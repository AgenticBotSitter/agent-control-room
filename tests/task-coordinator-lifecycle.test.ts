import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import type { DatabaseClient } from "../src/persistence/database";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";
import { createPrivateTaskApplication } from "../src/web/v1/private-task-application";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { instant } from "./hermes-native-fixture";
import { origin, request } from "./helpers/web-foundation";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage";
import { enrollment } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("trusted submission is opt-in, snapshots its port and drains before pool close", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close); await f.save();
  const entered = deferred(), release = deferred(); let closes = 0, calls = 0;
  let producerCloses = 0;
  const nativeSubmission = { async enqueueInSession() { calls++; entered.resolve(); await release.promise; },
    async close() { assert.equal(closes, 0); producerCloses++; } };
  const owner = createTaskCoordinatorLifecycle({ scope: f.scope, planning: f.plannerConfig, routes: [f.route],
    database: { client: f.db, close: async () => { closes++; }, isAvailable: () => true }, clock: f.clock,
    approvals: { enrollments: [{ enrollment, nodeClass: "personal-compute" }], store: f.store }, nativeSubmission });
  nativeSubmission.enqueueInSession = async () => { throw new Error("mutated port"); };
  const pending = owner.submission!.enqueue(...f.args, sha256Digest(f.packet), f.abort.signal);
  await entered.promise; const closing = owner.close(); assert.equal(closes, 0);
  await assert.rejects(owner.submission!.enqueue(...f.args, sha256Digest(f.packet), f.abort.signal), /unavailable/);
  release.resolve(); assert.equal((await pending).replayed, false); await closing;
  assert.equal(calls, 1); assert.equal(closes, 1); assert.equal(producerCloses, 1);
});

test("submission failure rolls back canonical intent through the owned lifecycle", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close); await f.save();
  const owner = createTaskCoordinatorLifecycle({ scope: f.scope, planning: f.plannerConfig, routes: [f.route],
    database: { client: f.db, close: async () => {}, isAvailable: () => true }, clock: f.clock,
    approvals: { enrollments: [{ enrollment, nodeClass: "personal-compute" }], store: f.store },
    nativeSubmission: { async enqueueInSession() { throw new Error("synthetic submission failure"); } } });
  t.after(() => owner.close());
  await assert.rejects(owner.submission!.enqueue(...f.args, sha256Digest(f.packet), f.abort.signal));
  assert.equal((await f.db.query("SELECT * FROM control_native_task_queue")).rows.length, 0);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.task.queued'")).rows.length, 0);
});
async function fixture() {
  const f = await taskAssignmentFixture(); let closes = 0, available = true;
  const database = { client: f.db, close: async () => { closes++; available = false; }, isAvailable: () => available };
  const config = { scope: f.scope, planning: f.plannerConfig, routes: [f.route], database, clock: () => instant + 8000 };
  const args = [f.identity, f.prepared.receipt.projectId, f.prepared.receipt.jobId, f.route.nodeId, f.prepared.receipt.inputDigest] as const;
  return { ...f, config, args, closes: () => closes, unavailable: () => { available = false; } };
}

test("owned coordinator exposes only scoped operations and preserves real assignment reconciliation", async t => {
  const f = await fixture(); t.after(f.close);
  const before = (await f.db.query("SELECT * FROM control_attempts")).rows.length;
  const owner = createTaskCoordinatorLifecycle(f.config);
  assert.deepEqual(Object.keys(owner).sort(), ["assignment", "close", "isReady", "planning"]);
  assert.equal((await f.db.query("SELECT * FROM control_attempts")).rows.length, before);
  f.config.scope = { tenantId: "tenant:other", workspaceId: "workspace:other" };
  f.config.routes[0] = { ...f.route, nodeId: "node:other" };
  const saved = await owner.assignment.assign(...f.args);
  assert.equal(saved.receipt.startsWork, false); assert.equal(saved.replayed, false);
  assert.equal((await owner.assignment.assign(...f.args)).replayed, true);
  const closing = owner.close(); assert.equal(owner.isReady(), false); assert.equal(owner.close(), closing);
  await closing; assert.equal(f.closes(), 1);
  await assert.rejects(owner.assignment.assign(...f.args), /task_coordinator_unavailable/);
});

test("admission has no queue and graceful drain waits for admitted SQL completion", async t => {
  const f = await fixture(); t.after(f.close); const entered = deferred(), release = deferred();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    entered.resolve(); await release.promise; return f.db.transactionWithPreCommitCheck(work, check);
  } };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, maxActive: 1, database: { ...f.config.database, client: db } });
  const save = owner.assignment.assign(...f.args); await entered.promise;
  await assert.rejects(owner.assignment.assign(...f.args), /task_coordinator_unavailable/);
  const closing = owner.close(); assert.equal(f.closes(), 0); assert.equal(owner.isReady(), false);
  release.resolve(); assert.equal((await save).replayed, false); await closing; assert.equal(f.closes(), 1);
});

