import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { taskStartupFixture } from "./helpers/task-startup";
import { createPrivateTaskBootstrap } from "../src/web/v1/private-task-startup";
import type { PrivateApplication } from "../src/web/v1/private-process";
import { instant } from "./hermes-native-fixture";
import { request } from "./helpers/web-foundation";
import { PostgresNewsSourceSettings } from "../src/project-adapters/abs-news/v1/source-settings";

test("news startup verifies separate roles, mounts source options and owns shutdown", async t => {
  for (const mode of ["success", "preflight", "producer", "worker", "install"] as const) await t.test(mode, async t => {
  const f = await taskStartupFixture(); t.after(f.close);
  for (const path of ["db/roles/news_coordinator_roles.sql", "db/roles/news_ingestion_roles.sql"])
    await f.raw.exec(await readFile(path, "utf8"));
  await f.raw.exec(`CREATE ROLE news_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ingestion_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_news_coordinator TO news_test; GRANT control_room_news_ingestion TO ingestion_test;
    CREATE SCHEMA control_room_queue;
    CREATE TABLE control_room_queue.version(version integer);
    CREATE TABLE control_room_queue.queue(name text);
    CREATE TABLE control_room_queue.job(id text);
    CREATE TABLE control_room_queue.job_common(id text);
    REVOKE ALL ON SCHEMA control_room_queue FROM PUBLIC;
    GRANT USAGE ON SCHEMA control_room_queue TO control_room_news_coordinator;
    GRANT SELECT ON ALL TABLES IN SCHEMA control_room_queue TO control_room_news_coordinator;
    GRANT INSERT ON control_room_queue.job,control_room_queue.job_common TO control_room_news_coordinator;
    GRANT UPDATE(name) ON control_room_queue.queue TO control_room_news_coordinator;`);
  const coordinator = f.pool("news_test"), ingestion = f.pool("ingestion_test"), key = new Uint8Array(32).fill(67);
  const scope = { ...f.scope, projectId: f.prepared.receipt.projectId };
  const source = { id: "source:startup", name: "Startup source", url: "https://example.org/news", enabled: true };
  await new PostgresNewsSourceSettings(f.db, scope, key).save(source, 0, new Date(instant + 8000).toISOString());
  const news = { configuration: { ...f.scope, assignments: [{ configuration: { ...scope,
    source: { sourceId: source.id, sourceLabel: source.name, sourceKind: "discovery", endpointUrl: source.url },
    expectedRevision: 1, allowedOrigins: ["https://example.org/"],
    limits: { timeoutMs: 1000, maxAttempts: 2, maxDocumentBytes: 4096, maxReservedBodyBytes: 8192 } },
  nodeId: "node:news", executorId: "executor:news", windowSeconds: 300 }] },
  coordinatorDatabase: { ...f.config.web.database, username: "news_test" },
  ingestionDatabase: { ...f.config.web.database, username: "ingestion_test" },
  workerDatabase: { ...f.config.web.database, username: "news_worker_test" }, integrityKey: key,
  authority: { assertCurrent() { return undefined; } }, transport: { lookup: async () => { throw new Error("no live DNS"); }, fetch: async () => { throw new Error("no live HTTP"); } } };
  let installed: PrivateApplication | undefined; const calls: string[] = [];
  class Producer {
    #closed = false;
    async enqueueInSession() { assert.equal(this.#closed, false); throw new Error("unused submission"); }
    async close() { assert.equal(this.#closed, false); this.#closed = true;
      calls.push("producer-close"); assert.equal(coordinator.closes(), 0); }
  }
  class Worker {
    #accepting = true;
    status() { return { accepting: this.#accepting }; }
    async close() { assert.equal(this.#accepting, true); this.#accepting = false;
      calls.push("worker-close"); assert.equal(ingestion.closes(), 0); }
  }
  const deps = { clock: () => instant + 8000,
    openDatabase: (db: { username: string }) => db.username === "news_test" ? coordinator : db.username === "ingestion_test" ? ingestion : f.openDatabase(db),
    install: (app: PrivateApplication) => { installed = app; if (mode === "install") throw new Error("synthetic install failure"); },
    prepareNewsSubmission: async () => { if (mode === "producer") throw new Error("synthetic factory failure");
      return new Producer(); },
    startNewsWorker: async () => { assert.equal(installed, undefined); if (mode === "worker") throw new Error("synthetic worker failure");
      return new Worker(); },
  };
  const input = { ...f.config, web: { ...f.config.web, news: { integrityKey: key } }, news };
  let invalidOpens = 0;
  await assert.rejects(createPrivateTaskBootstrap({ ...deps, openDatabase: () => { invalidOpens++; throw new Error(); } })
    .start({ ...input, news: { ...news, ingestionDatabase: news.coordinatorDatabase } }), /config_invalid/);
  assert.equal(invalidOpens, 0);
  if (mode === "preflight") await f.raw.exec("REVOKE SELECT ON control_abs_source_settings FROM control_room_news_ingestion");
  if (mode !== "success") {
    await assert.rejects(createPrivateTaskBootstrap(deps).start(input),
      mode === "producer" || mode === "worker" ? /cleanup_uncertain/ : /prerequisites_failed/);
    assert.deepEqual(calls, mode === "install" ? ["worker-close", "producer-close"] : mode === "worker" ? ["producer-close"] : []);
    assert.equal(coordinator.closes(), 1); assert.equal(ingestion.closes(), 1);
    assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
    return;
  }
  const runtime = await createPrivateTaskBootstrap(deps).start(input);
  t.after(() => runtime.close()); assert.equal(runtime.isReady(), true);
  const response = await installed!.handle(request(`/api/v1/projects/${encodeURIComponent(scope.projectId)}/news/sources/source%3Astartup/collection`, "GET", undefined, undefined, f.jwt), () => new Response("shell"));
  assert.equal(response.status, 200); assert.equal((await response.json()).configured, true);
  await assert.rejects(ingestion.client.query("SELECT * FROM control_abs_feed_plans"));
  await runtime.close(); assert.deepEqual(calls, ["worker-close", "producer-close"]);
  assert.equal(coordinator.closes(), 1); assert.equal(ingestion.closes(), 1);
  assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
  });
});
