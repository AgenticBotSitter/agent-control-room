import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import osModule, { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { createDeterministicTarGzipV1 } from "../src/installer/v1/local-release-assembly.mjs";
import { buildInstallationJournalNativeArtifactV1 } from "../scripts/build-installation-journal-native.mjs";
import { copyVerifiedMacosInstallationJournalNativeSidecarV1, stageMacosInstallationJournalNativeFactoryInputV1,
  verifyMacosInstallationJournalNativeSidecarV1, verifyInstallationJournalNativeArtifactV1,
  INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1 } from
  "../src/installer/v1/macos-installation-journal-native-sidecar.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const refusal = { message: "macos_installation_journal_native_sidecar_refused" };
const macosTest = process.platform === "darwin" && ["arm64", "x64"].includes(process.arch) ? test : test.skip;
const nonMacosTest = process.platform === "darwin" ? test.skip : test;

function tarChecksum(header) {
  header.fill(0x20, 148, 156); const text = header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0");
  header.write(text, 148, 6, "ascii"); header[154] = 0; header[155] = 0x20;
}
async function alterArchive(directory, change) {
  const name = "agent-control-room-installation-journal-darwin-arm64.tar.gz", path = join(directory, name);
  const tar = gunzipSync(await readFile(path)); change(tar);
  const archive = gzipSync(tar, { mtime: 0 });
  await writeFile(path, archive); await writeFile(join(directory, "SHA256SUMS"), `${digest(archive)}  ${name}\n`);
}

async function artifact(root, architecture = "arm64", flags = INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1, platform = "darwin") {
  const source = join(root, "source"), output = join(root, "artifact");
  await mkdir(source); await mkdir(output);
  const values = new Map([["LICENSE", Buffer.from("license\n")], ["NOTICE", Buffer.from("notice\n")],
    ["installation-journal-session-v1", Buffer.from("inert fixture bytes\n")]]);
  for (const [path, bytes] of values) await writeFile(join(source, path), bytes, { mode: path === "installation-journal-session-v1" ? 0o755 : 0o644 });
  const files = [...values].map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: digest(bytes),
    mode: path === "installation-journal-session-v1" ? "0755" : "0644" }));
  const manifest = { schema: "control-room.installation-journal-native-artifact/v1", platform, architecture,
    minimumMacos: "13.0", protocol: "ACRJNL1", sourceSha256: "b".repeat(64), ownerQualified: false,
    toolchain: { compiler: "Apple clang version 16.0.0", sdkVersion: "16.0", flags: [...flags] }, files };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), archiveRoot = `agent-control-room-installation-journal-darwin-${architecture}`;
  await writeFile(join(source, "INSTALLATION_JOURNAL_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  const archive = await createDeterministicTarGzipV1(source, archiveRoot, [...files.map(({ path, mode }) => ({ path, mode })),
    { path: "INSTALLATION_JOURNAL_MANIFEST.json", mode: "0644" }]);
  await writeFile(join(output, "INSTALLATION_JOURNAL_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  await writeFile(join(output, `${archiveRoot}.tar.gz`), archive, { mode: 0o644 });
  await writeFile(join(output, "SHA256SUMS"), `${digest(archive)}  ${archiveRoot}.tar.gz\n`, { mode: 0o644 });
  return output;
}

macosTest("sidecar verifies exact native identity and explicitly stages the factory input", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-")));
  try {
    const source = await artifact(root, process.arch), direct = await verifyInstallationJournalNativeArtifactV1(source);
    assert.equal(direct.executableSha256.startsWith("sha256:"), true);
    const sidecarRoot = join(root, "sidecar");
    const composed = await copyVerifiedMacosInstallationJournalNativeSidecarV1({ artifactDirectory: source,
      destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    assert.equal(composed.compiles, false); assert.equal(composed.downloads, false); assert.equal(composed.installs, false);
    const verified = await verifyMacosInstallationJournalNativeSidecarV1(sidecarRoot, {
      releaseVersion: "0.1.0", architecture: process.arch, macosVersion: "13.0" });
    assert.equal(verified.executableSha256, direct.executableSha256);
    const stageParent = join(root, "stage-parent"); await mkdir(stageParent, { mode: 0o700 });
    const staged = await stageMacosInstallationJournalNativeFactoryInputV1({ sidecarRoot, stagingParent: stageParent });
    assert.equal(staged.installationJournalNativeFactoryInput.executableSha256, verified.executableSha256);
    assert.equal((await lstat(staged.installationJournalNativeFactoryInput.executablePath)).mode & 0o7777, 0o700);
    assert.deepEqual(await readFile(staged.installationJournalNativeFactoryInput.executablePath), Buffer.from("inert fixture bytes\n"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sidecar refuses altered digest, linked input, unsupported architecture, and unsupported macOS before staging", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-refusal-")));
  try {
    const otherArchitecture = process.arch === "arm64" ? "x64" : "arm64";
    const source = await artifact(root, process.arch), sidecarRoot = join(root, "sidecar");
    await copyVerifiedMacosInstallationJournalNativeSidecarV1({ artifactDirectory: source, destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    await assert.rejects(verifyMacosInstallationJournalNativeSidecarV1(sidecarRoot, { architecture: otherArchitecture }), refusal);
    await assert.rejects(verifyMacosInstallationJournalNativeSidecarV1(sidecarRoot, { macosVersion: "12.6" }), refusal);
    await chmod(join(sidecarRoot, "MACOS_INSTALLATION_JOURNAL_SIDECAR.json"), 0o666);
    await assert.rejects(verifyMacosInstallationJournalNativeSidecarV1(sidecarRoot), refusal);
    await chmod(join(sidecarRoot, "MACOS_INSTALLATION_JOURNAL_SIDECAR.json"), 0o644);
    await chmod(join(sidecarRoot, "SHA256SUMS"), 0o666);
    await assert.rejects(verifyMacosInstallationJournalNativeSidecarV1(sidecarRoot), refusal);
    await chmod(join(sidecarRoot, "SHA256SUMS"), 0o644);
    const archiveName = `agent-control-room-installation-journal-darwin-${process.arch}.tar.gz`;
    await chmod(join(sidecarRoot, archiveName), 0o666);
    await assert.rejects(verifyMacosInstallationJournalNativeSidecarV1(sidecarRoot), refusal);
    await chmod(join(sidecarRoot, archiveName), 0o644);
    await rm(join(sidecarRoot, "INSTALLATION_JOURNAL_MANIFEST.json"));
    await symlink("SHA256SUMS", join(sidecarRoot, "INSTALLATION_JOURNAL_MANIFEST.json"));
    await assert.rejects(verifyMacosInstallationJournalNativeSidecarV1(sidecarRoot), refusal);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native artifact requires the exact reviewed compiler flag list", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-flags-")));
  try {
    for (const [name, flags] of [["missing", INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1.slice(1)],
      ["changed", [...INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1.slice(0, -1), "-mmacosx-version-min=14.0"]],
      ["extra", [...INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1, "-g"]]]) {
      const target = join(root, name); await mkdir(target);
      const output = await artifact(target, "arm64", flags);
      await assert.rejects(verifyInstallationJournalNativeArtifactV1(output), refusal);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native artifact rejects unsupported platform and architecture declarations", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-platform-")));
  try {
    const unsupportedPlatform = join(root, "platform"); await mkdir(unsupportedPlatform);
    await assert.rejects(verifyInstallationJournalNativeArtifactV1(await artifact(unsupportedPlatform, "arm64",
      INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1, "linux")), refusal);
    const unsupportedArchitecture = join(root, "architecture"); await mkdir(unsupportedArchitecture);
    await assert.rejects(verifyInstallationJournalNativeArtifactV1(await artifact(unsupportedArchitecture, "riscv64")), refusal);
  } finally { await rm(root, { recursive: true, force: true }); }
});

macosTest("private staging refuses a sidecar built for the other supported architecture", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-host-binding-")));
  try {
    const otherArchitecture = process.arch === "arm64" ? "x64" : "arm64";
    const source = await artifact(root, otherArchitecture), sidecarRoot = join(root, "sidecar"), parent = join(root, "parent");
    await mkdir(parent, { mode: 0o700 });
    await copyVerifiedMacosInstallationJournalNativeSidecarV1({ artifactDirectory: source,
      destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    await assert.rejects(stageMacosInstallationJournalNativeFactoryInputV1({ sidecarRoot, stagingParent: parent }), refusal);
  } finally { await rm(root, { recursive: true, force: true }); }
});

macosTest("private staging refuses a host below the sidecar minimum macOS version", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-minimum-macos-")));
  try {
    const source = await artifact(root, process.arch), sidecarRoot = join(root, "sidecar"), parent = join(root, "parent");
    await mkdir(parent, { mode: 0o700 });
    await copyVerifiedMacosInstallationJournalNativeSidecarV1({ artifactDirectory: source,
      destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    const hook = mock.method(osModule, "release", () => "21.6.0");
    syncBuiltinESMExports();
    try {
      await assert.rejects(stageMacosInstallationJournalNativeFactoryInputV1({ sidecarRoot, stagingParent: parent }), refusal);
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

nonMacosTest("private staging refuses the unsupported current host platform", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-unsupported-host-")));
  try {
    const source = await artifact(root, "x64"), sidecarRoot = join(root, "sidecar"), parent = join(root, "parent");
    await mkdir(parent, { mode: 0o700 });
    await copyVerifiedMacosInstallationJournalNativeSidecarV1({ artifactDirectory: source,
      destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    await assert.rejects(stageMacosInstallationJournalNativeFactoryInputV1({ sidecarRoot, stagingParent: parent }), refusal);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive parser refuses traversal, duplicate and malformed members, digest drift, links and hard links", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-archive-")));
  try {
    const traversal = async output => alterArchive(output, tar => {
        const header = tar.subarray(512, 1024); header.fill(0, 0, 100); header.write("agent-control-room-installation-journal-darwin-arm64/../escape", 0, "ascii"); tarChecksum(header);
      });
    const malformed = async output => alterArchive(output, tar => { tar[512 + 148] ^= 1; });
    const symbolicLink = async output => alterArchive(output, tar => {
      const header = tar.subarray(512, 1024); header[156] = "2".charCodeAt(0); tarChecksum(header);
    });
    const hardLink = async output => alterArchive(output, tar => {
      const header = tar.subarray(512, 1024); header[156] = "1".charCodeAt(0); tarChecksum(header);
    });
    // Duplicate changes the archive length, so construct it directly rather than mutating a fixed Buffer in place.
    const duplicate = async output => {
      const name = "agent-control-room-installation-journal-darwin-arm64.tar.gz", path = join(output, name), tar = gunzipSync(await readFile(path));
      const end = tar.length - 1024, header = tar.subarray(512, 1024), size = Number.parseInt(header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim(), 8);
      const record = Buffer.from(tar.subarray(512, 1024 + Math.ceil(size / 512) * 512)), archive = gzipSync(Buffer.concat([tar.subarray(0, end), record, tar.subarray(end)]), { mtime: 0 });
      await writeFile(path, archive); await writeFile(join(output, "SHA256SUMS"), `${digest(archive)}  ${name}\n`);
    };
    const wrongMode = async output => alterArchive(output, tar => {
      const header = tar.subarray(512, 1024); header.fill(0, 100, 108); header.write("0000700", 100, "ascii"); tarChecksum(header);
    });
    for (const [name, change] of [["traversal", traversal], ["duplicate", duplicate], ["malformed", malformed],
      ["symbolic-link", symbolicLink], ["hard-link", hardLink], ["wrong-mode", wrongMode]]) {
      const target = join(root, name); await mkdir(target); const output = await artifact(target); await change(output);
      await assert.rejects(verifyInstallationJournalNativeArtifactV1(output), refusal);
    }
    const digestTarget = join(root, "digest"); await mkdir(digestTarget); const digestOutput = await artifact(digestTarget);
    await writeFile(join(digestOutput, "agent-control-room-installation-journal-darwin-arm64.tar.gz"), Buffer.from("changed"));
    await assert.rejects(verifyInstallationJournalNativeArtifactV1(digestOutput), refusal);
  } finally { await rm(root, { recursive: true, force: true }); }
});

macosTest("staging uses captured verified archive bytes despite later sidecar-path substitution", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-custody-")));
  try {
    const source = await artifact(root, process.arch), sidecarRoot = join(root, "sidecar"), parent = join(root, "parent"); await mkdir(parent, { mode: 0o700 });
    await copyVerifiedMacosInstallationJournalNativeSidecarV1({ artifactDirectory: source, destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    const original = fsPromises.mkdtemp;
    const hook = mock.method(fsPromises, "mkdtemp", async (...args) => {
      const result = await original(...args);
      await writeFile(join(sidecarRoot, `agent-control-room-installation-journal-darwin-${process.arch}.tar.gz`), Buffer.from("substituted"));
      return result;
    });
    syncBuiltinESMExports();
    try {
      const staged = await stageMacosInstallationJournalNativeFactoryInputV1({ sidecarRoot, stagingParent: parent });
      assert.deepEqual(await readFile(staged.installationJournalNativeFactoryInput.executablePath), Buffer.from("inert fixture bytes\n"));
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public sidecar inputs reject accessors before asynchronous filesystem work", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-accessor-")));
  try {
    const source = await artifact(root), destination = join(root, "sidecar");
    const unsafe = {};
    Object.defineProperty(unsafe, "artifactDirectory", { enumerable: true, get() { throw new Error("must not read"); } });
    Object.defineProperty(unsafe, "destinationDirectory", { enumerable: true, value: destination });
    Object.defineProperty(unsafe, "releaseVersion", { enumerable: true, value: "0.1.0" });
    await assert.rejects(copyVerifiedMacosInstallationJournalNativeSidecarV1(unsafe), refusal);
    assert.equal(await lstat(source).then(stat => stat.isDirectory()), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

macosTest("native build is deterministic and binds the exact reviewed journal source", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-build-")));
  try {
    const firstDirectory = join(root, "one"), secondDirectory = join(root, "two");
    const first = await buildInstallationJournalNativeArtifactV1({ outputDirectory: firstDirectory });
    const second = await buildInstallationJournalNativeArtifactV1({ outputDirectory: secondDirectory });
    assert.deepEqual(first, second);
    assert.deepEqual(await readFile(join(firstDirectory, first.archiveName)), await readFile(join(secondDirectory, second.archiveName)));
    const verified = await verifyInstallationJournalNativeArtifactV1(firstDirectory);
    assert.equal(verified.sourceSha256, digest(await readFile(new URL("../native/installation-journal-session-v1.c", import.meta.url))));
    assert.equal(verified.architecture, process.arch);
    assert.equal(verified.ownerQualified, false);
    assert.equal(verified.compiles, false);
    assert.equal(verified.downloads, false);
    assert.equal(verified.installs, false);
    for (const name of ["LICENSE", "NOTICE"]) {
      const entry = verified.files.find(file => file.path === name);
      assert.equal(entry.sha256, digest(await readFile(new URL(`../${name}`, import.meta.url))));
    }
    await assert.rejects(buildInstallationJournalNativeArtifactV1({ outputDirectory: firstDirectory }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
