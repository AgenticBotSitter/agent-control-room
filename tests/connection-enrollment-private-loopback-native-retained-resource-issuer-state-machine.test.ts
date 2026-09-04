import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as issuerModule from "../src/connection-registry/v1/private-loopback-native-retained-resource-issuer-state-machine";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_IMPLEMENTATION_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATUS_V1,
  ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1,
  assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1,
  connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1,
  createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
type SafeCode = ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1
    && error.safeCode === code && error.message === code && error.stack === undefined);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function retain(issuer: ReturnType<typeof createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1>) {
  await issuer.claim();
  await issuer.markEffect();
  return issuer.settleRetention();
}

test("CR13A-LIVE-210 pins the accepted LIVE-200 contract and fixed state space", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1;
  assert.equal(implementation.implementationVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_IMPLEMENTATION_V1);
  assert.match(implementation.implementationReference, /^native-retained-resource-issuer-state:[a-f0-9]{24}$/);
  assert.equal(implementation.live200ProductCommit, "9e3cb2afdcd3008dcdac94d113db991f34e49175");
  assert.equal(implementation.acceptedLive200ReviewSha256,
    "82caf0b6ffc0a66661448a9780d0557221faa179f43956d6b2f691a7a1404185");
  assert.equal(implementation.scenarioSet,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1);
  assert.equal(implementation.stateSet,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATES_V1);
  assert.equal(implementation.scenarioSet.length, 5);
  assert.equal(implementation.stateSet.length, 9);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1(implementation),
    implementation);
});

test("CR13A-LIVE-210 completes one retained transfer and verified close", async () => {
  const issuer = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "retained_transferred_then_closed");
  await retain(issuer);
  const transferred = await issuer.transfer();
  assert.equal(transferred.state, "transferred");
  assert.equal(transferred.adapterAcceptedSimulated, true);
  assert.equal(transferred.ownershipTransferredSimulated, true);
  const closed = await issuer.close();
  assert.equal(closed.state, "closed_verified");
  assert.equal(closed.terminalCloseSimulated, true);
  assert.equal(closed.independentZeroResourceObservationSimulated, true);
  assert.deepEqual([closed.claimCalls, closed.effectMarkerCalls, closed.retentionCalls, closed.transferCalls,
    closed.closeCalls, closed.recoverCalls], [1, 1, 1, 1, 1, 0]);
});

test("CR13A-LIVE-210 separates pre-effect rejection and post-marker ambiguity", async () => {
  const rejected = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "rejected_before_effect");
  const rejectedStatus = await rejected.claim();
  assert.equal(rejectedStatus.state, "failed_before_effect");
  assert.equal(rejectedStatus.claimOutcome, "rejected_before_effect");
  assert.equal(rejectedStatus.effectUncertaintyMarkedSimulated, false);
  expectCode(() => rejected.markEffect(), "sequence_conflict");

  const ambiguous = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "ambiguous_after_effect_marker");
  await ambiguous.claim();
  await ambiguous.markEffect();
  const ambiguousStatus = await ambiguous.settleRetention();
  assert.equal(ambiguousStatus.state, "ambiguous_after_effect");
  assert.equal(ambiguousStatus.retentionOutcome, "ambiguous_after_effect");
  assert.equal(ambiguousStatus.fakeResourceCreatedSimulated, false);
  expectCode(() => ambiguous.transfer(), "sequence_conflict");
  assert.equal((await ambiguous.close()).state, "closed_verified");
});

test("CR13A-LIVE-210 retains issuer custody after fake adapter rejection", async () => {
  const issuer = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "adapter_rejected_after_retention");
  await retain(issuer);
  const rejected = await issuer.transfer();
  assert.equal(rejected.state, "ambiguous_after_effect");
  assert.equal(rejected.transferOutcome, "rejected_after_retention");
  assert.equal(rejected.fakeResourceRetainedSimulated, true);
  assert.equal(rejected.adapterAcceptedSimulated, false);
  assert.equal(rejected.ownershipTransferredSimulated, false);
  const closed = await issuer.close();
  assert.equal(closed.fakeResourceRetainedSimulated, false);
  assert.equal(closed.state, "closed_verified");
});

test("CR13A-LIVE-210 preserves cleanup failure until one no-reopen recovery", async () => {
  const issuer = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "cleanup_failed_then_recovered");
  await retain(issuer);
  await issuer.transfer();
  const failed = await issuer.close();
  assert.equal(failed.state, "cleanup_failed");
  assert.equal(failed.cleanupOutcome, "cleanup_failed");
  assert.equal(failed.fakeResourceRetainedSimulated, true);
  const recovered = await issuer.recover();
  assert.equal(recovered.state, "closed_verified");
  assert.equal(recovered.recoveryCheckedSimulated, true);
  assert.equal(recovered.fakeResourceRetainedSimulated, false);
  assert.deepEqual([recovered.claimCalls, recovered.effectMarkerCalls, recovered.retentionCalls,
    recovered.transferCalls, recovered.closeCalls, recovered.recoverCalls], [1, 1, 1, 1, 1, 1]);
});

test("CR13A-LIVE-210 replays the exact promises and never spends twice", async () => {
  const issuer = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "cleanup_failed_then_recovered");
  const claim = issuer.claim();
  assert.equal(issuer.claim(), claim);
  await claim;
  const marker = issuer.markEffect();
  assert.equal(issuer.markEffect(), marker);
  await marker;
  const retention = issuer.settleRetention();
  assert.equal(issuer.settleRetention(), retention);
  await retention;
  const transfer = issuer.transfer();
  assert.equal(issuer.transfer(), transfer);
  await transfer;
  const close = issuer.close();
  assert.equal(issuer.close(), close);
  await close;
  const recover = issuer.recover();
  assert.equal(issuer.recover(), recover);
  const status = await recover;
  assert.deepEqual([status.claimCalls, status.effectMarkerCalls, status.retentionCalls, status.transferCalls,
    status.closeCalls, status.recoverCalls], [1, 1, 1, 1, 1, 1]);
  assert.equal(status.transitionCount, 6);
});

