import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as validatorModule from
  "../src/connection-registry/v1/private-loopback-native-target-runtime-binding-validator-implementation";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_PROPERTIES_V1,
  ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1,
  connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1,
  connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1,
  parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1,
} from "../src/connection-registry/v1/private-loopback-native-target-runtime-binding-validator-implementation";

const root = resolve(import.meta.dirname, "..");
const modulePath = resolve(root, "src/connection-registry/v1",
  "private-loopback-native-target-runtime-binding-validator-implementation.ts");
type SafeCode = ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1
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

test("CR13A-LIVE-310 pins accepted LIVE300 and exact static process property scope", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1;
  assert.equal(implementation.live300ProductCommit, "aca7b98405fd12163b74fbc949a6a671d69fe310");
  assert.equal(implementation.acceptedLive300ReviewSha256,
    "86721e47c4c3c743aee97d5c577a1701242f799fdf6063c3dfbcfd3997d1758e");
  assert.match(implementation.implementationReference, /^native-target-runtime-binding-validator:[a-f0-9]{24}$/);
  assert.equal(implementation.validatedProperties,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_PROPERTIES_V1);
  assert.deepEqual(implementation.validatedProperties, [
    "node:process.version", "node:process.execPath", "node:process.pid", "node:process.ppid",
  ]);
  assert.equal(Object.isFrozen(implementation.validatedProperties), true);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1(
    implementation), implementation);
});

test("CR13A-LIVE-310 publishes honest private stored unreachable validator truth", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1;
  assert.equal(implementation.staticNodeProcessNamespaceImported, true);
  assert.equal(implementation.validatorSourcePresent, true);
  assert.equal(implementation.validatorPrivate, true);
  assert.equal(implementation.validatorStoredOnce, true);
  assert.equal(implementation.repositorySourceOnly, true);
  for (const key of ["ambientGlobalProcessUsed", "callerBindingAccepted", "validatorExported",
    "validatorRetrievable", "validatorInvoked", "validatorAcceptsCallerInput", "descriptorInspectionPerformed",
    "processValueRead", "observerImported", "observerComposed", "rawObservationCreated",
    "attestationImplemented", "replayCheckpointImplemented", "candidateAssemblerImplemented",
    "ownerAuthorizationPresent", "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired",
    "candidateEligible", "activationEligible", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority",
  ] as const) assert.equal(implementation[key], false, key);
});

test("CR13A-LIVE-310 keeps all validation, process-read, observer, and external totals zero", () => {
  const status = connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1(status), status);
  const actual = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  assert.equal(actual.length, 24);
  assert.deepEqual(actual, new Array(24).fill(0));
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.nativeBindingState, "static_namespace_captured_unread");
  assert.equal(status.validatorState, "stored_unreachable_uninvoked");
  assert.equal(status.descriptorState, "not_inspected");
  assert.equal(status.observerState, "not_composed");
  assert.equal(status.externalEffectOccurred, false);
});

test("CR13A-LIVE-310 stores one private no-input validator and exposes no retrieval path", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.equal((source.match(/quarantinedNativeTargetRuntimeBindingValidatorsV1/g) ?? []).length, 2);
  assert.equal((source.match(/weakMapSetV1, quarantinedNativeTargetRuntimeBindingValidatorsV1/g) ?? []).length, 1);
  assert.equal((source.match(/weakMapGetV1, quarantinedNativeTargetRuntimeBindingValidatorsV1/g) ?? []).length, 0);
  assert.equal((source.match(/createQuarantinedNativeTargetRuntimeBindingValidatorV1\(\)/g) ?? []).length, 2);
  assert.match(source, /function createQuarantinedNativeTargetRuntimeBindingValidatorV1\(\):/);
  assert.match(source, /const privateNativeTargetRuntimeBindingValidatorV1 = \(\):/);
  const allowedFunctions = new Set([
    "ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1",
  ]);
  for (const [name, value] of Object.entries(validatorModule)) {
    if (typeof value === "function") assert.equal(allowedFunctions.has(name), true, name);
  }
});

