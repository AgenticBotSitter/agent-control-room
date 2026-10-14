// macOS O_EXLOCK is not exposed by Node's fs.constants. The kernel releases it
// on every exit, including SIGKILL; a leftover name or recycled PID is harmless.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { open, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync,
  readFileSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";

const kernelLock = process.platform === "darwin" ? 0x20 | constants.O_NONBLOCK : 0;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
// Errno values that mean "there is something at the lock path that can never be the lock we
// describe, and that quarantining it would fix". A SHAPE, not a state: EISDIR a directory,
// ELOOP a symlink, ENOTSUP a FIFO or socket, ENOTDIR a path component that is not a directory.
// Deliberately absent: ENOSPC (the disk is full and the entry may be fine), EACCES/EPERM (the
// private directory is not ours to change), EBUSY/ETXTBSY (someone holds it open), EROFS.
const BROKEN_ENTRY_ERRNO_V1 = new Set(["EISDIR", "ELOOP", "ENOTSUP", "ENOTDIR"]);
const privateFile = (s, uid) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1
  && s.uid === uid && (s.mode & 0o077) === 0;
const linuxStart = pid => {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).trim().split(/\s+/u)[19]; }
  catch { return undefined; }
};

function readOwner(path, before, uid) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = fstatSync(fd);
    if (!privateFile(entry, uid) || !same(before, entry)) throw new Error("private_process_lock_invalid");
    const bytes = Buffer.alloc(8193), length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 8192) throw new Error("private_process_lock_invalid");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }
}
// Probe on our own descriptor; closing it drops a probe lock we won. A probe that cannot run
// proves nothing, so it counts as held. A replaced name is refused by the caller's inode check.
function sharedLockHeld(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return !kernelFileLockPlatformV1().tryLock(fd);
  } catch { return true; }
  finally { if (fd !== undefined) closeSync(fd); }
}
const processExists = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
};

/** One platform boundary. Linux flock(2) locks the open file description shared
 * by fd 3 and our descriptor. The descriptor-only util-linux command exits before
 * returning; our descriptor retains the lock until close or SIGKILL. No PID stamp,
 * shell, background holder, /proc race, or lock-recovery unlink is involved.
 * spawnSync returns only after the helper has exited (a timeout kills it first),
 * and the helper runs no command, so nothing is left to signal afterwards.
 * Linux hosts need the root-installed util-linux binary at /usr/bin/flock. */
export function kernelFileLockPlatformV1(platform = process.platform, { run = spawnSync, macExclusive = 0x20 } = {}) {
  if (platform === "darwin") return { openFlags: macExclusive, tryLock: () => true };
  if (platform !== "linux") throw new Error("kernel_file_lock_unsupported");
  return { openFlags: 0, tryLock: fd => {
    const result = run("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"],
      { stdio: ["ignore", "ignore", "ignore", fd], env: {}, detached: false, timeout: 5000, killSignal: "SIGKILL" });
    if (result.status === 0 && !result.error && !result.signal) return true;
    if (result.status === 75 && !result.error && !result.signal) return false;
    throw new Error("kernel_file_lock_unsupported");
  } };
}

/** Fixed, attached macOS ACL probe. Xattrs and deny-only ACLs grant no rights; any allow ACL
 * is refused by custody. Unknown output or tool failure proves no authority. */
export function macLockPathHasAclV1(path, { run = spawnSync } = {}) {
  const failed = () => { throw Object.assign(new Error("kernel_file_lock_acl_probe_failed"),
    { code: "kernel_file_lock_acl_probe_failed" }); };
  let result;
  try { result = run("/bin/ls", ["-lde", path], { encoding: "utf8", env: { LC_ALL: "C" },
    detached: false, timeout: 5000, killSignal: "SIGKILL" }); }
  catch { failed(); }
  if (!result || result.status !== 0 || result.error || result.signal || result.stderr) failed();
  if (typeof result.stdout !== "string") failed();
  const rows = result.stdout.replace(/\n$/u, "").split("\n");
  const header = /^[bcdlps-][rwxStTs-]{9}([+@]?)\s+\d+\s+\S+\s+\S+\s+\d+\s+.+$/u.exec(rows[0]);
  if (!header) failed();
  const acl = rows.slice(1);
  if (acl.some((row, index) => !new RegExp(`^\\s+${index}: (?:user|group):\\S+ (?:inherited )?(?:allow|deny) \\S.*$`, "u").test(row))) failed();
  if (header[1] === "+" && acl.length === 0) failed();
  return acl.some(row => / (?:inherited )?allow /u.test(row));
}

