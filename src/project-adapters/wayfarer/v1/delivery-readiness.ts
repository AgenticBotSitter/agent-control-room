import { z } from "zod";
import {
  exactProjectWorkspaceJsonV1,
  ProjectWorkspaceContractErrorV1,
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../../project-workspace/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import { buildWayfarerSyntheticProjectPackV1 } from "./fixture";
import {
  buildWayfarerDeliveryPreparationPackageV1,
  parseWayfarerDeliveryPreparationPackageV1,
  WAYFARER_DELIVERY_BOUNDARY_IDS_V1,
  type WayfarerDeliveryBoundaryIdV1,
} from "./delivery-preparation";
import { WAYFARER_PROJECT_ID_V1, WAYFARER_WORKSPACE_ID_V1 } from "./types";

export const WAYFARER_DELIVERY_READINESS_CONTRACT_V1 = "control-room-wayfarer-delivery-readiness/v1" as const;
export const WAYFARER_DELIVERY_READINESS_GATE_IDS_V1 = [
  "exact_preparation_package",
  "immutable_artifact_content_identities",
  "authoritative_completion_resolution",
  "exact_destination_identity",
  "qualified_destination_adapter",
  "protected_credential_custody",
  "node_execution_authority",
  "destination_idempotency_qualification",
  "cleanup_and_reconciliation_runbook",
  "fresh_owner_approval_window",
] as const;
export type WayfarerDeliveryReadinessGateIdV1 = (typeof WAYFARER_DELIVERY_READINESS_GATE_IDS_V1)[number];

const evidenceClassByGate: Record<WayfarerDeliveryReadinessGateIdV1, string> = {
  exact_preparation_package: "delivery_preparation_package",
  immutable_artifact_content_identities: "artifact_content_identity_set",
  authoritative_completion_resolution: "completion_gate_resolution",
  exact_destination_identity: "destination_identity",
  qualified_destination_adapter: "destination_adapter_qualification",
  protected_credential_custody: "credential_broker_plan",
  node_execution_authority: "node_approval_attestation",
  destination_idempotency_qualification: "destination_idempotency_qualification",
  cleanup_and_reconciliation_runbook: "cleanup_reconciliation_runbook",
  fresh_owner_approval_window: "owner_approval_window",
};

export interface WayfarerDeliveryReadinessPrerequisiteV1 {
  contractVersion: typeof WAYFARER_DELIVERY_READINESS_CONTRACT_V1;
  gateId: WayfarerDeliveryReadinessGateIdV1;
  evidenceClass: string;
  state: "met" | "missing" | "expired";
  evidenceDigest?: string;
  checkedAt: string;
  validUntil?: string;
  safeReasonCode: string;
  authoritativeEvidenceRequired: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  prerequisiteDigest: string;
}

export interface WayfarerDeliveryReadinessAssessmentV1 {
  contractVersion: typeof WAYFARER_DELIVERY_READINESS_CONTRACT_V1;
  assessmentId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  boundaryId: WayfarerDeliveryBoundaryIdV1;
  operation: "wayfarer.upload_private_distribution" | "wayfarer.publish_episode";
  candidatePackageId: string;
  candidatePackageDigest: string;
  candidateBoundaryDigest: string;
  candidateDestinationId?: string;
  candidateDestinationDigest?: string;
  prerequisites: WayfarerDeliveryReadinessPrerequisiteV1[];
  blockingGateIds: WayfarerDeliveryReadinessGateIdV1[];
  readiness: "blocked" | "candidate_for_owner_window";
  eligibleForOwnerWindow: boolean;
  assessedAt: string;
  requiresFreshStrongApproval: true;
  requiresSeparateNodeAttestation: true;
  requiresDestinationIdempotency: true;
  liveAdapterImplemented: false;
  deliveryAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  assessmentDigest: string;
}

export interface WayfarerDeliveryDisabledDispositionV1 {
  contractVersion: typeof WAYFARER_DELIVERY_READINESS_CONTRACT_V1;
  dispositionId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  boundaryId: WayfarerDeliveryBoundaryIdV1;
  assessmentId: string;
  assessmentDigest: string;
  candidatePackageDigest: string;
  status: "disabled";
  blockingGateIds: WayfarerDeliveryReadinessGateIdV1[];
  safeReasonCode: "required_evidence_missing";
  recordedAt: string;
  requiresNewAssessmentAndAuthorization: true;
  automaticRetryAllowed: false;
  deliveryAttempted: false;
  destinationContacted: false;
  artifactBytesRead: false;
  credentialResolutionObserved: false;
  effectClaimCreated: false;
  preEffectMarkerRecorded: false;
  destinationMutationObserved: false;
  externalEffectOccurred: false;
  uploadAuthorized: false;
  publicationAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  requiresIndependentCheckpoint: true;
  dispositionDigest: string;
}

const boundaryId = z.enum(WAYFARER_DELIVERY_BOUNDARY_IDS_V1);
const gate = z.enum(WAYFARER_DELIVERY_READINESS_GATE_IDS_V1);
const prerequisiteInputSchema = z.object({ gateId: gate, state: z.enum(["met", "missing", "expired"]),
  evidenceDigest: digest.optional(), checkedAt: time, validUntil: time.optional(), safeReasonCode: id }).strict();
const prerequisiteSchema = z.object({ contractVersion: z.literal(WAYFARER_DELIVERY_READINESS_CONTRACT_V1), gateId: gate,
  evidenceClass: id, state: z.enum(["met", "missing", "expired"]), evidenceDigest: digest.optional(), checkedAt: time,
  validUntil: time.optional(), safeReasonCode: id, authoritativeEvidenceRequired: z.literal(true),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), prerequisiteDigest: digest }).strict()
  .superRefine((value, context) => {
    if (value.evidenceClass !== evidenceClassByGate[value.gateId]) context.addIssue({ code: "custom", message: "evidence class mismatch" });
    if (value.state === "missing" && (value.evidenceDigest || value.validUntil)) context.addIssue({ code: "custom", message: "missing evidence mismatch" });
    if (value.state !== "missing" && !value.evidenceDigest) context.addIssue({ code: "custom", message: "evidence digest required" });
    if (value.state === "expired" && (!value.validUntil || Date.parse(value.validUntil) > Date.parse(value.checkedAt))) {
      context.addIssue({ code: "custom", message: "expired chronology mismatch" });
    }
    if (value.state === "met" && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.checkedAt)) {
      context.addIssue({ code: "custom", message: "met evidence expired" });
    }
  });
