import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema, nodeRecordSchema } from "../../domain/v1";
import { matchCodexTaskActivationV1, type CodexActivationFrameV1,
  type CodexDispatchFrameForActivationV1, type CodexDispatchReceiptFrameForActivationV1 } from "../../harness/codex-v1/activation-contract";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import { signedNodeFrameSchema, verifyNodeFrameSignature, type SignedNodeFrame } from "../../node-protocol/v1";
import type { CodexActivationChannel } from "../../node-control/server-node-session";
import { readCodexApprovalPacketInSession, type VerifiedCodexDeliveryAuthorityV1 } from "./codex-task-queue";
import { readCodexDeliveryEnvelopeInSession } from "./codex-delivery-envelope";
import { readCodexDeliveryReceiptEvidenceInSession } from "./codex-delivery-receipt";
import { readCodexTransmissionIntentReceipt } from "./codex-transmission-intent";
import { readNativeTaskQueueIntentInSession, type NativeTaskQueueScope } from "./native-task-queue";

const instant = z.string().datetime();
export const codexCurrentAdmissionSchemaV1 = z.object({
  schema: z.literal("control-room.codex-current-admission/v1"),
  tenantId: localId, projectId: localId, projectVersion: z.number().int().positive(), projectLifecycle: z.literal("active"),
  jobId: localId, jobVersion: z.number().int().nonnegative(), jobState: z.literal("leased"),
  attemptId: localId, attemptVersion: z.number().int().nonnegative(), attemptState: z.literal("leased"),
  leaseId: localId, leaseVersion: z.number().int().nonnegative(), leaseEpoch: z.number().int().positive(),
  leaseState: z.literal("active"), leaseExpiresAt: instant,
  nodeId: localId, nodeVersion: z.number().int().nonnegative(), nodeState: z.literal("active"),
  nodeKeyId: localId, nodeKeyState: z.literal("active"), nodeKeyValidFrom: instant, nodeKeyValidUntil: instant.nullable(),
  authorityDigest: digestSchema, authorityExpiresAt: instant,
  approvalKeyId: localId, approvalExpiresAt: instant, ownerTrustRevisionDigest: digestSchema,
  queueId: localId, dispatchMessageId: localId, dispatchFrameDigest: digestSchema,
  receiptMessageId: localId, receiptFrameDigest: digestSchema,
  permitDigest: digestSchema, inputDigest: digestSchema, operationDigest: digestSchema, effectClaimKey: digestSchema,
  enrollmentDigest: digestSchema, connectorProfileDigest: digestSchema, workspaceIntentDigest: digestSchema,
  configurationExpiresAt: instant, connectionId: localId, checkedAt: instant, admissionExpiresAt: instant,
}).strict();
export type CodexCurrentAdmissionV1 = z.infer<typeof codexCurrentAdmissionSchemaV1>;
export type CodexCurrentAdmissionBasisV1 = Omit<CodexCurrentAdmissionV1,
  "queueId" | "dispatchMessageId" | "dispatchFrameDigest" | "receiptMessageId" | "receiptFrameDigest"
  | "permitDigest" | "approvalExpiresAt" | "inputDigest" | "operationDigest" | "effectClaimKey"
  | "enrollmentDigest" | "connectorProfileDigest" | "workspaceIntentDigest" | "connectionId">;

const recordSchema = z.object({ schema: z.literal("control-room.codex-activation-transmission-intent/v1"),
  frame: signedNodeFrameSchema.refine(frame => frame.type === "harness.codex.dispatch.activation"),
  currentAdmission: codexCurrentAdmissionSchemaV1,
  dispatchFrameDigest: digestSchema, receiptFrameDigest: digestSchema,
  reservedAt: instant, reservedBy: localId }).strict();
type Record = z.infer<typeof recordSchema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string;
  activation_id: string; message_id: string; receipt_frame_digest: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("codex_activation_transmission_intent_unavailable"); };
const current = (check: () => void) => assertSynchronousFence(check, fail);
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key,
  { purpose: "codex-activation-transmission-intent/v1", record });
