import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { startupConfig } from "./helpers/web-startup";
import { verifyNewsCoordinatorDatabase } from "../src/web/v1/private-database-preflight";
import { taskFixture } from "./helpers/web-task";
import { now, origin, trust, request } from "./helpers/web-foundation";
import { createNewsCollectionHttpHandler } from "../src/web/v1/news-collection-http";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { DOMAIN_CONTRACT_VERSION } from "../src/domain/v1";
import { sha256Digest } from "../src/security";
import { WebNewsCollectionPlanning } from "../src/web/v1/news-collection-planning";
import { WebNewsCollectionAdmission } from "../src/web/v1/news-collection-admission";
import { WebProjectService } from "../src/web/v1/project-service";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { AbsFeedJobReference } from "../src/persistence/pg-boss-abs-feed-worker";
import { createAbsFeedJobExecution } from "../src/project-adapters/abs-news/v1/feed-job-execution";
import { AbsFeedIngestionService } from "../src/project-adapters/abs-news/v1/feed-ingestion";
import { PostgresNewsSourceSettings } from "../src/project-adapters/abs-news/v1/source-settings";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createNewsRefreshClient } from "../src/web/v1/news-refresh-client";

// Routing evidence only: real restricted-login qualification has separate tests.
function ingestionClient(db: DatabaseClient): DatabaseClient {
  const session = (tx: DatabaseSession): DatabaseSession => ({ query<T>(sql: string, values?: unknown[]) {
    assert.doesNotMatch(sql, /control_(?:jobs|attempts|leases|approvals|effect_intents|policy_decisions|abs_feed_plans)/);
    return tx.query<T>(sql, values);
  } });
  return { ...session(db), transaction: work => db.transaction(tx => work(session(tx))),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
}

async function fixture() {
  let current = now, failQueue = false, expireQueue = false;
  const f = await taskFixture(() => current), key = new Uint8Array(32).fill(67);
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId, nodeId: "node:feed", executorId: "executor:feed" };
  const template = { configuration: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId,
    source: { sourceId: "source:feed", sourceLabel: "Example news", sourceKind: "rss", endpointUrl: "https://example.org/feed" },
    maxBytes: 10000, maxItems: 25, timeoutMs: 10000 }, executorId: scope.executorId, windowSeconds: 300 };
  const planner = new WebNewsCollectionPlanning(f.client, template, key, () => current);
  const plan = await planner.propose(f.identity, { sourceDigest: planner.sourceDigest, idempotencyKey: "admission-plan-0001" });
  const canonical = new CanonicalStore(f.client), instant = new Date(now).toISOString();
  await canonical.create({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: scope.nodeId, tenantId: scope.tenantId,
    displayName: "Disposable collector", state: "pending_enrollment", platform: "linux", architecture: "x64", identityKeyId: "key:synthetic",
    hardwareFingerprint: sha256Digest("hardware"), softwareFingerprint: sha256Digest("software"), policyVersion: "1.0.0",
    minimumProtocolVersion: "control-room-node/v1", version: 0, createdAt: instant, updatedAt: instant });
  await canonical.transition({ tenantId: scope.tenantId, kind: "node", entityId: scope.nodeId, expectedVersion: 0, toState: "active",
    transitionId: "transition:feed-node-active", idempotencyKey: "feed-node-active-001", actor: { actorId: "identity:web", actorType: "human" },
    occurredAt: instant, recordPatch: { enrolledAt: instant } });
  await f.client.query("CREATE TABLE synthetic_feed_queue(reference jsonb NOT NULL)");
  const submission = { async enqueueInSession(tx: DatabaseSession, reference: AbsFeedJobReference) {
    await tx.query("INSERT INTO synthetic_feed_queue VALUES($1)", [reference]);
    if (expireQueue) current += 61_000; if (failQueue) throw new Error("synthetic queue failure");
  } };
  const service = new WebNewsCollectionAdmission(f.client, scope, key, submission, () => current);
  return { ...f, scope, key, plan, planner, service, submission, clock: () => current, setTime: (value: number) => { current = value; },
    failQueue: () => { failQueue = true; }, expireQueue: () => { expireQueue = true; },
    args: { jobId: plan.jobId, inputDigest: plan.inputDigest } };
}
test("owner approval, assignment, effect authorization and queue entry commit once", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const results = await Promise.all([f.service.approve(f.identity, f.args), f.service.approve(f.identity, f.args)]);
  assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
  assert.equal(results[0].effectId, results[1].effectId); assert.equal(results[0].effectState, "authorized");
  for (const table of ["control_attempts", "control_leases", "control_approvals", "control_effect_intents", "control_approval_consumptions", "synthetic_feed_queue"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 1);
  assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "leased");
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='tasks.approve'")).rows.length, 1);
  await f.client.query("DELETE FROM synthetic_feed_queue");
  assert.equal((await f.service.approve(f.identity, f.args)).replayed, true);
  assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 0);
});

