import { types } from "node:util";
import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1 } from
  "../../harness/hermes-021-v1/connector-profile";

export const MACOS_HERMES_RUNTIME_IMPORT_POLICY_V1 =
  "control-room.macos-hermes-runtime-import-policy/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const architecture = z.enum(["arm64", "x64"]);

const bootstrapSchema = z.object({
  kind: z.literal("cpython_isolated_config"),
  interpreterEntry: z.literal("python/bin/python3.11"),
  consoleScript: z.literal("hermes"),
  callable: z.literal("hermes_cli.main:main"),
  isolated: z.literal(true),
  useEnvironment: z.literal(false),
  importSite: z.literal(false),
  useUserSite: z.literal(false),
  writeBytecode: z.literal(false),
  moduleSearchPathsSet: z.literal(true),
}).strict();

const moduleRootSchema = z.object({
  role: z.enum(["standard_library", "extension_modules", "hermes_application", "dependencies"]),
  imageRelativePath: z.enum([
    "python/lib/python3.11",
    "python/lib/python3.11/lib-dynload",
    "runtime/hermes",
    "runtime/dependencies",
  ]),
  permitsPathMutation: z.literal(false),
}).strict();

const importBoundarySchema = z.object({
  acceptsExternalModuleRoots: z.literal(false),
  acceptsPythonPath: z.literal(false),
  acceptsUserSite: z.literal(false),
  acceptsCurrentDirectory: z.literal(false),
  acceptsPthFiles: z.literal(false),
  acceptsEditableInstallHooks: z.literal(false),
  acceptsMetaPathHooks: z.literal(false),
  acceptsPathHooks: z.literal(false),
  acceptsPlugins: z.literal(false),
  acceptsDynamicFileLoaders: z.literal(false),
  acceptsBootstrapInstallOrRepair: z.literal(false),
  acceptsCredentialsProfilesMemoriesSkills: z.literal(false),
}).strict();

const sourceReviewSchema = z.object({
  entryPointVerified: z.literal(true),
  pythonRequirementVerified: z.literal(true),
  licenseVerified: z.literal(true),
  safeModeAndLazyInstallArePartialMitigationsOnly: z.literal(true),
  providerDiscoveryRemainsReachable: z.literal(true),
  bootstrapImportsRecoveryHook: z.literal(true),
  bootstrapMutatesSysPath: z.literal(true),
  bootstrapCanInstallOrRepairDependencies: z.literal(true),
  bootstrapRecoveryMarkersRemainRelevant: z.literal(true),
  profileEnvironmentCanSelectRuntimeState: z.literal(true),
  runtimeInstallsMetaPathHook: z.literal(true),
  runtimeDiscoversUserProjectAndEntryPointPlugins: z.literal(true),
  compatibleWithPolicy: z.literal(false),
  blockers: z.tuple([
    z.literal("provider_discovery"),
    z.literal("bootstrap_import_hook"),
    z.literal("bootstrap_sys_path_mutation"),
    z.literal("bootstrap_install_or_repair"),
    z.literal("bootstrap_recovery_markers"),
    z.literal("profile_environment"),
    z.literal("runtime_meta_path_hook"),
    z.literal("runtime_plugin_discovery"),
  ]),
}).strict();

const inventorySchema = z.object({
  runtimeImageManifestDigest: digest,
  dependencyInventoryDigest: digest,
  nativeLibraryInventoryDigest: digest,
  licenseInventoryDigest: digest,
}).strict();

const policySchema = z.object({
  schema: z.literal(MACOS_HERMES_RUNTIME_IMPORT_POLICY_V1),
  platform: z.literal("darwin"),
  architecture,
  pythonAbi: z.literal("cp311"),
  hermesVersion: z.literal(HERMES_021_VERSION_V1),
  hermesSourceRevision: z.literal(HERMES_021_SOURCE_REVISION_V1),
  bootstrap: bootstrapSchema,
  moduleRoots: z.tuple([moduleRootSchema, moduleRootSchema, moduleRootSchema, moduleRootSchema]),
  importBoundary: importBoundarySchema,
  inventories: inventorySchema,
  sourceReview: sourceReviewSchema,
  status: z.literal("policy_only"),
  grantsImageAuthority: z.literal(false),
  grantsProcessAuthority: z.literal(false),
  grantsInstallAuthority: z.literal(false),
  grantsQualificationAuthority: z.literal(false),
  realWorkerLaunchReady: z.literal(false),
  grantsWorkerLaunchAuthority: z.literal(false),
  policyDigest: digest,
}).strict();

export type MacosHermesRuntimeImportPolicyV1 = Readonly<z.infer<typeof policySchema>>;

