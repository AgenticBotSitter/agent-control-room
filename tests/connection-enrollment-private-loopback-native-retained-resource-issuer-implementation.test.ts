import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as nativeIssuerModule from
  "../src/connection-registry/v1/private-loopback-native-retained-resource-issuer-implementation";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CAPTURED_PRIMITIVES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_IMPLEMENTATION_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_STATUS_V1,
  ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1,
  connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1,
  connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1,
  createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1,
} from "../src/connection-registry/v1/private-loopback-native-retained-resource-issuer-implementation";

const root = resolve(import.meta.dirname, "..");
const implementationPath = resolve(root,
  "src/connection-registry/v1/private-loopback-native-retained-resource-issuer-implementation.ts");
type SafeCode = ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1
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

function assertZeroEffects(status: typeof connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1):
void {
  assert.deepEqual([
    status.actualHostObservations, status.actualPortSelections, status.actualPortReservations,
    status.actualNativeBackendConstructions, status.actualNativeResourcesCreated,
    status.actualNativeResourcesRetained, status.actualListenerAttempts, status.actualCloseAttempts,
    status.actualHandoffCapabilitiesIssued, status.actualHandoffCapabilitiesSpent, status.actualDriverAcceptCalls,
    status.actualPersistenceWrites, status.actualTimerCreations, status.actualNetworkIoEvents, status.protectedValuesRead,
  ], new Array(15).fill(0));
  assert.equal(status.externalEffectOccurred, false);
}

test("CR13A-LIVE-220 pins the accepted LIVE-210 product and review", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1;
  assert.equal(implementation.implementationVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_IMPLEMENTATION_V1);
  assert.match(implementation.implementationReference, /^native-retained-resource-issuer-native:[a-f0-9]{24}$/);
  assert.equal(implementation.live210ProductCommit, "c4cac41561214117161c9764604f5dc06ecd63b6");
  assert.equal(implementation.acceptedLive210ReviewSha256,
    "c25e22dfa2c8601b23547a8a6f32b68d78da23458a696cd9461678ce084ec2c7");
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1(
    implementation,
  ), implementation);
});

test("CR13A-LIVE-220 captures one exact native primitive set behind literal loopback policy", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1;
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CAPTURED_PRIMITIVES_V1, [
    "node:net.createServer",
    "node:net.Server.prototype.listen",
    "node:net.Server.prototype.close",
    "node:net.Server.prototype.once",
    "node:net.Server.prototype.removeListener",
  ]);
  assert.equal(implementation.capturedPrimitiveSet,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CAPTURED_PRIMITIVES_V1);
  assert.equal(implementation.serverModule, "node:net");
  assert.equal(implementation.bindHostPolicy, "literal_ipv4_loopback_only");
  assert.equal(implementation.portSelectionPolicy, "kernel_assigned_private_unobserved");
  assert.deepEqual([implementation.maximumNativeServerConstructions, implementation.maximumListenerAttempts,
    implementation.maximumCloses], [1, 1, 1]);
  assert.equal(Object.isFrozen(implementation.capturedPrimitiveSet), true);
});

test("CR13A-LIVE-220 exposes only negative non-execution status", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1;
  const status = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1;
  assert.equal(status.statusVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_STATUS_V1);
  assert.equal(status.implementationReference, implementation.implementationReference);
  assert.equal(status.implementationDigest, implementation.implementationDigest);
  assert.equal(status.evidenceClass, "repository_static_non_execution");
  assert.deepEqual([status.nativeAttemptState, status.locatorState, status.retainedResourceState, status.handoffState,
    status.cleanupState], ["not_attempted", "not_selected_or_observed", "not_created", "not_issued_or_spent",
    "not_required"]);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1(status), status);
  assertZeroEffects(status);
});

test("CR13A-LIVE-220 keeps construction fail-closed before every native call", () => {
  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeV1(),
    "native_issuer_unavailable");
  const status = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1;
  assert.equal(status.nativeAttemptState, "not_attempted");
  assertZeroEffects(status);
});

