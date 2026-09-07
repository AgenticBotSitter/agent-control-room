import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { NativeResultStore, type NativeResultConfiguration } from "../../artifacts/v1/native-results";
import { prepareNativeTaskDispatchIntake } from "../../harness/v1/native-delivery";
import { verifyNativeTaskApprovalBinding } from "../../harness/v1/native-task-approval-binding";
import { nativeTaskRegistration } from "../../harness/v1/native-task-registration";
import { enrollmentSchema, type NativeEnrollment } from "../../harness/v1/native-run-contracts";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import { sha256Digest } from "../../security";
import type { ServerNodeSession } from "../../node-control/server-node-session";
import type { TaskResultOperation } from "./task-result-coordinator";
import { readNativeDeliveryEnvelopeInSession } from "./native-delivery-envelope";
import { readNativeDeliveryReceipt } from "./native-delivery-receipt";
import { readNativeTransmissionIntentReceipt } from "./native-transmission-intent";

export const nativeEvidenceRegistrationSchema = z.object({ projectId: localId, jobId: localId,
  attemptId: localId, inputDigest: digestSchema }).strict();
const fail = (): never => { throw new Error("native_evidence_uncertain"); };
export function captureNativeEvidenceInput(raw: string | Uint8Array, bytes: Uint8Array | undefined) {
  if ((typeof raw !== "string" && !(raw instanceof Uint8Array))
    || (typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength) > 16_384
    || bytes !== undefined && (!(bytes instanceof Uint8Array) || bytes.byteLength > 65_536)) return fail();
  return { raw: typeof raw === "string" ? raw : Uint8Array.from(raw), bytes: bytes === undefined ? undefined : Uint8Array.from(bytes) };
}
export type NativeEvidenceSettings = { integrityKey: Uint8Array; enrollments: readonly NativeEnrollment[]; storage: NativeResultConfiguration };
export function captureNativeEvidenceSettings(value: NativeEvidenceSettings): NativeEvidenceSettings {
  if (!Array.isArray(value.enrollments) || !value.enrollments.length || value.enrollments.length > 32
    || !(value.integrityKey instanceof Uint8Array) || value.integrityKey.length !== 32
    || !(value.storage.integrityKey instanceof Uint8Array) || value.storage.integrityKey.length !== 32
    || typeof value.storage.storage.put !== "function" || typeof value.storage.storage.read !== "function") return fail();
  return { integrityKey: Uint8Array.from(value.integrityKey), enrollments: value.enrollments.map(entry => enrollmentSchema.parse(entry)), storage: {
    ...value.storage, integrityKey: Uint8Array.from(value.storage.integrityKey),
    storage: { put: value.storage.storage.put.bind(value.storage.storage), read: value.storage.storage.read.bind(value.storage.storage) },
  } };
}
type Configuration = { scope: { tenantId: string; workspaceId: string }; integrityKey: Uint8Array;
  harnessIntegrityKey: Uint8Array; enrollments: readonly NativeEnrollment[];
  storage: NativeResultConfiguration; results: TaskResultOperation; clock?: () => number;
  assertAvailable?: () => void };

/** Trusted receiver only. Uses accepted durable delivery evidence, not caller-authored runs.
 * The owner supplies separately verified bounded SQL/storage and an authenticated server session.
 * No listener, native start, signing, polling, automatic retry or quality decision. */
