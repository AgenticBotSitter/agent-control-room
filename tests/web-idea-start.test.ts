import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { WebIdeaStartOperation, type IdeaStartRuntime } from "../src/web/v1/idea-start-operation";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { buildIdeaLabFixtureV1, buildRepositoryFakeProviderEvidenceV1, buildIdeaLabHermes021RuntimeCandidateV1,
  buildIdeaLabLivePanelAdmissionCandidateV1 } from "../src/idea-lab/v1";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { startupConfig } from "./helpers/web-startup";
import { request } from "./helpers/web-foundation";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" }, key = new Uint8Array(32).fill(71);
const at = (offset = 0) => new Date(now + offset).toISOString();
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const f = await taskFixture();
  const saved = await new IdeaSessionCreationService(f.client, scope, key, buildIdeaLabFixtureV1().session.participants, () => now)
    .create(f.identity, { title: "Test idea", ideaSummary: "Help local shops", targetCustomer: "Shop owners", maxRounds: 1,
      maxDurationSeconds: 300, maxCostUsd: 2 }, "idea-start-test01");
  const session = (await new IdeaLabProjectRegistryStoreV1(f.client, key).getSession(scope.tenantId, saved.sessionId))!;
  // Synthetic evidence and injected driver only. No native qualification/contact.
  const evidence = session.participants.map((p, i) => {
    const { evidenceDigest: ignored, ...base } = buildRepositoryFakeProviderEvidenceV1(session, p,
      { evidenceId: `evidence:start:${i}`, capturedAt: at(), expiresAt: at(240000) }); void ignored;
    const material = { ...base, mode: "hermes_bot_mode_filtered" as const, harnessPackage: "hermes_agent" as const,
      harnessVersion: "0.21.0", sourceRevision: "a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b",
      adapterDigest: sha256Digest("adapter.hermes.gateway.v2"), liveProviderAuthorized: true, providerContacted: true };
    return { ...material, evidenceDigest: sha256Digest(material) };
  });
  let calls = 0, resolutions = 0;
  const runtime: IdeaStartRuntime = {
    async resolve(selected, ownerId, runId) {
      resolutions++; assert.equal(ownerId, "identity:web"); assert.equal(selected.sessionDigest, saved.sessionDigest);
      return { evidence, admission: buildIdeaLabLivePanelAdmissionCandidateV1({ admissionId: "admission:start", runId, session, evidence,
        runtime: buildIdeaLabHermes021RuntimeCandidateV1({ compatibilityEvidenceDigest: sha256Digest("compat"),
          nativeQualificationReceiptDigest: sha256Digest("synthetic-receipt"), runtimeManifestDigest: sha256Digest("manifest"),
          protectedValueCustodyEvidenceDigest: sha256Digest("custody") }),
        runtimeIdentityDigests: Object.fromEntries(session.participants.map(p => [p.participantId, sha256Digest(p.participantId)])),
        ownerWindow: { windowId: "window:start", decisionDigest: sha256Digest("decision"), strongFactorEvidenceDigest: sha256Digest("factor"),
          authorizedAction: "idea_lab_live_panel", singleUse: true, ownerAttended: true, openedAt: at(), expiresAt: at(240000) },
        issuedAt: at(), expiresAt: at(240000) }) };
    },
    driver: { mode: "hermes_bot_mode_filtered", async invoke(input) {
      calls++; return { outcome: "completed", safeOpinion: "Test opinion", opportunityCode: "opportunity", primaryRiskCode: "risk",
        suggestedExperiment: "Ask one shop owner", confidencePercent: 70, costUsd: 0.01,
        providerReceiptDigest: sha256Digest(input.markerDigest), providerContacted: true };
    } }, evidenceAuthority: { async verify() { return true; } }, admissionAuthority: { async consume() { return true; } },
  };
  // Distinct wrappers over one serialized test engine are not independent SQL pools.
  const runtimeDb: DatabaseClient = { query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: f.client.transactionWithPreCommitCheck.bind(f.client) };
  return { ...f, saved, runtime, runtimeDb, counts: () => ({ calls, resolutions }) };
}

