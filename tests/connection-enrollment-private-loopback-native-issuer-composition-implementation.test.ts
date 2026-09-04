import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as compositionModule from "../src/connection-registry/v1/private-loopback-native-issuer-composition-implementation";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_IMPLEMENTATION_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_HISTORY_EVENTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_SCENARIOS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATES_V1,
  ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1,
  assertConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1,
  connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1,
  createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1,
  parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1,
  parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
type SafeCode = ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1
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

test("CR13A-LIVE-240 pins LIVE-230 and exact one-use surfaces", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1;
  assert.equal(implementation.implementationVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_IMPLEMENTATION_V1);
  assert.match(implementation.implementationReference, /^native-issuer-composition-implementation:[a-f0-9]{24}$/);
  assert.equal(implementation.live230ProductCommit, "3974f165f106cb0fe616b2f0e91a18e45b1b4c2d");
  assert.equal(implementation.acceptedLive230ReviewSha256,
    "eb6957f2f577b77ce7c68fb2f8e92e80004a987e3fa83ba1bdee993f6f59d58a");
  assert.equal(implementation.scenarioSet, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_SCENARIOS_V1);
  assert.equal(implementation.stateSet, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATES_V1);
  assert.equal(implementation.bindingValidationMode, "exact_live230_identity_before_claim");
  assert.equal(implementation.expiryValidationMode, "repository_owned_simulated_unexpired_before_claim");
  assert.equal(implementation.scenarioSet.length, 6);
  assert.equal(implementation.stateSet.length, 8);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_HISTORY_EVENTS_V1.length, 24);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_HISTORY_EVENTS_V1), true);
  assert.deepEqual([
    implementation.maximumRuns, implementation.maximumClaims, implementation.maximumLocatorSpends,
    implementation.maximumBindingChecks, implementation.maximumExpiryChecks, implementation.maximumCustodySpends,
    implementation.maximumEffectMarkers, implementation.maximumFactoryRetrievals,
    implementation.maximumFakeResources, implementation.maximumListenerSettlements,
    implementation.maximumLocatorObservations, implementation.maximumAdapterAccepts,
    implementation.maximumOwnershipTransfers, implementation.maximumCloses,
  ], new Array(14).fill(1));
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1(implementation),
    implementation);
});

test("CR13A-LIVE-240 completes the ordered same-object transfer and cleanup", async () => {
  const composition = createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1("transferred_then_closed");
  const before = composition.status();
  assert.deepEqual(before.history, []);
  const status = await composition.run();
  assert.equal(status.state, "closed_verified");
  assert.equal(status.custodyOwner, "none");
  assert.equal(status.cleanupOutcome, "closed_verified");
  assert.deepEqual([
    status.runCalls, status.bindingCheckCalls, status.expiryCheckCalls, status.claimCalls, status.locatorSpendCalls,
    status.custodySpendCalls, status.effectMarkerCalls,
    status.factoryRetrievalCalls, status.fakeResourceCreateCalls, status.listenerSettlementCalls,
    status.locatorObservationCalls, status.adapterAcceptCalls, status.ownershipTransferCalls, status.closeCalls,
    status.independentObservationCalls, status.tombstoneCalls, status.checkpointCalls,
  ], new Array(17).fill(1));
  assert.equal(status.exactResourceIdentityVerifiedSimulated, true);
  assert.equal(status.continuousCustodyVerifiedSimulated, true);
  assert.equal(status.ownershipTransferredSimulated, true);
  assert.equal(status.independentZeroResourceObservationSimulated, true);
  assert.deepEqual(status.history, [
    "bindings_verified", "expiry_verified", "attempt_claimed", "locator_authority_spent",
    "custody_authority_spent", "effect_uncertainty_marked", "factory_retrieved", "fake_resource_created",
    "listener_settled", "private_locator_observed", "adapter_offered", "adapter_accepted",
    "ownership_transferred", "close_attempted", "cleanup_closed_verified", "independent_absence_observed",
    "tombstoned", "checkpointed",
  ]);
  assert.equal(status.transitionCount, status.history.length);
  assert.equal(Object.isFrozen(status.history), true);
  assert.deepEqual(before.history, []);
  assert.notEqual(status.history, before.history);
});

