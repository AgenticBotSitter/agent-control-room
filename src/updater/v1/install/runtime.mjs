import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod, lchown, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateRuntimeInventoryV1, sha256File } from "../trusted-runtime.mjs";

const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C" });
const INPUT_KEYS = Object.freeze(["download", "fresh", "inventory", "root", "tools", "transactionId"]);
const INPUT_KEYS_WITH_SNAPSHOTS = Object.freeze([...INPUT_KEYS, "snapshots"]);
const TOOL_NAMES = Object.freeze(["node", "pnpm", "esbuild", "postgresql"]);
const TRANSACTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const RUNTIME_UNDO_SCHEMA = "control-room.runtime-vendor-undo/v1";
const RUNTIME_TREE = /^runtime\/(node|pnpm|esbuild|pg)-([0-9]+(?:\.[0-9]+){1,2})$/u;
const RUNTIME_LINK = /^runtime\/(node|pnpm|esbuild|pg)-(current|previous)$/u;
const RUNTIME_TARGET = /^(node|pnpm|esbuild|pg)-([0-9]+(?:\.[0-9]+){1,2})$/u;

const refuse = code => { const error = new Error(code); error.code = code; throw error; };
const plainRecord = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, expected) => plainRecord(value)
  && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
const inside = (root, path) => {
  const rest = relative(root, path);
  return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};
const absolute = value => typeof value === "string" && isAbsolute(value) && resolve(value) === value
  && !value.includes("\0") && value !== "/";

function validateInput(input) {
  const expected = input?.snapshots === undefined ? INPUT_KEYS : INPUT_KEYS_WITH_SNAPSHOTS;
  if (!exactKeys(input, expected) || !absolute(input.root) || typeof input.fresh !== "boolean"
    || !Array.isArray(input.tools) || input.tools.length < 1
    || input.tools.some(tool => !TOOL_NAMES.includes(tool)) || new Set(input.tools).size !== input.tools.length
    || !exactKeys(input.download, ["uid", "gid"])
    || ![input.download.uid, input.download.gid].every(value => Number.isSafeInteger(value) && value > 0)
    || typeof input.transactionId !== "string" || !TRANSACTION_ID.test(input.transactionId)
    || input.snapshots !== undefined && (!plainRecord(input.snapshots)
      || Object.keys(input.snapshots).some(tool => tool !== "node") || !absolute(input.snapshots.node))) {
    refuse("runtime_inventory_refused");
  }
  const inventory = validateRuntimeInventoryV1(input.inventory);
  return { input, inventory };
}

function run(file, args, options, runtime) {
  return new Promise((resolvePromise, reject) => {
    const launch = runtime.spawn ?? spawn;
    const child = launch(file, args, { ...options, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", bytes = 0, settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); action(value);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new Error("runtime_download_failed")); },
      runtime.downloadTimeoutMs ?? 30 * 60 * 1000);
    child.stderr?.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { child.kill("SIGKILL"); finish(reject, new Error("runtime_download_failed")); return; }
      stderr += chunk.toString("utf8");
    });
    child.once("error", () => finish(reject, new Error("runtime_download_failed")));
    child.once("close", (code, signal) => code === 0 && signal === null
      ? finish(resolvePromise, undefined) : finish(reject, new Error("runtime_download_failed")));
  });
}

async function downloadArchive(artifact, destination, identity, runtime) {
  const args = [...(runtime.curlArgumentsPrefix ?? []), "-q", "--proto", "=https", "--tlsv1.2", "--fail", "--silent", "--show-error", "--location",
    "--max-filesize", String(artifact.archiveBytes), "--output", destination, artifact.url];
  await runtime.observeDownloadSpawn?.({ file: runtime.curlPath ?? "/usr/bin/curl", args: [...args],
    uid: identity.uid, gid: identity.gid });
  await run(runtime.curlPath ?? "/usr/bin/curl", args, { env: SAFE_ENVIRONMENT, uid: identity.uid, gid: identity.gid }, runtime)
    .catch(() => refuse("runtime_download_failed"));
}

async function copyArchiveOnce(source, destination, expectedBytes) {
  const input = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(() => refuse("runtime_vendor_archive_invalid"));
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedBytes) refuse("runtime_vendor_archive_invalid");
    output = await open(destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
      .catch(() => refuse("runtime_vendor_archive_invalid"));
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead === 0) refuse("runtime_vendor_archive_invalid");
      await output.write(buffer, 0, bytesRead, position); position += bytesRead;
    }
    await output.sync();
    const after = await input.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) refuse("runtime_vendor_archive_invalid");
  } finally {
    await input.close(); await output?.close();
  }
}

