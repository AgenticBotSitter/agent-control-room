import { evaluateFleetEligibility, type FleetEligibilityInput, type FleetEligibilityResult } from "./eligibility";
import { FleetSignalStore } from "./fleet-signal-store";

export type StoredFleetEligibilityInput = Omit<FleetEligibilityInput, "signals"> & {
  tenantId: string;
  nodeId: string;
};

/** Evaluates one tenant-bound node solely from persisted, authenticated fleet signals. */
export class FleetEligibilityService {
  constructor(private readonly signals: FleetSignalStore) {}

  async evaluate(input: StoredFleetEligibilityInput): Promise<FleetEligibilityResult> {
    const signals = await this.signals.current({ tenantId: input.tenantId, nodeId: input.nodeId });
    return evaluateFleetEligibility({
      now: input.now,
      signals,
      requiredScratchBytes: input.requiredScratchBytes,
      requiredCapabilityProbeId: input.requiredCapabilityProbeId,
      requireVerifiedCapability: input.requireVerifiedCapability,
      requiredBenchmarkId: input.requiredBenchmarkId,
    });
  }
}
