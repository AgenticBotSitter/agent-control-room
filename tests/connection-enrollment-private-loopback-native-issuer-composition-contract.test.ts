import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as compositionModule from
  "../src/connection-registry/v1/private-loopback-native-retained-resource-issuer-composition-contract";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BINDINGS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_FAILURES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_MARKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_PROOFS_V1,
  ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1,
  assessConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionV1,
  connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1,
  connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1,
  parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1,
  parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1,
} from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
type SafeCode = ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1
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

test("CR13A-LIVE-230 pins LIVE-220 and every fixed policy set", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1;
  assert.equal(contract.live220ProductCommit, "2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9");
  assert.equal(contract.acceptedLive220ReviewSha256,
    "4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30");
  assert.match(contract.contractReference, /^native-issuer-composition:[a-f0-9]{24}$/);
  assert.equal(contract.bindings, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BINDINGS_V1);
  assert.equal(contract.markers, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_MARKERS_V1);
  assert.equal(contract.order, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1);
  assert.equal(contract.failures, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_FAILURES_V1);
  assert.equal(contract.proofs, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_PROOFS_V1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1(contract), contract);
});

test("CR13A-LIVE-230 requires complete bindings, markers, proofs, and blockers", () => {
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BINDINGS_V1.length, 18);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_MARKERS_V1.length, 10);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1.length, 16);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_FAILURES_V1.length, 5);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_PROOFS_V1.length, 15);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BLOCKERS_V1.length, 8);
  for (const set of [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BINDINGS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_MARKERS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_FAILURES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_PROOFS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BLOCKERS_V1]) {
    assert.equal(Object.isFrozen(set), true);
    assert.equal(new Set(set).size, set.length);
  }
});

test("CR13A-LIVE-230 freezes the durable pre-effect and same-resource order", () => {
  const order = CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1;
  assert.deepEqual(order.slice(0, 6), [
    "verify_exact_bindings_and_expiry", "durably_claim_attempt", "durably_spend_locator_authority",
    "durably_spend_custody_authority", "durably_mark_effect_uncertainty", "retrieve_exact_private_factory_once",
  ]);
  assert.ok(order.indexOf("retain_exact_server_in_issuer_custody") <
    order.indexOf("offer_exact_server_to_exact_adapter_once"));
  assert.ok(order.indexOf("offer_exact_server_to_exact_adapter_once") <
    order.indexOf("atomically_transfer_custody_after_acceptance"));
  assert.ok(order.indexOf("close_once_by_current_owner") <
    order.indexOf("independently_observe_zero_resource"));
  assert.equal(order.at(-1), "durably_tombstone_and_checkpoint");
});

test("CR13A-LIVE-230 fixes one-use ceilings and rejects substitution", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1;
  assert.deepEqual([contract.maximumFactoryRetrievals, contract.maximumServerConstructions,
    contract.maximumListenerAttempts, contract.maximumLocatorObservations, contract.maximumAdapterAccepts,
    contract.maximumOwnershipTransfers, contract.maximumCloses], new Array(7).fill(1));
  assert.deepEqual([contract.callerFactoryAccepted, contract.callerServerAccepted, contract.callerAdapterAccepted,
    contract.callerLocatorAccepted, contract.callerEffectClientAccepted, contract.numericPortHandoffAllowed,
    contract.retryRebindReopenAllowed], new Array(7).fill(false));
});

test("CR13A-LIVE-230 exposes only honest blocked repository status", () => {
  const status = assessConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionV1();
  assert.equal(status, connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1(status), status);
  assert.equal(status.evidenceClass, "repository_contract");
  assert.deepEqual([status.compositionState, status.factoryState, status.resourceState, status.locatorState,
    status.handoffState, status.cleanupState], ["not_implemented", "not_retrieved_or_invoked",
    "not_created_or_retained", "not_observed_or_spent", "not_issued_or_spent", "not_required"]);
  assert.equal(status.blockers, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BLOCKERS_V1);
});

