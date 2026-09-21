export type LocalInstallationReleaseReportV1 = Readonly<{
  schema: "control-room.local-installation-package-preparation/v1";
  mode: "dry-run";
  bundle: Readonly<{
    state: "fingerprinted" | "matched_expected_digest";
    version: string;
    fileCount: number;
    byteCount: number;
    digest: `sha256:${string}`;
    authenticityVerified: false;
  }>;
  service: Readonly<{ state: "awaiting_owner_setup" | "validated_not_installed" }>;
  readyForOwnerSetup: true;
  startsService: false;
  createsDatabase: false;
  writesCredentials: false;
  nextSteps: readonly string[];
}>;

export function prepareLocalInstallationReleaseV1(input: Readonly<{
  releaseRoot: string;
  expectedDigest?: `sha256:${string}`;
  serviceState?: "validated_not_installed";
}>): Promise<LocalInstallationReleaseReportV1>;
