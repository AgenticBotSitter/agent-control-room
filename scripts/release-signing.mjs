import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { parseStrictJsonV1 } from "../src/installer/shared/strict-json.mjs";
import { acquireKernelFileLockV1 } from "../src/installer/shared/private-process-lock.mjs";
import { chmod, chown, link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const RELEASE_SIGNING_CONFIG_SCHEMA_V1 = "control-room.release-signing-config/v1";
export const RELEASE_SUMS_SIGNATURE_SCHEMA_V1 = "control-room.release-sums-signature/v1";
export const CONNECTOR_UPDATE_SIGNATURE_SCHEMA_V1 = "control-room.fleet-connector-signature/v1";
export const RELEASE_TRUST_SCHEMA_V1 = "control-room.release-trust/v1";
export const RELEASE_KEY_ROTATION_SCHEMA_V1 = "control-room.release-key-rotation/v1";
export const RELEASE_KEY_REVOCATIONS_SCHEMA_V1 = "control-room.release-key-revocations/v1";
export const INSTALLATION_RELEASE_KEY_SCHEMA_V1 = "control-room.installation-release-key/v1";
export const MAX_RELEASE_SUMS_BYTES_V1 = 64 * 1024;
export const MAX_RELEASE_ARTIFACT_BYTES_V1 = 1024 * 1024 * 1024;
export const MAX_CONNECTOR_RELEASE_BYTES_V1 = 16 * 1024 * 1024;

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u;
const CONNECTOR_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const KEY_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{56,128}$/u;
const SAFE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

export class ReleaseSigningRefusal extends Error {
  constructor(reason) {
    super(`release_signing_refused:${reason}`);
    this.code = "release_signing_refused";
    this.reason = reason;
  }
}

const refuse = reason => { throw new ReleaseSigningRefusal(reason); };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (value, names, reason) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...names].sort().join(",")) refuse(reason);
  return value;
};

function versionParts(value) {
  if (typeof value !== "string") refuse("version");
  const match = VERSION_PATTERN.exec(value);
  if (!match) refuse("version");
  return { core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split(".") ?? [] };
}

export function compareReleaseVersionsV1(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index += 1) if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const av = a.prerelease[index], bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/u.test(av), bn = /^\d+$/u.test(bv);
    if (an && bn) return BigInt(av) < BigInt(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function cleanAbsolutePath(value, reason = "path") {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === sep
    || /[\u0000-\u001f\u007f]/u.test(value)) refuse(reason);
  return value;
}

function cleanPublicKey(value) {
  if (typeof value !== "string" || !PUBLIC_KEY_PATTERN.test(value)) refuse("public_key");
  let key;
  try { key = createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" }); }
  catch { refuse("public_key"); }
  if (key.asymmetricKeyType !== "ed25519"
    || key.export({ format: "der", type: "spki" }).toString("base64url") !== value) refuse("public_key");
  return key;
}

export function releaseKeyIdV1(publicKey) {
  const key = cleanPublicKey(publicKey);
  return `sha256:${sha256(key.export({ format: "der", type: "spki" }))}`;
}

export function captureReleaseTrustV1(value) {
  const input = exact(value, ["schema", "epoch", "keyId", "publicKey", "versionFloor", "revokedKeyIds"], "trust");
  // Types are checked before the patterns, because a pattern coerces its
  // argument to a string and silently disarms the check built on it. An ARRAY
  // floor passed `VERSION_PATTERN`, then stringified to "0.5.0" by the version
  // comparator; a key ID nested in an array passed `KEY_ID_PATTERN` while making
  // `revokedKeyIds.includes(keyId)` false, so a self-revoked key still verified
  // its own releases. The bare `keyId` needs no separate type check: an array or
  // number cannot match its pattern, and the equality check against the derived
  // key ID below only passes for the exact string.
  if (input.schema !== RELEASE_TRUST_SCHEMA_V1 || !Number.isSafeInteger(input.epoch) || input.epoch < 1
    || typeof input.keyId !== "string" || !KEY_ID_PATTERN.test(input.keyId)
    || typeof input.versionFloor !== "string" || !VERSION_PATTERN.test(input.versionFloor)
    || !Array.isArray(input.revokedKeyIds) || input.revokedKeyIds.some(key => typeof key !== "string" || !KEY_ID_PATTERN.test(key))
    || new Set(input.revokedKeyIds).size !== input.revokedKeyIds.length) refuse("trust");
  cleanPublicKey(input.publicKey);
  if (releaseKeyIdV1(input.publicKey) !== input.keyId || input.revokedKeyIds.includes(input.keyId)) refuse("trust");
  return Object.freeze({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: input.epoch, keyId: input.keyId,
    publicKey: input.publicKey, versionFloor: input.versionFloor,
    revokedKeyIds: Object.freeze([...input.revokedKeyIds].sort()) });
}

async function stableFile(path, maxBytes, { exactMode, expectedUid } = {}) {
  cleanAbsolutePath(path);
  const before = await lstat(path).catch(() => refuse("file_missing"));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes)
    refuse(before.size > maxBytes ? "file_too_large" : "file");
  if (exactMode !== undefined && process.platform !== "win32" && (before.mode & 0o777) !== exactMode) refuse("file_mode");
  if (expectedUid !== undefined && process.platform !== "win32" && before.uid !== expectedUid) refuse("file_owner");
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK;
  const handle = await open(path, flags).catch(() => refuse("file_open"));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) refuse("file_changed");
    const digest = createHash("sha256"), chunks = [], buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > maxBytes || position > before.size) refuse("file_too_large");
      const chunk = Buffer.from(buffer.subarray(0, bytesRead)); digest.update(chunk); chunks.push(chunk);
    }
    const after = await handle.stat();
    if (position !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) refuse("file_changed");
    return Object.freeze({ bytes: Buffer.concat(chunks), size: position, sha256: digest.digest("hex"), stat: after });
  } finally { await handle.close(); }
}

