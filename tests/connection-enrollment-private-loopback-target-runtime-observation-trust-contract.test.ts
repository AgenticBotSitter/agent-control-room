import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as trustModule from
  "../src/connection-registry/v1/private-loopback-target-runtime-observation-trust-contract";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_OBSERVATION_TRUST_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_OBSERVATION_TRUST_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_OBSERVATION_TRUST_STAGES_V1,
  ConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustErrorV1,
  assessConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustV1,
  connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1,
  connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1,
  parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1,
  parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
type SafeCode = ConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustErrorV1
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

test("CR13A-LIVE-300 pins accepted LIVE290 and exact frozen trust sets", () => {
  const contract = connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1;
  assert.equal(contract.live290ProductCommit, "3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba");
  assert.equal(contract.acceptedLive290ReviewSha256,
    "df2f3fb2fd414d595f020395dfc69fde2857c413e82d8d206383e66c6555c9b6");
  assert.match(contract.contractReference, /^target-runtime-observation-trust:[a-f0-9]{24}$/);
  assert.deepEqual([contract.rules.length, contract.stages.length, contract.blockers.length], [11, 12, 16]);
  for (const value of [contract.rules, contract.stages, contract.blockers]) assert.equal(Object.isFrozen(value), true);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1(contract), contract);
});

test("CR13A-LIVE-300 rejects every ambient or caller-controlled native evidence source", () => {
  const contract = connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1;
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_OBSERVATION_TRUST_RULES_V1, [
    "reject_ambient_global_process", "reject_caller_native_bindings", "reject_accessor_backed_bindings",
    "reject_proxy_derived_bindings", "reject_input_selected_dynamic_import", "reject_mutable_callbacks",
    "validate_exact_private_binding_descriptors_before_read",
    "keep_raw_observation_private_and_untrusted_until_attested",
    "bind_attestation_to_clock_nonce_signer_candidate_attempt_and_replay_checkpoint",
    "treat_post_retrieval_uncertainty_as_terminal", "sanitize_public_evidence",
  ]);
  for (const key of ["ambientGlobalProcessAllowed", "callerNativeBindingsAllowed", "accessorBackedBindingsAllowed",
    "proxyDerivedBindingsAllowed", "inputSelectedDynamicImportAllowed", "mutableCallbacksAllowed",
    "callerReadinessAssertionAllowed", "repositoryFakeSatisfiesRealEvidence",
  ] as const) assert.equal(contract[key], false, key);
});

test("CR13A-LIVE-300 preserves twelve non-collapsible future stages", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_OBSERVATION_TRUST_STAGES_V1, [
    "accepted_source_binding", "private_trusted_binding_capture", "descriptor_validation",
    "one_use_retrieval_authorization", "observer_retrieval", "private_raw_observation",
    "nonce_and_trusted_clock_binding", "platform_signature", "durable_replay_checkpoint_commit",
    "private_candidate_assembly", "fresh_owner_authorization", "single_owner_attended_physical_attempt",
  ]);
  assert.equal(connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1.maximumEntriesPerStage, 1);
  assert.equal(new Set(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_OBSERVATION_TRUST_STAGES_V1).size, 12);
});

test("CR13A-LIVE-300 retains every missing real prerequisite and terminal uncertainty rule", () => {
  const contract = connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1;
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_OBSERVATION_TRUST_BLOCKERS_V1, [
    "trusted_native_binding_capture_missing", "native_binding_descriptor_validation_missing",
    "one_use_observer_retrieval_authority_missing", "private_observer_lookup_missing",
    "private_observer_invocation_missing", "private_raw_observation_missing", "trusted_clock_missing",
    "fresh_nonce_missing", "platform_evidence_signer_missing", "durable_replay_checkpoint_missing",
    "target_runtime_attestation_missing", "private_candidate_assembler_missing",
    "fresh_owner_authorization_missing", "physical_qualification_missing",
    "independent_qualification_review_missing", "runtime_activation_approval_missing",
  ]);
  assert.equal(connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1.blockers,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_OBSERVATION_TRUST_BLOCKERS_V1);
  assert.equal(contract.automaticRetryAllowed, false);
  assert.equal(contract.retryAfterUncertaintyAllowed, false);
  assert.equal(contract.replacementObservationAllowed, false);
  assert.equal(contract.reopenAllowed, false);
});

