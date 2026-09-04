import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as issuerModule from "../src/connection-registry/v1/private-loopback-native-retained-resource-issuer-contract";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CONTRACT_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_RESULT_V1,
  ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerErrorV1,
  connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1,
  connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");

function expectCode(run: () => unknown, code: "invalid_contract" | "invalid_result" | "integrity_failed"): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerErrorV1
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

test("CR13A-LIVE-200 binds the exact accepted LIVE-190 product and rereview", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1;
  assert.equal(contract.contractVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CONTRACT_V1);
  assert.match(contract.policyReference, /^native-retained-resource-issuer-policy:[a-f0-9]{24}$/);
  assert.equal(contract.live190ProductCommit, "d59c02792e49a79a291e3f9109fc43f2fd22fbd8");
  assert.equal(contract.acceptedLive190ReviewSha256,
    "29be3e4ba7075397a764d57161bbff953993e6d2d815a4cc9ac353f475ab224a");
  assert.equal(contract.resourceClass, "retained_ipv4_loopback_tcp_listener");
  assert.equal(contract.issuerSurface, "same_module_private_non_serializable");
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1(contract), contract);
});

test("CR13A-LIVE-200 freezes all issuer bindings, markers, failures, and proofs", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1;
  assert.equal(contract.requiredBindings,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1);
  assert.equal(contract.requiredMarkers,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1);
  assert.equal(contract.failureClasses,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1);
  assert.equal(contract.requiredProofs,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1);
  assert.equal(contract.requiredBindings.length, 15);
  assert.equal(contract.requiredMarkers.length, 13);
  assert.equal(contract.failureClasses.length, 4);
  assert.equal(contract.requiredProofs.length, 14);
  for (const set of [contract.requiredBindings, contract.requiredMarkers, contract.failureClasses,
    contract.requiredProofs]) assert.equal(Object.isFrozen(set), true);
  assert.deepEqual([
    contract.maximumServerCreations, contract.maximumListenAttempts, contract.maximumAdapterAcceptances,
    contract.maximumCloseAttempts,
  ], [1, 1, 1, 1]);
  assert.equal(contract.retryRebindReopenAllowed, false);
  assert.equal(contract.numericPortHandoffAllowed, false);
  assert.equal(contract.publicResourceOrLocatorAllowed, false);
});

test("CR13A-LIVE-200 repository fake makes no issuer, custody, terminal, or eligibility claim", () => {
  const result = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1;
  assert.equal(result.resultVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_RESULT_V1);
  assert.match(result.resultReference, /^native-retained-resource-issuer-fake:[a-f0-9]{24}$/);
  assert.equal(result.evidenceClass, "repository_fake");
  assert.equal(result.policyReference,
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1.policyReference);
  assert.equal(result.contractDigest,
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1.contractDigest);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1(result), result);
  assert.equal(result.driverReservationHandoffGapPresent, true);
  assert.equal(result.exclusivePortCustodyMissing, true);
  const falseClaims = [
    result.bindingsVerified, result.attemptClaimed, result.locatorSpent, result.custodySpent,
    result.effectUncertaintyMarked, result.nativeServerCreated, result.nativeServerRetained,
    result.sameResourceIdentityVerified, result.continuousCustodyVerified, result.adapterAcceptedExactResource,
    result.ownershipTransferred, result.terminalCloseVerified, result.independentZeroResourceEvidencePresent,
    result.terminalTombstoneRecorded, result.externalCheckpointRecorded, result.realIssuerImplemented,
    result.clearsCustodyOrHandoffBlocker, result.candidateEligible, result.activationEligible, result.runtimeWired,
    result.externalEffectOccurred, result.grantsApproval, result.grantsQualificationAuthority,
    result.grantsCandidateAuthority, result.grantsActivationAuthority, result.grantsNetworkAuthority,
    result.grantsCommandAuthority, result.grantsLeaseAuthority, result.grantsExecutionAuthority,
  ];
  assert.deepEqual(falseClaims, new Array(falseClaims.length).fill(false));
});

