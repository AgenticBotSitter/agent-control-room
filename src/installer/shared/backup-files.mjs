// Shared by the dependency-free nightly runner and operator entry points.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, parse } from "node:path";

const generations = new WeakMap();
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function inspectAncestors(out) {
  if (typeof out !== "string" || !isAbsolute(out) || resolve(out) !== out)
    throw new Error("backup_output_path_refused");
  let path = parse(out).root;
  for (const component of out.slice(path.length).split("/").slice(0, -1)) {
    path = join(path, component);
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("backup_output_path_refused");
  }
}

export async function reserveBackupGenerationV1(out) {
  await inspectAncestors(out);
  try { await mkdir(out, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error("backup_output_exists");
    throw new Error("backup_output_reservation_failed");
  }
  const token = Object.freeze({});
  generations.set(token, { out, entry: await lstat(out), consumed: false });
  return token;
}

// A reservation is an in-process capability, never a caller-supplied boolean
// permitting reuse. Only the wrapper/nightly runner that made it can hand it on.
export async function consumeBackupGenerationV1(out, token) {
  const generation = generations.get(token);
  if (!generation || generation.out !== out || generation.consumed)
    throw new Error("backup_output_reservation_refused");
  generation.consumed = true;
  await assertBackupGenerationV1(out, token);
  if ((await readdir(out)).length !== 0) throw new Error("backup_output_reservation_refused");
}

export async function assertBackupGenerationV1(out, token) {
  await inspectAncestors(out);
  const generation = generations.get(token), entry = await lstat(out);
  if (!generation || generation.out !== out || !entry.isDirectory() || entry.isSymbolicLink()
    || !same(entry, generation.entry) || (entry.mode & 0o777) !== 0o700)
    throw new Error("backup_output_reservation_refused");
}

export async function sha256BackupFileV1(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1) throw new Error("backup_file_refused");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !same(entry, before)) throw new Error("backup_file_refused");
    const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), current = await lstat(path);
    if (!same(before, current) || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) throw new Error("backup_file_changed");
    return `sha256:${digest.digest("hex")}`;
  } finally { await handle.close(); }
}