async function assertSuppliedSnapshot(path, runtime) {
  const entry = await (runtime.lstat ?? lstat)(path).catch(() => refuse("runtime_vendor_archive_invalid"));
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) refuse("runtime_vendor_archive_invalid");
  if ((runtime.geteuid ?? process.geteuid)?.() === 0 && (entry.uid !== 0 || (entry.mode & 0o077) !== 0)) {
    refuse("runtime_vendor_archive_invalid");
  }
}

function command(file, args, runtime) {
  return new Promise((resolvePromise, reject) => {
    const launch = runtime.spawnCommand ?? spawn;
    const child = launch(file, args, { env: SAFE_ENVIRONMENT, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0, settled = false;
    const append = (target, chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("runtime_vendor_archive_invalid")); }
      return target + chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", () => { if (!settled) { settled = true; reject(new Error("runtime_vendor_archive_invalid")); } });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      if (code === 0) resolvePromise({ stdout, stderr }); else reject(new Error("runtime_vendor_archive_invalid"));
    });
  });
}

function validateArchiveListing(output) {
  const entries = output.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.length > 100_000
    || entries.some(name => name.includes("\0") || name.startsWith("/") || name.split("/").includes(".."))) {
    refuse("runtime_vendor_archive_invalid");
  }
}

async function extractTool(artifact, archive, staging, runtime) {
  const tar = runtime.tarPath ?? "/usr/bin/tar";
  const listing = await command(tar, ["-tzf", archive], runtime).catch(() => refuse("runtime_vendor_archive_invalid"));
  validateArchiveListing(listing.stdout);
  const safe = ["--no-same-owner", "--no-same-permissions"];
  let args;
  if (artifact.extraction === "tar-gz-strip-1") args = ["-xzf", archive, ...safe, "-C", staging, "--strip-components=1"];
  else if (artifact.extraction === "tar-gz") args = ["-xzf", archive, ...safe, "-C", staging];
  else if (artifact.extraction === "npm-tgz-bin-esbuild") {
    args = ["-xzf", archive, ...safe, "-C", staging, "--strip-components=2", "package/bin/esbuild"];
  } else refuse("runtime_inventory_refused");
  await runtime.observeExtraction?.(artifact.tool, archive);
  await command(tar, args, runtime).catch(() => refuse("runtime_vendor_archive_invalid"));
  const executable = join(staging, artifact.executableRelativePath);
  const entry = await lstat(executable).catch(() => refuse("runtime_vendor_archive_invalid"));
  if (!entry.isFile() || entry.isSymbolicLink() || await sha256File(executable) !== artifact.executableSha256) {
    refuse("runtime_vendor_archive_invalid");
  }
}

async function treeEntries(root) {
  const values = [root];
  const visit = async directory => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), entry = await lstat(path);
      values.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path);
    }
  };
  await visit(root); return values;
}

/** Rehearsal assertion for the root-owned, ACL-free runtime tree. */
export async function assertRuntimeTreeRootMetadataV1(root, runtime = {}) {
  if ((runtime.geteuid ?? process.geteuid)?.() !== 0) refuse("runtime_vendor_root_metadata_refused");
  for (const path of await treeEntries(root)) {
    const entry = await (runtime.lstat ?? lstat)(path);
    if (entry.uid !== 0 || entry.gid !== 0) refuse("runtime_vendor_root_metadata_refused");
    if (process.platform === "darwin") {
      const acl = (await command("/bin/ls", ["-lde", path], runtime)).stdout
        .split(/\r?\n/u).slice(1).filter(line => /^\s*\d+:/u.test(line));
      const fields = (await command("/bin/ls", ["-ldO", path], runtime)).stdout.trim().split(/\s+/u);
      if (acl.length !== 0 || fields.length < 6 || fields[4] !== "-") refuse("runtime_vendor_root_metadata_refused");
    }
  }
  return Object.freeze({ root, entries: (await treeEntries(root)).length });
}

