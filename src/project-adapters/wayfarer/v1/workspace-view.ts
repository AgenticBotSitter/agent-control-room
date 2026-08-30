import { z } from "zod";
import { exactProjectWorkspaceJsonV1, parseProjectWorkspaceSnapshotV1, ProjectWorkspaceContractErrorV1,
  projectWorkspaceDigestSchemaV1 as digest, projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time, type ProjectWorkspaceSnapshotV1 } from "../../../project-workspace/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import { parseWayfarerProjectPackV1 } from "./contract";
import { buildWayfarerSchedulingScenarioCatalogV1, parseWayfarerSchedulingScenarioV1,
  type WayfarerSchedulingScenarioV1 } from "./scheduling-scenarios";
import { buildWayfarerStoragePlanV1, buildWayfarerStoragePolicyV1 } from "./storage-contract";
import { WAYFARER_LOCAL_STORE_ID_V1, WAYFARER_R2_STORE_ID_V1, type WayfarerStoreIdV1 } from "./storage-types";
import { WayfarerFakeStorageAdapterV1, buildWayfarerDefaultFakeStorageCapacitiesV1 } from "./storage-fake";
import { buildWayfarerSyntheticProjectPackV1 } from "./fixture";
import { WAYFARER_PROJECT_ID_V1, WAYFARER_STAGE_IDS_V1,
  type WayfarerArtifactRoleV1, type WayfarerProjectPackV1, type WayfarerStageIdV1 } from "./types";
import { buildCurrentWayfarerUnrealBenchmarkDisabledV1, WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1,
  type WayfarerUnrealBenchmarkGateIdV1 } from "./unreal-benchmark";
import { buildCurrentWayfarerUnrealExecutorDisabledV1, WAYFARER_UNREAL_EXECUTOR_BLOCKERS_V1,
  type WayfarerUnrealExecutorBlockerV1 } from "./unreal-executor";
import { buildCurrentWayfarerDeliveryDisabledV1, WAYFARER_DELIVERY_BLOCKERS_V1,
  type WayfarerDeliveryBlockerV1, type WayfarerDeliveryBoundaryIdV1 } from "./delivery-preparation";
import { buildCurrentWayfarerDeliveryReadinessDisabledV1, WAYFARER_DELIVERY_READINESS_GATE_IDS_V1,
  type WayfarerDeliveryReadinessGateIdV1 } from "./delivery-readiness";

export const WAYFARER_WORKSPACE_VIEW_CONTRACT_V1 = "control-room-wayfarer-workspace-view/v1" as const;
export const WAYFARER_PRESENTATION_PROJECT_ID_V1 = "project.wayfarer.lazy-river" as const;

