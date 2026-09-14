import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { enrollmentSchema, HERMES_NATIVE_ADAPTER } from "../../harness/v1/native-run-contracts";
import { nativeRecoveryPermissionSchema } from "../../harness/v1/native-approval-packet";
import { leaseGrantSchema } from "../../node-protocol/v1";
import { normalizedLocalPolicyRequestSchema, ownerApprovalAttestationSchema } from "../../node-policy/v1/schemas";
import { RESOURCE_BOUND_WIRE_V2_NAMESPACE, resourceAdmissionBindingSchemaV2, resourceBoundWireV2Digest, resourceBoundWireV2DigestSchema, resourceBoundWireV2IdSchema, type ResourceAdmissionBindingV2 } from "./common";

export const NATIVE_RESOURCE_QUEUE_SCHEMA_V2 = "control-room.resource-bound-native-queue/v2" as const;
export const NATIVE_RESOURCE_SUBMISSION_SCHEMA_V2 = "control-room.resource-bound-native-submission/v2" as const;
export const NATIVE_RESOURCE_LEASE_SCHEMA_V2 = "control-room.resource-bound-native-lease/v2" as const;
export const NATIVE_RESOURCE_START_SCHEMA_V2 = "control-room.resource-bound-native-start/v2" as const;
export const NATIVE_RESOURCE_BINDING_SCHEMA_V2 = "control-room.resource-bound-native-binding/v2" as const;
export const NATIVE_RESOURCE_DISPATCH_SCHEMA_V2 = "control-room.resource-bound-native-dispatch/v2" as const;
export const NATIVE_RESOURCE_RECEIPT_SCHEMA_V2 = "control-room.resource-bound-native-receipt/v2" as const;
export const NATIVE_RESOURCE_DISPATCH_FEATURE_V2 = "harness.native.dispatch.v2" as const;
export const NATIVE_RESOURCE_LEASE_FEATURE_V2 = "harness.native.lease.v2" as const;
const denied = { startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false), permitsResume: z.literal(false), permitsRetry: z.literal(false), permitsThreadRead: z.literal(false) };
const admission = { resourceAdmissionId: resourceAdmissionBindingSchemaV2.shape.resourceAdmissionId, resourceAdmissionDigest: resourceAdmissionBindingSchemaV2.shape.resourceAdmissionDigest };
const scope = { tenantId: resourceBoundWireV2IdSchema, projectId: resourceBoundWireV2IdSchema, nodeId: resourceBoundWireV2IdSchema, jobId: resourceBoundWireV2IdSchema, attemptId: resourceBoundWireV2IdSchema };
const d = (kind: string, value: unknown) => resourceBoundWireV2Digest(`${RESOURCE_BOUND_WIRE_V2_NAMESPACE}/native-${kind}/v2`, value);
const pair = (v: ResourceAdmissionBindingV2) => ({ resourceAdmissionId: v.resourceAdmissionId, resourceAdmissionDigest: v.resourceAdmissionDigest });
const samePair = (a: ResourceAdmissionBindingV2, b: ResourceAdmissionBindingV2) => a.resourceAdmissionId === b.resourceAdmissionId && a.resourceAdmissionDigest === b.resourceAdmissionDigest;
type Scope = { tenantId: string; projectId: string; nodeId: string; jobId: string; attemptId: string };
const sameScope = (a: Scope, b: Scope) => a.tenantId === b.tenantId && a.projectId === b.projectId && a.nodeId === b.nodeId && a.jobId === b.jobId && a.attemptId === b.attemptId;
function without<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> { const copy = { ...value }; delete copy[key]; return copy; }
/** Keep the resource pair as an explicit first-level payload component, ahead of the legacy operation/effect leaves. */
function payload<T extends ResourceAdmissionBindingV2>(kind: string, value: T, omit: string): string { const boundary = { ...(value as object) } as Record<string, unknown>; delete boundary[omit]; return d(`${kind}-payload`, { resourceAdmission: pair(value), boundary }); }
const bad = (): never => { throw new Error("resource_bound_native_v2_invalid"); };

