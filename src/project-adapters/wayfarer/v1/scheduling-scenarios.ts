import { z } from "zod";
import { evaluateFleetEligibility, fleetSignalEnvelopeSchema, type FleetSignalEnvelope } from "../../../node-fleet/v1";
import { exactProjectWorkspaceJsonV1, ProjectWorkspaceContractErrorV1, projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id } from "../../../project-workspace/v1";
import { chooseAllocationV1, findBottleneckV1, projectResourceReliefV1 } from "../../../scheduler/v1";
import { sha256Digest } from "../../../security";
import { parseWayfarerProjectPackV1 } from "./contract";
import type { WayfarerProjectPackV1, WayfarerStageIdV1 } from "./types";

export const WAYFARER_SCHEDULING_SCENARIO_CONTRACT_V1 = "control-room-wayfarer-scheduling-scenario/v1" as const;
export type WayfarerSchedulingRejectionV1 = "scratch_insufficient" | "memory_insufficient" | "gpu_capability_missing"
  | "benchmark_missing" | "benchmark_environment_mismatch" | "gpu_capacity_unavailable" | "unreal_not_eligible";

export interface WayfarerSchedulingScenarioV1 {
  contractVersion: typeof WAYFARER_SCHEDULING_SCENARIO_CONTRACT_V1;
  scenarioId: string;
  label: string;
  tenantId: string;
  projectId: string;
  packDigest: string;
  stageId: WayfarerStageIdV1;
  routeProfileId: string;
  nodeId: string;
  platform: "linux" | "macos" | "windows";
  availableMemoryBytes: number;
  minimumMemoryBytes: number;
  availableScratchBytes: number;
  minimumScratchBytes: number;
  gpuRequirement: "required" | "optional" | "forbidden";
  gpuCapabilityState: "reported_pass" | "missing";
  benchmarkState: "synthetic_match" | "missing" | "environment_mismatch" | "not_required";
  requestedGpuUnits: number;
  availableGpuUnits: number;
  rejectionReasons: WayfarerSchedulingRejectionV1[];
  selectedForSimulation: boolean;
  schedulerExplanation: string[];
  bottleneckResourceKey?: string;
  reliefWouldMakeFeasible: boolean;
  evidenceAuthority: "synthetic_only";
  realGpuInspected: false;
  realScratchInspected: false;
  benchmarkExecuted: false;
  createsReservation: false;
  dispatchesWork: false;
  allowsNativeExecution: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  scenarioDigest: string;
}

const stageId = z.enum(["model_render_segment", "audio_candidate", "qc_media_probe", "review_cut", "assemble_episode", "prepare_publication"]);
const rejection = z.enum(["scratch_insufficient", "memory_insufficient", "gpu_capability_missing", "benchmark_missing",
  "benchmark_environment_mismatch", "gpu_capacity_unavailable", "unreal_not_eligible"]);
const scenarioSchema = z.object({ contractVersion: z.literal(WAYFARER_SCHEDULING_SCENARIO_CONTRACT_V1), scenarioId: id,
  label: z.string().min(1).max(120), tenantId: id, projectId: id, packDigest: digest, stageId, routeProfileId: id, nodeId: id,
  platform: z.enum(["linux", "macos", "windows"]), availableMemoryBytes: z.number().int().nonnegative(),
  minimumMemoryBytes: z.number().int().positive(), availableScratchBytes: z.number().int().nonnegative(),
  minimumScratchBytes: z.number().int().positive(), gpuRequirement: z.enum(["required", "optional", "forbidden"]),
  gpuCapabilityState: z.enum(["reported_pass", "missing"]),
  benchmarkState: z.enum(["synthetic_match", "missing", "environment_mismatch", "not_required"]),
  requestedGpuUnits: z.number().int().min(0).max(8), availableGpuUnits: z.number().int().min(0).max(8),
  rejectionReasons: z.array(rejection).max(7), selectedForSimulation: z.boolean(),
  schedulerExplanation: z.array(z.string().min(1).max(240)).min(1).max(8), bottleneckResourceKey: id.optional(),
  reliefWouldMakeFeasible: z.boolean(), evidenceAuthority: z.literal("synthetic_only"), realGpuInspected: z.literal(false),
  realScratchInspected: z.literal(false), benchmarkExecuted: z.literal(false), createsReservation: z.literal(false),
  dispatchesWork: z.literal(false), allowsNativeExecution: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), scenarioDigest: digest }).strict();

