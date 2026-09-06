import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1,
  createConnectionEnrollmentPrivateLoopbackListenerPlanV1,
  createConnectionEnrollmentPrivateLoopbackNativeDriverContractV1,
  createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1,
} from "../src/connection-registry/v1/index.ts";
import * as physicalDriverModule from
  "../src/connection-registry/v1/private-loopback-physical-native-driver.ts";
import { ConnectionEnrollmentPrivateLoopbackFrameDecoderV1 } from
  "../src/connection-registry/v1/private-loopback-framing.ts";
import { sha256Digest } from "../src/security/index.ts";

const {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_FAKE_SCENARIOS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_IMPLEMENTATION_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATUS_V1,
  ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1,
  assertConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusForDriverV1,
  createRepositoryFakeConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverV1,
  describeConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1,
} = physicalDriverModule;

const digest = (label: string) => sha256Digest({ label });

function buildContract(listenerSuffix = "001") {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1({
    listenerId: `private-loopback-listener:physical-native-fixture-${listenerSuffix}`,
    endpointIdentityDigest: digest(`endpoint-${listenerSuffix}`),
    ownerIdentityDigest: digest(`owner-${listenerSuffix}`),
    tunnelPeerIdentityDigest: digest(`peer-${listenerSuffix}`),
    tunnelHostKeyDigest: digest(`host-key-${listenerSuffix}`),
    channelIdentityDigest: digest(`channel-${listenerSuffix}`),
    maximumFrameBytes: 8_192,
    maximumChunks: 64,
    maximumConnectionDurationMs: 45_000,
    idleTimeoutMs: 4_000,
    shutdownGraceMs: 3_000,
  });
  const readiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(plan);
  return createConnectionEnrollmentPrivateLoopbackNativeDriverContractV1({ plan, readiness });
}

function buildDriver(scenario: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_FAKE_SCENARIOS_V1[number]
= "closed_verified", suffix: string = scenario) {
  const contract = buildContract(suffix);
  const driver = createRepositoryFakeConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverV1({
    contract,
    scenario,
  });
  return { contract, driver };
}

function expectCode(action: () => unknown,
  code: InstanceType<typeof ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1>["safeCode"]): void {
  assert.throws(action, (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1 && error.safeCode === code);
}

async function expectRejectedCode(action: () => Promise<unknown>,
  code: InstanceType<typeof ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1>["safeCode"]):
Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1 && error.safeCode === code);
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if ([".ts", ".tsx", ".mts", ".js", ".mjs"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

test("CR13A-LIVE-120 describes one implemented but unwired native backend", () => {
  const contract = buildContract("descriptor");
  const implementation = describeConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1(contract);
  assert.equal(implementation.contractVersion,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_IMPLEMENTATION_V1);
  assert.match(implementation.implementationReference, /^physical-native-implementation:[a-f0-9]{24}$/);
  assert.equal(implementation.driverContractDigest, contract.contractDigest);
  assert.deepEqual(implementation.operationSet,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1);
  assert.equal(implementation.serverModule, "node:net");
  assert.equal(implementation.bindPolicy, "literal_ipv4_loopback_only");
  assert.equal(implementation.portPolicy, "opaque_private_capability_only");
  assert.deepEqual([
    implementation.nativeImplementationPresent,
    implementation.repositoryFakeTestOnly,
    implementation.requiresIndependentReview,
    implementation.requiresFreshOwnerAuthorizationForPhysicalAttempt,
  ], new Array(4).fill(true));
  assert.deepEqual([
    implementation.nativeFactoryExported,
    implementation.bindCapabilityIssuerPresent,
    implementation.runtimeWired,
    implementation.physicalQualificationAccepted,
    implementation.activationEligible,
    implementation.externalEffectOccurred,
    implementation.automaticRestartAllowed,
    implementation.grantsApproval,
    implementation.grantsNetworkAuthority,
    implementation.grantsCommandAuthority,
    implementation.grantsLeaseAuthority,
    implementation.grantsExecutionAuthority,
  ], new Array(12).fill(false));
  assert.equal(implementation.listenerAttemptsMade, 0);
  assert.equal(implementation.networkIoEventsObserved, 0);
  assert.equal(Object.isFrozen(implementation), true);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1(implementation),
    implementation);
});

test("CR13A-LIVE-120 repository fake exercises the full happy lifecycle with zero effects", async () => {
  const { driver } = buildDriver();
  const created = driver.status();
  assert.equal(created.state, "created");
  assert.equal(created.statusCalls, 1);
  assert.equal((await driver.prepare()).state, "prepared");
  const listening = await driver.start();
  assert.equal(listening.state, "listening");
  assert.equal(listening.preEffectMarkerSimulated, true);
  assert.equal(listening.bindCallSimulated, true);
  const [closed, duplicateClose] = await Promise.all([driver.close(), driver.close()]);
  assert.equal(closed, duplicateClose);
  assert.equal(closed.state, "closed");
  assert.equal(closed.cleanupVerifiedSimulated, true);
  const [recovered, duplicateRecovery] = await Promise.all([driver.recover(), driver.recover()]);
  assert.equal(recovered, duplicateRecovery);
  assert.equal(recovered.state, "recovery_checked");
  assert.equal(recovered.recoveryChecked, true);
  assert.equal(recovered.listenerAttemptsMade, 0);
  assert.equal(recovered.networkIoEventsObserved, 0);
  assert.equal(recovered.runtimeWired, false);
  assert.equal(recovered.externalEffectOccurred, false);
  assert.equal(recovered.automaticRetryAllowed, false);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1(recovered), recovered);
  assert.equal(recovered.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATUS_V1);
  assertConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusForDriverV1(driver, recovered);
});

