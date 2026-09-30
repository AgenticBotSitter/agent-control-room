#!/usr/bin/env node
// Control Room worker connector. One file, no dependencies, Node 20 or newer.
//
// It runs on a worker machine and only ever connects OUT to the Control Room
// fleet gateway. It never holds a database login or an owner session. Its one
// credential is generated here; only the credential's SHA-256 digest is sent
// to Control Room, and it is stored locally in a file only this user can read.
//
//   node connector.mjs join --server https://control.example --code crj_...
//   node connector.mjs status | rotate | run | work | claims | mcp
//
// "mcp" starts a Model Context Protocol server on stdin/stdout so any
// MCP-capable agent can list, claim and report work through the same queue,
// permissions and records as the website. It cannot approve, accept, merge or
// widen permissions: the gateway has no such routes.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join as joinPath, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const CONNECTOR_VERSION = "0.2.0";
const CONFIG_SCHEMA = "control-room.fleet-connector/v1";
const SECRET_PATTERN = /^crf_[A-Za-z0-9_-]{43}$/u;
const CODE_PATTERN = /^crj_[A-Za-z0-9_-]{43}$/u;
const WORKER_PATTERN = /^fleet-worker:[a-f0-9]{32}$/u;
const ROTATE_BEFORE_MS = 7 * 86_400_000;
const MEDIA_TYPES = Object.freeze({ ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown",
  ".csv": "text/csv", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".pdf": "application/pdf", ".srt": "text/plain", ".vtt": "text/plain" });
const MAX_FILE_BYTES = 262_144;
const MAX_RESULT_BYTES = 65_536;
const MAX_PROPOSAL_BYTES = 256 * 1024;
const MAX_MCP_MESSAGE_BYTES = 512 * 1024;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u;
const OFFER_PATTERN = /^fleet-offer:[a-f0-9]{32}$/u;
const CLAIM_PATTERN = /^fleet-claim:[a-f0-9]{32}$/u;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/u;

export const sha256 = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const newSecret = () => `crf_${randomBytes(32).toString("base64url")}`;
export const newEnrollmentNonce = () => `crn_${randomBytes(32).toString("base64url")}`;

export function platformName(value = process.platform) {
  return value === "darwin" ? "macos" : value === "win32" ? "windows" : value === "linux" ? "linux" : "other";
}

export function defaultConfigPath(env = process.env) {
  if (env.CONTROL_ROOM_CONNECTOR_CONFIG) return resolve(env.CONTROL_ROOM_CONNECTOR_CONFIG);
  if (process.platform === "win32" && env.APPDATA) return joinPath(env.APPDATA, "control-room", "connector.json");
  return joinPath(env.XDG_CONFIG_HOME || joinPath(homedir(), ".config"), "control-room", "connector.json");
}

/** HTTPS is required, except loopback and the Tailscale address range, whose
 * traffic is already end-to-end encrypted by WireGuard. */
export function checkServer(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("The server address is not a valid URL."); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Error("Use only the server address, for example https://control.example");
  const host = url.hostname;
  const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/u.test(host);
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || tailnet)))
    throw new Error("The server must use https:// (plain http is allowed only on this machine or a Tailscale address).");
  return url.origin;
}

async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

export async function loadConfig(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); } catch { throw new Error("This machine has not joined yet. Run: join --server <address> --code <code>"); }
  if (process.platform !== "win32") {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) throw new Error(`The credential file ${path} is readable by other users. Run: chmod 600 ${path}`);
  }
  const config = JSON.parse(raw);
  if (config.schema !== CONFIG_SCHEMA || !SECRET_PATTERN.test(config.secret ?? "")
    || (config.workerId !== null && !WORKER_PATTERN.test(config.workerId ?? ""))) throw new Error("The credential file is not valid.");
  checkServer(config.server);
  return config;
}

