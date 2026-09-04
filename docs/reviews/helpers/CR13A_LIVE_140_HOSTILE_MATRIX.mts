import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as direct from "../../../src/connection-registry/v1/private-loopback-target-runtime-attestation.ts";
import * as barrel from "../../../src/connection-registry/v1/index.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1: architectures,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_CONTRACT_V1: contractVersion,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_RESULT_V1: resultVersion,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1: privateClaims,
  ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1: SafeError,
  connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1: contract,
  connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1: result,
  parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1: parseContract,
  parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1: parseResult,
} = direct;

let hostileAttempts = 0;
let hostileBehaviorExecutions = 0;
let ambientReplacementAttempts = 0;
let ambientReplacementExecutions = 0;

function expectSafeCode(run: () => unknown, code: "invalid_contract" | "invalid_result" | "integrity_failed"): void {
  hostileAttempts += 1;
  assert.throws(run, (error: unknown) => error instanceof SafeError
    && error.safeCode === code && error.message === code && error.stack === undefined);
}

function expectMutationDenied(run: () => unknown): void {
  hostileAttempts += 1;
  assert.throws(run, TypeError);
}

// Group 1: immutable predecessor identities.
assert.equal(contract.live130ProductCommit, "339c2e8a61e7c2ac0a40fc6f51711a512badbf6c");
assert.equal(contract.live130ProductTree, "06b57cdcec6f139a407d1475e3171ce3798ad64d");
assert.equal(contract.acceptedPhysicalDriverCommit, "5a579342b7a03bb013de21663c69a3a6118e11c6");
assert.equal(contract.contractVersion, contractVersion);
assert.equal(result.resultVersion, resultVersion);

// Group 2: exact private provenance defeats copies, apparent re-digests, alternate prototypes,
// accessors, symbols, Proxies, thenables, and borrowed values without executing behavior.
expectSafeCode(() => parseContract({ ...contract }), "invalid_contract");
expectSafeCode(() => parseResult({ ...result }), "invalid_result");
expectSafeCode(() => parseContract({ ...contract, contractDigest: `sha256:${"0".repeat(64)}` }), "invalid_contract");
expectSafeCode(() => parseResult({ ...result, resultDigest: `sha256:${"1".repeat(64)}` }), "invalid_result");
const alternateContract = Object.assign(Object.create(null), contract);
const alternateResult = Object.assign(Object.create(null), result);
expectSafeCode(() => parseContract(alternateContract), "invalid_contract");
expectSafeCode(() => parseResult(alternateResult), "invalid_result");
const contractAccessor = Object.defineProperty({}, "contractVersion", {
  enumerable: true,
  get() { hostileBehaviorExecutions += 1; throw new Error("raw accessor sentinel"); },
});
const resultAccessor = Object.defineProperty({}, "resultVersion", {
  enumerable: true,
  get() { hostileBehaviorExecutions += 1; throw new Error("raw accessor sentinel"); },
});
expectSafeCode(() => parseContract(contractAccessor), "invalid_contract");
expectSafeCode(() => parseResult(resultAccessor), "invalid_result");
expectSafeCode(() => parseContract({ ...contract, [Symbol("hostile")]: true }), "invalid_contract");
expectSafeCode(() => parseResult({ ...result, [Symbol("hostile")]: true }), "invalid_result");
const hostileProxy = new Proxy({}, {
  get() { hostileBehaviorExecutions += 1; throw new Error("raw proxy sentinel"); },
  getPrototypeOf() { hostileBehaviorExecutions += 1; throw new Error("raw proxy sentinel"); },
  ownKeys() { hostileBehaviorExecutions += 1; throw new Error("raw proxy sentinel"); },
});
expectSafeCode(() => parseContract(hostileProxy), "invalid_contract");
expectSafeCode(() => parseResult(hostileProxy), "invalid_result");
const hostileThenable = { then() { hostileBehaviorExecutions += 1; throw new Error("raw then sentinel"); } };
expectSafeCode(() => parseContract(hostileThenable), "invalid_contract");
expectSafeCode(() => parseResult(hostileThenable), "invalid_result");
const borrowedContractValue = { value: contract };
const borrowedResultValue = { value: result };
expectSafeCode(() => parseContract(borrowedContractValue), "invalid_contract");
expectSafeCode(() => parseResult(borrowedResultValue), "invalid_result");