export interface WayfarerStageViewV1 {
  stageId: WayfarerStageIdV1;
  label: string;
  position: number;
  state: "synthetic_evidence_ready";
  outputArtifactRoles: WayfarerArtifactRoleV1[];
  verificationScenarioIds: string[];
  minimumIndependentReviews: number;
  acceptedIndependentReviews: 0;
  completionState: "not_resolved";
  routeProfileId: string;
  gpu: "required" | "optional" | "forbidden";
  minimumScratchBytes: number;
  allowsNativeExecution: false;
  stageDigest: string;
}
export interface WayfarerArtifactViewV1 {
  artifactId: string;
  role: WayfarerArtifactRoleV1;
  label: string;
  kind: "media" | "document" | "manifest";
  contentType: string;
  declaredMaximumBytes: number;
  observedBytes: 0;
  state: "source_declared" | "synthetic_evidence" | "fake_storage_verified" | "quarantined";
  storeId?: WayfarerStoreIdV1;
  contentDigest: string;
  locatorAvailable: false;
  materialAvailable: false;
  qualifiesCompletion: false;
  grantsAuthority: false;
}
export interface WayfarerReviewViewV1 {
  reviewId: string;
  stageId: WayfarerStageIdV1;
  subjectLabel: string;
  risk: "medium" | "high";
  requiredIndependentReviews: number;
  acceptedIndependentReviews: 0;
  state: "waiting_independent_evidence";
  targetDigest: string;
  canApprove: false;
  canComplete: false;
  grantsAuthority: false;
}
export interface WayfarerStoreViewV1 {
  storeId: WayfarerStoreIdV1;
  label: string;
  state: "fake_metadata_only" | "quarantine_present";
  accountedObjectCount: number;
  accountedBytes: number;
  locatorAvailable: false;
  bytesAvailable: false;
  adapterConfigured: false;
  liveAccessAllowed: false;
}
export interface WayfarerUnrealBenchmarkViewV1 {
  packetId: string;
  packetDigest: string;
  packDigest: string;
  assessmentId: string;
  assessmentDigest: string;
  dispositionId: string;
  dispositionDigest: string;
  status: "disabled";
  metGateCount: 1;
  totalGateCount: 13;
  blockingGateIds: WayfarerUnrealBenchmarkGateIdV1[];
  maximumAttempts: 1;
  maximumRuntimeSeconds: 900;
  maximumCostUsd: 0;
  networkPolicy: "forbidden";
  nativeAttempted: false;
  gpuWorkObserved: false;
  sceneReadObserved: false;
  renderOutputObserved: false;
  eligibleForOwnerWindow: false;
  unrealEligible: false;
  grantsAuthority: false;
}
export interface WayfarerUnrealExecutorViewV1 {
  manifestId: string;
  manifestDigest: string;
  admissionId: string;
  admissionDigest: string;
  receiptId: string;
  receiptDigest: string;
  packetDigest: string;
  status: "disabled_before_start";
  implementationState: "frozen_disabled_contract_only";
  commandModel: "none";
  executorBlockers: WayfarerUnrealExecutorBlockerV1[];
  nativeAdapterPresent: false;
  processStarted: false;
  sceneRead: false;
  gpuWorkObserved: false;
  outputObserved: false;
  canExecute: false;
  grantsAuthority: false;
}
export interface WayfarerDeliveryBoundaryViewV1 {
  boundaryId: WayfarerDeliveryBoundaryIdV1;
  label: string;
  destinationClass: "owner_selected_private_object_store" | "owner_selected_public_video_channel";
  risk: "high";
  destinationIdempotencyRequired: true;
  preEffectMarkerRequired: true;
  automaticRetryAfterMarker: false;
  status: "not_configured";
  assessmentId: string;
  assessmentDigest: string;
  dispositionId: string;
  dispositionDigest: string;
  metGateCount: 1;
  totalGateCount: 10;
  blockingGateIds: WayfarerDeliveryReadinessGateIdV1[];
  eligibleForOwnerWindow: false;
  deliveryAttempted: false;
  grantsAuthority: false;
}
export interface WayfarerDeliveryPreparationViewV1 {
  packageId: string;
  packageDigest: string;
  outcomeId: string;
  outcomeDigest: string;
  packDigest: string;
  status: "disabled_before_effect";
  artifactDeclarationCount: 3;
  observedBytes: 0;
  boundaryCount: 2;
  readinessRecordCount: 2;
  blockingRequirements: WayfarerDeliveryBlockerV1[];
  boundaries: [WayfarerDeliveryBoundaryViewV1, WayfarerDeliveryBoundaryViewV1];
  destinationPresent: false;
  credentialsPresent: false;
  uploadAttempted: false;
  publicationAttempted: false;
  uploadEligible: false;
  publicationEligible: false;
  grantsAuthority: false;
}
export interface WayfarerWorkspaceViewV1 {
  contractVersion: typeof WAYFARER_WORKSPACE_VIEW_CONTRACT_V1;
  viewId: string;
  presentationProjectId: typeof WAYFARER_PRESENTATION_PROJECT_ID_V1;
  tenantId: string;
  projectId: string;
  packDigest: string;
  workspace: ProjectWorkspaceSnapshotV1;
  episode: { episodeId: string; title: string; mode: "no_byte_synthetic"; state: "evidence_ready_review_blocked";
    completedSyntheticStages: 6; authoritativeCompletedStages: 0 };
  stages: WayfarerStageViewV1[];
  artifacts: WayfarerArtifactViewV1[];
  reviews: WayfarerReviewViewV1[];
  stores: [WayfarerStoreViewV1, WayfarerStoreViewV1];
  schedulingScenarios: WayfarerSchedulingScenarioV1[];
  unrealBenchmark: WayfarerUnrealBenchmarkViewV1;
  unrealExecutor: WayfarerUnrealExecutorViewV1;
  deliveryPreparation: WayfarerDeliveryPreparationViewV1;
  unrealEligible: false;
  uploadEligible: false;
  publicationEligible: false;
  presentationOnly: true;
  createsJobs: false;
  createsReservations: false;
  dispatchesWork: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  generatedAt: string;
  viewDigest: string;
}

