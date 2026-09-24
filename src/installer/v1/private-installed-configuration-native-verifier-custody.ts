import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { types } from "node:util";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import {
  createPrivateInstalledConfigurationCustodyV3,
  PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3,
  type PrivateInstalledConfigurationCustodyManifestReadyV3,
} from "./private-installed-configuration-custody";
import {
  createPrivateInstalledConfigurationNativeHostV1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1,
  type PrivateInstalledConfigurationNativeHostV1,
} from "./private-installed-configuration-native-host";
import {
  stageMacosInstalledConfigurationNativeFactoryInputV1,
  retireMacosInstalledConfigurationNativeFactoryInputV1,
} from "./macos-installed-configuration-native-sidecar.mjs";
import {
  consumeMacosLocalLauncherInstalledConfigurationVerifierCustodyV1,
} from "./macos-local-launcher-bundle.mjs";

export const PRIVATE_INSTALLED_CONFIGURATION_NATIVE_VERIFIER_CUSTODY_V1 =
  "control-room.private-installed-configuration-native-verifier-custody/v1" as const;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const maximumConfigurationBytes = 256 * 1024;
const maximumManifestBytes = 16 * 1024;

type Captured = Readonly<{
  launcher: object;
  installationId: string;
  releaseDigest: string;
  planDigest: string;
  protectedRootPath: string;
  expectedOwnerUid: number;
  verificationDeadlineMs: number;
  configurationBytes: Buffer;
  configurationSha256: string;
  manifestBytes: Buffer;
  manifestSha256: string;
}>;

