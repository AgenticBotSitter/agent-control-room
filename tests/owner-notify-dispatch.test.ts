import assert from "node:assert/strict";
import test from "node:test";
import { nativeTaskFixture } from "../tests/native-task-fixture.ts";
import { OwnerPushDispatcherV1, PostgresOwnerPushStoreV1 } from "../src/web-push/v1/index.ts";

// SQL observations below are PGlite-only and must remain UNCONFIRMED for production.
async function fixture(t: any) {
  const f = await nativeTaskFixture(); t.after(() => f.close());
  const store = new PostgresOwnerPushStoreV1(f.db); let clock = Date.now();
  const sub = (id: string) => ({ id: "", tenantId: "tenant:test", endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: "A", auth: "B", expiresAt: null });
  const add = async (id: string, kind = "incident") => {
    const payload = { id, tenantId: "tenant:test", kind, state: "open", requestedAction: "Review saved warning", reasonCode: "fixture_warning",
      blockedWorkItemIds: [], legalResponses: [], evidence: [], createdAt: new Date(clock).toISOString(), deliveryState: "not_requested" };
    await f.raw.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
      VALUES($1,'tenant:test',NULL,NULL,$2,'open','not_requested',$3,NULL,$4::jsonb)`, [id, kind, payload.createdAt, JSON.stringify(payload)]);
  };
  const dispatcher = (send: any, db = f.db) => new OwnerPushDispatcherV1({ db, tenantId: "tenant:test", store, channel: { kind: "web-push", send }, clock: () => clock });
  return { ...f, store, sub, add, dispatcher, advance(ms: number) { clock += ms; }, now: () => clock };
}

test("U01: PGlite mixed dead and temporary targets retry only the recovered phone", async t => {
  const f = await fixture(t); await f.add("attention:mixed"); await f.store.subscribe(f.sub("one")); await f.store.subscribe(f.sub("two"));
  const listed = await f.store.list("tenant:test"); const gone = listed[0].id; let sends = 0, recovered = false;
  const d = f.dispatcher(async (s: any) => { sends++; if (s.id === gone) throw { statusCode: 410 }; if (!recovered) throw { statusCode: 503 }; return { statusCode: 201 }; });
  const first = await d.dispatch(); assert.equal(first[0].result, "retry_scheduled"); assert.equal(first[0].attempt, 1);
  recovered = true; f.advance(300001); await d.dispatch(); assert.equal(sends, 3);
});

test("U04: PGlite 429 respects provider Retry-After and the normal attempt budget", async t => {
  const f = await fixture(t); await f.add("attention:rate"); await f.store.subscribe(f.sub("phone")); let sends = 0;
  const d = f.dispatcher(async () => { sends++; throw { statusCode: 429, headers: { "retry-after": "7200" } }; });
  const first = await d.dispatch(); assert.equal(Date.parse(first[0].nextAttemptAt) - f.now(), 7200000);
  f.advance(30001); await d.dispatch(); assert.equal(sends, 1);
  f.advance(7200000); await d.dispatch(); assert.equal(sends, 2);
});


test("U04: Retry-After accepts delay and HTTP date, rejects bad input and caps excessive waits", async () => {
  const { ownerPushRetryAfterMsV1 } = await import("../src/web-push/v1/delivery");
  const now = "2026-10-01T12:00:00Z";
  assert.equal(ownerPushRetryAfterMsV1({ "retry-after": "7200" }, now), 7200000);
  assert.equal(ownerPushRetryAfterMsV1({ "Retry-After": "Thu, 01 Oct 2026 14:00:00 GMT" }, now), 7200000);
  assert.equal(ownerPushRetryAfterMsV1({ "retry-after": "9999999999" }, now), 86400000);
  for (const value of [null, "7200", {}, { "retry-after": 7200 }, { "retry-after": "-1" }, { "retry-after": "0" },
    { "retry-after": "2026-10-01" }, { "retry-after": "Wed, 30 Sep 2026 12:00:00 GMT" }, { "retry-after": "Thu, 99 Oct 2026 14:00:00 GMT" }])
    assert.equal(ownerPushRetryAfterMsV1(value, now), undefined);
});

test("U01: PGlite accepted phone plus removed phone settles delivered", async t => {
  const f = await fixture(t); await f.add("attention:accepted"); await f.store.subscribe(f.sub("one")); await f.store.subscribe(f.sub("two"));
  const gone = (await f.store.list("tenant:test"))[0].id;
  const result = await f.dispatcher(async (s: any) => { if (s.id === gone) throw { statusCode: 410 }; return { statusCode: 201 }; }).dispatch();
  assert.equal(result[0].result, "delivered");
});
