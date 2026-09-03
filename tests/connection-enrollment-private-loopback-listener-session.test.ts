import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { TextEncoder } from "node:util";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_SESSION_V1,
  CONNECTION_ENROLLMENT_TRANSPORT_ADMISSION_RECEIPT_V1,
  ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1,
  ConnectionEnrollmentPrivateLoopbackListenerSessionV1,
  ConnectionEnrollmentTransportAdmissionErrorV1,
  createConnectionEnrollmentPrivateLoopbackListenerPlanV1,
  parseConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1,
  parseConnectionEnrollmentTransportAdmissionReceiptV1,
  type ConnectionEnrollmentTransportAdmissionPortV1,
  type ConnectionEnrollmentTransportAdmissionReceiptV1,
} from "../src/connection-registry/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const digest = (label: string) => sha256Digest({ label });
const receivedAt = "2026-09-03T15:00:00.000Z";

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    listenerId: "private-loopback-listener:session-fixture-001",
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

function enrollmentFrame() {
  return {
    protocol: "control-room-node/v1",
    direction: "node_to_server",
    messageId: "message:listener-session:001",
    correlationId: "correlation:listener-session:001",
    tenantId: "tenant:fixture",
    actorId: "node:fixture",
    senderKind: "node",
    keyId: "key:fixture",
    connectionId: "connection:fixture",
    sequence: 2,
    sentAt: "2026-09-03T15:00:00.000Z",
    expiresAt: "2026-09-03T15:01:00.000Z",
    nonce: "nonce_listener_session_fixture_001",
    bodyDigest: digest("body"),
    signature: "signature_listener_session_fixture_001",
    type: "connection.enrollment.deliver",
    body: {
      deliveryId: "delivery:listener-session:001",
      enrollmentContract: "control-room-idea-lab-hermes-021-connection-enrollment/v1",
      envelopeDigest: digest("envelope"),
      envelope: { fixture: true },
    },
  };
}

function packetFor(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const packet = new Uint8Array(payload.byteLength + 4);
  packet[0] = (payload.byteLength >>> 24) & 0xff;
  packet[1] = (payload.byteLength >>> 16) & 0xff;
  packet[2] = (payload.byteLength >>> 8) & 0xff;
  packet[3] = payload.byteLength & 0xff;
  packet.set(payload, 4);
  return packet;
}

function admissionReceipt(plan: ReturnType<typeof createConnectionEnrollmentPrivateLoopbackListenerPlanV1>,
  overrides: Record<string, unknown> = {}): ConnectionEnrollmentTransportAdmissionReceiptV1 {
  const material = {
    contractVersion: CONNECTION_ENROLLMENT_TRANSPORT_ADMISSION_RECEIPT_V1,
    admissionReference: "transport-admission-reference:0123456789abcdef01234567",
    admissionPolicyDigest: digest("admission-policy"),
    transport: "ssh_tunnel" as const,
    listenerVisibility: "private_loopback" as const,
    channelIdentityDigest: plan.channelIdentityDigest,
    maximumFrameBytes: plan.maximumFrameBytes,
    ingressReference: "ingress:0123456789abcdef01234567",
    ingressReceiptDigest: digest("ingress-receipt"),
    protocolFrameDigest: digest("protocol-frame"),
    deliveryEvidenceDigest: digest("delivery-evidence"),
    enrollmentResultDigest: digest("enrollment-result"),
    registryRevision: 1,
    receivedAt,
    protocolDisposition: "accepted" as const,
    ledgerDisposition: "accepted" as const,
    enrollmentDisposition: "accepted" as const,
    opensListener: false as const,
    performsNetworkIo: false as const,
    grantsApproval: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
    ...overrides,
  };
  return parseConnectionEnrollmentTransportAdmissionReceiptV1({ ...material,
    receiptDigest: sha256Digest(material) });
}

class FixedAdmission implements ConnectionEnrollmentTransportAdmissionPortV1 {
  readonly inputs: unknown[] = [];
  constructor(readonly value: ConnectionEnrollmentTransportAdmissionReceiptV1, readonly failure?: unknown) {}
  async admit(input: unknown): Promise<ConnectionEnrollmentTransportAdmissionReceiptV1> {
    this.inputs.push(input);
    if (this.failure !== undefined) throw this.failure;
    return this.value;
  }
}

