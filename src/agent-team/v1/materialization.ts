import { DOMAIN_CONTRACT_VERSION, jobRecordSchema, requestRecordSchema, workflowRecordSchema, type JobRecord, type RequestRecord, type WorkflowRecord } from "../../domain/v1";
import { actionInboxItemSchemaV1, type ActionInboxItemV1 } from "../../operator-surfaces/v1";
import type { CanonicalStore } from "../../persistence/canonical-store";
import { assertNoSecretMaterial, computeAuthorityDigest, sha256Digest } from "../../security";
import { AgentTeamContractErrorV1 } from "./errors";
import { exactAgentTeamJsonV1, parseExactAgentTeamV1 } from "./exact";
import { agentTeamHandoffMaterializationInputSchemaV1, agentTeamHandoffMaterializationReceiptSchemaV1,
  agentTeamHandoffReviewInputSchemaV1, agentTeamHandoffReviewSchemaV1 } from "./materialization-schemas";
import { AGENT_TEAM_HANDOFF_MATERIALIZATION_V1, AGENT_TEAM_HANDOFF_REVIEW_V1,
  type AgentTeamHandoffMaterializationInputV1, type AgentTeamHandoffMaterializationReceiptV1,
  type AgentTeamHandoffReviewInputV1, type AgentTeamHandoffReviewProjectionV1, type AgentTeamHandoffReviewV1 } from "./materialization-types";
import { agentHandoffProposalSchemaV1 } from "./schemas";
import type { AgentHandoffProposalV1 } from "./types";

function fail(code: AgentTeamContractErrorV1["safeCode"]): never { throw new AgentTeamContractErrorV1(code); }
function id(prefix: string, value: unknown): string { return `${prefix}:${sha256Digest(value).slice(7, 39)}`; }
function without<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> { const copy = { ...value }; delete copy[key]; return copy; }

function parseProposal(value: unknown): AgentHandoffProposalV1 {
  const proposal = parseExactAgentTeamV1(agentHandoffProposalSchemaV1, value) as AgentHandoffProposalV1;
  if (sha256Digest(without(proposal as unknown as Record<string, unknown>, "proposalDigest")) !== proposal.proposalDigest) fail("digest_mismatch");
  const expected = sha256Digest({ projectId: proposal.projectId, roomId: proposal.roomId, sourceMessageId: proposal.sourceMessageId,
    targetAgentId: proposal.targetAgentId, title: proposal.title, goal: proposal.goal, routeProfile: proposal.routeProfile, platform: proposal.platform });
  if (expected !== proposal.idempotencyKey) fail("replay_drift");
  return proposal;
}

function parseServer<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { const parsed = schema.parse(exactAgentTeamJsonV1(value)); assertNoSecretMaterial(parsed, "agent team materialization"); return parsed; }
  catch (error) { if (error instanceof AgentTeamContractErrorV1) throw error; fail("invalid_input"); }
}

export function buildAgentTeamHandoffReviewV1(value: unknown): AgentTeamHandoffReviewV1 {
  const input = parseExactAgentTeamV1(agentTeamHandoffReviewInputSchemaV1, value) as AgentTeamHandoffReviewInputV1;
  const proposal = parseProposal(input.proposal);
  if (proposal.projectId !== input.projectId) fail("scope_mismatch");
  const unsigned: Omit<AgentTeamHandoffReviewV1, "reviewDigest"> = {
    contractVersion: AGENT_TEAM_HANDOFF_REVIEW_V1,
    tenantId: input.tenantId, workspaceId: input.workspaceId, projectId: input.projectId, reviewId: input.reviewId,
    proposalId: proposal.proposalId, proposalDigest: proposal.proposalDigest, proposalIdempotencyKey: proposal.idempotencyKey,
    roomId: proposal.roomId, sourceMessageId: proposal.sourceMessageId, targetAgentId: proposal.targetAgentId,
    decision: input.decision, safeReasonCode: input.safeReasonCode, reviewerActorDigest: input.reviewerActorDigest,
    ownerAuthenticationEvidenceDigest: input.ownerAuthenticationEvidenceDigest, reviewedAt: input.reviewedAt,
    isOwnerReview: true, grantsApproval: false, grantsDispatchAuthority: false, grantsLeaseAuthority: false, grantsExecutionAuthority: false,
  };
  return parseExactAgentTeamV1(agentTeamHandoffReviewSchemaV1, { ...unsigned, reviewDigest: sha256Digest(unsigned) }) as AgentTeamHandoffReviewV1;
}