/** Every lexical ancestor must retain trusted ownership and deny group/other
 * replacement. A sticky ancestor protects a trusted next component; the lock
 * folder itself must stay non-writable. No symlinks or Mac allow ACLs are admitted.
 * Product lock names are permanent. Replacement by root or the expected owner
 * is outside this threat model. Recheck custody after kernel acquisition. */
async function kernelLockDirectoryCustodyV1(path, expectedUid, refuse) {
  const parent = dirname(path), entries = [];
  for (let current = parent; ; current = dirname(current)) {
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) refuse();
    if (entry.uid !== 0 && entry.uid !== expectedUid) refuse();
    const child = entries.at(-1)?.[1];
    const protectedBySticky = current !== parent && (entry.mode & 0o1000) !== 0
      && child !== undefined && (child.uid === 0 || child.uid === expectedUid);
    if (entry.isDirectory() && (entry.mode & 0o022) !== 0 && !protectedBySticky) refuse();
    if (process.platform === "darwin" && macLockPathHasAclV1(current)) refuse();
    entries.push([current, entry]);
    if (dirname(current) === current) break;
  }
  return async () => {
    for (const [current, before] of entries) {
      const after = await lstat(current);
      if (!after.isDirectory() || after.isSymbolicLink() || !same(before, after)
        || before.uid !== after.uid || before.gid !== after.gid || before.mode !== after.mode) refuse();
      if (process.platform === "darwin" && macLockPathHasAclV1(current)) refuse();
    }
  };
}

/** Kernel exclusion on a permanent rendezvous inode. Closing releases authority;
 * neither release nor a failed acquisition unlinks the name a waiter may use. */
export async function acquireKernelFileLockV1(path, {
  expectedUid = process.getuid(), busyCode = "kernel_file_lock_busy", refusedCode = "kernel_file_lock_owner_refused" } = {}) {
  const busy = () => { throw Object.assign(new Error(busyCode), { code: busyCode }); };
  const refuse = () => { throw Object.assign(new Error(refusedCode), { code: refusedCode }); };
  // Preserve lexical ancestors: resolve() could hide a symlink before a /../.
  path = path.startsWith("/") ? path : `${process.cwd()}/${path}`;
  const checkDirectory = await kernelLockDirectoryCustodyV1(path, expectedUid, refuse);
  const platform = kernelFileLockPlatformV1(); let handle;
  try {
    const existing = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (existing && !existing.isFile()) refuse();
    if (existing && process.platform === "darwin" && macLockPathHasAclV1(path)) refuse();
    try { handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | platform.openFlags, 0o600); }
    catch (error) {
      if (["EAGAIN", "EWOULDBLOCK"].includes(error.code)) busy();
      if (BROKEN_ENTRY_ERRNO_V1.has(error.code)) refuse();
      throw error;
    }
    if (!platform.tryLock(handle.fd)) busy();
    const owned = await handle.stat();
    const named = await lstat(path).catch(error => { if (error.code === "ENOENT") refuse(); throw error; });
    if (!privateFile(owned, expectedUid) || !same(owned, named)) refuse();
    if (process.platform === "darwin" && macLockPathHasAclV1(path)) refuse();
    await handle.truncate(0); await handle.sync();
    await checkDirectory();
    if (!same(owned, await lstat(path))) refuse();
    if (process.platform === "darwin" && macLockPathHasAclV1(path)) refuse();
    let closed = false;
    const release = async () => {
      if (closed) return;
      closed = true;
      try {
        if (!same(owned, await lstat(path))) throw new Error("kernel_file_lock_owner_changed");
        // Keep the rendezvous inode: closing alone releases the kernel lock.
      } finally { await handle.close(); }
    };
    return { release };
  } catch (error) {
    // Keep even a freshly created name: another opener may already use it.
    await handle?.close();
    throw error;
  }
}

