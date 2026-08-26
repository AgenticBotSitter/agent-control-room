import { capabilityPayloadSchema } from "./schemas";

export type CapabilityProbeOutcome = "pass" | "fail" | "blocked" | "unavailable";

export interface CapabilityProbeObservation {
  outcome: CapabilityProbeOutcome;
  reasonCode: string;
  evidenceDigest?: string;
}

export interface CapabilityProbeDefinition {
  id: string;
  version: string;
  supportedPlatforms: Array<"windows" | "macos" | "linux" | "cloud">;
  requiredPrivilege: "none" | "native_evidence_required";
  evaluate: () => Promise<CapabilityProbeObservation>;
}

export interface CapabilityProbeRunnerInput {
  platform: "windows" | "macos" | "linux" | "cloud";
  probes: CapabilityProbeDefinition[];
}

/**
 * Runs only registered, no-privilege probe functions. It has no command,
 * process, network, filesystem, service, or privilege-escalation interface.
 */
export class CapabilityProbeRunner {
  private readonly probes = new Map<string, CapabilityProbeDefinition>();

  constructor(private readonly input: CapabilityProbeRunnerInput) {
    for (const probe of input.probes) {
      if (this.probes.has(probe.id)) throw new Error("duplicate capability probe id");
      this.probes.set(probe.id, probe);
    }
  }

  async run(probeId: string) {
    const probe = this.probes.get(probeId);
    if (!probe) throw new Error("unknown capability probe");
    if (!probe.supportedPlatforms.includes(this.input.platform)) {
      return capabilityPayloadSchema.parse({ probeId: probe.id, probeVersion: probe.version, outcome: "unavailable", reasonCode: "platform_unsupported" });
    }
    if (probe.requiredPrivilege !== "none") {
      return capabilityPayloadSchema.parse({ probeId: probe.id, probeVersion: probe.version, outcome: "blocked", reasonCode: "native_evidence_required" });
    }
    try {
      const observation = await probe.evaluate();
      return capabilityPayloadSchema.parse({ probeId: probe.id, probeVersion: probe.version, ...observation });
    } catch {
      return capabilityPayloadSchema.parse({ probeId: probe.id, probeVersion: probe.version, outcome: "unavailable", reasonCode: "probe_runtime_error" });
    }
  }
}
