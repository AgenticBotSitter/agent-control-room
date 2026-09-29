import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import type { LinearPipelineServiceV1 } from "../../pipelines/v1";
import { legacyLinearPipelineTemplateInputSchemaV1, linearPipelineTemplateInputSchemaV1 } from "../../pipelines/v1/schemas";
import { CONTROL_ROOM_SELF_PROJECT_TEMPLATE_V1 } from "../../config/v1/product-configuration";
import { improvementDeskViewSchemaV1, improvementRequestDraftSchemaV1, improvementRequestViewSchemaV1,
  recordUpdateCandidateSchemaV1, updateCandidateDecisionDraftSchemaV1, updateCandidateDecisionReceiptSchemaV1,
  updateCandidatePageSchemaV1, updateCandidateViewSchemaV1, type RecordUpdateCandidateV1 } from "./schemas";

type TemplateRow = { id: string; project_id: string; name: string; description: string; stages: unknown;
  max_stages: number | string; max_total_loops: number | string; may_advance_unattended: boolean;
  max_duration_seconds: number | string; record_digest: string; auth_tag: string; version: number | string;
  created_at: string | Date; updated_at: string | Date };
type RequestRow = { id: string; project_id: string; description: string; pipeline_template_id: string;
  pipeline_template_version: number | string; pipeline_template_digest: string; selected_worker_ids: unknown;
  lead_worker_id: string; pipeline_run_id: string; owner_identity_id: string; idempotency_key: string;
  request_digest: string; record_digest: string; auth_tag: string; created_at: string | Date };
type CandidateRow = { id: string; project_id: string; improvement_request_id: string; pipeline_run_id: string;
  base_revision: string; candidate_revision: string; summary: string; changed_areas: unknown; test_results: unknown;
  database_changes: unknown; lead_worker_id: string; state: "ready" | "accepted" | "declined";
  version: number | string; record_digest: string; auth_tag: string; created_at: string | Date; decided_at: string | Date | null };

const iso = (value: string | Date) => new Date(value).toISOString();
const same = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b); };

