import { timingSafeEqual } from "node:crypto";
import { jobRecordSchema, type JobRecord } from "../../domain/v1";
import { chooseAllocationV1 } from "../../scheduler/v1";
import { assertAuthorityDigest, assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { parseReadyFrontierMaterializationV1 } from "./materialization";
import { parseReadyFrontierStandingPolicyV1 } from "./standing-policy";
import { parseReadyFrontierReadyPolicyV1 } from "./ready-policy";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { exactReadyFrontierJsonV1 } from "./exact";
import { parseReadyFrontierEvaluationV1 } from "./controller";
import { readyFrontierPromotionBuildInputSchemaV1, readyFrontierPromotionReceiptSchemaV1 } from "./ready-policy-schemas";
import { readyFrontierTimeSchemaV1 } from "./schemas";
import {
  READY_FRONTIER_HANDOFF_PACKET_V1,
  READY_FRONTIER_PROMOTION_RECEIPT_V1,
  type ReadyFrontierHandoffPacketV1,
  type ReadyFrontierPromotionBuildInputV1,
  type ReadyFrontierPromotionReceiptV1,
  type ReadyFrontierReadyPolicyV1,
  type ReadyFrontierReadyProjectPolicyV1,
  type ReadyFrontierSchedulerDecisionV1,
} from "./ready-policy-types";
import { readyFrontierRiskClassesV1, type ReadyFrontierProposalV1 } from "./types";
import type { ReadyFrontierStandingPolicyV1 } from "./automation-types";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right);
}
function id(prefix: string, material: unknown): string { return `${prefix}:${sha256Digest(material).slice(7, 39)}`; }
function without(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const copy = { ...value }; for (const field of fields) delete copy[field]; return copy;
}
function risk(value: string): number { return readyFrontierRiskClassesV1.indexOf(value as never); }
function parseServer<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    const parsed = schema.parse(exactReadyFrontierJsonV1(value));
    assertNoSecretMaterial(parsed, "ready frontier promotion"); return parsed;
  } catch (error) {
    if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("invalid_input");
  }
}
function packetTag(key: Uint8Array, packet: ReadyFrontierHandoffPacketV1): string {
  return hmacSha256Tag(key, { schema: packet.schema, handoffId: packet.handoffId, tenantId: packet.tenantId,
    jobId: packet.jobId, materializationReceiptDigest: packet.materializationReceiptDigest,
    readyPolicyDigest: packet.readyPolicyDigest, schedulerDecisionDigest: packet.schedulerDecisionDigest,
    packetDigest: packet.packetDigest });
}
function receiptTag(key: Uint8Array, receipt: ReadyFrontierPromotionReceiptV1): string {
  return hmacSha256Tag(key, { schema: receipt.schema, receiptId: receipt.receiptId, tenantId: receipt.tenantId,
    jobId: receipt.readyJob.id, materializationReceiptDigest: receipt.materializationReceiptDigest,
    readyPolicyDigest: receipt.readyPolicyDigest, handoffPacketDigest: receipt.handoff.packetDigest,
    receiptDigest: receipt.receiptDigest });
}
function eligible(proposal: ReadyFrontierProposalV1, standing: ReadyFrontierStandingPolicyV1,
  ready: ReadyFrontierReadyPolicyV1, promotedAt: string, trustedNow: string): ReadyFrontierReadyProjectPolicyV1 {
  const promoted = Date.parse(promotedAt), now = Date.parse(trustedNow);
  if (promoted > now || now - promoted > 5_000) fail("stale_proposal");
  if (standing.state !== "active" || ready.state !== "active"
    || now < Date.parse(standing.effectiveAt) || now >= Date.parse(standing.expiresAt)
    || now < Date.parse(ready.effectiveAt) || now >= Date.parse(ready.expiresAt)) fail("policy_inactive");
  if (!standing.requiresSeparateReadyReview || standing.permitsReadyTransition || standing.permitsScheduling
    || ready.parentStandingPolicyId !== standing.policyId || ready.parentStandingPolicyRevision !== standing.revision
    || ready.parentStandingPolicyDigest !== standing.policyDigest || !ready.repositoryReviewFixtureAccepted
    || ready.productionOwnerAuthenticationVerified || ready.productionIndependentReviewVerified) fail("policy_denied");
  if (now < Date.parse(proposal.proposedAt) || now >= Date.parse(proposal.expiresAt)) fail("stale_proposal");
  const standingProject = standing.projectPolicies.find((item) => item.projectId === proposal.projectId);
  const readyProject = ready.projectPolicies.find((item) => item.projectId === proposal.projectId);
  if (!standingProject || !standingProject.enabled || !readyProject || !readyProject.enabled
    || !standingProject.allowedRouteIds.includes(proposal.routeId) || !readyProject.allowedRouteIds.includes(proposal.routeId)
    || !(standingProject.allowedPlatforms.includes(proposal.platform) || standingProject.allowedPlatforms.includes("any"))
    || !(readyProject.allowedPlatforms.includes(proposal.platform) || readyProject.allowedPlatforms.includes("any"))
    || !standingProject.allowedCapabilities.includes(proposal.requiredCapability)
    || !readyProject.allowedCapabilities.includes(proposal.requiredCapability)
    || risk(proposal.risk) > risk(standingProject.maximumRisk) || risk(proposal.risk) > risk(readyProject.maximumRisk)
    || proposal.estimatedCostMicrousd > standingProject.maximumCostMicrousdPerWork
    || proposal.estimatedCostMicrousd > readyProject.maximumCostMicrousdPerWork) fail("policy_denied");
  return readyProject;
}

