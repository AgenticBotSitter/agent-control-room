import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_ADAPTER_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_READINESS_V1,
  ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1,
  DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1,
  bindDefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1,
  createConnectionEnrollmentPrivateLoopbackListenerPlanV1,
  createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1,
  parseConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1,
} from "../src/connection-registry/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const digest = (label: string) => sha256Digest({ label });

function planConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    listenerId: "private-loopback-listener:native-adapter-fixture-001",
    endpointIdentityDigest: digest("endpoint"),
    ownerIdentityDigest: digest("owner"),
    tunnelPeerIdentityDigest: digest("peer"),
    tunnelHostKeyDigest: digest("host-key"),
    channelIdentityDigest: digest("channel"),
    maximumFrameBytes: 4_096,
    maximumChunks: 32,
    maximumConnectionDurationMs: 30_000,
    idleTimeoutMs: 5_000,
    shutdownGraceMs: 2_000,
    ...overrides,
  };
}

function expectCode(action: () => unknown,
  code: ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1 && error.safeCode === code);
}

async function expectRejection(action: () => Promise<unknown>,
  code: ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1["safeCode"]): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1 && error.safeCode === code);
}

test("CR13A-LIVE-100 freezes one plan-bound, default-disabled native-listener readiness", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const readiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(plan);
  assert.equal(readiness.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_READINESS_V1);
  assert.equal(readiness.adapterContract, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_ADAPTER_V1);
  assert.equal(readiness.listenerReference,
    `native-listener:${sha256Digest({ listenerId: plan.listenerId, listenerPlanDigest: plan.planDigest }).slice(7, 31)}`);
  assert.equal(readiness.listenerPlanDigest, plan.planDigest);
  assert.equal(readiness.readinessReference, `native-listener-readiness:${plan.planDigest.slice(7, 31)}`);
  assert.deepEqual({ transport: readiness.transport, visibility: readiness.listenerVisibility,
    bind: readiness.bindPolicy, port: readiness.portPolicy, concurrent: readiness.maximumConcurrentConnections,
    queued: readiness.maximumQueuedConnections, oneFrame: readiness.oneFramePerConnection,
    restart: readiness.automaticRestartAllowed }, {
    transport: "ssh_tunnel", visibility: "private_loopback", bind: "literal_ipv4_loopback_only",
    port: "private_and_unpublished", concurrent: 1, queued: 0, oneFrame: true, restart: false,
  });
  assert.deepEqual(readiness.blockerCodes, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1);
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(Object.isFrozen(readiness.blockerCodes), true);
  assert.deepEqual(parseConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(readiness), readiness);
});

test("CR13A-LIVE-100 keeps all native, effect, retry, and authority truth false", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const readiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(plan);
  assert.deepEqual([
    readiness.nativeDriverAccepted,
    readiness.ownerActivationAccepted,
    readiness.platformQualificationAccepted,
    readiness.exclusivePortOwnershipProven,
    readiness.tunnelPeerAuthenticated,
    readiness.hostKeyCustodyProven,
    readiness.connectionDeadlineProven,
    readiness.idleDeadlineProven,
    readiness.admissionDeadlineProven,
    readiness.backpressureProven,
    readiness.shutdownCleanupProven,
    readiness.processRecoveryProven,
    readiness.activationEligible,
    readiness.listenerEnabled,
    readiness.automaticRetryAllowed,
    readiness.opensListener,
    readiness.performsNetworkIo,
    readiness.grantsApproval,
    readiness.grantsNetworkAuthority,
    readiness.grantsCommandAuthority,
    readiness.grantsLeaseAuthority,
    readiness.grantsExecutionAuthority,
  ], new Array(22).fill(false));
  assert.equal(readiness.listenerAttemptsMade, 0);
  assert.equal(readiness.networkIoEventsObserved, 0);
  assert.equal(readiness.status, "blocked_before_native_listener");
  const serialized = JSON.stringify(readiness);
  assert.doesNotMatch(serialized, /127\.0\.0\.1|endpointIdentity|ownerIdentity|tunnelPeerIdentity|channelIdentity/i);
});

test("CR13A-LIVE-100 accepts only module-created readiness and rejects re-digested identity substitution", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const readiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(plan);
  const { readinessDigest: _readinessDigest, ...unsigned } = readiness;
  void _readinessDigest;
  const forgedActivation = { ...unsigned, nativeDriverAccepted: true, ownerActivationAccepted: true,
    platformQualificationAccepted: true, activationEligible: true, listenerEnabled: true,
    opensListener: true, performsNetworkIo: true };
  const substitutedListener = { ...unsigned,
    listenerReference: `native-listener:${"a".repeat(24)}` };
  const substitutedPlan = { ...unsigned, listenerPlanDigest: digest("other-plan"),
    readinessReference: `native-listener-readiness:${digest("other-plan").slice(7, 31)}` };
  for (const invalid of [
    { ...readiness },
    { ...readiness, extra: true },
    { ...readiness, listenerPlanDigest: digest("other-plan") },
    { ...readiness, blockerCodes: readiness.blockerCodes.slice(1) },
    { ...readiness, blockerCodes: [...readiness.blockerCodes].reverse() },
    { ...forgedActivation, readinessDigest: sha256Digest(forgedActivation) },
    { ...substitutedListener, readinessDigest: sha256Digest(substitutedListener) },
    { ...substitutedPlan, readinessDigest: sha256Digest(substitutedPlan) },
  ]) expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(invalid),
    "invalid_readiness");
});

