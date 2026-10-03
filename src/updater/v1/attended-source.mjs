import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, lchown, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildTrustedEnvironment, trustedToolEnvironment, verifyTrustedRuntimeInstallation,
} from "./trusted-runtime.mjs";
import { directoryCustodyV1, removeOwnedFileV1 } from "../../installer/shared/file-custody.mjs";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { verifyBundleManifestV1 } from "./attended-flip.mjs";
import { updaterRefuseV1 } from "./contracts.mjs";

import { signAttendedConnectorReleaseV1 } from "./install/connector-release.mjs";
import { captureReleaseTrustV1 } from "../../../scripts/release-signing.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const RELEASE_ID = /^[A-Za-z0-9._-]{1,80}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const MAX_TREE_FILES = 100_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TREE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_FILES = 25_000;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const BUILD_MANIFEST = "control-room.attended-build-manifest/v1";
const SOURCE_CONFIG = "control-room.attended-source/v1";
const MAIN_REF = "refs/heads/control-room-attended-main";
const BUILDER_ACCOUNT = /^_[a-z][a-z0-9_-]{0,30}$/u;
const FIXED_BUNDLE_INPUTS = Object.freeze([
  "src/updater/v1",
  "scripts/updater/build-fixed-updater-bundle.mjs",
  "scripts/release-signing.mjs",
  // The ONE file the fixed-bundle builder crosses in from outside `src/updater/v1`,
  // and it has to be STAGED or the builder cannot read it.
  //
  // `pg/init-database.mjs` imports `../../../pg-runtime/v1/pg-cluster-layout.ts`. The
  // builder's workspace is a copy of `src/updater/v1` alone, so that relative path
  // climbs out of the workspace to a file that is not there; the builder reads it from
  // the SOURCE tree by path and places it beside the workspace.
  //
  // MEASURED: with the two database-phase entries in `policy/bundle.json` and this
  // staging line missing, `the default tools path completes with generated outputs and
  // simulated separate root and builder identities` failed with a bare
  // `Command failed: ... build-fixed-bundle.mjs ... ENOENT` - no path, because the
  // builder's `copyFile` names the staged source and that staged source did not exist.
  //
  // It is a named file on purpose: the bundle's trust rule is that its inputs are a
  // reviewed set, and two enumerated exceptions are reviewable together while a
  // directory is not.
  "src/pg-runtime/v1/pg-cluster-layout.ts",
  // The shared entry guard, staged for the same reason as the layout above: the
  // builder reads it from the SOURCE tree by path
  // (`join(source, "src/installer/shared/is-main-module.mjs")`) and places it
  // beside the workspace, because every bundled entry imports it and the
  // workspace is a copy of `src/updater/v1` alone.
  //
  // MEASURED: with the three entries importing it and this staging line
  // missing, `the fixed step builds updater and CLI from source with pinned
  // arguments` failed with `Could not resolve
  // "../../installer/shared/is-main-module.mjs"` — a BUILD failure rather than a
  // runtime one, which is the direction that matters.
  //
  // It is the second enumerated exception for the same reason the first is: the
  // bundle's trust rule is that its inputs are a REVIEWED set, and a list of
  // named files is reviewable in one place where a directory is not.
  "src/installer/shared/is-main-module.mjs",
  "src/installer/shared/strict-json.mjs",
  "src/installer/shared/rehearsal-hostname.mjs",
  "src/installer/shared/file-custody.mjs",
  "src/installer/shared/private-process-lock.mjs",
  // The nightly backup's RECENCY READER, staged for the same reason as the layout
  // above and on the same trust rule: it is a named file, and it is the only
  // `installer/v1` module the fixed bundle may carry.
  //
  // `updater.mjs` reaches `../../installer/v1/nightly-backup-recency.ts` to answer
  // R5B-01's owner-visible question ("how old is the newest good backup"). The
  // builder's workspace is a copy of `src/updater/v1` alone, so that relative path
  // climbs out to a file that is not there; the builder reads it from the SOURCE
  // tree by path and places it where the import actually lands.
  //
  // MEASURED: with this staging line missing, the bundle build refused with
  // esbuild `Could not resolve "../../installer/v1/nightly-backup-recency.ts"` —
  // a BUILD failure, so `buildFixedUpdaterBundleV1` could produce no self-update
  // bundle at all and the owner's updater could never ship R5B-01 or R5B-02.
  //
  // WHY NOT ITS NEIGHBOUR `nightly-backup.ts`, which `backup_now` used to import.
  // That module imports `./nightly-backup-configuration`, which imports
  // `deploy/postgres/migration-ledger.json` — RELEASE DATA. Staging it would put
  // the migration ledger inside the trusted component, which is the exact thing
  // `src/updater/v1/pg/apply-release-schema.mjs` documents as forbidden. So the
  // reader crosses in and `backup_now` SPAWNS the already-built
  // `dist-vps/server/nightlyBackup.js` the launchd service runs.
  "src/installer/v1/nightly-backup-recency.ts",
  "src/installer/shared/jsonl-prefix.mjs",
]);

const refuse = code => { throw updaterRefuseV1(code); };
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inside = (parent, child) => {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};
const canonical = value => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  refuse("updater_plan_json_refused");
};
const safeRelative = (value, code) => {
  if (typeof value !== "string" || value.length < 1 || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || value.endsWith("/") || value.split("/").some(part => part === "" || part === "." || part === "..")
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) refuse(code);
  return value;
};
const shellQuote = value => `'${value.replaceAll("'", `'"'"'`)}'`;

async function statRegular(path, code, { uid, mode, maximum = 64 * 1024 } = {}) {
  const entry = await lstat(path).catch(() => refuse(code));
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > maximum
    || uid !== undefined && entry.uid !== uid || mode !== undefined && (entry.mode & 0o777) !== mode) refuse(code);
  return entry;
}

async function readSourceConfiguration(root, input) {
  if (input.remoteUrl) return { remoteUrl: input.remoteUrl };
  const value = JSON.parse(await readFileNoFollowV1(root, "updater-state/source.json", { maxBytes: 4096 }));
  if (value?.schema !== SOURCE_CONFIG || Object.keys(value).sort().join(",") !== "remoteUrl,schema")
    refuse("updater_source_config_refused");
  return value;
}

function remoteArguments(remoteUrl, allowFileRemote) {
  let url;
  try { url = new URL(remoteUrl); } catch { refuse("updater_remote_refused"); }
  if (url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname === "github.com"
    && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(url.pathname)) return [];
  if (allowFileRemote && url.protocol === "file:" && url.username === "" && url.password === "")
    return ["-c", "protocol.file.allow=always"];
  refuse("updater_remote_refused");
}

async function commandResult(file, args, options = {}) {
  await options.onSpawn?.({ file, args: [...args], cwd: options.cwd, env: { ...options.env }, uid: options.uid, gid: options.gid });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, uid: options.uid, gid: options.gid,
      detached: options.detached === true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, settled = false, timer;
    const finish = (action, value) => { if (settled) return; settled = true; clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort); action(value); };
    const append = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 4 * 1024 * 1024)) {
        killGroup(child.pid); finish(reject, updaterRefuseV1("updater_command_output_refused")); return target;
      }
      return target + chunk.toString("utf8");
    };
    const killGroup = pid => { if (!pid) return; try { process.kill(options.detached ? -pid : pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    } };
    const abort = () => { killGroup(child.pid); finish(reject, updaterRefuseV1("updater_attended_stopped")); };
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { killGroup(child.pid); finish(reject, updaterRefuseV1("updater_command_timeout")); },
      options.timeoutMs ?? 10 * 60 * 1000);
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", error => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (options.detached) killGroup(child.pid);
      const result = { stdout, stderr, pid: child.pid, code };
      if (code === 0 || options.acceptExitCodes?.includes(code)) finish(resolvePromise, result);
      else finish(reject, Object.assign(new Error(`updater_command_failed:${code ?? signal}`),
        { code: "updater_command_failed", stdout, stderr, exitCode: code }));
    });
  });
}

