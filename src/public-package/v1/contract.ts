import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { PublicPackageContractErrorV1 } from "./errors";
import { parseExactPublicPackageV1, verifyPublicPackageDigestV1 } from "./exact";

export const PUBLIC_PACKAGE_CONTRACT_V1 = "control-room-public-package/v1" as const;
export const PUBLIC_PACKAGE_FORMAT_VERSION_V1 = "control-room-public-package-format/v1" as const;

export const PUBLIC_PACKAGE_CLASS_IDS_V1 = [
  "public:core",
  "public:adapter-sdk",
  "public:conformance-kit",
  "public:reference-adapter",
  "public:synthetic-example",
  "public:documentation",
  "public:schema",
  "public:release-metadata",
] as const;
export type PublicPackageClassIdV1 = (typeof PUBLIC_PACKAGE_CLASS_IDS_V1)[number];

export const PRIVATE_PACKAGE_CLASS_IDS_V1 = [
  "private:deployment-config",
  "private:credential-material",
  "private:host-identity",
  "private:production-history",
  "private:artifact-body",
  "private:broker-state",
  "private:owner-trust",
  "private:internal-review",
  "private:runtime-state",
] as const;
export type PrivatePackageClassIdV1 = (typeof PRIVATE_PACKAGE_CLASS_IDS_V1)[number];
export type PackageMaterialClassIdV1 = PublicPackageClassIdV1 | PrivatePackageClassIdV1;

export interface PublicPackageClassDefinitionV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  classId: PackageMaterialClassIdV1;
  publicEligible: boolean;
  allowedPathRoot: string | null;
  contentProfile: string;
  syntheticDataOnly: boolean;
  rawRuntimeValuesAllowed: false;
  credentialValuesAllowed: false;
  privateLocatorValuesAllowed: false;
  productionHistoryAllowed: false;
  executableEffectsAllowed: false;
  grantsAuthority: false;
  definitionDigest: string;
}

export interface PublicPackageClassificationRegistryV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  registryId: "registry:public-package:classification:v1";
  definitions: PublicPackageClassDefinitionV1[];
  defaultClassification: "private_unclassified";
  allowByDefault: false;
  pathInferenceGrantsEligibility: false;
  contentInspectionPerformed: false;
  grantsPublicationAuthority: false;
  registryDigest: string;
}

interface ClassSpecV1 {
  publicEligible: boolean;
  allowedPathRoot: string | null;
  contentProfile: string;
  syntheticDataOnly: boolean;
}

const classSpecs: Record<PackageMaterialClassIdV1, ClassSpecV1> = {
  "public:core": { publicEligible: true, allowedPathRoot: "packages/control-room-core/", contentProfile: "core_contract_source", syntheticDataOnly: false },
  "public:adapter-sdk": { publicEligible: true, allowedPathRoot: "packages/control-room-adapter-sdk/", contentProfile: "observation_only_adapter_sdk", syntheticDataOnly: false },
  "public:conformance-kit": { publicEligible: true, allowedPathRoot: "packages/control-room-conformance-kit/", contentProfile: "effect_free_conformance", syntheticDataOnly: true },
  "public:reference-adapter": { publicEligible: true, allowedPathRoot: "packages/reference-adapters/", contentProfile: "synthetic_reference_adapter", syntheticDataOnly: true },
  "public:synthetic-example": { publicEligible: true, allowedPathRoot: "examples/synthetic/", contentProfile: "synthetic_example", syntheticDataOnly: true },
  "public:documentation": { publicEligible: true, allowedPathRoot: "docs/public/", contentProfile: "public_documentation", syntheticDataOnly: false },
  "public:schema": { publicEligible: true, allowedPathRoot: "schemas/public/", contentProfile: "public_machine_contract", syntheticDataOnly: false },
  "public:release-metadata": { publicEligible: true, allowedPathRoot: "release/", contentProfile: "release_trust_metadata", syntheticDataOnly: false },
  "private:deployment-config": { publicEligible: false, allowedPathRoot: null, contentProfile: "deployment_configuration", syntheticDataOnly: false },
  "private:credential-material": { publicEligible: false, allowedPathRoot: null, contentProfile: "credential_or_authentication_material", syntheticDataOnly: false },
  "private:host-identity": { publicEligible: false, allowedPathRoot: null, contentProfile: "host_or_operator_identity", syntheticDataOnly: false },
  "private:production-history": { publicEligible: false, allowedPathRoot: null, contentProfile: "production_history_or_audit", syntheticDataOnly: false },
  "private:artifact-body": { publicEligible: false, allowedPathRoot: null, contentProfile: "private_artifact_content", syntheticDataOnly: false },
  "private:broker-state": { publicEligible: false, allowedPathRoot: null, contentProfile: "broker_or_provider_state", syntheticDataOnly: false },
  "private:owner-trust": { publicEligible: false, allowedPathRoot: null, contentProfile: "owner_approval_or_trust_material", syntheticDataOnly: false },
  "private:internal-review": { publicEligible: false, allowedPathRoot: null, contentProfile: "private_findings_or_review_evidence", syntheticDataOnly: false },
  "private:runtime-state": { publicEligible: false, allowedPathRoot: null, contentProfile: "local_runtime_or_session_state", syntheticDataOnly: false },
};

const allClassIds = [...PUBLIC_PACKAGE_CLASS_IDS_V1, ...PRIVATE_PACKAGE_CLASS_IDS_V1] as const;
const classId = z.enum(allClassIds);
const classDefinitionSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), classId, publicEligible: z.boolean(),
  allowedPathRoot: z.string().min(1).max(120).nullable(), contentProfile: id, syntheticDataOnly: z.boolean(),
  rawRuntimeValuesAllowed: z.literal(false), credentialValuesAllowed: z.literal(false),
  privateLocatorValuesAllowed: z.literal(false), productionHistoryAllowed: z.literal(false),
  executableEffectsAllowed: z.literal(false), grantsAuthority: z.literal(false), definitionDigest: digest,
}).strict();
const classificationRegistrySchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), registryId: z.literal("registry:public-package:classification:v1"),
  definitions: z.array(classDefinitionSchema).length(allClassIds.length), defaultClassification: z.literal("private_unclassified"),
  allowByDefault: z.literal(false), pathInferenceGrantsEligibility: z.literal(false), contentInspectionPerformed: z.literal(false),
  grantsPublicationAuthority: z.literal(false), registryDigest: digest,
}).strict();

function buildClassDefinition(classification: PackageMaterialClassIdV1): PublicPackageClassDefinitionV1 {
  const material: Omit<PublicPackageClassDefinitionV1, "definitionDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, classId: classification, ...classSpecs[classification],
    rawRuntimeValuesAllowed: false, credentialValuesAllowed: false, privateLocatorValuesAllowed: false,
    productionHistoryAllowed: false, executableEffectsAllowed: false, grantsAuthority: false,
  };
  return { ...material, definitionDigest: sha256Digest(material) };
}

export function buildPublicPackageClassificationRegistryV1(): PublicPackageClassificationRegistryV1 {
  const material: Omit<PublicPackageClassificationRegistryV1, "registryDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, registryId: "registry:public-package:classification:v1",
    definitions: allClassIds.map(buildClassDefinition), defaultClassification: "private_unclassified", allowByDefault: false,
    pathInferenceGrantsEligibility: false, contentInspectionPerformed: false, grantsPublicationAuthority: false,
  };
  return parsePublicPackageClassificationRegistryV1({ ...material, registryDigest: sha256Digest(material) });
}

export function parsePublicPackageClassDefinitionV1(value: unknown): PublicPackageClassDefinitionV1 {
  const parsed = parseExactPublicPackageV1(classDefinitionSchema, value, "public package class definition");
  if (JSON.stringify(parsed) !== JSON.stringify(buildClassDefinition(parsed.classId))) {
    throw new PublicPackageContractErrorV1("classification_mismatch");
  }
  return parsed;
}

