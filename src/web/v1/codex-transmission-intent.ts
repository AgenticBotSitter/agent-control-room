import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import type { SignedNodeFrame } from "../../node-protocol/v1";
import type { CodexEnvelopeChannel } from "../../node-control/server-node-session";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import type { NativeTaskQueueScope } from "./native-task-queue";
import { readCodexDeliveryEnvelopeInSession, type VerifiedCodexDeliveryAuthorityV1 } from "./codex-delivery-envelope";

const schema = z.object({ schema: z.literal("control-room.codex-transmission-intent/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, inputDigest: digestSchema,
  queueId: localId, messageId: localId, connectionId: localId, frameDigest: digestSchema, bodyDigest: digestSchema,
  permitDigest: digestSchema, requestedAt: z.string().datetime(), requestedBy: localId }).strict();
type Record = z.infer<typeof schema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("codex_transmission_intent_unavailable"); };
const current = (check: () => void) => assertSynchronousFence(check, fail);
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key, { purpose: "codex-transmission-intent/v1", record });
const receipt = (record: Record) => ({ projectId: record.projectId, jobId: record.jobId, attemptId: record.attemptId,
  queueId: record.queueId, messageId: record.messageId, connectionId: record.connectionId, frameDigest: record.frameDigest,
  bodyDigest: record.bodyDigest, permitDigest: record.permitDigest, requestedAt: record.requestedAt,
  evidence: "stored_codex_transmission_intent" as const, deliveryConfirmed: false as const, grantsExecutionAuthority: false as const });

async function read(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const row = (await tx.query<Row>("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_codex_transmission_intents WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3",
    [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const record = schema.parse(row.record), expected = Buffer.from(tag(key, record)), actual = Buffer.from(row.auth_tag);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || row.tenant_id !== record.tenantId
    || row.project_id !== record.projectId || row.job_id !== record.jobId || row.attempt_id !== record.attemptId
    || record.tenantId !== scope.tenantId || record.projectId !== scope.projectId || record.jobId !== scope.jobId
    || record.attemptId !== scope.attemptId || record.inputDigest !== scope.inputDigest) return fail();
  return record;
}

/** Commits the only send slot before transport work. It intentionally does not send or start Codex. */
export async function persistCodexTransmissionIntent(tx: DatabaseSession, key: Uint8Array, frame: SignedNodeFrame<"harness.codex.dispatch">,
  channel: CodexEnvelopeChannel, actorId: string, now: number, authority: VerifiedCodexDeliveryAuthorityV1) {
  const start = frame.body.start, scope: NativeTaskQueueScope = { tenantId: start.tenantId, projectId: start.projectId,
    jobId: start.jobId, attemptId: start.attemptId, inputDigest: start.inputDigest };
  const saved = await readCodexDeliveryEnvelopeInSession(tx, key, scope);
  current(channel.assertCurrent); current(authority.assertFresh);
  if (!Number.isSafeInteger(now) || !saved || sha256Digest(saved.frame) !== sha256Digest(frame) || saved.nodeKeyId !== channel.nodeKeyId
    || channel.tenantId !== frame.tenantId || channel.nodeId !== start.nodeId || channel.connectionId !== frame.connectionId
    || now < Date.parse(saved.stagedAt) || now >= Date.parse(frame.expiresAt) || now >= start.deadline
    || authority.deliveryBodyDigest !== frame.bodyDigest || authority.permitDigest !== frame.body.permitDigest
    || authority.enrollmentDigest !== start.enrollmentDigest || authority.connectorProfileDigest !== start.connectorProfileDigest
    || authority.workspaceIntentDigest !== start.workspaceIntentDigest || await read(tx, key, scope)) return fail();
  const record = schema.parse({ schema: "control-room.codex-transmission-intent/v1", ...scope, queueId: frame.body.queueId,
    messageId: frame.messageId, connectionId: frame.connectionId, frameDigest: sha256Digest(frame), bodyDigest: frame.bodyDigest,
    permitDigest: frame.body.permitDigest, requestedAt: new Date(now).toISOString(), requestedBy: actorId });
  await tx.query("INSERT INTO control_codex_transmission_intents(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6)",
    [start.tenantId, start.projectId, start.jobId, start.attemptId, record, tag(key, record)]);
  current(authority.assertFresh); current(channel.assertCurrent); return receipt(record);
}

export async function readCodexTransmissionIntentReceipt(tx: DatabaseSession, key: Uint8Array, scope: NativeTaskQueueScope) {
  const record = await read(tx, key, scope); return record ? receipt(record) : null;
}
