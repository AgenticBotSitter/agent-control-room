import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { kernelFileLockPlatformV1 } from "./private-process-lock.mjs";

/** A permanent inode for short transactions and recovery. Never unlink it: a
 * waiter opening the old inode must not race a new holder on a replacement.
 * Kernel exclusion, not the stamp or the age, determines whether it is free. */
export async function tryPersistentKernelLockV1(path) {
  const platform = kernelFileLockPlatformV1();
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW
      | constants.O_NONBLOCK | platform.openFlags, 0o600);
    if (!platform.tryLock(handle.fd)) { await handle.close(); return null; }
    const owned = await handle.stat(), named = await lstat(path);
    if (!owned.isFile() || owned.nlink !== 1 || owned.uid !== process.getuid()
      || (owned.mode & 0o077) !== 0 || named.isSymbolicLink()
      || owned.dev !== named.dev || owned.ino !== named.ino) {
      throw new Error("persistent_kernel_lock_invalid");
    }
    // Refuse a filesystem that accepts the flags but ignores exclusion. A
    // second independent descriptor must conflict even in this process.
    let probe;
    try {
      probe = await open(path, constants.O_RDWR | constants.O_NOFOLLOW
        | constants.O_NONBLOCK | platform.openFlags);
      if (platform.tryLock(probe.fd)) throw new Error("persistent_kernel_lock_unsupported");
    } catch (error) {
      if (!["EAGAIN", "EWOULDBLOCK"].includes(error.code)) throw error;
    } finally { await probe?.close(); }
    return handle;
  } catch (error) {
    await handle?.close();
    if (["EAGAIN", "EWOULDBLOCK"].includes(error.code)) return null;
    throw error;
  }
}
