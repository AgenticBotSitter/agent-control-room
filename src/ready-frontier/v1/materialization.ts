import { timingSafeEqual } from "node:crypto";
import { DOMAIN_CONTRACT_VERSION, jobRecordSchema, requestRecordSchema, workflowRecordSchema,
  type JobRecord, type RequestRecord, type WorkflowRecord } from "../../domain/v1";
import { actionInboxItemSchemaV1, type ActionInboxItemV1 } from "../../operator-surfaces/v1";
import type { CanonicalStore } from "../../persistence/canonical-store";
import { assertNoSecretMaterial, computeAuthorityDigest, hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { exactReadyFrontierJsonV1, parseExactReadyFrontierV1 } from "./exact";
import { parseReadyFrontierEvaluationV1 } from "./controller";
import { parseReadyFrontierStandingPolicyV1 } from "./standing-policy";
import { readyFrontierMaterializationBuildInputSchemaV1, readyFrontierMaterializationReceiptSchemaV1 } from "./automation-schemas";
import {
  READY_FRONTIER_MATERIALIZATION_RECEIPT_V1,
  type ReadyFrontierMaterializationReceiptV1,
  type ReadyFrontierMaterializationRequestV1,
  type ReadyFrontierStandingPolicyV1,
  type ReadyFrontierStandingProjectPolicyV1,
} from "./automation-types";
import { readyFrontierRiskClassesV1, type ReadyFrontierEvaluationV1, type ReadyFrontierProposalV1 } from "./types";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function same(a: string, b: string): boolean { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function id(prefix: string, material: unknown): string { return `${prefix}:${sha256Digest(material).slice(7, 39)}`; }
function without<T extends Record<string, unknown>>(value: T, field: string): Record<string, unknown> { const copy = { ...value }; delete copy[field]; return copy; }
function risk(value: string): number { return readyFrontierRiskClassesV1.indexOf(value as never); }
function parseServer<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { const parsed = schema.parse(exactReadyFrontierJsonV1(value)); assertNoSecretMaterial(parsed, "ready frontier materialization"); return parsed; }
  catch (error) { if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("invalid_input"); }
}
function receiptTag(key: Uint8Array, receipt: ReadyFrontierMaterializationReceiptV1): string {
  return hmacSha256Tag(key, { schema: receipt.schema, receiptId: receipt.receiptId, tenantId: receipt.tenantId,
    cycleId: receipt.cycleId, proposalId: receipt.proposalId, standingPolicyDigest: receipt.standingPolicyDigest,
    receiptDigest: receipt.receiptDigest });
}
function eligible(proposal: ReadyFrontierProposalV1, policy: ReadyFrontierStandingPolicyV1,
  materializedAt: string): ReadyFrontierStandingProjectPolicyV1 {
  const now = Date.parse(materializedAt), project = policy.projectPolicies.find((item) => item.projectId === proposal.projectId);
  if (policy.state !== "active" || policy.action === "suspend" || policy.action === "revoke") fail("policy_inactive");
  if (now < Date.parse(policy.effectiveAt) || now >= Date.parse(policy.expiresAt)) fail("policy_inactive");
  if (now < Date.parse(proposal.proposedAt) || now >= Date.parse(proposal.expiresAt)
    || now - Date.parse(proposal.proposedAt) > policy.maximumProposalAgeSeconds * 1_000) fail("stale_proposal");
  if (!project || !project.enabled || !project.allowedRouteIds.includes(proposal.routeId)
    || !(project.allowedPlatforms.includes(proposal.platform) || project.allowedPlatforms.includes("any"))
    || !project.allowedCapabilities.includes(proposal.requiredCapability)
    || risk(proposal.risk) > risk(project.maximumRisk)
    || proposal.estimatedCostMicrousd > project.maximumCostMicrousdPerWork) fail("policy_denied");
  return project;
}

function buildMaterialization(value: unknown, evaluationIntegrityKey: Uint8Array,
  policyIntegrityKey: unknown): ReadyFrontierMaterializationReceiptV1 {
  const envelope = parseExactReadyFrontierV1(readyFrontierMaterializationBuildInputSchemaV1, value) as {
    request: ReadyFrontierMaterializationRequestV1; evaluation: ReadyFrontierEvaluationV1; standingPolicy: ReadyFrontierStandingPolicyV1;
  };
  const input = envelope.request;
  let evaluation: ReadyFrontierEvaluationV1, policy: ReadyFrontierStandingPolicyV1;
  try {
    evaluation = parseReadyFrontierEvaluationV1(envelope.evaluation, evaluationIntegrityKey);
    policy = parseReadyFrontierStandingPolicyV1(envelope.standingPolicy, policyIntegrityKey);
  } catch (error) { if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("invalid_input"); }
  if (input.tenantId !== evaluation.tenantId || input.tenantId !== policy.tenantId || input.workspaceId !== policy.workspaceId
    || input.cycleId !== evaluation.cycleId || input.evaluationDigest !== evaluation.evaluationDigest
    || input.sourceDigest !== evaluation.sourceDigest || input.frontierPolicyDigest !== evaluation.policyDigest
    || input.standingPolicyId !== policy.policyId || input.standingPolicyRevision !== policy.revision
    || input.standingPolicyDigest !== policy.policyDigest) fail("scope_mismatch");
  const proposal = evaluation.proposals.find((item) => item.proposalId === input.proposalId);
  if (!proposal || !same(proposal.proposalDigest, input.proposalDigest)) fail("replay_drift");
  eligible(proposal, policy, input.materializedAt);
  if (Date.parse(input.requestedAt) < Date.parse(policy.recordedAt) || Date.parse(input.materializedAt) < Date.parse(input.requestedAt)
    || Date.parse(input.authorityExpiresAt) <= Date.parse(input.materializedAt)
    || Date.parse(input.authorityExpiresAt) > Date.parse(policy.expiresAt)) fail("invalid_input");

  const stableLineage = { tenantId: input.tenantId, proposalId: proposal.proposalId, proposalDigest: proposal.proposalDigest };
  const boundLineage = { ...stableLineage, evaluationDigest: evaluation.evaluationDigest, sourceDigest: evaluation.sourceDigest,
    frontierPolicyDigest: evaluation.policyDigest, standingPolicyDigest: policy.policyDigest };
  const requestId = id("request:frontier", stableLineage), workflowId = id("workflow:frontier", stableLineage);
  const jobId = id("job:frontier", stableLineage), attentionId = id("attention:frontier", stableLineage);
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: input.tenantId, version: 0,
    createdAt: input.materializedAt, updatedAt: input.materializedAt } as const;
  const request = requestRecordSchema.parse({ ...common, kind: "request", id: requestId, projectId: proposal.projectId,
    title: proposal.title, objective: proposal.objective, state: "draft", priority: proposal.priority,
    requestedBy: { actorId: "service:ready-frontier-materializer", actorType: "service" },
    idempotencyKey: `frontier-materialize-${proposal.proposalDigest.slice(7)}` }) as RequestRecord;
  const workflow = workflowRecordSchema.parse({ ...common, kind: "workflow", id: workflowId, requestId,
    projectId: proposal.projectId, definitionVersion: "ready-frontier-work-order/v1",
    definitionDigest: sha256Digest(boundLineage), authorityMode: "control_room_native", state: "proposed", jobIds: [jobId] }) as WorkflowRecord;
  const authority: JobRecord["authority"] = { projectId: proposal.projectId, allowedExecutor: proposal.routeId,
    allowedOperations: ["prepare.repository-work"], credentialRefs: [], filesystemRoots: [], networkPolicy: "none",
    allowedNetworkDestinations: [], effectPolicy: "none", maxRisk: proposal.risk, maxDurationSeconds: 3_600,
    maxConcurrentEffects: 0, maxCostUsd: 0, expiresAt: input.authorityExpiresAt, digest: "sha256:" + "0".repeat(64) };
  authority.digest = computeAuthorityDigest(authority);
  const job = jobRecordSchema.parse({ ...common, kind: "job", id: jobId, workflowId, projectId: proposal.projectId,
    jobType: `frontier.repository-work.${proposal.platform}`, specVersion: "ready-frontier-work-order/v1",
    inputDigest: proposal.proposalDigest, state: "proposed", priority: proposal.priority,
    requiredCapability: proposal.requiredCapability, dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false,
      ambiguousEffectPolicy: "attention" } }) as JobRecord;
  const actionInbox = actionInboxItemSchemaV1.parse({ id: attentionId, tenantId: input.tenantId,
    projectId: proposal.projectId, workItemId: jobId, kind: "review", state: "resolved",
    requestedAction: "Standing policy recorded this item as proposed work", reasonCode: "ready_frontier_materialized_proposed",
    blockedWorkItemIds: [], legalResponses: [{ id: "response:frontier:open", kind: "open_source",
      label: "Open materialization evidence", requiresConfirmation: false, available: true }], evidence: [
      { id: proposal.proposalId, kind: "audit", digest: proposal.proposalDigest, observedAt: proposal.proposedAt },
      { id: policy.policyId, kind: "audit", digest: policy.policyDigest, observedAt: policy.recordedAt },
      { id: evaluation.cycleId, kind: "audit", digest: evaluation.evaluationDigest, observedAt: evaluation.evaluatedAt },
    ], createdAt: input.materializedAt, deliveryState: "not_requested" }) as ActionInboxItemV1;
  const unsigned: Omit<ReadyFrontierMaterializationReceiptV1, "receiptDigest" | "receiptAuthTag"> = {
    schema: READY_FRONTIER_MATERIALIZATION_RECEIPT_V1, receiptId: id("materialization:frontier", boundLineage),
    requestId: input.requestId, tenantId: input.tenantId, workspaceId: input.workspaceId, cycleId: input.cycleId,
    proposalId: proposal.proposalId, proposalDigest: proposal.proposalDigest, intentDigest: proposal.intentDigest,
    evaluationDigest: evaluation.evaluationDigest, sourceDigest: evaluation.sourceDigest, frontierPolicyDigest: evaluation.policyDigest,
    standingPolicyId: policy.policyId, standingPolicyRevision: policy.revision, standingPolicyDigest: policy.policyDigest,
    request, workflow, job, actionInbox, materializedAt: input.materializedAt, state: "materialized_proposed",
    repositorySimulationOnly: true, createsAttempt: false, createsLease: false, createsApproval: false,
    createsSchedule: false, dispatchState: "not_requested", contactsProvider: false, messagesAgent: false,
    mutatesGitHub: false, grantsExternalEffect: false,
  };
  const withDigest = { ...unsigned, receiptDigest: sha256Digest(unsigned), receiptAuthTag: "hmac-sha256:" + "0".repeat(64) };
  const receipt = parseServer(readyFrontierMaterializationReceiptSchemaV1,
    { ...withDigest, receiptAuthTag: receiptTag(evaluationIntegrityKey, withDigest) }) as ReadyFrontierMaterializationReceiptV1;
  assertNoSecretMaterial(receipt, "ready frontier materialization"); return receipt;
}

