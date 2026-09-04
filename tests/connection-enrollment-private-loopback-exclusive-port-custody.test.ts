import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as custodyModule from "../src/connection-registry/v1/private-loopback-exclusive-port-custody";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_CONTRACT_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_RESULT_V1,
  ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyErrorV1,
  connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1,
  connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1,
  parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1,
  parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");

function expectCode(run: () => unknown, code: "invalid_contract" | "invalid_result" | "integrity_failed"): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyErrorV1
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

test("CR13A-LIVE-160 freezes continuous same-resource custody policy", () => {
  const contract = connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1;
  assert.equal(contract.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_CONTRACT_V1);
  assert.match(contract.policyReference, /^exclusive-port-policy:[a-f0-9]{24}$/);
  assert.equal(contract.live150ProductCommit, "f089f896073fcc5aab24616a17fac592eba5146b");
  assert.equal(contract.acceptedLive150ReviewSha256,
    "e7047c506fad1f969563d3bb1ae31df28083761b2470bc322a91c4aa733abd67");
  assert.equal(contract.resourceClass, "retained_ipv4_loopback_tcp_listener");
  assert.equal(contract.exclusivityBasis, "same_native_resource_continuously_held");
  assert.equal(contract.selectionMode, "operating_system_selected_private_port");
  assert.equal(contract.maximumFuturePreHandoffCustodyLifetimeSeconds, 30);
  assert.equal(contract.maximumFutureHandoffs, 1);
  assert.equal(contract.retryRebindReopenAllowed, false);
  assert.equal(contract.sameNativeResourceTransferRequired, true);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1(contract), contract);
});

test("CR13A-LIVE-160 freezes thirteen proofs and records the accepted driver gap", () => {
  const contract = connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1;
  assert.equal(contract.requiredPrivateProofs,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1);
  assert.equal(contract.requiredPrivateProofs.length, 13);
  assert.equal(Object.isFrozen(contract.requiredPrivateProofs), true);
  assert.equal(contract.acceptedPhysicalDriverSupportsReservationHandoff, false);
  assert.equal(contract.driverReservationHandoffGapPresent, true);
  assert.equal(contract.realCustodyProviderImplemented, false);
  assert.equal(contract.realHandoffCapabilityImplemented, false);
  assert.equal(contract.clearsExclusivePortCustodyBlocker, false);
});

test("CR13A-LIVE-160 fake retains the blocker and creates no custody fact or authority", () => {
  const result = connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1;
  assert.equal(result.resultVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_RESULT_V1);
  assert.match(result.resultReference, /^exclusive-port-fake:[a-f0-9]{24}$/);
  assert.equal(result.evidenceClass, "repository_fake");
  assert.equal(parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1(result), result);
  assert.equal(result.driverReservationHandoffGapPresent, true);
  assert.equal(result.acceptedPhysicalDriverSupportsReservationHandoff, false);
  assert.equal(result.exclusivePortCustodyMissing, true);
  const falseClaims = [
    result.targetRuntimeAttestationProvided, result.privateLocatorBrokerProvided, result.custodyProviderPresent,
    result.operatingSystemPortSelected, result.nativeReservationCreated, result.nativeResourceRetained,
    result.exclusiveBindObserved, result.noReuseObserved, result.preEffectMarkerCommitted,
    result.independentCheckpointPresent, result.handoffCapabilityIssued, result.sameNativeResourceTransferred,
    result.independentResourceObservationPresent, result.terminalCloseObserved, result.terminalTombstoneRecorded,
    result.exclusivePortCustodyAccepted, result.clearsExclusivePortCustodyBlocker, result.activationEligible,
    result.externalEffectOccurred, result.runtimeWired, result.grantsApproval, result.grantsQualificationAuthority,
    result.grantsCandidateAuthority, result.grantsActivationAuthority, result.grantsNetworkAuthority,
    result.grantsCommandAuthority, result.grantsLeaseAuthority, result.grantsExecutionAuthority,
  ];
  assert.deepEqual(falseClaims, new Array(falseClaims.length).fill(false));
});

test("CR13A-LIVE-160 keeps every native, custody, and effect count at zero", () => {
  const result = connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1;
  assert.deepEqual([
    result.hostObservationAttempts, result.portSelectionsMade, result.portReservationsMade,
    result.nativeResourcesRetained, result.handoffCapabilitiesIssued, result.handoffCapabilitiesSpent,
    result.nativeBackendConstructions, result.listenerAttemptsMade, result.ipcListenerAttemptsMade,
    result.socketAttemptsMade, result.timerCreations, result.networkIoEventsObserved, result.protectedValuesRead,
  ], new Array(13).fill(0));
});

test("CR13A-LIVE-160 exact parsers reject substitution without behavior", () => {
  const contract = connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1;
  const result = connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1({ ...contract }),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1({ ...result }),
    "invalid_result");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw custody accessor"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1(accessor),
    "invalid_contract");
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw custody proxy"); },
    get() { executions += 1; throw new Error("raw custody proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1(proxy), "invalid_result");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1({
    ...result,
    [Symbol("hostile")]: true,
  }), "invalid_result");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-160 freezes records, collections, callables, and safe errors", () => {
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1), true);
  const callables = Object.values(custodyModule).filter((value) => typeof value === "function");
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
  const hostile = new ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyErrorV1(
    "127.0.0.1:65123 server fd=7 socket /Users/example credential owner",
  );
  assert.equal(hostile.safeCode, "integrity_failed");
  assert.equal(hostile.message, "integrity_failed");
  assert.equal(hostile.stack, undefined);
  assert.equal(executions, 0);
});

test("CR13A-LIVE-160 uses captured validation intrinsics after import", () => {
  const originals = [Object.isFrozen, WeakSet.prototype.has, WeakMap.prototype.get, Reflect.apply] as const;
  let executions = 0;
  try {
    Object.isFrozen = () => { executions += 1; return false; };
    WeakSet.prototype.has = function () { executions += 1; return false; };
    WeakMap.prototype.get = function () { executions += 1; return undefined; };
    Reflect.apply = () => { executions += 1; throw new Error("raw custody ambient"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1(
      connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1,
    ), connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1(
      connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1,
    ), connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1);
  } finally {
    Object.isFrozen = originals[0];
    WeakSet.prototype.has = originals[1];
    WeakMap.prototype.get = originals[2];
    Reflect.apply = originals[3];
  }
  assert.equal(executions, 0);
});

test("CR13A-LIVE-160 remains native-free, input-free, private, and runtime-unwired", async () => {
  const modulePath = resolve(root, "src/connection-registry/v1/private-loopback-exclusive-port-custody.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source,
    /node:net|node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|private-loopback-physical-native-driver|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|networkInterfaces|createServer|\.listen\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  assert.doesNotMatch(source,
    /\b(?:selectPort|reservePort|createReservation|issueHandoff|spendHandoff|transferListener|clearExclusivePort|connect|listen|exec|spawn)\s*\(/i);
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1,
    result: connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1,
  });
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|localhost|"(?:address|port|interface|socket|server|handle|fileDescriptor|capabilityId)"\s*:|\/Users\/|credentialMaterial|ownerIdentity/i);
  const consumers: string[] = [];
  for (const path of await sourceFiles(resolve(root, "src"))) {
    if (path === modulePath) continue;
    if (/private-loopback-exclusive-port-custody/.test(await readFile(path, "utf8"))) consumers.push(path);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
