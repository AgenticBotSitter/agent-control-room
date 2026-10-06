import { parseSelfUpdateFlagV1, updaterRefuseV1 } from "./contracts.mjs";

const PRE_DRAIN_V1 = new Set(["approved", "prechecked", "staged", "quick_backup"]);
const TERMINAL_V1 = new Set(["succeeded", "rolled_back", "needs_attention", "refused"]);
/** R7U-01: the run states whose outcome is the OWNER'S published state, plus the
 * one that clears it. Deliberately NOT `TERMINAL_V1`: `uncertain` and
 * `attended_upgrade_required` are not terminal (the owner can measure and settle
 * them) yet they are exactly the two states whose owner-facing instruction
 * ("Check and continue") is most needed, and a set equal to the terminal one
 * would have dropped them — which is the defect, not a fix. Kept separate rather
 * than derived, because the two sets answer different questions. */
const RUN_ATTENTION_STATES_V1 = new Set(["needs_attention", "uncertain", "attended_upgrade_required",
  "refused", "rolled_back", "succeeded"]);
const EFFECT_FAILURES_V1 = new WeakMap();

function markEffectFailureV1(error, name) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    EFFECT_FAILURES_V1.set(error, name); return error;
  }
  const wrapped = updaterRefuseV1("updater_step_failed");
  wrapped.cause = error; EFFECT_FAILURES_V1.set(wrapped, name); return wrapped;
}

const plainFailureV1 = Object.freeze({
  updater_precheck_refused: "The update could not be checked, so nothing was changed.",
  updater_referee_refused: "The running updater's rules refused this update, so nothing was changed.",
  updater_self_update_off: "Automatic updating is Off, so nothing was changed.",
  updater_disk_reserve_low: "There is too little free disk space for this update. Free some space on the Mac, then retry; nothing was changed.",
});
const reserveFailureV1 = Object.freeze({
  missing: "This install is missing its disk safety margin. Free space on the Mac and retry to rebuild it, or repair the install; nothing was changed.",
  short: "This install is missing part of its disk safety margin because the reserve is incomplete. Repair the install on the Mac before retrying; nothing was changed.",
  wrong_size: "This install is missing its verified disk safety margin because the reserve has the wrong size or allocation. Repair the install on the Mac before retrying; nothing was changed.",
});

/**
 * Item-8 skeleton of the durable updater state machine.
 *
 * Rules salvaged from cook/deploy, without importing its code:
 * - exactly one in-process caller;
 * - owner pause/stop is consulted only before drain;
 * - intent is durable before each repeat-safe effect and done is durable after;
 * - an interrupted effect is replayed from observable state;
 * - after drain, the run finishes or rolls back and is never stranded;
 * - a rescue marker forces `uncertain`; only an explicit owner
 *   check-and-continue can measure or settle it.
 */
export class UpdaterRunnerV1 {
  #running = false;
  constructor({ store, effects, journal, mode, stateFiles, referee, onHeartbeatState = () => {} }) {
    this.store = store; this.effects = effects; this.journal = journal; this.mode = mode;
    this.stateFiles = stateFiles; this.referee = referee; this.onHeartbeatState = onHeartbeatState;
  }

