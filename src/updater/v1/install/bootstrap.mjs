import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod, lchown, lstat, mkdir, open, readFile, readdir, realpath, rename, rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const COMMIT = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TRANSACTION = /^[a-f0-9-]{8,64}$/u;
const TOKEN = /^[A-Za-z0-9._~-]{1,1024}$/u;
const SOURCE_CONFIG = "control-room.attended-source/v1";
const SEED_FILES = Object.freeze([
  ["src/updater/v1/build-attended-release.mjs", "bin/build-attended-release.mjs", 0o500],
  ["scripts/updater/build-fixed-updater-bundle.mjs", "bin/build-fixed-bundle.mjs", 0o500],
  ["src/updater/v1/bin/git-credential-control-room", "bin/git-credential-control-room", 0o500],
]);
const GIT_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C", HOME: "/var/empty", XDG_CONFIG_HOME: "/var/empty",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" });
const GIT_PREFIX = mirror => ["--git-dir", mirror, "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null"];

const refuse = code => { const error = new Error(code); error.code = code; throw error; };
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inside = (parent, child) => {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};
const absolute = (value, code) => {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/" || value.includes("\0")) refuse(code);
  return value;
};

async function safeEntry(path, { directory, expectedUid, code }) {
  const entry = await lstat(path).catch(() => refuse(code));
  if (entry.isSymbolicLink() || directory !== entry.isDirectory() || !directory && (!entry.isFile() || entry.nlink !== 1)
      || entry.uid !== expectedUid || (entry.mode & 0o022) !== 0) refuse(code);
  return entry;
}

async function git(gitPath, mirror, args, options = {}) {
  try {
    return await executeFile(gitPath, [...GIT_PREFIX(mirror), ...args], {
      cwd: options.cwd, env: GIT_ENVIRONMENT, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch { refuse(options.code ?? "bootstrap_source_git_refused"); }
}

function parseTree(text) {
  if (typeof text !== "string" || !text.endsWith("\0")) refuse("bootstrap_source_tree_refused");
  const entries = text.split("\0").filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64}) +(\d+)\t([^\0]+)$/u.exec(row);
    if (!match || match[4].startsWith("/") || match[4].split("/").some(part => !part || part === "." || part === "..")
        || /[\r\n\u0000-\u001f\u007f]/u.test(match[4])) refuse("bootstrap_source_tree_refused");
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0 || size > 128 * 1024 * 1024) refuse("bootstrap_source_tree_refused");
    return Object.freeze({ mode: match[1], oid: match[2], size, path: match[4] });
  });
  if (entries.length < 1 || entries.length > 100_000
      || entries.reduce((sum, item) => sum + item.size, 0) > 2 * 1024 * 1024 * 1024) refuse("bootstrap_source_tree_refused");
  return entries;
}

async function walkSource(source, expectedUid) {
  const files = [];
  async function visit(directory) {
    await safeEntry(directory, { directory: true, expectedUid, code: "bootstrap_source_metadata_refused" });
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), local = relative(source, path).split(sep).join("/");
      const entry = await lstat(path).catch(() => refuse("bootstrap_source_metadata_refused"));
      if (entry.isSymbolicLink() || entry.uid !== expectedUid || (entry.mode & 0o022) !== 0) refuse("bootstrap_source_metadata_refused");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.nlink === 1) files.push({ path: local, size: entry.size, mode: entry.mode & 0o777 });
      else refuse("bootstrap_source_metadata_refused");
    }
  }
  await visit(source); return files;
}

