import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { privateResponseHeaders } from "./http-common";
import type { PrivateClientAssets } from "./private-assets";

export const privateHttpLimits = Object.freeze({ headersBytes: 24_576, headerCount: 64, urlBytes: 4096,
  bodyBytes: 8192, responseBytes: 4 * 1024 * 1024, activeRequests: 64,
  taskBodyBytes: 32_768,
  bodyMs: 5000, requestMs: 30_000, drainMs: 30_000 });
export interface PrivateServingApplication { isReady(): boolean; close(): Promise<void> }
export type PrivateBuiltHandler = (request: Request) => Promise<Response> | Response;
const forwarded = new Set(["accept", "accept-language", "cf-access-jwt-assertion", "origin", "sec-fetch-site",
  "content-type", "idempotency-key", "x-requested-with", "rsc", "next-router-state-tree", "next-router-prefetch",
  "next-router-segment-prefetch", "next-url"]);
class RequestFailure extends Error { constructor(readonly status: number) { super("private_request_rejected"); } }

function requestHead(input: IncomingMessage, origins: readonly string[], localDemo: boolean) {
  if (input.socket.remoteAddress !== "127.0.0.1" || input.httpVersion !== "1.1") throw new RequestFailure(403);
  const method = input.method;
  const target = input.url;
  if (!method || !["GET", "HEAD", "POST"].includes(method)) throw new RequestFailure(405);
  if (!target || Buffer.byteLength(target) > privateHttpLimits.urlBytes || !target.startsWith("/")
    || target.startsWith("//") || /[\\\s#]/u.test(target)
    || [...target].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new RequestFailure(400);
  const all = new Map<string, string>(), headers = new Headers();
  const raw = input.rawHeaders;
  if (raw.length % 2 || raw.length > privateHttpLimits.headerCount * 2) throw new RequestFailure(431);
  let bytes = 0;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase(), value = raw[i + 1];
    bytes += Buffer.byteLength(raw[i]) + Buffer.byteLength(value) + 4;
    if (bytes > privateHttpLimits.headersBytes) throw new RequestFailure(431);
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)
      || [...value].some(char => char.charCodeAt(0) < 32 && char !== "\t" || char.charCodeAt(0) === 127)
      || all.has(name)) throw new RequestFailure(400);
    all.set(name, value);
    if (forwarded.has(name) || localDemo && name === "cookie") headers.set(name, value);
  }
  const origin = origins.find(value => new URL(value).host === all.get("host"));
  if (!origin) throw new RequestFailure(403);
  const url = new URL(target, origin);
  // Select only a configured host, never X-Forwarded-Host or an absolute target.
  if (url.origin !== origin || `${url.pathname}${url.search}` !== target) throw new RequestFailure(400);
  if (localDemo && [...all.keys()].some(name => name === "forwarded" || name.startsWith("x-forwarded-"))) throw new RequestFailure(403);
  if (["upgrade", "expect", "trailer", "content-encoding"].some(name => all.has(name))) throw new RequestFailure(400);
  const length = all.get("content-length"), transfer = all.get("transfer-encoding");
  if (length !== undefined && (!/^(0|[1-9][0-9]{0,8})$/.test(length) || transfer !== undefined)
    || transfer !== undefined && transfer !== "chunked") throw new RequestFailure(400);
  const expectedLength = length === undefined ? undefined : Number(length);
  // Task endpoints have existing 16/24/32 KiB parsers. The outer transport must not
  // truncate valid task input; endpoint-specific limits and authentication still apply.
  const bodyLimit = method === "POST" && (/^\/api\/v1\/projects\/[^/]+\/tasks(?:\/|$)/.test(url.pathname)
    || localDemo && url.pathname === "/api/v1/local-pilot/workspace")
    ? privateHttpLimits.taskBodyBytes : privateHttpLimits.bodyBytes;
  if (expectedLength !== undefined && expectedLength > bodyLimit) throw new RequestFailure(413);
  if (method !== "POST" && (transfer || expectedLength && expectedLength > 0)) throw new RequestFailure(400);
  return { url, method, headers, expectedLength, bodyLimit };
}

