import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { PublicPackageContractErrorV1 } from "./errors";
import { parseExactPublicPackageV1, verifyPublicPackageDigestV1 } from "./exact";
import { parsePublicMechanicalAuditV1, type PublicMechanicalAuditV1 } from "./mechanical-assurance";
import { parsePublicTreeDispositionV1, type PublicTreeDispositionV1 } from "./public-tree-disposition";

export const PUBLIC_SECURITY_REVIEW_PACKET_CONTRACT_V1 = "control-room-public-security-review-packet/v1" as const;

export const PUBLIC_SECURITY_REVIEW_CASES_V1 = [
  { caseId: "classification.default_private", category: "privacy", severity: "critical", expected: "reject_or_report_blocker" },
  { caseId: "path.traversal_absolute_encoding", category: "privacy", severity: "high", expected: "reject_without_release_effect" },
  { caseId: "path.case_unicode_alias", category: "privacy", severity: "high", expected: "reject_without_release_effect" },
  { caseId: "tree.symlink_special_executable", category: "supply_chain", severity: "critical", expected: "reject_or_report_blocker" },
  { caseId: "tree.private_identity_history", category: "privacy", severity: "critical", expected: "report_digest_only_and_block" },
  { caseId: "tree.credential_secret_locator", category: "privacy", severity: "critical", expected: "report_digest_only_and_block" },
  { caseId: "data.proxy_accessor_symbol", category: "runtime", severity: "high", expected: "reject_without_property_behavior" },
  { caseId: "data.prototype_sparse_cycle_size", category: "runtime", severity: "high", expected: "reject_without_adapter_call" },
  { caseId: "adapter.hidden_mutable_method", category: "authority", severity: "critical", expected: "reject_before_conformance" },
  { caseId: "adapter.caller_code_not_sandboxed", category: "authority", severity: "critical", expected: "retain_explicit_isolation_blocker" },
  { caseId: "adapter.compatibility_result_spoof", category: "runtime", severity: "high", expected: "reject_without_property_behavior" },
  { caseId: "adapter.normalization_binding_replay", category: "runtime", severity: "high", expected: "reject_or_fail_conformance" },
  { caseId: "adapter.resource_exhaustion", category: "recovery", severity: "high", expected: "remain_bounded_or_report_blocker" },
  { caseId: "dependency.complete_sbom_provenance", category: "supply_chain", severity: "critical", expected: "retain_independent_evidence_blocker" },
  { caseId: "license.text_notice_authority", category: "legal_boundary", severity: "critical", expected: "retain_owner_authority_blocker" },
  { caseId: "artifact.inventory_toc_tou", category: "supply_chain", severity: "critical", expected: "retain_final_artifact_blocker" },
  { caseId: "build.reproducibility_substitution", category: "supply_chain", severity: "high", expected: "retain_external_evidence_blocker" },
  { caseId: "signature.key_manifest_provenance", category: "release", severity: "critical", expected: "retain_signature_blocker" },
  { caseId: "install.real_clean_room", category: "release", severity: "critical", expected: "retain_clean_room_blocker" },
  { caseId: "disclosure.private_reporting_channel", category: "privacy", severity: "high", expected: "retain_owner_resource_blocker" },
  { caseId: "release.rollback_revocation", category: "recovery", severity: "critical", expected: "retain_recovery_blocker" },
  { caseId: "evidence.replay_reorder_substitution", category: "authority", severity: "critical", expected: "reject_or_report_blocker" },
  { caseId: "recovery.failure_cleanup_ambiguity", category: "recovery", severity: "critical", expected: "preserve_ambiguity_without_retry" },
  { caseId: "owner.publication_authority", category: "authority", severity: "critical", expected: "retain_owner_decision_blocker" },
] as const;

export const PUBLIC_SECURITY_ARCHITECT_FINDINGS_V1 = [
  { findingId: "CR10Q-AF-001", severity: "high", category: "runtime", state: "remediated_pending_independent_verification", evidenceCaseIds: ["data.proxy_accessor_symbol", "data.prototype_sparse_cycle_size", "adapter.compatibility_result_spoof"] },
  { findingId: "CR10Q-AF-002", severity: "high", category: "authority", state: "remediated_pending_independent_verification", evidenceCaseIds: ["adapter.hidden_mutable_method", "adapter.caller_code_not_sandboxed"] },
] as const;

interface ReviewCase {
  caseId: (typeof PUBLIC_SECURITY_REVIEW_CASES_V1)[number]["caseId"];
  category: (typeof PUBLIC_SECURITY_REVIEW_CASES_V1)[number]["category"];
  severity: (typeof PUBLIC_SECURITY_REVIEW_CASES_V1)[number]["severity"];
  expected: (typeof PUBLIC_SECURITY_REVIEW_CASES_V1)[number]["expected"];
}
interface ArchitectFinding {
  findingId: (typeof PUBLIC_SECURITY_ARCHITECT_FINDINGS_V1)[number]["findingId"];
  severity: "high";
  category: (typeof PUBLIC_SECURITY_ARCHITECT_FINDINGS_V1)[number]["category"];
  state: "remediated_pending_independent_verification";
  evidenceCaseIds: ReviewCase["caseId"][];
}

