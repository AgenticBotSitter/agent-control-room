import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendAuditWith } from "../../audit/audit-store";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { evaluatePolicy, hmacSha256Tag, sha256Digest, type AuthenticatedPrincipal, type RoleGrant } from "../../security";
import { failWorkIntakeV1 } from "./errors";
import { workBatchProposalSchemaV1, workBatchReceiptSchemaV1, type WorkBatchProposalV1,
  type WorkBatchReceiptV1 } from "./schemas";
import { workBatchOwnerNotificationV1 } from "./owner-notification";

type Authorization = { allowed: true; workspaceId: string } | { allowed: false; safeReasonCode: "credential_inactive" | "no_matching_grant" };
type BatchRow = { id: string; tenant_id: string; project_id: string; proposed_by_identity_id: string;
  proposed_at: string | Date; state: string; approval_identity_id: string | null; approved_at: string | Date | null;
  decision_reason_code: string | null; decision_digest: string | null; decision_auth_tag: string | null;
  proposal: unknown; queue_depth_limit: number; batch_digest: string; auth_tag: string; version: number;
  created_at: string | Date; updated_at: string | Date };
type ItemRow = { id: string; tenant_id: string; batch_id: string; batch_revision: number; project_id: string;
  local_id: string; ordinal: number; role: "builder" | "checker" | "validator"; required_capability: string;
  depends_on_local_ids: string[]; requested_worker_kind: string | null; requested_model_key: string | null;
  acceptance_criteria: string; acceptance_tests: string; decision_state: "approved" | "rejected";
  decision_reason_code: string | null; job_id: string | null; job_attempt_count: number; item_digest: string;
  auth_tag: string; created_at: string | Date };

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const json = (value: unknown) => JSON.stringify(value);
const iso = (value: string | Date) => new Date(value).toISOString();
// Authenticated node principals are the audit schema's worker actor; all other
// principal actor types retain their exact value in refusal history.
const auditActor = (principal: AuthenticatedPrincipal): "human" | "agent" | "worker" | "service" =>
  principal.actorType === "node" ? "worker" : principal.actorType;

