import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fixture, now, request, trust } from "./helpers/web-foundation";
import { startupConfig } from "./helpers/web-startup";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { verifyIdeaCreationDatabase, verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import type { DatabaseClient } from "../src/persistence/database";

async function setup() {
  const f = await fixture();
  await f.db.exec(await readFile("db/roles/idea_creation_roles.sql", "utf8"));
  await f.db.exec(`CREATE ROLE idea_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_idea_creation TO idea_test;
    SET SESSION AUTHORIZATION idea_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  // Same documented PGlite-only TEMP metadata exception as other role tests.
  const client: DatabaseClient = { ...f.client, query: f.client.query.bind(f.client), transaction: async work => f.client.transaction(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
      return result;
    },
  })), transactionWithPreCommitCheck: f.client.transactionWithPreCommitCheck.bind(f.client) };
  return { ...f, checked: client, config: { ...startupConfig.database, username: "idea_test" } };
}
test("exact Idea creation SQL role passes preflight and saves without result or execution rights", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await assert.rejects(verifyIdeaCreationDatabase(f.client, f.config, startupConfig, now));
  await verifyIdeaCreationDatabase(f.checked, f.config, startupConfig, now);
  await assert.rejects(verifyPrivateDatabase(f.checked, f.config, startupConfig, now));
  const service = new IdeaSessionCreationService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" },
    new Uint8Array(32).fill(67), buildIdeaLabFixtureV1().session.participants, () => now);
  const identity = createAccessVerifier(trust)(request(), now);
  const draft = { title: "Idea role test", ideaSummary: "Help small businesses.", targetCustomer: "Small shops",
    maxRounds: 2, maxDurationSeconds: 300, maxCostUsd: 2 };
  const saved = await service.create(identity, draft, "idea-role-00001");
  assert.equal(saved.startsWork, false); assert.equal((await service.create(identity, draft, "idea-role-00001")).replayed, true);
  for (const table of ["control_idea_contributions", "control_idea_syntheses", "control_idea_decisions", "control_jobs", "control_outbox", "control_leases"])
    await assert.rejects(f.client.query(`INSERT INTO ${table} DEFAULT VALUES`));
  await assert.rejects(f.client.query("UPDATE control_idea_sessions SET payload='{}'::jsonb"));
  await assert.rejects(f.client.query("DELETE FROM control_idea_sessions"));
  await assert.rejects(f.client.query("UPDATE control_role_grants SET allowed_actions='[\"*\"]'::jsonb"));
});

test("Idea creation preflight rejects privilege expansion and removed required permissions", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await verifyIdeaCreationDatabase(f.checked, f.config, startupConfig, now);
  // Administrative changes are confined to this disposable test database.
  await f.db.exec("SET SESSION AUTHORIZATION postgres; GRANT INSERT ON control_outbox TO control_room_idea_creation; SET SESSION AUTHORIZATION idea_test");
  await assert.rejects(verifyIdeaCreationDatabase(f.checked, f.config, startupConfig, now), /preflight_failed/);
  await f.db.exec("SET SESSION AUTHORIZATION postgres; REVOKE INSERT ON control_outbox FROM control_room_idea_creation; REVOKE INSERT ON control_idea_sessions FROM control_room_idea_creation; SET SESSION AUTHORIZATION idea_test");
  await assert.rejects(verifyIdeaCreationDatabase(f.checked, f.config, startupConfig, now), /preflight_failed/);
});
