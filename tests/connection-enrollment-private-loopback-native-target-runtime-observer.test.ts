import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as observerModule from
  "../src/connection-registry/v1/private-loopback-native-target-runtime-observer-implementation";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_CAPTURED_OPERATIONS_V1,
  ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1,
  connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1,
  connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1,
  parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1,
} from "../src/connection-registry/v1/private-loopback-native-target-runtime-observer-implementation";

const root = resolve(import.meta.dirname, "..");
const modulePath = resolve(root, "src/connection-registry/v1",
  "private-loopback-native-target-runtime-observer-implementation.ts");
type SafeCode = ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1
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

test("CR13A-LIVE-290 pins accepted LIVE280 and the exact minimum captured operation set", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1;
  assert.equal(implementation.live280ProductCommit, "c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6");
  assert.equal(implementation.acceptedLive280RereviewSha256,
    "bd8281cf4e0336eba7f55de2b8cde9e39e9305860a2a8287e3dcf74af52d7853");
  assert.match(implementation.implementationReference, /^native-target-runtime-observer:[a-f0-9]{24}$/);
  assert.equal(implementation.capturedOperations,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_CAPTURED_OPERATIONS_V1);
  assert.deepEqual(implementation.capturedOperations, [
    "node:os.platform", "node:os.arch", "node:os.release", "node:os.uptime", "process.version",
    "process.execPath", "process.pid", "process.ppid",
  ]);
  assert.equal(Object.isFrozen(implementation.capturedOperations), true);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1(implementation),
    implementation);
});

test("CR13A-LIVE-290 publishes honest private stored unreachable observer truth", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1;
  assert.equal(implementation.observerSourcePresent, true);
  assert.equal(implementation.observerPrivate, true);
  assert.equal(implementation.observerStoredOnce, true);
  for (const key of ["observerExported", "observerRetrievable", "observerInvoked", "observerAcceptsCallerInput",
    "rawObservationExported", "rawObservationSerialized", "rawObservationLogged", "rawObservationPersisted",
    "rawObservationDigested", "attestationImplemented", "signerImplemented", "trustedClockImplemented",
    "nonceImplemented", "replayCheckpointImplemented", "candidateBindingImplemented", "ownerAuthorizationPresent",
    "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired", "candidateEligible",
    "activationEligible", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority",
  ] as const) assert.equal(implementation[key], false, key);
  assert.equal(implementation.repositorySourceOnly, true);
});

test("CR13A-LIVE-290 keeps all observation, attestation, listener, and external totals zero", () => {
  const status = connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1(status), status);
  const actual = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  assert.equal(actual.length, 22);
  assert.deepEqual(actual, new Array(22).fill(0));
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.observerState, "stored_unreachable_uninvoked");
  assert.equal(status.observationState, "not_observed");
  assert.equal(status.attestationState, "not_created");
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.targetRuntimeBlockerCleared, false);
  assert.equal(status.runtimeWired, false);
});

test("CR13A-LIVE-290 stores one private observer and provides no lookup or invocation path", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.equal((source.match(/quarantinedNativeTargetRuntimeObserversV1/g) ?? []).length, 2);
  assert.equal((source.match(/weakMapSetV1, quarantinedNativeTargetRuntimeObserversV1/g) ?? []).length, 1);
  assert.equal((source.match(/weakMapGetV1, quarantinedNativeTargetRuntimeObserversV1/g) ?? []).length, 0);
  assert.equal((source.match(/createQuarantinedNativeTargetRuntimeObserverV1\(\)/g) ?? []).length, 2);
  assert.match(source, /function createQuarantinedNativeTargetRuntimeObserverV1\(\):/);
  assert.match(source, /const privateNativeTargetRuntimeObserverV1 = \(\):/);
  assert.doesNotMatch(source, /export (?:function|const) .*ObserverV1\s*=\s*\(\)/);
  const allowedFunctions = new Set([
    "ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1",
  ]);
  for (const [name, value] of Object.entries(observerModule)) {
    if (typeof value === "function") assert.equal(allowedFunctions.has(name), true, name);
  }
});

test("CR13A-LIVE-290 confines future native reads to the unreachable observer body", async () => {
  const source = await readFile(modulePath, "utf8");
  const start = source.indexOf("function createQuarantinedNativeTargetRuntimeObserverV1");
  const end = source.indexOf("const implementationSeedV1", start);
  assert.ok(start > 0 && end > start);
  const before = source.slice(0, start);
  const body = source.slice(start, end);
  assert.doesNotMatch(before,
    /(?:runtimeVersion|executablePath|processIdentifier|parentProcessIdentifier): process\.(?:version|execPath|pid|ppid)/);
  for (const token of ["observeOsPlatformV1", "observeOsArchitectureV1", "observeOsReleaseV1",
    "observeOsUptimeV1", "process.version", "process.execPath", "process.pid", "process.ppid"]) {
    assert.equal(body.includes(token), true, token);
  }
  assert.doesNotMatch(body, /sha256Digest|assertNoSecretMaterial|JSON\.|console\.|\.log\(|weakMapGetV1/);
  assert.doesNotMatch(body, /process\.(?:env|argv|cwd|getuid|geteuid)|homedir|hostname|networkInterfaces/);
});

test("CR13A-LIVE-290 has no safe-barrel or production consumer", async () => {
  const consumers: string[] = [];
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    const source = await readFile(file, "utf8");
    if (source.includes("private-loopback-native-target-runtime-observer-implementation")) consumers.push(file);
  }
  assert.deepEqual(consumers, []);
  const barrel = await readFile(resolve(root, "src/connection-registry/v1/index.ts"), "utf8");
  assert.doesNotMatch(barrel, /native-target-runtime-observer-implementation/);
});

test("CR13A-LIVE-290 imports no forbidden effect or identity source", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.match(source, /from "node:os"/);
  assert.doesNotMatch(source, /from "node:(?:net|fs|fs\/promises|child_process|dns|http|https|crypto|timers)"/);
  assert.doesNotMatch(source, /private-loopback-native-retained-resource-issuer-implementation/);
  assert.doesNotMatch(source, /private-loopback-physical-native-driver/);
  assert.doesNotMatch(source, /system_profiler|sysctl|uname|Keychain|ssh|fetch\(|setTimeout|setInterval/);
  assert.doesNotMatch(source, /os\.(?:hostname|homedir|userInfo|networkInterfaces)/);
  assert.doesNotMatch(source, /import\s*\(/);
});

test("CR13A-LIVE-290 exact parsers reject copies, symbols, accessors, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1({
    ...connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1,
  }), "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1({
    ...connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1(
    Symbol("observer")), "invalid_implementation");
  let executions = 0;
  const accessor = Object.defineProperty({}, "implementationVersion", {
    get() { executions += 1; throw new Error("raw observer accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw observer proxy"); },
    get() { executions += 1; throw new Error("raw observer proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1(accessor),
    "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-290 freezes records and callables and exposes fixed safe errors", () => {
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1), true);
  for (const callable of [ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1,
    parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1,
    parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1]) {
    assert.equal(Object.isFrozen(callable), true);
  }
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1.prototype), true);
  const error = new ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1("raw host value");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-290 uses captured validation intrinsics after ambient replacement", () => {
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
    Reflect.apply = () => { executions[4] += 1; throw new Error("raw observer ambient"); };
    defineProperty(globalThis, "Object", { configurable: true,
      get() { globalObjectReads += 1; return objectConstructor; } });
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1(
      connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1),
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1(
      connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1),
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1);
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