export class WorkBatchStoreV1 {
  readonly #key: Uint8Array;
  constructor(private readonly db: DatabaseClient, integrityKey: Uint8Array) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("work_intake_configuration_invalid");
    this.#key = Uint8Array.from(integrityKey);
  }

  async #authority(tx: DatabaseSession, principal: AuthenticatedPrincipal, projectId: string, now: string,
    action = "work_batches.propose"): Promise<Authorization> {
    const identity = (await tx.query<{ actor_type: string; state: string }>(
      `SELECT actor_type,state FROM control_identities WHERE tenant_id=$1 AND id=$2 FOR SHARE`,
      [principal.tenantId, principal.identityId])).rows[0];
    const project = (await tx.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM projects WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [principal.tenantId, projectId])).rows[0];
    if (principal.actorType !== "agent" || !identity || identity.state !== "active"
      || identity.actor_type !== "agent" || !project)
      return { allowed: false, safeReasonCode: "credential_inactive" };
    const rows = (await tx.query<{ id: string; role_key: string; allowed_actions: string[]; project_ids: string[];
      risk_ceiling: RoleGrant["riskCeiling"]; allow_external_effects: boolean; require_strong_factor: boolean;
      expires_at?: string | Date; revoked_at?: string | Date }>(`SELECT id,role_key,allowed_actions,project_ids,risk_ceiling,
        allow_external_effects,require_strong_factor,expires_at,revoked_at FROM control_role_grants
        WHERE tenant_id=$1 AND identity_id=$2 FOR SHARE`, [principal.tenantId, principal.identityId])).rows;
    const grants = rows.filter(row => row.role_key === "work_batch_proposer"
      && row.allowed_actions.length === 1 && row.allowed_actions[0] === "work_batches.propose"
      && row.risk_ceiling === "low" && row.allow_external_effects === false
      && row.require_strong_factor === false).map(row => ({ id: row.id,
      allowedActions: row.allowed_actions, projectIds: row.project_ids, riskCeiling: row.risk_ceiling,
      allowExternalEffects: row.allow_external_effects, requireStrongFactor: row.require_strong_factor,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
      revokedAt: row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at }));
    const decision = evaluatePolicy(principal, grants, { tenantId: principal.tenantId, action,
      resourceType: "project", resourceId: projectId, projectId, risk: "low", externalEffect: false, occurredAt: now });
    return decision.allowed ? { allowed: true, workspaceId: project.workspace_id }
      : { allowed: false, safeReasonCode: "no_matching_grant" };
  }

  async authorize(principal: AuthenticatedPrincipal, projectId: string, now: string): Promise<Authorization> {
    return this.authorizeAction(principal, projectId, "work_batches.propose", now);
  }

  async authorizeAction(principal: AuthenticatedPrincipal, projectId: string, action: string, now: string): Promise<Authorization> {
    return this.db.transaction(async tx => {
      const result = await this.#authority(tx, principal, projectId, now, action);
      // The production intake login may only write audit events attributed to
      // its bound agent identity. Non-agent credentials are still refused, but
      // are not represented as durable intake-agent activity.
      if (principal.actorType !== "agent") return result;
      if (!result.allowed) await appendAuditWith(tx, { id: `audit:work-intake-refusal:${randomUUID()}`,
        tenantId: principal.tenantId, projectId, actorId: principal.identityId, actorType: auditActor(principal),
        action: "work_batches.action.refused", targetType: "project", targetId: projectId,
        safeMetadata: { reasonCode: result.safeReasonCode, requestedAction: action }, occurredAt: now });
      return result;
    });
  }

  async recordValidationRefusal(principal: AuthenticatedPrincipal, projectId: string, reasonCode: string, now: string) {
    await this.db.transaction(tx => appendAuditWith(tx, { id: `audit:work-intake-refusal:${randomUUID()}`,
      tenantId: principal.tenantId, projectId, actorId: principal.identityId, actorType: auditActor(principal),
      action: "work_batches.propose.refused", targetType: "project", targetId: projectId,
      safeMetadata: { reasonCode }, occurredAt: now }).then(() => undefined));
  }

  async create(input: { principal: AuthenticatedPrincipal; proposal: WorkBatchProposalV1; proposalDigest: string;
    idempotencyKey: string; now: string; queueDepthLimit: number }): Promise<WorkBatchReceiptV1> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u.test(input.idempotencyKey)
      || !Number.isSafeInteger(input.queueDepthLimit) || input.queueDepthLimit < 1 || input.queueDepthLimit > 20)
      failWorkIntakeV1("invalid_input");
    const requestDigest = sha256Digest({ identityId: input.principal.identityId,
      idempotencyKey: input.idempotencyKey, proposalDigest: input.proposalDigest });
    const scope = `work-batches.propose/v1:${input.principal.identityId}`;
    return this.db.transaction(async tx => {
      const authority = await this.#authority(tx, input.principal, input.proposal.projectId, input.now);
      if (!authority.allowed) failWorkIntakeV1(authority.safeReasonCode);
      const inserted = await tx.query(`INSERT INTO control_idempotency
        (tenant_id,operation_scope,idempotency_key,request_digest,status) VALUES($1,$2,$3,$4,'processing')
        ON CONFLICT(tenant_id,operation_scope,idempotency_key) DO NOTHING RETURNING idempotency_key`,
      [input.principal.tenantId, scope, input.idempotencyKey, requestDigest]);
      const durable = (await tx.query<{ request_digest: string; status: string; result: unknown }>(
        `SELECT request_digest,status,result FROM control_idempotency WHERE tenant_id=$1 AND operation_scope=$2
         AND idempotency_key=$3 FOR UPDATE`, [input.principal.tenantId, scope, input.idempotencyKey])).rows[0];
      if (!durable || durable.request_digest !== requestDigest) failWorkIntakeV1("replay_conflict");
      if (!inserted.rows.length) {
        const receipt = workBatchReceiptSchemaV1.safeParse(durable.result);
        if (durable.status !== "completed" || !receipt.success) failWorkIntakeV1("replay_conflict");
        await appendAuditWith(tx, { id: `audit:work-intake-replay:${randomUUID()}`,
          tenantId: input.principal.tenantId, workspaceId: authority.workspaceId,
          projectId: input.proposal.projectId, actorId: input.principal.identityId,
          actorType: auditActor(input.principal), action: "work_batches.propose.replayed",
          targetType: "work_batch", targetId: receipt.data.batchId, idempotencyKey: input.idempotencyKey,
          safeMetadata: { proposalDigest: input.proposalDigest }, occurredAt: input.now });
        return { ...receipt.data, replayed: true };
      }
      const batchId = `batch:${randomUUID()}`;
      const material = { id: batchId, tenantId: input.principal.tenantId, projectId: input.proposal.projectId,
        proposedByIdentityId: input.principal.identityId, proposedAt: input.now, state: "proposed",
        proposal: input.proposal, queueDepthLimit: input.queueDepthLimit, batchDigest: input.proposalDigest,
        version: 1, createdAt: input.now, updatedAt: input.now };
      const tag = hmacSha256Tag(this.#key, { purpose: "work-batch/v1", record: material });
      await tx.query(`INSERT INTO work_batches(id,tenant_id,project_id,proposed_by_identity_id,
        proposed_by_actor_type,proposed_at,state,proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,'agent',$5,'proposed',$6::jsonb,$7,$8,$9,1,$5,$5)`,
      [batchId, input.principal.tenantId, input.proposal.projectId, input.principal.identityId, input.now,
        json(input.proposal), input.queueDepthLimit, input.proposalDigest, tag]);
      const revisionMaterial = { id: `${batchId}:revision:1`, tenantId: input.principal.tenantId, batchId,
        revision: 1, editedByIdentityId: input.principal.identityId, editedAt: input.now,
        reasonCode: "submitted", proposal: input.proposal, revisionDigest: input.proposalDigest };
      const revisionTag = hmacSha256Tag(this.#key, { purpose: "work-batch-revision/v1", record: revisionMaterial });
      await tx.query(`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,
        edited_at,reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,$3,1,$4,$5,'submitted',$6::jsonb,$7,$8)`,
      [revisionMaterial.id, input.principal.tenantId, batchId, input.principal.identityId, input.now,
        json(input.proposal), input.proposalDigest, revisionTag]);
      const notification = workBatchOwnerNotificationV1({ tenantId: input.principal.tenantId,
        projectId: input.proposal.projectId, batchId, createdAt: input.now });
      await tx.query(`INSERT INTO control_action_inbox
        (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
        VALUES($1,$2,$3,$4,'approval','open','delivered',$5,NULL,$6::jsonb)`,
      [notification.item.id, input.principal.tenantId, input.proposal.projectId, batchId, input.now, json(notification.item)]);
      const receipt = workBatchReceiptSchemaV1.parse({ schema: "control-room.work-batch-receipt/v1", batchId,
        projectId: input.proposal.projectId, state: "proposed", proposalDigest: input.proposalDigest,
        revision: 1, replayed: false, startsWork: false, grantsExecutionAuthority: false });
      await appendAuditWith(tx, { id: `audit:work-intake:${batchId}`, tenantId: input.principal.tenantId,
        workspaceId: authority.workspaceId, projectId: input.proposal.projectId, actorId: input.principal.identityId,
        actorType: auditActor(input.principal), action: "work_batches.propose", targetType: "work_batch", targetId: batchId,
        idempotencyKey: input.idempotencyKey, safeMetadata: { proposalDigest: input.proposalDigest,
          taskCount: input.proposal.tasks.length, edgeCount: input.proposal.edges.length }, occurredAt: input.now });
      await tx.query(`UPDATE control_idempotency SET status='completed',result=$1::jsonb,completed_at=$2
        WHERE tenant_id=$3 AND operation_scope=$4 AND idempotency_key=$5 AND request_digest=$6 AND status='processing'`,
      [json(receipt), input.now, input.principal.tenantId, scope, input.idempotencyKey, requestDigest]);
      return receipt;
    });
  }

  #verify(row: BatchRow): WorkBatchProposalV1 {
    const proposal = workBatchProposalSchemaV1.parse(row.proposal);
    const digest = sha256Digest(proposal);
    const material = { id: row.id, tenantId: row.tenant_id, projectId: row.project_id,
      proposedByIdentityId: row.proposed_by_identity_id, proposedAt: iso(row.proposed_at), state: "proposed",
      proposal, queueDepthLimit: Number(row.queue_depth_limit), batchDigest: row.batch_digest,
      version: 1, createdAt: iso(row.created_at), updatedAt: iso(row.created_at) };
    const expected = hmacSha256Tag(this.#key, { purpose: "work-batch/v1", record: material });
    if (!new Set(["proposed", "approved", "partially_approved", "rejected"]).has(row.state)
      || Number(row.version) < 1 || digest !== row.batch_digest
      || !same(expected, row.auth_tag)) failWorkIntakeV1("integrity_failed");
    return proposal;
  }

  async #verifyStoredState(row: BatchRow): Promise<WorkBatchProposalV1> {
    const proposal = this.#verify(row);
    const items = (await this.db.query<ItemRow>(`SELECT id,tenant_id,batch_id,batch_revision,project_id,local_id,
      ordinal,role,required_capability,depends_on_local_ids,requested_worker_kind,requested_model_key,
      acceptance_criteria,acceptance_tests,decision_state,decision_reason_code,job_id,job_attempt_count,
      item_digest,auth_tag,created_at FROM work_batch_items
      WHERE tenant_id=$1 AND batch_id=$2 ORDER BY ordinal`, [row.tenant_id, row.id])).rows;
    if (row.state === "proposed") {
      if (row.decision_digest !== null || row.decision_auth_tag !== null || row.approval_identity_id !== null
        || row.approved_at !== null || row.decision_reason_code !== null || items.length) failWorkIntakeV1("integrity_failed");
      return proposal;
    }
    for (const item of items) {
      const material = { id: item.id, tenantId: item.tenant_id, batchId: item.batch_id,
        batchRevision: Number(item.batch_revision), projectId: item.project_id, localId: item.local_id,
        ordinal: Number(item.ordinal), role: item.role, requiredCapability: item.required_capability,
        dependsOnLocalIds: item.depends_on_local_ids, requestedWorkerKind: item.requested_worker_kind,
        requestedModelKey: item.requested_model_key, acceptanceCriteria: item.acceptance_criteria,
        acceptanceTests: item.acceptance_tests, decisionState: item.decision_state,
        decisionReasonCode: item.decision_reason_code, jobId: item.job_id,
        jobAttemptCount: Number(item.job_attempt_count), createdAt: iso(item.created_at) };
      if (sha256Digest(material) !== item.item_digest
        || !same(hmacSha256Tag(this.#key, { purpose: "work-batch-item/v1", record: material }), item.auth_tag))
        failWorkIntakeV1("integrity_failed");
    }
    if (!row.approval_identity_id || !row.approved_at || !row.decision_digest || !row.decision_auth_tag || !items.length)
      failWorkIntakeV1("integrity_failed");
    const material = { id: `${row.id}:decision`, tenantId: row.tenant_id, batchId: row.id, projectId: row.project_id,
      batchRevision: Number(row.version), state: row.state, approvalIdentityId: row.approval_identity_id,
      approvedAt: iso(row.approved_at), decisionReasonCode: row.decision_reason_code,
      itemDigests: items.map(item => item.item_digest) };
    if (sha256Digest(material) !== row.decision_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "work-batch-decision/v1", record: material }), row.decision_auth_tag))
      failWorkIntakeV1("integrity_failed");
    return proposal;
  }

  async status(principal: AuthenticatedPrincipal, projectId: string, batchId: string, now: string) {
    const auth = await this.authorize(principal, projectId, now); if (!auth.allowed) failWorkIntakeV1(auth.safeReasonCode);
    const row = (await this.db.query<BatchRow>(`SELECT id,tenant_id,project_id,proposed_by_identity_id,proposed_at,
      state,approval_identity_id,approved_at,decision_reason_code,decision_digest,decision_auth_tag,
      proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at
      FROM work_batches WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND proposed_by_identity_id=$4`,
    [principal.tenantId, projectId, batchId, principal.identityId])).rows[0];
    if (!row) failWorkIntakeV1("batch_not_found");
    const proposal = await this.#verifyStoredState(row);
    return { batchId: row.id, projectId, state: row.state as "proposed" | "approved" | "partially_approved" | "rejected", proposalDigest: row.batch_digest,
      taskCount: proposal.tasks.length, startsWork: false as const, grantsExecutionAuthority: false as const };
  }

  async list(principal: AuthenticatedPrincipal, projectId: string, now: string) {
    const auth = await this.authorize(principal, projectId, now); if (!auth.allowed) failWorkIntakeV1(auth.safeReasonCode);
    const rows = (await this.db.query<BatchRow>(`SELECT id,tenant_id,project_id,proposed_by_identity_id,proposed_at,
      state,approval_identity_id,approved_at,decision_reason_code,decision_digest,decision_auth_tag,
      proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at
      FROM work_batches WHERE tenant_id=$1 AND project_id=$2 AND proposed_by_identity_id=$3 ORDER BY proposed_at,id LIMIT 100`,
    [principal.tenantId, projectId, principal.identityId])).rows;
    return Promise.all(rows.map(async row => { await this.#verifyStoredState(row); return { batchId: row.id,
      state: row.state as "proposed" | "approved" | "partially_approved" | "rejected",
      proposalDigest: row.batch_digest }; }));
  }
}
