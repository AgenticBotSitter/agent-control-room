import { z } from 'zod';
import { normalizedLocalPolicyRequestSchema, ownerApprovalAttestationSchema } from '../../node-policy/v1/schemas';
import { computeNormalizedOperationDigest } from '../../node-policy/v1/policy-evaluator';
import { computeEffectClaimKey } from '../../node-policy/v1/effect-claim';
import { sha256Digest } from '../../security/canonical-digest';
import { CODEX_APP_SERVER_START_CONTRACT } from '../../harness/codex-v1/schema-contract';
import { digestSchema, localId } from '../../harness/v1/native-run-identifiers';
import { leaseGrantSchema } from '../../node-protocol/v1';
import { RESOURCE_BOUND_WIRE_V2_NAMESPACE, resourceAdmissionBindingSchemaV2, resourceBoundWireV2Digest, type ResourceAdmissionBindingV2 } from './common';

export const CODEX_START_OPERATION_V2 = 'harness.codex.app-server.start' as const;
export const CODEX_DELIVERY_FEATURE_V2 = 'harness.codex.dispatch.v2' as const;
export const CODEX_ACTIVATION_FEATURE_V2 = 'harness.codex.activation.v2' as const;
export const CODEX_LEASE_FEATURE_V2 = 'harness.codex.lease.v2' as const;
export const CODEX_RESOURCE_QUEUE_SCHEMA_V2 = 'control-room.resource-bound-codex-queue/v2' as const;
export const CODEX_RESOURCE_SUBMISSION_SCHEMA_V2 = 'control-room.resource-bound-codex-submission/v2' as const;
export const CODEX_RESOURCE_LEASE_SCHEMA_V2 = 'control-room.resource-bound-codex-lease/v2' as const;
export const CODEX_APP_SERVER_ADAPTER_V2 = 'codex-app-server/v1' as const;
export const CODEX_APP_SERVER_CAPABILITY_V2 = 'harness.codex.app-server.v1' as const;
export const CODEX_APP_SERVER_JOB_TYPE_V2 = 'harness.codex.app-server.task' as const;

const epoch = z.number().int().positive();
const unixInstant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const isoInstant = z.string().datetime();
const rpcId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const boundedText = (bytes: number) => z.string().refine(value => Buffer.byteLength(value, 'utf8') <= bytes);
const resourceShape = resourceAdmissionBindingSchemaV2.shape;
const fail = (message: string): never => { throw new Error(message); };
const codexBoundaryDigest = (kind: string, value: unknown) => resourceBoundWireV2Digest(
  `${RESOURCE_BOUND_WIRE_V2_NAMESPACE}/codex-${kind}/v2`, value,
);
const negativeCapabilities = {
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false), permitsResume: z.literal(false),
  permitsRetry: z.literal(false), permitsThreadRead: z.literal(false),
};

function sameResourceBinding(left: ResourceAdmissionBindingV2, right: ResourceAdmissionBindingV2): boolean {
  return left.resourceAdmissionId === right.resourceAdmissionId
    && left.resourceAdmissionDigest === right.resourceAdmissionDigest;
}

function sameCodexScope(left: { tenantId: string; nodeId: string; projectId: string; jobId: string; attemptId: string },
  right: { tenantId: string; nodeId: string; projectId: string; jobId: string; attemptId: string }): boolean {
  return left.tenantId === right.tenantId && left.nodeId === right.nodeId && left.projectId === right.projectId
    && left.jobId === right.jobId && left.attemptId === right.attemptId;
}

const taskRunIdentitySchemaV2 = z.object({
  tenantId: localId, nodeId: localId, projectId: localId, jobId: localId,
  attemptId: localId, leaseId: localId, leaseEpoch: epoch,
  ...resourceShape,
}).strict();

/** Stable v2 run identity. Its namespaced preimage includes the admitted resource. */
export function codexTaskRunIdV2(value: unknown): string {
  const source = value as Record<string, unknown>;
  const identity = taskRunIdentitySchemaV2.parse({
    tenantId: source.tenantId, nodeId: source.nodeId, projectId: source.projectId,
    jobId: source.jobId, attemptId: source.attemptId, leaseId: source.leaseId,
    leaseEpoch: source.leaseEpoch, resourceAdmissionId: source.resourceAdmissionId,
    resourceAdmissionDigest: source.resourceAdmissionDigest,
  });
  return `run:codex-task:${sha256Digest({ schema: 'control-room.codex-task-run-identity/v2', ...identity }).slice(7)}`;
}

export const codexTaskStartSchemaV2 = z.object({
  schema: z.literal('control-room.codex-task-start/v2'),
  tenantId: localId, nodeId: localId, projectId: localId, jobId: localId,
  attemptId: localId, runId: localId, leaseId: localId, leaseEpoch: epoch,
  ...resourceShape,
  effectClaimKey: digestSchema, operationDigest: digestSchema, inputDigest: digestSchema,
  enrollmentDigest: digestSchema, connectorProfileDigest: digestSchema, workspaceIntentDigest: digestSchema,
  prompt: boundedText(32_768).min(1), instructions: boundedText(8192), deadline: unixInstant,
}).strict();
export type CodexTaskStartV2 = z.infer<typeof codexTaskStartSchemaV2>;

/** The resource pair enters this payload before operation/effect authorization is derived. */
export function codexTaskPayloadDigestV2(startValue: unknown, authorityDigestValue: string): string {
  const start = codexTaskStartSchemaV2.parse(startValue);
  const authorityDigest = digestSchema.parse(authorityDigestValue);
  return sha256Digest({
    schema: 'control-room.codex-task-effect-payload/v2',
    resourceAdmissionId: start.resourceAdmissionId,
    resourceAdmissionDigest: start.resourceAdmissionDigest,
    enrollmentDigest: start.enrollmentDigest,
    connectorProfileDigest: start.connectorProfileDigest,
    workspaceIntentDigest: start.workspaceIntentDigest,
    inputDigest: start.inputDigest,
    leaseId: start.leaseId,
    leaseEpoch: start.leaseEpoch,
    authorityDigest,
    deadline: start.deadline,
  });
}