// Group 3: exact immutable platform and fourteen-claim policy.
assert.deepEqual(architectures, ["arm64", "x64"]);
assert.equal(Object.isFrozen(architectures), true);
assert.equal(contract.supportedArchitectureClasses, architectures);
assert.deepEqual(privateClaims, [
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
assert.equal(privateClaims.length, 14);
assert.equal(Object.isFrozen(privateClaims), true);
assert.equal(contract.requiredPrivateClaims, privateClaims);
assert.equal(result.requiredPrivateClaims, privateClaims);
expectMutationDenied(() => (architectures as unknown as string[]).push("riscv64"));
expectMutationDenied(() => (privateClaims as unknown as string[]).pop());
expectSafeCode(() => parseContract({ ...contract, supportedArchitectureClasses: ["arm64"] }), "invalid_contract");
expectSafeCode(() => parseContract({ ...contract, supportedArchitectureClasses: ["arm64", "arm64", "x64"] }), "invalid_contract");
expectSafeCode(() => parseContract({ ...contract, supportedArchitectureClasses: ["x64", "arm64"] }), "invalid_contract");
expectSafeCode(() => parseContract({ ...contract, intendedPlatformFamily: "linux" }), "invalid_contract");
expectSafeCode(() => parseContract({ ...contract, requiredPrivateClaims: privateClaims.slice(1) }), "invalid_contract");
expectSafeCode(() => parseContract({ ...contract, requiredPrivateClaims: [...privateClaims, privateClaims[0]] }), "invalid_contract");
expectSafeCode(() => parseContract({ ...contract, requiredPrivateClaims: [...privateClaims].reverse() }), "invalid_contract");

// Group 4: every security-relevant ambient intrinsic captured directly by this module is inert after import.
const originalFreeze = Object.freeze;
const originalIsFrozen = Object.isFrozen;
const originalReflectApply = Reflect.apply;
const originalStringSlice = String.prototype.slice;
const originalWeakMapGet = WeakMap.prototype.get;
const originalWeakMapSet = WeakMap.prototype.set;
const originalWeakSetAdd = WeakSet.prototype.add;
const originalWeakSetHas = WeakSet.prototype.has;
let parsedContractAfterReplacement: unknown;
let parsedResultAfterReplacement: unknown;
let safeErrorAfterReplacement: InstanceType<typeof SafeError> | undefined;
try {
  Object.freeze = ((value: unknown) => { ambientReplacementExecutions += 1; return value; }) as typeof Object.freeze;
  Object.isFrozen = (() => { ambientReplacementExecutions += 1; return false; }) as typeof Object.isFrozen;
  Reflect.apply = (() => { ambientReplacementExecutions += 1; throw new Error("raw reflect sentinel"); }) as typeof Reflect.apply;
  String.prototype.slice = (() => { ambientReplacementExecutions += 1; return "raw slice sentinel"; }) as typeof String.prototype.slice;
  WeakMap.prototype.get = (function () { ambientReplacementExecutions += 1; return undefined; }) as typeof WeakMap.prototype.get;
  WeakMap.prototype.set = (function (this: WeakMap<object, unknown>) {
    ambientReplacementExecutions += 1; return this;
  }) as typeof WeakMap.prototype.set;
  WeakSet.prototype.add = (function (this: WeakSet<object>) {
    ambientReplacementExecutions += 1; return this;
  }) as typeof WeakSet.prototype.add;
  WeakSet.prototype.has = (function () { ambientReplacementExecutions += 1; return false; }) as typeof WeakSet.prototype.has;
  ambientReplacementAttempts += 8;
  parsedContractAfterReplacement = parseContract(contract);
  parsedResultAfterReplacement = parseResult(result);
  safeErrorAfterReplacement = new SafeError("raw replacement sentinel");
} finally {
  Object.freeze = originalFreeze;
  Object.isFrozen = originalIsFrozen;
  Reflect.apply = originalReflectApply;
  String.prototype.slice = originalStringSlice;
  WeakMap.prototype.get = originalWeakMapGet;
  WeakMap.prototype.set = originalWeakMapSet;
  WeakSet.prototype.add = originalWeakSetAdd;
  WeakSet.prototype.has = originalWeakSetHas;
}
assert.equal(parsedContractAfterReplacement, contract);
assert.equal(parsedResultAfterReplacement, result);
assert.equal(safeErrorAfterReplacement?.safeCode, "integrity_failed");
assert.equal(safeErrorAfterReplacement?.message, "integrity_failed");
assert.equal(ambientReplacementExecutions, 0);

// Group 5: frozen callable, prototype, receiver, bind, subclass, and alternate-new-target behavior.
const callables = [SafeError, parseContract, parseResult] as const;
for (const callable of callables) {
  assert.equal(Object.isFrozen(callable), true);
  assert.equal(Object.isExtensible(callable), false);
  for (const property of ["call", "apply", "bind"] as const) {
    expectMutationDenied(() => Object.defineProperty(callable, property, {
      value: () => { hostileBehaviorExecutions += 1; },
    }));
  }
  expectMutationDenied(() => Object.setPrototypeOf(callable, hostileProxy));
}
assert.equal(Object.isFrozen(SafeError.prototype), true);
const hostileReceiver = new Proxy({}, {
  get() { hostileBehaviorExecutions += 1; throw new Error("raw receiver sentinel"); },
});
hostileAttempts += 4;
assert.equal(Reflect.apply(parseContract, hostileReceiver, [contract]), contract);
assert.equal(Reflect.apply(parseResult, hostileReceiver, [result]), result);
assert.equal(parseContract.bind(hostileReceiver)(contract), contract);
assert.equal(parseResult.bind(hostileReceiver)(result), result);
class AlternateSafeErrorTarget {}
hostileAttempts += 3;
const alternateError = Reflect.construct(SafeError, ["raw alternate target"], AlternateSafeErrorTarget) as {
  safeCode: unknown; message: unknown; stack: unknown;
};
assert.equal(alternateError.safeCode, "integrity_failed");
assert.equal(alternateError.message, "integrity_failed");
assert.equal(alternateError.stack, undefined);
assert.equal(Object.isFrozen(alternateError), true);
assert.equal(Reflect.construct(parseContract, [contract]), contract);
assert.equal(Reflect.construct(parseResult, [result]), result);

// Group 6: every observation, proof, blocker, authority, wiring, and effect truth is exhaustive false/zero.
const contractFalseKeys = [
  "repositoryFakeHostObservationAllowed", "realProviderImplemented", "realVerifierImplemented",
  "clearsTargetRuntimeAttestationBlocker", "grantsApproval", "grantsNetworkAuthority",
  "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
] as const;
for (const key of contractFalseKeys) assert.equal(contract[key], false, key);
for (const key of [
  "requiresFreshNonce", "requiresTrustedClock", "requiresPlatformSigner",
  "requiresIndependentCheckpoint", "forbidsRawOrGuessableHostIdentity",
] as const) assert.equal(contract[key], true, key);
const resultFalseKeys = [
  "hostObservationPerformed", "rawHostIdentityPresent", "stableHostTransformPresent",
  "platformFamilyObserved", "architectureObserved", "runtimeVersionObserved", "runtimeExecutableBound",
  "bootEpochBound", "processSessionEpochBound", "qualificationHarnessBound", "acceptedPhysicalDriverBound",
  "qualificationCandidateBound", "qualificationAttemptBound", "freshNonceConsumed", "trustedClockPresent",
  "platformSignerPresent", "independentCheckpointPresent", "realAttestationEnvelopePresent",
  "realAttestationVerified", "durableAcceptanceRecorded", "targetRuntimeAttestationAccepted",
  "clearsTargetRuntimeAttestationBlocker", "activationEligible", "externalEffectOccurred", "runtimeWired",
  "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
  "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
] as const;
for (const key of resultFalseKeys) assert.equal(result[key], false, key);
assert.equal(result.targetRuntimeAttestationMissing, true);
const resultZeroKeys = [
  "hostObservationAttempts", "platformSignerCalls", "nativeBackendConstructions", "listenerAttemptsMade",
  "ipcListenerAttemptsMade", "socketAttemptsMade", "portSelectionsMade", "networkIoEventsObserved",
  "protectedValuesRead",
] as const;
for (const key of resultZeroKeys) assert.equal(result[key], 0, key);

// Group 7: policy, digest, lifetime, blocker, and authority relabeling never becomes provenance.
expectSafeCode(() => parseResult({ ...result, evidenceClass: "real_target_runtime_attestation" }), "invalid_result");
expectSafeCode(() => parseResult({ ...result, hostObservationPerformed: true }), "invalid_result");
expectSafeCode(() => parseResult({ ...result, targetRuntimeAttestationMissing: false, targetRuntimeAttestationAccepted: true }), "invalid_result");
expectSafeCode(() => parseResult({ ...result, clearsTargetRuntimeAttestationBlocker: true }), "invalid_result");
expectSafeCode(() => parseResult({ ...result, grantsQualificationAuthority: true, grantsActivationAuthority: true }), "invalid_result");
expectSafeCode(() => parseResult({ ...result, contractDigest: `sha256:${"2".repeat(64)}` }), "invalid_result");
expectSafeCode(() => parseContract({ ...contract, maximumFutureAttestationLifetimeSeconds: 600 }), "invalid_contract");
expectSafeCode(() => parseContract({ ...contract, grantsExecutionAuthority: true }), "invalid_contract");

// Group 8: machine, user, path, process, network, tunnel, key, credential, owner, and native text is contained.
for (const raw of [
  "hardwareUuid=FABRICATED-SERIAL",
  "userName=fabricated /Users/example/work",
  "pid=1234 processArguments=--token=fabricated",
  "environmentVariables=API_KEY=fabricated-secret-value",
  "127.0.0.1:65123 macAddress=00:00:00:00:00:00",
  "sshPeer=fabricated hostKeyMaterial=fabricated",
  "credentialMaterial=fabricated-private-key ownerIdentity=fabricated",
  "native error from system_profiler",
  "sha256:guessable-stable-machine-transform",
]) {
  hostileAttempts += 1;
  const safe = new SafeError(raw);
  assert.equal(safe.safeCode, "integrity_failed");
  assert.equal(safe.message, "integrity_failed");
  assert.equal(safe.stack, undefined);
}
const publicSerialization = JSON.stringify({ contract, result });
assert.doesNotMatch(publicSerialization,
  /127\.0\.0\.1|localhost|"port"\s*:|\/Users\/|hardwareUuid|serialNumber|machineFingerprint|userName|homeDirectory|workingDirectory|processArguments|environmentVariables|macAddress|sshPeer|hostKeyMaterial|credentialMaterial|ownerIdentity|BEGIN PRIVATE KEY|system_profiler/i);
expectSafeCode(() => parseResult({ ...result, ownerIdentity: "fabricated" }), "invalid_result");
expectSafeCode(() => parseContract({ ...contract, stableMachineTransform: "sha256:guessable" }), "invalid_contract");

// Groups 9-11: literal-manifest import, initialization, consumer, and issuer inspection.
const attestationSource = await readFile(resolve(repositoryRoot,
  "src/connection-registry/v1/private-loopback-target-runtime-attestation.ts"), "utf8");
const barrelSource = await readFile(resolve(repositoryRoot, "src/connection-registry/v1/index.ts"), "utf8");
const securityIndexSource = await readFile(resolve(repositoryRoot, "src/security/index.ts"), "utf8");
const digestSource = await readFile(resolve(repositoryRoot, "src/security/digest.ts"), "utf8");
const redactionSource = await readFile(resolve(repositoryRoot, "src/security/redaction.ts"), "utf8");
const hostValueSource = await readFile(resolve(repositoryRoot, "src/security/host-value.ts"), "utf8");
const focusedTestSource = await readFile(resolve(repositoryRoot,
  "tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts"), "utf8");
assert.equal(attestationSource.includes('from "../../security"'), true);
assert.equal(attestationSource.includes('from "../../security/host-value"'), true);
assert.doesNotMatch(attestationSource,
  /from\s+["']node:(?:os|process|fs|child_process|net|http|https|tls|dgram|worker_threads|crypto|timers)["']|private-loopback-physical-native-driver|system_profiler|ioreg|sysctl|uname|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|createServer\s*\(|\.listen\s*\(|new\s+Socket\s*\(|fetch\s*\(|WebSocket|ssh2|setTimeout\s*\(|setInterval\s*\(/);
assert.equal(barrelSource.includes('export * from "./private-loopback-target-runtime-attestation"'), true);
for (const dependencySource of [securityIndexSource, digestSource, redactionSource, hostValueSource]) {
  assert.equal(dependencySource.includes("private-loopback-physical-native-driver"), false);
  assert.equal(dependencySource.includes("private-loopback-target-runtime-attestation"), false);
}
assert.equal(focusedTestSource.includes('"../src/connection-registry/v1/private-loopback-target-runtime-attestation"'), true);
assert.equal(focusedTestSource.includes("const sourcePaths = await sourceFiles(resolve(root, \"src\"))"), true);
assert.equal(focusedTestSource.includes("assert.deepEqual(consumers, [resolve(root, \"src/connection-registry/v1/index.ts\")])"), true);
assert.equal(barrel.connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1, contract);
assert.equal(barrel.connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1, result);
assert.equal(barrel.parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1, parseContract);
assert.equal(barrel.parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1, parseResult);
const exactExports = [
  "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1",
  "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_CONTRACT_V1",
  "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_RESULT_V1",
  "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1",
  "ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1",
  "connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1",
  "connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1",
  "parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1",
  "parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1",
].sort();
assert.deepEqual(Object.keys(direct).sort(), exactExports);
assert.doesNotMatch(attestationSource,
  /export\s+(?:async\s+)?function\s+(?:observe|collect|issue|sign|verify|clear|assemble|consume|activate|admit|connect)|export\s+class\s+(?:Provider|Signer|Verifier|Listener|Candidate|Admission)/i);

// Group 12: exact zero effects and hostile executions, then one frozen JSON summary.
assert.equal(hostileAttempts, 63);
assert.equal(hostileBehaviorExecutions, 0);
assert.equal(ambientReplacementAttempts, 8);
assert.equal(ambientReplacementExecutions, 0);
const summary = Object.freeze({
  disposition: "pass",
  productCommit: "6e716bd77c26ad7f70343ddd687dff990f5db12f",
  productTree: "4010bdaa5fd90f486d7ccad6185a2116dd9345af",
  designParent: "154231858828603d167c12371863bc0562f2e795",
  live130ProductCommit: contract.live130ProductCommit,
  live130ProductTree: contract.live130ProductTree,
  acceptedPhysicalDriverCommit: contract.acceptedPhysicalDriverCommit,
  groups: Object.freeze([
    "1_exact_predecessor_identities:pass",
    "2_exact_private_provenance:pass",
    "3_frozen_architecture_and_claim_policy:pass",
    "4_captured_intrinsic_replacement:pass",
    "5_callable_prototype_subclass_new_target_receiver:pass",
    "6_exhaustive_false_zero_truth:pass",
    "7_fake_relabel_digest_lifetime_blocker_authority:pass",
    "8_expanded_sanitation:pass",
    "9_literal_manifest_import_initialization_exclusions:pass",
    "10_safe_barrel_only_consumption:pass",
    "11_no_issuer_surface:pass",
    "12_exact_hostile_and_effect_totals:pass",
  ]),
  hostileAttempts,
  hostileBehaviorExecutions,
  ambientReplacementAttempts,
  ambientReplacementExecutions,
  literalManifestReads: 7,
  protectedValueExposures: 0,
  hostObservations: 0,
  physicalDriverImports: 0,
  nativeBackendConstructions: 0,
  capabilitiesIssued: 0,
  admissionsIssued: 0,
  candidatesAssembled: 0,
  ownerSpends: 0,
  physicalListenerAttempts: 0,
  ipcListenerAttempts: 0,
  socketAttempts: 0,
  portAttemptsOrSelections: 0,
  networkIoEvents: 0,
  externalEffects: 0,
});
console.log(JSON.stringify(summary));
