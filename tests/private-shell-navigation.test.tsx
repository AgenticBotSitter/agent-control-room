import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../private-app/app/page";
import { HomeDashboard, HomeInstallationStatus, type HomeDashboardState } from "../private-app/app/home-workspace";
import SettingsPage from "../private-app/app/settings/page";
import { PrivateProjectWorkspace, ProjectAgentInstallationStatus } from "../private-app/app/workspace";
import { ProjectCatalogNavigation } from "../app/components/project-catalog-navigation";
import { createProjectBrowserClient } from "../src/web/v1/browser-client";
import { readTaskHomeActivity } from "../src/web/v1/task-home-browser-client";
import { ProjectOverviewActivityView } from "../private-app/app/project-overview-activity";
import { PrivateTaskResults, readTaskResultSelectionV1, taskResultHrefV1 } from "../private-app/app/task-results";
import { readTaskProjectOverview } from "../src/web/v1/task-project-overview-browser-client";
import { ProjectFilesView } from "../private-app/app/project-files-workspace";
import { readTaskProjectFiles } from "../src/web/v1/task-project-files-browser-client";
import { ProjectNavigation } from "../private-app/app/project-navigation";
import { ProjectTaskViewPanel } from "../private-app/app/project-task-views";
import { ProjectResultReviewPanel } from "../private-app/app/project-result-review-workspace";
import { readTaskProjectAttention } from "../src/web/v1/task-project-attention-browser-client";
import { decodePrivateRouteSegment } from "../private-app/app/route-segment";
import { PrivateConnectionView } from "../private-app/app/connections/workspace";
import { InstallationTopologySummary } from "../private-app/app/installation-topology-summary";
import { LocalWorkerRouteStatus } from "../private-app/app/local-worker-route-status";
import { TaskProposalForm } from "../private-app/app/task-panels";
import { TaskAttentionPanel } from "../private-app/app/needs-me/task-attention";
import { taskAttentionPageSchema, taskAttentionPresentation } from "../src/web/v1/task-attention-wire";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationSetupViewV1 } from "../src/harness/v1/installation-setup-view";
import { sha256Digest } from "../src/security/canonical-digest";

test("compiled route parameters decode exactly once before reaching browser clients", () => {
  assert.equal(decodePrivateRouteSegment("project%3Aalpha"), "project:alpha");
  assert.equal(decodePrivateRouteSegment("project:alpha"), "project:alpha");
  assert.equal(decodePrivateRouteSegment("project%253Aalpha"), "project%3Aalpha");
  for (const value of ["", "%", "project%2Falpha", "project%5Calpha", "project%00alpha"])
    assert.throws(() => decodePrivateRouteSegment(value), /private_route_segment_invalid/);
});

test("home gives honest navigation to existing private workspace surfaces", () => {
  const html = renderToStaticMarkup(createElement(Home));
  for (const href of ["/projects", "/workers", "/setup", "/needs-me", "/settings"]) assert.match(html, new RegExp(`href="${href}"`));
  assert.doesNotMatch(html, /href="\/ideas"/);
  assert.match(html, /aria-controls="private-workspace-navigation"/);
  assert.match(html, /<nav id="private-workspace-navigation" class="private-navigation"/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /Each section reports unavailable data instead of replacing it with a zero/);
  assert.match(html, /Installation setup/);
  assert.match(html, /Checking saved setup status/);
  assert.match(html, /Local worker routes/);
  assert.match(html, /Checking saved local worker setup/);
  assert.doesNotMatch(html, /No reviewed setup plan is currently available/);
  assert.doesNotMatch(html, /Idea Lab is optional/);
  assert.doesNotMatch(html, /live workers|running now|0 tasks/i);
  for (const label of ["Loading saved work", "Loading saved attention items", "Loading verified result records",
    "Loading saved worker signals", "Loading saved projects"]) assert.match(html, new RegExp(label));
  assert.match(html, /Operator capacity/);
  assert.match(html, /Reading the recorded capacity and outcome evidence/);
  assert.equal((html.match(/operator-capacity-title/g) ?? []).length, 2, "one read-only capacity panel is mounted");
});

/** The route panel renders only once the task-worker read has resolved. The
 * component defaults that read to "loading", so a static render must pass the
 * resolved state explicitly; see tests/local-worker-route-status.test.tsx. */
const TASK_WORKERS_STARTED = { state: "available" as const, value: { taskWorkersStarted: true, workers: [] } } as const;

test("home shows the three saved local route setup states without presenting them as live", () => {
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }] });
  // The home panel now forwards a resolved task-worker read to the route panel
  // it composes, so the three saved route states are asserted here directly
  // rather than through the inner component.
  const html = renderToStaticMarkup(createElement(HomeInstallationStatus, { topology: {
    state: "available", setup: createInstallationSetupViewV1({ plan, localBackupRestoreVerified: false }),
  }, taskWorkerStatus: TASK_WORKERS_STARTED }));
  assert.match(html, /Local worker routes/);
  assert.match(html, /Three local worker routes/);
  for (const label of ["Hermes Agent", "Claude Code", "Codex"]) assert.match(html, new RegExp(label));
  assert.match(html, /saved setup and proof states, not a live process monitor/);
  assert.match(html, /This panel has no current route-bound task observation/);
  assert.doesNotMatch(html, /worker:local|sha256:|token|password|provider|model|<button|<form|<input/);
});