async function normalizeAndSeal(root, runtime) {
  const canonicalRoot = await realpath(root);
  const uid = (runtime.geteuid ?? process.geteuid)?.() === 0 ? 0 : (runtime.geteuid ?? process.geteuid)?.();
  const gid = (runtime.getegid ?? process.getegid)?.() ?? 0;
  const changeOwner = runtime.lchown ?? lchown;
  for (const path of await treeEntries(root)) {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target)) refuse("runtime_vendor_archive_invalid");
      const canonical = await realpath(path).catch(() => refuse("runtime_vendor_archive_invalid"));
      if (!inside(canonicalRoot, canonical)) refuse("runtime_vendor_archive_invalid");
    }
    await changeOwner(path, uid, gid);
  }
  if (process.platform === "darwin" && runtime.skipMacMetadata !== true) {
    await command("/usr/bin/chflags", ["-R", "0", root], runtime)
      .catch(() => refuse("runtime_vendor_root_metadata_refused"));
    await command("/bin/chmod", ["-RN", root], runtime)
      .catch(() => refuse("runtime_vendor_root_metadata_refused"));
  }
  const entries = await treeEntries(root);
  for (const path of entries.filter(path => path !== root)) {
    const entry = await lstat(path);
    if (entry.isFile()) await chmod(path, (entry.mode & 0o111) === 0 ? 0o444 : 0o555);
  }
  for (const path of [...entries].reverse()) {
    const entry = await lstat(path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await chmod(path, 0o555);
  }
}

async function installedFileInventory(root) {
  const files = [];
  const visit = async directory => {
    for (const name of (await readdir(directory)).sort()) {
      if (directory === root && name === "manifest.json") continue;
      const path = join(directory, name), entry = await lstat(path);
      const local = relative(root, path).split(sep).join("/");
      const mode = (entry.mode & 0o7777).toString(8).padStart(4, "0");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        files.push(Object.freeze({ path: local, type: "directory", mode }));
        await visit(path);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        files.push(Object.freeze({ path: local, type: "file", mode, bytes: entry.size,
          sha256: await sha256File(path) }));
      } else if (entry.isSymbolicLink()) {
        files.push(Object.freeze({ path: local, type: "symlink", mode, bytes: entry.size,
          target: await readlink(path) }));
      } else refuse("runtime_vendor_archive_invalid");
    }
  };
  await visit(root);
  return Object.freeze(files);
}

