import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MACOS_HERMES_RUNTIME_IMPORT_POLICY_V1,
  buildMacosHermesRuntimeImportPolicyV1,
  parseMacosHermesRuntimeImportPolicyV1,
  serializeMacosHermesRuntimeImportPolicyV1,
} from "../src/installer/v1/macos-hermes-runtime-import-policy";

const d = (character: string) => `sha256:${character.repeat(64)}`;
const input = Object.freeze({
  architecture: "arm64",
  runtimeImageManifestDigest: d("a"),
  dependencyInventoryDigest: d("b"),
  nativeLibraryInventoryDigest: d("c"),
  licenseInventoryDigest: d("d"),
});
const refusal = /^Error: macos_hermes_runtime_import_policy_refused$/u;

test("binds the exact source entry, Python ABI, architecture, module roots and inventories", () => {
  const policy = buildMacosHermesRuntimeImportPolicyV1(input);
  assert.equal(policy.schema, MACOS_HERMES_RUNTIME_IMPORT_POLICY_V1);
  assert.equal(policy.architecture, "arm64");
  assert.equal(policy.pythonAbi, "cp311");
  assert.equal(policy.hermesVersion, "0.21.3");
  assert.equal(policy.hermesSourceRevision, "00570550f37e9082676955d50f65c7d9ba846cc9");
  assert.deepEqual(policy.bootstrap, {
    kind: "cpython_isolated_config",
    interpreterEntry: "python/bin/python3.11",
    consoleScript: "hermes",
    callable: "hermes_cli.main:main",
    isolated: true,
    useEnvironment: false,
    importSite: false,
    useUserSite: false,
    writeBytecode: false,
    moduleSearchPathsSet: true,
  });
  assert.deepEqual(policy.moduleRoots.map(root => [root.role, root.imageRelativePath]), [
    ["standard_library", "python/lib/python3.11"],
    ["extension_modules", "python/lib/python3.11/lib-dynload"],
    ["hermes_application", "runtime/hermes"],
    ["dependencies", "runtime/dependencies"],
  ]);
  assert.deepEqual(policy.inventories, {
    runtimeImageManifestDigest: d("a"), dependencyInventoryDigest: d("b"),
    nativeLibraryInventoryDigest: d("c"), licenseInventoryDigest: d("d"),
  });
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.moduleRoots), true);
  assert.equal(Object.isFrozen(policy.sourceReview.blockers), true);
  assert.deepEqual(parseMacosHermesRuntimeImportPolicyV1(JSON.parse(
    serializeMacosHermesRuntimeImportPolicyV1(policy))), policy);
});

test("records the pinned source incompatibilities and grants no effect authority", () => {
  const policy = buildMacosHermesRuntimeImportPolicyV1(input);
  assert.deepEqual(policy.sourceReview, {
    entryPointVerified: true,
    pythonRequirementVerified: true,
    licenseVerified: true,
    safeModeAndLazyInstallArePartialMitigationsOnly: true,
    providerDiscoveryRemainsReachable: true,
    bootstrapImportsRecoveryHook: true,
    bootstrapMutatesSysPath: true,
    bootstrapCanInstallOrRepairDependencies: true,
    bootstrapRecoveryMarkersRemainRelevant: true,
    profileEnvironmentCanSelectRuntimeState: true,
    runtimeInstallsMetaPathHook: true,
    runtimeDiscoversUserProjectAndEntryPointPlugins: true,
    compatibleWithPolicy: false,
    blockers: ["provider_discovery", "bootstrap_import_hook", "bootstrap_sys_path_mutation",
      "bootstrap_install_or_repair", "bootstrap_recovery_markers", "profile_environment",
      "runtime_meta_path_hook", "runtime_plugin_discovery"],
  });
  assert.equal(policy.status, "policy_only");
  assert.equal(policy.grantsImageAuthority, false);
  assert.equal(policy.grantsProcessAuthority, false);
  assert.equal(policy.grantsInstallAuthority, false);
  assert.equal(policy.grantsQualificationAuthority, false);
  assert.equal(policy.realWorkerLaunchReady, false);
  assert.equal(policy.grantsWorkerLaunchAuthority, false);
});