test("task proposal and worker inventory disclose unavailable operational facts", () => {
  const proposal = renderToStaticMarkup(createElement(TaskProposalForm, {
    draft: { title: "", instructions: "" }, setDraft: () => {}, pending: false, uncertain: false, onSave: () => {},
  }));
  for (const text of ["reporting completion is not acceptance", "Eligible capabilities", "available slots",
    "cancel or resume support", "does not claim that any worker is currently available"])
    assert.match(proposal, new RegExp(text));
  const connections = renderToStaticMarkup(createElement(PrivateConnectionView,
    { data: { state: "loading" }, onRefresh: () => {} }));
  for (const text of ["platform details", "eligible capabilities", "available slots", "current work", "not part of this inventory",
    "Cancel and resume are unsupported"])
    assert.match(connections, new RegExp(text));
  assert.doesNotMatch(connections, /usage are unavailable in this view/);
});

test("workers page has a separate local route-status panel and does not turn inventory into a live monitor", () => {
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }] });
  const html = renderToStaticMarkup(createElement(LocalWorkerRouteStatus, { state: "available",
    setup: createInstallationSetupViewV1({ plan, localBackupRestoreVerified: false }),
    taskWorkerStatus: TASK_WORKERS_STARTED }));
  assert.match(html, /Local worker routes/);
  assert.match(html, /Hermes Agent/); assert.match(html, /Claude Code/); assert.match(html, /Codex/);
  assert.match(html, /not a live process monitor/);
  assert.match(html, /Connection inventory and capacity evidence below cannot substitute/);
  assert.doesNotMatch(html, /<button|<form|<input|worker:local|sha256:/);
});

test("project agents separates local installation setup from project availability", () => {
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }] });
  const html = renderToStaticMarkup(createElement(ProjectAgentInstallationStatus, { topology: {
    state: "available", setup: createInstallationSetupViewV1({ plan, localBackupRestoreVerified: false }),
  } }));
  assert.match(html, /Local worker setup on this computer/);
  assert.match(html, /Installation-scoped setup status only/);
  assert.match(html, /Three local worker routes/);
  for (const label of ["Hermes Agent", "Claude Code", "Codex"]) assert.match(html, new RegExp(label));
  assert.match(html, /not this project’s agent eligibility, available capacity, current work, or permission to assign a task/);
  assert.doesNotMatch(html, /<button|<form|<input|Assign|Start agent/);
  const remoteOnly = renderToStaticMarkup(createElement(ProjectAgentInstallationStatus, { topology: {
    state: "available", setup: createInstallationSetupViewV1({ plan: planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database-remote"),
      schedulerAuthorityDigest: sha256Digest("scheduler-remote"), currentRoutes: [{ kind: "remote", workerId: "worker:remote",
        adapterId: "connector:remote-v1", adapterRevision: "00570550" }], requestedRoutes: [{ kind: "remote", workerId: "worker:remote",
        adapterId: "connector:remote-v1", adapterRevision: "00570550" }] }), localBackupRestoreVerified: false }),
  } }));
  assert.equal(remoteOnly, "");
});