async function stableFileRetry(path, maxBytes, options) {
  const transient = new Set(["file", "file_changed", "file_missing", "file_open"]);
  // A retry must never weaken a refusal. Once any attempt has proved the file
  // changed identity under us, that is the security-relevant answer, and it has
  // to survive the loop: a substitution makes every later attempt fail the
  // generic pre-open shape check instead, so rethrowing the LAST error would
  // downgrade a caught substitution to a plain "file".
  let changed;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return await stableFile(path, maxBytes, options); }
    catch (error) {
      if (!(error instanceof ReleaseSigningRefusal) || !transient.has(error.reason)) throw error;
      if (error.reason === "file_changed") changed = error;
      if (attempt === 19) throw changed ?? error;
      await new Promise(resolveRetry => setImmediate(resolveRetry));
    }
  }
  refuse("file_changed");
}

async function privateSigningKey(path, expectedUid = process.geteuid?.()) {
  const captured = await stableFileRetry(path, 16 * 1024, { exactMode: 0o600, expectedUid });
  let key;
  try { key = createPrivateKey(captured.bytes); } catch { refuse("private_key"); }
  if (key.asymmetricKeyType !== "ed25519") refuse("private_key");
  return key;
}

async function signingConfiguration(path, expectedUid = process.geteuid?.()) {
  const captured = await stableFile(cleanAbsolutePath(path, "config_path"), 16 * 1024,
    { exactMode: 0o600, expectedUid });
  let parsed;
  try { parsed = parseStrictJsonV1(captured.bytes.toString("utf8")); } catch { refuse("config"); }
  const config = exact(parsed, ["schema", "privateKeyPath"], "config");
  if (config.schema !== RELEASE_SIGNING_CONFIG_SCHEMA_V1) refuse("config");
  cleanAbsolutePath(config.privateKeyPath, "private_key_path");
  return Object.freeze({ schema: RELEASE_SIGNING_CONFIG_SCHEMA_V1, privateKeyPath: config.privateKeyPath });
}

function releaseSumsSignatureMaterialV1(version, builtFrom, sumsSha256) {
  versionParts(version);
  if ((typeof builtFrom !== "string" || !COMMIT_PATTERN.test(builtFrom))) refuse("built_from");
  if ((typeof sumsSha256 !== "string" || !DIGEST_PATTERN.test(sumsSha256))) refuse("sums_digest");
  return Buffer.from(`${RELEASE_SUMS_SIGNATURE_SCHEMA_V1}\n${version}\n${builtFrom}\n${sumsSha256}\n`, "utf8");
}

