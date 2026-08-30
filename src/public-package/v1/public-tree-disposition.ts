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
  PUBLIC_MECHANICAL_PACKAGE_NAMES_V1,
  parsePublicMechanicalAuditV1,
  type PublicMechanicalAuditV1,
} from "./mechanical-assurance";

export const PUBLIC_TREE_DISPOSITION_CONTRACT_V1 = "control-room-public-tree-disposition/v1" as const;

export const PUBLIC_TREE_DISPOSITION_GATE_IDS_V1 = [
  "mechanical_audit_current",
  "fixed_root_inventory_complete",
  "license_identifier_files_present",
  "complete_project_license_text",
  "package_manifest_license_metadata",
  "author_license_authority",
  "local_direct_dependency_metadata",
  "independent_dependency_provenance",
  "notice_attribution_review",
  "schema_fixture_link_normalized",
  "bounded_private_data_scan_clean",
  "independent_private_data_review",
  "final_artifact_inventory",
  "signature_verification",
  "real_clean_room_install",
  "independent_security_review",
  "owner_publication_decision",
] as const;
export type PublicTreeDispositionGateIdV1 = (typeof PUBLIC_TREE_DISPOSITION_GATE_IDS_V1)[number];
export type PublicTreeDispositionGateStateV1 = "passed_local" | "failed" | "not_observed";

export interface PublicProjectLicenseObservationV1 {
  packageName: (typeof PUBLIC_MECHANICAL_PACKAGE_NAMES_V1)[number];
  licenseProfile: "spdx_identifier_only";
  licenseIdentifier: "Apache-2.0";
  licenseByteLength: 11;
  licenseContentDigest: string;
  manifestDigest: string;
  manifestLicenseDeclaration: null;
  observationDigest: string;
}

export interface PublicDirectDependencyLicenseObservationV1 {
  packageName: "zod";
  packageVersion: "4.1.12";
  declaredLicense: "MIT";
  localManifestDigest: string;
  localLicenseTextDigest: string;
  dependencyLockEntryDigest: string;
  localTransitiveDependencyCount: 0;
  evidenceMode: "prepared_workspace_local";
  independentProvenanceVerified: false;
  observationDigest: string;
}

export interface PublicTreeDispositionSourceFactsV1 {
  contractVersion: typeof PUBLIC_TREE_DISPOSITION_CONTRACT_V1;
  mechanicalAuditDigest: string;
  projectLicenses: PublicProjectLicenseObservationV1[];
  directDependency: PublicDirectDependencyLicenseObservationV1;
  authorLicenseAuthorityConfirmed: false;
  noticeAttributionReviewed: false;
  finalArtifactInventoryObserved: false;
  independentPrivateDataReviewComplete: false;
  independentSecurityReviewComplete: false;
  signatureVerified: false;
  realCleanRoomInstallObserved: false;
  ownerPublicationDecisionObserved: false;
  factsDigest: string;
}

export interface PublicTreeDispositionGateV1 {
  gateId: PublicTreeDispositionGateIdV1;
  ordinal: number;
  state: PublicTreeDispositionGateStateV1;
  evidenceDigest: string;
  gateDigest: string;
}

export interface PublicTreeDispositionV1 {
  contractVersion: typeof PUBLIC_TREE_DISPOSITION_CONTRACT_V1;
  dispositionId: string;
  mechanicalAuditDigest: string;
  factsDigest: string;
  reviewerId: string;
  reviewMode: "architect_local_non_independent";
  gates: PublicTreeDispositionGateV1[];
  blockers: PublicTreeDispositionGateIdV1[];
  state: "blocked_before_independent_review";
  licenseDisposition: "unresolved_owner_authority_and_complete_text_required";
  publicTreeDisposition: "mechanical_candidate_not_approved_for_public_release";
  localDirectDependencyLicenseObserved: true;
  directDependencyLicense: "MIT";
  localDependencyEvidenceIndependent: false;
  projectLicenseIdentifierObserved: "Apache-2.0";
  completeProjectLicenseTextObserved: false;
  packageManifestLicenseMetadataObserved: false;
  legalAdviceProvided: false;
  authorLicenseGrantInferred: false;
  publicSafetyCertified: false;
  releaseArtifactObserved: false;
  archiveCreationAllowed: false;
  packageInstallationAllowed: false;
  registryContactAllowed: false;
  networkContactAllowed: false;
  signingAllowed: false;
  uploadAllowed: false;
  publicationAllowed: false;
  grantsCertification: false;
  grantsReleaseAuthority: false;
  nextRequiredBlock: "CR10Q-SEC-000/010";
  assessedAt: string;
  dispositionDigest: string;
}

