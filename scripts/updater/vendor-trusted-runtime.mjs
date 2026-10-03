#!/usr/bin/env node
import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod, lchown, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sha256File, validateTrustedRuntimeManifest, verifyPinnedFile,
} from "../../src/updater/v1/trusted-runtime.mjs";

const policyPath = fileURLToPath(new URL("../../src/updater/v1/policy/runtime-inventory.json", import.meta.url));
const TAR = "/usr/bin/tar";
const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C" });

const refuse = code => { throw new Error(code); };
const absolute = (value, code) => {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) refuse(code);
  return value;
};
const inside = (root, path) => {
  const rest = relative(root, path);
  return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};

function run(file, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { env: SAFE_ENVIRONMENT, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0;
    const append = (current, chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("runtime_vendor_output_limit")); }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolvePromise({ stdout, stderr })
      : reject(new Error(`runtime_vendor_command_failed:${code}:${stderr.trim()}`)));
  });
}

function validateArchiveListing(output) {
  const entries = output.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.length > 100_000) refuse("runtime_vendor_archive_invalid");
  for (const name of entries) {
    if (name.includes("\0") || name.startsWith("/") || name.split("/").includes("..")) {
      refuse("runtime_vendor_archive_invalid");
    }
  }
}

async function extractArtifact(artifact, archive, destination, runtime) {
  const execute = async (file, args) => {
    await runtime.observeCommand?.(file, args);
    return run(file, args);
  };
  validateArchiveListing((await execute(TAR, ["-tzf", archive])).stdout);
  await mkdir(destination, { mode: 0o700 });
  const safeExtraction = ["--no-same-owner", "--no-same-permissions"];
  if (artifact.tool === "node") {
    await execute(TAR, ["-xzf", archive, ...safeExtraction, "-C", destination, "--strip-components=1"]);
  } else if (artifact.tool === "pnpm") {
    await execute(TAR, ["-xzf", archive, ...safeExtraction, "-C", destination]);
  } else if (artifact.tool === "esbuild") {
    await execute(TAR, ["-xzf", archive, ...safeExtraction, "-C", destination, "--strip-components=2", "package/bin/esbuild"]);
  } else refuse("runtime_vendor_tool_invalid");
  await verifyPinnedFile(join(destination, artifact.executableRelativePath), artifact.executableSha256);
}

async function copyArchiveOnce(source, destination) {
  const input = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(() => refuse("runtime_vendor_archive_invalid"));
  let output;
  try {
    output = await open(destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1) refuse("runtime_vendor_archive_invalid");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead === 0) refuse("runtime_vendor_archive_invalid");
      await output.write(buffer, 0, bytesRead, position); position += bytesRead;
    }
    const after = await input.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) refuse("runtime_vendor_archive_invalid");
    await output.chmod(0o600); await output.sync();
  } finally { await input.close(); await output?.close(); }
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
  await visit(root);
  return values;
}

async function normalizeRootMetadata(root, runtime) {
  const uid = process.geteuid?.() === 0 ? 0 : process.geteuid?.();
  const gid = process.geteuid?.() === 0 ? 0 : process.getegid?.();
  if (process.platform === "darwin") {
    await runtime.observeCommand?.("/usr/bin/chflags", ["-R", "0", root]);
    await run("/usr/bin/chflags", ["-R", "0", root]);
    await runtime.observeCommand?.("/bin/chmod", ["-RN", root]);
    await run("/bin/chmod", ["-RN", root]);
  }
  const changeOwner = runtime.lchown ?? lchown;
  for (const path of await treeEntries(root)) await changeOwner(path, uid, gid);
}

export async function assertRuntimeTreeRootMetadataV1(root) {
  if ((process.geteuid?.() ?? -1) !== 0) refuse("runtime_vendor_real_root_required");
  for (const path of await treeEntries(root)) {
    const entry = await lstat(path);
    if (entry.uid !== 0 || entry.gid !== 0) refuse("runtime_vendor_root_metadata_refused");
    if (process.platform === "darwin") {
      const acl = (await run("/bin/ls", ["-lde", path])).stdout.split(/\r?\n/u).slice(1).filter(line => /^\s*\d+:/u.test(line));
      const flags = (await run("/bin/ls", ["-ldO", path])).stdout.trim().split(/\s+/u)[4];
      if (acl.length !== 0 || flags !== "-") refuse("runtime_vendor_root_metadata_refused");
    }
  }
  return Object.freeze({ root, entries: (await treeEntries(root)).length });
}

async function inventory(root) {
  const entries = [], canonicalRoot = await realpath(root);
  const visit = async directory => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), local = relative(root, path).split(sep).join("/");
      const entry = await lstat(path);
      if (entry.isDirectory()) {
        entries.push({ path: local, type: "directory", mode: "0555" });
        await visit(path);
      } else if (entry.isFile()) {
        const executable = (entry.mode & 0o111) !== 0;
        entries.push({ path: local, type: "file", mode: executable ? "0555" : "0444", bytes: entry.size,
          sha256: await sha256File(path) });
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !inside(root, resolve(dirname(path), target))) refuse("runtime_vendor_symlink_invalid");
        const canonical = await realpath(path).catch(() => refuse("runtime_vendor_symlink_invalid"));
        if (!inside(canonicalRoot, canonical)) refuse("runtime_vendor_symlink_invalid");
        entries.push({ path: local, type: "symlink", mode: (entry.mode & 0o7777).toString(8).padStart(4, "0"),
          bytes: entry.size, target });
      } else refuse("runtime_vendor_file_type_invalid");
    }
  };
  await visit(root);
  return entries;
}