test("CR13A-LIVE-240 separates definite rejection and post-marker ambiguity", async () => {
  const rejected = await createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1(
    "rejected_before_effect_marker").run();
  assert.equal(rejected.state, "failed_before_effect");
  assert.deepEqual([rejected.runCalls, rejected.bindingCheckCalls, rejected.expiryCheckCalls, rejected.claimCalls,
    rejected.effectMarkerCalls, rejected.factoryRetrievalCalls, rejected.fakeResourceCreateCalls],
  [1, 1, 1, 1, 0, 0, 0]);
  assert.equal(rejected.effectUncertaintyMarkedSimulated, false);
  assert.deepEqual(rejected.history, ["bindings_verified", "expiry_verified", "pre_effect_rejected"]);

  const ambiguous = await createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1(
    "ambiguous_after_effect_marker").run();
  assert.equal(ambiguous.state, "ambiguous_after_effect");
  assert.equal(ambiguous.custodyOwner, "unresolved");
  assert.deepEqual([ambiguous.factoryRetrievalCalls, ambiguous.fakeResourceCreateCalls,
    ambiguous.listenerSettlementCalls, ambiguous.adapterAcceptCalls, ambiguous.closeCalls], [1, 0, 0, 0, 0]);
  assert.deepEqual(ambiguous.history, ["bindings_verified", "expiry_verified", "attempt_claimed",
    "locator_authority_spent", "custody_authority_spent", "effect_uncertainty_marked", "factory_retrieved",
    "native_settlement_ambiguous"]);
});

test("CR13A-LIVE-240 preserves issuer custody on adapter rejection", async () => {
  const status = await createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1(
    "adapter_rejected_issuer_closes").run();
  assert.equal(status.state, "closed_verified");
  assert.equal(status.adapterAcceptCalls, 1);
  assert.equal(status.adapterAcceptedSimulated, false);
  assert.equal(status.ownershipTransferCalls, 0);
  assert.equal(status.closeCalls, 1);
  assert.equal(status.custodyOwner, "none");
  assert.equal(status.continuousCustodyVerifiedSimulated, true);
  assert.equal(status.history.includes("adapter_rejected"), true);
  assert.equal(status.history.includes("ownership_transferred"), false);
});

test("CR13A-LIVE-240 never guesses custody after uncertain adapter acceptance", async () => {
  const status = await createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1(
    "adapter_acceptance_uncertain").run();
  assert.equal(status.state, "owner_unresolved");
  assert.equal(status.custodyOwner, "unresolved");
  assert.equal(status.adapterAcceptCalls, 1);
  assert.equal(status.ownershipTransferCalls, 0);
  assert.equal(status.closeCalls, 0);
  assert.equal(status.independentObservationCalls, 0);
  assert.equal(status.tombstoneCalls, 0);
  assert.equal(status.history.at(-1), "adapter_acceptance_uncertain");
});

test("CR13A-LIVE-240 recovers cleanup only by observing absence", async () => {
  const status = await createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1(
    "cleanup_failed_then_observed_absent").run();
  assert.equal(status.state, "closed_verified");
  assert.equal(status.cleanupOutcome, "observed_absent_after_failure");
  assert.equal(status.closeCalls, 1);
  assert.equal(status.independentObservationCalls, 1);
  assert.equal(status.replacementResourceCreatedSimulated, false);
  assert.equal(status.fakeResourceRetainedSimulated, false);
  assert.equal(status.history.includes("cleanup_failed"), true);
  assert.equal(status.history.includes("cleanup_observed_absent"), true);
  assert.ok(status.history.indexOf("cleanup_failed") < status.history.indexOf("cleanup_observed_absent"));
});

