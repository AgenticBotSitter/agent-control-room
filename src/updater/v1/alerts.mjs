import { lstat, readFile } from "node:fs/promises";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { updaterRefuseV1 } from "./contracts.mjs";
import { ownerPushEndpointAllowedV1 } from "./push-policy.mjs";

export const UPDATER_PUSH_CACHE_MS_V1 = 10 * 60_000;
export const UPDATER_PUSH_RATE_MS_V1 = 60 * 60_000;
export const UPDATER_PUSH_TIMEOUT_MS_V1 = 5_000;
export const UPDATER_PUSH_RETRY_MS_V1 = Object.freeze([30_000, 120_000, 600_000, 3_600_000]);

const TEMPLATES = Object.freeze({
  "control-room-updater.needs-owner": "Control Room needs you",
  "control-room-updater.uncertain": "Control Room needs a check before continuing",
  "control-room-updater.rescue": "Control Room recovered safely and needs a review",
  "control-room-updater.backup-failed": "Control Room backup needs attention",
  "control-room-updater.backup-missing": "Control Room backup is missing or too old",
  "control-room-updater.web-down": "Control Room is not responding",
  "control-room-updater.disk-reserve-used": "Control Room used its disk reserve",
  "control-room-updater.subscriptions-zero": "Phone notifications are not set up",
  "control-room-updater.recovered": "Control Room is back to normal",
});

function safeErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "updater_push_send_failed";
  return /^[a-z][a-z0-9_]{1,63}$/u.test(code) ? code : "updater_push_send_failed";
}

function validVapid(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "privateKey,publicKey,schema,subject"
    && value.schema === "control-room.updater-vapid/v1"
    && typeof value.subject === "string" && /^mailto:[^\s@]+@[^\s@]+$/u.test(value.subject)
    && typeof value.publicKey === "string" && /^[A-Za-z0-9_-]{80,100}$/u.test(value.publicKey)
    && typeof value.privateKey === "string" && /^[A-Za-z0-9_-]{40,100}$/u.test(value.privateKey);
}

/** Read the root-held VAPID key. A non-root process must fail before it opens it. */
export async function loadUpdaterVapidV1(root, runtime = {}) {
  const getuid = runtime.getuid ?? process.getuid, stat = runtime.lstat ?? lstat, read = runtime.readFile ?? readFile;
  if (typeof getuid !== "function" || getuid() !== 0) throw updaterRefuseV1("updater_vapid_not_root");
  const path = `${root}/updater-state/vapid.json`;
  let entry;
  try { entry = await stat(path); } catch { throw updaterRefuseV1("updater_vapid_unavailable"); }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== 0 || (entry.mode & 0o077) !== 0 || entry.size > 4096)
    throw updaterRefuseV1("updater_vapid_permissions_refused");
  let value;
  try { value = JSON.parse(await read(path, "utf8")); } catch { throw updaterRefuseV1("updater_vapid_invalid"); }
  if (!validVapid(value)) throw updaterRefuseV1("updater_vapid_invalid");
  return Object.freeze({ subject: value.subject, publicKey: value.publicKey, privateKey: value.privateKey });
}

async function defaultSend(vapid, subscription, payload, signal) {
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  // The library does not currently accept an AbortSignal. The caller still
  // aborts its own timer and never starts another send for this row until this
  // promise settles, so an uncooperative provider cannot create a pile-up.
  void signal;
  await webpush.sendNotification({ endpoint: subscription.endpoint, expirationTime: subscription.expiresAt,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload),
  { TTL: 3600, urgency: "normal", topic: payload.tag });
}

