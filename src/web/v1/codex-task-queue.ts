import type { DatabaseSession } from "../../persistence/database";
import { jobRecordSchema, attemptRecordSchema, leaseRecordSchema, nodeRecordSchema, type AuthorityEnvelope } from "../../domain/v1";
import { codexTaskDispatchBodySchemaV1, type CodexTaskDispatchBodyV1 } from "../../harness/codex-v1/delivery-contract";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import { assertAuthorityDigest, hmacSha256Tag, sha256Digest } from "../../security";
import { localId } from "../../harness/v1/native-run-identifiers";
import { z } from "zod";
import { enqueueNativeTaskInSession } from "./native-task-queue";

const fail = (): never => { throw new Error("codex_task_queue_unavailable"); };
const current = (check: () => void) => assertSynchronousFence(check, fail);
const approvalRecordSchema = z.object({ schema: z.literal("control-room.canonical-codex-approval-packet/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId,
  packetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), body: codexTaskDispatchBodySchemaV1,
  acceptedBy: localId, acceptedAt: z.string().datetime(),
}).strict();
type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
type ApprovalRow = { record: unknown; auth_tag: string };

export type VerifiedCodexDeliveryAuthorityV1 = Readonly<{
  deliveryBodyDigest: string;
  permitDigest: string;
  enrollmentDigest: string;
  connectorProfileDigest: string;
  workspaceIntentDigest: string;
  assertFresh(): void;
}>;

/** Digest of the complete Codex approval packet, not only its signed permit. */
export function codexApprovalPacketDigestV1(value: unknown) {
  const body = codexTaskDispatchBodySchemaV1.parse(value);
  return sha256Digest({ schema: "control-room.codex-approval-packet/v1", request: body.request,
    permit: body.permit, permitDigest: body.permitDigest });
}

/** Digest of the complete immutable machine/work binding. Prompt text is bound by inputDigest. */
export function codexExecutionBindingDigestV1(value: unknown) {
  const { schema: _schema, prompt: _prompt, instructions: _instructions, ...binding } = codexTaskDispatchBodySchemaV1.parse(value).start;
  void _schema; void _prompt; void _instructions;
  return sha256Digest({ schema: "control-room.codex-execution-binding/v1", ...binding });
}

function permits(authority: AuthorityEnvelope, body: CodexTaskDispatchBodyV1, now: number) {
  const request = body.request;
  if (request.target.kind !== "filesystem") return false;
  const canonicalPath = request.target.canonicalPath;
  const risk = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  const withinRoot = authority.filesystemRoots.some(root => root === "/"
    || canonicalPath === root || canonicalPath.startsWith(`${root}/`));
  return authority.digest === request.authorityDigest && authority.projectId === request.projectId
    && authority.allowedExecutor === request.executorId && authority.allowedOperations.includes(request.operationId)
    && request.credentialRefs.every(ref => authority.credentialRefs.includes(ref))
    && authority.effectPolicy !== "none" && risk[request.risk] <= risk[authority.maxRisk]
    && request.estimatedDurationSeconds <= authority.maxDurationSeconds
    && request.estimatedCostUsd === undefined
    && Date.parse(authority.expiresAt) >= body.start.deadline && Date.parse(authority.expiresAt) > now && withinRoot;
}

/**
 * Trusted coordinator collaborator. It creates the shared native queue intent only
 * after checking canonical job, attempt, lease and node state plus current owner trust.
 * It does not sign, transmit, launch Codex, create a workspace or grant node execution.
 */
export async function enqueueCodexTaskInSession(tx: DatabaseSession, key: Uint8Array, input: unknown,
  authority: VerifiedCodexDeliveryAuthorityV1, actorId: string, now: number) {
  const body = codexTaskDispatchBodySchemaV1.parse(input), start = body.start;
  current(authority.assertFresh);
  if (!Number.isSafeInteger(now) || now < 0 || now >= start.deadline
    || authority.deliveryBodyDigest !== sha256Digest(body) || authority.permitDigest !== body.permitDigest
    || authority.enrollmentDigest !== start.enrollmentDigest || authority.connectorProfileDigest !== start.connectorProfileDigest
    || authority.workspaceIntentDigest !== start.workspaceIntentDigest) return fail();

  const rows = await tx.query<{ job: unknown; attempt: unknown; lease: unknown; node: unknown }>(`SELECT
      j.payload AS job,a.payload AS attempt,l.payload AS lease,n.payload AS node
    FROM control_jobs j
    JOIN control_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
    JOIN control_leases l ON l.tenant_id=j.tenant_id AND l.job_id=j.id AND l.attempt_id=a.id
    JOIN control_nodes n ON n.tenant_id=j.tenant_id AND n.id=a.node_id
    WHERE j.tenant_id=$1 AND j.id=$2 AND j.project_id=$3 AND a.id=$4 AND l.id=$5 AND n.id=$6
    FOR UPDATE OF j,a,l,n`, [start.tenantId, start.jobId, start.projectId, start.attemptId, start.leaseId, start.nodeId]);
  if (rows.rows.length !== 1) return fail();
  const row = rows.rows[0], job = jobRecordSchema.parse(row.job), attempt = attemptRecordSchema.parse(row.attempt);
  const lease = leaseRecordSchema.parse(row.lease), node = nodeRecordSchema.parse(row.node);
  try { assertAuthorityDigest(job.authority); } catch { return fail(); }
  if (job.state !== "leased" || job.inputDigest !== start.inputDigest || !permits(job.authority, body, now)
    || attempt.state !== "leased" || attempt.jobId !== start.jobId || attempt.nodeId !== start.nodeId
    || attempt.leaseEpoch !== start.leaseEpoch || lease.state !== "active" || lease.jobId !== start.jobId
    || lease.attemptId !== start.attemptId || lease.nodeId !== start.nodeId || lease.epoch !== start.leaseEpoch
    || Date.parse(lease.expiresAt) < start.deadline || Date.parse(lease.expiresAt) <= now
    || node.state !== "active" || node.id !== start.nodeId) return fail();

  const packetDigest = codexApprovalPacketDigestV1(body);
  const record = approvalRecordSchema.parse({ schema: "control-room.canonical-codex-approval-packet/v1",
    tenantId: start.tenantId, projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId,
    packetDigest, body, acceptedBy: actorId, acceptedAt: new Date(now).toISOString() });
  const tag = hmacSha256Tag(key, { purpose: "canonical-codex-approval-packet/v1", record });
  const prior = (await tx.query<ApprovalRow>(`SELECT record,auth_tag FROM control_native_approval_packets
    WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3`, [start.tenantId, start.jobId, start.attemptId])).rows[0];
  if (prior) return fail();
  await tx.query(`INSERT INTO control_native_approval_packets(tenant_id,project_id,job_id,attempt_id,record,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6)`, [start.tenantId, start.projectId, start.jobId, start.attemptId, record, tag]);
  current(authority.assertFresh);
  const receipt = await enqueueNativeTaskInSession(tx, key, { schema: "control-room.native-task-queue/v1",
    tenantId: start.tenantId, projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId,
    nodeId: start.nodeId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch, inputDigest: start.inputDigest,
    packetDigest, operationDigest: start.operationDigest,
    bindingDigest: codexExecutionBindingDigestV1(body), enrollmentDigest: start.enrollmentDigest,
    deadline: start.deadline, queuedAt: new Date(now).toISOString(), queuedBy: actorId });
  current(authority.assertFresh);
  return { receipt, assertFresh: authority.assertFresh };
}
