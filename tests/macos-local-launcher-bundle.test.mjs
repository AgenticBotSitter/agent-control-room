import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembleLocalReleaseV1, createDeterministicTarGzipV1 } from "../src/installer/v1/local-release-assembly.mjs";
import {
  assembleMacosLocalLauncherBundleV1,
  assembleMacosLocalLauncherBundleV2,
  assembleMacosLocalLauncherBundleV3,
  runBoundedMacosLauncherChildV1,
  runMacosLocalLauncherBundleV1,
  consumeMacosLocalLauncherInstalledConfigurationVerifierCustodyV1,
  consumeMacosLocalLauncherInstalledConfigurationWriterContinuationV1,
  consumeMacosLocalLauncherInstalledConfigurationVerifierContinuationV1,
  consumeMacosLocalLauncherV3ManifestMaterializationCustodyV1,
  verifyExtractedMacosLocalLauncherBundleV1,
} from "../src/installer/v1/macos-local-launcher-bundle.mjs";
import { createPrivateInstalledConfigurationNativeVerifierCustodyV1,
  createPrivateInstalledConfigurationV3NativeVerifierCustodyV1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_VERIFIER_CUSTODY_V1 } from
  "../src/installer/v1/private-installed-configuration-native-verifier-custody.ts";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology.ts";
import { sha256Digest } from "../src/security/canonical-digest.ts";
import { PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "../src/installer/v1/private-installed-configuration-custody.ts";
import { PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1 } from
  "../src/installer/v1/private-installed-local-hermes-runtime-composer.ts";
import {
  composePrivateInstalledConfigurationV3MaterializationPublicationV1,
  consumePrivateInstalledConfigurationV3MaterializationCapabilityV1,
  preparePrivateInstalledConfigurationV1,
  preparePrivateInstalledConfigurationV3MaterializationV1,
  privateInstalledPostgresEndpointFingerprintV1,
  PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1,
  PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
} from "../src/installer/v1/private-installed-configuration-preparation.ts";
import { createPrivateInstalledConfigurationV3OwnerWriterV1,
  PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITE_REQUEST_V1 } from
  "../src/installer/v1/private-installed-configuration-v3-owner-writer.ts";
import { runLocalLauncherCoreV1 } from "../src/installer/v1/local-launcher-core.mjs";
import { INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1 } from
  "../src/installer/v1/macos-installation-journal-native-sidecar.mjs";
import { PROTECTED_DIRECTORY_NATIVE_REVIEWED_CFLAGS_V1 } from "../src/installer/v1/macos-protected-directory-native-sidecar.mjs";
import { INSTALLED_CONFIGURATION_NATIVE_REVIEWED_CFLAGS_V1 } from "../src/installer/v1/macos-installed-configuration-native-sidecar.mjs";
import { MACOS_SERVICE_NATIVE_REVIEWED_CFLAGS_V1 } from "../src/installer/v1/macos-service-native-sidecar.mjs";
import { CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1 } from
  "../src/installer/v1/macos-claude-code-process-native-sidecar.mjs";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const refusal = { message: "macos_local_launcher_bundle_refused" };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
let suiteRoot, releaseDirectory, nativeArtifactDirectory, journalNativeArtifactDirectory, bundleRoot, assembled;
let installedConfigurationNativeArtifactDirectory, macosServiceNativeArtifactDirectory, expandedBundleRoot, expandedAssembled;
let claudeCodeProcessNativeArtifactDirectory, claudeBoundBundleRoot, claudeBoundAssembled;

// Deliberately inert bytes: packaging tests never compile or execute native helpers.
async function writeExpandedNativeArtifact(directory, kind, architecture = "arm64") {
  const configuration = kind === "installed-configuration";
  const executable = configuration ? "installed-configuration-v1" : "macos-service-v1";
  const manifestName = configuration ? "INSTALLED_CONFIGURATION_MANIFEST.json" : "MACOS_SERVICE_NATIVE_MANIFEST.json";
  const staging = configuration ? join(directory, "staging") : directory;
  await mkdir(staging, { recursive: true });
  const contents = new Map([["LICENSE", Buffer.from("fixture license\n")], ["NOTICE", Buffer.from("fixture notice\n")],
    [executable, Buffer.from("inert packaging fixture; never execute\n")]]);
  for (const [name, bytes] of contents) await writeFile(join(staging, name), bytes,
    { mode: name === executable ? 0o755 : 0o644 });
  const files = [...contents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes),
    mode: path === executable ? "0755" : "0644" }));
  const manifest = { schema: `control-room.${kind}-native-artifact/v1`, platform: "darwin", architecture,
    minimumMacos: "13.0", protocol: configuration ? "ACRCFG1" : "ACRSVC1", sourceSha256: "c".repeat(64),
    toolchain: { compiler: "Apple clang version 16.0.0", sdkVersion: "16.0", flags: [...(configuration
      ? INSTALLED_CONFIGURATION_NATIVE_REVIEWED_CFLAGS_V1 : MACOS_SERVICE_NATIVE_REVIEWED_CFLAGS_V1)] },
    files, ownerQualified: false };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(staging, manifestName), manifestBytes, { mode: 0o644 });
  if (configuration) {
    const root = `agent-control-room-installed-configuration-darwin-${architecture}`;
    const archive = await createDeterministicTarGzipV1(staging, root,
      [...files.map(({ path, mode }) => ({ path, mode })), { path: manifestName, mode: "0644" }]);
    await writeFile(join(directory, manifestName), manifestBytes, { mode: 0o644 });
    await writeFile(join(directory, `${root}.tar.gz`), archive, { mode: 0o644 });
    await writeFile(join(directory, "SHA256SUMS"), `${sha256(archive)}  ${root}.tar.gz\n`, { mode: 0o644 });
    await rm(staging, { recursive: true, force: true });
  } else {
    contents.set(manifestName, manifestBytes);
    await writeFile(join(directory, "SHA256SUMS"), [...contents].map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join(""),
      { mode: 0o644 });
  }
}

function expandedInput(outputDirectory) {
  return { sourceRoot: repository, releaseDirectory, nativeArtifactDirectory, journalNativeArtifactDirectory,
    installedConfigurationNativeArtifactDirectory, macosServiceNativeArtifactDirectory, outputDirectory };
}

function claudeBoundInput(outputDirectory) {
  return { ...expandedInput(outputDirectory), claudeCodeProcessNativeArtifactDirectory };
}

function installedConfigurationSourceForLauncher(verified, mutation = {}) {
  const digest = value => sha256Digest(value);
  const databaseEndpoint = { host: "private-authority.invalid", port: 5432,
    database: "control_room", majorVersion: 17 };
  const databaseAuthority = { provider: "postgresql", majorVersion: 17, database: "control_room",
    networkClass: "private_network", databaseAuthorityDigest: digest("database-authority"),
    targetIdentityDigest: digest("database-target"),
    endpointFingerprint: privateInstalledPostgresEndpointFingerprintV1(databaseEndpoint),
    credentialReferenceFingerprint: digest("owner-secret-reference"),
    privateRouteEvidenceDigest: digest("reviewed-private-route") };
  const topologyPlan = planInstallationTopologyV1({ databaseAuthorityDigest: databaseAuthority.databaseAuthorityDigest,
    schedulerAuthorityDigest: digest("scheduler"), currentRoutes: [], requestedRoutes: [] });
  const journal = verified.installationJournalNativeSidecar;
  const nativeSidecar = { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1,
    releaseVersion: journal.releaseVersion, portableReleaseManifestSha256: verified.releaseManifestDigest,
    outerLauncherManifestSha256: verified.outerLauncherManifestSha256,
    sidecarManifestSha256: journal.sidecarManifestSha256, archiveSha256: journal.archiveSha256,
    artifactManifestSha256: journal.artifactManifestSha256, executableSha256: journal.executableSha256,
    platform: "darwin", protocol: "ACRJNL1", architecture: journal.architecture,
    ...(mutation.nativeSidecar ?? {}) };
  const privateConfigurationData = { schema: PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1,
    installationId: "local-control-room", releaseDigest: verified.releaseManifestDigest,
    installedManifestBindingDigest: digest("installed-binding"), runtimeIdentityDigest: digest("runtime"),
    prerequisiteInput: { installationId: "local-control-room", topologyPlan,
      releaseDigest: verified.releaseManifestDigest, releasePreflight: { evidenceDigest: digest("release-preflight") },
      privatePlacement: { evidenceDigest: digest("private-placement") } },
    settledInstallationPlan: { schema: "control-room.installation-plan/v1", digest: digest("plan") },
    hermes: { runnerConfiguration: { executablePath: "/private/owner-held/hermes",
      workingDirectory: "/private/owner-held/workspace", profile: "cr", model: "owner-selected-model",
      provider: "owner-selected-provider" }, taskPolicy: { taskClass: "text_review", tools: "none" } },
    operator: { port: 3210, templateId: "template:hermes-text-review" },
    database: { ...databaseEndpoint, roles: { web: "control_room_web", coordinator: "control_room_coordinator",
      results: "control_room_results", evidence: "control_room_evidence", queueWorker: "control_room_queue_worker" },
    queueConcurrency: 1 }, artifactStorage: { local: { rootPath: "/private/owner-held/results" },
      inventory: { storageNamespaceDigest: digest("storage") } },
    setupSources: { database_authority: { targetIdentityDigest: databaseAuthority.targetIdentityDigest },
      agent_readiness: { schema: "control-room.private-installed-local-hermes-agent-source/v1" } } };
  return { schema: PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1, installationId: "local-control-room",
    releaseDigest: verified.releaseManifestDigest,
    standardProtectedRootPath: "/Users/example-owner/Library/Application Support/Agent Control Room/Protected",
    expectedOwnerUid: 501, privateConfigurationData, nativeSidecar, databaseAuthority, verificationDeadlineMs: 5_000 };
}

