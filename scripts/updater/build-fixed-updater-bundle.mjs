#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function argumentsV1(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) refuse("updater_bundle_arguments_refused");
    result[key.slice(2)] = value;
  }
  for (const required of ["source", "policy", "runtime", "store", "output"])
    if (!result[required]) refuse("updater_bundle_arguments_refused");
  return result;
}

async function run(executable, args, cwd) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, stdio: "inherit", env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(Object.assign(
      new Error(`updater_bundle_tool_failed:${code ?? signal}`), { code: "updater_bundle_tool_failed" })));
  });
}

async function copyTree(source, destination) {
  const entry = await lstat(source);
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || (entry.isFile() && entry.nlink !== 1))
    refuse("updater_bundle_input_refused");
  if (entry.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    for (const name of (await readdir(source)).sort()) await copyTree(join(source, name), join(destination, name));
  } else { await cp(source, destination, { dereference: false }); await chmod(destination, entry.mode & 0o111 ? 0o500 : 0o400); }
}

async function manifestFiles(root, current = root) {
  const files = [];
  for (const name of (await readdir(current)).sort()) {
    if (name === "manifest.json") continue;
    const path = join(current, name), entry = await lstat(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || (entry.isFile() && entry.nlink !== 1))
      refuse("updater_bundle_output_refused");
    if (entry.isDirectory()) files.push(...await manifestFiles(root, path));
    else files.push({ path: relative(root, path), sha256: sha256(await readFile(path)), mode: entry.mode & 0o777,
      type: "file" });
  }
  return files;
}

export async function buildFixedUpdaterBundleV1(input) {
  const source = resolve(input.source), policyPath = resolve(input.policy), runtime = resolve(input.runtime);
  const store = resolve(input.store), output = resolve(input.output);
  if (process.env.CONTROL_ROOM_BUNDLE_TESTING !== "1") {
    if (source.startsWith(`/Users${sep}`)) refuse("updater_bundle_owner_home_refused");
    if (!source.split(sep).some(part => /^job-[A-Za-z0-9._-]{1,80}$/u.test(part)))
      refuse("updater_bundle_source_refused");
  }
  const sourceUpdater = join(source, "src/updater/v1");
  try {
    await lstat(join(sourceUpdater, "node_modules"));
    refuse("updater_bundle_source_modules_refused");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const updaterPackage = JSON.parse(await readFile(join(sourceUpdater, "package.json"), "utf8"));
  const updaterLock = await readFile(join(sourceUpdater, "pnpm-lock.yaml"), "utf8");
  if (updaterPackage.name !== "@control-room/updater-v1" || updaterPackage.private !== true
      || updaterPackage.scripts !== undefined
      || JSON.stringify(updaterPackage.dependencies) !== JSON.stringify({ "@simplewebauthn/server": "14.0.3",
        pg: "8.23.0" })
      || !/^lockfileVersion: '9\.0'/mu.test(updaterLock)
      || !/^ {6}'@simplewebauthn\/server':\n {8}specifier: 14\.0\.3\n {8}version: 14\.0\.3$/mu.test(updaterLock)
      || !/^ {6}pg:\n {8}specifier: 8\.23\.0\n {8}version: 8\.23\.0$/mu.test(updaterLock))
    refuse("updater_bundle_lock_refused");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  const exactArguments = ["--bundle", "--platform=node", "--format=esm", "--target=node22", "--packages=bundle",
    "--log-level=warning"];
  if (policy.schema !== "control-room.updater-bundle-policy/v1" || policy.candidateBuildOutputAccepted !== false
      || policy.packageManager !== "runtime/pnpm-current/pnpm"
      || JSON.stringify(policy.arguments) !== JSON.stringify(exactArguments)
      || JSON.stringify(policy.entries) !== JSON.stringify([{ input: "updater.mjs", output: "updater.mjs" },
        { input: "cli.mjs", output: "bin/control-room.mjs" }])) refuse("updater_bundle_policy_refused");
  let tool = join(runtime, policy.tool);
  let packageManager = join(runtime, policy.packageManager);
  if (input.esbuild) {
    if (process.env.CONTROL_ROOM_BUNDLE_TESTING !== "1") refuse("updater_bundle_tool_override_refused");
    tool = resolve(input.esbuild);
  }
  if (input.pnpm) {
    if (process.env.CONTROL_ROOM_BUNDLE_TESTING !== "1") refuse("updater_bundle_tool_override_refused");
    packageManager = resolve(input.pnpm);
  }
  for (const executable of [tool, packageManager]) {
    const toolEntry = await lstat(executable);
    if (!toolEntry.isFile() || toolEntry.isSymbolicLink()) refuse("updater_bundle_tool_refused");
  }
  const storeEntry = await lstat(store);
  if (!storeEntry.isDirectory() || storeEntry.isSymbolicLink()) refuse("updater_bundle_store_refused");

  const staging = join(dirname(output), `.${basename(output)}.${process.pid}.${randomBytes(8).toString("hex")}.staging`);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    const workspace = join(staging, ".build");
    await copyTree(sourceUpdater, workspace);
    await run(packageManager, ["install", "--offline", "--ignore-scripts", "--frozen-lockfile",
      `--store-dir=${store}`, `--dir=${workspace}`], workspace);
    if (input.testNodeModules) {
      if (process.env.CONTROL_ROOM_BUNDLE_TESTING !== "1") refuse("updater_bundle_test_modules_refused");
      await import("node:fs/promises").then(fs => fs.symlink(resolve(input.testNodeModules), join(workspace, "node_modules")));
    }
    for (const entry of policy.entries) {
      const target = join(staging, entry.output); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await run(tool, [...policy.arguments, `--outfile=${target}`, join(workspace, entry.input)], workspace);
    }
    for (const name of ["ddl", "policy"]) await copyTree(join(workspace, name), join(staging, name));
    await copyTree(join(workspace, "guard/guard.sh"), join(staging, "guard.sh"));
    await copyTree(join(workspace, "bin/control-room"), join(staging, "bin/control-room"));
    await rm(workspace, { recursive: true, force: true });
    await chmod(join(staging, "updater.mjs"), 0o500); await chmod(join(staging, "bin/control-room.mjs"), 0o500);
    await chmod(join(staging, "guard.sh"), 0o500); await chmod(join(staging, "bin/control-room"), 0o500);
    const manifest = { schema: "control-room.updater-bundle-manifest/v1", files: await manifestFiles(staging) };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    await rename(staging, output);
    return { manifest, digest: sha256(Buffer.from(JSON.stringify(manifest))) };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = argumentsV1(process.argv.slice(2));
  buildFixedUpdaterBundleV1(args).then(result => process.stdout.write(`${result.digest}\n`)).catch(error => {
    process.stderr.write(`${error?.code ?? "updater_bundle_failed"}\n`); process.exitCode = 1;
  });
}
