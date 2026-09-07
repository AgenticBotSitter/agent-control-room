import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStorageError, DisposableFilesystemArtifactStorage } from "../src/node-executor";

async function privateRoot(prefix: string): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  await chmod(parent, 0o700);
  return { parent, root: await realpath(parent) };
}

function safeCode(code: ArtifactStorageError["safeFailureCode"]) {
  return (error: unknown) => error instanceof ArtifactStorageError && error.safeFailureCode === code;
}

test("queued artifact writes retain the submitted identity, bytes and cancellation signal", async () => {
  const { parent, root } = await privateRoot("control-room-artifact-snapshot-");
  try {
    const storage = await DisposableFilesystemArtifactStorage.create(root);
    const input = { artifactId: "artifact:submitted", bytes: Uint8Array.from([1, 2, 3]) };
    const pending = storage.put(input);
    input.bytes.fill(9); input.artifactId = "artifact:changed"; input.bytes = Uint8Array.from([8]);
    const receipt = await pending;
    assert.equal(receipt.artifactId, "artifact:submitted");
    assert.deepEqual(await storage.read("artifact:submitted"), Uint8Array.from([1, 2, 3]));
    assert.equal(await storage.read("artifact:changed"), undefined);
    const controller = new AbortController();
    const cancellable = { artifactId: "artifact:cancelled", bytes: Uint8Array.from([4]), signal: controller.signal };
    const cancellation = storage.put(cancellable);
    const rejected = assert.rejects(cancellation);
    cancellable.signal = new AbortController().signal; controller.abort();
    await rejected;
    assert.equal(await storage.read("artifact:cancelled"), undefined);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("disposable storage writes exact bytes atomically and retries idempotently without exposing its root", async () => {
  const { parent, root } = await privateRoot("control-room-artifacts-");
  try {
    const storage = await DisposableFilesystemArtifactStorage.create(root, 2, 32);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const stored = await storage.put({ artifactId: "artifact:test:1", bytes });
    bytes[0] = 9;
    assert.match(stored.opaqueLocator, /^local-artifact:\/\/[a-f0-9]{64}$/u);
    assert.equal(stored.opaqueLocator.includes(root), false);
    assert.deepEqual(await storage.put({ artifactId: "artifact:test:1", bytes: Uint8Array.from([1, 2, 3, 4]) }), stored);
    await assert.rejects(storage.put({ artifactId: "artifact:test:1", bytes: Uint8Array.from([4, 3, 2, 1]) }), safeCode("storage_conflict"));
    const entries = (await import("node:fs/promises")).readdir(root);
    const names = await entries;
    assert.equal(names.length, 1);
    assert.deepEqual(Uint8Array.from(await readFile(join(root, names[0]))), Uint8Array.from([1, 2, 3, 4]));
    if (process.platform !== "win32") assert.equal(Number((await lstat(join(root, names[0]))).mode) & 0o077, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("disposable storage enforces count and byte capacity under serialized writes", async () => {
  const { parent, root } = await privateRoot("control-room-capacity-");
  try {
    const storage = await DisposableFilesystemArtifactStorage.create(root, 2, 5);
    await Promise.all([
      storage.put({ artifactId: "artifact:a", bytes: Uint8Array.from([1, 2]) }),
      storage.put({ artifactId: "artifact:b", bytes: Uint8Array.from([3, 4, 5]) }),
    ]);
    await assert.rejects(storage.put({ artifactId: "artifact:c", bytes: Uint8Array.from([6]) }), safeCode("storage_capacity"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("disposable storage rejects public, aliased, replaced, linked, and crash-ambiguous roots", async () => {
  const { parent, root } = await privateRoot("control-room-ambiguous-");
  const outside = await mkdtemp(join(tmpdir(), "control-room-outside-"));
  try {
    const publicRoot = join(outside, "public");
    await mkdir(publicRoot, { mode: 0o755 });
    if (process.platform !== "win32") {
      await assert.rejects(DisposableFilesystemArtifactStorage.create(publicRoot), safeCode("storage_invalid"));
    }

    const alias = join(outside, "alias");
    await symlink(root, alias, "dir");
    await assert.rejects(DisposableFilesystemArtifactStorage.create(alias), safeCode("storage_invalid"));

    const storage = await DisposableFilesystemArtifactStorage.create(root);
    await writeFile(join(root, ".pending-interrupted"), "orphan");
    await assert.rejects(storage.put({ artifactId: "artifact:blocked", bytes: Uint8Array.from([1]) }), safeCode("storage_ambiguous"));
    await rm(join(root, ".pending-interrupted"));

    const first = await storage.put({ artifactId: "artifact:linked", bytes: Uint8Array.from([2]) });
    const hash = first.opaqueLocator.slice("local-artifact://".length);
    await link(join(root, `${hash}.artifact`), join(root, `${"b".repeat(64)}.artifact`));
    await assert.rejects(storage.put({ artifactId: "artifact:linked", bytes: Uint8Array.from([2]) }), safeCode("storage_ambiguous"));
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("disposable storage detects replacement of its exact root directory", async () => {
  const container = await mkdtemp(join(tmpdir(), "control-room-root-swap-"));
  const configuredPath = join(container, "artifacts");
  const movedPath = join(container, "moved-artifacts");
  try {
    await mkdir(configuredPath, { mode: 0o700 });
    const storage = await DisposableFilesystemArtifactStorage.create(await realpath(configuredPath));
    await rename(configuredPath, movedPath);
    await mkdir(configuredPath, { mode: 0o700 });
    await assert.rejects(storage.put({ artifactId: "artifact:swapped", bytes: Uint8Array.from([1]) }), safeCode("storage_ambiguous"));
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});
