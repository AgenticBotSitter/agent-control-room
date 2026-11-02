import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import {
  captureLoopFinalizationCapabilityV1, createImproveControlRoomLoopFinalizerV1,
  verifyFinalizationRecordV1, type LoopFinalizationCapabilityV1,
  type LoopFinalizationInspectionV1, type LoopFinalizationRecordV1, type LoopFinalizationTargetV1,
} from "../src/web/v1/improve-control-room-loop-finalization";

function fixture() {
  let target: LoopFinalizationTargetV1 = {
    schemaVersion: 1, tenantId: "tenant:test", workspaceId: "workspace:test", projectId: "project:test",
    ownerIdentityId: "owner:test", requestId: "request:test", runLinkId: "run-link:test", localVersion: 1,
    authorizationId: "authorization:test", startCommandId: `loop-command:${"a".repeat(32)}`,
    startBindingDigest: sha256Digest("start"),
    run: { adapterId: "adapter:test", loopRunId: "run:test", toolingRevision: sha256Digest("tooling"), a2SchemaVersion: 1 },
    inputVersion: "input:1", requestSha256: "b".repeat(64), settingsSha256: "c".repeat(64),
    settingsDigest: sha256Digest("settings"), expectedRevision: 6, schemaDigest: sha256Digest("schema"),
  };
  const records: LoopFinalizationRecordV1[] = [];
  let outcome: "uncertain" | "stopped" = "uncertain", retains = 0, cleanups = 0;
  const inspect = (): LoopFinalizationInspectionV1 => {
    const binding = { ...target, eventDigest: sha256Digest({ revision: target.expectedRevision, outcome }) };
    const inventoryDigest = sha256Digest({ inventory: target.expectedRevision });
    const observedAt = "2026-11-02T00:00:00.000Z";
    return { observation: { schemaVersion: 1, binding, outcome, reasonCode: outcome === "uncertain" ? "UNAVAILABLE" : "STOPPED",
      evidenceDigest: sha256Digest("evidence"), completionDigest: null, inventoryDigest, observedAt },
    termination: { schemaVersion: 1, binding, inventoryDigest, state: outcome === "uncertain" ? "uncertain" : "already-ended",
      ownershipDigest: sha256Digest("ownership"), observedAt } };
  };
  const capability: LoopFinalizationCapabilityV1 = {
    enabled: () => true, inspect: async () => inspect(), withFence: async (_binding, work) => work(),
    source: { toolingRevision: target.run.toolingRevision, schemaDigest: target.schemaDigest,
      readVerifiedCompletion: async () => { throw new Error("unexpected publication"); } },
    repository: { observe: async () => { throw new Error("unexpected repository read"); } },
    readRecord: async () => records.at(-1) ?? null,
    appendRecord: async (_binding, record) => {
      assert.equal(record.previousDigest, records.at(-1)?.recordDigest ?? null);
      records.push(structuredClone(record)); return record;
    },
    retain: async binding => {
      retains++;
      return { schemaVersion: 1, binding, inventoryDigest: inspect().observation.inventoryDigest,
        retentionDigest: sha256Digest({ retention: binding.expectedRevision }), verifiedAt: inspect().observation.observedAt };
    },
    cleanup: async (binding, retentionDigest) => {
      cleanups++;
      return { schemaVersion: 1, binding, inventoryDigest: inspect().observation.inventoryDigest, retentionDigest,
        state: "complete", reasonCode: "CLEANUP_COMPLETE", removedDigest: sha256Digest([]), finishedAt: inspect().observation.observedAt };
    },
  };
  const finalize = (c = capability) => createImproveControlRoomLoopFinalizerV1({ capability: c,
    authorize: async () => target, signal: new AbortController().signal,
    publishCompletion: async () => { throw new Error("unexpected publication"); },
  }).finalize(target);
  return { capability, records, finalize, get target() { return target; },
    get effects() { return { retains, cleanups }; },
    advance(nextOutcome: typeof outcome = "stopped") { target = { ...target, expectedRevision: 71 }; outcome = nextOutcome; },
    stop() { outcome = "stopped"; },
  };
}

