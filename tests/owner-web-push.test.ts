import assert from "node:assert/strict";
import test from "node:test";
import { deliverOwnerPushV1, ownerPushEndpointAllowedV1, ownerPushPayloadIsMinimalV1, ownerPushPayloadV1,
  parseWebPushSubscriptionV1, type OwnerNotificationChannelV1, type OwnerPushStoreV1 } from "../src/web-push/v1";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { OwnerWebPushSettings } from "../private-app/app/owner-web-push";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store";

// The endpoint is a REAL push-service host, not `push.example.invalid`. Since
// 0227 the allow list is enforced in policy.ts, in channel.ts and in the
// database, so a fixture on a host that is not on the list would be testing a
// refusal rather than the behaviour each test is named for.
const subscription = Object.freeze({ id: "push:a", tenantId: "tenant:test", endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
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
    // A failure must be recorded, not ignored: the 0174 row's state is what the
    // next call's `reserve` reads, so a store whose `failed` is a no-op would
    // make a re-sendable retry look like a delivery.
    async failed(_tenant, id, key) { reservations.set(`${id}:${key}`, "failed"); },
  };
}

test("owner subscriptions accept only HTTPS endpoint material", () => {
  const valid = parseWebPushSubscriptionV1({ endpoint: subscription.endpoint, expirationTime: null, keys: { p256dh: subscription.p256dh, auth: subscription.auth } });
  assert.equal(valid.endpoint, subscription.endpoint);
  for (const invalid of [{ endpoint: "http://fcm.googleapis.com/x", expirationTime: null, keys: valid.keys },
    { endpoint: subscription.endpoint, expirationTime: null, keys: { p256dh: "not base64!", auth: subscription.auth } }])
    assert.throws(() => parseWebPushSubscriptionV1(invalid), /web_push_subscription_invalid/);
});

test("a subscription endpoint is refused unless it is a known push service over HTTPS", () => {
  // The four the brief names, plus a per-notification Windows host.
  for (const allowed of ["https://web.push.apple.com/abc", "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://db5p.notify.windows.com/w/?token=abc",
    "https://DB5P.NOTIFY.WINDOWS.COM/w/"]) {
    assert.equal(ownerPushEndpointAllowedV1(allowed), true, `${allowed} is a real push service`);
  }
  // Every one of these is the same SSRF: get the web process, which holds the
  // VAPID private key, to POST somewhere the attacker chose.
  for (const refused of [
    "https://evil.invalid/push",                                  // not a push service
    "https://localhost:8443/push",                                // loopback
    "https://169.254.169.254/latest/meta-data/",                  // link-local metadata
    "http://fcm.googleapis.com/fcm/send/abc",                     // not https
    "https://web.push.apple.com.evil.invalid/abc",                // suffix on an allowed name
    "https://evil.invalid/?next=https://web.push.apple.com/",     // allowed name in a query
    "https://fcm.googleapis.com.evil.invalid/",                   // prefix on an allowed name
    "https://user:pass@fcm.googleapis.com/",                       // credentials in the URL
    "https://xnotify.windows.com/",                               // the wildcard needs a label
    "https://notify.windows.com/",                                // and exactly one
    "https://x.y.notify.windows.com/",                            // label must be a single DNS label
    "https://.notify.windows.com/",
    "https://fcm.googleapis.com:8443/fcm/send/abc",              // a non-default port
    "https://fcm.googleapis.com/fcm/send/abc?x=1",                // a query
    "https://fcm.googleapis.com/fcm/send/abc#x",                  // a fragment
    "not a url at all",
  ]) {
    assert.equal(ownerPushEndpointAllowedV1(refused), false, `${refused} must be refused`);
    // And refused at the earliest point there is: a subscribe never stores it.
    assert.throws(() => parseWebPushSubscriptionV1({ endpoint: refused, expirationTime: null,
      keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) } }), /web_push_subscription_invalid/,
    `a subscribe must not store ${refused}`);
  }
  for (const notString of [null, undefined, 42, {}, [], true]) {
    assert.equal(ownerPushEndpointAllowedV1(notString), false);
  }
  assert.equal(ownerPushEndpointAllowedV1(`https://fcm.googleapis.com/${"a".repeat(2100)}`), false,
    "an absurdly long endpoint is refused rather than parsed");
});

