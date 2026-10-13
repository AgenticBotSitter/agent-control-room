import type { OwnerNotificationChannelV1, OwnerPushEventKindV1, OwnerPushStoreV1, OwnerPushCompletionResultV1 } from "./types";
import { ownerPushPayloadV1 } from "./policy";
import { pushRejectionReasonV1 } from "../../installer/shared/vapid.mjs";

/** What happened to one send. `onFailure` is the ONLY way a caller learns that a
 * send failed: the outcome counters deliberately do not carry it, because
 * "no subscription at all" and "every subscription's endpoint is down" produce
 * identical counters. A caller that must decide between "nothing to retry" and
 * "retry this later" -- the bounded-retry dispatcher -- needs that distinction,
 * and guessing it from the counters is how a permanently dead push service
 * looks like an owner with no phone. */
export interface OwnerPushFailureV1 {
  readonly subscriptionId: string;
  readonly statusCode: number | undefined;
  readonly removed: boolean;
  readonly rejectionReason?: string;
  readonly retryAfterMs?: number;
}

/** Honor provider throttling, bounded to one day and never earlier than now. */
export function ownerPushRetryAfterMsV1(headers: unknown, now: string): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const values = headers as Record<string, unknown>, raw = values["retry-after"] ?? values["Retry-After"];
  if (typeof raw !== "string") return undefined;
  const delay = /^\d{1,10}$/.test(raw) ? Number(raw) * 1000
    : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw) ? Date.parse(raw) - Date.parse(now) : NaN;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 86_400_000) : undefined;
}

/**
 * One reserve per (subscription,event), then a best-effort send.
 * 410/404 subscriptions are removed.
 *
 * ## The send is not exactly once, and cannot be
 *
 * The reservation is taken, the event is sent, and only then is the delivery
 * recorded -- in that order, deliberately. A process killed between the send and
 * the record leaves a provider that accepted an event and a row still
 * 'reserved', and the reservation's three-way outcome maps that row to
 * "previous_attempt_failed", which is RE-SENDABLE. So a retry can hand the
 * provider the same event twice.
 *
 * That is the right trade and it is measured, not assumed: recording the
 * delivery BEFORE sending would make a crash in that window a LOST alert, and a
 * lost alert for a stall the owner has not been told about is worse than a
 * repeated one. The alternative -- making the provider call and the database
 * write atomic -- is not available to us at all; the two are different systems.
 *
 * What closes the gap is on the receiver: the owner browser's service worker
 * keeps a durable receipt of the event tags it has surfaced
 * (private-app/app/service-worker.js), so the owner sees one alert per Needs-you
 * item even when the provider is handed the event twice. `dedupeKey` is the event
 * identity that makes that possible -- it is derived from the item, not generated,
 * so every attempt for one item proposes the same tag.
 *
 * Both halves are proved: this half in
 * tests/owner-push-dispatch-postgres.test.ts on real PostgreSQL as the production
 * owner-web login, and the receiver half in
 * tests/owner-push-service-worker.test.mjs in real Chromium with real IndexedDB.
 */
export async function deliverOwnerPushV1(input: Readonly<{ tenantId: string; kind: OwnerPushEventKindV1; link: string;
  dedupeKey: string; now: string; store: OwnerPushStoreV1; channel: OwnerNotificationChannelV1;
  subscriptionEndpoint?: string; onFailure?: (failure: OwnerPushFailureV1) => void;
  /** The dispatcher persists safe completion before publishing a retryable head.
   * Direct test notifications retain the existing ledger path. */
  recordResult?: (result: OwnerPushCompletionResultV1) => Promise<void>;
  maySend?: () => Promise<boolean> }>): Promise<{ delivered: number; deduplicated: number; removed: number }> {
  if (!/^[a-z][a-z0-9:_-]{2,180}$/.test(input.dedupeKey)) throw new Error("owner_push_dedupe_key_invalid");
  const payload = ownerPushPayloadV1(input.kind, input.link, input.dedupeKey);
  let delivered = 0, deduplicated = 0, removed = 0;
  for (const subscription of await input.store.list(input.tenantId)) {
    if (input.subscriptionEndpoint !== undefined && subscription.endpoint !== input.subscriptionEndpoint) continue;
    if (input.maySend && !await input.maySend()) break;
    const outcome = await input.store.reserve(input.tenantId, subscription.id, input.dedupeKey, input.now);
    if (outcome === "already_delivered") { deduplicated++; continue; }
    // A slow earlier send or reservation can outlive either authority. Reload
    // the subscription too, so withdrawn endpoints and obsolete keys from the
    // first list cannot authorize a never-started provider request.
    let target = subscription;
    if (input.maySend) {
      let current = (await input.store.list(input.tenantId)).find(row => row.id === subscription.id);
      if (!current) continue;
      if (!await input.maySend()) break;
      target = current;
    }
    let statusCode: number | undefined, failure: unknown;
    try {
      const response = await input.channel.send(target, payload);
      statusCode = response.statusCode;
    } catch (error) {
      failure = error;
      statusCode = typeof error === "object" && error !== null && "statusCode" in error
        && typeof error.statusCode === "number" ? error.statusCode : undefined;
    }
    const accepted = Number.isInteger(statusCode) && statusCode! >= 200 && statusCode! < 300;
    // Invalid provider status is normalized once before either persistence sink.
    // A SQL CHECK refusal is bookkeeping, never a new provider failure.
    const safeStatus = Number.isInteger(statusCode) && statusCode! >= 100 && statusCode! <= 599 ? statusCode! : null;
    const gone = !accepted && (statusCode === 404 || statusCode === 410);
    if (accepted) delivered++;
    else {
      const rejectionReason = pushRejectionReasonV1(failure);
      if (rejectionReason !== undefined) console.warn(JSON.stringify({ event: "owner_push_rejected",
        subscriptionId: subscription.id, statusCode: safeStatus, rejectionReason }));
      input.onFailure?.({ subscriptionId: subscription.id, statusCode: safeStatus ?? undefined, removed: gone,
        rejectionReason,
        retryAfterMs: statusCode === 429 && typeof failure === "object" && failure !== null && "headers" in failure
          ? ownerPushRetryAfterMsV1(failure.headers, input.now) : undefined });
    }
    if (input.recordResult) {
      // Outside the provider catch: refusal cannot relabel known acceptance or
      // overwrite it with a failure. The caller owns durable repair.
      await input.recordResult({ subscription_id: subscription.id, event_tag: input.dedupeKey,
        result: accepted ? "delivered" : "failed", status_code: safeStatus,
        completed_at: input.now, remove: gone });
    } else if (accepted) {
      await input.store.delivered(input.tenantId, subscription.id, input.dedupeKey, input.now);
    } else {
      await input.store.failed(input.tenantId, subscription.id, input.dedupeKey, safeStatus ?? undefined, input.now);
      if (gone) await input.store.unsubscribe(input.tenantId, subscription.endpoint);
    }
    if (gone) removed++;
  }
  return { delivered, deduplicated, removed };
}