const role = z.enum(["source_scene_manifest", "source_audio_brief", "render_segment", "audio_candidate", "qc_report", "review_proxy",
  "review_manifest", "episode_master", "assembly_manifest", "publication_package"]);
const WAYFARER_ARTIFACT_ROLES_V1 = role.options;
const stageId = z.enum(WAYFARER_STAGE_IDS_V1);
const stageSchema = z.object({ stageId, label: z.string().min(1).max(120), position: z.number().int().min(0).max(5),
  state: z.literal("synthetic_evidence_ready"), outputArtifactRoles: z.array(role).min(1).max(3),
  verificationScenarioIds: z.array(id).min(1).max(9), minimumIndependentReviews: z.number().int().min(1).max(2),
  acceptedIndependentReviews: z.literal(0), completionState: z.literal("not_resolved"), routeProfileId: id,
  gpu: z.enum(["required", "optional", "forbidden"]), minimumScratchBytes: z.number().int().positive(),
  allowsNativeExecution: z.literal(false), stageDigest: digest }).strict();
const artifactSchema = z.object({ artifactId: id, role, label: z.string().min(1).max(120), kind: z.enum(["media", "document", "manifest"]),
  contentType: z.string().min(3).max(100), declaredMaximumBytes: z.number().int().positive(), observedBytes: z.literal(0),
  state: z.enum(["source_declared", "synthetic_evidence", "fake_storage_verified", "quarantined"]), storeId: z.enum([
    WAYFARER_LOCAL_STORE_ID_V1, WAYFARER_R2_STORE_ID_V1]).optional(), contentDigest: digest, locatorAvailable: z.literal(false),
  materialAvailable: z.literal(false), qualifiesCompletion: z.literal(false), grantsAuthority: z.literal(false) }).strict();
const reviewSchema = z.object({ reviewId: id, stageId, subjectLabel: z.string().min(1).max(120), risk: z.enum(["medium", "high"]),
  requiredIndependentReviews: z.number().int().min(1).max(2), acceptedIndependentReviews: z.literal(0),
  state: z.literal("waiting_independent_evidence"), targetDigest: digest, canApprove: z.literal(false), canComplete: z.literal(false),
  grantsAuthority: z.literal(false) }).strict();
const storeSchema = z.object({ storeId: z.enum([WAYFARER_LOCAL_STORE_ID_V1, WAYFARER_R2_STORE_ID_V1]),
  label: z.string().min(1).max(80), state: z.enum(["fake_metadata_only", "quarantine_present"]),
  accountedObjectCount: z.number().int().nonnegative().max(100), accountedBytes: z.number().int().nonnegative(),
  locatorAvailable: z.literal(false), bytesAvailable: z.literal(false), adapterConfigured: z.literal(false), liveAccessAllowed: z.literal(false) }).strict();
const unrealGate = z.enum(WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1);
const unrealBenchmarkSchema = z.object({ packetId: id, packetDigest: digest, packDigest: digest, assessmentId: id, assessmentDigest: digest,
  dispositionId: id, dispositionDigest: digest, status: z.literal("disabled"), metGateCount: z.literal(1), totalGateCount: z.literal(13),
  blockingGateIds: z.array(unrealGate).length(12), maximumAttempts: z.literal(1), maximumRuntimeSeconds: z.literal(900),
  maximumCostUsd: z.literal(0), networkPolicy: z.literal("forbidden"), nativeAttempted: z.literal(false),
  gpuWorkObserved: z.literal(false), sceneReadObserved: z.literal(false), renderOutputObserved: z.literal(false),
  eligibleForOwnerWindow: z.literal(false), unrealEligible: z.literal(false), grantsAuthority: z.literal(false) }).strict();