function refused(): never {
  const error = new Error("private_installed_configuration_native_verifier_custody_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)) || names.some(name => !keys.includes(name))) return refused();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return refused();
  return value as number;
}

function bytes(value: unknown, maximum: number): Buffer {
  const observed = exactHostUint8ArrayV1(value, maximum);
  if (!observed || observed.byteLength < 1) return refused();
  return Buffer.from(observed.copy());
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function capture(value: unknown): Captured {
  const input = exact(value, ["schema", "verifiedLauncherBundle", "installation"]);
  if (input.schema !== PRIVATE_INSTALLED_CONFIGURATION_NATIVE_VERIFIER_CUSTODY_V1
    || !input.verifiedLauncherBundle || typeof input.verifiedLauncherBundle !== "object"
    || types.isProxy(input.verifiedLauncherBundle)) return refused();
  const installation = exact(input.installation, ["installationId", "releaseDigest", "planDigest",
    "protectedRootPath", "expectedOwnerUid", "verificationDeadlineMs", "configurationBytes",
    "configurationSha256", "manifestBytes", "manifestSha256"]);
  const expectedRoot = join(homedir(), "Library", "Application Support", "Agent Control Room", "Protected");
  if (typeof installation.installationId !== "string" || !installationPattern.test(installation.installationId)
    || installation.protectedRootPath !== expectedRoot) return refused();
  const configurationBytes = bytes(installation.configurationBytes, maximumConfigurationBytes);
  const manifestBytes = bytes(installation.manifestBytes, maximumManifestBytes);
  const configurationSha256 = digest(installation.configurationSha256);
  const manifestSha256 = digest(installation.manifestSha256);
  const expectedOwnerUid = integer(installation.expectedOwnerUid, 1, 0x7fffffff);
  if (typeof process.getuid !== "function" || typeof process.geteuid !== "function"
    || process.getuid() !== process.geteuid() || process.geteuid() !== expectedOwnerUid) return refused();
  if (sha256(configurationBytes) !== configurationSha256 || sha256(manifestBytes) !== manifestSha256) return refused();
  return Object.freeze({ launcher: input.verifiedLauncherBundle as object,
    installationId: installation.installationId, releaseDigest: digest(installation.releaseDigest),
    planDigest: digest(installation.planDigest), protectedRootPath: expectedRoot,
    expectedOwnerUid,
    verificationDeadlineMs: integer(installation.verificationDeadlineMs, 1, 30_000),
    configurationBytes, configurationSha256, manifestBytes, manifestSha256 });
}

export type PrivateInstalledConfigurationNativeVerifierCustodyV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_NATIVE_VERIFIER_CUSTODY_V1;
  status: "protected_native_verifier_bound";
  custody: Readonly<{
    loadManifestBoundPrivateConfigurationData(signal?: AbortSignal):
      Promise<Awaited<ReturnType<PrivateInstalledConfigurationCustodyManifestReadyV3["custody"]["loadManifestBoundPrivateConfigurationData"]>>>;
  }>;
  performsEffectOnConstruction: false;
  acceptsNativeVerifierCallback: false;
  acceptsHelperPath: false;
  acceptsProtectedRootPathOverride: false;
  retainsCredentialValueInPublicConfiguration: false;
  nextReleaseBoundary: "ship_and_bind_claude_process_sidecar";
}>;

/**
 * Binds V3 manifest custody to one genuinely verified expanded launcher and
 * the concrete installed-configuration helper. Construction is inert. The
 * one explicit load stages and retires only the launcher's pinned helper,
 * verifies the fixed owner root, reads the V3 manifest, and closes the native
 * host before returning the existing opaque Claude release capability.
 */
export function createPrivateInstalledConfigurationNativeVerifierCustodyV1(value: unknown):
PrivateInstalledConfigurationNativeVerifierCustodyV1 {
  const captured = capture(value);
  // Burn provenance during construction. A failed later read cannot be
  // retried through a newly selected bundle, helper, or path.
  const launcher = consumeMacosLocalLauncherInstalledConfigurationVerifierCustodyV1(captured.launcher);
  const sidecar = exact(launcher.sidecar, ["schema", "verified", "releaseVersion", "platform", "architecture",
    "minimumMacos", "protocol", "sidecarManifestSha256", "archiveSha256", "artifactManifestSha256",
    "executableSha256", "sourceSha256", "toolchain", "files", "compiles", "downloads", "installs"]);
  if (launcher.releaseManifestDigest !== captured.releaseDigest || sidecar.verified !== true
    || sidecar.protocol !== "ACRCFG1" || sidecar.platform !== "darwin") return refused();
  let spent = false;
  const custody = Object.freeze({ async loadManifestBoundPrivateConfigurationData(signal?: AbortSignal) {
    if (spent || signal !== undefined && !(signal instanceof AbortSignal)) return refused();
    spent = true; signal?.throwIfAborted();
    let staged: Awaited<ReturnType<typeof stageMacosInstalledConfigurationNativeFactoryInputV1>> | undefined;
    let native: PrivateInstalledConfigurationNativeHostV1 | undefined;
    let nativeClosed = false, stagedRetired = false;
    try {
      staged = await stageMacosInstalledConfigurationNativeFactoryInputV1({
        expectedArchiveSha256: sidecar.archiveSha256,
        expectedArtifactManifestSha256: sidecar.artifactManifestSha256,
        expectedExecutableSha256: sidecar.executableSha256,
        expectedReleaseVersion: sidecar.releaseVersion,
        expectedSidecarManifestSha256: sidecar.sidecarManifestSha256,
        sidecarRoot: launcher.sidecarRoot,
        stagingParent: await realpath(tmpdir()),
      });
      signal?.throwIfAborted();
      const host = exact(staged.installedConfigurationNativeHostInput, ["executablePath", "executableSha256"]);
      native = createPrivateInstalledConfigurationNativeHostV1({
        schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1,
        executablePath: host.executablePath, executableSha256: host.executableSha256,
        installationId: captured.installationId, releaseDigest: captured.releaseDigest,
        planDigest: captured.planDigest, rootPath: captured.protectedRootPath,
        expectedOwnerUid: captured.expectedOwnerUid,
        configurationBytes: captured.configurationBytes, configurationSha256: captured.configurationSha256,
        manifestBytes: captured.manifestBytes, manifestSha256: captured.manifestSha256,
      });
      const configuration = await createPrivateInstalledConfigurationCustodyV3({
        schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3,
        manifestPath: join(captured.protectedRootPath, "installed-manifest.json"),
        manifestBytes: captured.manifestBytes.byteLength, manifestSha256: captured.manifestSha256,
        expectedOwnerUid: captured.expectedOwnerUid, verificationDeadlineMs: captured.verificationDeadlineMs,
        native: Object.freeze({ verifyProtectedPath: native.verifyProtectedPath }),
      }, signal);
      await retireMacosInstalledConfigurationNativeFactoryInputV1(staged); stagedRetired = true;
      if (configuration.status !== "manifest_bound_configuration_ready") return refused();
      const prepared = await configuration.custody.loadManifestBoundPrivateConfigurationData(signal);
      const cleanup = await native.cleanup(new AbortController().signal);
      if (cleanup.outcome !== "confirmed") return refused();
      nativeClosed = true;
      return prepared;
    } catch {
      return refused();
    } finally {
      if (native && !nativeClosed) await native.cleanup(new AbortController().signal).catch(() => undefined);
      if (staged && !stagedRetired) await retireMacosInstalledConfigurationNativeFactoryInputV1(staged).catch(() => undefined);
      captured.configurationBytes.fill(0); captured.manifestBytes.fill(0);
    }
  } });
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_VERIFIER_CUSTODY_V1,
    status: "protected_native_verifier_bound" as const, custody,
    performsEffectOnConstruction: false as const, acceptsNativeVerifierCallback: false as const,
    acceptsHelperPath: false as const, acceptsProtectedRootPathOverride: false as const,
    retainsCredentialValueInPublicConfiguration: false as const,
    nextReleaseBoundary: "ship_and_bind_claude_process_sidecar" as const });
}