test("discovery approval and borrowed execution reuse queue claims and settlement without repeat reads", async t => {
  for (const mode of ["success", "disabled_before_approval", "disabled_before_execution", "disabled_during_read", "redirect_denied", "authority_revoked_at_commit"] as const)
    await t.test(mode, async () => {
      const f = await fixture();
      try {
        const projectScope = { tenantId: f.scope.tenantId, workspaceId: f.scope.workspaceId, projectId: f.scope.projectId };
        const settings = new PostgresNewsSourceSettings(f.client, projectScope, f.key);
        const source = { id: "source:discovery", name: "Example discovery", url: "https://example.org/news", enabled: true };
        const at = new Date(now).toISOString(); await settings.save(source, 0, at);
        const configuration = { ...projectScope,
          source: { sourceId: source.id, sourceLabel: source.name, sourceKind: "discovery", endpointUrl: source.url },
          expectedRevision: 1, allowedOrigins: ["https://example.org/", "https://feeds.example.org/"],
          limits: { timeoutMs: 10000, maxAttempts: 8, maxDocumentBytes: 4096, maxReservedBodyBytes: 32768 } };
        const planner = new WebNewsCollectionPlanning(f.client, { configuration, executorId: f.scope.executorId, windowSeconds: 300 }, f.key, f.clock);
        const admission = new WebNewsCollectionAdmission(f.client, f.scope, f.key, f.submission, f.clock, "discovery");
        const app = createPrivateWebProcess({ ...startupConfig, news: { integrityKey: f.key }, clock: f.clock,
          database: { client: f.client, close: async () => {} }, newsCollections: [{ ...projectScope, sourceId: source.id, planning: planner, admission }] });
        t.after(() => app.close());
        const path = `/api/v1/projects/${encodeURIComponent(projectScope.projectId)}/news/sources/${encodeURIComponent(source.id)}/collection`;
        const handle = (req: Request) => app.handle(req, () => new Response("shell"));
        const descriptor = await handle(request(path));
        assert.equal(descriptor.status, 200); assert.equal(descriptor.headers.get("cache-control"), "no-store");
        const description = await descriptor.json();
        assert.equal(description.sourceDigest, planner.sourceDigest); assert.equal(description.canRefresh, true);
        assert.deepEqual(description.allowedOrigins, configuration.allowedOrigins);
        const anonymous = request(path); anonymous.headers.delete("cf-access-jwt-assertion");
        assert.equal((await handle(anonymous)).status, 401);
        assert.equal((await (await handle(request(path.replace(encodeURIComponent(source.id), "source%3Aunconfigured")))).json()).configured, false);
        const proposalInput = { sourceDigest: description.sourceDigest, idempotencyKey: "discovery-execution-001" };
        const proposed = await handle(request(`${path}/propose`, "POST", proposalInput)); assert.equal(proposed.status, 201);
        const plan = await proposed.json() as Awaited<ReturnType<typeof planner.propose>>;
        assert.equal((await handle(request(`${path}/propose`, "POST", proposalInput))).status, 200);
        if (mode === "success") {
          const other = { ...source, id: "source:other", name: "Other source" };
          await settings.save(other, 0, at);
          const otherPlanner = new WebNewsCollectionPlanning(f.client, { configuration: { ...configuration,
            source: { ...configuration.source, sourceId: other.id, sourceLabel: other.name } },
          executorId: f.scope.executorId, windowSeconds: 300 }, f.key, f.clock);
          const otherPlan = await otherPlanner.propose(f.identity, { sourceDigest: otherPlanner.sourceDigest, idempotencyKey: "other-discovery-001" });
          assert.equal((await handle(request(`${path}/approve`, "POST", { jobId: otherPlan.jobId, inputDigest: otherPlan.inputDigest }))).status, 409);
          for (const table of ["synthetic_feed_queue", "control_effect_intents", "control_approvals", "control_attempts"])
            assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
        }
        const args = { jobId: plan.jobId, inputDigest: plan.inputDigest };
        if (mode === "disabled_before_approval") {
          await settings.save({ ...source, enabled: false }, 1, at);
          assert.equal((await (await handle(request(path))).json()).canRefresh, false);
          assert.equal((await handle(request(`${path}/approve`, "POST", args))).status, 409);
          assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 0); return;
        }
        const approvalResponse = await handle(request(`${path}/approve`, "POST", args));
        assert.equal(approvalResponse.status, 201);
        const approved = await approvalResponse.json() as Awaited<ReturnType<typeof admission.approve>>;
        const replayResponse = await handle(request(`${path}/approve`, "POST", args));
        assert.equal(replayResponse.status, 200); assert.equal((await replayResponse.json()).replayed, true);
        if (mode === "success") {
          const browser = createNewsRefreshClient(projectScope.projectId, source.id, async (url, init) =>
            handle(request(String(url), init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined)));
          await browser.propose(await browser.describe(), "discovery-execution-001");
          await browser.approve();
          assert.equal(browser.state().submitted, true); assert.equal(browser.state().jobId, plan.jobId);
        }
        const queued = (await f.client.query<{ reference: AbsFeedJobReference }>("SELECT reference FROM synthetic_feed_queue")).rows;
        assert.equal(queued.length, 1);
        if (mode === "disabled_before_execution") await settings.save({ ...source, enabled: false }, 1, at);
        const fetched: string[] = [], resolved: string[] = [];
        let revoked = false;
        const ingestion = ingestionClient(f.client);
        const guarded: DatabaseClient = { ...ingestion,
          transactionWithPreCommitCheck: (work, check) => ingestion.transactionWithPreCommitCheck(work, async () => {
            if (mode === "authority_revoked_at_commit") revoked = true;
            await check();
          }) };
        const executor = createAbsFeedJobExecution({ coordinator: f.client, ingestion: guarded }, f.scope, f.key,
          { assertCurrent(url) { if (revoked) throw new Error("source_revoked"); assert.ok(configuration.allowedOrigins.includes(new URL(url).origin + "/")); } }, f.clock, undefined, {
            lookup: async host => { resolved.push(host); return [{ address: "8.8.8.8", family: 4 }]; },
            fetch: async url => {
              fetched.push(url.toString());
              if (mode === "disabled_during_read") await settings.save({ ...source, enabled: false }, 1, at);
              if (mode === "redirect_denied") return new Response(null, { status: 302, headers: { location: "https://unapproved.example.org/feed" } });
              return new Response(url.toString() === source.url
                ? '<html><head><link rel="alternate" type="application/rss+xml" href="https://feeds.example.org/?feed=rss"></head></html>'
                : `<rss><channel><item><title>AI model release</title><link>https://example.org/news/model</link><pubDate>${new Date(now - 1000).toUTCString()}</pubDate></item></channel></rss>`);
            },
          });
        if (mode === "disabled_before_execution") {
          await assert.rejects(executor.collect(queued[0].reference, new AbortController().signal), /unavailable/);
          assert.equal(fetched.length, 0); return;
        }
        const result = await executor.collect(queued[0].reference, new AbortController().signal);
        assert.equal(result.disposition, mode === "success" ? "delivered" : "held");
        const before = fetched.length;
        await assert.rejects(executor.collect(queued[0].reference, new AbortController().signal));
        assert.equal(fetched.length, before);
        assert.equal(resolved.includes("unapproved.example.org"), false);
        const stories = await new PostgresAbsNewsStoreV1(f.client, projectScope, f.key).listStories();
        assert.equal(stories.stories.length, mode === "success" ? 1 : 0);
        const effect = (await f.client.query<{ state: string }>("SELECT state FROM control_effect_intents WHERE id=$1", [approved.effectId])).rows[0];
        assert.equal(effect.state, mode === "success" ? "confirmed" : "ambiguous");
        if (mode === "success") {
          assert.deepEqual(fetched.slice(0, 2), [source.url, "https://feeds.example.org/?feed=rss"]);
          assert.ok(fetched.length <= configuration.limits.maxAttempts);
          assert.ok(fetched.every(url => configuration.allowedOrigins.includes(new URL(url).origin + "/")));
        }
      } finally { await f.db.close(); }
    });
});

