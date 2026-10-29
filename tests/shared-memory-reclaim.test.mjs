// The lane that SIGKILLs the database phase at every statement leaves SysV
// shared-memory segments behind: a SIGKILLed postmaster, `initdb` or `postgres
// --boot` cannot run its exit path, and the segment it created stays with a dead
// creator and `nattch 0`. Reclaiming them is attributed by the one thing that
// names them -- the key PostgreSQL derives from the data directory's inode -- and
// by "unattached, owned by this login, creator gone", never by a user-wide sweep:
// other jobs share this login and their live clusters appear in the same `ipcs`.
//
// None of this needs a real PostgreSQL: `ipcs` and `ipcrm` are injected, and the
// data directory, its inode and the dead creator pid are real.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { keyForDirectory, parseSharedMemoryTable, reclaimLeakedSegments }
  from "./helpers/shared-memory-reclaim.mjs";

const OWNER = userInfo().username;
/** A pid that existed and is gone: a child that has already been reaped. */
const deadPid = () => spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" }).pid;

const table = rows => [
  "T     ID     KEY        MODE       OWNER    GROUP  CREATOR CGROUP NATTCH SEGSZ CPID LPID ATIME DTIME CTIME",
  "Shared Memory:",
  ...rows.map(row => `m ${row.id} ${row.key} --rw------- ${row.owner ?? OWNER} staff ${row.owner ?? OWNER} staff `
    + `${row.nattch ?? 0} 56 ${row.cpid} ${row.cpid} 9:00:00 9:00:00 9:00:00`),
].join("\n");

const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "shm-reclaim-"));
  return { directory, key: keyForDirectory(directory), done: () => rmSync(directory, { recursive: true, force: true }) };
};

test("keyForDirectory is the data directory's inode as PostgreSQL's 0x%08x key", () => {
  const { directory, key, done } = scratch();
  try {
    assert.equal(key, `0x${(lstatSync(directory).ino % 2 ** 32).toString(16).padStart(8, "0")}`);
    assert.equal(keyForDirectory(join(directory, "does-not-exist")), null, "a directory that is gone has no key");
  } finally { done(); }
});

test("parseSharedMemoryTable reads ipcs by header name and refuses anything else", () => {
  assert.deepEqual(parseSharedMemoryTable(table([{ id: 7, key: "0x00abc123", cpid: 4242, nattch: 1 }])),
    [{ id: "7", key: "0x00abc123", owner: OWNER, attachments: 1, creatorPid: 4242 }]);
  assert.equal(parseSharedMemoryTable("ipcs: sysctlbyname: Operation not permitted\n"), null);
  assert.equal(parseSharedMemoryTable("T ID KEY MODE OWNER GROUP\nShared Memory:\n"), null,
    "no NATTCH or CPID column is a table that cannot be judged, not an empty one");
});

test("an unattached segment of a dead creator, keyed by the lane's data directory, is removed by id", async () => {
  const { directory, key, done } = scratch();
  try {
    const removed = [];
    const report = await reclaimLeakedSegments([directory], {
      ipcs: async () => table([{ id: 91, key, cpid: deadPid() }]),
      ipcrm: async id => { removed.push(id); },
    });
    assert.deepEqual(removed, ["91"]);
    assert.deepEqual(report, { status: "read", removed: ["91"], remaining: [] });
  } finally { done(); }
});

test("a segment that is attached, has a live creator, another owner or another key is left alone", async () => {
  const { directory, key, done } = scratch();
  try {
    const removed = [];
    const rows = [
      { id: 1, key, cpid: deadPid(), nattch: 1 },            // a live postmaster's segment
      { id: 2, key, cpid: process.pid },                      // creator still running
      { id: 3, key, cpid: deadPid(), owner: "someone-else" }, // not this login's
      { id: 4, key: "0x7fffffff", cpid: deadPid() },          // another job's cluster
    ];
    const report = await reclaimLeakedSegments([directory], {
      ipcs: async () => table(rows), ipcrm: async id => { removed.push(id); },
    });
    assert.deepEqual(removed, [], "nothing here is this lane's orphan");
    // Only the lane's OWN segments are reported as remaining: the creator-alive and attached ones.
    assert.deepEqual(report.remaining.map(entry => entry.id), ["1", "2"]);
    assert.equal(report.status, "read");
  } finally { done(); }
});

test("an unreadable ipcs is reported as unreadable, never as a clean teardown", async () => {
  const { directory, done } = scratch();
  try {
    const removed = [];
    const report = await reclaimLeakedSegments([directory], {
      ipcs: async () => "ipcs: sysctlbyname: Operation not permitted\n", ipcrm: async id => { removed.push(id); },
    });
    assert.deepEqual(report, { status: "unreadable", removed: [], remaining: [] });
    assert.deepEqual(removed, []);
  } finally { done(); }
});

test("a directory that is gone, or no directory at all, runs no ipcrm", async () => {
  const removed = [];
  const report = await reclaimLeakedSegments(["/nonexistent/shm-reclaim-gone"], {
    ipcs: async () => table([{ id: 5, key: "0x00000001", cpid: deadPid() }]), ipcrm: async id => { removed.push(id); },
  });
  assert.deepEqual(removed, []);
  assert.deepEqual(report, { status: "read", removed: [], remaining: [] });
});
