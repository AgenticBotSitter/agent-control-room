import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBridgeJournal } from "../../src/node-bridge/journal";
import { NODE_PROTOCOL_V1, signNodeFrame, type UnsignedNodeFrame } from "../../src/node-protocol/v1";
import { PinnedOwnerTrust, SqliteNodeSecurityStateRepository, computeArtifactBodyDigest, signArtifact, signTrustBundleShrinkAuthorization } from "../../src/node-policy/v1";
import { createNativeLeaseEvidence } from "../../src/harness/hermes-native-v1/lease-evidence";
import { nativeStartAuthorityFixture } from "./native-start-authority";
import type { NativeEnrollment } from "../../src/harness/hermes-native-v1/contracts";

export async function nativeLeaseEvidenceFixture(enrollment?: NativeEnrollment) {
  const f = await nativeStartAuthorityFixture(undefined, enrollment), directory = await mkdtemp(join(tmpdir(), "cr-native-lease-"));
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
  const accept = async () => {
    await journal.consume(grant, at);
    if (grant.type !== "job.lease.grant") throw new Error("synthetic expected grant");
    journal.recordInitialLease(grant, at, () => true);
  };
  const config = { request: r, messageId: grant.messageId, serverActorId: actor, parentAuthorities: lease.parentAuthorities };
  const read = createNativeLeaseEvidence(config, { journal, trust, clock: now });
  return { ...f, startConfig: f.config, nativeRunJournal: f.journal, trust, journal, path, at, hello, grant, summary, config, read, accept, serverFrame: frame,
    provisionCeiling: async () => trust.provisionInitialCeiling(signArtifact(f.policy.ceiling, root.privateKey)),
    narrowCeiling: async () => {
      // Keep the signed ceiling structurally valid while genuinely narrowing it.
      // An empty operation list is rejected before adoption and cannot prove a
      // policy-revision change during a later await.
      const body = { ...f.policy.ceiling, version: 2, maxDurationSeconds: 1, bodyDigest: "" };
      body.bodyDigest = computeArtifactBodyDigest(body);
      await trust.adoptCeiling(signArtifact(body, root.privateKey));
    },
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
