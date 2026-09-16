import type { DatabaseClient } from "../../persistence/database";
import type { GitHubWebhookReplayStore } from "./webhook-admission";

const KEY_PATTERN = /^(delivery|signature):[A-Za-z0-9=:_-]{8,180}$/u;
const MAX_KEYS_PER_CLAIM = 4;
const MIN_REPLAY_TTL_MS = 60_000;
const MAX_REPLAY_TTL_MS = 7 * 24 * 60 * 60_000;

class ReplayAlreadyClaimed extends Error {}

/** Production adapter. Atomicity depends on DatabaseClient.transaction rolling back callback errors. */
export class PostgresGitHubWebhookReplayStore implements GitHubWebhookReplayStore {
  readonly #database: DatabaseClient;

  constructor(database: DatabaseClient) {
    this.#database = database;
  }

  async claim(keys: readonly string[], expiresAtMs: number, nowMs: number): Promise<boolean> {
    const unique = [...new Set(keys)];
    if (unique.length !== keys.length || unique.length < 1 || unique.length > MAX_KEYS_PER_CLAIM
      || unique.some((key) => !KEY_PATTERN.test(key))) throw new Error("github_webhook_replay_keys_invalid");
    const ttlMs = expiresAtMs - nowMs;
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(expiresAtMs)
      || nowMs < 0 || ttlMs < MIN_REPLAY_TTL_MS || ttlMs > MAX_REPLAY_TTL_MS) {
      throw new Error("github_webhook_replay_time_invalid");
    }
    try {
      await this.#database.transaction(async (tx) => {
        // PostgreSQL is the authority for retention time; caller clock drift can never
        // make a live claim eligible for cleanup.
        await tx.query("DELETE FROM control_github_webhook_replays WHERE expires_at <= clock_timestamp()");
        const inserted = await tx.query<{ replay_key: string }>(`
          INSERT INTO control_github_webhook_replays(replay_key,recorded_at,expires_at)
          SELECT key,clock_timestamp(),clock_timestamp()+($2::bigint * interval '1 millisecond')
          FROM unnest($1::text[]) AS key
          ON CONFLICT(replay_key) DO NOTHING
          RETURNING replay_key`, [unique, ttlMs]);
        if (inserted.rows.length !== unique.length) throw new ReplayAlreadyClaimed();
      });
      return true;
    } catch (error) {
      if (error instanceof ReplayAlreadyClaimed) return false;
      throw error;
    }
  }
}