  /** The next journal ordinal for a run, for the runner's own intent lines.
   *
   * A failed effect has a durable file intent but no database event. Use both
   * authorities so the recovery intent cannot reuse that ordinal with different
   * content and invalidate the file chain. The database still derives its own
   * mirror ordinal inside `updater.record_run_step`. */
  async #nextOrdinal(runId) {
    const events = await this.store.events(runId);
    const databaseNext = (events.at(-1)?.ordinal ?? 0) + 1;
    const journalNext = await this.journal.nextOrdinal?.(runId);
    return Math.max(databaseNext, journalNext ?? 1);
  }

  async #record(run, state, detail = {}, options = {}) {
    // §11's order, unchanged: journal the intent, take the transition (which
    // writes the database mirror in the SAME statement), journal the done line.
    // Read the file label once for the matching intent/done lines. The database
    // derives its own event ordinal; failed file intents have no database event.
    // The production transition replaces detail; retain the pinned effect inputs.
    detail = { ...run.detail, ...detail };
    const ordinal = await this.#nextOrdinal(run.run_id);
    await this.journal.intent({ runId: run.run_id, ordinal, from: run.state, to: state, detail });
    const next = await this.store.transition(run.run_id, run.lease_token, state, detail, options);
    await this.journal.done({ runId: run.run_id, ordinal, state, detail });
    return next;
  }

  async #effect(run, name, nextState, effect, detail = {}, options = {}) {
    // The production transition replaces detail; retain the pinned effect inputs.
    detail = { ...run.detail, ...detail };
    const ordinal = await this.#nextOrdinal(run.run_id);
    await this.journal.intent({ runId: run.run_id, ordinal, from: run.state, to: nextState,
      detail: { ...detail, effect: name } });
    try { await effect(); } // Every port method is required to be repeat-safe.
    catch (error) { throw markEffectFailureV1(error, name); }
    // The row and its mirror event move in one statement, so a kill after the
    // effect leaves the run in its PREVIOUS state — which is exactly what an
    // interrupted effect looks like, and which the replayable ports can repeat.
    // There is no window in which the row has advanced and the journal has not.
    const next = await this.store.transition(run.run_id, run.lease_token, nextState, detail, options);
    await this.journal.done({ runId: run.run_id, ordinal, state: nextState, detail });
    return next;
  }

  async #rollback(run, originalCode) {
    let current = run;
    if (current.state !== "rollback_started")
      current = await this.#record(current, "rollback_started", { originalCode });
    try {
      current = await this.#effect(current, "rollback", "code_restored",
        () => this.effects.rollback(current), { originalCode });
      return { status: "rolled_back", run: await this.#record(current, "rolled_back",
        { originalCode }, { terminal: true }), message: "The previous known-good pair is back." };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "updater_rollback_failed";
      return { status: "needs_attention", code, run: await this.#record(current, "needs_attention",
        { originalCode, code }, { terminal: true }), message: "Automatic recovery needs owner attention." };
    }
  }

  async #start(run) {
    const selfUpdate = parseSelfUpdateFlagV1(await this.stateFiles.readSelfUpdate());
    if (selfUpdate !== "On") {
      const refused = await this.#record(run, "refused", { code: "updater_self_update_off" }, { terminal: true });
      return { status: "refused", run: refused, message: plainFailureV1.updater_self_update_off };
    }
    const mode = await this.mode.read();
    if (mode === "stopped") {
      const refused = await this.#record(run, "refused", { code: "updater_owner_stop" }, { terminal: true });
      return { status: "refused", run: refused, message: "The owner stopped the update before anything changed." };
    }
    if (mode !== "running") return { status: "waiting", run, message: "The update is paused before any switch." };
    await this.referee.assertPlanAllowed(run); // Typed port; item 16 supplies the implementation.
    return this.#effect(run, "precheck", "prechecked", () => this.effects.precheck(run));
  }

  async #advance(initial) {
    let run = initial;
    if (await this.stateFiles.hasRescueMarker()) {
      if (run.state !== "uncertain") run = await this.#record(run, "uncertain", { reason: "rescue_marker" });
      return { status: "uncertain", run,
        message: "Control Room isn't sure the last update finished. Check and continue; if no update is running, clear the rescue on the Mac." };
    }
    if (run.state === "uncertain" || run.state === "attended_upgrade_required")
      return { status: run.state, run, message: "Owner action is required before this run can continue." };
    if (run.state === "code_restored") return { status: "rolled_back",
      run: await this.#record(run, "rolled_back", { originalCode: run.detail?.originalCode }, { terminal: true }),
      message: "The previous known-good pair is back." };
    if (run.state === "rollback_started") return this.#rollback(run, run.detail?.originalCode ?? "updater_resumed_failure");
    try {
      if (run.state === "approved") {
        const started = await this.#start(run);
        if ("status" in started) return started;
        run = started;
      }
      while (!TERMINAL_V1.has(run.state)) {
        if (PRE_DRAIN_V1.has(run.state)) {
          const ownerMode = await this.mode.read();
          if (ownerMode === "stopped") {
            const refused = await this.#record(run, "refused", { code: "updater_owner_stop" }, { terminal: true });
            return { status: "refused", run: refused, message: "The owner stopped the update before the switch." };
          }
          if (ownerMode !== "running") return { status: "waiting", run, message: "The update is paused before drain." };
        }
        switch (run.state) {
          case "prechecked": run = await this.#effect(run, "stage", "staged", () => this.effects.stage(run)); break;
          case "staged": run = await this.#effect(run, "quick_backup", "quick_backup",
            () => this.effects.quickBackup(run)); break;
          case "quick_backup": run = await this.#effect(run, "drain", "draining", () => this.effects.drain(run)); break;
          case "draining": run = await this.#effect(run, "switch", "switched", () => this.effects.switchPair(run)); break;
          case "switched": run = await this.#effect(run, "restart", "restarted", () => this.effects.restart(run)); break;
          case "restarted": {
            run = await this.#effect(run, "health", "healthy", async () => {
              if (!await this.effects.health(run)) throw updaterRefuseV1("updater_health_failed");
            });
            break;
          }
          case "healthy": {
            run = await this.#effect(run, "known_good", "succeeded",
              () => this.effects.commitKnownGood(run), {}, { terminal: true });
            return { status: "succeeded", run, message: "Update installed and healthy." };
          }
          default: throw updaterRefuseV1("updater_run_state_unexpected");
        }
      }
      return { status: run.state, run, message: "The updater run is already finished." };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "updater_step_failed";
      if (PRE_DRAIN_V1.has(run.state) && EFFECT_FAILURES_V1.get(error) !== "drain") {
        const reserveIssue = code === "updater_rescue_reserve_refused" && Object.hasOwn(reserveFailureV1, error.reserveIssue)
          ? error.reserveIssue : undefined;
        const refused = await this.#record(run, "refused", { code, ...(reserveIssue ? { reserveIssue } : {}) }, { terminal: true });
        return { status: "refused", code, run: refused,
          message: code === "updater_rescue_reserve_refused" ? reserveFailureV1[reserveIssue ?? "wrong_size"]
            : plainFailureV1[code] ?? "The update was refused before the switch. Nothing was changed." };
      }
      return this.#rollback(run, code);
    }
  }

  async #journalUncertain(run, reason) {
    if (run.state === "uncertain") return { status: "uncertain", run,
      message: "The updater journal is damaged. Tap Check and continue." };
    const uncertain = await this.store.transition(run.run_id, run.lease_token, "uncertain", { ...run.detail, reason });
    return { status: "uncertain", code: reason, run: uncertain,
      message: "The updater journal is damaged. Tap Check and continue." };
  }

  #outcomeHeartbeat(outcome, run) {
    if (["waiting", "uncertain", "attended_upgrade_required"].includes(outcome.status))
      this.onHeartbeatState({ state: "awaiting_approval", step: outcome.run?.state ?? run.state });
    else if (outcome.status === "rolled_back") this.onHeartbeatState({ state: "rolled_back", step: null });
    else if (outcome.status === "needs_attention") this.onHeartbeatState({ state: "uncertain", step: null });
    else this.onHeartbeatState({ state: "idle", step: null });
    // R7U-01: attached HERE, at the one place every terminal outcome returns
    // through, rather than at each of the eight call sites that build one. A
    // caller that forgot to add it would be a failed upgrade the loop never
    // learns about, and that is the whole defect — so there is nowhere to forget.
    // `run` is the fallback because a journal-uncertain outcome reports the row
    // it transitioned rather than the row the caller passed in.
    return Object.freeze({ ...outcome, durableOutcome: this.#durableOutcome(outcome?.run ?? run) });
  }

  /** R7U-01: the run's OWN state and code, taken from the row the transition
   * returned rather than restated from the outcome.
   *
   * The loop needs the run id and the runner's `detail.code` to record the
   * outcome durably, and both are facts about the ROW — restating them here
   * would be a second place they could disagree with the row the runner just
   * wrote. `succeeded` is included deliberately: it is the direction that CLOSES
   * an outstanding warning, so a successful run has to reach the same write as a
   * failed one or the earlier failure would stay published forever.
   *
   * `null` for anything else, including the transient statuses (`idle`,
   * `waiting`, `busy`, `error`) which name no run outcome to publish. */
  #durableOutcome(row) {
    const state = row?.state;
    if (!RUN_ATTENTION_STATES_V1.has(state)) return null;
    return Object.freeze({ state, runId: row.run_id,
      code: typeof row.detail?.code === "string" ? row.detail.code : null });
  }

  async runOnce({ onProgress } = {}) {
    if (this.#running) return { status: "busy", message: "Another updater call is active." };
    this.#running = true;
    let run;
    try {
      const acquisition = this.store.acquire
        ? await this.store.acquire(this.stateFiles.leaseToken)
        : { status: "acquired", run: await this.store.liveRun(), leaseToken: this.stateFiles.leaseToken };
      if (acquisition.status === "busy") return { status: "busy", liveRun: Boolean(acquisition.run),
        message: "An updater with another live database session owns the active run." };
      run = acquisition.run;
      if (!run) {
        this.onHeartbeatState({ state: "idle", step: null });
        return { status: "idle", message: "No approved update is active." };
      }
      if (run.lease_token !== acquisition.leaseToken) return { status: "busy", liveRun: true,
        message: "The active run lease could not be acquired." };
      this.onHeartbeatState({ state: "running", step: run.state });
      await onProgress?.(run);
      const reason = await this.stateFiles.refreshJournalHealth?.() ?? this.stateFiles.journalUncertain?.();
      if (reason) return this.#outcomeHeartbeat(await this.#journalUncertain(run, reason), run);
      return this.#outcomeHeartbeat(await this.#advance(run), run);
    } catch (error) {
      if (run && typeof error?.code === "string" && error.code.startsWith("updater_journal_")) {
        try { return this.#outcomeHeartbeat(await this.#journalUncertain(run, error.code), run); }
        catch (uncertainError) { error = uncertainError; }
      }
      // R7U-01 / LEAD DECISION 2: a runner error is PUBLISHED DURABLY, like
      // `needs_attention`, whenever there is a run to attribute it to.
      //
      // The reviewer's probe measured the gap on the merged tree's own terms: the
      // failing tick published `needs_attention`, and the NEXT tick — with the
      // runner idle — published `idle`, and `open_run_attention` had no row at
      // all. So the error reached the card for exactly as long as it took the loop
      // to ask again, which is the defect R7U-01 exists to end.
      //
      // `error` is the one `durableOutcome` state that is NOT a run state, and the
      // SQL function is written for that: it requires the run to be OPEN rather
      // than to BE in this state. A run that already finished is not one an error
      // can be attributed to — its own outcome is the fact, and a later failure
      // belongs to the next run.
      //
      // An error with NO live run carries no `durableOutcome`, because there is
      // nothing to attribute it to, and the loop keeps whatever the DATABASE
      // already answers. That is not a fallback for the common case: the run is
      // live in every one of the errors this branch can produce, because the
      // acquisition and the advance both happen inside the same `try`.
      const errorCode = typeof error?.code === "string" ? error.code : "updater_runner_error";
      const errorOutcome = Object.freeze({ status: "error", code: errorCode,
        message: "The updater hit an error and will retry from its durable step.",
        durableOutcome: run && typeof run.run_id === "string"
          ? Object.freeze({ state: "error", runId: run.run_id, code: errorCode })
          : null });
      // The heartbeat still records the error, as it did before, so the banner
      // and the alerts keep working exactly as they did.
      this.onHeartbeatState({ state: "uncertain", step: null });
      return errorOutcome;
    } finally { this.#running = false; }
  }

  /** Owner-gated recovery. The measurement port must establish one of the two
   * terminal observable states; a false, missing, or malformed answer leaves
   * both the rescue marker and the run uncertain. */
  async checkAndContinue({ source } = {}) {
    if (this.#running) return { status: "busy", message: "Another updater call is active." };
    this.#running = true;
    try {
      const run = await this.store.liveRun();
      const rescued = await this.stateFiles.hasRescueMarker(), journalUncertain = await this.stateFiles.journalUncertain?.();
      const journalRecoveryPending = await this.stateFiles.journalRecoveryPending?.();
      if (!run) {
        if (source !== "root") throw updaterRefuseV1("updater_web_rescue_clear_refused");
        if (!rescued && !journalUncertain && !journalRecoveryPending)
          throw updaterRefuseV1("updater_check_continue_refused");
        if (journalUncertain && !await this.stateFiles.repairJournalUncertain?.())
          throw updaterRefuseV1("updater_check_continue_refused");
        if (rescued) await this.stateFiles.removeRescueMarker();
        this.stateFiles.settleJournalRecovery?.();
        return { status: "idle", message: "The recovery status is cleared; no update is active." };
      }
      if (run.lease_token !== this.stateFiles.leaseToken)
        throw updaterRefuseV1("updater_check_continue_refused");
      if (run.state === "rollback_started" && !journalUncertain && !journalRecoveryPending) {
        const rollback = await this.#rollback(run, run.detail?.originalCode ?? "updater_resumed_failure");
        if (rollback.status === "rolled_back") {
          if (rescued) await this.stateFiles.removeRescueMarker();
          this.stateFiles.settleJournalRecovery?.();
        }
        return rollback;
      }
      if (!rescued && !journalUncertain && !journalRecoveryPending)
        throw updaterRefuseV1("updater_check_continue_refused");
      if (run.state !== "uncertain") throw updaterRefuseV1("updater_check_continue_refused");
      if (journalUncertain && !await this.stateFiles.repairJournalUncertain?.())
        throw updaterRefuseV1("updater_check_continue_refused");
      const measurement = await this.effects.measure(run);
      if (measurement?.state === "rollback_required") {
        const rollback = await this.#rollback(run, "updater_measurement_inconsistent");
        if (rollback.status === "rolled_back") {
          if (rescued) await this.stateFiles.removeRescueMarker();
          this.stateFiles.settleJournalRecovery?.();
        }
        return rollback;
      }
      if (!measurement || !["succeeded", "rolled_back"].includes(measurement.state))
        throw updaterRefuseV1("updater_measurement_refused");
      const settled = await this.#record(run, measurement.state, { measured: true, ...measurement.detail }, { terminal: true });
      if (rescued) await this.stateFiles.removeRescueMarker();
      this.stateFiles.settleJournalRecovery?.();
      return { status: measurement.state, run: settled, message: "The measured update state is recorded." };
    } finally { this.#running = false; }
  }
}

/** Dedicated heartbeat, deliberately independent of run-step progress. */
export class UpdaterHeartbeatV1 {
  #timer; #writing = false; #current;
  constructor({ store, stateFiles, bootId, leaseToken, report, intervalMs = 30_000, stopTimeoutMs = 1000, onError = () => {} }) {
    this.store = store; this.bootId = bootId; this.leaseToken = leaseToken; this.report = report;
    this.stateFiles = stateFiles; this.intervalMs = intervalMs; this.stopTimeoutMs = stopTimeoutMs; this.onError = onError;
  }
  async beat() {
    if (this.#writing) return false;
    this.#writing = true;
    this.#current = (async () => {
      const report = this.report();
      await this.stateFiles.writeHeartbeat({ bootId: this.bootId, leaseToken: this.leaseToken, ...report });
      await this.store.heartbeat({ bootId: this.bootId, leaseToken: this.leaseToken, ...report });
      return true;
    })();
    try { return await this.#current; }
    finally { this.#writing = false; this.#current = undefined; }
  }
  start() {
    if (!this.#timer) this.#timer = setInterval(() => void this.beat().catch(error => this.onError(error)), this.intervalMs);
    return this;
  }
  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    let timer;
    try { await Promise.race([this.#current, new Promise((_, reject) => {
      timer = setTimeout(() => reject(updaterRefuseV1("updater_heartbeat_stop_timeout")), this.stopTimeoutMs);
    })]); } catch (error) { this.onError(error); } finally { clearTimeout(timer); }
  }
}