test("CR13A-LIVE-220 ignores hostile caller values without behavior", () => {
  let executions = 0;
  const hostile = new Proxy({}, {
    get() { executions += 1; throw new Error("raw native input"); },
    ownKeys() { executions += 1; throw new Error("raw native input"); },
    getPrototypeOf() { executions += 1; throw new Error("raw native input"); },
  });
  expectCode(() => (createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeV1 as
    (...args: unknown[]) => never)(hostile), "native_issuer_unavailable");
  assert.equal(executions, 0);
  assertZeroEffects(connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1);
});

test("CR13A-LIVE-220 exact parsers reject copies, accessors, symbols, and proxies without execution", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1;
  const status = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1({
    ...implementation,
  }), "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1({ ...status }),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1({
    ...status,
    [Symbol("hostile")]: true,
  }), "invalid_status");
  let executions = 0;
  const accessor = Object.defineProperty({}, "statusVersion", {
    get() { executions += 1; throw new Error("raw native status"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw native status"); },
    get() { executions += 1; throw new Error("raw native status"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1(accessor),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1(proxy),
    "invalid_implementation");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-220 freezes every public surface and sanitizes errors", () => {
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1),
    true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1), true);
  const callables = Object.values(nativeIssuerModule).filter((value) => typeof value === "function");
  assert.equal(callables.length, 4);
  for (const callable of callables) assert.equal(Object.isFrozen(callable), true);
  const hostile = new ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1(
    "127.0.0.1:65123 server fd=7 /Users/example credential owner",
  );
  assert.equal(hostile.safeCode, "integrity_failed");
  assert.equal(hostile.message, "integrity_failed");
  assert.equal(hostile.stack, undefined);
  assert.equal(Object.isFrozen(hostile), true);
});

test("CR13A-LIVE-220 uses captured parser intrinsics", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1;
  const status = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1;
  const originals = [Object.isFrozen, WeakSet.prototype.has, WeakMap.prototype.get, Reflect.apply] as const;
  let executions = 0;
  try {
    Object.isFrozen = () => { executions += 1; return false; };
    WeakSet.prototype.has = function () { executions += 1; return false; };
    WeakMap.prototype.get = function () { executions += 1; return undefined; };
    Reflect.apply = () => { executions += 1; throw new Error("raw native ambient"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1(
      implementation,
    ), implementation);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1(status), status);
    expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeV1(),
      "native_issuer_unavailable");
  } finally {
    Object.isFrozen = originals[0];
    WeakSet.prototype.has = originals[1];
    WeakMap.prototype.get = originals[2];
    Reflect.apply = originals[3];
  }
  assert.equal(executions, 0);
});

test("CR13A-LIVE-220 exports no server, locator, resource, handle, or authority", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1;
  const status = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1;
  for (const record of [implementation, status]) {
    assert.deepEqual(Object.keys(record).filter((key) =>
      /^(?:address|port|interface|socket|server|listener|resource|handle|fileDescriptor|capability|locator)$/i.test(key)),
    []);
  }
  assert.deepEqual([
    status.grantsApproval, status.grantsQualificationAuthority, status.grantsCandidateAuthority,
    status.grantsActivationAuthority, status.grantsNetworkAuthority, status.grantsCommandAuthority,
    status.grantsLeaseAuthority, status.grantsExecutionAuthority,
  ], new Array(8).fill(false));
  assert.doesNotMatch(JSON.stringify({ implementation, status }),
    /127\.0\.0\.1|localhost|"(?:address|port|interface|socket|server|listener|resource|handle|fileDescriptor|capability|locator)"\s*:|\/Users\/|credentialMaterial|ownerIdentity/i);
});