function buildPromotion(value: unknown, evaluationKey: Uint8Array, standingPolicyKey: unknown,
  readyPolicyKey: unknown, evaluationValue: unknown, standingPolicyValue: unknown,
  readyPolicyValue: unknown, trustedNowValue?: unknown): ReadyFrontierPromotionReceiptV1 {
  const envelope = parseServer(readyFrontierPromotionBuildInputSchemaV1, value) as ReadyFrontierPromotionBuildInputV1;
  const input = envelope.request;
  const trustedNow = trustedNowValue === undefined ? input.promotedAt : parseServer(readyFrontierTimeSchemaV1, trustedNowValue);
  const materialization = parseReadyFrontierMaterializationV1(envelope.materializationReceipt, evaluationKey);
  const evaluation = parseReadyFrontierEvaluationV1(evaluationValue, evaluationKey);
  const standing = parseReadyFrontierStandingPolicyV1(standingPolicyValue, standingPolicyKey);
  const ready = parseReadyFrontierReadyPolicyV1(readyPolicyValue, readyPolicyKey);
  if (input.tenantId !== materialization.tenantId || input.tenantId !== evaluation.tenantId
    || input.tenantId !== standing.tenantId || input.tenantId !== ready.tenantId
    || input.workspaceId !== materialization.workspaceId || input.workspaceId !== standing.workspaceId
    || input.workspaceId !== ready.workspaceId || input.materializationReceiptId !== materialization.receiptId
    || input.materializationReceiptDigest !== materialization.receiptDigest || input.jobId !== materialization.job.id
    || input.standingPolicyId !== standing.policyId || input.standingPolicyRevision !== standing.revision
    || input.standingPolicyDigest !== standing.policyDigest || materialization.standingPolicyId !== standing.policyId
    || materialization.standingPolicyRevision !== standing.revision || materialization.standingPolicyDigest !== standing.policyDigest
    || input.readyPolicyId !== ready.policyId || input.readyPolicyRevision !== ready.revision
    || input.readyPolicyDigest !== ready.policyDigest || materialization.cycleId !== evaluation.cycleId
    || materialization.evaluationDigest !== evaluation.evaluationDigest || materialization.sourceDigest !== evaluation.sourceDigest) fail("scope_mismatch");
  const proposal = evaluation.proposals.find((item) => item.proposalId === materialization.proposalId);
  if (!proposal || proposal.proposalDigest !== materialization.proposalDigest
    || materialization.job.inputDigest !== proposal.proposalDigest) fail("replay_drift");
  const projectPolicy = eligible(proposal, standing, ready, input.promotedAt, trustedNow);
  if (Date.parse(trustedNow) - Date.parse(materialization.materializedAt)
    > ready.maximumMaterializationAgeSeconds * 1_000) fail("stale_proposal");
  if (materialization.state !== "materialized_proposed" || materialization.job.state !== "proposed"
    || materialization.job.version !== 0 || input.requestedAt < materialization.materializedAt
    || input.promotedAt < input.requestedAt || input.requestedAt > trustedNow
    || Date.parse(input.reservationExpiresAt) <= Date.parse(input.promotedAt)
    || Date.parse(input.reservationExpiresAt) <= Date.parse(trustedNow)
    || Date.parse(input.reservationExpiresAt) > Date.parse(ready.expiresAt)
    || Date.parse(input.reservationExpiresAt) > Date.parse(standing.expiresAt)
    || Date.parse(input.reservationExpiresAt) > Date.parse(materialization.job.authority.expiresAt)
    || Date.parse(input.reservationExpiresAt) - Date.parse(input.promotedAt) !== projectPolicy.reservationTtlSeconds * 1_000) fail("invalid_input");
  assertAuthorityDigest(materialization.job.authority);
  if (materialization.job.authority.allowedExecutor !== proposal.routeId
    || materialization.job.requiredCapability !== proposal.requiredCapability
    || materialization.job.authority.effectPolicy !== "none" || materialization.job.authority.networkPolicy !== "none"
    || materialization.job.authority.credentialRefs.length !== 0 || materialization.job.authority.filesystemRoots.length !== 0
    || materialization.job.authority.allowedNetworkDestinations.length !== 0
    || materialization.job.authority.maxConcurrentEffects !== 0 || materialization.job.authority.maxCostUsd !== 0) fail("policy_denied");

  const allocation = chooseAllocationV1([{ projectId: proposal.projectId, workItemId: materialization.job.id,
    routeId: proposal.routeId, targetShare: 100, recentShareUsed: 0, priority: proposal.priority,
    queueAgeMinutes: Math.max(0, (Date.parse(input.promotedAt) - Date.parse(materialization.materializedAt)) / 60_000),
    downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: proposal.estimatedCostMicrousd / 1_000_000 }]);
  if (!allocation.selected || allocation.selected.projectId !== proposal.projectId
    || allocation.selected.workItemId !== materialization.job.id || allocation.selected.routeId !== proposal.routeId
    || allocation.rejected.length !== 0 || allocation.score === undefined) fail("policy_denied");
  const decisionWithoutDigest = { selectedProjectId: proposal.projectId, selectedJobId: materialization.job.id,
    selectedRouteId: proposal.routeId, resourceKey: projectPolicy.resourceKey,
    reservationUnits: projectPolicy.reservationUnits, resourceCapacityUnits: projectPolicy.resourceCapacityUnits,
    score: allocation.score, reasonCodes: ["hard_gates_passed", "deterministic_allocation_selected", "database_capacity_reserved"] as
      ["hard_gates_passed", "deterministic_allocation_selected", "database_capacity_reserved"] };
  const schedulerDecision: ReadyFrontierSchedulerDecisionV1 = { ...decisionWithoutDigest,
    decisionDigest: sha256Digest(decisionWithoutDigest) };
  const stable = { tenantId: input.tenantId, jobId: materialization.job.id,
    materializationReceiptDigest: materialization.receiptDigest };
  const bound = { ...stable, standingPolicyDigest: standing.policyDigest, readyPolicyDigest: ready.policyDigest };
  const reservationId = id("reservation:frontier", bound), handoffId = id("outbox:frontier-handoff", bound);
  const reservation = { reservationId, tenantId: input.tenantId, projectId: proposal.projectId,
    jobId: materialization.job.id, routeId: proposal.routeId, resourceKey: projectPolicy.resourceKey,
    units: projectPolicy.reservationUnits, capacityUnits: projectPolicy.resourceCapacityUnits,
    decisionDigest: schedulerDecision.decisionDigest, state: "active" as const,
    acquiredAt: input.promotedAt, expiresAt: input.reservationExpiresAt };
  const readyJob = jobRecordSchema.parse({ ...materialization.job, state: "ready", version: 1,
    updatedAt: input.promotedAt }) as JobRecord;
  const packetUnsigned = { schema: READY_FRONTIER_HANDOFF_PACKET_V1, handoffId, tenantId: input.tenantId,
    workspaceId: input.workspaceId, projectId: proposal.projectId, jobId: materialization.job.id,
    routeId: proposal.routeId, requiredCapability: proposal.requiredCapability,
    materializationReceiptDigest: materialization.receiptDigest, evaluationDigest: evaluation.evaluationDigest,
    sourceDigest: evaluation.sourceDigest, proposalDigest: proposal.proposalDigest,
    standingPolicyDigest: standing.policyDigest, readyPolicyDigest: ready.policyDigest,
    schedulerDecisionDigest: schedulerDecision.decisionDigest, reservationId, createdAt: input.promotedAt,
    expiresAt: input.reservationExpiresAt, destination: "internal_scheduler_jobber_table" as const,
    state: "pending_internal_handoff" as const, repositorySimulationOnly: true as const,
    permitsClaimOrLease: false as const, permitsDispatchOrExecution: false as const,
    permitsProviderContact: false as const, permitsAgentMessage: false as const,
    permitsGitHubMutation: false as const, permitsExternalEffects: false as const };
  const packetWithDigest = { ...packetUnsigned, packetDigest: sha256Digest(packetUnsigned),
    packetAuthTag: "hmac-sha256:" + "0".repeat(64) };
  const handoff = parseServer(readyFrontierPromotionReceiptSchemaV1.shape.handoff,
    { ...packetWithDigest, packetAuthTag: packetTag(evaluationKey, packetWithDigest) }) as ReadyFrontierHandoffPacketV1;
  const unsigned = { schema: READY_FRONTIER_PROMOTION_RECEIPT_V1,
    receiptId: id("promotion:frontier", bound), requestId: input.requestId, tenantId: input.tenantId,
    promotionRequestDigest: sha256Digest(input),
    workspaceId: input.workspaceId, materializationReceiptId: materialization.receiptId,
    materializationReceiptDigest: materialization.receiptDigest, cycleId: evaluation.cycleId,
    proposalId: proposal.proposalId, proposalDigest: proposal.proposalDigest,
    evaluationDigest: evaluation.evaluationDigest, sourceDigest: evaluation.sourceDigest,
    standingPolicyId: standing.policyId, standingPolicyRevision: standing.revision,
    standingPolicyDigest: standing.policyDigest, readyPolicyId: ready.policyId,
    readyPolicyRevision: ready.revision, readyPolicyDigest: ready.policyDigest,
    proposedJobDigest: sha256Digest(materialization.job), readyJob, schedulerDecision, reservation, handoff,
    promotedAt: input.promotedAt, state: "ready_handoff_pending" as const,
    repositorySimulationOnly: true as const, createsAttempt: false as const, createsLease: false as const,
    createsApproval: false as const, createsSchedule: false as const, dispatchState: "not_requested" as const,
    contactsProvider: false as const, messagesAgent: false as const, mutatesGitHub: false as const,
    grantsExternalEffect: false as const };
  const withDigest = { ...unsigned, receiptDigest: sha256Digest(unsigned), receiptAuthTag: "hmac-sha256:" + "0".repeat(64) };
  const receipt = parseServer(readyFrontierPromotionReceiptSchemaV1,
    { ...withDigest, receiptAuthTag: receiptTag(evaluationKey, withDigest) }) as ReadyFrontierPromotionReceiptV1;
  assertNoSecretMaterial(receipt, "ready frontier promotion"); return receipt;
}

