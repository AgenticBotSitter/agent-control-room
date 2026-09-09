// Explicit disposable local fixture; never attaches to an existing database.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { SecurityStore } from "../src/security/security-store";
import { WebProjectService } from "../src/web/v1/project-service";
import { WebTaskService } from "../src/web/v1/task-service";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Pool, Client } from "pg";
import { createRehearsalProbe, createPgRehearsalTransport } from "../src/web/v1/private-rehearsal-probe";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createPrivatePgDriver } from "../src/web/v1/private-pg-driver";
import { qualifyPrivatePgSession } from "../src/web/v1/private-pg-qualification";
import { boundPrivateDatabase } from "../src/web/v1/bounded-database";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { articleStory } from "../tests/helpers/article-fixture";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { PostgresArticleDetails } from "../src/project-adapters/abs-news/v1/article-store";
import { readNewsArticleDetail } from "../src/project-adapters/abs-news/v1/article-detail";

const bin = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "supply the reviewed PostgreSQL 17 bin directory");
const exec = promisify(execFile);
const run = await mkdtemp(join(tmpdir(), "cr-driver-pg17-"));
const data = join(run, "data"), socket = join(run, "socket");
await mkdir(socket, { mode: 0o700 });
const native = (name: string, args: string[]) => exec(join(bin, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 20000 });
let attempted = false, stopped = false;
let db: ReturnType<typeof boundPrivateDatabase> | undefined;
let boss: PgBoss | undefined;
let queueFault = false;
try {
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "fixture_user", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
  attempted = true;
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "10", "-o",
    `-k ${socket} -p 65435 -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c shared_preload_libraries=''`, "start"]);
  const options = privatePgOptions({ host: "127.0.0.1", port: 65435, database: "postgres",
    username: "fixture_user", password: "fixture_only", majorVersion: 17 });
  // Test-only socket override; production still permits loopback TCP only.
  const pool = new Pool({ ...options, host: socket });
  pool.on("connect", client => {
    const query = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      const result = Reflect.apply(query, undefined, args);
      if (result && typeof result.catch === "function") return result.catch((error: { code?: string; constraint?: string }) => {
        console.log(JSON.stringify({ fixtureSqlFailure: error.code ?? "unknown", constraint: error.constraint })); throw error;
      });
      return result;
    }) as typeof client.query;
  });
  db = bindPrivatePgPool(pool);
  pool.on("error", () => { void db?.close().catch(() => {}); });
  assert.equal((await db.client.query<{ listen_addresses: string }>("SHOW listen_addresses")).rows[0].listen_addresses, "");
  await db.client.query("CREATE TABLE public.fixture_values (id uuid PRIMARY KEY, body jsonb, tags text[])");
  const id = "00000000-0000-4000-8000-000000000001";
  await db.client.transactionWithPreCommitCheck(async session => {
    await session.query("INSERT INTO fixture_values VALUES ($1, $2, $3)", [id, { value: 7 }, ["a", "b"]]);
  }, () => {});
  assert.deepEqual((await db.client.query("SELECT * FROM fixture_values WHERE id=$1", [id])).rows,
    [{ id, body: { value: 7 }, tags: ["a", "b"] }]);
  await assert.rejects(db.client.transactionWithPreCommitCheck(async session => {
    await session.query("DELETE FROM fixture_values");
  }, () => { throw new Error("synthetic refusal"); }), /synthetic refusal/);
  assert.equal((await db.client.query<{ n: number }>("SELECT count(*)::int AS n FROM fixture_values")).rows[0].n, 1);
  // Schema installation is fixture-owned, not a production worker permission.
  await pool.query(getConstructionPlans("fixture_queue"));
  boss = new PgBoss({ db: { executeSql: (sql, values) => db!.client.query(sql, values) },
    schema: "fixture_queue", migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false });
  boss.on("error", () => { queueFault = true; });
  await boss.start();
  await boss.createQueue("fixture_task", { retryLimit: 0 });
  const jobId = await boss.send("fixture_task", { task: "synthetic", version: 1 });
  assert.ok(jobId);
  const jobs = await boss.fetch("fixture_task");
  assert.equal(jobs.length, 1); assert.equal(jobs[0].id, jobId);
  assert.deepEqual(jobs[0].data, { task: "synthetic", version: 1 });
  await boss.complete("fixture_task", jobId, { review: "pending" });
  const stored = await boss.getJobById("fixture_task", jobId);
  assert.equal(stored?.state, "completed");
  assert.deepEqual(stored?.output, { review: "pending" });
  assert.equal((await boss.fetch("fixture_task")).length, 0);
  assert.equal(queueFault, false);
  const installer = new Client({ ...options, host: socket });
  try {
    await installer.connect(); await installer.query("SET search_path=public");
    for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort())
      await installer.query(await readFile(join("db/migrations", file), "utf8"));
  } finally { await installer.end(); }
  const now = Date.parse("2026-09-08T12:00:00Z");
  const identity = { provider: "https://fixture.invalid", subject: "fixture-owner", tokenDigest: `sha256:${"a".repeat(64)}`,
    issuedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 300000).toISOString(),
    verificationExpiresAt: new Date(now + 300000).toISOString() };
  await db.client.query("INSERT INTO tenants(id,display_name) VALUES('tenant:pg','Synthetic')");
  await db.client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:pg','tenant:pg','Synthetic')");
  await new SecurityStore(db.client).bootstrapOwner({ tenantId: "tenant:pg", provider: identity.provider,
    subject: identity.subject, identityId: "identity:pg", grantId: "grant:pg", displayName: "Synthetic",
    verifiedAt: identity.issuedAt, expiresAt: identity.expiresAt, now: new Date(now).toISOString() });
  const projects = new WebProjectService(db.client, { tenantId: "tenant:pg", workspaceId: "workspace:pg" }, () => now);
  const input = { title: "PG17 project", summary: "Disposable integration" };
  const created = await projects.create(identity, input, "synthetic-project-key");
  const replay = await projects.create(identity, input, "synthetic-project-key");
  assert.equal(replay.replayed, true); assert.deepEqual(replay.project, created.project);
  assert.equal((await projects.list(identity)).length, 1);
  await assert.rejects(projects.create(identity, { ...input, title: "Changed" }, "synthetic-project-key"), { message: "conflict" });
  const scope = { tenantId: "tenant:pg", workspaceId: "workspace:pg" };
  const articleScope = { ...scope, projectId: created.project.projectId }, articleKey = new Uint8Array(32).fill(9);
  const article = articleStory(articleScope), articleStories = new PostgresAbsNewsStoreV1(db.client, articleScope, articleKey);
  await articleStories.saveStory(article);
  const html = `<article><p>${"Synthetic PG17 article content for reading. ".repeat(80)}</p></article>`;
  const detail = await readNewsArticleDetail({ ...articleScope, storyId: article.storyId, storyDigest: article.storyDigest }, {
    getStory: id => articleStories.getStory(id), authority: { assertCurrent: () => undefined },
    reader: { read: async () => ({ text: html, byteCount: Buffer.byteLength(html), endpointUrl: article.canonicalUrl, contentType: "text/html" }) },
  }, new AbortController().signal);
  assert.equal(detail.status, "extracted"); if (detail.status !== "extracted") throw new Error("article fixture failed");
  const articleStore = new PostgresArticleDetails(db.client, articleScope, articleKey);
  assert.equal((await articleStore.save(detail)).replayed, false);
  assert.equal((await articleStore.save(detail)).replayed, true);
  assert.deepEqual(await articleStore.get(article.storyId, article.storyDigest, detail.detailDigest), detail);
  // A dedicated fixture login can read retained articles but cannot write them.
  await pool.query("CREATE ROLE fixture_article_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  await pool.query("GRANT USAGE ON SCHEMA public TO fixture_article_reader");
  await pool.query("GRANT SELECT ON control_abs_article_details TO fixture_article_reader");
  const articleReader = new Client({ ...options, host: socket, user: "fixture_article_reader" });
  try {
    await articleReader.connect();
    assert.equal((await articleReader.query("SELECT count(*)::int AS n FROM control_abs_article_details")).rows[0].n, 1);
    for (const sql of ["DELETE FROM control_abs_article_details", "UPDATE control_abs_article_details SET auth_tag=auth_tag", "TRUNCATE control_abs_article_details",
      "INSERT INTO control_abs_article_details SELECT * FROM control_abs_article_details"])
      await assert.rejects(articleReader.query(sql), { code: "42501" });
  } finally { await articleReader.end(); }
  console.log(JSON.stringify({ articleStorage: "passed", articleReaderPermissions: "passed" }));
  const tasks = new WebTaskService(db.client, scope, () => now);
  const draft = { title: "Synthetic task", instructions: "Read the synthetic fixture only." };
  const proposed = await tasks.propose(identity, created.project.projectId, draft, "synthetic-task-key");
  const again = await tasks.propose(identity, created.project.projectId, draft, "synthetic-task-key");
  assert.equal(again.replayed, true); assert.deepEqual(again.receipt, proposed.receipt);
  assert.equal(proposed.receipt.startsWork, false);
  const before = await tasks.detail(identity, created.project.projectId, proposed.receipt.jobId);
  const reconstructed = bindPrivatePgPool(new Pool({ ...options, host: socket }));
  try {
    const freshService = new WebTaskService(reconstructed.client, scope, () => now);
    assert.deepEqual(await freshService.detail(identity, created.project.projectId, proposed.receipt.jobId), before);
    assert.equal((await freshService.list(identity, created.project.projectId)).tasks.length, 1);
  } finally { await reconstructed.close(); }
  const probe = createRehearsalProbe({ host: "127.0.0.1", port: 65435, database: "postgres",
    username: "fixture_user", password: "fixture_only", majorVersion: 17 }, "a", probeOptions =>
    createPgRehearsalTransport(new Client({ ...options, host: socket }), probeOptions.onclose));
  try {
    const first = (await probe.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await probe.query("SET statement_timeout='20ms'");
    await assert.rejects(probe.query("SELECT pg_sleep(1)"), { message: "57014" });
    assert.equal((await probe.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid, first);
  } finally { await probe.close(); }
  assert.equal(probe.isClosed(), true);
  await pool.query("CREATE ROLE fixture_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  await pool.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await pool.query("GRANT USAGE ON SCHEMA public TO fixture_reader");
  await pool.query("GRANT SELECT ON public.fixture_values TO fixture_reader");
  for (const denied of ["DELETE FROM public.fixture_values", "CREATE TABLE public.forbidden (id int)"]) {
    const restrictedPool = new Pool({ ...options, host: socket, user: "fixture_reader" });
    const restricted = bindPrivatePgPool(restrictedPool);
    restrictedPool.on("error", () => { void restricted.close().catch(() => {}); });
    try {
      assert.equal((await restricted.client.query<{ n: number }>("SELECT count(*)::int AS n FROM public.fixture_values")).rows[0].n, 1);
      await assert.rejects(restricted.client.query(denied), { message: "database_outcome_uncertain" });
      assert.equal(restricted.isAvailable(), false);
    } finally { await restricted.close(); }
  }
  assert.equal((await db.client.query<{ n: number }>("SELECT count(*)::int AS n FROM public.fixture_values")).rows[0].n, 1);
  const interrupted = bindPrivatePgPool(new Pool({ ...options, host: socket }));
  let entered!: (pid: number) => void;
  let resume!: () => void;
  const ready = new Promise<number>(resolve => { entered = resolve; });
  const callbackWait = new Promise<void>(resolve => { resume = resolve; });
  const operation = interrupted.client.transaction(async session => {
    const pid = (await session.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    entered(pid); await callbackWait;
  });
  const rejected = assert.rejects(operation);
  try {
    const pid = await ready;
    // Only the backend just acquired from this owned fixture is terminated.
    assert.equal((await pool.query("SELECT pg_terminate_backend($1) AS stopped", [pid])).rows[0].stopped, true);
    await rejected;
    assert.equal(interrupted.isAvailable(), false);
  } finally { resume(); await interrupted.close(); }
  console.log(JSON.stringify({ pg17: true, tcpDisabled: true, qualification: true, values: true, preCommitRollback: true, queueRoundTrip: true, restrictedReadAndDeniedWrites: true, checkedOutDisconnect: true }));
} finally {
  try { try { await boss?.stop({ graceful: false }); } finally { await db?.close(); } }
  finally {
    if (attempted) {
      await native("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "10", "stop"]);
      stopped = true;
    }
    if (!attempted || stopped) await rm(run, { recursive: true });
    console.log(JSON.stringify({ cleanup: !attempted || stopped }));
  }
}