test("CR13A-LIVE-120 distinguishes pre-bind failure from post-marker ambiguity and never retries", async () => {
  for (const [scenario, expectedState, marker, bind] of [
    ["failed_before_bind", "failed_before_bind", false, false],
    ["ambiguous_after_marker", "ambiguous_after_marker", true, true],
  ] as const) {
    const { driver } = buildDriver(scenario);
    await driver.prepare();
    const terminal = await driver.start();
    assert.equal(terminal.state, expectedState);
    assert.equal(terminal.preEffectMarkerSimulated, marker);
    assert.equal(terminal.bindCallSimulated, bind);
    await expectRejectedCode(() => driver.start(), "start_already_consumed");
    const closed = await driver.close();
    assert.equal(closed.state, expectedState);
    assert.equal(closed.cleanupVerifiedSimulated, scenario === "ambiguous_after_marker");
    const recovered = await driver.recover();
    assert.equal(recovered.state, "recovery_checked");
    assert.equal(recovered.listenerAttemptsMade, 0);
    assert.equal(recovered.externalEffectOccurred, false);
  }
});

test("CR13A-LIVE-120 preserves cleanup failure as terminal until no-reopen recovery", async () => {
  const { driver } = buildDriver("cleanup_failed");
  await driver.prepare();
  await driver.start();
  const cleanupFailure = await driver.close();
  assert.equal(cleanupFailure.state, "cleanup_failed");
  assert.equal(cleanupFailure.cleanupVerifiedSimulated, false);
  assert.equal(cleanupFailure.automaticRetryAllowed, false);
  await expectRejectedCode(() => driver.start(), "start_already_consumed");
  assert.equal((await driver.recover()).state, "recovery_checked");
  assert.equal((await driver.recover()).state, "recovery_checked");
});

test("CR13A-LIVE-120 serializes concurrent prepare, start, close, and recovery calls", async () => {
  const { driver } = buildDriver("closed_verified", "concurrency");
  const prepares = await Promise.all(Array.from({ length: 32 }, () => driver.prepare()));
  assert.equal(new Set(prepares).size, 1);
  const starts = await Promise.allSettled(Array.from({ length: 32 }, () => driver.start()));
  assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(starts.filter((result) => result.status === "rejected"
    && result.reason instanceof ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1
    && result.reason.safeCode === "start_already_consumed").length, 31);
  const closes = await Promise.all(Array.from({ length: 32 }, () => driver.close()));
  assert.equal(new Set(closes).size, 1);
  const recoveries = await Promise.all(Array.from({ length: 32 }, () => driver.recover()));
  assert.equal(new Set(recoveries).size, 1);
  assert.equal(recoveries[0]!.state, "recovery_checked");
});

test("CR13A-LIVE-120 fails closed on illegal operation order", async () => {
  const { driver } = buildDriver("closed_verified", "sequence");
  await expectRejectedCode(() => driver.start(), "sequence_conflict");
  await expectRejectedCode(() => driver.close(), "sequence_conflict");
  await expectRejectedCode(() => driver.recover(), "recovery_not_terminal");
  await driver.prepare();
  await expectRejectedCode(() => driver.prepare(), "sequence_conflict");
  await driver.start();
  await expectRejectedCode(() => driver.recover(), "recovery_not_terminal");
});

