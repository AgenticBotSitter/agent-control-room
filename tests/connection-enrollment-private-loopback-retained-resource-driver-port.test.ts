import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as driverPortModule from "../src/connection-registry/v1/private-loopback-retained-resource-driver-port";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_IMPLEMENTATION_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_STATUS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_STATES_V1,
  ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1,
  connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1,
  createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1,
  parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");

type SafeCode = ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1
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
  typeof parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1
>): void {
  assert.deepEqual([
    status.actualHostObservations, status.actualPortSelections, status.actualPortReservations,
    status.actualNativeResourcesCreated, status.actualNativeResourcesRetained,
    status.actualHandoffCapabilitiesIssued, status.actualHandoffCapabilitiesSpent,
    status.actualDriverHandoffCalls, status.actualNativeBackendConstructions, status.actualListenerAttempts,
    status.actualIpcListenerAttempts, status.actualSocketAttempts, status.actualTimerCreations,
    status.actualNetworkIoEvents, status.protectedValuesRead,
  ], new Array(15).fill(0));
  assert.equal(status.runtimeWired, false);
  assert.equal(status.externalEffectOccurred, false);
}

test("CR13A-LIVE-180 pins a fake-only one-use driver-port implementation", () => {
  const implementation = connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1;
  assert.equal(implementation.contractVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_IMPLEMENTATION_V1);
  assert.match(implementation.implementationReference, /^retained-resource-driver-port:[a-f0-9]{24}$/);
  assert.equal(implementation.live170ProductCommit, "7e76e1980541075f9a1fa45479d20f06a823ef29");
  assert.equal(implementation.acceptedLive170ReviewSha256,
    "3581dcf33774e730614346d57594738236acf0932fa581214af7931af67c1381");
  assert.equal(implementation.transferMode, "same_fake_resource_atomic_one_use");
  assert.equal(implementation.scenarioSet,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1);
  assert.equal(implementation.maximumHandoffs, 1);
  assert.equal(implementation.repositoryFakeOnly, true);
  assert.equal(implementation.realDriverPortImplemented, false);
  assert.equal(implementation.exclusivePortCustodyMissing, true);
  assert.equal(implementation.clearsExclusivePortCustodyBlocker, false);
  assert.equal(implementation.activationEligible, false);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1(
    implementation,
  ), implementation);
});

test("CR13A-LIVE-180 accepts the same fake once and verifies terminal cleanup", async () => {
  const driver = createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "accepted_then_closed",
  );
  assert.equal(driver.status().state, "created");
  const prepare = driver.prepare();
  assert.equal(driver.prepare(), prepare);
  const prepared = await prepare;
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.statusVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_STATUS_V1);
  const handoff = driver.handoff();
  assert.equal(driver.handoff(), handoff);
  const accepted = await handoff;
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.handoffOutcome, "accepted");
  assert.equal(accepted.sameResourceIdentityVerifiedSimulated, true);
  assert.equal(accepted.continuousCustodyVerifiedSimulated, true);
  assert.equal(accepted.handoffSpentSimulated, true);
  assert.equal(accepted.driverAcceptedSimulated, true);
  const close = driver.close();
  assert.equal(driver.close(), close);
  const closed = await close;
  assert.equal(closed.state, "closed_verified");
  assert.equal(closed.cleanupOutcome, "closed_verified");
  assert.equal(closed.terminalCloseSimulated, true);
  assert.equal(closed.independentZeroResourceObservationSimulated, true);
  assert.deepEqual([closed.prepareCalls, closed.handoffCalls, closed.closeCalls, closed.recoverCalls], [1, 1, 1, 0]);
  assert.equal(closed.transitionCount, 3);
  assert.equal(closed.replacementResourceCreatedSimulated, false);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1(closed), closed);
  assertZeroActualEffects(closed);
});

test("CR13A-LIVE-180 separates pre-accept rejection from post-accept ambiguity", async () => {
  const rejectedDriver = createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "rejected_before_acceptance",
  );
  await rejectedDriver.prepare();
  const rejected = await rejectedDriver.handoff();
  assert.equal(rejected.state, "failed_before_acceptance");
  assert.equal(rejected.handoffOutcome, "failed_before_acceptance");
  assert.equal(rejected.handoffSpentSimulated, true);
  assert.equal(rejected.driverAcceptedSimulated, false);
  const rejectedClosed = await rejectedDriver.close();
  assert.equal(rejectedClosed.state, "closed_verified");
  assertZeroActualEffects(rejectedClosed);

  const ambiguousDriver = createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "ambiguous_after_acceptance",
  );
  await ambiguousDriver.prepare();
  const ambiguous = await ambiguousDriver.handoff();
  assert.equal(ambiguous.state, "ambiguous_after_acceptance");
  assert.equal(ambiguous.handoffOutcome, "ambiguous_after_acceptance");
  assert.equal(ambiguous.handoffSpentSimulated, true);
  assert.equal(ambiguous.driverAcceptedSimulated, false);
  const ambiguousClosed = await ambiguousDriver.close();
  assert.equal(ambiguousClosed.state, "closed_verified");
  assertZeroActualEffects(ambiguousClosed);
});

test("CR13A-LIVE-180 records cleanup failure and permits exactly one recovery", async () => {
  const driver = createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "cleanup_failed_then_recovered",
  );
  await driver.prepare();
  await driver.handoff();
  const failed = await driver.close();
  assert.equal(failed.state, "cleanup_failed");
  assert.equal(failed.cleanupOutcome, "cleanup_failed");
  assert.equal(failed.terminalCloseSimulated, false);
  const recovery = driver.recover();
  assert.equal(driver.recover(), recovery);
  const recovered = await recovery;
  assert.equal(recovered.state, "closed_verified");
  assert.equal(recovered.cleanupOutcome, "closed_verified");
  assert.equal(recovered.recoveryCheckedSimulated, true);
  assert.deepEqual([recovered.prepareCalls, recovered.handoffCalls, recovered.closeCalls, recovered.recoverCalls],
    [1, 1, 1, 1]);
  assert.equal(recovered.transitionCount, 4);
  assertZeroActualEffects(recovered);
});

