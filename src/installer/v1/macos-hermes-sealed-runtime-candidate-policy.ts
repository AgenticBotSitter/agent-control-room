import { types } from "node:util";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { parseMacosHermesRuntimeImportPolicyV1,
  type MacosHermesRuntimeImportPolicyV1 } from "./macos-hermes-runtime-import-policy";
import { prepareMacosHermesRestrictedHomePreflightV1 } from "./macos-hermes-restricted-home-preflight";

export const MACOS_HERMES_SEALED_RUNTIME_CANDIDATE_POLICY_V1 =
  "control-room.macos-hermes-sealed-runtime-candidate-policy/v1" as const;

function refuse(): never {
  const error = new Error("macos_hermes_sealed_runtime_candidate_policy_refused");
  error.stack = undefined;
  throw error;
}

function material(baselinePolicy: MacosHermesRuntimeImportPolicyV1,
  nativeHostBindingDigest: string, restrictedHomePreflightDigest: string) {
  return {
    schema: MACOS_HERMES_SEALED_RUNTIME_CANDIDATE_POLICY_V1,
    baselinePolicy,
    nativeHostBindingDigest,
    restrictedHomePreflightDigest,
    reviewedExceptions: {
      rootMutations: [
        { source: "runtime/hermes/hermes_cli/main.py", operation: "conditional_prepend_realpath_parent",
          target: "runtime/hermes" },
        { source: "runtime/hermes/hermes_cli/_startup_fast.py", callable: "ensure_project_root_on_path",
          operation: "remove_realpath_equivalent_entries_then_prepend", target: "runtime/hermes" },
      ],
      metaPathHook: {
        source: "runtime/hermes/cli.py", finder: "_AsyncHttpxDelNeuter", targetModule: "openai._base_client",
        requiredResolvedTarget: "runtime/dependencies/openai/_base_client.py",
        removesSelfBeforeDelegation: true, delegatesOrdinaryResolution: true,
        replacementTarget: "AsyncHttpxClientWrapper.__del__",
      },
      requiresImmutableImageCustody: true,
      acceptsCallerSelectedRootsOrHooks: false,
    },
    status: "candidate_policy_only",
    compatibleWithExistingImportPolicy: false,
    readyForLaunch: false,
    grantsImageAuthority: false,
    grantsProcessAuthority: false,
    grantsInstallAuthority: false,
    grantsQualificationAuthority: false,
    grantsLaunchAuthority: false,
    grantsPackagingAuthority: false,
    blockerCodes: ["native_filesystem_custody_unproven", "runtime_import_policy_incompatible",
      "bootstrap_install_or_repair", "entry_point_plugin_closure_unproven",
      "dynamic_file_loading_closure_unproven", "native_library_closure_unproven",
      "restricted_execution_home_runtime_unproven", "resolved_openai_hook_target_unproven"],
  } as const;
}

type Material = ReturnType<typeof material>;
export type MacosHermesSealedRuntimeCandidatePolicyV1 = Material & Readonly<{ policyDigest: string }>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Compare inert data through descriptors, never invoking a caller's accessor
// or proxy. Exact keys and array lengths also reject hidden/symbol extensions.
function matches(value: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object") return value === expected;
  if (!value || typeof value !== "object" || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.getPrototypeOf(expected)
    || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(expected);
  if (Object.getOwnPropertyNames(value).length !== keys.length) return false;
  return keys.every(key => {
    const actual = Object.getOwnPropertyDescriptor(value, key);
    const wanted = Object.getOwnPropertyDescriptor(expected, key)!;
    return actual && "value" in actual && actual.enumerable === wanted.enumerable
      && matches(actual.value, wanted.value);
  });
}

/** Pure source-review statement. Its inventories are unverified claims, and
 * its exact exceptions never grant custody, packaging, or execution authority.
 * The existing import policy and native-host contract remain unchanged. */
export function buildMacosHermesSealedRuntimeCandidatePolicyV1(value: unknown):
MacosHermesSealedRuntimeCandidatePolicyV1 {
  const preflight = prepareMacosHermesRestrictedHomePreflightV1(value);
  // The existing preflight already checks these exact plain-data properties.
  const input = value as { nativeHostInput: { importPolicy: unknown } };
  const body = material(parseMacosHermesRuntimeImportPolicyV1(input.nativeHostInput.importPolicy),
    preflight.nativeHostBindingDigest, preflight.preflightDigest);
  return freeze({ ...body, policyDigest: sha256Digest(body) });
}

export function parseMacosHermesSealedRuntimeCandidatePolicyV1(value: unknown):
MacosHermesSealedRuntimeCandidatePolicyV1 {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) refuse();
  const descriptor = Object.getOwnPropertyDescriptor(value, "baselinePolicy");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) refuse();
  function binding(name: string): string {
    const property = Object.getOwnPropertyDescriptor(value!, name);
    if (!property || !property.enumerable || !("value" in property)
      || typeof property.value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(property.value)) refuse();
    return property.value;
  }
  // Parsing proves only a consistent saved statement, not possession of the
  // inventories or native custody. Only the builder performs the pure join.
  const body = material(parseMacosHermesRuntimeImportPolicyV1(descriptor.value),
    binding("nativeHostBindingDigest"), binding("restrictedHomePreflightDigest"));
  const expected = { ...body, policyDigest: sha256Digest(body) };
  if (!matches(value, expected)) refuse();
  return freeze(expected);
}

export function serializeMacosHermesSealedRuntimeCandidatePolicyV1(value: unknown): string {
  return `${canonicalJson(parseMacosHermesSealedRuntimeCandidatePolicyV1(value))}\n`;
}
