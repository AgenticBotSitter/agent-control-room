import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { EventEmitter } from "node:events";
import { checkServerIdentity, type TLSSocket, type ConnectionOptions } from "node:tls";
import { z } from "zod";
import { captureAbsCurrentSourceAuthority, type AbsCurrentSourceAuthority } from "./current-source-authority";
import { absNewsCanonicalUrlSchemaV1 } from "./schemas";
import { preparePinnedHttpsConnection, verifyPinnedTlsPeer, type NetworkResolverV1 } from "../../../node-policy/v1/network-target-guard";

export interface AbsPublicReaderPorts {
  resolver: NetworkResolverV1;
  request(options: RequestOptions, receive: (response: IncomingMessage) => void): ClientRequest;
}
const nativePorts: AbsPublicReaderPorts = { resolver: { resolve: async host =>
  (await lookup(host, { all: true, verbatim: true })).map(item => item.address) }, request: httpsRequest };
const configSchema = z.object({ urls: z.array(absNewsCanonicalUrlSchemaV1).min(1).max(20),
  maxBytes: z.number().int().min(1).max(1_048_576), timeoutMs: z.number().int().min(1).max(30_000),
  contentTypes: z.array(z.enum(["application/rss+xml", "application/atom+xml", "application/xml", "text/xml", "text/html"])).min(1).max(5),
}).strict();
const refused = () => new Error("abs_public_read_failed");

/** Inert until read. Trusted composition must supply current per-read authority.
 * Reuses the repository public DNS/pinned peer guard and Node's TLS/HTTP implementation.
 * No private-address exception, cookies, credentials, redirects, decompression or retries. */
export function createAbsPublicReader(value: unknown, source: AbsCurrentSourceAuthority, ports: AbsPublicReaderPorts = nativePorts) {
  const config = configSchema.parse(value), allowed = new Set(config.urls);
  const assertCurrent = captureAbsCurrentSourceAuthority(source), resolve = ports.resolver.resolve.bind(ports.resolver), requestHttp = ports.request.bind(ports);
  const lifetime = new AbortController(), pending = new Set<Promise<unknown>>();
  let busy = false, closed = false, closing: Promise<void> | undefined;
  const track = <T>(promise: Promise<T>): Promise<T> => { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; };
  async function read(urlValue: string, signal: AbortSignal) {
    if (closed || busy || !(signal instanceof AbortSignal) || signal.aborted || !allowed.has(urlValue)) throw refused();
    const url = new URL(urlValue), destination = `https://${url.hostname}:443`;
    try { assertCurrent(urlValue); } catch { throw refused(); } busy = true;
    const stop = new AbortController(), abort = () => stop.abort();
    signal.addEventListener("abort", abort, { once: true }); lifetime.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, config.timeoutMs);
    let request: ClientRequest | undefined, response: IncomingMessage | undefined;
    const closures: Promise<void>[] = [];
    const own = <T extends EventEmitter>(resource: T): T => {
      closures.push(track(new Promise<void>(done => resource.once("close", done)))); return resource;
    };
    const cleanup = () => { response?.destroy(); request?.destroy(); };
    const current = () => { if (closed || stop.signal.aborted || signal.aborted) throw refused(); assertCurrent(urlValue);
      if (closed || stop.signal.aborted || signal.aborted) throw refused(); };
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const onStop = () => { cleanup(); rejectStopped(refused()); };
    stop.signal.addEventListener("abort", onStop, { once: true });
    const work = track(Promise.resolve().then(async () => {
      current();
      const plan = await preparePinnedHttpsConnection({ canonicalDestination: destination, allowedDestinations: [destination],
        resolver: { resolve }, resolvedAt: new Date().toISOString(), executor: { exposesFinalDestination: true, supportsPinnedTlsConnection: true } });
      current();
      const result = await new Promise<{ text: string; byteCount: number; contentType: string }>((accept, reject) => {
        // Dial the checked IP directly, while retaining exact DNS identity for TLS and Host.
        const options: RequestOptions & ConnectionOptions = { protocol: "https:", hostname: plan.pinnedAddresses[0], port: 443,
          servername: plan.host, rejectUnauthorized: true, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"],
          checkServerIdentity: (_host, cert) => checkServerIdentity(plan.host, cert), agent: false,
          path: url.pathname, method: "GET", maxHeaderSize: 8192, insecureHTTPParser: false,
          headers: { Host: plan.host, Accept: config.contentTypes.join(", "), "Accept-Encoding": "identity", Connection: "close" },
        };
        request = own(requestHttp(options, incoming => {
          response = own(incoming);
          const fail = () => { reject(refused()); cleanup(); };
          incoming.on("error", fail); incoming.on("aborted", fail);
          incoming.on("close", () => { if (!incoming.complete) fail(); });
          let contentType: string;
          try {
            current(); const peer = incoming.socket as TLSSocket;
            if (!peer.authorized || checkServerIdentity(plan.host, peer.getPeerCertificate())) throw refused();
            verifyPinnedTlsPeer(plan, { connectedAddress: peer.remoteAddress ?? "", connectedPort: peer.remotePort ?? 0,
              serverName: plan.host, certificateHostnameVerified: true });
            contentType = (incoming.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
            if (incoming.statusCode !== 200 || !config.contentTypes.some(type => type === contentType)
              || incoming.headers["content-encoding"] !== undefined || incoming.headers["set-cookie"] !== undefined
              || incoming.headers.location !== undefined) throw refused();
            const length = incoming.headers["content-length"];
            if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > config.maxBytes)) throw refused();
          } catch { fail(); return; }
          const chunks: Buffer[] = []; let byteCount = 0;
          incoming.on("data", (chunk: Buffer) => {
            try { current(); byteCount += chunk.byteLength; if (byteCount > config.maxBytes) throw refused(); chunks.push(Buffer.from(chunk)); }
            catch { fail(); }
          });
          incoming.once("end", () => {
            try { current(); if (!incoming.complete || incoming.rawTrailers.length) throw refused();
              accept({ text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, byteCount)), byteCount, contentType });
            } catch { fail(); }
          });
        }));
        request.on("error", () => reject(refused())); request.once("close", () => reject(refused()));
        request.on("upgrade", (_incoming, socket) => { own(socket).destroy(); reject(refused()); cleanup(); });
        current(); request.end();
      });
      cleanup(); await Promise.all(closures); current();
      return { ...result, endpointUrl: urlValue, observedAt: new Date().toISOString() };
    }));
    try { return await Promise.race([work, stopped]); }
    catch { closed = true; lifetime.abort(); cleanup(); throw refused(); }
    finally { clearTimeout(timer); busy = false; signal.removeEventListener("abort", abort); lifetime.signal.removeEventListener("abort", abort); stop.signal.removeEventListener("abort", onStop); }
  }
  return Object.freeze({ read, close() {
    if (closing) return closing; closed = true; lifetime.abort();
    closing = (async () => { let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled([...pending]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("abs_public_reader_close_uncertain")), 5000); })]); }
      finally { clearTimeout(timer); }
    })(); return closing;
  } });
}
