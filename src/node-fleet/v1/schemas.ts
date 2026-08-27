import { z } from "zod";
import { FLEET_SIGNAL_CONTRACT_V1, FLEET_SIGNAL_MAX_AGE_MS_V1 } from "./types";

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const label = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._: -]*$/);
const isoDate = z.string().datetime({ offset: true });
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const capacityBytes = z.number().int().nonnegative().max(9_007_199_254_740_991);
const trustSchema = z.enum(["reported", "verified", "blocked", "unavailable"]);

export const inventoryEntrySchema = z.object({ kind: z.enum(["bridge", "harness", "executor", "tool"]), id, version: label, manifestDigest: digest }).strict();

export const discoveryPayloadSchema = z.object({
  platform: z.enum(["windows", "macos", "linux", "cloud"]),
  architecture: label,
  cpuLogicalCores: z.number().int().min(1).max(4_096),
  memoryBytes: capacityBytes,
  gpuClasses: z.array(label).max(32),
  storage: z.array(z.object({ capacityBytes, availableBytes: capacityBytes, scratchEligible: z.boolean(), encryptionReported: z.boolean() }).strict()).min(1).max(64),
  networkClass: z.enum(["offline", "limited", "metered", "unmetered"]),
  inventory: z.array(inventoryEntrySchema).max(512),
  executorManifestDigest: digest,
}).strict().superRefine((value, context) => {
  value.storage.forEach((volume, index) => {
    if (volume.availableBytes > volume.capacityBytes) context.addIssue({ code: "custom", path: ["storage", index, "availableBytes"], message: "available storage exceeds capacity" });
  });
});

const metricSchema = z.object({
  quality: z.enum(["observed", "estimated", "blocked", "unavailable"]),
  value: z.number().finite().nonnegative().optional(),
}).strict().superRefine((value, context) => {
  if ((value.quality === "observed" || value.quality === "estimated") && value.value === undefined) {
    context.addIssue({ code: "custom", path: ["value"], message: "a measured metric needs a value" });
  }
  if ((value.quality === "blocked" || value.quality === "unavailable") && value.value !== undefined) {
    context.addIssue({ code: "custom", path: ["value"], message: "blocked or unavailable metric cannot claim a value" });
  }
});

export const telemetryPayloadSchema = z.object({
  samplingIntervalSeconds: z.number().int().min(1).max(3_600),
  cpuUtilizationPercent: metricSchema.refine((metric) => metric.value === undefined || metric.value <= 100, "CPU utilization exceeds 100"),
  availableMemoryBytes: metricSchema,
  availableStorageBytes: metricSchema,
  networkClass: z.enum(["offline", "limited", "metered", "unmetered", "blocked", "unavailable"]),
  powerState: z.enum(["ac", "battery", "unknown", "blocked", "unavailable"]),
  thermalState: z.enum(["nominal", "constrained", "critical", "unknown", "blocked", "unavailable"]),
}).strict();

export const capabilityPayloadSchema = z.object({
  probeId: id,
  probeVersion: label,
  outcome: z.enum(["pass", "fail", "blocked", "unavailable"]),
  reasonCode: id,
  evidenceDigest: digest.optional(),
}).strict();

export const benchmarkPayloadSchema = z.object({
  benchmarkId: id,
  benchmarkVersion: label,
  workloadDigest: digest,
  outcome: z.enum(["pass", "fail", "blocked", "unavailable"]),
  reasonCode: id,
  normalizedScore: z.number().finite().nonnegative().optional(),
  scoreUnit: id.optional(),
  environmentFingerprint: digest,
  evidenceDigest: digest.optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "pass" && (value.normalizedScore === undefined || value.scoreUnit === undefined)) {
    context.addIssue({ code: "custom", path: ["normalizedScore"], message: "a passed benchmark needs a score and unit" });
  }
  if (value.outcome !== "pass" && (value.normalizedScore !== undefined || value.scoreUnit !== undefined)) {
    context.addIssue({ code: "custom", path: ["normalizedScore"], message: "a non-passing benchmark cannot claim a score" });
  }
});

const baseSignalSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  tenantId: id,
  nodeId: id,
  sequence: z.number().int().positive(),
  observedAt: isoDate,
  expiresAt: isoDate,
  trust: trustSchema,
  fingerprint: digest,
}).strict();

export const fleetSignalEnvelopeSchema = z.discriminatedUnion("kind", [
  baseSignalSchema.extend({ kind: z.literal("discovery"), source: z.literal("static_collector"), payload: discoveryPayloadSchema }),
  baseSignalSchema.extend({ kind: z.literal("telemetry"), source: z.literal("telemetry_port"), payload: telemetryPayloadSchema }),
  baseSignalSchema.extend({ kind: z.literal("capability"), source: z.literal("probe_runner"), payload: capabilityPayloadSchema }),
  baseSignalSchema.extend({ kind: z.literal("benchmark"), source: z.literal("benchmark_runner"), payload: benchmarkPayloadSchema }),
]).superRefine((value, context) => {
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.observedAt);
  if (lifetime <= 0) context.addIssue({ code: "custom", path: ["expiresAt"], message: "signal expiry must be after observation" });
  else if (lifetime > FLEET_SIGNAL_MAX_AGE_MS_V1[value.kind]) context.addIssue({ code: "custom", path: ["expiresAt"], message: "signal lifetime exceeds the contract maximum" });
  if (value.trust === "verified") context.addIssue({ code: "custom", path: ["trust"], message: "node-submitted signals cannot self-report verified trust" });
});

export const fleetSignalContractVersionSchema = z.literal(FLEET_SIGNAL_CONTRACT_V1);

export type DiscoveryPayload = z.infer<typeof discoveryPayloadSchema>;
export type FleetSignalEnvelope = z.infer<typeof fleetSignalEnvelopeSchema>;