const unrealExecutorBlocker = z.enum(WAYFARER_UNREAL_EXECUTOR_BLOCKERS_V1);
const unrealExecutorSchema = z.object({ manifestId: id, manifestDigest: digest, admissionId: id, admissionDigest: digest,
  receiptId: id, receiptDigest: digest, packetDigest: digest, status: z.literal("disabled_before_start"),
  implementationState: z.literal("frozen_disabled_contract_only"), commandModel: z.literal("none"),
  executorBlockers: z.array(unrealExecutorBlocker).length(6), nativeAdapterPresent: z.literal(false), processStarted: z.literal(false),
  sceneRead: z.literal(false), gpuWorkObserved: z.literal(false), outputObserved: z.literal(false), canExecute: z.literal(false),
  grantsAuthority: z.literal(false) }).strict();
const deliveryBlocker = z.enum(WAYFARER_DELIVERY_BLOCKERS_V1);
const deliveryReadinessGate = z.enum(WAYFARER_DELIVERY_READINESS_GATE_IDS_V1);
const deliveryBoundarySchema = z.object({ boundaryId: z.enum(["private_upload", "public_publication"]),
  label: z.string().min(1).max(100), destinationClass: z.enum(["owner_selected_private_object_store",
    "owner_selected_public_video_channel"]), risk: z.literal("high"), destinationIdempotencyRequired: z.literal(true),
  preEffectMarkerRequired: z.literal(true), automaticRetryAfterMarker: z.literal(false), status: z.literal("not_configured"),
  assessmentId: id, assessmentDigest: digest, dispositionId: id, dispositionDigest: digest,
  metGateCount: z.literal(1), totalGateCount: z.literal(10), blockingGateIds: z.array(deliveryReadinessGate).length(9),
  eligibleForOwnerWindow: z.literal(false), deliveryAttempted: z.literal(false),
  grantsAuthority: z.literal(false) }).strict();
const deliveryPreparationSchema = z.object({ packageId: id, packageDigest: digest, outcomeId: id, outcomeDigest: digest,
  packDigest: digest, status: z.literal("disabled_before_effect"), artifactDeclarationCount: z.literal(3), observedBytes: z.literal(0),
  boundaryCount: z.literal(2), readinessRecordCount: z.literal(2), blockingRequirements: z.array(deliveryBlocker).length(12),
  boundaries: z.tuple([deliveryBoundarySchema, deliveryBoundarySchema]), destinationPresent: z.literal(false),
  credentialsPresent: z.literal(false), uploadAttempted: z.literal(false), publicationAttempted: z.literal(false),
  uploadEligible: z.literal(false), publicationEligible: z.literal(false), grantsAuthority: z.literal(false) }).strict();
const viewSchema = z.object({ contractVersion: z.literal(WAYFARER_WORKSPACE_VIEW_CONTRACT_V1), viewId: id,
  presentationProjectId: z.literal(WAYFARER_PRESENTATION_PROJECT_ID_V1), tenantId: id,
  projectId: z.literal(WAYFARER_PROJECT_ID_V1), packDigest: digest,
  workspace: z.unknown(), episode: z.object({ episodeId: id, title: z.string().min(1).max(160), mode: z.literal("no_byte_synthetic"),
    state: z.literal("evidence_ready_review_blocked"), completedSyntheticStages: z.literal(6), authoritativeCompletedStages: z.literal(0) }).strict(),
  stages: z.array(stageSchema).length(6), artifacts: z.array(artifactSchema).length(10), reviews: z.array(reviewSchema).length(6),
  stores: z.tuple([storeSchema, storeSchema]), schedulingScenarios: z.array(z.unknown()).length(6),
  unrealBenchmark: unrealBenchmarkSchema, unrealExecutor: unrealExecutorSchema, deliveryPreparation: deliveryPreparationSchema,
  unrealEligible: z.literal(false),
  uploadEligible: z.literal(false), publicationEligible: z.literal(false), presentationOnly: z.literal(true), createsJobs: z.literal(false),
  createsReservations: z.literal(false), dispatchesWork: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), generatedAt: time, viewDigest: digest }).strict();

