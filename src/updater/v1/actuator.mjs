import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readlink, rename, rmdir, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeIdV1, updaterRefuseV1 } from "./contracts.mjs";
import { assertNoSymlinkBelowV1, atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { assertPairTargetsV1, pairV1, readKnownGoodPairsV1, readLivePairV1,
  recoverPairLinksV1, switchPairLinksV1 } from "./release-layout.mjs";
import { clearStagedReleaseV1, readStagedReleaseV1, writeStagedReleaseV1 } from "./staged-release.mjs";

const GIB_V1 = 1024 ** 3;
const RESERVE_BYTES_V1 = 2 * GIB_V1;
const RESTORE_SCHEMA_V1 = "control-room.restore-points/v1";

function isNoSpaceV1(error) { return error?.code === "ENOSPC" || error?.code === "EDQUOT"; }
function samePairV1(left, right) {
  return left.releaseId === right.releaseId && left.pgDataId === right.pgDataId
    && left.schemaDigest === right.schemaDigest;
}

async function syncDirectoryV1(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function removeTreeNoFollowV1(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) { await unlink(path); return; }
  for (const name of await readdir(path)) await removeTreeNoFollowV1(join(path, name));
  await rmdir(path);
}

function parseRestorePointsV1(value) {
  if (!value || value.schema !== RESTORE_SCHEMA_V1 || !Array.isArray(value.pairs)
      || value.count !== value.pairs.length || value.pairs.length > 32)
    throw updaterRefuseV1("updater_restore_points_refused");
  return Object.freeze(value.pairs.map(item => pairV1(item, "updater_restore_points_refused")));
}

async function readRestorePointsV1(root) {
  try {
    return parseRestorePointsV1(JSON.parse(await readFileNoFollowV1(root, "updater-state/restore-points.json",
      { maxBytes: 32_768 })));
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    if (error instanceof SyntaxError) throw updaterRefuseV1("updater_restore_points_refused");
    throw error;
  }
}

async function writePairsV1(root, relative, schema, pairs) {
  await atomicWriteNoFollowV1(root, relative, `${JSON.stringify({ schema, count: pairs.length, pairs })}\n`);
}

export class PairHistoryV1 {
  constructor(root) { this.root = root; }
  knownGood() { return readKnownGoodPairsV1(this.root); }
  restorePoints() { return readRestorePointsV1(this.root); }

  async appendKnownGood(value) {
    const pair = pairV1(value), existing = await this.knownGood();
    const pairs = [...existing.filter(item => !samePairV1(item, pair)), pair].slice(-3);
    await writePairsV1(this.root, "updater-state/known-good", "control-room.known-good/v1", pairs);
    return Object.freeze(pairs);
  }

  async recordDatabaseSuccess({ installed, from, n1Compatible }) {
    const next = pairV1(installed), previous = pairV1(from);
    const [known, restore] = await Promise.all([this.knownGood(), this.restorePoints()]);
    const oldData = known.filter(item => item.pgDataId !== next.pgDataId);
    const retained = [...restore, ...oldData].filter((item, index, all) =>
      all.findIndex(other => samePairV1(other, item)) === index);
    const automatic = [next];
    if (n1Compatible === true) automatic.unshift({ ...previous, pgDataId: next.pgDataId,
      schemaDigest: next.schemaDigest });
    await writePairsV1(this.root, "updater-state/restore-points.json", RESTORE_SCHEMA_V1, retained);
    await writePairsV1(this.root, "updater-state/known-good", "control-room.known-good/v1", automatic.slice(-3));
    return { knownGood: automatic.slice(-3), restorePoints: retained };
  }
}

export class DiskReserveV1 {
  constructor(root, { reserveBytes = RESERVE_BYTES_V1, minimumHeadroomBytes = GIB_V1,
    diskFree = async path => { const value = await statfs(path); return Number(value.bavail) * Number(value.bsize); },
    createReserve, onDepleted = async () => {} } = {}) {
    this.root = root; this.reserveBytes = reserveBytes; this.minimumHeadroomBytes = minimumHeadroomBytes;
    this.diskFree = diskFree; this.createReserve = createReserve ?? (() => this.#writeReserve());
    this.onDepleted = onDepleted;
  }

  async #writeReserve() {
    const path = join(this.root, "rescue-reserve.bin"), handle = await open(path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const block = Buffer.alloc(Math.min(this.reserveBytes, 8 * 1024 * 1024));
    try {
      let remaining = this.reserveBytes;
      while (remaining > 0) { const bytes = Math.min(remaining, block.length); await handle.write(block, 0, bytes); remaining -= bytes; }
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectoryV1(this.root);
  }

  async assertIntact() {
    await assertNoSymlinkBelowV1(this.root, "rescue-reserve.bin");
    const entry = await lstat(join(this.root, "rescue-reserve.bin"));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size !== this.reserveBytes
        || Number(entry.blocks) * 512 < this.reserveBytes)
      throw updaterRefuseV1("updater_rescue_reserve_refused");
    return entry;
  }

  async preflight({ releaseBytes, databaseBytes = 0, databasePlan = false }) {
    if (!Number.isSafeInteger(releaseBytes) || releaseBytes < 1 || !Number.isSafeInteger(databaseBytes)
        || databaseBytes < 0) throw updaterRefuseV1("updater_disk_measurement_refused");
    await this.assertIntact();
    const required = 2 * releaseBytes + (databasePlan ? 3 * databaseBytes : 0) + this.minimumHeadroomBytes;
    if (!Number.isSafeInteger(required)) throw updaterRefuseV1("updater_disk_measurement_refused");
    const free = await this.diskFree(this.root);
    if (!Number.isSafeInteger(free) || free < required) throw updaterRefuseV1("updater_disk_reserve_low");
    return Object.freeze({ freeBytes: free, requiredBytes: required });
  }

  async #reportDepleted(error) {
    try { await this.onDepleted(error); } catch { /* notification is best-effort */ }
  }

  async finishWithReserve(operation) {
    try { return await operation(); }
    catch (error) {
      if (!isNoSpaceV1(error)) throw error;
      await this.assertIntact();
      await unlink(join(this.root, "rescue-reserve.bin"));
      await syncDirectoryV1(this.root);
      let result;
      try { result = await operation(); }
      catch (retryError) {
        if (isNoSpaceV1(retryError)) await this.#reportDepleted(retryError);
        try { await this.createReserve(); await this.assertIntact(); }
        catch (reserveError) { await this.#reportDepleted(reserveError); }
        throw retryError;
      }
      try { await this.createReserve(); await this.assertIntact(); }
      catch (reserveError) {
        if (!isNoSpaceV1(reserveError)) throw reserveError;
        await this.#reportDepleted(reserveError);
      }
      return result;
    }
  }
}

function planFromRunV1(run) {
  const detail = run?.detail?.actuator ?? run?.detail;
  if (!detail || typeof detail !== "object") throw updaterRefuseV1("updater_actuator_plan_refused");
  const from = pairV1(detail.from, "updater_actuator_plan_refused");
  const to = pairV1(detail.to, "updater_actuator_plan_refused");
  const releaseBytes = detail.releaseBytes;
  const databaseBytes = detail.databaseBytes ?? 0;
  if (!Number.isSafeInteger(releaseBytes) || releaseBytes < 1 || !Number.isSafeInteger(databaseBytes)
      || databaseBytes < 0 || !["none", "additive"].includes(detail.databaseClass ?? "none"))
    throw updaterRefuseV1("updater_actuator_plan_refused");
  const rawRunId = typeof run.run_id === "string" ? run.run_id : "";
  if (rawRunId.length < 1 || rawRunId.length > 240 || /[\0\r\n]/u.test(rawRunId))
    throw updaterRefuseV1("updater_actuator_plan_refused");
  const operationId = /^[A-Za-z0-9._-]{1,80}$/u.test(rawRunId) ? rawRunId
    : `run-${createHash("sha256").update(rawRunId).digest("hex").slice(0, 40)}`;
  return Object.freeze({ operationId: assertSafeIdV1(operationId, "updater_actuator_plan_refused"), from, to,
    releaseBytes, databaseBytes, databaseClass: detail.databaseClass ?? "none" });
}

/** Filesystem actuator for item 13. Service lifecycle, artifact unpack and
 * health are narrow injected ports so this root code never executes release
 * code and tests never touch the live installation. */
export class UpdaterActuatorV1 {
  #switching = false;
  constructor({ root, services, artifacts, health, schemaDigest, reserve = new DiskReserveV1(root),
    history = new PairHistoryV1(root), fault }) {
    this.root = root; this.services = services; this.artifacts = artifacts; this.healthProbe = health;
    this.schemaDigest = schemaDigest; this.reserve = reserve; this.history = history; this.fault = fault;
  }

  async recover() { return recoverPairLinksV1(this.root, { fault: this.fault,
    databaseStopped: move => this.services.databaseStopped?.(undefined, move) }); }

  async #exclusive(operation) {
    if (this.#switching) throw updaterRefuseV1("updater_actuator_busy");
    this.#switching = true;
    try { return await operation(); } finally { this.#switching = false; }
  }

  async precheck(run) {
    const plan = planFromRunV1(run), digest = await this.schemaDigest();
    const live = await readLivePairV1(this.root, digest);
    if (!samePairV1(live, plan.from)) throw updaterRefuseV1("updater_live_pair_moved");
    await this.reserve.preflight({ releaseBytes: plan.releaseBytes, databaseBytes: plan.databaseBytes,
      databasePlan: plan.databaseClass !== "none" });
    await this.artifacts.verifySource(run, plan);
  }

  async stage(run) {
    const plan = planFromRunV1(run), releases = join(this.root, "releases");
    await assertNoSymlinkBelowV1(this.root, "releases");
    const final = join(releases, plan.to.releaseId), staging = join(releases, `.staging-${plan.to.releaseId}`);
    try {
      const entry = await lstat(final);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw updaterRefuseV1("updater_release_target_refused");
      await this.artifacts.verifyRelease(run, final, plan);
      await writeStagedReleaseV1(this.root, plan.to.releaseId);
      return { replayed: true };
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await this.reserve.preflight({ releaseBytes: plan.releaseBytes, databaseBytes: plan.databaseBytes,
      databasePlan: plan.databaseClass !== "none" });
    try { await removeTreeNoFollowV1(staging); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await mkdir(staging, { mode: 0o700 });
    try {
      await this.artifacts.unpackRelease(run, staging, plan);
      await this.artifacts.verifyRelease(run, staging, plan);
      await writeStagedReleaseV1(this.root, plan.to.releaseId);
      await rename(staging, final); await syncDirectoryV1(releases);
      return { replayed: false };
    } catch (error) {
      try { await removeTreeNoFollowV1(staging); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; }
      await clearStagedReleaseV1(this.root, plan.to.releaseId);
      throw error;
    }
  }

  quickBackup(run) { return this.services.quickBackup(run); }
  drain(run) { return this.services.drain(run); }

  async switchPair(run) {
    return this.#exclusive(async () => {
      const plan = planFromRunV1(run);
      if (plan.from.pgDataId !== plan.to.pgDataId
          && await this.services.databaseStopped?.(run, plan) !== true)
        throw updaterRefuseV1("updater_database_not_stopped");
      return await switchPairLinksV1({ root: this.root, operationId: plan.operationId, from: plan.from, to: plan.to,
        previousReleaseId: plan.from.releaseId, fault: this.fault });
    });
  }

  restart(run) { return this.services.restart(run); }
  async health(run) {
    const pair = planFromRunV1(run).to;
    return typeof this.healthProbe === "function" ? this.healthProbe(run, pair)
      : this.healthProbe.fullHealth(await this.healthProbe.expectationForRun(run, pair));
  }
  async commitKnownGood(run) { return this.history.appendKnownGood(planFromRunV1(run).to); }
  measure(run) { return this.services.measure(run); }

  async rollback(run) {
    const plan = planFromRunV1(run), liveDigest = await this.schemaDigest();
    const live = await readLivePairV1(this.root, liveDigest), pairs = [...await this.history.knownGood()].reverse();
    let lastCode = "updater_rollback_chain_exhausted";
    for (const candidate of pairs) {
      if (candidate.pgDataId !== live.pgDataId || candidate.schemaDigest !== live.schemaDigest
          || candidate.releaseId === live.releaseId) continue;
      try {
        await assertPairTargetsV1(this.root, candidate);
        if (!await this.artifacts.verifyPair(candidate)) { lastCode = "updater_rollback_pair_corrupt"; continue; }
        const rollbackFrom = await readLivePairV1(this.root, await this.schemaDigest());
        await this.reserve.finishWithReserve(async () => {
          await switchPairLinksV1({ root: this.root,
            operationId: `${plan.operationId}.rollback.${candidate.releaseId}`, from: rollbackFrom,
            to: candidate, previousReleaseId: live.releaseId, fault: this.fault });
          await this.services.restart(run);
        });
        const healthy = typeof this.healthProbe === "function" ? await this.healthProbe(run, candidate)
          : await this.healthProbe.fullHealth(await this.healthProbe.expectationForRun(run, candidate));
        if (healthy) return candidate;
        lastCode = "updater_rollback_pair_unhealthy";
      } catch (error) {
        if (isNoSpaceV1(error)) throw error;
        lastCode = typeof error?.code === "string" ? error.code : "updater_rollback_pair_failed";      }
      throw updaterRefuseV1(lastCode);
    });
  }
}

export async function collectOldReleasesV1(root, { keep = 5, openStagingReleaseIds = [] } = {}) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw updaterRefuseV1("updater_retention_refused");
  const history = new PairHistoryV1(root), [known, restore] = await Promise.all([
    history.knownGood(), history.restorePoints(),
  ]);
  const protectedIds = new Set([...known, ...restore].map(pair => pair.releaseId));
  const stagedReleaseId = await readStagedReleaseV1(root);
  if (stagedReleaseId) protectedIds.add(stagedReleaseId);
  for (const link of ["current", "previous"]) {
    try {
      const entry = await lstat(join(root, link));
      if (!entry.isSymbolicLink()) throw updaterRefuseV1("updater_retention_refused");
      const target = await readlink(join(root, link));
      if (!/^releases\/[A-Za-z0-9._-]{1,80}$/u.test(target)) throw updaterRefuseV1("updater_retention_refused");
      protectedIds.add(target.slice("releases/".length));
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const openStaging = new Set(openStagingReleaseIds.map(id => assertSafeIdV1(id, "updater_retention_refused")));
  for (const id of openStaging) protectedIds.add(id);
  const releasesPath = await assertNoSymlinkBelowV1(root, "releases"), entries = [];
  for (const name of await readdir(releasesPath)) {
    const entry = await lstat(join(releasesPath, name));
    if (entry.isSymbolicLink()) throw updaterRefuseV1("updater_retention_symlink_refused");
    if (!entry.isDirectory()) continue;
    if (name.startsWith(".staging-")) {
      const id = assertSafeIdV1(name.slice(".staging-".length), "updater_retention_refused");
      entries.push({ name, id, mtimeMs: entry.mtimeMs, protected: openStaging.has(id) }); continue;
    }
    assertSafeIdV1(name, "updater_retention_refused");
    entries.push({ name, id: name, mtimeMs: entry.mtimeMs, protected: protectedIds.has(name) });
  }
  const removable = entries.filter(item => !item.protected).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const removed = [];
  while (entries.length - removed.length > keep && removable.length > 0) {
    const item = removable.shift(); await removeTreeNoFollowV1(join(releasesPath, item.name)); removed.push(item.name);
  }
  if (removed.length > 0) await syncDirectoryV1(releasesPath);
  return Object.freeze(removed);
}

export { RESERVE_BYTES_V1 };
