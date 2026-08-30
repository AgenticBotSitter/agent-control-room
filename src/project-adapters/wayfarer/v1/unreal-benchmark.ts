import { z } from "zod";
import { exactProjectWorkspaceJsonV1, ProjectWorkspaceContractErrorV1,
  projectWorkspaceDigestSchemaV1 as digest, projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import { parseWayfarerProjectPackV1 } from "./contract";
import { buildWayfarerSyntheticProjectPackV1 } from "./fixture";

export const WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1 = "control-room-wayfarer-unreal-benchmark/v1" as const;
export const WAYFARER_UNREAL_BENCHMARK_ID_V1 = "benchmark:wayfarer:unreal-scene-render:v1" as const;
export const WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1 = [
  "exact_benchmark_packet",
  "immutable_scene_identity",
  "pinned_unreal_tool_identity",
  "qualified_native_executor",
  "node_approval_attestation",
  "hardware_environment_fingerprint",
  "gpu_capability_evidence",
  "scratch_capacity_and_encryption",
  "offline_network_enforcement",
  "measured_clock_and_metrics",
  "evidence_capture_and_integrity",
  "cleanup_and_ambiguity_procedure",
  "owner_attended_single_use_window",
] as const;
export type WayfarerUnrealBenchmarkGateIdV1 = (typeof WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1)[number];

export const WAYFARER_UNREAL_REQUIRED_METRICS_V1 = ["wall_clock_ms", "frames_per_second", "peak_memory_bytes",
  "peak_scratch_bytes", "output_size_bytes"] as const;
export const WAYFARER_UNREAL_REQUIRED_EVIDENCE_V1 = ["trusted_start_and_end_time", "scene_identity", "tool_identity",
  "node_identity", "environment_fingerprint", "gpu_capability", "scratch_observation", "network_denial_observation",
  "measured_metrics", "output_content_identity", "native_execution_receipt", "cleanup_receipt"] as const;

const evidenceClassByGate: Record<WayfarerUnrealBenchmarkGateIdV1, string> = {
  exact_benchmark_packet: "benchmark_packet",
  immutable_scene_identity: "private_scene_identity",
  pinned_unreal_tool_identity: "native_tool_identity",
  qualified_native_executor: "native_executor_qualification",
  node_approval_attestation: "node_approval_attestation",
  hardware_environment_fingerprint: "environment_fingerprint",
  gpu_capability_evidence: "gpu_capability",
  scratch_capacity_and_encryption: "scratch_capacity",
  offline_network_enforcement: "network_enforcement",
  measured_clock_and_metrics: "measurement_clock",
  evidence_capture_and_integrity: "evidence_collector",
  cleanup_and_ambiguity_procedure: "cleanup_runbook",
  owner_attended_single_use_window: "owner_window",
};

export interface WayfarerUnrealBenchmarkPacketV1 {
  contractVersion: typeof WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1;
  packetId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  packId: string;
  packDigest: string;
  benchmarkId: typeof WAYFARER_UNREAL_BENCHMARK_ID_V1;
  benchmarkVersion: "1.0.0";
  stageId: "model_render_segment";
  scenePolicy: "owner_supplied_private_digest_and_size_only";
  workload: { widthPixels: 1920; heightPixels: 1080; frameCount: 300; warmupRuns: 1; measuredRuns: 3;
    aggregation: "median_wall_clock"; deterministicSettingsRequired: true };
  limits: { allowedPlatforms: ["macos", "windows", "linux"]; gpuRequired: true; minimumMemoryBytes: number;
    minimumScratchBytes: number; maximumRuntimeSeconds: 900; maximumCostUsd: 0; maximumAttempts: 1;
    networkPolicy: "forbidden"; providerCallsAllowed: false; automaticRetryAllowed: false };
  requiredMetrics: typeof WAYFARER_UNREAL_REQUIRED_METRICS_V1;
  requiredEvidence: typeof WAYFARER_UNREAL_REQUIRED_EVIDENCE_V1;
  ownerAttended: true;
  freshStrongApprovalRequired: true;
  preEffectMarkerRequired: true;
  restartAfterMarker: "terminal_ambiguity";
  resultRetention: "digest_only_control_plane";
  storesPaths: false;
  storesSceneOrRenderBytes: false;
  allowsNativeExecution: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  packetDigest: string;
}

export interface WayfarerUnrealBenchmarkPrerequisiteV1 {
  contractVersion: typeof WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1;
  gateId: WayfarerUnrealBenchmarkGateIdV1;
  evidenceClass: string;
  state: "met" | "missing" | "expired";
  evidenceDigest?: string;
  checkedAt: string;
  validUntil?: string;
  safeReasonCode: string;
  requiresAuthoritativeEvidence: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  prerequisiteDigest: string;
}

export interface WayfarerUnrealBenchmarkReadinessV1 {
  contractVersion: typeof WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1;
  assessmentId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  operation: "wayfarer.measure_unreal_scene_render";
  candidatePacketId?: string;
  candidatePacketDigest?: string;
  prerequisites: WayfarerUnrealBenchmarkPrerequisiteV1[];
  blockingGateIds: WayfarerUnrealBenchmarkGateIdV1[];
  readiness: "blocked" | "candidate_for_owner_window";
  eligibleForOwnerWindow: boolean;
  assessedAt: string;
  requiresFreshStrongApproval: true;
  requiresOwnerPresence: true;
  nativeCoordinatorImplemented: false;
  benchmarkAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  assessmentDigest: string;
}

export interface WayfarerUnrealBenchmarkDisabledDispositionV1 {
  contractVersion: typeof WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1;
  dispositionId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  assessmentId: string;
  assessmentDigest: string;
  status: "disabled";
  blockingGateIds: WayfarerUnrealBenchmarkGateIdV1[];
  safeReasonCode: "required_evidence_missing";
  recordedAt: string;
  requiresNewAssessment: true;
  automaticRetryAllowed: false;
  nativeAttempted: false;
  gpuWorkObserved: false;
  sceneReadObserved: false;
  renderOutputObserved: false;
  externalEffectOccurred: false;
  benchmarkAuthorized: false;
  unrealEligible: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  requiresIndependentCheckpoint: true;
  dispositionDigest: string;
}

export interface WayfarerUnrealBenchmarkEvidenceV1 {
  contractVersion: typeof WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1;
  evidenceId: string;
  packetId: string;
  packetDigest: string;
  attemptId: string;
  nodeIdentityDigest: string;
  toolIdentityDigest: string;
  sceneIdentityDigest: string;
  environmentFingerprint: string;
  outcome: "measured_pass" | "measured_fail" | "blocked_before_start" | "ambiguous_after_start";
  startedAt?: string;
  settledAt: string;
  measurements?: { wallClockMs: number; framesPerSecond: number; peakMemoryBytes: number; peakScratchBytes: number;
    outputSizeBytes: number };
  outputContentDigest?: string;
  ownerWindowDigest?: string;
  nodeApprovalAttestationDigest?: string;
  networkEnforcementEvidenceDigest?: string;
  nativeExecutionReceiptDigest?: string;
  measurementEvidenceDigest?: string;
  cleanupReceiptDigest?: string;
  executionAttempted: boolean;
  preEffectMarkerRecorded: boolean;
  cleanupConfirmed: boolean;
  candidateForRouteQualification: boolean;
  automaticallyActivatesRoute: false;
  resolvesMediaCompletion: false;
  unrealEligible: false;
  requiresIndependentReview: true;
  requiresReconciliation: boolean;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  evidenceDigest: string;
}

const tuple = <T extends readonly [string, ...string[]]>(values: T) => z.tuple(values.map((value) => z.literal(value)) as unknown as {
  [K in keyof T]: z.ZodLiteral<T[K]> });
const workloadSchema = z.object({ widthPixels: z.literal(1920), heightPixels: z.literal(1080), frameCount: z.literal(300),
  warmupRuns: z.literal(1), measuredRuns: z.literal(3), aggregation: z.literal("median_wall_clock"),
  deterministicSettingsRequired: z.literal(true) }).strict();
const limitsSchema = z.object({ allowedPlatforms: tuple(["macos", "windows", "linux"]), gpuRequired: z.literal(true),
  minimumMemoryBytes: z.literal(17_179_869_184), minimumScratchBytes: z.literal(68_719_476_736),
  maximumRuntimeSeconds: z.literal(900), maximumCostUsd: z.literal(0), maximumAttempts: z.literal(1),
  networkPolicy: z.literal("forbidden"), providerCallsAllowed: z.literal(false), automaticRetryAllowed: z.literal(false) }).strict();
const packetSchema = z.object({ contractVersion: z.literal(WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1), packetId: id,
  tenantId: id, workspaceId: id, projectId: id, packId: id, packDigest: digest,
  benchmarkId: z.literal(WAYFARER_UNREAL_BENCHMARK_ID_V1), benchmarkVersion: z.literal("1.0.0"),
  stageId: z.literal("model_render_segment"), scenePolicy: z.literal("owner_supplied_private_digest_and_size_only"),
  workload: workloadSchema, limits: limitsSchema, requiredMetrics: tuple(WAYFARER_UNREAL_REQUIRED_METRICS_V1),
  requiredEvidence: tuple(WAYFARER_UNREAL_REQUIRED_EVIDENCE_V1), ownerAttended: z.literal(true),
  freshStrongApprovalRequired: z.literal(true), preEffectMarkerRequired: z.literal(true),
  restartAfterMarker: z.literal("terminal_ambiguity"), resultRetention: z.literal("digest_only_control_plane"),
  storesPaths: z.literal(false), storesSceneOrRenderBytes: z.literal(false), allowsNativeExecution: z.literal(false),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), packetDigest: digest }).strict();
