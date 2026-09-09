import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import type { Server, ServerOptions } from "node:http";
import type { ListenOptions } from "node:net";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createContributorDemoService, createPrivateNodeService } from "../src/web/v1/private-serving.ts";
import { privateResponseHeaders } from "../src/web/v1/http-common.ts";

function fixture(mode: "normal" | "bind_stalls" | "bind_error" | "close_stalls" | "close_error" = "normal",
  applicationClose?: () => Promise<void>, demo = false) {
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
  server.close = (callback?: (error?: Error) => void) => { closes++; if (mode !== "close_stalls")
    queueMicrotask(() => callback?.(mode === "close_error" ? new Error("synthetic close failure") : undefined)); return server; };
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => { forceCloses++; };
  const listener = {
    createServer: (options: Readonly<ServerOptions>) => { created++; observedOptions = options; return server; },
    listenerTiming: { bindMs: 20, closeMs: 25 },
  };
  const service = demo ? createContributorDemoService({ origin: "http://127.0.0.1:3000",
    isReady: () => true, handle: async () => {},
    close: async () => { dbCloses++; await applicationClose?.(); },
  }, listener) : createPrivateNodeService({ origin: "https://private.example.invalid", port: 3210,
    application: { isReady: () => true, close: async () => { dbCloses++; await applicationClose?.(); } },
    handler: () => Response.json({ ok: true }), assets: { count: 1, digest: "synthetic", respond: () => undefined },
    ...listener,
  });
  return { service, server, completeBind: () => completeBind?.(), counts: () => ({ created, dbCloses, closes, forceCloses }),
    observed: () => ({ options: observedOptions, listen: listenOptions }) };
}
test("demo lifecycle reuses bounded loopback start, failure and cleanup without real sockets", async () => {
  for (const mode of ["normal", "bind_stalls", "bind_error", "close_stalls"] as const) {
    const f = fixture(mode, undefined, true);
    assert.equal(f.counts().created, 0);
    if (mode === "bind_stalls" || mode === "bind_error") {
      await assert.rejects(f.service.start(), /start_failed/);
      f.completeBind(); assert.equal(f.service.isReady(), false);
    } else {
      await f.service.start(); assert.equal(f.service.isReady(), true);
      if (mode === "close_stalls") await assert.rejects(f.service.close(), /close_uncertain/);
      else await f.service.close();
    }
    assert.equal(f.observed().listen?.host, "127.0.0.1");
    assert.equal(f.observed().listen?.port, 3000);
    assert.equal(f.counts().dbCloses, 1);
    await assert.rejects(f.service.start(), /already_attempted/);
  }
  const unstarted = fixture("normal", undefined, true);
  await unstarted.service.close(); assert.equal(unstarted.counts().created, 0);
  assert.equal(unstarted.counts().dbCloses, 1);
});
test("demo service rejects other origins and invalid timing without taking ownership", () => {
  let closes = 0;
  const bridge = { origin: "https://private.example.invalid", isReady: () => true,
    handle: async () => {}, close: async () => { closes++; } };
  assert.throws(() => createContributorDemoService(bridge), /config_invalid/);
  assert.throws(() => createContributorDemoService({ ...bridge, origin: "http://127.0.0.1:3000" },
    { listenerTiming: { bindMs: 0 } }), /config_invalid/);
  assert.equal(closes, 0);
});
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
test("successful factory construction owns close-before-start without creating a server", async () => {
  const f = fixture(); await f.service.close();
  assert.deepEqual(f.counts(), { created: 0, closes: 0, dbCloses: 1, forceCloses: 0 });
  await assert.rejects(f.service.start(), /already_attempted/);
});
test("owned expectation refusals apply the full private response policy", async () => {
  const f = fixture(); await f.service.start();
  for (const event of ["checkContinue", "checkExpectation"]) {
    let status = 0, headers: Record<string, string> = {}, ended = false;
    f.server.emit(event, {}, { writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
      end() { ended = true; } });
    assert.equal(status, 417); assert.equal(ended, true);
    assert.deepEqual(headers, { ...privateResponseHeaders, connection: "close" });
  }
  await f.service.close();
});
test("early network close failure still waits for bounded application cleanup", async t => {
  // Keep the deadline fixed while observing ordering; scheduler load must not expire it first.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: () => void, settled = false;
  const f = fixture("close_error", () => new Promise(resolve => { finish = resolve; }));
  await f.service.start();
  const closing = f.service.close().then(() => { settled = true; }, error => { settled = true; throw error; });
  const rejected = assert.rejects(closing, /private_listener_close_uncertain/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(f.counts().dbCloses, 1);
  finish(); await rejected; assert.equal(settled, true);
});
test("reviewed HTTP listener and outbound request imports stay separate; legacy net authority stays separate", async () => {
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name))
      : Promise.resolve(/\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : [])))).flat();
  }
  const owners: string[] = [], consumers: string[] = [];
  for (const path of await files("src")) {
    const source = await readFile(path, "utf8");
    if (/from\s+["'][^"']*private-serving["']/.test(source)) consumers.push(path.replaceAll("\\", "/"));
    if (!source.includes("node:http")) continue;
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    let ownsHttp = false;
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && node.moduleSpecifier.text === "node:http" && !node.importClause?.isTypeOnly) {
        ownsHttp = true;
        if (path.replaceAll("\\", "/") === "src/vendor/control-center/pinned-fetch.ts") {
          const clause = node.importClause;
          assert.equal(clause?.name, undefined, "outbound client cannot import the default HTTP namespace");
          assert.ok(clause?.namedBindings && ts.isNamedImports(clause.namedBindings));
          assert.deepEqual(clause.namedBindings.elements.map(entry => (entry.propertyName ?? entry.name).text), ["request"]);
        }
      }
      if (ts.isCallExpression(node) && node.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === "node:http")) {
        assert.notEqual(path.replaceAll("\\", "/"), "src/vendor/control-center/pinned-fetch.ts", "outbound client cannot dynamically acquire HTTP authority");
        ownsHttp = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(tree); if (ownsHttp) owners.push(path.replaceAll("\\", "/"));
  }
  assert.deepEqual(owners.sort(), ["src/vendor/control-center/pinned-fetch.ts", "src/web/v1/private-serving.ts"]);
  // E60/E63 explicitly compose serving in the supplied-resource host. No other
  // consumer or additional native HTTP owner is admitted by this inventory.
  // The adopted news client is separately restricted above to the request API.
  assert.deepEqual(consumers, ["src/web/v1/private-task-host.ts"]);
  const host = await readFile("src/web/v1/private-task-host.ts", "utf8");
  assert.doesNotMatch(host, /from ["']node:(?:http|net)["']|process\.env|process\.on\(|private-loopback-physical-native-driver/);
  const service = await readFile("src/web/v1/private-serving.ts", "utf8");
  assert.doesNotMatch(service, /from ["']node:net["']|process\.env|process\.on\(|private-loopback-physical-native-driver/);
  assert.match(service, /host: "127\.0\.0\.1"/);
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
