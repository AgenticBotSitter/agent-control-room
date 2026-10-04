import { stableFileBytesV1, directoryCustodyV1 } from "../../../installer/shared/file-custody.mjs";
import { acquirePrivateProcessLockV1 } from "../../../installer/shared/private-process-lock.mjs";
import { parseStrictJsonV1 } from "../../../installer/shared/strict-json.mjs";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { captureReleaseTrustV1, signConnectorReleaseAdvertisementV1,
  verifyConnectorReleaseAdvertisementV1 } from "../../../../scripts/release-signing.mjs";

const refuse = () => { throw new Error("attended_connector_release_refused"); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const advertisementPath = "dist-vps/server/fleet/release/connector-release.json";
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const heldJson = bytes => { try { return parseStrictJsonV1(bytes.toString("utf8")); } catch { refuse(); } };

async function heldFile(path, expectedUid, maximum = 16 * 1024 * 1024) {
  return stableFileBytesV1(path, maximum, entry => {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== expectedUid
      || (entry.mode & 0o777) !== 0o400 || entry.size > maximum) refuse();
  }).catch(refuse);
}

async function atomicFile(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Runs only after the builder is stopped, source rechecked and output adopted by root.
 * The private installation key never enters the builder's argv or filesystem. */
async function signHeldRelease({ output, commit, trust: trustValue, privateKeyPath }, options = {}) {
  const expectedUid = options.expectedUid ?? 0;
  const trust = captureReleaseTrustV1(trustValue);
  const checks = [await directoryCustodyV1(output)];
  let directory = output;
  for (const part of ["dist-vps", "server", "fleet", "release"]) {
    directory = join(directory, part);
    checks.push(await directoryCustodyV1(directory));
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== expectedUid
      || (entry.mode & 0o022) !== 0 || await realpath(directory) !== directory) refuse();
  }
  const checkCustody = async () => { for (const check of checks) await check(); };
  await checkCustody();
  // Strict parsing, mapped to the release's own refusal (`heldJson`): a damaged
  // manifest or a null one is a decision, never a raw SyntaxError/TypeError crash.
  const manifest = heldJson(await heldFile(join(directory, "manifest.json"), expectedUid));
  if (!plain(manifest) || Object.keys(manifest).sort().join(",") !== "builtFrom,file,schema,sha256,size,version"
    || manifest.schema !== "control-room.fleet-connector-release/v1" || manifest.builtFrom !== commit
    || !/^\d+\.\d+\.\d+$/u.test(manifest.version ?? "") || manifest.file !== `connector-${manifest.version}.mjs`
    || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || !/^[a-f0-9]{64}$/u.test(manifest.sha256 ?? "")) refuse();
  const bundle = await heldFile(join(directory, manifest.file), expectedUid);
  if (bundle.length !== manifest.size || digest(bundle) !== manifest.sha256
    || /^\/\/ Control Room embedded release key ID: (sha256:[a-f0-9]{64})$/mu.exec(
      bundle.subarray(0, 16 * 1024).toString("utf8"))?.[1] !== trust.keyId) refuse();
  // Read the deterministic bundled assignment; never execute builder output here.
  const versions = [...bundle.toString("utf8").matchAll(/^var CONNECTOR_VERSION = "(\d+\.\d+\.\d+)";$/gmu)];
  if (versions.length !== 1 || versions[0][1] !== manifest.version) refuse();
  const unsigned = { version: manifest.version, file: manifest.file, size: manifest.size, sha256: manifest.sha256,
    builtFrom: manifest.builtFrom, minVersion: manifest.version };
  const signed = await signConnectorReleaseAdvertisementV1(unsigned, privateKeyPath, { expectedUid });
  // A mismatched installation private key must fail before any output changes.
  verifyConnectorReleaseAdvertisementV1(signed, trust);
  const signedBytes = Buffer.from(`${JSON.stringify(signed, null, 2)}\n`);
  const target = join(output, advertisementPath);
  const existing = await lstat(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing && !(await heldFile(target, expectedUid)).equals(signedBytes)) refuse();
  const buildManifestPath = join(output, "RELEASE_MANIFEST.json");
  const buildBytes = await heldFile(buildManifestPath, expectedUid);
  const buildManifest = heldJson(buildBytes);
  // The counts are the record of what was shipped. A string `fileCount` was
  // incremented as text -- "two" became "two1" -- so the build manifest was
  // signed and rewritten while no longer counting anything. Counts must be
  // nonnegative safe integers and must agree exactly with the members they
  // describe, and every member must be a well-formed file record.
  if (!plain(buildManifest) || buildManifest.schema !== "control-room.attended-build-manifest/v1" || buildManifest.commit !== commit
    || !Array.isArray(buildManifest.files) || buildManifest.files.some(item => !plain(item)
      || typeof item.path !== "string" || !item.path || !/^sha256:[a-f0-9]{64}$/u.test(item.sha256 ?? "")
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o7777)
    || !Number.isSafeInteger(buildManifest.fileCount) || buildManifest.fileCount !== buildManifest.files.length
    || !Number.isSafeInteger(buildManifest.byteCount) || buildManifest.byteCount < 0
    || buildManifest.byteCount !== buildManifest.files.reduce((sum, item) => sum + item.bytes, 0)) refuse();
  const record = { path: advertisementPath, sha256: `sha256:${digest(signedBytes)}`, mode: 0o400, bytes: signedBytes.length };
  const prior = buildManifest.files.filter(item => item.path === advertisementPath);
  if (prior.length > 1 || prior.length === 1 && JSON.stringify(prior[0]) !== JSON.stringify(record)) refuse();
  if (prior.length && !existing) refuse();
  if (!prior.length && buildManifest.byteCount > Number.MAX_SAFE_INTEGER - signedBytes.length) refuse();
  await options.fault?.("before_publish");
  await checkCustody();
  if (!existing) await atomicFile(target, signedBytes);
  await options.fault?.("advertisement_written");
  if (!prior.length) {
    buildManifest.files.push(record);
    buildManifest.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
    buildManifest.fileCount += 1; buildManifest.byteCount += signedBytes.length;
    await atomicFile(buildManifestPath, Buffer.from(`${JSON.stringify(buildManifest, null, 2)}\n`));
  }
  return signed;
}

export async function signAttendedConnectorReleaseV1(input, options = {}) {
  const entry = await lstat(input.output), expectedUid = options.expectedUid ?? 0;
  if (!isAbsolute(input.output ?? "") || resolve(input.output) !== input.output || input.output === "/"
    || !entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== expectedUid
    || (entry.mode & 0o022) !== 0 || await realpath(input.output) !== input.output) refuse();
  const lock = join(input.output, ".connector-signing.lock");
  const held = acquirePrivateProcessLockV1(lock, { expectedUid, busyCode: "attended_connector_release_busy" });
  try { return await signHeldRelease(input, options); }
  finally { held.release(); }
}