export class UpdaterAlertSenderV1 {
  #running = false; #inflight = new Set(); #retry = new Map(); #rate = {}; #active = new Set();
  constructor({ root, store, send = defaultSend, now = () => Date.now(), timeoutMs = UPDATER_PUSH_TIMEOUT_MS_V1,
    getuid, lstat: stat, readFile: read, loadVapid = loadUpdaterVapidV1 }) {
    if (typeof root !== "string" || !store || typeof store.pending !== "function" || typeof store.begin !== "function"
      || typeof store.finish !== "function" || typeof store.subscriptions !== "function" || typeof send !== "function")
      throw updaterRefuseV1("updater_alert_sender_input_refused");
    this.root = root; this.store = store; this.send = send; this.now = now; this.timeoutMs = timeoutMs;
    this.vapidRuntime = { getuid, lstat: stat, readFile: read }; this.loadVapid = loadVapid;
  }
  async #readState() {
    try {
      const value = JSON.parse(await readFileNoFollowV1(this.root, "updater-state/push-alert-state.json", { maxBytes: 16_384 }));
      if (!value || value.schema !== "control-room.updater-alert-state/v1" || typeof value.rate !== "object" || Array.isArray(value.rate)
        || typeof value.retry !== "object" || Array.isArray(value.retry)) throw new Error();
      this.#rate = value.rate;
      for (const [id, at] of Object.entries(value.retry)) if (/^push:[0-9a-f-]{36}$/u.test(id) && Number.isSafeInteger(at)) this.#retry.set(id, at);
    } catch (error) { if (error?.code !== "ENOENT") throw updaterRefuseV1("updater_alert_state_refused"); }
  }
  async #writeState() {
    const retry = Object.fromEntries([...this.#retry].filter(([, at]) => at > this.now() - UPDATER_PUSH_RETRY_MS_V1.at(-1)));
    await atomicWriteNoFollowV1(this.root, "updater-state/push-alert-state.json", `${JSON.stringify({
      schema: "control-room.updater-alert-state/v1", rate: this.#rate, retry,
    })}\n`);
  }
  async #subscriptions() {
    const cachePath = "updater-state/push-subscriptions.json", now = this.now();
    const readCache = async () => {
      const value = JSON.parse(await readFileNoFollowV1(this.root, cachePath, { maxBytes: 65_536 }));
      if (!value || value.schema !== "control-room.updater-push-subscriptions/v1" || !Number.isSafeInteger(value.at)
        || !Array.isArray(value.subscriptions) || value.subscriptions.length > 100) throw new Error();
      const subscriptions = value.subscriptions.filter(item => item && typeof item.id === "string"
        && ownerPushEndpointAllowedV1(item.endpoint) && typeof item.p256dh === "string" && typeof item.auth === "string");
      if (subscriptions.length !== value.subscriptions.length) throw new Error();
      return { at: value.at, subscriptions };
    };
    try {
      const cached = await readCache(); if (now - cached.at <= UPDATER_PUSH_CACHE_MS_V1) return cached.subscriptions;
    } catch (error) { if (error?.code !== "ENOENT") throw updaterRefuseV1("updater_push_cache_refused"); }
    try {
      const rows = await this.store.subscriptions();
      const subscriptions = rows.filter(row => ownerPushEndpointAllowedV1(row.endpoint)).map(row => Object.freeze({ id: row.id,
        endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, expiresAt: row.expires_at ? Date.parse(row.expires_at) : null }));
      await atomicWriteNoFollowV1(this.root, cachePath, `${JSON.stringify({
        schema: "control-room.updater-push-subscriptions/v1", at: now, subscriptions,
      })}\n`);
      return subscriptions;
    } catch (error) {
      try { return (await readCache()).subscriptions; } catch { throw updaterRefuseV1("updater_push_subscriptions_unavailable"); }
    }
  }
  async observe(condition) {
    const template = `control-room-updater.${condition}`;
    if (!(template in TEMPLATES)) throw updaterRefuseV1("updater_push_condition_refused");
    await this.store.queue(template);
  }
  /** Queue only condition edges. A health loop can call this every 30 seconds
   * without turning one outage into an unbounded database flood. */
  async reconcile(facts = {}) {
    const known = Object.freeze({ needsOwner: "needs-owner", uncertain: "uncertain", rescue: "rescue",
      backupFailed: "backup-failed", backupMissing: "backup-missing", webDown: "web-down",
      diskReserveUsed: "disk-reserve-used", subscriptionsZero: "subscriptions-zero" });
    if (!facts || typeof facts !== "object" || Array.isArray(facts) || Object.keys(facts).some(key => !(key in known)
      || typeof facts[key] !== "boolean")) throw updaterRefuseV1("updater_push_facts_refused");
    for (const [key, condition] of Object.entries(known)) {
      const active = facts[key] === true, wasActive = this.#active.has(condition);
      if (active && !wasActive) { await this.observe(condition); this.#active.add(condition); }
      if (!active && wasActive) { await this.observe("recovered"); this.#active.delete(condition); }
    }
  }
  async preflight() { await this.loadVapid(this.root, this.vapidRuntime); }
  async #send(vapid, subscriptions, payload, row) {
    const controller = new AbortController(), work = Promise.all(subscriptions.map(subscription => this.send(vapid, subscription, payload, controller.signal)));
    this.#inflight.add(row.id);
    let timer;
    try {
      await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(updaterRefuseV1("updater_push_timeout"));
      }, this.timeoutMs); })]);
    } finally { clearTimeout(timer); work.finally(() => this.#inflight.delete(row.id)).catch(() => {}); }
  }
  async tick() {
    if (this.#running) return { status: "busy", sent: 0 };
    this.#running = true;
    try {
      await this.#readState(); const vapid = await this.loadVapid(this.root, this.vapidRuntime);
      const subscriptions = await this.#subscriptions(), rows = await this.store.pending(50), now = this.now();
      const grouped = new Map();
      for (const row of rows) {
        if (!(row.template in TEMPLATES)) { if (await this.store.begin(row.id)) await this.store.finish(row.id, { sent: true, errorCode: "updater_push_template_refused" }); continue; }
        if (this.#inflight.has(row.id) || (this.#retry.get(row.id) ?? 0) > now) continue;
        (grouped.get(row.template) ?? grouped.set(row.template, []).get(row.template)).push(row);
      }
      let sent = 0, suppressed = 0;
      for (const [template, batch] of grouped) {
        const rate = this.#rate[template] ?? {}, allowed = !Number.isSafeInteger(rate.sentAt) || now - rate.sentAt >= UPDATER_PUSH_RATE_MS_V1;
        const primary = batch[0];
        if (!allowed) { for (const row of batch) if (await this.store.begin(row.id)) await this.store.finish(row.id, { sent: true, errorCode: "updater_push_rate_limited" }); suppressed += batch.length; continue; }
        if (!subscriptions.length) { for (const row of batch) if (await this.store.begin(row.id)) await this.store.finish(row.id, { sent: true, errorCode: "updater_push_no_subscription" }); continue; }
        if (!await this.store.begin(primary.id)) continue;
        try {
          await this.#send(vapid, subscriptions, { title: "Control Room updater", body: TEMPLATES[template], link: "/needs-me", tag: template }, primary);
          await this.store.finish(primary.id, { sent: true }); this.#rate[template] = { sentAt: now }; sent += 1;
          for (const row of batch.slice(1)) if (await this.store.begin(row.id)) await this.store.finish(row.id, { sent: true, errorCode: "updater_push_rate_limited" });
          suppressed += batch.length - 1;
        } catch (error) {
          const attempt = Number(primary.attempts) + 1, delay = UPDATER_PUSH_RETRY_MS_V1[Math.min(attempt - 1, UPDATER_PUSH_RETRY_MS_V1.length - 1)];
          this.#retry.set(primary.id, now + delay); await this.store.finish(primary.id, { sent: false, errorCode: safeErrorCode(error) });
        }
      }
      // One calm summary for a burst, itself no more than hourly. It is a
      // separate flood condition, not a way to bypass a condition's limit.
      if (suppressed > 0 && (!Number.isSafeInteger(this.#rate.flood?.sentAt) || now - this.#rate.flood.sentAt >= UPDATER_PUSH_RATE_MS_V1) && subscriptions.length) {
        try { await this.#send(vapid, subscriptions, { title: "Control Room updater", body: "Several alerts were grouped. Please review Control Room.", link: "/needs-me", tag: "control-room-updater.flood" }, { id: "summary" }); this.#rate.flood = { sentAt: now }; sent += 1; } catch { /* the queued condition retries independently */ }
      }
      await this.#writeState(); return { status: "ok", sent, subscriptions: subscriptions.length };
    } finally { this.#running = false; }
  }
}
