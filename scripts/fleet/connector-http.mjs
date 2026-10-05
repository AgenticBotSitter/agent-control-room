import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const BODY_HIGH_WATER_MARK = 64 * 1024;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** The connector's default gateway transport: the subset of fetch() the
 * connector uses, carried by node:http instead of Node's bundled undici.
 *
 * Node 22's global fetch kills its whole process with an internal assertion
 * (`assert(!this.paused)` in undici's Parser.finish) when a reply marked
 * `connection: close` ends while its body is backpressured: the parser resumes,
 * the last body bytes and the FIN then arrive in one read, pushing those bytes
 * pauses the parser again, and the socket's `end` handler finishes a paused
 * parser. The gateway closes every connection after one reply, so any reply
 * over 64 KiB (the update download, a long claims list) could crash the
 * connector under CPU load; an MCP shim died silently in the middle of its
 * self-update. node:http applies backpressure by pausing the socket, so a
 * close-delimited reply is always read to its end.
 *
 * Failures keep fetch's shapes, because callers classify them: a network
 * failure is a TypeError whose `cause` carries the socket code, an abort
 * rejects with the signal's reason, and a body that stops early errors its
 * stream with a TypeError. Redirects are never followed. Every request uses
 * its own connection, as the gateway's one-reply-per-connection rule expects.
 * @param {string | URL} input
 * @param {RequestInit} [init] string or byte bodies only
 * @returns {Promise<Response>} */
export function connectorFetchV1(input, { method = "GET", headers = {}, body, signal, redirect = "follow" } = {}) {
  return new Promise((resolveFetch, rejectFetch) => {
    if (signal?.aborted) { rejectFetch(signal.reason); return; }
    let url, outgoing, payload;
    try {
      url = new URL(String(input));
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported protocol ${url.protocol}`);
      if (url.username || url.password) throw new Error("credentials in the URL");
      outgoing = new Headers(headers);
      payload = body === undefined || body === null ? undefined
        : typeof body === "string" ? Buffer.from(body, "utf8")
          : ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.from(body);
    } catch (error) { rejectFetch(new TypeError("fetch failed", { cause: error })); return; }
    if (typeof body === "string" && !outgoing.has("content-type")) outgoing.set("content-type", "text/plain;charset=UTF-8");
    if (payload) outgoing.set("content-length", String(payload.length));
    else if (["POST", "PUT"].includes(method.toUpperCase())) outgoing.set("content-length", "0");
    if (!outgoing.has("accept")) outgoing.set("accept", "*/*");

    let settled = false, incoming, streamController, streamDone = false;
    const detach = () => signal?.removeEventListener("abort", aborted);
    const fail = error => { if (settled) return; settled = true; detach(); rejectFetch(error); };
    const terminate = error => {
      if (streamDone) return;
      streamDone = true; detach();
      try { streamController?.error(error); } catch { /* the reader already cancelled */ }
    };
    function aborted() {
      const reason = signal.reason;
      request.destroy(); incoming?.destroy();
      fail(reason); terminate(reason);
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, { method, headers: Object.fromEntries(outgoing), agent: false });
    signal?.addEventListener("abort", aborted, { once: true });
    request.on("error", error => {
      fail(new TypeError("fetch failed", { cause: error }));
      terminate(new TypeError("terminated", { cause: error }));
    });
    request.once("response", response => {
      incoming = response;
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location !== undefined && redirect !== "manual") {
        response.destroy();
        fail(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));
        return;
      }
      let stream = null;
      if (method.toUpperCase() === "HEAD" || NULL_BODY_STATUSES.has(status)) { streamDone = true; response.resume(); }
      else stream = new ReadableStream({
        start(controller) {
          streamController = controller;
          response.on("data", chunk => {
            if (streamDone) return;
            controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            if ((controller.desiredSize ?? 0) <= 0) response.pause();
          });
          response.once("end", () => {
            if (streamDone) return;
            streamDone = true; detach(); controller.close();
          });
          response.on("error", error => terminate(new TypeError("terminated", { cause: error })));
          response.once("close", () => {
            if (!response.complete) terminate(new TypeError("terminated", {
              cause: Object.assign(new Error("other side closed"), { code: "ECONNRESET" }) }));
          });
        },
        pull() { response.resume(); },
        cancel() { streamDone = true; detach(); response.destroy(); },
      }, { highWaterMark: BODY_HIGH_WATER_MARK, size: chunk => chunk.byteLength });
      let reply;
      try {
        const replyHeaders = new Headers();
        for (let index = 0; index + 1 < response.rawHeaders.length; index += 2)
          replyHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        reply = new Response(stream, { status, statusText: response.statusMessage ?? "", headers: replyHeaders });
      } catch (error) {
        response.destroy();
        fail(new TypeError("fetch failed", { cause: error })); terminate(new TypeError("terminated", { cause: error }));
        return;
      }
      settled = true; if (streamDone) detach();
      resolveFetch(reply);
    });
    request.end(payload);
  });
}
