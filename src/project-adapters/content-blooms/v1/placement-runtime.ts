import { z } from "zod";
import {
  ownerApprovalAttestationSchema,
  verifyArtifactSignature,
  type OwnerApprovalAttestationV1,
} from "../../../node-policy/v1";
import { sha256Digest } from "../../../security";
import { ContentBloomsContractErrorV1 } from "./errors";
import { exactContentBloomsJsonV1, parseExactContentBloomsV1 } from "./exact";
import {
  parseContentBloomsPlacementAuthorizationV1,
  parseContentBloomsPlacementOutcomeReceiptV1,
  parseContentBloomsPlacementRequestV1,
} from "./placement";
import { contentBloomsDigestSchemaV1, contentBloomsSafeIdSchemaV1, contentBloomsTimeSchemaV1 } from "./schemas";
import type {
  ContentBloomsPlacementAuthorizationV1,
  ContentBloomsPlacementOutcomeReceiptV1,
  ContentBloomsPlacementRequestV1,
} from "./types";

export const CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1 = "control-room-content-blooms-placement-runtime/v1" as const;

export interface ContentBloomsPlacementNodeApprovalEvidenceV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1;
  evidenceId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  nodeId: string;
  requestId: string;
  requestDigest: string;
  authorizationId: string;
  authorizationDigest: string;
  jobId: string;
  attemptId: string;
  operationDigest: string;
  idempotencyKey: string;
  risk: "medium";
  approvalKeyId: string;
  attestationBodyDigest: string;
  attestationDigest: string;
  publicKeyDigest: string;
  nonceDigest: string;
  issuedAt: string;
  expiresAt: string;
  verifiedAt: string;
  signatureVerified: true;
  singleUseForEffect: true;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  evidenceDigest: string;
}

export interface ContentBloomsPlacementEffectClaimV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1;
  claimId: string;
  claimKey: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  nodeId: string;
  requestId: string;
  requestDigest: string;
  authorizationId: string;
  authorizationDigest: string;
  nodeAttestationEvidenceId: string;
  nodeAttestationEvidenceDigest: string;
  jobId: string;
  attemptId: string;
  effectIntentId: string;
  operationDigest: string;
  idempotencyKey: string;
  authorityDigest: string;
  effectiveDeadline: string;
  claimedAt: string;
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  sameEffectRetryAfterMarkerProhibited: true;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  claimDigest: string;
}

export interface ContentBloomsPlacementPreEffectMarkerV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1;
  markerId: string;
  claimKey: string;
  claimDigest: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  nodeId: string;
  requestId: string;
  requestDigest: string;
  authorizationDigest: string;
  nodeAttestationEvidenceDigest: string;
  operationDigest: string;
  idempotencyKey: string;
  destination: "content-blooms:source-scheduled";
  sourceOperation: "request_transcription_route_preference";
  workItemSourceRecordId: string;
  expectedSourceVersion: string;
  selectedRouteId: string;
  selectedRouteDigest: string;
  authorityDigest: string;
  effectiveDeadline: string;
  markedAt: string;
  transportMode: "injected_fake_only";
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  controlRoomMayAssign: false;
  controlRoomMayLease: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  markerDigest: string;
}

export interface ContentBloomsPlacementTombstoneV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1;
  tombstoneId: string;
  tenantId: string;
  projectId: string;
  claimKey: string;
  claimDigest: string;
  requestDigest: string;
  authorizationDigest: string;
  idempotencyKey: string;
  operationDigest: string;
  outcomeDigest: string;
  disposition: "accepted" | "already_applied" | "rejected" | "ambiguous";
  sealedAt: string;
  retainUntil: string;
  allRetentionHorizonsKnown: true;
  fullOutcomeRetained: true;
  prohibitsRedispatch: true;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  tombstoneDigest: string;
}

const idempotencyKeySchema = z.string().regex(/^cb-placement:[a-f0-9]{64}$/);
const publicKeySchema = z.string().min(40).max(1_000).regex(/^[A-Za-z0-9_-]+$/);