function exact<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(exactProjectWorkspaceJsonV1(value)); }
  catch (error) { if (error instanceof ProjectWorkspaceContractErrorV1) throw error; throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
}
function withoutDigest(value: Record<string, unknown>) { const copy = { ...value }; delete copy.scenarioDigest; return copy; }

export function parseWayfarerSchedulingScenarioV1(value: unknown): WayfarerSchedulingScenarioV1 {
  const scenario = exact(scenarioSchema, value) as WayfarerSchedulingScenarioV1;
  if (new Set(scenario.rejectionReasons).size !== scenario.rejectionReasons.length
    || scenario.rejectionReasons.join("|") !== [...scenario.rejectionReasons].sort().join("|")
    || scenario.selectedForSimulation !== (scenario.rejectionReasons.length === 0)
    || Boolean(scenario.bottleneckResourceKey) !== scenario.rejectionReasons.includes("gpu_capacity_unavailable")
    || scenario.reliefWouldMakeFeasible !== scenario.rejectionReasons.includes("gpu_capacity_unavailable")
    || sha256Digest(withoutDigest(scenario as unknown as Record<string, unknown>)) !== scenario.scenarioDigest) {
    throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  }
  return scenario;
}

interface ScenarioInput {
  scenarioId: string;
  label: string;
  stageId: WayfarerStageIdV1;
  nodeId: string;
  platform: "linux" | "macos" | "windows";
  availableMemoryBytes: number;
  availableScratchBytes: number;
  gpuCapability: boolean;
  benchmark: "match" | "missing" | "mismatch";
  requestedGpuUnits: number;
  availableGpuUnits: number;
  unrealRequested?: boolean;
}

function signals(pack: WayfarerProjectPackV1, input: ScenarioInput): FleetSignalEnvelope[] {
  const observedAt = "2026-08-29T22:00:00.000Z", fingerprint = sha256Digest({ nodeId: input.nodeId, environment: "synthetic-wayfarer" }),
    base = { schemaVersion: "1.0.0" as const, tenantId: pack.tenantId, nodeId: input.nodeId, observedAt, trust: "reported" as const,
      fingerprint }, result: FleetSignalEnvelope[] = [];
  result.push(fleetSignalEnvelopeSchema.parse({ ...base, kind: "discovery", source: "static_collector", sequence: 1,
    expiresAt: "2026-08-30T22:00:00.000Z", payload: { platform: input.platform, architecture: "synthetic",
      cpuLogicalCores: 8, memoryBytes: input.availableMemoryBytes, gpuClasses: input.gpuCapability ? ["synthetic-gpu"] : [],
      storage: [{ capacityBytes: Math.max(input.availableScratchBytes, 1), availableBytes: input.availableScratchBytes,
        scratchEligible: input.availableScratchBytes > 0, encryptionReported: true }], networkClass: "offline", inventory: [],
      executorManifestDigest: sha256Digest({ executor: "none" }) } }));
  result.push(fleetSignalEnvelopeSchema.parse({ ...base, kind: "telemetry", source: "telemetry_port", sequence: 2,
    expiresAt: "2026-08-29T22:05:00.000Z", payload: { samplingIntervalSeconds: 60,
      cpuUtilizationPercent: { quality: "observed", value: 0 }, availableMemoryBytes: { quality: "observed", value: input.availableMemoryBytes },
      availableStorageBytes: { quality: "observed", value: input.availableScratchBytes }, networkClass: "offline", powerState: "ac",
      thermalState: "nominal" } }));
  if (input.gpuCapability) result.push(fleetSignalEnvelopeSchema.parse({ ...base, kind: "capability", source: "probe_runner", sequence: 3,
    expiresAt: "2026-09-05T22:00:00.000Z", payload: { probeId: "probe:wayfarer:synthetic-gpu", probeVersion: "1.0.0",
      outcome: "pass", reasonCode: "synthetic_reported_pass", evidenceDigest: sha256Digest({ gpu: "synthetic" }) } }));
  if (input.benchmark !== "missing") result.push(fleetSignalEnvelopeSchema.parse({ ...base, kind: "benchmark", source: "benchmark_runner",
    sequence: 4, expiresAt: "2026-09-28T22:00:00.000Z", payload: { benchmarkId: "benchmark:wayfarer:synthetic-render",
      benchmarkVersion: "1.0.0", workloadDigest: sha256Digest({ workload: "no-byte-render" }), outcome: "pass",
      reasonCode: "synthetic_metadata_only", normalizedScore: 1, scoreUnit: "synthetic_points",
      environmentFingerprint: input.benchmark === "match" ? fingerprint : sha256Digest({ environment: "different" }),
      evidenceDigest: sha256Digest({ benchmark: input.benchmark }) } }));
  return result;
}