/** V2 replacement for the policy request. Its operation digest cannot be a v1 operation digest. */
export const nativeResourceRequestSchemaV2 = z.object({
  schema: z.literal("control-room.resource-bound-native-request/v2"), contractVersion: z.literal("control-room.resource-bound-native-request/v2"), requestId: resourceBoundWireV2IdSchema,
  ...scope, ...admission, nodeClass: resourceBoundWireV2IdSchema, leaseId: resourceBoundWireV2IdSchema,
  leaseEpoch: z.number().int().positive(), executorId: resourceBoundWireV2IdSchema,
  operationId: z.literal("harness.hermes.native.start"), operationDigest: resourceBoundWireV2DigestSchema,
  authorityDigest: resourceBoundWireV2DigestSchema, credentialRefs: z.array(resourceBoundWireV2IdSchema).length(1),
  target: normalizedLocalPolicyRequestSchema.shape.target, risk: z.literal("low"), externalEffect: z.literal(true),
  estimatedDurationSeconds: z.number().int().min(1).max(300), estimatedCostUsd: z.null(), approval: z.null(), occurredAt: z.string().datetime(), payloadDigest: resourceBoundWireV2DigestSchema,
}).strict().superRefine((v, c) => {
  const operation = d("operation", { resourceAdmission: pair(v), tenantId: v.tenantId, nodeId: v.nodeId, projectId: v.projectId,
    jobId: v.jobId, attemptId: v.attemptId, executorId: v.executorId, operationId: v.operationId, credentialRefs: v.credentialRefs,
    target: v.target, risk: v.risk, externalEffect: v.externalEffect, estimatedDurationSeconds: v.estimatedDurationSeconds, estimatedCostUsd: v.estimatedCostUsd, approval: v.approval, payloadDigest: v.payloadDigest });
  const requestId = `request:native-task:${d("request-id", { resourceAdmission: pair(v), tenantId: v.tenantId, nodeId: v.nodeId, projectId: v.projectId, jobId: v.jobId, attemptId: v.attemptId, leaseId: v.leaseId, leaseEpoch: v.leaseEpoch }).slice(7)}`;
  if (v.requestId !== requestId || v.operationDigest !== operation) c.addIssue({ code: "custom", message: "resource-bound v2 request identity or operation digest mismatch" });
});
export type NativeResourceRequestV2 = z.infer<typeof nativeResourceRequestSchemaV2>;
/** The exact v2 effect-payload commitment consumed by the operation digest. */
export function computeNativeResourcePayloadDigestV2(enrollmentValue: unknown, requestValue: NativeResourceRequestV2, startValue: NativeResourceStartLeafV2): string {
  const enrollment = enrollmentSchema.parse(enrollmentValue);
  return sha256Digest({ schema: "control-room.native-task-effect-payload/v2", resourceAdmissionId: requestValue.resourceAdmissionId, resourceAdmissionDigest: requestValue.resourceAdmissionDigest, enrollmentDigest: sha256Digest(enrollment), inputDigest: sha256Digest({ prompt: startValue.prompt, instructions: startValue.instructions }), leaseId: requestValue.leaseId, leaseEpoch: requestValue.leaseEpoch, authorityDigest: requestValue.authorityDigest, deadline: startValue.deadline });
}

export function nativeResourceEffectClaimKeyV2(value: Pick<NativeResourceRequestV2, "tenantId" | "nodeId" | "projectId" | "jobId" | "attemptId" | "operationDigest"> & ResourceAdmissionBindingV2): string {
  return d("effect-claim", { resourceAdmission: pair(value), tenantId: value.tenantId, nodeId: value.nodeId, projectId: value.projectId, jobId: value.jobId, attemptId: value.attemptId, operationDigest: value.operationDigest });
}
export const nativeResourceStartLeafSchemaV2 = z.object({ ...scope, ...admission, runId: resourceBoundWireV2IdSchema,
  effectClaimKey: resourceBoundWireV2DigestSchema, operationDigest: resourceBoundWireV2DigestSchema,
  prompt: z.string().min(1).max(4_000), instructions: z.string().max(8_192), deadline: z.number().int().nonnegative(),
}).strict().superRefine((v, c) => {
  if (v.effectClaimKey !== nativeResourceEffectClaimKeyV2(v) || v.runId !== `run:native-task:${v.effectClaimKey.slice(7)}`) c.addIssue({ code: "custom", message: "resource-bound v2 effect identity mismatch" });
});
export type NativeResourceStartLeafV2 = z.infer<typeof nativeResourceStartLeafSchemaV2>;

