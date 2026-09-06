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
