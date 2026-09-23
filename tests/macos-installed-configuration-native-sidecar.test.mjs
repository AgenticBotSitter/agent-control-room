import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeterministicTarGzipV1 } from "../src/installer/v1/local-release-assembly.mjs";
import { buildInstalledConfigurationNativeArtifactV1 } from "../scripts/build-installed-configuration-native.mjs";
import { copyVerifiedMacosInstalledConfigurationNativeSidecarV1,
  INSTALLED_CONFIGURATION_NATIVE_REVIEWED_CFLAGS_V1,
  stageMacosInstalledConfigurationNativeFactoryInputV1,
  verifyInstalledConfigurationNativeArtifactV1,
  verifyMacosInstalledConfigurationNativeSidecarV1 } from
  "../src/installer/v1/macos-installed-configuration-native-sidecar.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const refusal = { message: "macos_installed_configuration_native_sidecar_refused" };
const macosTest = process.platform === "darwin" && ["arm64", "x64"].includes(process.arch) ? test : test.skip;

function stagingInput(sidecarRoot, stagingParent, verified, overrides = {}) {
  return { sidecarRoot, stagingParent, expectedReleaseVersion: verified.releaseVersion,
    expectedSidecarManifestSha256: verified.sidecarManifestSha256,
    expectedArchiveSha256: verified.archiveSha256,
    expectedArtifactManifestSha256: verified.artifactManifestSha256,
    expectedExecutableSha256: verified.executableSha256, ...overrides };
}
async function fixture(root, architecture = process.arch, flags = INSTALLED_CONFIGURATION_NATIVE_REVIEWED_CFLAGS_V1) {
  const source = join(root, "source"), output = join(root, "artifact"); await mkdir(source); await mkdir(output);
  const values = new Map([["LICENSE", Buffer.from("license\n")], ["NOTICE", Buffer.from("notice\n")],
    ["installed-configuration-v1", Buffer.from("inert fixed helper\n")]]);
  for (const [path, bytes] of values) await writeFile(join(source, path), bytes,
    { mode: path === "installed-configuration-v1" ? 0o755 : 0o644 });
  const files = [...values].map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: hash(bytes),
    mode: path === "installed-configuration-v1" ? "0755" : "0644" }));
  const manifest = { schema: "control-room.installed-configuration-native-artifact/v1", platform: "darwin", architecture,
    minimumMacos: "13.0", protocol: "ACRCFG1", sourceSha256: "a".repeat(64), ownerQualified: false,
    toolchain: { compiler: "Apple clang version 16.0.0", sdkVersion: "16.0", flags: [...flags] }, files };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    archiveRoot = `agent-control-room-installed-configuration-darwin-${architecture}`;
  await writeFile(join(source, "INSTALLED_CONFIGURATION_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  const archive = await createDeterministicTarGzipV1(source, archiveRoot,
    [...files.map(({ path, mode }) => ({ path, mode })), { path: "INSTALLED_CONFIGURATION_MANIFEST.json", mode: "0644" }]);
  await writeFile(join(output, "INSTALLED_CONFIGURATION_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  await writeFile(join(output, `${archiveRoot}.tar.gz`), archive, { mode: 0o644 });
  await writeFile(join(output, "SHA256SUMS"), `${hash(archive)}  ${archiveRoot}.tar.gz\n`, { mode: 0o644 });
  return output;
}

macosTest("sidecar is release bound and stages only the captured verified helper bytes", async () => {
  const root = await realpath(await mkdtemp("/private/tmp/acr-installed-configuration-sidecar-"));
  try {
    const artifact = await fixture(root), sidecarRoot = join(root, "sidecar"), stagingParent = join(root, "staging");
    await mkdir(stagingParent, { mode: 0o700 });
    const direct = await verifyInstalledConfigurationNativeArtifactV1(artifact);
    await copyVerifiedMacosInstalledConfigurationNativeSidecarV1({ artifactDirectory: artifact,
      destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    const verified = await verifyMacosInstalledConfigurationNativeSidecarV1(sidecarRoot,
      { releaseVersion: "0.1.0", architecture: process.arch, macosVersion: "13.0" });
    assert.equal(verified.executableSha256, direct.executableSha256);
    assert.match(verified.sidecarManifestSha256, /^sha256:[a-f0-9]{64}$/u);
    const staged = await stageMacosInstalledConfigurationNativeFactoryInputV1(
      stagingInput(sidecarRoot, stagingParent, verified));
    assert.equal(staged.installedConfigurationNativeHostInput.executableSha256, verified.executableSha256);
    assert.deepEqual(await readFile(staged.installedConfigurationNativeHostInput.executablePath), Buffer.from("inert fixed helper\n"));
    assert.equal((await lstat(staged.installedConfigurationNativeHostInput.executablePath)).mode & 0o7777, 0o700);
    assert.equal(staged.compiles, false); assert.equal(staged.downloads, false); assert.equal(staged.installs, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

macosTest("staging refuses every release identity mismatch before creating a directory", async () => {
  const root = await realpath(await mkdtemp("/private/tmp/acr-installed-configuration-sidecar-binding-"));
  try {
    const artifact = await fixture(root), sidecarRoot = join(root, "sidecar"), stagingParent = join(root, "staging");
    await mkdir(stagingParent, { mode: 0o700 });
    await copyVerifiedMacosInstalledConfigurationNativeSidecarV1({ artifactDirectory: artifact,
      destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    const verified = await verifyMacosInstalledConfigurationNativeSidecarV1(sidecarRoot);
    for (const changed of [{ expectedReleaseVersion: "0.1.1" },
      { expectedSidecarManifestSha256: `sha256:${"0".repeat(64)}` },
      { expectedArchiveSha256: `sha256:${"1".repeat(64)}` },
      { expectedArtifactManifestSha256: `sha256:${"2".repeat(64)}` },
      { expectedExecutableSha256: `sha256:${"3".repeat(64)}` }]) {
      await assert.rejects(stageMacosInstalledConfigurationNativeFactoryInputV1(
        stagingInput(sidecarRoot, stagingParent, verified, changed)), refusal);
      assert.deepEqual(await readdir(stagingParent), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact and sidecar reject compiler, mode, digest and link drift", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-installed-configuration-sidecar-refusal-")));
  try {
    const flagsRoot = join(root, "flags"); await mkdir(flagsRoot);
    await assert.rejects(verifyInstalledConfigurationNativeArtifactV1(await fixture(flagsRoot,
      process.arch, INSTALLED_CONFIGURATION_NATIVE_REVIEWED_CFLAGS_V1.slice(1))), refusal);
    const artifact = await fixture(root), sidecarRoot = join(root, "sidecar");
    await copyVerifiedMacosInstalledConfigurationNativeSidecarV1({ artifactDirectory: artifact,
      destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    await chmod(join(sidecarRoot, "SHA256SUMS"), 0o666);
    await assert.rejects(verifyMacosInstalledConfigurationNativeSidecarV1(sidecarRoot), refusal);
    await chmod(join(sidecarRoot, "SHA256SUMS"), 0o644);
    await rm(join(sidecarRoot, "INSTALLED_CONFIGURATION_MANIFEST.json"));
    await symlink("SHA256SUMS", join(sidecarRoot, "INSTALLED_CONFIGURATION_MANIFEST.json"));
    await assert.rejects(verifyMacosInstalledConfigurationNativeSidecarV1(sidecarRoot), refusal);
  } finally { await rm(root, { recursive: true, force: true }); }
});

macosTest("native release build is deterministic and binds source, license and notice", async () => {
  const root = await realpath(await mkdtemp("/private/tmp/acr-installed-configuration-build-test-"));
  try {
    const firstDirectory = join(root, "one"), secondDirectory = join(root, "two");
    const originalUmask = process.umask(0o077); let first, second;
    try {
      first = await buildInstalledConfigurationNativeArtifactV1({ outputDirectory: firstDirectory });
      second = await buildInstalledConfigurationNativeArtifactV1({ outputDirectory: secondDirectory });
    } finally { process.umask(originalUmask); }
    assert.deepEqual(first, second);
    assert.deepEqual(await readFile(join(firstDirectory, first.archiveName)), await readFile(join(secondDirectory, second.archiveName)));
    for (const directory of [firstDirectory, secondDirectory])
      for (const name of [first.archiveName, "INSTALLED_CONFIGURATION_MANIFEST.json", "SHA256SUMS"])
        assert.equal((await lstat(join(directory, name))).mode & 0o7777, 0o644);
    const verified = await verifyInstalledConfigurationNativeArtifactV1(firstDirectory);
    assert.equal(verified.sourceSha256, hash(await readFile(new URL("../native/installed-configuration-v1.c", import.meta.url))));
    assert.equal(verified.architecture, process.arch); assert.equal(verified.ownerQualified, false);
    for (const name of ["LICENSE", "NOTICE"]) assert.equal(verified.files.find(file => file.path === name).sha256,
      hash(await readFile(new URL(`../${name}`, import.meta.url))));
    await assert.rejects(buildInstalledConfigurationNativeArtifactV1({ outputDirectory: firstDirectory }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