test("CR13A-LIVE-120 exact-brands implementation, driver, and status provenance", async () => {
  const first = buildDriver("closed_verified", "provenance-a");
  const second = buildDriver("closed_verified", "provenance-b");
  const implementation = describeConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1(first.contract);
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1({ ...implementation }),
    "invalid_implementation");
  await first.driver.prepare();
  const status = await first.driver.start();
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1({ ...status }), "invalid_status");
  expectCode(() => assertConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusForDriverV1(second.driver, status),
    "invalid_status");
  assertConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusForDriverV1(first.driver, status);
});

test("CR13A-LIVE-120 rejects copies, accessors, symbols, and Proxies without running caller behavior", () => {
  const contract = buildContract("hostile-input");
  let executions = 0;
  const accessor = {} as Record<string, unknown>;
  Object.defineProperties(accessor, {
    contract: { enumerable: true, get() { executions += 1; return contract; } },
    scenario: { enumerable: true, value: "closed_verified" },
  });
  expectCode(() => createRepositoryFakeConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverV1(accessor),
    "invalid_configuration");
  expectCode(() => createRepositoryFakeConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverV1({
    contract,
    scenario: "closed_verified",
    extra: true,
  }), "invalid_configuration");
  const symbol = Symbol("hostile");
  expectCode(() => createRepositoryFakeConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverV1({
    contract,
    scenario: "closed_verified",
    [symbol]: true,
  }), "invalid_configuration");
  expectCode(() => createRepositoryFakeConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverV1(new Proxy({
    contract,
    scenario: "closed_verified",
  }, {
    ownKeys() { executions += 1; throw new Error("must remain inert"); },
    get() { executions += 1; throw new Error("must remain inert"); },
  })), "invalid_configuration");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-120 freezes the fake driver's callable surface and rejects borrowed receivers", async () => {
  const { driver } = buildDriver("closed_verified", "surface");
  const prototype = Object.getPrototypeOf(driver) as Record<string, (...args: unknown[]) => unknown>;
  assert.equal(Object.isFrozen(driver), true);
  assert.equal(Object.isFrozen(prototype), true);
  assert.throws(() => Object.setPrototypeOf(driver, {}), TypeError);
  let replacementExecutions = 0;
  for (const name of ["prepare", "start", "status", "close", "recover"] as const) {
    const method = prototype[name]!;
    assert.equal(Object.isFrozen(method), true);
    assert.throws(() => Object.defineProperty(method, "call", {
      value: () => { replacementExecutions += 1; },
    }), TypeError);
    if (name === "status") expectCode(() => Reflect.apply(method, {}, []), "invalid_driver");
    else await expectRejectedCode(() => Reflect.apply(method, {}, []) as Promise<unknown>, "invalid_driver");
  }
  assert.equal(replacementExecutions, 0);
});

test("CR13A-LIVE-120 freezes every exported callable and the captured decoder surface", () => {
  const exportedCallables = Object.values(physicalDriverModule).filter(
    (value): value is (...args: unknown[]) => unknown => typeof value === "function",
  );
  assert.equal(exportedCallables.length, 6);
  for (const callable of exportedCallables) {
    assert.equal(Object.isFrozen(callable), true);
    assert.equal(Object.isExtensible(callable), false);
    for (const property of ["call", "apply", "bind"] as const) {
      assert.throws(() => Object.defineProperty(callable, property, {
        value: () => assert.fail("decorated callable executed"),
      }), TypeError);
    }
  }
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1.prototype), true);
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackFrameDecoderV1), true);
  assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackFrameDecoderV1.prototype), true);
  for (const method of [
    ConnectionEnrollmentPrivateLoopbackFrameDecoderV1.prototype.push,
    ConnectionEnrollmentPrivateLoopbackFrameDecoderV1.prototype.finish,
    ConnectionEnrollmentPrivateLoopbackFrameDecoderV1.prototype.close,
  ]) {
    assert.equal(Object.isFrozen(method), true);
    assert.throws(() => Object.defineProperty(method, "call", {
      value: () => assert.fail("decoder replacement executed"),
    }), TypeError);
  }
  assert.throws(() => Object.defineProperty(ConnectionEnrollmentPrivateLoopbackFrameDecoderV1.prototype, "push", {
    value: () => assert.fail("decoder replacement executed"),
  }), TypeError);
});

