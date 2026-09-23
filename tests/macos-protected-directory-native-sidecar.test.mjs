import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { createDeterministicTarGzipV1 } from "../src/installer/v1/local-release-assembly.mjs";
import { copyVerifiedMacosProtectedDirectoryNativeSidecarV1, stageMacosProtectedDirectoryNativeFactoryInputV1,
  verifyMacosProtectedDirectoryNativeSidecarV1, verifyProtectedDirectoryNativeArtifactV1,
  PROTECTED_DIRECTORY_NATIVE_REVIEWED_CFLAGS_V1 } from
  "../src/installer/v1/macos-protected-directory-native-sidecar.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const refusal = { message: "macos_protected_directory_native_sidecar_refused" };

function tarChecksum(header) {
  header.fill(0x20, 148, 156); const text = header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0");
  header.write(text, 148, 6, "ascii"); header[154] = 0; header[155] = 0x20;
}
async function alterArchive(directory, change) {
  const name = "agent-control-room-protected-directory-darwin-arm64.tar.gz", path = join(directory, name);
  const tar = gunzipSync(await readFile(path)); change(tar);
  const archive = gzipSync(tar, { mtime: 0 });
  await writeFile(path, archive); await writeFile(join(directory, "SHA256SUMS"), `${digest(archive)}  ${name}\n`);
}

async function artifact(root, architecture = "arm64", flags = PROTECTED_DIRECTORY_NATIVE_REVIEWED_CFLAGS_V1) {
  const source = join(root, "source"), output = join(root, "artifact");
  await mkdir(source); await mkdir(output);
  const values = new Map([["LICENSE", Buffer.from("license\n")], ["NOTICE", Buffer.from("notice\n")],
    ["protected-directory-v1", Buffer.from("inert fixture bytes\n")]]);
  for (const [path, bytes] of values) await writeFile(join(source, path), bytes, { mode: path === "protected-directory-v1" ? 0o755 : 0o644 });
  const files = [...values].map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: digest(bytes),
    mode: path === "protected-directory-v1" ? "0755" : "0644" }));
  const manifest = { schema: "control-room.protected-directory-native-artifact/v1", platform: "darwin", architecture,
    minimumMacos: "13.0", protocol: "ACRDIR1", sourceSha256: "b".repeat(64), ownerQualified: false,
    toolchain: { compiler: "Apple clang version 16.0.0", sdkVersion: "16.0", flags: [...flags] }, files };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), archiveRoot = `agent-control-room-protected-directory-darwin-${architecture}`;
  await writeFile(join(source, "PROTECTED_DIRECTORY_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  const archive = await createDeterministicTarGzipV1(source, archiveRoot, [...files.map(({ path, mode }) => ({ path, mode })),
    { path: "PROTECTED_DIRECTORY_MANIFEST.json", mode: "0644" }]);
  await writeFile(join(output, "PROTECTED_DIRECTORY_MANIFEST.json"), manifestBytes, { mode: 0o644 });
  await writeFile(join(output, `${archiveRoot}.tar.gz`), archive, { mode: 0o644 });
  await writeFile(join(output, "SHA256SUMS"), `${digest(archive)}  ${archiveRoot}.tar.gz\n`, { mode: 0o644 });
  return output;
}

