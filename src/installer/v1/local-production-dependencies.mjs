import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SCHEMA = "control-room.local-production-dependency-preparation/v1";
const RECEIPT_SCHEMA = "control-room.local-production-dependency-receipt/v1";
const MANIFEST_SCHEMA = "control-room.local-release-manifest/v1";
const RECEIPT_NAME = ".control-room-production-dependencies.json";
const LOCK_NAME = ".control-room-production-dependencies.lock";
const PACKAGE_MANAGER = "pnpm@11.19.0";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_RELEASE_FILES = 25_000;
const MAX_RELEASE_BYTES = 1024 * 1024 * 1024;
const MAX_DEPENDENCY_FILES = 150_000;
const MAX_DEPENDENCY_BYTES = 2 * 1024 * 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const rawDigestPattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const exactPackageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const refuse = (reason = "local_production_dependency_preparation_refused") => {
  const error = new Error(reason);
  error.code = reason;
  throw error;
};

const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function inside(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function canonicalDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) refuse();
  const canonical = await realpath(path);
  const stat = await lstat(path);
  if (canonical !== path || !stat.isDirectory() || stat.isSymbolicLink()) refuse();
  return canonical;
}

async function regularFile(path, root, maximum = MAX_MANIFEST_BYTES, minimum = 1) {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (!stat.isFile() || stat.isSymbolicLink() || canonical !== path || !inside(path, root)
    || stat.size < minimum || stat.size > maximum) refuse();
  return stat;
}

async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) refuse();
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major < 22 || (major === 22 && (minor < 13 || (minor === 13 && patch < 0)))) refuse();
  return version;
}

function parseManifest(bytes) {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) refuse();
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(",")
      !== "byteCount,dependencyPreparation,entrypoint,fileCount,files,layoutVersion,license,platform,preflight,product,schema,version"
    || manifest.schema !== MANIFEST_SCHEMA || manifest.layoutVersion !== 1
    || manifest.product !== "agent-control-room" || !versionPattern.test(manifest.version)
    || manifest.entrypoint !== "scripts/run-private-vps.mjs"
    || manifest.preflight !== "scripts/prepare-local-installation.mjs"
    || Object.keys(manifest.dependencyPreparation ?? {}).sort().join(",") !== "lockfile,mode,packageManager"
    || manifest.dependencyPreparation?.packageManager !== PACKAGE_MANAGER
    || manifest.dependencyPreparation?.lockfile !== "pnpm-lock.yaml"
    || manifest.dependencyPreparation?.mode !== "frozen-production-install-before-activation"
    || Object.keys(manifest.platform ?? {}).sort().join(",") !== "architectures,artifact,node,operatingSystems"
    || manifest.platform?.artifact !== "portable-node" || manifest.platform?.node !== ">=22.13.0"
    || JSON.stringify(manifest.platform?.operatingSystems) !== JSON.stringify(["darwin", "linux"])
    || JSON.stringify(manifest.platform?.architectures) !== JSON.stringify(["arm64", "x64"])
    || !manifest.platform.operatingSystems.includes(process.platform)
    || !manifest.platform.architectures.includes(process.arch)
    || Object.keys(manifest.license ?? {}).sort().join(",") !== "completeDistributionClearance,inventoryDigest"
    || manifest.license.completeDistributionClearance !== true
    || !rawDigestPattern.test(manifest.license.inventoryDigest)
    || !Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount
    || manifest.files.length < 1 || manifest.files.length > MAX_RELEASE_FILES
    || !Number.isSafeInteger(manifest.byteCount) || manifest.byteCount < 1
    || manifest.byteCount > MAX_RELEASE_BYTES) refuse();
  let total = 0;
  const paths = manifest.files.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "bytes,mode,path,sha256"
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.mode !== "0644"
      || !rawDigestPattern.test(entry.sha256)) refuse();
    total += entry.bytes;
    return safeRelative(entry.path);
  });
  if (total !== manifest.byteCount || new Set(paths).size !== paths.length
    || paths.some((path, index) => index > 0 && paths[index - 1] >= path)) refuse();
  if (!bytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"))) refuse();
  return manifest;
}

function safeRelative(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0")
    || path.startsWith("/") || path.endsWith("/")
    || path.split("/").some(part => part === "" || part === "." || part === "..")) refuse();
  return path;
}

function manifestEntry(manifest, path) {
  const matches = manifest.files.filter(entry => entry?.path === path);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].bytes) || matches[0].bytes < 1
    || !/^[a-f0-9]{64}$/u.test(matches[0].sha256) || matches[0].mode !== "0644") refuse();
  return matches[0];
}

