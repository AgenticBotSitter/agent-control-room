import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { seedWebIdea, webIdeaKey } from "./helpers/web-idea-project";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup";
import { now, request } from "./helpers/web-foundation";
import { WebIdeaService } from "../src/web/v1/idea-service";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
test("interleaved statement visibility cannot return a synthesis or decision without its matching dependencies", async t => {
  const f = await taskFixture(); t.after(() => f.db.close()); await seedWebIdea(f.client);
  for (const table of ["control_idea_syntheses", "control_idea_contributions"]) {
    let reads = 0;
    const wrap = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      // Model a record that was not visible to the first statement but committed
      // before later getter statements. PGlite does not provide real concurrent PG evidence.
      if (sql.includes(`FROM ${table} `) && ++reads === 1) return { rows: [] as T[] };
      return result;
    } });
    const db: DatabaseClient = { query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
      transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
    await assert.rejects(new WebIdeaService(db, scope, webIdeaKey, () => now).detail(f.identity, "idea:project.idea:web"));
    assert.ok(reads > 1);
  }
});
test("private Idea reads return retained discussions and decisions, never substitute a panel run", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const seed = await seedWebIdea(f.client), id = "idea:project.idea:web";
  const service = new WebIdeaService(f.client, scope, webIdeaKey, () => now);
  const page = await service.list(f.identity);
  assert.equal(page.sessions.length, 1); assert.equal(page.sessions[0].sessionId, id);
  assert.equal(page.execution, "not_configured");
  const detail = await service.detail(f.identity, id);
  assert.equal(detail.contributions.length, 4); assert.ok(detail.synthesis);
  assert.equal(detail.decision?.project?.projectId, seed.project.projectId);
  assert.equal(detail.execution, "not_configured");
  const restarted = new WebIdeaService(f.client, scope, webIdeaKey, () => now);
  assert.deepEqual(await restarted.detail(f.identity, id), detail);
  const unavailable = await new WebIdeaService(f.client, scope, undefined, () => now).list(f.identity);
  assert.equal(unavailable.availability, "not_configured"); assert.equal(unavailable.sessions.length, 0);
  await assert.rejects(new WebIdeaService(f.client, { ...scope, workspaceId: "workspace:other" }, webIdeaKey, () => now).detail(f.identity, id), /not_found/);
  await assert.rejects(new WebIdeaService(f.client, scope, new Uint8Array(32), () => now).detail(f.identity, id));
  await f.client.query("UPDATE control_role_grants SET role_key='operator'");
  await assert.rejects(service.list(f.identity), /access_denied/);
  await assert.rejects(service.detail(f.identity, id), /access_denied/);
  await f.client.query("UPDATE control_role_grants SET role_key='owner'");
  await f.client.query("UPDATE control_role_grants SET revoked_at=$1", [new Date(now).toISOString()]);
  await assert.rejects(service.list(f.identity), /access_denied/);
  await assert.rejects(service.detail(f.identity, id), /access_denied/);
});

test("private Idea catalog pages include every retained session exactly once", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const { store } = await seedWebIdea(f.client);
  const source = (await store.getSession(scope.tenantId, "idea:project.idea:web"))!;
  for (let i = 0; i < 51; i++) await store.registerSession(buildIdeaLabSessionV1({
    ...scope, sessionId: `idea:page:${String(i).padStart(3, "0")}`, title: source.title,
    ideaSummary: source.ideaSummary, targetCustomer: source.targetCustomer, participants: source.participants,
    maxRounds: source.maxRounds, maxDurationSeconds: source.maxDurationSeconds, maxCostUsd: source.maxCostUsd,
    createdByIdentityDigest: source.createdByIdentityDigest, createdAt: source.createdAt,
  }));
  const service = new WebIdeaService(f.client, scope, webIdeaKey, () => now);
  const first = await service.list(f.identity), last = await service.list(f.identity, first.nextCursor!);
  assert.equal(first.sessions.length, 50); assert.equal(last.sessions.length, 2); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.sessions, ...last.sessions].map(s => s.sessionId)).size, 52);
});

test("restricted private Idea HTTP reads work without any Idea write permissions", async t => {
  const f = await limitedWebFixture();
  const app = createPrivateWebProcess({ ...startupConfig, database: f.pool, clock: () => now });
  t.after(() => app.close());
  const handle = (req: Request) => app.handle(req, () => new Response("shell"));
  const path = "/api/v1/ideas", detail = path + "/idea%3Aproject.idea%3Aweb";
  const list = await handle(request(path)); assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.equal((await handle(request(detail))).status, 200);
  for (const url of [path + "?after=x&after=y", detail + "?after=idea:one", path + "?unexpected=1"])
    assert.equal((await handle(request(url))).status, 400);
  assert.equal((await handle(request(path, "POST", {}))).status, 400);
  assert.equal((await handle(request(path + "/idea:missing"))).status, 404);
  const anonymous = request(detail); anonymous.headers.delete("cf-access-jwt-assertion");
  assert.equal((await handle(anonymous)).status, 401);
  for (const table of ["control_idea_sessions", "control_idea_contributions", "control_idea_syntheses", "control_idea_decisions"]) {
    await assert.rejects(f.client.query(`INSERT INTO ${table} DEFAULT VALUES`));
    await assert.rejects(f.client.query(`DELETE FROM ${table}`));
  }
  assert.equal((await handle(request("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handle(request(detail))).status, 401);
});