function cleanConnectorRelease(value, signatureOptional = false) {
  const names = ["builtFrom", "file", "minVersion", "sha256", "signature", "size", "version"];
  const input = exact(value, names, "connector_advertisement");
  if ((typeof input.version !== "string" || !CONNECTOR_VERSION_PATTERN.test(input.version)) || input.file !== `connector-${input.version}.mjs`
    || (typeof input.minVersion !== "string" || !CONNECTOR_VERSION_PATTERN.test(input.minVersion)) || compareReleaseVersionsV1(input.version, input.minVersion) < 0
    || (typeof input.sha256 !== "string" || !DIGEST_PATTERN.test(input.sha256)) || (!signatureOptional && (typeof input.signature !== "string" || !SIGNATURE_PATTERN.test(input.signature)))
    || (signatureOptional && input.signature !== "" && (typeof input.signature !== "string" || !SIGNATURE_PATTERN.test(input.signature)))
    || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_CONNECTOR_RELEASE_BYTES_V1
    || (typeof input.builtFrom !== "string" || !COMMIT_PATTERN.test(input.builtFrom))) refuse("connector_advertisement");
  return Object.freeze({ version: input.version, file: input.file, sha256: input.sha256, size: input.size,
    builtFrom: input.builtFrom, minVersion: input.minVersion, signature: input.signature });
}

export function connectorReleaseSignatureMaterialV1(value) {
  const release = cleanConnectorRelease({ ...value, signature: value.signature ?? "" }, true);
  return Buffer.from(`${CONNECTOR_UPDATE_SIGNATURE_SCHEMA_V1}\n${release.version}\n${release.file}\n${release.size}\n${release.sha256}\n${release.builtFrom}\n${release.minVersion}\n`, "utf8");
}

export async function signConnectorReleaseAdvertisementV1(value, privateKeyPath, options = {}) {
  const unsigned = cleanConnectorRelease({ ...value, signature: "" }, true);
  const key = await privateSigningKey(cleanAbsolutePath(privateKeyPath, "private_key_path"), options.expectedUid);
  return Object.freeze({ ...unsigned,
    signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned), key).toString("base64url") });
}

export function verifyConnectorReleaseAdvertisementV1(value, trustValue, requiredFloor) {
  const release = cleanConnectorRelease(value), trust = typeof trustValue === "string"
    ? captureReleaseTrustV1({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: releaseKeyIdV1(trustValue),
      publicKey: trustValue, versionFloor: requiredFloor ?? "0.0.0", revokedKeyIds: [] })
    : captureReleaseTrustV1(trustValue);
  const floor = requiredFloor ?? trust.versionFloor;
  if (compareReleaseVersionsV1(release.version, floor) < 0) refuse("version_floor");
  if (trust.revokedKeyIds.includes(trust.keyId)) refuse("key_revoked");
  if (!verify(null, connectorReleaseSignatureMaterialV1(release), cleanPublicKey(trust.publicKey),
    Buffer.from(release.signature, "base64url"))) refuse("signature");
  return release;
}