/** Deterministic v2 queue identity. The admitted resource prevents cross-admission replay. */
export function codexTaskQueueIdV2(value: unknown): string {
  const source = value as Record<string, unknown>;
  const identity = z.object({
    tenantId: localId, jobId: localId, attemptId: localId, ...resourceShape,
  }).strict().parse({
    tenantId: source.tenantId, jobId: source.jobId, attemptId: source.attemptId,
    resourceAdmissionId: source.resourceAdmissionId,
    resourceAdmissionDigest: source.resourceAdmissionDigest,
  });
  return `native-queue:${sha256Digest({
    schema: 'control-room.resource-bound-wire/v2/native-queue/v2', ...identity,
  }).slice(7)}`;
}

function startMatchesCodexRequest(start: CodexTaskStartV2, request: z.infer<typeof normalizedLocalPolicyRequestSchema>): boolean {
  return sameCodexScope(start, request) && start.leaseId === request.leaseId && start.leaseEpoch === request.leaseEpoch
    && request.operationId === CODEX_START_OPERATION_V2 && request.externalEffect && request.risk === 'low'
    && request.approval === undefined && request.estimatedDurationSeconds >= 1 && request.estimatedDurationSeconds <= 300
    && request.estimatedCostUsd === undefined && request.credentialRefs.length === 1 && request.target.kind === 'filesystem'
    && start.inputDigest === sha256Digest({ prompt: start.prompt, instructions: start.instructions })
    && request.payloadDigest === codexTaskPayloadDigestV2(start, request.authorityDigest)
    && request.operationDigest === computeNormalizedOperationDigest(request) && start.operationDigest === request.operationDigest
    && start.effectClaimKey === computeEffectClaimKey(request) && start.runId === codexTaskRunIdV2(start);
}

/** Inert v2 queue intent that commits the existing request and start identities. */
export const codexResourceQueueSchemaV2 = z.object({
  schema: z.literal(CODEX_RESOURCE_QUEUE_SCHEMA_V2), queueId: localId,
  tenantId: localId, nodeId: localId, projectId: localId, jobId: localId, attemptId: localId,
  leaseId: localId, leaseEpoch: epoch, ...resourceShape,
  start: codexTaskStartSchemaV2, request: normalizedLocalPolicyRequestSchema,
  requestDigest: digestSchema, queueDigest: digestSchema, ...negativeCapabilities,
}).strict().superRefine((value, context) => {
  const { queueDigest, ...unsigned } = value;
  if (!sameResourceBinding(value, value.start) || !sameCodexScope(value, value.start)
    || value.leaseId !== value.start.leaseId || value.leaseEpoch !== value.start.leaseEpoch
    || !startMatchesCodexRequest(value.start, value.request)
    || value.queueId !== codexTaskQueueIdV2(value.start)
    || value.requestDigest !== codexBoundaryDigest('request', { resourceAdmission: {
      resourceAdmissionId: value.resourceAdmissionId, resourceAdmissionDigest: value.resourceAdmissionDigest }, request: value.request })
    || value.queueDigest !== codexBoundaryDigest('queue', { resourceAdmission: {
      resourceAdmissionId: value.resourceAdmissionId, resourceAdmissionDigest: value.resourceAdmissionDigest }, queue: unsigned })) {
    context.addIssue({ code: 'custom', message: 'codex v2 queue intent mismatch' });
  }
});
export type CodexResourceQueueV2 = z.infer<typeof codexResourceQueueSchemaV2>;