export function parseAgentTeamHandoffReviewV1(value: unknown): AgentTeamHandoffReviewV1 {
  const review = parseExactAgentTeamV1(agentTeamHandoffReviewSchemaV1, value) as AgentTeamHandoffReviewV1;
  if (sha256Digest(without(review as unknown as Record<string, unknown>, "reviewDigest")) !== review.reviewDigest) fail("digest_mismatch");
  return review;
}

export function buildAgentTeamHandoffMaterializationV1(value: unknown): AgentTeamHandoffMaterializationReceiptV1 {
  const input = parseServer(agentTeamHandoffMaterializationInputSchemaV1, value) as AgentTeamHandoffMaterializationInputV1;
  const proposal = parseProposal(input.proposal), review = parseAgentTeamHandoffReviewV1(input.acceptedReview);
  if (proposal.projectId !== input.projectId || review.tenantId !== input.tenantId || review.workspaceId !== input.workspaceId
    || review.projectId !== input.projectId) fail("scope_mismatch");
  if (review.decision !== "accepted") fail("invalid_input");
  if (review.proposalId !== proposal.proposalId || review.proposalDigest !== proposal.proposalDigest
    || review.proposalIdempotencyKey !== proposal.idempotencyKey || review.roomId !== proposal.roomId
    || review.sourceMessageId !== proposal.sourceMessageId || review.targetAgentId !== proposal.targetAgentId) fail("replay_drift");
  if (Date.parse(input.materializedAt) < Date.parse(review.reviewedAt) || Date.parse(input.authorityExpiresAt) <= Date.parse(input.materializedAt)) fail("invalid_input");
  const lineage = { proposalDigest: proposal.proposalDigest, acceptedReviewDigest: review.reviewDigest };
  const requestId = id("request:team", lineage), workflowId = id("workflow:team", lineage), jobId = id("job:team", lineage);
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: input.tenantId, version: 0,
    createdAt: input.materializedAt, updatedAt: input.materializedAt } as const;
  const request = requestRecordSchema.parse({ ...common, kind: "request", id: requestId, projectId: input.projectId,
    title: proposal.title, objective: proposal.goal, state: "draft", priority: 50,
    requestedBy: { actorId: "service:agent-team-materializer", actorType: "service" },
    idempotencyKey: `team-handoff-${proposal.idempotencyKey.slice(7)}` }) as RequestRecord;
  const workflow = workflowRecordSchema.parse({ ...common, kind: "workflow", id: workflowId, requestId, projectId: input.projectId,
    definitionVersion: "agent-team-handoff/v1", definitionDigest: sha256Digest({ ...lineage, routeProfile: proposal.routeProfile, platform: proposal.platform }),
    authorityMode: "control_room_native", state: "proposed", jobIds: [jobId] }) as WorkflowRecord;
  const authority: JobRecord["authority"] = { projectId: input.projectId, allowedExecutor: proposal.routeProfile,
    allowedOperations: ["prepare.agent-handoff"], credentialRefs: [], filesystemRoots: [], networkPolicy: "none",
    allowedNetworkDestinations: [], effectPolicy: "none", maxRisk: "low", maxDurationSeconds: 3_600,
    maxConcurrentEffects: 0, maxCostUsd: 0, expiresAt: input.authorityExpiresAt, digest: "sha256:" + "0".repeat(64) };
  authority.digest = computeAuthorityDigest(authority);
  const job = jobRecordSchema.parse({ ...common, kind: "job", id: jobId, workflowId, projectId: input.projectId,
    jobType: `agent-handoff.${proposal.platform}`, specVersion: "agent-team-handoff/v1", inputDigest: proposal.proposalDigest,
    state: "proposed", priority: 50, requiredCapability: `agent.team.handoff.${proposal.platform}`, dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } }) as JobRecord;
  const actionInbox = actionInboxItemSchemaV1.parse({ id: id("attention:team", lineage), tenantId: input.tenantId,
    projectId: input.projectId, workItemId: jobId, kind: "review", state: "resolved",
    requestedAction: "Reviewed handoff recorded as proposed work", reasonCode: "agent_team_handoff_materialized_proposed",
    blockedWorkItemIds: [], legalResponses: [{ id: "response:team:open", kind: "open_source", label: "Open handoff evidence", requiresConfirmation: false, available: true }],
    evidence: [{ id: proposal.proposalId, kind: "audit", digest: proposal.proposalDigest, observedAt: input.materializedAt },
      { id: review.reviewId, kind: "audit", digest: review.reviewDigest, observedAt: review.reviewedAt }],
    createdAt: input.materializedAt, deliveryState: "not_requested" }) as ActionInboxItemV1;
  const unsigned: Omit<AgentTeamHandoffMaterializationReceiptV1, "receiptDigest"> = {
    contractVersion: AGENT_TEAM_HANDOFF_MATERIALIZATION_V1, tenantId: input.tenantId, workspaceId: input.workspaceId,
    projectId: input.projectId, receiptId: id("materialization:team", lineage), proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest, acceptedReviewId: review.reviewId, acceptedReviewDigest: review.reviewDigest,
    roomId: proposal.roomId, sourceMessageId: proposal.sourceMessageId, targetAgentId: proposal.targetAgentId,
    request, workflow, job, actionInbox, materializedAt: input.materializedAt, state: "materialized_proposed",
    createsAttempt: false, createsLease: false, dispatchState: "not_requested", grantsApproval: false,
    grantsNetworkAuthority: false, grantsExecutionAuthority: false,
  };
  return parseServer(agentTeamHandoffMaterializationReceiptSchemaV1, { ...unsigned, receiptDigest: sha256Digest(unsigned) }) as AgentTeamHandoffMaterializationReceiptV1;
}

