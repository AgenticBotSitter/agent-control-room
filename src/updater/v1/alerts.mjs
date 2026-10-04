import { lstat, readFile } from "node:fs/promises";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { updaterRefuseV1 } from "./contracts.mjs";
import { ownerPushEndpointAllowedV1 } from "./push-policy.mjs";

export const UPDATER_PUSH_CACHE_MS_V1 = 10 * 60_000;
export const UPDATER_PUSH_RATE_MS_V1 = 60 * 60_000;
export const UPDATER_PUSH_TIMEOUT_MS_V1 = 5_000;
export const UPDATER_PUSH_RETRY_MS_V1 = Object.freeze([30_000, 120_000, 600_000, 3_600_000]);

/** The fixed R12 alert texts. Exported so the QUEUE and the SENDER cannot
 * disagree about what a condition says: `store.queue()` writes this text into
 * `push_queue.body` (which the schema CHECKs to 1..400 characters), and
 * `tick()` builds the payload from the same table. One source, two readers. */
export const UPDATER_PUSH_TEMPLATES_V1 = Object.freeze(Object.assign(Object.create(null), {
  "control-room-updater.needs-owner": "Control Room needs you",
  "control-room-updater.uncertain": "Control Room needs a check before continuing",
  "control-room-updater.rescue": "Control Room recovered safely and needs a review",
  "control-room-updater.backup-failed": "Control Room backup needs attention",
  "control-room-updater.backup-missing": "Control Room backup is missing or too old",
  "control-room-updater.web-down": "Control Room is not responding",
  "control-room-updater.disk-reserve-used": "Control Room used its disk reserve",
  "control-room-updater.subscriptions-zero": "Phone notifications are not set up",
  "control-room-updater.recovered": "Control Room is back to normal",
  // N05: the passkey cooling-off notice, which `enqueue_cooling_off_notices`
  // (0003_guards.sql) has always queued under this id with the passkey number
  // substituted into its own body. The sender had no entry for it, so the row
  // was settled `sent: true, updater_push_template_refused` with NO send: a
  // security notice the design requires within 24 hours of the key being added
  // was discarded, and the row then said it had been delivered.
  //
  // WHY THE TITLE-LEVEL TEXT AND NOT THE FULL NOTICE. The authorized body is
  // per-passkey and names the ledger position to revoke
  // (`sudo .../control-room passkey revoke <n>`). That text is the ROW's own
  // `push_queue.body`, written by the database function, and it is what
  // `tick()` sends — `TEMPLATES[template]` is only the FALLBACK for a row whose
  // body is empty, and this template is never queued through `queue()`. So the
  // entry here is the shape of the notice, and the number always comes from the
  // row. It is deliberately generic: a phone must not be told to revoke a passkey
  // number this process cannot see.
  "control-room-updater.passkey_cooling_off": "A new passkey was added to this Mac. If this wasn't you, revoke it in Control Room.",
}));

const TEMPLATES = UPDATER_PUSH_TEMPLATES_V1;

/** The fixed text for one updater template id, or a refusal: the queue path
 * must not be able to write a body the sender would then refuse to send. */
export function updaterPushBodyV1(template) {
  if (typeof template !== "string" || !(template in TEMPLATES))
    throw updaterRefuseV1("updater_push_condition_refused");
  return TEMPLATES[template];
}

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
  { TTL: 86400, urgency: "normal", timeout: UPDATER_PUSH_TIMEOUT_MS_V1 });
}