const nodeApprovalInputSchema = z.object({
  request: z.unknown(),
  authorization: z.unknown(),
  attestation: z.unknown(),
  publicKeySpki: publicKeySchema,
  verifiedAt: contentBloomsTimeSchemaV1,
}).strict();

const nodeApprovalEvidenceSchema = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1),
  evidenceId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  nodeId: contentBloomsSafeIdSchemaV1,
  requestId: contentBloomsSafeIdSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  authorizationId: contentBloomsSafeIdSchemaV1,
  authorizationDigest: contentBloomsDigestSchemaV1,
  jobId: contentBloomsSafeIdSchemaV1,
  attemptId: contentBloomsSafeIdSchemaV1,
  operationDigest: contentBloomsDigestSchemaV1,
  idempotencyKey: idempotencyKeySchema,
  risk: z.literal("medium"),
  approvalKeyId: contentBloomsSafeIdSchemaV1,
  attestationBodyDigest: contentBloomsDigestSchemaV1,
  attestationDigest: contentBloomsDigestSchemaV1,
  publicKeyDigest: contentBloomsDigestSchemaV1,
  nonceDigest: contentBloomsDigestSchemaV1,
  issuedAt: contentBloomsTimeSchemaV1,
  expiresAt: contentBloomsTimeSchemaV1,
  verifiedAt: contentBloomsTimeSchemaV1,
  signatureVerified: z.literal(true),
  singleUseForEffect: z.literal(true),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  evidenceDigest: contentBloomsDigestSchemaV1,
}).strict();

const claimInputSchema = z.object({
  request: z.unknown(),
  authorization: z.unknown(),
  nodeAttestationEvidence: z.unknown(),
  claimedAt: contentBloomsTimeSchemaV1,
}).strict();

const effectClaimSchema = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1),
  claimId: contentBloomsSafeIdSchemaV1,
  claimKey: contentBloomsDigestSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  nodeId: contentBloomsSafeIdSchemaV1,
  requestId: contentBloomsSafeIdSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  authorizationId: contentBloomsSafeIdSchemaV1,
  authorizationDigest: contentBloomsDigestSchemaV1,
  nodeAttestationEvidenceId: contentBloomsSafeIdSchemaV1,
  nodeAttestationEvidenceDigest: contentBloomsDigestSchemaV1,
  jobId: contentBloomsSafeIdSchemaV1,
  attemptId: contentBloomsSafeIdSchemaV1,
  effectIntentId: contentBloomsSafeIdSchemaV1,
  operationDigest: contentBloomsDigestSchemaV1,
  idempotencyKey: idempotencyKeySchema,
  authorityDigest: contentBloomsDigestSchemaV1,
  effectiveDeadline: contentBloomsTimeSchemaV1,
  claimedAt: contentBloomsTimeSchemaV1,
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  sameEffectRetryAfterMarkerProhibited: z.literal(true),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  claimDigest: contentBloomsDigestSchemaV1,
}).strict();

const markerInputSchema = z.object({
  claim: z.unknown(),
  request: z.unknown(),
  markedAt: contentBloomsTimeSchemaV1,
}).strict();

const markerSchema = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1),
  markerId: contentBloomsSafeIdSchemaV1,
  claimKey: contentBloomsDigestSchemaV1,
  claimDigest: contentBloomsDigestSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  nodeId: contentBloomsSafeIdSchemaV1,
  requestId: contentBloomsSafeIdSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  authorizationDigest: contentBloomsDigestSchemaV1,
  nodeAttestationEvidenceDigest: contentBloomsDigestSchemaV1,
  operationDigest: contentBloomsDigestSchemaV1,
  idempotencyKey: idempotencyKeySchema,
  destination: z.literal("content-blooms:source-scheduled"),
  sourceOperation: z.literal("request_transcription_route_preference"),
  workItemSourceRecordId: contentBloomsSafeIdSchemaV1,
  expectedSourceVersion: z.string().min(1).max(180),
  selectedRouteId: contentBloomsSafeIdSchemaV1,
  selectedRouteDigest: contentBloomsDigestSchemaV1,
  authorityDigest: contentBloomsDigestSchemaV1,
  effectiveDeadline: contentBloomsTimeSchemaV1,
  markedAt: contentBloomsTimeSchemaV1,
  transportMode: z.literal("injected_fake_only"),
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  controlRoomMayAssign: z.literal(false),
  controlRoomMayLease: z.literal(false),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  markerDigest: contentBloomsDigestSchemaV1,
}).strict();

