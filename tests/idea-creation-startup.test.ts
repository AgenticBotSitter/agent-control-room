import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { taskStartupFixture } from "./helpers/task-startup";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { createPrivateTaskBootstrap } from "../src/web/v1/private-task-startup";
import type { PrivateApplication } from "../src/web/v1/private-process";
import { instant } from "./hermes-native-fixture";
import { request } from "./helpers/web-foundation";

async function fixture() {
  const f = await taskStartupFixture();
  await f.raw.exec(await readFile("db/roles/idea_creation_roles.sql", "utf8"));
  await f.raw.exec("CREATE ROLE idea_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT control_room_idea_creation TO idea_test");
  const ideas = f.pool("idea_test"), integrityKey = new Uint8Array(32).fill(67);
  const config = { ...f.config, web: { ...f.config.web, ideaProjects: { integrityKey } },
    coordinator: { ...f.config.coordinator, ideaCreation: { integrityKey, participants: buildIdeaLabFixtureV1().session.participants,
      database: { ...f.config.coordinator.database, username: "idea_test" } } } };
  return { ...f, ideas, config, openDatabase: (db: { username: string }) => db.username === "idea_test" ? ideas : f.openDatabase(db) };
}
test("bootstrap verifies all three exact roles and mounts non-executing Idea creation", async t => {
  const f = await fixture(); t.after(f.close); let app!: PrivateApplication, opens = 0;
  const runtime = await createPrivateTaskBootstrap({ clock: () => instant + 8000,
    openDatabase: db => { opens++; return f.openDatabase(db); }, install: value => { app = value; } }).start(f.config);
  t.after(() => runtime.close()); assert.equal(opens, 3); assert.equal(runtime.isReady(), true);
  const draft = { title: "New business", ideaSummary: "Help local businesses", targetCustomer: "Shop owners",
    maxRounds: 2, maxDurationSeconds: 300, maxCostUsd: 2 };
  const handle = (path: string, method = "GET", body?: unknown) =>
    app.handle(request(path, method, body, "idea-startup-0001", f.jwt), () => new Response("shell"));
  assert.equal((await (await handle("/api/v1/ideas")).json()).canCreate, true);
  const options = await handle("/api/v1/ideas/options");
  assert.equal(options.status, 200); assert.equal((await options.json()).participants.length, 4);
  const saved = await handle("/api/v1/ideas", "POST", draft); assert.equal(saved.status, 201, await saved.clone().text());
  const receipt = await saved.json(); assert.equal(receipt.startsWork, false);
  assert.equal((await handle(`/api/v1/ideas/${encodeURIComponent(receipt.sessionId)}/synthesis`, "POST", {
    sessionDigest: receipt.sessionDigest, runId: "idea-run:not-started",
  })).status, 409);
  // Managed composition supplies the operation, but a saved draft without a
  // synthesis is not eligible. This is a conflict, not an unconfigured route.
  assert.equal((await handle(`/api/v1/ideas/${encodeURIComponent(receipt.sessionId)}/decision`, "POST", {
    sessionDigest: receipt.sessionDigest, synthesisDigest: `sha256:${"a".repeat(64)}`,
    intent: { decision: "save", safeReasonCode: "owner_selected" },
  })).status, 409);
  assert.equal((await handle("/api/v1/ideas", "POST", draft)).status, 200);
  assert.equal((await handle(`/api/v1/ideas/${receipt.sessionId}`)).status, 200);
  await assert.rejects(f.web.client.query("INSERT INTO control_idea_sessions DEFAULT VALUES"), /permission denied/);
  await assert.rejects(f.ideas.client.query("INSERT INTO control_outbox DEFAULT VALUES"), /permission denied/);
  await runtime.close(); assert.deepEqual([f.web.closes(), f.coordinator.closes(), f.ideas.closes()], [1, 1, 1]);
});
test("invalid Idea topology, key or roster opens no resources", async t => {
  const f = await fixture(); t.after(f.close); let effects = 0;
  const idea = f.config.coordinator.ideaCreation;
  for (const patch of [
    { database: f.config.web.database }, { database: f.config.coordinator.database },
    { database: { ...idea.database, database: "another" } },
    { integrityKey: new Uint8Array(32).fill(68) }, { participants: [] },
    { participants: [idea.participants[0], idea.participants[0], idea.participants[0]] },
  ]) {
    const bootstrap = createPrivateTaskBootstrap({ openDatabase: () => { effects++; throw new Error(); }, install: () => { effects++; } });
    await assert.rejects(bootstrap.start({ ...f.config, coordinator: { ...f.config.coordinator, ideaCreation: { ...idea, ...patch } } }), /config_invalid/);
  }
  assert.equal(effects, 0);
});
test("full task startup refuses missing Idea registration and closes all acquired pools", async t => {
  const f = await fixture(); t.after(f.close); let installs = 0;
  await f.raw.exec("DELETE FROM adapter_registry WHERE id='adapter.control-room-native-ideas'");
  const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000,
    openDatabase: f.openDatabase, install: () => { installs++; } });
  await assert.rejects(bootstrap.start(f.config), /prerequisites_failed/);
  assert.equal(installs, 0);
  assert.deepEqual([f.web.closes(), f.coordinator.closes(), f.ideas.closes()], [1, 1, 1]);
});
test("failed Idea preflight or cancellation cleans all acquired resources without installing", async t => {
  for (const cancel of [false, true]) await t.test(String(cancel), async t => {
    const f = await fixture(); t.after(f.close); const controller = new AbortController(); let installs = 0;
    if (!cancel) await f.raw.exec("GRANT INSERT ON control_outbox TO control_room_idea_creation");
    const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000,
      openDatabase: db => { const pool = f.openDatabase(db); if (cancel && db.username === "idea_test") controller.abort(); return pool; },
      install: () => { installs++; } });
    await assert.rejects(bootstrap.start(f.config, controller.signal), /prerequisites_failed/);
    assert.equal(installs, 0); assert.deepEqual([f.web.closes(), f.coordinator.closes(), f.ideas.closes()], [1, 1, 1]);
    await assert.rejects(bootstrap.start(f.config), /already_attempted/);
  });
});