async function seal(root, entries) {
  for (const entry of entries.filter(item => item.type === "file")) {
    await chmod(join(root, entry.path), Number.parseInt(entry.mode, 8));
  }
  for (const entry of [...entries].reverse().filter(item => item.type === "directory")) {
    await chmod(join(root, entry.path), 0o555);
  }
  await chmod(root, 0o555);
}

async function makeWritableForCleanup(root) {
  const entry = await lstat(root).catch(() => undefined);
  if (!entry || entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    await chmod(root, 0o700).catch(() => {});
    for (const name of await readdir(root).catch(() => [])) await makeWritableForCleanup(join(root, name));
  }
}

export async function vendorTrustedRuntime({ sourceDirectory, runtimeDirectory, manifest = undefined }, runtime = {}) {
  const source = absolute(sourceDirectory, "runtime_vendor_source_invalid");
  const destination = absolute(runtimeDirectory, "runtime_vendor_destination_invalid");
  const sourceEntry = await lstat(source).catch(() => refuse("runtime_vendor_source_invalid"));
  if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) refuse("runtime_vendor_source_invalid");
  if (await lstat(destination).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error))) {
    refuse("runtime_vendor_destination_exists");
  }
  const value = validateTrustedRuntimeManifest(manifest ?? JSON.parse(await readFile(policyPath, "utf8")));
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  const staging = join(dirname(destination), `.runtime-stage-${process.pid}-${randomBytes(8).toString("hex")}`);
  const archiveStaging = join(dirname(destination), `.runtime-archives-${process.pid}-${randomBytes(8).toString("hex")}`);
  await mkdir(staging, { mode: 0o700 });
  await mkdir(archiveStaging, { mode: 0o700 });
  try {
    for (const artifact of value.artifacts.filter(item => item.tool !== "postgresql")) {
      const archive = join(source, artifact.archiveName);
      const archiveEntry = await lstat(archive).catch(() => refuse("runtime_vendor_archive_missing"));
      if (!archiveEntry.isFile() || archiveEntry.isSymbolicLink()) refuse("runtime_vendor_archive_invalid");
      const snapshot = join(archiveStaging, artifact.archiveName);
      await copyArchiveOnce(archive, snapshot);
      await runtime.afterArchiveSnapshot?.(artifact.tool, archive);
      await verifyPinnedFile(snapshot, artifact.archiveSha256);
      await extractArtifact(artifact, snapshot, join(staging, `${artifact.tool}-${artifact.version}`), runtime);
      await runtime.afterArtifact?.(artifact.tool);
    }
    await normalizeRootMetadata(staging, runtime);
    const entries = await inventory(staging);
    const installed = Object.fromEntries(value.artifacts.filter(item => item.tool !== "postgresql").map(artifact => [artifact.tool, {
      version: artifact.version,
      directory: `${artifact.tool}-${artifact.version}`,
      executable: `${artifact.tool}-${artifact.version}/${artifact.executableRelativePath}`,
      archiveSha256: artifact.archiveSha256,
      executableSha256: artifact.executableSha256,
    }]));
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify({
      schema: "control-room.installed-trusted-runtime/v1", platform: value.platform,
      architecture: value.architecture, installed, files: entries,
    }, null, 2)}\n`, { mode: 0o444, flag: "wx" });
    await normalizeRootMetadata(staging, runtime);
    const withManifest = await inventory(staging);
    await seal(staging, withManifest);
    if (runtime.realRootRehearsal === true) await assertRuntimeTreeRootMetadataV1(staging);
    try { await rename(staging, destination); }
    catch (error) {
      const destinationExists = await lstat(destination).then(() => true,
        failure => failure?.code === "ENOENT" ? false : Promise.reject(failure));
      if (destinationExists) refuse("runtime_vendor_destination_exists");
      throw error;
    }
    return Object.freeze({ runtimeDirectory: destination, fileCount: withManifest.length });
  } catch (error) {
    await makeWritableForCleanup(staging);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally { await rm(archiveStaging, { recursive: true, force: true }).catch(() => {}); }
}

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!["--source-directory", "--runtime-directory"].includes(name) || value === undefined) refuse("usage_invalid");
    values[name] = value;
  }
  if (Object.keys(values).length !== 2) refuse("usage_invalid");
  return { sourceDirectory: values["--source-directory"], runtimeDirectory: values["--runtime-directory"] };
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  void vendorTrustedRuntime(argumentsFrom(process.argv.slice(2))).then(result => {
    process.stdout.write(`${JSON.stringify({ schema: "control-room.runtime-vendor-result/v1", ...result })}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "runtime_vendor_failed"}\n`);
    process.exitCode = 1;
  });
}