export interface PublicTreeDispositionProjectionV1 {
  contractVersion: typeof PUBLIC_TREE_DISPOSITION_CONTRACT_V1;
  dispositionId: string;
  state: PublicTreeDispositionV1["state"];
  licenseDisposition: PublicTreeDispositionV1["licenseDisposition"];
  publicTreeDisposition: PublicTreeDispositionV1["publicTreeDisposition"];
  passedLocalGateCount: number;
  failedGateCount: number;
  notObservedGateCount: number;
  blockerCodes: PublicTreeDispositionGateIdV1[];
  nextRequiredBlock: PublicTreeDispositionV1["nextRequiredBlock"];
  containsPaths: false;
  containsEvidenceDigests: false;
  containsLicenseText: false;
  publicationAvailable: false;
  grantsCertification: false;
  grantsReleaseAuthority: false;
}

const projectLicenseSchema = z.object({
  packageName: z.enum(PUBLIC_MECHANICAL_PACKAGE_NAMES_V1), licenseProfile: z.literal("spdx_identifier_only"),
  licenseIdentifier: z.literal("Apache-2.0"), licenseByteLength: z.literal(11), licenseContentDigest: digest,
  manifestDigest: digest, manifestLicenseDeclaration: z.null(), observationDigest: digest,
}).strict();
const dependencySchema = z.object({
  packageName: z.literal("zod"), packageVersion: z.literal("4.1.12"), declaredLicense: z.literal("MIT"),
  localManifestDigest: digest, localLicenseTextDigest: digest, dependencyLockEntryDigest: digest,
  localTransitiveDependencyCount: z.literal(0), evidenceMode: z.literal("prepared_workspace_local"),
  independentProvenanceVerified: z.literal(false), observationDigest: digest,
}).strict();
const factsSchema = z.object({
  contractVersion: z.literal(PUBLIC_TREE_DISPOSITION_CONTRACT_V1), mechanicalAuditDigest: digest,
  projectLicenses: z.array(projectLicenseSchema).length(PUBLIC_MECHANICAL_PACKAGE_NAMES_V1.length), directDependency: dependencySchema,
  authorLicenseAuthorityConfirmed: z.literal(false), noticeAttributionReviewed: z.literal(false), finalArtifactInventoryObserved: z.literal(false),
  independentPrivateDataReviewComplete: z.literal(false), independentSecurityReviewComplete: z.literal(false), signatureVerified: z.literal(false),
  realCleanRoomInstallObserved: z.literal(false), ownerPublicationDecisionObserved: z.literal(false), factsDigest: digest,
}).strict();
const gateState = z.enum(["passed_local", "failed", "not_observed"]);
const gateSchema = z.object({ gateId: z.enum(PUBLIC_TREE_DISPOSITION_GATE_IDS_V1), ordinal: z.number().int().min(1).max(PUBLIC_TREE_DISPOSITION_GATE_IDS_V1.length), state: gateState, evidenceDigest: digest, gateDigest: digest }).strict();
const dispositionSchema = z.object({
  contractVersion: z.literal(PUBLIC_TREE_DISPOSITION_CONTRACT_V1), dispositionId: id, mechanicalAuditDigest: digest, factsDigest: digest,
  reviewerId: id, reviewMode: z.literal("architect_local_non_independent"), gates: z.array(gateSchema).length(PUBLIC_TREE_DISPOSITION_GATE_IDS_V1.length),
  blockers: z.array(z.enum(PUBLIC_TREE_DISPOSITION_GATE_IDS_V1)).max(PUBLIC_TREE_DISPOSITION_GATE_IDS_V1.length), state: z.literal("blocked_before_independent_review"),
  licenseDisposition: z.literal("unresolved_owner_authority_and_complete_text_required"), publicTreeDisposition: z.literal("mechanical_candidate_not_approved_for_public_release"),
  localDirectDependencyLicenseObserved: z.literal(true), directDependencyLicense: z.literal("MIT"), localDependencyEvidenceIndependent: z.literal(false),
  projectLicenseIdentifierObserved: z.literal("Apache-2.0"), completeProjectLicenseTextObserved: z.literal(false), packageManifestLicenseMetadataObserved: z.literal(false),
  legalAdviceProvided: z.literal(false), authorLicenseGrantInferred: z.literal(false), publicSafetyCertified: z.literal(false), releaseArtifactObserved: z.literal(false),
  archiveCreationAllowed: z.literal(false), packageInstallationAllowed: z.literal(false), registryContactAllowed: z.literal(false), networkContactAllowed: z.literal(false),
  signingAllowed: z.literal(false), uploadAllowed: z.literal(false), publicationAllowed: z.literal(false), grantsCertification: z.literal(false), grantsReleaseAuthority: z.literal(false),
  nextRequiredBlock: z.literal("CR10Q-SEC-000/010"), assessedAt: time, dispositionDigest: digest,
}).strict();
const projectionSchema = z.object({
  contractVersion: z.literal(PUBLIC_TREE_DISPOSITION_CONTRACT_V1), dispositionId: id, state: z.literal("blocked_before_independent_review"),
  licenseDisposition: z.literal("unresolved_owner_authority_and_complete_text_required"), publicTreeDisposition: z.literal("mechanical_candidate_not_approved_for_public_release"),
  passedLocalGateCount: z.number().int().min(0).max(PUBLIC_TREE_DISPOSITION_GATE_IDS_V1.length), failedGateCount: z.number().int().min(0).max(PUBLIC_TREE_DISPOSITION_GATE_IDS_V1.length),
  notObservedGateCount: z.number().int().min(0).max(PUBLIC_TREE_DISPOSITION_GATE_IDS_V1.length), blockerCodes: z.array(z.enum(PUBLIC_TREE_DISPOSITION_GATE_IDS_V1)),
  nextRequiredBlock: z.literal("CR10Q-SEC-000/010"), containsPaths: z.literal(false), containsEvidenceDigests: z.literal(false), containsLicenseText: z.literal(false),
  publicationAvailable: z.literal(false), grantsCertification: z.literal(false), grantsReleaseAuthority: z.literal(false),
}).strict();

