import type { OwnerNotificationChannelV1, OwnerPushEventKindV1, OwnerPushStoreV1 } from "./types";
import { ownerPushPayloadV1 } from "./policy";

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
}

/** One reserve per (subscription,event), then a best-effort send. 410/404 subscriptions are removed. */
export async function deliverOwnerPushV1(input: Readonly<{ tenantId: string; kind: OwnerPushEventKindV1; link: string;
  dedupeKey: string; now: string; store: OwnerPushStoreV1; channel: OwnerNotificationChannelV1;
  onFailure?: (failure: OwnerPushFailureV1) => void }>): Promise<{ delivered: number; deduplicated: number; removed: number }> {
  if (!/^[a-z][a-z0-9:_-]{2,180}$/.test(input.dedupeKey)) throw new Error("owner_push_dedupe_key_invalid");
  const payload = ownerPushPayloadV1(input.kind, input.link, input.dedupeKey);
  let delivered = 0, deduplicated = 0, removed = 0;
  for (const subscription of await input.store.list(input.tenantId)) {
    // The three-way answer is load bearing. A boolean version of this returned
    // false for BOTH "already delivered" and "a previous attempt failed", and
    // counting the second as a duplicate made a permanently broken endpoint
    // indistinguishable from a delivered notification -- so a caller that
    // trusted the duplicate count reported success for a push that never
    // arrived, and stopped retrying.
    const outcome = await input.store.reserve(input.tenantId, subscription.id, input.dedupeKey, input.now);
    if (outcome === "already_delivered") { deduplicated++; continue; }
    // 'reserved' and 'previous_attempt_failed' both mean "send it now": the
    // second is a legitimate retry of a send that never landed.
    try {
      const response = await input.channel.send(subscription, payload);
      // The status is checked BEFORE the ledger is written, not after. The real
      // `web-push` library rejects on any non-2xx rather than resolving with
      // one, so a resolved non-2xx is unreachable through it today -- which is
      // exactly why the ordering has to be enforced by this code rather than by
      // an external library's undocumented contract. `store.delivered()` is a
      // TERMINAL, non-retryable write to the 0174 ledger: recording it for a
      // response outside 2xx would make the dispatcher settle the item as
      // delivered and never try again, so the phone would silently never ring
      // for a stall.
      if (response.statusCode >= 200 && response.statusCode < 300) {
        await input.store.delivered(input.tenantId, subscription.id, input.dedupeKey, input.now);
        delivered++;
      } else {
        // Same shape as a thrown failure, and treated as one: the reservation
        // stays re-sendable, the failure is reported, and the caller's bounded
        // retry still owns what happens next.
        await input.store.failed(input.tenantId, subscription.id, input.dedupeKey, response.statusCode, input.now);
        input.onFailure?.({ subscriptionId: subscription.id, statusCode: response.statusCode, removed: false });
      }
    } catch (error) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error
        && typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : undefined;
      await input.store.failed(input.tenantId, subscription.id, input.dedupeKey, statusCode, input.now);
      const gone = statusCode === 404 || statusCode === 410;
      if (gone) { await input.store.unsubscribe(input.tenantId, subscription.endpoint); removed++; }
      input.onFailure?.({ subscriptionId: subscription.id, statusCode, removed: gone });
    }
  }
  return { delivered, deduplicated, removed };
}