async function parsePackage(versionRoot, manifest) {
  const entry = manifestEntry(manifest, "package.json");
  const path = join(versionRoot, "package.json");
  const stat = await regularFile(path, versionRoot, MAX_PACKAGE_BYTES);
  const bytes = await readFile(path);
  if (stat.size !== entry.bytes || bytes.byteLength !== entry.bytes
    || sha256(bytes) !== `sha256:${entry.sha256}`) refuse();
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.name !== "control-room" || value.version !== manifest.version
    || value.packageManager !== PACKAGE_MANAGER || value.engines?.node !== ">=22.13.0"
    || !value.dependencies || typeof value.dependencies !== "object" || Array.isArray(value.dependencies)) refuse();
  const dependencies = Object.entries(value.dependencies).sort(([left], [right]) => left.localeCompare(right, "en"));
  if (dependencies.length < 1 || dependencies.some(([name, version]) =>
    typeof name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)
    || typeof version !== "string" || !exactPackageVersionPattern.test(version))) refuse();
  return { bytes, digest: sha256(bytes), dependencies };
}

async function verifyLockfile(versionRoot, manifest) {
  const entry = manifestEntry(manifest, "pnpm-lock.yaml");
  const path = join(versionRoot, "pnpm-lock.yaml");
  const stat = await regularFile(path, versionRoot, MAX_MANIFEST_BYTES);
  const bytes = await readFile(path);
  if (stat.size !== entry.bytes || bytes.byteLength !== entry.bytes
    || sha256(bytes) !== `sha256:${entry.sha256}`) refuse();
  const text = bytes.toString("utf8");
  if (!text.startsWith("lockfileVersion: '9.0'\n") || !text.includes("\nimporters:\n")
    || !text.includes("\n  .:\n")) refuse();
  return { bytes, digest: sha256(bytes) };
}

async function verifyPublicationClaim(versionsRoot, manifest, manifestDigest) {
  const path = join(versionsRoot, `.publish-${manifest.version}.json`);
  await regularFile(path, versionsRoot, 4096);
  const expected = Buffer.from(`${JSON.stringify({
    schema: "control-room.local-release-publication-claim/v1",
    version: manifest.version,
    manifestSha256: manifestDigest.slice("sha256:".length),
  })}\n`, "utf8");
  if (!(await readFile(path)).equals(expected)) refuse();
}

async function verifyPreparedReleaseSources(versionRoot, manifest, options = {}) {
  const expected = new Map(manifest.files.map(entry => [entry.path, entry]));
  expected.set("RELEASE_MANIFEST.json", undefined);
  const actual = [];
  const actualDirectories = new Set([""]);
  async function walk(directory, prefix = "") {
    const stat = await lstat(directory);
    const canonical = await realpath(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== directory
      || !inside(directory, versionRoot)) refuse();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && entry.name === "node_modules" && options.allowPrepared === true) continue;
      if (!prefix && entry.name === RECEIPT_NAME && options.allowPrepared === true) continue;
      if (!prefix && entry.name === LOCK_NAME && options.allowLock === true) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) refuse();
      if (entry.isDirectory()) {
        actualDirectories.add(name);
        await walk(path, name);
      }
      else if (entry.isFile()) actual.push(name);
      else refuse();
    }
  }
  await walk(versionRoot);
  actual.sort((left, right) => left.localeCompare(right, "en"));
  const expectedPaths = [...expected.keys()].sort((left, right) => left.localeCompare(right, "en"));
  if (actual.length !== expectedPaths.length || actual.some((path, index) => path !== expectedPaths[index])) refuse();
  const expectedDirectories = new Set([""]);
  for (const path of expectedPaths) {
    let current = dirname(path);
    while (current !== ".") {
      expectedDirectories.add(current.split(sep).join("/"));
      current = dirname(current);
    }
  }
  if (actualDirectories.size !== expectedDirectories.size
    || [...actualDirectories].some(path => !expectedDirectories.has(path))) refuse();
  for (const [path, entry] of expected) {
    if (!entry) continue;
    const absolute = join(versionRoot, path);
    const stat = await regularFile(absolute, versionRoot, MAX_RELEASE_BYTES, 0);
    const bytes = await readFile(absolute);
    if (stat.size !== entry.bytes || bytes.byteLength !== entry.bytes
      || sha256(bytes) !== `sha256:${entry.sha256}`) refuse();
  }
}

