import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TEST_RUNNER_SCHEMA = "control-room.test-runner/v1";
export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "agent-control-room", "test-runner.json");
const LOOPBACK = "127.0.0.1";
const REQUEST_LIMIT_BYTES = 64 * 1024;
const TOKEN_BYTES = 32;
const STOP_GRACE_MS = 500;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// tests/support/attack-kit/real-postgres.ts always puts a disposable
// cluster's Unix socket directly under /tmp as "ak<pid>-attack-kit-pg-…",
// bypassing TMPDIR, because a socket path under macOS's much longer
// /var/folders/... tmpdir would exceed the ~103-byte Unix-socket path limit.
// Our own TMPDIR is already short, but this helper does it unconditionally,
// so the sandbox must allow this one specific, narrowly-scoped /tmp pattern
// in addition to the run's own worktree and temp directory.
// Seatbelt matches the canonical path, and /tmp is a symlink to /private/tmp.
const ATTACK_KIT_SHORT_SOCKET_PATTERN = "/private/tmp/ak[0-9]+-attack-kit-pg-";
const CLUSTER_REGISTRY_NAME = "attack-kit-clusters.json";

const ENV_PREFIX = /^PG_BIN="\$\{PG_BIN:-[^"$`\\\n]*\}"\s+/u;
const FLAG_TOKEN = /^--[a-z][a-z0-9-]*(?:=[A-Za-z0-9_.:,-]+)?$/u;
const IMPORT_VALUE_TOKEN = /^[A-Za-z0-9_./-]+$/u;
const TEST_FILE_TOKEN = /^tests\/[a-zA-Z0-9_./-]+\.test\.(?:ts|tsx|mjs)$/u;

/**
 * Parses a pinned `package.json` script body into a literal argv for `node`,
 * with no shell involved. Only two shapes are accepted: an optional ignored
 * `PG_BIN="${PG_BIN:-...}"` prefix (the fixed environment always sets the
 * real PG_BIN, so this prefix's value is never read), then `node` with an
 * optional `scripts/run-tests-with-quarantine.mjs` first argument, flags, and
 * one or more `tests/*.test.{ts,tsx,mjs}` files. Anything else is refused.
 */
