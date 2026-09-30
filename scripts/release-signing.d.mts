export const RELEASE_TRUST_SCHEMA_V1: "control-room.release-trust/v1";
export type ReleaseTrustV1 = Readonly<{
  schema: typeof RELEASE_TRUST_SCHEMA_V1;
  epoch: number;
  keyId: `sha256:${string}`;
  publicKey: string;
  versionFloor: string;
  revokedKeyIds: readonly `sha256:${string}`[];
}>;
export function captureReleaseTrustV1(value: unknown): ReleaseTrustV1;
export function releaseKeyIdV1(publicKey: string): `sha256:${string}`;
export function verifySignedReleaseV1(input: Readonly<{
  releaseDirectory: string;
  trust: ReleaseTrustV1;
}>): Promise<Readonly<{ verified: true; version: string; keyId: `sha256:${string}`; sumsSha256: string;
  artifacts: readonly Readonly<{ file: string; size: number; sha256: string }>[] }>>;
export function verifySignedReleaseFromTrustFileV1(input: Readonly<{
  releaseDirectory: string;
  trustPath: string;
}>, options?: Readonly<{ expectedUid?: number }>): ReturnType<typeof verifySignedReleaseV1>;
