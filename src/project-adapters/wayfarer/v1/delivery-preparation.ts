import { z } from "zod";
import {
  exactProjectWorkspaceJsonV1,
  ProjectWorkspaceContractErrorV1,
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../../project-workspace/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import { parseWayfarerProjectPackV1 } from "./contract";
import { buildWayfarerSyntheticProjectPackV1 } from "./fixture";
import { WAYFARER_PROJECT_ID_V1, WAYFARER_WORKSPACE_ID_V1 } from "./types";

export const WAYFARER_DELIVERY_PREPARATION_CONTRACT_V1 = "control-room-wayfarer-delivery-preparation/v1" as const;
export const WAYFARER_DELIVERY_BOUNDARY_IDS_V1 = ["private_upload", "public_publication"] as const;
export type WayfarerDeliveryBoundaryIdV1 = (typeof WAYFARER_DELIVERY_BOUNDARY_IDS_V1)[number];
export const WAYFARER_DELIVERY_BLOCKERS_V1 = [
  "authoritative_render_missing",
  "authoritative_audio_missing",
  "qc_resolution_missing",
  "independent_review_missing",
  "completion_gate_resolution_missing",
  "immutable_media_bytes_unavailable",
  "live_storage_adapter_unconfigured",
  "exact_destination_identity_missing",
  "destination_adapter_unqualified",
  "credential_reference_missing",
  "node_execution_authority_missing",
  "fresh_strong_owner_approval_missing",
] as const;
export type WayfarerDeliveryBlockerV1 = (typeof WAYFARER_DELIVERY_BLOCKERS_V1)[number];

export interface WayfarerDeliveryArtifactDeclarationV1 {
  role: "episode_master" | "assembly_manifest" | "publication_package";
  artifactDefinitionDigest: string;
  allowedContentTypes: string[];
  maximumBytes: number;
  immutable: true;
  observedBytes: 0;
  materialAvailable: false;
  contentIdentityAvailable: false;
  locatorAvailable: false;
  qualifiesForDelivery: false;
  grantsAuthority: false;
}

export interface WayfarerDeliveryBoundaryV1 {
  boundaryId: WayfarerDeliveryBoundaryIdV1;
  operation: "wayfarer.upload_private_distribution" | "wayfarer.publish_episode";
  destinationClass: "owner_selected_private_object_store" | "owner_selected_public_video_channel";
  requiredArtifactRoles: Array<"episode_master" | "assembly_manifest" | "publication_package">;
  risk: "high";
  destinationIdentityPolicy: "owner_supplied_exact_digest_only";
  destinationPathPolicy: "owner_supplied_exact_digest_only";
  destinationIdempotencyRequired: true;
  freshStrongApprovalRequired: true;
  nodeAuthorityRequired: true;
  qualifiedAdapterRequired: true;
  credentialBrokerRequired: true;
  durableEffectClaimRequired: true;
  preEffectMarkerRequired: true;
  automaticRetryAfterMarker: false;
  unknownAfterMarker: "terminal_ambiguity";
  cleanupReceiptRequired: true;
  destinationReceiptRequired: true;
  networkConfigured: false;
  adapterConfigured: false;
  destinationIdentityPresent: false;
  credentialReferencePresent: false;
  allowsNetwork: false;
  allowsUpload: false;
  allowsPublication: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  boundaryDigest: string;
}

export interface WayfarerDeliveryPreparationPackageV1 {
  contractVersion: typeof WAYFARER_DELIVERY_PREPARATION_CONTRACT_V1;
  packageId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  packId: string;
  packDigest: string;
  episodeId: "episode:wayfarer:lazy-river:synthetic";
  preparePublicationStageId: "prepare_publication";
  preparePublicationStageDigest: string;
  artifactDeclarations: [WayfarerDeliveryArtifactDeclarationV1, WayfarerDeliveryArtifactDeclarationV1,
    WayfarerDeliveryArtifactDeclarationV1];
  boundaries: [WayfarerDeliveryBoundaryV1, WayfarerDeliveryBoundaryV1];
  blockingRequirements: WayfarerDeliveryBlockerV1[];
  preparationState: "metadata_only_blocked";
  preparedAt: string;
  containsMediaBytes: false;
  containsArtifactLocators: false;
  containsDestinationIdentifiers: false;
  containsDestinationPaths: false;
  containsCredentialReferences: false;
  containsCredentials: false;
  createsCanonicalJob: false;
  createsEffectClaim: false;
  recordsPreEffectMarker: false;
  resolvesCompletionGate: false;
  uploadEligible: false;
  publicationEligible: false;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  packageDigest: string;
}

export interface WayfarerDeliveryDisabledOutcomeV1 {
  contractVersion: typeof WAYFARER_DELIVERY_PREPARATION_CONTRACT_V1;
  outcomeId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  packageId: string;
  packageDigest: string;
  status: "disabled_before_effect";
  blockingRequirements: WayfarerDeliveryBlockerV1[];
  recordedAt: string;
  uploadAttempted: false;
  publicationAttempted: false;
  destinationContacted: false;
  credentialsResolved: false;
  artifactBytesRead: false;
  effectClaimCreated: false;
  preEffectMarkerRecorded: false;
  retryScheduled: false;
  externalEffectOccurred: false;
  requiresNewPackageAndAuthorization: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  outcomeDigest: string;
}

const role = z.enum(["episode_master", "assembly_manifest", "publication_package"]);
const artifactSchema = z.object({ role, artifactDefinitionDigest: digest, allowedContentTypes: z.array(z.string().min(3).max(100)).min(1).max(3),
  maximumBytes: z.number().int().positive(), immutable: z.literal(true), observedBytes: z.literal(0),
  materialAvailable: z.literal(false), contentIdentityAvailable: z.literal(false), locatorAvailable: z.literal(false),
  qualifiesForDelivery: z.literal(false), grantsAuthority: z.literal(false) }).strict();
const boundaryId = z.enum(WAYFARER_DELIVERY_BOUNDARY_IDS_V1);
const boundarySchema = z.object({ boundaryId,
  operation: z.enum(["wayfarer.upload_private_distribution", "wayfarer.publish_episode"]),
  destinationClass: z.enum(["owner_selected_private_object_store", "owner_selected_public_video_channel"]),
  requiredArtifactRoles: z.array(role).min(2).max(3), risk: z.literal("high"),
  destinationIdentityPolicy: z.literal("owner_supplied_exact_digest_only"),
  destinationPathPolicy: z.literal("owner_supplied_exact_digest_only"), destinationIdempotencyRequired: z.literal(true),
  freshStrongApprovalRequired: z.literal(true), nodeAuthorityRequired: z.literal(true), qualifiedAdapterRequired: z.literal(true),
  credentialBrokerRequired: z.literal(true), durableEffectClaimRequired: z.literal(true), preEffectMarkerRequired: z.literal(true),
  automaticRetryAfterMarker: z.literal(false), unknownAfterMarker: z.literal("terminal_ambiguity"),
  cleanupReceiptRequired: z.literal(true), destinationReceiptRequired: z.literal(true), networkConfigured: z.literal(false),
  adapterConfigured: z.literal(false), destinationIdentityPresent: z.literal(false), credentialReferencePresent: z.literal(false),
  allowsNetwork: z.literal(false), allowsUpload: z.literal(false), allowsPublication: z.literal(false),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), boundaryDigest: digest }).strict();
