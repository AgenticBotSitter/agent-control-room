import { loopCandidateEvidenceSchemaV1, loopCandidateCardSchemaV1, loopCandidatePageSchemaV1, loopCandidateDetailSchemaV1,
  loopCandidateDecisionBodySchemaV1, loopCandidateDecisionReceiptSchemaV1, loopCandidateCompletionReceiptSchemaV1,
  type LoopCandidateEvidenceV1, type LoopCandidateCompletionReceiptV1 } from "./loop-candidate-wire";
import { verifyLoopCandidateCompletionV1, LoopCandidateStaleCompletionV1, type LoopCandidateDependenciesV1 } from "./loop-candidate-publisher";
import { loopBridgeBindingSchemaV1, loopBridgeOutcomeSchemaV1 } from "./schemas";
import { databaseSqlStateV1 } from "../../persistence/database";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, canonicalJson, hmacSha256Tag, sha256Digest } from "../../security";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import type { LinearPipelineServiceV1 } from "../../pipelines/v1";
import { legacyLinearPipelineTemplateInputSchemaV1, linearPipelineTemplateInputSchemaV1 } from "../../pipelines/v1/schemas";
import { CONTROL_ROOM_SELF_PROJECT_TEMPLATE_V1 } from "../../config/v1/product-configuration";
import { improvementDeskViewSchemaV1, improvementRequestDraftSchemaV1, improvementRequestViewSchemaV1,
  loopImprovementDraftSchemaV1, loopImprovementEditSchemaV1, loopImprovementRunIdentitySchemaV1,
  loopImprovementRunLinkSchemaV1, loopImprovementStartSchemaV1, loopImprovementObservationSchemaV1,
  loopImprovementRequestViewSchemaV1, loopImprovementDeskViewSchemaV1, type LoopImprovementContractV1,
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
  database_changes: unknown; risk_flags: unknown; independent_reviews: unknown; lead_worker_id: string;
  state: "ready" | "accepted" | "declined";
  version: number | string; record_digest: string; auth_tag: string; created_at: string | Date; decided_at: string | Date | null };

const iso = (value: string | Date) => new Date(value).toISOString();
const same = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b); };

type LoopSignedRow = { tenant_id: string; project_id: string; owner_identity_id: string;
  record_digest: string; auth_tag: string; created_at: string | Date };
type LoopRootRow = LoopSignedRow & { id: string; idempotency_key: string };
type LoopInputRow = LoopSignedRow & { request_id: string; version: number | string; description: string;
  settings_text: string; request_sha256: string; settings_sha256: string; idempotency_key: string };
type LoopLinkRow = LoopSignedRow & { id: string; request_id: string; initial_input_version: number | string;
  adapter_id: string; loop_run_id: string; tooling_revision: string; a2_schema_version: number | string };
type LoopAuthorizationRow = LoopSignedRow & { id: string; request_id: string; input_version: number | string;
  run_link_id: string; start_key: string; request_sha256: string; settings_sha256: string;
  a2_input_version: unknown; a2_settings_digest: string; observed_revision: number | string; confirmation: unknown };
const loopPurposes = { requests: "loop-improvement-request/v1", inputs: "loop-improvement-input/v1",
  run_links: "loop-improvement-run-link/v1", authorizations: "loop-improvement-authorization/v1" } as const;
type LoopKind = keyof typeof loopPurposes;
const rawLoopHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type LoopCandidateRow = { tenant_id: string; id: string; project_id: string; request_id: string; owner_identity_id: string;
  run_link_id: string; local_version: number | string; a2_input_version: string | number; candidate_revision: string;
  completion_digest: string; retention_digest: string; record_digest: string; auth_tag: string; payload: unknown; created_at: string | Date };
type LoopCandidateDecisionRow = { tenant_id: string; id: string; candidate_id: string; project_id: string; owner_identity_id: string;
  candidate_record_digest: string; candidate_revision: string; idempotency_key: string; decision: "accept" | "decline";
  decision_digest: string; auth_tag: string; candidate_version: number | string; decided_at: string | Date };

