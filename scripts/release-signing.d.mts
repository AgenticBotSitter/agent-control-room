export const RELEASE_TRUST_SCHEMA_V1: "control-room.release-trust/v1";
export type ReleaseTrustV1 = Readonly<{
  schema: typeof RELEASE_TRUST_SCHEMA_V1;
  epoch: number;
  keyId: `sha256:${string}`;
  publicKey: string;
  versionFloor: string;
  revokedKeyIds: readonly `sha256:${string}`[];
}>;
export type ConnectorReleaseAdvertisementV1 = Readonly<{
  version: string;
  file: string;
  sha256: string;
  size: number;
  builtFrom: string;
  minVersion: string;
  signature: string;
}>;
export function captureReleaseTrustV1(value: unknown): ReleaseTrustV1;
export function releaseKeyIdV1(publicKey: string): `sha256:${string}`;
export function generateInstallationReleaseKeyV1(input: Readonly<{
  protectedRoot: string;
  gatewayConfigPath?: string;
  versionFloor: string;
}>, options?: Readonly<{ expectedUid?: number; fault?: (stage: string) => void | Promise<void> }>): Promise<Readonly<{
  schema: string; privateKeyPath: string; configPath: string; trustPath: string; trust: ReleaseTrustV1;
}>>;
export function connectorReleaseSignatureMaterialV1(
  value: Omit<ConnectorReleaseAdvertisementV1, "signature"> & Readonly<{ signature?: string }>,
): Buffer;
export function signConnectorReleaseAdvertisementV1(
  value: Omit<ConnectorReleaseAdvertisementV1, "signature"> & Readonly<{ signature?: string }>,
  privateKeyPath: string,
  options?: Readonly<{ expectedUid?: number }>,
): Promise<ConnectorReleaseAdvertisementV1>;
export function signReleaseArtifactsV1(input: Readonly<{
  releaseDirectory: string; version: string; configPath: string; connectorPath: string;
  connectorManifestPath: string; connectorMinVersion: string; updaterPath: string; webManifestPath: string;
}>, options?: Readonly<{ expectedUid?: number; fault?: (stage: string) => void | Promise<void> }>): Promise<Readonly<{
  releaseDirectory: string; version: string; keyId: `sha256:${string}`; sumsSha256: string;
  artifacts: readonly Readonly<{ role: string; path: string; file: string; size: number; sha256: string }>[];
  connector: ConnectorReleaseAdvertisementV1;
}>>;
export function verifyConnectorReleaseAdvertisementV1(
  value: unknown,
  trust: ReleaseTrustV1 | string,
  requiredFloor?: string,
): ConnectorReleaseAdvertisementV1;
export function verifySignedReleaseV1(input: Readonly<{
  releaseDirectory: string;
  trust: ReleaseTrustV1;
  installedVersion: string;
  expectedBuiltFrom: string;
  allowRollback?: boolean;
  expectedUid?: number;
}>): Promise<Readonly<{ verified: true; version: string; builtFrom: string; keyId: `sha256:${string}`; sumsSha256: string;
  artifacts: readonly Readonly<{ file: string; size: number; sha256: string }>[] }>>;
export function verifySignedReleaseFromTrustFileV1(input: Readonly<{
  releaseDirectory: string;
  trustPath: string;
  installedVersion: string;
  expectedBuiltFrom: string;
  allowRollback?: boolean;
}>, options?: Readonly<{ expectedUid?: number }>): ReturnType<typeof verifySignedReleaseV1>;
export function raiseReleaseTrustFloorV1(input: Readonly<{
  trustPath: string;
  installedVersion: string;
}>, options?: Readonly<{ expectedUid?: number; attempts?: number }>): Promise<ReleaseTrustV1>;