export function createClient(config, fetcher = globalThis.fetch) {
  async function call(method, path, body, secret = config.secret, extraHeaders = {}) {
    const response = await fetcher(`${config.server}${path}`, { method, redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(config.workerId ? { "x-control-room-worker": config.workerId } : {}),
        ...extraHeaders,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let value;
    try { value = await response.json(); } catch { value = {}; }
    if (!response.ok || value.ok !== true) {
      const error = new Error(`Control Room refused the request (${value.error ?? response.status}).`);
      error.code = value.error ?? `http_${response.status}`;
      throw error;
    }
    return value.result;
  }
  return Object.freeze({
    enroll: body => call("POST", "/fleet/v1/enroll", body, null),
    me: () => call("GET", "/fleet/v1/me"),
    heartbeat: (adapterCapabilities = []) => call("POST", "/fleet/v1/heartbeat",
      { connectorVersion: CONNECTOR_VERSION, platform: platformName(), adapterCapabilities }),
    rotate: (digest, secret) => call("POST", "/fleet/v1/rotate", { newCredentialDigest: digest }, secret),
    work: () => call("GET", "/fleet/v1/work"),
    claims: () => call("GET", "/fleet/v1/claims"),
    claim: (offerId, idempotencyKey) => call("POST", "/fleet/v1/claims", { offerId, idempotencyKey }),
    progress: (claimId, message, idempotencyKey) => call("POST", `/fleet/v1/claims/${claimId}/progress`, { message, idempotencyKey }),
    blocker: (claimId, message, idempotencyKey, release) => call("POST", `/fleet/v1/claims/${claimId}/blocker`,
      { message, idempotencyKey, ...(release ? { release: true } : {}) }),
    result: (claimId, summary, files, idempotencyKey) => call("POST", `/fleet/v1/claims/${claimId}/result`,
      { summary, idempotencyKey, ...(files.length ? { files } : {}) }),
    propose: (projectId, proposal, idempotencyKey) => call("POST",
      `/fleet/v1/projects/${encodeURIComponent(projectId)}/proposals`, { proposal, idempotencyKey }),
    mcpCall: (callId, toolName) => call("POST", "/fleet/v1/mcp/calls", { callId, toolName }, config.secret,
      { "x-control-room-mcp-call": callId, "x-control-room-mcp-tool": toolName }),
  });
}

/** @param {{ server: string, code: string, configPath: string, fetcher?: typeof fetch }} options */
export async function join({ server, code, configPath, fetcher }) {
  const origin = checkServer(server);
  if (!CODE_PATTERN.test(code ?? "")) throw new Error("The join code is not valid. Copy it again from the Workers page.");
  const tools = await loadToolAdapters(defaultToolAdaptersPath(configPath));
  const codeDigest = sha256(code);
  let pending;
  try {
    await stat(configPath);
    pending = await loadConfig(configPath);
  } catch (error) {
    if ((error?.code ?? "") !== "ENOENT" && !String(error?.message ?? "").startsWith("This machine has not joined yet.")) throw error;
  }
  if (pending?.workerId) throw new Error("This machine has already joined. Use status or rotate instead.");
  if (pending && (pending.server !== origin || pending.codeDigest !== codeDigest
    || !/^crn_[A-Za-z0-9_-]{43}$/u.test(pending.clientNonce ?? "")))
    throw new Error("A different join is already pending in this credential file. Finish it with the original server and code.");
  const secret = pending?.secret ?? newSecret();
  const clientNonce = pending?.clientNonce ?? newEnrollmentNonce();
  // The secret, code binding and nonce are saved before use. A lost response
  // retries this exact enrollment instead of consuming a second credential.
  await writePrivate(configPath, { schema: CONFIG_SCHEMA, server: origin, workerId: null, secret,
    credentialExpiresAt: null, codeDigest, clientNonce });
  const client = createClient({ server: origin, workerId: null, secret }, fetcher);
  const result = await client.enroll({ code, credentialDigest: sha256(secret), platform: platformName(),
    architecture: process.arch, connectorVersion: CONNECTOR_VERSION, clientNonce,
    adapterCapabilities: tools?.capabilities ?? [] });
  await writePrivate(configPath, { schema: CONFIG_SCHEMA, server: origin, workerId: result.workerId, secret,
    credentialExpiresAt: result.credentialExpiresAt });
  return result;
}

/** Rotation keeps the next secret on disk first; if the reply is lost the
 * connector tries it on the next start. */
/** @param {{ configPath: string, fetcher?: typeof fetch }} options */
export async function rotate({ configPath, fetcher }) {
  const config = await loadConfig(configPath);
  const next = newSecret();
  await writePrivate(configPath, { ...config, pendingSecret: next });
  const result = await createClient(config, fetcher).rotate(sha256(next), config.secret);
  const { pendingSecret: _pending, ...rest } = config;
  await writePrivate(configPath, { ...rest, secret: next, credentialExpiresAt: result.credentialExpiresAt });
  return result;
}

/** @param {{ configPath: string, fetcher?: typeof fetch }} options */
export async function recoverPending({ configPath, fetcher }) {
  const config = await loadConfig(configPath);
  if (!config.pendingSecret || !SECRET_PATTERN.test(config.pendingSecret)) return config;
  try { await createClient(config, fetcher).me(); const { pendingSecret: _p, ...rest } = config;
    await writePrivate(configPath, rest); return rest; }
  catch {
    const promoted = { ...config, secret: config.pendingSecret };
    const me = await createClient(promoted, fetcher).me();
    const { pendingSecret: _p, ...rest } = promoted;
    await writePrivate(configPath, { ...rest, credentialExpiresAt: me.credentialExpiresAt });
    return { ...rest, credentialExpiresAt: me.credentialExpiresAt };
  }
}

export function idempotencyKeyFor(tool, args) {
  return `mcp-${createHash("sha256").update(JSON.stringify([tool, args])).digest("hex").slice(0, 40)}`;
}

/** Reads a result file only from inside the workspace directory, never
 * through a link that escapes it, and never beyond the size limit. */
export async function workspaceFile(root, relative) {
  if (typeof relative !== "string" || !relative) throw new Error("A file path is required.");
  const base = await realpath(root);
  const target = await realpath(resolve(base, relative));
  if (target !== base && !target.startsWith(base + sep)) throw new Error("Only files inside the workspace can be attached.");
  const mediaType = MEDIA_TYPES[extname(target).toLowerCase()];
  if (!mediaType) throw new Error("That file type cannot be attached.");
  const info = await stat(target);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Attached files must be regular files of at most 256 KiB.");
  const name = basename(target).replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^[^A-Za-z0-9]+/u, "").slice(0, 120) || "file";
  return { name, mediaType, contentBase64: (await readFile(target)).toString("base64") };
}

// ---------------------------------------------------------------------------
// MCP server (stdio, newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------
const noAuthority = "It uses this machine's own worker credential and grants nothing: it cannot approve, accept, merge, grant or widen permissions.";
export const MCP_TOOLS = Object.freeze([
  { name: "list_eligible_work", description: `List tasks this worker may claim now (its projects and capabilities only). ${noAuthority}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "claim", description: `Claim one listed task. Creates a time-limited lease through the normal queue; retrying with the same arguments returns the same claim. ${noAuthority}`,
    inputSchema: { type: "object", properties: { offerId: { type: "string" }, idempotencyKey: { type: "string" } },
      required: ["offerId"], additionalProperties: false } },
  { name: "post_progress", description: `Post a short progress note on a claimed task. This also keeps the lease alive. ${noAuthority}`,
    inputSchema: { type: "object", properties: { claimId: { type: "string" }, message: { type: "string", maxLength: 2000 },
      idempotencyKey: { type: "string" } }, required: ["claimId", "message"], additionalProperties: false } },
  { name: "submit_result", description: `Submit the result of a claimed task for owner review: an answer (at most 64 KiB) and up to 8 files (256 KiB each, 1 MiB total) from inside the current workspace. The owner decides; submitting does not accept anything. ${noAuthority}`,
    inputSchema: { type: "object", properties: { claimId: { type: "string" }, answer: { type: "string", maxLength: MAX_RESULT_BYTES },
      files: { type: "array", maxItems: 8, items: { type: "string", description: "Path relative to the workspace." } },
      idempotencyKey: { type: "string" } }, required: ["claimId", "answer"], additionalProperties: false } },
  { name: "report_blocker", description: `Report that a claimed task is blocked. Set release to true to hand it back for another worker. Nothing is marked done. ${noAuthority}`,
    inputSchema: { type: "object", properties: { claimId: { type: "string" }, message: { type: "string", maxLength: 2000 },
      release: { type: "boolean" }, idempotencyKey: { type: "string" } }, required: ["claimId", "message"], additionalProperties: false } },
  { name: "propose_work", description: `Propose S1 work for the owner to approve. It never creates a task, lease or execution and never starts work by itself. ${noAuthority}`,
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, proposal: { type: "object" },
      idempotencyKey: { type: "string" } }, required: ["projectId", "proposal"], additionalProperties: false } },
]);

function validIdempotency(value) {
  return value === undefined || typeof value === "string" && IDEMPOTENCY_PATTERN.test(value);
}

function validateMcpArguments(name, args) {
  const plain = args && typeof args === "object" && !Array.isArray(args)
    && (Object.getPrototypeOf(args) === Object.prototype || Object.getPrototypeOf(args) === null);
  if (!plain) return false;
  const tool = MCP_TOOLS.find(value => value.name === name);
  if (!tool) return false;
  const allowed = Object.keys(tool.inputSchema.properties);
  if (Object.keys(args).some(key => !allowed.includes(key))
    || (tool.inputSchema.required ?? []).some(key => !(key in args)) || !validIdempotency(args.idempotencyKey)) return false;
  if (name === "list_eligible_work") return Object.keys(args).length === 0;
  if (name === "claim") return typeof args.offerId === "string" && OFFER_PATTERN.test(args.offerId);
  if (name === "post_progress" || name === "report_blocker") return typeof args.claimId === "string"
    && CLAIM_PATTERN.test(args.claimId) && typeof args.message === "string" && args.message.trim().length > 0
    && args.message.length <= 2000 && (name !== "report_blocker" || args.release === undefined || typeof args.release === "boolean");
  if (name === "submit_result") return typeof args.claimId === "string" && CLAIM_PATTERN.test(args.claimId)
    && typeof args.answer === "string" && args.answer.trim().length > 0
    && Buffer.byteLength(args.answer, "utf8") <= MAX_RESULT_BYTES
    && (args.files === undefined || Array.isArray(args.files) && args.files.length <= 8
      && args.files.every(path => typeof path === "string" && path.length > 0));
  if (name === "propose_work") return typeof args.projectId === "string" && PROJECT_PATTERN.test(args.projectId)
    && args.proposal && typeof args.proposal === "object" && !Array.isArray(args.proposal)
    && Buffer.byteLength(JSON.stringify(args.proposal), "utf8") <= MAX_PROPOSAL_BYTES;
  return false;
}

export function createMcpDispatcher({ client, workspaceRoot }) {
  const key = (tool, args) => typeof args.idempotencyKey === "string" ? args.idempotencyKey
    : idempotencyKeyFor(tool, Object.fromEntries(Object.entries(args).filter(([k]) => k !== "idempotencyKey")));
  const tools = {
    list_eligible_work: () => client.work(),
    claim: args => client.claim(args.offerId, key("claim", args)),
    post_progress: args => client.progress(args.claimId, args.message, key("progress", args)),
    submit_result: async args => {
      const files = [];
      for (const path of args.files ?? []) files.push(await workspaceFile(workspaceRoot, path));
      return client.result(args.claimId, args.answer, files, key("result", args));
    },
    report_blocker: args => client.blocker(args.claimId, args.message, key("blocker", args), args.release === true),
    propose_work: args => client.propose(args.projectId, args.proposal, key("propose", args)),
  };
  return async function dispatch(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return message && "id" in message ? { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "Invalid request" } } : null;
    }
    const reply = result => ({ jsonrpc: "2.0", id: message.id, result });
    if (!("id" in message)) return null; // notifications need no reply
    switch (message.method) {
      case "initialize": return reply({ protocolVersion: typeof message.params?.protocolVersion === "string"
        ? message.params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "control-room", version: CONNECTOR_VERSION },
        instructions: "Control Room work queue for this machine. Claim work, post progress, submit results for owner review. You cannot approve or accept work." });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: MCP_TOOLS });
      case "tools/call": {
        const name = message.params?.name, args = message.params?.arguments ?? {};
        const tool = MCP_TOOLS.find(value => value.name === name);
        try {
          const callId = `mcp-call:${randomBytes(16).toString("hex")}`;
          await client.mcpCall(callId, tool ? name : "unsupported");
          if (!tool) return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool" } };
          if (!validateMcpArguments(name, args))
            return reply({ isError: true, content: [{ type: "text", text: "The arguments do not match this tool." }] });
          const value = await tools[name](args);
          return reply({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } });
        } catch (error) {
          return reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Request failed." }] });
        }
      }
      default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
    }
  };
}

/** @param {{ configPath: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, fetcher?: typeof fetch, workspaceRoot?: string }} options */
export async function serveMcp({ configPath, input = process.stdin, output = process.stdout, fetcher, workspaceRoot = process.cwd() }) {
  const config = await recoverPending({ configPath, fetcher });
  const dispatch = createMcpDispatcher({ client: createClient(config, fetcher), workspaceRoot });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_MCP_MESSAGE_BYTES) {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } })}\n`);
      continue;
    }
    let message;
    try { message = JSON.parse(line); }
    catch { output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); continue; }
    const response = await dispatch(message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Owner-written local tool adapters
// ---------------------------------------------------------------------------
const TOOL_ADAPTERS_SCHEMA = "control-room.local-tool-adapters/v1";
const TOOL_ADAPTER_ID_PATTERN = /^[a-z][a-z0-9_-]{1,39}$/u;
const TOOL_PLACEHOLDER_PATTERN = /^\{(input|output):([a-z][a-z0-9_-]{0,39})\}$/u;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const SHELL_META_PATTERN = /[;&|`$<>\\\r\n]/u;
const MAX_TOOL_OUTPUT_BYTES = 1_048_576;
const MAX_TOOL_OUTPUT_FILES = 8;
const TOOL_KILL_GRACE_MS = 250;

export function defaultToolAdaptersPath(configPath) {
  return joinPath(dirname(configPath), "tool-adapters.json");
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).every(key => keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}

function manifestError(detail) {
  return new Error(`The tool adapter manifest is not valid: ${detail}.`);
}

/** Reads the machine owner's local executable allowlist. The fixed path is
 * beside the connector credential; neither Control Room nor task text can
 * name another manifest. A missing file means no local tool is enabled. */
export async function loadToolAdapters(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw new Error(`The tool adapter manifest ${path} cannot be read.`); }
  await refuseSharedWrite(path, "The tool adapter manifest");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The tool adapter manifest is not valid JSON."); }
  if (!exactKeys(value, ["schema", "maxConcurrent", "adapters"]) || value.schema !== TOOL_ADAPTERS_SCHEMA)
    throw manifestError(`schema must be "${TOOL_ADAPTERS_SCHEMA}" and only schema, maxConcurrent and adapters are allowed`);
  if (!Number.isSafeInteger(value.maxConcurrent) || value.maxConcurrent < 1 || value.maxConcurrent > 32)
    throw manifestError("maxConcurrent must be 1 to 32");
  if (!Array.isArray(value.adapters) || value.adapters.length < 1 || value.adapters.length > 32)
    throw manifestError("adapters must contain 1 to 32 entries");
  const adapters = new Map();
  for (const candidate of value.adapters) {
    const keys = ["id", "capability", "executable", "arguments", "timeoutMs", "maxOutputBytes", "envAllowlist"];
    if (!exactKeys(candidate, keys)) throw manifestError(`each adapter must contain exactly ${keys.join(", ")}`);
    if (typeof candidate.id !== "string" || !TOOL_ADAPTER_ID_PATTERN.test(candidate.id))
      throw manifestError("adapter id must use lowercase letters, digits, underscores or hyphens");
    if (adapters.has(candidate.id)) throw manifestError(`duplicate adapter id "${candidate.id}"`);
    if (typeof candidate.capability !== "string" || !CAPABILITY_PATTERN.test(candidate.capability))
      throw manifestError(`${candidate.id}.capability is invalid`);
    if (!absolutePath(candidate.executable)) throw manifestError(`${candidate.id}.executable must be an absolute path`);
    const executableInfo = await refuseSharedWrite(candidate.executable, `The tool executable for ${candidate.id}`);
    if (process.platform !== "win32" && (executableInfo.mode & 0o111) === 0)
      throw manifestError(`${candidate.id}.executable is not executable`);
    if (!Array.isArray(candidate.arguments) || candidate.arguments.length < 2 || candidate.arguments.length > 64
      || candidate.arguments.some(argument => typeof argument !== "string" || !argument || argument.length > 1024))
      throw manifestError(`${candidate.id}.arguments must contain 2 to 64 non-empty strings`);
    const placeholders = candidate.arguments.map(argument => TOOL_PLACEHOLDER_PATTERN.exec(argument));
    if (candidate.arguments.some((argument, index) => !placeholders[index] && (SHELL_META_PATTERN.test(argument)
      || argument.includes("{") || argument.includes("}"))))
      throw manifestError(`${candidate.id}.arguments contains shell metacharacters or a partial placeholder`);
    const inputNames = [...new Set(placeholders.filter(match => match?.[1] === "input").map(match => match[2]))];
    const outputNames = [...new Set(placeholders.filter(match => match?.[1] === "output").map(match => match[2]))];
    if (inputNames.length === 0 || outputNames.length === 0)
      throw manifestError(`${candidate.id}.arguments must contain named input and output placeholders`);
    if (!Number.isSafeInteger(candidate.timeoutMs) || candidate.timeoutMs < 100 || candidate.timeoutMs > 3_600_000)
      throw manifestError(`${candidate.id}.timeoutMs must be 100 to 3600000`);
    if (!Number.isSafeInteger(candidate.maxOutputBytes) || candidate.maxOutputBytes < 1
      || candidate.maxOutputBytes > MAX_TOOL_OUTPUT_BYTES)
      throw manifestError(`${candidate.id}.maxOutputBytes must be 1 to ${MAX_TOOL_OUTPUT_BYTES}`);
    if (!Array.isArray(candidate.envAllowlist) || candidate.envAllowlist.length > 32
      || candidate.envAllowlist.some(name => typeof name !== "string" || !ENV_NAME_PATTERN.test(name))
      || new Set(candidate.envAllowlist).size !== candidate.envAllowlist.length)
      throw manifestError(`${candidate.id}.envAllowlist must contain at most 32 unique environment variable names`);
    adapters.set(candidate.id, Object.freeze({ ...candidate, arguments: Object.freeze([...candidate.arguments]),
      envAllowlist: Object.freeze([...candidate.envAllowlist]), inputNames: Object.freeze(inputNames),
      outputNames: Object.freeze(outputNames) }));
  }
  return Object.freeze({ maxConcurrent: value.maxConcurrent, adapters,
    capabilities: Object.freeze([...new Set([...adapters.values()].map(adapter => adapter.capability))].sort()) });
}

function safeInputName(value, fallback) {
  const cleaned = basename(typeof value === "string" ? value : "").replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/^[^A-Za-z0-9]+/u, "").slice(0, 100);
  return cleaned || `${fallback}.input`;
}

function toolError(code, message) {
  const error = new Error(message); error.code = code; return error;
}

function killToolProcess(child, signal = "SIGTERM") {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

async function collectToolOutputs(root, declaredRoots, limit, needles) {
  const files = [];
  let total = 0;
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = joinPath(folder, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw toolError("tool_adapter_output_invalid", "Tool output may not contain symbolic links.");
      if (info.isDirectory()) { await walk(path); continue; }
      if (!info.isFile()) throw toolError("tool_adapter_output_invalid", "Tool output must contain only regular files.");
      total += info.size;
      if (files.length >= MAX_TOOL_OUTPUT_FILES || info.size > limit || total > limit)
        throw toolError("tool_adapter_output_too_large", "Tool output exceeded its declared size or file-count limit.");
      const content = await readFile(path);
      if (containsSecret(content.toString("utf8"), needles))
        throw toolError("tool_adapter_secret_refused", "Tool output contained secret material and was not uploaded.");
      const mediaType = MEDIA_TYPES[extname(entry.name).toLowerCase()];
      if (!mediaType) throw toolError("tool_adapter_output_invalid", "Tool output included a file type Control Room cannot upload.");
      const name = relative(root, path).split(sep).join("__").replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
      files.push(Object.freeze({ name, mediaType, contentBase64: content.toString("base64") }));
    }
  }
  for (const declared of declaredRoots) await walk(declared);
  return Object.freeze(files);
}

function acquireSlot(state, signal) {
  if (signal?.aborted) return Promise.reject(toolError("tool_adapter_aborted", "The tool run was stopped before it began."));
  if (state.active < state.limit) { state.active += 1; return Promise.resolve(); }
  return new Promise((resolveSlot, reject) => {
    const queued = { resolve: resolveSlot, reject, signal, onAbort: undefined };
    queued.onAbort = () => { const index = state.queue.indexOf(queued); if (index >= 0) state.queue.splice(index, 1);
      reject(toolError("tool_adapter_aborted", "The tool run was stopped before it began.")); };
    signal?.addEventListener("abort", queued.onAbort, { once: true });
    state.queue.push(queued);
  });
}

function releaseSlot(state) {
  const next = state.queue.shift();
  if (next) { next.signal?.removeEventListener("abort", next.onAbort); next.resolve(); }
  else state.active -= 1;
}

/** Creates one per-machine runner. Calls beyond maxConcurrent wait locally;
 * they do not start extra processes. Task data supplies bytes for declared
 * input names only and never contributes executable or argument syntax. */
export function createLocalToolAdapterRunner(registry, options = {}) {
  if (!registry?.adapters || !Number.isSafeInteger(registry.maxConcurrent)) throw new Error("tool_adapter_registry_invalid");
  const state = { active: 0, limit: registry.maxConcurrent, queue: [] };
  const spawner = options.spawner ?? spawn;
  const environment = options.environment ?? process.env;
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const secrets = options.secrets ?? [];
  return Object.freeze({
    get active() { return state.active; },
    async execute(task, signal) {
      const adapter = typeof task?.adapterId === "string" ? registry.adapters.get(task.adapterId) : undefined;
      if (!adapter) throw toolError("tool_adapter_unknown", "This machine has no owner-declared adapter with that id.");
      if (!exactKeys(task, ["adapterId", "inputs"]) || !plainObject(task.inputs)
        || Object.keys(task.inputs).sort().join("\0") !== [...adapter.inputNames].sort().join("\0"))
        throw toolError("tool_adapter_input_invalid", "The tool task inputs do not match the adapter manifest.");
      await acquireSlot(state, signal);
      let work;
      try {
        work = await mkdtemp(joinPath(temporaryRoot, "control-room-tool-"));
        await chmod(work, 0o700).catch(() => {});
        const inputRoot = joinPath(work, "inputs"), outputRoot = joinPath(work, "outputs");
        await mkdir(inputRoot, { recursive: true, mode: 0o700 });
        await mkdir(outputRoot, { recursive: true, mode: 0o700 });
        const inputPaths = new Map(), outputPaths = new Map();
        for (const name of adapter.inputNames) {
          const input = task.inputs[name];
          if (!plainObject(input) || typeof input.contentBase64 !== "string" || input.contentBase64.length > 2_000_000
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.contentBase64))
            throw toolError("tool_adapter_input_invalid", `Input ${name} is not valid base64 file data.`);
          const folder = joinPath(inputRoot, name); await mkdir(folder, { mode: 0o700 });
          const path = joinPath(folder, safeInputName(input.name, name));
          await writeFile(path, Buffer.from(input.contentBase64, "base64"), { mode: 0o600, flag: "wx" });
          inputPaths.set(name, path);
        }
        for (const name of adapter.outputNames) {
          const path = joinPath(outputRoot, name); await mkdir(path, { mode: 0o700 }); outputPaths.set(name, path);
        }
        const argv = adapter.arguments.map(argument => {
          const match = TOOL_PLACEHOLDER_PATTERN.exec(argument);
          return !match ? argument : match[1] === "input" ? inputPaths.get(match[2]) : outputPaths.get(match[2]);
        });
        const env = {};
        for (const name of adapter.envAllowlist) if (typeof environment[name] === "string") env[name] = environment[name];
        const child = spawner(adapter.executable, argv, { cwd: work, env, shell: false,
          detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "", stderr = "", timedOut = false, overflow = false, stopped = false, killTimer;
        const append = (which, chunk) => {
          const next = (which === "stdout" ? stdout : stderr) + chunk.toString("utf8");
          if (Buffer.byteLength(next, "utf8") > adapter.maxOutputBytes) { overflow = true; terminate(); }
          else if (which === "stdout") stdout = next; else stderr = next;
        };
        child.stdout?.on("data", chunk => append("stdout", chunk));
        child.stderr?.on("data", chunk => append("stderr", chunk));
        const terminate = () => { killToolProcess(child);
          killTimer ??= setTimeout(() => killToolProcess(child, "SIGKILL"), TOOL_KILL_GRACE_MS); };
        const stop = () => { stopped = true; terminate(); };
        signal?.addEventListener("abort", stop, { once: true });
        const timeout = setTimeout(() => { timedOut = true; terminate(); }, adapter.timeoutMs);
        const result = await new Promise((resolveProcess, reject) => {
          child.once("error", reject);
          child.once("close", (code, processSignal) => resolveProcess({ code, signal: processSignal }));
        }).finally(() => { clearTimeout(timeout); signal?.removeEventListener("abort", stop); });
        if (timedOut || stopped || overflow) {
          await new Promise(done => setTimeout(done, TOOL_KILL_GRACE_MS));
          clearTimeout(killTimer); killToolProcess(child, "SIGKILL");
        } else clearTimeout(killTimer);
        if (timedOut) throw toolError("tool_adapter_timeout", "The local tool exceeded its owner-declared time limit.");
        if (stopped) throw toolError("tool_adapter_aborted", "The local tool was stopped.");
        if (overflow) throw toolError("tool_adapter_output_too_large", "The local tool wrote too much process output.");
        if (result.code !== 0) throw toolError("tool_adapter_failed", "The local tool exited without completing successfully.");
        const needles = secretNeedles(secrets);
        if (containsSecret(stdout, needles) || containsSecret(stderr, needles))
          throw toolError("tool_adapter_secret_refused", "The local tool output contained secret material and was not uploaded.");
        const files = await collectToolOutputs(outputRoot, [...outputPaths.values()], adapter.maxOutputBytes, needles);
        const reported = storableText(stdout);
        const summary = reported && Buffer.byteLength(reported, "utf8") <= MAX_RESULT_BYTES
          ? reported : `Local tool ${adapter.id} completed.`;
        return Object.freeze({ adapterId: adapter.id, capability: adapter.capability, summary, files });
      } finally {
        if (work) await rm(work, { recursive: true, force: true });
        releaseSlot(state);
      }
    },
  });
}

/** Executes one already-authorized tool claim and returns its collected files
 * through the ordinary owner-review result route. Refusals hand the claim
 * back; they never become a successful result. */
export async function runClaimedToolTask({ client, claim, runner, signal, secrets = [] }) {
  const keyBase = `tool-${claim.claimId.slice("fleet-claim:".length)}`;
  const outcome = { claimId: claim.claimId, jobId: claim.jobId };
  const safeCode = error => /^tool_adapter_[a-z_]+$/u.test(error?.code ?? "") ? error.code : "tool_adapter_failed";
  try { await report(() => client.progress(claim.claimId, "Started the owner-declared local tool on this machine.", `${keyBase}-start`)); }
  catch (error) { return Object.freeze({ ...outcome, outcome: "abandoned", reason: error?.code ?? "unreachable" }); }
  try {
    const result = await runner.execute({ adapterId: claim.adapterId, inputs: claim.inputs }, signal);
    const needles = secretNeedles(secrets);
    if (containsSecret(result.summary, needles) || result.files.some(file =>
      containsSecret(Buffer.from(file.contentBase64, "base64").toString("utf8"), needles)))
      throw toolError("tool_adapter_secret_refused", "Tool output contained secret material and was not uploaded.");
    const stored = await report(() => client.result(claim.claimId, result.summary, result.files, `${keyBase}-result`));
    return Object.freeze({ ...outcome, outcome: "submitted", resultId: stored.resultId });
  } catch (error) {
    const code = safeCode(error);
    const message = `The local tool did not produce an uploadable result (${code}). Nothing was submitted.`;
    try {
      await report(() => client.blocker(claim.claimId, message, `${keyBase}-blocker`, true));
      return Object.freeze({ ...outcome, outcome: "blocked", message, reason: code });
    } catch (reportError) {
      return Object.freeze({ ...outcome, outcome: "abandoned", message, reason: reportError?.code ?? "unreachable" });
    }
  }
}

// ---------------------------------------------------------------------------
// Harness hand-off: `run` gives a claimed task to one local harness
// ---------------------------------------------------------------------------
// The machine owner enables harnesses in a local settings file next to the
// credential file. Nothing the server sends can pick an executable, a folder,
// a model or an adapter module; the server only offers tasks.
//
// Each harness is reached through the shared local CLI delivery contract that
// Control Room's own Codex, Claude Code and Hermes runners implement
// (OwnerTrustedLocalCliExecutionAdapterV1): the adapter module exports
// createFleetHarnessAdapter({ harness, configuration }) returning an object
// with execute({ delivery: { identity: { jobId }, input: { prompt, instructions } }, signal })
// that resolves to { kind: "completed", text } or { kind: "failed", reason }.
// src/fleet/v1/harness-adapters.ts is that module for a Control Room checkout.
const HARNESS_SETTINGS_SCHEMA = "control-room.fleet-harnesses/v1";
export const HANDOFF_HARNESSES = Object.freeze(["codex", "claude-code", "hermes"]);
const HARNESS_LABELS = Object.freeze({ codex: "Codex", "claude-code": "Claude Code", hermes: "Hermes" });
const MAX_MESSAGE_CHARS = 2000;
const WATCHDOG_GRACE_MS = 15_000;
const operationsMode = value => ["running", "paused", "draining", "stopped"].includes(value) ? value : "unknown";
// Refusals that mean this claim can no longer be reported on.
const LOST_CLAIM_CODES = new Set(["expired", "not_found", "conflict", "unauthenticated"]);
// Answers that are worth repeating with the same idempotency key.
const TRANSIENT_CODES = new Set(["rate_limited", "unavailable", "http_502", "http_503", "http_504"]);

const plainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const absolutePath = value => typeof value === "string" && value.length > 0 && value.length <= 4096
  && resolve(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);

export function defaultHarnessSettingsPath(configPath) {
  return joinPath(dirname(configPath), "harnesses.json");
}

async function refuseSharedWrite(path, what) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${what} ${path} is not a regular file.`);
  if (process.platform !== "win32" && (info.mode & 0o022) !== 0)
    throw new Error(`${what} ${path} can be changed by other users. Run: chmod go-w ${path}`);
  return info;
}

/** @typedef {Readonly<{ adapterModule: string | null, harnesses: Readonly<Record<string,
 *   Readonly<{ enabled: boolean, configuration: Readonly<Record<string, unknown>> }>>> }>} HarnessSettings */
/** @typedef {Readonly<{ state: string, mode?: string, outcome?: "submitted" | "blocked" | "abandoned", claimId?: string,
 *   jobId?: string, resultId?: string, message?: string, reason?: string, forcedTimeout?: boolean }>} RunPass */

/** Reads the machine owner's harness settings. A missing file means no
 * harness is enabled; anything malformed is refused, never guessed.
 * @param {string} path
 * @returns {Promise<HarnessSettings | null>} */
export async function loadHarnessSettings(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw new Error(`The harness settings file ${path} cannot be read.`); }
  await refuseSharedWrite(path, "The harness settings file");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The harness settings file is not valid JSON."); }
  const invalid = detail => new Error(`The harness settings file is not valid: ${detail}.`);
  if (!plainObject(value) || value.schema !== HARNESS_SETTINGS_SCHEMA) throw invalid(`schema must be "${HARNESS_SETTINGS_SCHEMA}"`);
  if (Object.keys(value).some(key => !["schema", "adapterModule", "harnesses"].includes(key))) throw invalid("unknown setting");
  if (!plainObject(value.harnesses)) throw invalid("harnesses must be an object");
  const harnesses = {};
  for (const [name, entry] of Object.entries(value.harnesses)) {
    if (!HANDOFF_HARNESSES.includes(name)) throw invalid(`unknown harness "${name}"`);
    if (!plainObject(entry) || typeof entry.enabled !== "boolean") throw invalid(`${name}.enabled must be true or false`);
    const { enabled, ...configuration } = entry;
    if (enabled && (!Number.isSafeInteger(configuration.deadlineMs) || configuration.deadlineMs < 100
      || configuration.deadlineMs > 3_600_000)) throw invalid(`${name}.deadlineMs must be 100 to 3600000`);
    harnesses[name] = Object.freeze({ enabled, configuration: Object.freeze(configuration) });
  }
  const anyEnabled = Object.values(harnesses).some(entry => entry.enabled);
  if (anyEnabled && !absolutePath(value.adapterModule)) throw invalid("adapterModule must be an absolute path");
  if (anyEnabled) await refuseSharedWrite(value.adapterModule, "The harness adapter module");
  return Object.freeze({ adapterModule: anyEnabled ? value.adapterModule : null, harnesses: Object.freeze(harnesses) });
}

