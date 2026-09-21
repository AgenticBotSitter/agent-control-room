import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import { nativeTaskApprovalPacketSchema } from "../../harness/v1/native-approval-packet";
import { createNativeApprovalIntake } from "../../harness/v1/native-approval-intake";
import type { prepareNativeTaskApproval } from "../../harness/v1/native-task-approval-binding";
import type { NativeEnrollment } from "../../harness/v1/native-run-contracts";
import { enqueueNativeTaskInSession, readNativeTaskQueueInSession, readNativeTaskQueueIntentInSession,
  type NativeTaskQueueIntent, type NativeTaskQueueScope } from "./native-task-queue";
import { persistNativeDeliveryPreparation, readNativeDeliveryPreparationReceipt, readNativeDeliveryPreparationInSession } from "./native-delivery-preparation";
import { assertNativeDeliveryEnvelopeAbsent, persistNativeDeliveryEnvelope, readNativeDeliveryEnvelopeReceipt } from "./native-delivery-envelope";
import type { ServerNodeSession, NativeEnvelopeChannel } from "../../node-control/server-node-session";
import type { SignedNodeFrame, NodeMessageBodyMap } from "../../node-protocol/v1";
import { persistNativeTransmissionIntent, readNativeTransmissionIntentReceipt } from "./native-transmission-intent";
import { nativeTaskDispatchBodySchema } from "../../harness/v1/native-delivery";
import { persistNativeDeliveryReceipt, readNativeDeliveryReceipt } from "./native-delivery-receipt";

