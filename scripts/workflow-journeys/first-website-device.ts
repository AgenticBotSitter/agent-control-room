// Proof-only private observations. This module never dispatches an engine command,
// launches transport tools, discovers credentials, or installs capture software.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, link, unlink, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { parseStrictJsonV1 } from "../../src/installer/shared/strict-json.mjs";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { loopBridgeReceiptSchemaV1 } from "../../src/improve-control-room/v1/schemas";
import { loopCandidateCardSchemaV1 } from "../../src/improve-control-room/v1/loop-candidate-wire";
import { admitTailscaleRequestV1 } from "../../src/web/v1/mac-local-remote-access";

export class B5DeviceRefusalV1 extends Error {
  constructor(readonly code: string) { super(code); }
}
function need(value: unknown, code: string): asserts value { if (!value) throw new B5DeviceRefusalV1(code); }
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u);
const utc = z.string().datetime({ offset: false });
const nonce = z.string().regex(/^[a-f0-9]{32}$/u);
const device = z.enum(["phone", "desktop"]);
export const b5DeviceHashV1 = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const stable = (v: unknown): string => JSON.stringify(v && typeof v === "object"
  ? Array.isArray(v) ? v.map(x => JSON.parse(stable(x))) : Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, JSON.parse(stable(x))])) : v);
export const b5MappingDigestV1 = (value: unknown) => b5DeviceHashV1(stable(value));
const parse = <T>(schema: z.ZodType<T>, value: unknown, code = "B5_DEVICE_SCHEMA"): T => {
  const p = schema.safeParse(value); need(p.success, code); return p.data;
};
export function parseB5DeviceJsonV1(bytes: string) {
  try { return parseStrictJsonV1(bytes, { maxBytes: 64 << 10 }); }
  catch { throw new B5DeviceRefusalV1(Buffer.byteLength(bytes) > 64 << 10 ? "B5_DEVICE_SIZE" : "B5_DEVICE_JSON"); }
}
export const b5DeviceInventorySchemaV1 = z.object({
  phone: z.object({ model: text, os: text, browser: text, browserVersion: text }).strict(),
  desktop: z.object({ browser: text, browserVersion: text }).strict(),
  captureMethod: z.enum(["native-screenshot", "native-screen-recording"]),
  fileTransferRoute: text,
}).strict();
const status = z.record(z.string(), z.unknown());
export const b5TransportQualificationSchemaV1 = z.object({
  schemaVersion: z.literal(1), kind: z.literal("tailscale-serve"), origin: z.string().max(512),
  backend: z.literal("http://127.0.0.1:60460"), actor: z.literal("owner"),
  authorizedAt: utc, expiresAt: utc, ownerAuthorized: z.literal(true),
  ownerLogin: z.string().min(3).max(254).regex(/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u),
  identityPolicy: z.literal("exact-owner-login"), captureMode: z.literal("native-capture-server-correlation"),
  inventory: b5DeviceInventorySchemaV1,
  beforeStatus: status, installedStatus: status, beforeDigest: digest, installedDigest: digest,
}).strict();
export type B5TransportQualificationV1 = z.infer<typeof b5TransportQualificationSchemaV1>;
/** R3 transport/identity confinement: exact values stay in private run data.
 * Retained receipts keep their URL-shaped origin as a non-identifying label.
 * Labels are stable within the independently qualified packet, never public
 * hashes of a hostname/login that could be guessed from a small dictionary. */
export function redactB5EvidenceV1(value: unknown, qualification: B5TransportQualificationV1): unknown {
  const hosts = [...new Set(JSON.stringify(qualification).toLowerCase().match(/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net\b/gu) ?? [])].sort();
  const redact = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net\b/giu, host=>{
      const index=hosts.indexOf(host.toLowerCase()); need(index >= 0,"B5_EVIDENCE_SECRET");
      return `private-tailnet-${index+1}.invalid`;
    }).replace(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*/giu,"redacted-owner");
    if (Array.isArray(v)) return v.map(redact);
    if (v && typeof v === "object") {
      const result: Record<string,unknown> = {};
      for (const [key,child] of Object.entries(v)) {
        if (key === "ownerLogin") continue;
        const safeKey=redact(key) as string;
        need(!Object.hasOwn(result,safeKey),"B5_EVIDENCE_SECRET");
        result[safeKey]=redact(child);
      }
      return result;
    }
    return v;
  };
  return redact(value);
}
export const b5RetainedTransportQualificationSchemaV1 = b5TransportQualificationSchemaV1.omit({ownerLogin:true})
  .extend({origin:z.string().regex(/^https:\/\/private-tailnet-[1-9][0-9]*\.invalid:60462$/u),sourceDigest:digest});
