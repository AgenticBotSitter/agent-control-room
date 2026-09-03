import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ACTIVATION_EVIDENCE_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_CONTRACT_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_FAKE_EVENTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_REHEARSAL_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1,
  ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1,
  RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1,
  bindRepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1,
  createConnectionEnrollmentPrivateLoopbackListenerPlanV1,
  createConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1,
  createConnectionEnrollmentPrivateLoopbackNativeDriverContractV1,
  createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1,
  parseConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1,
  parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1,
  parseConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1,
} from "../src/connection-registry/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const digest = (label: string) => sha256Digest({ label });

function planConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    listenerId: "private-loopback-listener:native-driver-contract-fixture-001",
    endpointIdentityDigest: digest("endpoint"),
    ownerIdentityDigest: digest("owner"),
    tunnelPeerIdentityDigest: digest("peer"),
    tunnelHostKeyDigest: digest("host-key"),
    channelIdentityDigest: digest("channel"),
    maximumFrameBytes: 8_192,
    maximumChunks: 64,
    maximumConnectionDurationMs: 45_000,
    idleTimeoutMs: 4_000,
    shutdownGraceMs: 3_000,
    ...overrides,
  };
}

function buildFixture(overrides: Record<string, unknown> = {}) {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration(overrides));
  const readiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(plan);
  const contract = createConnectionEnrollmentPrivateLoopbackNativeDriverContractV1({ plan, readiness });
  const driver = new RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1(contract);
  const rehearsal = driver.rehearse();
  const evidence = createConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1({
    readiness,
    driverContract: contract,
    driverRehearsal: rehearsal,
  });
  return { plan, readiness, contract, driver, rehearsal, evidence };
}

function expectCode(action: () => unknown,
  code: ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1 && error.safeCode === code);
}

test("CR13A-LIVE-110 freezes a plan-bound, fake-only native driver contract", () => {
  const { plan, readiness, contract } = buildFixture();
  assert.equal(contract.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_CONTRACT_V1);
  assert.match(contract.driverReference, /^native-driver-contract:[a-f0-9]{24}$/);
  assert.match(contract.driverBehaviorDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(contract.listenerReference, readiness.listenerReference);
  assert.equal(contract.listenerPlanDigest, plan.planDigest);
  assert.equal(contract.disabledReadinessDigest, readiness.readinessDigest);
  assert.equal(contract.driverMode, "injected_repository_fake");
  assert.deepEqual(contract.operationSet, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1);
  assert.deepEqual({ maximumFrameBytes: contract.maximumFrameBytes, maximumChunks: contract.maximumChunks,
    maximumConcurrentConnections: contract.maximumConcurrentConnections,
    maximumQueuedConnections: contract.maximumQueuedConnections,
    maximumConnectionDurationMs: contract.maximumConnectionDurationMs, idleTimeoutMs: contract.idleTimeoutMs,
    shutdownGraceMs: contract.shutdownGraceMs }, {
    maximumFrameBytes: 8_192, maximumChunks: 64, maximumConcurrentConnections: 1,
    maximumQueuedConnections: 0, maximumConnectionDurationMs: 45_000, idleTimeoutMs: 4_000,
    shutdownGraceMs: 3_000,
  });
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.operationSet), true);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1(contract), contract);
});

test("CR13A-LIVE-110 requires every future driver control while granting no native authority", () => {
  const { contract } = buildFixture();
  assert.deepEqual([
    contract.requiresExclusivePortEvidence,
    contract.requiresAuthenticatedTunnelPeer,
    contract.requiresAcceptedHostKeyCustody,
    contract.requiresConnectionDeadline,
    contract.requiresIdleDeadline,
    contract.requiresAdmissionDeadline,
    contract.requiresBackpressure,
    contract.requiresBoundedShutdownEvidence,
    contract.requiresProcessRecoveryEvidence,
  ], new Array(9).fill(true));
  assert.deepEqual([
    contract.nativeImplementationPresent,
    contract.nativeDriverAccepted,
    contract.activationInputAccepted,
    contract.opensListener,
    contract.performsNetworkIo,
    contract.grantsApproval,
    contract.grantsNetworkAuthority,
    contract.grantsCommandAuthority,
    contract.grantsLeaseAuthority,
    contract.grantsExecutionAuthority,
    contract.automaticRestartAllowed,
  ], new Array(11).fill(false));
});

