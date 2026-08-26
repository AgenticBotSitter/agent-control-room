import { appendAuditWith } from "../audit";
import { DeliveryStore } from "../persistence/delivery-store";
import type { DatabaseClient, DatabaseSession } from "../persistence/database";
import { assertDigest, assertNoSecretMaterial } from "../security";
import { signedNodeFrameSchema, type ArtifactLineageBody, type JobEventBody, type SignedNodeFrame } from "../node-protocol/v1";

export class NodeJobEventError extends Error {
  constructor(readonly safeCode: "invalid_event" | "identity_mismatch" | "sequence_conflict" | "evidence_conflict") {
    super(safeCode);
    this.name = "NodeJobEventError";
  }
}

export interface IngestedNodeJobEventV1 {
  event: JobEventBody["event"];
  attemptId: string;
  sequence: number;
  replayed: boolean;
}

function messageEnvelope(frame: SignedNodeFrame<"job.event">) {
  return {
    protocol: frame.protocol,
    messageId: frame.messageId,
    correlationId: frame.correlationId,
    ...(frame.causationId ? { causationId: frame.causationId } : {}),
    actorId: frame.actorId,
    tenantId: frame.tenantId,
    sentAt: frame.sentAt,
    expiresAt: frame.expiresAt,
    nonce: frame.nonce,
    type: frame.type,
    bodyDigest: frame.bodyDigest,
    body: frame.body,
    signature: frame.signature,
  };
}

function assertCompletionEvidence(event: JobEventBody): ArtifactLineageBody | undefined {
  if (event.event !== "completed") {
    if (event.artifactLineage || event.artifactManifestIds.length) throw new NodeJobEventError("invalid_event");
    return undefined;
  }
  const lineage = event.artifactLineage;
  if (!lineage || event.artifactManifestIds.length !== 1 || event.artifactManifestIds[0] !== lineage.artifactId) {
    throw new NodeJobEventError("invalid_event");
  }
  return lineage;
}

export class NodeJobEventService {
  private readonly delivery: DeliveryStore;

  constructor(private readonly db: DatabaseClient) {
    this.delivery = new DeliveryStore(db);
  }

  /** The caller must authenticate the signed frame before calling this method. */
  async ingestAuthenticated(frameInput: SignedNodeFrame<"job.event">, receivedAt: string): Promise<IngestedNodeJobEventV1> {
    const parsed = signedNodeFrameSchema.safeParse(frameInput);
    if (!parsed.success || parsed.data.type !== "job.event" || parsed.data.direction !== "node_to_server" || parsed.data.senderKind !== "node") {
      throw new NodeJobEventError("invalid_event");
    }
    const frame = parsed.data as SignedNodeFrame<"job.event">;
    assertDigest(frame.body, frame.bodyDigest, "node job event");
    assertNoSecretMaterial(frame.body, "node job event");
    const lineage = assertCompletionEvidence(frame.body);
    const received = await this.delivery.receive(messageEnvelope(frame), { now: receivedAt });
    if (received.replayed) return { event: frame.body.event, attemptId: frame.body.attemptId, sequence: frame.body.sequence, replayed: true };
    const processed = await this.delivery.processOnce(
      { tenantId: frame.tenantId, protocol: frame.protocol, messageId: frame.messageId },
      (tx, envelope) => this.persist(tx, frame, envelope.body as JobEventBody, lineage, receivedAt),
      { safeFailureCode: "node_job_event_rejected" },
    );
    return processed.result ?? { event: frame.body.event, attemptId: frame.body.attemptId, sequence: frame.body.sequence, replayed: true };
  }

