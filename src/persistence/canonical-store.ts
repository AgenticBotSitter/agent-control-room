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
  type RequestRecord,
  type TransitionTable,
  type WorkflowRecord,
} from "../domain/v1";
import { isRepositorySimulationDatabaseClientV1, type DatabaseClient, type DatabaseSession } from "./database";
import { assertAuthorityDigest, assertNoSecretMaterial, computeEffectOperationDigest, sha256Digest } from "../security";
import { isHostProxyV1 } from "../security/host-value";
import { actionInboxItemSchemaV1, type ActionInboxItemV1 } from "../operator-surfaces/v1";
import { acquireReadyFrontierCanonicalPromotionAuthorizationV1 } from "../ready-frontier/v1/promotion-service";
import { evaluatePolicy, type RoleGrant } from "../security/policy";
import { z } from "zod";

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

export interface ProposedWorkBundle {
  request: RequestRecord;
  workflow: WorkflowRecord;
  job: JobRecord;
}

export interface ProposedWorkBundleResult extends ProposedWorkBundle {
  replayed: boolean;
}

export interface ProposedWorkBundleWithActionInbox extends ProposedWorkBundle {
  actionInbox: ActionInboxItemV1;
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

const canonicalStores = new WeakSet<object>();
const repositorySimulationCanonicalStores = new WeakSet<object>();

function databaseMethod(value: object, name: "query" | "transaction" | "transactionWithPreCommitCheck"):
  ((...args: never[]) => unknown) | undefined {
  let current: object | null = value;
  const visited = new Set<object>();
  while (current && !visited.has(current)) {
    if (isHostProxyV1(current)) return undefined;
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return !descriptor.get && !descriptor.set && typeof descriptor.value === "function"
      ? descriptor.value as (...args: never[]) => unknown : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

export class CanonicalStore {
  readonly #session: DatabaseSession;
  readonly #transaction: DatabaseClient["transaction"];
  readonly #transactionWithPreCommitCheck: DatabaseClient["transactionWithPreCommitCheck"];

  constructor(db: DatabaseClient) {
    if (!db || typeof db !== "object" || isHostProxyV1(db)) throw new Error("Invalid canonical database client");
    const query = databaseMethod(db, "query") as DatabaseClient["query"] | undefined;
    const transaction = databaseMethod(db, "transaction") as DatabaseClient["transaction"] | undefined;
    const transactionWithPreCommitCheck = databaseMethod(db, "transactionWithPreCommitCheck") as
      DatabaseClient["transactionWithPreCommitCheck"] | undefined;
    if (!query || !transaction || !transactionWithPreCommitCheck) throw new Error("Invalid canonical database client");
    this.#session = Object.freeze({
      query: <T = Record<string, unknown>>(statement: string, params?: unknown[]) => query.call(db, statement, params) as Promise<{ rows: T[] }>,
    });
    this.#transaction = (<T>(callback: (session: DatabaseSession) => Promise<T>) =>
      transaction.call(db, callback) as Promise<T>) as DatabaseClient["transaction"];
    this.#transactionWithPreCommitCheck = (<T>(callback: (session: DatabaseSession) => Promise<T>, preCommitCheck: () => void | Promise<void>) =>
      transactionWithPreCommitCheck.call(db, callback, preCommitCheck) as Promise<T>) as DatabaseClient["transactionWithPreCommitCheck"];
    canonicalStores.add(this);
    if (isRepositorySimulationDatabaseClientV1(db)) repositorySimulationCanonicalStores.add(this);
    Object.freeze(this);
  }

  async create(entity: DomainEntity): Promise<void> {
    const validated = domainEntitySchema.parse(entity) as DomainEntity;
    assertNoSecretMaterial(validated, `${validated.kind} record`);
    if (validated.state !== initialStates[validated.kind]) {
      throw new Error(`${validated.kind} must be created in ${initialStates[validated.kind]} state`);
    }
    if (validated.kind === "attempt" || validated.kind === "lease") throw new Error("Attempts and leases must be created by claimReadyJob");
    await this.#transaction(async (tx) => {
      if (validated.kind === "workflow") {
        const request = await this.#requireWith(tx, validated.tenantId, "request", validated.requestId) as DomainEntity & { projectId?: string };
        if (request.projectId && request.projectId !== validated.projectId) throw new Error("Workflow project does not match its request");
      }
      if (validated.kind === "job") {
        assertAuthorityDigest(validated.authority);
        const workflow = await this.#requireWith(tx, validated.tenantId, "workflow", validated.workflowId) as DomainEntity & { projectId: string };
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
        const attempt = await this.#requireWith(tx, validated.tenantId, "attempt", validated.attemptId) as AttemptRecord;
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
          const approval = await this.#requireWith(tx, validated.tenantId, "approval", validated.approvalId) as ApprovalRecord;
          if (approval.operationDigest !== validated.operationDigest || approval.risk !== validated.risk) {
            throw new Error("Effect approval is not bound to the exact operation and risk");
          }
        }
      }
      if (validated.kind === "artifact_manifest") {
        const job = await this.#requireWith(tx, validated.tenantId, "job", validated.jobId) as JobRecord;
        const attempt = await this.#requireWith(tx, validated.tenantId, "attempt", validated.attemptId) as AttemptRecord;
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
      await this.#insertWith(tx, validated);
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

  /**
   * Atomically creates the non-runnable canonical records produced by an
   * already-reviewed proposal. Exact retries are safe; changed reuse of any
   * identifier fails closed. This boundary cannot make a job ready or create
   * an attempt, lease, approval, outbox entry, or effect intent.
   */
  async createProposedWorkBundle(input: ProposedWorkBundle): Promise<ProposedWorkBundleResult> {
    const request = domainEntitySchema.parse(input.request) as RequestRecord;
    const workflow = domainEntitySchema.parse(input.workflow) as WorkflowRecord;
    const job = domainEntitySchema.parse(input.job) as JobRecord;
    for (const record of [request, workflow, job]) assertNoSecretMaterial(record, `${record.kind} record`);
    if (request.state !== "draft" || workflow.state !== "proposed" || job.state !== "proposed") {
      throw new Error("Proposed work bundle must remain non-runnable");
    }
    if (request.tenantId !== workflow.tenantId || request.tenantId !== job.tenantId
      || request.projectId !== workflow.projectId || workflow.projectId !== job.projectId
      || workflow.requestId !== request.id || job.workflowId !== workflow.id
      || workflow.jobIds.length !== 1 || workflow.jobIds[0] !== job.id) {
      throw new Error("Proposed work bundle lineage mismatch");
    }
    assertAuthorityDigest(job.authority);
    if (job.authority.projectId !== job.projectId || job.authority.networkPolicy !== "none"
      || job.authority.allowedNetworkDestinations.length !== 0 || job.authority.credentialRefs.length !== 0
      || job.authority.filesystemRoots.length !== 0 || job.authority.effectPolicy !== "none"
      || job.authority.maxConcurrentEffects !== 0) {
      throw new Error("Proposed work bundle exceeds the materialization ceiling");
    }
    return this.#transaction(async (tx) => {
      let replayed = true;
      for (const entity of [request, workflow, job] as DomainEntity[]) {
        const existing = await this.#getWith(tx, entity.tenantId, entity.kind, entity.id);
        if (existing) {
          if (sha256Digest(existing) !== sha256Digest(entity)) throw new Error("Proposed work bundle replay conflict");
        } else {
          await this.#insertWith(tx, entity);
          replayed = false;
        }
      }
      return { request, workflow, job, replayed };
    });
  }

  /** Atomically records an exact reviewed proposed-work bundle and its resolved owner-attention item. */
  async createProposedWorkBundleWithActionInbox(input: ProposedWorkBundleWithActionInbox): Promise<ProposedWorkBundleResult & { actionInbox: ActionInboxItemV1 }> {
    const request = domainEntitySchema.parse(input.request) as RequestRecord;
    const workflow = domainEntitySchema.parse(input.workflow) as WorkflowRecord;
    const job = domainEntitySchema.parse(input.job) as JobRecord;
    const actionInbox = actionInboxItemSchemaV1.parse(input.actionInbox) as ActionInboxItemV1;
    for (const record of [request, workflow, job]) assertNoSecretMaterial(record, `${record.kind} record`);
    assertNoSecretMaterial(actionInbox, "action inbox item");
    if (request.state !== "draft" || workflow.state !== "proposed" || job.state !== "proposed"
      || actionInbox.state !== "resolved" || actionInbox.deliveryState !== "not_requested") {
      throw new Error("Reviewed proposed work must remain non-runnable");
    }
    if (request.tenantId !== workflow.tenantId || request.tenantId !== job.tenantId || request.tenantId !== actionInbox.tenantId
      || request.projectId !== workflow.projectId || workflow.projectId !== job.projectId || job.projectId !== actionInbox.projectId
      || workflow.requestId !== request.id || job.workflowId !== workflow.id || actionInbox.workItemId !== job.id
      || workflow.jobIds.length !== 1 || workflow.jobIds[0] !== job.id) {
      throw new Error("Reviewed proposed work lineage mismatch");
    }
    assertAuthorityDigest(job.authority);
    if (job.authority.projectId !== job.projectId || job.authority.networkPolicy !== "none"
      || job.authority.allowedNetworkDestinations.length !== 0 || job.authority.credentialRefs.length !== 0
      || job.authority.filesystemRoots.length !== 0 || job.authority.effectPolicy !== "none"
      || job.authority.maxConcurrentEffects !== 0 || job.authority.maxCostUsd !== 0
      || job.authority.allowedOperations.length !== 1 || job.authority.allowedOperations[0] !== "prepare.agent-handoff"
      || job.specVersion !== "agent-team-handoff/v1" || !job.jobType.startsWith("agent-handoff.")
      || !job.requiredCapability.startsWith("agent.team.handoff.")) throw new Error("Reviewed proposed work exceeds the materialization ceiling");
    if (actionInbox.kind !== "review" || actionInbox.reasonCode !== "agent_team_handoff_materialized_proposed"
      || actionInbox.requestedAction !== "Reviewed handoff recorded as proposed work" || actionInbox.blockedWorkItemIds.length !== 0
      || actionInbox.legalResponses.length !== 1 || actionInbox.legalResponses[0]?.kind !== "open_source"
      || actionInbox.evidence.length !== 2 || actionInbox.evidence.some((item) => item.kind !== "audit" || !item.digest || !item.observedAt)) {
      throw new Error("Reviewed proposed work attention contract mismatch");
    }
    return this.#transaction(async (tx) => {
      let replayed = true;
      for (const entity of [request, workflow, job] as DomainEntity[]) {
        const existing = await this.#getWith(tx, entity.tenantId, entity.kind, entity.id);
        if (existing) {
          if (sha256Digest(existing) !== sha256Digest(entity)) throw new Error("Reviewed proposed work replay conflict");
        } else { await this.#insertWith(tx, entity); replayed = false; }
      }
      const prior = await tx.query<{ payload: unknown }>(
        "SELECT payload FROM control_action_inbox WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [actionInbox.tenantId, actionInbox.id]);
      if (prior.rows[0]) {
        if (sha256Digest(prior.rows[0].payload) !== sha256Digest(actionInbox)) throw new Error("Reviewed proposed work attention conflict");
      } else {
        await tx.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [actionInbox.id, actionInbox.tenantId, actionInbox.projectId ?? null,
          actionInbox.workItemId ?? null, actionInbox.kind, actionInbox.state, actionInbox.deliveryState, actionInbox.createdAt,
          actionInbox.expiresAt ?? null, JSON.stringify(actionInbox)]);
        replayed = false;
      }
      return { request, workflow, job, actionInbox, replayed };
    });
  }

  /** Atomically records standing-policy frontier work without granting readiness or execution authority. */
  async createReadyFrontierProposedWorkBundleWithActionInbox(input: ProposedWorkBundleWithActionInbox): Promise<ProposedWorkBundleResult & { actionInbox: ActionInboxItemV1 }> {
    const request = domainEntitySchema.parse(input.request) as RequestRecord;
    const workflow = domainEntitySchema.parse(input.workflow) as WorkflowRecord;
    const job = domainEntitySchema.parse(input.job) as JobRecord;
    const actionInbox = actionInboxItemSchemaV1.parse(input.actionInbox) as ActionInboxItemV1;
    for (const record of [request, workflow, job]) assertNoSecretMaterial(record, `${record.kind} record`);
    assertNoSecretMaterial(actionInbox, "action inbox item");
    if (request.state !== "draft" || workflow.state !== "proposed" || job.state !== "proposed"
      || actionInbox.state !== "resolved" || actionInbox.deliveryState !== "not_requested") {
      throw new Error("Frontier proposed work must remain non-runnable");
    }
    if (request.tenantId !== workflow.tenantId || request.tenantId !== job.tenantId || request.tenantId !== actionInbox.tenantId
      || request.projectId !== workflow.projectId || workflow.projectId !== job.projectId || job.projectId !== actionInbox.projectId
      || workflow.requestId !== request.id || job.workflowId !== workflow.id || actionInbox.workItemId !== job.id
      || workflow.jobIds.length !== 1 || workflow.jobIds[0] !== job.id) {
      throw new Error("Frontier proposed work lineage mismatch");
    }
    assertAuthorityDigest(job.authority);
    if (job.authority.projectId !== job.projectId || job.authority.networkPolicy !== "none"
      || job.authority.allowedNetworkDestinations.length !== 0 || job.authority.credentialRefs.length !== 0
      || job.authority.filesystemRoots.length !== 0 || job.authority.effectPolicy !== "none"
      || job.authority.maxConcurrentEffects !== 0 || job.authority.maxCostUsd !== 0
      || job.authority.allowedOperations.length !== 1 || job.authority.allowedOperations[0] !== "prepare.repository-work"
      || job.specVersion !== "ready-frontier-work-order/v1" || !job.jobType.startsWith("frontier.repository-work.")
      || !job.requiredCapability.startsWith("capability.")) throw new Error("Frontier proposed work exceeds the materialization ceiling");
    if (actionInbox.kind !== "review" || actionInbox.reasonCode !== "ready_frontier_materialized_proposed"
      || actionInbox.requestedAction !== "Standing policy recorded this item as proposed work"
      || actionInbox.blockedWorkItemIds.length !== 0 || actionInbox.legalResponses.length !== 1
      || actionInbox.legalResponses[0]?.kind !== "open_source" || actionInbox.evidence.length !== 3
      || actionInbox.evidence.some((item) => item.kind !== "audit" || !item.digest || !item.observedAt)) {
      throw new Error("Frontier proposed work attention contract mismatch");
    }
    return this.#transaction(async (tx) => {
      let replayed = true;
      for (const entity of [request, workflow, job] as DomainEntity[]) {
        const existing = await this.#getWith(tx, entity.tenantId, entity.kind, entity.id);
        if (existing) {
          if (sha256Digest(existing) !== sha256Digest(entity)) throw new Error("Frontier proposed work replay conflict");
        } else { await this.#insertWith(tx, entity); replayed = false; }
      }
      const prior = await tx.query<{ payload: unknown }>(
        "SELECT payload FROM control_action_inbox WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [actionInbox.tenantId, actionInbox.id]);
      if (prior.rows[0]) {
        if (sha256Digest(prior.rows[0].payload) !== sha256Digest(actionInbox)) throw new Error("Frontier proposed work attention conflict");
      } else {
        await tx.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [actionInbox.id, actionInbox.tenantId, actionInbox.projectId ?? null,
          actionInbox.workItemId ?? null, actionInbox.kind, actionInbox.state, actionInbox.deliveryState, actionInbox.createdAt,
          actionInbox.expiresAt ?? null, JSON.stringify(actionInbox)]);
        replayed = false;
      }
      return { request, workflow, job, actionInbox, replayed };
    });
  }

  /** Internal AUTO-030 persistence port. Callers must enter through the policy-guarded promotion service. */
  async promoteReadyFrontierJobWithInternalHandoff(operationAuthorization: unknown): Promise<{ job: JobRecord; replayed: boolean }> {
    const authorization = acquireReadyFrontierCanonicalPromotionAuthorizationV1(operationAuthorization);
    if (!authorization) throw new Error("Ready frontier promotion requires an active exact-operation authorization");
    const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/;
    const digest = /^sha256:[a-f0-9]{64}$/;
    const instant = (value: string): boolean => {
      const parsed = new Date(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
    };
    try {
      const receipt = authorization.receipt;
      const standingPolicy = authorization.standingPolicy;
      const readyPolicy = authorization.readyPolicy;
      const standingProject = standingPolicy.projectPolicies.find((item) => item.projectId === receipt.readyJob.projectId);
      const readyProject = readyPolicy.projectPolicies.find((item) => item.projectId === receipt.readyJob.projectId);
      const expectedTransitionId = `transition:frontier-ready:${sha256Digest({ receiptId: receipt.receiptId }).slice(7, 39)}`;
      const expectedTransitionKey = `frontier-ready-${receipt.receiptDigest.slice(7)}`;
      const input = {
        tenantId: receipt.tenantId,
        projectId: receipt.readyJob.projectId,
        jobId: receipt.readyJob.id,
        requestId: receipt.requestId,
        requestDigest: receipt.promotionRequestDigest,
        receiptDigest: receipt.receiptDigest,
        readyJobDigest: sha256Digest(receipt.readyJob),
        standingPolicy: { policyId: receipt.standingPolicyId, revision: receipt.standingPolicyRevision,
          policyDigest: receipt.standingPolicyDigest },
        readyPolicy: { policyId: receipt.readyPolicyId, revision: receipt.readyPolicyRevision,
          policyDigest: receipt.readyPolicyDigest },
        expectedJobVersion: 0,
        expectedJobDigest: receipt.proposedJobDigest,
        maximumActiveReadyGlobal: readyPolicy.maximumActiveReadyGlobal,
        maximumActiveReadyProject: readyProject?.maximumActiveReady ?? 0,
        transitionId: expectedTransitionId,
        transitionIdempotencyKey: expectedTransitionKey,
        actor: { actorId: "service:ready-frontier-promoter", actorType: "service" } as ActorRef,
        occurredAt: receipt.promotedAt,
        reservation: {
          id: receipt.reservation.reservationId,
          routeId: receipt.reservation.routeId,
          resourceKey: receipt.reservation.resourceKey,
          units: receipt.reservation.units,
          capacityUnits: receipt.reservation.capacityUnits,
          decisionDigest: receipt.reservation.decisionDigest,
          acquiredAt: receipt.reservation.acquiredAt,
          expiresAt: receipt.reservation.expiresAt,
        },
        handoff: {
          id: receipt.handoff.handoffId,
          payloadDigest: sha256Digest(receipt.handoff),
          availableAt: receipt.handoff.createdAt,
          expiresAt: receipt.handoff.expiresAt,
          payload: receipt.handoff as unknown as Record<string, unknown>,
        },
      };
      if (!standingProject || !standingProject.enabled || !readyProject || !readyProject.enabled
        || readyPolicy.parentStandingPolicyId !== standingPolicy.policyId
        || readyPolicy.parentStandingPolicyRevision !== standingPolicy.revision
        || readyPolicy.parentStandingPolicyDigest !== standingPolicy.policyDigest
        || input.tenantId !== standingPolicy.tenantId || input.tenantId !== readyPolicy.tenantId
        || standingPolicy.workspaceId !== receipt.workspaceId || readyPolicy.workspaceId !== receipt.workspaceId
        || receipt.standingPolicyId !== standingPolicy.policyId
        || receipt.standingPolicyRevision !== standingPolicy.revision
        || receipt.standingPolicyDigest !== standingPolicy.policyDigest
        || receipt.readyPolicyId !== readyPolicy.policyId || receipt.readyPolicyRevision !== readyPolicy.revision
        || receipt.readyPolicyDigest !== readyPolicy.policyDigest
        || receipt.reservation.projectId !== receipt.readyJob.projectId
        || receipt.reservation.jobId !== receipt.readyJob.id
        || receipt.reservation.routeId !== receipt.readyJob.authority.allowedExecutor
        || input.reservation.resourceKey !== readyProject.resourceKey
        || input.reservation.units !== readyProject.reservationUnits
        || input.reservation.capacityUnits !== readyProject.resourceCapacityUnits
        || receipt.handoff.tenantId !== receipt.tenantId || receipt.handoff.projectId !== receipt.readyJob.projectId
        || receipt.handoff.jobId !== receipt.readyJob.id
        || receipt.handoff.reservationId !== receipt.reservation.reservationId) {
        throw new Error("Ready frontier promotion authorization mismatch");
      }
      if (![input.tenantId, input.projectId, input.jobId, input.requestId, input.standingPolicy.policyId,
        input.readyPolicy.policyId, input.transitionId, input.transitionIdempotencyKey,
        input.reservation.id, input.reservation.routeId, input.reservation.resourceKey,
        input.handoff.id].every((value) => safeId.test(value))
        || ![input.requestDigest, input.receiptDigest, input.readyJobDigest, input.expectedJobDigest,
          input.standingPolicy.policyDigest, input.readyPolicy.policyDigest,
          input.reservation.decisionDigest, input.handoff.payloadDigest].every((value) => digest.test(value))
        || ![input.occurredAt, input.reservation.acquiredAt, input.reservation.expiresAt,
          input.handoff.availableAt, input.handoff.expiresAt, authorization.materializedAt,
          authorization.authorizedAt].every(instant)
        || input.reservation.acquiredAt !== input.occurredAt
        || Date.parse(input.reservation.expiresAt) <= Date.parse(input.occurredAt)
        || input.handoff.availableAt !== input.occurredAt || input.handoff.expiresAt !== input.reservation.expiresAt
        || !Number.isSafeInteger(input.maximumActiveReadyGlobal) || input.maximumActiveReadyGlobal < 1
        || !Number.isSafeInteger(input.maximumActiveReadyProject) || input.maximumActiveReadyProject < 1
        || !Number.isSafeInteger(input.standingPolicy.revision) || input.standingPolicy.revision < 1
        || !Number.isSafeInteger(input.readyPolicy.revision) || input.readyPolicy.revision < 1
        || !Number.isSafeInteger(input.reservation.units) || input.reservation.units < 1
        || !Number.isSafeInteger(input.reservation.capacityUnits) || input.reservation.capacityUnits < input.reservation.units
        || input.actor.actorType !== "service" || input.actor.actorId !== "service:ready-frontier-promoter") {
        throw new Error("Invalid ready frontier promotion input");
      }
      assertNoSecretMaterial(input.handoff.payload, "ready frontier handoff");
      if (input.handoff.payload.handoffId !== input.handoff.id || input.handoff.payload.tenantId !== input.tenantId
        || input.handoff.payload.projectId !== input.projectId || input.handoff.payload.jobId !== input.jobId
        || input.handoff.payload.reservationId !== input.reservation.id
        || input.handoff.payload.destination !== "internal_scheduler_jobber_table"
        || input.handoff.payload.state !== "pending_internal_handoff"
        || input.handoff.payload.repositorySimulationOnly !== true || input.handoff.payload.permitsClaimOrLease !== false
        || input.handoff.payload.permitsDispatchOrExecution !== false || input.handoff.payload.permitsProviderContact !== false
        || input.handoff.payload.permitsAgentMessage !== false || input.handoff.payload.permitsGitHubMutation !== false
        || input.handoff.payload.permitsExternalEffects !== false) throw new Error("Ready frontier handoff contract mismatch");
      let lastAuthorizedTime = Date.parse(authorization.authorizedAt);
      const currentAuthorizationTime = (requireFreshPromotion: boolean): string => {
        let value: string;
        try { value = authorization.now(); } catch { throw new Error("Ready frontier trusted clock failed"); }
        if (!instant(value)) throw new Error("Ready frontier trusted clock returned an invalid instant");
        const current = Date.parse(value);
        if (current < lastAuthorizedTime || current < Date.parse(authorization.authorizedAt)
          || standingPolicy.state !== "active" || readyPolicy.state !== "active"
          || current < Date.parse(standingPolicy.effectiveAt) || current >= Date.parse(standingPolicy.expiresAt)
          || current < Date.parse(readyPolicy.effectiveAt) || current >= Date.parse(readyPolicy.expiresAt)
          || current >= Date.parse(receipt.reservation.expiresAt)
          || current >= Date.parse(receipt.handoff.expiresAt)
          || current >= Date.parse(receipt.readyJob.authority.expiresAt)) {
          throw new Error("Ready frontier promotion authorization is no longer current");
        }
        if (requireFreshPromotion && (current < Date.parse(receipt.promotedAt)
          || current - Date.parse(receipt.promotedAt) > 5_000
          || current < Date.parse(authorization.materializedAt)
          || current - Date.parse(authorization.materializedAt) > readyPolicy.maximumMaterializationAgeSeconds * 1_000)) {
          throw new Error("Ready frontier promotion request is stale at the write boundary");
        }
        lastAuthorizedTime = current;
        return value;
      };
      let requireFreshAtPreCommit = true;
      const result = await this.#transactionWithPreCommitCheck(async (tx) => {
      const tenant = await tx.query<{ id: string }>("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [input.tenantId]);
      if (!tenant.rows[0]) throw new Error("Ready frontier tenant not found");
      const priorRequest = await tx.query<{ request_digest: string; status: string; result: {
        receiptDigest?: string; jobId?: string; reservationId?: string; handoffId?: string } }>(
        `SELECT request_digest,status,result FROM control_idempotency
         WHERE tenant_id=$1 AND operation_scope='ready-frontier-promotion' AND idempotency_key=$2 FOR UPDATE`,
        [input.tenantId, input.requestId]);
      let transactionNow = currentAuthorizationTime(!priorRequest.rows[0]);
      if (priorRequest.rows[0]) {
        requireFreshAtPreCommit = false;
        const prior = priorRequest.rows[0];
        if (prior.request_digest !== input.requestDigest || prior.status !== "completed"
          || prior.result?.receiptDigest !== input.receiptDigest || prior.result?.jobId !== input.jobId
          || prior.result?.reservationId !== input.reservation.id || prior.result?.handoffId !== input.handoff.id) {
          throw new Error("Ready frontier promotion request replay conflict");
        }
        const handoff = await tx.query<{ request_id: string; project_id: string; job_id: string; reservation_id: string;
          state: string; payload_digest: string; available_at: string; expires_at: string; payload: Record<string, unknown> }>(
          `SELECT request_id,project_id,job_id,reservation_id,state,payload_digest,available_at,expires_at,payload
           FROM control_ready_frontier_handoffs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [input.tenantId, input.handoff.id]);
        const queued = handoff.rows[0];
        if (!queued || queued.request_id !== input.requestId || queued.project_id !== input.projectId
          || queued.job_id !== input.jobId || queued.reservation_id !== input.reservation.id
          || queued.state !== "pending_internal_handoff" || queued.payload_digest !== input.handoff.payloadDigest
          || new Date(queued.available_at).toISOString() !== input.handoff.availableAt
          || new Date(queued.expires_at).toISOString() !== input.handoff.expiresAt
          || sha256Digest(queued.payload) !== input.handoff.payloadDigest) {
          throw new Error("Ready frontier promotion replay lacks its pending internal handoff");
        }
        const transition = await tx.query<{ id: string; entity_id: string; from_state: string; to_state: string;
          from_version: number; to_version: number; actor_id: string; actor_type: string; occurred_at: string;
          safe_metadata: Record<string, unknown> }>(
          `SELECT id,entity_id,from_state,to_state,from_version,to_version,actor_id,actor_type,occurred_at,safe_metadata
           FROM control_transition_events
           WHERE tenant_id=$1 AND entity_kind='job' AND idempotency_key=$2`,
          [input.tenantId, input.transitionIdempotencyKey]);
        const event = transition.rows[0];
        if (!event || event.id !== input.transitionId || event.entity_id !== input.jobId
          || event.from_state !== "proposed" || event.to_state !== "ready"
          || event.from_version !== input.expectedJobVersion || event.to_version !== input.expectedJobVersion + 1
          || event.actor_id !== input.actor.actorId || event.actor_type !== input.actor.actorType
          || new Date(event.occurred_at).toISOString() !== input.occurredAt
          || sha256Digest(event.safe_metadata) !== sha256Digest({ readyFrontierHandoffId: input.handoff.id,
            schedulerDecisionDigest: input.reservation.decisionDigest, handoffPayloadDigest: input.handoff.payloadDigest })) {
          throw new Error("Ready frontier handoff replay lacks its canonical transition");
        }
        const reservation = await tx.query<{ project_id: string; work_item_id: string; route_id: string;
          resource_key: string; units: number; decision_digest: string; state: string; acquired_at: string;
          expires_at: string; capacity_units: number }>(
          `SELECT r.project_id,r.work_item_id,r.route_id,r.resource_key,r.units,r.decision_digest,r.state,
             r.acquired_at,r.expires_at,h.capacity_units
           FROM control_resource_reservations r JOIN control_resource_reservation_heads h
             ON h.tenant_id=r.tenant_id AND h.resource_key=r.resource_key
           WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r,h`,
          [input.tenantId, input.reservation.id]);
        const held = reservation.rows[0];
        if (!held || held.project_id !== input.projectId || held.work_item_id !== input.jobId
          || held.route_id !== input.reservation.routeId || held.resource_key !== input.reservation.resourceKey
          || Number(held.units) !== input.reservation.units || held.decision_digest !== input.reservation.decisionDigest
          || held.state !== "active" || Number(held.capacity_units) !== input.reservation.capacityUnits
          || new Date(held.acquired_at).toISOString() !== input.reservation.acquiredAt
          || new Date(held.expires_at).toISOString() !== input.reservation.expiresAt) {
          throw new Error("Ready frontier handoff replay lacks its database reservation");
        }
        const current = await this.#requireWith(tx, input.tenantId, "job", input.jobId) as JobRecord;
        if (current.state !== "ready" || current.version !== input.expectedJobVersion + 1
          || sha256Digest(current) !== input.readyJobDigest) throw new Error("Ready frontier replay job has advanced or drifted");
        currentAuthorizationTime(false);
        return { job: current, replayed: true };
      }
      await tx.query(`INSERT INTO control_idempotency
        (tenant_id,operation_scope,idempotency_key,request_digest,status)
        VALUES($1,'ready-frontier-promotion',$2,$3,'processing')`,
      [input.tenantId, input.requestId, input.requestDigest]);
      const row = await tx.query<{ payload: JobRecord }>(
        "SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.jobId]);
      const job = row.rows[0] ? domainEntitySchema.parse(row.rows[0].payload) as JobRecord : undefined;
      if (!job || job.kind !== "job" || job.projectId !== input.projectId || job.state !== "proposed"
        || job.version !== input.expectedJobVersion || sha256Digest(job) !== input.expectedJobDigest) {
        throw new Error("Ready frontier proposed job mismatch");
      }
      assertAuthorityDigest(job.authority);
      if (job.authority.projectId !== job.projectId || job.authority.allowedExecutor !== input.reservation.routeId
        || job.authority.networkPolicy !== "none" || job.authority.allowedNetworkDestinations.length !== 0
        || job.authority.credentialRefs.length !== 0 || job.authority.filesystemRoots.length !== 0
        || job.authority.effectPolicy !== "none" || job.authority.maxConcurrentEffects !== 0 || job.authority.maxCostUsd !== 0
        || job.authority.allowedOperations.length !== 1 || job.authority.allowedOperations[0] !== "prepare.repository-work"
        || job.specVersion !== "ready-frontier-work-order/v1" || !job.jobType.startsWith("frontier.repository-work.")) {
        throw new Error("Ready frontier job exceeds its ready ceiling");
      }
      const readyCounts = await tx.query<{ global_count: string; project_count: string }>(`SELECT
        (SELECT count(*) FROM control_jobs WHERE tenant_id=$1 AND state='ready')::text global_count,
        (SELECT count(*) FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND state='ready')::text project_count`,
      [input.tenantId, input.projectId]);
      if (Number(readyCounts.rows[0]?.global_count ?? 0) >= input.maximumActiveReadyGlobal
        || Number(readyCounts.rows[0]?.project_count ?? 0) >= input.maximumActiveReadyProject) {
        throw new Error("Ready frontier ready capacity exhausted");
      }

      await tx.query(`INSERT INTO control_resource_reservation_heads(tenant_id,resource_key,capacity_units)
        VALUES($1,$2,$3) ON CONFLICT(tenant_id,resource_key) DO NOTHING`,
      [input.tenantId, input.reservation.resourceKey, input.reservation.capacityUnits]);
      const head = await tx.query<{ capacity_units: number }>(
        "SELECT capacity_units FROM control_resource_reservation_heads WHERE tenant_id=$1 AND resource_key=$2 FOR UPDATE",
        [input.tenantId, input.reservation.resourceKey]);
      if (Number(head.rows[0]?.capacity_units) !== input.reservation.capacityUnits) throw new Error("Ready frontier resource capacity conflict");
      transactionNow = currentAuthorizationTime(true);
      await tx.query(`UPDATE control_resource_reservations SET state='expired'
        WHERE tenant_id=$1 AND resource_key=$2 AND state='active' AND expires_at <= $3`,
      [input.tenantId, input.reservation.resourceKey, transactionNow]);
      const existingReservation = await tx.query<{ id: string }>(
        "SELECT id FROM control_resource_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [input.tenantId, input.reservation.id]);
      if (existingReservation.rows[0]) throw new Error("Ready frontier reservation replay without handoff");
      const used = await tx.query<{ used_units: string }>(`SELECT COALESCE(SUM(units),0)::text used_units
        FROM control_resource_reservations WHERE tenant_id=$1 AND resource_key=$2 AND state='active' AND expires_at > $3`,
      [input.tenantId, input.reservation.resourceKey, transactionNow]);
      if (Number(used.rows[0]?.used_units ?? 0) + input.reservation.units > input.reservation.capacityUnits) {
        throw new Error("Ready frontier resource unavailable");
      }
      currentAuthorizationTime(true);
      await tx.query(`INSERT INTO control_resource_reservations
        (id,tenant_id,project_id,work_item_id,route_id,resource_key,units,decision_digest,state,acquired_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10)`,
      [input.reservation.id, input.tenantId, input.projectId, input.jobId, input.reservation.routeId,
        input.reservation.resourceKey, input.reservation.units, input.reservation.decisionDigest,
        input.reservation.acquiredAt, input.reservation.expiresAt]);
      currentAuthorizationTime(true);
      const promoted = await this.#transitionWith(tx, { tenantId: input.tenantId, kind: "job", entityId: input.jobId,
        expectedVersion: input.expectedJobVersion, toState: "ready", transitionId: input.transitionId,
        idempotencyKey: input.transitionIdempotencyKey, actor: input.actor, occurredAt: input.occurredAt,
        safeMetadata: { readyFrontierHandoffId: input.handoff.id, schedulerDecisionDigest: input.reservation.decisionDigest,
          handoffPayloadDigest: input.handoff.payloadDigest } }, true);
      currentAuthorizationTime(true);
      await tx.query(`INSERT INTO control_ready_frontier_handoffs
        (id,tenant_id,request_id,project_id,job_id,reservation_id,state,payload_digest,available_at,expires_at,payload)
        VALUES($1,$2,$3,$4,$5,$6,'pending_internal_handoff',$7,$8,$9,$10::jsonb)`,
      [input.handoff.id, input.tenantId, input.requestId, input.projectId, input.jobId, input.reservation.id,
        input.handoff.payloadDigest, input.handoff.availableAt, input.handoff.expiresAt, JSON.stringify(input.handoff.payload)]);
      currentAuthorizationTime(true);
      await tx.query(`UPDATE control_idempotency SET status='completed',result=$1::jsonb,completed_at=now()
        WHERE tenant_id=$2 AND operation_scope='ready-frontier-promotion' AND idempotency_key=$3 AND status='processing'`,
      [JSON.stringify({ receiptDigest: input.receiptDigest, jobId: input.jobId,
        reservationId: input.reservation.id, handoffId: input.handoff.id }), input.tenantId, input.requestId]);
      currentAuthorizationTime(true);
      return { job: promoted.entity as JobRecord, replayed: false };
      }, () => { currentAuthorizationTime(requireFreshAtPreCommit); });
      try { currentAuthorizationTime(false); }
      catch { throw new Error("Ready frontier transaction completed without confirmed current authorization; canonical outcome is ambiguous"); }
      return result;
    } finally {
      authorization.release();
    }
  }

  async get(tenantId: string, kind: EntityKind, id: string): Promise<DomainEntity | undefined> {
    return this.#getWith(this.#session, tenantId, kind, id);
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    return this.#transaction((tx) => this.#transitionWith(tx, input, false));
  }

  async claimReadyJob(input: ClaimJobInput): Promise<{ job: JobRecord; attempt: AttemptRecord; lease: LeaseRecord; replayed: boolean }> {
    return this.#transaction(async (tx) => {
      const prior = await tx.query<{ entity_id: string; safe_metadata: { attemptId?: string; leaseId?: string } }>(
        `SELECT entity_id,safe_metadata FROM control_transition_events WHERE tenant_id=$1 AND entity_kind='job' AND idempotency_key=$2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (prior.rows.length) {
        if (prior.rows[0].entity_id !== input.jobId || prior.rows[0].safe_metadata.attemptId !== input.attemptId
          || prior.rows[0].safe_metadata.leaseId !== input.leaseId) throw new Error("Claim idempotency key reused with different lineage");
        const job = await this.#requireWith(tx, input.tenantId, "job", input.jobId) as JobRecord;
        if (job.specVersion === "ready-frontier-work-order/v1") {
          throw new Error("Ready frontier jobs require the separately reviewed internal handoff consumer");
        }
        const attempt = await this.#requireWith(tx, input.tenantId, "attempt", input.attemptId) as AttemptRecord;
        const lease = await this.#requireWith(tx, input.tenantId, "lease", input.leaseId) as LeaseRecord;
        return { job, attempt, lease, replayed: true };
      }

      const jobRow = await tx.query<{ payload: JobRecord }>(
        `SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.jobId],
      );
      const job = jobRow.rows[0]?.payload;
      if (!job) throw new Error("Job not found");
      if (job.specVersion === "ready-frontier-work-order/v1") {
        throw new Error("Ready frontier jobs require the separately reviewed internal handoff consumer");
      }
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
      await this.#insertWith(tx, attemptOffered);

      const attemptResult = await this.#transitionWith(tx, {
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
      await this.#insertWith(tx, lease);

      const jobResult = await this.#transitionWith(tx, {
        tenantId: input.tenantId, kind: "job", entityId: input.jobId,
        expectedVersion: input.expectedJobVersion, toState: "leased", transitionId: input.transitionId,
        idempotencyKey: input.idempotencyKey, actor: input.actor, occurredAt: input.acquiredAt,
        safeMetadata: { attemptId: input.attemptId, leaseId: input.leaseId, leaseEpoch: next.next_epoch },
      }, true);
      return { job: jobResult.entity as JobRecord, attempt: attemptResult.entity as AttemptRecord, lease, replayed: false };
    });
  }

  /** Durable coordinator pre-effect marker for the fixed public-feed read operation only.
   * This is persistence, not a reader factory or a portable execution capability.
   * The collector must bind its saved full plan and recheck its local guard before I/O.
   * This does not replace the node-local protected claim required for remote execution.
   * Any replay refuses another start, even when the preceding caller lost its response. */
  async beginAbsFeedAttempt(input: { tenantId: string; workspaceId: string; projectId: string; jobId: string;
    attemptId: string; effectId: string; nodeId: string; executorId: string; inputDigest: string; operationDigest: string },
  clock: () => number = Date.now): Promise<{ started: true; markerDigest: string; deadline: string }> {
    input = { ...input };
    const startedAt = clock(); let deadline = startedAt;
    const assertCurrent = () => { const current = clock();
      if (!Number.isSafeInteger(current) || current < startedAt || current >= deadline) throw new Error("abs_feed_attempt_expired"); };
    if (!Number.isSafeInteger(startedAt)) throw new Error("abs_feed_attempt_expired");
    return this.#transactionWithPreCommitCheck(async tx => {
      // Match web admission's identity -> grants -> workspace lock order.
      const proof = (await tx.query<{ identity_id: string; id: string; decided_at: string; expires_at: string; approval_id: string; operation_digest: string }>(
        `SELECT d.identity_id,d.id,d.decided_at,d.expires_at,c.approval_id,c.operation_digest FROM control_approval_consumptions c
         JOIN control_policy_decisions d ON d.tenant_id=c.tenant_id AND d.id=c.policy_decision_id
         WHERE c.tenant_id=$1 AND c.effect_intent_id=$2`, [input.tenantId, input.effectId])).rows[0];
      if (!proof) throw new Error("abs_feed_attempt_unavailable");
      const owner = (await tx.query<{ actor_type: string; state: string }>(
        "SELECT actor_type,state FROM control_identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, proof.identity_id])).rows[0];
      if (owner?.actor_type !== "human" || owner.state !== "active") throw new Error("abs_feed_attempt_unavailable");
      const rows = await tx.query<{ id: string; role_key: string; allowed_actions: string[]; project_ids: string[];
        risk_ceiling: RoleGrant["riskCeiling"]; allow_external_effects: boolean; require_strong_factor: boolean;
        expires_at: string | null; revoked_at: string | null }>(
        "SELECT * FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2 FOR SHARE", [input.tenantId, proof.identity_id]);
      const grants = rows.rows.filter(g => g.role_key === "owner").map(g => ({ id: g.id, allowedActions: g.allowed_actions,
        projectIds: g.project_ids, riskCeiling: g.risk_ceiling, allowExternalEffects: g.allow_external_effects,
        requireStrongFactor: g.require_strong_factor, ...(g.expires_at ? { expiresAt: g.expires_at } : {}),
        ...(g.revoked_at ? { revokedAt: g.revoked_at } : {}) }));
      await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.workspaceId]);
      // The feed route currently targets ordinary projects; Idea promotion produces one.
      const project = (await tx.query<{ lifecycle: string }>(`SELECT h.lifecycle FROM projects p
        JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
        WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 FOR SHARE OF p,h`,
      [input.tenantId, input.workspaceId, input.projectId])).rows[0];
      if (project?.lifecycle !== "active") throw new Error("abs_feed_attempt_unavailable");
      await tx.query("SELECT id FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.jobId]);
      const job = await this.#requireWith(tx, input.tenantId, "job", input.jobId) as JobRecord;
      const attempt = await this.#requireWith(tx, input.tenantId, "attempt", input.attemptId) as AttemptRecord;
      const effect = await this.#requireWith(tx, input.tenantId, "effect_intent", input.effectId) as EffectIntentRecord;
      const leases = await tx.query<{ payload: LeaseRecord }>(
        "SELECT payload FROM control_leases WHERE tenant_id=$1 AND attempt_id=$2 AND state='active' FOR UPDATE", [input.tenantId, input.attemptId]);
      const lease = leases.rows[0] ? domainEntitySchema.parse(leases.rows[0].payload) as LeaseRecord : undefined;
      const node = (await tx.query<{ state: string }>("SELECT state FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [input.tenantId, input.nodeId])).rows[0];
      const discovery = job.specVersion === "abs-news-discovery/v1";
      const collectionOperation = discovery ? "abs.news.discover" : "abs.feed.collect";
      if (job.projectId !== input.projectId || job.inputDigest !== input.inputDigest || job.state !== "leased"
        || !discovery && job.specVersion !== "abs-feed-collection/v1" || job.jobType !== "abs.feed.collection"
        || job.authority.allowedExecutor !== input.executorId || job.authority.allowedOperations.length !== 1
        || job.authority.allowedOperations[0] !== collectionOperation || job.authority.effectPolicy !== "approval_required"
        || job.authority.maxConcurrentEffects !== 1 || job.authority.credentialRefs.length || job.authority.filesystemRoots.length
        || job.authority.maxRisk !== "low" || job.authority.maxCostUsd !== 0 || job.authority.maxDurationSeconds !== 60
        || job.requiredCapability !== (discovery ? "news.public_discovery.read" : "news.public_feed.read") || job.dependsOnJobIds.length
        || job.retryPolicy.maxAttempts !== 1 || job.retryPolicy.retryAfterOrphan || job.retryPolicy.retryableFailureCodes.length
        || job.retryPolicy.backoffSeconds !== 0 || job.retryPolicy.ambiguousEffectPolicy !== "attention"
        || job.authority.networkPolicy !== "allowlist" || job.authority.allowedNetworkDestinations.length < 1
        || job.authority.allowedNetworkDestinations.length > (discovery ? 16 : 1)
        || attempt.jobId !== job.id || attempt.nodeId !== input.nodeId || attempt.state !== "leased"
        || !lease || leases.rows.length !== 1 || lease.jobId !== job.id || lease.nodeId !== input.nodeId || lease.epoch !== attempt.leaseEpoch
        || node?.state !== "active" || effect.jobId !== job.id || effect.attemptId !== attempt.id || effect.state !== "authorized"
        || effect.operation !== collectionOperation || effect.risk !== "low" || !effect.approvalId
        || proof.approval_id !== effect.approvalId || proof.operation_digest !== effect.operationDigest
        || effect.operationDigest !== input.operationDigest || effect.operationDigest !== computeEffectOperationDigest(effect, job.projectId)
        || effect.destination !== job.authority.allowedNetworkDestinations[0]) throw new Error("abs_feed_attempt_unavailable");
      assertAuthorityDigest(job.authority);
      await tx.query("SELECT id FROM control_approvals WHERE tenant_id=$1 AND id=$2 FOR SHARE", [input.tenantId, effect.approvalId]);
      const approval = await this.#requireWith(tx, input.tenantId, "approval", effect.approvalId) as ApprovalRecord;
      if (approval.state !== "approved" || approval.operationDigest !== effect.operationDigest || approval.scope !== job.projectId
        || approval.risk !== "low") throw new Error("abs_feed_attempt_unavailable");
      const occurredAt = new Date(startedAt).toISOString();
      await this.#requirePolicyDecision(tx, { tenantId: input.tenantId, decisionId: proof.id, identityId: proof.identity_id,
        actorType: "human", action: "effect.authorize", resourceType: "effect_intent", resourceId: effect.id,
        projectId: job.projectId, risk: "low", externalEffect: true, requiredRoleKey: "owner", occurredAt });
      const decision = evaluatePolicy({ tenantId: input.tenantId, identityId: proof.identity_id, actorType: "human",
        authenticatedAt: proof.decided_at, expiresAt: proof.expires_at }, grants, { tenantId: input.tenantId,
        action: "effect.authorize", resourceType: "effect_intent", resourceId: effect.id, projectId: job.projectId,
        risk: "low", externalEffect: true, occurredAt });
      if (!decision.allowed) throw new Error("abs_feed_attempt_unavailable");
      deadline = Math.min(Date.parse(job.authority.expiresAt), Date.parse(lease.expiresAt), Date.parse(approval.expiresAt),
        Date.parse(proof.expires_at), ...grants.filter(g => decision.matchedGrantIds.includes(g.id))
          .flatMap(g => [g.expiresAt, g.revokedAt].filter((value): value is string => !!value).map(Date.parse)));
      if (!Number.isFinite(deadline)) throw new Error("abs_feed_attempt_unavailable");
      assertCurrent();
      const claimKey = sha256Digest({ tenantId: input.tenantId, nodeId: input.nodeId, projectId: job.projectId,
        jobId: job.id, attemptId: attempt.id, operationDigest: effect.operationDigest });
      const markerDigest = sha256Digest({ claimKey, inputDigest: job.inputDigest, authorityDigest: job.authority.digest,
        destination: effect.destination, deadline: new Date(deadline).toISOString() });
      const actor = { actorId: input.nodeId, actorType: "node" as const }, suffix = claimKey.slice(7, 47);
      for (const [entity, toState] of [[job, "running"], [attempt, "running"], [effect, "executing"]] as const)
        await this.#transitionWith(tx, { tenantId: input.tenantId, kind: entity.kind, entityId: entity.id,
          expectedVersion: entity.version, toState, actor, occurredAt, transitionId: `transition:feed-start:${suffix}:${entity.kind}`,
          idempotencyKey: `feed-start:${suffix}:${entity.kind}`, ...(entity.kind === "attempt" ? { recordPatch: { startedAt: occurredAt } } : {}), safeMetadata: { claimKey, markerDigest,
            deadline: new Date(deadline).toISOString(), inputDigest: job.inputDigest } }, true);
      return { started: true as const, markerDigest, deadline: new Date(deadline).toISOString() };
    }, assertCurrent);
  }

  /** Records a trusted collector's outcome; never performs or authorizes another read.
   * A receipt digest identifies evidence, not proof that the evidence is true. The owned
   * collector must retain and validate that evidence before requesting confirmation. */
  async settleAbsFeedAttempt(value: unknown, clock: () => number = Date.now) {
    const id = z.string().min(1).max(180), digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
    const input = z.object({ tenantId: id, projectId: id, jobId: id, attemptId: id, effectId: id, nodeId: id,
      markerDigest: digest, outcome: z.enum(["confirmed", "failed", "ambiguous"]), receiptDigest: digest.optional() }).strict()
      .refine(v => (v.outcome === "confirmed") === !!v.receiptDigest).parse(value);
    const now = clock(); if (!Number.isSafeInteger(now)) throw new Error("abs_feed_settlement_unavailable");
    const occurredAt = new Date(now).toISOString(), outcomeDigest = sha256Digest(input);
    let completionDeadline: number | undefined;
    const checkCompletion = () => { const current = clock();
      if (!Number.isSafeInteger(current) || current < now || completionDeadline !== undefined && current >= completionDeadline)
        throw new Error("abs_feed_settlement_expired"); };
    return this.#transactionWithPreCommitCheck(async tx => {
      await tx.query("SELECT id FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.jobId]);
      const job = await this.#requireWith(tx, input.tenantId, "job", input.jobId) as JobRecord;
      const attempt = await this.#requireWith(tx, input.tenantId, "attempt", input.attemptId) as AttemptRecord;
      const effect = await this.#requireWith(tx, input.tenantId, "effect_intent", input.effectId) as EffectIntentRecord;
      const discovery = job.specVersion === "abs-news-discovery/v1";
      if (job.projectId !== input.projectId || !discovery && job.specVersion !== "abs-feed-collection/v1" || job.jobType !== "abs.feed.collection"
        || attempt.jobId !== job.id || attempt.nodeId !== input.nodeId || effect.jobId !== job.id || effect.attemptId !== attempt.id
        || effect.operation !== (discovery ? "abs.news.discover" : "abs.feed.collect") || effect.risk !== "low") throw new Error("abs_feed_settlement_unavailable");
      const marker = (await tx.query<{ safe_metadata: { markerDigest?: string; deadline?: string } }>(
        "SELECT safe_metadata FROM control_transition_events WHERE tenant_id=$1 AND entity_kind='effect_intent' AND entity_id=$2 AND to_state='executing'",
        [input.tenantId, effect.id])).rows;
      if (marker.length !== 1 || marker[0].safe_metadata.markerDigest !== input.markerDigest
        || !Number.isFinite(Date.parse(marker[0].safe_metadata.deadline ?? ""))) throw new Error("abs_feed_settlement_unavailable");
      const suffix = sha256Digest({ tenantId: input.tenantId, effectId: effect.id, markerDigest: input.markerDigest }).slice(7, 47);
      const key = `feed-settle:${suffix}:effect_intent`;
      const prior = (await tx.query<{ safe_metadata: { outcomeDigest?: string }; to_state: string }>(
        "SELECT safe_metadata,to_state FROM control_transition_events WHERE tenant_id=$1 AND entity_kind='effect_intent' AND idempotency_key=$2",
        [input.tenantId, key])).rows[0];
      if (prior) {
        if (prior.safe_metadata.outcomeDigest !== outcomeDigest || prior.to_state !== effect.state) throw new Error("abs_feed_settlement_conflict");
        return { replayed: true, effectState: effect.state };
      }
      if (effect.state !== "executing") throw new Error("abs_feed_settlement_unavailable");
      const leases = (await tx.query<{ payload: LeaseRecord }>(
        "SELECT payload FROM control_leases WHERE tenant_id=$1 AND attempt_id=$2 FOR UPDATE", [input.tenantId, attempt.id])).rows;
      const lease = leases.length === 1 ? domainEntitySchema.parse(leases[0].payload) as LeaseRecord : undefined;
      if (!lease || lease.jobId !== job.id || lease.nodeId !== input.nodeId || lease.epoch !== attempt.leaseEpoch)
        throw new Error("abs_feed_settlement_unavailable");
      const orphaned = job.state === "orphaned" && attempt.state === "orphaned";
      if (!orphaned && (job.state !== "running" || attempt.state !== "running")) throw new Error("abs_feed_settlement_unavailable");
      // A late/expired attempt cannot turn its observation into a successful execution claim.
      const state = orphaned || lease.state !== "active" || now >= Date.parse(marker[0].safe_metadata.deadline!)
        ? "ambiguous" as const : input.outcome;
      if (state !== "ambiguous") completionDeadline = Date.parse(marker[0].safe_metadata.deadline!);
      checkCompletion();
      const actor = { actorId: input.nodeId, actorType: "node" as const };
      const metadata = { markerDigest: input.markerDigest, outcomeDigest, requestedOutcome: input.outcome,
        ...(input.receiptDigest ? { receiptDigest: input.receiptDigest } : {}) };
      await this.#transitionWith(tx, { tenantId: input.tenantId, kind: "effect_intent", entityId: effect.id,
        expectedVersion: effect.version, toState: state, actor, occurredAt, transitionId: `transition:${key}`, idempotencyKey: key,
        safeMetadata: metadata, recordPatch: state === "confirmed" ? { destinationReceipt: input.receiptDigest }
          : { safeFailureCode: state === "ambiguous" ? "abs_feed_outcome_uncertain" : "abs_feed_read_failed" } }, true);
      if (!orphaned) {
        const terminal = state === "confirmed" ? "succeeded" : state === "failed" ? "failed" : "orphaned";
        for (const entity of [job, attempt] as const) await this.#transitionWith(tx, { tenantId: input.tenantId,
          kind: entity.kind, entityId: entity.id, expectedVersion: entity.version, toState: terminal, actor, occurredAt,
          transitionId: `transition:feed-settle:${suffix}:${entity.kind}`, idempotencyKey: `feed-settle:${suffix}:${entity.kind}`,
          safeMetadata: metadata, ...(entity.kind === "attempt" ? { recordPatch: { finishedAt: occurredAt } } : {}) }, true);
      }
      if (lease.state === "active") await this.#transitionWith(tx, { tenantId: input.tenantId, kind: "lease", entityId: lease.id,
        expectedVersion: lease.version, toState: "released", actor, occurredAt, transitionId: `transition:feed-settle:${suffix}:lease`,
        idempotencyKey: `feed-settle:${suffix}:lease`, safeMetadata: metadata }, true);
      return { replayed: false, effectState: state };
    }, checkCompletion);
  }

  async expireLease(input: ExpireLeaseInput): Promise<{ job: JobRecord; attempt: AttemptRecord; lease: LeaseRecord; replayed: boolean }> {
    return this.#transaction(async (tx) => {
      const prior = await tx.query<{ entity_id: string }>(
        `SELECT entity_id FROM control_transition_events WHERE tenant_id=$1 AND entity_kind='lease' AND idempotency_key=$2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (prior.rows.length) {
        if (prior.rows[0].entity_id !== input.leaseId) throw new Error("Expiry idempotency key reused for another lease");
        const lease = await this.#requireWith(tx, input.tenantId, "lease", input.leaseId) as LeaseRecord;
        if (lease.jobId !== input.jobId || lease.attemptId !== input.attemptId || lease.epoch !== input.epoch) {
          throw new Error("Expiry replay lineage or epoch mismatch");
        }
        const attempt = await this.#requireWith(tx, input.tenantId, "attempt", input.attemptId) as AttemptRecord;
        const job = await this.#requireWith(tx, input.tenantId, "job", input.jobId) as JobRecord;
        return { job, attempt, lease, replayed: true };
      }

      const lease = await this.#requireWith(tx, input.tenantId, "lease", input.leaseId) as LeaseRecord;
      if (lease.jobId !== input.jobId || lease.attemptId !== input.attemptId || lease.epoch !== input.epoch) {
        throw new Error("Lease lineage or epoch mismatch");
      }
      if (lease.state !== "active" || Date.parse(lease.expiresAt) > Date.parse(input.occurredAt)) {
        throw new Error("Lease is not eligible for expiry");
      }

      const leaseResult = await this.#transitionWith(tx, {
        tenantId: input.tenantId, kind: "lease", entityId: input.leaseId,
        expectedVersion: input.expectedLeaseVersion, toState: "expired", transitionId: input.transitionId,
        idempotencyKey: input.idempotencyKey, actor: input.actor, occurredAt: input.occurredAt,
      }, true);
      const attemptResult = await this.#transitionWith(tx, {
        tenantId: input.tenantId, kind: "attempt", entityId: input.attemptId,
        expectedVersion: input.expectedAttemptVersion, toState: "orphaned", transitionId: `${input.transitionId}:attempt`,
        idempotencyKey: `${input.idempotencyKey}:attempt`, actor: input.actor, occurredAt: input.occurredAt,
        recordPatch: { finishedAt: input.occurredAt },
      }, true);
      const currentJob = await this.#requireWith(tx, input.tenantId, "job", input.jobId) as JobRecord;
      const nextJobState = currentJob.state === "leased" ? "ready" : "orphaned";
      const jobResult = await this.#transitionWith(tx, {
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
    return this.#transaction(async (tx) => {
      const prior = await tx.query<{ payload: { leaseId: string; epoch: number; expiresAt: string } }>(
        `SELECT payload FROM control_outbox WHERE tenant_id=$1 AND topic='lease.renewed' AND idempotency_key=$2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (prior.rows.length) {
        if (prior.rows[0].payload.leaseId !== input.leaseId || prior.rows[0].payload.epoch !== input.epoch
          || prior.rows[0].payload.expiresAt !== input.expiresAt) throw new Error("Renewal idempotency key reused with different content");
        return { lease: await this.#requireWith(tx, input.tenantId, "lease", input.leaseId) as LeaseRecord, replayed: true };
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
      const job = await this.#requireWith(tx, input.tenantId, "job", current.jobId) as JobRecord;
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
    return this.#transaction(async (tx) => {
      const approval = await this.#requireWith(tx, input.tenantId, "approval", input.approvalId) as ApprovalRecord;
      const linkedEffect = await tx.query<{ project_id: string }>(
        `SELECT j.project_id FROM control_effect_intents e
         JOIN control_jobs j ON j.tenant_id=e.tenant_id AND j.id=e.job_id
         WHERE e.tenant_id=$1 AND e.approval_id=$2`,
        [input.tenantId, input.approvalId],
      );
      const decision = await this.#requirePolicyDecision(tx, {
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
      return this.#transitionWith(tx, {
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
    return this.#transaction(async (tx) => {
      const replay = await tx.query<{ entity_id: string; to_state: string }>(
        `SELECT entity_id,to_state FROM control_transition_events
         WHERE tenant_id=$1 AND entity_kind='effect_intent' AND idempotency_key=$2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (replay.rows.length) {
        if (replay.rows[0].entity_id !== input.effectIntentId || replay.rows[0].to_state !== "authorized") {
          throw new Error("Idempotency key conflicts with a different effect authorization");
        }
        return { entity: await this.#requireWith(tx, input.tenantId, "effect_intent", input.effectIntentId), replayed: true };
      }

      const effectRow = await tx.query<{ payload: EffectIntentRecord }>(
        `SELECT payload FROM control_effect_intents WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.effectIntentId],
      );
      const effect = effectRow.rows[0]?.payload;
      if (!effect) throw new Error("effect_intent not found");
      const job = await this.#requireWith(tx, input.tenantId, "job", effect.jobId) as JobRecord;
      const decision = await this.#requirePolicyDecision(tx, {
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

      return this.#transitionWith(tx, {
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

  async #insertWith(tx: DatabaseSession, entity: DomainEntity): Promise<void> {
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

  async #getWith(tx: DatabaseSession, tenantId: string, kind: EntityKind, id: string): Promise<DomainEntity | undefined> {
    const result = await tx.query<{ payload: DomainEntity }>(
      `SELECT payload FROM ${entityConfigs[kind].table} WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
    return result.rows[0] ? domainEntitySchema.parse(result.rows[0].payload) as DomainEntity : undefined;
  }

  async #requireWith(tx: DatabaseSession, tenantId: string, kind: EntityKind, id: string): Promise<DomainEntity> {
    const entity = await this.#getWith(tx, tenantId, kind, id);
    if (!entity) throw new Error(`${kind} ${id} not found`);
    return entity;
  }

  async #requirePolicyDecision(tx: DatabaseSession, input: {
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

  async #transitionWith(tx: DatabaseSession, input: TransitionInput, coordinated: boolean): Promise<TransitionResult> {
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
      return { entity: await this.#requireWith(tx, input.tenantId, input.kind, input.entityId), replayed: true };
    }

    // Every new ready transition shares this tenant lock so policy-bound ready counts cannot race a generic canonical transition.
    if (input.kind === "job" && input.toState === "ready") {
      const tenant = await tx.query<{ id: string }>("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [input.tenantId]);
      if (!tenant.rows[0]) throw new Error("Ready transition tenant not found");
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
    if (!coordinated && input.kind === "job" && current.state === "proposed" && input.toState === "ready"
      && (current as JobRecord).specVersion === "ready-frontier-work-order/v1") {
      throw new Error("Ready frontier jobs require the policy-bound promotion operation");
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

export interface ReadyFrontierCanonicalOperationsV1 {
  createProposedWorkBundle(input: ProposedWorkBundleWithActionInbox):
    Promise<ProposedWorkBundleResult & { actionInbox: ActionInboxItemV1 }>;
  promoteWithInternalHandoff(operationAuthorization: unknown): Promise<{ job: JobRecord; replayed: boolean }>;
}

const createReadyFrontierProposedWorkBundle = CanonicalStore.prototype.createReadyFrontierProposedWorkBundleWithActionInbox;
const promoteReadyFrontierWithInternalHandoff = CanonicalStore.prototype.promoteReadyFrontierJobWithInternalHandoff;
Object.freeze(CanonicalStore.prototype);

/** Captures the exact registered canonical operations used by the repository-only frontier composition. */
export function bindReadyFrontierCanonicalOperationsV1(value: unknown): ReadyFrontierCanonicalOperationsV1 | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !canonicalStores.has(value)
    || Object.getPrototypeOf(value) !== CanonicalStore.prototype || !Object.isFrozen(value)) return undefined;
  const store = value as CanonicalStore;
  return Object.freeze({
    createProposedWorkBundle: (input: ProposedWorkBundleWithActionInbox) =>
      createReadyFrontierProposedWorkBundle.call(store, input),
    promoteWithInternalHandoff: (operationAuthorization: unknown) =>
      promoteReadyFrontierWithInternalHandoff.call(store, operationAuthorization),
  });
}

/** Repository-simulation-only variant; generic and networked clients never receive this brand. */
export function bindReadyFrontierRepositoryCanonicalOperationsV1(value: unknown):
  ReadyFrontierCanonicalOperationsV1 | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value)
    || !repositorySimulationCanonicalStores.has(value)) return undefined;
  return bindReadyFrontierCanonicalOperationsV1(value);
}
