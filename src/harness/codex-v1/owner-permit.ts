import { z } from "zod";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema } from "../../domain/v1";
import { canonicalJson, computeAuthorityDigest, sha256Digest } from "../../security";
import { computeArtifactBodyDigest, verifyArtifactSignature } from "../../node-policy/v1/crypto";
import { computeEffectClaimKey } from "../../node-policy/v1/effect-claim";
import { computeNormalizedOperationDigest } from "../../node-policy/v1/policy-evaluator";
import { canonicalFilesystemPathSchema, normalizedLocalPolicyRequestSchema, ownerApprovalAttestationBodySchema,
  ownerApprovalAttestationSchema } from "../../node-policy/v1/schemas";
import type { NormalizedLocalPolicyRequestV1 } from "../../node-policy/v1/types";
import { digestSchema, localId } from "../v1/native-run-identifiers";
import { CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_JOB_TYPE, CODEX_START_OPERATION,
  codexTaskPayloadDigestV1, codexTaskStartSchemaV1 } from "./delivery-contract";

const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const taskInputSchema = z.object({ prompt: z.string().min(1).max(32_768).refine(value => Buffer.byteLength(value, "utf8") <= 32_768),
  instructions: z.string().max(8192).refine(value => Buffer.byteLength(value, "utf8") <= 8192) }).strict();
const bindingSchema = z.object({ tenantId: localId, nodeId: localId, nodeClass: localId,
  enrollmentDigest: digestSchema, connectorProfileDigest: digestSchema, workspaceIntentDigest: digestSchema,
  credentialRef: localId, filesystemRoot: canonicalFilesystemPathSchema, validUntil: instant }).strict();
export type CodexOwnerPermitBindingV1 = z.infer<typeof bindingSchema>;
export function prepareCodexOwnerPermitBinding(value: unknown): CodexOwnerPermitBindingV1 {
  return Object.freeze(bindingSchema.parse(value));
}
const failMaterial = (): never => { throw new Error("codex_owner_permit_material_invalid"); };

export type CodexOwnerPermitPreparationInputV1 = {
  job: unknown; attempt: unknown; lease: unknown; input: unknown; binding: unknown;
  approvalKeyId: string; issuedAt: number; approvalNonce: string;
};

/**
 * Builds the one exact unsigned Codex owner permit from trusted canonical records
 * and configured node bindings. It has no signing key, storage, queue, process,
 * provider, workspace, or delivery dependency.
 */
