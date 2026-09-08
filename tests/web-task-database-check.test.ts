import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateTaskDatabaseCheck } from "../src/web/v1/private-task-database-check";
import { taskStartupFixture } from "./helpers/task-startup";
import { instant } from "./hermes-native-fixture";
import { readFile } from "node:fs/promises";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";

test("task database-only checks use real restricted roles and bounded cleanup without invoking runtime ports", async t => {
  // All cases share one disposable backend; each check gets fresh owned pool
  // handles. This tests actual LOGIN privileges, not independent PG sessions.
  const f = await taskStartupFixture(); t.after(f.close);
  const config = { ...f.config, web: { ...f.config.web, loadKeys: async () => { assert.fail("must not load issuer keys"); } },
    coordinator: { ...f.config.coordinator, planning: { ...f.config.coordinator.planning,
      checkpoints: { ...f.config.coordinator.planning.checkpoints, read: async () => { assert.fail("must not read runtime checkpoints"); } } } } };
  function resources() {
    const web = f.pool("web_test"), coordinator = f.pool("coordinator_test"), opens: string[] = [];
    return { web, coordinator, opens, openDatabase: (input: { username: string }) => {
      opens.push(input.username); assert.ok(["web_test", "coordinator_test"].includes(input.username));
      return input.username === "web_test" ? web : coordinator;
    } };
  }
  await t.test("minimal web and coordinator roles preflight and close without activating services", async () => {
    const r = resources();
    const receipt = await createPrivateTaskDatabaseCheck({ openDatabase: r.openDatabase, clock: () => instant + 8000 })(config);
    assert.equal(receipt.databasePreflight, "passed"); assert.equal(receipt.databaseClosed, true);
    assert.deepEqual(receipt.rolesChecked, ["web", "coordinator"]);
    for (const name of ["applicationInstalled", "listenerStarted", "workersStarted", "productionReady", "backupVerified"] as const)
      assert.equal(receipt[name], false);
    assert.deepEqual(r.opens, ["web_test", "coordinator_test"]); assert.deepEqual([r.web.closes(), r.coordinator.closes()], [1, 1]);
    assert.doesNotMatch(JSON.stringify(receipt), /synthetic-only|template1|identity:test/);
  });
  await t.test("optional Idea writer is checked without runtime or checkpoint calls", async () => {
    await f.raw.exec("SET SESSION AUTHORIZATION postgres");
    await f.raw.exec(await readFile("db/roles/idea_creation_roles.sql", "utf8"));
    await f.raw.exec("CREATE ROLE idea_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT control_room_idea_creation TO idea_test");
    // taskStartupFixture already includes the reviewed Idea adapter setup.
    assert.equal((await f.raw.query("SELECT id FROM adapter_registry WHERE tenant_id=$1 AND id='adapter.control-room-native-ideas'", [f.scope.tenantId])).rows.length, 1);
    const r = resources(), ideas = f.pool("idea_test"), key = new Uint8Array(32).fill(67);
    const receipt = await createPrivateTaskDatabaseCheck({ clock: () => instant + 8000,
      openDatabase: input => input.username === "idea_test" ? ideas : r.openDatabase(input) })({
      ...config, web: { ...config.web, ideaProjects: { integrityKey: key } }, coordinator: { ...config.coordinator,
        ideaCreation: { database: { ...config.coordinator.database, username: "idea_test" }, integrityKey: key,
          participants: buildIdeaLabFixtureV1().session.participants } },
    });
    assert.deepEqual(receipt.rolesChecked, ["web", "coordinator", "ideas"]);
    assert.equal(receipt.workersStarted, false); assert.deepEqual([r.web.closes(), r.coordinator.closes(), ideas.closes()], [1, 1, 1]);
  });
  await t.test("failed web role prevents later acquisition and returns no private diagnostics", async () => {
    await f.raw.exec("SET SESSION AUTHORIZATION postgres; REVOKE SELECT ON projects FROM control_room_private_web");
    const r = resources();
    try {
      await assert.rejects(createPrivateTaskDatabaseCheck({ openDatabase: r.openDatabase, clock: () => instant + 8000 })(config),
        { message: "private_task_database_check_failed" });
      assert.deepEqual(r.opens, ["web_test"]); assert.deepEqual([r.web.closes(), r.coordinator.closes()], [1, 0]);
    } finally { await f.raw.exec("SET SESSION AUTHORIZATION postgres; GRANT SELECT ON projects TO control_room_private_web"); }
  });
  await t.test("invalid same-primary and shared-login configurations acquire no resources", async () => {
    for (const database of [
      { ...config.coordinator.database, database: "different_synthetic_database" },
      { ...config.coordinator.database, username: config.web.database.username },
    ]) {
      const r = resources();
      await assert.rejects(createPrivateTaskDatabaseCheck({ openDatabase: r.openDatabase, clock: () => instant + 8000 })({
        ...config, coordinator: { ...config.coordinator, database },
      }), { message: "private_task_database_check_failed" });
      assert.deepEqual(r.opens, []); assert.deepEqual([r.web.closes(), r.coordinator.closes()], [0, 0]);
    }
  });
  await t.test("failed coordinator closes both acquired pools without acquiring configured Ideas", async () => {
    await f.raw.exec("SET SESSION AUTHORIZATION postgres; REVOKE SELECT ON projects FROM control_room_task_coordinator");
    const r = resources(), ideas = f.pool("idea_test"), key = new Uint8Array(32).fill(67);
    let ideaOpens = 0;
    try {
      await assert.rejects(createPrivateTaskDatabaseCheck({ clock: () => instant + 8000, openDatabase: input => {
        if (input.username === "idea_test") { ideaOpens++; return ideas; }
        return r.openDatabase(input);
      } })({ ...config, web: { ...config.web, ideaProjects: { integrityKey: key } }, coordinator: {
        ...config.coordinator, ideaCreation: { database: { ...config.coordinator.database, username: "idea_test" },
          integrityKey: key, participants: buildIdeaLabFixtureV1().session.participants },
      } }), { message: "private_task_database_check_failed" });
      assert.deepEqual(r.opens, ["web_test", "coordinator_test"]); assert.equal(ideaOpens, 0);
      assert.deepEqual([r.web.closes(), r.coordinator.closes(), ideas.closes()], [1, 1, 0]);
    } finally { await f.raw.exec("SET SESSION AUTHORIZATION postgres; GRANT SELECT ON projects TO control_room_task_coordinator"); }
  });
  await t.test("cancellation before and immediately after acquisition does not continue", async () => {
    for (const early of [true, false]) {
      const r = resources(), controller = new AbortController(); if (early) controller.abort();
      await assert.rejects(createPrivateTaskDatabaseCheck({ clock: () => instant + 8000,
        openDatabase: input => { const pool = r.openDatabase(input); controller.abort(); return pool; } })(config, controller.signal));
      assert.equal(r.opens.length, early ? 0 : 1); assert.equal(r.web.closes(), early ? 0 : 1); assert.equal(r.coordinator.closes(), 0);
    }
  });
  await t.test("same resource alias closes once and distinct handles sharing a client each close once", async () => {
    for (const separateHandle of [false, true]) {
      const web = f.pool("web_test"); let aliasCloses = 0, opens = 0;
      const alias = separateHandle ? { ...web, close: async () => { aliasCloses++; } } : web;
      await assert.rejects(createPrivateTaskDatabaseCheck({ clock: () => instant + 8000,
        openDatabase: () => ++opens === 1 ? web : alias })(config));
      assert.equal(opens, 2); assert.equal(web.closes(), 1); assert.equal(aliasCloses, separateHandle ? 1 : 0);
    }
  });
  await t.test("cleanup failure stays failure and cannot leak its underlying message", async () => {
    const r = resources(); let closes = 0;
    const error = await createPrivateTaskDatabaseCheck({ clock: () => instant + 8000, openDatabase: input => {
      const pool = r.openDatabase(input);
      return { ...pool, close: async () => { closes++; await pool.close(); throw new Error("private-host-and-password"); } };
    } })(config).then(() => assert.fail("cleanup failure cannot pass"), reason => reason);
    assert.ok(error instanceof Error); assert.equal(error.message, "private_task_database_check_cleanup_uncertain");
    assert.equal(closes, 2); assert.deepEqual([r.web.closes(), r.coordinator.closes()], [1, 1]);
  });
});
