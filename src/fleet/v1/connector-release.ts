export const FLEET_CONNECTOR_RELEASE_SCHEMA_V1 = "control-room.fleet-connector-release/v1";

export type FleetConnectorReleaseManifestV1 = Readonly<{
  schema: typeof FLEET_CONNECTOR_RELEASE_SCHEMA_V1;
  version: string;
  file: string;
  sha256: string;
  size: number;
  builtFrom: string;
}>;

const versionPattern = /^\d+\.\d+\.\d+$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;

export function captureFleetConnectorReleaseManifestV1(value: unknown): FleetConnectorReleaseManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fleet_connector_release_refused");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "builtFrom,file,schema,sha256,size,version"
    || input.schema !== FLEET_CONNECTOR_RELEASE_SCHEMA_V1 || typeof input.version !== "string"
    || !versionPattern.test(input.version) || input.file !== `connector-${input.version}.mjs`
    || typeof input.sha256 !== "string" || !digestPattern.test(input.sha256)
    || !Number.isSafeInteger(input.size) || (input.size as number) < 1 || (input.size as number) > 16 * 1024 * 1024
    || typeof input.builtFrom !== "string" || !commitPattern.test(input.builtFrom))
    throw new Error("fleet_connector_release_refused");
  return Object.freeze({ schema: FLEET_CONNECTOR_RELEASE_SCHEMA_V1, version: input.version,
    file: input.file, sha256: input.sha256, size: input.size, builtFrom: input.builtFrom } as FleetConnectorReleaseManifestV1);
}
