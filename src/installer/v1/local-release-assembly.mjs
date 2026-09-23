import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const MANIFEST_SCHEMA = "control-room.local-release-manifest/v1";
const ASSEMBLY_SCHEMA = "control-room.local-release-assembly/v1";
const MANIFEST_NAME = "RELEASE_MANIFEST.json";
const MAX_FILES = 25_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

/**
 * Deliberately small release surface. Directories are recursively inventoried,
 * but files elsewhere in a developer checkout can never enter the archive.
 */
export const LOCAL_RELEASE_FILE_POLICY_V1 = Object.freeze({
  files: Object.freeze([
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY.md",
    "deploy/operator-config.mjs",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/prepare-local-installation.mjs",
    "scripts/prepare-local-production-dependencies.mjs",
    "scripts/launch-local-setup.mjs",
    "scripts/initialize-local-installation-plan.mjs",
    "scripts/run-local-setup-host.mjs",
    "scripts/run-private-local-installation-operator.mjs",
    "scripts/run-private-vps.mjs",
    "src/installer/v1/local-clean-install-acceptance.mjs",
    "src/installer/v1/local-production-dependencies.mjs",
    "src/installer/v1/local-installation-release.d.mts",
    "src/installer/v1/local-installation-release.mjs",
    "src/installer/v1/local-release-assembly.mjs",
    "src/installer/v1/local-release-stager.mjs",
  ]),
  directories: Object.freeze([
    "db/migrations",
    "db/roles",
    "db/setup",
    "deploy/postgres",
    "dist-vps/client",
    "dist-vps/server",
    "third_party",
  ]),
  licenseEvidence: Object.freeze([
    "research/runtime-license-artifact-inventory.json",
    "research/runtime-license-bundled-scan.json",
    "research/runtime-license-exceptions.json",
    "research/runtime-license-input.json",
    "research/runtime-license-manifest.json",
    "research/runtime-license-report.json",
    "research/runtime-license-retained-provenance.json",
  ]),
});

const refused = () => {
  throw new Error("local_release_assembly_refused");
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")
    || value.includes("\0") || value.startsWith("/") || value.endsWith("/")
    || value.split("/").some(part => part === "" || part === "." || part === "..")) refused();
  return value;
}

function isInside(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function requireRoot(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) refused();
  const canonical = await realpath(path);
  const stat = await lstat(path);
  if (canonical !== path || !stat.isDirectory() || stat.isSymbolicLink()) refused();
  return canonical;
}

async function requireRegularFile(path, root) {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (!stat.isFile() || stat.isSymbolicLink() || canonical !== path || !isInside(canonical, root)) refused();
  return stat;
}

async function walkAllowedDirectory(root, releaseRoot, paths) {
  const stat = await lstat(root);
  const canonical = await realpath(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== root || !isInside(root, releaseRoot)) refused();
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length === 0) refused();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) refused();
    if (entry.isDirectory()) await walkAllowedDirectory(path, releaseRoot, paths);
    else if (entry.isFile()) paths.push(path);
    else refused();
    if (paths.length > MAX_FILES) refused();
  }
}

async function readPackageVersion(releaseRoot) {
  const bytes = await readFile(join(releaseRoot, "package.json"));
  if (bytes.byteLength > 64 * 1024) refused();
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.name !== "control-room" || !versionPattern.test(value.version)
    || value.packageManager !== "pnpm@11.19.0" || value.engines?.node !== ">=22.13.0") refused();
  return value.version;
}