export const nativeResourceBindingLeafSchemaV2 = z.object({ adapter: z.literal(HERMES_NATIVE_ADAPTER), ...scope, ...admission,
  runId: resourceBoundWireV2IdSchema, effectClaimKey: resourceBoundWireV2DigestSchema, operationDigest: resourceBoundWireV2DigestSchema,
  enrollmentDigest: resourceBoundWireV2DigestSchema, requestDigest: resourceBoundWireV2DigestSchema, sessionId: z.string().regex(/^crv2_[a-f0-9]{64}$/), deadline: z.number().int().nonnegative(),
}).strict();
export type NativeResourceBindingLeafV2 = z.infer<typeof nativeResourceBindingLeafSchemaV2>;
export function createNativeResourceBindingLeafV2(enrollmentValue: unknown, requestValue: unknown, startValue: unknown): Readonly<NativeResourceBindingLeafV2> {
  const enrollment = enrollmentSchema.parse(enrollmentValue), request = nativeResourceRequestSchemaV2.parse(requestValue), start = nativeResourceStartLeafSchemaV2.parse(startValue);
  if (!samePair(request, start) || !sameScope(request, start) || request.tenantId !== enrollment.tenantId || request.nodeId !== enrollment.nodeId || request.operationDigest !== start.operationDigest || request.credentialRefs[0] !== enrollment.credentialRef || request.target.kind !== "network" || request.target.canonicalDestination !== enrollment.canonicalDestination || start.deadline > enrollment.validUntil) bad();
  const requestDigest = d("native-request", { resourceAdmission: pair(request), request });
  const sessionId = `crv2_${d("session", { resourceAdmission: pair(request), tenantId: request.tenantId, projectId: request.projectId, attemptId: request.attemptId, effectClaimKey: start.effectClaimKey }).slice(7)}`;
  return Object.freeze(nativeResourceBindingLeafSchemaV2.parse({ adapter: HERMES_NATIVE_ADAPTER, ...scopeOf(request), ...pair(request), runId: start.runId, effectClaimKey: start.effectClaimKey, operationDigest: request.operationDigest, enrollmentDigest: sha256Digest(enrollment), requestDigest, sessionId, deadline: start.deadline }));
}
export const nativeResourceApprovalPacketSchemaV2 = z.object({ schema: z.literal("control-room.resource-bound-native-approval-packet/v2"), ...admission, approval: ownerApprovalAttestationSchema, recovery: nativeRecoveryPermissionSchema }).strict();
export type NativeResourceApprovalPacketV2 = z.infer<typeof nativeResourceApprovalPacketSchemaV2>;
function scopeOf(v: Scope): Scope { return { tenantId: v.tenantId, projectId: v.projectId, nodeId: v.nodeId, jobId: v.jobId, attemptId: v.attemptId }; }
function verifyPacket(v: NativeResourceApprovalPacketV2, request: NativeResourceRequestV2, binding: NativeResourceBindingLeafV2): boolean {
  const a = v.approval.body;
  return samePair(v, request) && a.tenantId === request.tenantId && a.nodeId === request.nodeId && a.projectId === request.projectId && a.jobId === request.jobId && a.attemptId === request.attemptId && a.operationDigest === request.operationDigest && a.risk === request.risk && v.recovery.body.bindingDigest === d("binding", { resourceAdmission: pair(request), binding });
}
export const nativeResourceDispatchBodySchemaV2 = z.object({ schema: z.literal("control-room.resource-bound-native-dispatch-body/v2"), queueId: resourceBoundWireV2IdSchema, ...scope, ...admission, inputDigest: resourceBoundWireV2DigestSchema, enrollmentDigest: resourceBoundWireV2DigestSchema, bindingDigest: resourceBoundWireV2DigestSchema, packetDigest: resourceBoundWireV2DigestSchema, request: nativeResourceRequestSchemaV2, start: nativeResourceStartLeafSchemaV2, binding: nativeResourceBindingLeafSchemaV2, packet: nativeResourceApprovalPacketSchemaV2 }).strict();
export type NativeResourceDispatchBodyV2 = z.infer<typeof nativeResourceDispatchBodySchemaV2>;
export const nativeResourceDispatchReceiptBodySchemaV2 = z.object({ schema: z.literal("control-room.resource-bound-native-dispatch-receipt/v2"), queueId: resourceBoundWireV2IdSchema, dispatchMessageId: resourceBoundWireV2IdSchema, dispatchBodyDigest: resourceBoundWireV2DigestSchema, ...scope, ...admission, packetDigest: resourceBoundWireV2DigestSchema, bindingDigest: resourceBoundWireV2DigestSchema, recordedAt: z.string().datetime(), disposition: z.enum(["recorded", "rejected"]), safeReason: z.enum(["none", "expired", "binding_mismatch", "authority_unavailable", "storage_uncertain"]), ...denied }).strict().superRefine((v,c) => { if ((v.disposition === "recorded") !== (v.safeReason === "none")) c.addIssue({ code: "custom", message: "receipt disposition mismatch" }); });