const scopeOf = (admission: CodexCurrentAdmissionV1): NativeTaskQueueScope => ({ tenantId: admission.tenantId,
  projectId: admission.projectId, jobId: admission.jobId, attemptId: admission.attemptId, inputDigest: admission.inputDigest });

function activationFrame(record: Record) {
  const parsed = record.frame as SignedNodeFrame;
  if (!parsed || parsed.type !== "harness.codex.dispatch.activation") return fail();
  return parsed as SignedNodeFrame<"harness.codex.dispatch.activation">;
}

export async function readCodexActivationTransmissionIntentInSession(tx: DatabaseSession, key: Uint8Array,
  scope: NativeTaskQueueScope) {
  const row = (await tx.query<Row>(`SELECT tenant_id,project_id,job_id,attempt_id,activation_id,message_id,
    receipt_frame_digest,record,auth_tag FROM control_codex_activation_transmission_intents
    WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3`, [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const record = recordSchema.parse(row.record), frame = activationFrame(record), admission = record.currentAdmission;
  const expected = Buffer.from(tag(key, record)), actual = Buffer.from(row.auth_tag);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
    || row.tenant_id !== admission.tenantId || row.project_id !== admission.projectId
    || row.job_id !== admission.jobId || row.attempt_id !== admission.attemptId
    || row.activation_id !== frame.body.activationId || row.message_id !== frame.messageId
    || row.receipt_frame_digest !== record.receiptFrameDigest
    || admission.tenantId !== scope.tenantId || admission.projectId !== scope.projectId
    || admission.jobId !== scope.jobId || admission.attemptId !== scope.attemptId
    || admission.inputDigest !== scope.inputDigest || frame.body.currentAdmissionDigest !== sha256Digest(admission)) return fail();
  return record;
}

async function assertCanonicalAdmission(tx: DatabaseSession, admission: CodexCurrentAdmissionV1) {
  const row = (await tx.query<{ project_lifecycle: string; project_version: number; job: unknown; attempt: unknown;
    lease: unknown; node: unknown; key_state: string; key_valid_from: string | Date; key_valid_until: string | Date | null }>(`SELECT
      h.lifecycle AS project_lifecycle,h.version AS project_version,j.payload AS job,a.payload AS attempt,
      l.payload AS lease,n.payload AS node,k.state AS key_state,k.valid_from AS key_valid_from,k.valid_until AS key_valid_until
    FROM control_manual_project_heads h
    JOIN control_jobs j ON j.tenant_id=h.tenant_id AND j.project_id=h.project_id
    JOIN control_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
    JOIN control_leases l ON l.tenant_id=j.tenant_id AND l.job_id=j.id AND l.attempt_id=a.id
    JOIN control_nodes n ON n.tenant_id=j.tenant_id AND n.id=a.node_id
    JOIN control_node_keys k ON k.tenant_id=n.tenant_id AND k.node_id=n.id AND k.id=n.identity_key_id
    WHERE h.tenant_id=$1 AND h.project_id=$2 AND j.id=$3 AND a.id=$4 AND l.id=$5 AND n.id=$6 AND k.id=$7
    FOR UPDATE OF h,j,a,l,n FOR SHARE OF k`, [admission.tenantId, admission.projectId, admission.jobId,
      admission.attemptId, admission.leaseId, admission.nodeId, admission.nodeKeyId])).rows[0];
  if (!row) return fail();
  const job = jobRecordSchema.parse(row.job), attempt = attemptRecordSchema.parse(row.attempt);
  const lease = leaseRecordSchema.parse(row.lease), node = nodeRecordSchema.parse(row.node);
  const keyFrom = new Date(row.key_valid_from).toISOString();
  const keyUntil = row.key_valid_until ? new Date(row.key_valid_until).toISOString() : null;
  if (row.project_lifecycle !== admission.projectLifecycle || Number(row.project_version) !== admission.projectVersion
    || job.id !== admission.jobId || job.version !== admission.jobVersion || job.state !== admission.jobState
    || job.inputDigest !== admission.inputDigest || job.authority.digest !== admission.authorityDigest
    || job.authority.expiresAt !== admission.authorityExpiresAt
    || attempt.id !== admission.attemptId || attempt.version !== admission.attemptVersion
    || attempt.state !== admission.attemptState || attempt.nodeId !== admission.nodeId
    || attempt.leaseEpoch !== admission.leaseEpoch || lease.id !== admission.leaseId
    || lease.version !== admission.leaseVersion || lease.state !== admission.leaseState
    || lease.epoch !== admission.leaseEpoch || lease.nodeId !== admission.nodeId
    || lease.expiresAt !== admission.leaseExpiresAt || node.id !== admission.nodeId
    || node.version !== admission.nodeVersion || node.state !== admission.nodeState
    || node.identityKeyId !== admission.nodeKeyId || row.key_state !== admission.nodeKeyState
    || keyFrom !== admission.nodeKeyValidFrom || keyUntil !== admission.nodeKeyValidUntil) return fail();
}

/** The record is both exact signed activation evidence and the only server send slot. */
export async function persistCodexActivationTransmissionIntent(tx: DatabaseSession, key: Uint8Array,
  frame: SignedNodeFrame<"harness.codex.dispatch.activation">,
  dispatch: SignedNodeFrame<"harness.codex.dispatch">, receipt: SignedNodeFrame<"harness.codex.dispatch.receipt">,
  admissionValue: CodexCurrentAdmissionV1, channel: CodexActivationChannel, actorId: string, now: number,
  authority: VerifiedCodexDeliveryAuthorityV1) {
  const admission = codexCurrentAdmissionSchemaV1.parse(admissionValue), scope = scopeOf(admission);
  current(channel.assertCurrent); current(authority.assertFresh);
  const savedEnvelope = await readCodexDeliveryEnvelopeInSession(tx, key, scope);
  const savedTransmission = await readCodexTransmissionIntentReceipt(tx, key, scope);
  const savedReceipt = await readCodexDeliveryReceiptEvidenceInSession(tx, key, scope);
  const queued = await readNativeTaskQueueIntentInSession(tx, key, scope);
  const approval = await readCodexApprovalPacketInSession(tx, key, scope);
  await assertCanonicalAdmission(tx, admission);
  const body = matchCodexTaskActivationV1(frame as unknown as CodexActivationFrameV1, {
    dispatch: dispatch as unknown as CodexDispatchFrameForActivationV1,
    receipt: receipt as unknown as CodexDispatchReceiptFrameForActivationV1,
    currentAdmissionDigest: sha256Digest(admission), receiptReceivedAt: savedReceipt?.receivedAt ?? "" });
  const checkedAt = Date.parse(admission.checkedAt), expiresAt = Date.parse(admission.admissionExpiresAt);
  if (!Number.isSafeInteger(now) || !savedEnvelope || !savedTransmission || !savedReceipt || !queued || !approval
    || receipt.body.disposition !== "recorded" || receipt.body.safeReason !== "none"
    || sha256Digest(savedEnvelope.frame) !== sha256Digest(dispatch)
    || savedTransmission.frameDigest !== sha256Digest(dispatch)
    || sha256Digest(savedReceipt.frame) !== sha256Digest(receipt)
    || savedReceipt.dispatchFrameDigest !== sha256Digest(dispatch)
    || approval.body.permitDigest !== admission.permitDigest || approval.packetDigest !== queued.packetDigest
    || `native-queue:${sha256Digest({ tenantId: queued.tenantId, jobId: queued.jobId,
      attemptId: queued.attemptId }).slice(7)}` !== admission.queueId || queued.operationDigest !== admission.operationDigest
    || queued.enrollmentDigest !== admission.enrollmentDigest || queued.nodeId !== admission.nodeId
    || queued.leaseId !== admission.leaseId || queued.leaseEpoch !== admission.leaseEpoch
    || dispatch.body.start.effectClaimKey !== admission.effectClaimKey
    || dispatch.connectionId !== admission.connectionId || dispatch.messageId !== admission.dispatchMessageId
    || receipt.messageId !== admission.receiptMessageId || sha256Digest(dispatch) !== admission.dispatchFrameDigest
    || sha256Digest(receipt) !== admission.receiptFrameDigest
    || dispatch.body.permit.body.approvalKeyId !== admission.approvalKeyId
    || dispatch.body.permit.body.expiresAt !== admission.approvalExpiresAt
    || authority.deliveryBodyDigest !== dispatch.bodyDigest || authority.permitDigest !== admission.permitDigest
    || authority.enrollmentDigest !== admission.enrollmentDigest
    || authority.connectorProfileDigest !== admission.connectorProfileDigest
    || authority.workspaceIntentDigest !== admission.workspaceIntentDigest
    || frame.tenantId !== channel.tenantId || frame.actorId !== channel.serverId || frame.keyId !== channel.serverKeyId
    || frame.connectionId !== channel.connectionId || channel.nodeId !== admission.nodeId
    || channel.nodeKeyId !== admission.nodeKeyId || !verifyNodeFrameSignature(frame, channel.serverPublicKeySpki)
    || Buffer.byteLength(JSON.stringify(frame)) > channel.maxFrameBytes
    || !Number.isFinite(checkedAt) || !Number.isFinite(expiresAt) || checkedAt > now || now >= expiresAt
    || now < Date.parse(body.activatedAt) || now >= Date.parse(frame.expiresAt)
    || Date.parse(frame.expiresAt) > expiresAt || Date.parse(frame.expiresAt) > Date.parse(channel.expiresAt)
    || Date.parse(frame.expiresAt) > Date.parse(admission.configurationExpiresAt)
    || await readCodexActivationTransmissionIntentInSession(tx, key, scope)) return fail();
  const record = recordSchema.parse({ schema: "control-room.codex-activation-transmission-intent/v1", frame,
    currentAdmission: admission, dispatchFrameDigest: sha256Digest(dispatch), receiptFrameDigest: sha256Digest(receipt),
    reservedAt: new Date(now).toISOString(), reservedBy: actorId });
  await tx.query(`INSERT INTO control_codex_activation_transmission_intents
    (tenant_id,project_id,job_id,attempt_id,activation_id,message_id,receipt_frame_digest,record,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [admission.tenantId, admission.projectId, admission.jobId,
      admission.attemptId, frame.body.activationId, frame.messageId, admission.receiptFrameDigest, record, tag(key, record)]);
  current(authority.assertFresh); current(channel.assertCurrent);
  return Object.freeze({ projectId: admission.projectId, jobId: admission.jobId, attemptId: admission.attemptId,
    queueId: admission.queueId, activationId: frame.body.activationId, messageId: frame.messageId,
    connectionId: frame.connectionId, dispatchFrameDigest: record.dispatchFrameDigest,
    receiptFrameDigest: record.receiptFrameDigest, currentAdmissionDigest: frame.body.currentAdmissionDigest,
    activationDigest: frame.body.activationDigest, reservedAt: record.reservedAt,
    evidence: "stored_codex_activation_transmission_intent" as const, transportConfirmed: false as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
}

export async function readCodexActivationTransmissionIntentReceipt(tx: DatabaseSession, key: Uint8Array,
  scope: NativeTaskQueueScope) {
  const record = await readCodexActivationTransmissionIntentInSession(tx, key, scope);
  if (!record) return null;
  const frame = activationFrame(record), admission = record.currentAdmission;
  return Object.freeze({ projectId: admission.projectId, jobId: admission.jobId, attemptId: admission.attemptId,
    queueId: admission.queueId, activationId: frame.body.activationId, messageId: frame.messageId,
    connectionId: frame.connectionId, dispatchFrameDigest: record.dispatchFrameDigest,
    receiptFrameDigest: record.receiptFrameDigest, currentAdmissionDigest: frame.body.currentAdmissionDigest,
    activationDigest: frame.body.activationDigest, reservedAt: record.reservedAt,
    evidence: "stored_codex_activation_transmission_intent" as const, transportConfirmed: false as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
}
