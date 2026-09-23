import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * This is a separately-versioned macOS sidecar for the claude-code-process
 * helper. Build/copied bytes remain inert: no staging or execution API exists.
 * It deliberately does not enter the portable Node release: that
 * release normalizes all members to 0644. No function here compiles, installs,
 * downloads, starts a service, or selects an owner path.
 */
export const MACOS_CLAUDE_CODE_PROCESS_NATIVE_SIDECAR_V1 =
  "control-room.macos-claude-code-process-native-sidecar/v1";
export const CLAUDE_CODE_PROCESS_NATIVE_ARTIFACT_V1 =
  "control-room.claude-code-process-native-artifact/v1";
export const CLAUDE_CODE_PROCESS_NATIVE_MANIFEST_NAME_V1 = "CLAUDE_CODE_PROCESS_MANIFEST.json";
export const MACOS_CLAUDE_CODE_PROCESS_SIDECAR_MANIFEST_NAME_V1 = "MACOS_CLAUDE_CODE_PROCESS_SIDECAR.json";
const CHECKSUM_NAME = "SHA256SUMS";
const EXECUTABLE_NAME = "claude-code-process-v1";
export const CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1 = Object.freeze([
  "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion", "-Wshadow", "-Wstrict-prototypes",
  "-fstack-protector-strong", "-D_FORTIFY_SOURCE=2", "-mmacosx-version-min=13.0",
]);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const refused = () => { throw new Error("macos_claude_code_process_native_sidecar_refused"); };

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
function safeRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || value.endsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) refused();
  return value;
}
function inside(child, parent) {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}
async function canonicalDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) refused();
  const [canonical, stat] = await Promise.all([realpath(value), lstat(value)]).catch(() => refused());
  if (canonical !== value || !stat.isDirectory() || stat.isSymbolicLink()) refused();
  return value;
}
async function regular(path, root, maximum = MAX_ARCHIVE_BYTES) {
  const [canonical, stat] = await Promise.all([realpath(path), lstat(path)]).catch(() => refused());
  if (canonical !== path || !inside(path, root) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 1 || stat.size > maximum) refused();
  return stat;
}
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function version(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) refused();
  return value;
}
function digestIdentity(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) refused();
  return value;
}
function minimumMacos(value) {
  if (typeof value !== "string" || !/^1[3-9]\.0$/u.test(value)) refused();
  return value;
}
function parseArtifactManifest(bytes) {
  if (bytes.byteLength > 64 * 1024) refused();
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return refused(); }
  exact(value, ["architecture", "files", "minimumMacos", "ownerQualified", "platform", "protocol", "schema", "sourceSha256", "toolchain"]);
  if (value.schema !== CLAUDE_CODE_PROCESS_NATIVE_ARTIFACT_V1 || value.platform !== "darwin"
    || !["arm64", "x64"].includes(value.architecture) || minimumMacos(value.minimumMacos) !== "13.0"
    || value.protocol !== "ACRCCP1" || !digestPattern.test(value.sourceSha256) || value.ownerQualified !== false) refused();
  exact(value.toolchain, ["compiler", "flags", "sdkVersion"]);
  if (typeof value.toolchain.compiler !== "string" || !/^Apple clang version [0-9][\x20-\x7e]{1,160}$/u.test(value.toolchain.compiler)
    || typeof value.toolchain.sdkVersion !== "string" || !/^\d+(?:\.\d+){1,2}$/u.test(value.toolchain.sdkVersion)
    || !Array.isArray(value.toolchain.flags)
    || JSON.stringify(value.toolchain.flags) !== JSON.stringify(CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1)) refused();
  if (!Array.isArray(value.files) || value.files.length !== 3) refused();
  const paths = value.files.map(file => {
    exact(file, ["bytes", "mode", "path", "sha256"]);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || !digestPattern.test(file.sha256)
      || !["0644", "0755"].includes(file.mode)) refused();
    return safeRelative(file.path);
  });
  if (JSON.stringify(paths) !== JSON.stringify(["LICENSE", "NOTICE", EXECUTABLE_NAME])) refused();
  if (value.files[0].mode !== "0644" || value.files[1].mode !== "0644" || value.files[2].mode !== "0755") refused();
  if (!bytes.equals(canonicalBytes(value))) refused();
  return value;
}
function parseOctal(bytes) {
  const text = bytes.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(text)) refused();
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number) || number < 0) refused();
  return number;
}
function ascii(bytes) {
  const end = bytes.indexOf(0), field = bytes.subarray(0, end < 0 ? bytes.length : end);
  if ([...field].some(byte => byte < 0x20 || byte > 0x7f)) refused();
  return field.toString("ascii");
}
function verifyHeader(header) {
  const expected = parseOctal(header.subarray(148, 156)), copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  if (copy.reduce((total, byte) => total + byte, 0) !== expected) refused();
}
function expectedDirectories(paths) {
  const result = new Set([""]);
  for (const path of paths) for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) result.add(parent.split(sep).join("/"));
  return result;
}
/** Parse the tiny archive ourselves so extraction never accepts links, traversal, or an unnoticed extra member. */
function parseArtifactArchive(bytes, artifact, manifestBytes) {
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES }); } catch { return refused(); }
  const root = `agent-control-room-claude-code-process-darwin-${artifact.architecture}`;
  const expectedFiles = new Set([...artifact.files.map(file => file.path), CLAUDE_CODE_PROCESS_NATIVE_MANIFEST_NAME_V1]);
  const expectedDirs = expectedDirectories([...expectedFiles]);
  const files = new Map(), directories = new Set();
  let offset = 0, terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > tar.length || !tar.subarray(offset, offset + 512).every(byte => byte === 0)) refused();
      offset += 512; if (!tar.subarray(offset).every(byte => byte === 0)) refused(); terminated = true; break;
    }
    verifyHeader(header);
    const size = parseOctal(header.subarray(124, 136)), mode = parseOctal(header.subarray(100, 108));
    const typeByte = header[156], type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const name = ascii(header.subarray(0, 100)), prefix = ascii(header.subarray(345, 500));
    if (!name || prefix || (type !== "0" && type !== "5") || size > MAX_EXPANDED_BYTES || offset + size > tar.length) refused();
    const data = tar.subarray(offset, offset + size); offset += size + ((512 - (size % 512)) % 512);
    if (offset > tar.length) refused();
    const directory = type === "5", archivePath = directory && name.endsWith("/") ? name.slice(0, -1) : name;
    if (archivePath === root) {
      if (!directory || size !== 0 || mode !== 0o755 || directories.has("")) refused(); directories.add(""); continue;
    }
    if (!archivePath.startsWith(`${root}/`)) refused();
    const path = safeRelative(archivePath.slice(root.length + 1));
    if (directory) {
      if (size !== 0 || mode !== 0o755 || directories.has(path) || files.has(path)) refused(); directories.add(path);
    } else {
      const entry = artifact.files.find(item => item.path === path);
      const expectedMode = entry ? Number.parseInt(entry.mode, 8) : path === CLAUDE_CODE_PROCESS_NATIVE_MANIFEST_NAME_V1 ? 0o644 : undefined;
      if (!expectedMode || mode !== expectedMode || files.has(path) || directories.has(path)) refused();
      files.set(path, Buffer.from(data));
    }
  }
  if (!terminated || files.size !== expectedFiles.size || [...files.keys()].some(path => !expectedFiles.has(path))
    || directories.size !== expectedDirs.size || [...directories].some(path => !expectedDirs.has(path))) refused();
  if (!files.get(CLAUDE_CODE_PROCESS_NATIVE_MANIFEST_NAME_V1)?.equals(manifestBytes)) refused();
  for (const file of artifact.files) {
    const content = files.get(file.path);
    if (!content || content.byteLength !== file.bytes || sha256(content) !== file.sha256) refused();
  }
  return { files, directories };
}
async function artifactDirectory(directoryInput, allowsSidecarManifest = false) {
  const directory = await canonicalDirectory(directoryInput);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== (allowsSidecarManifest ? 4 : 3) || entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) refused();
  const names = entries.map(entry => entry.name).sort();
  const required = [CLAUDE_CODE_PROCESS_NATIVE_MANIFEST_NAME_V1, CHECKSUM_NAME,
    ...(allowsSidecarManifest ? [MACOS_CLAUDE_CODE_PROCESS_SIDECAR_MANIFEST_NAME_V1] : [])].sort();
  if (JSON.stringify(names.filter(name => name !== names.find(item => item.endsWith(".tar.gz")))) !== JSON.stringify(required)) refused();
  const archiveName = names.find(name => name.endsWith(".tar.gz"));
  if (!/^agent-control-room-claude-code-process-darwin-(?:arm64|x64)\.tar\.gz$/u.test(archiveName)) refused();
  const [manifestStat, checksumStat, archiveStat] = await Promise.all([
    regular(join(directory, CLAUDE_CODE_PROCESS_NATIVE_MANIFEST_NAME_V1), directory, 64 * 1024),
    regular(join(directory, CHECKSUM_NAME), directory, 1024), regular(join(directory, archiveName), directory),
  ]);
  if ((manifestStat.mode & 0o7777) !== 0o644 || (checksumStat.mode & 0o7777) !== 0o644 || (archiveStat.mode & 0o7777) !== 0o644) refused();
  const manifestBytes = await readFile(join(directory, CLAUDE_CODE_PROCESS_NATIVE_MANIFEST_NAME_V1));
  const artifact = parseArtifactManifest(manifestBytes);
  if (archiveName !== `agent-control-room-claude-code-process-darwin-${artifact.architecture}.tar.gz`) refused();
  const checksum = await readFile(join(directory, CHECKSUM_NAME), "utf8");
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+\.tar\.gz)\n$/u.exec(checksum);
  if (!match || match[2] !== archiveName) refused();
  const archiveBytes = await readFile(join(directory, archiveName));
  if (sha256(archiveBytes) !== match[1]) refused();
  const parsed = parseArtifactArchive(archiveBytes, artifact, manifestBytes);
  return Object.freeze({ directory, artifact, manifestBytes, archiveName, archiveBytes, archiveSha256: match[1], parsed });
}

