import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as candidateModule from
  "../src/connection-registry/v1/private-loopback-physical-qualification-candidate-contract";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CEILINGS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_COMPONENTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STAGES_V1,
  ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1,
  assessConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateV1,
  connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1,
  connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1,
  parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1,
  parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
type SafeCode = ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1
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

test("CR13A-LIVE-280 pins accepted LIVE270 and exact frozen sets", () => {
  const contract = connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1;
  assert.equal(contract.live270ProductCommit, "5e5384b1c7b3806a62672018843aa318b0e75728");
  assert.equal(contract.acceptedLive270ReviewSha256,
    "96edcc2c9c65ea38b3da1adec7c092fdf056e544f02856705e93ce0f19d79609");
  assert.match(contract.contractReference, /^physical-qualification-candidate:[a-f0-9]{24}$/);
  assert.deepEqual([contract.components.length, contract.stages.length, contract.blockers.length,
    contract.oneAttemptCeilings.length], [15, 10, 14, 21]);
  for (const value of [contract.components, contract.stages, contract.blockers, contract.oneAttemptCeilings]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1(contract), contract);
});

test("CR13A-LIVE-280 fixes every future real component and rejects repository-fake substitution", () => {
  const contract = connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1;
  assert.deepEqual(contract.components,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_COMPONENTS_V1);
  assert.deepEqual(contract.components, [
    "accepted_physical_native_driver_and_native_issuer",
    "accepted_live270_private_composition_shell",
    "real_target_runtime_attestation",
    "private_literal_loopback_locator_broker",
    "exclusive_operating_system_port_reservation_and_custody",
    "one_use_retained_resource_handoff_capability",
    "exact_private_native_retained_resource_adapter",
    "platform_evidence_signer_and_trusted_clock",
    "durable_attempt_claim_spend_uncertainty_result_and_tombstone_ledger",
    "independently_held_high_water_checkpoint",
    "independent_native_resource_and_cleanup_observer",
    "authenticated_tunnel_peer_proof_and_accepted_host_key_custody",
    "exact_candidate_attempt_connection_tenant_node_route_server_and_provider_epochs",
    "fixed_ceilings_deadlines_cleanup_no_reopen_and_sanitation_policy",
    "separate_fresh_owner_authorization_reference",
  ]);
  assert.equal(contract.repositoryFakeSatisfiesRealComponent, false);
  assert.equal(contract.callerReadinessAssertionAllowed, false);
  assert.equal(contract.publicCandidateAssemblyAllowed, false);
});

test("CR13A-LIVE-280 preserves the ten separate stages and all fourteen blockers", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STAGES_V1, [
    "accepted_repository_source_and_reviews", "effect_free_candidate_contract",
    "accepted_real_private_providers_and_durable_stores", "private_candidate_assembler",
    "inert_assembled_candidate", "fresh_one_use_owner_authorization", "single_owner_attended_physical_attempt",
    "sanitized_result_and_independent_absence_observation", "different_independent_evidence_review",
    "separate_runtime_activation_decision",
  ]);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1, [
    "real_target_runtime_attestation_missing", "private_locator_broker_missing",
    "exclusive_port_custody_missing", "platform_evidence_signer_missing", "durable_attempt_ledger_missing",
    "independent_high_water_checkpoint_missing", "native_resource_observer_missing", "tunnel_peer_proof_missing",
    "accepted_host_key_custody_missing", "private_candidate_assembler_missing",
    "fresh_owner_authorization_missing", "physical_qualification_missing",
    "independent_qualification_review_missing", "runtime_activation_approval_missing",
  ]);
  assert.equal(connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1.blockers,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1);
});

test("CR13A-LIVE-280 freezes one-use ceilings and terminal no-retry truth", () => {
  const contract = connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1;
  assert.equal(contract.oneAttemptCeilings,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CEILINGS_V1);
  assert.equal(contract.maximumPerCeiling, 1);
  assert.equal(contract.oneAttemptCeilings.length, 21);
  assert.equal(new Set(contract.oneAttemptCeilings).size, 21);
  assert.equal(contract.automaticRetryAllowed, false);
  assert.equal(contract.retryAfterUncertaintyAllowed, false);
  assert.equal(contract.replacementResourceAllowed, false);
  assert.equal(contract.reopenAllowed, false);
});

