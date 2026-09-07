import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { startupConfig } from "./helpers/web-startup";
import type { DatabaseClient } from "../src/persistence/database";
import { verifyNewsIngestionDatabase, verifyIdeaRuntimeDatabase } from "../src/web/v1/private-database-preflight";
import { AbsFeedIngestionService } from "../src/project-adapters/abs-news/v1/feed-ingestion";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { AbsControlCenterIngestion } from "../src/project-adapters/abs-news/v1/control-center-ingestion";

async function setup() {
  const f = await taskFixture();
  await f.db.exec(await readFile("db/roles/news_ingestion_roles.sql", "utf8"));
  await f.db.exec(`CREATE ROLE news_ingestion_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_news_ingestion TO news_ingestion_test;
    SET SESSION AUTHORIZATION news_ingestion_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  // Existing PGlite-only TEMP metadata exception; actual production checks remain strict.
  const checked: DatabaseClient = { ...f.client, query: f.client.query.bind(f.client), transaction: work => f.client.transaction(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
      return result;
    },
  })), transactionWithPreCommitCheck: f.client.transactionWithPreCommitCheck.bind(f.client) };
  return { ...f, checked, config: { ...startupConfig.database, username: "news_ingestion_test" } };
}
test("exact news ingestion role retains source and article data without project or agent authority", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await assert.rejects(verifyNewsIngestionDatabase(f.client, f.config, startupConfig, now));
  await verifyNewsIngestionDatabase(f.checked, f.config, startupConfig, now);
  await f.client.query("SELECT * FROM control_abs_source_settings");
  await assert.rejects(f.client.query("INSERT INTO control_abs_source_settings SELECT * FROM control_abs_source_settings"), /permission denied/);
  await assert.rejects(verifyIdeaRuntimeDatabase(f.checked, f.config, startupConfig, now));
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId }, key = new Uint8Array(32).fill(59);
  const service = new AbsFeedIngestionService(f.client, { ...scope, source: { sourceId: "source:example", sourceLabel: "Example", sourceKind: "rss", endpointUrl: "https://example.org/feed" }, maxItems: 10, maxBytes: 10000 }, key);
  const xml = '<rss version="2.0"><channel><title>News</title><item><title>Role check</title><link>https://example.org/story</link></item></channel></rss>';
  const at = new Date(now).toISOString();
  assert.equal((await service.ingest(xml, at)).inserted, 1);
  assert.equal((await service.ingest(xml, at)).replayed, 1);
  const store = new PostgresAbsNewsStoreV1(f.client, scope, key);
  assert.equal((await store.listStories()).stories.length, 1); assert.equal((await store.listSourceStatuses()).statuses.length, 1);
  const source = { id: "source:borrowed", name: "Example", url: "https://example.org/feed" };
  const borrowed = new AbsControlCenterIngestion(f.client, { ...scope, source }, key);
  const snapshot = { sourceUrl: source.url, endpoint: source.url, urls: {}, checkedAt: at, mode: "feed" as const };
  await borrowed.ingest({ sourceUrl: source.url, coverageComplete: true, feedKind: "rss", snapshot, items: [],
    status: { sourceId: source.id, source: source.name, mode: "feed", endpoint: source.url } }, at);
  assert.deepEqual(await borrowed.loadBaseline(), snapshot);
  await assert.rejects(f.client.query("DELETE FROM control_abs_discovery_baselines"), /permission denied/);
  for (const table of ["projects", "control_jobs", "control_outbox", "control_abs_research_proposals", "control_idea_sessions", "control_role_grants", "audit_events"])
    await assert.rejects(f.client.query(`INSERT INTO ${table} DEFAULT VALUES`), /permission denied/);
  for (const sql of ["UPDATE projects SET domain_state='{}'::jsonb", "UPDATE control_role_grants SET revoked_at=NULL",
    "UPDATE control_abs_story_versions SET payload='{}'::jsonb", "DELETE FROM control_abs_source_observations"])
    await assert.rejects(f.client.query(sql), /permission denied/);
});
test("ingestion preflight rejects extra dispatch rights and missing source insertion rights", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await verifyNewsIngestionDatabase(f.checked, f.config, startupConfig, now);
  await f.db.exec("SET SESSION AUTHORIZATION postgres; GRANT INSERT ON control_jobs TO control_room_news_ingestion; SET SESSION AUTHORIZATION news_ingestion_test");
  await assert.rejects(verifyNewsIngestionDatabase(f.checked, f.config, startupConfig, now));
  await f.db.exec("SET SESSION AUTHORIZATION postgres; REVOKE INSERT ON control_jobs FROM control_room_news_ingestion; REVOKE INSERT ON control_abs_source_observations FROM control_room_news_ingestion; SET SESSION AUTHORIZATION news_ingestion_test");
  await assert.rejects(verifyNewsIngestionDatabase(f.checked, f.config, startupConfig, now));
});

test("ingestion can coexist with the queue but cannot inherit its permissions", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await f.db.exec(`SET SESSION AUTHORIZATION postgres;
    CREATE SCHEMA control_room_queue; CREATE TABLE control_room_queue.version(version integer);
    CREATE TABLE control_room_queue.queue(name text); CREATE TABLE control_room_queue.job(id text);
    CREATE TABLE control_room_queue.job_common(id text); REVOKE ALL ON SCHEMA control_room_queue FROM PUBLIC;
    SET SESSION AUTHORIZATION news_ingestion_test`);
  await assert.rejects(verifyNewsIngestionDatabase(f.checked, f.config, startupConfig, now));
  await verifyNewsIngestionDatabase(f.checked, f.config, startupConfig, now, { nativeQueue: true });
  await f.db.exec("SET SESSION AUTHORIZATION postgres; GRANT USAGE ON SCHEMA control_room_queue TO control_room_news_ingestion; SET SESSION AUTHORIZATION news_ingestion_test");
  await assert.rejects(verifyNewsIngestionDatabase(f.checked, f.config, startupConfig, now, { nativeQueue: true }));
});
