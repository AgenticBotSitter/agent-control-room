import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { UpdaterAlertSenderV1 } from "../src/updater/v1/alerts.mjs";
import { UpdaterMainLoopV1 } from "../src/updater/v1/runtime.mjs";
import { now, vapid, subscription, uid, AlertStore, scratch } from "./support/owner-notify-fixtures";

test("N08: updater one dead subscription cannot repeat the alert to a healthy phone across restart", async t => {
  const root = await scratch(t), store = new AlertStore([{ id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 }]);
  store.subscriptionsValue.push({ ...subscription, id: "push:gone", endpoint: "https://fcm.googleapis.com/fcm/send/gone", expires_at: null });
  let clock = now, healthy = 0, gone = 0;
  const sender = new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid, now: () => clock, send: async (_v: any, s: any) => {
    if (s.id === "push:gone") { gone++; throw { statusCode: 410 }; } healthy++;
  } } as any);
  await sender.tick(); clock += 30001; await new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid, now: () => clock, send: async (_v: any, s: any) => { if (s.id === "push:gone") { gone++; throw { statusCode: 410 }; } healthy++; } } as any).tick();
  assert.equal(healthy, 1); assert.equal(gone, 1); assert.equal(store.rows[0].sent, true);
});

test("N09: hourly updater suppression retains a fresh warning when its covering summary fails", async t => {
  const root = await scratch(t), store = new AlertStore([{ id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 }]);
  let clock = now, calls = 0, success = 0;
  const sender = new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid, now: () => clock, send: async (_v: any, _s: any, payload: any) => {
    calls++; if (payload.tag.endsWith(".flood")) throw new Error("fixture_summary_dropped"); success++;
  } } as any);
  await sender.tick(); clock += 60000; await sender.reconcile({ backupFailed: true }); await sender.tick();
  const warning = store.rows[1]; assert.equal(warning.sent, false);
  clock += 3600001; await sender.tick(); assert.equal(calls, 3); assert.equal(success, 2); assert.equal(warning.sent, true);
});

test("N14: updater retains a queued warning without spending attempts until a phone subscribes", async t => {
  const root = await scratch(t), row = { id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 }, store = new AlertStore([row]);
  store.subscriptionsValue = []; let clock = now, calls = 0;
  const sender = new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid, now: () => clock, send: async () => { calls++; } } as any);
  for (let i = 0; i < 30; i++) await sender.tick(); assert.ok(!(row as any).sent); assert.equal(row.attempts, 0);
  store.subscriptionsValue = [{ ...subscription, expires_at: null }]; clock += 600001; await sender.tick();
  assert.equal(calls, 1); assert.equal((row as any).sent, true);
});

test("N08: 50 callers with healthy, gone and temporarily failed phones retain receipts across restart", async t => {
  const root = await scratch(t), store = new AlertStore([{ id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 }]);
  store.subscriptionsValue.push({ ...subscription, id: "push:gone", endpoint: "https://fcm.googleapis.com/fcm/send/gone" },
    { ...subscription, id: "push:temporary", endpoint: "https://fcm.googleapis.com/fcm/send/temporary" });
  let clock = now, recovered = false;
  const calls: Record<string, number> = {};
  const send = async (_v: any, s: any) => {
    calls[s.id] = (calls[s.id] ?? 0) + 1;
    if (s.id === "push:gone") throw { statusCode: 410 };
    if (s.id === "push:temporary" && !recovered) throw { statusCode: 503 };
  };
  const options = { root, store, loadVapid: async () => vapid, now: () => clock, send };
  const newSender = new UpdaterAlertSenderV1(options as any);
  const results = await Promise.all(Array.from({ length: 50 }, () => newSender.tick()));
  assert.equal(results.filter(result => result.status === "busy").length, 49);
  assert.equal(store.rows[0].sent, false);
  clock += 30001; recovered = true;
  await new UpdaterAlertSenderV1(options as any).tick();
  assert.deepEqual(calls, { "push:fixture": 1, "push:gone": 1, "push:temporary": 2 });
  assert.equal(store.rows[0].sent, true);
});

