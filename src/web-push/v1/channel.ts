import webpush from "web-push";
import type { OwnerNotificationChannelV1, OwnerPushPayloadV1, OwnerPushSubscriptionRecordV1, OwnerWebPushConfigV1 } from "./types";
import { ownerPushEndpointAllowedV1, ownerPushPayloadIsMinimalV1 } from "./policy";

export function createWebPushChannelV1(config: OwnerWebPushConfigV1): OwnerNotificationChannelV1 {
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(config.subject) || !/^[A-Za-z0-9_-]{80,100}$/.test(config.publicKey)
    || !/^[A-Za-z0-9_-]{40,100}$/.test(config.privateKey)) throw new Error("web_push_config_invalid");
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return Object.freeze({ kind: "web-push", async send(subscription: OwnerPushSubscriptionRecordV1, payload: OwnerPushPayloadV1) {
    if (!ownerPushPayloadIsMinimalV1(payload)) throw new Error("web_push_payload_refused");
    // The allow list is checked a SECOND time here, at the point the outbound
    // request is actually made, and not only at subscribe time. The subscribe
    // route is the earliest and cheapest place to refuse, but a row written
    // before the allow list existed, or by anything else holding INSERT on the
    // subscriptions table, would otherwise be dialled on the dispatcher's own
    // schedule. This is the check that actually stops the request, so it is the
    // one that is not optional.
    if (!ownerPushEndpointAllowedV1(subscription.endpoint)) throw new Error("web_push_endpoint_refused");
    const response = await webpush.sendNotification({ endpoint: subscription.endpoint,
      expirationTime: subscription.expiresAt ? Date.parse(subscription.expiresAt) : null,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload), { TTL: 86400, urgency: "normal", timeout: 5000 });
    return { statusCode: response.statusCode };
  } });
}
