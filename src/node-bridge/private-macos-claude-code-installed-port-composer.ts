import { types } from "node:util";
import {
  createPrivateMacosClaudeCodeInstalledProcessHostPortsV1,
  type PrivateMacosClaudeCodeProcessPortConfigurationV1,
} from "./private-macos-claude-code-process-host-ports";
import type { PrivateClaudeCodeInstalledProcessHostPortsV1 } from
  "../harness/claude-code-v1/private-installed-process-host";
import {
  CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1,
  claudeCodeTextReviewQualificationReportSchemaV1,
  createClaudeCodeTextReviewQualificationEvidenceV1,
} from "../harness/claude-code-v1/qualification-evidence";
import {
  captureClaudeCodeTextReviewInvocationConfigurationV1,
} from "../harness/claude-code-v1/text-review-invocation-policy";

/**
 * This composer joins already-verified, owner-held data.  It neither reads a
 * sidecar from disk nor starts its helper or Claude.  The returned opaque
 * capability is deliberately narrower than the existing native port: only a
 * later private operator composition can consume it once.
 */
export const PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1 =
  "control-room.private-macos-claude-code-installed-port-composer/v1" as const;
export const PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1 =
  "control-room.private-macos-claude-code-installed-port-capability/v1" as const;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const refused = (): never => {
  const error = new Error("private_macos_claude_code_installed_port_composer_refused");
  error.stack = undefined;
  throw error;
};

type ReleaseBinding = Readonly<{
  releaseVersion: string;
  releaseSha256: string;
  platform: "darwin";
  architecture: "arm64" | "x64";
  sidecarManifestSha256: string;
  archiveSha256: string;
  artifactManifestSha256: string;
  executableSha256: string;
}>;

type BoundPorts = Readonly<{
  ports: PrivateClaudeCodeInstalledProcessHostPortsV1;
  executableSha256: string;
  workingDirectoryBindingDigest: string;
  qualificationDigest: string;
}>;

const privatePorts = new WeakMap<object, BoundPorts>();

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || names.some(name => !keys.includes(name)) || keys.some(key => !names.includes(key))) return refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return refused();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function releaseBinding(value: unknown): ReleaseBinding {
  const data = exact(value, ["releaseVersion", "releaseSha256", "platform", "architecture", "sidecarManifestSha256",
    "archiveSha256", "artifactManifestSha256", "executableSha256"]);
  if (typeof data.releaseVersion !== "string" || !versionPattern.test(data.releaseVersion)
    || data.platform !== "darwin" || (data.architecture !== "arm64" && data.architecture !== "x64")) return refused();
  return Object.freeze({ releaseVersion: data.releaseVersion, releaseSha256: digest(data.releaseSha256),
    platform: "darwin" as const, architecture: data.architecture,
    sidecarManifestSha256: digest(data.sidecarManifestSha256), archiveSha256: digest(data.archiveSha256),
    artifactManifestSha256: digest(data.artifactManifestSha256), executableSha256: digest(data.executableSha256) });
}

/** Capture only the non-path release identity emitted by the existing sidecar
 * verifier.  The caller must have run that verifier separately; accepting an
 * unverified or differently released sidecar never creates a native port. */
function verifiedSidecar(value: unknown): ReleaseBinding {
  const data = exact(value, ["schema", "verified", "releaseVersion", "releaseSha256", "platform", "architecture",
    "minimumMacos", "protocol", "sidecarManifestSha256", "archiveSha256", "artifactManifestSha256",
    "executableSha256", "sourceSha256", "toolchain", "files", "compiles", "downloads", "installs"]);
  if (data.schema !== "control-room.macos-claude-code-process-native-sidecar/v1" || data.verified !== true
    || data.compiles !== false || data.downloads !== false || data.installs !== false
    || data.protocol !== "ACRCCP1" || data.platform !== "darwin" || data.minimumMacos !== "13.0") return refused();
  return releaseBinding({ releaseVersion: data.releaseVersion, releaseSha256: data.releaseSha256,
    platform: data.platform, architecture: data.architecture, sidecarManifestSha256: data.sidecarManifestSha256,
    archiveSha256: data.archiveSha256, artifactManifestSha256: data.artifactManifestSha256,
    executableSha256: data.executableSha256 });
}

function sameRelease(left: ReleaseBinding, right: ReleaseBinding): boolean {
  return left.releaseVersion === right.releaseVersion && left.releaseSha256 === right.releaseSha256
    && left.platform === right.platform && left.architecture === right.architecture
    && left.sidecarManifestSha256 === right.sidecarManifestSha256 && left.archiveSha256 === right.archiveSha256
    && left.artifactManifestSha256 === right.artifactManifestSha256 && left.executableSha256 === right.executableSha256;
}

function capturePortConfiguration(value: unknown): Readonly<PrivateMacosClaudeCodeProcessPortConfigurationV1> {
  const data = exact(value, ["schema", "helperPath", "helperSha256", "executablePath", "executableSha256",
    "executableIdentity", "workingDirectory", "workingDirectoryIdentity", "workingDirectoryBindingDigest",
    "qualificationDigest", "ownerUid", "holdDeadlineMs", "runDeadlineMs", "maximumInputBytes", "maximumOutputBytes"]);
  const executableIdentity = exact(data.executableIdentity, ["device", "inode"]);
  const workingDirectoryIdentity = exact(data.workingDirectoryIdentity, ["device", "inode"]);
  return Object.freeze({ ...data, executableIdentity, workingDirectoryIdentity } as PrivateMacosClaudeCodeProcessPortConfigurationV1);
}

