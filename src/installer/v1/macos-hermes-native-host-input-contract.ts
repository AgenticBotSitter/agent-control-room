import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";
import { parseMacosHermesCliReleaseSidecarContractV1 } from "./macos-hermes-cli-release-sidecar-contract";
import { verifyMacosHermesRuntimeImageManifestV1 } from "./macos-hermes-runtime-image-manifest";
import { parseMacosHermesRuntimeImportPolicyV1 } from "./macos-hermes-runtime-import-policy";

const names = ["architecture", "releaseSha256", "sidecarContract", "runtimeManifest", "importPolicy",
  "observedEntries", "runtimeImageSha256"] as const;

function refuse(): never {
  const error = new Error("macos_hermes_native_host_input_contract_refused");
  error.stack = undefined;
  throw error;
}

/**
 * Pure preflight for a future native host. Observations and expected digests
 * are caller data, not proof of protected filesystem custody. A successful
 * join checks consistency only and cannot authorize packaging or execution.
 * There is deliberately no executable, runtime, profile, model or workdir input.
 */
export function prepareMacosHermesNativeHostInputContractV1(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) refuse();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key as typeof names[number]))) refuse();
  const input: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) refuse();
    input[name] = descriptor.value;
  }
  // Reuse the existing strict parsers rather than accepting structural claims.
  const contract = parseMacosHermesCliReleaseSidecarContractV1(input.sidecarContract);
  const manifest = verifyMacosHermesRuntimeImageManifestV1({
    manifest: input.runtimeManifest, observedEntries: input.observedEntries,
    runtimeImageSha256: input.runtimeImageSha256,
  });
  const policy = parseMacosHermesRuntimeImportPolicyV1(input.importPolicy);
  if (input.architecture !== contract.architecture || manifest.architecture !== contract.architecture
    || policy.architecture !== contract.architecture || input.releaseSha256 !== contract.releaseSha256
    || contract.runtimePackaging.runtimeImageSha256 !== manifest.runtimeImageSha256
    || contract.runtimePackaging.runtimeManifestSha256 !== manifest.manifestDigest
    || policy.inventories.runtimeImageManifestDigest !== manifest.manifestDigest) refuse();
  const material = {
    schema: "control-room.macos-hermes-native-host-input-contract/v1" as const,
    platform: contract.platform,
    architecture: contract.architecture,
    releaseVersion: contract.releaseVersion,
    releaseSha256: contract.releaseSha256,
    sidecarContractDigest: contract.contractDigest,
    runtimeImageSha256: manifest.runtimeImageSha256,
    runtimeManifestDigest: manifest.manifestDigest,
    importPolicyDigest: policy.policyDigest,
    nativeHostArtifactSha256: contract.nativeHost.artifactSha256,
    nativeHostSourceSha256: contract.nativeHost.sourceSha256,
    protocol: contract.nativeHost.protocol,
    status: "input_consistency_only" as const,
    readyForLaunch: false as const,
    filesystemCustodyVerified: false as const,
    grantsLaunchAuthority: false as const,
    grantsPackagingAuthority: false as const,
    blockerCodes: Object.freeze([
      ...contract.blockerCodes,
      "runtime_import_policy_incompatible" as const,
    ]),
  };
  return Object.freeze({ ...material, bindingDigest: sha256Digest(material) });
}
