import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { canonicalJson } from "../src/security/canonical-digest";
import { createPrivateInstalledConfigurationCustodyV3, PRIVATE_INSTALLED_CLAUDE_PROCESS_SIDECAR_IDENTITY_V1,
  PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3, PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "../src/installer/v1/private-installed-configuration-custody";
import { createPrivateMacosClaudeCodeQualificationPortComposerV1,
  PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PORT_COMPOSER_V1,
  PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PROCESS_PORT_V1 } from
  "../src/node-bridge/private-macos-claude-code-qualification-port-composer";
import { createPrivateMacosClaudeCodeInstalledPortComposerV1,
  PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1 } from
  "../src/node-bridge/private-macos-claude-code-installed-port-composer";
import { CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1 } from
  "../src/installer/v1/macos-claude-code-process-native-sidecar.mjs";
import { CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1, CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 } from
  "../src/harness/claude-code-v1/text-review-invocation-policy";
import { createClaudeCodeTextReviewQualificationEvidenceV1 } from
  "../src/harness/claude-code-v1/qualification-evidence";
import { runPrivateLocalClaudeQualificationV1 } from "../scripts/qualify-local-claude-code";

const run = promisify(execFile), nativeTest = process.platform === "darwin" ? test : test.skip;
const digest = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const encoded = (value: unknown) => Buffer.from(`${canonicalJson(value)}\n`, "utf8");

async function releaseCapability(t: TestContext, sidecar: Record<string, unknown>) {
  const root = await mkdtemp("/private/tmp/acr-claude-qualification-custody-");
  t.after(() => rm(root, { recursive: true, force: true })); await chmod(root, 0o700);
  const configuration = encoded({ protected: true });
  await writeFile(join(root, "operator.json"), configuration, { mode: 0o600 });
  await mkdir(join(root, "installation-journal"), { mode: 0o700 });
  const manifest = { schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3, installationId: "claude-qualification",
    ownerUid: process.geteuid!(), configuration: { name: "operator.json", bytes: configuration.length,
      sha256: digest(configuration) }, journal: { directoryName: "installation-journal", nativeSidecar: {
      schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1, releaseVersion: "1.2.3",
      portableReleaseManifestSha256: digest("portable"), outerLauncherManifestSha256: digest("launcher"),
      sidecarManifestSha256: digest("journal-sidecar"), archiveSha256: digest("journal-archive"),
      artifactManifestSha256: digest("journal-artifact"), executableSha256: digest("journal-helper"),
      platform: "darwin", protocol: "ACRJNL1", architecture: process.arch } },
    claudeCodeProcessNativeSidecar: { schema: PRIVATE_INSTALLED_CLAUDE_PROCESS_SIDECAR_IDENTITY_V1,
      releaseVersion: sidecar.releaseVersion, releaseSha256: sidecar.releaseSha256,
      sidecarManifestSha256: sidecar.sidecarManifestSha256, archiveSha256: sidecar.archiveSha256,
      artifactManifestSha256: sidecar.artifactManifestSha256, executableSha256: sidecar.executableSha256,
      platform: sidecar.platform, architecture: sidecar.architecture, minimumMacos: sidecar.minimumMacos,
      protocol: sidecar.protocol } };
  const bytes = encoded(manifest), manifestPath = join(root, "installed-manifest.json");
  await writeFile(manifestPath, bytes, { mode: 0o600 });
  const custody = await createPrivateInstalledConfigurationCustodyV3({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3,
    manifestPath, manifestBytes: bytes.length, manifestSha256: digest(bytes), expectedOwnerUid: process.geteuid!(),
    verificationDeadlineMs: 1_000, native: { async verifyProtectedPath(request: any) {
      return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1, outcome: "verified",
        descriptor: request.descriptor, device: request.identity.device, inode: request.identity.inode,
        ownerUid: request.identity.ownerUid, mode: request.identity.mode, extendedAcl: false, ancestorVerified: true };
    } } });
  assert.equal(custody.status, "manifest_bound_configuration_ready");
  if (custody.status !== "manifest_bound_configuration_ready") throw new Error("custody unavailable");
  return (await custody.custody.loadManifestBoundPrivateConfigurationData()).claudeCodeProcessReleaseCapability;
}