export function retainB5TransportQualificationV1(q:B5TransportQualificationV1, sourceDigest:string) {
  return b5RetainedTransportQualificationSchemaV1.parse({...redactB5EvidenceV1(q,q) as object,sourceDigest});
}
export function validateB5DeviceOriginV1(value: string) {
  try {
    const u = new URL(value);
    need(u.origin === value && u.protocol === "https:" && u.port === "60462" && u.hostname.endsWith(".ts.net")
      && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/u.test(u.hostname) && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/", "B5_DEVICE_ORIGIN");
  } catch { throw new B5DeviceRefusalV1("B5_DEVICE_ORIGIN"); }
  return value;
}
// Tailscale's raw status has TCP port entries and Web host:port entries. Preserve
// every unrelated value, including future top-level fields, in comparisons.
function withoutProof(value: Record<string, unknown>, origin: string) {
  const clone = structuredClone(value), host = new URL(origin).host;
  for (const [section, key] of [["TCP", "60462"], ["Web", host], ["AllowFunnel", host]]) {
    const object = clone[section!];
    if (object && typeof object === "object" && !Array.isArray(object)) {
      delete (object as Record<string, unknown>)[key!];
      if (!Object.keys(object).length) delete clone[section!];
    }
  }
  return clone;
}
function proofPresent(value: Record<string, unknown>, origin: string) {
  const tcp = value.TCP as Record<string, unknown> | undefined, web = value.Web as Record<string, unknown> | undefined;
  return tcp?.["60462"] !== undefined || web?.[new URL(origin).host] !== undefined
    || (value.AllowFunnel as Record<string, unknown> | undefined)?.[new URL(origin).host] !== undefined;
}
/** Pure retained-evidence comparison; shared with cleanup so the verifier cannot
 * apply a weaker definition of proof absence or unrelated mapping equality. */
export function compareB5RemovedStatusV1(before: Record<string,unknown>, after: Record<string,unknown>, origin:string) {
  validateB5DeviceOriginV1(origin);
  return !proofPresent(before,origin) && !proofPresent(after,origin)
    && stable(withoutProof(after,origin)) === stable(withoutProof(before,origin));
}
export function validateB5TransportV1(value: unknown, origin: string, now = Date.now()) {
  validateB5DeviceOriginV1(origin);
  need(value && typeof value === "object" && "inventory" in value, "B5_DEVICE_INVENTORY_REQUIRED");
  const q = parse(b5TransportQualificationSchemaV1, value, "B5_DEVICE_QUALIFICATION");
  need(q.origin === origin, "B5_DEVICE_ORIGIN");
  need(Date.parse(q.authorizedAt) <= now && now < Date.parse(q.expiresAt), "B5_DEVICE_EXPIRED");
  need(q.beforeDigest === b5MappingDigestV1(q.beforeStatus) && q.installedDigest === b5MappingDigestV1(q.installedStatus), "B5_DEVICE_MAPPING_DIGEST");
  need(!proofPresent(q.beforeStatus, origin), "B5_DEVICE_PORT_OCCUPIED");
  const host = new URL(origin).host;
  const installed = q.installedStatus as { TCP?: Record<string, unknown>; Web?: Record<string, unknown>; AllowFunnel?: Record<string, unknown> };
  need(stable(installed.TCP?.["60462"]) === stable({ HTTPS: true })
    && stable(installed.Web?.[host]) === stable({ Handlers: { "/": { Proxy: q.backend } } })
    && !installed.AllowFunnel?.[host]
    && stable(withoutProof(q.installedStatus, origin)) === stable(withoutProof(q.beforeStatus, origin)), "B5_DEVICE_MAPPING_DRIFT");
  return Object.freeze(q);
}
const credentialPath = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.codex|\.hermes|auth\.json|tokens?(?:\.[^/\\]*)?)(?:[/\\]|$)/iu;
async function custody(file: string, root: string, directory = false, cap = 64 << 10) {
  need(isAbsolute(file) && resolve(file) === file && !credentialPath.test(file)
    && (file === root || relative(root, file) !== ".." && !relative(root, file).startsWith(`..${sep}`) && !isAbsolute(relative(root, file))), "B5_DEVICE_PATH");
  for (let p = file;; p = dirname(p)) {
    const s = await lstat(p).catch(() => { throw new B5DeviceRefusalV1("B5_DEVICE_PATH"); });
    need(!s.isSymbolicLink(), "B5_DEVICE_PATH"); if (p === dirname(p)) break;
  }
  need(await realpath(file) === file, "B5_DEVICE_PATH");
  const s = await lstat(file);
  need(s.uid === process.getuid?.() && (s.mode & 0o777) === (directory ? 0o700 : 0o600)
    && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1), "B5_DEVICE_CUSTODY");
  need(directory || s.size <= cap, "B5_DEVICE_SIZE"); return s;
}
async function readDeviceFile(file: string, root: string, cap = 64 << 10) {
  const before = await custody(file, root, false, cap);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat(); need(st.ino === before.ino && st.dev === before.dev, "B5_DEVICE_CUSTODY");
    const bytes = await handle.readFile(); need(bytes.length <= cap, "B5_DEVICE_SIZE");
    await custody(file, root, false, cap); return bytes;
  } finally { await handle.close(); }
}
export async function readB5DeviceFileV1(file: string, root: string, cap = 64 << 10) {
  try { return await readDeviceFile(file, root, cap); }
  catch (error) { throw error instanceof B5DeviceRefusalV1 ? error : new B5DeviceRefusalV1("B5_DEVICE_IO"); }
}
export async function loadB5TransportV1(file: string, root: string, origin: string, expectedDigest?: string) {
  const bytes = await readB5DeviceFileV1(file, root);
  if (expectedDigest !== undefined) need(b5DeviceHashV1(bytes) === expectedDigest, "B5_DEVICE_QUALIFICATION_CHANGED");
  return validateB5TransportV1(parseB5DeviceJsonV1(bytes.toString("utf8")), origin);
}
/** Remote acquisition is qualified only with explicit cooperative ownership.
 * A private packet cannot substitute for the registered cleanup callback. */