function sameOrder(values: readonly string[], expected: readonly string[]): boolean { return values.join("|") === expected.join("|"); }

export function buildPublicProjectLicenseObservationV1(input: Omit<PublicProjectLicenseObservationV1, "observationDigest">): PublicProjectLicenseObservationV1 {
  const parsed = parseExactPublicPackageV1(projectLicenseSchema.omit({ observationDigest: true }), input, "public project license observation");
  return parsePublicProjectLicenseObservationV1({ ...parsed, observationDigest: sha256Digest(parsed) });
}

export function parsePublicProjectLicenseObservationV1(value: unknown): PublicProjectLicenseObservationV1 {
  const parsed = parseExactPublicPackageV1(projectLicenseSchema, value, "public project license observation");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "observationDigest", parsed.observationDigest);
  return parsed;
}

export function buildPublicDirectDependencyLicenseObservationV1(input: Omit<PublicDirectDependencyLicenseObservationV1, "observationDigest">): PublicDirectDependencyLicenseObservationV1 {
  const parsed = parseExactPublicPackageV1(dependencySchema.omit({ observationDigest: true }), input, "public direct dependency license observation");
  return parsePublicDirectDependencyLicenseObservationV1({ ...parsed, observationDigest: sha256Digest(parsed) });
}

export function parsePublicDirectDependencyLicenseObservationV1(value: unknown): PublicDirectDependencyLicenseObservationV1 {
  const parsed = parseExactPublicPackageV1(dependencySchema, value, "public direct dependency license observation");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "observationDigest", parsed.observationDigest);
  return parsed;
}

export function buildPublicTreeDispositionSourceFactsV1(input: Omit<PublicTreeDispositionSourceFactsV1, "contractVersion" | "factsDigest">): PublicTreeDispositionSourceFactsV1 {
  const material = { contractVersion: PUBLIC_TREE_DISPOSITION_CONTRACT_V1, ...input };
  return parsePublicTreeDispositionSourceFactsV1({ ...material, factsDigest: sha256Digest(material) });
}

