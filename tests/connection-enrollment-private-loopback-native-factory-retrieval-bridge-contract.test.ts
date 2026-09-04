import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as bridgeModule from
  "../src/connection-registry/v1/private-loopback-native-factory-retrieval-bridge-contract";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_FAILURES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_ORDER_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_PREREQUISITES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_PRIVACY_V1,
  ConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeErrorV1,
  assessConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeV1,
  connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1,
  connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1,
  parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1,
  parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
type SafeCode = ConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeErrorV1
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

test("CR13A-LIVE-250 pins both accepted boundaries and fixed contract sets", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1;
  assert.equal(contract.live220ProductCommit, "2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9");
  assert.equal(contract.acceptedLive220ReviewSha256,
    "4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30");
  assert.equal(contract.live240ProductCommit, "71e4c737b6e681fe24d730decc3497d196cf441c");
  assert.equal(contract.acceptedLive240ReviewSha256,
    "1d552ac7d580d6996b5192139dee85beb4f15e1058cf2c19719e9424f82f00f8");
  assert.match(contract.contractReference, /^native-factory-retrieval-bridge:[a-f0-9]{24}$/);
  assert.equal(contract.prerequisites,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_PREREQUISITES_V1);
  assert.equal(contract.order, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_ORDER_V1);
  assert.equal(contract.failures, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_FAILURES_V1);
  assert.equal(contract.privacy, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_PRIVACY_V1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1(contract), contract);
});

test("CR13A-LIVE-250 freezes prerequisite, order, failure, privacy, and blocker truth", () => {
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_PREREQUISITES_V1.length, 10);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_ORDER_V1.length, 9);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_FAILURES_V1.length, 5);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_PRIVACY_V1.length, 8);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_BLOCKERS_V1.length, 6);
  for (const value of [
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_PREREQUISITES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_ORDER_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_FAILURES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_PRIVACY_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_BLOCKERS_V1,
  ]) assert.equal(Object.isFrozen(value), true);
});

test("CR13A-LIVE-250 consumes before lookup and never returns or serializes a factory", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1;
  assert.deepEqual(contract.order, [
    "verify_exact_accepted_products_and_reviews",
    "verify_same_module_implementation_and_composition_identities",
    "verify_exact_attempt_epoch_owner_window_and_expiry",
    "verify_durable_claim_and_both_authority_spends",
    "verify_durable_effect_uncertainty_marker",
    "enter_one_synchronous_module_private_consumption_section",
    "consume_private_bridge_once_before_lookup",
    "lookup_exact_factory_once_from_existing_private_weak_map",
    "hand_factory_directly_to_private_composition_without_return_or_serialization",
  ]);
  assert.deepEqual([
    contract.maximumBridgeConsumptions,
    contract.maximumPrivateFactoryLookups,
    contract.maximumPrivateFactoryHandovers,
  ], [1, 1, 1]);
  assert.equal(contract.prerequisiteFailureConsumesBridge, false);
  assert.equal(contract.bridgeConsumptionPrecedesFactoryLookup, true);
  assert.equal(contract.postLookupRetryAllowed, false);
  assert.equal(contract.restartRetrievalAllowed, false);
  assert.equal(contract.sameModuleOnly, true);
  assert.equal(contract.publicGetterAllowed, false);
  assert.equal(contract.factoryReturnAllowed, false);
  assert.equal(contract.factorySerializationAllowed, false);
  assert.equal(contract.factoryLoggingAllowed, false);
});

test("CR13A-LIVE-250 exposes honest blocked zero-effect status", () => {
  const status = assessConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeV1();
  assert.equal(status, connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1(status), status);
  assert.equal(status.blockers, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_FACTORY_RETRIEVAL_BRIDGE_BLOCKERS_V1);
  assert.equal(status.bridgeState, "not_implemented");
  assert.equal(status.factoryState, "sealed_unretrieved_uninvoked");
  assert.equal(status.nativeEffectState, "unreachable");
  const counts = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  assert.equal(counts.length, 15);
  assert.deepEqual(counts, new Array(15).fill(0));
  const authorities = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(authorities.length, 8);
  assert.deepEqual(authorities, new Array(8).fill(false));
  assert.equal(status.runtimeWired, false);
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.clearsCustodyOrHandoffBlocker, false);
  assert.equal(status.candidateEligible, false);
  assert.equal(status.activationEligible, false);
});