async function writeClaudeProcessNativeArtifact(directory, architecture = "arm64", variant = "") {
  const staging = join(directory, "staging"); await mkdir(staging, { recursive: true });
  const executable = "claude-code-process-v1";
  const contents = new Map([["LICENSE", Buffer.from("fixture license\n")], ["NOTICE", Buffer.from("fixture notice\n")],
    [executable, Buffer.from(`inert Claude process fixture${variant}; never execute\n`)]]);
  for (const [name, bytes] of contents) await writeFile(join(staging, name), bytes,
    { mode: name === executable ? 0o755 : 0o644 });
  const files = [...contents].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes),
      mode: path === executable ? "0755" : "0644" }));
  const manifest = { schema: "control-room.claude-code-process-native-artifact/v1", platform: "darwin", architecture,
    minimumMacos: "13.0", protocol: "ACRCCP1", sourceSha256: "d".repeat(64),
    toolchain: { compiler: "Apple clang version 16.0.0", sdkVersion: "16.0",
      flags: [...CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1] }, files, ownerQualified: false };
  const manifestName = "CLAUDE_CODE_PROCESS_MANIFEST.json";
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(staging, manifestName), manifestBytes, { mode: 0o644 });
  const root = `agent-control-room-claude-code-process-darwin-${architecture}`;
  const archive = await createDeterministicTarGzipV1(staging, root,
    [...files.map(({ path, mode }) => ({ path, mode })), { path: manifestName, mode: "0644" }]);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, manifestName), manifestBytes, { mode: 0o644 });
  await writeFile(join(directory, `${root}.tar.gz`), archive, { mode: 0o644 });
  await writeFile(join(directory, "SHA256SUMS"), `${sha256(archive)}  ${root}.tar.gz\n`, { mode: 0o644 });
  await rm(staging, { recursive: true, force: true });
}

async function writeNativeArtifact(directory, architecture = "arm64") {
  const staging = join(directory, "staging"); await mkdir(staging, { recursive: true });
  const contents = new Map([["LICENSE", Buffer.from("native license\n")], ["NOTICE", Buffer.from("native notice\n")],
    ["protected-directory-v1", Buffer.from("fixture native helper\n")]]);
  for (const [name, bytes] of contents) await writeFile(join(staging, name), bytes, { mode: name === "protected-directory-v1" ? 0o755 : 0o644 });
  const files = [...contents].map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: sha256(bytes),
    mode: path === "protected-directory-v1" ? "0755" : "0644" }));
  const manifest = { schema: "control-room.protected-directory-native-artifact/v1", platform: "darwin", architecture,
    minimumMacos: "13.0", protocol: "ACRDIR1", sourceSha256: "a".repeat(64),
    toolchain: { compiler: "Apple clang version 16.0.0", sdkVersion: "16.0", flags: [...PROTECTED_DIRECTORY_NATIVE_REVIEWED_CFLAGS_V1] }, files, ownerQualified: false };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(staging, "PROTECTED_DIRECTORY_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  const root = `agent-control-room-protected-directory-darwin-${architecture}`;
  const archive = await createDeterministicTarGzipV1(staging, root, [...files.map(({ path, mode }) => ({ path, mode })),
    { path: "PROTECTED_DIRECTORY_MANIFEST.json", mode: "0644" }]);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "PROTECTED_DIRECTORY_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  await writeFile(join(directory, `${root}.tar.gz`), archive, { mode: 0o644 });
  await writeFile(join(directory, "SHA256SUMS"), `${sha256(archive)}  ${root}.tar.gz\n`, { mode: 0o644 });
  await rm(staging, { recursive: true, force: true });
}

async function writeJournalNativeArtifact(directory, architecture = "arm64") {
  const staging = join(directory, "staging"); await mkdir(staging, { recursive: true });
  const contents = new Map([["LICENSE", Buffer.from("journal native license\n")], ["NOTICE", Buffer.from("journal native notice\n")],
    ["installation-journal-session-v1", Buffer.from("fixture journal native helper\n")]]);
  for (const [name, bytes] of contents) await writeFile(join(staging, name), bytes,
    { mode: name === "installation-journal-session-v1" ? 0o755 : 0o644 });
  const files = [...contents].map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: sha256(bytes),
    mode: path === "installation-journal-session-v1" ? "0755" : "0644" }));
  const manifest = { schema: "control-room.installation-journal-native-artifact/v1", platform: "darwin", architecture,
    minimumMacos: "13.0", protocol: "ACRJNL1", sourceSha256: "b".repeat(64),
    toolchain: { compiler: "Apple clang version 16.0.0", sdkVersion: "16.0",
      flags: [...INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1] }, files, ownerQualified: false };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(staging, "INSTALLATION_JOURNAL_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  const root = `agent-control-room-installation-journal-darwin-${architecture}`;
  const archive = await createDeterministicTarGzipV1(staging, root, [...files.map(({ path, mode }) => ({ path, mode })),
    { path: "INSTALLATION_JOURNAL_MANIFEST.json", mode: "0644" }]);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "INSTALLATION_JOURNAL_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  await writeFile(join(directory, `${root}.tar.gz`), archive, { mode: 0o644 });
  await writeFile(join(directory, "SHA256SUMS"), `${sha256(archive)}  ${root}.tar.gz\n`, { mode: 0o644 });
  await rm(staging, { recursive: true, force: true });
}

async function extract(archive, destination) {
  await run("tar", ["-xzf", archive, "-C", destination]);
  return join(destination, "agent-control-room-macos-0.1.0");
}

before(async () => {
  suiteRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-macos-launcher-")));
  releaseDirectory = join(suiteRoot, "release");
  await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: releaseDirectory });
  nativeArtifactDirectory = join(suiteRoot, "native-artifact");
  await writeNativeArtifact(nativeArtifactDirectory);
  journalNativeArtifactDirectory = join(suiteRoot, "journal-native-artifact");
  await writeJournalNativeArtifact(journalNativeArtifactDirectory);
  const output = join(suiteRoot, "bundle-output");
  assembled = await assembleMacosLocalLauncherBundleV1({ sourceRoot: repository, releaseDirectory,
    nativeArtifactDirectory, journalNativeArtifactDirectory, outputDirectory: output });
  bundleRoot = await extract(join(output, assembled.archiveName), suiteRoot);
  installedConfigurationNativeArtifactDirectory = join(suiteRoot, "configuration-artifact");
  macosServiceNativeArtifactDirectory = join(suiteRoot, "service-artifact");
  await writeExpandedNativeArtifact(installedConfigurationNativeArtifactDirectory, "installed-configuration");
  await writeExpandedNativeArtifact(macosServiceNativeArtifactDirectory, "macos-service");
  expandedAssembled = await assembleMacosLocalLauncherBundleV2(expandedInput(join(suiteRoot, "expanded-output")));
  const expandedExtraction = join(suiteRoot, "expanded-extracted"); await mkdir(expandedExtraction);
  expandedBundleRoot = await extract(join(suiteRoot, "expanded-output", expandedAssembled.archiveName), expandedExtraction);
  claudeCodeProcessNativeArtifactDirectory = join(suiteRoot, "claude-process-artifact");
  await writeClaudeProcessNativeArtifact(claudeCodeProcessNativeArtifactDirectory);
  claudeBoundAssembled = await assembleMacosLocalLauncherBundleV3(
    claudeBoundInput(join(suiteRoot, "claude-bound-output")));
  const claudeExtraction = join(suiteRoot, "claude-bound-extracted"); await mkdir(claudeExtraction);
  claudeBoundBundleRoot = await extract(join(suiteRoot, "claude-bound-output", claudeBoundAssembled.archiveName), claudeExtraction);
});

after(async () => {
  await rm(suiteRoot, { recursive: true, force: true });
});

test("assembles one deterministic macOS asset with an executable Finder launcher", async () => {
  assert.equal(assembled.assetCount, 1);
  assert.equal(assembled.deterministic, true);
  assert.equal(assembled.platform, "darwin");
  assert.equal(assembled.nodePrerequisite, ">=22.13.0");
  assert.equal(assembled.installsNode, false);
  const secondOutput = join(suiteRoot, "bundle-output-second");
  const second = await assembleMacosLocalLauncherBundleV1({ sourceRoot: repository, releaseDirectory,
    nativeArtifactDirectory, journalNativeArtifactDirectory, outputDirectory: secondOutput });
  assert.equal(second.archiveSha256, assembled.archiveSha256);
  assert.deepEqual(await readFile(join(secondOutput, second.archiveName)),
    await readFile(join(suiteRoot, "bundle-output", assembled.archiveName)));
  const command = join(bundleRoot, "Open Agent Control Room.command");
  assert.notEqual((await lstat(command)).mode & 0o111, 0);
  const source = await readFile(command, "utf8");
  assert.match(source, /Node\.js 22\.13 or later/u);
  assert.doesNotMatch(source, /curl|wget|brew|npm install/u);
  await run("/bin/sh", ["-n", command]);
  const verified = await verifyExtractedMacosLocalLauncherBundleV1(bundleRoot);
  assert.equal(verified.verified, true); assert.equal(verified.version, "0.1.0"); assert.equal(verified.fileCount, 19);
  assert.equal(verified.releaseManifestDigest, `sha256:${createHash("sha256").update(await readFile(join(bundleRoot,
    "release", "agent-control-room-0.1.0.manifest.json"))).digest("hex")}`);
  assert.equal(verified.protectedDirectoryNativeSidecar.executableSha256, assembled.protectedDirectoryNativeSidecar.executableSha256);
  assert.equal(verified.installationJournalNativeSidecar.executableSha256,
    assembled.installationJournalNativeSidecar.executableSha256);
  assert.equal(verified.installationJournalNativeSidecar.sidecarManifestSha256,
    assembled.installationJournalNativeSidecar.sidecarManifestSha256);
});