export function parsePublicPackageClassificationRegistryV1(value: unknown): PublicPackageClassificationRegistryV1 {
  const parsed = parseExactPublicPackageV1(classificationRegistrySchema, value, "public package classification registry");
  if (parsed.definitions.map((item) => item.classId).join("|") !== allClassIds.join("|")) {
    throw new PublicPackageContractErrorV1("classification_mismatch");
  }
  parsed.definitions.forEach(parsePublicPackageClassDefinitionV1);
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "registryDigest", parsed.registryDigest);
  return parsed;
}

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const packagePathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const forbiddenSegments = new Set([".", "..", ".git", ".env", ".ssh", ".gnupg", ".codex", ".agents", "node_modules"]);
const forbiddenSuffixes = [".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3"];

function validPackagePath(value: string): boolean {
  if (!packagePathPattern.test(value) || value.length > 240 || value.startsWith("/") || value.endsWith("/")
    || value.includes("//") || value.includes("\\") || value.includes("%") || value.normalize("NFC") !== value) return false;
  const segments = value.split("/");
  if (segments.some((segment) => forbiddenSegments.has(segment.toLowerCase()) || segment.startsWith(".env.")
    || segment.endsWith(".") || forbiddenSuffixes.some((suffix) => segment.toLowerCase().endsWith(suffix)))) return false;
  return true;
}

function pathMatchesClass(entryPath: string, classification: PublicPackageClassIdV1): boolean {
  const root = classSpecs[classification].allowedPathRoot!;
  return entryPath.startsWith(root) && entryPath.length > root.length;
}

export type PublicPackageEntryKindV1 = "source" | "declaration" | "schema" | "documentation" | "fixture" | "metadata";
export interface PublicPackageManifestEntryV1 {
  entryPath: string;
  classId: PublicPackageClassIdV1;
  entryKind: PublicPackageEntryKindV1;
  objectKind: "regular_file";
  executable: false;
  generated: boolean;
  mediaType: "application/json" | "application/typescript" | "application/javascript" | "text/markdown" | "text/plain" | "text/yaml";
  byteLength: number;
  contentDigest: string;
  sourceDigest: string;
  entryDigest: string;
}

const publicClassId = z.enum(PUBLIC_PACKAGE_CLASS_IDS_V1);
const entrySchema = z.object({
  entryPath: z.string().refine(validPackagePath), classId: publicClassId,
  entryKind: z.enum(["source", "declaration", "schema", "documentation", "fixture", "metadata"]),
  objectKind: z.literal("regular_file"), executable: z.literal(false), generated: z.boolean(),
  mediaType: z.enum(["application/json", "application/typescript", "application/javascript", "text/markdown", "text/plain", "text/yaml"]),
  byteLength: z.number().int().min(0).max(100_000_000), contentDigest: digest, sourceDigest: digest, entryDigest: digest,
}).strict();
const entryInputSchema = entrySchema.omit({ entryDigest: true });

function buildManifestEntry(inputValue: unknown): PublicPackageManifestEntryV1 {
  const input = parseExactPublicPackageV1(entryInputSchema, inputValue, "public package manifest entry");
  if (!pathMatchesClass(input.entryPath, input.classId)) throw new PublicPackageContractErrorV1("classification_mismatch");
  return { ...input, entryDigest: sha256Digest(input) };
}

export function parsePublicPackageManifestEntryV1(value: unknown): PublicPackageManifestEntryV1 {
  const parsed = parseExactPublicPackageV1(entrySchema, value, "public package manifest entry");
  if (!pathMatchesClass(parsed.entryPath, parsed.classId)) throw new PublicPackageContractErrorV1("classification_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "entryDigest", parsed.entryDigest);
  return parsed;
}

export const PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1 = [
  "control-room-domain/v1",
  "control-room-harness-adapter-sdk/v1",
  "control-room-harness-event/v1",
  "control-room-harness/v1",
  "control-room-package-registry/v1",
  "control-room-project-workspace/v1",
  PUBLIC_PACKAGE_FORMAT_VERSION_V1,
] as const;
export type PublicSupportedContractVersionV1 = (typeof PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1)[number];

export interface PublicPackageCompatibilityPolicyV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  policyId: "policy:public-package:compatibility:v1";
  packageFormatVersion: typeof PUBLIC_PACKAGE_FORMAT_VERSION_V1;
  supportedContractVersions: PublicSupportedContractVersionV1[];
  supportedReleaseLines: Array<{ major: 0; minor: 1; state: "current" }>;
  contractCompatibilityMode: "exact_only";
  releaseCompatibilityMode: "same_major_and_supported_line";
  preReleaseAccepted: false;
  wildcardAccepted: false;
  unknownContractAccepted: false;
  downgradeAccepted: false;
  securityPatchPolicy: "latest_patch_per_supported_line";
  breakingChangePolicy: "new_major_or_pre_one_new_minor";
  supportPromiseSource: "published_supported_versions_document";
  grantsInstallAuthority: false;
  grantsPublicationAuthority: false;
  policyDigest: string;
}

const supportedContractVersion = z.enum(PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1);
const compatibilityPolicySchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), policyId: z.literal("policy:public-package:compatibility:v1"),
  packageFormatVersion: z.literal(PUBLIC_PACKAGE_FORMAT_VERSION_V1),
  supportedContractVersions: z.array(supportedContractVersion).length(PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1.length),
  supportedReleaseLines: z.array(z.object({ major: z.literal(0), minor: z.literal(1), state: z.literal("current") }).strict()).length(1),
  contractCompatibilityMode: z.literal("exact_only"), releaseCompatibilityMode: z.literal("same_major_and_supported_line"),
  preReleaseAccepted: z.literal(false), wildcardAccepted: z.literal(false), unknownContractAccepted: z.literal(false),
  downgradeAccepted: z.literal(false), securityPatchPolicy: z.literal("latest_patch_per_supported_line"),
  breakingChangePolicy: z.literal("new_major_or_pre_one_new_minor"),
  supportPromiseSource: z.literal("published_supported_versions_document"), grantsInstallAuthority: z.literal(false),
  grantsPublicationAuthority: z.literal(false), policyDigest: digest,
}).strict();

export function buildPublicPackageCompatibilityPolicyV1(): PublicPackageCompatibilityPolicyV1 {
  const material: Omit<PublicPackageCompatibilityPolicyV1, "policyDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, policyId: "policy:public-package:compatibility:v1",
    packageFormatVersion: PUBLIC_PACKAGE_FORMAT_VERSION_V1,
    supportedContractVersions: [...PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1],
    supportedReleaseLines: [{ major: 0, minor: 1, state: "current" }], contractCompatibilityMode: "exact_only",
    releaseCompatibilityMode: "same_major_and_supported_line", preReleaseAccepted: false, wildcardAccepted: false,
    unknownContractAccepted: false, downgradeAccepted: false, securityPatchPolicy: "latest_patch_per_supported_line",
    breakingChangePolicy: "new_major_or_pre_one_new_minor", supportPromiseSource: "published_supported_versions_document",
    grantsInstallAuthority: false, grantsPublicationAuthority: false,
  };
  return parsePublicPackageCompatibilityPolicyV1({ ...material, policyDigest: sha256Digest(material) });
}

export function parsePublicPackageCompatibilityPolicyV1(value: unknown): PublicPackageCompatibilityPolicyV1 {
  const parsed = parseExactPublicPackageV1(compatibilityPolicySchema, value, "public package compatibility policy");
  if (JSON.stringify(parsed.supportedContractVersions) !== JSON.stringify(PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1)
    || JSON.stringify(parsed.supportedReleaseLines) !== JSON.stringify([{ major: 0, minor: 1, state: "current" }])) {
    throw new PublicPackageContractErrorV1("compatibility_rejected");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "policyDigest", parsed.policyDigest);
  return parsed;
}

export interface PublicPackageManifestV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  packageFormatVersion: typeof PUBLIC_PACKAGE_FORMAT_VERSION_V1;
  manifestId: string;
  packageId: string;
  packageVersion: string;
  releaseChannel: "candidate";
  producerId: string;
  classificationRegistryDigest: string;
  compatibilityPolicyDigest: string;
  supportedContractVersions: PublicSupportedContractVersionV1[];
  entries: PublicPackageManifestEntryV1[];
  entrySetDigest: string;
  sourceRevisionDigest: string;
  buildRecipeDigest: string;
  dependencyLockDigest: string;
  sbomDigest: string;
  licenseInventoryDigest: string;
  noticeDigest: string;
  provenanceDigest: string;
  privateTreeScanDigest: string;
  credentialScanDigest: string;
  reproducibilityPlanDigest: string;
  publicOnlyDeclaration: true;
  contentBytesInspectedByContract: false;
  symlinksAllowed: false;
  unicodePathsAllowed: false;
  runtimeValuesIncluded: false;
  credentialValuesIncluded: false;
  privateLocatorValuesIncluded: false;
  productionHistoryIncluded: false;
  signatureClaimsIncluded: false;
  certificationClaimsIncluded: false;
  grantsInstallAuthority: false;
  grantsPublicationAuthority: false;
  createdAt: string;
  manifestDigest: string;
}

