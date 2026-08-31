import { z } from "zod";
import { sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import {
  parseOperationsPostgresReadinessDispositionV1,
  parseOperationsPostgresReadinessPacketV1,
  type OperationsPostgresReadinessDispositionV1,
  type OperationsPostgresReadinessPacketV1,
} from "./postgres-readiness";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime({ offset: true });
const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const trustedDateParse = Date.parse.bind(Date);
const trustedNumberIsFinite = Number.isFinite;

export const OPERATIONS_POSTGRES_REHEARSAL_REQUEST_V1 =
  "control-room-operations-postgres-rehearsal-request/v1" as const;
export const OPERATIONS_POSTGRES_REHEARSAL_DISPOSITION_V1 =
  "control-room-operations-postgres-rehearsal-disposition/v1" as const;
export const OPERATIONS_POSTGRES_REHEARSAL_PROJECTION_V1 =
  "control-room-operations-postgres-rehearsal-projection/v1" as const;
export const OPERATIONS_ACCEPTED_AUTO100_COMMIT_V1 =
  "34750ed8ec5cf34134d166505f3df50897afe3f7" as const;
export const OPERATIONS_ACCEPTED_AUTO100_REVIEW_SHA256_V1 =
  "sha256:aa2116b832ed6e5587c72705dcf6dc826f8ef0e7201c5b284c7876b93f53c0a9" as const;
export const OPERATIONS_POSTGRES_REHEARSAL_MAX_REQUEST_LIFETIME_SECONDS_V1 = 3_600 as const;
export const OPERATIONS_POSTGRES_REHEARSAL_MAX_NATIVE_ATTEMPTS_V1 = 1 as const;
export const OPERATIONS_POSTGRES_REHEARSAL_MAX_HOST_SESSIONS_V1 = 1 as const;
export const OPERATIONS_POSTGRES_REHEARSAL_MAX_DATABASE_SESSIONS_V1 = 4 as const;
export const OPERATIONS_POSTGRES_REHEARSAL_MAX_DURATION_SECONDS_V1 = 1_800 as const;
export const OPERATIONS_POSTGRES_REHEARSAL_MAX_EVIDENCE_BYTES_V1 = 1_048_576 as const;

export const OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_ID_V1 =
  "owner-direction:operations:postgres-rehearsal:auto110:1" as const;
export const OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_AT_V1 =
  "2026-08-31T16:58:35.000Z" as const;

export const operationsPostgresRehearsalStageCodesV1 = Object.freeze([
  "verify_protected_host_identity",
  "verify_private_network_boundary",
  "observe_postgres_runtime",
  "verify_role_and_credential_custody",
  "verify_backup_and_wal",
  "run_disposable_restore",
  "verify_migration_compatibility",
  "verify_health_and_resource_headroom",
  "collect_sanitized_evidence",
  "cleanup_disposable_resources",
] as const);
export type OperationsPostgresRehearsalStageCodeV1 =
  (typeof operationsPostgresRehearsalStageCodesV1)[number];

export const operationsPostgresRehearsalRequirementCodesV1 = Object.freeze([
  "accepted_auto100_lineage",
  "all_readiness_blockers_closed",
  "exact_strong_owner_effect_authorization",
  "protected_host_reference",
  "protected_access_path",
  "effect_scoped_claim_and_marker",
  "one_attempt_window",
  "rollback_material",
  "separate_cleanup_authorization",
  "sanitized_evidence_boundary",
  "independent_security_acceptance",
] as const);
export type OperationsPostgresRehearsalRequirementCodeV1 =
  (typeof operationsPostgresRehearsalRequirementCodesV1)[number];

export interface OperationsPostgresRehearsalOwnerPhaseDirectionV1 {
  directionId: typeof OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_ID_V1;
  source: "repository_accepted_owner_direction_snapshot";
  scope: "auto110_effect_free_packet_preparation_and_independent_review_only";
  acceptedAt: typeof OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_AT_V1;
  liveEffectAuthorization: false;
  protectedReferenceAuthority: false;
  hostContactAuthority: false;
  directionDigest: string;
}

export interface OperationsPostgresRehearsalRequestV1 {
  contractVersion: typeof OPERATIONS_POSTGRES_REHEARSAL_REQUEST_V1;
  requestId: string;
  sourceReadinessPacketId: string;
  sourceReadinessPacketDigest: string;
  sourceReadinessDispositionId: string;
  sourceReadinessDispositionDigest: string;
  sourceReadinessPacket: OperationsPostgresReadinessPacketV1;
  sourceReadinessDisposition: OperationsPostgresReadinessDispositionV1;
  acceptedAuto100Commit: typeof OPERATIONS_ACCEPTED_AUTO100_COMMIT_V1;
  acceptedAuto100ReviewSha256: typeof OPERATIONS_ACCEPTED_AUTO100_REVIEW_SHA256_V1;
  ownerPhaseDirectionId: typeof OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_ID_V1;
  ownerPhaseDirectionDigest: string;
  ownerPhaseDirection: OperationsPostgresRehearsalOwnerPhaseDirectionV1;
  packetKind: "controlled_effect_request_not_authority";
  rehearsalMode: "owner_attended_native_private_postgresql";
  targetClass: "owner_selected_hostinger_kvm2_private_postgresql_target";
  resourceClass: "disposable_nonproduction_database_on_selected_private_host";
  protectedAccessMode: "owner_attended_protected_reference_only";
  evidenceMode: "sanitized_digest_and_safe_codes_only";
  requestedStageCodes: OperationsPostgresRehearsalStageCodeV1[];
  blockingRequirementCodes: OperationsPostgresRehearsalRequirementCodeV1[];
  readinessBlockingGateKeys: string[];
  readinessBlockingGateCount: 36;
  maxNativeAttemptsRequested: typeof OPERATIONS_POSTGRES_REHEARSAL_MAX_NATIVE_ATTEMPTS_V1;
  maxHostSessionsRequested: typeof OPERATIONS_POSTGRES_REHEARSAL_MAX_HOST_SESSIONS_V1;
  maxDatabaseSessionsRequested: typeof OPERATIONS_POSTGRES_REHEARSAL_MAX_DATABASE_SESSIONS_V1;
  maxDurationSecondsRequested: typeof OPERATIONS_POSTGRES_REHEARSAL_MAX_DURATION_SECONDS_V1;
  maxEvidenceBytesRequested: typeof OPERATIONS_POSTGRES_REHEARSAL_MAX_EVIDENCE_BYTES_V1;
  productionDataAllowed: false;
  publicEndpointAllowed: false;
  existingProductionSchemaWritesAllowed: false;
  serviceInstallationRequested: false;
  serviceControlRequested: false;
  rawEvidenceRetentionAllowed: false;
  automaticRetryAllowed: false;
  rollbackRequired: true;
  cleanupRequired: true;
  cleanupMustBeSeparatelyAuthorized: true;
  cleanupReceiptRequired: true;
  phasePreparationAuthorized: true;
  exactLiveEffectAuthorizationPresent: false;
  ownerStrongFactorPresent: false;
  ownerEffectWindowPresent: false;
  protectedHostReferencePresent: false;
  protectedAccessPathPresent: false;
  effectClaimPresent: false;
  rollbackMaterialPresent: false;
  cleanupAuthorizationPresent: false;
  independentReviewAccepted: false;
  hostContactAuthorized: false;
  protectedReferenceResolutionAuthorized: false;
  processStartAuthorized: false;
  databaseContactAuthorized: false;
  migrationAuthorized: false;
  backupOrRestoreAuthorized: false;
  cleanupAuthorized: false;
  productionConsumerAuthorized: false;
  deploymentAuthorized: false;
  grantsApproval: false;
  grantsClaimOrLease: false;
  grantsDispatchOrExecution: false;
  grantsExternalEffects: false;
  state: "blocked_pending_live_prerequisites_and_exact_effect_authorization";
  safeReason: "phase_authorized_live_effect_packet_incomplete";
  requestedAt: string;
  expiresAt: string;
  requestDigest: string;
}

export interface OperationsPostgresRehearsalDispositionV1 {
  contractVersion: typeof OPERATIONS_POSTGRES_REHEARSAL_DISPOSITION_V1;
  dispositionId: string;
  requestId: string;
  requestDigest: string;
  status: "disabled_before_protected_reference_resolution";
  safeReason: "live_prerequisites_and_exact_effect_authorization_missing";
  readinessBlockingGateKeys: string[];
  recordedAt: string;
  newPacketRequiredAfterEvidenceChange: true;
  automaticRetryAllowed: false;
  hostContacted: false;
  protectedReferenceResolved: false;
  processStarted: false;
  databaseContacted: false;
  migrationAttempted: false;
  backupOrRestoreAttempted: false;
  cleanupAttempted: false;
  productionConsumerActivated: false;
  deploymentAttempted: false;
  rawEvidenceRetained: false;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  dispositionDigest: string;
}

export interface OperationsPostgresRehearsalProjectionV1 {
  contractVersion: typeof OPERATIONS_POSTGRES_REHEARSAL_PROJECTION_V1;
  requestId: string;
  requestDigest: string;
  dispositionId: string;
  dispositionDigest: string;
  providerTarget: "hostinger_kvm2_vps";
  status: "blocked_pending_live_prerequisites_and_exact_effect_authorization";
  safeReason: "phase_authorized_live_effect_packet_incomplete";
  phasePreparationAuthorized: true;
  readinessBlockingGateCount: 36;
  readinessBlockingGateKeys: string[];
  maxNativeAttemptsRequested: 1;
  maxDurationSecondsRequested: 1_800;
  canResolveProtectedReferences: false;
  canContactHost: false;
  canStartProcesses: false;
  canContactDatabase: false;
  canRunMigrations: false;
  canRunBackupOrRestore: false;
  canCleanupResources: false;
  canActivateConsumer: false;
  canDeploy: false;
  projectionDigest: string;
}

const safeCode = z.string().min(1).max(180).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const stageCode = z.enum(operationsPostgresRehearsalStageCodesV1);
const requirementCode = z.enum(operationsPostgresRehearsalRequirementCodesV1);
const ownerPhaseDirectionSchema = z.object({
  directionId: z.literal(OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_ID_V1),
  source: z.literal("repository_accepted_owner_direction_snapshot"),
  scope: z.literal("auto110_effect_free_packet_preparation_and_independent_review_only"),
  acceptedAt: z.literal(OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_AT_V1),
  liveEffectAuthorization: z.literal(false), protectedReferenceAuthority: z.literal(false),
  hostContactAuthority: z.literal(false), directionDigest: digest,
}).strict();
const acceptedOwnerPhaseDirectionMaterial = {
  directionId: OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_ID_V1,
  source: "repository_accepted_owner_direction_snapshot" as const,
  scope: "auto110_effect_free_packet_preparation_and_independent_review_only" as const,
  acceptedAt: OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_AT_V1,
  liveEffectAuthorization: false as const,
  protectedReferenceAuthority: false as const,
  hostContactAuthority: false as const,
};
const acceptedOwnerPhaseDirection = Object.freeze({ ...acceptedOwnerPhaseDirectionMaterial,
  directionDigest: sha256Digest(acceptedOwnerPhaseDirectionMaterial) });
const acceptedOwnerPhaseDirectionSnapshotDigest = sha256Digest(acceptedOwnerPhaseDirection);
const requestInputSchema = z.object({ requestId: id, sourceReadinessPacket: z.unknown(),
  sourceReadinessDisposition: z.unknown(), requestedAt: time, expiresAt: time }).strict();
const requestSchema = z.object({ contractVersion: z.literal(OPERATIONS_POSTGRES_REHEARSAL_REQUEST_V1), requestId: id,
  sourceReadinessPacketId: id, sourceReadinessPacketDigest: digest, sourceReadinessDispositionId: id,
  sourceReadinessDispositionDigest: digest, sourceReadinessPacket: z.unknown(), sourceReadinessDisposition: z.unknown(),
  acceptedAuto100Commit: z.literal(OPERATIONS_ACCEPTED_AUTO100_COMMIT_V1),
  acceptedAuto100ReviewSha256: z.literal(OPERATIONS_ACCEPTED_AUTO100_REVIEW_SHA256_V1),
  ownerPhaseDirectionId: z.literal(OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_ID_V1),
  ownerPhaseDirectionDigest: digest, ownerPhaseDirection: z.unknown(),
  packetKind: z.literal("controlled_effect_request_not_authority"),
  rehearsalMode: z.literal("owner_attended_native_private_postgresql"),
  targetClass: z.literal("owner_selected_hostinger_kvm2_private_postgresql_target"),
  resourceClass: z.literal("disposable_nonproduction_database_on_selected_private_host"),
  protectedAccessMode: z.literal("owner_attended_protected_reference_only"),
  evidenceMode: z.literal("sanitized_digest_and_safe_codes_only"),
  requestedStageCodes: z.array(stageCode).length(10), blockingRequirementCodes: z.array(requirementCode).length(11),
  readinessBlockingGateKeys: z.array(safeCode).length(36), readinessBlockingGateCount: z.literal(36),
  maxNativeAttemptsRequested: z.literal(OPERATIONS_POSTGRES_REHEARSAL_MAX_NATIVE_ATTEMPTS_V1),
  maxHostSessionsRequested: z.literal(OPERATIONS_POSTGRES_REHEARSAL_MAX_HOST_SESSIONS_V1),
  maxDatabaseSessionsRequested: z.literal(OPERATIONS_POSTGRES_REHEARSAL_MAX_DATABASE_SESSIONS_V1),
  maxDurationSecondsRequested: z.literal(OPERATIONS_POSTGRES_REHEARSAL_MAX_DURATION_SECONDS_V1),
  maxEvidenceBytesRequested: z.literal(OPERATIONS_POSTGRES_REHEARSAL_MAX_EVIDENCE_BYTES_V1),
  productionDataAllowed: z.literal(false), publicEndpointAllowed: z.literal(false),
  existingProductionSchemaWritesAllowed: z.literal(false), serviceInstallationRequested: z.literal(false),
  serviceControlRequested: z.literal(false), rawEvidenceRetentionAllowed: z.literal(false),
  automaticRetryAllowed: z.literal(false), rollbackRequired: z.literal(true), cleanupRequired: z.literal(true),
  cleanupMustBeSeparatelyAuthorized: z.literal(true), cleanupReceiptRequired: z.literal(true),
  phasePreparationAuthorized: z.literal(true), exactLiveEffectAuthorizationPresent: z.literal(false),
  ownerStrongFactorPresent: z.literal(false), ownerEffectWindowPresent: z.literal(false),
  protectedHostReferencePresent: z.literal(false), protectedAccessPathPresent: z.literal(false),
  effectClaimPresent: z.literal(false), rollbackMaterialPresent: z.literal(false),
  cleanupAuthorizationPresent: z.literal(false), independentReviewAccepted: z.literal(false),
  hostContactAuthorized: z.literal(false), protectedReferenceResolutionAuthorized: z.literal(false),
  processStartAuthorized: z.literal(false), databaseContactAuthorized: z.literal(false), migrationAuthorized: z.literal(false),
  backupOrRestoreAuthorized: z.literal(false), cleanupAuthorized: z.literal(false),
  productionConsumerAuthorized: z.literal(false), deploymentAuthorized: z.literal(false), grantsApproval: z.literal(false),
  grantsClaimOrLease: z.literal(false), grantsDispatchOrExecution: z.literal(false),
  grantsExternalEffects: z.literal(false),
  state: z.literal("blocked_pending_live_prerequisites_and_exact_effect_authorization"),
  safeReason: z.literal("phase_authorized_live_effect_packet_incomplete"), requestedAt: time, expiresAt: time,
  requestDigest: digest }).strict();
const dispositionInputSchema = z.object({ request: z.unknown(), recordedAt: time }).strict();
const dispositionSchema = z.object({ contractVersion: z.literal(OPERATIONS_POSTGRES_REHEARSAL_DISPOSITION_V1),
  dispositionId: id, requestId: id, requestDigest: digest,
  status: z.literal("disabled_before_protected_reference_resolution"),
  safeReason: z.literal("live_prerequisites_and_exact_effect_authorization_missing"),
  readinessBlockingGateKeys: z.array(safeCode).length(36), recordedAt: time,
  newPacketRequiredAfterEvidenceChange: z.literal(true), automaticRetryAllowed: z.literal(false),
  hostContacted: z.literal(false), protectedReferenceResolved: z.literal(false), processStarted: z.literal(false),
  databaseContacted: z.literal(false), migrationAttempted: z.literal(false), backupOrRestoreAttempted: z.literal(false),
  cleanupAttempted: z.literal(false), productionConsumerActivated: z.literal(false), deploymentAttempted: z.literal(false),
  rawEvidenceRetained: z.literal(false), externalEffectOccurred: z.literal(false), grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  dispositionDigest: digest }).strict();
const projectionSchema = z.object({ contractVersion: z.literal(OPERATIONS_POSTGRES_REHEARSAL_PROJECTION_V1),
  requestId: id, requestDigest: digest, dispositionId: id, dispositionDigest: digest,
  providerTarget: z.literal("hostinger_kvm2_vps"),
  status: z.literal("blocked_pending_live_prerequisites_and_exact_effect_authorization"),
  safeReason: z.literal("phase_authorized_live_effect_packet_incomplete"), phasePreparationAuthorized: z.literal(true),
  readinessBlockingGateCount: z.literal(36), readinessBlockingGateKeys: z.array(safeCode).length(36),
  maxNativeAttemptsRequested: z.literal(1), maxDurationSecondsRequested: z.literal(1_800),
  canResolveProtectedReferences: z.literal(false), canContactHost: z.literal(false),
  canStartProcesses: z.literal(false), canContactDatabase: z.literal(false), canRunMigrations: z.literal(false),
  canRunBackupOrRestore: z.literal(false), canCleanupResources: z.literal(false),
  canActivateConsumer: z.literal(false), canDeploy: z.literal(false), projectionDigest: digest }).strict();

function copyList<T>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (let position = 0; position < values.length; position += 1) result.push(values[position]!);
  return result;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let position = 0; position < left.length; position += 1) if (left[position] !== right[position]) return false;
  return true;
}