export function createCodexResourceQueueV2(value: Omit<CodexResourceQueueV2, 'queueId' | 'requestDigest' | 'queueDigest'
  | 'startsWork' | 'grantsExecutionAuthority' | 'permitsResume' | 'permitsRetry' | 'permitsThreadRead'>): Readonly<CodexResourceQueueV2> {
  const queueId = codexTaskQueueIdV2(value.start);
  const resourceAdmission = { resourceAdmissionId: value.resourceAdmissionId, resourceAdmissionDigest: value.resourceAdmissionDigest };
  const requestDigest = codexBoundaryDigest('request', { resourceAdmission, request: value.request });
  const unsigned = { ...value, queueId, requestDigest, startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  return verifyCodexResourceQueueV2({ ...unsigned, queueDigest: codexBoundaryDigest('queue', { resourceAdmission, queue: unsigned }) });
}

/** A compact v2 reference to one already-committed queue intent. */
export const codexResourceSubmissionSchemaV2 = z.object({
  schema: z.literal(CODEX_RESOURCE_SUBMISSION_SCHEMA_V2), submissionId: localId, queueId: localId, queueDigest: digestSchema,
  tenantId: localId, nodeId: localId, projectId: localId, jobId: localId, attemptId: localId,
  leaseId: localId, leaseEpoch: epoch, ...resourceShape,
  requestId: localId, requestDigest: digestSchema, startDigest: digestSchema, operationDigest: digestSchema,
  authorityDigest: digestSchema, payloadDigest: digestSchema, ...negativeCapabilities,
}).strict().superRefine((value, context) => {
  const { payloadDigest, ...unsigned } = value;
  const resourceAdmission = { resourceAdmissionId: value.resourceAdmissionId, resourceAdmissionDigest: value.resourceAdmissionDigest };
  const expectedId = `codex-submission:${codexBoundaryDigest('submission-id', {
    resourceAdmission, queueId: value.queueId, queueDigest: value.queueDigest }).slice(7)}`;
  if (value.submissionId !== expectedId || value.payloadDigest !== codexBoundaryDigest('submission', { resourceAdmission, submission: unsigned })) {
    context.addIssue({ code: 'custom', message: 'codex v2 submission reference mismatch' });
  }
});
export type CodexResourceSubmissionV2 = z.infer<typeof codexResourceSubmissionSchemaV2>;

export function createCodexResourceSubmissionV2(queueValue: unknown): Readonly<CodexResourceSubmissionV2> {
  const queue = verifyCodexResourceQueueV2(queueValue);
  const resourceAdmission = { resourceAdmissionId: queue.resourceAdmissionId, resourceAdmissionDigest: queue.resourceAdmissionDigest };
  const unsigned = {
    schema: CODEX_RESOURCE_SUBMISSION_SCHEMA_V2, queueId: queue.queueId, queueDigest: queue.queueDigest,
    tenantId: queue.tenantId, nodeId: queue.nodeId, projectId: queue.projectId, jobId: queue.jobId, attemptId: queue.attemptId,
    leaseId: queue.leaseId, leaseEpoch: queue.leaseEpoch, ...resourceAdmission, requestId: queue.request.requestId,
    requestDigest: queue.requestDigest, startDigest: codexBoundaryDigest('start', { resourceAdmission, start: queue.start }),
    operationDigest: queue.start.operationDigest, authorityDigest: queue.request.authorityDigest,
    startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const,
    permitsRetry: false as const, permitsThreadRead: false as const,
  };
  const submissionId = `codex-submission:${codexBoundaryDigest('submission-id', {
    resourceAdmission, queueId: queue.queueId, queueDigest: queue.queueDigest }).slice(7)}`;
  return verifyCodexResourceSubmissionV2({ ...unsigned, submissionId,
    payloadDigest: codexBoundaryDigest('submission', { resourceAdmission, submission: { ...unsigned, submissionId } }) });
}

/** V2 lease envelope retains the canonical grant while binding it to one submission reference. */
export const codexResourceLeaseSchemaV2 = z.object({
  schema: z.literal(CODEX_RESOURCE_LEASE_SCHEMA_V2), submission: codexResourceSubmissionSchemaV2,
  submissionDigest: digestSchema, tenantId: localId, nodeId: localId, projectId: localId, jobId: localId, attemptId: localId,
  leaseId: localId, leaseEpoch: epoch, ...resourceShape, leaseGrant: leaseGrantSchema,
  leaseFeature: z.literal(CODEX_LEASE_FEATURE_V2), payloadDigest: digestSchema, ...negativeCapabilities,
}).strict().superRefine((value, context) => {
  const { payloadDigest, ...unsigned } = value;
  const submission = value.submission, grant = value.leaseGrant;
  const resourceAdmission = { resourceAdmissionId: value.resourceAdmissionId, resourceAdmissionDigest: value.resourceAdmissionDigest };
  if (!sameResourceBinding(value, submission) || !sameCodexScope(value, submission)
    || value.leaseId !== submission.leaseId || value.leaseEpoch !== submission.leaseEpoch
    || value.submissionDigest !== submission.payloadDigest || grant.nodeId !== submission.nodeId
    || grant.jobId !== submission.jobId || grant.attemptId !== submission.attemptId || grant.leaseId !== submission.leaseId
    || grant.leaseEpoch !== submission.leaseEpoch || grant.authorityDigest !== submission.authorityDigest
    || value.payloadDigest !== codexBoundaryDigest('lease', { resourceAdmission, lease: unsigned })) {
    context.addIssue({ code: 'custom', message: 'codex v2 lease envelope mismatch' });
  }
});
export type CodexResourceLeaseV2 = z.infer<typeof codexResourceLeaseSchemaV2>;

export function createCodexResourceLeaseV2(submissionValue: unknown, leaseGrantValue: unknown): Readonly<CodexResourceLeaseV2> {
  const submission = verifyCodexResourceSubmissionV2(submissionValue), leaseGrant = leaseGrantSchema.parse(leaseGrantValue);
  const resourceAdmission = { resourceAdmissionId: submission.resourceAdmissionId, resourceAdmissionDigest: submission.resourceAdmissionDigest };
  const unsigned = {
    schema: CODEX_RESOURCE_LEASE_SCHEMA_V2, submission, submissionDigest: submission.payloadDigest,
    tenantId: submission.tenantId, nodeId: submission.nodeId, projectId: submission.projectId, jobId: submission.jobId,
    attemptId: submission.attemptId, leaseId: submission.leaseId, leaseEpoch: submission.leaseEpoch,
    ...resourceAdmission, leaseGrant, leaseFeature: CODEX_LEASE_FEATURE_V2,
    startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const,
    permitsRetry: false as const, permitsThreadRead: false as const,
  };
  return verifyCodexResourceLeaseV2({ ...unsigned,
    payloadDigest: codexBoundaryDigest('lease', { resourceAdmission, lease: unsigned }) });
}

export const verifyCodexResourceQueueV2 = (value: unknown): Readonly<CodexResourceQueueV2> => Object.freeze(codexResourceQueueSchemaV2.parse(value));
export const verifyCodexResourceSubmissionV2 = (value: unknown): Readonly<CodexResourceSubmissionV2> => Object.freeze(codexResourceSubmissionSchemaV2.parse(value));
export const verifyCodexResourceLeaseV2 = (value: unknown): Readonly<CodexResourceLeaseV2> => Object.freeze(codexResourceLeaseSchemaV2.parse(value));

export const codexTaskDispatchBodySchemaV2 = z.object({
  schema: z.literal('control-room.codex-task-dispatch/v2'),
  queueId: localId, tenantId: localId, nodeId: localId, projectId: localId, jobId: localId, attemptId: localId,
  leaseId: localId, leaseEpoch: epoch,
  ...resourceShape,
  queue: codexResourceQueueSchemaV2, queueDigest: digestSchema,
  submission: codexResourceSubmissionSchemaV2, submissionDigest: digestSchema,
  lease: codexResourceLeaseSchemaV2, leaseDigest: digestSchema,
  start: codexTaskStartSchemaV2,
  request: normalizedLocalPolicyRequestSchema,
  permit: ownerApprovalAttestationSchema,
  permitDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { start, request, permit } = value;
  const approval = permit.body;
  const resourceMatches = sameResourceBinding(value, start);
  const identityMatches = request.tenantId === start.tenantId && request.nodeId === start.nodeId
    && request.projectId === start.projectId && request.jobId === start.jobId
    && request.attemptId === start.attemptId && request.leaseId === start.leaseId
    && request.leaseEpoch === start.leaseEpoch && approval.tenantId === start.tenantId
    && approval.nodeId === start.nodeId && approval.projectId === start.projectId
    && approval.jobId === start.jobId && approval.attemptId === start.attemptId;
  const approvalTime = Date.parse(approval.issuedAt);
  const requestTime = Date.parse(request.occurredAt);
  const chainMismatch = !sameResourceBinding(value.queue, value) || !sameCodexScope(value.queue, value)
    || !sameResourceBinding(value.submission, value) || !sameCodexScope(value.submission, value)
    || !sameResourceBinding(value.lease, value) || !sameCodexScope(value.lease, value)
    || value.queueDigest !== value.queue.queueDigest || value.submissionDigest !== value.submission.payloadDigest
    || value.leaseDigest !== value.lease.payloadDigest || value.queue.queueId !== value.queueId
    || value.submission.queueId !== value.queue.queueId || value.submission.queueDigest !== value.queue.queueDigest
    || value.lease.submissionDigest !== value.submission.payloadDigest
    || value.lease.submission.submissionId !== value.submission.submissionId
    || value.lease.leaseGrant.authorityDigest !== request.authorityDigest
    || value.queue.requestDigest !== value.submission.requestDigest
    || value.queue.start.operationDigest !== start.operationDigest || value.queue.request.requestId !== request.requestId
    || value.submission.startDigest !== codexBoundaryDigest('start', { resourceAdmission: {
      resourceAdmissionId: value.resourceAdmissionId, resourceAdmissionDigest: value.resourceAdmissionDigest }, start })
    || value.submission.operationDigest !== request.operationDigest || value.submission.authorityDigest !== request.authorityDigest;
  if (!resourceMatches
    || value.queueId !== codexTaskQueueIdV2(start)
    || chainMismatch
    || request.approval
    || start.inputDigest !== sha256Digest({ prompt: start.prompt, instructions: start.instructions })
    || !identityMatches
    || request.operationId !== CODEX_START_OPERATION_V2
    || !request.externalEffect
    || request.risk !== 'low'
    || request.estimatedDurationSeconds < 1
    || request.estimatedDurationSeconds > 300
    || request.estimatedCostUsd !== undefined
    || request.credentialRefs.length !== 1
    || request.target.kind !== 'filesystem'
    || request.payloadDigest !== codexTaskPayloadDigestV2(start, request.authorityDigest)
    || request.operationDigest !== computeNormalizedOperationDigest(request)
    || start.operationDigest !== request.operationDigest
    || start.effectClaimKey !== computeEffectClaimKey(request)
    || start.runId !== codexTaskRunIdV2(start)
    || approval.operationDigest !== request.operationDigest
    || approval.risk !== request.risk
    || approval.decision !== 'approved'
    || !Number.isFinite(approvalTime)
    || approvalTime < requestTime
    || Date.parse(approval.expiresAt) < start.deadline
    || value.permitDigest !== sha256Digest(permit)
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 65_536) {
    context.addIssue({ code: 'custom', message: 'codex v2 dispatch binding mismatch' });
  }
});
export type CodexTaskDispatchBodyV2 = z.infer<typeof codexTaskDispatchBodySchemaV2>;

export function codexApprovalPacketDigestV2(value: unknown): string {
  const body = codexTaskDispatchBodySchemaV2.parse(value);
  return sha256Digest({
    schema: 'control-room.codex-approval-packet/v2',
    resourceAdmissionId: body.resourceAdmissionId,
    resourceAdmissionDigest: body.resourceAdmissionDigest,
    request: body.request,
    permit: body.permit,
    permitDigest: body.permitDigest,
  });
}

export function codexExecutionBindingDigestV2(value: unknown): string {
  const { schema: _schema, prompt: _prompt, instructions: _instructions, ...binding } =
    codexTaskDispatchBodySchemaV2.parse(value).start;
  void _schema; void _prompt; void _instructions;
  return sha256Digest({ schema: 'control-room.codex-execution-binding/v2', ...binding });
}

export const codexTaskDispatchReceiptBodySchemaV2 = z.object({
  schema: z.literal('control-room.codex-task-dispatch-receipt/v2'),
  queueId: localId, dispatchMessageId: localId, dispatchBodyDigest: digestSchema,
  tenantId: localId, projectId: localId, nodeId: localId, jobId: localId, attemptId: localId,
  ...resourceShape,
  permitDigest: digestSchema, enrollmentDigest: digestSchema, recordedAt: isoInstant,
  disposition: z.enum(['recorded', 'rejected']),
  safeReason: z.enum(['none', 'expired', 'binding_mismatch', 'authority_unavailable', 'storage_uncertain']),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if ((value.disposition === 'recorded') !== (value.safeReason === 'none')) {
    context.addIssue({ code: 'custom', message: 'codex v2 receipt disposition mismatch' });
  }
});
export type CodexTaskDispatchReceiptBodyV2 = z.infer<typeof codexTaskDispatchReceiptBodySchemaV2>;

/** Call only after authenticating the receipt frame. This matches evidence, not authority. */
export function matchCodexTaskDispatchReceiptV2(receiptValue: unknown, expected: {
  messageId: string; body: CodexTaskDispatchBodyV2;
}): CodexTaskDispatchReceiptBodyV2 {
  const receipt = codexTaskDispatchReceiptBodySchemaV2.parse(receiptValue);
  const body = codexTaskDispatchBodySchemaV2.parse(expected.body);
  const start = body.start;
  if (receipt.dispatchMessageId !== localId.parse(expected.messageId)
    || receipt.dispatchBodyDigest !== sha256Digest(body)
    || receipt.queueId !== body.queueId
    || !sameResourceBinding(receipt, body)
    || !sameResourceBinding(receipt, start)
    || receipt.tenantId !== start.tenantId || receipt.projectId !== start.projectId
    || receipt.nodeId !== start.nodeId || receipt.jobId !== start.jobId
    || receipt.attemptId !== start.attemptId || receipt.permitDigest !== body.permitDigest
    || receipt.disposition !== 'recorded' || receipt.safeReason !== 'none'
    || receipt.enrollmentDigest !== start.enrollmentDigest) {
    return fail('codex_v2_dispatch_receipt_mismatch');
  }
  return receipt;
}

export const codexCurrentAdmissionSchemaV2 = z.object({
  schema: z.literal('control-room.codex-current-admission/v2'),
  tenantId: localId, projectId: localId, projectVersion: z.number().int().positive(), projectLifecycle: z.literal('active'),
  jobId: localId, jobVersion: z.number().int().nonnegative(), jobState: z.literal('leased'),
  attemptId: localId, attemptVersion: z.number().int().nonnegative(), attemptState: z.literal('leased'),
  leaseId: localId, leaseVersion: z.number().int().nonnegative(), leaseEpoch: epoch,
  leaseState: z.literal('active'), leaseExpiresAt: isoInstant,
  nodeId: localId, nodeVersion: z.number().int().nonnegative(), nodeState: z.literal('active'),
  nodeKeyId: localId, nodeKeyState: z.literal('active'), nodeKeyValidFrom: isoInstant, nodeKeyValidUntil: isoInstant.nullable(),
  authorityDigest: digestSchema, authorityExpiresAt: isoInstant,
  approvalKeyId: localId, approvalExpiresAt: isoInstant, ownerTrustRevisionDigest: digestSchema,
  queueId: localId, dispatchMessageId: localId, dispatchFrameDigest: digestSchema,
  receiptMessageId: localId, receiptFrameDigest: digestSchema,
  ...resourceShape,
  permitDigest: digestSchema, inputDigest: digestSchema, operationDigest: digestSchema, effectClaimKey: digestSchema,
  enrollmentDigest: digestSchema, connectorProfileDigest: digestSchema, workspaceIntentDigest: digestSchema,
  configurationExpiresAt: isoInstant, connectionId: localId, checkedAt: isoInstant, admissionExpiresAt: isoInstant,
}).strict();
export type CodexCurrentAdmissionV2 = z.infer<typeof codexCurrentAdmissionSchemaV2>;

export function codexCurrentAdmissionDigestV2(value: unknown): string {
  const admission = codexCurrentAdmissionSchemaV2.parse(value);
  return sha256Digest({ schema: 'control-room.codex-current-admission-digest/v2', admission });
}

export type CodexDispatchFrameForActivationV2 = Readonly<{
  type: 'harness.codex.dispatch'; direction: 'node_to_server' | 'server_to_node'; senderKind: 'node' | 'control_room';
  messageId: string; tenantId: string; actorId: string; keyId: string; connectionId: string;
  sentAt: string; expiresAt: string; body: CodexTaskDispatchBodyV2;
}>;
export type CodexDispatchReceiptFrameForActivationV2 = Readonly<{
  type: 'harness.codex.dispatch.receipt'; direction: 'node_to_server' | 'server_to_node'; senderKind: 'node' | 'control_room';
  messageId: string; causationId?: string; tenantId: string; actorId: string; keyId: string;
  connectionId: string; sentAt: string; expiresAt: string; body: CodexTaskDispatchReceiptBodyV2;
}>;

/** Matches the current-admission wire snapshot to its exact authenticated delivery evidence. */
export function matchCodexCurrentAdmissionV2(admissionValue: unknown, expected: {
  dispatch: CodexDispatchFrameForActivationV2;
  receipt: CodexDispatchReceiptFrameForActivationV2;
}): CodexCurrentAdmissionV2 {
  const admission = codexCurrentAdmissionSchemaV2.parse(admissionValue);
  const body = codexTaskDispatchBodySchemaV2.parse(expected.dispatch.body);
  const receipt = matchCodexTaskDispatchReceiptV2(expected.receipt.body, {
    messageId: expected.dispatch.messageId, body,
  });
  const start = body.start;
  if (!sameResourceBinding(admission, body)
    || admission.tenantId !== start.tenantId || admission.projectId !== start.projectId
    || admission.jobId !== start.jobId || admission.attemptId !== start.attemptId
    || admission.leaseId !== start.leaseId || admission.leaseEpoch !== start.leaseEpoch
    || admission.nodeId !== start.nodeId || admission.queueId !== body.queueId
    || admission.dispatchMessageId !== expected.dispatch.messageId
    || admission.dispatchFrameDigest !== sha256Digest(expected.dispatch)
    || admission.receiptMessageId !== expected.receipt.messageId
    || admission.receiptFrameDigest !== sha256Digest(expected.receipt)
    || admission.permitDigest !== body.permitDigest || admission.inputDigest !== start.inputDigest
    || admission.operationDigest !== start.operationDigest || admission.effectClaimKey !== start.effectClaimKey
    || admission.enrollmentDigest !== start.enrollmentDigest
    || admission.connectorProfileDigest !== start.connectorProfileDigest
    || admission.workspaceIntentDigest !== start.workspaceIntentDigest
    || admission.connectionId !== expected.dispatch.connectionId
    || admission.authorityDigest !== body.request.authorityDigest
    || admission.approvalKeyId !== body.permit.body.approvalKeyId
    || admission.approvalExpiresAt !== body.permit.body.expiresAt
    || receipt.resourceAdmissionId !== admission.resourceAdmissionId) {
    return fail('codex_v2_current_admission_mismatch');
  }
  return admission;
}

const activationMaterialSchemaV2 = z.object({
  schema: z.literal('control-room.codex-task-activation/v2'),
  tenantId: localId, projectId: localId, nodeId: localId, jobId: localId,
  attemptId: localId, runId: localId, leaseId: localId, leaseEpoch: epoch,
  queueId: localId, connectionId: localId,
  ...resourceShape,
  dispatchMessageId: localId, dispatchFrameDigest: digestSchema, dispatchBodyDigest: digestSchema,
  receiptMessageId: localId, receiptFrameDigest: digestSchema, receiptBodyDigest: digestSchema,
  permitDigest: digestSchema, inputDigest: digestSchema, operationDigest: digestSchema,
  effectClaimKey: digestSchema, enrollmentDigest: digestSchema, connectorProfileDigest: digestSchema,
  workspaceIntentDigest: digestSchema, currentAdmissionDigest: digestSchema,
  workspacePath: boundedText(4096).min(1), prompt: boundedText(32_768).min(1), instructions: boundedText(8192),
  receiptRecordedAt: isoInstant, receiptReceivedAt: isoInstant, activatedAt: isoInstant, activationExpiresAt: isoInstant,
  startsWork: z.literal(false), authorizesExactStart: z.literal(true), grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false), permitsResume: z.literal(false), permitsThreadRead: z.literal(false),
}).strict();