test("a reused Idea pool cannot mount the app or double-close a resource", async t => {
  const f = await fixture(); t.after(f.close); let installs = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000,
    openDatabase: db => db.username === "idea_test" ? f.coordinator : f.openDatabase(db),
    install: () => { installs++; } });
  await assert.rejects(bootstrap.start(f.config), /prerequisites_failed/);
  assert.equal(installs, 0); assert.deepEqual([f.web.closes(), f.coordinator.closes(), f.ideas.closes()], [1, 1, 0]);
});

async function runtimeFixture() {
  const f = await fixture();
  await f.raw.exec(await readFile("db/roles/idea_runtime_roles.sql", "utf8"));
  await f.raw.exec("CREATE ROLE idea_runtime_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT control_room_idea_runtime TO idea_runtime_test");
  const runtimeDb = f.pool("idea_runtime_test"); let closes = 0, lookups = 0, calls = 0;
  const runtime = { driver: { mode: "hermes_bot_mode_filtered" as const, async invoke(): Promise<never> { calls++; throw new Error("must not invoke"); } },
    async resolve(): Promise<never> { lookups++; throw new Error("synthetic missing accepted window"); },
    evidenceAuthority: { async verify() { return false; } }, admissionAuthority: { async consume() { return false; } } };
  const config = { ...f.config, coordinator: { ...f.config.coordinator,
    ideaRuntime: { database: { ...f.config.coordinator.database, username: "idea_runtime_test" }, runtime, close: async () => { closes++; } } } };
  return { ...f, config, runtimeDb, counts: () => ({ closes, lookups, calls }),
    openDatabase: (db: { username: string }) => db.username === "idea_runtime_test" ? runtimeDb : f.openDatabase(db) };
}