function observations(plan: ReturnType<typeof createConnectionEnrollmentPrivateLoopbackListenerPlanV1>) {
  const base = { listenerId: plan.listenerId, planDigest: plan.planDigest,
    evidenceMode: "repository_fake" as const, nativeEvidenceAccepted: false as const };
  return {
    bind: { ...base, sequence: 1, observedAddress: "127.0.0.1", observedAddressFamily: "ipv4",
      endpointIdentityDigest: plan.endpointIdentityDigest, ownerIdentityDigest: plan.ownerIdentityDigest,
      simulatedExclusiveOwnership: true },
    open: { ...base, sequence: 2, activeConnections: 1, queuedConnections: 0,
      tunnelPeerIdentityDigest: plan.tunnelPeerIdentityDigest, tunnelHostKeyDigest: plan.tunnelHostKeyDigest,
      channelIdentityDigest: plan.channelIdentityDigest, simulatedTunnelAuthenticated: true },
    frame: { ...base, sequence: 3, activeConnections: 1, queuedConnections: 0,
      connectionAgeMs: 200, idleAgeMs: 20, frameChunks: 1 },
    connectionClose: { ...base, sequence: 4, activeConnections: 0, queuedConnections: 0,
      connectionAgeMs: 250 },
    drain: { ...base, sequence: 5, activeConnections: 0, queuedConnections: 0, shutdownElapsedMs: 10,
      automaticRestartAttempted: false },
    listenerClose: { ...base, sequence: 6, activeConnections: 0, queuedConnections: 0, shutdownElapsedMs: 20,
      simulatedCleanupConfirmed: true },
  };
}

function createSession(admissionValue?: ConnectionEnrollmentTransportAdmissionReceiptV1,
  failure?: unknown) {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(configuration());
  const admission = new FixedAdmission(admissionValue ?? admissionReceipt(plan), failure);
  return { plan, admission, session: new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(plan, admission),
    input: observations(plan), packet: packetFor(enrollmentFrame()) };
}

async function completeSession(value = createSession()) {
  const { session, input, packet } = value;
  session.observeBind(input.bind);
  session.observeConnectionOpen(input.open);
  session.pushFrameChunk(packet);
  await session.completeFrameAndAdmit(input.frame);
  session.observeConnectionClose(input.connectionClose);
  session.observeDrainStart(input.drain);
  session.observeListenerClose(input.listenerClose);
  return { ...value, receipt: session.finish() };
}

function expectCode(action: () => unknown,
  code: ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1 && error.safeCode === code);
}

async function expectRejection(action: () => Promise<unknown>,
  code: ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1["safeCode"]): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1 && error.safeCode === code);
}