type Trust = Omit<Parameters<typeof createNativeApprovalIntake>[1], "clock">;
type Prepared = ReturnType<typeof prepareNativeTaskApproval> & { enrollment: NativeEnrollment; inputDigest: string; leaseGrant?: NodeMessageBodyMap["job.lease.grant"] };
const recordSchema = z.object({ schema: z.literal("control-room.canonical-native-approval-packet/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, nodeId: localId,
  leaseId: localId, leaseEpoch: z.number().int().positive(), inputDigest: digestSchema,
  enrollmentDigest: digestSchema, operationDigest: digestSchema, bindingDigest: digestSchema,
  packetDigest: digestSchema, packet: nativeTaskApprovalPacketSchema,
  acceptedBy: localId, acceptedAt: z.string().datetime(),
}).strict();
type Record = z.infer<typeof recordSchema>;
/**
 * A deliberately narrow sibling record for the pinned local Hermes contract.
 * The shared queue has a foreign key to this table, so every queued harness
 * must leave durable, HMAC-protected approval evidence.  This is not an old
 * native approval packet and never contains a Hermes command or credential.
 */
const hermes021QueueApprovalSchema = z.object({
  schema: z.literal("control-room.canonical-hermes-021-local-queue-approval/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, nodeId: localId,
  leaseId: localId, leaseEpoch: z.number().int().positive(), inputDigest: digestSchema,
  packetDigest: digestSchema, operationDigest: digestSchema, bindingDigest: digestSchema,
  enrollmentDigest: digestSchema, planDigest: digestSchema, acceptedBy: localId, acceptedAt: z.string().datetime(),
}).strict();
type Hermes021QueueApproval = z.infer<typeof hermes021QueueApprovalSchema>;
/** Same existing receipt table and queue, but a distinct tagged record for the
 * local Claude contract. It cannot be confused with Hermes evidence. */
const claudeCodeLocalQueueApprovalSchema = z.object({
  schema: z.literal("control-room.canonical-claude-code-local-queue-approval/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, nodeId: localId,
  leaseId: localId, leaseEpoch: z.number().int().positive(), inputDigest: digestSchema,
  packetDigest: digestSchema, operationDigest: digestSchema, bindingDigest: digestSchema,
  enrollmentDigest: digestSchema, planDigest: digestSchema, acceptedBy: localId, acceptedAt: z.string().datetime(),
}).strict();
type ClaudeCodeLocalQueueApproval = z.infer<typeof claudeCodeLocalQueueApprovalSchema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("native_approval_packet_unavailable"); };

/** Trusted transaction collaborator, not an authenticated web service. The coordinator must hold its
 * canonical reservation and owner/session locks and invoke the returned fence before commit.
 * Owner public trust is explicit; no keys are loaded, signed, installed or rotated here.
 */
export class NativeApprovalPacketStore {
  private readonly key: Uint8Array;
  private readonly trust: Map<string, Trust>;
  constructor(key: Uint8Array, trust: readonly Trust[], private readonly clock: () => number = Date.now) {
    if (!(key instanceof Uint8Array) || key.length !== 32 || trust.length > 64) fail();
    this.key = Uint8Array.from(key); this.trust = new Map();
    for (const source of trust) {
      const scope = source.approvals.binding(), id = sha256Digest(scope);
      if (this.trust.has(id)) fail();
      this.trust.set(id, { approvals: source.approvals,
        security: { currentServerTrustRevision: source.security.currentServerTrustRevision.bind(source.security) } });
    }
  }
  private tag(record: Record) { return hmacSha256Tag(this.key, { purpose: "canonical-native-approval-packet/v1", record }); }
  private hermes021Tag(record: Hermes021QueueApproval) {
    return hmacSha256Tag(this.key, { purpose: "canonical-hermes-021-local-queue-approval/v1", record });
  }
  private claudeCodeLocalTag(record: ClaudeCodeLocalQueueApproval) {
    return hmacSha256Tag(this.key, { purpose: "canonical-claude-code-local-queue-approval/v1", record });
  }
  private verify(row: Row) {
    const record = recordSchema.parse(row.record), expected = Buffer.from(this.tag(record)), actual = Buffer.from(row.auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
      || row.tenant_id !== record.tenantId || row.project_id !== record.projectId || row.job_id !== record.jobId
      || row.attempt_id !== record.attemptId || record.packetDigest !== sha256Digest(record.packet)) fail();
    return record;
  }
  /** Authenticated coordinator readback only. Historical evidence is not a current permission check. */
  async readInSession(tx: DatabaseSession, scope: { tenantId: string; projectId: string; jobId: string; attemptId: string; inputDigest: string }) {
    const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_approval_packets WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
      [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
    if (!row) return null;
    const record = this.verify(row);
    if (record.tenantId !== scope.tenantId || record.projectId !== scope.projectId || record.jobId !== scope.jobId
      || record.attemptId !== scope.attemptId || record.inputDigest !== scope.inputDigest) fail();
    return { projectId: record.projectId, jobId: record.jobId, attemptId: record.attemptId,
      packetDigest: record.packetDigest, operationDigest: record.operationDigest, acceptedAt: record.acceptedAt,
      evidence: "stored_signatures_only" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  }
  async acceptInSession(tx: DatabaseSession, prepared: Prepared, packet: unknown, acceptedBy: string, signal: AbortSignal) {
    const r = prepared.request, trust = this.trust.get(sha256Digest({ tenantId: r.tenantId, nodeId: r.nodeId, nodeClass: r.nodeClass }));
    if (!trust) return fail();
    const verified = await createNativeApprovalIntake(prepared, { ...trust, clock: this.clock })(packet, signal);
    const signed = nativeTaskApprovalPacketSchema.parse({ schema: "control-room.native-task-approval-packet/v1",
      approval: verified.request.approval, recovery: verified.recoveryPermission });
    const record = recordSchema.parse({ schema: "control-room.canonical-native-approval-packet/v1",
      tenantId: r.tenantId, projectId: r.projectId, jobId: r.jobId, attemptId: r.attemptId, nodeId: r.nodeId,
      leaseId: r.leaseId, leaseEpoch: r.leaseEpoch, inputDigest: prepared.inputDigest,
      enrollmentDigest: sha256Digest(prepared.enrollment), operationDigest: r.operationDigest,
      bindingDigest: sha256Digest(verified.binding), packetDigest: verified.packetDigest, packet: signed,
      acceptedBy, acceptedAt: new Date(this.clock()).toISOString() });
    const rows = await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_approval_packets WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
      [r.tenantId, r.jobId, r.attemptId]);
    const prior = rows.rows[0] ? this.verify(rows.rows[0]) : undefined;
    if (prior) {
      const content = ({ acceptedBy: _actor, acceptedAt: _at, ...value }: Record) => { void _actor; void _at; return value; };
      if (sha256Digest(content(prior)) !== sha256Digest(content(record))) fail();
    } else await tx.query("INSERT INTO control_native_approval_packets (tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES ($1,$2,$3,$4,$5,$6)",
      [r.tenantId, r.projectId, r.jobId, r.attemptId, record, this.tag(record)]);
    const assertFresh = () => { if (signal.aborted) fail(); verified.assertFresh(); };
    assertFresh(); const saved = prior ?? record;
    return { assertFresh, receipt: { projectId: saved.projectId, jobId: saved.jobId, attemptId: saved.attemptId,
      packetDigest: saved.packetDigest, operationDigest: saved.operationDigest, acceptedAt: saved.acceptedAt,
      replayed: !!prior, startsWork: false as const, grantsExecutionAuthority: false as const } };
  }
  /** Internal dispatch preparation only: reauthenticate immutable evidence against the locked current
   * reservation and current owner pins. Historical receipts must never enter this path as authority.
   * The caller holds canonical locks and must run assertFresh before committing; the returned material
   * is a snapshot, not permission to execute later without node-side admission.
   */
  async revalidateInSession(tx: DatabaseSession, prepared: Prepared, expectedPacketDigest: string, signal: AbortSignal) {
    digestSchema.parse(expectedPacketDigest);
    if (signal.aborted) return fail();
    const r = prepared.request;
    const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_approval_packets WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
      [r.tenantId, r.jobId, r.attemptId])).rows[0];
    if (!row) return fail();
    const record = this.verify(row);
    if (record.tenantId !== r.tenantId || record.projectId !== r.projectId || record.jobId !== r.jobId
      || record.attemptId !== r.attemptId || record.nodeId !== r.nodeId || record.leaseId !== r.leaseId
      || record.leaseEpoch !== r.leaseEpoch || record.inputDigest !== prepared.inputDigest
      || record.enrollmentDigest !== sha256Digest(prepared.enrollment) || record.operationDigest !== r.operationDigest
      || record.bindingDigest !== sha256Digest(prepared.binding) || record.packetDigest !== expectedPacketDigest) return fail();
    const trust = this.trust.get(sha256Digest({ tenantId: r.tenantId, nodeId: r.nodeId, nodeClass: r.nodeClass }));
    if (!trust) return fail();
    const verified = await createNativeApprovalIntake(prepared, { ...trust, clock: this.clock })(record.packet, signal);
    const assertFresh = () => { if (signal.aborted) fail(); verified.assertFresh(); };
    assertFresh();
    return { ...verified, assertFresh };
  }
  async enqueueInSession(tx: DatabaseSession, prepared: Prepared, expectedPacketDigest: string, actorId: string, signal: AbortSignal) {
    const verified = await this.revalidateInSession(tx, prepared, expectedPacketDigest, signal), r = prepared.request;
    const receipt = await enqueueNativeTaskInSession(tx, this.key, {
      schema: "control-room.native-task-queue/v1", tenantId: r.tenantId, projectId: r.projectId, jobId: r.jobId,
      attemptId: r.attemptId, nodeId: r.nodeId, leaseId: r.leaseId, leaseEpoch: r.leaseEpoch,
      inputDigest: prepared.inputDigest, packetDigest: verified.packetDigest, operationDigest: r.operationDigest,
      bindingDigest: sha256Digest(verified.binding), enrollmentDigest: sha256Digest(prepared.enrollment),
      deadline: prepared.start.deadline, queuedAt: new Date(this.clock()).toISOString(), queuedBy: actorId,
    });
    verified.assertFresh(); return { receipt, assertFresh: verified.assertFresh };
  }
  /**
   * Shared queue storage for the newer local Hermes contract.  The caller has
   * already reconstructed and locked its canonical plan, lease and current
   * owner permission; this helper supplies only the existing queue HMAC.  It
   * deliberately cannot create or reinterpret a legacy signed approval.
   */
  async enqueueHermes021LocalInSession(tx: DatabaseSession, intent: NativeTaskQueueIntent, planDigest: string) {
    const value = { ...intent, deliveryKind: "hermes-021-macos-local" as const };
    const r = z.object({ schema: z.literal("control-room.native-task-queue/v1"), tenantId: localId,
      projectId: localId, jobId: localId, attemptId: localId, nodeId: localId, leaseId: localId,
      leaseEpoch: z.number().int().positive(), inputDigest: digestSchema, packetDigest: digestSchema,
      operationDigest: digestSchema, bindingDigest: digestSchema, enrollmentDigest: digestSchema,
      deadline: z.number().int().nonnegative(), queuedAt: z.string().datetime(), queuedBy: localId,
      deliveryKind: z.literal("hermes-021-macos-local") }).strict().parse(value);
    const approval = hermes021QueueApprovalSchema.parse({
      schema: "control-room.canonical-hermes-021-local-queue-approval/v1", tenantId: r.tenantId,
      projectId: r.projectId, jobId: r.jobId, attemptId: r.attemptId, nodeId: r.nodeId, leaseId: r.leaseId,
      leaseEpoch: r.leaseEpoch, inputDigest: r.inputDigest, packetDigest: r.packetDigest,
      operationDigest: r.operationDigest, bindingDigest: r.bindingDigest, enrollmentDigest: r.enrollmentDigest,
      planDigest: digestSchema.parse(planDigest), acceptedBy: r.queuedBy, acceptedAt: r.queuedAt,
    });
    const rows = await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_approval_packets WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
      [r.tenantId, r.jobId, r.attemptId]);
    const prior = rows.rows[0];
    if (prior) {
      const record = hermes021QueueApprovalSchema.parse(prior.record);
      const expected = Buffer.from(this.hermes021Tag(record)), actual = Buffer.from(prior.auth_tag);
      const stable = ({ acceptedBy: _actor, acceptedAt: _at, ...value }: Hermes021QueueApproval) => { void _actor; void _at; return value; };
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
        || prior.tenant_id !== record.tenantId || prior.project_id !== record.projectId
        || prior.job_id !== record.jobId || prior.attempt_id !== record.attemptId
        || sha256Digest(stable(record)) !== sha256Digest(stable(approval))) fail();
    } else await tx.query("INSERT INTO control_native_approval_packets(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6)",
      [r.tenantId, r.projectId, r.jobId, r.attemptId, approval, this.hermes021Tag(approval)]);
    return enqueueNativeTaskInSession(tx, this.key, r);
  }
  /** Verified historical local-Hermes queue evidence.  It is intentionally
   * separate from `readInSession`, which understands only the legacy signed
   * native packet format.  A caller must still recheck current authority. */
  async readHermes021LocalQueueApprovalInSession(tx: DatabaseSession,
    scope: { tenantId: string; projectId: string; jobId: string; attemptId: string; inputDigest: string }) {
    const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_approval_packets WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
      [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
    if (!row) return null;
    const record = hermes021QueueApprovalSchema.parse(row.record);
    const expected = Buffer.from(this.hermes021Tag(record)), actual = Buffer.from(row.auth_tag);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
      || row.tenant_id !== record.tenantId || row.project_id !== record.projectId
      || row.job_id !== record.jobId || row.attempt_id !== record.attemptId
      || record.tenantId !== scope.tenantId || record.projectId !== scope.projectId
      || record.jobId !== scope.jobId || record.attemptId !== scope.attemptId
      || record.inputDigest !== scope.inputDigest) fail();
    return record;
  }
  /** Claude uses the same durable queue and table family as Hermes, with a
   * different authenticated record type so a receipt cannot cross adapters. */
  async enqueueClaudeCodeLocalInSession(tx: DatabaseSession, intent: NativeTaskQueueIntent, planDigest: string) {
    const value = { ...intent, deliveryKind: "claude-code-local" as const };
    const r = z.object({ schema: z.literal("control-room.native-task-queue/v1"), tenantId: localId,
      projectId: localId, jobId: localId, attemptId: localId, nodeId: localId, leaseId: localId,
      leaseEpoch: z.number().int().positive(), inputDigest: digestSchema, packetDigest: digestSchema,
      operationDigest: digestSchema, bindingDigest: digestSchema, enrollmentDigest: digestSchema,
      deadline: z.number().int().nonnegative(), queuedAt: z.string().datetime(), queuedBy: localId,
      deliveryKind: z.literal("claude-code-local") }).strict().parse(value);
    const approval = claudeCodeLocalQueueApprovalSchema.parse({
      schema: "control-room.canonical-claude-code-local-queue-approval/v1", tenantId: r.tenantId,
      projectId: r.projectId, jobId: r.jobId, attemptId: r.attemptId, nodeId: r.nodeId, leaseId: r.leaseId,
      leaseEpoch: r.leaseEpoch, inputDigest: r.inputDigest, packetDigest: r.packetDigest,
      operationDigest: r.operationDigest, bindingDigest: r.bindingDigest, enrollmentDigest: r.enrollmentDigest,
      planDigest: digestSchema.parse(planDigest), acceptedBy: r.queuedBy, acceptedAt: r.queuedAt,
    });
    const rows = await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_approval_packets WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
      [r.tenantId, r.jobId, r.attemptId]);
    const prior = rows.rows[0];
    if (prior) {
      const record = claudeCodeLocalQueueApprovalSchema.parse(prior.record);
      const expected = Buffer.from(this.claudeCodeLocalTag(record)), actual = Buffer.from(prior.auth_tag);
      const stable = ({ acceptedBy: _actor, acceptedAt: _at, ...value }: ClaudeCodeLocalQueueApproval) => { void _actor; void _at; return value; };
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
        || prior.tenant_id !== record.tenantId || prior.project_id !== record.projectId
        || prior.job_id !== record.jobId || prior.attempt_id !== record.attemptId
        || sha256Digest(stable(record)) !== sha256Digest(stable(approval))) fail();
    } else await tx.query("INSERT INTO control_native_approval_packets(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6)",
      [r.tenantId, r.projectId, r.jobId, r.attemptId, approval, this.claudeCodeLocalTag(approval)]);
    return enqueueNativeTaskInSession(tx, this.key, r);
  }
  async readClaudeCodeLocalQueueApprovalInSession(tx: DatabaseSession,
    scope: { tenantId: string; projectId: string; jobId: string; attemptId: string; inputDigest: string }) {
    const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_approval_packets WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
      [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
    if (!row) return null;
    const record = claudeCodeLocalQueueApprovalSchema.parse(row.record);
    const expected = Buffer.from(this.claudeCodeLocalTag(record)), actual = Buffer.from(row.auth_tag);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
      || row.tenant_id !== record.tenantId || row.project_id !== record.projectId
      || row.job_id !== record.jobId || row.attempt_id !== record.attemptId
      || record.tenantId !== scope.tenantId || record.projectId !== scope.projectId
      || record.jobId !== scope.jobId || record.attemptId !== scope.attemptId
      || record.inputDigest !== scope.inputDigest) fail();
    return record;
  }
  readQueueInSession(tx: DatabaseSession, scope: NativeTaskQueueScope) {
    return readNativeTaskQueueInSession(tx, this.key, scope);
  }
  /** Internal verified evidence for server delivery. Not execution permission;
   * caller must recheck current grants, canonical state and signed packet. */
  readQueueIntentInSession(tx: DatabaseSession, scope: NativeTaskQueueScope) {
    return readNativeTaskQueueIntentInSession(tx, this.key, scope);
  }
  async prepareDeliveryInSession(tx: DatabaseSession, prepared: Prepared, expectedPacketDigest: string, actorId: string, signal: AbortSignal) {
    const v = await this.revalidateInSession(tx, prepared, expectedPacketDigest, signal), r = prepared.request;
    const body = nativeTaskDispatchBodySchema.parse({ schema: "control-room.native-task-dispatch/v1",
      queueId: `native-queue:${sha256Digest({ tenantId: r.tenantId, jobId: r.jobId, attemptId: r.attemptId }).slice(7)}`,
      inputDigest: prepared.inputDigest, enrollmentDigest: sha256Digest(prepared.enrollment), bindingDigest: sha256Digest(v.binding),
      packetDigest: v.packetDigest, request: r, start: v.start, packet: { schema: "control-room.native-task-approval-packet/v1", approval: v.request.approval, recovery: v.recoveryPermission } });
    const receipt = await persistNativeDeliveryPreparation(tx, this.key, body, actorId, this.clock());
    v.assertFresh(); return { receipt, assertFresh: v.assertFresh };
  }
  readDeliveryPreparationInSession(tx: DatabaseSession, scope: NativeTaskQueueScope) {
    return readNativeDeliveryPreparationReceipt(tx, this.key, scope);
  }
  async stageDeliveryEnvelopeInSession(tx: DatabaseSession, prepared: Prepared, expectedPacketDigest: string, actorId: string,
    signal: AbortSignal, sign: Parameters<Parameters<ServerNodeSession["stageNativeDispatch"]>[0]>[0], channel: NativeEnvelopeChannel, deadline: number,
    signLease?: Parameters<Parameters<ServerNodeSession["stageNativeDispatch"]>[0]>[2]) {
    const p = await this.prepareDeliveryInSession(tx, prepared, expectedPacketDigest, actorId, signal);
    const scope = { tenantId: prepared.request.tenantId, projectId: prepared.request.projectId, jobId: prepared.request.jobId,
      attemptId: prepared.request.attemptId, inputDigest: prepared.inputDigest };
    await assertNativeDeliveryEnvelopeAbsent(tx, this.key, scope);
    const saved = await readNativeDeliveryPreparationInSession(tx, this.key, scope);
    if (!saved) throw new Error("native_delivery_preparation_unavailable");
    p.assertFresh(); channel.assertCurrent();
    const frame = await sign(saved.body, deadline);
    if (channel.leaseDelivery && (!signLease || !prepared.leaseGrant)) return fail();
    const leaseFrame = channel.leaseDelivery ? await signLease!(prepared.leaseGrant!) : undefined;
    p.assertFresh(); channel.assertCurrent();
    const receipt = await persistNativeDeliveryEnvelope(tx, this.key, frame, channel, actorId, this.clock(), leaseFrame);
    const assertFresh = () => { p.assertFresh(); channel.assertCurrent(); };
    assertFresh(); return { receipt, assertFresh };
  }
  readDeliveryEnvelopeInSession(tx: DatabaseSession, scope: NativeTaskQueueScope) {
    return readNativeDeliveryEnvelopeReceipt(tx, this.key, scope);
  }
  async recordTransmissionInSession(tx: DatabaseSession, prepared: Prepared, expectedPacketDigest: string, actorId: string,
    signal: AbortSignal, frame: SignedNodeFrame<"harness.native.dispatch">, channel: NativeEnvelopeChannel, leaseFrame?: SignedNodeFrame<"job.lease.grant">) {
    const p = await this.prepareDeliveryInSession(tx, prepared, expectedPacketDigest, actorId, signal);
    if (frame.bodyDigest !== p.receipt.bodyDigest) throw new Error("native_transmission_body_mismatch");
    if (leaseFrame && (!prepared.leaseGrant || sha256Digest(leaseFrame.body) !== sha256Digest(prepared.leaseGrant))) return fail();
    const receipt = await persistNativeTransmissionIntent(tx, this.key, frame, channel, actorId, this.clock(), leaseFrame);
    const assertFresh = () => { p.assertFresh(); channel.assertCurrent(); };
    assertFresh(); return { receipt, assertFresh };
  }
  readTransmissionInSession(tx: DatabaseSession, scope: NativeTaskQueueScope) {
    return readNativeTransmissionIntentReceipt(tx, this.key, scope);
  }
  readReceiptInSession(tx: DatabaseSession, scope: NativeTaskQueueScope) {
    return readNativeDeliveryReceipt(tx, this.key, scope);
  }
  /** Trusted node router only, not owner approval or a mounted browser operation. */
  async receiveDeliveryReceipt(db: DatabaseClient, session: ServerNodeSession, raw: string | Uint8Array, signal: AbortSignal) {
    if (signal.aborted) return fail();
    return session.acceptNativeReceipt(raw, async (frame, dispatch, assertCurrent) => {
      let fence = () => { if (signal.aborted) fail(); assertCurrent(); };
      const value = await db.transactionWithPreCommitCheck(async tx => {
        const check = fence;
        const result = await persistNativeDeliveryReceipt(tx, this.key, frame, dispatch, this.clock, check);
        fence = () => { check(); result.assertFresh(); };
        await appendAuditWith(tx, { id: `audit:native-receipt:${frame.body.queueId}`, tenantId: frame.tenantId,
          projectId: frame.body.projectId, actorId: frame.actorId, actorType: "worker",
          action: "native.delivery.receipt_recorded", targetType: "attempt", targetId: frame.body.attemptId,
          occurredAt: result.value.receivedAt, safeMetadata: { receiptFrameDigest: sha256Digest(frame),
            disposition: frame.body.disposition, safeReason: frame.body.safeReason } });
        fence(); return result.value;
      }, () => fence());
      fence(); return value;
    });
  }
}
