import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectCatalog } from "../app/components/project-catalog";
import { TaskCatalogPanel } from "../private-app/app/task-panels";
import { LocalProjectWorkspace, localPreviewHref, localPreviewFailure } from "../app/local-preview/workspace";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import type { TaskPage } from "../src/web/v1/task-wire";
import { ContributorSimulationPanel } from "../app/components/contributor-simulation";
import { ContributorDemoView, contributorDemoSelection } from "../contributor-demo/view";
import { LocalControlRoomWorkboard } from "../app/local-preview/control-room-workboard";

test("standalone contributor entry keeps project selection strict and starts without private records", () => {
  assert.deepEqual(contributorDemoSelection("?project=project%3Ademo&job=job%3Ademo"), {
    projectId: "project:demo", jobId: "job:demo", after: undefined,
  });
  for (const query of ["?job=job:demo", "?project=a&project=b", "?project=p&job=j&after=a", "?secret=value"]) {
    assert.throws(() => contributorDemoSelection(query), /invalid_demo_link/);
  }
  const html = renderToStaticMarkup(createElement(ContributorDemoView, { search: "" }));
  assert.match(html, /Disposable contributor demo/);
  assert.match(html, /One-time owner code/);
  assert.match(html, /Loading saved data/);
  assert.doesNotMatch(html, /Simulate this task|Save proposal/);
});

test("simulation panel distinguishes pending, uncertain and untrusted output", () => {
  const render = (props: Partial<Parameters<typeof ContributorSimulationPanel>[0]>) => renderToStaticMarkup(
    createElement(ContributorSimulationPanel, { pending: false, uncertain: false, onRun: () => {}, ...props }));
  assert.match(render({}), /Simulate this task/);
  const pending = render({ pending: true });
  assert.match(pending, /disabled/); assert.match(pending, /role="status"/);
  assert.match(render({ uncertain: true }), /Check this simulation/);
  const restoring = render({ pending: true, restoring: true });
  assert.match(restoring, /Loading sample history/);
  assert.match(restoring, /No simulation is being started/);
  const result = render({ text: "<script>untrusted sample</script>" });
  assert.match(result, /untrusted content/);
  assert.match(result, /&lt;script&gt;/);
  assert.doesNotMatch(result, /<script>/);
  assert.match(render({ error: "Sign in again" }), /role="alert"/);
  const revision = { feedback: "Make it shorter", previous: ["<script>old sample</script>"], locked: false,
    onFeedback: () => {}, onSubmit: () => {} };
  const editable = render({ text: "New sample", revision });
  assert.match(editable, /Request revised sample/); assert.match(editable, /maxLength="500"/);
  assert.match(editable, /Previous sample 1/); assert.match(editable, /&lt;script&gt;old sample/);
  assert.doesNotMatch(editable, /<script>/);
  const locked = render({ text: "Sample", revision: { ...revision, locked: true } });
  assert.match(locked, /Check the existing request/);
  assert.match(locked, /textarea[^>]*disabled/);
});

