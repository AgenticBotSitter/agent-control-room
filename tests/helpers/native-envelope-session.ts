import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { DatabaseClient } from "../../src/persistence/database";
import { ServerNodeSession } from "../../src/node-control/server-node-session";
import { PortableNodeBridge, SqliteBridgeJournal } from "../../src/node-bridge";
import { DatabaseNodeKeyResolver, DatabaseReplayGuard, FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame } from "../../src/node-protocol/v1";
import { NATIVE_DELIVERY_FEATURE, NATIVE_LEASE_DELIVERY_FEATURE } from "../../src/harness/v1/native-delivery";
import type { NativeDispatchIntakeHandler } from "../../src/node-bridge/native-dispatch-handler";

export async function nativeEnvelopeSession(f: { db: DatabaseClient; keys: { privateKey: KeyObject }; clock(): number },
  options: { send?: (raw: string) => Promise<void>; nodeSend?: (raw: string) => Promise<void>; timeoutMs?: number; leaseDelivery?: boolean; leaseSend?: (raw: string) => Promise<void>;
    nativeHandler?: (journal: SqliteBridgeJournal) => NativeDispatchIntakeHandler } = {}) {
  const journal = new SqliteBridgeJournal(":memory:"), keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const outgoing: string[] = [], incoming: string[] = [], sent: string[] = [];
  const nativeHandler = options.nativeHandler?.(journal);
  const features = [NATIVE_DELIVERY_FEATURE, ...(options.leaseDelivery ? [NATIVE_LEASE_DELIVERY_FEATURE] : [])];
  const bridge = new PortableNodeBridge({ tenantId: "tenant:test", nodeId: "node:test", keyId: "key:test", features }, journal,
    { async sign(frame) { return signNodeFrame(frame, f.keys.privateKey); } },
    new NodeProtocolAuthenticator({ async resolve(input) { return { ...input, algorithm: "ed25519" as const, publicKeySpki: spki,
      state: "active" as const, principalState: "active" as const, validFrom: new Date(f.clock() - 60_000).toISOString() }; } }, journal,
    new FixedWindowProtocolRateLimiter(100, 60)), undefined, undefined, nativeHandler);
  const createSession = () => new ServerNodeSession({ tenantId: "tenant:test", nodeId: "node:test", nodeKeyId: "key:test",
    serverId: "server:test", serverKeyId: "key:server", serverPublicKeySpki: spki, transportIdentity: "transport:synthetic",
    features, maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30,
    ...(options.timeoutMs ? { operationTimeoutMs: options.timeoutMs } : {}) }, {
    authentication: new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(f.db), new DatabaseReplayGuard(f.db), new FixedWindowProtocolRateLimiter(100, 60)),
    clock: f.clock, async sign(frame) { return signNodeFrame(frame, keys.privateKey); },
    async send(raw) { sent.push(raw); outgoing.push(raw); if (JSON.parse(raw).type === "harness.native.dispatch") await options.send?.(raw);
      if (JSON.parse(raw).type === "job.lease.grant") await options.leaseSend?.(raw); },
  });
  let session = createSession();
  const handshake = async () => {
    await bridge.open({ async send(raw) { incoming.push(raw); await options.nodeSend?.(raw); }, async close() {} }, { now: new Date(f.clock()).toISOString(), transportIdentity: "transport:synthetic" });
    await session.acceptHello(incoming.shift()!);
    for (let i = 0; i < 20 && (outgoing.length || incoming.length); i++) {
      while (outgoing.length) await bridge.receive(outgoing.shift()!, new Date(f.clock()).toISOString());
      while (incoming.length) await session.receive(incoming.shift()!);
    }
    if (!session.nativeDeliveryChannel() || outgoing.length || incoming.length) throw new Error("Synthetic session failed to reconcile");
  };
  await handshake();
  const reconnect = async () => {
    session.disconnect(); await bridge.disconnected();
    // These arrays represent detached transport buffers, not the durable bridge journal.
    outgoing.length = 0; incoming.length = 0;
    session = createSession(); await handshake();
    return session;
  };
  return { get session() { return session; }, reconnect, sent, spki, bridge, journal, incoming,
    close: async () => { nativeHandler?.close(); session.disconnect(); await bridge.close(); journal.close(); } };
}