  private async persist(
    tx: DatabaseSession,
    frame: SignedNodeFrame<"job.event">,
    event: JobEventBody,
    lineage: ArtifactLineageBody | undefined,
    recordedAt: string,
  ): Promise<IngestedNodeJobEventV1> {
    const authority = await tx.query<{
      attempt_id: string; node_id: string | null; job_id: string; project_id: string; workflow_id: string;
      lease_id: string; lease_epoch: number | string; lease_node_id: string;
    }>(
      `SELECT a.id AS attempt_id,a.node_id,a.job_id,j.project_id,j.workflow_id,l.id AS lease_id,l.epoch AS lease_epoch,l.node_id AS lease_node_id
       FROM control_attempts a JOIN control_jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
       JOIN control_leases l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.id
       WHERE a.tenant_id=$1 AND a.id=$2 FOR UPDATE`,
      [frame.tenantId,event.attemptId],
    );
    const bound = authority.rows[0];
    if (!bound || bound.node_id !== frame.actorId || bound.lease_node_id !== frame.actorId || bound.job_id !== event.jobId
      || bound.lease_id !== event.leaseId || Number(bound.lease_epoch) !== event.leaseEpoch) {
      throw new NodeJobEventError("identity_mismatch");
    }
    const node = await tx.query<{ id: string }>(`SELECT id FROM control_nodes WHERE tenant_id=$1 AND id=$2`, [frame.tenantId,frame.actorId]);
    if (!node.rows[0]) throw new NodeJobEventError("identity_mismatch");
    if (lineage && (lineage.tenantId !== frame.tenantId || lineage.projectId !== bound.project_id || lineage.jobId !== event.jobId
      || lineage.attemptId !== event.attemptId || lineage.producerId !== frame.actorId || lineage.manifest.workflowId !== undefined && lineage.manifest.workflowId !== bound.workflow_id)) {
      throw new NodeJobEventError("identity_mismatch");
    }

    const prior = await tx.query<{ body_digest: string }>(
      `SELECT body_digest FROM control_node_job_events WHERE tenant_id=$1 AND attempt_id=$2 AND event_sequence=$3 FOR UPDATE`,
      [frame.tenantId,event.attemptId,event.sequence],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].body_digest !== frame.bodyDigest) throw new NodeJobEventError("sequence_conflict");
      return { event: event.event, attemptId: event.attemptId, sequence: event.sequence, replayed: true };
    }
    const last = await tx.query<{ event_sequence: number }>(
      `SELECT event_sequence FROM control_node_job_events WHERE tenant_id=$1 AND attempt_id=$2 ORDER BY event_sequence DESC LIMIT 1 FOR UPDATE`,
      [frame.tenantId,event.attemptId],
    );
    if (event.sequence !== (last.rows[0]?.event_sequence ?? 0) + 1) throw new NodeJobEventError("sequence_conflict");

    if (lineage) await this.persistLineage(tx, frame.tenantId, bound.workflow_id, lineage, recordedAt);
    await tx.query(
      `INSERT INTO control_node_job_events
       (tenant_id,attempt_id,event_sequence,message_id,node_id,job_id,lease_id,lease_epoch,event_kind,occurred_at,body_digest,safe_reason_code,artifact_id,payload,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
      [frame.tenantId,event.attemptId,event.sequence,frame.messageId,frame.actorId,event.jobId,event.leaseId,event.leaseEpoch,
        event.event,event.occurredAt,frame.bodyDigest,event.safeReasonCode ?? null,lineage?.artifactId ?? null,JSON.stringify(event),recordedAt],
    );
    await appendAuditWith(tx, {
      id: `audit:${frame.messageId}`, tenantId: frame.tenantId, projectId: bound.project_id, actorId: frame.actorId, actorType: "worker",
      action: `node.job_event.${event.event}`, targetType: "attempt", targetId: event.attemptId,
      correlationId: frame.correlationId, idempotencyKey: frame.bodyDigest,
      safeMetadata: { sequence: event.sequence, leaseEpoch: event.leaseEpoch, ...(lineage ? { artifactId: lineage.artifactId, lineageDigest: lineage.lineageDigest } : {}) },
      occurredAt: event.occurredAt,
    });
    return { event: event.event, attemptId: event.attemptId, sequence: event.sequence, replayed: false };
  }

  private async persistLineage(tx: DatabaseSession, tenantId: string, workflowId: string, lineage: ArtifactLineageBody, recordedAt: string): Promise<void> {
    const prior = await tx.query<{ lineage_digest: string }>(
      `SELECT lineage_digest FROM control_artifact_lineage WHERE tenant_id=$1 AND artifact_id=$2 FOR UPDATE`, [tenantId,lineage.artifactId],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].lineage_digest !== lineage.lineageDigest) throw new NodeJobEventError("evidence_conflict");
      return;
    }
    await tx.query(
      `INSERT INTO control_artifact_manifests
       (id,tenant_id,project_id,workflow_id,job_id,attempt_id,content_hash,state,version,payload,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [lineage.manifest.id,tenantId,lineage.projectId,lineage.manifest.workflowId ?? workflowId,lineage.jobId,lineage.attemptId,
        lineage.manifest.contentHash,lineage.manifest.state,lineage.manifest.version,JSON.stringify(lineage.manifest),lineage.manifest.createdAt,lineage.manifest.updatedAt],
    );
    await tx.query(
      `INSERT INTO control_artifact_lineage
       (artifact_id,tenant_id,project_id,job_id,attempt_id,producer_id,lineage_digest,manifest_digest,producer_claim_digest,independent_verification_state,payload,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'not_run',$10::jsonb,$11)`,
      [lineage.artifactId,tenantId,lineage.projectId,lineage.jobId,lineage.attemptId,lineage.producerId,lineage.lineageDigest,
        lineage.producerClaim.manifestDigest,lineage.producerClaim.claimDigest,JSON.stringify(lineage),recordedAt],
    );
  }
}
