// Gives back the SysV shared-memory segments a lane's SIGKILLs leaked.
//
// A postmaster (or `initdb`'s `postgres --boot`/`--single`) creates one 56-byte
// segment and releases it only on an exit path; SIGKILL runs none, so the segment
// stays with a dead creator and `nattch 0`. The machine has a small fixed number
// of segments, so a lane that kills at every statement fills it and `initdb`
// then fails for every other job with "No space left on device".
//
// Attribution is by the key PostgreSQL derives from the data directory's inode
// (the same fact tests/install-database-phase-real-postgres.test.mjs uses for its
// power-cut case), narrowed to unattached segments of this login whose creator is
// gone. It is never a user-wide sweep: other jobs share this login, and a
// segment that is merely unattached for a moment belongs to a live creator.
//
// `ipcs` and `ipcrm` are injectable so the selection is testable without a
// PostgreSQL, and a table that cannot be read is reported as `unreadable` rather
// than as a clean result nobody measured.

import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** `0x%08x` of the directory's inode, or null when the directory is gone. */
export function keyForDirectory(directory) {
  try { return `0x${(lstatSync(directory).ino % 2 ** 32).toString(16).padStart(8, "0")}`; }
  catch { return null; }
}

/**
 * `ipcs -m -a` rows, parsed by HEADER NAME (macOS: `T ID KEY MODE OWNER GROUP
 * CREATOR CGROUP NATTCH SEGSZ CPID LPID ...`, rows prefixed `m `). Null when the
 * output is not a table with every column this needs, so a caller refuses rather
 * than treating a failed `ipcs` as "no segments".
 */
export function parseSharedMemoryTable(text) {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  const headerAt = lines.findIndex(line => /\bNATTCH\b/u.test(line) && /\bCPID\b/u.test(line));
  if (headerAt === -1) return null;
  const headings = lines[headerAt].split(/\s+/u);
  const id = headings.indexOf("ID"), key = headings.indexOf("KEY"), owner = headings.indexOf("OWNER");
  const nattch = headings.indexOf("NATTCH"), cpid = headings.indexOf("CPID");
  if ([id, key, owner, nattch, cpid].some(index => index < 0)) return null;
  const rows = [];
  for (const line of lines.slice(headerAt + 1)) {
    const fields = line.split(/\s+/u);
    if (!/^\d+$/u.test(fields[id] ?? "") || !/^\d+$/u.test(fields[nattch] ?? "")
      || !/^\d+$/u.test(fields[cpid] ?? "") || !/^0x[0-9a-f]+$/iu.test(fields[key] ?? "")) continue;
    rows.push({ id: fields[id], key: fields[key].toLowerCase(), owner: fields[owner],
      attachments: Number(fields[nattch]), creatorPid: Number(fields[cpid]) });
  }
  return rows;
}

const pidExists = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};

/**
 * Remove the leaked segments of `directories` (data directories this lane created,
 * including ones a sweep renamed aside -- a rename keeps the inode). Call it
 * BEFORE the directories are deleted, because the inode is the only link.
 *
 * Returns `{ status, removed, remaining }`: `remaining` are this lane's own
 * segments that could not be removed because the creator is still alive or the
 * segment is still attached -- a postmaster the lane failed to stop, which the
 * caller should assert against rather than ignore.
 */
export async function reclaimLeakedSegments(directories, options = {}) {
  const {
    ipcs = async () => (await exec("/usr/bin/ipcs", ["-m", "-a"], { encoding: "utf8", timeout: 10_000 })).stdout,
    ipcrm = async id => { await exec("/usr/bin/ipcrm", ["-m", id], { encoding: "utf8", timeout: 10_000 }); },
    alive = pidExists,
    owner = userInfo().username,
  } = options;
  const keys = new Set(directories.map(keyForDirectory).filter(key => key !== null));
  if (keys.size === 0) return { status: "read", removed: [], remaining: [] };
  const rows = parseSharedMemoryTable(String(await Promise.resolve(ipcs()).catch(() => "")));
  if (rows === null) return { status: "unreadable", removed: [], remaining: [] };
  const removed = [], remaining = [];
  for (const row of rows) {
    if (!keys.has(row.key) || row.owner !== owner) continue;
    if (row.attachments !== 0 || alive(row.creatorPid)) { remaining.push(row); continue; }
    try { await ipcrm(row.id); removed.push(row.id); } catch { remaining.push(row); }
  }
  return { status: "read", removed, remaining };
}
