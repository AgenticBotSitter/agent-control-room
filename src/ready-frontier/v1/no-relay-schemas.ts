import { z } from "zod";
import { readyFrontierMaterializationRequestSchemaV1 } from "./automation-schemas";
import {
  READY_FRONTIER_ACTIVATION_PACKET_V1,
  READY_FRONTIER_FAKE_DELIVERY_ACK_V1,
  READY_FRONTIER_FAKE_DELIVERY_REQUEST_V1,
  READY_FRONTIER_NO_RELAY_PROJECTION_V1,
  READY_FRONTIER_NO_RELAY_REQUEST_V1,
  READY_FRONTIER_NO_RELAY_RUN_V1,
} from "./no-relay-types";
import { readyFrontierAuthTagSchemaV1, readyFrontierDigestSchemaV1, readyFrontierIdSchemaV1,
  readyFrontierSafeCodeSchemaV1, readyFrontierTimeSchemaV1 } from "./schemas";

const nonAuthority = {
  createsAttempt: z.literal(false), createsLease: z.literal(false), claimsJob: z.literal(false),
  dispatchesOrExecutes: z.literal(false), contactsProvider: z.literal(false), messagesAgent: z.literal(false),
  mutatesGitHub: z.literal(false), grantsExternalEffect: z.literal(false),
};

export const readyFrontierNoRelayRequestSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_NO_RELAY_REQUEST_V1), runId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1, workspaceId: readyFrontierIdSchemaV1,
  materializationRequest: readyFrontierMaterializationRequestSchemaV1,
  readyPolicyId: readyFrontierIdSchemaV1, readyPolicyRevision: z.number().int().min(1).max(2_147_483_647),
  readyPolicyDigest: readyFrontierDigestSchemaV1, promotionRequestId: readyFrontierIdSchemaV1,
  promotionRequestedAt: readyFrontierTimeSchemaV1, promotedAt: readyFrontierTimeSchemaV1,
  reservationExpiresAt: readyFrontierTimeSchemaV1, deliveryDeadline: readyFrontierTimeSchemaV1,
  observedAt: readyFrontierTimeSchemaV1, trigger: z.literal("repository_no_relay_simulation"),
  deliveryTransport: z.literal("injected_fake"), maximumDeliveryAttempts: z.literal(1),
  repositorySimulationOnly: z.literal(true), permitsProductionPolicyEnrollment: z.literal(false),
  permitsApproval: z.literal(false), permitsScheduleCreation: z.literal(false),
  permitsClaimOrLease: z.literal(false), permitsDispatchOrExecution: z.literal(false),
  permitsProviderContact: z.literal(false), permitsAgentMessage: z.literal(false),
  permitsGitHubMutation: z.literal(false), permitsExternalEffects: z.literal(false),
}).strict();

export const readyFrontierFakeDeliveryRequestSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_FAKE_DELIVERY_REQUEST_V1), runId: readyFrontierIdSchemaV1,
  deliveryId: readyFrontierIdSchemaV1, tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1, projectId: readyFrontierIdSchemaV1,
  jobId: readyFrontierIdSchemaV1, routeId: readyFrontierIdSchemaV1, handoffId: readyFrontierIdSchemaV1,
  handoffPacketDigest: readyFrontierDigestSchemaV1, promotionReceiptDigest: readyFrontierDigestSchemaV1,
  deliveryStartedAt: readyFrontierTimeSchemaV1, deliveryDeadline: readyFrontierTimeSchemaV1,
  transport: z.literal("injected_fake"),
  repositorySimulationOnly: z.literal(true), ...nonAuthority,
}).strict();