const semver = z.string().max(80).regex(semverPattern);
const manifestSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), packageFormatVersion: z.literal(PUBLIC_PACKAGE_FORMAT_VERSION_V1),
  manifestId: id, packageId: id, packageVersion: semver, releaseChannel: z.literal("candidate"), producerId: id,
  classificationRegistryDigest: digest, compatibilityPolicyDigest: digest,
  supportedContractVersions: z.array(supportedContractVersion).length(PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1.length),
  entries: z.array(entrySchema).min(1).max(5_000), entrySetDigest: digest, sourceRevisionDigest: digest,
  buildRecipeDigest: digest, dependencyLockDigest: digest, sbomDigest: digest, licenseInventoryDigest: digest,
  noticeDigest: digest, provenanceDigest: digest, privateTreeScanDigest: digest, credentialScanDigest: digest,
  reproducibilityPlanDigest: digest, publicOnlyDeclaration: z.literal(true), contentBytesInspectedByContract: z.literal(false),
  symlinksAllowed: z.literal(false), unicodePathsAllowed: z.literal(false), runtimeValuesIncluded: z.literal(false),
  credentialValuesIncluded: z.literal(false), privateLocatorValuesIncluded: z.literal(false), productionHistoryIncluded: z.literal(false),
  signatureClaimsIncluded: z.literal(false), certificationClaimsIncluded: z.literal(false), grantsInstallAuthority: z.literal(false),
  grantsPublicationAuthority: z.literal(false), createdAt: time, manifestDigest: digest,
}).strict();
const manifestInputSchema = manifestSchema.omit({ entries: true, entrySetDigest: true, manifestDigest: true,
  contractVersion: true, packageFormatVersion: true, releaseChannel: true, supportedContractVersions: true,
  publicOnlyDeclaration: true, contentBytesInspectedByContract: true, symlinksAllowed: true, unicodePathsAllowed: true,
  runtimeValuesIncluded: true, credentialValuesIncluded: true, privateLocatorValuesIncluded: true,
  productionHistoryIncluded: true, signatureClaimsIncluded: true, certificationClaimsIncluded: true,
  grantsInstallAuthority: true, grantsPublicationAuthority: true }).extend({ entries: z.array(entryInputSchema).min(1).max(5_000) }).strict();

function assertManifestEntries(entries: PublicPackageManifestEntryV1[]): void {
  const paths = entries.map((entry) => entry.entryPath);
  const sorted = [...paths].sort((left, right) => left.localeCompare(right, "en"));
  if (paths.join("\0") !== sorted.join("\0") || new Set(paths).size !== paths.length
    || new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    throw new PublicPackageContractErrorV1("classification_mismatch");
  }
  entries.forEach(parsePublicPackageManifestEntryV1);
}

export function buildPublicPackageManifestV1(inputValue: unknown): PublicPackageManifestV1 {
  const input = parseExactPublicPackageV1(manifestInputSchema, inputValue, "public package manifest input");
  const registry = buildPublicPackageClassificationRegistryV1(), policy = buildPublicPackageCompatibilityPolicyV1();
  if (input.classificationRegistryDigest !== registry.registryDigest || input.compatibilityPolicyDigest !== policy.policyDigest) {
    throw new PublicPackageContractErrorV1("classification_mismatch");
  }
  const entries = input.entries.map(buildManifestEntry).sort((left, right) => left.entryPath.localeCompare(right.entryPath, "en"));
  assertManifestEntries(entries);
  const entrySetDigest = sha256Digest(entries.map((entry) => entry.entryDigest));
  const material: Omit<PublicPackageManifestV1, "manifestDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, packageFormatVersion: PUBLIC_PACKAGE_FORMAT_VERSION_V1,
    manifestId: input.manifestId, packageId: input.packageId, packageVersion: input.packageVersion,
    releaseChannel: "candidate", producerId: input.producerId, classificationRegistryDigest: input.classificationRegistryDigest,
    compatibilityPolicyDigest: input.compatibilityPolicyDigest, supportedContractVersions: [...PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1],
    entries, entrySetDigest, sourceRevisionDigest: input.sourceRevisionDigest, buildRecipeDigest: input.buildRecipeDigest,
    dependencyLockDigest: input.dependencyLockDigest, sbomDigest: input.sbomDigest,
    licenseInventoryDigest: input.licenseInventoryDigest, noticeDigest: input.noticeDigest,
    provenanceDigest: input.provenanceDigest, privateTreeScanDigest: input.privateTreeScanDigest,
    credentialScanDigest: input.credentialScanDigest, reproducibilityPlanDigest: input.reproducibilityPlanDigest,
    publicOnlyDeclaration: true, contentBytesInspectedByContract: false, symlinksAllowed: false, unicodePathsAllowed: false,
    runtimeValuesIncluded: false, credentialValuesIncluded: false, privateLocatorValuesIncluded: false,
    productionHistoryIncluded: false, signatureClaimsIncluded: false, certificationClaimsIncluded: false,
    grantsInstallAuthority: false, grantsPublicationAuthority: false, createdAt: input.createdAt,
  };
  return parsePublicPackageManifestV1({ ...material, manifestDigest: sha256Digest(material) });
}

export function parsePublicPackageManifestV1(value: unknown): PublicPackageManifestV1 {
  const parsed = parseExactPublicPackageV1(manifestSchema, value, "public package manifest");
  if (parsed.classificationRegistryDigest !== buildPublicPackageClassificationRegistryV1().registryDigest
    || parsed.compatibilityPolicyDigest !== buildPublicPackageCompatibilityPolicyV1().policyDigest
    || JSON.stringify(parsed.supportedContractVersions) !== JSON.stringify(PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1)
    || parsed.manifestId !== `manifest:${parsed.packageId}:${parsed.packageVersion}`) {
    throw new PublicPackageContractErrorV1("classification_mismatch");
  }
  assertManifestEntries(parsed.entries);
  if (parsed.entrySetDigest !== sha256Digest(parsed.entries.map((entry) => entry.entryDigest))) {
    throw new PublicPackageContractErrorV1("digest_mismatch");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "manifestDigest", parsed.manifestDigest);
  return parsed;
}

export type PublicPackageCompatibilityReasonV1 =
  | "package_format_mismatch"
  | "manifest_version_mismatch"
  | "release_line_unsupported"
  | "pre_release_rejected"
  | "contract_set_mismatch"
  | "downgrade_rejected";

export interface PublicPackageCompatibilityRequestV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  requestId: string;
  packageId: string;
  manifestDigest: string;
  requestedPackageVersion: string;
  currentInstalledVersion?: string;
  requestedPackageFormatVersion: string;
  requestedContractVersions: string[];
  wildcardRequested: false;
  installAttempted: false;
  grantsInstallAuthority: false;
  requestedAt: string;
  requestDigest: string;
}

export interface PublicPackageCompatibilityAssessmentV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  assessmentId: string;
  requestId: string;
  requestDigest: string;
  packageId: string;
  packageVersion: string;
  manifestDigest: string;
  policyDigest: string;
  compatible: boolean;
  reasons: PublicPackageCompatibilityReasonV1[];
  exactContractMatch: boolean;
  supportedReleaseLine: boolean;
  downgradeDetected: boolean;
  installAttempted: false;
  grantsInstallAuthority: false;
  grantsPublicationAuthority: false;
  assessedAt: string;
  assessmentDigest: string;
}

