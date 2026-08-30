import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { PublicPackageContractErrorV1 } from "./errors";
import { parseExactPublicPackageV1, verifyPublicPackageDigestV1 } from "./exact";
import {
  PUBLIC_SECURITY_REVIEW_CASES_V1,
  parsePublicSecurityReviewPacketV1,
  type PublicSecurityReviewPacketV1,
} from "./security-review-packet";

export const PUBLIC_SECURITY_REMEDIATION_REVIEW_CONTRACT_V1 = "control-room-public-security-remediation-review-packet/v1" as const;
export const CR10Q_SEC_010_ORIGINAL_PACKET_ID_V1 = "public-security-review:6fc96618cf696e2b0ea82cf8" as const;
export const CR10Q_SEC_010_REVIEWER_ID_V1 = "reviewer:codex:independent:cr10q-sec-010" as const;
export const CR10Q_SEC_010_REPORT_DIGEST_V1 = "sha256:11a4710620e3e8487a5834df30277b5c915959ac52224fb25322d15b13a0919f" as const;
export const CR10Q_SEC_025_REPORT_PATH_V1 = "docs/reviews/CR10Q_REMEDIATION_REREVIEW.md" as const;

export const PUBLIC_SECURITY_REMEDIATION_FINDINGS_V1 = [
  {
    findingId: "CR10Q-IR-001",
    severity: "high",
    category: "runtime",
    state: "remediated_pending_different_independent_reverification",
    requiredEvidence: [
      "reserved_keys_rejected_before_nested_value",
      "snapshots_have_null_prototype",
      "compatibility_evidence_rejected_before_adapter_call",
    ],
  },
  {
    findingId: "CR10Q-IR-002",
    severity: "high",
    category: "runtime",
    state: "remediated_pending_different_independent_reverification",
    requiredEvidence: ["property_name_256_accepted", "property_name_257_rejected"],
  },
  {
    findingId: "CR10Q-IR-003",
    severity: "medium",
    category: "scope",
    state: "remediated_pending_different_independent_reverification",
    requiredEvidence: ["machine_inventory_36", "human_review_scope_36"],
  },
] as const;

type OriginalCaseIdV1 = (typeof PUBLIC_SECURITY_REVIEW_CASES_V1)[number]["caseId"];

interface PublicSecurityRemediationFindingV1 {
  findingId: (typeof PUBLIC_SECURITY_REMEDIATION_FINDINGS_V1)[number]["findingId"];
  severity: (typeof PUBLIC_SECURITY_REMEDIATION_FINDINGS_V1)[number]["severity"];
  category: (typeof PUBLIC_SECURITY_REMEDIATION_FINDINGS_V1)[number]["category"];
  state: "remediated_pending_different_independent_reverification";
  requiredEvidence: string[];
  findingDigest: string;
}

export interface PublicSecurityRemediationReviewPacketV1 {
  contractVersion: typeof PUBLIC_SECURITY_REMEDIATION_REVIEW_CONTRACT_V1;
  packetId: string;
  architectId: string;
  preparedAt: string;
  originalReviewPacketId: typeof CR10Q_SEC_010_ORIGINAL_PACKET_ID_V1;
  originalIndependentReviewerId: typeof CR10Q_SEC_010_REVIEWER_ID_V1;
  originalIndependentReportDigest: typeof CR10Q_SEC_010_REPORT_DIGEST_V1;
  previousIndependentDisposition: "remediation_required";
  remediatedReviewPacketId: string;
  remediatedReviewPacketDigest: string;
  remediatedMechanicalAuditDigest: string;
  remediatedSourceInventoryDigest: string;
  remediatedDispositionDigest: string;
  remediationSourceDigest: string;
  remediationRegressionSourceDigest: string;
  remediationPacketContractSourceDigest: string;
  remediationPacketRegressionSourceDigest: string;
  scopeCorrectionSourceDigest: string;
  candidateFileCount: 36;
  findings: PublicSecurityRemediationFindingV1[];
  requiredOriginalCaseIds: OriginalCaseIdV1[];
  fullOriginalCaseReexecutionRequired: true;
  requiredReviewerRelationship: "different_from_original_reviewer_architect_and_candidate_producer";
  reviewState: "ready_for_owner_authorized_independent_remediation_review";
  architectMayAcceptOwnRemediation: false;
  independentReviewObserved: false;
  independentReviewerMayModifySource: false;
  independentReviewerReportOnly: true;
  requiredReportPath: typeof CR10Q_SEC_025_REPORT_PATH_V1;
  externalEffectsAllowed: false;
  legalConclusionAllowed: false;
  licenseGrantAllowed: false;
  publicationDecisionAllowed: false;
  releaseCandidate: false;
  nextRequiredBlock: "CR10Q-SEC-025";
  packetDigest: string;
}