export function prepareCodexOwnerPermitMaterial(input: CodexOwnerPermitPreparationInputV1) {
  try {
    const job = jobRecordSchema.parse(input.job), attempt = attemptRecordSchema.parse(input.attempt);
    const lease = leaseRecordSchema.parse(input.lease), content = taskInputSchema.parse(input.input);
    const binding = bindingSchema.parse(input.binding), key = localId.parse(input.approvalKeyId);
    const now = instant.parse(input.issuedAt), authority = job.authority;
    if (job.jobType !== CODEX_APP_SERVER_JOB_TYPE || job.specVersion !== "1.0.0"
      || job.requiredCapability !== CODEX_APP_SERVER_CAPABILITY || job.state !== "leased"
      || job.inputDigest !== sha256Digest(content) || job.dependsOnJobIds.length || job.retryPolicy.maxAttempts !== 1
      || job.retryPolicy.retryAfterOrphan || job.retryPolicy.retryableFailureCodes.length || job.retryPolicy.ambiguousEffectPolicy !== "attention"
      || attempt.tenantId !== job.tenantId || attempt.jobId !== job.id || attempt.state !== "leased" || attempt.attemptNumber !== 1
      || attempt.startedAt !== undefined || attempt.finishedAt !== undefined || attempt.nodeId !== binding.nodeId
      || lease.tenantId !== job.tenantId || lease.jobId !== job.id || lease.attemptId !== attempt.id || lease.state !== "active"
      || lease.nodeId !== binding.nodeId || lease.epoch !== attempt.leaseEpoch || binding.tenantId !== job.tenantId
      || Date.parse(lease.acquiredAt) > now || Date.parse(attempt.offeredAt) > now
      || authority.digest !== computeAuthorityDigest(authority) || authority.parentDigest !== undefined
      || authority.allowedExecutor === "executor:unassigned" || authority.allowedOperations.length !== 1
      || authority.allowedOperations[0] !== CODEX_START_OPERATION || authority.maxRisk !== "low"
      || authority.effectPolicy !== "approval_required" || authority.maxCostUsd !== undefined || authority.maxConcurrentEffects !== 1
      || authority.maxDurationSeconds < 1 || authority.maxDurationSeconds > 300
      || authority.filesystemRoots.length !== 1 || authority.filesystemRoots[0] !== binding.filesystemRoot
      || authority.credentialRefs.length !== 1 || authority.credentialRefs[0] !== binding.credentialRef
      || authority.networkPolicy !== "none" || authority.allowedNetworkDestinations.length) return failMaterial();
    const deadline = Math.min(Date.parse(lease.expiresAt), Date.parse(authority.expiresAt), binding.validUntil,
      Date.parse(lease.acquiredAt) + authority.maxDurationSeconds * 1000);
    if (!Number.isFinite(deadline) || deadline <= now) return failMaterial();
    const identity = { tenantId: job.tenantId, nodeId: binding.nodeId, projectId: job.projectId, jobId: job.id, attemptId: attempt.id };
    const provisional = codexTaskStartSchemaV1.parse({ schema: "control-room.codex-task-start/v1", ...identity,
      runId: `run:codex-task:${sha256Digest({ ...identity, leaseId: lease.id, leaseEpoch: lease.epoch }).slice(7)}`,
      leaseId: lease.id, leaseEpoch: lease.epoch, effectClaimKey: sha256Digest("codex-owner-permit-pending"),
      operationDigest: sha256Digest("codex-owner-permit-pending"), inputDigest: sha256Digest(content),
      enrollmentDigest: binding.enrollmentDigest, connectorProfileDigest: binding.connectorProfileDigest,
      workspaceIntentDigest: binding.workspaceIntentDigest, ...content, deadline });
    const request: NormalizedLocalPolicyRequestV1 = { contractVersion: "control-room-node-policy/v1",
      requestId: `request:codex-task:${sha256Digest({ ...identity, leaseId: lease.id, leaseEpoch: lease.epoch }).slice(7)}`,
      ...identity, nodeClass: binding.nodeClass, leaseId: lease.id, leaseEpoch: lease.epoch, executorId: authority.allowedExecutor,
      operationId: CODEX_START_OPERATION, operationDigest: "", authorityDigest: authority.digest, credentialRefs: [binding.credentialRef],
      target: { kind: "filesystem", canonicalPath: binding.filesystemRoot }, risk: "low", externalEffect: true,
      estimatedDurationSeconds: authority.maxDurationSeconds, occurredAt: new Date(now).toISOString() };
    request.payloadDigest = codexTaskPayloadDigestV1(provisional, authority.digest);
    request.operationDigest = computeNormalizedOperationDigest(request);
    const effectClaimKey = computeEffectClaimKey(request);
    const start = codexTaskStartSchemaV1.parse({ ...provisional, effectClaimKey, operationDigest: request.operationDigest,
      runId: `run:codex-task:${effectClaimKey.slice(7)}` });
    if (request.payloadDigest !== codexTaskPayloadDigestV1(start, authority.digest)) return failMaterial();
    const approval = { schema: "control-room.owner-approval-attestation/v1" as const, ...identity,
      operationDigest: request.operationDigest, risk: "low" as const, decision: "approved" as const,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(deadline).toISOString(), nonce: input.approvalNonce,
      approvalKeyId: key };
    const parsedApproval = ownerApprovalAttestationBodySchema.parse({ ...approval, bodyDigest: computeArtifactBodyDigest(approval) });
    return Object.freeze({ request: Object.freeze(request), start: Object.freeze(start), approval: Object.freeze(parsedApproval),
      startsWork: false as const, grantsExecutionAuthority: false as const });
  } catch { return failMaterial(); }
}

