import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLAIMS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLEANUP_FACTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_OUTCOMES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PROVIDERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RECOVERY_CASES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_STAGES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1,
  ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1,
  connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1,
  connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1,
  parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1,
  parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1,
} from "../src/connection-registry/v1/private-loopback-observation-attestation-pipeline-contract";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-observation-attestation-pipeline-contract";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
type SafeCode = ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1
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

test("CR13A-LIVE-460 binds the exact accepted LIVE-450 architecture", async () => {
  const contract = connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1;
  assert.equal(contract.live450ArchitectureCommit, "8413ad8acca4dbd79ffd56b666ad3c0a25351a36");
  assert.equal(contract.acceptedLive450DesignSha256,
    "f22f583485c5cebb3bd3fad5d698bbfa9740fb9f54246be27505d842c2740e6e");
  assert.equal(contract.acceptedLive450ReviewSha256,
    "f84d2b4ded765a76ca74ab80943c2ae49f3d845e138d8e5ea2f15d6704efcea1");
  const design = await readFile(resolve(root,
    "docs/CR13A_LIVE_450_PRIVATE_OBSERVATION_ATTESTATION_PIPELINE_DESIGN.md"));
  const review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_450_ARCHITECTURE_REVIEW.md"));
  assert.equal(createHash("sha256").update(design).digest("hex"), contract.acceptedLive450DesignSha256);
  assert.equal(createHash("sha256").update(review).digest("hex"), contract.acceptedLive450ReviewSha256);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1(contract), contract);
});

test("CR13A-LIVE-460 freezes all claims, providers, stages, states, outcomes, cleanup, recovery, and successors", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLAIMS_V1, [
    "platform_family", "architecture_class", "runtime_semantic_version", "runtime_executable_content_identity",
    "operating_system_boot_epoch", "attestor_process_session_epoch", "qualification_harness_identity",
    "accepted_physical_driver_build_identity", "qualification_candidate_identity", "qualification_attempt_identity",
    "fresh_request_nonce", "trusted_observed_and_expiry_time", "platform_signer_key_identity_and_signature",
    "monotonic_acceptance_checkpoint_identity",
  ]);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PROVIDERS_V1, [
    "running_executable_content", "operating_system_boot_session", "attestor_process_session",
    "running_qualification_harness_artifact", "running_physical_driver_artifact",
  ]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_STAGES_V1.length, 36);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1.length, 9);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_OUTCOMES_V1.length, 11);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLEANUP_FACTS_V1.length, 6);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RECOVERY_CASES_V1.length, 10);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1.length, 6);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1.length, 30);
  for (const value of [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLAIMS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PROVIDERS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_STAGES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_OUTCOMES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLEANUP_FACTS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RECOVERY_CASES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("CR13A-LIVE-460 preserves authority, attempt, capsule, privacy, and cleanup ceilings", () => {
  const contract = connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1;
  assert.equal(contract.maximumAttestationLifetimeSeconds, 60);
  assert.equal(contract.maximumFutureNativeAttemptsPerExactProductPair, 1);
  assert.equal(contract.maximumCurrentNativeAttempts, 0);
  assert.equal(contract.maximumFutureSourceInvocations, 1);
  assert.equal(contract.maximumCurrentSourceInvocations, 0);
  assert.equal(contract.maximumFutureInvocationsPerSupplementaryProvider, 1);
  assert.equal(contract.maximumCurrentSupplementaryProviderInvocations, 0);
  for (const key of ["postgresqlSoleGlobalWriteAuthorityRequired", "independentHighWaterNonAuthoritativeRequired",
    "separateOwnerNativeAuthorizationRequired", "ownerAuthorizationBeforeSourceRequired",
    "productionModuleCapsuleRequired", "preResolvedPrivacyOperationRequired", "pairwiseDistinctKeysRequired",
    "afterExitCleanupRequiredBeforeAcceptance", "exactSplitCommitRecoveryRequired",
    "directModuleFixedScenarioTestSeamRequired", "contractImplemented", "repositoryContractOnly",
  ] as const) assert.equal(contract[key], true, key);
  for (const key of ["callerDependencyInjectionAllowed", "rawObservationExportAllowed", "rawObservationDigestAllowed",
    "rawObservationPersistenceAllowed", "retryAfterUncertaintyAllowed", "sameAuthorizationReuseAllowed",
    "recoverySourceOrProviderCallAllowed", "acceptanceBeforeCleanupAllowed", "candidateProposalIsCandidate",
    "successorAuthorityGranted",
  ] as const) assert.equal(contract[key], false, key);
});

test("CR13A-LIVE-460 keeps PostgreSQL, high-water, recovery, cleanup, and successors separate", () => {
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1
    .includes("use_postgresql_as_sole_global_write_authority"));
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1
    .includes("limit_independent_high_water_to_authenticated_revision_and_head_digest"));
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1
    .includes("prohibit_source_or_provider_recall_during_recovery"));
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1
    .includes("attestation_pending_anchor"));
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1
    .includes("cleanup_pending_anchor"));
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RECOVERY_CASES_V1
    .includes("unknown_cas_allows_read_only_same_request_reconciliation_only"));
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLEANUP_FACTS_V1, [
    "qualification_process_absent", "descendants_absent", "listeners_and_enumerated_resources_absent",
    "temporary_database_closed", "disposable_root_absent", "bounded_residue_scan_clean",
  ]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1[0],
    "private_candidate_assembly");
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1.at(-1),
    "separate_runtime_activation_decision");
});

