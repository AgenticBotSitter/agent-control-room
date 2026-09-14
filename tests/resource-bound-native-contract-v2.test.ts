import assert from "node:assert/strict";
import test from "node:test";
import { resourceAdmissionBindingSchemaV2, resourceBoundWireV2Digest } from "../src/resource-bound-wire/v2/common";
import {
  NATIVE_RESOURCE_DISPATCH_FEATURE_V2, NATIVE_RESOURCE_LEASE_FEATURE_V2,
  NATIVE_RESOURCE_QUEUE_SCHEMA_V2,
  computeNativeStartAuthorizationDigestV2, computeNativeResourcePayloadDigestV2, createNativeResourceBindingLeafV2, matchNativeResourceDispatchV2,
  nativeResourceBindingSchemaV2, nativeResourceEffectClaimKeyV2, nativeResourceLeaseSchemaV2, nativeResourceDispatchSchemaV2,
  nativeResourceQueueSchemaV2, nativeResourceReceiptSchemaV2, nativeResourceRequestSchemaV2, nativeResourceStartLeafSchemaV2,
  nativeResourceStartSchemaV2, nativeResourceSubmissionSchemaV2,
} from "../src/resource-bound-wire/v2/native-contract";
import { computeArtifactBodyDigest } from "../src/node-policy/v1/crypto";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { verifyCurrentResourceHolderProofV2 } from "../src/contracts/v1/project-coordination-boundaries";

const namespace = "control-room.resource-bound-wire/v2/native-queue/v2";
const digest = (kind: string, value: unknown) => resourceBoundWireV2Digest(`${namespace.replace("native-queue", `native-${kind}`)}`, value);
const admission = { resourceAdmissionId: "admission:test", resourceAdmissionDigest: resourceBoundWireV2Digest("control-room.resource-admission/v2", { id: "admission:test" }) };
const nativeDigest = (kind: string, value: unknown) => resourceBoundWireV2Digest(`control-room.resource-bound-wire/v2/native-${kind}/v2`, value);
const nativePayload = (kind: string, value: Record<string, unknown>, omit: string) => {
  const boundary = { ...value }; delete boundary[omit];
  return nativeDigest(`${kind}-payload`, { resourceAdmission: admission, boundary });
};
function queue() {
  const base = {
    schema: NATIVE_RESOURCE_QUEUE_SCHEMA_V2, tenantId: "tenant:test", projectId: "project:test", nodeId: "node:test",
    jobId: "job:test", attemptId: "attempt:test", ...admission, leaseId: "lease:test", leaseEpoch: 1,
    inputDigest: resourceBoundWireV2Digest("control-room.resource-bound-wire/v2/input/v2", { input: "test" }),
    packetDigest: resourceBoundWireV2Digest("control-room.resource-bound-wire/v2/packet/v2", { packet: "test" }),
    operationDigest: resourceBoundWireV2Digest("control-room.resource-bound-wire/v2/operation/v2", { operation: "test" }),
    bindingDigest: resourceBoundWireV2Digest("control-room.resource-bound-wire/v2/binding/v2", { binding: "test" }),
    enrollmentDigest: resourceBoundWireV2Digest("control-room.resource-bound-wire/v2/enrollment/v2", { enrollment: "test" }),
    deadline: 200, queuedAt: "2026-09-13T00:00:00.000Z", queuedBy: "actor:test",
    startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const,
    permitsRetry: false as const, permitsThreadRead: false as const,
  };
  const queueId = `native-queue:${digest("queue-id", { tenantId: base.tenantId, jobId: base.jobId, attemptId: base.attemptId, resourceAdmission: admission }).slice(7)}`;
  const unsigned = { ...base, queueId };
  return { ...unsigned, payloadDigest: digest("queue-payload", { resourceAdmission: admission, boundary: unsigned }) };
}