test("expanded v2 deterministically binds four inert sidecars and both extracted runtimes remain self-contained", async () => {
  const second = await assembleMacosLocalLauncherBundleV2(expandedInput(join(suiteRoot, "expanded-second")));
  assert.equal(second.archiveSha256, expandedAssembled.archiveSha256);
  assert.equal(second.schema, "control-room.macos-local-launcher-bundle/v2");
  const verified = await verifyExtractedMacosLocalLauncherBundleV1(expandedBundleRoot);
  assert.equal(verified.fileCount, 31);
  assert.equal(verified.outerLauncherManifestSha256, expandedAssembled.outerLauncherManifestSha256);
  assert.equal(verified.outerLauncherManifestSha256,
    `sha256:${sha256(await readFile(join(expandedBundleRoot, "MACOS_LAUNCHER_MANIFEST.json")))}`);
  for (const [name, protocol] of [["protectedDirectoryNativeSidecar", "ACRDIR1"],
    ["installationJournalNativeSidecar", "ACRJNL1"], ["installedConfigurationNativeSidecar", "ACRCFG1"],
    ["macosServiceNativeSidecar", "ACRSVC1"]]) {
    assert.equal(verified[name].protocol, protocol);
    assert.equal(verified[name].architecture, "arm64");
    assert.equal(verified[name].releaseVersion, "0.1.0");
    assert.deepEqual(verified[name], expandedAssembled[name]);
  }
  assert.equal(verified.macosServiceNativeSidecar.releaseSha256, verified.releaseManifestDigest);
  const manifest = JSON.parse(await readFile(join(expandedBundleRoot, "MACOS_LAUNCHER_MANIFEST.json"), "utf8"));
  assert.deepEqual(manifest.files.filter(file => file.mode === "0755").map(file => file.path),
    ["Open Agent Control Room.command", "native/macos-service/macos-service-v1"]);
  for (const root of [bundleRoot, expandedBundleRoot]) {
    const extractedModule = await import(pathToFileURL(join(root, "runtime/macos-local-launcher-bundle.mjs")).href);
    assert.equal((await extractedModule.verifyExtractedMacosLocalLauncherBundleV1(root)).verified, true);
  }
});

test("v3 ships one exact release-bound Claude process sidecar without installing or invoking it", async () => {
  const second = await assembleMacosLocalLauncherBundleV3(
    claudeBoundInput(join(suiteRoot, "claude-bound-second")));
  assert.equal(second.archiveSha256, claudeBoundAssembled.archiveSha256);
  assert.equal(second.schema, "control-room.macos-local-launcher-bundle/v3");
  assert.deepEqual(second.claudeCodeProcessNativeSidecar, claudeBoundAssembled.claudeCodeProcessNativeSidecar);
  const verified = await verifyExtractedMacosLocalLauncherBundleV1(claudeBoundBundleRoot);
  assert.equal(second.claudeCodeProcessNativeSidecar.releaseSha256, verified.releaseManifestDigest);
  assert.equal(second.claudeCodeProcessNativeSidecar.protocol, "ACRCCP1");
  assert.equal(second.claudeCodeProcessNativeSidecar.architecture, "arm64");
  assert.equal(second.claudeCodeProcessNativeSidecar.installs, false);
  assert.equal(second.claudeCodeProcessNativeSidecar.compiles, false);
  assert.equal(second.claudeCodeProcessNativeSidecar.downloads, false);
  assert.equal(verified.schema, "control-room.macos-local-launcher-bundle/v3");
  assert.equal(verified.fileCount, 36);
  assert.deepEqual(verified.claudeCodeProcessNativeSidecar, second.claudeCodeProcessNativeSidecar);
  const manifest = JSON.parse(await readFile(join(claudeBoundBundleRoot, "MACOS_LAUNCHER_MANIFEST.json"), "utf8"));
  assert.deepEqual(manifest.files.filter(file => file.path.startsWith("native/claude-code-process/"))
    .map(file => file.path), [
    "native/claude-code-process/CLAUDE_CODE_PROCESS_MANIFEST.json",
    "native/claude-code-process/MACOS_CLAUDE_CODE_PROCESS_SIDECAR.json",
    "native/claude-code-process/SHA256SUMS",
    "native/claude-code-process/agent-control-room-claude-code-process-darwin-arm64.tar.gz",
  ]);
  assert.deepEqual(manifest.files.filter(file => file.path.startsWith("native/claude-code-process/"))
    .map(file => file.mode), ["0644", "0644", "0644", "0644"]);
  const releaseCustody = consumeMacosLocalLauncherInstalledConfigurationVerifierCustodyV1(verified);
  assert.equal(releaseCustody.claudeProcessSidecarRoot,
    join(claudeBoundBundleRoot, "native/claude-code-process"));
  assert.deepEqual(releaseCustody.claudeProcessSidecar, second.claudeCodeProcessNativeSidecar);
});

test("v3 manifest preparation consumes exact launcher custody and emits only inert owner-write bytes", async () => {
  const verified = await verifyExtractedMacosLocalLauncherBundleV1(claudeBoundBundleRoot);
  const configurationPlan = preparePrivateInstalledConfigurationV1(installedConfigurationSourceForLauncher(verified));
  const prepared = preparePrivateInstalledConfigurationV3MaterializationV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
    configurationPlan, verifiedLauncherBundle: verified,
  });
  assert.equal(prepared.status, "ready_for_owner_attended_materialization");
  assert.equal(prepared.manifest.schema, "control-room.private-installed-configuration-custody/v3");
  assert.deepEqual(prepared.preflight, { status: "passed", exactVerifiedLauncherBound: true,
    exactConfigurationVerifierBound: true,
    exactJournalSidecarBound: true, exactClaudeProcessSidecarBound: true,
    evidenceDigest: prepared.preflight.evidenceDigest });
  assert.deepEqual(prepared.rollback, { status: "not_required_before_materialization",
    previousInstallationUnchanged: true, createdPaths: 0, cleanupRequired: false,
    evidenceDigest: prepared.rollback.evidenceDigest });
  assert.equal(prepared.performsEffect, false); assert.equal(prepared.writesProtectedFiles, false);
  assert.equal(prepared.containsProtectedPath, false); assert.equal(prepared.containsConfigurationBytes, false);
  assert.equal(prepared.containsHelperPath, false); assert.equal(prepared.containsVerifier, false);
  const redacted = JSON.stringify(prepared);
  assert.doesNotMatch(redacted, /example-owner|private-authority|owner-held|\.acr-|sidecarRoot/u);
  assert.throws(() => consumeMacosLocalLauncherV3ManifestMaterializationCustodyV1(verified), refusal,
    "manifest preparation burns only its data-only launcher custody");
  assert.throws(() => consumeMacosLocalLauncherInstalledConfigurationVerifierCustodyV1(verified), refusal,
    "the raw launcher cannot release verifier custody after the materialization chain begins");
  const publication = composePrivateInstalledConfigurationV3MaterializationPublicationV1(prepared);
  assert.equal(publication.status, "opaque_owner_materialization_ready");
  assert.equal(publication.performsEffect, false); assert.equal(publication.writesProtectedFiles, false);
  assert.equal(publication.acceptsPath, false); assert.equal(publication.acceptsVerifier, false);
  assert.equal(publication.acceptsHelperBytes, false); assert.equal(publication.acceptsConfiguration, false);
  assert.equal("manifestPath" in publication, false); assert.equal("manifestBytes" in publication, false);
  assert.throws(() => consumePrivateInstalledConfigurationV3MaterializationCapabilityV1({
    ...publication.materializationCapability,
  }), /refused/u, "a structural materialization capability has no authority");
  const materialization = consumePrivateInstalledConfigurationV3MaterializationCapabilityV1(
    publication.materializationCapability);
  const manifest = JSON.parse(Buffer.from(materialization.manifestBytes).toString("utf8"));
  assert.equal(manifest.schema, "control-room.private-installed-configuration-custody/v3");
  assert.deepEqual(manifest.claudeCodeProcessNativeSidecar, {
    schema: "control-room.private-installed-claude-process-sidecar-identity/v1",
    releaseVersion: verified.version, releaseSha256: verified.releaseManifestDigest,
    sidecarManifestSha256: verified.claudeCodeProcessNativeSidecar.sidecarManifestSha256,
    archiveSha256: verified.claudeCodeProcessNativeSidecar.archiveSha256,
    artifactManifestSha256: verified.claudeCodeProcessNativeSidecar.artifactManifestSha256,
    executableSha256: verified.claudeCodeProcessNativeSidecar.executableSha256,
    platform: "darwin", architecture: verified.claudeCodeProcessNativeSidecar.architecture,
    minimumMacos: "13.0", protocol: "ACRCCP1",
  });
  assert.equal(manifest.journal.nativeSidecar.outerLauncherManifestSha256,
    verified.outerLauncherManifestSha256);
  const writerCustody = consumeMacosLocalLauncherInstalledConfigurationWriterContinuationV1(
    materialization.nativeWriterContinuation);
  assert.throws(() => consumeMacosLocalLauncherInstalledConfigurationVerifierContinuationV1({
    ...writerCustody.postWriteVerifierContinuation,
  }), refusal, "a structural post-write continuation has no verifier custody");
  const laterVerifierCustody = consumeMacosLocalLauncherInstalledConfigurationVerifierContinuationV1(
    writerCustody.postWriteVerifierContinuation);
  assert.equal(laterVerifierCustody.releaseManifestDigest, verified.releaseManifestDigest);
  assert.deepEqual(laterVerifierCustody.claudeProcessSidecar, verified.claudeCodeProcessNativeSidecar,
    "the later verifier comes only from the exact launcher used for this manifest");
  assert.throws(() => consumePrivateInstalledConfigurationV3MaterializationCapabilityV1(
    publication.materializationCapability), /refused/u, "materialization capability is one-use");
  assert.throws(() => consumeMacosLocalLauncherInstalledConfigurationWriterContinuationV1(
    materialization.nativeWriterContinuation), refusal, "writer continuation is one-use");
  assert.throws(() => consumeMacosLocalLauncherInstalledConfigurationVerifierContinuationV1(
    writerCustody.postWriteVerifierContinuation), refusal, "verifier continuation is one-use");
  assert.throws(() => composePrivateInstalledConfigurationV3MaterializationPublicationV1(prepared), /refused/u,
    "exact bytes are one-use");
});

