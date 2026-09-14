import { startPgBossBoundedRuntime, type PgBossBoundedRuntimeConstructor, type PgBossBoundedRuntimeDatabase } from "./pg-boss-bounded-runtime";
import type { BoundedDeliveryHandler } from "./pg-boss-bounded-worker";
import { startPgBossNewsFeedWorker, type NewsFeedJobReference } from "./pg-boss-news-feed-worker";

/** Explicit fixed-feed composition, not startup mounting or authority to collect.
 * Caller supplies an already-verified dedicated operational worker pool and canonical
 * collector. No recovery hook: uncertain collection must never automatically re-read.
 * Reuses native lifecycle bounds, pool ownership, error fencing and drain semantics. */
export function startPgBossNewsFeedRuntime(
  PgBoss: PgBossBoundedRuntimeConstructor, database: PgBossBoundedRuntimeDatabase,
  input: { collect: BoundedDeliveryHandler<NewsFeedJobReference>; concurrency?: number;
    backend?: "postgres" | "pglite"; operationTimeoutMs?: number },
) {
  return startPgBossBoundedRuntime(PgBoss, database, {
    deliver: typeof input.collect === "function" ? input.collect.bind(input) : input.collect, concurrency: input.concurrency,
    backend: input.backend, operationTimeoutMs: input.operationTimeoutMs,
  }, { errorPrefix: "news_feed", startWorker(client, options) {
    return startPgBossNewsFeedWorker(client, { collect: options.deliver, concurrency: options.concurrency });
  } });
}