export class NativeEvidenceReceiver {
  private readonly scope: Configuration["scope"];
  private readonly key: Uint8Array;
  private readonly harnessKey: Uint8Array;
  private readonly enrollments: readonly NativeEnrollment[];
  private readonly results: TaskResultOperation;
  private readonly artifacts: NativeResultStore;
  private readonly clock: () => number;
  private readonly available: () => void;
  private highWater = -Infinity;
  constructor(private readonly db: DatabaseClient, config: Configuration) {
    config = { ...config, ...captureNativeEvidenceSettings(config) };
    this.scope = Object.freeze({ tenantId: localId.parse(config.scope.tenantId), workspaceId: localId.parse(config.scope.workspaceId) });
    if (config.integrityKey.length !== 32 || config.harnessIntegrityKey.length !== 32
      || config.results.tenantId !== this.scope.tenantId || config.results.workspaceId !== this.scope.workspaceId
      || !config.enrollments.length || config.enrollments.length > 32) fail();
    this.key = Uint8Array.from(config.integrityKey); this.harnessKey = Uint8Array.from(config.harnessIntegrityKey);
    this.enrollments = config.enrollments.map(value => enrollmentSchema.parse(value));
    if (this.enrollments.some(value => value.tenantId !== this.scope.tenantId)
      || new Set(this.enrollments.map(value => value.nodeId)).size !== this.enrollments.length) fail();
    this.results = Object.freeze({ ...this.scope, register: config.results.register.bind(config.results), submit: config.results.submit.bind(config.results) });
    this.artifacts = new NativeResultStore(db, this.harnessKey, config.storage);
    this.clock = config.clock ?? Date.now; this.available = config.assertAvailable ?? (() => {});
  }
  private guard(signal: AbortSignal) {
    if (!(signal instanceof AbortSignal)) return fail();
    const started = this.clock();
    const current = () => {
      this.available(); const now = this.clock();
      if (signal.aborted || !Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(now)
        || now < started || now < this.highWater || now - started > 10_000) return fail();
      this.highWater = now; return now;
    };
    current(); return current;
  }
  private guarded(current: () => number): DatabaseClient {
    const wrap = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
      current(); const value = await tx.query<T>(sql, params); current(); return value;
    } });
    const db: DatabaseClient = { query: (sql, params) => db.transaction(tx => tx.query(sql, params)),
      transaction: work => db.transactionWithPreCommitCheck(work, () => {}),
      transactionWithPreCommitCheck: async (work, check) => {
        current(); const value = await this.db.transactionWithPreCommitCheck(tx => work(wrap(tx)), async () => { current(); await check(); current(); });
        current(); return value;
      } };
    return db;
  }
  private async project(tx: DatabaseSession, projectId: string) {
    const value = await tx.query("SELECT id FROM projects WHERE tenant_id=$1 AND id=$2 AND workspace_id=$3 FOR SHARE",
      [this.scope.tenantId, projectId, this.scope.workspaceId]);
    if (value.rows.length !== 1) return fail();
  }
  async register(value: z.infer<typeof nativeEvidenceRegistrationSchema>, signal: AbortSignal, assertSessionCurrent: () => void = () => {}) {
    const input = nativeEvidenceRegistrationSchema.parse(value), guard = this.guard(signal);
    const current = () => { assertSessionCurrent(); return guard(); }, db = this.guarded(current);
    let freshDeadline: number | undefined;
    const registration = await db.transactionWithPreCommitCheck(async tx => {
      await this.project(tx, input.projectId);
      const scope = { tenantId: this.scope.tenantId, ...input };
      const envelope = await readNativeDeliveryEnvelopeInSession(tx, this.key, scope);
      const receipt = await readNativeDeliveryReceipt(tx, this.key, scope);
      const intent = await readNativeTransmissionIntentReceipt(tx, this.key, scope);
      if (!envelope || envelope.frame.type !== "harness.native.dispatch" || !receipt || !intent
        || receipt.nodeReportedDisposition !== "recorded" || receipt.dispatchMessageId !== envelope.frame.messageId
        || receipt.queueId !== envelope.frame.body.queueId || receipt.packetDigest !== envelope.frame.body.packetDigest
        || intent.frameDigest !== sha256Digest(envelope.frame) || intent.messageId !== envelope.frame.messageId
        || Date.parse(receipt.receivedAt) > current() || Date.parse(receipt.recordedAt) > Date.parse(receipt.receivedAt)
        || Date.parse(receipt.recordedAt) < Date.parse(intent.requestedAt)) return fail();
      const body = envelope.frame.body, enrollment = this.enrollments.find(value => value.nodeId === body.request.nodeId);
      if (!enrollment) return fail();
      const prepared = prepareNativeTaskDispatchIntake(body, enrollment);
      const { binding } = verifyNativeTaskApprovalBinding(prepared.enrollment, prepared.request, prepared.start);
      // Node intake precedes possible execution; receipt network arrival can be later than progress.
      const run = nativeTaskRegistration(binding, body.inputDigest, body.request.leaseId, body.request.leaseEpoch, receipt.recordedAt);
      const joined: DatabaseClient = { query: tx.query.bind(tx), transaction: async work => work(tx),
        transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } };
      const saved = await new HarnessRunStoreV1(joined, this.harnessKey).create(run);
      if (!saved.replayed) { freshDeadline = binding.deadline; if (current() >= freshDeadline) return fail(); }
      return { run, replayed: saved.replayed, deadline: binding.deadline };
    }, () => { if (freshDeadline !== undefined && current() >= freshDeadline) return fail(); current(); });
    current();
    const bound = await this.results.register({ projectId: input.projectId, jobId: input.jobId, runId: registration.run.id }, signal, current);
    current(); return { receipt: bound.receipt, replayed: registration.replayed && bound.replayed };
  }
  /** Reattach only existing, authenticated evidence. No registration, planning or writes. */
  async recover(session: Pick<ServerNodeSession, "recoverNativeDelivery">,
    value: z.infer<typeof nativeEvidenceRegistrationSchema>, signal: AbortSignal) {
    const input = nativeEvidenceRegistrationSchema.parse(value), current = this.guard(signal), db = this.guarded(current);
    await session.recoverNativeDelivery(async channel => {
      const check = () => { current(); channel.assertCurrent(); };
      return db.transactionWithPreCommitCheck(async tx => {
        check(); await this.project(tx, input.projectId);
        const scope = { tenantId: this.scope.tenantId, ...input };
        const envelope = await readNativeDeliveryEnvelopeInSession(tx, this.key, scope);
        const receipt = await readNativeDeliveryReceipt(tx, this.key, scope);
        const intent = await readNativeTransmissionIntentReceipt(tx, this.key, scope);
        if (!envelope || envelope.frame.type !== "harness.native.dispatch" || !receipt || !intent
          || channel.tenantId !== scope.tenantId || envelope.nodeKeyId !== channel.nodeKeyId
          || envelope.frame.body.request.nodeId !== channel.nodeId
          || receipt.nodeReportedDisposition !== "recorded" || receipt.dispatchMessageId !== envelope.frame.messageId
          || receipt.queueId !== envelope.frame.body.queueId || receipt.packetDigest !== envelope.frame.body.packetDigest
          || intent.frameDigest !== sha256Digest(envelope.frame) || intent.messageId !== envelope.frame.messageId
          || Date.parse(receipt.receivedAt) > current() || Date.parse(receipt.recordedAt) > Date.parse(receipt.receivedAt)
          || Date.parse(receipt.recordedAt) < Date.parse(intent.requestedAt)) return fail();
        const body = envelope.frame.body, enrollment = this.enrollments.find(entry => entry.nodeId === channel.nodeId);
        if (!enrollment) return fail();
        const prepared = prepareNativeTaskDispatchIntake(body, enrollment);
        const { binding } = verifyNativeTaskApprovalBinding(prepared.enrollment, prepared.request, prepared.start);
        const expected = nativeTaskRegistration(binding, body.inputDigest, body.request.leaseId, body.request.leaseEpoch, receipt.recordedAt);
        const joined: DatabaseClient = { query: tx.query.bind(tx), transaction: async work => work(tx),
          transactionWithPreCommitCheck: async (work, commitCheck) => { const result = await work(tx); await commitCheck(); return result; } };
        const saved = await new HarnessRunStoreV1(joined, this.harnessKey).get(scope.tenantId, expected.id);
        if (!saved) return fail();
        const initial = { ...saved, state: "discovered", cancelState: "not_requested",
          updatedAt: saved.createdAt, lastObservedAt: saved.createdAt };
        delete initial.startedAt; delete initial.finishedAt; delete initial.safeReasonCode;
        if (sha256Digest(initial) !== sha256Digest(expected)) return fail();
        // Historical lease identity must still exist; its expiry/state does not grant execution.
        const canonical = await tx.query(`SELECT j.id FROM control_jobs j
          JOIN control_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
          JOIN control_leases l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.id
          WHERE j.tenant_id=$1 AND j.id=$2 AND j.project_id=$3 AND a.id=$4 AND a.node_id=$5
            AND l.id=$6 AND l.node_id=$5 AND a.lease_epoch=$7 AND l.epoch=$7
            AND j.payload->>'inputDigest'=$8 FOR SHARE OF j,a,l`,
        [scope.tenantId, input.jobId, input.projectId, input.attemptId, channel.nodeId,
          body.request.leaseId, body.request.leaseEpoch, input.inputDigest]);
        if (canonical.rows.length !== 1) return fail();
        check(); return envelope.frame;
      }, check);
    });
    current(); return { recovered: true as const, grantsExecutionAuthority: false as const };
  }
  async receive(session: Pick<ServerNodeSession, "acceptNativeSnapshot">, raw: string | Uint8Array,
    bytes: Uint8Array | undefined, signal: AbortSignal) {
    const { raw: owned, bytes: content } = captureNativeEvidenceInput(raw, bytes);
    const accept = session.acceptNativeSnapshot.bind(session), current = this.guard(signal), db = this.guarded(current);
    const result = await accept(owned, async (frame, assertSessionCurrent) => {
      const check = () => { current(); assertSessionCurrent(); };
      check();
      if (frame.tenantId !== this.scope.tenantId || !this.enrollments.some(value => value.nodeId === frame.actorId)
        || content !== undefined && (frame.body.state !== "completed" || !frame.body.result)) return fail();
      await db.transaction(tx => this.project(tx, frame.body.projectId)); check();
      // Before the first progress write, reconcile the actual saved review binding.
      await this.results.register({ projectId: frame.body.projectId, jobId: frame.body.jobId, runId: frame.body.runId }, signal, check); check();
      const observed = await new HarnessRunStoreV1(db, this.harnessKey)
        .recordNativeSnapshot(frame.tenantId, frame.actorId, frame.body, check); check();
      let submitted: Awaited<ReturnType<TaskResultOperation["submit"]>> | undefined;
      if (content !== undefined) {
        await this.artifacts.capture(frame.tenantId, frame.actorId, frame.body, content, new Date(current()).toISOString(), check); check();
        submitted = await this.results.submit({ projectId: frame.body.projectId, jobId: frame.body.jobId, runId: frame.body.runId }, signal, check); check();
      }
      return { runId: observed.run.id, state: observed.run.state, replayed: observed.replayed,
        ...(submitted ? { submission: submitted.receipt } : {}), executionAuthorized: false as const };
    });
    current(); return result;
  }
}