test("the channel refuses an off-list endpoint before it makes any request", async () => {
  // The subscribe route is the earliest check, but it is not the one that stops
  // the request: a row that predates the allow list, or one written by anything
  // else holding INSERT, reaches the channel. The channel is where the outbound
  // POST happens, so the channel is where the refusal has to be.
  const { createWebPushChannelV1 } = await import("../src/web-push/v1/channel");
  // A REAL EC P-256 VAPID key pair, because `createWebPushChannelV1` calls
  // webpush.setVapidDetails and the library validates the key length. A
  // repeated-character placeholder is refused there, which would make this
  // test fail for a reason that has nothing to do with the allow list.
  const pair = await import("node:crypto").then(crypto => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }));
  const channel = createWebPushChannelV1({ subject: "mailto:owner@example.invalid",
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).subarray(-65).toString("base64url"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64url") });
  const payload = ownerPushPayloadV1("needs_you", "/needs-me", "needs:record-1");
  // No network is reached: the refusal throws before webpush is called, so this
  // is a pure assertion and needs no listening server.
  await assert.rejects(() => channel.send({ ...subscription, endpoint: "https://evil.invalid/steal" }, payload),
    /web_push_endpoint_refused/);
  // A payload carrying anything beyond title/link/tag is still refused, and the
  // payload check runs first so the endpoint check is not the only guard.
  await assert.rejects(() => channel.send(subscription, { ...payload, taskText: "private" } as never),
    /web_push_payload_refused/);
});

test("a resolved non-2xx response is a failure, and the ledger never records it as delivered", async () => {
  // Unreachable through the real `web-push` library, which REJECTS on non-2xx
  // rather than resolving. That is precisely why the ordering has to be enforced
  // here instead of being left to an external library's undocumented contract:
  // `store.delivered()` is a terminal, non-retryable write, so recording it for
  // a response outside 2xx would settle the item as delivered and the phone
  // would never ring for that stall, ever.
  const memory = store();
  const failures: { statusCode: number | undefined; removed: boolean }[] = [];
  const resolved: OwnerNotificationChannelV1 = { kind: "web-push", async send() { return { statusCode: 500 }; } };
  const result = await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "needs_you", link: "/needs-me",
    dedupeKey: "needs:item-500", now: "2026-09-29T00:00:00.000Z", store: memory, channel: resolved,
    onFailure: failure => failures.push({ statusCode: failure.statusCode, removed: failure.removed }) });
  assert.deepEqual(result, { delivered: 0, deduplicated: 0, removed: 0 }, "a 500 is not a delivery");
  assert.deepEqual(failures, [{ statusCode: 500, removed: false }], "and it is reported like a thrown failure");
  assert.equal(memory.reservations.get("push:a:needs:item-500"), "failed",
    "the 0174 row is left re-sendable, so the bounded retry still owns what happens next");
  // A retry therefore really reaches the endpoint rather than being suppressed
  // as a duplicate -- the property a delivered row would have destroyed.
  let sends = 0;
  const still500: OwnerNotificationChannelV1 = { kind: "web-push", async send() { sends++; return { statusCode: 503 }; } };
  const retried = await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "needs_you", link: "/needs-me",
    dedupeKey: "needs:item-500", now: "2026-09-29T00:01:00.000Z", store: memory, channel: still500 });
  assert.equal(sends, 1, "a resolved non-2xx does not suppress the retry");
  assert.deepEqual(retried, { delivered: 0, deduplicated: 0, removed: 0 });
  // 2xx still takes the delivered path, so the reorder did not break the happy case.
  const memory2 = store();
  const ok: OwnerNotificationChannelV1 = { kind: "web-push", async send() { return { statusCode: 201 }; } };
  assert.deepEqual(await deliverOwnerPushV1({ tenantId: "tenant:test", kind: "needs_you", link: "/needs-me",
    dedupeKey: "needs:item-201", now: "2026-09-29T00:00:00.000Z", store: memory2, channel: ok }),
  { delivered: 1, deduplicated: 0, removed: 0 });
  assert.equal(memory2.reservations.get("push:a:needs:item-201"), "delivered");
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