async function writeInstalledRuntimeManifest(staging, artifact, runtime) {
  const files = await installedFileInventory(staging);
  const manifest = Object.freeze({ schema: "control-room.installed-runtime/v1", tool: artifact.tool,
    version: artifact.version, executable: artifact.executableRelativePath,
    archiveSha256: artifact.archiveSha256, executableSha256: artifact.executableSha256, files });
  await chmod(staging, 0o755);
  const path = join(staging, "manifest.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444, flag: "wx" });
  const uid = (runtime.geteuid ?? process.geteuid)?.() === 0 ? 0 : (runtime.geteuid ?? process.geteuid)?.();
  const gid = (runtime.getegid ?? process.getegid)?.() ?? 0;
  await (runtime.lchown ?? lchown)(path, uid, gid);
  await chmod(path, 0o444); await chmod(staging, 0o555);
}

async function linkState(runtimeRoot, artifact, fresh) {
  const currentName = `${artifact.linkBase}-current`, previousName = `${artifact.linkBase}-previous`;
  const target = `${artifact.linkBase}-${artifact.version}`;
  const currentPath = join(runtimeRoot, currentName), previousPath = join(runtimeRoot, previousName);
  const read = path => lstat(path).then(async entry => entry.isSymbolicLink()
    ? readlink(path) : refuse("runtime_link_refused"), error => error?.code === "ENOENT" ? null : Promise.reject(error));
  const [oldCurrent, oldPrevious] = await Promise.all([read(currentPath), read(previousPath)]);
  if (fresh && (oldCurrent !== null || oldPrevious !== null)) refuse("runtime_link_refused");
  return { currentName, previousName, target, previousTarget: fresh ? target : oldCurrent, oldCurrent, oldPrevious };
}

async function installLink(runtimeRoot, name, target) {
  if (target === null) refuse("runtime_link_refused");
  const path = join(runtimeRoot, name), temporary = join(runtimeRoot, `.${name}.${process.pid}.${randomBytes(5).toString("hex")}`);
  const entry = await lstat(path).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (entry && !entry.isSymbolicLink()) refuse("runtime_link_refused");
  await symlink(target, temporary);
  await rename(temporary, path).catch(async () => { await rm(temporary, { force: true }); refuse("runtime_link_refused"); });
}

async function restoreLink(runtimeRoot, name, target) {
  const path = join(runtimeRoot, name);
  if (target === null) { await rm(path, { force: true }); return; }
  await installLink(runtimeRoot, name, target);
}

function undoReceipt(root, created, linkPlan) {
  return Object.freeze({
    schema: RUNTIME_UNDO_SCHEMA,
    trees: Object.freeze(created.map(path => relative(root, path).split(sep).join("/"))),
    links: Object.freeze(linkPlan.flatMap(plan => [
      Object.freeze({ path: `runtime/${plan.previousName}`, installedTarget: plan.previousTarget,
        previousTarget: plan.oldPrevious }),
      Object.freeze({ path: `runtime/${plan.currentName}`, installedTarget: plan.target,
        previousTarget: plan.oldCurrent }),
    ])),
  });
}

function validateUndoReceipt(value) {
  if (!exactKeys(value, ["schema", "trees", "links"]) || value.schema !== RUNTIME_UNDO_SCHEMA
    || !Array.isArray(value.trees) || value.trees.length < 1 || value.trees.length > TOOL_NAMES.length
    || new Set(value.trees).size !== value.trees.length || value.trees.some(path => typeof path !== "string" || !RUNTIME_TREE.test(path))
    || !Array.isArray(value.links) || value.links.length !== value.trees.length * 2) refuse("runtime_undo_refused");
  const bases = new Set(value.trees.map(path => RUNTIME_TREE.exec(path)[1]));
  const names = new Set();
  for (const link of value.links) {
    if (!exactKeys(link, ["path", "installedTarget", "previousTarget"]) || typeof link.path !== "string") {
      refuse("runtime_undo_refused");
    }
    const match = RUNTIME_LINK.exec(link.path);
    const validTarget = target => target === null || typeof target === "string" && RUNTIME_TARGET.test(target);
    if (!match || !bases.has(match[1]) || names.has(link.path)
      || !validTarget(link.installedTarget) || !validTarget(link.previousTarget)
      || RUNTIME_TARGET.exec(link.installedTarget ?? "")?.[1] !== match[1]
      || link.previousTarget !== null && RUNTIME_TARGET.exec(link.previousTarget)?.[1] !== match[1]) refuse("runtime_undo_refused");
    names.add(link.path);
  }
  for (const base of bases) {
    if (!["current", "previous"].every(kind => names.has(`runtime/${base}-${kind}`))) refuse("runtime_undo_refused");
    const current = value.links.find(link => link.path === `runtime/${base}-current`);
    const tree = value.trees.find(path => RUNTIME_TREE.exec(path)[1] === base);
    if (current.installedTarget !== tree.slice("runtime/".length)) refuse("runtime_undo_refused");
  }
  return value;
}

/** Restore runtime links and remove the transaction-owned runtime trees. */
export async function undoVendoredRuntimeV1(input, runtime = {}) {
  if (!exactKeys(input, ["receipt", "root"]) || !absolute(input.root)) refuse("runtime_undo_refused");
  const receipt = validateUndoReceipt(input.receipt), runtimeRoot = join(input.root, "runtime");
  if (await realpath(input.root).catch(() => null) !== input.root
    || await realpath(runtimeRoot).catch(() => null) !== runtimeRoot) refuse("runtime_undo_refused");
  for (const link of [...receipt.links].reverse()) {
    const name = link.path.slice("runtime/".length), path = join(input.root, link.path);
    const entry = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (entry) {
      if (!entry.isSymbolicLink()) refuse("runtime_undo_refused");
      const target = await readlink(path);
      if (target !== link.installedTarget && target !== link.previousTarget) refuse("runtime_undo_refused");
    }
    if (!entry && link.previousTarget === null) continue;
    await restoreLink(runtimeRoot, name, link.previousTarget);
  }
  const removeTree = runtime.rm ?? rm;
  for (const tree of [...receipt.trees].reverse()) {
    const path = join(input.root, tree);
    const entry = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!entry) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) refuse("runtime_undo_refused");
    await makeWritable(path);
    await removeTree(path, { recursive: true, force: true });
  }
  return Object.freeze({ status: "runtime_undone" });
}

