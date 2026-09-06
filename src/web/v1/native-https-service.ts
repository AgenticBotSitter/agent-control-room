import { createServer, type Server } from "node:https";
import { isIP, type Socket } from "node:net";
import type { createNativeHttpHost } from "./native-http-host";
import { nativeHttpLimits } from "../../harness/v1/native-http-exchange";

/** Native Node TLS supplies certificate verification; the existing native callback
 * supplies exact peer pins and task authorization. No key loading or provisioning.
 * Construction is inert. Explicit start is a separately authorized physical effect.
 */
export type NativeHttpsConfiguration = { host: string; port: number; key: Uint8Array; cert: Uint8Array; ca: Uint8Array };
/** Trusted configuration capture only; returned bytes are private and never a log/report. */
export function captureNativeHttpsConfiguration(input: NativeHttpsConfiguration) {
  const { host, port } = input, octets = host.split(".").map(Number);
  const privateAddress = host === "127.0.0.1" || octets[0] === 10
    || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
    || octets[0] === 192 && octets[1] === 168
    || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  if (isIP(host) !== 4 || !privateAddress || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("native_https_service_config_invalid");
  const copy = (bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 65_536) throw new Error("native_https_service_config_invalid");
    return Buffer.from(bytes);
  };
  return { host, port, key: copy(input.key), cert: copy(input.cert), ca: copy(input.ca) };
}
export function createNativeHttpsService(input: NativeHttpsConfiguration & {
  application: Pick<ReturnType<typeof createNativeHttpHost>, "isReady" | "handleNode" | "close">;
  createServer?: typeof createServer;
  onUnavailable?: () => void;
}) {
  const { host, port, key, cert, ca } = captureNativeHttpsConfiguration(input);
  const onUnavailable = input.onUnavailable;
  const application = input.application, make = input.createServer ?? createServer;
  const handle = application.handleNode.bind(application), appReady = application.isReady.bind(application);
  const closeApp = application.close.bind(application);
  let attempted = false, ready = false, closing: Promise<void> | undefined, server: Server | undefined;
  const binding = new AbortController(), sockets = new Set<Socket>();
  function destroySockets() { for (const socket of sockets) socket.destroy(); }
  const isReady = () => ready && !closing && appReady();
  function close() {
    if (closing) return closing;
    ready = false; binding.abort();
    closing = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const network = server ? new Promise<void>((resolve, reject) => {
        server!.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          ? reject(new Error("native_https_service_cleanup_uncertain")) : resolve());
        server!.closeIdleConnections();
      }) : Promise.resolve();
      try {
        await Promise.race([Promise.allSettled([network, Promise.resolve().then(closeApp)]).then(results => {
          if (results.some(result => result.status === "rejected")) throw new Error("native_https_service_cleanup_uncertain");
        }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native_https_service_cleanup_uncertain")), nativeHttpLimits.closeMs); })]);
      } catch { server?.closeAllConnections(); throw new Error("native_https_service_cleanup_uncertain"); }
      finally { clearTimeout(timer); destroySockets(); key.fill(0); cert.fill(0); ca.fill(0); }
    });
    try { onUnavailable?.(); } catch { /* Readiness is already false; do not interrupt owned cleanup. */ }
    return closing;
  }
  return Object.freeze({ isReady, close, async start() {
    if (attempted || closing) throw new Error("native_https_service_already_attempted");
    attempted = true;
    try {
      if (!appReady()) throw new Error();
      server = make({ key, cert, ca, requestCert: true, rejectUnauthorized: true,
        minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"], handshakeTimeout: 5000,
        maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: nativeHttpLimits.requestMs,
        keepAliveTimeout: 1000, insecureHTTPParser: false });
      const owned = server;
      owned.maxConnections = 16; owned.maxHeadersCount = 32; owned.maxRequestsPerSocket = 1;
      owned.on("connection", (socket: Socket) => {
        if (closing || sockets.size >= 16) { socket.destroy(); return; }
        sockets.add(socket); socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy()); socket.setTimeout(nativeHttpLimits.requestMs, () => socket.destroy());
      });
      owned.on("request", (request, response) => {
        if (!isReady()) { request.destroy(); response.destroy(); return; }
        void handle(request, response).catch(() => { request.destroy(); response.destroy(); });
      });
      for (const event of ["upgrade", "connect"] as const) owned.on(event, (_request, socket) => socket.destroy());
      owned.on("clientError", (_error, socket) => socket.destroy());
      owned.on("tlsClientError", (_error, socket) => socket.destroy());
      for (const event of ["checkContinue", "checkExpectation"])
        owned.on(event, (request, response) => { request.destroy(); response.destroy(); });
      owned.on("error", () => { void close().catch(() => {}); });
      owned.on("close", () => { void close().catch(() => {}); });
      let bindTimer: ReturnType<typeof setTimeout> | undefined, failed = () => {};
      try {
        await new Promise<void>((resolve, reject) => {
          bindTimer = setTimeout(() => { binding.abort(); reject(new Error()); }, 5000);
          failed = () => reject(new Error()); owned.once("error", failed);
          owned.listen({ host, port, exclusive: true, backlog: 16, signal: binding.signal }, () => {
            if (closing || binding.signal.aborted || !appReady()) reject(new Error()); else resolve();
          });
        });
      } finally { clearTimeout(bindTimer); owned.off("error", failed); }
      if (closing || !appReady()) throw new Error(); ready = true;
    } catch {
      await close(); throw new Error("native_https_service_start_failed");
    }
  } });
}
