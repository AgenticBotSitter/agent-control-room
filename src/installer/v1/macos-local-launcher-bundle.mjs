import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, release as kernelRelease } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createDeterministicTarGzipV1 } from "./local-release-assembly.mjs";
import { runLocalLauncherCoreV1 } from "./local-launcher-core.mjs";
import { stageLocalReleaseV1 } from "./local-release-stager.mjs";
import { copyVerifiedMacosInstallationJournalNativeSidecarV1,
  verifyInstallationJournalNativeArtifactV1,
  verifyMacosInstallationJournalNativeSidecarV1 } from "./macos-installation-journal-native-sidecar.mjs";
import { copyVerifiedMacosProtectedDirectoryNativeSidecarV1, verifyProtectedDirectoryNativeArtifactV1,
  verifyMacosProtectedDirectoryNativeSidecarV1 } from "./macos-protected-directory-native-sidecar.mjs";

export const MACOS_LOCAL_LAUNCHER_BUNDLE_V1 =
  "control-room.macos-local-launcher-bundle/v1";

const MANIFEST_NAME = "MACOS_LAUNCHER_MANIFEST.json";
const COMMAND_NAME = "Open Agent Control Room.command";
const FIXED_FILE_COUNT = 19;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const safeIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const NATIVE_SIDECAR_DIRECTORY = "native/protected-directory";
const JOURNAL_NATIVE_SIDECAR_DIRECTORY = "native/installation-journal";
const RUNTIME_FILES = Object.freeze(["local-launcher-core.mjs", "local-release-assembly.mjs", "local-release-stager.mjs",
  "local-setup-launcher-supervisor.mjs", "macos-installation-journal-native-sidecar.mjs",
  "macos-local-launcher-bundle.mjs", "macos-protected-directory-native-sidecar.mjs"]);

const refused = (reason = "macos_local_launcher_bundle_refused") => {
  const error = new Error(reason);
  error.code = reason;
  throw error;
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function inside(child, parent) {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function safeRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || value.endsWith("/")
    || value.split("/").some(part => part === "" || part === "." || part === "..")) refused();
  return value;
}

async function canonicalDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) refused();
  const [canonical, stat] = await Promise.all([realpath(path), lstat(path)]).catch(() => refused());
  if (canonical !== path || !stat.isDirectory() || stat.isSymbolicLink()) refused();
  return path;
}

async function regularFile(path, root, maximum = MAX_FILE_BYTES) {
  const [canonical, stat] = await Promise.all([realpath(path), lstat(path)]).catch(() => refused());
  if (canonical !== path || !inside(path, root) || !stat.isFile() || stat.isSymbolicLink()
    || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) refused();
  return stat;
}

function nodeSupported(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0)));
}

function parseManifest(bytes) {
  if (bytes.byteLength > 64 * 1024) refused();
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "fileCount,files,node,platform,product,schema,version"
    || value.schema !== MACOS_LOCAL_LAUNCHER_BUNDLE_V1 || value.product !== "agent-control-room"
    || value.platform !== "darwin" || value.node !== ">=22.13.0" || !versionPattern.test(value.version)
    || !Array.isArray(value.files) || value.files.length !== value.fileCount
    || value.files.length !== FIXED_FILE_COUNT) refused();
  const paths = value.files.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "bytes,mode,path,sha256"
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_FILE_BYTES
      || !digestPattern.test(entry.sha256) || (entry.mode !== "0644" && entry.mode !== "0755")) refused();
    return safeRelative(entry.path);
  });
  if (new Set(paths).size !== paths.length
    || paths.some((path, index) => index > 0 && paths[index - 1] >= path)
    || !bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"))) refused();
  return value;
}

async function listTree(root) {
  const files = [];
  const directories = new Set([""]);
  async function walk(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const path = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelative(name);
      if (entry.isSymbolicLink()) refused();
      if (entry.isDirectory()) {
        const stat = await lstat(path);
        if (await realpath(path) !== path || (stat.mode & 0o7777) !== 0o755) refused();
        directories.add(name);
        await walk(path, name);
      } else if (entry.isFile()) files.push(name);
      else refused();
      if (files.length > FIXED_FILE_COUNT + 1) refused();
    }
  }
  await walk(root);
  return { files: files.sort(), directories };
}