export class UpdaterAlertSenderV1 {
  #running = false; #inflight = new Set(); #retry = new Map(); #rate = {}; #active = new Set(); #deliveries = {}; #dead = new Set(); #writes = Promise.resolve(); #loaded = false;
  /** THIS process's claim identity (U02/U03/U07).
   *
   * One token per sender instance, minted in the constructor, and every claim
   * this sender takes carries it. That is what makes a reservation
   * attributable: a row reserved by a process that then died is recoverable,
   * a row reserved by a process that is still sending is not, and the
   * distinction is the token plus its deadline rather than an age guess.
   *
   * It is per INSTANCE and not per row, deliberately: a fresh process after a
   * restart must not be able to present the dead process's token, and the
   * cheapest way to guarantee that is for a token to never outlive its process.
   * Per-row tokens would also be correct, but they would make the per-phone
   * receipt file the authority for liveness, which is a second ledger for one
   * fact. */
  #claimToken = `claim:${globalThis.crypto.randomUUID()}`;
  /** How long one whole attempt's claim is held, in seconds.
   *
   * Deliberately much larger than `UPDATER_PUSH_TIMEOUT_MS_V1` (5 s): the
   * deadline covers the whole fan-out, not one send. With up to 100
   * subscriptions at a 5 s timeout each, a deadline at the send timeout would
   * expire under a live dispatcher and a recovery would take the row from it —
   * which is the U02 duplicate-send defect this whole mechanism exists to
   * remove. Two minutes is above the bounded worst case of the fan-out and far
   * below the time an operator would wait for a crash to be noticed, so a dead
   * row is invisible for minutes rather than hours. */
  #claimHoldSeconds = 120;
  constructor({ root, store, send = defaultSend, now = () => Date.now(), timeoutMs = UPDATER_PUSH_TIMEOUT_MS_V1,
    getuid, lstat: stat, readFile: read, loadVapid = loadUpdaterVapidV1, claimHoldSeconds = null }) {
    if (typeof root !== "string" || !store || typeof store.pending !== "function" || typeof store.begin !== "function"
      || typeof store.finish !== "function" || typeof store.subscriptions !== "function" || typeof send !== "function")
      throw updaterRefuseV1("updater_alert_sender_input_refused");
    // A caller may state its own attempt bound, and one that is not a real
    // bound is refused rather than clamped: a silently clamped hold would be a
    // claim deadline nobody chose, and a zero would make every claim instantly
    // recoverable. Production passes nothing and takes the default above.
    if (claimHoldSeconds !== null) {
      if (!Number.isSafeInteger(claimHoldSeconds) || claimHoldSeconds < 5 || claimHoldSeconds > 3600)
        throw updaterRefuseV1("updater_push_claim_hold_refused");
      this.#claimHoldSeconds = claimHoldSeconds;
    }
    this.root = root; this.store = store; this.send = send; this.now = now; this.timeoutMs = timeoutMs;
    this.vapidRuntime = { getuid, lstat: stat, readFile: read }; this.loadVapid = loadVapid;
  }
  async #readState() {
    try {
      const value = JSON.parse(await readFileNoFollowV1(this.root, "updater-state/push-alert-state.json", { maxBytes: 1_048_576 }));
      if (!value || value.schema !== "control-room.updater-alert-state/v1" || typeof value.rate !== "object" || Array.isArray(value.rate)
        || typeof value.retry !== "object" || Array.isArray(value.retry)) throw new Error();
      this.#rate = value.rate;
      const deliveries = value.deliveries ?? {}, dead = value.dead ?? [];
      if (!deliveries || typeof deliveries !== "object" || Array.isArray(deliveries)
        || Object.entries(deliveries).some(([id, targets]) => !/^push:[0-9a-f-]{36}$/u.test(id)
          || !Array.isArray(targets) || targets.length > 100 || targets.some(target => typeof target !== "string" || target.length > 200))
        || !Array.isArray(dead) || dead.some(id => typeof id !== "string" || id.length > 200))
        throw updaterRefuseV1("updater_alert_state_refused");
      this.#deliveries = deliveries; this.#dead = new Set(dead);
      for (const [id, at] of Object.entries(value.retry)) if (/^push:[0-9a-f-]{36}$/u.test(id) && Number.isSafeInteger(at)) this.#retry.set(id, at);
    } catch (error) { if (error?.code !== "ENOENT") throw updaterRefuseV1("updater_alert_state_refused"); }
  }
  async #writeState() {
    const write = async () => {
      const retry = Object.fromEntries([...this.#retry].filter(([, at]) => at > this.now() - UPDATER_PUSH_RETRY_MS_V1.at(-1)));
      await atomicWriteNoFollowV1(this.root, "updater-state/push-alert-state.json", `${JSON.stringify({
        schema: "control-room.updater-alert-state/v1", rate: this.#rate, retry,
        deliveries: this.#deliveries, dead: [...this.#dead],
      })}\n`);
    };
    this.#writes = this.#writes.then(write, write);
    await this.#writes;
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
  async #send(vapid, subscriptions, payload, rows) {
    const controller = new AbortController();
    for (const row of rows) this.#inflight.add(row.id);
    // U02: a LIVE dispatcher keeps its claim alive for as long as it is really
    // working. The fan-out is bounded (100 subscriptions, 5 s each) but that
    // bound is over the whole batch, and a slow provider makes the real duration
    // long — long enough for a claim deadline to pass and for a recovery to
    // take the row. So the claim is renewed while the sends are in flight.
    //
    // The renewal interval is a FRACTION of the claim hold, never equal to it:
    // a timer that fires at the deadline has already lost the row, so renewing
    // "every 60 seconds" against a 120-second hold leaves room for one missed
    // tick, and two lost ticks is already a recovery. This is also the honest
    // meaning of "live": a process that is running is not one that is wedged, and
    // a process that is wedged stops renewing and is recovered.
    //
    // If a renewal FAILS, this dispatcher has lost the row: another dispatcher
    // took the claim over. It stops and reports a failure rather than sending
    // on top of the new owner, which is the U02 duplicate-send defect measured
    // at the ledger instead of at the network. The failure is `updater_push_
    // claim_lost`, a distinct code from any transport failure, so an operator
    // can tell "the phone would not answer" from "another dispatcher took this".
    const canRenew = this.#fenced && rows.every(row => row.__claimed);
    let renewTimer;
    let lostClaim = null;
    if (canRenew) {
      const interval = Math.max(1000, Math.floor(this.#claimHoldSeconds * 1000 / 2));
      renewTimer = setInterval(() => {
        void Promise.all(rows.map(row => this.store.renewClaim(row.id, row.__claimed, this.#claimHoldSeconds)
          .catch(() => false)))
          .then(results => { if (results.some(ok => ok === false)) lostClaim = updaterRefuseV1("updater_push_claim_lost"); })
          .catch(() => { lostClaim = updaterRefuseV1("updater_push_claim_lost"); });
      }, interval);
      // A renewal timer must never be the reason the process does not exit.
      renewTimer.unref?.();
    }
    let accepted = 0;
    const work = Promise.allSettled(subscriptions.map(async subscription => {
      if (this.#dead.has(subscription.id)) return;
      if (rows.every(row => (this.#deliveries[row.id] ?? []).includes(subscription.id))) { accepted++; return; }
      if (lostClaim) throw lostClaim;
      try {
        const response = await this.send(vapid, subscription, payload, controller.signal);
        if (response?.statusCode !== undefined && !(response.statusCode >= 200 && response.statusCode < 300))
          throw { statusCode: response.statusCode };
      } catch (error) {
        if (error?.statusCode !== 404 && error?.statusCode !== 410) throw error;
        // The deployer has no DELETE grant. Invalidate locally and durably;
        // database pruning remains a separate, authorized store responsibility.
        this.#dead.add(subscription.id); await this.#writeState(); return;
      }
      for (const row of rows) {
        const targets = this.#deliveries[row.id] ??= [];
        targets.push(subscription.id);
      }
      accepted++; await this.#writeState();
    })).then(results => {
      const failed = results.find(result => result.status === "rejected");
      // Losing the claim outranks a transport failure: even if every phone
      // answered, this dispatcher must not record a delivery for a row another
      // dispatcher now owns.
      if (lostClaim) throw lostClaim;
      if (failed) throw failed.reason;
      if (!accepted) throw updaterRefuseV1("updater_push_no_subscription");
    });
    let timer;
    try {
      await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(updaterRefuseV1("updater_push_timeout"));
      }, this.timeoutMs); })]);
    } finally {
      clearTimeout(timer);
      if (renewTimer) clearInterval(renewTimer);
      work.finally(() => { for (const row of rows) this.#inflight.delete(row.id); }).catch(() => {});
    }
  }
  /** Settle every row in one send, and report whether ALL of them settled.
   *
   * The boolean is the answer to "did this send actually record a delivery?",
   * and a false means at least one row's claim had been taken over since the
   * send — a delivery that must not be counted, because the row now belongs to
   * another dispatcher and that dispatcher is responsible for it. This is the
   * U02 property measured at the ledger rather than at the network: the send
   * may well have reached a phone, but the durable record of it is refused.
   *
   * A row this sender CLAIMED is settled with its token. A row claimed WITHOUT
   * one (the offline fixture store, and the pre-existing single-argument
   * `begin()`) settles the old way, so the offline lanes keep working while a
   * production sender can never take that path: `#beginClaimed` always passes
   * the token. The split is visible here rather than hidden behind a flag.
   */
  async #finish(rows, sent, errorCode = null) {
    let allSettled = true;
    for (const row of rows) {
      // `row.__claimed` is set only by `#beginClaimed`, and only when the store
      // has the claim API (see the `#fenced` getter). So this branch is the
      // fenced settle in production and the pre-existing `finish()` for a store
      // that never took a token -- not a runtime choice between two equally
      // good ways to record the same thing.
      const settled = row.__claimed
        ? await this.store.settleClaim(row.id, row.__claimed, { sent, errorCode })
        : (await this.store.finish(row.id, { sent, errorCode }), true);
      // A claim this sender no longer holds is not a delivery it may record, and
      // a FAILED settle must not leave a retry scheduled against a row another
      // dispatcher owns — that would be this process re-driving somebody else's
      // work. So a refused settle clears the in-process bookkeeping too.
      if (!settled) { allSettled = false; this.#retry.delete(row.id); continue; }
      if (sent) { delete this.#deliveries[row.id]; this.#retry.delete(row.id); }
      else {
        const delay = UPDATER_PUSH_RETRY_MS_V1[Math.min(Number(row.attempts), UPDATER_PUSH_RETRY_MS_V1.length - 1)];
        this.#retry.set(row.id, this.now() + delay);
      }
    }
    return allSettled;
  }
  /** Claim one row under THIS sender's token, and mark the row with the token
   * so `#finish` settles it the fenced way. The `__claimed` field is private to
   * this module's rows: it is set on the object `pending()` returned, and the
   * only readers are the two methods above.
   *
   * A store that does not implement the claim API -- the offline fixture store
   * behind the PGlite-free lanes -- is claimed the OLD way and settles the old
   * way. That is checked on the store's SHAPE rather than on whether a token
   * was passed, because a store may accept the options and ignore them, and
   * marking the row as claimed when the store never recorded a token would
   * make `#finish` call `settleClaim` against a store that has no such method
   * (measured: "this.store.settleClaim is not a function", which took the whole
   * offline alert lane down).
   *
   * Production composition is on the fenced path and always has been: the
   * production store is `PostgresUpdaterStoreV1`, which has all three methods,
   * and the sender's default claim hold is the one `claim_push` validates. */
  get #fenced() {
    return typeof this.store.settleClaim === "function"
      && typeof this.store.renewClaim === "function"
      && typeof this.store.recoverExpiredClaims === "function";
  }
  async #beginClaimed(row) {
    if (!this.#fenced) return this.store.begin(row.id);
    const claimed = await this.store.begin(row.id,
      { claimToken: this.#claimToken, claimHoldSeconds: this.#claimHoldSeconds });
    if (claimed) row.__claimed = this.#claimToken;
    return claimed;
  }
  async tick() {
    if (this.#running) return { status: "busy", sent: 0 };
    this.#running = true;
    try {
      // Load the durable checkpoint once. Accepted receipts remain in memory
      // if a filesystem write fails, so retrying cannot erase their evidence.
      if (!this.#loaded) { await this.#readState(); this.#loaded = true; }
      const vapid = await this.loadVapid(this.root, this.vapidRuntime);
      // U07/U03: recover first, every tick, before anything is selected. A row
      // whose claim expired because its process died is released (budget left)
      // or terminated (no budget left) HERE, so it is either sendable again in
      // this same tick or a visible terminal outcome — and never a row that is
      // invisible to selection and cannot be claimed by anyone.
      //
      // It runs before `pending()` so a released row is picked up in this tick
      // rather than the next one, and a terminated row is already excluded by
      // the time selection asks. The sweep is bounded by the store and its
      // result is NOT an error path: a store without the function (the offline
      // fixture store) simply has nothing to recover.
      if (typeof this.store.recoverExpiredClaims === "function")
        await this.store.recoverExpiredClaims(64);
      const subscriptions = (await this.#subscriptions()).filter(subscription => !this.#dead.has(subscription.id));
      const rows = await this.store.pending(50), now = this.now(), grouped = new Map();
      for (const row of rows) {
        if (!(row.template in TEMPLATES)) { if (await this.#beginClaimed(row)) await this.#finish([row], true, "updater_push_template_refused"); continue; }
        if (this.#inflight.has(row.id) || (this.#retry.get(row.id) ?? 0) > now) continue;
        (grouped.get(row.template) ?? grouped.set(row.template, []).get(row.template)).push(row);
      }
      let sent = 0;
      const summary = [];
      for (const [template, batch] of grouped) {
        // Waiting for a phone is not a delivery attempt.
        if (!subscriptions.length) continue;
        const rate = this.#rate[template] ?? {}, allowed = !Number.isSafeInteger(rate.sentAt) || now - rate.sentAt >= UPDATER_PUSH_RATE_MS_V1;
        if (!allowed) { summary.push(...batch); continue; }
        const primary = batch[0];
        if (!await this.#beginClaimed(primary)) continue;
        try {
          // N05: the row's OWN body, when it has one. The cooling-off notice is
          // queued by `enqueue_cooling_off_notices` with the authorized text and
          // the passkey's ledger position in it, and that text is the whole
          // point of the notice — a generic "something happened" would leave the
          // owner unable to act on the one security warning the design spells
          // out verbatim. For every other template the fixed text is the text,
          // because those rows are written by `queue()` from the same table.
          // A row whose body is empty (which the schema CHECK forbids) falls
          // back to the fixed text rather than sending an empty notification.
          const body = typeof primary.body === "string" && primary.body.length > 0
            ? primary.body : TEMPLATES[template];
          await this.#send(vapid, subscriptions, { title: "Control Room updater", body, link: "/needs-me", tag: template }, [primary]);
          if (await this.#finish([primary], true)) { this.#rate[template] = { sentAt: now }; sent++; summary.push(...batch.slice(1)); }
        } catch (error) { await this.#finish([primary], false, safeErrorCode(error)); }
      }
      // A summary covers only the rows claimed for THIS send. Fresh warnings
      // wait if the hourly summary budget is spent; an older summary cannot
      // acknowledge warnings which did not exist when it was accepted.
      if (summary.length && subscriptions.length && (!Number.isSafeInteger(this.#rate.flood?.sentAt)
        || now - this.#rate.flood.sentAt >= UPDATER_PUSH_RATE_MS_V1)) {
        const claimed = [];
        for (const row of summary) if (await this.#beginClaimed(row)) claimed.push(row);
        if (claimed.length) {
          try {
            await this.#send(vapid, subscriptions, { title: "Control Room updater", body: "Several alerts were grouped. Please review Control Room.", link: "/needs-me", tag: "control-room-updater.flood" }, claimed);
            // A summary that could not record its rows did not cover them, so it
            // does not spend the hourly budget: otherwise the rows it failed to
            // settle would be acknowledged by a LATER summary for a send that
            // never happened. That is N09's defect in the recovery path.
            if (await this.#finish(claimed, true, "updater_push_grouped")) { this.#rate.flood = { sentAt: now }; sent++; }
          } catch (error) { await this.#finish(claimed, false, safeErrorCode(error)); }
        }
      }
      await this.#writeState(); return { status: "ok", sent, subscriptions: subscriptions.length };
    } finally { this.#running = false; }
  }
}