const gate = z.enum(WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1);
const prerequisiteSchema = z.object({ contractVersion: z.literal(WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1), gateId: gate,
  evidenceClass: id, state: z.enum(["met", "missing", "expired"]), evidenceDigest: digest.optional(), checkedAt: time,
  validUntil: time.optional(), safeReasonCode: id, requiresAuthoritativeEvidence: z.literal(true), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), prerequisiteDigest: digest }).strict().superRefine((value, context) => {
    if (value.evidenceClass !== evidenceClassByGate[value.gateId]) context.addIssue({ code: "custom", message: "evidence class mismatch" });
    if (value.state === "missing" && (value.evidenceDigest || value.validUntil)) context.addIssue({ code: "custom", message: "missing evidence mismatch" });
    if (value.state !== "missing" && !value.evidenceDigest) context.addIssue({ code: "custom", message: "evidence digest required" });
    if (value.state === "expired" && (!value.validUntil || Date.parse(value.validUntil) > Date.parse(value.checkedAt))) {
      context.addIssue({ code: "custom", message: "expired chronology mismatch" });
    }
    if (value.state === "met" && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.checkedAt)) {
      context.addIssue({ code: "custom", message: "met evidence expired" });
    }
  });
const readinessSchema = z.object({ contractVersion: z.literal(WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1), assessmentId: id,
  tenantId: id, workspaceId: id, projectId: id, operation: z.literal("wayfarer.measure_unreal_scene_render"),
  candidatePacketId: id.optional(), candidatePacketDigest: digest.optional(),
  prerequisites: z.array(prerequisiteSchema).length(WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1.length),
  blockingGateIds: z.array(gate).max(WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1.length),
  readiness: z.enum(["blocked", "candidate_for_owner_window"]), eligibleForOwnerWindow: z.boolean(), assessedAt: time,
  requiresFreshStrongApproval: z.literal(true), requiresOwnerPresence: z.literal(true), nativeCoordinatorImplemented: z.literal(false),
  benchmarkAuthorized: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  assessmentDigest: digest }).strict().superRefine((value, context) => {
    if (Boolean(value.candidatePacketId) !== Boolean(value.candidatePacketDigest)) context.addIssue({ code: "custom", message: "packet identity incomplete" });
    if (value.prerequisites.map((item) => item.gateId).join("|") !== WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1.join("|")) {
      context.addIssue({ code: "custom", message: "gate order mismatch" });
    }
    const blockers = value.prerequisites.filter((item) => item.state !== "met").map((item) => item.gateId);
    if (blockers.join("|") !== value.blockingGateIds.join("|")) context.addIssue({ code: "custom", message: "blocker mismatch" });
    const packetGate = value.prerequisites[0];
    if (value.candidatePacketDigest && packetGate?.state === "met" && packetGate.evidenceDigest !== value.candidatePacketDigest) {
      context.addIssue({ code: "custom", message: "packet evidence mismatch" });
    }
    if (value.prerequisites.some((item) => Date.parse(item.checkedAt) > Date.parse(value.assessedAt)
      || (item.state === "met" && item.validUntil && Date.parse(item.validUntil) <= Date.parse(value.assessedAt)))) {
      context.addIssue({ code: "custom", message: "assessment chronology mismatch" });
    }
    const candidate = Boolean(value.candidatePacketId && value.candidatePacketDigest && blockers.length === 0);
    if ((value.readiness === "candidate_for_owner_window") !== candidate || value.eligibleForOwnerWindow !== candidate) {
      context.addIssue({ code: "custom", message: "readiness mismatch" });
    }
  });
