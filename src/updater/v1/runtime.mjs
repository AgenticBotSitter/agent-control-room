import { lstat, readlink, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { parseSelfUpdateFlagV1, publicStatusV1, updaterRefuseV1 } from "./contracts.mjs";
export { FileStepJournalV1, RefusalAggregatorV1, reconcileJournalDisplayV1 } from "./journal.mjs";

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
    await unlink(`${this.root}/updater-state/rescued.json`);
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
  async readBackupSchedule() {
    let value;
    try {
      value = JSON.parse(await readFileNoFollowV1(this.root, "updater-state/backup-schedule.json", { maxBytes: 512 }));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw updaterRefuseV1("updater_backup_schedule_state_refused");
      throw error;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "nextWindowAt,schema"
        || value.schema !== "control-room.backup-schedule/v1"
        || typeof value.nextWindowAt !== "string" || !Number.isFinite(Date.parse(value.nextWindowAt)))
      throw updaterRefuseV1("updater_backup_schedule_state_refused");
    return Object.freeze({ nextWindowAt: value.nextWindowAt });
  }
  writeBackupSchedule(nextWindowAt) {
    if (typeof nextWindowAt !== "string" || !Number.isFinite(Date.parse(nextWindowAt)))
      throw updaterRefuseV1("updater_backup_schedule_state_refused");
    return atomicWriteNoFollowV1(this.root, "updater-state/backup-schedule.json", `${JSON.stringify({
      schema: "control-room.backup-schedule/v1", nextWindowAt,
    })}\n`);
  }
  async writeStatus(value) {
    await atomicWriteNoFollowV1(this.root, "status/status.json", `${JSON.stringify(publicStatusV1(value))}\n`,
      { mode: 0o644 });
  }
  async publicFacts() {
    let releaseId = null, updaterRestartsLastHour = 0;
    try {
      const target = await readlink(`${this.root}/current`);
      if (target.startsWith("/") || target.split("/").includes(".."))
        throw updaterRefuseV1("updater_current_link_refused");
      releaseId = basename(target);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    try {
      const guard = JSON.parse(await readFileNoFollowV1(this.root, "updater-state/guard-status.json",
        { maxBytes: 4096 }));
      if (guard?.schema !== "control-room.guard-status/v1" || !Number.isInteger(guard.updaterRestartsLastHour)
          || guard.updaterRestartsLastHour < 0 || guard.updaterRestartsLastHour > 3)
        throw updaterRefuseV1("updater_guard_status_refused");
      updaterRestartsLastHour = guard.updaterRestartsLastHour;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return { releaseId, updaterRestartsLastHour };
  }
}

/** The next 02:30 in the Mac's local timezone, strictly after `from`. */
export function nextBackupWindowV1(from) {
  if (!(from instanceof Date) || !Number.isFinite(from.getTime()))
    throw updaterRefuseV1("updater_backup_schedule_refused");
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 2, 30, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Runs backup work outside the updater tick. The root-held schedule marker is
 * the claim: it is advanced before a scheduled launch, so a restart or several
 * missed nights produce one catch-up run rather than a burst. A missing marker
 * is initialized only; startup itself never launches a backup.
 */
export class UpdaterBackupWorkerV1 {
  #running = null; #controller = null; #serial = Promise.resolve(); #startup = true;
  constructor({ backup, stateFiles, clock = () => new Date(), timeoutMs = 2 * 60 * 60_000 + 15 * 60_000,
    onError = () => {} }) {
    if (!backup || typeof backup.runOnce !== "function" || typeof backup.status !== "function"
        || !stateFiles?.readBackupSchedule || !stateFiles?.writeBackupSchedule
        || typeof clock !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000)
      throw updaterRefuseV1("updater_backup_worker_input_refused");
    this.backup = backup; this.stateFiles = stateFiles; this.clock = clock;
    this.timeoutMs = timeoutMs; this.onError = onError;
  }
  status() { return this.backup.status(); }
  #start(manual) {
    if (this.#running) return Object.freeze({ status: "busy" });
    const controller = new AbortController(); this.#controller = controller;
    const work = Promise.resolve().then(() => this.backup.runOnce({ manual, signal: controller.signal }));
    // Always observe the underlying work even when the timeout wins the race.
    work.catch(() => {});
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(updaterRefuseV1("updater_backup_worker_timeout"));
    }, this.timeoutMs); timer.unref?.(); });
    const running = Promise.race([work, timeout]).catch(error => { this.onError(error); return { status: "failed" }; })
      .finally(() => { clearTimeout(timer); if (this.#running === running) {
        this.#running = null; this.#controller = null;
      } });
    this.#running = running;
    return Object.freeze({ status: "started" });
  }
  runManual() { return this.#start(true); }
  cancel() { this.#controller?.abort(); }
  tick() {
    const claim = this.#serial.then(async () => {
      const now = this.clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        throw updaterRefuseV1("updater_backup_schedule_refused");
      const schedule = await this.stateFiles.readBackupSchedule();
      // Even an overdue marker never launches from startUpdaterV1's initial
      // tick. Roll it to the next 02:30; that next window performs one run.
      if (this.#startup) {
        this.#startup = false;
        if (schedule === null || Date.parse(schedule.nextWindowAt) <= now.getTime())
          await this.stateFiles.writeBackupSchedule(nextBackupWindowV1(now).toISOString());
        return Object.freeze({ status: "initialized" });
      }
      if (schedule === null) {
        await this.stateFiles.writeBackupSchedule(nextBackupWindowV1(now).toISOString());
        return Object.freeze({ status: "initialized" });
      }
      if (Date.parse(schedule.nextWindowAt) > now.getTime()) return Object.freeze({ status: "not_due" });
      // This write is the one-run-per-window claim. Advance from NOW rather than
      // the old marker so several missed nights collapse to one catch-up run.
      await this.stateFiles.writeBackupSchedule(nextBackupWindowV1(now).toISOString());
      return this.#start(false);
    });
    this.#serial = claim.catch(() => {});
    return claim;
  }
  async stop() {
    this.cancel();
    if (this.#running) await Promise.race([this.#running, new Promise(resolve => {
      const timer = setTimeout(resolve, 5_000); timer.unref?.();
    })]).catch(() => {});
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

