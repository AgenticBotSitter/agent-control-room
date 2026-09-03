import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { TextEncoder } from "node:util";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_PLAN_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_REHEARSAL_V1,
  ConnectionEnrollmentPrivateLoopbackFrameDecoderV1,
  ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1,
  ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1,
  createConnectionEnrollmentPrivateLoopbackListenerPlanV1,
  parseConnectionEnrollmentPrivateLoopbackListenerPlanV1,
  parseConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1,
} from "../src/connection-registry/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function planConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    listenerId: "private-loopback-listener:lifecycle-fixture-001",
    endpointIdentityDigest: digest("1"),
    ownerIdentityDigest: digest("2"),
    tunnelPeerIdentityDigest: digest("3"),
    tunnelHostKeyDigest: digest("4"),
    channelIdentityDigest: digest("5"),
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
    messageId: "message:listener-lifecycle:001",
    correlationId: "correlation:listener-lifecycle:001",
    tenantId: "tenant:fixture",
    actorId: "node:fixture",
    senderKind: "node",
    keyId: "key:fixture",
    connectionId: "connection:fixture",
    sequence: 2,
    sentAt: "2026-09-03T13:00:00.000Z",
    expiresAt: "2026-09-03T13:01:00.000Z",
    nonce: "nonce_listener_lifecycle_fixture_001",
    bodyDigest: digest("a"),
    signature: "signature_listener_lifecycle_fixture_001",
    type: "connection.enrollment.deliver",
    body: {
      deliveryId: "delivery:listener-lifecycle:001",
      enrollmentContract: "control-room-idea-lab-hermes-021-connection-enrollment/v1",
      envelopeDigest: digest("b"),
      envelope: { fixture: true },
    },
  };
}

function protectedFrame(listenerId = planConfiguration().listenerId as string) {
  const plan = planConfiguration();
  const raw = new TextEncoder().encode(JSON.stringify(enrollmentFrame()));
  const packet = new Uint8Array(raw.byteLength + 4);
  packet[0] = (raw.byteLength >>> 24) & 0xff;
  packet[1] = (raw.byteLength >>> 16) & 0xff;
  packet[2] = (raw.byteLength >>> 8) & 0xff;
  packet[3] = raw.byteLength & 0xff;
  packet.set(raw, 4);
  const decoder = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1({
    listenerId,
    transport: "ssh_tunnel",
    listenerVisibility: "private_loopback",
    addressFamily: "ipv4",
    bindAddress: "127.0.0.1",
    framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
    maximumFrameBytes: plan.maximumFrameBytes,
    maximumChunks: plan.maximumChunks,
  });
  decoder.push(packet);
  return decoder.finish();
}

function observations(plan: ReturnType<typeof createConnectionEnrollmentPrivateLoopbackListenerPlanV1>,
  frame = protectedFrame(plan.listenerId)) {
  const base = { listenerId: plan.listenerId, planDigest: plan.planDigest,
    evidenceMode: "repository_fake" as const, nativeEvidenceAccepted: false as const };
  return {
    bind: { ...base, sequence: 1, observedAddress: "127.0.0.1", observedAddressFamily: "ipv4",
      endpointIdentityDigest: plan.endpointIdentityDigest, ownerIdentityDigest: plan.ownerIdentityDigest,
      simulatedExclusiveOwnership: true },
    open: { ...base, sequence: 2, activeConnections: 1, queuedConnections: 0,
      tunnelPeerIdentityDigest: plan.tunnelPeerIdentityDigest, tunnelHostKeyDigest: plan.tunnelHostKeyDigest,
      channelIdentityDigest: plan.channelIdentityDigest, simulatedTunnelAuthenticated: true },
    frame: { ...base, sequence: 3, activeConnections: 1, queuedConnections: 0, connectionAgeMs: 200,
      idleAgeMs: 20, frameChunks: 1, protectedFrame: frame },
    connectionClose: { ...base, sequence: 4, activeConnections: 0, queuedConnections: 0,
      connectionAgeMs: 250 },
    drain: { ...base, sequence: 5, activeConnections: 0, queuedConnections: 0, shutdownElapsedMs: 10,
      automaticRestartAttempted: false },
    listenerClose: { ...base, sequence: 6, activeConnections: 0, queuedConnections: 0, shutdownElapsedMs: 20,
      simulatedCleanupConfirmed: true },
  };
}