function operationDigest(expected) {
  return sha256(Buffer.from(JSON.stringify({ ...expected, nodeVersion: process.versions.node,
    platform: process.platform, architecture: process.arch, packageManager: PACKAGE_MANAGER }), "utf8"));
}

async function verifyExactLock(lockPath, versionRoot, expectedDigest) {
  await regularFile(lockPath, versionRoot, 4096);
  const value = JSON.parse(await readFile(lockPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "operationDigest,schema"
    || value.schema !== "control-room.local-production-dependency-lock/v1"
    || value.operationDigest !== expectedDigest) refuse();
}

async function dependencyTreeDigest(root, options = {}) {
  const aggregate = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  const directories = [];
  async function walk(directory, prefix = "") {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
    directories.push(directory);
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath.includes("\\") || relativePath.split("/").some(part => !part || part === "." || part === "..")) refuse();
      const path = join(directory, entry.name);
      const item = await lstat(path);
      if (item.isDirectory() && !item.isSymbolicLink()) {
        aggregate.update(`d\0${relativePath}\0`);
        await walk(path, relativePath);
      } else if (item.isFile() && !item.isSymbolicLink()) {
        const bytes = await readFile(path);
        fileCount += 1;
        byteCount += bytes.byteLength;
        if (fileCount > MAX_DEPENDENCY_FILES || byteCount > MAX_DEPENDENCY_BYTES) refuse();
        aggregate.update(`f\0${relativePath}\0${bytes.byteLength}\0`);
        aggregate.update(createHash("sha256").update(bytes).digest());
        if (options.durable === true) {
          const handle = await open(path, "r");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      } else if (item.isSymbolicLink()) {
        const target = await realpath(path);
        if (!inside(target, root)) refuse();
        const linkText = await readlink(path);
        aggregate.update(`l\0${relativePath}\0${linkText}\0`);
      } else refuse();
    }
  }
  await walk(root);
  if (options.durable === true) {
    for (const directory of directories.sort((left, right) => right.split(sep).length - left.split(sep).length)) {
      await syncDirectory(directory);
    }
  }
  if (fileCount < 1 || byteCount < 1) refuse();
  return { digest: `sha256:${aggregate.digest("hex")}`, fileCount, byteCount };
}

async function verifyTopLevelProductionDependencies(root, dependencies) {
  const expected = new Set(dependencies.map(([name]) => name));
  const actual = new Set();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".pnpm" || entry.name === ".bin" || entry.name === ".modules.yaml") continue;
    if (entry.name.startsWith("@")) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) refuse();
      for (const child of await readdir(join(root, entry.name), { withFileTypes: true })) {
        actual.add(`${entry.name}/${child.name}`);
      }
    } else actual.add(entry.name);
  }
  if (actual.size !== expected.size || [...actual].some(name => !expected.has(name))) refuse();
  for (const [name, expectedVersion] of dependencies) {
    const packageRoot = join(root, ...name.split("/"));
    const canonical = await realpath(packageRoot);
    if (!inside(canonical, root)) refuse();
    const bytes = await readFile(join(packageRoot, "package.json"));
    if (bytes.byteLength > MAX_PACKAGE_BYTES) refuse();
    const value = JSON.parse(bytes.toString("utf8"));
    if (value?.name !== name || value?.version !== expectedVersion) refuse();
  }
}

function exactReceipt(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",")
      !== "architecture,dependencyByteCount,dependencyFileCount,dependencyTreeDigest,lockfileDigest,manifestDigest,nodeVersion,packageDigest,packageManager,platform,schema,version"
    || value.schema !== RECEIPT_SCHEMA || value.version !== expected.version
    || value.manifestDigest !== expected.manifestDigest || value.packageDigest !== expected.packageDigest
    || value.lockfileDigest !== expected.lockfileDigest || value.packageManager !== PACKAGE_MANAGER
    || value.nodeVersion !== process.versions.node || value.platform !== process.platform
    || value.architecture !== process.arch || !digestPattern.test(value.dependencyTreeDigest)
    || !Number.isSafeInteger(value.dependencyFileCount) || value.dependencyFileCount < 1
    || !Number.isSafeInteger(value.dependencyByteCount) || value.dependencyByteCount < 1) refuse();
  return value;
}