export function parsePinnedScriptCommand(pinned) {
  if (typeof pinned !== "string" || pinned.length === 0) return undefined;
  const withoutEnvironmentPrefix = pinned.replace(ENV_PREFIX, "");
  if (/[;&|`$<>\n\r]/u.test(withoutEnvironmentPrefix)) return undefined;
  const tokens = withoutEnvironmentPrefix.split(" ").filter(token => token.length > 0);
  if (tokens.join(" ") !== withoutEnvironmentPrefix) return undefined;
  if (tokens[0] !== "node") return undefined;
  const argv = [];
  let index = 1;
  if (tokens[index] === "scripts/run-tests-with-quarantine.mjs") { argv.push(tokens[index]); index += 1; }
  for (;;) {
    const token = tokens[index];
    if (token === "--import" && IMPORT_VALUE_TOKEN.test(tokens[index + 1] ?? "")) {
      argv.push(token, tokens[index + 1]);
      index += 2;
      continue;
    }
    if (typeof token === "string" && FLAG_TOKEN.test(token)) { argv.push(token); index += 1; continue; }
    break;
  }
  const testFiles = [];
  while (index < tokens.length) {
    const token = tokens[index];
    if (!TEST_FILE_TOKEN.test(token) || token.split("/").includes("..")) return undefined;
    argv.push(token);
    testFiles.push(token);
    index += 1;
  }
  if (testFiles.length === 0) return undefined;
  return Object.freeze({ argv: Object.freeze(argv), testFiles: Object.freeze(testFiles) });
}

export class RunnerRefusal extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = "RunnerRefusal";
    this.status = status;
    this.code = code;
  }
}

function integer(value, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`configuration_invalid: ${name}`);
  }
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`configuration_invalid: ${name}`);
  }
  return resolve(value);
}

async function canonicalPrefix(value, name) {
  const prefix = absolutePath(value, name).replaceAll(sep === "/" ? "\\" : "/", sep);
  const parent = await realpath(dirname(prefix));
  return join(parent, basename(prefix));
}

export async function readConfiguration(path = DEFAULT_CONFIG_PATH) {
  const configPath = absolutePath(path, "config path");
  let raw;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`configuration_unreadable: ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema !== TEST_RUNNER_SCHEMA) {
    throw new Error("configuration_invalid: schema");
  }
  if (!Array.isArray(raw.allowedWorktreePrefixes) || raw.allowedWorktreePrefixes.length === 0) {
    throw new Error("configuration_invalid: allowedWorktreePrefixes");
  }
  if (!raw.allowedScripts || typeof raw.allowedScripts !== "object" || Array.isArray(raw.allowedScripts) ||
      Object.keys(raw.allowedScripts).length === 0) {
    throw new Error("configuration_invalid: allowedScripts");
  }
  const allowedScripts = {};
  for (const [name, pinned] of Object.entries(raw.allowedScripts)) {
    if (!/^[a-z0-9][a-z0-9:._-]*$/u.test(name) || !parsePinnedScriptCommand(pinned)) {
      throw new Error(`configuration_invalid: allowedScripts.${name}`);
    }
    allowedScripts[name] = pinned;
  }
  const portPool = raw.portPool;
  if (!portPool || typeof portPool !== "object" || Array.isArray(portPool)) {
    throw new Error("configuration_invalid: portPool");
  }
  const start = integer(portPool.start, "portPool.start", { minimum: 1024, maximum: 65535 });
  const end = integer(portPool.end, "portPool.end", { minimum: start, maximum: 65535 });
  const blockSize = integer(portPool.blockSize, "portPool.blockSize", { minimum: 2, maximum: end - start + 1 });
  const port = integer(raw.port, "port", { minimum: 1024, maximum: 65535 });
  if (port >= start && port <= end) throw new Error("configuration_invalid: service port overlaps portPool");
  const pgBin = absolutePath(raw.pgBin, "pgBin");
  const nodeBin = raw.nodeBin === undefined ? process.execPath : absolutePath(raw.nodeBin, "nodeBin");
  for (const [name, path, directory] of [["pgBin", pgBin, true], ["nodeBin", nodeBin, false]]) {
    let details;
    try { details = await stat(path); } catch { throw new Error(`configuration_invalid: ${name}`); }
    if (directory ? !details.isDirectory() : !details.isFile()) throw new Error(`configuration_invalid: ${name}`);
  }
  const allowedWorktreePrefixes = [];
  for (const [index, value] of raw.allowedWorktreePrefixes.entries()) {
    allowedWorktreePrefixes.push(await canonicalPrefix(value, `allowedWorktreePrefixes[${index}]`));
  }
  const protectedReadPrefixes = [];
  if (raw.protectedReadPrefixes !== undefined) {
    if (!Array.isArray(raw.protectedReadPrefixes)) throw new Error("configuration_invalid: protectedReadPrefixes");
    for (const [index, value] of raw.protectedReadPrefixes.entries()) {
      protectedReadPrefixes.push(await canonicalPrefix(value, `protectedReadPrefixes[${index}]`));
    }
  }
  return Object.freeze({
    schema: TEST_RUNNER_SCHEMA,
    configPath,
    port,
    tokenFile: absolutePath(raw.tokenFile, "tokenFile"),
    auditLog: absolutePath(raw.auditLog, "auditLog"),
    allowedWorktreePrefixes: Object.freeze(allowedWorktreePrefixes),
    protectedReadPrefixes: Object.freeze(protectedReadPrefixes),
    allowedScripts: Object.freeze(allowedScripts),
    pgBin,
    nodeBin,
    portPool: Object.freeze({ start, end, blockSize }),
    concurrency: integer(raw.concurrency ?? 2, "concurrency", { maximum: 32 }),
    timeoutMs: integer(raw.timeoutMs ?? 20 * 60 * 1000, "timeoutMs", { minimum: 50, maximum: 60 * 60 * 1000 }),
    maxOutputBytes: integer(raw.maxOutputBytes ?? 1024 * 1024, "maxOutputBytes", { minimum: 1024, maximum: 16 * 1024 * 1024 }),
  });
}

async function requirePrivateRegularFile(path, label) {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile() || (details.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && details.uid !== process.getuid())) {
    throw new Error(`${label}_not_private`);
  }
  return details;
}

async function privateParent(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o077) !== 0) {
    throw new Error("private_directory_invalid");
  }
}

