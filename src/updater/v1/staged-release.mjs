import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeIdV1, updaterRefuseV1 } from "./contracts.mjs";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";

const STAGED_RELEASE_SCHEMA_V1 = "control-room.staged-release/v1";

async function syncDirectoryV1(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function parseStagedReleaseV1(value) {
  if (!value || value.schema !== STAGED_RELEASE_SCHEMA_V1)
    throw updaterRefuseV1("updater_staged_release_refused");
  return assertSafeIdV1(value.releaseId, "updater_staged_release_refused");
}

export async function readStagedReleaseV1(root) {
  try {
    return parseStagedReleaseV1(JSON.parse(await readFileNoFollowV1(root, "updater-state/staged-release",
      { maxBytes: 4096 })));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw updaterRefuseV1("updater_staged_release_refused");
    throw error;
  }
}

export async function writeStagedReleaseV1(root, releaseId) {
  const value = { schema: STAGED_RELEASE_SCHEMA_V1,
    releaseId: assertSafeIdV1(releaseId, "updater_staged_release_refused") };
  await atomicWriteNoFollowV1(root, "updater-state/staged-release", `${JSON.stringify(value)}\n`);
}

export async function clearStagedReleaseV1(root, releaseId) {
  const expected = assertSafeIdV1(releaseId, "updater_staged_release_refused");
  if (await readStagedReleaseV1(root) !== expected) return false;
  await unlink(join(root, "updater-state/staged-release"));
  await syncDirectoryV1(join(root, "updater-state"));
  return true;
}