test("v3 manifest preparation rejects look-alikes, substitutions, incomplete binding, and replay", async () => {
  const extraFieldReport = await verifyExtractedMacosLocalLauncherBundleV1(claudeBoundBundleRoot);
  const extraFieldPlan = preparePrivateInstalledConfigurationV1(installedConfigurationSourceForLauncher(extraFieldReport));
  for (const extra of [
    { helperPath: "/tmp/helper" }, { helperBytes: Uint8Array.of(1) },
    { verifier: { verifyProtectedPath() {} } }, { configuration: { arbitrary: true } },
  ]) assert.throws(() => preparePrivateInstalledConfigurationV3MaterializationV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
    configurationPlan: extraFieldPlan, verifiedLauncherBundle: extraFieldReport, ...extra,
  }), /refused/u);

  const clonedReport = await verifyExtractedMacosLocalLauncherBundleV1(claudeBoundBundleRoot);
  const clonedReportPlan = preparePrivateInstalledConfigurationV1(installedConfigurationSourceForLauncher(clonedReport));
  assert.throws(() => preparePrivateInstalledConfigurationV3MaterializationV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
    configurationPlan: clonedReportPlan, verifiedLauncherBundle: { ...clonedReport },
  }), /refused/u, "a structural launcher report has no custody");

  const clonedPlanReport = await verifyExtractedMacosLocalLauncherBundleV1(claudeBoundBundleRoot);
  const clonedPlan = preparePrivateInstalledConfigurationV1(installedConfigurationSourceForLauncher(clonedPlanReport));
  assert.throws(() => preparePrivateInstalledConfigurationV3MaterializationV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
    configurationPlan: structuredClone(clonedPlan), verifiedLauncherBundle: clonedPlanReport,
  }), /refused/u, "a structural configuration plan has no captured bytes");

  const substitutedReport = await verifyExtractedMacosLocalLauncherBundleV1(claudeBoundBundleRoot);
  const substitutedPlan = preparePrivateInstalledConfigurationV1(installedConfigurationSourceForLauncher(substitutedReport,
    { nativeSidecar: { executableSha256: `sha256:${"f".repeat(64)}` } }));
  assert.throws(() => preparePrivateInstalledConfigurationV3MaterializationV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
    configurationPlan: substitutedPlan, verifiedLauncherBundle: substitutedReport,
  }), /refused/u, "the journal helper identity cannot be substituted");
  assert.throws(() => preparePrivateInstalledConfigurationV3MaterializationV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
    configurationPlan: substitutedPlan, verifiedLauncherBundle: substitutedReport,
  }), /refused/u, "a failed binding cannot be retried with replacement input");

  const incompleteReport = await verifyExtractedMacosLocalLauncherBundleV1(expandedBundleRoot);
  const incompletePlan = preparePrivateInstalledConfigurationV1(installedConfigurationSourceForLauncher(incompleteReport));
  assert.throws(() => preparePrivateInstalledConfigurationV3MaterializationV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
    configurationPlan: incompletePlan, verifiedLauncherBundle: incompleteReport,
  }), /refused/u, "a v2 launcher cannot materialize a v3 Claude manifest");
});

test("v3 owner writer accepts only the opaque exact-plan capability and explicit owner invocation", async () => {
  const verified = await verifyExtractedMacosLocalLauncherBundleV1(claudeBoundBundleRoot);
  const source = { ...installedConfigurationSourceForLauncher(verified),
    standardProtectedRootPath: join(homedir(), "Library", "Application Support", "Agent Control Room", "Protected"),
    expectedOwnerUid: typeof process.geteuid === "function" ? process.geteuid() : 501 };
  const configurationPlan = preparePrivateInstalledConfigurationV1(source);
  const prepared = preparePrivateInstalledConfigurationV3MaterializationV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
    configurationPlan, verifiedLauncherBundle: verified,
  });
  const publication = composePrivateInstalledConfigurationV3MaterializationPublicationV1(prepared);
  assert.throws(() => createPrivateInstalledConfigurationV3OwnerWriterV1(
    { ...publication.materializationCapability }), /refused/u,
  "a structural copy cannot select bytes, paths, helper, or configuration");
  const writer = createPrivateInstalledConfigurationV3OwnerWriterV1(publication.materializationCapability);
  assert.deepEqual({ schema: writer.schema, status: writer.status, oneUse: writer.oneUse,
    acceptsPath: writer.acceptsPath, acceptsBytes: writer.acceptsBytes,
    acceptsConfiguration: writer.acceptsConfiguration, acceptsNativeCallback: writer.acceptsNativeCallback,
    performsEffectOnConstruction: writer.performsEffectOnConstruction }, {
    schema: "control-room.private-installed-configuration-v3-owner-writer/v1",
    status: "ready_for_explicit_owner_attended_write", oneUse: true,
    acceptsPath: false, acceptsBytes: false, acceptsConfiguration: false,
    acceptsNativeCallback: false, performsEffectOnConstruction: false });
  assert.doesNotMatch(JSON.stringify(writer), /example-owner|operator\.json|installed-manifest|sidecarRoot/u);
  assert.throws(() => createPrivateInstalledConfigurationV3OwnerWriterV1(
    publication.materializationCapability), /refused/u, "the exact preparation capability cannot be replayed");
  await assert.rejects(writer.materialize({ schema: PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITE_REQUEST_V1,
    ownerAttended: true, signal: new AbortController().signal, deadlineUnixMs: Date.now() + 1_000,
    manifestPath: "/tmp/substitution" }), /refused/u,
  "the owner invocation accepts no path or byte substitution");
  await assert.rejects(writer.materialize({ schema: PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITE_REQUEST_V1,
    ownerAttended: false, signal: new AbortController().signal, deadlineUnixMs: Date.now() + 1_000 }), /refused/u,
  "the future runtime must make the owner-attended invocation explicit");
});

test("a same-release second launcher cannot replace the verifier continuation bound to plan A", async () => {
  const secondArtifact = join(suiteRoot, "claude-process-second-valid");
  await writeClaudeProcessNativeArtifact(secondArtifact, "arm64", " B");
  const secondOutput = join(suiteRoot, "claude-bound-second-valid-output");
  const secondAssembly = await assembleMacosLocalLauncherBundleV3({
    ...claudeBoundInput(secondOutput), claudeCodeProcessNativeArtifactDirectory: secondArtifact,
  });
  const secondExtraction = join(suiteRoot, "claude-bound-second-valid-extracted"); await mkdir(secondExtraction);
  const secondRoot = await extract(join(secondOutput, secondAssembly.archiveName), secondExtraction);
  const reportA = await verifyExtractedMacosLocalLauncherBundleV1(claudeBoundBundleRoot);
  const reportB = await verifyExtractedMacosLocalLauncherBundleV1(secondRoot);
  assert.equal(reportA.releaseManifestDigest, reportB.releaseManifestDigest,
    "the hostile case deliberately shares the portable release digest");
  assert.notEqual(reportA.outerLauncherManifestSha256, reportB.outerLauncherManifestSha256);
  assert.notEqual(reportA.claudeCodeProcessNativeSidecar.executableSha256,
    reportB.claudeCodeProcessNativeSidecar.executableSha256);
  const publicationFor = report => composePrivateInstalledConfigurationV3MaterializationPublicationV1(
    preparePrivateInstalledConfigurationV3MaterializationV1({
      schema: PRIVATE_INSTALLED_CONFIGURATION_V3_MATERIALIZATION_PREPARATION_V1,
      configurationPlan: preparePrivateInstalledConfigurationV1(installedConfigurationSourceForLauncher(report)),
      verifiedLauncherBundle: report,
    }));
  const publicationA = publicationFor(reportA), publicationB = publicationFor(reportB);
  const materializationA = consumePrivateInstalledConfigurationV3MaterializationCapabilityV1(
    publicationA.materializationCapability);
  const materializationB = consumePrivateInstalledConfigurationV3MaterializationCapabilityV1(
    publicationB.materializationCapability);
  const freshReportB = await verifyExtractedMacosLocalLauncherBundleV1(secondRoot);
  const exactOwnerRoot = join(homedir(), "Library", "Application Support", "Agent Control Room", "Protected");
  const currentOwnerUid = typeof process.geteuid === "function" ? process.geteuid() : 501;
  const hostileInstallation = {
    installationId: materializationA.installationId,
    releaseDigest: materializationA.releaseDigest,
    planDigest: materializationA.planDigest,
    protectedRootPath: exactOwnerRoot,
    expectedOwnerUid: currentOwnerUid,
    verificationDeadlineMs: materializationA.verificationDeadlineMs,
    configurationBytes: materializationA.configurationBytes,
    configurationSha256: materializationA.configurationSha256,
    manifestBytes: materializationA.manifestBytes,
    manifestSha256: materializationA.manifestSha256,
  };
  assert.throws(() => createPrivateInstalledConfigurationNativeVerifierCustodyV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_VERIFIER_CUSTODY_V1,
    verifiedLauncherBundle: freshReportB,
    installation: hostileInstallation,
  }), /native_verifier_custody_refused/u,
  "the legacy concrete verifier refuses A bytes paired with a fresh V3 launcher B report");
  const freshV2Report = await verifyExtractedMacosLocalLauncherBundleV1(expandedBundleRoot);
  assert.equal(freshV2Report.releaseManifestDigest, materializationA.releaseDigest,
    "the second hostile case uses a V2 launcher with the same portable release");
  assert.throws(() => createPrivateInstalledConfigurationNativeVerifierCustodyV1({
    schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_VERIFIER_CUSTODY_V1,
    verifiedLauncherBundle: freshV2Report, installation: hostileInstallation,
  }), /native_verifier_custody_refused/u,
  "a legacy V2 launcher cannot be paired with A's V3 manifest bytes");
  assert.throws(() => createPrivateInstalledConfigurationV3NativeVerifierCustodyV1({
    schema: "control-room.private-installed-configuration-v3-post-write-verification-capability/v1",
  }), /owner_writer_refused/u,
  "the V3 concrete verifier accepts only the writer-minted opaque post-write binding");
  assert.throws(() => Object.assign(materializationA, {
    nativeWriterContinuation: materializationB.nativeWriterContinuation,
  }), TypeError, "the exact A bytes and A continuation cannot be recombined with B");
  const writerA = consumeMacosLocalLauncherInstalledConfigurationWriterContinuationV1(
    materializationA.nativeWriterContinuation);
  const writerB = consumeMacosLocalLauncherInstalledConfigurationWriterContinuationV1(
    materializationB.nativeWriterContinuation);
  const verifierA = consumeMacosLocalLauncherInstalledConfigurationVerifierContinuationV1(
    writerA.postWriteVerifierContinuation);
  const verifierB = consumeMacosLocalLauncherInstalledConfigurationVerifierContinuationV1(
    writerB.postWriteVerifierContinuation);
  assert.deepEqual(verifierA.claudeProcessSidecar, reportA.claudeCodeProcessNativeSidecar);
  assert.deepEqual(verifierB.claudeProcessSidecar, reportB.claudeCodeProcessNativeSidecar);
  assert.notDeepEqual(verifierA.claudeProcessSidecar, verifierB.claudeProcessSidecar);
});