export async function readOrCreateToken(path) {
  await privateParent(path);
  try {
    await requirePrivateRegularFile(path, "token_file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(`${randomBytes(TOKEN_BYTES).toString("hex")}\n`); } finally { await handle.close(); }
    await chmod(path, 0o600);
    await requirePrivateRegularFile(path, "token_file");
  }
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error("token_file_invalid");
  return token;
}

export async function readExistingToken(path) {
  await requirePrivateRegularFile(path, "token_file");
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error("token_file_invalid");
  return token;
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

export function authorized(header, token) {
  const candidate = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(candidate), digest(token));
}

export class PortPool {
  #free;
  #blockSize;

  constructor({ start, end, blockSize }) {
    this.#blockSize = blockSize;
    this.#free = new Set();
    for (let base = start; base + blockSize - 1 <= end; base += blockSize) this.#free.add(base);
    if (this.#free.size === 0) throw new Error("configuration_invalid: empty port pool");
  }

  acquire() {
    const base = this.#free.values().next().value;
    if (base === undefined) return undefined;
    this.#free.delete(base);
    return Object.freeze({ base, end: base + this.#blockSize - 1 });
  }

  release(block) {
    if (block) this.#free.add(block.base);
  }
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function resolveWorktree(config, requested) {
  if (typeof requested !== "string" || !isAbsolute(requested) || requested.includes("\0")) {
    throw new RunnerRefusal(403, "worktree_refused");
  }
  let worktree;
  try { worktree = await realpath(requested); } catch { throw new RunnerRefusal(403, "worktree_refused"); }
  const details = await stat(worktree);
  if (!details.isDirectory()) throw new RunnerRefusal(403, "worktree_refused");
  if (!config.allowedWorktreePrefixes.some(prefix => worktree.startsWith(prefix))) {
    throw new RunnerRefusal(403, "worktree_refused");
  }
  return worktree;
}

async function packageScripts(worktree) {
  const path = join(worktree, "package.json");
  let details;
  try { details = await lstat(path); } catch { throw new RunnerRefusal(403, "command_refused"); }
  if (details.isSymbolicLink() || !details.isFile()) throw new RunnerRefusal(403, "command_refused");
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw new RunnerRefusal(403, "command_refused"); }
  return value?.scripts && typeof value.scripts === "object" && !Array.isArray(value.scripts) ? value.scripts : {};
}

export async function resolveApprovedCommand(config, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RunnerRefusal(400, "invalid_request");
  const keys = Object.keys(body).sort();
  const shape = keys.join("\0");
  if (shape !== "file\0worktree" && shape !== "script\0worktree") throw new RunnerRefusal(400, "invalid_request");
  const worktree = await resolveWorktree(config, body.worktree);
  if (shape === "script\0worktree") {
    if (typeof body.script !== "string" || !Object.hasOwn(config.allowedScripts, body.script)) {
      throw new RunnerRefusal(403, "command_refused");
    }
    const scripts = await packageScripts(worktree);
    const pinned = config.allowedScripts[body.script];
    if (scripts[body.script] !== pinned) throw new RunnerRefusal(403, "command_refused");
    const parsed = parsePinnedScriptCommand(pinned);
    if (!parsed) throw new RunnerRefusal(403, "command_refused");
    const testsRoot = await realpath(join(worktree, "tests")).catch(() => undefined);
    if (!testsRoot) throw new RunnerRefusal(403, "command_refused");
    const resolvedFiles = new Map();
    for (const file of parsed.testFiles) {
      const candidate = await realpath(join(worktree, file)).catch(() => undefined);
      if (!candidate || !inside(testsRoot, candidate)) throw new RunnerRefusal(403, "command_refused");
      const fileDetails = await stat(candidate);
      if (!fileDetails.isFile()) throw new RunnerRefusal(403, "command_refused");
      resolvedFiles.set(file, candidate);
    }
    const argv = parsed.argv.map(token => resolvedFiles.get(token) ?? token);
    return Object.freeze({ worktree, display: `node ${parsed.argv.join(" ")}`, executable: config.nodeBin,
      argv: Object.freeze(argv) });
  }
  if (typeof body.file !== "string" || !/^tests\/[a-zA-Z0-9_./-]+\.test\.(?:ts|tsx|mjs)$/u.test(body.file) ||
      body.file.split("/").includes("..")) {
    throw new RunnerRefusal(403, "command_refused");
  }
  const testsRoot = await realpath(join(worktree, "tests")).catch(() => undefined);
  const candidate = await realpath(join(worktree, body.file)).catch(() => undefined);
  if (!testsRoot || !candidate || !inside(testsRoot, candidate)) throw new RunnerRefusal(403, "command_refused");
  const details = await stat(candidate);
  if (!details.isFile()) throw new RunnerRefusal(403, "command_refused");
  return Object.freeze({ worktree, display: `node --import tsx --test ${body.file}`, executable: config.nodeBin,
    argv: Object.freeze(["--import", "tsx", "--test", candidate]) });
}

class BoundedOutput {
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
    this.headLimit = Math.floor(maximumBytes / 2);
    this.tailLimit = maximumBytes - this.headLimit;
    this.totalBytes = 0;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
  }

  add(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += bytes.length;
    if (this.head.length < this.headLimit) {
      const take = Math.min(this.headLimit - this.head.length, bytes.length);
      this.head = Buffer.concat([this.head, bytes.subarray(0, take)]);
      if (take === bytes.length) return;
      this.#appendTail(bytes.subarray(take));
      return;
    }
    this.#appendTail(bytes);
  }

  #appendTail(bytes) {
    this.tail = Buffer.concat([this.tail, bytes]);
    if (this.tail.length > this.tailLimit) this.tail = this.tail.subarray(this.tail.length - this.tailLimit);
  }

  result() {
    if (this.totalBytes <= this.maximumBytes) {
      return { text: Buffer.concat([this.head, this.tail]).toString("utf8"), truncated: false, totalBytes: this.totalBytes };
    }
    const omitted = this.totalBytes - this.head.length - this.tail.length;
    const marker = Buffer.from(`\n... ${omitted} output bytes omitted ...\n`);
    return { text: Buffer.concat([this.head, marker, this.tail]).toString("utf8"), truncated: true, totalBytes: this.totalBytes };
  }
}

export function tapSummary(text) {
  const number = label => {
    const matches = [...text.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, "gmu"))];
    return matches.length ? Number(matches.at(-1)[1]) : 0;
  };
  const failing = [...text.matchAll(/^\s*not ok \d+ - (.+)$/gmu)].map(match => match[1].trim()).slice(0, 50);
  return Object.freeze({ tests: number("tests"), pass: number("pass"), fail: number("fail"), failingTests: failing });
}