test("CR13A-LIVE-210 binds status to its exact issuer and rejects operation misuse", async () => {
  const first = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "retained_transferred_then_closed");
  const second = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "retained_transferred_then_closed");
  const status = await first.claim();
  assert.equal(status.statusVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATUS_V1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1(status), status);
  assert.equal(assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1(first, status), status);
  expectCode(() => assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1(second, status),
    "status_mismatch");
  expectCode(() => first.transfer(), "sequence_conflict");
  expectCode(() => first.recover(), "recovery_not_available");
  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1("unknown"),
    "invalid_scenario");
  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(new String(
    "retained_transferred_then_closed")), "invalid_scenario");
});

test("CR13A-LIVE-210 rejects copies, symbols, accessors, Proxies, and borrowed receivers without behavior", async () => {
  const issuer = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "retained_transferred_then_closed");
  const status = await issuer.claim();
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1({
    ...connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1,
  }), "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1({ ...status }),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1({
    ...status, [Symbol("hostile")]: true,
  }), "invalid_status");
  let executions = 0;
  const accessor = Object.defineProperty({}, "statusVersion", {
    get() { executions += 1; throw new Error("raw issuer state accessor"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1(accessor),
    "invalid_status");
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw issuer state proxy"); },
    get() { executions += 1; throw new Error("raw issuer state proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1(proxy),
    "invalid_status");
  expectCode(() => issuer.markEffect.call({}), "invalid_issuer");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-210 freezes every surface and resists ambient intrinsic replacement", async () => {
  const issuer = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "retained_transferred_then_closed");
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1), true);
  assert.equal(Object.isFrozen(issuer), true);
  for (const method of Object.values(issuer)) assert.equal(Object.isFrozen(method), true);
  const callables = Object.values(issuerModule).filter((value) => typeof value === "function");
  assert.equal(callables.length, 5);
  for (const callable of callables) assert.equal(Object.isFrozen(callable), true);
  const originals = [Object.isFrozen, Object.values, WeakSet.prototype.has, WeakMap.prototype.get,
    Reflect.apply, Promise.resolve] as const;
  let executions = 0;
  try {
    Object.isFrozen = () => { executions += 1; return false; };
    Object.values = () => { executions += 1; return []; };
    WeakSet.prototype.has = function () { executions += 1; return false; };
    WeakMap.prototype.get = function () { executions += 1; return undefined; };
    Reflect.apply = () => { executions += 1; throw new Error("raw issuer state ambient"); };
    Promise.resolve = () => { executions += 1; throw new Error("raw issuer promise ambient"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1(
      connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1,
    ), connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1);
    const created = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
      "retained_transferred_then_closed");
    await created.claim();
  } finally {
    Object.isFrozen = originals[0];
    Object.values = originals[1];
    WeakSet.prototype.has = originals[2];
    WeakMap.prototype.get = originals[3];
    Reflect.apply = originals[4];
    Promise.resolve = originals[5];
  }
  assert.equal(executions, 0);
});

test("CR13A-LIVE-210 exposes no resource and keeps all real effects and authority at zero", async () => {
  const issuer = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(
    "retained_transferred_then_closed");
  await retain(issuer);
  await issuer.transfer();
  const status = await issuer.close();
  assert.deepEqual([
    status.actualHostObservations, status.actualPortSelections, status.actualPortReservations,
    status.actualNativeResourcesCreated, status.actualNativeResourcesRetained, status.actualCapabilitiesIssued,
    status.actualCapabilitiesSpent, status.actualDriverAcceptCalls, status.actualNativeBackendConstructions,
    status.actualListenerAttempts, status.actualIpcListenerAttempts, status.actualSocketAttempts,
    status.actualTimerCreations, status.actualNetworkIoEvents, status.actualProtectedValuesRead,
    status.actualPersistenceWrites,
  ], new Array(16).fill(0));
  const falseClaims = [status.realIssuerImplemented, status.realAdapterCalled,
    status.clearsCustodyOrHandoffBlocker, status.candidateEligible, status.activationEligible, status.runtimeWired,
    status.externalEffectOccurred, status.grantsApproval, status.grantsQualificationAuthority,
    status.grantsCandidateAuthority, status.grantsActivationAuthority, status.grantsNetworkAuthority,
    status.grantsCommandAuthority, status.grantsLeaseAuthority, status.grantsExecutionAuthority];
  assert.deepEqual(falseClaims, new Array(falseClaims.length).fill(false));
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|localhost|"(?:address|port|interface|socket|server|handle|fileDescriptor|capabilityId)"\s*:|\/Users\/|credentialMaterial|ownerIdentity/i);
});

test("CR13A-LIVE-210 remains network-free, persistence-free, and runtime-unwired", async () => {
  const modulePath = resolve(root,
    "src/connection-registry/v1/private-loopback-native-retained-resource-issuer-state-machine.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source,
    /node:net|node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|postgres|pglite|sqlite|private-loopback-physical-native-driver|private-loopback-native-retained-resource-adapter|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|networkInterfaces|createServer|\.listen\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  const consumers: string[] = [];
  for (const path of await sourceFiles(resolve(root, "src"))) {
    if (path === modulePath) continue;
    if (/private-loopback-native-retained-resource-issuer-state-machine/.test(await readFile(path, "utf8"))) {
      consumers.push(path);
    }
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
