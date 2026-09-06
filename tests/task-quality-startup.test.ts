import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient } from "../src/persistence/database";
import type { PrivateApplication } from "../src/web/v1/private-process";
import { createPrivateTaskBootstrap, type PrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";
import type { TaskQualityConfiguration, TaskQualityRequest } from "../src/web/v1/task-quality-coordinator";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion";
import { taskStartupFixture } from "./helpers/task-startup";
import { request } from "./helpers/web-foundation";

type QualityFixture = Awaited<ReturnType<typeof nativeQualityCompletionFixture>>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function qualityConfiguration(x: QualityFixture): TaskQualityConfiguration {
  return {
    integrityKey: Uint8Array.from(x.f.ownerConfig.integrityKey),
    harnessIntegrityKey: Uint8Array.from(x.f.ownerConfig.harnessIntegrityKey),
    checkpoints: x.f.ownerConfig.checkpoints,
    results: { ...x.f.ownerConfig.results, integrityKey: Uint8Array.from(x.f.ownerConfig.results.integrityKey) },
    scenarios: [{ ...x.scenario, rules: { ...x.scenario.rules,
      requiredHeadings: [...x.scenario.rules.requiredHeadings], forbiddenTerms: [...x.scenario.rules.forbiddenTerms] } }],
  };
}

function qualityRequest(x: QualityFixture): TaskQualityRequest {
  return { ...x.request, projectId: x.registration.projectId, jobId: x.registration.jobId };
}

function differentKey(key: Uint8Array) {
  const changed = Uint8Array.from(key); changed[0] = changed[0]! ^ 0xff; return changed;
}

test("two restricted startup roles mount only the scoped quality command after both preflights", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const f = await taskStartupFixture(x.f.assignmentFixture);
  const quality = qualityConfiguration(x);
  const config: PrivateTaskStartupConfiguration = { ...f.config,
    coordinator: { ...f.config.coordinator, quality } };
  let app!: PrivateApplication, installs = 0, opens = 0, completedPreflights = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: x.f.clock,
    openDatabase: database => {
      opens++; const resource = f.openDatabase(database);
      const client: DatabaseClient = { ...resource.client, transaction: async work => {
        const value = await resource.client.transaction(work); completedPreflights++; return value;
      } };
      return { ...resource, client };
    },
    install: value => { assert.equal(completedPreflights, 2); app = value; installs++; },
  });

  const runtime = await bootstrap.start(config);
  assert.equal(opens, 2); assert.equal(installs, 1); assert.equal(runtime.isReady(), true);
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "isReady", "quality"]);
  assert.deepEqual(Object.keys(app).sort(), ["close", "handle", "isReady", "quality"]);
  assert.ok(runtime.quality);
  assert.deepEqual(Object.keys(runtime.quality).sort(), ["reconcile", "tenantId", "workspaceId"]);
  assert.equal(runtime.quality.tenantId, x.f.scope.tenantId);
  assert.equal(runtime.quality.workspaceId, x.f.scope.workspaceId);
  const exposed = JSON.stringify({ runtime, quality: runtime.quality });
  for (const forbidden of ["client", "database", "password", "integrityKey", "harnessIntegrityKey", "synthetic-only"])
    assert.equal(exposed.includes(forbidden), false, forbidden);

  const input = qualityRequest(x);
  const pending = await runtime.quality.reconcile(input, new AbortController().signal);
  assert.equal(pending.disposition, "waiting_review"); assert.equal(pending.verification, "recorded");
  assert.equal(pending.grantsApproval, false); assert.equal(pending.grantsExecutionAuthority, false);
  assert.deepEqual({ tenantId: pending.tenantId, projectId: pending.projectId, jobId: pending.jobId, runId: pending.runId,
    targetDigest: pending.targetDigest, contentHash: pending.contentHash }, input);
  assert.equal((await x.states()).job.state, "leased");

  const reviewPath = `/api/v1/projects/${input.projectId}/tasks/${input.jobId}/results/${x.artifact.artifactId}/reviews/${x.target.id}`;
  const review = await app.handle(request(reviewPath, "POST", { artifactId: x.artifact.artifactId, targetId: x.target.id,
    targetDigest: input.targetDigest, contentHash: input.contentHash, decision: "accepted", feedback: "" },
  "quality-startup-review-001", x.f.jwt), () => new Response("shell"));
  assert.equal(review.status, 201, await review.clone().text());
  const completed = await runtime.quality.reconcile(input, new AbortController().signal);
  assert.equal(completed.disposition, "completed"); assert.equal(completed.verification, "replayed");
  assert.equal(completed.grantsApproval, false); assert.equal(completed.grantsExecutionAuthority, false);
  assert.equal(completed.completion.replayed, false); assert.equal(completed.completion.receipt.jobId, input.jobId);
  assert.equal((await x.states()).job.state, "succeeded");

  const route = `/api/v1/projects/${input.projectId}/tasks/${input.jobId}/quality`;
  assert.equal((await app.handle(request(route, "GET", undefined, undefined, x.f.jwt), () => new Response("shell"))).status, 404);
  const retained = runtime.quality;
  const closing = runtime.close(); assert.equal(runtime.close(), closing); await closing;
  assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
  await assert.rejects(retained.reconcile(input, new AbortController().signal), { message: "task_coordinator_unavailable" });
});

