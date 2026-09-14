import { z } from "zod";
import { localId, digestSchema } from "../harness/v1/native-run-identifiers";
import { sha256Digest } from "../security";
import { startPgBossBoundedWorker, type BoundedDeliveryHandler, type PgBossBoundedWorkerClient } from "./pg-boss-bounded-worker";

/** Locators only: destination, source configuration and authority stay in canonical SQL. */
export const newsFeedJobReferenceSchema = z.object({ schema: z.literal("control-room.news-feed-job/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, effectId: localId,
  operationDigest: digestSchema,
}).strict();
export type NewsFeedJobReference = z.infer<typeof newsFeedJobReferenceSchema>;
export const NEWS_FEED_QUEUE = Object.freeze({ name: "news-feed-collection", table: "job_common" });

export function newsFeedJobId(value: NewsFeedJobReference): string {
  const reference = newsFeedJobReferenceSchema.parse(value);
  const hex = sha256Digest({ purpose: "pg-boss-news-feed/v1", reference }).slice(7);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function assertNewsFeedQueue(value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("news_feed_queue_unavailable");
  const q = value as Record<string, unknown>;
  if (q.name !== NEWS_FEED_QUEUE.name || q.table !== NEWS_FEED_QUEUE.table || q.policy !== "standard"
    || q.partition !== false || q.retryLimit !== 0 || q.deadLetter != null || q.notify !== false)
    throw new Error("news_feed_queue_unavailable");
}

/** Explicitly started client only. No queue provisioning, SQL connection or network reader.
 * Canonical handler must own a durable effect marker, revalidate current source/job approval,
 * await collection cleanup and retain its outcome before returning delivered or held.
 * Neither a pg-boss pickup nor this deterministic ID authorizes or deduplicates an effect.
 * No recovery port: uncertain collections are not automatically re-read. */
export function startPgBossNewsFeedWorker(client: PgBossBoundedWorkerClient, input: {
  concurrency?: number; collect: BoundedDeliveryHandler<NewsFeedJobReference>;
}) {
  const collect = input.collect?.bind(input);
  return startPgBossBoundedWorker(client, { name: NEWS_FEED_QUEUE.name, maximumRecoveries: 0,
    parse: value => newsFeedJobReferenceSchema.parse(value), identify: newsFeedJobId, assertQueue: assertNewsFeedQueue,
    errors: { unresolved: "news_feed_delivery_unresolved", config: "news_feed_worker_config_invalid", close: "news_feed_worker_close_uncertain" },
  }, { concurrency: input.concurrency, deliver: collect });
}