test("N09: a spent summary budget never covers fresh rows or consumes their attempts", async t => {
  const root = await scratch(t), store = new AlertStore([{ id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 },
    { id: uid(2), template: "control-room-updater.backup-failed", attempts: 0 }]);
  let clock = now, calls = 0;
  const sender = new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid, now: () => clock, send: async () => { calls++; } } as any);
  await sender.tick(); assert.equal(calls, 2); assert.equal(store.rows[1].errorCode, "updater_push_grouped");
  store.rows.push({ id: uid(3), template: "control-room-updater.backup-failed", attempts: 0 });
  clock += 60000; await sender.tick(); assert.equal(calls, 2);
  assert.ok(!store.rows[2].sent); assert.equal(store.rows[2].attempts, 0);
  clock += 3600001; await sender.tick(); assert.equal(calls, 3); assert.equal(store.rows[2].sent, true);
});

test("N08/N09: stop after accepted fan-out preserves receipts for an unsettled row", async t => {
  const root = await scratch(t), store = new AlertStore([{ id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 }]);
  const original = store.finish.bind(store); let stopped = true, calls = 0;
  store.finish = async (id: string, value: any) => { if (stopped) throw new Error("fixture_stop_before_finish"); await original(id, value); };
  const options = { root, store, loadVapid: async () => vapid, now: () => now, send: async () => { calls++; } };
  await assert.rejects(new UpdaterAlertSenderV1(options as any).tick(), /fixture_stop_before_finish/);
  const state = JSON.parse(await readFile(join(root, "updater-state/push-alert-state.json"), "utf8"));
  assert.deepEqual(state.deliveries[uid(1)], [subscription.id]);
  // SQL reservation recovery is deliberately outside this no-SQL patch.
  store.rows[0].reserved = false; stopped = false;
  await new UpdaterAlertSenderV1(options as any).tick();
  assert.equal(calls, 1); assert.equal(store.rows[0].sent, true);
});

test("N08: malformed receipt state and non-2xx injected transport fail closed", async t => {
  const root = await scratch(t), store = new AlertStore([{ id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 }]);
  const { writeFile } = await import("node:fs/promises");
  const options = { root, store, loadVapid: async () => vapid, now: () => now, send: async () => ({ statusCode: 503 }) };
  const path = join(root, "updater-state/push-alert-state.json");
  for (const extra of [{ deliveries: [] }, { deliveries: { hostile: [] } }, { deliveries: { [uid(1)]: [null] } }, { dead: {} }]) {
    await writeFile(path, JSON.stringify({ schema: "control-room.updater-alert-state/v1", rate: {}, retry: {}, ...extra }));
    await assert.rejects(new UpdaterAlertSenderV1(options as any).tick(), /updater_alert_state_refused/);
  }
  await rm(path);
  await new UpdaterAlertSenderV1(options as any).tick();
  assert.equal(store.rows[0].sent, false);
});

test("N08: receipt persistence failure cannot erase accepted targets on an in-process retry", async t => {
  const root = await scratch(t), store = new AlertStore([{ id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 }]);
  const { writeFile, symlink } = await import("node:fs/promises");
  const path = join(root, "updater-state/push-alert-state.json"), stale = JSON.stringify({ schema: "control-room.updater-alert-state/v1", rate: {}, retry: {} });
  await writeFile(path, stale);
  let clock = now, calls = 0;
  const sender = new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid, now: () => clock, send: async () => {
    calls++; await rm(path); await symlink("unavailable", path);
  } } as any);
  await assert.rejects(sender.tick(), /updater_file_refused/);
  await rm(path); await writeFile(path, stale); clock += 30001;
  await sender.tick(); assert.equal(calls, 1); assert.equal(store.rows[0].sent, true);
});

