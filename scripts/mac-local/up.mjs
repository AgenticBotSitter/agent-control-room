// Starts the Mac-local stack in the fixed order: repin, database check, owner bootstrap,
// task provider, task host. The database connection is direct over the protected Tailscale route.
// Repeat-safe: a running stack is left alone.
// Usage: pnpm mac:up -- --protected-root ABS_PATH   (or CONTROL_ROOM_PROTECTED_ROOT)
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { alive, hostCommand, protectedRootFromArguments, readPid, repoRoot, runtimePaths, stopRecorded } from "./stack.mjs";

const PROVIDER_MODULE = "dist-vps/server/macLocalDefaultTaskProvider.js";

export function providerFileBody(modulePath) {
  return `export { schema, workerKinds, createTaskApplication } from ${JSON.stringify(pathToFileURL(modulePath).href)};\n`;
}

const log = line => console.log(`mac:up ${line}`);
const fail = (line, code = 1) => { console.error(`mac:up FAILED ${line}`); process.exit(code); };

function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.once("close", code => { clearTimeout(timer); resolve(code ?? 1); });
    child.once("error", () => { clearTimeout(timer); resolve(1); });
  });
}

const portOpen = port => new Promise(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setTimeout(1_000);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(false));
});
async function waitFor(check, seconds) {
  for (let i = 0; i < seconds * 2; i++) { if (await check()) return true; await new Promise(r => setTimeout(r, 500)); }
  return false;
}

async function writePrivate(path, content) {
  const temporary = `${path}.new-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "w" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Appends to a private log without following a symlink or reusing a loose file. */
function openPrivateLog(path) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const entry = fstatSync(fd);
  if (!entry.isFile() || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid()) {
    closeSync(fd);
    throw new Error(`${path} must be a private regular file`);
  }
  return fd;
}

async function startDetached([command, ...args], logPath, pidPath) {
  const out = openPrivateLog(logPath);
  const child = spawn(command, args, { cwd: repoRoot, detached: true, stdio: ["ignore", out, out], env: process.env });
  closeSync(out);
  // A failed exec (for example a missing binary) is reported by the start check, not thrown.
  child.once("error", () => {});
  child.unref();
  if (!child.pid) throw new Error(`${command} could not be started`);
  // A started child whose pid cannot be recorded could never be stopped by mac:down.
  try { await writePrivate(pidPath, `${child.pid}\n`); }
  catch (error) { try { process.kill(-child.pid, "SIGKILL"); } catch {} throw error; }
  return child.pid;
}

/** Starts a detached child and waits until `ready()`. On any failure the child is stopped and its
 * pid file removed, so a failed start never leaves an orphan behind. */
async function startAndWait(command, logPath, pidPath, ready, seconds, what) {
  const pid = await startDetached(command, logPath, pidPath);
  const ok = await waitFor(async () => !alive(pid, command) || await ready(), seconds) && alive(pid, command);
  if (!ok) {
    await stopRecorded(pidPath, command, 10);
    fail(`${what} did not start within ${seconds}s (see ${logPath.split("/").slice(-2).join("/")})`);
  }
  return pid;
}

async function main() {
  const root = protectedRootFromArguments(process.argv.slice(2));
  if (!root) fail("--protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required", 2);
  const paths = runtimePaths(root);
  const mac = JSON.parse(await readFile(join(root, "config/mac-local.json"), "utf8"));
  const hostPid = await readPid(paths.hostPid);
  if (hostPid && alive(hostPid, hostCommand(root))) {
    // A host that is alive but not serving is a failure, never "already running".
    if (await portOpen(mac.port)) { log(`already running (pid ${hostPid})`); return; }
    fail("task host is running but not serving: run pnpm mac:down first");
  }
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  await chmod(paths.runtime, 0o700);
  if (!existsSync(join(repoRoot, "dist-vps/server/macLocalHost.js"))) fail("release build missing: run pnpm build first");

  log("1/5 repin");
  const repin = await run(["--import", "tsx", "scripts/mac-local/repin-workers.mjs", "--protected-root", root]);
  if (repin === 1) log("repin blocked for a worker: it will show unavailable");
  else if (repin !== 0) fail(`repin exit ${repin}: protected configuration is unsafe`);

  log("2/5 database");
  if (await run(["--import", "tsx", "scripts/mac-local/check-database.ts", root]) !== 0) fail("database check failed");

  log("3/5 owner");
  if (await run(["--import", "tsx", "scripts/mac-local/bootstrap-owner.ts", root]) !== 0) fail("owner bootstrap failed");

  log("4/5 task provider");
  const module = join(repoRoot, PROVIDER_MODULE);
  if (!existsSync(module)) fail(`${PROVIDER_MODULE} missing: run pnpm build`);
  const body = providerFileBody(module);
  const current = existsSync(paths.provider) ? await readFile(paths.provider, "utf8") : undefined;
  if (current !== body) { await writePrivate(paths.provider, body); log("task provider written"); }

  log("5/5 task host");
  await stopRecorded(paths.hostPid, hostCommand(root), 45);
  const pid = await startAndWait(hostCommand(root), paths.hostLog, paths.hostPid, () => portOpen(mac.port), 90, "task host");
  log(`running: http://127.0.0.1:${mac.port} (pid ${pid})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => fail(error instanceof Error ? error.message : "unknown"));
}
