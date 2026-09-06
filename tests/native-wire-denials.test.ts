import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { NATIVE_WIRE_MAX_BYTES, decodeNativeWire, encodeNativeWire } from "../src/harness/v1/native-wire";
import type { NativeTaskSnapshotBody } from "../src/harness/v1/native-observation";
import { NODE_PROTOCOL_V1, signNodeFrame, type SignedNodeFrame } from "../src/node-protocol/v1";
import { nativeNodeRuntimeFixture } from "./helpers/native-node-runtime";
import { currentSignal } from "./helpers/managed-native-session";

const keys = generateKeyPairSync("ed25519");
const instant = "2026-09-06T18:00:00.000Z";
const expires = "2026-09-06T18:01:00.000Z";
const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function snapshotFrame(bytes?: Uint8Array, patch: Partial<NativeTaskSnapshotBody> = {}) {
  const body: NativeTaskSnapshotBody = {
    runId: "run:wire", projectId: "project:wire", jobId: "job:wire", attemptId: "attempt:wire",
    leaseId: "lease:wire", leaseEpoch: 1, bindingDigest: digest("binding"), sessionKeyDigest: digest("session"),
    nativeRunKeyDigest: digest("native-run"), snapshotVersion: 4, observedAt: instant, upstreamUpdatedAt: instant,
    state: "completed", availability: "current", lastActivity: "status_resnapshot", stopAttempted: false,
    safeReason: "none", result: bytes ? { contentHash: digest(bytes), sizeBytes: bytes.byteLength } : null,
    usage: null, ...patch,
  };
  return signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
    messageId: "message:wire:snapshot", correlationId: "correlation:wire", tenantId: "tenant:wire",
    actorId: "node:wire", keyId: "key:wire", connectionId: "connection:wire", sequence: 2,
    sentAt: instant, expiresAt: expires, nonce: "wire_snapshot_nonce_1234567890", type: "harness.native.snapshot", body }, keys.privateKey);
}

function acknowledgement(direction: "node_to_server" | "server_to_node") {
  return signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction,
    senderKind: direction === "node_to_server" ? "node" : "control_room",
    messageId: `message:wire:ack:${direction}`, correlationId: "correlation:wire", tenantId: "tenant:wire",
    actorId: direction === "node_to_server" ? "node:wire" : "server:wire", keyId: "key:wire",
    connectionId: "connection:wire", sequence: 3, sentAt: instant, expiresAt: expires,
    nonce: `wire_ack_${direction}_1234567890`, type: "protocol.ack",
    body: { acknowledgedMessageIds: ["message:wire:prior"], highestContiguousSequence: 2, disposition: "accepted" } },
  keys.privateKey);
}

const raw = (frame: SignedNodeFrame) => JSON.stringify(frame);
const unavailable = (work: () => unknown) => assert.throws(work, { message: "native_wire_unavailable" });

test("wire framing preserves the exact signed JSON and copies canonical completed-result bytes", () => {
  const expected = new Uint8Array([0, 1, 2, 127, 128, 254, 255]), source = Uint8Array.from(expected);
  const signed = raw(snapshotFrame(expected));
  let observed: NativeTaskSnapshotBody | undefined;
  const packet = encodeNativeWire(signed, "node_to_server", body => { observed = body; return source; });
  assert.deepEqual(observed, snapshotFrame(expected).body);
  assert.equal(packet.includes(signed), false, "the raw frame is JSON-escaped inside the outer packet");
  assert.equal(JSON.parse(packet).result, Buffer.from(expected).toString("base64"));
  source.fill(9);

  const input = new TextEncoder().encode(packet), decoded = decodeNativeWire(input, "node_to_server");
  input.fill(0); assert.equal(decoded.raw, signed); assert.deepEqual(decoded.bytes, expected);
  decoded.bytes!.fill(8);
  assert.deepEqual(decodeNativeWire(packet, "node_to_server").bytes, expected,
    "returned bytes do not alias either the packet input or a later decode");
});

test("inclusive raw-frame and result bounds are accepted while the next byte is refused", async t => {
  await t.test("64 KiB result", () => {
    const bytes = new Uint8Array(65_536); bytes[0] = 1; bytes[bytes.length - 1] = 2;
    const signed = raw(snapshotFrame(bytes)), packet = encodeNativeWire(signed, "node_to_server", () => bytes);
    assert.equal(Buffer.byteLength(JSON.parse(packet).result, "base64"), bytes.byteLength);
    assert.deepEqual(decodeNativeWire(packet, "node_to_server"), { raw: signed, bytes });
    unavailable(() => encodeNativeWire(signed, "node_to_server", () => new Uint8Array(65_537)));
  });

  await t.test("16 KiB snapshot frame", () => {
    const compact = raw(snapshotFrame()), bounded = compact + " ".repeat(16_384 - Buffer.byteLength(compact));
    assert.equal(Buffer.byteLength(bounded), 16_384);
    const packet = encodeNativeWire(bounded, "node_to_server");
    assert.equal(decodeNativeWire(packet, "node_to_server").raw, bounded);
    unavailable(() => encodeNativeWire(`${bounded} `, "node_to_server"));
  });

  await t.test("128 KiB ordinary frame", () => {
    const compact = raw(acknowledgement("node_to_server"));
    const bounded = compact + " ".repeat(131_072 - Buffer.byteLength(compact));
    assert.equal(Buffer.byteLength(bounded), 131_072);
    const packet = encodeNativeWire(bounded, "node_to_server");
    assert.deepEqual(decodeNativeWire(packet, "node_to_server"), { raw: bounded, bytes: undefined });
    unavailable(() => encodeNativeWire(`${bounded} `, "node_to_server"));
  });
});

