import { z } from "zod";
import { sha256Digest } from "../../../security";
import {
  exactProjectWorkspaceJsonV1,
  ProjectWorkspaceContractErrorV1,
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../../project-workspace/v1";

export const ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1 = "control-room-abs-news-publication-readiness/v1" as const;

export const ABS_NEWS_PUBLICATION_GATE_IDS_V1 = [
  "exact_destination_identity",
  "immutable_article_revision",
  "authoritative_completion_resolution",
  "reviewed_live_adapter",
  "node_approval_attestation",
  "credential_custody",
  "destination_idempotency_qualification",
  "rollback_and_reconciliation_procedure",
  "owner_attended_approval_window",
] as const;
export type AbsNewsPublicationGateIdV1 = (typeof ABS_NEWS_PUBLICATION_GATE_IDS_V1)[number];

const evidenceClassByGate: Record<AbsNewsPublicationGateIdV1, string> = {
  exact_destination_identity: "destination_identity",
  immutable_article_revision: "publication_package",
  authoritative_completion_resolution: "completion_gate_snapshot",
  reviewed_live_adapter: "adapter_qualification",
  node_approval_attestation: "node_approval_attestation",
  credential_custody: "credential_broker_plan",
  destination_idempotency_qualification: "destination_idempotency_qualification",
  rollback_and_reconciliation_procedure: "rollback_runbook",
  owner_attended_approval_window: "owner_approval_window",
};

function parseServer<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(exactProjectWorkspaceJsonV1(value)); }
  catch (error) {
    if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
}
function exactDigest(value: Record<string, unknown>, key: string, actual: string): void {
  const material = { ...value }; delete material[key];
  if (sha256Digest(material) !== actual) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
}
function derivedId(prefix: string, value: unknown): string { return `${prefix}:${sha256Digest(value).slice(7, 31)}`; }

export interface AbsNewsPublicationPrerequisiteV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1;
  gateId: AbsNewsPublicationGateIdV1;
  evidenceClass: string;
  state: "met" | "missing" | "expired";
  evidenceDigest?: string;
  checkedAt: string;
  validUntil?: string;
  safeReasonCode: string;
  authoritativeResolutionRequired: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  prerequisiteDigest: string;
}

export interface AbsNewsPublicationReadinessAssessmentV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1;
  assessmentId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  operation: "abs.publish_article";
  candidatePackageId?: string;
  candidatePackageDigest?: string;
  candidateDestinationId?: string;
  candidateDestinationDigest?: string;
  prerequisites: AbsNewsPublicationPrerequisiteV1[];
  blockingGateIds: AbsNewsPublicationGateIdV1[];
  readiness: "blocked" | "candidate";
  eligibleForOwnerApproval: boolean;
  assessedAt: string;
  requiresFreshOwnerApproval: true;
  requiresAuthoritativeResolution: true;
  liveExecutionImplemented: false;
  publicationAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  assessmentDigest: string;
}

export interface AbsNewsPublicationDisabledDispositionV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1;
  dispositionId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  assessmentId: string;
  assessmentDigest: string;
  status: "disabled";
  blockingGateIds: AbsNewsPublicationGateIdV1[];
  safeReasonCode: "required_evidence_missing";
  recordedAt: string;
  requiresNewAssessment: true;
  automaticRetryAllowed: false;
  actualPublicationAttempted: false;
  publicMutationObserved: false;
  externalEffectOccurred: false;
  publicationAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  requiresIndependentCheckpoint: true;
  dispositionDigest: string;
}

