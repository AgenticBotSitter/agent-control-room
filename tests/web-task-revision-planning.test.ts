import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualityCompletionFixture, qualityText } from "./helpers/native-quality-completion";
import { taskStartupFixture } from "./helpers/task-startup";
import { origin, request } from "./helpers/web-foundation";
import { createPrivateTaskBootstrap } from "../src/web/v1/private-task-startup";
import { createPrivateWebProcess, type PrivateApplication } from "../src/web/v1/private-process";
import { createPrivateWebBootstrap } from "../src/web/v1/private-startup";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { WebTaskService } from "../src/web/v1/task-service";
import { taskReviewOptionsSchema } from "../src/web/v1/task-review-wire";
import { taskRevisionCommandSchema, type TaskRevisionRequest } from "../src/web/v1/task-revision-wire";
import type { TaskRevisionOperation } from "../src/web/v1/task-revision-operation";
import type { DatabaseClient } from "../src/persistence/database";
import { hmacSha256Tag, sha256Digest } from "../src/security";

async function fixture(connected = true) {
  const x = await nativeQualityCompletionFixture();
  try {
    const f = await taskStartupFixture(x.f.assignmentFixture);
    let app!: PrivateApplication, opens = 0, preflights = 0;
    const runtime = await createPrivateTaskBootstrap({ clock: x.f.clock,
      openDatabase: config => {
        opens++; const pool = f.openDatabase(config);
        return { ...pool, client: { ...pool.client, transaction: async work => {
          const result = await pool.client.transaction(work); preflights++; return result;
        } } satisfies DatabaseClient };
      }, install: value => { assert.equal(preflights, 2); app = value; },
    }).start({ ...f.config, coordinator: { ...f.config.coordinator,
      quality: { ...x.f.ownerConfig, scenarios: [x.scenario] }, ...(connected ? { revisionPlanning: true as const } : {}) } });
    assert.equal(opens, 2);
    const path = `/api/v1/projects/${x.registration.projectId}/tasks/${x.registration.jobId}/revisions`;
    const reviewPath = `/api/v1/projects/${x.registration.projectId}/tasks/${x.registration.jobId}/results/${x.artifact.artifactId}/reviews/${x.target.id}`;
    const handle = (req: Request) => app.handle(req, () => new Response("synthetic-shell"));
    const req = (body?: unknown, route = path, method = "POST") => {
      const value = request(route, method, body, undefined, x.f.jwt);
      if (route !== reviewPath) value.headers.delete("idempotency-key");
      return value;
    };
    const options = async () => {
      const response = await handle(req(undefined, reviewPath, "GET")); assert.equal(response.status, 200, await response.clone().text());
      return taskReviewOptionsSchema.parse(await response.json());
    };
    const saveReview = async (): Promise<TaskRevisionRequest> => {
      const response = await handle(req({ artifactId: x.artifact.artifactId, targetId: x.target.id,
        targetDigest: x.request.targetDigest, contentHash: x.request.contentHash,
        decision: "changes_requested", feedback: "Please improve the evidence." }, reviewPath));
      assert.equal(response.status, 201, await response.clone().text());
      const saved = (await options()).ownReview!; assert.ok(saved);
      return { runId: x.request.runId, targetId: saved.targetId, targetDigest: saved.targetDigest,
        contentHash: saved.contentHash, reviewId: saved.reviewId, feedback: saved.feedback };
    };
    const rows = () => f.coordinator.client.query<{ plan: Record<string, unknown>; auth_tag: string }>(
      "SELECT plan,auth_tag FROM control_task_execution_plans WHERE tenant_id=$1 AND source_job_id=$2", [x.request.tenantId, x.registration.jobId]);
    const evidence = async () => {
      const saved: Record<string, unknown> = {};
      // Explicit coordinator observer avoids relying on PGlite's ambient one-backend session identity.
      for (const table of ["control_jobs", "control_attempts", "control_leases", "control_harness_runs", "control_artifact_manifests"])
        saved[table] = (await f.coordinator.client.query(`SELECT * FROM ${table} WHERE ${table === "control_jobs" ? "id" : "job_id"}=$1 ORDER BY id`, [x.registration.jobId])).rows;
      saved.gate = (await f.coordinator.client.query("SELECT * FROM control_completion_gate_records ORDER BY id")).rows;
      saved.outbox = (await f.coordinator.client.query("SELECT * FROM control_outbox ORDER BY id")).rows;
      saved.checkpoint = x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`);
      saved.calls = [...x.local.calls]; saved.effects = x.local.effects.countFull(); return saved;
    };
    const service = new WebTaskService(f.web.client, x.f.scope, x.f.clock, f.config.web.tasks);
    const handler = (revisions?: TaskRevisionOperation) => createTaskHttpHandler({ origin, trust: x.f.accessTrust, service, revisions, clock: x.f.clock });
    return { x, f, app, runtime, path, reviewPath, req, handle, options, saveReview, rows, evidence, handler,
      close: async () => { await runtime.close(); await x.close(); } };
  } catch (error) { await x.close(); throw error; }
}

test("both restricted startup roles mount recorded owner feedback into one proposed signed revision through protected HTTP", async t => {
  const f = await fixture(); t.after(f.close);
  const initial = await f.options(); assert.equal(initial.revisionPlanning, "configured"); assert.equal(initial.ownReview, null);
  assert.deepEqual((await f.rows()).rows, []);
  const body = await f.saveReview(), before = await f.evidence();
  const response = await f.handle(f.req(body)); assert.equal(response.status, 201, await response.clone().text());
  const saved = taskRevisionCommandSchema.parse(await response.json()), { receipt } = saved;
  assert.equal(saved.replayed, false); assert.equal(receipt.startsWork, false); assert.equal(receipt.grantsExecutionAuthority, false);
  assert.equal(receipt.executionAvailability, "requires_separate_assignment_and_approval");
  assert.deepEqual([receipt.fromRunId, receipt.fromTargetId, receipt.fromTargetDigest, receipt.fromContentHash, receipt.reviewId, receipt.feedbackDigest],
    [body.runId, body.targetId, body.targetDigest, body.contentHash, body.reviewId, sha256Digest(body.feedback)]);
  assert.equal(receipt.sourceJobId, f.x.registration.jobId); assert.notEqual(receipt.jobId, receipt.sourceJobId);
  const stored = (await f.rows()).rows; assert.equal(stored.length, 1);
  assert.equal(stored[0].plan.schema, "control-room.task-execution-plan/v2");
  assert.equal(stored[0].auth_tag, hmacSha256Tag(f.x.f.plannerConfig.integrityKey, { purpose: "task-execution-plan/v2", plan: stored[0].plan }));
  const plan = stored[0].plan as { input: { prompt: string }; job: { state: string }; request: { state: string }; workflow: { state: string } };
  assert.deepEqual([plan.request.state, plan.workflow.state, plan.job.state], ["draft", "proposed", "proposed"]);
  assert.equal(JSON.parse(plan.input.prompt).previousResult, qualityText); assert.equal(JSON.parse(plan.input.prompt).requestedChanges, body.feedback);
  const replayResponse = await f.handle(f.req(body)); assert.equal(replayResponse.status, 200);
  assert.deepEqual(taskRevisionCommandSchema.parse(await replayResponse.json()), { ...saved, replayed: true });
  assert.equal((await f.rows()).rows.length, 1);
  assert.equal((await f.f.coordinator.client.query("SELECT id FROM audit_events WHERE target_id=$1", [receipt.jobId])).rows.length, 1);
  for (const table of ["control_attempts", "control_leases"])
    assert.deepEqual((await f.f.coordinator.client.query(`SELECT id FROM ${table} WHERE job_id=$1`, [receipt.jobId])).rows, []);
  assert.deepEqual(await f.evidence(), before);
  await assert.rejects(f.f.web.client.query("SELECT * FROM control_task_execution_plans"));
  for (const r of [response, replayResponse]) {
    assert.equal(r.headers.get("cache-control"), "no-store"); assert.match(r.headers.get("x-robots-tag")!, /noindex/);
  }
  await f.runtime.close(); assert.equal(f.f.web.closes(), 1); assert.equal(f.f.coordinator.closes(), 1);
  assert.equal((await f.handle(f.req(body))).status, 503);
});

test("disconnected revision planning is unavailable and its protected configuration indicator never creates work", async t => {
  const f = await fixture(false); t.after(f.close);
  assert.equal(f.runtime.revisions, undefined); assert.equal((await f.options()).revisionPlanning, "not_connected");
  const body = await f.saveReview(), before = await f.evidence();
  assert.equal((await f.handle(f.req(body))).status, 503);
  assert.equal((await f.options()).revisionPlanning, "not_connected");
  assert.deepEqual((await f.rows()).rows, []); assert.deepEqual(await f.evidence(), before);
});

test("protected revision route rejects malformed bodies, route identities, origin and revoked sessions before injected operations", async t => {
  const f = await fixture(); t.after(f.close); const body = await f.saveReview(), before = await f.evidence(); let calls = 0;
  const handler = f.handler({ ...f.x.f.scope, async plan() { calls++; throw new Error("must_not_run"); } });
  const invalid: Request[] = [f.req(body, `${f.path}?x=1`), f.req(body, f.path.replace(f.x.registration.projectId, "%ZZ")),
    f.req(body, f.path.replace(f.x.registration.projectId, "a%2Fb")), f.req(), f.req({ ...body, feedback: "x".repeat(17000) }),
    ...[{ authority: {} }, { nodeId: "node:other" }, { idempotencyKey: "caller" }, { feedback: " unsaved " }, { runId: "bad/id" }].map(patch => f.req({ ...body, ...patch }))];
  const wrongType = f.req(body); wrongType.headers.set("content-type", "text/plain"); invalid.push(wrongType);
  for (const key of ["caller-selected-key", ""]) {
    const keyed = f.req(body); keyed.headers.set("idempotency-key", key); invalid.push(keyed);
  }
  const malformed = new Request(f.req().url, { method: "POST", headers: f.req().headers, body: "{" }); invalid.push(malformed);
  for (const req of invalid) assert.equal((await handler(req)).status, 400);
  for (const method of ["GET", "DELETE"]) assert.equal((await handler(f.req(undefined, f.path, method))).status, 404);
  const cross = f.req(body); cross.headers.set("origin", "https://other.example.invalid"); assert.equal((await handler(cross)).status, 403);
  const missing = f.req(body); missing.headers.delete("cf-access-jwt-assertion"); assert.equal((await handler(missing)).status, 401);
  assert.equal((await f.handle(f.req(undefined, "/api/v1/session/logout"))).status, 204);
  assert.equal((await handler(f.req(body))).status, 401); assert.equal((await f.handle(f.req(undefined, f.reviewPath, "GET"))).status, 401);
  assert.equal(calls, 0); assert.deepEqual((await f.rows()).rows, []); assert.deepEqual(await f.evidence(), before);
});

test("real coordinator rejects changed saved feedback, review, content and source without proposing a child", async t => {
  const f = await fixture(); t.after(f.close); const body = await f.saveReview(), before = await f.evidence();
  for (const patch of [{ feedback: "Different requested change." }, { reviewId: "review:other" }, { contentHash: sha256Digest("different") },
    { targetDigest: sha256Digest("different target") }, { runId: "run:other" }]) {
    const response = await f.handle(f.req({ ...body, ...patch })); assert.ok(response.status >= 400, await response.clone().text());
  }
  assert.ok((await f.handle(f.req(body, f.path.replace(f.x.registration.jobId, "job:other")))).status >= 400);
  assert.deepEqual((await f.rows()).rows, []); assert.deepEqual(await f.evidence(), before);
});

test("HTTP validates every exact returned revision receipt binding and strips no unrecognized authority fields", async t => {
  const f = await fixture(); t.after(f.close); const body = await f.saveReview();
  const saved = taskRevisionCommandSchema.parse(await (await f.handle(f.req(body))).json()), before = await f.evidence();
  for (const patch of [{ projectId: "project:other" }, { sourceJobId: "job:other" }, { jobId: f.x.registration.jobId },
    { fromRunId: "run:other" }, { fromTargetId: "target:other" }, { fromTargetDigest: sha256Digest("other") },
    { fromContentHash: sha256Digest("other") }, { reviewId: "review:other" }, { feedbackDigest: sha256Digest("other") },
    { startsWork: true }, { grantsExecutionAuthority: true }, { approval: true }]) {
    const handler = f.handler({ ...f.x.f.scope, async plan() { return { ...saved, receipt: { ...saved.receipt, ...patch } } as never; } });
    const response = await handler(f.req(body)); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "service_unavailable" });
  }
  assert.deepEqual(await f.evidence(), before); assert.equal((await f.rows()).rows.length, 1);
});

test("revision HTTP passes the actual request signal and frozen exact body to the mounted operation", async t => {
  const f = await fixture(); t.after(f.close); const body = await f.saveReview(); let entered!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; }); const abort = new AbortController();
  const req = new Request(f.req(body), { signal: abort.signal });
  const handler = f.handler({ ...f.x.f.scope, async plan(identity, projectId, sourceJobId, draft, signal) {
    assert.equal(identity.subject, f.x.f.identity.subject); assert.equal(projectId, f.x.registration.projectId);
    assert.equal(sourceJobId, f.x.registration.jobId); assert.deepEqual(draft, body); assert.equal(Object.isFrozen(draft), true);
    assert.equal(signal, req.signal); entered();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    assert.equal(signal.aborted, true); throw new Error("synthetic_request_cancelled");
  } });
  const pending = handler(req); await admitted; abort.abort(); assert.equal((await pending).status, 503);
  const cancelled = new Request(f.req(body), { signal: abort.signal });
  assert.equal((await f.handle(cancelled)).status, 503); assert.deepEqual((await f.rows()).rows, []);
});

test("private composition captures the scoped operation and rejects cross-scope or ordinary one-pool injection", async t => {
  const f = await fixture(); t.after(f.close); const body = await f.saveReview();
  const saved = taskRevisionCommandSchema.parse(await (await f.handle(f.req(body))).json()); let capturedCalls = 0, replacedCalls = 0;
  const operation: TaskRevisionOperation = { ...f.x.f.scope, async plan() { capturedCalls++; return saved; } };
  const options = { ...f.f.config.web, database: { client: f.f.web.client, close: async () => {} }, clock: f.x.f.clock };
  const app = createPrivateWebProcess({ ...options, revisions: operation }); t.after(() => app.close());
  operation.plan = async () => { replacedCalls++; throw new Error("mutated_operation"); };
  assert.equal((await app.handle(f.req(body), () => new Response("shell"))).status, 201);
  assert.equal(capturedCalls, 1); assert.equal(replacedCalls, 0);
  let effects = 0;
  for (const scope of [{ tenantId: "tenant:other" }, { workspaceId: "workspace:other" }])
    assert.throws(() => createPrivateWebProcess({ ...options, loadKeys: async () => { effects++; return []; },
      revisions: { ...operation, ...scope } }), /invalid_private_app_config/);
  const bootstrap = createPrivateWebBootstrap({ openDatabase: () => { effects++; throw new Error("must_not_open"); },
    install: () => { effects++; throw new Error("must_not_install"); } });
  await assert.rejects(bootstrap.start({ ...f.f.config.web, revisions: operation } as never), /private_startup_config_invalid/);
  assert.equal(effects, 0);
});