// Publish only complete, synced bytes. A dead writer can leave a private
// temporary, but can never reserve the final name with a partial file.
async function publishOnce(path, bytes, mode, options = {}) {
  const temporary = join(dirname(path), `.${basename(path)}.publish-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(bytes); await handle.chmod(mode);
      if (options.gid !== undefined) await handle.chown(options.expectedUid, options.gid);
      await handle.sync();
    } finally { await handle.close(); }
    try { await link(temporary, path); }
    catch (error) { if (error?.code === "EEXIST") return false; throw error; }
    await rm(temporary, { force: true });
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } finally { await rm(temporary, { force: true }); }
}

// A kill between link and unlink leaves a complete final file with a second
// name. Remove only our publication aliases of that same inode; never replace
// an established key or touch an unrelated temporary.
async function recoverPublicationAliases(path, expectedUid) {
  const published = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!published || published.nlink === 1) return;
  if (!published.isFile() || published.isSymbolicLink() || published.uid !== expectedUid) refuse("file");
  const prefix = `.${basename(path)}.publish-`;
  for (const name of await readdir(dirname(path))) {
    if (!name.startsWith(prefix) || !/^[0-9]+-[a-f0-9]{16}$/u.test(name.slice(prefix.length))) continue;
    const alias = join(dirname(path), name), entry = await lstat(alias).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (entry?.dev === published.dev && entry.ino === published.ino && entry.isFile() && !entry.isSymbolicLink()) {
      await rm(alias, { force: true });
    }
  }
}

async function writeOnceOrMatch(path, bytes, mode, options = {}) {
  if (await publishOnce(path, bytes, mode, options)) return true;
  const existing = await stableFileRetry(path, Math.max(bytes.length, 1) + 1,
    { exactMode: mode, expectedUid: options.expectedUid });
  if (!existing.bytes.equals(Buffer.from(bytes))) refuse("output_exists");
  return false;
}

function directChild(path, root) {
  const part = relative(root, path);
  return part !== "" && !part.startsWith(`..${sep}`) && !isAbsolute(part) && !part.includes(sep) && SAFE_FILE_PATTERN.test(part);
}

function parseConnectorManifest(value, connector) {
  const input = exact(value, ["schema", "version", "file", "sha256", "size", "builtFrom"], "connector_manifest");
  if (input.schema !== "control-room.fleet-connector-release/v1" || (typeof input.version !== "string" || !VERSION_PATTERN.test(input.version))
    || input.file !== basename(connector.path) || input.file !== `connector-${input.version}.mjs`
    || input.sha256 !== connector.sha256 || input.size !== connector.size || (typeof input.builtFrom !== "string" || !COMMIT_PATTERN.test(input.builtFrom)))
    refuse("connector_manifest");
  return input;
}

export async function signReleaseArtifactsV1(input, options = {}) {
  const suppliedReleaseDirectory = cleanAbsolutePath(input.releaseDirectory, "release_directory");
  const suppliedRootStat = await lstat(suppliedReleaseDirectory).catch(() => refuse("release_directory"));
  if (!suppliedRootStat.isDirectory() || suppliedRootStat.isSymbolicLink()) refuse("release_directory");
  const releaseDirectory = await realpath(suppliedReleaseDirectory);
  const rootStat = await lstat(releaseDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refuse("release_directory");
  versionParts(input.version);
  const config = await signingConfiguration(input.configPath, options.expectedUid);
  const key = await privateSigningKey(config.privateKeyPath, options.expectedUid);
  const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url");
  const keyId = releaseKeyIdV1(publicKey);
  const roles = [
    ["connector", input.connectorPath, MAX_CONNECTOR_RELEASE_BYTES_V1],
    ["updater", input.updaterPath, MAX_RELEASE_ARTIFACT_BYTES_V1],
    ["web", input.webManifestPath, 16 * 1024 * 1024],
  ];
  const artifacts = [];
  for (const [role, rawPath, limit] of roles) {
    const path = cleanAbsolutePath(rawPath, `${role}_path`);
    const canonicalPath = await realpath(path).catch(() => refuse("file_missing"));
    if (!directChild(canonicalPath, releaseDirectory)) refuse("artifact_location");
    const captured = await stableFile(path, limit);
    artifacts.push(Object.freeze({ role, path, file: basename(path), size: captured.size, sha256: captured.sha256 }));
  }
  if (new Set(artifacts.map(item => item.file)).size !== artifacts.length) refuse("artifact_name");
  const connectorManifestPath = cleanAbsolutePath(input.connectorManifestPath, "connector_manifest_path");
  if (!directChild(await realpath(connectorManifestPath).catch(() => refuse("file_missing")), releaseDirectory))
    refuse("artifact_location");
  const connectorManifestBytes = await stableFile(connectorManifestPath, 64 * 1024);
  let connectorManifest;
  try { connectorManifest = JSON.parse(connectorManifestBytes.bytes.toString("utf8")); }
  catch { refuse("connector_manifest"); }
  const connector = artifacts.find(item => item.role === "connector");
  const capturedManifest = parseConnectorManifest(connectorManifest, connector);
  if (capturedManifest.version !== input.version) refuse("connector_manifest");
  const sumsBytes = Buffer.from(artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(""), "utf8");
  if (sumsBytes.length > MAX_RELEASE_SUMS_BYTES_V1) refuse("sums_too_large");
  const sumsSha256 = sha256(sumsBytes);
  const signature = sign(null, releaseSumsSignatureMaterialV1(input.version, capturedManifest.builtFrom, sumsSha256), key)
    .toString("base64url");
  const signatureRecord = Object.freeze({ schema: RELEASE_SUMS_SIGNATURE_SCHEMA_V1, version: input.version,
    keyId, builtFrom: capturedManifest.builtFrom, sumsSha256, signature });
  const connectorAdvertisement = Object.freeze({ version: capturedManifest.version, file: capturedManifest.file,
    size: capturedManifest.size, sha256: capturedManifest.sha256, builtFrom: capturedManifest.builtFrom,
    minVersion: input.connectorMinVersion, signature: "" });
  const signedConnector = Object.freeze({ ...connectorAdvertisement,
    signature: sign(null, connectorReleaseSignatureMaterialV1(connectorAdvertisement), key).toString("base64url") });
  const notes = Buffer.from(`## Release integrity\n\nConnector SHA-256: \`${connector.sha256}\`\n\nRelease key: \`${keyId}\`\n`, "utf8");
  await options.fault?.("before_outputs");
  await writeOnceOrMatch(join(releaseDirectory, "SHA256SUMS"), sumsBytes, 0o644);
  await options.fault?.("sums_written");
  await writeOnceOrMatch(join(releaseDirectory, "SHA256SUMS.sig"), Buffer.from(`${JSON.stringify(signatureRecord, null, 2)}\n`), 0o644);
  await writeOnceOrMatch(join(releaseDirectory, "connector-release.json"), Buffer.from(`${JSON.stringify(signedConnector, null, 2)}\n`), 0o644);
  await writeOnceOrMatch(join(releaseDirectory, "RELEASE_NOTES.signing.md"), notes, 0o644);
  return Object.freeze({ releaseDirectory, version: input.version, keyId, sumsSha256,
    artifacts: Object.freeze(artifacts), connector: signedConnector });
}

function parseSums(bytes) {
  if (bytes.length < 1 || bytes.length > MAX_RELEASE_SUMS_BYTES_V1 || bytes[bytes.length - 1] !== 0x0a) refuse("sums");
  const lines = bytes.toString("utf8").split("\n"); lines.pop();
  if (lines.length !== 3) refuse("sums");
  const entries = lines.map(line => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]{0,199})$/u.exec(line);
    if (!match) refuse("sums");
    return { sha256: match[1], file: match[2] };
  });
  if (new Set(entries.map(entry => entry.file)).size !== entries.length) refuse("sums");
  return entries;
}