export function buildReadyFrontierMaterializationV1(value: unknown, evaluationIntegrityKeyValue: unknown,
  policyIntegrityKey: unknown): ReadyFrontierMaterializationReceiptV1 {
  const snapshot = exactHostUint8ArrayV1(evaluationIntegrityKeyValue, 128); if (!snapshot || snapshot.byteLength < 32) fail("integrity_failed");
  const key = snapshot.copy(); try { return buildMaterialization(value, key, policyIntegrityKey); } finally { key.fill(0); }
}

export function parseReadyFrontierMaterializationV1(value: unknown, integrityKeyValue: unknown): ReadyFrontierMaterializationReceiptV1 {
  const snapshot = exactHostUint8ArrayV1(integrityKeyValue, 128); if (!snapshot || snapshot.byteLength < 32) fail("integrity_failed");
  const key = snapshot.copy();
  try {
    const receipt = parseServer(readyFrontierMaterializationReceiptSchemaV1, value) as ReadyFrontierMaterializationReceiptV1;
    const withoutAuth = without(receipt as unknown as Record<string, unknown>, "receiptAuthTag");
    if (!same(receipt.receiptDigest, sha256Digest(without(withoutAuth, "receiptDigest"))) || !same(receipt.receiptAuthTag, receiptTag(key, receipt))
      || receipt.request.tenantId !== receipt.tenantId || receipt.workflow.tenantId !== receipt.tenantId
      || receipt.job.tenantId !== receipt.tenantId || receipt.actionInbox.tenantId !== receipt.tenantId
      || receipt.request.projectId !== receipt.job.projectId || receipt.workflow.projectId !== receipt.job.projectId
      || receipt.actionInbox.projectId !== receipt.job.projectId || receipt.workflow.requestId !== receipt.request.id
      || receipt.job.workflowId !== receipt.workflow.id || receipt.workflow.jobIds.length !== 1
      || receipt.workflow.jobIds[0] !== receipt.job.id || receipt.actionInbox.workItemId !== receipt.job.id
      || receipt.request.state !== "draft" || receipt.workflow.state !== "proposed" || receipt.job.state !== "proposed") fail("digest_mismatch");
    return receipt;
  } finally { key.fill(0); }
}

export async function persistReadyFrontierMaterializationV1(input: { canonicalStore: CanonicalStore;
  receipt: ReadyFrontierMaterializationReceiptV1; integrityKey: unknown }): Promise<{ receipt: ReadyFrontierMaterializationReceiptV1; replayed: boolean }> {
  const receipt = parseReadyFrontierMaterializationV1(input.receipt, input.integrityKey);
  const result = await input.canonicalStore.createReadyFrontierProposedWorkBundleWithActionInbox({ request: receipt.request,
    workflow: receipt.workflow, job: receipt.job, actionInbox: receipt.actionInbox });
  return { receipt, replayed: result.replayed };
}