const tombstoneInputSchema = z.object({
  claim: z.unknown(),
  outcome: z.unknown(),
  sealedAt: contentBloomsTimeSchemaV1,
  retainUntil: contentBloomsTimeSchemaV1,
  allRetentionHorizonsKnown: z.literal(true),
}).strict();

const tombstoneSchema = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1),
  tombstoneId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  claimKey: contentBloomsDigestSchemaV1,
  claimDigest: contentBloomsDigestSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  authorizationDigest: contentBloomsDigestSchemaV1,
  idempotencyKey: idempotencyKeySchema,
  operationDigest: contentBloomsDigestSchemaV1,
  outcomeDigest: contentBloomsDigestSchemaV1,
  disposition: z.enum(["accepted", "already_applied", "rejected", "ambiguous"]),
  sealedAt: contentBloomsTimeSchemaV1,
  retainUntil: contentBloomsTimeSchemaV1,
  allRetentionHorizonsKnown: z.literal(true),
  fullOutcomeRetained: z.literal(true),
  prohibitsRedispatch: z.literal(true),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  tombstoneDigest: contentBloomsDigestSchemaV1,
}).strict();

function withoutDigest<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function samePlacementBinding(
  request: ContentBloomsPlacementRequestV1,
  authorization: ContentBloomsPlacementAuthorizationV1,
): boolean {
  return request.tenantId === authorization.tenantId
    && request.workspaceId === authorization.workspaceId
    && request.projectId === authorization.projectId
    && request.adapterId === authorization.adapterId
    && request.requestId === authorization.requestId
    && request.requestDigest === authorization.requestDigest
    && request.operationDigest === authorization.operationDigest
    && request.idempotencyKey === authorization.idempotencyKey;
}

