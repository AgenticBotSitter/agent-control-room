import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildMacosServiceNativeArtifactV1 } from "../scripts/build-macos-service-native.mjs";
import { buildMacosServiceNativeSidecarManifestV1, copyVerifiedMacosServiceNativeSidecarV1,
  verifyMacosServiceNativeArtifactV1, verifyMacosServiceNativeSidecarV1 } from
  "../src/installer/v1/macos-service-native-sidecar.mjs";

const nativeTest = process.platform === "darwin" ? test : test.skip;
const refused = { message: "macos_service_native_sidecar_refused" };
const releaseSha256 = `sha256:${"a".repeat(64)}`, otherDigest = `sha256:${"b".repeat(64)}`;
let root, artifact;

before(async () => {
  if (process.platform !== "darwin") return;
  root = await mkdtemp("/private/tmp/acr-service-sidecar-test-");
  artifact = join(root, "artifact"); await buildMacosServiceNativeArtifactV1({ outputDirectory: artifact });
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function copy(name) {
  const destinationDirectory = join(root, name);
  const verified = await copyVerifiedMacosServiceNativeSidecarV1({ artifactDirectory: artifact,
    destinationDirectory, releaseVersion: "0.1.0", releaseSha256 });
  return { destinationDirectory, verified };
}

nativeTest("the ACRSVC1 artifact is deterministic, inert, release-bound, and separately executable", async () => {
  const second = join(root, "second"), previousUmask = process.umask(0o077);
  try { await buildMacosServiceNativeArtifactV1({ outputDirectory: second }); }
  finally { process.umask(previousUmask); }
  assert.deepEqual(await readdir(second), await readdir(artifact));
  for (const name of await readdir(artifact)) assert.deepEqual(await readFile(join(artifact, name)), await readFile(join(second, name)));
  assert.equal((await lstat(second)).mode & 0o7777, 0o700);
  for (const name of ["LICENSE", "NOTICE", "MACOS_SERVICE_NATIVE_MANIFEST.json", "SHA256SUMS"])
    assert.equal((await lstat(join(second, name))).mode & 0o7777, 0o644);
  assert.equal((await lstat(join(second, "macos-service-v1"))).mode & 0o7777, 0o755);
  const built = await verifyMacosServiceNativeArtifactV1(artifact, { architecture: process.arch });
  assert.equal(built.protocol, "ACRSVC1"); assert.equal(built.ownerQualified, false);
  assert.equal(built.compiles, false); assert.equal(built.installs, false); assert.equal(built.startsService, false);
  const manifest = await buildMacosServiceNativeSidecarManifestV1({ artifactDirectory: artifact,
    releaseVersion: "0.1.0", releaseSha256 });
  const { destinationDirectory, verified } = await copy("valid");
  assert.equal(manifest.releaseSha256, releaseSha256); assert.equal(verified.releaseSha256, releaseSha256);
  assert.equal(verified.executableSha256, built.executableSha256);
  const checked = await verifyMacosServiceNativeSidecarV1(destinationDirectory, {
    releaseVersion: "0.1.0", releaseSha256, sidecarManifestSha256: verified.sidecarManifestSha256,
    architecture: process.arch, sourceSha256: built.sourceSha256, executableSha256: built.executableSha256 });
  assert.equal(checked.verified, true); assert.equal(checked.installs, false); assert.equal(checked.startsService, false);
});

nativeTest("source, executable, manifest, mode, link, and release substitution are refused", async () => {
  await assert.rejects(verifyMacosServiceNativeArtifactV1(artifact, { sourceSha256: otherDigest }), refused);
  for (const kind of ["executable", "manifest", "mode", "link"]) {
    const { destinationDirectory } = await copy(`tamper-${kind}`);
    const executable = join(destinationDirectory, "macos-service-v1");
    const manifest = join(destinationDirectory, "MACOS_SERVICE_NATIVE_MANIFEST.json");
    if (kind === "executable") { const bytes = await readFile(executable); bytes[0] ^= 1; await writeFile(executable, bytes); await chmod(executable, 0o755); }
    else if (kind === "manifest") { const value = JSON.parse(await readFile(manifest)); value.protocol = "ACRJNL1";
      await writeFile(manifest, `${JSON.stringify(value, null, 2)}\n`); }
    else if (kind === "mode") await chmod(executable, 0o775);
    else { await rm(manifest); await symlink(join(artifact, "MACOS_SERVICE_NATIVE_MANIFEST.json"), manifest); }
    await assert.rejects(verifyMacosServiceNativeSidecarV1(destinationDirectory), refused);
  }
  const valid = await copy("release-substitution");
  await assert.rejects(verifyMacosServiceNativeSidecarV1(valid.destinationDirectory, { releaseSha256: otherDigest }), refused);
});

nativeTest("copy/build refuse existing or noncanonical destinations before replacing data", async () => {
  const existing = join(root, "existing"); await mkdir(existing);
  await assert.rejects(copyVerifiedMacosServiceNativeSidecarV1({ artifactDirectory: artifact,
    destinationDirectory: existing, releaseVersion: "0.1.0", releaseSha256 }), refused);
  await assert.rejects(buildMacosServiceNativeArtifactV1({ outputDirectory: "/private/tmp/../escape" }),
    { message: "macos_service_native_build_refused" });
});