function timestamp(value: string): number {
  const parsed = trustedDateParse(value);
  if (!trustedNumberIsFinite(parsed)) throw new OperationsContractErrorV1("invalid_input");
  return parsed;
}

function parseCanonicalOwnerPhaseDirection(value: unknown): OperationsPostgresRehearsalOwnerPhaseDirectionV1 {
  const direction = parseExactOperationsV1(ownerPhaseDirectionSchema, value,
    "operations postgres rehearsal owner phase direction");
  verifyOperationsDigestV1(direction as unknown as Record<string, unknown>, "directionDigest",
    direction.directionDigest);
  if (sha256Digest(direction) !== acceptedOwnerPhaseDirectionSnapshotDigest
    || direction.directionDigest !== acceptedOwnerPhaseDirection.directionDigest) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  return direction;
}

function parseSource(packetValue: unknown, dispositionValue: unknown): {
  packet: OperationsPostgresReadinessPacketV1;
  disposition: OperationsPostgresReadinessDispositionV1;
} {
  const packet = parseOperationsPostgresReadinessPacketV1(packetValue);
  const disposition = parseOperationsPostgresReadinessDispositionV1(dispositionValue, packet);
  if (packet.state !== "blocked_repository_only" || packet.blockingGateCount !== 36
    || packet.metRepositoryContractCount !== 3 || packet.eligibleForOwnerWindow || packet.productionReady
    || disposition.status !== "disabled_before_host_contact" || disposition.externalEffectOccurred) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  return { packet, disposition };
}