async function run(input, file, args, options = {}) {
  return (input.commandRunner ?? commandResult)(file, args, { ...options, signal: input.signal, onSpawn: input.onSpawn });
}

async function acquireLock(root) {
  const path = join(root, "updater-state/attended-install.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(`${process.pid}\n`); await handle.sync(); await handle.close();
      return async () => rm(path, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const entry = await statRegular(path, "updater_attended_lock_refused", { maximum: 32 });
      if ((entry.mode & 0o077) !== 0) refuse("updater_attended_lock_refused");
      const pid = Number((await readFile(path, "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid < 1) refuse("updater_attended_lock_refused");
      try { process.kill(pid, 0); refuse("updater_attended_busy"); }
      catch (processError) { if (processError?.code !== "ESRCH") throw processError; }
      await rm(path);
    }
  }
  refuse("updater_attended_busy");
}

async function git(input, gitPath, mirror, args, options = {}) {
  const env = trustedToolEnvironment("git");
  return run(input, gitPath, ["--git-dir", mirror, ...args], { env, timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
    cwd: options.cwd });
}

function parseTree(text, limits) {
  const rows = text.split("\0").filter(Boolean), entries = [];
  let totalBytes = 0;
  if (rows.length > limits.maxTreeFiles) refuse("updater_source_too_large");
  for (const row of rows) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(row);
    if (!match) refuse("updater_tree_refused");
    const path = safeRelative(match[4], "updater_tree_path_refused"), parts = path.split("/");
    if (parts.includes(".git")) refuse("updater_tree_dot_git_refused");
    if (parts.includes("node_modules")) refuse("updater_tree_node_modules_refused");
    if (match[1] === "120000") refuse("updater_tree_symlink_refused");
    if (match[1] === "160000" || match[2] !== "blob") refuse("updater_tree_gitlink_refused");
    entries.push({ mode: match[1], oid: match[3], path });
  }
  return { entries, addSize(size) { if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxTreeFileBytes)
    refuse("updater_source_too_large"); totalBytes += size; if (totalBytes > limits.maxTreeBytes) refuse("updater_source_too_large"); },
  total: () => totalBytes };
}

export function parseAttendedTreeV1(text, limits = {}) {
  return parseTree(text, { maxTreeFiles: limits.maxTreeFiles ?? MAX_TREE_FILES,
    maxTreeBytes: limits.maxTreeBytes ?? MAX_TREE_BYTES, maxTreeFileBytes: limits.maxTreeFileBytes ?? MAX_TREE_FILE_BYTES });
}

async function readTree(input, gitPath, mirror, commit, limits) {
  const listing = await git(input, gitPath, mirror, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const parsed = parseTree(listing.stdout, limits);
  for (const entry of parsed.entries) {
    const result = await git(input, gitPath, mirror, ["cat-file", "-s", entry.oid]);
    if (!/^\d+\n?$/u.test(result.stdout)) refuse("updater_tree_refused");
    entry.size = Number(result.stdout.trim()); parsed.addSize(entry.size);
  }
  return { entries: parsed.entries, bytes: parsed.total() };
}

async function walkExtracted(root) {
  const files = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), entry = await lstat(path), local = relative(root, path).split(sep).join("/");
      safeRelative(local, "updater_archive_path_refused");
      if (entry.isSymbolicLink()) refuse("updater_archive_symlink_refused");
      if (entry.isDirectory()) await visit(path);
      else if (!entry.isFile() || entry.nlink !== 1) refuse(entry.isFile() ? "updater_archive_hardlink_refused" : "updater_archive_entry_refused");
      else files.push({ path: local, entry });
    }
  }
  await visit(root); return files;
}

async function compareArchive(input, gitPath, source, tree) {
  const files = await walkExtracted(source);
  if (files.length !== tree.entries.length) refuse("updater_archive_tree_mismatch");
  const expected = new Map(tree.entries.map(entry => [entry.path, entry]));
  for (const file of files) {
    const item = expected.get(file.path);
    if (!item || file.entry.size !== item.size || (item.mode === "100755") !== ((file.entry.mode & 0o111) !== 0))
      refuse("updater_archive_tree_mismatch");
  }
  const paths = `${files.map(file => file.path).join("\n")}\n`;
  await input.onSpawn?.({ file: gitPath, args: ["hash-object", "--no-filters", "--stdin-paths"],
    env: { ...trustedToolEnvironment("git") } });
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(gitPath, ["hash-object", "--no-filters", "--stdin-paths"], { cwd: source,
      env: trustedToolEnvironment("git"), shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error("updater_hash_failed")));
    child.stdin.end(paths);
  });
  const hashes = result.stdout.trim().split("\n");
  if (hashes.length !== files.length || files.some((file, index) => hashes[index] !== expected.get(file.path).oid))
    refuse("updater_archive_tree_mismatch");
  return files.length;
}

async function compareArchivedSource(input, gitPath, source, tree) {
  const files = [];
  for (const item of tree.entries) {
    let path = source;
    const parts = item.path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      path = join(path, parts[index]);
      const entry = await lstat(path).catch(() => refuse("updater_archive_tree_mismatch"));
      if (entry.isSymbolicLink()) refuse("updater_archive_symlink_refused");
      if (index < parts.length - 1) {
        if (!entry.isDirectory()) refuse("updater_archive_tree_mismatch");
      } else {
        if (!entry.isFile() || entry.nlink !== 1) refuse(entry.isFile()
          ? "updater_archive_hardlink_refused" : "updater_archive_tree_mismatch");
        if (entry.size !== item.size || (item.mode === "100755") !== ((entry.mode & 0o111) !== 0))
          refuse("updater_archive_tree_mismatch");
        files.push({ path: item.path, entry });
      }
    }
  }
  const paths = `${files.map(file => file.path).join("\n")}\n`;
  await input.onSpawn?.({ file: gitPath, args: ["hash-object", "--no-filters", "--stdin-paths"],
    env: { ...trustedToolEnvironment("git") } });
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(gitPath, ["hash-object", "--no-filters", "--stdin-paths"], { cwd: source,
      env: trustedToolEnvironment("git"), shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error("updater_hash_failed")));
    child.stdin.end(paths);
  });
  const expected = new Map(tree.entries.map(entry => [entry.path, entry]));
  const hashes = result.stdout.trim().split("\n");
  if (hashes.length !== files.length || files.some((file, index) => hashes[index] !== expected.get(file.path).oid))
    refuse("updater_archive_tree_mismatch");
}

async function chownTree(path, uid, gid) {
  const entry = await lstat(path);
  if (entry.isDirectory()) for (const name of await readdir(path)) await chownTree(join(path, name), uid, gid);
  await lchown(path, uid, gid);
}

async function changeOwnership(input, path, uid, gid) {
  await (input.changeOwnership ?? chownTree)(path, uid, gid);
  await input.hooks?.afterOwnershipChange?.({ path, uid, gid });
}

