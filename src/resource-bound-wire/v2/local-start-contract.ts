import { z } from 'zod';
import { sha256Digest } from '../../security/canonical-digest';
import { digestSchema, localId } from '../../harness/v1/native-run-identifiers';
import { resourceAdmissionBindingSchemaV2, type ResourceAdmissionBindingV2 } from './common';
import {
  codexCurrentAdmissionDigestV2,
  codexCurrentAdmissionSchemaV2,
  codexStartAdmissionSchemaV2,
  codexTaskActivationBodySchemaV2,
  matchCodexStartAdmissionV2,
  parseCodexTaskActivationV2,
  verifyCodexStartAdmissionV2,
  type CodexActivationFrameV2,
  type CodexCurrentAdmissionV2,
  type CodexStartAdmissionV2,
  type CodexTaskActivationBodyV2,
} from './codex-contract';

export const CODEX_LOCAL_START_BINDING_SCHEMA_V2 = 'control-room.codex-local-start-binding/v2' as const;

const instant = z.string().datetime();
const rpcId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const resourceShape = resourceAdmissionBindingSchemaV2.shape;
const falseAuthority = {
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false), permitsResume: z.literal(false), permitsThreadRead: z.literal(false),
};
const fail = (): never => { throw new Error('codex_v2_local_start_binding_unavailable'); };

function sameAdmission(left: ResourceAdmissionBindingV2, right: ResourceAdmissionBindingV2): boolean {
  return left.resourceAdmissionId === right.resourceAdmissionId
    && left.resourceAdmissionDigest === right.resourceAdmissionDigest;
}

const localStartMaterialSchemaV2 = z.object({
  schema: z.literal(CODEX_LOCAL_START_BINDING_SCHEMA_V2),
  bindingId: localId,
  ...resourceShape,
  queueId: localId,
  activation: codexTaskActivationBodySchemaV2,
  currentAdmission: codexCurrentAdmissionSchemaV2,
  startAdmission: codexStartAdmissionSchemaV2,
  activationFrameDigest: digestSchema,
  activationMessageId: localId,
  activationId: localId,
  activationDigest: digestSchema,
  dispatchMessageId: localId,
  dispatchFrameDigest: digestSchema,
  dispatchBodyDigest: digestSchema,
  receiptMessageId: localId,
  receiptFrameDigest: digestSchema,
  receiptBodyDigest: digestSchema,
  currentAdmissionDigest: digestSchema,
  connectionAttemptId: localId,
  initializedConnectionDigest: digestSchema,
  startAuthorizationDigest: digestSchema,
  threadStartRequestId: rpcId,
  turnStartRequestId: rpcId,
  requestedAt: instant,
  deadline: instant,
  ...falseAuthority,
}).strict();

export const codexLocalStartBindingSchemaV2 = localStartMaterialSchemaV2.extend({
  bindingDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { bindingDigest, ...material } = value;
  const activation = value.activation;
  const admission = value.startAdmission;
  const current = value.currentAdmission;
  const expectedId = `codex-local-start:${sha256Digest({
    schema: 'control-room.codex-local-start-binding-identity/v2',
    resourceAdmissionId: value.resourceAdmissionId,
    resourceAdmissionDigest: value.resourceAdmissionDigest,
    queueId: value.queueId,
    activationId: value.activationId,
    startAdmissionId: admission.admissionId,
    connectionAttemptId: value.connectionAttemptId,
    threadStartRequestId: value.threadStartRequestId,
    turnStartRequestId: value.turnStartRequestId,
  }).slice(7)}`;
  const pairMatches = sameAdmission(value, activation)
    && sameAdmission(value, admission)
    && sameAdmission(value, current);
  let admissionValid = true;
  try { verifyCodexStartAdmissionV2(admission); } catch { admissionValid = false; }
  if (!admissionValid || !pairMatches
    || value.bindingId !== expectedId
    || bindingDigest !== sha256Digest({
      schema: 'control-room.codex-local-start-binding-digest/v2', material,
    })
    || value.queueId !== activation.queueId || value.queueId !== admission.queueId
    || value.activationMessageId !== admission.activationMessageId
    || value.activationId !== activation.activationId || value.activationId !== admission.activationId
    || value.activationDigest !== activation.activationDigest
    || value.activationDigest !== admission.activationDigest
    || value.activationFrameDigest !== admission.activationFrameDigest
    || value.dispatchMessageId !== activation.dispatchMessageId
    || value.dispatchMessageId !== admission.dispatchMessageId
    || value.dispatchFrameDigest !== activation.dispatchFrameDigest
    || value.dispatchFrameDigest !== admission.dispatchFrameDigest
    || value.dispatchBodyDigest !== activation.dispatchBodyDigest
    || value.receiptMessageId !== activation.receiptMessageId
    || value.receiptMessageId !== admission.receiptMessageId
    || value.receiptFrameDigest !== activation.receiptFrameDigest
    || value.receiptFrameDigest !== admission.receiptFrameDigest
    || value.receiptBodyDigest !== activation.receiptBodyDigest
    || value.currentAdmissionDigest !== activation.currentAdmissionDigest
    || value.currentAdmissionDigest !== admission.currentAdmissionDigest
    || value.currentAdmissionDigest !== codexCurrentAdmissionDigestV2(current)
    || value.connectionAttemptId !== admission.connectionAttemptId
    || value.initializedConnectionDigest !== admission.initializedConnectionDigest
    || value.startAuthorizationDigest !== admission.startAuthorizationDigest
    || value.threadStartRequestId !== admission.threadStartRequestId
    || value.requestedAt !== admission.requestedAt || value.deadline !== admission.deadline
    || value.threadStartRequestId === value.turnStartRequestId
    || Date.parse(value.deadline) <= Date.parse(value.requestedAt)) {
    context.addIssue({ code: 'custom', message: 'codex v2 local-start binding mismatch' });
  }
});
export type CodexLocalStartBindingV2 = z.infer<typeof codexLocalStartBindingSchemaV2>;