export function assertB5DeviceSignalCleanupV1(options?: { signalOwner?: string; cleanup?: () => Promise<unknown> }): void {
  need(options?.signalOwner === "caller" && typeof options.cleanup === "function", "B5_DEVICE_SIGNAL_CLEANUP_UNQUALIFIED");
}
export function b5DeviceRemoteOriginsV1(q: B5TransportQualificationV1) {
  return Object.freeze([Object.freeze({ origin: q.origin, admit(headers: Headers) {
    need(Date.now() < Date.parse(q.expiresAt), "B5_DEVICE_EXPIRED");
    admitTailscaleRequestV1({ origin: q.origin, ownerLogin: q.ownerLogin }, headers);
  } })]);
}
export const b5DeviceRequestSchemaV1 = z.object({ schemaVersion: z.literal(1), sessionNonce: nonce,
  sequence: z.number().int().positive().safe(), phase: z.enum(["connect", "prepare", "bindings-ready", "confirm-start", "question", "plan", "spec", "close", "repair", "finish", "retained"]),
  origin: z.string().url().max(512), device, expiresAt: utc,
  binding: z.object({ requestId: text, runLinkId: text, inputVersion: z.number().int().positive() }).strict().optional(),
}).strict();
export type B5DeviceRequestV1 = z.infer<typeof b5DeviceRequestSchemaV1>;
const observationSchema = z.object({ sessionDigest: digest, routeClass: z.literal("project-document"), method: z.literal("GET"),
  status: z.literal(200), observedAt: utc, sessionNonce: nonce, sequence: z.number().int().positive(), device }).strict();
const captureSchema = z.object({ path: z.string().min(1).max(512), sha256: digest,
  device, sessionNonce: nonce, sequence: z.number().int().positive().safe(), capturedAt: utc }).strict();
export const b5DeviceReceiptSchemaV1 = b5DeviceRequestSchemaV1.extend({ observedAt: utc, real: z.boolean(), browser: text,
  actions: z.array(z.enum(["connected", "prepared", "bindings-ready-observed", "confirmed", "started", "answered", "plan-read", "plan-approved", "spec-read", "spec-approved", "closed", "repair-observed", "finished", "retained-read"])).min(1).max(16),
  captures: z.array(captureSchema).min(1).max(16), observation: observationSchema,
  closeAttestation: z.object({ actor: z.literal("owner"), closedAt: utc, allProofTabsClosed: z.literal(true) }).strict().optional(),
}).strict();
export type B5DeviceReceiptV1 = z.infer<typeof b5DeviceReceiptSchemaV1>;