function exact<T>(schema: z.ZodType<T>, value: unknown): T {
  try { const parsed = schema.parse(exactProjectWorkspaceJsonV1(value)); assertNoSecretMaterial(parsed, "Wayfarer workspace view"); return parsed; }
  catch (error) { if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    if (error instanceof Error && error.message.includes("contains secret material")) throw new ProjectWorkspaceContractErrorV1("redaction_rejected");
    throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
}
function withoutDigest(value: Record<string, unknown>) { const copy = { ...value }; delete copy.viewDigest; return copy; }
function label(value: string) { return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase()); }

export function parseWayfarerWorkspaceViewV1(value: unknown): WayfarerWorkspaceViewV1 {
  const parsed = exact(viewSchema, value) as WayfarerWorkspaceViewV1, workspace = parseProjectWorkspaceSnapshotV1(parsed.workspace),
    scenarios = parsed.schedulingScenarios.map(parseWayfarerSchedulingScenarioV1);
  if (workspace.tenantId !== parsed.tenantId || workspace.projectId !== parsed.projectId || parsed.packDigest !== scenarios[0]?.packDigest
    || parsed.stages.map((stage) => stage.stageId).join("|") !== WAYFARER_STAGE_IDS_V1.join("|")
    || parsed.stages.some((stage, position) => {
      const { stageDigest, ...material } = stage;
      return stage.position !== position || new Set(stage.verificationScenarioIds).size !== stage.verificationScenarioIds.length
        || sha256Digest(material) !== stageDigest;
    })
    || parsed.artifacts.map((artifact) => artifact.role).join("|") !== WAYFARER_ARTIFACT_ROLES_V1.join("|")
    || new Set(parsed.artifacts.map((artifact) => artifact.artifactId)).size !== parsed.artifacts.length
    || parsed.artifacts.some((artifact) => (artifact.state === "fake_storage_verified" && artifact.storeId !== WAYFARER_LOCAL_STORE_ID_V1)
      || (artifact.state === "quarantined" && artifact.storeId !== WAYFARER_R2_STORE_ID_V1)
      || ((artifact.state === "source_declared" || artifact.state === "synthetic_evidence") && artifact.storeId !== undefined))
    || new Set(parsed.reviews.map((review) => review.reviewId)).size !== parsed.reviews.length
    || parsed.reviews.some((review, position) => review.stageId !== parsed.stages[position]?.stageId
      || review.targetDigest !== parsed.stages[position]?.stageDigest
      || review.requiredIndependentReviews !== parsed.stages[position]?.minimumIndependentReviews)
    || parsed.stores.map((store) => store.storeId).join("|") !== `${WAYFARER_LOCAL_STORE_ID_V1}|${WAYFARER_R2_STORE_ID_V1}`
    || parsed.stores[0].state !== "fake_metadata_only" || parsed.stores[1].state !== "quarantine_present"
    || parsed.unrealBenchmark.packDigest !== parsed.packDigest
    || parsed.unrealBenchmark.blockingGateIds.join("|") !== WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1.slice(1).join("|")
    || parsed.unrealExecutor.packetDigest !== parsed.unrealBenchmark.packetDigest
    || parsed.unrealExecutor.executorBlockers.join("|") !== WAYFARER_UNREAL_EXECUTOR_BLOCKERS_V1.join("|")
    || parsed.deliveryPreparation.packDigest !== parsed.packDigest
    || parsed.deliveryPreparation.blockingRequirements.join("|") !== WAYFARER_DELIVERY_BLOCKERS_V1.join("|")
    || parsed.deliveryPreparation.boundaries.map((boundary) => boundary.boundaryId).join("|") !== "private_upload|public_publication"
    || parsed.deliveryPreparation.boundaries[0].destinationClass !== "owner_selected_private_object_store"
    || parsed.deliveryPreparation.boundaries[1].destinationClass !== "owner_selected_public_video_channel"
    || parsed.deliveryPreparation.boundaries.some((boundary) => boundary.blockingGateIds.join("|")
      !== WAYFARER_DELIVERY_READINESS_GATE_IDS_V1.slice(1).join("|"))
    || new Set(parsed.deliveryPreparation.boundaries.map((boundary) => boundary.assessmentDigest)).size !== 2
    || new Set(parsed.deliveryPreparation.boundaries.map((boundary) => boundary.dispositionDigest)).size !== 2
    || new Set(scenarios.map((scenario) => scenario.scenarioId)).size !== scenarios.length
    || scenarios.some((scenario) => scenario.tenantId !== parsed.tenantId || scenario.projectId !== parsed.projectId
      || scenario.packDigest !== parsed.packDigest)
    || sha256Digest(withoutDigest(parsed as unknown as Record<string, unknown>)) !== parsed.viewDigest) {
    throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  }
  return { ...parsed, workspace, schedulingScenarios: scenarios };
}

