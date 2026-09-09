import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import type { SignedNodeFrame } from "../../node-protocol/v1";
import type { NativeEnvelopeChannel } from "../../node-control/server-node-session";
import type { NativeTaskQueueScope } from "./native-task-queue";
import { readNativeDeliveryEnvelopeInSession } from "./native-delivery-envelope";

const schema = z.object({ schema: z.literal("control-room.native-transmission-intent/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, inputDigest: digestSchema,
  queueId: localId, messageId: localId, connectionId: localId, frameDigest: digestSchema, packetDigest: digestSchema,
  leaseFrameDigest: digestSchema.optional(),
  requestedAt: z.string().datetime(), requestedBy: localId }).strict();
type Record = z.infer<typeof schema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("native_transmission_intent_unavailable"); };
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key, { purpose: "native-transmission-intent/v1", record });
const receipt = (r: Record) => ({ projectId: r.projectId, jobId: r.jobId, attemptId: r.attemptId,
  queueId: r.queueId, messageId: r.messageId, connectionId: r.connectionId, frameDigest: r.frameDigest,
  packetDigest: r.packetDigest, requestedAt: r.requestedAt, evidence: "stored_transmission_intent" as const,
  ...(r.leaseFrameDigest ? { leaseFrameDigest: r.leaseFrameDigest } : {}),
  deliveryConfirmed: false as const, grantsExecutionAuthority: false as const });
async function read(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_transmission_intents WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
    [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const r = schema.parse(row.record), expected = Buffer.from(tag(key, r)), actual = Buffer.from(row.auth_tag);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
      || row.tenant_id !== r.tenantId || row.project_id !== r.projectId || row.job_id !== r.jobId || row.attempt_id !== r.attemptId
      || r.tenantId !== scope.tenantId || r.projectId !== scope.projectId || r.jobId !== scope.jobId || r.attemptId !== scope.attemptId
      || r.inputDigest !== scope.inputDigest) return fail();
  return r;
}
/** Only the canonical coordinator may supply current authority and the pre-commit fence. */
export async function persistNativeTransmissionIntent(tx: DatabaseSession, key: Uint8Array, frame: SignedNodeFrame<"harness.native.dispatch">,
  channel: NativeEnvelopeChannel, actorId: string, now: number, leaseFrame?: SignedNodeFrame<"job.lease.grant">) {
  const q = frame.body.request;
  const scope = { tenantId: q.tenantId, projectId: q.projectId, jobId: q.jobId, attemptId: q.attemptId, inputDigest: frame.body.inputDigest };
  const saved = await readNativeDeliveryEnvelopeInSession(tx, key, scope);
  channel.assertCurrent();
  if (saved && ((saved.leaseFrame ? sha256Digest(saved.leaseFrame) : undefined) !== (leaseFrame ? sha256Digest(leaseFrame) : undefined))) return fail();
  if (leaseFrame && now >= Date.parse(leaseFrame.expiresAt)) return fail();
  if (!saved || sha256Digest(saved.frame) !== sha256Digest(frame) || saved.nodeKeyId !== channel.nodeKeyId
      || channel.tenantId !== frame.tenantId || channel.nodeId !== q.nodeId || channel.connectionId !== frame.connectionId
      || now < Date.parse(saved.stagedAt) || now >= Date.parse(frame.expiresAt) || await read(tx, key, scope)) return fail();
  const r = schema.parse({ schema: "control-room.native-transmission-intent/v1", ...scope,
    queueId: frame.body.queueId, messageId: frame.messageId, connectionId: frame.connectionId, frameDigest: sha256Digest(frame),
    packetDigest: frame.body.packetDigest, ...(leaseFrame ? { leaseFrameDigest: sha256Digest(leaseFrame) } : {}), requestedAt: new Date(now).toISOString(), requestedBy: actorId });
  await tx.query("INSERT INTO control_native_transmission_intents(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6)",
    [q.tenantId, q.projectId, q.jobId, q.attemptId, r, tag(key, r)]);
  channel.assertCurrent(); return receipt(r);
}
export async function readNativeTransmissionIntentReceipt(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const r = await read(tx, key, scope); return r ? receipt(r) : null;
}