const contractVersionString = z.string().min(3).max(120).regex(/^[a-z0-9][a-z0-9._/-]*$/);
const compatibilityRequestSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), requestId: id, packageId: id, manifestDigest: digest,
  requestedPackageVersion: semver, currentInstalledVersion: semver.optional(), requestedPackageFormatVersion: contractVersionString,
  requestedContractVersions: z.array(contractVersionString).min(1).max(20), wildcardRequested: z.literal(false),
  installAttempted: z.literal(false), grantsInstallAuthority: z.literal(false), requestedAt: time, requestDigest: digest,
}).strict();
const compatibilityRequestInputSchema = compatibilityRequestSchema.omit({ contractVersion: true, requestId: true,
  wildcardRequested: true, installAttempted: true, grantsInstallAuthority: true, requestDigest: true }).strict();
const compatibilityReason = z.enum(["package_format_mismatch", "manifest_version_mismatch", "release_line_unsupported",
  "pre_release_rejected", "contract_set_mismatch", "downgrade_rejected"]);
const compatibilityAssessmentSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), assessmentId: id, requestId: id, requestDigest: digest,
  packageId: id, packageVersion: semver, manifestDigest: digest, policyDigest: digest, compatible: z.boolean(),
  reasons: z.array(compatibilityReason).max(6), exactContractMatch: z.boolean(), supportedReleaseLine: z.boolean(),
  downgradeDetected: z.boolean(), installAttempted: z.literal(false), grantsInstallAuthority: z.literal(false),
  grantsPublicationAuthority: z.literal(false), assessedAt: time, assessmentDigest: digest,
}).strict();

function parseSemver(value: string): { major: number; minor: number; patch: number; prerelease: string | undefined } {
  const match = semverPattern.exec(value);
  if (!match) throw new PublicPackageContractErrorV1("compatibility_rejected");
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left), b = parseSemver(right);
  for (const key of ["major", "minor", "patch"] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en");
}

export function buildPublicPackageCompatibilityRequestV1(inputValue: unknown): PublicPackageCompatibilityRequestV1 {
  const input = parseExactPublicPackageV1(compatibilityRequestInputSchema, inputValue, "public package compatibility request input");
  const requestedContractVersions = [...input.requestedContractVersions].sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(requestedContractVersions).size !== requestedContractVersions.length) {
    throw new PublicPackageContractErrorV1("compatibility_rejected");
  }
  const requestId = `compatibility-request:${input.packageId}:${input.requestedPackageVersion}`;
  const material: Omit<PublicPackageCompatibilityRequestV1, "requestDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, requestId, packageId: input.packageId, manifestDigest: input.manifestDigest,
    requestedPackageVersion: input.requestedPackageVersion,
    ...(input.currentInstalledVersion ? { currentInstalledVersion: input.currentInstalledVersion } : {}),
    requestedPackageFormatVersion: input.requestedPackageFormatVersion, requestedContractVersions,
    wildcardRequested: false, installAttempted: false, grantsInstallAuthority: false, requestedAt: input.requestedAt,
  };
  return parsePublicPackageCompatibilityRequestV1({ ...material, requestDigest: sha256Digest(material) });
}

export function parsePublicPackageCompatibilityRequestV1(value: unknown): PublicPackageCompatibilityRequestV1 {
  const parsed = parseExactPublicPackageV1(compatibilityRequestSchema, value, "public package compatibility request");
  const sorted = [...parsed.requestedContractVersions].sort((left, right) => left.localeCompare(right, "en"));
  if (parsed.requestedContractVersions.join("|") !== sorted.join("|")
    || new Set(parsed.requestedContractVersions).size !== parsed.requestedContractVersions.length
    || parsed.requestId !== `compatibility-request:${parsed.packageId}:${parsed.requestedPackageVersion}`) {
    throw new PublicPackageContractErrorV1("compatibility_rejected");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "requestDigest", parsed.requestDigest);
  return parsed;
}

export function assessPublicPackageCompatibilityV1(inputValue: unknown): PublicPackageCompatibilityAssessmentV1 {
  const input = parseExactPublicPackageV1(z.object({ manifest: z.unknown(), policy: z.unknown(), request: z.unknown(),
    assessedAt: time }).strict(), inputValue, "public package compatibility assessment input");
  const manifest = parsePublicPackageManifestV1(input.manifest), policy = parsePublicPackageCompatibilityPolicyV1(input.policy),
    request = parsePublicPackageCompatibilityRequestV1(input.request);
  if (request.packageId !== manifest.packageId || request.manifestDigest !== manifest.manifestDigest
    || Date.parse(input.assessedAt) < Date.parse(request.requestedAt)) throw new PublicPackageContractErrorV1("compatibility_rejected");
  const requested = parseSemver(request.requestedPackageVersion), exactContractMatch =
    request.requestedContractVersions.join("|") === policy.supportedContractVersions.join("|"),
    supportedReleaseLine = policy.supportedReleaseLines.some((line) => line.major === requested.major && line.minor === requested.minor),
    downgradeDetected = request.currentInstalledVersion ? compareSemver(request.requestedPackageVersion, request.currentInstalledVersion) < 0 : false;
  const reasons: PublicPackageCompatibilityReasonV1[] = [];
  if (request.requestedPackageFormatVersion !== policy.packageFormatVersion) reasons.push("package_format_mismatch");
  if (request.requestedPackageVersion !== manifest.packageVersion) reasons.push("manifest_version_mismatch");
  if (!supportedReleaseLine) reasons.push("release_line_unsupported");
  if (requested.prerelease !== undefined) reasons.push("pre_release_rejected");
  if (!exactContractMatch) reasons.push("contract_set_mismatch");
  if (downgradeDetected) reasons.push("downgrade_rejected");
  const compatible = reasons.length === 0;
  const assessmentId = `compatibility-assessment:${manifest.packageId}:${manifest.packageVersion}`;
  const material: Omit<PublicPackageCompatibilityAssessmentV1, "assessmentDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, assessmentId, requestId: request.requestId, requestDigest: request.requestDigest,
    packageId: manifest.packageId, packageVersion: manifest.packageVersion, manifestDigest: manifest.manifestDigest,
    policyDigest: policy.policyDigest, compatible, reasons, exactContractMatch, supportedReleaseLine, downgradeDetected,
    installAttempted: false, grantsInstallAuthority: false, grantsPublicationAuthority: false, assessedAt: input.assessedAt,
  };
  return parsePublicPackageCompatibilityAssessmentV1({ ...material, assessmentDigest: sha256Digest(material) });
}

export function parsePublicPackageCompatibilityAssessmentV1(value: unknown): PublicPackageCompatibilityAssessmentV1 {
  const parsed = parseExactPublicPackageV1(compatibilityAssessmentSchema, value, "public package compatibility assessment");
  if (parsed.compatible !== (parsed.reasons.length === 0)
    || (parsed.compatible && (!parsed.exactContractMatch || !parsed.supportedReleaseLine || parsed.downgradeDetected))
    || new Set(parsed.reasons).size !== parsed.reasons.length
    || parsed.assessmentId !== `compatibility-assessment:${parsed.packageId}:${parsed.packageVersion}`) {
    throw new PublicPackageContractErrorV1("compatibility_rejected");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "assessmentDigest", parsed.assessmentDigest);
  return parsed;
}

export type PublicPackageSignatureClaimStateV1 = "unsigned" | "unverified_signature_digest";
export interface PublicPackageSignatureClaimV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  claimId: string;
  packageId: string;
  packageVersion: string;
  manifestDigest: string;
  claimState: PublicPackageSignatureClaimStateV1;
  algorithm: "none" | "ed25519";
  signerKeyFingerprintDigest?: string;
  signatureDigest?: string;
  signatureBytesPresent: false;
  signingKeyValuePresent: false;
  cryptographicVerificationPerformed: false;
  verificationState: "not_verified";
  grantsCertification: false;
  grantsPublicationAuthority: false;
  claimedAt: string;
  claimDigest: string;
}

const signatureClaimSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), claimId: id, packageId: id, packageVersion: semver,
  manifestDigest: digest, claimState: z.enum(["unsigned", "unverified_signature_digest"]),
  algorithm: z.enum(["none", "ed25519"]), signerKeyFingerprintDigest: digest.optional(), signatureDigest: digest.optional(),
  signatureBytesPresent: z.literal(false), signingKeyValuePresent: z.literal(false),
  cryptographicVerificationPerformed: z.literal(false), verificationState: z.literal("not_verified"),
  grantsCertification: z.literal(false), grantsPublicationAuthority: z.literal(false), claimedAt: time, claimDigest: digest,
}).strict();
const signatureClaimInputSchema = z.object({ manifest: z.unknown(), claimState: z.enum(["unsigned", "unverified_signature_digest"]),
  signerKeyFingerprintDigest: digest.optional(), signatureDigest: digest.optional(), claimedAt: time }).strict();

