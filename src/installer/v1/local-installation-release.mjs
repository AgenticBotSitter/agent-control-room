import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const SCHEMA = "control-room.local-installation-package-preparation/v1";
const MAX_FILES = 20_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const requiredFiles = Object.freeze([
  "deploy/operator-config.mjs",
  "dist-vps/client/favicon.svg",
  "dist-vps/client/vinext-client-entry-manifest.json",
  "dist-vps/server/index.js",
  "dist-vps/server/runtime.js",
  "dist-vps/server/serving.js",
  "dist-vps/server/taskApplication.js",
  "package.json",
  "pnpm-lock.yaml",
  "scripts/prepare-local-installation.mjs",
  "scripts/run-private-vps.mjs",
  "src/installer/v1/local-installation-release.mjs",
]);

const refused = () => { throw new Error("local_installation_package_refused"); };
const inside = (child, parent) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

function nodeSupported(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0)));
}

async function regularFile(path, releaseRoot) {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (!stat.isFile() || stat.isSymbolicLink() || canonical !== path || !inside(canonical, releaseRoot)) refused();
  return stat;
}

async function inventoryDirectory(root, releaseRoot, entries) {
  const canonical = await realpath(root);
  const stat = await lstat(root);
  if (canonical !== root || !stat.isDirectory() || stat.isSymbolicLink() || !inside(canonical, releaseRoot)) refused();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isSymbolicLink()) refused();
    if (entry.isDirectory()) await inventoryDirectory(path, releaseRoot, entries);
    else if (entry.isFile()) entries.push(path);
    else refused();
    if (entries.length > MAX_FILES) refused();
  }
}

async function bundleInventory(releaseRoot, version) {
  const paths = [];
  await inventoryDirectory(`${releaseRoot}/dist-vps/server`, releaseRoot, paths);
  await inventoryDirectory(`${releaseRoot}/dist-vps/client`, releaseRoot, paths);
  for (const required of requiredFiles) {
    const path = `${releaseRoot}/${required}`;
    await regularFile(path, releaseRoot);
    if (!paths.includes(path)) paths.push(path);
  }
  paths.sort();
  let byteCount = 0;
  const aggregate = createHash("sha256");
  for (const path of paths) {
    const stat = await regularFile(path, releaseRoot);
    byteCount += stat.size;
    if (byteCount > MAX_BYTES) refused();
    const contents = await readFile(path);
    const name = relative(releaseRoot, path);
    aggregate.update(`${name}\0${contents.byteLength}\0`);
    aggregate.update(createHash("sha256").update(contents).digest());
  }
  return Object.freeze({ version, fileCount: paths.length, byteCount,
    digest: `sha256:${aggregate.digest("hex")}` });
}

/** Standalone Node-only release preparation used by the downloadable bundle. */
export async function prepareLocalInstallationReleaseV1(input) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => key !== "releaseRoot" && key !== "expectedDigest" && key !== "serviceState")
      || typeof input.releaseRoot !== "string" || !isAbsolute(input.releaseRoot)
      || resolve(input.releaseRoot) !== input.releaseRoot
      || (input.expectedDigest !== undefined && (typeof input.expectedDigest !== "string" || !digestPattern.test(input.expectedDigest)))
      || (input.serviceState !== undefined && input.serviceState !== "validated_not_installed")) refused();
    const releaseRoot = await realpath(input.releaseRoot);
    const rootStat = await lstat(releaseRoot);
    if (releaseRoot !== input.releaseRoot || !rootStat.isDirectory() || rootStat.isSymbolicLink()
      || !nodeSupported(process.versions.node)) refused();
    const packageBytes = await readFile(`${releaseRoot}/package.json`);
    if (packageBytes.byteLength > MAX_PACKAGE_BYTES) refused();
    const packageMetadata = JSON.parse(packageBytes.toString("utf8"));
    if (!packageMetadata || typeof packageMetadata !== "object" || Array.isArray(packageMetadata)
      || packageMetadata.name !== "control-room" || !versionPattern.test(packageMetadata.version)
      || packageMetadata.packageManager !== "pnpm@11.19.0"
      || packageMetadata.engines?.node !== ">=22.13.0") refused();
    const inventory = await bundleInventory(releaseRoot, packageMetadata.version);
    if (input.expectedDigest !== undefined && inventory.digest !== input.expectedDigest) refused();
    const bundle = Object.freeze({ state: input.expectedDigest === undefined ? "fingerprinted" : "matched_expected_digest",
      ...inventory, authenticityVerified: false });
    const service = Object.freeze({ state: input.serviceState ?? "awaiting_owner_setup" });
    const nextSteps = service.state === "awaiting_owner_setup"
      ? ["Create private installation settings through the owner setup flow.",
        "Run the owner-attended service safety check.",
        "Review database, backup and supervisor readiness before activation."]
      : ["Review database, backup and supervisor readiness before activation.",
        "Use the separate owner-authorized activation step when every readiness check passes."];
    return Object.freeze({ schema: SCHEMA, mode: "dry-run", bundle, service,
      readyForOwnerSetup: true, startsService: false, createsDatabase: false,
      writesCredentials: false, nextSteps: Object.freeze(nextSteps) });
  } catch {
    return refused();
  }
}