/** Loads the adapter for one harness only if the machine owner enabled it.
 * @param {HarnessSettings | null} settings
 * @param {string} harness
 * @param {(specifier: string) => Promise<any>} [importer] */
export async function loadHarnessAdapter(settings, harness, importer = specifier => import(specifier)) {
  const entry = settings?.harnesses?.[harness];
  if (!HANDOFF_HARNESSES.includes(harness) || entry?.enabled !== true || !settings.adapterModule) return null;
  const module = await importer(pathToFileURL(settings.adapterModule).href);
  if (typeof module?.createFleetHarnessAdapter !== "function")
    throw new Error("The harness adapter module does not export createFleetHarnessAdapter.");
  const adapter = await module.createFleetHarnessAdapter(Object.freeze({ harness, configuration: entry.configuration }));
  if (!adapter || typeof adapter.execute !== "function") throw new Error("The harness adapter module returned no adapter.");
  return Object.freeze({ harness, deadlineMs: entry.configuration.deadlineMs, execute: adapter.execute.bind(adapter) });
}

/** Text the gateway will store: no control characters except tab and newlines. */
export function storableText(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "").trim();
}
const shortReason = value => storableText(value).replace(/\s+/gu, " ").slice(0, 200) || "no reason given";

/** The strings to refuse in outgoing text: each live credential whole, and
 * the bare base64url part after "crf_" (a harness that reads the credential
 * file could echo either form back in its answer). A read-only harness such
 * as Codex can read this machine's own key file even though it was never
 * given the key; this is the only guard standing between that read and the
 * key leaving the machine in a result or blocker message. */