test("a duplicate owner start reads the active run without blocking on a provider or dispatching twice", async t => {
  const f = await fixture(); t.after(() => f.db.close()); const entered = deferred(), release = deferred();
  const invoke = f.runtime.driver.invoke.bind(f.runtime.driver);
  f.runtime.driver.invoke = async input => { entered.resolve(); await release.promise; return invoke(input); };
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  const first = service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  await entered.promise;
  const second = await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  assert.equal(second.replayed, true); assert.equal(second.state, "running");
  assert.equal(f.counts().resolutions, 1); release.resolve();
  const done = await first; assert.equal(done.state, "completed"); assert.equal(f.counts().calls, 4);
  assert.equal((await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest })).replayed, true);
  assert.equal(f.counts().calls, 4);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='idea_lab.panel_start'")).rows.length, 1);
});

test("denied admission and unknown provider outcomes are retained without another attempt", async t => {
  for (const denied of [true, false]) await t.test(String(denied), async t => {
    const f = await fixture(); t.after(() => f.db.close()); let attempts = 0;
    f.runtime.admissionAuthority.consume = async () => !denied;
    f.runtime.driver.invoke = async () => { attempts++; throw new Error("synthetic unknown outcome"); };
    const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
    const result = await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
    assert.equal(result.state, denied ? "failed_definite" : "ambiguous"); assert.equal(attempts, denied ? 0 : 1);
    await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
    assert.equal(attempts, denied ? 0 : 1); assert.equal(f.counts().resolutions, 1);
  });
});

test("start refuses fake fallback, changed digest and revoked owner before resolving runtime material", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  assert.throws(() => new WebIdeaStartOperation(f.client, f.client, scope, key, f.runtime), /config_invalid/);
  assert.throws(() => new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key,
    { ...f.runtime, driver: { ...f.runtime.driver, mode: "repository_fake" } }), /config_invalid/);
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  await assert.rejects(service.start(f.identity, f.saved.sessionId, { sessionDigest: sha256Digest("wrong") }), /conflict/);
  await f.client.query("UPDATE control_role_grants SET revoked_at=$1", [at()]);
  await assert.rejects(service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /access_denied/);
  assert.deepEqual(f.counts(), { calls: 0, resolutions: 0 });
});

test("failed claim audit cannot leave a run or reach a provider", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const commandDb: DatabaseClient = { ...f.client, query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work({ async query<T>(sql: string, params?: unknown[]) {
      if (sql.includes("INSERT INTO audit_events")) throw new Error("synthetic failed audit");
      return tx.query<T>(sql, params);
    } }), check) };
  await assert.rejects(new WebIdeaStartOperation(commandDb, f.runtimeDb, scope, key, f.runtime, () => now)
    .start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /synthetic failed audit/);
  assert.equal(f.counts().calls, 0);
  assert.equal((await f.client.query("SELECT * FROM control_idea_bot_run_events")).rows.length, 0);
});

test("owner access is checked again after runtime lookup", async t => {
  const f = await fixture(); t.after(() => f.db.close()); const resolve = f.runtime.resolve.bind(f.runtime);
  f.runtime.resolve = async (...args) => {
    const value = await resolve(...args); await f.client.query("UPDATE control_role_grants SET revoked_at=$1", [at()]); return value;
  };
  await assert.rejects(new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now)
    .start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /access_denied/);
  assert.equal(f.counts().calls, 0); assert.equal((await f.client.query("SELECT * FROM control_idea_bot_run_events")).rows.length, 0);
});

test("interruption after a durable claim does not resubmit a prepared run on retry", async t => {
  const f = await fixture(); t.after(() => f.db.close()); let checks = 0;
  f.runtime.admissionAuthority.consume = async () => { checks++; throw new Error("synthetic uncertain admission"); };
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  await assert.rejects(service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /uncertain admission/);
  const replay = await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  assert.equal(replay.state, "prepared"); assert.equal(replay.replayed, true); assert.equal(replay.retryPermitted, false);
  assert.equal(checks, 1); assert.equal(f.counts().calls, 0); assert.equal(f.counts().resolutions, 1);
});