function fixedEnvironment(config, ports, tempDirectory) {
  const environment = {
    PATH: [...new Set([dirname(config.nodeBin), config.pgBin, "/usr/bin", "/bin"])].join(":"),
    PG_BIN: config.pgBin,
    CONTROL_ROOM_PG_TEST_PORT_BASE: String(ports.base),
    CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE: `${ports.base + 1}-${ports.end}`,
    TMPDIR: tempDirectory,
    LC_ALL: "C",
    LANG: "C",
  };
  return Object.freeze(environment);
}

function signalGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function commandName(pid) {
  return await new Promise(resolveResult => {
    const child = spawn("/bin/ps", ["-o", "comm=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", () => resolveResult(undefined));
    child.once("close", code => resolveResult(code === 0 ? output.trim() : undefined));
  });
}

async function processCwd(pid) {
  return await new Promise(resolveResult => {
    const child = spawn("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", () => resolveResult(undefined));
    child.once("close", code => {
      if (code !== 0) { resolveResult(undefined); return; }
      const line = output.split(/\r?\n/u).find(entry => entry.startsWith("n"));
      resolveResult(line ? line.slice(1) : undefined);
    });
  });
}

/**
 * Proves a pid is really a postmaster rooted at `dataDirectory`, without
 * trusting process-group membership: `pg_ctl start` runs the postmaster
 * under `setsid`, in its own session, so it is never a member of the runner
 * child's process group. A postmaster always `chdir`s into its data
 * directory, so command name plus cwd is the ownership proof instead. This
 * still refuses a forged `postmaster.pid` pointing at an unrelated process
 * (for example the live app), because that process is neither named
 * `postgres` nor `chdir`'d into the claimed data directory.
 */
async function ownsPostgresProcess(pid, dataDirectory) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const [comm, cwd] = await Promise.all([commandName(pid), processCwd(pid)]);
  if (comm !== "postgres" && !(typeof comm === "string" && comm.endsWith("/postgres"))) return false;
  if (!cwd) return false;
  let realCwd, realData;
  try { [realCwd, realData] = await Promise.all([realpath(cwd), realpath(dataDirectory)]); } catch { return false; }
  return realCwd === realData;
}