const assessmentInputSchema = z.object({ assessmentId: id, package: z.unknown(), boundaryId,
  candidateDestinationId: id.optional(), candidateDestinationDigest: digest.optional(),
  prerequisites: z.array(z.unknown()).length(10), assessedAt: time }).strict();
const assessmentSchema = z.object({ contractVersion: z.literal(WAYFARER_DELIVERY_READINESS_CONTRACT_V1), assessmentId: id,
  tenantId: id, workspaceId: z.literal(WAYFARER_WORKSPACE_ID_V1), projectId: z.literal(WAYFARER_PROJECT_ID_V1), boundaryId,
  operation: z.enum(["wayfarer.upload_private_distribution", "wayfarer.publish_episode"]), candidatePackageId: id,
  candidatePackageDigest: digest, candidateBoundaryDigest: digest, candidateDestinationId: id.optional(),
  candidateDestinationDigest: digest.optional(), prerequisites: z.array(prerequisiteSchema).length(10),
  blockingGateIds: z.array(gate).max(10), readiness: z.enum(["blocked", "candidate_for_owner_window"]),
  eligibleForOwnerWindow: z.boolean(), assessedAt: time, requiresFreshStrongApproval: z.literal(true),
  requiresSeparateNodeAttestation: z.literal(true), requiresDestinationIdempotency: z.literal(true),
  liveAdapterImplemented: z.literal(false), deliveryAuthorized: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), assessmentDigest: digest }).strict().superRefine((value, context) => {
    if (Boolean(value.candidateDestinationId) !== Boolean(value.candidateDestinationDigest)) {
      context.addIssue({ code: "custom", message: "destination identity incomplete" });
    }
    if (value.prerequisites.map((item) => item.gateId).join("|") !== WAYFARER_DELIVERY_READINESS_GATE_IDS_V1.join("|")) {
      context.addIssue({ code: "custom", message: "gate order mismatch" });
    }
    const blockers = value.prerequisites.filter((item) => item.state !== "met").map((item) => item.gateId);
    if (blockers.join("|") !== value.blockingGateIds.join("|")) context.addIssue({ code: "custom", message: "blockers mismatch" });
    if (value.prerequisites[0]?.state === "met" && value.prerequisites[0].evidenceDigest !== value.candidatePackageDigest) {
      context.addIssue({ code: "custom", message: "package evidence mismatch" });
    }
    if (value.candidateDestinationDigest && value.prerequisites[3]?.state === "met"
      && value.prerequisites[3].evidenceDigest !== value.candidateDestinationDigest) {
      context.addIssue({ code: "custom", message: "destination evidence mismatch" });
    }
    const candidate = Boolean(value.candidateDestinationId && value.candidateDestinationDigest && blockers.length === 0);
    if ((value.readiness === "candidate_for_owner_window") !== candidate || value.eligibleForOwnerWindow !== candidate) {
      context.addIssue({ code: "custom", message: "readiness mismatch" });
    }
    if ((value.boundaryId === "private_upload") !== (value.operation === "wayfarer.upload_private_distribution")) {
      context.addIssue({ code: "custom", message: "operation mismatch" });
    }
  });