function withoutRepository(value) {
  const copy = structuredClone(value);
  delete copy.repository;
  return copy;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Re-runs the existing freshness and disclosure gates over the exact source tree. */
export async function validateRuntimeLicenseEvidenceV1(releaseRootInput) {
  const releaseRoot = await requireRoot(releaseRootInput);
  try {
    // The extracted release uses this module only for checksum/tree
    // verification. Keep the build-only license analyzers lazy so a public
    // release never needs developer checkout scripts merely to stage itself.
    const [{ buildArtifactInventory }, { scanBundledUndisclosed }, { finalizedRuntimeLicenseOutputs }] = await Promise.all([
      import("../../../scripts/runtime-license-artifact-inventory.mjs"),
      import("../../../scripts/runtime-license-bundled-scan.mjs"),
      import("../../../scripts/runtime-license-finalize.mjs"),
    ]);
    const savedInventory = JSON.parse(await readFile(join(releaseRoot,
      "research/runtime-license-artifact-inventory.json"), "utf8"));
    const savedScan = JSON.parse(await readFile(join(releaseRoot,
      "research/runtime-license-bundled-scan.json"), "utf8"));
    const savedManifest = JSON.parse(await readFile(join(releaseRoot,
      "research/runtime-license-manifest.json"), "utf8"));
    const savedNotice = await readFile(join(releaseRoot, "THIRD_PARTY.md"), "utf8");
    const inventory = buildArtifactInventory(releaseRoot);
    const scan = scanBundledUndisclosed(releaseRoot);
    const finalized = finalizedRuntimeLicenseOutputs(releaseRoot);
    if (!inventory.completeDistributionClearance || scan.summary.undisclosed !== 0
      || !sameJson(withoutRepository(inventory), withoutRepository(savedInventory))
      || !sameJson(scan, savedScan) || !sameJson(finalized.manifest, savedManifest)
      || finalized.notice !== savedNotice) refused();
    return Object.freeze({
      verified: true,
      inventoryDigest: inventory.inventoryDigest,
      undisclosed: 0,
    });
  } catch {
    return refused();
  }
}

export async function buildLocalReleaseManifestV1(releaseRootInput) {
  const releaseRoot = await requireRoot(releaseRootInput);
  const license = await validateRuntimeLicenseEvidenceV1(releaseRoot);
  const absolutePaths = [];
  for (const name of [...LOCAL_RELEASE_FILE_POLICY_V1.files, ...LOCAL_RELEASE_FILE_POLICY_V1.licenseEvidence]) {
    const normalized = normalizeRelativePath(name);
    const path = join(releaseRoot, normalized);
    await requireRegularFile(path, releaseRoot);
    absolutePaths.push(path);
  }
  for (const name of LOCAL_RELEASE_FILE_POLICY_V1.directories) {
    await walkAllowedDirectory(join(releaseRoot, normalizeRelativePath(name)), releaseRoot, absolutePaths);
  }
  const unique = [...new Set(absolutePaths.map(path => relative(releaseRoot, path).split(sep).join("/")))].sort();
  if (unique.length !== absolutePaths.length || unique.includes(MANIFEST_NAME)) refused();
  let byteCount = 0;
  const files = [];
  for (const path of unique) {
    const bytes = await readFile(join(releaseRoot, path));
    byteCount += bytes.byteLength;
    if (byteCount > MAX_BYTES) refused();
    files.push(Object.freeze({ path, bytes: bytes.byteLength, sha256: sha256(bytes), mode: "0644" }));
  }
  const version = await readPackageVersion(releaseRoot);
  return Object.freeze({
    schema: MANIFEST_SCHEMA,
    layoutVersion: 1,
    product: "agent-control-room",
    version,
    platform: Object.freeze({
      artifact: "portable-node",
      operatingSystems: Object.freeze(["darwin", "linux"]),
      architectures: Object.freeze(["arm64", "x64"]),
      node: ">=22.13.0",
    }),
    entrypoint: "scripts/run-private-vps.mjs",
    preflight: "scripts/prepare-local-installation.mjs",
    dependencyPreparation: Object.freeze({
      packageManager: "pnpm@11.19.0",
      lockfile: "pnpm-lock.yaml",
      mode: "frozen-production-install-before-activation",
    }),
    fileCount: files.length,
    byteCount,
    license: Object.freeze({ inventoryDigest: license.inventoryDigest, completeDistributionClearance: true }),
    files: Object.freeze(files),
  });
}

function manifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function expectedDirectories(paths) {
  const result = new Set([""]);
  for (const path of paths) {
    let current = dirname(path);
    while (current !== ".") {
      result.add(current.split(sep).join("/"));
      current = dirname(current);
    }
  }
  return result;
}

async function listReleaseTree(root) {
  const files = [];
  const directories = new Set([""]);
  async function walk(current, prefix = "") {
    const stat = await lstat(current);
    const canonical = await realpath(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== current || !isInside(current, root)) refused();
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      normalizeRelativePath(relativeName);
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) refused();
      if (entry.isDirectory()) {
        directories.add(relativeName);
        await walk(path, relativeName);
      } else if (entry.isFile()) files.push(relativeName);
      else refused();
      if (files.length > MAX_FILES + 1) refused();
    }
  }
  await walk(root);
  return { files: files.sort(), directories };
}