async function findRunArtifacts(root, depth = 0, found = { postmasterFiles: [], registryFiles: [] }) {
  if (depth > 8 || found.postmasterFiles.length + found.registryFiles.length >= 200) return found;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (found.postmasterFiles.length + found.registryFiles.length >= 200) break;
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await findRunArtifacts(path, depth + 1, found);
    else if (entry.isFile() && entry.name === "postmaster.pid") found.postmasterFiles.push(path);
    else if (entry.isFile() && entry.name === CLUSTER_REGISTRY_NAME) found.registryFiles.push(path);
  }
  return found;
}

/** Reads the attack kit's own cluster registry (see tests/support/attack-kit), so a
 *  cluster it started is reapable even if the recursive directory walk misses it. */
async function readClusterRegistryEntries(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch { return []; }
  const entries = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.port === "number" && typeof parsed.dataDirectory === "string") entries.push(parsed);
    } catch { /* a half-written line from a killed process is not a cluster */ }
  }
  return entries;
}

async function runUtility(executable, argv, environment, timeoutMs = 12_000) {
  return await new Promise(resolveResult => {
    const child = spawn(executable, argv, { env: environment, stdio: "ignore" });
    let settled = false;
    const finish = code => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(code); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
    child.once("error", () => finish(null));
    child.once("close", code => finish(code));
  });
}

async function stopOwnedPostgres(config, tempDirectory, ports, environment) {
  const stopped = [], errors = [];
  const artifacts = await findRunArtifacts(tempDirectory);
  const dataDirectories = new Set(artifacts.postmasterFiles.map(pidFile => dirname(pidFile)));
  const candidates = [...artifacts.postmasterFiles];
  for (const registryFile of artifacts.registryFiles) {
    for (const entry of await readClusterRegistryEntries(registryFile)) {
      if (dataDirectories.has(entry.dataDirectory)) continue;
      dataDirectories.add(entry.dataDirectory);
      candidates.push(join(entry.dataDirectory, "postmaster.pid"));
    }
  }
  for (const pidFile of candidates) {
    let lines;
    try { lines = (await readFile(pidFile, "utf8")).split(/\r?\n/u); } catch { continue; }
    const pid = Number(lines[0]), port = Number(lines[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(port) || port < ports.base || port > ports.end) continue;
    if (!(await ownsPostgresProcess(pid, dirname(pidFile)))) continue;
    const code = await runUtility(join(config.pgBin, "pg_ctl"), ["-D", dirname(pidFile), "stop", "-m", "immediate", "-w", "-t", "10"], environment);
    if (code === 0) stopped.push(port); else errors.push(port);
  }
  return { stopped, errors };
}

/** Kills any process (regardless of process group) whose cwd is under the run's
 *  temp directory — the last line of defense against a detached grandchild that
 *  escaped the runner child's process group by starting its own session. */
async function killByCwd(tempDirectory) {
  let real;
  try { real = await realpath(tempDirectory); } catch { return; }
  const prefix = real.endsWith(sep) ? real : `${real}${sep}`;
  // `lsof +D <dir>` walks the whole subtree looking for a match and can hang
  // for a long time (or on a directory Full Disk Access would gate). Instead,
  // list every process' cwd in one pass — a plain process-table read, not a
  // filesystem walk — and filter the (small) result ourselves.
  const entries = await new Promise(resolveResult => {
    const child = spawn("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", () => resolveResult(""));
    child.once("close", () => resolveResult(output));
  });
  let pid;
  for (const line of entries.split(/\r?\n/u)) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); continue; }
    if (!line.startsWith("n") || pid === undefined) continue;
    const cwd = line.slice(1);
    if (cwd === real || cwd.startsWith(prefix)) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") { /* best effort */ } }
    }
  }
}

function wait(milliseconds) {
  return new Promise(resolveResult => setTimeout(resolveResult, milliseconds));
}

