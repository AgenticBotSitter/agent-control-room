import { randomBytes, randomUUID } from "node:crypto";
import { DOMAIN_CONTRACT_VERSION, nodeRecordSchema, type NodeRecord } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { opaqueTokenDigest, opaqueTokenMatches, publicKeyFingerprint, verifyEnrollmentProof } from "./crypto";
import { enrollmentChallengeRequestSchema, enrollmentChallengeSchema, enrollmentProofSchema, issueEnrollmentTokenSchema } from "./schemas";
import { negotiateProtocolVersion, ProtocolNegotiationError } from "./versioning";
import {
  NODE_PROTOCOL_SUPPORTED_VERSIONS,
  type EnrollmentChallenge,
  type EnrollmentChallengeRequest,
  type EnrollmentProof,
  type EnrollmentResult,
  type ReplayGuard,
  type SignedNodeFrame,
  type ServerTrustKey,
  type TrustedKeyResolver,
  type TrustedProtocolKey,
} from "./types";

export class EnrollmentError extends Error {
  constructor(readonly safeReasonCode: Exclude<EnrollmentResult, { accepted: true }>["safeReasonCode"]) {
    super("Node enrollment was rejected");
    this.name = "EnrollmentError";
  }
}

function enrollmentReject(code: EnrollmentError["safeReasonCode"]): never {
  throw new EnrollmentError(code);
}

function plusSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1_000).toISOString();
}

interface EnrollmentTokenRow {
  tenant_id: string;
  token_digest: string;
  node_class: string;
  state: string;
  created_at: string;
  expires_at: string;
}

interface EnrollmentChallengeRow {
  tenant_id: string;
  token_id: string;
  challenge_nonce: string;
  node_class: string;
  supported_protocols: string[];
  server_trust_keys: ServerTrustKey[];
  state: string;
  expires_at: string;
  token_state: string;
  token_expires_at: string;
}

export interface IssueEnrollmentTokenInput {
  tenantId: string;
  nodeClass: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  tokenId?: string;
}

export interface CompleteEnrollmentOptions {
  now: string;
  policyVersion: string;
  initialGrant: Record<string, unknown>;
}

export class NodeEnrollmentStore {
  private readonly serverTrustKeys: ServerTrustKey[];

  constructor(private readonly db: DatabaseClient, serverTrustKeys: ServerTrustKey[]) {
    if (serverTrustKeys.length < 1 || serverTrustKeys.length > 8) throw new Error("Between one and eight server trust keys must be advertised");
    if (new Set(serverTrustKeys.map((key) => key.keyId)).size !== serverTrustKeys.length) throw new Error("Server trust key IDs must be unique");
    for (const key of serverTrustKeys) {
      if (key.algorithm !== "ed25519") throw new Error("Only Ed25519 server trust keys are supported in v1");
      publicKeyFingerprint(key.spki);
    }
    this.serverTrustKeys = structuredClone(serverTrustKeys);
  }

