import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { signedNodeFrameSchema, verifyNodeFrameSignature, type SignedNodeFrame } from "../../node-protocol/v1";
import { matchNativeTaskDispatchReceipt } from "../../harness/v1/native-delivery";
import { digestSchema } from "../../harness/v1/native-run-identifiers";
import type { NativeTaskQueueScope } from "./native-task-queue";
import { readNativeDeliveryEnvelopeInSession } from "./native-delivery-envelope";
import { readNativeTransmissionIntentReceipt } from "./native-transmission-intent";

const schema = z.object({ schema: z.literal("control-room.native-delivery-receipt/v1"),
  frame: signedNodeFrameSchema.refine(f => f.type === "harness.native.dispatch.receipt"),
  inputDigest: digestSchema, dispatchFrameDigest: digestSchema, receivedAt: z.string().datetime() }).strict();
type Record = z.infer<typeof schema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("native_delivery_receipt_unavailable"); };
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key, { purpose: "native-delivery-receipt/v1", record });
const body = (r: Record) => {
  if (r.frame.type !== "harness.native.dispatch.receipt") return fail();
  return r.frame.body;
};
const receipt = (r: Record) => {
  const b = body(r);
  return { projectId: b.projectId, jobId: b.jobId, attemptId: b.attemptId, queueId: b.queueId,
    dispatchMessageId: b.dispatchMessageId, receiptMessageId: r.frame.messageId, packetDigest: b.packetDigest,
    nodeReportedDisposition: b.disposition, safeReason: b.safeReason, recordedAt: b.recordedAt, receivedAt: r.receivedAt,
    evidence: "stored_authenticated_node_receipt" as const, startsWork: false as const, executionConfirmed: false as const,
    grantsExecutionAuthority: false as const };
};
export async function readNativeDeliveryReceipt(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_delivery_receipts WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
    [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const r = schema.parse(row.record), b = body(r), expected = Buffer.from(tag(key, r)), actual = Buffer.from(row.auth_tag);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || r.inputDigest !== scope.inputDigest
    || row.tenant_id !== b.tenantId || row.project_id !== b.projectId || row.job_id !== b.jobId || row.attempt_id !== b.attemptId
    || b.tenantId !== scope.tenantId || b.projectId !== scope.projectId || b.jobId !== scope.jobId || b.attemptId !== scope.attemptId
    || r.frame.bodyDigest !== sha256Digest(b)) return fail();
  return receipt(r);
}

/** Called only inside authenticated ServerNodeSession receipt processing, never from a browser body.
 * Match durable intent/envelope and lock the current node/key again before accepting historical evidence. */
export async function persistNativeDeliveryReceipt(tx: DatabaseSession, key: Uint8Array,
  frame: SignedNodeFrame<"harness.native.dispatch.receipt">, dispatch: SignedNodeFrame<"harness.native.dispatch">,
  clock: () => number, assertCurrent: () => void) {
  const b = matchNativeTaskDispatchReceipt(frame.body, dispatch), q = dispatch.body.request;
  const scope = { tenantId: q.tenantId, projectId: q.projectId, jobId: q.jobId, attemptId: q.attemptId, inputDigest: dispatch.body.inputDigest };
  const saved = await readNativeDeliveryEnvelopeInSession(tx, key, scope);
  const intent = await readNativeTransmissionIntentReceipt(tx, key, scope);
  if (!saved || !intent || sha256Digest(saved.frame) !== sha256Digest(dispatch) || intent.frameDigest !== sha256Digest(dispatch)
    || saved.nodeKeyId !== frame.keyId || frame.actorId !== q.nodeId || frame.tenantId !== q.tenantId
    || frame.connectionId !== dispatch.connectionId || frame.causationId !== dispatch.messageId
    || Date.parse(b.recordedAt) < Date.parse(intent.requestedAt) || await readNativeDeliveryReceipt(tx, key, scope)) return fail();
  const current = (await tx.query<{ public_key_spki: string; key_state: string; node_state: string; valid_from: string; valid_until: string | null }>(
    `SELECT k.public_key_spki,k.state AS key_state,n.state AS node_state,k.valid_from,k.valid_until
     FROM control_nodes n JOIN control_node_keys k ON k.tenant_id=n.tenant_id AND k.node_id=n.id
     WHERE n.tenant_id=$1 AND n.id=$2 AND k.id=$3 FOR SHARE OF n,k`, [q.tenantId, q.nodeId, frame.keyId])).rows[0];
  if (!current || current.key_state !== "active" || ["pending_enrollment", "quarantined", "revoked"].includes(current.node_state)
    || !verifyNodeFrameSignature(frame, current.public_key_spki)) return fail();
  const checkedAt = clock(), from = Date.parse(current.valid_from), until = current.valid_until ? Date.parse(current.valid_until) : Infinity;
  const assertFresh = () => {
    assertCurrent(); const now = clock();
    if (!Number.isSafeInteger(checkedAt) || !Number.isSafeInteger(now) || now < checkedAt || !Number.isFinite(from)
      || Number.isNaN(until) || now < from || now >= until || now >= Date.parse(frame.expiresAt)) fail();
  };
  assertFresh();
  const r = schema.parse({ schema: "control-room.native-delivery-receipt/v1", frame,
    inputDigest: scope.inputDigest, dispatchFrameDigest: sha256Digest(dispatch), receivedAt: new Date(checkedAt).toISOString() });
  await tx.query("INSERT INTO control_native_delivery_receipts(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6)",
    [q.tenantId, q.projectId, q.jobId, q.attemptId, r, tag(key, r)]);
  assertFresh(); return { value: receipt(r), assertFresh };
}
