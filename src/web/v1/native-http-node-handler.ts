import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { Readable } from "node:stream";
import { nativeHttpLimits, readNativeHttpBody } from "../../harness/v1/native-http-exchange";

/** Separate private HTTPS callback. No listener is opened; actual TLS peer evidence
 * comes from the request socket, never an HTTP forwarding header. */
export function createNativeHttpNodeHandler(origin: string, application: {
  handle(request: Request, socket: TLSSocket, nativeDelivery?: boolean): Promise<Response>; close(): Promise<void>; isReady(): boolean;
  settleResponse?(response: Response, delivered: boolean): Promise<void>;
}) {
  const handle = application.handle.bind(application), closeApplication = application.close.bind(application);
  const ready = application.isReady.bind(application), active = new Set<Promise<void>>();
  const settle = application.settleResponse?.bind(application);
  const controllers = new Set<AbortController>(), sockets = new WeakSet<object>();
  let closed = false, closing: Promise<void> | undefined;
  async function serve(input: IncomingMessage, output: ServerResponse) {
    if (closed || !ready() || active.size >= nativeHttpLimits.activeRequests || sockets.has(input.socket)) {
      input.destroy(); output.destroy(); return;
    }
    sockets.add(input.socket);
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => { controller.abort(); input.destroy(); output.destroy(); };
    const disconnected = () => { if (!output.writableFinished) abort(); };
    input.once("error", abort); output.once("error", abort); output.once("close", disconnected);
    const timer = setTimeout(abort, nativeHttpLimits.requestMs);
    let response: Response | undefined, delivered = false;
    try {
      if (input.httpVersion !== "1.1" || input.method !== "POST" || input.url !== nativeHttpLimits.path
        || input.rawHeaders.length > 64 || input.rawHeaders.length % 2) throw new Error();
      const headers = new Headers(), seen = new Set<string>(); let size = 0;
      for (let i = 0; i < input.rawHeaders.length; i += 2) {
        const name = input.rawHeaders[i].toLowerCase(), value = input.rawHeaders[i + 1];
        size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
        if (size > 8192 || seen.has(name) || !["host", "content-length", "content-type", "accept", "accept-encoding", "connection"].includes(name)
          || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error();
        seen.add(name); headers.set(name, value);
      }
      const destination = new URL(origin);
      const expectedHost = `${destination.hostname}:${destination.port || "443"}`;
      if (headers.get("host") !== expectedHost || headers.get("connection") !== "close"
        || headers.get("accept-encoding") !== "identity") throw new Error();
      const request = new Request(`${origin}${nativeHttpLimits.path}`, { method: "POST", headers,
        body: Readable.toWeb(input) as ReadableStream<Uint8Array>, signal: controller.signal,
        duplex: "half" } as RequestInit & { duplex: "half" });
      response = await handle(request, input.socket as TLSSocket, true);
      if (controller.signal.aborted || output.destroyed) { void response.body?.cancel().catch(() => {}); return; }
      const body = await readNativeHttpBody(response.body, controller.signal);
      if (controller.signal.aborted || output.destroyed) return;
      output.statusCode = response.status;
      output.setHeader("content-type", "application/json"); output.setHeader("cache-control", "no-store");
      output.setHeader("x-content-type-options", "nosniff"); output.setHeader("connection", "close");
      output.setHeader("content-length", String(Buffer.byteLength(body)));
      await new Promise<void>((resolve, reject) => {
        const stopped = () => reject(new Error("native_http_response_uncertain"));
        controller.signal.addEventListener("abort", stopped, { once: true });
        output.end(body, () => { controller.signal.removeEventListener("abort", stopped); resolve(); });
        if (controller.signal.aborted) stopped();
      });
      delivered = !controller.signal.aborted && output.writableFinished;
    } catch { abort(); }
    finally { if (response && settle) { try { await settle(response, delivered); } catch { abort(); } }
      clearTimeout(timer); controllers.delete(controller);
      input.off("error", abort); output.off("error", abort); output.off("close", disconnected);
      if (!input.complete) input.destroy(); }
  }
  return Object.freeze({
    handle(input: IncomingMessage, output: ServerResponse) {
      const work = serve(input, output); active.add(work); void work.finally(() => active.delete(work)).catch(() => {}); return work;
    },
    close() {
      if (closing) return closing; closed = true;
      for (const controller of controllers) controller.abort();
      closing = (async () => { let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([Promise.all([closeApplication(), ...active]), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("native_http_callback_close_uncertain")), nativeHttpLimits.closeMs);
        })]); } finally { clearTimeout(timer); }
      })(); return closing;
    },
  });
}