export function buildPublicPackageSignatureClaimV1(inputValue: unknown): PublicPackageSignatureClaimV1 {
  const input = parseExactPublicPackageV1(signatureClaimInputSchema, inputValue, "public package signature claim input"),
    manifest = parsePublicPackageManifestV1(input.manifest), signed = input.claimState === "unverified_signature_digest";
  if (signed !== Boolean(input.signerKeyFingerprintDigest) || signed !== Boolean(input.signatureDigest)
    || Date.parse(input.claimedAt) < Date.parse(manifest.createdAt)) throw new PublicPackageContractErrorV1("signature_mismatch");
  const claimId = `signature-claim:${manifest.packageId}:${manifest.packageVersion}`;
  const material: Omit<PublicPackageSignatureClaimV1, "claimDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, claimId, packageId: manifest.packageId,
    packageVersion: manifest.packageVersion, manifestDigest: manifest.manifestDigest, claimState: input.claimState,
    algorithm: signed ? "ed25519" : "none",
    ...(input.signerKeyFingerprintDigest ? { signerKeyFingerprintDigest: input.signerKeyFingerprintDigest } : {}),
    ...(input.signatureDigest ? { signatureDigest: input.signatureDigest } : {}), signatureBytesPresent: false,
    signingKeyValuePresent: false, cryptographicVerificationPerformed: false, verificationState: "not_verified",
    grantsCertification: false, grantsPublicationAuthority: false, claimedAt: input.claimedAt,
  };
  return parsePublicPackageSignatureClaimV1({ ...material, claimDigest: sha256Digest(material) });
}

export function parsePublicPackageSignatureClaimV1(value: unknown): PublicPackageSignatureClaimV1 {
  const parsed = parseExactPublicPackageV1(signatureClaimSchema, value, "public package signature claim"),
    signed = parsed.claimState === "unverified_signature_digest";
  if (signed !== (parsed.algorithm === "ed25519") || signed !== Boolean(parsed.signerKeyFingerprintDigest)
    || signed !== Boolean(parsed.signatureDigest)
    || parsed.claimId !== `signature-claim:${parsed.packageId}:${parsed.packageVersion}`) {
    throw new PublicPackageContractErrorV1("signature_mismatch");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "claimDigest", parsed.claimDigest);
  return parsed;
}

export interface PublicPackageSignatureVerificationV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  verificationId: string;
  packageId: string;
  packageVersion: string;
  manifestDigest: string;
  claimId: string;
  claimDigest: string;
  algorithm: "none" | "ed25519";
  verifierId: string;
  verifierIndependent: boolean;
  verificationState: "not_observed" | "failed" | "verified_external";
  cryptographicVerificationReported: boolean;
  evidenceDigest: string;
  signingKeyValuePresent: false;
  signatureBytesPresent: false;
  grantsCertification: false;
  grantsPublicationAuthority: false;
  verifiedAt: string;
  verificationDigest: string;
}

const signatureVerificationSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), verificationId: id, packageId: id, packageVersion: semver,
  manifestDigest: digest, claimId: id, claimDigest: digest, algorithm: z.enum(["none", "ed25519"]), verifierId: id,
  verifierIndependent: z.boolean(), verificationState: z.enum(["not_observed", "failed", "verified_external"]),
  cryptographicVerificationReported: z.boolean(), evidenceDigest: digest, signingKeyValuePresent: z.literal(false),
  signatureBytesPresent: z.literal(false), grantsCertification: z.literal(false), grantsPublicationAuthority: z.literal(false),
  verifiedAt: time, verificationDigest: digest,
}).strict();
const signatureVerificationInputSchema = z.object({ manifest: z.unknown(), claim: z.unknown(), verifierId: id,
  verificationState: z.enum(["not_observed", "failed", "verified_external"]), evidenceDigest: digest, verifiedAt: time }).strict();

export function buildPublicPackageSignatureVerificationV1(inputValue: unknown): PublicPackageSignatureVerificationV1 {
  const input = parseExactPublicPackageV1(signatureVerificationInputSchema, inputValue, "public package signature verification input"),
    manifest = parsePublicPackageManifestV1(input.manifest), claim = parsePublicPackageSignatureClaimV1(input.claim);
  if (claim.packageId !== manifest.packageId || claim.packageVersion !== manifest.packageVersion
    || claim.manifestDigest !== manifest.manifestDigest || Date.parse(input.verifiedAt) < Date.parse(claim.claimedAt)) {
    throw new PublicPackageContractErrorV1("signature_mismatch");
  }
  const verified = input.verificationState === "verified_external", observed = input.verificationState !== "not_observed";
  if ((verified && claim.claimState !== "unverified_signature_digest") || (verified && input.verifierId === manifest.producerId)) {
    throw new PublicPackageContractErrorV1("signature_mismatch");
  }
  const verificationId = `signature-verification:${manifest.packageId}:${manifest.packageVersion}`;
  const material: Omit<PublicPackageSignatureVerificationV1, "verificationDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, verificationId, packageId: manifest.packageId,
    packageVersion: manifest.packageVersion, manifestDigest: manifest.manifestDigest, claimId: claim.claimId,
    claimDigest: claim.claimDigest, algorithm: claim.algorithm, verifierId: input.verifierId,
    verifierIndependent: input.verifierId !== manifest.producerId, verificationState: input.verificationState,
    cryptographicVerificationReported: observed, evidenceDigest: input.evidenceDigest, signingKeyValuePresent: false,
    signatureBytesPresent: false, grantsCertification: false, grantsPublicationAuthority: false, verifiedAt: input.verifiedAt,
  };
  return parsePublicPackageSignatureVerificationV1({ ...material, verificationDigest: sha256Digest(material) });
}

export function parsePublicPackageSignatureVerificationV1(value: unknown): PublicPackageSignatureVerificationV1 {
  const parsed = parseExactPublicPackageV1(signatureVerificationSchema, value, "public package signature verification"),
    verified = parsed.verificationState === "verified_external", observed = parsed.verificationState !== "not_observed";
  if ((verified && (parsed.algorithm !== "ed25519" || !parsed.verifierIndependent || !parsed.cryptographicVerificationReported))
    || observed !== parsed.cryptographicVerificationReported
    || parsed.verificationId !== `signature-verification:${parsed.packageId}:${parsed.packageVersion}`) {
    throw new PublicPackageContractErrorV1("signature_mismatch");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "verificationDigest", parsed.verificationDigest);
  return parsed;
}

export const PUBLIC_RELEASE_GATE_IDS_V1 = [
  "manifest_integrity",
  "explicit_public_classification",
  "private_tree_exclusion",
  "credential_value_exclusion",
  "sbom_complete",
  "license_notice_complete",
  "provenance_complete",
  "reproducible_build",
  "compatibility_pass",
  "adapter_conformance",
  "clean_room_install",
] as const;
export type PublicReleaseGateIdV1 = (typeof PUBLIC_RELEASE_GATE_IDS_V1)[number];
export type PublicReleaseEvidenceModeV1 = "synthetic" | "external_digest_only";
export type PublicReleaseGateStateV1 = "passed" | "failed" | "not_observed";

const independentGateIds = new Set<PublicReleaseGateIdV1>([
  "explicit_public_classification", "private_tree_exclusion", "credential_value_exclusion",
  "adapter_conformance", "clean_room_install",
]);

export interface PublicReleaseGateEvidenceV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  gateId: PublicReleaseGateIdV1;
  packageId: string;
  packageVersion: string;
  manifestDigest: string;
  policyDigest: string;
  evidenceMode: PublicReleaseEvidenceModeV1;
  state: PublicReleaseGateStateV1;
  verifierId: string;
  verifierIndependent: boolean;
  independenceRequired: boolean;
  evidenceDigest: string;
  observedAt: string;
  validUntil: string;
  grantsCertification: false;
  grantsPublicationAuthority: false;
  recordDigest: string;
}

