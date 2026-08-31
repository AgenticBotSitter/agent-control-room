import { z } from "zod";
import { exactProjectWorkspaceJsonV1, ProjectWorkspaceContractErrorV1, projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import { parseWayfarerProjectPackV1 } from "./contract";
import { WAYFARER_LOCAL_STORE_ID_V1, WAYFARER_LOCATOR_REGISTRY_ID_V1, WAYFARER_R2_STORE_ID_V1,
  WAYFARER_STORAGE_CONTRACT_V1, type WayfarerCapacityReservationV1, type WayfarerLogicalStoreV1,
  type WayfarerRetentionProposalV1, type WayfarerStorageArtifactDeclarationV1, type WayfarerStorageAttemptObservationV1,
  type WayfarerStorageAttemptOutcomeV1, type WayfarerStorageCleanupReceiptV1, type WayfarerStorageLifecycleStateV1,
  type WayfarerStoragePlanV1, type WayfarerStoragePolicyV1, type WayfarerStoreIdV1 } from "./storage-types";

const storeId = z.enum([WAYFARER_LOCAL_STORE_ID_V1, WAYFARER_R2_STORE_ID_V1]);
const storageClass = z.enum(["local_private", "r2_private"]);
const lifecycle = z.enum(["declared", "reserved", "write_marker_recorded", "stored_unverified", "verified", "quarantined",
  "ambiguous", "retention_candidate", "cleanup_proposed", "released"]);
const role = z.enum(["source_scene_manifest", "source_audio_brief", "render_segment", "audio_candidate", "qc_report", "review_proxy",
  "review_manifest", "episode_master", "assembly_manifest", "publication_package"]);
const safeContentType = z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,49}\/[a-z0-9][a-z0-9.+-]{0,49}$/u);

const logicalStoreSchema = z.object({ storeId, storageClass, logicalNamespaceId: id, scopeIdentityDigest: digest,
  locatorRegistryId: z.literal(WAYFARER_LOCATOR_REGISTRY_ID_V1), locatorReferenceMode: z.literal("digest_only"),
  locatorValuesRemainBrokerPrivate: z.literal(true), immutableObjectKeys: z.literal(true), overwriteAllowed: z.literal(false),
  requiresContentDigest: z.literal(true), requiresExactSize: z.literal(true), maximumObjectBytes: z.number().int().positive().max(34_359_738_368),
  maximumReservationBytes: z.number().int().positive().max(68_719_476_736), maximumOutstandingObjects: z.number().int().positive().max(10_000),
  credentialBindingMode: z.enum(["none", "owner_configured_broker_private"]), adapterConfigured: z.literal(false),
  adapterQualified: z.literal(false), liveAccessAllowed: z.literal(false), filesystemAccessAllowed: z.literal(false),
  networkAccessAllowed: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
const locatorCustodySchema = z.object({ locatorRegistryId: z.literal(WAYFARER_LOCATOR_REGISTRY_ID_V1),
  controlPlaneStoresLocatorValues: z.literal(false), controlPlaneStoresPaths: z.literal(false),
  controlPlaneStoresBucketNames: z.literal(false), controlPlaneStoresAccountIdentifiers: z.literal(false),
  controlPlaneStoresEndpoints: z.literal(false), controlPlaneStoresSignedUrls: z.literal(false),
  locatorResolutionRequiresSeparateAuthority: z.literal(true), locatorResolutionAllowedByThisContract: z.literal(false),
  locatorReferencesGrantAuthority: z.literal(false) }).strict();
const retryPolicySchema = z.object({ maximumPreMarkerRetries: z.literal(1), automaticPostMarkerRetryAllowed: z.literal(false),
  restartAfterMarkerDisposition: z.literal("terminal_ambiguous"), unknownAfterMarkerDisposition: z.literal("terminal_ambiguous"),
  integrityMismatchDisposition: z.literal("quarantine"), ambiguityRequiresAuthoritativeReconciliation: z.literal(true),
  ambiguityCanBeClearedByRetry: z.literal(false) }).strict();
const transitionSchema = z.object({ from: lifecycle, to: lifecycle }).strict();
const policySchema = z.object({ contractVersion: z.literal(WAYFARER_STORAGE_CONTRACT_V1), policyId: id, tenantId: id,
  workspaceId: id, projectId: id, packId: id, packDigest: digest, stores: z.tuple([logicalStoreSchema, logicalStoreSchema]),
  locatorCustody: locatorCustodySchema, retryPolicy: retryPolicySchema, allowedTransitions: z.array(transitionSchema).length(13),
  storageIsCoordinationPlane: z.literal(false), storesRawCredentials: z.literal(false), storesArtifactBytesInControlPlane: z.literal(false),
  automaticRetentionCleanupAllowed: z.literal(false), legalHoldWins: z.literal(true), syntheticEvaluationOnly: z.literal(true),
  enablesFilesystemAdapter: z.literal(false), enablesR2Adapter: z.literal(false), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), createdAt: time, policyDigest: digest }).strict();
const artifactDeclarationSchema = z.object({ artifactId: id, episodeId: id, role, contentType: safeContentType, contentDigest: digest,
  sizeBytes: z.number().int().positive().max(34_359_738_368), createdAt: time }).strict();
const reservationSchema = z.object({ reservationId: id, storeId, reservedObjectCount: z.literal(1),
  reservedBytes: z.number().int().positive().max(34_359_738_368), expiresAt: time, state: z.literal("proposed"),
  acquiredCapacity: z.literal(false), canWrite: z.literal(false), grantsExecutionAuthority: z.literal(false), reservationDigest: digest }).strict();
const planSchema = z.object({ contractVersion: z.literal(WAYFARER_STORAGE_CONTRACT_V1), planId: id, tenantId: id, workspaceId: id,
  projectId: id, packId: id, packDigest: digest, policyId: id, policyDigest: digest, storeId, storageClass,
  artifact: artifactDeclarationSchema, artifactIdentityDigest: digest, objectKeyDigest: digest, locatorRefDigest: digest,
  retentionClassId: id, capacityReservation: reservationSchema, lifecycleState: z.literal("declared"), embedsBytes: z.literal(false),
  containsLocatorValue: z.literal(false), resolvesLocator: z.literal(false), resolvesCredential: z.literal(false), writesObject: z.literal(false),
  createsEffectIntent: z.literal(false), syntheticEvaluationOnly: z.literal(true), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), plannedAt: time, planDigest: digest }).strict();
