import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeIdV1, parseKnownGoodV1, updaterRefuseV1 } from "./contracts.mjs";
import { assertNoSymlinkBelowV1, atomicSymlinkNoFollowV1, atomicWriteNoFollowV1,
  readFileNoFollowV1 } from "./fs-safety.mjs";
import { clearStagedReleaseV1 } from "./staged-release.mjs";

const SWITCH_SCHEMA_V1 = "control-room.pair-link-switch/v1";
const PHASES_V1 = Object.freeze([
  "prepared", "previous_intent", "previous_done", "database_intent", "database_done",
  "release_intent", "release_done", "completed", "rollback_intent", "rolled_back",
]);

export function pairV1(value, code = "updater_pair_refused") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw updaterRefuseV1(code);
  const schemaDigest = typeof value.schemaDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.schemaDigest)
    ? value.schemaDigest : undefined;
  if (!schemaDigest) throw updaterRefuseV1(code);
  return Object.freeze({ releaseId: assertSafeIdV1(value.releaseId, code),
    pgDataId: assertSafeIdV1(value.pgDataId, code), schemaDigest });
}

function samePairV1(left, right) {
  return left.releaseId === right.releaseId && left.pgDataId === right.pgDataId
    && left.schemaDigest === right.schemaDigest;
}

async function assertDirectoryTargetV1(root, relative, code) {
  try {
    const path = await assertNoSymlinkBelowV1(root, relative);
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw updaterRefuseV1(code);
  } catch (error) {
    if (error?.code === "ENOENT") throw updaterRefuseV1(code);
    throw error;
  }
}

export async function assertPairTargetsV1(root, value) {
  const pair = pairV1(value);
  await assertDirectoryTargetV1(root, `releases/${pair.releaseId}`, "updater_release_target_refused");
  await assertDirectoryTargetV1(root, `pg/data-${pair.pgDataId}`, "updater_pg_target_refused");
  return pair;
}

async function readBoundedLinkV1(root, relative, prefix, code) {
  const path = join(root, relative);
  await assertNoSymlinkBelowV1(root, relative.split("/").slice(0, -1).join("/") || ".");
  const entry = await lstat(path);
  if (!entry.isSymbolicLink()) throw updaterRefuseV1(code);
  const target = await readlink(path);
  if (!target.startsWith(prefix) || target.slice(prefix.length).includes("/")
      || !/^[A-Za-z0-9._-]{1,80}$/u.test(target.slice(prefix.length))) throw updaterRefuseV1(code);
  await assertDirectoryTargetV1(root, `${relative.includes("/") ? "pg/" : ""}${target}`, code);
  return target.slice(prefix.length);
}

export async function readLivePairV1(root, schemaDigest) {
  if (typeof schemaDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(schemaDigest))
    throw updaterRefuseV1("updater_schema_digest_refused");
  const [releaseId, pgDataId] = await Promise.all([
    readBoundedLinkV1(root, "current", "releases/", "updater_current_link_refused"),
    readBoundedLinkV1(root, "pg/current", "data-", "updater_pg_link_refused"),
  ]);
  return Object.freeze({ releaseId, pgDataId, schemaDigest });
}

function parseSwitchV1(value) {
  if (!value || value.schema !== SWITCH_SCHEMA_V1 || !PHASES_V1.includes(value.phase))
    throw updaterRefuseV1("updater_link_switch_refused");
  const operationId = assertSafeIdV1(value.operationId, "updater_link_switch_refused");
  const from = pairV1(value.from, "updater_link_switch_refused");
  const to = pairV1(value.to, "updater_link_switch_refused");
  const previousReleaseId = assertSafeIdV1(value.previousReleaseId, "updater_link_switch_refused");
  return Object.freeze({ schema: SWITCH_SCHEMA_V1, operationId, phase: value.phase, from, to,
    previousReleaseId });
}

async function readSwitchV1(root) {
  try {
    return parseSwitchV1(JSON.parse(await readFileNoFollowV1(root, "updater-state/link-switch.json",
      { maxBytes: 16_384 })));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw updaterRefuseV1("updater_link_switch_refused");
    throw error;
  }
}

async function writeSwitchV1(root, value, phase, fault) {
  const next = { ...value, phase };
  await atomicWriteNoFollowV1(root, "updater-state/link-switch.json", `${JSON.stringify(next)}\n`);
  await fault?.(`after_${phase}`);
  return next;
}

async function completeForwardV1(root, initial, fault, beforeDatabaseMove) {
  let record = initial;
  if (["prepared", "previous_intent"].includes(record.phase)) {
    record = await writeSwitchV1(root, record, "previous_intent", fault);
    await atomicSymlinkNoFollowV1(root, "previous", `releases/${record.previousReleaseId}`);
    await fault?.("after_previous_effect");
    record = await writeSwitchV1(root, record, "previous_done", fault);
  }
  if (["previous_done", "database_intent"].includes(record.phase)) {
    record = await writeSwitchV1(root, record, "database_intent", fault);
    await beforeDatabaseMove?.(record.to.pgDataId, "forward");
    await atomicSymlinkNoFollowV1(root, "pg/current", `data-${record.to.pgDataId}`);
    await fault?.("after_database_effect");
    record = await writeSwitchV1(root, record, "database_done", fault);
  }
  if (["database_done", "release_intent"].includes(record.phase)) {
    record = await writeSwitchV1(root, record, "release_intent", fault);
    await atomicSymlinkNoFollowV1(root, "current", `releases/${record.to.releaseId}`);
    await fault?.("after_release_effect");
    record = await writeSwitchV1(root, record, "release_done", fault);
  }
  if (record.phase === "release_done") record = await writeSwitchV1(root, record, "completed", fault);
  if (record.phase !== "completed") throw updaterRefuseV1("updater_link_switch_refused");
  await clearStagedReleaseV1(root, record.to.releaseId);
  return record;
}