export function parsePublicTreeDispositionSourceFactsV1(value: unknown): PublicTreeDispositionSourceFactsV1 {
  const parsed = parseExactPublicPackageV1(factsSchema, value, "public tree disposition facts");
  if (!sameOrder(parsed.projectLicenses.map((item) => item.packageName), PUBLIC_MECHANICAL_PACKAGE_NAMES_V1)
    || new Set(parsed.projectLicenses.map((item) => item.packageName)).size !== PUBLIC_MECHANICAL_PACKAGE_NAMES_V1.length) throw new PublicPackageContractErrorV1("evidence_mismatch");
  parsed.projectLicenses.forEach(parsePublicProjectLicenseObservationV1);
  parsePublicDirectDependencyLicenseObservationV1(parsed.directDependency);
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "factsDigest", parsed.factsDigest);
  return parsed;
}

function expectedGateStates(): Record<PublicTreeDispositionGateIdV1, PublicTreeDispositionGateStateV1> {
  return {
    mechanical_audit_current: "passed_local", fixed_root_inventory_complete: "passed_local", license_identifier_files_present: "passed_local",
    complete_project_license_text: "failed", package_manifest_license_metadata: "failed", author_license_authority: "not_observed",
    local_direct_dependency_metadata: "passed_local", independent_dependency_provenance: "not_observed", notice_attribution_review: "not_observed",
    schema_fixture_link_normalized: "passed_local", bounded_private_data_scan_clean: "passed_local", independent_private_data_review: "not_observed",
    final_artifact_inventory: "not_observed", signature_verification: "not_observed", real_clean_room_install: "not_observed",
    independent_security_review: "not_observed", owner_publication_decision: "not_observed",
  };
}

function buildGates(audit: PublicMechanicalAuditV1, facts: PublicTreeDispositionSourceFactsV1): PublicTreeDispositionGateV1[] {
  const states = expectedGateStates();
  const evidence: Record<PublicTreeDispositionGateIdV1, string> = {
    mechanical_audit_current: audit.auditDigest, fixed_root_inventory_complete: audit.sourceInventoryDigest,
    license_identifier_files_present: audit.licenseNoticeInventoryDigest, complete_project_license_text: audit.licenseNoticeInventoryDigest,
    package_manifest_license_metadata: audit.sbomDigest, author_license_authority: facts.factsDigest,
    local_direct_dependency_metadata: facts.directDependency.observationDigest, independent_dependency_provenance: facts.directDependency.observationDigest,
    notice_attribution_review: audit.licenseNoticeInventoryDigest, schema_fixture_link_normalized: audit.normalizationDigest,
    bounded_private_data_scan_clean: audit.privateDataScanDigest, independent_private_data_review: audit.privateDataScanDigest,
    final_artifact_inventory: audit.sourceInventoryDigest, signature_verification: facts.factsDigest, real_clean_room_install: facts.factsDigest,
    independent_security_review: facts.factsDigest, owner_publication_decision: facts.factsDigest,
  };
  return PUBLIC_TREE_DISPOSITION_GATE_IDS_V1.map((gateId, index) => {
    const material = { gateId, ordinal: index + 1, state: states[gateId], evidenceDigest: evidence[gateId] };
    return { ...material, gateDigest: sha256Digest(material) };
  });
}

export function assessPublicTreeDispositionV1(input: { audit: PublicMechanicalAuditV1; facts: PublicTreeDispositionSourceFactsV1; reviewerId: string; assessedAt: string }): PublicTreeDispositionV1 {
  const audit = parsePublicMechanicalAuditV1(input.audit), facts = parsePublicTreeDispositionSourceFactsV1(input.facts);
  if (audit.state !== "mechanical_candidate_only" || facts.mechanicalAuditDigest !== audit.auditDigest || audit.sensitiveDataFindings.length !== 0) throw new PublicPackageContractErrorV1("evidence_mismatch");
  for (const [index, component] of audit.sbom.entries()) {
    const observation = facts.projectLicenses[index]!;
    if (observation.packageName !== component.packageName || observation.licenseContentDigest !== component.licenseFileDigest || observation.manifestDigest !== component.manifestDigest) throw new PublicPackageContractErrorV1("evidence_mismatch");
  }
  const gates = buildGates(audit, facts), blockers = gates.filter((gate) => gate.state !== "passed_local").map((gate) => gate.gateId);
  const identity = { mechanicalAuditDigest: audit.auditDigest, factsDigest: facts.factsDigest, reviewerId: input.reviewerId, gateDigests: gates.map((gate) => gate.gateDigest) };
  const material: Omit<PublicTreeDispositionV1, "dispositionDigest"> = {
    contractVersion: PUBLIC_TREE_DISPOSITION_CONTRACT_V1, dispositionId: `public-tree-disposition:${sha256Digest(identity).slice(7, 31)}`,
    mechanicalAuditDigest: audit.auditDigest, factsDigest: facts.factsDigest, reviewerId: input.reviewerId, reviewMode: "architect_local_non_independent",
    gates, blockers, state: "blocked_before_independent_review", licenseDisposition: "unresolved_owner_authority_and_complete_text_required",
    publicTreeDisposition: "mechanical_candidate_not_approved_for_public_release", localDirectDependencyLicenseObserved: true,
    directDependencyLicense: "MIT", localDependencyEvidenceIndependent: false, projectLicenseIdentifierObserved: "Apache-2.0",
    completeProjectLicenseTextObserved: false, packageManifestLicenseMetadataObserved: false, legalAdviceProvided: false, authorLicenseGrantInferred: false,
    publicSafetyCertified: false, releaseArtifactObserved: false, archiveCreationAllowed: false, packageInstallationAllowed: false,
    registryContactAllowed: false, networkContactAllowed: false, signingAllowed: false, uploadAllowed: false, publicationAllowed: false,
    grantsCertification: false, grantsReleaseAuthority: false, nextRequiredBlock: "CR10Q-SEC-000/010", assessedAt: input.assessedAt,
  };
  return parsePublicTreeDispositionV1({ ...material, dispositionDigest: sha256Digest(material) });
}