const dispositionSchema = z.object({ contractVersion: z.literal(WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1), dispositionId: id,
  tenantId: id, workspaceId: id, projectId: id, assessmentId: id, assessmentDigest: digest, status: z.literal("disabled"),
  blockingGateIds: z.array(gate).min(1).max(WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1.length),
  safeReasonCode: z.literal("required_evidence_missing"), recordedAt: time, requiresNewAssessment: z.literal(true),
  automaticRetryAllowed: z.literal(false), nativeAttempted: z.literal(false), gpuWorkObserved: z.literal(false),
  sceneReadObserved: z.literal(false), renderOutputObserved: z.literal(false), externalEffectOccurred: z.literal(false),
  benchmarkAuthorized: z.literal(false), unrealEligible: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), requiresIndependentCheckpoint: z.literal(true), dispositionDigest: digest }).strict();
const measurementSchema = z.object({ wallClockMs: z.number().int().positive().max(900_000), framesPerSecond: z.number().positive().finite(),
  peakMemoryBytes: z.number().int().positive(), peakScratchBytes: z.number().int().positive(), outputSizeBytes: z.number().int().positive() }).strict();
const evidenceSchema = z.object({ contractVersion: z.literal(WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1), evidenceId: id,
  packetId: id, packetDigest: digest, attemptId: id, nodeIdentityDigest: digest, toolIdentityDigest: digest,
  sceneIdentityDigest: digest, environmentFingerprint: digest,
  outcome: z.enum(["measured_pass", "measured_fail", "blocked_before_start", "ambiguous_after_start"]),
  startedAt: time.optional(), settledAt: time, measurements: measurementSchema.optional(), outputContentDigest: digest.optional(),
  ownerWindowDigest: digest.optional(), nodeApprovalAttestationDigest: digest.optional(),
  networkEnforcementEvidenceDigest: digest.optional(), nativeExecutionReceiptDigest: digest.optional(),
  measurementEvidenceDigest: digest.optional(), cleanupReceiptDigest: digest.optional(),
  executionAttempted: z.boolean(), preEffectMarkerRecorded: z.boolean(), cleanupConfirmed: z.boolean(),
  candidateForRouteQualification: z.boolean(), automaticallyActivatesRoute: z.literal(false), resolvesMediaCompletion: z.literal(false),
  unrealEligible: z.literal(false), requiresIndependentReview: z.literal(true), requiresReconciliation: z.boolean(),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), evidenceDigest: digest }).strict().superRefine((value, context) => {
    const blocked = value.outcome === "blocked_before_start", passed = value.outcome === "measured_pass",
      ambiguous = value.outcome === "ambiguous_after_start";
    const attemptDigests = [value.ownerWindowDigest, value.nodeApprovalAttestationDigest, value.networkEnforcementEvidenceDigest,
      value.nativeExecutionReceiptDigest, value.measurementEvidenceDigest];
    if (blocked !== (!value.executionAttempted && !value.preEffectMarkerRecorded && !value.startedAt && !value.measurements
      && !value.outputContentDigest && !value.cleanupConfirmed && attemptDigests.every((item) => item === undefined)
      && !value.cleanupReceiptDigest)) context.addIssue({ code: "custom", message: "blocked evidence mismatch" });
    if (!blocked && (!value.executionAttempted || !value.preEffectMarkerRecorded || !value.startedAt)) {
      context.addIssue({ code: "custom", message: "attempt evidence mismatch" });
    }
    if (!blocked && attemptDigests.some((item) => item === undefined)) context.addIssue({ code: "custom", message: "attempt digests incomplete" });
    if (value.startedAt && Date.parse(value.settledAt) < Date.parse(value.startedAt)) context.addIssue({ code: "custom", message: "chronology mismatch" });
    if ((passed || value.outcome === "measured_fail") && (!value.measurements || !value.outputContentDigest
      || !value.cleanupConfirmed || !value.cleanupReceiptDigest)) context.addIssue({ code: "custom", message: "measured evidence incomplete" });
    if (Boolean(value.measurements) !== Boolean(value.outputContentDigest)) context.addIssue({ code: "custom", message: "output identity incomplete" });
    if (value.cleanupConfirmed !== Boolean(value.cleanupReceiptDigest)) context.addIssue({ code: "custom", message: "cleanup evidence mismatch" });
    if (value.measurements && value.measurements.outputSizeBytes <= 0) context.addIssue({ code: "custom", message: "output size mismatch" });
    if (value.candidateForRouteQualification !== passed || value.requiresReconciliation !== ambiguous) {
      context.addIssue({ code: "custom", message: "outcome projection mismatch" });
    }
  });

