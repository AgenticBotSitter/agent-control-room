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
  runBoundedMacosLauncherChildV1,
  runMacosLocalLauncherBundleV1,
  consumeMacosLocalLauncherInstalledConfigurationVerifierCustodyV1,
  verifyExtractedMacosLocalLauncherBundleV1,
} from "../src/installer/v1/macos-local-launcher-bundle.mjs";
import { createPrivateInstalledConfigurationNativeVerifierCustodyV1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_VERIFIER_CUSTODY_V1 } from
  "../src/installer/v1/private-installed-configuration-native-verifier-custody.ts";
import { runLocalLauncherCoreV1 } from "../src/installer/v1/local-launcher-core.mjs";
import { INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1 } from
  "../src/installer/v1/macos-installation-journal-native-sidecar.mjs";
import { PROTECTED_DIRECTORY_NATIVE_REVIEWED_CFLAGS_V1 } from "../src/installer/v1/macos-protected-directory-native-sidecar.mjs";
import { INSTALLED_CONFIGURATION_NATIVE_REVIEWED_CFLAGS_V1 } from "../src/installer/v1/macos-installed-configuration-native-sidecar.mjs";
import { MACOS_SERVICE_NATIVE_REVIEWED_CFLAGS_V1 } from "../src/installer/v1/macos-service-native-sidecar.mjs";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const refusal = { message: "macos_local_launcher_bundle_refused" };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
let suiteRoot, releaseDirectory, nativeArtifactDirectory, journalNativeArtifactDirectory, bundleRoot, assembled;
let installedConfigurationNativeArtifactDirectory, macosServiceNativeArtifactDirectory, expandedBundleRoot, expandedAssembled;

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

for (const expanded of [false, true]) test(`composes the ${expanded ? "expanded" : "legacy"} stager with one stable installation identity without effects`, async () => {
  const launchBundleRoot = expanded ? expandedBundleRoot : bundleRoot;
  const installRoot = join(suiteRoot, `private-install-${expanded}`), journalRoot = join(suiteRoot, `private-journal-${expanded}`);
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
  assert.equal(report.schema, `control-room.macos-local-launcher-bundle/v${expanded ? 2 : 1}`);
  assert.equal(report.outerLauncherManifestSha256,
    (expanded ? expandedAssembled : assembled).outerLauncherManifestSha256);
  if (expanded) {
    assert.deepEqual(report.installedConfigurationNativeSidecar, expandedAssembled.installedConfigurationNativeSidecar);
    assert.deepEqual(report.macosServiceNativeSidecar, expandedAssembled.macosServiceNativeSidecar);
  }
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