async function copyRootHeldInput(source, destination, ownership) {
  const entry = await lstat(source).catch(() => refuse("updater_bundle_input_refused"));
  if (entry.isSymbolicLink() || entry.uid !== ownership.rootUid || entry.gid !== ownership.rootGid)
    refuse("updater_bundle_input_refused");
  if (entry.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    for (const name of (await readdir(source)).sort())
      await copyRootHeldInput(join(source, name), join(destination, name), ownership);
    return;
  }
  if (!entry.isFile() || entry.nlink !== 1) refuse("updater_bundle_input_refused");
  const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== ownership.rootUid
      || opened.gid !== ownership.rootGid || opened.dev !== entry.dev || opened.ino !== entry.ino)
      refuse("updater_bundle_input_refused");
    const destinationHandle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0), (opened.mode & 0o111) === 0 ? 0o400 : 0o500);
    try { await destinationHandle.writeFile(await sourceHandle.readFile()); await destinationHandle.sync(); }
    finally { await destinationHandle.close(); }
  } finally { await sourceHandle.close(); }
}

async function stageFixedBundleInputs(source, destination, ownership) {
  await mkdir(destination, { mode: 0o700 });
  for (const local of FIXED_BUNDLE_INPUTS) {
    const target = join(destination, local);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyRootHeldInput(join(source, local), target, ownership);
  }
}

async function stageBuilderTools(tools, destination, ownership, names) {
  // Keep updater/current root-only. The builder receives per-phase copies of
  // only the reviewed program and policy it needs, inside the job scratch that
  // is transferred to the builder uid and returned to root before verification.
  await mkdir(join(destination, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(join(destination, "policy"), { recursive: true, mode: 0o700 });
  const destinations = {
    buildEntry: join(destination, "bin/build-attended-release.mjs"),
    bundleEntry: join(destination, "bin/build-fixed-bundle.mjs"),
    bundlePolicy: join(destination, "policy/bundle.json"),
  };
  const staged = {};
  for (const name of names) {
    const target = destinations[name];
    if (!target) refuse("updater_tool_root_refused");
    await copyRootHeldInput(tools[name], target, ownership); staged[name] = target;
  }
  return Object.freeze({ ...tools, ...staged });
}

function allowedOutputPath(path) {
  return ["LICENSE", "NOTICE", "THIRD_PARTY.md", "package.json", "pnpm-lock.yaml"].includes(path)
    || ["dist-vps/", "db/", "deploy/", "scripts/", "src/installer/", "third_party/"].some(prefix => path.startsWith(prefix));
}

export async function verifyAttendedBuildOutputV1(output, { commit, maximumFiles = MAX_OUTPUT_FILES,
  maximumBytes = MAX_OUTPUT_BYTES } = {}) {
  const manifestPath = join(output, "RELEASE_MANIFEST.json");
  await statRegular(manifestPath, "updater_build_manifest_refused", { maximum: 16 * 1024 * 1024 });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest?.schema !== BUILD_MANIFEST || manifest.commit !== commit || !VERSION.test(manifest.version ?? "")
    || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > maximumFiles
    || manifest.fileCount !== manifest.files.length || !Number.isSafeInteger(manifest.byteCount) || manifest.byteCount < 0)
    refuse("updater_build_manifest_refused");
  const declared = new Map(); let bytes = 0;
  for (const item of manifest.files) {
    const path = safeRelative(item?.path, "updater_build_manifest_refused");
    if (!allowedOutputPath(path) || declared.has(path) || !/^sha256:[a-f0-9]{64}$/u.test(item.sha256 ?? "")
      || ![0o400, 0o500].includes(item.mode) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) refuse("updater_build_manifest_refused");
    bytes += item.bytes; if (bytes > maximumBytes) refuse("updater_build_output_too_large"); declared.set(path, item);
  }
  if (bytes !== manifest.byteCount) refuse("updater_build_manifest_refused");
  const actual = await walkExtracted(output), payload = actual.filter(item => item.path !== "RELEASE_MANIFEST.json");
  if (payload.length !== declared.size || payload.some(item => !declared.has(item.path))) refuse("updater_build_unmanifested_file");
  for (const file of payload) {
    const item = declared.get(file.path), content = await readFile(join(output, file.path));
    if (file.entry.size !== item.bytes || (file.entry.mode & 0o777) !== item.mode || sha256(content) !== item.sha256)
      refuse("updater_build_output_mismatch");
  }
  return { manifest, fileCount: payload.length, byteCount: bytes };
}

async function snapshotVerifiedTree(source, ownership) {
  const entries = new Map();
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), local = relative(source, path).split(sep).join("/");
      safeRelative(local, "updater_adoption_source_refused");
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || entry.uid !== ownership.rootUid || entry.gid !== ownership.rootGid)
        refuse("updater_adoption_source_refused");
      if (entry.isDirectory()) {
        entries.set(local, { type: "directory", mode: entry.mode & 0o777 });
        await visit(path);
      } else if (entry.isFile() && entry.nlink === 1) {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== ownership.rootUid
            || opened.gid !== ownership.rootGid || opened.dev !== entry.dev || opened.ino !== entry.ino)
            refuse("updater_adoption_source_refused");
          const bytes = await handle.readFile();
          entries.set(local, { type: "file", mode: opened.mode & 0o777, bytes: opened.size, sha256: sha256(bytes) });
        } finally { await handle.close(); }
      } else refuse("updater_adoption_source_refused");
    }
  }
  await visit(source);
  return entries;
}

async function copyVerifiedTree(source, destination, ownership, snapshot, modeForFile) {
  await mkdir(destination, { mode: 0o750 });
  async function visit(from, to) {
    for (const name of (await readdir(from)).sort()) {
      const sourcePath = join(from, name), targetPath = join(to, name), local = relative(source, sourcePath).split(sep).join("/");
      const expected = snapshot.get(local), entry = await lstat(sourcePath);
      if (!expected || entry.isSymbolicLink()) refuse("updater_adoption_source_refused");
      if (expected.type === "directory") {
        if (!entry.isDirectory() || (entry.mode & 0o777) !== expected.mode) refuse("updater_adoption_source_refused");
        await mkdir(targetPath, { mode: 0o750 }); await visit(sourcePath, targetPath); await chmod(targetPath, 0o550);
      } else {
        if (!entry.isFile() || entry.nlink !== 1) refuse("updater_adoption_source_refused");
        const sourceHandle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await sourceHandle.stat(), bytes = await sourceHandle.readFile();
          if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== ownership.rootUid
            || opened.gid !== ownership.rootGid || opened.dev !== entry.dev || opened.ino !== entry.ino
            || (opened.mode & 0o777) !== expected.mode || opened.size !== expected.bytes
            || sha256(bytes) !== expected.sha256) refuse("updater_adoption_source_refused");
          const targetMode = modeForFile(local, expected.mode);
          const targetHandle = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
            | (constants.O_NOFOLLOW ?? 0), targetMode);
          try { await targetHandle.writeFile(bytes); await targetHandle.sync(); } finally { await targetHandle.close(); }
          await chmod(targetPath, targetMode);
        } finally { await sourceHandle.close(); }
      }
      await lchown(targetPath, ownership.rootUid, ownership.serviceGid);
    }
  }
  await visit(source, destination);
  const copied = await snapshotVerifiedTree(source, ownership);
  if (copied.size !== snapshot.size || [...copied].some(([path, value]) => {
    const expected = snapshot.get(path);
    return !expected || value.type !== expected.type || value.mode !== expected.mode || value.bytes !== expected.bytes;
  }))
    refuse("updater_adoption_source_refused");
  await lchown(destination, ownership.rootUid, ownership.serviceGid); await chmod(destination, 0o550);
}