test("collection HTTP admission requires owner authentication and exact protected route", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const handler = createNewsCollectionHttpHandler({ origin, trust, projectId: f.scope.projectId, admission: f.service,
    planning: f.planner, clock: f.clock });
  const path = `/api/v1/projects/${encodeURIComponent(f.scope.projectId)}/news/collection/approve`;
  const unauthenticated = request(path, "POST", f.args); unauthenticated.headers.delete("cf-access-jwt-assertion");
  assert.equal((await handler(unauthenticated)).status, 401);
  const foreign = request(path, "POST", f.args); foreign.headers.set("origin", "https://other.example.org");
  assert.equal((await handler(foreign)).status, 403);
  assert.equal((await handler(request(path + "?url=anything", "POST", f.args))).status, 400);
  assert.equal((await handler(request(path, "POST", { padding: "x".repeat(5000) }))).status, 400);
  assert.equal((await handler(request(path.replace(encodeURIComponent(f.scope.projectId), "project%3Aother"), "POST", f.args))).status, 404);
  assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 0);
  const first = await handler(request(path, "POST", f.args)); assert.equal(first.status, 201);
  assert.match(first.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await handler(request(path, "POST", f.args))).status, 200);
  assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 1);
  const proposalPath = path.replace(/approve$/, "propose"), input = { sourceDigest: f.planner.sourceDigest, idempotencyKey: "http-feed-proposal-002" };
  assert.equal((await handler(request(proposalPath, "POST", input))).status, 201);
  assert.equal((await handler(request(proposalPath, "POST", input))).status, 200);
  assert.equal((await f.client.query("SELECT * FROM control_jobs WHERE state='proposed'")).rows.length, 1);
  assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 1);
});

