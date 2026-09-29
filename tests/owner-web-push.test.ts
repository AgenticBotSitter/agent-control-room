import assert from "node:assert/strict";
import test from "node:test";
import { deliverOwnerPushV1, ownerPushPayloadIsMinimalV1, ownerPushPayloadV1, parseWebPushSubscriptionV1,
  type OwnerNotificationChannelV1, type OwnerPushStoreV1 } from "../src/web-push/v1";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { OwnerWebPushSettings } from "../private-app/app/owner-web-push";

const subscription = Object.freeze({ id: "push:a", tenantId: "tenant:test", endpoint: "https://push.example.invalid/subscription",
  p256dh: "A".repeat(87), auth: "B".repeat(22), expiresAt: null });

function store(): OwnerPushStoreV1 & { removed: string[]; reservations: Set<string> } {
  const reservations = new Set<string>(), removed: string[] = [];
  return { removed, reservations,
    async subscribe() {}, async unsubscribe(_tenant, endpoint) { removed.push(endpoint); return true; },
    async list() { return [subscription]; }, async reserve(_tenant, id, key) { const value = `${id}:${key}`; if (reservations.has(value)) return false; reservations.add(value); return true; },
    async delivered() {}, async failed() {},
  };
}

test("owner subscriptions accept only HTTPS endpoint material", () => {
  const valid = parseWebPushSubscriptionV1({ endpoint: subscription.endpoint, expirationTime: null, keys: { p256dh: subscription.p256dh, auth: subscription.auth } });
  assert.equal(valid.endpoint, subscription.endpoint);
  for (const invalid of [{ endpoint: "http://push.example.invalid/x", expirationTime: null, keys: valid.keys },
    { endpoint: subscription.endpoint, expirationTime: null, keys: { p256dh: "not base64!", auth: subscription.auth } }])
    assert.throws(() => parseWebPushSubscriptionV1(invalid), /web_push_subscription_invalid/);
});

test("push payloads are minimal, local-link-only, and reject smuggled private data", () => {
  const payload = ownerPushPayloadV1("needs_you", "/needs-me", "needs:record-1");
  assert.deepEqual(payload, { title: "Control Room needs you", link: "/needs-me", tag: "needs:record-1" });
  assert.equal(ownerPushPayloadIsMinimalV1(payload), true);
  assert.equal(ownerPushPayloadIsMinimalV1({ ...payload, taskText: "private task details" }), false);
  assert.throws(() => ownerPushPayloadV1("needs_you", "https://outside.invalid", "needs:record-1"), /owner_push_link_invalid/);
});

test("dedupe reserves one notification and a permanent failure cleans the subscription", async () => {
  const memory = store(); let calls = 0;
  const channel: OwnerNotificationChannelV1 = { kind: "web-push", async send() { calls++; throw { statusCode: 410 }; } };
  const first = await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "night_finished", link: "/morning", dedupeKey: "night:run-1",
    now: "2026-09-29T00:00:00.000Z", store: memory, channel });
  const second = await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "night_finished", link: "/morning", dedupeKey: "night:run-1",
    now: "2026-09-29T00:01:00.000Z", store: memory, channel });
  assert.deepEqual(first, { delivered: 0, deduplicated: 0, removed: 1 });
  assert.deepEqual(second, { delivered: 0, deduplicated: 1, removed: 0 });
  assert.equal(calls, 1); assert.deepEqual(memory.removed, [subscription.endpoint]);
});

test("phone notification controls are owner-facing labelled buttons", () => {
  const html = renderToStaticMarkup(createElement(OwnerWebPushSettings));
  assert.match(html, /Phone notifications/); assert.match(html, /Subscribe this browser/);
  assert.match(html, /Unsubscribe this browser/); assert.match(html, /Send test/);
});
