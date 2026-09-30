import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RELEASE_SIGNING_CONFIG_SCHEMA_V1,
  RELEASE_TRUST_SCHEMA_V1,
  applyReleaseKeyRevocationsV1,
  applyReleaseKeyRotationV1,
  compareReleaseVersionsV1,
  createReleaseKeyRevocationsV1,
  createReleaseKeyRotationV1,
  generateInstallationReleaseKeyV1,
  raiseReleaseTrustFloorV1,
  releaseKeyIdV1,
  signConnectorReleaseAdvertisementV1,
  signReleaseArtifactsV1,
  verifySignedReleaseV1,
} from "../scripts/release-signing.mjs";
import { verifyConnectorReleaseAdvertisementV1 } from "../scripts/fleet/connector.mjs";
import { verifyInstallerSignedReleaseFromTrustFileV1,
  verifyInstallerSignedReleaseV1 } from "../src/installer/v1/signed-release-verifier.mjs";

const uid = process.geteuid?.() ?? 0;
const BUILT_FROM = "1".repeat(40);
const changed = value => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;

function child(args) {
  return new Promise((resolveChild, reject) => {
    const childProcess = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    childProcess.stdout.on("data", chunk => { stdout += chunk; });
    childProcess.stderr.on("data", chunk => { stderr += chunk; });
    childProcess.once("error", reject);
    childProcess.once("close", code => { resolveChild({ code, stdout, stderr }); });
  });
}

