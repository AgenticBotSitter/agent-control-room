import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as readinessModule from "../src/connection-registry/v1/private-loopback-physical-qualification-readiness";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_FUTURE_CEILINGS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_READINESS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_STAGES_V1,
  ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessErrorV1,
  connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1,
  parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");

function expectCode(run: () => unknown, code: "invalid_readiness" | "integrity_failed"): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessErrorV1 && error.safeCode === code);
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

test("CR13A-LIVE-130 binds the exact accepted LIVE-120 source evidence", () => {
  const readiness = connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1;
  assert.equal(readiness.contractVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_READINESS_V1);
  assert.match(readiness.readinessReference, /^physical-qualification-readiness:[a-f0-9]{24}$/);
  assert.equal(readiness.integrationCommit, "19a87163c9210730140ec0d769c2effa6bbb5e1b");
  assert.equal(readiness.remediationCommit, "5a579342b7a03bb013de21663c69a3a6118e11c6");
  assert.equal(readiness.remediationTree, "720682ab8ee8d4fe14f63601e72ac5776fa8183a");
  assert.equal(readiness.rejectedTarget, "959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38");
  assert.equal(readiness.negativeReviewSha256,
    "sha256:baefddebe2af5bcf3f2132d2a8ef2b9bce9c84f02477fff8e95de9319b8b8e66");
  assert.equal(readiness.acceptedReviewSha256,
    "sha256:420e0d3313915d9a0b71cc6fa537f3742e64359186ba569021b4d3ece95e3f7c");
  assert.equal(readiness.sourceImplementationAccepted, true);
  assert.equal(readiness.independentSourceReviewAccepted, true);
  assert.equal(readiness.prerequisiteContractAccepted, true);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1(readiness), readiness);
});

test("CR13A-LIVE-130 keeps all twelve physical prerequisites explicitly missing", () => {
  const readiness = connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1;
  assert.deepEqual(readiness.blockerCodes, [
    "target_runtime_attestation_missing",
    "private_locator_broker_missing",
    "exclusive_port_custody_missing",
    "platform_evidence_signer_missing",
    "durable_attempt_ledger_missing",
    "independent_high_water_checkpoint_missing",
    "native_resource_observer_missing",
    "tunnel_peer_proof_missing",
    "accepted_host_key_custody_missing",
    "fresh_owner_authorization_missing",
    "physical_qualification_missing",
    "runtime_activation_approval_missing",
  ]);
  assert.equal(readiness.blockerCodes, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_BLOCKERS_V1);
  assert.deepEqual(readiness.stageOrder, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_STAGES_V1);
  assert.equal(readiness.status, "blocked_missing_private_qualification_prerequisites");
});

test("CR13A-LIVE-130 grants no candidate, native effect, retry, or authority", () => {
  const readiness = connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1;
  const falseClaims = [
    readiness.targetRuntimeAttested,
    readiness.privateLocatorBrokerAccepted,
    readiness.exclusivePortCustodyProven,
    readiness.platformEvidenceSignerAccepted,
    readiness.durableAttemptLedgerAccepted,
    readiness.independentHighWaterCheckpointAccepted,
    readiness.nativeResourceObserverAccepted,
    readiness.tunnelPeerProofAccepted,
    readiness.hostKeyCustodyProofAccepted,
    readiness.freshOwnerAuthorizationPresent,
    readiness.qualificationCandidateAssembled,
    readiness.physicalQualificationAccepted,
    readiness.independentPhysicalEvidenceAccepted,
    readiness.runtimeActivationApproved,
    readiness.activationEligible,
    readiness.externalEffectOccurred,
    readiness.automaticRetryAllowed,
    readiness.runtimeWired,
    readiness.grantsApproval,
    readiness.grantsNetworkAuthority,
    readiness.grantsCommandAuthority,
    readiness.grantsLeaseAuthority,
    readiness.grantsExecutionAuthority,
  ];
  assert.deepEqual(falseClaims, new Array(falseClaims.length).fill(false));
  assert.deepEqual([
    readiness.nativeBackendConstructions,
    readiness.bindCapabilitiesIssued,
    readiness.connectionAdmissionsIssued,
    readiness.listenerAttemptsMade,
    readiness.socketAttemptsMade,
    readiness.networkIoEventsObserved,
  ], new Array(6).fill(0));
});

