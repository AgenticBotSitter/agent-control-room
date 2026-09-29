import type { OwnerNotificationChannelV1, OwnerPushEventKindV1, OwnerPushStoreV1 } from "./types";
import { ownerPushPayloadV1 } from "./policy";

/** One reserve per (subscription,event), then a best-effort send. 410/404 subscriptions are removed. */
export async function deliverOwnerPushV1(input: Readonly<{ tenantId: string; kind: OwnerPushEventKindV1; link: string;
  dedupeKey: string; now: string; store: OwnerPushStoreV1; channel: OwnerNotificationChannelV1 }>): Promise<{ delivered: number; deduplicated: number; removed: number }> {
  if (!/^[a-z][a-z0-9:_-]{2,180}$/.test(input.dedupeKey)) throw new Error("owner_push_dedupe_key_invalid");
  const payload = ownerPushPayloadV1(input.kind, input.link, input.dedupeKey);
  let delivered = 0, deduplicated = 0, removed = 0;
  for (const subscription of await input.store.list(input.tenantId)) {
    if (!await input.store.reserve(input.tenantId, subscription.id, input.dedupeKey, input.now)) { deduplicated++; continue; }
    try {
      const response = await input.channel.send(subscription, payload);
      await input.store.delivered(input.tenantId, subscription.id, input.dedupeKey, input.now);
      if (response.statusCode >= 200 && response.statusCode < 300) delivered++;
    } catch (error) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error
        && typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : undefined;
      await input.store.failed(input.tenantId, subscription.id, input.dedupeKey, statusCode, input.now);
      if (statusCode === 404 || statusCode === 410) { await input.store.unsubscribe(input.tenantId, subscription.endpoint); removed++; }
    }
  }
  return { delivered, deduplicated, removed };
}
