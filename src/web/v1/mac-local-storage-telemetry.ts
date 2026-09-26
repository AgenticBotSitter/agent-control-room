import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { evaluateFleetEligibility } from "../../node-fleet/v1/eligibility";
import type { FleetSignalEnvelope } from "../../node-fleet/v1/schemas";

type StorageMetric = Readonly<{ quality: "observed"; value: number } | { quality: "unavailable" }>;

/** Measure the actual result-artifact volume. An error or unsafe number can
 * never become assignment permission, even when scratch demand is zero. */
export async function measureMacLocalArtifactStorageV1(protectedRoot: string,
  measure: typeof statfs = statfs): Promise<StorageMetric> {
  try {
    const result = await measure(join(protectedRoot, "runtime", "artifacts"), { bigint: true });
    const bytes = result.bavail * result.bsize;
    if (bytes < BigInt(0) || bytes > BigInt(Number.MAX_SAFE_INTEGER)) return { quality: "unavailable" };
    return { quality: "observed", value: Number(bytes) };
  } catch { return { quality: "unavailable" }; }
}

/** Kept beside the sampler so failure-mode tests exercise the real assignment
 * rule, not a second, more lenient local rule. */
export function macLocalStorageAllowsAssignmentV1(signal: FleetSignalEnvelope, now: string): boolean {
  return evaluateFleetEligibility({ signals: [signal], now, requiredScratchBytes: 0 }).eligible;
}
