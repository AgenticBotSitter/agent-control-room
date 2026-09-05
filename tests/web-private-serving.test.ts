import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server, ServerOptions } from "node:http";
import type { ListenOptions } from "node:net";
import test from "node:test";
import { createPrivateNodeService } from "../src/web/v1/private-serving.ts";

function fixture(mode: "normal" | "bind_stalls" | "bind_error" | "close_stalls" = "normal") {
  let created = 0, dbCloses = 0, closes = 0, forceCloses = 0;
  let observedOptions: Readonly<ServerOptions> | undefined, listenOptions: ListenOptions | undefined;
  let completeBind: (() => void) | undefined;
  const server = new EventEmitter() as Server;
  server.listen = ((options: ListenOptions, callback: () => void) => {
    listenOptions = options; completeBind = callback;
    if (mode === "bind_error") queueMicrotask(() => server.emit("error", new Error("private diagnostic")));
    else if (mode !== "bind_stalls") queueMicrotask(callback);
    return server;
  }) as typeof server.listen;
  server.close = (callback?: (error?: Error) => void) => { closes++; if (mode !== "close_stalls") queueMicrotask(() => callback?.()); return server; };
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => { forceCloses++; };
  const service = createPrivateNodeService({ origin: "https://private.example.invalid", port: 3210,
    application: { isReady: () => true, close: async () => { dbCloses++; } },
    handler: () => Response.json({ ok: true }), assets: { count: 1, digest: "synthetic", respond: () => undefined },
    createServer: options => { created++; observedOptions = options; return server; },
    listenerTiming: { bindMs: 20, closeMs: 25 },
  });
  return { service, server, completeBind: () => completeBind?.(), counts: () => ({ created, dbCloses, closes, forceCloses }),
    observed: () => ({ options: observedOptions, listen: listenOptions }) };
}
test("private service is inert, starts only the fixed loopback profile and closes once", async () => {
  const f = fixture(); assert.equal(f.counts().created, 0); assert.equal(f.service.isReady(), false);
  await f.service.start(); assert.equal(f.service.isReady(), true);
  assert.equal(f.observed().listen?.host, "127.0.0.1"); assert.equal(f.observed().listen?.port, 3210);
  assert.equal(f.observed().listen?.exclusive, true); assert.equal(f.server.maxConnections, 64);
  assert.equal(f.server.maxRequestsPerSocket, 1); assert.equal(f.observed().options?.insecureHTTPParser, false);
  const close = f.service.close(); assert.equal(f.service.isReady(), false); assert.equal(f.service.close(), close);
  await close; assert.deepEqual(f.counts(), { created: 1, closes: 1, dbCloses: 1, forceCloses: 0 });
  await assert.rejects(f.service.start(), /already_attempted/);
});
test("failed and late binds close owned application and cannot retry or become ready", async () => {
  for (const mode of ["bind_stalls", "bind_error"] as const) {
    const f = fixture(mode); await assert.rejects(f.service.start(), { message: "private_listener_start_failed" });
    assert.equal(f.observed().listen?.signal?.aborted, true);
    f.completeBind(); assert.equal(f.service.isReady(), false); assert.equal(f.counts().dbCloses, 1);
    await assert.rejects(f.service.start(), /already_attempted/);
  }
});
test("uncertain listener close forces owned sockets down and retains fixed uncertainty", async () => {
  const f = fixture("close_stalls"); await f.service.start();
  await assert.rejects(f.service.close(), { message: "private_listener_close_uncertain" });
  assert.equal(f.counts().forceCloses, 1); assert.equal(f.counts().dbCloses, 1);
});
test("unexpected server error drops readiness and runs cleanup", async () => {
  const f = fixture(); await f.service.start(); f.server.emit("error", new Error("private diagnostic"));
  assert.equal(f.service.isReady(), false); await f.service.close(); assert.equal(f.counts().dbCloses, 1);
});
test("unready application and invalid listener configuration cannot start a server", async () => {
  let created = 0, closed = 0;
  const options = { origin: "https://private.example.invalid", port: 3210,
    application: { isReady: () => false, close: async () => { closed++; } },
    handler: () => new Response(), assets: { count: 1, digest: "synthetic", respond: () => undefined },
    createServer: () => { created++; throw new Error(); },
  };
  for (const port of [0, 65536, NaN]) assert.throws(() => createPrivateNodeService({ ...options, port }));
  const service = createPrivateNodeService(options); await assert.rejects(service.start(), /start_failed/);
  assert.equal(created, 0); assert.equal(closed, 1);
});
