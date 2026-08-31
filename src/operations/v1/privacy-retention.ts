import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";

export const OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1 = "control-room-operations-privacy-retention/v1" as const;
export const OPERATIONS_DATA_CLASS_IDS_V1 = [
  "data-class:operations:scope-identity",
  "data-class:operations:source-projection",
  "data-class:operations:work-lifecycle",
  "data-class:operations:approval-authority",
  "data-class:operations:audit-security",
  "data-class:operations:effect-replay",
  "data-class:operations:credential-reference",
  "data-class:operations:observability",
  "data-class:operations:artifact-metadata",
  "data-class:operations:private-artifact-body",
  "data-class:operations:public-artifact-body",
  "data-class:operations:transient-transport-body",
  "data-class:operations:backup-recovery-material",
  "data-class:operations:quarantine-evidence",
] as const;
export type OperationsDataClassIdV1 = (typeof OPERATIONS_DATA_CLASS_IDS_V1)[number];
export type OperationsRetentionKindV1 = "configurable_duration" | "maximum_dependency_horizon" |
  "source_authoritative" | "indefinite_preservation";
export type OperationsDispositionModeV1 = "delete_body_review" | "compact_to_digest_tombstone_review" |
  "source_reconciliation_review" | "never_delete_full_record";

export interface OperationsDataClassDefinitionV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  dataClassId: OperationsDataClassIdV1;
  purposeCode: string;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  privacyAssociation: "none" | "pseudonymous" | "personal_possible";
  custody: "control_plane" | "broker_private" | "artifact_store_private" | "public_destination";
  representation: "sanitized_metadata" | "digest_only" | "private_body" | "public_body";
  retentionKind: OperationsRetentionKindV1;
  dependencyHorizonRequired: boolean;
  dispositionMode: OperationsDispositionModeV1;
  auditPreservation: "ordinary_record" | "digest_tombstone_required" | "append_only_full_record";
  legalHoldAlwaysWins: true;
  policyConfigurationRequired: true;
  rawMaterialStoredInControlPlane: false;
  locatorValueStoredInControlPlane: false;
  sensitiveMaterialAllowed: false;
  automaticDispositionAllowed: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  definitionDigest: string;
}

export interface OperationsDataClassRegistryV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  registryId: "registry:operations:privacy-data-classes:v1";
  definitions: OperationsDataClassDefinitionV1[];
  jurisdictionSpecificRulesPresent: false;
  makesLegalDeterminations: false;
  rawMaterialPresent: false;
  locatorValuesPresent: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  registryDigest: string;
}

type ClassSpec = Omit<OperationsDataClassDefinitionV1, "contractVersion" | "dataClassId" | "legalHoldAlwaysWins" |
  "policyConfigurationRequired" | "rawMaterialStoredInControlPlane" | "locatorValueStoredInControlPlane" |
  "sensitiveMaterialAllowed" | "automaticDispositionAllowed" | "grantsApproval" | "grantsDeletionAuthority" |
  "grantsExecutionAuthority" | "definitionDigest">;
const classSpecs: Record<OperationsDataClassIdV1, ClassSpec> = {
  "data-class:operations:scope-identity": { purposeCode: "scope_and_identity_binding", sensitivity: "confidential",
    privacyAssociation: "pseudonymous", custody: "control_plane", representation: "sanitized_metadata",
    retentionKind: "maximum_dependency_horizon", dependencyHorizonRequired: true,
    dispositionMode: "compact_to_digest_tombstone_review", auditPreservation: "digest_tombstone_required" },
  "data-class:operations:source-projection": { purposeCode: "source_versioned_projection", sensitivity: "confidential",
    privacyAssociation: "personal_possible", custody: "control_plane", representation: "sanitized_metadata",
    retentionKind: "source_authoritative", dependencyHorizonRequired: false,
    dispositionMode: "source_reconciliation_review", auditPreservation: "ordinary_record" },
  "data-class:operations:work-lifecycle": { purposeCode: "work_job_attempt_truth", sensitivity: "confidential",
    privacyAssociation: "pseudonymous", custody: "control_plane", representation: "sanitized_metadata",
    retentionKind: "maximum_dependency_horizon", dependencyHorizonRequired: true,
    dispositionMode: "compact_to_digest_tombstone_review", auditPreservation: "digest_tombstone_required" },
  "data-class:operations:approval-authority": { purposeCode: "approval_and_authority_evidence", sensitivity: "restricted",
    privacyAssociation: "pseudonymous", custody: "control_plane", representation: "digest_only",
    retentionKind: "maximum_dependency_horizon", dependencyHorizonRequired: true,
    dispositionMode: "compact_to_digest_tombstone_review", auditPreservation: "digest_tombstone_required" },
  "data-class:operations:audit-security": { purposeCode: "audit_chain_and_security_evidence", sensitivity: "restricted",
    privacyAssociation: "pseudonymous", custody: "control_plane", representation: "digest_only",
    retentionKind: "indefinite_preservation", dependencyHorizonRequired: true,
    dispositionMode: "never_delete_full_record", auditPreservation: "append_only_full_record" },
  "data-class:operations:effect-replay": { purposeCode: "effect_replay_and_idempotency_truth", sensitivity: "restricted",
    privacyAssociation: "pseudonymous", custody: "control_plane", representation: "digest_only",
    retentionKind: "maximum_dependency_horizon", dependencyHorizonRequired: true,
    dispositionMode: "compact_to_digest_tombstone_review", auditPreservation: "digest_tombstone_required" },
  "data-class:operations:credential-reference": { purposeCode: "broker_private_reference_metadata", sensitivity: "restricted",
    privacyAssociation: "pseudonymous", custody: "broker_private", representation: "digest_only",
    retentionKind: "maximum_dependency_horizon", dependencyHorizonRequired: true,
    dispositionMode: "delete_body_review", auditPreservation: "ordinary_record" },
  "data-class:operations:observability": { purposeCode: "sanitized_health_and_monitoring", sensitivity: "internal",
    privacyAssociation: "pseudonymous", custody: "control_plane", representation: "sanitized_metadata",
    retentionKind: "configurable_duration", dependencyHorizonRequired: false,
    dispositionMode: "delete_body_review", auditPreservation: "ordinary_record" },
  "data-class:operations:artifact-metadata": { purposeCode: "immutable_artifact_lineage", sensitivity: "confidential",
    privacyAssociation: "pseudonymous", custody: "control_plane", representation: "digest_only",
    retentionKind: "maximum_dependency_horizon", dependencyHorizonRequired: true,
    dispositionMode: "compact_to_digest_tombstone_review", auditPreservation: "digest_tombstone_required" },
  "data-class:operations:private-artifact-body": { purposeCode: "private_artifact_content", sensitivity: "restricted",
    privacyAssociation: "personal_possible", custody: "artifact_store_private", representation: "private_body",
    retentionKind: "maximum_dependency_horizon", dependencyHorizonRequired: true,
    dispositionMode: "delete_body_review", auditPreservation: "ordinary_record" },
  "data-class:operations:public-artifact-body": { purposeCode: "published_artifact_content", sensitivity: "public",
    privacyAssociation: "personal_possible", custody: "public_destination", representation: "public_body",
    retentionKind: "source_authoritative", dependencyHorizonRequired: false,
    dispositionMode: "source_reconciliation_review", auditPreservation: "ordinary_record" },
  "data-class:operations:transient-transport-body": { purposeCode: "bounded_transport_processing", sensitivity: "restricted",
    privacyAssociation: "personal_possible", custody: "broker_private", representation: "private_body",
    retentionKind: "configurable_duration", dependencyHorizonRequired: false,
    dispositionMode: "delete_body_review", auditPreservation: "ordinary_record" },
  "data-class:operations:backup-recovery-material": { purposeCode: "backup_wal_and_recovery_material", sensitivity: "restricted",
    privacyAssociation: "personal_possible", custody: "artifact_store_private", representation: "private_body",
    retentionKind: "maximum_dependency_horizon", dependencyHorizonRequired: true,
    dispositionMode: "delete_body_review", auditPreservation: "ordinary_record" },
  "data-class:operations:quarantine-evidence": { purposeCode: "quarantine_reason_and_integrity_truth", sensitivity: "restricted",
    privacyAssociation: "pseudonymous", custody: "control_plane", representation: "digest_only",
    retentionKind: "maximum_dependency_horizon", dependencyHorizonRequired: true,
    dispositionMode: "compact_to_digest_tombstone_review", auditPreservation: "digest_tombstone_required" },
};