/** Fresh-install crash recovery for a vendor call that wrote only its planned journal row. */
export async function recoverPlannedRuntimeV1(input, runtime = {}) {
  if (!exactKeys(input, ["root", "tools", "transactionId"]) || !absolute(input.root)
    || !Array.isArray(input.tools) || input.tools.length < 1 || input.tools.some(tool => !TOOL_NAMES.includes(tool))
    || new Set(input.tools).size !== input.tools.length || !TRANSACTION_ID.test(input.transactionId ?? "")) {
    refuse("runtime_undo_refused");
  }
  const inventory = runtime.inventory === undefined ? await loadRuntimeInventoryV1()
    : validateRuntimeInventoryV1(runtime.inventory);
  const runtimeRoot = join(input.root, "runtime");
  for (const tool of [...input.tools].reverse()) {
    const artifact = inventory.artifacts.find(value => value.tool === tool);
    if (!artifact) refuse("runtime_undo_refused");
    const target = `${artifact.linkBase}-${artifact.version}`;
    for (const kind of ["current", "previous"]) {
      const path = join(runtimeRoot, `${artifact.linkBase}-${kind}`);
      const entry = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (!entry) continue;
      if (!entry.isSymbolicLink() || await readlink(path) !== target) refuse("runtime_undo_refused");
      await rm(path, { force: true });
    }
    for (const path of [join(runtimeRoot, target), join(runtimeRoot, `.${target}.${input.transactionId}`)]) {
      const entry = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (!entry) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) refuse("runtime_undo_refused");
      await makeWritable(path); await (runtime.rm ?? rm)(path, { recursive: true, force: true });
    }
  }
  await rm(join(input.root, `build/download-${input.transactionId}`), { recursive: true, force: true });
  return Object.freeze({ status: "runtime_recovered" });
}

async function makeWritable(root) {
  const entry = await lstat(root).catch(() => undefined);
  if (!entry || entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    await chmod(root, 0o700).catch(() => {});
    for (const name of await readdir(root).catch(() => [])) await makeWritable(join(root, name));
  }
}

async function ensureDirectory(root, path, mode) {
  const parts = relative(root, path).split(sep).filter(Boolean);
  if (parts.length === 0 || !inside(root, path)) refuse("runtime_vendor_destination_exists");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const existing = await lstat(current).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!existing) await mkdir(current, { mode: index === parts.length - 1 ? mode : 0o755 });
    const entry = await lstat(current), canonical = await realpath(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || canonical !== current || (entry.mode & 0o022) !== 0
      || process.geteuid?.() === 0 && (entry.uid !== 0 || entry.gid !== 0)) refuse("runtime_vendor_destination_exists");
  }
}

async function vendorPostgresql(artifact, source, destination, runtime) {
  const pin = { schema: "control-room.pg-runtime-vendor/v1", version: artifact.version,
    archiveName: artifact.archiveName, url: artifact.url, archiveSha256: artifact.archiveSha256,
    archiveBytes: artifact.archiveBytes, teamIdentifier: artifact.teamIdentifier, provenance: artifact.provenance };
  const vendor = runtime.vendorPostgresql ?? (await import("../pg/pg-runtime-vendor.ts")).vendorPgRuntimeV1;
  const result = await vendor({ archivePath: source, runtimeDirectory: destination, pin, opensslConf: "",
    hooks: runtime.pgHooks });
  if (result?.status !== "pg_runtime_vendored") {
    const reason = typeof result?.refusal === "string" && result.refusal.length > 0 ? `: ${result.refusal}` : "";
    refuse(`pg_runtime_vendor_refused${reason}`);
  }
  const executable = join(destination, artifact.executableRelativePath);
  if (await sha256File(executable) !== artifact.executableSha256) refuse("pg_runtime_vendor_refused");
}

