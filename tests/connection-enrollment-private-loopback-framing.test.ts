import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { TextEncoder } from "node:util";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAME_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
  ConnectionEnrollmentPrivateLoopbackFrameDecoderV1,
  ConnectionEnrollmentPrivateLoopbackFramingErrorV1,
  DisabledConnectionEnrollmentPrivateLoopbackListenerV1,
  parseConnectionEnrollmentPrivateLoopbackProtectedFrameV1,
  toConnectionEnrollmentTransportAdmissionInputV1,
} from "../src/connection-registry/v1/index.ts";

const deliveryId = "delivery:private-loopback:001";

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    listenerId: "private-loopback-listener:fixture-001",
    transport: "ssh_tunnel" as const,
    listenerVisibility: "private_loopback" as const,
    addressFamily: "ipv4" as const,
    bindAddress: "127.0.0.1" as const,
    framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
    maximumFrameBytes: 4_096,
    maximumChunks: 32,
    ...overrides,
  };
}

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "control-room-node/v1",
    direction: "node_to_server",
    messageId: "message:private-loopback:001",
    correlationId: "correlation:private-loopback:001",
    causationId: "message:private-loopback:000",
    tenantId: "tenant:fixture",
    actorId: "node:fixture",
    senderKind: "node",
    keyId: "key:fixture",
    connectionId: "connection:fixture",
    sequence: 2,
    sentAt: "2026-09-03T12:00:00.000Z",
    expiresAt: "2026-09-03T12:01:00.000Z",
    nonce: "nonce_private_loopback_fixture_001",
    bodyDigest: `sha256:${"a".repeat(64)}`,
    signature: "signature_private_loopback_fixture_001",
    type: "connection.enrollment.deliver",
    body: {
      deliveryId,
      enrollmentContract: "control-room-idea-lab-hermes-021-connection-enrollment/v1",
      envelopeDigest: `sha256:${"b".repeat(64)}`,
      envelope: { fixture: true },
    },
    ...overrides,
  };
}

function packetFor(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  const packet = new Uint8Array(payload.byteLength + 4);
  packet[0] = (payload.byteLength >>> 24) & 0xff;
  packet[1] = (payload.byteLength >>> 16) & 0xff;
  packet[2] = (payload.byteLength >>> 8) & 0xff;
  packet[3] = payload.byteLength & 0xff;
  packet.set(payload, 4);
  return packet;
}

function copiedChunks(packet: Uint8Array, boundaries: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const boundary of boundaries) {
    const end = Math.min(packet.byteLength, offset + boundary);
    if (end > offset) chunks.push(packet.slice(offset, end));
    offset = end;
  }
  if (offset < packet.byteLength) chunks.push(packet.slice(offset));
  return chunks;
}

function expectCode(action: () => unknown,
  code: ConnectionEnrollmentPrivateLoopbackFramingErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackFramingErrorV1 && error.safeCode === code);
}

function decode(packet: Uint8Array, boundaries = [1, 2, 3, 5, 8, 13, 21]) {
  const decoder = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration());
  for (const chunk of copiedChunks(packet, boundaries)) decoder.push(chunk);
  return decoder.finish();
}

test("CR13A-LIVE-070 decodes one fragmented frame into a protected authority-free handoff", () => {
  const packet = packetFor(frame()), original = packet.slice();
  const decoded = decode(packet);
  assert.equal(decoded.contractVersion, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAME_V1);
  assert.deepEqual({ listenerId: decoded.listenerId, transport: decoded.transport,
    listenerVisibility: decoded.listenerVisibility, framing: decoded.framing, deliveryId: decoded.deliveryId,
    frameBytes: decoded.frameBytes }, {
    listenerId: "private-loopback-listener:fixture-001",
    transport: "ssh_tunnel",
    listenerVisibility: "private_loopback",
    framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
    deliveryId,
    frameBytes: new TextEncoder().encode(decoded.rawFrame).byteLength,
  });
  assert.deepEqual([decoded.grantsApproval, decoded.grantsNetworkAuthority, decoded.grantsCommandAuthority,
    decoded.grantsLeaseAuthority, decoded.grantsExecutionAuthority], [false, false, false, false, false]);
  assert.deepEqual(parseConnectionEnrollmentPrivateLoopbackProtectedFrameV1(decoded), decoded);
  assert.deepEqual(toConnectionEnrollmentTransportAdmissionInputV1(decoded), {
    rawFrame: decoded.rawFrame,
    deliveryId,
  });
  assert.deepEqual(packet, original, "the decoder must not alter caller-owned bytes");
});