function secretNeedles(secrets) {
  const needles = new Set();
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue;
    needles.add(secret);
    if (secret.startsWith("crf_")) needles.add(secret.slice(4));
  }
  return [...needles];
}
const SECRET_MATERIAL_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bBearer\s+[a-z0-9._~+/=-]{12,}/iu,
  /(?:api[_-]?key|password|passphrase|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{6,}/iu,
  /(?:X-Amz-Signature|X-Amz-Credential)=/iu,
  /\b(?:ghp|github_pat|sk_live|sk_test)_[a-z0-9_-]{12,}/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/u,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/iu,
]);
const containsSecret = (text, needles) => needles.some(needle => needle.length > 0 && String(text).includes(needle))
  || SECRET_MATERIAL_PATTERNS.some(pattern => pattern.test(String(text)));

async function report(send, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await send(); }
    catch (error) {
      const transient = error?.code === undefined || TRANSIENT_CODES.has(error.code);
      if (!transient || attempt >= attempts) throw error;
      await new Promise(done => setTimeout(done, 250 * attempt));
    }
  }
}

/**
 * Runs one claimed task on one local harness and reports what really
 * happened. Only a completed, well-formed, in-bounds answer becomes a result;
 * a failure, crash, timeout, stop, malformed or oversized answer becomes a
 * blocker that hands the task back. Nothing here can accept the result.
 * @param {{ client: ReturnType<typeof createClient>, claim: any, adapter: any, progressIntervalMs?: number,
 *   readMode?: () => Promise<string>, log?: (message: string) => void, watchdogGraceMs?: number,
 *   secrets?: string[] }} options
 * @returns {Promise<RunPass>}
 */
