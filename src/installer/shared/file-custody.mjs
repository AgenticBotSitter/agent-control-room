import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export const sameIdentityV1 = (left, right) => left.dev === right.dev && left.ino === right.ino;
export const sameFileV1 = (left, right) => sameIdentityV1(left, right) && left.size === right.size
  && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
  && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
const refused = () => { throw new Error("file_custody_refused"); };

/** Retain identities, rather than trusting a pathname checked earlier. Directory
 * timestamps may change when another legitimate writer publishes a file. */
/** @param {string} path
 * @param {(path: string) => Promise<import("node:fs").Stats>} inspect */
export async function directoryCustodyV1(path, inspect = lstat) {
  const entries = [], canonical = await realpath(path);
  for (let current = path; ; current = dirname(current)) {
    const entry = await inspect(current);
    if (current === path ? !entry.isDirectory() || entry.isSymbolicLink()
      : !entry.isDirectory() && !entry.isSymbolicLink()) refused();
    if (entry.isSymbolicLink() && (!["/var", "/tmp", "/etc"].includes(current)
      || await realpath(current) !== `/private${current}`)) refused();
    entries.push([current, entry]);
    if (dirname(current) === current) break;
  }
  return async () => {
    for (const [current, before] of entries) {
      const after = await inspect(current);
      if (before.isDirectory() !== after.isDirectory() || before.isSymbolicLink() !== after.isSymbolicLink() || !sameIdentityV1(before, after)
        || before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid) refused();
    }
    if (await realpath(path) !== canonical) refused();
  };
}

/** A capped read of one unchanged regular inode. Nonblocking open refuses FIFOs
 * even when a regular file is replaced after lstat. Parent identities are checked
 * again before returning any bytes. Writers must publish complete bytes by atomic
 * rename/link: a paused in-place writer can look stable with incomplete content.
 * @param {string} path
 * @param {number} maximum
 * @param {(entry: import("node:fs").Stats) => void} validate */
export async function stableFileBytesV1(path, maximum, validate = () => {}) {
  const checkDirectory = await directoryCustodyV1(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) refused();
  validate(before);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileV1(before, opened)) refused();
    const bytes = Buffer.alloc(before.size + 1);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) break;
      position += bytesRead;
    }
    if (position !== before.size || !sameFileV1(before, await handle.stat())
      || !sameFileV1(before, await lstat(path))) refused();
    await checkDirectory();
    return bytes.subarray(0, position);
  } finally { await handle.close(); }
}

/** Clean only the inode this invocation created; a replacement belongs to
 * somebody else. Missing means the publication rename already consumed it. */
export async function removeOwnedFileV1(path, owned) {
  const current = await lstat(path).catch(error => { if (error?.code === "ENOENT") return null; throw error; });
  if (current && sameIdentityV1(current, owned)) await unlink(path);
}