export function buildOperationsPostgresRehearsalRequestV1(inputValue: unknown): OperationsPostgresRehearsalRequestV1 {
  const input = parseExactOperationsV1(requestInputSchema, inputValue, "operations postgres rehearsal request input");
  const { packet, disposition } = parseSource(input.sourceReadinessPacket, input.sourceReadinessDisposition);
  const direction = parseCanonicalOwnerPhaseDirection(acceptedOwnerPhaseDirection);
  const requestedAt = timestamp(input.requestedAt), expiresAt = timestamp(input.expiresAt);
  if (requestedAt < timestamp(direction.acceptedAt) || requestedAt < timestamp(disposition.recordedAt)
    || expiresAt <= requestedAt
    || expiresAt - requestedAt > OPERATIONS_POSTGRES_REHEARSAL_MAX_REQUEST_LIFETIME_SECONDS_V1 * 1_000) {
    throw new OperationsContractErrorV1("invalid_input");
  }
  const material: Omit<OperationsPostgresRehearsalRequestV1, "requestDigest"> = {
    contractVersion: OPERATIONS_POSTGRES_REHEARSAL_REQUEST_V1, requestId: input.requestId,
    sourceReadinessPacketId: packet.packetId, sourceReadinessPacketDigest: packet.packetDigest,
    sourceReadinessDispositionId: disposition.dispositionId,
    sourceReadinessDispositionDigest: disposition.dispositionDigest, sourceReadinessPacket: packet,
    sourceReadinessDisposition: disposition, acceptedAuto100Commit: OPERATIONS_ACCEPTED_AUTO100_COMMIT_V1,
    acceptedAuto100ReviewSha256: OPERATIONS_ACCEPTED_AUTO100_REVIEW_SHA256_V1,
    ownerPhaseDirectionId: direction.directionId, ownerPhaseDirectionDigest: direction.directionDigest,
    ownerPhaseDirection: direction,
    packetKind: "controlled_effect_request_not_authority", rehearsalMode: "owner_attended_native_private_postgresql",
    targetClass: "owner_selected_hostinger_kvm2_private_postgresql_target",
    resourceClass: "disposable_nonproduction_database_on_selected_private_host",
    protectedAccessMode: "owner_attended_protected_reference_only",
    evidenceMode: "sanitized_digest_and_safe_codes_only", requestedStageCodes: copyList(operationsPostgresRehearsalStageCodesV1),
    blockingRequirementCodes: copyList(operationsPostgresRehearsalRequirementCodesV1),
    readinessBlockingGateKeys: copyList(packet.blockingGateKeys), readinessBlockingGateCount: 36,
    maxNativeAttemptsRequested: OPERATIONS_POSTGRES_REHEARSAL_MAX_NATIVE_ATTEMPTS_V1,
    maxHostSessionsRequested: OPERATIONS_POSTGRES_REHEARSAL_MAX_HOST_SESSIONS_V1,
    maxDatabaseSessionsRequested: OPERATIONS_POSTGRES_REHEARSAL_MAX_DATABASE_SESSIONS_V1,
    maxDurationSecondsRequested: OPERATIONS_POSTGRES_REHEARSAL_MAX_DURATION_SECONDS_V1,
    maxEvidenceBytesRequested: OPERATIONS_POSTGRES_REHEARSAL_MAX_EVIDENCE_BYTES_V1,
    productionDataAllowed: false, publicEndpointAllowed: false, existingProductionSchemaWritesAllowed: false,
    serviceInstallationRequested: false, serviceControlRequested: false, rawEvidenceRetentionAllowed: false,
    automaticRetryAllowed: false, rollbackRequired: true, cleanupRequired: true,
    cleanupMustBeSeparatelyAuthorized: true, cleanupReceiptRequired: true, phasePreparationAuthorized: true,
    exactLiveEffectAuthorizationPresent: false, ownerStrongFactorPresent: false, ownerEffectWindowPresent: false,
    protectedHostReferencePresent: false, protectedAccessPathPresent: false, effectClaimPresent: false,
    rollbackMaterialPresent: false, cleanupAuthorizationPresent: false, independentReviewAccepted: false,
    hostContactAuthorized: false, protectedReferenceResolutionAuthorized: false, processStartAuthorized: false,
    databaseContactAuthorized: false, migrationAuthorized: false, backupOrRestoreAuthorized: false,
    cleanupAuthorized: false, productionConsumerAuthorized: false, deploymentAuthorized: false, grantsApproval: false,
    grantsClaimOrLease: false, grantsDispatchOrExecution: false, grantsExternalEffects: false,
    state: "blocked_pending_live_prerequisites_and_exact_effect_authorization",
    safeReason: "phase_authorized_live_effect_packet_incomplete", requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
  };
  return parseOperationsPostgresRehearsalRequestV1({ ...material, requestDigest: sha256Digest(material) });
}