export const codexTaskActivationBodySchemaV2 = activationMaterialSchemaV2.extend({
  activationId: localId,
  activationDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { activationId, activationDigest, ...material } = value;
  const expectedDigest = computeCodexTaskActivationDigestV2(material);
  if (activationDigest !== expectedDigest || activationId !== `codex-activation-v2:${expectedDigest.slice(7)}`) {
    context.addIssue({ code: 'custom', message: 'codex v2 activation digest mismatch' });
  }
  if (Date.parse(value.activationExpiresAt) <= Date.parse(value.activatedAt)
    || Date.parse(value.receiptReceivedAt) < Date.parse(value.receiptRecordedAt)
    || Date.parse(value.activatedAt) < Date.parse(value.receiptReceivedAt)
    || value.inputDigest !== sha256Digest({ prompt: value.prompt, instructions: value.instructions })
    || (!value.workspacePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value.workspacePath))
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 65_536) {
    context.addIssue({ code: 'custom', message: 'codex v2 activation timing or size mismatch' });
  }
});
export type CodexTaskActivationBodyV2 = z.infer<typeof codexTaskActivationBodySchemaV2>;

export type CodexActivationFrameV2 = Readonly<{
  type: 'harness.codex.dispatch.activation'; direction: 'node_to_server' | 'server_to_node'; senderKind: 'node' | 'control_room';
  messageId: string; causationId?: string; tenantId: string; actorId: string; keyId: string;
  connectionId: string; sentAt: string; expiresAt: string; body: CodexTaskActivationBodyV2;
}>;