async function existingReceipt(versionRoot, expected, dependencies) {
  const receiptPath = join(versionRoot, RECEIPT_NAME);
  if (await absent(receiptPath)) return undefined;
  await regularFile(receiptPath, versionRoot, 16 * 1024);
  const receipt = exactReceipt(JSON.parse(await readFile(receiptPath, "utf8")), expected);
  const dependencyRoot = join(versionRoot, "node_modules");
  await canonicalDirectory(dependencyRoot);
  await verifyTopLevelProductionDependencies(dependencyRoot, dependencies);
  const tree = await dependencyTreeDigest(dependencyRoot);
  if (tree.digest !== receipt.dependencyTreeDigest || tree.fileCount !== receipt.dependencyFileCount
    || tree.byteCount !== receipt.dependencyByteCount) refuse();
  return receipt;
}

function result(receipt, alreadyPrepared) {
  return Object.freeze({
    schema: SCHEMA,
    state: "production_dependencies_prepared",
    version: receipt.version,
    alreadyPrepared,
    manifestDigest: receipt.manifestDigest,
    dependencyTreeDigest: receipt.dependencyTreeDigest,
    dependencyFileCount: receipt.dependencyFileCount,
    dependencyByteCount: receipt.dependencyByteCount,
    packageManager: receipt.packageManager,
    nodeVersion: receipt.nodeVersion,
    platform: receipt.platform,
    architecture: receipt.architecture,
    switchesCurrentRelease: false,
    installsOrStartsService: false,
    createsOrMigratesDatabase: false,
    readsOrWritesCredentials: false,
    startsWorkers: false,
    runsPackageScripts: false,
  });
}

async function writeDurableFile(path, bytes, mode = 0o600) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Prepare production dependencies for one already-staged release. `runner` is
 * injected so tests never download packages or execute package tooling.
 */
