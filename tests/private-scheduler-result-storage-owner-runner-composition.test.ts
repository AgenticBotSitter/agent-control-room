import assert from "node:assert/strict";
import test from "node:test";
import { createThreeWorkerActivationBundleCustodyV1 } from
  "../src/installer/v1/three-worker-activation-bundle-preflight";
import { createPrivateSchedulerResultStorageOwnerRunnerCompositionV1,
  invokePrivateSchedulerResultStorageOwnerRunnerV1,
  PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_INVOCATION_V1 } from
  "../src/installer/v1/private-scheduler-result-storage-owner-runner-composition";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: string) => sha256Digest(value);
const binding = Object.freeze({ installationId: "control-room-one", releaseDigest: d("release"),
  topologyPlanDigest: d("topology") });

test("composition records the exact missing protected-custody gate without effects", () => {
  const aggregate = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  const result = createPrivateSchedulerResultStorageOwnerRunnerCompositionV1({ aggregate,
    postWriteVerificationCapability: undefined });
  assert.deepEqual({ ...result, capability: undefined }, {
    schema: "control-room.private-scheduler-result-storage-owner-runner-composition/v1",
    status: "blocked", blocker: "protected_configuration_custody_missing", oneUse: true,
    providesGenericIssuer: false, acceptsSchedulerCallback: false, acceptsStorageCallback: false,
    acceptsRestoreCallback: false, performsEffectOnConstruction: false, opensProtectedConfiguration: false,
    opensScheduler: false, opensStorage: false, runsScheduledTask: false, runsBackup: false,
    runsRestore: false, capability: undefined });
  assert.deepEqual(result.capability,
    { schema: "control-room.private-scheduler-result-storage-owner-runner-composition/v1" });
});

test("structural owner host is never called and burns the one-use composition", () => {
  const aggregate = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  const composition = createPrivateSchedulerResultStorageOwnerRunnerCompositionV1({ aggregate,
    postWriteVerificationCapability: undefined });
  let called = false;
  const invocation = { schema: PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_INVOCATION_V1,
    aggregate, compositionCapability: composition.capability,
    ownerInvocationCapability: { execute() { called = true; } } };
  assert.throws(() => invokePrivateSchedulerResultStorageOwnerRunnerV1(invocation), /owner_runner_refused/u);
  assert.equal(called, false);
  assert.throws(() => invokePrivateSchedulerResultStorageOwnerRunnerV1(invocation), /owner_runner_refused/u);
});

test("cross-aggregate, copied, proxied and fabricated capabilities refuse", () => {
  const first = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  const second = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  const cross = createPrivateSchedulerResultStorageOwnerRunnerCompositionV1({ aggregate: first,
    postWriteVerificationCapability: undefined });
  assert.throws(() => invokePrivateSchedulerResultStorageOwnerRunnerV1({
    schema: PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_INVOCATION_V1, aggregate: second,
    compositionCapability: cross.capability, ownerInvocationCapability: {} }), /owner_runner_refused/u);
  for (const capability of [{ ...cross.capability }, new Proxy(cross.capability, {}),
    { schema: cross.schema }]) assert.throws(() => invokePrivateSchedulerResultStorageOwnerRunnerV1({
      schema: PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_INVOCATION_V1, aggregate: first,
      compositionCapability: capability, ownerInvocationCapability: {} }), /owner_runner_refused/u);
});

test("a structural protected-configuration capability cannot construct custody", () => {
  const aggregate = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  assert.throws(() => createPrivateSchedulerResultStorageOwnerRunnerCompositionV1({ aggregate,
    postWriteVerificationCapability: {
      schema: "control-room.private-installed-configuration-v3-post-write-verification-capability/v1" } }),
  /owner_writer_refused/u);
});