test("needs-attention items expose owner questions and sort urgent work first", () => {
  assert.deepEqual(taskAttentionPresentation(["proposal"]), { category: "preparation", urgency: "normal",
    ownerQuestion: "Is this saved work ready for its next preparation or assignment step?" });
  const task = (jobId: string, title: string, updatedAt: string) => ({ projectId: "project:alpha", jobId,
    requestId: `request:${jobId}`, title, state: "proposed" as const, version: 1,
    createdAt: "2026-09-04T10:00:00.000Z", updatedAt });
  const page = taskAttentionPageSchema.parse({ items: [
    { task: task("job:normal", "Prepare later", "2026-09-04T12:00:00.000Z"), inputDigest: `sha256:${"a".repeat(64)}`, reasons: ["proposal"] },
    { task: task("job:urgent", "Resolve uncertainty", "2026-09-04T11:00:00.000Z"), inputDigest: `sha256:${"b".repeat(64)}`, reasons: ["delivery_uncertain"] },
    { task: task("job:soon", "Review result", "2026-09-04T13:00:00.000Z"), inputDigest: `sha256:${"c".repeat(64)}`, reasons: ["review"] },
  ], nextCursor: null, examined: 3, observedAt: "2026-09-04T14:00:00.000Z", startsWork: false,
  planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" } });
  assert.deepEqual(page.items.map(item => item.task.jobId), ["job:urgent", "job:soon", "job:normal"]);
  const html = renderToStaticMarkup(createElement(TaskAttentionPanel, { page }));
  assert.ok(html.indexOf("Resolve uncertainty") < html.indexOf("Review result"));
  assert.ok(html.indexOf("Review result") < html.indexOf("Prepare later"));
  assert.match(html, /Urgent · uncertainty/); assert.match(html, /Question for you:/);
  assert.match(html, /What was already recorded, and is it safe to continue/);
  assert.doesNotMatch(html, /<button/);
});

test("home dashboard links exact saved work, results, attention and projects without starting anything", () => {
  const task = { jobId: "job:running", projectId: "project:alpha", requestId: "request:alpha", title: "Prepare report",
    state: "running" as const, version: 2, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
  const data = { activity: { state: "ready", value: { active: [task], recentResults: [{ task: { ...task, jobId: "job:done",
    requestId: "request:done", title: "Completed research", state: "succeeded" }, artifact: { artifactId: "artifact:result",
    attemptId: "attempt:done", runId: "run:done", contentHash: `sha256:${"a".repeat(64)}`, sizeBytes: 42,
    receivedAt: "2026-09-04T12:00:00.000Z", byteCheck: "matched_recorded_claim", qualityAccepted: false } }],
    additionalActiveOmitted: false, additionalResultsOmitted: false, resultSource: "configured", observedAt: "2026-09-04T12:00:00.000Z",
    startsWork: false } }, attention: { state: "ready", value: { items: [{ task, inputDigest: `sha256:${"b".repeat(64)}`,
    reasons: ["approval"] }], nextCursor: null, examined: 1, observedAt: "2026-09-04T12:00:00.000Z", startsWork: false,
    planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" } } },
    projects: { state: "ready", value: { projects: [{ projectId: "project:alpha", title: "Alpha", summary: "Project",
      lifecycle: "active", version: 1, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z",
      origin: "ordinary", lifecycleEditable: true }], nextCursor: null, canCreate: true,
      sources: { ordinary: "included", ideas: "not_configured" } } }, connections: { state: "ready", value: { telemetry: "configured",
      projection: { summary: { connectionCount: 2, currentSignalCount: 1, staleSignalCount: 1, missingSignalCount: 0,
        attentionCount: 1 } } } } } as unknown as HomeDashboardState;
  const html = renderToStaticMarkup(createElement(HomeDashboard, { data }));
  assert.match(html, /Prepare report/); assert.match(html, /Completed research/); assert.match(html, /Alpha/);
  assert.match(html, /2 enrolled workers/); assert.match(html, /approval/);
  assert.match(html, /projects\/project%3Aalpha\/tasks\/job%3Arunning/);
  assert.doesNotMatch(html, /submit|retry|resume|start agent/i);
});

test("home dashboard keeps independent unavailable sources explicit", () => {
  const unavailable = { state: "unavailable" } as const;
  const html = renderToStaticMarkup(createElement(HomeDashboard, { data: { projects: unavailable, activity: unavailable,
    attention: unavailable, connections: unavailable } }));
  for (const label of ["Running work is unavailable", "Attention items are unavailable",
    "Verified result records are unavailable", "Worker status is unavailable", "Projects are unavailable"])
    assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, />0</);
});

test("home task reader accepts only the bounded read-only activity contract", async () => {
  let requested = ""; let method = "";
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input); method = init?.method ?? "";
    return Response.json({ active: [], recentResults: [], additionalActiveOmitted: false,
      additionalResultsOmitted: false, resultSource: "not_configured", observedAt: "2026-09-04T12:00:00.000Z", startsWork: false });
  }) as typeof fetch;
  const result = await readTaskHomeActivity(transport);
  assert.equal(requested, "/api/v1/home/tasks"); assert.equal(method, "GET"); assert.equal(result.startsWork, false);
  await assert.rejects(readTaskHomeActivity((async () => Response.json({ ...result, startsWork: true })) as typeof fetch), /unavailable/);
  await assert.rejects(readTaskHomeActivity((async () => Response.json({ ...result, resultSource: "not_authorized",
    recentResults: [{ unexpected: true }] })) as typeof fetch), /unavailable/);
});

test("project catalog filter is sent to the protected read and rejects mixed lifecycle results", async () => {
  let requested = "";
  const project = { projectId: "project:active", title: "Active project", summary: "Saved", lifecycle: "active" as const,
    version: 1, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T10:00:00.000Z",
    origin: "ordinary" as const, lifecycleEditable: true };
  const transport = (async (input: RequestInfo | URL) => { requested = String(input); return Response.json({ projects: [project],
    nextCursor: null, canCreate: true, sources: { ordinary: "included", ideas: "not_configured" } }); }) as typeof fetch;
  const client = createProjectBrowserClient(transport);
  assert.equal((await client.list(undefined, "active")).projects[0]?.projectId, project.projectId);
  assert.equal(requested, "/api/v1/projects?lifecycle=active");
  await assert.rejects(client.list(undefined, "archived"), /unavailable/);
});

test("project status filters are direct links and remain selected across catalog pages", () => {
  const workspace = renderToStaticMarkup(createElement(PrivateProjectWorkspace, { lifecycleFilter: "archived" }));
  assert.match(workspace, /aria-label="Filter projects by status"/);
  assert.match(workspace, /href="\/projects\?lifecycle=archived" aria-current="page"/);
  const pages = renderToStaticMarkup(createElement(ProjectCatalogNavigation,
    { lifecycle: "archived", after: "project:one", nextCursor: "project:two", count: 50 }));
  assert.match(pages, /href="\/projects\?lifecycle=archived">First page/);
  assert.match(pages, /href="\/projects\?lifecycle=archived&amp;after=project%3Atwo">Next page/);
});

test("project overview shows scoped current, review and recent work without commands", async () => {
  const base = { projectId: "project:alpha", requestId: "request:alpha", version: 2,
    createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
  const running = { ...base, jobId: "job:running", title: "Prepare report", state: "running" as const };
  const review = { ...base, jobId: "job:review", title: "Review report", state: "waiting_approval" as const };
  const done = { ...base, jobId: "job:done", title: "Earlier research", state: "succeeded" as const };
  const value = { projectId: base.projectId, current: [running, review], awaitingReview: [review], recent: [done, review, running],
    additionalCurrentOmitted: false, additionalReviewsOmitted: false, additionalRecentOmitted: false,
    observedAt: "2026-09-04T12:00:00.000Z", startsWork: false as const };
  const html = renderToStaticMarkup(createElement(ProjectOverviewActivityView,
    { projectId: base.projectId, state: { state: "ready", value } }));
  for (const label of ["Current work", "Waiting for approval", "Recent task activity", "Prepare report", "Earlier research"])
    assert.match(html, new RegExp(label));
  assert.match(html, /projects\/project%3Aalpha\/tasks\/job%3Areview/);
  assert.doesNotMatch(html, /submit|retry|resume|approve/i);
  let requested = "", method = "";
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input); method = init?.method ?? ""; return Response.json(value);
  }) as typeof fetch;
  assert.equal((await readTaskProjectOverview(base.projectId, transport)).recent.length, 3);
  assert.equal(requested, "/api/v1/projects/project%3Aalpha/overview"); assert.equal(method, "GET");
  await assert.rejects(readTaskProjectOverview("project:other", transport), /unavailable/);
});

