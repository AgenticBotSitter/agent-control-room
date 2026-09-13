import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeResultId } from "../src/artifacts/v1/native-results";
import { openPrivateArtifactStorageV1, privateArtifactStorageNamespaceDigestV1,
  type PrivateArtifactStorageConfigurationV1 } from
  "../src/web/v1/private-artifact-storage";
import { sha256Digest } from "../src/security";

const configuration = (rootPath: string): PrivateArtifactStorageConfigurationV1 => ({
  local: { rootPath, maximumArtifacts: 10, maximumFileBytes: 65_536,
    maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000 },
  inventory: { releaseId: "release:restart", releaseDigest: sha256Digest("release"),
    databaseSchemaVersion: "schema:71", databaseSchemaDigest: sha256Digest("schema"),
    storageNamespace: "artifact-namespace:restart",
    storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1("artifact-namespace:restart", rootPath) },
});

test("clean restart opens and reads the exact create-once bytes", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-artifact-restart-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactId = nativeResultId("tenant:restart", "run:restart");
  const bytes = new TextEncoder().encode("Exact bytes survive restart.");
  const first = await openPrivateArtifactStorageV1(configuration(root));
  const receipt = await first.storage.put({ artifactId, bytes });
  const restarted = await openPrivateArtifactStorageV1(configuration(root));
  assert.deepEqual(await restarted.storage.read(artifactId), bytes);
  assert.deepEqual(await restarted.storage.put({ artifactId, bytes }), receipt);
});

test("wrong root, corrupt bytes, stale lock and canceled inventory are refused without repair", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-artifact-corrupt-")));
  const wrongRoot = await realpath(await mkdtemp(join(tmpdir(), "control-room-artifact-wrong-root-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(wrongRoot, { recursive: true, force: true })]));
  const artifactId = nativeResultId("tenant:restart", "run:corrupt");
  const opened = await openPrivateArtifactStorageV1(configuration(root));
  await opened.storage.put({ artifactId, bytes: new TextEncoder().encode("Do not return corrupt bytes.") });
  const name = (await readdir(root)).find(value => value.endsWith(".artifact"));
  assert.ok(name);
  await writeFile(join(root, name), "corrupt", { mode: 0o600 });
  await assert.rejects(openPrivateArtifactStorageV1(configuration(root)), /storage_ambiguous/);

  await writeFile(join(wrongRoot, ".control-room-persistent-artifact.lock"), "foreign\n", { mode: 0o600 });
  await assert.rejects(openPrivateArtifactStorageV1(configuration(wrongRoot)), /storage_ambiguous/);
  const originalBinding = configuration(root);
  await assert.rejects(openPrivateArtifactStorageV1({ ...originalBinding,
    local: { ...originalBinding.local, rootPath: wrongRoot } }), /private_artifact_storage_unavailable/);

  const empty = await realpath(await mkdtemp(join(tmpdir(), "control-room-artifact-canceled-")));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const canceled = await openPrivateArtifactStorageV1(configuration(empty));
  await assert.rejects(canceled.captureInventory({ query: async <T>() => ({ rows: [] as T[] }) },
    "tenant:restart", new Uint8Array(32), AbortSignal.abort()), /private_artifact_storage_unavailable/);
});
