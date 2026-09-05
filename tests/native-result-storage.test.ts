import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DisposableFilesystemArtifactStorage } from "../src/node-executor/artifact-storage";
import { NativeResultStore } from "../src/artifacts/v1/native-results";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";

test("private filesystem result read survives adapter reopen and returns owned bounded copies", async t => {
  const owned = await mkdtemp(join(tmpdir(), "cr14c-result-read-")); t.after(() => rm(owned, { recursive: true, force: true }));
  await chmod(owned, 0o700); const root = await realpath(owned), storage = await DisposableFilesystemArtifactStorage.create(root);
  assert.equal(await storage.read("artifact:missing"), undefined);
  for (const [id, text] of [["artifact:empty", ""], ["artifact:unicode", "Useful result café"], ["artifact:full", "x".repeat(65_536)]]) {
    const bytes = new TextEncoder().encode(text); await storage.put({ artifactId: id, bytes });
    const reopened = await DisposableFilesystemArtifactStorage.create(root); const read = await reopened.read(id);
    assert.deepEqual(read, bytes); if (read?.length) read[0] = 0;
    assert.deepEqual(await reopened.read(id), bytes);
  }
});

test("native receipt can read actual disposable local artifact storage after reopening its adapter", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const owned = await mkdtemp(join(tmpdir(), "cr14c-result-file-")); t.after(() => rm(owned, { recursive: true, force: true }));
  await chmod(owned, 0o700); const root = await realpath(owned), storage = await DisposableFilesystemArtifactStorage.create(root);
  const input = f.complete("Result retained in local artifact bytes"); await f.service.ingest(input.raw, f.options(at(2000)));
  const store = new NativeResultStore(f.db, f.harnessKey, { ...f.config, storage });
  const { receipt } = await store.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000));
  const reopened = new NativeResultStore(f.db, f.harnessKey, { ...f.config, storage: await DisposableFilesystemArtifactStorage.create(root) });
  const content = await f.db.transaction(tx => reopened.read(tx, binding.tenantId, binding.projectId, binding.jobId, receipt.artifactId));
  assert.equal(content?.text, "Result retained in local artifact bytes");
});
