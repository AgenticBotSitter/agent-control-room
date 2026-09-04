import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as adapterModule from
  "../src/connection-registry/v1/private-loopback-native-retained-resource-adapter";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_IMPLEMENTATION_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_STATUS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_STATES_V1,
  ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1,
  assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1,
  connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1,
  createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
type SafeCode = ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1
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

function assertZeroActualEffects(status: ReturnType<
  typeof parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1
>): void {
  assert.deepEqual([
    status.actualHostObservations, status.actualPortSelections, status.actualPortReservations,
    status.actualNativeServersReceived, status.actualNativeResourcesCreated, status.actualNativeResourcesRetained,
    status.actualHandoffCapabilitiesIssued, status.actualHandoffCapabilitiesSpent, status.actualDriverAcceptCalls,
    status.actualNativeBackendConstructions, status.actualListenerAttempts, status.actualIpcListenerAttempts,
    status.actualSocketAttempts, status.actualTimerCreations, status.actualNetworkIoEvents, status.protectedValuesRead,
  ], new Array(16).fill(0));
  assert.equal(status.runtimeWired, false);
  assert.equal(status.externalEffectOccurred, false);
}

test("CR13A-LIVE-190 pins a type-only, issuer-absent native adapter", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1;
  assert.equal(implementation.contractVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_IMPLEMENTATION_V1);
  assert.match(implementation.implementationReference, /^native-retained-resource-adapter:[a-f0-9]{24}$/);
  assert.equal(implementation.live180ProductCommit, "052afc3b4a61f1c6f1957a567f5305f3a2c5bca0");
  assert.equal(implementation.acceptedLive180ReviewSha256,
    "05c4d57ad9f247916102acdc090c071b22a9b7a9623d1984779caf41d8acfd76");
  assert.equal(implementation.nativeServerTypeContract, "node:net.Server_type_only");
  assert.equal(implementation.transferMode, "same_retained_server_atomic_one_use");
  assert.equal(implementation.typeOnlyNativeReference, true);
  assert.equal(implementation.scenarioSet,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1);
  assert.equal(implementation.maximumAccepts, 1);
  assert.equal(implementation.nativeServerIssuerPresent, false);
  assert.equal(implementation.numericPortBindCompatible, false);
  assert.equal(implementation.realNativeRetainedResourceAdapterImplemented, false);
  assert.equal(implementation.driverReservationHandoffGapCleared, false);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1(
    implementation,
  ), implementation);
});

test("CR13A-LIVE-190 accepts the exact fake server once and verifies cleanup", async () => {
  const adapter = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "accepted_then_closed",
  );
  assert.equal(adapter.status().state, "created");
  const prepare = adapter.prepare();
  assert.equal(adapter.prepare(), prepare);
  const prepared = await prepare;
  assert.equal(prepared.statusVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_STATUS_V1);
  assert.equal(prepared.state, "prepared");
  const acceptance = adapter.accept();
  assert.equal(adapter.accept(), acceptance);
  const accepted = await acceptance;
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.acceptanceOutcome, "accepted");
  assert.equal(accepted.sameServerIdentityVerifiedSimulated, true);
  assert.equal(accepted.continuousCustodyVerifiedSimulated, true);
  assert.equal(accepted.acceptanceSpentSimulated, true);
  assert.equal(accepted.driverAcceptedSimulated, true);
  assert.equal(accepted.ownershipTransitionSimulated, true);
  const close = adapter.close();
  assert.equal(adapter.close(), close);
  const closed = await close;
  assert.equal(closed.state, "closed_verified");
  assert.equal(closed.terminalCloseSimulated, true);
  assert.equal(closed.independentZeroResourceObservationSimulated, true);
  assert.deepEqual([closed.prepareCalls, closed.acceptCalls, closed.closeCalls, closed.recoverCalls], [1, 1, 1, 0]);
  assert.equal(closed.transitionCount, 3);
  assert.equal(closed.replacementServerCreatedSimulated, false);
  assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1(adapter, closed);
  assertZeroActualEffects(closed);
});

