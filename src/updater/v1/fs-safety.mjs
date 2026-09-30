import { constants } from "node:fs";
import { chmod, lchown, lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { updaterRefuseV1 } from "./contracts.mjs";

function boundedRelativeV1(root, candidate) {
  if (typeof root !== "string" || typeof candidate !== "string" || !isAbsolute(root))
    throw updaterRefuseV1("updater_path_refused");
  const absolute = resolve(root, candidate);
  const rel = relative(resolve(root), absolute);
  if (rel === "" || rel === ".") return { absolute, parts: [] };
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw updaterRefuseV1("updater_path_refused");
  return { absolute, parts: rel.split(sep) };
}

/** Refuse every symlink below the root-owned boundary. The boundary itself is
 * supplied by trusted configuration and is checked separately by the installer. */
export async function assertNoSymlinkBelowV1(root, candidate, { allowMissingLeaf = false } = {}) {
  const { absolute, parts } = boundedRelativeV1(root, candidate);
  let current = resolve(root);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error?.code === "ENOENT") return absolute;
      throw error;
    }
    if (entry.isSymbolicLink()) throw updaterRefuseV1("updater_symlink_refused");
  }
  return absolute;
}

export async function openNoFollowV1(root, candidate, flags = constants.O_RDONLY, mode = 0o600) {
  const path = await assertNoSymlinkBelowV1(root, candidate);
  return open(path, flags | (constants.O_NOFOLLOW ?? 0), mode);
}

export async function readFileNoFollowV1(root, candidate, { maxBytes = 1024 * 1024 } = {}) {
  const handle = await openNoFollowV1(root, candidate, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > maxBytes || entry.nlink !== 1) throw updaterRefuseV1("updater_file_refused");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

/** Atomic, fsynced replacement that never opens a caller-planted symlink. */
export async function atomicWriteNoFollowV1(root, candidate, contents, { mode = 0o600 } = {}) {
  const { absolute } = boundedRelativeV1(root, candidate);
  const parent = dirname(absolute);
  await assertNoSymlinkBelowV1(root, parent);
  try {
    const existing = await lstat(absolute);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)
      throw updaterRefuseV1("updater_file_refused");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(parent, { recursive: false }).catch(error => { if (error?.code !== "EEXIST") throw error; });
  const temporary = join(parent, `.${absolute.slice(parent.length + 1)}.${process.pid}.${randomBytes(8).toString("hex")}`);
  const tempRelative = relative(root, temporary);
  const handle = await openNoFollowV1(root, tempRelative,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode).catch(async error => {
      if (error?.code === "ENOENT") {
        // The leaf is intentionally absent. The parent walk above is the race
        // fence and O_EXCL|O_NOFOLLOW is the leaf fence.
        return open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0), mode);
      }
      throw error;
    });
  try { await handle.writeFile(contents); await handle.sync(); } catch (error) { await handle.close(); throw error; }
  await handle.close();
  await chmod(temporary, mode);
  await rename(temporary, absolute);
  const directory = await open(parent, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function lchownNoFollowV1(root, candidate, uid, gid) {
  const path = await assertNoSymlinkBelowV1(root, candidate);
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw updaterRefuseV1("updater_symlink_refused");
  await lchown(path, uid, gid);
}
