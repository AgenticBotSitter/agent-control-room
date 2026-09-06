import assert from "node:assert/strict";
import test from "node:test";
import { stageCompletionCheckpoint } from "../src/completion-gate/v1/staged-checkpoint";
import { InMemoryRollbackCheckpointStoreV1, ROLLBACK_CHECKPOINT_SCHEMA_V1, rollbackCheckpointDigestV1 } from "../src/security/rollback-checkpoint";
const initial = { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: "completion-gate:tenant:test", revision: 1,
  recordCount: 0, stateDigest: `sha256:${"a".repeat(64)}`, stateAuthTag: `hmac-sha256:${"b".repeat(64)}` };
function fixture() { const store = new InMemoryRollbackCheckpointStoreV1({ testOnly: true }); store.initialize(initial); return store; }

test("staged review checkpoints keep the durable anchor unchanged until one-use flush", () => {
  const store = fixture(), stage = stageCompletionCheckpoint(store, "tenant:test");
  const next = { ...initial, revision: 2, recordCount: 1 }, final = { ...initial, revision: 3, recordCount: 2 };
  stage.checkpoints.advance(rollbackCheckpointDigestV1(initial), next);
  stage.checkpoints.advance(rollbackCheckpointDigestV1(next), final);
  assert.deepEqual(store.read(initial.scope), initial); assert.deepEqual(stage.checkpoints.read(initial.scope), final);
  stage.flush(); assert.deepEqual(store.read(initial.scope), final);
  assert.throws(() => stage.flush()); assert.throws(() => stage.checkpoints.read(initial.scope));
  assert.deepEqual(store.read(initial.scope), final);
});

test("abandonment, input mutation, wrong scope, provisioning and excess writes cannot change the anchor", () => {
  const store = fixture(), stage = stageCompletionCheckpoint(store, "tenant:test");
  const copy = stage.checkpoints.read(initial.scope)!; copy.revision = 999;
  assert.equal(stage.checkpoints.read(initial.scope)!.revision, 1);
  assert.throws(() => stage.checkpoints.read("completion-gate:tenant:other"));
  assert.throws(() => stage.checkpoints.initialize(initial));
  assert.throws(() => stage.checkpoints.advance(rollbackCheckpointDigestV1(initial), { ...initial, revision: 3 }));
  for (const n of [2, 3]) {
    const current = stage.checkpoints.read(initial.scope)!;
    stage.checkpoints.advance(rollbackCheckpointDigestV1(current), { ...current, revision: n });
  }
  const current = stage.checkpoints.read(initial.scope)!;
  assert.throws(() => stage.checkpoints.advance(rollbackCheckpointDigestV1(current), { ...current, revision: 4 }));
  assert.deepEqual(store.read(initial.scope), initial); // Discarding the stage cannot commit it.
});

test("external conflict and partial flush are terminal for that stage, with no rollback or implicit retry", () => {
  const store = fixture(); let calls = 0;
  const stage = stageCompletionCheckpoint({ read: store.read.bind(store), initialize: () => { throw new Error(); },
    advance(expected, next) { calls++; if (calls === 2) throw new Error("synthetic_cas_uncertain"); store.advance(expected, next); } }, "tenant:test");
  const next = { ...initial, revision: 2 }, final = { ...initial, revision: 3 };
  stage.checkpoints.advance(rollbackCheckpointDigestV1(initial), next); stage.checkpoints.advance(rollbackCheckpointDigestV1(next), final);
  assert.throws(() => stage.flush()); assert.equal(store.read(initial.scope)!.revision, 2);
  assert.throws(() => stage.flush()); assert.equal(calls, 2);
});

test("an empty stage never initializes or advances durable storage", () => {
  let writes = 0;
  const stage = stageCompletionCheckpoint({ read: () => undefined, initialize() { writes++; }, advance() { writes++; } }, "tenant:test");
  assert.equal(stage.checkpoints.read(initial.scope), undefined); stage.flush(); assert.equal(writes, 0);
});

test("explicit automated batches permit fifty sequential advances but never widen the default bound", () => {
  const store = fixture(), stage = stageCompletionCheckpoint(store, "tenant:test", 50);
  for (let n = 0; n < 50; n++) {
    const current = stage.checkpoints.read(initial.scope)!;
    stage.checkpoints.advance(rollbackCheckpointDigestV1(current), { ...current, revision: current.revision + 1, recordCount: current.recordCount + 1 });
  }
  const current = stage.checkpoints.read(initial.scope)!;
  assert.equal(current.revision, 51); assert.deepEqual(store.read(initial.scope), initial);
  assert.throws(() => stage.checkpoints.advance(rollbackCheckpointDigestV1(current), { ...current, revision: 52 }));
  stage.flush(); assert.deepEqual(store.read(initial.scope), current);
  for (const value of [0, -1, 51, 1.5, NaN, Infinity]) assert.throws(() => stageCompletionCheckpoint(store, "tenant:test", value));
});