export interface PublicReleaseEvidenceBundleV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  bundleId: string;
  packageId: string;
  packageVersion: string;
  manifestDigest: string;
  policyDigest: string;
  evidenceMode: PublicReleaseEvidenceModeV1;
  records: PublicReleaseGateEvidenceV1[];
  recordSetDigest: string;
  allRequiredGatesPresent: true;
  evidenceBodiesPresent: false;
  nativeChecksPerformedByContract: false;
  grantsCertification: false;
  grantsPublicationAuthority: false;
  assembledAt: string;
  bundleDigest: string;
}

const gateId = z.enum(PUBLIC_RELEASE_GATE_IDS_V1);
const evidenceMode = z.enum(["synthetic", "external_digest_only"]);
const gateState = z.enum(["passed", "failed", "not_observed"]);
const gateEvidenceSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), gateId, packageId: id, packageVersion: semver,
  manifestDigest: digest, policyDigest: digest, evidenceMode, state: gateState, verifierId: id,
  verifierIndependent: z.boolean(), independenceRequired: z.boolean(), evidenceDigest: digest,
  observedAt: time, validUntil: time, grantsCertification: z.literal(false), grantsPublicationAuthority: z.literal(false),
  recordDigest: digest,
}).strict();
const gateEvidenceInputSchema = z.object({ manifest: z.unknown(), policy: z.unknown(), gateId,
  evidenceMode, state: gateState, verifierId: id, evidenceDigest: digest, observedAt: time, validUntil: time }).strict();
const evidenceBundleSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), bundleId: id, packageId: id, packageVersion: semver,
  manifestDigest: digest, policyDigest: digest, evidenceMode, records: z.array(gateEvidenceSchema).length(PUBLIC_RELEASE_GATE_IDS_V1.length),
  recordSetDigest: digest, allRequiredGatesPresent: z.literal(true), evidenceBodiesPresent: z.literal(false),
  nativeChecksPerformedByContract: z.literal(false), grantsCertification: z.literal(false),
  grantsPublicationAuthority: z.literal(false), assembledAt: time, bundleDigest: digest,
}).strict();

export function buildPublicReleaseGateEvidenceV1(inputValue: unknown): PublicReleaseGateEvidenceV1 {
  const input = parseExactPublicPackageV1(gateEvidenceInputSchema, inputValue, "public release gate evidence input"),
    manifest = parsePublicPackageManifestV1(input.manifest), policy = parsePublicPackageCompatibilityPolicyV1(input.policy),
    independenceRequired = independentGateIds.has(input.gateId), verifierIndependent = input.verifierId !== manifest.producerId;
  const observed = Date.parse(input.observedAt), validUntil = Date.parse(input.validUntil);
  if (policy.policyDigest !== manifest.compatibilityPolicyDigest || validUntil <= observed || validUntil - observed > 7 * 86_400_000
    || (input.state === "passed" && independenceRequired && !verifierIndependent)) {
    throw new PublicPackageContractErrorV1("evidence_mismatch");
  }
  const exactEvidenceBindings: Partial<Record<PublicReleaseGateIdV1, string>> = {
    manifest_integrity: manifest.manifestDigest,
    explicit_public_classification: manifest.classificationRegistryDigest,
    private_tree_exclusion: manifest.privateTreeScanDigest,
    credential_value_exclusion: manifest.credentialScanDigest,
    sbom_complete: manifest.sbomDigest,
    license_notice_complete: sha256Digest({ licenseInventoryDigest: manifest.licenseInventoryDigest, noticeDigest: manifest.noticeDigest }),
    provenance_complete: manifest.provenanceDigest,
  };
  if (input.state === "passed" && exactEvidenceBindings[input.gateId]
    && input.evidenceDigest !== exactEvidenceBindings[input.gateId]) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const material: Omit<PublicReleaseGateEvidenceV1, "recordDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, gateId: input.gateId, packageId: manifest.packageId,
    packageVersion: manifest.packageVersion, manifestDigest: manifest.manifestDigest, policyDigest: policy.policyDigest,
    evidenceMode: input.evidenceMode, state: input.state, verifierId: input.verifierId, verifierIndependent,
    independenceRequired, evidenceDigest: input.evidenceDigest, observedAt: input.observedAt, validUntil: input.validUntil,
    grantsCertification: false, grantsPublicationAuthority: false,
  };
  return parsePublicReleaseGateEvidenceV1({ ...material, recordDigest: sha256Digest(material) });
}

export function parsePublicReleaseGateEvidenceV1(value: unknown): PublicReleaseGateEvidenceV1 {
  const parsed = parseExactPublicPackageV1(gateEvidenceSchema, value, "public release gate evidence"),
    independenceRequired = independentGateIds.has(parsed.gateId);
  if (parsed.independenceRequired !== independenceRequired
    || (parsed.state === "passed" && independenceRequired && !parsed.verifierIndependent)
    || Date.parse(parsed.validUntil) <= Date.parse(parsed.observedAt)
    || Date.parse(parsed.validUntil) - Date.parse(parsed.observedAt) > 7 * 86_400_000) {
    throw new PublicPackageContractErrorV1("evidence_mismatch");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "recordDigest", parsed.recordDigest);
  return parsed;
}

export function buildPublicReleaseEvidenceBundleV1(inputValue: unknown): PublicReleaseEvidenceBundleV1 {
  const input = parseExactPublicPackageV1(z.object({ manifest: z.unknown(), policy: z.unknown(), evidenceMode,
    records: z.array(z.unknown()).length(PUBLIC_RELEASE_GATE_IDS_V1.length), assembledAt: time }).strict(),
  inputValue, "public release evidence bundle input"), manifest = parsePublicPackageManifestV1(input.manifest),
    policy = parsePublicPackageCompatibilityPolicyV1(input.policy), records = input.records.map(parsePublicReleaseGateEvidenceV1);
  if (policy.policyDigest !== manifest.compatibilityPolicyDigest
    || records.map((record) => record.gateId).join("|") !== PUBLIC_RELEASE_GATE_IDS_V1.join("|")
    || records.some((record) => record.packageId !== manifest.packageId || record.packageVersion !== manifest.packageVersion
      || record.manifestDigest !== manifest.manifestDigest || record.policyDigest !== policy.policyDigest
      || record.evidenceMode !== input.evidenceMode || Date.parse(record.observedAt) > Date.parse(input.assembledAt))) {
    throw new PublicPackageContractErrorV1("evidence_mismatch");
  }
  const recordSetDigest = sha256Digest(records.map((record) => record.recordDigest)),
    bundleId = `release-evidence:${manifest.packageId}:${manifest.packageVersion}`;
  const material: Omit<PublicReleaseEvidenceBundleV1, "bundleDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, bundleId, packageId: manifest.packageId,
    packageVersion: manifest.packageVersion, manifestDigest: manifest.manifestDigest, policyDigest: policy.policyDigest,
    evidenceMode: input.evidenceMode, records, recordSetDigest, allRequiredGatesPresent: true, evidenceBodiesPresent: false,
    nativeChecksPerformedByContract: false, grantsCertification: false, grantsPublicationAuthority: false,
    assembledAt: input.assembledAt,
  };
  return parsePublicReleaseEvidenceBundleV1({ ...material, bundleDigest: sha256Digest(material) });
}

export function parsePublicReleaseEvidenceBundleV1(value: unknown): PublicReleaseEvidenceBundleV1 {
  const parsed = parseExactPublicPackageV1(evidenceBundleSchema, value, "public release evidence bundle");
  parsed.records.forEach(parsePublicReleaseGateEvidenceV1);
  if (parsed.records.map((record) => record.gateId).join("|") !== PUBLIC_RELEASE_GATE_IDS_V1.join("|")
    || parsed.records.some((record) => record.packageId !== parsed.packageId || record.packageVersion !== parsed.packageVersion
      || record.manifestDigest !== parsed.manifestDigest || record.policyDigest !== parsed.policyDigest
      || record.evidenceMode !== parsed.evidenceMode || Date.parse(record.observedAt) > Date.parse(parsed.assembledAt))
    || parsed.recordSetDigest !== sha256Digest(parsed.records.map((record) => record.recordDigest))) {
    throw new PublicPackageContractErrorV1("evidence_mismatch");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "bundleDigest", parsed.bundleDigest);
  return parsed;
}

