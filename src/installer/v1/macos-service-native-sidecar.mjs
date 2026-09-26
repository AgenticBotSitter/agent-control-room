import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MACOS_SERVICE_NATIVE_ARTIFACT_V1 = "control-room.macos-service-native-artifact/v1";
export const MACOS_SERVICE_NATIVE_SIDECAR_V1 = "control-room.macos-service-native-sidecar/v1";
export const MACOS_SERVICE_NATIVE_MANIFEST_NAME_V1 = "MACOS_SERVICE_NATIVE_MANIFEST.json";
export const MACOS_SERVICE_NATIVE_SIDECAR_MANIFEST_NAME_V1 = "MACOS_SERVICE_NATIVE_SIDECAR.json";
export const MACOS_SERVICE_NATIVE_REVIEWED_CFLAGS_V1 = Object.freeze([
  "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion", "-Wshadow", "-Wstrict-prototypes",
  "-fstack-protector-strong", "-D_FORTIFY_SOURCE=2", "-mmacosx-version-min=13.0",
]);

const EXECUTABLE_NAME = "macos-service-v1", CHECKSUM_NAME = "SHA256SUMS";
const ARTIFACT_NAMES = Object.freeze(["LICENSE", MACOS_SERVICE_NATIVE_MANIFEST_NAME_V1, "NOTICE", CHECKSUM_NAME, EXECUTABLE_NAME].sort());
const digestPattern = /^[a-f0-9]{64}$/u;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const refused = () => { throw new Error("macos_service_native_sidecar_refused"); };

