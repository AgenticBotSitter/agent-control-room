import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readMacLocalRollbackCheckpointWithoutWriterV1 } from "../src/web/v1/mac-local-rollback-checkpoint-store";
import { MAC_LOCAL_ROLLBACK_CHECKPOINTS_V1 } from "../src/web/v1/mac-local-rollback-checkpoint-store";
import { ROLLBACK_CHECKPOINT_SCHEMA_V1 } from "../src/security/rollback-checkpoint";

test("first-owner startup reads an existing checkpoint without a lock or write", async () => {
  const root = await mkdtemp(join(tmpdir(), "acr-readonly-checkpoint-"));
  const state = join(root, "state");
  await mkdir(state, { mode: 0o700 });
  const scope = "completion-gate:tenant:one";
  const checkpoint = { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope, revision: 1, recordCount: 0,
    stateDigest: `sha256:${"a".repeat(64)}`, stateAuthTag: `hmac-sha256:${"b".repeat(64)}` };
  await writeFile(join(state, "rollback-checkpoints.json"), JSON.stringify({ schema: MAC_LOCAL_ROLLBACK_CHECKPOINTS_V1,
    checkpoints: { [scope]: checkpoint } }), { mode: 0o600 });
  assert.deepEqual(await readMacLocalRollbackCheckpointWithoutWriterV1(root, scope), checkpoint);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(state), ["rollback-checkpoints.json"]);
  assert.equal(await readMacLocalRollbackCheckpointWithoutWriterV1(root, "completion-gate:tenant:other"), undefined);
});

test("missing checkpoint file refuses rather than initializing", async () => {
  const root = await mkdtemp(join(tmpdir(), "acr-readonly-checkpoint-"));
  await mkdir(join(root, "state"), { mode: 0o700 });
  await assert.rejects(readMacLocalRollbackCheckpointWithoutWriterV1(root, "completion-gate:tenant:one"),
    /mac_local_rollback_checkpoint_unavailable/);
});