async function fixture(t, version = "1.2.0") {
  const root = await mkdtemp(join(tmpdir(), "control-room-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedRoot = join(root, "Protected"), releaseDirectory = join(root, "release");
  await mkdir(protectedRoot, { mode: 0o750 }); await chmod(protectedRoot, 0o750);
  await mkdir(join(protectedRoot, "config"), { mode: 0o750 }); await chmod(join(protectedRoot, "config"), 0o750);
  await mkdir(releaseDirectory, { mode: 0o700 });
  const gatewayConfigPath = join(protectedRoot, "config", "gateway.json");
  await writeFile(gatewayConfigPath, `${JSON.stringify({ schema: "control-room.fleet-gateway/v1", fixture: true })}\n`, { mode: 0o640 });
  await chmod(gatewayConfigPath, 0o640);
  const installed = await generateInstallationReleaseKeyV1({ protectedRoot, gatewayConfigPath, versionFloor: version },
    { expectedUid: uid });
  const connectorPath = join(releaseDirectory, `connector-${version}.mjs`);
  const updaterPath = join(releaseDirectory, `updater-${version}.tgz`);
  const webManifestPath = join(releaseDirectory, "web-build-manifest.json");
  await writeFile(connectorPath, "export const connector = true;\n");
  await writeFile(updaterPath, "updater fixture\n");
  await writeFile(webManifestPath, `${JSON.stringify({ files: ["app.js"] })}\n`);
  const connectorBytes = await readFile(connectorPath);
  const connectorManifestPath = join(releaseDirectory, "connector-manifest.json");
  const digest = (await import("node:crypto")).createHash("sha256").update(connectorBytes).digest("hex");
  await writeFile(connectorManifestPath, `${JSON.stringify({ schema: "control-room.fleet-connector-release/v1",
    version, file: `connector-${version}.mjs`, sha256: digest, size: connectorBytes.length,
    builtFrom: BUILT_FROM }, null, 2)}\n`);
  const input = { releaseDirectory, version, configPath: installed.configPath, connectorPath,
    connectorManifestPath, connectorMinVersion: version, updaterPath, webManifestPath };
  return { root, protectedRoot, gatewayConfigPath, installed, releaseDirectory, connectorPath,
    updaterPath, webManifestPath, connectorManifestPath, input };
}

test("the release signer binds all three artifacts and emits the connector updater's exact signature", async t => {
  const f = await fixture(t);
  const canonicalRoot = await realpath(f.root);
  assert.equal(f.installed.privateKeyPath, join(canonicalRoot, "updater-state", "release-signing-key.pem"));
  assert.equal(f.installed.configPath, join(canonicalRoot, "updater-state", "release-signing.json"));
  assert.equal(f.installed.trustPath, join(canonicalRoot, "Protected", "config", "release-trust.json"));
  const signed = await signReleaseArtifactsV1(f.input, { expectedUid: uid });
  const verified = await verifyInstallerSignedReleaseV1({ releaseDirectory: f.releaseDirectory, trust: f.installed.trust,
    installedVersion: "1.1.0", expectedBuiltFrom: BUILT_FROM });
  assert.equal(verified.version, "1.2.0"); assert.equal(verified.artifacts.length, 3);
  assert.equal(verified.builtFrom, BUILT_FROM);
  const verifiedFromPinnedFile = await verifyInstallerSignedReleaseFromTrustFileV1({
    releaseDirectory: f.releaseDirectory, trustPath: f.installed.trustPath,
    installedVersion: "1.1.0", expectedBuiltFrom: BUILT_FROM }, { expectedUid: uid });
  assert.equal(verifiedFromPinnedFile.sumsSha256, verified.sumsSha256);
  assert.equal(verifyConnectorReleaseAdvertisementV1(signed.connector, f.installed.trust).sha256,
    signed.artifacts.find(item => item.role === "connector").sha256);
  assert.throws(() => verifyConnectorReleaseAdvertisementV1({ ...signed.connector,
    signature: changed(signed.connector.signature) }, f.installed.trust), /signature/u);
  const notes = await readFile(join(f.releaseDirectory, "RELEASE_NOTES.signing.md"), "utf8");
  assert.match(notes, new RegExp(signed.connector.sha256, "u"));
  const gateway = JSON.parse(await readFile(f.gatewayConfigPath, "utf8"));
  assert.equal(gateway.releaseTrust, undefined, "key generation does not rewrite unrelated gateway configuration");
  assert.deepEqual(JSON.parse(await readFile(f.installed.trustPath, "utf8")), f.installed.trust);
  assert.equal(JSON.stringify(gateway).includes("PRIVATE KEY"), false);
});

test("the release and installer verification command lines share the pinned trust file", async t => {
  const f = await fixture(t);
  const signed = await child(["scripts/sign-release-artifacts.mjs", "--release-directory", f.releaseDirectory,
    "--version", "1.2.0", "--config", f.installed.configPath, "--connector", f.connectorPath,
    "--connector-manifest", f.connectorManifestPath, "--connector-min-version", "1.2.0",
    "--updater", f.updaterPath, "--web-manifest", f.webManifestPath]);
  assert.equal(signed.code, 0, signed.stderr);
  assert.equal(JSON.parse(signed.stdout).version, "1.2.0");
  const verified = await child(["scripts/verify-signed-release.mjs", "--release-directory", f.releaseDirectory,
    "--trust", f.installed.trustPath, "--installed-version", "1.1.0", "--built-from", BUILT_FROM]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).verified, true);
  const recorded = await child(["scripts/record-installed-release.mjs", "--trust", f.installed.trustPath,
    "--installed-version", "1.2.0"]);
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.equal(JSON.parse(recorded.stdout).versionFloor, "1.2.0");
  const replayed = await child(["scripts/verify-signed-release.mjs", "--release-directory", f.releaseDirectory,
    "--trust", f.installed.trustPath, "--installed-version", "1.2.0", "--built-from", BUILT_FROM]);
  assert.equal(replayed.code, 1, "the installer CLI refuses the just-installed release on replay");
  assert.equal((await child(["scripts/verify-signed-release.mjs", "--trust", f.installed.trustPath])).code, 2);
});

test("tampered sums, another key, an old release, truncation and huge artifacts all fail closed", async t => {
  await t.test("tampered SHA256SUMS", async t => {
    const f = await fixture(t); await signReleaseArtifactsV1(f.input, { expectedUid: uid });
    const path = join(f.releaseDirectory, "SHA256SUMS"), sums = await readFile(path, "utf8");
    await writeFile(path, `${sums[0] === "0" ? "1" : "0"}${sums.slice(1)}`);
    await assert.rejects(verifySignedReleaseV1({ releaseDirectory: f.releaseDirectory, trust: f.installed.trust,
      installedVersion: "1.1.0", expectedBuiltFrom: BUILT_FROM }), /release_signing_refused/u);
  });
  await t.test("signature by another key", async t => {
    const f = await fixture(t); await signReleaseArtifactsV1(f.input, { expectedUid: uid });
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const trust = { ...f.installed.trust, keyId: releaseKeyIdV1(other), publicKey: other };
    await assert.rejects(verifySignedReleaseV1({ releaseDirectory: f.releaseDirectory, trust,
      installedVersion: "1.1.0", expectedBuiltFrom: BUILT_FROM }), /release_signing_refused/u);
  });
  await t.test("changed Ed25519 signature", async t => {
    const f = await fixture(t); await signReleaseArtifactsV1(f.input, { expectedUid: uid });
    const path = join(f.releaseDirectory, "SHA256SUMS.sig"), record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, `${JSON.stringify({ ...record, signature: changed(record.signature) }, null, 2)}\n`);
    await assert.rejects(verifySignedReleaseV1({ releaseDirectory: f.releaseDirectory, trust: f.installed.trust,
      installedVersion: "1.1.0", expectedBuiltFrom: BUILT_FROM }), /signature/u);
  });
  await t.test("different checked-out source commit", async t => {
    const f = await fixture(t); await signReleaseArtifactsV1(f.input, { expectedUid: uid });
    await assert.rejects(verifySignedReleaseV1({ releaseDirectory: f.releaseDirectory, trust: f.installed.trust,
      installedVersion: "1.1.0", expectedBuiltFrom: "2".repeat(40) }), /signature_record/u);
  });
  await t.test("replayed older release", async t => {
    const f = await fixture(t); await signReleaseArtifactsV1(f.input, { expectedUid: uid });
    await assert.rejects(verifySignedReleaseV1({ releaseDirectory: f.releaseDirectory,
      trust: { ...f.installed.trust, versionFloor: "1.2.1" }, installedVersion: "1.1.0",
      expectedBuiltFrom: BUILT_FROM }), /version_floor/u);
  });
  await t.test("truncated artifact", async t => {
    const f = await fixture(t); await signReleaseArtifactsV1(f.input, { expectedUid: uid });
    await truncate(f.updaterPath, 1);
    await assert.rejects(verifySignedReleaseV1({ releaseDirectory: f.releaseDirectory, trust: f.installed.trust,
      installedVersion: "1.1.0", expectedBuiltFrom: BUILT_FROM }), /artifact_digest/u);
  });
  await t.test("huge sparse artifact", async t => {
    const f = await fixture(t); await truncate(f.updaterPath, 1024 * 1024 * 1024 + 1);
    await assert.rejects(signReleaseArtifactsV1(f.input, { expectedUid: uid }), /file_too_large/u);
  });
});

