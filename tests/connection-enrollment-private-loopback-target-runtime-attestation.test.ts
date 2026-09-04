import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as attestationModule from
  "../src/connection-registry/v1/private-loopback-target-runtime-attestation";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_CONTRACT_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_RESULT_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1,
  ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1,
  connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1,
  connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1,
  parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1,
  parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");

function expectCode(run: () => unknown, code: "invalid_contract" | "invalid_result" | "integrity_failed"): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1 && error.safeCode === code);
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

test("CR13A-LIVE-140 freezes the intended target policy without claiming observation", () => {
  const contract = connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1;
  assert.equal(contract.contractVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_CONTRACT_V1);
  assert.match(contract.policyReference, /^target-runtime-policy:[a-f0-9]{24}$/);
  assert.equal(contract.live130ProductCommit, "339c2e8a61e7c2ac0a40fc6f51711a512badbf6c");
  assert.equal(contract.live130ProductTree, "06b57cdcec6f139a407d1475e3171ce3798ad64d");
  assert.equal(contract.acceptedPhysicalDriverCommit, "5a579342b7a03bb013de21663c69a3a6118e11c6");
  assert.equal(contract.intendedPlatformFamily, "macos");
  assert.deepEqual(contract.supportedArchitectureClasses, ["arm64", "x64"]);
  assert.equal(contract.runtimeFamily, "node");
  assert.equal(contract.minimumRuntimeVersion, "22.13.0");
  assert.equal(contract.networkRole, "private_loopback_qualification_host");
  assert.equal(contract.bindingScope, "single_boot_single_process_single_candidate_single_attempt");
  assert.equal(contract.maximumFutureAttestationLifetimeSeconds, 60);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1(contract), contract);
});

test("CR13A-LIVE-140 requires every private runtime claim and forbids guessable public identity", () => {
  const contract = connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1;
  assert.equal(contract.requiredPrivateClaims,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1);
  assert.deepEqual(contract.requiredPrivateClaims, [
    "platform_family",
    "architecture_class",
    "runtime_semantic_version",
    "runtime_executable_content_identity",
    "operating_system_boot_epoch",
    "attestor_process_session_epoch",
    "qualification_harness_identity",
    "accepted_physical_driver_build_identity",
    "qualification_candidate_identity",
    "qualification_attempt_identity",
    "fresh_request_nonce",
    "trusted_observed_and_expiry_time",
    "platform_signer_key_identity_and_signature",
    "monotonic_acceptance_checkpoint_identity",
  ]);
  assert.equal(contract.requiresFreshNonce, true);
  assert.equal(contract.requiresTrustedClock, true);
  assert.equal(contract.requiresPlatformSigner, true);
  assert.equal(contract.requiresIndependentCheckpoint, true);
  assert.equal(contract.forbidsRawOrGuessableHostIdentity, true);
  assert.equal(contract.publicPrivacyMode,
    "fixed_enums_booleans_zero_counts_public_repository_digests_only");
});

test("CR13A-LIVE-140 repository fake cannot observe, attest, clear a blocker, or grant authority", () => {
  const result = connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1;
  assert.equal(result.resultVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_RESULT_V1);
  assert.match(result.resultReference, /^target-runtime-fake:[a-f0-9]{24}$/);
  assert.equal(result.evidenceClass, "repository_fake");
  assert.equal(result.contractDigest,
    connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.contractDigest);
  assert.equal(result.policyReference,
    connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.policyReference);
  assert.equal(result.supportedArchitectureClasses,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1);
  assert.equal(result.requiredPrivateClaims,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1(result), result);
  const falseClaims = [
    result.hostObservationPerformed, result.rawHostIdentityPresent, result.stableHostTransformPresent,
    result.platformFamilyObserved, result.architectureObserved, result.runtimeVersionObserved,
    result.runtimeExecutableBound, result.bootEpochBound, result.processSessionEpochBound,
    result.qualificationHarnessBound, result.acceptedPhysicalDriverBound, result.qualificationCandidateBound,
    result.qualificationAttemptBound, result.freshNonceConsumed, result.trustedClockPresent,
    result.platformSignerPresent, result.independentCheckpointPresent, result.realAttestationEnvelopePresent,
    result.realAttestationVerified, result.durableAcceptanceRecorded, result.targetRuntimeAttestationAccepted,
    result.clearsTargetRuntimeAttestationBlocker, result.activationEligible, result.externalEffectOccurred,
    result.runtimeWired, result.grantsApproval, result.grantsQualificationAuthority,
    result.grantsCandidateAuthority, result.grantsActivationAuthority, result.grantsNetworkAuthority,
    result.grantsCommandAuthority, result.grantsLeaseAuthority, result.grantsExecutionAuthority,
  ];
  assert.deepEqual(falseClaims, new Array(falseClaims.length).fill(false));
  assert.equal(result.targetRuntimeAttestationMissing, true);
});