function expectedDirectories(paths) {
  const result = new Set([""]);
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== ".") {
      result.add(parent.split(sep).join("/"));
      parent = dirname(parent);
    }
  }
  return result;
}

function expectedBundleMembers(version, architecture) {
  const paths = [COMMAND_NAME, "release/SHA256SUMS", `release/agent-control-room-${version}.manifest.json`,
    `release/agent-control-room-${version}.tar.gz`, ...RUNTIME_FILES.map(name => `runtime/${name}`),
    `${NATIVE_SIDECAR_DIRECTORY}/MACOS_PROTECTED_DIRECTORY_SIDECAR.json`,
    `${NATIVE_SIDECAR_DIRECTORY}/PROTECTED_DIRECTORY_MANIFEST.json`, `${NATIVE_SIDECAR_DIRECTORY}/SHA256SUMS`,
    `${NATIVE_SIDECAR_DIRECTORY}/agent-control-room-protected-directory-darwin-${architecture}.tar.gz`,
    `${JOURNAL_NATIVE_SIDECAR_DIRECTORY}/INSTALLATION_JOURNAL_MANIFEST.json`,
    `${JOURNAL_NATIVE_SIDECAR_DIRECTORY}/MACOS_INSTALLATION_JOURNAL_SIDECAR.json`,
    `${JOURNAL_NATIVE_SIDECAR_DIRECTORY}/SHA256SUMS`,
    `${JOURNAL_NATIVE_SIDECAR_DIRECTORY}/agent-control-room-installation-journal-darwin-${architecture}.tar.gz`]
    .sort();
  if (paths.length !== FIXED_FILE_COUNT || new Set(paths).size !== paths.length) refused();
  return paths.map(path => Object.freeze({ path, mode: path === COMMAND_NAME ? "0755" : "0644" }));
}

/** Verifies the complete extracted one-asset launcher before it can stage a release. */
export async function verifyExtractedMacosLocalLauncherBundleV1(bundleRootInput) {
  const bundleRoot = await canonicalDirectory(bundleRootInput);
  if (((await lstat(bundleRoot)).mode & 0o7777) !== 0o755) refused();
  const manifestPath = join(bundleRoot, MANIFEST_NAME);
  const manifestStat = await regularFile(manifestPath, bundleRoot, 64 * 1024);
  if ((manifestStat.mode & 0o7777) !== 0o644) refused();
  const manifest = parseManifest(await readFile(manifestPath));
  const tree = await listTree(bundleRoot);
  const expectedFiles = [...manifest.files.map(entry => entry.path), MANIFEST_NAME].sort();
  const expectedDirs = expectedDirectories(expectedFiles);
  if (tree.files.length !== expectedFiles.length
    || tree.files.some((path, index) => path !== expectedFiles[index])
    || tree.directories.size !== expectedDirs.size
    || [...tree.directories].some(path => !expectedDirs.has(path))) refused();
  for (const entry of manifest.files) {
    const path = join(bundleRoot, entry.path);
    const stat = await regularFile(path, bundleRoot);
    const bytes = await readFile(path);
    const exactMode = stat.mode & 0o7777;
    const actualMode = exactMode === 0o644 ? "0644" : exactMode === 0o755 ? "0755" : undefined;
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256 || actualMode !== entry.mode) refused();
  }
  // The release assembler writes this external manifest byte-for-byte with
  // the inner RELEASE_MANIFEST.json that the stager later verifies.
  const releaseManifest = manifest.files.find(entry => entry.path === `release/agent-control-room-${manifest.version}.manifest.json`);
  const journalSidecarManifest = manifest.files.find(entry => entry.path
    === `${JOURNAL_NATIVE_SIDECAR_DIRECTORY}/MACOS_INSTALLATION_JOURNAL_SIDECAR.json`);
  if (!releaseManifest || !journalSidecarManifest) refused();
  let protectedDirectoryNativeSidecar, installationJournalNativeSidecar;
  try {
    [protectedDirectoryNativeSidecar, installationJournalNativeSidecar] = await Promise.all([
      verifyMacosProtectedDirectoryNativeSidecarV1(join(bundleRoot, NATIVE_SIDECAR_DIRECTORY),
        { releaseVersion: manifest.version }),
      verifyMacosInstallationJournalNativeSidecarV1(join(bundleRoot, JOURNAL_NATIVE_SIDECAR_DIRECTORY),
        { releaseVersion: manifest.version }),
    ]);
  } catch { refused(); }
  if (protectedDirectoryNativeSidecar.architecture !== installationJournalNativeSidecar.architecture
    || installationJournalNativeSidecar.sidecarManifestSha256 !== `sha256:${journalSidecarManifest.sha256}`) refused();
  const expectedMembers = expectedBundleMembers(manifest.version, installationJournalNativeSidecar.architecture);
  if (manifest.files.some((entry, index) => entry.path !== expectedMembers[index].path
    || entry.mode !== expectedMembers[index].mode)) refused();
  return Object.freeze({ verified: true, version: manifest.version, fileCount: manifest.fileCount,
    releaseManifestDigest: `sha256:${releaseManifest.sha256}`, protectedDirectoryNativeSidecar,
    installationJournalNativeSidecar });
}