test("CR13A-LIVE-310 confines descriptor inspection and process-property names to the unreachable body", async () => {
  const source = await readFile(modulePath, "utf8");
  const start = source.indexOf("function createQuarantinedNativeTargetRuntimeBindingValidatorV1");
  const end = source.indexOf("const implementationSeedV1", start);
  assert.ok(start > 0 && end > start);
  const before = source.slice(0, start);
  const body = source.slice(start, end);
  assert.doesNotMatch(before, /objectGetOwnPropertyDescriptorV1, objectConstructorV1/);
  for (const token of ["objectGetOwnPropertyDescriptorV1", "nativeProcessNamespaceV1, \"version\"",
    "nativeProcessNamespaceV1, \"execPath\"", "nativeProcessNamespaceV1, \"pid\"",
    "nativeProcessNamespaceV1, \"ppid\""]) assert.equal(body.includes(token), true, token);
  assert.doesNotMatch(body, /globalThis|process\.|sha256Digest|assertNoSecretMaterial|JSON\.|console\.|\.log\(/);
  assert.doesNotMatch(body, /env|argv|cwd|homedir|hostname|networkInterfaces|weakMapGetV1/);
});

test("CR13A-LIVE-310 uses one static builtin import and has no observer or production consumer", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.equal((source.match(/from "node:process"/g) ?? []).length, 1);
  assert.match(source, /import \* as nativeProcessNamespaceV1 from "node:process"/);
  assert.doesNotMatch(source,
    /globalThis\.process|(?<!node:)\bprocess\.(?:version|execPath|pid|ppid|env|argv|cwd)/);
  assert.doesNotMatch(source, /native-target-runtime-observer-implementation/);
  assert.doesNotMatch(source, /from "node:(?:os|net|fs|fs\/promises|child_process|dns|http|https|crypto|timers)"/);
  assert.doesNotMatch(source, /import\s*\(|createServer|\.listen\(|\.close\(|fetch\(|setTimeout|setInterval/);
  const consumers: string[] = [];
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    const sourceText = await readFile(file, "utf8");
    if (sourceText.includes("private-loopback-native-target-runtime-binding-validator-implementation")) {
      consumers.push(file);
    }
  }
  assert.deepEqual(consumers, []);
  const barrel = await readFile(resolve(root, "src/connection-registry/v1/index.ts"), "utf8");
  assert.doesNotMatch(barrel, /native-target-runtime-binding-validator-implementation/);
});

test("CR13A-LIVE-310 exact parsers reject copies, symbols, accessors, and proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1({
    ...connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1,
  }), "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1({
    ...connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1(
    Symbol("validator")), "invalid_implementation");
  let executions = 0;
  const accessor = Object.defineProperty({}, "implementationVersion", {
    get() { executions += 1; throw new Error("raw validator accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw validator proxy"); },
    get() { executions += 1; throw new Error("raw validator proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1(
    accessor), "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-310 freezes records and callables and exposes only fixed safe errors", () => {
  assert.equal(Object.isFrozen(
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1), true);
  for (const callable of [ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1,
    parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1,
    parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1]) {
    assert.equal(Object.isFrozen(callable), true);
  }
  assert.equal(Object.isFrozen(
    ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1.prototype), true);
  const error = new ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1("raw process");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-310 parsers use captured intrinsics after ambient replacement", () => {
  const objectConstructor = Object;
  const defineProperty = objectConstructor.defineProperty;
  const originalGlobalObject = objectConstructor.getOwnPropertyDescriptor(globalThis, "Object");
  const originalFreeze = objectConstructor.freeze;
  const originalIsFrozen = objectConstructor.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalReflectApply = Reflect.apply;
  const originalArrayFilter = Array.prototype.filter;
  const originalArrayMap = Array.prototype.map;
  const originalArraySome = Array.prototype.some;
  const originalStringStartsWith = String.prototype.startsWith;
  const executions = new Array(9).fill(0);
  let globalObjectReads = 0;
  let parsedImplementation: unknown;
  let parsedStatus: unknown;
  try {
    objectConstructor.freeze = <T>(value: T): Readonly<T> => { executions[0] += 1; return value; };
    objectConstructor.isFrozen = () => { executions[1] += 1; return false; };
    WeakSet.prototype.has = function () { executions[2] += 1; return false; };
    WeakMap.prototype.get = function () { executions[3] += 1; return undefined; };
    Reflect.apply = () => { executions[4] += 1; throw new Error("raw validator ambient"); };
    Array.prototype.filter = function () { executions[5] += 1; throw new Error("raw validator ambient"); };
    Array.prototype.map = function () { executions[6] += 1; throw new Error("raw validator ambient"); };
    Array.prototype.some = function () { executions[7] += 1; throw new Error("raw validator ambient"); };
    String.prototype.startsWith = function () { executions[8] += 1; throw new Error("raw validator ambient"); };
    defineProperty(globalThis, "Object", { configurable: true,
      get() { globalObjectReads += 1; return objectConstructor; } });
    parsedImplementation = parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1(
      connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1(
      connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1);
  } finally {
    objectConstructor.freeze = originalFreeze;
    objectConstructor.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Reflect.apply = originalReflectApply;
    Array.prototype.filter = originalArrayFilter;
    Array.prototype.map = originalArrayMap;
    Array.prototype.some = originalArraySome;
    String.prototype.startsWith = originalStringStartsWith;
    if (originalGlobalObject) defineProperty(globalThis, "Object", originalGlobalObject);
  }
  assert.equal(parsedImplementation,
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1);
  assert.deepEqual(executions, new Array(9).fill(0));
  assert.equal(globalObjectReads, 0);
});

test("CR13A-LIVE-310 future validator body captures Object and Array intrinsics", async () => {
  const source = await readFile(modulePath, "utf8");
  const start = source.indexOf("function createQuarantinedNativeTargetRuntimeBindingValidatorV1");
  const end = source.indexOf("const implementationSeedV1", start);
  const body = source.slice(start, end);
  assert.match(source, /const arraySomeV1 = Array\.prototype\.some;/);
  assert.match(source, /const objectConstructorV1 = Object;/);
  assert.equal((body.match(/objectGetOwnPropertyDescriptorV1, objectConstructorV1/g) ?? []).length, 4);
  assert.match(body, /reflectApplyV1\(arraySomeV1, exactDescriptorsV1/);
  assert.match(body, /descriptor\.writable !== true/);
  assert.doesNotMatch(body, /exactDescriptorsV1\.some|objectGetOwnPropertyDescriptorV1, Object/);
});

test("CR13A-LIVE-310 status parser dispatches only captured collection and prefix methods", async () => {
  const source = await readFile(modulePath, "utf8");
  const start = source.indexOf(
    "export function parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1");
  const end = source.indexOf("objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1.prototype)",
    start);
  const body = source.slice(start, end);
  for (const capture of ["const arrayFilterV1 = Array.prototype.filter;", "const arrayMapV1 = Array.prototype.map;",
    "const arraySomeV1 = Array.prototype.some;", "const stringStartsWithV1 = String.prototype.startsWith;"]) {
    assert.equal(source.includes(capture), true, capture);
  }
  for (const callable of ["arrayFilterV1", "arrayMapV1", "arraySomeV1", "stringStartsWithV1"]) {
    assert.equal(body.includes(`reflectApplyV1(${callable}`), true, callable);
  }
  assert.doesNotMatch(body, /\.(?:filter|map|some|startsWith)\(/);
});

test("CR13A-LIVE-310 public records contain no observed runtime or host material", () => {
  const serialized = JSON.stringify({
    implementation: connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1,
    status: connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1("private value"),
  });
  assert.doesNotMatch(serialized, /executablePath|processIdentifier|runtimeVersion|observed|hostname|username|command/);
  assert.doesNotMatch(serialized, /stack|private value/);
});
