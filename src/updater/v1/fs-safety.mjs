import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lchown, lstat, mkdir, open, readlink, rename, symlink, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { removeOwnedFileV1 } from "../../installer/shared/file-custody.mjs";
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
  let owned;
  try {
    owned = await handle.stat();
    await handle.writeFile(contents); await handle.sync();
    await handle.close();
    await chmod(temporary, mode);
    await rename(temporary, absolute);
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    try { await handle.close(); }
    finally { if (owned) await removeOwnedFileV1(temporary, owned); }
  }
}

export async function lchownNoFollowV1(root, candidate, uid, gid) {
  const path = await assertNoSymlinkBelowV1(root, candidate);
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw updaterRefuseV1("updater_symlink_refused");
  await lchown(path, uid, gid);
}

/** Atomically replaces one root-owned relative symlink. The caller validates
 * the semantic target; this helper supplies the R-FS path and durability
 * guarantees shared by release, database, updater and runtime link sets. */
export async function atomicSymlinkNoFollowV1(root, candidate, target) {
  if (typeof target !== "string" || target.length < 1 || target.length > 240 || isAbsolute(target)
      || target.includes("\0") || target.split(/[\\/]/u).includes(".."))
    throw updaterRefuseV1("updater_link_target_refused");
  const { absolute } = boundedRelativeV1(root, candidate);
  const parent = dirname(absolute);
  await assertNoSymlinkBelowV1(root, parent);
  try {
    const existing = await lstat(absolute);
    if (!existing.isSymbolicLink()) throw updaterRefuseV1("updater_link_refused");
    await readlink(absolute);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = join(parent, `.${basename(absolute)}.${process.pid}.${randomBytes(8).toString("hex")}.link`);
  await symlink(target, temporary);
  try { await rename(temporary, absolute); }
  finally { await unlink(temporary).catch(() => {}); }
  const directory = await open(parent, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

// macOS's kernel owns this lock, so SIGKILL, reboot and reused PIDs cannot
// strand it. Keep the inode permanently: unlinking a flock file would allow
// two different inodes to be locked under one name.
export async function acquireUpdaterLocalLockV1(root, relativePath, { waitMs = 0,
  busyCode = "updater_live_session_busy" } = {}) {
  const path = await assertNoSymlinkBelowV1(root, relativePath, { allowMissingLeaf: true });
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    .catch(error => { if (error.code === "EISDIR") throw updaterRefuseV1("updater_local_lock_refused"); throw error; });
  let child, released = false, closed;
  const killGroup = () => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const release = async () => {
    if (released) return;
    released = true;
    try {
      if (child) {
        child.stdin.end();
        let timer;
        try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
        finally { clearTimeout(timer); killGroup(); await closed; }
      }
    } finally { await handle.close(); }
  };
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid())
      throw updaterRefuseV1("updater_local_lock_refused");
    // The helper holds no authority other than the inherited lock fd. EOF on
    // its input releases the kernel lock even when our process is killed.
    child = spawn("/usr/bin/lockf", ["-k", "-s", "-t", String(Math.ceil(waitMs / 1000)), "/dev/fd/3",
      process.execPath, "--input-type=module", "-e",
      'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
    { detached: true, stdio: ["pipe", "pipe", "ignore", handle.fd],
      env: { PATH: "/usr/bin:/bin", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } });
    child.stdin.on("error", () => {});
    closed = new Promise(resolve => { child.once("close", resolve); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(updaterRefuseV1("updater_local_lock_timeout")), waitMs + 5000);
      let output = "";
      const done = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once("error", () => done(updaterRefuseV1("updater_local_lock_refused")));
      child.once("exit", code => done(updaterRefuseV1(code === 75 ? busyCode : "updater_local_lock_refused")));
      child.stdout.on("data", chunk => { output += chunk; if (output === "locked\n") done(); });
    });
    return release;
  } catch (error) { await release(); throw error; }
}
