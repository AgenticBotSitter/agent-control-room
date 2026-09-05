import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { NODE_PROTOCOL_V1, signNodeFrame, type UnsignedNodeFrame } from "../src/node-protocol/v1";
import { PinnedOwnerTrust, SqliteNodeSecurityStateRepository, computeArtifactBodyDigest, signArtifact, signTrustBundleShrinkAuthorization } from "../src/node-policy/v1";
import { createNativeLeaseEvidence } from "../src/harness/hermes-native-v1/lease-evidence";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";

async function fixture() {
  const f = await nativeStartAuthorityFixture(), directory = await mkdtemp(join(tmpdir(), "cr-native-lease-"));
  const root = generateKeyPairSync("ed25519"), server = generateKeyPairSync("ed25519");
  const rootSpki = root.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const pin = { keyId: "owner-key:test", algorithm: "ed25519" as const, spki: rootSpki,
    fingerprint: `sha256:${createHash("sha256").update(Buffer.from(rootSpki, "base64url")).digest("hex")}` };
  const now = () => f.dependencies.clock!(), at = new Date(now()).toISOString(), r = f.prepared.request;
  const trust = new SqliteNodeSecurityStateRepository({ artifactDatabasePath: join(directory, "artifacts.db"), highWaterDatabasePath: join(directory, "water.db") },
    { tenantId: r.tenantId, nodeId: r.nodeId, nodeClass: "personal-compute" },
    new PinnedOwnerTrust({ ceilingProvisioningKey: pin, serverTrustRootKey: pin, trustShrinkKeys: [pin] }), { now: () => new Date(now()).toISOString() });
  const material = { schema: "control-room.server-trust-bundle/v1" as const, tenantId: r.tenantId, nodeClass: "personal-compute", epoch: 1,
    issuedAt: at, ownerRootKeyId: pin.keyId, keys: [{ keyId: "server-key:test", algorithm: "ed25519" as const,
      spki: server.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), state: "active" as const }] };
  await trust.provisionInitialTrustBundle(signArtifact({ ...material, bodyDigest: computeArtifactBodyDigest(material) }, root.privateKey));
  const path = join(directory, "bridge.db"), journal = new SqliteBridgeJournal(path), actor = "control-room:server";
  const frame = (sequence: number, type: UnsignedNodeFrame["type"], body: UnsignedNodeFrame["body"]) => signNodeFrame({ protocol: NODE_PROTOCOL_V1,
    direction: "server_to_node", messageId: `message:lease:${sequence}`, correlationId: "correlation:lease", tenantId: r.tenantId,
    actorId: actor, senderKind: "control_room", keyId: "server-key:test", connectionId: "connection:lease", sequence,
    sentAt: at, expiresAt: new Date(now() + 10_000).toISOString(), nonce: `synthetic_lease_nonce_${sequence}_123456789012345`, type, body } as UnsignedNodeFrame, server.privateKey);
  const hello = frame(1, "connection.accepted", { selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: [], maxFrameBytes: 65536, heartbeatIntervalSeconds: 10, serverTime: at });
  await journal.consume(hello, at);
  const lease = f.policy.lease;
  const grant = frame(2, "job.lease.grant", { offerId: "offer:lease", nodeId: r.nodeId, jobId: r.jobId, attemptId: r.attemptId,
    leaseId: r.leaseId, leaseEpoch: r.leaseEpoch, acquiredAt: at, expiresAt: lease.expiresAt, authorityDigest: lease.authorityDigest, authority: lease.authority });
  const summary = { attemptId: r.attemptId, jobId: r.jobId, leaseId: r.leaseId, leaseEpoch: r.leaseEpoch,
    state: "leased" as const, lastEventSequence: 0, checkpointIds: [] };
  const accept = async () => { await journal.consume(grant, at); journal.recordCommand(grant, at); journal.upsertAttempt(summary, at); };
  const config = { request: r, messageId: grant.messageId, serverActorId: actor, parentAuthorities: lease.parentAuthorities };
  const read = createNativeLeaseEvidence(config, { journal, trust, clock: now });
  return { ...f, trust, journal, path, at, grant, summary, config, read, accept,
    revoke: async () => {
      const replacement = generateKeyPairSync("ed25519");
      const next = { ...material, epoch: 2, keys: [{ ...material.keys[0], state: "revoked" as const },
        { keyId: "server-key:replacement", algorithm: "ed25519" as const, state: "active" as const,
          spki: replacement.publicKey.export({ format: "der", type: "spki" }).toString("base64url") }].sort((a, b) => a.keyId.localeCompare(b.keyId)) };
      const body = { ...next, bodyDigest: computeArtifactBodyDigest(next) };
      await trust.applyOwnerSignedBundle({ ...signArtifact(body, root.privateKey),
        shrinkAuthorization: signTrustBundleShrinkAuthorization(body.bodyDigest, pin.keyId, root.privateKey) });
    },
    close: async () => { journal.close(); trust.close(); await f.close(); await rm(directory, { recursive: true }); } };
}
const signal = () => new AbortController().signal;

