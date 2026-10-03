import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { killAtBoundary, runChild, runCrashCases } from "./support/r6k-owned-child.mjs";
const child = (root, ...cut) => ["--import", "tsx", "tests/support/r6k-crash-child.ts", "lock", root, ...cut];
const rounds = Number(process.env.CONTROL_ROOM_R6K_CRASH_ROUNDS ?? 20);
test("R6K-02/03: elected, published, held, released and cleaner SIGKILL cuts restart cleanly", { timeout: 180_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-connector-")));
  try {
    const cases = [];
    for (const boundary of ["directory", "owner", "held", "released", "cleaner"]) for (let i = 0; i < rounds; i++) {
      cases.push(async () => {
      const state = join(root, `${boundary}-${i}`); await mkdir(state, { mode: 0o700 });
      if (boundary === "cleaner") await killAtBoundary(child(state, "owner"));
      await killAtBoundary(child(state, boundary));
      assert.equal((await runChild(child(state))).opened, true);
      });
    }
    await runCrashCases(cases);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-03: failed cleaner election sleeps and respects the caller deadline", { timeout: 10_000 }, async () => {
  const { acquireRotationLock } = await import(process.env.CONTROL_ROOM_R6K_BASELINE_CONNECTOR ?? "../scripts/fleet/connector-update.mjs");
  const { writeFile, readFile } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-deadline-")));
  const lock = join(root, "profile.rotate.lock"), token = "f".repeat(32);
  try {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: 2147483647, token }), { mode: 0o600 });
    // A live legacy cleaner has exclusive election, but is outside the new
    // kernel protocol. The waiter must neither displace it nor spin on it.
    const marker = `${lock}.reap-${token}`;
    await writeFile(marker, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    let instant = 0, sleeps = 0;
    await assert.rejects(acquireRotationLock(lock, { deadlineMs: 100, waitMs: 25,
      clock: () => instant, getProcessIdentity: async () => null,
      sleep: async ms => { sleeps++; instant += ms; } }), /Another session/u);
    assert.equal(instant, 100); assert.equal(sleeps, 4);
    assert.equal(JSON.parse(await readFile(marker, "utf8")).pid, process.pid);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-02: delayed cleanup cannot remove a replacement generation", async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readFile } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-generation-"))), lock = join(root, "profile.rotate.lock");
  const token = "e".repeat(32), replacement = "d".repeat(32);
  try {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: 2147483647, token }), { mode: 0o600 });
    let cleaners = 0;
    await assert.rejects(acquireRotationLock(lock, { deadlineMs: 0, getProcessIdentity: async () => null,
      afterCleanerElection: async () => { cleaners++; },
      beforeDeadOwnerCleanup: async () => {
        await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
        await writeFile(join(lock, `owner-${replacement}.json`), JSON.stringify({ pid: process.pid, token: replacement }), { mode: 0o600 });
      } }), /Another session/u);
    assert.equal(cleaners, 0);
    assert.equal(JSON.parse(await readFile(join(lock, `owner-${replacement}.json`), "utf8")).pid, process.pid);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-02: twenty concurrent restarts recover one abandoned owner with no overlapping holders", { timeout: 90_000 }, async () => {
  const { ownedChild } = await import("./support/r6k-owned-child.mjs");
  const { readFile } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-lock-load-")));
  try {
    await killAtBoundary(child(root, "owner"));
    await Promise.all(Array.from({ length: 20 }, () => ownedChild([
      "--import", "tsx", "tests/support/r6k-crash-child.ts", "lock-load", root,
    ], async ({ closed, errors }) => { assert.equal((await closed).code, 0, errors()); }, { timeoutMs: 60_000 })));
    let inside = 0, entrants = 0;
    for (const line of (await readFile(join(root, "journal"), "utf8")).trim().split("\n")) {
      if (line === "enter") { entrants++; inside++; assert.equal(inside, 1); }
      else { inside--; assert.equal(inside, 0); }
    }
    assert.equal(entrants, 20);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-02/03: SIGKILL at each filesystem election and retirement step recovers", { timeout: 1_200_000 }, async () => {
  const { ownedChild } = await import("./support/r6k-owned-child.mjs");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-fleet-io-")));
  try {
    const cases = [];
    const boundaries = ["open:contender", "writeFile:contender", "sync:contender", "close:contender",
      "mkdir:candidate", "rename:owner", "open:guard", "rename:canonical", "close:guard",
      "open:marker-scratch", "writeFile:marker-scratch", "sync:marker-scratch", "close:marker-scratch",
      "link:marker", "unlink:marker-scratch", "unlink:owner", "rmdir:canonical", "unlink:marker"];
    for (const at of boundaries) for (const phase of ["before", "after"]) for (let i = 0; i < rounds; i++) {
      cases.push(async () => {
      const state = join(root, `${at.replace(":", "-")}-${phase}-${i}`); await mkdir(state, { mode: 0o700 });
      const env = { R6K_CUT_ROOT: state, R6K_CUT_BOUNDARY: at, R6K_CUT_PHASE: phase };
      // The preload wraps the actual fs promises, including before the owner
      // publication and after an owner unlink; it does not simulate a failure.
      await ownedChild(["--import", "./tests/support/r6k-fs-cut.mjs", ...child(state)],
        async ({ closed, output, errors }) => {
          assert.equal((await closed).signal, "SIGKILL", errors());
          assert.equal(JSON.parse(output()).cut, at);
        }, { env });
      assert.equal((await runChild(child(state))).opened, true);
      });
    }
    await runCrashCases(cases);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K kernel exclusion refuses live holders and unsafe permanent lock entries", async () => {
  const { tryPersistentKernelLockV1 } = await import("../src/installer/shared/persistent-kernel-lock.mjs");
  const { writeFile, chmod, symlink, link } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-kernel-shape-")));
  try {
    const path = join(root, "permanent"), first = await tryPersistentKernelLockV1(path);
    assert.ok(first);
    try { assert.equal(await tryPersistentKernelLockV1(path), null); }
    finally { await first.close(); }
    const after = await tryPersistentKernelLockV1(path); assert.ok(after); await after.close();
    await chmod(path, 0o644);
    await assert.rejects(tryPersistentKernelLockV1(path), /persistent_kernel_lock_invalid/u);
    const alias = join(root, "alias"); await symlink(path, alias);
    await assert.rejects(tryPersistentKernelLockV1(alias));
    await chmod(path, 0o600); await link(path, join(root, "second"));
    await assert.rejects(tryPersistentKernelLockV1(path), /persistent_kernel_lock_invalid/u);
    const directory = join(root, "directory"); await mkdir(directory);
    await assert.rejects(tryPersistentKernelLockV1(directory));
    await writeFile(join(root, "foreign"), "preserve", { mode: 0o600 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K connector refuses malformed owners and unknown directories without removal", async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readFile, readdir, symlink, link } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-lock-invalid-"))), lock = join(root, "profile.rotate.lock");
  try {
    for (const fixture of ["empty", "unexpected", "token", "pid", "symlink", "hardlink"]) {
      await mkdir(lock, { mode: 0o700 });
      const owner = join(lock, `owner-${"a".repeat(32)}.json`);
      const bytes = JSON.stringify({ pid: fixture === "pid" ? -1 : 2147483647,
        token: fixture === "token" ? "b".repeat(32) : "a".repeat(32) });
      if (fixture === "unexpected") await writeFile(join(lock, "unexpected"), "preserve");
      if (["token", "pid"].includes(fixture)) await writeFile(owner, bytes, { mode: 0o600 });
      if (["symlink", "hardlink"].includes(fixture)) {
        const outside = join(root, fixture); await writeFile(outside, bytes, { mode: 0o600 });
        if (fixture === "symlink") await symlink(outside, owner); else await link(outside, owner);
      }
      const entries = await readdir(lock);
      await assert.rejects(acquireRotationLock(lock, { deadlineMs: 2000, getProcessIdentity: async () => null }));
      assert.deepEqual(await readdir(lock), entries);
      if (["symlink", "hardlink"].includes(fixture)) assert.equal(await readFile(join(root, fixture), "utf8"), bytes);
      await rm(lock, { recursive: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-02: elected cleaner revalidates process and directory after election", async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readFile } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-after-cleaner-")));
  try {
    for (const changed of ["pid", "directory"]) {
      const lock = join(root, changed), token = "e".repeat(32);
      await mkdir(lock); const path = join(lock, `owner-${token}.json`);
      await writeFile(path, JSON.stringify({ pid: 2147483647, token }), { mode: 0o600 });
      let called = false;
      await assert.rejects(acquireRotationLock(lock, { deadlineMs: 100, waitMs: 10,
        getProcessIdentity: async () => null,
        afterCleanerElection: async () => {
          if (called) return; called = true;
          if (changed === "directory") { await rm(lock, { recursive: true }); await mkdir(lock); }
          await writeFile(path, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
        },
      }), /Another session/u);
      assert.ok(called); assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K kernel exclusion refuses a volume that ignores exclusive open flags", async () => {
  const { ownedChild } = await import("./support/r6k-owned-child.mjs");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-kernel-volume-")));
  try {
    await ownedChild(["--import", "./tests/support/r6k-fs-cut.mjs", "--import", "tsx",
      "tests/support/r6k-crash-child.ts", "kernel-probe", root], async ({ closed, output, errors }) => {
      assert.equal((await closed).code, 0, errors());
      assert.equal(JSON.parse(output()).code, "persistent_kernel_lock_unsupported");
    }, { env: { R6K_IGNORE_KERNEL: "1", R6K_CUT_ROOT: root } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-02: legacy empty election recovers only proven dead contenders and rechecks generation", async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readdir } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-legacy-election-"))), lock = join(root, "profile.rotate.lock");
  const token = "a".repeat(32), contender = `${lock}.2147483647.${token}.tmp`;
  try {
    await mkdir(lock); await writeFile(contender, JSON.stringify({ pid: 2147483647, token, processIdentity: "dead" }), { mode: 0o600 });
    const release = await acquireRotationLock(lock, { getProcessIdentity: async () => null }); await release();
    assert.equal((await readdir(root)).some(name => name.endsWith(".tmp") || name === "profile.rotate.lock"), false);
    await mkdir(lock); await writeFile(contender, JSON.stringify({ pid: 2147483647, token }), { mode: 0o600 });
    await assert.rejects(acquireRotationLock(lock, { deadlineMs: 100, isPidAlive: () => true,
      getProcessIdentity: async () => null }), /Another session/u);
    assert.deepEqual(await readdir(lock), []);
    await assert.rejects(acquireRotationLock(lock, { deadlineMs: 100, getProcessIdentity: async () => null,
      afterCleanerElection: async () => { await rm(lock, { recursive: true }); await mkdir(lock); } }), /generation_changed/u);
    assert.deepEqual(await readdir(lock), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-03: malformed or symlinked cleaner markers refuse without following or deleting them", async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readFile, symlink, lstat } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-marker-shape-"))), lock = join(root, "profile.rotate.lock");
  const token = "e".repeat(32), marker = `${lock}.reap-${token}`;
  try {
    await mkdir(lock); await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: 2147483647, token }), { mode: 0o600 });
    await writeFile(marker, "{", { mode: 0o600 });
    await assert.rejects(acquireRotationLock(lock), /connector_lock_cleaner_unidentified/u);
    assert.equal(await readFile(marker, "utf8"), "{");
    await rm(marker); const outside = join(root, "outside");
    await writeFile(outside, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
    await symlink(outside, marker);
    await assert.rejects(acquireRotationLock(lock), /connector_lock_cleaner_unidentified/u);
    assert.ok((await lstat(marker)).isSymbolicLink());
    assert.equal(JSON.parse(await readFile(outside, "utf8")).pid, 2147483647);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-03: an unidentifiable cleaner marker blocks only while it could be live", { timeout: 120_000 }, async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readFile, readdir, mkdir, utimes, lstat, rm } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-marker-abandoned-")));
  const token = "e".repeat(32);
  // Every shape an interrupted publication can leave behind. None of them is a
  // record this protocol ever writes, so none can identify a live cleaner.
  const shapes = {
    "zero-byte": "",
    "truncated-json": '{',
    "wrong-shape": JSON.stringify({ pid: "not-a-pid" }),
    "wrong-shape-empty": "{}",
    "oversized": `${JSON.stringify({ pid: 2147483647 })}\n${" ".repeat(4096)}`,
  };
  // The production five-minute stale window, on the real clock, with no injected
  // window: a marker backdated past it is abandoned by construction.
  const aged = new Date(Date.now() - 6 * 60_000);
  try {
    for (const [shape, bytes] of Object.entries(shapes)) for (const age of ["young", "aged"]) {
      const state = join(root, `${shape}-${age}`);
      const lock = join(state, "profile.rotate.lock"), marker = `${lock}.reap-${token}`;
      await mkdir(state, { mode: 0o700 });
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: 2147483647, token }), { mode: 0o600 });
      await writeFile(marker, bytes, { mode: 0o600 });
      if (age === "aged") await utimes(marker, aged, aged);
      const before = await lstat(marker);
      // The permanent guard inode is the one file an attempt may add beside the
      // lock; everything else that was there must be exactly as it was.
      const beside = async () => (await readdir(state)).filter(name => !name.endsWith(".guard")).sort();
      if (age === "young") {
        // A younger unidentifiable marker may belong to a cleaner between
        // opening and writing its record, so it still fails closed.
        await assert.rejects(acquireRotationLock(lock), /connector_lock_cleaner_unidentified/u);
        assert.deepEqual(await readdir(lock), [`owner-${token}.json`], "a young marker never retires the owner");
        assert.deepEqual(await beside(), ["profile.rotate.lock", `profile.rotate.lock.reap-${token}`]);
        assert.equal((await lstat(marker)).ino, before.ino);
        assert.equal(await readFile(marker, "utf8"), bytes);
        await rm(state, { recursive: true });
        continue;
      }
      const release = await acquireRotationLock(lock);
      assert.equal(typeof release, "function", `${shape}: an abandoned marker must not block start`);
      await release();
      assert.equal(await readFile(marker, "utf8"), bytes, "an abandoned marker is never rewritten");
      assert.equal((await lstat(marker)).ino, before.ino, "an abandoned marker is never replaced");
      assert.deepEqual(await beside(), [`profile.rotate.lock.reap-${token}`],
        "the dead owner is retired and the unidentified marker is left in place");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-03: retiring past an abandoned marker skips the cleaner election hook", { timeout: 30_000 }, async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readFile, readdir, mkdir, utimes, lstat, rm } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-marker-no-election-")));
  const token = "e".repeat(32), aged = new Date(Date.now() - 6 * 60_000);
  try {
    const lock = join(root, "profile.rotate.lock"), marker = `${lock}.reap-${token}`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: 2147483647, token }), { mode: 0o600 });
    await writeFile(marker, "", { mode: 0o600 });
    await utimes(marker, aged, aged);
    const ino = (await lstat(marker)).ino;
    let elections = 0, deadCleanups = 0;
    // No cleaner was elected (the name is held by the abandoned marker), so the
    // election hook must not fire: a caller waiting on it would wait forever.
    const release = await acquireRotationLock(lock, { afterCleanerElection: async () => { elections++; },
      beforeDeadOwnerCleanup: async () => { deadCleanups++; } });
    assert.equal(elections, 0, "an abandoned marker elects no cleaner");
    assert.equal(deadCleanups, 1);
    await release();
    assert.deepEqual(await readdir(root), [`profile.rotate.lock.guard`, `profile.rotate.lock.reap-${token}`].sort());
    assert.equal((await lstat(marker)).ino, ino);
    assert.equal(await readFile(marker, "utf8"), "");
    // A marker that WAS elected still fires the hook exactly once.
    const second = "c".repeat(32), other = `${lock}.reap-${second}`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, `owner-${second}.json`), JSON.stringify({ pid: 2147483647, token: second }), { mode: 0o600 });
    await writeFile(other, "", { mode: 0o600 });
    await utimes(other, aged, aged);
    const otherRelease = await acquireRotationLock(lock, { afterCleanerElection: async () => { elections++; },
      beforeDeadOwnerCleanup: async () => { deadCleanups++; } });
    assert.equal(elections, 0, "the abandoned marker of one generation elects nothing");
    assert.equal(deadCleanups, 2);
    await otherRelease();
    assert.deepEqual((await readdir(root)).filter(name => !name.endsWith(".guard")).sort(),
      [`profile.rotate.lock.reap-${token}`, `profile.rotate.lock.reap-${second}`].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-03: an aged unidentified marker never becomes evidence for another directory", { timeout: 30_000 }, async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readFile, readdir, mkdir, utimes, lstat, rm } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-marker-no-evidence-")));
  const token = "e".repeat(32), marker = `${root}/profile.rotate.lock.reap-${token}`;
  const aged = new Date(Date.now() - 6 * 60_000);
  try {
    // An ownerless empty directory plus an aged marker of ANOTHER generation.
    // The marker cannot prove anything about this directory, so recovery still
    // refuses and still names the exact path for the owner.
    const lock = join(root, "profile.rotate.lock");
    await mkdir(lock, { mode: 0o700 });
    await writeFile(marker, "", { mode: 0o600 });
    await utimes(marker, aged, aged);
    await assert.rejects(acquireRotationLock(lock), /stale but has no owner record/u);
    assert.deepEqual(await readdir(lock), []);
    const markerIno = (await lstat(marker)).ino;
    assert.equal(await readFile(marker, "utf8"), "");
    // With a proven dead cleaner for THIS directory it still recovers.
    const directory = (await lstat(lock)), stamped = JSON.stringify({ pid: 2147483647,
      processIdentity: "dead", directory: { dev: String(directory.dev), ino: String(directory.ino),
        birthtimeMs: directory.birthtimeMs } });
    await writeFile(marker, stamped, { mode: 0o600 });
    await utimes(marker, aged, aged);
    const release = await acquireRotationLock(lock, { getProcessIdentity: async () => null });
    await release();
    assert.equal((await lstat(marker)).ino, markerIno);
    assert.equal(await readFile(marker, "utf8"), stamped, "the evidence marker is retired by name, never rewritten");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-03: a generation retired inside the election hook leaves no marker of its own", { timeout: 30_000 }, async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readdir, mkdir, rm } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-generation-vanish-")));
  const token = "e".repeat(32);
  try {
    // A cleaner outside this protocol can retire the generation inside the
    // election hook. The waiter must re-observe, finish the acquisition, and
    // clean up the marker IT elected rather than leaking it for ever.
    const state = join(root, "state"), lock = join(state, "profile.rotate.lock");
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: 2147483647, token }), { mode: 0o600 });
    let once = false;
    const release = await acquireRotationLock(lock, { deadlineMs: 5000, getProcessIdentity: async () => null,
      afterCleanerElection: async () => { if (once) return; once = true; await rm(lock, { recursive: true, force: true }); } });
    await release();
    assert.deepEqual((await readdir(state)).filter(name => !name.endsWith(".guard")), [],
      "a marker this attempt elected is retired with the generation it elected for");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-03: an aged symlinked marker is judged by the link, never its target", { timeout: 30_000 }, async () => {
  const { acquireRotationLock } = await import("../scripts/fleet/connector-update.mjs");
  const { writeFile, readFile, readdir, symlink, lstat, lutimes, utimes, mkdir, rm } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-marker-symlink-age-")));
  const token = "e".repeat(32);
  try {
    // A symlink to an OLD file must not inherit that target's age and become
    // abandoned. The link's own mtime is the marker's, so a fresh link refuses.
    const lock = join(root, "fresh", "profile.rotate.lock"), marker = `${lock}.reap-${token}`;
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: 2147483647, token }), { mode: 0o600 });
    const target = join(root, "target");
    await writeFile(target, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
    const old = new Date(Date.now() - 6 * 60_000);
    await utimes(target, old, old);
    await symlink(target, marker);
    await assert.rejects(acquireRotationLock(lock), /connector_lock_cleaner_unidentified/u,
      "a fresh link to an old file is still young, so it still refuses");
    assert.ok((await lstat(marker)).isSymbolicLink(), "the refusal leaves the link alone");
    // Backdate the LINK itself (lutimes, never utimes which follows it): now it
    // is abandoned, and the file it points at is never read as the marker.
    const targetBefore = await readFile(target, "utf8");
    await lutimes(marker, old, old);
    const release = await acquireRotationLock(lock, { getProcessIdentity: async () => null });
    await release();
    assert.ok((await lstat(marker)).isSymbolicLink(), "an abandoned link is never deleted or replaced");
    assert.deepEqual((await readdir(join(root, "fresh"))).filter(name => !name.endsWith(".guard")),
      [`profile.rotate.lock.reap-${token}`]);
    assert.equal(await readFile(target, "utf8"), targetBefore, "the target of a link is never written");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K crash harness rejects a hard-timeout kill and waits for all failed cases", async () => {
  const { ownedChild } = await import("./support/r6k-owned-child.mjs");
  await assert.rejects(ownedChild(["-e", "setInterval(() => {}, 1000)"],
    async ({ closed }) => { assert.equal((await closed).signal, "SIGKILL"); }, { timeoutMs: 50 }), /hard deadline/u);
  let completed = false;
  await assert.rejects(runCrashCases([
    async () => { throw new Error("intentional-case-failure"); },
    async () => { await new Promise(done => setTimeout(done, 20)); completed = true; },
  ]), /intentional-case-failure/u);
  assert.equal(completed, true);
});

// A reaped child can no longer authorize a signal to its former group ID.
test("R6K crash harness never signals a reaped child group", async () => {
  const { ownedChild } = await import(process.env.CONTROL_ROOM_R6K_HELPER ?? "./support/r6k-owned-child.mjs");
  const originalKill = process.kill;
  try {
    await ownedChild(["-e", "process.exit(0)"], async ({ closed, kill }) => {
      assert.equal((await closed).code, 0);
      process.kill = (pid, signal) => {
        if (signal === "SIGKILL") throw new Error("reaped-group-signal");
        return originalKill(pid, signal);
      };
      kill();
    });
  } finally { process.kill = originalKill; }
});