async function rollBackInterruptedV1(root, initial, fault, beforeDatabaseMove) {
  let record = await writeSwitchV1(root, initial, "rollback_intent", fault);
  await beforeDatabaseMove?.(record.from.pgDataId, "rollback");
  await atomicSymlinkNoFollowV1(root, "pg/current", `data-${record.from.pgDataId}`);
  await atomicSymlinkNoFollowV1(root, "current", `releases/${record.from.releaseId}`);
  await atomicSymlinkNoFollowV1(root, "previous", `releases/${record.previousReleaseId}`);
  record = await writeSwitchV1(root, record, "rolled_back", fault);
  await clearStagedReleaseV1(root, record.to.releaseId);
  return record;
}

async function readCurrentPgDataIdV1(root) {
  await assertNoSymlinkBelowV1(root, "pg");
  const entry = await lstat(join(root, "pg/current"));
  if (!entry.isSymbolicLink()) throw updaterRefuseV1("updater_pg_link_refused");
  const target = await readlink(join(root, "pg/current"));
  if (!/^data-[A-Za-z0-9._-]{1,80}$/u.test(target)) throw updaterRefuseV1("updater_pg_link_refused");
  return target.slice("data-".length);
}

async function assertRecoveryDatabaseStoppedV1(root, record, nextPgDataId, direction, databaseStopped) {
  let currentPgDataId;
  try { currentPgDataId = await readCurrentPgDataIdV1(root); }
  catch (error) { if (error?.code !== "ENOENT") throw error; return; }
  if (currentPgDataId === nextPgDataId) return;
  try {
    const pidPath = await assertNoSymlinkBelowV1(root, `pg/data-${currentPgDataId}/postmaster.pid`,
      { allowMissingLeaf: true });
    await lstat(pidPath);
    throw updaterRefuseV1("updater_database_not_stopped");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const move = Object.freeze({ operationId: record.operationId, direction, fromPgDataId: currentPgDataId,
    toPgDataId: nextPgDataId });
  if (await databaseStopped?.(move) !== true) throw updaterRefuseV1("updater_database_not_stopped");
}

/** Durable pair transaction adapted from cook/deploylinks. Previous is made
 * recoverable first, database and code targets are individually atomically
 * replaced, and the root-only record makes a torn set deterministic. Services
 * must be stopped while a database target changes. */
export async function switchPairLinksV1({ root, operationId, from, to, previousReleaseId = from?.releaseId,
  fault }) {
  assertSafeIdV1(operationId, "updater_link_switch_refused");
  const source = await assertPairTargetsV1(root, from), target = await assertPairTargetsV1(root, to);
  assertSafeIdV1(previousReleaseId, "updater_link_switch_refused");
  await assertDirectoryTargetV1(root, `releases/${previousReleaseId}`, "updater_release_target_refused");
  const existing = await readSwitchV1(root);
  if (existing && !["completed", "rolled_back"].includes(existing.phase)
      && (existing.operationId !== operationId || !samePairV1(existing.from, source)
        || !samePairV1(existing.to, target))) throw updaterRefuseV1("updater_link_switch_busy");
  if (existing?.operationId === operationId) {
    if (!samePairV1(existing.from, source) || !samePairV1(existing.to, target)
        || existing.previousReleaseId !== previousReleaseId) throw updaterRefuseV1("updater_link_switch_refused");
    if (existing.phase === "completed") {
      await clearStagedReleaseV1(root, existing.to.releaseId);
      return { pair: target, replayed: true };
    }
    if (existing.phase === "rolled_back") throw updaterRefuseV1("updater_link_switch_rolled_back");
    await completeForwardV1(root, existing, fault);
    return { pair: target, replayed: true };
  }
  const prepared = await writeSwitchV1(root, { schema: SWITCH_SCHEMA_V1, operationId, from: source, to: target,
    previousReleaseId }, "prepared", fault);
  await completeForwardV1(root, prepared, fault);
  return { pair: target, replayed: false };
}

/** On startup, an incomplete record resumes only while both target members are
 * still valid. A missing/corrupt target restores the recorded source pair. */
export async function recoverPairLinksV1(root, { fault, databaseStopped } = {}) {
  try {
    await readFileNoFollowV1(root, "updater-state/rescued.json", { maxBytes: 16_384 });
    return { status: "uncertain", reason: "rescue_marker" };
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const record = await readSwitchV1(root);
  if (!record) return { status: "none" };
  if (["completed", "rolled_back"].includes(record.phase)) {
    await clearStagedReleaseV1(root, record.to.releaseId);
    return { status: record.phase };
  }
  const beforeDatabaseMove = (nextPgDataId, direction) =>
    assertRecoveryDatabaseStoppedV1(root, record, nextPgDataId, direction, databaseStopped);
  try {
    await assertPairTargetsV1(root, record.to);
    await completeForwardV1(root, record, fault, beforeDatabaseMove);
    return { status: "completed", pair: record.to };
  } catch (error) {
    if (!["updater_release_target_refused", "updater_pg_target_refused"].includes(error?.code)) throw error;
    await assertPairTargetsV1(root, record.from);
    await rollBackInterruptedV1(root, record, fault, beforeDatabaseMove);
    return { status: "rolled_back", pair: record.from, reason: error.code };
  }
}

export async function readKnownGoodPairsV1(root) {
  try {
    return parseKnownGoodV1(JSON.parse(await readFileNoFollowV1(root, "updater-state/known-good",
      { maxBytes: 32_768 }))).pairs;
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    if (error instanceof SyntaxError) throw updaterRefuseV1("updater_known_good_refused");
    throw error;
  }
}
