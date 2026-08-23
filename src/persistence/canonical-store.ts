import {
  approvalTransitions,
  artifactTransitions,
  attemptTransitions,
  checkpointTransitions,
  domainEntitySchema,
  effectIntentTransitions,
  incidentTransitions,
  jobTransitions,
  leaseTransitions,
  nodeTransitions,
  requestTransitions,
  scheduleTransitions,
  serviceTransitions,
  workflowTransitions,
  type ActorRef,
  type ApprovalRecord,
  type AttemptRecord,
  type DomainEntity,
  type EffectIntentRecord,
  type JobRecord,
  type LeaseRecord,
  type TransitionTable,
} from "../domain/v1";
import type { DatabaseClient, DatabaseSession } from "./database";
import { assertAuthorityDigest, assertNoSecretMaterial, computeEffectOperationDigest } from "../security";

type EntityKind = DomainEntity["kind"];
type EntityState = DomainEntity["state"];

interface EntityConfig {
  table: string;
  transitions: TransitionTable<string>;
}

const entityConfigs: Record<EntityKind, EntityConfig> = {
  request: { table: "control_requests", transitions: requestTransitions },
  workflow: { table: "control_workflows", transitions: workflowTransitions },
  job: { table: "control_jobs", transitions: jobTransitions },
  attempt: { table: "control_attempts", transitions: attemptTransitions },
  lease: { table: "control_leases", transitions: leaseTransitions },
  checkpoint: { table: "control_checkpoints", transitions: checkpointTransitions },
  effect_intent: { table: "control_effect_intents", transitions: effectIntentTransitions },
  approval: { table: "control_approvals", transitions: approvalTransitions },
  service: { table: "control_services", transitions: serviceTransitions },
  schedule: { table: "control_schedules", transitions: scheduleTransitions },
  incident: { table: "control_incidents", transitions: incidentTransitions },
  artifact_manifest: { table: "control_artifact_manifests", transitions: artifactTransitions },
  node: { table: "control_nodes", transitions: nodeTransitions },
};

const initialStates: Record<EntityKind, EntityState> = {
  request: "draft", workflow: "proposed", job: "proposed", attempt: "offered", lease: "active",
  checkpoint: "declared", effect_intent: "proposed", approval: "pending", service: "active",
  schedule: "active", incident: "open", artifact_manifest: "declared", node: "pending_enrollment",
};

export interface TransitionInput {
  tenantId: string;
  kind: EntityKind;
  entityId: string;
  expectedVersion: number;
  toState: EntityState;
  transitionId: string;
  idempotencyKey: string;
  actor: ActorRef;
  occurredAt: string;
  safeMetadata?: Record<string, unknown>;
  recordPatch?: Record<string, unknown>;
}

export interface TransitionResult {
  entity: DomainEntity;
  replayed: boolean;
}

export interface ClaimJobInput {
  tenantId: string;
  jobId: string;
  expectedJobVersion: number;
  nodeId: string;
  workerId?: string;
  attemptId: string;
  leaseId: string;
  transitionId: string;
  idempotencyKey: string;
  actor: ActorRef;
  acquiredAt: string;
  expiresAt: string;
}

export interface ExpireLeaseInput {
  tenantId: string;
  leaseId: string;
  jobId: string;
  attemptId: string;
  expectedLeaseVersion: number;
  expectedJobVersion: number;
  expectedAttemptVersion: number;
  epoch: number;
  transitionId: string;
  idempotencyKey: string;
  actor: ActorRef;
  occurredAt: string;
}

export interface RenewLeaseInput {
  tenantId: string;
  leaseId: string;
  expectedVersion: number;
  epoch: number;
  renewalId: string;
  idempotencyKey: string;
  renewedAt: string;
  expiresAt: string;
}

export interface ResolveApprovalInput {
  tenantId: string;
  approvalId: string;
  expectedVersion: number;
  toState: "approved" | "denied" | "revoked";
  policyDecisionId: string;
  transitionId: string;
  idempotencyKey: string;
  actor: ActorRef;
  occurredAt: string;
  safeReasonCode?: string;
}

export interface AuthorizeEffectInput {
  tenantId: string;
  effectIntentId: string;
  expectedVersion: number;
  policyDecisionId: string;
  transitionId: string;
  idempotencyKey: string;
  actor: ActorRef;
  occurredAt: string;
}

