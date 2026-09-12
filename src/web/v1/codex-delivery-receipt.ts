import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { codexTaskDispatchReceiptBodySchemaV1, matchCodexTaskDispatchReceiptV1 } from "../../harness/codex-v1/delivery-contract";
import { digestSchema } from "../../harness/v1/native-run-identifiers";
import { signedNodeFrameSchema, verifyNodeFrameSignature, type SignedNodeFrame } from "../../node-protocol/v1";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import type { NativeTaskQueueScope } from "./native-task-queue";
import { readCodexDeliveryEnvelopeInSession } from "./codex-delivery-envelope";
import { readCodexTransmissionIntentReceipt } from "./codex-transmission-intent";

const schema = z.object({ schema: z.literal("control-room.codex-delivery-receipt/v1"),
  frame: signedNodeFrameSchema.refine(frame => frame.type === "harness.codex.dispatch.receipt"),
  inputDigest: digestSchema, dispatchFrameDigest: digestSchema, receivedAt: z.string().datetime() }).strict();
type Record = z.infer<typeof schema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("codex_delivery_receipt_unavailable"); };
const synchronous = (check: () => void) => assertSynchronousFence(check, fail);
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key, { purpose: "codex-delivery-receipt/v1", record });
const bodyOf = (record: Record) => {
  if (record.frame.type !== "harness.codex.dispatch.receipt") return fail();
  return codexTaskDispatchReceiptBodySchemaV1.parse(record.frame.body);
};
const receipt = (record: Record) => {
  const body = bodyOf(record);
  return { projectId: body.projectId, jobId: body.jobId, attemptId: body.attemptId, queueId: body.queueId,
    dispatchMessageId: body.dispatchMessageId, receiptMessageId: record.frame.messageId, dispatchBodyDigest: body.dispatchBodyDigest,
    permitDigest: body.permitDigest, enrollmentDigest: body.enrollmentDigest, nodeReportedDisposition: body.disposition,
    safeReason: body.safeReason, recordedAt: body.recordedAt, receivedAt: record.receivedAt,
    evidence: "stored_authenticated_codex_node_receipt" as const, startsWork: false as const,
    executionConfirmed: false as const, grantsExecutionAuthority: false as const };
};

export async function readCodexDeliveryReceiptEvidenceInSession(tx: DatabaseSession, key: Uint8Array,
  scope: NativeTaskQueueScope) {
  const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_codex_delivery_receipts WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
    [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const record = schema.parse(row.record), body = bodyOf(record), expected = Buffer.from(tag(key, record)), actual = Buffer.from(row.auth_tag);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || record.inputDigest !== scope.inputDigest
    || row.tenant_id !== body.tenantId || row.project_id !== body.projectId || row.job_id !== body.jobId || row.attempt_id !== body.attemptId
    || body.tenantId !== scope.tenantId || body.projectId !== scope.projectId || body.jobId !== scope.jobId || body.attemptId !== scope.attemptId
    || record.frame.bodyDigest !== sha256Digest(body)) return fail();
  return Object.freeze({ frame: record.frame as SignedNodeFrame<"harness.codex.dispatch.receipt">,
    inputDigest: record.inputDigest, dispatchFrameDigest: record.dispatchFrameDigest,
    receivedAt: record.receivedAt });
}

export async function readCodexDeliveryReceipt(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const evidence = await readCodexDeliveryReceiptEvidenceInSession(tx, key, scope);
  if (!evidence) return null;
  return receipt(schema.parse({ schema: "control-room.codex-delivery-receipt/v1", ...evidence }));
}

/** Called only from authenticated Codex receipt handling. It records receipt evidence and grants no authority. */
export async function persistCodexDeliveryReceipt(tx: DatabaseSession, key: Uint8Array,
  frame: SignedNodeFrame<"harness.codex.dispatch.receipt">, dispatch: SignedNodeFrame<"harness.codex.dispatch">,
  clock: () => number, assertCurrent: () => void) {
  const body = matchCodexTaskDispatchReceiptV1(frame.body, { messageId: dispatch.messageId, body: dispatch.body });
  const start = dispatch.body.start, scope: NativeTaskQueueScope = { tenantId: start.tenantId, projectId: start.projectId,
    jobId: start.jobId, attemptId: start.attemptId, inputDigest: start.inputDigest };
  const saved = await readCodexDeliveryEnvelopeInSession(tx, key, scope);
  const intent = await readCodexTransmissionIntentReceipt(tx, key, scope);
  if (!saved || !intent || sha256Digest(saved.frame) !== sha256Digest(dispatch) || intent.frameDigest !== sha256Digest(dispatch)
    || intent.bodyDigest !== dispatch.bodyDigest || intent.permitDigest !== dispatch.body.permitDigest || saved.nodeKeyId !== frame.keyId
    || frame.actorId !== start.nodeId || frame.tenantId !== start.tenantId || frame.connectionId !== dispatch.connectionId
    || frame.causationId !== dispatch.messageId || Date.parse(body.recordedAt) < Date.parse(intent.requestedAt)
    || await readCodexDeliveryReceipt(tx, key, scope)) return fail();
  const current = (await tx.query<{ public_key_spki: string; key_state: string; node_state: string; valid_from: string; valid_until: string | null }>(
    `SELECT k.public_key_spki,k.state AS key_state,n.state AS node_state,k.valid_from,k.valid_until
     FROM control_nodes n JOIN control_node_keys k ON k.tenant_id=n.tenant_id AND k.node_id=n.id
     WHERE n.tenant_id=$1 AND n.id=$2 AND k.id=$3 FOR SHARE OF n,k`, [start.tenantId, start.nodeId, frame.keyId])).rows[0];
  if (!current || current.key_state !== "active" || ["pending_enrollment", "quarantined", "revoked"].includes(current.node_state)
    || !verifyNodeFrameSignature(frame, current.public_key_spki)) return fail();
  const checkedAt = clock(), from = Date.parse(current.valid_from), until = current.valid_until ? Date.parse(current.valid_until) : Infinity;
  const assertFresh = () => {
    synchronous(assertCurrent); const now = clock();
    if (!Number.isSafeInteger(checkedAt) || !Number.isSafeInteger(now) || now < checkedAt || !Number.isFinite(from)
      || Number.isNaN(until) || now < from || now >= until || now >= Date.parse(frame.expiresAt)) fail();
  };
  assertFresh();
  const record = schema.parse({ schema: "control-room.codex-delivery-receipt/v1", frame, inputDigest: scope.inputDigest,
    dispatchFrameDigest: sha256Digest(dispatch), receivedAt: new Date(checkedAt).toISOString() });
  await tx.query("INSERT INTO control_codex_delivery_receipts(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6)",
    [start.tenantId, start.projectId, start.jobId, start.attemptId, record, tag(key, record)]);
  assertFresh(); return { value: receipt(record), assertFresh };
}