/** Returns an owned descriptor. Never follows, truncates or removes an unproved entry.
 *
 * Only EAGAIN from the kernel means "someone else holds this lock". A wrong mode, a directory,
 * a dangling symlink or a FIFO at the lock path is a BROKEN ENTRY, not a holder: reporting it as
 * the busy code told the owner "another one is running" forever, with no way out but hand-editing
 * the private directory. Broken entries get `unusableCode` and `error.unusable`, so the caller can
 * tell damage from contention and quarantine the entry — see `quarantineUsableLockV1`.
 *
 * Everything else keeps its OWN code and is never quarantineable, because nothing is wrong with
 * the entry: ENOSPC means the disk is full, EACCES/EPERM means the private directory is not ours,
 * EBUSY/ETXTBSY means something else holds it open. Those must propagate: a full disk that made
 * the supervisor quarantine its own perfectly good lock would turn R4S-06's fix into a new way
 * to lose the lock, and "full disk" is not something quarantining a file can fix.
 *
 * @returns {Readonly<{fd: number, identity: Readonly<{dev: number, ino: number, nonce: string}>,
 *   writeOwner: (pid: number, command?: string[]) => void, shareWithChildren: () => void,
 *   close: () => void, release: () => void}>}
 */
export function acquirePrivateProcessLockV1(path, {
  busyCode = "private_process_lock_busy", expectedUid = process.getuid(), unusableCode = "private_process_lock_unusable" } = {}) {
  const busy = () => { const error = new Error(busyCode); error.code = busyCode; throw error; };
  // Declared `never`-returning by throwing at every exit, so the TypeScript inference from this
  // .mjs does not widen the acquired lock to `... | undefined` at the call sites.
  const unusable = (cause) => {
    const error = new Error(unusableCode);
    error.code = unusableCode;
    error.unusable = true;
    error.path = path;
    error.cause = cause;
    throw error;
  };
  let fd;
  try {
    if (!kernelLock) {
      // Linux build/rehearsal fallback. PID incarnation, rather than PID alone,
      // binds a live owner. Fresh empty files remain busy during publication.
      try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") {
          // A directory, symlink or FIFO can never be the lock we are describing.
          if (["EISDIR", "ELOOP", "ENOTDIR", "ENOTSUP", "EPERM"].includes(error.code)) unusable(error);
          throw error;
        }
        const before = lstatSync(path);
        if (!privateFile(before, expectedUid)) unusable(error);
        let owner;
        try { owner = readOwner(path, before, expectedUid); } catch {}
        const liveStart = Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? linuxStart(owner.pid) : undefined;
        if (liveStart && (!owner.start || owner.start === liveStart)
          || !liveStart && Number.isSafeInteger(owner?.pid) && owner.pid > 0 && processExists(owner.pid)
          || !owner && Date.now() - before.mtimeMs < 300_000) busy();
        // A holder that shared its descriptor proved liveness by flock(2), not by its PID: a child
        // that inherited the descriptor keeps the lock after the stamped process is gone.
        if (owner?.flock === true && sharedLockHeld(path)) busy();
        if (!same(before, lstatSync(path))) busy();
        unlinkSync(path);
        fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      }
    } else {
      try { fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | kernelLock, 0o600); }
      catch (error) {
        // The ONE errno that means a live holder. Everything else is either a broken entry we may
        // quarantine (a shape, or a file we could open but may not own) or a reason to give up
        // without touching anything (ENOSPC, EACCES, EBUSY). Calling those "busy" is what made a
        // damaged lock permanent; calling them "unusable" would make a full disk look like damage.
        if (error.code === "EAGAIN") busy();
        if (BROKEN_ENTRY_ERRNO_V1.has(error.code)) unusable(error);
        throw error;
      }
    }
    const owned = fstatSync(fd);
    // Opened, but not a lock we may own: a world-readable file restored from a backup, an
    // entry owned by another account, or a hardlinked name. Usable, never contention.
    if (!privateFile(owned, expectedUid)) unusable();
    if (!same(owned, lstatSync(path))) busy();
    const nonce = randomBytes(24).toString("hex"), identity = { dev: owned.dev, ino: owned.ino, nonce };
    let shared = false, stamped = [process.pid, []];
    const writeOwner = (pid, command = []) => {
      stamped = [pid, command];
      ftruncateSync(fd, 0);
      writeSync(fd, `${JSON.stringify({ version: 2, pid, command, nonce, ...(kernelLock ? {} : { start: linuxStart(pid), ...(shared ? { flock: true } : {}) }) })}\n`, 0, "utf8");
      fsyncSync(fd);
    };
    writeOwner(process.pid);
    // Call before passing `fd` to a child that must keep exclusion if this process dies. macOS
    // O_EXLOCK already belongs to the shared open file description. Linux adds flock(2) to it,
    // then stamps that, so a competitor probes the inode instead of trusting a dead PID.
    const shareWithChildren = () => {
      if (kernelLock || shared) return;
      if (!kernelFileLockPlatformV1().tryLock(fd)) busy();
      shared = true;
      writeOwner(...stamped);
    };
    let closed = false;
    const close = () => { if (!closed) { closed = true; closeSync(fd); } };
    const release = () => {
      try { if (same(owned, lstatSync(path))) unlinkSync(path); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      finally { close(); }
    };
    return Object.freeze({ fd, identity: Object.freeze(identity), writeOwner, shareWithChildren, close, release });
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error?.unusable === true) throw error;
    // Only the errno we can prove means contention keeps the busy code.
    if (error?.code === "EAGAIN") busy();
    // `busy()` throws a plain Error whose message is the caller's busy code. It reaches here
    // from the inner EAGAIN check, so it must pass through unchanged — reclassifying it as
    // unusable would turn real contention into "damaged" and let recovery quarantine a LIVE
    // holder's lock.
    if (error?.code === busyCode) throw error;
    // A writeOwner failure, an ENOSPC, a permission error: nothing here says the ENTRY is wrong,
    // so the caller must see the real reason and must not quarantine anything.
    if (error instanceof Error && error.code) throw error;
    unusable(error);
  }
}