const RISK_REDUCING_WHILE_OFF_V1 = new Set(["pause", "stop", "backup_now", "check_and_continue", "repair_serve"]);

export class UpdaterMainLoopV1 {
  #timer; #ticking = false;
  constructor({ runner, store, stateFiles, mode, ownerActions, watcher = null, alerts = null,
    alertFacts = async () => ({}), intervalMs = 5_000, onError = () => {}, backupWorker = null,
    backupUnavailable = false }) {
    this.runner = runner; this.store = store; this.stateFiles = stateFiles; this.mode = mode;
    this.backupWorker = backupWorker; this.backupUnavailable = backupUnavailable;
    this.ownerActions = ownerActions; this.watcher = watcher; this.alerts = alerts; this.alertFacts = alertFacts;
    this.intervalMs = intervalMs; this.onError = onError;
    this.lastOutcome = { status: "idle" };
  }
  async #requests(flag) {
    for (const request of await this.store.unhandledOwnerRequests()) {
      if (flag === "Off" && !RISK_REDUCING_WHILE_OFF_V1.has(request.request_kind)) {
        await this.store.finishOwnerRequest(request.id, "refused"); continue;
      }
      try {
        await this.ownerActions.handle({ ...request, source: "web" });
        await this.store.finishOwnerRequest(request.id, "acted");
      } catch { await this.store.finishOwnerRequest(request.id, "refused"); }
    }
  }
  async tick() {
    if (this.#ticking) return { status: "busy" };
    this.#ticking = true;
    try {
      const flag = parseSelfUpdateFlagV1(await this.stateFiles.readSelfUpdate());
      await this.#requests(flag);
      // R5iii: while Off, do not read approval rows, watch sources or invoke a
      // builder. Only timer work and risk-reducing owner requests run.
      if (flag === "On" && this.watcher) await this.watcher.tick();
      const rescued = await this.stateFiles.hasRescueMarker();
      if (rescued) {
        const measured = await this.runner.runOnce();
        this.lastOutcome = measured.status === "idle" ? { status: "uncertain",
          message: "A rescue occurred; owner review is required. If no update is running, clear the rescue on the Mac." }
          : measured;
      } else this.lastOutcome = flag === "Off" ? { status: "idle", message: "Self-update is Off." }
        : await this.runner.runOnce();
      const mode = await this.mode.read();
      const publicFacts = this.stateFiles.publicFacts ? await this.stateFiles.publicFacts() : {};
      const publicState = this.lastOutcome.status === "uncertain" ? "uncertain"
        : this.lastOutcome.status === "attended_upgrade_required" ? "attended_upgrade_required"
        : this.lastOutcome.status === "waiting" ? "awaiting_approval"
        : this.lastOutcome.status === "rolled_back" ? "rolled_back"
        : ["busy", "needs_attention", "error"].includes(this.lastOutcome.status) ? "needs_attention"
        : mode === "running" ? "idle" : mode;
      let backupStatus = null;
      if (this.backupWorker) {
        try { backupStatus = await this.backupWorker.status(); }
        catch (error) { this.onError(error); backupStatus = { fresh: false, badge: "missing", consecutiveFailures: 0 }; }
      } else if (this.backupUnavailable) backupStatus = { fresh: false, badge: "missing", consecutiveFailures: 0 };
      const backupFailed = backupStatus !== null && (backupStatus.consecutiveFailures > 0 || backupStatus.state === "failed");
      const backupMissing = backupStatus !== null && !backupFailed
        && (backupStatus.fresh !== true || ["missing", "never run"].includes(backupStatus.badge));
      const backupState = backupStatus === null ? undefined : backupFailed ? "failed" : backupMissing ? "missing" : "ok";
      await this.stateFiles.writeStatus({ ...publicFacts, state: publicState, backup: backupState,
        needsYou: ["busy", "uncertain", "attended_upgrade_required", "needs_attention", "error"]
          .includes(this.lastOutcome.status) || backupFailed || backupMissing,
      selfUpdate: flag });
      // TIMER work starts in its own bounded worker. Never await the backup
      // itself here: Pause, Stop, release work and alerts keep their 5s loop.
      if (this.backupWorker) {
        try { this.lastBackup = await this.backupWorker.tick(); }
        catch (error) { this.onError(error); }
      }
      if (this.alerts) {
        const facts = await this.alertFacts();
        if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw updaterRefuseV1("updater_alert_facts_refused");
        await this.alerts.reconcile({ ...facts, backupFailed: facts.backupFailed === true || backupFailed,
          backupMissing: facts.backupMissing === true || backupMissing,
          needsOwner: facts.needsOwner === true || this.lastOutcome.status === "needs_attention",
          uncertain: facts.uncertain === true || this.lastOutcome.status === "uncertain", rescue: facts.rescue === true || rescued });
        await this.alerts.tick();
      }
      return this.lastOutcome;
    } finally { this.#ticking = false; }
  }
  start() {
    if (!this.#timer) this.#timer = setInterval(() => void this.tick().catch(error => this.onError(error)), this.intervalMs);
    return this;
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
}

export function newUpdaterIdentityV1() {
  return Object.freeze({ bootId: `boot-${randomUUID()}`, leaseToken: `lease-${randomUUID()}` });
}
