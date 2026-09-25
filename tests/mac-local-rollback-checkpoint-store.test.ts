import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openMacLocalRollbackCheckpointStoreV1 } from "../src/web/v1/mac-local-rollback-checkpoint-store";
import { ROLLBACK_CHECKPOINT_SCHEMA_V1, rollbackCheckpointDigestV1, type RollbackCheckpointV1 } from "../src/security/rollback-checkpoint";

const scope = "completion-gate:tenant:mac-local";
const hex = (byte: string) => byte.repeat(64);
const checkpoint = (revision: number, fill = String(revision % 10)): RollbackCheckpointV1 => ({ schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope,
  revision, recordCount: revision - 1, stateDigest: `sha256:${hex(fill)}`, stateAuthTag: `hmac-sha256:${hex(fill)}` });
const dead = { pid: 424242, alive: () => false };

async function root(t: { after(fn: () => unknown): void }) {
  const value = await mkdtemp(join(tmpdir(), "acr-checkpoint-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  await chmod(value, 0o700);
  return value;
}

test("initialize, read and compare-and-swap advance persist durably in private files", async t => {
  const r = await root(t);
  const store = await openMacLocalRollbackCheckpointStoreV1(r);
  assert.equal(await store.read(scope), undefined);
  await store.initialize(checkpoint(1));
  await store.advance(rollbackCheckpointDigestV1(checkpoint(1)), checkpoint(2));
  assert.deepEqual(await store.read(scope), checkpoint(2));
  assert.equal((await stat(join(r, "state"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(r, "state/rollback-checkpoints.json"))).mode & 0o777, 0o600);
  await store.close();
  const reopened = await openMacLocalRollbackCheckpointStoreV1(r);
  assert.deepEqual(await reopened.read(scope), checkpoint(2));
  await reopened.close();
  assert.deepEqual((await readdir(join(r, "state"))).sort(), ["rollback-checkpoints.json"], "no temporary or lock file is left");
});

test("every non-matching write is refused and leaves the file unchanged", async t => {
  const r = await root(t), file = join(r, "state/rollback-checkpoints.json");
  const store = await openMacLocalRollbackCheckpointStoreV1(r);
  await assert.rejects(store.initialize(checkpoint(2)), /conflict/u);
  await store.initialize(checkpoint(1));
  const before = await readFile(file, "utf8");
  await assert.rejects(store.initialize(checkpoint(1)), /conflict/u);
  await assert.rejects(store.advance(rollbackCheckpointDigestV1(checkpoint(1, "9")), checkpoint(2)), /conflict/u);
  await assert.rejects(store.advance(rollbackCheckpointDigestV1(checkpoint(1)), checkpoint(3)), /conflict/u);
  await assert.rejects(store.advance(rollbackCheckpointDigestV1(checkpoint(1)), { ...checkpoint(2), scope: "completion-gate:other" }), /conflict/u);
  assert.equal(await readFile(file, "utf8"), before);
  await store.close();
});

test("a file rolled back to an older copy is detected, not accepted", async t => {
  const r = await root(t), file = join(r, "state/rollback-checkpoints.json"), old = join(r, "old.json");
  const store = await openMacLocalRollbackCheckpointStoreV1(r);
  await store.initialize(checkpoint(1));
  await copyFile(file, old);
  await store.advance(rollbackCheckpointDigestV1(checkpoint(1)), checkpoint(2));
  await copyFile(old, file);
  await chmod(file, 0o600);
  // The caller (the review system) still holds revision 2 as current state.
  await assert.rejects(store.advance(rollbackCheckpointDigestV1(checkpoint(2)), checkpoint(3)), /conflict/u);
  await store.close();
});

test("a second live holder is refused; a lock left by a dead process is taken over", async t => {
  const r = await root(t);
  const first = await openMacLocalRollbackCheckpointStoreV1(r);
  await assert.rejects(openMacLocalRollbackCheckpointStoreV1(r, { pid: process.pid + 1, alive: () => true }), /unavailable/u);
  await first.close();
  await writeFile(join(r, "state/rollback-checkpoints.lock"), "424243\n", { mode: 0o600 });
  const second = await openMacLocalRollbackCheckpointStoreV1(r, dead);
  await second.initialize(checkpoint(1));
  await second.close();
  assert.equal(await readFile(join(r, "state/rollback-checkpoints.lock"), "utf8").catch(() => "gone"), "gone");
});

test("tampered, readable-by-others or symlinked files are refused without echoing content", async t => {
  const r = await root(t), file = join(r, "state/rollback-checkpoints.json");
  const store = await openMacLocalRollbackCheckpointStoreV1(r);
  await store.initialize(checkpoint(1));
  const valid = await readFile(file, "utf8");
  const wrongScope = valid.replace(`"scope":"${scope}"`, `"scope":"completion-gate:tenant:other"`);
  for (const content of ["not json", wrongScope, "{\"schema\":\"x\",\"checkpoints\":{}}\n"]) {
    await writeFile(file, content, { mode: 0o600 });
    await assert.rejects(store.read(scope), error => error instanceof Error && error.message === "mac_local_rollback_checkpoint_unavailable");
  }
  await writeFile(file, valid, { mode: 0o600 });
  await chmod(file, 0o644);
  await assert.rejects(store.read(scope), /unavailable/u);
  await chmod(file, 0o600);
  await rm(file); await writeFile(join(r, "elsewhere.json"), valid, { mode: 0o600 });
  await symlink(join(r, "elsewhere.json"), file);
  await assert.rejects(store.read(scope), /unavailable/u);
  await store.close();
});

test("an open is refused for a relative root or a non-private protected root", async t => {
  await assert.rejects(openMacLocalRollbackCheckpointStoreV1("relative/root"), /unavailable/u);
  const r = await root(t);
  await chmod(r, 0o755);
  await assert.rejects(openMacLocalRollbackCheckpointStoreV1(r), /unavailable/u);
  await chmod(r, 0o700);
  await mkdir(join(r, "state"), { mode: 0o755 }); await chmod(join(r, "state"), 0o755);
  await assert.rejects(openMacLocalRollbackCheckpointStoreV1(r), /unavailable/u);
});

test("an aborted signal and a closed store both refuse", async t => {
  const r = await root(t);
  const store = await openMacLocalRollbackCheckpointStoreV1(r);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.initialize(checkpoint(1), controller.signal), /unavailable/u);
  assert.equal(await store.read(scope), undefined);
  await store.close();
  await assert.rejects(store.read(scope), /unavailable/u);
});
