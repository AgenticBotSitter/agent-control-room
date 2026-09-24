import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalJson } from "../src/security/canonical-digest";
import { createPrivateInstalledConfigurationCustodyV3, PRIVATE_INSTALLED_CLAUDE_PROCESS_SIDECAR_IDENTITY_V1,
  PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3, PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "../src/installer/v1/private-installed-configuration-custody";
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
const encoded = (value: unknown) => Buffer.from(`${canonicalJson(value)}\n`, "utf8");
async function protectedCapability(t: TestContext, identity = sidecar) {
  const root = await mkdtemp(join(process.cwd(), ".claude-release-custody-"));
  t.after(() => rm(root, { recursive: true, force: true })); await chmod(root, 0o700);
  const configuration = encoded({ protected: true }), configurationName = "operator.json";
  await writeFile(join(root, configurationName), configuration, { mode: 0o600 });
  await mkdir(join(root, "installation-journal"), { mode: 0o700 });
  const journalSidecar = { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1,
    releaseVersion: "1.2.3", portableReleaseManifestSha256: digest("portable"),
    outerLauncherManifestSha256: digest("launcher"), sidecarManifestSha256: digest("journal-sidecar"),
    archiveSha256: digest("journal-archive"), artifactManifestSha256: digest("journal-artifact"),
    executableSha256: digest("journal-helper"), platform: "darwin", protocol: "ACRJNL1", architecture: "arm64" };
  const claudeCodeProcessNativeSidecar = { schema: PRIVATE_INSTALLED_CLAUDE_PROCESS_SIDECAR_IDENTITY_V1,
    releaseVersion: identity.releaseVersion, releaseSha256: identity.releaseSha256,
    sidecarManifestSha256: identity.sidecarManifestSha256, archiveSha256: identity.archiveSha256,
    artifactManifestSha256: identity.artifactManifestSha256, executableSha256: identity.executableSha256,
    platform: identity.platform, architecture: identity.architecture, minimumMacos: identity.minimumMacos,
    protocol: identity.protocol };
  const manifest = { schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3, installationId: "local-claude",
    ownerUid: process.geteuid!(), configuration: { name: configurationName, bytes: configuration.length,
      sha256: `sha256:${createHash("sha256").update(configuration).digest("hex")}` },
    journal: { directoryName: "installation-journal", nativeSidecar: journalSidecar }, claudeCodeProcessNativeSidecar };
  const bytes = encoded(manifest), path = join(root, "installed-manifest.json");
  await writeFile(path, bytes, { mode: 0o600 });
  const custody = await createPrivateInstalledConfigurationCustodyV3({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3,
    manifestPath: path, manifestBytes: bytes.length,
    manifestSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    expectedOwnerUid: process.geteuid!(), verificationDeadlineMs: 1_000,
    native: { async verifyProtectedPath(request: any) { return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1,
      outcome: "verified", descriptor: request.descriptor, device: request.identity.device, inode: request.identity.inode,
      ownerUid: request.identity.ownerUid, mode: request.identity.mode, extendedAcl: false, ancestorVerified: true }; } } });
  assert.equal(custody.status, "manifest_bound_configuration_ready");
  if (custody.status !== "manifest_bound_configuration_ready") throw new Error("custody blocked");
  return (await custody.custody.loadManifestBoundPrivateConfigurationData()).claudeCodeProcessReleaseCapability;
}

async function fixture(t: TestContext) {
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
  return { schema: PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1,
    manifestReleaseCapability: await protectedCapability(t),
    verifiedSidecar: sidecar, installedProcessConfiguration, processPortConfiguration, qualificationReport: report };
}

const refuses = (value: unknown) => assert.throws(
  () => createPrivateMacosClaudeCodeInstalledPortComposerV1(value),
  /^Error: private_macos_claude_code_installed_port_composer_refused$/,
);

