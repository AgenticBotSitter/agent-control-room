import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { ServerNodeSession, ServerNodeSessionRegistry, type ServerNodeSessionConfig } from "../src/node-control/server-node-session";
import { PortableNodeBridge, SqliteBridgeJournal } from "../src/node-bridge";
import { FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame, type SignedNodeFrame, type UnsignedNodeFrame } from "../src/node-protocol/v1";
import { NATIVE_DELIVERY_FEATURE } from "../src/harness/v1/native-delivery";
import { nativeTaskFixture, at } from "./native-task-fixture";

async function fixture(features = [NATIVE_DELIVERY_FEATURE]) {
  const f = await nativeTaskFixture();
  const journal = new SqliteBridgeJournal(":memory:");
  const serverKeys = generateKeyPairSync("ed25519");
  const spki = serverKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  let now = Date.parse(at(1000));
  const nodeFrames: string[] = [], serverFrames: string[] = [];
  const config: ServerNodeSessionConfig = { tenantId: "tenant:test", nodeId: "node:test", nodeKeyId: "key:test",
    serverId: "server:test", serverKeyId: "key:server", serverPublicKeySpki: spki, transportIdentity: "transport:synthetic",
    features, maxFrameBytes: 65_536, heartbeatIntervalSeconds: 30 };
  const bridge = new PortableNodeBridge({ tenantId: "tenant:test", nodeId: "node:test", keyId: "key:test", features: [NATIVE_DELIVERY_FEATURE] }, journal,
    { async sign(frame) { return signNodeFrame(frame, f.keys.privateKey); } },
    new NodeProtocolAuthenticator({ async resolve(input) {
      if (input.actorId !== "server:test" || input.keyId !== "key:server" || input.tenantId !== "tenant:test" || input.senderKind !== "control_room") return undefined;
      return { ...input, algorithm: "ed25519" as const, publicKeySpki: spki, state: "active" as const,
        principalState: "active" as const, validFrom: at() };
    } }, journal, new FixedWindowProtocolRateLimiter(100, 60)));
  const ports = { authentication: f.auth, clock: () => now,
    async sign(frame: UnsignedNodeFrame): Promise<SignedNodeFrame> { return signNodeFrame(frame, serverKeys.privateKey); },
    async send(raw: string) { serverFrames.push(raw); } };
  const session = new ServerNodeSession(config, ports);
  await bridge.open({ async send(raw) { nodeFrames.push(raw); }, async close() {} }, { now: new Date(now).toISOString(), transportIdentity: "transport:synthetic" });
  const hello = nodeFrames.shift()!;
  async function pump() {
    for (let i = 0; i < 20 && (serverFrames.length || nodeFrames.length); i++) {
      while (serverFrames.length) await bridge.receive(serverFrames.shift()!, new Date(now).toISOString());
      while (nodeFrames.length) await session.receive(nodeFrames.shift()!);
    }
    assert.equal(serverFrames.length + nodeFrames.length, 0);
  }
  return { ...f, config, ports, session, bridge, hello, pump, nodeFrames, serverFrames,
    setNow: (value: number) => { now = value; },
    async close() { session.disconnect(); await bridge.close(); journal.close(); await f.close(); } };
}

test("real bridge and database-authenticated server negotiate and reconcile before either native channel is available", async () => {
  const f = await fixture();
  try {
    assert.equal(f.session.nativeDeliveryChannel(), undefined);
    f.config.features.length = 0;
    await f.session.acceptHello(f.hello);
    assert.equal(f.session.nativeDeliveryChannel(), undefined);
    await f.pump();
    const server = f.session.nativeDeliveryChannel()!;
    const node = f.bridge.nativeDeliveryChannel()!;
    assert.equal(server.connectionId, node.connectionId);
    assert.equal(server.maxFrameBytes, 65_536);
    assert.equal(server.grantsExecutionAuthority, false);
    server.assertCurrent(); node.assertCurrent();
    f.session.disconnect();
    assert.throws(() => server.assertCurrent(), /no longer current/);
    assert.equal(f.session.nativeDeliveryChannel(), undefined);
    await assert.rejects(f.session.acceptHello(f.hello), /cannot repeat/);
  } finally { await f.close(); }
});