export interface PublicSecurityReviewPacketV1 {
  contractVersion: typeof PUBLIC_SECURITY_REVIEW_PACKET_CONTRACT_V1;
  packetId: string;
  architectId: string;
  preparedAt: string;
  mechanicalAuditDigest: string;
  sourceInventoryDigest: string;
  dispositionDigest: string;
  architectRegressionSourceDigest: string;
  cases: Array<ReviewCase & { ordinal: number; caseDigest: string }>;
  architectFindings: Array<ArchitectFinding & { findingDigest: string }>;
  reviewMode: "independent_effect_free_repository_review";
  requiredReviewerRelationship: "different_from_architect_and_candidate_producer";
  reviewState: "ready_for_owner_authorized_independent_review";
  architectMayAcceptOwnPacket: false;
  independentReviewObserved: false;
  independentReviewerMayModifySource: false;
  independentReviewerReportOnly: true;
  externalEffectsAllowed: false;
  legalConclusionAllowed: false;
  licenseGrantAllowed: false;
  publicationDecisionAllowed: false;
  releaseCandidate: false;
  nextRequiredBlock: "CR10Q-SEC-010";
  packetDigest: string;
}

export interface PublicSecurityReviewPacketProjectionV1 {
  contractVersion: typeof PUBLIC_SECURITY_REVIEW_PACKET_CONTRACT_V1;
  packetId: string;
  reviewState: PublicSecurityReviewPacketV1["reviewState"];
  reviewCaseCount: 24;
  criticalCaseCount: number;
  highCaseCount: number;
  architectFindingCount: 2;
  pendingIndependentFindingCount: 2;
  independentReviewObserved: false;
  releaseCandidate: false;
  externalEffectsAllowed: false;
  nextRequiredBlock: "CR10Q-SEC-010";
  requiresOwnerAuthorizationForDifferentReviewer: true;
}

const category = z.enum(["authority", "privacy", "supply_chain", "runtime", "recovery", "release", "legal_boundary"]);
const severity = z.enum(["critical", "high"]);
const reviewCaseSchema = z.object({ caseId: id, category, severity, expected: id, ordinal: z.number().int().min(1).max(PUBLIC_SECURITY_REVIEW_CASES_V1.length), caseDigest: digest }).strict();
const findingSchema = z.object({ findingId: id, severity: z.literal("high"), category, state: z.literal("remediated_pending_independent_verification"), evidenceCaseIds: z.array(id).min(1).max(4), findingDigest: digest }).strict();
const packetSchema = z.object({
  contractVersion: z.literal(PUBLIC_SECURITY_REVIEW_PACKET_CONTRACT_V1), packetId: id, architectId: id, preparedAt: time,
  mechanicalAuditDigest: digest, sourceInventoryDigest: digest, dispositionDigest: digest, architectRegressionSourceDigest: digest,
  cases: z.array(reviewCaseSchema).length(PUBLIC_SECURITY_REVIEW_CASES_V1.length), architectFindings: z.array(findingSchema).length(PUBLIC_SECURITY_ARCHITECT_FINDINGS_V1.length),
  reviewMode: z.literal("independent_effect_free_repository_review"), requiredReviewerRelationship: z.literal("different_from_architect_and_candidate_producer"),
  reviewState: z.literal("ready_for_owner_authorized_independent_review"), architectMayAcceptOwnPacket: z.literal(false), independentReviewObserved: z.literal(false),
  independentReviewerMayModifySource: z.literal(false), independentReviewerReportOnly: z.literal(true), externalEffectsAllowed: z.literal(false),
  legalConclusionAllowed: z.literal(false), licenseGrantAllowed: z.literal(false), publicationDecisionAllowed: z.literal(false), releaseCandidate: z.literal(false),
  nextRequiredBlock: z.literal("CR10Q-SEC-010"), packetDigest: digest,
}).strict();
const projectionSchema = z.object({
  contractVersion: z.literal(PUBLIC_SECURITY_REVIEW_PACKET_CONTRACT_V1), packetId: id, reviewState: z.literal("ready_for_owner_authorized_independent_review"),
  reviewCaseCount: z.literal(24), criticalCaseCount: z.number().int().min(0).max(24), highCaseCount: z.number().int().min(0).max(24),
  architectFindingCount: z.literal(2), pendingIndependentFindingCount: z.literal(2), independentReviewObserved: z.literal(false), releaseCandidate: z.literal(false),
  externalEffectsAllowed: z.literal(false), nextRequiredBlock: z.literal("CR10Q-SEC-010"), requiresOwnerAuthorizationForDifferentReviewer: z.literal(true),
}).strict();

function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function buildCases(): PublicSecurityReviewPacketV1["cases"] {
  return PUBLIC_SECURITY_REVIEW_CASES_V1.map((item, index) => {
    const material = { ...item, ordinal: index + 1 };
    return { ...material, caseDigest: sha256Digest(material) };
  });
}