async function assertPointerLeaf(path) {
  await lstat(path).then(entry => { if (!entry.isSymbolicLink()) refuse("updater_release_pointer_refused"); },
    error => { if (error?.code !== "ENOENT") throw error; });
}

async function replaceLink(root, name, target) {
  const path = join(root, name), temporary = join(dirname(path), `.${name.split("/").at(-1)}.${process.pid}.${randomBytes(6).toString("hex")}`);
  const custody = await directoryCustodyV1(dirname(path));
  await assertPointerLeaf(path);
  await custody();
  await symlink(target, temporary);
  await custody();
  const owned = await lstat(temporary);
  try {
    await custody();
    await assertPointerLeaf(path);
    await rename(temporary, path);
  } finally {
    // Do not follow a substituted parent while cleaning a failed publication.
    await custody();
    await removeOwnedFileV1(temporary, owned);
  }
}

async function setLink(root, name, target) {
  if (target === null || target === undefined) {
    const path = join(root, name), custody = await directoryCustodyV1(dirname(path));
    await assertPointerLeaf(path);
    await custody();
    await rm(path, { force: true }); return;
  }
  await replaceLink(root, name, target);
}

async function restorePair(root, value) {
  const pointers = [["current", value.oldCurrent], ["previous", value.oldPrevious],
    ["updater/current", value.oldUpdaterCurrent], ["updater/previous", value.oldUpdaterPrevious]];
  const checks = [await directoryCustodyV1(root), await directoryCustodyV1(join(root, "updater"))];
  // Validate EVERY parent, leaf and target before the first pointer changes.
  for (const [name, target] of pointers) {
    await assertPointerLeaf(join(root, name));
    if (target !== null) checks.push(await directoryCustodyV1(join(dirname(join(root, name)), target)));
  }
  for (const [name, target] of pointers) {
    for (const check of checks) await check();
    await setLink(root, name, target);
  }
}

export function validateResolvedBuilderIdentityV1(identity) {
  if (!Number.isSafeInteger(identity.builderUid) || identity.builderUid < 1 || identity.builderUid === identity.rootUid
    || !BUILDER_ACCOUNT.test(identity.builderAccount)) refuse("updater_account_refused");
  return identity;
}

async function identities(input) {
  if (input.identities) return input.identities;
  const accounts = JSON.parse(await readFile(new URL("./policy/accounts.json", import.meta.url), "utf8"));
  if (accounts?.schema !== "control-room.accounts/v1") refuse("updater_accounts_policy_refused");
  const id = async (flag, name) => {
    const result = await run(input, "/usr/bin/id", [flag, name], { env: buildTrustedEnvironment(), timeoutMs: 10_000 });
    if (!/^\d+\n?$/u.test(result.stdout)) refuse("updater_account_refused"); return Number(result.stdout.trim());
  };
  const result = { rootUid: 0, rootGid: 0, builderUid: await id("-u", accounts.accounts.builder),
    builderGid: await id("-g", accounts.accounts.builder), serviceGid: await id("-g", accounts.accounts.service),
    builderAccount: accounts.accounts.builder };
  return validateResolvedBuilderIdentityV1(result);
}

async function verifyRuntimeBeforeUse(input, root) {
  const [manifestPolicy, initPolicy] = input.trustedRuntimePolicies ?? await Promise.all([
    new URL("./policy/runtime-inventory.json", import.meta.url), new URL("./policy/init-config.json", import.meta.url),
  ].map(async path => JSON.parse(await readFile(path, "utf8"))));
  const verifier = input.trustedRuntimeVerifier ?? verifyTrustedRuntimeInstallation;
  return verifier({ runtimeDirectory: join(root, "runtime"), manifestPolicy, initPolicy }, input.trustedRuntimeRuntime);
}

async function assertToolRoot(root, toolRoot, identity) {
  if (typeof toolRoot !== "string" || !isAbsolute(toolRoot) || resolve(toolRoot) !== toolRoot
    || !inside(join(root, "updater"), toolRoot)) refuse("updater_tool_root_refused");
  const [canonical, updaterRoot] = await Promise.all([realpath(toolRoot), realpath(join(root, "updater"))])
    .catch(() => refuse("updater_tool_root_refused"));
  if (!inside(updaterRoot, canonical)) refuse("updater_tool_root_refused");
  const link = await lstat(toolRoot).catch(() => refuse("updater_tool_root_refused"));
  if ((!link.isDirectory() && !link.isSymbolicLink()) || link.uid !== identity.rootUid || link.gid !== identity.rootGid)
    refuse("updater_tool_root_refused");
  const entry = await lstat(canonical).catch(() => refuse("updater_tool_root_refused"));
  if (!entry.isDirectory() || entry.uid !== identity.rootUid || entry.gid !== identity.rootGid
    || (entry.mode & 0o222) !== 0) refuse("updater_tool_root_refused");
  return canonical;
}

async function defaultTools(input, root, trustedRuntime, toolRoot, identity) {
  if (input.tools) return input.tools;
  const gitPath = trustedRuntime?.developerTools?.tools?.git;
  const pnpm = trustedRuntime?.tools?.pnpm?.executable, node = trustedRuntime?.tools?.node?.executable;
  if (![gitPath, pnpm, node].every(path => typeof path === "string" && isAbsolute(path)))
    refuse("trusted_runtime_installation_invalid");
  const tools = { git: gitPath, tar: "/usr/bin/tar", pnpm, node,
    helper: join(toolRoot, "bin/git-credential-control-room"),
    buildEntry: join(toolRoot, "bin/build-attended-release.mjs"),
    bundleEntry: join(toolRoot, "bin/build-fixed-bundle.mjs"),
    bundlePolicy: join(toolRoot, "policy/bundle.json") };
  for (const path of [tools.helper, tools.buildEntry, tools.bundleEntry]) {
    const entry = await statRegular(path, "updater_tool_root_refused",
      { uid: identity.rootUid, mode: 0o500, maximum: 1024 * 1024 });
    if (entry.gid !== identity.rootGid) refuse("updater_tool_root_refused");
  }
  const policy = await statRegular(tools.bundlePolicy, "updater_tool_root_refused", { uid: identity.rootUid,
    maximum: 1024 * 1024 });
  if (policy.gid !== identity.rootGid || (policy.mode & 0o222) !== 0) refuse("updater_tool_root_refused");
  return tools;
}

export function parseBuilderPidsV1(text, builderUid) {
  const pids = [];
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) refuse("builder_left_process");
    const pid = Number(match[1]), uid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(uid) || uid < 0) refuse("builder_left_process");
    if (uid === builderUid) pids.push(pid);
  }
  return [...new Set(pids)];
}

function defaultBuilderProcessControl(input) {
  return Object.freeze({
    async listPids(builderUid) {
      const result = await run(input, "/bin/ps", ["-axo", "pid=,uid="],
        { env: buildTrustedEnvironment(), timeoutMs: 10_000 });
      return parseBuilderPidsV1(result.stdout, builderUid);
    },
    async hasScheduledEntries(builderAccount) {
      const cron = await run(input, "/usr/bin/crontab", ["-l", "-u", builderAccount],
        { env: buildTrustedEnvironment(), timeoutMs: 10_000, acceptExitCodes: [1] });
      if (cron.code === 1) {
        const escaped = builderAccount.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        if (cron.stdout.trim() !== "" || !new RegExp(`^(?:crontab:\\s*)?no crontab for ${escaped}\\s*$`, "iu")
          .test(cron.stderr.trim())) refuse("builder_left_process");
      } else if (cron.stdout.trim() !== "") return true;
      const at = await run(input, "/usr/bin/atq", [], { env: buildTrustedEnvironment(), timeoutMs: 10_000 });
      return at.stdout.split(/\r?\n/u).some(line => line.trim() !== ""
        && line.trim().split(/\s+/u).includes(builderAccount));
    },
    async killPid(pid) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") refuse("builder_left_process"); }
    },
  });
}

