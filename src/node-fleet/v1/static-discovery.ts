import { computeDiscoveryFingerprint } from "./fingerprint";
import { discoveryPayloadSchema, type DiscoveryPayload } from "./schemas";

/**
 * The platform-specific reader belongs outside this module. It may pass only
 * already-approved aggregate facts here; host identity, paths, addresses, and
 * command output have no representable field and are rejected by the schema.
 */
export interface StaticDiscoveryInput {
  platform: DiscoveryPayload["platform"];
  architecture: string;
  cpuLogicalCores: number;
  memoryBytes: number;
  gpuClasses: string[];
  storage: DiscoveryPayload["storage"];
  networkClass: DiscoveryPayload["networkClass"];
  inventory: DiscoveryPayload["inventory"];
  executorManifestDigest: string;
}

export interface StaticDiscoveryResult {
  payload: DiscoveryPayload;
  fingerprint: string;
}

export function normalizeStaticDiscovery(input: StaticDiscoveryInput): StaticDiscoveryResult {
  const payload = discoveryPayloadSchema.parse({
    platform: input.platform,
    architecture: input.architecture,
    cpuLogicalCores: input.cpuLogicalCores,
    memoryBytes: input.memoryBytes,
    gpuClasses: [...input.gpuClasses].sort(),
    storage: input.storage.map((volume) => ({
      capacityBytes: volume.capacityBytes,
      availableBytes: volume.availableBytes,
      scratchEligible: volume.scratchEligible,
      encryptionReported: volume.encryptionReported,
    })),
    networkClass: input.networkClass,
    inventory: [...input.inventory]
      .map((entry) => ({ kind: entry.kind, id: entry.id, version: entry.version, manifestDigest: entry.manifestDigest }))
      .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
    executorManifestDigest: input.executorManifestDigest,
  });
  return { payload, fingerprint: computeDiscoveryFingerprint(payload) };
}