const gate = z.enum(ABS_NEWS_PUBLICATION_GATE_IDS_V1);
const prerequisiteSchema = z.object({ contractVersion: z.literal(ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1), gateId: gate,
  evidenceClass: id, state: z.enum(["met", "missing", "expired"]), evidenceDigest: digest.optional(), checkedAt: time,
  validUntil: time.optional(), safeReasonCode: id, authoritativeResolutionRequired: z.literal(true), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), prerequisiteDigest: digest }).strict().superRefine((value, context) => {
    if (value.evidenceClass !== evidenceClassByGate[value.gateId]) context.addIssue({ code: "custom", message: "evidence class mismatch" });
    if (value.state === "missing" && (value.evidenceDigest || value.validUntil)) context.addIssue({ code: "custom", message: "missing evidence invalid" });
    if (value.state !== "missing" && !value.evidenceDigest) context.addIssue({ code: "custom", message: "evidence digest required" });
    if (value.state === "expired" && (!value.validUntil || Date.parse(value.validUntil) > Date.parse(value.checkedAt))) {
      context.addIssue({ code: "custom", message: "expired evidence chronology invalid" });
    }
    if (value.state === "met" && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.checkedAt)) {
      context.addIssue({ code: "custom", message: "met evidence is expired" });
    }
  });
const prerequisiteInputSchema = z.object({ gateId: gate, state: z.enum(["met", "missing", "expired"]), evidenceDigest: digest.optional(),
  checkedAt: time, validUntil: time.optional(), safeReasonCode: id }).strict();

const orderedGates = z.array(gate).length(ABS_NEWS_PUBLICATION_GATE_IDS_V1.length).superRefine((values, context) => {
  if (values.join("|") !== ABS_NEWS_PUBLICATION_GATE_IDS_V1.join("|")) context.addIssue({ code: "custom", message: "gate order invalid" });
});
const assessmentSchema = z.object({ contractVersion: z.literal(ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1), assessmentId: id,
  tenantId: id, workspaceId: id, projectId: id, operation: z.literal("abs.publish_article"), candidatePackageId: id.optional(),
  candidatePackageDigest: digest.optional(), candidateDestinationId: id.optional(), candidateDestinationDigest: digest.optional(),
  prerequisites: z.array(prerequisiteSchema).length(ABS_NEWS_PUBLICATION_GATE_IDS_V1.length), blockingGateIds: z.array(gate).max(ABS_NEWS_PUBLICATION_GATE_IDS_V1.length),
  readiness: z.enum(["blocked", "candidate"]), eligibleForOwnerApproval: z.boolean(), assessedAt: time,
  requiresFreshOwnerApproval: z.literal(true), requiresAuthoritativeResolution: z.literal(true), liveExecutionImplemented: z.literal(false),
  publicationAuthorized: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), assessmentDigest: digest,
}).strict().superRefine((value, context) => {
  if (Boolean(value.candidatePackageId) !== Boolean(value.candidatePackageDigest)) {
    context.addIssue({ code: "custom", message: "candidate package identity incomplete" });
  }
  if (Boolean(value.candidateDestinationId) !== Boolean(value.candidateDestinationDigest)) {
    context.addIssue({ code: "custom", message: "candidate destination identity incomplete" });
  }
  const gateIds = value.prerequisites.map((item) => item.gateId);
  orderedGates.safeParse(gateIds).error?.issues.forEach((issue) => context.addIssue({ code: "custom", message: issue.message }));
  const expectedBlocking = value.prerequisites.filter((item) => item.state !== "met").map((item) => item.gateId);
  if (expectedBlocking.join("|") !== value.blockingGateIds.join("|")) context.addIssue({ code: "custom", message: "blocking gates mismatch" });
  const completeCandidate = Boolean(value.candidatePackageId && value.candidatePackageDigest
    && value.candidateDestinationId && value.candidateDestinationDigest && expectedBlocking.length === 0);
  if ((value.readiness === "candidate") !== completeCandidate || value.eligibleForOwnerApproval !== completeCandidate) {
    context.addIssue({ code: "custom", message: "readiness status mismatch" });
  }
});
const assessmentInputSchema = z.object({ assessmentId: id, tenantId: id, workspaceId: id, projectId: id,
  candidatePackageId: id.optional(), candidatePackageDigest: digest.optional(), candidateDestinationId: id.optional(),
  candidateDestinationDigest: digest.optional(), prerequisites: z.array(z.unknown()).length(ABS_NEWS_PUBLICATION_GATE_IDS_V1.length),
  assessedAt: time }).strict();

