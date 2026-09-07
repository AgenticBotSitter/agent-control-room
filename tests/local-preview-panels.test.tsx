import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectCatalog } from "../app/components/project-catalog";
import { TaskCatalogPanel } from "../private-app/app/task-panels";
import { LocalProjectWorkspace, localPreviewHref, localPreviewFailure } from "../app/local-preview/workspace";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import type { TaskPage } from "../src/web/v1/task-wire";

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
