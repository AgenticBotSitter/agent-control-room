import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { TLSSocket } from "node:tls";
import test from "node:test";
import { nativeHttpJson, nativeHttpLimits, type NativeHttpRequest } from "../src/harness/v1/native-http-exchange";
import { createNativeHttpHost } from "../src/web/v1/native-http-host";
import type { NativeSessionTransport } from "../src/web/v1/managed-native-sessions";
import { createNativeHttpsService } from "../src/web/v1/native-https-service";
import type { Server, ServerOptions, createServer } from "node:https";

const origin = "https://native-control.example.test";
const certificate = Buffer.from("synthetic delivery client certificate");
const certificateDigest = `sha256:${createHash("sha256").update(certificate).digest("hex")}`;
const task = { projectId: "project:http", jobId: "job:http", attemptId: "attempt:http",
  inputDigest: `sha256:${"a".repeat(64)}` };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accepted => { resolve = accepted; });
  return { promise, resolve };
}

function socket() {
  return { encrypted: true, authorized: true, destroyed: false,
    getPeerCertificate: () => ({ raw: certificate }) } as unknown as TLSSocket;
}

type HandleState = { receives: string[]; closes: number };
function fixture(peerCurrent: unknown = true) {
  const handles: HandleState[] = [], transports: NativeSessionTransport[] = [];
  const host = createNativeHttpHost({ origin, peers: [{ nodeId: "node:http", certificateDigest, task }],
    isPeerCurrent: (() => peerCurrent) as (nodeId: string, digest: string) => boolean,
    connections: { async attachWire(nodeId, transport) {
      assert.equal(nodeId, "node:http"); transports.push(transport);
      const state: HandleState = { receives: [], closes: 0 }; handles.push(state);
      return Object.freeze({ nodeId, grantsExecutionAuthority: false as const,
        async receive(packet: string | Uint8Array) {
          state.receives.push(typeof packet === "string" ? packet : new TextDecoder().decode(packet));
          return { kind: "reconciliation" as const };
        },
        async stage() { throw new Error("stage is outside delivery-settlement evidence"); },
        async transmit() { throw new Error("transmit is outside delivery-settlement evidence"); },
        async close() { state.closes++; },
      });
    } }, isReady: () => true, clock: () => Date.parse("2026-09-06T18:00:00.000Z") });
  return { host, handles, transports };
}

class FakeServerResponse extends EventEmitter {
  statusCode = 0; destroyed = false; writableFinished = false;
  readonly headers = new Map<string, string>(); readonly chunks: Buffer[] = [];
  readonly ended = deferred(); private callback?: () => void;
  constructor(private readonly automatic: boolean) { super(); }
  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers.set(name.toLowerCase(), String(value)); return this as unknown as ServerResponse;
  }
  end(body?: string | Uint8Array, callback?: () => void) {
    if (body !== undefined) this.chunks.push(Buffer.from(body));
    this.callback = callback; this.ended.resolve(); if (this.automatic) this.complete();
    return this as unknown as ServerResponse;
  }
  complete() {
    if (this.writableFinished || this.destroyed) return;
    this.writableFinished = true; const callback = this.callback; this.callback = undefined; callback?.();
  }
  fail() { if (!this.destroyed) this.emit("error", new Error("synthetic response delivery failure")); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
  body() { return Buffer.concat(this.chunks).toString("utf8"); }
}

function exchange(command: NativeHttpRequest, automatic = true) {
  const body = nativeHttpJson(command), peer = socket();
  const input = new Readable({ read() { this.push(Buffer.from(body)); this.push(null); } }) as IncomingMessage;
  Object.assign(input, { url: nativeHttpLimits.path, method: "POST", httpVersion: "1.1", complete: true, socket: peer,
    rawTrailers: [], rawHeaders: ["Host", "native-control.example.test:443", "Content-Length", String(Buffer.byteLength(body)),
      "Content-Type", "application/json", "Accept", "application/json", "Accept-Encoding", "identity", "Connection", "close"] });
  const output = new FakeServerResponse(automatic);
  return { input, output, peer };
}

function openCommand(): NativeHttpRequest {
  return { schema: "control-room.native-http/v1", operation: "open", mode: "initial" };
}

function connection(output: FakeServerResponse) {
  const value = JSON.parse(output.body()) as { connection: string };
  assert.match(value.connection, /^connection:http:/); return value.connection;
}