test("v2 queue binds the exact admission pair into its ID and payload before operation material", () => {
  const value = queue();
  assert.deepEqual(nativeResourceQueueSchemaV2.parse(value), value);
  assert.throws(() => nativeResourceQueueSchemaV2.parse({ ...value, resourceAdmissionDigest: value.operationDigest }));
  assert.throws(() => nativeResourceQueueSchemaV2.parse({ ...value, resourceAdmissionId: "admission:other" }));
  assert.throws(() => nativeResourceQueueSchemaV2.parse({ ...value, startsWork: true }));
  assert.throws(() => nativeResourceQueueSchemaV2.parse({ ...value, extra: "not allowed" }));
});

test("v2 accepts stable canonical IDs but cannot be confused with a v1 contract literal", () => {
  assert.deepEqual(resourceAdmissionBindingSchemaV2.parse(admission), admission);
  const value = queue();
  assert.throws(() => nativeResourceQueueSchemaV2.parse({ ...value, schema: "control-room.native-task-queue/v1" }));
  assert.equal(NATIVE_RESOURCE_DISPATCH_FEATURE_V2, "harness.native.dispatch.v2");
  assert.equal(NATIVE_RESOURCE_LEASE_FEATURE_V2, "harness.native.lease.v2");
});

test("submission boundary refuses missing, substituted, and unbound resource fields before leaf acceptance", () => {
  const value = queue();
  const skeletal = { schema: "control-room.resource-bound-native-submission/v2", submissionId: "submission:test", queue: value,
    queueDigest: value.payloadDigest, tenantId: value.tenantId, projectId: value.projectId, nodeId: value.nodeId,
    jobId: value.jobId, attemptId: value.attemptId, ...admission, enrollment: {}, request: {}, start: {}, packet: {},
    payloadDigest: value.payloadDigest, startsWork: false, grantsExecutionAuthority: false, permitsResume: false, permitsRetry: false, permitsThreadRead: false };
  assert.throws(() => nativeResourceSubmissionSchemaV2.parse(skeletal));
  assert.throws(() => nativeResourceSubmissionSchemaV2.parse({ ...skeletal, resourceAdmissionDigest: value.operationDigest }));
  assert.throws(() => nativeResourceSubmissionSchemaV2.parse({ ...skeletal, resourceAdmissionId: undefined }));
});

test("final-start digest binds the exact admission pair and signed dispatch identity", () => {
  const base = { ...admission, tenantId: "tenant:test", projectId: "project:test", nodeId: "node:test", jobId: "job:test",
    attemptId: "attempt:test", leaseId: "lease:test", leaseEpoch: 1, runId: "run:native-task:abc", operationDigest: queue().operationDigest,
    effectClaimKey: queue().bindingDigest, dispatchMessageId: "message:dispatch", dispatchFrameDigest: queue().packetDigest };
  const exact = computeNativeStartAuthorizationDigestV2(base);
  assert.notEqual(exact, computeNativeStartAuthorizationDigestV2({ ...base, resourceAdmissionDigest: queue().operationDigest }));
  assert.notEqual(exact, computeNativeStartAuthorizationDigestV2({ ...base, dispatchFrameDigest: queue().bindingDigest }));
});