export function parseOperationsPostgresRehearsalRequestV1(value: unknown): OperationsPostgresRehearsalRequestV1 {
  const request = parseExactOperationsV1(requestSchema, value,
    "operations postgres rehearsal request") as unknown as OperationsPostgresRehearsalRequestV1;
  const { packet, disposition } = parseSource(request.sourceReadinessPacket, request.sourceReadinessDisposition);
  const direction = parseCanonicalOwnerPhaseDirection(request.ownerPhaseDirection);
  const requestedAt = timestamp(request.requestedAt), expiresAt = timestamp(request.expiresAt);
  if (request.sourceReadinessPacketId !== packet.packetId
    || request.sourceReadinessPacketDigest !== packet.packetDigest
    || request.sourceReadinessDispositionId !== disposition.dispositionId
    || request.sourceReadinessDispositionDigest !== disposition.dispositionDigest
    || request.ownerPhaseDirectionId !== direction.directionId
    || request.ownerPhaseDirectionDigest !== direction.directionDigest
    || !sameList(request.requestedStageCodes, operationsPostgresRehearsalStageCodesV1)
    || !sameList(request.blockingRequirementCodes, operationsPostgresRehearsalRequirementCodesV1)
    || !sameList(request.readinessBlockingGateKeys, packet.blockingGateKeys)
    || requestedAt < timestamp(direction.acceptedAt) || requestedAt < timestamp(disposition.recordedAt)
    || expiresAt <= requestedAt
    || expiresAt - requestedAt > OPERATIONS_POSTGRES_REHEARSAL_MAX_REQUEST_LIFETIME_SECONDS_V1 * 1_000) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(request as unknown as Record<string, unknown>, "requestDigest", request.requestDigest);
  return request;
}

