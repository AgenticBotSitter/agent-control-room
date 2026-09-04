import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as shellModule from
  "../src/connection-registry/v1/private-loopback-native-composition-shell-contract";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CALL_GRAPH_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CUSTODY_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_FAILURES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_PRIVACY_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_RESTART_V1,
  ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1,
  assessConnectionEnrollmentPrivateLoopbackNativeCompositionShellV1,
  connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1,
  connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1,
  parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1,
  parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
type SafeCode = ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1
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

test("CR13A-LIVE-260 pins accepted LIVE250 and all fixed contract sets", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1;
  assert.equal(contract.live250ProductCommit, "9b855d4193837fdf6d0d0fce1dcfd65a94cce49f");
  assert.equal(contract.acceptedLive250ReviewSha256,
    "2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6");
  assert.match(contract.contractReference, /^native-composition-shell:[a-f0-9]{24}$/);
  assert.equal(contract.callGraph, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CALL_GRAPH_V1);
  assert.deepEqual([contract.callGraph.length, contract.failures.length, contract.custody.length,
    contract.restart.length, contract.privacy.length, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_BLOCKERS_V1.length],
  [14, 7, 8, 6, 8, 7]);
  for (const value of [contract.callGraph, contract.failures, contract.custody, contract.restart, contract.privacy,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_BLOCKERS_V1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1(contract), contract);
});

test("CR13A-LIVE-260 fixes the one-use call graph and separates retrieval from invocation", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1;
  assert.deepEqual(contract.callGraph, [
    "enter_non_exported_no_input_native_composition",
    "verify_exact_accepted_live250_product_and_review",
    "verify_module_owned_implementation_composition_attempt_epoch_window_and_expiry",
    "verify_durable_claim_locator_spend_custody_spend_and_uncertainty_marker",
    "enter_live250_synchronous_private_bridge_section",
    "consume_bridge_once_before_private_factory_lookup",
    "hand_exact_factory_directly_into_shell_lexical_scope",
    "record_private_factory_receipt_without_return_serialization_log_or_digest",
    "invoke_exact_factory_once_separately_from_retrieval",
    "classify_native_settlement_without_retry",
    "retain_continuous_issuer_custody_over_exact_created_resource",
    "observe_private_locator_and_offer_same_resource_to_exact_adapter_once",
    "atomically_transfer_custody_after_acceptance_and_close_once_by_current_owner",
    "durably_reconcile_cleanup_absence_tombstone_and_checkpoint_without_reopen",
  ]);
  assert.deepEqual([
    contract.maximumShellEntries, contract.maximumBridgeConsumptions, contract.maximumFactoryLookups,
    contract.maximumFactoryReceipts, contract.maximumFactoryInvocations, contract.maximumNativeConstructions,
    contract.maximumListenerAttempts, contract.maximumLocatorObservations, contract.maximumAdapterAccepts,
    contract.maximumOwnershipTransfers, contract.maximumCloses, contract.maximumIndependentObservations,
    contract.maximumTombstones, contract.maximumCheckpoints,
  ], new Array(14).fill(1));
  assert.equal(contract.retrievalSeparateFromInvocation, true);
  assert.equal(contract.factoryReceiptProvesInvocation, false);
  assert.equal(contract.factoryInvocationProvesResourceCreation, false);
  assert.equal(contract.postLookupRetryAllowed, false);
  assert.equal(contract.restartRetrievalOrInvocationAllowed, false);
});

test("CR13A-LIVE-260 freezes failure, custody, restart, and privacy truth", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_FAILURES_V1, [
    "definite_before_bridge_consumption", "terminal_identity_failure_after_bridge_consumption",
    "ambiguous_after_factory_lookup_even_without_proven_invocation", "definite_factory_failure_before_resource_creation",
    "adapter_rejected_issuer_retains_custody", "adapter_acceptance_uncertain_owner_unresolved",
    "cleanup_failed_observe_same_resource_only_no_reopen",
  ]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CUSTODY_V1.includes(
    "current_owner_alone_may_close_exact_object_once"), true);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_RESTART_V1.includes(
    "no_factory_invocation"), true);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_PRIVACY_V1.includes(
    "same_source_module_and_lexical_scope_only"), true);
});

test("CR13A-LIVE-260 exposes honest blocked zero-effect status", () => {
  const status = assessConnectionEnrollmentPrivateLoopbackNativeCompositionShellV1();
  assert.equal(status, connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1(status), status);
  const counts = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  assert.equal(counts.length, 20);
  assert.deepEqual(counts, new Array(20).fill(0));
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.shellState, "not_implemented");
  assert.equal(status.bridgeState, "not_implemented");
  assert.equal(status.factoryState, "sealed_unretrieved_uninvoked");
  assert.equal(status.runtimeWired, false);
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.candidateEligible, false);
  assert.equal(status.activationEligible, false);
});

test("CR13A-LIVE-260 exact parsers reject copies, symbols, accessors, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1({
    ...connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1({
    ...connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1(Symbol("shell")),
    "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw shell accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw shell proxy"); },
    get() { executions += 1; throw new Error("raw shell proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1(proxy), "invalid_status");
  assert.equal((assessConnectionEnrollmentPrivateLoopbackNativeCompositionShellV1 as
    (...args: unknown[]) => unknown)(proxy), connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1);
  assert.equal(executions, 0);
});

test("CR13A-LIVE-260 freezes records and callable surfaces and sanitizes errors", () => {
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1), true);
  for (const callable of [ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1,
    parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1,
    parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1,
    assessConnectionEnrollmentPrivateLoopbackNativeCompositionShellV1]) assert.equal(Object.isFrozen(callable), true);
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1.prototype), true);
  const error = new ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1("raw secret");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-260 uses captured validation intrinsics after ambient replacement", () => {
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
    Reflect.apply = () => { executions[4] += 1; throw new Error("raw shell ambient"); };
    defineProperty(globalThis, "Object", { configurable: true,
      get() { globalObjectReads += 1; return objectConstructor; } });
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1(
      connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1),
    connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1(
      connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1),
    connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1);
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

test("CR13A-LIVE-260 publishes no shell or bridge callable and remains native-free and unwired", async () => {
  const allowedFunctions = new Set([
    "ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1",
    "assessConnectionEnrollmentPrivateLoopbackNativeCompositionShellV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1",
  ]);
  for (const [name, value] of Object.entries(shellModule)) {
    if (typeof value === "function") assert.equal(allowedFunctions.has(name), true, name);
  }
  const modulePath = resolve(root, "src/connection-registry/v1",
    "private-loopback-native-composition-shell-contract.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /node:net|createServer|quarantinedNativeFactoriesV1/);
  assert.doesNotMatch(source, /private-loopback-native-retained-resource-issuer-implementation/);
  assert.doesNotMatch(source, /private-loopback-native-issuer-composition-implementation/);
  const consumers: string[] = [];
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    const sourceText = await readFile(file, "utf8");
    if (sourceText.includes("private-loopback-native-composition-shell-contract")) consumers.push(file);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
  const contract = connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1;
  for (const key of ["callerDependencyAccepted", "publicShellOrBridgeExportAllowed",
    "factoryReturnSerializationLoggingOrDigestAllowed", "resourceOrLocatorExportAllowed", "shellImplemented",
    "bridgeImplemented", "live220ImportedOrModified", "live240ImportedOrModified", "realFactoryReachable",
    "realFactoryRetrieved", "realFactoryInvoked", "nativeEffectReachable", "runtimeWired",
    "clearsCustodyOrHandoffBlocker", "candidateEligible", "activationEligible", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  ] as const) assert.equal(contract[key], false, key);
});
