import assert from "node:assert/strict";
import test from "node:test";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";
import { createPrivateTaskApplication } from "../src/web/v1/private-task-application";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import type { DatabaseClient } from "../src/persistence/database";
import { instant } from "./hermes-native-fixture";
import { origin, request } from "./helpers/web-foundation";

const draft = () => ({ title: "Small business idea", ideaSummary: "Help small shops", targetCustomer: "Local owners",
  maxRounds: 2, maxDurationSeconds: 300, maxCostUsd: 2 });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const f = await taskAssignmentFixture(); let taskCloses = 0, ideaCloses = 0, available = true;
  // Distinct client wrappers on one disposable PGlite instance test ownership, not real pool isolation.
  const client: DatabaseClient = { query: f.db.query.bind(f.db), transaction: f.db.transaction.bind(f.db),
    transactionWithPreCommitCheck: f.db.transactionWithPreCommitCheck.bind(f.db) };
  const ideaCreation = { database: { client, isAvailable: () => available, close: async () => { ideaCloses++; } },
    integrityKey: new Uint8Array(32).fill(67), participants: buildIdeaLabFixtureV1().session.participants };
  const config = { scope: f.scope, planning: f.plannerConfig, routes: [f.route], clock: () => instant + 8000,
    database: { client: f.db, isAvailable: () => true, close: async () => { taskCloses++; } }, ideaCreation };
  return { ...f, config, counts: () => [taskCloses, ideaCloses], unavailable: () => { available = false; } };
}
test("Idea save snapshots input, shares admission and drains before closing its separate resource", async t => {
  const f = await fixture(); t.after(f.close);
  const entered = deferred(), release = deferred();
  const raw = f.config.ideaCreation.database.client.transactionWithPreCommitCheck;
  f.config.ideaCreation.database.client.transactionWithPreCommitCheck = async (work, check) => {
    entered.resolve(); await release.promise; return raw(work, check);
  };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, maxActive: 1 });
  const input = draft(), pending = owner.ideaCreation!.create(f.identity, input, "idea-lifecycle-001");
  input.title = "mutated"; await entered.promise;
  await assert.rejects(owner.ideaCreation!.create(f.identity, draft(), "idea-lifecycle-002"), /unavailable/);
  const closing = owner.close(); assert.deepEqual(f.counts(), [0, 0]);
  release.resolve(); assert.equal((await pending).startsWork, false); await closing;
  assert.deepEqual(f.counts(), [1, 1]); assert.equal(owner.close(), closing);
  const rows = await f.db.query<{ payload: { title: string } }>("SELECT payload FROM control_idea_sessions");
  assert.equal(rows.rows[0].payload.title, "Small business idea");
  await assert.rejects(owner.ideaCreation!.create(f.identity, draft(), "idea-lifecycle-003"), /unavailable/);
});
test("Idea drain timeout refuses late writes and reports uncertainty", async t => {
  const f = await fixture(); t.after(f.close);
  const entered = deferred(), release = deferred(), finished = deferred();
  const raw = f.config.ideaCreation.database.client.transactionWithPreCommitCheck;
  f.config.ideaCreation.database.client.transactionWithPreCommitCheck = async (work, check) => {
    entered.resolve(); await release.promise; try { return await raw(work, check); } finally { finished.resolve(); }
  };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, drainMs: 5 });
  const pending = owner.ideaCreation!.create(f.identity, draft(), "idea-lifecycle-004");
  const rejected = assert.rejects(pending, /uncertain/); await entered.promise;
  await assert.rejects(owner.close(), /uncertain/); await rejected;
  release.resolve(); await finished.promise;
  assert.equal((await f.db.query("SELECT * FROM control_idea_sessions")).rows.length, 0);
  assert.deepEqual(f.counts(), [1, 1]);
});
test("Idea resource cannot alias the coordinator and unavailable storage refuses admission", async t => {
  const f = await fixture(); t.after(f.close);
  assert.throws(() => createTaskCoordinatorLifecycle({ ...f.config,
    ideaCreation: { ...f.config.ideaCreation, database: f.config.database } }), /config_invalid/);
  assert.deepEqual(f.counts(), [0, 0]);
  const owner = createTaskCoordinatorLifecycle(f.config); t.after(() => owner.close()); f.unavailable();
  assert.equal(owner.isReady(), false);
  await assert.rejects(owner.ideaCreation!.create(f.identity, draft(), "idea-lifecycle-005"), /unavailable/);
});
test("application rejects mismatched Idea read/write integrity configuration before taking ownership", async t => {
  const f = await fixture(); t.after(f.close);
  assert.ok(f.ownerKeys.harnessIntegrityKey);
  const web = { ...f.accessTrust, ...f.scope, origin, tasks: { ...f.ownerKeys, harnessIntegrityKey: f.ownerKeys.harnessIntegrityKey }, loadKeys: async () => f.accessTrust.keys,
    database: { ...f.config.database, client: { ...f.db } }, clock: f.config.clock,
    ideaProjects: { integrityKey: new Uint8Array(32).fill(68) } };
  await assert.rejects(createPrivateTaskApplication(web, f.config), /config_invalid/);
  assert.deepEqual(f.counts(), [0, 0]);
});

test("combined application exposes saved Ideas through the owned writer and closes all resources", async t => {
  const f = await fixture(); t.after(f.close); let webCloses = 0;
  assert.ok(f.ownerKeys.harnessIntegrityKey);
  const app = await createPrivateTaskApplication({ ...f.accessTrust, ...f.scope, origin,
    tasks: { ...f.ownerKeys, harnessIntegrityKey: f.ownerKeys.harnessIntegrityKey }, loadKeys: async () => f.accessTrust.keys,
    database: { client: { ...f.db }, close: async () => { webCloses++; }, isAvailable: () => true },
    clock: f.config.clock, ideaProjects: { integrityKey: f.config.ideaCreation.integrityKey } }, f.config);
  t.after(() => app.close());
  const handle = (path: string, method = "GET", body?: unknown) =>
    app.handle(request(path, method, body, "idea-app-000001", f.jwt), () => new Response("shell"));
  assert.equal((await (await handle("/api/v1/ideas")).json()).canCreate, true);
  assert.equal((await handle("/api/v1/ideas", "POST", { ...draft(), title: "" })).status, 400);
  const saved = await handle("/api/v1/ideas", "POST", draft());
  assert.equal(saved.status, 201, await saved.clone().text()); const receipt = await saved.json();
  assert.equal((await handle("/api/v1/ideas", "POST", draft())).status, 200);
  assert.equal((await handle(`/api/v1/ideas/${receipt.sessionId}`)).status, 200);
  await app.close(); assert.deepEqual(f.counts(), [1, 1]); assert.equal(webCloses, 1);
  assert.equal((await handle("/api/v1/ideas", "POST", draft())).status, 503);
});

test("failed or stalled Idea cleanup stays uncertain and closes only once", async t => {
  for (const stall of [false, true]) await t.test(String(stall), async t => {
    const f = await fixture(); t.after(f.close); let closes = 0;
    f.config.ideaCreation.database.close = async () => {
      closes++; if (stall) await new Promise<void>(() => {}); else throw new Error("synthetic private detail");
    };
    const owner = createTaskCoordinatorLifecycle({ ...f.config, closeMs: 5 });
    const closing = owner.close(); assert.equal(owner.close(), closing);
    await assert.rejects(closing, { message: "task_coordinator_close_uncertain" });
    assert.equal(closes, 1); assert.equal(owner.isReady(), false);
  });
});