const dispositionSchema = z.object({ contractVersion: z.literal(ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1), dispositionId: id,
  tenantId: id, workspaceId: id, projectId: id, assessmentId: id, assessmentDigest: digest, status: z.literal("disabled"),
  blockingGateIds: z.array(gate).min(1).max(ABS_NEWS_PUBLICATION_GATE_IDS_V1.length), safeReasonCode: z.literal("required_evidence_missing"),
  recordedAt: time, requiresNewAssessment: z.literal(true), automaticRetryAllowed: z.literal(false), actualPublicationAttempted: z.literal(false),
  publicMutationObserved: z.literal(false), externalEffectOccurred: z.literal(false), publicationAuthorized: z.literal(false),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), requiresIndependentCheckpoint: z.literal(true),
  dispositionDigest: digest }).strict();
const dispositionInputSchema = z.object({ assessment: z.unknown(), recordedAt: time }).strict();

export function buildAbsNewsPublicationPrerequisiteV1(inputValue: unknown): AbsNewsPublicationPrerequisiteV1 {
  const input = parseServer(prerequisiteInputSchema, inputValue);
  const material: Omit<AbsNewsPublicationPrerequisiteV1, "prerequisiteDigest"> = {
    contractVersion: ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1, ...input, evidenceClass: evidenceClassByGate[input.gateId],
    authoritativeResolutionRequired: true, grantsApproval: false, grantsExecutionAuthority: false };
  return parseServer(prerequisiteSchema, { ...material, prerequisiteDigest: sha256Digest(material) }) as AbsNewsPublicationPrerequisiteV1;
}

export function parseAbsNewsPublicationPrerequisiteV1(value: unknown): AbsNewsPublicationPrerequisiteV1 {
  const parsed = parseServer(prerequisiteSchema, value) as AbsNewsPublicationPrerequisiteV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "prerequisiteDigest", parsed.prerequisiteDigest);
  return parsed;
}

export function buildAbsNewsPublicationReadinessAssessmentV1(inputValue: unknown): AbsNewsPublicationReadinessAssessmentV1 {
  const input = parseServer(assessmentInputSchema, inputValue), prerequisites = input.prerequisites.map(parseAbsNewsPublicationPrerequisiteV1),
    blockingGateIds = prerequisites.filter((item) => item.state !== "met").map((item) => item.gateId), completeCandidate = Boolean(
      input.candidatePackageId && input.candidatePackageDigest && input.candidateDestinationId && input.candidateDestinationDigest
      && blockingGateIds.length === 0);
  const material: Omit<AbsNewsPublicationReadinessAssessmentV1, "assessmentDigest"> = {
    contractVersion: ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1, assessmentId: input.assessmentId, tenantId: input.tenantId,
    workspaceId: input.workspaceId, projectId: input.projectId, operation: "abs.publish_article",
    ...(input.candidatePackageId ? { candidatePackageId: input.candidatePackageId } : {}),
    ...(input.candidatePackageDigest ? { candidatePackageDigest: input.candidatePackageDigest } : {}),
    ...(input.candidateDestinationId ? { candidateDestinationId: input.candidateDestinationId } : {}),
    ...(input.candidateDestinationDigest ? { candidateDestinationDigest: input.candidateDestinationDigest } : {}),
    prerequisites, blockingGateIds, readiness: completeCandidate ? "candidate" : "blocked",
    eligibleForOwnerApproval: completeCandidate, assessedAt: input.assessedAt, requiresFreshOwnerApproval: true,
    requiresAuthoritativeResolution: true, liveExecutionImplemented: false, publicationAuthorized: false,
    grantsApproval: false, grantsExecutionAuthority: false };
  return parseServer(assessmentSchema, { ...material, assessmentDigest: sha256Digest(material) }) as AbsNewsPublicationReadinessAssessmentV1;
}