test("actual v2 request, operation, and effect leaves reject a v1-style wrapped request", () => {
  const enrollment = { adapter: "hermes-native-runs/v1", revision: "29112bef099274229cadff79cdff7bf7b99c4b77", tenantId: "tenant:test", nodeId: "node:test", connectionId: "connection:test", canonicalDestination: "https://agent.example.test:443", profile: "native", credentialRef: "credential:test", profilePolicyDigest: queue().packetDigest, qualificationDigest: queue().bindingDigest, validUntil: 500, model: "model-test", provider: "provider" };
  const common = { ...admission, tenantId: "tenant:test", projectId: "project:test", nodeId: "node:test", jobId: "job:test", attemptId: "attempt:test", nodeClass: "node-class:test", leaseId: "lease:test", leaseEpoch: 1, executorId: "executor:test", operationId: "harness.hermes.native.start" as const, authorityDigest: queue().operationDigest, credentialRefs: ["credential:test"], target: { kind: "network" as const, canonicalDestination: "https://agent.example.test:443" }, risk: "low" as const, externalEffect: true as const, estimatedDurationSeconds: 60, estimatedCostUsd: null, approval: null, occurredAt: "2026-09-13T00:00:00.000Z" };
  const provisional = { ...common, schema: "control-room.resource-bound-native-request/v2" as const, contractVersion: "control-room.resource-bound-native-request/v2" as const, requestId: "request:native-task:placeholder", operationDigest: queue().operationDigest, payloadDigest: queue().packetDigest };
  const start0 = { ...admission, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, runId: "run:native-task:placeholder", effectClaimKey: queue().bindingDigest, operationDigest: queue().operationDigest, prompt: "do work", instructions: "", deadline: 200 };
  const payloadDigest = computeNativeResourcePayloadDigestV2(enrollment, provisional, start0);
  const operationDigest = resourceBoundWireV2Digest("control-room.resource-bound-wire/v2/native-operation/v2", { resourceAdmission: admission, tenantId: common.tenantId, nodeId: common.nodeId, projectId: common.projectId, jobId: common.jobId, attemptId: common.attemptId, executorId: common.executorId, operationId: common.operationId, credentialRefs: common.credentialRefs, target: common.target, risk: common.risk, externalEffect: true, estimatedDurationSeconds: 60, estimatedCostUsd: null, approval: null, payloadDigest });
  const requestId = `request:native-task:${resourceBoundWireV2Digest("control-room.resource-bound-wire/v2/native-request-id/v2", { resourceAdmission: admission, tenantId: common.tenantId, nodeId: common.nodeId, projectId: common.projectId, jobId: common.jobId, attemptId: common.attemptId, leaseId: common.leaseId, leaseEpoch: 1 }).slice(7)}`;
  const request = { ...provisional, requestId, operationDigest, payloadDigest };
  const effectClaimKey = nativeResourceEffectClaimKeyV2(request);
  const start = { ...start0, effectClaimKey, operationDigest, runId: `run:native-task:${effectClaimKey.slice(7)}` };
  assert.deepEqual(nativeResourceRequestSchemaV2.parse(request), request);
  assert.deepEqual(nativeResourceStartLeafSchemaV2.parse(start), start);
  assert.throws(() => nativeResourceRequestSchemaV2.parse({ ...request, schema: "control-room-node-policy/v1" }));
  assert.throws(() => nativeResourceRequestSchemaV2.parse({ ...request, resourceAdmissionDigest: queue().operationDigest }));
});