const observationSchema = z.object({ observationCode: z.enum(["simulated_store_verified", "definite_pre_marker_failure",
  "capacity_unavailable_pre_marker", "integrity_mismatch_after_marker", "post_marker_outcome_unknown", "restart_after_marker"]),
  markerRecorded: z.boolean(), observedContentDigest: digest.optional(), observedSizeBytes: z.number().int().positive().max(34_359_738_368).optional(),
  safeEvidenceDigest: digest }).strict();
const outcomeSchema = z.object({ contractVersion: z.literal(WAYFARER_STORAGE_CONTRACT_V1), outcomeId: id, planId: id,
  planDigest: digest, policyDigest: digest, artifactIdentityDigest: digest, expectedContentDigest: digest,
  expectedSizeBytes: z.number().int().positive().max(34_359_738_368), attemptNumber: z.union([z.literal(1), z.literal(2)]),
  previousOutcomeDigest: digest.optional(),
  observation: observationSchema, disposition: z.enum(["simulated_verified", "definite_failure", "capacity_blocked", "quarantined", "ambiguous"]),
  lifecycleState: z.enum(["verified", "released", "quarantined", "ambiguous"]),
  reservationDisposition: z.enum(["simulated_consumed", "released", "quarantined", "held_for_reconciliation"]), retryAllowed: z.boolean(),
  retryReason: z.enum(["definite_pre_marker_only", "retry_limit_reached", "post_marker_retry_forbidden", "not_applicable"]),
  requiresReconciliation: z.boolean(), locatorResolved: z.literal(false), credentialResolved: z.literal(false),
  bytesTransferred: z.literal(false), filesystemUsed: z.literal(false), networkUsed: z.literal(false), objectStorageUsed: z.literal(false),
  syntheticOnly: z.literal(true), externalEffectOccurred: z.literal(false), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), startedAt: time, settledAt: time,
  outcomeDigest: digest }).strict();
const retentionProposalSchema = z.object({ contractVersion: z.literal(WAYFARER_STORAGE_CONTRACT_V1), proposalId: id, planId: id,
  planDigest: digest, policyDigest: digest, outcomeDigest: digest, retentionClassId: id, lifecycleState: z.enum(["verified", "quarantined"]),
  retentionClockEvidenceDigest: digest, eligibleAfter: time, evaluatedAt: time, legalHoldActive: z.boolean(),
  disposition: z.enum(["not_due", "blocked_by_legal_hold", "owner_review_candidate"]), ownerReviewRequired: z.literal(true),
  independentEvidenceRequired: z.literal(true), cleanupCandidate: z.boolean(), automaticallyScheduled: z.literal(false),
  deletesObject: z.literal(false), resolvesLocator: z.literal(false), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), proposalDigest: digest }).strict();
