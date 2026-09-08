import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { taskStartupFixture } from "./helpers/task-startup";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { createPrivateIdeaAuthoringBootstrap, createPrivateIdeaAuthoringDatabaseCheck } from "../src/web/v1/private-idea-authoring-startup";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { instant } from "./hermes-native-fixture";
import { request } from "./helpers/web-foundation";
import { verifyPrivateIdeaAdapter } from "../src/web/v1/private-database-preflight";

async function fixture() {
  const f = await taskStartupFixture();
  await f.raw.exec(await readFile("db/roles/idea_creation_roles.sql", "utf8"));
  await f.raw.exec("CREATE ROLE idea_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT control_room_idea_creation TO idea_test");
  const writer = f.pool("idea_test");
  const config = { web: { ...f.config.web, ideaProjects: { integrityKey: new Uint8Array(32).fill(67) } },
    ideaAuthoring: { database: { ...f.config.web.database, username: "idea_test" }, participants: buildIdeaLabFixtureV1().session.participants } };
  return { ...f, writer, config, openDatabase: (db: { username: string }) => {
    assert.ok(["web_test", "idea_test"].includes(db.username)); return db.username === "web_test" ? f.web : writer;
  } };
}

test("authoring setup requires the native Idea registration without creating or repairing it", async t => {
  const f = await fixture(); t.after(f.close);
  const scope = f.config.web;
  await verifyPrivateIdeaAdapter(f.web.client, scope);
  for (const sql of [
    "UPDATE adapter_registry SET source_system='wrong' WHERE id='adapter.control-room-native-ideas'",
    "UPDATE adapter_registry SET authority_mode='advisory' WHERE id='adapter.control-room-native-ideas'",
    "UPDATE adapter_registry SET status='disabled' WHERE id='adapter.control-room-native-ideas'",
  ]) {
    await f.raw.exec('SET SESSION AUTHORIZATION postgres');
    await f.raw.exec(sql);
    await assert.rejects(verifyPrivateIdeaAdapter(f.web.client, scope), /private_idea_adapter_unavailable/);
    await f.raw.exec('SET SESSION AUTHORIZATION postgres');
    await f.raw.exec("UPDATE adapter_registry SET source_system='control_room_native_ideas',authority_mode='control_room_native',status='pending' WHERE id='adapter.control-room-native-ideas'");
  }
  await assert.rejects(verifyPrivateIdeaAdapter(f.web.client, { tenantId: 'tenant:other' }), /private_idea_adapter_unavailable/);
  await f.raw.exec('SET SESSION AUTHORIZATION postgres');
  await f.raw.exec("DELETE FROM adapter_registry WHERE id='adapter.control-room-native-ideas'");
  await assert.rejects(createPrivateIdeaAuthoringDatabaseCheck({ openDatabase: f.openDatabase,
    clock: () => instant + 8000 })(f.config), /private_idea_authoring_prerequisites_failed/);
  assert.deepEqual([f.web.closes(), f.writer.closes()], [1, 0]);
  await f.raw.exec('SET SESSION AUTHORIZATION postgres');
  assert.equal((await f.raw.query("SELECT id FROM adapter_registry WHERE id='adapter.control-room-native-ideas'")).rows.length, 0);
  const setup = await readFile("db/setup/private_idea_adapter.sql", "utf8");
  await f.raw.query("SELECT set_config('control_room.setup_tenant_id','',false)");
  await assert.rejects(f.raw.exec(setup), /private_idea_adapter_setup_invalid/);
  await f.raw.exec('ROLLBACK');
  await f.raw.query("SELECT set_config('control_room.setup_tenant_id',$1,false)", [scope.tenantId]);
  await f.raw.exec(setup);
  const registered = await f.raw.query("SELECT tenant_id,status FROM adapter_registry WHERE id='adapter.control-room-native-ideas'");
  assert.deepEqual(registered.rows, [{ tenant_id: scope.tenantId, status: 'pending' }]);
  await assert.rejects(f.raw.exec(setup), /duplicate key/);
  await f.raw.exec('ROLLBACK');
  assert.deepEqual((await f.raw.query("SELECT tenant_id,status FROM adapter_registry WHERE id='adapter.control-room-native-ideas'")).rows, registered.rows);
});

test("two-role authoring mounts existing save/options/read without task planning or runtime", async t => {
  const f = await fixture(); t.after(f.close); let app!: ReturnType<typeof createPrivateWebProcess>, opens = 0;
  const runtime = await createPrivateIdeaAuthoringBootstrap({ clock: () => instant + 8000,
    openDatabase: db => { opens++; return f.openDatabase(db); }, install: options => app = createPrivateWebProcess(options) }).start(f.config);
  t.after(() => runtime.close());
  const handle = (path: string, method = "GET", body?: unknown) => app.handle(request(path, method, body, "idea-authoring-0001", f.jwt), () => new Response("shell"));
  assert.equal(opens, 2); assert.equal(runtime.isReady(), true);
  assert.equal((await (await handle("/api/v1/ideas/options")).json()).participants.length, 4);
  const draft = { title: "Local business", ideaSummary: "Help local teams", targetCustomer: "Small teams", maxRounds: 2, maxDurationSeconds: 300, maxCostUsd: 2 };
  const saved = await handle("/api/v1/ideas", "POST", draft); assert.equal(saved.status, 201);
  const receipt = await saved.json(); assert.equal(receipt.startsWork, false);
  assert.equal((await handle("/api/v1/ideas", "POST", draft)).status, 200);
  const path = `/api/v1/ideas/${encodeURIComponent(receipt.sessionId)}`;
  assert.equal((await handle(path)).status, 200);
  assert.equal((await handle(`${path}/start`, "POST", { sessionDigest: receipt.sessionDigest })).status, 503);
  assert.equal((await handle(`${path}/synthesis`, "POST", { sessionDigest: receipt.sessionDigest, runId: "idea-run:not-started" })).status, 409);
  await assert.rejects(f.web.client.query("INSERT INTO control_idea_sessions DEFAULT VALUES"), /permission denied/);
  await assert.rejects(f.writer.client.query("INSERT INTO control_outbox DEFAULT VALUES"), /permission denied/);
  await runtime.close(); assert.equal(runtime.isReady(), false);
  assert.deepEqual([f.web.closes(), f.writer.closes(), f.coordinator.closes()], [1, 1, 0]);
  assert.equal((await handle(path)).status, 503);
});