/** Re-proves that stage B's extracted source is exactly the phone-confirmed git tree. */
export async function verifyBootstrapSourceV1(input, runtime = {}) {
  const bootstrapRoot = absolute(input?.bootstrapRoot, "bootstrap_source_refused");
  if (!COMMIT.test(input?.commit ?? "")) refuse("bootstrap_source_refused");
  const expectedUid = runtime.expectedUid ?? 0;
  const source = join(bootstrapRoot, "source"), mirror = join(bootstrapRoot, "mirror.git");
  await safeEntry(bootstrapRoot, { directory: true, expectedUid, code: "bootstrap_source_metadata_refused" });
  await safeEntry(mirror, { directory: true, expectedUid, code: "bootstrap_source_metadata_refused" });
  const gitPath = absolute(runtime.gitPath ?? input.gitPath ?? "/usr/bin/git", "bootstrap_source_git_refused");
  const resolved = await git(gitPath, mirror, ["rev-parse", `${input.commit}^{commit}`]);
  if (resolved.stdout.trim() !== input.commit) refuse("bootstrap_source_commit_refused");
  const tree = parseTree((await git(gitPath, mirror, ["ls-tree", "-r", "-z", "--long", "--full-tree", input.commit])).stdout);
  const files = await walkSource(source, expectedUid);
  if (files.length !== tree.length) refuse("bootstrap_source_tree_refused");
  const expected = new Map(tree.map(item => [item.path, item]));
  for (const file of files) {
    const item = expected.get(file.path);
    if (!item || item.size !== file.size || (item.mode === "100755") !== ((file.mode & 0o111) !== 0)) {
      refuse("bootstrap_source_tree_refused");
    }
  }
  // One-file no-filter hashes keep parsing explicit, including odd but accepted
  // spaces in paths, without passing archive paths through a shell.
  for (const file of files) {
    const result = runtime.hashFile
      ? await runtime.hashFile({ gitPath, mirror, source, path: file.path })
      : await git(gitPath, mirror, ["hash-object", "--no-filters", join(source, file.path)]);
    if (result.stdout.trim() !== expected.get(file.path).oid) refuse("bootstrap_source_tree_refused");
  }
  const sourceDigest = sha256(Buffer.from(tree.map(item => `${item.mode} ${item.oid} ${item.size}\t${item.path}\0`).join("")));
  return Object.freeze({ treeEntries: tree.length, sourceDigest });
}

async function copyFileNoFollow(source, target, mode, expectedUid) {
  await safeEntry(source, { directory: false, expectedUid, code: "seed_updater_source_refused" });
  const input = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat();
    output = await open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode);
    const bytes = await input.readFile();
    const after = await input.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) refuse("seed_updater_source_refused");
    await output.writeFile(bytes); await output.chmod(mode); await output.sync();
  } finally { await input.close(); await output?.close(); }
  await lchown(target, expectedUid, expectedUid === 0 ? 0 : (process.getegid?.() ?? 0));
}

async function copyPolicyTree(source, target, expectedUid) {
  await safeEntry(source, { directory: true, expectedUid, code: "seed_updater_source_refused" });
  await mkdir(target, { mode: 0o700 });
  for (const name of (await readdir(source)).sort()) {
    const from = join(source, name), to = join(target, name), entry = await lstat(from);
    if (entry.isSymbolicLink()) refuse("seed_updater_source_refused");
    if (entry.isDirectory()) await copyPolicyTree(from, to, expectedUid);
    else if (entry.isFile() && entry.nlink === 1) await copyFileNoFollow(from, to, 0o400, expectedUid);
    else refuse("seed_updater_source_refused");
  }
  await chmod(target, 0o555);
}

async function copyDirectoryNoFollow(source, target, expectedUid) {
  const sourceEntry = await safeEntry(source, { directory: true, expectedUid, code: "bootstrap_adoption_refused" });
  await mkdir(target, { mode: sourceEntry.mode & 0o777 });
  for (const name of (await readdir(source)).sort()) {
    const from = join(source, name), to = join(target, name), entry = await lstat(from);
    if (entry.isSymbolicLink() || entry.uid !== expectedUid) refuse("bootstrap_adoption_refused");
    if (entry.isDirectory()) await copyDirectoryNoFollow(from, to, expectedUid);
    else if (entry.isFile() && entry.nlink === 1) await copyFileNoFollow(from, to, entry.mode & 0o777, expectedUid);
    else refuse("bootstrap_adoption_refused");
  }
  await chmod(target, sourceEntry.mode & 0o777);
  await lchown(target, expectedUid, expectedUid === 0 ? 0 : (process.getegid?.() ?? 0));
}