test("CR13A-LIVE-120 uses captured validation intrinsics", async () => {
  const { driver } = buildDriver("closed_verified", "captured-intrinsics");
  await driver.prepare();
  const status = await driver.start();
  const originalIncludes = Array.prototype.includes;
  const originalSafeInteger = Number.isSafeInteger;
  let replacements = 0;
  try {
    Array.prototype.includes = function () { replacements += 1; return false; };
    Number.isSafeInteger = () => { replacements += 1; return false; };
    assert.equal(parseConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1(status), status);
  } finally {
    Array.prototype.includes = originalIncludes;
    Number.isSafeInteger = originalSafeInteger;
  }
  assert.equal(replacements, 0);
});

test("CR13A-LIVE-120 does not resolve the ambient Number receiver during status validation", async () => {
  const { driver } = buildDriver("closed_verified", "captured-number-receiver");
  await driver.prepare();
  const status = await driver.start();
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Number");
  assert.ok(originalDescriptor);
  let executions = 0;
  let parsed: unknown;
  try {
    Object.defineProperty(globalThis, "Number", {
      configurable: true,
      get() {
        executions += 1;
        throw new Error("raw ambient sentinel");
      },
    });
    parsed = parseConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1(status);
  } finally {
    Object.defineProperty(globalThis, "Number", originalDescriptor);
  }
  assert.equal(parsed, status);
  assert.equal(executions, 0);
});

test("CR13A-LIVE-120 exposes no native constructor, bind issuer, locator, or protected identity", async () => {
  const exportedNames = Object.keys(physicalDriverModule).join("\n");
  assert.doesNotMatch(exportedNames, /createUnwiredNodeNetPort|nativeBindCapabilities|issue.*capability/i);
  const { driver } = buildDriver("closed_verified", "127.0.0.1:65123-owner-peer-host-key");
  await driver.prepare();
  const status = await driver.start();
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized,
    /127\.0\.0\.1|65123|owner-peer-host-key|listenerId|endpointIdentityDigest|channelIdentityDigest|credential/i);
  assert.equal(status.listenerAttemptsMade, 0);
  assert.equal(status.networkIoEventsObserved, 0);
});

