import { preflightMacosLocalServiceV1 } from "../../harness/v1/macos-local-service-preflight";
import { prepareLocalInstallationReleaseV1,
  type LocalInstallationReleaseReportV1 } from "./local-installation-release.mjs";

export type LocalInstallationPreparationReportV1 = LocalInstallationReleaseReportV1;

/**
 * Adds the existing owner-attended macOS service preflight result to the
 * standalone release inventory. The public release command never reads this
 * private definition; the future owner setup flow owns that boundary.
 */
export async function prepareLocalInstallationPackageV1(input: Readonly<{
  releaseRoot: string;
  expectedDigest?: `sha256:${string}`;
  serviceDefinition?: unknown;
  ownerAttended?: true;
}>): Promise<LocalInstallationPreparationReportV1> {
  if (input.serviceDefinition === undefined) return prepareLocalInstallationReleaseV1({
    releaseRoot: input.releaseRoot, ...(input.expectedDigest ? { expectedDigest: input.expectedDigest } : {}) });
  if (input.ownerAttended !== true) throw new Error("local_installation_package_refused");
  await preflightMacosLocalServiceV1(input.serviceDefinition);
  return prepareLocalInstallationReleaseV1({ releaseRoot: input.releaseRoot,
    ...(input.expectedDigest ? { expectedDigest: input.expectedDigest } : {}), serviceState: "validated_not_installed" });
}
