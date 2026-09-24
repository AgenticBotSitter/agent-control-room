import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1,
  createPrivateMacosClaudeCodeInstalledPortComposerV1,
  PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1,
  PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1,
} from "../src/node-bridge/private-macos-claude-code-installed-port-composer";
import {
  CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1,
  CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
} from "../src/harness/claude-code-v1/text-review-invocation-policy";
import { CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1 } from
  "../src/harness/claude-code-v1/qualification-evidence";
import { createClaudeCodeTextReviewQualificationEvidenceV1 } from
  "../src/harness/claude-code-v1/qualification-evidence";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const sidecar = {
  schema: "control-room.macos-claude-code-process-native-sidecar/v1",
  verified: true as const, releaseVersion: "1.2.3", releaseSha256: digest("release"), platform: "darwin" as const,
  architecture: "arm64" as const, minimumMacos: "13.0", protocol: "ACRCCP1",
  sidecarManifestSha256: digest("sidecar"), archiveSha256: digest("archive"), artifactManifestSha256: digest("artifact"),
  executableSha256: digest("helper"), sourceSha256: "a".repeat(64), toolchain: {}, files: [],
  compiles: false as const, downloads: false as const, installs: false as const,
};
const manifestReleaseBinding = {
  releaseVersion: sidecar.releaseVersion, releaseSha256: sidecar.releaseSha256, platform: sidecar.platform,
  architecture: sidecar.architecture, sidecarManifestSha256: sidecar.sidecarManifestSha256,
  archiveSha256: sidecar.archiveSha256, artifactManifestSha256: sidecar.artifactManifestSha256,
  executableSha256: sidecar.executableSha256,
};

function fixture() {
  const executableSha256 = digest("claude"), workspaceDigest = digest("workspace");
  const report = {
    schema: CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1, qualified: true,
    fixedInvocationPolicyDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
    executableSha256, workingDirectoryBindingDigest: workspaceDigest, terminalResultObserved: true,
    terminalResultDigest: digest("terminal"), inputTokens: 11, outputTokens: 7, totalTokens: 18, durationMs: 12,
    failureReason: "none" as const, retryRequiresFreshOwnerAuthorization: false,
    startsWork: false as const, grantsExecutionAuthority: false as const,
  };
  const qualificationDigest = createClaudeCodeTextReviewQualificationEvidenceV1(report).evidenceDigest;
  const installedProcessConfiguration = {
    schema: "control-room.claude-code-private-installed-process-host-configuration/v1" as const,
    process: { executablePath: "/private/owner/claude", args: [...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1],
      workingDirectory: "/private/owner/workspace", cleanupMs: 2_000 },
    executableSha256, workingDirectoryBindingDigest: workspaceDigest, qualificationDigest,
    startupDeadlineMs: 2_000, terminateDeadlineMs: 500, killDeadlineMs: 2_000,
  };
  const processPortConfiguration = {
    schema: "control-room.macos-claude-code-process-port/v1", helperPath: "/private/owner/helper",
    helperSha256: sidecar.executableSha256, executablePath: installedProcessConfiguration.process.executablePath,
    executableSha256, executableIdentity: { device: "1", inode: "2" },
    workingDirectory: installedProcessConfiguration.process.workingDirectory, workingDirectoryIdentity: { device: "1", inode: "3" },
    workingDirectoryBindingDigest: workspaceDigest, qualificationDigest, ownerUid: process.getuid?.() ?? 501,
    holdDeadlineMs: 2_000, runDeadlineMs: 5_000, maximumInputBytes: 1024, maximumOutputBytes: 1024,
  };
  return { schema: PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1, manifestReleaseBinding,
    verifiedSidecar: sidecar, installedProcessConfiguration, processPortConfiguration, qualificationReport: report };
}

const refuses = (value: unknown) => assert.throws(
  () => createPrivateMacosClaudeCodeInstalledPortComposerV1(value),
  /^Error: private_macos_claude_code_installed_port_composer_refused$/,
);