test("restricted coordinator role can plan approve start and settle but cannot write articles", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  // Remove this fixture's stand-in queue before exact schema fingerprint verification.
  await f.db.exec("DROP TABLE synthetic_feed_queue");
  await f.db.exec(await readFile("db/roles/news_coordinator_roles.sql", "utf8"));
  await f.db.exec(`CREATE ROLE news_coordinator_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_news_coordinator TO news_coordinator_test; SET SESSION AUTHORIZATION news_coordinator_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  const checked: DatabaseClient = { ...f.client, transaction: work => f.client.transaction(tx => work({ async query<T>(sql: string, params?: unknown[]) {
    const result = await tx.query<T>(sql, params);
    // PGlite-only TEMP metadata exception, not a production permission override.
    if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
    return result;
  } })) };
  const config = { ...startupConfig.database, username: "news_coordinator_test" };
  await assert.rejects(verifyNewsCoordinatorDatabase(f.client, config, startupConfig, now));
  await verifyNewsCoordinatorDatabase(checked, config, startupConfig, now);
  const plan = await f.planner.propose(f.identity, { sourceDigest: f.planner.sourceDigest, idempotencyKey: "restricted-news-plan-002" });
  let submissions = 0;
  const service = new WebNewsCollectionAdmission(f.client, f.scope, f.key, { async enqueueInSession() { submissions++; } }, f.clock);
  const receipt = await service.approve(f.identity, { jobId: plan.jobId, inputDigest: plan.inputDigest });
  assert.equal(submissions, 1); // No queue privilege is asserted by this injected submission.
  const store = new CanonicalStore(f.client);
  const marker = await store.beginAbsFeedAttempt({ ...f.scope, jobId: plan.jobId, inputDigest: plan.inputDigest,
    attemptId: receipt.attemptId, effectId: receipt.effectId, operationDigest: receipt.operationDigest }, f.clock);
  assert.equal((await store.settleAbsFeedAttempt({ tenantId: f.scope.tenantId, projectId: f.scope.projectId, jobId: plan.jobId,
    attemptId: receipt.attemptId, effectId: receipt.effectId, nodeId: f.scope.nodeId, markerDigest: marker.markerDigest, outcome: "ambiguous" }, f.clock)).effectState, "ambiguous");
  for (const table of ["control_abs_story_versions", "control_abs_source_observations", "projects", "control_role_grants", "control_native_task_queue"])
    await assert.rejects(f.client.query(`INSERT INTO ${table} DEFAULT VALUES`), /permission denied/);
  await f.db.exec("SET SESSION AUTHORIZATION postgres; GRANT INSERT ON control_abs_story_versions TO control_room_news_coordinator; SET SESSION AUTHORIZATION news_coordinator_test");
  await assert.rejects(verifyNewsCoordinatorDatabase(checked, config, startupConfig, now));
  await f.db.exec("SET SESSION AUTHORIZATION postgres; REVOKE INSERT ON control_abs_story_versions FROM control_room_news_coordinator; REVOKE INSERT ON control_abs_feed_plans FROM control_room_news_coordinator; SET SESSION AUTHORIZATION news_coordinator_test");
  await assert.rejects(verifyNewsCoordinatorDatabase(checked, config, startupConfig, now));
});
test("revoked owners, non-owner roles, paused projects and extra input cannot admit", async t => {
  for (const mode of ["revoked", "operator", "paused", "extra"]) await t.test(mode, async () => {
    const f = await fixture();
    try {
      if (mode === "revoked") await f.client.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:web'", [new Date(now).toISOString()]);
      if (mode === "operator") await f.client.query("UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'");
      if (mode === "paused") await new WebProjectService(f.client, { tenantId: f.scope.tenantId, workspaceId: f.scope.workspaceId }, f.clock)
        .transition(f.identity, f.scope.projectId, { lifecycle: "paused", expectedVersion: f.project.version }, "pause-feed-admission-001");
      await assert.rejects(f.service.approve(f.identity, mode === "extra" ? { ...f.args, endpointUrl: "https://other.example.org/feed" } : f.args));
      assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 0);
      assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "proposed");
    } finally { await f.db.close(); }
  });
});
test("failed queue write or elapsed admission deadline rolls back all admission records", async t => {
  for (const mode of ["queue", "deadline"]) await t.test(mode, async () => {
    const f = await fixture();
    try {
      if (mode === "queue") f.failQueue(); else f.expireQueue();
      await assert.rejects(f.service.approve(f.identity, f.args));
      for (const table of ["control_attempts", "control_leases", "control_approvals", "control_effect_intents", "control_approval_consumptions", "control_policy_decisions", "synthetic_feed_queue"])
        assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
      assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "proposed");
    } finally { await f.db.close(); }
  });
});
test("separate external-effect grant expiring during enqueue rolls back admission", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  let enqueued = false;
  await f.client.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at,expires_at)
    SELECT 'grant:feed-external',tenant_id,identity_id,role_key,'["approval.decide","effect.authorize"]'::jsonb,
      project_ids,risk_ceiling,true,false,created_at,updated_at,$1 FROM control_role_grants WHERE id='grant:web'`, [new Date(now + 10_000).toISOString()]);
  await f.client.query("UPDATE control_role_grants SET allow_external_effects=false WHERE id='grant:web'");
  const service = new WebNewsCollectionAdmission(f.client, f.scope, f.key, {
    async enqueueInSession(tx, reference) { await f.submission.enqueueInSession(tx, reference); enqueued = true; f.setTime(now + 11_000); }
  }, f.clock);
  await assert.rejects(service.approve(f.identity, f.args));
  assert.equal(enqueued, true);
  for (const table of ["control_attempts", "control_leases", "control_approvals", "control_effect_intents", "control_approval_consumptions", "control_policy_decisions", "synthetic_feed_queue"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
  assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "proposed");
});

