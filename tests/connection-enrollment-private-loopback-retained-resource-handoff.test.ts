import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as handoffModule from "../src/connection-registry/v1/private-loopback-retained-resource-handoff";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_CONTRACT_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_RESULT_V1,
  ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffErrorV1,
  connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1,
  connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1,
  parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1,
  parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");

function expectCode(run: () => unknown, code: "invalid_contract" | "invalid_result" | "integrity_failed"): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffErrorV1
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

test("CR13A-LIVE-170 freezes atomic same-resource transfer policy", () => {
  const contract = connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1;
  assert.equal(contract.contractVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_CONTRACT_V1);
  assert.match(contract.policyReference, /^retained-resource-handoff-policy:[a-f0-9]{24}$/);
  assert.equal(contract.live160ProductCommit, "97d46c74e413d21c1f81c9704b9eb0b66447be5c");
  assert.equal(contract.acceptedLive160ReviewSha256,
    "0a0837acbd36ba9292e8b3f37b57d4900290aa03c54c3c13c73413aebd8345a6");
  assert.equal(contract.transferMode, "same_retained_resource_atomic_one_use");
  assert.equal(contract.handoffSurface, "module_private_non_serializable");
  assert.equal(contract.locatorExposure, "none");
  assert.equal(contract.maximumFutureHandoffs, 1);
  assert.equal(contract.driverMayBindNewResource, false);
  assert.equal(contract.custodyMayCloseBeforeDriverAcceptance, false);
  assert.equal(contract.retryRebindReopenAllowed, false);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1(contract), contract);
});

test("CR13A-LIVE-170 freezes twelve proofs and retains the physical-driver gap", () => {
  const contract = connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1;
  assert.equal(contract.requiredPrivateProofs,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1);
  assert.equal(contract.requiredPrivateProofs.length, 12);
  assert.equal(Object.isFrozen(contract.requiredPrivateProofs), true);
  assert.equal(contract.acceptedPhysicalDriverHandoffPortImplemented, false);
  assert.equal(contract.driverReservationHandoffGapPresent, true);
  assert.equal(contract.realHandoffPortImplemented, false);
  assert.equal(contract.realHandoffCapabilityImplemented, false);
  assert.equal(contract.clearsExclusivePortCustodyBlocker, false);
});

test("CR13A-LIVE-170 fake provides no transfer, custody fact, or authority", () => {
  const result = connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1;
  assert.equal(result.resultVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_RESULT_V1);
  assert.match(result.resultReference, /^retained-resource-handoff-fake:[a-f0-9]{24}$/);
  assert.equal(result.evidenceClass, "repository_fake");
  assert.equal(parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1(result), result);
  assert.equal(result.driverReservationHandoffGapPresent, true);
  assert.equal(result.exclusivePortCustodyMissing, true);
  const falseClaims = [
    result.acceptedPhysicalDriverHandoffPortImplemented, result.exclusivePortCustodyProvided,
    result.handoffPortPresent, result.privateHandoffAccepted, result.sameResourceIdentityVerified,
    result.continuousCustodyVerified, result.oneUseStateVerified, result.atomicOwnershipTransitionObserved,
    result.driverAcceptedRetainedResource, result.driverCreatedReplacementResource, result.locatorExposed,
    result.preAcceptanceCloseObserved, result.retryRebindReopenObserved, result.terminalCloseObserved,
    result.independentZeroResourceObservationPresent, result.durableTombstoneRecorded,
    result.exclusivePortCustodyAccepted, result.clearsExclusivePortCustodyBlocker, result.activationEligible,
    result.externalEffectOccurred, result.runtimeWired, result.grantsApproval, result.grantsQualificationAuthority,
    result.grantsCandidateAuthority, result.grantsActivationAuthority, result.grantsNetworkAuthority,
    result.grantsCommandAuthority, result.grantsLeaseAuthority, result.grantsExecutionAuthority,
  ];
  assert.deepEqual(falseClaims, new Array(falseClaims.length).fill(false));
});

