import { DOMAIN_CONTRACT_VERSION, jobRecordSchema, requestRecordSchema, workflowRecordSchema, type JobRecord, type RequestRecord, type WorkflowRecord } from "../../../domain/v1";
import { actionInboxItemSchemaV1, type ActionInboxItemV1 } from "../../../operator-surfaces/v1";
import type { CanonicalStore } from "../../../persistence/canonical-store";
import { assertNoSecretMaterial, computeAuthorityDigest, sha256Digest } from "../../../security";
import { ProjectWorkspaceContractErrorV1, exactProjectWorkspaceJsonV1, parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import {
  absNewsMaterializationInputSchemaV1,
  absNewsMaterializationReceiptSchemaV1,
  absNewsProposalReviewInputSchemaV1,
  absNewsProposalReviewSchemaV1,
} from "./schemas";
import { parseAbsNewsWorkOrderProposalV1 } from "./proposal";
import {
  ABS_NEWS_CONTRACT_V1,
  type AbsNewsMaterializationProjectionV1,
  type AbsNewsMaterializationReceiptV1,
  type AbsNewsProposalReviewV1,
  type AbsNewsWorkOrderProposalV1,
} from "./types";

function withoutDigest<T extends Record<string, unknown>>(value: T, field: keyof T): Omit<T, keyof T> & Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function id(prefix: string, material: unknown): string {
  return `${prefix}:${sha256Digest(material).slice(7, 39)}`;
}

function parseServerRecord<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    const parsed = schema.parse(exactProjectWorkspaceJsonV1(value));
    assertNoSecretMaterial(parsed, "ABS server record");
    return parsed;
  } catch (error) {
    if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
}