/** Inert v2 record of the existing queue intent. Admission enters the payload preimage before operation/effect values. */
export const nativeResourceQueueSchemaV2 = z.object({ schema: z.literal(NATIVE_RESOURCE_QUEUE_SCHEMA_V2), queueId: resourceBoundWireV2IdSchema, ...scope, ...admission, leaseId: resourceBoundWireV2IdSchema, leaseEpoch: z.number().int().positive(), inputDigest: resourceBoundWireV2DigestSchema, packetDigest: resourceBoundWireV2DigestSchema, operationDigest: resourceBoundWireV2DigestSchema, bindingDigest: resourceBoundWireV2DigestSchema, enrollmentDigest: resourceBoundWireV2DigestSchema, deadline: z.number().int().nonnegative(), queuedAt: z.string().datetime(), queuedBy: resourceBoundWireV2IdSchema, payloadDigest: resourceBoundWireV2DigestSchema, ...denied }).strict().superRefine((v, c) => {
  const expectedId = `native-queue:${d("queue-id", { tenantId: v.tenantId, jobId: v.jobId, attemptId: v.attemptId, resourceAdmission: pair(v) }).slice(7)}`;
  if (v.queueId !== expectedId || v.payloadDigest !== payload("queue", v, "payloadDigest")) c.addIssue({ code: "custom", message: "resource-bound native queue v2 mismatch" });
});
export type NativeResourceQueueV2 = z.infer<typeof nativeResourceQueueSchemaV2>;

/** Actual v1 request/start/enrollment/approval leaves live inside a separately-versioned v2 envelope. */
export const nativeResourceSubmissionSchemaV2 = z.object({ schema: z.literal(NATIVE_RESOURCE_SUBMISSION_SCHEMA_V2), submissionId: resourceBoundWireV2IdSchema, queue: nativeResourceQueueSchemaV2, queueDigest: resourceBoundWireV2DigestSchema, ...scope, ...admission, enrollment: enrollmentSchema, request: nativeResourceRequestSchemaV2, start: nativeResourceStartLeafSchemaV2, packet: nativeResourceApprovalPacketSchemaV2, payloadDigest: resourceBoundWireV2DigestSchema, ...denied }).strict().superRefine((v, c) => {
  let binding: NativeResourceBindingLeafV2; try { binding = createNativeResourceBindingLeafV2(v.enrollment, v.request, v.start); } catch { c.addIssue({ code: "custom", message: "native v2 leaves do not bind" }); return; }
  const input = sha256Digest({ prompt: v.start.prompt, instructions: v.start.instructions });
  if (v.request.payloadDigest !== computeNativeResourcePayloadDigestV2(v.enrollment, v.request, v.start) || v.queueDigest !== v.queue.payloadDigest || !samePair(v, v.queue) || !sameScope(v, v.queue) || !sameScope(v, v.request) || !sameScope(v, v.start) || !verifyPacket(v.packet, v.request, binding) || v.queue.leaseId !== v.request.leaseId || v.queue.leaseEpoch !== v.request.leaseEpoch || v.queue.inputDigest !== input || v.queue.bindingDigest !== d("binding", { resourceAdmission: pair(v), binding }) || v.queue.packetDigest !== sha256Digest(v.packet) || v.queue.operationDigest !== v.request.operationDigest || v.queue.enrollmentDigest !== sha256Digest(v.enrollment) || v.submissionId !== `native-submission:${d("submission-id", { queueDigest: v.queueDigest, resourceAdmission: pair(v) }).slice(7)}` || v.payloadDigest !== payload("submission", v, "payloadDigest")) c.addIssue({ code: "custom", message: "resource-bound native submission v2 mismatch" });
});
export type NativeResourceSubmissionV2 = z.infer<typeof nativeResourceSubmissionSchemaV2>;

