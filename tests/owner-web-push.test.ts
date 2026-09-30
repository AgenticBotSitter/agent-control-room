import assert from "node:assert/strict";
import test from "node:test";
import { deliverOwnerPushV1, ownerPushPayloadIsMinimalV1, ownerPushPayloadV1, parseWebPushSubscriptionV1,
  type OwnerNotificationChannelV1, type OwnerPushStoreV1 } from "../src/web-push/v1";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { OwnerWebPushSettings } from "../private-app/app/owner-web-push";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store";

const subscription = Object.freeze({ id: "push:a", tenantId: "tenant:test", endpoint: "https://push.example.invalid/subscription",
  p256dh: "A".repeat(87), auth: "B".repeat(22), expiresAt: null });

function store(): OwnerPushStoreV1 & { removed: string[]; reservations: Map<string, string> } {
  const reservations = new Map<string, string>(), removed: string[] = [];
  return { removed, reservations,
    async subscribe() {}, async unsubscribe(_tenant, endpoint) { removed.push(endpoint); return true; },
    async list() { return [subscription]; },
    // The three-way answer, not a boolean. A boolean cannot tell "already
    // delivered" from "a previous attempt failed", and collapsing them is the
    // bug this stream's stress runs found in the real store: a retry after a
    // failed send was counted as a duplicate and the item reported delivered
    // while the phone had never been rung.
    async reserve(_tenant, id, key) {
      const value = `${id}:${key}`, prior = reservations.get(value);
      if (prior === "delivered") return "already_delivered" as const;
      reservations.set(value, "reserved");
      return "reserved" as const;
    },
    async delivered(_tenant, id, key) { reservations.set(`${id}:${key}`, "delivered"); },
    async failed() {},
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

test("a permanent push failure removes the subscription; a delivered one is never sent twice", async () => {
  const gone = store(); let goneCalls = 0;
  const failing: OwnerNotificationChannelV1 = { kind: "web-push", async send() { goneCalls++; throw { statusCode: 410 }; } };
  const first = await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "night_finished", link: "/morning",
    dedupeKey: "night:run-1", now: "2026-09-29T00:00:00.000Z", store: gone, channel: failing });
  assert.deepEqual(first, { delivered: 0, deduplicated: 0, removed: 1 });
  assert.equal(goneCalls, 1);
  assert.deepEqual(gone.removed, [subscription.endpoint]);

  // A FAILED send leaves a re-sendable row, so the retry is attempted rather
  // than being mistaken for a delivery. This is the distinction the whole
  // bounded-retry dispatcher rests on: the ledger records that a send was
  // attempted, not that one landed.
  const second = await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "night_finished", link: "/morning",
    dedupeKey: "night:run-1", now: "2026-09-29T00:01:00.000Z", store: gone, channel: failing });
  assert.equal(second.deduplicated, 0, "a previous failure is not a delivery");
  assert.equal(goneCalls, 2, "so the retry really reaches the endpoint");

  // A DELIVERED send is terminal: the second pass is deduplicated and the
  // channel is never called a second time.
  const kept = store(); let keptCalls = 0;
  const working: OwnerNotificationChannelV1 = { kind: "web-push", async send() { keptCalls++; return { statusCode: 201 }; } };
  const delivered = await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "night_finished", link: "/morning",
    dedupeKey: "night:run-2", now: "2026-09-29T00:00:00.000Z", store: kept, channel: working });
  assert.deepEqual(delivered, { delivered: 1, deduplicated: 0, removed: 0 });
  const repeated = await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "night_finished", link: "/morning",
    dedupeKey: "night:run-2", now: "2026-09-29T00:01:00.000Z", store: kept, channel: working });
  assert.deepEqual(repeated, { delivered: 0, deduplicated: 1, removed: 0 });
  assert.equal(keptCalls, 1, "exactly one push for one event");
});

test("a send that fails is reported to the caller, not only counted", async () => {
  const memory = store();
  const failures: { statusCode: number | undefined; removed: boolean }[] = [];
  const failing: OwnerNotificationChannelV1 = { kind: "web-push", async send() { throw { statusCode: 503 }; } };
  const result = await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "needs_you", link: "/needs-me",
    dedupeKey: "needs:item-1", now: "2026-09-29T00:00:00.000Z", store: memory, channel: failing,
    onFailure: failure => failures.push({ statusCode: failure.statusCode, removed: failure.removed }) });
  // The counters alone cannot distinguish this from "no subscription at all",
  // and a caller that guesses wrong stops retrying a phone that is merely
  // offline. The failure report is what makes the two tellable apart.
  assert.deepEqual(result, { delivered: 0, deduplicated: 0, removed: 0 });
  assert.deepEqual(failures, [{ statusCode: 503, removed: false }]);
});

test("phone notification controls are owner-facing labelled buttons", () => {
  const html = renderToStaticMarkup(createElement(OwnerWebPushSettings));
  assert.match(html, /Phone notifications/); assert.match(html, /Subscribe this browser/);
  assert.match(html, /Unsubscribe this browser/); assert.match(html, /Send test/);
});

test("subscription reads prune expired endpoints before returning send targets", async () => {
  const statements: string[] = [];
  const db = { async query(sql: string) { statements.push(sql); return { rows: [] }; } };
  await new PostgresOwnerPushStoreV1(db as never).list("tenant:test");
  assert.match(statements[0]!, /DELETE FROM owner_web_push_subscriptions/);
  assert.match(statements[0]!, /expires_at<=now\(\)/);
});