test("two starts that both reach lookup still produce only one owned claim", async t => {
  const f = await fixture(); t.after(() => f.db.close()); const both = deferred(), release = deferred();
  const resolve = f.runtime.resolve.bind(f.runtime); let waiting = 0;
  f.runtime.resolve = async (...args) => {
    const material = await resolve(...args); if (++waiting === 2) both.resolve(); await release.promise; return material;
  };
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  const a = service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  const b = service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  await both.promise; release.resolve(); const results = await Promise.all([a, b]);
  assert.equal(results.filter(r => !r.replayed).length, 1); assert.equal(f.counts().calls, 4);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='idea_lab.panel_start'")).rows.length, 1);
});

test("HTTP start remains unconfigured by default and requires same-origin authenticated exact requests", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const creation = new IdeaSessionCreationService(f.client, scope, key, buildIdeaLabFixtureV1().session.participants, () => now);
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  const options = { ...startupConfig, database: { client: f.client, close: async () => {} }, clock: () => now,
    ideaProjects: { integrityKey: key }, ideaCreation: { ...scope, create: creation.create.bind(creation) } };
  const closed = createPrivateWebProcess(options), app = createPrivateWebProcess({ ...options,
    ideaCreation: { ...options.ideaCreation, start: service.start.bind(service) } });
  t.after(async () => { await closed.close(); await app.close(); });
  const path = `/api/v1/ideas/${encodeURIComponent(f.saved.sessionId)}/start`, body = { sessionDigest: f.saved.sessionDigest };
  const handle = (req: Request) => app.handle(req, () => new Response("shell"));
  assert.equal((await closed.handle(request(path, "POST", body), () => new Response("shell"))).status, 503);
  const foreign = request(path, "POST", body); foreign.headers.set("origin", "https://other.example");
  assert.equal((await handle(foreign)).status, 403);
  const anonymous = request(path, "POST", body); anonymous.headers.delete("cf-access-jwt-assertion");
  assert.equal((await handle(anonymous)).status, 401);
  assert.equal((await handle(request(path, "GET"))).status, 400);
  assert.equal((await handle(request(path, "POST", { ...body, admission: {} }))).status, 400);
  assert.equal((await handle(request(path, "POST", { ...body, padding: "x".repeat(2200) }))).status, 400);
  assert.equal(f.counts().calls, 0);
  assert.equal((await handle(request(path, "POST", body))).status, 201);
  assert.equal((await handle(request(path, "POST", body))).status, 200);
  assert.equal(f.counts().calls, 4);
  await handle(request("/api/v1/session/logout", "POST"));
  assert.equal((await handle(request(path, "POST", body))).status, 401);
});

async function managedFixture() {
  const f = await fixture(), planner = await taskAssignmentFixture();
  const closed: string[] = [];
  const wrap = (): DatabaseClient => ({ query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: f.client.transactionWithPreCommitCheck.bind(f.client) });
  const resource = (name: string, client: DatabaseClient) => ({ client, isAvailable: () => true, close: async () => { closed.push(name); } });
  const config = { scope, planning: planner.plannerConfig, routes: [planner.route], clock: () => now,
    database: resource("task", wrap()), ideaCreation: { database: resource("idea", f.client), integrityKey: key,
      participants: buildIdeaLabFixtureV1().session.participants },
    ideaRuntime: { database: resource("runtime-db", f.runtimeDb), runtime: f.runtime, close: async () => { closed.push("runtime"); } } };
  return { ...f, config, closed, cleanup: async () => { await planner.close(); await f.db.close(); } };
}