test("real owner-pinned trust and accepted bridge receipt supply the native start controller's lease", async t => {
  const f = await fixture(); t.after(f.close); await f.accept();
  const lease = await f.read(signal()); assert.deepEqual(lease, f.policy.lease);
  const controller = f.create({ async readCurrent(s) { return { ...await f.dependencies.readCurrent(s), lease: await f.read(s) }; } });
  t.after(() => controller.close()); assert.equal((await f.adapter(controller).start(f.prepared.start)).state, "queued");
});

test("a lease object, queued-only frame or accepted-only receipt is not usable lease evidence", async t => {
  for (const partial of ["none", "queued", "received"] as const) await t.test(partial, async t => {
    const f = await fixture(); t.after(f.close);
    if (partial === "queued") f.journal.recordCommand(f.grant, f.at);
    if (partial === "received") await f.journal.consume(f.grant, f.at);
    await assert.rejects(f.read(signal()), /unavailable/);
  });
});

test("terminal, superseded, expired and wrong-actor grants fail closed", async t => {
  const f = await fixture(); t.after(f.close); await f.accept();
  for (const patch of [{ state: "completed" as const }, { leaseEpoch: f.summary.leaseEpoch + 1 }, { leaseId: "lease:other" }]) {
    f.journal.upsertAttempt({ ...f.summary, ...patch }, f.at); await assert.rejects(f.read(signal()), /unavailable/);
  }
  f.journal.upsertAttempt(f.summary, f.at);
  const other = createNativeLeaseEvidence({ ...f.config, serverActorId: "control-room:other" }, { journal: f.journal, trust: f.trust, clock: f.dependencies.clock });
  await assert.rejects(other(signal()), /unavailable/);
  f.setNow(Date.parse(f.policy.lease.expiresAt)); await assert.rejects(f.read(signal()), /unavailable/);
});

test("accepted grant can outlive transport envelope expiry but not lease expiry", async t => {
  const f = await fixture(); t.after(f.close); await f.accept(); f.setNow(Date.parse(f.grant.expiresAt) + 1);
  assert.equal((await f.read(signal())).leaseId, f.summary.leaseId);
});

test("receipt corruption and lost current trust cannot be replaced by a previously valid object", async t => {
  const f = await fixture(); t.after(f.close); await f.accept(); await f.read(signal());
  const noKey = createNativeLeaseEvidence(f.config, { journal: f.journal, trust: { async resolveServerKey() { return undefined; } }, clock: f.dependencies.clock });
  await assert.rejects(noKey(signal()), /unavailable/);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.prepare("UPDATE bridge_inbox SET frame_digest=? WHERE message_id=?").run(`sha256:${"f".repeat(64)}`, f.grant.messageId);
  await assert.rejects(f.read(signal()), /unavailable/);
});

test("abort and attempt changes while current signing trust resolves prevent admission", async t => {
  const f = await fixture(); t.after(f.close); await f.accept(); let release!: () => void;
  const read = createNativeLeaseEvidence(f.config, { journal: f.journal, trust: { async resolveServerKey(id) {
    await new Promise<void>(resolve => { release = resolve; }); return f.trust.resolveServerKey(id);
  } }, clock: f.dependencies.clock });
  const c = new AbortController(), pending = read(c.signal), rejected = assert.rejects(pending, /unavailable/); c.abort(); release(); await rejected;
  const next = read(signal()), refused = assert.rejects(next, /unavailable/);
  f.journal.upsertAttempt({ ...f.summary, state: "cancelled" }, f.at); release(); await refused;
});

test("actual owner-signed server key revocation invalidates an already recorded lease", async t => {
  const f = await fixture(); t.after(f.close); await f.accept(); await f.read(signal());
  await f.revoke(); await assert.rejects(f.read(signal()), /unavailable/);
});

test("recording a forged signature does not convert it into verified lease authority", async t => {
  const f = await fixture(); t.after(f.close); f.grant.signature = "a".repeat(86); await f.accept();
  await assert.rejects(f.read(signal()), /unavailable/);
});