export async function verifyExtractedLocalReleaseV1(releaseRootInput, expectedManifest) {
  const releaseRoot = await requireRoot(releaseRootInput);
  if (!expectedManifest || expectedManifest.schema !== MANIFEST_SCHEMA
    || Object.keys(expectedManifest).sort().join(",")
      !== "byteCount,dependencyPreparation,entrypoint,fileCount,files,layoutVersion,license,platform,preflight,product,schema,version"
    || expectedManifest.layoutVersion !== 1 || expectedManifest.product !== "agent-control-room"
    || expectedManifest.entrypoint !== "scripts/run-private-vps.mjs"
    || expectedManifest.preflight !== "scripts/prepare-local-installation.mjs"
    || Object.keys(expectedManifest.platform ?? {}).sort().join(",") !== "architectures,artifact,node,operatingSystems"
    || expectedManifest.platform.artifact !== "portable-node"
    || expectedManifest.platform.node !== ">=22.13.0"
    || JSON.stringify(expectedManifest.platform.operatingSystems) !== JSON.stringify(["darwin", "linux"])
    || JSON.stringify(expectedManifest.platform.architectures) !== JSON.stringify(["arm64", "x64"])
    || Object.keys(expectedManifest.license ?? {}).sort().join(",") !== "completeDistributionClearance,inventoryDigest"
    || expectedManifest.license.completeDistributionClearance !== true
    || !digestPattern.test(expectedManifest.license.inventoryDigest)
    || Object.keys(expectedManifest.dependencyPreparation ?? {}).sort().join(",") !== "lockfile,mode,packageManager"
    || expectedManifest.dependencyPreparation.packageManager !== "pnpm@11.19.0"
    || expectedManifest.dependencyPreparation.lockfile !== "pnpm-lock.yaml"
    || expectedManifest.dependencyPreparation.mode !== "frozen-production-install-before-activation"
    || !Array.isArray(expectedManifest.files) || expectedManifest.fileCount !== expectedManifest.files.length
    || !Number.isSafeInteger(expectedManifest.byteCount) || expectedManifest.byteCount < 0
    || !versionPattern.test(expectedManifest.version)) refused();
  const expectedFiles = expectedManifest.files.map(entry => {
    if (!entry || Object.keys(entry).sort().join(",") !== "bytes,mode,path,sha256"
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.mode !== "0644"
      || !digestPattern.test(entry.sha256)) refused();
    return normalizeRelativePath(entry.path);
  });
  if (new Set(expectedFiles).size !== expectedFiles.length || expectedFiles.some((path, index) => index && expectedFiles[index - 1] >= path)) refused();
  const manifestPath = join(releaseRoot, MANIFEST_NAME);
  await requireRegularFile(manifestPath, releaseRoot);
  const savedManifest = await readFile(manifestPath);
  if (!savedManifest.equals(manifestBytes(expectedManifest))) refused();
  const actual = await listReleaseTree(releaseRoot);
  const completeExpectedFiles = [...expectedFiles, MANIFEST_NAME].sort();
  if (actual.files.length !== completeExpectedFiles.length
    || actual.files.some((path, index) => path !== completeExpectedFiles[index])) refused();
  const directories = expectedDirectories(completeExpectedFiles);
  if (actual.directories.size !== directories.size
    || [...actual.directories].some(path => !directories.has(path))) refused();
  let total = 0;
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const entry = expectedManifest.files[index];
    const path = join(releaseRoot, entry.path);
    const stat = await requireRegularFile(path, releaseRoot);
    const bytes = await readFile(path);
    total += bytes.byteLength;
    if (stat.size !== entry.bytes || bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) refused();
  }
  if (total !== expectedManifest.byteCount) refused();
  return Object.freeze({ verified: true, fileCount: expectedFiles.length, byteCount: total });
}