test("native v2 constructs the full queue-to-receipt chain and binds an authenticated dispatch frame", () => {
  const enrollment = { adapter: "hermes-native-runs/v1" as const, revision: "29112bef099274229cadff79cdff7bf7b99c4b77" as const,
    tenantId: "tenant:test", nodeId: "node:test", connectionId: "connection:test", canonicalDestination: "https://agent.example.test:443",
    profile: "native", credentialRef: "credential:test", profilePolicyDigest: digest("profile", {}), qualificationDigest: digest("qualification", {}), validUntil: 500, model: "model-test", provider: "provider" };
  const authority = { projectId: "project:test", allowedExecutor: "executor:test", allowedOperations: ["harness.hermes.native.start"], credentialRefs: ["credential:test"], filesystemRoots: [], networkPolicy: "allowlist" as const, allowedNetworkDestinations: [enrollment.canonicalDestination], effectPolicy: "approval_required" as const, maxRisk: "low" as const, maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: "2026-09-13T00:10:00.000Z", digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const common = { ...admission, tenantId: "tenant:test", projectId: "project:test", nodeId: "node:test", jobId: "job:test", attemptId: "attempt:test",
    nodeClass: "node-class:test", leaseId: "lease:test", leaseEpoch: 1, executorId: "executor:test", operationId: "harness.hermes.native.start" as const,
    authorityDigest: authority.digest, credentialRefs: ["credential:test"], target: { kind: "network" as const, canonicalDestination: enrollment.canonicalDestination },
    risk: "low" as const, externalEffect: true as const, estimatedDurationSeconds: 60, estimatedCostUsd: null, approval: null, occurredAt: "2026-09-13T00:00:00.000Z" };
  const start0 = { ...admission, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId,
    runId: "run:native-task:placeholder", effectClaimKey: digest("placeholder-effect", {}), operationDigest: digest("placeholder-operation", {}), prompt: "do work", instructions: "", deadline: 200 };
  const request0 = { ...common, schema: "control-room.resource-bound-native-request/v2" as const, contractVersion: "control-room.resource-bound-native-request/v2" as const,
    requestId: "request:native-task:placeholder", operationDigest: digest("placeholder-operation", {}), payloadDigest: digest("placeholder-payload", {}) };
  const payloadDigest = computeNativeResourcePayloadDigestV2(enrollment, request0, start0);
  const operationDigest = nativeDigest("operation", { resourceAdmission: admission, tenantId: common.tenantId, nodeId: common.nodeId, projectId: common.projectId,
    jobId: common.jobId, attemptId: common.attemptId, executorId: common.executorId, operationId: common.operationId, credentialRefs: common.credentialRefs,
    target: common.target, risk: common.risk, externalEffect: common.externalEffect, estimatedDurationSeconds: common.estimatedDurationSeconds,
    estimatedCostUsd: common.estimatedCostUsd, approval: common.approval, payloadDigest });
  const requestId = `request:native-task:${nativeDigest("request-id", { resourceAdmission: admission, tenantId: common.tenantId, nodeId: common.nodeId,
    projectId: common.projectId, jobId: common.jobId, attemptId: common.attemptId, leaseId: common.leaseId, leaseEpoch: common.leaseEpoch }).slice(7)}`;
  const request = nativeResourceRequestSchemaV2.parse({ ...request0, requestId, operationDigest, payloadDigest });
  const effectClaimKey = nativeResourceEffectClaimKeyV2(request);
  const start = nativeResourceStartLeafSchemaV2.parse({ ...start0, operationDigest, effectClaimKey, runId: `run:native-task:${effectClaimKey.slice(7)}` });
  const binding = createNativeResourceBindingLeafV2(enrollment, request, start);
  const approvalBody = { schema: "control-room.owner-approval-attestation/v1" as const, tenantId: common.tenantId, nodeId: common.nodeId, projectId: common.projectId,
    jobId: common.jobId, attemptId: common.attemptId, operationDigest, risk: "low" as const, decision: "approved" as const,
    issuedAt: "2026-09-13T00:00:00.000Z", expiresAt: "2026-09-13T00:10:00.000Z", nonce: "0123456789abcdef", approvalKeyId: "approval-key:test" };
  const approval = { body: { ...approvalBody, bodyDigest: computeArtifactBodyDigest(approvalBody) }, signatureAlgorithm: "Ed25519" as const, signature: "A".repeat(86) };
  const recoveryBody = { schema: "control-room.native-run-recovery-permission/v1" as const, bindingDigest: nativeDigest("binding", { resourceAdmission: admission, binding }),
    approvalKeyId: approvalBody.approvalKeyId, issuedAt: 0, expiresAt: 500, operations: ["status", "stop"] as ["status", "stop"], nonce: "0123456789abcdef", bodyDigest: digest("recovery", {}) };
  const packet = { schema: "control-room.resource-bound-native-approval-packet/v2" as const, ...admission, approval, recovery: { body: recoveryBody, signatureAlgorithm: "Ed25519" as const, signature: "A".repeat(86) } };
  const inputDigest = resourceBoundWireV2Digest("control-room.resource-bound-wire/v2/input/v2", { prompt: start.prompt, instructions: start.instructions });
  const queueBase = { schema: NATIVE_RESOURCE_QUEUE_SCHEMA_V2, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId,
    ...admission, leaseId: common.leaseId, leaseEpoch: common.leaseEpoch, inputDigest: sha256Digest({ prompt: start.prompt, instructions: start.instructions }), packetDigest: sha256Digest(packet), operationDigest, bindingDigest: nativeDigest("binding", { resourceAdmission: admission, binding }), enrollmentDigest: sha256Digest(enrollment), deadline: start.deadline, queuedAt: common.occurredAt, queuedBy: "actor:test", startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  void inputDigest;
  const queueId = `native-queue:${nativeDigest("queue-id", { tenantId: common.tenantId, jobId: common.jobId, attemptId: common.attemptId, resourceAdmission: admission }).slice(7)}`;
  const nativeQueue = nativeResourceQueueSchemaV2.parse({ ...queueBase, queueId, payloadDigest: nativePayload("queue", { ...queueBase, queueId }, "payloadDigest") });
  const submissionBase = { schema: "control-room.resource-bound-native-submission/v2" as const, queue: nativeQueue, queueDigest: nativeQueue.payloadDigest, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, ...admission, enrollment, request, start, packet, startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  const submissionId = `native-submission:${nativeDigest("submission-id", { queueDigest: nativeQueue.payloadDigest, resourceAdmission: admission }).slice(7)}`;
  const submission = nativeResourceSubmissionSchemaV2.parse({ ...submissionBase, submissionId, payloadDigest: nativePayload("submission", { ...submissionBase, submissionId }, "payloadDigest") });
  const leaseGrant = { offerId: "offer:native:test", nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, leaseId: common.leaseId, leaseEpoch: common.leaseEpoch, acquiredAt: common.occurredAt, expiresAt: approvalBody.expiresAt, authorityDigest: common.authorityDigest, authority };
  const leaseBase = { schema: "control-room.resource-bound-native-lease/v2" as const, submission, submissionDigest: submission.payloadDigest, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, ...admission, leaseGrant, leaseFeature: NATIVE_RESOURCE_LEASE_FEATURE_V2, startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  const lease = nativeResourceLeaseSchemaV2.parse({ ...leaseBase, payloadDigest: nativePayload("lease", leaseBase, "payloadDigest") });
  const startBase = { schema: "control-room.resource-bound-native-start/v2" as const, lease, leaseDigest: lease.payloadDigest, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, ...admission, start, startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  const startEnvelope = nativeResourceStartSchemaV2.parse({ ...startBase, payloadDigest: nativePayload("start", startBase, "payloadDigest") });
  const bindingBase = { schema: "control-room.resource-bound-native-binding/v2" as const, start: startEnvelope, startDigest: startEnvelope.payloadDigest, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, ...admission, binding, startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  const bindingEnvelope = nativeResourceBindingSchemaV2.parse({ ...bindingBase, payloadDigest: nativePayload("binding", bindingBase, "payloadDigest") });
  const dispatchBody = { schema: "control-room.resource-bound-native-dispatch-body/v2" as const, queueId: nativeQueue.queueId, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, ...admission, inputDigest: queueBase.inputDigest, enrollmentDigest: queueBase.enrollmentDigest, bindingDigest: queueBase.bindingDigest, packetDigest: queueBase.packetDigest, request, start, binding, packet };
  const frame = { type: "harness.native.dispatch" as const, direction: "server_to_node" as const, senderKind: "control_room" as const, messageId: "message:native-dispatch", tenantId: common.tenantId, actorId: "control-room:test", keyId: "server-key:test", connectionId: enrollment.connectionId, sentAt: common.occurredAt, expiresAt: approvalBody.expiresAt, body: dispatchBody };
  const dispatchBase = { schema: "control-room.resource-bound-native-dispatch/v2" as const, binding: bindingEnvelope, bindingDigest: bindingEnvelope.payloadDigest, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, ...admission, dispatch: dispatchBody, dispatchFeature: NATIVE_RESOURCE_DISPATCH_FEATURE_V2, dispatchMessageId: frame.messageId, dispatchFrameDigest: sha256Digest(frame), startAuthorizationDigest: "", startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  dispatchBase.startAuthorizationDigest = computeNativeStartAuthorizationDigestV2({ ...admission, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, leaseId: common.leaseId, leaseEpoch: common.leaseEpoch, runId: start.runId, operationDigest, effectClaimKey, dispatchMessageId: frame.messageId, dispatchFrameDigest: dispatchBase.dispatchFrameDigest });
  const dispatch = nativeResourceDispatchSchemaV2.parse({ ...dispatchBase, payloadDigest: nativePayload("dispatch", dispatchBase, "payloadDigest") });
  assert.equal(matchNativeResourceDispatchV2(dispatch, frame).dispatchMessageId, frame.messageId);
  const receiptBody = { schema: "control-room.resource-bound-native-dispatch-receipt/v2" as const, queueId: nativeQueue.queueId, dispatchMessageId: frame.messageId, dispatchBodyDigest: sha256Digest(dispatchBody), tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, ...admission, packetDigest: queueBase.packetDigest, bindingDigest: queueBase.bindingDigest, recordedAt: "2026-09-13T00:00:01.000Z", disposition: "recorded" as const, safeReason: "none" as const, startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  const receiptBase = { schema: "control-room.resource-bound-native-receipt/v2" as const, dispatch, dispatchDigest: dispatch.payloadDigest, tenantId: common.tenantId, projectId: common.projectId, nodeId: common.nodeId, jobId: common.jobId, attemptId: common.attemptId, ...admission, receipt: receiptBody, startsWork: false as const, grantsExecutionAuthority: false as const, permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  const receiptDigest = nativeDigest("receipt", { resourceAdmission: admission, receipt: receiptBase });
  const receipt = nativeResourceReceiptSchemaV2.parse({ ...receiptBase, receiptDigest, payloadDigest: nativeDigest("receipt-payload", { resourceAdmission: admission, boundary: { ...receiptBase, receiptDigest } }) });
  assert.equal(receipt.receipt.dispatchMessageId, frame.messageId);
  assert.throws(() => nativeResourceSubmissionSchemaV2.parse({ ...submission, resourceAdmissionDigest: digest("other", {}) }));
  assert.throws(() => nativeResourceDispatchSchemaV2.parse({ ...dispatch, dispatchMessageId: "message:other" }));
  assert.throws(() => matchNativeResourceDispatchV2(dispatch, { ...frame, messageId: "message:other" }));
  const proof = { schema: "control-room.current-resource-holder/v2" as const, tenantId: common.tenantId, projectId: common.projectId, jobId: common.jobId, attemptId: common.attemptId, leaseId: common.leaseId, nodeId: common.nodeId, runId: start.runId, admissionId: admission.resourceAdmissionId, resourceAdmissionDigest: admission.resourceAdmissionDigest, startAuthorizationDigest: dispatch.startAuthorizationDigest, admissionVersion: 1, state: "held" as const, checkedAt: common.occurredAt, expiresAt: "2026-09-13T00:00:10.000Z" };
  assert.equal(verifyCurrentResourceHolderProofV2(proof, proof, Date.parse("2026-09-13T00:00:01.000Z")).admissionId, admission.resourceAdmissionId);
  assert.throws(() => verifyCurrentResourceHolderProofV2(proof, { ...proof, runId: "run:other" }, Date.parse("2026-09-13T00:00:01.000Z")));
  assert.throws(() => verifyCurrentResourceHolderProofV2(proof, { ...proof, startAuthorizationDigest: digest("other", {}) }, Date.parse("2026-09-13T00:00:01.000Z")));
});