test("CR13A-LIVE-180 rejects invalid scenarios, receivers, and illegal order with safe codes", async () => {
  expectCode(() => createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "accepted_then_reopened",
  ), "invalid_scenario");
  const driver = createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "accepted_then_closed",
  );
  expectCode(() => driver.handoff(), "sequence_conflict");
  expectCode(() => driver.close(), "sequence_conflict");
  expectCode(() => driver.recover(), "recovery_not_available");
  const borrowed = driver.prepare;
  expectCode(() => borrowed.call({}), "invalid_driver");
  await driver.prepare();
  await driver.handoff();
  await driver.close();
  expectCode(() => driver.recover(), "recovery_not_available");
});

test("CR13A-LIVE-180 exact parsers reject copies, accessors, symbols, and proxies without execution", async () => {
  const implementation = connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1;
  const driver = createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "accepted_then_closed",
  );
  const status = await driver.prepare();
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1({
    ...implementation,
  }), "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1({ ...status }),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1({
    ...status,
    [Symbol("hostile")]: true,
  }), "invalid_status");
  let executions = 0;
  const accessor = Object.defineProperty({}, "statusVersion", {
    get() { executions += 1; throw new Error("raw driver-port accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw driver-port proxy"); },
    get() { executions += 1; throw new Error("raw driver-port proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1(accessor),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1(proxy),
    "invalid_implementation");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-180 freezes states, scenarios, drivers, methods, records, and safe errors", async () => {
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1),
    true);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_STATES_V1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1), true);
  const driver = createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "accepted_then_closed",
  );
  assert.equal(Object.isFrozen(driver), true);
  for (const method of Object.values(driver)) {
    assert.equal(Object.isFrozen(method), true);
    assert.equal(Object.isExtensible(method), false);
  }
  assert.equal(Object.isFrozen(await driver.prepare()), true);
  const callables = Object.values(driverPortModule).filter((value) => typeof value === "function");
  assert.equal(callables.length, 4);
  for (const callable of callables) assert.equal(Object.isFrozen(callable), true);
  const hostile = new ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1(
    "127.0.0.1:65123 server fd=7 socket /Users/example credential owner",
  );
  assert.equal(hostile.safeCode, "integrity_failed");
  assert.equal(hostile.message, "integrity_failed");
  assert.equal(hostile.stack, undefined);
  assert.equal(Object.isFrozen(hostile), true);
});

test("CR13A-LIVE-180 uses captured validation and lifecycle intrinsics after import", async () => {
  const implementation = connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1;
  const driver = createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "accepted_then_closed",
  );
  const originals = [Object.isFrozen, WeakSet.prototype.has, WeakMap.prototype.get, Reflect.apply,
    Promise.resolve, Promise.prototype.then] as const;
  let executions = 0;
  try {
    Object.isFrozen = () => { executions += 1; return false; };
    WeakSet.prototype.has = function () { executions += 1; return false; };
    WeakMap.prototype.get = function () { executions += 1; return undefined; };
    Reflect.apply = () => { executions += 1; throw new Error("raw driver-port ambient"); };
    Promise.resolve = () => { executions += 1; throw new Error("raw driver-port promise"); };
    Promise.prototype.then = function () { executions += 1; throw new Error("raw driver-port then"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1(
      implementation,
    ), implementation);
    const prepared = await driver.prepare();
    assert.equal(parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1(prepared), prepared);
    await driver.handoff();
    await driver.close();
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

test("CR13A-LIVE-180 exposes no fake resource, locator, handle, or authority", async () => {
  const driver = createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
    "accepted_then_closed",
  );
  await driver.prepare();
  await driver.handoff();
  const status = await driver.close();
  assert.deepEqual(Object.keys(driver).sort(), ["close", "handoff", "prepare", "recover", "status"]);
  assert.deepEqual(Object.keys(status).filter((key) =>
    /^(?:address|port|interface|socket|server|listener|resource|handle|fileDescriptor|capability|locator)$/i.test(key)), []);
  assert.deepEqual([
    status.grantsApproval, status.grantsQualificationAuthority, status.grantsCandidateAuthority,
    status.grantsActivationAuthority, status.grantsNetworkAuthority, status.grantsCommandAuthority,
    status.grantsLeaseAuthority, status.grantsExecutionAuthority,
  ], new Array(8).fill(false));
  const serialized = JSON.stringify({
    implementation: connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1,
    status,
  });
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|localhost|"(?:address|port|interface|socket|server|listener|resource|handle|fileDescriptor|capability|locator)"\s*:|\/Users\/|credentialMaterial|ownerIdentity/i);
});

test("CR13A-LIVE-180 remains native-free, input-free, and runtime-unwired", async () => {
  const modulePath = resolve(root,
    "src/connection-registry/v1/private-loopback-retained-resource-driver-port.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source,
    /node:net|node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|private-loopback-physical-native-driver|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|networkInterfaces|createServer|\.listen\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  assert.doesNotMatch(source,
    /\b(?:selectPort|reservePort|createReservation|issueHandoff|spendHandoff|transferListener|clearExclusivePort|connect|listen|exec|spawn)\s*\(/i);
  const consumers: string[] = [];
  for (const path of await sourceFiles(resolve(root, "src"))) {
    if (path === modulePath) continue;
    if (/private-loopback-retained-resource-driver-port/.test(await readFile(path, "utf8"))) consumers.push(path);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