const cleanupSchema = z.object({ contractVersion: z.literal(WAYFARER_STORAGE_CONTRACT_V1), cleanupId: id, planId: id,
  planDigest: digest, outcomeDigest: digest,
  reservationDisposition: z.enum(["simulated_consumed", "released", "quarantined", "held_for_reconciliation"]),
  temporaryHandlesClosed: z.literal(true), temporaryObjectsRemaining: z.literal(false), locatorResolved: z.literal(false),
  credentialResolved: z.literal(false), objectDeleted: z.literal(false), filesystemUsed: z.literal(false), networkUsed: z.literal(false),
  objectStorageUsed: z.literal(false), cleanupIsDeletionEvidence: z.literal(false), syntheticOnly: z.literal(true),
  externalEffectOccurred: z.literal(false), grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), cleanedAt: time, cleanupDigest: digest }).strict();

export const WAYFARER_STORAGE_TRANSITIONS_V1: ReadonlyArray<Readonly<{ from: WayfarerStorageLifecycleStateV1;
  to: WayfarerStorageLifecycleStateV1 }>> = [
  { from: "declared", to: "reserved" }, { from: "reserved", to: "write_marker_recorded" }, { from: "reserved", to: "released" },
  { from: "write_marker_recorded", to: "stored_unverified" }, { from: "write_marker_recorded", to: "ambiguous" },
  { from: "stored_unverified", to: "verified" }, { from: "stored_unverified", to: "quarantined" },
  { from: "stored_unverified", to: "ambiguous" }, { from: "verified", to: "quarantined" },
  { from: "verified", to: "retention_candidate" }, { from: "quarantined", to: "verified" },
  { from: "quarantined", to: "retention_candidate" }, { from: "retention_candidate", to: "cleanup_proposed" },
] as const;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try { const parsed = schema.parse(exactProjectWorkspaceJsonV1(value)); assertNoSecretMaterial(parsed, "Wayfarer storage contract"); return parsed; }
  catch (error) { if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    if (error instanceof Error && error.message.includes("contains secret material")) throw new ProjectWorkspaceContractErrorV1("redaction_rejected");
    throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
}
function material(value: Record<string, unknown>, digestKey: string) { const copy = { ...value }; delete copy[digestKey]; return copy; }
function exactDigest(value: Record<string, unknown>, digestKey: string, actual: string) {
  if (sha256Digest(material(value, digestKey)) !== actual) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
}
function storeIdentity(input: { tenantId: string; workspaceId: string; projectId: string; packDigest: string }, store: {
  storeId: WayfarerStoreIdV1; storageClass: "local_private" | "r2_private"; logicalNamespaceId: string }) {
  return sha256Digest({ contractVersion: WAYFARER_STORAGE_CONTRACT_V1, tenantId: input.tenantId, workspaceId: input.workspaceId,
    projectId: input.projectId, packDigest: input.packDigest, storeId: store.storeId, storageClass: store.storageClass,
    logicalNamespaceId: store.logicalNamespaceId });
}
function expectedStore(input: { tenantId: string; workspaceId: string; projectId: string; packDigest: string },
  kind: "local" | "r2"): WayfarerLogicalStoreV1 {
  const local = kind === "local", identity = { storeId: local ? WAYFARER_LOCAL_STORE_ID_V1 : WAYFARER_R2_STORE_ID_V1,
    storageClass: local ? "local_private" as const : "r2_private" as const,
    logicalNamespaceId: local ? "namespace:wayfarer:local-artifacts:v1" : "namespace:wayfarer:r2-artifacts:v1" };
  return { ...identity, scopeIdentityDigest: storeIdentity(input, identity), locatorRegistryId: WAYFARER_LOCATOR_REGISTRY_ID_V1,
    locatorReferenceMode: "digest_only", locatorValuesRemainBrokerPrivate: true, immutableObjectKeys: true, overwriteAllowed: false,
    requiresContentDigest: true, requiresExactSize: true, maximumObjectBytes: 17_179_869_184, maximumReservationBytes: 34_359_738_368,
    maximumOutstandingObjects: local ? 32 : 128, credentialBindingMode: local ? "none" : "owner_configured_broker_private",
    adapterConfigured: false, adapterQualified: false, liveAccessAllowed: false, filesystemAccessAllowed: false,
    networkAccessAllowed: false, grantsExecutionAuthority: false };
}