export async function prepareLocalProductionDependenciesV1(input, { runner }) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "expectedManifestDigest,installRoot,ownerAttended,version"
    || input.ownerAttended !== true || !versionPattern.test(input.version)
    || !digestPattern.test(input.expectedManifestDigest) || typeof runner !== "function") refuse();
  const installRoot = await canonicalDirectory(input.installRoot);
  const versionsRoot = await canonicalDirectory(join(installRoot, "versions"));
  const versionRoot = await canonicalDirectory(join(versionsRoot, input.version));
  const manifestPath = join(versionRoot, "RELEASE_MANIFEST.json");
  await regularFile(manifestPath, versionRoot, MAX_MANIFEST_BYTES);
  const manifestBytes = await readFile(manifestPath);
  const manifestDigest = sha256(manifestBytes);
  if (manifestDigest !== input.expectedManifestDigest) refuse();
  const manifest = parseManifest(manifestBytes);
  if (manifest.version !== input.version) refuse();
  await verifyPublicationClaim(versionsRoot, manifest, manifestDigest);
  const packageRecord = await parsePackage(versionRoot, manifest);
  const lockRecord = await verifyLockfile(versionRoot, manifest);
  const expected = { version: manifest.version, manifestDigest, packageDigest: packageRecord.digest,
    lockfileDigest: lockRecord.digest };
  parseNodeVersion(process.versions.node);
  const lockPath = join(versionRoot, LOCK_NAME);
  const expectedOperationDigest = operationDigest(expected);
  const hasReceipt = !await absent(join(versionRoot, RECEIPT_NAME));
  const hasLock = !await absent(lockPath);
  if (hasReceipt) {
    await verifyPreparedReleaseSources(versionRoot, manifest, { allowPrepared: true, allowLock: hasLock });
  }
  const saved = await existingReceipt(versionRoot, expected, packageRecord.dependencies);
  if (saved) {
    if (hasLock) {
      await verifyExactLock(lockPath, versionRoot, expectedOperationDigest);
      await rm(lockPath, { force: true });
      await syncDirectory(versionRoot);
    }
    return result(saved, true);
  }
  if (!await absent(join(versionRoot, "node_modules")) || hasLock) {
    refuse("local_production_dependency_preparation_uncertain");
  }
  await verifyPreparedReleaseSources(versionRoot, manifest);

  try {
    await writeDurableFile(lockPath, Buffer.from(`${JSON.stringify({ schema: "control-room.local-production-dependency-lock/v1",
      operationDigest: expectedOperationDigest })}\n`, "utf8"));
    await syncDirectory(versionRoot);
  } catch (error) {
    if (error?.code === "EEXIST") refuse("local_production_dependency_preparation_in_progress");
    throw error;
  }

  const temporary = await mkdtemp(join(installRoot, ".dependency-staging-"));
  let knownFailure = true;
  let published = false;
  try {
    await writeFile(join(temporary, "package.json"), packageRecord.bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(temporary, "pnpm-lock.yaml"), lockRecord.bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(temporary, ".npmrc"), "ignore-scripts=true\n", { flag: "wx", mode: 0o600 });
    for (const directory of ["home", "store", "cache", "config", "data"]) {
      await mkdir(join(temporary, directory), { mode: 0o700 });
    }
    const environment = Object.freeze({
      PATH: process.env.PATH ?? "",
      HOME: join(temporary, "home"),
      XDG_CACHE_HOME: join(temporary, "cache"),
      XDG_CONFIG_HOME: join(temporary, "config"),
      XDG_DATA_HOME: join(temporary, "data"),
      COREPACK_HOME: join(temporary, "home", ".cache", "node", "corepack"),
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      NPM_CONFIG_GLOBALCONFIG: join(temporary, ".npmrc"),
      NPM_CONFIG_USERCONFIG: join(temporary, ".npmrc"),
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_globalconfig: join(temporary, ".npmrc"),
      npm_config_userconfig: join(temporary, ".npmrc"),
      npm_config_ignore_scripts: "true",
      CI: "true",
      NO_COLOR: "1",
    });
    let versionRun;
    try {
      versionRun = await runner(Object.freeze({ executable: "pnpm", args: Object.freeze(["--version"]),
        cwd: temporary, environment, timeoutMs: 60_000 }));
    } catch {
      knownFailure = false;
      refuse("local_production_dependency_preparation_uncertain");
    }
    if (!versionRun || versionRun.exitCode !== 0 || versionRun.signal !== null
      || versionRun.stdout.trim() !== "11.19.0" || versionRun.stderr.length > 32 * 1024) refuse();
    let installRun;
    try {
      installRun = await runner(Object.freeze({
        executable: "pnpm",
        args: Object.freeze(["install", "--prod", "--frozen-lockfile", "--ignore-scripts",
          "--store-dir", join(temporary, "store"), "--virtual-store-dir", join(temporary, "node_modules", ".pnpm")]),
        cwd: temporary,
        environment,
        timeoutMs: 15 * 60_000,
      }));
    } catch {
      knownFailure = false;
      refuse("local_production_dependency_preparation_uncertain");
    }
    if (!installRun || installRun.exitCode !== 0 || installRun.signal !== null
      || installRun.stdout.length > 1024 * 1024 || installRun.stderr.length > 1024 * 1024) refuse();
    const temporaryDependencies = await canonicalDirectory(join(temporary, "node_modules"));
    await verifyTopLevelProductionDependencies(temporaryDependencies, packageRecord.dependencies);
    const tree = await dependencyTreeDigest(temporaryDependencies, { durable: true });
    await syncDirectory(temporary);
    if (!await absent(join(versionRoot, "node_modules"))) {
      knownFailure = false;
      refuse("local_production_dependency_preparation_uncertain");
    }
    await rename(temporaryDependencies, join(versionRoot, "node_modules"));
    published = true;
    await syncDirectory(temporary);
    await syncDirectory(versionRoot);
    const publishedDependencies = await canonicalDirectory(join(versionRoot, "node_modules"));
    await verifyTopLevelProductionDependencies(publishedDependencies, packageRecord.dependencies);
    const publishedTree = await dependencyTreeDigest(publishedDependencies);
    if (publishedTree.digest !== tree.digest || publishedTree.fileCount !== tree.fileCount
      || publishedTree.byteCount !== tree.byteCount) {
      knownFailure = false;
      refuse("local_production_dependency_preparation_uncertain");
    }
    const receipt = Object.freeze({
      schema: RECEIPT_SCHEMA,
      version: manifest.version,
      manifestDigest,
      packageDigest: packageRecord.digest,
      lockfileDigest: lockRecord.digest,
      packageManager: PACKAGE_MANAGER,
      nodeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      dependencyTreeDigest: publishedTree.digest,
      dependencyFileCount: publishedTree.fileCount,
      dependencyByteCount: publishedTree.byteCount,
    });
    const receiptTemporary = join(versionRoot, `.dependency-receipt-${expectedOperationDigest.slice(-16)}.json`);
    await writeDurableFile(receiptTemporary, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
    await rename(receiptTemporary, join(versionRoot, RECEIPT_NAME));
    await syncDirectory(versionRoot);
    await rm(lockPath, { force: true });
    await syncDirectory(versionRoot);
    await rm(temporary, { recursive: true, force: true });
    return result(receipt, false);
  } catch (error) {
    if (published) {
      knownFailure = false;
      refuse("local_production_dependency_preparation_uncertain");
    }
    if (knownFailure) {
      await rm(temporary, { recursive: true, force: true });
      await rm(lockPath, { force: true });
      await syncDirectory(versionRoot);
    }
    throw error;
  }
}
