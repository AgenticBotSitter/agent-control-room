import { createHmac, timingSafeEqual } from "node:crypto";

export type GitHubWebhookHeaders = Readonly<Record<string, string | undefined>>;

export type AcceptedGitHubWorkerEvent = Readonly<{
  deliveryId: string;
  event: "issues" | "issue_comment" | "pull_request" | "pull_request_review" | "check_suite" | "workflow_run";
  action: string;
  repository: string;
  installationId: number;
  issueOrPullNumber?: number;
}>;

export type WebhookAdmissionResult =
  | Readonly<{ accepted: true; event: AcceptedGitHubWorkerEvent }>
  | Readonly<{ accepted: false; reason: string }>;

export type VerifiedGitHubWorkerWebhook = Readonly<{
  accepted: true;
  event: AcceptedGitHubWorkerEvent;
  replayKeys: readonly string[];
}>;
export type GitHubWebhookVerificationResult = VerifiedGitHubWorkerWebhook | Readonly<{ accepted: false; reason: string }>;

export type GitHubWebhookReplayStore = Readonly<{
  /** Atomically records every key, or records none when any key is already live. */
  claim(keys: readonly string[], expiresAtMs: number, nowMs: number): Promise<boolean>;
}>;

const DELIVERY_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;
const ALLOWED_EVENTS = new Set([
  "issues", "issue_comment", "pull_request", "pull_request_review", "check_suite", "workflow_run",
]);
const ALLOWED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  issues: new Set(["opened", "edited", "labeled", "unlabeled", "closed", "reopened", "assigned", "unassigned"]),
  issue_comment: new Set(["created", "edited", "deleted"]),
  pull_request: new Set(["opened", "reopened", "synchronize", "closed", "ready_for_review", "converted_to_draft"]),
  pull_request_review: new Set(["submitted", "edited", "dismissed"]),
  check_suite: new Set(["completed", "requested", "rerequested"]),
  workflow_run: new Set(["completed", "requested", "in_progress"]),
});

export function verifyGitHubWebhookSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!Buffer.isBuffer(body) || secret.length < 32 || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Test/disposable adapter only. A live listener must supply a durable atomic store. */
export class InMemoryGitHubWebhookReplayStore implements GitHubWebhookReplayStore {
  readonly #seen = new Map<string, number>();
  readonly #maxEntries: number;

  constructor({ maxEntries = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("github_webhook_capacity_invalid");
    this.#maxEntries = maxEntries;
  }

  async claim(keys: readonly string[], expiresAtMs: number, nowMs: number): Promise<boolean> {
    for (const [id, expiresAt] of this.#seen) if (expiresAt <= nowMs) this.#seen.delete(id);
    if (keys.some((key) => this.#seen.has(key))) return false;
    // Fail closed instead of evicting an unexpired replay record.
    if (this.#seen.size + keys.length > this.#maxEntries) throw new Error("github_webhook_replay_store_full");
    for (const key of keys) this.#seen.set(key, expiresAtMs);
    return true;
  }
}

function parsePayload(body: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Converts only allowlisted, verified events for the one installed repository into wake-up hints.
 * This function grants no GitHub or Control Room authority and performs no work itself.
 */
export async function admitGitHubWorkerWebhook({
  body, headers, secret, expectedRepository, expectedInstallationId, replayStore, nowMs = Date.now(),
  maxBodyBytes = 1_048_576, replayTtlMs = 24 * 60 * 60_000,
}: {
  body: Buffer;
  headers: GitHubWebhookHeaders;
  secret: string;
  expectedRepository: string;
  expectedInstallationId: number;
  replayStore: GitHubWebhookReplayStore;
  nowMs?: number;
  maxBodyBytes?: number;
  replayTtlMs?: number;
}): Promise<WebhookAdmissionResult> {
  const verified = verifyGitHubWorkerWebhook({ body, headers, secret, expectedRepository, expectedInstallationId, maxBodyBytes });
  if (!verified.accepted) return verified;
  if (!Number.isSafeInteger(replayTtlMs) || replayTtlMs < 60_000) {
    return { accepted: false, reason: "replay_ttl_invalid" };
  }
  const accepted = await replayStore.claim(verified.replayKeys, nowMs + replayTtlMs, nowMs);
  if (!accepted) return { accepted: false, reason: "delivery_replayed" };
  return { accepted: true, event: verified.event };
}

/** Verifies and reduces a webhook without writing state. The replay keys are safe
 * only as inputs to the atomic admission store; they are never response data. */
export function verifyGitHubWorkerWebhook({
  body, headers, secret, expectedRepository, expectedInstallationId, maxBodyBytes = 1_048_576,
}: {
  body: Buffer;
  headers: GitHubWebhookHeaders;
  secret: string;
  expectedRepository: string;
  expectedInstallationId: number;
  maxBodyBytes?: number;
}): GitHubWebhookVerificationResult {
  if (body.length > maxBodyBytes) return { accepted: false, reason: "payload_too_large" };
  if (!verifyGitHubWebhookSignature(body, headers["x-hub-signature-256"], secret)) {
    return { accepted: false, reason: "signature_invalid" };
  }
  const deliveryId = headers["x-github-delivery"];
  const eventName = headers["x-github-event"];
  if (!deliveryId || !DELIVERY_PATTERN.test(deliveryId)) return { accepted: false, reason: "delivery_id_invalid" };
  if (!eventName || !ALLOWED_EVENTS.has(eventName)) return { accepted: false, reason: "event_not_allowed" };
  const payload = parsePayload(body);
  if (!payload) return { accepted: false, reason: "payload_invalid" };
  const repository = (payload.repository as { full_name?: unknown } | undefined)?.full_name;
  const installationId = (payload.installation as { id?: unknown } | undefined)?.id;
  const action = payload.action;
  if (repository !== expectedRepository) return { accepted: false, reason: "repository_not_allowed" };
  if (installationId !== expectedInstallationId) return { accepted: false, reason: "installation_not_allowed" };
  if (typeof action !== "string" || !ALLOWED_ACTIONS[eventName]?.has(action)) {
    return { accepted: false, reason: "action_not_allowed" };
  }
  const issueNumber = (payload.issue as { number?: unknown } | undefined)?.number;
  const pullNumber = (payload.pull_request as { number?: unknown } | undefined)?.number;
  const number = Number.isSafeInteger(issueNumber) ? issueNumber as number
    : Number.isSafeInteger(pullNumber) ? pullNumber as number : undefined;
  return {
    accepted: true,
    event: Object.freeze({
      deliveryId,
      event: eventName as AcceptedGitHubWorkerEvent["event"],
      action,
      repository,
      installationId,
      ...(number === undefined ? {} : { issueOrPullNumber: number }),
    }),
    // Delivery ID is not covered by GitHub's body HMAC. Claim both the ID and the
    // verified signature so a captured request cannot be replayed with a new header.
    replayKeys: Object.freeze([`delivery:${deliveryId}`, `signature:${headers["x-hub-signature-256"]}`]),
  };
}
