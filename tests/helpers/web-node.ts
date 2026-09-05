import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

/** In-memory Node streams only. No socket or listener is constructed. */
export function nodeExchange(options: {
  path?: string; method?: string; headers?: string[]; body?: string; holdInput?: boolean;
  holdOutput?: boolean; peer?: string;
} = {}) {
  const input = new Readable({ read() {
    if (options.holdInput) return;
    if (options.body) this.push(Buffer.from(options.body));
    this.push(null);
  } }) as IncomingMessage;
  Object.assign(input, { url: options.path ?? "/projects", method: options.method ?? "GET", httpVersion: "1.1",
    rawHeaders: ["Host", "private.example.invalid", ...(options.headers ?? [])], rawTrailers: [],
    complete: true, socket: { remoteAddress: options.peer ?? "127.0.0.1" } });
  const chunks: Buffer[] = [], headers = new Map<string, string>();
  let sent = false;
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
    sent = true;
    chunks.push(Buffer.from(chunk));
    if (!options.holdOutput) callback();
  } }) as ServerResponse;
  Object.defineProperty(output, "headersSent", { get: () => sent });
  output.setHeader = (name, value) => { headers.set(name.toLowerCase(), String(value)); return output; };
  return { input, output, headers, body: () => Buffer.concat(chunks).toString("utf8") };
}