test("sidecar verifies exact native identity and explicitly stages the factory input", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-")));
  try {
    const source = await artifact(root), direct = await verifyProtectedDirectoryNativeArtifactV1(source);
    assert.equal(direct.executableSha256.startsWith("sha256:"), true);
    const sidecarRoot = join(root, "sidecar");
    const composed = await copyVerifiedMacosProtectedDirectoryNativeSidecarV1({ artifactDirectory: source,
      destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    assert.equal(composed.compiles, false); assert.equal(composed.downloads, false); assert.equal(composed.installs, false);
    const verified = await verifyMacosProtectedDirectoryNativeSidecarV1(sidecarRoot, {
      releaseVersion: "0.1.0", architecture: "arm64", macosVersion: "13.0" });
    assert.equal(verified.executableSha256, direct.executableSha256);
    const stageParent = join(root, "stage-parent"); await mkdir(stageParent, { mode: 0o700 });
    const staged = await stageMacosProtectedDirectoryNativeFactoryInputV1({ sidecarRoot, stagingParent: stageParent });
    assert.equal(staged.protectedRootNativeFactoryInput.executableSha256, verified.executableSha256);
    assert.equal((await lstat(staged.protectedRootNativeFactoryInput.executablePath)).mode & 0o7777, 0o700);
    assert.deepEqual(await readFile(staged.protectedRootNativeFactoryInput.executablePath), Buffer.from("inert fixture bytes\n"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sidecar refuses altered digest, linked input, unsupported architecture, and unsupported macOS before staging", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-refusal-")));
  try {
    const source = await artifact(root), sidecarRoot = join(root, "sidecar");
    await copyVerifiedMacosProtectedDirectoryNativeSidecarV1({ artifactDirectory: source, destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    await assert.rejects(verifyMacosProtectedDirectoryNativeSidecarV1(sidecarRoot, { architecture: "x64" }), refusal);
    await assert.rejects(verifyMacosProtectedDirectoryNativeSidecarV1(sidecarRoot, { macosVersion: "12.6" }), refusal);
    await chmod(join(sidecarRoot, "MACOS_PROTECTED_DIRECTORY_SIDECAR.json"), 0o666);
    await assert.rejects(verifyMacosProtectedDirectoryNativeSidecarV1(sidecarRoot), refusal);
    await chmod(join(sidecarRoot, "MACOS_PROTECTED_DIRECTORY_SIDECAR.json"), 0o644);
    await chmod(join(sidecarRoot, "SHA256SUMS"), 0o666);
    await assert.rejects(verifyMacosProtectedDirectoryNativeSidecarV1(sidecarRoot), refusal);
    await chmod(join(sidecarRoot, "SHA256SUMS"), 0o644);
    await rm(join(sidecarRoot, "PROTECTED_DIRECTORY_MANIFEST.json"));
    await symlink("SHA256SUMS", join(sidecarRoot, "PROTECTED_DIRECTORY_MANIFEST.json"));
    await assert.rejects(verifyMacosProtectedDirectoryNativeSidecarV1(sidecarRoot), refusal);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native artifact requires the exact reviewed compiler flag list", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-flags-")));
  try {
    for (const [name, flags] of [["missing", PROTECTED_DIRECTORY_NATIVE_REVIEWED_CFLAGS_V1.slice(1)],
      ["changed", [...PROTECTED_DIRECTORY_NATIVE_REVIEWED_CFLAGS_V1.slice(0, -1), "-mmacosx-version-min=14.0"]],
      ["extra", [...PROTECTED_DIRECTORY_NATIVE_REVIEWED_CFLAGS_V1, "-g"]]]) {
      const target = join(root, name); await mkdir(target);
      const output = await artifact(target, "arm64", flags);
      await assert.rejects(verifyProtectedDirectoryNativeArtifactV1(output), refusal);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive parser refuses traversal, duplicate and malformed members, digest drift, links and hard links", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-archive-")));
  try {
    const traversal = async output => alterArchive(output, tar => {
        const header = tar.subarray(512, 1024); header.fill(0, 0, 100); header.write("agent-control-room-protected-directory-darwin-arm64/../escape", 0, "ascii"); tarChecksum(header);
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
      const name = "agent-control-room-protected-directory-darwin-arm64.tar.gz", path = join(output, name), tar = gunzipSync(await readFile(path));
      const end = tar.length - 1024, header = tar.subarray(512, 1024), size = Number.parseInt(header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim(), 8);
      const record = Buffer.from(tar.subarray(512, 1024 + Math.ceil(size / 512) * 512)), archive = gzipSync(Buffer.concat([tar.subarray(0, end), record, tar.subarray(end)]), { mtime: 0 });
      await writeFile(path, archive); await writeFile(join(output, "SHA256SUMS"), `${digest(archive)}  ${name}\n`);
    };
    for (const [name, change] of [["traversal", traversal], ["duplicate", duplicate], ["malformed", malformed],
      ["symbolic-link", symbolicLink], ["hard-link", hardLink]]) {
      const target = join(root, name); await mkdir(target); const output = await artifact(target); await change(output);
      await assert.rejects(verifyProtectedDirectoryNativeArtifactV1(output), refusal);
    }
    const digestTarget = join(root, "digest"); await mkdir(digestTarget); const digestOutput = await artifact(digestTarget);
    await writeFile(join(digestOutput, "agent-control-room-protected-directory-darwin-arm64.tar.gz"), Buffer.from("changed"));
    await assert.rejects(verifyProtectedDirectoryNativeArtifactV1(digestOutput), refusal);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("staging uses captured verified archive bytes despite later sidecar-path substitution", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-native-sidecar-custody-")));
  try {
    const source = await artifact(root), sidecarRoot = join(root, "sidecar"), parent = join(root, "parent"); await mkdir(parent, { mode: 0o700 });
    await copyVerifiedMacosProtectedDirectoryNativeSidecarV1({ artifactDirectory: source, destinationDirectory: sidecarRoot, releaseVersion: "0.1.0" });
    const original = fsPromises.mkdtemp;
    const hook = mock.method(fsPromises, "mkdtemp", async (...args) => {
      const result = await original(...args);
      await writeFile(join(sidecarRoot, "agent-control-room-protected-directory-darwin-arm64.tar.gz"), Buffer.from("substituted"));
      return result;
    });
    syncBuiltinESMExports();
    try {
      const staged = await stageMacosProtectedDirectoryNativeFactoryInputV1({ sidecarRoot, stagingParent: parent });
      assert.deepEqual(await readFile(staged.protectedRootNativeFactoryInput.executablePath), Buffer.from("inert fixture bytes\n"));
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
    await assert.rejects(copyVerifiedMacosProtectedDirectoryNativeSidecarV1(unsafe), refusal);
    assert.equal(await lstat(source).then(stat => stat.isDirectory()), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