function sandboxLiteral(value) {
  if (typeof value !== "string" || value.length === 0 || /["\\\n\r]/u.test(value)) {
    throw new Error("sandbox_path_invalid");
  }
  return value;
}

async function realDirectory(path) {
  try { return await realpath(path); } catch { return resolve(path); }
}

/**
 * Builds a per-run macOS Seatbelt (sandbox-exec) profile: writes only to the
 * worktree and this run's temp directory, no reading of the token file, audit
 * log, config, `~/.ssh`, keychains, or any configured protected prefix, and
 * network loopback only on this run's assigned port block. Everything else
 * stays at the default allow, because the outer host sandbox (not this
 * profile) is what bounds the helper; this profile's only job is to stop the
 * command it runs from stepping outside the worktree, the run, and its ports.
 */
async function buildSeatbeltProfile(config, { worktree, tempDirectory, ports }) {
  const worktreeReal = sandboxLiteral(await realpath(worktree));
  const tempReal = sandboxLiteral(await realpath(tempDirectory));
  const denyReadPrefixes = new Set();
  for (const candidate of [
    dirname(config.tokenFile),
    dirname(config.auditLog),
    dirname(config.configPath),
    join(homedir(), ".ssh"),
    join(homedir(), "Library", "Keychains"),
    ...(config.protectedReadPrefixes ?? []),
  ]) {
    const real = await realDirectory(candidate);
    // A `deny` on an ancestor of the worktree or this run's temp directory
    // cannot be safely undone by a narrower nested `allow`: Seatbelt still
    // denies plain traversal of the ancestor itself (needed to resolve any
    // path underneath it), which breaks reading the worktree/temp entirely
    // rather than just the protected prefix. Skip a candidate that overlaps
    // either one; a misconfigured protected prefix must not break the run.
    if (inside(real, worktreeReal) || inside(real, tempReal)) continue;
    denyReadPrefixes.add(sandboxLiteral(real));
  }
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${worktreeReal}") (subpath "${tempReal}") (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/")`
      + ` (regex #"^${ATTACK_KIT_SHORT_SOCKET_PATTERN}"))`,
    ...[...denyReadPrefixes].map(prefix => `(deny file-read* (subpath "${prefix}"))`),
    "(deny network-outbound (remote ip))",
    "(deny network-bind)",
    `(allow network-bind (local unix-socket (subpath "${tempReal}")))`,
    `(allow network-bind (local unix-socket (regex #"^${ATTACK_KIT_SHORT_SOCKET_PATTERN}")))`,
  ];
  for (let port = ports.base; port <= ports.end; port += 1) {
    lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
    lines.push(`(allow network-bind (local ip "localhost:${port}"))`);
  }
  return lines.join("\n");
}