test("a release private key must be a single 0600 Ed25519 file selected by a 0600 config", async t => {
  const f = await fixture(t);
  await signReleaseArtifactsV1(f.input, { expectedUid: uid });
  await chmod(f.installed.privateKeyPath, 0o644);
  await assert.rejects(signReleaseArtifactsV1(f.input, { expectedUid: uid }), /file_mode/u);
  await chmod(f.installed.privateKeyPath, 0o600);
  await chmod(f.installed.configPath, 0o644);
  await assert.rejects(signReleaseArtifactsV1(f.input, { expectedUid: uid }), /file_mode/u);
  await chmod(f.installed.configPath, 0o600);
  await chmod(f.installed.trustPath, 0o644);
  await assert.rejects(verifyInstallerSignedReleaseFromTrustFileV1({
    releaseDirectory: f.releaseDirectory, trustPath: f.installed.trustPath,
    installedVersion: "1.1.0", expectedBuiltFrom: BUILT_FROM }, { expectedUid: uid }), /file_mode/u);
  await chmod(f.installed.trustPath, 0o640);
  await chmod(f.releaseDirectory, 0o750);
  await assert.rejects(verifyInstallerSignedReleaseFromTrustFileV1({
    releaseDirectory: f.releaseDirectory, trustPath: f.installed.trustPath,
    installedVersion: "1.1.0", expectedBuiltFrom: BUILT_FROM }, { expectedUid: uid }), /release_directory_custody/u);
  await chmod(f.releaseDirectory, 0o700);
  const config = JSON.parse(await readFile(f.installed.configPath, "utf8"));
  assert.equal(config.schema, RELEASE_SIGNING_CONFIG_SCHEMA_V1);
});

