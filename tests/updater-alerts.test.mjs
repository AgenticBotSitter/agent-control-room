import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import https from "node:https";
import { createECDH, randomBytes } from "node:crypto";
import { UPDATER_PUSH_RETRY_MS_V1, UpdaterAlertSenderV1, loadUpdaterVapidV1 } from "../src/updater/v1/alerts.mjs";
import { ownerPushEndpointAllowedV1 } from "../src/updater/v1/push-policy.mjs";

const vapid = Object.freeze({ schema: "control-room.updater-vapid/v1", subject: "https://fixture.ts.net",
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

test("50 concurrent ticks, a burst at the limit, and a hostile template settle the queue exactly once", async t => {
  // The stress cases. A health loop and an owner action can both reach `tick()`
  // at once, and a 30s loop over a flapping condition can produce a burst well
  // past the 50-row drain limit. Nothing here may double-send, lose a row, or
  // leave an attempt unrecorded.
  const root = await fixture(t), rows = [];
  for (let n = 1; n <= 120; n++) rows.push({ id: id(200 + n), template: "control-room-updater.web-down", attempts: 0 });
  // A row whose template is a PROTOTYPE key. `in` on a normal object would say
  // true for "constructor", and the sender would then render
  // `Object.prototype.constructor` as the push body.
  rows.push({ id: id(400), template: "constructor", attempts: 0 });
  rows.push({ id: id(401), template: "__proto__", attempts: 0 });
  const store = new MemoryStore(rows), calls = [];
  let now = 500_000;
  const sender = new UpdaterAlertSenderV1({ root, store, now: () => now, timeoutMs: 2_000,
    loadVapid: async () => vapid, send: async (_key, subscription, payload) => {
      calls.push(payload.tag); await new Promise(resolve => setImmediate(resolve));
    } });
  // 50 callers at once, on ONE sender: `#running` must admit exactly one.
  const results = await Promise.all(Array.from({ length: 50 }, () => sender.tick()));
  assert.equal(results.filter(result => result.status === "busy").length, 49,
    "one tick runs and the other 49 are told the loop is busy, not left to double-send");
  const sentTags = calls.filter(tag => tag === "control-room-updater.web-down");
  assert.equal(sentTags.length, 1, "a 120-row burst of one condition is ONE push, not 120");
  assert.ok(calls.every(tag => typeof tag === "string" && tag.startsWith("control-room-updater.")),
    `no send carried a prototype key: ${JSON.stringify(calls.filter(tag => !tag.startsWith("control-room-updater.")))}`);
  for (const row of rows) {
    assert.equal(row.attempts, 1, `row ${row.id} consumed exactly one bounded attempt`);
    assert.equal(row.sent, true, `row ${row.id} is settled rather than retried forever`);
  }
  assert.deepEqual(rows.filter(row => row.template === "constructor" || row.template === "__proto__")
    .map(row => row.errorCode), ["updater_push_template_refused", "updater_push_template_refused"],
  "a prototype key in the queue is refused, not rendered");

  // A second burst inside the hour adds no push and no new attempt, and a
  // dropped connection mid-send leaves exactly one retry, not fifty.
  now += 1_000;
  await sender.reconcile({ webDown: true });
  assert.equal((await sender.tick()).sent, 0, "the hourly rate limit holds across processes of time");
  assert.ok(rows.every(row => row.attempts === 1), "a rate-limited burst consumes no attempt at all");
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

test("updater VAPID accepts installation HTTPS origin and fails closed on missing and reserved contacts", async t => {
  const root = await fixture(t), path = join(root, "updater-state/vapid.json");
  const runtime = { getuid: () => 0, lstat: async name => Object.assign(await lstat(name), { uid: 0 }) };
  await writeFile(path, JSON.stringify({ ...vapid, subject: "https://fixture.ts.net" }), { mode: 0o600 });
  assert.equal((await loadUpdaterVapidV1(root, runtime)).subject, "https://fixture.ts.net");
  for (const subject of [undefined, "", "mailto:owner@example.invalid", "mailto:owner@localhost", "https://example.org",
    "https://fixture.ts.net/", "https://fixture.ts.net:443", "https://fixture.ts.net?x", "https://fixture.invalid"]) {
    await writeFile(path, JSON.stringify({ ...vapid, subject }), { mode: 0o600 });
    await assert.rejects(loadUpdaterVapidV1(root, runtime), /updater_vapid_invalid/u, String(subject));
  }
});

test("updater send results retain the bounded push service rejection body", async t => {
  const root = await fixture(t), row = { id: id(1), template: "control-room-updater.web-down", attempts: 0 };
  const store = new MemoryStore([row]);
  const sender = new UpdaterAlertSenderV1({ root, store, loadVapid: async () => ({ ...vapid, subject: "https://fixture.ts.net" }),
    send: async () => { throw { statusCode: 403, body: "VapidPkHashMismatch" + "x".repeat(2048) }; } });
  const result = await sender.tick();
  assert.equal(result.sent, 0);
  assert.deepEqual(result.failures, [{ subscriptionId: "phone:one", statusCode: 403,
    rejectionReason: "VapidPkHashMismatch" + "x".repeat(1005) }]);
  assert.equal(row.sent, false);
  const burstRoot = await fixture(t), burstStore = new MemoryStore([
    { id: id(1), template: "control-room-updater.web-down", attempts: 0 },
    { id: id(2), template: "control-room-updater.backup-failed", attempts: 0 },
  ]);
  // The production query returns at most 100 subscriptions. Two templates exercise 200 rejections.
  burstStore.subscriptionsValue = Array.from({ length: 100 }, (_, n) => ({ id: `phone:${n}`,
    endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, p256dh: "A", auth: "B", expires_at: null }));
  const burst = new UpdaterAlertSenderV1({ root: burstRoot, store: burstStore, loadVapid: async () => vapid,
    send: async () => { throw { statusCode: 403, body: "BadJwtToken" }; } });
  assert.equal((await burst.tick()).failures.length, 100, "the send result retains at most 100 diagnostic records");
});

test("production defaultSend Authorization signs the installation origin", async t => {
  const { default: webpush } = await import("web-push");
  const root = await fixture(t), keys = webpush.generateVAPIDKeys();
  await writeFile(join(root, "updater-state/vapid.json"), JSON.stringify({ ...vapid, ...keys }), { mode: 0o600 });
  const phone = createECDH("prime256v1"); phone.generateKeys();
  const store = new MemoryStore([{ id: id(701), template: "control-room-updater.web-down", attempts: 0 }]);
  store.subscriptionsValue = [{ id: "phone:production", endpoint: "https://web.push.apple.com/3/device/fixture",
    p256dh: phone.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"), expires_at: null }];
  const requests = [];
  // Intercept only the network boundary, AFTER the real library encrypted and signed.
  // No provider answer is fabricated: the transport is deliberately unavailable offline.
  t.mock.method(https, "request", options => { requests.push(options); throw new Error("offline_transport_stop"); });
  const sender = new UpdaterAlertSenderV1({ root, store, getuid: () => 0,
    lstat: async path => Object.assign(await lstat(path), { uid: 0 }) });
  await sender.tick();
  assert.equal(requests.length, 1, "defaultSend reached the real HTTPS transport exactly once");
  const token = /^vapid t=([^,]+), k=(.+)$/u.exec(requests[0].headers.Authorization);
  assert.ok(token, "production defaultSend supplies a VAPID Authorization header");
  const jwt = JSON.parse(Buffer.from(token[1].split(".")[1], "base64url").toString("utf8"));
  assert.equal(jwt.sub, "https://fixture.ts.net", "production defaultSend JWT sub is the installation origin");
  assert.equal(jwt.aud, "https://web.push.apple.com");
  assert.equal(token[2], keys.publicKey);
});


test("legacy invalid VAPID keeps the production updater running with a status-card warning and no sends", async t => {
  const startup = await import("../src/updater/v1/updater.mjs");
  // Full native lock composition runs on Mac; Linux exercises the same startup
  // body. This test makes no Linux local-lock or cross-process guarantee.
  const startUpdaterV1 = process.platform === "darwin" ? startup.startUpdaterV1 : startup.startLockedUpdaterV1;
  const { createUpdaterHomeStatusReaderV1 } = await import("../src/web/v1/updater-home-status.ts");
  const { readUpdaterHomeStatusV1 } = await import("../src/web/v1/updater-home-status-browser.ts");
  // Use a short job-local root: Darwin's UNIX socket path has a 103-byte limit.
  const root = await mkdtemp(join(process.cwd(), ".test-tmp/p-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "updater-state")); await mkdir(join(root, "status"));
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  const warnings = [], store = new MemoryStore([{ id: id(702), template: "control-room-updater.web-down", attempts: 0 }]);
  let beats = 0, acquisitions = 0;
  Object.assign(store, { liveRun: async () => null,
    acquire: async token => { acquisitions++; return { status: "acquired", run: null, leaseToken: token }; }, heartbeat: async () => { beats++; },
    unhandledOwnerRequests: async () => [] });
  const runtime = { getuid: () => 0, lstat: async path => Object.assign(await lstat(path), { uid: 0 }) };
  for (const subject of ["mailto:owner@control-room.invalid", "", undefined, "https://fixture.invalid"]) {
    await writeFile(join(root, "updater-state/vapid.json"), JSON.stringify({ ...vapid, subject }), { mode: 0o600 });
    let updater;
    await assert.doesNotReject(async () => {
      updater = await startUpdaterV1({ root, store, alertRuntime: runtime,
        identity: { bootId: "boot-legacy", leaseToken: "lease-legacy" }, onTimerError: error => warnings.push(error.code) });
    }, "a legacy invalid contact must not stop production startup");
    try {
      assert.equal(updater.alerts, null, "invalid contacts disable only sending");
      assert.ok(beats > 0, "the production updater heartbeats after startup");
      await Promise.all(Array.from({ length: 50 }, () => updater.loop.tick()));
      const card = await createUpdaterHomeStatusReaderV1({ root }).read();
      const browserCard = await readUpdaterHomeStatusV1(async () => Response.json(card));
      assert.equal(browserCard.reason, "Phone notifications are off because their contact is invalid. Rerun the installer to repair them; updates continue.",
        "the browser accepts the warning captured from the real status reader");
      assert.equal(card.reason, "Phone notifications are off because their contact is invalid. Rerun the installer to repair them; updates continue.",
        "the real status-card reader retains the owner-readable warning");
      assert.equal(store.subscriptionReads, 0, "no send path is entered");
      assert.equal(store.rows[0].attempts, 0, "the queued alert is untouched");
      await writeFile(join(root, "updater-state/self-update"), "Off\n");
      await updater.loop.tick();
      assert.equal((await createUpdaterHomeStatusReaderV1({ root }).read()).reason,
        "Phone notifications are off because their contact is invalid. Rerun the installer to repair them; updates continue.",
        "turning self-update Off does not hide the notification warning");
      await writeFile(join(root, "updater-state/self-update"), "On\n");
      const updateReason = "An update could not finish cleanly. Control Room needs you.";
      await updater.loop.stateFiles.writeStatus({ state: "needs_attention", selfUpdate: "On", reason: updateReason });
      assert.equal((await createUpdaterHomeStatusReaderV1({ root }).read()).reason, updateReason,
        "an outstanding update reason is not hidden by the notification warning");
    } finally { await updater.stop(); }
  }
  assert.deepEqual(warnings, Array(4).fill("updater_vapid_invalid"));
  for (const content of ["{", null]) {
    const key = join(root, "updater-state/vapid.json");
    if (content === null) await rm(key); else await writeFile(key, content);
    let updater;
    await assert.doesNotReject(async () => { updater = await startUpdaterV1({ root, store, alertRuntime: runtime,
      onTimerError: error => warnings.push(error.code) }); }, "missing or unreadable contact data leaves updates running");
    try {
      assert.equal(updater.alerts, null);
      const expected = content === null
        ? "Phone notifications are off because their key is missing. Rerun the installer to repair them; updates continue."
        : "Phone notifications are off because their contact is invalid. Rerun the installer to repair them; updates continue.";
      assert.equal((await createUpdaterHomeStatusReaderV1({ root }).read()).reason, expected);
      assert.equal(store.subscriptionReads, 0);
    } finally { await updater.stop(); }
  }
  assert.deepEqual(warnings, [...Array(5).fill("updater_vapid_invalid"), "updater_vapid_unavailable"]);
  // Repair and retry uses the same default sender, and stopping retires all timers/socket.
  await writeFile(join(root, "updater-state/vapid.json"), JSON.stringify(vapid), { mode: 0o600 });
  store.rows = [];
  const repaired = await startUpdaterV1({ root, store, alertRuntime: runtime,
    identity: { bootId: "boot-repaired", leaseToken: "lease-repaired" } });
  try { assert.ok(repaired.alerts); } finally { await repaired.stop(); }
  await assert.rejects(lstat(join(root, "updater-state/control.sock")), { code: "ENOENT" });
  const unexpected = [];
  t.after(async () => { for (const updater of unexpected) await updater.stop(); });
  const start = async alertRuntime => {
    const updater = await startUpdaterV1({ root, store, alertRuntime });
    unexpected.push(updater); return updater;
  };
  const before = acquisitions;
  await chmod(join(root, "updater-state/vapid.json"), 0o644);
  await assert.rejects(start(runtime), /updater_vapid_permissions_refused/u,
    "custody failures still stop startup before the lease");
  await chmod(join(root, "updater-state/vapid.json"), 0o600);
  await assert.rejects(start({ getuid: () => 501 }), /updater_vapid_not_root/u,
    "wrong authority still stops startup before the lease");
  assert.equal(acquisitions, before, "custody refusals never acquire a lease");
});