const dataClassId = z.enum(OPERATIONS_DATA_CLASS_IDS_V1);
const definitionSchema = z.object({ contractVersion: z.literal(OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1), dataClassId,
  purposeCode: id, sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
  privacyAssociation: z.enum(["none", "pseudonymous", "personal_possible"]),
  custody: z.enum(["control_plane", "broker_private", "artifact_store_private", "public_destination"]),
  representation: z.enum(["sanitized_metadata", "digest_only", "private_body", "public_body"]),
  retentionKind: z.enum(["configurable_duration", "maximum_dependency_horizon", "source_authoritative", "indefinite_preservation"]),
  dependencyHorizonRequired: z.boolean(), dispositionMode: z.enum(["delete_body_review", "compact_to_digest_tombstone_review",
    "source_reconciliation_review", "never_delete_full_record"]),
  auditPreservation: z.enum(["ordinary_record", "digest_tombstone_required", "append_only_full_record"]),
  legalHoldAlwaysWins: z.literal(true), policyConfigurationRequired: z.literal(true),
  rawMaterialStoredInControlPlane: z.literal(false), locatorValueStoredInControlPlane: z.literal(false),
  sensitiveMaterialAllowed: z.literal(false), automaticDispositionAllowed: z.literal(false), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), definitionDigest: digest }).strict();
const registrySchema = z.object({ contractVersion: z.literal(OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1),
  registryId: z.literal("registry:operations:privacy-data-classes:v1"), definitions: z.array(definitionSchema).length(14),
  jurisdictionSpecificRulesPresent: z.literal(false), makesLegalDeterminations: z.literal(false), rawMaterialPresent: z.literal(false),
  locatorValuesPresent: z.literal(false), grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), registryDigest: digest }).strict();

function buildDefinition(currentId: OperationsDataClassIdV1): OperationsDataClassDefinitionV1 {
  const material: Omit<OperationsDataClassDefinitionV1, "definitionDigest"> = {
    contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1, dataClassId: currentId, ...classSpecs[currentId],
    legalHoldAlwaysWins: true, policyConfigurationRequired: true, rawMaterialStoredInControlPlane: false,
    locatorValueStoredInControlPlane: false, sensitiveMaterialAllowed: false, automaticDispositionAllowed: false,
    grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false };
  return { ...material, definitionDigest: sha256Digest(material) };
}

export function buildOperationsDataClassRegistryV1(): OperationsDataClassRegistryV1 {
  const material: Omit<OperationsDataClassRegistryV1, "registryDigest"> = {
    contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1, registryId: "registry:operations:privacy-data-classes:v1",
    definitions: OPERATIONS_DATA_CLASS_IDS_V1.map(buildDefinition), jurisdictionSpecificRulesPresent: false,
    makesLegalDeterminations: false, rawMaterialPresent: false, locatorValuesPresent: false, grantsApproval: false,
    grantsDeletionAuthority: false, grantsExecutionAuthority: false };
  return parseOperationsDataClassRegistryV1({ ...material, registryDigest: sha256Digest(material) });
}

export function parseOperationsDataClassDefinitionV1(value: unknown): OperationsDataClassDefinitionV1 {
  const parsed = parseExactOperationsV1(definitionSchema, value, "operations privacy data class"), expected = buildDefinition(parsed.dataClassId);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new OperationsContractErrorV1("scope_mismatch");
  return parsed;
}

export function parseOperationsDataClassRegistryV1(value: unknown): OperationsDataClassRegistryV1 {
  const parsed = parseExactOperationsV1(registrySchema, value, "operations privacy data class registry");
  if (parsed.definitions.map((item) => item.dataClassId).join("|") !== OPERATIONS_DATA_CLASS_IDS_V1.join("|")) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  parsed.definitions.forEach(parseOperationsDataClassDefinitionV1);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "registryDigest", parsed.registryDigest); return parsed;
}

export type OperationsPolicyRetentionStateV1 = "configured_duration" | "blocked_unconfigured" |
  "source_authoritative" | "indefinite_preservation";
export interface OperationsPrivacyRetentionRuleV1 {
  ruleId: string;
  dataClassId: OperationsDataClassIdV1;
  retentionState: OperationsPolicyRetentionStateV1;
  retainForDays?: number;
  sourcePolicyDigest?: string;
  legalHoldWins: true;
  ownerReviewRequired: true;
  automaticDispositionAllowed: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  ruleDigest: string;
}
export interface OperationsPrivacyRetentionPolicyV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  policyId: string;
  revision: number;
  previousPolicyDigest?: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  registryDigest: string;
  rules: OperationsPrivacyRetentionRuleV1[];
  legalRulesSuppliedExternally: true;
  makesLegalDeterminations: false;
  defaultDeletionAllowed: false;
  automaticDispositionAllowed: false;
  nativeExecutorPresent: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  effectiveAt: string;
  policyDigest: string;
}