const blocker = z.enum(WAYFARER_DELIVERY_BLOCKERS_V1);
const packageSchema = z.object({ contractVersion: z.literal(WAYFARER_DELIVERY_PREPARATION_CONTRACT_V1), packageId: id,
  tenantId: id, workspaceId: z.literal(WAYFARER_WORKSPACE_ID_V1), projectId: z.literal(WAYFARER_PROJECT_ID_V1),
  packId: id, packDigest: digest,
  episodeId: z.literal("episode:wayfarer:lazy-river:synthetic"), preparePublicationStageId: z.literal("prepare_publication"),
  preparePublicationStageDigest: digest, artifactDeclarations: z.tuple([artifactSchema, artifactSchema, artifactSchema]),
  boundaries: z.tuple([boundarySchema, boundarySchema]), blockingRequirements: z.array(blocker).length(12),
  preparationState: z.literal("metadata_only_blocked"), preparedAt: time, containsMediaBytes: z.literal(false),
  containsArtifactLocators: z.literal(false), containsDestinationIdentifiers: z.literal(false),
  containsDestinationPaths: z.literal(false), containsCredentialReferences: z.literal(false), containsCredentials: z.literal(false),
  createsCanonicalJob: z.literal(false), createsEffectClaim: z.literal(false), recordsPreEffectMarker: z.literal(false),
  resolvesCompletionGate: z.literal(false), uploadEligible: z.literal(false), publicationEligible: z.literal(false),
  externalEffectOccurred: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  packageDigest: digest }).strict();
const outcomeSchema = z.object({ contractVersion: z.literal(WAYFARER_DELIVERY_PREPARATION_CONTRACT_V1), outcomeId: id,
  tenantId: id, workspaceId: z.literal(WAYFARER_WORKSPACE_ID_V1), projectId: z.literal(WAYFARER_PROJECT_ID_V1),
  packageId: id, packageDigest: digest,
  status: z.literal("disabled_before_effect"), blockingRequirements: z.array(blocker).length(12), recordedAt: time,
  uploadAttempted: z.literal(false), publicationAttempted: z.literal(false), destinationContacted: z.literal(false),
  credentialsResolved: z.literal(false), artifactBytesRead: z.literal(false), effectClaimCreated: z.literal(false),
  preEffectMarkerRecorded: z.literal(false), retryScheduled: z.literal(false), externalEffectOccurred: z.literal(false),
  requiresNewPackageAndAuthorization: z.literal(true), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  outcomeDigest: digest }).strict();

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