test("drain timeout closes once and prevents late transaction writes or a false successful save", async t => {
  const f = await fixture(); t.after(f.close); const entered = deferred(), release = deferred(), finished = deferred();
  let queries = 0;
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    entered.resolve(); await release.promise;
    try { return await f.db.transactionWithPreCommitCheck(tx => work({ query: (sql, params) => { queries++; return tx.query(sql, params); } }), check); }
    finally { finished.resolve(); }
  } };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, drainMs: 5, database: { ...f.config.database, client: db } });
  const save = assert.rejects(owner.assignment.assign(...f.args), /task_coordinator_save_uncertain/);
  await entered.promise; await assert.rejects(owner.close(), /task_coordinator_close_uncertain/); await save;
  assert.equal(f.closes(), 1); release.resolve(); await finished.promise;
  assert.equal(queries, 0); assert.equal((await f.db.query("SELECT * FROM control_attempts WHERE job_id=$1", [f.args[2]])).rows.length, 0);
  await assert.rejects(owner.close(), /task_coordinator_close_uncertain/); assert.equal(f.closes(), 1);
});

test("a completed normal drain cancels its timer before separately bounded pool cleanup", async t => {
  const f = await fixture(); t.after(f.close);
  const entered = deferred(), release = deferred(), cleanupEntered = deferred(), cleanupRelease = deferred();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    entered.resolve(); await release.promise; return f.db.transactionWithPreCommitCheck(work, check);
  } };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, drainMs: 5, closeMs: 100, database: { ...f.config.database, client: db,
    close: async () => { cleanupEntered.resolve(); await cleanupRelease.promise; } } });
  const save = owner.assignment.assign(...f.args); await entered.promise;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const closing = owner.close(); release.resolve(); await cleanupEntered.promise;
  assert.equal((await save).replayed, false);
  t.mock.timers.tick(10); cleanupRelease.resolve(); await closing;
  assert.equal(owner.isReady(), false);
});

test("pool cleanup failure or stall stays uncertain and never retries", async t => {
  for (const stalls of [false, true]) await t.test(String(stalls), async t => {
    const f = await fixture(); t.after(f.close); let calls = 0;
    const owner = createTaskCoordinatorLifecycle({ ...f.config, closeMs: 5, database: { ...f.config.database,
      close: async () => { calls++; if (stalls) await new Promise(() => {}); else throw new Error("synthetic private diagnostic"); } } });
    await assert.rejects(owner.close(), { message: "task_coordinator_close_uncertain" });
    await assert.rejects(owner.close(), { message: "task_coordinator_close_uncertain" });
    assert.equal(calls, 1); assert.equal(owner.isReady(), false);
  });
});

test("shutdown across precommit or lost commit acknowledgement never invents a success or retries", async t => {
  for (const committed of [false, true]) await t.test(committed ? "acknowledgement lost" : "precommit blocked", async t => {
    const f = await fixture(); t.after(f.close); const entered = deferred(), release = deferred(), finished = deferred();
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
      try {
        if (committed) {
          const value = await f.db.transactionWithPreCommitCheck(work, check);
          entered.resolve(); await release.promise; return value;
        }
        return await f.db.transactionWithPreCommitCheck(async tx => {
          const value = await work(tx); entered.resolve(); await release.promise; return value;
        }, check);
      } finally { finished.resolve(); }
    } };
    const owner = createTaskCoordinatorLifecycle({ ...f.config, drainMs: 5, database: { ...f.config.database, client: db } });
    const save = assert.rejects(owner.assignment.assign(...f.args), /task_coordinator_save_uncertain/);
    await entered.promise; await assert.rejects(owner.close(), /task_coordinator_close_uncertain/); await save;
    release.resolve(); await finished.promise;
    assert.equal((await f.db.query("SELECT * FROM control_attempts WHERE job_id=$1", [f.args[2]])).rows.length, committed ? 1 : 0);
    if (committed) {
      const rebuilt = createTaskCoordinatorLifecycle({ ...f.config, database: { client: f.db, close: async () => {}, isAvailable: () => true } });
      const result = await rebuilt.assignment.assign(...f.args); assert.equal(result.replayed, true);
      assert.equal((await f.db.query("SELECT * FROM control_attempts WHERE job_id=$1", [f.args[2]])).rows.length, 1);
      await rebuilt.close();
    }
  });
});