test("v3 refuses missing, changed, or mixed-architecture Claude helper input without publishing", async () => {
  const changed = join(suiteRoot, "claude-process-changed");
  await writeClaudeProcessNativeArtifact(changed);
  await writeFile(join(changed, "agent-control-room-claude-code-process-darwin-arm64.tar.gz"), "changed\n");
  const mixed = join(suiteRoot, "claude-process-x64"); await writeClaudeProcessNativeArtifact(mixed, "x64");
  for (const [name, value] of [["missing", undefined], ["changed", changed], ["mixed", mixed]]) {
    const outputDirectory = join(suiteRoot, `claude-${name}-output`);
    const input = { ...claudeBoundInput(outputDirectory), claudeCodeProcessNativeArtifactDirectory: value };
    if (value === undefined) delete input.claudeCodeProcessNativeArtifactDirectory;
    await assert.rejects(assembleMacosLocalLauncherBundleV3(input), refusal);
    await assert.rejects(access(outputDirectory), error => error?.code === "ENOENT");
  }
});

test("v3 verifier refuses mixed release/helper bytes before any installation-root effect", async () => {
  const destination = join(suiteRoot, "claude-bound-mutated"); await mkdir(destination);
  const root = await extract(join(suiteRoot, "claude-bound-output", claudeBoundAssembled.archiveName), destination);
  const path = join(root, "native/claude-code-process/MACOS_CLAUDE_CODE_PROCESS_SIDECAR.json");
  const sidecar = JSON.parse(await readFile(path, "utf8"));
  sidecar.releaseSha256 = `sha256:${"f".repeat(64)}`;
  const bytes = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`); await writeFile(path, bytes);
  const outerPath = join(root, "MACOS_LAUNCHER_MANIFEST.json");
  const outer = JSON.parse(await readFile(outerPath, "utf8"));
  const entry = outer.files.find(file => file.path === "native/claude-code-process/MACOS_CLAUDE_CODE_PROCESS_SIDECAR.json");
  entry.bytes = bytes.length; entry.sha256 = sha256(bytes);
  await writeFile(outerPath, `${JSON.stringify(outer, null, 2)}\n`);
  await assert.rejects(verifyExtractedMacosLocalLauncherBundleV1(root), refusal);
  const installRoot = join(destination, "must-not-exist"); let calls = 0;
  await assert.rejects(runMacosLocalLauncherBundleV1({ bundleRoot: root, homeDirectory: suiteRoot, installRoot }, {
    platform: "darwin", architecture: "arm64", nodeVersion: "22.13.0", macosVersion: "13.0",
    runner: async () => { calls += 1; },
  }), refusal);
  assert.equal(calls, 0);
  await assert.rejects(access(installRoot), error => error?.code === "ENOENT");
});

test("expanded verification mints one opaque concrete configuration-verifier custody and rejects look-alikes", async () => {
  const verified = await verifyExtractedMacosLocalLauncherBundleV1(expandedBundleRoot);
  const configurationBytes = Uint8Array.from(Buffer.from("{\"protected\":true}\n", "utf8"));
  const manifestBytes = Uint8Array.from(Buffer.from("{\"schema\":\"not-read-during-composition\"}\n", "utf8"));
  const installation = {
    installationId: "local-control-room", releaseDigest: verified.releaseManifestDigest,
    planDigest: `sha256:${"e".repeat(64)}`,
    protectedRootPath: join(homedir(), "Library", "Application Support", "Agent Control Room", "Protected"),
    expectedOwnerUid: typeof process.geteuid === "function" ? process.geteuid() : 501,
    verificationDeadlineMs: 1_000, configurationBytes,
    configurationSha256: `sha256:${sha256(configurationBytes)}`, manifestBytes,
    manifestSha256: `sha256:${sha256(manifestBytes)}`,
  };
  const input = { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_VERIFIER_CUSTODY_V1,
    verifiedLauncherBundle: verified, installation };

  assert.throws(() => createPrivateInstalledConfigurationNativeVerifierCustodyV1({ ...input,
    verifiedLauncherBundle: { ...verified } }), /refused/u,
  "a field-identical plain report has no verifier provenance");
  assert.throws(() => createPrivateInstalledConfigurationNativeVerifierCustodyV1({ ...input,
    installation: { ...installation, protectedRootPath: join(suiteRoot, "caller-selected") } }),
  /native_verifier_custody_refused/u, "the caller cannot choose the protected path");
  assert.throws(() => createPrivateInstalledConfigurationNativeVerifierCustodyV1({ ...input,
    installation: { ...installation, native: { verifyProtectedPath() {} } } }),
  /native_verifier_custody_refused/u, "there is no structural native-verifier input");

  const before = (await readdir(await realpath(tmpdir()))).filter(name => name.startsWith(".acr-installed-configuration-sidecar-"));
  const composed = createPrivateInstalledConfigurationNativeVerifierCustodyV1(input);
  assert.deepEqual({ status: composed.status, performsEffectOnConstruction: composed.performsEffectOnConstruction,
    acceptsNativeVerifierCallback: composed.acceptsNativeVerifierCallback, acceptsHelperPath: composed.acceptsHelperPath,
    acceptsProtectedRootPathOverride: composed.acceptsProtectedRootPathOverride,
    retainsCredentialValueInPublicConfiguration: composed.retainsCredentialValueInPublicConfiguration,
    nextReleaseBoundary: composed.nextReleaseBoundary }, {
    status: "protected_native_verifier_bound", performsEffectOnConstruction: false,
    acceptsNativeVerifierCallback: false, acceptsHelperPath: false, acceptsProtectedRootPathOverride: false,
    retainsCredentialValueInPublicConfiguration: false, nextReleaseBoundary: "ship_and_bind_claude_process_sidecar",
  });
  assert.equal("verifiedLauncherBundle" in composed, false); assert.equal("installation" in composed, false);
  assert.throws(() => consumeMacosLocalLauncherInstalledConfigurationVerifierCustodyV1(verified), refusal,
    "the composer burns launcher custody exactly once");
  await assert.rejects(composed.custody.loadManifestBoundPrivateConfigurationData(),
    /private_installed_configuration_native_verifier_custody_refused/u);
  await assert.rejects(composed.custody.loadManifestBoundPrivateConfigurationData(),
    /private_installed_configuration_native_verifier_custody_refused/u, "a failed native read cannot select a replacement");
  const after = (await readdir(await realpath(tmpdir()))).filter(name => name.startsWith(".acr-installed-configuration-sidecar-"));
  assert.deepEqual(after, before, "failed disposable verification retires only its own staging directory");
});

test("expanded x64 packaging remains inert and mismatched host or old macOS refuses before owner-root writes", async () => {
  const input = expandedInput(join(suiteRoot, "expanded-x64-output"));
  input.nativeArtifactDirectory = join(suiteRoot, "protected-x64");
  input.journalNativeArtifactDirectory = join(suiteRoot, "journal-x64");
  input.installedConfigurationNativeArtifactDirectory = join(suiteRoot, "configuration-x64");
  input.macosServiceNativeArtifactDirectory = join(suiteRoot, "service-x64");
  await writeNativeArtifact(input.nativeArtifactDirectory, "x64");
  await writeJournalNativeArtifact(input.journalNativeArtifactDirectory, "x64");
  await writeExpandedNativeArtifact(input.installedConfigurationNativeArtifactDirectory, "installed-configuration", "x64");
  await writeExpandedNativeArtifact(input.macosServiceNativeArtifactDirectory, "macos-service", "x64");
  const report = await assembleMacosLocalLauncherBundleV2(input);
  const destination = join(suiteRoot, "expanded-x64-extracted"); await mkdir(destination);
  const root = await extract(join(input.outputDirectory, report.archiveName), destination);
  const verified = await verifyExtractedMacosLocalLauncherBundleV1(root);
  assert.equal(verified.installedConfigurationNativeSidecar.architecture, "x64");
  assert.equal(verified.macosServiceNativeSidecar.architecture, "x64");
  const installRoot = join(destination, "must-not-exist");
  for (const [architecture, macosVersion] of [["arm64", "13.0"], ["x64", "12.0"]]) {
    await assert.rejects(runMacosLocalLauncherBundleV1({ bundleRoot: root, homeDirectory: suiteRoot, installRoot }, {
      platform: "darwin", architecture, macosVersion, nodeVersion: "22.13.0",
      runner: async () => { throw new Error("must not run"); },
    }), { message: "macos_local_launcher_unsupported_platform" });
    await assert.rejects(access(installRoot), error => error?.code === "ENOENT");
  }
});

test("expanded assembly refuses missing, substituted, and mixed-architecture new inputs without publishing", async () => {
  for (const [kind, key] of [["installed-configuration", "installedConfigurationNativeArtifactDirectory"],
    ["macos-service", "macosServiceNativeArtifactDirectory"]]) {
    const mixed = join(suiteRoot, `${kind}-mixed`); await writeExpandedNativeArtifact(mixed, kind, "x64");
    const bad = join(suiteRoot, `${kind}-bad`); await writeExpandedNativeArtifact(bad, kind);
    await writeFile(join(bad, kind === "macos-service" ? "macos-service-v1"
      : "agent-control-room-installed-configuration-darwin-arm64.tar.gz"), "substituted\n");
    for (const [name, value] of [["mixed", mixed], ["bad", bad], ["missing", undefined]]) {
      const output = join(suiteRoot, `${kind}-${name}-output`);
      const input = { ...expandedInput(output), [key]: value };
      if (value === undefined) delete input[key];
      await assert.rejects(assembleMacosLocalLauncherBundleV2(input), refusal);
      await assert.rejects(access(output), error => error?.code === "ENOENT");
    }
  }
});

test("expanded verifier rejects coherent sidecar mismatches and unsafe inventory before owner-root writes", async () => {
  async function rewriteSidecar(root, path, change) {
    const value = JSON.parse(await readFile(join(root, path), "utf8")); change(value);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); await writeFile(join(root, path), bytes);
    const manifestPath = join(root, "MACOS_LAUNCHER_MANIFEST.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.files.find(file => file.path === path); entry.sha256 = sha256(bytes); entry.bytes = bytes.length;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const [name, mutate] of [
    ["configuration-release", root => rewriteSidecar(root, "native/installed-configuration/MACOS_INSTALLED_CONFIGURATION_SIDECAR.json",
      value => { value.releaseVersion = "0.1.1"; })],
    ["service-release", root => rewriteSidecar(root, "native/macos-service/MACOS_SERVICE_NATIVE_SIDECAR.json",
      value => { value.releaseSha256 = `sha256:${"f".repeat(64)}`; })],
    ["service-version", root => rewriteSidecar(root, "native/macos-service/MACOS_SERVICE_NATIVE_SIDECAR.json",
      value => { value.releaseVersion = "0.1.1"; })],
    ["service-mode", root => chmod(join(root, "native/macos-service/macos-service-v1"), 0o644)],
    ["missing-configuration", root => unlink(join(root, "native/installed-configuration/INSTALLED_CONFIGURATION_MANIFEST.json"))],
    ["missing-service", root => unlink(join(root, "native/macos-service/macos-service-v1"))],
    ["extra-member", root => writeFile(join(root, "native/macos-service/extra"), "extra\n")],
    ["downgraded-schema", async root => {
      const path = join(root, "MACOS_LAUNCHER_MANIFEST.json"), manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.schema = "control-room.macos-local-launcher-bundle/v1";
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }],
  ]) {
    const destination = join(suiteRoot, `expanded-mutation-${name}`); await mkdir(destination);
    const root = await extract(join(suiteRoot, "expanded-output", expandedAssembled.archiveName), destination);
    await mutate(root);
    await assert.rejects(verifyExtractedMacosLocalLauncherBundleV1(root), refusal, name);
    const installRoot = join(destination, "must-not-exist"); let calls = 0;
    await assert.rejects(runMacosLocalLauncherBundleV1({ bundleRoot: root, homeDirectory: suiteRoot, installRoot }, {
      platform: "darwin", architecture: "arm64", nodeVersion: "22.13.0", macosVersion: "13.0",
      runner: async () => { calls += 1; },
    }), refusal);
    assert.equal(calls, 0); await assert.rejects(access(installRoot), error => error?.code === "ENOENT");
  }
});

test("refuses substituted journal input and mixed native architectures before publishing an output", async () => {
  const substitutedRoot = join(suiteRoot, "journal-native-substituted");
  await writeJournalNativeArtifact(substitutedRoot, "arm64");
  await writeFile(join(substitutedRoot, "agent-control-room-installation-journal-darwin-arm64.tar.gz"),
    Buffer.from("substituted\n"));
  const substitutedOutput = join(suiteRoot, "substituted-output");
  await assert.rejects(assembleMacosLocalLauncherBundleV1({ sourceRoot: repository, releaseDirectory,
    nativeArtifactDirectory, journalNativeArtifactDirectory: substitutedRoot,
    outputDirectory: substitutedOutput }), refusal);
  await assert.rejects(access(substitutedOutput), error => error?.code === "ENOENT");

  const mixedRoot = join(suiteRoot, "journal-native-mixed-architecture");
  await writeJournalNativeArtifact(mixedRoot, "x64");
  const mixedOutput = join(suiteRoot, "mixed-output");
  await assert.rejects(assembleMacosLocalLauncherBundleV1({ sourceRoot: repository, releaseDirectory,
    nativeArtifactDirectory, journalNativeArtifactDirectory: mixedRoot, outputDirectory: mixedOutput }), refusal);
  await assert.rejects(access(mixedOutput), error => error?.code === "ENOENT");
});

test("the shared launcher core accepts a host-neutral handoff without platform policy", async () => {
  const installRoot = join(suiteRoot, "core-install"), journalRoot = join(suiteRoot, "core-journal");
  await mkdir(installRoot, { mode: 0o700 }); await mkdir(journalRoot, { mode: 0o700 });
  const calls = [];
  const runner = async spec => {
    calls.push(spec);
    if (spec.args[0].endsWith("scripts/prepare-local-installation.mjs")) return { exitCode: 0, signal: null,
      stdout: JSON.stringify({ readyForOwnerSetup: true, startsService: false, createsDatabase: false, writesCredentials: false }) };
    if (spec.args[0].endsWith("scripts/launch-local-setup.mjs")) return { exitCode: 0, signal: null,
      stdout: JSON.stringify({ state: "source_only_rehearsal_begun", version: "0.1.0", createsDatabase: false,
        startsService: false, startsWorker: false, launcherComplete: false, productionAcceptanceComplete: false }) };
    return { exitCode: 0, signal: null, stdout: JSON.stringify({
      schema: "control-room.local-installation-plan-bootstrap/v1", installationId: "portable-local", revision: 0,
      planDigest: `sha256:${"c".repeat(64)}`, replayed: false, createsDatabase: false, writesCredentials: false,
      startsService: false, startsWorker: false, enablesAuthority: false, enablesWorkers: false, grantsExecutionAuthority: false,
    }) };
  };
  const { protectedDirectoryNativeSidecar: _protectedSidecar,
    installationJournalNativeSidecar: _journalSidecar,
    schema: _schema, outerLauncherManifestSha256: _outerDigest,
    ...verifiedBundle } = await verifyExtractedMacosLocalLauncherBundleV1(bundleRoot);
  const report = await runLocalLauncherCoreV1({ verifiedBundle,
    releaseDirectory: join(bundleRoot, "release"), installRoot, journalRoot, installationId: "portable-local",
    topologyPlanDigest: `sha256:${"d".repeat(64)}`, environment: { PATH: "/safe/bin" },
    executable: process.execPath, schema: "example.local-launcher/v1" }, {
    runner, openerRunner: async () => ({ exitCode: 0, signal: null, stdout: "" }), openerExecutable: "/usr/bin/xdg-open",
    async supervisor(spec, dependencies) {
      assert.deepEqual(spec.environment, { PATH: "/safe/bin" });
      assert.equal(typeof dependencies.runOpener, "function");
      assert.equal(dependencies.openerExecutable, "/usr/bin/xdg-open");
      return { state: "setup_host_closed", ready: true, opened: true, reaped: true };
    },
  });
  assert.equal(report.schema, "example.local-launcher/v1");
  assert.equal(report.state, "source_only_setup_prepared");
  assert.equal(calls.length, 3);
  const mismatchInstall = join(suiteRoot, "core-manifest-mismatch");
  await mkdir(mismatchInstall, { mode: 0o700 });
  await assert.rejects(runLocalLauncherCoreV1({ verifiedBundle: { ...verifiedBundle,
    releaseManifestDigest: `sha256:${"e".repeat(64)}` }, releaseDirectory: join(bundleRoot, "release"),
    installRoot: mismatchInstall, journalRoot, installationId: "portable-local",
    topologyPlanDigest: `sha256:${"d".repeat(64)}`, environment: { PATH: "/safe/bin" },
    executable: process.execPath, schema: "example.local-launcher/v1" }, {
    runner: async () => { throw new Error("must not run"); },
    openerRunner: async () => ({ exitCode: 0, signal: null, stdout: "" }), openerExecutable: "/usr/bin/xdg-open",
  }), { message: "local_launcher_core_refused" });
});

test("refuses changed, missing, linked, extra, or any inexact member mode", async () => {
  for (const [name, mutate] of [
    ["changed", root => writeFile(join(root, "runtime/local-release-stager.mjs"), "changed\n")],
    ["missing", root => unlink(join(root, "release/SHA256SUMS"))],
    ["journal-sidecar-missing", root => unlink(join(root,
      "native/installation-journal/MACOS_INSTALLATION_JOURNAL_SIDECAR.json"))],
    ["journal-archive-substituted", root => writeFile(join(root,
      "native/installation-journal/agent-control-room-installation-journal-darwin-arm64.tar.gz"), "substituted\n")],
    ["journal-release-mismatch", async root => {
      const sidecarPath = join(root, "native/installation-journal/MACOS_INSTALLATION_JOURNAL_SIDECAR.json");
      const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
      sidecar.releaseVersion = "0.1.1";
      const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`);
      await writeFile(sidecarPath, sidecarBytes);
      const outerPath = join(root, "MACOS_LAUNCHER_MANIFEST.json");
      const outer = JSON.parse(await readFile(outerPath, "utf8"));
      const entry = outer.files.find(file => file.path
        === "native/installation-journal/MACOS_INSTALLATION_JOURNAL_SIDECAR.json");
      entry.bytes = sidecarBytes.byteLength; entry.sha256 = sha256(sidecarBytes);
      await writeFile(outerPath, `${JSON.stringify(outer, null, 2)}\n`);
    }],
    ["coherently-renamed-runtime", async root => {
      const original = "runtime/local-release-assembly.mjs";
      const replacement = "runtime/unexpected-local-release-assembly.mjs";
      await rename(join(root, original), join(root, replacement));
      const outerPath = join(root, "MACOS_LAUNCHER_MANIFEST.json");
      const outer = JSON.parse(await readFile(outerPath, "utf8"));
      const entry = outer.files.find(file => file.path === original);
      entry.path = replacement;
      const bytes = await readFile(join(root, replacement));
      entry.bytes = bytes.byteLength; entry.sha256 = sha256(bytes);
      outer.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      await writeFile(outerPath, `${JSON.stringify(outer, null, 2)}\n`);
    }],
    ["linked", async root => {
      await unlink(join(root, "release/SHA256SUMS"));
      await symlink("../MACOS_LAUNCHER_MANIFEST.json", join(root, "release/SHA256SUMS"));
    }],
    ["extra", root => writeFile(join(root, "extra.txt"), "extra\n")],
    ["command-not-executable", root => chmod(join(root, "Open Agent Control Room.command"), 0o644)],
    ["file-too-open", root => chmod(join(root, "release/SHA256SUMS"), 0o666)],
    ["command-too-open", root => chmod(join(root, "Open Agent Control Room.command"), 0o777)],
    ["special-bits", root => chmod(join(root, "Open Agent Control Room.command"), 0o1755)],
    ["directory-too-open", root => chmod(join(root, "runtime"), 0o777)],
  ]) {
    const target = join(suiteRoot, `mutation-${name}`);
    await mkdir(target);
    const copy = await extract(join(suiteRoot, "bundle-output", assembled.archiveName), target);
    await mutate(copy);
    await assert.rejects(verifyExtractedMacosLocalLauncherBundleV1(copy), refusal, name);
  }
});