const inputNames = ["architecture", "dependencyInventoryDigest", "licenseInventoryDigest",
  "nativeLibraryInventoryDigest", "runtimeImageManifestDigest"] as const;
const policyNames = ["architecture", "bootstrap", "grantsImageAuthority", "grantsInstallAuthority",
  "grantsProcessAuthority", "grantsQualificationAuthority", "grantsWorkerLaunchAuthority", "hermesSourceRevision", "hermesVersion",
  "importBoundary", "inventories", "moduleRoots", "platform", "policyDigest", "pythonAbi", "schema",
  "realWorkerLaunchReady", "sourceReview", "status"] as const;
const bootstrapNames = ["callable", "consoleScript", "importSite", "interpreterEntry", "isolated", "kind",
  "moduleSearchPathsSet", "useEnvironment", "useUserSite", "writeBytecode"] as const;
const moduleRootNames = ["imageRelativePath", "permitsPathMutation", "role"] as const;
const importBoundaryNames = ["acceptsBootstrapInstallOrRepair", "acceptsCredentialsProfilesMemoriesSkills",
  "acceptsCurrentDirectory", "acceptsDynamicFileLoaders", "acceptsEditableInstallHooks",
  "acceptsExternalModuleRoots", "acceptsMetaPathHooks", "acceptsPathHooks", "acceptsPlugins", "acceptsPthFiles",
  "acceptsPythonPath", "acceptsUserSite"] as const;
const inventoryNames = ["dependencyInventoryDigest", "licenseInventoryDigest", "nativeLibraryInventoryDigest",
  "runtimeImageManifestDigest"] as const;
const sourceReviewNames = ["blockers", "bootstrapCanInstallOrRepairDependencies", "bootstrapImportsRecoveryHook",
  "bootstrapMutatesSysPath", "bootstrapRecoveryMarkersRemainRelevant", "compatibleWithPolicy", "entryPointVerified",
  "licenseVerified", "profileEnvironmentCanSelectRuntimeState", "providerDiscoveryRemainsReachable",
  "pythonRequirementVerified", "runtimeDiscoversUserProjectAndEntryPointPlugins", "runtimeInstallsMetaPathHook",
  "safeModeAndLazyInstallArePartialMitigationsOnly"] as const;

function refuse(): never {
  const error = new Error("macos_hermes_runtime_import_policy_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) refuse();
  const properties = Object.getOwnPropertyNames(value);
  if (properties.length !== names.length || properties.some(name => !names.includes(name))
    || names.some(name => !properties.includes(name))) refuse();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) refuse();
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactArray(value: unknown, length: number): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0 || value.length !== length) refuse();
  const properties = Object.getOwnPropertyNames(value);
  if (properties.length !== length + 1 || properties.at(-1) !== "length") refuse();
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) refuse();
  }
  return value;
}

