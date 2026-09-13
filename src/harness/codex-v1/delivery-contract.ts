import { z } from 'zod';
import { normalizedLocalPolicyRequestSchema, ownerApprovalAttestationSchema } from '../../node-policy/v1/schemas';
import { computeNormalizedOperationDigest } from '../../node-policy/v1/policy-evaluator';
import { computeEffectClaimKey } from '../../node-policy/v1/effect-claim';
import { sha256Digest } from '../../security/canonical-digest';
import { digestSchema, localId } from '../v1/native-run-identifiers';

export const CODEX_START_OPERATION = 'harness.codex.app-server.start' as const;
export const CODEX_DELIVERY_FEATURE = 'harness.codex.dispatch.v1' as const;
export const CODEX_APP_SERVER_ADAPTER = 'codex-app-server/v1' as const;
export const CODEX_APP_SERVER_CAPABILITY = 'harness.codex.app-server.v1' as const;
export const CODEX_APP_SERVER_JOB_TYPE = 'harness.codex.app-server.task' as const;
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = (bytes: number) => z.string().refine(value => Buffer.byteLength(value, 'utf8') <= bytes);

export const codexTaskStartSchemaV1 = z.object({
  schema: z.literal('control-room.codex-task-start/v1'),
  tenantId: localId, nodeId: localId, projectId: localId, jobId: localId,
  attemptId: localId, runId: localId, leaseId: localId,
  leaseEpoch: z.number().int().positive(), effectClaimKey: digestSchema, operationDigest: digestSchema,
  inputDigest: digestSchema, enrollmentDigest: digestSchema,
  connectorProfileDigest: digestSchema, workspaceIntentDigest: digestSchema,
  prompt: text(32_768).min(1), instructions: text(8192), deadline: instant,
}).strict();
export type CodexTaskStartV1 = z.infer<typeof codexTaskStartSchemaV1>;

function taskPayloadDigest(start: CodexTaskStartV1, authorityDigest: string) {
  return sha256Digest({ schema: 'control-room.codex-task-effect-payload/v1',
    enrollmentDigest: start.enrollmentDigest, connectorProfileDigest: start.connectorProfileDigest,
    workspaceIntentDigest: start.workspaceIntentDigest, inputDigest: start.inputDigest,
    leaseId: start.leaseId, leaseEpoch: start.leaseEpoch, authorityDigest,
    deadline: start.deadline });
}
export function codexTaskPayloadDigestV1(startValue: unknown, authorityDigest: string) {
  return taskPayloadDigest(codexTaskStartSchemaV1.parse(startValue), digestSchema.parse(authorityDigest));
}

export const codexTaskDispatchBodySchemaV1 = z.object({
  schema: z.literal('control-room.codex-task-dispatch/v1'),
  queueId: localId, start: codexTaskStartSchemaV1,
  request: normalizedLocalPolicyRequestSchema,
  permit: ownerApprovalAttestationSchema,
  permitDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { start, request, permit } = value, approval = permit.body;
  const expectedQueue = `native-queue:${sha256Digest({ tenantId: start.tenantId,
    jobId: start.jobId, attemptId: start.attemptId }).slice(7)}`;
  const identityMatches = request.tenantId === start.tenantId && request.nodeId === start.nodeId
    && request.projectId === start.projectId && request.jobId === start.jobId
    && request.attemptId === start.attemptId && request.leaseId === start.leaseId
    && request.leaseEpoch === start.leaseEpoch && approval.tenantId === start.tenantId
    && approval.nodeId === start.nodeId && approval.projectId === start.projectId
    && approval.jobId === start.jobId && approval.attemptId === start.attemptId;
  const approvalTime = Date.parse(approval.issuedAt), requestTime = Date.parse(request.occurredAt);
  if (value.queueId !== expectedQueue || request.approval
    || start.inputDigest !== sha256Digest({ prompt: start.prompt, instructions: start.instructions })
    || !identityMatches || request.operationId !== CODEX_START_OPERATION || !request.externalEffect || request.risk !== 'low'
    || request.estimatedDurationSeconds < 1 || request.estimatedDurationSeconds > 300
    || request.estimatedCostUsd !== undefined || request.credentialRefs.length !== 1 || request.target.kind !== 'filesystem'
    || request.payloadDigest !== taskPayloadDigest(start, request.authorityDigest)
    || request.operationDigest !== computeNormalizedOperationDigest(request) || start.operationDigest !== request.operationDigest
    || start.effectClaimKey !== computeEffectClaimKey(request)
    || start.runId !== `run:codex-task:${start.effectClaimKey.slice(7)}`
    || approval.operationDigest !== request.operationDigest || approval.risk !== request.risk || approval.decision !== 'approved'
    || !Number.isFinite(approvalTime) || approvalTime < requestTime || Date.parse(approval.expiresAt) < start.deadline
    || value.permitDigest !== sha256Digest(permit) || Buffer.byteLength(JSON.stringify(value), 'utf8') > 65_536) {
    context.addIssue({ code: 'custom', message: 'codex dispatch binding mismatch' });
  }
});
export type CodexTaskDispatchBodyV1 = z.infer<typeof codexTaskDispatchBodySchemaV1>;

export const codexTaskDispatchReceiptBodySchemaV1 = z.object({
  schema: z.literal('control-room.codex-task-dispatch-receipt/v1'),
  queueId: localId, dispatchMessageId: localId, dispatchBodyDigest: digestSchema,
  tenantId: localId, projectId: localId, nodeId: localId, jobId: localId, attemptId: localId,
  permitDigest: digestSchema, enrollmentDigest: digestSchema, recordedAt: z.string().datetime(),
  disposition: z.enum(['recorded', 'rejected']),
  safeReason: z.enum(['none', 'expired', 'binding_mismatch', 'authority_unavailable', 'storage_uncertain']),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if ((value.disposition === 'recorded') !== (value.safeReason === 'none')) {
    context.addIssue({ code: 'custom', message: 'codex receipt disposition mismatch' });
  }
});
export type CodexTaskDispatchReceiptBodyV1 = z.infer<typeof codexTaskDispatchReceiptBodySchemaV1>;

/** Call only after the receipt's outer node frame has been authenticated. */
export function matchCodexTaskDispatchReceiptV1(receiptValue: unknown, expected: {
  messageId: string; body: CodexTaskDispatchBodyV1;
}) {
  const receipt = codexTaskDispatchReceiptBodySchemaV1.parse(receiptValue);
  const body = codexTaskDispatchBodySchemaV1.parse(expected.body), start = body.start;
  if (receipt.dispatchMessageId !== expected.messageId || receipt.dispatchBodyDigest !== sha256Digest(body)
    || receipt.queueId !== body.queueId || receipt.tenantId !== start.tenantId || receipt.projectId !== start.projectId
    || receipt.nodeId !== start.nodeId || receipt.jobId !== start.jobId || receipt.attemptId !== start.attemptId
    || receipt.permitDigest !== body.permitDigest || receipt.enrollmentDigest !== start.enrollmentDigest) {
    throw new Error('codex_dispatch_receipt_mismatch');
  }
  return receipt;
}