export function parseAgentTeamHandoffMaterializationV1(value: unknown): AgentTeamHandoffMaterializationReceiptV1 {
  const receipt = parseServer(agentTeamHandoffMaterializationReceiptSchemaV1, value) as AgentTeamHandoffMaterializationReceiptV1;
  if (sha256Digest(without(receipt as unknown as Record<string, unknown>, "receiptDigest")) !== receipt.receiptDigest
    || receipt.request.tenantId !== receipt.tenantId || receipt.workflow.tenantId !== receipt.tenantId || receipt.job.tenantId !== receipt.tenantId
    || receipt.request.projectId !== receipt.projectId || receipt.workflow.projectId !== receipt.projectId || receipt.job.projectId !== receipt.projectId
    || receipt.workflow.requestId !== receipt.request.id || receipt.job.workflowId !== receipt.workflow.id
    || receipt.workflow.jobIds.length !== 1 || receipt.workflow.jobIds[0] !== receipt.job.id
    || receipt.actionInbox.workItemId !== receipt.job.id || receipt.actionInbox.tenantId !== receipt.tenantId
    || receipt.actionInbox.projectId !== receipt.projectId || receipt.request.state !== "draft"
    || receipt.workflow.state !== "proposed" || receipt.job.state !== "proposed") fail("digest_mismatch");
  return receipt;
}