test("canonical feed pre-effect marker starts once and survives a recreated store", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const receipt = await f.service.approve(f.identity, f.args);
  const input = { ...f.scope, ...f.args, attemptId: receipt.attemptId, effectId: receipt.effectId, operationDigest: receipt.operationDigest };
  const store = new CanonicalStore(f.client);
  const results = await Promise.allSettled([store.beginAbsFeedAttempt(input, f.clock), store.beginAbsFeedAttempt(input, f.clock)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  await assert.rejects(new CanonicalStore(f.client).beginAbsFeedAttempt(input, f.clock));
  assert.equal((await store.get(f.scope.tenantId, "job", receipt.jobId))?.state, "running");
  assert.equal((await store.get(f.scope.tenantId, "attempt", receipt.attemptId))?.state, "running");
  assert.equal((await store.get(f.scope.tenantId, "effect_intent", receipt.effectId))?.state, "executing");
  const markers = (await f.client.query("SELECT safe_metadata FROM control_transition_events WHERE to_state='executing'")).rows;
  assert.equal(markers.length, 1); assert.match(String((markers[0].safe_metadata as Record<string, unknown>).markerDigest), /^sha256:/);
});

test("feed outcomes settle atomically, replay exactly and never permit another start", async t => {
  for (const outcome of ["confirmed", "failed", "ambiguous", "late"] as const) await t.test(outcome, async () => {
    const f = await fixture();
    try {
      const receipt = await f.service.approve(f.identity, f.args), store = new CanonicalStore(f.client);
      const start = { ...f.scope, ...f.args, attemptId: receipt.attemptId, effectId: receipt.effectId, operationDigest: receipt.operationDigest };
      const marker = await store.beginAbsFeedAttempt(start, f.clock);
      if (outcome === "late") f.setTime(now + 61_000);
      const input = { tenantId: f.scope.tenantId, projectId: f.scope.projectId, jobId: receipt.jobId, attemptId: receipt.attemptId,
        effectId: receipt.effectId, nodeId: f.scope.nodeId, markerDigest: marker.markerDigest,
        outcome: outcome === "late" ? "confirmed" : outcome, ...(["confirmed", "late"].includes(outcome) ? { receiptDigest: sha256Digest("synthetic retained receipt") } : {}) };
      await assert.rejects(store.settleAbsFeedAttempt({ ...input, markerDigest: sha256Digest("wrong") }, f.clock));
      const result = await store.settleAbsFeedAttempt(input, f.clock);
      assert.equal(result.effectState, outcome === "late" ? "ambiguous" : outcome);
      assert.equal(result.replayed, false);
      assert.equal((await new CanonicalStore(f.client).settleAbsFeedAttempt(input, f.clock)).replayed, true);
      await assert.rejects(store.settleAbsFeedAttempt({ ...input, outcome: outcome === "failed" ? "ambiguous" : "failed", receiptDigest: undefined }, f.clock));
      await assert.rejects(store.beginAbsFeedAttempt(start, f.clock));
      const expected = outcome === "confirmed" ? "succeeded" : outcome === "failed" ? "failed" : "orphaned";
      assert.equal((await store.get(f.scope.tenantId, "job", receipt.jobId))?.state, expected);
      assert.equal((await store.get(f.scope.tenantId, "attempt", receipt.attemptId))?.state, expected);
      assert.equal((await f.client.query("SELECT state FROM control_leases WHERE attempt_id=$1", [receipt.attemptId])).rows[0].state, "released");
    } finally { await f.db.close(); }
  });
});

test("settlement write failure or deadline crossing cannot commit partial success", async t => {
  for (const mode of ["write", "deadline"]) await t.test(mode, async () => {
    const f = await fixture();
    try {
      const receipt = await f.service.approve(f.identity, f.args), store = new CanonicalStore(f.client);
      const marker = await store.beginAbsFeedAttempt({ ...f.scope, ...f.args, attemptId: receipt.attemptId,
        effectId: receipt.effectId, operationDigest: receipt.operationDigest }, f.clock);
      let releaseReached = false;
      const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, values?: unknown[]) {
        const result = await tx.query<T>(sql, values);
        if (sql.includes("UPDATE control_leases")) {
          releaseReached = true;
          if (mode === "write") throw new Error("synthetic release failure");
          f.setTime(now + 61_000);
        }
        return result;
      } });
      const db: DatabaseClient = { query: f.client.query.bind(f.client), transaction: work => f.client.transaction(tx => work(session(tx))),
        transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
      const input = { tenantId: f.scope.tenantId, projectId: f.scope.projectId, jobId: receipt.jobId, attemptId: receipt.attemptId,
        effectId: receipt.effectId, nodeId: f.scope.nodeId, markerDigest: marker.markerDigest, outcome: "confirmed", receiptDigest: sha256Digest("synthetic receipt") };
      await assert.rejects(new CanonicalStore(db).settleAbsFeedAttempt(input, f.clock));
      assert.equal(releaseReached, true);
      assert.equal((await store.get(f.scope.tenantId, "job", receipt.jobId))?.state, "running");
      assert.equal((await store.get(f.scope.tenantId, "attempt", receipt.attemptId))?.state, "running");
      assert.equal((await store.get(f.scope.tenantId, "effect_intent", receipt.effectId))?.state, "executing");
      assert.equal((await f.client.query("SELECT state FROM control_leases WHERE attempt_id=$1", [receipt.attemptId])).rows[0].state, "active");
      if (mode === "deadline") assert.equal((await store.settleAbsFeedAttempt(input, f.clock)).effectState, "ambiguous");
    } finally { await f.db.close(); }
  });
});