function runRehearsal(overrides: Partial<ReturnType<typeof observations>> = {}) {
  return runRehearsalForConfiguration({}, overrides);
}

function runRehearsalForConfiguration(configurationOverrides: Record<string, unknown> = {},
  overrides: Partial<ReturnType<typeof observations>> = {}) {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration(configurationOverrides));
  const input = { ...observations(plan), ...overrides };
  const rehearsal = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  rehearsal.observeBind(input.bind);
  rehearsal.observeConnectionOpen(input.open);
  rehearsal.observeFrameComplete(input.frame);
  rehearsal.observeConnectionClose(input.connectionClose);
  rehearsal.observeDrainStart(input.drain);
  rehearsal.observeListenerClose(input.listenerClose);
  return { plan, receipt: rehearsal.finish(), rehearsal };
}

function expectCode(action: () => unknown,
  code: ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1 && error.safeCode === code);
}

test("CR13A-LIVE-080 freezes an exact disabled private-loopback listener plan", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  assert.equal(plan.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_PLAN_V1);
  assert.deepEqual({ transport: plan.transport, visibility: plan.listenerVisibility, family: plan.addressFamily,
    address: plan.bindAddress, framing: plan.framing, concurrent: plan.maximumConcurrentConnections,
    queued: plan.maximumQueuedConnections, oneFrame: plan.oneFramePerConnection,
    automaticRestart: plan.automaticRestartAllowed, effectMode: plan.effectMode }, {
    transport: "ssh_tunnel", visibility: "private_loopback", family: "ipv4", address: "127.0.0.1",
    framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1, concurrent: 1, queued: 0,
    oneFrame: true, automaticRestart: false, effectMode: "repository_fake_only",
  });
  assert.deepEqual([plan.opensListener, plan.performsNetworkIo, plan.grantsApproval, plan.grantsNetworkAuthority,
    plan.grantsCommandAuthority, plan.grantsLeaseAuthority, plan.grantsExecutionAuthority],
  [false, false, false, false, false, false, false]);
  assert.deepEqual(parseConnectionEnrollmentPrivateLoopbackListenerPlanV1(plan), plan);
  assert.equal(Object.isFrozen(plan), true);
});

test("CR13A-LIVE-080 rejects plan scope, identity, bounds, aliases, and behavior", () => {
  for (const invalid of [
    planConfiguration({ listenerId: "listener:short" }),
    planConfiguration({ endpointIdentityDigest: "?" }),
    planConfiguration({ ownerIdentityDigest: "?" }),
    planConfiguration({ tunnelPeerIdentityDigest: "?" }),
    planConfiguration({ tunnelHostKeyDigest: "?" }),
    planConfiguration({ channelIdentityDigest: "?" }),
    planConfiguration({ maximumFrameBytes: 4_095 }),
    planConfiguration({ maximumFrameBytes: 1_048_577 }),
    planConfiguration({ maximumChunks: 0 }),
    planConfiguration({ maximumConnectionDurationMs: 999 }),
    planConfiguration({ maximumConnectionDurationMs: 300_001 }),
    planConfiguration({ idleTimeoutMs: 30_001 }),
    planConfiguration({ shutdownGraceMs: 30_001 }),
    { ...planConfiguration(), bindAddress: "127.0.0.1" },
  ]) expectCode(() => createConnectionEnrollmentPrivateLoopbackListenerPlanV1(invalid), "invalid_configuration");

  let traps = 0;
  expectCode(() => createConnectionEnrollmentPrivateLoopbackListenerPlanV1(new Proxy(planConfiguration(), {
    get() { traps += 1; throw new Error("must remain inert"); },
  })), "invalid_configuration");
  assert.equal(traps, 0);

  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackListenerPlanV1({
    ...plan, maximumConnectionDurationMs: plan.maximumConnectionDurationMs + 1,
  }), "invalid_plan");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackListenerPlanV1({ ...plan, extra: true }), "invalid_plan");
  const accessorPlan = { ...plan };
  let accessorExecutions = 0;
  Object.defineProperty(accessorPlan, "bindAddress", {
    enumerable: true,
    get() { accessorExecutions += 1; return "127.0.0.1"; },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackListenerPlanV1(accessorPlan), "invalid_plan");
  assert.equal(accessorExecutions, 0);
});

