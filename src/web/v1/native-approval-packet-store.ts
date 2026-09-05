import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import { nativeTaskApprovalPacketSchema } from "../../harness/v1/native-approval-packet";
import { createNativeApprovalIntake } from "../../harness/v1/native-approval-intake";
import type { prepareNativeTaskApproval } from "../../harness/v1/native-task-approval-binding";
import type { NativeEnrollment } from "../../harness/v1/native-run-contracts";
import { enqueueNativeTaskInSession, readNativeTaskQueueInSession, type NativeTaskQueueScope } from "./native-task-queue";

type Trust = Omit<Parameters<typeof createNativeApprovalIntake>[1], "clock">;
type Prepared = ReturnType<typeof prepareNativeTaskApproval> & { enrollment: NativeEnrollment; inputDigest: string };
const recordSchema = z.object({ schema: z.literal("control-room.canonical-native-approval-packet/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, nodeId: localId,
  leaseId: localId, leaseEpoch: z.number().int().positive(), inputDigest: digestSchema,
  enrollmentDigest: digestSchema, operationDigest: digestSchema, bindingDigest: digestSchema,
  packetDigest: digestSchema, packet: nativeTaskApprovalPacketSchema,
  acceptedBy: localId, acceptedAt: z.string().datetime(),
}).strict();
type Record = z.infer<typeof recordSchema>;
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
  readQueueInSession(tx: DatabaseSession, scope: NativeTaskQueueScope) {
    return readNativeTaskQueueInSession(tx, this.key, scope);
  }
}
