import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as nativeIssuerModule from
  "../src/connection-registry/v1/private-loopback-native-retained-resource-issuer-implementation";
import {
  connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1,
  connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1,
} from "../src/connection-registry/v1/private-loopback-native-retained-resource-issuer-implementation";

const root = resolve(import.meta.dirname, "..");
const implementationPath = resolve(root,
  "src/connection-registry/v1/private-loopback-native-retained-resource-issuer-implementation.ts");

test("CR13A-LIVE-270 pins all accepted source boundaries and honest private reachability", () => {
  const implementation = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1;
  assert.equal(implementation.live220ProductCommit, "2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9");
  assert.equal(implementation.acceptedLive220ReviewSha256,
    "4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30");
  assert.equal(implementation.live240ProductCommit, "71e4c737b6e681fe24d730decc3497d196cf441c");
  assert.equal(implementation.acceptedLive240ReviewSha256,
    "1d552ac7d580d6996b5192139dee85beb4f15e1058cf2c19719e9424f82f00f8");
  assert.equal(implementation.live250ProductCommit, "9b855d4193837fdf6d0d0fce1dcfd65a94cce49f");
  assert.equal(implementation.acceptedLive250ReviewSha256,
    "2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6");
  assert.equal(implementation.live260ProductCommit, "01bfa6540cc83dc6099564e4fc9043be4cafddc6");
  assert.equal(implementation.acceptedLive260ReviewSha256,
    "41c55ae9437f8951e18f919ec1569bbebe1f795cafeaade51a41826fc3d0f9f1");
  assert.equal(implementation.privateFactoryLexicallyReachable, true);
  assert.equal(implementation.privateRetrievalBridgeImplemented, true);
  assert.equal(implementation.privateCompositionShellImplemented, true);
  assert.equal(implementation.nativeFactoryReachable, false);
  assert.equal(implementation.privateShellExported, false);
  assert.equal(implementation.privateShellRuntimeReachable, false);
  assert.equal(implementation.nativeInvocationAllowed, false);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1(
    implementation), implementation);
});

test("CR13A-LIVE-270 reports exact zero shell, bridge, factory, native, and external use", () => {
  const status = connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1;
  assert.equal(status.privateFactoryLexicallyReachable, true);
  assert.equal(status.privateRetrievalBridgeImplemented, true);
  assert.equal(status.privateCompositionShellImplemented, true);
  assert.equal(status.privateShellExported, false);
  assert.equal(status.privateShellRuntimeReachable, false);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1(status), status);
  assert.deepEqual([
    status.actualPrivateShellEntries, status.actualPrivateBridgeConsumptions, status.actualPrivateFactoryLookups,
    status.actualPrivateFactoryReceipts, status.actualPrivateFactoryInvocations,
    status.actualNativeBackendConstructions, status.actualNativeResourcesCreated, status.actualNativeResourcesRetained,
    status.actualListenerAttempts, status.actualCloseAttempts, status.actualHostObservations,
    status.actualPortSelections, status.actualPortReservations, status.actualHandoffCapabilitiesIssued,
    status.actualHandoffCapabilitiesSpent, status.actualDriverAcceptCalls, status.actualPersistenceWrites,
    status.actualTimerCreations, status.actualNetworkIoEvents, status.protectedValuesRead,
  ], new Array(20).fill(0));
  assert.deepEqual([
    status.runtimeWired, status.physicalQualificationAccepted, status.clearsCustodyOrHandoffBlocker,
    status.candidateEligible, status.activationEligible, status.externalEffectOccurred, status.grantsApproval,
    status.grantsQualificationAuthority, status.grantsCandidateAuthority, status.grantsActivationAuthority,
    status.grantsNetworkAuthority, status.grantsCommandAuthority, status.grantsLeaseAuthority,
    status.grantsExecutionAuthority,
  ], new Array(14).fill(false));
});