export async function verifySignedReleaseV1(input) {
  const suppliedReleaseDirectory = cleanAbsolutePath(input.releaseDirectory, "release_directory");
  const suppliedRootStat = await lstat(suppliedReleaseDirectory).catch(() => refuse("release_directory"));
  if (!suppliedRootStat.isDirectory() || suppliedRootStat.isSymbolicLink()) refuse("release_directory");
  const releaseDirectory = await realpath(suppliedReleaseDirectory);
  const rootStat = await lstat(releaseDirectory);
  const expectedUid = input.expectedUid ?? process.geteuid?.();
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || process.platform !== "win32" && (rootStat.uid !== expectedUid || (rootStat.mode & 0o777) !== 0o700))
    refuse("release_directory_custody");
  const trust = captureReleaseTrustV1(input.trust);
  versionParts(input.installedVersion);
  if (input.allowRollback !== undefined && typeof input.allowRollback !== "boolean") refuse("rollback_authority");
  if (typeof input.expectedBuiltFrom !== "string" || !COMMIT_PATTERN.test(input.expectedBuiltFrom)) refuse("built_from");
  const sums = await stableFile(join(releaseDirectory, "SHA256SUMS"), MAX_RELEASE_SUMS_BYTES_V1);
  const signatureFile = await stableFile(join(releaseDirectory, "SHA256SUMS.sig"), 16 * 1024);
  let signature;
  try { signature = JSON.parse(signatureFile.bytes.toString("utf8")); } catch { refuse("signature_record"); }
  signature = exact(signature, ["schema", "version", "keyId", "builtFrom", "sumsSha256", "signature"], "signature_record");
  if (signature.schema !== RELEASE_SUMS_SIGNATURE_SCHEMA_V1 || (typeof signature.version !== "string" || !VERSION_PATTERN.test(signature.version))
    || signature.keyId !== trust.keyId || signature.builtFrom !== input.expectedBuiltFrom
    || (typeof signature.builtFrom !== "string" || !COMMIT_PATTERN.test(signature.builtFrom)) || signature.sumsSha256 !== sums.sha256
    || (typeof signature.signature !== "string" || !SIGNATURE_PATTERN.test(signature.signature)) || trust.revokedKeyIds.includes(signature.keyId))
    refuse("signature_record");
  if (input.allowRollback !== true && compareReleaseVersionsV1(signature.version, trust.versionFloor) < 0)
    refuse("version_floor");
  if (input.allowRollback !== true && compareReleaseVersionsV1(signature.version, input.installedVersion) <= 0)
    refuse("installed_version");
  if (!verify(null, releaseSumsSignatureMaterialV1(signature.version, signature.builtFrom, signature.sumsSha256), cleanPublicKey(trust.publicKey),
    Buffer.from(signature.signature, "base64url"))) refuse("signature");
  const entries = parseSums(sums.bytes), artifacts = [];
  for (const entry of entries) {
    const path = join(releaseDirectory, entry.file);
    if (!directChild(path, releaseDirectory)) refuse("artifact_location");
    const limit = entry.file.startsWith("connector-") ? MAX_CONNECTOR_RELEASE_BYTES_V1 : MAX_RELEASE_ARTIFACT_BYTES_V1;
    const captured = await stableFile(path, limit);
    if (captured.sha256 !== entry.sha256) refuse("artifact_digest");
    artifacts.push(Object.freeze({ file: entry.file, size: captured.size, sha256: captured.sha256 }));
  }
  return Object.freeze({ verified: true, version: signature.version, builtFrom: signature.builtFrom, keyId: signature.keyId,
    sumsSha256: signature.sumsSha256, artifacts: Object.freeze(artifacts) });
}

