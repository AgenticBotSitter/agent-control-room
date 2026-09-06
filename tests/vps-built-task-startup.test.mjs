import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap, startPrivateTaskApplication } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication, installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { taskDraft } from "./helpers/web-task.ts";
import { instant } from "./hermes-native-fixture.ts";
import { request } from "./helpers/web-foundation.ts";
import { sha256Digest } from "../src/security/index.ts";
import { createPrivateNodeHandler } from "../dist-vps/server/serving.js";
import { nodeExchange } from "./helpers/web-node.ts";
import { EventEmitter } from "node:events";
import { createPrivateTaskHost, createInstalledPrivateTaskHost } from "../dist-vps/server/taskHost.js";

test("compiled two-pool bootstrap mounts protected planning, assignment and page rendering under shared logout", async t => {
  assert.equal(typeof startPrivateTaskApplication, "function");
  assert.equal((await handler(request())).status, 503);
  const f = await taskStartupFixture(); t.after(f.close);
  assert.equal(typeof createPrivateTaskBootstrap, "function");
  assert.equal(typeof createInstalledPrivateTaskHost().start, "function");
  let binds = 0, listenerCloses = 0;
  const server = new EventEmitter();
  server.listen = (options, callback) => { binds++; assert.equal(options.host, "127.0.0.1"); queueMicrotask(callback); return server; };
  server.close = callback => { listenerCloses++; queueMicrotask(() => callback?.()); return server; };
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const host = createPrivateTaskHost({ openDatabase: f.openDatabase, install: installPrivateApplication,
    clock: () => instant + 8000, createServer: () => server });
  assert.equal(binds, 0);
  const app = await host.start({ configuration: f.config, port: 3210, handler,
    assets: { count: 0, digest: "synthetic-no-assets", respond: () => undefined } });
  t.after(() => app.close()); assert.equal(app.isReady(), true); assert.equal(binds, 1);
  const project = `/api/v1/projects/${f.profile.projectId}`;
  const req = (path, method = "GET", body) => request(path, method, body, "built-task-startup-001", f.jwt);
  const bridge = createPrivateNodeHandler({ origin: f.config.web.origin, application: app, handler,
    assets: { count: 0, digest: "synthetic-no-assets", respond: () => undefined } });
  t.after(() => bridge.close());
  const longDraft = { ...taskDraft, instructions: "中".repeat(3000) };
  const longRequest = request(`${project}/tasks`, "POST", longDraft, "built-large-task-001", f.jwt);
  const body = await longRequest.text(); assert.ok(Buffer.byteLength(body) > 8192);
  const exchange = nodeExchange({ path: new URL(longRequest.url).pathname, method: "POST", body,
    headers: [...longRequest.headers].flat() });
  await bridge.handle(exchange.input, exchange.output);
  assert.equal(exchange.output.statusCode, 201, exchange.body());
  const created = await handler(req(`${project}/tasks`, "POST", taskDraft));
  assert.equal(created.status, 201, await created.clone().text());
  const proposal = await created.json();
  const planned = await handler(req(`${project}/tasks/${proposal.receipt.jobId}/plan`, "POST", { expectedInputDigest: sha256Digest(taskDraft) }));
  assert.equal(planned.status, 201, await planned.clone().text());
  const plan = (await planned.json()).receipt;
  const path = `${project}/tasks/${plan.jobId}/assignment`;
  assert.equal((await handler(req(path))).status, 200);
  const saved = await handler(req(path, "POST", { action: "assign", nodeId: f.route.nodeId, expectedInputDigest: plan.inputDigest }));
  assert.equal(saved.status, 201, await saved.clone().text()); assert.equal((await saved.json()).receipt.startsWork, false);
  const page = await handler(req(`/projects/${f.profile.projectId}/tasks/${plan.jobId}`));
  assert.equal(page.status, 200); assert.match(await page.text(), /<html/);
  assert.throws(() => installPrivateWebProcess({}), /already_configured/);
  assert.equal((await handler(req("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handler(req(path))).status, 401);
  const closing = app.close(); assert.equal(app.isReady(), false); await closing;
  assert.equal((await handler(req(path))).status, 503); assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
  assert.equal(listenerCloses, 1);
  await assert.rejects(host.start({}), /already_attempted/);
});

test("compiled host denies invalid setup before pools and cleans up after failed bind", async t => {
  for (const mode of ["invalid-port", "bind-error", "cleanup-error"]) await t.test(mode, async t => {
    const f = await taskStartupFixture(); t.after(f.close);
    let opens = 0, binds = 0, listenerCloses = 0;
    const server = new EventEmitter();
    server.listen = () => { binds++; queueMicrotask(() => server.emit("error", new Error("synthetic bind error"))); return server; };
    server.close = callback => { listenerCloses++; queueMicrotask(() => callback?.()); return server; };
    server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
    const host = createPrivateTaskHost({ openDatabase(config) {
      opens++; const pool = f.openDatabase(config);
      if (mode !== "cleanup-error" || config.username !== f.config.coordinator.database.username) return pool;
      return { ...pool, async close() { await pool.close(); throw new Error("synthetic pool close error"); } };
    }, install() {}, clock: () => instant + 8000, createServer: () => server });
    await assert.rejects(host.start({ configuration: f.config, port: mode === "invalid-port" ? 0 : 3210, handler,
      assets: { count: 0, digest: "synthetic", respond: () => undefined } }),
    new RegExp(mode === "invalid-port" ? "config_invalid" : mode === "cleanup-error" ? "cleanup_uncertain" : "start_failed"));
    assert.equal(opens, mode === "invalid-port" ? 0 : 2);
    assert.equal(binds, mode === "invalid-port" ? 0 : 1);
    assert.equal(listenerCloses, binds);
    assert.equal(f.web.closes(), binds); assert.equal(f.coordinator.closes(), binds);
    await assert.rejects(host.start({}), /already_attempted/);
  });
});

test("task startup and database role material never enter browser assets", () => {
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const file of files("dist-vps/client").filter(path => path.endsWith(".js")))
    assert.doesNotMatch(readFileSync(file, "utf8"), /private_task_startup_|control_room_task_coordinator|startPrivateTaskApplication/);
});
