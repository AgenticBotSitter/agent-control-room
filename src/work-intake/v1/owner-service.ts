import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority, type WebActor } from "../../web/v1/session-authority";
import { WebTaskService } from "../../web/v1/task-service";
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "./schemas";
import { workBatchProposalDigestV1 } from "./digest";
import { captureWorkBatchQueueCatalogV1, resolveWorkBatchQueueWorkerV1,
  type WorkBatchQueueCatalogV1 } from "./queue-catalog";
import { workBatchOwnerCommandSchemaV1, workBatchOwnerPageSchemaV1, workBatchOwnerReceiptSchemaV1, workBatchOwnerViewSchemaV1,
  type WorkBatchOwnerReceiptV1 } from "./owner-schemas";

type BatchRow = { id: string; tenant_id: string; project_id: string; proposed_by_identity_id: string;
  proposed_at: string | Date; state: string; approval_identity_id: string | null; approved_at: string | Date | null;
  decision_reason_code: string | null; proposal: unknown; queue_depth_limit: number; batch_digest: string;
  auth_tag: string; auth_material_version: number; decision_digest: string | null; decision_auth_tag: string | null;
  version: number; created_at: string | Date; updated_at: string | Date };
type RevisionRow = { revision: number; edited_by_identity_id: string; edited_at: string | Date;
  reason_code: string; proposal: unknown; revision_digest: string; auth_tag: string };
type BatchRevisionRow = RevisionRow & { batch_id: string };
type ItemRow = { id: string; tenant_id: string; batch_id: string; batch_revision: number; project_id: string;
  local_id: string; ordinal: number; role: "builder" | "checker" | "validator";
  required_capability: string; depends_on_local_ids: string[]; requested_worker_id: string | null;
  requested_worker_kind: string | null;
  requested_model_key: string | null; acceptance_criteria: string; acceptance_tests: string;
  decision_state: "approved" | "rejected"; decision_reason_code: string | null; job_id: string | null;
  job_attempt_count: number; item_digest: string; auth_tag: string; created_at: string | Date };
type AdmissionRow = { admission_id: string; item_id: string; batch_id: string; project_id: string; job_id: string; worker_id: string;
  worker_kind: "codex" | "claude-code" | "hermes"; node_id: string; queue_position: number;
  queue_depth_limit: number; selection_key: string; model: string; effort: string; provider: string | null;
  profile: string | null; assignment_revision: number; supersedes_admission_id: string | null;
  change_reason_code: string; authorized_by_identity_id: string;
  admission_digest: string; auth_tag: string; admitted_at: string | Date };

export type WorkBatchQueueAdmissionSelectionV1 = Readonly<{ workerId: string;
  workerKind: "codex" | "claude-code" | "hermes"; nodeId: string; selectionKey: string;
  model: string; effort: string; provider: string | null; profile: string | null }>;
export type WorkBatchQueueAcceptedResultSelectionV1 = Readonly<{
  sourceJobId: string; workerId: string; nodeId: string;
}>;
export type WorkBatchQueueAcceptedResultProofV1 = Readonly<{
  executionJobId: string; attemptId: string; harnessRunId: string; artifactId: string;
  contentHash: string; revision: number;
}>;
/** Protected host-generation authority. Exact-worker admission is unavailable
 * without this current readiness/model-policy recheck.
 *
 * The three accepted-result operations are passed the caller's session only as
 * a boundary marker, never as the place their reads run. They belong to the
 * task coordinator, which owns lifecycle and transition data the private-web
 * login may not read, so an implementation MUST resolve them on its own pool and
 * return only the proof below. A caller's transaction that is aborted by an
 * unreadable table cannot be repaired by catching the JavaScript error. */
export type WorkBatchQueueAdmissionAuthorityV1 = Readonly<{
  assertCurrent(selection: WorkBatchQueueAdmissionSelectionV1): boolean | Promise<boolean>;
  isAcceptedResultCurrent(tx: DatabaseSession,
    selection: WorkBatchQueueAcceptedResultSelectionV1): boolean | Promise<boolean>;
  /** Optional authenticated Completion Gate round for read-only pipeline presentation. */
  acceptedResultRevision?(tx: DatabaseSession,
    selection: WorkBatchQueueAcceptedResultSelectionV1): number | null | Promise<number | null>;
  /** Exact authenticated proof used for pipeline handoff presentation.  This
   * must describe the same retained result accepted by Completion Gate, not a
   * newer artifact for the job. */
  acceptedResultProof?(tx: DatabaseSession,
    selection: WorkBatchQueueAcceptedResultSelectionV1): WorkBatchQueueAcceptedResultProofV1 | null
      | Promise<WorkBatchQueueAcceptedResultProofV1 | null>;
}>;

const json = (value: unknown) => JSON.stringify(value);
const iso = (value: string | Date) => new Date(value).toISOString();
const same = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b); };