test("the import boundary excludes hooks, external paths, plugins, installs and private material", () => {
  const policy = buildMacosHermesRuntimeImportPolicyV1(input);
  assert.deepEqual(policy.importBoundary, {
    acceptsExternalModuleRoots: false,
    acceptsPythonPath: false,
    acceptsUserSite: false,
    acceptsCurrentDirectory: false,
    acceptsPthFiles: false,
    acceptsEditableInstallHooks: false,
    acceptsMetaPathHooks: false,
    acceptsPathHooks: false,
    acceptsPlugins: false,
    acceptsDynamicFileLoaders: false,
    acceptsBootstrapInstallOrRepair: false,
    acceptsCredentialsProfilesMemoriesSkills: false,
  });
  assert.equal(policy.moduleRoots.every(root => !root.permitsPathMutation), true);
});

test("refuses caller-selected entry, ABI, roots, hooks, plugins and private paths", () => {
  for (const extra of [
    { entryPoint: "run_agent:main" },
    { pythonAbi: "cp313" },
    { moduleRoot: "/private/owner/site-packages" },
    { pluginRoot: "~/.hermes/plugins" },
    { importHook: "caller_hook" },
    { credentialPath: "~/.hermes/.env" },
  ]) assert.throws(() => buildMacosHermesRuntimeImportPolicyV1({ ...input, ...extra }), refusal);
  assert.throws(() => buildMacosHermesRuntimeImportPolicyV1({ ...input, architecture: "universal2" }), refusal);
  assert.throws(() => buildMacosHermesRuntimeImportPolicyV1({ ...input,
    dependencyInventoryDigest: "sha256:not-a-digest" }), refusal);
});

test("refuses proxies, accessors and every saved-policy relaxation", () => {
  assert.throws(() => buildMacosHermesRuntimeImportPolicyV1(new Proxy(input, {})), refusal);
  const getter = { ...input } as Record<string, unknown>;
  Object.defineProperty(getter, "architecture", { enumerable: true, get() { throw new Error("read"); } });
  assert.throws(() => buildMacosHermesRuntimeImportPolicyV1(getter), refusal);

  const policy = buildMacosHermesRuntimeImportPolicyV1(input);
  for (const changed of [
    { ...policy, status: "ready" },
    { ...policy, grantsImageAuthority: true },
    { ...policy, grantsProcessAuthority: true },
    { ...policy, grantsInstallAuthority: true },
    { ...policy, grantsQualificationAuthority: true },
    { ...policy, realWorkerLaunchReady: true },
    { ...policy, grantsWorkerLaunchAuthority: true },
    { ...policy, pythonAbi: "cp312" },
    { ...policy, bootstrap: { ...policy.bootstrap, useEnvironment: true } },
    { ...policy, moduleRoots: policy.moduleRoots.map((root, index) => index === 3
      ? { ...root, imageRelativePath: "private/site-packages" } : root) },
    { ...policy, importBoundary: { ...policy.importBoundary, acceptsMetaPathHooks: true } },
    { ...policy, importBoundary: { ...policy.importBoundary, acceptsPlugins: true } },
    { ...policy, importBoundary: { ...policy.importBoundary,
      acceptsCredentialsProfilesMemoriesSkills: true } },
    { ...policy, sourceReview: { ...policy.sourceReview, compatibleWithPolicy: true } },
    { ...policy, sourceReview: { ...policy.sourceReview,
      safeModeAndLazyInstallArePartialMitigationsOnly: false } },
    { ...policy, sourceReview: { ...policy.sourceReview, providerDiscoveryRemainsReachable: false } },
    { ...policy, sourceReview: { ...policy.sourceReview, bootstrapImportsRecoveryHook: false } },
    { ...policy, sourceReview: { ...policy.sourceReview, bootstrapRecoveryMarkersRemainRelevant: false } },
    { ...policy, sourceReview: { ...policy.sourceReview, profileEnvironmentCanSelectRuntimeState: false } },
    { ...policy, privatePath: "/private/owner" },
  ]) assert.throws(() => parseMacosHermesRuntimeImportPolicyV1(changed), refusal);
});