test("unavailable project overview does not claim an empty project", () => {
  const html = renderToStaticMarkup(createElement(ProjectOverviewActivityView,
    { projectId: "project:alpha", state: { state: "unavailable", code: "unavailable" } }));
  assert.match(html, /No empty project or all-clear is inferred/);
  assert.doesNotMatch(html, /No saved tasks exist/);
});

test("project files link verified metadata to the exact protected task result", async () => {
  const task = { projectId: "project:alpha", requestId: "request:alpha", jobId: "job:done", title: "Research result",
    state: "succeeded" as const, version: 3, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
  const artifact = { artifactId: "artifact:one", attemptId: "attempt:one", runId: "run:one",
    contentHash: `sha256:${"a".repeat(64)}`, sizeBytes: 42, receivedAt: "2026-09-04T12:00:00.000Z",
    byteCheck: "matched_recorded_claim" as const, qualityAccepted: false as const };
  const value = { projectId: task.projectId, items: [{ task, artifact }], additionalItemsOmitted: false,
    resultSource: "configured" as const, observedAt: "2026-09-04T12:00:00.000Z", startsWork: false as const };
  const html = renderToStaticMarkup(createElement(ProjectFilesView, { projectId: task.projectId,
    data: { state: "ready", value } }));
  assert.match(html, /Research result/); assert.match(html, /42 bytes/);
  // The link now names the exact artifact, not just the task's results anchor,
  // so opening a file from Files lands on that file rather than a generic list.
  assert.match(html,
    /projects\/project%3Aalpha\/tasks\/job%3Adone\?result=artifact%3Aone#task-results/);
  assert.equal(taskResultHrefV1("project:alpha", "job:done", "artifact:one"),
    "/projects/project%3Aalpha/tasks/job%3Adone?result=artifact%3Aone#task-results");
  // Without an artifact the anchor-only form is preserved for plain navigation.
  assert.equal(taskResultHrefV1("project:alpha", "job:done"),
    "/projects/project%3Aalpha/tasks/job%3Adone#task-results");
  assert.doesNotMatch(html, /filesystem|storage locator|download/i);
  let requested = "", method = "";
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input); method = init?.method ?? ""; return Response.json(value);
  }) as typeof fetch;
  assert.equal((await readTaskProjectFiles(task.projectId, transport)).items.length, 1);
  assert.equal(requested, "/api/v1/projects/project%3Aalpha/files"); assert.equal(method, "GET");
  await assert.rejects(readTaskProjectFiles("project:other", transport), /unavailable/);
});

test("unavailable project files do not claim an empty result set", () => {
  const html = renderToStaticMarkup(createElement(ProjectFilesView, { projectId: "project:alpha",
    data: { state: "ready", value: { projectId: "project:alpha", items: [], additionalItemsOmitted: false,
      resultSource: "not_configured", observedAt: "2026-09-04T12:00:00.000Z", startsWork: false } } }));
  assert.match(html, /No zero count or empty file list is inferred/);
  assert.doesNotMatch(html, /No verified result files have been received/);
});

test("shared project navigation keeps core pages and hides optional news until enabled", () => {
  const html = renderToStaticMarkup(createElement(ProjectNavigation, { projectId: "project:alpha", current: "work" }));
  for (const [label, path] of [["Overview", "/projects/project%3Aalpha"], ["Work", "/projects/project%3Aalpha/tasks"],
    ["Files", "/projects/project%3Aalpha/files"], ["Reviews", "/projects/project%3Aalpha/reviews"],
    ["Activity", "/projects/project%3Aalpha/activity"], ["Settings", "/projects/project%3Aalpha/settings"]]) {
    assert.match(html, new RegExp(`href="${path}"[^>]*>${label}`));
  }
  assert.match(html, /href="\/projects\/project%3Aalpha\/tasks" aria-current="page">Work/);
  assert.doesNotMatch(html, />News</);
});

