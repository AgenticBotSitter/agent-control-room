import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { signedNodeFrameSchema, verifyNodeFrameSignature, type SignedNodeFrame } from "../../node-protocol/v1";
import { localId } from "../../harness/v1/native-run-identifiers";
import type { NativeEnvelopeChannel } from "../../node-control/server-node-session";
import type { NativeTaskQueueScope } from "./native-task-queue";
import { readNativeDeliveryPreparationInSession } from "./native-delivery-preparation";

const schema = z.object({ schema: z.literal("control-room.native-delivery-envelope/v1"),
  frame: signedNodeFrameSchema, nodeKeyId: localId, stagedAt: z.string().datetime(), stagedBy: localId }).strict()
  .refine(r => r.frame.type === "harness.native.dispatch");
type Record = z.infer<typeof schema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; message_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("native_delivery_envelope_unavailable"); };
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key, { purpose: "native-delivery-envelope/v1", record });
const frameOf = (r: Record) => r.frame as SignedNodeFrame<"harness.native.dispatch">;
const receipt = (r: Record) => {
  const f = frameOf(r), body = f.body;
  return { projectId: body.request.projectId, jobId: body.request.jobId, attemptId: body.request.attemptId,
    queueId: body.queueId, messageId: f.messageId, connectionId: f.connectionId, frameDigest: sha256Digest(f),
    bodyDigest: f.bodyDigest, packetDigest: body.packetDigest, stagedAt: r.stagedAt, expiresAt: f.expiresAt,
    evidence: "stored_signed_delivery_envelope" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
};
export async function readNativeDeliveryEnvelopeInSession(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,message_id,record,auth_tag FROM control_native_delivery_envelopes WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
    [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const r = schema.parse(row.record), f = frameOf(r), q = f.body.request;
  const expected = Buffer.from(tag(key, r)), actual = Buffer.from(row.auth_tag);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || row.message_id !== f.messageId
      || row.tenant_id !== q.tenantId || row.project_id !== q.projectId || row.job_id !== q.jobId || row.attempt_id !== q.attemptId
      || q.tenantId !== scope.tenantId || q.projectId !== scope.projectId || q.jobId !== scope.jobId || q.attemptId !== scope.attemptId
      || f.body.inputDigest !== scope.inputDigest || f.bodyDigest !== sha256Digest(f.body)) return fail();
  return r;
}
export async function assertNativeDeliveryEnvelopeAbsent(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  if (await readNativeDeliveryEnvelopeInSession(tx, key, scope)) return fail();
}
/** Internal collaborator: current canonical/signature checks and commit fence are mandatory. */
export async function persistNativeDeliveryEnvelope(tx: DatabaseSession, key: Uint8Array, input: SignedNodeFrame<"harness.native.dispatch">,
  channel: NativeEnvelopeChannel, actorId: string, now: number) {
  const r = schema.parse({ schema: "control-room.native-delivery-envelope/v1", frame: input, nodeKeyId: channel.nodeKeyId,
    stagedAt: new Date(now).toISOString(), stagedBy: actorId }), f = frameOf(r), q = f.body.request;
  channel.assertCurrent();
  if (f.tenantId !== channel.tenantId || q.nodeId !== channel.nodeId || f.connectionId !== channel.connectionId
      || f.actorId !== channel.serverId || f.keyId !== channel.serverKeyId || now < Date.parse(f.sentAt)
      || now >= Date.parse(f.expiresAt) || Date.parse(f.expiresAt) > Date.parse(channel.expiresAt)
      || Buffer.byteLength(JSON.stringify(f)) > channel.maxFrameBytes || f.bodyDigest !== sha256Digest(f.body)
      || !verifyNodeFrameSignature(f, channel.serverPublicKeySpki)) return fail();
  const scope = { tenantId: q.tenantId, projectId: q.projectId, jobId: q.jobId, attemptId: q.attemptId, inputDigest: f.body.inputDigest };
  const prepared = await readNativeDeliveryPreparationInSession(tx, key, scope);
  if (!prepared || sha256Digest(prepared.body) !== f.bodyDigest) return fail();
  await assertNativeDeliveryEnvelopeAbsent(tx, key, scope);
  await tx.query("INSERT INTO control_native_delivery_envelopes(tenant_id,project_id,job_id,attempt_id,message_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [q.tenantId, q.projectId, q.jobId, q.attemptId, f.messageId, r, tag(key, r)]);
  channel.assertCurrent(); return receipt(r);
}
export async function readNativeDeliveryEnvelopeReceipt(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const r = await readNativeDeliveryEnvelopeInSession(tx, key, scope); return r ? receipt(r) : null;
}