test("lease expiry preserves orphaned history when collection uncertainty is settled", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const receipt = await f.service.approve(f.identity, f.args), store = new CanonicalStore(f.client);
  const marker = await store.beginAbsFeedAttempt({ ...f.scope, ...f.args, attemptId: receipt.attemptId,
    effectId: receipt.effectId, operationDigest: receipt.operationDigest }, f.clock);
  const lease = (await f.client.query<{ id: string; epoch: number }>("SELECT id,epoch FROM control_leases WHERE attempt_id=$1", [receipt.attemptId])).rows[0];
  f.setTime(now + 61_000);
  await store.expireLease({ tenantId: f.scope.tenantId, jobId: receipt.jobId, attemptId: receipt.attemptId, leaseId: lease.id,
    epoch: lease.epoch, expectedLeaseVersion: 0,
    expectedJobVersion: (await store.get(f.scope.tenantId, "job", receipt.jobId))!.version,
    expectedAttemptVersion: (await store.get(f.scope.tenantId, "attempt", receipt.attemptId))!.version,
    transitionId: "transition:feed-expired-test", idempotencyKey: "feed-expired-test-001",
    actor: { actorId: f.scope.nodeId, actorType: "node" }, occurredAt: new Date(f.clock()).toISOString() });
  const result = await store.settleAbsFeedAttempt({ tenantId: f.scope.tenantId, projectId: f.scope.projectId, jobId: receipt.jobId,
    attemptId: receipt.attemptId, effectId: receipt.effectId, nodeId: f.scope.nodeId, markerDigest: marker.markerDigest,
    outcome: "ambiguous" }, f.clock);
  assert.equal(result.effectState, "ambiguous");
  assert.equal((await store.get(f.scope.tenantId, "job", receipt.jobId))?.state, "orphaned");
  assert.equal((await store.get(f.scope.tenantId, "attempt", receipt.attemptId))?.state, "orphaned");
  assert.equal((await store.get(f.scope.tenantId, "lease", lease.id))?.state, "expired");
});

