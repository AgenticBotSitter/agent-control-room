import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { codexTaskDispatchBodySchemaV1 } from "../../harness/codex-v1/delivery-contract";
import { localId } from "../../harness/v1/native-run-identifiers";
import { signedNodeFrameSchema, verifyNodeFrameSignature, type SignedNodeFrame } from "../../node-protocol/v1";
import type { CodexEnvelopeChannel } from "../../node-control/server-node-session";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import { readNativeTaskQueueIntentInSession, type NativeTaskQueueScope } from "./native-task-queue";
import { codexApprovalPacketDigestV1, codexExecutionBindingDigestV1,
  type VerifiedCodexDeliveryAuthorityV1 } from "./codex-task-queue";

const schema = z.object({ schema: z.literal("control-room.codex-delivery-envelope/v1"),
  frame: signedNodeFrameSchema.refine(frame => frame.type === "harness.codex.dispatch"), nodeKeyId: localId,
  stagedAt: z.string().datetime(), stagedBy: localId }).strict();
type Record = z.infer<typeof schema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; message_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("codex_delivery_envelope_unavailable"); };
export type { VerifiedCodexDeliveryAuthorityV1 } from "./codex-task-queue";
const current = (check: () => void) => assertSynchronousFence(check, fail);
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key, { purpose: "codex-delivery-envelope/v1", record });
const frameOf = (record: Record) => record.frame as SignedNodeFrame<"harness.codex.dispatch">;
const scopeOf = (frame: SignedNodeFrame<"harness.codex.dispatch">): NativeTaskQueueScope => {
  const start = frame.body.start;
  return { tenantId: start.tenantId, projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId, inputDigest: start.inputDigest };
};
const receipt = (record: Record) => {
  const frame = frameOf(record), start = frame.body.start;
  return { projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId, queueId: frame.body.queueId,
    messageId: frame.messageId, connectionId: frame.connectionId, frameDigest: sha256Digest(frame), bodyDigest: frame.bodyDigest,
    permitDigest: frame.body.permitDigest, stagedAt: record.stagedAt, expiresAt: frame.expiresAt,
    evidence: "stored_signed_codex_delivery_envelope" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
};

export async function readCodexDeliveryEnvelopeInSession(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,message_id,record,auth_tag FROM control_codex_delivery_envelopes WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
    [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const record = schema.parse(row.record), frame = frameOf(record), start = frame.body.start;
  const expected = Buffer.from(tag(key, record)), actual = Buffer.from(row.auth_tag);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || row.message_id !== frame.messageId
    || row.tenant_id !== start.tenantId || row.project_id !== start.projectId || row.job_id !== start.jobId || row.attempt_id !== start.attemptId
    || start.tenantId !== scope.tenantId || start.projectId !== scope.projectId || start.jobId !== scope.jobId || start.attemptId !== scope.attemptId
    || start.inputDigest !== scope.inputDigest || frame.bodyDigest !== sha256Digest(frame.body)) return fail();
  return record;
}

export async function assertCodexDeliveryEnvelopeAbsent(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  if (await readCodexDeliveryEnvelopeInSession(tx, key, scope)) return fail();
}

/** Internal coordinator collaborator. A signed envelope is only durable evidence, never a start permission. */
export async function persistCodexDeliveryEnvelope(tx: DatabaseSession, key: Uint8Array, input: SignedNodeFrame<"harness.codex.dispatch">,
  channel: CodexEnvelopeChannel, actorId: string, now: number, authority: VerifiedCodexDeliveryAuthorityV1) {
  const record = schema.parse({ schema: "control-room.codex-delivery-envelope/v1", frame: input, nodeKeyId: channel.nodeKeyId,
    stagedAt: new Date(now).toISOString(), stagedBy: actorId });
  const frame = frameOf(record), body = codexTaskDispatchBodySchemaV1.parse(frame.body), start = body.start, scope = scopeOf(frame);
  current(channel.assertCurrent); current(authority.assertFresh);
  if (!Number.isSafeInteger(now) || frame.tenantId !== channel.tenantId || start.nodeId !== channel.nodeId
    || frame.connectionId !== channel.connectionId || frame.actorId !== channel.serverId || frame.keyId !== channel.serverKeyId
    || now < Date.parse(frame.sentAt) || now >= Date.parse(frame.expiresAt) || now >= start.deadline
    || Date.parse(frame.expiresAt) > Date.parse(channel.expiresAt) || Buffer.byteLength(JSON.stringify(frame)) > channel.maxFrameBytes
    || frame.bodyDigest !== sha256Digest(body) || !verifyNodeFrameSignature(frame, channel.serverPublicKeySpki)
    || authority.deliveryBodyDigest !== frame.bodyDigest || authority.permitDigest !== body.permitDigest
    || authority.enrollmentDigest !== start.enrollmentDigest || authority.connectorProfileDigest !== start.connectorProfileDigest
    || authority.workspaceIntentDigest !== start.workspaceIntentDigest) return fail();
  const queued = await readNativeTaskQueueIntentInSession(tx, key, scope);
  if (!queued || queued.nodeId !== start.nodeId || queued.leaseId !== start.leaseId || queued.leaseEpoch !== start.leaseEpoch
    || queued.operationDigest !== start.operationDigest || queued.enrollmentDigest !== start.enrollmentDigest
    || queued.packetDigest !== codexApprovalPacketDigestV1(body)
    || queued.bindingDigest !== codexExecutionBindingDigestV1(body) || queued.deadline !== start.deadline
    || now < Date.parse(queued.queuedAt) || now >= queued.deadline) return fail();
  await assertCodexDeliveryEnvelopeAbsent(tx, key, scope);
  await tx.query("INSERT INTO control_codex_delivery_envelopes(tenant_id,project_id,job_id,attempt_id,message_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [start.tenantId, start.projectId, start.jobId, start.attemptId, frame.messageId, record, tag(key, record)]);
  current(authority.assertFresh); current(channel.assertCurrent); return receipt(record);
}

export async function readCodexDeliveryEnvelopeReceipt(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const record = await readCodexDeliveryEnvelopeInSession(tx, key, scope); return record ? receipt(record) : null;
}