test("startup without quality configuration exposes no quality capability", async t => {
  const f = await taskStartupFixture(); t.after(f.close);
  let app!: PrivateApplication;
  const runtime = await createPrivateTaskBootstrap({ openDatabase: f.openDatabase, install: value => { app = value; } }).start(f.config);
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "isReady"]);
  assert.deepEqual(Object.keys(app).sort(), ["close", "handle", "isReady"]);
  assert.equal("quality" in runtime, false); assert.equal("quality" in app, false);
  await runtime.close(); assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
});

test("startup deeply captures quality keys and rule arrays, while cross-key failures open no pools", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const f = await taskStartupFixture(x.f.assignmentFixture);
  const quality = qualityConfiguration(x);
  const bootstrap = createPrivateTaskBootstrap({ clock: x.f.clock, openDatabase: f.openDatabase, install: () => {} });
  const starting = bootstrap.start({ ...f.config, coordinator: { ...f.config.coordinator, quality } });
  quality.integrityKey.fill(0); quality.harnessIntegrityKey.fill(0); quality.results.integrityKey.fill(0);
  const rules = quality.scenarios[0]!.rules;
  (rules.requiredHeadings as string[])[0] = "Mutated";
  (rules.forbiddenTerms as string[]).push("useful synthetic document");
  const runtime = await starting; assert.ok(runtime.quality);
  const outcome = await runtime.quality.reconcile(qualityRequest(x), new AbortController().signal);
  assert.equal(outcome.disposition, "waiting_review"); assert.equal(outcome.verification, "recorded");
  await runtime.close();

  const variants = [
    (value: TaskQualityConfiguration) => ({ ...value, integrityKey: differentKey(x.f.ownerConfig.integrityKey) }),
    (value: TaskQualityConfiguration) => ({ ...value, harnessIntegrityKey: differentKey(x.f.ownerConfig.harnessIntegrityKey) }),
    (value: TaskQualityConfiguration) => ({ ...value, results: { ...value.results,
      integrityKey: differentKey(x.f.ownerConfig.results.integrityKey) } }),
  ];
  let effects = 0;
  for (const alter of variants) {
    const invalid = alter(qualityConfiguration(x));
    const denied = createPrivateTaskBootstrap({ openDatabase: () => { effects++; throw new Error("must not open"); }, install: () => { effects++; } });
    await assert.rejects(denied.start({ ...f.config, coordinator: { ...f.config.coordinator, quality: invalid } }),
      { message: "private_task_startup_config_invalid" });
  }
  assert.equal(effects, 0);
});