export async function verifySignedReleaseFromTrustFileV1(input, options = {}) {
  const captured = await stableFile(cleanAbsolutePath(input.trustPath, "trust_path"), 64 * 1024,
    { exactMode: 0o640, expectedUid: options.expectedUid ?? process.geteuid?.() });
  let trust;
  try { trust = parseStrictJsonV1(captured.bytes.toString("utf8")); } catch { refuse("trust"); }
  return verifySignedReleaseV1({ releaseDirectory: input.releaseDirectory, trust: captureReleaseTrustV1(trust),
    installedVersion: input.installedVersion, expectedBuiltFrom: input.expectedBuiltFrom,
    allowRollback: input.allowRollback, expectedUid: options.expectedUid ?? process.geteuid?.() });
}

function rotationMaterial(value) {
  return Buffer.from(`${RELEASE_KEY_ROTATION_SCHEMA_V1}\n${value.epoch}\n${value.fromKeyId}\n${value.toKeyId}\n${value.toPublicKey}\n${value.versionFloor}\n`, "utf8");
}

export async function createReleaseKeyRotationV1(input, options = {}) {
  const current = captureReleaseTrustV1(input.currentTrust), toKeyId = releaseKeyIdV1(input.toPublicKey);
  if (!Number.isSafeInteger(input.epoch) || input.epoch !== current.epoch + 1 || toKeyId === current.keyId
    || current.revokedKeyIds.includes(toKeyId) || compareReleaseVersionsV1(input.versionFloor, current.versionFloor) < 0)
    refuse("rotation");
  const unsigned = Object.freeze({ schema: RELEASE_KEY_ROTATION_SCHEMA_V1, epoch: input.epoch,
    fromKeyId: current.keyId, toKeyId, toPublicKey: input.toPublicKey, versionFloor: input.versionFloor });
  const key = await privateSigningKey(input.oldPrivateKeyPath, options.expectedUid);
  if (releaseKeyIdV1(createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url")) !== current.keyId)
    refuse("rotation_key");
  return Object.freeze({ ...unsigned, signature: sign(null, rotationMaterial(unsigned), key).toString("base64url") });
}

export function applyReleaseKeyRotationV1(value, currentValue) {
  const current = captureReleaseTrustV1(currentValue);
  const input = exact(value, ["schema", "epoch", "fromKeyId", "toKeyId", "toPublicKey", "versionFloor", "signature"], "rotation");
  if (input.schema !== RELEASE_KEY_ROTATION_SCHEMA_V1 || input.epoch !== current.epoch + 1
    || input.fromKeyId !== current.keyId || releaseKeyIdV1(input.toPublicKey) !== input.toKeyId
    || current.revokedKeyIds.includes(input.toKeyId)
    || (typeof input.signature !== "string" || !SIGNATURE_PATTERN.test(input.signature))
    || !verify(null, rotationMaterial(input), cleanPublicKey(current.publicKey), Buffer.from(input.signature, "base64url")))
    refuse("rotation");
  return captureReleaseTrustV1({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: input.epoch, keyId: input.toKeyId,
    publicKey: input.toPublicKey, versionFloor: compareReleaseVersionsV1(current.versionFloor, input.versionFloor) > 0
      ? current.versionFloor : input.versionFloor,
    revokedKeyIds: [...new Set([...current.revokedKeyIds, current.keyId])].sort() });
}

function revocationMaterial(value) {
  return Buffer.from(`${RELEASE_KEY_REVOCATIONS_SCHEMA_V1}\n${value.epoch}\n${value.signerKeyId}\n${value.revokedKeyIds.join(",")}\n`, "utf8");
}

export async function createReleaseKeyRevocationsV1(input, options = {}) {
  const current = captureReleaseTrustV1(input.currentTrust), revokedKeyIds = [...new Set(input.revokedKeyIds ?? [])].sort();
  if (!Number.isSafeInteger(input.epoch) || input.epoch <= current.epoch || revokedKeyIds.length < 1
    || revokedKeyIds.some(key => typeof key !== "string" || !KEY_ID_PATTERN.test(key) || key === current.keyId)) refuse("revocations");
  const unsigned = Object.freeze({ schema: RELEASE_KEY_REVOCATIONS_SCHEMA_V1, epoch: input.epoch,
    signerKeyId: current.keyId, revokedKeyIds: Object.freeze(revokedKeyIds) });
  const key = await privateSigningKey(input.privateKeyPath, options.expectedUid);
  if (releaseKeyIdV1(createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url")) !== current.keyId)
    refuse("revocation_key");
  return Object.freeze({ ...unsigned, signature: sign(null, revocationMaterial(unsigned), key).toString("base64url") });
}

export function applyReleaseKeyRevocationsV1(value, currentValue) {
  const current = captureReleaseTrustV1(currentValue);
  const input = exact(value, ["schema", "epoch", "signerKeyId", "revokedKeyIds", "signature"], "revocations");
  if (input.schema !== RELEASE_KEY_REVOCATIONS_SCHEMA_V1 || !Number.isSafeInteger(input.epoch) || input.epoch <= current.epoch
    || input.signerKeyId !== current.keyId || !Array.isArray(input.revokedKeyIds) || input.revokedKeyIds.length < 1
    || input.revokedKeyIds.some(key => typeof key !== "string" || !KEY_ID_PATTERN.test(key) || key === current.keyId)
    || new Set(input.revokedKeyIds).size !== input.revokedKeyIds.length || (typeof input.signature !== "string" || !SIGNATURE_PATTERN.test(input.signature))
    || !verify(null, revocationMaterial({ ...input, revokedKeyIds: [...input.revokedKeyIds].sort() }), cleanPublicKey(current.publicKey),
      Buffer.from(input.signature, "base64url"))) refuse("revocations");
  return captureReleaseTrustV1({ ...current, epoch: input.epoch,
    revokedKeyIds: [...new Set([...current.revokedKeyIds, ...input.revokedKeyIds])].sort() });
}

async function writePrivateKeyOnce(path, bytes) {
  return publishOnce(path, bytes, 0o600);
}

async function securePrivateDirectory(path, expectedUid) {
  let created = false;
  try { await mkdir(path, { mode: 0o700 }); created = true; }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  if (created && process.platform !== "win32") await chmod(path, 0o700);
  const info = await lstat(path).catch(() => refuse("private_directory"));
  const canonical = await realpath(path).catch(() => refuse("private_directory"));
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== path
    || process.platform !== "win32" && (info.uid !== expectedUid || (info.mode & 0o777) !== 0o700))
    refuse("private_directory");
}

async function atomicJson(path, value, mode = 0o600, gid) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  if (process.platform !== "win32") await chmod(temporary, mode);
  if (process.platform !== "win32" && gid !== undefined) await chown(temporary, process.geteuid?.() ?? 0, gid);
  await rename(temporary, path);
}

async function secureSharedDirectory(path, expectedUid) {
  let created = false;
  try { await mkdir(path, { mode: 0o750 }); created = true; }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  if (created && process.platform !== "win32") await chmod(path, 0o750);
  const info = await lstat(path).catch(() => refuse("shared_directory"));
  const canonical = await realpath(path).catch(() => refuse("shared_directory"));
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== path
    || process.platform !== "win32" && (info.uid !== expectedUid || (info.mode & 0o027) !== 0))
    refuse("shared_directory");
  return info;
}

async function existingTrust(path, expectedUid) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!info.isFile()) refuse("trust_exists");
  const captured = await stableFile(path, 64 * 1024, { exactMode: 0o640, expectedUid });
  try { return captureReleaseTrustV1(parseStrictJsonV1(captured.bytes.toString("utf8"))); }
  catch { refuse("trust_exists"); }
}