export async function runClaimedTask({ client, claim, adapter, progressIntervalMs = 60_000, readMode = async () => "unknown",
  log = () => {}, watchdogGraceMs = WATCHDOG_GRACE_MS, secrets = [] }) {
  const label = HARNESS_LABELS[adapter.harness] ?? adapter.harness;
  const keyBase = `handoff-${claim.claimId.slice("fleet-claim:".length)}`;
  const outcome = { claimId: claim.claimId, jobId: claim.jobId };
  const needles = secretNeedles(secrets);
  const keyLeakMessage = `${label}'s answer contained this machine's key, so it was not sent. Rotate the key.`;
  const blocked = async (message, extra = {}) => {
    const safeMessage = containsSecret(message, needles) ? keyLeakMessage : message;
    try {
      await report(() => client.blocker(claim.claimId, safeMessage.slice(0, MAX_MESSAGE_CHARS), `${keyBase}-blocker`, true));
      return Object.freeze({ ...outcome, outcome: "blocked", message: safeMessage, ...extra });
    } catch (error) {
      return Object.freeze({ ...outcome, outcome: "abandoned", message: safeMessage, reason: error?.code ?? "unreachable", ...extra });
    }
  };
  try { await report(() => client.progress(claim.claimId, `Started on ${label} on this machine.`, `${keyBase}-start`)); }
  catch (error) { return Object.freeze({ ...outcome, outcome: "abandoned", reason: error?.code ?? "unreachable" }); }

  const controller = new AbortController();
  let stop, ticks = 0, ticking = Promise.resolve(), watchdogTimer;
  const halt = reason => { if (!stop) { stop = reason; controller.abort(); } };
  const startedAt = Date.now();
  const tick = async () => {
    ticks += 1;
    try { if (await readMode() === "stopped") halt("stopped"); }
    catch (error) { if (error?.code === "unauthenticated") halt("lost"); }
    if (stop) return;
    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
    try { await client.progress(claim.claimId, `Still working on ${label} (${minutes} min).`, `${keyBase}-p${ticks}`); }
    catch (error) { if (LOST_CLAIM_CODES.has(error?.code)) halt("lost"); }
  };
  const ticker = setInterval(() => { ticking = ticking.then(tick); }, progressIntervalMs);
  const watchdog = new Promise(done => {
    watchdogTimer = setTimeout(() => { halt("watchdog"); done({ watchdog: true }); }, adapter.deadlineMs + watchdogGraceMs);
  });
  let settled;
  try {
    // The adapter sees the task text and a cancel signal: never the
    // credential, the server address or anything that grants authority.
    const delivery = Object.freeze({ identity: Object.freeze({ jobId: claim.jobId }), input: Object.freeze({
      prompt: [claim.title, claim.instructions].filter(Boolean).join("\n\n"),
      instructions: "Complete this Control Room task and reply with the result. Your reply is sent to the owner for review; the owner decides whether to accept it." }) });
    settled = await Promise.race([
      Promise.resolve().then(() => adapter.execute({ delivery, signal: controller.signal }))
        .then(value => ({ value }), error => ({ error })),
      watchdog,
    ]);
  } finally {
    clearInterval(ticker); clearTimeout(watchdogTimer);
    await ticking;
  }
  if (stop === "lost") {
    log(`The task ${claim.jobId} can no longer be reported on (its claim ended); nothing was submitted.`);
    return Object.freeze({ ...outcome, outcome: "abandoned", reason: "claim_lost" });
  }
  if (settled.watchdog) return blocked(`The ${label} run did not stop by its time limit, so it was abandoned. Nothing was submitted.`,
    { forcedTimeout: true });
  const value = settled.value;
  // A run that finished anyway is still reported honestly after a Stop.
  if (stop === "stopped" && !(plainObject(value) && value.kind === "completed" && typeof value.text === "string"))
    return blocked(`Stopped from Control Room before ${label} finished. Nothing was submitted.`);
  if ("error" in settled) return blocked(`The ${label} adapter failed before it gave an answer. Nothing was submitted.`);
  if (!plainObject(value) || (value.kind === "completed" ? typeof value.text !== "string"
    : value.kind !== "failed" || typeof value.reason !== "string"))
    return blocked(`${label} gave an answer Control Room does not understand. Nothing was submitted.`);
  if (value.kind === "failed") return blocked(`The ${label} run did not finish (${shortReason(value.reason)}). Nothing was submitted.`);
  const summary = storableText(value.text);
  if (!summary) return blocked(`${label} finished with an empty answer. Nothing was submitted.`);
  if (Buffer.byteLength(summary, "utf8") > MAX_RESULT_BYTES)
    return blocked(`${label}'s answer was larger than 64 KiB, so it was not submitted. Ask for a shorter answer.`);
  if (containsSecret(summary, needles)) return blocked(keyLeakMessage, { keyLeak: true });
  try {
    const result = await report(() => client.result(claim.claimId, summary, [], `${keyBase}-result`));
    return Object.freeze({ ...outcome, outcome: "submitted", resultId: result.resultId });
  } catch (error) {
    if (error?.code === "too_large" || error?.code === "invalid")
      return blocked(`${label}'s answer could not be stored (${error.code}). Nothing was submitted.`);
    return Object.freeze({ ...outcome, outcome: "abandoned", reason: error?.code ?? "unreachable" });
  }
}

