import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { nativeTaskDispatchBodySchema, type NativeTaskDispatchBody } from "../../harness/v1/native-delivery";
import { localId } from "../../harness/v1/native-run-identifiers";
import { readNativeTaskQueueIntentInSession, type NativeTaskQueueScope } from "./native-task-queue";

const schema = z.object({ schema: z.literal("control-room.native-delivery-preparation/v1"),
  body: nativeTaskDispatchBodySchema, preparedAt: z.string().datetime(), preparedBy: localId }).strict();
type Record = z.infer<typeof schema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("native_delivery_preparation_unavailable"); };
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key, { purpose: "native-delivery-preparation/v1", record });
const receipt = (r: Record) => ({ projectId: r.body.request.projectId, jobId: r.body.request.jobId, attemptId: r.body.request.attemptId,
  queueId: r.body.queueId, bodyDigest: sha256Digest(r.body), packetDigest: r.body.packetDigest, preparedAt: r.preparedAt,
  evidence: "stored_unsigned_delivery_body" as const, startsWork: false as const, grantsExecutionAuthority: false as const });
export async function readNativeDeliveryPreparationInSession(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_delivery_preparations WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
    [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const r = schema.parse(row.record), q = r.body.request, expected = Buffer.from(tag(key, r)), actual = Buffer.from(row.auth_tag);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
    || row.tenant_id !== q.tenantId || row.project_id !== q.projectId || row.job_id !== q.jobId || row.attempt_id !== q.attemptId
    || q.tenantId !== scope.tenantId || q.projectId !== scope.projectId || q.jobId !== scope.jobId
    || q.attemptId !== scope.attemptId || r.body.inputDigest !== scope.inputDigest) return fail();
  return r;
}
/** Internal transaction collaborator; coordinator must establish current authority and fence commit. */
export async function persistNativeDeliveryPreparation(tx: DatabaseSession, key: Uint8Array, body: NativeTaskDispatchBody, actorId: string, now: number) {
  const r = schema.parse({ schema: "control-room.native-delivery-preparation/v1", body, preparedAt: new Date(now).toISOString(), preparedBy: actorId });
  body = r.body;
  const q = r.body.request, scope = { tenantId: q.tenantId, projectId: q.projectId, jobId: q.jobId, attemptId: q.attemptId, inputDigest: body.inputDigest };
  const intent = await readNativeTaskQueueIntentInSession(tx, key, scope);
  if (!intent || intent.nodeId !== q.nodeId || intent.leaseId !== q.leaseId || intent.leaseEpoch !== q.leaseEpoch
    || intent.packetDigest !== body.packetDigest || intent.operationDigest !== q.operationDigest
    || intent.bindingDigest !== body.bindingDigest || intent.enrollmentDigest !== body.enrollmentDigest
    || intent.deadline !== body.start.deadline || now < Date.parse(intent.queuedAt) || now >= intent.deadline) return fail();
  const prior = await readNativeDeliveryPreparationInSession(tx, key, scope);
  if (prior) {
    // Canonical revalidation observes a new time; retain the first exact prepared body rather than
    // changing its digest on replay. All permission/content fields still have to match.
    const stable = (value: NativeTaskDispatchBody) => {
      const { occurredAt: _time, ...request } = value.request; void _time; return { ...value, request };
    };
    if (Date.parse(prior.body.request.occurredAt) > now || Date.parse(prior.body.request.occurredAt) < Date.parse(intent.queuedAt)
      || sha256Digest(stable(prior.body)) !== sha256Digest(stable(r.body))) return fail();
  }
  else await tx.query("INSERT INTO control_native_delivery_preparations(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6)",
    [scope.tenantId, scope.projectId, scope.jobId, scope.attemptId, r, tag(key, r)]);
  return { ...receipt(prior ?? r), replayed: !!prior };
}
export async function readNativeDeliveryPreparationReceipt(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const r = await readNativeDeliveryPreparationInSession(tx, key, scope); return r ? receipt(r) : null;
}