export function parseAbsNewsPublicationReadinessAssessmentV1(value: unknown): AbsNewsPublicationReadinessAssessmentV1 {
  const parsed = parseServer(assessmentSchema, value) as AbsNewsPublicationReadinessAssessmentV1;
  for (const prerequisite of parsed.prerequisites) parseAbsNewsPublicationPrerequisiteV1(prerequisite);
  exactDigest(parsed as unknown as Record<string, unknown>, "assessmentDigest", parsed.assessmentDigest);
  return parsed;
}

export function buildAbsNewsPublicationDisabledDispositionV1(inputValue: unknown): AbsNewsPublicationDisabledDispositionV1 {
  const input = parseServer(dispositionInputSchema, inputValue);
  const assessment = parseAbsNewsPublicationReadinessAssessmentV1(input.assessment), recordedAt = input.recordedAt;
  if (assessment.readiness !== "blocked" || assessment.blockingGateIds.length === 0
    || Date.parse(recordedAt) < Date.parse(assessment.assessedAt)) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  const material: Omit<AbsNewsPublicationDisabledDispositionV1, "dispositionDigest"> = {
    contractVersion: ABS_NEWS_PUBLICATION_READINESS_CONTRACT_V1,
    dispositionId: derivedId("disposition:abs-publication-disabled", assessment.assessmentDigest), tenantId: assessment.tenantId,
    workspaceId: assessment.workspaceId, projectId: assessment.projectId, assessmentId: assessment.assessmentId,
    assessmentDigest: assessment.assessmentDigest, status: "disabled", blockingGateIds: assessment.blockingGateIds,
    safeReasonCode: "required_evidence_missing", recordedAt, requiresNewAssessment: true, automaticRetryAllowed: false,
    actualPublicationAttempted: false, publicMutationObserved: false, externalEffectOccurred: false, publicationAuthorized: false,
    grantsApproval: false, grantsExecutionAuthority: false, requiresIndependentCheckpoint: true };
  return parseServer(dispositionSchema, { ...material, dispositionDigest: sha256Digest(material) }) as AbsNewsPublicationDisabledDispositionV1;
}

export function parseAbsNewsPublicationDisabledDispositionV1(value: unknown): AbsNewsPublicationDisabledDispositionV1 {
  const parsed = parseServer(dispositionSchema, value) as AbsNewsPublicationDisabledDispositionV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "dispositionDigest", parsed.dispositionDigest);
  return parsed;
}

export function buildCurrentAbsNewsPublicationDisabledDispositionV1(): { assessment: AbsNewsPublicationReadinessAssessmentV1;
  disposition: AbsNewsPublicationDisabledDispositionV1 } {
  const checkedAt = "2026-08-29T15:00:00.000Z";
  const prerequisites = ABS_NEWS_PUBLICATION_GATE_IDS_V1.map((gateId) => buildAbsNewsPublicationPrerequisiteV1({ gateId,
    state: "missing", checkedAt, safeReasonCode: `missing_${gateId}` }));
  const assessment = buildAbsNewsPublicationReadinessAssessmentV1({ assessmentId: "assessment:abs-publication:cr9d-080",
    tenantId: "tenant:abs", workspaceId: "workspace:abs:news", projectId: "project:abs:news", prerequisites, assessedAt: checkedAt });
  return { assessment, disposition: buildAbsNewsPublicationDisabledDispositionV1({ assessment,
    recordedAt: "2026-08-29T15:01:00.000Z" }) };
}

export const absNewsPublicationReadinessSchemasV1 = { prerequisite: prerequisiteSchema, assessment: assessmentSchema,
  disposition: dispositionSchema } as const;