type LocalStartSourcesV2 = {
  activationFrame: CodexActivationFrameV2;
  currentAdmission: CodexCurrentAdmissionV2;
  startAdmission: CodexStartAdmissionV2;
  connectionAttemptId: string;
  initializedConnectionDigest: string;
  threadStartRequestId: number;
  turnStartRequestId: number;
  requestedAt: string;
  deadline: string;
};

/** Builds inert local-start evidence. It performs no reservation, workspace, process or transport effect. */
export function createCodexLocalStartBindingV2(input: LocalStartSourcesV2): Readonly<CodexLocalStartBindingV2> {
  const activation = parseCodexTaskActivationV2(input.activationFrame.body);
  const currentAdmission = codexCurrentAdmissionSchemaV2.parse(input.currentAdmission);
  const startAdmission = matchCodexStartAdmissionV2(input.startAdmission, {
    activationFrame: input.activationFrame, currentAdmission,
  });
  const pair = resourceAdmissionBindingSchemaV2.parse({
    resourceAdmissionId: activation.resourceAdmissionId,
    resourceAdmissionDigest: activation.resourceAdmissionDigest,
  });
  const bindingId = `codex-local-start:${sha256Digest({
    schema: 'control-room.codex-local-start-binding-identity/v2',
    ...pair, queueId: activation.queueId, activationId: activation.activationId,
    startAdmissionId: startAdmission.admissionId, connectionAttemptId: input.connectionAttemptId,
    threadStartRequestId: input.threadStartRequestId, turnStartRequestId: input.turnStartRequestId,
  }).slice(7)}`;
  const material = localStartMaterialSchemaV2.parse({
    schema: CODEX_LOCAL_START_BINDING_SCHEMA_V2,
    bindingId, ...pair, queueId: activation.queueId,
    activation, currentAdmission, startAdmission,
    activationFrameDigest: sha256Digest(input.activationFrame), activationMessageId: input.activationFrame.messageId,
    activationId: activation.activationId, activationDigest: activation.activationDigest,
    dispatchMessageId: activation.dispatchMessageId, dispatchFrameDigest: activation.dispatchFrameDigest,
    dispatchBodyDigest: activation.dispatchBodyDigest, receiptMessageId: activation.receiptMessageId,
    receiptFrameDigest: activation.receiptFrameDigest, receiptBodyDigest: activation.receiptBodyDigest,
    currentAdmissionDigest: activation.currentAdmissionDigest,
    connectionAttemptId: input.connectionAttemptId,
    initializedConnectionDigest: input.initializedConnectionDigest,
    startAuthorizationDigest: startAdmission.startAuthorizationDigest,
    threadStartRequestId: input.threadStartRequestId, turnStartRequestId: input.turnStartRequestId,
    requestedAt: input.requestedAt, deadline: input.deadline,
    startsWork: false, grantsExecutionAuthority: false,
    permitsRetry: false, permitsResume: false, permitsThreadRead: false,
  });
  return Object.freeze(codexLocalStartBindingSchemaV2.parse({
    ...material,
    bindingDigest: sha256Digest({ schema: 'control-room.codex-local-start-binding-digest/v2', material }),
  }));
}

/** Validates lineage only against the exact authenticated source activation frame. */
export function verifyCodexLocalStartBindingV2(value: unknown,
  activationFrame: CodexActivationFrameV2): Readonly<CodexLocalStartBindingV2> {
  const binding = codexLocalStartBindingSchemaV2.parse(value);
  verifyCodexStartAdmissionV2(binding.startAdmission);
  if (binding.activationFrameDigest !== sha256Digest(activationFrame)
    || binding.activationMessageId !== activationFrame.messageId
    || sha256Digest(binding.activation) !== sha256Digest(activationFrame.body)) fail();
  matchCodexStartAdmissionV2(binding.startAdmission, {
    activationFrame, currentAdmission: binding.currentAdmission,
  });
  return Object.freeze(binding);
}

export type CodexLocalStartActivationV2 = CodexTaskActivationBodyV2;