const transitionPatchFields: Record<EntityKind, ReadonlySet<string>> = {
  request: new Set(), workflow: new Set(), job: new Set(),
  attempt: new Set(["startedAt", "finishedAt", "safeFailureCode"]),
  lease: new Set(["expiresAt", "renewedAt"]),
  checkpoint: new Set(["verifiedAt"]),
  effect_intent: new Set(["destinationReceipt", "safeFailureCode"]),
  approval: new Set(["decidedBy", "decidedAt", "safeReasonCode"]),
  service: new Set(["lastObservedAt", "lastHealthyAt", "safeStatusCode"]),
  schedule: new Set(), incident: new Set(["resolvedAt"]),
  artifact_manifest: new Set(["opaqueLocator"]),
  node: new Set(["enrolledAt", "lastSeenAt", "quarantineReasonCode"]),
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function extras(entity: DomainEntity): Array<[string, unknown]> {
  switch (entity.kind) {
    case "request": return [["project_id", entity.projectId ?? null], ["idempotency_key", entity.idempotencyKey]];
    case "workflow": return [["request_id", entity.requestId], ["project_id", entity.projectId], ["definition_digest", entity.definitionDigest]];
    case "job": return [["workflow_id", entity.workflowId], ["project_id", entity.projectId], ["priority", entity.priority], ["required_capability", entity.requiredCapability], ["authority_digest", entity.authority.digest]];
    case "attempt": return [["job_id", entity.jobId], ["attempt_number", entity.attemptNumber], ["worker_id", entity.workerId ?? null], ["node_id", entity.nodeId ?? null], ["lease_epoch", entity.leaseEpoch ?? null]];
    case "lease": return [["job_id", entity.jobId], ["attempt_id", entity.attemptId], ["node_id", entity.nodeId], ["epoch", entity.epoch], ["acquired_at", entity.acquiredAt], ["expires_at", entity.expiresAt], ["renewed_at", entity.renewedAt ?? null]];
    case "checkpoint": return [["attempt_id", entity.attemptId], ["sequence", entity.sequence], ["payload_digest", entity.payloadDigest]];
    case "effect_intent": return [["job_id", entity.jobId], ["attempt_id", entity.attemptId], ["approval_id", entity.approvalId ?? null], ["operation_digest", entity.operationDigest], ["destination", entity.destination], ["idempotency_key", entity.idempotencyKey]];
    case "approval": return [["operation_digest", entity.operationDigest], ["expires_at", entity.expiresAt]];
    case "service": return [["project_id", entity.projectId]];
    case "schedule": return [["project_id", entity.projectId], ["next_run_at", entity.nextRunAt ?? null]];
    case "incident": return [["project_id", entity.projectId ?? null], ["node_id", entity.nodeId ?? null], ["severity", entity.severity]];
    case "artifact_manifest": return [["project_id", entity.projectId], ["workflow_id", entity.workflowId ?? null], ["job_id", entity.jobId], ["attempt_id", entity.attemptId], ["content_hash", entity.contentHash]];
    case "node": return [["identity_key_id", entity.identityKeyId]];
  }
}

export class CanonicalStore {
  constructor(private readonly db: DatabaseClient) {}

  async create(entity: DomainEntity): Promise<void> {
    const validated = domainEntitySchema.parse(entity) as DomainEntity;
    assertNoSecretMaterial(validated, `${validated.kind} record`);
    if (validated.state !== initialStates[validated.kind]) {
      throw new Error(`${validated.kind} must be created in ${initialStates[validated.kind]} state`);
    }
    if (validated.kind === "attempt" || validated.kind === "lease") throw new Error("Attempts and leases must be created by claimReadyJob");
    await this.db.transaction(async (tx) => {
      if (validated.kind === "workflow") {
        const request = await this.requireWith(tx, validated.tenantId, "request", validated.requestId) as DomainEntity & { projectId?: string };
        if (request.projectId && request.projectId !== validated.projectId) throw new Error("Workflow project does not match its request");
      }
      if (validated.kind === "job") {
        assertAuthorityDigest(validated.authority);
        const workflow = await this.requireWith(tx, validated.tenantId, "workflow", validated.workflowId) as DomainEntity & { projectId: string };
        if (workflow.projectId !== validated.projectId || validated.authority.projectId !== validated.projectId) {
          throw new Error("Job project and authority must match its workflow");
        }
      }
      if (validated.kind === "effect_intent") {
        const jobResult = await tx.query<{ payload: JobRecord }>(
          `SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2`,
          [validated.tenantId, validated.jobId],
        );
        const job = jobResult.rows[0]?.payload;
        if (!job) throw new Error("Effect job not found");
        const attempt = await this.requireWith(tx, validated.tenantId, "attempt", validated.attemptId) as AttemptRecord;
        if (attempt.jobId !== job.id) throw new Error("Effect attempt does not belong to its job");
        if (!["leased", "running", "waiting"].includes(attempt.state)
          || !["leased", "running", "waiting_approval"].includes(job.state)) {
          throw new Error("Effect intent requires an active job attempt");
        }
        if (computeEffectOperationDigest(validated, job.projectId) !== validated.operationDigest) {
          throw new Error("Effect operation digest mismatch");
        }
        if (!job.authority.allowedOperations.includes(validated.operation)) throw new Error("Effect operation exceeds job authority");
        if (job.authority.effectPolicy === "none") throw new Error("Job authority forbids external effects");
        if (Date.parse(job.authority.expiresAt) <= Date.parse(validated.createdAt)) throw new Error("Job authority has expired");
        if (job.authority.networkPolicy === "allowlist" && !job.authority.allowedNetworkDestinations.includes(validated.destination)) {
          throw new Error("Effect destination exceeds job authority");
        }
        if (job.authority.effectPolicy === "approval_required" && !validated.approvalId) throw new Error("Job authority requires effect approval");
        if (validated.approvalId) {
          const approval = await this.requireWith(tx, validated.tenantId, "approval", validated.approvalId) as ApprovalRecord;
          if (approval.operationDigest !== validated.operationDigest || approval.risk !== validated.risk) {
            throw new Error("Effect approval is not bound to the exact operation and risk");
          }
        }
      }
      if (validated.kind === "artifact_manifest") {
        const job = await this.requireWith(tx, validated.tenantId, "job", validated.jobId) as JobRecord;
        const attempt = await this.requireWith(tx, validated.tenantId, "attempt", validated.attemptId) as AttemptRecord;
        if (attempt.jobId !== job.id || validated.projectId !== job.projectId
          || (validated.workflowId && validated.workflowId !== job.workflowId)) {
          throw new Error("Artifact lineage does not match its job and attempt");
        }
      }
      if (validated.kind === "checkpoint") {
        const attempt = await tx.query<{ id: string }>(
          `SELECT id FROM control_attempts WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [validated.tenantId, validated.attemptId],
        );
        if (!attempt.rows.length) throw new Error("Checkpoint attempt not found");
        const latest = await tx.query<{ sequence: number | null }>(
          `SELECT max(sequence)::int AS sequence FROM control_checkpoints WHERE tenant_id=$1 AND attempt_id=$2`,
          [validated.tenantId, validated.attemptId],
        );
        if (latest.rows[0]?.sequence != null && validated.sequence <= latest.rows[0].sequence) {
          throw new Error("Checkpoint sequence must increase monotonically");
        }
      }
      await this.insertWith(tx, validated);
      if (validated.kind === "job") {
        for (const dependencyId of validated.dependsOnJobIds) {
          await tx.query(
            `INSERT INTO control_job_dependencies (tenant_id,job_id,depends_on_job_id) VALUES ($1,$2,$3)`,
            [validated.tenantId, validated.id, dependencyId],
          );
        }
      }
    });
  }

  async get(tenantId: string, kind: EntityKind, id: string): Promise<DomainEntity | undefined> {
    return this.getWith(this.db, tenantId, kind, id);
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    return this.db.transaction((tx) => this.transitionWith(tx, input, false));
  }

  async claimReadyJob(input: ClaimJobInput): Promise<{ job: JobRecord; attempt: AttemptRecord; lease: LeaseRecord; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      const prior = await tx.query<{ entity_id: string; safe_metadata: { attemptId?: string; leaseId?: string } }>(
        `SELECT entity_id,safe_metadata FROM control_transition_events WHERE tenant_id=$1 AND entity_kind='job' AND idempotency_key=$2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (prior.rows.length) {
        if (prior.rows[0].entity_id !== input.jobId || prior.rows[0].safe_metadata.attemptId !== input.attemptId
          || prior.rows[0].safe_metadata.leaseId !== input.leaseId) throw new Error("Claim idempotency key reused with different lineage");
        const job = await this.requireWith(tx, input.tenantId, "job", input.jobId) as JobRecord;
        const attempt = await this.requireWith(tx, input.tenantId, "attempt", input.attemptId) as AttemptRecord;
        const lease = await this.requireWith(tx, input.tenantId, "lease", input.leaseId) as LeaseRecord;
        return { job, attempt, lease, replayed: true };
      }

      const jobRow = await tx.query<{ payload: JobRecord }>(
        `SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.jobId],
      );
      const job = jobRow.rows[0]?.payload;
      if (!job) throw new Error("Job not found");
      if (job.state !== "ready" || job.version !== input.expectedJobVersion) throw new Error("Job is not claimable at expected version");
      if (Date.parse(job.authority.expiresAt) <= Date.parse(input.acquiredAt)) throw new Error("Job authority has expired");
      if (Date.parse(input.expiresAt) > Date.parse(job.authority.expiresAt)
        || Date.parse(input.expiresAt) - Date.parse(input.acquiredAt) > job.authority.maxDurationSeconds * 1_000) {
        throw new Error("Lease duration exceeds job authority");
      }

      const nodeRow = await tx.query<{ state: string }>(
        `SELECT state FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.nodeId],
      );
      if (nodeRow.rows[0]?.state !== "active") throw new Error("Node is not active");

      const sequence = await tx.query<{ next_attempt: number; next_epoch: number }>(
        `SELECT
          COALESCE((SELECT max(attempt_number)+1 FROM control_attempts WHERE job_id=$1),1)::int AS next_attempt,
          COALESCE((SELECT max(epoch)+1 FROM control_leases WHERE job_id=$1),1)::int AS next_epoch`,
        [input.jobId],
      );
      const next = sequence.rows[0];

      const attemptOffered: AttemptRecord = {
        contractVersion: job.contractVersion,
        kind: "attempt",
        id: input.attemptId,
        tenantId: input.tenantId,
        jobId: input.jobId,
        attemptNumber: next.next_attempt,
        state: "offered",
        version: 0,
        workerId: input.workerId,
        nodeId: input.nodeId,
        leaseEpoch: next.next_epoch,
        offeredAt: input.acquiredAt,
        createdAt: input.acquiredAt,
        updatedAt: input.acquiredAt,
      };
      await this.insertWith(tx, attemptOffered);

      const attemptResult = await this.transitionWith(tx, {
        tenantId: input.tenantId, kind: "attempt", entityId: input.attemptId,
        expectedVersion: 0, toState: "leased", transitionId: `${input.transitionId}:attempt`,
        idempotencyKey: `${input.idempotencyKey}:attempt`, actor: input.actor, occurredAt: input.acquiredAt,
      }, true);

      const lease: LeaseRecord = {
        contractVersion: job.contractVersion,
        kind: "lease",
        id: input.leaseId,
        tenantId: input.tenantId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        nodeId: input.nodeId,
        epoch: next.next_epoch,
        state: "active",
        version: 0,
        acquiredAt: input.acquiredAt,
        expiresAt: input.expiresAt,
        createdAt: input.acquiredAt,
        updatedAt: input.acquiredAt,
      };
      await this.insertWith(tx, lease);

      const jobResult = await this.transitionWith(tx, {
        tenantId: input.tenantId, kind: "job", entityId: input.jobId,
        expectedVersion: input.expectedJobVersion, toState: "leased", transitionId: input.transitionId,
        idempotencyKey: input.idempotencyKey, actor: input.actor, occurredAt: input.acquiredAt,
        safeMetadata: { attemptId: input.attemptId, leaseId: input.leaseId, leaseEpoch: next.next_epoch },
      }, true);
      return { job: jobResult.entity as JobRecord, attempt: attemptResult.entity as AttemptRecord, lease, replayed: false };
    });
  }

  async expireLease(input: ExpireLeaseInput): Promise<{ job: JobRecord; attempt: AttemptRecord; lease: LeaseRecord; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      const prior = await tx.query<{ entity_id: string }>(
        `SELECT entity_id FROM control_transition_events WHERE tenant_id=$1 AND entity_kind='lease' AND idempotency_key=$2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (prior.rows.length) {
        if (prior.rows[0].entity_id !== input.leaseId) throw new Error("Expiry idempotency key reused for another lease");
        const lease = await this.requireWith(tx, input.tenantId, "lease", input.leaseId) as LeaseRecord;
        if (lease.jobId !== input.jobId || lease.attemptId !== input.attemptId || lease.epoch !== input.epoch) {
          throw new Error("Expiry replay lineage or epoch mismatch");
        }
        const attempt = await this.requireWith(tx, input.tenantId, "attempt", input.attemptId) as AttemptRecord;
        const job = await this.requireWith(tx, input.tenantId, "job", input.jobId) as JobRecord;
        return { job, attempt, lease, replayed: true };
      }

      const lease = await this.requireWith(tx, input.tenantId, "lease", input.leaseId) as LeaseRecord;
      if (lease.jobId !== input.jobId || lease.attemptId !== input.attemptId || lease.epoch !== input.epoch) {
        throw new Error("Lease lineage or epoch mismatch");
      }
      if (lease.state !== "active" || Date.parse(lease.expiresAt) > Date.parse(input.occurredAt)) {
        throw new Error("Lease is not eligible for expiry");
      }

      const leaseResult = await this.transitionWith(tx, {
        tenantId: input.tenantId, kind: "lease", entityId: input.leaseId,
        expectedVersion: input.expectedLeaseVersion, toState: "expired", transitionId: input.transitionId,
        idempotencyKey: input.idempotencyKey, actor: input.actor, occurredAt: input.occurredAt,
      }, true);
      const attemptResult = await this.transitionWith(tx, {
        tenantId: input.tenantId, kind: "attempt", entityId: input.attemptId,
        expectedVersion: input.expectedAttemptVersion, toState: "orphaned", transitionId: `${input.transitionId}:attempt`,
        idempotencyKey: `${input.idempotencyKey}:attempt`, actor: input.actor, occurredAt: input.occurredAt,
        recordPatch: { finishedAt: input.occurredAt },
      }, true);
      const currentJob = await this.requireWith(tx, input.tenantId, "job", input.jobId) as JobRecord;
      const nextJobState = currentJob.state === "leased" ? "ready" : "orphaned";
      const jobResult = await this.transitionWith(tx, {
        tenantId: input.tenantId, kind: "job", entityId: input.jobId,
        expectedVersion: input.expectedJobVersion, toState: nextJobState, transitionId: `${input.transitionId}:job`,
        idempotencyKey: `${input.idempotencyKey}:job`, actor: input.actor, occurredAt: input.occurredAt,
        safeMetadata: { expiredLeaseId: input.leaseId, leaseEpoch: input.epoch },
      }, true);
      return {
        lease: leaseResult.entity as LeaseRecord,
        attempt: attemptResult.entity as AttemptRecord,
        job: jobResult.entity as JobRecord,
        replayed: false,
      };
    });
  }

  async renewLease(input: RenewLeaseInput): Promise<{ lease: LeaseRecord; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      const prior = await tx.query<{ payload: { leaseId: string; epoch: number; expiresAt: string } }>(
        `SELECT payload FROM control_outbox WHERE tenant_id=$1 AND topic='lease.renewed' AND idempotency_key=$2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (prior.rows.length) {
        if (prior.rows[0].payload.leaseId !== input.leaseId || prior.rows[0].payload.epoch !== input.epoch
          || prior.rows[0].payload.expiresAt !== input.expiresAt) throw new Error("Renewal idempotency key reused with different content");
        return { lease: await this.requireWith(tx, input.tenantId, "lease", input.leaseId) as LeaseRecord, replayed: true };
      }

      const row = await tx.query<{ payload: LeaseRecord }>(
        `SELECT payload FROM control_leases WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.leaseId],
      );
      const current = row.rows[0]?.payload;
      if (!current) throw new Error("Lease not found");
      if (current.state !== "active" || current.epoch !== input.epoch || current.version !== input.expectedVersion) {
        throw new Error("Lease renewal has stale state, epoch, or version");
      }
      if (Date.parse(input.renewedAt) > Date.parse(current.expiresAt)) throw new Error("Expired leases cannot be renewed");
      if (Date.parse(input.expiresAt) <= Date.parse(current.expiresAt)) throw new Error("Renewal must extend expiry");
      const job = await this.requireWith(tx, input.tenantId, "job", current.jobId) as JobRecord;
      if (Date.parse(input.expiresAt) > Date.parse(job.authority.expiresAt)
        || Date.parse(input.expiresAt) - Date.parse(current.acquiredAt) > job.authority.maxDurationSeconds * 1_000) {
        throw new Error("Renewal exceeds job authority");
      }

      const next = domainEntitySchema.parse({
        ...current, expiresAt: input.expiresAt, renewedAt: input.renewedAt,
        version: current.version + 1, updatedAt: input.renewedAt,
      }) as LeaseRecord;
      const updated = await tx.query(
        `UPDATE control_leases SET version=$1,expires_at=$2,renewed_at=$3,payload=$4::jsonb,updated_at=$3
         WHERE tenant_id=$5 AND id=$6 AND version=$7 AND state='active' AND epoch=$8 RETURNING id`,
        [next.version,next.expiresAt,next.renewedAt,json(next),input.tenantId,input.leaseId,current.version,input.epoch],
      );
      if (updated.rows.length !== 1) throw new Error("Concurrent lease renewal conflict");
      await tx.query(
        `INSERT INTO control_outbox (id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,available_at,payload)
         VALUES ($1,$2,'lease.renewed','lease',$3,$4,'pending',$5,$6::jsonb)`,
        [input.renewalId,input.tenantId,input.leaseId,input.idempotencyKey,input.renewedAt,
          json({ leaseId: input.leaseId, epoch: input.epoch, expiresAt: input.expiresAt, version: next.version })],
      );
      return { lease: next, replayed: false };
    });
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<TransitionResult> {
    return this.db.transaction(async (tx) => {
      const approval = await this.requireWith(tx, input.tenantId, "approval", input.approvalId) as ApprovalRecord;
      const linkedEffect = await tx.query<{ project_id: string }>(
        `SELECT j.project_id FROM control_effect_intents e
         JOIN control_jobs j ON j.tenant_id=e.tenant_id AND j.id=e.job_id
         WHERE e.tenant_id=$1 AND e.approval_id=$2`,
        [input.tenantId, input.approvalId],
      );
      const decision = await this.requirePolicyDecision(tx, {
        tenantId: input.tenantId,
        decisionId: input.policyDecisionId,
        identityId: input.actor.actorId,
        actorType: input.actor.actorType,
        action: "approval.decide",
        resourceType: "approval",
        resourceId: input.approvalId,
        projectId: linkedEffect.rows[0]?.project_id,
        risk: approval.risk,
        externalEffect: true,
        requiredRoleKey: approval.requiredActorType,
        occurredAt: input.occurredAt,
      });
      if (input.toState === "approved" && Date.parse(approval.expiresAt) <= Date.parse(input.occurredAt)) {
        throw new Error("Expired approval cannot be approved");
      }
      if ((approval.risk === "high" || approval.risk === "critical") && !decision.strong_factor_evidence_id) {
        throw new Error("High-risk approval requires strong-factor evidence");
      }
      return this.transitionWith(tx, {
        tenantId: input.tenantId,
        kind: "approval",
        entityId: input.approvalId,
        expectedVersion: input.expectedVersion,
        toState: input.toState,
        transitionId: input.transitionId,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        occurredAt: input.occurredAt,
        safeMetadata: { policyDecisionId: input.policyDecisionId },
        recordPatch: {
          decidedBy: input.actor,
          decidedAt: input.occurredAt,
          ...(input.safeReasonCode ? { safeReasonCode: input.safeReasonCode } : {}),
        },
      }, true);
    });
  }

  async authorizeEffect(input: AuthorizeEffectInput): Promise<TransitionResult> {
    return this.db.transaction(async (tx) => {
      const replay = await tx.query<{ entity_id: string; to_state: string }>(
        `SELECT entity_id,to_state FROM control_transition_events
         WHERE tenant_id=$1 AND entity_kind='effect_intent' AND idempotency_key=$2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (replay.rows.length) {
        if (replay.rows[0].entity_id !== input.effectIntentId || replay.rows[0].to_state !== "authorized") {
          throw new Error("Idempotency key conflicts with a different effect authorization");
        }
        return { entity: await this.requireWith(tx, input.tenantId, "effect_intent", input.effectIntentId), replayed: true };
      }

      const effectRow = await tx.query<{ payload: EffectIntentRecord }>(
        `SELECT payload FROM control_effect_intents WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.effectIntentId],
      );
      const effect = effectRow.rows[0]?.payload;
      if (!effect) throw new Error("effect_intent not found");
      const job = await this.requireWith(tx, input.tenantId, "job", effect.jobId) as JobRecord;
      const decision = await this.requirePolicyDecision(tx, {
        tenantId: input.tenantId,
        decisionId: input.policyDecisionId,
        identityId: input.actor.actorId,
        actorType: input.actor.actorType,
        action: "effect.authorize",
        resourceType: "effect_intent",
        resourceId: input.effectIntentId,
        projectId: job.projectId,
        risk: effect.risk,
        externalEffect: true,
        occurredAt: input.occurredAt,
      });
      if ((effect.risk === "high" || effect.risk === "critical") && !decision.strong_factor_evidence_id) {
        throw new Error("High-risk effect authorization requires strong-factor evidence");
      }

      if (effect.approvalId) {
        const approvalRow = await tx.query<{ payload: ApprovalRecord }>(
          `SELECT payload FROM control_approvals WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [input.tenantId, effect.approvalId],
        );
        const approval = approvalRow.rows[0]?.payload;
        if (!approval) throw new Error("approval not found");
        if (approval.state !== "approved") throw new Error("Effect approval is not approved");
        if (approval.operationDigest !== effect.operationDigest) throw new Error("Effect and approval operation digests differ");
        if (approval.risk !== effect.risk) throw new Error("Effect and approval risk classifications differ");
        if (Date.parse(approval.expiresAt) <= Date.parse(input.occurredAt)) throw new Error("Effect approval has expired");
        await tx.query(
          `INSERT INTO control_approval_consumptions
            (tenant_id,approval_id,effect_intent_id,policy_decision_id,operation_digest,consumed_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [input.tenantId, approval.id, effect.id, input.policyDecisionId, effect.operationDigest, input.occurredAt],
        );
      } else if (effect.risk === "high" || effect.risk === "critical") {
        throw new Error("High-risk effect requires an approval");
      }

      return this.transitionWith(tx, {
        tenantId: input.tenantId,
        kind: "effect_intent",
        entityId: input.effectIntentId,
        expectedVersion: input.expectedVersion,
        toState: "authorized",
        transitionId: input.transitionId,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        occurredAt: input.occurredAt,
        safeMetadata: { policyDecisionId: input.policyDecisionId, approvalId: effect.approvalId },
      }, true);
    });
  }

  private async insertWith(tx: DatabaseSession, entity: DomainEntity): Promise<void> {
    domainEntitySchema.parse(entity);
    const config = entityConfigs[entity.kind];
    const fields: Array<[string, unknown, boolean?]> = [
      ["id", entity.id], ["tenant_id", entity.tenantId], ["state", entity.state],
      ["version", entity.version], ["payload", json(entity), true],
      ["created_at", entity.createdAt], ["updated_at", entity.updatedAt],
      ...extras(entity).map(([name, value]) => [name, value] as [string, unknown]),
    ];
    const placeholders = fields.map((field, index) => `$${index + 1}${field[2] ? "::jsonb" : ""}`);
    await tx.query(
      `INSERT INTO ${config.table} (${fields.map(([name]) => name).join(",")}) VALUES (${placeholders.join(",")})`,
      fields.map(([, value]) => value),
    );
  }

  private async getWith(tx: DatabaseSession, tenantId: string, kind: EntityKind, id: string): Promise<DomainEntity | undefined> {
    const result = await tx.query<{ payload: DomainEntity }>(
      `SELECT payload FROM ${entityConfigs[kind].table} WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
    return result.rows[0] ? domainEntitySchema.parse(result.rows[0].payload) as DomainEntity : undefined;
  }

  private async requireWith(tx: DatabaseSession, tenantId: string, kind: EntityKind, id: string): Promise<DomainEntity> {
    const entity = await this.getWith(tx, tenantId, kind, id);
    if (!entity) throw new Error(`${kind} ${id} not found`);
    return entity;
  }

  private async requirePolicyDecision(tx: DatabaseSession, input: {
    tenantId: string;
    decisionId: string;
    identityId: string;
    actorType: ActorRef["actorType"];
    action: string;
    resourceType: string;
    resourceId: string;
    projectId?: string;
    risk: "low" | "medium" | "high" | "critical";
    externalEffect: boolean;
    requiredRoleKey?: "owner" | "operator" | "policy";
    occurredAt: string;
  }): Promise<{ strong_factor_evidence_id?: string }> {
    const result = await tx.query<{
      identity_id: string; action: string; resource_type: string; resource_id: string; project_id?: string;
      actor_type: string; identity_state: string; risk: string; external_effect: boolean; grant_ids: string[];
      allowed: boolean; expires_at: string; strong_factor_evidence_id?: string;
    }>(
      `SELECT d.identity_id,d.action,d.resource_type,d.resource_id,d.project_id,d.risk,d.external_effect,
        d.grant_ids,d.allowed,d.expires_at,d.strong_factor_evidence_id,i.actor_type,i.state AS identity_state
       FROM control_policy_decisions d
       JOIN control_identities i ON i.tenant_id=d.tenant_id AND i.id=d.identity_id
       WHERE d.tenant_id=$1 AND d.id=$2`,
      [input.tenantId, input.decisionId],
    );
    const decision = result.rows[0];
    if (!decision || !decision.allowed || decision.identity_state !== "active") throw new Error("Allowed policy decision for an active identity not found");
    if (decision.identity_id !== input.identityId || decision.actor_type !== input.actorType || decision.action !== input.action
      || decision.resource_type !== input.resourceType || decision.resource_id !== input.resourceId
      || (decision.project_id ?? undefined) !== input.projectId || decision.risk !== input.risk
      || decision.external_effect !== input.externalEffect) {
      throw new Error("Policy decision is not bound to this actor and operation");
    }
    if (Date.parse(decision.expires_at) <= Date.parse(input.occurredAt)) throw new Error("Policy decision has expired");
    const roles = await tx.query<{ id: string; role_key: string; expires_at?: string; revoked_at?: string }>(
      `SELECT id,role_key,expires_at,revoked_at FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2`,
      [input.tenantId, input.identityId],
    );
    const matched = new Set(decision.grant_ids);
    const activeMatchedRoles = roles.rows.filter((grant) => matched.has(grant.id)
      && (!grant.expires_at || Date.parse(grant.expires_at) > Date.parse(input.occurredAt))
      && (!grant.revoked_at || Date.parse(grant.revoked_at) > Date.parse(input.occurredAt)));
    if (!activeMatchedRoles.length) throw new Error("Policy decision grants are no longer active");
    if (input.requiredRoleKey) {
      const acceptedRoles = input.requiredRoleKey === "operator" ? new Set(["operator", "owner"]) : new Set([input.requiredRoleKey]);
      if (!activeMatchedRoles.some((grant) => acceptedRoles.has(grant.role_key))) {
        throw new Error("Policy decision does not satisfy the approval role requirement");
      }
    }
    return decision;
  }

  private async transitionWith(tx: DatabaseSession, input: TransitionInput, coordinated: boolean): Promise<TransitionResult> {
    assertNoSecretMaterial(input.safeMetadata ?? {}, "Transition safe metadata");
    assertNoSecretMaterial(input.recordPatch ?? {}, "Transition record patch");
    const existing = await tx.query<{ entity_id: string; to_state: string; from_version: number; actor_id: string; actor_type: string; occurred_at: string }>(
      `SELECT entity_id,to_state,from_version,actor_id,actor_type,occurred_at FROM control_transition_events WHERE tenant_id=$1 AND entity_kind=$2 AND idempotency_key=$3`,
      [input.tenantId, input.kind, input.idempotencyKey],
    );
    if (existing.rows.length) {
      const prior = existing.rows[0];
      if (prior.entity_id !== input.entityId || prior.to_state !== input.toState || prior.from_version !== input.expectedVersion
        || prior.actor_id !== input.actor.actorId || prior.actor_type !== input.actor.actorType
        || new Date(prior.occurred_at).toISOString() !== new Date(input.occurredAt).toISOString()) {
        throw new Error("Idempotency key conflicts with a different transition");
      }
      return { entity: await this.requireWith(tx, input.tenantId, input.kind, input.entityId), replayed: true };
    }

    const config = entityConfigs[input.kind];
    const row = await tx.query<{ payload: DomainEntity }>(
      `SELECT payload FROM ${config.table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [input.tenantId, input.entityId],
    );
    const current = row.rows[0]?.payload;
    if (!current) throw new Error(`${input.kind} not found`);
    if (Date.parse(input.occurredAt) < Date.parse(current.updatedAt)) throw new Error("Transition timestamp precedes current entity state");
    if (current.version !== input.expectedVersion) throw new Error(`Version conflict: expected ${input.expectedVersion}, found ${current.version}`);
    if (!config.transitions[current.state]?.includes(input.toState)) throw new Error(`Illegal ${input.kind} transition: ${current.state} -> ${input.toState}`);

    if (!coordinated && (input.kind === "attempt" || input.kind === "lease" || input.kind === "approval" || input.kind === "effect_intent")) {
      throw new Error(`${input.kind} transitions require a coordinated repository operation`);
    }
    if (!coordinated && input.kind === "job" && current.state !== "proposed") {
      throw new Error(`Job transition ${current.state} -> ${input.toState} requires a coordinated repository operation`);
    }
    if (input.kind === "job" && current.state === "proposed" && input.toState === "ready") {
      const job = current as JobRecord;
      if (Date.parse(job.authority.expiresAt) <= Date.parse(input.occurredAt)) throw new Error("Job authority has expired");
      const blocked = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM control_job_dependencies d
         JOIN control_jobs dependency ON dependency.tenant_id=d.tenant_id AND dependency.id=d.depends_on_job_id
         WHERE d.tenant_id=$1 AND d.job_id=$2 AND dependency.state <> 'succeeded'`,
        [input.tenantId, input.entityId],
      );
      if (blocked.rows[0]?.count !== "0") throw new Error("Job dependencies are not satisfied");
    }

    for (const key of Object.keys(input.recordPatch ?? {})) {
      if (!transitionPatchFields[input.kind].has(key)) throw new Error(`Transition patch cannot modify ${input.kind}.${key}`);
    }
    const next = domainEntitySchema.parse({
      ...current,
      ...(input.recordPatch ?? {}),
      state: input.toState,
      version: current.version + 1,
      updatedAt: input.occurredAt,
    }) as DomainEntity;
    const updated = await tx.query<{ payload: DomainEntity }>(
      `UPDATE ${config.table} SET state=$1,version=$2,payload=$3::jsonb,updated_at=$4
       WHERE tenant_id=$5 AND id=$6 AND version=$7 AND state=$8 RETURNING payload`,
      [next.state, next.version, json(next), next.updatedAt, input.tenantId, input.entityId, current.version, current.state],
    );
    if (updated.rows.length !== 1) throw new Error("Concurrent transition conflict");

    await tx.query(
      `INSERT INTO control_transition_events (
        id,tenant_id,entity_kind,entity_id,from_state,to_state,from_version,to_version,
        actor_id,actor_type,idempotency_key,safe_metadata,occurred_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [input.transitionId,input.tenantId,input.kind,input.entityId,current.state,next.state,current.version,next.version,
        input.actor.actorId,input.actor.actorType,input.idempotencyKey,json(input.safeMetadata ?? {}),input.occurredAt],
    );
    await tx.query(
      `INSERT INTO control_outbox (
        id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,available_at,payload
      ) VALUES ($1,$2,'domain.transition',$3,$4,$5,'pending',$6,$7::jsonb)`,
      [`outbox:${input.transitionId}`,input.tenantId,input.kind,input.entityId,input.idempotencyKey,input.occurredAt,
        json({ entityKind: input.kind, entityId: input.entityId, fromState: current.state, toState: next.state, version: next.version })],
    );
    return { entity: next, replayed: false };
  }
}
