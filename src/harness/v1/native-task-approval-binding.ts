import { z } from "zod";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema } from "../../domain/v1";
import { computeAuthorityDigest, sha256Digest } from "../../security";
import { computeEffectClaimKey } from "../../node-policy/v1/effect-claim";
import { computeNormalizedOperationDigest } from "../../node-policy/v1/policy-evaluator";
import { normalizedLocalPolicyRequestSchema } from "../../node-policy/v1/schemas";
import type { NormalizedLocalPolicyRequestV1 } from "../../node-policy/v1/types";
import { bindNativeStart, enrollmentSchema, localId, startSchema, type NativeEnrollment, type NativeStart } from "./native-run-contracts";

const taskInput = z.object({ prompt: z.string().min(1).max(4000).refine(v => Buffer.byteLength(v, "utf8") <= 4000),
  instructions: z.string().max(8192).refine(v => Buffer.byteLength(v, "utf8") <= 8192) }).strict();
const fixedOperation = "harness.hermes.native.start";
const fail = (): never => { throw new Error("native_task_approval_binding_invalid"); };
function payload(enrollment: NativeEnrollment, request: Pick<NormalizedLocalPolicyRequestV1, "leaseId" | "leaseEpoch" | "authorityDigest">,
  start: Pick<NativeStart, "prompt" | "instructions" | "deadline">) {
  return sha256Digest({ schema: "control-room.native-task-effect-payload/v1", enrollmentDigest: sha256Digest(enrollment),
    inputDigest: sha256Digest({ prompt: start.prompt, instructions: start.instructions }), leaseId: request.leaseId,
    leaseEpoch: request.leaseEpoch, authorityDigest: request.authorityDigest, deadline: start.deadline });
}

/** Typed payload verification for a trusted node admission controller. This verifies binding, not
 * approval signature, owner ceiling, signed lease provenance, current qualification or permission.
 * The controller must perform those checks separately before releasing any authenticated bytes.
 */
export function verifyNativeTaskApprovalBinding(enrollmentValue: unknown, requestValue: unknown, startValue: unknown) {
  try {
    const enrollment = enrollmentSchema.parse(enrollmentValue), request = normalizedLocalPolicyRequestSchema.parse(requestValue);
    const start = startSchema.parse(startValue);
    taskInput.parse({ prompt: start.prompt, instructions: start.instructions });
    if (request.operationId !== fixedOperation || !request.externalEffect || request.risk !== "low"
      || request.estimatedCostUsd !== undefined || request.estimatedDurationSeconds < 1 || request.estimatedDurationSeconds > 300
      || request.credentialRefs.length !== 1 || request.credentialRefs[0] !== enrollment.credentialRef
      || request.target.kind !== "network" || request.target.canonicalDestination !== enrollment.canonicalDestination
      || request.tenantId !== start.tenantId || request.nodeId !== start.nodeId || request.projectId !== start.projectId
      || request.jobId !== start.jobId || request.attemptId !== start.attemptId
      || request.payloadDigest !== payload(enrollment, request, start)
      || request.operationDigest !== computeNormalizedOperationDigest(request) || start.operationDigest !== request.operationDigest
      || start.effectClaimKey !== computeEffectClaimKey(request)
      || start.runId !== `run:native-task:${start.effectClaimKey.slice(7)}`) fail();
    return bindNativeStart(enrollment, start);
  } catch { return fail(); }
}

/** Build the exact unsigned approval/admission material from an authenticated saved plan and its
 * current canonical reservation. Inputs must be read by trusted coordinator code in one checked
 * transaction. Plain records are not provenance. This pure builder signs nothing and starts nothing.
 */