test("B5 reads an announced predecessor from revision 6 at revision 71 of the same run", async () => {
  const f = fixture(), announced = await f.finalize();
  assert.equal(announced?.phase, "announced"); assert.equal(announced?.binding.expectedRevision, 6);
  f.advance();
  assert.deepEqual(verifyFinalizationRecordV1(announced, f.target), announced);
  assert.deepEqual(await captureLoopFinalizationCapabilityV1(f.capability)!.readRecord(f.target), announced);
});

test("B5 finalizes revision 71 after an uncertain announced record at revision 6", async () => {
  const f = fixture(), announced = await f.finalize();
  assert.equal(announced?.phase, "announced"); f.advance();
  const record = await f.finalize(captureLoopFinalizationCapabilityV1(f.capability)!);
  assert.equal(record?.phase, "cleanup"); assert.equal(record?.cleanup?.state, "complete");
  assert.equal(record?.binding.expectedRevision, 71);
  assert.equal(f.records[1]?.previousDigest, announced?.recordDigest);
  assert.equal(f.records[1]?.sequence, 2);
  assert.equal(f.records[1]?.termination, null);
  assert.equal(f.records[1]?.publication, null);
  assert.equal(f.records[1]?.cleanup, null);
  assert.deepEqual(f.effects, { retains: 2, cleanups: 1 });
});

test("B5 raw finalizer accepts the earlier revision without a captured read", async () => {
  const f = fixture(); await f.finalize(); f.advance();
  assert.equal((await f.finalize())?.cleanup?.state, "complete");
});

test("B5 a new observation inherits no custody or cleanup from the earlier revision", async () => {
  const f = fixture(); f.stop();
  const old = await f.finalize(); assert.equal(old?.cleanup?.state, "complete");
  const count = f.records.length, effects = f.effects;
  f.advance("uncertain");
  const announced = await f.finalize();
  assert.equal(announced?.phase, "announced");
  assert.equal(announced?.previousDigest, old?.recordDigest);
  assert.equal(announced?.sequence, count + 1);
  assert.equal(announced?.custody, null); assert.equal(announced?.publication, null); assert.equal(announced?.cleanup, null);
  assert.equal(announced?.termination?.state, "uncertain");
  assert.deepEqual(f.effects, effects);
});

test("B5 an earlier record refuses every foreign target identity before custody", async t => {
  const original = fixture(); await original.finalize(); original.advance();
  for (const key of Object.keys(original.target) as (keyof LoopFinalizationTargetV1)[]) {
    if (key === "schemaVersion" || key === "expectedRevision") continue;
    await t.test(key, async () => {
      const f = fixture(); await f.finalize(); f.advance();
      const foreign = structuredClone(f.target);
      if (key === "run") foreign.run.loopRunId = "run:foreign";
      else if (key === "localVersion") foreign.localVersion++;
      else if (key === "startCommandId") foreign.startCommandId = `loop-command:${"d".repeat(32)}`;
      else if (key === "requestSha256" || key === "settingsSha256") foreign[key] = "d".repeat(64);
      else if (key.endsWith("Digest")) Object.assign(foreign, { [key]: sha256Digest("foreign") });
      else Object.assign(foreign, { [key]: "foreign:identity" });
      const prior = f.records[0]!;
      assert.throws(() => verifyFinalizationRecordV1(prior, foreign), /loop_finalization_unavailable/);
      await assert.rejects(captureLoopFinalizationCapabilityV1(f.capability)!.readRecord(foreign), /loop_finalization_unavailable/);
      await assert.rejects(createImproveControlRoomLoopFinalizerV1({
        capability: { ...f.capability, inspect: async () => {
          const inspection = await f.capability.inspect(f.target);
          const binding = { ...foreign, eventDigest: inspection.observation.binding.eventDigest };
          return { observation: { ...inspection.observation, binding }, termination: inspection.termination && { ...inspection.termination, binding } };
        } }, authorize: async () => foreign, signal: new AbortController().signal,
        publishCompletion: async () => { throw new Error("unexpected publication"); },
      }).finalize(foreign), /loop_finalization_unavailable/);
      assert.equal(f.records.length, 1); assert.deepEqual(f.effects, { retains: 0, cleanups: 0 });
    });
  }
});