/** Safe review material for the same exact unsigned permit; no profile details or credentials are exposed. */
export function describeCodexOwnerPermitReview(input: CodexOwnerPermitPreparationInputV1) {
  const material = prepareCodexOwnerPermitMaterial(input), { request, start } = material;
  if (request.approval) throw new Error("codex_owner_permit_material_invalid");
  return Object.freeze({ projectId: start.projectId, jobId: start.jobId, inputDigest: start.inputDigest,
    attemptId: start.attemptId, nodeId: start.nodeId, prompt: start.prompt, instructions: start.instructions,
    durationSeconds: request.estimatedDurationSeconds, deadline: new Date(start.deadline).toISOString(),
    operationDigest: request.operationDigest, connectorProfileDigest: start.connectorProfileDigest,
    workspaceIntentDigest: start.workspaceIntentDigest, signatureStatus: "unsigned" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
}

/**
 * Bounded one-shot owner-signing composition. The caller supplies an actual
 * synchronous consent/current-pins guard; no key custody is implemented here.
 */
export function createCodexOwnerPermitIssuer(input: CodexOwnerPermitPreparationInputV1, dependencies: {
  publicKeySpki: string; timeoutMs: number; clock: () => number;
  assertOwnerConsentCurrent: (reviewDigest: string) => void;
  sign: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
}) {
  const material = prepareCodexOwnerPermitMaterial(input), review = describeCodexOwnerPermitReview(input);
  const reviewDigest = sha256Digest({ review, material }), key = dependencies.publicKeySpki, clock = dependencies.clock;
  const consent = dependencies.assertOwnerConsentCurrent, sign = dependencies.sign, timeoutMs = dependencies.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("codex_owner_permit_issuer_invalid");
  let attempted = false, highWater = Date.parse(material.approval.issuedAt);
  return Object.freeze({ review, reviewDigest,
    authorization: Object.freeze({ approvalKeyId: material.approval.approvalKeyId, approvalExpiresAt: material.approval.expiresAt }),
    async issue(signal: AbortSignal) {
      const unavailable = () => new Error("codex_owner_permit_issuance_uncertain");
      if (attempted) throw unavailable(); attempted = true;
      const controller = new AbortController(), stop = () => controller.abort(), end = performance.now() + timeoutMs;
      const observe = () => {
        const now = clock();
        if (controller.signal.aborted || signal.aborted || performance.now() >= end || !Number.isSafeInteger(now)
          || now < highWater || now >= Date.parse(material.approval.expiresAt)) throw unavailable();
        highWater = now;
      };
      const current = () => {
        observe(); const result: unknown = consent(reviewDigest);
        if (result !== undefined) { if (result instanceof Promise) void result.catch(() => {}); throw unavailable(); }
        observe();
      };
      signal.addEventListener("abort", stop, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined, onAbort: () => void = () => {};
      try {
        const stopped = new Promise<never>((_, reject) => {
          onAbort = () => reject(unavailable()); controller.signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(stop, timeoutMs);
        });
        const work = (async () => {
          current(); const bytes = await sign(Buffer.from(canonicalJson(material.approval)), controller.signal); current();
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 64) throw unavailable();
          const permit = ownerApprovalAttestationSchema.parse({ body: material.approval,
            signatureAlgorithm: "Ed25519" as const, signature: Buffer.from(bytes).toString("base64url") });
          if (!verifyArtifactSignature(permit, key)) throw unavailable(); current(); return permit;
        })();
        return await Promise.race([work, stopped]);
      } catch { throw unavailable(); }
      finally { controller.abort(); clearTimeout(timer); signal.removeEventListener("abort", stop);
        controller.signal.removeEventListener("abort", onAbort); }
    },
  });
}
