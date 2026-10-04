import { assertOwnerActionTimeoutV1, beginOwnerActionV1 } from "./owner-action.mjs";
import { lstat, readlink, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { parseSelfUpdateFlagV1, publicStatusV1, SAFE_ID_V1, updaterRefuseV1, updaterRunAttentionV1 } from "./contracts.mjs";
export { FileStepJournalV1, RefusalAggregatorV1, reconcileJournalDisplayV1 } from "./journal.mjs";

/** R7U-01: a durable run state, as the PUBLIC status state the owner reads.
 *
 * Stated here rather than mapped at the call site so there is one answer per
 * state, and so an outcome the database can hold but the display cannot name
 * cannot be published as something else. `rolled_back` and `refused` keep the
 * names they already had, which is why removing the two-name cache did not
 * change those two cards.
 *
 * @param {string} state a state from `updater.owner_run_attention.state`
 * @returns {string|null} null for a state that is not a public state at all,
 *   which is a refusal rather than a default: publishing an unknown outcome as
 *   `idle` is the defect this whole change is about. */
function publicRunStateV1(state) {
  if (state === "needs_attention" || state === "attended_upgrade_required" || state === "uncertain") return state;
  if (state === "refused" || state === "rolled_back") return state;
  // R7U-01 (lead decision 2): `error` is a state of the UPDATER rather than of
  // the run, but it is still a public state with a name the owner reads and a
  // reason sentence of its own. `publicStatusV1` carries it as `error`, which is
  // what `contracts.mjs` has always accepted on the tick path (`["busy",
  // "needs_attention", "error"]` all published as `needs_attention` before).
  if (state === "error") return "needs_attention";
  return null;
}

/** R7U-02's damaged-switch fact, read from whichever snapshot of `publicFacts`
 * this tick is holding. A caller whose `publicFacts` predates the field (the
 * in-memory fixtures, the rehearsal scenarios) reads `false`, which is the
 * pre-R7U-02 behaviour rather than a refusal: the fact is a FILE this tree may
 * not have written, not an authority a caller is asserting. */
function refreshedSelfUpgradeNeedsAttention(facts) {
  return facts?.selfUpgradeNeedsAttention === true;
}

export class UpdaterStateFilesV1 {
  constructor(root, leaseToken) { this.root = root; this.leaseToken = leaseToken; }
  readSelfUpdate() { return readFileNoFollowV1(this.root, "updater-state/self-update", { maxBytes: 16 }); }
  async hasRescueMarker() {
    try {
      const entry = await lstat(`${this.root}/updater-state/rescued.json`);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 16_384)
        throw updaterRefuseV1("updater_rescue_marker_refused");
      return true;
    } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  }
  async removeRescueMarker() {
    await this.hasRescueMarker();
    await atomicWriteNoFollowV1(this.root, "updater-state/rescue-resolution.json", `${JSON.stringify({
      schema: "control-room.rescue-resolution/v1", pending: true,
    })}\n`);
    await unlink(`${this.root}/updater-state/rescued.json`);
  }
  async confirmRescueResolution() {
    await atomicWriteNoFollowV1(this.root, "updater-state/rescue-resolution.json", `${JSON.stringify({
      schema: "control-room.rescue-resolution/v1", pending: false,
    })}\n`);
  }
  async readMode() {
    let value;
    try { value = JSON.parse(await readFileNoFollowV1(this.root, "updater-state/mode.json", { maxBytes: 256 })); }
    catch (error) {
      if (error?.code === "ENOENT") return "running";
      if (error instanceof SyntaxError) throw updaterRefuseV1("updater_mode_state_refused");
      throw error;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "mode,schema"
        || value.schema !== "control-room.updater-mode/v1"
        || !["running", "paused", "stopped"].includes(value.mode))
      throw updaterRefuseV1("updater_mode_state_refused");
    return value.mode;
  }
  writeMode(mode) {
    return atomicWriteNoFollowV1(this.root, "updater-state/mode.json", `${JSON.stringify({
      schema: "control-room.updater-mode/v1", mode,
    })}\n`);
  }
  async writeHeartbeat(value) {
    await atomicWriteNoFollowV1(this.root, "updater-state/heartbeat", `${JSON.stringify({
      schema: "control-room.updater-heartbeat/v1", at: new Date().toISOString(), ...value,
    })}\n`);
  }
  async writeStatus(value) {
    await atomicWriteNoFollowV1(this.root, "status/status.json", `${JSON.stringify(publicStatusV1(value))}\n`,
      { mode: 0o644 });
  }
  async publicFacts() {
    // `lastUpdateState` is deliberately ABSENT where cook/r7ufix declared it, and
    // that is R7U-01 rather than a tidying-up: the cache kept exactly two state
    // NAMES alive across idle polls by re-reading this file's own previous
    // `state`, so `refused` and `rolled_back` survived and `needs_attention`,
    // `uncertain` and `attended_upgrade_required` did not — because the cache
    // could only remember names it was told to. A cache that is correct for two
    // outcomes and silent for three is worse than none: it is why a failed
    // upgrade read as healthy one poll later while a durable row said otherwise.
    // The database answers the question now, and it has an answer for every
    // outcome. R7U-02's `rescueResolutionPending` survives on the SAME read below,
    // because that is a different fact: not "what happened to the last update"
    // but "has the owner seen the rescue I told them about".
    let releaseId = null, updaterRestartsLastHour = 0,
      selfUpgradeNeedsAttention = false, rescueResolutionPending = false;
    try {
      const target = await readlink(`${this.root}/current`);
      if (target.startsWith("/") || target.split("/").includes(".."))
        throw updaterRefuseV1("updater_current_link_refused");
      releaseId = SAFE_ID_V1.test(basename(target)) ? basename(target) : null;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    try {
      const guard = JSON.parse(await readFileNoFollowV1(this.root, "updater-state/guard-status.json",
        { maxBytes: 4096 }));
      if (guard?.schema !== "control-room.guard-status/v1" || !Number.isInteger(guard.updaterRestartsLastHour)
          || guard.updaterRestartsLastHour < 0 || guard.updaterRestartsLastHour > 3)
        throw updaterRefuseV1("updater_guard_status_refused");
      const age = Date.now() / 1000 - guard.at;
      updaterRestartsLastHour = Number.isSafeInteger(guard.at) && age >= 0 && age < 3600 ? guard.updaterRestartsLastHour : 0;
    } catch { /* Guard status is a disposable display cache, never authority. */ }
    // R7U-02's rescue-resolution fact, read from the previous status file. Kept
    // on this read and NOT the two-name cache it used to sit beside: this asks
    // "did the owner already act on the rescue I published", which is about the
    // owner's own action, not about what the last update did to the install.
    try {
      const previous = JSON.parse(await readFileNoFollowV1(this.root, "status/status.json", { maxBytes: 8192 }));
      if (previous.schema === "control-room.updater-status/v1" && previous.nextAction === "review_rescue_on_mac")
        rescueResolutionPending = true;
    } catch { /* An absent or damaged cache supplies no completed-update fact. */ }
    // R7U-02: a self-update flip that was reverted is a damaged switch, so it is
    // needs-attention rather than a quiet Off.
    try {
      const flip = JSON.parse(await readFileNoFollowV1(this.root, "updater-state/selfupgrade.json", { maxBytes: 16_384 }));
      selfUpgradeNeedsAttention = flip?.schema === "control-room.selfupgrade/v1" && flip.state === "needs_attention"
        && flip.reason === "updater_selfupgrade_reverted";
    } catch (error) { if (error?.code !== "ENOENT") selfUpgradeNeedsAttention = true; }
    try {
      const resolution = JSON.parse(await readFileNoFollowV1(this.root, "updater-state/rescue-resolution.json", { maxBytes: 256 }));
      if (resolution?.schema === "control-room.rescue-resolution/v1" && resolution.pending === true)
        rescueResolutionPending = true;
    } catch { /* The last public rescue action also supports a manually cleared marker. */ }
    return { releaseId, updaterRestartsLastHour, selfUpgradeNeedsAttention, rescueResolutionPending };
  }
}

export class UpdaterModeV1 {
  #value = "running";
  #serial = Promise.resolve();
  constructor(stateFiles) { this.stateFiles = stateFiles; }
  async initialize() {
    if (this.stateFiles?.readMode) this.#value = await this.stateFiles.readMode();
    return this.#value;
  }
  async read() { await this.#serial; return this.#value; }
  async set(value) {
    if (!["running", "paused", "stopped"].includes(value)) throw updaterRefuseV1("updater_mode_refused");
    const change = this.#serial.then(async () => {
      if (this.stateFiles?.writeMode) await this.stateFiles.writeMode(value);
      this.#value = value;
    });
    this.#serial = change.catch(() => {});
    await change;
  }
}