test("database-only authoring check verifies both roles and closes without installing or saving", async t => {
  const f = await fixture(); t.after(f.close);
  const before = (await f.raw.query("SELECT * FROM control_idea_sessions")).rows.length;
  const result = await createPrivateIdeaAuthoringDatabaseCheck({ openDatabase: f.openDatabase, clock: () => instant + 8000 })(f.config);
  assert.equal(result.databasePreflight, "passed"); assert.equal(result.databaseClosed, true);
  assert.deepEqual(result.rolesVerified, ["web", "idea-authoring"]);
  assert.equal(result.applicationInstalled, false); assert.equal(result.listenerStarted, false);
  assert.equal(result.backupVerified, false); assert.equal(result.productionReady, false);
  assert.deepEqual([f.web.closes(), f.writer.closes(), f.coordinator.closes()], [1, 1, 0]);
  assert.equal((await f.raw.query("SELECT * FROM control_idea_sessions")).rows.length, before);
});

test("authoring database check never returns acceptance when either cleanup fails", async t => {
  const f = await fixture(); t.after(f.close); let failedCloses = 0;
  const writer = { ...f.writer, close: async () => { failedCloses++; throw new Error("synthetic cleanup failure"); } };
  await assert.rejects(createPrivateIdeaAuthoringDatabaseCheck({ clock: () => instant + 8000,
    openDatabase: db => db.username === "web_test" ? f.web : writer })(f.config), /cleanup_uncertain/);
  assert.equal(f.web.closes(), 1); assert.equal(failedCloses, 1);
});

test("authoring rejects missing keys, wrong primary, shared login and executable fields before opening", async t => {
  const f = await fixture(); t.after(f.close); let effects = 0;
  for (const config of [
    { ...f.config, web: { ...f.config.web, ideaProjects: undefined } },
    { ...f.config, ideaAuthoring: { ...f.config.ideaAuthoring, database: f.config.web.database } },
    { ...f.config, ideaAuthoring: { ...f.config.ideaAuthoring, database: { ...f.config.ideaAuthoring.database, database: "other" } } },
    { ...f.config, ideaAuthoring: { ...f.config.ideaAuthoring, participants: [] } },
    { ...f.config, coordinator: {} }, { ...f.config, ideaAuthoring: { ...f.config.ideaAuthoring, runtime: {} } },
  ]) await assert.rejects(createPrivateIdeaAuthoringBootstrap({ openDatabase: () => { effects++; throw new Error(); },
    install: () => { effects++; throw new Error(); } }).start(config), /config_invalid/);
  assert.equal(effects, 0);
});

test("failed writer preflight closes both resources and cannot retry startup", async t => {
  const f = await fixture(); t.after(f.close); let installs = 0;
  await f.raw.exec("GRANT INSERT ON control_outbox TO control_room_idea_creation");
  const bootstrap = createPrivateIdeaAuthoringBootstrap({ clock: () => instant + 8000,
    openDatabase: f.openDatabase, install: () => { installs++; throw new Error(); } });
  await assert.rejects(bootstrap.start(f.config), /prerequisites_failed/);
  assert.equal(installs, 0); assert.deepEqual([f.web.closes(), f.writer.closes()], [1, 1]);
  await assert.rejects(bootstrap.start(f.config), /already_attempted/);
});

test("aliased client wrappers retain both cleanup obligations without installing", async t => {
  const f = await fixture(); t.after(f.close); let secondCloses = 0, installs = 0;
  const aliased = { ...f.web, close: async () => { secondCloses++; } };
  const bootstrap = createPrivateIdeaAuthoringBootstrap({ clock: () => instant + 8000,
    openDatabase: db => db.username === "web_test" ? f.web : aliased,
    install: () => { installs++; throw new Error(); } });
  await assert.rejects(bootstrap.start(f.config), /prerequisites_failed/);
  assert.equal(installs, 0); assert.equal(f.web.closes(), 1); assert.equal(secondCloses, 1);
});

test("cancellation at writer acquisition and installation failure both close owned pools", async t => {
  for (const cancel of [true, false]) await t.test(String(cancel), async t => {
    const f = await fixture(); t.after(f.close); const controller = new AbortController(); let installs = 0;
    const bootstrap = createPrivateIdeaAuthoringBootstrap({ clock: () => instant + 8000,
      openDatabase: db => { const pool = f.openDatabase(db); if (cancel && db.username === "idea_test") controller.abort(); return pool; },
      install: () => { installs++; throw new Error("synthetic installation failure"); } });
    await assert.rejects(bootstrap.start(f.config, controller.signal), /prerequisites_failed/);
    assert.equal(installs, cancel ? 0 : 1); assert.deepEqual([f.web.closes(), f.writer.closes()], [1, 1]);
  });
});