test("CR13A-LIVE-460 publishes 58 zero actuals, eight false grants, and no implementation authority", () => {
  const contract = connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1;
  for (const key of ["productionCapsuleImplemented", "supplementaryProvidersImplemented",
    "ownerNativeAuthorizationImplemented", "sourceInvocationImplemented", "privateAttestationImplemented",
    "platformSignerImplemented", "postgresqlPipelineImplemented", "independentHighWaterImplemented",
    "cleanupObserverImplemented", "candidateAssemblerImplemented", "physicalQualificationImplemented",
    "runtimeWired", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority",
  ] as const) assert.equal(contract[key], false, key);

  const status = connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1(status), status);
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 58);
  assert.deepEqual(actuals, new Array(58).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.targetRuntimeBlockerCleared, false);
  assert.equal(status.nativeAttemptState, "not_attempted");
});

test("CR13A-LIVE-460 rejects copies, accessors, Symbols, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1({
    ...connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1({
    ...connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1(Symbol("raw")),
    "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw pipeline accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw pipeline proxy"); },
    get() { executions += 1; throw new Error("raw pipeline proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-460 freezes records, parsers, arrays, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1,
    connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1,
    ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1,
    ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1,
    parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1("raw host value");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-460 parsers retain captured intrinsics after ambient replacement", () => {
  const originalIsFrozen = Object.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalArraySome = Array.prototype.some;
  const originalReflectApply = Reflect.apply;
  const executions = new Array(5).fill(0);
  let parsedContract: unknown;
  let parsedStatus: unknown;
  try {
    Object.isFrozen = () => { executions[0] += 1; return false; };
    WeakSet.prototype.has = function () { executions[1] += 1; return false; };
    WeakMap.prototype.get = function () { executions[2] += 1; return undefined; };
    Array.prototype.some = function () { executions[3] += 1; throw new Error("raw ambient"); };
    Reflect.apply = () => { executions[4] += 1; throw new Error("raw ambient"); };
    parsedContract = parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1(
      connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1(
      connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedContract, connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1);
  assert.deepEqual(executions, new Array(5).fill(0));
});

test("CR13A-LIVE-460 source has no production capsule, native source, provider, persistence, key, or effect path", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from "node:|import "node:|import\(/);
  assert.doesNotMatch(source, /private-loopback-unreachable-atomic-native-observation-source/);
  assert.doesNotMatch(source, /new (?:Map|Set)|createServer|\.listen\(|fetch\(|setTimeout|setInterval/);
  assert.doesNotMatch(source, /from ["'](?:postgres|@electric-sql\/pglite)/);
  assert.doesNotMatch(source, /insert into|update .* set|compareAndSwap|keychain|child_process|node:os|node:process/i);
  assert.doesNotMatch(source, /function (?:invoke|observe|attest|sign|persist|checkpoint|deploy)/);
});

test("CR13A-LIVE-460 has only the safe connection-registry barrel as a production consumer", async () => {
  const consumers: string[] = [];
  const barrel = resolve(root, "src/connection-registry/v1/index.ts");
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    if ((await readFile(file, "utf8")).includes(moduleName)) consumers.push(file);
  }
  assert.deepEqual(consumers, [barrel]);
});

test("CR13A-LIVE-460 public records are sanitized and durable docs preserve zero execution", async () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1,
    status: connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1("raw host value"),
  });
  assert.doesNotMatch(serialized, /\/Users\/|127\.0\.0\.1|localhost|raw host value|stack/);
  assert.doesNotMatch(serialized, /executablePath|processIdentifier|parentProcessIdentifier|hostname|username/);

  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_450_PRIVATE_OBSERVATION_ATTESTATION_PIPELINE_DESIGN.md"), "utf8");
  const plan = await readFile(resolve(root, "docs/CR3_BUILD_PLAN.md"), "utf8");
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  for (const text of [architecture, plan, status]) {
    assert.match(text, /CR13A-LIVE-4(?:50|60)/);
    assert.match(text, /36/);
    assert.match(text, /zero|no source|non-native|repository-only/i);
  }
});