test("project review and activity pages reuse exact saved task links without commands", () => {
  const base = { projectId: "project:alpha", requestId: "request:alpha", version: 2,
    createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
  const review = { ...base, jobId: "job:review", title: "Review report", state: "waiting_approval" as const };
  const done = { ...base, jobId: "job:done", title: "Completed research", state: "succeeded" as const };
  const value = { projectId: base.projectId, current: [review], awaitingReview: [review], recent: [done, review],
    additionalCurrentOmitted: false, additionalReviewsOmitted: false, additionalRecentOmitted: false,
    observedAt: "2026-09-04T12:00:00.000Z", startsWork: false as const };
  const reviews = renderToStaticMarkup(createElement(ProjectTaskViewPanel,
    { projectId: base.projectId, view: "reviews", state: { state: "ready", value } }));
  assert.match(reviews, /Review report/);
  assert.doesNotMatch(reviews, /Completed research/);
  assert.match(reviews, /projects\/project%3Aalpha\/tasks\/job%3Areview/);
  const activity = renderToStaticMarkup(createElement(ProjectTaskViewPanel,
    { projectId: base.projectId, view: "activity", state: { state: "ready", value } }));
  assert.match(activity, /Completed research/);
  assert.match(activity, /Review report/);
  assert.doesNotMatch(activity, /approve|retry|submit|start agent/i);
});

test("project review page distinguishes unavailable data from an empty list", () => {
  const html = renderToStaticMarkup(createElement(ProjectTaskViewPanel,
    { projectId: "project:alpha", view: "reviews", state: { state: "unavailable", code: "unavailable" } }));
  assert.match(html, /No empty list or all-clear is inferred/);
  assert.doesNotMatch(html, /No task is currently recorded/);
});

test("project inbox and result reviews use exact protected results and keep execution approval separate", async () => {
  const base = { projectId: "project:alpha", requestId: "request:alpha", jobId: "job:returned", title: "Returned report",
    state: "succeeded" as const, version: 2, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
  const value = { projectId: base.projectId, mode: "reviews" as const, items: [{ task: base,
    inputDigest: `sha256:${"a".repeat(64)}`, reasons: ["verification_blocked" as const], resultArtifactIds: ["artifact:returned"],
    category: "uncertainty" as const, urgency: "urgent" as const, ownerQuestion: "What was already recorded, and is it safe to continue?" }],
    nextCursor: "job:z-later", examined: 20, resultSource: "configured" as const, reviewSource: "configured" as const,
    resultContent: "authorized" as const,
    observedAt: "2026-09-04T12:00:00.000Z", startsWork: false as const };
  const html = renderToStaticMarkup(createElement(ProjectResultReviewPanel,
    { projectId: base.projectId, mode: "reviews", data: { state: "ready", value } }));
  assert.match(html, /Returned result needs review|Verification is blocked/);
  assert.match(html, /tasks\/job%3Areturned\?result=artifact%3Areturned#task-results/);
  assert.match(html, /Execution approval remains a separate task decision/);
  assert.match(html, /Check next saved tasks/);
  assert.doesNotMatch(html, /approve|retry|submit|start work/i);
  let requested = "", method = "";
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input); method = init?.method ?? ""; return Response.json(value);
  }) as typeof fetch;
  assert.equal((await readTaskProjectAttention(base.projectId, "reviews", undefined, transport)).items[0]?.task.state, "succeeded");
  assert.equal(requested, "/api/v1/projects/project%3Aalpha/reviews"); assert.equal(method, "GET");
  await assert.rejects(readTaskProjectAttention("project:other", "reviews", "bad\u0000cursor", transport), /invalid_request/);
});

test("project review attention does not turn unavailable evidence into an empty all-clear", () => {
  const html = renderToStaticMarkup(createElement(ProjectResultReviewPanel, { projectId: "project:alpha", mode: "reviews",
    data: { state: "ready", value: { projectId: "project:alpha", mode: "reviews", items: [], nextCursor: null, examined: 1,
      resultSource: "not_configured", reviewSource: "not_configured", resultContent: "authorized",
      observedAt: "2026-09-04T12:00:00.000Z", startsWork: false } } }));
  assert.match(html, /not an all-clear for omitted or unavailable evidence/);
  assert.doesNotMatch(html, /No returned result needs review/);
});