test("CR13A-LIVE-080 completes one exact repository-fake lifecycle without claiming native truth", () => {
  const { plan, receipt, rehearsal } = runRehearsal();
  assert.equal(receipt.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_REHEARSAL_V1);
  assert.equal(receipt.planDigest, plan.planDigest);
  assert.deepEqual({ mode: receipt.evidenceMode, disposition: receipt.disposition, events: receipt.eventCount,
    chunks: receipt.frameChunks, active: receipt.maximumObservedConcurrentConnections,
    queued: receipt.maximumObservedQueuedConnections }, {
    mode: "repository_fake", disposition: "passed", events: 6, chunks: 1, active: 1, queued: 0,
  });
  assert.deepEqual([receipt.bindPolicyMatched, receipt.capacityPolicyMatched, receipt.tunnelPolicyMatched,
    receipt.framePolicyMatched, receipt.cleanupPolicyMatched], [true, true, true, true, true]);
  assert.deepEqual([receipt.actualBindObserved, receipt.exclusivePortOwnershipProven,
    receipt.tunnelPeerAuthenticated, receipt.hostKeyCustodyProven, receipt.nativeCleanupEvidenceAccepted,
    receipt.listenerEnabled, receipt.opensListener, receipt.performsNetworkIo],
  [false, false, false, false, false, false, false, false]);
  assert.doesNotMatch(JSON.stringify(receipt), /rawFrame|deliveryId|signature|127\.0\.0\.1/i);
  assert.deepEqual(parseConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1(receipt), receipt);
  expectCode(() => rehearsal.finish(), "state_conflict");
  expectCode(() => rehearsal.observeBind(observations(plan).bind), "state_conflict");
});

test("CR13A-LIVE-080 rejects bind and tunnel identity drift before frame handling", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const input = observations(plan);
  for (const bind of [
    { ...input.bind, observedAddress: "0.0.0.0" },
    { ...input.bind, observedAddress: "localhost" },
    { ...input.bind, observedAddressFamily: "ipv6" },
    { ...input.bind, endpointIdentityDigest: digest("e") },
    { ...input.bind, ownerIdentityDigest: digest("e") },
    { ...input.bind, simulatedExclusiveOwnership: false },
  ]) expectCode(() => new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan).observeBind(bind),
    "bind_identity_mismatch");

  for (const open of [
    { ...input.open, tunnelPeerIdentityDigest: digest("e") },
    { ...input.open, tunnelHostKeyDigest: digest("e") },
    { ...input.open, channelIdentityDigest: digest("e") },
    { ...input.open, simulatedTunnelAuthenticated: false },
  ]) {
    const rehearsal = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
    rehearsal.observeBind(input.bind);
    expectCode(() => rehearsal.observeConnectionOpen(open), "tunnel_identity_mismatch");
  }
});

test("CR13A-LIVE-080 enforces one connection, zero queue, and bounded lifetimes", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const input = observations(plan);
  for (const open of [{ ...input.open, activeConnections: 2 }, { ...input.open, queuedConnections: 1 }]) {
    const rehearsal = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
    rehearsal.observeBind(input.bind);
    expectCode(() => rehearsal.observeConnectionOpen(open), "capacity_exceeded");
  }
  for (const frame of [
    { ...input.frame, connectionAgeMs: plan.maximumConnectionDurationMs + 1 },
    { ...input.frame, idleAgeMs: plan.idleTimeoutMs + 1 },
    { ...input.frame, connectionAgeMs: 100, idleAgeMs: 101 },
  ]) {
    const rehearsal = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
    rehearsal.observeBind(input.bind); rehearsal.observeConnectionOpen(input.open);
    expectCode(() => rehearsal.observeFrameComplete(frame), "lifetime_exceeded");
  }
  for (const frame of [
    { ...input.frame, frameChunks: 0 },
    { ...input.frame, frameChunks: plan.maximumChunks + 1 },
  ]) {
    const rehearsal = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
    rehearsal.observeBind(input.bind); rehearsal.observeConnectionOpen(input.open);
    expectCode(() => rehearsal.observeFrameComplete(frame), "frame_rejected");
  }

  const reverseAge = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  reverseAge.observeBind(input.bind); reverseAge.observeConnectionOpen(input.open);
  reverseAge.observeFrameComplete(input.frame);
  expectCode(() => reverseAge.observeConnectionClose({ ...input.connectionClose,
    connectionAgeMs: input.frame.connectionAgeMs - 1 }), "lifetime_exceeded");
});