export const readyFrontierFakeDeliveryAcknowledgementSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_FAKE_DELIVERY_ACK_V1), runId: readyFrontierIdSchemaV1,
  deliveryId: readyFrontierIdSchemaV1, jobId: readyFrontierIdSchemaV1,
  routeId: readyFrontierIdSchemaV1, handoffId: readyFrontierIdSchemaV1,
  acknowledgedAt: readyFrontierTimeSchemaV1, state: z.literal("acknowledged_repository_simulation"),
  repositorySimulationOnly: z.literal(true), ...nonAuthority,
  acknowledgementDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierNoRelayRunSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_NO_RELAY_RUN_V1), runId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1, workspaceId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1, requestDigest: readyFrontierDigestSchemaV1,
  materializationReceiptDigest: readyFrontierDigestSchemaV1, promotionReceiptDigest: readyFrontierDigestSchemaV1,
  jobId: readyFrontierIdSchemaV1, routeId: readyFrontierIdSchemaV1, handoffId: readyFrontierIdSchemaV1,
  handoffPacketDigest: readyFrontierDigestSchemaV1, deliveryId: readyFrontierIdSchemaV1,
  deliveryDeadline: readyFrontierTimeSchemaV1, deliveryAttemptCount: z.literal(1),
  state: z.enum(["delivery_started", "acknowledged_repository_simulation", "terminal_ambiguous", "expired_before_delivery"]),
  safeReason: z.enum(["fake_handoff_acknowledged", "delivery_outcome_ambiguous", "delivery_window_expired"]),
  startedAt: readyFrontierTimeSchemaV1, updatedAt: readyFrontierTimeSchemaV1,
  acknowledgedAt: readyFrontierTimeSchemaV1.nullable(), acknowledgementDigest: readyFrontierDigestSchemaV1.nullable(),
  repositorySimulationOnly: z.literal(true), ...nonAuthority,
  runDigest: readyFrontierDigestSchemaV1, runAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();

export const readyFrontierNoRelayRunViewSchemaV1 = z.object({
  runId: readyFrontierIdSchemaV1, projectId: readyFrontierIdSchemaV1, jobId: readyFrontierIdSchemaV1,
  routeId: readyFrontierIdSchemaV1,
  state: z.enum(["acknowledged_repository_simulation", "terminal_ambiguous", "expired_before_delivery"]),
  safeReason: z.enum(["fake_handoff_acknowledged", "delivery_outcome_ambiguous", "delivery_window_expired"]),
  deliveryAttemptCount: z.literal(1), updatedAt: readyFrontierTimeSchemaV1,
}).strict();

export const readyFrontierNoRelayAttentionSchemaV1 = z.object({
  runId: readyFrontierIdSchemaV1, projectId: readyFrontierIdSchemaV1, state: z.literal("needs_review"),
  safeReason: z.enum(["delivery_outcome_ambiguous", "delivery_window_expired"]),
}).strict();

export const readyFrontierNoRelayProjectionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_NO_RELAY_PROJECTION_V1), tenantId: readyFrontierIdSchemaV1,
  simulationState: z.enum(["not_run", "acknowledged", "needs_review"]),
  runs: z.array(readyFrontierNoRelayRunViewSchemaV1).max(64),
  attention: z.array(readyFrontierNoRelayAttentionSchemaV1).max(64),
  activationState: z.enum(["blocked_no_simulation_evidence", "blocked_pending_production_proof"]),
  repositorySimulationOnly: z.literal(true), canActivateProduction: z.literal(false),
  canDeliver: z.literal(false), canClaimOrLease: z.literal(false), canDispatchOrExecute: z.literal(false),
  projectionDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierActivationPacketSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_ACTIVATION_PACKET_V1), packetId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1, workspaceId: readyFrontierIdSchemaV1,
  simulationRunId: readyFrontierIdSchemaV1, simulationRunDigest: readyFrontierDigestSchemaV1,
  acceptedAuto030Commit: z.literal("adf0804a52a13d544192afc90506c3e989254ffd"),
  acceptedAuto030ReviewSha256: z.literal("sha256:18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2"),
  requiredProductionGateCodes: z.array(readyFrontierSafeCodeSchemaV1).min(1).max(32),
  state: z.literal("blocked_pending_production_proof"), createdAt: readyFrontierTimeSchemaV1,
  repositorySimulationOnly: z.literal(true), productionOwnerApprovalPresent: z.literal(false),
  productionPolicyEnrolled: z.literal(false), productionConsumerQualified: z.literal(false),
  productionDatabaseQualified: z.literal(false), canActivateItself: z.literal(false),
  permitsProtectedMaterial: z.literal(false), permitsNetwork: z.literal(false),
  permitsGitHubMutation: z.literal(false), permitsAgentOrProviderContact: z.literal(false),
  permitsDispatchOrExecution: z.literal(false), permitsExternalEffects: z.literal(false),
  packetDigest: readyFrontierDigestSchemaV1, packetAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();