test("key bootstrap cannot escape Protected through a child-directory link or an outside gateway file", async t => {
  const root = await mkdtemp(join(tmpdir(), "control-room-key-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedRoot = join(root, "Protected"), outside = join(root, "outside");
  await mkdir(protectedRoot, { mode: 0o750 }); await chmod(protectedRoot, 0o750);
  await mkdir(join(protectedRoot, "config"), { mode: 0o750 }); await chmod(join(protectedRoot, "config"), 0o750);
  await mkdir(outside, { mode: 0o700 }); await symlink(outside, join(protectedRoot, "updater"), "dir");
  await symlink(outside, join(root, "updater-state"), "dir");
  const gatewayConfigPath = join(protectedRoot, "config", "gateway.json");
  await writeFile(gatewayConfigPath, "{}\n", { mode: 0o640 }); await chmod(gatewayConfigPath, 0o640);
  await assert.rejects(generateInstallationReleaseKeyV1({ protectedRoot, gatewayConfigPath,
    versionFloor: "1.0.0" }, { expectedUid: uid }), /private_directory/u);
  assert.deepEqual(await readdir(outside), []);

  await rm(join(root, "updater-state"));
  const outsideGateway = join(outside, "gateway.json");
  await writeFile(outsideGateway, "{}\n", { mode: 0o600 }); await chmod(outsideGateway, 0o600);
  await assert.rejects(generateInstallationReleaseKeyV1({ protectedRoot, gatewayConfigPath: outsideGateway,
    versionFloor: "1.0.0" }, { expectedUid: uid }), /gateway_config/u);
  assert.equal(await readFile(outsideGateway, "utf8"), "{}\n");

  const writableProtected = join(root, "WritableProtected"), writableConfig = join(writableProtected, "config");
  await mkdir(writableConfig, { recursive: true, mode: 0o750 }); await chmod(writableProtected, 0o770);
  const writableGateway = join(writableConfig, "gateway.json");
  await writeFile(writableGateway, "{}\n", { mode: 0o640 });
  await assert.rejects(generateInstallationReleaseKeyV1({ protectedRoot: writableProtected,
    gatewayConfigPath: writableGateway, versionFloor: "1.0.0" }, { expectedUid: uid }), /protected_root/u);

  const unsafeShared = join(root, "UnsafeShared"), unsafeConfig = join(unsafeShared, "config");
  await mkdir(unsafeConfig, { recursive: true, mode: 0o750 }); await chmod(unsafeShared, 0o750); await chmod(unsafeConfig, 0o770);
  const unsafeGateway = join(unsafeConfig, "gateway.json"); await writeFile(unsafeGateway, "{}\n", { mode: 0o640 });
  await assert.rejects(generateInstallationReleaseKeyV1({ protectedRoot: unsafeShared,
    gatewayConfigPath: unsafeGateway, versionFloor: "1.0.0" }, { expectedUid: uid }), /shared_directory/u);
});

test("version floors compare arbitrary-size SemVer identifiers without numeric rounding", () => {
  assert.equal(compareReleaseVersionsV1("9007199254740993.0.0", "9007199254740992.0.0"), 1);
  assert.equal(compareReleaseVersionsV1("1.0.0-9007199254740993", "1.0.0-9007199254740992"), 1);
});

test("installation key bootstrap survives a stop halfway, retries idempotently and serializes 20 callers", async t => {
  const root = await mkdtemp(join(tmpdir(), "control-room-key-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedRoot = join(root, "Protected"), gatewayConfigPath = join(protectedRoot, "gateway.json");
  await mkdir(protectedRoot, { mode: 0o750 }); await chmod(protectedRoot, 0o750);
  await mkdir(join(protectedRoot, "config"), { mode: 0o750 }); await chmod(join(protectedRoot, "config"), 0o750);
  const actualGatewayConfigPath = join(protectedRoot, "config", "gateway.json");
  await writeFile(actualGatewayConfigPath, "{}\n", { mode: 0o640 }); await chmod(actualGatewayConfigPath, 0o640);
  await assert.rejects(generateInstallationReleaseKeyV1({ protectedRoot, gatewayConfigPath, versionFloor: "2.0.0" }, {
    expectedUid: uid, fault: stage => { if (stage === "private_key_written") throw new Error("stopped"); },
  }), /stopped/u);
  const privateBefore = await readFile(join(root, "updater-state", "release-signing-key.pem"));
  const retried = await generateInstallationReleaseKeyV1({ protectedRoot, gatewayConfigPath: actualGatewayConfigPath, versionFloor: "2.0.0" },
    { expectedUid: uid });
  assert.deepEqual(await readFile(retried.privateKeyPath), privateBefore, "retry keeps the original private key");
  const results = await Promise.all(Array.from({ length: 20 }, () => generateInstallationReleaseKeyV1({
    protectedRoot, gatewayConfigPath: actualGatewayConfigPath, versionFloor: "2.0.0" }, { expectedUid: uid })));
  assert.equal(new Set(results.map(result => result.trust.keyId)).size, 1);
  assert.equal((await stat(retried.privateKeyPath)).mode & 0o777, 0o600);
});

test("installer version floor is non-decreasing under replay, rollback and 20 concurrent completions", async t => {
  const f = await fixture(t); await signReleaseArtifactsV1(f.input, { expectedUid: uid });
  await assert.rejects(verifyInstallerSignedReleaseV1({ releaseDirectory: f.releaseDirectory, trust: f.installed.trust,
    installedVersion: "1.2.0", expectedBuiltFrom: BUILT_FROM }), /installed_version/u,
  "an equal or older signed release is not an update");
  const rollback = await verifyInstallerSignedReleaseV1({ releaseDirectory: f.releaseDirectory, trust: f.installed.trust,
    installedVersion: "1.3.0", expectedBuiltFrom: BUILT_FROM, allowRollback: true });
  assert.equal(rollback.version, "1.2.0", "the explicit owner-approved rollback seam remains separate");

  await writeFile(`${f.installed.trustPath}.lock`, `${JSON.stringify({ pid: 2_147_483_647, token: "stopped" })}\n`,
    { mode: 0o600 });
  await raiseReleaseTrustFloorV1({ trustPath: f.installed.trustPath, installedVersion: "1.3.0" }, { expectedUid: uid });
  const versions = Array.from({ length: 20 }, (_, index) => `1.${index + 3}.0`);
  await Promise.all(versions.map(installedVersion => raiseReleaseTrustFloorV1({
    trustPath: f.installed.trustPath, installedVersion }, { expectedUid: uid })));
  const raised = JSON.parse(await readFile(f.installed.trustPath, "utf8"));
  assert.equal(raised.versionFloor, "1.22.0");
  assert.equal(raised.keyId, f.installed.trust.keyId);
  await raiseReleaseTrustFloorV1({ trustPath: f.installed.trustPath, installedVersion: "1.0.0" }, { expectedUid: uid });
  assert.equal(JSON.parse(await readFile(f.installed.trustPath, "utf8")).versionFloor, "1.22.0");
  await assert.rejects(verifyInstallerSignedReleaseFromTrustFileV1({ releaseDirectory: f.releaseDirectory,
    trustPath: f.installed.trustPath, installedVersion: "1.22.0", expectedBuiltFrom: BUILT_FROM },
  { expectedUid: uid }), /version_floor|installed_version/u);
});

test("generator retry cannot roll rotated trust, its floor or the gateway configuration backward", async t => {
  const f = await fixture(t, "2.0.0"), next = generateKeyPairSync("ed25519");
  const nextPublic = next.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const rotation = await createReleaseKeyRotationV1({ currentTrust: f.installed.trust, epoch: 2,
    toPublicKey: nextPublic, versionFloor: "2.5.0", oldPrivateKeyPath: f.installed.privateKeyPath }, { expectedUid: uid });
  const rotated = applyReleaseKeyRotationV1(rotation, f.installed.trust);
  await writeFile(f.installed.trustPath, `${JSON.stringify(rotated, null, 2)}\n`, { mode: 0o640 });
  await chmod(f.installed.trustPath, 0o640);
  const gatewayBefore = await readFile(f.gatewayConfigPath);
  await assert.rejects(generateInstallationReleaseKeyV1({ protectedRoot: f.protectedRoot,
    gatewayConfigPath: f.gatewayConfigPath, versionFloor: "0.0.1" }, { expectedUid: uid }), /trust_exists/u);
  assert.deepEqual(JSON.parse(await readFile(f.installed.trustPath, "utf8")), rotated);
  assert.deepEqual(await readFile(f.gatewayConfigPath), gatewayBefore);
  await rm(f.installed.privateKeyPath);
  await assert.rejects(generateInstallationReleaseKeyV1({ protectedRoot: f.protectedRoot,
    gatewayConfigPath: f.gatewayConfigPath, versionFloor: "2.5.0" }, { expectedUid: uid }), /trust_exists/u);
  await assert.rejects(stat(f.installed.privateKeyPath), error => error?.code === "ENOENT");
});

test("rotation is signed by the old key and signed revocations block retired keys", async t => {
  const f = await fixture(t, "3.0.0"), next = generateKeyPairSync("ed25519");
  const nextPublic = next.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const rotation = await createReleaseKeyRotationV1({ currentTrust: f.installed.trust, epoch: 2,
    toPublicKey: nextPublic, versionFloor: "3.1.0", oldPrivateKeyPath: f.installed.privateKeyPath }, { expectedUid: uid });
  const rotated = applyReleaseKeyRotationV1(rotation, f.installed.trust);
  assert.equal(rotated.keyId, releaseKeyIdV1(nextPublic)); assert.equal(rotated.versionFloor, "3.1.0");
  assert.deepEqual(rotated.revokedKeyIds, [f.installed.trust.keyId], "planned rotation retires the old key");
  const nextPrivate = join(f.root, "updater-state", "next.pem");
  await writeFile(nextPrivate, next.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 }); await chmod(nextPrivate, 0o600);
  const revocations = await createReleaseKeyRevocationsV1({ currentTrust: rotated, epoch: 3,
    revokedKeyIds: [f.installed.trust.keyId], privateKeyPath: nextPrivate }, { expectedUid: uid });
  const revoked = applyReleaseKeyRevocationsV1(revocations, rotated);
  assert.deepEqual(revoked.revokedKeyIds, [f.installed.trust.keyId]);
  const connector = await signConnectorReleaseAdvertisementV1({ version: "3.1.0", file: "connector-3.1.0.mjs",
    size: 10, sha256: "a".repeat(64), builtFrom: "b".repeat(40), minVersion: "3.1.0" }, nextPrivate, { expectedUid: uid });
  assert.equal(verifyConnectorReleaseAdvertisementV1(connector, revoked).version, "3.1.0");
  assert.throws(() => applyReleaseKeyRotationV1({ ...rotation, signature: changed(rotation.signature) }, f.installed.trust), /rotation/u);
  assert.throws(() => applyReleaseKeyRevocationsV1({ ...revocations, signature: changed(revocations.signature) }, rotated), /revocations/u);
  assert.throws(() => applyReleaseKeyRotationV1({ ...rotation, versionFloor: "2.0.0" }, f.installed.trust), /rotation/u);
});
