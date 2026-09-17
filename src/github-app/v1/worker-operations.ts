import { GitHubAppInstallationAuth } from "./installation-auth";
import { parseClaimPacket } from "../../../scripts/automatic-claim-controller.mjs";
import {
  createBoundedGitHubClient,
  type BoundedGitHubClient,
  type BoundedGitHubAudit,
  type GitHubRequestShape,
} from "./worker-github-client";

/**
 * The worker-facing half of the GitHub App broker.
 *
 * Workers reach GitHub through a small, versioned, named operation set instead of an
 * arbitrary proxy. Each operation binds the configured repository, validates worker
 * identity and the finite command shape, bounds pagination and body sizes, and answers
 * with stable machine-readable codes. Installation tokens are minted inside the broker
 * and never returned to a caller.
 *
 * The command bodies are byte-exact with the controller parsers, which are anchored
 * regular expressions over the whole comment: no dedupe marker, suffix, or formatting
 * flourish may be added to `CLAIM REQUEST`, `HANDOFF …`, or `CLAIM ACCEPTED` records.
 * Retry safety therefore comes from reading the issue history before posting, not from
 * annotating the comment.
 */

export const WORKER_OPERATIONS_VERSION = "acr-worker-broker-operations:v1";

export const WORKER_OPERATION_NAMES = Object.freeze([
  "worker-inbox-read",
  "ready-queue-discovery",
  "claim-request",
  "correction-acknowledge",
  "handoff-submit",
  "pull-request-status",
] as const);

export type WorkerOperationName = (typeof WORKER_OPERATION_NAMES)[number];

/** Never reachable through this service; listed so refusals are explicit and testable. */
export const FORBIDDEN_WORKER_OPERATION_NAMES = Object.freeze([
  "merge",
  "merge-pull-request",
  "workflow-edit",
  "repository-admin",
  "secrets-read",
  "secrets-write",
  "deployment",
  "environment",
  "membership",
  "permission-change",
  "arbitrary-request",
  "graphql",
] as const);

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const MAX_ISSUES = 60;
const MAX_PULLS = 100;
const MAX_WORKER_COMMAND_BYTES = 512;

export type WorkerOperationResult =
  | Readonly<{ version: string; operation: string; ok: true; [key: string]: unknown }>
  | Readonly<{ version: string; operation: string; ok: false; code: string }>;

export type WorkerOperationAudit = Readonly<{
  operation: string;
  outcome: "ok" | "refused" | "idempotent";
  code?: string;
  commentId?: number;
}>;

export type GitHubWorkerOperationsOptions = Readonly<{
  repository: string;
  auth: GitHubAppInstallationAuth;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetryAfterMs?: number;
  audit?: (entry: WorkerOperationAudit) => void;
}>;

export type GitHubWorkerOperationInput = Readonly<{
  operation: string;
  workerId?: string;
  issue?: number;
  pr?: number;
  head?: string;
  previous?: number;
}>;

function refused(operation: string, code: string): WorkerOperationResult {
  return Object.freeze({ version: WORKER_OPERATIONS_VERSION, operation, ok: false, code });
}

function issueNumber(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 99_999_999
    ? (value as number) : undefined;
}

function commandBody(operation: string, input: GitHubWorkerOperationInput): string | undefined {
  const { workerId, pr, head, previous } = input;
  if (operation === "claim-request") return `CLAIM REQUEST\nworker-id: ${workerId}`;
  if (operation === "correction-acknowledge") {
    return `HANDOFF acknowledge\nworker-id: ${workerId}\npr: ${pr}\nhead: ${head}\nprevious: ${previous}`;
  }
  return `HANDOFF submit\nworker-id: ${workerId}\npr: ${pr}\nhead: ${head}\nprevious: ${previous}`;
}

type CommentRecord = Readonly<{ id: number; author: string; bot: boolean; body: string; created_at?: string }>;

function commentRecords(value: unknown): CommentRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: CommentRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { id?: unknown; body?: unknown; created_at?: unknown; user?: { login?: unknown; type?: unknown } };
    if (!Number.isSafeInteger(candidate.id) || typeof candidate.body !== "string") continue;
    records.push(Object.freeze({
      id: candidate.id as number,
      author: typeof candidate.user?.login === "string" ? candidate.user.login : "",
      bot: candidate.user?.type === "Bot",
      body: candidate.body,
      ...(typeof candidate.created_at === "string" ? { created_at: candidate.created_at } : {}),
    }));
  }
  return records;
}

