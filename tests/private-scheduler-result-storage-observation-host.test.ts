import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { assessPrivateSchedulerResultStorageObservationHostV1,
  consumePrivateSchedulerResultStorageObservationHostBlockedV1 } from
  "../src/installer/v1/private-scheduler-result-storage-observation-host";
import { createThreeWorkerActivationBundleCustodyV1 } from
  "../src/installer/v1/three-worker-activation-bundle-preflight";

const d = (value: string) => sha256Digest(value);
const binding = Object.freeze({ installationId: "control-room-one", releaseDigest: d("release"),
  topologyPlanDigest: d("topology") });

test("assessment names the two exact native gaps and performs no effect", () => {
  const aggregate = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  const result = assessPrivateSchedulerResultStorageObservationHostV1({ aggregate });
  assert.deepEqual(result.blockers, ["noninjectable_scheduler_observation_host_missing",
    "noninjectable_recovery_native_port_missing"]);
  assert.equal(result.recoveryRequirement.protocol, "control-room.private-recovery-native-execution-host/v1");
  assert.match(result.recoveryRequirement.fixedArgvDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.recoveryRequirement.reviewedToolClosureDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual({ acceptsSchedulerCallback: result.acceptsSchedulerCallback,
    acceptsRecoveryCallback: result.acceptsRecoveryCallback, providesEvidenceIssuer: result.providesEvidenceIssuer,
    performsEffect: result.performsEffect, startsProcess: result.startsProcess, opensDatabase: result.opensDatabase,
    readsStorage: result.readsStorage, writesStorage: result.writesStorage }, {
    acceptsSchedulerCallback: false, acceptsRecoveryCallback: false, providesEvidenceIssuer: false,
    performsEffect: false, startsProcess: false, opensDatabase: false, readsStorage: false, writesStorage: false });
  assert.deepEqual(consumePrivateSchedulerResultStorageObservationHostBlockedV1({
    aggregate, capability: result.capability }), { schema:
      "control-room.private-scheduler-result-storage-observation-host/v1", status: "blocked",
    reportDigest: result.reportDigest });
});

test("structural scheduler and recovery callbacks refuse without invocation", () => {
  const aggregate = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  let called = false;
  const callback = () => { called = true; };
  assert.throws(() => assessPrivateSchedulerResultStorageObservationHostV1({ aggregate,
    schedulerRuntimeCapability: { observe: callback }, recoveryNativeHostCapability: { execute: callback } }),
  /observation_host_refused/u);
  assert.equal(called, false);
  const accessor = Object.create(Object.prototype);
  Object.defineProperty(accessor, "aggregate", { enumerable: true, get() { called = true; return aggregate; } });
  assert.throws(() => assessPrivateSchedulerResultStorageObservationHostV1(accessor), /observation_host_refused/u);
  assert.equal(called, false);
});

test("blocked capability refuses cross-aggregate, copies, proxies, fabrication and replay", () => {
  const first = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  const second = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  const cross = assessPrivateSchedulerResultStorageObservationHostV1({ aggregate: first });
  assert.throws(() => consumePrivateSchedulerResultStorageObservationHostBlockedV1({ aggregate: second,
    capability: cross.capability }), /observation_host_refused/u);
  for (const capability of [{ ...cross.capability }, new Proxy(cross.capability, {}),
    { schema: "control-room.private-scheduler-result-storage-observation-host/v1" }]) {
    assert.throws(() => consumePrivateSchedulerResultStorageObservationHostBlockedV1({ aggregate: first,
      capability }), /observation_host_refused/u);
  }
  assert.throws(() => consumePrivateSchedulerResultStorageObservationHostBlockedV1({ aggregate: first,
    capability: cross.capability }), /observation_host_refused/u);
});

test("source has no process, database, storage or generic callback execution surface", () => {
  const source = readFileSync(new URL("../src/installer/v1/private-scheduler-result-storage-observation-host.ts",
    import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:fs", "node:net", "pg(", ".execute(", ".observe(",
    "status: \"ready\""]) assert.equal(source.includes(forbidden), false, forbidden);
});