test("CR13A-LIVE-190 separates rejection before acceptance from ambiguity after it", async () => {
  const rejectedAdapter = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "rejected_before_acceptance",
  );
  await rejectedAdapter.prepare();
  const rejected = await rejectedAdapter.accept();
  assert.equal(rejected.state, "failed_before_acceptance");
  assert.equal(rejected.acceptanceOutcome, "failed_before_acceptance");
  assert.equal(rejected.acceptanceSpentSimulated, true);
  assert.equal(rejected.driverAcceptedSimulated, false);
  assert.equal(rejected.ownershipTransitionSimulated, false);
  const rejectedClosed = await rejectedAdapter.close();
  assert.equal(rejectedClosed.state, "closed_verified");
  assertZeroActualEffects(rejectedClosed);

  const ambiguousAdapter = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "ambiguous_after_acceptance",
  );
  await ambiguousAdapter.prepare();
  const ambiguous = await ambiguousAdapter.accept();
  assert.equal(ambiguous.state, "ambiguous_after_acceptance");
  assert.equal(ambiguous.acceptanceOutcome, "ambiguous_after_acceptance");
  assert.equal(ambiguous.acceptanceSpentSimulated, true);
  assert.equal(ambiguous.driverAcceptedSimulated, false);
  assert.equal(ambiguous.ownershipTransitionSimulated, false);
  const ambiguousClosed = await ambiguousAdapter.close();
  assert.equal(ambiguousClosed.state, "closed_verified");
  assertZeroActualEffects(ambiguousClosed);
});

test("CR13A-LIVE-190 makes cleanup failure terminal until one no-reopen recovery", async () => {
  const adapter = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "cleanup_failed_then_recovered",
  );
  await adapter.prepare();
  await adapter.accept();
  const failed = await adapter.close();
  assert.equal(failed.state, "cleanup_failed");
  assert.equal(failed.cleanupOutcome, "cleanup_failed");
  assert.equal(failed.terminalCloseSimulated, false);
  const recovery = adapter.recover();
  assert.equal(adapter.recover(), recovery);
  const recovered = await recovery;
  assert.equal(recovered.state, "closed_verified");
  assert.equal(recovered.cleanupOutcome, "closed_verified");
  assert.equal(recovered.recoveryCheckedSimulated, true);
  assert.deepEqual([recovered.prepareCalls, recovered.acceptCalls, recovered.closeCalls, recovered.recoverCalls],
    [1, 1, 1, 1]);
  assert.equal(recovered.transitionCount, 4);
  assertZeroActualEffects(recovered);
});

test("CR13A-LIVE-190 status provenance is bound to the exact adapter", async () => {
  const first = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "accepted_then_closed",
  );
  const second = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "accepted_then_closed",
  );
  const status = await first.prepare();
  assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1(first, status);
  expectCode(() => assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1(second, status),
    "status_mismatch");
});

test("CR13A-LIVE-190 rejects invalid scenarios, receivers, and operation order safely", async () => {
  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "accepted_then_rebound",
  ), "invalid_scenario");
  const adapter = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "accepted_then_closed",
  );
  expectCode(() => adapter.accept(), "sequence_conflict");
  expectCode(() => adapter.close(), "sequence_conflict");
  expectCode(() => adapter.recover(), "recovery_not_available");
  expectCode(() => adapter.prepare.call({}), "invalid_adapter");
  await adapter.prepare();
  await adapter.accept();
  await adapter.close();
  expectCode(() => adapter.recover(), "recovery_not_available");
});

test("CR13A-LIVE-190 exact parsers reject copies, accessors, symbols, and proxies without execution", async () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1;
  const adapter = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "accepted_then_closed",
  );
  const status = await adapter.prepare();
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1({
    ...implementation,
  }), "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1({ ...status }),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1({
    ...status,
    [Symbol("hostile")]: true,
  }), "invalid_status");
  let executions = 0;
  const accessor = Object.defineProperty({}, "statusVersion", {
    get() { executions += 1; throw new Error("raw native adapter accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw native adapter proxy"); },
    get() { executions += 1; throw new Error("raw native adapter proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1(accessor),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1(proxy),
    "invalid_implementation");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-190 freezes adapters, methods, records, callables, and safe errors", async () => {
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1),
    true);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_STATES_V1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1), true);
  const adapter = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "accepted_then_closed",
  );
  assert.equal(Object.isFrozen(adapter), true);
  for (const method of Object.values(adapter)) {
    assert.equal(Object.isFrozen(method), true);
    assert.equal(Object.isExtensible(method), false);
  }
  assert.equal(Object.isFrozen(await adapter.prepare()), true);
  const callables = Object.values(adapterModule).filter((value) => typeof value === "function");
  assert.equal(callables.length, 5);
  for (const callable of callables) assert.equal(Object.isFrozen(callable), true);
  const hostile = new ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1(
    "127.0.0.1:65123 server fd=7 /Users/example credential owner",
  );
  assert.equal(hostile.safeCode, "integrity_failed");
  assert.equal(hostile.message, "integrity_failed");
  assert.equal(hostile.stack, undefined);
  assert.equal(Object.isFrozen(hostile), true);
});