test("CR13A-LIVE-220 contains the native factory only in private quarantine", async () => {
  const source = await readFile(implementationPath, "utf8");
  assert.match(source, /from "node:net"/);
  assert.match(source, /createServer as createNodeNetServerV1/);
  assert.match(source, /const createServerV1 = createNodeNetServerV1/);
  assert.match(source, /const serverListenV1 = NodeNetServerV1\.prototype\.listen/);
  assert.match(source, /const serverCloseV1 = NodeNetServerV1\.prototype\.close/);
  assert.match(source, /const serverOnceV1 = NodeNetServerV1\.prototype\.once/);
  assert.match(source, /const serverRemoveListenerV1 = NodeNetServerV1\.prototype\.removeListener/);
  assert.match(source, /const literalIpv4LoopbackV1 = "127\.0\.0\.1"/);
  assert.match(source, /const quarantinedNativeFactoriesV1 = new WeakMap/);
  assert.match(source, /weakMapSetV1, quarantinedNativeFactoriesV1/);
  assert.doesNotMatch(source, /weakMapGetV1, quarantinedNativeFactoriesV1/);
  const publicConstruction = source.slice(source.indexOf(
    "export function createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeV1",
  ));
  assert.match(publicConstruction, /failV1\("native_issuer_unavailable"\)/);
  assert.doesNotMatch(publicConstruction,
    /createQuarantinedNativeIssuerV1|createServerV1|serverListenV1|serverCloseV1|quarantinedNativeFactoriesV1/);
});

test("CR13A-LIVE-220 native code has fixed inputs, one attempt, one close, and no retry", async () => {
  const source = await readFile(implementationPath, "utf8");
  const nativeFactory = source.slice(source.indexOf("function createQuarantinedNativeIssuerV1"),
    source.indexOf("const implementationSeedV1"));
  assert.match(nativeFactory, /reflectApplyV1\(createServerV1, undefined, \[\]\)/);
  assert.match(nativeFactory, /reflectApplyV1\(serverListenV1, server, \[\{/);
  assert.match(nativeFactory, /host: literalIpv4LoopbackV1/);
  assert.match(nativeFactory, /port: 0/);
  assert.match(nativeFactory, /exclusive: true/);
  assert.match(nativeFactory, /reflectApplyV1\(serverCloseV1, server/);
  assert.match(nativeFactory, /if \(closeConsumed\) return settledV1\("cleanup_failed"\)/);
  assert.doesNotMatch(nativeFactory,
    /setTimeout|setInterval|process\.|\.address\s*\(|networkInterfaces|retry|rebind|reopen|fetch|WebSocket|ssh2/);
  assert.equal((nativeFactory.match(/reflectApplyV1\(createServerV1/g) ?? []).length, 1);
  assert.equal((nativeFactory.match(/reflectApplyV1\(serverListenV1/g) ?? []).length, 1);
  assert.equal((nativeFactory.match(/reflectApplyV1\(serverCloseV1/g) ?? []).length, 1);
});

test("CR13A-LIVE-220 remains absent from every runtime consumer and barrel", async () => {
  const source = await readFile(implementationPath, "utf8");
  assert.doesNotMatch(source,
    /node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|postgres|pglite|sqlite|private-loopback-physical-native-driver|private-loopback-native-retained-resource-adapter|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|networkInterfaces|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  const consumers: string[] = [];
  for (const path of await sourceFiles(resolve(root, "src"))) {
    if (path === implementationPath) continue;
    if (/from\s+["'][^"']*private-loopback-native-retained-resource-issuer-implementation["']/.test(
      await readFile(path, "utf8"),
    )) {
      consumers.push(path);
    }
  }
  assert.deepEqual(consumers, []);
  const barrel = await readFile(resolve(root, "src/connection-registry/v1/index.ts"), "utf8");
  const localPilot = await readFile(resolve(root, "src/local-pilot/v1/runtime.ts"), "utf8");
  assert.doesNotMatch(barrel, /native-retained-resource-issuer-implementation/);
  assert.doesNotMatch(localPilot, /native-retained-resource-issuer-implementation|createQuarantinedNativeIssuerV1/);
  assertZeroEffects(connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1);
});
