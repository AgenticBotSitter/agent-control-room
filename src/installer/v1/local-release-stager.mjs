import { createHash } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { verifyExtractedLocalReleaseV1 } from "./local-release-assembly.mjs";

const STAGING_SCHEMA = "control-room.local-release-staging/v1";
const MANIFEST_SCHEMA = "control-room.local-release-manifest/v1";
const MANIFEST_NAME = "RELEASE_MANIFEST.json";
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 25_000;
const digestPattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const refused = () => {
  throw new Error("local_release_staging_refused");
};

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function inside(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function canonicalDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) refused();
  const canonical = await realpath(path);
  const stat = await lstat(path);
  if (canonical !== path || !stat.isDirectory() || stat.isSymbolicLink()) refused();
  return canonical;
}

async function regularFile(path, root, maximum = MAX_ARCHIVE_BYTES) {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (!stat.isFile() || stat.isSymbolicLink() || canonical !== path || !inside(path, root)
    || stat.size < 1 || stat.size > maximum) refused();
  return stat;
}

function safeRelative(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0")
    || path.startsWith("/") || path.endsWith("/")
    || path.split("/").some(part => part === "" || part === "." || part === "..")) refused();
  return path;
}

function parseExternalManifest(bytes) {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) refused();
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!manifest || Object.keys(manifest).sort().join(",")
      !== "byteCount,dependencyPreparation,entrypoint,fileCount,files,layoutVersion,license,platform,preflight,product,schema,version"
    || manifest.schema !== MANIFEST_SCHEMA || manifest.layoutVersion !== 1
    || manifest.product !== "agent-control-room" || !versionPattern.test(manifest.version)
    || manifest.entrypoint !== "scripts/run-private-vps.mjs"
    || manifest.preflight !== "scripts/prepare-local-installation.mjs"
    || Object.keys(manifest.platform ?? {}).sort().join(",") !== "architectures,artifact,node,operatingSystems"
    || manifest.platform.artifact !== "portable-node" || manifest.platform.node !== ">=22.13.0"
    || JSON.stringify(manifest.platform.operatingSystems) !== JSON.stringify(["darwin", "linux"])
    || JSON.stringify(manifest.platform.architectures) !== JSON.stringify(["arm64", "x64"])
    || Object.keys(manifest.dependencyPreparation ?? {}).sort().join(",") !== "lockfile,mode,packageManager"
    || manifest.dependencyPreparation.packageManager !== "pnpm@11.19.0"
    || manifest.dependencyPreparation.lockfile !== "pnpm-lock.yaml"
    || manifest.dependencyPreparation.mode !== "frozen-production-install-before-activation"
    || Object.keys(manifest.license ?? {}).sort().join(",") !== "completeDistributionClearance,inventoryDigest"
    || manifest.license.completeDistributionClearance !== true
    || !digestPattern.test(manifest.license.inventoryDigest)
    || !Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount
    || manifest.files.length < 1 || manifest.files.length > MAX_FILES
    || !Number.isSafeInteger(manifest.byteCount) || manifest.byteCount < 1 || manifest.byteCount > MAX_EXPANDED_BYTES)
    refused();
  const paths = manifest.files.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "bytes,mode,path,sha256"
      || typeof entry.path !== "string" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !digestPattern.test(entry.sha256) || entry.mode !== "0644") refused();
    return safeRelative(entry.path);
  });
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1] >= path)) refused();
  if (manifest.files.reduce((sum, entry) => sum + entry.bytes, 0) !== manifest.byteCount
    || !bytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"))) refused();
  return { manifest, paths };
}

function parseOctal(bytes) {
  const value = bytes.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(value)) refused();
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) refused();
  return number;
}

function asciiField(bytes) {
  const end = bytes.indexOf(0);
  const field = bytes.subarray(0, end < 0 ? bytes.length : end);
  if ([...field].some(byte => byte > 0x7f || byte < 0x20)) refused();
  return field.toString("ascii");
}

function verifyHeaderChecksum(header) {
  const expected = parseOctal(header.subarray(148, 156));
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected) refused();
}

function parsePaxPath(bytes) {
  let offset = 0;
  let path;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space <= offset) refused();
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^\d+$/u.test(lengthText)) refused();
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length) refused();
    const record = bytes.subarray(space + 1, offset + length);
    if (record.at(-1) !== 0x0a) refused();
    const text = record.subarray(0, -1).toString("utf8");
    if (!text.startsWith("path=") || path !== undefined) refused();
    path = text.slice(5);
    offset += length;
  }
  if (offset !== bytes.length || path === undefined) refused();
  return path;
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

