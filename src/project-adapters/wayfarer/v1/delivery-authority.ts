import { z } from "zod";
import {
  COMPLETION_GATE_SCHEMA_VERSION_V1,
  consequentialApprovalRequestSchemaV1,
  type ConsequentialApprovalRequestV1,
} from "../../../completion-gate/v1";
import {
  exactProjectWorkspaceJsonV1,
  ProjectWorkspaceContractErrorV1,
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../../project-workspace/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import {
  parseWayfarerDeliveryPreparationPackageV1,
  WAYFARER_DELIVERY_BOUNDARY_IDS_V1,
  type WayfarerDeliveryBoundaryIdV1,
  type WayfarerDeliveryPreparationPackageV1,
} from "./delivery-preparation";
import { WAYFARER_PROJECT_ID_V1, WAYFARER_WORKSPACE_ID_V1 } from "./types";

export const WAYFARER_DELIVERY_AUTHORITY_CONTRACT_V1 = "control-room-wayfarer-delivery-authority/v1" as const;

export interface WayfarerDeliveryDestinationV1 {
  contractVersion: typeof WAYFARER_DELIVERY_AUTHORITY_CONTRACT_V1;
  destinationId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  boundaryId: WayfarerDeliveryBoundaryIdV1;
  destinationKind: "private_object_store" | "public_video_channel";
  environment: "candidate_only";
  destinationOriginDigest: string;
  destinationPathDigest: string;
  adapterId: string;
  adapterReleaseDigest: string;
  credentialReferenceDigest: string;
  supportsStableIdempotency: true;
  exactRevisionRequired: true;
  rawOriginStored: false;
  rawPathStored: false;
  rawCredentialReferenceStored: false;
  containsCredentials: false;
  networkConfigured: false;
  adapterQualified: false;
  deliveryAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  destinationIdentityDigest: string;
  destinationDigest: string;
}

export interface WayfarerDeliveryContentIdentityV1 {
  role: "episode_master" | "assembly_manifest" | "publication_package";
  contentDigest: string;
  sizeBytes: number;
  immutable: true;
  contentObservedByAuthoritativeSource: true;
  grantsAuthority: false;
  identityDigest: string;
}

export interface WayfarerDeliveryRequestV1 {
  contractVersion: typeof WAYFARER_DELIVERY_AUTHORITY_CONTRACT_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  effectIntentId: string;
  boundaryId: WayfarerDeliveryBoundaryIdV1;
  operation: "wayfarer.upload_private_distribution" | "wayfarer.publish_episode";
  packageId: string;
  packageDigest: string;
  boundaryDigest: string;
  contentIdentities: WayfarerDeliveryContentIdentityV1[];
  contentSetDigest: string;
  completionResolutionDigest: string;
  destinationId: string;
  destinationIdentityDigest: string;
  destinationPathDigest: string;
  adapterReleaseDigest: string;
  credentialReferenceDigest: string;
  operationDigest: string;
  destinationIdempotencyKey: string;
  requestedAt: string;
  expiresAt: string;
  risk: "high";
  requiredFactor: "strong";
  ownerApprovalRequired: true;
  separateNodeAttestationRequired: true;
  durableEffectClaimRequired: true;
  preEffectMarkerRequired: true;
  destinationReceiptRequired: true;
  cleanupReceiptRequired: true;
  automaticRetryAfterMarker: false;
  unknownAfterMarker: "terminal_ambiguity";
  deliveryAuthorized: false;
  allowsCredentialResolution: false;
  allowsNetwork: false;
  allowsUpload: false;
  allowsPublication: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  requestDigest: string;
}

const boundaryId = z.enum(WAYFARER_DELIVERY_BOUNDARY_IDS_V1);
const destinationInputSchema = z.object({ destinationId: id, tenantId: id, workspaceId: z.literal(WAYFARER_WORKSPACE_ID_V1),
  projectId: z.literal(WAYFARER_PROJECT_ID_V1), boundaryId,
  destinationOriginDigest: digest, destinationPathDigest: digest, adapterId: id, adapterReleaseDigest: digest,
  credentialReferenceDigest: digest }).strict();
const destinationSchema = z.object({ contractVersion: z.literal(WAYFARER_DELIVERY_AUTHORITY_CONTRACT_V1),
  destinationId: id, tenantId: id, workspaceId: z.literal(WAYFARER_WORKSPACE_ID_V1),
  projectId: z.literal(WAYFARER_PROJECT_ID_V1), boundaryId,
  destinationKind: z.enum(["private_object_store", "public_video_channel"]), environment: z.literal("candidate_only"),
  destinationOriginDigest: digest, destinationPathDigest: digest, adapterId: id, adapterReleaseDigest: digest,
  credentialReferenceDigest: digest, supportsStableIdempotency: z.literal(true), exactRevisionRequired: z.literal(true),
  rawOriginStored: z.literal(false), rawPathStored: z.literal(false), rawCredentialReferenceStored: z.literal(false),
  containsCredentials: z.literal(false), networkConfigured: z.literal(false), adapterQualified: z.literal(false),
  deliveryAuthorized: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  destinationIdentityDigest: digest, destinationDigest: digest }).strict();
const role = z.enum(["episode_master", "assembly_manifest", "publication_package"]);
const contentInputSchema = z.object({ role, contentDigest: digest, sizeBytes: z.number().int().positive(),
  contentObservedByAuthoritativeSource: z.literal(true) }).strict();
const contentSchema = z.object({ role, contentDigest: digest, sizeBytes: z.number().int().positive(), immutable: z.literal(true),
  contentObservedByAuthoritativeSource: z.literal(true), grantsAuthority: z.literal(false), identityDigest: digest }).strict();
const requestInputSchema = z.object({ requestId: id, jobId: id, attemptId: id, effectIntentId: id, package: z.unknown(),
  destination: z.unknown(), contentIdentities: z.array(z.unknown()).min(2).max(3), completionResolutionDigest: digest,
  requestedAt: time, expiresAt: time }).strict();
const requestSchema = z.object({ contractVersion: z.literal(WAYFARER_DELIVERY_AUTHORITY_CONTRACT_V1), requestId: id,
  tenantId: id, workspaceId: z.literal(WAYFARER_WORKSPACE_ID_V1), projectId: z.literal(WAYFARER_PROJECT_ID_V1),
  jobId: id, attemptId: id, effectIntentId: id, boundaryId,
  operation: z.enum(["wayfarer.upload_private_distribution", "wayfarer.publish_episode"]), packageId: id, packageDigest: digest,
  boundaryDigest: digest, contentIdentities: z.array(contentSchema).min(2).max(3), contentSetDigest: digest,
  completionResolutionDigest: digest, destinationId: id, destinationIdentityDigest: digest, destinationPathDigest: digest,
  adapterReleaseDigest: digest, credentialReferenceDigest: digest, operationDigest: digest, destinationIdempotencyKey: digest,
  requestedAt: time, expiresAt: time, risk: z.literal("high"), requiredFactor: z.literal("strong"),
  ownerApprovalRequired: z.literal(true), separateNodeAttestationRequired: z.literal(true),
  durableEffectClaimRequired: z.literal(true), preEffectMarkerRequired: z.literal(true), destinationReceiptRequired: z.literal(true),
  cleanupReceiptRequired: z.literal(true), automaticRetryAfterMarker: z.literal(false), unknownAfterMarker: z.literal("terminal_ambiguity"),
  deliveryAuthorized: z.literal(false), allowsCredentialResolution: z.literal(false), allowsNetwork: z.literal(false),
  allowsUpload: z.literal(false), allowsPublication: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), requestDigest: digest }).strict();

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
function operationFor(boundary: WayfarerDeliveryBoundaryIdV1) {
  return boundary === "private_upload" ? "wayfarer.upload_private_distribution" as const : "wayfarer.publish_episode" as const;
}
function expectedRoles(boundary: WayfarerDeliveryBoundaryIdV1) {
  return boundary === "private_upload" ? ["episode_master", "assembly_manifest", "publication_package"] as const
    : ["episode_master", "publication_package"] as const;
}