function builderProcessControl(input) {
  const value = input.builderProcessControl ?? defaultBuilderProcessControl(input);
  if (![value?.listPids, value?.hasScheduledEntries, value?.killPid].every(method => typeof method === "function"))
    refuse("builder_left_process");
  return value;
}

async function inspectBuilderState(control, identity) {
  const pids = await control.listPids(identity.builderUid);
  if (!Array.isArray(pids) || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1) || pids.length > 100_000)
    refuse("builder_left_process");
  const scheduled = await control.hasScheduledEntries(identity.builderAccount);
  if (typeof scheduled !== "boolean") refuse("builder_left_process");
  return { pids: [...new Set(pids)], scheduled };
}

async function assertBuilderIdle(control, identity) {
  const state = await inspectBuilderState(control, identity);
  if (state.pids.length > 0 || state.scheduled) refuse("builder_left_process");
}

async function killAndVerifyBuilder(control, identity) {
  const before = await inspectBuilderState(control, identity);
  for (const pid of before.pids) await control.killPid(pid);
  const after = await inspectBuilderState(control, identity);
  if (after.pids.length > 0 || after.scheduled) refuse("builder_left_process");
}

async function runBuilderStep(input, identity, step, cwd, env, timeoutMs) {
  return run(input, step.file, step.args, { cwd, env, uid: identity.builderUid, gid: identity.builderGid,
    detached: true, timeoutMs });
}

async function writePlan(root, plan) {
  const body = canonical(plan), digest = sha256(Buffer.from(body));
  await atomicWriteNoFollowV1(root, `updater-state/plans/${plan.planId}.json`, `${body}\n`);
  await atomicWriteNoFollowV1(root, "updater-state/open-confirmation.json", `${JSON.stringify({ planId: plan.planId, planDigest: digest })}\n`);
  return digest;
}

const attendedSessions = new Map();
const releaseSessions = new WeakMap();
const bundleSessions = new WeakMap();

function sessionForJob(job) {
  const session = attendedSessions.get(job);
  if (!session) refuse("updater_attended_session_refused");
  return session;
}

async function closeSession(session) {
  if (!session || session.closed) return;
  session.closed = true;
  let cleanupError;
  if (session.builderActive) {
    try { await killAndVerifyBuilder(session.control, session.identity); } catch (error) { cleanupError = error; }
  }
  attendedSessions.delete(session.job);
  await rm(session.job, { recursive: true, force: true }).catch(() => {});
  await session.unlock();
  if (cleanupError) throw cleanupError;
}

export async function abortAttendedV1(value) {
  const session = typeof value === "string" ? attendedSessions.get(value)
    : attendedSessions.get(value?.job) ?? releaseSessions.get(value) ?? bundleSessions.get(value);
  await closeSession(session);
}

export async function fetchVerifiedSourceV1(input) {
  const root = resolve(input.root), commit = input.commit;
  if (!COMMIT.test(commit ?? "")) refuse("updater_install_commit_refused");
  const selfUpdate = (await readFileNoFollowV1(root, "updater-state/self-update", { maxBytes: 16 })).trim();
  if (selfUpdate !== "Off") refuse("updater_install_requires_off");
  const unlock = await acquireLock(root), jobId = `job-${commit.slice(0, 12)}-${randomBytes(6).toString("hex")}`;
  const job = join(root, "build", jobId), source = join(job, "src"), output = join(job, "output"), store = join(job, "store");
  const session = { input, root, commit, unlock, job, source, output, store, builderActive: false, closed: false };
  try {
    const trustedRuntime = await verifyRuntimeBeforeUse(input, root);
    const identity = await identities(input);
    if (!BUILDER_ACCOUNT.test(identity.builderAccount ?? "") || !Number.isSafeInteger(identity.builderUid)
      || identity.builderUid < 1 || !Number.isSafeInteger(identity.builderGid) || identity.builderGid < 1)
      refuse("updater_account_refused");
    const control = builderProcessControl(input);
    await assertBuilderIdle(control, identity);
    const stalePrefix = `job-${commit.slice(0, 12)}-`;
    for (const name of await readdir(join(root, "build")).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error))) {
      if (name.startsWith(stalePrefix) && /^[A-Za-z0-9._-]{1,100}$/u.test(name)) {
        await rm(join(root, "build", name), { recursive: true, force: true });
      }
    }
    const requestedToolRoot = input.toolRoot ?? join(root, "updater/current");
    const toolRoot = input.toolRoot !== undefined || input.tools === undefined
      ? await assertToolRoot(root, requestedToolRoot, identity) : requestedToolRoot;
    let tools = await defaultTools(input, root, trustedRuntime, toolRoot, identity);
    const config = await readSourceConfiguration(root, input);
    const remotePolicy = remoteArguments(config.remoteUrl, input.allowFileRemote === true);
    const credential = input.credentialPath ?? join(root, "updater-state/github-read.token");
    await statRegular(credential, "updater_credential_refused", { uid: identity.rootUid, mode: 0o600, maximum: 16_384 });
    await statRegular(tools.helper, "updater_credential_helper_refused", { uid: identity.rootUid, mode: 0o500,
      maximum: 64 * 1024 });
    const mirror = join(root, "updater-state/mirror.git");
    await mkdir(mirror, { recursive: false, mode: 0o700 }).catch(error => { if (error?.code !== "EEXIST") throw error; });
    const mirrorEntry = await lstat(mirror); if (!mirrorEntry.isDirectory() || mirrorEntry.isSymbolicLink()) refuse("updater_mirror_refused");
    if (!(await lstat(join(mirror, "HEAD")).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error))))
      await run(input, tools.git, ["init", "--bare", mirror], { env: trustedToolEnvironment("git"), timeoutMs: 30_000 });
    const helper = `!${shellQuote(tools.helper)} ${shellQuote(credential)}`;
    const fetchArgs = [...remotePolicy, "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
      "-c", "transfer.fsckObjects=true", "-c", "core.hooksPath=/dev/null", "-c", `credential.helper=${helper}`,
      "fetch", "--force", "--no-tags", config.remoteUrl, `+refs/heads/main:${MAIN_REF}`];
    await git(input, tools.git, mirror, fetchArgs).catch(() => refuse("updater_fetch_refused"));
    const fetched = (await git(input, tools.git, mirror, ["rev-parse", `${MAIN_REF}^{commit}`])).stdout.trim();
    if (!COMMIT.test(fetched)) refuse("updater_main_ref_refused");
    await git(input, tools.git, mirror, ["cat-file", "-e", `${commit}^{commit}`]);
    await git(input, tools.git, mirror, ["merge-base", "--is-ancestor", commit, MAIN_REF])
      .catch(() => refuse("updater_commit_not_on_main"));
    const limits = { maxTreeFiles: input.maxTreeFiles ?? MAX_TREE_FILES, maxTreeBytes: input.maxTreeBytes ?? MAX_TREE_BYTES,
      maxTreeFileBytes: input.maxTreeFileBytes ?? MAX_TREE_FILE_BYTES };
    const tree = await readTree(input, tools.git, mirror, commit, limits);
    await mkdir(job, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
    const archive = join(job, "source.tar");
    await git(input, tools.git, mirror, ["archive", "--format=tar", `--output=${archive}`, commit], { timeoutMs: 120_000 });
    await run(input, tools.tar, ["-xf", archive, "-C", source], { env: buildTrustedEnvironment(), timeoutMs: 120_000 });
    await input.hooks?.afterArchive?.({ mirror, source, job, mainRef: MAIN_REF });
    const afterArchive = (await git(input, tools.git, mirror, ["rev-parse", `${MAIN_REF}^{commit}`])).stdout.trim();
    if (afterArchive !== fetched) refuse("updater_main_ref_moved");
    const sourceFileCount = await compareArchive(input, tools.git, source, tree);
    await rm(archive); await mkdir(output); await mkdir(store); await mkdir(join(job, "tmp"));
    if (input.tools === undefined) tools = await stageBuilderTools(tools, join(job, "builder-tools"),
      { rootUid: identity.rootUid, rootGid: identity.rootGid }, ["buildEntry"]);
    await changeOwnership(input, job, identity.builderUid, identity.builderGid);
    Object.assign(session, { trustedRuntime, identity, control, toolRoot, tools, mirror, tree, sourceFileCount });
    attendedSessions.set(job, session);
    return Object.freeze({ job, source, tree: Object.freeze({ entries: tree.entries.length, bytes: tree.bytes }), mainCommit: fetched });
  } catch (error) { await closeSession(session).catch(() => {}); throw error; }
}

