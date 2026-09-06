import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import type { TLSSocket } from "node:tls";
import test from "node:test";
import { nativeHttpJson, nativeHttpLimits, type NativeHttpRequest } from "../src/harness/v1/native-http-exchange";
import { createNativeHttpHost } from "../src/web/v1/native-http-host";
import { createNativeHttpNodeHandler } from "../src/web/v1/native-http-node-handler";
import type { NativeSessionTransport } from "../src/web/v1/managed-native-sessions";

const origin = "https://native-control.example.test";
const certificate = Buffer.from("synthetic authorized client certificate");
const certificateDigest = `sha256:${createHash("sha256").update(certificate).digest("hex")}`;
const inputDigest = `sha256:${"a".repeat(64)}`;
const task = { projectId: "project:http", jobId: "job:http", attemptId: "attempt:http", inputDigest };

function socket(options: { authorized?: boolean; destroyed?: boolean; certificate?: Uint8Array } = {}) {
  return { encrypted: true, authorized: options.authorized ?? true, destroyed: options.destroyed ?? false,
    getPeerCertificate: () => ({ raw: options.certificate ?? certificate }) } as unknown as TLSSocket;
}

function hostFixture() {
  const attached: { nodeId: string; transport: NativeSessionTransport; mode: string; task: unknown }[] = [];
  const handles: { receives: unknown[]; closes: number; stages: number; transmits: number }[] = [];
  let ready = true, current = true;
  const host = createNativeHttpHost({ origin, peers: [{ nodeId: "node:http", certificateDigest, task }],
    isPeerCurrent(nodeId, digest) { return current && nodeId === "node:http" && digest === certificateDigest; },
    connections: { async attachWire(nodeId, transport, configuration) {
      const state = { receives: [] as unknown[], closes: 0, stages: 0, transmits: 0 }; handles.push(state);
      attached.push({ nodeId, transport, mode: configuration.mode, task: configuration.task });
      return Object.freeze({ nodeId, grantsExecutionAuthority: false as const,
        async receive(packet: string | Uint8Array) { state.receives.push(packet); return { kind: "reconciliation" as const }; },
        async stage() { state.stages++; throw new Error("stage is outside HTTP denial evidence"); },
        async transmit() { state.transmits++; throw new Error("transmit is outside HTTP denial evidence"); },
        async close() { state.closes++; },
      });
    } }, isReady: () => ready, clock: () => Date.parse("2026-09-06T18:00:00.000Z") });
  return { host, attached, handles, setReady: (value: boolean) => { ready = value; },
    setCurrent: (value: boolean) => { current = value; } };
}

function request(command: NativeHttpRequest, options: { body?: string; length?: string; headers?: Record<string, string> } = {}) {
  const body = options.body ?? nativeHttpJson(command);
  return new Request(`${origin}${nativeHttpLimits.path}`, { method: "POST", body,
    headers: { "content-type": "application/json", "content-length": options.length ?? String(Buffer.byteLength(body)),
      ...options.headers }, duplex: "half" } as RequestInit & { duplex: "half" });
}

async function open(f: ReturnType<typeof hostFixture>) {
  const response = await f.host.handle(request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" }), socket());
  assert.equal(response.status, 200); const body = await response.json() as { connection: string; packets: string[]; more: boolean };
  assert.match(body.connection, /^connection:http:/); assert.deepEqual(body.packets, []); assert.equal(body.more, false);
  return body.connection;
}

test("host selects only the configured current TLS certificate and captures the exact trusted task", async t => {
  const f = hostFixture(); t.after(() => f.host.close());
  for (const [name, peer] of [
    ["unauthorized", socket({ authorized: false })],
    ["destroyed", socket({ destroyed: true })],
    ["unknown certificate", socket({ certificate: Buffer.from("other certificate") })],
    ["missing certificate", socket({ certificate: new Uint8Array() })],
  ] as const) await t.test(name, async () => {
    const response = await f.host.handle(request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" }), peer);
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "native_http_unavailable" });
    assert.equal(f.attached.length, 0);
  });
  f.setCurrent(false);
  assert.equal((await f.host.handle(request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" }), socket())).status, 503);
  assert.equal(f.attached.length, 0);
  f.setCurrent(true); await open(f);
  assert.equal(f.attached.length, 1); assert.equal(f.attached[0].nodeId, "node:http");
  assert.equal(f.attached[0].mode, "initial"); assert.deepEqual(f.attached[0].task, task);
});

test("host rejects request metadata, body mismatch and malformed commands before attaching a wire", async t => {
  const commands: [string, Request][] = [
    ["wrong method", new Request(`${origin}${nativeHttpLimits.path}`, { method: "PUT" })],
    ["wrong path", new Request(`${origin}/other`, { method: "POST", body: "{}" })],
    ["query", new Request(`${origin}${nativeHttpLimits.path}?node=node:other`, { method: "POST", body: "{}" })],
    ["missing type", new Request(`${origin}${nativeHttpLimits.path}`, { method: "POST", body: "{}", headers: { "content-length": "2" } })],
    ["compressed", request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" },
      { headers: { "content-encoding": "gzip" } })],
    ["forwarded identity", request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" },
      { headers: { "cf-access-jwt-assertion": "not-authority" } })],
    ["length mismatch", request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" }, { length: "1" })],
    ["oversized declared length", request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" },
      { length: String(nativeHttpLimits.bodyBytes + 1) })],
    ["invalid JSON", request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" }, { body: "{" })],
    ["unknown command field", request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" },
      { body: JSON.stringify({ schema: "control-room.native-http/v1", operation: "open", mode: "initial", nodeId: "node:other" }) })],
  ];
  for (const [name, input] of commands) await t.test(name, async t => {
    const f = hostFixture(); t.after(() => f.host.close());
    const response = await f.host.handle(input, socket()); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "native_http_unavailable" }); assert.equal(f.attached.length, 0);
  });
});