  async issueToken(input: IssueEnrollmentTokenInput): Promise<{ tokenId: string; token: string; expiresAt: string }> {
    const validated = issueEnrollmentTokenSchema.parse(input);
    const tokenId = validated.tokenId ?? `enrollment:${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = validated.expiresAt ?? plusSeconds(validated.createdAt, 900);
    const lifetime = Date.parse(expiresAt) - Date.parse(validated.createdAt);
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 900_000) throw new Error("Enrollment token lifetime must be between one millisecond and 15 minutes");
    await this.db.query(
      `INSERT INTO node_enrollment_tokens (id,tenant_id,token_digest,node_class,state,created_by,created_at,expires_at)
       VALUES ($1,$2,$3,$4,'issued',$5,$6,$7)`,
      [tokenId,validated.tenantId,opaqueTokenDigest(token),validated.nodeClass,validated.createdBy,validated.createdAt,expiresAt],
    );
    return { tokenId, token, expiresAt };
  }

  async createChallenge(request: EnrollmentChallengeRequest, now: string, challengeId = `challenge:${randomUUID()}`): Promise<EnrollmentChallenge> {
    const validated = enrollmentChallengeRequestSchema.parse(request);
    return this.db.transaction(async (tx) => {
      const result = await tx.query<EnrollmentTokenRow>(
        `SELECT tenant_id,token_digest,node_class,state,created_at,expires_at
         FROM node_enrollment_tokens WHERE id=$1 FOR UPDATE`,
        [validated.tokenId],
      );
      const token = result.rows[0];
      if (!token || token.state !== "issued" || !opaqueTokenMatches(validated.token, token.token_digest) || token.node_class !== validated.nodeClass) enrollmentReject("invalid_enrollment");
      if (Date.parse(token.expires_at) <= Date.parse(now)) {
        enrollmentReject("expired_enrollment");
      }
      try {
        negotiateProtocolVersion(validated.supportedProtocols);
      } catch (error) {
        if (error instanceof ProtocolNegotiationError) enrollmentReject("unsupported_protocol");
        throw error;
      }
      const challenge = enrollmentChallengeSchema.parse({
        challengeId,
        challengeNonce: randomBytes(32).toString("base64url"),
        issuedAt: now,
        expiresAt: new Date(Math.min(Date.parse(now) + 300_000, Date.parse(token.expires_at))).toISOString(),
        supportedProtocols: [...NODE_PROTOCOL_SUPPORTED_VERSIONS],
        serverTrustKeys: structuredClone(this.serverTrustKeys),
      }) as EnrollmentChallenge;
      await tx.query(
        `INSERT INTO node_enrollment_challenges
         (id,tenant_id,token_id,challenge_nonce,node_class,supported_protocols,server_trust_keys,state,created_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'issued',$8,$9)`,
        [challenge.challengeId,token.tenant_id,validated.tokenId,challenge.challengeNonce,token.node_class,
          JSON.stringify(challenge.supportedProtocols),JSON.stringify(challenge.serverTrustKeys),challenge.issuedAt,challenge.expiresAt],
      );
      return challenge;
    });
  }

  async complete(proof: EnrollmentProof, options: CompleteEnrollmentOptions): Promise<EnrollmentResult> {
    const validated = enrollmentProofSchema.parse(proof) as EnrollmentProof;
    const initialGrant = structuredClone(options.initialGrant);
    assertNoSecretMaterial(initialGrant, "initial node grant");
    const initialGrantDigest = sha256Digest(initialGrant);
    return this.db.transaction(async (tx) => {
      const result = await tx.query<EnrollmentChallengeRow>(
        `SELECT c.tenant_id,c.token_id,c.challenge_nonce,c.node_class,c.supported_protocols,c.server_trust_keys,
                c.state,c.expires_at,t.state AS token_state,t.expires_at AS token_expires_at
         FROM node_enrollment_challenges c
         JOIN node_enrollment_tokens t ON t.tenant_id=c.tenant_id AND t.id=c.token_id
         WHERE c.id=$1 FOR UPDATE OF c,t`,
        [validated.challengeId],
      );
      const challenge = result.rows[0];
      if (!challenge || challenge.state !== "issued" || challenge.token_state !== "issued"
        || challenge.challenge_nonce !== validated.challengeNonce || challenge.node_class !== validated.nodeClass) enrollmentReject("invalid_enrollment");
      if (Date.parse(challenge.expires_at) <= Date.parse(options.now) || Date.parse(challenge.token_expires_at) <= Date.parse(options.now)) enrollmentReject("expired_enrollment");
      let fingerprint: string;
      try {
        if (!verifyEnrollmentProof(validated)) enrollmentReject("invalid_enrollment");
        fingerprint = publicKeyFingerprint(validated.publicKey.spki);
      } catch (error) {
        if (error instanceof EnrollmentError) throw error;
        enrollmentReject("invalid_enrollment");
      }
      let selectedProtocol;
      try {
        selectedProtocol = negotiateProtocolVersion(validated.supportedProtocols);
        if (!challenge.supported_protocols.includes(selectedProtocol)) enrollmentReject("unsupported_protocol");
      } catch (error) {
        if (error instanceof ProtocolNegotiationError) enrollmentReject("unsupported_protocol");
        throw error;
      }
      const collision = await tx.query(
        `SELECT id FROM control_nodes WHERE id=$1 OR (tenant_id=$2 AND identity_key_id=$3)
         UNION ALL SELECT node_id AS id FROM control_node_keys WHERE tenant_id=$2 AND fingerprint=$4`,
        [validated.nodeId,challenge.tenant_id,validated.publicKey.keyId,fingerprint],
      );
      if (collision.rows.length) enrollmentReject("identity_conflict");

      const node = nodeRecordSchema.parse({
        contractVersion: DOMAIN_CONTRACT_VERSION,
        kind: "node",
        id: validated.nodeId,
        tenantId: challenge.tenant_id,
        displayName: validated.displayName,
        state: "active",
        version: 1,
        platform: validated.platformFacts.platform,
        architecture: validated.platformFacts.architecture,
        identityKeyId: validated.publicKey.keyId,
        hardwareFingerprint: validated.platformFacts.hardwareFingerprint,
        softwareFingerprint: validated.platformFacts.softwareFingerprint,
        policyVersion: options.policyVersion,
        minimumProtocolVersion: selectedProtocol,
        enrolledAt: options.now,
        createdAt: options.now,
        updatedAt: options.now,
      }) as NodeRecord;
      await this.insertEnrolledNode(tx, node, validated.publicKey.spki, fingerprint, challenge.token_id, validated.challengeId, options.now, initialGrantDigest);
      return {
        accepted: true,
        nodeId: node.id,
        keyId: node.identityKeyId,
        selectedProtocol,
        initialGrant: structuredClone(initialGrant),
        initialGrantDigest,
        serverTrustKeys: challenge.server_trust_keys,
        enrolledAt: options.now,
      };
    });
  }

  private async insertEnrolledNode(tx: DatabaseSession, node: NodeRecord, spki: string, fingerprint: string, tokenId: string, challengeId: string, now: string, grantDigest: string): Promise<void> {
    const enrollmentKey = `node-enroll:${opaqueTokenDigest(challengeId).slice("sha256:".length)}`;
    await tx.query(
      `INSERT INTO control_nodes (id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
       VALUES ($1,$2,'active',1,$3,$4::jsonb,$5,$5)`,
      [node.id,node.tenantId,node.identityKeyId,JSON.stringify(node),now],
    );
    await tx.query(
      `INSERT INTO control_node_keys (id,tenant_id,node_id,algorithm,public_key_spki,fingerprint,state,valid_from,created_at)
       VALUES ($1,$2,$3,'ed25519',$4,$5,'active',$6,$6)`,
      [node.identityKeyId,node.tenantId,node.id,spki,fingerprint,now],
    );
    await tx.query(`UPDATE node_enrollment_challenges SET state='consumed',consumed_at=$1 WHERE tenant_id=$2 AND id=$3 AND state='issued'`, [now,node.tenantId,challengeId]);
    await tx.query(`UPDATE node_enrollment_tokens SET state='consumed',consumed_at=$1 WHERE tenant_id=$2 AND id=$3 AND state='issued'`, [now,node.tenantId,tokenId]);
    await tx.query(
      `INSERT INTO control_transition_events
       (id,tenant_id,entity_kind,entity_id,from_state,to_state,from_version,to_version,actor_id,actor_type,idempotency_key,safe_metadata,occurred_at)
       VALUES ($1,$2,'node',$3,'pending_enrollment','active',0,1,$3,'node',$4,$5::jsonb,$6)`,
      [`transition:${enrollmentKey}`,node.tenantId,node.id,enrollmentKey,JSON.stringify({ keyId: node.identityKeyId, grantDigest }),now],
    );
    await tx.query(
      `INSERT INTO control_outbox (id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,available_at,payload)
       VALUES ($1,$2,'node.enrolled','node',$3,$4,'pending',$5,$6::jsonb)`,
      [`outbox:${enrollmentKey}`,node.tenantId,node.id,enrollmentKey,now,
        JSON.stringify({ nodeId: node.id, keyId: node.identityKeyId, grantDigest, enrolledAt: now })],
    );
  }
}

export class DatabaseNodeKeyResolver implements TrustedKeyResolver {
  constructor(private readonly db: DatabaseClient) {}

  async resolve(input: { tenantId: string; actorId: string; senderKind: "node" | "control_room"; keyId: string }): Promise<TrustedProtocolKey | undefined> {
    if (input.senderKind !== "node") return undefined;
    const result = await this.db.query<{
      tenant_id: string; node_id: string; key_id: string; algorithm: "ed25519"; public_key_spki: string;
      key_state: "active" | "retired" | "revoked"; node_state: TrustedProtocolKey["principalState"]; valid_from: string; valid_until?: string;
    }>(
      `SELECT k.tenant_id,k.node_id,k.id AS key_id,k.algorithm,k.public_key_spki,k.state AS key_state,
              n.state AS node_state,k.valid_from,k.valid_until
       FROM control_node_keys k JOIN control_nodes n ON n.tenant_id=k.tenant_id AND n.id=k.node_id
       WHERE k.tenant_id=$1 AND k.node_id=$2 AND k.id=$3`,
      [input.tenantId,input.actorId,input.keyId],
    );
    const row = result.rows[0];
    return row ? {
      tenantId: row.tenant_id, actorId: row.node_id, senderKind: "node", keyId: row.key_id,
      algorithm: row.algorithm, publicKeySpki: row.public_key_spki, state: row.key_state,
      principalState: row.node_state, validFrom: row.valid_from, ...(row.valid_until ? { validUntil: row.valid_until } : {}),
    } : undefined;
  }
}

export class DatabaseReplayGuard implements ReplayGuard {
  constructor(private readonly db: DatabaseClient) {}

  async consume(frame: SignedNodeFrame, receivedAt: string): Promise<"accepted" | "duplicate"> {
    if (frame.senderKind !== "node") throw new Error("Database replay guard only accepts node principals");
    return this.db.transaction(async (tx) => {
      const frameDigest = sha256Digest(frame);
      const nonceDigest = opaqueTokenDigest(frame.nonce);
      const prior = await tx.query<{
        message_id: string; nonce_digest: string; connection_id: string; sequence: string | number; frame_digest?: string;
      }>(
        `SELECT message_id,nonce_digest,connection_id,sequence,frame_digest FROM node_protocol_replay
         WHERE tenant_id=$1 AND node_id=$2 AND key_id=$3
           AND (message_id=$4 OR nonce_digest=$5) FOR UPDATE`,
        [frame.tenantId,frame.actorId,frame.keyId,frame.messageId,nonceDigest],
      );
      if (prior.rows.length) {
        const exact = prior.rows.length === 1 && prior.rows[0].message_id === frame.messageId
          && prior.rows[0].nonce_digest === nonceDigest && prior.rows[0].connection_id === frame.connectionId
          && Number(prior.rows[0].sequence) === frame.sequence && prior.rows[0].frame_digest === frameDigest;
        if (exact) return "duplicate" as const;
        throw new Error("message or nonce replay conflict");
      }
      const connection = await tx.query<{ last_sequence: string | number }>(
        `SELECT last_sequence FROM node_protocol_connections
         WHERE tenant_id=$1 AND node_id=$2 AND connection_id=$3 AND direction=$4 FOR UPDATE`,
        [frame.tenantId,frame.actorId,frame.connectionId,frame.direction],
      );
      if (!connection.rows.length) {
        if (frame.sequence !== 1 || frame.type !== "connection.hello") throw new Error("new connection must begin with hello sequence 1");
        await tx.query(
          `INSERT INTO node_protocol_connections
           (tenant_id,node_id,connection_id,direction,last_sequence,last_message_id,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
          [frame.tenantId,frame.actorId,frame.connectionId,frame.direction,frame.sequence,frame.messageId,receivedAt],
        );
      } else {
        if (frame.sequence !== Number(connection.rows[0].last_sequence) + 1) throw new Error("non-monotonic protocol sequence");
        await tx.query(
          `UPDATE node_protocol_connections SET last_sequence=$1,last_message_id=$2,updated_at=$3
           WHERE tenant_id=$4 AND node_id=$5 AND connection_id=$6 AND direction=$7`,
          [frame.sequence,frame.messageId,receivedAt,frame.tenantId,frame.actorId,frame.connectionId,frame.direction],
        );
      }
      await tx.query(
        `INSERT INTO node_protocol_replay
         (tenant_id,node_id,key_id,direction,message_id,nonce_digest,connection_id,sequence,received_at,expires_at,frame_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [frame.tenantId,frame.actorId,frame.keyId,frame.direction,frame.messageId,nonceDigest,frame.connectionId,frame.sequence,receivedAt,frame.expiresAt,frameDigest],
      );
      return "accepted" as const;
    });
  }

  async pruneExpired(before: string): Promise<number> {
    const result = await this.db.query<{ message_id: string }>(`DELETE FROM node_protocol_replay WHERE expires_at < $1 RETURNING message_id`, [before]);
    return result.rows.length;
  }
}