test("CR13A-LIVE-280 exposes honest blocked zero-effect and false-authority status", () => {
  const status = assessConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateV1();
  assert.equal(status, connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1(status), status);
  const counts = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  assert.equal(counts.length, 31);
  assert.deepEqual(counts, new Array(31).fill(0));
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.sourceState, "accepted_repository_source");
  assert.equal(status.prerequisiteState, "real_prerequisites_missing");
  assert.equal(status.candidateState, "not_assembled");
  assert.equal(status.physicalAttemptState, "not_attempted");
  assert.equal(status.runtimeState, "not_wired");
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.candidateEligible, false);
  assert.equal(status.activationEligible, false);
});

test("CR13A-LIVE-280 contract cannot self-accept or grant readiness", () => {
  const contract = connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1;
  assert.equal(contract.repositorySourceAccepted, true);
  assert.equal(contract.candidateContractImplementationPresent, true);
  for (const key of ["candidateContractSelfAccepted", "realPrerequisitesAccepted",
    "privateCandidateAssemblerImplemented", "candidateAssembled", "ownerAuthorizationPresent",
    "physicalAttemptPerformed", "physicalQualificationAccepted", "runtimeWired", "activationEligible",
    "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  ] as const) assert.equal(contract[key], false, key);
  assert.equal(contract.repositoryContractOnly, true);
});

test("CR13A-LIVE-280 exact parsers reject copies, symbols, accessors, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1({
    ...connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1({
    ...connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1(
    Symbol("candidate")), "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw candidate accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw candidate proxy"); },
    get() { executions += 1; throw new Error("raw candidate proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1(proxy),
    "invalid_status");
  assert.equal((assessConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateV1 as
    (...args: unknown[]) => unknown)(proxy),
  connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1);
  assert.equal(executions, 0);
});

test("CR13A-LIVE-280 freezes records and callable surfaces and sanitizes errors", () => {
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1), true);
  for (const callable of [ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1,
    parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1,
    parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1,
    assessConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateV1]) {
    assert.equal(Object.isFrozen(callable), true);
  }
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1.prototype),
    true);
  const error = new ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1("raw private value");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-280 uses captured validation intrinsics after ambient replacement", () => {
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
    Reflect.apply = () => { executions[4] += 1; throw new Error("raw candidate ambient"); };
    defineProperty(globalThis, "Object", { configurable: true,
      get() { globalObjectReads += 1; return objectConstructor; } });
    assert.equal(parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1(
      connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1),
    connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1(
      connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1),
    connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1);
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

test("CR13A-LIVE-280 exports no candidate assembler and remains native-free and unwired", async () => {
  const allowedFunctions = new Set([
    "ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1",
    "assessConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateV1",
    "parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1",
    "parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1",
  ]);
  for (const [name, value] of Object.entries(candidateModule)) {
    if (typeof value === "function") assert.equal(allowedFunctions.has(name), true, name);
  }
  const modulePath = resolve(root, "src/connection-registry/v1",
    "private-loopback-physical-qualification-candidate-contract.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from ["']node:net|from ["']node:os|from ["']node:fs|from ["']node:child_process/);
  assert.doesNotMatch(source, /private-loopback-native-retained-resource-issuer-implementation/);
  assert.doesNotMatch(source, /private-loopback-physical-native-driver/);
  assert.doesNotMatch(source, /createServer|\.listen\(|\.close\(|process\.|setTimeout|setInterval/);
  const consumers: string[] = [];
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    const sourceText = await readFile(file, "utf8");
    if (sourceText.includes("private-loopback-physical-qualification-candidate-contract")) consumers.push(file);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