test("CR13A-LIVE-250 exact parsers reject copies, symbols, accessors, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1({
    ...connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1({
    ...connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1(Symbol("bridge")),
    "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw bridge accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw bridge proxy"); },
    get() { executions += 1; throw new Error("raw bridge proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1(proxy),
    "invalid_status");
  assert.equal((assessConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeV1 as
    (...args: unknown[]) => unknown)(proxy),
    connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1);
  assert.equal(executions, 0);
});

test("CR13A-LIVE-250 freezes records and callable surfaces and sanitizes errors", () => {
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1), true);
  for (const callable of [
    ConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeErrorV1,
    parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1,
    parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1,
    assessConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeV1,
  ]) assert.equal(Object.isFrozen(callable), true);
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeErrorV1.prototype), true);
  const error = new ConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeErrorV1("raw secret");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.message, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-250 uses captured validation intrinsics after ambient replacement", () => {
  const objectConstructor = Object;
  const objectDefineProperty = objectConstructor.defineProperty;
  const originalGlobalObject = objectConstructor.getOwnPropertyDescriptor(globalThis, "Object");
  const originalFreeze = objectConstructor.freeze;
  const originalIsFrozen = objectConstructor.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalReflectApply = Reflect.apply;
  const executions = new Array(5).fill(0);
  let ambientGlobalObjectReads = 0;
  try {
    objectConstructor.freeze = <T>(value: T): Readonly<T> => { executions[0] += 1; return value; };
    objectConstructor.isFrozen = () => { executions[1] += 1; return false; };
    WeakSet.prototype.has = function () { executions[2] += 1; return false; };
    WeakMap.prototype.get = function () { executions[3] += 1; return undefined; };
    Reflect.apply = () => { executions[4] += 1; throw new Error("raw bridge ambient"); };
    objectDefineProperty(globalThis, "Object", {
      configurable: true,
      get() { ambientGlobalObjectReads += 1; return objectConstructor; },
    });
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1(
      connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1),
    connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1(
      connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1),
    connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1);
  } finally {
    objectConstructor.freeze = originalFreeze;
    objectConstructor.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Reflect.apply = originalReflectApply;
    if (originalGlobalObject) objectDefineProperty(globalThis, "Object", originalGlobalObject);
  }
  assert.deepEqual(executions, new Array(5).fill(0));
  assert.equal(ambientGlobalObjectReads, 0);
});

test("CR13A-LIVE-250 publishes no retrieval callable and remains native-free and unwired", async () => {
  const allowedFunctions = new Set([
    "ConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeErrorV1",
    "assessConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeStatusV1",
  ]);
  for (const [name, value] of Object.entries(bridgeModule)) {
    if (typeof value === "function") assert.equal(allowedFunctions.has(name), true, name);
  }

  const modulePath = resolve(root, "src/connection-registry/v1",
    "private-loopback-native-factory-retrieval-bridge-contract.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /node:net|createServer|quarantinedNativeFactoriesV1|createQuarantinedNativeIssuerV1/);
  assert.doesNotMatch(source, /private-loopback-native-retained-resource-issuer-implementation/);
  assert.doesNotMatch(source, /private-loopback-native-issuer-composition-implementation/);

  const consumers: string[] = [];
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    const text = await readFile(file, "utf8");
    if (text.includes("private-loopback-native-factory-retrieval-bridge-contract")) consumers.push(file);
  }
  assert.deepEqual(consumers.sort(), [
    resolve(root, "src/connection-registry/v1/index.ts"),
    resolve(root, "src/connection-registry/v1/private-loopback-native-retained-resource-issuer-implementation.ts"),
  ].sort());

  const contract = connectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1;
  for (const key of [
    "callerImplementationAccepted", "callerCompositionAccepted", "callerPermitAccepted", "callerFactoryAccepted",
    "bridgeImplemented", "live220Modified", "live240Modified", "realFactoryReachable", "realFactoryRetrieved",
    "realFactoryInvoked", "nativeEffectReachable", "runtimeWired", "clearsCustodyOrHandoffBlocker",
    "candidateEligible", "activationEligible", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority",
  ] as const) assert.equal(contract[key], false, key);
});
