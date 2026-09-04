import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1,
  ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1,
  connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1,
  connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1,
  parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1,
  parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1,
} from "../src/connection-registry/v1/private-loopback-atomic-native-observation-composition-contract";

const root = resolve(import.meta.dirname, "..");
const modulePath = resolve(root, "src/connection-registry/v1",
  "private-loopback-atomic-native-observation-composition-contract.ts");
type SafeCode = ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1
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

test("CR13A-LIVE-320 binds the exact accepted observer and validator evidence", () => {
  const contract = connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1;
  assert.equal(contract.live290ProductCommit, "3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba");
  assert.equal(contract.acceptedLive290ReviewSha256,
    "df2f3fb2fd414d595f020395dfc69fde2857c413e82d8d206383e66c6555c9b6");
  assert.equal(contract.live310IntegrationProduct, "d95738bf79f9f12f6986f28b8f7548b661f0587a");
  assert.equal(contract.acceptedLive310ReviewSha256,
    "db3c721a2ad20b9f533202bc48275df6617035d30eb27df52900d8f97dbdb20e");
  assert.match(contract.contractReference, /^atomic-native-observation-composition:[a-f0-9]{24}$/);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1(contract),
    contract);
});

test("CR13A-LIVE-320 freezes complete atomic rules, stage order, and blockers", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_RULES_V1, [
    "co_locate_static_native_sources", "keep_consolidated_callable_private",
    "reject_cross_module_callable_export_or_lookup", "reject_caller_native_bindings_and_descriptors",
    "validate_exact_own_data_descriptors", "require_writable_enumerable_nonconfigurable_shape",
    "consume_validated_descriptor_values_once", "prohibit_second_namespace_read",
    "remain_synchronous_without_interleaving", "validate_os_observation_shape_and_bounds",
    "treat_partial_or_uncertain_observation_as_terminal", "keep_raw_observation_private",
    "sanitize_public_evidence",
  ]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1.length, 15);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1[3],
    "same_module_unreachable_source_consolidation");
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1[4],
    "one_use_retrieval_and_invocation_authorization");
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1[14],
    "separate_runtime_activation_approval");
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_BLOCKERS_V1.length, 14);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_BLOCKERS_V1[0],
    "atomic_native_observation_composition_missing");
  for (const value of [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_RULES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_BLOCKERS_V1]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("CR13A-LIVE-320 requires private synchronous validated-value consumption without fallback", () => {
  const contract = connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1;
  for (const key of ["sameModuleRequired", "noInputRequired", "synchronousRequired",
    "validatedDescriptorValueConsumptionRequired", "compositionContractImplemented", "repositoryContractOnly",
  ] as const) assert.equal(contract[key], true, key);
  for (const key of ["secondNamespaceReadAllowed", "crossModuleCallableExportAllowed", "callerBindingAllowed",
    "callerDescriptorAllowed", "callbackAllowed", "promiseOrAwaitAllowed", "timerAllowed",
    "automaticRetryAllowed", "replacementBindingAllowed", "partialObservationAllowed",
    "repositoryFakeSatisfiesRealObservation", "atomicCompositionImplemented", "compositionRetrievable",
    "compositionInvoked", "descriptorValidationImplemented", "rawObservationImplemented",
    "attestationImplemented", "replayCheckpointImplemented", "candidateAssemblerImplemented",
    "ownerAuthorizationPresent", "physicalAttemptPerformed", "runtimeWired", "activationEligible",
    "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  ] as const) assert.equal(contract[key], false, key);
  assert.equal(contract.maximumCompositionEntries, 1);
});

test("CR13A-LIVE-320 publishes 32 zero actuals and eight false grants", () => {
  const status = connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1(status), status);
  const actual = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actual.length, 32);
  assert.deepEqual(actual, new Array(32).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.compositionState, "contract_only");
  assert.equal(status.observerSourceState, "accepted_isolated_unreachable_uninvoked");
  assert.equal(status.validatorSourceState, "accepted_isolated_unreachable_uninvoked");
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.targetRuntimeBlockerCleared, false);
});

test("CR13A-LIVE-320 exact parsers reject copies, symbols, accessors, and proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1({
    ...connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1({
    ...connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1(
    Symbol("composition")), "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw composition accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw composition proxy"); },
    get() { executions += 1; throw new Error("raw composition proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-320 freezes records, callables, arrays, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1,
    connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1,
    ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1,
    ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1,
    parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1("raw host value");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-320 parsers retain captured intrinsics after ambient replacement", () => {
  const objectConstructor = Object;
  const originalFreeze = objectConstructor.freeze;
  const originalIsFrozen = objectConstructor.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalArraySome = Array.prototype.some;
  const originalReflectApply = Reflect.apply;
  const executions = new Array(6).fill(0);
  let parsedContract: unknown;
  let parsedStatus: unknown;
  try {
    objectConstructor.freeze = <T>(value: T): Readonly<T> => { executions[0] += 1; return value; };
    objectConstructor.isFrozen = () => { executions[1] += 1; return false; };
    WeakSet.prototype.has = function () { executions[2] += 1; return false; };
    WeakMap.prototype.get = function () { executions[3] += 1; return undefined; };
    Array.prototype.some = function () { executions[4] += 1; throw new Error("raw composition ambient"); };
    Reflect.apply = () => { executions[5] += 1; throw new Error("raw composition ambient"); };
    parsedContract = parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1(
      connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1(
      connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1);
  } finally {
    objectConstructor.freeze = originalFreeze;
    objectConstructor.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedContract, connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1);
  assert.deepEqual(executions, new Array(6).fill(0));
});

test("CR13A-LIVE-320 source contains no native implementation, native import, or executable composition", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from "node:/);
  assert.doesNotMatch(source, /native-target-runtime-(?:observer|binding-validator)-implementation/);
  assert.doesNotMatch(source, /globalThis\.process|\bprocess\.(?:version|execPath|pid|ppid|env|argv|cwd)/);
  assert.doesNotMatch(source, /getOwnPropertyDescriptor|createServer|\.listen\(|fetch\(|setTimeout|setInterval/);
  assert.doesNotMatch(source, /function (?:create|invoke|retrieve).*NativeObservation/);
  const consumers: string[] = [];
  const barrelPath = resolve(root, "src/connection-registry/v1/index.ts");
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath || file === barrelPath) continue;
    const sourceText = await readFile(file, "utf8");
    if (sourceText.includes("private-loopback-atomic-native-observation-composition-contract")) consumers.push(file);
  }
  assert.deepEqual(consumers, []);
});

test("CR13A-LIVE-320 architecture, build plan, and status retain the no-effect boundary", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_320_PRIVATE_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_CONTRACT.md"), "utf8");
  const plan = await readFile(resolve(root, "docs/CR3_BUILD_PLAN.md"), "utf8");
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  for (const text of [architecture, plan, status]) {
    assert.match(text, /CR13A-LIVE-320/);
    assert.match(text, /atomic/i);
    assert.match(text, /no (?:native import|lookup|native-source)|must not import/i);
  }
  assert.match(architecture, /consume the already validated descriptor values directly/);
  assert.match(architecture, /no retry, replacement binding, fallback, or partial result/);
});

test("CR13A-LIVE-320 public records contain no raw native or host material", () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1,
    status: connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1("private value"),
  });
  assert.doesNotMatch(serialized,
    /executablePath|processIdentifier|parentProcessIdentifier|runtimeVersion|osRelease|uptimeSeconds|hostname|username/);
  assert.doesNotMatch(serialized, /stack|private value|127\.0\.0\.1|localhost/);
});
