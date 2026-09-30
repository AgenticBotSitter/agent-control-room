import { parseSelfUpdateFlagV1, updaterRefuseV1 } from "./contracts.mjs";

const PRE_DRAIN_V1 = new Set(["approved", "prechecked", "staged", "quick_backup"]);
const TERMINAL_V1 = new Set(["succeeded", "rolled_back", "needs_attention", "refused"]);

const plainFailureV1 = Object.freeze({
  updater_precheck_refused: "The update could not be checked, so nothing was changed.",
  updater_referee_refused: "The running updater's rules refused this update, so nothing was changed.",
  updater_self_update_off: "Automatic updating is Off, so nothing was changed.",
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

  async #record(run, state, detail = {}, options = {}) {
    const events = await this.store.events(run.run_id);
    const ordinal = (events.at(-1)?.ordinal ?? 0) + 1;
    await this.journal.intent({ runId: run.run_id, ordinal, from: run.state, to: state, detail });
    const next = await this.store.transition(run.run_id, run.lease_token, state, detail, options);
    if (!options.terminal) await this.store.appendEvent(run.run_id, ordinal, state, detail);
    await this.journal.done({ runId: run.run_id, ordinal, state, detail });
    return next;
  }

  async #effect(run, name, nextState, effect, detail = {}) {
    const events = await this.store.events(run.run_id);
    const ordinal = (events.at(-1)?.ordinal ?? 0) + 1;
    await this.journal.intent({ runId: run.run_id, ordinal, from: run.state, to: nextState,
      detail: { ...detail, effect: name } });
    await effect(); // Every port method is required to be repeat-safe.
    const next = await this.store.transition(run.run_id, run.lease_token, nextState, detail);
    await this.store.appendEvent(run.run_id, ordinal, nextState, detail);
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
        message: "Control Room isn't sure the last update finished. Tap Check and continue." };
    }
    if (run.state === "uncertain" || run.state === "attended_upgrade_required")
      return { status: run.state, run, message: "Owner action is required before this run can continue." };
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
            const healthy = await this.effects.health(run);
            if (!healthy) throw updaterRefuseV1("updater_health_failed");
            run = await this.#record(run, "healthy");
            break;
          }
          case "healthy": {
            await this.effects.commitKnownGood(run);
            run = await this.#record(run, "succeeded", {}, { terminal: true });
            return { status: "succeeded", run, message: "Update installed and healthy." };
          }
          default: throw updaterRefuseV1("updater_run_state_unexpected");
        }
      }
      return { status: run.state, run, message: "The updater run is already finished." };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "updater_step_failed";
      if (PRE_DRAIN_V1.has(run.state)) {
        const refused = await this.#record(run, "refused", { code }, { terminal: true });
        return { status: "refused", code, run: refused,
          message: plainFailureV1[code] ?? "The update was refused before the switch. Nothing was changed." };
      }
      return this.#rollback(run, code);
    }
  }

  async #journalUncertain(run, reason) {
    if (run.state === "uncertain") return { status: "uncertain", run,
      message: "The updater journal is damaged. Tap Check and continue." };
    const uncertain = await this.store.transition(run.run_id, run.lease_token, "uncertain", { reason });
    return { status: "uncertain", code: reason, run: uncertain,
      message: "The updater journal is damaged. Tap Check and continue." };
  }

  #outcomeHeartbeat(outcome, run) {
    if (["waiting", "uncertain", "attended_upgrade_required"].includes(outcome.status))
      this.onHeartbeatState({ state: "awaiting_approval", step: outcome.run?.state ?? run.state });
    else if (outcome.status === "rolled_back") this.onHeartbeatState({ state: "rolled_back", step: null });
    else if (outcome.status === "needs_attention") this.onHeartbeatState({ state: "uncertain", step: null });
    else this.onHeartbeatState({ state: "idle", step: null });
    return outcome;
  }

  async runOnce() {
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
      const reason = await this.stateFiles.refreshJournalHealth?.() ?? this.stateFiles.journalUncertain?.();
      if (reason) return this.#outcomeHeartbeat(await this.#journalUncertain(run, reason), run);
      return this.#outcomeHeartbeat(await this.#advance(run), run);
    } catch (error) {
      if (run && typeof error?.code === "string" && error.code.startsWith("updater_journal_")) {
        try { return this.#outcomeHeartbeat(await this.#journalUncertain(run, error.code), run); }
        catch (uncertainError) { error = uncertainError; }
      }
      return { status: "error", code: typeof error?.code === "string" ? error.code : "updater_runner_error",
        message: "The updater hit an error and will retry from its durable step." };
    } finally { this.#running = false; }
  }

  /** Owner-gated recovery. The measurement port must establish one of the two
   * terminal observable states; a false, missing, or malformed answer leaves
   * both the rescue marker and the run uncertain. */
  async checkAndContinue() {
    if (this.#running) return { status: "busy", message: "Another updater call is active." };
    this.#running = true;
    try {
      const run = await this.store.liveRun();
      const rescued = await this.stateFiles.hasRescueMarker(), journalUncertain = await this.stateFiles.journalUncertain?.();
      const journalRecoveryPending = await this.stateFiles.journalRecoveryPending?.();
      if (!run || run.lease_token !== this.stateFiles.leaseToken || (!rescued && !journalUncertain && !journalRecoveryPending))
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
  constructor({ store, stateFiles, bootId, leaseToken, report, intervalMs = 30_000, onError = () => {} }) {
    this.store = store; this.bootId = bootId; this.leaseToken = leaseToken; this.report = report;
    this.stateFiles = stateFiles; this.intervalMs = intervalMs; this.onError = onError;
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
    try { await this.#current; } catch (error) { this.onError(error); }
  }
}