test("CR13A-LIVE-080 accepts only a decoder-minted, listener-bound protected frame", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const input = observations(plan), rehearsal = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  rehearsal.observeBind(input.bind); rehearsal.observeConnectionOpen(input.open);
  expectCode(() => rehearsal.observeFrameComplete({ ...input.frame,
    protectedFrame: { ...input.frame.protectedFrame } }), "frame_rejected");

  const otherPlan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration({
    listenerId: "private-loopback-listener:lifecycle-other-001",
  }));
  const otherFrame = observations(otherPlan).frame.protectedFrame;
  const second = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  second.observeBind(input.bind); second.observeConnectionOpen(input.open);
  expectCode(() => second.observeFrameComplete({ ...input.frame, protectedFrame: otherFrame }), "frame_rejected");
});

test("CR13A-LIVE-080 makes invalid sequence, observation, and incomplete finish terminal", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration()), input = observations(plan);
  const wrongSequence = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  expectCode(() => wrongSequence.observeBind({ ...input.bind, sequence: 2 }), "sequence_conflict");
  expectCode(() => wrongSequence.observeBind(input.bind), "state_conflict");

  const extra = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  expectCode(() => extra.observeBind({ ...input.bind, extra: true }), "invalid_observation");
  expectCode(() => extra.finish(), "incomplete_lifecycle");

  const incomplete = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  incomplete.observeBind(input.bind);
  expectCode(() => incomplete.finish(), "incomplete_lifecycle");
  expectCode(() => incomplete.observeConnectionOpen(input.open), "state_conflict");

  let observationTraps = 0;
  const behavioral = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  expectCode(() => behavioral.observeBind(new Proxy(input.bind, {
    get() { observationTraps += 1; throw new Error("must remain inert"); },
  })), "invalid_observation");
  assert.equal(observationTraps, 0);
  expectCode(() => behavioral.observeBind(input.bind), "state_conflict");

  const premature = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  premature.observeBind(input.bind); premature.observeConnectionOpen(input.open);
  premature.observeFrameComplete(input.frame);
  expectCode(() => premature.finish(), "incomplete_lifecycle");
  expectCode(() => premature.observeConnectionClose(input.connectionClose), "state_conflict");

  const wrongAfterFrame = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  wrongAfterFrame.observeBind(input.bind); wrongAfterFrame.observeConnectionOpen(input.open);
  wrongAfterFrame.observeFrameComplete(input.frame);
  expectCode(() => wrongAfterFrame.observeDrainStart(input.drain), "state_conflict");
  expectCode(() => wrongAfterFrame.observeConnectionClose(input.connectionClose), "state_conflict");
});

test("CR13A-LIVE-080 fails shutdown on active work, deadline, restart, or missing cleanup", () => {
  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration()), input = observations(plan);
  function throughFrame() {
    const rehearsal = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
    rehearsal.observeBind(input.bind); rehearsal.observeConnectionOpen(input.open);
    rehearsal.observeFrameComplete(input.frame); rehearsal.observeConnectionClose(input.connectionClose);
    return rehearsal;
  }
  for (const drain of [
    { ...input.drain, activeConnections: 1 },
    { ...input.drain, queuedConnections: 1 },
  ]) expectCode(() => throughFrame().observeDrainStart(drain), "capacity_exceeded");
  for (const drain of [
    { ...input.drain, shutdownElapsedMs: plan.shutdownGraceMs + 1 },
    { ...input.drain, automaticRestartAttempted: true },
  ]) expectCode(() => throughFrame().observeDrainStart(drain), "cleanup_failed");

  for (const close of [
    { ...input.listenerClose, shutdownElapsedMs: plan.shutdownGraceMs + 1 },
    { ...input.listenerClose, shutdownElapsedMs: input.drain.shutdownElapsedMs - 1 },
    { ...input.listenerClose, simulatedCleanupConfirmed: false },
  ]) {
    const rehearsal = throughFrame(); rehearsal.observeDrainStart(input.drain);
    expectCode(() => rehearsal.observeListenerClose(close), "cleanup_failed");
  }
});