function consumeBody(input: IncomingMessage, signal: AbortSignal, expectedLength: number | undefined, bodyMs: number, bodyLimit: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => finish(new RequestFailure(408)), bodyMs);
    function finish(error?: Error) {
      clearTimeout(timer); input.pause();
      input.off("data", data); input.off("end", end); input.off("error", failed); input.off("aborted", failed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(Buffer.concat(chunks, size));
    }
    function data(chunk: Buffer) {
      size += chunk.length;
      if (size > bodyLimit) finish(new RequestFailure(413)); else chunks.push(chunk);
    }
    function end() {
      finish(!input.complete || input.rawTrailers.length || expectedLength !== undefined && size !== expectedLength
        ? new RequestFailure(400) : undefined);
    }
    function failed() { finish(new RequestFailure(400)); }
    function aborted() { finish(new RequestFailure(408)); }
    input.on("data", data); input.once("end", end); input.once("error", failed); input.once("aborted", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted(); else if (input.readableEnded) end();
  });
}

async function deliver(output: ServerResponse, response: Response, method: string, signal: AbortSignal, localDemo: boolean) {
  if (signal.aborted || output.destroyed) { void response.body?.cancel().catch(() => {}); return; }
  output.statusCode = response.status;
  // Runtime owns framing/connection lifetime. Do not relay a handler's hop-by-hop headers or cookies.
  for (const [name, value] of response.headers) {
    if (!["connection", "transfer-encoding", "keep-alive", "upgrade", "trailer", "content-length"].includes(name)
      && (name !== "set-cookie" || localDemo))
      output.setHeader(name, value);
  }
  for (const [name, value] of Object.entries(privateResponseHeaders)) output.setHeader(name, value);
  output.setHeader("connection", "close");
  if (method === "HEAD" || !response.body) {
    void response.body?.cancel().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const abort = () => { output.destroy(); reject(new Error("private_response_interrupted")); };
      signal.addEventListener("abort", abort, { once: true });
      output.end(() => { signal.removeEventListener("abort", abort); resolve(); });
      if (signal.aborted) abort();
    });
    return;
  }
  let bytes = 0;
  const ceiling = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > privateHttpLimits.responseBytes ? new Error("private_response_limit") : null,
      bytes > privateHttpLimits.responseBytes ? undefined : chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as NodeWebStream<Uint8Array>), ceiling, output, { signal });
}

/** No listener, credentials, environment or filesystem access. Supplies a Node-compatible callback.
 * Trusted composition provides the built application and startup-owned immutable client snapshot.
 */
interface NodeHandlerOptions {
  origin: string; application: PrivateServingApplication; handler: PrivateBuiltHandler; assets: PrivateClientAssets;
  secondaryOrigin?: string;
  /** Test-only shortening, never a production extension. */
  timing?: { bodyMs?: number; requestMs?: number; drainMs?: number };
}

export function createPrivateNodeHandler(options: NodeHandlerOptions) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.origin !== options.origin) throw new Error("private_serving_config_invalid");
  if (options.secondaryOrigin !== undefined) {
    const secondary = new URL(options.secondaryOrigin);
    if (secondary.protocol !== "https:" || secondary.origin !== options.secondaryOrigin || secondary.origin === origin.origin
      || secondary.hostname.includes("*")) throw new Error("private_serving_config_invalid");
  }
  return createNodeHandler(options, false);
}

/** Separate local-only composition. Never selected through environment or a request.
 * The production factory above still strips cookies and requires an HTTPS origin.
 * This factory is request-only: it does not create a server or bind a listener.
 */
export function createContributorDemoNodeHandler(options: NodeHandlerOptions) {
  if (options.origin !== "http://127.0.0.1:3000") throw new Error("demo_serving_config_invalid");
  return createNodeHandler(options, true);
}