test("direction and completed-result presence are exact and do not add authority", () => {
  const bytes = new TextEncoder().encode("bounded saved result"), completed = raw(snapshotFrame(bytes));
  const server = raw(acknowledgement("server_to_node"));
  const node = raw(acknowledgement("node_to_server"));
  assert.deepEqual(decodeNativeWire(encodeNativeWire(server, "server_to_node"), "server_to_node"),
    { raw: server, bytes: undefined });
  assert.deepEqual(decodeNativeWire(encodeNativeWire(node, "node_to_server"), "node_to_server"),
    { raw: node, bytes: undefined });
  unavailable(() => encodeNativeWire(server, "node_to_server"));
  unavailable(() => decodeNativeWire(encodeNativeWire(server, "server_to_node"), "node_to_server"));
  unavailable(() => encodeNativeWire(completed, "server_to_node", () => bytes));
  unavailable(() => encodeNativeWire(completed, "node_to_server"));

  const missing = JSON.stringify({ ...JSON.parse(encodeNativeWire(completed, "node_to_server", () => bytes)), result: null });
  unavailable(() => decodeNativeWire(missing, "node_to_server"));
  const extra = JSON.stringify({ ...JSON.parse(encodeNativeWire(node, "node_to_server")), result: "AA==" });
  unavailable(() => decodeNativeWire(extra, "node_to_server"));
});

test("malformed, noncanonical, tampered and oversized packets fail with one fixed error", async t => {
  const bytes = new Uint8Array([1, 2, 3]), completed = raw(snapshotFrame(bytes));
  const valid = JSON.parse(encodeNativeWire(completed, "node_to_server", () => bytes));
  const cases: [string, string | Uint8Array][] = [
    ["invalid JSON", "{"],
    ["unsupported version", JSON.stringify({ ...valid, schema: "control-room.native-wire/v2" })],
    ["missing result field", JSON.stringify({ schema: valid.schema, raw: valid.raw })],
    ["extra field", JSON.stringify({ ...valid, extra: true })],
    ["noncanonical base64", JSON.stringify({ ...valid, result: "AQID=" })],
    ["changed result hash", JSON.stringify({ ...valid, result: Buffer.from([1, 2, 4]).toString("base64") })],
    ["changed result length", JSON.stringify({ ...valid, result: Buffer.from([1, 2]).toString("base64") })],
    ["invalid UTF-8", new Uint8Array([0xc3, 0x28])],
    ["oversized packet", " ".repeat(NATIVE_WIRE_MAX_BYTES + 1)],
    ["oversized inner frame", JSON.stringify({ ...valid, raw: `${valid.raw}${" ".repeat(131_073)}` })],
  ];
  for (const [name, packet] of cases) await t.test(name, () => unavailable(() => decodeNativeWire(packet, "node_to_server")));
});

test("actual node and server wire owners close malformed transports once and refuse transport reuse", async t => {
  const f = await nativeNodeRuntimeFixture(); t.after(f.close); await f.x.verify();
  const nodePackets: string[] = [], serverPackets: string[] = [];
  const state = { nodeCloses: 0, serverCloses: 0, serverAvailable: true };
  const nodeTransport = { async send(packet: string) { nodePackets.push(packet); },
    async close() { state.nodeCloses++; } };
  const serverTransport = { async send(packet: string) { serverPackets.push(packet); },
    async close() { state.serverCloses++; state.serverAvailable = false; }, isAvailable: () => state.serverAvailable };
  const server = await f.x.manager.attachWire(f.config.enrollment.nodeId, serverTransport,
    { mode: "initial", task: f.x.request });
  await f.runtime.openWire(nodeTransport, "transport:managed-server", currentSignal());

  for (let turn = 0; turn < 20 && (nodePackets.length || serverPackets.length); turn++) {
    while (nodePackets.length) await server.receive(nodePackets.shift()!, currentSignal());
    while (serverPackets.length) await f.runtime.receiveWire(serverPackets.shift()!, currentSignal());
  }
  assert.equal(nodePackets.length + serverPackets.length, 0);
  assert.deepEqual(f.x.local.calls, []);
  await assert.rejects(f.x.manager.attachWire(f.config.enrollment.nodeId, serverTransport,
    { mode: "initial", task: f.x.request }), { message: "native_session_unavailable" });
  assert.throws(() => f.runtime.openWire(nodeTransport, "transport:managed-server", currentSignal()),
    { message: "native_node_runtime_unavailable" });

  await assert.rejects(server.receive("{", currentSignal()), { message: "native_input_uncertain" });
  assert.equal(state.serverCloses, 1); assert.deepEqual(f.x.local.calls, []);
  await assert.rejects(f.runtime.receiveWire("{", currentSignal()), { message: "native_node_runtime_uncertain" });
  await f.runtime.close(); assert.equal(state.nodeCloses, 1); assert.deepEqual(f.x.local.calls, []);
});