test("the installed Claude port is bound to one exact manifest, sidecar, fixed policy and qualification without launching", async t => {
  const input = await fixture(t), before = structuredClone(input);
  const result = createPrivateMacosClaudeCodeInstalledPortComposerV1(input);
  assert.deepEqual(input, before);
  assert.equal(result.status, "installed_port_bound");
  assert.equal(result.capability.schema, PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1);
  assert.equal(result.nativeEffects, false);
  assert.equal(result.launchesClaude, false);
  assert.equal(result.stagesSidecar, false);
  assert.deepEqual(result.remainingBlockers, [
    "owner_attended_native_login_qualification_missing",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private\/owner|workspace/i);
  const ports = consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1(result.capability);
  assert.equal(typeof ports.verifyInstallation, "function");
  assert.equal(typeof ports.launch, "function");
});

test("the protected release and installed-port capabilities are one-use and never become a generic retry path", async t => {
  const input = await fixture(t), releaseCapability = input.manifestReleaseCapability;
  const result = createPrivateMacosClaudeCodeInstalledPortComposerV1(input);
  consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1(result.capability);
  assert.throws(() => consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1(result.capability),
    /^Error: private_macos_claude_code_installed_port_composer_refused$/);
  assert.throws(() => consumePrivateMacosClaudeCodeInstalledProcessHostPortsV1({
    schema: PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1,
  }), /^Error: private_macos_claude_code_installed_port_composer_refused$/);
  refuses({ ...await fixture(t), manifestReleaseCapability: releaseCapability });
});

test("protected-manifest and verified-sidecar byte, platform and release drift are all refused before port construction", async t => {
  const fields = ["releaseVersion", "releaseSha256", "platform", "architecture", "sidecarManifestSha256",
    "archiveSha256", "artifactManifestSha256", "executableSha256"] as const;
  for (const field of fields) {
    const input = await fixture(t);
    const changed = field === "platform" ? "linux" : field === "architecture" ? "x64" : field === "releaseVersion" ? "9.9.9" : digest(`changed:${field}`);
    refuses({ ...input, verifiedSidecar: { ...input.verifiedSidecar, [field]: changed } });
    const protectedDrift = { ...sidecar, [field]: changed } as typeof sidecar;
    if (field === "platform") await assert.rejects(protectedCapability(t, protectedDrift),
      /private_installed_configuration_custody_refused/u);
    else refuses({ ...await fixture(t), manifestReleaseCapability: await protectedCapability(t, protectedDrift) });
  }
  const input = await fixture(t);
  refuses({ ...input, verifiedSidecar: { ...input.verifiedSidecar, verified: false } });
  refuses({ ...input, verifiedSidecar: { ...input.verifiedSidecar, compiles: true } });
  refuses({ ...input, verifiedSidecar: { ...input.verifiedSidecar, protocol: "other" } });
});

test("process policy, workspace and qualification substitutions cannot reach the native port", async t => {
  const template = await fixture(t);
  for (const change of [
    { process: { ...template.installedProcessConfiguration.process, args: ["--resume"] } },
    { process: { ...template.installedProcessConfiguration.process, executablePath: "/private/other/claude" } },
    { process: { ...template.installedProcessConfiguration.process, workingDirectory: "/private/other/workspace" } },
    { executableSha256: digest("other-executable") },
    { workingDirectoryBindingDigest: digest("other-workspace") },
    { qualificationDigest: digest("other-qualification") },
  ]) { const input = await fixture(t);
    refuses({ ...input, installedProcessConfiguration: { ...input.installedProcessConfiguration, ...change } }); }
  for (const change of [
    { helperSha256: digest("other-helper") }, { executablePath: "/private/other/claude" },
    { workingDirectory: "/private/other/workspace" }, { qualificationDigest: digest("other-qualification") },
  ]) { const input = await fixture(t);
    refuses({ ...input, processPortConfiguration: { ...input.processPortConfiguration, ...change } }); }
  const input = await fixture(t);
  refuses({ ...input, qualificationReport: { ...input.qualificationReport, qualified: false } });
  const second = await fixture(t);
  refuses({ ...second, qualificationReport: { ...second.qualificationReport, executableSha256: digest("other") } });
  const third = await fixture(t);
  refuses({ ...third, qualificationReport: { ...third.qualificationReport, fixedInvocationPolicyDigest: digest("other") } });
});

test("getters, proxies and extra values are refused without reading a private path", async t => {
  const input = await fixture(t);
  const getter = { ...input } as Record<string, unknown>;
  Object.defineProperty(getter, "verifiedSidecar", { enumerable: true, get() { throw new Error("must not run"); } });
  refuses(getter);
  refuses(new Proxy(input, {}));
  refuses({ ...input, extra: "not accepted" });
});