export function buildWayfarerDeliveryDestinationV1(inputValue: unknown): WayfarerDeliveryDestinationV1 {
  const input = exact(destinationInputSchema, inputValue, "Wayfarer delivery destination");
  const destinationKind = input.boundaryId === "private_upload" ? "private_object_store" as const : "public_video_channel" as const;
  const identity = { destinationId: input.destinationId, tenantId: input.tenantId, workspaceId: input.workspaceId,
    projectId: input.projectId, boundaryId: input.boundaryId, destinationKind, environment: "candidate_only" as const,
    destinationOriginDigest: input.destinationOriginDigest, destinationPathDigest: input.destinationPathDigest,
    adapterId: input.adapterId, adapterReleaseDigest: input.adapterReleaseDigest, credentialReferenceDigest: input.credentialReferenceDigest };
  const material: Omit<WayfarerDeliveryDestinationV1, "destinationDigest"> = {
    contractVersion: WAYFARER_DELIVERY_AUTHORITY_CONTRACT_V1, ...identity, supportsStableIdempotency: true,
    exactRevisionRequired: true, rawOriginStored: false, rawPathStored: false, rawCredentialReferenceStored: false,
    containsCredentials: false, networkConfigured: false, adapterQualified: false, deliveryAuthorized: false,
    grantsApproval: false, grantsExecutionAuthority: false, destinationIdentityDigest: sha256Digest(identity) };
  return parseWayfarerDeliveryDestinationV1({ ...material, destinationDigest: sha256Digest(material) });
}