/** Reads and verifies a separately built, already-reviewed native artifact. */
function artifactSummary(verified) {
  return Object.freeze({ schema: CLAUDE_CODE_PROCESS_NATIVE_ARTIFACT_V1, platform: verified.artifact.platform,
    architecture: verified.artifact.architecture, minimumMacos: verified.artifact.minimumMacos, protocol: verified.artifact.protocol,
    sourceSha256: verified.artifact.sourceSha256, toolchain: Object.freeze(structuredClone(verified.artifact.toolchain)),
    files: Object.freeze(structuredClone(verified.artifact.files)), archiveName: verified.archiveName,
    archiveSha256: `sha256:${verified.archiveSha256}`, artifactManifestSha256: `sha256:${sha256(verified.manifestBytes)}`,
    executableSha256: `sha256:${verified.artifact.files.find(file => file.path === EXECUTABLE_NAME).sha256}`,
    ownerQualified: false, compiles: false, downloads: false, installs: false });
}

export async function verifyClaudeCodeProcessNativeArtifactV1(directory) {
  return artifactSummary(await artifactDirectory(directory));
}

export async function buildMacosClaudeCodeProcessNativeSidecarManifestV1(input) {
  const captured = exact(input, ["artifactDirectory", "releaseVersion", "releaseSha256"]);
  const releaseVersion = version(captured.releaseVersion), verified = await verifyClaudeCodeProcessNativeArtifactV1(captured.artifactDirectory);
  return sidecarManifest(releaseVersion, digestIdentity(captured.releaseSha256), verified);
}