test("refuses unsupported systems and old Node before writing an installation root", async () => {
  const home = join(suiteRoot, "unsupported-home");
  await mkdir(home, { mode: 0o700 });
  await assert.rejects(runMacosLocalLauncherBundleV1({ bundleRoot, homeDirectory: home }, {
    platform: "linux", architecture: "arm64", nodeVersion: "22.13.0",
  }), { message: "macos_local_launcher_unsupported_platform" });
  await assert.rejects(runMacosLocalLauncherBundleV1({ bundleRoot, homeDirectory: home }, {
    platform: "darwin", architecture: "arm64", nodeVersion: "22.12.0",
  }), { message: "macos_local_launcher_node_prerequisite_missing" });
  await assert.rejects(lstat(join(home, "Library")), error => error?.code === "ENOENT");
});

for (const level of [1, 2, 3]) test(`composes the ${level === 1 ? "legacy" : level === 2 ? "expanded" : "Claude-bound"} stager with one stable installation identity without effects`, async () => {
  const expanded = level >= 2, claudeBound = level >= 3;
  const launchBundleRoot = claudeBound ? claudeBoundBundleRoot : expanded ? expandedBundleRoot : bundleRoot;
  const installRoot = join(suiteRoot, `private-install-${level}`), journalRoot = join(suiteRoot, `private-journal-${level}`);
  const launcherHome = join(suiteRoot, "launcher-home");
  await mkdir(installRoot, { mode: 0o700 }); await mkdir(journalRoot, { mode: 0o700 });
  const calls = [], supervisors = [];
  const runner = async spec => {
    calls.push(spec);
    if (spec.args[0].endsWith("scripts/prepare-local-installation.mjs")) {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ readyForOwnerSetup: true,
        startsService: false, createsDatabase: false, writesCredentials: false }), stderr: "" };
    }
    if (spec.args[0].endsWith("scripts/launch-local-setup.mjs")) {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ state: "source_only_rehearsal_begun",
        version: "0.1.0", createsDatabase: false, startsService: false, startsWorker: false,
        launcherComplete: false, productionAcceptanceComplete: false }), stderr: "" };
    }
    if (spec.args[0].endsWith("scripts/initialize-local-installation-plan.mjs")) {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({
        schema: "control-room.local-installation-plan-bootstrap/v1", installationId: "macos-local",
        revision: 0, planDigest: `sha256:${"a".repeat(64)}`, replayed: false,
        createsDatabase: false, writesCredentials: false, startsService: false, startsWorker: false,
        enablesAuthority: false, enablesWorkers: false, grantsExecutionAuthority: false,
      }), stderr: "" };
    }
    throw new Error("unexpected process");
  };
  const report = await runMacosLocalLauncherBundleV1({ bundleRoot: launchBundleRoot, homeDirectory: launcherHome, installRoot, journalRoot }, {
    platform: "darwin", architecture: "arm64", macosVersion: "13.0", nodeVersion: "22.13.0", runner,
    async supervisor(spec, dependencies) {
      supervisors.push({ spec, dependencies });
      return { state: "setup_host_closed", ready: true, opened: true, reaped: true };
    },
    hostEnvironment: { PATH: "/safe/bin", HOME: "/private/source-home", TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8", NODE_OPTIONS: "--require=/secret/startup.cjs", BASH_ENV: "/secret/bash-env",
      NPM_TOKEN: "secret", npm_config_userconfig: "/secret/npmrc" },
  });
  assert.equal(report.state, "source_only_setup_prepared");
  assert.equal(report.releaseVerified, true);
  assert.equal(report.preflightPassed, true);
  assert.equal(report.launcherComplete, false);
  assert.equal(report.setupHostOpened, true);
  assert.equal(report.setupHostClosed, true);
  assert.equal(report.installationPlanInitialized, true);
  assert.equal(report.installationJournalNativeSidecar.releaseVersion, "0.1.0");
  assert.equal(report.installationJournalNativeSidecar.executableSha256,
    assembled.installationJournalNativeSidecar.executableSha256);
  assert.equal(report.productionAcceptanceComplete, false);
  assert.equal(report.schema, `control-room.macos-local-launcher-bundle/v${level}`);
  assert.equal(report.outerLauncherManifestSha256,
    (claudeBound ? claudeBoundAssembled : expanded ? expandedAssembled : assembled).outerLauncherManifestSha256);
  if (expanded) {
    assert.deepEqual(report.installedConfigurationNativeSidecar, expandedAssembled.installedConfigurationNativeSidecar);
    assert.deepEqual(report.macosServiceNativeSidecar, expandedAssembled.macosServiceNativeSidecar);
  }
  if (claudeBound) assert.deepEqual(report.claudeCodeProcessNativeSidecar,
    claudeBoundAssembled.claudeCodeProcessNativeSidecar);
  assert.equal(calls.length, 3);
  assert.match(calls[0].args[0], /versions\/0\.1\.0\/scripts\/prepare-local-installation\.mjs$/u);
  assert.match(calls[1].args[0], /versions\/0\.1\.0\/scripts\/launch-local-setup\.mjs$/u);
  assert.match(calls[2].args[0], /versions\/0\.1\.0\/scripts\/initialize-local-installation-plan\.mjs$/u);
  assert.ok(calls[1].args.includes(join(launchBundleRoot, "release")));
  assert.ok(calls[1].args.includes("--owner-attended"));
  assert.ok(calls[2].args.includes("--controller-only"));
  assert.ok(calls[2].args.includes("--owner-attended"));
  assert.ok(calls[2].args.includes("--release-digest"));
  const topologyDigest = `sha256:${createHash("sha256").update(JSON.stringify({ placement: "this-computer",
    schema: "control-room.local-launcher-topology/v1" })).digest("hex")}`;
  const topologyIndex = calls[1].args.indexOf("--topology-plan-digest");
  assert.equal(calls[1].args[topologyIndex + 1], topologyDigest);
  for (const call of calls.slice(1)) {
    const idIndex = call.args.indexOf("--installation-id");
    assert.notEqual(idIndex, -1);
    assert.equal(call.args[idIndex + 1], "macos-local");
  }
  assert.deepEqual(calls[0].environment, { PATH: "/safe/bin", HOME: launcherHome,
    TMPDIR: "/private/tmp", LANG: "en_US.UTF-8" });
  assert.equal(calls[0].timeoutMs, 60_000);
  assert.equal(calls[1].timeoutMs, 20 * 60_000);
  assert.equal(calls[2].timeoutMs, 60_000);
  assert.equal(supervisors.length, 1);
  assert.deepEqual(supervisors[0].spec.args, [join(installRoot, "versions", "0.1.0", "scripts", "run-local-setup-host.mjs"),
    "--release-root", join(installRoot, "versions", "0.1.0"), "--journal-root", journalRoot,
    "--installation-id", "macos-local", "--port", "3210"]);
  assert.equal(supervisors[0].dependencies.runOpener, runBoundedMacosLauncherChildV1);
  assert.equal(supervisors[0].dependencies.openerExecutable, "/usr/bin/open");
  for (const key of ["NODE_OPTIONS", "BASH_ENV", "ENV", "NPM_TOKEN", "npm_config_userconfig"]) {
    assert.equal(Object.hasOwn(calls[0].environment, key), false);
  }
});

