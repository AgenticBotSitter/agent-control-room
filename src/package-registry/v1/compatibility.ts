import type { HarnessAdapterManifestV1 } from "../../harness/v1";
import type { PackageEligibilityV1, PackageHarnessMappingInputV1, StoredPackageV1 } from "./types";

export function evaluatePackageCompatibilityV1(
  stored: StoredPackageV1,
  mapping: PackageHarnessMappingInputV1,
  manifest: HarnessAdapterManifestV1,
): PackageEligibilityV1 {
  const reasons: string[] = [];
  if (mapping.packageId !== stored.package.id || mapping.packageDigest !== stored.packageDigest) reasons.push("package_binding_mismatch");
  if (mapping.tenantId !== stored.package.tenantId || mapping.projectId !== stored.package.projectId) reasons.push("scope_mismatch");
  if (mapping.decision !== "verified") reasons.push("mapping_not_verified");
  if (mapping.adapterId !== manifest.adapterId || mapping.adapterVersion !== manifest.adapterVersion) reasons.push("adapter_version_mismatch");
  if (mapping.harness !== manifest.harness || mapping.harnessVersion !== manifest.harnessVersion) reasons.push("harness_version_mismatch");
  if (!manifest.runtime.supportedPlatforms.includes(mapping.platform)) reasons.push("platform_not_supported_by_adapter");
  const declaration = stored.package.compatibility.find((candidate) => candidate.adapterId === mapping.adapterId && candidate.adapterVersion === mapping.adapterVersion && candidate.harness === mapping.harness && candidate.harnessVersion === mapping.harnessVersion);
  if (!declaration) reasons.push("package_compatibility_not_declared");
  else {
    if (!declaration.supportedPlatforms.includes(mapping.platform)) reasons.push("platform_not_declared");
    const expected=[...declaration.requiredVerbs].sort(); const verified=[...mapping.verifiedVerbs].sort();
    if (expected.join("|")!==verified.join("|") || verified.some((verb)=>!manifest.supportedVerbs.includes(verb))) reasons.push("verified_verb_set_mismatch");
  }
  return {
    packageId: stored.package.id, packageDigest: stored.packageDigest, adapterId: mapping.adapterId, adapterVersion: mapping.adapterVersion,
    platform: mapping.platform, instructionCompatible: reasons.length === 0, reasons, grantsAuthority: false, canExecuteWithoutAuthority: false,
  };
}
