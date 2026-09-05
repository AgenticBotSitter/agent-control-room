import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateTaskBootstrap, type PrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import type { PrivateApplication } from "../src/web/v1/private-process";
import { taskStartupFixture } from "./helpers/task-startup";
import { instant } from "./hermes-native-fixture";
import { request } from "./helpers/web-foundation";

test("two real restricted roles pass startup and serve assignment without widening web writes", async t => {
  const f = await taskStartupFixture(); t.after(f.close);
  let app!: PrivateApplication, installs = 0, opens = 0, loads = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000,
    openDatabase: config => { opens++; return f.openDatabase(config); }, install: value => { app = value; installs++; } });
  const runtime = await bootstrap.start({ ...f.config, web: { ...f.config.web, loadKeys: async () => { loads++; return f.accessTrust.keys; } } });
  t.after(() => runtime.close());
  assert.equal(opens, 2); assert.equal(installs, 1); assert.equal(loads, 0);
  assert.equal(runtime.isReady(), true); assert.deepEqual(Object.keys(runtime).sort(), ["close", "isReady"]);
  await assert.rejects(f.web.client.query("UPDATE control_jobs SET state='ready'"));
  const path = `/api/v1/projects/${f.prepared.receipt.projectId}/tasks/${f.prepared.receipt.jobId}/assignment`;
  const handle = (method = "GET", body?: unknown) => app.handle(request(path, method, body, undefined, f.jwt), () => new Response("shell"));
  assert.equal((await handle()).status, 200);
  const saved = await handle("POST", { action: "assign", nodeId: f.route.nodeId, expectedInputDigest: f.prepared.receipt.inputDigest });
  assert.equal(saved.status, 201, await saved.clone().text()); assert.equal((await saved.json()).receipt.startsWork, false);
  assert.equal((await handle("POST", { action: "assign", nodeId: f.route.nodeId, expectedInputDigest: f.prepared.receipt.inputDigest })).status, 200);
  await assert.rejects(bootstrap.start(f.config), /already_attempted/);
  const closing = runtime.close(); assert.equal(runtime.close(), closing); assert.equal(runtime.isReady(), false);
  assert.equal((await handle()).status, 503); await closing;
  assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
});

test("invalid topology, planning and route configuration cannot open any resource", async t => {
  const f = await taskStartupFixture(); t.after(f.close); let calls = 0;
  const invalid: PrivateTaskStartupConfiguration[] = [
    { ...f.config, coordinator: { ...f.config.coordinator, database: f.config.web.database } },
    ...[{ database: "another" }, { port: 5433 }, { host: "remote.invalid" }].map(patch => ({ ...f.config,
      coordinator: { ...f.config.coordinator, database: { ...f.config.coordinator.database, ...patch } } } as PrivateTaskStartupConfiguration)),
    { ...f.config, coordinator: { ...f.config.coordinator, routes: [f.route, f.route] } },
    { ...f.config, coordinator: { ...f.config.coordinator, planning: { ...f.plannerConfig, integrityKey: new Uint8Array(1) } } },
    { ...f.config, coordinator: { ...f.config.coordinator, planning: { ...f.plannerConfig,
      template: { ...f.plannerConfig.template, adapter: "invalid" as never } } } },
  ];
  for (const config of invalid) {
    const bootstrap = createPrivateTaskBootstrap({ openDatabase: () => { calls++; throw new Error(); }, install: () => { calls++; } });
    await assert.rejects(bootstrap.start(config), /config_invalid/);
    await assert.rejects(bootstrap.start(f.config), /already_attempted/);
  }
  assert.equal(calls, 0);
});

test("failed prerequisites and installer failures clean every acquired resource once", async t => {
  for (const failure of ["web", "coordinator", "second-open", "install", "unavailable"] as const) await t.test(failure, async t => {
    const f = await taskStartupFixture(); t.after(f.close); let opens = 0, installs = 0;
    if (failure === "web") await f.raw.exec("REVOKE SELECT ON projects FROM control_room_private_web");
    if (failure === "coordinator") await f.raw.exec("GRANT INSERT ON control_approvals TO control_room_task_coordinator");
    if (failure === "unavailable") f.coordinator.quarantine();
    const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000, openDatabase: config => {
      opens++; if (failure === "second-open" && opens === 2) throw new Error("private detail"); return f.openDatabase(config);
    }, install: () => { installs++; throw new Error("private detail"); } });
    await assert.rejects(bootstrap.start(f.config), { message: "private_task_startup_prerequisites_failed" });
    assert.equal(installs, failure === "install" ? 1 : 0);
    assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), failure === "web" || failure === "second-open" ? 0 : 1);
    await assert.rejects(bootstrap.start(f.config), /already_attempted/);
  });
});

test("uncertain cleanup is reported without retrying either close", async t => {
  const f = await taskStartupFixture(); t.after(f.close); let closes = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000, openDatabase: config => config.username === "web_test"
    ? { ...f.web, close: async () => { closes++; throw new Error("private failure"); } } : f.coordinator,
    install: () => { throw new Error(); } });
  await assert.rejects(bootstrap.start(f.config), { message: "private_task_startup_cleanup_uncertain" });
  assert.equal(closes, 1); assert.equal(f.coordinator.closes(), 1);
});

test("startup snapshots keys and routes before opening either resource", async t => {
  const f = await taskStartupFixture(); t.after(f.close); let app!: PrivateApplication, opens = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000, openDatabase: config => {
    if (++opens === 1) {
      f.config.coordinator.database.username = "mutated_login";
      f.config.coordinator.planning.integrityKey.fill(0);
      f.config.coordinator.planning.template.instructions = "mutated instructions";
      f.config.coordinator.routes[0]!.nodeId = "node:mutated";
    }
    assert.notEqual(config.username, "mutated_login"); return f.openDatabase(config);
  }, install: value => { app = value; } });
  const runtime = await bootstrap.start(f.config); t.after(() => runtime.close());
  const path = `/api/v1/projects/${f.prepared.receipt.projectId}/tasks/${f.prepared.receipt.jobId}/assignment`;
  const response = await app.handle(request(path, "GET", undefined, undefined, f.jwt), () => new Response());
  assert.equal(response.status, 200, await response.clone().text());
  assert.notEqual((await response.json()).candidates[0].nodeId, "node:mutated");
  f.web.quarantine(); assert.equal(runtime.isReady(), false);
});

test("same supplied resource is rejected and closed only once", async t => {
  const f = await taskStartupFixture(); t.after(f.close); let installs = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000, openDatabase: () => f.web,
    install: () => { installs++; } });
  await assert.rejects(bootstrap.start(f.config), /prerequisites_failed/);
  assert.equal(f.web.closes(), 1); assert.equal(installs, 0);
});

test("stalled prerequisite cleanup has a fixed deadline and remains uncertain", async t => {
  const f = await taskStartupFixture(); t.after(f.close); let closes = 0;
  await f.raw.exec("REVOKE SELECT ON projects FROM control_room_private_web");
  const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000,
    openDatabase: () => ({ ...f.web, close: () => { closes++; return new Promise<void>(() => {}); } }), install: () => assert.fail() });
  await assert.rejects(bootstrap.start(f.config), { message: "private_task_startup_cleanup_uncertain" });
  assert.equal(closes, 1); await assert.rejects(bootstrap.start(f.config), /already_attempted/);
});
