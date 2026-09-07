import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fixture, now, request, trust } from "./helpers/web-foundation";
import { startupConfig } from "./helpers/web-startup";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { verifyIdeaRuntimeDatabase, verifyIdeaCreationDatabase } from "../src/web/v1/private-database-preflight";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { IdeaLabBotCoordinatorV1, IdeaLabBotRunStoreV1, IdeaLabProjectRegistryStoreV1,
  DeterministicIdeaLabFakeDriverV1, buildIdeaLabFixtureV1, buildRepositoryFakeProviderEvidenceV1 } from "../src/idea-lab/v1";
import type { DatabaseClient } from "../src/persistence/database";

const key = new Uint8Array(32).fill(72), at = new Date(now).toISOString();
async function setup() {
  const f = await fixture();
  const saved = await new IdeaSessionCreationService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key,
    buildIdeaLabFixtureV1().session.participants, () => now).create(createAccessVerifier(trust)(request(), now),
    { title: "Runtime role", ideaSummary: "Help local shops", targetCustomer: "Shop owners", maxRounds: 2,
      maxDurationSeconds: 300, maxCostUsd: 2 }, "idea-runtime-role01");
  const registry = new IdeaLabProjectRegistryStoreV1(f.client, key);
  const session = (await registry.getSession("tenant:web", saved.sessionId))!;
  await f.db.exec(await readFile("db/roles/idea_runtime_roles.sql", "utf8"));
  await f.db.exec(`CREATE ROLE idea_runtime_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_idea_runtime TO idea_runtime_test;
    SET SESSION AUTHORIZATION idea_runtime_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  // Explicit existing PGlite-only TEMP metadata exception; never used in production.
  const checked: DatabaseClient = { ...f.client, query: f.client.query.bind(f.client), transaction: work => f.client.transaction(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
      return result;
    },
  })), transactionWithPreCommitCheck: f.client.transactionWithPreCommitCheck.bind(f.client) };
  return { ...f, registry, session, checked, config: { ...startupConfig.database, username: "idea_runtime_test" } };
}

test("exact runtime role runs injected discussion and retains turns without owner or job writes", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await assert.rejects(verifyIdeaRuntimeDatabase(f.client, f.config, startupConfig, now));
  await verifyIdeaRuntimeDatabase(f.checked, f.config, startupConfig, now);
  await assert.rejects(verifyIdeaCreationDatabase(f.checked, f.config, startupConfig, now));
  const ledger = new IdeaLabBotRunStoreV1(f.client, key);
  const coordinator = new IdeaLabBotCoordinatorV1(ledger, f.registry, new DeterministicIdeaLabFakeDriverV1(), () => at);
  const evidence = f.session.participants.map((p, i) => buildRepositoryFakeProviderEvidenceV1(f.session, p,
    { evidenceId: `evidence:runtime-role:${i}`, capturedAt: at, expiresAt: new Date(now + 240000).toISOString() }));
  const result = await coordinator.execute({ runId: "idea-run:runtime-role", session: f.session, evidence, safePrompt: "Discuss this idea." });
  assert.equal(result.state, "completed"); assert.equal(result.messagesUsed, 8);
  assert.equal((await f.registry.listContributions(f.session.tenantId, f.session.sessionId)).length, 8);
  assert.equal((await ledger.get(result.runId))!.runDigest, result.runDigest);
  for (const table of ["control_idea_sessions", "control_idea_syntheses", "control_idea_decisions", "control_idea_owner_authorizations",
    "control_policy_decisions", "projects", "control_jobs", "control_outbox", "control_web_sessions", "audit_events"])
    await assert.rejects(f.client.query(`INSERT INTO ${table} DEFAULT VALUES`), /permission denied/);
  await assert.rejects(f.client.query("UPDATE control_idea_contributions SET payload='{}'::jsonb"), /permission denied/);
  await assert.rejects(f.client.query("DELETE FROM control_idea_bot_run_events"), /permission denied/);
  await assert.rejects(f.client.query("UPDATE control_role_grants SET revoked_at=NULL"), /permission denied/);
});

test("runtime preflight rejects added owner permissions and missing contribution rights", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await verifyIdeaRuntimeDatabase(f.checked, f.config, startupConfig, now);
  await f.db.exec("SET SESSION AUTHORIZATION postgres; GRANT INSERT ON control_idea_decisions TO control_room_idea_runtime; SET SESSION AUTHORIZATION idea_runtime_test");
  await assert.rejects(verifyIdeaRuntimeDatabase(f.checked, f.config, startupConfig, now), /preflight_failed/);
  await f.db.exec("SET SESSION AUTHORIZATION postgres; REVOKE INSERT ON control_idea_decisions FROM control_room_idea_runtime; REVOKE INSERT ON control_idea_contributions FROM control_room_idea_runtime; SET SESSION AUTHORIZATION idea_runtime_test");
  await assert.rejects(verifyIdeaRuntimeDatabase(f.checked, f.config, startupConfig, now), /preflight_failed/);
});

test("runtime can coexist with a configured queue but must retain zero queue permissions", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await f.db.exec(`SET SESSION AUTHORIZATION postgres;
    CREATE SCHEMA control_room_queue; CREATE TABLE control_room_queue.version(version integer);
    CREATE TABLE control_room_queue.queue(name text); CREATE TABLE control_room_queue.job(id text);
    CREATE TABLE control_room_queue.job_common(id text); REVOKE ALL ON SCHEMA control_room_queue FROM PUBLIC;
    SET SESSION AUTHORIZATION idea_runtime_test`);
  await assert.rejects(verifyIdeaRuntimeDatabase(f.checked, f.config, startupConfig, now));
  await verifyIdeaRuntimeDatabase(f.checked, f.config, startupConfig, now, { nativeQueue: true });
  await f.db.exec("SET SESSION AUTHORIZATION postgres; GRANT USAGE ON SCHEMA control_room_queue TO control_room_idea_runtime; SET SESSION AUTHORIZATION idea_runtime_test");
  await assert.rejects(verifyIdeaRuntimeDatabase(f.checked, f.config, startupConfig, now, { nativeQueue: true }));
});