function storageView(pack: WayfarerProjectPackV1) {
  const policy = buildWayfarerStoragePolicyV1({ pack, createdAt: "2026-08-29T22:20:00.000Z" }),
    adapter = new WayfarerFakeStorageAdapterV1(policy, buildWayfarerDefaultFakeStorageCapacitiesV1()), createdAt = "2026-08-29T22:21:00.000Z",
    render = buildWayfarerStoragePlanV1({ policy, pack, storeId: WAYFARER_LOCAL_STORE_ID_V1, plannedAt: "2026-08-29T22:22:00.000Z",
      artifact: { artifactId: "artifact:wayfarer:view:render", episodeId: "episode:wayfarer:lazy-river:synthetic", role: "render_segment",
        contentType: "video/mp4", contentDigest: sha256Digest({ view: "render" }), sizeBytes: 1_048_576, createdAt } }),
    audio = buildWayfarerStoragePlanV1({ policy, pack, storeId: WAYFARER_R2_STORE_ID_V1, plannedAt: "2026-08-29T22:22:00.000Z",
      artifact: { artifactId: "artifact:wayfarer:view:audio", episodeId: "episode:wayfarer:lazy-river:synthetic", role: "audio_candidate",
        contentType: "audio/flac", contentDigest: sha256Digest({ view: "audio" }), sizeBytes: 524_288, createdAt } });
  adapter.apply({ plan: render, attemptNumber: 1, observation: { observationCode: "simulated_store_verified", markerRecorded: true,
    observedContentDigest: render.artifact.contentDigest, observedSizeBytes: render.artifact.sizeBytes,
    safeEvidenceDigest: sha256Digest({ view: "render-match" }) }, startedAt: "2026-08-29T22:23:00.000Z", settledAt: "2026-08-29T22:24:00.000Z" });
  adapter.apply({ plan: audio, attemptNumber: 1, observation: { observationCode: "integrity_mismatch_after_marker", markerRecorded: true,
    observedContentDigest: sha256Digest({ view: "audio-mismatch" }), observedSizeBytes: audio.artifact.sizeBytes,
    safeEvidenceDigest: sha256Digest({ view: "audio-quarantine" }) }, startedAt: "2026-08-29T22:23:00.000Z",
    settledAt: "2026-08-29T22:24:00.000Z" });
  return { adapter, render, audio };
}