/**
 * The `run` loop. Each pass checks in (which also reads the owner's Pause /
 * Drain / Stop), renews the credential when due, and, only when the worker's
 * harness is enabled here and Control Room is running, claims one offered
 * task and hands it to that harness. One task at a time.
 * @param {{ configPath: string, harnessesPath?: string, fetcher?: typeof fetch, once?: boolean,
 *   importer?: (specifier: string) => Promise<any>, progressIntervalMs?: number, pollMs?: number,
 *   log?: (message: string) => void, sleep?: (ms: number) => Promise<void>, watchdogGraceMs?: number }} options
 * @returns {Promise<RunPass>}
 */
export async function runWorker({ configPath, harnessesPath = defaultHarnessSettingsPath(configPath), fetcher, once = false,
  importer, progressIntervalMs = 60_000, pollMs = 60_000, log = message => process.stderr.write(`${message}\n`),
  sleep = ms => new Promise(done => setTimeout(done, ms)), watchdogGraceMs = WATCHDOG_GRACE_MS }) {
  const settings = await loadHarnessSettings(harnessesPath);
  const tools = await loadToolAdapters(defaultToolAdaptersPath(configPath));
  const handedBack = new Set(); // tasks this machine could not finish; left for another worker
  let adapter = null, said = "";
  const say = message => { if (message !== said) { said = message; log(`${new Date().toISOString()} ${message}`); } };
  for (;;) {
    let current = await recoverPending({ configPath, fetcher });
    if (current.credentialExpiresAt && Date.parse(current.credentialExpiresAt) - Date.now() < ROTATE_BEFORE_MS) {
      await rotate({ configPath, fetcher }); current = await loadConfig(configPath);
      log("Credential renewed.");
    }
    const client = createClient(current, fetcher);
    let me;
    try { me = await client.heartbeat(tools?.capabilities ?? []); }
    catch (error) {
      if (error?.code === "unauthenticated") throw new Error("Control Room no longer accepts this machine's key. Ask the owner for a new key.");
      say(`Could not reach Control Room (${error?.code ?? "network"}); trying again.`);
      if (once) return Object.freeze({ state: "unreachable" });
      await sleep(pollMs); continue;
    }
    const mode = operationsMode(me.operationsMode);
    const harness = HANDOFF_HARNESSES.includes(me.workerKind) ? me.workerKind : null;
    let pass = { state: "idle" };
    if (me.workerKind === "tool") {
      if (!tools) {
        say(`Connected as ${me.displayName}. No owner-written tool-adapters.json is present, so no work is taken.`);
        pass = { state: "not_enabled" };
      } else if (mode !== "running") {
        say(`Connected as ${me.displayName}. ${mode === "unknown" ? "Control Room could not read its Pause switch"
          : `Control Room is ${mode}`}, so no new work is taken.`);
        pass = { state: "paused", mode };
      } else {
        let offers = [], claim, selected;
        try {
          offers = (await client.work()).filter(item => !handedBack.has(item.jobId));
          selected = offers.find(item => {
            const declared = typeof item.adapterId === "string" ? tools.adapters.get(item.adapterId) : undefined;
            return declared?.capability === item.capability;
          });
          if (selected) claim = await client.claim(selected.offerId, `tool-claim-${randomBytes(16).toString("hex")}`);
        } catch (error) {
          if (error?.code === "paused") pass = { state: "paused", mode: "paused" };
          else if (error?.code === "unauthenticated") throw new Error("Control Room no longer accepts this machine's key. Ask the owner for a new key.");
          else { say(`Could not take tool work (${error?.code ?? "network"}); trying again.`); pass = { state: "unreachable" }; }
        }
        if (!claim && pass.state !== "unreachable" && pass.state !== "paused") {
          const refused = offers.some(item => typeof item.adapterId === "string" && !tools.adapters.has(item.adapterId));
          say(refused ? "An offered task named an adapter this machine's owner did not declare, so it was refused."
            : `Connected as ${me.displayName}. Waiting for matching tool work (${offers.length} offered).`);
          pass = { state: refused ? "adapter_refused" : "idle" };
        } else if (claim) {
          const declared = typeof claim.adapterId === "string" ? tools.adapters.get(claim.adapterId) : undefined;
          if (!declared || declared.capability !== selected.capability || !plainObject(claim.inputs)) {
            const message = "The claimed task did not match an owner-declared local adapter and input binding. Nothing was run.";
            await report(() => client.blocker(claim.claimId, message,
              `tool-${claim.claimId.slice("fleet-claim:".length)}-blocker`, true));
            handedBack.add(claim.jobId); pass = { state: "ran", outcome: "blocked", claimId: claim.claimId,
              jobId: claim.jobId, message };
          } else {
            const secrets = [current.secret, current.pendingSecret].filter(value => typeof value === "string" && value);
            const runner = createLocalToolAdapterRunner(tools, { secrets });
            const controller = new AbortController();
            let checking = false;
            const stopCheck = setInterval(() => { if (checking) return; checking = true;
              void client.heartbeat(tools.capabilities).then(value => {
                if (operationsMode(value.operationsMode) === "stopped") controller.abort();
              }).catch(error => { if (LOST_CLAIM_CODES.has(error?.code)) controller.abort(); }).finally(() => { checking = false; });
            }, progressIntervalMs);
            let finished;
            try { finished = await runClaimedToolTask({ client, claim, runner, signal: controller.signal, secrets }); }
            finally { clearInterval(stopCheck); }
            if (finished.outcome !== "submitted") handedBack.add(claim.jobId);
            pass = { state: "ran", ...finished };
          }
        }
      }
    } else if (!harness) {
      say(`Connected as ${me.displayName}. This worker is driven through MCP, so run starts no harness.`);
      pass = { state: "no_harness" };
    } else if (settings?.harnesses?.[harness]?.enabled !== true) {
      say(`Connected as ${me.displayName}. ${HARNESS_LABELS[harness]} is not enabled on this machine, so no work is taken. `
        + `Enable it in ${harnessesPath}.`);
      pass = { state: "not_enabled" };
    } else if (mode !== "running") {
      say(`Connected as ${me.displayName}. ${mode === "unknown" ? "Control Room could not read its Pause switch"
        : `Control Room is ${mode}`}, so no new work is taken.`);
      pass = { state: "paused", mode };
    } else {
      // Load before claiming, so a broken local setup never strands a task.
      adapter ??= await loadHarnessAdapter(settings, harness, importer);
      let offers = [], claim;
      try {
        offers = (await client.work()).filter(item => !handedBack.has(item.jobId));
        for (const offer of offers) {
          try { claim = await client.claim(offer.offerId, `handoff-claim-${randomBytes(16).toString("hex")}`); break; }
          catch (error) {
            if (error?.code === "paused") { pass = { state: "paused", mode: "paused" }; break; }
            if (error?.code !== "conflict" && error?.code !== "not_found") throw error;
          }
        }
      } catch (error) {
        if (error?.code === "unauthenticated") throw new Error("Control Room no longer accepts this machine's key. Ask the owner for a new key.");
        say(`Could not take work (${error?.code ?? "network"}); trying again.`);
        pass = { state: "unreachable" };
      }
      if (pass.state === "paused") say("Control Room paused new work, so none was taken.");
      else if (!claim && pass.state !== "unreachable") say(`Connected as ${me.displayName}. Waiting for work (${offers.length} offered).`);
      else if (claim) {
        say(`Claimed "${claim.title}" for ${HARNESS_LABELS[harness]}.`);
        const readMode = async () => operationsMode((await client.heartbeat(tools?.capabilities ?? [])).operationsMode);
        // The adapter never receives these; they are only checked against the
        // adapter's own answer afterward, so a leaked key cannot be sent on.
        const secrets = [current.secret, current.pendingSecret].filter(value => typeof value === "string" && value);
        const finished = await runClaimedTask({ client, claim, adapter, progressIntervalMs, readMode, log,
          watchdogGraceMs, secrets });
        if (finished.outcome !== "submitted") handedBack.add(claim.jobId);
        say(finished.outcome === "submitted" ? `Sent the result of "${claim.title}" to the owner for review.`
          : `Could not finish "${claim.title}": ${finished.message ?? finished.reason}`);
        pass = { state: "ran", ...finished };
        // A harness that ignored its own time limit may still be running.
        // Taking more work next to it is not safe; stop and let a person look.
        if (finished.forcedTimeout) throw new Error(`${HARNESS_LABELS[harness]} did not stop by its time limit. `
          + "run has stopped taking work; check this machine before starting it again.");
      }
    }
    if (once) return Object.freeze(pass);
    if (pass.state !== "ran") await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
function options(args) {
  const values = {}, positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (["once", "release"].includes(name)) values[name] = true;
      else { values[name] = args[i + 1]; i += 1; }
    } else positional.push(arg);
  }
  return { values, positional };
}

