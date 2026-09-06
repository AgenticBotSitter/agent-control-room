import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { createTaskRevisionBrowserClient, revisionRequestFromReview } from "../src/web/v1/task-revision-browser-client.ts";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { request, origin } from "./helpers/web-foundation.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { createPrivateNodeHandler, loadPrivateClientAssets } from "../dist-vps/server/serving.js";
import { nodeExchange } from "./helpers/web-node.ts";

test("compiled protected interface prepares and reconciles one exact saved owner revision without starting work", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  const canonical = new CanonicalStore(startup.coordinator.client);
  const runtime = await createPrivateTaskBootstrap({ clock: x.f.clock, install: installPrivateApplication,
    openDatabase: startup.openDatabase }).start({ ...startup.config, coordinator: { ...startup.config.coordinator,
      quality: { ...x.f.ownerConfig, scenarios: [x.scenario] }, revisionPlanning: true,
    } });
  t.after(() => runtime.close());
  assert.equal(runtime.isReady(), true); assert.ok(runtime.revisions);
  const bridge = createPrivateNodeHandler({ origin, application: runtime, handler,
    assets: await loadPrivateClientAssets(await realpath("dist-vps/client")) });
  t.after(() => bridge.close());
  async function send(webRequest) {
    const url = new URL(webRequest.url);
    const exchange = nodeExchange({ path: `${url.pathname}${url.search}`, method: webRequest.method,
      headers: [...webRequest.headers].flat(), body: webRequest.body ? await webRequest.text() : undefined });
    await bridge.handle(exchange.input, exchange.output);
    return new Response(exchange.body(), { status: exchange.output.statusCode, headers: exchange.headers });
  }

  const projectId = x.registration.projectId, sourceJobId = x.registration.jobId;
  const reviewPath = `/api/v1/projects/${projectId}/tasks/${sourceJobId}/results/${x.artifact.artifactId}/reviews/${x.target.id}`;
  const feedback = "Prepare a clearer explanation of the recorded evidence.";
  const reviewDraft = { artifactId: x.artifact.artifactId, targetId: x.target.id, targetDigest: x.request.targetDigest,
    contentHash: x.request.contentHash, decision: "changes_requested", feedback };
  const denied = await send(new Request(`${origin}${reviewPath}`, { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify(reviewDraft) }));
  assert.equal(denied.status, 401);
  const page = await send(request(`/projects/${projectId}/tasks/${sourceJobId}`, "GET", undefined, undefined, x.f.jwt));
  assert.equal(page.status, 200); assert.match(await page.text(), /Task progress · Control Room/);
  const reviewed = await send(request(reviewPath, "POST", reviewDraft, "compiled-owner-revision-review-001", x.f.jwt));
  assert.equal(reviewed.status, 201, await reviewed.clone().text());
  const reviewReceipt = (await reviewed.json()).receipt; assert.equal(reviewReceipt.startsRevision, false);
  const optionsResponse = await send(request(reviewPath, "GET", undefined, undefined, x.f.jwt));
  assert.equal(optionsResponse.status, 200, await optionsResponse.clone().text());
  const options = await optionsResponse.json();
  assert.equal(options.revisionPlanning, "configured"); assert.equal(options.ownReview.reviewId, reviewReceipt.reviewId);
  assert.equal(options.ownReview.findingId, reviewReceipt.findingId); assert.equal(options.ownReview.artifactId, x.artifact.artifactId);
  assert.equal(options.ownReview.targetId, x.target.id); assert.equal(options.ownReview.targetDigest, x.request.targetDigest);
  assert.equal(options.ownReview.contentHash, x.request.contentHash); assert.equal(options.ownReview.feedback, feedback);
  const draft = revisionRequestFromReview(x.registration.id, options); assert.ok(draft);

  const source = {
    job: await canonical.get(x.request.tenantId, "job", sourceJobId),
    attempt: await canonical.get(x.request.tenantId, "attempt", x.registration.attemptId),
    lease: await canonical.get(x.request.tenantId, "lease", x.registration.nativeTask.leaseId),
    target: await x.f.reviewStore.snapshot(x.request.tenantId, x.target.id),
    checkpoint: x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`),
  };
  const nativeCalls = [...x.local.calls], nativeEffects = x.local.effects.countFull();
  const plansBefore = (await startup.coordinator.client.query("SELECT job_id FROM control_task_execution_plans ORDER BY job_id")).rows;
  const revisionPath = `/api/v1/projects/${projectId}/tasks/${sourceJobId}/revisions`;
  const callerKey = await send(request(revisionPath, "POST", draft, "caller-selected-revision-key", x.f.jwt));
  assert.equal(callerKey.status, 400); assert.equal((await startup.coordinator.client.query(
    "SELECT job_id FROM control_task_execution_plans")).rows.length, plansBefore.length);
  const statuses = [], bodies = [];
  const client = createTaskRevisionBrowserClient(async (url, init) => {
    const browserHeaders = new Headers(init?.headers);
    assert.equal(browserHeaders.has("idempotency-key"), false); bodies.push(String(init?.body));
    browserHeaders.set("cf-access-jwt-assertion", x.f.jwt); browserHeaders.set("origin", origin);
    const response = await send(new Request(`${origin}${url}`, { ...init, headers: browserHeaders }));
    statuses.push(response.status); return response;
  });
  const saved = await client.prepare(projectId, sourceJobId, draft);
  assert.deepEqual(statuses, [201]); assert.equal(saved.sourceJobId, sourceJobId); assert.notEqual(saved.jobId, sourceJobId);
  assert.equal(saved.fromRunId, x.registration.id); assert.equal(saved.fromTargetId, x.target.id);
  assert.equal(saved.fromTargetDigest, x.request.targetDigest); assert.equal(saved.fromContentHash, x.request.contentHash);
  assert.equal(saved.reviewId, reviewReceipt.reviewId); assert.equal(saved.revisionNumber, 1);
  assert.equal(saved.startsWork, false); assert.equal(saved.grantsExecutionAuthority, false);
  assert.equal(saved.executionAvailability, "requires_separate_assignment_and_approval");
  const child = await canonical.get(x.request.tenantId, "job", saved.jobId);
  assert.equal(child.state, "proposed"); assert.equal(child.version, 0); assert.equal(child.projectId, projectId);
  const workflow = await canonical.get(x.request.tenantId, "workflow", child.workflowId);
  const childRequest = await canonical.get(x.request.tenantId, "request", workflow.requestId);
  assert.equal(workflow.state, "proposed"); assert.deepEqual(workflow.jobIds, [child.id]); assert.equal(childRequest.state, "draft");
  assert.equal((await startup.coordinator.client.query("SELECT id FROM control_attempts WHERE job_id=$1", [child.id])).rows.length, 0);
  assert.equal((await startup.coordinator.client.query("SELECT job_id FROM control_task_execution_plans")).rows.length, plansBefore.length + 1);
  assert.deepEqual(await canonical.get(x.request.tenantId, "job", sourceJobId), source.job);
  assert.deepEqual(await canonical.get(x.request.tenantId, "attempt", x.registration.attemptId), source.attempt);
  assert.deepEqual(await canonical.get(x.request.tenantId, "lease", x.registration.nativeTask.leaseId), source.lease);
  assert.deepEqual(await x.f.reviewStore.snapshot(x.request.tenantId, x.target.id), source.target);
  assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`), source.checkpoint);
  assert.deepEqual(x.local.calls, nativeCalls); assert.equal(x.local.effects.countFull(), nativeEffects);

  const replay = await client.prepare(projectId, sourceJobId, draft);
  assert.deepEqual(statuses, [201, 200]); assert.deepEqual(replay, saved);
  assert.equal(new Set(bodies).size, 1);
  assert.equal((await startup.coordinator.client.query("SELECT id FROM audit_events WHERE action='tasks.revisions.plan' AND target_id=$1", [child.id])).rows.length, 1);
  assert.deepEqual(x.local.calls, nativeCalls); assert.equal(x.local.effects.countFull(), nativeEffects);
  await runtime.close(); assert.equal(runtime.isReady(), false);
  assert.equal(startup.web.closes(), 1); assert.equal(startup.coordinator.closes(), 1);
  assert.equal((await handler(request(reviewPath, "GET", undefined, undefined, x.f.jwt))).status, 503);
});

test("compiled browser assets exclude server-only revision planner internals", () => {
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const javascript = files("dist-vps/client").filter(file => file.endsWith(".js"));
  assert.ok(javascript.length > 0);
  for (const file of javascript) assert.doesNotMatch(readFileSync(file, "utf8"),
    /TaskExecutionPlanner|control-room\.task-execution-plan\/v2|tasks\.revisions\.plan|task_coordinator_save_uncertain/);
});