test("owned feed execution binds approved plan, retained receipt and terminal job", async t => {
  for (const mode of ["success", "read_failure", "bad_receipt", "cleanup", "revoked"] as const) await t.test(mode, async () => {
    const f = await fixture();
    try {
      const approved = await f.service.approve(f.identity, f.args);
      const { replayed, effectState, networkContacted, ...reference } = approved;
      assert.equal(replayed, false); assert.equal(effectState, "authorized"); assert.equal(networkContacted, false);
      let calls = 0, closes = 0, permitted = true;
      const ingestionDb = ingestionClient(f.client);
      assert.throws(() => createAbsFeedJobExecution({ coordinator: f.client, ingestion: f.client }, f.scope, f.key,
        { assertCurrent() {} }), /database_separation_required/);
      const runner = createAbsFeedJobExecution({ coordinator: f.client, ingestion: ingestionDb }, f.scope, f.key, { assertCurrent(url) {
        assert.equal(url, "https://example.org/feed"); if (!permitted) throw new Error("synthetic revoked guard");
      } }, f.clock, (db, value, key, guard) => {
        assert.equal(db, ingestionDb); assert.notEqual(db, f.client);
        const { timeoutMs, ...configuration } = value as Record<string, unknown>;
        assert.equal(timeoutMs, 10000);
        const ingestion = new AbsFeedIngestionService(db, configuration, key);
        return { async collect(signal) {
          calls++; assert.equal(signal.aborted, false); guard.assertCurrent("https://example.org/feed");
          assert.equal((await new CanonicalStore(f.client).get(f.scope.tenantId, "effect_intent", approved.effectId))?.state, "executing");
          const result = mode === "read_failure" ? await ingestion.recordReadFailure({ checkedAt: new Date(now).toISOString(), reason: "read_failed" })
            : await ingestion.ingest('<rss version="2.0"><channel><title>News</title><item><title>Saved news</title><link>https://example.org/story</link></item></channel></rss>', new Date(now).toISOString());
          if (mode === "bad_receipt") result.receipt.authTag = "hmac-sha256:" + "0".repeat(64);
          if (mode === "revoked") permitted = false;
          return result;
        }, async close() { closes++; if (mode === "cleanup") throw new Error("synthetic cleanup uncertainty"); } };
      });
      const result = await runner.collect(reference, new AbortController().signal);
      assert.equal(result.disposition, mode === "success" ? "delivered" : "held");
      assert.equal(calls, 1); assert.ok(closes >= 1);
      assert.equal((await new CanonicalStore(f.client).get(f.scope.tenantId, "effect_intent", approved.effectId))?.state,
        mode === "success" ? "confirmed" : mode === "read_failure" ? "failed" : "ambiguous");
      await assert.rejects(runner.collect(reference, new AbortController().signal)); assert.equal(calls, 1);
    } finally { await f.db.close(); }
  });
});

test("cancellation during durable start cannot invoke the collector", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const approved = await f.service.approve(f.identity, f.args), controller = new AbortController();
  const reference = { schema: "control-room.abs-feed-job/v1", tenantId: f.scope.tenantId, projectId: f.scope.projectId,
    jobId: approved.jobId, attemptId: approved.attemptId, effectId: approved.effectId, operationDigest: approved.operationDigest };
  let marked = false;
  const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, values?: unknown[]) {
    const result = await tx.query<T>(sql, values);
    if (sql.includes("UPDATE control_effect_intents") && values?.[0] === "executing") { marked = true; controller.abort(); }
    return result;
  } });
  const db: DatabaseClient = { query: f.client.query.bind(f.client), transaction: work => f.client.transaction(tx => work(session(tx))),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
  const runner = createAbsFeedJobExecution({ coordinator: db, ingestion: ingestionClient(f.client) }, f.scope, f.key, { assertCurrent() {} }, f.clock, () => {
    assert.fail("cancelled attempt must not construct a collector");
  });
  assert.equal((await runner.collect(reference, controller.signal)).disposition, "held"); assert.equal(marked, true);
  assert.equal((await new CanonicalStore(f.client).get(f.scope.tenantId, "effect_intent", approved.effectId))?.state, "ambiguous");
});

