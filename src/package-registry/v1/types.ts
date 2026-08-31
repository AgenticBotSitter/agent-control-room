import type { HarnessAdapterManifestV1, HarnessLifecycleVerb } from "../../harness/v1";

export const PACKAGE_REGISTRY_SCHEMA_VERSION_V1 = "control-room-package-registry/v1" as const;

export type PackageKindV1 = "procedure" | "knowledge";

export interface PackageProvenanceV1 {
  sourceType: "owner" | "repository" | "reviewed_agent" | "imported" | "run_outcome";
  sourceId: string;
  sourceDigest: string;
  producerId: string;
  producedAt: string;
}

export interface PackageCompatibilityV1 {
  adapterId: string;
  adapterVersion: string;
  harness: "hermes" | "codex" | "claude" | "other";
  harnessVersion: string;
  requiredVerbs: HarnessLifecycleVerb[];
  supportedPlatforms: Array<"linux" | "macos" | "windows">;
}

export interface ProcedureContentV1 {
  objective: string;
  steps: Array<{ id: string; instruction: string }>;
  acceptanceSteps: Array<{ id: string; check: string }>;
  inputRoles: string[];
  outputRoles: string[];
}

export interface KnowledgeContentV1 {
  facts: Array<{
    id: string;
    subject: string;
    predicate: string;
    value: string;
    evidenceDigest: string;
    observedAt?: string;
    validUntil?: string;
  }>;
  references: Array<{
    id: string;
    kind: "artifact" | "document" | "repository" | "external_reference";
    locatorDigest: string;
    contentDigest: string;
  }>;
}

interface PackageBaseV1 {
  schemaVersion: typeof PACKAGE_REGISTRY_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  kind: PackageKindV1;
  name: string;
  version: string;
  provenance: PackageProvenanceV1;
  compatibility: PackageCompatibilityV1[];
  separation: {
    grantsAuthority: false;
    suppliesPolicy: false;
    containsCredentials: false;
  };
  createdAt: string;
}

export interface ProcedurePackageV1 extends PackageBaseV1 {
  kind: "procedure";
  content: ProcedureContentV1;
}

export interface KnowledgePackageV1 extends PackageBaseV1 {
  kind: "knowledge";
  content: KnowledgeContentV1;
}

export type RegistryPackageV1 = ProcedurePackageV1 | KnowledgePackageV1;

export interface StoredPackageV1 {
  package: RegistryPackageV1;
  packageDigest: string;
}

export interface PackageReviewV1 {
  schemaVersion: typeof PACKAGE_REGISTRY_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  packageId: string;
  packageDigest: string;
  producerId: string;
  reviewerId: string;
  decision: "accepted" | "rejected";
  reasonCode: string;
  evidenceDigests: string[];
  reviewedAt: string;
}

export interface PackageHarnessMappingInputV1 {
  schemaVersion: typeof PACKAGE_REGISTRY_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  packageId: string;
  packageDigest: string;
  adapterId: string;
  adapterVersion: string;
  harness: "hermes" | "codex" | "claude" | "other";
  harnessVersion: string;
  platform: "linux" | "macos" | "windows";
  verifiedVerbs: HarnessLifecycleVerb[];
  decision: "verified" | "rejected";
  verifierId: string;
  evidenceDigests: string[];
  verifiedAt: string;
}

export interface PackageHarnessMappingV1 extends PackageHarnessMappingInputV1 {
  manifestDigest: string;
  manifest: HarnessAdapterManifestV1;
}

export interface PackageActivationCommandV1 {
  schemaVersion: typeof PACKAGE_REGISTRY_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  packageId: string;
  packageDigest: string;
  reviewId: string;
  mappingId: string;
  actorId: string;
  expectedActiveDigest: string | null;
  action: "promote" | "rollback";
  reasonCode: string;
  activatedAt: string;
}

export interface PackagePromotionV1 extends PackageActivationCommandV1 {
  packageKind: PackageKindV1;
  packageName: string;
  priorPackageId: string | null;
  priorPackageDigest: string | null;
  channelRevision: number;
  promotionDigest: string;
}

export interface ResolvedActivePackageV1 extends StoredPackageV1 {
  promotion: PackagePromotionV1;
  mapping: PackageHarnessMappingV1;
  trust: "reviewed_and_active";
  grantsAuthority: false;
  suppliesPolicy: false;
  canApprove: false;
  canDispatch: false;
  canExecute: false;
  requiresSeparateAuthority: true;
}

export interface PackageEligibilityV1 {
  packageId: string;
  packageDigest: string;
  adapterId: string;
  adapterVersion: string;
  platform: "linux" | "macos" | "windows";
  instructionCompatible: boolean;
  reasons: string[];
  grantsAuthority: false;
  canExecuteWithoutAuthority: false;
}