test("CR13A-LIVE-240 serializes concurrent runs into one exact promise", async () => {
  const composition = createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1("transferred_then_closed");
  const first = composition.run();
  assert.equal(composition.run(), first);
  assert.equal(composition.run(), first);
  const status = await first;
  assert.equal(status.runCalls, 1);
  assert.deepEqual([status.factoryRetrievalCalls, status.fakeResourceCreateCalls, status.listenerSettlementCalls,
    status.locatorObservationCalls, status.adapterAcceptCalls, status.ownershipTransferCalls, status.closeCalls],
  new Array(7).fill(1));
  assert.equal(status.bindingCheckCalls, 1);
  assert.equal(status.expiryCheckCalls, 1);
  assert.ok(status.history.indexOf("bindings_verified") < status.history.indexOf("expiry_verified"));
  assert.ok(status.history.indexOf("expiry_verified") < status.history.indexOf("attempt_claimed"));
});

test("CR13A-LIVE-240 binds status and rejects hostile values without behavior", async () => {
  const first = createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1("transferred_then_closed");
  const second = createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1("transferred_then_closed");
  const status = await first.run();
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1(status), status);
  assert.equal(assertConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1(first, status),
    status);
  expectCode(() => assertConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1(second,
    status), "status_mismatch");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1({
    ...connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1,
  }), "invalid_implementation");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1({ ...status }),
    "invalid_status");
  let executions = 0;
  const accessor = Object.defineProperty({}, "statusVersion", {
    get() { executions += 1; throw new Error("raw composition accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw composition proxy"); },
    get() { executions += 1; throw new Error("raw composition proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1(accessor),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1(proxy),
    "invalid_status");
  expectCode(() => first.run.call({}), "invalid_composition");
  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1(proxy), "invalid_scenario");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-240 freezes surfaces and resists ambient replacement", async () => {
  const objectConstructor = Object;
  const objectDefineProperty = objectConstructor.defineProperty;
  const originals = [objectConstructor.freeze, objectConstructor.isFrozen, objectConstructor.defineProperties,
    WeakSet.prototype.has,
    WeakMap.prototype.get, Reflect.apply, Array.prototype.includes, Array.prototype.slice,
    Array.prototype.push, objectConstructor.keys, JSON.stringify, objectConstructor.setPrototypeOf] as const;
  const originalInheritedThen = objectConstructor.getOwnPropertyDescriptor(objectConstructor.prototype, "then");
  const originalGlobalObject = objectConstructor.getOwnPropertyDescriptor(globalThis, "Object");
  const composition = createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1("transferred_then_closed");
  const executions = new Array(12).fill(0);
  let inheritedThenExecutions = 0;
  let ambientGlobalObjectReads = 0;
  let settledStatus: object | undefined;
  try {
    objectDefineProperty(objectConstructor.prototype, "then", {
      configurable: true,
      get() { inheritedThenExecutions += 1; throw new Error("raw inherited thenable ambient"); },
    });
    objectConstructor.freeze = <T>(value: T): Readonly<T> => { executions[0] += 1; return value; };
    objectConstructor.isFrozen = () => { executions[1] += 1; return false; };
    objectConstructor.defineProperties = (value) => { executions[2] += 1; return value; };
    WeakSet.prototype.has = function () { executions[3] += 1; return false; };
    WeakMap.prototype.get = function () { executions[4] += 1; return undefined; };
    Reflect.apply = () => { executions[5] += 1; throw new Error("raw composition ambient"); };
    Array.prototype.includes = () => { executions[6] += 1; return false; };
    Array.prototype.slice = () => { executions[7] += 1; return []; };
    Array.prototype.push = () => { executions[8] += 1; return 0; };
    objectConstructor.keys = () => { executions[9] += 1; return []; };
    JSON.stringify = () => { executions[10] += 1; return "raw ambient"; };
    objectConstructor.setPrototypeOf = <T extends object>(value: T): T => { executions[11] += 1; return value; };
    objectDefineProperty(globalThis, "Object", {
      configurable: true,
      get() { ambientGlobalObjectReads += 1; return objectConstructor; },
    });
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1(
      connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1),
    connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1);
    settledStatus = await composition.run();
  } finally {
    objectConstructor.freeze = originals[0];
    objectConstructor.isFrozen = originals[1];
    objectConstructor.defineProperties = originals[2];
    WeakSet.prototype.has = originals[3];
    WeakMap.prototype.get = originals[4];
    Reflect.apply = originals[5];
    Array.prototype.includes = originals[6];
    Array.prototype.slice = originals[7];
    Array.prototype.push = originals[8];
    objectConstructor.keys = originals[9];
    JSON.stringify = originals[10];
    objectConstructor.setPrototypeOf = originals[11];
    if (originalGlobalObject) objectDefineProperty(globalThis, "Object", originalGlobalObject);
    if (originalInheritedThen) objectDefineProperty(objectConstructor.prototype, "then", originalInheritedThen);
    else delete (objectConstructor.prototype as { then?: unknown }).then;
  }
  assert.deepEqual(executions, new Array(12).fill(0));
  assert.equal(inheritedThenExecutions, 0);
  assert.equal(ambientGlobalObjectReads, 0);
  assert.ok(settledStatus);
  assert.equal(Object.getPrototypeOf(settledStatus), null);
  assert.equal(Object.isFrozen(composition), true);
  for (const callable of Object.values(compositionModule).filter((value) => typeof value === "function")) {
    assert.equal(Object.isFrozen(callable), true);
  }
});