const retentionState = z.enum(["configured_duration", "blocked_unconfigured", "source_authoritative", "indefinite_preservation"]);
const ruleSchema = z.object({ ruleId: id, dataClassId, retentionState, retainForDays: z.number().int().min(0).max(36_500).optional(),
  sourcePolicyDigest: digest.optional(), legalHoldWins: z.literal(true), ownerReviewRequired: z.literal(true),
  automaticDispositionAllowed: z.literal(false), grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  ruleDigest: digest }).strict();
const policySchema = z.object({ contractVersion: z.literal(OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1), policyId: id,
  revision: z.number().int().positive(), previousPolicyDigest: digest.optional(), tenantId: id, workspaceId: id, projectId: id,
  registryDigest: digest, rules: z.array(ruleSchema).length(14), legalRulesSuppliedExternally: z.literal(true),
  makesLegalDeterminations: z.literal(false), defaultDeletionAllowed: z.literal(false), automaticDispositionAllowed: z.literal(false),
  nativeExecutorPresent: z.literal(false), grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), effectiveAt: time, policyDigest: digest }).strict();
const ruleInputSchema = z.object({ dataClassId, retentionState, retainForDays: z.number().int().min(0).max(36_500).optional(),
  sourcePolicyDigest: digest.optional() }).strict();

function assertRuleMatchesDefinition(rule: OperationsPrivacyRetentionRuleV1, definition: OperationsDataClassDefinitionV1): void {
  const stateAllowed = definition.retentionKind === "source_authoritative" ? rule.retentionState === "source_authoritative"
    : definition.retentionKind === "indefinite_preservation" ? rule.retentionState === "indefinite_preservation"
      : ["configured_duration", "blocked_unconfigured"].includes(rule.retentionState);
  if (!stateAllowed || (rule.retentionState === "configured_duration") !== (rule.retainForDays !== undefined)
    || (rule.retentionState === "source_authoritative") !== Boolean(rule.sourcePolicyDigest)
    || rule.retentionState !== "source_authoritative" && rule.sourcePolicyDigest !== undefined) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
}

export function buildOperationsPrivacyRetentionPolicyV1(inputValue: unknown): OperationsPrivacyRetentionPolicyV1 {
  const input = parseExactOperationsV1(z.object({ registry: z.unknown(), policyId: id, revision: z.number().int().positive(),
    previousPolicyDigest: digest.optional(), tenantId: id, workspaceId: id, projectId: id,
    rules: z.array(ruleInputSchema).length(14), effectiveAt: time }).strict(), inputValue, "operations privacy policy input"),
    registry = parseOperationsDataClassRegistryV1(input.registry);
  if ((input.revision === 1) === Boolean(input.previousPolicyDigest)
    || input.rules.map((item) => item.dataClassId).join("|") !== OPERATIONS_DATA_CLASS_IDS_V1.join("|")) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const rules = input.rules.map((item, position) => {
    const definition = registry.definitions[position]!, material: Omit<OperationsPrivacyRetentionRuleV1, "ruleDigest"> = {
      ruleId: `rule:operations:privacy:${definition.dataClassId.split(":").at(-1)}`, ...item, legalHoldWins: true,
      ownerReviewRequired: true, automaticDispositionAllowed: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false };
    const built = { ...material, ruleDigest: sha256Digest(material) }; assertRuleMatchesDefinition(built, definition); return built;
  });
  const material: Omit<OperationsPrivacyRetentionPolicyV1, "policyDigest"> = {
    contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1, policyId: input.policyId, revision: input.revision,
    ...(input.previousPolicyDigest ? { previousPolicyDigest: input.previousPolicyDigest } : {}), tenantId: input.tenantId,
    workspaceId: input.workspaceId, projectId: input.projectId, registryDigest: registry.registryDigest, rules,
    legalRulesSuppliedExternally: true, makesLegalDeterminations: false, defaultDeletionAllowed: false,
    automaticDispositionAllowed: false, nativeExecutorPresent: false, grantsApproval: false, grantsDeletionAuthority: false,
    grantsExecutionAuthority: false, effectiveAt: input.effectiveAt };
  return parseOperationsPrivacyRetentionPolicyV1({ ...material, policyDigest: sha256Digest(material) }, registry);
}

export function parseOperationsPrivacyRetentionPolicyV1(value: unknown,
  registryValue: unknown = buildOperationsDataClassRegistryV1()): OperationsPrivacyRetentionPolicyV1 {
  const parsed = parseExactOperationsV1(policySchema, value, "operations privacy policy"), registry = parseOperationsDataClassRegistryV1(registryValue);
  if (parsed.registryDigest !== registry.registryDigest || (parsed.revision === 1) === Boolean(parsed.previousPolicyDigest)
    || parsed.rules.map((item) => item.dataClassId).join("|") !== OPERATIONS_DATA_CLASS_IDS_V1.join("|")) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  parsed.rules.forEach((rule, position) => {
    if (rule.ruleId !== `rule:operations:privacy:${rule.dataClassId.split(":").at(-1)}`) {
      throw new OperationsContractErrorV1("scope_mismatch");
    }
    verifyOperationsDigestV1(rule as unknown as Record<string, unknown>, "ruleDigest", rule.ruleDigest);
    assertRuleMatchesDefinition(rule, registry.definitions[position]!); });
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "policyDigest", parsed.policyDigest); return parsed;
}

export function buildOperationsSyntheticPrivacyRetentionPolicyV1(inputValue: unknown): OperationsPrivacyRetentionPolicyV1 {
  const input = parseExactOperationsV1(z.object({ tenantId: id, workspaceId: id, projectId: id, effectiveAt: time }).strict(),
    inputValue, "operations synthetic privacy policy input");
  const registry = buildOperationsDataClassRegistryV1(), rules = registry.definitions.map((definition) => ({
    dataClassId: definition.dataClassId,
    retentionState: definition.retentionKind === "source_authoritative" ? "source_authoritative" as const
      : definition.retentionKind === "indefinite_preservation" ? "indefinite_preservation" as const
        : "configured_duration" as const,
    ...(definition.retentionKind === "source_authoritative" ? { sourcePolicyDigest: sha256Digest({ syntheticSourcePolicy: definition.dataClassId }) }
      : definition.retentionKind === "indefinite_preservation" ? {} : { retainForDays: definition.dataClassId.endsWith("transient-transport-body") ? 0 : 30 }),
  }));
  return buildOperationsPrivacyRetentionPolicyV1({ registry, policyId: "policy:operations:privacy:synthetic", revision: 1,
    tenantId: input.tenantId, workspaceId: input.workspaceId, projectId: input.projectId, rules, effectiveAt: input.effectiveAt });
}

