import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_OPERATIONS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_PROPERTIES_V1,
  ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1,
  connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1,
  connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
  parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1,
  parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
} from "../src/connection-registry/v1/private-loopback-unreachable-atomic-native-observation-source";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-unreachable-atomic-native-observation-source";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
type SafeCode = ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1
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

test("CR13A-LIVE-330 binds exact accepted LIVE-320 product and review evidence", async () => {
  const implementation = connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1;
  assert.equal(implementation.live320ProductCommit, "0c906419652adceb5e771637ae269b52fd1c77cd");
  assert.equal(implementation.acceptedLive320ReviewSha256,
    "da7d247d874d543877c18215ae9e8fbbba7ba838065fe6a9d410772e776799d6");
  const report = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_320_INDEPENDENT_REVIEW.md"));
  assert.equal(createHash("sha256").update(report).digest("hex"), implementation.acceptedLive320ReviewSha256);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1(implementation),
    implementation);
});

test("CR13A-LIVE-330 fixes the exact process properties and native operation ceiling", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_PROPERTIES_V1,
    ["version", "execPath", "pid", "ppid"]);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_OPERATIONS_V1, [
    "node:process.version", "node:process.execPath", "node:process.pid", "node:process.ppid",
    "node:os.platform", "node:os.arch", "node:os.release", "node:os.uptime",
  ]);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_PROPERTIES_V1),
    true);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_OPERATIONS_V1),
    true);
});

test("CR13A-LIVE-330 reports real private source presence with no reachability or use", () => {
  const implementation = connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1;
  for (const key of ["staticProcessNamespaceCaptured", "staticOsOperationsCaptured", "atomicSourcePresent",
    "atomicSourcePrivate", "atomicSourceFrozen", "atomicSourceNoInput", "atomicSourceSynchronous",
    "atomicSourceStoredOnce", "descriptorValidationSourcePresent", "directDescriptorValueConsumptionSourcePresent",
    "repositorySourceOnly",
  ] as const) assert.equal(implementation[key], true, key);
  for (const key of ["atomicSourceExported", "atomicSourceRetrievable", "atomicSourceInvoked",
    "secondNamespaceReadPresent", "ambientGlobalProcessUsed", "callerBindingAccepted", "callerDescriptorAccepted",
    "callbackAccepted", "promiseOrAwaitPresent", "timerPresent", "automaticRetryPresent",
    "replacementBindingPresent", "nativeValueRead", "rawObservationCreated", "rawObservationExported",
    "rawObservationSerialized", "rawObservationLogged", "rawObservationPersisted", "rawObservationDigested",
    "attestationImplemented", "signerImplemented", "trustedClockImplemented", "nonceImplemented",
    "replayCheckpointImplemented", "candidateAssemblerImplemented", "ownerAuthorizationPresent",
    "physicalAttemptPerformed", "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired",
    "candidateEligible", "activationEligible", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority",
  ] as const) assert.equal(implementation[key], false, key);
});

test("CR13A-LIVE-330 publishes 34 zero actuals and eight false grants", () => {
  const status = connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1(status),
    status);
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 34);
  assert.deepEqual(actuals, new Array(34).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.sourceState, "stored_unreachable_uninvoked");
  assert.equal(status.nativeBindingState, "static_sources_captured_unread");
  assert.equal(status.externalEffectOccurred, false);
});