/** Moves an unusable lock entry aside inside the SAME directory, without following it or
 * descending into it, so the lock can be recreated. The entry is renamed, never opened, so a
 * directory full of someone else's data comes back out whole rather than being emptied. */
export function quarantineUsableLockV1(path) {
  const moved = `${path}.quarantine-${randomBytes(16).toString("hex")}`;
  try { renameSync(path, moved); return moved; }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

/** Acquire, quarantining ONE unusable entry and retrying once. A second unusable entry, or a
 * second busy refusal, is returned to the caller unchanged: this recovers from damage on disk,
 * never from a live holder.
 *
 * @returns {ReturnType<typeof acquirePrivateProcessLockV1>}
 */
export function acquireRecoverablePrivateProcessLockV1(path, options = {}) {
  try { return acquirePrivateProcessLockV1(path, options); }
  catch (error) {
    if (error?.unusable !== true) throw error;
    if (quarantineUsableLockV1(path) === undefined) throw error;
    return acquirePrivateProcessLockV1(path, options);
  }
}

/** Diagnostic host state can be missing after a crash. Recover the identity from
 * the same private descriptor stamp; liveness still requires its held kernel lock. */
export function readPrivateProcessLeaseV1(path) {
  try {
    const before = lstatSync(path), owner = readOwner(path, before, process.getuid());
    return { pid: owner.pid, identity: { dev: before.dev, ino: before.ino, nonce: owner.nonce } };
  } catch { return undefined; }
}

/** A child inherits the locked descriptor. Match its private inode and nonce as
 * well as kill(0); a recycled PID with an unlocked old file cannot pass. */
export function privateProcessLeaseAliveV1(path, pid, command, identity) {
  if (!kernelLock || !Number.isSafeInteger(pid) || pid <= 1 || !identity) return false;
  try {
    process.kill(pid, 0);
    const before = lstatSync(path);
    if (!privateFile(before, process.getuid()) || !same(before, identity) || before.size > 8192) return false;
    const owner = readOwner(path, before, process.getuid());
    if (owner.pid !== pid || owner.nonce !== identity.nonce || JSON.stringify(owner.command) !== JSON.stringify(command)) return false;
    let probe;
    try { probe = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | kernelLock); }
    catch (error) { return error.code === "EAGAIN" && same(before, lstatSync(path)); }
    finally { if (probe !== undefined) closeSync(probe); }
  } catch {}
  return false;
}