function buildScenario(pack: WayfarerProjectPackV1, input: ScenarioInput): WayfarerSchedulingScenarioV1 {
  const stage = pack.stages.find((candidate) => candidate.stageId === input.stageId)!;
  const fleet = evaluateFleetEligibility({ now: "2026-08-29T22:01:00.000Z", signals: signals(pack, input),
    requiredScratchBytes: stage.route.minimumScratchBytes,
    ...(stage.route.gpu === "required" ? { requiredCapabilityProbeId: "probe:wayfarer:synthetic-gpu" } : {}),
    ...(stage.route.requiresMeasuredBenchmark ? { requiredBenchmarkId: "benchmark:wayfarer:synthetic-render" } : {}) });
  const reasons = new Set<WayfarerSchedulingRejectionV1>();
  for (const reason of fleet.reasons) {
    if (reason === "scratch_insufficient") reasons.add("scratch_insufficient");
    if (reason === "capability_missing" || reason === "capability_expired" || reason === "capability_unverified") reasons.add("gpu_capability_missing");
    if (reason === "benchmark_missing" || reason === "benchmark_expired") reasons.add("benchmark_missing");
    if (reason === "benchmark_environment_mismatch") reasons.add("benchmark_environment_mismatch");
  }
  if (input.availableMemoryBytes < stage.route.minimumMemoryBytes) reasons.add("memory_insufficient");
  if (input.requestedGpuUnits > input.availableGpuUnits) reasons.add("gpu_capacity_unavailable");
  if (input.unrealRequested && !pack.unrealEligible) reasons.add("unreal_not_eligible");
  const sortedReasons = [...reasons].sort(), resourceKey = `resource:wayfarer:synthetic-gpu:${input.nodeId}`,
    allocation = chooseAllocationV1([{ projectId: pack.projectId, workItemId: `work:wayfarer:${input.scenarioId}`,
      routeId: stage.route.routeProfileId, targetShare: 50, recentShareUsed: 10, priority: 80, queueAgeMinutes: 30,
      downstreamUnlockCount: 2, deadlineRisk: 0, estimatedCostUsd: 0,
      availability: { resourceKey, requestedFrom: "2026-08-29T22:02:00.000Z", requestedUntil: "2026-08-29T22:12:00.000Z",
        units: Math.max(input.requestedGpuUnits, 1), windows: [{ startsAt: "2026-08-29T22:00:00.000Z",
          endsAt: "2026-08-29T23:00:00.000Z", capacityUnits: Math.max(input.availableGpuUnits, 1) }] },
      exclusions: sortedReasons.length ? [sortedReasons.includes("gpu_capacity_unavailable") ? "resource_unavailable" : "fleet_ineligible"] : [] }]),
    bottleneck = sortedReasons.includes("gpu_capacity_unavailable") ? findBottleneckV1([{ resourceKey,
      capacityUnits: Math.max(input.availableGpuUnits, 1), reservedUnits: Math.max(input.availableGpuUnits, 1),
      blockedWorkItemIds: [`work:wayfarer:${input.scenarioId}`] }]) : undefined,
    relief = bottleneck ? projectResourceReliefV1({ resourceKey, capacityUnits: Math.max(input.availableGpuUnits, 1),
      reservedUnits: Math.max(input.availableGpuUnits, 1), releasedUnits: 1,
      waiting: [{ workItemId: `work:wayfarer:${input.scenarioId}`, units: 1, queuePosition: 1, downstreamUnlockCount: 2 }] }) : undefined,
    unsigned: Omit<WayfarerSchedulingScenarioV1, "scenarioDigest"> = { contractVersion: WAYFARER_SCHEDULING_SCENARIO_CONTRACT_V1,
      scenarioId: input.scenarioId, label: input.label, tenantId: pack.tenantId, projectId: pack.projectId,
      packDigest: pack.packDigest, stageId: input.stageId, routeProfileId: stage.route.routeProfileId, nodeId: input.nodeId,
      platform: input.platform, availableMemoryBytes: input.availableMemoryBytes, minimumMemoryBytes: stage.route.minimumMemoryBytes,
      availableScratchBytes: input.availableScratchBytes, minimumScratchBytes: stage.route.minimumScratchBytes,
      gpuRequirement: stage.route.gpu, gpuCapabilityState: input.gpuCapability ? "reported_pass" : "missing",
      benchmarkState: !stage.route.requiresMeasuredBenchmark ? "not_required" : input.benchmark === "match" ? "synthetic_match"
        : input.benchmark === "missing" ? "missing" : "environment_mismatch", requestedGpuUnits: input.requestedGpuUnits,
      availableGpuUnits: input.availableGpuUnits, rejectionReasons: sortedReasons, selectedForSimulation: Boolean(allocation.selected),
      schedulerExplanation: allocation.explanation, ...(bottleneck ? { bottleneckResourceKey: bottleneck.resourceKey } : {}),
      reliefWouldMakeFeasible: Boolean(relief?.newlyFeasibleWorkItemIds.length), evidenceAuthority: "synthetic_only",
      realGpuInspected: false, realScratchInspected: false, benchmarkExecuted: false, createsReservation: false,
      dispatchesWork: false, allowsNativeExecution: false, grantsApproval: false, grantsExecutionAuthority: false };
  return parseWayfarerSchedulingScenarioV1({ ...unsigned, scenarioDigest: sha256Digest(unsigned) });
}

