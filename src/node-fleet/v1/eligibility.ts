import type { FleetSignalEnvelope } from "./schemas";
import { evaluateFleetSignalFreshness } from "./freshness";

export type FleetEligibilityReason =
  | "signal_identity_mismatch"
  | "telemetry_missing"
  | "telemetry_stale"
  | "scratch_insufficient"
  | "capability_missing"
  | "capability_expired"
  | "capability_unverified"
  | "benchmark_missing"
  | "benchmark_expired"
  | "benchmark_environment_mismatch";

export interface FleetEligibilityInput {
  now: string;
  signals: FleetSignalEnvelope[];
  requiredScratchBytes: number;
  requiredCapabilityProbeId?: string;
  requireVerifiedCapability?: boolean;
  requiredBenchmarkId?: string;
}

export interface FleetEligibilityResult {
  eligible: boolean;
  reasons: FleetEligibilityReason[];
}

function latest<T extends FleetSignalEnvelope>(signals: T[]): T | undefined {
  return [...signals].sort((left, right) => right.sequence - left.sequence)[0];
}

function currentUsable(signal: FleetSignalEnvelope, now: string): boolean {
  return (signal.trust === "reported" || signal.trust === "verified")
    && evaluateFleetSignalFreshness(signal, now).eligible;
}

/** A total, effect-free policy function for a single node's current signals. */
export function evaluateFleetEligibility(input: FleetEligibilityInput): FleetEligibilityResult {
  const identities = new Set(input.signals.map((signal) => `${signal.tenantId}\u0000${signal.nodeId}`));
  if (identities.size > 1) return { eligible: false, reasons: ["signal_identity_mismatch"] };
  const reasons: FleetEligibilityReason[] = [];
  const telemetry = latest(input.signals.filter((signal) => signal.kind === "telemetry"));
  if (!telemetry || telemetry.trust === "blocked" || telemetry.trust === "unavailable") reasons.push("telemetry_missing");
  else if (!currentUsable(telemetry, input.now)) reasons.push("telemetry_stale");
  else if (telemetry.payload.availableStorageBytes.quality !== "observed" || (telemetry.payload.availableStorageBytes.value ?? 0) < input.requiredScratchBytes) reasons.push("scratch_insufficient");

  if (input.requiredCapabilityProbeId) {
    const capability = latest(input.signals.filter((signal): signal is Extract<FleetSignalEnvelope, { kind: "capability" }> => signal.kind === "capability" && signal.payload.probeId === input.requiredCapabilityProbeId));
    if (!capability || capability.payload.outcome !== "pass" || capability.trust === "blocked" || capability.trust === "unavailable") reasons.push("capability_missing");
    else if (!currentUsable(capability, input.now)) reasons.push("capability_expired");
    else if (input.requireVerifiedCapability && capability.trust !== "verified") reasons.push("capability_unverified");
  }
  if (input.requiredBenchmarkId) {
    const benchmark = latest(input.signals.filter((signal): signal is Extract<FleetSignalEnvelope, { kind: "benchmark" }> => signal.kind === "benchmark" && signal.payload.benchmarkId === input.requiredBenchmarkId));
    if (!benchmark || benchmark.payload.outcome !== "pass" || benchmark.trust === "blocked" || benchmark.trust === "unavailable") reasons.push("benchmark_missing");
    else if (!currentUsable(benchmark, input.now)) reasons.push("benchmark_expired");
    else {
      const discovery = latest(input.signals.filter((signal): signal is Extract<FleetSignalEnvelope, { kind: "discovery" }> => signal.kind === "discovery"));
      if (!discovery || !currentUsable(discovery, input.now) || benchmark.payload.environmentFingerprint !== discovery.fingerprint) reasons.push("benchmark_environment_mismatch");
    }
  }
  return { eligible: reasons.length === 0, reasons };
}