export function buildWayfarerWorkspaceViewV1(packValue: unknown = buildWayfarerSyntheticProjectPackV1()): WayfarerWorkspaceViewV1 {
  const pack = parseWayfarerProjectPackV1(packValue), generatedAt = "2026-08-29T23:00:00.000Z", storage = storageView(pack),
    stages: WayfarerStageViewV1[] = pack.stages.map((stage, position) => {
      const profile = pack.acceptanceProfiles[position]!.profile, material = { stageId: stage.stageId, label: stage.label, position,
        state: "synthetic_evidence_ready" as const, outputArtifactRoles: stage.outputArtifactRoles,
        verificationScenarioIds: profile.requiredVerificationScenarioIds, minimumIndependentReviews: profile.minimumIndependentReviews,
        acceptedIndependentReviews: 0 as const, completionState: "not_resolved" as const, routeProfileId: stage.route.routeProfileId,
        gpu: stage.route.gpu, minimumScratchBytes: stage.route.minimumScratchBytes, allowsNativeExecution: false as const };
      return { ...material, stageDigest: sha256Digest(material) };
    }),
    artifacts: WayfarerArtifactViewV1[] = pack.artifacts.map((definition) => {
      const storageState = definition.role === "render_segment" ? { state: "fake_storage_verified" as const, storeId: WAYFARER_LOCAL_STORE_ID_V1 }
        : definition.role === "audio_candidate" ? { state: "quarantined" as const, storeId: WAYFARER_R2_STORE_ID_V1 }
        : { state: definition.origin === "source_input" ? "source_declared" as const : "synthetic_evidence" as const };
      return { artifactId: `artifact-view:wayfarer:${definition.role}`, role: definition.role, label: label(definition.role), kind: definition.kind,
        contentType: definition.allowedContentTypes[0]!, declaredMaximumBytes: definition.maximumBytes, observedBytes: 0, ...storageState,
        contentDigest: definition.role === "render_segment" ? storage.render.artifact.contentDigest
          : definition.role === "audio_candidate" ? storage.audio.artifact.contentDigest : sha256Digest({ packDigest: pack.packDigest, role: definition.role }),
        locatorAvailable: false, materialAvailable: false, qualifiesCompletion: false, grantsAuthority: false };
    }),
    reviews: WayfarerReviewViewV1[] = pack.stages.map((stage, position) => {
      const profile = pack.acceptanceProfiles[position]!.profile;
      if (profile.minimumRisk !== "medium" && profile.minimumRisk !== "high") throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
      return { reviewId: `review-view:wayfarer:${stage.stageId}`, stageId: stage.stageId,
        subjectLabel: `${stage.label} independent evidence`, risk: profile.minimumRisk,
        requiredIndependentReviews: profile.minimumIndependentReviews, acceptedIndependentReviews: 0,
        state: "waiting_independent_evidence", targetDigest: stages[position]!.stageDigest, canApprove: false, canComplete: false,
        grantsAuthority: false };
    }),
    local = storage.adapter.inventory(WAYFARER_LOCAL_STORE_ID_V1), r2 = storage.adapter.inventory(WAYFARER_R2_STORE_ID_V1),
    unreal = buildCurrentWayfarerUnrealBenchmarkDisabledV1(pack), executor = buildCurrentWayfarerUnrealExecutorDisabledV1(pack),
    delivery = buildCurrentWayfarerDeliveryDisabledV1(pack),
    deliveryReadiness = buildCurrentWayfarerDeliveryReadinessDisabledV1(pack),
    stores: [WayfarerStoreViewV1, WayfarerStoreViewV1] = [
      { storeId: WAYFARER_LOCAL_STORE_ID_V1, label: "Local private · fake metadata", state: "fake_metadata_only",
        accountedObjectCount: local.accountedObjectCount, accountedBytes: local.accountedBytes, locatorAvailable: false,
        bytesAvailable: false, adapterConfigured: false, liveAccessAllowed: false },
      { storeId: WAYFARER_R2_STORE_ID_V1, label: "R2 private · fake metadata", state: "quarantine_present",
        accountedObjectCount: r2.accountedObjectCount, accountedBytes: r2.accountedBytes, locatorAvailable: false,
        bytesAvailable: false, adapterConfigured: false, liveAccessAllowed: false },
    ],
    unsigned: Omit<WayfarerWorkspaceViewV1, "viewDigest"> = { contractVersion: WAYFARER_WORKSPACE_VIEW_CONTRACT_V1,
      viewId: "workspace-view:wayfarer:lazy-river:1", presentationProjectId: WAYFARER_PRESENTATION_PROJECT_ID_V1,
      tenantId: pack.tenantId, projectId: pack.projectId, packDigest: pack.packDigest, workspace: pack.workspace,
      episode: { episodeId: "episode:wayfarer:lazy-river:synthetic", title: "Lazy River synthetic production pass",
        mode: "no_byte_synthetic", state: "evidence_ready_review_blocked", completedSyntheticStages: 6,
        authoritativeCompletedStages: 0 }, stages, artifacts, reviews, stores,
      schedulingScenarios: buildWayfarerSchedulingScenarioCatalogV1(pack), unrealBenchmark: { packetId: unreal.packet.packetId,
        packetDigest: unreal.packet.packetDigest, packDigest: unreal.packet.packDigest, assessmentId: unreal.assessment.assessmentId,
        assessmentDigest: unreal.assessment.assessmentDigest, dispositionId: unreal.disposition.dispositionId,
        dispositionDigest: unreal.disposition.dispositionDigest, status: "disabled", metGateCount: 1, totalGateCount: 13,
        blockingGateIds: unreal.disposition.blockingGateIds, maximumAttempts: unreal.packet.limits.maximumAttempts,
        maximumRuntimeSeconds: unreal.packet.limits.maximumRuntimeSeconds, maximumCostUsd: unreal.packet.limits.maximumCostUsd,
        networkPolicy: unreal.packet.limits.networkPolicy, nativeAttempted: false, gpuWorkObserved: false,
        sceneReadObserved: false, renderOutputObserved: false, eligibleForOwnerWindow: false, unrealEligible: false,
        grantsAuthority: false },
      unrealExecutor: { manifestId: executor.manifest.manifestId, manifestDigest: executor.manifest.manifestDigest,
        admissionId: executor.admission.admissionId, admissionDigest: executor.admission.admissionDigest,
        receiptId: executor.receipt.receiptId, receiptDigest: executor.receipt.receiptDigest,
        packetDigest: executor.manifest.packetDigest, status: "disabled_before_start",
        implementationState: executor.manifest.implementationState, commandModel: executor.manifest.commandModel,
        executorBlockers: executor.admission.executorBlockers, nativeAdapterPresent: false, processStarted: false,
        sceneRead: false, gpuWorkObserved: false, outputObserved: false, canExecute: false, grantsAuthority: false },
      deliveryPreparation: { packageId: delivery.package.packageId, packageDigest: delivery.package.packageDigest,
        outcomeId: delivery.outcome.outcomeId, outcomeDigest: delivery.outcome.outcomeDigest, packDigest: delivery.package.packDigest,
        status: "disabled_before_effect", artifactDeclarationCount: 3, observedBytes: 0, boundaryCount: 2,
        readinessRecordCount: 2,
        blockingRequirements: delivery.package.blockingRequirements,
        boundaries: delivery.package.boundaries.map((boundary, position) => {
          const record = deliveryReadiness.records[position]!;
          if (record.assessment.boundaryId !== boundary.boundaryId
            || record.assessment.candidatePackageDigest !== delivery.package.packageDigest) {
            throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
          }
          return { boundaryId: boundary.boundaryId,
          label: boundary.boundaryId === "private_upload" ? "Private distribution upload" : "Public episode publication",
          destinationClass: boundary.destinationClass, risk: boundary.risk,
          destinationIdempotencyRequired: boundary.destinationIdempotencyRequired,
          preEffectMarkerRequired: boundary.preEffectMarkerRequired,
          automaticRetryAfterMarker: boundary.automaticRetryAfterMarker, status: "not_configured" as const,
          assessmentId: record.assessment.assessmentId, assessmentDigest: record.assessment.assessmentDigest,
          dispositionId: record.disposition.dispositionId, dispositionDigest: record.disposition.dispositionDigest,
          metGateCount: 1 as const, totalGateCount: 10 as const, blockingGateIds: record.assessment.blockingGateIds,
          eligibleForOwnerWindow: false as const, deliveryAttempted: false as const,
          grantsAuthority: false as const };
        }) as [WayfarerDeliveryBoundaryViewV1, WayfarerDeliveryBoundaryViewV1],
        destinationPresent: false, credentialsPresent: false, uploadAttempted: false, publicationAttempted: false,
        uploadEligible: false, publicationEligible: false, grantsAuthority: false },
      unrealEligible: false, uploadEligible: false,
      publicationEligible: false, presentationOnly: true, createsJobs: false, createsReservations: false, dispatchesWork: false,
      grantsApproval: false, grantsExecutionAuthority: false, generatedAt };
  return parseWayfarerWorkspaceViewV1({ ...unsigned, viewDigest: sha256Digest(unsigned) });
}

export const wayfarerWorkspaceViewSchemasV1 = { stage: stageSchema, artifact: artifactSchema, review: reviewSchema,
  store: storeSchema, unrealBenchmark: unrealBenchmarkSchema, unrealExecutor: unrealExecutorSchema,
  deliveryPreparation: deliveryPreparationSchema, view: viewSchema } as const;
