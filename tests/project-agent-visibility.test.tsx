import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectAgentVisibilityView } from "../private-app/app/project-agent-workspace";
import { readProjectAgentVisibility, readTaskProjectAgentOptions,
  type ProjectAgentVisibilityRead } from "../src/web/v1/task-project-agents-browser-client";
import { taskProjectAgentOptionsSchema, type TaskProjectAgentOptions } from "../src/web/v1/task-project-agents-wire";
import type { TaskDetail } from "../src/web/v1/task-wire";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { origin, request, token, trust } from "./helpers/web-foundation";
import { binding, instant } from "./hermes-native-fixture";

const observedAt = "2026-09-04T12:00:08.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const options: TaskProjectAgentOptions = {
  projectId: binding.projectId,
  eligibilitySource: "configured",
  workers: [{
    nodeId: binding.nodeId,
    label: "Local Hermes worker",
    platform: "macos",
    eligibleTasks: [{ jobId: "job:one", title: "Review launch plan", inputDigest: digest,
      workScope: "bounded_text_review" }],
  }],
  tasksExamined: 1,
  additionalTasksOmitted: false,
  candidateEvidence: "configured_routes_only",
  observedAt,
  startsWork: false,
  grantsAssignmentAuthority: false,
  grantsExecutionAuthority: false,
};

function taskDetail(jobId: string, routeEvidence: "local_hermes" | "local_claude" = "local_claude"): TaskDetail {
  return {
    project: { projectId: binding.projectId, title: "Agent visibility", summary: "Fixture", origin: "ordinary",
      lifecycle: "active", version: 1, createdAt: observedAt, updatedAt: observedAt, lifecycleEditable: true },
    task: { jobId, projectId: binding.projectId, requestId: `request:${jobId.split(":").at(-1)}`, title: "Current project task",
      state: "running", version: 2, createdAt: observedAt, updatedAt: observedAt },
    instructions: "Review the bounded input", inputDigest: digest, observedAt,
    attempts: [{ attemptId: `attempt:${jobId.split(":").at(-1)}`, attemptNumber: 1, state: "running",
      runs: [{ runId: `run:${jobId.split(":").at(-1)}`, harness: "claude", state: "running", lastObservedAt: observedAt,
        stale: false, routeEvidence, firstObservedExecutionAt: observedAt, finishedObservedAt: null,
        cancellation: "requested", source: "native_snapshot", nativeState: "running", availability: "current",
        usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12, costUsd: null, hardCostLimitEnforced: false },
        resultClaim: null, timeline: [], earlierObservationsOmitted: false }], additionalRunsOmitted: false }],
    earlierAttemptsOmitted: false, preparedFor: "claude", localRouteObservation: { state: "configured_local_route", adapter: "claude" },
    hermesDeliveryRecovery: { source: "not_applicable" }, progressSource: "configured", dispatch: "configured",
    artifacts: "configured", review: "recorded",
  };
}

test("project agent wire keeps its read-only boundary and deterministic ordering", () => {
  assert.deepEqual(taskProjectAgentOptionsSchema.parse(options), options);
  assert.throws(() => taskProjectAgentOptionsSchema.parse({ ...options, grantsAssignmentAuthority: true }));
  assert.throws(() => taskProjectAgentOptionsSchema.parse({ ...options, eligibilitySource: "not_configured" }));
  assert.throws(() => taskProjectAgentOptionsSchema.parse({ ...options, workers: [
    { ...options.workers[0]!, nodeId: "node:z" }, { ...options.workers[0]!, nodeId: "node:a" },
  ] }));
});

test("browser reader uses one project-scoped GET and refuses a cross-project response", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify(options), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  assert.deepEqual(await readTaskProjectAgentOptions(binding.projectId, transport), options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input, `/api/v1/projects/${encodeURIComponent(binding.projectId)}/agents`);
  assert.equal(calls[0]!.init?.method, "GET");
  await assert.rejects(readTaskProjectAgentOptions("project:other", transport));
});