function buildFindings(regressionDigest: string): PublicSecurityReviewPacketV1["architectFindings"] {
  return PUBLIC_SECURITY_ARCHITECT_FINDINGS_V1.map((item) => ({ ...item, evidenceCaseIds: [...item.evidenceCaseIds], findingDigest: sha256Digest({ ...item, architectRegressionSourceDigest: regressionDigest }) })) as PublicSecurityReviewPacketV1["architectFindings"];
}

export function buildPublicSecurityReviewPacketV1(input: {
  audit: PublicMechanicalAuditV1;
  disposition: PublicTreeDispositionV1;
  architectId: string;
  preparedAt: string;
  architectRegressionSourceDigest: string;
}): PublicSecurityReviewPacketV1 {
  const audit = parsePublicMechanicalAuditV1(input.audit), disposition = parsePublicTreeDispositionV1(input.disposition);
  if (disposition.mechanicalAuditDigest !== audit.auditDigest || disposition.state !== "blocked_before_independent_review") throw new PublicPackageContractErrorV1("evidence_mismatch");
  const cases = buildCases(), architectFindings = buildFindings(input.architectRegressionSourceDigest);
  const identity = { sourceInventoryDigest: audit.sourceInventoryDigest, dispositionDigest: disposition.dispositionDigest, architectRegressionSourceDigest: input.architectRegressionSourceDigest, caseDigests: cases.map((item) => item.caseDigest) };
  const material: Omit<PublicSecurityReviewPacketV1, "packetDigest"> = {
    contractVersion: PUBLIC_SECURITY_REVIEW_PACKET_CONTRACT_V1, packetId: `public-security-review:${sha256Digest(identity).slice(7, 31)}`,
    architectId: input.architectId, preparedAt: input.preparedAt, mechanicalAuditDigest: audit.auditDigest, sourceInventoryDigest: audit.sourceInventoryDigest,
    dispositionDigest: disposition.dispositionDigest, architectRegressionSourceDigest: input.architectRegressionSourceDigest, cases, architectFindings,
    reviewMode: "independent_effect_free_repository_review", requiredReviewerRelationship: "different_from_architect_and_candidate_producer",
    reviewState: "ready_for_owner_authorized_independent_review", architectMayAcceptOwnPacket: false, independentReviewObserved: false,
    independentReviewerMayModifySource: false, independentReviewerReportOnly: true, externalEffectsAllowed: false, legalConclusionAllowed: false,
    licenseGrantAllowed: false, publicationDecisionAllowed: false, releaseCandidate: false, nextRequiredBlock: "CR10Q-SEC-010",
  };
  return parsePublicSecurityReviewPacketV1({ ...material, packetDigest: sha256Digest(material) });
}

export function parsePublicSecurityReviewPacketV1(value: unknown): PublicSecurityReviewPacketV1 {
  const parsed = parseExactPublicPackageV1(packetSchema, value, "public security review packet");
  const expectedCases = buildCases(), expectedFindings = buildFindings(parsed.architectRegressionSourceDigest);
  if (!sameJson(parsed.cases, expectedCases) || !sameJson(parsed.architectFindings, expectedFindings)) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const identity = { sourceInventoryDigest: parsed.sourceInventoryDigest, dispositionDigest: parsed.dispositionDigest, architectRegressionSourceDigest: parsed.architectRegressionSourceDigest, caseDigests: parsed.cases.map((item) => item.caseDigest) };
  if (parsed.packetId !== `public-security-review:${sha256Digest(identity).slice(7, 31)}`) throw new PublicPackageContractErrorV1("evidence_mismatch");
  parsed.cases.forEach((item) => verifyPublicPackageDigestV1(item as unknown as Record<string, unknown>, "caseDigest", item.caseDigest));
  parsed.architectFindings.forEach((item) => {
    const material = { ...item, architectRegressionSourceDigest: parsed.architectRegressionSourceDigest } as Record<string, unknown>;
    delete material.findingDigest;
    if (sha256Digest(material) !== item.findingDigest) throw new PublicPackageContractErrorV1("digest_mismatch");
  });
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "packetDigest", parsed.packetDigest);
  return parsed as PublicSecurityReviewPacketV1;
}

export function projectPublicSecurityReviewPacketV1(value: PublicSecurityReviewPacketV1): PublicSecurityReviewPacketProjectionV1 {
  const parsed = parsePublicSecurityReviewPacketV1(value);
  return parseExactPublicPackageV1(projectionSchema, {
    contractVersion: parsed.contractVersion, packetId: parsed.packetId, reviewState: parsed.reviewState, reviewCaseCount: 24,
    criticalCaseCount: parsed.cases.filter((item) => item.severity === "critical").length, highCaseCount: parsed.cases.filter((item) => item.severity === "high").length,
    architectFindingCount: 2, pendingIndependentFindingCount: 2, independentReviewObserved: false, releaseCandidate: false,
    externalEffectsAllowed: false, nextRequiredBlock: "CR10Q-SEC-010", requiresOwnerAuthorizationForDifferentReviewer: true,
  }, "public security review projection");
}
