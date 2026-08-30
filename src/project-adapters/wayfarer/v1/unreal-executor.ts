import { z } from "zod";
import {
  exactProjectWorkspaceJsonV1,
  ProjectWorkspaceContractErrorV1,
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../../project-workspace/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import { buildWayfarerSyntheticProjectPackV1 } from "./fixture";
import {
  buildCurrentWayfarerUnrealBenchmarkDisabledV1,
  parseWayfarerUnrealBenchmarkDisabledDispositionV1,
  parseWayfarerUnrealBenchmarkPacketV1,
  parseWayfarerUnrealBenchmarkReadinessV1,
  WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1,
  type WayfarerUnrealBenchmarkDisabledDispositionV1,
  type WayfarerUnrealBenchmarkGateIdV1,
  type WayfarerUnrealBenchmarkPacketV1,
  type WayfarerUnrealBenchmarkReadinessV1,
} from "./unreal-benchmark";

export const WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1 = "control-room-wayfarer-unreal-executor/v1" as const;
export const WAYFARER_UNREAL_EXECUTOR_ID_V1 = "executor:wayfarer:unreal:disabled:v1" as const;
export const WAYFARER_UNREAL_EXECUTOR_BLOCKERS_V1 = [
  "benchmark_readiness_blocked",
  "native_adapter_not_implemented",
  "private_scene_locator_unavailable",
  "pinned_tool_locator_unavailable",
  "node_execution_authority_unavailable",
  "fresh_owner_window_unavailable",
] as const;
export type WayfarerUnrealExecutorBlockerV1 = (typeof WAYFARER_UNREAL_EXECUTOR_BLOCKERS_V1)[number];

export interface WayfarerUnrealExecutorManifestV1 {
  contractVersion: typeof WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1;
  manifestId: string;
  executorId: typeof WAYFARER_UNREAL_EXECUTOR_ID_V1;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  packId: string;
  packDigest: string;
  packetId: string;
  packetDigest: string;
  operation: "wayfarer.measure_unreal_scene_render";
  stageId: "model_render_segment";
  supportedPlatforms: ["macos", "windows", "linux"];
  implementationState: "frozen_disabled_contract_only";
  commandModel: "none";
  nativeAdapterPresent: false;
  processSpawnPresent: false;
  filesystemReaderPresent: false;
  sceneLocatorResolverPresent: false;
  toolLocatorResolverPresent: false;
  credentialResolverPresent: false;
  networkClientPresent: false;
  artifactWriterPresent: false;
  cancellationControllerPresent: false;
  maximumAttempts: 1;
  maximumRuntimeSeconds: 900;
  maximumCostUsd: 0;
  networkPolicy: "forbidden";
  automaticRetryAllowed: false;
  canPrepareAdmissionOnly: true;
  canExecute: false;
  allowsNativeExecution: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  manifestDigest: string;
}

export interface WayfarerUnrealExecutorAdmissionV1 {
  contractVersion: typeof WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1;
  admissionId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  manifestId: string;
  manifestDigest: string;
  packetId: string;
  packetDigest: string;
  assessmentId: string;
  assessmentDigest: string;
  dispositionId: string;
  dispositionDigest: string;
  operation: "wayfarer.measure_unreal_scene_render";
  status: "disabled_before_start";
  readinessGateBlockers: WayfarerUnrealBenchmarkGateIdV1[];
  executorBlockers: WayfarerUnrealExecutorBlockerV1[];
  evaluatedAt: string;
  createsJob: false;
  createsReservation: false;
  createsLease: false;
  createsEffectClaim: false;
  recordsPreEffectMarker: false;
  resolvesPrivateLocator: false;
  invokesNativeAdapter: false;
  attemptsExecution: false;
  consumesOwnerApproval: false;
  eligibleForOwnerWindow: false;
  benchmarkAuthorized: false;
  unrealEligible: false;
  automaticRetryAllowed: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  admissionDigest: string;
}

export interface WayfarerUnrealExecutorDisabledReceiptV1 {
  contractVersion: typeof WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1;
  receiptId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  admissionId: string;
  admissionDigest: string;
  result: "disabled_before_start";
  safeReasonCode: "frozen_executor_has_no_native_implementation";
  recordedAt: string;
  attemptIdPresent: false;
  processStarted: false;
  sceneRead: false;
  gpuWorkObserved: false;
  outputObserved: false;
  networkObserved: false;
  credentialResolutionObserved: false;
  filesystemEffectObserved: false;
  externalEffectOccurred: false;
  retryScheduled: false;
  benchmarkAuthorized: false;
  unrealEligible: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

const tuple = <T extends readonly [string, ...string[]]>(values: T) => z.tuple(values.map((value) => z.literal(value)) as unknown as {
  [K in keyof T]: z.ZodLiteral<T[K]>
});
const manifestSchema = z.object({ contractVersion: z.literal(WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1), manifestId: id,
  executorId: z.literal(WAYFARER_UNREAL_EXECUTOR_ID_V1), tenantId: id, workspaceId: id, projectId: id, packId: id,
  packDigest: digest, packetId: id, packetDigest: digest, operation: z.literal("wayfarer.measure_unreal_scene_render"),
  stageId: z.literal("model_render_segment"), supportedPlatforms: tuple(["macos", "windows", "linux"]),
  implementationState: z.literal("frozen_disabled_contract_only"), commandModel: z.literal("none"),
  nativeAdapterPresent: z.literal(false), processSpawnPresent: z.literal(false), filesystemReaderPresent: z.literal(false),
  sceneLocatorResolverPresent: z.literal(false), toolLocatorResolverPresent: z.literal(false),
  credentialResolverPresent: z.literal(false), networkClientPresent: z.literal(false), artifactWriterPresent: z.literal(false),
  cancellationControllerPresent: z.literal(false), maximumAttempts: z.literal(1), maximumRuntimeSeconds: z.literal(900),
  maximumCostUsd: z.literal(0), networkPolicy: z.literal("forbidden"), automaticRetryAllowed: z.literal(false),
  canPrepareAdmissionOnly: z.literal(true), canExecute: z.literal(false), allowsNativeExecution: z.literal(false),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), manifestDigest: digest }).strict();
const benchmarkGate = z.enum(WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1);
const admissionSchema = z.object({ contractVersion: z.literal(WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1), admissionId: id,
  tenantId: id, workspaceId: id, projectId: id, manifestId: id, manifestDigest: digest, packetId: id, packetDigest: digest,
  assessmentId: id, assessmentDigest: digest, dispositionId: id, dispositionDigest: digest,
  operation: z.literal("wayfarer.measure_unreal_scene_render"), status: z.literal("disabled_before_start"),
  readinessGateBlockers: z.array(benchmarkGate).length(12), executorBlockers: tuple(WAYFARER_UNREAL_EXECUTOR_BLOCKERS_V1),
  evaluatedAt: time, createsJob: z.literal(false), createsReservation: z.literal(false), createsLease: z.literal(false),
  createsEffectClaim: z.literal(false), recordsPreEffectMarker: z.literal(false), resolvesPrivateLocator: z.literal(false),
  invokesNativeAdapter: z.literal(false), attemptsExecution: z.literal(false), consumesOwnerApproval: z.literal(false),
  eligibleForOwnerWindow: z.literal(false), benchmarkAuthorized: z.literal(false), unrealEligible: z.literal(false),
  automaticRetryAllowed: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  admissionDigest: digest }).strict();
const receiptSchema = z.object({ contractVersion: z.literal(WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1), receiptId: id,
  tenantId: id, workspaceId: id, projectId: id, admissionId: id, admissionDigest: digest,
  result: z.literal("disabled_before_start"), safeReasonCode: z.literal("frozen_executor_has_no_native_implementation"),
  recordedAt: time, attemptIdPresent: z.literal(false), processStarted: z.literal(false), sceneRead: z.literal(false),
  gpuWorkObserved: z.literal(false), outputObserved: z.literal(false), networkObserved: z.literal(false),
  credentialResolutionObserved: z.literal(false), filesystemEffectObserved: z.literal(false),
  externalEffectOccurred: z.literal(false), retryScheduled: z.literal(false), benchmarkAuthorized: z.literal(false),
  unrealEligible: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  receiptDigest: digest }).strict();

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

export function buildWayfarerUnrealExecutorManifestV1(
  packetValue: unknown = buildCurrentWayfarerUnrealBenchmarkDisabledV1().packet,
): WayfarerUnrealExecutorManifestV1 {
  const packet = parseWayfarerUnrealBenchmarkPacketV1(packetValue);
  const material: Omit<WayfarerUnrealExecutorManifestV1, "manifestDigest"> = {
    contractVersion: WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1,
    manifestId: "manifest:wayfarer:unreal-executor:cr9b-wf-090",
    executorId: WAYFARER_UNREAL_EXECUTOR_ID_V1,
    tenantId: packet.tenantId,
    workspaceId: packet.workspaceId,
    projectId: packet.projectId,
    packId: packet.packId,
    packDigest: packet.packDigest,
    packetId: packet.packetId,
    packetDigest: packet.packetDigest,
    operation: "wayfarer.measure_unreal_scene_render",
    stageId: packet.stageId,
    supportedPlatforms: ["macos", "windows", "linux"],
    implementationState: "frozen_disabled_contract_only",
    commandModel: "none",
    nativeAdapterPresent: false,
    processSpawnPresent: false,
    filesystemReaderPresent: false,
    sceneLocatorResolverPresent: false,
    toolLocatorResolverPresent: false,
    credentialResolverPresent: false,
    networkClientPresent: false,
    artifactWriterPresent: false,
    cancellationControllerPresent: false,
    maximumAttempts: packet.limits.maximumAttempts,
    maximumRuntimeSeconds: packet.limits.maximumRuntimeSeconds,
    maximumCostUsd: packet.limits.maximumCostUsd,
    networkPolicy: packet.limits.networkPolicy,
    automaticRetryAllowed: packet.limits.automaticRetryAllowed,
    canPrepareAdmissionOnly: true,
    canExecute: false,
    allowsNativeExecution: false,
    grantsApproval: false,
    grantsExecutionAuthority: false,
  };
  return parseWayfarerUnrealExecutorManifestV1({ ...material, manifestDigest: sha256Digest(material) });
}

export function parseWayfarerUnrealExecutorManifestV1(value: unknown): WayfarerUnrealExecutorManifestV1 {
  const parsed = exact(manifestSchema, value, "Wayfarer Unreal executor manifest") as WayfarerUnrealExecutorManifestV1;
  verifyDigest(parsed as unknown as Record<string, unknown>, "manifestDigest", parsed.manifestDigest);
  return parsed;
}

export function buildWayfarerUnrealExecutorAdmissionV1(input: {
  manifest: unknown;
  packet: unknown;
  assessment: unknown;
  disposition: unknown;
  evaluatedAt: string;
}): WayfarerUnrealExecutorAdmissionV1 {
  const manifest = parseWayfarerUnrealExecutorManifestV1(input.manifest);
  const packet = parseWayfarerUnrealBenchmarkPacketV1(input.packet);
  const assessment = parseWayfarerUnrealBenchmarkReadinessV1(input.assessment);
  const disposition = parseWayfarerUnrealBenchmarkDisabledDispositionV1(input.disposition);
  if (manifest.packetId !== packet.packetId || manifest.packetDigest !== packet.packetDigest
    || manifest.packDigest !== packet.packDigest || manifest.tenantId !== assessment.tenantId
    || manifest.workspaceId !== assessment.workspaceId || manifest.projectId !== assessment.projectId
    || assessment.assessmentId !== disposition.assessmentId || assessment.assessmentDigest !== disposition.assessmentDigest
    || assessment.readiness !== "blocked" || assessment.eligibleForOwnerWindow || disposition.status !== "disabled"
    || disposition.blockingGateIds.join("|") !== assessment.blockingGateIds.join("|")) {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  const identity = { manifestDigest: manifest.manifestDigest, packetDigest: packet.packetDigest,
    assessmentDigest: assessment.assessmentDigest, dispositionDigest: disposition.dispositionDigest };
  const material: Omit<WayfarerUnrealExecutorAdmissionV1, "admissionDigest"> = {
    contractVersion: WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1,
    admissionId: derivedId("admission:wayfarer:unreal:disabled", identity),
    tenantId: packet.tenantId,
    workspaceId: packet.workspaceId,
    projectId: packet.projectId,
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    packetId: packet.packetId,
    packetDigest: packet.packetDigest,
    assessmentId: assessment.assessmentId,
    assessmentDigest: assessment.assessmentDigest,
    dispositionId: disposition.dispositionId,
    dispositionDigest: disposition.dispositionDigest,
    operation: "wayfarer.measure_unreal_scene_render",
    status: "disabled_before_start",
    readinessGateBlockers: disposition.blockingGateIds,
    executorBlockers: [...WAYFARER_UNREAL_EXECUTOR_BLOCKERS_V1],
    evaluatedAt: input.evaluatedAt,
    createsJob: false,
    createsReservation: false,
    createsLease: false,
    createsEffectClaim: false,
    recordsPreEffectMarker: false,
    resolvesPrivateLocator: false,
    invokesNativeAdapter: false,
    attemptsExecution: false,
    consumesOwnerApproval: false,
    eligibleForOwnerWindow: false,
    benchmarkAuthorized: false,
    unrealEligible: false,
    automaticRetryAllowed: false,
    grantsApproval: false,
    grantsExecutionAuthority: false,
  };
  return parseWayfarerUnrealExecutorAdmissionV1({ ...material, admissionDigest: sha256Digest(material) });
}

export function parseWayfarerUnrealExecutorAdmissionV1(value: unknown): WayfarerUnrealExecutorAdmissionV1 {
  const parsed = exact(admissionSchema, value, "Wayfarer Unreal executor admission");
  if (parsed.readinessGateBlockers.join("|") !== WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1.slice(1).join("|")) {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  verifyDigest(parsed as unknown as Record<string, unknown>, "admissionDigest", parsed.admissionDigest);
  return parsed;
}

export function buildWayfarerUnrealExecutorDisabledReceiptV1(input: {
  admission: unknown;
  recordedAt: string;
}): WayfarerUnrealExecutorDisabledReceiptV1 {
  const admission = parseWayfarerUnrealExecutorAdmissionV1(input.admission);
  if (Date.parse(input.recordedAt) < Date.parse(admission.evaluatedAt)) {
    throw new ProjectWorkspaceContractErrorV1("invalid_transition");
  }
  const material: Omit<WayfarerUnrealExecutorDisabledReceiptV1, "receiptDigest"> = {
    contractVersion: WAYFARER_UNREAL_EXECUTOR_CONTRACT_V1,
    receiptId: derivedId("receipt:wayfarer:unreal:disabled", { admissionDigest: admission.admissionDigest }),
    tenantId: admission.tenantId,
    workspaceId: admission.workspaceId,
    projectId: admission.projectId,
    admissionId: admission.admissionId,
    admissionDigest: admission.admissionDigest,
    result: "disabled_before_start",
    safeReasonCode: "frozen_executor_has_no_native_implementation",
    recordedAt: input.recordedAt,
    attemptIdPresent: false,
    processStarted: false,
    sceneRead: false,
    gpuWorkObserved: false,
    outputObserved: false,
    networkObserved: false,
    credentialResolutionObserved: false,
    filesystemEffectObserved: false,
    externalEffectOccurred: false,
    retryScheduled: false,
    benchmarkAuthorized: false,
    unrealEligible: false,
    grantsApproval: false,
    grantsExecutionAuthority: false,
  };
  return parseWayfarerUnrealExecutorDisabledReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
}

export function parseWayfarerUnrealExecutorDisabledReceiptV1(value: unknown): WayfarerUnrealExecutorDisabledReceiptV1 {
  const parsed = exact(receiptSchema, value, "Wayfarer Unreal executor disabled receipt");
  verifyDigest(parsed as unknown as Record<string, unknown>, "receiptDigest", parsed.receiptDigest);
  return parsed;
}

export function buildCurrentWayfarerUnrealExecutorDisabledV1(packValue: unknown = buildWayfarerSyntheticProjectPackV1()): {
  packet: WayfarerUnrealBenchmarkPacketV1;
  assessment: WayfarerUnrealBenchmarkReadinessV1;
  disposition: WayfarerUnrealBenchmarkDisabledDispositionV1;
  manifest: WayfarerUnrealExecutorManifestV1;
  admission: WayfarerUnrealExecutorAdmissionV1;
  receipt: WayfarerUnrealExecutorDisabledReceiptV1;
} {
  const benchmark = buildCurrentWayfarerUnrealBenchmarkDisabledV1(packValue);
  const manifest = buildWayfarerUnrealExecutorManifestV1(benchmark.packet);
  const admission = buildWayfarerUnrealExecutorAdmissionV1({ ...benchmark, manifest, evaluatedAt: "2026-08-29T23:10:00.000Z" });
  const receipt = buildWayfarerUnrealExecutorDisabledReceiptV1({ admission, recordedAt: "2026-08-29T23:10:01.000Z" });
  return { ...benchmark, manifest, admission, receipt };
}

export const wayfarerUnrealExecutorSchemasV1 = { manifest: manifestSchema, admission: admissionSchema,
  disabledReceipt: receiptSchema } as const;
