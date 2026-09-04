import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as brokerModule from "../src/connection-registry/v1/private-loopback-private-locator-broker";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_CONTRACT_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RESULT_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1,
  ConnectionEnrollmentPrivateLoopbackLocatorBrokerErrorV1,
  connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1,
  connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1,
  parseConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1,
  parseConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");

function expectCode(run: () => unknown, code: "invalid_contract" | "invalid_result" | "integrity_failed"): void {
  assert.throws(run, (error: unknown) => error instanceof ConnectionEnrollmentPrivateLoopbackLocatorBrokerErrorV1
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

test("CR13A-LIVE-150 freezes private locator policy without selecting a locator", () => {
  const contract = connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1;
  assert.equal(contract.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_CONTRACT_V1);
  assert.match(contract.policyReference, /^private-locator-policy:[a-f0-9]{24}$/);
  assert.equal(contract.live140ProductCommit, "6e716bd77c26ad7f70343ddd687dff990f5db12f");
  assert.equal(contract.acceptedLive140ReviewSha256,
    "483ab05695b5cecaa6fe02ca4cc63b2e640733ac42270e2a435364c6be0ea6d8");
  assert.equal(contract.locatorClass, "private_ipv4_loopback");
  assert.equal(contract.transportClass, "private_tcp_qualification_listener");
  assert.equal(contract.publicationMode, "private_never_public_or_serialized");
  assert.equal(contract.capabilityScope, "single_target_candidate_attempt_epoch_reservation_spend");
  assert.equal(contract.maximumFutureCapabilityLifetimeSeconds, 30);
  assert.equal(contract.maximumFutureCapabilitySpends, 1);
  assert.equal(contract.automaticRetryAllowed, false);
  assert.equal(contract.terminalTombstoneRequired, true);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1(contract), contract);
});

test("CR13A-LIVE-150 freezes exact private bindings and retains both blockers", () => {
  const contract = connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1;
  assert.equal(contract.requiredPrivateBindings,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1);
  assert.equal(contract.requiredPrivateBindings.length, 14);
  assert.deepEqual(contract.retainedBlockers, [
    "private_locator_broker_missing",
    "exclusive_port_custody_missing",
  ]);
  assert.equal(contract.retainedBlockers,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1);
  assert.equal(Object.isFrozen(contract.requiredPrivateBindings), true);
  assert.equal(Object.isFrozen(contract.retainedBlockers), true);
});

test("CR13A-LIVE-150 fake cannot observe, select, reserve, issue, spend, clear, or grant", () => {
  const result = connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1;
  assert.equal(result.resultVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RESULT_V1);
  assert.match(result.resultReference, /^private-locator-fake:[a-f0-9]{24}$/);
  assert.equal(result.evidenceClass, "repository_fake");
  assert.equal(result.contractDigest, connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.contractDigest);
  assert.equal(result.policyReference, connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.policyReference);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1(result), result);
  const falseClaims = [
    result.targetRuntimeAttestationProvided, result.brokerProviderPresent, result.addressObserved,
    result.interfaceEnumerated, result.dnsResolved, result.portSelected, result.exclusivePortReserved,
    result.locatorMaterialPresent, result.locatorMaterialPublic, result.capabilityIssued, result.capabilitySpent,
    result.durableIssuanceRecorded, result.independentCheckpointPresent, result.driverHandoffPerformed,
    result.cleanupEvidencePresent, result.clearsPrivateLocatorBrokerBlocker,
    result.clearsExclusivePortCustodyBlocker, result.activationEligible, result.externalEffectOccurred,
    result.runtimeWired, result.grantsApproval, result.grantsQualificationAuthority,
    result.grantsCandidateAuthority, result.grantsActivationAuthority, result.grantsNetworkAuthority,
    result.grantsCommandAuthority, result.grantsLeaseAuthority, result.grantsExecutionAuthority,
  ];
  assert.deepEqual(falseClaims, new Array(falseClaims.length).fill(false));
  assert.equal(result.privateLocatorBrokerMissing, true);
  assert.equal(result.exclusivePortCustodyMissing, true);
});