test("CR13A-LIVE-240 exposes safe zero-effect truth and has no runtime consumer", async () => {
  const status = await createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1(
    "transferred_then_closed").run();
  const zeroes = [status.actualHostObservations, status.actualPortSelections, status.actualPortReservations,
    status.actualFactoryRetrievals, status.actualNativeBackendConstructions, status.actualNativeResourcesCreated,
    status.actualNativeResourcesRetained, status.actualListenerAttempts, status.actualCloseAttempts,
    status.actualLocatorObservations, status.actualCapabilitiesIssued, status.actualCapabilitiesSpent,
    status.actualAdapterAcceptCalls, status.actualDriverCalls, status.actualPersistenceWrites,
    status.actualTimerCreations, status.actualNetworkIoEvents, status.actualProtectedValuesRead];
  assert.deepEqual(zeroes, new Array(zeroes.length).fill(0));
  const falseClaims = [status.runtimeWired, status.externalEffectOccurred, status.clearsCustodyOrHandoffBlocker,
    status.candidateEligible, status.activationEligible, status.grantsApproval, status.grantsQualificationAuthority,
    status.grantsCandidateAuthority, status.grantsActivationAuthority, status.grantsNetworkAuthority,
    status.grantsCommandAuthority, status.grantsLeaseAuthority, status.grantsExecutionAuthority];
  assert.deepEqual(falseClaims, new Array(falseClaims.length).fill(false));
  assert.doesNotMatch(JSON.stringify(status),
    /127\.0\.0\.1|localhost|"(?:address|port|interface|socket|server|resource|handle|descriptor|locator|capability)"\s*:|\/Users\/|credential|ownerIdentity/i);

  const modulePath = resolve(root,
    "src/connection-registry/v1/private-loopback-native-issuer-composition-implementation.ts");
  const source = await readFile(modulePath, "utf8");
  const imports = [...source.matchAll(/^import\s+(?:type\s+)?[^;]+from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["../../security"]);
  assert.doesNotMatch(source,
    /node:net|node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|postgres|pglite|sqlite|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|networkInterfaces|createServer|\.listen\s*\(|new\s+Socket|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  const consumers: string[] = [];
  for (const path of await sourceFiles(resolve(root, "src"))) {
    if (path === modulePath) continue;
    if (/private-loopback-native-issuer-composition-implementation/.test(await readFile(path, "utf8"))) {
      consumers.push(path);
    }
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