export type OperationsDispositionRequestKindV1 = "retention_expiry" | "owner_deletion_request" |
  "subject_erasure_request" | "quarantine_review";
export interface OperationsDataDispositionRequestV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  policyDigest: string;
  dataClassId: OperationsDataClassIdV1;
  recordSetDigest: string;
  requestKind: OperationsDispositionRequestKindV1;
  subjectReferenceDigest?: string;
  rawSubjectPresent: false;
  rawMaterialPresent: false;
  locatorValuePresent: false;
  makesLegalDetermination: false;
  ownerReviewRequired: true;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  requestedAt: string;
  requestDigest: string;
}
const requestKind = z.enum(["retention_expiry", "owner_deletion_request", "subject_erasure_request", "quarantine_review"]);
const requestSchema = z.object({ contractVersion: z.literal(OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1), requestId: id,
  tenantId: id, workspaceId: id, projectId: id, policyDigest: digest, dataClassId, recordSetDigest: digest,
  requestKind, subjectReferenceDigest: digest.optional(), rawSubjectPresent: z.literal(false), rawMaterialPresent: z.literal(false),
  locatorValuePresent: z.literal(false), makesLegalDetermination: z.literal(false), ownerReviewRequired: z.literal(true),
  performsAction: z.literal(false), grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), requestedAt: time, requestDigest: digest }).strict();

export function buildOperationsDataDispositionRequestV1(inputValue: unknown): OperationsDataDispositionRequestV1 {
  const input = parseExactOperationsV1(z.object({ policy: z.unknown(), dataClassId, recordSetDigest: digest, requestKind,
    subjectReferenceDigest: digest.optional(), requestedAt: time }).strict(), inputValue, "operations data disposition request input"),
    policy = parseOperationsPrivacyRetentionPolicyV1(input.policy);
  if ((input.requestKind === "subject_erasure_request") !== Boolean(input.subjectReferenceDigest)
    || Date.parse(input.requestedAt) < Date.parse(policy.effectiveAt)) throw new OperationsContractErrorV1("scope_mismatch");
  const identity = sha256Digest({ tenantId: policy.tenantId, workspaceId: policy.workspaceId, projectId: policy.projectId,
    policyDigest: policy.policyDigest, dataClassId: input.dataClassId, recordSetDigest: input.recordSetDigest,
    requestKind: input.requestKind, subjectReferenceDigest: input.subjectReferenceDigest ?? "none" }),
    material: Omit<OperationsDataDispositionRequestV1, "requestDigest"> = {
      contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1, requestId: `request:operations:privacy:${identity.slice(7, 31)}`,
      tenantId: policy.tenantId, workspaceId: policy.workspaceId, projectId: policy.projectId, policyDigest: policy.policyDigest,
      dataClassId: input.dataClassId, recordSetDigest: input.recordSetDigest, requestKind: input.requestKind,
      ...(input.subjectReferenceDigest ? { subjectReferenceDigest: input.subjectReferenceDigest } : {}), rawSubjectPresent: false,
      rawMaterialPresent: false, locatorValuePresent: false, makesLegalDetermination: false, ownerReviewRequired: true,
      performsAction: false, grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false,
      requestedAt: input.requestedAt };
  return parseOperationsDataDispositionRequestV1({ ...material, requestDigest: sha256Digest(material) });
}
export function parseOperationsDataDispositionRequestV1(value: unknown): OperationsDataDispositionRequestV1 {
  const parsed = parseExactOperationsV1(requestSchema, value, "operations data disposition request");
  const identity = sha256Digest({ tenantId: parsed.tenantId, workspaceId: parsed.workspaceId, projectId: parsed.projectId,
    policyDigest: parsed.policyDigest, dataClassId: parsed.dataClassId, recordSetDigest: parsed.recordSetDigest,
    requestKind: parsed.requestKind, subjectReferenceDigest: parsed.subjectReferenceDigest ?? "none" });
  if ((parsed.requestKind === "subject_erasure_request") !== Boolean(parsed.subjectReferenceDigest)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  if (parsed.requestId !== `request:operations:privacy:${identity.slice(7, 31)}`) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "requestDigest", parsed.requestDigest); return parsed;
}

export interface OperationsLegalHoldV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  holdId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  dataClassIds: OperationsDataClassIdV1[];
  subjectReferenceDigest?: string;
  authorityEvidenceDigest: string;
  basisReferenceDigest: string;
  effectiveAt: string;
  controlRoomDeterminedLegalNeed: false;
  preventsDisposition: true;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  holdDigest: string;
}
export interface OperationsLegalHoldReleaseEvidenceV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  releaseId: string;
  holdId: string;
  holdDigest: string;
  authorityEvidenceDigest: string;
  basisReferenceDigest: string;
  releasedAt: string;
  evidenceOnly: true;
  doesNotDelete: true;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  releaseDigest: string;
}
const holdSchema = z.object({ contractVersion: z.literal(OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1), holdId: id,
  tenantId: id, workspaceId: id, projectId: id, dataClassIds: z.array(dataClassId).min(1).max(14),
  subjectReferenceDigest: digest.optional(), authorityEvidenceDigest: digest, basisReferenceDigest: digest, effectiveAt: time,
  controlRoomDeterminedLegalNeed: z.literal(false), preventsDisposition: z.literal(true), performsAction: z.literal(false),
  grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  holdDigest: digest }).strict();
const releaseSchema = z.object({ contractVersion: z.literal(OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1), releaseId: id,
  holdId: id, holdDigest: digest, authorityEvidenceDigest: digest, basisReferenceDigest: digest, releasedAt: time,
  evidenceOnly: z.literal(true), doesNotDelete: z.literal(true), performsAction: z.literal(false), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), releaseDigest: digest }).strict();