test("the installed Claude port is bound to one exact manifest, sidecar, fixed policy and qualification without launching", () => {
  const input = fixture(), before = structuredClone(input);
  const result = createPrivateMacosClaudeCodeInstalledPortComposerV1(input);
  assert.deepEqual(input, before);
  assert.equal(result.status, "installed_port_bound");
  assert.equal(result.capability.schema, PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1);
  assert.equal(result.nativeEffects, false);
  assert.equal(result.launchesClaude, false);
  assert.equal(result.stagesSidecar, false);
  assert.deepEqual(result.remainingBlockers, [
    "owner_attended_native_login_qualification_missing",
    "installed_helper_release_custody_missing",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private\/owner|workspace/i);
  const ports = consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1(result.capability);
  assert.equal(typeof ports.verifyInstallation, "function");
  assert.equal(typeof ports.launch, "function");
});

test("the capability is one-use and never becomes a generic recovery or retry path", () => {
  const result = createPrivateMacosClaudeCodeInstalledPortComposerV1(fixture());
  consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1(result.capability);
  assert.throws(() => consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1(result.capability),
    /^Error: private_macos_claude_code_installed_port_composer_refused$/);
  assert.throws(() => consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1({
    schema: PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1,
  }), /^Error: private_macos_claude_code_installed_port_composer_refused$/);
});

test("manifest and verified-sidecar byte, platform and release drift are all refused before port construction", () => {
  const fields = ["releaseVersion", "releaseSha256", "platform", "architecture", "sidecarManifestSha256",
    "archiveSha256", "artifactManifestSha256", "executableSha256"] as const;
  for (const field of fields) {
    const input = fixture();
    const changed = field === "platform" ? "linux" : field === "architecture" ? "x64" : field === "releaseVersion" ? "9.9.9" : digest(`changed:${field}`);
    refuses({ ...input, manifestReleaseBinding: { ...input.manifestReleaseBinding, [field]: changed } });
    refuses({ ...input, verifiedSidecar: { ...input.verifiedSidecar, [field]: changed } });
  }
  const input = fixture();
  refuses({ ...input, verifiedSidecar: { ...input.verifiedSidecar, verified: false } });
  refuses({ ...input, verifiedSidecar: { ...input.verifiedSidecar, compiles: true } });
  refuses({ ...input, verifiedSidecar: { ...input.verifiedSidecar, protocol: "other" } });
});

test("process policy, workspace and qualification substitutions cannot reach the native port", () => {
  const input = fixture();
  for (const change of [
    { process: { ...input.installedProcessConfiguration.process, args: ["--resume"] } },
    { process: { ...input.installedProcessConfiguration.process, executablePath: "/private/other/claude" } },
    { process: { ...input.installedProcessConfiguration.process, workingDirectory: "/private/other/workspace" } },
    { executableSha256: digest("other-executable") },
    { workingDirectoryBindingDigest: digest("other-workspace") },
    { qualificationDigest: digest("other-qualification") },
  ]) refuses({ ...input, installedProcessConfiguration: { ...input.installedProcessConfiguration, ...change } });
  for (const change of [
    { helperSha256: digest("other-helper") }, { executablePath: "/private/other/claude" },
    { workingDirectory: "/private/other/workspace" }, { qualificationDigest: digest("other-qualification") },
  ]) refuses({ ...input, processPortConfiguration: { ...input.processPortConfiguration, ...change } });
  refuses({ ...input, qualificationReport: { ...input.qualificationReport, qualified: false } });
  refuses({ ...input, qualificationReport: { ...input.qualificationReport, executableSha256: digest("other") } });
  refuses({ ...input, qualificationReport: { ...input.qualificationReport, fixedInvocationPolicyDigest: digest("other") } });
});

test("getters, proxies and extra values are refused without reading a private path", () => {
  const input = fixture();
  const getter = { ...input } as Record<string, unknown>;
  Object.defineProperty(getter, "verifiedSidecar", { enumerable: true, get() { throw new Error("must not run"); } });
  refuses(getter);
  refuses(new Proxy(input, {}));
  refuses({ ...input, extra: "not accepted" });
});