// acknowledge_attention only records that the owner has seen an outstanding outcome; it changes
// nothing the updater installs, so it must work while self-update is Off too.
const RISK_REDUCING_WHILE_OFF_V1 = new Set(["pause", "stop", "backup_now", "check_and_continue", "repair_serve", "acknowledge_attention"]);

// The switch file's own refusal or read error, reduced to a short printable fact. It goes into
// the status message the owner reads, so it must never carry a path, a newline or a control byte.
const cleanReason = error => String(error?.code ?? error?.message ?? "unknown")
  .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").slice(0, 120);

export class UpdaterMainLoopV1 {
  #timer; #ticking = false; #watching; #activeTick; #ownerAction; #stopping = false;
  constructor({ runner, store, stateFiles, mode, ownerActions, watcher = null, alerts = null,
    alertFacts = async () => ({}), intervalMs = 5_000, watcherTimeoutMs = 5000, ownerActionTimeoutMs = 300_000, onError = () => {} }) {
    assertOwnerActionTimeoutV1(ownerActionTimeoutMs);
    this.runner = runner; this.store = store; this.stateFiles = stateFiles; this.mode = mode;
    this.ownerActions = ownerActions; this.watcher = watcher; this.alerts = alerts; this.alertFacts = alertFacts;
    this.intervalMs = intervalMs; this.watcherTimeoutMs = watcherTimeoutMs; this.ownerActionTimeoutMs = ownerActionTimeoutMs; this.onError = onError;
    this.lastOutcome = { status: "idle" };
  }
  async #requests(flag) {
    if (this.#ownerAction) return false;
    for (const request of await this.store.unhandledOwnerRequests()) {
      if (this.#stopping) return false;
      if (flag === "Off" && !RISK_REDUCING_WHILE_OFF_V1.has(request.request_kind)) {
        await this.store.finishOwnerRequest(request.id, "refused"); continue;
      }
      const action = beginOwnerActionV1(async context => {
        let outcome = "acted";
        try { await this.ownerActions.handle({ ...request, source: "web" }, context); }
        catch { outcome = "refused"; }
        await this.store.finishOwnerRequest(request.id, outcome);
      }, this.ownerActionTimeoutMs, "updater_owner_action_timeout");
      this.#ownerAction = action;
      action.completion.then(() => { if (this.#ownerAction === action) this.#ownerAction = undefined; });
      const outcome = await action.wait;
      if (outcome.pending) {
        try { this.onError(updaterRefuseV1("updater_owner_action_timeout")); } catch {}
        return false;
      }
      if (outcome.error) throw outcome.error;
    }
    return !this.#stopping;
  }
  tick() {
    if (this.#stopping) return Promise.resolve({ status: "stopped" });
    if (this.#ticking) return Promise.resolve({ status: "busy" });
    const tick = this.#tick(); this.#activeTick = tick;
    tick.finally(() => { if (this.#activeTick === tick) this.#activeTick = undefined; }).catch(() => {});
    return tick;
  }
  /** R7U-01: this tick's durable run outcome, or null when the tick names none.
   *
   * Read from the runner's `durableOutcome` rather than re-derived from
   * `status`, because the STATUS is the display name and the ROW is the fact:
   * `needs_attention` and `uncertain` are both `needs_attention` on the card,
   * and they need different instructions. The runner reads the state off the row
   * it just wrote, so by the time the loop sees it the two cannot disagree.
   *
   * A caller that supplies its own outcome shape without the field gets null,
   * which means "nothing durable to record" — never a guess.
   */
  #durableRunAttention(outcome) {
    const durable = outcome?.durableOutcome;
    if (!durable || typeof durable !== "object" || Array.isArray(durable)) return null;
    if (typeof durable.runId !== "string" || typeof durable.state !== "string") return null;
    return Object.freeze({ runId: durable.runId, state: durable.state,
      code: typeof durable.code === "string" ? durable.code : null });
  }

  async #tick() {
    if (this.#ticking) return { status: "busy" };
    this.#ticking = true;
    try {
      // An unreadable switch must not take the whole loop down with it. Stop, Pause and
      // backup-now are RISK-REDUCING: refusing them because a three-byte file is torn is the
      // wrong way to fail, and it left the owner with no way to stop the service at all. A
      // refused or unreadable switch is treated as Off — which is also the only direction that
      // can start an update, so it cannot start one — and the tick continues so status is still
      // published and the damage is visible as needsYou.
      let flag = "Off", switchUnreadable;
      try { flag = parseSelfUpdateFlagV1(await this.stateFiles.readSelfUpdate()); }
      catch (error) { switchUnreadable = cleanReason(error); }
      const requestsSettled = await this.#requests(flag);
      // R5iii: while Off, do not read approval rows, watch sources or invoke a
      // builder. Only timer work and risk-reducing owner requests run.
      if (requestsSettled && !this.#stopping && flag === "On" && this.watcher) {
        if (!this.#watching) {
          const watching = Promise.resolve().then(() => this.watcher.tick());
          this.#watching = watching;
          watching.finally(() => { if (this.#watching === watching) this.#watching = undefined; }).catch(() => {});
          let timer;
          try { await Promise.race([watching, new Promise((_, reject) => {
            timer = setTimeout(() => reject(updaterRefuseV1("updater_watcher_timeout")), this.watcherTimeoutMs);
          })]); } catch (error) { try { this.onError(error); } catch { /* reporting cannot block the runner */ } }
          finally { clearTimeout(timer); }
        }
      }
      const publicFacts = this.stateFiles.publicFacts ? await this.stateFiles.publicFacts() : {};
      const rescued = await this.stateFiles.hasRescueMarker();
      if (!requestsSettled || this.#stopping) this.lastOutcome = { status: "uncertain",
        message: "An owner action has not settled; updates are held until it finishes." };
      else if (rescued) {
        const measured = await this.runner.runOnce();
        this.lastOutcome = measured.status === "idle" ? { status: "uncertain",
          message: "A rescue occurred; owner review is required. If no update is running, clear the rescue on the Mac." }
          : measured;
      } else this.lastOutcome = flag === "Off"
        ? { status: "idle", message: switchUnreadable
          ? `The self-update switch could not be read (${switchUnreadable}); self-update is being treated as Off.`
          : "Self-update is Off." }
        : await this.runner.runOnce({ onProgress: async () => {
          await this.stateFiles.writeStatus({ ...publicFacts, state: "running", needsYou: false, selfUpdate: flag });
        } });
      // -------------------------------------------------------------------
      // R7U-01: THE OWNER-VISIBLE STATE IS A DURABLE DATABASE FACT.
      // -------------------------------------------------------------------
      //
      // Before this, the published state was a function of THIS tick's outcome
      // plus a two-name in-memory cache. `needs_attention`, `uncertain`,
      // `attended_upgrade_required` and `error` are recorded as terminal, so the
      // next `runOnce` found no live run and answered `idle` — the status file
      // said healthy, `needsYou:false`, and the Home card said healthy, one
      // five-second poll after the runner had said "Automatic recovery needs
      // owner attention". The run row stayed in the database the whole time,
      // unread.
      //
      // So the write is recorded first and the READ is what publishes. A run
      // outcome is durable the moment the runner returns it; after that the
      // tick's own outcome can be idle, busy, refused-by-a-damaged-switch or
      // nothing at all, and the owner's answer must not depend on which of
      // those happened to be true this time round.
      //
      // A store WITHOUT the durable port keeps the tick's own outcome, which is
      // the pre-existing behaviour for a composition that has no durable store to
      // ask (the rehearsal scenarios and the in-memory fixtures). Both halves are
      // gated on the SAME check, deliberately: a store that could be written to
      // but not read back would record an outcome and then publish a healthy
      // card — the defect, reproduced through half a port. A store that HAS the
      // port and fails to answer raises, because publishing a healthy card while a
      // query is broken is the exact failure this change exists to end.
      const durableCapable = typeof this.store.observeRunAttention === "function"
        && typeof this.store.openRunAttention === "function";
      const durable = durableCapable ? this.#durableRunAttention(this.lastOutcome) : null;
      if (durable) {
        await this.store.observeRunAttention(durable.state, { runId: durable.runId, code: durable.code });
      }
      const outstanding = durableCapable ? await this.store.openRunAttention() : null;
      const mode = await this.mode.read();
      const status = this.lastOutcome.status;
      // An outstanding durable outcome is the published state, with its own
      // fixed reason. `mode` is deliberately NOT consulted over it: a paused or
      // stopped updater still has an unrecovered failure to tell the owner
      // about, and quiet mode is not consent to forget one.
      // An outstanding row whose state has no public name is REFUSED, not
      // published as null. The database's CHECK keeps the set to run states and
      // the six attention ones are named here, so this cannot be reached by a
      // row the product wrote — and if it ever were, a refusal is the only safe
      // answer: publishing `null` would drop the state entirely and render the
      // install as healthy, which is the defect itself.
      const durableState = outstanding ? publicRunStateV1(outstanding.state) : null;
      if (outstanding && !durableState) throw updaterRefuseV1("updater_attention_state_refused");
      // -----------------------------------------------------------------------
      // PRECEDENCE, because the merge put four independent needs-you facts here
      // and the ORDER between them is a product decision, not a detail.
      //
      //   1. a REVERTED SELF-UPDATE SWITCH (R7U-02) outranks everything. It is
      //      about whether any future update can happen at all, so it is
      //      `needs_attention` even when the last run finished cleanly and even
      //      when an older run is still outstanding. The outstanding row's own
      //      reason still travels with it below, because the owner has to settle
      //      both.
      //   2. then the OUTSTANDING DURABLE ROW (R7U-01), over this tick's own
      //      outcome. The tick can be idle, busy, or refused by a damaged switch
      //      while the database still holds a failure nobody answered.
      //   3. then this tick's own outcome, for a store with no durable port (the
      //      rehearsal scenarios and the in-memory fixtures).
      // `mode` is last of all, and only over a tick that named no outcome.
      // The re-read is done HERE, before the first use, rather than after it as
      // cook/r7ufix had it. `publicFacts` was read at the top of the tick and the
      // updater can have written `selfupgrade.json` since — the re-read is what
      // makes the publish see the damage rather than the snapshot. Ordering it
      // before the precedence chain rather than after is what makes there be ONE
      // answer per tick: the two `publicFacts` reads cannot disagree about
      // `selfUpgradeNeedsAttention` and produce two different published states
      // from one tick.
      const refreshedFacts = this.stateFiles.publicFacts ? await this.stateFiles.publicFacts() : {};
      const damagedSwitchRefreshed = refreshedSelfUpgradeNeedsAttention(refreshedFacts);
      const damagedSwitch = publicFacts.selfUpgradeNeedsAttention === true || damagedSwitchRefreshed;
      const publicState = damagedSwitch ? "needs_attention"
        : outstanding ? durableState
        : status === "uncertain" ? "uncertain"
        : status === "attended_upgrade_required" ? "attended_upgrade_required"
        : status === "waiting" ? "awaiting_approval"
        : status === "rolled_back" ? "rolled_back"
        : status === "refused" ? "refused"
        : ["busy", "needs_attention", "error"].includes(status) ? "needs_attention"
        : mode !== "running" ? mode
        : "idle";
      // A damaged switch is Off AND needs the owner: it is not a normal quiet Off, so `needsYou` must
      // be true for it regardless of the outcome status, or the damage is invisible.
      const needsYou = damagedSwitch || switchUnreadable !== undefined || Boolean(outstanding)
        || ["busy", "uncertain", "attended_upgrade_required", "needs_attention", "error", "rolled_back"]
          .includes(status);
      // `damagedSwitch` ALREADY ORS the refreshed read into the chain above, so
      // there is no second conditional here to keep in step with the first — an
      // earlier version of this merge had one, which meant two places had to agree
      // about which read wins and only one of them was the chain. The re-read is
      // folded in once, at `damagedSwitch`.
      const finalState = publicState;
      const finalNeedsYou = needsYou;
      const resolved = !rescued && publicFacts.rescueResolutionPending && this.lastOutcome.status === "idle" && !finalNeedsYou;
      // -----------------------------------------------------------------------
      // THE ACTION KEY, and which of the three candidate sources wins.
      //
      // `nextAction` is an ALLOWLISTED KEY (R7U-02) and `reason` is the SENTENCE
      // for this specific outcome (R7U-01); they are separate fields because they
      // are separate kinds of value. The merge is what proved it: one field had
      // come to hold both, and the merged contract refused whichever the other
      // branch's caller wrote.
      //
      // The rescue key wins over the durable row's key ONLY when the row is
      // itself `uncertain`, because those are the same fact described two ways and
      // the rescue wording is the more specific one. It does not win over a
      // DIFFERENT outstanding outcome: a `rolled_back` row from yesterday must
      // not be relabelled as today's rescue.
      //
      // `resolved` cannot collide with an outstanding row at all: `finalNeedsYou`
      // is true whenever a row is outstanding, so `resolved` requires its absence.
      const attention = outstanding ? updaterRunAttentionV1(outstanding) : null;
      const rescueAction = finalState === "uncertain" && rescued && (!attention || attention.nextAction === "check_and_continue")
        ? "review_rescue_on_mac" : undefined;
      const nextAction = rescueAction ?? attention?.nextAction ?? (resolved ? "rescue_resolved" : undefined);
      // The REASON travels with the status, and it comes from the fixed table
      // keyed by the durable row's own code — never from the row's text, never
      // from a caller. `publicStatusV1` drops it if the shape ever stops
      // allowing it, so this cannot become a second public API by accident.
      // THE REASON IS PUBLISHED WHENEVER THERE IS AN OUTSTANDING ROW, even when
      // the rescue key overtook the row's own key above. That is what the
      // precedence comment above promises, and suppressing the reason whenever
      // `rescueAction` won would have broken it: a run stuck `uncertain` behind a
      // rescue marker would then publish the rescue's instruction with NO sentence
      // about the update that is actually stuck — which is the one card where the
      // owner most needs to know two things are outstanding. Measured: the
      // uncertain case failed on exactly that.
      //
      // The two fields describe different things and are allowed to disagree —
      // that is the merge's whole point — so there is no rule here that one must
      // imply the other.
      await this.stateFiles.writeStatus({ ...refreshedFacts, state: finalState, needsYou: finalNeedsYou, selfUpdate: flag,
        ...(nextAction === undefined ? {} : { nextAction }),
        ...(attention ? { reason: attention.reason } : {}) });
      if (resolved) await this.stateFiles.confirmRescueResolution?.();
      if (this.alerts) {
        const facts = await this.alertFacts();
        if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw updaterRefuseV1("updater_alert_facts_refused");
        await this.alerts.reconcile({ ...facts, needsOwner: facts.needsOwner === true || ["needs_attention", "error", "rolled_back"].includes(this.lastOutcome.status),
          uncertain: facts.uncertain === true || this.lastOutcome.status === "uncertain", rescue: facts.rescue === true || rescued });
        await this.alerts.tick();
      }
      // N06: the warning that OUTLASTS the outcome. Everything above is
      // transient by design -- an edge, a push row, a status file that is
      // rewritten every tick -- and an update that failed at 03:00 has stopped
      // being an `error` by 03:01, so all of it is gone by then. This is the
      // one record that says the owner has not looked yet, and it is durable
      // until they do.
      //
      // It is written AFTER the alert, deliberately: the push is the phone's
      // copy and the review is the record, and if the push path fails the
      // owner still has a warning on /needs-me. A warning whose existence
      // depends on the transport working is the N01 shape repeating itself.
      //
      // `observeUpdateOutcome` is UPSERT per kind, so a loop that ticks every
      // five seconds while the condition persists leaves ONE row rather than
      // five hundred a day. And it is called on BOTH error and rollback,
      // because the two are different warnings: "the update failed" and "we
      // put the old one back" are different facts the owner may want to tell
      // apart weeks later.
      if (typeof this.store.observeUpdateOutcome === "function"
        && ["error", "rolled_back"].includes(this.lastOutcome.status))
        await this.store.observeUpdateOutcome(this.lastOutcome.status === "error" ? "update_error" : "update_rolled_back",
          { runId: typeof this.lastOutcome.runId === "string" ? this.lastOutcome.runId : null });
      return this.lastOutcome;
    } finally { this.#ticking = false; }
  }
  start() {
    if (!this.#timer) this.#timer = setInterval(() => void this.tick().catch(error => this.onError(error)), this.intervalMs);
    return this;
  }
  // stop() keeps the existing manual-tick API; shutdown() ends ownership.
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  async shutdown() {
    this.#stopping = true;
    this.stop();
    this.#ownerAction?.cancel();
    await Promise.allSettled([this.#activeTick, this.#ownerAction?.completion, this.#watching]);
  }
}

export function newUpdaterIdentityV1() {
  return Object.freeze({ bootId: `boot-${randomUUID()}`, leaseToken: `lease-${randomUUID()}` });
}