export async function executeApprovedCommand(config, command, ports, { signal } = {}) {
  const tempDirectory = await mkdtemp("/tmp/acr-tr-");
  const environment = fixedEnvironment(config, ports, tempDirectory);
  const output = new BoundedOutput(config.maxOutputBytes);
  const startedAt = Date.now();
  let child, timeoutHandle, killHandle, timedOut = false, cancelled = false, stopStarted;
  const requestStop = reason => {
    if (stopStarted) return stopStarted;
    if (reason === "timeout") timedOut = true;
    if (reason === "cancel") cancelled = true;
    stopStarted = (async () => {
      if (!child?.pid) return;
      await stopOwnedPostgres(config, tempDirectory, ports, environment);
      signalGroup(child.pid, "SIGTERM");
      killHandle = setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
    })();
    return stopStarted;
  };
  const abort = () => { void requestStop("cancel"); };
  try {
    const profile = await buildSeatbeltProfile(config, { worktree: command.worktree, tempDirectory, ports });
    const completion = new Promise(resolveResult => {
      child = spawn(SANDBOX_EXEC, ["-p", profile, command.executable, ...command.argv], {
        cwd: command.worktree,
        detached: true,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", chunk => output.add(chunk));
      child.stderr.on("data", chunk => output.add(chunk));
      child.once("error", error => resolveResult({ code: null, signal: null, spawnError: error.message }));
      child.once("exit", (code, exitSignal) => {
        let settled = false, drainTimer;
        const finish = () => { if (settled) return; settled = true; clearTimeout(drainTimer); resolveResult({ code, signal: exitSignal }); };
        const remaining = new Set();
        for (const stream of [child.stdout, child.stderr]) {
          if (stream.closed) continue;
          remaining.add(stream);
          stream.once("close", () => { remaining.delete(stream); if (remaining.size === 0) finish(); });
        }
        if (remaining.size === 0) { finish(); return; }
        // The pipe stays open as long as ANY holder (including an escaped
        // detached grandchild) keeps its inherited fd — bound the wait rather
        // than let that grandchild block the run forever.
        drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, STOP_GRACE_MS);
      });
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    timeoutHandle = setTimeout(() => requestStop("timeout"), config.timeoutMs);
    const status = await completion;
    clearTimeout(timeoutHandle);
    await stopOwnedPostgres(config, tempDirectory, ports, environment);
    signalGroup(child.pid, "SIGTERM");
    await wait(25);
    signalGroup(child.pid, "SIGKILL");
    if (stopStarted) await stopStarted;
    clearTimeout(killHandle);
    await killByCwd(tempDirectory);
    const bounded = output.result();
    return Object.freeze({
      exitCode: status.code,
      signal: status.signal,
      spawnError: status.spawnError,
      timedOut,
      cancelled,
      durationMs: Date.now() - startedAt,
      ports,
      tap: tapSummary(bounded.text),
      outputBytes: bounded.totalBytes,
      outputTruncated: bounded.truncated,
      logExcerpt: bounded.text,
    });
  } finally {
    clearTimeout(timeoutHandle);
    clearTimeout(killHandle);
    signal?.removeEventListener("abort", abort);
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function appendAudit(config, entry) {
  await privateParent(config.auditLog);
  try {
    await requirePrivateRegularFile(config.auditLog, "audit_log");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      const handle = await open(config.auditLog, "wx", 0o600);
      await handle.close();
    } catch (createError) {
      if (createError.code !== "EEXIST") throw createError;
      await requirePrivateRegularFile(config.auditLog, "audit_log");
    }
  }
  await appendFile(config.auditLog, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > REQUEST_LIMIT_BYTES) throw new RunnerRefusal(413, "request_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new RunnerRefusal(400, "invalid_request"); }
}

function respond(response, status, body) {
  if (response.writableEnded) return;
  const serialized = JSON.stringify(body);
  try {
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(serialized), "cache-control": "no-store" });
    response.end(serialized);
  } catch { /* the client is already gone; nothing left to notify */ }
}

export async function createTestRunnerService(config) {
  const token = await readOrCreateToken(config.tokenFile);
  const ports = new PortPool(config.portPool);
  const activeRuns = new Map();
  let reservations = 0;
  const server = createServer(async (request, response) => {
    response.on("error", () => {});
    if (!authorized(request.headers.authorization, token)) {
      respond(response, 401, { error: "auth_refused" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/runs") {
      respond(response, 404, { error: "not_found" });
      return;
    }
    if (reservations >= config.concurrency) {
      respond(response, 429, { error: "concurrency_limit" });
      return;
    }
    reservations += 1;
    let command, body, portBlock;
    try {
      body = await requestBody(request);
      command = await resolveApprovedCommand(config, body);
      portBlock = ports.acquire();
      if (!portBlock) throw new RunnerRefusal(503, "port_pool_exhausted");
    } catch (error) {
      reservations -= 1;
      const refusal = error instanceof RunnerRefusal ? error : new RunnerRefusal(500, "internal_error");
      respond(response, refusal.status, { error: refusal.code });
      return;
    }
    const runId = randomUUID();
    const controller = new AbortController();
    const running = executeApprovedCommand(config, command, portBlock, { signal: controller.signal });
    activeRuns.set(runId, { controller, running });
    // A client that disconnects mid-run must not hold its slot and port block
    // until the timeout: abort the run the moment the connection is gone,
    // unless this handler already finished and closed it itself.
    const onResponseClose = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", onResponseClose);
    try {
      const result = await running;
      await appendAudit(config, {
        schema: "control-room.test-runner.audit/v1",
        at: new Date().toISOString(),
        runId,
        worktree: command.worktree,
        command: command.display,
        ports: portBlock,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        durationMs: result.durationMs,
        outputBytes: result.outputBytes,
      });
      respond(response, 200, { runId, command: command.display, ...result });
    } catch {
      respond(response, 500, { error: "run_failed", runId });
    } finally {
      response.removeListener("close", onResponseClose);
      activeRuns.delete(runId);
      ports.release(portBlock);
      reservations -= 1;
    }
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  return Object.freeze({
    server,
    activeRuns,
    async listen() {
      await new Promise((resolveReady, reject) => {
        server.once("error", reject);
        server.listen(config.port, LOOPBACK, () => { server.off("error", reject); resolveReady(); });
      });
      return server.address();
    },
    async close() {
      const closed = new Promise(resolveClosed => server.close(() => resolveClosed()));
      for (const run of activeRuns.values()) run.controller.abort();
      await Promise.allSettled([...activeRuns.values()].map(run => run.running));
      await closed;
    },
  });
}
