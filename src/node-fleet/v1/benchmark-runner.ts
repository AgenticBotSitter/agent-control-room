import { benchmarkPayloadSchema } from "./schemas";

export interface BenchmarkObservation {
  outcome: "pass" | "fail" | "blocked" | "unavailable";
  reasonCode: string;
  normalizedScore?: number;
  scoreUnit?: string;
  evidenceDigest?: string;
}

export interface BenchmarkDefinition {
  id: string;
  version: string;
  workloadDigest: string;
  supportedPlatforms: Array<"windows" | "macos" | "linux" | "cloud">;
  requiredPrivilege: "none" | "native_evidence_required";
  run: () => Promise<BenchmarkObservation>;
}

export interface BenchmarkRunnerInput {
  platform: "windows" | "macos" | "linux" | "cloud";
  benchmarks: BenchmarkDefinition[];
}

export interface BenchmarkRunRequest {
  benchmarkId: string;
  environmentFingerprint: string;
  ownerAuthorized: boolean;
  observedAt: string;
}

function canonicalInstant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("invalid benchmark observation time");
  return value;
}

/**
 * Runs a registered workload only after its caller has supplied an explicit
 * owner authorization. It has no auto-run or discovery-triggered entrypoint.
 */
export class BenchmarkRunner {
  private readonly benchmarks = new Map<string, BenchmarkDefinition>();

  constructor(private readonly input: BenchmarkRunnerInput) {
    for (const benchmark of input.benchmarks) {
      if (this.benchmarks.has(benchmark.id)) throw new Error("duplicate benchmark id");
      this.benchmarks.set(benchmark.id, benchmark);
    }
  }

  async run(request: BenchmarkRunRequest) {
    const benchmark = this.benchmarks.get(request.benchmarkId);
    if (!benchmark) throw new Error("unknown benchmark");
    const observedAt = canonicalInstant(request.observedAt);
    const base = { benchmarkId: benchmark.id, benchmarkVersion: benchmark.version, workloadDigest: benchmark.workloadDigest, environmentFingerprint: request.environmentFingerprint };
    let observation: BenchmarkObservation;
    if (!request.ownerAuthorized) observation = { outcome: "blocked", reasonCode: "owner_authorization_required" };
    else if (!benchmark.supportedPlatforms.includes(this.input.platform)) observation = { outcome: "unavailable", reasonCode: "platform_unsupported" };
    else if (benchmark.requiredPrivilege !== "none") observation = { outcome: "blocked", reasonCode: "native_evidence_required" };
    else {
      try {
        observation = await benchmark.run();
      } catch {
        observation = { outcome: "unavailable", reasonCode: "benchmark_runtime_error" };
      }
    }
    return {
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      payload: benchmarkPayloadSchema.parse({ ...base, ...observation }),
    };
  }
}