export function buildOperationsLegalHoldV1(inputValue: unknown): OperationsLegalHoldV1 {
  const input = parseExactOperationsV1(z.object({ holdId: id, tenantId: id, workspaceId: id, projectId: id,
    dataClassIds: z.array(dataClassId).min(1).max(14), subjectReferenceDigest: digest.optional(), authorityEvidenceDigest: digest,
    basisReferenceDigest: digest, effectiveAt: time }).strict(), inputValue, "operations legal hold input"),
    ordered = [...input.dataClassIds].sort((left, right) => OPERATIONS_DATA_CLASS_IDS_V1.indexOf(left) - OPERATIONS_DATA_CLASS_IDS_V1.indexOf(right));
  if (new Set(ordered).size !== ordered.length) throw new OperationsContractErrorV1("scope_mismatch");
  const material: Omit<OperationsLegalHoldV1, "holdDigest"> = { contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1,
    holdId: input.holdId, tenantId: input.tenantId, workspaceId: input.workspaceId, projectId: input.projectId,
    dataClassIds: ordered, ...(input.subjectReferenceDigest ? { subjectReferenceDigest: input.subjectReferenceDigest } : {}),
    authorityEvidenceDigest: input.authorityEvidenceDigest, basisReferenceDigest: input.basisReferenceDigest,
    effectiveAt: input.effectiveAt, controlRoomDeterminedLegalNeed: false, preventsDisposition: true, performsAction: false,
    grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false };
  return parseOperationsLegalHoldV1({ ...material, holdDigest: sha256Digest(material) });
}
export function parseOperationsLegalHoldV1(value: unknown): OperationsLegalHoldV1 {
  const parsed = parseExactOperationsV1(holdSchema, value, "operations legal hold"), ordered = [...parsed.dataClassIds]
    .sort((left, right) => OPERATIONS_DATA_CLASS_IDS_V1.indexOf(left) - OPERATIONS_DATA_CLASS_IDS_V1.indexOf(right));
  if (new Set(ordered).size !== ordered.length || ordered.join("|") !== parsed.dataClassIds.join("|")) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "holdDigest", parsed.holdDigest); return parsed;
}
export function buildOperationsLegalHoldReleaseEvidenceV1(inputValue: unknown): OperationsLegalHoldReleaseEvidenceV1 {
  const input = parseExactOperationsV1(z.object({ hold: z.unknown(), authorityEvidenceDigest: digest,
    basisReferenceDigest: digest, releasedAt: time }).strict(), inputValue, "operations legal hold release input"),
    hold = parseOperationsLegalHoldV1(input.hold);
  if (Date.parse(input.releasedAt) < Date.parse(hold.effectiveAt)) throw new OperationsContractErrorV1("scope_mismatch");
  const material: Omit<OperationsLegalHoldReleaseEvidenceV1, "releaseDigest"> = {
    contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1,
    releaseId: `release:operations:privacy:${hold.holdDigest.slice(7, 31)}`, holdId: hold.holdId, holdDigest: hold.holdDigest,
    authorityEvidenceDigest: input.authorityEvidenceDigest, basisReferenceDigest: input.basisReferenceDigest,
    releasedAt: input.releasedAt, evidenceOnly: true, doesNotDelete: true, performsAction: false, grantsApproval: false,
    grantsDeletionAuthority: false, grantsExecutionAuthority: false };
  return parseOperationsLegalHoldReleaseEvidenceV1({ ...material, releaseDigest: sha256Digest(material) });
}
export function parseOperationsLegalHoldReleaseEvidenceV1(value: unknown): OperationsLegalHoldReleaseEvidenceV1 {
  const parsed = parseExactOperationsV1(releaseSchema, value, "operations legal hold release");
  if (parsed.releaseId !== `release:operations:privacy:${parsed.holdDigest.slice(7, 31)}`) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "releaseDigest", parsed.releaseDigest); return parsed;
}

export interface OperationsRetentionEvidenceV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  evidenceId: string;
  requestDigest: string;
  policyDigest: string;
  dataClassId: OperationsDataClassIdV1;
  recordSetDigest: string;
  clockStartedAt: string;
  evaluatedAt: string;
  eligibleAfter?: string;
  retentionDue: boolean;
  allDependencyHorizonsKnown: boolean;
  maximumDependencyHorizonAt?: string;
  activeReferencesAbsent: boolean;
  referenceEvidenceDigest: string;
  inventoryEvidenceDigest: string;
  auditChainHeadDigest: string;
  rawMaterialRead: false;
  locatorResolved: false;
  performsAction: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  evidenceDigest: string;
}
const retentionEvidenceSchema = z.object({ contractVersion: z.literal(OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1), evidenceId: id,
  requestDigest: digest, policyDigest: digest, dataClassId, recordSetDigest: digest, clockStartedAt: time, evaluatedAt: time,
  eligibleAfter: time.optional(), retentionDue: z.boolean(), allDependencyHorizonsKnown: z.boolean(),
  maximumDependencyHorizonAt: time.optional(), activeReferencesAbsent: z.boolean(), referenceEvidenceDigest: digest,
  inventoryEvidenceDigest: digest, auditChainHeadDigest: digest, rawMaterialRead: z.literal(false), locatorResolved: z.literal(false),
  performsAction: z.literal(false), grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  evidenceDigest: digest }).strict();
function addDays(value: string, days: number): string { return new Date(Date.parse(value) + days * 86_400_000).toISOString(); }