export function computeCodexTaskActivationDigestV2(value: unknown): string {
  const material = activationMaterialSchemaV2.parse(value);
  return sha256Digest({ schema: 'control-room.codex-task-activation-digest/v2', material });
}

export function parseCodexTaskActivationV2(value: unknown): CodexTaskActivationBodyV2 {
  return codexTaskActivationBodySchemaV2.parse(value);
}

type ActivationSourcesV2 = {
  dispatch: CodexDispatchFrameForActivationV2;
  receipt: CodexDispatchReceiptFrameForActivationV2;
  currentAdmission: CodexCurrentAdmissionV2;
  receiptReceivedAt: string;
};

function matchActivationSourcesV2(value: CodexTaskActivationBodyV2, expected: ActivationSourcesV2) {
  const dispatch = expected.dispatch;
  const receipt = expected.receipt;
  const body = codexTaskDispatchBodySchemaV2.parse(dispatch.body);
  const receiptBody = matchCodexTaskDispatchReceiptV2(receipt.body, { messageId: dispatch.messageId, body });
  const admission = matchCodexCurrentAdmissionV2(expected.currentAdmission, { dispatch, receipt });
  const start = body.start;
  if (dispatch.type !== 'harness.codex.dispatch' || dispatch.direction !== 'server_to_node'
    || dispatch.senderKind !== 'control_room' || receipt.type !== 'harness.codex.dispatch.receipt'
    || receipt.direction !== 'node_to_server' || receipt.senderKind !== 'node'
    || dispatch.tenantId !== start.tenantId || receipt.causationId !== dispatch.messageId
    || receipt.tenantId !== dispatch.tenantId || receipt.actorId !== start.nodeId
    || receipt.connectionId !== dispatch.connectionId
    || Date.parse(expected.receiptReceivedAt) < Date.parse(receipt.sentAt)
    || !sameResourceBinding(value, body)
    || !sameResourceBinding(value, admission)
    || value.tenantId !== start.tenantId || value.projectId !== start.projectId
    || value.nodeId !== start.nodeId || value.jobId !== start.jobId || value.attemptId !== start.attemptId
    || value.runId !== start.runId || value.leaseId !== start.leaseId || value.leaseEpoch !== start.leaseEpoch
    || value.queueId !== body.queueId || value.connectionId !== dispatch.connectionId
    || value.dispatchMessageId !== dispatch.messageId || value.dispatchFrameDigest !== sha256Digest(dispatch)
    || value.dispatchBodyDigest !== sha256Digest(body) || value.receiptMessageId !== receipt.messageId
    || value.receiptFrameDigest !== sha256Digest(receipt) || value.receiptBodyDigest !== sha256Digest(receiptBody)
    || value.permitDigest !== body.permitDigest || value.inputDigest !== start.inputDigest
    || value.operationDigest !== start.operationDigest || value.effectClaimKey !== start.effectClaimKey
    || value.enrollmentDigest !== start.enrollmentDigest
    || value.connectorProfileDigest !== start.connectorProfileDigest
    || value.workspaceIntentDigest !== start.workspaceIntentDigest
    || value.workspacePath !== (body.request.target.kind === 'filesystem' ? body.request.target.canonicalPath : '')
    || value.prompt !== start.prompt || value.instructions !== start.instructions
    || value.currentAdmissionDigest !== codexCurrentAdmissionDigestV2(admission)
    || value.receiptRecordedAt !== receiptBody.recordedAt
    || value.receiptReceivedAt !== expected.receiptReceivedAt) {
    return fail('codex_v2_activation_mismatch');
  }
  return { dispatch, receipt, body, receiptBody, admission };
}