export class ImproveControlRoomDeskServiceV1 {
  readonly #key: Uint8Array;
  readonly #authority: WebSessionAuthority;
  readonly #loopReadAuthority: WebSessionAuthority;

  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    integrityKey: Uint8Array, private readonly pipelines: Pick<LinearPipelineServiceV1, "instantiate"> | undefined,
    private readonly clock: () => number = Date.now, private readonly loopContract?: LoopImprovementContractV1, private readonly loopCandidates?: LoopCandidateDependenciesV1) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("improvement_desk_configuration_invalid");
    if (loopCandidates && (!loopContract || loopCandidates.source.toolingRevision !== loopContract.toolingRevision
      || !/^sha256:[a-f0-9]{64}$/.test(loopCandidates.source.schemaDigest))) throw new Error("loop_candidate_configuration_invalid");
    if (loopCandidates) {
      const source = loopCandidates.source, repository = loopCandidates.repository;
      this.loopCandidates = Object.freeze({ source: Object.freeze({ toolingRevision: source.toolingRevision,
        schemaDigest: source.schemaDigest, readVerifiedCompletion: source.readVerifiedCompletion.bind(source) }),
        repository: Object.freeze({ observe: repository.observe.bind(repository) }) });
    }
    this.#key = Uint8Array.from(integrityKey);
    this.#authority = new WebSessionAuthority(db, scope, clock, "improvement_desk");
    // Loop GETs require an already established session and never register one.
    // The common authority's exact session-bootstrap INSERT is suppressed; its
    // immediately following locked SELECT still verifies the existing session.
    const readSession = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(statement: string, params?: unknown[]) => {
      if (statement.startsWith("INSERT INTO control_web_sessions(")) return { rows: [] as T[] };
      if (!statement.trimStart().startsWith("SELECT")) throw new Error("loop_read_write_refused");
      return tx.query<T>(statement, params);
    } });
    const readDb: DatabaseClient = { query: (sql, params) => readSession(db).query(sql, params),
      transaction: callback => db.transaction(tx => callback(readSession(tx))),
      transactionWithPreCommitCheck: (callback, check) => db.transactionWithPreCommitCheck(tx => callback(readSession(tx)), check) };
    this.#loopReadAuthority = new WebSessionAuthority(readDb, scope, clock, "improvement_desk");
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

  async #legacyDeskView(tx: DatabaseSession, projectId: string) {
      const templates = await this.#templates(tx, projectId);
      const requests = (await tx.query<RequestRow>(`SELECT id,project_id,description,pipeline_template_id,
        pipeline_template_version,pipeline_template_digest,selected_worker_ids,lead_worker_id,pipeline_run_id,
        owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,created_at
        FROM control_improvement_requests WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,
      [this.scope.tenantId, projectId])).rows.map(row => this.#requestView(row));
      return improvementDeskViewSchemaV1.parse({ projectId, templates: templates.map(value => value.choice), requests,
        startsWork: false, grantsDeployAuthority: false });
  }

  async view(identity: VerifiedWebIdentity, projectId: string) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", projectId, true); await this.#requireSelfProject(tx, projectId);
      return this.#legacyDeskView(tx, projectId);
    }, { readOnly: true });
  }

  async create(identity: VerifiedWebIdentity, projectId: string, draft: unknown, idempotencyKey: string) {
    if (!this.pipelines) throw new Error("improvement_desk_configuration_invalid");
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
      // The web login holds no UPDATE on requests, so no row lock here. Same-owner writes
      // already serialize on the identity lock; the unique key and replay back that up.
      const replay = async () => {
        const existing = (await tx.query<RequestRow>(`SELECT id,project_id,description,pipeline_template_id,
          pipeline_template_version,pipeline_template_digest,selected_worker_ids,lead_worker_id,pipeline_run_id,
          owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,created_at
          FROM control_improvement_requests WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3`,
        [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
        if (!existing) return undefined;
        if (existing.request_digest !== requestDigest || existing.pipeline_run_id !== run.runId) throw new WebAccessError("conflict");
        return { request: this.#requestView(existing), replayed: true };
      };
      const prior = await replay(); if (prior) return prior;
      const now = actor.now, id = `improvement:${randomUUID()}`, template = prepared.template!;
      const partial: RequestRow = { id, project_id: projectId, description: parsed.data.description,
        pipeline_template_id: template.row.id, pipeline_template_version: Number(template.row.version),
        pipeline_template_digest: template.row.record_digest, selected_worker_ids: parsed.data.selectedWorkerIds,
        lead_worker_id: parsed.data.leadWorkerId, pipeline_run_id: run.runId, owner_identity_id: actor.id,
        idempotency_key: idempotencyKey, request_digest: requestDigest, record_digest: "", auth_tag: "", created_at: now };
      const material = this.#requestMaterial(partial), recordDigest = sha256Digest(material);
      const authTag = hmacSha256Tag(this.#key, { purpose: "improvement-request/v1", record: material });
      const inserted = await tx.query<{ id: string }>(`INSERT INTO control_improvement_requests(tenant_id,id,project_id,description,pipeline_template_id,
        pipeline_template_version,pipeline_template_digest,selected_worker_ids,lead_worker_id,pipeline_run_id,
        owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (tenant_id, owner_identity_id, idempotency_key) DO NOTHING RETURNING id`,
      [this.scope.tenantId, id, projectId, partial.description, partial.pipeline_template_id,
        partial.pipeline_template_version, partial.pipeline_template_digest, JSON.stringify(partial.selected_worker_ids),
        partial.lead_worker_id, partial.pipeline_run_id, actor.id, idempotencyKey, requestDigest, recordDigest, authTag, now]);
      if (!inserted.rows.length) {
        const winner = await replay(); if (!winner) throw new WebAccessError("conflict");
        return winner;
      }
      return { request: this.#requestView({ ...partial, record_digest: recordDigest, auth_tag: authTag }), replayed: false };
    });
  }

  #candidateMaterial(row: CandidateRow) {
    return { id: row.id, tenantId: this.scope.tenantId, projectId: row.project_id,
      improvementRequestId: row.improvement_request_id, pipelineRunId: row.pipeline_run_id,
      baseRevision: row.base_revision, candidateRevision: row.candidate_revision, summary: row.summary,
      changedAreas: row.changed_areas, testResults: row.test_results, databaseChanges: row.database_changes,
      riskFlags: row.risk_flags, independentReviews: row.independent_reviews,
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
      riskFlags: row.risk_flags, independentReviews: row.independent_reviews,
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
      const replay = async () => {
        const existing = (await tx.query<CandidateRow>(`SELECT id,project_id,improvement_request_id,pipeline_run_id,
          base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,risk_flags,independent_reviews,
          lead_worker_id,state,version,
          record_digest,auth_tag,created_at,decided_at FROM control_update_candidates
          WHERE tenant_id=$1 AND pipeline_run_id=$2`, [this.scope.tenantId, parsed.pipelineRunId])).rows[0];
        if (!existing) return undefined;
        const view = this.#candidateView(existing);
        const { candidateId: _id, state: _state, version: _version, recordDigest: _digest, createdAt: _created,
          decidedAt: _decided, startsDeploy: _deploy, signedDeployApprovalCreated: _approval, ...evidence } = view;
        if (canonicalJson(evidence) !== canonicalJson(parsed)) throw new Error("update_candidate_conflict");
        return { candidate: view, replayed: true };
      };
      const prior = await replay(); if (prior) return prior;
      const now = new Date(this.clock()).toISOString(), id = `update-candidate:${randomUUID()}`;
      const partial: CandidateRow = { id, project_id: parsed.projectId, improvement_request_id: parsed.improvementRequestId,
        pipeline_run_id: parsed.pipelineRunId, base_revision: parsed.baseRevision, candidate_revision: parsed.candidateRevision,
        summary: parsed.summary, changed_areas: parsed.changedAreas, test_results: parsed.testResults,
        database_changes: parsed.databaseChanges, risk_flags: parsed.riskFlags,
        independent_reviews: parsed.independentReviews, lead_worker_id: parsed.leadWorkerId, state: "ready", version: 1,
        record_digest: "", auth_tag: "", created_at: now, decided_at: null };
      const material = this.#candidateMaterial(partial), recordDigest = sha256Digest(material);
      const authTag = hmacSha256Tag(this.#key, { purpose: "update-candidate/v1", record: material });
      // No UPDATE grant, so no row lock: a concurrent publisher of the same run loses the
      // unique key and replays the winner.
      const inserted = await tx.query<{ id: string }>(`INSERT INTO control_update_candidates(tenant_id,id,project_id,improvement_request_id,pipeline_run_id,
        base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,risk_flags,independent_reviews,
        lead_worker_id,state,version,record_digest,auth_tag,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,'ready',1,$15,$16,$17)
        ON CONFLICT (tenant_id, pipeline_run_id) DO NOTHING RETURNING id`,
      [this.scope.tenantId, id, parsed.projectId, parsed.improvementRequestId, parsed.pipelineRunId,
        parsed.baseRevision, parsed.candidateRevision, parsed.summary, JSON.stringify(parsed.changedAreas),
        JSON.stringify(parsed.testResults), JSON.stringify(parsed.databaseChanges), JSON.stringify(parsed.riskFlags),
        JSON.stringify(parsed.independentReviews), parsed.leadWorkerId, recordDigest, authTag, now]);
      if (!inserted.rows.length) {
        const winner = await replay(); if (!winner) throw new Error("update_candidate_conflict");
        return winner;
      }
      return { candidate: this.#candidateView({ ...partial, record_digest: recordDigest, auth_tag: authTag }), replayed: false };
    });
  }

  async ready(identity: VerifiedWebIdentity) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", undefined, true);
      const rows = (await tx.query<CandidateRow>(`SELECT id,project_id,improvement_request_id,pipeline_run_id,
        base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,risk_flags,independent_reviews,
        lead_worker_id,state,version,
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
        base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,risk_flags,independent_reviews,
        lead_worker_id,state,version,
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
  #loopMaterial(row: LoopSignedRow) {
    const material: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(row)) {
      if (name === "record_digest" || name === "auth_tag") continue;
      if (["version", "initial_input_version", "input_version", "a2_schema_version", "observed_revision"].includes(name)) {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < (name === "observed_revision" ? 0 : 1))
          throw new Error("loop_improvement_integrity_failed");
        material[name] = number;
      } else material[name] = name === "created_at" ? iso(value as string | Date) : value;
    }
    return material;
  }

  #sealLoop<T extends LoopSignedRow>(kind: LoopKind, row: T): T {
    const record = this.#loopMaterial(row);
    return { ...row, record_digest: sha256Digest(record),
      auth_tag: hmacSha256Tag(this.#key, { purpose: loopPurposes[kind], record }) };
  }

  #verifyLoop(kind: LoopKind, row: LoopSignedRow) {
    const record = this.#loopMaterial(row);
    if (row.tenant_id !== this.scope.tenantId || sha256Digest(record) !== row.record_digest
      || !same(hmacSha256Tag(this.#key, { purpose: loopPurposes[kind], record }), row.auth_tag))
      throw new Error("loop_improvement_integrity_failed");
    if (kind === "inputs") {
      const input = row as LoopInputRow;
      if (!loopImprovementDraftSchemaV1.safeParse({ description: input.description, settingsText: input.settings_text }).success
        || rawLoopHash(input.description) !== input.request_sha256 || rawLoopHash(input.settings_text) !== input.settings_sha256)
        throw new Error("loop_improvement_integrity_failed");
    }
  }

  async #insertLoop<T extends LoopSignedRow>(tx: DatabaseSession, kind: LoopKind, row: T) {
    const signed = this.#sealLoop(kind, row), columns = Object.keys(signed);
    // Table/columns come exclusively from the closed server row constructors below.
    const values = Object.entries(signed).map(([name, value]) =>
      ["confirmation", "a2_input_version"].includes(name) ? JSON.stringify(value) : value);
    await tx.query(`INSERT INTO control_loop_improvement_${kind}(${columns.join(",")})
      VALUES(${columns.map((name, i) => `$${i + 1}${["confirmation", "a2_input_version"].includes(name) ? "::jsonb" : ""}`).join(",")})`, values);
    return signed;
  }

  #loopKey(key: string) {
    if (!/^[A-Za-z0-9:_-]{16,100}$/.test(key)) throw new WebAccessError("invalid_request");
  }

  async #loopRoot(tx: DatabaseSession, projectId: string, requestId: string, ownerId?: string) {
    const root = (await tx.query<LoopRootRow>(`SELECT * FROM control_loop_improvement_requests
      WHERE tenant_id=$1 AND id=$2`, [this.scope.tenantId, requestId])).rows[0];
    if (!root || root.project_id !== projectId || (ownerId !== undefined && root.owner_identity_id !== ownerId))
      throw new WebAccessError("not_found");
    this.#verifyLoop("requests", root);
    return root;
  }

  async #loopInput(tx: DatabaseSession, root: LoopRootRow, version?: number) {
    const input = (await tx.query<LoopInputRow>(`SELECT * FROM control_loop_improvement_inputs
      WHERE tenant_id=$1 AND request_id=$2 ${version === undefined ? "ORDER BY version DESC LIMIT 1" : "AND version=$3"}`,
    version === undefined ? [root.tenant_id, root.id] : [root.tenant_id, root.id, version])).rows[0];
    if (!input || input.project_id !== root.project_id || input.owner_identity_id !== root.owner_identity_id)
      throw new Error("loop_improvement_integrity_failed");
    this.#verifyLoop("inputs", input);
    return input;
  }

  async #loopLink(tx: DatabaseSession, root: LoopRootRow) {
    const link = (await tx.query<LoopLinkRow>(`SELECT * FROM control_loop_improvement_run_links
      WHERE tenant_id=$1 AND request_id=$2`, [root.tenant_id, root.id])).rows[0];
    if (link) {
      this.#verifyLoop("run_links", link);
      if (link.project_id !== root.project_id || link.owner_identity_id !== root.owner_identity_id)
        throw new Error("loop_improvement_integrity_failed");
      await this.#loopInput(tx, root, Number(link.initial_input_version));
    }
    return link;
  }

  #loopRunView(link: LoopLinkRow) {
    return { runLinkId: link.id, initialInputVersion: Number(link.initial_input_version), adapterId: link.adapter_id,
      loopRunId: link.loop_run_id, toolingRevision: link.tooling_revision, a2SchemaVersion: Number(link.a2_schema_version) as 1 };
  }

  #loopInputView(input: LoopInputRow) {
    return { version: Number(input.version), description: input.description,
      requestSha256: input.request_sha256, settingsSha256: input.settings_sha256 };
  }

  async #loopRequestView(tx: DatabaseSession, root: LoopRootRow) {
    const current = await this.#loopInput(tx, root), link = await this.#loopLink(tx, root);
    const authorization = (await tx.query<LoopAuthorizationRow>(`SELECT * FROM control_loop_improvement_authorizations
      WHERE tenant_id=$1 AND request_id=$2 AND input_version=$3`, [root.tenant_id, root.id, Number(current.version)])).rows[0];
    if (authorization) {
      this.#verifyLoop("authorizations", authorization);
      if (!link || authorization.run_link_id !== link.id || authorization.project_id !== root.project_id
        || authorization.owner_identity_id !== root.owner_identity_id
        || authorization.request_sha256 !== current.request_sha256 || authorization.settings_sha256 !== current.settings_sha256)
        throw new Error("loop_improvement_integrity_failed");
    }
    return loopImprovementRequestViewSchemaV1.parse({ requestId: root.id, projectId: root.project_id,
      currentVersion: Number(current.version), description: current.description, requestSha256: current.request_sha256,
      settingsSha256: current.settings_sha256, runLink: link ? this.#loopRunView(link) : null,
      savedAuthorization: !!authorization,
      createdAt: iso(root.created_at), startsWork: false, grantsDeployAuthority: false });
  }

  async saveLoopDraft(identity: VerifiedWebIdentity, projectId: string, draft: unknown, idempotencyKey: string) {
    const parsed = loopImprovementDraftSchemaV1.safeParse(draft);
    this.#loopKey(idempotencyKey);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data); } catch { throw new WebAccessError("invalid_request"); }
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.propose", projectId, true); await this.#requireSelfProject(tx, projectId);
      const prior = (await tx.query<LoopInputRow>(`SELECT * FROM control_loop_improvement_inputs
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3`,
      [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
      if (prior) {
        this.#verifyLoop("inputs", prior);
        if (prior.project_id !== projectId || Number(prior.version) !== 1
          || prior.description !== parsed.data.description || prior.settings_text !== parsed.data.settingsText)
          throw new WebAccessError("conflict");
        const root = await this.#loopRoot(tx, projectId, prior.request_id, actor.id);
        if (root.idempotency_key !== idempotencyKey) throw new WebAccessError("conflict");
        return { request: await this.#loopRequestView(tx, root), savedInput: this.#loopInputView(prior), replayed: true };
      }
      const root = await this.#insertLoop(tx, "requests", { tenant_id: this.scope.tenantId,
        id: `loop-request:${randomUUID()}`, project_id: projectId, owner_identity_id: actor.id,
        idempotency_key: idempotencyKey, created_at: actor.now, record_digest: "", auth_tag: "" });
      const input = await this.#insertLoop(tx, "inputs", { tenant_id: root.tenant_id, request_id: root.id,
        project_id: projectId, owner_identity_id: actor.id, version: 1, description: parsed.data.description,
        settings_text: parsed.data.settingsText, request_sha256: rawLoopHash(parsed.data.description),
        settings_sha256: rawLoopHash(parsed.data.settingsText), idempotency_key: idempotencyKey,
        created_at: actor.now, record_digest: "", auth_tag: "" });
      return { request: await this.#loopRequestView(tx, root), savedInput: this.#loopInputView(input), replayed: false };
    });
  }

  async reviseLoopDraft(identity: VerifiedWebIdentity, projectId: string, edit: unknown, idempotencyKey: string) {
    const parsed = loopImprovementEditSchemaV1.safeParse(edit); this.#loopKey(idempotencyKey);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data); } catch { throw new WebAccessError("invalid_request"); }
    const value = parsed.data;
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.propose", projectId, true); await this.#requireSelfProject(tx, projectId);
      const root = await this.#loopRoot(tx, projectId, value.requestId, actor.id);
      const prior = (await tx.query<LoopInputRow>(`SELECT * FROM control_loop_improvement_inputs
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3`,
      [root.tenant_id, actor.id, idempotencyKey])).rows[0];
      if (prior) {
        this.#verifyLoop("inputs", prior);
        if (prior.request_id !== root.id || prior.project_id !== projectId || Number(prior.version) !== value.expectedVersion + 1
          || prior.description !== value.description || prior.settings_text !== value.settingsText) throw new WebAccessError("conflict");
        return { request: await this.#loopRequestView(tx, root), savedInput: this.#loopInputView(prior), replayed: true };
      }
      const current = await this.#loopInput(tx, root);
      if (Number(current.version) !== value.expectedVersion || value.expectedVersion === Number.MAX_SAFE_INTEGER)
        throw new WebAccessError("conflict");
      // Engine-linked copies cannot be changed in place. Stop and create a new request.
      if (current.settings_text !== value.settingsText && await this.#loopLink(tx, root)) throw new WebAccessError("conflict");
      const input = await this.#insertLoop(tx, "inputs", { tenant_id: root.tenant_id, request_id: root.id,
        project_id: projectId, owner_identity_id: actor.id, version: value.expectedVersion + 1,
        description: value.description, settings_text: value.settingsText, request_sha256: rawLoopHash(value.description),
        settings_sha256: rawLoopHash(value.settingsText), idempotency_key: idempotencyKey,
        created_at: actor.now, record_digest: "", auth_tag: "" });
      return { request: await this.#loopRequestView(tx, root), savedInput: this.#loopInputView(input), replayed: false };
    });
  }

  #decodeLoopRun(value: unknown) {
    if (!this.loopContract || !/^sha256:[a-f0-9]{64}$/.test(this.loopContract.toolingRevision))
      throw new Error("loop_contract_unavailable");
    const run = loopImprovementRunIdentitySchemaV1.parse(this.loopContract.decodeRunIdentity(value));
    if (run.toolingRevision !== this.loopContract.toolingRevision) throw new Error("loop_contract_pin_mismatch");
    return run;
  }

  /** Server-only, inert admission seam. No production caller until A2 is pinned. */
  async recordLoopRunLink(input: unknown) {
    const value = loopImprovementRunLinkSchemaV1.parse(input), run = this.#decodeLoopRun(value.run);
    return this.db.transaction(async tx => {
      const root = await this.#loopRoot(tx, value.projectId, value.requestId);
      await tx.query("SELECT id FROM control_identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [root.tenant_id, root.owner_identity_id]);
      await this.#requireSelfProject(tx, value.projectId);
      await this.#loopInput(tx, root, value.initialInputVersion);
      const prior = await this.#loopLink(tx, root);
      if (prior) {
        if (Number(prior.initial_input_version) !== value.initialInputVersion
          || canonicalJson({ adapterId: prior.adapter_id, loopRunId: prior.loop_run_id, toolingRevision: prior.tooling_revision,
            a2SchemaVersion: Number(prior.a2_schema_version) }) !== canonicalJson(run)) throw new WebAccessError("conflict");
        return { runLink: this.#loopRunView(prior), replayed: true };
      }
      const link = await this.#insertLoop(tx, "run_links", { tenant_id: root.tenant_id, id: `loop-link:${randomUUID()}`,
        request_id: root.id, initial_input_version: value.initialInputVersion, project_id: root.project_id,
        owner_identity_id: root.owner_identity_id, adapter_id: run.adapterId, loop_run_id: run.loopRunId,
        tooling_revision: run.toolingRevision, a2_schema_version: run.a2SchemaVersion,
        created_at: new Date(this.clock()).toISOString(), record_digest: "", auth_tag: "" });
      return { runLink: this.#loopRunView(link), replayed: false };
    });
  }

  async authorizeLoopStart(identity: VerifiedWebIdentity, projectId: string, input: unknown,
    startKey: string, trustedConfirmation: unknown) {
    const parsed = loopImprovementStartSchemaV1.safeParse(input); this.#loopKey(startKey);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    if (!this.loopContract) throw new Error("loop_contract_unavailable");
    const observation = loopImprovementObservationSchemaV1.parse(this.loopContract.decodeObservation(trustedConfirmation));
    const value = parsed.data;
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.propose", projectId, true, "high"); await this.#requireSelfProject(tx, projectId);
      const root = await this.#loopRoot(tx, projectId, value.requestId, actor.id);
      const current = await this.#loopInput(tx, root), link = await this.#loopLink(tx, root);
      if (!link || link.id !== value.runLinkId || Number(current.version) !== value.expectedVersion
        || current.request_sha256 !== value.requestSha256 || current.settings_sha256 !== value.settingsSha256)
        throw new WebAccessError("conflict");
      const run = this.#decodeLoopRun({ adapterId: link.adapter_id, loopRunId: link.loop_run_id,
        toolingRevision: link.tooling_revision, a2SchemaVersion: Number(link.a2_schema_version) });
      if (observation.confirmation.sha256 !== current.request_sha256
        || canonicalJson(observation.confirmation.input_version) !== canonicalJson(observation.inputVersion)
        || !this.loopContract!.matchesSavedInput(run, observation, { description: current.description,
          settingsText: current.settings_text, requestSha256: current.request_sha256, settingsSha256: current.settings_sha256 }))
        throw new WebAccessError("conflict");
      const binding = { tenant_id: root.tenant_id, request_id: root.id, input_version: Number(current.version),
        project_id: projectId, owner_identity_id: actor.id, run_link_id: link.id, start_key: startKey,
        request_sha256: current.request_sha256, settings_sha256: current.settings_sha256,
        a2_input_version: observation.inputVersion, a2_settings_digest: observation.settingsDigest,
        observed_revision: observation.revision, confirmation: observation.confirmation };
      const prior = (await tx.query<LoopAuthorizationRow>(`SELECT * FROM control_loop_improvement_authorizations
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND start_key=$3`, [root.tenant_id, actor.id, startKey])).rows[0];
      if (prior) {
        this.#verifyLoop("authorizations", prior);
        const { id: _id, created_at: _at, ...saved } = this.#loopMaterial(prior);
        if (canonicalJson(saved) !== canonicalJson(binding)) throw new WebAccessError("conflict");
        return { authorizationId: prior.id, replayed: true, startsWork: false as const, grantsDeployAuthority: false as const };
      }
      const existing = (await tx.query(`SELECT id FROM control_loop_improvement_authorizations
        WHERE tenant_id=$1 AND request_id=$2 AND input_version=$3`, [root.tenant_id, root.id, Number(current.version)])).rows[0];
      if (existing) throw new WebAccessError("conflict");
      const authorization = await this.#insertLoop(tx, "authorizations", { ...binding, id: `loop-authorization:${randomUUID()}`,
        created_at: actor.now, record_digest: "", auth_tag: "" });
      return { authorizationId: authorization.id, replayed: false, startsWork: false as const, grantsDeployAuthority: false as const };
    });
  }

  async viewLoopDesk(identity: VerifiedWebIdentity, projectId: string) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", projectId, true); await this.#requireSelfProject(tx, projectId);
      const roots = (await tx.query<LoopRootRow>(`SELECT * FROM control_loop_improvement_requests
        WHERE tenant_id=$1 AND project_id=$2 AND owner_identity_id=$3 ORDER BY created_at DESC,id DESC LIMIT 100`,
      [this.scope.tenantId, projectId, actor.id])).rows;
      const loopRequests = [];
      for (const root of roots) {
        this.#verifyLoop("requests", root);
        loopRequests.push(await this.#loopRequestView(tx, root));
      }
      return loopImprovementDeskViewSchemaV1.parse({ legacy: await this.#legacyDeskView(tx, projectId), loopRequests });
    }, { readOnly: true, repeatableReadSnapshot: true });
  }
  /** Bounded, read-only owner discovery. Terminal exclusion requires the reviewed A2 evidence pin. */
  async viewLoopAttentionRequests(identity: VerifiedWebIdentity) {
    return this.#loopReadAuthority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", undefined, true);
      const roots = (await tx.query<LoopRootRow>(`SELECT r.* FROM control_loop_improvement_requests r
        JOIN projects p ON p.tenant_id=r.tenant_id AND p.id=r.project_id
        JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
        WHERE r.tenant_id=$1 AND p.workspace_id=$2 AND r.owner_identity_id=$3
          AND p.payload->'presentation'->>'templateId'=$4 AND h.lifecycle='active'
        ORDER BY r.created_at DESC,r.id DESC LIMIT 11`,
      [this.scope.tenantId, this.scope.workspaceId, actor.id, CONTROL_ROOM_SELF_PROJECT_TEMPLATE_V1.id])).rows;
      const requests = [];
      for (const root of roots.slice(0, 10)) {
        actor.require("projects.read", root.project_id, true);
        this.#verifyLoop("requests", root);
        requests.push(await this.#loopRequestView(tx, root));
      }
      return { requests, truncated: roots.length > 10, observedAt: actor.now };
    }, { readOnly: true });
  }

  /** Server-only transaction-local B1a composition. The outer authority owns identity
   * serialization and the final freshness fence; nested B1a calls share this tx. */
  async loopBridgeTransaction<T>(identity: VerifiedWebIdentity, projectId: string, mutation: boolean,
    operation: (context: { tx: DatabaseSession; actor: import("../../web/v1/session-authority").WebActor;
      lineage: ImproveControlRoomDeskServiceV1 }) => Promise<T>) {
    return (mutation ? this.#authority : this.#loopReadAuthority).authenticated(identity, async (tx, actor) => {
      actor.require(mutation ? "tasks.propose" : "projects.read", projectId, true, mutation ? "high" : "low");
      // All loop mutations take the project mutex before the shared scope/head check.
      if (mutation) await tx.query(`SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`,
        [this.scope.tenantId, this.scope.workspaceId, projectId]);
      await this.#requireSelfProject(tx, projectId);
      const localDb: DatabaseClient = {
        query: tx.query.bind(tx), transaction: callback => callback(tx),
        transactionWithPreCommitCheck: async (callback, check) => { const result = await callback(tx); await check(); return result; },
      };
      const lineage = new ImproveControlRoomDeskServiceV1(localDb, this.scope, this.#key, undefined, this.clock, this.loopContract);
      return operation({ tx, actor, lineage });
    }, { readOnly: !mutation });
  }

  /** Verified complete lineage for the bridge; never exposes private settings to HTTP. */
  async loopBridgeLineage(tx: DatabaseSession, projectId: string, requestId: string, ownerId: string) {
    const root = await this.#loopRoot(tx, projectId, requestId, ownerId);
    const input = await this.#loopInput(tx, root), link = await this.#loopLink(tx, root);
    const authorization = (await tx.query<LoopAuthorizationRow>(`SELECT * FROM control_loop_improvement_authorizations
      WHERE tenant_id=$1 AND request_id=$2 AND input_version=$3`, [root.tenant_id, root.id, Number(input.version)])).rows[0];
    if (authorization) {
      this.#verifyLoop("authorizations", authorization);
      if (!link || authorization.run_link_id !== link.id || authorization.project_id !== root.project_id
        || authorization.owner_identity_id !== ownerId || authorization.request_sha256 !== input.request_sha256
        || authorization.settings_sha256 !== input.settings_sha256) throw new Error("loop_improvement_integrity_failed");
    }
    return { root, input, link, authorization, view: await this.#loopRequestView(tx, root) };
  }

  #candidateDependencies() {
    if (!this.loopCandidates || !this.loopContract || this.loopCandidates.source.toolingRevision !== this.loopContract.toolingRevision)
      throw new Error("loop_candidate_unavailable");
    return this.loopCandidates;
  }

  #loopCandidateMaterial(row: LoopCandidateRow) {
    return { tenant_id: row.tenant_id, id: row.id, project_id: row.project_id, request_id: row.request_id,
      owner_identity_id: row.owner_identity_id, run_link_id: row.run_link_id, local_version: Number(row.local_version),
      a2_input_version: row.a2_input_version, candidate_revision: row.candidate_revision, completion_digest: row.completion_digest,
      retention_digest: row.retention_digest, payload: row.payload, created_at: iso(row.created_at) };
  }
  #verifyCandidate(row: LoopCandidateRow) {
    const material = this.#loopCandidateMaterial(row), evidence = loopCandidateEvidenceSchemaV1.parse(row.payload), b = evidence.binding;
    if (row.tenant_id !== this.scope.tenantId || sha256Digest(material) !== row.record_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "loop-update-candidate/v1", record: material }), row.auth_tag)
      || row.project_id !== b.projectId || row.request_id !== b.requestId || row.run_link_id !== b.runLinkId
      || Number(row.local_version) !== b.localVersion || canonicalJson(row.a2_input_version) !== canonicalJson(b.a2InputVersion)
      || row.candidate_revision !== b.candidateRevision || row.completion_digest !== evidence.completionDigest
      || row.retention_digest !== evidence.retentionDigest) throw new Error("loop_candidate_integrity_failed");
    return evidence;
  }
  #decisionMaterial(row: LoopCandidateDecisionRow) {
    return { tenant_id: row.tenant_id, id: row.id, candidate_id: row.candidate_id, project_id: row.project_id,
      owner_identity_id: row.owner_identity_id, candidate_record_digest: row.candidate_record_digest,
      candidate_revision: row.candidate_revision, idempotency_key: row.idempotency_key, decision: row.decision,
      candidate_version: Number(row.candidate_version), decided_at: iso(row.decided_at) };
  }
  #verifyCandidateDecision(row: LoopCandidateDecisionRow, candidate: LoopCandidateRow) {
    const material = this.#decisionMaterial(row);
    if (row.tenant_id !== candidate.tenant_id || row.candidate_id !== candidate.id || row.project_id !== candidate.project_id
      || row.owner_identity_id !== candidate.owner_identity_id || row.candidate_record_digest !== candidate.record_digest
      || row.candidate_revision !== candidate.candidate_revision || Number(row.candidate_version) !== 1
      || !["accept", "decline"].includes(row.decision) || !/^[A-Za-z0-9:_-]{16,100}$/.test(row.idempotency_key)
      || sha256Digest(material) !== row.decision_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "loop-update-candidate-decision/v1", record: material }), row.auth_tag))
      throw new Error("loop_candidate_integrity_failed");
    return row;
  }

  /** Verifies the original Start at its original input, which may precede a later
   * confirmed input. Neither the Start result nor status=finished proves readiness. */
  async #candidateLineage(tx: DatabaseSession, b: Pick<LoopCandidateEvidenceV1["binding"], "projectId" | "requestId" | "runLinkId" | "localVersion" | "adapterId" | "loopRunId" | "toolingRevision" | "requestSha256" | "settingsSha256">, ownerId?: string) {
    const root = await this.#loopRoot(tx, b.projectId, b.requestId, ownerId);
    await this.#requireSelfProject(tx, b.projectId);
    const input = await this.#loopInput(tx, root), link = await this.#loopLink(tx, root);
    if (!link || link.id !== b.runLinkId || link.adapter_id !== b.adapterId || link.loop_run_id !== b.loopRunId
      || link.tooling_revision !== b.toolingRevision || Number(input.version) !== b.localVersion
      || input.request_sha256 !== b.requestSha256 || input.settings_sha256 !== b.settingsSha256)
      throw new WebAccessError("conflict");
    const commands = (await tx.query<Record<string, unknown>>(`SELECT * FROM control_loop_improvement_commands
      WHERE tenant_id=$1 AND request_id=$2 AND operation='start' ORDER BY entry_kind`, [root.tenant_id, root.id])).rows;
    if (commands.length !== 2) throw new WebAccessError("conflict");
    const verified = commands.map((raw): Record<string, unknown> & { binding: import("./schemas").LoopBridgeBindingV1 } => {
      const row: Record<string, unknown> = { ...raw, created_at: iso(raw.created_at as string | Date) };
      const { record_digest, auth_tag, ...record } = row;
      const binding = loopBridgeBindingSchemaV1.parse(record.binding);
      if (record.tenant_id !== root.tenant_id || record.owner_identity_id !== root.owner_identity_id
        || record.project_id !== root.project_id || record.request_id !== root.id
        || sha256Digest(record) !== record_digest
        || !same(hmacSha256Tag(this.#key, { purpose: "loop-improvement-command/v1", record }), String(auth_tag)))
        throw new Error("loop_candidate_integrity_failed");
      return { ...record, binding };
    });
    const claim = verified.find(c => c.entry_kind === "claim"), result = verified.find(c => c.entry_kind === "result");
    if (!claim || !result || claim.command_id !== result.command_id || claim.idempotency_key !== result.idempotency_key
      || canonicalJson(claim.binding) !== canonicalJson(result.binding) || claim.result !== null
      || loopBridgeOutcomeSchemaV1.parse(result.result).state !== "accepted" || claim.binding.runLinkId !== link.id
      || claim.binding.schemaDigest !== this.#candidateDependencies().source.schemaDigest)
      throw new WebAccessError("conflict");
    const authorization = (await tx.query<LoopAuthorizationRow>(`SELECT * FROM control_loop_improvement_authorizations
      WHERE tenant_id=$1 AND id=$2`, [root.tenant_id, claim.binding.authorizationId])).rows[0];
    if (!authorization) throw new WebAccessError("conflict");
    this.#verifyLoop("authorizations", authorization);
    const initial = await this.#loopInput(tx, root, claim.binding.localVersion);
    // Website Confirm records start:<confirm command> while Start keeps the browser's own
    // key, so lineage follows the signed Start claim's authorization id, never start_key.
    if (authorization.id !== claim.binding.authorizationId || authorization.run_link_id !== link.id
      || authorization.request_id !== root.id || authorization.project_id !== root.project_id
      || authorization.owner_identity_id !== root.owner_identity_id
      || Number(authorization.input_version) !== claim.binding.localVersion || authorization.request_sha256 !== initial.request_sha256
      || authorization.settings_sha256 !== initial.settings_sha256 || authorization.request_sha256 !== claim.binding.requestSha256
      || authorization.settings_sha256 !== claim.binding.settingsSha256
      || canonicalJson(authorization.a2_input_version) !== canonicalJson(claim.binding.inputVersion))
      throw new Error("loop_candidate_integrity_failed");
    return { root, input, link };
  }

  async prepareLoopCandidateCompletion(runLinkId: string): Promise<void> {
    this.#candidateDependencies();
    await this.db.transaction(async tx => {
      const raw = (await tx.query<LoopLinkRow>(`SELECT * FROM control_loop_improvement_run_links
        WHERE tenant_id=$1 AND id=$2`, [this.scope.tenantId,runLinkId])).rows[0];
      if (!raw) throw new WebAccessError("not_found");
      this.#verifyLoop("run_links",raw);
      const root = await this.#loopRoot(tx,raw.project_id,raw.request_id), input = await this.#loopInput(tx,root);
      await this.#candidateLineage(tx,{ projectId:root.project_id,requestId:root.id,runLinkId:raw.id,
        localVersion:Number(input.version),adapterId:raw.adapter_id,loopRunId:raw.loop_run_id,toolingRevision:raw.tooling_revision,
        requestSha256:input.request_sha256,settingsSha256:input.settings_sha256 });
    });
  }

  #completionReceipt(row: LoopCandidateRow, state: "recorded" | "replayed"): LoopCandidateCompletionReceiptV1 {
    const e = this.#verifyCandidate(row), b = e.binding;
    return loopCandidateCompletionReceiptSchemaV1.parse({ schemaVersion: 1, state, projectId: row.project_id,
      requestId: row.request_id, runLinkId: row.run_link_id, localVersion: Number(row.local_version), a2InputVersion: row.a2_input_version,
      engineRevision: b.engineRevision, completionDigest: row.completion_digest, retentionDigest: row.retention_digest,
      candidate: { candidateId: row.id, candidateRevision: row.candidate_revision, recordDigest: row.record_digest },
      finishedAt: e.timing.finishedAt, href: `/projects/${encodeURIComponent(row.project_id)}/improvements#request=${encodeURIComponent(row.request_id)}` });
  }
  async recordLoopCandidate(input: LoopCandidateEvidenceV1): Promise<LoopCandidateCompletionReceiptV1> {
    const deps = this.#candidateDependencies(), e = loopCandidateEvidenceSchemaV1.parse(input);
    // Local signed lineage is checked before touching configured evidence files.
    await this.db.transaction(tx => this.#candidateLineage(tx, e.binding));
    const verified = await verifyLoopCandidateCompletionV1(deps, e.binding.runLinkId, e.completionDigest);
    if (canonicalJson(e) !== canonicalJson(verified)) throw new WebAccessError("conflict");
    return this.db.transaction(async tx => {
      const root = await this.#loopRoot(tx, e.binding.projectId, e.binding.requestId);
      await tx.query(`SELECT id FROM control_identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [root.tenant_id, root.owner_identity_id]);
      await this.#candidateLineage(tx, e.binding);
      const prior = (await tx.query<LoopCandidateRow>(`SELECT * FROM control_loop_update_candidates
        WHERE tenant_id=$1 AND run_link_id=$2 AND local_version=$3 AND a2_input_version=$4::jsonb`,
      [root.tenant_id, e.binding.runLinkId, e.binding.localVersion, JSON.stringify(e.binding.a2InputVersion)])).rows[0];
      if (prior) {
        if (canonicalJson(this.#verifyCandidate(prior)) !== canonicalJson(e)) throw new WebAccessError("conflict");
        return this.#completionReceipt(prior, "replayed");
      }
      const material = this.#loopCandidateMaterial({ tenant_id: root.tenant_id, id: `loop-candidate:${randomUUID()}`,
        project_id: root.project_id, request_id: root.id, owner_identity_id: root.owner_identity_id, run_link_id: e.binding.runLinkId,
        local_version: e.binding.localVersion, a2_input_version: e.binding.a2InputVersion, candidate_revision: e.binding.candidateRevision,
        completion_digest: e.completionDigest, retention_digest: e.retentionDigest, payload: e, created_at: new Date(this.clock()).toISOString(),
        record_digest: "", auth_tag: "" });
      const row: LoopCandidateRow = { ...material, record_digest: sha256Digest(material),
        auth_tag: hmacSha256Tag(this.#key, { purpose: "loop-update-candidate/v1", record: material }) };
      await tx.query(`INSERT INTO control_loop_update_candidates(tenant_id,id,project_id,request_id,owner_identity_id,run_link_id,
        local_version,a2_input_version,candidate_revision,completion_digest,retention_digest,payload,created_at,record_digest,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
      [row.tenant_id,row.id,row.project_id,row.request_id,row.owner_identity_id,row.run_link_id,row.local_version,JSON.stringify(row.a2_input_version),
        row.candidate_revision,row.completion_digest,row.retention_digest,JSON.stringify(row.payload),row.created_at,row.record_digest,row.auth_tag]);
      return this.#completionReceipt(row, "recorded");
    });
  }

  async #candidateSnapshot(identity: VerifiedWebIdentity, projectId?: string, requestId?: string) {
    this.#candidateDependencies();
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", projectId, true);
      if (projectId) { await this.#requireSelfProject(tx, projectId); await this.#loopRoot(tx, projectId, requestId!, actor.id); }
      const rows = (await tx.query<LoopCandidateRow>(`SELECT * FROM control_loop_update_candidates WHERE tenant_id=$1 AND owner_identity_id=$2
        ${projectId ? "AND project_id=$3 AND request_id=$4" : ""} ORDER BY created_at DESC,id DESC LIMIT ${projectId ? "1" : "11"}`,
      projectId ? [this.scope.tenantId,actor.id,projectId,requestId] : [this.scope.tenantId,actor.id])).rows;
      const values = [];
      for (const row of rows.slice(0, projectId ? 1 : 10)) {
        actor.require("projects.read", row.project_id, true); await this.#requireSelfProject(tx, row.project_id);
        const e = this.#verifyCandidate(row), root = await this.#loopRoot(tx,row.project_id,row.request_id,actor.id);
        const input = await this.#loopInput(tx,root); await this.#loopLink(tx,root);
        const decision = (await tx.query<LoopCandidateDecisionRow>(`SELECT * FROM control_loop_update_candidate_decisions
          WHERE tenant_id=$1 AND candidate_id=$2`, [row.tenant_id,row.id])).rows[0];
        if (decision) this.#verifyCandidateDecision(decision,row);
        const newer = (await tx.query(`SELECT id FROM control_loop_update_candidates WHERE tenant_id=$1 AND run_link_id=$2
          AND local_version=$3 AND id<>$4 AND (payload->'binding'->>'engineRevision')::bigint >= $5 LIMIT 1`,
        [row.tenant_id,row.run_link_id,row.local_version,row.id,e.binding.engineRevision])).rows.length > 0;
        values.push({ row, e, decision, current: !newer && Number(input.version) === e.binding.localVersion
          && input.request_sha256 === e.binding.requestSha256 && input.settings_sha256 === e.binding.settingsSha256,
          mayDecide: actor.can("updates.decide", row.project_id, true, "high") });
      }
      return { values, truncated: rows.length > 10, observedAt: actor.now };
    }, { readOnly: true });
  }
  async #freshCandidate(value: { row: LoopCandidateRow; e: LoopCandidateEvidenceV1; decision: LoopCandidateDecisionRow | undefined; current: boolean; mayDecide: boolean }) {
    let current = value.current, unreadable: { error: unknown } | undefined;
    if (current) {
      try {
        const e = await verifyLoopCandidateCompletionV1(this.#candidateDependencies(), value.row.run_link_id);
        current = canonicalJson(e) === canonicalJson(value.e);
      } catch (error) {
        current = false;
        // A decided card is retained history: lost or superseded evidence never hides its decision.
        if (!(error instanceof LoopCandidateStaleCompletionV1) && !value.decision) unreadable = { error };
      }
    }
    const d = value.decision;
    return { unreadable, card: loopCandidateCardSchemaV1.parse({ candidateId: value.row.id, projectId: value.row.project_id, requestId: value.row.request_id,
      localVersion: Number(value.row.local_version), a2InputVersion: value.row.a2_input_version, candidateRevision: value.row.candidate_revision,
      recordDigest: value.row.record_digest, version: d ? 2 : 1, state: d ? d.decision === "accept" ? "accepted" : "declined" : "ready",
      evidence: value.e, freshness: current ? "current" : "stale", createdAt: iso(value.row.created_at),
      decidedAt: d ? iso(d.decided_at) : null, canDecide: current && !d && value.mayDecide }) };
  }
  async readLoopCandidates(identity: VerifiedWebIdentity) {
    const snap = await this.#candidateSnapshot(identity), results = [];
    for (const value of snap.values) results.push(await this.#freshCandidate(value));
    // One unreadable card is isolated without decision authority beside any other
    // readable card or retained history. A page of only unreadable cards is unknown
    // and fails rather than looking clear.
    if (results.length && results.every(r => r.unreadable)) throw results[0]!.unreadable!.error;
    return loopCandidatePageSchemaV1.parse({ schemaVersion: 1, candidates: results.map(r => r.card), truncated: snap.truncated,
      observedAt: snap.observedAt, startsDeploy: false, signedDeployApprovalCreated: false });
  }
  async readLoopCandidate(identity: VerifiedWebIdentity, projectId: string, requestId: string) {
    const snap = await this.#candidateSnapshot(identity, projectId, requestId);
    const result = snap.values[0] ? await this.#freshCandidate(snap.values[0]) : undefined;
    if (result?.unreadable) throw result.unreadable.error;
    return loopCandidateDetailSchemaV1.parse({ schemaVersion: 1, candidate: result?.card ?? null, observedAt: snap.observedAt });
  }
  #candidateDecisionReceipt(row: LoopCandidateDecisionRow, replayed: boolean) {
    return loopCandidateDecisionReceiptSchemaV1.parse({ schemaVersion: 1, decisionId: row.id, candidateId: row.candidate_id,
      projectId: row.project_id, decision: row.decision, candidateVersion: 1, candidateRevision: row.candidate_revision,
      candidateRecordDigest: row.candidate_record_digest, decidedAt: iso(row.decided_at), replayed,
      startsDeploy: false, signedDeployApprovalCreated: false, grantsDeployAuthority: false });
  }
  async decideLoopCandidate(identity: VerifiedWebIdentity, body: unknown, key: string) {
    const parsed = loopCandidateDecisionBodySchemaV1.safeParse(body); this.#loopKey(key);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    this.#candidateDependencies();
    const b = parsed.data;
    // Reauthorization precedes replay and all source reads.
    const prepare = async (tx: DatabaseSession, actor: import("../../web/v1/session-authority").WebActor) => {
      const row = (await tx.query<LoopCandidateRow>(`SELECT * FROM control_loop_update_candidates
        WHERE tenant_id=$1 AND id=$2 AND owner_identity_id=$3`, [this.scope.tenantId,b.candidateId,actor.id])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      actor.require("updates.decide",row.project_id,true,"high"); await this.#requireSelfProject(tx,row.project_id);
      const e = this.#verifyCandidate(row);
      await this.#loopRoot(tx,row.project_id,row.request_id,actor.id);
      if (b.candidateRevision !== row.candidate_revision || b.candidateRecordDigest !== row.record_digest
        || b.localVersion !== Number(row.local_version) || canonicalJson(b.a2InputVersion) !== canonicalJson(row.a2_input_version))
        throw new WebAccessError("conflict");
      const prior = (await tx.query<LoopCandidateDecisionRow>(`SELECT * FROM control_loop_update_candidate_decisions
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND (idempotency_key=$3 OR candidate_id=$4)`,
      [row.tenant_id,actor.id,key,row.id])).rows;
      if (prior.length) {
        if (prior.length !== 1 || prior[0]!.candidate_id !== row.id) throw new WebAccessError("conflict");
        const decision = this.#verifyCandidateDecision(prior[0]!,row);
        if (decision.idempotency_key !== key || decision.decision !== b.decision) throw new WebAccessError("conflict");
        return { row,e,receipt:this.#candidateDecisionReceipt(decision,true) };
      }
      await this.#candidateLineage(tx,e.binding,actor.id);
      return { row,e,receipt:undefined };
    };
    const prepared = await this.#authority.authenticated(identity,prepare,{readOnly:true});
    if (prepared.receipt) return prepared.receipt;
    const verified = await verifyLoopCandidateCompletionV1(this.#candidateDependencies(),prepared.row.run_link_id);
    if (canonicalJson(verified) !== canonicalJson(prepared.e)) throw new WebAccessError("conflict");
    try {
      return await this.#authority.authenticated(identity,async(tx,actor)=>{
        const current = await prepare(tx,actor); if(current.receipt) return current.receipt;
        const material = this.#decisionMaterial({ tenant_id: this.scope.tenantId,id:`loop-candidate-decision:${randomUUID()}`,
          candidate_id: current.row.id,project_id: current.row.project_id,owner_identity_id:actor.id,candidate_record_digest:current.row.record_digest,
          candidate_revision:current.row.candidate_revision,idempotency_key:key,decision:b.decision,candidate_version:1,decided_at:actor.now,decision_digest:"",auth_tag:"" });
        const row: LoopCandidateDecisionRow = { ...material, decision_digest:sha256Digest(material),
          auth_tag:hmacSha256Tag(this.#key,{purpose:"loop-update-candidate-decision/v1",record:material}) };
        actor.require("updates.decide",row.project_id,true,"high");
        await tx.query(`INSERT INTO control_loop_update_candidate_decisions(tenant_id,id,candidate_id,project_id,owner_identity_id,
          candidate_record_digest,candidate_revision,idempotency_key,decision,candidate_version,decided_at,decision_digest,auth_tag)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [row.tenant_id,row.id,row.candidate_id,row.project_id,row.owner_identity_id,row.candidate_record_digest,row.candidate_revision,
          row.idempotency_key,row.decision,row.candidate_version,row.decided_at,row.decision_digest,row.auth_tag]);
        return this.#candidateDecisionReceipt(row,false);
      });
    } catch(error) { if (["23505","23514"].includes(databaseSqlStateV1(error) ?? "")) throw new WebAccessError("conflict"); throw error; }
  }

}
