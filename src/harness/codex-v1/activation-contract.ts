import { z } from 'zod';
import { sha256Digest } from '../../security/canonical-digest';
import { digestSchema, localId } from '../v1/native-run-identifiers';
import { codexTaskDispatchBodySchemaV1, codexTaskDispatchReceiptBodySchemaV1,
  matchCodexTaskDispatchReceiptV1, type CodexTaskDispatchBodyV1,
  type CodexTaskDispatchReceiptBodyV1 } from './delivery-contract';

export const CODEX_ACTIVATION_FEATURE = 'harness.codex.activation.v1' as const;

const instant = z.string().datetime();
const activationMaterialSchemaV1 = z.object({
  schema: z.literal('control-room.codex-task-activation/v1'),
  tenantId: localId, projectId: localId, nodeId: localId, jobId: localId,
  attemptId: localId, runId: localId, leaseId: localId, leaseEpoch: z.number().int().positive(),
  queueId: localId, connectionId: localId,
  dispatchMessageId: localId, dispatchFrameDigest: digestSchema, dispatchBodyDigest: digestSchema,
  receiptMessageId: localId, receiptFrameDigest: digestSchema, receiptBodyDigest: digestSchema,
  permitDigest: digestSchema, inputDigest: digestSchema, operationDigest: digestSchema,
  effectClaimKey: digestSchema, enrollmentDigest: digestSchema, connectorProfileDigest: digestSchema,
  workspaceIntentDigest: digestSchema, currentAdmissionDigest: digestSchema,
  receiptRecordedAt: instant, receiptReceivedAt: instant, activatedAt: instant, activationExpiresAt: instant,
  startsWork: z.literal(false), authorizesExactStart: z.literal(true), grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false), permitsResume: z.literal(false), permitsThreadRead: z.literal(false),
}).strict();

export const codexTaskActivationBodySchemaV1 = activationMaterialSchemaV1.extend({
  activationId: localId,
  activationDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { activationId, activationDigest, ...material } = value;
  const expectedDigest = sha256Digest(material);
  if (activationDigest !== expectedDigest || activationId !== `codex-activation:${expectedDigest.slice(7)}`) {
    context.addIssue({ code: 'custom', message: 'codex activation digest mismatch' });
  }
  if (Date.parse(value.activationExpiresAt) <= Date.parse(value.activatedAt)
    || Date.parse(value.receiptReceivedAt) < Date.parse(value.receiptRecordedAt)
    || Date.parse(value.activatedAt) < Date.parse(value.receiptReceivedAt)
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 16_384) {
    context.addIssue({ code: 'custom', message: 'codex activation timing or size mismatch' });
  }
});
export type CodexTaskActivationBodyV1 = z.infer<typeof codexTaskActivationBodySchemaV1>;

/** Parses only self-contained activation evidence; matching its source frames remains mandatory. */
export function parseCodexTaskActivationV1(value: unknown): CodexTaskActivationBodyV1 {
  return codexTaskActivationBodySchemaV1.parse(value);
}

export type CodexDispatchFrameForActivationV1 = Readonly<{
  type: 'harness.codex.dispatch'; direction: 'node_to_server' | 'server_to_node'; senderKind: 'node' | 'control_room';
  messageId: string; tenantId: string; actorId: string; keyId: string; connectionId: string;
  sentAt: string; expiresAt: string; body: CodexTaskDispatchBodyV1;
}>;
export type CodexDispatchReceiptFrameForActivationV1 = Readonly<{
  type: 'harness.codex.dispatch.receipt'; direction: 'node_to_server' | 'server_to_node'; senderKind: 'node' | 'control_room';
  messageId: string; causationId?: string; tenantId: string; actorId: string; keyId: string;
  connectionId: string; sentAt: string; expiresAt: string; body: CodexTaskDispatchReceiptBodyV1;
}>;
export type CodexActivationFrameV1 = Readonly<{
  type: 'harness.codex.dispatch.activation'; direction: 'node_to_server' | 'server_to_node'; senderKind: 'node' | 'control_room';
  messageId: string; causationId?: string; tenantId: string; actorId: string; keyId: string;
  connectionId: string; sentAt: string; expiresAt: string; body: CodexTaskActivationBodyV1;
}>;

export function computeCodexTaskActivationDigestV1(value: unknown): string {
  return sha256Digest(activationMaterialSchemaV1.parse(value));
}

function fail(): never { throw new Error('codex_activation_mismatch'); }

