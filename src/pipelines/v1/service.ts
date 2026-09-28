import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { CanonicalStore } from "../../persistence/canonical-store";
import { DOMAIN_CONTRACT_VERSION, type AuthorityEnvelope, type JobRecord, type RequestRecord, type WorkflowRecord } from "../../domain/v1";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, computeAuthorityDigest, hmacSha256Tag, sha256Digest } from "../../security";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import type { WorkBatchQueueAdmissionAuthorityV1, WorkBatchQueueAdmissionSelectionV1 } from "../../work-intake/v1/owner-service";
import { instantiateLinearPipelineSchemaV1, legacyLinearPipelineTemplateInputSchemaV1,
  linearPipelineTemplateInputSchemaV1, pipelineBuildWritePolicySchemaV1, pipelineRunPageSchemaV1,
  pipelineRunReceiptSchemaV1, pipelineRunViewSchemaV1, pipelineTemplateReceiptSchemaV1,
  type LinearPipelineTemplateInputV1, type PipelineStageTemplateV1 } from "./schemas";
import { controllerWorkerDeliverySchemaV1 } from "../../harness/v1/controller-worker-delivery";
import { verifyPullRequestPublicationEvidenceV1,
  verifyStoredPullRequestPublicationEvidenceV1 } from "../../harness/v1/pull-request-publication";
import { createPipelineBuildPublicationAuthoritySnapshotV1,
  createPipelineBuildPublicationAuthorityV1, derivePipelineBuildPublicationAuthorityKeyV1,
  derivePipelineBuildPublicationEvidenceKeyV1,
  verifyPipelineBuildPublicationAuthoritySnapshotV1 } from "./build-publication-authority";
import type { CodexBuildStagePublicationCompositionV1 } from "../../harness/codex-v1/delivery-bound-workspace-preparation";

type TemplateRow = { id: string; project_id: string; name: string; description: string; stages: unknown;
  max_stages: number; max_total_loops: number; may_advance_unattended: boolean; max_duration_seconds: number;
  record_digest: string; auth_tag: string; version: number; created_at: string | Date; updated_at: string | Date };
type RunRow = { id: string; project_id: string; request_id: string; template_id: string; template_version: number;
  template_digest: string; workflow_id: string; title: string; state: "proposed" | "active" | "paused" | "succeeded" | "failed" | "cancelled";
  started_at: string | Date | null; updated_at: string | Date; completed_at: string | Date | null;
  current_stage_ordinal: number | null; unattended: boolean; record_digest: string; auth_tag: string; version: number };
type StageRow = { stage_ordinal: number; stage_kind: "build" | "check" | "signoff"; role: "builder" | "checker" | "validator";
  project_id: string; pipeline_run_id: string; current_job_id: string; worker_id: string;
  worker_kind: "codex" | "claude-code" | "hermes"; node_id: string; selection_key: string; model: string;
  effort: "default" | "low" | "medium" | "high" | "xhigh" | "max"; provider: string | null; profile: string | null;
  current_attempt_id: string | null; current_lease_id: string | null; state: string; max_loops: number;
  allowed_paths: unknown | null; maximum_changed_files: number | null; maximum_changed_bytes: number | null;
  handoff_from_result_digest: string | null; signoff_review_id: string | null; started_at: string | Date | null;
  finished_at: string | Date | null; record_digest: string; auth_tag: string; version: number };
type BuildPublicationRow = { project_id: string; pipeline_run_id: string; stage_ordinal: number; job_id: string;
  attempt_id: string; harness_run_id: string; artifact_id: string; result_revision: number;
  delivery_digest: string; retained_result_digest: string;
  plan_digest: string; evidence_digest: string; evidence: unknown; auth_tag: string; recorded_at: string | Date;
  artifact_content_hash: string; canonical_result_digest: string; source_job_id: string; worker_id: string; node_id: string };

function joined(tx: DatabaseSession): DatabaseClient {
  return Object.freeze({ query: tx.query.bind(tx), transaction: async <T>(work: (session: DatabaseSession) => Promise<T>) => work(tx),
    transactionWithPreCommitCheck: async <T>(work: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => {
      const value = await work(tx); await check(); return value;
    } });
}
const iso = (value: string | Date) => new Date(value).toISOString();
const same = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b); };

export interface CanonicalPipelineRepositoryRegistryV1 {
  resolve(tx: DatabaseSession, scope: Readonly<{ tenantId: string; workspaceId: string; projectId: string }>):
    Promise<Readonly<{ repositoryUrl: string }> | undefined>;
}

type InstalledBuildPublicationPortsV1 = Pick<CodexBuildStagePublicationCompositionV1,
  "runGit" | "journal" | "openPullRequest">;