export function parseWayfarerDeliveryDestinationV1(value: unknown): WayfarerDeliveryDestinationV1 {
  const parsed = exact(destinationSchema, value, "Wayfarer delivery destination") as WayfarerDeliveryDestinationV1;
  verifyDigest(parsed as unknown as Record<string, unknown>, "destinationDigest", parsed.destinationDigest);
  const identity = { destinationId: parsed.destinationId, tenantId: parsed.tenantId, workspaceId: parsed.workspaceId,
    projectId: parsed.projectId, boundaryId: parsed.boundaryId, destinationKind: parsed.destinationKind,
    environment: parsed.environment, destinationOriginDigest: parsed.destinationOriginDigest,
    destinationPathDigest: parsed.destinationPathDigest, adapterId: parsed.adapterId,
    adapterReleaseDigest: parsed.adapterReleaseDigest, credentialReferenceDigest: parsed.credentialReferenceDigest };
  if (sha256Digest(identity) !== parsed.destinationIdentityDigest
    || (parsed.boundaryId === "private_upload") !== (parsed.destinationKind === "private_object_store")) {
    throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  }
  return parsed;
}

function buildContentIdentity(value: unknown): WayfarerDeliveryContentIdentityV1 {
  const input = exact(contentInputSchema, value, "Wayfarer delivery content identity");
  const material: Omit<WayfarerDeliveryContentIdentityV1, "identityDigest"> = { ...input, immutable: true,
    grantsAuthority: false };
  return exact(contentSchema, { ...material, identityDigest: sha256Digest(material) }, "Wayfarer delivery content identity");
}