export function buildWayfarerStoragePolicyV1(inputValue: unknown): WayfarerStoragePolicyV1 {
  const input = parse(z.object({ pack: z.unknown(), createdAt: time }).strict(), inputValue), pack = parseWayfarerProjectPackV1(input.pack),
    scope = { tenantId: pack.tenantId, workspaceId: pack.workspaceId, projectId: pack.projectId, packDigest: pack.packDigest };
  const unsigned: Omit<WayfarerStoragePolicyV1, "policyDigest"> = { contractVersion: WAYFARER_STORAGE_CONTRACT_V1,
    policyId: "storage-policy:wayfarer:1", ...scope, packId: pack.packId,
    stores: [expectedStore(scope, "local"), expectedStore(scope, "r2")], locatorCustody: {
      locatorRegistryId: WAYFARER_LOCATOR_REGISTRY_ID_V1, controlPlaneStoresLocatorValues: false, controlPlaneStoresPaths: false,
      controlPlaneStoresBucketNames: false, controlPlaneStoresAccountIdentifiers: false, controlPlaneStoresEndpoints: false,
      controlPlaneStoresSignedUrls: false, locatorResolutionRequiresSeparateAuthority: true,
      locatorResolutionAllowedByThisContract: false, locatorReferencesGrantAuthority: false }, retryPolicy: {
      maximumPreMarkerRetries: 1, automaticPostMarkerRetryAllowed: false, restartAfterMarkerDisposition: "terminal_ambiguous",
      unknownAfterMarkerDisposition: "terminal_ambiguous", integrityMismatchDisposition: "quarantine",
      ambiguityRequiresAuthoritativeReconciliation: true, ambiguityCanBeClearedByRetry: false },
    allowedTransitions: WAYFARER_STORAGE_TRANSITIONS_V1.map((transition) => ({ ...transition })), storageIsCoordinationPlane: false,
    storesRawCredentials: false, storesArtifactBytesInControlPlane: false, automaticRetentionCleanupAllowed: false, legalHoldWins: true,
    syntheticEvaluationOnly: true, enablesFilesystemAdapter: false, enablesR2Adapter: false, grantsApproval: false,
    grantsDeletionAuthority: false, grantsExecutionAuthority: false, createdAt: input.createdAt };
  return parseWayfarerStoragePolicyV1({ ...unsigned, policyDigest: sha256Digest(unsigned) });
}