test("CR13A-LIVE-190 uses captured validation and settlement intrinsics", async () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1;
  const adapter = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "accepted_then_closed",
  );
  const originals = [Object.isFrozen, WeakSet.prototype.has, WeakMap.prototype.get, Reflect.apply,
    Promise.resolve, Promise.prototype.then] as const;
  let executions = 0;
  try {
    Object.isFrozen = () => { executions += 1; return false; };
    WeakSet.prototype.has = function () { executions += 1; return false; };
    WeakMap.prototype.get = function () { executions += 1; return undefined; };
    Reflect.apply = () => { executions += 1; throw new Error("raw native adapter ambient"); };
    Promise.resolve = () => { executions += 1; throw new Error("raw native adapter promise"); };
    Promise.prototype.then = function () { executions += 1; throw new Error("raw native adapter then"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1(
      implementation,
    ), implementation);
    const prepared = await adapter.prepare();
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1(prepared), prepared);
    await adapter.accept();
    await adapter.close();
  } finally {
    Object.isFrozen = originals[0];
    WeakSet.prototype.has = originals[1];
    WeakMap.prototype.get = originals[2];
    Reflect.apply = originals[3];
    Promise.resolve = originals[4];
    Promise.prototype.then = originals[5];
  }
  assert.equal(executions, 0);
});

test("CR13A-LIVE-190 exports no server, locator, handle, capability, or authority", async () => {
  const adapter = createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
    "accepted_then_closed",
  );
  await adapter.prepare();
  await adapter.accept();
  const status = await adapter.close();
  assert.deepEqual(Object.keys(adapter).sort(), ["accept", "close", "prepare", "recover", "status"]);
  assert.deepEqual(Object.keys(status).filter((key) =>
    /^(?:address|port|interface|socket|server|listener|resource|handle|fileDescriptor|capability|locator)$/i.test(key)), []);
  assert.deepEqual([
    status.grantsApproval, status.grantsQualificationAuthority, status.grantsCandidateAuthority,
    status.grantsActivationAuthority, status.grantsNetworkAuthority, status.grantsCommandAuthority,
    status.grantsLeaseAuthority, status.grantsExecutionAuthority,
  ], new Array(8).fill(false));
  const serialized = JSON.stringify({
    implementation: connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1,
    status,
  });
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|localhost|"(?:address|port|interface|socket|server|listener|resource|handle|fileDescriptor|capability|locator)"\s*:|\/Users\/|credentialMaterial|ownerIdentity/i);
});

test("CR13A-LIVE-190 type-only native reference erases at runtime and remains unwired", async () => {
  const modulePath = resolve(root,
    "src/connection-registry/v1/private-loopback-native-retained-resource-adapter.ts");
  const source = await readFile(modulePath, "utf8");
  assert.match(source, /^import type \{ Server \} from "node:net";/);
  assert.doesNotMatch(source, /^import(?!\s+type).*from\s+"node:net"/m);
  assert.doesNotMatch(source,
    /private-loopback-physical-native-driver|node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|networkInterfaces|createServer|\.listen\s*\(|\.close\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  assert.doesNotMatch(source,
    /\b(?:selectPort|reservePort|createReservation|issueHandoff|spendHandoff|transferListener|clearExclusivePort|connect|listen|exec|spawn)\s*\(/i);
  const consumers: string[] = [];
  for (const path of await sourceFiles(resolve(root, "src"))) {
    if (path === modulePath) continue;
    if (/private-loopback-native-retained-resource-adapter/.test(await readFile(path, "utf8"))) consumers.push(path);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