const usage = `Control Room worker connector ${CONNECTOR_VERSION}

  join --server <address> --code <code>   Join this machine (code from the Workers page)
  status                                  Show this worker and its credential
  rotate                                  Replace this machine's credential now
  run [--once] [--harnesses <path>]       Stay connected: check in, renew the credential, and
                                          hand offered tasks to the harness enabled in
                                          harnesses.json (next to the credential file)
  work                                    List tasks this worker may claim
  claims                                  List this worker's claims and owner decisions
  claim <offerId>
  progress <claimId> <message>
  blocker <claimId> <message> [--release]
  result <claimId> --summary <text> [--file <path>]...
  mcp                                     Start the MCP server for an agent (stdin/stdout)

  --config <path>   Credential file (default ${defaultConfigPath()})
`;

export async function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
  const [command, ...rest] = argv;
  const { values, positional } = options(rest);
  const configPath = values.config ? resolve(values.config) : defaultConfigPath();
  const print = value => io.out.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
  try {
    if (!command || command === "--help" || command === "help") { print(usage); return 0; }
    if (command === "join") {
      const result = await join({ server: values.server, code: values.code, configPath });
      print(`Joined as "${result.displayName}" (${result.workerId}).`);
      print(`Projects: ${result.projectIds.join(", ")}. Capabilities: ${result.capabilities.join(", ")}.`);
      print(`Credential saved to ${configPath}. Next: node ${basename(process.argv[1] ?? "connector.mjs")} run`);
      return 0;
    }
    if (command === "mcp") { await serveMcp({ configPath }); return 0; }
    const config = await recoverPending({ configPath });
    const client = createClient(config);
    if (command === "status") {
      const tools = await loadToolAdapters(defaultToolAdaptersPath(configPath));
      print(await client.heartbeat(tools?.capabilities ?? [])); return 0;
    }
    if (command === "rotate") { print(await rotate({ configPath })); return 0; }
    if (command === "work") { print(await client.work()); return 0; }
    if (command === "claims") { print(await client.claims()); return 0; }
    if (command === "claim") { print(await client.claim(positional[0], idempotencyKeyFor("claim", { offerId: positional[0] }))); return 0; }
    if (command === "progress") { print(await client.progress(positional[0], positional[1], `cli-${randomBytes(12).toString("hex")}`)); return 0; }
    if (command === "blocker") {
      print(await client.blocker(positional[0], positional[1], `cli-${randomBytes(12).toString("hex")}`, values.release === true));
      return 0;
    }
    if (command === "result") {
      const paths = rest.flatMap((arg, i) => arg === "--file" ? [rest[i + 1]] : []);
      const files = [];
      for (const path of paths) files.push(await workspaceFile(process.cwd(), path));
      print(await client.result(positional[0], values.summary, files, idempotencyKeyFor("result", { claimId: positional[0], summary: values.summary, paths })));
      return 0;
    }
    if (command === "run") {
      const pass = await runWorker({ configPath, once: values.once === true,
        ...(values.harnesses ? { harnessesPath: resolve(values.harnesses) } : {}),
        log: message => io.err.write(`${message}\n`) });
      return pass.state === "unreachable" ? 1 : 0;
    }
    io.err.write(usage); return 2;
  } catch (error) {
    io.err.write(`${error instanceof Error ? error.message : "The connector stopped."}\n`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; } catch { return false; }
})();
if (invokedDirectly) main().then(code => { process.exitCode = code; });
