import { startPgBossBoundedRuntime, type PgBossBoundedRuntimeConstructor, type PgBossBoundedRuntimeDatabase } from "./pg-boss-bounded-runtime";
import type { BoundedDeliveryHandler } from "./pg-boss-bounded-worker";
import { startPgBossAbsFeedWorker, type AbsFeedJobReference } from "./pg-boss-abs-feed-worker";

/** Explicit fixed-feed composition, not startup mounting or authority to collect.
 * Caller supplies an already-verified dedicated operational worker pool and canonical
 * collector. No recovery hook: uncertain collection must never automatically re-read.
 * Reuses native lifecycle bounds, pool ownership, error fencing and drain semantics. */
export function startPgBossAbsFeedRuntime(
  PgBoss: PgBossBoundedRuntimeConstructor, database: PgBossBoundedRuntimeDatabase,
  input: { collect: BoundedDeliveryHandler<AbsFeedJobReference>; concurrency?: number;
    backend?: "postgres" | "pglite"; operationTimeoutMs?: number },
) {
  return startPgBossBoundedRuntime(PgBoss, database, {
    deliver: typeof input.collect === "function" ? input.collect.bind(input) : input.collect, concurrency: input.concurrency,
    backend: input.backend, operationTimeoutMs: input.operationTimeoutMs,
  }, { errorPrefix: "abs_feed", startWorker(client, options) {
    return startPgBossAbsFeedWorker(client, { collect: options.deliver, concurrency: options.concurrency });
  } });
}