function sidecarManifest(releaseVersion, releaseSha256, verified) {
  return Object.freeze({ schema: MACOS_CLAUDE_CODE_PROCESS_NATIVE_SIDECAR_V1, releaseVersion, releaseSha256, platform: "darwin",
    architecture: verified.architecture, minimumMacos: verified.minimumMacos, protocol: verified.protocol,
    sourceSha256: verified.sourceSha256, toolchain: verified.toolchain, files: verified.files,
    archiveName: verified.archiveName, archiveSha256: verified.archiveSha256,
    artifactManifestSha256: verified.artifactManifestSha256, executableSha256: verified.executableSha256 });
}

function parseSidecarManifest(bytes) {
  if (bytes.byteLength > 96 * 1024) refused();
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { return refused(); }
  exact(value, ["architecture", "archiveName", "archiveSha256", "artifactManifestSha256", "executableSha256", "files", "minimumMacos",
    "platform", "protocol", "releaseVersion", "releaseSha256", "schema", "sourceSha256", "toolchain"]);
  if (value.schema !== MACOS_CLAUDE_CODE_PROCESS_NATIVE_SIDECAR_V1 || value.platform !== "darwin" || !["arm64", "x64"].includes(value.architecture)
    || minimumMacos(value.minimumMacos) !== "13.0" || value.protocol !== "ACRCCP1" || !digestPattern.test(value.sourceSha256)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.archiveSha256) || !/^sha256:[a-f0-9]{64}$/u.test(value.artifactManifestSha256)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.executableSha256)) refused();
  version(value.releaseVersion); digestIdentity(value.releaseSha256);
  if (value.archiveName !== `agent-control-room-claude-code-process-darwin-${value.architecture}.tar.gz`) refused();
  const artifact = { schema: CLAUDE_CODE_PROCESS_NATIVE_ARTIFACT_V1, platform: value.platform, architecture: value.architecture,
    minimumMacos: value.minimumMacos, protocol: value.protocol, sourceSha256: value.sourceSha256, toolchain: value.toolchain,
    files: value.files, ownerQualified: false };
  parseArtifactManifest(canonicalBytes(artifact));
  if (`sha256:${value.files.find(file => file.path === EXECUTABLE_NAME).sha256}` !== value.executableSha256 || !bytes.equals(canonicalBytes(value))) refused();
  return value;
}
function macosAtLeast(actual, minimum) {
  if (typeof actual !== "string" || !/^\d+\.\d+(?:\.\d+)?$/u.test(actual)) return false;
  const a = actual.split(".").map(Number), b = minimum.split(".").map(Number);
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
}
/** Verifies the composed sidecar without extracting it or touching an owner installation root. */
async function verifySidecarInternal(sidecarRootInput, expectedInput = {}) {
  const expectedNames = Object.getOwnPropertyNames(expectedInput);
  if (expectedNames.some(key => !["architecture", "macosVersion", "releaseVersion", "releaseSha256", "sidecarManifestSha256"].includes(key))) refused();
  const expected = exact(expectedInput, expectedNames);
  if (typeof sidecarRootInput !== "string") refused();
  const sidecarRoot = await canonicalDirectory(sidecarRootInput);
  const sidecarPath = join(sidecarRoot, MACOS_CLAUDE_CODE_PROCESS_SIDECAR_MANIFEST_NAME_V1);
  const sidecarStat = await regular(sidecarPath, sidecarRoot, 96 * 1024);
  if ((sidecarStat.mode & 0o7777) !== 0o644) refused();
  const sidecarBytes = await readFile(sidecarPath), sidecar = parseSidecarManifest(sidecarBytes);
  if (expected.releaseSha256 !== undefined && digestIdentity(expected.releaseSha256) !== sidecar.releaseSha256) refused();
  if (expected.sidecarManifestSha256 !== undefined && digestIdentity(expected.sidecarManifestSha256) !== `sha256:${sha256(sidecarBytes)}`) refused();
  if (expected.releaseVersion !== undefined && expected.releaseVersion !== sidecar.releaseVersion) refused();
  if (expected.architecture !== undefined && expected.architecture !== sidecar.architecture) refused();
  if (expected.macosVersion !== undefined && !macosAtLeast(expected.macosVersion, sidecar.minimumMacos)) refused();
  const artifactRoot = await artifactDirectory(sidecarRoot, true);
  const verified = artifactSummary(artifactRoot);
  for (const key of ["architecture", "minimumMacos", "protocol", "sourceSha256", "toolchain", "files", "archiveName", "archiveSha256", "artifactManifestSha256", "executableSha256"])
    if (JSON.stringify(sidecar[key]) !== JSON.stringify(verified[key])) refused();
  if (artifactRoot.archiveName !== sidecar.archiveName) refused();
  const summary = Object.freeze({ schema: MACOS_CLAUDE_CODE_PROCESS_NATIVE_SIDECAR_V1, verified: true, releaseVersion: sidecar.releaseVersion, releaseSha256: sidecar.releaseSha256,
    platform: "darwin", architecture: sidecar.architecture, minimumMacos: sidecar.minimumMacos, protocol: sidecar.protocol,
    sidecarManifestSha256: `sha256:${sha256(sidecarBytes)}`,
    archiveSha256: sidecar.archiveSha256, artifactManifestSha256: sidecar.artifactManifestSha256,
    executableSha256: sidecar.executableSha256, sourceSha256: sidecar.sourceSha256,
    toolchain: Object.freeze(structuredClone(sidecar.toolchain)), files: Object.freeze(structuredClone(sidecar.files)),
    compiles: false, downloads: false, installs: false });
  return Object.freeze({ summary, artifactRoot });
}