test("a stale generation cannot exchange with or close its replacement", async t => {
  const f = hostFixture(); t.after(() => f.host.close());
  const first = await open(f), second = await open(f); assert.notEqual(first, second);
  assert.equal(f.handles.length, 2); assert.equal(f.handles[0].closes, 1); assert.equal(f.handles[1].closes, 0);
  const staleClose = await f.host.handle(request({ schema: "control-room.native-http/v1", operation: "close", connection: first }), socket());
  assert.equal(staleClose.status, 503); assert.equal(f.handles[1].closes, 0);
  const staleExchange = await f.host.handle(request({ schema: "control-room.native-http/v1", operation: "exchange",
    connection: first, packet: null }), socket());
  assert.equal(staleExchange.status, 503); assert.equal(f.handles[1].receives.length, 0);
  const current = await f.host.handle(request({ schema: "control-room.native-http/v1", operation: "exchange",
    connection: second, packet: null }), socket()); assert.equal(current.status, 200);
  const closed = await f.host.handle(request({ schema: "control-room.native-http/v1", operation: "close", connection: second }), socket());
  assert.equal(closed.status, 200); assert.equal(f.handles[1].closes, 1);
});

function nodeExchange(options: { rawHeaders?: string[]; body?: string; path?: string; method?: string; holdOutput?: boolean } = {}) {
  const body = options.body ?? "{}";
  const input = new Readable({ read() { this.push(Buffer.from(body)); this.push(null); } }) as IncomingMessage;
  const fakeSocket = socket();
  Object.assign(input, { url: options.path ?? nativeHttpLimits.path, method: options.method ?? "POST", httpVersion: "1.1",
    rawHeaders: options.rawHeaders ?? ["Host", "native-control.example.test:443", "Content-Length", String(Buffer.byteLength(body)),
      "Content-Type", "application/json", "Accept", "application/json", "Accept-Encoding", "identity", "Connection", "close"],
    rawTrailers: [], complete: true, socket: fakeSocket });
  const chunks: Buffer[] = [], headers = new Map<string, string>();
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
    chunks.push(Buffer.from(chunk)); if (!options.holdOutput) callback();
  } }) as ServerResponse;
  output.setHeader = (name, value) => { headers.set(name.toLowerCase(), String(value)); return output; };
  return { input, output, socket: fakeSocket, headers, body: () => Buffer.concat(chunks).toString("utf8") };
}

test("Node callback forwards one exact bounded request and writes fixed response headers", async t => {
  let requests = 0, seenBody = "", seenSocket: TLSSocket | undefined;
  const callback = createNativeHttpNodeHandler(origin, { isReady: () => true, async close() {},
    async handle(input, peer) { requests++; seenBody = await input.text(); seenSocket = peer;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 }); } });
  t.after(() => callback.close());
  const x = nodeExchange({ body: "bounded request body" }); await callback.handle(x.input, x.output);
  assert.equal(requests, 1); assert.equal(seenBody, "bounded request body"); assert.equal(seenSocket, x.socket);
  assert.equal(x.output.statusCode, 200); assert.equal(x.body(), JSON.stringify({ accepted: true }));
  assert.deepEqual(Object.fromEntries(x.headers), { "cache-control": "no-store", connection: "close",
    "content-length": String(Buffer.byteLength(JSON.stringify({ accepted: true }))), "content-type": "application/json",
    "x-content-type-options": "nosniff" });
});

test("Node callback rejects duplicate and unsupported headers, socket reuse and oversized responses", async t => {
  let requests = 0;
  const app = { isReady: () => true, async close() {}, async handle() { requests++;
    return new Response("x".repeat(nativeHttpLimits.bodyBytes + 1)); } };
  const callback = createNativeHttpNodeHandler(origin, app); t.after(() => callback.close());
  const duplicate = nodeExchange({ rawHeaders: ["Host", "native-control.example.test:443", "Content-Length", "2",
    "Content-Length", "2", "Content-Type", "application/json", "Accept-Encoding", "identity", "Connection", "close"] });
  await callback.handle(duplicate.input, duplicate.output); assert.equal(requests, 0);
  assert.equal(duplicate.input.destroyed, true); assert.equal(duplicate.output.destroyed, true);

  const unsupported = nodeExchange({ rawHeaders: ["Host", "native-control.example.test:443", "Content-Length", "2",
    "Content-Type", "application/json", "Accept-Encoding", "identity", "Connection", "keep-alive"] });
  await callback.handle(unsupported.input, unsupported.output); assert.equal(requests, 0);

  const oversized = nodeExchange(); await callback.handle(oversized.input, oversized.output);
  assert.equal(requests, 1); assert.equal(oversized.output.destroyed, true); assert.equal(oversized.body(), "");
  await callback.handle(oversized.input, nodeExchange().output);
  assert.equal(requests, 1, "the callback refuses reuse of the same accepted TLS socket");
});