test("server never supplies native channel for an unnegotiated feature", async () => {
  const f = await fixture([]);
  try {
    await f.session.acceptHello(f.hello); await f.pump();
    assert.equal(f.session.nativeDeliveryChannel(), undefined);
    assert.equal(f.bridge.nativeDeliveryChannel(), undefined);
  } finally { await f.close(); }
});

for (const rollback of [false, true]) test(`server channel expires permanently on ${rollback ? "clock rollback" : "hello deadline"}`, async () => {
  const f = await fixture();
  try {
    await f.session.acceptHello(f.hello); await f.pump();
    const channel = f.session.nativeDeliveryChannel()!;
    f.setNow(rollback ? Date.parse(at()) : Date.parse(channel.expiresAt));
    assert.throws(() => channel.assertCurrent(), /no longer current/);
    f.setNow(Date.parse(at(1000)));
    assert.equal(f.session.nativeDeliveryChannel(), undefined);
  } finally { await f.close(); }
});

test("server rejects mismatched expected node and revoked key without sending handshake", async () => {
  const f = await fixture();
  try {
    const mismatch = new ServerNodeSession({ ...f.config, nodeId: "node:other" }, f.ports);
    await assert.rejects(mismatch.acceptHello(f.hello), /identity or replay mismatch/);
    assert.equal(f.serverFrames.length, 0);
    await f.db.query("UPDATE control_node_keys SET state='revoked', revoked_at=$1 WHERE id='key:test'", [at(1000)]);
    await assert.rejects(f.session.acceptHello(f.hello), /forbidden/);
    assert.equal(f.serverFrames.length, 0);
  } finally { await f.close(); }
});

test("server rejects signer content substitution before transport", async () => {
  const f = await fixture();
  try {
    const session = new ServerNodeSession(f.config, { ...f.ports, async sign(frame) { return f.ports.sign({ ...frame, actorId: "server:other" }); } });
    await assert.rejects(session.acceptHello(f.hello), /signer changed/);
    assert.equal(f.serverFrames.length, 0);
  } finally { await f.close(); }
});

test("server bounds uncertain signing and refuses late send or another handshake", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const session = new ServerNodeSession({ ...f.config, operationTimeoutMs: 20 }, {
      ...f.ports, async sign(frame) { await gate; return f.ports.sign(frame); },
    });
    await assert.rejects(session.acceptHello(f.hello), /uncertain/);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.serverFrames.length, 0);
    assert.equal(session.nativeDeliveryChannel(), undefined);
    await assert.rejects(session.acceptHello(f.hello), /cannot repeat/);
  } finally { release(); await f.close(); }
});

test("bounded registry replaces only the same node and stale release cannot disconnect its replacement", async () => {
  const f = await fixture();
  const registry = new ServerNodeSessionRegistry(1);
  try {
    const old = registry.replace(f.config, f.ports);
    const replacement = registry.replace(f.config, f.ports);
    await assert.rejects(old.acceptHello(f.hello), /cannot repeat/);
    registry.release(old);
    await replacement.acceptHello(f.hello);
    assert.throws(() => registry.replace({ ...f.config, nodeId: "node:other" }, f.ports), /capacity/);
    registry.close();
    assert.equal(replacement.nativeDeliveryChannel(), undefined);
    const reopened = registry.replace(f.config, f.ports);
    registry.release(reopened);
  } finally { registry.close(); await f.close(); }
});

test("disconnect between final handshake send and state transition cannot reopen the session", async () => {
  const f = await fixture();
  try {
    const session = new ServerNodeSession(f.config, { ...f.ports, async send(raw) {
      f.serverFrames.push(raw);
      if (JSON.parse(raw).type === "node.reconciliation.request") queueMicrotask(() => queueMicrotask(() => session.disconnect()));
    } });
    await assert.rejects(session.acceptHello(f.hello), /no longer current/);
    while (f.serverFrames.length) await f.bridge.receive(f.serverFrames.shift()!, at(1000));
    assert.equal(session.nativeDeliveryChannel(), undefined);
    for (const raw of f.nodeFrames) await assert.rejects(session.receive(raw), /not accepting reconciliation/);
  } finally { await f.close(); }
});