function buildBoundary(input: Pick<WayfarerDeliveryBoundaryV1, "boundaryId" | "operation" | "destinationClass"
  | "requiredArtifactRoles">): WayfarerDeliveryBoundaryV1 {
  const material: Omit<WayfarerDeliveryBoundaryV1, "boundaryDigest"> = { ...input, risk: "high",
    destinationIdentityPolicy: "owner_supplied_exact_digest_only", destinationPathPolicy: "owner_supplied_exact_digest_only",
    destinationIdempotencyRequired: true, freshStrongApprovalRequired: true, nodeAuthorityRequired: true,
    qualifiedAdapterRequired: true, credentialBrokerRequired: true, durableEffectClaimRequired: true,
    preEffectMarkerRequired: true, automaticRetryAfterMarker: false, unknownAfterMarker: "terminal_ambiguity",
    cleanupReceiptRequired: true, destinationReceiptRequired: true, networkConfigured: false, adapterConfigured: false,
    destinationIdentityPresent: false, credentialReferencePresent: false, allowsNetwork: false, allowsUpload: false,
    allowsPublication: false, grantsApproval: false, grantsExecutionAuthority: false };
  return { ...material, boundaryDigest: sha256Digest(material) };
}

export function buildWayfarerDeliveryPreparationPackageV1(
  packValue: unknown = buildWayfarerSyntheticProjectPackV1(),
): WayfarerDeliveryPreparationPackageV1 {
  const pack = parseWayfarerProjectPackV1(packValue);
  const stage = pack.stages.find((item) => item.stageId === "prepare_publication");
  if (!stage) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  const requiredRoles = ["episode_master", "assembly_manifest", "publication_package"] as const;
  const artifacts = requiredRoles.map((requiredRole) => {
    const definition = pack.artifacts.find((item) => item.role === requiredRole);
    if (!definition) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
    return { role: requiredRole, artifactDefinitionDigest: sha256Digest(definition), allowedContentTypes: definition.allowedContentTypes,
      maximumBytes: definition.maximumBytes, immutable: true as const, observedBytes: 0 as const, materialAvailable: false as const,
      contentIdentityAvailable: false as const, locatorAvailable: false as const, qualifiesForDelivery: false as const,
      grantsAuthority: false as const };
  }) as [WayfarerDeliveryArtifactDeclarationV1, WayfarerDeliveryArtifactDeclarationV1, WayfarerDeliveryArtifactDeclarationV1];
  const boundaries: [WayfarerDeliveryBoundaryV1, WayfarerDeliveryBoundaryV1] = [
    buildBoundary({ boundaryId: "private_upload", operation: "wayfarer.upload_private_distribution",
      destinationClass: "owner_selected_private_object_store", requiredArtifactRoles: [...requiredRoles] }),
    buildBoundary({ boundaryId: "public_publication", operation: "wayfarer.publish_episode",
      destinationClass: "owner_selected_public_video_channel", requiredArtifactRoles: ["episode_master", "publication_package"] }),
  ];
  const stageDigest = sha256Digest(stage);
  const material: Omit<WayfarerDeliveryPreparationPackageV1, "packageDigest"> = {
    contractVersion: WAYFARER_DELIVERY_PREPARATION_CONTRACT_V1,
    packageId: derivedId("package:wayfarer:delivery-preparation", { packDigest: pack.packDigest, stageDigest }),
    tenantId: pack.tenantId,
    workspaceId: pack.workspaceId,
    projectId: pack.projectId,
    packId: pack.packId,
    packDigest: pack.packDigest,
    episodeId: "episode:wayfarer:lazy-river:synthetic",
    preparePublicationStageId: "prepare_publication",
    preparePublicationStageDigest: stageDigest,
    artifactDeclarations: artifacts,
    boundaries,
    blockingRequirements: [...WAYFARER_DELIVERY_BLOCKERS_V1],
    preparationState: "metadata_only_blocked",
    preparedAt: "2026-08-29T23:20:00.000Z",
    containsMediaBytes: false,
    containsArtifactLocators: false,
    containsDestinationIdentifiers: false,
    containsDestinationPaths: false,
    containsCredentialReferences: false,
    containsCredentials: false,
    createsCanonicalJob: false,
    createsEffectClaim: false,
    recordsPreEffectMarker: false,
    resolvesCompletionGate: false,
    uploadEligible: false,
    publicationEligible: false,
    externalEffectOccurred: false,
    grantsApproval: false,
    grantsExecutionAuthority: false,
  };
  return parseWayfarerDeliveryPreparationPackageV1({ ...material, packageDigest: sha256Digest(material) });
}