test("CR13A-LIVE-170 keeps every handoff, native, and effect count at zero", () => {
  const result = connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1;
  assert.deepEqual([
    result.hostObservationAttempts, result.portSelectionsMade, result.portReservationsMade,
    result.nativeResourcesCreated, result.nativeResourcesRetained, result.handoffCapabilitiesIssued,
    result.handoffCapabilitiesSpent, result.driverHandoffCalls, result.nativeBackendConstructions,
    result.listenerAttemptsMade, result.ipcListenerAttemptsMade, result.socketAttemptsMade,
    result.timerCreations, result.networkIoEventsObserved, result.protectedValuesRead,
  ], new Array(15).fill(0));
});

test("CR13A-LIVE-170 exact parsers reject substitution without behavior", () => {
  const contract = connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1;
  const result = connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1({ ...contract }),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1({ ...result }),
    "invalid_result");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw handoff accessor"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1(accessor),
    "invalid_contract");
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw handoff proxy"); },
    get() { executions += 1; throw new Error("raw handoff proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1(proxy), "invalid_result");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1({
    ...result,
    [Symbol("hostile")]: true,
  }), "invalid_result");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-170 freezes records, collections, callables, and safe errors", () => {
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1), true);
  const callables = Object.values(handoffModule).filter((value) => typeof value === "function");
  assert.equal(callables.length, 3);
  let executions = 0;
  for (const callable of callables) {
    assert.equal(Object.isFrozen(callable), true);
    assert.equal(Object.isExtensible(callable), false);
    for (const property of ["call", "apply", "bind"] as const) {
      assert.throws(() => Object.defineProperty(callable, property, {
        value: () => { executions += 1; },
      }), TypeError);
    }
  }
  const hostile = new ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffErrorV1(
    "127.0.0.1:65123 server fd=7 socket /Users/example credential owner",
  );
  assert.equal(hostile.safeCode, "integrity_failed");
  assert.equal(hostile.message, "integrity_failed");
  assert.equal(hostile.stack, undefined);
  assert.equal(executions, 0);
});

test("CR13A-LIVE-170 uses captured validation intrinsics after import", () => {
  const originals = [Object.isFrozen, WeakSet.prototype.has, WeakMap.prototype.get, Reflect.apply] as const;
  let executions = 0;
  try {
    Object.isFrozen = () => { executions += 1; return false; };
    WeakSet.prototype.has = function () { executions += 1; return false; };
    WeakMap.prototype.get = function () { executions += 1; return undefined; };
    Reflect.apply = () => { executions += 1; throw new Error("raw handoff ambient"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1(
      connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1,
    ), connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1(
      connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1,
    ), connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1);
  } finally {
    Object.isFrozen = originals[0];
    WeakSet.prototype.has = originals[1];
    WeakMap.prototype.get = originals[2];
    Reflect.apply = originals[3];
  }
  assert.equal(executions, 0);
});

test("CR13A-LIVE-170 remains native-free, input-free, private, and runtime-unwired", async () => {
  const modulePath = resolve(root, "src/connection-registry/v1/private-loopback-retained-resource-handoff.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source,
    /node:net|node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|private-loopback-physical-native-driver|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|networkInterfaces|createServer|\.listen\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  assert.doesNotMatch(source,
    /\b(?:selectPort|reservePort|createReservation|issueHandoff|spendHandoff|transferListener|acceptResource|clearExclusivePort|connect|listen|exec|spawn)\s*\(/i);
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1,
    result: connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1,
  });
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|localhost|"(?:address|port|interface|socket|server|handle|fileDescriptor|capabilityId)"\s*:|\/Users\/|credentialMaterial|ownerIdentity/i);
  const consumers: string[] = [];
  for (const path of await sourceFiles(resolve(root, "src"))) {
    if (path === modulePath) continue;
    if (/private-loopback-retained-resource-handoff/.test(await readFile(path, "utf8"))) consumers.push(path);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