function exact<T>(schema: z.ZodType<T>, value: unknown): T {
  try { const parsed = schema.parse(exactProjectWorkspaceJsonV1(value)); assertNoSecretMaterial(parsed, "Wayfarer Unreal benchmark"); return parsed; }
  catch (error) { if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    if (error instanceof Error && error.message.includes("contains secret material")) throw new ProjectWorkspaceContractErrorV1("redaction_rejected");
    throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
}
function verifyDigest(value: Record<string, unknown>, key: string, actual: string) { const material = { ...value }; delete material[key];
  if (sha256Digest(material) !== actual) throw new ProjectWorkspaceContractErrorV1("digest_mismatch"); }
function derivedId(prefix: string, value: unknown) { return `${prefix}:${sha256Digest(value).slice(7, 31)}`; }

export function buildWayfarerUnrealBenchmarkPacketV1(packValue: unknown = buildWayfarerSyntheticProjectPackV1()): WayfarerUnrealBenchmarkPacketV1 {
  const pack = parseWayfarerProjectPackV1(packValue), route = pack.stages.find((stage) => stage.stageId === "model_render_segment")!.route;
  const material: Omit<WayfarerUnrealBenchmarkPacketV1, "packetDigest"> = { contractVersion: WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1,
    packetId: "packet:wayfarer:unreal-benchmark:cr9b-wf-080", tenantId: pack.tenantId, workspaceId: pack.workspaceId,
    projectId: pack.projectId, packId: pack.packId, packDigest: pack.packDigest, benchmarkId: WAYFARER_UNREAL_BENCHMARK_ID_V1,
    benchmarkVersion: "1.0.0", stageId: "model_render_segment", scenePolicy: "owner_supplied_private_digest_and_size_only",
    workload: { widthPixels: 1920, heightPixels: 1080, frameCount: 300, warmupRuns: 1, measuredRuns: 3,
      aggregation: "median_wall_clock", deterministicSettingsRequired: true }, limits: { allowedPlatforms: ["macos", "windows", "linux"],
      gpuRequired: true, minimumMemoryBytes: route.minimumMemoryBytes, minimumScratchBytes: route.minimumScratchBytes,
      maximumRuntimeSeconds: 900, maximumCostUsd: 0, maximumAttempts: 1, networkPolicy: "forbidden",
      providerCallsAllowed: false, automaticRetryAllowed: false }, requiredMetrics: WAYFARER_UNREAL_REQUIRED_METRICS_V1,
    requiredEvidence: WAYFARER_UNREAL_REQUIRED_EVIDENCE_V1, ownerAttended: true, freshStrongApprovalRequired: true,
    preEffectMarkerRequired: true, restartAfterMarker: "terminal_ambiguity", resultRetention: "digest_only_control_plane",
    storesPaths: false, storesSceneOrRenderBytes: false, allowsNativeExecution: false, grantsApproval: false,
    grantsExecutionAuthority: false };
  return parseWayfarerUnrealBenchmarkPacketV1({ ...material, packetDigest: sha256Digest(material) });
}
export function parseWayfarerUnrealBenchmarkPacketV1(value: unknown): WayfarerUnrealBenchmarkPacketV1 {
  const parsed = exact(packetSchema, value) as WayfarerUnrealBenchmarkPacketV1;
  verifyDigest(parsed as unknown as Record<string, unknown>, "packetDigest", parsed.packetDigest); return parsed;
}
export function buildWayfarerUnrealBenchmarkPrerequisiteV1(inputValue: unknown): WayfarerUnrealBenchmarkPrerequisiteV1 {
  const input = exact(z.object({ gateId: gate, state: z.enum(["met", "missing", "expired"]), evidenceDigest: digest.optional(),
    checkedAt: time, validUntil: time.optional(), safeReasonCode: id }).strict(), inputValue);
  const material: Omit<WayfarerUnrealBenchmarkPrerequisiteV1, "prerequisiteDigest"> = { contractVersion: WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1,
    ...input, evidenceClass: evidenceClassByGate[input.gateId], requiresAuthoritativeEvidence: true, grantsApproval: false,
    grantsExecutionAuthority: false };
  return parseWayfarerUnrealBenchmarkPrerequisiteV1({ ...material, prerequisiteDigest: sha256Digest(material) });
}
export function parseWayfarerUnrealBenchmarkPrerequisiteV1(value: unknown): WayfarerUnrealBenchmarkPrerequisiteV1 {
  const parsed = exact(prerequisiteSchema, value) as WayfarerUnrealBenchmarkPrerequisiteV1;
  verifyDigest(parsed as unknown as Record<string, unknown>, "prerequisiteDigest", parsed.prerequisiteDigest); return parsed;
}
export function buildWayfarerUnrealBenchmarkReadinessV1(inputValue: unknown): WayfarerUnrealBenchmarkReadinessV1 {
  const input = exact(z.object({ assessmentId: id, tenantId: id, workspaceId: id, projectId: id, candidatePacketId: id.optional(),
    candidatePacketDigest: digest.optional(), prerequisites: z.array(z.unknown()).length(WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1.length),
    assessedAt: time }).strict(), inputValue), prerequisites = input.prerequisites.map(parseWayfarerUnrealBenchmarkPrerequisiteV1),
    blockingGateIds = prerequisites.filter((item) => item.state !== "met").map((item) => item.gateId), candidate = Boolean(
      input.candidatePacketId && input.candidatePacketDigest && blockingGateIds.length === 0);
  const material: Omit<WayfarerUnrealBenchmarkReadinessV1, "assessmentDigest"> = {
    contractVersion: WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1, assessmentId: input.assessmentId, tenantId: input.tenantId,
    workspaceId: input.workspaceId, projectId: input.projectId, operation: "wayfarer.measure_unreal_scene_render",
    ...(input.candidatePacketId ? { candidatePacketId: input.candidatePacketId } : {}),
    ...(input.candidatePacketDigest ? { candidatePacketDigest: input.candidatePacketDigest } : {}), prerequisites, blockingGateIds,
    readiness: candidate ? "candidate_for_owner_window" : "blocked", eligibleForOwnerWindow: candidate, assessedAt: input.assessedAt,
    requiresFreshStrongApproval: true, requiresOwnerPresence: true, nativeCoordinatorImplemented: false,
    benchmarkAuthorized: false, grantsApproval: false, grantsExecutionAuthority: false };
  return parseWayfarerUnrealBenchmarkReadinessV1({ ...material, assessmentDigest: sha256Digest(material) });
}
export function parseWayfarerUnrealBenchmarkReadinessV1(value: unknown): WayfarerUnrealBenchmarkReadinessV1 {
  const parsed = exact(readinessSchema, value) as WayfarerUnrealBenchmarkReadinessV1;
  parsed.prerequisites.forEach(parseWayfarerUnrealBenchmarkPrerequisiteV1);
  verifyDigest(parsed as unknown as Record<string, unknown>, "assessmentDigest", parsed.assessmentDigest); return parsed;
}
export function buildWayfarerUnrealBenchmarkDisabledDispositionV1(inputValue: unknown): WayfarerUnrealBenchmarkDisabledDispositionV1 {
  const input = exact(z.object({ assessment: z.unknown(), recordedAt: time }).strict(), inputValue),
    assessment = parseWayfarerUnrealBenchmarkReadinessV1(input.assessment);
  if (assessment.readiness !== "blocked" || !assessment.blockingGateIds.length || Date.parse(input.recordedAt) < Date.parse(assessment.assessedAt)) {
    throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  }
  const material: Omit<WayfarerUnrealBenchmarkDisabledDispositionV1, "dispositionDigest"> = {
    contractVersion: WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1,
    dispositionId: derivedId("disposition:wayfarer:unreal-disabled", assessment.assessmentDigest), tenantId: assessment.tenantId,
    workspaceId: assessment.workspaceId, projectId: assessment.projectId, assessmentId: assessment.assessmentId,
    assessmentDigest: assessment.assessmentDigest, status: "disabled", blockingGateIds: assessment.blockingGateIds,
    safeReasonCode: "required_evidence_missing", recordedAt: input.recordedAt, requiresNewAssessment: true,
    automaticRetryAllowed: false, nativeAttempted: false, gpuWorkObserved: false, sceneReadObserved: false,
    renderOutputObserved: false, externalEffectOccurred: false, benchmarkAuthorized: false, unrealEligible: false,
    grantsApproval: false, grantsExecutionAuthority: false, requiresIndependentCheckpoint: true };
  return parseWayfarerUnrealBenchmarkDisabledDispositionV1({ ...material, dispositionDigest: sha256Digest(material) });
}
export function parseWayfarerUnrealBenchmarkDisabledDispositionV1(value: unknown): WayfarerUnrealBenchmarkDisabledDispositionV1 {
  const parsed = exact(dispositionSchema, value) as WayfarerUnrealBenchmarkDisabledDispositionV1;
  verifyDigest(parsed as unknown as Record<string, unknown>, "dispositionDigest", parsed.dispositionDigest); return parsed;
}
export function buildWayfarerUnrealBenchmarkEvidenceV1(inputValue: unknown): WayfarerUnrealBenchmarkEvidenceV1 {
  const input = exact(z.object({ evidenceId: id, packet: z.unknown(), attemptId: id, nodeIdentityDigest: digest,
    toolIdentityDigest: digest, sceneIdentityDigest: digest, environmentFingerprint: digest,
    outcome: z.enum(["measured_pass", "measured_fail", "blocked_before_start", "ambiguous_after_start"]),
    startedAt: time.optional(), settledAt: time, measurements: measurementSchema.optional(), outputContentDigest: digest.optional(),
    ownerWindowDigest: digest.optional(), nodeApprovalAttestationDigest: digest.optional(),
    networkEnforcementEvidenceDigest: digest.optional(), nativeExecutionReceiptDigest: digest.optional(),
    measurementEvidenceDigest: digest.optional(), cleanupReceiptDigest: digest.optional(),
    cleanupConfirmed: z.boolean() }).strict(), inputValue), packet = parseWayfarerUnrealBenchmarkPacketV1(input.packet),
    blocked = input.outcome === "blocked_before_start", passed = input.outcome === "measured_pass",
    ambiguous = input.outcome === "ambiguous_after_start";
  const material: Omit<WayfarerUnrealBenchmarkEvidenceV1, "evidenceDigest"> = {
    contractVersion: WAYFARER_UNREAL_BENCHMARK_CONTRACT_V1, evidenceId: input.evidenceId, packetId: packet.packetId,
    packetDigest: packet.packetDigest, attemptId: input.attemptId, nodeIdentityDigest: input.nodeIdentityDigest,
    toolIdentityDigest: input.toolIdentityDigest, sceneIdentityDigest: input.sceneIdentityDigest,
    environmentFingerprint: input.environmentFingerprint, outcome: input.outcome, ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    settledAt: input.settledAt, ...(input.measurements ? { measurements: input.measurements } : {}),
    ...(input.outputContentDigest ? { outputContentDigest: input.outputContentDigest } : {}),
    ...(input.ownerWindowDigest ? { ownerWindowDigest: input.ownerWindowDigest } : {}),
    ...(input.nodeApprovalAttestationDigest ? { nodeApprovalAttestationDigest: input.nodeApprovalAttestationDigest } : {}),
    ...(input.networkEnforcementEvidenceDigest ? { networkEnforcementEvidenceDigest: input.networkEnforcementEvidenceDigest } : {}),
    ...(input.nativeExecutionReceiptDigest ? { nativeExecutionReceiptDigest: input.nativeExecutionReceiptDigest } : {}),
    ...(input.measurementEvidenceDigest ? { measurementEvidenceDigest: input.measurementEvidenceDigest } : {}),
    ...(input.cleanupReceiptDigest ? { cleanupReceiptDigest: input.cleanupReceiptDigest } : {}), executionAttempted: !blocked,
    preEffectMarkerRecorded: !blocked, cleanupConfirmed: input.cleanupConfirmed, candidateForRouteQualification: passed,
    automaticallyActivatesRoute: false, resolvesMediaCompletion: false, unrealEligible: false, requiresIndependentReview: true,
    requiresReconciliation: ambiguous, grantsApproval: false, grantsExecutionAuthority: false };
  return parseWayfarerUnrealBenchmarkEvidenceV1({ ...material, evidenceDigest: sha256Digest(material) });
}
export function parseWayfarerUnrealBenchmarkEvidenceV1(value: unknown): WayfarerUnrealBenchmarkEvidenceV1 {
  const parsed = exact(evidenceSchema, value) as WayfarerUnrealBenchmarkEvidenceV1;
  verifyDigest(parsed as unknown as Record<string, unknown>, "evidenceDigest", parsed.evidenceDigest); return parsed;
}
export function buildCurrentWayfarerUnrealBenchmarkDisabledV1(packValue: unknown = buildWayfarerSyntheticProjectPackV1()) {
  const packet = buildWayfarerUnrealBenchmarkPacketV1(packValue), checkedAt = "2026-08-29T23:20:00.000Z",
    prerequisites = WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1.map((gateId) => buildWayfarerUnrealBenchmarkPrerequisiteV1(gateId === "exact_benchmark_packet"
      ? { gateId, state: "met", evidenceDigest: packet.packetDigest, checkedAt, safeReasonCode: "packet_frozen" }
      : { gateId, state: "missing", checkedAt, safeReasonCode: `missing_${gateId}` })),
    assessment = buildWayfarerUnrealBenchmarkReadinessV1({ assessmentId: "assessment:wayfarer:unreal:cr9b-wf-080",
      tenantId: packet.tenantId, workspaceId: packet.workspaceId, projectId: packet.projectId, candidatePacketId: packet.packetId,
      candidatePacketDigest: packet.packetDigest, prerequisites, assessedAt: checkedAt }),
    disposition = buildWayfarerUnrealBenchmarkDisabledDispositionV1({ assessment, recordedAt: "2026-08-29T23:21:00.000Z" });
  return { packet, assessment, disposition };
}

export const wayfarerUnrealBenchmarkSchemasV1 = { packet: packetSchema, prerequisite: prerequisiteSchema,
  readiness: readinessSchema, disposition: dispositionSchema, evidence: evidenceSchema } as const;
