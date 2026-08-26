import { createHash } from "node:crypto";
import type { DiscoveryPayload } from "./schemas";

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Digest only normalized material discovery facts; telemetry never participates. */
export function computeDiscoveryFingerprint(payload: DiscoveryPayload): string {
  const materialProjection = {
    platform: payload.platform,
    architecture: payload.architecture,
    cpuLogicalCores: payload.cpuLogicalCores,
    memoryBytes: payload.memoryBytes,
    gpuClasses: [...payload.gpuClasses].sort(),
    storage: payload.storage.map(({ capacityBytes, scratchEligible, encryptionReported }) => ({ capacityBytes, scratchEligible, encryptionReported })),
    networkClass: payload.networkClass,
    inventory: [...payload.inventory].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
    executorManifestDigest: payload.executorManifestDigest,
  };
  return `sha256:${createHash("sha256").update(canonicalize(materialProjection)).digest("hex")}`;
}
