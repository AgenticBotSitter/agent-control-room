import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "./database";
import { domainEntitySchema, jobRecordSchema, attemptRecordSchema, leaseRecordSchema,
  jobTransitions, attemptTransitions, leaseTransitions, type JobRecord, type AttemptRecord, type LeaseRecord } from "../domain/v1";
import { appendAuditWith } from "../audit/audit-store";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../security";
import { NativeResultSubmissionService } from "../completion-gate/v1/native-result-submission";
import { nativeQualityRequestSchema, type NativeQualityConfiguration, type NativeQualityRequest } from "../completion-gate/v1/native-result-verification";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const receiptSchema = nativeQualityRequestSchema.extend({ projectId: id, jobId: id, attemptId: id, leaseId: id, nodeId: id,
  artifactId: id, leaseEpoch: z.number().int().positive(), completedAt: z.string().datetime(), recordedAt: z.string().datetime(),
  jobVersion: z.number().int().positive(), attemptVersion: z.number().int().positive(), leaseVersion: z.number().int().positive(),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
export type NativeTaskCompletionReceipt = z.infer<typeof receiptSchema>;
const metadataSchema = z.object({ receipt: receiptSchema, requestDigest: digest, authTag: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/) }).strict();
const deny = (): never => { throw new Error("native_task_completion_unavailable"); };
type Record = JobRecord | AttemptRecord | LeaseRecord;
const tables = { job: "control_jobs", attempt: "control_attempts", lease: "control_leases" };
const states = { job: jobTransitions, attempt: attemptTransitions, lease: leaseTransitions };

/** Internal coordinated repository operation, never a browser finish button or execution permit. */
export class NativeTaskCompletionService {
  private readonly submission: NativeResultSubmissionService;
  private readonly key: Uint8Array;
  private lastObserved = Number.NEGATIVE_INFINITY;
  private time() { const now = this.clock(); if (!Number.isSafeInteger(now) || now < this.lastObserved) return deny();
    this.lastObserved = now; return now; }
  constructor(private readonly db: DatabaseClient, config: NativeQualityConfiguration, private readonly clock: () => number = Date.now) {
    this.submission = new NativeResultSubmissionService(db, config); this.key = Uint8Array.from(config.integrityKey);
  }
  private tag(receipt: NativeTaskCompletionReceipt, requestDigest: string) {
    return hmacSha256Tag(this.key, { purpose: "native-task-completion/v1", receipt, requestDigest });
  }
  private async record(tx: DatabaseSession, tenantId: string, kind: keyof typeof tables, entityId: string) {
    const row = (await tx.query<{ payload: unknown; state: string; version: number }>(
      `SELECT payload,state,version FROM ${tables[kind]} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, entityId])).rows[0];
    if (!row) return deny();
    const entity = domainEntitySchema.parse(row.payload);
    if (entity.kind !== kind || entity.tenantId !== tenantId || entity.id !== entityId || entity.state !== row.state || entity.version !== Number(row.version)) return deny();
    return entity as Record;
  }
  private async transition(tx: DatabaseSession, entity: Record, toState: string, suffix: string, key: string,
    occurredAt: string, metadata: object, patch: object = {}) {
    const allowed = states[entity.kind] as { [state: string]: readonly string[] };
    if (!allowed[entity.state]?.includes(toState) || Date.parse(occurredAt) < Date.parse(entity.updatedAt)) return deny();
    const next = domainEntitySchema.parse({ ...entity, ...patch, state: toState, version: entity.version + 1, updatedAt: occurredAt }) as Record;
    const eventId = `transition:native-completion:${key}:${suffix}`, idempotencyKey = `native-completion:${key}:${suffix}`;
    const updated = await tx.query(`UPDATE ${tables[entity.kind]} SET state=$1,version=$2,payload=$3::jsonb,updated_at=$4
      WHERE tenant_id=$5 AND id=$6 AND version=$7 AND state=$8 RETURNING id`,
    [next.state, next.version, JSON.stringify(next), occurredAt, entity.tenantId, entity.id, entity.version, entity.state]);
    if (updated.rows.length !== 1) return deny();
    await tx.query(`INSERT INTO control_transition_events(id,tenant_id,entity_kind,entity_id,from_state,to_state,from_version,to_version,
      actor_id,actor_type,idempotency_key,safe_metadata,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'service',$10,$11::jsonb,$12)`,
    [eventId, entity.tenantId, entity.kind, entity.id, entity.state, next.state, entity.version, next.version,
      "service:native-task-completion", idempotencyKey, JSON.stringify(metadata), occurredAt]);
    await tx.query(`INSERT INTO control_outbox(id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,available_at,payload)
      VALUES($1,$2,'domain.transition',$3,$4,$5,'pending',$6,$7::jsonb)`,
    [`outbox:${eventId}`, entity.tenantId, entity.kind, entity.id, idempotencyKey, occurredAt,
      JSON.stringify({ entityKind: entity.kind, entityId: entity.id, fromState: entity.state, toState: next.state, version: next.version })]);
    return next;
  }
  async complete(input: NativeQualityRequest, assertCurrent: () => void) {
    const request = nativeQualityRequestSchema.parse(input); assertNoSecretMaterial(request); assertCurrent();
    const started = this.time();
    const current = () => { const now = this.time(); if (now - started > 10_000) return deny(); assertCurrent(); return now; };
    const result = await this.db.transactionWithPreCommitCheck(async tx => {
      current(); const context = await this.submission.inspectSubmitted(tx, request.tenantId, request.runId);
      const { run, snapshot, result: artifact } = context, native = run.nativeTask!;
      if (snapshot.status !== "ready" || snapshot.targetDigest !== request.targetDigest || artifact.receipt.contentHash !== request.contentHash) return deny();
      const job = jobRecordSchema.parse(await this.record(tx, request.tenantId, "job", run.jobId));
      const attempt = attemptRecordSchema.parse(await this.record(tx, request.tenantId, "attempt", run.attemptId));
      const lease = leaseRecordSchema.parse(await this.record(tx, request.tenantId, "lease", native.leaseId));
      if (job.projectId !== run.projectId || job.id !== context.job.id || job.inputDigest !== native.inputDigest
        || attempt.jobId !== job.id || attempt.nodeId !== run.nodeId || attempt.leaseEpoch !== native.leaseEpoch
        || lease.jobId !== job.id || lease.attemptId !== attempt.id || lease.nodeId !== run.nodeId || lease.epoch !== native.leaseEpoch) return deny();
      const latest = (await tx.query<{ epoch: number }>("SELECT max(epoch) AS epoch FROM control_leases WHERE tenant_id=$1 AND job_id=$2", [request.tenantId, job.id])).rows[0];
      if (Number(latest?.epoch) !== lease.epoch) return deny();
      const terminal = context.events.at(-1);
      if (terminal?.payload.category !== "native_snapshot" || terminal.payload.snapshot.state !== "completed"
        || terminal.payload.snapshot.result?.contentHash !== request.contentHash || !run.startedAt || !run.finishedAt
        || run.finishedAt !== terminal.occurredAt || Date.parse(run.startedAt) < Date.parse(lease.acquiredAt)
        || Date.parse(run.finishedAt) < Date.parse(run.startedAt)
        || Date.parse(run.finishedAt) >= Math.min(Date.parse(native.deadline), Date.parse(lease.expiresAt), Date.parse(job.authority.expiresAt))) return deny();
      const recordedAt = new Date(current()).toISOString();
      if ([job.updatedAt, attempt.updatedAt, lease.updatedAt, run.finishedAt, artifact.receipt.receivedAt, snapshot.target.submittedAt]
        .some(value => Date.parse(value) > Date.parse(recordedAt))) return deny();
      // Do not mark completion before its accepted reviews or verification records existed.
      for (const recordId of snapshot.acceptedReviewIds) {
        const record = await context.gate.getRecord(request.tenantId, recordId, "review");
        if (!record || !("reviewedAt" in record) || Date.parse(record.reviewedAt) > Date.parse(recordedAt)) return deny();
      }
      const verificationRows = await tx.query<{ payload: { verifiedAt: string } }>(
        "SELECT payload FROM control_completion_gate_records WHERE tenant_id=$1 AND kind='verification' AND parent_id=$2", [request.tenantId, snapshot.target.id]);
      if (verificationRows.rows.some(row => Date.parse(row.payload.verifiedAt) > Date.parse(recordedAt))) return deny();
      const requestDigest = sha256Digest(request), key = requestDigest.slice(7);
      const prior = (await tx.query<{ safe_metadata: unknown; entity_id: string; to_state: string; occurred_at: string | Date }>(
        "SELECT safe_metadata,entity_id,to_state,occurred_at FROM control_transition_events WHERE tenant_id=$1 AND entity_kind='job' AND idempotency_key=$2",
        [request.tenantId, `native-completion:${key}:job`])).rows[0];
      if (prior) {
        const metadata = metadataSchema.parse(prior.safe_metadata), receipt = metadata.receipt;
        const expected = Buffer.from(this.tag(receipt, requestDigest)), actual = Buffer.from(metadata.authTag);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || metadata.requestDigest !== requestDigest
          || prior.entity_id !== job.id || prior.to_state !== "succeeded" || new Date(prior.occurred_at).toISOString() !== receipt.recordedAt
          || job.state !== "succeeded" || attempt.state !== "succeeded" || lease.state !== "released"
          || receipt.jobId !== job.id || receipt.attemptId !== attempt.id || receipt.leaseId !== lease.id || receipt.nodeId !== run.nodeId
          || receipt.projectId !== run.projectId || receipt.artifactId !== artifact.receipt.artifactId || receipt.leaseEpoch !== lease.epoch
          || receipt.completedAt !== run.finishedAt || receipt.jobVersion !== job.version || receipt.attemptVersion !== attempt.version || receipt.leaseVersion !== lease.version
          || sha256Digest(nativeQualityRequestSchema.parse({ tenantId: receipt.tenantId, runId: receipt.runId, targetDigest: receipt.targetDigest, contentHash: receipt.contentHash })) !== requestDigest) return deny();
        current(); return { receipt, replayed: true };
      }
      if (!["leased", "running"].includes(job.state) || !["leased", "running", "waiting"].includes(attempt.state) || lease.state !== "active"
        || Boolean(attempt.startedAt) && attempt.startedAt !== run.startedAt || attempt.finishedAt) return deny();
      const receipt = receiptSchema.parse({ ...request, projectId: run.projectId, jobId: job.id, attemptId: attempt.id,
        leaseId: lease.id, nodeId: run.nodeId, leaseEpoch: lease.epoch, artifactId: artifact.receipt.artifactId,
        completedAt: run.finishedAt, recordedAt, jobVersion: job.version + (job.state === "leased" ? 2 : 1),
        attemptVersion: attempt.version + (attempt.state === "leased" ? 2 : 1), leaseVersion: lease.version + 1,
        grantsApproval: false, grantsExecutionAuthority: false });
      const metadata = { receipt, requestDigest, authTag: this.tag(receipt, requestDigest) }; assertNoSecretMaterial(metadata);
      let nextJob: Record = job, nextAttempt: Record = attempt;
      if (job.state === "leased") nextJob = await this.transition(tx, job, "running", "job-observed", key, recordedAt, metadata);
      if (attempt.state === "leased") nextAttempt = await this.transition(tx, attempt, "running", "attempt-observed", key, recordedAt, metadata, { startedAt: run.startedAt });
      await this.transition(tx, nextAttempt, "succeeded", "attempt", key, recordedAt, metadata, { startedAt: run.startedAt, finishedAt: run.finishedAt });
      await this.transition(tx, nextJob, "succeeded", "job", key, recordedAt, metadata);
      await this.transition(tx, lease, "released", "lease", key, recordedAt, metadata);
      await appendAuditWith(tx, { id: `audit:native-completion:${key}`, tenantId: request.tenantId, projectId: run.projectId,
        actorId: "service:native-task-completion", actorType: "service", action: "task.native.completed", targetType: "job", targetId: job.id,
        occurredAt: recordedAt, idempotencyKey: requestDigest,
        safeMetadata: { runId: run.id, attemptId: attempt.id, artifactId: receipt.artifactId, targetDigest: request.targetDigest, contentHash: request.contentHash, grantsExecutionAuthority: false } });
      current(); return { receipt, replayed: false };
    }, current);
    current(); return result;
  }
}