test("native HTTPS service supplies strict TLS settings and forwards the actual socket to existing intake", async t => {
  const f = fixture();
  let made = 0, binds = 0, closes = 0;
  const server = new EventEmitter() as Server;
  server.listen = ((options: { host: string }, callback: () => void) => {
    assert.equal(options.host, "100.64.0.1"); binds++; queueMicrotask(callback); return server;
  }) as typeof server.listen;
  server.close = callback => { closes++; queueMicrotask(() => callback?.()); return server; };
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const material = new Uint8Array([1, 2, 3]);
  const service = createNativeHttpsService({ host: "100.64.0.1", port: 443, key: material, cert: material, ca: material,
    application: f.host, createServer: ((options: ServerOptions) => {
      made++; assert.equal(options.requestCert, true); assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.minVersion, "TLSv1.2"); assert.deepEqual(options.ALPNProtocols, ["http/1.1"]);
      assert.deepEqual(options.key, Buffer.from([1, 2, 3])); return server;
    }) as typeof createServer });
  t.after(() => service.close()); material.fill(9);
  assert.equal(made, 0); assert.equal(binds, 0); assert.equal(service.isReady(), false);
  await service.start(); assert.equal(service.isReady(), true);
  const incoming = exchange(openCommand()); server.emit("request", incoming.input, incoming.output);
  await incoming.output.ended.promise;
  assert.equal(incoming.output.statusCode, 200); connection(incoming.output);
  await service.close(); await service.close();
  assert.equal(closes, 1); assert.equal(f.handles[0].closes, 1); assert.equal(service.isReady(), false);
  await assert.rejects(service.start(), /already_attempted/);
});

test("native HTTPS service refuses public/default binds and retains startup cleanup failures", async () => {
  const material = new Uint8Array([1]);
  for (const host of ["0.0.0.0", "::", "example.test", "8.8.8.8", "100.128.0.1", "172.32.0.1"])
    assert.throws(() => createNativeHttpsService({ host, port: 443, key: material, cert: material, ca: material,
      application: { isReady: () => true, async close() {}, async handleNode() {} } }), /config_invalid/);
  for (const cleanupFails of [false, true]) for (const bindFails of [false, true]) {
    let closes = 0, made = 0, listenerCloses = 0;
    const server = new EventEmitter() as Server;
    server.listen = (() => { queueMicrotask(() => server.emit("error", new Error("synthetic bind failure"))); return server; }) as typeof server.listen;
    server.close = callback => { listenerCloses++; queueMicrotask(() => callback?.()); return server; };
    server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
    const service = createNativeHttpsService({ host: "127.0.0.1", port: 443, key: material, cert: material, ca: material,
      application: { isReady: () => true, async close() { closes++; if (cleanupFails) throw new Error("synthetic close error"); }, async handleNode() {} },
      createServer: (() => { made++; if (bindFails) return server; throw new Error("synthetic invalid TLS material"); }) as typeof createServer });
    await assert.rejects(service.start(), new RegExp(cleanupFails ? "cleanup_uncertain" : "start_failed"));
    assert.equal(closes, 1); assert.equal(made, 1); assert.equal(service.isReady(), false);
    assert.equal(listenerCloses, bindFails ? 1 : 0);
    await assert.rejects(service.start(), /already_attempted/);
  }
});

for (const mode of ["stalled-bind", "stalled-close"] as const) test(`native HTTPS bounds ${mode} and cannot restart`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let appCloses = 0, forced = 0;
  const server = new EventEmitter() as Server;
  server.listen = ((_options: unknown, callback: () => void) => {
    if (mode !== "stalled-bind") callback(); return server;
  }) as typeof server.listen;
  server.close = callback => { if (mode !== "stalled-close") callback?.(); return server; };
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => { forced++; };
  const material = new Uint8Array([1]);
  const service = createNativeHttpsService({ host: "127.0.0.1", port: 443, key: material, cert: material, ca: material,
    application: { isReady: () => true, async close() { appCloses++; }, async handleNode() {} },
    createServer: (() => server) as typeof createServer });
  if (mode === "stalled-bind") {
    const failed = assert.rejects(service.start(), /start_failed/); t.mock.timers.tick(5000); await failed;
  } else {
    await service.start(); const failed = assert.rejects(service.close(), /cleanup_uncertain/);
    await Promise.resolve(); t.mock.timers.tick(nativeHttpLimits.closeMs); await failed;
  }
  assert.equal(appCloses, 1); assert.equal(service.isReady(), false);
  assert.equal(forced, mode === "stalled-close" ? 1 : 0);
  await assert.rejects(service.start(), /already_attempted/);
});

test("failed output after a successful host exchange closes that exact generation and denies its token", async t => {
  const f = fixture(); t.after(() => f.host.close());
  const first = exchange(openCommand(), false), pending = f.host.handleNode(first.input, first.output as unknown as ServerResponse);
  await first.output.ended.promise;
  assert.equal(first.output.statusCode, 200); const token = connection(first.output);
  assert.equal(f.handles.length, 1); assert.equal(f.handles[0].closes, 0); assert.equal(f.host.isReady(), true);
  first.output.fail(); await pending;
  assert.equal(first.output.destroyed, true); assert.equal(first.output.writableFinished, false);
  assert.equal(f.handles[0].closes, 1); assert.equal(f.host.isReady(), true);

  const stale = exchange({ schema: "control-room.native-http/v1", operation: "exchange", connection: token, packet: null });
  await f.host.handleNode(stale.input, stale.output as unknown as ServerResponse);
  assert.equal(stale.output.statusCode, 503); assert.deepEqual(JSON.parse(stale.output.body()), { error: "native_http_unavailable" });
  assert.equal(f.handles[0].closes, 1); assert.deepEqual(f.handles[0].receives, []);
});