/** Download, snapshot once, vendor and switch the selected pinned runtimes. */
export async function vendorRuntimeV1(inputValue, runtime = {}) {
  const { input, inventory } = validateInput(inputValue);
  if (await realpath(input.root).catch(() => null) !== input.root) refuse("runtime_inventory_refused");
  const runtimeRoot = join(input.root, "runtime"), downloadRoot = join(input.root, `build/download-${input.transactionId}`);
  const snapshotRoot = join(input.root, "updater-state/tmp");
  await ensureDirectory(input.root, runtimeRoot, 0o755);
  await ensureDirectory(input.root, dirname(downloadRoot), 0o755);
  await mkdir(downloadRoot, { mode: 0o700 }).catch(error => error?.code === "EEXIST"
    ? refuse("runtime_vendor_destination_exists") : Promise.reject(error));
  await (runtime.lchown ?? lchown)(downloadRoot, input.download.uid, input.download.gid);
  await ensureDirectory(input.root, snapshotRoot, 0o700);
  const artifacts = input.tools.map(tool => inventory.artifacts.find(artifact => artifact.tool === tool));
  const installed = {}, links = {}, created = [], stagingPaths = [], linkPlan = [], appliedLinks = [];
  try {
    for (const artifact of artifacts) {
      const destination = join(runtimeRoot, `${artifact.linkBase}-${artifact.version}`);
      if (await lstat(destination).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error))) {
        refuse("runtime_vendor_destination_exists");
      }
      linkPlan.push(await linkState(runtimeRoot, artifact, input.fresh));
      const suppliedSnapshot = input.snapshots?.[artifact.tool];
      const downloaded = suppliedSnapshot ?? join(downloadRoot, artifact.archiveName);
      if (suppliedSnapshot) await assertSuppliedSnapshot(suppliedSnapshot, runtime);
      else await downloadArchive(artifact, downloaded, input.download, runtime);
      if (artifact.tool === "postgresql") {
        await vendorPostgresql(artifact, downloaded, destination, runtime);
      } else {
        const snapshot = suppliedSnapshot ?? join(snapshotRoot, `${input.transactionId}-${artifact.archiveName}`);
        if (!suppliedSnapshot) {
          await copyArchiveOnce(downloaded, snapshot, artifact.archiveBytes);
          await runtime.afterArchiveSnapshot?.(artifact.tool, downloaded);
        } else if ((await lstat(snapshot)).size !== artifact.archiveBytes) refuse("runtime_vendor_archive_invalid");
        if (await sha256File(snapshot) !== artifact.archiveSha256) refuse("runtime_vendor_archive_invalid");
        const staging = join(runtimeRoot, `.${artifact.linkBase}-${artifact.version}.${input.transactionId}`);
        await mkdir(staging, { mode: 0o700 }).catch(error => error?.code === "EEXIST"
          ? refuse("runtime_vendor_destination_exists") : Promise.reject(error));
        stagingPaths.push(staging);
        await extractTool(artifact, snapshot, staging, runtime);
        await normalizeAndSeal(staging, runtime);
        await writeInstalledRuntimeManifest(staging, artifact, runtime);
        await rename(staging, destination).catch(async error => {
          if (await lstat(destination).then(() => true, () => false)) refuse("runtime_vendor_destination_exists");
          throw error;
        });
        stagingPaths.splice(stagingPaths.indexOf(staging), 1);
        if (!suppliedSnapshot) await rm(snapshot, { force: true });
      }
      await runtime.afterRuntimeTreeInstalled?.(artifact.tool, destination);
      created.push(destination);
      installed[artifact.tool] = Object.freeze({ version: artifact.version,
        dir: relative(input.root, destination).split(sep).join("/"), archiveSha256: artifact.archiveSha256,
        executableSha256: artifact.executableSha256 });
    }
    for (const plan of linkPlan) {
      await installLink(runtimeRoot, plan.previousName, plan.previousTarget);
      appliedLinks.push({ name: plan.previousName, target: plan.oldPrevious });
      await installLink(runtimeRoot, plan.currentName, plan.target);
      appliedLinks.push({ name: plan.currentName, target: plan.oldCurrent });
      links[plan.previousName] = plan.previousTarget; links[plan.currentName] = plan.target;
    }
    if ((runtime.geteuid ?? process.geteuid)?.() === 0) {
      const assertMetadata = runtime.assertRuntimeTreeRootMetadata ?? assertRuntimeTreeRootMetadataV1;
      for (const destination of created) await assertMetadata(destination, runtime);
    }
    return Object.freeze({ installed: Object.freeze(installed), links: Object.freeze(links),
      undo: undoReceipt(input.root, created, linkPlan) });
  } catch (error) {
    let linkRollbackFailed = false;
    for (const link of appliedLinks.reverse()) {
      await restoreLink(runtimeRoot, link.name, link.target).catch(() => { linkRollbackFailed = true; });
    }
    for (const staging of stagingPaths.reverse()) {
      await makeWritable(staging); await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    for (const destination of created.reverse()) {
      await makeWritable(destination); await rm(destination, { recursive: true, force: true }).catch(() => {});
    }
    if (linkRollbackFailed) refuse("runtime_link_refused");
    throw error;
  } finally {
    await rm(downloadRoot, { recursive: true, force: true }).catch(() => {});
    for (const artifact of artifacts) {
      await rm(join(snapshotRoot, `${input.transactionId}-${artifact.archiveName}`), { force: true }).catch(() => {});
    }
  }
}

export async function loadRuntimeInventoryV1() {
  return validateRuntimeInventoryV1(JSON.parse(await readFile(
    new URL("../policy/runtime-inventory.json", import.meta.url), "utf8")));
}
