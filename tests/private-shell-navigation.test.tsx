import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../private-app/app/page";
import { HomeDashboard, type HomeDashboardState } from "../private-app/app/home-workspace";
import SettingsPage from "../private-app/app/settings/page";
import { PrivateProjectWorkspace } from "../private-app/app/workspace";
import { ProjectCatalogNavigation } from "../app/components/project-catalog-navigation";
import { createProjectBrowserClient } from "../src/web/v1/browser-client";
import { readTaskHomeActivity } from "../src/web/v1/task-home-browser-client";
import { ProjectOverviewActivityView } from "../private-app/app/project-overview-activity";
import { readTaskProjectOverview } from "../src/web/v1/task-project-overview-browser-client";
import { ProjectFilesView } from "../private-app/app/project-files-workspace";
import { readTaskProjectFiles } from "../src/web/v1/task-project-files-browser-client";
import { ProjectNavigation } from "../private-app/app/project-navigation";
import { ProjectTaskViewPanel } from "../private-app/app/project-task-views";

test("home gives honest navigation to existing private workspace surfaces", () => {
  const html = renderToStaticMarkup(createElement(Home));
  for (const href of ["/projects", "/workers", "/needs-me", "/settings"]) assert.match(html, new RegExp(`href="${href}"`));
  assert.doesNotMatch(html, /href="\/ideas"/);
  assert.match(html, /aria-controls="private-workspace-navigation"/);
  assert.match(html, /<nav id="private-workspace-navigation" class="private-navigation"/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /Each section reports unavailable data instead of replacing it with a zero/);
  assert.doesNotMatch(html, /Idea Lab is optional/);
  assert.doesNotMatch(html, /live workers|running now|0 tasks/i);
  for (const label of ["Loading saved work", "Loading saved attention items", "Loading verified result records",
    "Loading saved worker signals", "Loading saved projects"]) assert.match(html, new RegExp(label));
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
  assert.match(html, /projects\/project%3Aalpha\/tasks\/job%3Adone#task-results/);
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

test("settings links to the real session surface without credential controls", () => {
  const html = renderToStaticMarkup(createElement(SettingsPage));
  assert.match(html, /href="\/session"/);
  assert.match(html, /does not expose credentials/);
  assert.doesNotMatch(html, /password|api key|secret key/i);
});