test("CR13A-LIVE-150 keeps every observation and effect count at zero", () => {
  const result = connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1;
  assert.deepEqual([
    result.hostObservationAttempts, result.interfaceEnumerationAttempts, result.dnsResolutionAttempts,
    result.portSelectionsMade, result.portReservationsMade, result.capabilitiesIssued, result.capabilitySpends,
    result.nativeBackendConstructions, result.listenerAttemptsMade, result.ipcListenerAttemptsMade,
    result.socketAttemptsMade, result.timerCreations, result.networkIoEventsObserved, result.protectedValuesRead,
  ], new Array(14).fill(0));
  assert.equal(connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.publicLocatorMaterialAllowed, false);
  assert.equal(connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.realBrokerImplemented, false);
  assert.equal(connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.realCapabilityImplemented, false);
});

test("CR13A-LIVE-150 parsers reject copies, accessors, symbols, and Proxies without behavior", () => {
  const contract = connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1;
  const result = connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1({ ...contract }),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1({ ...result }), "invalid_result");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    enumerable: true,
    get() { executions += 1; throw new Error("raw locator accessor"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1(accessor), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1({
    ...result,
    [Symbol("hostile")]: true,
  }), "invalid_result");
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw locator proxy"); },
    get() { executions += 1; throw new Error("raw locator proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1(proxy), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1(proxy), "invalid_result");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-150 freezes collections, records, and callable surfaces", () => {
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1), true);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1), true);
  const callables = Object.values(brokerModule).filter((value) => typeof value === "function");
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
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackLocatorBrokerErrorV1.prototype), true);
  assert.equal(executions, 0);
});

test("CR13A-LIVE-150 errors and public records expose no locator or protected material", () => {
  const hostile = new ConnectionEnrollmentPrivateLoopbackLocatorBrokerErrorV1(
    "127.0.0.1:65123 interface en0 reservation socket credential owner /Users/example",
  );
  assert.equal(hostile.safeCode, "integrity_failed");
  assert.equal(hostile.message, "integrity_failed");
  assert.equal(hostile.stack, undefined);
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1,
    result: connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1,
  });
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|localhost|"(?:address|port|interface|endpoint|hostname|socket|reservationHandle|capabilityId)"\s*:|\/Users\/|credentialMaterial|ownerIdentity|BEGIN PRIVATE KEY/i);
});

test("CR13A-LIVE-150 uses captured validation intrinsics after import", () => {
  const originalIsFrozen = Object.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalReflectApply = Reflect.apply;
  let replacements = 0;
  try {
    Object.isFrozen = () => { replacements += 1; return false; };
    WeakSet.prototype.has = function () { replacements += 1; return false; };
    WeakMap.prototype.get = function () { replacements += 1; return undefined; };
    Reflect.apply = () => { replacements += 1; throw new Error("raw ambient locator sentinel"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1(
      connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1,
    ), connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1(
      connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1,
    ), connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(replacements, 0);
});

test("CR13A-LIVE-150 remains input-free, selection-free, native-free, and runtime-unwired", async () => {
  const modulePath = resolve(root, "src/connection-registry/v1/private-loopback-private-locator-broker.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source,
    /node:net|node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|private-loopback-physical-native-driver|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|networkInterfaces|lookup\s*\(|resolve\s*\(|createServer|\.listen\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  assert.doesNotMatch(source,
    /\b(?:observeAddress|enumerateInterfaces|selectPort|reservePort|issueCapability|spendCapability|createLocator|clearPrivateLocatorBlocker|assembleQualificationCandidate|connect|listen|writeFile|exec|spawn)\s*\(/i);
  const sourcePaths = await sourceFiles(resolve(root, "src"));
  const consumers: string[] = [];
  for (const path of sourcePaths) {
    if (path === modulePath) continue;
    const candidateSource = await readFile(path, "utf8");
    if (/private-loopback-private-locator-broker/.test(candidateSource)) consumers.push(path);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