test("a failed web preflight never invokes or exposes configured quality", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const f = await taskStartupFixture(x.f.assignmentFixture);
  const quality = qualityConfiguration(x); let qualityCalls = 0, installs = 0, opens = 0;
  const read = quality.results.storage.read.bind(quality.results.storage);
  quality.results = { ...quality.results, storage: { async read(...args: Parameters<typeof read>) {
    qualityCalls++; return read(...args);
  } } };
  await f.raw.exec("REVOKE SELECT ON projects FROM control_room_private_web");
  const bootstrap = createPrivateTaskBootstrap({ clock: x.f.clock,
    openDatabase: database => { opens++; return f.openDatabase(database); }, install: () => { installs++; } });
  await assert.rejects(bootstrap.start({ ...f.config, coordinator: { ...f.config.coordinator, quality } }),
    { message: "private_task_startup_prerequisites_failed" });
  assert.equal(opens, 1); assert.equal(installs, 0); assert.equal(qualityCalls, 0);
  assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 0);
});

test("quality reconciliation obeys graceful drain, cancellation, and forced-timeout uncertainty", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const input = qualityRequest(x);
  const base = (client: DatabaseClient, close: () => Promise<void>, isAvailable: () => boolean, drainMs = 1000) => ({
    scope: x.f.scope, planning: x.f.plannerConfig, routes: [x.f.route], quality: qualityConfiguration(x),
    database: { client, close, isAvailable }, clock: x.f.clock, drainMs,
  });

  const entered = deferred(), release = deferred(); let closes = 0, available = true, first = true;
  const draining: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: async (work, check) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return x.f.db.transactionWithPreCommitCheck(work, check);
  } };
  const owner = createTaskCoordinatorLifecycle(base(draining, async () => { closes++; available = false; }, () => available));
  const saving = owner.quality!.reconcile(input, new AbortController().signal); await entered.promise;
  const closing = owner.close(); assert.equal(owner.isReady(), false); assert.equal(closes, 0);
  release.resolve(); assert.equal((await saving).disposition, "waiting_review"); await closing; assert.equal(closes, 1);
  await assert.rejects(owner.quality!.reconcile(input, new AbortController().signal), { message: "task_coordinator_unavailable" });

  const cancelEntered = deferred(), cancelRelease = deferred();
  const cancellable: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: async (work, check) => {
    cancelEntered.resolve(); await cancelRelease.promise; return x.f.db.transactionWithPreCommitCheck(work, check);
  } };
  let cancelAvailable = true;
  const cancelled = createTaskCoordinatorLifecycle(base(cancellable, async () => { cancelAvailable = false; }, () => cancelAvailable));
  const abort = new AbortController();
  const cancelledSave = cancelled.quality!.reconcile(input, abort.signal); await cancelEntered.promise;
  abort.abort(); cancelRelease.resolve();
  await assert.rejects(cancelledSave, { message: "task_quality_unavailable" }); await cancelled.close();

  const timeoutEntered = deferred(), timeoutRelease = deferred(), finished = deferred();
  const timed: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: async (work, check) => {
    timeoutEntered.resolve(); await timeoutRelease.promise;
    try { return await x.f.db.transactionWithPreCommitCheck(work, check); } finally { finished.resolve(); }
  } };
  let timeoutCloses = 0, timeoutAvailable = true;
  const timedOut = createTaskCoordinatorLifecycle(base(timed, async () => { timeoutCloses++; timeoutAvailable = false; },
    () => timeoutAvailable, 5));
  const uncertain = assert.rejects(timedOut.quality!.reconcile(input, new AbortController().signal),
    { message: "task_coordinator_save_uncertain" });
  await timeoutEntered.promise;
  await assert.rejects(timedOut.close(), { message: "task_coordinator_close_uncertain" }); await uncertain;
  assert.equal(timeoutCloses, 1); timeoutRelease.resolve(); await finished.promise;
  await assert.rejects(timedOut.close(), { message: "task_coordinator_close_uncertain" }); assert.equal(timeoutCloses, 1);
});
