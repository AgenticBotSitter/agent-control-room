import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, unlink,
  writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createPersistentLocalArtifactStorageV1,
  createPersistentLocalArtifactStorageForTestV1,
  type PersistentLocalArtifactStorageConfigurationV1,
  type PersistentLocalArtifactStorageIoBoundaryV1,
  type PersistentLocalArtifactStorageTestIoV1,
} from "../src/artifacts/v1/persistent-local-storage";
import { nativeResultId, resultBytesHash } from "../src/artifacts/v1/native-results";
import { ArtifactStorageError } from "../src/node-executor/artifact-storage";

const text = (value: string) => new TextEncoder().encode(value);
const id = (suffix: string) => nativeResultId("tenant:persistent-test", `run:${suffix}`);

function storageError(code: ArtifactStorageError["safeFailureCode"]): (error: unknown) => boolean {
  return error => error instanceof ArtifactStorageError && error.safeFailureCode === code;
}

async function privateRoot(t: TestContext): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "control-room-persistent-artifacts-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function configuration(
  rootPath: string,
  overrides: Partial<PersistentLocalArtifactStorageConfigurationV1> = {},
): PersistentLocalArtifactStorageConfigurationV1 {
  return {
    rootPath,
    maximumArtifacts: 10,
    maximumFileBytes: 65_536,
    maximumTotalBytes: 655_360,
    operationTimeoutMs: 2_000,
    ...overrides,
  };
}

async function artifactFile(root: string): Promise<string> {
  const entries = await readdir(root);
  const artifact = entries.find(entry => entry.endsWith(".artifact"));
  assert.ok(artifact, "one artifact file exists");
  return join(root, artifact);
}

class ControlledIo implements PersistentLocalArtifactStorageTestIoV1 {
  hits = 0;
  private enteredResolve!: () => void;
  readonly entered = new Promise<void>(resolve => { this.enteredResolve = resolve; });

  constructor(
    private readonly selected: PersistentLocalArtifactStorageIoBoundaryV1,
    private readonly mode: "fail_before" | "fail_after" | "wait",
  ) {}

  async run<T>(boundary: PersistentLocalArtifactStorageIoBoundaryV1, operation: () => Promise<T>): Promise<T> {
    if (boundary !== this.selected) return operation();
    this.hits++;
    this.enteredResolve();
    if (this.mode === "fail_before") throw new Error("injected_filesystem_failure");
    if (this.mode === "wait") return new Promise<T>(() => {});
    const value = await operation();
    throw new Error("injected_uncertain_filesystem_reply");
  }
}

async function assertRetainedUncertainty(root: string, storage: Awaited<ReturnType<
  typeof createPersistentLocalArtifactStorageForTestV1>>, gate: ControlledIo): Promise<string[]> {
  const entries = await readdir(root);
  assert.ok(entries.includes(".control-room-persistent-artifact.lock"));
  assert.ok(entries.some(entry => entry.startsWith(".control-room-persistent-artifact-pending-")));
  const hits = gate.hits;
  await assert.rejects(storage.put({ artifactId: id("subsequent-refused"), bytes: text("Never retried.") }),
    storageError("storage_ambiguous"));
  assert.equal(gate.hits, hits);
  await assert.rejects(createPersistentLocalArtifactStorageV1(configuration(root)),
    storageError("storage_ambiguous"));
  assert.deepEqual(await readdir(root), entries);
  return entries;
}

test("create-once bytes replay exactly after a new adapter opens the same private root", async t => {
  const root = await privateRoot(t);
  const first = await createPersistentLocalArtifactStorageV1(configuration(root));
  const artifactId = id("durable-replay");
  const bytes = text("A durable native result.");

  const stored = await first.put({ artifactId, bytes });
  assert.deepEqual(stored, {
    artifactId,
    opaqueLocator: stored.opaqueLocator,
    contentHash: resultBytesHash(bytes),
    sizeBytes: bytes.byteLength,
  });
  assert.match(stored.opaqueLocator, /^control-room-artifact:v1:[a-f0-9]{64}$/u);
  assert.equal(stored.opaqueLocator.includes(root), false);
  assert.deepEqual(await first.read(artifactId), bytes);

  const restarted = await createPersistentLocalArtifactStorageV1(configuration(root));
  assert.deepEqual(await restarted.read(artifactId), bytes);
  assert.deepEqual(await restarted.put({ artifactId, bytes }), stored);
  assert.deepEqual((await readdir(root)).filter(entry => entry.endsWith(".artifact")).length, 1);
});

