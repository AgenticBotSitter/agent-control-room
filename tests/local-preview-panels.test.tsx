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