test("CR13A-LIVE-090 composes one bounded frame with one admission and mandatory cleanup", async () => {
  const { plan, admission, session, receipt } = await completeSession();
  assert.equal(receipt.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_SESSION_V1);
  assert.equal(receipt.listenerPlanDigest, plan.planDigest);
  assert.equal(receipt.frameChunks, 1);
  assert.match(receipt.protectedFrameDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.admissionInputDigest, sha256Digest(admission.inputs[0]));
  assert.deepEqual([receipt.listenerEventCount, receipt.admissionCompleted, receipt.enrollmentDisposition,
    receipt.nativeListenerQualified, receipt.actualBindObserved, receipt.exclusivePortOwnershipProven,
    receipt.tunnelPeerAuthenticated, receipt.hostKeyCustodyProven, receipt.nativeCleanupEvidenceAccepted,
    receipt.listenerEnabled, receipt.opensListener, receipt.performsNetworkIo],
  [6, true, "accepted", false, false, false, false, false, false, false, false, false]);
  assert.deepEqual([receipt.grantsApproval, receipt.grantsNetworkAuthority, receipt.grantsCommandAuthority,
    receipt.grantsLeaseAuthority, receipt.grantsExecutionAuthority], [false, false, false, false, false]);
  assert.equal(admission.inputs.length, 1);
  assert.deepEqual(admission.inputs[0], {
    rawFrame: JSON.stringify(enrollmentFrame()),
    deliveryId: "delivery:listener-session:001",
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(parseConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1(receipt), receipt);
  assert.doesNotMatch(JSON.stringify(receipt), /rawFrame|signature_listener|127\.0\.0\.1|host-key/i);
  expectCode(() => session.finish(), "state_conflict");
});

test("CR13A-LIVE-090 enforces sequencing and makes frame or observation failure terminal", async () => {
  const early = createSession();
  expectCode(() => early.session.pushFrameChunk(early.packet), "state_conflict");
  expectCode(() => early.session.observeBind(early.input.bind), "state_conflict");

  const malformed = createSession();
  malformed.session.observeBind(malformed.input.bind);
  malformed.session.observeConnectionOpen(malformed.input.open);
  malformed.session.pushFrameChunk(malformed.packet.slice(0, 5));
  await expectRejection(() => malformed.session.completeFrameAndAdmit(malformed.input.frame), "frame_rejected");
  expectCode(() => malformed.session.observeConnectionClose(malformed.input.connectionClose), "state_conflict");

  let reads = 0;
  const behavioral = createSession();
  behavioral.session.observeBind(behavioral.input.bind);
  behavioral.session.observeConnectionOpen(behavioral.input.open);
  behavioral.session.pushFrameChunk(behavioral.packet);
  const observation = { ...behavioral.input.frame };
  Object.defineProperty(observation, "connectionAgeMs", {
    enumerable: true,
    get() { reads += 1; return 200; },
  });
  await expectRejection(() => behavioral.session.completeFrameAndAdmit(observation), "invalid_observation");
  assert.equal(reads, 0);
  expectCode(() => behavioral.session.finish(), "incomplete_session");

  const chunkDrift = createSession();
  chunkDrift.session.observeBind(chunkDrift.input.bind);
  chunkDrift.session.observeConnectionOpen(chunkDrift.input.open);
  chunkDrift.session.pushFrameChunk(chunkDrift.packet.slice(0, 4));
  chunkDrift.session.pushFrameChunk(chunkDrift.packet.slice(4));
  await expectRejection(() => chunkDrift.session.completeFrameAndAdmit(chunkDrift.input.frame),
    "invalid_observation");
  assert.equal(chunkDrift.admission.inputs.length, 0);
});

test("CR13A-LIVE-090 rejects admission failure, foreign thenables, and policy mismatch", async () => {
  const rejectedPlan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(configuration());
  const rejected = createSession(undefined, new ConnectionEnrollmentTransportAdmissionErrorV1("disabled"));
  rejected.session.observeBind(rejected.input.bind); rejected.session.observeConnectionOpen(rejected.input.open);
  rejected.session.pushFrameChunk(rejected.packet);
  await expectRejection(() => rejected.session.completeFrameAndAdmit(rejected.input.frame), "admission_rejected");

  let thenReads = 0;
  const thenable = {};
  Object.defineProperty(thenable, "then", {
    get() { thenReads += 1; throw new Error("must remain unread"); },
  });
  const foreignAdmission = { admit() { return thenable as Promise<ConnectionEnrollmentTransportAdmissionReceiptV1>; } };
  const foreign = new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(rejectedPlan, foreignAdmission);
  const input = observations(rejectedPlan), packet = packetFor(enrollmentFrame());
  foreign.observeBind(input.bind); foreign.observeConnectionOpen(input.open); foreign.pushFrameChunk(packet);
  await expectRejection(() => foreign.completeFrameAndAdmit(input.frame), "integrity_failed");
  assert.equal(thenReads, 0);

  for (const changed of [
    { channelIdentityDigest: digest("different-channel") },
    { maximumFrameBytes: 8_192 },
  ]) {
    const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(configuration());
    const sessionValue = createSession(admissionReceipt(plan, changed));
    sessionValue.session.observeBind(sessionValue.input.bind);
    sessionValue.session.observeConnectionOpen(sessionValue.input.open);
    sessionValue.session.pushFrameChunk(sessionValue.packet);
    await expectRejection(() => sessionValue.session.completeFrameAndAdmit(sessionValue.input.frame),
      "admission_mismatch");
    assert.equal(sessionValue.admission.inputs.length, 1);
    expectCode(() => sessionValue.session.finish(), "incomplete_session");
  }
});

test("CR13A-LIVE-090 captures an inert admission method and observes malformed native rejection", async () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(configuration());
  let traps = 0;
  expectCode(() => new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(plan, new Proxy({
    async admit() { return admissionReceipt(plan); },
  }, {
    get() { traps += 1; throw new Error("must remain inert"); },
  })), "invalid_configuration");
  const accessorAdmission = {};
  Object.defineProperty(accessorAdmission, "admit", {
    get() { traps += 1; throw new Error("must remain inert"); },
  });
  expectCode(() => new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(plan,
    accessorAdmission as ConnectionEnrollmentTransportAdmissionPortV1), "invalid_configuration");
  assert.equal(traps, 0);

  const protectedFailure = Object.freeze({ privateValue: "must-not-escape" });
  const malformed = Promise.reject(protectedFailure);
  let instrumentationReads = 0;
  Object.defineProperty(malformed, "instrumentation", {
    get() { instrumentationReads += 1; throw new Error("must remain inert"); },
  });
  const admission = {
    admit() { return malformed as Promise<ConnectionEnrollmentTransportAdmissionReceiptV1>; },
  };
  const session = new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(plan, admission);
  const input = observations(plan);
  session.observeBind(input.bind); session.observeConnectionOpen(input.open);
  session.pushFrameChunk(packetFor(enrollmentFrame()));
  const escaped: unknown[] = [];
  const listener = (value: unknown) => { escaped.push(value); };
  process.on("unhandledRejection", listener);
  try {
    await expectRejection(() => session.completeFrameAndAdmit(input.frame), "integrity_failed");
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    assert.deepEqual(escaped, []);
    assert.equal(instrumentationReads, 0);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("CR13A-LIVE-090 contains constructor-decorated native rejection under strict process policy", async () => {
  if (process.env.CR13A_LIVE_090_STRICT_PROMISE_CHILD !== "1") {
    const completed = spawnSync(process.execPath, [
      "--unhandled-rejections=strict",
      "--import",
      "tsx",
      "--test",
      "--test-name-pattern",
      "CR13A-LIVE-090 contains constructor-decorated native rejection under strict process policy",
      "tests/connection-enrollment-private-loopback-listener-session.test.ts",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CR13A_LIVE_090_STRICT_PROMISE_CHILD: "1", NODE_OPTIONS: "" },
    });
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(completed.signal, null);
    return;
  }

  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(configuration());
  const protectedFailure = Object.freeze({ privateValue: "must-not-escape" });
  const malformed = Promise.reject(protectedFailure);
  Object.defineProperty(malformed, "constructor", {
    configurable: true,
    enumerable: false,
    value: Promise,
    writable: false,
  });
  const session = new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(plan, {
    admit() { return malformed as Promise<ConnectionEnrollmentTransportAdmissionReceiptV1>; },
  });
  const input = observations(plan);
  session.observeBind(input.bind);
  session.observeConnectionOpen(input.open);
  session.pushFrameChunk(packetFor(enrollmentFrame()));
  await expectRejection(() => session.completeFrameAndAdmit(input.frame), "integrity_failed");
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
});

test("CR13A-LIVE-090 leaves behavioral Promise constructors inert", async () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(configuration());
  const malformed = Promise.reject(new Error("already observed test rejection"));
  Reflect.apply(Promise.prototype.then, malformed, [undefined, () => undefined]);
  let constructorReads = 0;
  Object.defineProperty(malformed, "constructor", {
    configurable: true,
    get() { constructorReads += 1; throw new Error("must remain inert"); },
  });
  const session = new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(plan, {
    admit() { return malformed as Promise<ConnectionEnrollmentTransportAdmissionReceiptV1>; },
  });
  const input = observations(plan);
  session.observeBind(input.bind);
  session.observeConnectionOpen(input.open);
  session.pushFrameChunk(packetFor(enrollmentFrame()));
  await expectRejection(() => session.completeFrameAndAdmit(input.frame), "integrity_failed");
  assert.equal(constructorReads, 0);
});

test("CR13A-LIVE-090 requires admission before close and complete cleanup before finish", async () => {
  const noAdmission = createSession();
  noAdmission.session.observeBind(noAdmission.input.bind);
  noAdmission.session.observeConnectionOpen(noAdmission.input.open);
  expectCode(() => noAdmission.session.observeConnectionClose(noAdmission.input.connectionClose), "state_conflict");

  const incomplete = createSession();
  incomplete.session.observeBind(incomplete.input.bind); incomplete.session.observeConnectionOpen(incomplete.input.open);
  incomplete.session.pushFrameChunk(incomplete.packet);
  await incomplete.session.completeFrameAndAdmit(incomplete.input.frame);
  expectCode(() => incomplete.session.finish(), "incomplete_session");

  const aborted = createSession();
  aborted.session.abort();
  expectCode(() => aborted.session.observeBind(aborted.input.bind), "state_conflict");
});

test("CR13A-LIVE-090 serializes admission and cannot interrupt a pending admission", async () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(configuration());
  let settle: ((value: ConnectionEnrollmentTransportAdmissionReceiptV1) => void) | undefined;
  const deferred = new Promise<ConnectionEnrollmentTransportAdmissionReceiptV1>((resolvePromise) => {
    settle = resolvePromise;
  });
  let calls = 0;
  const admission = {
    admit() { calls += 1; return deferred; },
  };
  const session = new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(plan, admission);
  const input = observations(plan);
  session.observeBind(input.bind); session.observeConnectionOpen(input.open);
  session.pushFrameChunk(packetFor(enrollmentFrame()));
  const pending = session.completeFrameAndAdmit(input.frame);
  await Promise.resolve();
  expectCode(() => session.observeConnectionClose(input.connectionClose), "state_conflict");
  expectCode(() => session.abort(), "state_conflict");
  expectCode(() => session.finish(), "state_conflict");
  settle?.(admissionReceipt(plan));
  await pending;
  assert.equal(calls, 1);
  session.observeConnectionClose(input.connectionClose);
  session.observeDrainStart(input.drain);
  session.observeListenerClose(input.listenerClose);
  const receipt = session.finish();
  assert.equal(receipt.admissionCompleted, true);
  assert.equal(receipt.listenerEventCount, 6);
  assert.equal(calls, 1);

  let release: ((value: ConnectionEnrollmentTransportAdmissionReceiptV1) => void) | undefined;
  const secondDeferred = new Promise<ConnectionEnrollmentTransportAdmissionReceiptV1>((resolvePromise) => {
    release = resolvePromise;
  });
  const second = new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(plan, {
    admit() { return secondDeferred; },
  });
  second.observeBind(input.bind); second.observeConnectionOpen(input.open);
  second.pushFrameChunk(packetFor(enrollmentFrame()));
  const firstAttempt = second.completeFrameAndAdmit(input.frame);
  await Promise.resolve();
  await expectRejection(() => second.completeFrameAndAdmit(input.frame), "state_conflict");
  release?.(admissionReceipt(plan));
  await firstAttempt;
});

test("CR13A-LIVE-090 finish cannot interrupt synchronous admission reentry", async () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(configuration());
  const input = observations(plan);
  let calls = 0;
  const sessionHolder: { current?: ConnectionEnrollmentPrivateLoopbackListenerSessionV1 } = {};
  const admission = {
    admit() {
      calls += 1;
      const current = sessionHolder.current;
      assert.ok(current);
      expectCode(() => current.finish(), "state_conflict");
      return Promise.resolve(admissionReceipt(plan));
    },
  };
  const session = new ConnectionEnrollmentPrivateLoopbackListenerSessionV1(plan, admission);
  sessionHolder.current = session;
  session.observeBind(input.bind);
  session.observeConnectionOpen(input.open);
  session.pushFrameChunk(packetFor(enrollmentFrame()));
  await session.completeFrameAndAdmit(input.frame);
  assert.equal(calls, 1);
  session.observeConnectionClose(input.connectionClose);
  session.observeDrainStart(input.drain);
  session.observeListenerClose(input.listenerClose);
  const receipt = session.finish();
  assert.equal(receipt.admissionCompleted, true);
  assert.equal(receipt.listenerEventCount, 6);
  assert.equal(calls, 1);
});