test("CR13A-LIVE-330 exact parsers reject copies, accessors, Symbols, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1({
    ...connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
  }), "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1({
    ...connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1(Symbol("raw")),
    "invalid_implementation");
  let executions = 0;
  const accessor = Object.defineProperty({}, "implementationVersion", {
    get() { executions += 1; throw new Error("raw native accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw native proxy"); },
    get() { executions += 1; throw new Error("raw native proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1(accessor),
    "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-330 freezes all public records, callables, arrays, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
    connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_PROPERTIES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_OPERATIONS_V1,
    ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1,
    ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
    parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1("raw path");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-330 parsers retain captured intrinsics after ambient replacement", () => {
  const objectConstructor = Object;
  const originalIsFrozen = objectConstructor.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalArraySome = Array.prototype.some;
  const originalReflectApply = Reflect.apply;
  const executions = new Array(5).fill(0);
  let parsedImplementation: unknown;
  let parsedStatus: unknown;
  try {
    objectConstructor.isFrozen = () => { executions[0] += 1; return false; };
    WeakSet.prototype.has = function () { executions[1] += 1; return false; };
    WeakMap.prototype.get = function () { executions[2] += 1; return undefined; };
    Array.prototype.some = function () { executions[3] += 1; throw new Error("raw ambient"); };
    Reflect.apply = () => { executions[4] += 1; throw new Error("raw ambient"); };
    parsedImplementation = parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1(
      connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1(
      connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1);
  } finally {
    objectConstructor.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedImplementation, connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1);
  assert.deepEqual(executions, new Array(5).fill(0));
});

test("CR13A-LIVE-330 contains one exact static native source with no historical import", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.match(source, /import \* as nativeProcessNamespaceV1 from "node:process";/);
  assert.match(source, /from "node:os";/);
  assert.doesNotMatch(source, /native-target-runtime-(?:observer|binding-validator)-implementation/);
  assert.doesNotMatch(source,
    /globalThis\.process|(?<!node:)\bprocess\.(?:version|execPath|pid|ppid|env|argv|cwd)/);
  assert.doesNotMatch(source, /import\(|from "node:(?:fs|net|http|https|dns|child_process|crypto|timers)/);
  assert.doesNotMatch(source, /createServer|\.listen\(|fetch\(|setTimeout|setInterval/);
});

test("CR13A-LIVE-330 keeps validation and direct descriptor-value consumption atomic and unreachable", async () => {
  const source = await readFile(modulePath, "utf8");
  const bodyStart = source.indexOf("function createQuarantinedAtomicNativeObservationSourceV1");
  const bodyEnd = source.indexOf("const implementationSeedV1");
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart);
  const body = source.slice(bodyStart, bodyEnd);
  for (const property of ["version", "execPath", "pid", "ppid"]) {
    assert.match(body, new RegExp(`nativeProcessNamespaceV1, "${property}"`));
  }
  assert.equal((body.match(/objectGetOwnPropertyDescriptorV1/g) ?? []).length, 4);
  assert.match(body, /runtimeVersion = versionDescriptor\.value/);
  assert.match(body, /executablePath = execPathDescriptor\.value/);
  assert.match(body, /processIdentifier = pidDescriptor\.value/);
  assert.match(body, /parentProcessIdentifier = ppidDescriptor\.value/);
  assert.doesNotMatch(body, /nativeProcessNamespaceV1\.(?:version|execPath|pid|ppid)/);
  assert.match(body, /reflectApplyV1\(observeOsPlatformV1, undefined, \[\]\)/);
  assert.match(body, /reflectApplyV1\(observeOsArchitectureV1, undefined, \[\]\)/);
  assert.match(body, /reflectApplyV1\(observeOsReleaseV1, undefined, \[\]\)/);
  assert.match(body, /reflectApplyV1\(observeOsUptimeV1, undefined, \[\]\)/);
  assert.doesNotMatch(body, /Promise|\bawait\b|setTimeout|setInterval/);
  assert.equal((source.match(/quarantinedAtomicNativeObservationSourcesV1/g) ?? []).length, 2);
  assert.doesNotMatch(source, /weakMapGetV1, quarantinedAtomicNativeObservationSourcesV1/);
  assert.doesNotMatch(source, /export (?:function|const) (?:create|retrieve|invoke).*AtomicNativeObservation/);
});

test("CR13A-LIVE-330 has no production consumer and public evidence contains no native material", async () => {
  const consumers: string[] = [];
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    if ((await readFile(file, "utf8")).includes(moduleName)) consumers.push(file);
  }
  assert.deepEqual(consumers, []);
  const serialized = JSON.stringify({
    implementation: connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
    status: connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1("raw value"),
  });
  assert.doesNotMatch(serialized,
    /executablePath|processIdentifier|parentProcessIdentifier|runtimeVersion|osRelease|uptimeSeconds|hostname|username/);
  assert.doesNotMatch(serialized, /stack|raw value|127\.0\.0\.1|localhost/);
});

test("CR13A-LIVE-330 architecture and status retain the zero-read boundary", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_330_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_SOURCE_CONSOLIDATION.md"), "utf8");
  const plan = await readFile(resolve(root, "docs/CR3_BUILD_PLAN.md"), "utf8");
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  for (const text of [architecture, plan, status]) {
    assert.match(text, /CR13A-LIVE-330/);
    assert.match(text, /unreachable/i);
    assert.match(text, /no lookup|no native reads|zero native reads|no descriptor/i);
  }
});
