import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { acquireKernelFileLockV1 } from "../../installer/shared/private-process-lock.mjs";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { updaterRefuseV1 } from "./contracts.mjs";

export const ATTENDED_LINKS_V1 = Object.freeze([
  "updater/current", "runtime/node-current", "runtime/pnpm-current", "runtime/pg-current", "runtime/esbuild-current",
]);

// The guard uses this same kernel lock for each complete watch or rescue.
export async function withSelfUpgradeGuardV1(root, operation) {
  const lock = await acquireKernelFileLockV1(join(root, "updater-state/guard.lock"), { busyCode: "updater_flip_guard_busy" });
  try { return await operation(); } finally { await lock.release(); }
}

export async function noteSelfUpgradeHealthV1(root, expectedAttemptId) {
  return withSelfUpgradeGuardV1(root, async () => {
    let record;
    try { record = JSON.parse(await readFileNoFollowV1(root, "updater-state/selfupgrade.json", { maxBytes: 16_384 })); }
    catch (error) { if (error?.code === "ENOENT" && expectedAttemptId === undefined) return; throw error; }
    if (record?.schema !== "control-room.selfupgrade/v1" || record.phase !== "flipping"
      && !(record.phase === "settled" && record.reason === "updater_selfupgrade_healthy" && record.healthPassed === true)) {
      if (expectedAttemptId !== undefined) throw updaterRefuseV1("updater_flip_attempt_settled");
      return;
    }
    let active;
    try { active = JSON.parse(await readFileNoFollowV1(root, "updater-state/selfupgrade-attempt.json", { maxBytes: 4096 })); }
    catch (error) { if (expectedAttemptId === undefined) return; throw error; }
    if (active?.schema !== "control-room.selfupgrade-attempt/v1" || active.attemptId !== record.attemptId
      || active.bootId !== record.bootId || active.startedMono !== record.startedMono
      || expectedAttemptId !== undefined && record.attemptId !== expectedAttemptId) {
      if (expectedAttemptId === undefined) return;
      else throw updaterRefuseV1("updater_flip_attempt_settled");
    }
    if (!Array.isArray(record.links) || record.links.length < 1 || record.links.length > 5
      || record.links.length !== record.linkCount || new Set(record.links.map(item => item.link)).size !== record.links.length)
      throw updaterRefuseV1("updater_flip_links_refused");
    for (const item of record.links) {
      if (!ATTENDED_LINKS_V1.includes(item.link) || await readlink(join(root, item.link)) !== item.to)
        throw updaterRefuseV1("updater_flip_attempt_settled");
    }
    await atomicWriteNoFollowV1(root, "updater-state/selfupgrade.json", `${JSON.stringify({ ...record, healthPassed: true })}\n`);
  });
}