test("a refused canonical plan bootstrap never starts or opens the setup host", async () => {
  const installRoot = join(suiteRoot, "bootstrap-refusal-install");
  const journalRoot = join(suiteRoot, "bootstrap-refusal-journal");
  const launcherHome = join(suiteRoot, "bootstrap-refusal-home");
  await mkdir(installRoot, { mode: 0o700 });
  await mkdir(journalRoot, { mode: 0o700 });
  let supervisorCalls = 0;
  const runner = async spec => {
    if (spec.args[0].endsWith("scripts/prepare-local-installation.mjs")) return {
      exitCode: 0, signal: null, stdout: JSON.stringify({ readyForOwnerSetup: true,
        startsService: false, createsDatabase: false, writesCredentials: false }), stderr: "",
    };
    if (spec.args[0].endsWith("scripts/launch-local-setup.mjs")) return {
      exitCode: 0, signal: null, stdout: JSON.stringify({ state: "source_only_rehearsal_begun",
        version: "0.1.0", createsDatabase: false, startsService: false, startsWorker: false,
        launcherComplete: false, productionAcceptanceComplete: false }), stderr: "",
    };
    return { exitCode: 1, signal: null, stdout: "", stderr: "sanitized refusal" };
  };
  await assert.rejects(runMacosLocalLauncherBundleV1({ bundleRoot, homeDirectory: launcherHome,
    installRoot, journalRoot, installationId: "bootstrap-refusal" }, {
    platform: "darwin", architecture: "arm64", macosVersion: "13.0", nodeVersion: "22.13.0", runner,
    async supervisor() { supervisorCalls += 1; throw new Error("must not start"); },
  }), { message: "macos_local_launcher_plan_bootstrap_refused" });
  assert.equal(supervisorCalls, 0);
});

