import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateWebBootstrap, type PrivateStartupConfiguration } from "../src/web/v1/private-startup";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { boundPrivateDatabase } from "../src/web/v1/bounded-database";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup";
import { now, request } from "./helpers/web-foundation";

test("invalid startup configuration has zero pool, install or key-loader calls", async () => {
  let calls = 0;
  for (const patch of [{ origin: "http://invalid.example.invalid" }, { audience: "" }, { ownerIdentityId: "" },
    { database: { ...startupConfig.database, password: "" } }, { maxSessionSeconds: 604801 },
    { connections: { registryIntegrityKey: new Uint8Array(1) } }, { planning: {} }]) {
    const bootstrap = createPrivateWebBootstrap({ openDatabase: () => { calls++; throw new Error(); },
      install: () => { calls++; throw new Error(); } });
    await assert.rejects(bootstrap.start({ ...startupConfig, ...patch } as PrivateStartupConfiguration), /config_invalid/);
  }
  assert.equal(calls, 0);
});

test("startup verifies schema and role before one shared installation; close removes readiness immediately", async () => {
  const f = await limitedWebFixture(); let opens = 0, installs = 0, keyLoads = 0;
  let app!: ReturnType<typeof createPrivateWebProcess>;
  const bootstrap = createPrivateWebBootstrap({ clock: () => now,
    openDatabase: () => { opens++; return f.pool; }, install: options => { installs++; app = createPrivateWebProcess(options); return app; } });
  const runtime = await bootstrap.start({ ...startupConfig, loadKeys: async signal => { keyLoads++; return startupConfig.loadKeys(signal); } });
  try {
    assert.equal(opens, 1); assert.equal(installs, 1); assert.equal(keyLoads, 0); assert.equal(runtime.isReady(), true);
    await assert.rejects(bootstrap.start(startupConfig), /already_attempted/);
    assert.equal((await app.handle(request(), () => new Response("shell"))).status, 200);
    const closing = runtime.close(); assert.equal(runtime.isReady(), false); assert.equal(runtime.close(), closing);
    assert.equal((await app.handle(request(), () => new Response())).status, 503);
    await closing; assert.equal(f.closes(), 1);
  } finally { await runtime.close(); }
});

test("missing prerequisites close the acquired pool once without install, automatic repair or retry", async () => {
  const f = await limitedWebFixture(); let installs = 0;
  const bootstrap = createPrivateWebBootstrap({ clock: () => now, openDatabase: () => f.pool,
    install: () => { installs++; throw new Error(); } });
  await assert.rejects(bootstrap.start({ ...startupConfig, ownerIdentityId: "identity:absent" }), /prerequisites_failed/);
  assert.equal(f.closes(), 1); assert.equal(installs, 0);
  await assert.rejects(bootstrap.start(startupConfig), /already_attempted/); assert.equal(f.closes(), 1);
});

test("installer failure is sanitized and closes the pool", async () => {
  const f = await limitedWebFixture();
  const bootstrap = createPrivateWebBootstrap({ clock: () => now, openDatabase: () => f.pool,
    install: () => { throw new Error("synthetic private details"); } });
  await assert.rejects(bootstrap.start(startupConfig), { message: "private_startup_prerequisites_failed" });
  assert.equal(f.closes(), 1);
});

test("bounded drain stops admission and reports uncertainty if an admitted renderer never completes", async () => {
  let entered!: () => void, release!: (r: Response) => void, closes = 0;
  const rendering = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const pool = boundPrivateDatabase({ acquire: async () => { throw new Error("not needed on session shell"); }, terminate: async () => { closes++; } });
  const app = createPrivateWebProcess({ ...startupConfig, clock: () => now, database: pool, drainMs: 10 });
  const response = app.handle(request("/session"), () => { entered(); return pending; });
  await rendering;
  const closing = app.close(); assert.equal(app.close(), closing);
  assert.equal((await app.handle(request(), () => new Response())).status, 503);
  await assert.rejects(closing, /drain_uncertain/); assert.equal((await response).status, 503);
  assert.equal(closes, 1); release(new Response("late shell"));
  await assert.rejects(app.close(), /drain_uncertain/);
});