test("CR13A allowlists only the isolated node:net server modules with no runtime consumer", async () => {
  const implementationPath = resolve(
    "src/connection-registry/v1/private-loopback-physical-native-driver.ts");
  const retainedIssuerImplementationPath = resolve(
    "src/connection-registry/v1/private-loopback-native-retained-resource-issuer-implementation.ts");
  const implementationSource = await readFile(implementationPath, "utf8");
  assert.match(implementationSource, /from "node:net"/);
  assert.match(implementationSource, /createServer as createNodeNetServerV1/);
  assert.match(implementationSource, /host: literalIpv4LoopbackV1/);
  assert.match(implementationSource, /exclusive: true/);
  assert.match(implementationSource, /backlog: 1/);
  assert.match(implementationSource, /void createUnwiredNodeNetPortV1/);
  assert.doesNotMatch(implementationSource, /export\s+(?:async\s+)?function\s+createUnwiredNodeNetPortV1/);
  assert.doesNotMatch(implementationSource, /weakMapSetV1,\s*nativeBindCapabilitiesV1/);
  assert.doesNotMatch(implementationSource, /nativeBindCapabilitiesV1\.set\s*\(/);
  assert.match(implementationSource, /nativeConnectionAdmissionsV1/);
  assert.doesNotMatch(implementationSource, /weakMapSetV1,\s*nativeConnectionAdmissionsV1/);
  assert.doesNotMatch(implementationSource, /nativeConnectionAdmissionsV1\.set\s*\(/);
  assert.doesNotMatch(implementationSource, /node:(?:tls|http|https|dgram|child_process)/);
  assert.doesNotMatch(implementationSource, /fetch\s*\(|WebSocket|ssh2|process\.env|process\.on\s*\(/i);

  const nativeBackendSource = implementationSource.slice(implementationSource.indexOf("type NativeBindCapabilityStateV1"));
  assert.match(nativeBackendSource, /capability\.contract !== exactContract/);
  assert.match(nativeBackendSource, /capability\.implementation !== exactImplementation/);
  assert.match(nativeBackendSource, /admission\.tunnelPeerProof !== capability\.tunnelPeerProof/);
  assert.match(nativeBackendSource, /admission\.hostKeyCustodyProof !== capability\.hostKeyCustodyProof/);
  assert.match(nativeBackendSource, /admission\.admissionDeadlineMs !== capability\.admissionDeadlineMs/);
  assert.match(nativeBackendSource, /admission\.spent = true/);
  assert.match(nativeBackendSource, /reflectApplyV1\(frameDecoderPushV1, activeDecoder/);
  assert.match(nativeBackendSource, /reflectApplyV1\(frameDecoderFinishV1, activeDecoder/);
  assert.match(nativeBackendSource, /reflectApplyV1\(frameDecoderCloseV1, activeDecoder/);
  assert.doesNotMatch(nativeBackendSource, /decoder\.(?:push|finish|close)\s*\(/);
  assert.match(nativeBackendSource, /pendingBufferedBytes <= capability\.backpressureLowWaterBytes/);
  assert.doesNotMatch(nativeBackendSource, /backpressureLowWaterBytes >= 0/);
  assert.match(nativeBackendSource, /capability\.drainDeadlineMs/);
  assert.match(nativeBackendSource, /capability\.shutdownDeadlineMs/);
  assert.match(nativeBackendSource, /no signer, durable attempt ledger, high-water checkpoint/);
  assert.match(nativeBackendSource, /disposition = "cleanup_failed"/);
  assert.doesNotMatch(nativeBackendSource, /\? "closed_verified"/);
  assert.doesNotMatch(nativeBackendSource, /tunnelPeerAuthenticated|hostKeyCustodyProven|platformSignerTrustAccepted/);

  const connectionRegistryFiles = await sourceFiles(resolve("src/connection-registry/v1"));
  const runtimeNetImporters: string[] = [];
  const typeOnlyNetImporters: string[] = [];
  for (const file of connectionRegistryFiles) {
    const source = await readFile(file, "utf8");
    const withoutTypeOnlyNetImport = source.replace(/^import\s+type[^\n]*from ["']node:net["'];\n?/gm, "");
    if (/from ["']node:net["']/.test(withoutTypeOnlyNetImport)) runtimeNetImporters.push(file);
    if (/^import\s+type[^\n]*from ["']node:net["'];/m.test(source)) typeOnlyNetImporters.push(file);
  }
  assert.deepEqual(runtimeNetImporters.sort(), [implementationPath, retainedIssuerImplementationPath].sort());
  assert.deepEqual(typeOnlyNetImporters, [
    resolve("src/connection-registry/v1/private-loopback-native-retained-resource-adapter.ts"),
  ]);

  const allSourceFiles = await sourceFiles(resolve("src"));
  const nativeServerAuthorityFiles: string[] = [];
  for (const file of allSourceFiles) {
    const source = await readFile(file, "utf8");
    // E62's TLS service owns an HTTPS server, not a net server. Exclude only its
    // exact pure address validator/type import; any additional net import still
    // enters the original inventory and fails its unchanged two-owner limit.
    let serverSource = source;
    if (file === resolve("src/web/v1/native-https-service.ts")) {
      const addressImport = /^import \{ isIP, type Socket \} from "node:net";$/m;
      assert.match(source, addressImport);
      assert.match(source, /import \{ createServer, type Server \} from "node:https"/);
      serverSource = source.replace(addressImport, "");
    }
    if (/from ["']node:net["']/.test(serverSource) && /\bcreateServer\b|\.listen\s*\(/.test(serverSource)) {
      nativeServerAuthorityFiles.push(file);
    }
    if (file !== implementationPath) {
      assert.doesNotMatch(source, /private-loopback-physical-native-driver/);
    }
  }
  assert.deepEqual(nativeServerAuthorityFiles.sort(), [implementationPath, retainedIssuerImplementationPath].sort());
  const barrel = await readFile(resolve("src/connection-registry/v1/index.ts"), "utf8");
  const localPilot = await readFile(resolve("src/local-pilot/v1/runtime.ts"), "utf8");
  assert.doesNotMatch(barrel, /physical-native-driver/);
  assert.doesNotMatch(localPilot, /physical-native-driver|createUnwiredNodeNetPort|node:net/);
  assert.match(localPilot, /new DisabledConnectionEnrollmentPrivateLoopbackListenerV1\(\)/);
});

test("CR13A-LIVE-120 fixed sets are frozen and cannot be widened", () => {
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATES_V1), true);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_FAKE_SCENARIOS_V1), true);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATES_V1, [
    "created", "prepared", "starting", "listening", "draining", "closed", "failed_before_bind",
    "ambiguous_after_marker", "cleanup_failed", "recovery_checked",
  ]);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_FAKE_SCENARIOS_V1, [
    "closed_verified", "failed_before_bind", "ambiguous_after_marker", "cleanup_failed",
  ]);
  assert.throws(() => Object.defineProperty(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATES_V1,
    "10", { value: "restarting" }), TypeError);
});