export const nativeResourceLeaseSchemaV2 = z.object({ schema: z.literal(NATIVE_RESOURCE_LEASE_SCHEMA_V2), submission: nativeResourceSubmissionSchemaV2, submissionDigest: resourceBoundWireV2DigestSchema, ...scope, ...admission, leaseGrant: leaseGrantSchema, leaseFeature: z.literal(NATIVE_RESOURCE_LEASE_FEATURE_V2), payloadDigest: resourceBoundWireV2DigestSchema, ...denied }).strict().superRefine((v, c) => {
  const r = v.submission.request, g = v.leaseGrant;
  if (v.submissionDigest !== v.submission.payloadDigest || !samePair(v, v.submission) || !sameScope(v, v.submission) || g.nodeId !== r.nodeId || g.jobId !== r.jobId || g.attemptId !== r.attemptId || g.leaseId !== r.leaseId || g.leaseEpoch !== r.leaseEpoch || g.authorityDigest !== r.authorityDigest || v.payloadDigest !== payload("lease", v, "payloadDigest")) c.addIssue({ code: "custom", message: "resource-bound native lease v2 mismatch" });
});
export type NativeResourceLeaseV2 = z.infer<typeof nativeResourceLeaseSchemaV2>;

export const nativeResourceStartSchemaV2 = z.object({ schema: z.literal(NATIVE_RESOURCE_START_SCHEMA_V2), lease: nativeResourceLeaseSchemaV2, leaseDigest: resourceBoundWireV2DigestSchema, ...scope, ...admission, start: nativeResourceStartLeafSchemaV2, payloadDigest: resourceBoundWireV2DigestSchema, ...denied }).strict().superRefine((v, c) => {
  const r = v.lease.submission.request;
  if (v.leaseDigest !== v.lease.payloadDigest || !samePair(v, v.lease) || !sameScope(v, v.lease) || !sameScope(v, v.start) || v.start.runId !== `run:native-task:${v.start.effectClaimKey.slice(7)}` || v.start.operationDigest !== r.operationDigest || v.payloadDigest !== payload("start", v, "payloadDigest")) c.addIssue({ code: "custom", message: "resource-bound native start v2 mismatch" });
});
export type NativeResourceStartV2 = z.infer<typeof nativeResourceStartSchemaV2>;

export const nativeResourceBindingSchemaV2 = z.object({ schema: z.literal(NATIVE_RESOURCE_BINDING_SCHEMA_V2), start: nativeResourceStartSchemaV2, startDigest: resourceBoundWireV2DigestSchema, ...scope, ...admission, binding: nativeResourceBindingLeafSchemaV2, payloadDigest: resourceBoundWireV2DigestSchema, ...denied }).strict().superRefine((v, c) => {
  const s = v.start, r = s.lease.submission.request, b = v.binding;
  let expected: NativeResourceBindingLeafV2 | undefined; try { expected = createNativeResourceBindingLeafV2(s.lease.submission.enrollment, r, s.start); } catch { /* reported below */ }
  if (!expected || v.startDigest !== s.payloadDigest || !samePair(v, s) || !sameScope(v, s) || sha256Digest(b) !== sha256Digest(expected) || v.payloadDigest !== payload("binding", v, "payloadDigest")) c.addIssue({ code: "custom", message: "resource-bound native binding v2 mismatch" });
});
export type NativeResourceBindingV2 = z.infer<typeof nativeResourceBindingSchemaV2>;