test("same-generation commands wait for successful response settlement without draining queued packets", async t => {
  const f = fixture(); t.after(() => f.host.close());
  const first = exchange(openCommand(), false), pending = f.host.handleNode(first.input, first.output as unknown as ServerResponse);
  await first.output.ended.promise; const token = connection(first.output);
  assert.equal(f.handles.length, 1); assert.equal(f.handles[0].closes, 0);
  await f.transports[0].send("packet:first"); await f.transports[0].send("packet:second");

  const overlapping = exchange({ schema: "control-room.native-http/v1", operation: "exchange",
    connection: token, packet: "packet:inbound" });
  await f.host.handleNode(overlapping.input, overlapping.output as unknown as ServerResponse);
  assert.equal(overlapping.output.statusCode, 503);
  assert.deepEqual(JSON.parse(overlapping.output.body()), { error: "native_http_unavailable" });
  assert.deepEqual(f.handles[0].receives, []); assert.equal(f.handles[0].closes, 0);

  const closing = exchange({ schema: "control-room.native-http/v1", operation: "close", connection: token });
  await f.host.handleNode(closing.input, closing.output as unknown as ServerResponse);
  assert.equal(closing.output.statusCode, 503); assert.equal(f.handles[0].closes, 0);
  assert.equal(f.transports[0].isAvailable(), true); assert.equal(f.host.isReady(), true);

  first.output.complete(); await pending;
  assert.equal(first.output.writableFinished, true); assert.equal(first.output.destroyed, false);
  assert.equal(f.handles[0].closes, 0); assert.equal(f.transports[0].isAvailable(), true);

  const next = exchange({ schema: "control-room.native-http/v1", operation: "exchange", connection: token, packet: null });
  await f.host.handleNode(next.input, next.output as unknown as ServerResponse);
  assert.equal(next.output.statusCode, 200);
  assert.deepEqual(JSON.parse(next.output.body()), { schema: "control-room.native-http/v1", connection: token,
    packets: ["packet:first", "packet:second"], more: false });
  assert.deepEqual(f.handles[0].receives, []); assert.equal(f.handles[0].closes, 0);
});

test("a replacement opened before late old-response failure stays current and ready", async t => {
  const f = fixture(); t.after(() => f.host.close());
  const first = exchange(openCommand(), false), oldPending = f.host.handleNode(first.input, first.output as unknown as ServerResponse);
  await first.output.ended.promise; const oldToken = connection(first.output);
  assert.equal(f.handles.length, 1); assert.equal(f.handles[0].closes, 0);

  const replacement = exchange(openCommand());
  await f.host.handleNode(replacement.input, replacement.output as unknown as ServerResponse);
  const currentToken = connection(replacement.output); assert.notEqual(currentToken, oldToken);
  assert.equal(f.handles.length, 2); assert.equal(f.handles[0].closes, 1); assert.equal(f.handles[1].closes, 0);
  assert.equal(f.host.isReady(), true);

  first.output.fail(); await oldPending;
  assert.equal(f.handles[0].closes, 1); assert.equal(f.handles[1].closes, 0);
  assert.equal(f.host.isReady(), true);

  const old = exchange({ schema: "control-room.native-http/v1", operation: "exchange", connection: oldToken, packet: null });
  await f.host.handleNode(old.input, old.output as unknown as ServerResponse);
  assert.equal(old.output.statusCode, 503); assert.equal(f.handles[1].closes, 0);

  const current = exchange({ schema: "control-room.native-http/v1", operation: "exchange", connection: currentToken, packet: null });
  await f.host.handleNode(current.input, current.output as unknown as ServerResponse);
  assert.equal(current.output.statusCode, 200); assert.equal(connection(current.output), currentToken);
  assert.equal(f.handles[1].closes, 0); assert.deepEqual(f.handles[1].receives, []);
});

test("peer-current callback must return literal boolean true", async t => {
  for (const [name, value] of [["truthy object", { current: true }], ["truthy string", "true"],
    ["promise false", Promise.resolve(false)]] as const) await t.test(name, async t => {
    const f = fixture(value); t.after(() => f.host.close());
    const denied = exchange(openCommand());
    await f.host.handleNode(denied.input, denied.output as unknown as ServerResponse);
    assert.equal(denied.output.statusCode, 503);
    assert.deepEqual(JSON.parse(denied.output.body()), { error: "native_http_unavailable" });
    assert.equal(f.handles.length, 0); assert.equal(f.transports.length, 0); assert.equal(f.host.isReady(), true);
  });
});