test("submitted buffers are captured synchronously and returned reads are copies", async t => {
  const root = await privateRoot(t);
  const storage = await createPersistentLocalArtifactStorageV1(configuration(root));
  const artifactId = id("buffer-custody");
  const submitted = text("Captured before caller mutation.");
  const expected = Uint8Array.from(submitted);
  const pending = storage.put({ artifactId, bytes: submitted });
  submitted.fill(0x78);
  await pending;
  const read = await storage.read(artifactId);
  assert.deepEqual(read, expected);
  read!.fill(0x79);
  assert.deepEqual(await storage.read(artifactId), expected);
});

test("exact replay is idempotent while conflicting bytes refuse without replacement", async t => {
  const root = await privateRoot(t);
  const storage = await createPersistentLocalArtifactStorageV1(configuration(root));
  const artifactId = id("conflict");
  const original = text("Original immutable bytes.");
  const first = await storage.put({ artifactId, bytes: original });
  assert.deepEqual(await storage.put({ artifactId, bytes: Uint8Array.from(original) }), first);
  await assert.rejects(storage.put({ artifactId, bytes: text("Conflicting immutable bytes.") }),
    storageError("storage_conflict"));
  assert.deepEqual(await storage.read(artifactId), original);
});

test("concurrent conflicting writers create at most one immutable artifact", async t => {
  const root = await privateRoot(t);
  const left = await createPersistentLocalArtifactStorageV1(configuration(root));
  const right = await createPersistentLocalArtifactStorageV1(configuration(root));
  const artifactId = id("concurrent-conflict");
  const leftBytes = text("Left concurrent bytes.");
  const rightBytes = text("Right concurrent bytes.");
  const outcomes = await Promise.allSettled([
    left.put({ artifactId, bytes: leftBytes }),
    right.put({ artifactId, bytes: rightBytes }),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  const rejection = outcomes.find(outcome => outcome.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejection.reason instanceof ArtifactStorageError);
  assert.ok(["storage_conflict", "storage_ambiguous"].includes(rejection.reason.safeFailureCode));
  const restarted = await createPersistentLocalArtifactStorageV1(configuration(root));
  const persisted = await restarted.read(artifactId);
  assert.ok(Buffer.from(persisted!).equals(Buffer.from(leftBytes)) || Buffer.from(persisted!).equals(Buffer.from(rightBytes)));
  assert.equal((await readdir(root)).filter(entry => entry.endsWith(".artifact")).length, 1);
});

test("file, total-byte, and artifact-count quotas fail before a second durable object", async t => {
  const fileRoot = await privateRoot(t);
  const fileStorage = await createPersistentLocalArtifactStorageV1(configuration(fileRoot, {
    maximumArtifacts: 3, maximumFileBytes: 8, maximumTotalBytes: 24,
  }));
  await assert.rejects(fileStorage.put({ artifactId: id("file-quota"), bytes: text("nine-byte") }),
    storageError("storage_capacity"));
  assert.deepEqual(await readdir(fileRoot), []);

  const totalRoot = await privateRoot(t);
  const totalStorage = await createPersistentLocalArtifactStorageV1(configuration(totalRoot, {
    maximumArtifacts: 3, maximumFileBytes: 12, maximumTotalBytes: 20,
  }));
  await totalStorage.put({ artifactId: id("total-one"), bytes: text("twelve-bytes") });
  await assert.rejects(totalStorage.put({ artifactId: id("total-two"), bytes: text("nine-byte") }),
    storageError("storage_capacity"));
  assert.equal((await readdir(totalRoot)).filter(entry => entry.endsWith(".artifact")).length, 1);

  const countRoot = await privateRoot(t);
  const countStorage = await createPersistentLocalArtifactStorageV1(configuration(countRoot, { maximumArtifacts: 1 }));
  await countStorage.put({ artifactId: id("count-one"), bytes: text("first") });
  await assert.rejects(countStorage.put({ artifactId: id("count-two"), bytes: text("second") }),
    storageError("storage_capacity"));
});

test("invalid, traversal, absolute, URL, and alternate-separator artifact identities never reach disk", async t => {
  const root = await privateRoot(t);
  const storage = await createPersistentLocalArtifactStorageV1(configuration(root));
  const invalid = ["../escape", "/private/tmp/escape", "C:\\escape", "folder/artifact", "folder\\artifact",
    "file:///private/tmp/escape", "https://example.invalid/artifact", "artifact:native:not-a-digest"];
  for (const artifactId of invalid) {
    await assert.rejects(storage.put({ artifactId, bytes: text("safe") }), storageError("storage_invalid"));
    await assert.rejects(storage.read(artifactId), storageError("storage_invalid"));
  }
  assert.deepEqual(await readdir(root), []);
});

test("invalid result bytes and non-canonical or non-private roots refuse safely", async t => {
  const root = await privateRoot(t);
  const storage = await createPersistentLocalArtifactStorageV1(configuration(root));
  await assert.rejects(storage.put({ artifactId: id("invalid-utf8"), bytes: Uint8Array.of(0xc3, 0x28) }),
    storageError("storage_invalid"));
  assert.deepEqual(await readdir(root), []);

  if (process.platform !== "win32") {
    const broad = await privateRoot(t);
    await chmod(broad, 0o755);
    await assert.rejects(createPersistentLocalArtifactStorageV1(configuration(broad)), storageError("storage_invalid"));
  }
  const alias = `${root}-alias`;
  await symlink(root, alias);
  t.after(() => rm(alias, { force: true }));
  await assert.rejects(createPersistentLocalArtifactStorageV1(configuration(alias)), storageError("storage_invalid"));
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
});

test("mutation and truncation are detected from the persistent envelope and never returned", async t => {
  const mutationRoot = await privateRoot(t);
  const mutationStorage = await createPersistentLocalArtifactStorageV1(configuration(mutationRoot));
  const mutationId = id("mutation");
  await mutationStorage.put({ artifactId: mutationId, bytes: text("Mutation detection bytes.") });
  const mutationPath = await artifactFile(mutationRoot);
  const changed = await readFile(mutationPath);
  changed[changed.byteLength - 1] ^= 1;
  await writeFile(mutationPath, changed);
  await assert.rejects(mutationStorage.read(mutationId), storageError("storage_ambiguous"));
  await assert.rejects(createPersistentLocalArtifactStorageV1(configuration(mutationRoot)),
    storageError("storage_ambiguous"));
  assert.equal((await lstat(mutationPath)).isFile(), true);

  const truncationRoot = await privateRoot(t);
  const truncationStorage = await createPersistentLocalArtifactStorageV1(configuration(truncationRoot));
  const truncationId = id("truncation");
  await truncationStorage.put({ artifactId: truncationId, bytes: text("Truncation detection bytes.") });
  const truncationPath = await artifactFile(truncationRoot);
  const size = (await lstat(truncationPath)).size;
  await truncate(truncationPath, Math.max(1, size - 5));
  await assert.rejects(truncationStorage.read(truncationId), storageError("storage_ambiguous"));
  await assert.rejects(createPersistentLocalArtifactStorageV1(configuration(truncationRoot)),
    storageError("storage_ambiguous"));
  assert.equal((await lstat(truncationPath)).isFile(), true);
});

test("symlink, hardlink, and root-path substitution refuse without deleting evidence", async t => {
  const symlinkRoot = await privateRoot(t);
  const outside = join(await privateRoot(t), "outside");
  await writeFile(outside, "foreign", { mode: 0o600 });
  const foreignLink = join(symlinkRoot, "foreign-link");
  await symlink(outside, foreignLink);
  await assert.rejects(createPersistentLocalArtifactStorageV1(configuration(symlinkRoot)),
    storageError("storage_ambiguous"));
  assert.equal((await lstat(foreignLink)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, "utf8"), "foreign");

  const targetLinkRoot = await privateRoot(t);
  const targetLinkStorage = await createPersistentLocalArtifactStorageV1(configuration(targetLinkRoot));
  const targetLinkId = id("target-symlink");
  await targetLinkStorage.put({ artifactId: targetLinkId, bytes: text("Original target bytes.") });
  const targetLinkPath = await artifactFile(targetLinkRoot);
  await unlink(targetLinkPath);
  await symlink(outside, targetLinkPath);
  await assert.rejects(targetLinkStorage.read(targetLinkId), storageError("storage_ambiguous"));
  assert.equal((await lstat(targetLinkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, "utf8"), "foreign");

  const hardlinkRoot = await privateRoot(t);
  const hardlinkStorage = await createPersistentLocalArtifactStorageV1(configuration(hardlinkRoot));
  const hardlinkId = id("hardlink");
  await hardlinkStorage.put({ artifactId: hardlinkId, bytes: text("Hardlink detection bytes.") });
  const hardlinkArtifact = await artifactFile(hardlinkRoot);
  const secondName = join(await privateRoot(t), "second-link");
  await link(hardlinkArtifact, secondName);
  await assert.rejects(hardlinkStorage.read(hardlinkId), storageError("storage_ambiguous"));
  assert.equal((await lstat(hardlinkArtifact)).nlink, 2);
  assert.equal((await lstat(secondName)).nlink, 2);

  const originalRoot = await privateRoot(t);
  const substitutedStorage = await createPersistentLocalArtifactStorageV1(configuration(originalRoot));
  const movedRoot = `${originalRoot}-moved`;
  await rename(originalRoot, movedRoot);
  t.after(() => rm(movedRoot, { recursive: true, force: true }));
  await mkdir(originalRoot, { mode: 0o700 });
  const marker = join(originalRoot, "foreign-marker");
  await writeFile(marker, "preserve", { mode: 0o600 });
  await assert.rejects(substitutedStorage.read(id("path-substitution")), storageError("storage_ambiguous"));
  assert.equal(await readFile(marker, "utf8"), "preserve");
});

test("stale lock and pending evidence are never recovered or deleted", async t => {
  const lockedRoot = await privateRoot(t);
  const storage = await createPersistentLocalArtifactStorageV1(configuration(lockedRoot));
  const lockPath = join(lockedRoot, ".control-room-persistent-artifact.lock");
  await writeFile(lockPath, "unresolved prior writer\n", { mode: 0o600 });
  await assert.rejects(storage.put({ artifactId: id("locked"), bytes: text("Never written.") }),
    storageError("storage_ambiguous"));
  assert.equal(await readFile(lockPath, "utf8"), "unresolved prior writer\n");
  await assert.rejects(createPersistentLocalArtifactStorageV1(configuration(lockedRoot)),
    storageError("storage_ambiguous"));
  assert.equal(await readFile(lockPath, "utf8"), "unresolved prior writer\n");

  const pendingRoot = await privateRoot(t);
  const pendingPath = join(pendingRoot, ".control-room-persistent-artifact-pending-foreign");
  await writeFile(pendingPath, "uncertain partial bytes", { mode: 0o600 });
  await assert.rejects(createPersistentLocalArtifactStorageV1(configuration(pendingRoot)),
    storageError("storage_ambiguous"));
  assert.equal(await readFile(pendingPath, "utf8"), "uncertain partial bytes");
});

test("filesystem failures after mutation starts poison the adapter and retain reconciliation evidence", async t => {
  for (const [boundary, mode, targetExpected] of [
    ["pending_write", "fail_after", false],
    ["target_link", "fail_after", true],
    ["pending_unlink", "fail_before", true],
  ] as const) {
    await t.test(boundary, async t => {
      const root = await privateRoot(t);
      const gate = new ControlledIo(boundary, mode);
      const storage = await createPersistentLocalArtifactStorageForTestV1(configuration(root), gate);
      await assert.rejects(storage.put({ artifactId: id(`failure-${boundary}`), bytes: text("Uncertain boundary bytes.") }),
        storageError("storage_ambiguous"));
      assert.equal(gate.hits, 1);
      const entries = await assertRetainedUncertainty(root, storage, gate);
      assert.equal(entries.some(entry => entry.endsWith(".artifact")), targetExpected);
    });
  }
});

test("in-flight cancellation after pending bytes exist withholds output and forbids reuse", async t => {
  const root = await privateRoot(t);
  const gate = new ControlledIo("pending_sync", "wait");
  const storage = await createPersistentLocalArtifactStorageForTestV1(configuration(root), gate);
  const controller = new AbortController();
  const pending = storage.put({ artifactId: id("in-flight-cancel"), bytes: text("Cancel after mutation."),
    signal: controller.signal });
  await gate.entered;
  controller.abort();
  await assert.rejects(pending, storageError("storage_ambiguous"));
  assert.equal(gate.hits, 1);
  await assertRetainedUncertainty(root, storage, gate);
});

test("in-flight durability timeout preserves linked and pending evidence and forbids reuse", async t => {
  const root = await privateRoot(t);
  const gate = new ControlledIo("root_sync", "wait");
  const storage = await createPersistentLocalArtifactStorageForTestV1(
    configuration(root, { operationTimeoutMs: 200 }), gate);
  await assert.rejects(storage.put({ artifactId: id("in-flight-timeout"), bytes: text("Timeout after target link.") }),
    storageError("storage_ambiguous"));
  assert.equal(gate.hits, 1);
  const entries = await assertRetainedUncertainty(root, storage, gate);
  assert.equal(entries.filter(entry => entry.endsWith(".artifact")).length, 1);
});

test("pre-cancelled calls and zero-deadline startup perform no storage mutation", async t => {
  const root = await privateRoot(t);
  const storage = await createPersistentLocalArtifactStorageV1(configuration(root));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(storage.put({ artifactId: id("cancelled-write"), bytes: text("Not written."),
    signal: cancelled.signal }), error => error instanceof Error && error.name === "AbortError");
  await assert.rejects(storage.read(id("cancelled-read"), cancelled.signal),
    error => error instanceof Error && error.name === "AbortError");
  assert.deepEqual(await readdir(root), []);

  const timeoutRoot = await privateRoot(t);
  await assert.rejects(createPersistentLocalArtifactStorageV1(configuration(timeoutRoot, { operationTimeoutMs: 0 })),
    storageError("storage_ambiguous"));
  assert.deepEqual(await readdir(timeoutRoot), []);
});