export function buildOperationsPostgresRehearsalDispositionV1(inputValue: unknown):
  OperationsPostgresRehearsalDispositionV1 {
  const input = parseExactOperationsV1(dispositionInputSchema, inputValue,
    "operations postgres rehearsal disposition input");
  const request = parseOperationsPostgresRehearsalRequestV1(input.request);
  if (timestamp(input.recordedAt) < timestamp(request.requestedAt)) {
    throw new OperationsContractErrorV1("invalid_input");
  }
  const material: Omit<OperationsPostgresRehearsalDispositionV1, "dispositionDigest"> = {
    contractVersion: OPERATIONS_POSTGRES_REHEARSAL_DISPOSITION_V1,
    dispositionId: `disposition:operations:postgres-rehearsal:${request.requestDigest.slice(7, 31)}`,
    requestId: request.requestId, requestDigest: request.requestDigest,
    status: "disabled_before_protected_reference_resolution",
    safeReason: "live_prerequisites_and_exact_effect_authorization_missing",
    readinessBlockingGateKeys: copyList(request.readinessBlockingGateKeys), recordedAt: input.recordedAt,
    newPacketRequiredAfterEvidenceChange: true, automaticRetryAllowed: false, hostContacted: false,
    protectedReferenceResolved: false, processStarted: false, databaseContacted: false, migrationAttempted: false,
    backupOrRestoreAttempted: false, cleanupAttempted: false, productionConsumerActivated: false,
    deploymentAttempted: false, rawEvidenceRetained: false, externalEffectOccurred: false, grantsApproval: false,
    grantsDeploymentAuthority: false, grantsExecutionAuthority: false,
  };
  return parseOperationsPostgresRehearsalDispositionV1({ ...material, dispositionDigest: sha256Digest(material) }, request);
}