nativeTest("the owner entry qualifies only the protected supervised route and that exact report admits the later installed port", async t => {
  const root = await mkdtemp("/private/tmp/acr-claude-supervised-qualification-");
  t.after(() => rm(root, { recursive: true, force: true })); await chmod(root, 0o700);
  const helper = join(root, "helper"), executable = join(root, "fixture-claude"), workspace = join(root, "workspace");
  await run("/usr/bin/clang", [...CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1,
    "native/claude-code-process-v1.c", "-o", helper], { timeout: 30_000 });
  await run("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "tests/helpers/claude-code-qualification-fixture.c", "-o", executable], { timeout: 30_000 });
  await chmod(executable, 0o700); await mkdir(workspace, { mode: 0o700 });
  const helperSha256 = digest(await readFile(helper)), executableSha256 = digest(await readFile(executable));
  const executableStat = await lstat(executable, { bigint: true }), workspaceStat = await lstat(workspace, { bigint: true });
  const workingDirectoryBindingDigest = digest("qualification-workspace");
  const sidecar = { schema: "control-room.macos-claude-code-process-native-sidecar/v1", verified: true,
    releaseVersion: "1.2.3", releaseSha256: digest("release"), platform: "darwin",
    architecture: process.arch, minimumMacos: "13.0", protocol: "ACRCCP1",
    sidecarManifestSha256: digest("sidecar"), archiveSha256: digest("archive"),
    artifactManifestSha256: digest("artifact"), executableSha256: helperSha256,
    sourceSha256: "a".repeat(64), toolchain: {}, files: [], compiles: false, downloads: false, installs: false };
  const qualificationConfiguration = { schema: PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PROCESS_PORT_V1,
    helperPath: helper, helperSha256, executablePath: executable, executableSha256,
    executableIdentity: { device: `${executableStat.dev}`, inode: `${executableStat.ino}` },
    workingDirectory: workspace, workingDirectoryIdentity: { device: `${workspaceStat.dev}`, inode: `${workspaceStat.ino}` },
    workingDirectoryBindingDigest, ownerUid: process.geteuid!(), holdDeadlineMs: 2_000, runDeadlineMs: 5_000,
    maximumInputBytes: 4096, maximumOutputBytes: 65_536 };
  const composed = createPrivateMacosClaudeCodeQualificationPortComposerV1({
    schema: PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PORT_COMPOSER_V1,
    manifestReleaseCapability: await releaseCapability(t, sidecar), verifiedSidecar: sidecar,
    processPortConfiguration: qualificationConfiguration });
  assert.equal(composed.status, "protected_qualification_route_bound");
  assert.equal(composed.launchesClaude, false); assert.equal(composed.startsTask, false);
  const output: string[] = [], errors: string[] = [], signals = new EventEmitter();
  const code = await runPrivateLocalClaudeQualificationV1(["--owner-attended", "--reuse-owner-login"], {
    async loadProtectedQualificationRoute() { return composed.capability; },
    report(value) { output.push(value); }, reportError(value) { errors.push(value); },
    signals: signals as never,
  });
  assert.equal(code, 0, JSON.stringify({ output, errors })); assert.deepEqual(errors, []); assert.equal(output.length, 1);
  const report = JSON.parse(output[0]!);
  assert.equal(report.qualified, true); assert.match(report.supervisedRouteDigest, /^sha256:/u);
  assert.deepEqual({ input: report.inputTokens, output: report.outputTokens, total: report.totalTokens },
    { input: 3, output: 2, total: 5 });
  assert.doesNotMatch(output[0]!, /CONTROL_ROOM_CLAUDE|00000000|acr-claude|fixture-claude/iu);
  const evidence = createClaudeCodeTextReviewQualificationEvidenceV1(report);
  const processConfiguration = { schema: "control-room.claude-code-private-installed-process-host-configuration/v1",
    process: { executablePath: executable, args: [...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1],
      workingDirectory: workspace, cleanupMs: 2_000 }, executableSha256, workingDirectoryBindingDigest,
    qualificationDigest: evidence.evidenceDigest, startupDeadlineMs: 2_000, terminateDeadlineMs: 500, killDeadlineMs: 2_000 };
  const installed = createPrivateMacosClaudeCodeInstalledPortComposerV1({
    schema: PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1,
    manifestReleaseCapability: await releaseCapability(t, sidecar), verifiedSidecar: sidecar,
    installedProcessConfiguration: processConfiguration,
    processPortConfiguration: { ...qualificationConfiguration,
      schema: "control-room.macos-claude-code-process-port/v1", qualificationDigest: evidence.evidenceDigest },
    qualificationReport: report });
  assert.equal(installed.status, "installed_port_bound");
});

nativeTest("generic/path-only reports, altered routes and reused capabilities cannot become installed readiness", async t => {
  const generic = { schema: "control-room.claude-code-text-review-qualification-report/v1", qualified: true,
    fixedInvocationPolicyDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
    executableSha256: digest("executable"),
    workingDirectoryBindingDigest: digest("workspace"), supervisedRouteDigest: null,
    terminalResultObserved: true, terminalResultDigest: digest("terminal"), inputTokens: 1, outputTokens: 1,
    totalTokens: 2, durationMs: 1, failureReason: "none", retryRequiresFreshOwnerAuthorization: false,
    startsWork: false, grantsExecutionAuthority: false };
  assert.throws(() => createClaudeCodeTextReviewQualificationEvidenceV1(generic));
  const sidecar = { schema: "control-room.macos-claude-code-process-native-sidecar/v1", verified: true,
    releaseVersion: "1.2.3", releaseSha256: digest("release"), platform: "darwin", architecture: process.arch,
    minimumMacos: "13.0", protocol: "ACRCCP1", sidecarManifestSha256: digest("sidecar"),
    archiveSha256: digest("archive"), artifactManifestSha256: digest("artifact"), executableSha256: digest("helper"),
    sourceSha256: "a".repeat(64), toolchain: {}, files: [], compiles: false, downloads: false, installs: false };
  const capability = await releaseCapability(t, sidecar);
  assert.throws(() => createPrivateMacosClaudeCodeQualificationPortComposerV1({
    schema: PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PORT_COMPOSER_V1,
    manifestReleaseCapability: capability, verifiedSidecar: { ...sidecar, executableSha256: digest("other") },
    processPortConfiguration: {} }), /qualification_port_composer_refused/u);
  assert.throws(() => createPrivateMacosClaudeCodeQualificationPortComposerV1({
    schema: PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PORT_COMPOSER_V1,
    manifestReleaseCapability: capability, verifiedSidecar: sidecar,
    processPortConfiguration: {} }), /refused/u,
  "a capability burned by a mismatched release cannot be retried");
});