async function adoptAcrossVolumes(source, target, { directory, expectedUid, transactionId, move = rename }) {
  try { await move(source, target); return; } catch (error) { if (error?.code !== "EXDEV") throw error; }
  const staging = `${target}.adopting-${transactionId}`;
  await rm(staging, { recursive: true, force: true });
  try {
    if (directory) await copyDirectoryNoFollow(source, staging, expectedUid);
    else {
      const entry = await safeEntry(source, { directory: false, expectedUid, code: "bootstrap_adoption_refused" });
      await copyFileNoFollow(source, staging, entry.mode & 0o777, expectedUid);
    }
    await rename(staging, target);
    await rm(source, { recursive: directory, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function sourceConfiguration(remoteUrl, allowFileRemote = false) {
  let url;
  try { url = new URL(remoteUrl); } catch { refuse("bootstrap_adoption_refused"); }
  const github = url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname === "github.com"
    && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(url.pathname);
  const localFixture = allowFileRemote && url.protocol === "file:" && url.username === "" && url.password === "";
  if (!github && !localFixture) refuse("bootstrap_adoption_refused");
  return Object.freeze({ schema: SOURCE_CONFIG, remoteUrl });
}

async function writeSourceConfiguration(path, configuration, expectedUid) {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
    .catch(() => refuse("bootstrap_adoption_refused"));
  try { await handle.writeFile(`${JSON.stringify(configuration)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await lchown(path, expectedUid, expectedUid === 0 ? 0 : (process.getegid?.() ?? 0)); await chmod(path, 0o600);
}

async function digestTree(root) {
  const rows = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), entry = await lstat(path), local = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) { rows.push(`d ${entry.mode & 0o777} ${local}\n`); await visit(path); }
      else rows.push(`f ${entry.mode & 0o777} ${sha256(await readFile(path))} ${local}\n`);
    }
  }
  await visit(root); return sha256(Buffer.from(rows.join("")));
}

/** Copies only the dependency-free builder entry points and policy into the seed. */
export async function seedUpdaterV1(input, runtime = {}) {
  const root = absolute(input?.root, "seed_updater_refused"), bootstrapRoot = absolute(input?.bootstrapRoot, "seed_updater_refused");
  if (!COMMIT.test(input?.commit ?? "") || !TRANSACTION.test(input?.transactionId ?? "")) refuse("seed_updater_refused");
  const expectedUid = runtime.expectedUid ?? 0, source = join(bootstrapRoot, "source");
  const directory = join(root, "updater", `seed-${input.commit.slice(0, 12)}`);
  const exists = await lstat(directory).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error));
  if (exists) await rename(directory, `${directory}.rolled-back-${input.transactionId}`);
  await mkdir(join(directory, "bin"), { recursive: true, mode: 0o700 });
  for (const [from, to, mode] of SEED_FILES) await copyFileNoFollow(join(source, from), join(directory, to), mode, expectedUid);
  await copyPolicyTree(join(source, "src/updater/v1/policy"), join(directory, "policy"), expectedUid);
  await chmod(join(directory, "bin"), 0o555); await chmod(directory, 0o555);
  await lchown(join(directory, "bin"), expectedUid, expectedUid === 0 ? 0 : (process.getegid?.() ?? 0));
  await lchown(directory, expectedUid, expectedUid === 0 ? 0 : (process.getegid?.() ?? 0));
  return Object.freeze({ dir: directory, digest: await digestTree(directory) });
}

/** Adopts stage B state without making a failed prior adoption block the next run. */
export async function adoptBootstrapV1(input, runtime = {}) {
  const root = absolute(input?.root, "bootstrap_adoption_refused"), bootstrapRoot = absolute(input?.bootstrapRoot, "bootstrap_adoption_refused");
  if (!TRANSACTION.test(input?.transactionId ?? "")) refuse("bootstrap_adoption_refused");
  const expectedUid = runtime.expectedUid ?? 0, state = join(root, "updater-state");
  const configuration = sourceConfiguration(input.remoteUrl, runtime.allowFileRemote === true);
  const fromMirror = join(bootstrapRoot, "mirror.git"), fromToken = join(bootstrapRoot, "github-read.token");
  await safeEntry(fromMirror, { directory: true, expectedUid, code: "bootstrap_adoption_refused" });
  const tokenEntry = await safeEntry(fromToken, { directory: false, expectedUid, code: "bootstrap_adoption_refused" });
  if ((tokenEntry.mode & 0o777) !== 0o600 || !TOKEN.test((await readFile(fromToken, "utf8")).replace(/\n$/u, ""))) {
    refuse("bootstrap_adoption_refused");
  }
  const mirror = join(state, "mirror.git"), token = join(state, "github-read.token"), sourceConfig = join(state, "source.json");
  const movedAside = [];
  for (const [current, name] of [[mirror, "mirror"], [token, "github-read.token"], [sourceConfig, "source.json"]]) {
    if (await lstat(current).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error))) {
      const backup = join(state, `.${name}-${input.transactionId}`); await rename(current, backup); movedAside.push(backup);
    }
  }
  try {
    await adoptAcrossVolumes(fromMirror, mirror, { directory: true, expectedUid, transactionId: input.transactionId,
      move: runtime.rename ?? rename });
    await adoptAcrossVolumes(fromToken, token, { directory: false, expectedUid, transactionId: input.transactionId,
      move: runtime.rename ?? rename });
    await chmod(token, 0o600); await writeSourceConfiguration(sourceConfig, configuration, expectedUid);
  } catch (error) {
    await rm(mirror, { recursive: true, force: true }).catch(() => {}); await rm(token, { force: true }).catch(() => {});
    await rm(sourceConfig, { force: true }).catch(() => {}); throw error;
  }
  const retained = [];
  for (const path of movedAside) {
    if (path.includes(".github-read.token-") || path.includes(".source.json-")) await rm(path, { force: true });
    else retained.push(path);
  }
  return Object.freeze({ mirror: true, token: true, source: true, movedAside: Object.freeze(retained) });
}

async function verifyBundle(directory, expectedDigest) {
  const manifestPath = join(directory, "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest?.schema !== "control-room.updater-bundle-manifest/v1" || !Array.isArray(manifest.files)
      || manifest.files.length < 1 || manifest.files.length > 10_000) refuse("updater_bundle_manifest_refused");
  const declared = new Set();
  for (const item of manifest.files) {
    const profileMode = /^policy\/service-[a-z-]+\.sb$/u.test(item?.path ?? "");
    if (!item || typeof item.path !== "string" || item.path.startsWith("/") || item.path.split("/").some(part => !part || part === "." || part === "..")
        || !DIGEST.test(item.sha256) || item.type !== "file"
        || ![0o400, 0o500, ...(profileMode ? [0o440] : []), ...(item.path === "service-output.mjs" ? [0o555] : [])].includes(item.mode) || declared.has(item.path)) {
      refuse("updater_bundle_manifest_refused");
    }
    declared.add(item.path);
    let path = directory;
    for (const part of item.path.split("/")) {
      path = join(path, part); const entry = await lstat(path).catch(() => refuse("updater_bundle_manifest_refused"));
      if (entry.isSymbolicLink()) refuse("updater_bundle_manifest_refused");
    }
    const entry = await lstat(path);
    if (!entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o777) !== item.mode || sha256(await readFile(path)) !== item.sha256) {
      refuse("updater_bundle_digest_refused");
    }
  }
  const actual = [];
  async function visit(current) {
    for (const name of (await readdir(current)).sort()) {
      if (current === directory && name === "manifest.json") continue;
      const path = join(current, name), entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) refuse("updater_bundle_manifest_refused");
      if (entry.isDirectory()) await visit(path); else actual.push(relative(directory, path).split(sep).join("/"));
    }
  }
  await visit(directory);
  if (actual.length !== declared.size || actual.some(path => !declared.has(path))) refuse("updater_bundle_manifest_refused");
  const digest = sha256(Buffer.from(JSON.stringify(manifest)));
  if (digest !== expectedDigest) refuse("updater_bundle_digest_refused");
  return digest;
}

/** Verifies the confirmed bundle again immediately before importing stage 1. */
export async function loadInstallStepsV1(input, runtime = {}) {
  const updaterTarget = absolute(input?.updaterTarget, "install_steps_refused");
  if (!DIGEST.test(input?.expectedDigest ?? "")) refuse("install_steps_refused");
  const expectedUid = runtime.expectedUid ?? 0;
  const digest = await (runtime.verifyBundle ?? verifyBundle)(updaterTarget, input.expectedDigest);
  const modulePath = join(updaterTarget, "lib/install-steps.mjs");
  if (!inside(updaterTarget, modulePath)) refuse("install_steps_refused");
  const inspectEntry = runtime.lstat ?? lstat;
  const versionEntry = await inspectEntry(updaterTarget).catch(() => refuse("install_steps_refused"));
  if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink() || versionEntry.uid !== expectedUid
    || (versionEntry.mode & 0o022) !== 0) refuse("install_steps_refused");
  let current = updaterTarget;
  for (const part of ["lib", "install-steps.mjs"]) {
    current = join(current, part);
    const entry = await inspectEntry(current).catch(() => refuse("install_steps_refused"));
    if (entry.isSymbolicLink() || entry.uid !== expectedUid || (entry.mode & 0o022) !== 0
        || part === "lib" && !entry.isDirectory() || part !== "lib" && (!entry.isFile() || entry.nlink !== 1)) {
      refuse("install_steps_refused");
    }
  }
  const module = await import(`${pathToFileURL(modulePath).href}?digest=${digest.slice(7)}`);
  if (typeof module.continueInstallV1 !== "function" || typeof module.createStageOnePortsV1 !== "function") {
    refuse("install_steps_refused");
  }
  return Object.freeze({ module: "lib/install-steps.mjs", bundleDigest: digest,
    continueInstallV1: module.continueInstallV1, createStageOnePortsV1: module.createStageOnePortsV1 });
}

export async function removeAdoptedBootstrapV1(root) {
  await rm(join(root, "updater-state", "mirror.git"), { recursive: true, force: true });
  await rm(join(root, "updater-state", "github-read.token"), { force: true });
  await rm(join(root, "updater-state", "source.json"), { force: true });
}
