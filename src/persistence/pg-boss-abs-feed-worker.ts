import { z } from "zod";
import { localId, digestSchema } from "../harness/v1/native-run-identifiers";
import { sha256Digest } from "../security";
import { startPgBossBoundedWorker, type BoundedDeliveryHandler, type PgBossBoundedWorkerClient } from "./pg-boss-bounded-worker";

/** Locators only: destination, source configuration and authority stay in canonical SQL. */
export const absFeedJobReferenceSchema = z.object({ schema: z.literal("control-room.abs-feed-job/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, effectId: localId,
  operationDigest: digestSchema,
}).strict();
export type AbsFeedJobReference = z.infer<typeof absFeedJobReferenceSchema>;
export const ABS_FEED_QUEUE = Object.freeze({ name: "abs-feed-collection", table: "job_common" });

export function absFeedJobId(value: AbsFeedJobReference): string {
  const reference = absFeedJobReferenceSchema.parse(value);
  const hex = sha256Digest({ purpose: "pg-boss-abs-feed/v1", reference }).slice(7);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function assertAbsFeedQueue(value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("abs_feed_queue_unavailable");
  const q = value as Record<string, unknown>;
  if (q.name !== ABS_FEED_QUEUE.name || q.table !== ABS_FEED_QUEUE.table || q.policy !== "standard"
    || q.partition !== false || q.retryLimit !== 0 || q.deadLetter != null || q.notify !== false)
    throw new Error("abs_feed_queue_unavailable");
}

/** Explicitly started client only. No queue provisioning, SQL connection or network reader.
 * Canonical handler must own a durable effect marker, revalidate current source/job approval,
 * await collection cleanup and retain its outcome before returning delivered or held.
 * Neither a pg-boss pickup nor this deterministic ID authorizes or deduplicates an effect.
 * No recovery port: uncertain collections are not automatically re-read. */
export function startPgBossAbsFeedWorker(client: PgBossBoundedWorkerClient, input: {
  concurrency?: number; collect: BoundedDeliveryHandler<AbsFeedJobReference>;
}) {
  const collect = input.collect?.bind(input);
  return startPgBossBoundedWorker(client, { name: ABS_FEED_QUEUE.name, maximumRecoveries: 0,
    parse: value => absFeedJobReferenceSchema.parse(value), identify: absFeedJobId, assertQueue: assertAbsFeedQueue,
    errors: { unresolved: "abs_feed_delivery_unresolved", config: "abs_feed_worker_config_invalid", close: "abs_feed_worker_close_uncertain" },
  }, { concurrency: input.concurrency, deliver: collect });
}