test("CR13A-LIVE-070 produces the same handoff across safe chunk partitions", () => {
  const packet = packetFor(frame());
  assert.deepEqual(decode(packet, [packet.byteLength]), decode(packet, [4, packet.byteLength - 4]));
  assert.deepEqual(decode(packet, [packet.byteLength]), decode(packet, new Array(20).fill(1)));
});

test("CR13A-LIVE-070 accepts only fixed private IPv4 loopback configuration", () => {
  for (const invalid of [
    configuration({ listenerId: "listener:short" }),
    configuration({ transport: "http" }),
    configuration({ listenerVisibility: "public" }),
    configuration({ addressFamily: "ipv6" }),
    configuration({ bindAddress: "0.0.0.0" }),
    configuration({ bindAddress: "localhost" }),
    configuration({ framing: "newline-json" }),
    configuration({ maximumFrameBytes: 4_095 }),
    configuration({ maximumFrameBytes: 1_048_577 }),
    configuration({ maximumChunks: 0 }),
    configuration({ maximumChunks: 4_097 }),
    { ...configuration(), extra: true },
  ]) expectCode(() => new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(invalid),
    "invalid_configuration");

  let traps = 0;
  const proxy = new Proxy(configuration(), {
    get() { traps += 1; throw new Error("configuration behavior must remain inert"); },
  });
  expectCode(() => new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(proxy), "invalid_configuration");
  assert.equal(traps, 0);
});

test("CR13A-LIVE-070 bounds declared length, completeness, trailing data, and chunk count", () => {
  for (const length of [0, 1]) {
    const decoder = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration());
    expectCode(() => decoder.push(new Uint8Array([0, 0, 0, length])), "malformed_prefix");
  }
  const oversized = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration());
  expectCode(() => oversized.push(new Uint8Array([0, 0, 0x10, 1])), "frame_too_large");

  const incomplete = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration());
  incomplete.push(new Uint8Array([0, 0, 0, 2, 0x7b]));
  expectCode(() => incomplete.finish(), "incomplete_frame");

  const trailing = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration());
  const validPacket = packetFor(frame());
  const withTrailing = new Uint8Array(validPacket.byteLength + 1);
  withTrailing.set(validPacket); withTrailing[withTrailing.byteLength - 1] = 10;
  expectCode(() => trailing.push(withTrailing), "trailing_bytes");

  const chunked = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration({ maximumChunks: 2 }));
  chunked.push(new Uint8Array([0])); chunked.push(new Uint8Array([0]));
  expectCode(() => chunked.push(new Uint8Array([0])), "chunk_limit_exceeded");
});

test("CR13A-LIVE-070 rejects malformed bytes and message routing before admission", () => {
  const invalidUtf8 = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration());
  invalidUtf8.push(new Uint8Array([0, 0, 0, 2, 0xc3, 0x28]));
  expectCode(() => invalidUtf8.finish(), "invalid_utf8");

  expectCode(() => decode(packetFor("{ ")), "invalid_json");
  expectCode(() => decode(packetFor(frame({ type: "node.heartbeat" }))), "wrong_message_type");
  expectCode(() => decode(packetFor(frame({ body: {
    deliveryId: "?", enrollmentContract: "contract", envelopeDigest: `sha256:${"b".repeat(64)}`,
    envelope: {},
  } }))), "invalid_delivery_id");
  expectCode(() => decode(packetFor(frame({ body: { deliveryId, extra: true } }))), "invalid_delivery_id");
});

test("CR13A-LIVE-070 rejects behavioral or aliased binary chunks without invoking them", () => {
  const packet = packetFor(frame());
  const decoder = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration());
  expectCode(() => decoder.push(Buffer.from(packet)), "invalid_chunk");

  const partial = packet.subarray(0, packet.byteLength - 1);
  expectCode(() => new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration()).push(partial),
    "invalid_chunk");

  let traps = 0;
  const proxy = new Proxy(packet, {
    get() { traps += 1; throw new Error("binary behavior must remain inert"); },
  });
  expectCode(() => new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration()).push(proxy),
    "invalid_chunk");
  assert.equal(traps, 0);
});

