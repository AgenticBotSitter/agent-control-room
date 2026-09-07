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
  const saved = await handle("/api/v1/ideas", "POST", draft); assert.equal(saved.status, 201, await saved.clone().text());
  const receipt = await saved.json(); assert.equal(receipt.startsWork, false);
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
