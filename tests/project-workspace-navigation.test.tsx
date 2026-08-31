import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectWorkspacePage } from "../app/project-workspace-page.tsx";
import { buildProjectWorkspaceUiFixtureV1 } from "../app/fixtures/project-workspace-ui.ts";
import { projects } from "../src/fixtures/data.ts";
import { parseProjectWorkspaceSnapshotV1 } from "../src/project-workspace/v1/index.ts";

test("CR12A-PILOT-000 builds a valid sectioned workspace for every registered project", () => {
  for (const project of projects) {
    const snapshot = buildProjectWorkspaceUiFixtureV1(project.id);
    assert.ok(snapshot);
    assert.deepEqual(parseProjectWorkspaceSnapshotV1(snapshot), snapshot);
    assert.equal(snapshot.sections.length >= 9, true);
    assert.deepEqual(snapshot.sections.slice(0, 9).map((section) => section.sectionId),
      ["overview", "inbox", "work", "agents", "automations", "artifacts", "reviews", "activity", "settings"]);
    for (const section of snapshot.sections) {
      assert.equal(section.deepLinkPath, `/projects/${project.id}/${section.sectionId}`);
      assert.equal(section.presentationOnly, true);
      assert.equal(section.grantsCommandAuthority, false);
      assert.equal(section.grantsExecutionAuthority, false);
    }
  }
});

test("CR12A-PILOT-000 overview exposes real section links and an explicit no-authority boundary", () => {
  const html = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.blooms.content-ops" />);
  assert.match(html, /Project Workspace/);
  assert.match(html, /href="\/projects\/project\.blooms\.content-ops\/inbox"/);
  assert.match(html, /href="\/projects\/project\.blooms\.content-ops\/automations"/);
  assert.match(html, /Current work/);
  assert.match(html, /Source Scheduled/);
  assert.match(html, /presentation-only/);
  assert.match(html, /grants no approval, network, command, lease, dispatch, or execution authority/i);
});

test("CR12A-PILOT-000 core routes render distinct project-scoped operational views", () => {
  const inbox = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.blooms.content-ops" sectionId="inbox" />);
  assert.match(inbox, /Attention items/); assert.match(inbox, /Choose a transcription fallback route/);
  const work = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.blooms.content-ops" sectionId="work" />);
  assert.match(work, /Project work/); assert.match(work, /Transcribe recording queue item/);
  const agents = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.blooms.content-ops" sectionId="agents" />);
  assert.match(agents, /Your agent team, in one room/); assert.match(agents, /Johnny5/);
  const automations = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.blooms.content-ops" sectionId="automations" />);
  assert.match(automations, /Ready frontier/); assert.match(automations, /production activation remains blocked/i);
  const artifacts = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.blooms.content-ops" sectionId="artifacts" />);
  assert.match(artifacts, /No authenticated artifact index is connected/);
  const activity = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.blooms.content-ops" sectionId="activity" />);
  assert.match(activity, /Detected unavailable preferred transcription route/);
  const settings = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.blooms.content-ops" sectionId="settings" />);
  assert.match(settings, /Authority settings/); assert.match(settings, /This view cannot change the mode/);
});

test("CR12A-PILOT-000 project extensions retain the established ABS and Wayfarer workspaces", () => {
  const abs = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.abs.ai-tech-news" sectionId="ai-tech-news" />);
  assert.match(abs, /What matters in AI and tech today/); assert.match(abs, /Research this/);
  assert.match(abs, /Proposal editor/);
  assert.equal(abs.match(/aria-label="Project workspace navigation"/g)?.length, 1);
  const wayfarer = renderToStaticMarkup(<ProjectWorkspacePage projectId="project.wayfarer.lazy-river" sectionId="media-graph" />);
  assert.match(wayfarer, /Six-stage production pipeline/); assert.match(wayfarer, /Unreal remains blocked/);
});