export function buildOperationsRetentionEvidenceV1(inputValue: unknown): OperationsRetentionEvidenceV1 {
  const input = parseExactOperationsV1(z.object({ registry: z.unknown(), policy: z.unknown(), request: z.unknown(),
    clockStartedAt: time, evaluatedAt: time, allDependencyHorizonsKnown: z.boolean(), maximumDependencyHorizonAt: time.optional(),
    activeReferencesAbsent: z.boolean(), referenceEvidenceDigest: digest, inventoryEvidenceDigest: digest,
    auditChainHeadDigest: digest }).strict(), inputValue, "operations retention evidence input"),
    registry = parseOperationsDataClassRegistryV1(input.registry), policy = parseOperationsPrivacyRetentionPolicyV1(input.policy, registry),
    request = parseOperationsDataDispositionRequestV1(input.request), definition = registry.definitions.find((item) => item.dataClassId === request.dataClassId)!,
    rule = policy.rules.find((item) => item.dataClassId === request.dataClassId)!;
  if (request.policyDigest !== policy.policyDigest || request.tenantId !== policy.tenantId || request.workspaceId !== policy.workspaceId
    || request.projectId !== policy.projectId || Date.parse(input.clockStartedAt) > Date.parse(input.evaluatedAt)
    || (!input.allDependencyHorizonsKnown && input.maximumDependencyHorizonAt)
    || (definition.dependencyHorizonRequired && input.allDependencyHorizonsKnown) !== Boolean(input.maximumDependencyHorizonAt)
    || !definition.dependencyHorizonRequired && input.maximumDependencyHorizonAt) throw new OperationsContractErrorV1("scope_mismatch");
  let eligibleAfter: string | undefined;
  if (rule.retentionState === "configured_duration") {
    eligibleAfter = addDays(input.clockStartedAt, rule.retainForDays!);
    if (input.maximumDependencyHorizonAt && Date.parse(input.maximumDependencyHorizonAt) > Date.parse(eligibleAfter)) {
      eligibleAfter = input.maximumDependencyHorizonAt;
    }
  } else if (rule.retentionState === "source_authoritative") eligibleAfter = input.clockStartedAt;
  const retentionDue = Boolean(eligibleAfter && Date.parse(input.evaluatedAt) >= Date.parse(eligibleAfter));
  const material: Omit<OperationsRetentionEvidenceV1, "evidenceDigest"> = {
    contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1,
    evidenceId: `evidence:operations:privacy:${request.requestDigest.slice(7, 31)}`, requestDigest: request.requestDigest,
    policyDigest: policy.policyDigest, dataClassId: request.dataClassId, recordSetDigest: request.recordSetDigest,
    clockStartedAt: input.clockStartedAt, evaluatedAt: input.evaluatedAt, ...(eligibleAfter ? { eligibleAfter } : {}),
    retentionDue, allDependencyHorizonsKnown: input.allDependencyHorizonsKnown,
    ...(input.maximumDependencyHorizonAt ? { maximumDependencyHorizonAt: input.maximumDependencyHorizonAt } : {}),
    activeReferencesAbsent: input.activeReferencesAbsent, referenceEvidenceDigest: input.referenceEvidenceDigest,
    inventoryEvidenceDigest: input.inventoryEvidenceDigest, auditChainHeadDigest: input.auditChainHeadDigest,
    rawMaterialRead: false, locatorResolved: false, performsAction: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false };
  return parseOperationsRetentionEvidenceV1({ ...material, evidenceDigest: sha256Digest(material) });
}
export function parseOperationsRetentionEvidenceV1(value: unknown): OperationsRetentionEvidenceV1 {
  const parsed = parseExactOperationsV1(retentionEvidenceSchema, value, "operations retention evidence");
  if (parsed.evidenceId !== `evidence:operations:privacy:${parsed.requestDigest.slice(7, 31)}`
    || Date.parse(parsed.clockStartedAt) > Date.parse(parsed.evaluatedAt)
    || (!parsed.allDependencyHorizonsKnown && parsed.maximumDependencyHorizonAt)
    || parsed.retentionDue !== Boolean(parsed.eligibleAfter && Date.parse(parsed.evaluatedAt) >= Date.parse(parsed.eligibleAfter))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "evidenceDigest", parsed.evidenceDigest); return parsed;
}

export type OperationsDispositionAssessmentV1 = "not_due" | "blocked_policy_unconfigured" | "blocked_legal_hold" |
  "blocked_unknown_horizon" | "blocked_active_reference" | "blocked_audit_preservation" |
  "deletion_review_candidate" | "digest_tombstone_review_candidate" | "source_reconciliation_review_candidate" |
  "quarantine_review_candidate";
export interface OperationsDataDispositionAssessmentV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  assessmentId: string;
  requestDigest: string;
  policyDigest: string;
  registryDigest: string;
  dataClassId: OperationsDataClassIdV1;
  recordSetDigest: string;
  retentionEvidenceDigest: string;
  activeHoldDigests: string[];
  disposition: OperationsDispositionAssessmentV1;
  safeReasonCode: string;
  candidateActionPresent: boolean;
  legalHoldChecked: true;
  legalValidityDetermined: false;
  auditRecordPreserved: true;
  rawMaterialRead: false;
  locatorResolved: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  assessedAt: string;
  assessmentDigest: string;
}
const assessmentDisposition = z.enum(["not_due", "blocked_policy_unconfigured", "blocked_legal_hold", "blocked_unknown_horizon",
  "blocked_active_reference", "blocked_audit_preservation", "deletion_review_candidate", "digest_tombstone_review_candidate",
  "source_reconciliation_review_candidate", "quarantine_review_candidate"]);
const assessmentSchema = z.object({ contractVersion: z.literal(OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1), assessmentId: id,
  requestDigest: digest, policyDigest: digest, registryDigest: digest, dataClassId, recordSetDigest: digest,
  retentionEvidenceDigest: digest, activeHoldDigests: z.array(digest).max(32), disposition: assessmentDisposition,
  safeReasonCode: id, candidateActionPresent: z.boolean(), legalHoldChecked: z.literal(true), legalValidityDetermined: z.literal(false),
  auditRecordPreserved: z.literal(true), rawMaterialRead: z.literal(false), locatorResolved: z.literal(false),
  performsAction: z.literal(false), grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), assessedAt: time, assessmentDigest: digest }).strict();
const candidates = new Set<OperationsDispositionAssessmentV1>(["deletion_review_candidate", "digest_tombstone_review_candidate",
  "source_reconciliation_review_candidate", "quarantine_review_candidate"]);