test("CR13A-LIVE-090 session receipt rejects drift, behavior, and recomputed native claims", async () => {
  const { receipt } = await completeSession();
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  void _receiptDigest;
  const changedReference = { ...unsigned, sessionReference: `listener-session:${"f".repeat(24)}` };
  const forgedNative = { ...unsigned, nativeListenerQualified: true };
  const overlongListener = { ...unsigned,
    listenerId: `private-loopback-listener:${"a".repeat(135)}` };
  for (const invalid of [
    { ...receipt, extra: true },
    { ...changedReference, receiptDigest: sha256Digest(changedReference) },
    { ...forgedNative, receiptDigest: sha256Digest(forgedNative) },
    { ...overlongListener, receiptDigest: sha256Digest(overlongListener) },
  ]) expectCode(() => parseConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1(invalid),
    "integrity_failed");

  let traps = 0;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1(new Proxy(receipt, {
    get() { traps += 1; throw new Error("must remain inert"); },
  })), "integrity_failed");
  assert.equal(traps, 0);
});

test("CR13A-LIVE-090 adds no listener, socket, SSH, route, or runtime enablement", async () => {
  const source = await readFile(resolve("src/connection-registry/v1/private-loopback-listener-session.ts"), "utf8");
  assert.doesNotMatch(source, /from ["']node:(?:net|tls|http|https|child_process|dgram)["']/);
  assert.doesNotMatch(source, /\.listen\s*\(|\.connect\s*\(|createServer\s*\(|spawn\s*\(|exec\s*\(/);
  assert.doesNotMatch(source, /ssh2|fetch\s*\(|WebSocket/i);
  assert.doesNotMatch(source, /app\/api|route\.ts|local-pilot/i);
  assert.match(source, /nativeListenerQualified: false/);
  assert.match(source, /opensListener: false/);
  assert.match(source, /performsNetworkIo: false/);
});
