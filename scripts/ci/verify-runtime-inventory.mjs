#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { Readable } from "node:stream";
import { validateRuntimeInventoryV1 } from "../../src/updater/v1/trusted-runtime.mjs";
import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";

const inventoryPath = fileURLToPath(new URL("../../src/updater/v1/policy/runtime-inventory.json", import.meta.url));
class VerificationFailure extends Error {}
const refuse = (tool, step) => { throw new VerificationFailure(`runtime_inventory_verification_failed:${tool}:${step}`); };
async function atStep(tool, step, operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof VerificationFailure) throw error;
    refuse(tool, `${step}${error?.code === "ENOENT" ? "_missing" : ""}`);
  }
}

async function downloadToFile(url, destination, maximumBytes, tool, step) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok) refuse(tool, `${step}_http_${response.status}`);
  if (!response.body || !response.url.startsWith("https://")) refuse(tool, `${step}_response_invalid`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) refuse(tool, `${step}_size_limit`);
  let bytes = 0;
  const bound = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maximumBytes ? new VerificationFailure(`runtime_inventory_verification_failed:${tool}:${step}_size_limit`) : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  return bytes;
}

function run(file, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { env: { LANG: "C", LC_ALL: "C" }, shell: false,
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0;
    const append = (current, chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("runtime_inventory_verification_failed")); }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error("runtime_inventory_verification_failed")));
  });
}

async function digests(path) {
  const sha256 = createHash("sha256"), sha512 = createHash("sha512");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; sha256.update(chunk); sha512.update(chunk); }
  return { bytes, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

async function verifyNodeGpg({ artifact, proof, workDirectory, download, execute = run }) {
  const plain = join(workDirectory, "node-SHASUMS256.txt"), signature = join(workDirectory, "node-SHASUMS256.txt.asc");
  const keyring = join(workDirectory, "node-release-keys.kbx"), verified = join(workDirectory, "node-SHASUMS256.verified");
  await download(proof.shasumsUrl, plain, 4 * 1024 * 1024, "node_shasums_download");
  await download(proof.signatureUrl, signature, 8 * 1024 * 1024, "node_signature_download");
  await download(proof.keyringUrl, keyring, 32 * 1024 * 1024, "node_keyring_download");
  const result = await atStep(artifact.tool, "node_gpg_verify", () => execute("/usr/bin/gpgv",
    ["--homedir", workDirectory, "--status-fd=1", "--keyring", keyring, "--output", verified, signature]));
  const valid = result.stdout.split(/\r?\n/u).find(line => line.startsWith("[GNUPG:] VALIDSIG "));
  if (!valid) refuse(artifact.tool, "node_gpg_validsig_missing");
  const fields = valid.split(/\s+/u), signingFingerprint = fields[2], primaryFingerprint = fields.at(-1);
  if (![signingFingerprint, primaryFingerprint].some(value => proof.signerFingerprints.includes(value))) refuse(artifact.tool, "node_gpg_signer_mismatch");
  const [declared, authenticated] = await atStep(artifact.tool, "node_gpg_authenticated_read",
    () => Promise.all([readFile(plain, "utf8"), readFile(verified, "utf8")]));
  if (declared !== authenticated) refuse(artifact.tool, "node_shasums_content_mismatch");
  const matching = authenticated.split(/\r?\n/u).filter(line => line.endsWith(`  ${artifact.archiveName}`));
  if (matching.length !== 1 || matching[0] !== `${artifact.archiveSha256}  ${artifact.archiveName}`) refuse(artifact.tool, "node_shasums_archive_mismatch");
}

async function verifyNpmIntegrity({ artifact, proof, workDirectory, download, archiveSha512 }) {
  const metadataPath = join(workDirectory, "esbuild-metadata.json");
  await download(proof.metadataUrl, metadataPath, 1024 * 1024, "npm_metadata_download");
  let metadata;
  try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); } catch { refuse(artifact.tool, "npm_metadata_invalid"); }
  if (metadata?.dist?.integrity !== `sha512-${proof.sha512}` || archiveSha512 !== proof.sha512) refuse(artifact.tool, "npm_integrity_mismatch");
  if (metadata?.dist?.tarball !== artifact.url) refuse(artifact.tool, "npm_tarball_mismatch");
}

export async function verifyRuntimeInventoryV1(input, runtime = {}) {
  const inventory = await atStep("inventory", "validate", () => validateRuntimeInventoryV1(input.inventory));
  const download = runtime.downloadToFile ?? downloadToFile;
  const nodeVerifier = runtime.verifyNodeGpg ?? verifyNodeGpg;
  const npmVerifier = runtime.verifyNpmIntegrity ?? verifyNpmIntegrity;
  const verified = [];
  for (const artifact of inventory.artifacts) {
    const artifactRoot = join(input.workDirectory, artifact.tool);
    await atStep(artifact.tool, "work_directory", () => (runtime.mkdir ?? mkdir)(artifactRoot, { recursive: false, mode: 0o700 }));
    const archive = join(artifactRoot, artifact.archiveName);
    const artifactDownload = (url, destination, maximumBytes, step) => atStep(artifact.tool, step,
      () => download(url, destination, maximumBytes, artifact.tool, step));
    const downloadedBytes = await artifactDownload(artifact.url, archive, artifact.archiveBytes + 1, "archive_download");
    const actual = await atStep(artifact.tool, "archive_read", () => digests(archive));
    if (downloadedBytes !== artifact.archiveBytes || actual.bytes !== artifact.archiveBytes
      || actual.sha256 !== artifact.archiveSha256) refuse(artifact.tool, "archive_digest_or_size_mismatch");
    if (artifact.publisherProof.kind === "nodejs-shasums-gpg") {
      await nodeVerifier({ artifact, proof: artifact.publisherProof,
        workDirectory: artifactRoot, download: artifactDownload, execute: runtime.run ?? run });
    } else if (artifact.publisherProof.kind === "npm-integrity") {
      await npmVerifier({ artifact, proof: artifact.publisherProof,
        workDirectory: artifactRoot, download: artifactDownload, archiveSha512: actual.sha512 });
    }
    verified.push(Object.freeze({ tool: artifact.tool, archiveSha256: actual.sha256, archiveBytes: actual.bytes,
      publisherProof: artifact.publisherProof.kind }));
  }
  return Object.freeze({ schema: "control-room.runtime-inventory-verification/v1", verified: Object.freeze(verified) });
}

async function main() {
  const workDirectory = await mkdtemp(join(tmpdir(), "control-room-runtime-inventory-"));
  try {
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    const result = await verifyRuntimeInventoryV1({ inventory, workDirectory });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof VerificationFailure ? error.message : "runtime_inventory_verification_failed:inventory:setup_or_cleanup"}\n`);
    process.exitCode = 1;
  });
}
