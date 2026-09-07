import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import test from "node:test";
import { createAbsPublicReader, type AbsPublicReaderPorts } from "../src/project-adapters/abs-news/v1/public-reader";

const url = "https://news.example.test/feed";
function fixture(mode = "normal", timeoutMs = 1000) {
  let resolves = 0, requests = 0, permitted = true, options: RequestOptions | undefined;
  let release!: (answers: string[]) => void;
  class Resource extends EventEmitter { destroyed = false; destroy() { if (!this.destroyed) { this.destroyed = true; if (mode !== "close_stall") queueMicrotask(() => this.emit("close")); } return this; } }
  class Reply extends Resource {
    complete = false; rawTrailers: string[] = []; statusCode = mode === "redirect" ? 302 : 200;
    headers = { "content-type": mode === "type" ? "application/json" : "application/rss+xml; charset=utf-8",
      ...(mode === "redirect" ? { location: "https://other.example.test/" } : {}),
      ...(mode === "cookie" ? { "set-cookie": ["cookie=refused"] } : {}),
      ...(mode === "compressed" ? { "content-encoding": "gzip" } : {}) };
    socket = { authorized: mode !== "tls", remoteAddress: mode === "peer" ? "8.8.4.4" : "8.8.8.8", remotePort: 443,
      getPeerCertificate: () => ({ subjectaltname: mode === "hostname" ? "DNS:other.example.test" : "DNS:news.example.test" }) };
  }
  const reply = new Reply(); let receive!: (response: IncomingMessage) => void;
  class Request extends Resource { end() {
    if (mode === "hang") return this;
    queueMicrotask(() => {
      receive(reply as unknown as IncomingMessage); if (reply.destroyed) return;
      reply.emit("data", mode === "oversize" ? Buffer.alloc(1001) : mode === "utf8" ? Buffer.from([255]) : Buffer.from("<rss/>"));
      reply.complete = mode !== "incomplete"; reply.emit("end");
    }); return this;
  } }
  const request = new Request();
  const ports: AbsPublicReaderPorts = { resolver: { async resolve(host) {
    resolves++; assert.equal(host, "news.example.test");
    if (mode === "dns_wait") return new Promise<string[]>(done => { release = done; });
    return mode === "private" ? ["10.0.0.1"] : ["8.8.8.8"];
  } }, request(value, handler) { requests++; options = value; receive = handler; return request as unknown as ClientRequest; } };
  const reader = createAbsPublicReader({ urls: [url], maxBytes: 1000, timeoutMs, contentTypes: ["application/rss+xml"] },
    { assertCurrent() { if (!permitted) throw new Error("not authorized"); } }, ports);
  return { reader, reply, request, counts: () => ({ resolves, requests }), options: () => options,
    revoke: () => { permitted = false; }, release: () => release(["8.8.8.8"]) };
}
test("reader is inert and makes one public pinned GET without credentials, cookies or pooled connections", async () => {
  const f = fixture(); assert.deepEqual(f.counts(), { resolves: 0, requests: 0 });
  const result = await f.reader.read(url, new AbortController().signal);
  assert.equal(result.text, "<rss/>"); assert.equal(result.endpointUrl, url); assert.equal(result.byteCount, 6);
  const options = f.options()!;
  assert.equal(options.hostname, "8.8.8.8"); assert.equal(options.servername, "news.example.test");
  assert.equal(options.agent, false); assert.equal(options.path, "/feed"); assert.equal(options.method, "GET");
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.ca, undefined); assert.equal(options.cert, undefined); assert.equal(options.key, undefined);
  assert.deepEqual(options.headers, { Host: "news.example.test", Accept: "application/rss+xml", "Accept-Encoding": "identity", Connection: "close" });
  assert.equal(f.reply.destroyed, true); assert.equal(f.request.destroyed, true); await f.reader.close();
});
test("private addresses, TLS mismatch, redirects, cookies, encoding, sizes and incomplete responses are refused without retry", async t => {
  for (const mode of ["private", "tls", "peer", "hostname", "redirect", "cookie", "compressed", "type", "oversize", "utf8", "incomplete"]) await t.test(mode, async () => {
    const f = fixture(mode); await assert.rejects(f.reader.read(url, new AbortController().signal), /abs_public_read_failed/);
    assert.equal(f.counts().requests, mode === "private" ? 0 : 1);
    await assert.rejects(f.reader.read(url, new AbortController().signal)); assert.equal(f.counts().resolves, 1);
    await f.reader.close();
  });
});
test("URL and authority refusal prevent DNS; timeout and late DNS cannot issue a request", async () => {
  const f = fixture(); await assert.rejects(f.reader.read(url + "/other", new AbortController().signal));
  f.revoke(); await assert.rejects(f.reader.read(url, new AbortController().signal));
  assert.deepEqual(f.counts(), { resolves: 0, requests: 0 }); await f.reader.close();
  const wait = fixture("dns_wait", 20), pending = wait.reader.read(url, new AbortController().signal);
  await assert.rejects(pending); wait.release(); await wait.reader.close(); assert.equal(wait.counts().requests, 0);
  const hang = fixture("hang", 20); await assert.rejects(hang.reader.read(url, new AbortController().signal));
  assert.equal(hang.request.destroyed, true); await hang.reader.close();
});
test("revocation during DNS and explicit cancellation fence subsequent requests", async () => {
  const f = fixture("dns_wait"); const pending = f.reader.read(url, new AbortController().signal);
  await new Promise(done => setImmediate(done)); f.revoke(); f.release(); await assert.rejects(pending);
  assert.equal(f.counts().requests, 0); await f.reader.close();
  const other = fixture("hang"), abort = new AbortController(); const reading = other.reader.read(url, abort.signal);
  await new Promise(done => setImmediate(done)); abort.abort(); await assert.rejects(reading);
  assert.equal(other.request.destroyed, true); await other.reader.close();
});

test("missing resource-close evidence is reported as uncertainty, never successful cleanup", async () => {
  const f = fixture("close_stall", 20);
  await assert.rejects(f.reader.read(url, new AbortController().signal), /abs_public_read_failed/);
  await assert.rejects(f.reader.close(), /abs_public_reader_close_uncertain/);
  assert.equal(f.request.destroyed, true); assert.equal(f.reply.destroyed, true);
});
