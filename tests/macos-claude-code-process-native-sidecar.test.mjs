import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildClaudeCodeProcessNativeArtifactV1 } from "../scripts/build-claude-code-process-native.mjs";
import { buildMacosClaudeCodeProcessNativeSidecarManifestV1, copyVerifiedMacosClaudeCodeProcessNativeSidecarV1,
  retireMacosClaudeCodeProcessNativeFactoryInputV1, stageMacosClaudeCodeProcessNativeFactoryInputV1,
  verifyClaudeCodeProcessNativeArtifactV1, verifyMacosClaudeCodeProcessNativeSidecarV1 } from
  "../src/installer/v1/macos-claude-code-process-native-sidecar.mjs";

const nativeTest = process.platform === "darwin" ? test : test.skip;
const refusal = { message: "macos_claude_code_process_native_sidecar_refused" };
const releaseSha256 = `sha256:${"a".repeat(64)}`, otherDigest = `sha256:${"b".repeat(64)}`;
let root, artifact;
before(async () => {
  if (process.platform !== "darwin") return;
  root = await mkdtemp("/private/tmp/acr-claude-package-test-");
  artifact = join(root, "artifact");
  await buildClaudeCodeProcessNativeArtifactV1({ outputDirectory: artifact });
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function copy(name) {
  const destinationDirectory = join(root, name);
  const verified = await copyVerifiedMacosClaudeCodeProcessNativeSidecarV1({ artifactDirectory: artifact,
    destinationDirectory, releaseVersion: "0.1.0", releaseSha256 });
  return { destinationDirectory, verified };
}

nativeTest("native build is deterministic, inert, separately packaged, and release-bound", async () => {
  const second = join(root, "second");
  await buildClaudeCodeProcessNativeArtifactV1({ outputDirectory: second });
  for (const name of await readdir(artifact)) assert.deepEqual(await readFile(join(artifact, name)), await readFile(join(second, name)));
  const built = await verifyClaudeCodeProcessNativeArtifactV1(artifact);
  assert.equal(built.protocol, "ACRCCP1"); assert.equal(built.ownerQualified, false);
  assert.equal(built.compiles, false); assert.equal(built.installs, false); assert.equal(built.downloads, false);
  const manifest = await buildMacosClaudeCodeProcessNativeSidecarManifestV1({ artifactDirectory: artifact,
    releaseVersion: "0.1.0", releaseSha256 });
  const { destinationDirectory, verified } = await copy("valid");
  assert.equal(manifest.releaseSha256, releaseSha256); assert.equal(verified.releaseSha256, releaseSha256);
  assert.equal(verified.executableSha256, built.executableSha256);
  assert.equal((await verifyMacosClaudeCodeProcessNativeSidecarV1(destinationDirectory, {
    releaseVersion: "0.1.0", releaseSha256, sidecarManifestSha256: verified.sidecarManifestSha256,
    architecture: process.arch, macosVersion: "13.0" })).verified, true);
  await assert.rejects(buildClaudeCodeProcessNativeArtifactV1({ outputDirectory: artifact }));
});

nativeTest("sidecar refuses wrong release, manifest pin, architecture, minimum OS, or protocol", async () => {
  const { destinationDirectory } = await copy("pins");
  for (const expected of [{ releaseSha256: otherDigest }, { sidecarManifestSha256: otherDigest },
    { releaseVersion: "0.2.0" }, { architecture: process.arch === "arm64" ? "x64" : "arm64" }, { macosVersion: "12.6" }])
    await assert.rejects(verifyMacosClaudeCodeProcessNativeSidecarV1(destinationDirectory, expected), refusal);
  const path = join(destinationDirectory, "MACOS_CLAUDE_CODE_PROCESS_SIDECAR.json");
  const value = JSON.parse(await readFile(path)); value.protocol = "ACRJNL1";
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await assert.rejects(verifyMacosClaudeCodeProcessNativeSidecarV1(destinationDirectory), refusal);
});

nativeTest("sidecar rejects altered archive, executable claims, compiler flags, links and writable files", async () => {
  for (const kind of ["archive", "executable", "flags", "link", "mode"]) {
    const { destinationDirectory, verified } = await copy(`tamper-${kind}`);
    const manifestPath = join(destinationDirectory, "CLAUDE_CODE_PROCESS_MANIFEST.json");
    if (kind === "archive") {
      const archivePath = join(destinationDirectory, `agent-control-room-claude-code-process-darwin-${process.arch}.tar.gz`);
      const bytes = await readFile(archivePath); bytes[40] ^= 1; await writeFile(archivePath, bytes);
    } else if (kind === "link") { await rm(manifestPath); await symlink(join(artifact, "CLAUDE_CODE_PROCESS_MANIFEST.json"), manifestPath); }
    else if (kind === "mode") await chmod(manifestPath, 0o666);
    else {
      const manifest = JSON.parse(await readFile(manifestPath));
      if (kind === "flags") manifest.toolchain.flags.push("-g");
      else manifest.files.at(-1).sha256 = "c".repeat(64);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await assert.rejects(verifyMacosClaudeCodeProcessNativeSidecarV1(destinationDirectory, {
      releaseSha256, sidecarManifestSha256: verified.sidecarManifestSha256 }), refusal);
  }
});

nativeTest("copy refuses existing destination, symlinked parent, missing release binding and extra public entries", async () => {
  const destinationDirectory = join(root, "already-there"); await mkdir(destinationDirectory);
  await assert.rejects(copyVerifiedMacosClaudeCodeProcessNativeSidecarV1({ artifactDirectory: artifact,
    destinationDirectory, releaseVersion: "0.1.0", releaseSha256 }), refusal);
  const parent = join(root, "linked-parent"); await symlink(root, parent);
  await assert.rejects(copyVerifiedMacosClaudeCodeProcessNativeSidecarV1({ artifactDirectory: artifact,
    destinationDirectory: join(parent, "escape"), releaseVersion: "0.1.0", releaseSha256 }), refusal);
  await assert.rejects(buildMacosClaudeCodeProcessNativeSidecarManifestV1({ artifactDirectory: artifact,
    releaseVersion: "0.1.0" }), refusal);
  const extra = await copy("extra"); await writeFile(join(extra.destinationDirectory, "unreviewed"), "extra");
  await assert.rejects(verifyMacosClaudeCodeProcessNativeSidecarV1(extra.destinationDirectory), refusal);
});

nativeTest("verified release custody stages one private helper and retires it without starting Claude", async () => {
  const { destinationDirectory, verified } = await copy("staging");
  const staged = await stageMacosClaudeCodeProcessNativeFactoryInputV1({
    expectedArchiveSha256: verified.archiveSha256,
    expectedArtifactManifestSha256: verified.artifactManifestSha256,
    expectedExecutableSha256: verified.executableSha256,
    expectedReleaseSha256: verified.releaseSha256,
    expectedReleaseVersion: verified.releaseVersion,
    expectedSidecarManifestSha256: verified.sidecarManifestSha256,
    sidecarRoot: destinationDirectory, stagingParent: root,
  });
  assert.equal(staged.staged, true);
  assert.equal(staged.claudeCodeProcessPortFactoryInput.helperSha256, verified.executableSha256);
  assert.deepEqual((await readdir(staged.stagingRoot)).sort(),
    ["CLAUDE_CODE_PROCESS_MANIFEST.json", "LICENSE", "NOTICE", "claude-code-process-v1"]);
  await retireMacosClaudeCodeProcessNativeFactoryInputV1(staged);
  await assert.rejects(readdir(staged.stagingRoot), error => error?.code === "ENOENT");
  await assert.rejects(retireMacosClaudeCodeProcessNativeFactoryInputV1(staged), refusal,
    "retirement cannot become a generic recursive-delete primitive");
});

test("native build refuses a noncanonical output before toolchain or filesystem effects", async () => {
  await assert.rejects(buildClaudeCodeProcessNativeArtifactV1({ outputDirectory: "/private/tmp/../escape" }),
    { message: "claude_code_process_native_build_refused" });
});