test("bootstrap verifies a fourth runtime role, mounts start and owns prepared ports without activating them", async t => {
  const f = await runtimeFixture(); t.after(f.close); let app!: PrivateApplication;
  const owner = await createPrivateTaskBootstrap({ clock: () => instant + 8000,
    openDatabase: db => {
      // Configuration captures ports before the first asynchronous database gate.
      f.config.coordinator.ideaRuntime.runtime.resolve = async () => { throw new Error("mutated lookup"); };
      f.config.coordinator.ideaRuntime.close = async () => { throw new Error("mutated cleanup"); };
      return f.openDatabase(db);
    }, install: value => { app = value; } }).start(f.config);
  t.after(() => owner.close()); assert.deepEqual(f.counts(), { closes: 0, lookups: 0, calls: 0 });
  const handle = (path: string, body: unknown) => app.handle(request(path, "POST", body, "idea-runtime-startup01", f.jwt), () => new Response("shell"));
  const saved = await handle("/api/v1/ideas", { title: "Startup idea", ideaSummary: "Help local shops", targetCustomer: "Owners",
    maxRounds: 1, maxDurationSeconds: 300, maxCostUsd: 2 });
  assert.equal(saved.status, 201); const receipt = await saved.json();
  const response = await handle(`/api/v1/ideas/${encodeURIComponent(receipt.sessionId)}/start`, { sessionDigest: receipt.sessionDigest });
  assert.equal(response.status, 503); assert.equal(f.counts().lookups, 1); assert.equal(f.counts().calls, 0);
  assert.equal((await f.runtimeDb.client.query("SELECT * FROM control_idea_bot_run_events")).rows.length, 0);
  await owner.close(); await owner.close(); assert.equal(f.counts().closes, 1);
  assert.deepEqual([f.web.closes(), f.coordinator.closes(), f.ideas.closes(), f.runtimeDb.closes()], [1, 1, 1, 1]);
});

test("invalid runtime topology or fake mode leaves ownership with caller and opens no pools", async t => {
  const f = await runtimeFixture(); t.after(f.close); let opens = 0;
  for (const patch of [{ database: f.config.coordinator.ideaCreation.database },
    { database: { ...f.config.coordinator.ideaRuntime.database, database: "other" } },
    { runtime: { ...f.config.coordinator.ideaRuntime.runtime, driver: { ...f.config.coordinator.ideaRuntime.runtime.driver, mode: "repository_fake" as const } } }]) {
    const bootstrap = createPrivateTaskBootstrap({ openDatabase: () => { opens++; throw new Error(); }, install: () => {} });
    await assert.rejects(bootstrap.start({ ...f.config, coordinator: { ...f.config.coordinator,
      ideaRuntime: { ...f.config.coordinator.ideaRuntime, ...patch } } }), /config_invalid/);
  }
  assert.equal(opens, 0); assert.deepEqual(f.counts(), { closes: 0, lookups: 0, calls: 0 });
});

test("failed runtime verification, cancellation and installation clean prepared ports and all pools once", async t => {
  for (const phase of ["preflight", "cancel", "install", "cleanup", "stalled"] as const) await t.test(phase, async t => {
    const f = await runtimeFixture(); t.after(f.close); const abort = new AbortController();
    if (phase === "preflight" || phase === "cleanup" || phase === "stalled") await f.raw.exec("GRANT INSERT ON control_idea_decisions TO control_room_idea_runtime");
    if (phase === "cleanup" || phase === "stalled") { const close = f.config.coordinator.ideaRuntime.close;
      f.config.coordinator.ideaRuntime.close = async () => {
        await close(); if (phase === "stalled") await new Promise<void>(() => {}); throw new Error("synthetic failed cleanup");
      }; }
    const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000,
      openDatabase: db => { const pool = f.openDatabase(db); if (phase === "cancel" && db.username === "idea_runtime_test") abort.abort(); return pool; },
      install: () => { throw new Error("synthetic failed install"); } });
    await assert.rejects(bootstrap.start(f.config, abort.signal), phase === "cleanup" || phase === "stalled" ? /cleanup_uncertain/ : /prerequisites_failed/);
    assert.deepEqual(f.counts(), { closes: 1, lookups: 0, calls: 0 });
    assert.deepEqual([f.web.closes(), f.coordinator.closes(), f.ideas.closes(), f.runtimeDb.closes()], [1, 1, 1, 1]);
    await assert.rejects(bootstrap.start(f.config), /already_attempted/);
  });
});