export function buildWayfarerSchedulingScenarioCatalogV1(packValue: unknown): WayfarerSchedulingScenarioV1[] {
  const pack = parseWayfarerProjectPackV1(packValue), gib = 1_073_741_824;
  return [
    buildScenario(pack, { scenarioId: "scenario:wayfarer:synthetic-render-ready", label: "Synthetic render route has reported GPU and scratch",
      stageId: "model_render_segment", nodeId: "node:synthetic:windows-ready", platform: "windows", availableMemoryBytes: 32 * gib,
      availableScratchBytes: 128 * gib, gpuCapability: true, benchmark: "match", requestedGpuUnits: 1, availableGpuUnits: 1 }),
    buildScenario(pack, { scenarioId: "scenario:wayfarer:scratch-blocked", label: "Render route blocked by scratch ceiling",
      stageId: "model_render_segment", nodeId: "node:synthetic:mac-scratch", platform: "macos", availableMemoryBytes: 32 * gib,
      availableScratchBytes: 8 * gib, gpuCapability: true, benchmark: "match", requestedGpuUnits: 1, availableGpuUnits: 1 }),
    buildScenario(pack, { scenarioId: "scenario:wayfarer:gpu-capability-missing", label: "Render route blocked by missing GPU capability",
      stageId: "model_render_segment", nodeId: "node:synthetic:linux-no-gpu", platform: "linux", availableMemoryBytes: 32 * gib,
      availableScratchBytes: 128 * gib, gpuCapability: false, benchmark: "match", requestedGpuUnits: 1, availableGpuUnits: 1 }),
    buildScenario(pack, { scenarioId: "scenario:wayfarer:benchmark-mismatch", label: "Render route blocked by benchmark environment drift",
      stageId: "model_render_segment", nodeId: "node:synthetic:windows-drift", platform: "windows", availableMemoryBytes: 32 * gib,
      availableScratchBytes: 128 * gib, gpuCapability: true, benchmark: "mismatch", requestedGpuUnits: 1, availableGpuUnits: 1 }),
    buildScenario(pack, { scenarioId: "scenario:wayfarer:gpu-contention", label: "Assembly route waits for declared GPU capacity",
      stageId: "assemble_episode", nodeId: "node:synthetic:windows-busy", platform: "windows", availableMemoryBytes: 32 * gib,
      availableScratchBytes: 256 * gib, gpuCapability: true, benchmark: "missing", requestedGpuUnits: 2, availableGpuUnits: 1 }),
    buildScenario(pack, { scenarioId: "scenario:wayfarer:unreal-disabled", label: "Unreal remains blocked before an owner-controlled benchmark",
      stageId: "model_render_segment", nodeId: "node:synthetic:unreal-declared", platform: "windows", availableMemoryBytes: 64 * gib,
      availableScratchBytes: 512 * gib, gpuCapability: true, benchmark: "match", requestedGpuUnits: 1, availableGpuUnits: 1,
      unrealRequested: true }),
  ];
}

export const wayfarerSchedulingScenarioSchemasV1 = { scenario: scenarioSchema } as const;