test("CR13A-LIVE-070 makes decoder failures and completion terminal", () => {
  const failed = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration());
  expectCode(() => failed.push(new Uint8Array()), "invalid_chunk");
  expectCode(() => failed.push(new Uint8Array([0])), "state_conflict");
  expectCode(() => failed.finish(), "state_conflict");
  failed.close(); failed.close();

  const complete = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(configuration());
  complete.push(packetFor(frame())); complete.finish();
  expectCode(() => complete.push(new Uint8Array([0])), "state_conflict");
  expectCode(() => complete.finish(), "state_conflict");
  complete.close(); complete.close();
});

test("CR13A-LIVE-070 validates protected handoffs and keeps the listener disabled", async () => {
  const accepted = decode(packetFor(frame()));
  for (const invalid of [
    { ...accepted, rawFrame: `${accepted.rawFrame} ` },
    { ...accepted, deliveryId: "delivery:private-loopback:changed" },
    { ...accepted, frameBytes: accepted.frameBytes + 1 },
    { ...accepted, grantsCommandAuthority: true },
    { ...accepted, extra: true },
  ]) expectCode(() => parseConnectionEnrollmentPrivateLoopbackProtectedFrameV1(invalid), "integrity_failed");
  let traps = 0;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackProtectedFrameV1(new Proxy(accepted, {
    get() { traps += 1; throw new Error("protected input behavior must remain inert"); },
  })), "integrity_failed");
  assert.equal(traps, 0);

  const listener = new DisabledConnectionEnrollmentPrivateLoopbackListenerV1();
  assert.equal(listener.enabled, false);
  await assert.rejects(listener.start(), (error: unknown) =>
    error instanceof ConnectionEnrollmentPrivateLoopbackFramingErrorV1 && error.safeCode === "disabled");
  await listener.close();
});

test("CR13A-LIVE-070 local pilot wiring opens no listener or route", async () => {
  const runtimeSource = await readFile(resolve("src/local-pilot/v1/runtime.ts"), "utf8");
  const framingSource = await readFile(resolve("src/connection-registry/v1/private-loopback-framing.ts"), "utf8");
  assert.match(runtimeSource, /new DisabledConnectionEnrollmentPrivateLoopbackListenerV1\(\)/);
  assert.doesNotMatch(runtimeSource, /from ["']node:net["']/);
  assert.doesNotMatch(framingSource, /from ["']node:net["']/);
  assert.doesNotMatch(framingSource, /\.listen\s*\(/);
  assert.doesNotMatch(framingSource, /ssh2|child_process|spawn\s*\(|exec\s*\(/i);
});

test("CR13A-LIVE-070 rejects selected runtime replacement before executing it", () => {
  const mutations = [
    `Object.defineProperty(JSON, "parse", { configurable: true, value() { calls += 1; throw new Error("used"); } });`,
    `Object.defineProperty(Buffer, "byteLength", { configurable: true, value() { calls += 1; throw new Error("used"); } });`,
    `Object.defineProperty(Object.getPrototypeOf(new TextDecoder()), "decode", { configurable: true,
      value() { calls += 1; throw new Error("used"); } });`,
  ];
  for (const mutation of mutations) {
    const script = `
      import { Buffer } from "node:buffer";
      import { TextDecoder } from "node:util";
      import { ConnectionEnrollmentPrivateLoopbackFrameDecoderV1,
        CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1 } from "./src/connection-registry/v1/index.ts";
      const decoder = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1({
        listenerId: "private-loopback-listener:runtime-probe",
        transport: "ssh_tunnel", listenerVisibility: "private_loopback", addressFamily: "ipv4",
        bindAddress: "127.0.0.1", framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
        maximumFrameBytes: 4096, maximumChunks: 8,
      });
      let calls = 0;
      ${mutation}
      let code = "none";
      try { decoder.push(new Uint8Array([0])); } catch (error) { code = error?.safeCode; }
      if (code !== "integrity_failed" || calls !== 0) {
        process.stderr.write(JSON.stringify({ code, calls })); process.exitCode = 1;
      }
    `;
    const child = spawnSync(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  }
});