export function parseOperationsPostgresRehearsalDispositionV1(value: unknown, requestValue: unknown):
  OperationsPostgresRehearsalDispositionV1 {
  const request = parseOperationsPostgresRehearsalRequestV1(requestValue);
  const disposition = parseExactOperationsV1(dispositionSchema, value, "operations postgres rehearsal disposition");
  if (disposition.dispositionId !== `disposition:operations:postgres-rehearsal:${request.requestDigest.slice(7, 31)}`
    || disposition.requestId !== request.requestId || disposition.requestDigest !== request.requestDigest
    || !sameList(disposition.readinessBlockingGateKeys, request.readinessBlockingGateKeys)
    || timestamp(disposition.recordedAt) < timestamp(request.requestedAt)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(disposition as unknown as Record<string, unknown>, "dispositionDigest",
    disposition.dispositionDigest);
  return disposition;
}

export function projectOperationsPostgresRehearsalV1(requestValue: unknown, dispositionValue: unknown):
  OperationsPostgresRehearsalProjectionV1 {
  const request = parseOperationsPostgresRehearsalRequestV1(requestValue);
  const disposition = parseOperationsPostgresRehearsalDispositionV1(dispositionValue, request);
  const material: Omit<OperationsPostgresRehearsalProjectionV1, "projectionDigest"> = {
    contractVersion: OPERATIONS_POSTGRES_REHEARSAL_PROJECTION_V1, requestId: request.requestId,
    requestDigest: request.requestDigest, dispositionId: disposition.dispositionId,
    dispositionDigest: disposition.dispositionDigest, providerTarget: "hostinger_kvm2_vps",
    status: request.state, safeReason: request.safeReason, phasePreparationAuthorized: true,
    readinessBlockingGateCount: 36, readinessBlockingGateKeys: copyList(request.readinessBlockingGateKeys),
    maxNativeAttemptsRequested: 1, maxDurationSecondsRequested: 1_800, canResolveProtectedReferences: false,
    canContactHost: false, canStartProcesses: false, canContactDatabase: false, canRunMigrations: false,
    canRunBackupOrRestore: false, canCleanupResources: false, canActivateConsumer: false, canDeploy: false,
  };
  return parseOperationsPostgresRehearsalProjectionV1({ ...material, projectionDigest: sha256Digest(material) },
    request, disposition);
}

export function parseOperationsPostgresRehearsalProjectionV1(value: unknown, requestValue: unknown,
  dispositionValue: unknown): OperationsPostgresRehearsalProjectionV1 {
  const request = parseOperationsPostgresRehearsalRequestV1(requestValue);
  const disposition = parseOperationsPostgresRehearsalDispositionV1(dispositionValue, request);
  const projection = parseExactOperationsV1(projectionSchema, value, "operations postgres rehearsal projection");
  if (projection.requestId !== request.requestId || projection.requestDigest !== request.requestDigest
    || projection.dispositionId !== disposition.dispositionId
    || projection.dispositionDigest !== disposition.dispositionDigest
    || !sameList(projection.readinessBlockingGateKeys, request.readinessBlockingGateKeys)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(projection as unknown as Record<string, unknown>, "projectionDigest",
    projection.projectionDigest);
  return projection;
}
