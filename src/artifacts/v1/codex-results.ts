import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { appendAuditWith } from "../../audit/audit-store";
import { CompletionGateStoreV1 } from "../../completion-gate/v1/store";
import { completionAcceptanceProfileSchemaV1, completionReviewTargetSchemaV1 } from "../../completion-gate/v1/schemas";
import { stageAsyncCompletionCheckpoint } from "../../completion-gate/v1/async-staged-checkpoint";
import { DOMAIN_CONTRACT_VERSION, artifactManifestRecordSchema, attemptRecordSchema, jobRecordSchema,
  leaseRecordSchema, type ArtifactManifestRecord } from "../../domain/v1";
import { createCodexCanonicalResultRecordV1, codexCanonicalResultRecordSchemaV1,
  codexQualificationTrustSchemaV1, type CodexCanonicalResultRecordV1,
  type CodexQualificationTrustV1 } from "../../harness/codex-v1/canonical-result-record";
import { codexResultPublicationContractSchemaV1, type CodexResultPublicationContractV1 } from "../../harness/codex-v1/result-publication-contract";
import { terminalResultEvidenceSchemaV1, type CodexTerminalResultEvidenceV1 } from "../../harness/v1/terminal-result-evidence";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import type { HarnessRunV1 } from "../../harness/v1/types";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, computeAuthorityDigest, hmacSha256Tag, sha256Digest,
  type AwaitableRollbackCheckpointStoreV1 } from "../../security";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import { assertCanonicalCodexAdmissionInSession,
  readCodexActivationTransmissionIntentInSession } from "../../web/v1/codex-activation-transmission-intent";
import { readCodexTaskExecutionPlanV3InSession, type CodexTaskExecutionPlanV3 } from "../../web/v1/task-execution-planner";
import { checkedResultBytes, nativeResultId } from "./native-results";
import { codexResultReservationSchemaV1, commitCodexResultReservationMetadataV1,
  markCodexResultReservationStorageUncertainV1, reserveCodexResultWriteV1,
  verifyCodexResultReservationBytesV1, type CodexResultReservationV1 } from "./codex-result-reservation";

