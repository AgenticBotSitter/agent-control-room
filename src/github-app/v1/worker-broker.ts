import {
  admitGitHubWorkerWebhook,
  type AcceptedGitHubWorkerEvent,
  type GitHubWebhookHeaders,
  type GitHubWebhookReplayStore,
} from "./webhook-admission";

export type GitHubWorkerWakeHint = Readonly<{
  sequence: string;
  source: "github-app-webhook";
  repository: string;
  event: AcceptedGitHubWorkerEvent["event"];
  action: string;
  issueOrPullNumber?: number;
  observedAt: string;
}>;

export type GitHubWorkerWakeSink = Readonly<{
  /** Persist the hint before resolving. The sink must never execute repository-supplied content. */
  publish(hint: GitHubWorkerWakeHint): Promise<void>;
}>;

export type GitHubWorkerBrokerAudit = Readonly<{
  outcome: "queued" | "fallback" | "rejected";
  reason?: string;
  event?: AcceptedGitHubWorkerEvent["event"];
  action?: string;
  issueOrPullNumber?: number;
}>;

export type GitHubWorkerBrokerResult =
  | Readonly<{ accepted: true; wake: "queued" | "fallback" }>
  | Readonly<{ accepted: false; status: 400 | 401 | 403 | 413; reason: string }>;

const REJECTION_STATUS: Readonly<Record<string, 400 | 401 | 403 | 413>> = Object.freeze({
  payload_too_large: 413,
  signature_invalid: 401,
  repository_not_allowed: 403,
  installation_not_allowed: 403,
  event_not_allowed: 403,
  action_not_allowed: 403,
});

function wakeHint(event: AcceptedGitHubWorkerEvent, nowMs: number): GitHubWorkerWakeHint {
  return Object.freeze({
    sequence: event.deliveryId,
    source: "github-app-webhook",
    repository: event.repository,
    event: event.event,
    action: event.action,
    ...(event.issueOrPullNumber === undefined ? {} : { issueOrPullNumber: event.issueOrPullNumber }),
    observedAt: new Date(nowMs).toISOString(),
  });
}

/**
 * Effect-bounded broker composition. GitHub remains canonical: a wake-up hint only asks a
 * worker to refresh its verified inbox and never grants a claim, review, or merge authority.
 */
export class GitHubWorkerBroker {
  readonly #secret: string;
  readonly #repository: string;
  readonly #installationId: number;
  readonly #replayStore: GitHubWebhookReplayStore;
  readonly #wakeSink: GitHubWorkerWakeSink;
  readonly #now: () => number;
  readonly #audit?: (entry: GitHubWorkerBrokerAudit) => void;

  constructor({ secret, repository, installationId, replayStore, wakeSink, now = Date.now, audit }: {
    secret: string;
    repository: string;
    installationId: number;
    replayStore: GitHubWebhookReplayStore;
    wakeSink: GitHubWorkerWakeSink;
    now?: () => number;
    audit?: (entry: GitHubWorkerBrokerAudit) => void;
  }) {
    if (secret.length < 32) throw new Error("github_worker_broker_secret_invalid");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new Error("github_worker_broker_repository_invalid");
    }
    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      throw new Error("github_worker_broker_installation_invalid");
    }
    this.#secret = secret;
    this.#repository = repository;
    this.#installationId = installationId;
    this.#replayStore = replayStore;
    this.#wakeSink = wakeSink;
    this.#now = now;
    this.#audit = audit;
  }

  #record(entry: GitHubWorkerBrokerAudit): void {
    try { this.#audit?.(entry); } catch { /* Telemetry must never control webhook disposition. */ }
  }

  async receive({ body, headers }: { body: Buffer; headers: GitHubWebhookHeaders }): Promise<GitHubWorkerBrokerResult> {
    const nowMs = this.#now();
    const admission = await admitGitHubWorkerWebhook({
      body,
      headers,
      secret: this.#secret,
      expectedRepository: this.#repository,
      expectedInstallationId: this.#installationId,
      replayStore: this.#replayStore,
      nowMs,
    });
    if (!admission.accepted) {
      // A duplicate has already passed all security checks and been recorded. Acknowledge it
      // without publishing twice; every other refusal remains a rejected request.
      if (admission.reason === "delivery_replayed") {
        this.#record(Object.freeze({ outcome: "rejected", reason: admission.reason }));
        return Object.freeze({ accepted: true, wake: "fallback" });
      }
      this.#record(Object.freeze({ outcome: "rejected", reason: admission.reason }));
      return Object.freeze({
        accepted: false,
        status: REJECTION_STATUS[admission.reason] ?? 400,
        reason: admission.reason,
      });
    }

    const hint = wakeHint(admission.event, nowMs);
    try { await this.#wakeSink.publish(hint); } catch {
      // The verified event is already durable at GitHub. Quiet fallback polling recovers the
      // current state, so do not leak sink errors or ask GitHub to replay an already claimed ID.
      this.#record(Object.freeze({
        outcome: "fallback",
        reason: "wake_sink_unavailable",
        event: hint.event,
        action: hint.action,
        ...(hint.issueOrPullNumber === undefined ? {} : { issueOrPullNumber: hint.issueOrPullNumber }),
      }));
      return Object.freeze({ accepted: true, wake: "fallback" });
    }
    this.#record(Object.freeze({
      outcome: "queued",
      event: hint.event,
      action: hint.action,
      ...(hint.issueOrPullNumber === undefined ? {} : { issueOrPullNumber: hint.issueOrPullNumber }),
    }));
    return Object.freeze({ accepted: true, wake: "queued" });
  }
}
