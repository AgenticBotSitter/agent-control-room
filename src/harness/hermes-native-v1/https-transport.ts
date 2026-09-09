import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { checkServerIdentity, connect, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { ClientRequest, IncomingMessage } from "node:http";
import { z } from "zod";
import { preparePinnedHttpsConnection, verifyPinnedTlsPeer, type NetworkResolverV1 } from "../../node-policy/v1/network-target-guard";
import { digestSchema, enrollmentSchema, nativeId, nativeLimits, type NativeEnrollment, type NativeRunTransport,
  type NativeWireRequest, type NativeWireResponse } from "./contracts";

/** Native ports are injectable only by trusted construction/tests; they are not request payload options. */
export interface NativeHttpsPorts {
  resolver: NetworkResolverV1;
  connect(options: ConnectionOptions): TLSSocket;
  request(options: RequestOptions, receive: (response: IncomingMessage) => void): ClientRequest;
}
const nativePorts: NativeHttpsPorts = { resolver: { resolve: async host => (await lookup(host, { all: true, verbatim: true })).map(value => value.address) },
  connect, request: httpsRequest };
const session = z.string().regex(/^cr_[a-f0-9]{64}$/);
const bodySchema = z.object({ input: z.string().min(1), instructions: z.string(), session_id: session,
  model: enrollmentSchema.shape.model, provider: enrollmentSchema.shape.provider }).strict();
function wireShape(value: NativeWireRequest, enrollment: NativeEnrollment, stream: boolean) {
  if (Object.keys(value).some(key => !["operation", "nativeRunId", "body", "idempotencyKey", "sessionKey", "deadline", "signal", "authorize"].includes(key))
    || typeof value.authorize !== "function" || !Number.isSafeInteger(value.deadline) || value.deadline < 0
    || (stream ? value.operation !== "events" : !["capabilities", "start", "status", "stop"].includes(value.operation))) throw new Error("native_wire_invalid");
  let body: string | undefined;
  if (value.operation === "start") {
    if (value.nativeRunId !== undefined) throw new Error("native_wire_invalid");
    const parsed = bodySchema.parse(value.body); digestSchema.parse(value.idempotencyKey); session.parse(value.sessionKey);
    if (parsed.session_id !== value.sessionKey || parsed.model !== enrollment.model || parsed.provider !== enrollment.provider
      || Buffer.byteLength(parsed.input) > 32768 || Buffer.byteLength(parsed.instructions) > 8192) throw new Error("native_wire_invalid");
    body = JSON.stringify(parsed);
    if (Buffer.byteLength(body) > nativeLimits.requestBytes) throw new Error("native_wire_limit");
  } else {
    if (value.body !== undefined || value.idempotencyKey !== undefined || value.sessionKey !== undefined) throw new Error("native_wire_invalid");
    if (value.operation === "capabilities" ? value.nativeRunId !== undefined : !nativeId.safeParse(value.nativeRunId).success) throw new Error("native_wire_invalid");
  }
  const path = value.operation === "capabilities" ? "/v1/capabilities" : value.operation === "start" ? "/v1/runs"
    : `/v1/runs/${value.nativeRunId}${value.operation === "status" ? "" : `/${value.operation}`}`;
  return { body, path: `/p/${enrollment.profile}${path}`, method: value.operation === "start" || value.operation === "stop" ? "POST" : "GET" };
}

/** An inert, outbound-only HTTPS client. Construction performs no resolution, credential read or I/O.
 * An exact accepted enrollment and trusted authority are required by the adapter before invocation.
 * This does not install/start Hermes, open a listener, select a personal profile, or expose its API.
 */
export function createNativeHttpsTransport(value: NativeEnrollment,
  credential: (credentialRef: string) => Promise<string>, ports: NativeHttpsPorts = nativePorts,
  now: () => number = Date.now): NativeRunTransport {
  const enrollment = Object.freeze(enrollmentSchema.parse(value));
  async function exchange(input: NativeWireRequest, receiveChunk?: (chunk: Uint8Array) => void): Promise<NativeWireResponse> {
    input = Object.freeze({ ...input });
    let shape: ReturnType<typeof wireShape>;
    try { shape = wireShape(input, enrollment, Boolean(receiveChunk)); } catch { throw new Error("native_wire_invalid"); }
    const at = now(), maximumMs = receiveChunk ? nativeLimits.streamMs : nativeLimits.requestMs;
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("native_transport_clock_invalid");
    const deadline = Math.min(input.deadline, at + maximumMs, enrollment.validUntil);
    if (at >= deadline || input.signal?.aborted) throw new Error("native_transport_unavailable");
    let socket: TLSSocket | undefined, request: ClientRequest | undefined, response: IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, done = false;
    const ensureCurrent = () => { if (done || input.signal?.aborted || now() >= deadline) throw new Error("native_transport_unavailable"); };
    return new Promise<NativeWireResponse>((resolve, reject) => {
      const cleanup = () => {
        if (timer) clearTimeout(timer); input.signal?.removeEventListener("abort", fail);
        response?.destroy(); request?.destroy(); socket?.destroy();
      };
      const fail = () => { if (done) return; done = true; cleanup(); reject(new Error("native_transport_unavailable")); };
      const finish = (result: NativeWireResponse) => { if (done) return; done = true; cleanup(); resolve(result); };
      timer = setTimeout(fail, deadline - at); input.signal?.addEventListener("abort", fail, { once: true });
      void (async () => {
        await input.authorize(); ensureCurrent();
        const plan = await preparePinnedHttpsConnection({ canonicalDestination: enrollment.canonicalDestination,
          allowedDestinations: [enrollment.canonicalDestination], resolver: ports.resolver,
          executor: { exposesFinalDestination: true, supportsPinnedTlsConnection: true }, resolvedAt: new Date(now()).toISOString() });
        ensureCurrent(); await input.authorize(); ensureCurrent();
        // Connect to one pinned address only. No DNS fallback, address retry, redirects, pooled sockets or TLS session reuse.
        await new Promise<void>((secure, failed) => {
          socket = ports.connect({ host: plan.pinnedAddresses[0], port: plan.port,
            servername: plan.hostKind === "dns" ? plan.host : undefined, rejectUnauthorized: true,
            minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"], checkServerIdentity: (_host, cert) => checkServerIdentity(plan.host, cert) });
          socket.on("error", fail);
          socket.once("error", failed);
          socket.once("close", () => failed(new Error("native_connection_closed")));
          socket.once("secureConnect", () => {
            try {
              ensureCurrent();
              if (!socket?.authorized || checkServerIdentity(plan.host, socket.getPeerCertificate())) throw new Error("native_peer_invalid");
              verifyPinnedTlsPeer(plan, { connectedAddress: socket.remoteAddress ?? "", connectedPort: socket.remotePort ?? 0,
                serverName: plan.host, certificateHostnameVerified: true });
              secure();
            } catch { failed(new Error("native_peer_invalid")); }
          });
        });
        ensureCurrent();
        // A secret is requested only after peer verification, and remains in this private request scope.
        const bearer = await credential(enrollment.credentialRef); ensureCurrent();
        if (typeof bearer !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(bearer)) throw new Error("native_credential_unavailable");
        await input.authorize(); ensureCurrent();
        const headers: Record<string, string> = { Host: `${plan.host}:${plan.port}`, Authorization: `Bearer ${bearer}`,
          Accept: receiveChunk ? "text/event-stream" : "application/json", "Accept-Encoding": "identity", Connection: "close" };
        if (shape.body !== undefined) {
          headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(shape.body));
          headers["Idempotency-Key"] = input.idempotencyKey!; headers["X-Hermes-Session-Key"] = input.sessionKey!;
        } else if (shape.method === "POST") headers["Content-Length"] = "0";
        let socketHandedOff = false;
        request = ports.request({ protocol: "https:", hostname: plan.host, port: plan.port, path: shape.path, method: shape.method,
          headers, maxHeaderSize: 8192, insecureHTTPParser: false,
          // Do not set agent:false: Node then creates a new default Agent and ignores this socket factory.
          // With no agent and this factory, Node sends HTTP only through our already verified TLS socket.
          createConnection: () => { ensureCurrent(); if (socketHandedOff || !socket || socket.destroyed) throw new Error("native_connection_unavailable");
            socketHandedOff = true; return socket; },
        }, incoming => {
          if (done) { incoming.destroy(); return; }
          response = incoming;
          const status = incoming.statusCode ?? 0, contentType = incoming.headers["content-type"] ?? "";
          const encoding = incoming.headers["content-encoding"];
          if (status < 200 || status >= 300 && status !== 404 || (encoding !== undefined && encoding !== "identity")
            || typeof contentType !== "string" || (receiveChunk && (status !== 200 || !/^text\/event-stream(?:\s*;|$)/i.test(contentType)))) { fail(); return; }
          let bytes = 0; const chunks: Buffer[] = [];
          incoming.on("error", fail); incoming.on("aborted", fail);
          incoming.on("close", () => { if (!incoming.complete) fail(); });
          incoming.on("data", (chunk: Buffer) => {
            try {
              ensureCurrent(); bytes += chunk.byteLength;
              if (bytes > (receiveChunk ? nativeLimits.streamBytes : nativeLimits.jsonBytes)) throw new Error("native_response_limit");
              if (receiveChunk) receiveChunk(chunk); else chunks.push(Buffer.from(chunk));
            } catch { fail(); }
          });
          incoming.on("end", () => { if (!incoming.complete) { fail(); return; }
            finish({ status, contentType, body: receiveChunk ? new Uint8Array() : Buffer.concat(chunks, bytes) }); });
        });
        request.on("error", fail); request.once("upgrade", fail);
        ensureCurrent(); request.end(shape.body);
      })().catch(fail);
    });
  }
  return Object.freeze({ json: (input: NativeWireRequest) => exchange(input),
    events: async (input: NativeWireRequest, receive: (chunk: Uint8Array) => void) => { await exchange(input, receive); } });
}