/** Builds bounded, effect-free activation evidence after exact receipt/current-admission matching. */
export function buildCodexTaskActivationV2(input: ActivationSourcesV2 & {
  activatedAt: string;
  activationExpiresAt: string;
}): CodexTaskActivationBodyV2 {
  const start = codexTaskDispatchBodySchemaV2.parse(input.dispatch.body).start;
  const admission = codexCurrentAdmissionSchemaV2.parse(input.currentAdmission);
  const material = activationMaterialSchemaV2.parse({
    schema: 'control-room.codex-task-activation/v2',
    tenantId: start.tenantId, projectId: start.projectId, nodeId: start.nodeId, jobId: start.jobId,
    attemptId: start.attemptId, runId: start.runId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch,
    queueId: input.dispatch.body.queueId, connectionId: input.dispatch.connectionId,
    resourceAdmissionId: start.resourceAdmissionId, resourceAdmissionDigest: start.resourceAdmissionDigest,
    dispatchMessageId: input.dispatch.messageId, dispatchFrameDigest: sha256Digest(input.dispatch),
    dispatchBodyDigest: sha256Digest(input.dispatch.body), receiptMessageId: input.receipt.messageId,
    receiptFrameDigest: sha256Digest(input.receipt), receiptBodyDigest: sha256Digest(input.receipt.body),
    permitDigest: input.dispatch.body.permitDigest, inputDigest: start.inputDigest,
    operationDigest: start.operationDigest, effectClaimKey: start.effectClaimKey,
    enrollmentDigest: start.enrollmentDigest, connectorProfileDigest: start.connectorProfileDigest,
    workspaceIntentDigest: start.workspaceIntentDigest,
    currentAdmissionDigest: codexCurrentAdmissionDigestV2(admission),
    workspacePath: input.dispatch.body.request.target.kind === 'filesystem'
      ? input.dispatch.body.request.target.canonicalPath : '',
    prompt: start.prompt, instructions: start.instructions,
    receiptRecordedAt: input.receipt.body.recordedAt, receiptReceivedAt: input.receiptReceivedAt,
    activatedAt: input.activatedAt, activationExpiresAt: input.activationExpiresAt,
    startsWork: false, authorizesExactStart: true, grantsExecutionAuthority: false,
    permitsRetry: false, permitsResume: false, permitsThreadRead: false,
  });
  const activationDigest = computeCodexTaskActivationDigestV2(material);
  const activation = codexTaskActivationBodySchemaV2.parse({
    ...material, activationId: `codex-activation-v2:${activationDigest.slice(7)}`, activationDigest,
  });
  matchActivationSourcesV2(activation, input);
  return Object.freeze(activation);
}