function macosVersionFromKernel(value) {
  const match = /^(\d+)\./u.exec(value);
  if (!match) return undefined;
  const darwinMajor = Number(match[1]);
  // Darwin 22 is macOS 13. Earlier mappings cannot meet the sidecar minimum.
  return Number.isSafeInteger(darwinMajor) && darwinMajor >= 22 ? `${darwinMajor - 9}.0` : undefined;
}

async function ensurePrivateDirectory(path) {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch {
    return refused();
  }
  const directory = await canonicalDirectory(path);
  const stat = await lstat(directory);
  if ((stat.mode & 0o077) !== 0) refused("macos_local_launcher_private_directory_refused");
  return directory;
}

function defaultTopologyDigest() {
  const plan = JSON.stringify({ placement: "this-computer", schema: "control-room.local-launcher-topology/v1" });
  return `sha256:${sha256(Buffer.from(plan, "utf8"))}`;
}

function killProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
}

/** Runs one owned macOS process group and reaps its leader after bounded group termination. */
export function runBoundedMacosLauncherChildV1(spec) {
  if (!spec || typeof spec !== "object" || !Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1
    || (spec.terminationGraceMs !== undefined
      && (!Number.isSafeInteger(spec.terminationGraceMs) || spec.terminationGraceMs < 1 || spec.terminationGraceMs > 30_000))) refused();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.environment,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = {
      stdout: { chunks: [], bytes: 0 },
      stderr: { chunks: [], bytes: 0 },
    };
    let oversized = false, timedOut = false, leaderClosed = false;
    let exitCode, exitSignal, terminationStarted = false, groupKilled = false;
    const grace = spec.terminationGraceMs ?? 2_000;
    let timer, killTimer;
    const retainedText = target => {
      let text = Buffer.concat(output[target].chunks, output[target].bytes).toString("utf8");
      while (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) text = text.slice(0, -1);
      return text;
    };
    const finish = () => {
      if (!leaderClosed || (terminationStarted && !groupKilled)) return;
      clearTimeout(timer); clearTimeout(killTimer);
      resolvePromise({ exitCode, signal: exitSignal, stdout: retainedText("stdout"),
        stderr: retainedText("stderr"), oversized, timedOut });
    };
    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      try { killProcessGroup(child.pid, "SIGTERM"); } catch (error) { reject(error); return; }
      killTimer = setTimeout(() => {
        try { killProcessGroup(child.pid, "SIGKILL"); }
        catch (error) { reject(error); return; }
        groupKilled = true;
        finish();
      }, grace);
    };
    const append = target => chunk => {
      if (terminationStarted || oversized) return;
      const state = output[target];
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_OUTPUT_BYTES - state.bytes;
      if (bytes.byteLength > remaining) {
        if (remaining > 0) state.chunks.push(bytes.subarray(0, remaining));
        state.bytes += remaining;
        oversized = true;
        terminate();
        return;
      }
      state.chunks.push(bytes);
      state.bytes += bytes.byteLength;
    };
    child.stdout.on("data", append("stdout"));
    child.stderr.on("data", append("stderr"));
    child.once("error", reject);
    timer = setTimeout(() => { timedOut = true; terminate(); }, spec.timeoutMs);
    child.once("close", (closedExitCode, closedSignal) => {
      leaderClosed = true;
      exitCode = closedExitCode; exitSignal = closedSignal;
      finish();
    });
  });
}