test("CR13A-LIVE-230 exact parsers reject copies, symbols, accessors, and Proxies without behavior", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1;
  const status = connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1({ ...contract }),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1({ ...status }),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1({
    ...status,
    [Symbol("hostile")]: true,
  }), "invalid_status");
  let executions = 0;
  const accessor = Object.defineProperty({}, "statusVersion", {
    get() { executions += 1; throw new Error("raw composition accessor"); },
  });
  const proxy = new Proxy({}, {
    get() { executions += 1; throw new Error("raw composition proxy"); },
    ownKeys() { executions += 1; throw new Error("raw composition proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1(accessor),
    "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1(proxy),
    "invalid_contract");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-230 freezes records and callables and sanitizes errors", () => {
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1), true);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1), true);
  const callables = Object.values(compositionModule).filter((value) => typeof value === "function");
  assert.equal(callables.length, 4);
  for (const callable of callables) assert.equal(Object.isFrozen(callable), true);
  const error = new ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1(
    "127.0.0.1:65123 server fd=7 /Users/example credential owner",
  );
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.message, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-230 uses captured validation intrinsics and ignores hostile extra arguments", () => {
  const contract = connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1;
  const status = connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1;
  const originals = [Object.isFrozen, WeakSet.prototype.has, WeakMap.prototype.get, Reflect.apply] as const;
  let executions = 0;
  try {
    Object.isFrozen = () => { executions += 1; return false; };
    WeakSet.prototype.has = function () { executions += 1; return false; };
    WeakMap.prototype.get = function () { executions += 1; return undefined; };
    Reflect.apply = () => { executions += 1; throw new Error("raw composition ambient"); };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1(contract), contract);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1(status), status);
    const hostile = new Proxy({}, { get() { executions += 1; return undefined; } });
    assert.equal((assessConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionV1 as
      (...args: unknown[]) => unknown)(hostile), status);
  } finally {
    Object.isFrozen = originals[0];
    WeakSet.prototype.has = originals[1];
    WeakMap.prototype.get = originals[2];
    Reflect.apply = originals[3];
  }
  assert.equal(executions, 0);
});

test("CR13A-LIVE-230 exposes zero effects and no authority-bearing value", () => {
  const status = connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1;
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  assert.equal(actuals.length, 18);
  assert.deepEqual(actuals, new Array(18).fill(0));
  assert.deepEqual([status.runtimeWired, status.externalEffectOccurred, status.clearsCustodyOrHandoffBlocker,
    status.candidateEligible, status.activationEligible, status.grantsApproval, status.grantsQualificationAuthority,
    status.grantsCandidateAuthority, status.grantsActivationAuthority, status.grantsNetworkAuthority,
    status.grantsCommandAuthority, status.grantsLeaseAuthority, status.grantsExecutionAuthority],
  new Array(13).fill(false));
  assert.doesNotMatch(JSON.stringify(status),
    /127\.0\.0\.1|localhost|"(?:address|port|interface|socket|server|listener|resource|handle|fileDescriptor|capability|locator)"\s*:|\/Users\/|credentialMaterial|ownerIdentity/i);
});

test("CR13A-LIVE-230 remains native-free, effect-free, and runtime-unwired", async () => {
  const modulePath = resolve(root,
    "src/connection-registry/v1/private-loopback-native-retained-resource-issuer-composition-contract.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source,
    /node:net|node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|postgres|pglite|sqlite|private-loopback-native-retained-resource-issuer-implementation|private-loopback-native-retained-resource-adapter|private-loopback-physical-native-driver|process\.(?:env|pid|ppid|argv|cwd|execPath|version|platform|arch)|createServer|\.listen\s*\(|\.close\s*\(|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  const consumers: string[] = [];
  for (const path of await sourceFiles(resolve(root, "src"))) {
    if (path === modulePath) continue;
    if (/from\s+["'][^"']*private-loopback-native-retained-resource-issuer-composition-contract["']/.test(
      await readFile(path, "utf8"),
    )) consumers.push(path);
  }
  assert.deepEqual(consumers, [resolve(root, "src/connection-registry/v1/index.ts")]);
});