export function projectAgentTeamHandoffReviewV1(input: { tenantId: string; projectId: string; proposal: AgentHandoffProposalV1;
  review?: AgentTeamHandoffReviewV1; receipt?: AgentTeamHandoffMaterializationReceiptV1 }): AgentTeamHandoffReviewProjectionV1 {
  const proposal = parseProposal(input.proposal), review = input.review ? parseAgentTeamHandoffReviewV1(input.review) : undefined;
  const receipt = input.receipt ? parseAgentTeamHandoffMaterializationV1(input.receipt) : undefined;
  if (proposal.projectId !== input.projectId || review && (review.tenantId !== input.tenantId || review.projectId !== input.projectId)
    || receipt && (receipt.tenantId !== input.tenantId || receipt.projectId !== input.projectId)) fail("scope_mismatch");
  if (review && (review.proposalId !== proposal.proposalId || review.proposalDigest !== proposal.proposalDigest
    || review.proposalIdempotencyKey !== proposal.idempotencyKey || review.roomId !== proposal.roomId
    || review.sourceMessageId !== proposal.sourceMessageId || review.targetAgentId !== proposal.targetAgentId)) fail("replay_drift");
  if (receipt && (receipt.proposalId !== proposal.proposalId || receipt.proposalDigest !== proposal.proposalDigest
    || receipt.roomId !== proposal.roomId || receipt.sourceMessageId !== proposal.sourceMessageId
    || receipt.targetAgentId !== proposal.targetAgentId || review && (receipt.acceptedReviewId !== review.reviewId
      || receipt.acceptedReviewDigest !== review.reviewDigest))) fail("replay_drift");
  const reviewState = receipt ? "materialized_proposed" : review?.decision === "rejected" ? "rejected"
    : review?.decision === "withdrawn" ? "withdrawn"
    : review?.decision === "accepted" ? "accepted_pending_materialization" : "awaiting_owner";
  const open = reviewState === "awaiting_owner" || reviewState === "accepted_pending_materialization";
  const actionInbox = receipt?.actionInbox ?? actionInboxItemSchemaV1.parse({ id: id("attention:team", { proposalDigest: proposal.proposalDigest }),
    tenantId: input.tenantId, projectId: input.projectId, workItemId: proposal.proposalId, kind: "review", state: open ? "open" : "resolved",
    requestedAction: reviewState === "awaiting_owner" ? "Review the exact saved handoff draft"
      : reviewState === "accepted_pending_materialization" ? "Reconcile accepted handoff materialization"
        : reviewState === "withdrawn" ? "Handoff draft was withdrawn" : "Handoff draft was declined",
    reasonCode: reviewState === "awaiting_owner" ? "agent_team_handoff_owner_review_required"
      : reviewState === "accepted_pending_materialization" ? "agent_team_handoff_materialization_pending"
        : reviewState === "withdrawn" ? "agent_team_handoff_withdrawn" : "agent_team_handoff_rejected",
    blockedWorkItemIds: open ? [proposal.proposalId] : [], legalResponses: reviewState === "awaiting_owner" ? [
      { id: "response:team:accept", kind: "record_decision", label: "Accept exact handoff", requiresConfirmation: true, available: true },
      { id: "response:team:decline", kind: "decline", label: "Decline handoff", requiresConfirmation: true, available: true },
      { id: "response:team:withdraw", kind: "decline", label: "Withdraw handoff draft", requiresConfirmation: true, available: true },
    ] : [{ id: "response:team:open", kind: "open_source", label: "Open handoff evidence", requiresConfirmation: false, available: true }],
    evidence: [{ id: proposal.proposalId, kind: "audit", digest: proposal.proposalDigest }, ...(review ? [{ id: review.reviewId, kind: "audit" as const, digest: review.reviewDigest, observedAt: review.reviewedAt }] : [])],
    createdAt: review?.reviewedAt ?? "2026-08-30T12:22:00.000Z", deliveryState: "not_requested" }) as ActionInboxItemV1;
  return { actionInbox, proposalId: proposal.proposalId, proposalDigest: proposal.proposalDigest, reviewState,
    createsWorkItem: Boolean(receipt), dispatchState: "not_requested", grantsAuthority: false,
    ...(receipt ? { materializedWork: { requestId: receipt.request.id, workflowId: receipt.workflow.id, jobId: receipt.job.id, state: "proposed" as const } } : {}) };
}

export async function persistAgentTeamHandoffMaterializationV1(input: { canonicalStore: CanonicalStore;
  receipt: AgentTeamHandoffMaterializationReceiptV1 }): Promise<{ receipt: AgentTeamHandoffMaterializationReceiptV1; replayed: boolean }> {
  const receipt = parseAgentTeamHandoffMaterializationV1(input.receipt);
  const result = await input.canonicalStore.createProposedWorkBundleWithActionInbox({ request: receipt.request, workflow: receipt.workflow,
    job: receipt.job, actionInbox: receipt.actionInbox });
  return { receipt, replayed: result.replayed };
}