test("CR13A-LIVE-110 fake rehearsal simulates the full contract with zero effects", () => {
  const { contract, rehearsal } = buildFixture();
  assert.equal(rehearsal.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_REHEARSAL_V1);
  assert.equal(rehearsal.driverContractDigest, contract.contractDigest);
  assert.deepEqual(rehearsal.eventSequence, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_FAKE_EVENTS_V1);
  assert.deepEqual([
    rehearsal.operationSetMatched,
    rehearsal.literalLoopbackPolicySimulated,
    rehearsal.privatePortPolicySimulated,
    rehearsal.singleConnectionPolicySimulated,
    rehearsal.zeroQueuePolicySimulated,
    rehearsal.oneFramePolicySimulated,
    rehearsal.connectionDeadlineSimulated,
    rehearsal.idleDeadlineSimulated,
    rehearsal.admissionDeadlineSimulated,
    rehearsal.backpressureSimulated,
    rehearsal.boundedShutdownSimulated,
    rehearsal.processRecoverySimulated,
    rehearsal.candidateForIndependentContractReview,
  ], new Array(13).fill(true));
  assert.deepEqual([
    rehearsal.externalEffectOccurred,
    rehearsal.nativeImplementationPresent,
    rehearsal.nativeDriverAccepted,
    rehearsal.activationEvidenceAccepted,
    rehearsal.automaticallyActivatesListener,
    rehearsal.grantsApproval,
    rehearsal.grantsNetworkAuthority,
    rehearsal.grantsCommandAuthority,
    rehearsal.grantsLeaseAuthority,
    rehearsal.grantsExecutionAuthority,
  ], new Array(10).fill(false));
  assert.equal(rehearsal.listenerAttemptsMade, 0);
  assert.equal(rehearsal.networkIoEventsObserved, 0);
  assert.equal(Object.isFrozen(rehearsal), true);
  assert.equal(Object.isFrozen(rehearsal.eventSequence), true);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1(rehearsal), rehearsal);
});

test("CR13A-LIVE-110 activation evidence remains blocked after a perfect fake rehearsal", () => {
  const { readiness, contract, rehearsal, evidence } = buildFixture();
  assert.equal(evidence.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ACTIVATION_EVIDENCE_V1);
  assert.equal(evidence.listenerReference, readiness.listenerReference);
  assert.equal(evidence.disabledReadinessDigest, readiness.readinessDigest);
  assert.equal(evidence.driverContractDigest, contract.contractDigest);
  assert.equal(evidence.driverRehearsalDigest, rehearsal.rehearsalDigest);
  assert.equal(evidence.driverContractRehearsalPassed, true);
  assert.deepEqual(evidence.blockerCodes, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1);
  assert.equal(evidence.status, "blocked_repository_evidence_only");
  assert.deepEqual([
    evidence.nativeDriverAccepted,
    evidence.ownerActivationAccepted,
    evidence.platformQualificationAccepted,
    evidence.exclusivePortOwnershipProven,
    evidence.tunnelPeerAuthenticated,
    evidence.hostKeyCustodyProven,
    evidence.connectionDeadlineProven,
    evidence.idleDeadlineProven,
    evidence.admissionDeadlineProven,
    evidence.backpressureProven,
    evidence.shutdownCleanupProven,
    evidence.processRecoveryProven,
    evidence.activationEligible,
    evidence.nativeAttempted,
    evidence.listenerOpened,
    evidence.externalEffectOccurred,
    evidence.automaticRetryAllowed,
    evidence.opensListener,
    evidence.performsNetworkIo,
    evidence.grantsApproval,
    evidence.grantsNetworkAuthority,
    evidence.grantsCommandAuthority,
    evidence.grantsLeaseAuthority,
    evidence.grantsExecutionAuthority,
  ], new Array(24).fill(false));
  assert.equal(evidence.listenerAttemptsMade, 0);
  assert.equal(evidence.networkIoEventsObserved, 0);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1(evidence), evidence);
});

test("CR13A-LIVE-110 accepts only exact module-created contract, rehearsal, and evidence records", () => {
  const { contract, rehearsal, evidence } = buildFixture();
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1({ ...contract }),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1({
    ...contract,
    nativeDriverAccepted: true,
    contractDigest: digest("forged-contract"),
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1({ ...rehearsal }),
    "invalid_rehearsal");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1({ ...evidence }),
    "invalid_evidence");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1({
    ...evidence,
    nativeDriverAccepted: true,
    activationEligible: true,
    opensListener: true,
    evidenceDigest: digest("forged-evidence"),
  }), "invalid_evidence");
});

test("CR13A-LIVE-110 rejects cross-plan and cross-driver evidence substitution", () => {
  const first = buildFixture();
  const secondPlan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration({
    listenerId: "private-loopback-listener:native-driver-contract-fixture-002",
  }));
  const secondReadiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(secondPlan);
  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeDriverContractV1({
    plan: first.plan,
    readiness: secondReadiness,
  }), "invalid_configuration");
  const secondContract = createConnectionEnrollmentPrivateLoopbackNativeDriverContractV1({
    plan: secondPlan,
    readiness: secondReadiness,
  });
  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1({
    readiness: secondReadiness,
    driverContract: secondContract,
    driverRehearsal: first.rehearsal,
  }), "invalid_evidence");
});