export interface PublicSecurityRemediationReviewProjectionV1 {
  contractVersion: typeof PUBLIC_SECURITY_REMEDIATION_REVIEW_CONTRACT_V1;
  packetId: string;
  remediatedReviewPacketId: string;
  reviewState: PublicSecurityRemediationReviewPacketV1["reviewState"];
  previousIndependentDisposition: "remediation_required";
  candidateFileCount: 36;
  remediationFindingCount: 3;
  highFindingCount: 2;
  mediumFindingCount: 1;
  requiredOriginalCaseCount: 24;
  fullOriginalCaseReexecutionRequired: true;
  independentReviewObserved: false;
  releaseCandidate: false;
  externalEffectsAllowed: false;
  nextRequiredBlock: "CR10Q-SEC-025";
  requiresOwnerAuthorizationForDifferentReviewer: true;
}

const findingSchema = z.object({
  findingId: z.enum(["CR10Q-IR-001", "CR10Q-IR-002", "CR10Q-IR-003"]),
  severity: z.enum(["high", "medium"]),
  category: z.enum(["runtime", "scope"]),
  state: z.literal("remediated_pending_different_independent_reverification"),
  requiredEvidence: z.array(id).min(2).max(3),
  findingDigest: digest,
}).strict();

const packetSchema = z.object({
  contractVersion: z.literal(PUBLIC_SECURITY_REMEDIATION_REVIEW_CONTRACT_V1), packetId: id, architectId: id, preparedAt: time,
  originalReviewPacketId: z.literal(CR10Q_SEC_010_ORIGINAL_PACKET_ID_V1), originalIndependentReviewerId: z.literal(CR10Q_SEC_010_REVIEWER_ID_V1),
  originalIndependentReportDigest: z.literal(CR10Q_SEC_010_REPORT_DIGEST_V1), previousIndependentDisposition: z.literal("remediation_required"),
  remediatedReviewPacketId: id, remediatedReviewPacketDigest: digest, remediatedMechanicalAuditDigest: digest,
  remediatedSourceInventoryDigest: digest, remediatedDispositionDigest: digest, remediationSourceDigest: digest,
  remediationRegressionSourceDigest: digest, remediationPacketContractSourceDigest: digest, remediationPacketRegressionSourceDigest: digest,
  scopeCorrectionSourceDigest: digest, candidateFileCount: z.literal(36),
  findings: z.array(findingSchema).length(PUBLIC_SECURITY_REMEDIATION_FINDINGS_V1.length),
  requiredOriginalCaseIds: z.array(id).length(PUBLIC_SECURITY_REVIEW_CASES_V1.length), fullOriginalCaseReexecutionRequired: z.literal(true),
  requiredReviewerRelationship: z.literal("different_from_original_reviewer_architect_and_candidate_producer"),
  reviewState: z.literal("ready_for_owner_authorized_independent_remediation_review"), architectMayAcceptOwnRemediation: z.literal(false),
  independentReviewObserved: z.literal(false), independentReviewerMayModifySource: z.literal(false), independentReviewerReportOnly: z.literal(true),
  requiredReportPath: z.literal(CR10Q_SEC_025_REPORT_PATH_V1),
  externalEffectsAllowed: z.literal(false), legalConclusionAllowed: z.literal(false), licenseGrantAllowed: z.literal(false),
  publicationDecisionAllowed: z.literal(false), releaseCandidate: z.literal(false), nextRequiredBlock: z.literal("CR10Q-SEC-025"), packetDigest: digest,
}).strict();

const projectionSchema = z.object({
  contractVersion: z.literal(PUBLIC_SECURITY_REMEDIATION_REVIEW_CONTRACT_V1), packetId: id, remediatedReviewPacketId: id,
  reviewState: z.literal("ready_for_owner_authorized_independent_remediation_review"), previousIndependentDisposition: z.literal("remediation_required"),
  candidateFileCount: z.literal(36), remediationFindingCount: z.literal(3), highFindingCount: z.literal(2), mediumFindingCount: z.literal(1),
  requiredOriginalCaseCount: z.literal(24), fullOriginalCaseReexecutionRequired: z.literal(true), independentReviewObserved: z.literal(false),
  releaseCandidate: z.literal(false), externalEffectsAllowed: z.literal(false), nextRequiredBlock: z.literal("CR10Q-SEC-025"),
  requiresOwnerAuthorizationForDifferentReviewer: z.literal(true),
}).strict();