function parseArchive(bytes, rootName, manifestBytes, manifestPaths) {
  let tar;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch {
    return refused();
  }
  const files = new Map();
  const directories = new Set();
  let offset = 0;
  let pendingPaxPath;
  let terminated = false;
  let records = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > tar.length || !tar.subarray(offset, offset + 512).every(byte => byte === 0)) refused();
      offset += 512;
      if (!tar.subarray(offset).every(byte => byte === 0)) refused();
      terminated = true;
      break;
    }
    verifyHeaderChecksum(header);
    const size = parseOctal(header.subarray(124, 136));
    const typeByte = header[156];
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const name = asciiField(header.subarray(0, 100));
    const prefix = asciiField(header.subarray(345, 500));
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const dataEnd = offset + size;
    if (size > MAX_EXPANDED_BYTES || dataEnd > tar.length) refused();
    const data = tar.subarray(offset, dataEnd);
    offset = dataEnd + ((512 - (size % 512)) % 512);
    if (offset > tar.length) refused();
    if (type === "x") {
      if (pendingPaxPath !== undefined) refused();
      pendingPaxPath = parsePaxPath(data);
      continue;
    }
    const archivePath = pendingPaxPath ?? headerPath;
    pendingPaxPath = undefined;
    records += 1;
    if (records > MAX_FILES * 2) refused();
    if (type !== "0" && type !== "5") refused();
    const directory = type === "5";
    const normalizedArchivePath = directory && archivePath.endsWith("/") ? archivePath.slice(0, -1) : archivePath;
    const prefixPath = `${rootName}/`;
    if (normalizedArchivePath === rootName) {
      if (!directory || directories.has("")) refused();
      directories.add("");
      continue;
    }
    if (!normalizedArchivePath.startsWith(prefixPath)) refused();
    const releasePath = normalizedArchivePath.slice(prefixPath.length);
    safeRelative(releasePath);
    if (directory) {
      if (size !== 0 || directories.has(releasePath) || files.has(releasePath)) refused();
      directories.add(releasePath);
    } else {
      if (files.has(releasePath) || directories.has(releasePath)) refused();
      files.set(releasePath, Buffer.from(data));
    }
  }
  if (!terminated || pendingPaxPath !== undefined) refused();
  const expectedFiles = new Set([...manifestPaths, MANIFEST_NAME]);
  const expectedDirs = expectedDirectories(expectedFiles);
  if (files.size !== expectedFiles.size || [...files].some(([path]) => !expectedFiles.has(path))
    || directories.size !== expectedDirs.size || [...directories].some(path => !expectedDirs.has(path))) refused();
  if (!files.get(MANIFEST_NAME)?.equals(manifestBytes)) refused();
  return { files, directories };
}

