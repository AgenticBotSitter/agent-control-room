import type { DatabaseClient } from "../../persistence/database";
import type { AcceptedGitHubWorkerEvent } from "./webhook-admission";
import type { GitHubWorkerAtomicAdmissionStore, GitHubWorkerWakeHint, GitHubWorkerWakeSink } from "./worker-broker";

const DELIVERY_ID = /^[A-Za-z0-9-]{8,100}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ACTION = /^[a-z][a-z0-9_]{1,63}$/u;
const EVENTS = new Set(["issues", "issue_comment", "pull_request", "pull_request_review", "check_suite", "workflow_run"]);
const REPLAY_KEY = /^(delivery|signature):[A-Za-z0-9=:_-]{8,180}$/u;
const MIN_RETENTION_MS = 60_000;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type StoredGitHubWorkerWakeHint = GitHubWorkerWakeHint & Readonly<{ cursor: string }>;
class ReplayAlreadyClaimed extends Error {}

function validateHint(hint: GitHubWorkerWakeHint): void {
  if (hint.source !== "github-app-webhook" || !DELIVERY_ID.test(hint.sequence)
    || !REPOSITORY.test(hint.repository) || !EVENTS.has(hint.event) || !ACTION.test(hint.action)
    || (hint.issueOrPullNumber !== undefined && (!Number.isSafeInteger(hint.issueOrPullNumber) || hint.issueOrPullNumber < 1))
    || !Number.isFinite(Date.parse(hint.observedAt))) throw new Error("github_worker_wake_hint_invalid");
}

/** PostgreSQL-backed wake sink and cursor reader. It stores metadata only, never GitHub text. */
export class PostgresGitHubWorkerWakeStore implements GitHubWorkerWakeSink, GitHubWorkerAtomicAdmissionStore {
  readonly #database: DatabaseClient;
  readonly #retentionMs: number;

  constructor(database: DatabaseClient, { retentionMs = 7 * 24 * 60 * 60_000 } = {}) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < MIN_RETENTION_MS || retentionMs > MAX_RETENTION_MS) {
      throw new Error("github_worker_wake_retention_invalid");
    }
    this.#database = database;
    this.#retentionMs = retentionMs;
  }

  async publish(hint: GitHubWorkerWakeHint): Promise<void> {
    validateHint(hint);
    await this.#database.transaction(async (tx) => {
      await tx.query("DELETE FROM control_github_worker_wake_hints WHERE expires_at <= clock_timestamp()");
      await tx.query(`INSERT INTO control_github_worker_wake_hints
        (delivery_id,source,repository,event,action,issue_or_pull_number,observed_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8::bigint * interval '1 millisecond'))
        ON CONFLICT(delivery_id) DO NOTHING`, [hint.sequence, hint.source, hint.repository, hint.event,
        hint.action, hint.issueOrPullNumber ?? null, hint.observedAt, this.#retentionMs]);
    });
  }

  async acceptVerified({ event, replayKeys, nowMs, replayExpiresAtMs }: {
    event: AcceptedGitHubWorkerEvent;
    replayKeys: readonly string[];
    nowMs: number;
    replayExpiresAtMs: number;
  }): Promise<boolean> {
    const unique = [...new Set(replayKeys)];
    const replayTtlMs = replayExpiresAtMs - nowMs;
    if (unique.length !== replayKeys.length || unique.length !== 2 || unique.some(key => !REPLAY_KEY.test(key))
      || !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(replayExpiresAtMs) || nowMs < 0
      || replayTtlMs < MIN_RETENTION_MS || replayTtlMs > 7 * 24 * 60 * 60_000) {
      throw new Error("github_worker_atomic_admission_invalid");
    }
    const hint: GitHubWorkerWakeHint = Object.freeze({
      sequence: event.deliveryId,
      source: "github-app-webhook",
      repository: event.repository,
      event: event.event,
      action: event.action,
      ...(event.issueOrPullNumber === undefined ? {} : { issueOrPullNumber: event.issueOrPullNumber }),
      observedAt: new Date(nowMs).toISOString(),
    });
    validateHint(hint);
    try {
      await this.#database.transaction(async (tx) => {
        await tx.query("DELETE FROM control_github_webhook_replays WHERE expires_at <= clock_timestamp()");
        await tx.query("DELETE FROM control_github_worker_wake_hints WHERE expires_at <= clock_timestamp()");
        const inserted = await tx.query<{ replay_key: string }>(`
          INSERT INTO control_github_webhook_replays(replay_key,recorded_at,expires_at)
          SELECT key,clock_timestamp(),clock_timestamp()+($2::bigint * interval '1 millisecond')
          FROM unnest($1::text[]) AS key ON CONFLICT(replay_key) DO NOTHING RETURNING replay_key`,
        [unique, replayTtlMs]);
        if (inserted.rows.length !== unique.length) throw new ReplayAlreadyClaimed();
        const wake = await tx.query<{ delivery_id: string }>(`INSERT INTO control_github_worker_wake_hints
          (delivery_id,source,repository,event,action,issue_or_pull_number,observed_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8::bigint * interval '1 millisecond'))
          ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id`,
        [hint.sequence, hint.source, hint.repository, hint.event, hint.action,
          hint.issueOrPullNumber ?? null, hint.observedAt, this.#retentionMs]);
        // Wake hints outlive replay claims. A delayed GitHub redelivery after the
        // replay window is still a known duplicate while its durable hint exists.
        if (wake.rows.length !== 1) throw new ReplayAlreadyClaimed();
      });
      return true;
    } catch (error) {
      if (error instanceof ReplayAlreadyClaimed) return false;
      throw error;
    }
  }

  async probe(): Promise<void> {
    await this.#database.query(`SELECT 1 FROM control_github_webhook_replays r
      CROSS JOIN control_github_worker_wake_hints h WHERE false`);
  }

  async readAfter(cursor = "0", limit = 100): Promise<readonly StoredGitHubWorkerWakeHint[]> {
    if (!/^(0|[1-9][0-9]{0,18})$/u.test(cursor) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("github_worker_wake_cursor_invalid");
    }
    const result = await this.#database.query<{
      cursor: string; delivery_id: string; repository: string; event: GitHubWorkerWakeHint["event"];
      action: string; issue_or_pull_number: number | null; observed_at: string;
    }>(`SELECT hint_id::text AS cursor,delivery_id,repository,event,action,issue_or_pull_number,
      observed_at::text FROM control_github_worker_wake_hints
      WHERE hint_id > $1::bigint AND expires_at > clock_timestamp()
      ORDER BY hint_id ASC LIMIT $2`, [cursor, limit]);
    return Object.freeze(result.rows.map(row => Object.freeze({
      cursor: row.cursor,
      sequence: row.delivery_id,
      source: "github-app-webhook" as const,
      repository: row.repository,
      event: row.event,
      action: row.action,
      ...(row.issue_or_pull_number === null ? {} : { issueOrPullNumber: row.issue_or_pull_number }),
      observedAt: new Date(row.observed_at).toISOString(),
    })));
  }
}