export type PublicPackageReleaseBlockerV1 = PublicReleaseGateIdV1 | "compatibility_rejected" |
  "signature_not_verified" | "synthetic_evidence_only" | "evidence_expired";
export interface PublicPackageReleaseCandidateV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  candidateId: string;
  packageId: string;
  packageVersion: string;
  manifestDigest: string;
  policyDigest: string;
  compatibilityAssessmentDigest: string;
  signatureClaimDigest: string;
  signatureVerificationDigest: string;
  evidenceBundleDigest: string;
  evidenceMode: PublicReleaseEvidenceModeV1;
  state: "blocked" | "synthetic_candidate_only" | "candidate_for_independent_release_review";
  blockers: PublicPackageReleaseBlockerV1[];
  allGatesReportedPass: boolean;
  compatibilityAccepted: boolean;
  externalSignatureVerificationReported: boolean;
  certificationState: "not_certified";
  certificationEligibility: "not_eligible" | "eligible_for_independent_review";
  freshOwnerReleaseDecisionRequired: true;
  independentSecurityReviewRequired: true;
  cleanRoomInstallEvidenceRequired: true;
  contentBytesInspectedByContract: false;
  buildPerformedByContract: false;
  signingPerformedByContract: false;
  publicationAttempted: false;
  grantsCertification: false;
  grantsInstallAuthority: false;
  grantsPublicationAuthority: false;
  assessedAt: string;
  candidateDigest: string;
}

const releaseBlocker = z.enum([...PUBLIC_RELEASE_GATE_IDS_V1, "compatibility_rejected", "signature_not_verified",
  "synthetic_evidence_only", "evidence_expired"]);
const releaseCandidateSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), candidateId: id, packageId: id, packageVersion: semver,
  manifestDigest: digest, policyDigest: digest, compatibilityAssessmentDigest: digest, signatureClaimDigest: digest,
  signatureVerificationDigest: digest, evidenceBundleDigest: digest, evidenceMode,
  state: z.enum(["blocked", "synthetic_candidate_only", "candidate_for_independent_release_review"]),
  blockers: z.array(releaseBlocker).max(PUBLIC_RELEASE_GATE_IDS_V1.length + 4), allGatesReportedPass: z.boolean(),
  compatibilityAccepted: z.boolean(), externalSignatureVerificationReported: z.boolean(), certificationState: z.literal("not_certified"),
  certificationEligibility: z.enum(["not_eligible", "eligible_for_independent_review"]),
  freshOwnerReleaseDecisionRequired: z.literal(true), independentSecurityReviewRequired: z.literal(true),
  cleanRoomInstallEvidenceRequired: z.literal(true), contentBytesInspectedByContract: z.literal(false),
  buildPerformedByContract: z.literal(false), signingPerformedByContract: z.literal(false), publicationAttempted: z.literal(false),
  grantsCertification: z.literal(false), grantsInstallAuthority: z.literal(false), grantsPublicationAuthority: z.literal(false),
  assessedAt: time, candidateDigest: digest,
}).strict();

export function assessPublicPackageReleaseCandidateV1(inputValue: unknown): PublicPackageReleaseCandidateV1 {
  const input = parseExactPublicPackageV1(z.object({ manifest: z.unknown(), policy: z.unknown(), compatibility: z.unknown(),
    signatureClaim: z.unknown(), signatureVerification: z.unknown(), evidenceBundle: z.unknown(), assessedAt: time }).strict(),
  inputValue, "public package release candidate input"), manifest = parsePublicPackageManifestV1(input.manifest),
    policy = parsePublicPackageCompatibilityPolicyV1(input.policy), compatibility = parsePublicPackageCompatibilityAssessmentV1(input.compatibility),
    claim = parsePublicPackageSignatureClaimV1(input.signatureClaim), verification = parsePublicPackageSignatureVerificationV1(input.signatureVerification),
    bundle = parsePublicReleaseEvidenceBundleV1(input.evidenceBundle);
  const bindingMismatch = policy.policyDigest !== manifest.compatibilityPolicyDigest
    || compatibility.packageId !== manifest.packageId || compatibility.packageVersion !== manifest.packageVersion
    || compatibility.manifestDigest !== manifest.manifestDigest || compatibility.policyDigest !== policy.policyDigest
    || claim.packageId !== manifest.packageId || claim.packageVersion !== manifest.packageVersion || claim.manifestDigest !== manifest.manifestDigest
    || verification.packageId !== manifest.packageId || verification.packageVersion !== manifest.packageVersion
    || verification.manifestDigest !== manifest.manifestDigest || verification.claimDigest !== claim.claimDigest
    || bundle.packageId !== manifest.packageId || bundle.packageVersion !== manifest.packageVersion
    || bundle.manifestDigest !== manifest.manifestDigest || bundle.policyDigest !== policy.policyDigest;
  if (bindingMismatch || Date.parse(input.assessedAt) < Date.parse(bundle.assembledAt)) {
    throw new PublicPackageContractErrorV1("evidence_mismatch");
  }
  const blockers: PublicPackageReleaseBlockerV1[] = [];
  for (const record of bundle.records) {
    if (record.state !== "passed") blockers.push(record.gateId);
    else if (Date.parse(record.validUntil) < Date.parse(input.assessedAt)) blockers.push("evidence_expired");
  }
  if (!compatibility.compatible) blockers.push("compatibility_rejected");
  if (verification.verificationState !== "verified_external") blockers.push("signature_not_verified");
  if (bundle.evidenceMode === "synthetic") blockers.push("synthetic_evidence_only");
  const uniqueBlockers = [...new Set(blockers)], allGatesReportedPass = bundle.records.every((record) => record.state === "passed"),
    compatibilityAccepted = compatibility.compatible,
    externalSignatureVerificationReported = verification.verificationState === "verified_external",
    externallyReady = uniqueBlockers.length === 0,
    state = externallyReady ? "candidate_for_independent_release_review" : bundle.evidenceMode === "synthetic"
      && uniqueBlockers.length === 1 && uniqueBlockers[0] === "synthetic_evidence_only" ? "synthetic_candidate_only" : "blocked",
    candidateId = `release-candidate:${manifest.packageId}:${manifest.packageVersion}`;
  const material: Omit<PublicPackageReleaseCandidateV1, "candidateDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, candidateId, packageId: manifest.packageId,
    packageVersion: manifest.packageVersion, manifestDigest: manifest.manifestDigest, policyDigest: policy.policyDigest,
    compatibilityAssessmentDigest: compatibility.assessmentDigest, signatureClaimDigest: claim.claimDigest,
    signatureVerificationDigest: verification.verificationDigest, evidenceBundleDigest: bundle.bundleDigest,
    evidenceMode: bundle.evidenceMode, state, blockers: uniqueBlockers, allGatesReportedPass, compatibilityAccepted,
    externalSignatureVerificationReported, certificationState: "not_certified",
    certificationEligibility: externallyReady ? "eligible_for_independent_review" : "not_eligible",
    freshOwnerReleaseDecisionRequired: true, independentSecurityReviewRequired: true,
    cleanRoomInstallEvidenceRequired: true, contentBytesInspectedByContract: false, buildPerformedByContract: false,
    signingPerformedByContract: false, publicationAttempted: false, grantsCertification: false,
    grantsInstallAuthority: false, grantsPublicationAuthority: false, assessedAt: input.assessedAt,
  };
  return parsePublicPackageReleaseCandidateV1({ ...material, candidateDigest: sha256Digest(material) });
}

export function parsePublicPackageReleaseCandidateV1(value: unknown): PublicPackageReleaseCandidateV1 {
  const parsed = parseExactPublicPackageV1(releaseCandidateSchema, value, "public package release candidate"),
    externallyReady = parsed.blockers.length === 0,
    expectedState = externallyReady ? "candidate_for_independent_release_review" : parsed.evidenceMode === "synthetic"
      && parsed.blockers.length === 1 && parsed.blockers[0] === "synthetic_evidence_only" ? "synthetic_candidate_only" : "blocked";
  if (new Set(parsed.blockers).size !== parsed.blockers.length || parsed.state !== expectedState
    || parsed.certificationEligibility !== (externallyReady ? "eligible_for_independent_review" : "not_eligible")
    || parsed.candidateId !== `release-candidate:${parsed.packageId}:${parsed.packageVersion}`
    || (parsed.state !== "blocked" && (!parsed.allGatesReportedPass || !parsed.compatibilityAccepted
      || !parsed.externalSignatureVerificationReported))) {
    throw new PublicPackageContractErrorV1("evidence_mismatch");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "candidateDigest", parsed.candidateDigest);
  return parsed;
}