const CLAIM_MARKER = /<!-- agent-control-room-claim:v2 issue=(\d+) request=(\d+) actor=(\S+) worker=(\S+) -->/u;

/**
 * Latest claim record for an issue, read from bot comments only. A human-authored
 * lookalike can never satisfy the marker, so it cannot authorize or deny a worker.
 */
export function latestClaimRecord(comments: readonly CommentRecord[]) {
  const claims = comments.filter(entry => entry.bot && entry.body.includes("<!-- agent-control-room-claim:v2"));
  const latest = claims.at(-1);
  if (!latest) return undefined;
  const match = CLAIM_MARKER.exec(latest.body);
  if (!match) return undefined;
  const state = latest.body.startsWith("CLAIM ACCEPTED") ? "accepted"
    : latest.body.startsWith("CLAIM PENDING") ? "pending"
      : latest.body.startsWith("CLAIM REVOKED") ? "revoked" : "unknown";
  return Object.freeze({ state, workerId: match[4], requestId: Number(match[2]), commentId: latest.id });
}

export function createGitHubWorkerOperations(options: GitHubWorkerOperationsOptions) {
  const client: BoundedGitHubClient = createBoundedGitHubClient({
    repository: options.repository,
    auth: options.auth,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.maxRetryAfterMs === undefined ? {} : { maxRetryAfterMs: options.maxRetryAfterMs }),
    audit: (entry: BoundedGitHubAudit) => report(options.audit, {
      operation: "github-transport", outcome: entry.code ? "refused" : "ok",
      ...(entry.code ? { code: entry.code } : {}),
    }),
  });
  const now = options.now ?? Date.now;

  function report(audit: ((entry: WorkerOperationAudit) => void) | undefined, entry: WorkerOperationAudit): void {
    try { audit?.(entry); } catch { /* Telemetry must never decide an operation outcome. */ }
  }

  function record(result: WorkerOperationResult, entry: WorkerOperationAudit): WorkerOperationResult {
    report(options.audit, entry);
    return result;
  }

  function auditEntry(operation: string, outcome: WorkerOperationAudit["outcome"], extra: Partial<WorkerOperationAudit> = {}) {
    return { operation, outcome, ...extra } as WorkerOperationAudit;
  }

  /** Reads every comment authored by this installation, so command retries are detectable. */
  async function commentsWithFailure(issue: number): Promise<
    Readonly<{ ok: true; comments: CommentRecord[] }> | Readonly<{ ok: false; code: string }>
  > {
    const page = await client.pages<unknown>({ shape: "issue-comments-list", params: { number: issue } });
    if (!page.ok) return Object.freeze({ ok: false, code: page.code });
    if (page.truncated) return Object.freeze({ ok: false, code: "github_snapshot_incomplete" });
    const records = commentRecords(page.items);
    if (!records) return Object.freeze({ ok: false, code: "github_response_invalid" });
    return Object.freeze({ ok: true, comments: records });
  }

  async function repositorySnapshot(includeQueue: boolean): Promise<
    (Readonly<{ ok: true; snapshot: Record<string, unknown> }>) | (Readonly<{ ok: false; code: string }>)
  > {
    const issues = await client.pages<unknown>({ shape: "issues-list", query: { state: "open" } });
    if (!issues.ok) return Object.freeze({ ok: false, code: issues.code });
    if (issues.truncated || issues.items.length > MAX_ISSUES) {
      return Object.freeze({ ok: false, code: "github_snapshot_incomplete" });
    }
    const comments: Record<string, readonly CommentRecord[]> = {};
    const commentErrors: Record<string, string> = {};
    const projected: unknown[] = [];
    for (const entry of issues.items) {
      if (!entry || typeof entry !== "object") continue;
      const issue = entry as { number?: unknown; title?: unknown; body?: unknown; state?: unknown; labels?: unknown;
        pull_request?: unknown; user?: { login?: unknown; type?: unknown } };
      const number = issueNumber(issue.number);
      if (number === undefined) continue;
      projected.push(Object.freeze({
        number,
        // Titles and bodies are untrusted repository text. They travel to the requesting
        // worker as data and are never written to the broker's own logs or audit records.
        title: typeof issue.title === "string" ? issue.title : "",
        body: typeof issue.body === "string" ? issue.body : "",
        state: typeof issue.state === "string" ? issue.state : "",
        isPullRequest: issue.pull_request !== undefined,
        author: typeof issue.user?.login === "string" ? issue.user.login : "",
        authorIsBot: issue.user?.type === "Bot",
        labels: Array.isArray(issue.labels) ? issue.labels.map(label =>
          typeof label === "string" ? label : (label as { name?: unknown })?.name).filter(
          (value): value is string => typeof value === "string") : [],
      }));
      const issueComments = await commentsWithFailure(number);
      if (issueComments.ok) comments[String(number)] = issueComments.comments;
      else commentErrors[String(number)] = issueComments.code;
    }
    // Fetch only dependencies named by valid Ready packets. Keep them separate
    // from open issues so closed records cannot become assignments or offers.
    const dependencies: Record<string, unknown> = {};
    if (includeQueue) {
      const wanted = new Set<number>();
      for (const entry of projected) {
        const issue = entry as { body: string; labels: string[]; isPullRequest: boolean };
        if (issue.isPullRequest || !issue.labels.includes("status:ready")) continue;
        const packet = parseClaimPacket(issue.body);
        for (const number of packet?.dependencies ?? []) wanted.add(number);
      }
      if (wanted.size > MAX_ISSUES) return Object.freeze({ ok: false, code: "github_snapshot_incomplete" });
      for (const number of wanted) {
        const result = await client.request<unknown>({ shape: "issue-read", params: { number } });
        if (!result.ok) return Object.freeze({ ok: false, code: result.code });
        const value = result.value as { number?: unknown; state?: unknown; state_reason?: unknown;
          labels?: unknown; pull_request?: unknown } | null;
        if (!value || value.number !== number || !["open", "closed"].includes(String(value.state))
          || !Array.isArray(value.labels)) return Object.freeze({ ok: false, code: "github_response_invalid" });
        dependencies[String(number)] = Object.freeze({ number, state: value.state,
          state_reason: typeof value.state_reason === "string" ? value.state_reason : null,
          ...(value.pull_request !== undefined ? { pull_request: {} } : {}),
          labels: value.labels.map(label => typeof label === "string" ? label : label?.name)
            .filter((label): label is string => typeof label === "string") });
      }
    }
    const snapshot: Record<string, unknown> = {
      repository: options.repository,
      dependencies: Object.freeze(dependencies),
      observedAt: new Date(now()).toISOString(),
      issues: Object.freeze(projected),
      comments: Object.freeze(comments),
      commentErrors: Object.freeze(commentErrors),
      // A consumer that ignores commentErrors still cannot mistake a partial read for a
      // whole one: any unreadable issue comment feed makes the snapshot incomplete.
      complete: Object.keys(commentErrors).length === 0,
    };
    if (!includeQueue) return Object.freeze({ ok: true, snapshot: Object.freeze(snapshot) });

    const pulls = await client.pages<unknown>({ shape: "pulls-list", query: { state: "open" } });
    if (!pulls.ok) return Object.freeze({ ok: false, code: pulls.code });
    if (pulls.truncated || pulls.items.length > MAX_PULLS) {
      return Object.freeze({ ok: false, code: "github_snapshot_incomplete" });
    }
    const projectedPulls: unknown[] = [];
    for (const entry of pulls.items) {
      if (!entry || typeof entry !== "object") continue;
      const pull = entry as { number?: unknown; state?: unknown; draft?: unknown; head?: { sha?: unknown } };
      const number = issueNumber(pull.number);
      const sha = typeof pull.head?.sha === "string" ? pull.head.sha : "";
      if (number === undefined || !SHA.test(sha)) continue;
      projectedPulls.push(Object.freeze({ number, state: typeof pull.state === "string" ? pull.state : "",
        draft: pull.draft === true, headSha: sha }));
    }
    const base = await client.request<unknown>({ shape: "commit-read", params: { ref: "main" } });
    const baseSha = base.ok && base.value && typeof base.value === "object"
      ? (base.value as { sha?: unknown }).sha : undefined;
    if (typeof baseSha !== "string" || !SHA.test(baseSha)) {
      return Object.freeze({ ok: false, code: base.ok ? "github_response_invalid" : base.code });
    }
    return Object.freeze({ ok: true, snapshot: Object.freeze({ ...snapshot,
      pulls: Object.freeze(projectedPulls), base: Object.freeze({ ref: "main", sha: baseSha }) }) });
  }

  /**
   * Posts a controller command at most once. GitHub is the dedupe substrate: an identical
   * comment already authored by this installation means an earlier attempt succeeded and
   * the acknowledgement was lost, so the retry reports the existing record.
   */
  async function postOnce(operation: string, issue: number, body: string): Promise<WorkerOperationResult> {
    if (Buffer.byteLength(body, "utf8") > MAX_WORKER_COMMAND_BYTES) {
      return record(refused(operation, "worker_command_too_large"), auditEntry(operation, "refused", { code: "worker_command_too_large" }));
    }
    const history = await commentsWithFailure(issue);
    if (!history.ok) {
      return record(refused(operation, history.code), auditEntry(operation, "refused", { code: history.code }));
    }
    const login = await client.installationBotLogin();
    const existing = history.comments.find(entry =>
      (login ? entry.author === login : entry.bot) && entry.body === body);
    if (existing) {
      return record(Object.freeze({ version: WORKER_OPERATIONS_VERSION, operation, ok: true,
        idempotent: true, posted: false, commentId: existing.id }),
      auditEntry(operation, "idempotent", { commentId: existing.id }));
    }
    const posted = await client.request<unknown>({ shape: "issue-command-comment",
      params: { number: issue }, body: { body } });
    if (!posted.ok) return record(refused(operation, posted.code), auditEntry(operation, "refused", { code: posted.code }));
    const commentId = posted.value && typeof posted.value === "object"
      ? (posted.value as { id?: unknown }).id : undefined;
    if (!Number.isSafeInteger(commentId)) {
      return record(refused(operation, "github_response_invalid"),
        auditEntry(operation, "refused", { code: "github_response_invalid" }));
    }
    return record(Object.freeze({ version: WORKER_OPERATIONS_VERSION, operation, ok: true,
      idempotent: false, posted: true, commentId: commentId as number }),
    auditEntry(operation, "ok", { commentId: commentId as number }));
  }

  async function run(input: GitHubWorkerOperationInput): Promise<WorkerOperationResult> {
    const operation = typeof input?.operation === "string" ? input.operation : "";
    if (!(WORKER_OPERATION_NAMES as readonly string[]).includes(operation)) {
      return record(refused(operation, "worker_operation_forbidden"),
        auditEntry(operation, "refused", { code: "worker_operation_forbidden" }));
    }

    if (operation === "worker-inbox-read" || operation === "ready-queue-discovery") {
      if (typeof input.workerId !== "string" || !WORKER_ID.test(input.workerId)) {
        return record(refused(operation, "worker_identity_invalid"),
          auditEntry(operation, "refused", { code: "worker_identity_invalid" }));
      }
      const snapshot = await repositorySnapshot(operation === "ready-queue-discovery");
      if (!snapshot.ok) return record(refused(operation, snapshot.code), auditEntry(operation, "refused", { code: snapshot.code }));
      return record(Object.freeze({ version: WORKER_OPERATIONS_VERSION, operation, ok: true,
        workerId: input.workerId, snapshot: snapshot.snapshot }), auditEntry(operation, "ok"));
    }

    if (operation === "pull-request-status") {
      const pr = issueNumber(input.pr);
      if (pr === undefined) {
        return record(refused(operation, "worker_command_invalid"), auditEntry(operation, "refused", { code: "worker_command_invalid" }));
      }
      const pull = await client.request<unknown>({ shape: "pull-read", params: { number: pr } });
      if (!pull.ok) {
        const code = pull.code === "github_not_found" ? "worker_pull_not_found" : pull.code;
        return record(refused(operation, code), auditEntry(operation, "refused", { code }));
      }
      const value = pull.value as { state?: unknown; draft?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown } };
      const headSha = typeof value?.head?.sha === "string" ? value.head.sha : "";
      if (!SHA.test(headSha)) {
        return record(refused(operation, "github_response_invalid"), auditEntry(operation, "refused", { code: "github_response_invalid" }));
      }
      const checks = await client.request<unknown>({ shape: "commit-check-runs-list", params: { sha: headSha } });
      if (!checks.ok) return record(refused(operation, checks.code), auditEntry(operation, "refused", { code: checks.code }));
      const runs = checks.value && typeof checks.value === "object"
        ? (checks.value as { check_runs?: unknown }).check_runs : undefined;
      if (!Array.isArray(runs)) {
        return record(refused(operation, "github_response_invalid"), auditEntry(operation, "refused", { code: "github_response_invalid" }));
      }
      const conclusions: Record<string, number> = {};
      let incomplete = 0;
      for (const run_ of runs) {
        const conclusion = run_ && typeof run_ === "object" ? (run_ as { conclusion?: unknown; status?: unknown }) : {};
        if (typeof conclusion.conclusion === "string") {
          conclusions[conclusion.conclusion] = (conclusions[conclusion.conclusion] ?? 0) + 1;
        } else if (typeof conclusion.status === "string" && conclusion.status !== "completed") incomplete += 1;
      }
      return record(Object.freeze({ version: WORKER_OPERATIONS_VERSION, operation, ok: true,
        repository: options.repository, pull: pr,
        state: typeof value?.state === "string" ? value.state : "",
        draft: value?.draft === true,
        baseRef: typeof value?.base?.ref === "string" ? value.base.ref : "",
        headSha, checks: Object.freeze({ reported: runs.length, incomplete,
          conclusions: Object.freeze(conclusions) }) }), auditEntry(operation, "ok"));
    }

    const issue = issueNumber(input.issue);
    if (typeof input.workerId !== "string" || !WORKER_ID.test(input.workerId) || issue === undefined) {
      return record(refused(operation, "worker_command_invalid"), auditEntry(operation, "refused", { code: "worker_command_invalid" }));
    }
    if (operation === "claim-request") {
      const history = await commentsWithFailure(issue);
      if (!history.ok) return record(refused(operation, history.code), auditEntry(operation, "refused", { code: history.code }));
      const claim = latestClaimRecord(history.comments);
      if (claim && claim.state === "accepted" && claim.workerId !== input.workerId) {
        return record(refused(operation, "worker_claim_conflict"),
          auditEntry(operation, "refused", { code: "worker_claim_conflict" }));
      }
      if (claim && claim.state === "accepted") {
        return record(Object.freeze({ version: WORKER_OPERATIONS_VERSION, operation, ok: true,
          idempotent: true, posted: false, commentId: claim.commentId }),
        auditEntry(operation, "idempotent", { commentId: claim.commentId }));
      }
      return postOnce(operation, issue, commandBody(operation, input)!);
    }

    const pr = issueNumber(input.pr);
    const previous = Number.isSafeInteger(input.previous) && (input.previous as number) >= 0 ? input.previous as number : undefined;
    if (pr === undefined || typeof input.head !== "string" || !SHA.test(input.head) || previous === undefined) {
      return record(refused(operation, "worker_command_invalid"), auditEntry(operation, "refused", { code: "worker_command_invalid" }));
    }
    const history = await commentsWithFailure(issue);
    if (!history.ok) return record(refused(operation, history.code), auditEntry(operation, "refused", { code: history.code }));
    const claim = latestClaimRecord(history.comments);
    // A handoff is only meaningful for the worker that holds the accepted claim. Refusing
    // here keeps one worker from advancing another worker's issue and keeps an unrelated
    // worker's retry from posting an unverifiable record.
    if (claim && claim.state === "accepted" && claim.workerId !== input.workerId) {
      return record(refused(operation, "worker_claim_mismatch"),
        auditEntry(operation, "refused", { code: "worker_claim_mismatch" }));
    }
    return postOnce(operation, issue, commandBody(operation, input)!);
  }

  return Object.freeze({
    version: WORKER_OPERATIONS_VERSION,
    repository: options.repository,
    supportedOperations: WORKER_OPERATION_NAMES,
    forbiddenOperations: FORBIDDEN_WORKER_OPERATION_NAMES,
    run,
  });
}

export type GitHubWorkerOperations = ReturnType<typeof createGitHubWorkerOperations>;

/**
 * Composes the operations service from installation credentials. The credentials are
 * used only to mint installation tokens inside the broker.
 */
export function prepareGitHubWorkerOperations(input: Readonly<{
  repository: string;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  audit?: (entry: WorkerOperationAudit) => void;
}>) {
  const auth = new GitHubAppInstallationAuth({
    credentials: { appId: input.appId, installationId: input.installationId, privateKeyPem: input.privateKeyPem },
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  return createGitHubWorkerOperations({
    repository: input.repository,
    auth,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
    ...(input.audit ? { audit: input.audit } : {}),
  });
}

/** Shapes are exported so the HTTP layer can assert the allowed request surface in tests. */
export const WORKER_OPERATION_REQUEST_SHAPES: readonly GitHubRequestShape[] = Object.freeze([
  "app-user", "issues-list", "issue-read", "issue-comments-list", "issue-command-comment",
  "pulls-list", "pull-read", "commit-read", "commit-check-runs-list",
]);

export type { GitHubRequestShape };