export function computeNativeStartAuthorizationDigestV2(value: { resourceAdmissionId: string; resourceAdmissionDigest: string; tenantId: string; projectId: string; nodeId: string; jobId: string; attemptId: string; leaseId: string; leaseEpoch: number; runId: string; operationDigest: string; effectClaimKey: string; dispatchMessageId: string; dispatchFrameDigest: string }): string {
  return d("start-authorization", { resourceAdmission: pair(value), tenantId: value.tenantId, projectId: value.projectId, nodeId: value.nodeId, jobId: value.jobId, attemptId: value.attemptId, leaseId: value.leaseId, leaseEpoch: value.leaseEpoch, runId: value.runId, operationDigest: value.operationDigest, effectClaimKey: value.effectClaimKey, dispatchMessageId: value.dispatchMessageId, dispatchFrameDigest: value.dispatchFrameDigest });
}
/** Authenticated outer delivery evidence required before a dispatch authorization can be used. */
export type AuthenticatedNativeResourceDispatchFrameV2 = Readonly<{
  type: "harness.native.dispatch"; direction: "node_to_server" | "server_to_node"; senderKind: "node" | "control_room";
  messageId: string; tenantId: string; actorId: string; keyId: string; connectionId: string;
  sentAt: string; expiresAt: string; body: NativeResourceDispatchBodyV2;
}>;
export const nativeResourceDispatchSchemaV2 = z.object({ schema: z.literal(NATIVE_RESOURCE_DISPATCH_SCHEMA_V2), binding: nativeResourceBindingSchemaV2, bindingDigest: resourceBoundWireV2DigestSchema, ...scope, ...admission, dispatch: nativeResourceDispatchBodySchemaV2, dispatchFeature: z.literal(NATIVE_RESOURCE_DISPATCH_FEATURE_V2), dispatchMessageId: resourceBoundWireV2IdSchema, dispatchFrameDigest: resourceBoundWireV2DigestSchema, startAuthorizationDigest: resourceBoundWireV2DigestSchema, payloadDigest: resourceBoundWireV2DigestSchema, ...denied }).strict().superRefine((v, c) => {
  const b = v.binding, s = b.start, sub = s.lease.submission, x = v.dispatch;
  const auth = computeNativeStartAuthorizationDigestV2({ ...pair(v), ...v, leaseId: sub.request.leaseId, leaseEpoch: sub.request.leaseEpoch, runId: s.start.runId, operationDigest: sub.request.operationDigest, effectClaimKey: s.start.effectClaimKey, dispatchMessageId: v.dispatchMessageId, dispatchFrameDigest: v.dispatchFrameDigest });
  if (v.bindingDigest !== b.payloadDigest || !samePair(v, b) || !sameScope(v, b) || v.startAuthorizationDigest !== auth || !samePair(x, v) || !sameScope(x, v) || x.enrollmentDigest !== sha256Digest(sub.enrollment) || x.bindingDigest !== d("binding", { resourceAdmission: pair(v), binding: b.binding }) || x.packetDigest !== sha256Digest(sub.packet) || sha256Digest(x.request) !== sha256Digest(sub.request) || sha256Digest(x.start) !== sha256Digest(s.start) || sha256Digest(x.binding) !== sha256Digest(b.binding) || x.inputDigest !== sha256Digest({ prompt: s.start.prompt, instructions: s.start.instructions }) || v.payloadDigest !== payload("dispatch", v, "payloadDigest")) c.addIssue({ code: "custom", message: "resource-bound native dispatch v2 mismatch" });
});
export type NativeResourceDispatchV2 = z.infer<typeof nativeResourceDispatchSchemaV2>;

/**
 * Match post-authentication outer-frame evidence before relying on the exact
 * start authorization. Structural dispatch parsing alone does not authenticate
 * a transport frame.
 */