test("CR13A-LIVE-130 future call ceilings are bounded descriptions, not present authority", () => {
  const readiness = connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1;
  assert.equal(readiness.futureCallCeilings,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_FUTURE_CEILINGS_V1);
  assert.deepEqual(readiness.futureCallCeilings, {
    maximumNativeBackendConstructions: 1,
    maximumListenerAttempts: 1,
    maximumPrivateLocatorCapabilitySpends: 1,
    maximumAdmittedConnections: 1,
    maximumProtectedFrames: 1,
    maximumCloseDrainSequences: 1,
    maximumRecoveryObservations: 1,
    maximumAutomaticRetries: 0,
  });
  assert.equal(readiness.activationEligible, false);
  assert.equal(readiness.freshOwnerAuthorizationPresent, false);
});

test("CR13A-LIVE-130 rejects copies, accessors, symbols, and Proxies without behavior", () => {
  const readiness = connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1({ ...readiness }),
    "invalid_readiness");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    enumerable: true,
    get() { executions += 1; throw new Error("raw accessor sentinel"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1(accessor),
    "invalid_readiness");
  const symbol = Symbol("hostile");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1({
    ...readiness,
    [symbol]: true,
  }), "invalid_readiness");
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw proxy sentinel"); },
    get() { executions += 1; throw new Error("raw proxy sentinel"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1(proxy),
    "invalid_readiness");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-130 freezes records, fixed sets, and exported callable surfaces", () => {
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1), true);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_BLOCKERS_V1), true);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_STAGES_V1), true);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_FUTURE_CEILINGS_V1), true);
  const callables = Object.values(readinessModule).filter((value) => typeof value === "function");
  assert.equal(callables.length, 2);
  let replacementExecutions = 0;
  for (const callable of callables) {
    assert.equal(Object.isFrozen(callable), true);
    assert.equal(Object.isExtensible(callable), false);
    for (const property of ["call", "apply", "bind"] as const) {
      assert.throws(() => Object.defineProperty(callable, property, {
        value: () => { replacementExecutions += 1; },
      }), TypeError);
    }
  }
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessErrorV1.prototype),
    true);
  assert.equal(replacementExecutions, 0);
});

test("CR13A-LIVE-130 exposes only fixed safe error vocabulary and sanitized public truth", () => {
  const hostileError = new ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessErrorV1(
    "raw locator 127.0.0.1:65123 /Users/owner secret host-key",
  );
  assert.equal(hostileError.safeCode, "integrity_failed");
  assert.equal(hostileError.message, "integrity_failed");
  const serialized = JSON.stringify(connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1);
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|localhost|"port"\s*:|\/Users\/|BEGIN PRIVATE KEY|credential|hostKeyMaterial|ownerIdentity|commandLine|process\.env/i);
  assert.equal(hostileError.stack, undefined);
});

test("CR13A-LIVE-130 uses captured validation intrinsics after import", () => {
  const originalIsFrozen = Object.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalReflectApply = Reflect.apply;
  let replacements = 0;
  try {
    Object.isFrozen = () => { replacements += 1; return false; };
    WeakSet.prototype.has = function () { replacements += 1; return false; };
    Reflect.apply = () => { replacements += 1; throw new Error("raw ambient sentinel"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1(
      connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1,
    ), connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(replacements, 0);
});

test("CR13A-LIVE-130 remains native-free, input-free, and absent from runtime composition", async () => {
  const modulePath = resolve(root,
    "src/connection-registry/v1/private-loopback-physical-qualification-readiness.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source,
    /node:net|node:fs|node:child_process|private-loopback-physical-native-driver|createServer|\.listen\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|process\.env|process\.on\s*\(/);
  assert.doesNotMatch(source,
    /\b(?:issueBindCapability|issueConnectionAdmission|issueTunnelPeerProof|issueHostKeyProof|assembleQualificationCandidate|consumeOwnerAuthorization|writeFile|mkdir|mkdtemp|unlink)\b|connect\s*\(/i);
  const sourcePaths = await sourceFiles(resolve(root, "src"));
  const consumers: string[] = [];
  for (const path of sourcePaths) {
    if (path === modulePath) continue;
    const candidateSource = await readFile(path, "utf8");
    if (/private-loopback-physical-qualification-readiness/.test(candidateSource)) consumers.push(path);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
  const barrel = await readFile(resolve(root, "src/connection-registry/v1/index.ts"), "utf8");
  assert.match(barrel, /export \* from "\.\/private-loopback-physical-qualification-readiness"/);
});