export function prepareNativeTaskApproval(input: {
  job: unknown; attempt: unknown; lease: unknown; input: unknown; enrollment: unknown; nodeClass: string; now: number;
}) {
  try {
    const job = jobRecordSchema.parse(input.job), attempt = attemptRecordSchema.parse(input.attempt), lease = leaseRecordSchema.parse(input.lease);
    const enrollment = enrollmentSchema.parse(input.enrollment), content = taskInput.parse(input.input), nodeClass = localId.parse(input.nodeClass);
    const a = job.authority, now = input.now;
    if (!Number.isSafeInteger(now) || now < 0 || job.jobType !== "harness.hermes.native.task" || job.specVersion !== "1.0.0"
      || job.requiredCapability !== "harness.hermes.native.runs.v1" || job.state !== "leased"
      || job.inputDigest !== sha256Digest(content) || job.dependsOnJobIds.length || job.retryPolicy.maxAttempts !== 1
      || job.retryPolicy.retryAfterOrphan || job.retryPolicy.retryableFailureCodes.length || job.retryPolicy.ambiguousEffectPolicy !== "attention"
      || attempt.tenantId !== job.tenantId || attempt.jobId !== job.id || attempt.state !== "leased" || attempt.attemptNumber !== 1
      || attempt.startedAt !== undefined || attempt.finishedAt !== undefined || attempt.nodeId !== enrollment.nodeId
      || lease.tenantId !== job.tenantId || lease.jobId !== job.id || lease.attemptId !== attempt.id || lease.state !== "active"
      || lease.nodeId !== enrollment.nodeId || lease.epoch !== attempt.leaseEpoch || enrollment.tenantId !== job.tenantId
      || Date.parse(lease.acquiredAt) > now || Date.parse(attempt.offeredAt) > now
      || a.digest !== computeAuthorityDigest(a) || a.parentDigest !== undefined || a.allowedExecutor === "executor:unassigned"
      || a.allowedOperations.length !== 1 || a.allowedOperations[0] !== fixedOperation || a.maxRisk !== "low"
      || a.effectPolicy !== "approval_required" || a.maxCostUsd !== undefined || a.maxConcurrentEffects !== 1
      || a.maxDurationSeconds < 1 || a.maxDurationSeconds > 300 || a.filesystemRoots.length
      || a.credentialRefs.length !== 1 || a.credentialRefs[0] !== enrollment.credentialRef || a.networkPolicy !== "allowlist"
      || a.allowedNetworkDestinations.length !== 1 || a.allowedNetworkDestinations[0] !== enrollment.canonicalDestination) fail();
    const deadline = Math.min(Date.parse(lease.expiresAt), Date.parse(a.expiresAt), enrollment.validUntil,
      Date.parse(lease.acquiredAt) + a.maxDurationSeconds * 1000);
    if (deadline <= now) fail();
    const identity = { tenantId: job.tenantId, nodeId: enrollment.nodeId, projectId: job.projectId, jobId: job.id, attemptId: attempt.id };
    const request: NormalizedLocalPolicyRequestV1 = { contractVersion: "control-room-node-policy/v1",
      requestId: `request:native-task:${sha256Digest({ ...identity, leaseId: lease.id, leaseEpoch: lease.epoch }).slice(7)}`,
      ...identity, nodeClass, leaseId: lease.id, leaseEpoch: lease.epoch, executorId: a.allowedExecutor,
      operationId: fixedOperation, operationDigest: "", authorityDigest: a.digest, credentialRefs: [enrollment.credentialRef],
      target: { kind: "network", canonicalDestination: enrollment.canonicalDestination }, risk: "low", externalEffect: true,
      estimatedDurationSeconds: a.maxDurationSeconds, occurredAt: new Date(now).toISOString() };
    request.payloadDigest = payload(enrollment, request, { ...content, deadline });
    request.operationDigest = computeNormalizedOperationDigest(request);
    const effectClaimKey = computeEffectClaimKey(request);
    const start: NativeStart = { ...identity, ...content, deadline, effectClaimKey,
      operationDigest: request.operationDigest, runId: `run:native-task:${effectClaimKey.slice(7)}` };
    const bound = verifyNativeTaskApprovalBinding(enrollment, request, start);
    return { request, start, binding: bound.binding, body: bound.body,
      startsWork: false as const, grantsExecutionAuthority: false as const };
  } catch { return fail(); }
}