const dispositionInputSchema = z.object({ assessment: z.unknown(), recordedAt: time }).strict();
const dispositionSchema = z.object({ contractVersion: z.literal(WAYFARER_DELIVERY_READINESS_CONTRACT_V1), dispositionId: id,
  tenantId: id, workspaceId: z.literal(WAYFARER_WORKSPACE_ID_V1), projectId: z.literal(WAYFARER_PROJECT_ID_V1),
  boundaryId, assessmentId: id, assessmentDigest: digest,
  candidatePackageDigest: digest, status: z.literal("disabled"), blockingGateIds: z.array(gate).min(1).max(10),
  safeReasonCode: z.literal("required_evidence_missing"), recordedAt: time,
  requiresNewAssessmentAndAuthorization: z.literal(true), automaticRetryAllowed: z.literal(false),
  deliveryAttempted: z.literal(false), destinationContacted: z.literal(false), artifactBytesRead: z.literal(false),
  credentialResolutionObserved: z.literal(false), effectClaimCreated: z.literal(false), preEffectMarkerRecorded: z.literal(false),
  destinationMutationObserved: z.literal(false), externalEffectOccurred: z.literal(false), uploadAuthorized: z.literal(false),
  publicationAuthorized: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  requiresIndependentCheckpoint: z.literal(true), dispositionDigest: digest }).strict();

function exact<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    const parsed = schema.parse(exactProjectWorkspaceJsonV1(value));
    assertNoSecretMaterial(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    if (error instanceof Error && error.message.includes("contains secret material")) {
      throw new ProjectWorkspaceContractErrorV1("redaction_rejected");
    }
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
}
function verifyDigest(value: Record<string, unknown>, key: string, actual: string): void {
  const material = { ...value };
  delete material[key];
  if (sha256Digest(material) !== actual) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
}
function derivedId(prefix: string, value: unknown): string { return `${prefix}:${sha256Digest(value).slice(7, 31)}`; }

export function buildWayfarerDeliveryReadinessPrerequisiteV1(inputValue: unknown): WayfarerDeliveryReadinessPrerequisiteV1 {
  const input = exact(prerequisiteInputSchema, inputValue, "Wayfarer delivery prerequisite");
  const material: Omit<WayfarerDeliveryReadinessPrerequisiteV1, "prerequisiteDigest"> = {
    contractVersion: WAYFARER_DELIVERY_READINESS_CONTRACT_V1, ...input, evidenceClass: evidenceClassByGate[input.gateId],
    authoritativeEvidenceRequired: true, grantsApproval: false, grantsExecutionAuthority: false };
  return parseWayfarerDeliveryReadinessPrerequisiteV1({ ...material, prerequisiteDigest: sha256Digest(material) });
}

