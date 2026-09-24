import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";
import { prepareMacosHermesNativeHostInputContractV1 } from "./macos-hermes-native-host-input-contract";
import { parseMacosHermesRuntimeImageManifestV1 } from "./macos-hermes-runtime-image-manifest";

function refuse(): never {
  throw new Error("macos_hermes_restricted_home_preflight_refused");
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) refuse();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) refuse();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !("value" in property)) refuse();
    result[key] = property.value;
  }
  return result;
}

/** Pure inspection of supplied inventories. Does not inspect or create a home,
 * read credentials, execute Python, or turn inventory statements into custody. */
export function prepareMacosHermesRestrictedHomePreflightV1(value: unknown) {
  const input = record(value, ["nativeHostInput", "executionHomeEntries"]);
  const binding = prepareMacosHermesNativeHostInputContractV1(input.nativeHostInput);
  const host = record(input.nativeHostInput, ["architecture", "releaseSha256", "sidecarContract",
    "runtimeManifest", "importPolicy", "observedEntries", "runtimeImageSha256"]);
  const manifest = parseMacosHermesRuntimeImageManifestV1(host.runtimeManifest);
  const home = input.executionHomeEntries;
  if (!Array.isArray(home) || types.isProxy(home) || Object.getPrototypeOf(home) !== Array.prototype
    || Object.getOwnPropertySymbols(home).length || home.length > 2
    || Object.getOwnPropertyNames(home).length !== home.length + 1) refuse();
  const seen = new Set<string>();
  for (let i = 0; i < home.length; i += 1) {
    const property = Object.getOwnPropertyDescriptor(home, String(i));
    if (!property || !("value" in property) || !property.enumerable) refuse();
    const entry = record(property.value, ["path", "kind", "mode"]);
    if ((entry.path !== "logs" && entry.path !== "sessions") || entry.kind !== "directory"
      || entry.mode !== "0700" || seen.has(entry.path)) refuse();
    seen.add(entry.path);
  }
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  const roots = ["python/lib/python3.11", "python/lib/python3.11/lib-dynload",
    "runtime/hermes", "runtime/dependencies"];
  for (const root of roots) if (entries.get(root)?.kind !== "directory") refuse();
  for (const path of ["python/bin/python3.11", "runtime/hermes/hermes_cli/main.py",
    "runtime/hermes/hermes_cli/_early_recovery.py", "runtime/hermes/cli.py",
    "runtime/dependencies/openai/_base_client.py"])
    if (entries.get(path)?.kind !== "regular_file") refuse();
  // No symlink entries can survive the existing manifest parser. Reject
  // known bootstrap triggers and site hooks even when recorded as plain files.
  for (const entry of manifest.entries) {
    const parts = entry.path.split("/");
    if (parts.some(part => [".update-incomplete", ".lazy-refresh-incomplete", ".env",
      "sitecustomize.py", "usercustomize.py"].includes(part)
      || part.endsWith(".pth") || part.endsWith(".egg-link"))) refuse();
  }
  const result = {
    schema: "control-room.macos-hermes-restricted-home-preflight/v1" as const,
    nativeHostBindingDigest: binding.bindingDigest,
    executionHomeInventoryDigest: sha256Digest([...seen].sort()),
    bootstrapRootClassification: "exact_image_internal_parent" as const,
    reviewedMetaPathTarget: "openai._base_client" as const,
    status: "inventory_consistency_only" as const,
    filesystemCustodyVerified: false as const,
    readyForLaunch: false as const,
    grantsLaunchAuthority: false as const,
    grantsPackagingAuthority: false as const,
    blockerCodes: Object.freeze(["native_filesystem_custody_unproven",
      "runtime_import_policy_incompatible", "entry_point_plugin_closure_unproven",
      "restricted_execution_home_runtime_unproven"] as const),
  };
  return Object.freeze({ ...result, preflightDigest: sha256Digest(result) });
}