test("managed discussion drains an in-flight turn, blocks another turn and closes captured resources once", async t => {
  const f = await managedFixture(); t.after(f.cleanup); const entered = deferred(), release = deferred();
  const invoke = f.runtime.driver.invoke.bind(f.runtime.driver);
  f.runtime.driver.invoke = async input => { entered.resolve(); await release.promise; return invoke(input); };
  const owner = createTaskCoordinatorLifecycle(f.config);
  // Changing caller-owned methods after construction cannot replace the captured ports.
  f.runtime.driver.invoke = async () => { throw new Error("mutated driver"); };
  f.config.ideaRuntime.close = async () => { throw new Error("mutated close"); };
  const pending = owner.ideaCreation!.start!(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  await entered.promise; const closing = owner.close(); assert.equal(owner.isReady(), false);
  await assert.rejects(owner.ideaCreation!.start!(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /unavailable/);
  assert.deepEqual(f.closed, []); release.resolve();
  const result = await pending; await closing; await owner.close();
  assert.equal(f.counts().calls, 1); assert.equal(result.state, "failed_definite");
  assert.equal((await f.client.query("SELECT * FROM control_idea_contributions")).rows.length, 1);
  assert.equal(f.closed[0], "runtime"); assert.deepEqual([...f.closed].sort(), ["idea", "runtime", "runtime-db", "task"]);
});

test("managed shutdown during runtime lookup cannot claim or contact a provider", async t => {
  const f = await managedFixture(); t.after(f.cleanup); const entered = deferred(), release = deferred();
  const resolve = f.runtime.resolve.bind(f.runtime);
  f.runtime.resolve = async (...args) => { entered.resolve(); await release.promise; return resolve(...args); };
  const owner = createTaskCoordinatorLifecycle(f.config);
  const pending = owner.ideaCreation!.start!(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  // Existing lifecycle deliberately reports an interrupted admitted command as
  // uncertain once teardown wins, even though the assertions below prove no claim.
  const rejected = assert.rejects(pending, /unavailable|save_uncertain/);
  await entered.promise; const closing = owner.close(); release.resolve(); await rejected; await closing;
  assert.equal(f.counts().calls, 0); assert.equal((await f.client.query("SELECT * FROM control_idea_bot_run_events")).rows.length, 0);
});

test("managed drain timeout retains unknown in-flight history and rejects a late reply", async t => {
  const f = await managedFixture(); t.after(f.cleanup); const entered = deferred(), release = deferred();
  const invoke = f.runtime.driver.invoke.bind(f.runtime.driver);
  f.runtime.driver.invoke = async input => { entered.resolve(); await release.promise; return invoke(input); };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, drainMs: 10, closeMs: 20 });
  const pending = owner.ideaCreation!.start!(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  const rejected = assert.rejects(pending, /uncertain/); await entered.promise;
  await assert.rejects(owner.close(), /close_uncertain/); await rejected;
  const before = await f.client.query("SELECT * FROM control_idea_bot_run_events");
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await f.client.query("SELECT * FROM control_idea_bot_run_events")).rows, before.rows);
  assert.equal((await f.client.query("SELECT * FROM control_idea_contributions")).rows.length, 0);
  assert.equal(f.counts().calls, 1);
});

test("managed runtime rejects aliased pools and closes databases after failed or stalled runtime cleanup", async t => {
  for (const stalled of [false, true]) await t.test(String(stalled), async t => {
    const f = await managedFixture(); t.after(f.cleanup);
    assert.throws(() => createTaskCoordinatorLifecycle({ ...f.config, ideaCreation: undefined }), /config_invalid/);
    assert.throws(() => createTaskCoordinatorLifecycle({ ...f.config,
      ideaRuntime: { ...f.config.ideaRuntime, database: f.config.ideaCreation.database } }), /config_invalid/);
    f.config.ideaRuntime.close = async () => {
      f.closed.push("runtime"); if (stalled) await new Promise<void>(() => {}); throw new Error("synthetic cleanup failure");
    };
    const owner = createTaskCoordinatorLifecycle({ ...f.config, closeMs: 20 }); await assert.rejects(owner.close(), /close_uncertain/);
    assert.deepEqual([...f.closed].sort(), ["idea", "runtime", "runtime-db", "task"]);
  });
});