function matchActivationSources(value: CodexTaskActivationBodyV1, expected: {
  dispatch: CodexDispatchFrameForActivationV1;
  receipt: CodexDispatchReceiptFrameForActivationV1;
  currentAdmissionDigest: string;
  receiptReceivedAt: string;
}) {
  const dispatch = expected.dispatch, receipt = expected.receipt;
  const body = codexTaskDispatchBodySchemaV1.parse(dispatch.body);
  const receiptBody = codexTaskDispatchReceiptBodySchemaV1.parse(receipt.body);
  const start = body.start;
  if (dispatch.type !== 'harness.codex.dispatch' || dispatch.direction !== 'server_to_node'
    || dispatch.senderKind !== 'control_room' || receipt.type !== 'harness.codex.dispatch.receipt'
    || receipt.direction !== 'node_to_server' || receipt.senderKind !== 'node'
    || dispatch.tenantId !== start.tenantId || receipt.causationId !== dispatch.messageId || receipt.tenantId !== dispatch.tenantId
    || receipt.actorId !== start.nodeId || receipt.connectionId !== dispatch.connectionId
    || Date.parse(expected.receiptReceivedAt) < Date.parse(receipt.sentAt)) return fail();
  try { matchCodexTaskDispatchReceiptV1(receiptBody, { messageId: dispatch.messageId, body }); } catch { return fail(); }
  if (value.tenantId !== start.tenantId || value.projectId !== start.projectId || value.nodeId !== start.nodeId
    || value.jobId !== start.jobId || value.attemptId !== start.attemptId || value.runId !== start.runId
    || value.leaseId !== start.leaseId || value.leaseEpoch !== start.leaseEpoch || value.queueId !== body.queueId
    || value.connectionId !== dispatch.connectionId || value.dispatchMessageId !== dispatch.messageId
    || value.dispatchFrameDigest !== sha256Digest(dispatch) || value.dispatchBodyDigest !== sha256Digest(body)
    || value.receiptMessageId !== receipt.messageId || value.receiptFrameDigest !== sha256Digest(receipt)
    || value.receiptBodyDigest !== sha256Digest(receiptBody) || value.permitDigest !== body.permitDigest
    || value.inputDigest !== start.inputDigest || value.operationDigest !== start.operationDigest
    || value.effectClaimKey !== start.effectClaimKey || value.enrollmentDigest !== start.enrollmentDigest
    || value.connectorProfileDigest !== start.connectorProfileDigest
    || value.workspaceIntentDigest !== start.workspaceIntentDigest
    || value.currentAdmissionDigest !== digestSchema.parse(expected.currentAdmissionDigest)
    || value.receiptRecordedAt !== receiptBody.recordedAt || value.receiptReceivedAt !== expected.receiptReceivedAt) return fail();
  return { dispatch, receipt, body, receiptBody };
}

/** Builds bounded, effect-free evidence after the dispatch receipt was authenticated. */
export function buildCodexTaskActivationV1(input: {
  dispatch: CodexDispatchFrameForActivationV1;
  receipt: CodexDispatchReceiptFrameForActivationV1;
  currentAdmissionDigest: string;
  receiptReceivedAt: string;
  activatedAt: string;
  activationExpiresAt: string;
}): CodexTaskActivationBodyV1 {
  const dispatch = input.dispatch, receipt = input.receipt;
  const start = codexTaskDispatchBodySchemaV1.parse(dispatch.body).start;
  const material = activationMaterialSchemaV1.parse({
    schema: 'control-room.codex-task-activation/v1',
    tenantId: start.tenantId, projectId: start.projectId, nodeId: start.nodeId, jobId: start.jobId,
    attemptId: start.attemptId, runId: start.runId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch,
    queueId: dispatch.body.queueId, connectionId: dispatch.connectionId,
    dispatchMessageId: dispatch.messageId, dispatchFrameDigest: sha256Digest(dispatch), dispatchBodyDigest: sha256Digest(dispatch.body),
    receiptMessageId: receipt.messageId, receiptFrameDigest: sha256Digest(receipt), receiptBodyDigest: sha256Digest(receipt.body),
    permitDigest: dispatch.body.permitDigest, inputDigest: start.inputDigest, operationDigest: start.operationDigest,
    effectClaimKey: start.effectClaimKey, enrollmentDigest: start.enrollmentDigest,
    connectorProfileDigest: start.connectorProfileDigest, workspaceIntentDigest: start.workspaceIntentDigest,
    currentAdmissionDigest: input.currentAdmissionDigest, receiptRecordedAt: receipt.body.recordedAt,
    receiptReceivedAt: input.receiptReceivedAt, activatedAt: input.activatedAt,
    activationExpiresAt: input.activationExpiresAt, startsWork: false, authorizesExactStart: true,
    grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false, permitsThreadRead: false,
  });
  const activationDigest = computeCodexTaskActivationDigestV1(material);
  const activation = codexTaskActivationBodySchemaV1.parse({ ...material,
    activationId: `codex-activation:${activationDigest.slice(7)}`, activationDigest });
  matchActivationSources(activation, input);
  return Object.freeze(activation);
}

/** Matches the exact authenticated dispatch and receipt; it grants no execution capability. */
export function matchCodexTaskActivationV1(activationFrame: CodexActivationFrameV1, expected: {
  dispatch: CodexDispatchFrameForActivationV1;
  receipt: CodexDispatchReceiptFrameForActivationV1;
  currentAdmissionDigest: string;
  receiptReceivedAt: string;
}) {
  const activation = parseCodexTaskActivationV1(activationFrame.body);
  const matched = matchActivationSources(activation, expected);
  if (activationFrame.type !== 'harness.codex.dispatch.activation' || activationFrame.direction !== 'server_to_node'
    || activationFrame.senderKind !== 'control_room' || activationFrame.tenantId !== activation.tenantId
    || activationFrame.connectionId !== activation.connectionId || activationFrame.causationId !== activation.receiptMessageId
    || activationFrame.actorId !== matched.dispatch.actorId || activationFrame.keyId !== matched.dispatch.keyId
    || activationFrame.connectionId !== matched.dispatch.connectionId || activationFrame.sentAt !== activation.activatedAt
    || Date.parse(activationFrame.expiresAt) > Date.parse(activation.activationExpiresAt)
    || Date.parse(activationFrame.expiresAt) > matched.body.start.deadline) return fail();
  return activation;
}
