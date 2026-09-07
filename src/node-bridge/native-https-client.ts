import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { checkServerIdentity, connect, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { ClientRequest, IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { z } from "zod";
import { verifyPinnedTlsPeer, parseCanonicalHttpsDestination,
  type NetworkResolverV1 } from "../node-policy/v1/network-target-guard";
import { nativeHttpLimits, nativeHttpJson, nativeHttpRequestSchema, nativeHttpResponseSchema,
  type NativeHttpRequest, type NativeHttpResponse } from "../harness/v1/native-http-exchange";
import type { NativeHttpClient } from "./native-http-host";
import { captureNativePrivateAddress, prepareNativeHttpsDestination } from "./native-https-destination";

export interface NativeNodeHttpsPorts {
  resolver: NetworkResolverV1;
  connect(options: ConnectionOptions): TLSSocket;
  request(options: RequestOptions, receive: (response: IncomingMessage) => void): ClientRequest;
}
const nativePorts: NativeNodeHttpsPorts = { resolver: { resolve: async host =>
  (await lookup(host, { all: true, verbatim: true })).map(record => record.address) }, connect, request: httpsRequest };
const schema = z.object({ canonicalDestination: z.string(), connectorCredentialRef: z.string().min(3).max(160),
  pinnedPrivateAddress: z.string().max(45).optional(),
  serverCertificateDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), serverCa: z.string().min(16).max(65_536) }).strict();
export type NativeNodeHttpsConfiguration = z.input<typeof schema>;
const credentialSchema = z.object({ certificate: z.string().min(16).max(65_536), privateKey: z.string().min(16).max(65_536) }).strict();
const unavailable = () => new Error("native_node_https_unavailable");

/** Inert native mTLS client. Its connector credential is needed during handshake,
 * unlike a bearer token. It is never a Hermes, owner-approval or frame-signing key. */
export function createNativeNodeHttpsClient(input: NativeNodeHttpsConfiguration, source: {
  credential(reference: string): Promise<z.input<typeof credentialSchema>>;
  assertCurrent(): void; clock?: () => number;
}, ports: NativeNodeHttpsPorts = nativePorts): NativeHttpClient {
  const config = schema.parse(input); parseCanonicalHttpsDestination(config.canonicalDestination);
  captureNativePrivateAddress(config.canonicalDestination, config.pinnedPrivateAddress);
  const credential = source.credential.bind(source), available = source.assertCurrent.bind(source);
  const now = (source.clock ?? Date.now).bind(source);
  const resolve = ports.resolver.resolve.bind(ports.resolver), tls = ports.connect.bind(ports), requestHttp = ports.request.bind(ports);
  const lifetime = new AbortController(), pending = new Set<Promise<unknown>>();
  let closed = false, busy = false, highWater = -1, closing: Promise<void> | undefined;
  function current(signal?: AbortSignal) {
    const at = now();
    if (closed || lifetime.signal.aborted || signal?.aborted || !Number.isSafeInteger(at) || at < 0 || at < highWater) throw unavailable();
    highWater = at; available(); if (closed || lifetime.signal.aborted || signal?.aborted) throw unavailable(); return at;
  }
  function track<T>(work: Promise<T>): Promise<T> { pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work)); return work; }
  async function exchange(value: NativeHttpRequest, signal: AbortSignal): Promise<NativeHttpResponse> {
    current(signal); if (!(signal instanceof AbortSignal) || busy) throw unavailable();
    const body = nativeHttpJson(nativeHttpRequestSchema.parse(value));
    busy = true; const controller = new AbortController(), deadline = current(signal) + nativeHttpLimits.requestMs;
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    lifetime.signal.addEventListener("abort", abort, { once: true });
    let socket: TLSSocket | undefined, request: ClientRequest | undefined, response: IncomingMessage | undefined;
    const resourceClose: Promise<void>[] = [];
    const own = <T extends EventEmitter>(resource: T): T => {
      const close = new Promise<void>(resolve => resource.once("close", resolve));
      resourceClose.push(track(close)); return resource;
    };
    const cleanup = () => { response?.destroy(); request?.destroy(); socket?.destroy(); };
    const ensure = () => { current(controller.signal); if (now() >= deadline) throw unavailable(); };
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const stop = () => { cleanup(); rejectStopped(unavailable()); };
    controller.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(abort, nativeHttpLimits.requestMs);
    const work = track(Promise.resolve().then(async () => {
      ensure();
      const plan = await prepareNativeHttpsDestination(config.canonicalDestination, config.pinnedPrivateAddress,
        { resolve }, new Date(now()).toISOString());
      ensure(); const secret = credentialSchema.parse(await credential(config.connectorCredentialRef)); ensure();
      await new Promise<void>((accepted, rejected) => {
        socket = own(tls({ host: plan.pinnedAddresses[0], port: plan.port,
          servername: plan.hostKind === "dns" ? plan.host : undefined, minVersion: "TLSv1.2", rejectUnauthorized: true,
          ca: config.serverCa, cert: secret.certificate, key: secret.privateKey, ALPNProtocols: ["http/1.1"],
          checkServerIdentity: (_host, cert) => checkServerIdentity(plan.host, cert) }));
        socket.on("error", () => controller.abort());
        socket.once("error", rejected); socket.once("close", () => rejected(unavailable()));
        socket.once("secureConnect", () => {
          try {
            ensure(); const certificate = socket!.getPeerCertificate();
            if (!socket!.authorized || checkServerIdentity(plan.host, certificate) || !certificate.raw
              || `sha256:${createHash("sha256").update(certificate.raw).digest("hex")}` !== config.serverCertificateDigest) throw unavailable();
            verifyPinnedTlsPeer(plan, { connectedAddress: socket!.remoteAddress ?? "", connectedPort: socket!.remotePort ?? 0,
              serverName: plan.host, certificateHostnameVerified: true }); accepted();
          } catch { rejected(unavailable()); }
        });
      });
      ensure(); let handed = false;
      const text = await new Promise<string>((accepted, rejected) => {
        request = own(requestHttp({ protocol: "https:", hostname: plan.host, port: plan.port, path: nativeHttpLimits.path,
          method: "POST", maxHeaderSize: 8192, insecureHTTPParser: false,
          headers: { Host: `${plan.host}:${plan.port}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)),
            Accept: "application/json", "Accept-Encoding": "identity", Connection: "close" },
          createConnection: () => { ensure(); if (handed || !socket || socket.destroyed) throw unavailable(); handed = true; return socket; },
        }, incoming => {
          response = own(incoming);
          try {
            ensure();
            if (incoming.statusCode !== 200 || incoming.headers["content-type"] !== "application/json"
              || incoming.headers["content-encoding"] !== undefined || incoming.headers["set-cookie"] !== undefined
              || incoming.headers.location !== undefined) throw unavailable();
          } catch { rejected(unavailable()); cleanup(); return; }
          const chunks: Uint8Array[] = []; let bytes = 0;
          incoming.on("error", rejected); incoming.on("aborted", () => rejected(unavailable()));
          incoming.on("close", () => { if (!incoming.complete) rejected(unavailable()); });
          incoming.on("data", (chunk: Buffer) => {
            try { ensure(); bytes += chunk.byteLength;
              if (bytes > nativeHttpLimits.bodyBytes) throw unavailable(); chunks.push(Uint8Array.from(chunk));
            } catch { rejected(unavailable()); cleanup(); }
          });
          incoming.once("end", () => {
            try { ensure();
              if (!incoming.complete || incoming.rawTrailers.length) throw unavailable();
              accepted(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
            } catch { rejected(unavailable()); }
          });
        }));
        request.on("error", rejected); request.once("upgrade", () => rejected(unavailable()));
        ensure(); request.end(body);
      });
      ensure(); const result = nativeHttpResponseSchema.parse(JSON.parse(text));
      cleanup(); await Promise.all(resourceClose); ensure(); return result;
    }));
    try { return await Promise.race([work, stopped]); }
    catch { closed = true; lifetime.abort(); cleanup(); throw unavailable(); }
    finally { clearTimeout(timer); controller.abort(); busy = false;
      signal.removeEventListener("abort", abort); lifetime.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", stop); }
  }
  return Object.freeze({ exchange,
    close() {
      if (closing) return closing; closed = true; lifetime.abort();
      closing = (async () => { let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([Promise.allSettled([...pending]), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("native_node_https_close_uncertain")), nativeHttpLimits.closeMs);
        })]); } finally { clearTimeout(timer); }
      })(); return closing;
    },
  });
}