export function buildContentBloomsPlacementNodeApprovalEvidenceV1(inputValue: unknown): ContentBloomsPlacementNodeApprovalEvidenceV1 {
  let input: z.infer<typeof nodeApprovalInputSchema>;
  try {
    input = nodeApprovalInputSchema.parse(exactContentBloomsJsonV1(inputValue));
  } catch (error) {
    if (error instanceof ContentBloomsContractErrorV1) throw error;
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
  const request = parseContentBloomsPlacementRequestV1(input.request);
  const authorization = parseContentBloomsPlacementAuthorizationV1(input.authorization);
  if (!samePlacementBinding(request, authorization)) throw new ContentBloomsContractErrorV1("approval_required");
  const parsedAttestation = ownerApprovalAttestationSchema.safeParse(input.attestation);
  if (!parsedAttestation.success) throw new ContentBloomsContractErrorV1("approval_required");
  const attestation = parsedAttestation.data as OwnerApprovalAttestationV1;
  try {
    if (!verifyArtifactSignature(attestation, input.publicKeySpki)) throw new ContentBloomsContractErrorV1("approval_required");
  } catch (error) {
    if (error instanceof ContentBloomsContractErrorV1) throw error;
    throw new ContentBloomsContractErrorV1("approval_required");
  }
  const body = attestation.body;
  if (!body.nodeId || body.nodeClass !== undefined || body.tenantId !== request.tenantId
    || body.projectId !== request.projectId || body.jobId !== request.jobId
    || body.attemptId !== request.attemptId || body.operationDigest !== request.operationDigest
    || body.risk !== request.risk || body.decision !== "approved") {
    throw new ContentBloomsContractErrorV1("approval_required");
  }
  if (Date.parse(input.verifiedAt) < Date.parse(body.issuedAt)
    || Date.parse(input.verifiedAt) >= Date.parse(body.expiresAt)
    || Date.parse(body.expiresAt) > Date.parse(authorization.expiresAt)
    || Date.parse(body.expiresAt) > Date.parse(request.expiresAt)
    || Date.parse(body.expiresAt) > Date.parse(request.routeValidUntil)) {
    throw new ContentBloomsContractErrorV1("request_expired");
  }
  const attestationDigest = sha256Digest(attestation);
  const unsigned: Omit<ContentBloomsPlacementNodeApprovalEvidenceV1, "evidenceDigest"> = {
    schemaVersion: CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1,
    evidenceId: `cb-placement-node-attestation:${attestationDigest.slice(7, 39)}`,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    adapterId: request.adapterId,
    nodeId: body.nodeId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    authorizationId: authorization.authorizationId,
    authorizationDigest: authorization.authorizationDigest,
    jobId: request.jobId,
    attemptId: request.attemptId,
    operationDigest: request.operationDigest,
    idempotencyKey: request.idempotencyKey,
    risk: "medium",
    approvalKeyId: body.approvalKeyId,
    attestationBodyDigest: body.bodyDigest,
    attestationDigest,
    publicKeyDigest: sha256Digest({ format: "ed25519-spki-der-base64url", value: input.publicKeySpki }),
    nonceDigest: sha256Digest({ nonce: body.nonce }),
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    verifiedAt: input.verifiedAt,
    signatureVerified: true,
    singleUseForEffect: true,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(nodeApprovalEvidenceSchema, {
    ...unsigned,
    evidenceDigest: sha256Digest(unsigned),
  }) as ContentBloomsPlacementNodeApprovalEvidenceV1;
}

export function parseContentBloomsPlacementNodeApprovalEvidenceV1(value: unknown): ContentBloomsPlacementNodeApprovalEvidenceV1 {
  const evidence = parseExactContentBloomsV1(nodeApprovalEvidenceSchema, value) as ContentBloomsPlacementNodeApprovalEvidenceV1;
  if (sha256Digest(withoutDigest(evidence as unknown as Record<string, unknown>, "evidenceDigest")) !== evidence.evidenceDigest
    || Date.parse(evidence.verifiedAt) < Date.parse(evidence.issuedAt)
    || Date.parse(evidence.verifiedAt) >= Date.parse(evidence.expiresAt)) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return evidence;
}

export function buildContentBloomsPlacementEffectClaimV1(inputValue: unknown): ContentBloomsPlacementEffectClaimV1 {
  const input = parseExactContentBloomsV1(claimInputSchema, inputValue);
  const request = parseContentBloomsPlacementRequestV1(input.request);
  const authorization = parseContentBloomsPlacementAuthorizationV1(input.authorization);
  const evidence = parseContentBloomsPlacementNodeApprovalEvidenceV1(input.nodeAttestationEvidence);
  if (!samePlacementBinding(request, authorization)
    || evidence.tenantId !== request.tenantId || evidence.projectId !== request.projectId
    || evidence.requestDigest !== request.requestDigest || evidence.authorizationDigest !== authorization.authorizationDigest
    || evidence.operationDigest !== request.operationDigest || evidence.idempotencyKey !== request.idempotencyKey) {
    throw new ContentBloomsContractErrorV1("approval_required");
  }
  const effectiveDeadline = [request.expiresAt, request.routeValidUntil, authorization.expiresAt, evidence.expiresAt]
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  if (Date.parse(input.claimedAt) < Date.parse(authorization.authorizedAt)
    || Date.parse(input.claimedAt) < Date.parse(evidence.verifiedAt)
    || Date.parse(input.claimedAt) >= Date.parse(effectiveDeadline)) {
    throw new ContentBloomsContractErrorV1("request_expired");
  }
  const claimKey = sha256Digest({
    schema: "control-room.effect-identity/v1",
    tenantId: request.tenantId,
    nodeId: evidence.nodeId,
    projectId: request.projectId,
    jobId: request.jobId,
    attemptId: request.attemptId,
    operationDigest: request.operationDigest,
  });
  const unsigned: Omit<ContentBloomsPlacementEffectClaimV1, "claimDigest"> = {
    schemaVersion: CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1,
    claimId: `cb-placement-claim:${claimKey.slice(7, 39)}`,
    claimKey,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    adapterId: request.adapterId,
    nodeId: evidence.nodeId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    authorizationId: authorization.authorizationId,
    authorizationDigest: authorization.authorizationDigest,
    nodeAttestationEvidenceId: evidence.evidenceId,
    nodeAttestationEvidenceDigest: evidence.evidenceDigest,
    jobId: request.jobId,
    attemptId: request.attemptId,
    effectIntentId: request.effectIntentId,
    operationDigest: request.operationDigest,
    idempotencyKey: request.idempotencyKey,
    authorityDigest: sha256Digest({
      authorizationDigest: authorization.authorizationDigest,
      nodeAttestationEvidenceDigest: evidence.evidenceDigest,
    }),
    effectiveDeadline,
    claimedAt: input.claimedAt,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sameEffectRetryAfterMarkerProhibited: true,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(effectClaimSchema, { ...unsigned, claimDigest: sha256Digest(unsigned) }) as ContentBloomsPlacementEffectClaimV1;
}

export function parseContentBloomsPlacementEffectClaimV1(value: unknown): ContentBloomsPlacementEffectClaimV1 {
  const claim = parseExactContentBloomsV1(effectClaimSchema, value) as ContentBloomsPlacementEffectClaimV1;
  const expectedKey = sha256Digest({
    schema: "control-room.effect-identity/v1",
    tenantId: claim.tenantId,
    nodeId: claim.nodeId,
    projectId: claim.projectId,
    jobId: claim.jobId,
    attemptId: claim.attemptId,
    operationDigest: claim.operationDigest,
  });
  if (expectedKey !== claim.claimKey
    || sha256Digest(withoutDigest(claim as unknown as Record<string, unknown>, "claimDigest")) !== claim.claimDigest
    || Date.parse(claim.claimedAt) >= Date.parse(claim.effectiveDeadline)) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return claim;
}

export function buildContentBloomsPlacementPreEffectMarkerV1(inputValue: unknown): ContentBloomsPlacementPreEffectMarkerV1 {
  const input = parseExactContentBloomsV1(markerInputSchema, inputValue);
  const claim = parseContentBloomsPlacementEffectClaimV1(input.claim);
  const request = parseContentBloomsPlacementRequestV1(input.request);
  if (claim.requestDigest !== request.requestDigest || claim.operationDigest !== request.operationDigest
    || claim.idempotencyKey !== request.idempotencyKey || claim.tenantId !== request.tenantId
    || claim.projectId !== request.projectId || claim.jobId !== request.jobId || claim.attemptId !== request.attemptId) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  if (Date.parse(input.markedAt) < Date.parse(claim.claimedAt)
    || Date.parse(input.markedAt) >= Date.parse(claim.effectiveDeadline)) {
    throw new ContentBloomsContractErrorV1("request_expired");
  }
  const unsigned: Omit<ContentBloomsPlacementPreEffectMarkerV1, "markerDigest"> = {
    schemaVersion: CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1,
    markerId: `cb-placement-marker:${claim.claimKey.slice(7, 39)}`,
    claimKey: claim.claimKey,
    claimDigest: claim.claimDigest,
    tenantId: claim.tenantId,
    workspaceId: claim.workspaceId,
    projectId: claim.projectId,
    adapterId: claim.adapterId,
    nodeId: claim.nodeId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    authorizationDigest: claim.authorizationDigest,
    nodeAttestationEvidenceDigest: claim.nodeAttestationEvidenceDigest,
    operationDigest: request.operationDigest,
    idempotencyKey: request.idempotencyKey,
    destination: "content-blooms:source-scheduled",
    sourceOperation: "request_transcription_route_preference",
    workItemSourceRecordId: request.workItemSourceRecordId,
    expectedSourceVersion: request.expectedSourceVersion,
    selectedRouteId: request.selectedRouteId,
    selectedRouteDigest: request.selectedRouteDigest,
    authorityDigest: claim.authorityDigest,
    effectiveDeadline: claim.effectiveDeadline,
    markedAt: input.markedAt,
    transportMode: "injected_fake_only",
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    controlRoomMayAssign: false,
    controlRoomMayLease: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(markerSchema, { ...unsigned, markerDigest: sha256Digest(unsigned) }) as ContentBloomsPlacementPreEffectMarkerV1;
}

export function parseContentBloomsPlacementPreEffectMarkerV1(value: unknown): ContentBloomsPlacementPreEffectMarkerV1 {
  const marker = parseExactContentBloomsV1(markerSchema, value) as ContentBloomsPlacementPreEffectMarkerV1;
  if (sha256Digest(withoutDigest(marker as unknown as Record<string, unknown>, "markerDigest")) !== marker.markerDigest
    || Date.parse(marker.markedAt) >= Date.parse(marker.effectiveDeadline)) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return marker;
}

export function buildContentBloomsPlacementTombstoneV1(inputValue: unknown): ContentBloomsPlacementTombstoneV1 {
  const input = parseExactContentBloomsV1(tombstoneInputSchema, inputValue);
  const claim = parseContentBloomsPlacementEffectClaimV1(input.claim);
  const outcome = parseContentBloomsPlacementOutcomeReceiptV1(input.outcome);
  if (outcome.tenantId !== claim.tenantId || outcome.projectId !== claim.projectId
    || outcome.requestDigest !== claim.requestDigest || outcome.authorizationDigest !== claim.authorizationDigest
    || outcome.operationDigest !== claim.operationDigest || outcome.idempotencyKey !== claim.idempotencyKey
    || Date.parse(input.sealedAt) < Date.parse("receivedAt" in outcome ? outcome.receivedAt : outcome.raisedAt)
    || Date.parse(input.retainUntil) <= Date.parse(input.sealedAt)) {
    throw new ContentBloomsContractErrorV1("sequence_invalid");
  }
  const unsigned: Omit<ContentBloomsPlacementTombstoneV1, "tombstoneDigest"> = {
    schemaVersion: CONTENT_BLOOMS_PLACEMENT_RUNTIME_V1,
    tombstoneId: `cb-placement-tombstone:${claim.claimKey.slice(7, 39)}`,
    tenantId: claim.tenantId,
    projectId: claim.projectId,
    claimKey: claim.claimKey,
    claimDigest: claim.claimDigest,
    requestDigest: claim.requestDigest,
    authorizationDigest: claim.authorizationDigest,
    idempotencyKey: claim.idempotencyKey,
    operationDigest: claim.operationDigest,
    outcomeDigest: outcome.receiptDigest,
    disposition: outcome.disposition,
    sealedAt: input.sealedAt,
    retainUntil: input.retainUntil,
    allRetentionHorizonsKnown: true,
    fullOutcomeRetained: true,
    prohibitsRedispatch: true,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(tombstoneSchema, { ...unsigned, tombstoneDigest: sha256Digest(unsigned) }) as ContentBloomsPlacementTombstoneV1;
}

export function parseContentBloomsPlacementTombstoneV1(value: unknown): ContentBloomsPlacementTombstoneV1 {
  const tombstone = parseExactContentBloomsV1(tombstoneSchema, value) as ContentBloomsPlacementTombstoneV1;
  if (sha256Digest(withoutDigest(tombstone as unknown as Record<string, unknown>, "tombstoneDigest")) !== tombstone.tombstoneDigest
    || Date.parse(tombstone.retainUntil) <= Date.parse(tombstone.sealedAt)) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return tombstone;
}

export function contentBloomsPlacementOutcomeRecordedAtV1(outcome: ContentBloomsPlacementOutcomeReceiptV1): string {
  return "receivedAt" in outcome ? outcome.receivedAt : outcome.raisedAt;
}