async function writeParsedArchive(root, parsed) {
  const directories = [...parsed.directories].filter(Boolean).sort();
  for (const directory of directories) await mkdir(join(root, directory), { recursive: true, mode: 0o755 });
  for (const [path, bytes] of [...parsed.files].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    const handle = await open(destination, "wx", 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const durableDirectories = [root, ...directories.map(directory => join(root, directory))]
    .sort((left, right) => right.split(sep).length - left.split(sep).length);
  for (const directory of durableDirectories) await syncDirectory(directory);
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exactReleaseInputs(releaseDirectory) {
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  if (entries.length !== 3 || entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) refused();
  const names = entries.map(entry => entry.name).sort();
  if (names[0] !== "SHA256SUMS" || !names[1].endsWith(".manifest.json") || !names[2].endsWith(".tar.gz")) refused();
  for (const name of names) await regularFile(join(releaseDirectory, name), releaseDirectory);
  return { checksumName: names[0], manifestName: names[1], archiveName: names[2] };
}

async function prepareVersionsRoot(installRoot) {
  const versions = join(installRoot, "versions");
  try {
    await mkdir(versions, { mode: 0o755 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const canonical = await canonicalDirectory(versions);
  // Persist the new `versions` directory entry itself, not only its later
  // contents. This is required for the first successful stage to survive a
  // host crash after reporting success.
  await syncDirectory(installRoot);
  return canonical;
}

async function existingTarget(path, manifest) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) refused();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await verifyExtractedLocalReleaseV1(path, manifest);
  return true;
}

async function ensurePublicationClaim(path, bytes, versionsRoot) {
  const claimStaging = await mkdtemp(join(versionsRoot, ".claim-"));
  const complete = join(claimStaging, "claim.json");
  let created = false;
  try {
    await syncDirectory(versionsRoot);
    const handle = await open(complete, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(claimStaging);
    try {
      await link(complete, path);
      created = true;
      await syncDirectory(versionsRoot);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await regularFile(path, versionsRoot, 4096);
      if (!(await readFile(path)).equals(bytes)) refused();
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) refused();
    return created;
  } finally {
    await rm(claimStaging, { recursive: true, force: true });
    await syncDirectory(versionsRoot);
  }
}

async function verifiedReadyOrFalse(path, manifest) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) refused();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await verifyExtractedLocalReleaseV1(path, manifest);
  return true;
}

async function publishReadyDirectory(ready, target, manifest) {
  if (await existingTarget(target, manifest)) {
    try {
      if (await verifiedReadyOrFalse(ready, manifest)) await rm(ready, { recursive: true });
    } catch (error) {
      if (!await existingTarget(target, manifest)) throw error;
    }
    return true;
  }
  try {
    // The private versions root has one protocol writer. The ready directory
    // is already complete, so rename is all-or-nothing across a host crash.
    await rename(ready, target);
    await syncDirectory(dirname(target));
    return false;
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)
      && await existingTarget(target, manifest)) {
      try {
        if (await verifiedReadyOrFalse(ready, manifest)) await rm(ready, { recursive: true });
      } catch (readyError) {
        if (!await existingTarget(target, manifest)) throw readyError;
      }
      return true;
    }
    throw error;
  }
}

async function report(manifest, alreadyStaged, versionsRoot) {
  // A retry may be the process that finishes durability after another process
  // completed the rename but stopped before flushing the parent directory.
  await syncDirectory(versionsRoot);
  return Object.freeze({
    schema: STAGING_SCHEMA,
    state: "verified_release_staged",
    version: manifest.version,
    alreadyStaged,
    fileCount: manifest.fileCount,
    byteCount: manifest.byteCount,
    remainingCategory: "production_dependencies_not_prepared",
    preparesDependencies: false,
    switchesCurrentRelease: false,
    installsOrStartsService: false,
    createsDatabase: false,
    writesCredentials: false,
    usesNetwork: false,
    publishes: false,
  });
}

/** Stage one verified archive. This is owner-attended placement, not install or activation. */
async function stageLocalReleaseInternalV1(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "installRoot,ownerAttended,releaseDirectory"
    || input.ownerAttended !== true) refused();
  const releaseDirectory = await canonicalDirectory(input.releaseDirectory);
  const installRoot = await canonicalDirectory(input.installRoot);
  if (inside(releaseDirectory, installRoot) || inside(installRoot, releaseDirectory)) refused();
  const names = await exactReleaseInputs(releaseDirectory);
  const manifestBytes = await readFile(join(releaseDirectory, names.manifestName));
  const { manifest, paths } = parseExternalManifest(manifestBytes);
  const stem = `agent-control-room-${manifest.version}`;
  if (names.manifestName !== `${stem}.manifest.json` || names.archiveName !== `${stem}.tar.gz`) refused();
  const checksumBytes = await readFile(join(releaseDirectory, names.checksumName));
  if (checksumBytes.byteLength > 1024) refused();
  const checksumLine = checksumBytes.toString("utf8");
  const checksumMatch = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+\.tar\.gz)\n$/u.exec(checksumLine);
  if (!checksumMatch || checksumMatch[2] !== names.archiveName) refused();
  const archivePath = join(releaseDirectory, names.archiveName);
  await regularFile(archivePath, releaseDirectory);
  const archiveBytes = await readFile(archivePath);
  if (sha256(archiveBytes) !== checksumMatch[1]) refused();
  const parsed = parseArchive(archiveBytes, stem, manifestBytes, paths);
  const versionsRoot = await prepareVersionsRoot(installRoot);
  const target = join(versionsRoot, manifest.version);
  const manifestDigest = sha256(manifestBytes);
  const ready = join(versionsRoot, `.ready-${manifest.version}-${manifestDigest}`);
  const claim = join(versionsRoot, `.publish-${manifest.version}.json`);
  const claimBytes = Buffer.from(`${JSON.stringify({
    schema: "control-room.local-release-publication-claim/v1",
    version: manifest.version,
    manifestSha256: manifestDigest,
  })}\n`, "utf8");
  if (await existingTarget(target, manifest)) {
    try {
      await regularFile(claim, versionsRoot, 4096);
      if (!(await readFile(claim)).equals(claimBytes)) refused();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return report(manifest, true, versionsRoot);
  }
  try {
    if (await verifiedReadyOrFalse(ready, manifest)) {
      await ensurePublicationClaim(claim, claimBytes, versionsRoot);
      const alreadyStaged = await publishReadyDirectory(ready, target, manifest);
      return report(manifest, alreadyStaged, versionsRoot);
    }
  } catch (error) {
    if (await existingTarget(target, manifest)) return report(manifest, true, versionsRoot);
    throw error;
  }
  const temporary = await mkdtemp(join(versionsRoot, ".staging-"));
  await syncDirectory(versionsRoot);
  try {
    const extracted = join(temporary, stem);
    await mkdir(extracted, { mode: 0o755 });
    await syncDirectory(temporary);
    await writeParsedArchive(extracted, parsed);
    await verifyExtractedLocalReleaseV1(extracted, manifest);
    await ensurePublicationClaim(claim, claimBytes, versionsRoot);
    try {
      await rename(extracted, ready);
      await syncDirectory(versionsRoot);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      try {
        if (!await verifiedReadyOrFalse(ready, manifest)) throw error;
      } catch (readyError) {
        if (await existingTarget(target, manifest)) {
          return report(manifest, true, versionsRoot);
        }
        throw readyError;
      }
    }
    const alreadyStaged = await publishReadyDirectory(ready, target, manifest);
    return report(manifest, alreadyStaged, versionsRoot);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await syncDirectory(versionsRoot);
  }
}

export async function stageLocalReleaseV1(input) {
  try {
    return await stageLocalReleaseInternalV1(input);
  } catch {
    return refused();
  }
}
