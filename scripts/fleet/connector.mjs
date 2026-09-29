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
import { mkdir, readFile, realpath, rename, stat, writeFile, chmod, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join as joinPath, resolve, sep } from "node:path";
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
  ".jpeg": "image/jpeg", ".pdf": "application/pdf" });
const MAX_FILE_BYTES = 262_144;
const MAX_RESULT_BYTES = 65_536;
const MAX_PROPOSAL_BYTES = 256 * 1024;
const MAX_MCP_MESSAGE_BYTES = 512 * 1024;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u;
const OFFER_PATTERN = /^fleet-offer:[a-f0-9]{32}$/u;
const CLAIM_PATTERN = /^fleet-claim:[a-f0-9]{32}$/u;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;

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
  async function call(method, path, body, secret = config.secret) {
    const response = await fetcher(`${config.server}${path}`, { method, redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(config.workerId ? { "x-control-room-worker": config.workerId } : {}),
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
    heartbeat: () => call("POST", "/fleet/v1/heartbeat", { connectorVersion: CONNECTOR_VERSION, platform: platformName() }),
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
    mcpCall: (callId, toolName) => call("POST", "/fleet/v1/mcp/calls", { callId, toolName }),
  });
}

/** @param {{ server: string, code: string, configPath: string, fetcher?: typeof fetch }} options */
export async function join({ server, code, configPath, fetcher }) {
  const origin = checkServer(server);
  if (!CODE_PATTERN.test(code ?? "")) throw new Error("The join code is not valid. Copy it again from the Workers page.");
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
    architecture: process.arch, connectorVersion: CONNECTOR_VERSION, clientNonce });
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
  run [--once]                            Stay connected: check in, renew the credential
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
    if (command === "status") { print(await client.heartbeat()); return 0; }
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
      for (;;) {
        let current = await loadConfig(configPath);
        if (current.credentialExpiresAt && Date.parse(current.credentialExpiresAt) - Date.now() < ROTATE_BEFORE_MS) {
          await rotate({ configPath }); current = await loadConfig(configPath);
          io.err.write("Credential renewed.\n");
        }
        const me = await createClient(current).heartbeat();
        const work = await createClient(current).work();
        io.err.write(`${new Date().toISOString()} connected as ${me.displayName}; ${work.length} task(s) available.\n`);
        if (values.once) return 0;
        await new Promise(done => setTimeout(done, 60_000));
      }
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