function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function buildFindings(input: Pick<PublicSecurityRemediationReviewPacketV1,
  "remediationSourceDigest" | "remediationRegressionSourceDigest" | "scopeCorrectionSourceDigest"
>): PublicSecurityRemediationReviewPacketV1["findings"] {
  const binding = {
    remediationSourceDigest: input.remediationSourceDigest,
    remediationRegressionSourceDigest: input.remediationRegressionSourceDigest,
    scopeCorrectionSourceDigest: input.scopeCorrectionSourceDigest,
  };
  return PUBLIC_SECURITY_REMEDIATION_FINDINGS_V1.map((finding) => ({
    ...finding,
    requiredEvidence: [...finding.requiredEvidence],
    findingDigest: sha256Digest({ ...finding, ...binding }),
  })) as PublicSecurityRemediationReviewPacketV1["findings"];
}

function packetIdentity(value: Omit<PublicSecurityRemediationReviewPacketV1, "packetId" | "packetDigest" | "architectId" | "preparedAt">): Record<string, unknown> {
  return {
    originalReviewPacketId: value.originalReviewPacketId,
    originalIndependentReportDigest: value.originalIndependentReportDigest,
    remediatedReviewPacketId: value.remediatedReviewPacketId,
    remediatedReviewPacketDigest: value.remediatedReviewPacketDigest,
    remediatedSourceInventoryDigest: value.remediatedSourceInventoryDigest,
    remediationSourceDigest: value.remediationSourceDigest,
    remediationRegressionSourceDigest: value.remediationRegressionSourceDigest,
    remediationPacketContractSourceDigest: value.remediationPacketContractSourceDigest,
    remediationPacketRegressionSourceDigest: value.remediationPacketRegressionSourceDigest,
    scopeCorrectionSourceDigest: value.scopeCorrectionSourceDigest,
    requiredReportPath: value.requiredReportPath,
    findingDigests: value.findings.map((finding) => finding.findingDigest),
    requiredOriginalCaseIds: value.requiredOriginalCaseIds,
  };
}

export function buildPublicSecurityRemediationReviewPacketV1(input: {
  remediatedReviewPacket: PublicSecurityReviewPacketV1;
  architectId: string;
  preparedAt: string;
  originalIndependentReportDigest: string;
  remediationSourceDigest: string;
  remediationRegressionSourceDigest: string;
  remediationPacketContractSourceDigest: string;
  remediationPacketRegressionSourceDigest: string;
  scopeCorrectionSourceDigest: string;
  candidateFileCount: number;
}): PublicSecurityRemediationReviewPacketV1 {
  const current = parsePublicSecurityReviewPacketV1(input.remediatedReviewPacket);
  if (input.originalIndependentReportDigest !== CR10Q_SEC_010_REPORT_DIGEST_V1 || input.candidateFileCount !== 36
    || current.packetId === CR10Q_SEC_010_ORIGINAL_PACKET_ID_V1) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const binding = {
    remediationSourceDigest: input.remediationSourceDigest,
    remediationRegressionSourceDigest: input.remediationRegressionSourceDigest,
    remediationPacketContractSourceDigest: input.remediationPacketContractSourceDigest,
    remediationPacketRegressionSourceDigest: input.remediationPacketRegressionSourceDigest,
    scopeCorrectionSourceDigest: input.scopeCorrectionSourceDigest,
  };
  const findings = buildFindings(binding);
  const materialWithoutIdentity: Omit<PublicSecurityRemediationReviewPacketV1, "packetId" | "packetDigest"> = {
    contractVersion: PUBLIC_SECURITY_REMEDIATION_REVIEW_CONTRACT_V1,
    architectId: input.architectId,
    preparedAt: input.preparedAt,
    originalReviewPacketId: CR10Q_SEC_010_ORIGINAL_PACKET_ID_V1,
    originalIndependentReviewerId: CR10Q_SEC_010_REVIEWER_ID_V1,
    originalIndependentReportDigest: CR10Q_SEC_010_REPORT_DIGEST_V1,
    previousIndependentDisposition: "remediation_required",
    remediatedReviewPacketId: current.packetId,
    remediatedReviewPacketDigest: current.packetDigest,
    remediatedMechanicalAuditDigest: current.mechanicalAuditDigest,
    remediatedSourceInventoryDigest: current.sourceInventoryDigest,
    remediatedDispositionDigest: current.dispositionDigest,
    ...binding,
    candidateFileCount: 36,
    findings,
    requiredOriginalCaseIds: PUBLIC_SECURITY_REVIEW_CASES_V1.map((item) => item.caseId),
    fullOriginalCaseReexecutionRequired: true,
    requiredReviewerRelationship: "different_from_original_reviewer_architect_and_candidate_producer",
    reviewState: "ready_for_owner_authorized_independent_remediation_review",
    architectMayAcceptOwnRemediation: false,
    independentReviewObserved: false,
    independentReviewerMayModifySource: false,
    independentReviewerReportOnly: true,
    requiredReportPath: CR10Q_SEC_025_REPORT_PATH_V1,
    externalEffectsAllowed: false,
    legalConclusionAllowed: false,
    licenseGrantAllowed: false,
    publicationDecisionAllowed: false,
    releaseCandidate: false,
    nextRequiredBlock: "CR10Q-SEC-025",
  };
  const packetId = `public-security-remediation-review:${sha256Digest(packetIdentity(materialWithoutIdentity)).slice(7, 31)}`;
  const material = { ...materialWithoutIdentity, packetId };
  return parsePublicSecurityRemediationReviewPacketV1({ ...material, packetDigest: sha256Digest(material) });
}