export function assessOperationsDataDispositionV1(inputValue: unknown): OperationsDataDispositionAssessmentV1 {
  const input = parseExactOperationsV1(z.object({ registry: z.unknown(), policy: z.unknown(), request: z.unknown(),
    evidence: z.unknown(), holds: z.array(z.unknown()).max(32), releases: z.array(z.unknown()).max(32) }).strict(), inputValue,
  "operations data disposition assessment input"), registry = parseOperationsDataClassRegistryV1(input.registry),
    policy = parseOperationsPrivacyRetentionPolicyV1(input.policy, registry), request = parseOperationsDataDispositionRequestV1(input.request),
    evidence = parseOperationsRetentionEvidenceV1(input.evidence), holds = input.holds.map(parseOperationsLegalHoldV1),
    releases = input.releases.map(parseOperationsLegalHoldReleaseEvidenceV1),
    definition = registry.definitions.find((item) => item.dataClassId === request.dataClassId)!,
    rule = policy.rules.find((item) => item.dataClassId === request.dataClassId)!;
  if (request.policyDigest !== policy.policyDigest || evidence.requestDigest !== request.requestDigest
    || evidence.policyDigest !== policy.policyDigest || evidence.dataClassId !== request.dataClassId
    || evidence.recordSetDigest !== request.recordSetDigest || request.tenantId !== policy.tenantId
    || request.workspaceId !== policy.workspaceId || request.projectId !== policy.projectId
    || holds.some((hold) => hold.tenantId !== policy.tenantId || hold.workspaceId !== policy.workspaceId || hold.projectId !== policy.projectId)
    || releases.some((release) => !holds.some((hold) => hold.holdId === release.holdId && hold.holdDigest === release.holdDigest))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const relevant = holds.filter((hold) => Date.parse(hold.effectiveAt) <= Date.parse(evidence.evaluatedAt)
    && hold.dataClassIds.includes(request.dataClassId)
    && (!hold.subjectReferenceDigest || !request.subjectReferenceDigest || hold.subjectReferenceDigest === request.subjectReferenceDigest)
    && !releases.some((release) => release.holdId === hold.holdId && release.holdDigest === hold.holdDigest
      && Date.parse(release.releasedAt) <= Date.parse(evidence.evaluatedAt))), activeHoldDigests = relevant.map((hold) => hold.holdDigest).sort();
  let disposition: OperationsDispositionAssessmentV1, safeReasonCode: string;
  if (activeHoldDigests.length) { disposition = "blocked_legal_hold"; safeReasonCode = "active_legal_hold_preserves_target"; }
  else if (definition.dispositionMode === "never_delete_full_record") {
    disposition = "blocked_audit_preservation"; safeReasonCode = "append_only_audit_record_preserved";
  } else if (rule.retentionState === "blocked_unconfigured") {
    disposition = "blocked_policy_unconfigured"; safeReasonCode = "retention_policy_value_missing";
  } else if (definition.dependencyHorizonRequired && !evidence.allDependencyHorizonsKnown) {
    disposition = "blocked_unknown_horizon"; safeReasonCode = "dependency_horizon_unknown_retain";
  } else if (!evidence.activeReferencesAbsent) {
    disposition = "blocked_active_reference"; safeReasonCode = "active_reference_preserves_target";
  } else if (request.requestKind === "retention_expiry" && !evidence.retentionDue
    && rule.retentionState !== "source_authoritative") {
    disposition = "not_due"; safeReasonCode = "retention_window_not_elapsed";
  } else if (request.requestKind === "quarantine_review") {
    disposition = "quarantine_review_candidate"; safeReasonCode = "quarantine_requires_owner_review";
  } else if (definition.dispositionMode === "compact_to_digest_tombstone_review") {
    disposition = "digest_tombstone_review_candidate"; safeReasonCode = "full_record_compaction_review_only";
  } else if (definition.dispositionMode === "source_reconciliation_review") {
    disposition = "source_reconciliation_review_candidate"; safeReasonCode = "source_authority_review_required";
  } else { disposition = "deletion_review_candidate"; safeReasonCode = "data_disposition_owner_review_required"; }
  const material: Omit<OperationsDataDispositionAssessmentV1, "assessmentDigest"> = {
    contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1,
    assessmentId: `assessment:operations:privacy:${request.requestDigest.slice(7, 31)}`, requestDigest: request.requestDigest,
    policyDigest: policy.policyDigest, registryDigest: registry.registryDigest, dataClassId: request.dataClassId,
    recordSetDigest: request.recordSetDigest, retentionEvidenceDigest: evidence.evidenceDigest, activeHoldDigests,
    disposition, safeReasonCode, candidateActionPresent: candidates.has(disposition), legalHoldChecked: true,
    legalValidityDetermined: false, auditRecordPreserved: true, rawMaterialRead: false, locatorResolved: false,
    performsAction: false, grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false,
    assessedAt: evidence.evaluatedAt };
  return parseOperationsDataDispositionAssessmentV1({ ...material, assessmentDigest: sha256Digest(material) });
}
export function parseOperationsDataDispositionAssessmentV1(value: unknown): OperationsDataDispositionAssessmentV1 {
  const parsed = parseExactOperationsV1(assessmentSchema, value, "operations data disposition assessment");
  if (parsed.assessmentId !== `assessment:operations:privacy:${parsed.requestDigest.slice(7, 31)}`
    || parsed.candidateActionPresent !== candidates.has(parsed.disposition)
    || parsed.activeHoldDigests.join("|") !== [...parsed.activeHoldDigests].sort().join("|")) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "assessmentDigest", parsed.assessmentDigest); return parsed;
}

export const OPERATIONS_DATA_DISPOSITION_GATE_CODES_V1 = ["exact_scope_and_policy", "current_bounded_inventory",
  "retention_or_request_basis", "legal_hold_clearance", "dependency_horizons_complete", "active_references_absent",
  "fresh_owner_decision", "protected_effect_claim", "pre_effect_marker", "independent_terminal_receipt_and_audit"] as const;
export type OperationsDataDispositionCandidateActionV1 = "delete_candidate" | "compact_to_digest_tombstone_candidate" |
  "source_reconciliation_candidate" | "quarantine_candidate";
export interface OperationsDataDispositionProposalV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  proposalId: string;
  assessmentDigest: string;
  requestDigest: string;
  policyDigest: string;
  dataClassId: OperationsDataClassIdV1;
  recordSetDigest: string;
  candidateAction: OperationsDataDispositionCandidateActionV1;
  requiredGateCodes: string[];
  tombstoneRequired: boolean;
  ownerDecisionPresent: false;
  effectClaimPresent: false;
  preEffectMarkerPresent: false;
  terminalReceiptPresent: false;
  independentAbsenceEvidencePresent: false;
  commandLines: [];
  locatorPresent: false;
  credentialReferencePresent: false;
  nativeExecutorPresent: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  proposedAt: string;
  proposalDigest: string;
}
const candidateAction = z.enum(["delete_candidate", "compact_to_digest_tombstone_candidate", "source_reconciliation_candidate",
  "quarantine_candidate"]);
const proposalSchema = z.object({ contractVersion: z.literal(OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1), proposalId: id,
  assessmentDigest: digest, requestDigest: digest, policyDigest: digest, dataClassId, recordSetDigest: digest, candidateAction,
  requiredGateCodes: z.array(id).length(10), tombstoneRequired: z.boolean(), ownerDecisionPresent: z.literal(false),
  effectClaimPresent: z.literal(false), preEffectMarkerPresent: z.literal(false), terminalReceiptPresent: z.literal(false),
  independentAbsenceEvidencePresent: z.literal(false), commandLines: z.tuple([]), locatorPresent: z.literal(false),
  credentialReferencePresent: z.literal(false), nativeExecutorPresent: z.literal(false), performsAction: z.literal(false),
  grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  proposedAt: time, proposalDigest: digest }).strict();
const trustedProposals = new WeakSet<object>();