export type PrivateMacosClaudeCodeInstalledPortComposerV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1;
  status: "installed_port_bound";
  capability: Readonly<{ schema: typeof PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1 }>;
  nativeEffects: false;
  launchesClaude: false;
  stagesSidecar: false;
  remainingBlockers: readonly ["owner_attended_native_login_qualification_missing", "installed_helper_release_custody_missing"];
}>;

/**
 * Compose the exact existing macOS process-host port only when the installed
 * manifest release binding, already verified native sidecar, fixed invocation
 * policy, workspace binding, and successful owner qualification agree.  This
 * creates no process: the underlying port does no I/O until its later
 * `verifyInstallation` call.
 */
export function createPrivateMacosClaudeCodeInstalledPortComposerV1(value: unknown): PrivateMacosClaudeCodeInstalledPortComposerV1 {
  try {
    const input = exact(value, ["schema", "manifestReleaseBinding", "verifiedSidecar", "installedProcessConfiguration",
      "processPortConfiguration", "qualificationReport"]);
    if (input.schema !== PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1) return refused();
    const manifest = releaseBinding(input.manifestReleaseBinding);
    const sidecar = verifiedSidecar(input.verifiedSidecar);
    if (!sameRelease(manifest, sidecar)) return refused();
    const process = captureClaudeCodeTextReviewInvocationConfigurationV1(input.installedProcessConfiguration as never);
    const portConfiguration = capturePortConfiguration(input.processPortConfiguration);
    const report = claudeCodeTextReviewQualificationReportSchemaV1.parse(input.qualificationReport);
    if (report.schema !== CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1) return refused();
    const qualification = createClaudeCodeTextReviewQualificationEvidenceV1(report);
    if (portConfiguration.helperSha256 !== sidecar.executableSha256
      || portConfiguration.executablePath !== process.process.executablePath
      || portConfiguration.executableSha256 !== process.executableSha256
      || portConfiguration.workingDirectory !== process.process.workingDirectory
      || portConfiguration.workingDirectoryBindingDigest !== process.workingDirectoryBindingDigest
      || portConfiguration.qualificationDigest !== process.qualificationDigest
      || portConfiguration.qualificationDigest !== qualification.evidenceDigest
      || report.executableSha256 !== process.executableSha256
      || report.workingDirectoryBindingDigest !== process.workingDirectoryBindingDigest) return refused();
    const ports = createPrivateMacosClaudeCodeInstalledProcessHostPortsV1(portConfiguration);
    const capability = Object.freeze({ schema: PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1 });
    privatePorts.set(capability, Object.freeze({ ports, executableSha256: process.executableSha256,
      workingDirectoryBindingDigest: process.workingDirectoryBindingDigest,
      qualificationDigest: qualification.evidenceDigest }));
    return Object.freeze({ schema: PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1,
      status: "installed_port_bound" as const, capability,
      nativeEffects: false as const, launchesClaude: false as const, stagesSidecar: false as const,
      remainingBlockers: Object.freeze([
        "owner_attended_native_login_qualification_missing",
        "installed_helper_release_custody_missing",
      ]) as PrivateMacosClaudeCodeInstalledPortComposerV1["remainingBlockers"] });
  } catch { return refused(); }
}

/** Consume an installation-bound native port once.  It has no fallback or
 * reconstruction path after a caller loses custody of the capability. */
export function consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1(
  capability: unknown,
): PrivateClaudeCodeInstalledProcessHostPortsV1 {
  if (!capability || typeof capability !== "object" || types.isProxy(capability)) return refused();
  const bound = privatePorts.get(capability);
  if (!bound || !privatePorts.delete(capability)) return refused();
  return bound.ports;
}

/**
 * The post-install bridge must prove that its existing tuple still describes
 * the same fixed executable, workspace and owner-attended qualification that
 * created the opaque capability.  A mismatch burns the capability: retrying
 * through a later tuple is not a safe recovery path.
 */
export function consumePrivateMacosClaudeCodeInstalledProcessHostPortsForPostInstallV1(
  capability: unknown,
  value: unknown,
): PrivateClaudeCodeInstalledProcessHostPortsV1 {
  if (!capability || typeof capability !== "object" || types.isProxy(capability)) return refused();
  const bound = privatePorts.get(capability);
  if (!bound || !privatePorts.delete(capability)) return refused();
  try {
    const input = exact(value, ["installedProcessConfiguration", "qualificationReport"]);
    const process = captureClaudeCodeTextReviewInvocationConfigurationV1(input.installedProcessConfiguration as never);
    const report = claudeCodeTextReviewQualificationReportSchemaV1.parse(input.qualificationReport);
    const qualification = createClaudeCodeTextReviewQualificationEvidenceV1(report);
    if (process.executableSha256 !== bound.executableSha256
      || process.workingDirectoryBindingDigest !== bound.workingDirectoryBindingDigest
      || process.qualificationDigest !== bound.qualificationDigest
      || qualification.evidenceDigest !== bound.qualificationDigest) return refused();
    return bound.ports;
  } catch { return refused(); }
}