const project = { projectId: "project:example", title: "Example <project>", summary: "Purpose", lifecycle: "active" as const,
  origin: "ordinary" as const, lifecycleEditable: true, version: 1, createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
test("invalid saves keep forms editable but failed reads and uncertain or denied writes clear records", () => {
  const invalid = new BrowserRequestError("invalid_request");
  assert.equal(localPreviewFailure(invalid, "save", false).clearRecords, false);
  assert.match(localPreviewFailure(invalid, "save", true).message, /title and instructions/);
  assert.equal(localPreviewFailure(invalid, "read", false).clearRecords, true);
  for (const code of ["authentication_required", "access_denied", "not_found", "conflict", "uncertain", "unavailable"] as const)
    assert.equal(localPreviewFailure(new BrowserRequestError(code), "save", true).clearRecords, true);
  const unexpected = localPreviewFailure(new Error("private implementation detail"), "save", false);
  assert.equal(unexpected.clearRecords, true);
  assert.doesNotMatch(unexpected.message, /private implementation detail/);
});
test("reused project catalog keeps pilot links separate and preserves default navigation", () => {
  const pilot = renderToStaticMarkup(createElement(ProjectCatalog, { state: "ready", projects: [project], projectHref: localPreviewHref }));
  assert.match(pilot, /href="\/local-preview\?project=project%3Aexample"/);
  assert.match(pilot, /target="_blank" rel="noopener noreferrer"/);
  assert.match(pilot, /Example &lt;project&gt;/);
  assert.match(pilot, /dateTime="2026-09-06T00:00:00.000Z"/);
  assert.match(pilot, /Updated/);
  assert.doesNotMatch(pilot, /href="\/projects\//);
  const original = renderToStaticMarkup(createElement(ProjectCatalog, { state: "ready", projects: [project] }));
  assert.match(original, /href="\/projects\/project%3Aexample"/);
});
test("task links and pagination stay in the selected pilot project", () => {
  const page: TaskPage = { project, tasks: [{ projectId: project.projectId, jobId: "job:example", requestId: "request:example",
    title: "Saved task", state: "proposed", version: 1, createdAt: project.createdAt, updatedAt: project.updatedAt }],
    nextCursor: "job:next", canPropose: true, dispatch: "not_connected", observedAt: project.updatedAt };
  const html = renderToStaticMarkup(createElement(TaskCatalogPanel, { page, after: "job:previous", href: localPreviewHref }));
  assert.match(html, /project=project%3Aexample&amp;job=job%3Aexample/);
  assert.match(html, /project=project%3Aexample&amp;after=job%3Anext/);
  assert.match(html, /Proposal saved/);
  assert.doesNotMatch(html, /href="\/projects\//);
  const original = renderToStaticMarkup(createElement(TaskCatalogPanel, { page }));
  assert.match(original, /\/projects\/project%3Aexample\/tasks\/job%3Aexample/);
});
test("preview initially renders no sample records or operational controls", () => {
  const html = renderToStaticMarkup(createElement(LocalProjectWorkspace, {}));
  assert.match(html, /Loading saved data/);
  assert.match(html, /cannot assign or start agents/);
  assert.doesNotMatch(html, /Save proposal|Create project|Start agent|Example &lt;project&gt;/);
  assert.equal(localPreviewHref(undefined, undefined, "project:next"), "/local-preview?after=project%3Anext");
});

test("local workboard is a read-only navigation surface with honest worker evidence", () => {
  const html = renderToStaticMarkup(createElement(LocalControlRoomWorkboard, { projectId: "project:example" }));
  assert.match(html, /Local Control Room workboard/);
  assert.match(html, /Reading saved task activity/);
  assert.match(html, /Reading worker evidence/);
  assert.match(html, /cannot assign, start, stop, approve, or retry work/);
  assert.doesNotMatch(html, /Start task|Approve task|Retry task|Assign worker/);
});

test("mounted workboard sends its normal browser reads to the exact local-pilot route", async () => {
  // @ts-expect-error jsdom has no bundled declarations.
  const jsdomModule = await import("jsdom");
  const JSDOM = (jsdomModule as { JSDOM: unknown }).JSDOM as new (html: string,
    options?: { url?: string; pretendToBeVisual?: boolean }) => { window: Window & typeof globalThis };
  const React = await import("react"); const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://127.0.0.1:3000/local-preview?project=project%3Aexample", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "fetch", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const requests: { url: string; method?: string }[] = [];
  const observedAt = "2026-09-22T00:00:00.000Z";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method }); const resource = new URL(String(url), dom.window.location.origin).searchParams.get("resource");
    if (resource === "home") return Response.json({ active: [], recentResults: [], additionalActiveOmitted: false,
      additionalResultsOmitted: false, resultSource: "not_configured", observedAt, startsWork: false });
    if (resource === "overview") return Response.json({ projectId: "project:example", current: [], awaitingReview: [], recent: [],
      additionalCurrentOmitted: false, additionalReviewsOmitted: false, additionalRecentOmitted: false, observedAt, startsWork: false });
    if (resource === "agents") return Response.json({ projectId: "project:example", eligibilitySource: "not_configured", workers: [],
      tasksExamined: 0, additionalTasksOmitted: false, candidateEvidence: "configured_routes_only", observedAt, startsWork: false,
      grantsAssignmentAuthority: false, grantsExecutionAuthority: false });
    if (resource === "attention") return Response.json({ projectId: "project:example", mode: new URL(String(url), dom.window.location.origin).searchParams.get("mode"),
      items: [], examined: 0, nextCursor: null, resultSource: "not_configured", reviewSource: "not_configured", resultContent: "authorized", observedAt, startsWork: false });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!); const { act } = React;
  try {
    await act(async () => { root.render(React.createElement(LocalControlRoomWorkboard, { projectId: "project:example" }));
      await new Promise(resolve => dom.window.setTimeout(resolve, 0)); });
    for (let attempt = 0; attempt < 20 && requests.length < 5; attempt += 1)
      await act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 0)); });
    assert.deepEqual(requests.map(item => item.method), ["GET", "GET", "GET", "GET", "GET"]);
    assert.deepEqual(requests.map(item => new URL(item.url, dom.window.location.origin).pathname),
      Array(5).fill("/api/v1/local-pilot/workspace"));
    assert.deepEqual(requests.map(item => new URL(item.url, dom.window.location.origin).searchParams.get("resource")).sort(),
      ["agents", "attention", "attention", "home", "overview"]);
  } finally {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
