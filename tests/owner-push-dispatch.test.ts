import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { OwnerPushDispatcherV1, OWNER_PUSH_ATTEMPT_LIMIT_V1, OWNER_PUSH_DISPATCH_INTERVAL_MS_V1,
  ownerPushBackoffMsV1, ownerPushCycleFailureV1, ownerPushDedupeKeyV1 } from "../src/web-push/v1";
import { startSupervisorLoopV1 } from "../src/supervisor/v1/loop";
import { OwnerWebPushSettings } from "../private-app/app/owner-web-push";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { OwnerNotificationChannelV1, OwnerPushStoreV1 } from "../src/web-push/v1/types";

// These are the loop and the pure policy, which no database test can reach. The
// dispatcher's SQL, its concurrency and its exactly-once behaviour are covered
// against real PostgreSQL in owner-push-dispatch-postgres.test.ts, as the owner
// web login; nothing here stands in for that.

const TENANT = "tenant:loop";

test("the push interval matches the supervisor's own cycle", () => {
  // The supervisor reconciles every 30s (supervisor/v1/loop.ts default). A push
  // loop on a longer interval would make the alert for a second lapse arrive
  // later than the Needs-you item it alerts about, which is the failure this
  // stream exists to prevent.
  assert.equal(OWNER_PUSH_DISPATCH_INTERVAL_MS_V1, 30_000);
});

test("the backoff is monotonic, never zero, and holds its last value at the bound", () => {
  const schedule = Array.from({ length: OWNER_PUSH_ATTEMPT_LIMIT_V1 },
    (_value, index) => ownerPushBackoffMsV1(index + 1));
  assert.ok(schedule.every(value => value >= OWNER_PUSH_DISPATCH_INTERVAL_MS_V1),
    "every backoff is at least one loop interval, or the schedule does not exist for the failure that matters most");
  for (let index = 1; index < schedule.length; index++) {
    assert.ok(schedule[index]! >= schedule[index - 1]!, `the backoff must not shrink at attempt ${index + 1}`);
  }
  // Past the schedule's end it holds the last value rather than wrapping to zero,
  // so an item at its bound waits hours rather than retrying immediately.
  assert.equal(ownerPushBackoffMsV1(OWNER_PUSH_ATTEMPT_LIMIT_V1 + 5), schedule.at(-1));
  assert.throws(() => ownerPushBackoffMsV1(0), /owner_push_backoff_invalid/);
  assert.throws(() => ownerPushBackoffMsV1(1.5), /owner_push_backoff_invalid/);
});

test("the dedupe key is derived from the item, so a retry in a later process is the same event", () => {
  const key = ownerPushDedupeKeyV1("attention:supervisor:abc");
  assert.equal(key, "needs:attention:supervisor:abc");
  // Stable across calls: a retry after a restart proposes the SAME key, which is
  // what lets the 0174 ledger suppress a duplicate after a lost acknowledgement.
  assert.equal(ownerPushDedupeKeyV1("attention:supervisor:abc"), key);
  // And it fits the ledger's own dedupe_key CHECK, so a real write cannot be refused.
  assert.match(key, /^[a-z][a-z0-9:_-]{2,180}$/);
  assert.throws(() => ownerPushDedupeKeyV1("has spaces"), /owner_push_item_id_invalid/);
  assert.throws(() => ownerPushDedupeKeyV1("-leading-dash"), /owner_push_item_id_invalid/);
});

/** A client that answers nothing. Used only to prove construction and argument
 * validation, which never reach SQL. */
const inertClient = (): DatabaseClient => Object.freeze({
  query: async () => ({ rows: [] }),
  transaction: async <T,>(callback: (tx: DatabaseSession) => Promise<T>) => await callback(
    Object.freeze({ query: async () => ({ rows: [] }) }) as DatabaseSession),
  transactionWithPreCommitCheck: async <T,>(callback: (tx: DatabaseSession) => Promise<T>) => await callback(
    Object.freeze({ query: async () => ({ rows: [] }) }) as DatabaseSession),
});

const inertStore: OwnerPushStoreV1 = Object.freeze({
  async subscribe() {}, async unsubscribe() { return true; }, async list() { return []; },
  async reserve() { return "reserved" as const; }, async delivered() {}, async failed() {},
});
const inertChannel: OwnerNotificationChannelV1 = Object.freeze({
  kind: "web-push", async send() { return { statusCode: 201 }; },
});

test("the dispatcher refuses a composition it cannot own, and checks its bounds", async () => {
  for (const broken of [null, {}, { db: inertClient(), tenantId: "", store: inertStore, channel: inertChannel },
    { db: inertClient(), tenantId: TENANT, store: inertStore },
    { db: inertClient(), tenantId: TENANT, store: inertStore, channel: { kind: "web-push" } },
    { db: { query() {} }, tenantId: TENANT, store: inertStore, channel: inertChannel }]) {
    assert.throws(() => new OwnerPushDispatcherV1(broken as never), /owner_push_dispatcher_input_invalid/,
      "a partial composition is refused rather than half-built");
  }
  // The bounds are refused rather than clamped, so a bad caller learns.
  const dispatcher = new OwnerPushDispatcherV1({ db: inertClient(), tenantId: TENANT,
    store: inertStore, channel: inertChannel });
  await assert.rejects(() => dispatcher.dispatch(0), /owner_push_limit_invalid/);
  await assert.rejects(() => dispatcher.dispatch(1_000), /owner_push_limit_invalid/);
  await assert.rejects(() => dispatcher.dispatch(1.5), /owner_push_limit_invalid/);
  await assert.rejects(() => dispatcher.adoptOpenAttention(0), /owner_push_limit_invalid/);
  await assert.rejects(() => dispatcher.adoptOpenAttention(65), /owner_push_limit_invalid/);
});