test("CR13A-LIVE-140 keeps every present observation and effect count at zero", () => {
  const result = connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1;
  assert.deepEqual([
    result.hostObservationAttempts,
    result.platformSignerCalls,
    result.nativeBackendConstructions,
    result.listenerAttemptsMade,
    result.ipcListenerAttemptsMade,
    result.socketAttemptsMade,
    result.portSelectionsMade,
    result.networkIoEventsObserved,
    result.protectedValuesRead,
  ], new Array(9).fill(0));
  assert.equal(connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.realProviderImplemented, false);
  assert.equal(connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.realVerifierImplemented, false);
  assert.equal(connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1
    .repositoryFakeHostObservationAllowed, false);
});

test("CR13A-LIVE-140 parsers reject copies, accessors, symbols, and Proxies without behavior", () => {
  const contract = connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1;
  const result = connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1({ ...contract }),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1({ ...result }),
    "invalid_result");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    enumerable: true,
    get() { executions += 1; throw new Error("raw accessor sentinel"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1(accessor),
    "invalid_contract");
  const symbol = Symbol("hostile");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1({
    ...result,
    [symbol]: true,
  }), "invalid_result");
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw proxy sentinel"); },
    get() { executions += 1; throw new Error("raw proxy sentinel"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1(proxy),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1(proxy),
    "invalid_result");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-140 freezes fixed collections, records, and callable surfaces", () => {
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1), true);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1), true);
  const callables = Object.values(attestationModule).filter((value) => typeof value === "function");
  assert.equal(callables.length, 3);
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
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1.prototype), true);
  assert.equal(replacementExecutions, 0);
});

test("CR13A-LIVE-140 errors and public records remain fixed and sanitized", () => {
  const hostile = new ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1(
    "host owner /Users/example 127.0.0.1:65123 private-key credential",
  );
  assert.equal(hostile.safeCode, "integrity_failed");
  assert.equal(hostile.message, "integrity_failed");
  assert.equal(hostile.stack, undefined);
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1,
    result: connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1,
  });
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|localhost|"port"\s*:|\/Users\/|hardwareUuid|serialNumber|machineFingerprint|userName|homeDirectory|workingDirectory|processArguments|environmentVariables|macAddress|sshPeer|hostKeyMaterial|credentialMaterial|ownerIdentity|BEGIN PRIVATE KEY/i);
});

test("CR13A-LIVE-140 uses captured validation intrinsics after import", () => {
  const originalIsFrozen = Object.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalReflectApply = Reflect.apply;
  let replacements = 0;
  try {
    Object.isFrozen = () => { replacements += 1; return false; };
    WeakSet.prototype.has = function () { replacements += 1; return false; };
    WeakMap.prototype.get = function () { replacements += 1; return undefined; };
    Reflect.apply = () => { replacements += 1; throw new Error("raw ambient sentinel"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1(
      connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1,
    ), connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1(
      connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1,
    ), connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(replacements, 0);
});

test("CR13A-LIVE-140 remains host-read-free, native-free, input-free, and runtime-unwired", async () => {
  const modulePath = resolve(root, "src/connection-registry/v1/private-loopback-target-runtime-attestation.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source,
    /node:os|node:process|node:fs|node:child_process|node:net|node:crypto|private-loopback-physical-native-driver|system_profiler|ioreg|sysctl|uname|hostname\s*\(|homedir\s*\(|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|createServer|\.listen\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  assert.doesNotMatch(source,
    /\b(?:observeHost|collectHost|readMachine|issueNonce|issueAttestation|signAttestation|verifyAttestation|clearTargetRuntimeBlocker|assembleQualificationCandidate|consumeOwnerAuthorization|writeFile|mkdir|mkdtemp|unlink|exec|spawn|connect)\s*\(/i);
  const sourcePaths = await sourceFiles(resolve(root, "src"));
  const consumers: string[] = [];
  for (const path of sourcePaths) {
    if (path === modulePath) continue;
    const candidateSource = await readFile(path, "utf8");
    if (/private-loopback-target-runtime-attestation/.test(candidateSource)) consumers.push(path);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
  const barrel = await readFile(resolve(root, "src/connection-registry/v1/index.ts"), "utf8");
  assert.match(barrel, /export \* from "\.\/private-loopback-target-runtime-attestation"/);
});