export function parseWayfarerDeliveryReadinessPrerequisiteV1(value: unknown): WayfarerDeliveryReadinessPrerequisiteV1 {
  const parsed = exact(prerequisiteSchema, value, "Wayfarer delivery prerequisite") as WayfarerDeliveryReadinessPrerequisiteV1;
  verifyDigest(parsed as unknown as Record<string, unknown>, "prerequisiteDigest", parsed.prerequisiteDigest);
  return parsed;
}

export function buildWayfarerDeliveryReadinessAssessmentV1(inputValue: unknown): WayfarerDeliveryReadinessAssessmentV1 {
  const input = exact(assessmentInputSchema, inputValue, "Wayfarer delivery readiness assessment");
  const prepared = parseWayfarerDeliveryPreparationPackageV1(input.package);
  const boundary = prepared.boundaries.find((item) => item.boundaryId === input.boundaryId);
  if (!boundary) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  const prerequisites = input.prerequisites.map(parseWayfarerDeliveryReadinessPrerequisiteV1);
  const blockers = prerequisites.filter((item) => item.state !== "met").map((item) => item.gateId);
  if (prerequisites.some((item) => Date.parse(item.checkedAt) > Date.parse(input.assessedAt)
    || (item.state === "met" && item.validUntil && Date.parse(item.validUntil) <= Date.parse(input.assessedAt)))) {
    throw new ProjectWorkspaceContractErrorV1("invalid_transition");
  }
  const candidate = Boolean(input.candidateDestinationId && input.candidateDestinationDigest && blockers.length === 0);
  const material: Omit<WayfarerDeliveryReadinessAssessmentV1, "assessmentDigest"> = {
    contractVersion: WAYFARER_DELIVERY_READINESS_CONTRACT_V1, assessmentId: input.assessmentId,
    tenantId: prepared.tenantId, workspaceId: prepared.workspaceId, projectId: prepared.projectId, boundaryId: input.boundaryId,
    operation: input.boundaryId === "private_upload" ? "wayfarer.upload_private_distribution" : "wayfarer.publish_episode",
    candidatePackageId: prepared.packageId, candidatePackageDigest: prepared.packageDigest,
    candidateBoundaryDigest: boundary.boundaryDigest,
    ...(input.candidateDestinationId ? { candidateDestinationId: input.candidateDestinationId } : {}),
    ...(input.candidateDestinationDigest ? { candidateDestinationDigest: input.candidateDestinationDigest } : {}),
    prerequisites, blockingGateIds: blockers, readiness: candidate ? "candidate_for_owner_window" : "blocked",
    eligibleForOwnerWindow: candidate, assessedAt: input.assessedAt, requiresFreshStrongApproval: true,
    requiresSeparateNodeAttestation: true, requiresDestinationIdempotency: true, liveAdapterImplemented: false,
    deliveryAuthorized: false, grantsApproval: false, grantsExecutionAuthority: false };
  return parseWayfarerDeliveryReadinessAssessmentV1({ ...material, assessmentDigest: sha256Digest(material) });
}

export function parseWayfarerDeliveryReadinessAssessmentV1(value: unknown): WayfarerDeliveryReadinessAssessmentV1 {
  const parsed = exact(assessmentSchema, value, "Wayfarer delivery readiness assessment") as WayfarerDeliveryReadinessAssessmentV1;
  for (const prerequisite of parsed.prerequisites) parseWayfarerDeliveryReadinessPrerequisiteV1(prerequisite);
  verifyDigest(parsed as unknown as Record<string, unknown>, "assessmentDigest", parsed.assessmentDigest);
  return parsed;
}

