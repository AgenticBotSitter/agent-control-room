import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createFilesystemOwnerBootstrapLifecycleStoreV1 } from "../src/web/v1/owner-bootstrap-ceremony/filesystem-lifecycle";

async function prepared(t: import("node:test").TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acr-owner-bootstrap-")));
  await chmod(directory, 0o700); t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "owner-bootstrap.lifecycle");
  return { directory, marker, store: createFilesystemOwnerBootstrapLifecycleStoreV1({
    runtimeDirectory: directory, markerPath: marker, ownerUid: process.getuid?.() ?? -1,
  }) };
}

test("filesystem lifecycle atomically retains claimed then complete state", async t => {
  const x = await prepared(t), signal = new AbortController().signal;
  assert.equal(await x.store.inspect(), "available");
  await x.store.claim(signal);
  assert.equal(await x.store.inspect(), "claimed");
  await assert.rejects(x.store.claim(signal), /unavailable/);
  await x.store.complete(signal);
  assert.equal(await x.store.inspect(), "complete");
  await assert.rejects(x.store.complete(signal), /unavailable/);
});

test("filesystem lifecycle refuses unsafe directories and markers without replacing them", async t => {
  const x = await prepared(t), signal = new AbortController().signal;
  await chmod(x.directory, 0o755);
  await assert.rejects(x.store.inspect(), /unavailable/);
  await chmod(x.directory, 0o700);
  await writeFile(x.marker, "not-a-state\n", { mode: 0o600 });
  await assert.rejects(x.store.inspect(), /unavailable/);
  await rm(x.marker);
  await symlink("/tmp", x.marker);
  await assert.rejects(x.store.claim(signal), /unavailable/);
});

test("filesystem lifecycle rejects escaping or caller-selected marker locations", () => {
  const directory = join(tmpdir(), "acr-owner-bootstrap-shape");
  assert.throws(() => createFilesystemOwnerBootstrapLifecycleStoreV1({ runtimeDirectory: directory,
    markerPath: join(directory, "other"), ownerUid: 1 }), /unavailable/);
  assert.throws(() => createFilesystemOwnerBootstrapLifecycleStoreV1({ runtimeDirectory: directory,
    markerPath: join(directory, "..", "owner-bootstrap.lifecycle"), ownerUid: 1 }), /unavailable/);
});