test("CR13A-LIVE-110 exact-brands and freezes the repository fake driver and binder", () => {
  const { contract, driver, rehearsal } = buildFixture();
  const prototype = RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1.prototype;
  assert.equal(Object.isFrozen(driver), true);
  assert.equal(Object.isFrozen(prototype), true);
  assert.equal(Object.isExtensible(driver), false);
  assert.throws(() => Object.defineProperty(driver, "rehearse", { value: () => ({}) }), TypeError);
  assert.throws(() => Object.defineProperty(prototype, "rehearse", { value: () => ({}) }), TypeError);
  assert.throws(() => Object.setPrototypeOf(driver, { rehearse: () => ({}) }), TypeError);
  class Subclass extends RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1 {}
  expectCode(() => new Subclass(contract), "invalid_driver");
  expectCode(() => prototype.status.call({}), "integrity_failed");
  expectCode(() => prototype.rehearse.call({}), "integrity_failed");
  expectCode(() => prototype.close.call({}), "integrity_failed");

  const bound = bindRepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1(driver);
  assert.equal(Object.isFrozen(bound), true);
  assert.equal(bound.status(), contract);
  assert.equal(bound.rehearse(), rehearsal);
  bound.close();
  bound.close();
  for (const operation of [bound.status, bound.rehearse, bound.close]) {
    assert.equal(Object.isFrozen(operation), true);
    assert.equal(Object.isExtensible(operation), false);
    assert.throws(() => Object.defineProperty(operation, "call", { value: () => "replacement" }), TypeError);
    assert.throws(() => Object.defineProperty(operation, "prototype", { value: {} }), TypeError);
    assert.throws(() => Object.setPrototypeOf(operation, { call: () => "replacement" }), TypeError);
  }
  expectCode(() => bindRepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1({
    mode: "injected_repository_fake",
    status: () => contract,
    rehearse: () => rehearsal,
    close: () => undefined,
  }), "integrity_failed");
});

test("CR13A-LIVE-110 rejects behavioral inputs without invoking them", () => {
  const { plan, readiness, contract, rehearsal, evidence } = buildFixture();
  let traps = 0;
  for (const [value, parse, code] of [
    [contract, parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1, "invalid_contract"],
    [rehearsal, parseConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1, "invalid_rehearsal"],
    [evidence, parseConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1, "invalid_evidence"],
  ] as const) {
    expectCode(() => parse(new Proxy(value, {
      get() { traps += 1; throw new Error("must remain inert"); },
    })), code);
  }
  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeDriverContractV1(new Proxy({ plan, readiness }, {
    get() { traps += 1; throw new Error("must remain inert"); },
  })), "invalid_configuration");
  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1(new Proxy({
    readiness,
    driverContract: contract,
    driverRehearsal: rehearsal,
  }, {
    get() { traps += 1; throw new Error("must remain inert"); },
  })), "invalid_evidence");
  assert.equal(traps, 0);
});

test("CR13A-LIVE-110 exposes no listener locator or protected identity", () => {
  const { contract, rehearsal, evidence } = buildFixture({
    listenerId: "private-loopback-listener:127.0.0.1:4545",
  });
  const serialized = JSON.stringify({ contract, rehearsal, evidence });
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|4545|listenerId|endpointIdentity|ownerIdentity|tunnelPeerIdentity|tunnelHostKey|channelIdentity/i);
  assert.match(contract.listenerReference, /^native-listener:[a-f0-9]{24}$/);
});

test("CR13A-LIVE-110 adds no native implementation, runtime wiring, or external effect path", async () => {
  const source = await readFile(resolve(
    "src/connection-registry/v1/private-loopback-native-driver-contract.ts"), "utf8");
  const runtime = await readFile(resolve("src/local-pilot/v1/runtime.ts"), "utf8");
  assert.doesNotMatch(source, /from ["']node:(?:net|tls|http|https|child_process|dgram)["']/);
  assert.doesNotMatch(source, /\.listen\s*\(|\.connect\s*\(|createServer\s*\(|spawn\s*\(|exec\s*\(/);
  assert.doesNotMatch(source, /ssh2|fetch\s*\(|WebSocket/i);
  assert.doesNotMatch(source, /app\/api|route\.ts|local-pilot/i);
  assert.match(source, /driverMode: "injected_repository_fake"/);
  assert.match(source, /nativeImplementationPresent: false/);
  assert.match(source, /listenerAttemptsMade: 0/);
  assert.match(source, /networkIoEventsObserved: 0/);
  assert.match(runtime, /new DisabledConnectionEnrollmentPrivateLoopbackListenerV1\(\)/);
  assert.doesNotMatch(runtime, /RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1/);
});
