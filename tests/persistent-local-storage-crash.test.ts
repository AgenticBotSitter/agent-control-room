import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { killAtBoundary, runChild, runCrashCases } from "./support/r6k-owned-child.mjs";
const child = (kind: string, root: string, ...cut: string[]) =>
  ["--import", "tsx", "tests/support/r6k-crash-child.ts", kind, root, ...cut];
const rounds = Number(process.env.CONTROL_ROOM_R6K_CRASH_ROUNDS ?? 20);
test("R6K-01: SIGKILL before and after every text write step recovers exact bytes", { timeout: 1_800_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-artifact-")));
  try {
    const cases: Array<() => Promise<void>> = [];
    for (const boundary of ["kernel_stamp", "kernel_sync", "lock_open", "lock_write", "lock_sync", "pending_open", "pending_write",
      "pending_sync", "pending_close", "target_link", "pending_unlink", "lock_close", "lock_unlink",
      "root_sync_open", "root_sync", "root_sync_close"]) {
      const occurrences = boundary.startsWith("root_sync") ? [1, 2, 3] : [1];
      for (const occurrence of occurrences) for (const phase of ["before", "after"]) for (let round = 0; round < rounds; round++) {
        cases.push(async () => {
        const state = join(root, `${boundary}-${occurrence}-${phase}-${round}`); await mkdir(state, { mode: 0o700 });
        await killAtBoundary(child("artifact-write", state, boundary, phase, String(occurrence)));
        assert.equal((await runChild(child("artifact-open", state))).opened, true);
        assert.equal((await runChild(child("artifact-open", state))).prior, true);
        assert.equal((await readdir(state)).some(name => name.includes("pending-") || name.endsWith("artifact.lock")), false);
        });
      }
    }
    await runCrashCases(cases);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-01: live writer survives a second opener and restart after its kill", { timeout: 20_000 }, async () => {
  const { ownedChild } = await import("./support/r6k-owned-child.mjs");
  const { PersistentLocalArtifactStorageV1 } = await import("../src/artifacts/v1/persistent-local-storage.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-live-artifact-")));
  try {
    await ownedChild(child("artifact-write", root, "pending_sync", "hold"), async ({ child: writer, output, closed, kill }) => {
      for (let i = 0; i < 500 && !output().includes("held"); i++) await new Promise(done => setTimeout(done, 10));
      assert.ok(output().includes("held"));
      const entries = (await readdir(root)).sort();
      await assert.rejects(PersistentLocalArtifactStorageV1.create({ rootPath: root, maximumArtifacts: 100,
        maximumFileBytes: 65536, maximumTotalBytes: 1000000, operationTimeoutMs: 100 }), /storage_ambiguous/u);
      assert.deepEqual((await readdir(root)).sort(), entries);
      assert.equal(writer.exitCode, null); kill(); await closed;
    });
    assert.equal((await runChild(child("artifact-open", root))).opened, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-01: unknown files, unassociated pending and unsafe bookkeeping refuse with named reasons", async () => {
  const { PersistentLocalArtifactStorageV1 } = await import("../src/artifacts/v1/persistent-local-storage.ts");
  const { writeFile, symlink, link, readFile } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-unknown-artifact-")));
  const conf = (rootPath: string) => ({ rootPath, maximumArtifacts: 100, maximumFileBytes: 65536,
    maximumTotalBytes: 1000000, operationTimeoutMs: 2000 });
  const named = (reason: string) => (error: unknown) =>
    (error as { safeReasonCode?: string }).safeReasonCode === reason;
  try {
    for (const [kind, reason] of [["unknown", "storage_unknown_entry"], ["pending", "storage_pending_unidentified"],
      ["legacy", "storage_writer_unidentified"], ["writer-json", "storage_writer_unidentified"], ["writer-size", "storage_writer_unidentified"], ["symlink", "storage_bookkeeping_invalid"],
      ["hardlink", "storage_bookkeeping_invalid"], ["kernel-stamp", "storage_writer_unidentified"], ["kernel-stamp-json", "storage_writer_unidentified"],
      ["kernel-stamp-size", "storage_writer_unidentified"], ["kernel-stamp-pending", "storage_writer_unidentified"]]) {
      const state = join(root, kind); await mkdir(state, { mode: 0o700 });
      const lock = join(state, ".control-room-persistent-artifact.lock");
      const outside = join(root, `outside-${kind}`); await writeFile(outside, "preserve", { mode: 0o600 });
      if (kind === "unknown") await writeFile(join(state, "foreign"), "preserve", { mode: 0o600 });
      if (kind === "pending") await writeFile(join(state, ".control-room-persistent-artifact-pending-foreign"), "preserve", { mode: 0o600 });
      if (kind === "legacy") await writeFile(lock, "control-room-persistent-artifact-write\n", { mode: 0o600 });
      if (["writer-json", "writer-size"].includes(kind)) await writeFile(lock,
        JSON.stringify({ schema: kind === "writer-json" ? "foreign" : "control-room.persistent-artifact-writer/v1",
          pid: process.pid, token: "a0000000-0000-4000-8000-000000000000" }) + (kind === "writer-size" ? " ".repeat(2048) : ""), { mode: 0o600 });
      if (kind === "symlink") await symlink(outside, lock);
      if (kind === "hardlink") await link(outside, lock);
      // An empty lock is the real crash shape: the writer died between
      // lock_open and lock_write, so only the permanent guard stamp can prove
      // who owned it. A guard stamp that is not a writer record proves nobody,
      // and the recovery set behind it is left exactly as it was found.
      if (kind.startsWith("kernel-stamp")) {
        await writeFile(lock, "", { mode: 0o600 });
        const stamps: Record<string, string> = {
          "kernel-stamp": JSON.stringify({ schema: "not-a-writer", pid: 1, token: "forged" }),
          "kernel-stamp-json": JSON.stringify({ schema: "control-room.persistent-artifact-writer/v1",
            pid: process.pid, token: "not-a-uuid" }),
          "kernel-stamp-size": JSON.stringify({ schema: "control-room.persistent-artifact-writer/v1",
            pid: process.pid, token: "a0000000-0000-4000-8000-000000000000" }) + " ".repeat(2048),
          "kernel-stamp-pending": "not json at all\n",
        };
        await writeFile(join(state, ".control-room-artifact-kernel.lock"), stamps[kind], { mode: 0o600 });
        await writeFile(join(state, ".control-room-persistent-artifact-pending-forged"), "preserve", { mode: 0o600 });
      }
      await assert.rejects(PersistentLocalArtifactStorageV1.create(conf(state)), named(reason));
      assert.equal(await readFile(outside, "utf8"), "preserve");
      assert.ok((await readdir(state)).length >= 1);
      // The unidentified stamp's recovery set survives intact: the foreign
      // pending file and the guard stamp itself are never deleted.
      if (kind.startsWith("kernel-stamp")) {
        assert.deepEqual((await readdir(state)).sort(),
          [".control-room-artifact-kernel.lock", ".control-room-persistent-artifact-pending-forged",
            ".control-room-persistent-artifact.lock"].sort());
        assert.equal(await readFile(join(state, ".control-room-persistent-artifact-pending-forged"), "utf8"), "preserve");
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-01: twenty simultaneous openers and exact retries recover one crashed result", { timeout: 90_000 }, async () => {
  const { ownedChild } = await import("./support/r6k-owned-child.mjs");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-artifact-load-")));
  try {
    await killAtBoundary(child("artifact-write", root, "target_link"));
    await Promise.all(Array.from({ length: 20 }, () => ownedChild(child("artifact-open", root),
      async ({ closed, errors }) => { assert.equal((await closed).code, 0, errors()); }, { timeoutMs: 60_000 })));
    assert.equal((await readdir(root)).filter(name => name.endsWith(".artifact")).length, 1);
    assert.equal((await runChild(child("artifact-open", root))).prior, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-01: unknown entry preserves the entire identified recovery set", async () => {
  const { PersistentLocalArtifactStorageV1 } = await import("../src/artifacts/v1/persistent-local-storage.ts");
  const { writeFile } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-recovery-set-")));
  try {
    await killAtBoundary(child("artifact-write", root, "pending_sync"));
    await writeFile(join(root, "unknown"), "preserve", { mode: 0o600 });
    const entries = (await readdir(root)).sort();
    await assert.rejects(PersistentLocalArtifactStorageV1.create({ rootPath: root, maximumArtifacts: 100,
      maximumFileBytes: 65536, maximumTotalBytes: 1000000, operationTimeoutMs: 2000 }),
    (error: unknown) => (error as { safeReasonCode?: string }).safeReasonCode === "storage_unknown_entry");
    assert.deepEqual((await readdir(root)).sort(), entries);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-01: recovery refuses writer replacement at open and retirement", async () => {
  const { PersistentLocalArtifactStorageV1 } = await import("../src/artifacts/v1/persistent-local-storage.ts");
  const { readFile, unlink, writeFile, lstat } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-writer-recheck-")));
  try {
    for (const at of ["recovery_open", "recovery_stat"] as const) {
      const state = join(root, at); await mkdir(state, { mode: 0o700 });
      await killAtBoundary(child("artifact-write", state, "lock_sync"));
      const path = join(state, ".control-room-persistent-artifact.lock"), record = await readFile(path);
      const before = await lstat(path); let seen = 0;
      const replacement = at === "recovery_open" ? Buffer.from(JSON.stringify({ schema: "foreign" })) : record;
      await assert.rejects(PersistentLocalArtifactStorageV1.createForTest({ rootPath: state, maximumArtifacts: 100,
        maximumFileBytes: 65536, maximumTotalBytes: 1000000, operationTimeoutMs: 2000 }, {
        async run(boundary, operation) {
          if (boundary === at && ++seen === (at === "recovery_stat" ? 2 : 1)) {
            await unlink(path); await writeFile(path, replacement, { mode: 0o600 });
          }
          return operation();
        },
      }), (error: unknown) => (error as { safeReasonCode?: string }).safeReasonCode === "storage_writer_changed");
      assert.notEqual((await lstat(path)).ino, before.ino);
      assert.deepEqual(await readFile(path), replacement);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R6K-01: a timed-out recovery retains exclusion until its late unlink settles", async () => {
  const { PersistentLocalArtifactStorageV1 } = await import("../src/artifacts/v1/persistent-local-storage.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "r6k-recovery-timeout-")));
  let resume!: () => void;
  const allowed = new Promise<void>(done => { resume = done; });
  const conf = (timeout: number) => ({ rootPath: root, maximumArtifacts: 100, maximumFileBytes: 65536,
    maximumTotalBytes: 1000000, operationTimeoutMs: timeout });
  try {
    await killAtBoundary(child("artifact-write", root, "lock_sync"));
    await assert.rejects(PersistentLocalArtifactStorageV1.createForTest(conf(200), {
      async run(boundary, operation) { if (boundary === "recovery_unlink") await allowed; return operation(); },
    }), /storage_ambiguous/u);
    const entries = (await readdir(root)).sort();
    await assert.rejects(PersistentLocalArtifactStorageV1.create(conf(100)), /storage_ambiguous/u);
    assert.deepEqual((await readdir(root)).sort(), entries);
    resume(); await PersistentLocalArtifactStorageV1.create(conf(2000));
    assert.equal((await readdir(root)).includes(".control-room-persistent-artifact.lock"), false);
  } finally { resume(); await rm(root, { recursive: true, force: true }); }
});
