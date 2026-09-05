import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerOptions, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createPrivateNodeHandler, privateHttpLimits } from "./private-node-handler";
export { loadPrivateClientAssets } from "./private-assets";
export { createPrivateNodeHandler } from "./private-node-handler";

export const privateServerOptions: Readonly<ServerOptions> = Object.freeze({
  maxHeaderSize: privateHttpLimits.headersBytes, headersTimeout: 5000, requestTimeout: 5000,
  connectionsCheckingInterval: 1000, keepAliveTimeout: 1000, highWaterMark: 16384,
  insecureHTTPParser: false, requireHostHeader: true,
});
type ServerFactory = (options: Readonly<ServerOptions>) => Server;

/** Inert until explicit start(). Tests inject a server with no sockets.
 * Start is a physical effect and requires the separate approved deployment/rehearsal packet.
 * The caller transfers ownership of the already-preflighted application on start, including failure.
 * No signal handler, service installation, environment loader or retry is installed.
 */
export function createPrivateNodeService(options: Parameters<typeof createPrivateNodeHandler>[0] & {
  port: number;
  createServer?: ServerFactory;
  listenerTiming?: { bindMs?: number; closeMs?: number };
}) {
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("private_listener_config_invalid");
  const bindMs = options.listenerTiming?.bindMs ?? 5000, closeMs = options.listenerTiming?.closeMs ?? 35_000;
  if (!Number.isSafeInteger(bindMs) || bindMs < 1 || bindMs > 5000
    || !Number.isSafeInteger(closeMs) || closeMs < 1 || closeMs > 35_000) throw new Error("private_listener_config_invalid");
  const bridge = createPrivateNodeHandler(options);
  const binding = new AbortController();
  let attempted = false, ready = false, closed: Promise<void> | undefined, server: Server | undefined;
  const sockets = new Set<Socket>();
  function stopSockets() { for (const socket of sockets) socket.destroy(); }
  function close(): Promise<void> {
    if (closed) return closed;
    ready = false;
    // Prevent a delayed bind from opening a listener after cleanup.
    binding.abort();
    closed = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const network = server ? new Promise<void>((resolve, reject) => {
        server!.close(error => { if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
          reject(new Error("private_listener_close_uncertain")); else resolve(); });
        server!.closeIdleConnections();
      }) : Promise.resolve();
      try {
        await Promise.race([Promise.all([network, bridge.close()]), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("private_listener_close_uncertain")), closeMs);
        })]);
      } catch {
        server?.closeAllConnections(); stopSockets();
        throw new Error("private_listener_close_uncertain");
      } finally { clearTimeout(timer); stopSockets(); }
    })();
    return closed;
  }
  return Object.freeze({
    isReady: () => ready && !closed && bridge.isReady(), close,
    async start(): Promise<void> {
      if (attempted || closed) throw new Error("private_listener_already_attempted");
      attempted = true;
      try {
        if (!bridge.isReady()) throw new Error();
        const instance = (options.createServer ?? createServer)(privateServerOptions); server = instance;
        instance.maxConnections = 64; instance.maxHeadersCount = privateHttpLimits.headerCount;
        instance.maxRequestsPerSocket = 1;
        instance.on("connection", (socket: Socket) => {
          if (closed || sockets.size >= 64 || socket.remoteAddress !== "127.0.0.1") { socket.destroy(); return; }
          sockets.add(socket); socket.once("close", () => sockets.delete(socket));
          socket.on("error", () => socket.destroy());
          socket.setTimeout(30_000, () => socket.destroy());
        });
        instance.on("request", (request: IncomingMessage, response: ServerResponse) => {
          void bridge.handle(request, response).catch(() => response.destroy());
        });
        instance.on("upgrade", (_request, socket) => socket.destroy());
        instance.on("connect", (_request, socket) => socket.destroy());
        instance.on("clientError", (_error, socket) => socket.destroy());
        for (const event of ["checkContinue", "checkExpectation"])
          instance.on(event, (_request: IncomingMessage, response: ServerResponse) => {
            response.writeHead(417, { "connection": "close", "cache-control": "no-store" }); response.end();
          });
        instance.on("error", () => { ready = false; void close().catch(() => {}); });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { binding.abort(); reject(new Error()); }, bindMs);
          const failed = () => { clearTimeout(timer); reject(new Error()); };
          instance.once("error", failed);
          instance.listen({ host: "127.0.0.1", port: options.port, exclusive: true, backlog: 64, signal: binding.signal }, () => {
            clearTimeout(timer); instance.off("error", failed);
            if (closed || binding.signal.aborted || !bridge.isReady()) { reject(new Error()); return; }
            resolve();
          });
        });
        if (closed || !bridge.isReady()) throw new Error();
        ready = true;
      } catch {
        try { await close(); } catch { throw new Error("private_listener_cleanup_uncertain"); }
        throw new Error("private_listener_start_failed");
      }
    },
  });
}