function allowedChildEnvironment(home, source) {
  const environment = {
    PATH: typeof source.PATH === "string" && source.PATH.length > 0
      ? source.PATH : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
  };
  for (const key of ["TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) environment[key] = value;
  }
  return Object.freeze(environment);
}

/**
 * Runs the extracted macOS handoff. This composes the existing stager,
 * shipped read-only preflight and shipped source-only setup rehearsal.
 */
export async function runMacosLocalLauncherBundleV1(input, dependencies = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["bundleRoot", "homeDirectory", "installRoot", "installationId", "journalRoot"].includes(key))
    || typeof input.bundleRoot !== "string") refused();
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  if (platform !== "darwin" || !["arm64", "x64"].includes(architecture)) refused("macos_local_launcher_unsupported_platform");
  if (!nodeSupported(nodeVersion)) refused("macos_local_launcher_node_prerequisite_missing");
  const bundleRoot = await canonicalDirectory(input.bundleRoot);
  const verified = await verifyExtractedMacosLocalLauncherBundleV1(bundleRoot);
  const macosVersion = dependencies.macosVersion ?? macosVersionFromKernel(dependencies.kernelRelease ?? kernelRelease());
  if (!macosVersion || verified.protectedDirectoryNativeSidecar.architecture !== architecture
    || verified.installationJournalNativeSidecar.architecture !== architecture) {
    refused("macos_local_launcher_unsupported_platform");
  }
  try {
    await Promise.all([
      verifyMacosProtectedDirectoryNativeSidecarV1(join(bundleRoot, NATIVE_SIDECAR_DIRECTORY), {
        releaseVersion: verified.version, architecture, macosVersion,
      }),
      verifyMacosInstallationJournalNativeSidecarV1(join(bundleRoot, JOURNAL_NATIVE_SIDECAR_DIRECTORY), {
        releaseVersion: verified.version, architecture, macosVersion,
      }),
    ]);
  } catch { refused("macos_local_launcher_unsupported_platform"); }
  const home = input.homeDirectory ?? homedir();
  if (typeof home !== "string" || !isAbsolute(home) || resolve(home) !== home) refused();
  const installRoot = await ensurePrivateDirectory(input.installRoot
    ?? join(home, "Library", "Application Support", "Agent Control Room"));
  const journalRoot = await ensurePrivateDirectory(input.journalRoot ?? join(installRoot, "setup-journal"));
  // The installation identity belongs to the owner installation, not to a
  // release. Keeping it stable makes upgrades replay or conflict against the
  // same canonical setup history instead of silently creating a second one.
  const installationId = input.installationId ?? "macos-local";
  if (!safeIdPattern.test(installationId)) refused();
  const releaseDirectory = await canonicalDirectory(join(bundleRoot, "release"));
  const { protectedDirectoryNativeSidecar, installationJournalNativeSidecar, ...verifiedBundle } = verified;
  const report = await runLocalLauncherCoreV1({ verifiedBundle, releaseDirectory, installRoot, journalRoot,
    installationId, topologyPlanDigest: defaultTopologyDigest(),
    environment: allowedChildEnvironment(home, dependencies.hostEnvironment ?? process.env),
    executable: process.execPath, schema: MACOS_LOCAL_LAUNCHER_BUNDLE_V1 }, {
    runner: dependencies.runner ?? runBoundedMacosLauncherChildV1,
    openerRunner: dependencies.openerRunner ?? runBoundedMacosLauncherChildV1,
    openerExecutable: "/usr/bin/open",
    ...(dependencies.supervisor ? { supervisor: dependencies.supervisor } : {}),
    ...(dependencies.spawnProcess ? { spawnProcess: dependencies.spawnProcess } : {}),
    ...(dependencies.signals ? { signals: dependencies.signals } : {}),
    ...(dependencies.killGroup ? { killGroup: dependencies.killGroup } : {}),
    ...(dependencies.setTimer ? { setTimer: dependencies.setTimer } : {}),
    ...(dependencies.clearTimer ? { clearTimer: dependencies.clearTimer } : {}),
    refusalCodes: {
      refused: "macos_local_launcher_bundle_refused",
      preflight: "macos_local_launcher_preflight_refused",
      setup: "macos_local_launcher_setup_refused",
      bootstrap: "macos_local_launcher_plan_bootstrap_refused",
      setupHost: "macos_local_launcher_setup_host_refused",
    },
  });
  return Object.freeze({ ...report, protectedDirectoryNativeSidecar, installationJournalNativeSidecar });
}