export function buildWayfarerDeliveryRequestV1(inputValue: unknown): WayfarerDeliveryRequestV1 {
  const input = exact(requestInputSchema, inputValue, "Wayfarer delivery request");
  const prepared = parseWayfarerDeliveryPreparationPackageV1(input.package);
  const destination = parseWayfarerDeliveryDestinationV1(input.destination);
  const boundary = prepared.boundaries.find((item) => item.boundaryId === destination.boundaryId);
  if (!boundary || prepared.tenantId !== destination.tenantId || prepared.workspaceId !== destination.workspaceId
    || prepared.projectId !== destination.projectId || Date.parse(input.expiresAt) <= Date.parse(input.requestedAt)) {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  const identities = input.contentIdentities.map(buildContentIdentity);
  if (identities.map((item) => item.role).join("|") !== expectedRoles(destination.boundaryId).join("|")
    || identities.some((item) => {
      const declaration = prepared.artifactDeclarations.find((candidate) => candidate.role === item.role);
      return !declaration || item.sizeBytes > declaration.maximumBytes;
    })) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  const contentSetDigest = sha256Digest(identities.map((item) => item.identityDigest));
  const operation = operationFor(destination.boundaryId);
  const operationMaterial = { operation, tenantId: prepared.tenantId, workspaceId: prepared.workspaceId,
    projectId: prepared.projectId, jobId: input.jobId, attemptId: input.attemptId, effectIntentId: input.effectIntentId,
    boundaryId: destination.boundaryId, packageDigest: prepared.packageDigest, boundaryDigest: boundary.boundaryDigest,
    contentSetDigest, completionResolutionDigest: input.completionResolutionDigest,
    destinationIdentityDigest: destination.destinationIdentityDigest, destinationPathDigest: destination.destinationPathDigest,
    adapterReleaseDigest: destination.adapterReleaseDigest, credentialReferenceDigest: destination.credentialReferenceDigest };
  const operationDigest = sha256Digest(operationMaterial);
  const destinationIdempotencyKey = sha256Digest({ boundaryId: destination.boundaryId,
    destinationIdentityDigest: destination.destinationIdentityDigest, destinationPathDigest: destination.destinationPathDigest,
    contentSetDigest, completionResolutionDigest: input.completionResolutionDigest });
  const material: Omit<WayfarerDeliveryRequestV1, "requestDigest"> = {
    contractVersion: WAYFARER_DELIVERY_AUTHORITY_CONTRACT_V1, requestId: input.requestId, tenantId: prepared.tenantId,
    workspaceId: prepared.workspaceId, projectId: prepared.projectId, jobId: input.jobId, attemptId: input.attemptId,
    effectIntentId: input.effectIntentId, boundaryId: destination.boundaryId, operation, packageId: prepared.packageId,
    packageDigest: prepared.packageDigest, boundaryDigest: boundary.boundaryDigest, contentIdentities: identities,
    contentSetDigest, completionResolutionDigest: input.completionResolutionDigest, destinationId: destination.destinationId,
    destinationIdentityDigest: destination.destinationIdentityDigest, destinationPathDigest: destination.destinationPathDigest,
    adapterReleaseDigest: destination.adapterReleaseDigest, credentialReferenceDigest: destination.credentialReferenceDigest,
    operationDigest, destinationIdempotencyKey, requestedAt: input.requestedAt, expiresAt: input.expiresAt, risk: "high",
    requiredFactor: "strong", ownerApprovalRequired: true, separateNodeAttestationRequired: true,
    durableEffectClaimRequired: true, preEffectMarkerRequired: true, destinationReceiptRequired: true,
    cleanupReceiptRequired: true, automaticRetryAfterMarker: false, unknownAfterMarker: "terminal_ambiguity",
    deliveryAuthorized: false, allowsCredentialResolution: false, allowsNetwork: false, allowsUpload: false,
    allowsPublication: false, grantsApproval: false, grantsExecutionAuthority: false };
  return parseWayfarerDeliveryRequestV1({ ...material, requestDigest: sha256Digest(material) });
}

export function parseWayfarerDeliveryRequestV1(value: unknown): WayfarerDeliveryRequestV1 {
  const parsed = exact(requestSchema, value, "Wayfarer delivery request") as WayfarerDeliveryRequestV1;
  for (const identity of parsed.contentIdentities) verifyDigest(identity as unknown as Record<string, unknown>, "identityDigest", identity.identityDigest);
  if (parsed.contentIdentities.map((item) => item.role).join("|") !== expectedRoles(parsed.boundaryId).join("|")
    || parsed.operation !== operationFor(parsed.boundaryId)
    || parsed.contentSetDigest !== sha256Digest(parsed.contentIdentities.map((item) => item.identityDigest))) {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  const operationMaterial = { operation: parsed.operation, tenantId: parsed.tenantId, workspaceId: parsed.workspaceId,
    projectId: parsed.projectId, jobId: parsed.jobId, attemptId: parsed.attemptId, effectIntentId: parsed.effectIntentId,
    boundaryId: parsed.boundaryId, packageDigest: parsed.packageDigest, boundaryDigest: parsed.boundaryDigest,
    contentSetDigest: parsed.contentSetDigest, completionResolutionDigest: parsed.completionResolutionDigest,
    destinationIdentityDigest: parsed.destinationIdentityDigest, destinationPathDigest: parsed.destinationPathDigest,
    adapterReleaseDigest: parsed.adapterReleaseDigest, credentialReferenceDigest: parsed.credentialReferenceDigest };
  if (parsed.operationDigest !== sha256Digest(operationMaterial)
    || parsed.destinationIdempotencyKey !== sha256Digest({ boundaryId: parsed.boundaryId,
      destinationIdentityDigest: parsed.destinationIdentityDigest, destinationPathDigest: parsed.destinationPathDigest,
      contentSetDigest: parsed.contentSetDigest, completionResolutionDigest: parsed.completionResolutionDigest })) {
    throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  }
  verifyDigest(parsed as unknown as Record<string, unknown>, "requestDigest", parsed.requestDigest);
  return parsed;
}

export function buildWayfarerDeliveryApprovalRequestV1(requestValue: unknown): ConsequentialApprovalRequestV1 {
  const request = parseWayfarerDeliveryRequestV1(requestValue);
  return consequentialApprovalRequestSchemaV1.parse({ schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
    id: derivedId(`approval-request:wayfarer:${request.boundaryId}`, request.requestDigest), tenantId: request.tenantId,
    projectId: request.projectId, jobId: request.jobId, attemptId: request.attemptId, effectIntentId: request.effectIntentId,
    operationDigest: request.operationDigest, risk: "high", requestedBy: { actorId: "service:wayfarer-delivery",
      actorType: "service" }, requiredFactor: "strong", requestedAt: request.requestedAt, expiresAt: request.expiresAt,
    grantsExecutionAuthority: false }) as ConsequentialApprovalRequestV1;
}

export function buildWayfarerDeliveryCandidateFixtureV1(
  preparedValue: unknown,
  boundary: WayfarerDeliveryBoundaryIdV1,
): { package: WayfarerDeliveryPreparationPackageV1; destination: WayfarerDeliveryDestinationV1; request: WayfarerDeliveryRequestV1;
  approvalRequest: ConsequentialApprovalRequestV1 } {
  const prepared = parseWayfarerDeliveryPreparationPackageV1(preparedValue);
  const destination = buildWayfarerDeliveryDestinationV1({ destinationId: `destination:wayfarer:${boundary}:candidate`,
    tenantId: prepared.tenantId, workspaceId: prepared.workspaceId, projectId: prepared.projectId, boundaryId: boundary,
    destinationOriginDigest: sha256Digest({ boundary, candidate: "origin" }),
    destinationPathDigest: sha256Digest({ boundary, candidate: "path" }), adapterId: `adapter:wayfarer:${boundary}:candidate`,
    adapterReleaseDigest: sha256Digest({ boundary, candidate: "adapter-release" }),
    credentialReferenceDigest: sha256Digest({ boundary, candidate: "credential-reference" }) });
  const roles = expectedRoles(boundary);
  const contentIdentities = roles.map((contentRole, position) => ({ role: contentRole,
    contentDigest: sha256Digest({ boundary, contentRole, candidate: "content" }), sizeBytes: 1_048_576 * (position + 1),
    contentObservedByAuthoritativeSource: true as const }));
  const request = buildWayfarerDeliveryRequestV1({ requestId: `request:wayfarer:${boundary}:candidate`,
    jobId: `job:wayfarer:${boundary}:candidate`, attemptId: `attempt:wayfarer:${boundary}:candidate`,
    effectIntentId: `effect:wayfarer:${boundary}:candidate`, package: prepared, destination, contentIdentities,
    completionResolutionDigest: sha256Digest({ boundary, candidate: "completion-resolution" }),
    requestedAt: "2026-08-29T23:30:00.000Z", expiresAt: "2026-08-29T23:35:00.000Z" });
  return { package: prepared, destination, request, approvalRequest: buildWayfarerDeliveryApprovalRequestV1(request) };
}

export const wayfarerDeliveryAuthoritySchemasV1 = { destination: destinationSchema, contentIdentity: contentSchema,
  request: requestSchema } as const;