test("project review attention explains limited access without advertising a result link", () => {
  const task = { projectId: "project:alpha", requestId: "request:alpha", jobId: "job:returned", title: "Returned report",
    state: "succeeded" as const, version: 2, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
  const html = renderToStaticMarkup(createElement(ProjectResultReviewPanel, { projectId: task.projectId, mode: "reviews",
    data: { state: "ready", value: { projectId: task.projectId, mode: "reviews", items: [{ task,
      inputDigest: `sha256:${"a".repeat(64)}`, reasons: ["review"], resultArtifactIds: [], category: "review",
      urgency: "soon", ownerQuestion: "Does the saved result meet the requested outcome, or does it need changes?" }],
    nextCursor: null, examined: 1, resultSource: "configured", reviewSource: "configured", resultContent: "not_authorized",
    observedAt: "2026-09-04T12:00:00.000Z", startsWork: false } } }));
  assert.match(html, /Review metadata is visible/);
  assert.match(html, /does not authorize opening result content/);
  assert.doesNotMatch(html, /Open exact protected result/);
});

test("settings links to the real session surface without credential controls", () => {
  const html = renderToStaticMarkup(createElement(SettingsPage));
  assert.match(html, /href="\/session"/);
  assert.match(html, /does not expose credentials/);
  assert.match(html, /Set up one Agent Control Room/);
  assert.match(html, /No installation effects happen from this read-only view/);
  assert.doesNotMatch(html, /type="password"|api key|secret key/i);
});

test("home links each recent result to its exact file, not a generic results anchor", () => {
  const task = { projectId: "project:alpha", requestId: "request:alpha", jobId: "job:done", title: "Research result",
    state: "succeeded" as const, version: 3, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
  const artifact = { artifactId: "artifact:one", attemptId: "attempt:one", runId: "run:one",
    contentHash: `sha256:${"a".repeat(64)}`, sizeBytes: 42, receivedAt: "2026-09-04T12:00:00.000Z",
    byteCheck: "matched_recorded_claim" as const, qualityAccepted: false as const };
  const second = { ...artifact, artifactId: "artifact:two", contentHash: `sha256:${"b".repeat(64)}` };
  const state = {
    projects: { state: "unavailable", code: "unavailable" },
    attention: { state: "unavailable", code: "unavailable" },
    connections: { state: "unavailable", code: "unavailable" },
    activity: { state: "ready", value: { projectId: task.projectId, active: [], recentTasks: [],
      recentResults: [{ task, artifact }, { task, artifact: second }], additionalResultsOmitted: false,
      resultSource: "configured", observedAt: "2026-09-04T12:00:00.000Z", startsWork: false } },
  } as unknown as HomeDashboardState;
  const html = renderToStaticMarkup(createElement(HomeDashboard, { data: state }));
  // Two artifacts in one task must produce two distinct exact links.
  assert.match(html, /tasks\/job%3Adone\?result=artifact%3Aone#task-results/);
  assert.match(html, /tasks\/job%3Adone\?result=artifact%3Atwo#task-results/);
});

test("a result selection is read from the URL only when it is a usable identifier", () => {
  assert.equal(readTaskResultSelectionV1("?result=artifact%3Aone"), "artifact:one");
  assert.equal(readTaskResultSelectionV1("result=artifact%3Aone"), "artifact:one");
  // Absent, empty and malformed selections are simply "no selection"; they are
  // never turned into a request.
  assert.equal(readTaskResultSelectionV1(""), undefined);
  assert.equal(readTaskResultSelectionV1("?other=artifact%3Aone"), undefined);
  assert.equal(readTaskResultSelectionV1("?result="), undefined);
  // Control characters and oversized values are refused before reaching the DOM
  // or a request path.
  assert.equal(readTaskResultSelectionV1(`?result=${encodeURIComponent(`bad${String.fromCharCode(0)}id`)}`), undefined);
  assert.equal(readTaskResultSelectionV1(`?result=${"x".repeat(257)}`), undefined);
  assert.equal(readTaskResultSelectionV1(`?result=${"x".repeat(256)}`), "x".repeat(256));
  // A selection is carried verbatim; it is validated against the authorized
  // list by the reader, not trusted here.
  assert.equal(readTaskResultSelectionV1(`?result=${encodeURIComponent("../other-project")}`), "../other-project");
});

test("the exact-result link encodes each segment separately", () => {
  // A project or job containing a separator must not be able to forge a path.
  assert.equal(taskResultHrefV1("project:a/b", "job:c?d", "artifact:e#f"),
    "/projects/project%3Aa%2Fb/tasks/job%3Ac%3Fd?result=artifact%3Ae%23f#task-results");
});

/**
 * Mounted coverage for URL-addressable result selection.
 *
 * These use the repository's existing jsdom + react-dom/client + act pattern
 * (see tests/task-results-lifecycle.test.mjs). Playwright is not available
 * here, so these are not browser evidence — but the validation, history and
 * focus behaviour are component behaviour and must not rest on pure-function
 * tests alone.
 */
async function mountTaskResults(options: { search?: string; canReadContent?: boolean; items?: string[] } = {}) {
  // jsdom ships no type declarations and cannot be augmented. Import it once
  // and bind exactly the surface these tests use, rather than widening the
  // module to `any`.
  const jsdomModule = await import("jsdom");
  const JSDOM = (jsdomModule as { JSDOM: unknown }).JSDOM as new (
    html: string, options?: { url?: string; pretendToBeVisual?: boolean },
  ) => { window: Window & typeof globalThis };
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>',
    { url: `https://control.invalid/projects/project%3Atest/tasks/job%3Atest${options.search ?? ""}#task-results`,
      pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const requests: string[] = [];
  const ids = options.items ?? ["artifact:one", "artifact:two"];
  // Each file's fingerprint must match the exact bytes the reader returns, or
  // the protected reader correctly refuses the content.
  const textFor = (artifactId: string) => `${artifactId} PROTECTED RESULT TEXT`;
  const artifacts = ids.map(artifactId => ({ artifactId, attemptId: "attempt:one", runId: "run:one",
    contentHash: `sha256:${createHash("sha256").update(textFor(artifactId)).digest("hex")}`,
    sizeBytes: Buffer.byteLength(textFor(artifactId)), receivedAt: "2026-09-08T12:00:00.000Z",
    byteCheck: "matched_recorded_claim", qualityAccepted: false }));
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url));
    const path = String(url);
    const match = /\/results\/([^/?]+)$/.exec(path);
    if (match) {
      const artifact = artifacts.find(item => item.artifactId === decodeURIComponent(match[1]));
      if (!artifact) return new Response("no", { status: 404 });
      return Response.json({ projectId: "project:test", jobId: "job:test", artifact,
        text: textFor(artifact.artifactId), contentVerifiedAt: artifact.receivedAt, untrustedContent: true });
    }
    return Response.json({ projectId: "project:test", jobId: "job:test", observedAt: "2026-09-08T12:00:00.000Z",
      resultSource: "configured", reviewSource: "configured", items: artifacts, reviews: [],
      additionalResultsOmitted: false, additionalTargetsOmitted: false,
      canReadContent: options.canReadContent ?? true, reviewCommands: "not_connected" });
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const { act } = React;
  // `act` flushes React's own queued work, but the panel's load is a chain of
  // protected reads it never hands back to the caller: the authorized list,
  // then -- when a file is selected -- that file's content. A single flush can
  // return while a read is still in flight, leaving the panel on "Loading
  // protected results and review…" or "Reading protected result…". Flush
  // repeatedly until the panel has settled into the state an assertion is
  // about, so no assertion races those reads on a slower or loaded machine.
  const settle = async (ready: () => boolean, perform?: () => void) => {
    if (perform) await act(async () => { perform(); });
    for (let attempt = 0; attempt < 200 && !ready(); attempt += 1) {
      // jsdom queues real history.back()/forward() traversal -- and the
      // popstate it dispatches -- as its own task, not a microtask, so a
      // plain act() flush can miss it. Give the event loop a tick too.
      await act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 0)); });
    }
  };
  const idle = () => {
    const text = dom.window.document.body.textContent ?? "";
    return !text.includes("Loading protected results and review…") && !text.includes("Reading protected result…");
  };
  await act(async () => { root.render(React.createElement(PrivateTaskResults,
    { projectId: "project:test", jobId: "job:test", reviewWorkspace: {} as never })); });
  await settle(idle);
  const restore = async () => {
    // The panel installs a 30s poll, a window listener and in-flight fetches.
    // Unmount inside act so its cleanup aborts them, then let the aborted
    // promises settle before the globals disappear -- otherwise a late
    // continuation dereferences a `window` that no longer exists.
    try { await act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    await new Promise(resolve => setImmediate(resolve));
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { dom, root, act, requests, artifacts, restore, settle, idle,
    contentRequests: () => requests.filter(url => /\/results\/[^/?]+$/.test(url)) };
}

test("an unlisted URL selection is refused without any content request", async () => {
  const mounted = await mountTaskResults({ search: "?result=artifact%3Anot-in-this-task" });
  try {
    // The authorized list is fetched; the unlisted file is never read.
    assert.equal(mounted.contentRequests().length, 0);
    assert.match(mounted.dom.window.document.body.textContent ?? "",
      /is not in this task’s authorized file list/);
    // The unusable selection is dropped so a reload does not repeat it.
    assert.equal(new URL(mounted.dom.window.location.href).searchParams.get("result"), null);
  } finally { await mounted.restore(); }
});

test("a listed URL selection opens that exact file and moves focus into it", async () => {
  const mounted = await mountTaskResults({ search: "?result=artifact%3Atwo" });
  try {
    assert.deepEqual(mounted.contentRequests().map(url => decodeURIComponent(url).split("/").pop()),
      ["artifact:two"]);
    const body = mounted.dom.window.document.body;
    assert.match(body.textContent ?? "", /artifact:two PROTECTED RESULT TEXT/);
    const region = mounted.dom.window.document.querySelector(".private-result-content");
    assert.equal(mounted.dom.window.document.activeElement, region);
  } finally { await mounted.restore(); }
});

test("a background refresh does not move focus into the open result", async () => {
  const mounted = await mountTaskResults({ search: "?result=artifact%3Aone" });
  try {
    const region = mounted.dom.window.document.querySelector(".private-result-content");
    assert.equal(mounted.dom.window.document.activeElement, region);
    // The panel reloads on window focus and on a 30-second poll. Focus must be
    // moved once, when the file is opened -- never again on a reload, or a
    // keyboard user would be yanked back to the top of the result every poll.
    (region as HTMLElement).blur();
    await mounted.act(async () => { mounted.dom.window.dispatchEvent(new mounted.dom.window.Event("focus")); });
    // The reload clears content before re-reading it, so wait for the reread to
    // finish rather than inspecting the panel mid-refresh.
    await mounted.settle(() => mounted.idle()
      && Boolean(mounted.dom.window.document.querySelector(".private-result-content")));
    const reopened = mounted.dom.window.document.querySelector(".private-result-content");
    assert.ok(reopened);
    assert.notEqual(mounted.dom.window.document.activeElement, reopened);
  } finally { await mounted.restore(); }
});

test("closing returns focus to the button that opened the file", async () => {
  const mounted = await mountTaskResults({ search: "?result=artifact%3Aone" });
  try {
    const close = [...mounted.dom.window.document.querySelectorAll("button")]
      .find(button => button.textContent === "Close result");
    assert.ok(close);
    await mounted.act(async () => { close!.click(); });
    const openers = [...mounted.dom.window.document.querySelectorAll("button")]
      .filter(button => button.textContent === "Read result");
    assert.equal(mounted.dom.window.document.activeElement, openers[0]);
    assert.equal(new URL(mounted.dom.window.location.href).searchParams.get("result"), null);
    // The anchor is preserved so the panel stays addressable.
    assert.equal(new URL(mounted.dom.window.location.href).hash, "#task-results");
  } finally { await mounted.restore(); }
});

test("back and forward move the open file, not just the scroll position", async () => {
  const mounted = await mountTaskResults();
  try {
    const openers = [...mounted.dom.window.document.querySelectorAll("button")]
      .filter(button => button.textContent === "Read result");
    const body = () => mounted.dom.window.document.body.textContent ?? "";
    const selected = () => new URL(mounted.dom.window.location.href).searchParams.get("result");

    // Real pushState navigation, exactly as the panel performs it, so jsdom's
    // own history stack (not a hand-built URL) drives back()/forward().
    await mounted.settle(() => selected() === "artifact:one",
      () => { openers[0]!.click(); });
    assert.equal(selected(), "artifact:one");
    await mounted.settle(() => /artifact:one PROTECTED RESULT TEXT/.test(body()));
    assert.match(body(), /artifact:one PROTECTED RESULT TEXT/);
    assert.doesNotMatch(body(), /artifact:two PROTECTED RESULT TEXT/);

    // Open a second, distinct file so Back/Forward has two real positions to
    // move between rather than a selection and an absence of one.
    await mounted.settle(() => selected() === "artifact:two",
      () => { openers[1]!.click(); });
    assert.equal(selected(), "artifact:two");
    await mounted.settle(() => /artifact:two PROTECTED RESULT TEXT/.test(body()));
    assert.match(body(), /artifact:two PROTECTED RESULT TEXT/);
    assert.doesNotMatch(body(), /artifact:one PROTECTED RESULT TEXT/);

    // Back: real browser history navigation, not a synthesized popstate.
    await mounted.settle(() => selected() === "artifact:one",
      () => { mounted.dom.window.history.back(); });
    await mounted.settle(() => /artifact:one PROTECTED RESULT TEXT/.test(body()));
    assert.equal(selected(), "artifact:one");
    assert.match(body(), /artifact:one PROTECTED RESULT TEXT/);
    // The exact prior artifact wins outright: no stale artifact:two response,
    // requested moments earlier, is left showing once Back settles.
    assert.doesNotMatch(body(), /artifact:two PROTECTED RESULT TEXT/);

    // Forward: returns to the second exact artifact, again by real navigation.
    await mounted.settle(() => selected() === "artifact:two",
      () => { mounted.dom.window.history.forward(); });
    await mounted.settle(() => /artifact:two PROTECTED RESULT TEXT/.test(body()));
    assert.equal(selected(), "artifact:two");
    assert.match(body(), /artifact:two PROTECTED RESULT TEXT/);
    assert.doesNotMatch(body(), /artifact:one PROTECTED RESULT TEXT/);

    // Back twice more: returns to no selection, and closing still fires from
    // real navigation, not only from an in-page Close click.
    await mounted.settle(() => selected() === "artifact:one",
      () => { mounted.dom.window.history.back(); });
    await mounted.settle(() => selected() === null,
      () => { mounted.dom.window.history.back(); });
    await mounted.settle(() => !/PROTECTED RESULT TEXT/.test(body()));
    assert.equal(selected(), null);
    assert.doesNotMatch(body(), /PROTECTED RESULT TEXT/);
  } finally { await mounted.restore(); }
});

test("metadata-only access is reported as denied, not as a missing file", async () => {
  const mounted = await mountTaskResults({ search: "?result=artifact%3Aone", canReadContent: false });
  try {
    assert.equal(mounted.contentRequests().length, 0);
    const body = mounted.dom.window.document.body.textContent ?? "";
    assert.doesNotMatch(body, /is not in this task’s authorized file list/);
    assert.match(body, /Your access permits metadata, not reading this file/);
  } finally { await mounted.restore(); }
});

test("workers view mounts the operator capacity panel below the inventory", () => {
  // Issue #327: the existing unmodified PrivateOperatorCapacityWorkspace is
  // mounted read-only under the connection inventory. SSR never runs effects,
  // so the panel renders its deterministic loading state — no network, and
  // the same markup regardless of the inventory's own state.
  for (const data of [{ state: "loading" }, { state: "unavailable", code: "unavailable" }] as const) {
    const html = renderToStaticMarkup(createElement(PrivateConnectionView, { data, onRefresh: () => {} }));
    assert.match(html, /Operator capacity/, `panel heading with inventory ${data.state}`);
    assert.match(html, /Reading the recorded capacity and outcome evidence/, `panel loading with inventory ${data.state}`);
  }
});

test("capacity panel states stay independent of the connection inventory", () => {
  // The inventory's unavailable branch must not hide or replace the capacity
  // panel: both render side by side, each carrying its own unavailable state.
  const html = renderToStaticMarkup(createElement(PrivateConnectionView,
    { data: { state: "unavailable", code: "unavailable" }, onRefresh: () => {} }));
  assert.match(html, /Connection inventory unavailable/);
  assert.match(html, /Operator capacity/);
  assert.match(html, /Reading the recorded capacity and outcome evidence/);
  // Exactly one capacity mount: the panel is not duplicated.
  assert.equal((html.match(/operator-capacity-title/g) ?? []).length, 2);
});

test("workers boundary text no longer claims capacity data is unavailable", () => {
  const html = renderToStaticMarkup(createElement(PrivateConnectionView,
    { data: { state: "loading" }, onRefresh: () => {} }));
  assert.doesNotMatch(html, /usage are unavailable in this view/);
  assert.match(html, /not part of this inventory/);
  assert.match(html, /operator capacity panel below shows the recorded capacity/);
  assert.match(html, /read-only/);
});

test("workers can show the reviewed installation plan without revealing routes or offering setup actions", () => {
  const plan = planInstallationTopologyV1({
    databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
  });
  const html = renderToStaticMarkup(createElement(PrivateConnectionView, { data: { state: "loading" }, onRefresh: () => {} },
    createElement(InstallationTopologySummary, { setup: createInstallationSetupViewV1({ plan, localBackupRestoreVerified: false }) })));
  assert.match(html, /Installation setup/);
  assert.match(html, /This computer/);
  assert.match(html, /successful owner-attended local worker check/);
  assert.doesNotMatch(html, /worker:local|sha256:|<form|<input/);
});