export function buildAbsNewsProposalReviewV1(inputValue: unknown): AbsNewsProposalReviewV1 {
  const input = parseExactProjectWorkspaceV1(absNewsProposalReviewInputSchemaV1, inputValue);
  const proposal = parseAbsNewsWorkOrderProposalV1(input.proposal);
  const unsigned: Omit<AbsNewsProposalReviewV1, "reviewDigest"> = {
    contractVersion: ABS_NEWS_CONTRACT_V1,
    reviewId: input.reviewId,
    tenantId: proposal.tenantId,
    workspaceId: proposal.workspaceId,
    projectId: proposal.projectId,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    storyId: proposal.storyId,
    storyDigest: proposal.storyDigest,
    actionCatalogDigest: proposal.actionCatalogDigest,
    decision: input.decision,
    safeReasonCode: input.safeReasonCode,
    reviewerActorDigest: input.reviewerActorDigest,
    reviewedAt: input.reviewedAt,
    grantsApproval: false,
    grantsDispatchAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactProjectWorkspaceV1(absNewsProposalReviewSchemaV1, { ...unsigned, reviewDigest: sha256Digest(unsigned) }) as AbsNewsProposalReviewV1;
}

export function parseAbsNewsProposalReviewV1(value: unknown): AbsNewsProposalReviewV1 {
  const review = parseExactProjectWorkspaceV1(absNewsProposalReviewSchemaV1, value) as AbsNewsProposalReviewV1;
  if (sha256Digest(withoutDigest(review as unknown as Record<string, unknown>, "reviewDigest")) !== review.reviewDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  return review;
}

export function buildAbsNewsMaterializationReceiptV1(inputValue: unknown): AbsNewsMaterializationReceiptV1 {
  const input = parseExactProjectWorkspaceV1(absNewsMaterializationInputSchemaV1, inputValue);
  const proposal = parseAbsNewsWorkOrderProposalV1(input.proposal);
  const review = parseAbsNewsProposalReviewV1(input.acceptedReview);
  if (review.decision !== "accepted") throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  if (review.proposalId !== proposal.proposalId || review.proposalDigest !== proposal.proposalDigest
    || review.storyId !== proposal.storyId || review.storyDigest !== proposal.storyDigest
    || review.actionCatalogDigest !== proposal.actionCatalogDigest || review.tenantId !== proposal.tenantId
    || review.workspaceId !== proposal.workspaceId || review.projectId !== proposal.projectId) {
    throw new ProjectWorkspaceContractErrorV1("replay_drift");
  }
  if (Date.parse(input.materializedAt) < Date.parse(review.reviewedAt)
    || Date.parse(input.authorityExpiresAt) <= Date.parse(input.materializedAt)) {
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
  const lineage = { proposalDigest: proposal.proposalDigest, acceptedReviewDigest: review.reviewDigest };
  const requestId = id("request:abs", lineage);
  const workflowId = id("workflow:abs", lineage);
  const jobId = id("job:abs", lineage);
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: proposal.tenantId, version: 0, createdAt: input.materializedAt, updatedAt: input.materializedAt } as const;
  const request = requestRecordSchema.parse({
    ...common, kind: "request", id: requestId, projectId: proposal.projectId, title: proposal.requestedTitle,
    objective: proposal.goal, state: "draft", priority: 50,
    requestedBy: { actorId: "service:abs-materializer", actorType: "service" },
    idempotencyKey: `abs-materialize-${proposal.proposalIdempotencyKey.slice(7)}`,
  }) as RequestRecord;
  const workflow = workflowRecordSchema.parse({
    ...common, kind: "workflow", id: workflowId, requestId, projectId: proposal.projectId,
    definitionVersion: "abs-news-work-order/v1", definitionDigest: sha256Digest({ proposalDigest: proposal.proposalDigest, reviewDigest: review.reviewDigest, routeProfileId: proposal.routeProfileId }),
    authorityMode: "control_room_native", state: "proposed", jobIds: [jobId],
  }) as WorkflowRecord;
  const authority: JobRecord["authority"] = {
    projectId: proposal.projectId, allowedExecutor: proposal.routeProfileId,
    allowedOperations: [`prepare.${proposal.deliverableKind}`], credentialRefs: [], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none", maxRisk: proposal.risk,
    maxDurationSeconds: 3_600, maxConcurrentEffects: 0, maxCostUsd: 0, expiresAt: input.authorityExpiresAt,
    digest: "sha256:" + "0".repeat(64),
  };
  authority.digest = computeAuthorityDigest(authority);
  const job = jobRecordSchema.parse({
    ...common, kind: "job", id: jobId, workflowId, projectId: proposal.projectId,
    jobType: `abs.${proposal.deliverableKind}`, specVersion: "abs-news-work-order/v1", inputDigest: proposal.proposalDigest,
    state: "proposed", priority: 50, requiredCapability: proposal.requiredCapability, dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" },
  }) as JobRecord;
  const unsigned: Omit<AbsNewsMaterializationReceiptV1, "receiptDigest"> = {
    contractVersion: ABS_NEWS_CONTRACT_V1,
    receiptId: id("materialization:abs", lineage), tenantId: proposal.tenantId, workspaceId: proposal.workspaceId,
    projectId: proposal.projectId, proposalId: proposal.proposalId, proposalDigest: proposal.proposalDigest,
    acceptedReviewId: review.reviewId, acceptedReviewDigest: review.reviewDigest, request, workflow, job,
    materializedAt: input.materializedAt, state: "materialized_proposed", createsAttempt: false, createsLease: false,
    dispatchState: "not_requested", grantsApproval: false, grantsNetworkAuthority: false, grantsExecutionAuthority: false,
  };
  return parseServerRecord(absNewsMaterializationReceiptSchemaV1, { ...unsigned, receiptDigest: sha256Digest(unsigned) }) as AbsNewsMaterializationReceiptV1;
}

export function parseAbsNewsMaterializationReceiptV1(value: unknown): AbsNewsMaterializationReceiptV1 {
  const receipt = parseServerRecord(absNewsMaterializationReceiptSchemaV1, value) as AbsNewsMaterializationReceiptV1;
  if (sha256Digest(withoutDigest(receipt as unknown as Record<string, unknown>, "receiptDigest")) !== receipt.receiptDigest
    || receipt.request.tenantId !== receipt.tenantId || receipt.workflow.tenantId !== receipt.tenantId || receipt.job.tenantId !== receipt.tenantId
    || receipt.request.projectId !== receipt.projectId || receipt.workflow.projectId !== receipt.projectId || receipt.job.projectId !== receipt.projectId
    || receipt.workflow.requestId !== receipt.request.id || receipt.job.workflowId !== receipt.workflow.id
    || receipt.workflow.jobIds.length !== 1 || receipt.workflow.jobIds[0] !== receipt.job.id
    || receipt.request.state !== "draft" || receipt.workflow.state !== "proposed" || receipt.job.state !== "proposed") {
    throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  }
  return receipt;
}

export function projectAbsNewsMaterializationV1(input: {
  proposal: AbsNewsWorkOrderProposalV1;
  review?: AbsNewsProposalReviewV1;
  receipt?: AbsNewsMaterializationReceiptV1;
}): AbsNewsMaterializationProjectionV1 {
  const proposal = parseAbsNewsWorkOrderProposalV1(input.proposal);
  const review = input.review ? parseAbsNewsProposalReviewV1(input.review) : undefined;
  const receipt = input.receipt ? parseAbsNewsMaterializationReceiptV1(input.receipt) : undefined;
  const open = !review;
  const rejected = review?.decision === "rejected";
  const actionInbox: ActionInboxItemV1 = {
    id: `attention:abs:${proposal.proposalId}`, tenantId: proposal.tenantId, projectId: proposal.projectId,
    workItemId: receipt?.job.id ?? proposal.proposalId, kind: "review", state: open ? "open" : "resolved",
    requestedAction: open ? "Review the exact ABS work proposal" : rejected ? "Proposal was declined" : "Proposal review recorded",
    reasonCode: open ? "abs_proposal_owner_review_required" : rejected ? "abs_proposal_rejected" : "abs_proposal_accepted",
    blockedWorkItemIds: receipt ? [] : [proposal.proposalId],
    legalResponses: open ? [
      { id: "response:abs:accept", kind: "record_decision", label: "Accept exact proposal", requiresConfirmation: true, available: true },
      { id: "response:abs:decline", kind: "decline", label: "Decline proposal", requiresConfirmation: true, available: true },
    ] : [{ id: "response:abs:recorded", kind: "open_source", label: "Open proposal evidence", requiresConfirmation: false, available: true }],
    evidence: [{ id: proposal.proposalId, kind: "audit", digest: proposal.proposalDigest, observedAt: proposal.requestedAt }, ...(review ? [{ id: review.reviewId, kind: "audit" as const, digest: review.reviewDigest, observedAt: review.reviewedAt }] : [])],
    createdAt: proposal.requestedAt, deliveryState: "not_requested",
  };
  const validatedInbox = actionInboxItemSchemaV1.parse(actionInbox) as ActionInboxItemV1;
  return { actionInbox: validatedInbox, ...(receipt ? { materializedWork: { requestId: receipt.request.id, workflowId: receipt.workflow.id, jobId: receipt.job.id, state: "proposed" as const } } : {}) };
}

export async function persistAbsNewsMaterializationV1(input: { canonicalStore: CanonicalStore; receipt: AbsNewsMaterializationReceiptV1 }): Promise<{ receipt: AbsNewsMaterializationReceiptV1; replayed: boolean }> {
  const receipt = parseAbsNewsMaterializationReceiptV1(input.receipt);
  const result = await input.canonicalStore.createProposedWorkBundle({ request: receipt.request, workflow: receipt.workflow, job: receipt.job });
  return { receipt, replayed: result.replayed };
}