export function parsePublicTreeDispositionV1(value: unknown): PublicTreeDispositionV1 {
  const parsed = parseExactPublicPackageV1(dispositionSchema, value, "public tree disposition");
  const states = expectedGateStates();
  if (!sameOrder(parsed.gates.map((gate) => gate.gateId), PUBLIC_TREE_DISPOSITION_GATE_IDS_V1)
    || parsed.gates.some((gate, index) => gate.ordinal !== index + 1 || gate.state !== states[gate.gateId])) throw new PublicPackageContractErrorV1("evidence_mismatch");
  parsed.gates.forEach((gate) => verifyPublicPackageDigestV1(gate as unknown as Record<string, unknown>, "gateDigest", gate.gateDigest));
  const blockers = parsed.gates.filter((gate) => gate.state !== "passed_local").map((gate) => gate.gateId);
  if (!sameOrder(parsed.blockers, blockers) || new Set(parsed.blockers).size !== parsed.blockers.length) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const identity = { mechanicalAuditDigest: parsed.mechanicalAuditDigest, factsDigest: parsed.factsDigest, reviewerId: parsed.reviewerId, gateDigests: parsed.gates.map((gate) => gate.gateDigest) };
  if (parsed.dispositionId !== `public-tree-disposition:${sha256Digest(identity).slice(7, 31)}`) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "dispositionDigest", parsed.dispositionDigest);
  return parsed;
}

export function projectPublicTreeDispositionV1(value: PublicTreeDispositionV1): PublicTreeDispositionProjectionV1 {
  const parsed = parsePublicTreeDispositionV1(value);
  return parsePublicTreeDispositionProjectionV1({
    contractVersion: PUBLIC_TREE_DISPOSITION_CONTRACT_V1, dispositionId: parsed.dispositionId, state: parsed.state,
    licenseDisposition: parsed.licenseDisposition, publicTreeDisposition: parsed.publicTreeDisposition,
    passedLocalGateCount: parsed.gates.filter((gate) => gate.state === "passed_local").length,
    failedGateCount: parsed.gates.filter((gate) => gate.state === "failed").length,
    notObservedGateCount: parsed.gates.filter((gate) => gate.state === "not_observed").length,
    blockerCodes: parsed.blockers, nextRequiredBlock: parsed.nextRequiredBlock, containsPaths: false, containsEvidenceDigests: false,
    containsLicenseText: false, publicationAvailable: false, grantsCertification: false, grantsReleaseAuthority: false,
  });
}

export function parsePublicTreeDispositionProjectionV1(value: unknown): PublicTreeDispositionProjectionV1 {
  const parsed = parseExactPublicPackageV1(projectionSchema, value, "public tree disposition projection");
  if (parsed.passedLocalGateCount + parsed.failedGateCount + parsed.notObservedGateCount !== PUBLIC_TREE_DISPOSITION_GATE_IDS_V1.length
    || parsed.blockerCodes.length !== parsed.failedGateCount + parsed.notObservedGateCount) throw new PublicPackageContractErrorV1("evidence_mismatch");
  return parsed;
}