function sameTrust(left, right) { return JSON.stringify(captureReleaseTrustV1(left)) === JSON.stringify(captureReleaseTrustV1(right)); }

async function withTrustLock(path, work, options = {}) {
  const lockPath = `${path}.lock`, attempts = options.attempts ?? 500;
  let held;
  for (let attempt = 0; ; attempt += 1) {
    try {
      held = await acquireKernelFileLockV1(lockPath, { expectedUid: options.expectedUid ?? process.geteuid?.(), busyCode: "trust_busy" });
      break;
    } catch (error) {
      if (error?.code !== "trust_busy") throw error;
      if (attempt >= attempts) refuse("trust_busy");
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  }
  try { return await work(); } finally {
    try { await held.release(); } catch { refuse("trust_lock_owner_changed"); }
  }
}

export async function raiseReleaseTrustFloorV1(input, options = {}) {
  const trustPath = cleanAbsolutePath(input.trustPath, "trust_path");
  versionParts(input.installedVersion);
  const expectedUid = options.expectedUid ?? process.geteuid?.();
  return withTrustLock(trustPath, async () => {
    const captured = await stableFile(trustPath, 64 * 1024, { exactMode: 0o640, expectedUid });
    let trust;
    try { trust = captureReleaseTrustV1(parseStrictJsonV1(captured.bytes.toString("utf8"))); }
    catch { refuse("trust"); }
    if (compareReleaseVersionsV1(input.installedVersion, trust.versionFloor) <= 0) return trust;
    const raised = captureReleaseTrustV1({ ...trust, versionFloor: input.installedVersion });
    await atomicJson(trustPath, raised, 0o640, captured.stat.gid);
    return raised;
  }, options);
}

export async function generateInstallationReleaseKeyV1(input, options = {}) {
  const suppliedProtectedRoot = cleanAbsolutePath(input.protectedRoot, "protected_root");
  const suppliedRootInfo = await lstat(suppliedProtectedRoot).catch(() => refuse("protected_root"));
  if (!suppliedRootInfo.isDirectory() || suppliedRootInfo.isSymbolicLink()) refuse("protected_root");
  const protectedRoot = await realpath(suppliedProtectedRoot);
  const rootInfo = await lstat(protectedRoot);
  const expectedUid = options.expectedUid ?? 0;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || process.platform !== "win32" && (rootInfo.uid !== expectedUid || (rootInfo.mode & 0o022) !== 0)) refuse("protected_root");
  versionParts(input.versionFloor);
  const installationRoot = dirname(protectedRoot);
  const privateKeyPath = join(installationRoot, "updater-state", "release-signing-key.pem");
  const trustPath = join(protectedRoot, "config", "release-trust.json");
  const configPath = join(installationRoot, "updater-state", "release-signing.json");
  await securePrivateDirectory(dirname(privateKeyPath), expectedUid);
  const trustDirectory = await secureSharedDirectory(dirname(trustPath), expectedUid);
  for (const path of [privateKeyPath, configPath, trustPath]) await recoverPublicationAliases(path, expectedUid);
  const priorTrust = await existingTrust(trustPath, expectedUid);
  let key;
  if (priorTrust) {
    try { key = await privateSigningKey(privateKeyPath, expectedUid); }
    catch { refuse("trust_exists"); }
  } else {
    const generated = generateKeyPairSync("ed25519");
    const privateBytes = generated.privateKey.export({ format: "pem", type: "pkcs8" });
    await writePrivateKeyOnce(privateKeyPath, privateBytes);
    await options.fault?.("private_key_written");
    key = await privateSigningKey(privateKeyPath, expectedUid);
  }
  const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url");
  const trust = captureReleaseTrustV1({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: releaseKeyIdV1(publicKey),
    publicKey, versionFloor: input.versionFloor, revokedKeyIds: [] });
  if (priorTrust && !sameTrust(priorTrust, trust)) refuse("trust_exists");
  await writeOnceOrMatch(configPath, Buffer.from(`${JSON.stringify({ schema: RELEASE_SIGNING_CONFIG_SCHEMA_V1,
    privateKeyPath }, null, 2)}\n`), 0o600, { expectedUid });
  const trustCreated = await writeOnceOrMatch(trustPath, Buffer.from(`${JSON.stringify(trust, null, 2)}\n`), 0o640,
    { expectedUid, gid: trustDirectory.gid });
  if (trustCreated && process.platform !== "win32") await chown(trustPath, expectedUid, trustDirectory.gid);
  if (input.gatewayConfigPath) {
    const gatewayPath = cleanAbsolutePath(input.gatewayConfigPath, "gateway_config_path");
    const gatewayCanonical = await realpath(gatewayPath).catch(() => refuse("gateway_config"));
    if (gatewayCanonical !== join(protectedRoot, "config", "gateway.json")) refuse("gateway_config");
    const gatewayFile = await stableFileRetry(gatewayPath, 1024 * 1024, { expectedUid });
    if (process.platform !== "win32" && (gatewayFile.stat.mode & 0o037) !== 0) refuse("gateway_config");
    let gateway;
    try { gateway = JSON.parse(gatewayFile.bytes.toString("utf8")); } catch { refuse("gateway_config"); }
    if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) refuse("gateway_config");
    if (Object.hasOwn(gateway, "releaseTrust")) refuse("gateway_config");
  }
  return Object.freeze({ schema: INSTALLATION_RELEASE_KEY_SCHEMA_V1, privateKeyPath, configPath, trustPath, trust });
}