function createNodeHandler(options: NodeHandlerOptions, localDemo: boolean) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin) throw new Error("private_serving_config_invalid");
  if (localDemo && options.secondaryOrigin !== undefined) throw new Error("demo_serving_config_invalid");
  const origins = Object.freeze([options.origin, ...(options.secondaryOrigin ? [options.secondaryOrigin] : [])]);
  const limits = { ...privateHttpLimits, ...options.timing };
  for (const name of ["bodyMs", "requestMs", "drainMs"] as const)
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > privateHttpLimits[name]) throw new Error("private_serving_config_invalid");
  const active = new Set<AbortController>();
  let closing = false, closed: Promise<void> | undefined, drained: (() => void) | undefined;
  const isReady = () => !closing && options.application.isReady();
  return Object.freeze({ isReady,
    async handle(input: IncomingMessage, output: ServerResponse): Promise<void> {
      const controller = new AbortController(), { signal } = controller;
      const disconnected = () => { if (!output.writableFinished) controller.abort(); };
      const failed = () => controller.abort();
      output.once("close", disconnected); output.once("error", failed); input.once("error", failed);
      const admitted = isReady() && active.size < limits.activeRequests;
      if (admitted) active.add(controller);
      const timer = setTimeout(() => { controller.abort(); input.destroy(); output.destroy(); }, limits.requestMs);
      try {
        if (!admitted) throw new RequestFailure(503);
        const head = requestHead(input, origins, localDemo);
        const body = await consumeBody(input, signal, head.expectedLength, limits.bodyMs, head.bodyLimit);
        if (signal.aborted) return;
        if (head.method !== "POST" && body.length) throw new RequestFailure(400);
        if (head.headers.get("sec-fetch-site") === "cross-site") throw new RequestFailure(403);
        const staticPath = head.url.pathname.startsWith("/_next/") || head.url.pathname === "/favicon.svg";
        let response: Response;
        if (staticPath) {
          if (head.url.search || head.method === "POST") throw new RequestFailure(404);
          response = options.assets.respond(head.url.pathname, head.method) ?? new Response(null, { status: 404 });
        } else {
          const request = new Request(head.url, { method: head.method, headers: head.headers, signal,
            ...(head.method === "POST" && body.length ? { body: new Uint8Array(body) } : {}) });
          const work = Promise.resolve().then(() => options.handler(request));
          // An interrupted connection never retries its command. Dispose late response bytes, not the command receipt.
          void work.then(late => { if (signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
          response = await new Promise<Response>((resolve, reject) => {
            const abort = () => reject(new Error("private_request_interrupted"));
            signal.addEventListener("abort", abort, { once: true });
            void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
            if (signal.aborted) abort();
          });
        }
        await deliver(output, response, head.method, signal, localDemo);
      } catch (error) {
        if (!signal.aborted && !output.headersSent && !output.destroyed) {
          const status = error instanceof RequestFailure ? error.status : 503;
          const response = Response.json({ error: status === 503 ? "service_unavailable" : "invalid_request" }, { status });
          try { await deliver(output, response, input.method ?? "GET", signal, localDemo); } catch { output.destroy(); }
        } else output.destroy();
      } finally {
        clearTimeout(timer); controller.abort();
        output.off("close", disconnected); output.off("error", failed); input.off("error", failed);
        if (admitted) active.delete(controller);
        if (closing && active.size === 0) drained?.();
        // Every response closes its connection; incomplete input cannot be reused as another request.
        if (!input.complete) input.destroy();
      }
    },
    close(): Promise<void> {
      if (closed) return closed;
      closing = true;
      closed = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined, uncertain = false;
        if (active.size) await Promise.race([new Promise<void>(resolve => { drained = resolve; }),
          new Promise<void>(resolve => { timer = setTimeout(() => {
            uncertain = true; for (const controller of active) controller.abort(); resolve();
          }, limits.drainMs); })]);
        clearTimeout(timer);
        await options.application.close();
        if (uncertain) throw new Error("private_serving_drain_uncertain");
      })();
      return closed;
    },
  });
}