test("CR13A-LIVE-270 keeps shell and bridge private, no-input, stored once, and unreachable", async () => {
  const source = await readFile(implementationPath, "utf8");
  assert.match(source, /function createQuarantinedNativeCompositionShellV1\(\): PrivateNativeCompositionShellV1/);
  assert.match(source, /const privateNativeCompositionShellV1 = \(\): Promise<PrivateNativeCompositionShellOutcomeV1>/);
  assert.match(source, /const quarantinedNativeCompositionShellsV1 = new WeakMap/);
  assert.equal((source.match(/weakMapSetV1, quarantinedNativeCompositionShellsV1/g) ?? []).length, 1);
  assert.doesNotMatch(source, /weakMapGetV1, quarantinedNativeCompositionShellsV1/);
  assert.doesNotMatch(source, /export (?:async )?function createQuarantinedNativeCompositionShellV1/);
  assert.doesNotMatch(source, /export .*PrivateNativeCompositionShell/);
  assert.doesNotMatch(source, /private-loopback-native-issuer-composition-implementation/);
  assert.doesNotMatch(source, /private-loopback-native-retained-resource-adapter/);

  const allowedFunctions = new Set([
    "ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1",
    "createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1",
    "parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1",
  ]);
  for (const [name, value] of Object.entries(nativeIssuerModule)) {
    if (typeof value === "function") assert.equal(allowedFunctions.has(name), true, name);
  }
});

test("CR13A-LIVE-270 fixes consume-before-lookup and receipt-before-invocation in lexical scope", async () => {
  const source = await readFile(implementationPath, "utf8");
  const shell = source.slice(source.indexOf("function createQuarantinedNativeCompositionShellV1"),
    source.indexOf("const implementationSeedV1"));
  const ordered = [
    "parseConnectionEnrollmentPrivateLoopbackNativeFactoryRetrievalBridgeContractV1(",
    "parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1(",
    "if (bridgeConsumedV1)",
    "bridgeConsumedV1 = true",
    "weakMapGetV1, quarantinedNativeFactoriesV1",
    "const factoryReceiptV1 = nativeFactoryV1",
    "reflectApplyV1(factoryReceiptV1, undefined, [])",
  ];
  let previous = -1;
  for (const marker of ordered) {
    const next = shell.indexOf(marker);
    assert.ok(next > previous, marker);
    previous = next;
  }
  assert.equal((shell.match(/weakMapGetV1, quarantinedNativeFactoriesV1/g) ?? []).length, 1);
  assert.equal((shell.match(/reflectApplyV1\(factoryReceiptV1, undefined, \[\]\)/g) ?? []).length, 1);
  assert.doesNotMatch(shell, /return nativeFactoryV1|return factoryReceiptV1|JSON\.stringify|console\.|sha256Digest/);
});

test("CR13A-LIVE-270 introduces no second native importer or runtime consumer", async () => {
  const source = await readFile(implementationPath, "utf8");
  assert.equal((source.match(/from "node:net"/g) ?? []).length, 1);
  assert.match(source, /from "\.\/private-loopback-native-factory-retrieval-bridge-contract"/);
  assert.match(source, /from "\.\/private-loopback-native-composition-shell-contract"/);
  assert.doesNotMatch(source, /node:os|node:process|node:fs|node:child_process|node:dns|node:http|node:https|node:tls|node:dgram|postgres|pglite|sqlite|fetch\s*\(|WebSocket|ssh2|setTimeout|setInterval/);
  const shellMapStorage = source.indexOf("weakMapSetV1, quarantinedNativeCompositionShellsV1");
  const publicConstruction = source.indexOf(
    "export function createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeV1");
  assert.ok(shellMapStorage >= 0 && publicConstruction > shellMapStorage);
  assert.doesNotMatch(source.slice(publicConstruction),
    /quarantinedNativeCompositionShellsV1|createQuarantinedNativeCompositionShellV1|factoryReceiptV1/);
});
