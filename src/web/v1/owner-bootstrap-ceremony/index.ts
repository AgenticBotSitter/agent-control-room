import { randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { DatabaseClient } from "../../../persistence/database";
import { sha256Digest } from "../../../security";
import { createAccessVerifier, cloudflareAccessGatewayAssertionProfileV1, requireSameOrigin,
  type AccessTrust } from "../access-verifier";
import { privateResponseHeaders, readBoundedJson } from "../http-common";
import { createPrivateOwnerBootstrap, type PrivateOwnerBootstrapConfiguration } from "../private-owner-bootstrap";

const CONTROL_REQUEST = Buffer.from('{"operation":"arm"}', "utf8");
const CODE_LIFETIME_MS = 5 * 60_000;

export interface LinuxUnixOwnerBootstrapControlAttemptV1 {
  transport: "unix";
  platform: "linux";
  runtimeDirectory: string;
  socketPath: string;
  serviceUid: number;
  operatorUid: number;
  directory: { kind: "directory"; path: string; uid: number; mode: number; linkCount: number };
  socket: { kind: "socket"; path: string; uid: number; mode: number; linkCount: number };
  peer: { uid: number; pid: number };
  requestBytes: Uint8Array;
  writeCode(code: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface OwnerBootstrapCeremonyV1 {
  isBootstrapOnly(): boolean;
  arm(attempt: LinuxUnixOwnerBootstrapControlAttemptV1, signal?: AbortSignal): Promise<Readonly<{
    schema: "control-room.owner-bootstrap-arm/v1"; armed: true; expiresAt: string;
    listenerStarted: false; physicalPeerQualificationComplete: false;
  }>>;
  route(request: Request): Promise<Response | undefined>;
  close(): Promise<void>;
}

/** Durable adapter contract. claim() must be atomic create-once across processes. */
export interface OwnerBootstrapLifecycleStoreV1 {
  inspect(): Promise<"available" | "claimed" | "complete">;
  claim(signal: AbortSignal): Promise<void>;
  complete(signal: AbortSignal): Promise<void>;
}

export interface OwnerBootstrapCeremonyConfigurationV1 {
  origin: string;
  trust: AccessTrust;
  owner: PrivateOwnerBootstrapConfiguration;
  database: DatabaseClient;
  runtimeDirectory: string;
  socketPath: string;
  serviceUid: number;
  operatorUid: number;
  lifecycle: OwnerBootstrapLifecycleStoreV1;
  clock?: () => number;
  random?: (size: number) => Uint8Array;
  controlDeadlineMs?: number;
}

const unavailable = (): never => { throw new Error("owner_bootstrap_ceremony_unavailable"); };
const failedResponse = () => Response.json({ error: "owner_bootstrap_unavailable" },
  { status: 503, headers: privateResponseHeaders });
const identityCount = async (db: DatabaseClient, tenantId: string) => {
  const rows = (await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_identities WHERE tenant_id=$1", [tenantId])).rows;
  if (rows.length !== 1 || !/^\d+$/.test(rows[0]?.count ?? "")) unavailable();
  return Number(rows[0]!.count);
};
const equal = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
async function readBoundedForm(body: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) unavailable(); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const params = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if ([...params.keys()].length !== 1 || params.getAll("code").length !== 1) unavailable();
    return params.get("code") ?? unavailable();
  } catch { return unavailable(); }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Pure Linux evidence validation. The caller must obtain these values from a reviewed
 * SO_PEERCRED/stat implementation; this module never opens a socket or trusts a request field. */
export function assertLinuxUnixOwnerBootstrapPeerV1(attempt: LinuxUnixOwnerBootstrapControlAttemptV1,
  expected: Pick<OwnerBootstrapCeremonyConfigurationV1,
    "runtimeDirectory" | "socketPath" | "serviceUid" | "operatorUid">): void {
  const inside = relative(resolve(expected.runtimeDirectory), resolve(expected.socketPath));
  if (attempt.transport !== "unix" || attempt.platform !== "linux" || !isAbsolute(expected.runtimeDirectory)
    || !isAbsolute(expected.socketPath) || inside.startsWith("..") || isAbsolute(inside) || inside === ""
    || attempt.runtimeDirectory !== expected.runtimeDirectory || attempt.socketPath !== expected.socketPath
    || attempt.serviceUid !== expected.serviceUid || attempt.operatorUid !== expected.operatorUid
    // The portable MVP deliberately requires the service and attached operator to be the same OS account.
    || expected.serviceUid !== expected.operatorUid || attempt.peer.uid !== expected.operatorUid
    || !Number.isSafeInteger(attempt.peer.pid) || attempt.peer.pid < 1
    || attempt.directory.kind !== "directory" || attempt.directory.path !== expected.runtimeDirectory
    || attempt.directory.uid !== expected.serviceUid || attempt.directory.mode !== 0o700
    || !Number.isSafeInteger(attempt.directory.linkCount) || attempt.directory.linkCount < 2
    || attempt.socket.kind !== "socket" || attempt.socket.path !== expected.socketPath
    || attempt.socket.uid !== expected.serviceUid || attempt.socket.mode !== 0o600 || attempt.socket.linkCount !== 1
    || Buffer.from(attempt.requestBytes).compare(CONTROL_REQUEST) !== 0) unavailable();
}

/** Effect-free composition until arm() is called with an injected, already-accepted Unix peer.
 * The only raw code copy is handed to writeCode and is never returned or persisted. */
export function createOwnerBootstrapCeremonyV1(config: OwnerBootstrapCeremonyConfigurationV1): OwnerBootstrapCeremonyV1 {
  const origin = new URL(config.origin);
  const controlDeadlineMs = config.controlDeadlineMs ?? 2000;
  if (origin.protocol !== "https:" || origin.origin !== config.origin || !isAbsolute(config.runtimeDirectory)
    || !isAbsolute(config.socketPath) || !Number.isSafeInteger(config.serviceUid) || config.serviceUid < 0
    || !Number.isSafeInteger(config.operatorUid) || config.operatorUid < 0
    || !Number.isSafeInteger(controlDeadlineMs) || controlDeadlineMs < 1 || controlDeadlineMs > 2000) unavailable();
  const verify = createAccessVerifier(config.trust, cloudflareAccessGatewayAssertionProfileV1);
  const clock = config.clock ?? Date.now, entropy = config.random ?? (size => randomBytes(size));
  const bootstrap = createPrivateOwnerBootstrap(config.owner, config.trust, { database: config.database, clock });
  const shutdown = new AbortController(); let closed = false;
  let state: "checking" | "idle" | "arming" | "armed" | "consuming" | "complete" | "terminal" = "checking";
  let codeDigest: string | undefined, expiresAt = 0, highWater = -1;
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < highWater || value < 0) unavailable(); highWater = value; return value; };
  const terminal = () => { state = "terminal"; codeDigest = undefined; expiresAt = 0; };
  const ready = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), controlDeadlineMs); });
    try {
      const identities = await Promise.race([identityCount(config.database, config.owner.tenantId), deadline]);
      if (closed) return;
      if (identities > 0) { state = "complete"; return; }
      const lifecycle = await Promise.race([config.lifecycle.inspect(), deadline]);
      if (!closed) state = lifecycle === "available" ? "idle" : "terminal";
    } catch { terminal(); } finally { clearTimeout(timer); }
  })();

  return Object.freeze({
    isBootstrapOnly: () => state !== "complete",
    async arm(attempt: LinuxUnixOwnerBootstrapControlAttemptV1, signal?: AbortSignal) {
      await ready;
      if (closed || state !== "idle" || signal?.aborted) unavailable();
      assertLinuxUnixOwnerBootstrapPeerV1(attempt, config);
      state = "arming";
      const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      const relay = () => abort.abort(); signal?.addEventListener("abort", relay, { once: true });
      shutdown.signal.addEventListener("abort", relay, { once: true });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error()); }, controlDeadlineMs);
      });
      try {
        if (await Promise.race([identityCount(config.database, config.owner.tenantId), deadline]) !== 0) unavailable();
        if (closed || signal?.aborted) unavailable();
        await Promise.race([config.lifecycle.claim(abort.signal), deadline]);
        if (closed || signal?.aborted || abort.signal.aborted) unavailable();
        const issuedAt = now(), candidate = Buffer.from(entropy(32));
        if (candidate.byteLength !== 32) unavailable();
        const code = candidate.toString("base64url");
        codeDigest = sha256Digest({ code }); expiresAt = issuedAt + CODE_LIFETIME_MS;
        await Promise.race([attempt.writeCode(code, abort.signal), deadline]);
        if (closed || abort.signal.aborted || now() >= expiresAt) unavailable();
      } catch { terminal(); throw new Error("owner_bootstrap_control_uncertain"); }
      finally {
        clearTimeout(timer); signal?.removeEventListener("abort", relay); shutdown.signal.removeEventListener("abort", relay);
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([attempt.close(), new Promise<never>((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error()), controlDeadlineMs);
        })]); }
        catch { terminal(); throw new Error("owner_bootstrap_control_cleanup_uncertain"); }
        finally { clearTimeout(closeTimer); }
      }
      // Redemption cannot begin until both delivery and control cleanup finish definitely.
      if (closed || signal?.aborted || abort.signal.aborted || now() >= expiresAt) { terminal(); return unavailable(); }
      state = "armed";
      return Object.freeze({ schema: "control-room.owner-bootstrap-arm/v1", armed: true,
        expiresAt: new Date(expiresAt).toISOString(), listenerStarted: false,
        physicalPeerQualificationComplete: false });
    },
    async route(request: Request) {
      await ready;
      if (closed) return failedResponse();
      const url = new URL(request.url);
      if (url.origin !== config.origin) return failedResponse();
      if (url.pathname !== "/owner-bootstrap" && url.pathname !== "/api/v1/owner-bootstrap")
        return state === "complete" ? undefined : failedResponse();
      if (state === "complete") return new Response(null, { status: 404 });
      const operation = new AbortController();
      const relay = () => operation.abort(); request.signal.addEventListener("abort", relay, { once: true });
      shutdown.signal.addEventListener("abort", relay, { once: true });
      let ownsConsumption = false;
      try {
        requireSameOrigin(request, config.origin);
        if (url.pathname === "/owner-bootstrap") {
          if (request.method !== "GET" || url.search) unavailable();
          return new Response("<!doctype html><meta charset=utf-8><title>Set up owner</title><form method=post action=/api/v1/owner-bootstrap><label>One-time code <input name=code autocomplete=one-time-code required></label><button>Continue</button></form>",
            { headers: { ...privateResponseHeaders, "content-type": "text/html; charset=utf-8" } });
        }
        const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        const requestBody = request.body;
        if (request.method !== "POST" || url.search || state !== "armed" || !requestBody
          || contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") unavailable();
        const bodyStream = requestBody ?? unavailable();
        const at = now(); if (at >= expiresAt) { terminal(); unavailable(); }
        // Verification owns subject/provider. The body is permitted to contain only the code.
        verify(request, at);
        let code: string;
        if (contentType === "application/json") {
          const body = await readBoundedJson(bodyStream, 512) as unknown;
          if (closed || operation.signal.aborted) unavailable();
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).join(",") !== "code" || typeof (body as { code?: unknown }).code !== "string") unavailable();
          code = (body as { code: string }).code;
        } else {
          code = await readBoundedForm(bodyStream, 512);
          if (closed || operation.signal.aborted) unavailable();
        }
        if (code.length !== 43 || !codeDigest || !equal(sha256Digest({ code }), codeDigest)) unavailable();
        if (state !== "armed") unavailable();
        if (now() >= expiresAt) { terminal(); unavailable(); }
        const assertion = request.headers.get(cloudflareAccessGatewayAssertionProfileV1.assertionHeader) ?? unavailable();
        state = "consuming"; ownsConsumption = true; codeDigest = undefined;
        await bootstrap.bootstrap(assertion, operation.signal);
        if (closed || operation.signal.aborted || state !== "consuming") unavailable();
        const completionAbort = new AbortController(); let completionTimer: ReturnType<typeof setTimeout> | undefined;
        const relayCompletion = () => completionAbort.abort(); operation.signal.addEventListener("abort", relayCompletion, { once: true });
        try { await Promise.race([config.lifecycle.complete(completionAbort.signal), new Promise<never>((_, reject) => {
          completionTimer = setTimeout(() => { completionAbort.abort(); reject(new Error()); }, controlDeadlineMs);
        })]); if (completionAbort.signal.aborted) unavailable(); }
        finally { clearTimeout(completionTimer); operation.signal.removeEventListener("abort", relayCompletion); }
        if (closed || operation.signal.aborted || state !== "consuming") unavailable();
        state = "complete";
        return Response.json({ schema: "control-room.owner-bootstrap-complete/v1", ownerCreated: true,
          normalApplicationAvailable: true, physicalGatewayAcceptanceComplete: false }, { status: 201 });
      } catch { if (ownsConsumption && state === "consuming") terminal(); return failedResponse(); }
      finally { request.signal.removeEventListener("abort", relay); shutdown.signal.removeEventListener("abort", relay); }
    },
    async close() { closed = true; shutdown.abort(); terminal(); },
  });
}