export function parsePublicSecurityRemediationReviewPacketV1(value: unknown): PublicSecurityRemediationReviewPacketV1 {
  const parsed = parseExactPublicPackageV1(packetSchema, value, "public security remediation review packet") as PublicSecurityRemediationReviewPacketV1;
  const expectedFindings = buildFindings(parsed);
  const expectedCases = PUBLIC_SECURITY_REVIEW_CASES_V1.map((item) => item.caseId);
  if (!sameJson(parsed.findings, expectedFindings) || !sameJson(parsed.requiredOriginalCaseIds, expectedCases)
    || parsed.remediatedReviewPacketId === parsed.originalReviewPacketId) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const materialWithoutIdentity = { ...parsed } as Record<string, unknown>;
  delete materialWithoutIdentity.packetId;
  delete materialWithoutIdentity.packetDigest;
  const expectedPacketId = `public-security-remediation-review:${sha256Digest(packetIdentity(materialWithoutIdentity as Omit<PublicSecurityRemediationReviewPacketV1, "packetId" | "packetDigest" | "architectId" | "preparedAt">)).slice(7, 31)}`;
  if (parsed.packetId !== expectedPacketId) throw new PublicPackageContractErrorV1("evidence_mismatch");
  parsed.findings.forEach((finding) => verifyPublicPackageDigestV1({ ...finding, remediationSourceDigest: parsed.remediationSourceDigest,
    remediationRegressionSourceDigest: parsed.remediationRegressionSourceDigest, scopeCorrectionSourceDigest: parsed.scopeCorrectionSourceDigest }, "findingDigest", finding.findingDigest));
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "packetDigest", parsed.packetDigest);
  return parsed;
}

export function projectPublicSecurityRemediationReviewPacketV1(value: PublicSecurityRemediationReviewPacketV1): PublicSecurityRemediationReviewProjectionV1 {
  const parsed = parsePublicSecurityRemediationReviewPacketV1(value);
  return parseExactPublicPackageV1(projectionSchema, {
    contractVersion: parsed.contractVersion,
    packetId: parsed.packetId,
    remediatedReviewPacketId: parsed.remediatedReviewPacketId,
    reviewState: parsed.reviewState,
    previousIndependentDisposition: parsed.previousIndependentDisposition,
    candidateFileCount: parsed.candidateFileCount,
    remediationFindingCount: parsed.findings.length,
    highFindingCount: parsed.findings.filter((finding) => finding.severity === "high").length,
    mediumFindingCount: parsed.findings.filter((finding) => finding.severity === "medium").length,
    requiredOriginalCaseCount: parsed.requiredOriginalCaseIds.length,
    fullOriginalCaseReexecutionRequired: parsed.fullOriginalCaseReexecutionRequired,
    independentReviewObserved: parsed.independentReviewObserved,
    releaseCandidate: parsed.releaseCandidate,
    externalEffectsAllowed: parsed.externalEffectsAllowed,
    nextRequiredBlock: parsed.nextRequiredBlock,
    requiresOwnerAuthorizationForDifferentReviewer: true,
  }, "public security remediation review projection");
}