export class ImproveControlRoomDeskServiceV1 {
  readonly #key: Uint8Array;
  readonly #authority: WebSessionAuthority;

  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    integrityKey: Uint8Array, private readonly pipelines: Pick<LinearPipelineServiceV1, "instantiate">,
    private readonly clock: () => number = Date.now) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("improvement_desk_configuration_invalid");
    this.#key = Uint8Array.from(integrityKey);
    this.#authority = new WebSessionAuthority(db, scope, clock, "improvement_desk");
  }

  #templateMaterial(row: TemplateRow) {
    const raw = { name: row.name, description: row.description, stages: row.stages,
      maxTotalLoops: Number(row.max_total_loops), maxDurationSeconds: Number(row.max_duration_seconds) };
    const current = linearPipelineTemplateInputSchemaV1.safeParse(raw);
    const parsed = current.success ? current.data : legacyLinearPipelineTemplateInputSchemaV1.parse(raw);
    return { material: { id: row.id, tenantId: this.scope.tenantId, projectId: row.project_id, name: row.name,
      description: row.description, stages: parsed.stages, maxStages: Number(row.max_stages),
      maxTotalLoops: Number(row.max_total_loops), mayAdvanceUnattended: row.may_advance_unattended,
      maxDurationSeconds: Number(row.max_duration_seconds), version: Number(row.version),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }, definition: parsed };
  }

  #verifyTemplate(row: TemplateRow) {
    const value = this.#templateMaterial(row);
    if (sha256Digest(value.material) !== row.record_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "pipeline-template/v1", record: value.material }), row.auth_tag))
      throw new Error("improvement_desk_integrity_failed");
    return value.definition;
  }

  async #requireSelfProject(tx: DatabaseSession, projectId: string) {
    const row = (await tx.query<{ lifecycle: string; template_id: string | null }>(`SELECT h.lifecycle,
      p.payload->'presentation'->>'templateId' AS template_id FROM projects p JOIN control_manual_project_heads h
      ON h.tenant_id=p.tenant_id AND h.project_id=p.id
      WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 FOR SHARE OF p,h`,
    [this.scope.tenantId, this.scope.workspaceId, projectId])).rows[0];
    if (!row || row.template_id !== CONTROL_ROOM_SELF_PROJECT_TEMPLATE_V1.id) throw new WebAccessError("not_found");
    if (row.lifecycle !== "active") throw new WebAccessError("conflict");
  }

  async #templates(tx: DatabaseSession, projectId: string) {
    const rows = (await tx.query<TemplateRow>(`SELECT id,project_id,name,description,stages,max_stages,max_total_loops,
      may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at
      FROM pipeline_templates WHERE tenant_id=$1 AND project_id=$2 ORDER BY name,id LIMIT 100`,
    [this.scope.tenantId, projectId])).rows;
    return rows.map(row => { const value = this.#verifyTemplate(row); return { row, value, choice: {
      templateId: row.id, name: row.name, version: Number(row.version), templateDigest: row.record_digest,
      workers: value.stages.map(stage => ({ ordinal: stage.ordinal, stage: stage.stageKind,
        workerId: stage.workerId, model: stage.model, effort: stage.effort })),
    } }; });
  }

  #requestMaterial(row: RequestRow) {
    return { id: row.id, tenantId: this.scope.tenantId, projectId: row.project_id, description: row.description,
      pipelineTemplateId: row.pipeline_template_id, pipelineTemplateVersion: Number(row.pipeline_template_version),
      pipelineTemplateDigest: row.pipeline_template_digest, selectedWorkerIds: row.selected_worker_ids,
      leadWorkerId: row.lead_worker_id, pipelineRunId: row.pipeline_run_id, ownerIdentityId: row.owner_identity_id,
      idempotencyKey: row.idempotency_key, requestDigest: row.request_digest, createdAt: iso(row.created_at) };
  }

  #requestView(row: RequestRow) {
    const material = this.#requestMaterial(row);
    if (sha256Digest(material) !== row.record_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "improvement-request/v1", record: material }), row.auth_tag))
      throw new Error("improvement_desk_integrity_failed");
    return improvementRequestViewSchemaV1.parse({ requestId: row.id, projectId: row.project_id,
      description: row.description, pipelineTemplateId: row.pipeline_template_id,
      pipelineTemplateVersion: Number(row.pipeline_template_version), pipelineTemplateDigest: row.pipeline_template_digest,
      selectedWorkerIds: row.selected_worker_ids, leadWorkerId: row.lead_worker_id, pipelineRunId: row.pipeline_run_id,
      createdAt: iso(row.created_at), startsWork: false, grantsDeployAuthority: false });
  }

  async view(identity: VerifiedWebIdentity, projectId: string) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", projectId, true); await this.#requireSelfProject(tx, projectId);
      const templates = await this.#templates(tx, projectId);
      const requests = (await tx.query<RequestRow>(`SELECT id,project_id,description,pipeline_template_id,
        pipeline_template_version,pipeline_template_digest,selected_worker_ids,lead_worker_id,pipeline_run_id,
        owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,created_at
        FROM control_improvement_requests WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,
      [this.scope.tenantId, projectId])).rows.map(row => this.#requestView(row));
      return improvementDeskViewSchemaV1.parse({ projectId, templates: templates.map(value => value.choice), requests,
        startsWork: false, grantsDeployAuthority: false });
    }, { readOnly: true });
  }

  async create(identity: VerifiedWebIdentity, projectId: string, draft: unknown, idempotencyKey: string) {
    const parsed = improvementRequestDraftSchemaV1.safeParse(draft);
    if (!parsed.success || !/^[A-Za-z0-9:_-]{16,100}$/.test(idempotencyKey)) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data); } catch { throw new WebAccessError("invalid_request"); }
    const requestDigest = sha256Digest({ schema: "control-room.improvement-request/v1", ...this.scope, projectId,
      ...parsed.data });
    const prepared = await this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.propose", projectId, true); await this.#requireSelfProject(tx, projectId);
      const existing = (await tx.query<RequestRow>(`SELECT id,project_id,description,pipeline_template_id,
        pipeline_template_version,pipeline_template_digest,selected_worker_ids,lead_worker_id,pipeline_run_id,
        owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,created_at
        FROM control_improvement_requests WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3`,
      [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_digest !== requestDigest) throw new WebAccessError("conflict");
        return { actorId: actor.id, template: undefined, existing: this.#requestView(existing) };
      }
      const template = (await this.#templates(tx, projectId)).find(value => value.row.id === parsed.data.pipelineTemplateId);
      if (!template) throw new WebAccessError("not_found");
      const selected = [...new Set(template.value.stages.filter(stage => stage.stageKind !== "signoff").map(stage => stage.workerId))].sort();
      if (JSON.stringify(selected) !== JSON.stringify([...parsed.data.selectedWorkerIds].sort())
        || template.value.stages[2]?.workerId !== parsed.data.leadWorkerId) throw new WebAccessError("conflict");
      return { actorId: actor.id, template, existing: undefined };
    });
    if (prepared.existing) return { request: prepared.existing, replayed: true };
    const title = parsed.data.description.replace(/\s+/gu, " ").slice(0, 180);
    const run = await this.pipelines.instantiate(identity, projectId,
      { templateId: parsed.data.pipelineTemplateId, title }, `improve:${idempotencyKey}`);
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.propose", projectId, true); await this.#requireSelfProject(tx, projectId);
      const existing = (await tx.query<RequestRow>(`SELECT id,project_id,description,pipeline_template_id,
        pipeline_template_version,pipeline_template_digest,selected_worker_ids,lead_worker_id,pipeline_run_id,
        owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,created_at
        FROM control_improvement_requests WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3 FOR UPDATE`,
      [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_digest !== requestDigest || existing.pipeline_run_id !== run.runId) throw new WebAccessError("conflict");
        return { request: this.#requestView(existing), replayed: true };
      }
      const now = actor.now, id = `improvement:${randomUUID()}`, template = prepared.template!;
      const partial: RequestRow = { id, project_id: projectId, description: parsed.data.description,
        pipeline_template_id: template.row.id, pipeline_template_version: Number(template.row.version),
        pipeline_template_digest: template.row.record_digest, selected_worker_ids: parsed.data.selectedWorkerIds,
        lead_worker_id: parsed.data.leadWorkerId, pipeline_run_id: run.runId, owner_identity_id: actor.id,
        idempotency_key: idempotencyKey, request_digest: requestDigest, record_digest: "", auth_tag: "", created_at: now };
      const material = this.#requestMaterial(partial), recordDigest = sha256Digest(material);
      const authTag = hmacSha256Tag(this.#key, { purpose: "improvement-request/v1", record: material });
      await tx.query(`INSERT INTO control_improvement_requests(tenant_id,id,project_id,description,pipeline_template_id,
        pipeline_template_version,pipeline_template_digest,selected_worker_ids,lead_worker_id,pipeline_run_id,
        owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [this.scope.tenantId, id, projectId, partial.description, partial.pipeline_template_id,
        partial.pipeline_template_version, partial.pipeline_template_digest, JSON.stringify(partial.selected_worker_ids),
        partial.lead_worker_id, partial.pipeline_run_id, actor.id, idempotencyKey, requestDigest, recordDigest, authTag, now]);
      return { request: this.#requestView({ ...partial, record_digest: recordDigest, auth_tag: authTag }), replayed: false };
    });
  }

  #candidateMaterial(row: CandidateRow) {
    return { id: row.id, tenantId: this.scope.tenantId, projectId: row.project_id,
      improvementRequestId: row.improvement_request_id, pipelineRunId: row.pipeline_run_id,
      baseRevision: row.base_revision, candidateRevision: row.candidate_revision, summary: row.summary,
      changedAreas: row.changed_areas, testResults: row.test_results, databaseChanges: row.database_changes,
      leadWorkerId: row.lead_worker_id, createdAt: iso(row.created_at) };
  }

  #candidateView(row: CandidateRow) {
    const material = this.#candidateMaterial(row);
    if (sha256Digest(material) !== row.record_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "update-candidate/v1", record: material }), row.auth_tag))
      throw new Error("improvement_desk_integrity_failed");
    return updateCandidateViewSchemaV1.parse({ candidateId: row.id, projectId: row.project_id,
      improvementRequestId: row.improvement_request_id, pipelineRunId: row.pipeline_run_id,
      baseRevision: row.base_revision, candidateRevision: row.candidate_revision, summary: row.summary,
      changedAreas: row.changed_areas, testResults: row.test_results, databaseChanges: row.database_changes,
      leadWorkerId: row.lead_worker_id, state: row.state, version: Number(row.version), recordDigest: row.record_digest,
      createdAt: iso(row.created_at), decidedAt: row.decided_at ? iso(row.decided_at) : null,
      startsDeploy: false, signedDeployApprovalCreated: false });
  }

  /** Trusted coordinator seam for the later branch/test publisher. No browser or worker obtains this operation. */
  async recordCandidate(input: RecordUpdateCandidateV1) {
    const parsed = recordUpdateCandidateSchemaV1.parse(input);
    try { assertNoSecretMaterial(parsed); } catch { throw new Error("update_candidate_invalid"); }
    return this.db.transaction(async tx => {
      const binding = (await tx.query<{ request_id: string; run_state: string; signoff_worker: string; signoff_state: string }>(`
        SELECT request.id AS request_id,run.state AS run_state,stage.worker_id AS signoff_worker,stage.state AS signoff_state
        FROM control_improvement_requests request JOIN pipeline_runs run
          ON run.tenant_id=request.tenant_id AND run.id=request.pipeline_run_id AND run.project_id=request.project_id
        JOIN pipeline_stage_runs stage ON stage.tenant_id=run.tenant_id AND stage.pipeline_run_id=run.id
          AND stage.project_id=run.project_id AND stage.stage_kind='signoff'
        WHERE request.tenant_id=$1 AND request.id=$2 AND request.project_id=$3 AND request.pipeline_run_id=$4`,
      [this.scope.tenantId, parsed.improvementRequestId, parsed.projectId, parsed.pipelineRunId])).rows[0];
      if (!binding || binding.run_state !== "succeeded" || binding.signoff_state !== "succeeded"
        || binding.signoff_worker !== parsed.leadWorkerId) throw new Error("update_candidate_not_ready");
      const existing = (await tx.query<CandidateRow>(`SELECT id,project_id,improvement_request_id,pipeline_run_id,
        base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,lead_worker_id,state,version,
        record_digest,auth_tag,created_at,decided_at FROM control_update_candidates
        WHERE tenant_id=$1 AND pipeline_run_id=$2`, [this.scope.tenantId, parsed.pipelineRunId])).rows[0];
      if (existing) {
        const view = this.#candidateView(existing);
        if (view.candidateRevision !== parsed.candidateRevision) throw new Error("update_candidate_conflict");
        return { candidate: view, replayed: true };
      }
      const now = new Date(this.clock()).toISOString(), id = `update-candidate:${randomUUID()}`;
      const partial: CandidateRow = { id, project_id: parsed.projectId, improvement_request_id: parsed.improvementRequestId,
        pipeline_run_id: parsed.pipelineRunId, base_revision: parsed.baseRevision, candidate_revision: parsed.candidateRevision,
        summary: parsed.summary, changed_areas: parsed.changedAreas, test_results: parsed.testResults,
        database_changes: parsed.databaseChanges, lead_worker_id: parsed.leadWorkerId, state: "ready", version: 1,
        record_digest: "", auth_tag: "", created_at: now, decided_at: null };
      const material = this.#candidateMaterial(partial), recordDigest = sha256Digest(material);
      const authTag = hmacSha256Tag(this.#key, { purpose: "update-candidate/v1", record: material });
      await tx.query(`INSERT INTO control_update_candidates(tenant_id,id,project_id,improvement_request_id,pipeline_run_id,
        base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,lead_worker_id,state,version,
        record_digest,auth_tag,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,'ready',1,$13,$14,$15)`,
      [this.scope.tenantId, id, parsed.projectId, parsed.improvementRequestId, parsed.pipelineRunId,
        parsed.baseRevision, parsed.candidateRevision, parsed.summary, JSON.stringify(parsed.changedAreas),
        JSON.stringify(parsed.testResults), JSON.stringify(parsed.databaseChanges), parsed.leadWorkerId, recordDigest, authTag, now]);
      return { candidate: this.#candidateView({ ...partial, record_digest: recordDigest, auth_tag: authTag }), replayed: false };
    });
  }

  async ready(identity: VerifiedWebIdentity) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", undefined, true);
      const rows = (await tx.query<CandidateRow>(`SELECT id,project_id,improvement_request_id,pipeline_run_id,
        base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,lead_worker_id,state,version,
        record_digest,auth_tag,created_at,decided_at FROM control_update_candidates
        WHERE tenant_id=$1 AND state='ready' ORDER BY created_at DESC,id DESC LIMIT 100`, [this.scope.tenantId])).rows;
      return updateCandidatePageSchemaV1.parse({ candidates: rows.map(row => this.#candidateView(row)),
        startsDeploy: false, signedDeployApprovalCreated: false });
    }, { readOnly: true });
  }

  async decide(identity: VerifiedWebIdentity, value: unknown, idempotencyKey: string) {
    const parsed = updateCandidateDecisionDraftSchemaV1.safeParse(value);
    if (!parsed.success || !/^[A-Za-z0-9:_-]{16,100}$/.test(idempotencyKey)) throw new WebAccessError("invalid_request");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("updates.decide", undefined, true, "high");
      const prior = (await tx.query<{ id: string; candidate_id: string; project_id: string; candidate_version: number | string;
        candidate_record_digest: string; decision: "accept" | "decline"; decision_digest: string; auth_tag: string;
        decided_at: string | Date }>(`SELECT id,candidate_id,project_id,candidate_version,candidate_record_digest,decision,
        decision_digest,auth_tag,decided_at FROM control_update_candidate_decisions
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3`,
      [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
      const requestedDigest = sha256Digest({ schema: "control-room.update-candidate-decision/v1", ...this.scope,
        ...parsed.data, ownerIdentityId: actor.id, idempotencyKey });
      if (prior) {
        if (prior.decision_digest !== requestedDigest) throw new WebAccessError("conflict");
        return updateCandidateDecisionReceiptSchemaV1.parse({ decisionId: prior.id, candidateId: prior.candidate_id,
          projectId: prior.project_id, decision: prior.decision, candidateVersion: Number(prior.candidate_version),
          decidedAt: iso(prior.decided_at), replayed: true, startsDeploy: false, signedDeployApprovalCreated: false,
          grantsDeployAuthority: false });
      }
      const row = (await tx.query<CandidateRow>(`SELECT id,project_id,improvement_request_id,pipeline_run_id,
        base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,lead_worker_id,state,version,
        record_digest,auth_tag,created_at,decided_at FROM control_update_candidates
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [this.scope.tenantId, parsed.data.candidateId])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      this.#candidateView(row);
      if (row.state !== "ready" || Number(row.version) !== parsed.data.expectedVersion
        || row.record_digest !== parsed.data.candidateRecordDigest) throw new WebAccessError("conflict");
      actor.require("updates.decide", row.project_id, true, "high");
      const decisionId = `update-decision:${randomUUID()}`, decidedAt = actor.now;
      const material = { id: decisionId, tenantId: this.scope.tenantId, candidateId: row.id, projectId: row.project_id,
        candidateVersion: Number(row.version), candidateRecordDigest: row.record_digest, decision: parsed.data.decision,
        ownerIdentityId: actor.id, idempotencyKey, decisionDigest: requestedDigest, decidedAt };
      const authTag = hmacSha256Tag(this.#key, { purpose: "update-candidate-decision/v1", record: material });
      await tx.query(`INSERT INTO control_update_candidate_decisions(tenant_id,id,candidate_id,project_id,candidate_version,
        candidate_record_digest,decision,owner_identity_id,idempotency_key,decision_digest,auth_tag,decided_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [this.scope.tenantId, decisionId, row.id, row.project_id,
        Number(row.version), row.record_digest, parsed.data.decision, actor.id, idempotencyKey, requestedDigest, authTag, decidedAt]);
      await tx.query(`UPDATE control_update_candidates SET state=$1,version=version+1,decided_at=$2
        WHERE tenant_id=$3 AND id=$4`, [parsed.data.decision === "accept" ? "accepted" : "declined",
        decidedAt, this.scope.tenantId, row.id]);
      return updateCandidateDecisionReceiptSchemaV1.parse({ decisionId, candidateId: row.id, projectId: row.project_id,
        decision: parsed.data.decision, candidateVersion: Number(row.version), decidedAt, replayed: false,
        startsDeploy: false, signedDeployApprovalCreated: false, grantsDeployAuthority: false });
    });
  }
}
