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
const CLUSTER_REGISTRY_NAME = "attack-kit-clusters.json";
const RUN_ID_VARIABLE = "CONTROL_ROOM_TEST_RUN_ID";
// Reads under these roots are denied by default (the service account's home
// is added at run time); only the run's own roots are opened back up. Seatbelt
// matches canonical paths, and /tmp is a symlink to /private/tmp.
const READ_DENIED_ROOTS = Object.freeze(["/private/tmp", "/private/var/folders", "/Volumes"]);
// Always unreadable and unwritable, even inside an allowed root: credentials,
// agent state, the private planning repo, and the live app's install folders.
const PROTECTED_HOME_ENTRIES = Object.freeze([
  ".config", ".claude", ".codex", ".pgpass", ".ssh", ".gnupg", ".aws", ".docker", ".kube",
  ".netrc", ".npmrc", ".git-credentials", ".gitconfig", "Library/Keychains",
  "work/acr-private",
]);
const PROTECTED_HOME_NAME_PREFIXES = Object.freeze(["work/acr-package-"]);
// The only programs a run may exec besides node and the PostgreSQL binaries.
// launchctl, open, osascript and ssh are deliberately absent. /bin/ps is too:
// it is setuid, and macOS refuses a setuid exec under any Seatbelt profile.
// lsof is absent because no test needs it and it maps every process's files.
const EXEC_ALLOWED_LITERALS = Object.freeze([
  "/bin/sh", "/bin/bash", "/bin/dash", "/bin/zsh", "/bin/cat", "/bin/echo", "/bin/kill", "/bin/ls",
  "/bin/mkdir", "/bin/rm", "/bin/sleep", "/usr/bin/env", "/usr/bin/false", "/usr/bin/ipcs",
  "/usr/bin/true", "/usr/bin/uname",
]);
// Services a child must never reach even though (deny default) already
// refuses them: launching work through launchd/LaunchServices is how a job
// would step outside this profile, because launchd spawns it unsandboxed.
const MACH_SERVICES_DENIED = Object.freeze([
  "com.apple.coreservices.launchservicesd", "com.apple.lsd.mapdb", "com.apple.lsd.open",
  "com.apple.coreservices.appleevents", "com.apple.xpc.smd", "com.apple.dnssd.service",
]);

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
  const tokenFile = absolutePath(raw.tokenFile, "tokenFile");
  const auditLog = absolutePath(raw.auditLog, "auditLog");
  // Fail closed: a protected folder that contains a worktree or /tmp could
  // only be enforced by also denying the run itself, so refuse it here rather
  // than let the profile quietly drop the deny (which would make it readable).
  const tmpReal = await realpath("/tmp");
  for (const [name, value] of [["tokenFile", dirname(tokenFile)], ["auditLog", dirname(auditLog)],
    ["configPath", dirname(configPath)], ...protectedReadPrefixes.map((prefix, index) => [`protectedReadPrefixes[${index}]`, prefix])]) {
    const real = await realpath(value).catch(() => value);
    const overlapsWorktree = allowedWorktreePrefixes.some(prefix => inside(real, dirname(prefix)) || real.startsWith(prefix));
    if (overlapsWorktree || inside(real, tmpReal)) throw new Error(`configuration_invalid: ${name} overlaps a sandbox root`);
  }
  return Object.freeze({
    schema: TEST_RUNNER_SCHEMA,
    configPath,
    port,
    tokenFile,
    auditLog,
    allowedWorktreePrefixes: Object.freeze(allowedWorktreePrefixes),
    protectedReadPrefixes: Object.freeze(protectedReadPrefixes),
    allowedScripts: Object.freeze(allowedScripts),
    sandboxHome: raw.sandboxHome === undefined ? homedir() : absolutePath(raw.sandboxHome, "sandboxHome"),
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
  #quarantined;
  #blockSize;

  constructor({ start, end, blockSize }) {
    this.#blockSize = blockSize;
    this.#free = new Set();
    this.#quarantined = new Set();
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
    if (!block) return;
    this.#quarantined.delete(block.base);
    this.#free.add(block.base);
  }

  /** Holds back a block something still has a socket on, until it is clear. */
  quarantine(block) {
    if (block) this.#quarantined.add(block.base);
  }

  quarantinedBlocks() {
    return [...this.#quarantined].map(base => Object.freeze({ base, end: base + this.#blockSize - 1 }));
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
    // Two reporter formats, because Node ships both and the default changed.
    //
    // `--test-reporter=tap` writes the spec's `# tests 1`; the DEFAULT reporter
    // (and therefore any plain `node --test` run) writes `ℹ tests 1` in this
    // Node version. Matching only the `#` form meant the summary of a perfectly
    // healthy run came back all zeros, and the caller had no way to tell that
    // apart from a run that produced no TAP at all.
    //
    // Both anchors are line-anchored and both require a whole number, so a count
    // embedded in prose or in a test name cannot be picked up. The last match
    // wins: a nested or repeated summary block ends with the outermost one, which
    // is the run's real total.
    const matches = [...text.matchAll(new RegExp(`^(?:#|ℹ) ${label} (\\d+)\\s*$`, "gmu"))];
    return matches.length ? Number(matches.at(-1)[1]) : 0;
  };
  const failing = [
    // Spec: `not ok 4 - name`. Default reporter: `✖ name (12ms)`, which has no
    // ordinal and a trailing duration.
    ...[...text.matchAll(/^\s*not ok \d+ - (.+)$/gmu)].map(match => match[1].trim()),
    ...[...text.matchAll(/^✖ (.+?) \(\d[\d.,]*(?:ms|s|m)\)$/gmu)].map(match => match[1].trim()),
  ].slice(0, 50);
  return Object.freeze({ tests: number("tests"), pass: number("pass"), fail: number("fail"), failingTests: failing });
}

function fixedEnvironment(config, ports, tempDirectory, runId) {
  const environment = {
    PATH: [...new Set([dirname(config.nodeBin), config.pgBin, "/usr/bin", "/bin"])].join(":"),
    PG_BIN: config.pgBin,
    CONTROL_ROOM_PG_TEST_PORT_BASE: String(ports.base),
    CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE: `${ports.base + 1}-${ports.end}`,
    [RUN_ID_VARIABLE]: runId,
    // The real home is unreadable inside the sandbox; point tools that look
    // for dotfiles (git, npm) at the run's own directory instead.
    HOME: tempDirectory,
    // Keep the attack kit's short Unix-socket directories inside this run.
    ATTACK_KIT_SOCKET_ROOT: tempDirectory,
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

async function stopOwnedPostgres(config, { tempDirectory, worktree }, ports, environment) {
  const stopped = [], errors = [];
  // Only a data directory that really lives in this run's own space may be
  // stopped: a registry line (or a symlink in the temp directory) pointing at
  // another cluster's data directory must never reach `pg_ctl stop`.
  const ownRoots = [];
  for (const root of [tempDirectory, worktree]) {
    try { ownRoots.push(await realpath(root)); } catch { /* gone already */ }
  }
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
    let dataDirectory;
    try { dataDirectory = await realpath(dirname(pidFile)); } catch { continue; }
    if (!ownRoots.some(root => inside(root, dataDirectory))) continue;
    let lines;
    try { lines = (await readFile(join(dataDirectory, "postmaster.pid"), "utf8")).split(/\r?\n/u); } catch { continue; }
    const pid = Number(lines[0]), port = Number(lines[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(port) || port < ports.base || port > ports.end) continue;
    if (!(await ownsPostgresProcess(pid, dataDirectory))) continue;
    const code = await runUtility(join(config.pgBin, "pg_ctl"), ["-D", dataDirectory, "stop", "-m", "immediate", "-w", "-t", "10"], environment);
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

/** Kills every process of this user that still carries this run's id in its
 *  environment: a detached grandchild keeps the worktree as its cwd and its
 *  own session, so neither the process-group kill nor `killByCwd` reaches it. */
async function killByRunMarker(runId) {
  const marker = `${RUN_ID_VARIABLE}=${runId}`;
  const argv = ["-Eww", "-o", "pid=,command="];
  if (typeof process.getuid === "function") argv.push("-U", String(process.getuid()));
  const listing = await new Promise(resolveResult => {
    const child = spawn("/bin/ps", argv, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", () => resolveResult(""));
    child.once("close", () => resolveResult(output));
  });
  for (const line of listing.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s(.*)$/u.exec(line);
    if (!match || !match[2].split(" ").includes(marker)) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/** True while any process holds a TCP socket on the block (or `lsof` cannot say). */
export async function portBlockHeld(block) {
  return await new Promise(resolveResult => {
    const child = spawn("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${block.base}-${block.end}`], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", () => resolveResult(true));
    child.once("close", code => resolveResult(output.trim().length > 0 || (code !== 0 && code !== 1)));
  });
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

/** Resolves as much of `path` as exists, keeping any missing tail as written. */
async function realExistingPrefix(path) {
  const absolute = resolve(path);
  try { return await realpath(absolute); } catch { /* resolve the parent instead */ }
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(await realExistingPrefix(parent), basename(absolute));
}

function sandboxRegexLiteral(value) {
  return sandboxLiteral(value).replace(/[.*+?^${}()|[\]]/gu, "\\$&");
}

function ancestors(path) {
  const result = [];
  for (let current = dirname(path); current !== dirname(current); current = dirname(current)) result.push(current);
  result.push("/");
  return result;
}

function refuseProfile() {
  return new RunnerRefusal(500, "sandbox_profile_invalid");
}

/**
 * Builds a per-run macOS Seatbelt (sandbox-exec) profile on `(deny default)`
 * (plus Apple's own `system.sb` base so dyld and libSystem work). The child:
 *
 *  - reads the system, but nothing under the service account's home, `/tmp`,
 *    `/var/folders` or `/Volumes`, except its worktree, this run's temp
 *    directory, and the node and PostgreSQL install trees; and never reads the
 *    runner's private files, the built-in credential/agent/live-app folders,
 *    or a configured protected prefix, even inside an allowed root;
 *  - writes only to its worktree and this run's temp directory;
 *  - connects only to loopback ports in its block and Unix sockets in its temp
 *    directory, and binds/listens only on those;
 *  - execs only node, the PostgreSQL binaries, esbuild from the worktree's
 *    node_modules, and a short list of shell tools (never launchctl or open);
 *  - reads argv, environment, open files and working directory only of
 *    processes in its own sandbox (never the service's, the live app's or an
 *    agent session's, whose environments hold credentials);
 *  - signals only processes in its own sandbox, and reaches only the mach
 *    services `system.sb` lists (never launchd job submission, LaunchServices
 *    or Apple Events), so it cannot hand work to anything unsandboxed.
 *
 * It fails closed: any protected folder that would contain one of the run's
 * own roots cannot be enforced without breaking the run, so the run is
 * refused instead of the deny being dropped.
 */
export async function buildSeatbeltProfile(config, { worktree, tempDirectory, ports }) {
  const worktreeReal = sandboxLiteral(await realpath(worktree));
  const tempReal = sandboxLiteral(await realpath(tempDirectory));
  const home = await realExistingPrefix(config.sandboxHome ?? homedir());
  const nodeReal = sandboxLiteral(await realpath(config.nodeBin));
  const nodeTree = sandboxLiteral(dirname(dirname(nodeReal)));
  const pgReal = sandboxLiteral(await realpath(config.pgBin));
  const pgTree = sandboxLiteral(dirname(pgReal));
  const readRoots = [worktreeReal, tempReal, nodeTree, pgTree];
  const deniedRoots = [home, ...READ_DENIED_ROOTS];
  // A toolchain tree that is (or contains) a denied root would reopen all of
  // it, for example a node binary installed as ~/bin/node.
  for (const tree of [nodeTree, pgTree]) {
    if (deniedRoots.some(root => inside(tree, root))) throw refuseProfile();
  }
  const protectedPaths = new Set();
  for (const candidate of [
    dirname(config.tokenFile),
    dirname(config.auditLog),
    dirname(config.configPath),
    ...PROTECTED_HOME_ENTRIES.map(entry => join(home, entry)),
    ...(config.protectedReadPrefixes ?? []),
  ]) {
    const real = await realExistingPrefix(candidate);
    if (readRoots.some(root => inside(real, root))) throw refuseProfile();
    protectedPaths.add(sandboxLiteral(real));
  }
  const protectedPatterns = PROTECTED_HOME_NAME_PREFIXES.map(prefix => `^${sandboxRegexLiteral(join(home, prefix))}`);
  for (const root of readRoots) {
    for (const prefix of PROTECTED_HOME_NAME_PREFIXES) {
      const relativeRoot = relative(home, root);
      if (inside(home, root) && `${relativeRoot}${sep}`.startsWith(prefix)) throw refuseProfile();
    }
  }
  const metadataOnly = new Set();
  for (const root of readRoots) for (const ancestor of ancestors(root)) metadataOnly.add(sandboxLiteral(ancestor));
  const protectedFilter = [
    ...[...protectedPaths].map(path => `(subpath "${path}")`),
    ...protectedPatterns.map(pattern => `(regex #"${pattern}")`),
  ].join(" ");
  const lines = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    `(allow process-exec (literal "${nodeReal}") (subpath "${pgReal}")`
      + ` ${EXEC_ALLOWED_LITERALS.map(path => `(literal "${path}")`).join(" ")}`
      + ` (regex #"^${sandboxRegexLiteral(worktreeReal)}/node_modules/(\\.pnpm/[^/]+/node_modules/)?@esbuild/darwin-[a-z0-9]+/bin/esbuild$"))`,
    "(allow signal (target same-sandbox))",
    // (deny default) does not cover process-info on this macOS, so deny it
    // explicitly, then reopen it for this run's own processes only. Measured:
    // the kernel hands out another process's argv and environment through
    // kern.procargs2 when EITHER process-info-pidinfo OR that sysctl-read is
    // allowed, so both denies below are needed; either alone leaks secrets.
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    // kern.proc.* is the process table (kern.proc.pid for this process still
    // works through the process-info allow above).
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs") (sysctl-name-prefix "kern.proc."))',
    // ipcs iterates SysV segments through these two write-shaped sysctls.
    '(allow sysctl-write (sysctl-name "kern.sysv.ipcs.shm") (sysctl-name "kern.sysv.ipcs.sem"))',
    "(allow ipc-sysv-shm ipc-sysv-sem ipc-posix-shm ipc-posix-sem)",
    "(allow file-read* file-map-executable)",
    `(deny file-read* file-map-executable ${deniedRoots.map(root => `(subpath "${sandboxLiteral(root)}")`).join(" ")})`,
    `(allow file-read* file-map-executable ${readRoots.map(root => `(subpath "${root}")`).join(" ")})`,
    `(allow file-read-metadata ${[...metadataOnly].map(path => `(literal "${path}")`).join(" ")})`,
    `(allow file-write* (subpath "${worktreeReal}") (subpath "${tempReal}") (literal "/dev/null") (literal "/dev/tty")`
      + ' (literal "/dev/dtracehelper") (subpath "/dev/fd"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))',
    `(deny file-read* file-write* file-map-executable ${protectedFilter})`,
    "(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6) (socket-domain AF_UNIX))",
    `(allow network-bind network-inbound (local unix-socket (subpath "${tempReal}")))`,
    `(allow network-outbound (remote unix-socket (subpath "${tempReal}")))`,
    `(deny mach-lookup ${MACH_SERVICES_DENIED.map(name => `(global-name "${name}")`).join(" ")})`,
    "(deny appleevent-send)",
    "(deny lsopen)",
  ];
  for (let port = ports.base; port <= ports.end; port += 1) {
    lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
    lines.push(`(allow network-bind network-inbound (local ip "localhost:${port}"))`);
  }
  return lines.join("\n");
}

export async function executeApprovedCommand(config, command, ports, { signal, runId = randomUUID() } = {}) {
  const tempDirectory = await mkdtemp("/tmp/acr-tr-");
  const environment = fixedEnvironment(config, ports, tempDirectory, runId);
  const runRoots = { tempDirectory, worktree: command.worktree };
  const output = new BoundedOutput(config.maxOutputBytes);
  const startedAt = Date.now();
  let child, timeoutHandle, killHandle, timedOut = false, cancelled = false, stopStarted;
  const requestStop = reason => {
    if (stopStarted) return stopStarted;
    if (reason === "timeout") timedOut = true;
    if (reason === "cancel") cancelled = true;
    stopStarted = (async () => {
      if (!child?.pid) return;
      await stopOwnedPostgres(config, runRoots, ports, environment);
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
    await stopOwnedPostgres(config, runRoots, ports, environment);
    signalGroup(child.pid, "SIGTERM");
    await wait(25);
    signalGroup(child.pid, "SIGKILL");
    if (stopStarted) await stopStarted;
    clearTimeout(killHandle);
    await killByCwd(tempDirectory);
    await killByRunMarker(runId);
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
    // Listen for a disconnect from the very start: a client that goes away
    // while its body is read or its command resolved must not start a run.
    const controller = new AbortController();
    const onResponseClose = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", onResponseClose);
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
      for (const block of ports.quarantinedBlocks()) {
        if (!(await portBlockHeld(block))) ports.release(block);
      }
      portBlock = ports.acquire();
      if (!portBlock) throw new RunnerRefusal(503, "port_pool_exhausted");
    } catch (error) {
      reservations -= 1;
      const refusal = error instanceof RunnerRefusal ? error : new RunnerRefusal(500, "internal_error");
      respond(response, refusal.status, { error: refusal.code });
      return;
    }
    if (controller.signal.aborted || response.destroyed) {
      ports.release(portBlock);
      reservations -= 1;
      return;
    }
    const runId = randomUUID();
    const running = executeApprovedCommand(config, command, portBlock, { signal: controller.signal, runId });
    activeRuns.set(runId, { controller, running });
    let status = 200, payload;
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
      payload = { runId, command: command.display, ...result };
    } catch (error) {
      status = error instanceof RunnerRefusal ? error.status : 500;
      payload = { error: error instanceof RunnerRefusal ? error.code : "run_failed", runId };
    }
    response.removeListener("close", onResponseClose);
    activeRuns.delete(runId);
    // A process that outlived every reaper and still holds a socket on the
    // block must not meet the next run there.
    try {
      if (await portBlockHeld(portBlock)) ports.quarantine(portBlock);
      else ports.release(portBlock);
    } finally {
      reservations -= 1;
    }
    respond(response, status, payload);
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
