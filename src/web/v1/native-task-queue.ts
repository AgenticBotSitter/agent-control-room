import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";

const intentSchema = z.object({ schema: z.literal("control-room.native-task-queue/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, nodeId: localId,
  leaseId: localId, leaseEpoch: z.number().int().positive(), inputDigest: digestSchema,
  packetDigest: digestSchema, operationDigest: digestSchema, bindingDigest: digestSchema, enrollmentDigest: digestSchema,
  deadline: z.number().int().nonnegative(), queuedAt: z.string().datetime(), queuedBy: localId,
}).strict();
export type NativeTaskQueueIntent = z.infer<typeof intentSchema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; record: unknown; auth_tag: string };
export type NativeTaskQueueScope = Pick<NativeTaskQueueIntent, "tenantId" | "projectId" | "jobId" | "attemptId" | "inputDigest">;
const fail = (): never => { throw new Error("native_task_queue_unavailable"); };
const tag = (key: Uint8Array, record: NativeTaskQueueIntent) => hmacSha256Tag(key, { purpose: "native-task-queue/v1", record });
const receipt = (r: NativeTaskQueueIntent) => ({ projectId: r.projectId, jobId: r.jobId, attemptId: r.attemptId,
  queueId: `native-queue:${sha256Digest({ tenantId: r.tenantId, jobId: r.jobId, attemptId: r.attemptId }).slice(7)}`,
  packetDigest: r.packetDigest, operationDigest: r.operationDigest, queuedAt: r.queuedAt,
  evidence: "recorded_delivery_intent" as const, startsWork: false as const, grantsExecutionAuthority: false as const });
export async function readNativeTaskQueueIntentInSession(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_task_queue WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
    [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const r = intentSchema.parse(row.record), expected = Buffer.from(tag(key, r)), actual = Buffer.from(row.auth_tag);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
    || row.tenant_id !== r.tenantId || row.project_id !== r.projectId || row.job_id !== r.jobId || row.attempt_id !== r.attemptId
    || r.tenantId !== scope.tenantId || r.projectId !== scope.projectId || r.jobId !== scope.jobId
    || r.attemptId !== scope.attemptId || r.inputDigest !== scope.inputDigest) return fail();
  return r;
}
/** Internal SQL helpers. Caller owns authentication, current revalidation and the checked transaction. */
export async function enqueueNativeTaskInSession(tx: DatabaseSession, key: Uint8Array, value: NativeTaskQueueIntent) {
  const r = intentSchema.parse(value), prior = await readNativeTaskQueueIntentInSession(tx, key, r);
  if (prior) {
    const stable = ({ queuedAt: _at, queuedBy: _by, ...value }: NativeTaskQueueIntent) => { void _at; void _by; return value; };
    if (sha256Digest(stable(prior)) !== sha256Digest(stable(r))) return fail();
  } else await tx.query("INSERT INTO control_native_task_queue(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6)",
    [r.tenantId, r.projectId, r.jobId, r.attemptId, r, tag(key, r)]);
  return { ...receipt(prior ?? r), replayed: !!prior };
}
export async function readNativeTaskQueueInSession(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const r = await readNativeTaskQueueIntentInSession(tx, key, scope); return r ? receipt(r) : null;
}
