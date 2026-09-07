import { z } from "zod";
import { actionInboxItemSchemaV1 } from "../../operator-surfaces/v1";
import { jobRecordSchema, requestRecordSchema, workflowRecordSchema } from "../../domain/v1";
import {
  READY_FRONTIER_AUTOMATION_PROJECTION_V1,
  READY_FRONTIER_MATERIALIZATION_RECEIPT_V1,
  READY_FRONTIER_MATERIALIZATION_REQUEST_V1,
  READY_FRONTIER_STANDING_POLICY_V1,
} from "./automation-types";
import {
  readyFrontierAuthTagSchemaV1,
  readyFrontierEvaluationSchemaV1,
  readyFrontierDigestSchemaV1,
  readyFrontierIdSchemaV1,
  readyFrontierSafeCodeSchemaV1,
  readyFrontierTimeSchemaV1,
} from "./schemas";
import { READY_FRONTIER_RESOURCE_CEILINGS_V1, readyFrontierPlatformsV1, readyFrontierRiskClassesV1 } from "./types";

const revision = z.number().int().min(1).max(2_147_483_647);
const negativeAuthority = {
  permitsApproval: z.literal(false), permitsReadyTransition: z.literal(false), permitsScheduling: z.literal(false),
  permitsClaimOrLease: z.literal(false), permitsDispatchOrExecution: z.literal(false), permitsProviderContact: z.literal(false),
  permitsAgentMessage: z.literal(false), permitsGitHubMutation: z.literal(false), permitsExternalEffects: z.literal(false),
};

export const readyFrontierStandingProjectPolicySchemaV1 = z.object({
  projectId: readyFrontierIdSchemaV1,
  enabled: z.boolean(),
  allowedRouteIds: z.array(readyFrontierIdSchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxRoutes),
  allowedPlatforms: z.array(z.enum(readyFrontierPlatformsV1)).min(1).max(readyFrontierPlatformsV1.length),
  allowedCapabilities: z.array(readyFrontierSafeCodeSchemaV1).min(1).max(32),
  maximumRisk: z.enum(readyFrontierRiskClassesV1),
  maximumCostMicrousdPerWork: z.number().int().min(0).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCostMicrousd),
}).strict();

export const readyFrontierStandingPolicySchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_STANDING_POLICY_V1),
  tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1,
  policyId: readyFrontierIdSchemaV1,
  revision,
  previousPolicyDigest: readyFrontierDigestSchemaV1.nullable(),
  action: z.enum(["enroll", "revise", "suspend", "revoke"]),
  state: z.enum(["active", "suspended", "revoked"]),
  activationScope: z.literal("repository_simulation"),
  ownerActorDigest: readyFrontierDigestSchemaV1,
  ownerAuthenticationEvidenceDigest: readyFrontierDigestSchemaV1,
  evidenceSource: z.literal("repository_fixture"),
  productionOwnerAuthenticationVerified: z.literal(false),
  recordedAt: readyFrontierTimeSchemaV1,
  effectiveAt: readyFrontierTimeSchemaV1,
  expiresAt: readyFrontierTimeSchemaV1,
  maximumProposalAgeSeconds: z.number().int().min(60).max(86_400),
  projectPolicies: z.array(readyFrontierStandingProjectPolicySchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProjects),
  permitsRepositorySimulationMaterialization: z.literal(true),
  materializesProposedWorkOnly: z.literal(true),
  requiresSeparateReadyReview: z.literal(true),
  permitsAutomaticApproval: z.literal(false),
  permitsReadyTransition: z.literal(false),
  permitsScheduling: z.literal(false),
  permitsClaimOrLease: z.literal(false),
  permitsDispatchOrExecution: z.literal(false),
  permitsProviderContact: z.literal(false),
  permitsAgentMessage: z.literal(false),
  permitsGitHubMutation: z.literal(false),
  permitsExternalEffects: z.literal(false),
  policyCeilingDigest: readyFrontierDigestSchemaV1,
  policyDigest: readyFrontierDigestSchemaV1,
  policyAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();

export const readyFrontierMaterializationRequestSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_MATERIALIZATION_REQUEST_V1), requestId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1, workspaceId: readyFrontierIdSchemaV1, cycleId: readyFrontierIdSchemaV1,
  proposalId: readyFrontierIdSchemaV1, proposalDigest: readyFrontierDigestSchemaV1,
  evaluationDigest: readyFrontierDigestSchemaV1, sourceDigest: readyFrontierDigestSchemaV1,
  frontierPolicyDigest: readyFrontierDigestSchemaV1, standingPolicyId: readyFrontierIdSchemaV1,
  standingPolicyRevision: revision, standingPolicyDigest: readyFrontierDigestSchemaV1,
  requestedAt: readyFrontierTimeSchemaV1, materializedAt: readyFrontierTimeSchemaV1,
  authorityExpiresAt: readyFrontierTimeSchemaV1, trigger: z.literal("standing_policy_repository_simulation"),
  scheduleId: z.null(), repositorySimulationOnly: z.literal(true), ...negativeAuthority,
}).strict();

export const readyFrontierMaterializationBuildInputSchemaV1 = z.object({
  request: readyFrontierMaterializationRequestSchemaV1,
  evaluation: readyFrontierEvaluationSchemaV1,
  standingPolicy: readyFrontierStandingPolicySchemaV1,
}).strict();

export const readyFrontierMaterializationReceiptSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_MATERIALIZATION_RECEIPT_V1), receiptId: readyFrontierIdSchemaV1,
  requestId: readyFrontierIdSchemaV1, tenantId: readyFrontierIdSchemaV1, workspaceId: readyFrontierIdSchemaV1,
  cycleId: readyFrontierIdSchemaV1, proposalId: readyFrontierIdSchemaV1, proposalDigest: readyFrontierDigestSchemaV1,
  intentDigest: readyFrontierDigestSchemaV1, evaluationDigest: readyFrontierDigestSchemaV1,
  sourceDigest: readyFrontierDigestSchemaV1, frontierPolicyDigest: readyFrontierDigestSchemaV1,
  standingPolicyId: readyFrontierIdSchemaV1, standingPolicyRevision: revision,
  standingPolicyDigest: readyFrontierDigestSchemaV1, request: requestRecordSchema, workflow: workflowRecordSchema,
  job: jobRecordSchema, actionInbox: actionInboxItemSchemaV1, materializedAt: readyFrontierTimeSchemaV1,
  state: z.literal("materialized_proposed"), repositorySimulationOnly: z.literal(true), createsAttempt: z.literal(false),
  createsLease: z.literal(false), createsApproval: z.literal(false), createsSchedule: z.literal(false),
  dispatchState: z.literal("not_requested"), contactsProvider: z.literal(false), messagesAgent: z.literal(false),
  mutatesGitHub: z.literal(false), grantsExternalEffect: z.literal(false), receiptDigest: readyFrontierDigestSchemaV1,
  receiptAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();

const proposalView = z.object({ proposalId: readyFrontierIdSchemaV1, title: z.string().min(1).max(160),
  policyDisposition: z.enum(["eligible_repository_simulation", "policy_missing", "policy_inactive", "policy_denied"]),
  materializationState: z.enum(["not_requested", "materialized_proposed"]), materializedJobId: readyFrontierIdSchemaV1.optional() }).strict();

export const readyFrontierAutomationProjectionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_AUTOMATION_PROJECTION_V1), tenantId: readyFrontierIdSchemaV1,
  standingPolicyState: z.enum(["repository_fixture_active", "missing", "suspended", "revoked", "expired"]),
  productionPolicyState: z.literal("not_enrolled"), projects: z.array(z.object({ projectId: readyFrontierIdSchemaV1,
    proposals: z.array(proposalView).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerProject) }).strict())
    .max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProjects), repositorySimulationOnly: z.literal(true),
  canEnrollProductionPolicy: z.literal(false), canMaterializeFromView: z.literal(false), canApprove: z.literal(false),
  canReady: z.literal(false), canSchedule: z.literal(false), canClaimOrLease: z.literal(false),
  canDispatchOrExecute: z.literal(false), projectionDigest: readyFrontierDigestSchemaV1,
}).strict();