test("CR13A-LIVE-100 never retains locator-shaped listener IDs in public readiness", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration({
    listenerId: "private-loopback-listener:127.0.0.1:3000",
  }));
  const readiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(plan);
  assert.match(readiness.listenerReference, /^native-listener:[a-f0-9]{24}$/);
  const serialized = JSON.stringify(readiness);
  assert.doesNotMatch(serialized, /127\.0\.0\.1|3000/);
  assert.equal("listenerId" in readiness, false);
});

test("CR13A-LIVE-100 leaves Proxy, accessor, and nested-array behavior inert", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const readiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(plan);
  let traps = 0;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(new Proxy(readiness, {
    get() { traps += 1; throw new Error("must remain inert"); },
  })), "invalid_readiness");
  assert.equal(traps, 0);

  const accessor = { ...readiness };
  Object.defineProperty(accessor, "activationEligible", {
    enumerable: true,
    get() { traps += 1; return false; },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(accessor),
    "invalid_readiness");
  assert.equal(traps, 0);

  const blockerProxy = new Proxy([...readiness.blockerCodes], {
    get() { traps += 1; throw new Error("must remain inert"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1({
    ...readiness, blockerCodes: blockerProxy,
  }), "invalid_readiness");
  assert.equal(traps, 0);

  expectCode(() => createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(new Proxy(plan, {
    get() { traps += 1; throw new Error("must remain inert"); },
  })), "invalid_configuration");
  assert.equal(traps, 0);
});

test("CR13A-LIVE-100 adapter remains disabled and close is harmless and repeatable", async () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const adapter = new DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1(plan);
  assert.equal(adapter.enabled, false);
  assert.deepEqual(adapter.status(), createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(plan));
  await expectRejection(() => adapter.start(), "disabled");
  await expectRejection(() => adapter.start(), "disabled");
  await adapter.close();
  await adapter.close();
  assert.equal(adapter.status().listenerAttemptsMade, 0);
  assert.equal(adapter.status().networkIoEventsObserved, 0);
});

test("CR13A-LIVE-100 exact-brands and freezes adapter and captured consumer operations", async () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const adapter = new DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1(plan);
  const prototype = DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1.prototype;
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.isFrozen(prototype), true);
  assert.equal(Object.isExtensible(adapter), false);
  assert.throws(() => Object.defineProperty(adapter, "enabled", { value: true }), TypeError);
  assert.throws(() => Object.defineProperty(adapter, "start", { value: async () => {} }), TypeError);
  assert.throws(() => Object.defineProperty(prototype, "start", { value: async () => {} }), TypeError);
  assert.throws(() => Object.setPrototypeOf(adapter, { start: async () => {} }), TypeError);

  class Subclass extends DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1 {}
  expectCode(() => new Subclass(plan), "invalid_configuration");
  expectCode(() => prototype.status.call({}), "integrity_failed");
  await expectRejection(() => prototype.start.call({}), "integrity_failed");
  await expectRejection(() => prototype.close.call({}), "integrity_failed");

  const bound = bindDefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1(adapter);
  assert.equal(Object.isFrozen(bound), true);
  assert.equal(bound.enabled, false);
  for (const operation of [bound.status, bound.start, bound.close]) {
    assert.equal(Object.isFrozen(operation), true);
    assert.equal(Object.isExtensible(operation), false);
    assert.throws(() => Object.defineProperty(operation, "call", { value: () => "replacement" }), TypeError);
    assert.throws(() => Object.defineProperty(operation, "prototype", { value: {} }), TypeError);
    assert.throws(() => Object.setPrototypeOf(operation, { call: () => "replacement" }), TypeError);
  }
  assert.deepEqual(bound.status(), adapter.status());
  const starts = await Promise.allSettled(Array.from({ length: 16 }, () => bound.start()));
  assert.equal(starts.every((result) => result.status === "rejected"
    && result.reason instanceof ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1
    && result.reason.safeCode === "disabled"), true);
  await bound.close();
  await bound.close();
  expectCode(() => bindDefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1({
    enabled: false, status: () => adapter.status(), start: () => adapter.start(), close: () => adapter.close(),
  }), "integrity_failed");
});

test("CR13A-LIVE-100 adds no native driver, listener call, route, or runtime activation", async () => {
  const source = await readFile(resolve(
    "src/connection-registry/v1/private-loopback-native-listener-adapter.ts"), "utf8");
  const runtime = await readFile(resolve("src/local-pilot/v1/runtime.ts"), "utf8");
  assert.doesNotMatch(source, /from ["']node:(?:net|tls|http|https|child_process|dgram)["']/);
  assert.doesNotMatch(source, /\.listen\s*\(|\.connect\s*\(|createServer\s*\(|spawn\s*\(|exec\s*\(/);
  assert.doesNotMatch(source, /ssh2|fetch\s*\(|WebSocket/i);
  assert.doesNotMatch(source, /app\/api|route\.ts|local-pilot/i);
  assert.match(source, /activationMode: "disabled"/);
  assert.match(source, /listenerAttemptsMade: 0/);
  assert.match(source, /networkIoEventsObserved: 0/);
  assert.match(runtime, /new DisabledConnectionEnrollmentPrivateLoopbackListenerV1\(\)/);
  assert.doesNotMatch(runtime, /DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1/);
});