test("CR13A-LIVE-300 exposes honest contract-only zero-effect status", () => {
  const status = assessConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustV1();
  assert.equal(status, connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1(status), status);
  const counts = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  assert.equal(counts.length, 32);
  assert.deepEqual(counts, new Array(32).fill(0));
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.trustBoundaryState, "contract_only");
  assert.equal(status.nativeBindingState, "not_captured");
  assert.equal(status.observerState, "unreachable_and_uninvoked");
  assert.equal(status.attestationState, "not_created");
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.candidateEligible, false);
  assert.equal(status.activationEligible, false);
});

test("CR13A-LIVE-300 cannot self-implement, self-accept, or grant authority", () => {
  const contract = connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1;
  assert.equal(contract.contractImplementationPresent, true);
  assert.equal(contract.repositoryContractOnly, true);
  for (const key of ["trustedBindingCaptureImplemented", "descriptorValidationImplemented",
    "observerLookupImplemented", "observerInvocationImplemented", "rawObservationImplemented",
    "attestationImplemented", "replayCheckpointImplemented", "candidateAssemblerImplemented",
    "ownerAuthorizationPresent", "physicalAttemptPerformed", "runtimeWired", "activationEligible",
    "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  ] as const) assert.equal(contract[key], false, key);
});

test("CR13A-LIVE-300 identity parsers reject copies, accessors, proxies, symbols, and extras without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1({
    ...connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1({
    ...connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1(
    Symbol("trust")), "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw trust accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw trust proxy"); },
    get() { executions += 1; throw new Error("raw trust proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1(proxy),
    "invalid_status");
  assert.equal((assessConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustV1 as
    (...args: unknown[]) => unknown)(proxy),
  connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1);
  assert.equal(executions, 0);
});

test("CR13A-LIVE-300 freezes callable surfaces and emits only safe errors", () => {
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1), true);
  for (const callable of [ConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustErrorV1,
    parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1,
    parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1,
    assessConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustV1]) {
    assert.equal(Object.isFrozen(callable), true);
  }
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustErrorV1.prototype),
    true);
  const error = new ConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustErrorV1("raw process value");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-300 parsing uses captured validation intrinsics after ambient replacement", () => {
  const objectConstructor = Object;
  const defineProperty = objectConstructor.defineProperty;
  const originalGlobalObject = objectConstructor.getOwnPropertyDescriptor(globalThis, "Object");
  const originalFreeze = objectConstructor.freeze;
  const originalIsFrozen = objectConstructor.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalReflectApply = Reflect.apply;
  const executions = new Array(5).fill(0);
  let globalObjectReads = 0;
  try {
    objectConstructor.freeze = <T>(value: T): Readonly<T> => { executions[0] += 1; return value; };
    objectConstructor.isFrozen = () => { executions[1] += 1; return false; };
    WeakSet.prototype.has = function () { executions[2] += 1; return false; };
    WeakMap.prototype.get = function () { executions[3] += 1; return undefined; };
    Reflect.apply = () => { executions[4] += 1; throw new Error("raw trust ambient"); };
    defineProperty(globalThis, "Object", { configurable: true,
      get() { globalObjectReads += 1; return objectConstructor; } });
    assert.equal(parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1(
      connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1),
    connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1(
      connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1),
    connectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1);
  } finally {
    objectConstructor.freeze = originalFreeze;
    objectConstructor.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Reflect.apply = originalReflectApply;
    if (originalGlobalObject) defineProperty(globalThis, "Object", originalGlobalObject);
  }
  assert.deepEqual(executions, new Array(5).fill(0));
  assert.equal(globalObjectReads, 0);
});

test("CR13A-LIVE-300 exports no native input or effect surface and has only the safe-barrel consumer", async () => {
  const allowedFunctions = new Set([
    "ConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustErrorV1",
    "assessConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustV1",
    "parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustContractV1",
    "parseConnectionEnrollmentPrivateLoopbackTargetRuntimeObservationTrustStatusV1",
  ]);
  for (const [name, value] of Object.entries(trustModule)) {
    if (typeof value === "function") assert.equal(allowedFunctions.has(name), true, name);
  }
  const modulePath = resolve(root, "src/connection-registry/v1",
    "private-loopback-target-runtime-observation-trust-contract.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from ["']node:(?:os|process|net|fs|child_process|dns|http|https|crypto)/);
  assert.doesNotMatch(source, /native-target-runtime-observer-implementation/);
  assert.doesNotMatch(source, /createServer|\.listen\(|\.close\(|globalThis\.process|process\.(?:env|pid|ppid|version|execPath)/);
  assert.doesNotMatch(source, /setTimeout|setInterval|dynamic import|import\(/);
  const consumers: string[] = [];
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    const sourceText = await readFile(file, "utf8");
    if (sourceText.includes("private-loopback-target-runtime-observation-trust-contract")) consumers.push(file);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