async function assertAbsent(path) {
  try { await access(path); refused(); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function commandBytes() {
  return Buffer.from(`#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
prompt_to_close() {
  printf '%s' 'Press Return to close...'
  if [ -t 0 ]; then
    IFS= read -r _answer || :
  fi
}
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Agent Control Room needs Node.js 22.13 or later. Install Node.js, then double-click this file again.' >&2
  prompt_to_close
  exit 1
fi
set +e
node "$SCRIPT_DIR/runtime/macos-local-launcher-bundle.mjs" --launch-bundle "$SCRIPT_DIR"
status=$?
set -e
printf '\n%s\n' 'This source-only launcher does not activate the database, service, or agents.'
prompt_to_close
exit "$status"
`, "utf8");
}

/** Creates the single deterministic GitHub Release asset for the macOS source-only launcher. */
export async function assembleMacosLocalLauncherBundleV1(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",")
      !== "journalNativeArtifactDirectory,nativeArtifactDirectory,outputDirectory,releaseDirectory,sourceRoot") refused();
  const sourceRoot = await canonicalDirectory(input.sourceRoot);
  const releaseDirectory = await canonicalDirectory(input.releaseDirectory);
  if (typeof input.nativeArtifactDirectory !== "string" || !isAbsolute(input.nativeArtifactDirectory)
    || resolve(input.nativeArtifactDirectory) !== input.nativeArtifactDirectory
    || typeof input.journalNativeArtifactDirectory !== "string" || !isAbsolute(input.journalNativeArtifactDirectory)
    || resolve(input.journalNativeArtifactDirectory) !== input.journalNativeArtifactDirectory
    || typeof input.outputDirectory !== "string" || !isAbsolute(input.outputDirectory)
    || resolve(input.outputDirectory) !== input.outputDirectory
    || inside(input.outputDirectory, sourceRoot) || inside(sourceRoot, input.outputDirectory)) refused();
  const outputParent = await canonicalDirectory(dirname(input.outputDirectory));
  await assertAbsent(input.outputDirectory);
  // Capture both reviewed artifact identities before any release or native
  // member is staged. Copying re-verifies the sources and must reproduce these
  // exact bounded identities, closing substitution and mixed-architecture gaps.
  let expectedProtectedDirectoryArtifact, expectedInstallationJournalArtifact;
  try {
    [expectedProtectedDirectoryArtifact, expectedInstallationJournalArtifact] = await Promise.all([
      verifyProtectedDirectoryNativeArtifactV1(input.nativeArtifactDirectory),
      verifyInstallationJournalNativeArtifactV1(input.journalNativeArtifactDirectory),
    ]);
  } catch { refused(); }
  if (expectedProtectedDirectoryArtifact.architecture !== expectedInstallationJournalArtifact.architecture) refused();
  const validation = await mkdtemp(join(outputParent, ".macos-launcher-validation-"));
  try {
    const staged = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot: validation });
    if (staged.state !== "verified_release_staged" || staged.installsOrStartsService || staged.usesNetwork) refused();
    const work = await mkdtemp(join(outputParent, ".macos-launcher-assembly-"));
    try {
      const rootName = `agent-control-room-macos-${staged.version}`;
      const bundleRoot = join(work, rootName);
      await mkdir(join(bundleRoot, "release"), { recursive: true, mode: 0o755 });
      await mkdir(join(bundleRoot, "runtime"), { recursive: true, mode: 0o755 });
      await Promise.all([bundleRoot, join(bundleRoot, "release"), join(bundleRoot, "runtime")]
        .map(path => chmod(path, 0o755)));
      const releaseNames = (await readdir(releaseDirectory, { withFileTypes: true })).map(entry => entry.name).sort();
      for (const name of releaseNames) {
        const source = join(releaseDirectory, name);
        await regularFile(source, releaseDirectory);
        const destination = join(bundleRoot, "release", name);
        await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
        await chmod(destination, 0o644);
      }
      for (const name of RUNTIME_FILES) {
        const source = join(sourceRoot, "src", "installer", "v1", name);
        await regularFile(source, sourceRoot);
        const destination = join(bundleRoot, "runtime", name);
        await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
        await chmod(destination, 0o644);
      }
      let protectedDirectoryNativeSidecar, installationJournalNativeSidecar;
      try {
        protectedDirectoryNativeSidecar = await copyVerifiedMacosProtectedDirectoryNativeSidecarV1({
          artifactDirectory: input.nativeArtifactDirectory, destinationDirectory: join(bundleRoot, NATIVE_SIDECAR_DIRECTORY),
          releaseVersion: staged.version,
        });
        installationJournalNativeSidecar = await copyVerifiedMacosInstallationJournalNativeSidecarV1({
          artifactDirectory: input.journalNativeArtifactDirectory,
          destinationDirectory: join(bundleRoot, JOURNAL_NATIVE_SIDECAR_DIRECTORY), releaseVersion: staged.version,
        });
      } catch { refused(); }
      for (const [actual, expected] of [[protectedDirectoryNativeSidecar, expectedProtectedDirectoryArtifact],
        [installationJournalNativeSidecar, expectedInstallationJournalArtifact]]) {
        for (const key of ["architecture", "sourceSha256", "archiveSha256", "artifactManifestSha256", "executableSha256"])
          if (actual[key] !== expected[key]) refused();
      }
      if (protectedDirectoryNativeSidecar.architecture !== installationJournalNativeSidecar.architecture) refused();
      await writeFile(join(bundleRoot, COMMAND_NAME), commandBytes(), { flag: "wx", mode: 0o755 });
      await chmod(join(bundleRoot, COMMAND_NAME), 0o755);
      const tree = await listTree(bundleRoot);
      const rows = [];
      for (const path of tree.files.sort()) {
        const bytes = await readFile(join(bundleRoot, path));
        rows.push(Object.freeze({ path, bytes: bytes.byteLength, sha256: sha256(bytes),
          mode: path === COMMAND_NAME ? "0755" : "0644" }));
      }
      const manifest = Object.freeze({ schema: MACOS_LOCAL_LAUNCHER_BUNDLE_V1, product: "agent-control-room",
        version: staged.version, platform: "darwin", node: ">=22.13.0", fileCount: rows.length,
        files: Object.freeze(rows) });
      await writeFile(join(bundleRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
      await chmod(join(bundleRoot, MANIFEST_NAME), 0o644);
      await verifyExtractedMacosLocalLauncherBundleV1(bundleRoot);
      const archiveName = `${rootName}.tar.gz`;
      const archive = await createDeterministicTarGzipV1(bundleRoot, rootName,
        [...manifest.files, { path: MANIFEST_NAME, mode: "0644" }]
          .map(entry => ({ path: entry.path, mode: entry.mode }))
          .sort((left, right) => left.path.localeCompare(right.path, "en")));
      await mkdir(input.outputDirectory, { mode: 0o755 });
      await writeFile(join(input.outputDirectory, archiveName), archive, { flag: "wx", mode: 0o644 });
      return Object.freeze({ schema: MACOS_LOCAL_LAUNCHER_BUNDLE_V1, version: staged.version, archiveName,
        archiveSha256: sha256(archive), assetCount: 1, deterministic: true, platform: "darwin",
        protectedDirectoryNativeSidecar, installationJournalNativeSidecar,
        nodePrerequisite: ">=22.13.0", installsNode: false, publishes: false, signs: false });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  } finally {
    await rm(validation, { recursive: true, force: true });
  }
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--launch-bundle" || !isAbsolute(args[1])) refused();
  const report = await runMacosLocalLauncherBundleV1({ bundleRoot: args[1] });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    const message = error?.code === "macos_local_launcher_unsupported_platform"
      ? "This launcher supports macOS on Apple silicon or Intel only."
      : error?.code === "macos_local_launcher_node_prerequisite_missing"
        ? "Agent Control Room needs Node.js 22.13 or later. Node.js was not downloaded or changed."
        : "Agent Control Room refused the launcher bundle because it was incomplete, changed, unsafe, or setup did not finish cleanly.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