export interface PublicPackageReleaseProjectionV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  candidateId: string;
  packageId: string;
  packageVersion: string;
  state: PublicPackageReleaseCandidateV1["state"];
  blockerCodes: PublicPackageReleaseBlockerV1[];
  entryCount: number;
  publicClassCount: number;
  allGatesReportedPass: boolean;
  compatibilityAccepted: boolean;
  externalSignatureVerificationReported: boolean;
  certificationState: "not_certified";
  certificationEligibility: PublicPackageReleaseCandidateV1["certificationEligibility"];
  evidenceMode: PublicReleaseEvidenceModeV1;
  publicationAvailable: false;
  signingAvailable: false;
  containsEntryPaths: false;
  containsEvidenceReferences: false;
  containsPrivateValues: false;
  containsCredentialValues: false;
  grantsCertification: false;
  grantsInstallAuthority: false;
  grantsPublicationAuthority: false;
  assessedAt: string;
  projectionDigest: string;
}

const releaseProjectionSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), candidateId: id, packageId: id, packageVersion: semver,
  state: z.enum(["blocked", "synthetic_candidate_only", "candidate_for_independent_release_review"]),
  blockerCodes: z.array(releaseBlocker).max(PUBLIC_RELEASE_GATE_IDS_V1.length + 4),
  entryCount: z.number().int().positive().max(5_000), publicClassCount: z.number().int().positive().max(PUBLIC_PACKAGE_CLASS_IDS_V1.length),
  allGatesReportedPass: z.boolean(), compatibilityAccepted: z.boolean(), externalSignatureVerificationReported: z.boolean(),
  certificationState: z.literal("not_certified"), certificationEligibility: z.enum(["not_eligible", "eligible_for_independent_review"]),
  evidenceMode, publicationAvailable: z.literal(false), signingAvailable: z.literal(false), containsEntryPaths: z.literal(false),
  containsEvidenceReferences: z.literal(false), containsPrivateValues: z.literal(false), containsCredentialValues: z.literal(false),
  grantsCertification: z.literal(false), grantsInstallAuthority: z.literal(false), grantsPublicationAuthority: z.literal(false),
  assessedAt: time, projectionDigest: digest,
}).strict();

export function projectPublicPackageReleaseV1(inputValue: unknown): PublicPackageReleaseProjectionV1 {
  const input = parseExactPublicPackageV1(z.object({ manifest: z.unknown(), candidate: z.unknown() }).strict(),
    inputValue, "public package release projection input"), manifest = parsePublicPackageManifestV1(input.manifest),
    candidate = parsePublicPackageReleaseCandidateV1(input.candidate);
  if (candidate.packageId !== manifest.packageId || candidate.packageVersion !== manifest.packageVersion
    || candidate.manifestDigest !== manifest.manifestDigest) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const material: Omit<PublicPackageReleaseProjectionV1, "projectionDigest"> = {
    contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, candidateId: candidate.candidateId, packageId: candidate.packageId,
    packageVersion: candidate.packageVersion, state: candidate.state, blockerCodes: [...candidate.blockers],
    entryCount: manifest.entries.length, publicClassCount: new Set(manifest.entries.map((entry) => entry.classId)).size,
    allGatesReportedPass: candidate.allGatesReportedPass, compatibilityAccepted: candidate.compatibilityAccepted,
    externalSignatureVerificationReported: candidate.externalSignatureVerificationReported, certificationState: "not_certified",
    certificationEligibility: candidate.certificationEligibility, evidenceMode: candidate.evidenceMode,
    publicationAvailable: false, signingAvailable: false, containsEntryPaths: false, containsEvidenceReferences: false,
    containsPrivateValues: false, containsCredentialValues: false, grantsCertification: false,
    grantsInstallAuthority: false, grantsPublicationAuthority: false, assessedAt: candidate.assessedAt,
  };
  return parsePublicPackageReleaseProjectionV1({ ...material, projectionDigest: sha256Digest(material) });
}

export function parsePublicPackageReleaseProjectionV1(value: unknown): PublicPackageReleaseProjectionV1 {
  const parsed = parseExactPublicPackageV1(releaseProjectionSchema, value, "public package release projection");
  if (new Set(parsed.blockerCodes).size !== parsed.blockerCodes.length) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "projectionDigest", parsed.projectionDigest);
  return parsed;
}

export interface PublicPackageDisabledPublicationReceiptV1 {
  contractVersion: typeof PUBLIC_PACKAGE_CONTRACT_V1;
  receiptId: string;
  candidateId: string;
  candidateDigest: string;
  packageId: string;
  packageVersion: string;
  disposition: "disabled_before_provider_contact";
  safeReasonCode: "public_release_not_authorized";
  providerClientPresent: false;
  registryDestinationPresent: false;
  credentialReferencePresent: false;
  networkContacted: false;
  signingAttempted: false;
  buildAttempted: false;
  uploadAttempted: false;
  publicationAttempted: false;
  grantsCertification: false;
  grantsInstallAuthority: false;
  grantsPublicationAuthority: false;
  recordedAt: string;
  receiptDigest: string;
}

const disabledPublicationReceiptSchema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_CONTRACT_V1), receiptId: id, candidateId: id, candidateDigest: digest,
  packageId: id, packageVersion: semver, disposition: z.literal("disabled_before_provider_contact"),
  safeReasonCode: z.literal("public_release_not_authorized"), providerClientPresent: z.literal(false),
  registryDestinationPresent: z.literal(false), credentialReferencePresent: z.literal(false), networkContacted: z.literal(false),
  signingAttempted: z.literal(false), buildAttempted: z.literal(false), uploadAttempted: z.literal(false),
  publicationAttempted: z.literal(false), grantsCertification: z.literal(false), grantsInstallAuthority: z.literal(false),
  grantsPublicationAuthority: z.literal(false), recordedAt: time, receiptDigest: digest,
}).strict();

export function createDisabledPublicPackagePublisherV1(): {
  publish(candidate: unknown, recordedAt: string): PublicPackageDisabledPublicationReceiptV1;
} {
  return Object.freeze({ publish(candidateValue: unknown, recordedAt: string) {
    const candidate = parsePublicPackageReleaseCandidateV1(candidateValue), parsedTime = time.safeParse(recordedAt);
    if (!parsedTime.success || Date.parse(recordedAt) < Date.parse(candidate.assessedAt)) {
      throw new PublicPackageContractErrorV1("invalid_input");
    }
    const receiptId = `publication-disabled:${candidate.packageId}:${candidate.packageVersion}`;
    const material: Omit<PublicPackageDisabledPublicationReceiptV1, "receiptDigest"> = {
      contractVersion: PUBLIC_PACKAGE_CONTRACT_V1, receiptId, candidateId: candidate.candidateId,
      candidateDigest: candidate.candidateDigest, packageId: candidate.packageId, packageVersion: candidate.packageVersion,
      disposition: "disabled_before_provider_contact", safeReasonCode: "public_release_not_authorized",
      providerClientPresent: false, registryDestinationPresent: false, credentialReferencePresent: false,
      networkContacted: false, signingAttempted: false, buildAttempted: false, uploadAttempted: false,
      publicationAttempted: false, grantsCertification: false, grantsInstallAuthority: false,
      grantsPublicationAuthority: false, recordedAt,
    };
    return parsePublicPackageDisabledPublicationReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
  } });
}

export function parsePublicPackageDisabledPublicationReceiptV1(value: unknown): PublicPackageDisabledPublicationReceiptV1 {
  const parsed = parseExactPublicPackageV1(disabledPublicationReceiptSchema, value, "public package disabled publication receipt");
  if (parsed.receiptId !== `publication-disabled:${parsed.packageId}:${parsed.packageVersion}`) {
    throw new PublicPackageContractErrorV1("publication_disabled");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "receiptDigest", parsed.receiptDigest);
  return parsed;
}