/** Matches exact delivery and admission evidence; it grants no execution capability. */
export function matchCodexTaskActivationV2(activationFrame: CodexActivationFrameV2,
  expected: ActivationSourcesV2): CodexTaskActivationBodyV2 {
  const activation = parseCodexTaskActivationV2(activationFrame.body);
  const matched = matchActivationSourcesV2(activation, expected);
  if (activationFrame.type !== 'harness.codex.dispatch.activation'
    || activationFrame.direction !== 'server_to_node' || activationFrame.senderKind !== 'control_room'
    || activationFrame.tenantId !== activation.tenantId
    || activationFrame.connectionId !== activation.connectionId
    || activationFrame.causationId !== activation.receiptMessageId
    || activationFrame.actorId !== matched.dispatch.actorId
    || activationFrame.keyId !== matched.dispatch.keyId
    || activationFrame.connectionId !== matched.dispatch.connectionId
    || activationFrame.sentAt !== activation.activatedAt
    || Date.parse(activationFrame.expiresAt) > Date.parse(activation.activationExpiresAt)
    || Date.parse(activationFrame.expiresAt) > matched.body.start.deadline) {
    return fail('codex_v2_activation_mismatch');
  }
  return activation;
}

const startScopeSchemaV2 = z.object({
  tenantId: localId, nodeId: localId, projectId: localId, jobId: localId,
  attemptId: localId, runId: localId, leaseId: localId, leaseEpoch: epoch, operationDigest: digestSchema,
}).strict();

const adapterSchemaV2 = z.object({
  package: z.literal(CODEX_APP_SERVER_START_CONTRACT.package),
  version: z.literal(CODEX_APP_SERVER_START_CONTRACT.version),
  generatedBundleSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.generatedBundleSha256),
  threadStartResponseSchemaSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256),
  turnStartResponseSchemaSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256),
  transport: z.literal('json_rpc_stdio'),
}).strict();

export const codexStartAdmissionSchemaV2 = z.object({
  schema: z.literal('control-room.codex-start-admission/v2'),
  admissionId: localId,
  scope: startScopeSchemaV2,
  queueId: localId,
  ...resourceShape,
  requestMessageId: localId, activationMessageId: localId, activationId: localId,
  activationDigest: digestSchema, activationFrameDigest: digestSchema,
  dispatchMessageId: localId, dispatchFrameDigest: digestSchema,
  receiptMessageId: localId, receiptFrameDigest: digestSchema,
  workspacePath: z.string().min(1).max(4096), deliveryDigest: digestSchema,
  enrollmentDigest: digestSchema, permitDigest: digestSchema, currentAdmissionDigest: digestSchema,
  inputDigest: digestSchema, method: z.literal('thread/start'), connectionAttemptId: localId,
  initializedConnectionDigest: digestSchema, threadStartRequestId: rpcId, adapter: adapterSchemaV2,
  requestedAt: isoInstant, deadline: isoInstant,
  startAuthorizationDigest: digestSchema, contractDigest: digestSchema,
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
  permitsResume: z.literal(false), permitsRetry: z.literal(false), permitsThreadRead: z.literal(false),
}).strict();
export type CodexStartAdmissionV2 = z.infer<typeof codexStartAdmissionSchemaV2>;

type CodexStartAdmissionInputV2 = Omit<CodexStartAdmissionV2,
  'admissionId' | 'adapter' | 'startAuthorizationDigest' | 'contractDigest' | 'startsWork' | 'grantsExecutionAuthority'
  | 'permitsResume' | 'permitsRetry' | 'permitsThreadRead'>;

const adapterV2 = Object.freeze({
  package: CODEX_APP_SERVER_START_CONTRACT.package,
  version: CODEX_APP_SERVER_START_CONTRACT.version,
  generatedBundleSha256: CODEX_APP_SERVER_START_CONTRACT.generatedBundleSha256,
  threadStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256,
  turnStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256,
  transport: 'json_rpc_stdio' as const,
});

/**
 * Exact expected authorization value for a fresh resource-holder proof. This
 * hashes the complete unsigned start-admission contract without embedding a
 * proof or introducing a digest cycle.
 */
export function computeCodexStartAuthorizationDigestV2(value: unknown): string {
  const material = z.object({
    schema: z.literal('control-room.codex-start-admission/v2'), admissionId: localId,
    scope: startScopeSchemaV2, queueId: localId, ...resourceShape,
    requestMessageId: localId, activationMessageId: localId, activationId: localId,
    activationDigest: digestSchema, activationFrameDigest: digestSchema,
    dispatchMessageId: localId, dispatchFrameDigest: digestSchema,
    receiptMessageId: localId, receiptFrameDigest: digestSchema,
    workspacePath: z.string().min(1).max(4096), deliveryDigest: digestSchema,
    enrollmentDigest: digestSchema, permitDigest: digestSchema, currentAdmissionDigest: digestSchema,
    inputDigest: digestSchema, method: z.literal('thread/start'), connectionAttemptId: localId,
    initializedConnectionDigest: digestSchema, threadStartRequestId: rpcId, adapter: adapterSchemaV2,
    requestedAt: isoInstant, deadline: isoInstant,
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
    permitsResume: z.literal(false), permitsRetry: z.literal(false), permitsThreadRead: z.literal(false),
  }).strict().parse(value);
  return sha256Digest({ schema: 'control-room.codex-start-authorization/v2', admissionContract: material });
}