// R3 “No-download device evidence”: allowlisted observations only. Never retain
// request bodies, headers, session cookies, login exchanges or network bodies.
export function assertB5EvidenceSecretFreeV1(value: unknown): void {
  if (typeof value === "string") need(!/(?:control_room_local_owner=|b5_correlation=|\bBearer\s|-----BEGIN .*PRIVATE KEY|[a-z0-9.-]+\.ts\.net\b|[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*)/iu.test(value), "B5_EVIDENCE_SECRET");
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    need(!/^(?:cookies?|set[-_]?cookie|authorization|headers?|owner[-_]?(?:code|login)|(?:access|refresh)[-_]?token|token|password|secret|storage[-_]?state)$/iu.test(key), "B5_EVIDENCE_SECRET");
    assertB5EvidenceSecretFreeV1(key);
    assertB5EvidenceSecretFreeV1(child);
  }
}
export const b5DeviceServiceEvidenceSchemaV1 = z.object({
  sequence: z.number().int().positive(), events: z.array(z.object({
    name: z.enum(["intake", "confirm", "start", "answer", "approve-plan", "approve-spec", "finish-phone", "finish-desktop", "retained"]),
    at: utc, method: z.enum(["GET", "POST"]), path: z.string().regex(/^\/api\/v1\/projects\/[^/?#]+\/improvements\/loop\/(?:[^/?#]+\/)?(?:intake|confirm|start|answer|approve|candidate)$/u), status: z.number().int(),
    responseDigest: digest.optional(), recordDigest: digest.optional(), candidateRevision: z.string().regex(/^[a-f0-9]{40}$/u).optional(), baseRevision: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
  }).strict()).max(16),
  dom: z.object({candidateRevision:z.string(),baseRevision:z.string(),requestId:z.string()}).strict().optional(),
}).strict();
export type B5DeviceServiceEvidenceV1 = z.infer<typeof b5DeviceServiceEvidenceSchemaV1>;
function expectedServiceActions(request:B5DeviceRequestV1): B5DeviceServiceEvidenceV1["events"][number]["name"][] {
  return ({prepare:["intake"],"confirm-start":["confirm","start"],question:["answer"],plan:["approve-plan"],spec:["approve-spec"],
    finish:[request.device === "phone" ? "finish-phone" : "finish-desktop"],retained:["retained"]} as Partial<Record<B5DeviceRequestV1["phase"],B5DeviceServiceEvidenceV1["events"][number]["name"][]>>)[request.phase] ?? [];
}


const phaseActions: Record<B5DeviceRequestV1["phase"], string[]> = { connect: ["connected"], prepare: ["prepared"],
  "bindings-ready": ["bindings-ready-observed"], "confirm-start": ["confirmed", "started"], question: ["answered"],
  plan: ["plan-read", "plan-approved"], spec: ["spec-read", "spec-approved"], close: ["closed"], repair: ["repair-observed"],
  finish: ["finished"], retained: ["retained-read"] };
async function publish(file: string, value: unknown, immutable: boolean) {
  const bytes = JSON.stringify(value) + "\n"; need(Buffer.byteLength(bytes) <= 64 << 10, "B5_DEVICE_SIZE");
  const temporary = join(dirname(file), `.pending-${randomBytes(16).toString("hex")}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { if (immutable) await link(temporary, file); else await rename(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new B5DeviceRefusalV1("B5_DEVICE_DUPLICATE"); throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function createB5DeviceMailboxV1(scratchRoot: string, origin: string, options: { real: boolean; projectId: string; inventory?: z.infer<typeof b5DeviceInventorySchemaV1>; now?: () => number }) {
  const now = options.now ?? Date.now, root = join(scratchRoot, "device");
  await custody(scratchRoot, scratchRoot, true);
  if (options.real) { validateB5DeviceOriginV1(origin); need(options.inventory, "B5_DEVICE_INVENTORY_REQUIRED"); }
  else if (origin !== "http://127.0.0.1:60460") validateB5DeviceOriginV1(origin);
  try { await mkdir(root, { mode: 0o700 }); } catch { throw new B5DeviceRefusalV1("B5_DEVICE_EXISTS"); }
  await mkdir(join(root, "receipts"), { mode: 0o700 }); await mkdir(join(root, "captures"), { mode: 0o700 });
  if (options.real) await mkdir(join(root, "service"), { mode: 0o700 });
  await mkdir(join(root, "observations"), { mode: 0o700 }); await mkdir(join(root, "inbox"), { mode: 0o700 });
  const identity = await custody(root, scratchRoot, true);
  let challengedSession: string | undefined;
  let sequence = 0, pending: B5DeviceRequestV1 | undefined, observed: z.infer<typeof observationSchema> | undefined, closed = false;
  const sessions = new Map<string, string>(), accepted = new Map<number, string>();
  const sealedService = new Map<number, string>();
  let events: B5DeviceServiceEvidenceV1["events"] = [];
  const active = new Set<Promise<unknown>>(); let closing: Promise<void> | undefined;
  async function checked() {
    const s = await custody(root, scratchRoot, true);
    need(s.ino === identity.ino && s.dev === identity.dev, "B5_DEVICE_CUSTODY");
    for (const dir of ["receipts", "captures", "observations", "inbox", ...(options.real ? ["service"] : [])]) await custody(join(root, dir), root, true);
  }
  function locked<T>(body: () => Promise<T>): Promise<T> {
    const work = (async () => {
      try {
        need(!closed, "B5_DEVICE_CLOSED"); await checked();
        const lock = join(root, ".lock");
        try { await mkdir(lock, { mode: 0o700 }); } catch { throw new B5DeviceRefusalV1("B5_DEVICE_SEQUENCE_RACE"); }
        try { return await body(); } finally { await rmdir(lock); }
      } catch (error) { throw error instanceof B5DeviceRefusalV1 ? error : new B5DeviceRefusalV1("B5_DEVICE_IO"); }
    })();
    active.add(work); void work.finally(() => active.delete(work)).catch(() => {}); return work;
  }

  const projectPath = `/projects/${encodeURIComponent(options.projectId)}`;
  const apiPath = `/api/v1/projects/${encodeURIComponent(options.projectId)}/improvements/loop/`;
  async function observeAction(request: Request, response: Response) {
    const url = new URL(request.url), current = pending, observation = observed;
    if (!options.real || closed || !current || !observation || accepted.has(current.sequence) || url.origin !== origin
      || url.search || !url.pathname.startsWith(apiPath) || !response.ok || now() >= Date.parse(current.expiresAt)) return;
    const tokens = (request.headers.get("cookie") ?? "").split(";").map(c => c.trim()).filter(c => /^control_room_local_owner=[A-Za-z0-9_-]{43}$/u.test(c));
    if (tokens.length !== 1 || b5DeviceHashV1(tokens[0]!) !== observation.sessionDigest) return;
    const suffix = url.pathname.slice(apiPath.length), binding = current.binding;
    const expected = binding ? encodeURIComponent(binding.requestId) + "/" : "";
    const allowed = expectedServiceActions(current);
    const name = allowed?.find(name => suffix === (name === "intake" ? "intake" : expected + (name.startsWith("approve-") ? "approve" : ["finish-phone","finish-desktop","retained"].includes(name) ? "candidate" : name)));
    if (!name || request.method !== (["finish-phone","finish-desktop","retained"].includes(name) ? "GET" : "POST")) return;
    const hash = createHash("sha256"), clone = response.clone();
    if (!clone.body) return;
    const body = clone.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk, controller) {hash.update(chunk);controller.enqueue(chunk);}}));
    let value:unknown;
    try {value = await readBrowserJson(new Response(body,{headers:clone.headers}),1<<20,10_000);}
    catch {throw new B5DeviceRefusalV1("B5_DEVICE_SERVICE_RESPONSE");}
    const common = {name:name as B5DeviceServiceEvidenceV1["events"][number]["name"],at:new Date(now()).toISOString(),method:request.method as "GET"|"POST",path:url.pathname,status:response.status,responseDigest:`sha256:${hash.digest("hex")}`};
    let event: B5DeviceServiceEvidenceV1["events"][number];
    if (request.method === "POST") {
      const receipt = loopBridgeReceiptSchemaV1.safeParse(value);
      if (!receipt.success || receipt.data.state !== "accepted" || binding && (receipt.data.requestId !== binding.requestId || receipt.data.localVersion !== binding.inputVersion)) return;
      event = common;
    } else {
      const card = loopCandidateCardSchemaV1.safeParse((value as {candidate?:unknown})?.candidate);
      if (!card.success || !binding || card.data.requestId !== binding.requestId || card.data.localVersion !== binding.inputVersion
        || card.data.evidence.binding.runLinkId !== binding.runLinkId || card.data.projectId !== options.projectId) return;
      event = {...common,recordDigest:card.data.recordDigest,candidateRevision:card.data.candidateRevision,baseRevision:card.data.evidence.binding.baseRevision};
    }
    // A new phase/acceptance cannot steal an in-flight response's correlation.
    await locked(async () => {
      need(pending === current && observed === observation && !accepted.has(current.sequence),"B5_DEVICE_STALE");
      // Preserve the first accepted exchange, which precedes the capture;
      // background candidate polling must not replace it after the screenshot.
      if(!events.some(e=>e.name === event.name)) events.push(event);
    });
  }
  const mailbox = {
    root, projectPath,
    request(phase: B5DeviceRequestV1["phase"], target: "phone" | "desktop", expiresAt: string, binding?: B5DeviceRequestV1["binding"]) {
      return locked(async () => {
        const request = parse(b5DeviceRequestSchemaV1, { schemaVersion: 1, sessionNonce: randomBytes(16).toString("hex"),
          sequence: sequence + 1, phase, origin, device: target, expiresAt, ...(binding ? { binding } : {}) });
        need(Date.parse(expiresAt) > now(), "B5_DEVICE_EXPIRED");
        if (pending) await custody(join(root, "request.json"), root);
        await publish(join(root, "request.json"), request, false);
        sequence = request.sequence; pending = request; events = []; observed = undefined; challengedSession = undefined; return structuredClone(request);
      });
    },
    // Wrap the actual built product handler. Authenticated first read sets the
    // one-use cookie; second read echoes it. No added route or query allowance.
    async handle(request: Request, render: () => Promise<Response>) {
      const response = await render(), url = new URL(request.url);
      await observeAction(request, response);
      if (closed || response.status !== 200 || request.method !== "GET" || url.origin !== origin || url.pathname !== projectPath || url.search) return response;
      return locked(async () => {
        const current = pending;
        if (!current || accepted.has(current.sequence) || Date.parse(current.expiresAt) <= now()) return response;
        const cookies = request.headers.get("cookie") ?? "";
        const tokens = cookies.split(";").map(x => x.trim()).filter(x => /^control_room_local_owner=[A-Za-z0-9_-]{43}$/u.test(x));
        if (tokens.length !== 1) return response;
        const sessionDigest = b5DeviceHashV1(tokens[0]!);
        need(!sessions.has(sessionDigest) || sessions.get(sessionDigest) === current.device, "B5_DEVICE_SESSION");
        need(!challengedSession || challengedSession === sessionDigest, "B5_DEVICE_SESSION");
        challengedSession = sessionDigest; sessions.set(sessionDigest, current.device);
        const challenges = cookies.split(";").map(x => x.trim()).filter(x => x.startsWith("b5_correlation="));
        const headers = new Headers(response.headers);
        if (challenges.length === 1 && challenges[0] === `b5_correlation=${current.sessionNonce}`) {
          need(!observed, "B5_DEVICE_DUPLICATE");
          observed = { sessionDigest, routeClass: "project-document", method: "GET", status: 200, observedAt: new Date(now()).toISOString(),
            sessionNonce: current.sessionNonce, sequence: current.sequence, device: current.device };
          await checked();
          await publish(join(root, "observations", `${current.sequence}.json`), observed, true);
          headers.append("set-cookie", "b5_correlation=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + (origin.startsWith("https:") ? "; Secure" : ""));
        } else headers.append("set-cookie", `b5_correlation=${current.sessionNonce}; Path=/; HttpOnly; SameSite=Strict` + (origin.startsWith("https:") ? "; Secure" : ""));
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }).catch(error => {
        // Reloads can race the single evidence observation. Keep the refusal on
        // the HTTP path without replacing evidence or throwing into the product.
        if (error instanceof B5DeviceRefusalV1 && ["B5_DEVICE_DUPLICATE", "B5_DEVICE_SEQUENCE_RACE"].includes(error.code))
          return new Response(error.code, { status: 409, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
        throw error;
      });
    },
    observation() { return observed ? structuredClone(observed) : undefined; },
    accept(value: unknown) {
      return locked(async () => {
        const receipt = parse(b5DeviceReceiptSchemaV1, value);
        need(pending, "B5_DEVICE_STALE");
        const saved = parse(b5DeviceRequestSchemaV1, parseB5DeviceJsonV1((await readB5DeviceFileV1(join(root, "request.json"), root)).toString("utf8")));
        need(stable(saved) === stable(pending), "B5_DEVICE_REQUEST_CHANGED");
        need(receipt.sequence === pending.sequence, "B5_DEVICE_STALE");
        need(receipt.origin === pending.origin, "B5_DEVICE_ORIGIN");
        need(receipt.device === pending.device, "B5_DEVICE_DEVICE");
        need(receipt.sessionNonce === pending.sessionNonce, "B5_DEVICE_NONCE");
        need(receipt.phase === pending.phase && stable(receipt.binding) === stable(pending.binding) && receipt.expiresAt === pending.expiresAt, "B5_DEVICE_REQUEST_CHANGED");
        need(now() < Date.parse(pending.expiresAt) && Date.parse(receipt.observedAt) <= now(), "B5_DEVICE_EXPIRED");
        need(receipt.real === options.real, "B5_DEVICE_REAL");
        if (options.inventory) { const browser = options.inventory[receipt.device];
          need(receipt.browser === `${browser.browser}/${browser.browserVersion}`, "B5_DEVICE_BROWSER"); }
        need(observed && stable(receipt.observation) === stable(observed)
          && Date.parse(receipt.observedAt) >= Date.parse(observed.observedAt), "B5_DEVICE_CORRELATION");
        need(stable(receipt.actions) === stable(phaseActions[pending.phase]), "B5_DEVICE_ACTIONS");
        if (pending.phase === "close") need(receipt.closeAttestation && Date.parse(receipt.closeAttestation.closedAt) >= Date.parse(observed.observedAt)
          && Date.parse(receipt.closeAttestation.closedAt) <= Date.parse(receipt.observedAt), "B5_DEVICE_CLOSE");
        else need(!receipt.closeAttestation, "B5_DEVICE_CLOSE");
        const paths = new Set<string>();
        for (const capture of receipt.captures) {
          need(/^captures\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|jpeg|mp4|mov)$/u.test(capture.path) && !paths.has(capture.path), "B5_DEVICE_PATH");
          paths.add(capture.path);
          need(capture.device === receipt.device && capture.sessionNonce === receipt.sessionNonce && capture.sequence === receipt.sequence
            && Date.parse(capture.capturedAt) >= Date.parse(observed.observedAt) && Date.parse(capture.capturedAt) <= Date.parse(receipt.observedAt), "B5_DEVICE_CORRELATION");
          const bytes = await readB5DeviceFileV1(join(root, capture.path), root, 1 << 20);
          need(bytes.length > 0 && b5DeviceHashV1(bytes) === capture.sha256, "B5_DEVICE_CAPTURE_CHANGED");
          if (options.real) need(isCapture(bytes, capture.path), "B5_DEVICE_CAPTURE_FORMAT");
        }
        if (options.real) {
          const service = parse(b5DeviceServiceEvidenceSchemaV1,{sequence:receipt.sequence,events});
          assertB5EvidenceSecretFreeV1(service);
          need(expectedServiceActions(pending).every(name=>service.events.some(e=>e.name === name)),"B5_DEVICE_SERVICE_MISSING");
          need(service.events.every(e=>Date.parse(e.at) >= Date.parse(receipt.observation.observedAt)
            && receipt.captures.every(c=>Date.parse(e.at) <= Date.parse(c.capturedAt))),"B5_DEVICE_CORRELATION");
          await publish(join(root,"service",`${receipt.sequence}.json`),service,true);
          sealedService.set(receipt.sequence,b5DeviceHashV1(JSON.stringify(service)+"\n"));
        }
        await publish(join(root, "receipts", `${receipt.sequence}.json`), receipt, true);
        accepted.set(receipt.sequence, b5DeviceHashV1(JSON.stringify(receipt) + "\n")); return receipt;
      });
    },
    async readServiceEvidence(sequence: number) {
      need(accepted.has(sequence) && options.real,"B5_DEVICE_STALE");
      const bytes=await readB5DeviceFileV1(join(root,"service",`${sequence}.json`),root);
      need(sealedService.get(sequence) === b5DeviceHashV1(bytes),"B5_DEVICE_SERVICE_CHANGED");
      const value=parseB5DeviceJsonV1(bytes.toString("utf8")); assertB5EvidenceSecretFreeV1(value);
      return parse(b5DeviceServiceEvidenceSchemaV1,value);
    },
    async readReceipt(sequence: number) {
      need(Number.isSafeInteger(sequence) && sequence > 0, "B5_DEVICE_STALE"); await checked();
      const bytes = await readB5DeviceFileV1(join(root, "receipts", `${sequence}.json`), root);
      need(accepted.get(sequence) === b5DeviceHashV1(bytes), "B5_DEVICE_RECEIPT_CHANGED");
      const receipt = parse(b5DeviceReceiptSchemaV1, parseB5DeviceJsonV1(bytes.toString("utf8")));
      for (const capture of receipt.captures) {
        need(/^captures\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|jpeg|mp4|mov)$/u.test(capture.path), "B5_DEVICE_PATH");
        need(b5DeviceHashV1(await readB5DeviceFileV1(join(root, capture.path), root, 1 << 20)) === capture.sha256, "B5_DEVICE_CAPTURE_CHANGED");
      }
      return receipt;
    },
    close() { closed = true; return closing ??= Promise.allSettled([...active]).then(() => {}); },
  };
  return Object.freeze(mailbox);
}
export type B5DeviceMailboxV1 = Awaited<ReturnType<typeof createB5DeviceMailboxV1>>;

export const B5_DEVICE_INSTALL_COMMAND_V1 = "tailscale serve --bg --https=60462 http://127.0.0.1:60460";
export const B5_DEVICE_OFF_COMMAND_V1 = "tailscale serve --https=60462 off";
export const B5_DEVICE_STATUS_COMMAND_V1 = "tailscale serve status --json";
export const b5RemovalReceiptSchemaV1 = z.object({ schemaVersion: z.literal(1), actor: z.literal("owner"),
  removalNonce: nonce, observedAt: utc, installSettled: z.literal(true), installCancelled: z.boolean(),
  off: z.object({ command: z.literal(B5_DEVICE_OFF_COMMAND_V1), port: z.literal(60462), exitCode: z.number().int() }).strict(),
  status: z.object({ command: z.literal(B5_DEVICE_STATUS_COMMAND_V1), exitCode: z.number().int(), afterStatus: status, afterDigest: digest }).strict(),
  beforeDigest: digest, installedDigest: digest,
}).strict();
export type B5RemovalReceiptV1 = z.infer<typeof b5RemovalReceiptSchemaV1>;
export type B5MappingDispositionV1 = { disposition: "mapping-removed" | "mapping-outstanding"; hostStopped: boolean; comparison: boolean | null;
  failures: string[]; removalReceiptDigest?: string; beforeDigest: string; installedDigest: string; afterDigest?: string };
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, code: string) {
  const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(() => work(abort.signal)), new Promise<never>((_, no) => {
    timer = setTimeout(() => { abort.abort(); no(new B5DeviceRefusalV1(code)); }, ms);
  })]); } finally { clearTimeout(timer); }
}
// Register before requesting installation or acquiring resources. Removal has its
// own context; the caller's abort must never cancel safety cleanup. No CLI here.
export function createB5DeviceCleanupV1(q: B5TransportQualificationV1, ports: {
  closeHost(signal: AbortSignal): Promise<void>;
  requestRemoval(request: { removalNonce: string; requestedAt: string }, signal: AbortSignal): Promise<unknown>;
  now?: () => number; closeMs?: number; removalMs?: number;
}) {
  let closing: Promise<B5MappingDispositionV1> | undefined;
  const now = ports.now ?? Date.now;
  return () => closing ??= (async () => {
    const result: B5MappingDispositionV1 = { disposition: "mapping-outstanding", hostStopped: false, comparison: null, failures: [], beforeDigest: q.beforeDigest, installedDigest: q.installedDigest };
    try { await bounded(ports.closeHost, Math.min(60_000, ports.closeMs ?? 60_000), "B5_DEVICE_HOST_CLOSE_TIMEOUT"); result.hostStopped = true; }
    catch (error) { result.failures.push(error instanceof B5DeviceRefusalV1 ? error.code : "B5_DEVICE_HOST_CLEANUP"); }
    const removalNonce = randomBytes(16).toString("hex"), requestedAt = new Date(now()).toISOString();
    try {
      const value = await bounded(signal => ports.requestRemoval({ removalNonce, requestedAt }, signal),
        Math.min(120_000, ports.removalMs ?? 120_000), "B5_DEVICE_REMOVAL_TIMEOUT");
      result.removalReceiptDigest = b5DeviceHashV1(stable(value));
      const receipt = parse(b5RemovalReceiptSchemaV1, value, "B5_DEVICE_REMOVAL_RECEIPT");
      result.afterDigest = b5MappingDigestV1(receipt.status.afterStatus);
      need(receipt.removalNonce === removalNonce && Date.parse(receipt.observedAt) >= Date.parse(requestedAt) && Date.parse(receipt.observedAt) <= now(), "B5_DEVICE_REMOVAL_RECEIPT");
      need(receipt.off.exitCode === 0 && receipt.status.exitCode === 0, "B5_DEVICE_REMOVAL_COMMAND");
      need(receipt.beforeDigest === q.beforeDigest && receipt.installedDigest === q.installedDigest
        && receipt.status.afterDigest === b5MappingDigestV1(receipt.status.afterStatus), "B5_DEVICE_MAPPING_DIGEST");
      result.comparison = compareB5RemovedStatusV1(q.beforeStatus,receipt.status.afterStatus,q.origin);
      need(result.comparison, "B5_DEVICE_MAPPING_DRIFT");
      result.disposition = "mapping-removed"; result.removalReceiptDigest = b5DeviceHashV1(stable(receipt)); result.afterDigest = receipt.status.afterDigest;
    } catch (error) { result.failures.push(error instanceof B5DeviceRefusalV1 ? error.code : "B5_DEVICE_REMOVAL_RECEIPT"); }
    return result;
  })();
}

/** Bounded owner mailbox waits. The lead writes observations; no callback can
 * choose engine commands. Caller interruption only applies to non-cleanup waits. */
export async function waitB5DeviceJsonV1(file: string, root: string, signal: AbortSignal, deadline: number) {
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const exists = await lstat(file).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; });
    if (exists) return parseB5DeviceJsonV1((await readB5DeviceFileV1(file, root)).toString("utf8"));
    await new Promise<void>(yes => { const timer = setTimeout(done, 100); function done() { clearTimeout(timer); signal.removeEventListener("abort", done); yes(); } signal.addEventListener("abort", done, { once: true }); });
  }
  throw new B5DeviceRefusalV1("B5_DEVICE_RECEIPT_TIMEOUT");
}
export async function writeB5DeviceRequestV1(file: string, value: unknown) {
  const root = dirname(file);
  need(resolve(file) === file && basename(root) === "device" && /^(?:install-request|install-cancelled|removal-request|cleanup-result|stop-request)\.json$/u.test(basename(file)), "B5_DEVICE_PATH");
  await custody(root, root, true);
  try { await publish(file, value, true); }
  catch (error) { throw error instanceof B5DeviceRefusalV1 ? error : new B5DeviceRefusalV1("B5_DEVICE_IO"); }
}

/** Device-side delivery for waitB5DeviceJsonV1; acceptance remains with the mailbox. */
export async function writeB5DeviceReceiptV1(file: string, value: unknown) {
  const inbox = dirname(file), root = dirname(inbox);
  need(isAbsolute(file) && resolve(file) === file && basename(root) === "device" && basename(inbox) === "inbox"
    && /^[1-9][0-9]*\.json$/u.test(basename(file)), "B5_DEVICE_PATH");
  const receipt = parse(b5DeviceReceiptSchemaV1, value);
  need(basename(file) === `${receipt.sequence}.json`, "B5_DEVICE_PATH");
  await custody(root, root, true); await custody(inbox, root, true);
  try { await publish(file, receipt, true); }
  catch (error) { throw error instanceof B5DeviceRefusalV1 ? error : new B5DeviceRefusalV1("B5_DEVICE_IO"); }
}

function isCapture(bytes: Buffer, path: string) {
  if (path.endsWith(".png")) return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (/\.jpe?g$/u.test(path)) return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.subarray(4, 8).toString("ascii") === "ftyp";
}
const absolute = z.string().refine(v => isAbsolute(v) && resolve(v) === v && !/[\0\r\n]/u.test(v));
export const b5DeviceTrialSchemaV1 = z.object({ configFile: absolute, configDigest: digest, transportDigest: digest,
  ownerCodeSocket: absolute }).strict();
export const b5DeviceSmokePacketSchemaV1 = z.object({ schemaVersion: z.literal(1), ownerWindowApproved: z.literal(true),
  authorizedAt: utc, expiresAt: utc, trials: z.object({ smoke: b5DeviceTrialSchemaV1, deadline: b5DeviceTrialSchemaV1,
    stop: b5DeviceTrialSchemaV1, "cold-read": b5DeviceTrialSchemaV1, verifier: b5DeviceTrialSchemaV1, interrupt: b5DeviceTrialSchemaV1 }).strict() }).strict();
export async function resolveB5DeviceSmokePacketV1(file?: string) {
  need(file, "B5_DEVICE_QUALIFICATION_REQUIRED");
  const packet = parse(b5DeviceSmokePacketSchemaV1, parseB5DeviceJsonV1((await readB5DeviceFileV1(file, dirname(file))).toString("utf8")), "B5_DEVICE_QUALIFICATION");
  need(Date.parse(packet.authorizedAt) <= Date.now() && Date.now() < Date.parse(packet.expiresAt), "B5_DEVICE_EXPIRED");
  need(new Set(Object.values(packet.trials).map(v => v.configFile)).size === 6, "B5_DEVICE_TRIAL_REUSE");
  return packet;
}
