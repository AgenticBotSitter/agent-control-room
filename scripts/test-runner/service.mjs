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
  if (!Array.isArray(raw.allowedScripts) || raw.allowedScripts.length === 0 ||
      raw.allowedScripts.some(value => typeof value !== "string" || !/^[a-z0-9][a-z0-9:._-]*$/u.test(value))) {
    throw new Error("configuration_invalid: allowedScripts");
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
  const pnpmBin = absolutePath(raw.pnpmBin, "pnpmBin");
  const pgBin = absolutePath(raw.pgBin, "pgBin");
  const nodeBin = raw.nodeBin === undefined ? process.execPath : absolutePath(raw.nodeBin, "nodeBin");
  for (const [name, path, directory] of [["pnpmBin", pnpmBin, false], ["pgBin", pgBin, true], ["nodeBin", nodeBin, false]]) {
    let details;
    try { details = await stat(path); } catch { throw new Error(`configuration_invalid: ${name}`); }
    if (directory ? !details.isDirectory() : !details.isFile()) throw new Error(`configuration_invalid: ${name}`);
  }
  const allowedWorktreePrefixes = [];
  for (const [index, value] of raw.allowedWorktreePrefixes.entries()) {
    allowedWorktreePrefixes.push(await canonicalPrefix(value, `allowedWorktreePrefixes[${index}]`));
  }
  return Object.freeze({
    schema: TEST_RUNNER_SCHEMA,
    configPath,
    port,
    tokenFile: absolutePath(raw.tokenFile, "tokenFile"),
    auditLog: absolutePath(raw.auditLog, "auditLog"),
    allowedWorktreePrefixes: Object.freeze(allowedWorktreePrefixes),
    allowedScripts: Object.freeze([...new Set(raw.allowedScripts)]),
    pnpmBin,
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
    if (typeof body.script !== "string" || !config.allowedScripts.includes(body.script)) {
      throw new RunnerRefusal(403, "command_refused");
    }
    const scripts = await packageScripts(worktree);
    if (typeof scripts[body.script] !== "string") throw new RunnerRefusal(403, "command_refused");
    return Object.freeze({ worktree, display: `pnpm run ${body.script}`, executable: config.pnpmBin,
      argv: Object.freeze(["run", body.script]) });
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
    PATH: [...new Set([dirname(config.nodeBin), dirname(config.pnpmBin), config.pgBin, "/usr/bin", "/bin"])].join(":"),
    PG_BIN: config.pgBin,
    CONTROL_ROOM_PG_TEST_PORT_BASE: String(ports.base),
    CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE: `${ports.base + 1}-${ports.end}`,
    TMPDIR: tempDirectory,
  };
  return Object.freeze(environment);
}

function signalGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function processGroup(pid) {
  return await new Promise(resolveResult => {
    const child = spawn("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", () => resolveResult(undefined));
    child.once("close", code => resolveResult(code === 0 && /^\s*\d+\s*$/u.test(output) ? Number(output.trim()) : undefined));
  });
}

async function findPostmasterFiles(root, depth = 0, found = []) {
  if (depth > 8 || found.length >= 100) return found;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (found.length >= 100) break;
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await findPostmasterFiles(path, depth + 1, found);
    else if (entry.isFile() && entry.name === "postmaster.pid") found.push(path);
  }
  return found;
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

async function stopOwnedPostgres(config, tempDirectory, ports, processGroupId, environment) {
  const stopped = [], errors = [];
  for (const pidFile of await findPostmasterFiles(tempDirectory)) {
    let lines;
    try { lines = (await readFile(pidFile, "utf8")).split(/\r?\n/u); } catch { continue; }
    const pid = Number(lines[0]), port = Number(lines[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(port) || port < ports.base || port > ports.end) continue;
    if (await processGroup(pid) !== processGroupId) continue;
    const code = await runUtility(join(config.pgBin, "pg_ctl"), ["-D", dirname(pidFile), "stop", "-m", "immediate", "-w", "-t", "10"], environment);
    if (code === 0) stopped.push(port); else errors.push(port);
  }
  return { stopped, errors };
}

function wait(milliseconds) {
  return new Promise(resolveResult => setTimeout(resolveResult, milliseconds));
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
      await stopOwnedPostgres(config, tempDirectory, ports, child.pid, environment);
      signalGroup(child.pid, "SIGTERM");
      killHandle = setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
    })();
    return stopStarted;
  };
  const abort = () => { void requestStop("cancel"); };
  try {
    const completion = new Promise(resolveResult => {
      child = spawn(command.executable, command.argv, {
        cwd: command.worktree,
        detached: true,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", chunk => output.add(chunk));
      child.stderr.on("data", chunk => output.add(chunk));
      child.once("error", error => resolveResult({ code: null, signal: null, spawnError: error.message }));
      child.once("close", (code, closeSignal) => resolveResult({ code, signal: closeSignal }));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    timeoutHandle = setTimeout(() => requestStop("timeout"), config.timeoutMs);
    const status = await completion;
    clearTimeout(timeoutHandle);
    await stopOwnedPostgres(config, tempDirectory, ports, child.pid, environment);
    signalGroup(child.pid, "SIGTERM");
    await wait(25);
    signalGroup(child.pid, "SIGKILL");
    if (stopStarted) await stopStarted;
    clearTimeout(killHandle);
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
  const serialized = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(serialized), "cache-control": "no-store" });
  response.end(serialized);
}

export async function createTestRunnerService(config) {
  const token = await readOrCreateToken(config.tokenFile);
  const ports = new PortPool(config.portPool);
  const activeRuns = new Map();
  let reservations = 0;
  const server = createServer(async (request, response) => {
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