export async function buildReleaseV1(input) {
  const session = sessionForJob(input.job), { source, output, store, identity, tools, control, commit } = session;
  const buildEnv = buildTrustedEnvironment({ PATH: `${dirname(tools.node)}:${dirname(tools.pnpm)}:/usr/bin:/bin`,
    HOME: "/var/empty", TMPDIR: join(session.job, "tmp"), NPM_CONFIG_USERCONFIG: "/dev/null",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null", CI: "1" },
  { explicitlySet: ["PATH", "HOME", "TMPDIR", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG"] });
  const fetchSteps = session.input.fetchSteps ?? [
    { file: tools.pnpm, args: ["fetch", "--ignore-scripts", "--frozen-lockfile", `--store-dir=${store}`] },
  ];
  session.builderActive = true;
  for (const step of fetchSteps) await runBuilderStep(session.input, identity, step, source, buildEnv,
    session.input.fetchTimeoutMs ?? 10 * 60 * 1000);
  const persistedTrust = await readFile(join(session.root, "Protected/config/release-trust.json"), "utf8")
    .catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (persistedTrust !== undefined) await statRegular(join(session.root, "Protected/config/release-trust.json"),
    "updater_release_trust_refused", { uid: identity.rootUid, mode: 0o640 });
  if (persistedTrust !== undefined && input.releaseTrust !== undefined
    && JSON.stringify(captureReleaseTrustV1(JSON.parse(persistedTrust))) !== JSON.stringify(captureReleaseTrustV1(input.releaseTrust)))
    refuse("updater_release_trust_refused");
  const trust = input.releaseTrust === undefined
    ? persistedTrust === undefined ? undefined : captureReleaseTrustV1(JSON.parse(persistedTrust))
    : captureReleaseTrustV1(input.releaseTrust);
  const buildSteps = session.input.buildSteps ?? [
    { file: tools.pnpm, args: ["install", "--offline", "--ignore-scripts", "--frozen-lockfile", `--store-dir=${store}`] },
    { file: tools.pnpm, args: ["run", "build"] },
    { file: tools.node, args: [tools.buildEntry, "--source", source, "--output", output, "--commit", commit,
      ...(trust ? ["--release-trust-json", JSON.stringify(trust)] : [])] },
  ];
  for (const step of buildSteps) await runBuilderStep(session.input, identity, step, source, buildEnv,
    session.input.buildTimeoutMs ?? 20 * 60 * 1000);
  await killAndVerifyBuilder(control, identity); session.builderActive = false;
  await changeOwnership(session.input, session.job, identity.rootUid, identity.rootGid); await chmod(session.job, 0o711);
  await session.input.hooks?.beforeCandidateFinalVerification?.();
  await compareArchivedSource(session.input, tools.git, source, session.tree);
  let built = await verifyAttendedBuildOutputV1(output, { commit, maximumFiles: session.input.maxOutputFiles,
    maximumBytes: session.input.maxOutputBytes });
  if (trust) {
    await signAttendedConnectorReleaseV1({ output, commit, trust,
      privateKeyPath: join(session.root, "updater-state/release-signing-key.pem") }, { expectedUid: identity.rootUid });
    built = await verifyAttendedBuildOutputV1(output, { commit, maximumFiles: session.input.maxOutputFiles,
      maximumBytes: session.input.maxOutputBytes });
  }
  const packageValue = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (packageValue?.name !== "control-room" || !VERSION.test(packageValue.version ?? "")) refuse("updater_release_version_refused");
  const releaseId = `${packageValue.version}-${commit.slice(0, 12)}`;
  if (!RELEASE_ID.test(releaseId)) refuse("updater_release_id_refused");
  session.releaseSnapshot = await snapshotVerifiedTree(output, { rootUid: identity.rootUid, rootGid: identity.rootGid });
  const manifestDigest = sha256(await readFile(join(output, "RELEASE_MANIFEST.json")));
  const result = Object.freeze({ output, releaseId, manifestDigest, fileCount: built.fileCount, byteCount: built.byteCount });
  session.releaseVersion = packageValue.version;
  session.release = result; releaseSessions.set(result, session); return result;
}

export async function buildFixedBundleV1(input) {
  const session = sessionForJob(input.job), { identity, source, control } = session;
  let { tools } = session;
  if (!session.release) refuse("updater_attended_session_refused");
  const bundleJob = join(session.job, "fixed-updater"), bundleSource = join(bundleJob, "source"),
    bundle = join(bundleJob, "bundle"), bundleStore = join(bundleJob, "store");
  await mkdir(bundleJob); await mkdir(bundleStore); await mkdir(join(bundleJob, "tmp"));
  await stageFixedBundleInputs(source, bundleSource, { rootUid: identity.rootUid, rootGid: identity.rootGid });
  if (session.input.tools === undefined) tools = await stageBuilderTools(tools, join(bundleJob, "builder-tools"),
    { rootUid: identity.rootUid, rootGid: identity.rootGid }, ["bundleEntry", "bundlePolicy"]);
  await changeOwnership(session.input, bundleJob, identity.builderUid, identity.builderGid);
  await session.input.hooks?.beforeFixedBundleBuild?.({ source: bundleSource, candidateSource: source, bundleJob });
  const bundleEnv = buildTrustedEnvironment({ PATH: `${dirname(tools.node)}:${dirname(tools.pnpm)}:/usr/bin:/bin`,
    HOME: "/var/empty", TMPDIR: join(bundleJob, "tmp"), NPM_CONFIG_USERCONFIG: "/dev/null",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null", CI: "1" },
  { explicitlySet: ["PATH", "HOME", "TMPDIR", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG"] });
  const bundleFetchStep = session.input.bundleFetchStep === undefined ? { file: tools.pnpm,
    args: ["fetch", "--ignore-scripts", "--frozen-lockfile", `--store-dir=${bundleStore}`],
    cwd: join(bundleSource, "src/updater/v1") } : session.input.bundleFetchStep;
  session.builderActive = true;
  if (bundleFetchStep !== null) await runBuilderStep(session.input, identity, bundleFetchStep,
    bundleFetchStep.cwd ?? bundleSource, bundleEnv, session.input.fetchTimeoutMs ?? 10 * 60 * 1000);
  const bundleStep = session.input.bundleStep ?? { file: tools.node, args: [tools.bundleEntry, "--source", bundleSource,
    "--policy", tools.bundlePolicy ?? join(session.toolRoot, "policy/bundle.json"), "--runtime", session.root,
    "--store", bundleStore, "--output", bundle] };
  await runBuilderStep(session.input, identity, bundleStep, bundleSource, bundleEnv,
    session.input.buildTimeoutMs ?? 20 * 60 * 1000);
  await killAndVerifyBuilder(control, identity); session.builderActive = false;
  await changeOwnership(session.input, bundleJob, identity.rootUid, identity.rootGid);
  await session.input.hooks?.beforeFinalVerification?.();
  const bundleManifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
  const bundleDigest = await verifyBundleManifestV1(bundle, bundleManifest);
  session.bundleSnapshot = await snapshotVerifiedTree(bundle, { rootUid: identity.rootUid, rootGid: identity.rootGid });
  await session.input.hooks?.afterFinalVerification?.();
  const result = Object.freeze({ bundle, uver: session.release.releaseId, bundleDigest });
  session.bundle = result; bundleSessions.set(result, session); return result;
}

export async function runningBundleDigestV1({ root }) {
  const current = join(resolve(root), "updater/current");
  const target = await realpath(current).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (target === null) return null;
  const updaterRoot = await realpath(join(resolve(root), "updater"));
  if (!inside(updaterRoot, target)) refuse("updater_bundle_digest_refused");
  const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
  return verifyBundleManifestV1(target, manifest);
}

// SemVer precedence, including prereleases. Release IDs append a commit and are
// not themselves version numbers, so compare the verified manifests instead.
export function compareReleaseVersionsV1(left, right) {
  if (!VERSION.test(left ?? "") || !VERSION.test(right ?? "")) refuse("updater_release_version_refused");
  const parts = value => { const split = value.indexOf("-"); return [
    (split < 0 ? value : value.slice(0, split)).split(".").map(BigInt),
    split < 0 ? null : value.slice(split + 1).split(".")]; };
  const [a, preA] = parts(left), [b, preB] = parts(right);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  if (preA === null || preB === null) return preA === preB ? 0 : preA === null ? 1 : -1;
  for (let i = 0; i < Math.max(preA.length, preB.length); i += 1) {
    if (preA[i] === undefined || preB[i] === undefined) return preA[i] === undefined ? -1 : 1;
    if (preA[i] === preB[i]) continue;
    const numericA = /^[0-9]+$/u.test(preA[i]), numericB = /^[0-9]+$/u.test(preB[i]);
    if (numericA && numericB) return BigInt(preA[i]) < BigInt(preB[i]) ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return preA[i] < preB[i] ? -1 : 1;
  }
  return 0;
}

async function installedReleaseForPlanV1(session) {
  const target = await readlink(join(session.root, "current")).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (target === null) return { releaseId: "not installed" };
  const releaseId = target.startsWith("releases/") ? target.slice(9) : "";
  if (!RELEASE_ID.test(releaseId)) refuse("updater_installed_release_refused");
  const manifest = JSON.parse(await readFileNoFollowV1(session.root, `${target}/RELEASE_MANIFEST.json`, { maxBytes: 16 * 1024 * 1024 }));
  if (!VERSION.test(manifest?.version ?? "") || !COMMIT.test(manifest?.commit ?? "")) refuse("updater_installed_release_refused");
  return { releaseId, version: manifest.version, commit: manifest.commit };
}

export async function confirmAttendedV1(input) {
  const session = releaseSessions.get(input.release) ?? bundleSessions.get(input.bundle);
  if (!session || session.release !== input.release || session.bundle !== input.bundle) refuse("updater_attended_session_refused");
  const classification = await classifyAttendedSourceV1(input);
  const { changedPaths, changesDatabase } = classification;
  const changesUpdater = typeof input.runningBundleDigest === "string"
    ? input.runningBundleDigest !== input.bundle.bundleDigest : true;
  const classes = ["code"];
  if (changesDatabase) classes.push("database");
  if (changesUpdater) classes.push("protected", "updater");
  const planId = `install-${session.commit.slice(0, 12)}-${randomBytes(4).toString("hex")}`;
  const from = await installedReleaseForPlanV1(session);
  let downgrade = from.version !== undefined && compareReleaseVersionsV1(session.releaseVersion, from.version) < 0;
  if (!downgrade && from.commit && from.commit !== session.commit) {
    // A same/newer version can still point to an older or divergent commit.
    // Missing ancestry proof is conservative: require explicit downgrade consent.
    try { await git(session.input, session.tools.git, session.mirror, ["merge-base", "--is-ancestor", from.commit, session.commit]); }
    catch { downgrade = true; }
  }
  const plan = { schema: "control-room.install-plan/v2", planId, kind: "updater", from,
    artifact: { releaseId: input.release.releaseId, commit: session.commit, sourceFileCount: session.sourceFileCount,
      outputFileCount: input.release.fileCount, outputByteCount: input.release.byteCount,
      updaterBundleDigest: input.bundle.bundleDigest,
      ...(input.inventoryDigest === undefined ? {} : { inventoryDigest: input.inventoryDigest }) }, classes,
    updaterDerived: { changesDatabase, changesUpdater, sandboxTestsRan: false, downgrade } };
  const planDigest = await writePlan(session.root, plan);
  const authorize = input.authorize ?? session.input.authorize;
  if (typeof authorize !== "function") refuse("updater_install_confirmation_required");
  await authorize({ plan, planDigest, terminal: input.terminal });
  const confirmation = await readFileNoFollowV1(session.root, `updater-state/confirmations/${planId}.json`, { maxBytes: 8192 })
    .then(text => JSON.parse(text), error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (confirmation?.confirmed !== true || confirmation.planId !== planId || confirmation.planDigest !== planDigest
      || downgrade && confirmation.downgradeConfirmed !== true)
    refuse("updater_install_confirmation_missing");
  session.plan = { plan, planDigest, changesDatabase, changesUpdater };
  return Object.freeze({ planId, planDigest });
}

/** Classifies the verified commit before the owner is asked to confirm it. */
export async function classifyAttendedSourceV1(input) {
  const session = releaseSessions.get(input?.release) ?? bundleSessions.get(input?.bundle)
    ?? attendedSessions.get(input?.job);
  if (!session || input?.release && session.release !== input.release || input?.bundle && session.bundle !== input.bundle) {
    refuse("updater_attended_session_refused");
  }
  const diff = await git(session.input, session.tools.git, session.mirror,
    ["diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "-r", "-z", session.commit]);
  const changedPaths = [...new Set(diff.stdout.split("\0").filter(Boolean)
    .map(path => safeRelative(path, "updater_tree_path_refused")))];
  return Object.freeze({ changedPaths: Object.freeze(changedPaths),
    changesDatabase: changedPaths.some(path => path.startsWith("db/")) });
}

export async function stageVerifiedTreeV1(session, source, snapshot, target, staging, serviceGid, modeForFile) {
  const directoryMode = snapshot.has("service-output.mjs") ? 0o551 : 0o550;
  const existing = await lstat(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== session.identity.rootUid
      || existing.gid !== serviceGid || (existing.mode & 0o777) !== directoryMode) refuse("updater_install_target_exists");
    const seen = new Set();
    async function verify(directory) {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name), local = relative(target, path).split(sep).join("/"), expected = snapshot.get(local);
        const entry = await lstat(path); seen.add(local);
        if (!expected || entry.isSymbolicLink() || entry.uid !== session.identity.rootUid || entry.gid !== serviceGid) {
          refuse("updater_install_target_exists");
        }
        if (expected.type === "directory") {
          if (!entry.isDirectory() || (entry.mode & 0o777) !== 0o550) refuse("updater_install_target_exists");
          await verify(path);
        } else {
          const bytes = entry.isFile() && entry.nlink === 1 ? await readFile(path) : null;
          if (!bytes || (entry.mode & 0o777) !== modeForFile(local, expected.mode)
            || entry.size !== expected.bytes || sha256(bytes) !== expected.sha256) refuse("updater_install_target_exists");
        }
      }
    }
    await verify(target);
    if (seen.size !== snapshot.size) refuse("updater_install_target_exists");
    return Object.freeze({ target });
  }
  try {
    await copyVerifiedTree(source, staging, { rootUid: session.identity.rootUid, rootGid: session.identity.rootGid,
      serviceGid }, snapshot, modeForFile);
    // The database login must search the bundle root to read the immutable collector.
    // Other files and all subdirectories retain their root/service-only modes.
    await chmod(staging, directoryMode);
    await rename(staging, target);
    await session.input.hooks?.afterStageRename?.(Object.freeze({ target, staging }));
    return Object.freeze({ target });
  } catch (error) { await rm(staging, { recursive: true, force: true }).catch(() => {}); throw error; }
}

export async function stageReleaseV1(input) {
  const session = releaseSessions.get(input.release);
  if (!session || input.release.releaseId !== input.releaseId) refuse("updater_attended_session_refused");
  return stageVerifiedTreeV1(session, input.release.output, session.releaseSnapshot,
    join(session.root, "releases", input.releaseId), join(session.root, "releases", `.staging-${input.releaseId}`),
    input.serviceGid, (_path, mode) => mode === 0o500 ? 0o550 : 0o440);
}

export async function stageUpdaterBundleV1(input) {
  const session = bundleSessions.get(input.bundle);
  if (!session || input.bundle.uver !== input.uver || input.bundle.bundleDigest !== input.expectedDigest)
    refuse("updater_bundle_digest_refused");
  return stageVerifiedTreeV1(session, input.bundle.bundle, session.bundleSnapshot,
    join(session.root, "updater", input.uver), join(session.root, "updater", `.staging-${input.uver}`),
    session.identity.serviceGid, (_path, mode) => mode);
}

export async function switchPairV1(input) {
  if (input?.restore) {
    const root = resolve(input.root), value = input.restore;
    if (!value || typeof value !== "object"
      || ![value.oldCurrent, value.oldPrevious].every(target => target === null
        || typeof target === "string" && /^releases\/[A-Za-z0-9._-]{1,80}$/u.test(target) && !["releases/.", "releases/.."].includes(target))
      || ![value.oldUpdaterCurrent, value.oldUpdaterPrevious].every(target => target === null
        || typeof target === "string" && RELEASE_ID.test(target) && ![".", ".."].includes(target))) refuse("updater_release_pointer_refused");
    await restorePair(root, value);
    return Object.freeze({ restored: true });
  }
  const session = releaseSessions.get(input.release);
  if (!session || input.releaseStage?.target !== join(session.root, "releases", input.release.releaseId)
    || input.updateUpdater !== (input.updaterStage !== null)
    || input.updateUpdater && input.updaterStage?.target !== join(session.root, "updater", input.bundle?.uver))
    refuse("updater_attended_session_refused");
  const releaseTarget = `releases/${input.release.releaseId}`, updaterTarget = input.bundle.uver;
  const currentPath = join(session.root, "current"), updaterCurrentPath = join(session.root, "updater/current");
  const readOld = path => lstat(path).then(entry => entry.isSymbolicLink() ? readlink(path)
    : refuse("updater_release_pointer_refused"), error => error?.code === "ENOENT" ? null : Promise.reject(error));
  const oldCurrent = await readOld(currentPath), oldPrevious = await readOld(join(session.root, "previous"));
  const oldUpdaterCurrent = await readOld(updaterCurrentPath), oldUpdaterPrevious = await readOld(join(session.root, "updater/previous"));
  try {
    if (input.fresh && oldCurrent === null) await replaceLink(session.root, "previous", releaseTarget);
    else if (oldCurrent !== null) await replaceLink(session.root, "previous", oldCurrent);
    await replaceLink(session.root, "current", releaseTarget);
    if (input.updateUpdater) {
      if (input.fresh && oldUpdaterCurrent === null) await replaceLink(session.root, "updater/previous", updaterTarget);
      else if (oldUpdaterCurrent !== null) await replaceLink(session.root, "updater/previous", oldUpdaterCurrent);
      await replaceLink(session.root, "updater/current", updaterTarget);
    }
    await closeSession(session);
  } catch (error) {
    for (const [name, target] of [["current", oldCurrent], ["previous", oldPrevious],
      ["updater/current", oldUpdaterCurrent], ["updater/previous", oldUpdaterPrevious]])
      await setLink(session.root, name, target).catch(() => {});
    throw error;
  }
  return Object.freeze({ oldCurrent, oldPrevious, oldUpdaterCurrent, oldUpdaterPrevious });
}

export async function installAttendedCommitV1(input) {
  let fetched, release, bundle, releaseStage, updaterStage;
  try {
    fetched = await fetchVerifiedSourceV1(input);
    release = await buildReleaseV1({ ...input, ...fetched });
    bundle = await buildFixedBundleV1({ ...input, ...fetched });
    const confirmed = await confirmAttendedV1({ root: input.root, commit: input.commit, release, bundle,
      runningBundleDigest: input.runningBundleDigest, inventoryDigest: input.inventoryDigest, terminal: input.terminal,
      authorize: input.authorize });
    const identity = sessionForJob(fetched.job).identity;
    releaseStage = await stageReleaseV1({ root: input.root, release, output: release.output,
      releaseId: release.releaseId, serviceGid: identity.serviceGid });
    updaterStage = await stageUpdaterBundleV1({ root: input.root, bundle, uver: bundle.uver,
      expectedDigest: bundle.bundleDigest });
    const sessionPlan = sessionForJob(fetched.job).plan;
    await switchPairV1({ root: input.root, release, bundle, releaseStage, updaterStage, fresh: false, updateUpdater: true });
    return Object.freeze({ commit: input.commit, releaseId: release.releaseId, ...confirmed,
      sourceFileCount: fetched.tree.entries, outputFileCount: release.fileCount,
      changesDatabase: sessionPlan.changesDatabase, changesUpdater: sessionPlan.changesUpdater,
      updaterBundleDigest: bundle.bundleDigest });
  } catch (error) {
    for (const target of [releaseStage?.target, updaterStage?.target].filter(Boolean))
      await rm(target, { recursive: true, force: true }).catch(() => {});
    if (fetched) await abortAttendedV1(fetched).catch(() => {});
    throw error;
  }
}

export const ATTENDED_SOURCE_SCHEMAS_V1 = Object.freeze({ buildManifest: BUILD_MANIFEST, sourceConfig: SOURCE_CONFIG });