export async function verifyMacosClaudeCodeProcessNativeSidecarV1(sidecarRootInput, expected = {}) {
  return (await verifySidecarInternal(sidecarRootInput, expected)).summary;
}

export async function copyVerifiedMacosClaudeCodeProcessNativeSidecarV1(input) {
  const captured = exact(input, ["artifactDirectory", "destinationDirectory", "releaseVersion", "releaseSha256"]);
  const destination = captured.destinationDirectory;
  if (typeof destination !== "string" || !isAbsolute(destination) || resolve(destination) !== destination || destination === "/") refused();
  await canonicalDirectory(dirname(destination));
  const releaseVersion = version(captured.releaseVersion);
  const artifact = await artifactDirectory(captured.artifactDirectory);
  const sidecar = sidecarManifest(releaseVersion, digestIdentity(captured.releaseSha256), artifactSummary(artifact));
  try { await access(destination); refused(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(destination, { mode: 0o755 });
  await chmod(destination, 0o755);
  try {
    const checksum = Buffer.from(`${artifact.archiveSha256}  ${sidecar.archiveName}\n`, "utf8");
    await writeFile(join(destination, CLAUDE_CODE_PROCESS_NATIVE_MANIFEST_NAME_V1), artifact.manifestBytes, { flag: "wx", mode: 0o644 });
    await writeFile(join(destination, CHECKSUM_NAME), checksum, { flag: "wx", mode: 0o644 });
    await writeFile(join(destination, sidecar.archiveName), artifact.archiveBytes, { flag: "wx", mode: 0o644 });
    for (const name of [CLAUDE_CODE_PROCESS_NATIVE_MANIFEST_NAME_V1, CHECKSUM_NAME, sidecar.archiveName]) await chmod(join(destination, name), 0o644);
    await writeFile(join(destination, MACOS_CLAUDE_CODE_PROCESS_SIDECAR_MANIFEST_NAME_V1), canonicalBytes(sidecar), { flag: "wx", mode: 0o644 });
    await chmod(join(destination, MACOS_CLAUDE_CODE_PROCESS_SIDECAR_MANIFEST_NAME_V1), 0o644);
    return verifyMacosClaudeCodeProcessNativeSidecarV1(destination, { releaseVersion });
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
