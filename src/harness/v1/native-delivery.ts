import { z } from "zod";
import { normalizedLocalPolicyRequestSchema } from "../../node-policy/v1/schemas";
import { sha256Digest } from "../../security/canonical-digest";
import { startSchema, enrollmentSchema } from "./native-run-contracts";
import { verifyNativeTaskApprovalBinding } from "./native-task-approval-binding";
import { localId, digestSchema } from "./native-run-identifiers";
import { nativeTaskApprovalPacketSchema } from "./native-approval-packet";

export const NATIVE_DELIVERY_FEATURE = "harness.native.dispatch.v1" as const;
export const nativeTaskDispatchBodySchema = z.object({
  schema: z.literal("control-room.native-task-dispatch/v1"), queueId: localId, inputDigest: digestSchema,
  enrollmentDigest: digestSchema, bindingDigest: digestSchema, packetDigest: digestSchema,
  request: normalizedLocalPolicyRequestSchema, start: startSchema, packet: nativeTaskApprovalPacketSchema,
}).strict().superRefine((v, ctx) => {
  const r = v.request, s = v.start, a = v.packet.approval.body;
  const expectedQueue = `native-queue:${sha256Digest({ tenantId: r.tenantId, jobId: r.jobId, attemptId: r.attemptId }).slice(7)}`;
  if (v.queueId !== expectedQueue || v.inputDigest !== sha256Digest({ prompt: s.prompt, instructions: s.instructions })
    || r.approval || r.operationId !== "harness.hermes.native.start"
    || r.tenantId !== s.tenantId || r.projectId !== s.projectId || r.jobId !== s.jobId
    || r.attemptId !== s.attemptId || r.nodeId !== s.nodeId || r.operationDigest !== s.operationDigest
    || a.tenantId !== r.tenantId || a.nodeId !== r.nodeId || a.projectId !== r.projectId
    || a.jobId !== r.jobId || a.attemptId !== r.attemptId || a.operationDigest !== r.operationDigest
    || a.decision !== "approved" || a.risk !== r.risk || Date.parse(a.expiresAt) < s.deadline
    || v.packet.recovery.body.bindingDigest !== v.bindingDigest || v.packetDigest !== sha256Digest(v.packet)
    || Buffer.byteLength(JSON.stringify(v), "utf8") > 65_536) ctx.addIssue({ code: "custom", message: "native dispatch binding mismatch" });
});
export type NativeTaskDispatchBody = z.infer<typeof nativeTaskDispatchBodySchema>;

/** After frame authentication, resolve enrollment locally. Never adopt configuration from a message.
 * Binding only: paired signature intake and current node admission are still separately required. */
export function prepareNativeTaskDispatchIntake(body: unknown, trustedEnrollment: unknown) {
  const value = nativeTaskDispatchBodySchema.parse(body), enrollment = enrollmentSchema.parse(trustedEnrollment);
  const { binding } = verifyNativeTaskApprovalBinding(enrollment, value.request, value.start);
  if (sha256Digest(enrollment) !== value.enrollmentDigest || sha256Digest(binding) !== value.bindingDigest)
    throw new Error("native_dispatch_binding_mismatch");
  return { enrollment, request: value.request, start: value.start, packet: value.packet };
}

/** Receipt is durable intake evidence only, never approval, execution, completion or stop proof. */
export const nativeTaskDispatchReceiptBodySchema = z.object({
  schema: z.literal("control-room.native-task-dispatch-receipt/v1"),
  queueId: localId, dispatchMessageId: localId, dispatchBodyDigest: digestSchema,
  tenantId: localId, projectId: localId, nodeId: localId, jobId: localId, attemptId: localId,
  packetDigest: digestSchema, bindingDigest: digestSchema,
  recordedAt: z.string().datetime(), disposition: z.enum(["recorded", "rejected"]),
  safeReason: z.enum(["none", "expired", "binding_mismatch", "authority_unavailable", "storage_uncertain"]),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((v, ctx) => {
  if ((v.disposition === "recorded") !== (v.safeReason === "none")) ctx.addIssue({ code: "custom", message: "receipt disposition mismatch" });
});
export type NativeTaskDispatchReceiptBody = z.infer<typeof nativeTaskDispatchReceiptBodySchema>;

/** Call only after authenticating the receipt's node frame. This matches evidence, not authority. */
export function matchNativeTaskDispatchReceipt(receipt: unknown, expected: { messageId: string; body: NativeTaskDispatchBody }) {
  const r = nativeTaskDispatchReceiptBodySchema.parse(receipt), b = nativeTaskDispatchBodySchema.parse(expected.body), q = b.request;
  if (r.dispatchMessageId !== expected.messageId || r.dispatchBodyDigest !== sha256Digest(b)
    || r.queueId !== b.queueId || r.tenantId !== q.tenantId || r.projectId !== q.projectId
    || r.nodeId !== q.nodeId || r.jobId !== q.jobId || r.attemptId !== q.attemptId
    || r.packetDigest !== b.packetDigest || r.bindingDigest !== b.bindingDigest) throw new Error("native_dispatch_receipt_mismatch");
  return r;
}