test("an exact reopening resumes the saved rehearsal before replaying the canonical plan", async () => {
  const installRoot = join(suiteRoot, "reopen-install");
  const journalRoot = join(suiteRoot, "reopen-journal");
  const launcherHome = join(suiteRoot, "reopen-home");
  await mkdir(installRoot, { mode: 0o700 });
  await mkdir(journalRoot, { mode: 0o700 });
  const calls = [];
  const runner = async spec => {
    calls.push(spec);
    if (spec.args[0].endsWith("scripts/prepare-local-installation.mjs")) return {
      exitCode: 0, signal: null, stdout: JSON.stringify({ readyForOwnerSetup: true,
        startsService: false, createsDatabase: false, writesCredentials: false }), stderr: "",
    };
    if (spec.args.includes("begin")) return { exitCode: 1, signal: null, stdout: "", stderr: "already exists" };
    if (spec.args.includes("resume")) return { exitCode: 0, signal: null, stdout: JSON.stringify({
      state: "source_only_rehearsal_resumed", version: "0.1.0", createsDatabase: false,
      startsService: false, startsWorker: false, launcherComplete: false, productionAcceptanceComplete: false,
    }), stderr: "" };
    if (spec.args[0].endsWith("scripts/initialize-local-installation-plan.mjs")) return {
      exitCode: 0, signal: null, stdout: JSON.stringify({
        schema: "control-room.local-installation-plan-bootstrap/v1", installationId: "macos-local",
        revision: 0, planDigest: `sha256:${"b".repeat(64)}`, replayed: true,
        createsDatabase: false, writesCredentials: false, startsService: false, startsWorker: false,
        enablesAuthority: false, enablesWorkers: false, grantsExecutionAuthority: false,
      }), stderr: "",
    };
    throw new Error("unexpected process");
  };
  let supervisorCalls = 0;
  const report = await runMacosLocalLauncherBundleV1({ bundleRoot, homeDirectory: launcherHome,
  installRoot, journalRoot }, { platform: "darwin", architecture: "arm64", macosVersion: "13.0", nodeVersion: "22.13.0", runner,
    async supervisor() { supervisorCalls += 1; return { state: "setup_host_closed", ready: true, opened: true, reaped: true }; },
  });
  assert.equal(report.state, "source_only_setup_prepared");
  assert.equal(supervisorCalls, 1);
  const setupModes = calls.filter(call => call.args[0].endsWith("scripts/launch-local-setup.mjs"))
    .map(call => call.args[call.args.indexOf("--mode") + 1]);
  assert.deepEqual(setupModes, ["begin", "resume"]);
  const resume = calls.find(call => call.args.includes("resume"));
  const expectedVersionIndex = resume.args.indexOf("--expected-release-version");
  const expectedDigestIndex = resume.args.indexOf("--expected-release-manifest-digest");
  assert.equal(resume.args[expectedVersionIndex + 1], "0.1.0");
  assert.equal(resume.args[expectedDigestIndex + 1], (await verifyExtractedMacosLocalLauncherBundleV1(bundleRoot)).releaseManifestDigest);
});

test("owned timeout kills the full descendant process group before returning", async () => {
  const marker = join(suiteRoot, "descendant-survived");
  const descendant = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setTimeout(() => fs.writeFileSync(process.argv[1], "survived\\n"), 450);
setInterval(() => {}, 1000);
`;
  const parent = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;
  const result = await runBoundedMacosLauncherChildV1({ executable: process.execPath,
    args: ["-e", parent, marker], cwd: suiteRoot, environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 100, terminationGraceMs: 100 });
  assert.equal(result.timedOut, true);
  await wait(500);
  await assert.rejects(access(marker), error => error?.code === "ENOENT");
});

test("oversized output is retained only to the byte bound and terminates descendants", async () => {
  const marker = join(suiteRoot, "oversized-descendant-survived");
  const descendant = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setTimeout(() => fs.writeFileSync(process.argv[1], "survived\\n"), 450);
setInterval(() => {}, 1000);
`;
  const parent = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: "ignore" });
process.stdout.write(Buffer.alloc(4 * 1024 * 1024, "a"));
process.stderr.write(Buffer.alloc(4 * 1024 * 1024, "b"));
setInterval(() => {}, 1000);
`;
  const result = await runBoundedMacosLauncherChildV1({ executable: process.execPath,
    args: ["-e", parent, marker], cwd: suiteRoot, environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 2_000, terminationGraceMs: 100 });
  assert.equal(result.oversized, true);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 1024 * 1024);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 1024 * 1024);
  assert.equal(Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > 0, true);
  await wait(500);
  await assert.rejects(access(marker), error => error?.code === "ENOENT");
});

test("the command prompt is EOF-safe and preserves success and failure status", async () => {
  const fixture = join(suiteRoot, "command-behavior"), bin = join(fixture, "bin"), runtime = join(fixture, "runtime");
  await mkdir(bin, { recursive: true }); await mkdir(runtime);
  const command = join(fixture, "Open Agent Control Room.command");
  await writeFile(command, await readFile(join(bundleRoot, "Open Agent Control Room.command")), { mode: 0o755 });
  const fakeNode = join(bin, "node");
  await writeFile(fakeNode, "#!/bin/sh\nexit \"$FAKE_NODE_EXIT\"\n", { mode: 0o755 });
  await chmod(fakeNode, 0o755);
  const base = { PATH: `${bin}:/usr/bin:/bin`, HOME: fixture };
  const success = await run("/bin/sh", [command], { env: { ...base, FAKE_NODE_EXIT: "0" }, timeout: 2_000 });
  assert.match(success.stdout, /does not activate/u);
  await assert.rejects(run("/bin/sh", [command], { env: { ...base, FAKE_NODE_EXIT: "7" }, timeout: 2_000 }), error => {
    assert.equal(error?.code, 7);
    assert.match(error?.stdout, /does not activate/u);
    return true;
  });
});

test("assembler CLI requires canonical absolute inputs", async () => {
  await assert.rejects(run(process.execPath, [join(repository, "scripts/assemble-macos-local-launcher.mjs"),
    "--source-root", ".", "--release-directory", releaseDirectory,
    "--native-artifact-directory", nativeArtifactDirectory,
    "--journal-native-artifact-directory", journalNativeArtifactDirectory,
    "--output-directory", join(suiteRoot, "bad-cli-output")], { cwd: repository }), error => error?.code === 2);
  await assert.rejects(run(process.execPath, [join(repository, "scripts/assemble-macos-local-launcher.mjs"),
    "--source-root", repository, "--release-directory", releaseDirectory,
    "--native-artifact-directory", nativeArtifactDirectory,
    "--output-directory", join(suiteRoot, "missing-journal-cli-output")], { cwd: repository }), error => error?.code === 2);
});

test("assembler CLI selects expanded v2 only with both new native artifact inputs", async () => {
  const base = [join(repository, "scripts/assemble-macos-local-launcher.mjs"),
    "--source-root", repository, "--release-directory", releaseDirectory,
    "--native-artifact-directory", nativeArtifactDirectory,
    "--journal-native-artifact-directory", journalNativeArtifactDirectory,
    "--output-directory", join(suiteRoot, "expanded-cli-output")];
  const configuration = ["--installed-configuration-native-artifact-directory", installedConfigurationNativeArtifactDirectory];
  const service = ["--macos-service-native-artifact-directory", macosServiceNativeArtifactDirectory];
  for (const partial of [configuration, service, [...configuration, ...configuration]]) {
    await assert.rejects(run(process.execPath, [...base, ...partial], { cwd: repository }), error => error?.code === 2);
  }
  const report = JSON.parse((await run(process.execPath, [...base, ...configuration, ...service], { cwd: repository })).stdout);
  assert.equal(report.schema, "control-room.macos-local-launcher-bundle/v2");
  assert.equal(report.archiveSha256, expandedAssembled.archiveSha256);
  assert.equal(report.outerLauncherManifestSha256, expandedAssembled.outerLauncherManifestSha256);
});

test("assembler CLI selects v3 only when the complete Claude-bound input set is present", async () => {
  const outputDirectory = join(suiteRoot, "claude-bound-cli-output");
  const base = [join(repository, "scripts/assemble-macos-local-launcher.mjs"),
    "--source-root", repository, "--release-directory", releaseDirectory,
    "--native-artifact-directory", nativeArtifactDirectory,
    "--journal-native-artifact-directory", journalNativeArtifactDirectory,
    "--output-directory", outputDirectory];
  const expanded = ["--installed-configuration-native-artifact-directory", installedConfigurationNativeArtifactDirectory,
    "--macos-service-native-artifact-directory", macosServiceNativeArtifactDirectory];
  const claude = ["--claude-code-process-native-artifact-directory", claudeCodeProcessNativeArtifactDirectory];
  await assert.rejects(run(process.execPath, [...base, ...claude], { cwd: repository }), error => error?.code === 2);
  const report = JSON.parse((await run(process.execPath, [...base, ...expanded, ...claude], { cwd: repository })).stdout);
  assert.equal(report.schema, "control-room.macos-local-launcher-bundle/v3");
  assert.equal(report.archiveSha256, claudeBoundAssembled.archiveSha256);
  assert.equal(report.claudeCodeProcessNativeSidecar.releaseSha256,
    (await verifyExtractedMacosLocalLauncherBundleV1(claudeBoundBundleRoot)).releaseManifestDigest);
});