function exact(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) refused();
  const captured = {};
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) refused();
    captured[key] = descriptor.value;
  }
  return Object.freeze(captured);
}
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function identityDigest(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) refused();
  return value;
}
function version(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) refused();
  return value;
}
async function canonicalDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/") refused();
  const [canonical, stat] = await Promise.all([realpath(value), lstat(value)]).catch(() => refused());
  if (canonical !== value || !stat.isDirectory() || stat.isSymbolicLink()) refused();
  return value;
}
async function regular(path, root, maximum, mode) {
  const [canonical, stat] = await Promise.all([realpath(path), lstat(path)]).catch(() => refused());
  if (canonical !== path || dirname(path) !== root || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 1 || stat.size > maximum || (stat.mode & 0o7777) !== mode) refused();
  return stat;
}
function parseManifest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 96 * 1024) refused();
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { return refused(); }
  exact(value, ["architecture", "files", "minimumMacos", "ownerQualified", "platform", "protocol", "schema",
    "sourceSha256", "toolchain"]);
  if (value.schema !== MACOS_SERVICE_NATIVE_ARTIFACT_V1 || value.platform !== "darwin"
    || !["arm64", "x64"].includes(value.architecture) || value.minimumMacos !== "13.0"
    || value.protocol !== "ACRSVC1" || !digestPattern.test(value.sourceSha256) || value.ownerQualified !== false) refused();
  exact(value.toolchain, ["compiler", "flags", "sdkVersion"]);
  if (typeof value.toolchain.compiler !== "string" || !/^Apple clang version [0-9][\x20-\x7e]{1,160}$/u.test(value.toolchain.compiler)
    || typeof value.toolchain.sdkVersion !== "string" || !/^\d+(?:\.\d+){1,2}$/u.test(value.toolchain.sdkVersion)
    || !Array.isArray(value.toolchain.flags)
    || JSON.stringify(value.toolchain.flags) !== JSON.stringify(MACOS_SERVICE_NATIVE_REVIEWED_CFLAGS_V1)) refused();
  if (!Array.isArray(value.files) || value.files.length !== 3) refused();
  const names = value.files.map(file => {
    exact(file, ["bytes", "mode", "path", "sha256"]);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || !digestPattern.test(file.sha256)
      || !["0644", "0755"].includes(file.mode) || !["LICENSE", "NOTICE", EXECUTABLE_NAME].includes(file.path)) refused();
    return file.path;
  });
  if (JSON.stringify(names) !== JSON.stringify(["LICENSE", "NOTICE", EXECUTABLE_NAME])
    || value.files[0].mode !== "0644" || value.files[1].mode !== "0644" || value.files[2].mode !== "0755"
    || !bytes.equals(canonicalBytes(value))) refused();
  return value;
}
function parseChecksums(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 4096 || !text.endsWith("\n")) refused();
  const result = new Map();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  (LICENSE|NOTICE|macos-service-v1|MACOS_SERVICE_NATIVE_MANIFEST\.json)$/u.exec(line);
    if (!match || result.has(match[2])) refused(); result.set(match[2], match[1]);
  }
  if (result.size !== 4) refused();
  return result;
}
async function artifactDirectory(input, allowsSidecar = false) {
  const root = await canonicalDirectory(input), entries = await readdir(root, { withFileTypes: true });
  const expected = allowsSidecar ? [...ARTIFACT_NAMES, MACOS_SERVICE_NATIVE_SIDECAR_MANIFEST_NAME_V1].sort() : ARTIFACT_NAMES;
  if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink())
    || JSON.stringify(entries.map(entry => entry.name).sort()) !== JSON.stringify(expected)) refused();
  await Promise.all([regular(join(root, "LICENSE"), root, 4 * 1024 * 1024, 0o644),
    regular(join(root, "NOTICE"), root, 4 * 1024 * 1024, 0o644),
    regular(join(root, EXECUTABLE_NAME), root, 16 * 1024 * 1024, 0o755),
    regular(join(root, MACOS_SERVICE_NATIVE_MANIFEST_NAME_V1), root, 96 * 1024, 0o644),
    regular(join(root, CHECKSUM_NAME), root, 4096, 0o644)]);
  const manifestBytes = await readFile(join(root, MACOS_SERVICE_NATIVE_MANIFEST_NAME_V1));
  const manifest = parseManifest(manifestBytes), checksums = parseChecksums(await readFile(join(root, CHECKSUM_NAME), "utf8"));
  const content = new Map();
  for (const name of ["LICENSE", "NOTICE", EXECUTABLE_NAME, MACOS_SERVICE_NATIVE_MANIFEST_NAME_V1]) {
    const bytes = await readFile(join(root, name));
    if (sha256(bytes) !== checksums.get(name)) refused(); content.set(name, bytes);
  }
  for (const file of manifest.files) {
    const bytes = content.get(file.path);
    if (!bytes || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) refused();
  }
  return Object.freeze({ root, manifest, manifestBytes, checksums, content });
}
function summary(artifact) {
  const executable = artifact.manifest.files.find(file => file.path === EXECUTABLE_NAME);
  return Object.freeze({ schema: MACOS_SERVICE_NATIVE_ARTIFACT_V1, platform: "darwin",
    architecture: artifact.manifest.architecture, minimumMacos: artifact.manifest.minimumMacos,
    protocol: artifact.manifest.protocol, sourceSha256: `sha256:${artifact.manifest.sourceSha256}`,
    artifactManifestSha256: `sha256:${sha256(artifact.manifestBytes)}`,
    executableSha256: `sha256:${executable.sha256}`, toolchain: Object.freeze(structuredClone(artifact.manifest.toolchain)),
    files: Object.freeze(structuredClone(artifact.manifest.files)), ownerQualified: false,
    compiles: false, downloads: false, installs: false, startsService: false });
}
export async function verifyMacosServiceNativeArtifactV1(directory, expected = {}) {
  const names = Object.getOwnPropertyNames(expected);
  if (names.some(name => !["architecture", "sourceSha256", "artifactManifestSha256", "executableSha256"].includes(name))) refused();
  const captured = exact(expected, names), verified = summary(await artifactDirectory(directory));
  for (const name of names) {
    const expectedValue = name === "architecture" ? captured[name] : identityDigest(captured[name]);
    if (expectedValue !== verified[name]) refused();
  }
  return verified;
}
function sidecarManifest(releaseVersion, releaseSha256, artifact) {
  return Object.freeze({ schema: MACOS_SERVICE_NATIVE_SIDECAR_V1, releaseVersion, releaseSha256,
    platform: artifact.platform, architecture: artifact.architecture, minimumMacos: artifact.minimumMacos,
    protocol: artifact.protocol, sourceSha256: artifact.sourceSha256,
    artifactManifestSha256: artifact.artifactManifestSha256, executableSha256: artifact.executableSha256,
    toolchain: artifact.toolchain, files: artifact.files });
}
export async function buildMacosServiceNativeSidecarManifestV1(input) {
  const captured = exact(input, ["artifactDirectory", "releaseVersion", "releaseSha256"]);
  return sidecarManifest(version(captured.releaseVersion), identityDigest(captured.releaseSha256),
    await verifyMacosServiceNativeArtifactV1(captured.artifactDirectory));
}
function parseSidecar(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 128 * 1024) refused();
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { return refused(); }
  exact(value, ["architecture", "artifactManifestSha256", "executableSha256", "files", "minimumMacos", "platform",
    "protocol", "releaseSha256", "releaseVersion", "schema", "sourceSha256", "toolchain"]);
  version(value.releaseVersion); identityDigest(value.releaseSha256); identityDigest(value.sourceSha256);
  identityDigest(value.artifactManifestSha256); identityDigest(value.executableSha256);
  const artifact = { schema: MACOS_SERVICE_NATIVE_ARTIFACT_V1, platform: value.platform, architecture: value.architecture,
    minimumMacos: value.minimumMacos, protocol: value.protocol, sourceSha256: value.sourceSha256.slice(7),
    toolchain: value.toolchain, files: value.files, ownerQualified: false };
  parseManifest(canonicalBytes(artifact));
  if (value.schema !== MACOS_SERVICE_NATIVE_SIDECAR_V1 || !bytes.equals(canonicalBytes(value))) refused();
  return value;
}
export async function verifyMacosServiceNativeSidecarV1(directory, expected = {}) {
  const names = Object.getOwnPropertyNames(expected);
  if (names.some(name => !["architecture", "releaseVersion", "releaseSha256", "sidecarManifestSha256",
    "sourceSha256", "executableSha256"].includes(name))) refused();
  const captured = exact(expected, names), artifact = await artifactDirectory(directory, true);
  const sidecarPath = join(artifact.root, MACOS_SERVICE_NATIVE_SIDECAR_MANIFEST_NAME_V1);
  await regular(sidecarPath, artifact.root, 128 * 1024, 0o644);
  const bytes = await readFile(sidecarPath), sidecar = parseSidecar(bytes), verified = summary(artifact);
  const found = { architecture: sidecar.architecture, releaseVersion: sidecar.releaseVersion,
    releaseSha256: sidecar.releaseSha256, sidecarManifestSha256: `sha256:${sha256(bytes)}`,
    sourceSha256: sidecar.sourceSha256, executableSha256: sidecar.executableSha256 };
  for (const name of names) {
    const expectedValue = name === "architecture" || name === "releaseVersion" ? captured[name] : identityDigest(captured[name]);
    if (expectedValue !== found[name]) refused();
  }
  const rebound = sidecarManifest(sidecar.releaseVersion, sidecar.releaseSha256, verified);
  if (!canonicalBytes(rebound).equals(bytes)) refused();
  return Object.freeze({ ...found, schema: MACOS_SERVICE_NATIVE_SIDECAR_V1, verified: true,
    platform: "darwin", minimumMacos: sidecar.minimumMacos, protocol: sidecar.protocol,
    artifactManifestSha256: sidecar.artifactManifestSha256, toolchain: verified.toolchain, files: verified.files,
    compiles: false, downloads: false, installs: false, startsService: false });
}
export async function copyVerifiedMacosServiceNativeSidecarV1(input) {
  const captured = exact(input, ["artifactDirectory", "destinationDirectory", "releaseVersion", "releaseSha256"]);
  if (typeof captured.destinationDirectory !== "string" || !isAbsolute(captured.destinationDirectory)
    || resolve(captured.destinationDirectory) !== captured.destinationDirectory || captured.destinationDirectory === "/") refused();
  await canonicalDirectory(dirname(captured.destinationDirectory));
  const artifact = await artifactDirectory(captured.artifactDirectory), verified = summary(artifact);
  const sidecar = sidecarManifest(version(captured.releaseVersion), identityDigest(captured.releaseSha256), verified);
  try { await access(captured.destinationDirectory); refused(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(captured.destinationDirectory, { mode: 0o755 });
  try {
    for (const name of ARTIFACT_NAMES) {
      const bytes = await readFile(join(artifact.root, name));
      await writeFile(join(captured.destinationDirectory, name), bytes, { flag: "wx", mode: name === EXECUTABLE_NAME ? 0o755 : 0o644 });
      await chmod(join(captured.destinationDirectory, name), name === EXECUTABLE_NAME ? 0o755 : 0o644);
    }
    await writeFile(join(captured.destinationDirectory, MACOS_SERVICE_NATIVE_SIDECAR_MANIFEST_NAME_V1), canonicalBytes(sidecar),
      { flag: "wx", mode: 0o644 });
    await chmod(join(captured.destinationDirectory, MACOS_SERVICE_NATIVE_SIDECAR_MANIFEST_NAME_V1), 0o644);
    return verifyMacosServiceNativeSidecarV1(captured.destinationDirectory, { releaseVersion: sidecar.releaseVersion,
      releaseSha256: sidecar.releaseSha256, sourceSha256: sidecar.sourceSha256,
      executableSha256: sidecar.executableSha256 });
  } catch (error) { await rm(captured.destinationDirectory, { recursive: true, force: true }); throw error; }
}