export function buildWayfarerDeliveryDisabledDispositionV1(inputValue: unknown): WayfarerDeliveryDisabledDispositionV1 {
  const input = exact(dispositionInputSchema, inputValue, "Wayfarer delivery disabled disposition");
  const assessment = parseWayfarerDeliveryReadinessAssessmentV1(input.assessment);
  if (assessment.readiness !== "blocked" || assessment.blockingGateIds.length === 0
    || Date.parse(input.recordedAt) < Date.parse(assessment.assessedAt)) {
    throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  }
  const material: Omit<WayfarerDeliveryDisabledDispositionV1, "dispositionDigest"> = {
    contractVersion: WAYFARER_DELIVERY_READINESS_CONTRACT_V1,
    dispositionId: derivedId(`disposition:wayfarer:${assessment.boundaryId}:disabled`, assessment.assessmentDigest),
    tenantId: assessment.tenantId, workspaceId: assessment.workspaceId, projectId: assessment.projectId,
    boundaryId: assessment.boundaryId, assessmentId: assessment.assessmentId, assessmentDigest: assessment.assessmentDigest,
    candidatePackageDigest: assessment.candidatePackageDigest, status: "disabled", blockingGateIds: assessment.blockingGateIds,
    safeReasonCode: "required_evidence_missing", recordedAt: input.recordedAt,
    requiresNewAssessmentAndAuthorization: true, automaticRetryAllowed: false, deliveryAttempted: false,
    destinationContacted: false, artifactBytesRead: false, credentialResolutionObserved: false, effectClaimCreated: false,
    preEffectMarkerRecorded: false, destinationMutationObserved: false, externalEffectOccurred: false,
    uploadAuthorized: false, publicationAuthorized: false, grantsApproval: false, grantsExecutionAuthority: false,
    requiresIndependentCheckpoint: true };
  return parseWayfarerDeliveryDisabledDispositionV1({ ...material, dispositionDigest: sha256Digest(material) });
}

export function parseWayfarerDeliveryDisabledDispositionV1(value: unknown): WayfarerDeliveryDisabledDispositionV1 {
  const parsed = exact(dispositionSchema, value, "Wayfarer delivery disabled disposition") as WayfarerDeliveryDisabledDispositionV1;
  verifyDigest(parsed as unknown as Record<string, unknown>, "dispositionDigest", parsed.dispositionDigest);
  return parsed;
}

export function buildCurrentWayfarerDeliveryReadinessDisabledV1(packValue: unknown = buildWayfarerSyntheticProjectPackV1()): {
  package: ReturnType<typeof buildWayfarerDeliveryPreparationPackageV1>;
  records: [{ assessment: WayfarerDeliveryReadinessAssessmentV1; disposition: WayfarerDeliveryDisabledDispositionV1 },
    { assessment: WayfarerDeliveryReadinessAssessmentV1; disposition: WayfarerDeliveryDisabledDispositionV1 }];
} {
  const prepared = buildWayfarerDeliveryPreparationPackageV1(packValue), checkedAt = "2026-08-29T23:40:00.000Z";
  const records = WAYFARER_DELIVERY_BOUNDARY_IDS_V1.map((currentBoundary) => {
    const prerequisites = WAYFARER_DELIVERY_READINESS_GATE_IDS_V1.map((gateId, position) =>
      buildWayfarerDeliveryReadinessPrerequisiteV1({ gateId, state: position === 0 ? "met" : "missing",
        ...(position === 0 ? { evidenceDigest: prepared.packageDigest } : {}), checkedAt,
        safeReasonCode: position === 0 ? "exact_preparation_package_bound" : `missing_${gateId}` }));
    const assessment = buildWayfarerDeliveryReadinessAssessmentV1({ assessmentId: `assessment:wayfarer:${currentBoundary}:cr9b-wf-120`,
      package: prepared, boundaryId: currentBoundary, prerequisites, assessedAt: checkedAt });
    return { assessment, disposition: buildWayfarerDeliveryDisabledDispositionV1({ assessment,
      recordedAt: "2026-08-29T23:40:01.000Z" }) };
  }) as [{ assessment: WayfarerDeliveryReadinessAssessmentV1; disposition: WayfarerDeliveryDisabledDispositionV1 },
    { assessment: WayfarerDeliveryReadinessAssessmentV1; disposition: WayfarerDeliveryDisabledDispositionV1 }];
  return { package: prepared, records };
}

export const wayfarerDeliveryReadinessSchemasV1 = { prerequisite: prerequisiteSchema, assessment: assessmentSchema,
  disposition: dispositionSchema } as const;