test("CR13A-LIVE-200 keeps every actual host, native, persistence, and effect count at zero", () => {
  const result = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1;
  assert.deepEqual([
    result.actualHostObservations, result.actualPortSelections, result.actualPortReservations,
    result.actualNativeResourcesCreated, result.actualNativeResourcesRetained, result.actualCapabilitiesIssued,
    result.actualCapabilitiesSpent, result.actualDriverAcceptCalls, result.actualNativeBackendConstructions,
    result.actualListenerAttempts, result.actualIpcListenerAttempts, result.actualSocketAttempts,
    result.actualTimerCreations, result.actualNetworkIoEvents, result.actualProtectedValuesRead,
    result.actualPersistenceWrites,
  ], new Array(16).fill(0));
});

test("CR13A-LIVE-200 exact parsers reject copies, symbols, accessors, and Proxies without behavior", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1;
  const result = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1({ ...contract }),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1({ ...result }),
    "invalid_result");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1({
    ...contract,
    [Symbol("hostile")]: true,
  }), "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw issuer accessor"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1(accessor),
    "invalid_contract");
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw issuer proxy"); },
    get() { executions += 1; throw new Error("raw issuer proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1(proxy),
    "invalid_result");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-200 freezes records, sets, callables, prototype, and safe errors", () => {
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1), true);
  const callables = Object.values(issuerModule).filter((value) => typeof value === "function");
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
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerErrorV1.prototype), true);
  const hostile = new ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerErrorV1(
    "127.0.0.1:65123 server fd=7 /Users/example credential owner",
  );
  assert.equal(hostile.safeCode, "integrity_failed");
  assert.equal(hostile.message, "integrity_failed");
  assert.equal(hostile.stack, undefined);
  assert.equal(executions, 0);
});

test("CR13A-LIVE-200 uses captured validation intrinsics after import", () => {
  const originals = [Object.isFrozen, WeakSet.prototype.has, WeakMap.prototype.get, Reflect.apply] as const;
  let executions = 0;
  try {
    Object.isFrozen = () => { executions += 1; return false; };
    WeakSet.prototype.has = function () { executions += 1; return false; };
    WeakMap.prototype.get = function () { executions += 1; return undefined; };
    Reflect.apply = () => { executions += 1; throw new Error("raw issuer ambient"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1(
      connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1,
    ), connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1(
      connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1,
    ), connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1);
  } finally {
    Object.isFrozen = originals[0];
    WeakSet.prototype.has = originals[1];
    WeakMap.prototype.get = originals[2];
    Reflect.apply = originals[3];
  }
  assert.equal(executions, 0);
});

test("CR13A-LIVE-200 exposes no server, locator, port, handle, capability, protected value, or authority", () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1,
    result: connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1,
  });
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|localhost|"(?:address|port|interface|socket|server|handle|fileDescriptor|capabilityId)"\s*:|\/Users\/|credentialMaterial|ownerIdentity/i);
});

test("CR13A-LIVE-200 remains network-free, adapter-free, input-free, and runtime-unwired", async () => {
  const modulePath = resolve(root,
    "src/connection-registry/v1/private-loopback-native-retained-resource-issuer-contract.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source,
    /node:net|node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|private-loopback-physical-native-driver|private-loopback-native-retained-resource-adapter|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|networkInterfaces|createServer|\.listen\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  assert.doesNotMatch(source,
    /\b(?:selectPort|reservePort|createReservation|issueCapability|spendCapability|transferListener|acceptResource|clearExclusivePort|connect|listen|exec|spawn)\s*\(/i);
  const consumers: string[] = [];
  for (const path of await sourceFiles(resolve(root, "src"))) {
    if (path === modulePath) continue;
    if (/private-loopback-native-retained-resource-issuer-contract/.test(await readFile(path, "utf8"))) {
      consumers.push(path);
    }
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