async function copyManifestFiles(releaseRoot, stagingRoot, manifest) {
  for (const entry of manifest.files) {
    const source = join(releaseRoot, entry.path);
    const destination = join(stagingRoot, entry.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  }
  await writeFile(join(stagingRoot, MANIFEST_NAME), manifestBytes(manifest), { flag: "wx", mode: 0o644 });
}

function writeOctal(buffer, offset, length, number) {
  const value = number.toString(8).padStart(length - 1, "0");
  if (value.length >= length) refused();
  buffer.write(value, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function splitTarPath(path) {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index), name = path.slice(index + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  return undefined;
}

function tarHeader(path, size, type, mode = type === "5" ? 0o755 : 0o644) {
  const split = splitTarPath(path);
  if (!split) refused();
  const { name, prefix } = split;
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function paddedTarBytes(bytes) {
  const padding = (512 - (bytes.length % 512)) % 512;
  return padding ? [bytes, Buffer.alloc(padding, 0)] : [bytes];
}

function paxPathRecord(path) {
  const payload = ` path=${path}\n`;
  let length = Buffer.byteLength(payload) + 1;
  while (true) {
    const candidate = `${length}${payload}`;
    const actual = Buffer.byteLength(candidate);
    if (actual === length) return Buffer.from(candidate, "utf8");
    length = actual;
  }
}

function tarEntryHeaders(path, size, type, mode) {
  if (splitTarPath(path)) return [tarHeader(path, size, type, mode)];
  const digest = sha256(Buffer.from(path, "utf8")).slice(0, 32);
  const record = paxPathRecord(path);
  return [
    tarHeader(`PaxHeaders/${digest}`, record.length, "x", 0o644),
    ...paddedTarBytes(record),
    tarHeader(`PaxFiles/${digest}`, size, type, mode),
  ];
}

/** Shared normalized tar-gzip writer for reviewed release packaging lanes. */
export async function createDeterministicTarGzipV1(stagingRootInput, archiveRoot, entriesInput) {
  const stagingRoot = await requireRoot(stagingRootInput);
  if (typeof archiveRoot !== "string" || archiveRoot.length === 0 || archiveRoot.includes("/")
    || archiveRoot.includes("\\") || archiveRoot.includes("\0") || archiveRoot === "." || archiveRoot === ".."
    || !Array.isArray(entriesInput) || entriesInput.length < 1 || entriesInput.length > MAX_FILES + 1) refused();
  const entries = entriesInput.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "mode,path"
      || (entry.mode !== "0644" && entry.mode !== "0755")) refused();
    return { path: normalizeRelativePath(entry.path), mode: entry.mode };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) refused();
  for (const entry of entries) await requireRegularFile(join(stagingRoot, entry.path), stagingRoot);
  const paths = entries.map(entry => entry.path);
  const directories = [...expectedDirectories(paths)].filter(Boolean).sort();
  const parts = [...tarEntryHeaders(`${archiveRoot}/`, 0, "5", 0o755)];
  for (const directory of directories) parts.push(...tarEntryHeaders(`${archiveRoot}/${directory}/`, 0, "5", 0o755));
  for (const entry of entries) {
    const bytes = await readFile(join(stagingRoot, entry.path));
    const mode = entry.mode === "0755" ? 0o755 : 0o644;
    parts.push(...tarEntryHeaders(`${archiveRoot}/${entry.path}`, bytes.length, "0", mode), ...paddedTarBytes(bytes));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 });
}

async function assertOutputAbsent(path) {
  try {
    await access(path);
    refused();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function assembleLocalReleaseV1(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "outputDirectory,releaseRoot"
    || typeof input.outputDirectory !== "string" || !isAbsolute(input.outputDirectory)
    || resolve(input.outputDirectory) !== input.outputDirectory) refused();
  const releaseRoot = await requireRoot(input.releaseRoot);
  if (isInside(input.outputDirectory, releaseRoot) || isInside(releaseRoot, input.outputDirectory)) refused();
  const manifest = await buildLocalReleaseManifestV1(releaseRoot);
  const outputParent = dirname(input.outputDirectory);
  await requireRoot(outputParent);
  await assertOutputAbsent(input.outputDirectory);
  await mkdir(input.outputDirectory, { mode: 0o755 });
  const stagingRoot = join(input.outputDirectory, ".staging");
  await mkdir(stagingRoot, { mode: 0o755 });
  await copyManifestFiles(releaseRoot, stagingRoot, manifest);
  await verifyExtractedLocalReleaseV1(stagingRoot, manifest);
  const stem = `agent-control-room-${manifest.version}`;
  const archiveName = `${stem}.tar.gz`;
  const archive = await createDeterministicTarGzipV1(stagingRoot, stem,
    [...manifest.files.map(entry => ({ path: entry.path, mode: "0644" })), { path: MANIFEST_NAME, mode: "0644" }]
      .sort((left, right) => left.path.localeCompare(right.path, "en")));
  const digest = sha256(archive);
  const externalManifest = join(input.outputDirectory, `${stem}.manifest.json`);
  const archivePath = join(input.outputDirectory, archiveName);
  const checksumPath = join(input.outputDirectory, "SHA256SUMS");
  await writeFile(externalManifest, manifestBytes(manifest), { flag: "wx", mode: 0o644 });
  await writeFile(archivePath, archive, { flag: "wx", mode: 0o644 });
  await writeFile(checksumPath, `${digest}  ${archiveName}\n`, { flag: "wx", mode: 0o644 });
  await rm(stagingRoot, { recursive: true });
  return Object.freeze({
    schema: ASSEMBLY_SCHEMA,
    version: manifest.version,
    archiveName,
    archiveSha256: digest,
    manifestName: basename(externalManifest),
    checksumName: basename(checksumPath),
    fileCount: manifest.fileCount,
    byteCount: manifest.byteCount,
    publishes: false,
    signs: false,
    installs: false,
  });
}