export function createCodexStartAdmissionV2(value: CodexStartAdmissionInputV2): CodexStartAdmissionV2 {
  const parsedInput = z.object({
    schema: z.literal('control-room.codex-start-admission/v2'), scope: startScopeSchemaV2,
    queueId: localId, ...resourceShape,
    requestMessageId: localId, activationMessageId: localId, activationId: localId,
    activationDigest: digestSchema, activationFrameDigest: digestSchema,
    dispatchMessageId: localId, dispatchFrameDigest: digestSchema,
    receiptMessageId: localId, receiptFrameDigest: digestSchema,
    workspacePath: z.string().min(1).max(4096), deliveryDigest: digestSchema,
    enrollmentDigest: digestSchema, permitDigest: digestSchema, currentAdmissionDigest: digestSchema,
    inputDigest: digestSchema, method: z.literal('thread/start'), connectionAttemptId: localId,
    initializedConnectionDigest: digestSchema, threadStartRequestId: rpcId,
    requestedAt: isoInstant, deadline: isoInstant,
  }).strict().parse(value);
  const { schema: _schema, ...identity } = parsedInput;
  void _schema;
  const admissionId = `codex-admission-v2:${sha256Digest({
    schema: 'control-room.codex-start-admission-identity/v2', ...identity, adapter: adapterV2,
  }).slice(7)}`;
  const authorizationMaterial = {
    schema: 'control-room.codex-start-admission/v2' as const,
    admissionId, ...identity, adapter: adapterV2,
    startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const,
  };
  const startAuthorizationDigest = computeCodexStartAuthorizationDigestV2(authorizationMaterial);
  const unsigned = { ...authorizationMaterial, startAuthorizationDigest };
  const admission = codexStartAdmissionSchemaV2.parse({
    ...unsigned,
    contractDigest: sha256Digest({ schema: 'control-room.codex-start-admission-contract-digest/v2', admission: unsigned }),
  });
  return verifyCodexStartAdmissionV2(admission);
}

export function verifyCodexStartAdmissionV2(value: unknown): CodexStartAdmissionV2 {
  const admission = codexStartAdmissionSchemaV2.parse(value);
  const { contractDigest, startAuthorizationDigest, admissionId, schema: _schema, startsWork: _startsWork,
    grantsExecutionAuthority: _grants, permitsResume: _resume, permitsRetry: _retry,
    permitsThreadRead: _read, ...identity } = admission;
  void _schema; void _startsWork; void _grants; void _resume; void _retry; void _read;
  const expectedId = `codex-admission-v2:${sha256Digest({
    schema: 'control-room.codex-start-admission-identity/v2', ...identity,
  }).slice(7)}`;
  const authorizationMaterial = { schema: 'control-room.codex-start-admission/v2' as const, admissionId, ...identity,
    startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  const unsigned = { ...authorizationMaterial, startAuthorizationDigest };
  const expectedDigest = sha256Digest({
    schema: 'control-room.codex-start-admission-contract-digest/v2', admission: unsigned,
  });
  if (admissionId !== expectedId
    || startAuthorizationDigest !== computeCodexStartAuthorizationDigestV2(authorizationMaterial)
    || contractDigest !== expectedDigest
    || admission.requestMessageId !== admission.activationMessageId
    || admission.deliveryDigest !== admission.dispatchFrameDigest
    || Date.parse(admission.deadline) <= Date.parse(admission.requestedAt)) {
    return fail('codex_v2_start_admission_unavailable');
  }
  return admission;
}

/** Matches a self-validating start admission to the exact activation and current admission. */
export function matchCodexStartAdmissionV2(admissionValue: unknown, expected: {
  activationFrame: CodexActivationFrameV2;
  currentAdmission: CodexCurrentAdmissionV2;
}): CodexStartAdmissionV2 {
  const admission = verifyCodexStartAdmissionV2(admissionValue);
  const activation = parseCodexTaskActivationV2(expected.activationFrame.body);
  const current = codexCurrentAdmissionSchemaV2.parse(expected.currentAdmission);
  const scope = admission.scope;
  if (!sameResourceBinding(admission, activation) || !sameResourceBinding(admission, current)
    || admission.queueId !== activation.queueId
    || admission.requestMessageId !== expected.activationFrame.messageId
    || admission.activationMessageId !== expected.activationFrame.messageId
    || admission.activationId !== activation.activationId || admission.activationDigest !== activation.activationDigest
    || admission.activationFrameDigest !== sha256Digest(expected.activationFrame)
    || admission.dispatchMessageId !== activation.dispatchMessageId
    || admission.dispatchFrameDigest !== activation.dispatchFrameDigest
    || admission.receiptMessageId !== activation.receiptMessageId
    || admission.receiptFrameDigest !== activation.receiptFrameDigest
    || admission.workspacePath !== activation.workspacePath
    || admission.deliveryDigest !== activation.dispatchFrameDigest
    || admission.enrollmentDigest !== activation.enrollmentDigest
    || admission.permitDigest !== activation.permitDigest
    || admission.currentAdmissionDigest !== codexCurrentAdmissionDigestV2(current)
    || admission.currentAdmissionDigest !== activation.currentAdmissionDigest
    || admission.inputDigest !== activation.inputDigest
    || scope.tenantId !== activation.tenantId || scope.nodeId !== activation.nodeId
    || scope.projectId !== activation.projectId || scope.jobId !== activation.jobId
    || scope.attemptId !== activation.attemptId || scope.runId !== activation.runId
    || scope.leaseId !== activation.leaseId || scope.leaseEpoch !== activation.leaseEpoch
    || scope.operationDigest !== activation.operationDigest
    || expected.activationFrame.sentAt !== activation.activatedAt
    || Date.parse(admission.requestedAt) < Date.parse(activation.activatedAt)
    || Date.parse(admission.deadline) > Date.parse(activation.activationExpiresAt)
    || Date.parse(admission.deadline) > Date.parse(expected.activationFrame.expiresAt)
    || Date.parse(admission.deadline) > Date.parse(current.leaseExpiresAt)
    || Date.parse(admission.deadline) > Date.parse(current.authorityExpiresAt)
    || Date.parse(admission.deadline) > Date.parse(current.approvalExpiresAt)
    || Date.parse(admission.deadline) > Date.parse(current.configurationExpiresAt)
    || Date.parse(admission.deadline) > Date.parse(current.admissionExpiresAt)) {
    return fail('codex_v2_start_admission_mismatch');
  }
  return admission;
}