export function matchNativeResourceDispatchV2(value: unknown, frame: AuthenticatedNativeResourceDispatchFrameV2): Readonly<NativeResourceDispatchV2> {
  const dispatch = verifyNativeResourceDispatchV2(value), body = nativeResourceDispatchBodySchemaV2.parse(frame.body);
  if (frame.type !== "harness.native.dispatch" || frame.direction !== "server_to_node" || frame.senderKind !== "control_room"
    || frame.messageId !== dispatch.dispatchMessageId || frame.tenantId !== dispatch.tenantId
    || sha256Digest(frame) !== dispatch.dispatchFrameDigest || sha256Digest(body) !== sha256Digest(dispatch.dispatch)
    || !samePair(body, dispatch) || !sameScope(body, dispatch)) bad();
  return dispatch;
}

/** A receipt is exact intake evidence only; all authority flags stay negative. */
export const nativeResourceReceiptSchemaV2 = z.object({ schema: z.literal(NATIVE_RESOURCE_RECEIPT_SCHEMA_V2), dispatch: nativeResourceDispatchSchemaV2, dispatchDigest: resourceBoundWireV2DigestSchema, ...scope, ...admission, receipt: nativeResourceDispatchReceiptBodySchemaV2, receiptDigest: resourceBoundWireV2DigestSchema, payloadDigest: resourceBoundWireV2DigestSchema, ...denied }).strict().superRefine((v, c) => {
  const d0 = v.dispatch, x = d0.dispatch, r = v.receipt;
  const receiptMaterial = without(without(v, "receiptDigest"), "payloadDigest");
  const receiptPayload = without(v, "payloadDigest");
  if (v.dispatchDigest !== d0.payloadDigest || !samePair(v, d0) || !sameScope(v, d0) || !samePair(r, v) || r.dispatchBodyDigest !== sha256Digest(x) || r.queueId !== x.queueId || r.tenantId !== v.tenantId || r.projectId !== v.projectId || r.nodeId !== v.nodeId || r.jobId !== v.jobId || r.attemptId !== v.attemptId || r.packetDigest !== x.packetDigest || r.bindingDigest !== x.bindingDigest || v.receiptDigest !== d("receipt", { resourceAdmission: pair(v), receipt: receiptMaterial }) || v.payloadDigest !== d("receipt-payload", { resourceAdmission: pair(v), boundary: receiptPayload })) c.addIssue({ code: "custom", message: "resource-bound native receipt v2 mismatch" });
});
export type NativeResourceReceiptV2 = z.infer<typeof nativeResourceReceiptSchemaV2>;
export const verifyNativeResourceQueueV2 = (v: unknown): Readonly<NativeResourceQueueV2> => Object.freeze(nativeResourceQueueSchemaV2.parse(v));
export const verifyNativeResourceSubmissionV2 = (v: unknown): Readonly<NativeResourceSubmissionV2> => Object.freeze(nativeResourceSubmissionSchemaV2.parse(v));
export const verifyNativeResourceLeaseV2 = (v: unknown): Readonly<NativeResourceLeaseV2> => Object.freeze(nativeResourceLeaseSchemaV2.parse(v));
export const verifyNativeResourceStartV2 = (v: unknown): Readonly<NativeResourceStartV2> => Object.freeze(nativeResourceStartSchemaV2.parse(v));
export const verifyNativeResourceBindingV2 = (v: unknown): Readonly<NativeResourceBindingV2> => Object.freeze(nativeResourceBindingSchemaV2.parse(v));
export const verifyNativeResourceDispatchV2 = (v: unknown): Readonly<NativeResourceDispatchV2> => Object.freeze(nativeResourceDispatchSchemaV2.parse(v));
export const verifyNativeResourceReceiptV2 = (v: unknown): Readonly<NativeResourceReceiptV2> => Object.freeze(nativeResourceReceiptSchemaV2.parse(v));
export function matchNativeResourceReceiptV2(receiptValue: unknown, dispatchValue: unknown): Readonly<NativeResourceReceiptV2> { const receipt = verifyNativeResourceReceiptV2(receiptValue), dispatch = verifyNativeResourceDispatchV2(dispatchValue); if (receipt.dispatchDigest !== dispatch.payloadDigest || !samePair(receipt, dispatch) || !sameScope(receipt, dispatch)) bad(); return receipt; }