export function parseWayfarerDeliveryPreparationPackageV1(value: unknown): WayfarerDeliveryPreparationPackageV1 {
  const parsed = exact(packageSchema, value, "Wayfarer delivery preparation package");
  if (parsed.artifactDeclarations.map((item) => item.role).join("|") !== "episode_master|assembly_manifest|publication_package"
    || parsed.boundaries.map((item) => item.boundaryId).join("|") !== WAYFARER_DELIVERY_BOUNDARY_IDS_V1.join("|")
    || parsed.blockingRequirements.join("|") !== WAYFARER_DELIVERY_BLOCKERS_V1.join("|")
    || parsed.boundaries[0].operation !== "wayfarer.upload_private_distribution"
    || parsed.boundaries[0].destinationClass !== "owner_selected_private_object_store"
    || parsed.boundaries[0].requiredArtifactRoles.join("|") !== "episode_master|assembly_manifest|publication_package"
    || parsed.boundaries[1].operation !== "wayfarer.publish_episode"
    || parsed.boundaries[1].destinationClass !== "owner_selected_public_video_channel"
    || parsed.boundaries[1].requiredArtifactRoles.join("|") !== "episode_master|publication_package") {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  for (const boundary of parsed.boundaries) verifyDigest(boundary as unknown as Record<string, unknown>, "boundaryDigest", boundary.boundaryDigest);
  verifyDigest(parsed as unknown as Record<string, unknown>, "packageDigest", parsed.packageDigest);
  return parsed;
}

export function buildWayfarerDeliveryDisabledOutcomeV1(input: {
  package: unknown;
  recordedAt: string;
}): WayfarerDeliveryDisabledOutcomeV1 {
  const prepared = parseWayfarerDeliveryPreparationPackageV1(input.package);
  if (Date.parse(input.recordedAt) < Date.parse(prepared.preparedAt)) throw new ProjectWorkspaceContractErrorV1("invalid_transition");
  const material: Omit<WayfarerDeliveryDisabledOutcomeV1, "outcomeDigest"> = {
    contractVersion: WAYFARER_DELIVERY_PREPARATION_CONTRACT_V1,
    outcomeId: derivedId("outcome:wayfarer:delivery:disabled", { packageDigest: prepared.packageDigest }),
    tenantId: prepared.tenantId,
    workspaceId: prepared.workspaceId,
    projectId: prepared.projectId,
    packageId: prepared.packageId,
    packageDigest: prepared.packageDigest,
    status: "disabled_before_effect",
    blockingRequirements: prepared.blockingRequirements,
    recordedAt: input.recordedAt,
    uploadAttempted: false,
    publicationAttempted: false,
    destinationContacted: false,
    credentialsResolved: false,
    artifactBytesRead: false,
    effectClaimCreated: false,
    preEffectMarkerRecorded: false,
    retryScheduled: false,
    externalEffectOccurred: false,
    requiresNewPackageAndAuthorization: true,
    grantsApproval: false,
    grantsExecutionAuthority: false,
  };
  return parseWayfarerDeliveryDisabledOutcomeV1({ ...material, outcomeDigest: sha256Digest(material) });
}

export function parseWayfarerDeliveryDisabledOutcomeV1(value: unknown): WayfarerDeliveryDisabledOutcomeV1 {
  const parsed = exact(outcomeSchema, value, "Wayfarer delivery disabled outcome");
  if (parsed.blockingRequirements.join("|") !== WAYFARER_DELIVERY_BLOCKERS_V1.join("|")) {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  verifyDigest(parsed as unknown as Record<string, unknown>, "outcomeDigest", parsed.outcomeDigest);
  return parsed;
}

export function buildCurrentWayfarerDeliveryDisabledV1(packValue: unknown = buildWayfarerSyntheticProjectPackV1()): {
  package: WayfarerDeliveryPreparationPackageV1;
  outcome: WayfarerDeliveryDisabledOutcomeV1;
} {
  const prepared = buildWayfarerDeliveryPreparationPackageV1(packValue);
  return { package: prepared, outcome: buildWayfarerDeliveryDisabledOutcomeV1({ package: prepared,
    recordedAt: "2026-08-29T23:20:01.000Z" }) };
}

export const wayfarerDeliveryPreparationSchemasV1 = { artifact: artifactSchema, boundary: boundarySchema,
  package: packageSchema, disabledOutcome: outcomeSchema } as const;
