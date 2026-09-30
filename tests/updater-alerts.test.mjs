import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UPDATER_PUSH_RETRY_MS_V1, UpdaterAlertSenderV1, loadUpdaterVapidV1 } from "../src/updater/v1/alerts.mjs";
import { ownerPushEndpointAllowedV1 } from "../src/updater/v1/push-policy.mjs";

const vapid = Object.freeze({ schema: "control-room.updater-vapid/v1", subject: "mailto:owner@example.invalid",
  publicKey: "A".repeat(88), privateKey: "b".repeat(48) });
const id = n => `push:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "updater-alerts-"));
  t.after(async () => { await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })); });
  await mkdir(join(root, "updater-state"));
  await writeFile(join(root, "updater-state/vapid.json"), `${JSON.stringify(vapid)}\n`, { mode: 0o600 });
  await chmod(join(root, "updater-state/vapid.json"), 0o600);
  return root;
}

class MemoryStore {
  constructor(rows = []) {
    this.rows = rows; this.queued = []; this.subscriptionReads = 0;
    this.subscriptionsValue = [Object.freeze({ id: "phone:one", endpoint: "https://fcm.googleapis.com/fcm/send/one",
      p256dh: "A", auth: "B", expires_at: null }), Object.freeze({ id: "hostile", endpoint: "https://127.0.0.1/secret",
      p256dh: "A", auth: "B", expires_at: null })];
  }
  async subscriptions() { this.subscriptionReads += 1; return this.subscriptionsValue; }
  async pending() { return this.rows.filter(row => !row.sent && !row.reserved && row.attempts < 10); }
  async begin(value) { const row = this.rows.find(item => item.id === value); if (!row || row.sent || row.reserved) return false;
    row.reserved = true; row.attempts += 1; return true; }
  async finish(value, { sent, errorCode = null }) { const row = this.rows.find(item => item.id === value); row.reserved = false;
    row.sent = sent; row.errorCode = errorCode; }
  async queue(template) { this.queued.push(template); }
}

test("the shared endpoint policy admits only known HTTPS push hosts", () => {
  for (const endpoint of ["https://fcm.googleapis.com/fcm/send/a", "https://web.push.apple.com/3/device/a",
    "https://updates.push.services.mozilla.com/wpush/v2/a", "https://x.notify.windows.com/?token=a"])
    assert.equal(ownerPushEndpointAllowedV1(endpoint), true, endpoint);
  for (const endpoint of ["http://fcm.googleapis.com/a", "https://localhost/a", "https://127.0.0.1/a",
    "https://[::1]/a", "https://fcm.googleapis.com.evil.invalid/a", "https://evil.invalid/?next=fcm.googleapis.com",
    "https://user@fcm.googleapis.com/a", "https://fcm.googleapis.com:444/a"])
    assert.equal(ownerPushEndpointAllowedV1(endpoint), false, endpoint);
});

test("root-only VAPID refuses non-root and permissive key modes before any send", async t => {
  const root = await fixture(t), key = join(root, "updater-state/vapid.json");
  await assert.rejects(loadUpdaterVapidV1(root, { getuid: () => 501 }), /updater_vapid_not_root/u);
  await chmod(key, 0o644);
  await assert.rejects(loadUpdaterVapidV1(root, { getuid: () => 0, lstat: async path => Object.assign(await lstat(path), { uid: 0 }) }),
    /updater_vapid_permissions_refused/u);
  await chmod(key, 0o600);
  const loaded = await loadUpdaterVapidV1(root, { getuid: () => 0, lstat: async path => Object.assign(await lstat(path), { uid: 0 }) });
  assert.equal(loaded.privateKey, vapid.privateKey);
});

test("a hostile queue row and hostile endpoint are never contacted; 50 alerts are rate-limited with one summary", async t => {
  const root = await fixture(t), rows = [{ id: id(1), template: "task.done", attempts: 0 }];
  for (let n = 2; n <= 51; n++) rows.push({ id: id(n), template: "control-room-updater.web-down", attempts: 0 });
  const store = new MemoryStore(rows), calls = [];
  let now = 10_000;
  const sender = new UpdaterAlertSenderV1({ root, store, now: () => now, timeoutMs: 100,
    loadVapid: async () => vapid, send: async (_key, subscription, payload) => calls.push({ endpoint: subscription.endpoint, payload }) });
  const result = await sender.tick();
  assert.equal(result.sent, 2, "one condition alert plus the one flood summary");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.endpoint === "https://fcm.googleapis.com/fcm/send/one"));
  assert.deepEqual(calls.map(call => call.payload.tag).sort(), ["control-room-updater.flood", "control-room-updater.web-down"]);
  assert.ok(rows.every(row => row.sent), "a burst is settled rather than retried forever");
  assert.ok(rows.every(row => row.attempts === 1), "each queue row consumed one bounded attempt");
  assert.equal(rows[0].errorCode, "updater_push_template_refused", "the bot cannot use a web template to make a phone call");
  rows.push({ id: id(52), template: "control-room-updater.web-down", attempts: 0 }); now += 60_000;
  await sender.tick();
  assert.equal(calls.length, 2, "the same condition is limited to once per hour");
  for (const condition of ["needs-owner", "uncertain", "rescue", "backup-failed", "backup-missing", "web-down", "disk-reserve-used", "subscriptions-zero"])
    await sender.observe(condition);
  assert.equal(store.queued.length, 8);
  await sender.reconcile({ needsOwner: true, uncertain: true, rescue: true, backupFailed: true, backupMissing: true,
    webDown: true, diskReserveUsed: true, subscriptionsZero: true });
  assert.equal(store.queued.length, 16, "all specified alert sources have fixed updater templates");
  await sender.reconcile({});
  assert.equal(store.queued.filter(template => template === "control-room-updater.recovered").length, 8,
    "each cleared condition queues the calm back-to-normal template once");
  await assert.rejects(sender.observe("untrusted"), /updater_push_condition_refused/u);
});

test("a slow push is timed out, retried on a bounded schedule, and never piles up", async t => {
  const root = await fixture(t), rows = [{ id: id(99), template: "control-room-updater.uncertain", attempts: 0 }];
  const store = new MemoryStore(rows); let now = 100, calls = 0;
  const sender = new UpdaterAlertSenderV1({ root, store, now: () => now, timeoutMs: 5,
    loadVapid: async () => vapid, send: async () => { calls += 1; await new Promise(() => {}); } });
  await sender.tick();
  assert.equal(calls, 1); assert.equal(rows[0].attempts, 1); assert.equal(rows[0].sent, false);
  now += UPDATER_PUSH_RETRY_MS_V1[0] + 1;
  await sender.tick();
  assert.equal(calls, 1, "the abandoned slow call remains the one in flight; no second socket is opened");
  assert.equal(rows[0].attempts, 1, "a slow service cannot burn through the retry budget in a loop");
  assert.ok(store.subscriptionReads >= 1, "subscriptions were cached from the database before the outage");
  assert.ok((await readFile(join(root, "updater-state/push-subscriptions.json"), "utf8")).includes("fcm.googleapis.com"));
});