export function buildReadyFrontierPromotionV1(value: unknown, evaluationKeyValue: unknown,
  standingPolicyKey: unknown, readyPolicyKey: unknown, evaluation: unknown,
  standingPolicy: unknown, readyPolicy: unknown, trustedNowValue?: unknown): ReadyFrontierPromotionReceiptV1 {
  const snapshot = exactHostUint8ArrayV1(evaluationKeyValue, 128);
  if (!snapshot || snapshot.byteLength < 32) fail("integrity_failed");
  const key = snapshot.copy();
  try { return buildPromotion(value, key, standingPolicyKey, readyPolicyKey, evaluation, standingPolicy, readyPolicy, trustedNowValue); }
  finally { key.fill(0); }
}

export function parseReadyFrontierPromotionV1(value: unknown, evaluationKeyValue: unknown): ReadyFrontierPromotionReceiptV1 {
  const snapshot = exactHostUint8ArrayV1(evaluationKeyValue, 128);
  if (!snapshot || snapshot.byteLength < 32) fail("integrity_failed");
  const key = snapshot.copy();
  try {
    const receipt = parseServer(readyFrontierPromotionReceiptSchemaV1, value) as ReadyFrontierPromotionReceiptV1;
    const packetWithoutAuth = without(receipt.handoff as unknown as Record<string, unknown>, ["packetDigest", "packetAuthTag"]);
    const receiptWithoutAuth = without(receipt as unknown as Record<string, unknown>, ["receiptDigest", "receiptAuthTag"]);
    const decisionWithoutDigest = without(receipt.schedulerDecision as unknown as Record<string, unknown>, ["decisionDigest"]);
    if (!same(receipt.handoff.packetDigest, sha256Digest(packetWithoutAuth))
      || !same(receipt.handoff.packetAuthTag, packetTag(key, receipt.handoff))
      || !same(receipt.receiptDigest, sha256Digest(receiptWithoutAuth))
      || !same(receipt.receiptAuthTag, receiptTag(key, receipt))
      || !same(receipt.schedulerDecision.decisionDigest, sha256Digest(decisionWithoutDigest))
      || receipt.readyJob.state !== "ready" || receipt.readyJob.version !== 1
      || receipt.readyJob.updatedAt !== receipt.promotedAt || receipt.readyJob.id !== receipt.schedulerDecision.selectedJobId
      || receipt.readyJob.projectId !== receipt.schedulerDecision.selectedProjectId
      || receipt.readyJob.authority.allowedExecutor !== receipt.schedulerDecision.selectedRouteId
      || receipt.reservation.jobId !== receipt.readyJob.id || receipt.reservation.projectId !== receipt.readyJob.projectId
      || receipt.reservation.routeId !== receipt.schedulerDecision.selectedRouteId
      || receipt.reservation.resourceKey !== receipt.schedulerDecision.resourceKey
      || receipt.reservation.units !== receipt.schedulerDecision.reservationUnits
      || receipt.reservation.capacityUnits !== receipt.schedulerDecision.resourceCapacityUnits
      || receipt.reservation.decisionDigest !== receipt.schedulerDecision.decisionDigest
      || receipt.handoff.jobId !== receipt.readyJob.id || receipt.handoff.projectId !== receipt.readyJob.projectId
      || receipt.handoff.routeId !== receipt.schedulerDecision.selectedRouteId
      || receipt.handoff.reservationId !== receipt.reservation.reservationId
      || receipt.handoff.schedulerDecisionDigest !== receipt.schedulerDecision.decisionDigest
      || receipt.handoff.materializationReceiptDigest !== receipt.materializationReceiptDigest
      || receipt.handoff.evaluationDigest !== receipt.evaluationDigest || receipt.handoff.sourceDigest !== receipt.sourceDigest
      || receipt.handoff.proposalDigest !== receipt.proposalDigest || receipt.handoff.standingPolicyDigest !== receipt.standingPolicyDigest
      || receipt.handoff.readyPolicyDigest !== receipt.readyPolicyDigest || receipt.handoff.createdAt !== receipt.promotedAt
      || receipt.handoff.expiresAt !== receipt.reservation.expiresAt) fail("digest_mismatch");
    assertAuthorityDigest(receipt.readyJob.authority); return receipt;
  } finally { key.fill(0); }
}