function material(value: z.infer<typeof inventorySchema> & { architecture: "arm64" | "x64" }) {
  return {
    schema: MACOS_HERMES_RUNTIME_IMPORT_POLICY_V1,
    platform: "darwin" as const,
    architecture: value.architecture,
    pythonAbi: "cp311" as const,
    hermesVersion: HERMES_021_VERSION_V1,
    hermesSourceRevision: HERMES_021_SOURCE_REVISION_V1,
    bootstrap: {
      kind: "cpython_isolated_config" as const,
      interpreterEntry: "python/bin/python3.11" as const,
      consoleScript: "hermes" as const,
      callable: "hermes_cli.main:main" as const,
      isolated: true as const,
      useEnvironment: false as const,
      importSite: false as const,
      useUserSite: false as const,
      writeBytecode: false as const,
      moduleSearchPathsSet: true as const,
    },
    moduleRoots: [
      { role: "standard_library" as const, imageRelativePath: "python/lib/python3.11" as const,
        permitsPathMutation: false as const },
      { role: "extension_modules" as const, imageRelativePath: "python/lib/python3.11/lib-dynload" as const,
        permitsPathMutation: false as const },
      { role: "hermes_application" as const, imageRelativePath: "runtime/hermes" as const,
        permitsPathMutation: false as const },
      { role: "dependencies" as const, imageRelativePath: "runtime/dependencies" as const,
        permitsPathMutation: false as const },
    ] as const,
    importBoundary: {
      acceptsExternalModuleRoots: false as const,
      acceptsPythonPath: false as const,
      acceptsUserSite: false as const,
      acceptsCurrentDirectory: false as const,
      acceptsPthFiles: false as const,
      acceptsEditableInstallHooks: false as const,
      acceptsMetaPathHooks: false as const,
      acceptsPathHooks: false as const,
      acceptsPlugins: false as const,
      acceptsDynamicFileLoaders: false as const,
      acceptsBootstrapInstallOrRepair: false as const,
      acceptsCredentialsProfilesMemoriesSkills: false as const,
    },
    inventories: {
      runtimeImageManifestDigest: value.runtimeImageManifestDigest,
      dependencyInventoryDigest: value.dependencyInventoryDigest,
      nativeLibraryInventoryDigest: value.nativeLibraryInventoryDigest,
      licenseInventoryDigest: value.licenseInventoryDigest,
    },
    sourceReview: {
      entryPointVerified: true as const,
      pythonRequirementVerified: true as const,
      licenseVerified: true as const,
      // Upstream controls can reduce a branch, but neither proves a sealed
      // import/runtime closure or a real worker launch.
      safeModeAndLazyInstallArePartialMitigationsOnly: true as const,
      providerDiscoveryRemainsReachable: true as const,
      bootstrapImportsRecoveryHook: true as const,
      bootstrapMutatesSysPath: true as const,
      bootstrapCanInstallOrRepairDependencies: true as const,
      bootstrapRecoveryMarkersRemainRelevant: true as const,
      profileEnvironmentCanSelectRuntimeState: true as const,
      runtimeInstallsMetaPathHook: true as const,
      runtimeDiscoversUserProjectAndEntryPointPlugins: true as const,
      compatibleWithPolicy: false as const,
      blockers: ["provider_discovery", "bootstrap_import_hook", "bootstrap_sys_path_mutation",
        "bootstrap_install_or_repair", "bootstrap_recovery_markers", "profile_environment",
        "runtime_meta_path_hook", "runtime_plugin_discovery"] as const,
    },
    status: "policy_only" as const,
    grantsImageAuthority: false as const,
    grantsProcessAuthority: false as const,
    grantsInstallAuthority: false as const,
    grantsQualificationAuthority: false as const,
    realWorkerLaunchReady: false as const,
    grantsWorkerLaunchAuthority: false as const,
  };
}

function freezePolicy(value: z.infer<typeof policySchema>): MacosHermesRuntimeImportPolicyV1 {
  Object.freeze(value.bootstrap);
  for (const root of value.moduleRoots) Object.freeze(root);
  Object.freeze(value.moduleRoots);
  Object.freeze(value.importBoundary);
  Object.freeze(value.inventories);
  Object.freeze(value.sourceReview.blockers);
  Object.freeze(value.sourceReview);
  return Object.freeze(value);
}

/**
 * Records the exact source-reviewed import boundary and future inventory
 * bindings. The pinned source is deliberately marked incompatible: this pure
 * function neither proves an inventory nor grants image, process, install or
 * qualification authority.
 */
export function buildMacosHermesRuntimeImportPolicyV1(value: unknown): MacosHermesRuntimeImportPolicyV1 {
  const input = exact(value, inputNames);
  const parsed = z.object({
    architecture,
    runtimeImageManifestDigest: digest,
    dependencyInventoryDigest: digest,
    nativeLibraryInventoryDigest: digest,
    licenseInventoryDigest: digest,
  }).strict().safeParse(input);
  if (!parsed.success) refuse();
  const body = material(parsed.data);
  return freezePolicy(policySchema.parse({ ...body, policyDigest: sha256Digest(body) }));
}

export function parseMacosHermesRuntimeImportPolicyV1(value: unknown): MacosHermesRuntimeImportPolicyV1 {
  const outer = exact(value, policyNames);
  exact(outer.bootstrap, bootstrapNames);
  exact(outer.importBoundary, importBoundaryNames);
  exact(outer.inventories, inventoryNames);
  exact(outer.sourceReview, sourceReviewNames);
  const roots = exactArray(outer.moduleRoots, 4);
  for (const root of roots) exact(root, moduleRootNames);
  const blockers = exactArray((outer.sourceReview as Readonly<Record<string, unknown>>).blockers, 8);
  const parsed = policySchema.safeParse({ ...outer, moduleRoots: roots,
    sourceReview: { ...(outer.sourceReview as Readonly<Record<string, unknown>>), blockers } });
  if (!parsed.success) refuse();
  const expected = material({ architecture: parsed.data.architecture, ...parsed.data.inventories });
  const body = { ...parsed.data } as Record<string, unknown>;
  delete body.policyDigest;
  if (canonicalJson(body) !== canonicalJson(expected) || sha256Digest(body) !== parsed.data.policyDigest) refuse();
  return freezePolicy(parsed.data);
}

export function serializeMacosHermesRuntimeImportPolicyV1(value: unknown): string {
  return `${canonicalJson(parseMacosHermesRuntimeImportPolicyV1(value))}\n`;
}