export function buildOperationsDataDispositionProposalV1(assessmentValue: unknown): OperationsDataDispositionProposalV1 {
  const assessment = parseOperationsDataDispositionAssessmentV1(assessmentValue), actionByDisposition = {
    deletion_review_candidate: "delete_candidate", digest_tombstone_review_candidate: "compact_to_digest_tombstone_candidate",
    source_reconciliation_review_candidate: "source_reconciliation_candidate", quarantine_review_candidate: "quarantine_candidate",
  } as const, candidate = actionByDisposition[assessment.disposition as keyof typeof actionByDisposition];
  if (!candidate) throw new OperationsContractErrorV1("unsupported_action");
  const material: Omit<OperationsDataDispositionProposalV1, "proposalDigest"> = {
    contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1,
    proposalId: `proposal:operations:privacy:${assessment.assessmentDigest.slice(7, 31)}`, assessmentDigest: assessment.assessmentDigest,
    requestDigest: assessment.requestDigest, policyDigest: assessment.policyDigest, dataClassId: assessment.dataClassId,
    recordSetDigest: assessment.recordSetDigest, candidateAction: candidate,
    requiredGateCodes: [...OPERATIONS_DATA_DISPOSITION_GATE_CODES_V1],
    tombstoneRequired: candidate === "delete_candidate" || candidate === "compact_to_digest_tombstone_candidate",
    ownerDecisionPresent: false, effectClaimPresent: false, preEffectMarkerPresent: false, terminalReceiptPresent: false,
    independentAbsenceEvidencePresent: false, commandLines: [], locatorPresent: false, credentialReferencePresent: false,
    nativeExecutorPresent: false, performsAction: false, grantsApproval: false, grantsDeletionAuthority: false,
    grantsExecutionAuthority: false, proposedAt: assessment.assessedAt };
  const proposal = parseOperationsDataDispositionProposalV1({ ...material, proposalDigest: sha256Digest(material) });
  trustedProposals.add(proposal as object); return proposal;
}
export function parseOperationsDataDispositionProposalV1(value: unknown): OperationsDataDispositionProposalV1 {
  const parsed = parseExactOperationsV1(proposalSchema, value, "operations data disposition proposal");
  if (parsed.proposalId !== `proposal:operations:privacy:${parsed.assessmentDigest.slice(7, 31)}`
    || parsed.requiredGateCodes.join("|") !== OPERATIONS_DATA_DISPOSITION_GATE_CODES_V1.join("|")
    || parsed.tombstoneRequired !== ["delete_candidate", "compact_to_digest_tombstone_candidate"].includes(parsed.candidateAction)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "proposalDigest", parsed.proposalDigest); return parsed;
}

export interface OperationsDisabledDataDispositionV1 {
  status: "disabled_before_execution";
  proposalDigest: string;
  candidateAction: OperationsDataDispositionCandidateActionV1;
  commandLines: [];
  locatorPresent: false;
  clientPresent: false;
  credentialResolutionAttempted: false;
  effectAttempted: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  dispositionDigest: string;
}
export function createOperationsDisabledDataDispositionExecutorV1(): { prepare(value: unknown): OperationsDisabledDataDispositionV1 } {
  return Object.freeze({ prepare(value: unknown) {
    if (!value || typeof value !== "object" || !trustedProposals.has(value as object)) throw new OperationsContractErrorV1("unsupported_action");
    const proposal = parseOperationsDataDispositionProposalV1(value), material: Omit<OperationsDisabledDataDispositionV1, "dispositionDigest"> = {
      status: "disabled_before_execution", proposalDigest: proposal.proposalDigest, candidateAction: proposal.candidateAction,
      commandLines: [], locatorPresent: false, clientPresent: false, credentialResolutionAttempted: false, effectAttempted: false,
      performsAction: false, grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false };
    return { ...material, dispositionDigest: sha256Digest(material) };
  } });
}

export interface OperationsPrivacyProjectionV1 {
  contractVersion: typeof OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1;
  scopeDigest: string;
  policyDigest: string;
  registryDigest: string;
  configuredClassCount: number;
  blockedClassCount: number;
  cards: Array<{ dataClassId: OperationsDataClassIdV1; disposition: OperationsDispositionAssessmentV1;
    safeReasonCode: string; candidateActionPresent: boolean; activeHoldCount: number; }>;
  controls: [];
  commandLines: [];
  rawMaterialPresent: false;
  locatorValuesPresent: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  projectionDigest: string;
}
export function projectOperationsPrivacyV1(policyValue: unknown, assessmentValues: unknown): OperationsPrivacyProjectionV1 {
  const policy = parseOperationsPrivacyRetentionPolicyV1(policyValue), assessmentInputs = parseExactOperationsV1(
    z.array(z.unknown()).max(128), assessmentValues, "operations privacy projection assessments"),
    assessments = assessmentInputs.map(parseOperationsDataDispositionAssessmentV1);
  if (assessments.some((item) => item.policyDigest !== policy.policyDigest)) throw new OperationsContractErrorV1("scope_mismatch");
  const material: Omit<OperationsPrivacyProjectionV1, "projectionDigest"> = {
    contractVersion: OPERATIONS_PRIVACY_RETENTION_CONTRACT_V1,
    scopeDigest: sha256Digest({ tenantId: policy.tenantId, workspaceId: policy.workspaceId, projectId: policy.projectId }),
    policyDigest: policy.policyDigest, registryDigest: policy.registryDigest,
    configuredClassCount: policy.rules.filter((rule) => rule.retentionState !== "blocked_unconfigured").length,
    blockedClassCount: policy.rules.filter((rule) => rule.retentionState === "blocked_unconfigured").length,
    cards: assessments.map((assessment) => ({ dataClassId: assessment.dataClassId, disposition: assessment.disposition,
      safeReasonCode: assessment.safeReasonCode, candidateActionPresent: assessment.candidateActionPresent,
      activeHoldCount: assessment.activeHoldDigests.length })), controls: [], commandLines: [], rawMaterialPresent: false,
    locatorValuesPresent: false, performsAction: false, grantsApproval: false, grantsDeletionAuthority: false,
    grantsExecutionAuthority: false };
  return { ...material, projectionDigest: sha256Digest(material) };
}

export const operationsPrivacyRetentionSchemasV1 = { definition: definitionSchema, registry: registrySchema, rule: ruleSchema,
  policy: policySchema, request: requestSchema, hold: holdSchema, release: releaseSchema, evidence: retentionEvidenceSchema,
  assessment: assessmentSchema, proposal: proposalSchema } as const;