test("N08: dead targets are invalidated during fan-out as well as later cache reads", async t => {
  const root = await scratch(t), store = new AlertStore([{ id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 },
    { id: uid(2), template: "control-room-updater.web-down", attempts: 0 }]);
  store.subscriptionsValue.push({ ...subscription, id: "push:gone", endpoint: "https://fcm.googleapis.com/fcm/send/gone" });
  let gone = 0;
  const sender = new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid, now: () => now, send: async (_v: any, target: any) => {
    if (target.id === "push:gone") { gone++; throw { statusCode: 404 }; }
  } } as any);
  await sender.tick(); assert.equal(gone, 1);
  assert.equal((await sender.tick()).subscriptions, 1);
});

test("N08: all dead phones retain an undelivered warning and bounded state validation rejects oversized targets", async t => {
  const root = await scratch(t), store = new AlertStore([{ id: uid(1), template: "control-room-updater.backup-failed", attempts: 0 }]);
  const sender = new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid, now: () => now, send: async () => { throw { statusCode: 410 }; } } as any);
  await sender.tick(); assert.equal(store.rows[0].sent, false);
  const { writeFile } = await import("node:fs/promises");
  const path = join(root, "updater-state/push-alert-state.json");
  for (const extra of [{ deliveries: { [uid(1)]: "wrong" } }, { deliveries: { [uid(1)]: Array(101).fill("push:fixture") } },
    { deliveries: { [uid(1)]: ["x".repeat(201)] } }, { dead: [null] }, { dead: ["x".repeat(201)] }]) {
    await writeFile(path, JSON.stringify({ schema: "control-room.updater-alert-state/v1", rate: {}, retry: {}, ...extra }));
    await assert.rejects(new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid } as any).tick(), /updater_alert_state_refused/);
  }
});

// ---------------------------------------------------------------------------
// U09: recorded, not fixed. The default composition supplies NO health facts.
// ---------------------------------------------------------------------------
// The review listed U09 as a source-trace suspicion and was careful to say it was
// not a reproduced failure: "default alertFacts is an empty object; default
// disk-reserve callback does nothing; refusal aggregation is composed only when
// extra journal/push collaborators are supplied."
//
// This asserts the FIRST of those against the real default construction, so the
// gap is a measured fact in the suite rather than a comment. It is deliberately
// a record and not a fix: binding a real backup collector means reaching into
// the backup service for a fact whose shape this stream has no authority to
// decide, and a guessed fact would satisfy this assertion while warning the
// owner about nothing -- which is the failure mode the review named.
//
// The assertion is inverted on purpose. When a real collector IS bound, this
// test fails and the lead is told to replace it with one that asserts the
// collector is wired, so the gap cannot be closed by accident or forgotten.
test("U09: the default composition reports no health facts, so no condition can be escalated", async t => {
  const root = await scratch(t);
  const loop = new UpdaterMainLoopV1({ runner: { async runOnce() { return { status: "idle" }; } },
    store: { async unhandledOwnerRequests() { return []; } },
    stateFiles: { async readSelfUpdate() { return "Off"; }, async hasRescueMarker() { return false; },
      async writeStatus() {} },
    mode: { async read() { return "stopped"; } }, ownerActions: {} } as any);
  const facts = await (loop as any).alertFacts();
  assert.deepEqual(facts, {},
    "U09 RECORDED: the default alertFacts callback is empty, so backupFailed, backupMissing, "
    + "diskReserveUsed and subscriptionsZero can never fire on the default path. If this now fails, "
    + "a real collector has been bound and this test should be replaced with one that asserts it is wired.");
  // The sender is present and working -- which is what makes the gap a
  // composition problem rather than a missing feature. A condition edge cannot
  // be raised because no condition is ever reported, not because the alerting
  // path is absent.
  const store = new AlertStore([]);
  const sender = new UpdaterAlertSenderV1({ root, store, loadVapid: async () => vapid, now: () => now,
    send: async () => {} } as any);
  await sender.reconcile(facts as never);
  assert.deepEqual(store.queued, [],
    "and so nothing is queued: the sender is composed, wired and idle");
});