test("project reader propagates navigation cancellation to every independent source", async () => {
  let attached = 0;
  const transport = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    assert.ok(init?.signal); attached += 1;
    init.signal.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
  const controller = new AbortController();
  const reading = readProjectAgentVisibility(binding.projectId, transport, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  const result = await reading;
  assert.equal(attached, 4);
  assert.deepEqual(Object.values(result).map(value => value.state),
    ["unavailable", "unavailable", "unavailable", "unavailable", "unavailable"]);
});

test("project reader uses the protected detail GET for each bounded current task and preserves per-task failure", async () => {
  const overview = { projectId: binding.projectId,
    current: [taskDetail("job:one").task, { ...taskDetail("job:two").task, jobId: "job:two", requestId: "request:two" }],
    awaitingReview: [], recent: [], additionalCurrentOmitted: false, additionalReviewsOmitted: false,
    additionalRecentOmitted: false, observedAt, startsWork: false } as const;
  const calls: Array<{ path: string; method?: string; signal?: AbortSignal | null }> = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push({ path, method: init?.method, signal: init?.signal });
    if (path.endsWith("/overview")) return Response.json(overview);
    if (path.endsWith(`/tasks/${encodeURIComponent("job:one")}`)) return Response.json(taskDetail("job:one"));
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  const controller = new AbortController();
  const result = await readProjectAgentVisibility(binding.projectId, transport, controller.signal);
  assert.equal(result.agentWork.state, "ready");
  if (result.agentWork.state !== "ready") return;
  assert.deepEqual(result.agentWork.value.map(item => [item.jobId, item.detail.state]),
    [["job:one", "ready"], ["job:two", "unavailable"]]);
  for (const jobId of ["job:one", "job:two"])
    assert.equal(calls.filter(call => call.path.endsWith(`/tasks/${encodeURIComponent(jobId)}`)).length, 1);
  assert.ok(calls.every(call => call.method === "GET" && call.signal));
});

test("navigation cancellation reaches an in-flight exact task evidence read", async () => {
  const overview = { projectId: binding.projectId, current: [taskDetail("job:one").task], awaitingReview: [], recent: [],
    additionalCurrentOmitted: false, additionalReviewsOmitted: false, additionalRecentOmitted: false,
    observedAt, startsWork: false } as const;
  let detailAttached = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/overview")) return Response.json(overview);
    if (path.endsWith(`/tasks/${encodeURIComponent("job:one")}`)) return new Promise<Response>((_resolve, reject) => {
      assert.ok(init?.signal); detailAttached = true;
      init.signal.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  const controller = new AbortController();
  const reading = readProjectAgentVisibility(binding.projectId, transport, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  const result = await reading;
  assert.equal(detailAttached, true);
  assert.equal(result.agentWork.state, "ready");
  if (result.agentWork.state === "ready") assert.equal(result.agentWork.value[0]?.detail.state, "unavailable");
});

test("project view presents eligibility, availability, connections, and work as separate evidence", () => {
  const state: ProjectAgentVisibilityRead = {
    eligibility: { state: "ready", value: options },
    capacity: { state: "unavailable", code: "operator_surface_unavailable" },
    connections: { state: "unavailable", code: "unavailable" },
    currentWork: { state: "ready", value: {
      projectId: binding.projectId,
      current: [{ jobId: "job:two", projectId: binding.projectId, requestId: "request:two", title: "Current project task",
        state: "running", version: 2, createdAt: observedAt, updatedAt: observedAt }],
      awaitingReview: [], recent: [], additionalCurrentOmitted: false, additionalReviewsOmitted: false,
      additionalRecentOmitted: false, observedAt, startsWork: false,
    } },
    agentWork: { state: "ready", value: [{ jobId: "job:two", detail: { state: "ready", value: taskDetail("job:two") } }] },
  };
  const html = renderToStaticMarkup(createElement(ProjectAgentVisibilityView, {
    state: { state: "ready", value: state }, projectId: binding.projectId,
  }));
  assert.match(html, /Local Hermes worker/);
  assert.match(html, /text review only/);
  assert.match(html, /Capacity and availability evidence is unavailable; no status is inferred/);
  assert.match(html, /Connection inventory is unavailable with this read; no enrollment state is inferred/);
  assert.match(html, /Current project task/);
  assert.match(html, /Agent work evidence/);
  assert.match(html, /Task state:<\/strong> running/);
  assert.match(html, /Local Claude Code adapter/);
  assert.match(html, /Latest saved run state/);
  assert.match(html, /Not marked stale at read time/);
  assert.match(html, /Reported tokens/);
  assert.match(html, />12</);
  assert.match(html, /Cancellation/);
  assert.match(html, /requested/);
  assert.match(html, /Model evidence/);
  assert.match(html, /does not expose a saved model/);
  assert.match(html, /current work is not attributed to a worker here/i);
  assert.doesNotMatch(html, /Assign without starting|Start work|Reserve worker|<button|<form/);
});

test("sanitized connection pseudonyms are never joined to canonical eligible workers", () => {
  const pseudonymousOptions: TaskProjectAgentOptions = { ...options, workers: [{ ...options.workers[0]!,
    nodeId: "node:inventory:001" }] };
  const state: ProjectAgentVisibilityRead = {
    eligibility: { state: "ready", value: pseudonymousOptions },
    capacity: { state: "unavailable", code: "operator_surface_unavailable" },
    connections: { state: "ready", value: { telemetry: "not_configured", projection: {
      contractVersion: "control-room-connection-center/v1", tenantScoped: true, generatedAt: observedAt,
      sourceMode: "protected_enrollment_roster", inventoryState: "enrolled",
      safeStatusCode: "enrollment_present_qualification_required",
      reviewedRuntime: { releaseLine: "0.21", runtimeRevision: "abcdef0",
        sourceCandidateDigest: `sha256:${"b".repeat(64)}` },
      summary: { connectionCount: 1, localConnectionCount: 1, sshConnectionCount: 0,
        qualificationReadyCount: 0, nativeQualifiedCount: 0, livePanelEligibleCount: 0,
        currentSignalCount: 0, staleSignalCount: 0, missingSignalCount: 1, attentionCount: 1 },
      connections: [{ connectionReference: "connection:inventory:001", nodeReference: "node:inventory:001",
        transport: "local_loopback", runtimeRevision: "abcdef0", runtimeCompatibility: "reviewed_exact_revision",
        enrollmentState: "accepted", profileState: "eligible", qualificationState: "required",
        livePanelState: "blocked", diagnosticState: "setup_required", signalFreshness: "missing",
        signalFreshnessBasis: "none", signalObservedAt: null, signalExpiresAt: null,
        blockerCodes: ["native_qualification_missing", "owner_effect_window_missing",
          "admission_authority_not_configured", "live_driver_not_configured"],
        enrolledAt: observedAt, enrollmentExpiresAt: "2026-10-04T12:00:08.000Z", lastEvaluatedAt: observedAt,
        locationVisible: false, credentialMaterialVisible: false, nativeLocatorVisible: false,
        presentationOnly: true, grantsApproval: false, grantsCommandAuthority: false,
        grantsLeaseAuthority: false, grantsExecutionAuthority: false }],
      containsNativeLocators: false, containsProtectedValueMaterial: false, presentationOnly: true,
      grantsApproval: false, grantsNetworkAuthority: false, grantsCommandAuthority: false,
      grantsLeaseAuthority: false, grantsExecutionAuthority: false,
      projectionDigest: `sha256:${"c".repeat(64)}`,
    } } },
    currentWork: { state: "unavailable", code: "unavailable" },
    agentWork: { state: "unavailable", code: "unavailable" },
  };
  const html = renderToStaticMarkup(createElement(ProjectAgentVisibilityView, {
    state: { state: "ready", value: state }, projectId: binding.projectId,
  }));
  assert.match(html, /1 sanitized connection record/);
  assert.match(html, /not joined to workers/);
  assert.doesNotMatch(html, /saved enrollment is visible for this eligible worker/i);
});

test("project aggregation reuses task assignment eligibility and stops listing an assigned task", async t => {
  const fixture = await taskAssignmentFixture();
  t.after(fixture.close);
  const detail = await fixture.coordinator.options(fixture.identity, binding.projectId, fixture.prepared.receipt.jobId);
  const project = await fixture.coordinator.projectOptions(fixture.identity, binding.projectId);
  assert.equal(project.workers.length, 1);
  assert.deepEqual(project.workers[0], {
    nodeId: detail.candidates[0]!.nodeId,
    label: detail.candidates[0]!.label,
    platform: detail.candidates[0]!.platform,
    eligibleTasks: [{ jobId: fixture.prepared.receipt.jobId, title: fixture.sourceDraft.title,
      inputDigest: detail.inputDigest, workScope: detail.candidates[0]!.workScope }],
  });
  assert.equal(project.startsWork, false);
  assert.equal(project.grantsAssignmentAuthority, false);
  const app = createPrivateWebProcess({ origin, ...trust, tenantId: fixture.scope.tenantId,
    workspaceId: fixture.scope.workspaceId, database: { client: fixture.db, close: async () => undefined },
    clock: () => instant, loadKeys: async () => trust.keys, assignment: fixture.coordinator.webOperation() });
  t.after(() => app.close());
  const path = `/api/v1/projects/${encodeURIComponent(binding.projectId)}/agents`;
  const jwt = token({ iat: instant / 1000 - 60, exp: instant / 1000 + 300 });
  const response = await app.handle(request(path, "GET", undefined, "project-agent-read-0001", jwt),
    () => new Response("unexpected fallback", { status: 500 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), project);
  assert.equal((await app.handle(request(path, "POST", undefined, "project-agent-read-0002", jwt),
    () => new Response("unexpected fallback", { status: 500 }))).status, 400);
  assert.equal((await app.handle(request(`/api/v1/projects/${encodeURIComponent("project:other")}/agents`, "GET", undefined,
    "project-agent-read-0003", jwt),
    () => new Response("unexpected fallback", { status: 500 }))).status, 404);
  await fixture.assign();
  const assigned = await fixture.coordinator.projectOptions(fixture.identity, binding.projectId);
  assert.equal(assigned.workers.length, 0);
  await assert.rejects(fixture.coordinator.projectOptions(fixture.identity, "project:other"));
});