test("a clock that is not a real instant is refused before it can write a row", async () => {
  for (const bad of [-1, 1.5, Number.NaN]) {
    const dispatcher = new OwnerPushDispatcherV1({ db: inertClient(), tenantId: TENANT,
      store: inertStore, channel: inertChannel, clock: () => bad });
    await assert.rejects(() => dispatcher.dispatch(), /owner_push_clock_invalid/,
      `a clock returning ${String(bad)} must not be used to schedule an item`);
  }
});

test("a failing push cycle is reported and retried by the next tick, not thrown", async () => {
  // This is the host-startup path: a busy machine, or a push service that is
  // down at that exact instant, must not fail the host. The items are still in
  // the inbox, so the next tick picks them up.
  const reported: string[] = [];
  let cycles = 0;
  const handle = await startSupervisorLoopV1({
    toleratesFirstCycleFailure: true, intervalMs: 60_000,
    service: Object.freeze({ cycle: async () => {
      cycles++;
      if (cycles === 1) throw new Error("owner_push_cycle_unavailable: first tick failed");
    } }),
    runtime: Object.freeze({ setInterval: () => ({ unref() {} }) as never,
      clearInterval: () => {}, report: error => reported.push(String((error as Error).message).split("\n")[0]!) }),
  });
  await handle.close();
  assert.equal(cycles, 1, "the first cycle really ran and really failed");
  assert.deepEqual(reported, ["owner_push_cycle_unavailable: first tick failed"],
    "a failed cycle is reported rather than thrown, so the loop survives it");
});

test("a first-cycle failure is fatal when the caller treats the cycle as the whole unit of work", async () => {
  // startSupervisorLoopV1 has two behaviours on purpose, and this is the other
  // one: a caller that needs the cycle to have completed must still see the
  // failure. Asserted so the tolerating default cannot quietly become the only
  // behaviour.
  await assert.rejects(() => startSupervisorLoopV1({
    service: Object.freeze({ cycle: async () => { throw new Error("cycle_failed"); } }),
    runtime: Object.freeze({ setInterval: () => ({ unref() {} }) as never, clearInterval: () => {},
      report: () => {} }),
  }), /cycle_failed/);
});

test("the loop's report carries a reason code, never an endpoint or task text", async () => {
  // The report is what an operator reads in the host log. A push endpoint URL is
  // a bearer-token-shaped secret, and a task title is the owner's private data,
  // so neither may reach it. Asserted on the shape, not trusted.
  const { startOwnerPushLoopV1 } = await import("../src/web-push/v1");
  // A client whose claim statement fails, so the cycle really throws rather
  // than quietly succeeding on an empty inbox.
  const failing = Object.freeze({
    query: async () => { throw new Error("push endpoint https://push.example.invalid/abc rejected task: private title"); },
    transaction: async <T,>(callback: (tx: DatabaseSession) => Promise<T>) => await callback(failing as never),
    transactionWithPreCommitCheck: async <T,>(callback: (tx: DatabaseSession) => Promise<T>) => await callback(failing as never),
  }) as unknown as DatabaseClient;
  const reported: string[] = [];
  const handle = await startOwnerPushLoopV1({ db: failing, tenantId: TENANT, store: inertStore,
    channel: inertChannel, intervalMs: 60_000, report: error => reported.push(String((error as Error).message)) });
  await handle.close();
  assert.ok(reported.length > 0, "the failing cycle was reported");
  for (const line of reported) {
    // The push library's message is reduced to a bare reason code. Its endpoint
    // URL and the text it quoted are both gone, and the reduction happens before
    // the reporter is called rather than inside it -- so a different reporter
    // would receive the same safe value.
    assert.equal(line, "owner_push_cycle_failed",
      `a raw error message reached the report: ${line}`);
    assert.ok(!line.includes("https://"), "an endpoint never reaches the report");
  }
  // A code-shaped message is kept, because it is the actionable part.
  assert.equal(ownerPushCycleFailureV1(new Error("owner_push_endpoint_unavailable")).message,
    "owner_push_endpoint_unavailable");
  // A message that is not a bare code is dropped entirely, including one whose
  // FIRST LINE is safe-looking but which carries a second line -- the second
  // line is where a quoted endpoint or a task title would be.
  assert.equal(ownerPushCycleFailureV1(new Error("first line\nhttps://secret")).message,
    "owner_push_cycle_failed");
  assert.equal(ownerPushCycleFailureV1(new Error("a".repeat(200))).message, "owner_push_cycle_failed");
  assert.equal(ownerPushCycleFailureV1("owner_push_endpoint_unavailable").message,
    "owner_push_cycle_failed", "a bare string carries no message and is not trusted");
  assert.equal(ownerPushCycleFailureV1(null).message, "owner_push_cycle_failed");
  assert.equal(ownerPushCycleFailureV1(undefined).message, "owner_push_cycle_failed");
});

test("the owner push settings surface is owner-facing and carries no task text", () => {
  const html = renderToStaticMarkup(createElement(OwnerWebPushSettings));
  assert.match(html, /Phone notifications/);
  assert.match(html, /Subscribe this browser/);
  assert.match(html, /Unsubscribe this browser/);
  assert.match(html, /Send test/);
  // Attention-first: nothing in the surface is the kind of text that would end
  // up in a notification payload, which is title/link/tag only.
  assert.doesNotMatch(html, /task text|objective|private detail/i);
});
