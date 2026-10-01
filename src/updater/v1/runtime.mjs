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
  constructor({ runner, store, stateFiles, mode, ownerActions, watcher = null, intervalMs = 5_000, onError = () => {} }) {
    this.runner = runner; this.store = store; this.stateFiles = stateFiles; this.mode = mode;
    this.ownerActions = ownerActions; this.watcher = watcher; this.intervalMs = intervalMs; this.onError = onError;
    this.lastOutcome = { status: "idle" };
  }
  async #requests(flag) {
    for (const request of await this.store.unhandledOwnerRequests()) {
      if (flag === "Off" && !RISK_REDUCING_WHILE_OFF_V1.has(request.request_kind)) {
        await this.store.finishOwnerRequest(request.id, "refused"); continue;
      }
      try {
        await this.ownerActions.handle(request);
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
          message: "A rescue occurred; owner review is required." } : measured;
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
      await this.stateFiles.writeStatus({ ...publicFacts, state: publicState,
        needsYou: ["busy", "uncertain", "attended_upgrade_required", "needs_attention", "error"]
          .includes(this.lastOutcome.status),
      selfUpdate: flag });
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