test("configuration failure retains caller ownership and unavailable pools refuse admission", async t => {
  const f = await fixture(); t.after(f.close);
  for (const patch of [{ maxActive: 0 }, { maxActive: 9 }, { drainMs: 30_001 }, { closeMs: 5001 }, { routes: [f.route, f.route] },
    { nativeSubmission: { async enqueueInSession() {} } },
    { planning: { ...f.plannerConfig, integrityKey: new Uint8Array(2) } }])
    assert.throws(() => createTaskCoordinatorLifecycle({ ...f.config, ...patch }));
  assert.equal(f.closes(), 0);
  const owner = createTaskCoordinatorLifecycle(f.config); f.unavailable(); assert.equal(owner.isReady(), false);
  await assert.rejects(owner.assignment.assign(...f.args), /task_coordinator_unavailable/); await owner.close();
});

test("a commit acknowledgement arriving during forced pool cleanup cannot report success", async t => {
  const f = await fixture(); t.after(f.close);
  const committed = deferred(), acknowledge = deferred(), cleanupEntered = deferred(), cleanupRelease = deferred(), operationReturned = deferred();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    const value = await f.db.transactionWithPreCommitCheck(work, check); committed.resolve(); await acknowledge.promise;
    operationReturned.resolve(); return value;
  } };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, drainMs: 5, database: { ...f.config.database, client: db,
    close: async () => { cleanupEntered.resolve(); await cleanupRelease.promise; } } });
  let outcome = "pending";
  const save = owner.assignment.assign(...f.args).then(() => { outcome = "success"; }, error => { outcome = error.message; });
  await committed.promise;
  const closing = assert.rejects(owner.close(), /task_coordinator_close_uncertain/);
  await cleanupEntered.promise; acknowledge.resolve(); await operationReturned.promise;
  // Flush promise reactions, without a wall-clock assertion or starting another operation.
  await new Promise<void>(resolve => setImmediate(resolve));
  const duringCleanup = outcome; cleanupRelease.resolve(); await closing; await save;
  assert.equal(duringCleanup, "pending"); assert.equal(outcome, "task_coordinator_save_uncertain");
});

test("combined application mounts real assignment behind a genuinely restricted web role and closes both resources", async t => {
  const f = await fixture(); t.after(f.close); await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  const restricted: DatabaseClient = {
    query: (sql, params) => f.db.transaction(async tx => { await tx.query("SET LOCAL ROLE control_room_private_web"); return tx.query(sql, params); }),
    transaction: work => f.db.transaction(async tx => { await tx.query("SET LOCAL ROLE control_room_private_web"); return work(tx); }),
    transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
      await tx.query("SET LOCAL ROLE control_room_private_web"); return work(tx);
    }, check),
  };
  await assert.rejects(restricted.query("SELECT * FROM control_task_execution_plans"));
  let webCloses = 0, webAvailable = true;
  assert.ok(f.ownerKeys.harnessIntegrityKey);
  const web = { ...f.accessTrust, ...f.scope, origin, tasks: { ...f.ownerKeys, harnessIntegrityKey: f.ownerKeys.harnessIntegrityKey }, loadKeys: async () => f.accessTrust.keys,
    database: { client: restricted, close: async () => { webCloses++; }, isAvailable: () => webAvailable }, clock: () => instant + 8000 };
  await assert.rejects(createPrivateTaskApplication({ ...web, database: f.config.database }, f.config), /config_invalid/);
  assert.equal(f.closes(), 0);
  const app = await createPrivateTaskApplication(web, f.config);
  const path = `/api/v1/projects/${f.args[1]}/tasks/${f.args[2]}/assignment`;
  const handle = (method = "GET", body?: unknown, route = path) => app.handle(request(route, method, body, undefined, f.jwt), () => new Response("shell"));
  assert.equal((await handle()).status, 200);
  const result = await handle("POST", { action: "assign", nodeId: f.route.nodeId, expectedInputDigest: f.args[4] });
  assert.equal(result.status, 201, await result.clone().text()); assert.equal((await result.json()).receipt.startsWork, false);
  assert.equal((await handle("POST", undefined, "/api/v1/session/logout")).status, 204);
  assert.equal((await handle()).status, 401);
  webAvailable = false; assert.equal(app.isReady(), false);
  const closing = app.close(); assert.equal(app.close(), closing); await closing;
  assert.equal(webCloses, 1); assert.equal(f.closes(), 1); assert.equal((await handle()).status, 503);
});

test("failed web construction cleans both transferred resources and hides underlying errors", async t => {
  const f = await fixture(); t.after(f.close); let webCloses = 0;
  const web = { ...f.accessTrust, ...f.scope, origin: "http://invalid.example.invalid", loadKeys: async () => f.accessTrust.keys,
    database: { client: { ...f.db }, close: async () => { webCloses++; }, isAvailable: () => true } };
  await assert.rejects(createPrivateTaskApplication(web, f.config), { message: "private_task_application_install_failed" });
  assert.equal(webCloses, 1); assert.equal(f.closes(), 1);
});
