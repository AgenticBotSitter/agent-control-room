import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { bindPrivateRecoveryNativeOwnerHostV1, createPrivateRecoveryNativeOwnerHostBoundaryV1,
  PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BIND_V1, PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1 } from
  "../src/installer/v1/private-recovery-native-owner-host-boundary";
import { assessPrivateSchedulerResultStorageObservationHostV1 } from
  "../src/installer/v1/private-scheduler-result-storage-observation-host";
import { createThreeWorkerActivationBundleCustodyV1 } from
  "../src/installer/v1/three-worker-activation-bundle-preflight";

const d = (value: string) => sha256Digest(value);
const binding = Object.freeze({ installationId: "control-room-one", releaseDigest: d("release"),
  topologyPlanDigest: d("topology") });
function fixture() {
  const aggregate = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  const blocked = assessPrivateSchedulerResultStorageObservationHostV1({ aggregate });
  return { aggregate, blocked };
}

test("genuine blocked observation yields only an opaque fail-closed recovery boundary", () => {
  const f = fixture();
  const result = createPrivateRecoveryNativeOwnerHostBoundaryV1({
    schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1, aggregate: f.aggregate,
    blockedObservationCapability: f.blocked.capability });
  assert.equal(result.status, "blocked");
  assert.equal(result.blocker, "verified_recovery_native_sidecar_custody_missing");
  assert.equal(result.protocol, "control-room.private-recovery-native-execution-host/v1");
  assert.match(result.fixedArgvDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.reviewedToolClosureDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual({ acceptsConfiguration: result.acceptsConfiguration,
    acceptsExecutablePath: result.acceptsExecutablePath,
    acceptsVerifyExecutionCallback: result.acceptsVerifyExecutionCallback,
    acceptsPrepareLaunchCallback: result.acceptsPrepareLaunchCallback,
    acceptsAssertCurrentCallback: result.acceptsAssertCurrentCallback,
    providesExecutionAuthority: result.providesExecutionAuthority,
    performsEffectOnConstruction: result.performsEffectOnConstruction,
    readsProtectedConfiguration: result.readsProtectedConfiguration, opensStorage: result.opensStorage,
    opensDatabase: result.opensDatabase, startsProcess: result.startsProcess }, {
    acceptsConfiguration: false, acceptsExecutablePath: false, acceptsVerifyExecutionCallback: false,
    acceptsPrepareLaunchCallback: false, acceptsAssertCurrentCallback: false,
    providesExecutionAuthority: false, performsEffectOnConstruction: false,
    readsProtectedConfiguration: false, opensStorage: false, opensDatabase: false, startsProcess: false });
});

test("injected verification, launch and currentness ports refuse before access", () => {
  const f = fixture();
  let called = false;
  const execute = () => { called = true; };
  assert.throws(() => createPrivateRecoveryNativeOwnerHostBoundaryV1({
    schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1, aggregate: f.aggregate,
    blockedObservationCapability: f.blocked.capability, verifyExecution: execute,
    prepareLaunch: execute, assertCurrent: execute }), /owner_host_boundary_refused/u);
  assert.equal(called, false);
  const accessor = Object.create(Object.prototype);
  Object.defineProperty(accessor, "schema", { enumerable: true, value: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1 });
  Object.defineProperty(accessor, "aggregate", { enumerable: true, get() { called = true; return f.aggregate; } });
  Object.defineProperty(accessor, "blockedObservationCapability", { enumerable: true, value: f.blocked.capability });
  assert.throws(() => createPrivateRecoveryNativeOwnerHostBoundaryV1(accessor), /owner_host_boundary_refused/u);
  assert.equal(called, false);
});

test("structural native sidecar cannot bind and the boundary is one-use", () => {
  const f = fixture();
  const boundary = createPrivateRecoveryNativeOwnerHostBoundaryV1({
    schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1, aggregate: f.aggregate,
    blockedObservationCapability: f.blocked.capability });
  let called = false;
  const request = { schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BIND_V1, aggregate: f.aggregate,
    boundaryCapability: boundary.capability,
    nativeSidecarCapability: { execute() { called = true; }, verifyExecution() { called = true; } } };
  assert.throws(() => bindPrivateRecoveryNativeOwnerHostV1(request), /owner_host_boundary_refused/u);
  assert.equal(called, false);
  assert.throws(() => bindPrivateRecoveryNativeOwnerHostV1(request), /owner_host_boundary_refused/u);
});

test("cross-aggregate, copied, proxied and fabricated boundary capabilities refuse", () => {
  const f = fixture();
  const other = createThreeWorkerActivationBundleCustodyV1(binding).aggregate;
  const boundary = createPrivateRecoveryNativeOwnerHostBoundaryV1({
    schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1, aggregate: f.aggregate,
    blockedObservationCapability: f.blocked.capability });
  assert.throws(() => bindPrivateRecoveryNativeOwnerHostV1({ schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BIND_V1,
    aggregate: other, boundaryCapability: boundary.capability, nativeSidecarCapability: {} }),
  /owner_host_boundary_refused/u);
  for (const capability of [{ ...boundary.capability }, new Proxy(boundary.capability, {}),
    { schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1 }]) assert.throws(() =>
    bindPrivateRecoveryNativeOwnerHostV1({ schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BIND_V1,
      aggregate: f.aggregate, boundaryCapability: capability, nativeSidecarCapability: {} }),
  /owner_host_boundary_refused/u);
});

test("source adds no process, filesystem, storage or database execution surface", () => {
  const source = readFileSync(new URL("../src/installer/v1/private-recovery-native-owner-host-boundary.ts",
    import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:fs", "node:net", "createPrivateRecoveryNativeExecutionHostV1(",
    ".execute(", ".verifyExecution(", ".prepareLaunch(", ".assertCurrent(", "status: \"ready\""])
    assert.equal(source.includes(forbidden), false, forbidden);
});