test("grant revocation deadline and marker write failures roll back the whole start", async t => {
  for (const mode of ["revoke", "write"]) await t.test(mode, async () => {
    const f = await fixture();
    try {
      const receipt = await f.service.approve(f.identity, f.args);
      if (mode === "revoke") await f.client.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:web'", [new Date(now + 10_000).toISOString()]);
      let markerReached = false, approvalLocked = false;
      const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, values?: unknown[]) {
        if (sql.includes("SELECT id FROM control_approvals") && sql.includes("FOR SHARE")) approvalLocked = true;
        const result = await tx.query<T>(sql, values);
        if (sql.includes("UPDATE control_effect_intents")) {
          markerReached = true;
          if (mode === "write") throw new Error("synthetic marker failure");
          f.setTime(now + 11_000);
        }
        return result;
      } });
      const db: DatabaseClient = { query: f.client.query.bind(f.client), transaction: work => f.client.transaction(tx => work(session(tx))),
        transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
      await assert.rejects(new CanonicalStore(db).beginAbsFeedAttempt({ ...f.scope, ...f.args, attemptId: receipt.attemptId,
        effectId: receipt.effectId, operationDigest: receipt.operationDigest }, f.clock));
      assert.equal(markerReached, true); assert.equal(approvalLocked, true);
      const store = new CanonicalStore(f.client);
      assert.equal((await store.get(f.scope.tenantId, "job", receipt.jobId))?.state, "leased");
      assert.equal((await store.get(f.scope.tenantId, "attempt", receipt.attemptId))?.state, "leased");
      assert.equal((await store.get(f.scope.tenantId, "effect_intent", receipt.effectId))?.state, "authorized");
      assert.equal((await f.client.query("SELECT * FROM control_transition_events WHERE to_state='executing'")).rows.length, 0);
    } finally { await f.db.close(); }
  });
});

test("changed authority or assignment and elapsed deadlines refuse a feed start", async t => {
  for (const mode of ["revoked", "effects", "actions", "project", "node", "digest", "expired"]) await t.test(mode, async () => {
    const f = await fixture();
    try {
      const receipt = await f.service.approve(f.identity, f.args), store = new CanonicalStore(f.client);
      const input = { ...f.scope, ...f.args, attemptId: receipt.attemptId, effectId: receipt.effectId, operationDigest: receipt.operationDigest };
      if (mode === "revoked") await f.client.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:web'", [new Date(now).toISOString()]);
      if (mode === "effects") await f.client.query("UPDATE control_role_grants SET allow_external_effects=false WHERE id='grant:web'");
      if (mode === "actions") await f.client.query("UPDATE control_role_grants SET allowed_actions='[\"tasks.read\"]'::jsonb WHERE id='grant:web'");
      if (mode === "project") await new WebProjectService(f.client, { tenantId: f.scope.tenantId, workspaceId: f.scope.workspaceId }, f.clock)
        .transition(f.identity, f.scope.projectId, { lifecycle: "paused", expectedVersion: f.project.version }, "pause-feed-start-001");
      if (mode === "node") input.nodeId = "node:other";
      if (mode === "digest") input.inputDigest = sha256Digest("wrong");
      if (mode === "expired") f.setTime(now + 60_000);
      await assert.rejects(store.beginAbsFeedAttempt(input, f.clock));
      assert.equal((await store.get(f.scope.tenantId, "job", receipt.jobId))?.state, "leased");
      assert.equal((await store.get(f.scope.tenantId, "effect_intent", receipt.effectId))?.state, "authorized");
    } finally { await f.db.close(); }
  });
});
test("changed plan, wrong executor, inactive node and external-effect denial cannot authorize", async t => {
  for (const mode of ["digest", "executor", "node", "effects", "expired"]) await t.test(mode, async () => {
    const f = await fixture();
    try {
      let service = f.service, args = f.args;
      if (mode === "digest") args = { ...args, inputDigest: sha256Digest("changed") };
      if (mode === "executor") service = new WebNewsCollectionAdmission(f.client, { ...f.scope, executorId: "executor:other" }, f.key, f.submission, f.clock);
      if (mode === "node") await f.client.query("UPDATE control_nodes SET state='offline',payload=jsonb_set(payload,'{state}','\"offline\"') WHERE id=$1", [f.scope.nodeId]);
      if (mode === "effects") await f.client.query("UPDATE control_role_grants SET allow_external_effects=false WHERE id='grant:web'");
      if (mode === "expired") f.setTime(now + 241_000);
      await assert.rejects(service.approve(f.identity, args));
      assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 0);
      assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "proposed");
    } finally { await f.db.close(); }
  });
});