export const CODEX_CANONICAL_RUN_ADAPTER_ID = "codex-app-server:v1" as const;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
export const codexResultReceiptSchemaV1 = z.object({
  schema: z.literal("control-room.codex-result-receipt/v1"), artifactId: localId,
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId, nodeId: localId,
  publicationId: localId, publicationContractDigest: digestSchema, terminalEvidenceDigest: digestSchema,
  qualificationReceiptBodyDigest: digestSchema, qualificationSignerKeyId: localId,
  threadId: localId, turnId: localId, itemId: localId, projectionDigest: digestSchema,
  rawResultDigest: digestSchema, rawTurnDigest: digestSchema, contentHash: digestSchema,
  sizeBytes: z.number().int().min(1).max(65_536), manifestDigest: digestSchema, receivedAt: instant,
  byteCheck: z.literal("matched_recorded_claim"), qualityAccepted: z.literal(false),
  canonicalPublicationAllowed: z.literal(false), completionVerified: z.literal(false),
  releasesCapacity: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export type CodexResultReceiptV1 = z.infer<typeof codexResultReceiptSchemaV1>;

const reviewPlanSchema = z.object({
  schema: z.literal("control-room.codex-review-plan/v1"), tenantId: localId, projectId: localId,
  jobId: localId, attemptId: localId, runId: localId, nodeId: localId,
  publicationId: localId, publicationContractDigest: digestSchema, terminalEvidenceDigest: digestSchema,
  taskPlanDigest: digestSchema, activationIntentRecordDigest: digestSchema,
  acceptanceProfileId: localId, acceptanceProfileDigest: digestSchema, plannedAt: instant, targetId: localId,
  qualityAccepted: z.literal(false), completionVerified: z.literal(false), releasesCapacity: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();
type CodexReviewPlan = z.infer<typeof reviewPlanSchema>;

type PublicationRow = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string;
  publication_id: string; record_digest: string; record: unknown; auth_tag: string; recorded_at: string | Date };
type ReservationRow = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string;
  artifact_id: string; identity_digest: string; state: string; contract_digest: string; reservation: unknown;
  auth_tag: string; created_at: string | Date; updated_at: string | Date };
type ResultRow = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string;
  artifact_id: string; receipt: unknown; auth_tag: string; manifest: unknown; content_hash: string; state: string;
  version: number; workflow_id: string; created_at: string | Date; updated_at: string | Date };
type ReviewRow = { tenant_id: string; project_id: string; job_id: string; run_id: string; plan: unknown; auth_tag: string };

const resultSelection = `r.tenant_id,r.project_id,r.job_id,r.attempt_id,r.run_id,r.artifact_id,r.receipt,r.auth_tag,
  m.payload AS manifest,m.content_hash,m.state,m.version,m.workflow_id,m.created_at,m.updated_at
  FROM control_native_artifact_receipts r JOIN control_artifact_manifests m
  ON m.tenant_id=r.tenant_id AND m.id=r.artifact_id AND m.project_id=r.project_id
    AND m.job_id=r.job_id AND m.attempt_id=r.attempt_id`;
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
const unavailable = (): never => { throw new Error("codex_canonical_result_unavailable"); };
const current = (check: () => unknown) => assertSynchronousFence(check, unavailable);

export interface CodexResultPublisherConfigurationV1 {
  integrityKey: Uint8Array;
  harnessIntegrityKey: Uint8Array;
  taskPlanIntegrityKey: Uint8Array;
  activationIntegrityKey: Uint8Array;
  reviewIntegrityKey: Uint8Array;
  /** Separate least-privilege result/review database profile. */
  reviewDatabase: DatabaseClient;
  checkpoints: AwaitableRollbackCheckpointStoreV1;
  qualificationTrust: CodexQualificationTrustV1;
  storageClass: "local" | "r2";
  storage: ArtifactStoragePortV1 & ArtifactReadPortV1;
  /** Synchronous trusted server clock; caller payload timestamps are never used for freshness. */
  now: () => number;
  storageIoMs?: number;
}

/** Trusted Codex-only result persistence. It consumes already-produced evidence and has no
 * process, provider, credential, completion, retry, resume or capacity-release port. */
export class CodexCanonicalResultPublisherV1 {
  private readonly key: Uint8Array; private readonly harnessKey: Uint8Array;
  private readonly taskPlanKey: Uint8Array; private readonly activationKey: Uint8Array;
  private readonly reviewKey: Uint8Array; private readonly qualificationTrust: CodexQualificationTrustV1;
  private readonly storageClass: "local" | "r2"; private readonly storageIoMs: number;
  private readonly put: ArtifactStoragePortV1["put"]; private readonly readBytes: ArtifactReadPortV1["read"];
  private readonly checkpoints: AwaitableRollbackCheckpointStoreV1; private storageUncertain = false;
  private readonly reviewDb: DatabaseClient;
  private readonly now: () => number;

  constructor(private readonly db: DatabaseClient, config: CodexResultPublisherConfigurationV1) {
    for (const key of [config.integrityKey, config.harnessIntegrityKey, config.taskPlanIntegrityKey,
      config.activationIntegrityKey, config.reviewIntegrityKey]) {
      if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("codex_result_configuration_invalid");
    }
    this.key = Uint8Array.from(config.integrityKey); this.harnessKey = Uint8Array.from(config.harnessIntegrityKey);
    this.taskPlanKey = Uint8Array.from(config.taskPlanIntegrityKey); this.activationKey = Uint8Array.from(config.activationIntegrityKey);
    this.reviewKey = Uint8Array.from(config.reviewIntegrityKey);
    this.reviewDb = config.reviewDatabase;
    this.qualificationTrust = codexQualificationTrustSchemaV1.parse(config.qualificationTrust);
    this.storageClass = z.enum(["local", "r2"]).parse(config.storageClass);
    this.put = config.storage.put.bind(config.storage); this.readBytes = config.storage.read.bind(config.storage);
    if (typeof config.now !== "function") throw new Error("codex_result_configuration_invalid");
    this.now = config.now;
    this.storageIoMs = config.storageIoMs ?? 2000;
    if (!Number.isSafeInteger(this.storageIoMs) || this.storageIoMs < 1 || this.storageIoMs > 2000)
      throw new Error("codex_result_configuration_invalid");
    this.checkpoints = Object.freeze({ read: config.checkpoints.read.bind(config.checkpoints),
      initialize: config.checkpoints.initialize.bind(config.checkpoints), advance: config.checkpoints.advance.bind(config.checkpoints) });
  }

  private nowInstant(): string {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) unavailable();
    return new Date(value).toISOString();
  }

  private assertBefore(expiresAt: number): void {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value >= expiresAt) unavailable();
  }

  private async io<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.storageUncertain) throw new Error("codex_result_storage_uncertain");
    const abort = new AbortController(); const started = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([Promise.resolve().then(() => operation(abort.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.storageUncertain = true; abort.abort(); reject(new Error("codex_result_storage_uncertain")); }, this.storageIoMs);
      })]);
      if (this.storageUncertain || performance.now() - started >= this.storageIoMs) {
        this.storageUncertain = true; abort.abort(); throw new Error("codex_result_storage_uncertain");
      }
      return value;
    } finally { clearTimeout(timer); }
  }

  private publicationTag(record: CodexCanonicalResultRecordV1) {
    return hmacSha256Tag(this.key, { purpose: "codex-canonical-result-record/v1", record });
  }
  private reservationTag(reservation: CodexResultReservationV1) {
    return hmacSha256Tag(this.key, { purpose: "native-result-write-reservation/v1", reservation });
  }
  private reviewTag(plan: CodexReviewPlan) { return hmacSha256Tag(this.reviewKey, { purpose: "codex-review-plan/v1", plan }); }

  private verifyPublicationRow(row: PublicationRow) {
    const record = codexCanonicalResultRecordSchemaV1.parse(row.record);
    const expected = Buffer.from(this.publicationTag(record)), actual = Buffer.from(row.auth_tag);
    const i = record.publication.identity;
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || row.tenant_id !== i.tenantId
      || row.project_id !== i.projectId || row.job_id !== i.jobId || row.attempt_id !== i.attemptId
      || row.run_id !== i.runId || row.publication_id !== record.publication.publicationId
      || row.record_digest !== record.recordDigest || new Date(row.recorded_at).toISOString() !== record.recordedAt) unavailable();
    return record;
  }
  private verifyReservationRow(row: ReservationRow) {
    const reservation = codexResultReservationSchemaV1.parse(row.reservation);
    const expected = Buffer.from(this.reservationTag(reservation)), actual = Buffer.from(row.auth_tag);
    const i = reservation.identity;
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || row.tenant_id !== i.tenantId
      || row.project_id !== i.projectId || row.job_id !== i.jobId || row.attempt_id !== i.attemptId
      || row.run_id !== i.runId || row.artifact_id !== i.artifactId || row.identity_digest !== reservation.identityDigest
      || row.state !== reservation.state || row.contract_digest !== reservation.contractDigest) unavailable();
    return reservation;
  }
  private verifyReviewRow(row: ReviewRow) {
    const plan = reviewPlanSchema.parse(row.plan), expected = Buffer.from(this.reviewTag(plan)), actual = Buffer.from(row.auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || row.tenant_id !== plan.tenantId
      || row.project_id !== plan.projectId || row.job_id !== plan.jobId || row.run_id !== plan.runId) unavailable();
    return plan;
  }
  private verifyResultRow(row: ResultRow) {
    const receipt = codexResultReceiptSchemaV1.parse(row.receipt), manifest = artifactManifestRecordSchema.parse(row.manifest);
    const expected = Buffer.from(hmacSha256Tag(this.key, { purpose: "codex-result-receipt/v1", receipt }));
    const actual = Buffer.from(row.auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || receipt.tenantId !== row.tenant_id
      || receipt.projectId !== row.project_id || receipt.jobId !== row.job_id || receipt.attemptId !== row.attempt_id
      || receipt.runId !== row.run_id || receipt.artifactId !== row.artifact_id || sha256Digest(manifest) !== receipt.manifestDigest
      || manifest.id !== receipt.artifactId || manifest.tenantId !== receipt.tenantId || manifest.projectId !== receipt.projectId
      || manifest.jobId !== receipt.jobId || manifest.attemptId !== receipt.attemptId || manifest.producerId !== receipt.nodeId
      || manifest.contentHash !== receipt.contentHash || manifest.sizeBytes !== receipt.sizeBytes
      || row.content_hash !== receipt.contentHash || row.state !== "uploaded" || Number(row.version) !== 0
      || row.workflow_id !== manifest.workflowId || manifest.storageClass !== this.storageClass
      || manifest.mimeType !== "text/plain; charset=utf-8") unavailable();
    return { receipt, manifest };
  }

  private async reservationRow(tx: DatabaseSession, tenantId: string, runId: string) {
    return (await tx.query<ReservationRow>(`SELECT tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,
      identity_digest,state,contract_digest,reservation,auth_tag,created_at,updated_at
      FROM control_native_result_write_reservations WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`, [tenantId, runId])).rows[0];
  }
  private async updateReservation(tx: DatabaseSession, prior: CodexResultReservationV1,
    next: CodexResultReservationV1, updatedAt: string) {
    const rows = (await tx.query<{ state: string }>(`UPDATE control_native_result_write_reservations SET
      state=$1,contract_digest=$2,reservation=$3::jsonb,auth_tag=$4,updated_at=$5
      WHERE tenant_id=$6 AND run_id=$7 AND state=$8 AND contract_digest=$9 RETURNING state`,
    [next.state, next.contractDigest, JSON.stringify(next), this.reservationTag(next), updatedAt,
      next.identity.tenantId, next.identity.runId, prior.state, prior.contractDigest])).rows;
    if (rows.length !== 1 || rows[0].state !== next.state) unavailable();
  }

  private async bound(tx: DatabaseSession, publication: CodexResultPublicationContractV1,
    evidence: CodexTerminalResultEvidenceV1, qualificationReceipt: unknown, receivedAt: string) {
    const i = publication.identity;
    const readPlan = await readCodexTaskExecutionPlanV3InSession(tx, this.taskPlanKey, i.tenantId, i.jobId);
    const plan = readPlan ?? unavailable();
    const scope = { tenantId: i.tenantId, projectId: i.projectId, jobId: i.jobId,
      attemptId: i.attemptId, inputDigest: plan.job.inputDigest };
    const readActivationIntent = await readCodexActivationTransmissionIntentInSession(tx, this.activationKey, scope);
    const activationIntent = readActivationIntent ?? unavailable();
    const activation = activationIntent.frame.body, admission = activationIntent.currentAdmission;
    await assertCanonicalCodexAdmissionInSession(tx, admission);
    const row = (await tx.query<{ job: unknown; attempt: unknown; lease: unknown }>(`SELECT j.payload AS job,a.payload AS attempt,l.payload AS lease
      FROM control_jobs j JOIN control_attempts a ON a.tenant_id=j.tenant_id AND a.id=$4 AND a.job_id=j.id
      JOIN control_leases l ON l.tenant_id=j.tenant_id AND l.id=$5 AND l.attempt_id=a.id
      WHERE j.tenant_id=$1 AND j.project_id=$2 AND j.id=$3 FOR UPDATE OF j,a,l`,
    [i.tenantId, i.projectId, i.jobId, i.attemptId, i.leaseId])).rows[0];
    const job = jobRecordSchema.parse(row?.job), attempt = attemptRecordSchema.parse(row?.attempt), lease = leaseRecordSchema.parse(row?.lease);
    const immutableJob = { ...job, state: "proposed" as const, version: 0, updatedAt: job.createdAt };
    if (plan.projectId !== i.projectId || plan.job.id !== i.jobId || plan.job.inputDigest !== job.inputDigest
      || sha256Digest(plan.job) !== sha256Digest(immutableJob) || plan.connectorProfileDigest !== publication.connection.connectorProfileDigest
      || plan.workspaceIntentDigest !== activation.workspaceIntentDigest || computeAuthorityDigest(job.authority) !== job.authority.digest
      || activation.tenantId !== i.tenantId || activation.projectId !== i.projectId || activation.jobId !== i.jobId
      || activation.attemptId !== i.attemptId || activation.runId !== i.runId || activation.nodeId !== i.nodeId
      || activation.leaseId !== i.leaseId || activation.leaseEpoch !== i.leaseEpoch
      || activation.activationId !== publication.delivery.activationId || activation.activationDigest !== publication.delivery.activationDigest
      || activation.dispatchMessageId !== publication.delivery.dispatchMessageId
      || activation.dispatchFrameDigest !== publication.delivery.dispatchFrameDigest
      || activation.dispatchBodyDigest !== publication.delivery.dispatchBodyDigest
      || activation.receiptMessageId !== publication.delivery.receiptMessageId
      || activation.receiptFrameDigest !== publication.delivery.receiptFrameDigest
      || activation.receiptBodyDigest !== publication.delivery.receiptBodyDigest
      || activation.connectionId !== publication.connection.connectionId
      || activation.connectorProfileDigest !== publication.connection.connectorProfileDigest
      || admission.tenantId !== i.tenantId || admission.projectId !== i.projectId || admission.jobId !== i.jobId
      || admission.attemptId !== i.attemptId || admission.nodeId !== i.nodeId || admission.leaseId !== i.leaseId
      || admission.leaseEpoch !== i.leaseEpoch || admission.connectionId !== publication.connection.connectionId
      || admission.dispatchFrameDigest !== publication.delivery.dispatchFrameDigest
      || admission.receiptFrameDigest !== publication.delivery.receiptFrameDigest
      || admission.connectorProfileDigest !== publication.connection.connectorProfileDigest
      || job.version !== admission.jobVersion || job.state !== admission.jobState
      || attempt.version !== admission.attemptVersion || attempt.state !== admission.attemptState
      || lease.version !== admission.leaseVersion || lease.state !== admission.leaseState || lease.nodeId !== i.nodeId
      || lease.epoch !== i.leaseEpoch || attempt.nodeId !== i.nodeId || attempt.leaseEpoch !== i.leaseEpoch
      || Date.parse(receivedAt) < Date.parse(evidence.observedAt)
      || Date.parse(receivedAt) < Date.parse(admission.checkedAt)
      || Date.parse(receivedAt) < Date.parse(admission.nodeKeyValidFrom)
      || Date.parse(receivedAt) >= Date.parse(lease.expiresAt)
      || Date.parse(receivedAt) >= Date.parse(admission.admissionExpiresAt)
      || Date.parse(receivedAt) >= Date.parse(admission.authorityExpiresAt)
      || Date.parse(receivedAt) >= Date.parse(admission.approvalExpiresAt)
      || Date.parse(receivedAt) >= Date.parse(admission.configurationExpiresAt)
      || Date.parse(receivedAt) >= Date.parse(activationIntent.frame.expiresAt)
      || (admission.nodeKeyValidUntil !== null
        && Date.parse(receivedAt) >= Date.parse(admission.nodeKeyValidUntil))) unavailable();
    const validityInstants = [lease.expiresAt, admission.admissionExpiresAt, admission.authorityExpiresAt,
      admission.approvalExpiresAt, admission.configurationExpiresAt, activationIntent.frame.expiresAt,
      ...(admission.nodeKeyValidUntil === null ? [] : [admission.nodeKeyValidUntil])].map(value => Date.parse(value));
    const validUntilMs = Math.min(...validityInstants);
    if (!Number.isSafeInteger(validUntilMs)) unavailable();
    const planDigest = sha256Digest(plan), activationIntentRecordDigest = sha256Digest(activationIntent);
    const record = createCodexCanonicalResultRecordV1({ publication, terminalEvidence: evidence,
      qualificationReceipt,
      qualificationTrust: this.qualificationTrust, taskPlanDigest: planDigest, activationIntentRecordDigest, recordedAt: receivedAt });
    return { plan, activationIntent, job, record, planDigest, activationIntentRecordDigest, validUntilMs };
  }

  private anchor(publication: CodexResultPublicationContractV1, receivedAt: string): HarnessRunV1 {
    const i = publication.identity;
    return { schemaVersion: "control-room-harness/v1", id: i.runId, tenantId: i.tenantId, projectId: i.projectId,
      jobId: i.jobId, attemptId: i.attemptId, nodeId: i.nodeId, adapterId: CODEX_CANONICAL_RUN_ADAPTER_ID,
      adapterVersion: "1.0.0", harness: "codex", harnessVersion: publication.exactPackage.packageVersion,
      nativeSessionKeyDigest: publication.connection.initializedConnectionDigest, state: "discovered", resumable: false,
      cancelState: "unsupported", createdAt: receivedAt, updatedAt: receivedAt, lastObservedAt: receivedAt };
  }

  private reviewPlan(plan: CodexTaskExecutionPlanV3, record: CodexCanonicalResultRecordV1): CodexReviewPlan {
    const i = record.publication.identity;
    return reviewPlanSchema.parse({ schema: "control-room.codex-review-plan/v1",
      tenantId: i.tenantId, projectId: i.projectId, jobId: i.jobId, attemptId: i.attemptId,
      runId: i.runId, nodeId: i.nodeId,
      publicationId: record.publication.publicationId, publicationContractDigest: record.publication.contractDigest,
      terminalEvidenceDigest: record.terminalEvidence.evidenceDigest, taskPlanDigest: record.taskPlanDigest,
      activationIntentRecordDigest: record.activationIntentRecordDigest,
      acceptanceProfileId: plan.acceptanceProfileId, acceptanceProfileDigest: plan.acceptanceProfileDigest,
      plannedAt: plan.plannedAt, targetId: `target:codex:${sha256Digest({ tenantId: i.tenantId, jobId: i.jobId }).slice(7)}`,
      qualityAccepted: false, completionVerified: false, releasesCapacity: false, grantsExecutionAuthority: false });
  }

  private async requireProfile(tx: DatabaseSession, plan: CodexReviewPlan) {
    const gate = new CompletionGateStoreV1(joined(tx), this.reviewKey, this.checkpoints);
    const profile = completionAcceptanceProfileSchemaV1.parse(await gate.getRecord(plan.tenantId, plan.acceptanceProfileId, "profile"));
    if (profile.projectId !== plan.projectId || sha256Digest(profile) !== plan.acceptanceProfileDigest
      || profile.targetKind !== "document" || Date.parse(profile.createdAt) > Date.parse(plan.plannedAt)) unavailable();
    return profile;
  }

  private async markUncertain(tenantId: string, runId: string, stage: string, updatedAt: string) {
    try { await this.db.transaction(async tx => {
      await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, runId]);
      const row = await this.reservationRow(tx, tenantId, runId); if (!row) return;
      const reservation = this.verifyReservationRow(row);
      if (reservation.state === "metadata_committed" || reservation.state === "storage_uncertain") return;
      const uncertain = markCodexResultReservationStorageUncertainV1({ reservation,
        uncertaintyDigest: sha256Digest({ purpose: "codex-result-storage-uncertainty/v1",
          reservationId: reservation.reservationId, reservationContractDigest: reservation.contractDigest, stage }) });
      await this.updateReservation(tx, reservation, uncertain, updatedAt);
    }); } catch { /* Original operation remains failed closed if the marker cannot commit. */ }
  }

  async capture(input: { publication: unknown; terminalEvidence: unknown; qualificationReceipt: unknown;
    bytes: Uint8Array; assertCurrent: () => unknown }) {
    if (typeof input.assertCurrent !== "function") unavailable();
    const assertCurrent = input.assertCurrent; current(assertCurrent);
    const publication = codexResultPublicationContractSchemaV1.parse(input.publication);
    const parsedEvidence = terminalResultEvidenceSchemaV1.parse(input.terminalEvidence);
    const evidence = parsedEvidence.kind === "codex_exact_completed_turn" ? parsedEvidence : unavailable();
    const { bytes } = checkedResultBytes(input.bytes, { contentHash: publication.result.contentHash,
      sizeBytes: publication.result.contentSizeBytes });
    if (Buffer.from(publication.result.text, "utf8").compare(Buffer.from(bytes)) !== 0) unavailable();
    // Verify the complete signed receipt before acquiring any database or storage effect.
    const preflightAt = this.nowInstant();
    createCodexCanonicalResultRecordV1({ publication, terminalEvidence: evidence,
      qualificationReceipt: input.qualificationReceipt, qualificationTrust: this.qualificationTrust,
      taskPlanDigest: sha256Digest("preflight-plan"), activationIntentRecordDigest: sha256Digest("preflight-activation"), recordedAt: preflightAt });
    const i = publication.identity, artifactId = nativeResultId(i.tenantId, i.runId);
    let reservationValidUntil = 0;
    const acquired = await this.db.transactionWithPreCommitCheck(async tx => {
      current(assertCurrent);
      const receivedAt = this.nowInstant();
      const bound = await this.bound(tx, publication, evidence, input.qualificationReceipt, receivedAt);
      reservationValidUntil = bound.validUntilMs;
      const anchor = this.anchor(publication, receivedAt);
      const anchored = await new HarnessRunStoreV1(joined(tx), this.harnessKey).create(anchor);
      if (anchored.run.state !== "discovered" || anchored.run.nativeTask || anchored.run.startedAt || anchored.run.finishedAt
        || anchored.run.resumable || anchored.run.harness !== "codex" || anchored.run.cancelState !== "unsupported") unavailable();
      let publicationRow = (await tx.query<PublicationRow>(`SELECT * FROM control_codex_result_publications
        WHERE tenant_id=$1 AND run_id=$2`, [i.tenantId, i.runId])).rows[0];
      if (publicationRow) {
        const prior = this.verifyPublicationRow(publicationRow);
        if (prior.recordDigest !== bound.record.recordDigest) unavailable();
      } else {
        await tx.query(`INSERT INTO control_codex_result_publications
          (tenant_id,project_id,job_id,attempt_id,run_id,publication_id,record_digest,record,auth_tag,recorded_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, [i.tenantId, i.projectId, i.jobId, i.attemptId,
          i.runId, publication.publicationId, bound.record.recordDigest, JSON.stringify(bound.record),
          this.publicationTag(bound.record), receivedAt]);
        publicationRow = { tenant_id: i.tenantId, project_id: i.projectId, job_id: i.jobId, attempt_id: i.attemptId,
          run_id: i.runId, publication_id: publication.publicationId, record_digest: bound.record.recordDigest,
          record: bound.record, auth_tag: this.publicationTag(bound.record), recorded_at: receivedAt };
      }
      const row = await this.reservationRow(tx, i.tenantId, i.runId);
      if (row) {
        const reservation = this.verifyReservationRow(row);
        reserveCodexResultWriteV1({ publication, evidence, existing: reservation });
        if (reservation.state !== "metadata_committed") throw new Error("codex_result_manual_reconciliation_required");
        const resultRow = (await tx.query<ResultRow>(`SELECT ${resultSelection} WHERE r.tenant_id=$1 AND r.run_id=$2`,
          [i.tenantId, i.runId])).rows[0];
        if (!resultRow) unavailable();
        const verified = this.verifyResultRow(resultRow);
        if (reservation.manifestDigest !== verified.receipt.manifestDigest
          || reservation.receiptDigest !== sha256Digest(verified.receipt)) unavailable();
        return { kind: "replay" as const, receipt: verified.receipt, receivedAt, validUntilMs: bound.validUntilMs };
      }
      const unreserved = (await tx.query<ResultRow>(`SELECT ${resultSelection} WHERE r.tenant_id=$1 AND r.run_id=$2`,
        [i.tenantId, i.runId])).rows[0];
      if (unreserved) { this.verifyResultRow(unreserved); throw new Error("codex_result_manual_reconciliation_required"); }
      const reservation = reserveCodexResultWriteV1({ publication, evidence });
      await tx.query(`INSERT INTO control_native_result_write_reservations
        (tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,identity_digest,state,contract_digest,reservation,auth_tag,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12)`, [i.tenantId, i.projectId, i.jobId,
        i.attemptId, i.runId, artifactId, reservation.identityDigest, reservation.state, reservation.contractDigest,
        JSON.stringify(reservation), this.reservationTag(reservation), receivedAt]);
      return { kind: "fresh" as const, reservation, job: bound.job, receivedAt, validUntilMs: bound.validUntilMs };
    }, () => { current(assertCurrent); this.assertBefore(reservationValidUntil); });

    const receivedAt = acquired.receivedAt;

    if (acquired.kind === "replay") {
      const review = await this.submitReview(i.tenantId, i.runId, acquired.validUntilMs, assertCurrent);
      current(assertCurrent); this.assertBefore(acquired.validUntilMs);
      return { receipt: acquired.receipt, target: review.target, replayed: true };
    }
    this.assertBefore(acquired.validUntilMs);
    if (this.storageUncertain) { await this.markUncertain(i.tenantId, i.runId, "storage_port_previously_uncertain", receivedAt);
      throw new Error("codex_result_storage_uncertain"); }
    let stored: Awaited<ReturnType<ArtifactStoragePortV1["put"]>>;
    try {
      current(assertCurrent); this.assertBefore(acquired.validUntilMs);
      stored = await this.io(signal => this.put({ artifactId, bytes, signal }));
      current(assertCurrent); this.assertBefore(acquired.validUntilMs);
      if (stored.artifactId !== artifactId || stored.contentHash !== publication.result.contentHash
        || stored.sizeBytes !== bytes.byteLength) unavailable();
      const readback = await this.io(signal => this.readBytes(artifactId, signal));
      current(assertCurrent); this.assertBefore(acquired.validUntilMs);
      const verifiedReadback = readback ?? unavailable();
      checkedResultBytes(verifiedReadback, acquired.reservation.identity);
      await this.db.transactionWithPreCommitCheck(async tx => {
        await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [i.tenantId, i.runId]);
        const row = await this.reservationRow(tx, i.tenantId, i.runId); if (!row) unavailable();
        const reservation = this.verifyReservationRow(row);
        if (reservation.contractDigest !== acquired.reservation.contractDigest || reservation.state !== "reserved")
          throw new Error("codex_result_manual_reconciliation_required");
        await this.updateReservation(tx, reservation,
          verifyCodexResultReservationBytesV1(reservation, verifiedReadback), receivedAt);
      }, () => { current(assertCurrent); this.assertBefore(acquired.validUntilMs); });
    } catch {
      await this.markUncertain(i.tenantId, i.runId, "put_or_exact_readback", receivedAt);
      throw new Error("codex_result_storage_uncertain");
    }
    this.assertBefore(acquired.validUntilMs);
    const captured = await this.db.transactionWithPreCommitCheck(async tx => {
      await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [i.tenantId, i.runId]);
      const row = await this.reservationRow(tx, i.tenantId, i.runId); if (!row) unavailable();
      const reservation = this.verifyReservationRow(row);
      reserveCodexResultWriteV1({ publication, evidence, existing: reservation });
      if (reservation.state !== "bytes_verified") throw new Error("codex_result_manual_reconciliation_required");
      const manifest: ArtifactManifestRecord = artifactManifestRecordSchema.parse({ contractVersion: DOMAIN_CONTRACT_VERSION,
        id: artifactId, tenantId: i.tenantId, projectId: i.projectId, jobId: i.jobId, attemptId: i.attemptId,
        workflowId: acquired.job.workflowId, kind: "artifact_manifest", state: "uploaded", version: 0,
        createdAt: receivedAt, updatedAt: receivedAt, contentHash: publication.result.contentHash,
        sizeBytes: bytes.byteLength, mimeType: "text/plain; charset=utf-8", logicalRole: "task_result",
        schemaVersion: "1.0.0", producerId: i.nodeId, storageClass: this.storageClass,
        opaqueLocator: stored.opaqueLocator, retentionClass: "private_task_result" });
      assertNoSecretMaterial(manifest);
      const receipt = codexResultReceiptSchemaV1.parse({ schema: "control-room.codex-result-receipt/v1", artifactId,
        tenantId: i.tenantId, projectId: i.projectId, jobId: i.jobId, attemptId: i.attemptId,
        runId: i.runId, nodeId: i.nodeId,
        publicationId: publication.publicationId, publicationContractDigest: publication.contractDigest,
        terminalEvidenceDigest: evidence.evidenceDigest,
        qualificationReceiptBodyDigest: publication.physicalQualification.receiptBodyDigest,
        qualificationSignerKeyId: publication.physicalQualification.signerKeyId,
        threadId: publication.result.threadId, turnId: publication.result.turnId, itemId: publication.result.itemId,
        projectionDigest: publication.result.projectionDigest, rawResultDigest: publication.result.rawResultDigest,
        rawTurnDigest: publication.result.rawTurnDigest, contentHash: publication.result.contentHash,
        sizeBytes: publication.result.contentSizeBytes, manifestDigest: sha256Digest(manifest), receivedAt,
        byteCheck: "matched_recorded_claim", qualityAccepted: false, canonicalPublicationAllowed: false,
        completionVerified: false, releasesCapacity: false, grantsExecutionAuthority: false });
      const committed = commitCodexResultReservationMetadataV1({ reservation,
        manifestDigest: receipt.manifestDigest, receiptDigest: sha256Digest(receipt) });
      await tx.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,
        content_hash,state,version,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'uploaded',0,$8::jsonb,$9,$9)`,
      [artifactId, i.tenantId, i.projectId, acquired.job.workflowId, i.jobId, i.attemptId,
        receipt.contentHash, JSON.stringify(manifest), receivedAt]);
      await tx.query(`INSERT INTO control_native_artifact_receipts
        (tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,receipt,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [i.tenantId, i.projectId, i.jobId, i.attemptId, i.runId,
        artifactId, JSON.stringify(receipt), hmacSha256Tag(this.key, { purpose: "codex-result-receipt/v1", receipt })]);
      await appendAuditWith(tx, { id: `audit:codex-result:${sha256Digest({ tenantId: i.tenantId, artifactId }).slice(7)}`,
        tenantId: i.tenantId, projectId: i.projectId, actorId: i.nodeId, actorType: "worker",
        action: "task.result.received", targetType: "artifact", targetId: artifactId, occurredAt: receivedAt,
        idempotencyKey: publication.contractDigest, safeMetadata: { contentHash: receipt.contentHash,
          sizeBytes: receipt.sizeBytes, byteCheck: receipt.byteCheck, completionVerified: false } });
      await this.updateReservation(tx, reservation, committed, receivedAt);
      return receipt;
    }, () => { current(assertCurrent); this.assertBefore(acquired.validUntilMs); });
    const review = await this.submitReview(i.tenantId, i.runId, acquired.validUntilMs, assertCurrent);
    current(assertCurrent); this.assertBefore(acquired.validUntilMs);
    return { receipt: captured, target: review.target, replayed: false };
  }

  private async submitReview(tenantId: string, runId: string, validUntilMs: number,
    assertCurrent: () => unknown) {
    current(assertCurrent); this.assertBefore(validUntilMs);
    const staged = stageAsyncCompletionCheckpoint(this.checkpoints, tenantId);
    return this.reviewDb.transactionWithPreCommitCheck(async tx => {
      current(assertCurrent); this.assertBefore(validUntilMs);
      const locked = await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, runId]);
      if (locked.rows.length !== 1) unavailable();
      const run = await new HarnessRunStoreV1(joined(tx), this.harnessKey).inspect(tenantId, runId);
      if (!run || run.events.length || run.run.harness !== "codex" || run.run.state !== "discovered"
        || run.run.nativeTask || run.run.startedAt || run.run.finishedAt || run.run.resumable) unavailable();
      const publicationRow = (await tx.query<PublicationRow>(`SELECT * FROM control_codex_result_publications
        WHERE tenant_id=$1 AND run_id=$2`, [tenantId, runId])).rows[0];
      if (!publicationRow) unavailable();
      const record = this.verifyPublicationRow(publicationRow), identity = record.publication.identity;
      const readTaskPlan = await readCodexTaskExecutionPlanV3InSession(tx, this.taskPlanKey, tenantId, identity.jobId);
      const taskPlan = readTaskPlan ?? unavailable();
      if (sha256Digest(taskPlan) !== record.taskPlanDigest) unavailable();
      const expectedPlan = this.reviewPlan(taskPlan, record);
      const reviewRow = (await tx.query<ReviewRow>(`SELECT * FROM control_native_review_plans
        WHERE tenant_id=$1 AND run_id=$2`, [tenantId, runId])).rows[0];
      let plan: CodexReviewPlan;
      if (reviewRow) {
        plan = this.verifyReviewRow(reviewRow);
        if (sha256Digest(plan) !== sha256Digest(expectedPlan)) unavailable();
      } else {
        plan = expectedPlan;
        await tx.query(`INSERT INTO control_native_review_plans(tenant_id,project_id,job_id,run_id,plan,auth_tag)
          VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [tenantId, identity.projectId, identity.jobId, runId,
          JSON.stringify(plan), this.reviewTag(plan)]);
      }
      if (plan.publicationContractDigest !== record.publication.contractDigest
        || plan.terminalEvidenceDigest !== record.terminalEvidence.evidenceDigest
        || plan.taskPlanDigest !== record.taskPlanDigest || plan.activationIntentRecordDigest !== record.activationIntentRecordDigest) unavailable();
      await this.requireProfile(tx, plan);
      const resultRow = (await tx.query<ResultRow>(`SELECT ${resultSelection} WHERE r.tenant_id=$1 AND r.run_id=$2`,
        [tenantId, runId])).rows[0];
      if (!resultRow) unavailable(); const { receipt } = this.verifyResultRow(resultRow);
      if (receipt.publicationContractDigest !== record.publication.contractDigest
        || receipt.terminalEvidenceDigest !== record.terminalEvidence.evidenceDigest) unavailable();
      const target = completionReviewTargetSchemaV1.parse({ schemaVersion: "control-room-completion-gate/v1",
        id: plan.targetId, tenantId, projectId: plan.projectId, kind: "document", subjectId: plan.jobId,
        subjectDigest: receipt.contentHash, acceptanceProfileId: plan.acceptanceProfileId,
        acceptanceProfileDigest: plan.acceptanceProfileDigest, producer: { actorId: plan.nodeId, actorType: "agent" },
        rootTargetId: plan.targetId, revisionNumber: 0, submittedAt: receipt.receivedAt });
      const gate = new CompletionGateStoreV1(joined(tx), this.reviewKey, staged.checkpoints);
      const registered = await gate.registerTarget(target);
      if (!registered.replayed) await appendAuditWith(tx, { id: `audit:codex-submission:${sha256Digest({ tenantId, runId }).slice(7)}`,
        tenantId, projectId: plan.projectId, actorId: "service:codex-result-submission", actorType: "service",
        action: "task.result.submitted_for_review", targetType: "artifact", targetId: receipt.artifactId,
        occurredAt: receipt.receivedAt, idempotencyKey: sha256Digest(plan), safeMetadata: {
          targetId: target.id, contentHash: target.subjectDigest, qualityAccepted: false, completionVerified: false } });
      return { target: registered.target, replayed: registered.replayed, qualityAccepted: false as const,
        completionVerified: false as const, releasesCapacity: false as const };
    }, async () => {
      const fence = () => { current(assertCurrent); this.assertBefore(validUntilMs); };
      fence();
      await staged.flush(fence);
      fence();
    });
  }
}