export function parseWayfarerStoragePolicyV1(value: unknown): WayfarerStoragePolicyV1 {
  const policy = parse(policySchema, value) as WayfarerStoragePolicyV1,
    expected = [expectedStore(policy, "local"), expectedStore(policy, "r2")];
  if (policy.policyId !== "storage-policy:wayfarer:1" || policy.packId !== "project-pack:lofi-wayfarer:1"
    || policy.stores.map((store) => `${store.storeId}|${store.storageClass}|${store.logicalNamespaceId}`).join("|")
      !== expected.map((store) => `${store.storeId}|${store.storageClass}|${store.logicalNamespaceId}`).join("|")
    || policy.stores.some((store, index) => store.scopeIdentityDigest !== expected[index]!.scopeIdentityDigest
      || sha256Digest(store) !== sha256Digest(expected[index]!))
    || policy.allowedTransitions.map((transition) => `${transition.from}>${transition.to}`).join("|")
      !== WAYFARER_STORAGE_TRANSITIONS_V1.map((transition) => `${transition.from}>${transition.to}`).join("|")) {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  exactDigest(policy as unknown as Record<string, unknown>, "policyDigest", policy.policyDigest); return policy;
}

export function assertWayfarerStorageTransitionV1(from: WayfarerStorageLifecycleStateV1, to: WayfarerStorageLifecycleStateV1): void {
  if (!WAYFARER_STORAGE_TRANSITIONS_V1.some((transition) => transition.from === from && transition.to === to)) {
    throw new ProjectWorkspaceContractErrorV1("invalid_transition");
  }
}

function artifactIdentity(plan: Pick<WayfarerStoragePlanV1, "tenantId" | "workspaceId" | "projectId" | "packDigest" | "artifact">) {
  return sha256Digest({ contractVersion: WAYFARER_STORAGE_CONTRACT_V1, tenantId: plan.tenantId, workspaceId: plan.workspaceId,
    projectId: plan.projectId, packDigest: plan.packDigest, artifact: plan.artifact });
}
function objectKey(plan: Pick<WayfarerStoragePlanV1, "tenantId" | "projectId" | "storeId" | "artifactIdentityDigest">) {
  return sha256Digest({ keyDerivationVersion: "wayfarer-object-key/v1", tenantId: plan.tenantId, projectId: plan.projectId,
    storeId: plan.storeId, artifactIdentityDigest: plan.artifactIdentityDigest });
}
function locatorReference(plan: Pick<WayfarerStoragePlanV1, "policyDigest" | "storeId" | "objectKeyDigest">) {
  return sha256Digest({ locatorRegistryId: WAYFARER_LOCATOR_REGISTRY_ID_V1, policyDigest: plan.policyDigest,
    storeId: plan.storeId, objectKeyDigest: plan.objectKeyDigest });
}
function reservationDigest(reservation: Omit<WayfarerCapacityReservationV1, "reservationDigest">) { return sha256Digest(reservation); }

export function buildWayfarerStoragePlanV1(inputValue: unknown): WayfarerStoragePlanV1 {
  const input = parse(z.object({ policy: z.unknown(), pack: z.unknown(), storeId, artifact: artifactDeclarationSchema,
    plannedAt: time }).strict(), inputValue), policy = parseWayfarerStoragePolicyV1(input.policy), pack = parseWayfarerProjectPackV1(input.pack),
    selectedStore = policy.stores.find((store) => store.storeId === input.storeId),
    definition = pack.artifacts.find((artifact) => artifact.role === input.artifact.role);
  if (!selectedStore || policy.tenantId !== pack.tenantId || policy.workspaceId !== pack.workspaceId || policy.projectId !== pack.projectId
    || policy.packId !== pack.packId || policy.packDigest !== pack.packDigest || !definition
    || !definition.allowedContentTypes.includes(input.artifact.contentType) || input.artifact.sizeBytes > definition.maximumBytes
    || input.artifact.sizeBytes > selectedStore.maximumObjectBytes || Date.parse(input.artifact.createdAt) > Date.parse(input.plannedAt)) {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  const skeleton = { tenantId: pack.tenantId, workspaceId: pack.workspaceId, projectId: pack.projectId, packDigest: pack.packDigest,
    artifact: input.artifact }, artifactIdentityDigest = artifactIdentity(skeleton), keyInput = { tenantId: pack.tenantId,
    projectId: pack.projectId, storeId: selectedStore.storeId, artifactIdentityDigest }, objectKeyDigest = objectKey(keyInput),
    planId = `storage-plan:wayfarer:${objectKeyDigest.slice(7, 31)}`,
    reservationUnsigned: Omit<WayfarerCapacityReservationV1, "reservationDigest"> = {
      reservationId: `capacity:wayfarer:${objectKeyDigest.slice(7, 31)}`, storeId: selectedStore.storeId, reservedObjectCount: 1,
      reservedBytes: input.artifact.sizeBytes, expiresAt: new Date(Date.parse(input.plannedAt) + 900_000).toISOString(), state: "proposed",
      acquiredCapacity: false, canWrite: false, grantsExecutionAuthority: false },
    capacityReservation = { ...reservationUnsigned, reservationDigest: reservationDigest(reservationUnsigned) };
  const unsigned: Omit<WayfarerStoragePlanV1, "planDigest"> = { contractVersion: WAYFARER_STORAGE_CONTRACT_V1, planId,
    tenantId: pack.tenantId, workspaceId: pack.workspaceId, projectId: pack.projectId, packId: pack.packId,
    packDigest: pack.packDigest, policyId: policy.policyId, policyDigest: policy.policyDigest, storeId: selectedStore.storeId,
    storageClass: selectedStore.storageClass, artifact: input.artifact, artifactIdentityDigest, objectKeyDigest,
    locatorRefDigest: locatorReference({ policyDigest: policy.policyDigest, storeId: selectedStore.storeId, objectKeyDigest }),
    retentionClassId: definition.retentionClassId, capacityReservation, lifecycleState: "declared", embedsBytes: false,
    containsLocatorValue: false, resolvesLocator: false, resolvesCredential: false, writesObject: false, createsEffectIntent: false,
    syntheticEvaluationOnly: true, grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false,
    plannedAt: input.plannedAt };
  return parseWayfarerStoragePlanV1({ ...unsigned, planDigest: sha256Digest(unsigned) });
}

export function parseWayfarerStoragePlanV1(value: unknown): WayfarerStoragePlanV1 {
  const plan = parse(planSchema, value) as WayfarerStoragePlanV1,
    expectedArtifactIdentity = artifactIdentity(plan), expectedObjectKey = objectKey(plan), expectedLocator = locatorReference(plan),
    reservation = plan.capacityReservation, reservationMaterial = material(reservation as unknown as Record<string, unknown>, "reservationDigest");
  if (plan.artifactIdentityDigest !== expectedArtifactIdentity || plan.objectKeyDigest !== expectedObjectKey
    || plan.locatorRefDigest !== expectedLocator || reservation.storeId !== plan.storeId || reservation.reservedBytes !== plan.artifact.sizeBytes
    || reservation.reservationDigest !== sha256Digest(reservationMaterial) || Date.parse(reservation.expiresAt) !== Date.parse(plan.plannedAt) + 900_000
    || plan.planId !== `storage-plan:wayfarer:${plan.objectKeyDigest.slice(7, 31)}`
    || reservation.reservationId !== `capacity:wayfarer:${plan.objectKeyDigest.slice(7, 31)}`
    || (plan.storeId === WAYFARER_LOCAL_STORE_ID_V1 ? plan.storageClass !== "local_private" : plan.storageClass !== "r2_private")) {
    throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  }
  exactDigest(plan as unknown as Record<string, unknown>, "planDigest", plan.planDigest); return plan;
}

function validateObservation(expected: { artifact: Pick<WayfarerStorageArtifactDeclarationV1, "contentDigest" | "sizeBytes"> },
  observation: WayfarerStorageAttemptObservationV1): void {
  const hasObserved = observation.observedContentDigest !== undefined || observation.observedSizeBytes !== undefined;
  if (observation.observationCode === "simulated_store_verified") {
    if (!observation.markerRecorded || observation.observedContentDigest !== expected.artifact.contentDigest
      || observation.observedSizeBytes !== expected.artifact.sizeBytes) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  } else if (observation.observationCode === "integrity_mismatch_after_marker") {
    if (!observation.markerRecorded || observation.observedContentDigest === undefined || observation.observedSizeBytes === undefined
      || (observation.observedContentDigest === expected.artifact.contentDigest && observation.observedSizeBytes === expected.artifact.sizeBytes)) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
  } else if (["post_marker_outcome_unknown", "restart_after_marker"].includes(observation.observationCode)) {
    if (!observation.markerRecorded || hasObserved) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  } else if (observation.markerRecorded || hasObserved) throw new ProjectWorkspaceContractErrorV1("invalid_input");
}
function expectedOutcome(observation: WayfarerStorageAttemptObservationV1, attemptNumber: 1 | 2) {
  const code = observation.observationCode, retry = attemptNumber === 1
    && (code === "definite_pre_marker_failure" || code === "capacity_unavailable_pre_marker");
  if (code === "simulated_store_verified") return { disposition: "simulated_verified" as const, lifecycleState: "verified" as const,
    reservationDisposition: "simulated_consumed" as const, retryAllowed: false, retryReason: "not_applicable" as const, requiresReconciliation: false };
  if (code === "definite_pre_marker_failure" || code === "capacity_unavailable_pre_marker") return {
    disposition: code === "definite_pre_marker_failure" ? "definite_failure" as const : "capacity_blocked" as const,
    lifecycleState: "released" as const, reservationDisposition: "released" as const, retryAllowed: retry,
    retryReason: retry ? "definite_pre_marker_only" as const : "retry_limit_reached" as const, requiresReconciliation: false };
  if (code === "integrity_mismatch_after_marker") return { disposition: "quarantined" as const, lifecycleState: "quarantined" as const,
    reservationDisposition: "quarantined" as const, retryAllowed: false, retryReason: "post_marker_retry_forbidden" as const,
    requiresReconciliation: false };
  return { disposition: "ambiguous" as const, lifecycleState: "ambiguous" as const,
    reservationDisposition: "held_for_reconciliation" as const, retryAllowed: false, retryReason: "post_marker_retry_forbidden" as const,
    requiresReconciliation: true };
}

export function evaluateWayfarerStorageAttemptV1(inputValue: unknown): WayfarerStorageAttemptOutcomeV1 {
  const input = parse(z.object({ policy: z.unknown(), plan: z.unknown(), attemptNumber: z.union([z.literal(1), z.literal(2)]),
    previousOutcome: z.unknown().optional(), observation: observationSchema, startedAt: time, settledAt: time }).strict(), inputValue),
    policy = parseWayfarerStoragePolicyV1(input.policy), plan = parseWayfarerStoragePlanV1(input.plan),
    previous = input.previousOutcome === undefined ? undefined : parseWayfarerStorageAttemptOutcomeV1(input.previousOutcome);
  if (plan.policyId !== policy.policyId || plan.policyDigest !== policy.policyDigest || plan.tenantId !== policy.tenantId
    || plan.projectId !== policy.projectId || Date.parse(input.settledAt) < Date.parse(input.startedAt)
    || (input.attemptNumber === 1 && previous) || (input.attemptNumber === 2 && (!previous || previous.planDigest !== plan.planDigest
      || previous.artifactIdentityDigest !== plan.artifactIdentityDigest || previous.expectedContentDigest !== plan.artifact.contentDigest
      || previous.expectedSizeBytes !== plan.artifact.sizeBytes || previous.attemptNumber !== 1 || !previous.retryAllowed
      || Date.parse(previous.settledAt) > Date.parse(input.startedAt)))) {
    throw new ProjectWorkspaceContractErrorV1("replay_drift");
  }
  validateObservation(plan, input.observation); const expected = expectedOutcome(input.observation, input.attemptNumber),
    previousOutcomeDigest = previous?.outcomeDigest,
    unsigned: Omit<WayfarerStorageAttemptOutcomeV1, "outcomeDigest"> = { contractVersion: WAYFARER_STORAGE_CONTRACT_V1,
      outcomeId: `storage-outcome:wayfarer:${plan.planDigest.slice(7, 23)}:${input.attemptNumber}`, planId: plan.planId,
      planDigest: plan.planDigest, policyDigest: policy.policyDigest, artifactIdentityDigest: plan.artifactIdentityDigest,
      expectedContentDigest: plan.artifact.contentDigest, expectedSizeBytes: plan.artifact.sizeBytes, attemptNumber: input.attemptNumber,
      ...(previousOutcomeDigest ? { previousOutcomeDigest } : {}), observation: input.observation, ...expected, locatorResolved: false,
      credentialResolved: false, bytesTransferred: false, filesystemUsed: false, networkUsed: false, objectStorageUsed: false,
      syntheticOnly: true, externalEffectOccurred: false, grantsApproval: false, grantsDeletionAuthority: false,
      grantsExecutionAuthority: false, startedAt: input.startedAt, settledAt: input.settledAt };
  return parseWayfarerStorageAttemptOutcomeV1({ ...unsigned, outcomeDigest: sha256Digest(unsigned) });
}

export function parseWayfarerStorageAttemptOutcomeV1(value: unknown): WayfarerStorageAttemptOutcomeV1 {
  const outcome = parse(outcomeSchema, value) as WayfarerStorageAttemptOutcomeV1, expected = expectedOutcome(outcome.observation, outcome.attemptNumber);
  validateObservation({ artifact: { contentDigest: outcome.expectedContentDigest, sizeBytes: outcome.expectedSizeBytes } }, outcome.observation);
  if ((outcome.attemptNumber === 1 ? outcome.previousOutcomeDigest !== undefined : outcome.previousOutcomeDigest === undefined)
    || Object.entries(expected).some(([key, expectedValue]) => outcome[key as keyof WayfarerStorageAttemptOutcomeV1] !== expectedValue)
    || outcome.outcomeId !== `storage-outcome:wayfarer:${outcome.planDigest.slice(7, 23)}:${outcome.attemptNumber}`
    || (outcome.observation.observationCode === "simulated_store_verified"
      && (outcome.observation.observedContentDigest !== outcome.expectedContentDigest
        || outcome.observation.observedSizeBytes !== outcome.expectedSizeBytes))
    || (outcome.observation.observationCode === "integrity_mismatch_after_marker"
      && outcome.observation.observedContentDigest === outcome.expectedContentDigest
      && outcome.observation.observedSizeBytes === outcome.expectedSizeBytes)) {
    throw new ProjectWorkspaceContractErrorV1("replay_drift");
  }
  exactDigest(outcome as unknown as Record<string, unknown>, "outcomeDigest", outcome.outcomeDigest); return outcome;
}

function addDays(value: string, days: number) { return new Date(Date.parse(value) + days * 86_400_000).toISOString(); }
export function buildWayfarerRetentionProposalV1(inputValue: unknown): WayfarerRetentionProposalV1 {
  const input = parse(z.object({ pack: z.unknown(), policy: z.unknown(), plan: z.unknown(), outcome: z.unknown(),
    retentionClockStartedAt: time, retentionClockEvidenceDigest: digest, evaluatedAt: time, legalHoldActive: z.boolean() }).strict(), inputValue),
    pack = parseWayfarerProjectPackV1(input.pack), policy = parseWayfarerStoragePolicyV1(input.policy),
    plan = parseWayfarerStoragePlanV1(input.plan), outcome = parseWayfarerStorageAttemptOutcomeV1(input.outcome),
    retention = pack.retentionClasses.find((item) => item.retentionClassId === plan.retentionClassId);
  if (!retention || plan.packDigest !== pack.packDigest || plan.policyDigest !== policy.policyDigest || outcome.planDigest !== plan.planDigest
    || outcome.artifactIdentityDigest !== plan.artifactIdentityDigest || outcome.expectedContentDigest !== plan.artifact.contentDigest
    || outcome.expectedSizeBytes !== plan.artifact.sizeBytes
    || !(["verified", "quarantined"] as string[]).includes(outcome.lifecycleState)
    || Date.parse(input.retentionClockStartedAt) < Date.parse(plan.artifact.createdAt)) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  const eligibleAfter = addDays(input.retentionClockStartedAt, retention.retainForDays), due = Date.parse(input.evaluatedAt) >= Date.parse(eligibleAfter),
    disposition = input.legalHoldActive ? "blocked_by_legal_hold" as const : due ? "owner_review_candidate" as const : "not_due" as const,
    unsigned: Omit<WayfarerRetentionProposalV1, "proposalDigest"> = { contractVersion: WAYFARER_STORAGE_CONTRACT_V1,
      proposalId: `retention-proposal:wayfarer:${plan.planDigest.slice(7, 31)}`, planId: plan.planId,
      planDigest: plan.planDigest, policyDigest: policy.policyDigest, outcomeDigest: outcome.outcomeDigest,
      retentionClassId: retention.retentionClassId, lifecycleState: outcome.lifecycleState as "verified" | "quarantined",
      retentionClockEvidenceDigest: input.retentionClockEvidenceDigest, eligibleAfter, evaluatedAt: input.evaluatedAt,
      legalHoldActive: input.legalHoldActive, disposition, ownerReviewRequired: true, independentEvidenceRequired: true,
      cleanupCandidate: disposition === "owner_review_candidate", automaticallyScheduled: false, deletesObject: false,
      resolvesLocator: false, grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false };
  return parseWayfarerRetentionProposalV1({ ...unsigned, proposalDigest: sha256Digest(unsigned) });
}

export function parseWayfarerRetentionProposalV1(value: unknown): WayfarerRetentionProposalV1 {
  const proposal = parse(retentionProposalSchema, value) as WayfarerRetentionProposalV1,
    due = Date.parse(proposal.evaluatedAt) >= Date.parse(proposal.eligibleAfter),
    expected = proposal.legalHoldActive ? "blocked_by_legal_hold" : due ? "owner_review_candidate" : "not_due";
  if (proposal.proposalId !== `retention-proposal:wayfarer:${proposal.planDigest.slice(7, 31)}`
    || proposal.disposition !== expected || proposal.cleanupCandidate !== (expected === "owner_review_candidate")) {
    throw new ProjectWorkspaceContractErrorV1("invalid_transition");
  }
  exactDigest(proposal as unknown as Record<string, unknown>, "proposalDigest", proposal.proposalDigest); return proposal;
}

export function buildWayfarerStorageCleanupReceiptV1(inputValue: unknown): WayfarerStorageCleanupReceiptV1 {
  const input = parse(z.object({ plan: z.unknown(), outcome: z.unknown(), cleanedAt: time }).strict(), inputValue),
    plan = parseWayfarerStoragePlanV1(input.plan), outcome = parseWayfarerStorageAttemptOutcomeV1(input.outcome);
  if (outcome.planDigest !== plan.planDigest || outcome.artifactIdentityDigest !== plan.artifactIdentityDigest
    || outcome.expectedContentDigest !== plan.artifact.contentDigest || outcome.expectedSizeBytes !== plan.artifact.sizeBytes
    || Date.parse(input.cleanedAt) < Date.parse(outcome.settledAt)) {
    throw new ProjectWorkspaceContractErrorV1("replay_drift");
  }
  const unsigned: Omit<WayfarerStorageCleanupReceiptV1, "cleanupDigest"> = { contractVersion: WAYFARER_STORAGE_CONTRACT_V1,
    cleanupId: `storage-cleanup:wayfarer:${outcome.outcomeDigest.slice(7, 31)}`, planId: plan.planId, planDigest: plan.planDigest,
    outcomeDigest: outcome.outcomeDigest, reservationDisposition: outcome.reservationDisposition, temporaryHandlesClosed: true,
    temporaryObjectsRemaining: false, locatorResolved: false, credentialResolved: false, objectDeleted: false, filesystemUsed: false,
    networkUsed: false, objectStorageUsed: false, cleanupIsDeletionEvidence: false, syntheticOnly: true, externalEffectOccurred: false,
    grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false, cleanedAt: input.cleanedAt };
  return parseWayfarerStorageCleanupReceiptV1({ ...unsigned, cleanupDigest: sha256Digest(unsigned) });
}

export function parseWayfarerStorageCleanupReceiptV1(value: unknown): WayfarerStorageCleanupReceiptV1 {
  const receipt = parse(cleanupSchema, value) as WayfarerStorageCleanupReceiptV1;
  if (receipt.cleanupId !== `storage-cleanup:wayfarer:${receipt.outcomeDigest.slice(7, 31)}`) {
    throw new ProjectWorkspaceContractErrorV1("replay_drift");
  }
  exactDigest(receipt as unknown as Record<string, unknown>, "cleanupDigest", receipt.cleanupDigest); return receipt;
}

export const wayfarerStorageSchemasV1 = { logicalStore: logicalStoreSchema, locatorCustody: locatorCustodySchema,
  retryPolicy: retryPolicySchema, policy: policySchema, artifactDeclaration: artifactDeclarationSchema,
  capacityReservation: reservationSchema, plan: planSchema, observation: observationSchema, outcome: outcomeSchema,
  retentionProposal: retentionProposalSchema, cleanup: cleanupSchema } as const;
