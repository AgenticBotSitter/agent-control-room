import { telemetryPayloadSchema } from "./schemas";

export interface TelemetrySampleInput {
  observedAt: string;
  samplingIntervalSeconds: number;
  cpuUtilizationPercent: { quality: "observed" | "estimated" | "blocked" | "unavailable"; value?: number };
  availableMemoryBytes: { quality: "observed" | "estimated" | "blocked" | "unavailable"; value?: number };
  availableStorageBytes: { quality: "observed" | "estimated" | "blocked" | "unavailable"; value?: number };
  networkClass: "offline" | "limited" | "metered" | "unmetered" | "blocked" | "unavailable";
  powerState: "ac" | "battery" | "unknown" | "blocked" | "unavailable";
  thermalState: "nominal" | "constrained" | "critical" | "unknown" | "blocked" | "unavailable";
}

export interface NormalizedTelemetrySample {
  observedAt: string;
  expiresAt: string;
  payload: ReturnType<typeof telemetryPayloadSchema.parse>;
}

function canonicalInstant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("invalid telemetry observation time");
  return value;
}

/**
 * Normalizes a fixed telemetry vector. It performs no sampling itself and
 * drops any undeclared caller fields before returning the safe payload.
 */
export function normalizeTelemetrySample(input: TelemetrySampleInput): NormalizedTelemetrySample {
  const observedAt = canonicalInstant(input.observedAt);
  const payload = telemetryPayloadSchema.parse({
    samplingIntervalSeconds: input.samplingIntervalSeconds,
    cpuUtilizationPercent: input.cpuUtilizationPercent,
    availableMemoryBytes: input.availableMemoryBytes,
    availableStorageBytes: input.availableStorageBytes,
    networkClass: input.networkClass,
    powerState: input.powerState,
    thermalState: input.thermalState,
  });
  const lifetimeSeconds = Math.min(payload.samplingIntervalSeconds * 3, 300);
  return { observedAt, expiresAt: new Date(Date.parse(observedAt) + lifetimeSeconds * 1_000).toISOString(), payload };
}