export class LinearPipelineServiceV1 {
  readonly #key: Uint8Array;
  readonly #publicationAuthorityKey: Uint8Array;
  readonly #publicationEvidenceKey: Uint8Array;
  readonly #authority: WebSessionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    integrityKey: Uint8Array, private readonly selection?: WorkBatchQueueAdmissionAuthorityV1,
    private readonly clock: () => number = Date.now,
    private readonly repositories?: CanonicalPipelineRepositoryRegistryV1) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("pipeline_configuration_invalid");
    this.#key = Uint8Array.from(integrityKey);
    this.#publicationAuthorityKey = derivePipelineBuildPublicationAuthorityKeyV1(this.#key);
    this.#publicationEvidenceKey = derivePipelineBuildPublicationEvidenceKeyV1(this.#key);
    this.#authority = new WebSessionAuthority(db, scope, clock, "pipeline");
  }

  async createBuildPublicationAuthority(deliveryValue: unknown) {
    if (!this.selection?.acceptedResultProof || !this.repositories) throw new Error("pipeline_build_publication_unavailable");
    const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue), identity = delivery.identity;
    if (identity.tenantId !== this.scope.tenantId) throw new Error("pipeline_build_publication_unavailable");
    return this.db.transaction(async tx => {
      const row = (await tx.query<StageRow & { run_title: string }>(`SELECT stage.project_id,stage.pipeline_run_id,
        stage.stage_ordinal,stage.stage_kind,stage.role,stage.current_job_id,stage.worker_id,stage.worker_kind,stage.node_id,
        stage.selection_key,stage.model,stage.effort,stage.provider,stage.profile,stage.current_attempt_id,stage.current_lease_id,
        stage.state,stage.max_loops,stage.allowed_paths,stage.maximum_changed_files,stage.maximum_changed_bytes,
        stage.handoff_from_result_digest,stage.signoff_review_id,stage.started_at,stage.finished_at,stage.record_digest,
        stage.auth_tag,stage.version,run.title AS run_title FROM pipeline_stage_runs stage
        JOIN pipeline_runs run ON run.tenant_id=stage.tenant_id AND run.id=stage.pipeline_run_id
        JOIN control_task_execution_plans execution ON execution.tenant_id=stage.tenant_id
          AND execution.project_id=stage.project_id AND execution.source_job_id=stage.current_job_id
        JOIN control_harness_runs harness ON harness.tenant_id=stage.tenant_id AND harness.job_id=execution.job_id
        JOIN control_attempts attempt ON attempt.tenant_id=harness.tenant_id AND attempt.id=harness.attempt_id
          AND attempt.job_id=harness.job_id AND attempt.node_id=stage.node_id AND attempt.worker_id=stage.worker_id
        JOIN control_task_model_selections selected ON selected.tenant_id=stage.tenant_id
          AND selected.project_id=stage.project_id AND selected.job_id=execution.job_id
          AND selected.worker_kind=stage.worker_kind AND selected.selection_key=stage.selection_key
          AND selected.model=stage.model AND selected.effort=stage.effort
          AND selected.provider IS NOT DISTINCT FROM stage.provider AND selected.profile IS NOT DISTINCT FROM stage.profile
        WHERE stage.tenant_id=$1 AND stage.project_id=$2 AND execution.job_id=$3 AND harness.id=$4
          AND harness.attempt_id=$5 AND harness.node_id=$6 AND stage.stage_kind='build' AND stage.role='builder' FOR SHARE`,
      [this.scope.tenantId, identity.projectId, identity.jobId, identity.runId, identity.attemptId, identity.nodeId])).rows[0];
      if (!row || row.worker_id !== delivery.worker.workerId || row.node_id !== identity.nodeId) throw new Error("pipeline_build_publication_unavailable");
      this.#verifyStage(row);
      const policy = pipelineBuildWritePolicySchemaV1.safeParse({ allowedPaths: row.allowed_paths,
        maximumChangedFiles: row.maximum_changed_files, maximumChangedBytes: row.maximum_changed_bytes });
      if (!policy.success) throw new Error("pipeline_build_publication_unavailable");
      const proof = await this.selection!.acceptedResultProof!(tx, { sourceJobId: row.current_job_id,
        workerId: row.worker_id, nodeId: row.node_id });
      const repository = await this.repositories!.resolve(tx, { ...this.scope, projectId: row.project_id });
      if (!proof || !repository) throw new Error("pipeline_build_publication_unavailable");
      if (proof.executionJobId !== identity.jobId || proof.attemptId !== identity.attemptId
        || proof.harnessRunId !== identity.runId
        || row.current_attempt_id !== null && row.current_attempt_id !== identity.attemptId)
        throw new Error("pipeline_build_publication_unavailable");
      return createPipelineBuildPublicationAuthoritySnapshotV1(this.#publicationAuthorityKey, {
        schema: "control-room.pipeline-build-publication-authority/v1", deliveryDigest: delivery.deliveryDigest,
        tenantId: this.scope.tenantId, projectId: row.project_id, sourceJobId: row.current_job_id,
        executionJobId: identity.jobId, attemptId: identity.attemptId, runId: identity.runId,
        artifactId: proof.artifactId, resultRevision: proof.revision,
        pipelineRunId: row.pipeline_run_id, stageOrdinal: Number(row.stage_ordinal), stageRecordDigest: row.record_digest,
        workerId: row.worker_id, model: row.model, effort: row.effort,
        ...policy.data, retainedResultDigest: proof.contentHash,
        repositoryUrl: repository.repositoryUrl, title: row.run_title,
        body: `Automated build-stage proposal for ${row.pipeline_run_id}, stage ${Number(row.stage_ordinal)}.`,
      });
    });
  }

  /** Trusted controller-side assembly. Callers supply only node-owned effects;
   * canonical authority/currentness/retention and the integrity key remain
   * closed over by this service. */
  async createInstalledBuildPublication(delivery: unknown,
    ports: InstalledBuildPublicationPortsV1): Promise<CodexBuildStagePublicationCompositionV1> {
    const snapshot = await this.createBuildPublicationAuthority(delivery);
    const authority = createPipelineBuildPublicationAuthorityV1({ integrityKey: this.#publicationAuthorityKey, snapshot,
      assertControllerCurrent: value => this.assertBuildPublicationAuthorityCurrent(value) });
    return Object.freeze({ integrityKey: Uint8Array.from(this.#publicationEvidenceKey), authority,
      runGit: ports.runGit, journal: ports.journal, openPullRequest: ports.openPullRequest,
      retainPublished: input => this.retainBuildPublication({ snapshot, ...input }).then(() => undefined) });
  }

  async assertBuildPublicationAuthorityCurrent(snapshotValue: unknown): Promise<void> {
    if (!this.selection?.acceptedResultProof || !this.repositories) throw new Error("pipeline_build_publication_unavailable");
    const snapshot = verifyPipelineBuildPublicationAuthoritySnapshotV1(this.#publicationAuthorityKey, snapshotValue);
    if (snapshot.tenantId !== this.scope.tenantId) throw new Error("pipeline_build_publication_unavailable");
    await this.db.transaction(async tx => {
      const row = (await tx.query<StageRow & { run_title: string }>(`SELECT stage.project_id,stage.pipeline_run_id,
        stage.stage_ordinal,stage.stage_kind,stage.role,stage.current_job_id,stage.worker_id,stage.worker_kind,stage.node_id,
        stage.selection_key,stage.model,stage.effort,stage.provider,stage.profile,stage.current_attempt_id,stage.current_lease_id,
        stage.state,stage.max_loops,stage.allowed_paths,stage.maximum_changed_files,stage.maximum_changed_bytes,
        stage.handoff_from_result_digest,stage.signoff_review_id,stage.started_at,stage.finished_at,stage.record_digest,
        stage.auth_tag,stage.version,run.title AS run_title FROM pipeline_stage_runs stage
        JOIN pipeline_runs run ON run.tenant_id=stage.tenant_id AND run.id=stage.pipeline_run_id
        JOIN control_task_execution_plans execution ON execution.tenant_id=stage.tenant_id
          AND execution.project_id=stage.project_id AND execution.source_job_id=stage.current_job_id
          AND execution.job_id=$4
        JOIN control_harness_runs harness ON harness.tenant_id=stage.tenant_id AND harness.job_id=execution.job_id
          AND harness.id=$6 AND harness.attempt_id=$5 AND harness.node_id=stage.node_id
        JOIN control_attempts attempt ON attempt.tenant_id=harness.tenant_id AND attempt.id=harness.attempt_id
          AND attempt.job_id=harness.job_id AND attempt.node_id=stage.node_id AND attempt.worker_id=stage.worker_id
        JOIN control_task_model_selections selected ON selected.tenant_id=stage.tenant_id
          AND selected.project_id=stage.project_id AND selected.job_id=execution.job_id
          AND selected.worker_kind=stage.worker_kind AND selected.selection_key=stage.selection_key
          AND selected.model=stage.model AND selected.effort=stage.effort
          AND selected.provider IS NOT DISTINCT FROM stage.provider AND selected.profile IS NOT DISTINCT FROM stage.profile
        WHERE stage.tenant_id=$1 AND stage.project_id=$2 AND stage.pipeline_run_id=$3
          AND stage.stage_ordinal=$7 AND stage.stage_kind='build' AND stage.role='builder' FOR SHARE`,
      [this.scope.tenantId, snapshot.projectId, snapshot.pipelineRunId, snapshot.executionJobId,
        snapshot.attemptId, snapshot.runId, snapshot.stageOrdinal])).rows[0];
      if (!row) throw new Error("pipeline_build_publication_unavailable");
      this.#verifyStage(row);
      const policy = pipelineBuildWritePolicySchemaV1.safeParse({ allowedPaths: row.allowed_paths,
        maximumChangedFiles: row.maximum_changed_files, maximumChangedBytes: row.maximum_changed_bytes });
      const proof = await this.selection!.acceptedResultProof!(tx, { sourceJobId: row.current_job_id,
        workerId: row.worker_id, nodeId: row.node_id });
      const repository = await this.repositories!.resolve(tx, { ...this.scope, projectId: row.project_id });
      const body = `Automated build-stage proposal for ${row.pipeline_run_id}, stage ${Number(row.stage_ordinal)}.`;
      if (!policy.success || row.record_digest !== snapshot.stageRecordDigest || row.current_job_id !== snapshot.sourceJobId
        || row.worker_id !== snapshot.workerId || row.model !== snapshot.model || row.effort !== snapshot.effort
        || policy.data.allowedPaths.length !== snapshot.allowedPaths.length
        || policy.data.allowedPaths.some((path, index) => path !== snapshot.allowedPaths[index])
        || policy.data.maximumChangedFiles !== snapshot.maximumChangedFiles
        || policy.data.maximumChangedBytes !== snapshot.maximumChangedBytes
        || proof?.executionJobId !== snapshot.executionJobId || proof?.attemptId !== snapshot.attemptId
        || proof?.harnessRunId !== snapshot.runId || proof?.artifactId !== snapshot.artifactId
        || proof?.revision !== snapshot.resultRevision || proof?.contentHash !== snapshot.retainedResultDigest
        || row.current_attempt_id !== null && row.current_attempt_id !== snapshot.attemptId
        || repository?.repositoryUrl !== snapshot.repositoryUrl
        || row.run_title !== snapshot.title || body !== snapshot.body) throw new Error("pipeline_build_publication_unavailable");
    });
  }

  async retainBuildPublication(input: Readonly<{ snapshot: unknown; plan: unknown; evidence: unknown }>) {
    if (!this.selection?.acceptedResultProof || !this.repositories) throw new Error("pipeline_build_publication_unavailable");
    const snapshot = verifyPipelineBuildPublicationAuthoritySnapshotV1(this.#publicationAuthorityKey, input.snapshot);
    const evidence = verifyPullRequestPublicationEvidenceV1(input.evidence, input.plan, this.#publicationEvidenceKey);
    const plan = input.plan as { authoritySnapshotDigest?: string; repositoryUrl?: string };
    if (snapshot.tenantId !== this.scope.tenantId || evidence.deliveryDigest !== snapshot.deliveryDigest
      || evidence.retainedResultDigest !== snapshot.retainedResultDigest
      || plan.authoritySnapshotDigest !== snapshot.snapshotDigest || plan.repositoryUrl !== snapshot.repositoryUrl)
      throw new Error("pipeline_build_publication_unavailable");
    return this.db.transaction(async tx => {
      const stage = (await tx.query<StageRow>(`SELECT project_id,pipeline_run_id,stage_ordinal,stage_kind,role,current_job_id,
        worker_id,worker_kind,node_id,selection_key,model,effort,provider,profile,current_attempt_id,current_lease_id,state,max_loops,
        allowed_paths,maximum_changed_files,maximum_changed_bytes,handoff_from_result_digest,signoff_review_id,started_at,finished_at,
        record_digest,auth_tag,version FROM pipeline_stage_runs stage
        WHERE stage.tenant_id=$1 AND stage.project_id=$2 AND stage.pipeline_run_id=$3
          AND stage.stage_ordinal=$4 AND stage.stage_kind='build'
          AND EXISTS (SELECT 1 FROM control_task_model_selections selected WHERE selected.tenant_id=stage.tenant_id
            AND selected.project_id=stage.project_id AND selected.job_id=$5
            AND selected.worker_kind=stage.worker_kind AND selected.selection_key=stage.selection_key
            AND selected.model=stage.model AND selected.effort=stage.effort
            AND selected.provider IS NOT DISTINCT FROM stage.provider AND selected.profile IS NOT DISTINCT FROM stage.profile)
          FOR SHARE OF stage`,
      [this.scope.tenantId, snapshot.projectId, snapshot.pipelineRunId, snapshot.stageOrdinal,
        snapshot.executionJobId])).rows[0];
      if (!stage) throw new Error("pipeline_build_publication_unavailable");
      this.#verifyStage(stage);
      const proof = await this.selection!.acceptedResultProof!(tx, { sourceJobId: stage.current_job_id,
        workerId: stage.worker_id, nodeId: stage.node_id });
      const repository = await this.repositories!.resolve(tx, { ...this.scope, projectId: stage.project_id });
      if (stage.record_digest !== snapshot.stageRecordDigest || stage.current_job_id !== snapshot.sourceJobId
        || stage.worker_id !== snapshot.workerId || stage.model !== snapshot.model || stage.effort !== snapshot.effort
        || !proof || proof.executionJobId !== snapshot.executionJobId || proof.attemptId !== snapshot.attemptId
        || proof.harnessRunId !== snapshot.runId || proof.artifactId !== snapshot.artifactId
        || proof.revision !== snapshot.resultRevision || proof.contentHash !== snapshot.retainedResultDigest
        || stage.current_attempt_id !== null && stage.current_attempt_id !== snapshot.attemptId
        || repository?.repositoryUrl !== snapshot.repositoryUrl) throw new Error("pipeline_build_publication_unavailable");
      const record = { tenantId: this.scope.tenantId, projectId: snapshot.projectId,
        pipelineRunId: snapshot.pipelineRunId, stageOrdinal: snapshot.stageOrdinal, jobId: snapshot.executionJobId,
        attemptId: snapshot.attemptId, harnessRunId: snapshot.runId, artifactId: snapshot.artifactId,
        resultRevision: snapshot.resultRevision, deliveryDigest: snapshot.deliveryDigest,
        retainedResultDigest: snapshot.retainedResultDigest, planDigest: evidence.planDigest,
        evidenceDigest: evidence.evidenceDigest, evidence, recordedAt: new Date(this.clock()).toISOString() };
      const authTag = hmacSha256Tag(this.#publicationAuthorityKey, { purpose: "pipeline-build-publication-record/v1", record });
      const inserted = await tx.query(`INSERT INTO control_pipeline_build_publications(tenant_id,project_id,pipeline_run_id,
        stage_ordinal,job_id,attempt_id,harness_run_id,artifact_id,result_revision,delivery_digest,retained_result_digest,
        plan_digest,evidence_digest,evidence,auth_tag,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
        ON CONFLICT (tenant_id,pipeline_run_id,stage_ordinal) DO NOTHING RETURNING evidence_digest`,
      [record.tenantId, record.projectId, record.pipelineRunId, record.stageOrdinal, record.jobId, record.attemptId,
        record.harnessRunId, record.artifactId, record.resultRevision, record.deliveryDigest, record.retainedResultDigest,
        record.planDigest, record.evidenceDigest, JSON.stringify(evidence), authTag, record.recordedAt]);
      if (!inserted.rows.length) {
        const prior = (await tx.query<{ evidence_digest: string }>(`SELECT evidence_digest FROM control_pipeline_build_publications
          WHERE tenant_id=$1 AND pipeline_run_id=$2 AND stage_ordinal=$3`,
        [record.tenantId, record.pipelineRunId, record.stageOrdinal])).rows[0];
        if (prior?.evidence_digest !== evidence.evidenceDigest) throw new Error("pipeline_build_publication_conflict");
      }
      return Object.freeze({ evidenceDigest: evidence.evidenceDigest, replayed: !inserted.rows.length });
    });
  }

  async readRetainedBuildPublication(deliveryDigest: string) {
    return this.db.transaction(tx => this.#readBuildPublication(tx, deliveryDigest));
  }

  async #project(tx: DatabaseSession, projectId: string, active: boolean) {
    const row = (await tx.query<{ lifecycle: string }>(`SELECT h.lifecycle FROM projects p JOIN control_manual_project_heads h
      ON h.tenant_id=p.tenant_id AND h.project_id=p.id WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 FOR SHARE OF p,h`,
    [this.scope.tenantId, this.scope.workspaceId, projectId])).rows[0];
    if (!row) throw new WebAccessError("not_found");
    if (active && row.lifecycle !== "active") throw new WebAccessError("conflict");
    return row.lifecycle;
  }

  #templateMaterial(row: Omit<TemplateRow, "auth_tag">) {
    const raw = { name: row.name, description: row.description, stages: row.stages,
      maxTotalLoops: Number(row.max_total_loops), maxDurationSeconds: Number(row.max_duration_seconds) };
    const current = linearPipelineTemplateInputSchemaV1.safeParse(raw);
    const parsed = current.success ? current.data : legacyLinearPipelineTemplateInputSchemaV1.parse(raw);
    return { id: row.id, tenantId: this.scope.tenantId, projectId: row.project_id, name: row.name,
      description: row.description, stages: parsed.stages,
      maxStages: Number(row.max_stages), maxTotalLoops: Number(row.max_total_loops), mayAdvanceUnattended: false,
      maxDurationSeconds: Number(row.max_duration_seconds), version: Number(row.version),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }
  #verifyTemplate(row: TemplateRow) {
    const raw = { name: row.name, description: row.description, stages: row.stages,
      maxTotalLoops: Number(row.max_total_loops), maxDurationSeconds: Number(row.max_duration_seconds) };
    const current = linearPipelineTemplateInputSchemaV1.safeParse(raw);
    const value = current.success ? current.data : legacyLinearPipelineTemplateInputSchemaV1.parse(raw);
    const material = this.#templateMaterial(row);
    if (sha256Digest(material) !== row.record_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "pipeline-template/v1", record: material }), row.auth_tag))
      throw new Error("pipeline_integrity_failed");
    return value;
  }
  #runMaterial(row: RunRow) {
    return { id: row.id, tenantId: this.scope.tenantId, projectId: row.project_id, requestId: row.request_id,
      templateId: row.template_id, templateVersion: Number(row.template_version), templateDigest: row.template_digest,
      workflowId: row.workflow_id, title: row.title, state: row.state, startedAt: row.started_at ? iso(row.started_at) : null,
      updatedAt: iso(row.updated_at), completedAt: row.completed_at ? iso(row.completed_at) : null,
      currentStageOrdinal: row.current_stage_ordinal === null ? null : Number(row.current_stage_ordinal),
      unattended: row.unattended, version: Number(row.version) };
  }
  #verifyRun(row: RunRow) {
    const material = this.#runMaterial(row);
    if (sha256Digest(material) !== row.record_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "pipeline-run/v1", record: material }), row.auth_tag))
      throw new Error("pipeline_integrity_failed");
  }
  #stageMaterial(row: StageRow) {
    const policy = row.stage_kind === "build" && row.allowed_paths !== null
      ? pipelineBuildWritePolicySchemaV1.parse({ allowedPaths: row.allowed_paths,
        maximumChangedFiles: row.maximum_changed_files, maximumChangedBytes: row.maximum_changed_bytes }) : null;
    return { id: `${row.pipeline_run_id}:stage:${Number(row.stage_ordinal)}`, tenantId: this.scope.tenantId,
      projectId: row.project_id, pipelineRunId: row.pipeline_run_id, stageOrdinal: Number(row.stage_ordinal),
      stageKind: row.stage_kind, role: row.role, workerId: row.worker_id, workerKind: row.worker_kind,
      nodeId: row.node_id, selectionKey: row.selection_key, model: row.model, effort: row.effort,
      provider: row.provider, profile: row.profile, currentJobId: row.current_job_id,
      currentAttemptId: row.current_attempt_id, currentLeaseId: row.current_lease_id, state: row.state,
      maxLoops: Number(row.max_loops), handoffFromResultDigest: row.handoff_from_result_digest,
      allowedPaths: policy ? [...policy.allowedPaths] : null,
      maximumChangedFiles: policy?.maximumChangedFiles ?? null,
      maximumChangedBytes: policy?.maximumChangedBytes ?? null,
      signoffReviewId: row.signoff_review_id, startedAt: row.started_at ? iso(row.started_at) : null,
      finishedAt: row.finished_at ? iso(row.finished_at) : null, version: Number(row.version) };
  }
  #verifyStage(row: StageRow) {
    const material = this.#stageMaterial(row);
    if (sha256Digest(material) === row.record_digest
      && same(hmacSha256Tag(this.#key, { purpose: "pipeline-stage-run/v1", record: material }), row.auth_tag)) return;
    const { allowedPaths: _paths, maximumChangedFiles: _files, maximumChangedBytes: _bytes, ...legacy } = material;
    if (row.allowed_paths !== null || row.maximum_changed_files !== null || row.maximum_changed_bytes !== null
      || sha256Digest(legacy) !== row.record_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "pipeline-stage-run/v1", record: legacy }), row.auth_tag))
      throw new Error("pipeline_integrity_failed");
  }
  async #readBuildPublication(tx: DatabaseSession, deliveryDigest: string) {
    if (!/^sha256:[a-f0-9]{64}$/.test(deliveryDigest)) throw new Error("pipeline_build_publication_unavailable");
    const row = (await tx.query<BuildPublicationRow>(`SELECT publication.project_id,publication.pipeline_run_id,
      publication.stage_ordinal,publication.job_id,publication.attempt_id,publication.harness_run_id,
      publication.artifact_id,publication.result_revision,
      publication.delivery_digest,publication.retained_result_digest,publication.plan_digest,publication.evidence_digest,
      publication.evidence,publication.auth_tag,publication.recorded_at,artifact.artifact_id,
      manifest.content_hash AS artifact_content_hash,
      canonical.record_digest AS canonical_result_digest,stage.current_job_id AS source_job_id,
      stage.worker_id,stage.node_id FROM control_pipeline_build_publications publication
      JOIN pipeline_stage_runs stage ON stage.tenant_id=publication.tenant_id
        AND stage.pipeline_run_id=publication.pipeline_run_id AND stage.stage_ordinal=publication.stage_ordinal
      JOIN control_native_artifact_receipts artifact ON artifact.tenant_id=publication.tenant_id
        AND artifact.run_id=publication.harness_run_id AND artifact.project_id=publication.project_id
        AND artifact.job_id=publication.job_id AND artifact.attempt_id=publication.attempt_id
        AND artifact.artifact_id=publication.artifact_id
      JOIN control_artifact_manifests manifest ON manifest.tenant_id=artifact.tenant_id AND manifest.id=artifact.artifact_id
        AND manifest.content_hash=publication.retained_result_digest AND manifest.state='verified'
      JOIN control_codex_result_publications canonical ON canonical.tenant_id=publication.tenant_id
        AND canonical.run_id=publication.harness_run_id AND canonical.project_id=publication.project_id
        AND canonical.job_id=publication.job_id AND canonical.attempt_id=publication.attempt_id
      WHERE publication.tenant_id=$1 AND publication.delivery_digest=$2`,
    [this.scope.tenantId, deliveryDigest])).rows[0];
    if (!row || !this.selection?.acceptedResultProof || row.artifact_content_hash !== row.retained_result_digest
      || !/^sha256:[a-f0-9]{64}$/.test(row.canonical_result_digest)) return undefined;
    const stage = (await tx.query<StageRow>(`SELECT project_id,pipeline_run_id,stage_ordinal,stage_kind,role,current_job_id,
      worker_id,worker_kind,node_id,selection_key,model,effort,provider,profile,current_attempt_id,current_lease_id,state,max_loops,
      allowed_paths,maximum_changed_files,maximum_changed_bytes,handoff_from_result_digest,signoff_review_id,started_at,finished_at,
      record_digest,auth_tag,version FROM pipeline_stage_runs WHERE tenant_id=$1 AND pipeline_run_id=$2 AND stage_ordinal=$3`,
    [this.scope.tenantId, row.pipeline_run_id, Number(row.stage_ordinal)])).rows[0];
    if (!stage) return undefined;
    this.#verifyStage(stage);
    if (stage.current_job_id !== row.source_job_id || stage.worker_id !== row.worker_id || stage.node_id !== row.node_id)
      throw new Error("pipeline_build_publication_integrity_failed");
    const proof = await this.selection.acceptedResultProof(tx, { sourceJobId: row.source_job_id,
      workerId: row.worker_id, nodeId: row.node_id });
    if (proof?.executionJobId !== row.job_id || proof?.attemptId !== row.attempt_id
      || proof?.harnessRunId !== row.harness_run_id || proof?.artifactId !== row.artifact_id
      || proof?.revision !== Number(row.result_revision)
      || proof?.contentHash !== row.retained_result_digest) return undefined;
    const evidence = verifyStoredPullRequestPublicationEvidenceV1(row.evidence, this.#publicationEvidenceKey);
    const record = { tenantId: this.scope.tenantId, projectId: row.project_id, pipelineRunId: row.pipeline_run_id,
      stageOrdinal: Number(row.stage_ordinal), jobId: row.job_id, attemptId: row.attempt_id,
      harnessRunId: row.harness_run_id, artifactId: row.artifact_id,
      resultRevision: Number(row.result_revision), deliveryDigest: row.delivery_digest,
      retainedResultDigest: row.retained_result_digest, planDigest: row.plan_digest,
      evidenceDigest: row.evidence_digest, evidence, recordedAt: iso(row.recorded_at) };
    if (evidence.evidenceDigest !== row.evidence_digest || evidence.planDigest !== row.plan_digest
      || evidence.deliveryDigest !== row.delivery_digest || evidence.retainedResultDigest !== row.retained_result_digest
      || !same(row.auth_tag, hmacSha256Tag(this.#publicationAuthorityKey, { purpose: "pipeline-build-publication-record/v1", record })))
      throw new Error("pipeline_build_publication_integrity_failed");
    return Object.freeze({ url: evidence.url, commitDigest: evidence.commitDigest,
      modelSelection: evidence.modelSelection, usage: evidence.usage, evidenceDigest: evidence.evidenceDigest });
  }
  async #assertSelection(stage: PipelineStageTemplateV1) {
    if (!this.selection) throw new WebAccessError("conflict");
    const selected: WorkBatchQueueAdmissionSelectionV1 = { workerId: stage.workerId, workerKind: stage.workerKind,
      nodeId: stage.nodeId, selectionKey: stage.selectionKey, model: stage.model, effort: stage.effort,
      provider: stage.provider, profile: stage.profile };
    try { if (await this.selection.assertCurrent(selected) !== true) throw new Error(); }
    catch { throw new WebAccessError("conflict"); }
  }

  async createTemplate(identity: VerifiedWebIdentity, projectId: string, value: unknown) {
    const parsed = linearPipelineTemplateInputSchemaV1.safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data); } catch { throw new WebAccessError("invalid_request"); }
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.propose", projectId, true); await this.#project(tx, projectId, true);
      // Selection policy is protected state.  Check authorization first so an
      // unprivileged caller cannot use template validation as a policy oracle.
      for (const stage of parsed.data.stages) await this.#assertSelection(stage);
      const id = `pipeline-template:${randomUUID()}`, now = actor.now;
      const partial: Omit<TemplateRow, "auth_tag"> = { id, project_id: projectId, name: parsed.data.name,
        description: parsed.data.description, stages: parsed.data.stages, max_stages: 3,
        max_total_loops: parsed.data.maxTotalLoops, may_advance_unattended: false,
        max_duration_seconds: parsed.data.maxDurationSeconds, record_digest: "", version: 1, created_at: now, updated_at: now };
      const material = this.#templateMaterial(partial), recordDigest = sha256Digest(material);
      const authTag = hmacSha256Tag(this.#key, { purpose: "pipeline-template/v1", record: material });
      await tx.query(`INSERT INTO pipeline_templates(id,tenant_id,project_id,name,description,stages,max_stages,max_total_loops,
        may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,3,$7,false,$8,$9,$10,1,$11,$11)`,
      [id, this.scope.tenantId, projectId, parsed.data.name, parsed.data.description, JSON.stringify(parsed.data.stages),
        parsed.data.maxTotalLoops, parsed.data.maxDurationSeconds, recordDigest, authTag, now]);
      await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, projectId, actorId: actor.id, actorType: "human",
        action: "pipelines.template.create", targetType: "pipeline_template", targetId: id,
        idempotencyKey: `pipeline-template:${recordDigest}`, occurredAt: now, safeMetadata: { recordDigest, startsWork: false } });
      return pipelineTemplateReceiptSchemaV1.parse({ templateId: id, projectId, version: 1,
        templateDigest: recordDigest, createdAt: now, startsWork: false, grantsExecutionAuthority: false });
    });
  }

  async instantiate(identity: VerifiedWebIdentity, projectId: string, value: unknown, idempotencyKey: string) {
    const parsed = instantiateLinearPipelineSchemaV1.safeParse(value);
    if (!parsed.success || !/^[A-Za-z0-9:_-]{12,180}$/.test(idempotencyKey)) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data); } catch { throw new WebAccessError("invalid_request"); }
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.propose", projectId, true); await this.#project(tx, projectId, true);
      const template = (await tx.query<TemplateRow>(`SELECT id,project_id,name,description,stages,max_stages,max_total_loops,
        may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at
        FROM pipeline_templates WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR SHARE`,
      [this.scope.tenantId, projectId, parsed.data.templateId])).rows[0];
      if (!template) throw new WebAccessError("not_found");
      const definition = this.#verifyTemplate(template);
      const currentDefinition = linearPipelineTemplateInputSchemaV1.safeParse(definition);
      if (!currentDefinition.success) throw new WebAccessError("conflict");
      const boundedDefinition: LinearPipelineTemplateInputV1 = currentDefinition.data;
      for (const stage of boundedDefinition.stages) await this.#assertSelection(stage);
      const requestDigest = sha256Digest({ schema: "control-room.pipeline-instantiation/v1", tenantId: this.scope.tenantId,
        projectId, title: parsed.data.title, templateId: template.id, templateVersion: Number(template.version),
        templateDigest: template.record_digest, stages: boundedDefinition.stages });
      const operation = "pipeline-runs.instantiate/v1";
      const inserted = await tx.query(`INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,request_digest,status)
        VALUES($1,$2,$3,$4,'processing') ON CONFLICT DO NOTHING RETURNING idempotency_key`,
      [this.scope.tenantId, operation, idempotencyKey, requestDigest]);
      if (!inserted.rows.length) {
        const prior = (await tx.query<{ request_digest: string; status: string; result: unknown }>(`SELECT request_digest,status,result
          FROM control_idempotency WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3 FOR UPDATE`,
        [this.scope.tenantId, operation, idempotencyKey])).rows[0];
        if (!prior || prior.request_digest !== requestDigest || prior.status !== "completed") throw new WebAccessError("conflict");
        const receipt = pipelineRunReceiptSchemaV1.parse(prior.result);
        return pipelineRunReceiptSchemaV1.parse({ ...receipt, replayed: true });
      }
      const suffix = randomUUID(), runId = `pipeline-run:${suffix}`, requestId = `request:pipeline:${suffix}`,
        workflowId = `workflow:pipeline:${suffix}`, now = actor.now;
      const jobIds = boundedDefinition.stages.map(stage => `job:pipeline:${suffix}:${stage.ordinal}`);
      const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: this.scope.tenantId, version: 0,
        createdAt: now, updatedAt: now } as const;
      const request: RequestRecord = { ...common, kind: "request", id: requestId, projectId, title: parsed.data.title,
        objective: boundedDefinition.description, state: "draft", priority: 50, requestedBy: { actorId: actor.id, actorType: "human" },
        idempotencyKey: `pipeline:${sha256Digest({ projectId, idempotencyKey }).slice(7, 39)}` };
      const workflow: WorkflowRecord = { ...common, kind: "workflow", id: workflowId, requestId, projectId,
        definitionVersion: "linear-pipeline/v1", definitionDigest: template.record_digest,
        authorityMode: "control_room_native", state: "proposed", jobIds };
      const canonical = new CanonicalStore(joined(tx));
      await canonical.create(request); await canonical.create(workflow);
      const runMaterial = { id: runId, tenantId: this.scope.tenantId, projectId, requestId,
        templateId: template.id, templateVersion: Number(template.version), templateDigest: template.record_digest,
        workflowId, title: parsed.data.title, state: "proposed", startedAt: null, updatedAt: now,
        completedAt: null, currentStageOrdinal: 0, unattended: false, version: 1 };
      const runDigest = sha256Digest(runMaterial), runTag = hmacSha256Tag(this.#key, { purpose: "pipeline-run/v1", record: runMaterial });
      await tx.query(`INSERT INTO pipeline_runs(id,tenant_id,project_id,request_id,template_id,template_version,template_digest,
        workflow_id,title,state,started_at,updated_at,completed_at,current_stage_ordinal,unattended,record_digest,auth_tag,version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'proposed',NULL,$10,NULL,0,false,$11,$12,1)`,
      [runId, this.scope.tenantId, projectId, requestId, template.id, Number(template.version), template.record_digest,
        workflowId, parsed.data.title, now, runDigest, runTag]);
      for (const stage of boundedDefinition.stages) {
        const authority: AuthorityEnvelope = { projectId, allowedExecutor: "executor:unassigned", allowedOperations: ["task.propose"],
          credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none",
          maxRisk: "low", maxDurationSeconds: Math.min(boundedDefinition.maxDurationSeconds, 86400), maxConcurrentEffects: 0,
          expiresAt: new Date(Date.parse(now) + Math.min(boundedDefinition.maxDurationSeconds, 86400) * 1000).toISOString(), digest: "" };
        authority.digest = computeAuthorityDigest(authority);
        // The canonical domain currently stores task instructions on the one
        // request shared by this workflow.  Stage-specific intent remains in
        // the authenticated template/stage projection; the ordinary proposal
        // digest must match the existing planner's request-derived draft.
        const instructions = boundedDefinition.description;
        const job: JobRecord = { ...common, kind: "job", id: jobIds[stage.ordinal]!, workflowId, projectId,
          jobType: "task.proposal", specVersion: "1.0.0", inputDigest: sha256Digest({ title: parsed.data.title, instructions }),
          state: "proposed", priority: 50, requiredCapability: stage.requiredCapability,
          dependsOnJobIds: stage.ordinal ? [jobIds[stage.ordinal - 1]!] : [], authority,
          retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } };
        await canonical.create(job);
        await tx.query(`UPDATE control_jobs SET stage_kind=$1,stage_ordinal=$2,pipeline_run_id=$3
          WHERE tenant_id=$4 AND id=$5`, [stage.stageKind, stage.ordinal, runId, this.scope.tenantId, job.id]);
        await tx.query(`INSERT INTO control_task_model_selections(tenant_id,project_id,job_id,worker_kind,selection_key,model,effort,
          provider,profile,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [this.scope.tenantId, projectId, job.id, stage.workerKind, stage.selectionKey, stage.model, stage.effort,
          stage.provider, stage.profile, now]);
        await tx.query(`INSERT INTO control_task_declared_scopes(tenant_id,project_id,job_id,scope_kind,path,path_fold)
          VALUES($1,$2,$3,'tree','','')`, [this.scope.tenantId, projectId, job.id]);
        const stageId = `${runId}:stage:${stage.ordinal}`;
        const stageMaterial = { id: stageId, tenantId: this.scope.tenantId, projectId, pipelineRunId: runId,
          stageOrdinal: stage.ordinal, stageKind: stage.stageKind, role: stage.role, workerId: stage.workerId,
          workerKind: stage.workerKind, nodeId: stage.nodeId, selectionKey: stage.selectionKey, model: stage.model,
          effort: stage.effort, provider: stage.provider, profile: stage.profile,
          currentJobId: job.id, currentAttemptId: null, currentLeaseId: null,
          state: "proposed", maxLoops: stage.maxLoops, handoffFromResultDigest: null, signoffReviewId: null,
          allowedPaths: stage.stageKind === "build" ? [...stage.allowedPaths] : null,
          maximumChangedFiles: stage.stageKind === "build" ? stage.maximumChangedFiles : null,
          maximumChangedBytes: stage.stageKind === "build" ? stage.maximumChangedBytes : null,
          startedAt: null, finishedAt: null, version: 1 };
        const stageDigest = sha256Digest(stageMaterial), stageTag = hmacSha256Tag(this.#key,
          { purpose: "pipeline-stage-run/v1", record: stageMaterial });
        await tx.query(`INSERT INTO pipeline_stage_runs(id,tenant_id,project_id,pipeline_run_id,stage_ordinal,stage_kind,role,
          worker_id,worker_kind,node_id,selection_key,model,effort,provider,profile,current_job_id,current_attempt_id,current_lease_id,state,max_loops,
          allowed_paths,maximum_changed_files,maximum_changed_bytes,handoff_from_result_digest,signoff_review_id,started_at,finished_at,
          record_digest,auth_tag,version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL,NULL,'proposed',$17,$18::jsonb,$19,$20,
            NULL,NULL,NULL,NULL,$21,$22,1)`,
        [stageId, this.scope.tenantId, projectId, runId, stage.ordinal, stage.stageKind, stage.role, stage.workerId,
          stage.workerKind, stage.nodeId, stage.selectionKey, stage.model, stage.effort, stage.provider, stage.profile,
          job.id, stage.maxLoops, stage.stageKind === "build" ? JSON.stringify(stage.allowedPaths) : null,
          stage.stageKind === "build" ? stage.maximumChangedFiles : null,
          stage.stageKind === "build" ? stage.maximumChangedBytes : null, stageDigest, stageTag]);
      }
      await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, projectId, actorId: actor.id, actorType: "human",
        action: "pipelines.run.instantiate", targetType: "pipeline_run", targetId: runId, idempotencyKey,
        occurredAt: now, safeMetadata: { templateDigest: template.record_digest, stageCount: 3, startsWork: false } });
      const receipt = pipelineRunReceiptSchemaV1.parse({ runId, projectId, requestId, workflowId, jobIds,
        replayed: false, createdAt: now, startsWork: false, grantsExecutionAuthority: false });
      await tx.query(`UPDATE control_idempotency SET status='completed',result=$1::jsonb,completed_at=$2
        WHERE tenant_id=$3 AND operation_scope=$4 AND idempotency_key=$5 AND status='processing'`,
      [JSON.stringify(receipt), now, this.scope.tenantId, operation, idempotencyKey]);
      return receipt;
    });
  }

  async list(identity: VerifiedWebIdentity, projectId: string) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); await this.#project(tx, projectId, false);
      const rows = (await tx.query<RunRow>(`SELECT id,project_id,request_id,template_id,template_version,template_digest,
        workflow_id,title,state,started_at,updated_at,completed_at,current_stage_ordinal,unattended,record_digest,auth_tag,version
        FROM pipeline_runs WHERE tenant_id=$1 AND project_id=$2 ORDER BY updated_at DESC,id LIMIT 100`,
      [this.scope.tenantId, projectId])).rows;
      for (const row of rows) {
        this.#verifyRun(row);
        const template = (await tx.query<TemplateRow>(`SELECT id,project_id,name,description,stages,max_stages,max_total_loops,
          may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at
          FROM pipeline_templates WHERE tenant_id=$1 AND project_id=$2 AND id=$3`,
        [this.scope.tenantId, projectId, row.template_id])).rows[0];
        if (!template || template.record_digest !== row.template_digest || Number(template.version) !== Number(row.template_version))
          throw new Error("pipeline_integrity_failed");
        this.#verifyTemplate(template);
      }
      return pipelineRunPageSchemaV1.parse({ projectId, runs: rows.map(row => ({ runId: row.id, title: row.title,
        state: row.state, updatedAt: iso(row.updated_at) })), startsWork: false, grantsExecutionAuthority: false });
    });
  }

  async view(identity: VerifiedWebIdentity, projectId: string, runId: string) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); const lifecycle = await this.#project(tx, projectId, false);
      const run = (await tx.query<RunRow>(`SELECT id,project_id,request_id,template_id,template_version,template_digest,
        workflow_id,title,state,started_at,updated_at,completed_at,current_stage_ordinal,unattended,record_digest,auth_tag,version
        FROM pipeline_runs WHERE tenant_id=$1 AND project_id=$2 AND id=$3`, [this.scope.tenantId, projectId, runId])).rows[0];
      if (!run) throw new WebAccessError("not_found");
      this.#verifyRun(run);
      const template = (await tx.query<TemplateRow>(`SELECT id,project_id,name,description,stages,max_stages,max_total_loops,
        may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at
        FROM pipeline_templates WHERE tenant_id=$1 AND project_id=$2 AND id=$3`,
      [this.scope.tenantId, projectId, run.template_id])).rows[0];
      if (!template || template.record_digest !== run.template_digest || Number(template.version) !== Number(run.template_version))
        throw new Error("pipeline_integrity_failed");
      this.#verifyTemplate(template);
      const rows = (await tx.query<StageRow>(`SELECT project_id,pipeline_run_id,stage_ordinal,stage_kind,role,current_job_id,
        worker_id,worker_kind,node_id,selection_key,model,effort,provider,profile,current_attempt_id,current_lease_id,
        state,max_loops,allowed_paths,maximum_changed_files,maximum_changed_bytes,handoff_from_result_digest,signoff_review_id,
        started_at,finished_at,record_digest,auth_tag,version
        FROM pipeline_stage_runs WHERE tenant_id=$1 AND project_id=$2 AND pipeline_run_id=$3 ORDER BY stage_ordinal`,
      [this.scope.tenantId, projectId, runId])).rows;
      if (rows.length !== 3) throw new Error("pipeline_integrity_failed");
      const accepted: Array<{ ok: boolean; digest: string | null; round: number | null }> = [];
      const stages = [];
      for (const row of rows) {
        this.#verifyStage(row);
        let own = { ok: false, digest: null as string | null, round: null as number | null };
        if (this.selection) try {
          const selection = { sourceJobId: row.current_job_id, workerId: row.worker_id, nodeId: row.node_id };
          const proof = this.selection.acceptedResultProof
            ? await this.selection.acceptedResultProof(tx, selection) : null;
          own = { ok: proof !== null, digest: proof?.contentHash ?? null, round: proof?.revision ?? null };
        } catch { own = { ok: false, digest: null, round: null }; }
        const job = (await tx.query<{ state: string }>(`SELECT state FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3`,
        [this.scope.tenantId, projectId, row.current_job_id])).rows[0];
        const plan = (await tx.query<{ job_id: string }>(`SELECT job_id FROM control_task_execution_plans WHERE tenant_id=$1 AND source_job_id=$2`,
        [this.scope.tenantId, row.current_job_id])).rows[0];
        const attempt = plan ? (await tx.query<{ state: string }>(`SELECT state FROM control_attempts WHERE tenant_id=$1 AND job_id=$2
          ORDER BY attempt_number DESC LIMIT 1`, [this.scope.tenantId, plan.job_id])).rows[0] : undefined;
        let state: "waiting_dependency" | "eligible" | "assigned" | "running" | "completed" | "failed" | "paused" | "uncertain";
        if (lifecycle !== "active") state = "paused";
        else if (own.ok) state = "completed";
        else if (attempt?.state === "running") state = "running";
        else if (attempt && ["offered", "leased", "waiting"].includes(attempt.state)) state = "assigned";
        else if (attempt && ["failed", "cancelled", "orphaned"].includes(attempt.state)) state = "failed";
        else if (row.stage_ordinal > 0 && !accepted[row.stage_ordinal - 1]?.ok) state = "waiting_dependency";
        else if (!job || job.state !== "proposed") state = "uncertain";
        else state = "eligible";
        let pullRequestEvidence = null;
        if (row.stage_kind === "build") {
          const publication = (await tx.query<{ delivery_digest: string }>(`SELECT delivery_digest
            FROM control_pipeline_build_publications WHERE tenant_id=$1 AND pipeline_run_id=$2 AND stage_ordinal=$3`,
          [this.scope.tenantId, row.pipeline_run_id, Number(row.stage_ordinal)])).rows[0];
          if (publication) pullRequestEvidence = await this.#readBuildPublication(tx, publication.delivery_digest) ?? null;
        }
        stages.push({ ordinal: Number(row.stage_ordinal), stageKind: row.stage_kind, role: row.role,
          jobId: row.current_job_id, workerId: row.worker_id, nodeId: row.node_id, model: row.model, effort: row.effort,
          state, round: own.round, usage: "unknown" as const,
          writePolicy: row.stage_kind === "build" && row.allowed_paths !== null ? { allowedPaths: row.allowed_paths,
            maximumChangedFiles: Number(row.maximum_changed_files), maximumChangedBytes: Number(row.maximum_changed_bytes) } : null,
          pullRequestEvidence,
          predecessorResultDigest: row.stage_ordinal ? accepted[row.stage_ordinal - 1]?.digest ?? null : null,
          startsWork: false as const, grantsExecutionAuthority: false as const });
        accepted.push(own);
      }
      return pipelineRunViewSchemaV1.parse({ runId, projectId, title: run.title, state: run.state,
        stages, updatedAt: iso(run.updated_at), startsWork: false, grantsExecutionAuthority: false });
    });
  }
}