test("CR13A-LIVE-080 rehearsal receipts reject drift, added behavior, and recomputed claims", () => {
  const { receipt } = runRehearsal();
  const { receiptDigest: _receiptDigest, ...unsignedReceipt } = receipt;
  void _receiptDigest;
  const forgedNativeClaim = { ...unsignedReceipt, actualBindObserved: true };
  const reboundReference = { ...unsignedReceipt, rehearsalReference: `listener-rehearsal:${"f".repeat(24)}` };
  const overlongListener = { ...unsignedReceipt,
    listenerId: `private-loopback-listener:${"a".repeat(135)}` };
  for (const invalid of [
    { ...receipt, actualBindObserved: true },
    { ...receipt, exclusivePortOwnershipProven: true },
    { ...receipt, tunnelPeerAuthenticated: true },
    { ...receipt, hostKeyCustodyProven: true },
    { ...receipt, nativeCleanupEvidenceAccepted: true },
    { ...receipt, listenerEnabled: true },
    { ...receipt, performsNetworkIo: true },
    { ...receipt, grantsNetworkAuthority: true },
    { ...receipt, extra: true },
    { ...forgedNativeClaim, receiptDigest: sha256Digest(forgedNativeClaim) },
    { ...reboundReference, receiptDigest: sha256Digest(reboundReference) },
    { ...overlongListener, receiptDigest: sha256Digest(overlongListener) },
  ]) expectCode(() => parseConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1(invalid),
    "integrity_failed");

  let traps = 0;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1(new Proxy(receipt, {
    get() { traps += 1; throw new Error("must remain inert"); },
  })), "integrity_failed");
  assert.equal(traps, 0);

  const minimum = runRehearsalForConfiguration({ listenerId: "private-loopback-listener:a" }).receipt;
  const maximum = runRehearsalForConfiguration({
    listenerId: `private-loopback-listener:${"a".repeat(134)}`,
  }).receipt;
  assert.equal(minimum.listenerId.length, 27);
  assert.equal(maximum.listenerId.length, 160);
  assert.deepEqual(parseConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1(minimum), minimum);
  assert.deepEqual(parseConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1(maximum), maximum);
});

test("CR13A-LIVE-080 adds no listener, network, process, route, or runtime enablement", async () => {
  const source = await readFile(resolve(
    "src/connection-registry/v1/private-loopback-listener-lifecycle.ts"), "utf8");
  const runtime = await readFile(resolve("src/local-pilot/v1/runtime.ts"), "utf8");
  assert.doesNotMatch(source, /from ["']node:(?:net|tls|http|https|child_process|dgram)["']/);
  assert.doesNotMatch(source, /\.listen\s*\(|\.connect\s*\(|spawn\s*\(|exec\s*\(/);
  assert.doesNotMatch(source, /ssh2|fetch\s*\(|WebSocket/i);
  assert.doesNotMatch(source, /#frame\s*:\s*ConnectionEnrollmentPrivateLoopbackProtectedFrameV1/);
  assert.match(source, /#frameDigest: string \| undefined/);
  assert.match(runtime, /new DisabledConnectionEnrollmentPrivateLoopbackListenerV1\(\)/);
});

test("CR13A-LIVE-080 rejects selected runtime replacement before executing it", () => {
  const original = Object.keys;
  let replacementExecutions = 0;
  Object.keys = (() => {
    replacementExecutions += 1;
    throw new Error("replacement must remain inert");
  }) as typeof Object.keys;
  try {
    expectCode(() => createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration()),
      "invalid_configuration");
    assert.equal(replacementExecutions, 0);
  } finally {
    Object.keys = original;
  }

  const plan = createConnectionEnrollmentPrivateLoopbackListenerPlanV1(planConfiguration());
  const input = observations(plan);
  const rehearsal = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(plan);
  rehearsal.observeBind(input.bind); rehearsal.observeConnectionOpen(input.open);
  rehearsal.observeFrameComplete(input.frame); rehearsal.observeConnectionClose(input.connectionClose);
  rehearsal.observeDrainStart(input.drain); rehearsal.observeListenerClose(input.listenerClose);
  Object.keys = (() => {
    replacementExecutions += 1;
    throw new Error("replacement must remain inert");
  }) as typeof Object.keys;
  try {
    expectCode(() => rehearsal.finish(), "integrity_failed");
    assert.equal(replacementExecutions, 0);
  } finally {
    Object.keys = original;
  }
});