export class WorkBatchOwnerServiceV1 {
  readonly #key: Uint8Array;
  readonly #authority: WebSessionAuthority;
  readonly #queueCatalog: WorkBatchQueueCatalogV1;
  readonly #queueAdmissionAuthority?: WorkBatchQueueAdmissionAuthorityV1;
  constructor(private readonly db: DatabaseClient, private readonly tasks: WebTaskService,
    private readonly scope: { tenantId: string; workspaceId: string }, integrityKey: Uint8Array,
    private readonly clock: () => number = Date.now, queueCatalog: WorkBatchQueueCatalogV1 = [],
    queueAdmissionAuthority?: WorkBatchQueueAdmissionAuthorityV1) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("work_batch_owner_configuration_invalid");
    this.#key = Uint8Array.from(integrityKey);
    this.#authority = new WebSessionAuthority(db, scope, clock, "work_batch");
    this.#queueCatalog = captureWorkBatchQueueCatalogV1(queueCatalog);
    if (queueAdmissionAuthority && (typeof queueAdmissionAuthority.assertCurrent !== "function"
      || typeof queueAdmissionAuthority.isAcceptedResultCurrent !== "function"))
      throw new Error("work_batch_owner_configuration_invalid");
    this.#queueAdmissionAuthority = queueAdmissionAuthority ? Object.freeze({
      assertCurrent: queueAdmissionAuthority.assertCurrent.bind(queueAdmissionAuthority),
      isAcceptedResultCurrent: queueAdmissionAuthority.isAcceptedResultCurrent.bind(queueAdmissionAuthority),
    }) : undefined;
  }

  #verifyAdmission(row: AdmissionRow) {
    const material = { itemId: row.item_id, batchId: row.batch_id, projectId: row.project_id, jobId: row.job_id,
      workerId: row.worker_id, workerKind: row.worker_kind, nodeId: row.node_id, position: Number(row.queue_position),
      queueDepthLimit: Number(row.queue_depth_limit), selectionKey: row.selection_key, model: row.model,
      effort: row.effort, provider: row.provider, profile: row.profile,
      assignmentRevision: Number(row.assignment_revision), supersedesAdmissionId: row.supersedes_admission_id,
      changeReasonCode: row.change_reason_code, authorizedByIdentityId: row.authorized_by_identity_id,
      admittedAt: iso(row.admitted_at) };
    if (sha256Digest(material) !== row.admission_digest
      || row.admission_id !== `admission:${row.admission_digest.slice(7)}`
      || !same(hmacSha256Tag(this.#key, { purpose: "work-batch-queue-admission/v1", record: material }), row.auth_tag))
      throw new Error("work_batch_integrity_failed");
    return material;
  }

  async #acceptedResult(tx: DatabaseSession, selection: WorkBatchQueueAcceptedResultSelectionV1) {
    if (!this.#queueAdmissionAuthority) return false;
    try { return await this.#queueAdmissionAuthority.isAcceptedResultCurrent(tx, selection) === true; }
    catch { return false; }
  }

  async #queueState(tx: DatabaseSession, row: AdmissionRow) {
    const plan = (await tx.query<{ job_id: string }>(`SELECT job_id FROM control_task_execution_plans
      WHERE tenant_id=$1 AND source_job_id=$2`, [this.scope.tenantId, row.job_id])).rows[0];
    if (!plan) return "awaiting_preparation" as const;
    const executionJobId = plan.job_id;
    const job = (await tx.query<{ state: string }>(`SELECT state FROM control_jobs
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3`, [this.scope.tenantId, row.project_id, executionJobId])).rows[0];
    if (!job) return "uncertain" as const;
    if (job.state === "succeeded") return await this.#acceptedResult(tx, {
      sourceJobId: row.job_id, workerId: row.worker_id, nodeId: row.node_id,
    }) ? "completed" as const : "uncertain" as const;
    if (["failed", "cancelled"].includes(job.state)) return "failed" as const;
    const selection = (await tx.query<{ worker_kind: string | null; selection_key: string | null; model: string | null;
      effort: string | null; provider: string | null; profile: string | null }>(`SELECT worker_kind,selection_key,
        model,effort,provider,profile FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$2`,
    [this.scope.tenantId, executionJobId])).rows[0];
    if (!selection || selection.worker_kind !== row.worker_kind || selection.selection_key !== row.selection_key
      || selection.model !== row.model || selection.effort !== row.effort || selection.provider !== row.provider
      || selection.profile !== row.profile) return "uncertain" as const;
    const attempt = (await tx.query<{ state: string; worker_id: string | null; node_id: string | null }>(`SELECT state,worker_id,node_id FROM control_attempts
      WHERE tenant_id=$1 AND job_id=$2 ORDER BY attempt_number DESC LIMIT 1`,
    [this.scope.tenantId, executionJobId])).rows[0];
    if (attempt && (attempt.worker_id !== row.worker_id || attempt.node_id !== row.node_id)) return "uncertain" as const;
    if (attempt?.state === "running") return "running" as const;
    const native = await tx.query(`SELECT job_id FROM control_native_task_queue WHERE tenant_id=$1 AND job_id=$2 LIMIT 1`,
      [this.scope.tenantId, executionJobId]);
    if (native.rows.length) return attempt && ["offered", "leased", "waiting"].includes(attempt.state)
      ? "queued" as const : "uncertain" as const;
    if (attempt && ["offered", "leased", "waiting"].includes(attempt.state)) return "assigned" as const;
    if (attempt) return "uncertain" as const;
    const dependencies = (await tx.query<{ depends_on_job_id: string; worker_id: string | null; node_id: string | null }>(
      `SELECT d.depends_on_job_id,a.worker_id,a.node_id FROM control_job_dependencies d
      LEFT JOIN work_batch_effective_queue_admissions a
        ON a.tenant_id=d.tenant_id AND a.job_id=d.depends_on_job_id
      WHERE d.tenant_id=$1 AND d.job_id=$2 ORDER BY d.depends_on_job_id`,
    [this.scope.tenantId, row.job_id])).rows;
    for (const dependency of dependencies) if (!dependency.worker_id || !dependency.node_id
      || !await this.#acceptedResult(tx, { sourceJobId: dependency.depends_on_job_id,
        workerId: dependency.worker_id, nodeId: dependency.node_id }))
      return "waiting_dependency" as const;
    const earlier = (await tx.query<{ job_id: string; worker_id: string; node_id: string }>(`SELECT job_id,worker_id,node_id
      FROM work_batch_effective_queue_admissions
      WHERE tenant_id=$1 AND worker_id=$2 AND queue_position<$3 ORDER BY queue_position`,
    [this.scope.tenantId, row.worker_id, Number(row.queue_position)])).rows;
    for (const prior of earlier) if (!await this.#acceptedResult(tx, { sourceJobId: prior.job_id,
      workerId: prior.worker_id, nodeId: prior.node_id })) return "waiting_turn" as const;
    return "ready_for_assignment" as const;
  }

  #verifyBatch(row: BatchRow): WorkBatchProposalV1 {
    const proposal = workBatchProposalSchemaV1.parse(row.proposal);
    const material = { id: row.id, tenantId: row.tenant_id, projectId: row.project_id,
      proposedByIdentityId: row.proposed_by_identity_id, proposedAt: iso(row.proposed_at), state: "proposed",
      proposal, queueDepthLimit: Number(row.queue_depth_limit), batchDigest: row.batch_digest,
      version: 1, createdAt: iso(row.created_at), updatedAt: iso(row.created_at) };
    const expected = hmacSha256Tag(this.#key, { purpose: "work-batch/v1", record: material });
    if (Number(row.auth_material_version) !== 1
      || workBatchProposalDigestV1(proposal) !== row.batch_digest || !same(expected, row.auth_tag))
      throw new Error("work_batch_integrity_failed");
    return proposal;
  }

  #verifyRevision(row: RevisionRow, batchId: string): WorkBatchProposalV1 {
    const proposal = workBatchProposalSchemaV1.parse(row.proposal);
    const material = { id: `${batchId}:revision:${Number(row.revision)}`, tenantId: this.scope.tenantId, batchId,
      revision: Number(row.revision), editedByIdentityId: row.edited_by_identity_id, editedAt: iso(row.edited_at),
      reasonCode: row.reason_code, proposal, revisionDigest: row.revision_digest };
    const expected = hmacSha256Tag(this.#key, { purpose: "work-batch-revision/v1", record: material });
    if (workBatchProposalDigestV1(proposal) !== row.revision_digest || !same(expected, row.auth_tag))
      throw new Error("work_batch_integrity_failed");
    return proposal;
  }

  async #currentProposal(tx: DatabaseSession, row: BatchRow): Promise<WorkBatchProposalV1> {
    const original = this.#verifyBatch(row);
    const revision = (await tx.query<RevisionRow>(`SELECT revision,edited_by_identity_id,edited_at,reason_code,proposal,
      revision_digest,auth_tag FROM work_batch_revisions WHERE tenant_id=$1 AND batch_id=$2
      ORDER BY revision DESC LIMIT 1`, [this.scope.tenantId, row.id])).rows[0];
    if (!revision) return original;
    if (Number(revision.revision) !== Number(row.version)) throw new Error("work_batch_integrity_failed");
    return this.#verifyRevision(revision, row.id);
  }

  async #currentProposals(tx: DatabaseSession, rows: readonly BatchRow[]) {
    const proposals = new Map(rows.map(row => [row.id, this.#verifyBatch(row)]));
    if (!rows.length) return proposals;
    const revisions = (await tx.query<BatchRevisionRow>(`SELECT DISTINCT ON (batch_id)
      batch_id,revision,edited_by_identity_id,edited_at,reason_code,proposal,revision_digest,auth_tag
      FROM work_batch_revisions WHERE tenant_id=$1 AND batch_id=ANY($2::text[])
      ORDER BY batch_id,revision DESC`, [this.scope.tenantId, rows.map(row => row.id)])).rows;
    const latest = new Map(revisions.map(revision => [revision.batch_id, revision]));
    for (const row of rows) {
      const revision = latest.get(row.id);
      if (!revision) continue;
      if (Number(revision.revision) !== Number(row.version)) throw new Error("work_batch_integrity_failed");
      proposals.set(row.id, this.#verifyRevision(revision, row.id));
    }
    return proposals;
  }

  async #itemsByBatch(tx: DatabaseSession, rows: readonly BatchRow[]) {
    const decidedIds = rows.filter(row => row.state !== "proposed").map(row => row.id);
    const grouped = new Map<string, ItemRow[]>();
    if (!decidedIds.length) return grouped;
    const items = (await tx.query<ItemRow>(`SELECT id,tenant_id,batch_id,batch_revision,
      project_id,local_id,ordinal,role,required_capability,depends_on_local_ids,requested_worker_id,
      requested_worker_kind,
      requested_model_key,acceptance_criteria,acceptance_tests,decision_state,decision_reason_code,job_id,
      job_attempt_count,item_digest,auth_tag,created_at FROM work_batch_items
      WHERE tenant_id=$1 AND batch_id=ANY($2::text[]) ORDER BY batch_id,ordinal`,
    [this.scope.tenantId, decidedIds])).rows;
    for (const item of items) grouped.set(item.batch_id, [...(grouped.get(item.batch_id) ?? []), item]);
    return grouped;
  }

  #verifyItem(row: ItemRow) {
    const material = { id: row.id, tenantId: row.tenant_id, batchId: row.batch_id,
      batchRevision: Number(row.batch_revision), projectId: row.project_id, localId: row.local_id,
      ordinal: Number(row.ordinal), role: row.role, requiredCapability: row.required_capability,
      dependsOnLocalIds: row.depends_on_local_ids,
      ...(row.requested_worker_id ? { requestedWorkerId: row.requested_worker_id } : {}),
      requestedWorkerKind: row.requested_worker_kind,
      requestedModelKey: row.requested_model_key, acceptanceCriteria: row.acceptance_criteria,
      acceptanceTests: row.acceptance_tests, decisionState: row.decision_state,
      decisionReasonCode: row.decision_reason_code, jobId: row.job_id,
      jobAttemptCount: Number(row.job_attempt_count), createdAt: iso(row.created_at) };
    const digest = sha256Digest(material);
    const tag = hmacSha256Tag(this.#key, { purpose: "work-batch-item/v1", record: material });
    if (digest !== row.item_digest || !same(tag, row.auth_tag)) throw new Error("work_batch_integrity_failed");
  }

  #verifyProposedState(row: BatchRow, itemCount: number) {
    if (row.approval_identity_id !== null || row.approved_at !== null || row.decision_reason_code !== null
      || row.decision_digest !== null || row.decision_auth_tag !== null || itemCount !== 0)
      throw new Error("work_batch_integrity_failed");
  }

  #verifyDecision(row: BatchRow, items: readonly ItemRow[]) {
    if (row.state === "proposed") {
      this.#verifyProposedState(row, items.length);
      return;
    }
    for (const item of items) this.#verifyItem(item);
    if (!row.approval_identity_id || !row.approved_at || !row.decision_digest || !row.decision_auth_tag)
      throw new Error("work_batch_integrity_failed");
    const material = { id: `${row.id}:decision`, tenantId: row.tenant_id, batchId: row.id,
      projectId: row.project_id, batchRevision: Number(row.version), state: row.state,
      approvalIdentityId: row.approval_identity_id, approvedAt: iso(row.approved_at),
      decisionReasonCode: row.decision_reason_code, itemDigests: items.map(item => item.item_digest) };
    if (sha256Digest(material) !== row.decision_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "work-batch-decision/v1", record: material }), row.decision_auth_tag))
      throw new Error("work_batch_integrity_failed");
  }

  async #batch(tx: DatabaseSession, projectId: string, batchId: string, lock: boolean): Promise<BatchRow> {
    const row = (await tx.query<BatchRow>(`SELECT id,tenant_id,project_id,proposed_by_identity_id,proposed_at,state,
      approval_identity_id,approved_at,decision_reason_code,proposal,queue_depth_limit,batch_digest,auth_tag,auth_material_version,
      decision_digest,decision_auth_tag,version,
      created_at,updated_at FROM work_batches WHERE tenant_id=$1 AND project_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`,
    [this.scope.tenantId, projectId, batchId])).rows[0];
    if (!row) throw new WebAccessError("not_found");
    this.#verifyBatch(row); return row;
  }

  async command(identity: VerifiedWebIdentity, projectId: string, value: unknown, idempotencyKey: string) {
    const parsed = workBatchOwnerCommandSchemaV1.safeParse(value);
    if (!parsed.success || parsed.data.batchId.length > 180 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u.test(idempotencyKey))
      throw new WebAccessError("invalid_request");
    try { if (parsed.data.operation === "revise") assertNoSecretMaterial(parsed.data.proposal, "work batch revision"); }
    catch { throw new WebAccessError("invalid_request"); }
    const requestDigest = sha256Digest({ ...this.scope, projectId, actorCommand: parsed.data });
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      actor.require("work_batches.decide", projectId, true);
      const batch = await this.#batch(tx, projectId, parsed.data.batchId, true);
      const operationScope = `work-batches.owner/v1:${actor.id}`;
      const inserted = await tx.query(`INSERT INTO control_idempotency
        (tenant_id,operation_scope,idempotency_key,request_digest,status) VALUES($1,$2,$3,$4,'processing')
        ON CONFLICT(tenant_id,operation_scope,idempotency_key) DO NOTHING RETURNING idempotency_key`,
      [this.scope.tenantId, operationScope, idempotencyKey, requestDigest]);
      const durable = (await tx.query<{ request_digest: string; status: string; result: unknown }>(`SELECT request_digest,status,result
        FROM control_idempotency WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3 FOR UPDATE`,
      [this.scope.tenantId, operationScope, idempotencyKey])).rows[0];
      if (!durable || durable.request_digest !== requestDigest) throw new WebAccessError("conflict");
      if (!inserted.rows.length) {
        const receipt = workBatchOwnerReceiptSchemaV1.safeParse(durable.result);
        if (durable.status !== "completed" || !receipt.success || receipt.data.batchId !== batch.id
          || receipt.data.projectId !== projectId) throw new WebAccessError("conflict");
        return { ...receipt.data, replayed: true };
      }
      if (batch.state !== "proposed" || Number(batch.version) !== parsed.data.expectedRevision)
        throw new WebAccessError("conflict");
      const existingItemCount = Number((await tx.query<{ count: string | number }>(`SELECT count(*) AS count
        FROM work_batch_items WHERE tenant_id=$1 AND batch_id=$2`, [this.scope.tenantId, batch.id])).rows[0]?.count ?? -1);
      this.#verifyProposedState(batch, existingItemCount);
      const receipt = parsed.data.operation === "revise"
        ? await this.#revise(tx, actor, batch, parsed.data.proposal, parsed.data.reasonCode)
        : await this.#decide(tx, actor, batch, parsed.data.items);
      await tx.query(`UPDATE control_idempotency SET status='completed',result=$1::jsonb,completed_at=$2
        WHERE tenant_id=$3 AND operation_scope=$4 AND idempotency_key=$5 AND request_digest=$6 AND status='processing'`,
      [json(receipt), actor.now, this.scope.tenantId, operationScope, idempotencyKey, requestDigest]);
      return receipt;
    });
  }

  async #revise(tx: DatabaseSession, actor: WebActor, batch: BatchRow, proposal: WorkBatchProposalV1,
    reasonCode: string): Promise<WorkBatchOwnerReceiptV1> {
    if (proposal.projectId !== batch.project_id) throw new WebAccessError("invalid_request");
    const revision = Number(batch.version) + 1, digest = workBatchProposalDigestV1(proposal);
    const material = { id: `${batch.id}:revision:${revision}`, tenantId: this.scope.tenantId, batchId: batch.id,
      revision, editedByIdentityId: actor.id, editedAt: actor.now, reasonCode, proposal, revisionDigest: digest };
    const tag = hmacSha256Tag(this.#key, { purpose: "work-batch-revision/v1", record: material });
    await tx.query(`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,edited_at,
      reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [material.id, this.scope.tenantId, batch.id, revision, actor.id, actor.now, reasonCode, json(proposal), digest, tag]);
    const updated = await tx.query<{ id: string }>(`UPDATE work_batches SET version=$1,updated_at=$2
      WHERE tenant_id=$3 AND id=$4 AND state='proposed' AND version=$5 RETURNING id`,
    [revision, actor.now, this.scope.tenantId, batch.id, Number(batch.version)]);
    if (updated.rows.length !== 1 || updated.rows[0]?.id !== batch.id) throw new WebAccessError("conflict");
    await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, projectId: batch.project_id,
      actorId: actor.id, actorType: "human", action: "work_batches.revise", targetType: "work_batch", targetId: batch.id,
      safeMetadata: { revision, proposalDigest: digest, reasonCode }, occurredAt: actor.now });
    return workBatchOwnerReceiptSchemaV1.parse({ schema: "control-room.work-batch-owner-receipt/v1", batchId: batch.id,
      projectId: batch.project_id, state: "proposed", revision, jobIds: [], replayed: false,
      startsWork: false, grantsExecutionAuthority: false });
  }

  async #decide(tx: DatabaseSession, actor: WebActor, batch: BatchRow,
    decisions: readonly { localId: string; decision: "approve" | "reject"; reasonCode?: string }[]): Promise<WorkBatchOwnerReceiptV1> {
    const revisionRow = (await tx.query<RevisionRow>(`SELECT revision,edited_by_identity_id,edited_at,reason_code,proposal,
      revision_digest,auth_tag FROM work_batch_revisions WHERE tenant_id=$1 AND batch_id=$2 AND revision=$3`,
    [this.scope.tenantId, batch.id, Number(batch.version)])).rows[0];
    if (!revisionRow) throw new Error("work_batch_integrity_failed");
    const proposal = this.#verifyRevision(revisionRow, batch.id);
    const byLocal = new Map(decisions.map(item => [item.localId, item]));
    if (byLocal.size !== decisions.length || byLocal.size !== proposal.tasks.length
      || proposal.tasks.some(task => !byLocal.has(task.localId))) throw new WebAccessError("invalid_request");
    for (const edge of proposal.edges) if (byLocal.get(edge.toLocalId)?.decision === "approve"
      && byLocal.get(edge.fromLocalId)?.decision !== "approve") throw new WebAccessError("conflict");
    const approved = new Set(decisions.filter(item => item.decision === "approve").map(item => item.localId));
    const remaining = new Set(approved), ordered: typeof proposal.tasks = [];
    while (remaining.size) {
      const ready = proposal.tasks.filter(task => remaining.has(task.localId) && proposal.edges
        .filter(edge => edge.toLocalId === task.localId).every(edge => !remaining.has(edge.fromLocalId)));
      if (!ready.length) throw new WebAccessError("conflict");
      for (const task of ready) { ordered.push(task); remaining.delete(task.localId); }
    }
    const resolvedTasks = new Map<string, NonNullable<ReturnType<typeof resolveWorkBatchQueueWorkerV1>>>();
    for (const task of ordered) {
      let resolved: ReturnType<typeof resolveWorkBatchQueueWorkerV1>;
      try { resolved = resolveWorkBatchQueueWorkerV1(this.#queueCatalog, task); }
      catch { throw new WebAccessError("conflict"); }
      if (resolved) {
        if (!this.#queueAdmissionAuthority) throw new WebAccessError("conflict");
        const current = { workerId: resolved.worker.workerId, workerKind: resolved.worker.workerKind,
          nodeId: resolved.worker.nodeId, selectionKey: resolved.model.selectionKey, model: resolved.model.model,
          effort: resolved.model.effort, provider: resolved.model.provider ?? null, profile: resolved.model.profile ?? null };
        try { if (await this.#queueAdmissionAuthority.assertCurrent(Object.freeze(current)) !== true)
          throw new Error("not_current"); }
        catch { throw new WebAccessError("conflict"); }
        resolvedTasks.set(task.localId, resolved);
      }
    }
    const jobs = new Map<string, string>();
    for (const task of ordered) {
      const dependsOnJobIds = proposal.edges.filter(edge => edge.toLocalId === task.localId)
        .map(edge => jobs.get(edge.fromLocalId)).filter((value): value is string => !!value);
      const key = `batch-item:${sha256Digest({ batchId: batch.id, revision: Number(batch.version), localId: task.localId }).slice(7)}`;
      const command = await this.tasks.proposeWithDependenciesInSession(tx, actor, batch.project_id,
        { title: task.title, instructions: task.instructions, ...(task.requestedModelKey ? { model: task.requestedModelKey } : {}) },
        key, dependsOnJobIds);
      if (command.receipt.startsWork !== false) throw new Error("work_batch_task_authority_invalid");
      jobs.set(task.localId, command.receipt.jobId);
    }
    const queue = new Map<string, { workerId: string; workerKind: "codex" | "claude-code" | "hermes";
      nodeId: string; position: number; selectionKey: string; model: string; effort: string;
      provider: string | null; profile: string | null }>();
    const byWorker = new Map<string, { task: typeof proposal.tasks[number]; jobId: string;
      resolved: NonNullable<ReturnType<typeof resolveWorkBatchQueueWorkerV1>> }[]>();
    for (const task of ordered) {
      if (!approved.has(task.localId)) continue;
      const resolved = resolvedTasks.get(task.localId);
      if (!resolved) continue;
      const list = byWorker.get(resolved.worker.workerId) ?? [];
      list.push({ task, jobId: jobs.get(task.localId)!, resolved });
      byWorker.set(resolved.worker.workerId, list);
    }
    for (const workerId of [...byWorker.keys()].sort()) {
      const incoming = byWorker.get(workerId)!;
      await tx.query(`INSERT INTO work_batch_agent_queue_heads(tenant_id,worker_id,next_position,updated_at)
        VALUES($1,$2,1,$3) ON CONFLICT(tenant_id,worker_id) DO NOTHING`,
      [this.scope.tenantId, workerId, actor.now]);
      const head = (await tx.query<{ next_position: string | number }>(`SELECT next_position
        FROM work_batch_agent_queue_heads WHERE tenant_id=$1 AND worker_id=$2 FOR UPDATE`,
      [this.scope.tenantId, workerId])).rows[0];
      const next = Number(head?.next_position);
      const existing = (await tx.query<{ job_id: string; worker_id: string; node_id: string }>(`SELECT job_id,worker_id,node_id
        FROM work_batch_effective_queue_admissions
        WHERE tenant_id=$1 AND worker_id=$2 ORDER BY queue_position`, [this.scope.tenantId, workerId])).rows;
      let depth = 0;
      for (const admitted of existing) if (!await this.#acceptedResult(tx, { sourceJobId: admitted.job_id,
        workerId: admitted.worker_id, nodeId: admitted.node_id })) depth += 1;
      if (!Number.isSafeInteger(next) || next < 1 || !Number.isSafeInteger(depth) || depth < 0
        || depth + incoming.length > Number(batch.queue_depth_limit)) throw new WebAccessError("queue_depth_exceeded");
      const advanced = await tx.query<{ next_position: string | number }>(`UPDATE work_batch_agent_queue_heads
        SET next_position=next_position+$1,updated_at=$2 WHERE tenant_id=$3 AND worker_id=$4 AND next_position=$5
        RETURNING next_position`, [incoming.length, actor.now, this.scope.tenantId, workerId, next]);
      if (Number(advanced.rows[0]?.next_position) !== next + incoming.length) throw new WebAccessError("conflict");
      incoming.forEach(({ task, resolved }, index) => queue.set(task.localId, {
        workerId, workerKind: resolved.worker.workerKind, nodeId: resolved.worker.nodeId,
        position: next + index, selectionKey: resolved.model.selectionKey, model: resolved.model.model,
        effort: resolved.model.effort, provider: resolved.model.provider ?? null, profile: resolved.model.profile ?? null,
      }));
    }
    const itemDigests: string[] = [];
    for (const [ordinal, task] of proposal.tasks.entries()) {
      const decision = byLocal.get(task.localId)!;
      const item = { id: `${batch.id}:item:${task.localId}`, tenantId: this.scope.tenantId, batchId: batch.id,
        batchRevision: Number(batch.version), projectId: batch.project_id, localId: task.localId, ordinal,
        role: task.role, requiredCapability: task.requiredCapability,
        dependsOnLocalIds: proposal.edges.filter(edge => edge.toLocalId === task.localId).map(edge => edge.fromLocalId).sort(),
        ...(task.requestedWorkerId ? { requestedWorkerId: task.requestedWorkerId } : {}),
        requestedWorkerKind: task.requestedWorkerKind ?? null, requestedModelKey: task.requestedModelKey ?? null,
        acceptanceCriteria: task.acceptanceCriteria, acceptanceTests: task.acceptanceTests,
        decisionState: decision.decision === "approve" ? "approved" as const : "rejected" as const,
        decisionReasonCode: decision.reasonCode ?? null, jobId: jobs.get(task.localId) ?? null,
        jobAttemptCount: 0, createdAt: actor.now };
      const digest = sha256Digest(item), tag = hmacSha256Tag(this.#key, { purpose: "work-batch-item/v1", record: item });
      itemDigests.push(digest);
      await tx.query(`INSERT INTO work_batch_items(id,tenant_id,batch_id,batch_revision,project_id,local_id,ordinal,role,
        required_capability,depends_on_local_ids,requested_worker_id,requested_worker_kind,requested_model_key,
        acceptance_criteria,acceptance_tests,decision_state,decision_reason_code,job_id,job_attempt_count,item_digest,auth_tag,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,$19,$20,$21)`,
      [item.id, item.tenantId, item.batchId, item.batchRevision, item.projectId, item.localId, item.ordinal, item.role,
        item.requiredCapability, item.dependsOnLocalIds, item.requestedWorkerId ?? null, item.requestedWorkerKind, item.requestedModelKey,
        item.acceptanceCriteria, item.acceptanceTests, item.decisionState, item.decisionReasonCode, item.jobId,
        digest, tag, item.createdAt]);
      const admitted = queue.get(task.localId);
      if (admitted && item.jobId) {
        const material = { itemId: item.id, batchId: batch.id, projectId: batch.project_id, jobId: item.jobId,
          workerId: admitted.workerId, workerKind: admitted.workerKind, nodeId: admitted.nodeId,
          position: admitted.position, queueDepthLimit: Number(batch.queue_depth_limit),
          selectionKey: admitted.selectionKey, model: admitted.model, effort: admitted.effort,
          provider: admitted.provider, profile: admitted.profile, assignmentRevision: 1,
          supersedesAdmissionId: null, changeReasonCode: "initial_owner_approval",
          authorizedByIdentityId: actor.id, admittedAt: actor.now };
        const admissionDigest = sha256Digest(material);
        const admissionId = `admission:${admissionDigest.slice(7)}`;
        const admissionTag = hmacSha256Tag(this.#key, { purpose: "work-batch-queue-admission/v1", record: material });
        await tx.query(`INSERT INTO work_batch_queue_admissions(tenant_id,admission_id,item_id,batch_id,project_id,job_id,
          worker_id,worker_kind,node_id,queue_position,queue_depth_limit,selection_key,model,effort,provider,profile,
          assignment_revision,supersedes_admission_id,change_reason_code,authorized_by_identity_id,
          admission_digest,auth_tag,admitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
            $17,$18,$19,$20,$21,$22,$23)`,
        [this.scope.tenantId, admissionId, item.id, batch.id, batch.project_id, item.jobId, admitted.workerId,
          admitted.workerKind, admitted.nodeId, admitted.position, Number(batch.queue_depth_limit),
          admitted.selectionKey, admitted.model, admitted.effort, admitted.provider, admitted.profile,
          1, null, "initial_owner_approval", actor.id, admissionDigest, admissionTag, actor.now]);
      }
    }
    const state = approved.size === proposal.tasks.length ? "approved" : approved.size === 0 ? "rejected" : "partially_approved";
    const reasonCode = state === "rejected" ? "all_items_rejected" : null;
    const decisionMaterial = { id: `${batch.id}:decision`, tenantId: this.scope.tenantId, batchId: batch.id,
      projectId: batch.project_id, batchRevision: Number(batch.version), state, approvalIdentityId: actor.id,
      approvedAt: actor.now, decisionReasonCode: reasonCode, itemDigests };
    const decisionDigest = sha256Digest(decisionMaterial);
    const decisionTag = hmacSha256Tag(this.#key, { purpose: "work-batch-decision/v1", record: decisionMaterial });
    const updated = await tx.query<{ id: string }>(`UPDATE work_batches SET state=$1,approval_identity_id=$2,approved_at=$3,decision_reason_code=$4,
      decision_digest=$5,decision_auth_tag=$6,updated_at=$3
      WHERE tenant_id=$7 AND id=$8 AND state='proposed' AND version=$9 RETURNING id`,
    [state, actor.id, actor.now, reasonCode, decisionDigest, decisionTag,
      this.scope.tenantId, batch.id, Number(batch.version)]);
    if (updated.rows.length !== 1 || updated.rows[0]?.id !== batch.id) throw new WebAccessError("conflict");
    const resolved = await tx.query<{ id: string }>(`UPDATE control_action_inbox
      SET state='resolved',payload=jsonb_set(payload,'{state}','"resolved"'::jsonb)
      WHERE tenant_id=$1 AND id=$2 AND project_id=$3 AND work_item_id=$4 AND state='open' RETURNING id`,
    [this.scope.tenantId, `attention:work-batch:${batch.id}`, batch.project_id, batch.id]);
    if (resolved.rows.length !== 1 || resolved.rows[0]?.id !== `attention:work-batch:${batch.id}`)
      throw new Error("work_batch_integrity_failed");
    const jobIds = [...jobs.values()];
    await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, projectId: batch.project_id,
      actorId: actor.id, actorType: "human", action: `work_batches.${state}`, targetType: "work_batch", targetId: batch.id,
      safeMetadata: { revision: Number(batch.version), approvedCount: approved.size,
        rejectedCount: proposal.tasks.length - approved.size, admittedCount: queue.size }, occurredAt: actor.now });
    return workBatchOwnerReceiptSchemaV1.parse({ schema: "control-room.work-batch-owner-receipt/v1", batchId: batch.id,
      projectId: batch.project_id, state, revision: Number(batch.version), jobIds, replayed: false,
      startsWork: false, grantsExecutionAuthority: false });
  }

  async view(identity: VerifiedWebIdentity, projectId: string, batchId: string) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const batch = await this.#batch(tx, projectId, batchId, false), original = this.#verifyBatch(batch);
      const revisions = (await tx.query<RevisionRow>(`SELECT revision,edited_by_identity_id,edited_at,reason_code,proposal,
        revision_digest,auth_tag FROM work_batch_revisions WHERE tenant_id=$1 AND batch_id=$2 ORDER BY revision`,
      [this.scope.tenantId, batchId])).rows.map(row => ({ revision: Number(row.revision), editedByIdentityId: row.edited_by_identity_id,
        editedAt: iso(row.edited_at), reasonCode: row.reason_code, proposal: this.#verifyRevision(row, batchId) }));
      const items = (await tx.query<ItemRow>(`SELECT id,tenant_id,batch_id,batch_revision,project_id,local_id,ordinal,
        role,required_capability,depends_on_local_ids,
        requested_worker_id,requested_worker_kind,requested_model_key,acceptance_criteria,acceptance_tests,decision_state,
        decision_reason_code,job_id,job_attempt_count,item_digest,auth_tag,created_at
        FROM work_batch_items WHERE tenant_id=$1 AND batch_id=$2 ORDER BY ordinal`,
      [this.scope.tenantId, batchId])).rows;
      this.#verifyDecision(batch, items);
      const admissionColumns = `admission_id,item_id,batch_id,project_id,job_id,worker_id,worker_kind,
        node_id,queue_position,queue_depth_limit,selection_key,model,effort,provider,profile,assignment_revision,
        supersedes_admission_id,change_reason_code,authorized_by_identity_id,admission_digest,auth_tag,admitted_at`;
      const admissionHistory = (await tx.query<AdmissionRow>(`SELECT ${admissionColumns}
        FROM work_batch_queue_admissions WHERE tenant_id=$1 AND batch_id=$2 ORDER BY item_id,assignment_revision`,
      [this.scope.tenantId, batchId])).rows;
      for (const row of admissionHistory) this.#verifyAdmission(row);
      const admissions = (await tx.query<AdmissionRow>(`SELECT admission_id,item_id,batch_id,project_id,job_id,worker_id,worker_kind,
        node_id,queue_position,queue_depth_limit,selection_key,model,effort,provider,profile,assignment_revision,
        supersedes_admission_id,change_reason_code,authorized_by_identity_id,admission_digest,auth_tag,admitted_at
        FROM work_batch_effective_queue_admissions WHERE tenant_id=$1 AND batch_id=$2 ORDER BY worker_id,queue_position`,
      [this.scope.tenantId, batchId])).rows;
      const localByItem = new Map(items.map(item => [item.id, item.local_id]));
      const queue = [];
      for (const row of admissions) {
        const material = this.#verifyAdmission(row), localId = localByItem.get(row.item_id);
        if (!localId) throw new Error("work_batch_integrity_failed");
        queue.push({ localId, jobId: row.job_id, workerId: material.workerId, workerKind: material.workerKind,
          nodeId: material.nodeId, position: material.position, queueDepthLimit: material.queueDepthLimit,
          selectionKey: material.selectionKey, model: material.model, effort: material.effort,
          provider: material.provider, profile: material.profile, state: await this.#queueState(tx, row) });
      }
      const publicItems = items.map(row => ({ localId: row.local_id, ordinal: Number(row.ordinal), role: row.role,
        requiredCapability: row.required_capability, dependsOnLocalIds: row.depends_on_local_ids,
        requestedWorkerId: row.requested_worker_id, requestedWorkerKind: row.requested_worker_kind,
        requestedModelKey: row.requested_model_key,
        acceptanceCriteria: row.acceptance_criteria, acceptanceTests: row.acceptance_tests,
        decisionState: row.decision_state, decisionReasonCode: row.decision_reason_code, jobId: row.job_id }));
      return workBatchOwnerViewSchemaV1.parse({ batchId: batch.id, projectId, state: batch.state,
        revision: Number(batch.version), proposedByIdentityId: batch.proposed_by_identity_id, proposedAt: iso(batch.proposed_at),
        approvalIdentityId: batch.approval_identity_id, decidedAt: batch.approved_at ? iso(batch.approved_at) : null,
        proposal: revisions.at(-1)?.proposal ?? original, revisions, items: publicItems, queue,
        queueDepthLimit: Number(batch.queue_depth_limit),
        startsWork: false, grantsExecutionAuthority: false });
    });
  }

  async list(identity: VerifiedWebIdentity, projectId: string) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const rows = (await tx.query<BatchRow>(`SELECT id,tenant_id,project_id,proposed_by_identity_id,proposed_at,state,
        approval_identity_id,approved_at,decision_reason_code,proposal,queue_depth_limit,batch_digest,auth_tag,auth_material_version,
        decision_digest,decision_auth_tag,version,
        created_at,updated_at FROM work_batches WHERE tenant_id=$1 AND project_id=$2 ORDER BY proposed_at DESC,id LIMIT 100`,
      [this.scope.tenantId, projectId])).rows;
      const proposals = await this.#currentProposals(tx, rows);
      const itemsByBatch = await this.#itemsByBatch(tx, rows);
      const summaries = [];
      for (const row of rows) {
        const items = itemsByBatch.get(row.id) ?? [];
        this.#verifyDecision(row, items);
        const proposal = proposals.get(row.id)!;
        summaries.push({ batchId: row.id, projectId,
        state: row.state, revision: Number(row.version), proposedByIdentityId: row.proposed_by_identity_id,
        proposedAt: iso(row.proposed_at), taskCount: proposal.tasks.length,
        approvalIdentityId: row.approval_identity_id, decidedAt: row.approved_at ? iso(row.approved_at) : null });
      }
      return workBatchOwnerPageSchemaV1.parse({ batches: summaries,
      startsWork: false, grantsExecutionAuthority: false });
    });
  }

  async attention(identity: VerifiedWebIdentity) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      const rows = (await tx.query<BatchRow>(`SELECT b.id,b.tenant_id,b.project_id,b.proposed_by_identity_id,
        b.proposed_at,b.state,b.approval_identity_id,b.approved_at,b.decision_reason_code,b.proposal,
        b.queue_depth_limit,b.batch_digest,b.auth_tag,b.auth_material_version,b.decision_digest,b.decision_auth_tag,b.version,
        b.created_at,b.updated_at FROM work_batches b JOIN control_action_inbox a
          ON a.tenant_id=b.tenant_id AND a.work_item_id=b.id AND a.project_id=b.project_id
        WHERE b.tenant_id=$1 AND b.state='proposed' AND a.id='attention:work-batch:' || b.id
          AND a.state='open'
          AND EXISTS (SELECT 1 FROM control_role_grants readable WHERE readable.tenant_id=b.tenant_id
            AND readable.identity_id=$2 AND readable.role_key IN ('owner','operator')
            AND (readable.project_ids @> pg_catalog.to_jsonb(ARRAY[b.project_id]::text[])
              OR readable.project_ids @> '["*"]'::jsonb)
            AND (readable.allowed_actions @> '["tasks.read"]'::jsonb
              OR readable.allowed_actions @> '["*"]'::jsonb)
            AND readable.require_strong_factor=false
            AND (readable.revoked_at IS NULL OR readable.revoked_at>$3::timestamptz)
            AND (readable.expires_at IS NULL OR readable.expires_at>$3::timestamptz))
          AND EXISTS (SELECT 1 FROM control_role_grants deciding WHERE deciding.tenant_id=b.tenant_id
            AND deciding.identity_id=$2 AND deciding.role_key='owner'
            AND (deciding.project_ids @> pg_catalog.to_jsonb(ARRAY[b.project_id]::text[])
              OR deciding.project_ids @> '["*"]'::jsonb)
            AND (deciding.allowed_actions @> '["work_batches.decide"]'::jsonb
              OR deciding.allowed_actions @> '["*"]'::jsonb)
            AND deciding.require_strong_factor=false
            AND (deciding.revoked_at IS NULL OR deciding.revoked_at>$3::timestamptz)
            AND (deciding.expires_at IS NULL OR deciding.expires_at>$3::timestamptz))
          ORDER BY b.proposed_at,b.id LIMIT 100`, [this.scope.tenantId, actor.id, actor.now])).rows
        .filter(row => actor.can("tasks.read", row.project_id) && actor.can("work_batches.decide", row.project_id, true));
      const proposals = await this.#currentProposals(tx, rows);
      const batches = [];
      for (const row of rows) {
        this.#verifyDecision(row, []);
        const proposal = proposals.get(row.id)!;
        batches.push({ batchId: row.id, projectId: row.project_id, state: row.state, revision: Number(row.version),
          proposedByIdentityId: row.proposed_by_identity_id, proposedAt: iso(row.proposed_at),
          taskCount: proposal.tasks.length, approvalIdentityId: null, decidedAt: null });
      }
      return workBatchOwnerPageSchemaV1.parse({ batches, startsWork: false, grantsExecutionAuthority: false });
    });
  }
}
