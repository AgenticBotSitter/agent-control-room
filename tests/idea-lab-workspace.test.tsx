import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IdeaLabWorkspace } from "../app/components/idea-lab-workspace.tsx";
import { IdeaPromotedProjectWorkspace } from "../app/components/idea-promoted-project-workspace.tsx";
import { buildIdeaLabUiFixtureV1 } from "../app/fixtures/idea-lab-ui.ts";
import { parseProjectWorkspaceSnapshotV1 } from "../src/project-workspace/v1/index.ts";

test("CR12B-IDEA-020 renders diverse analysis, advisory synthesis, owner promotion, and the honest provider boundary", () => {
  const fixture = buildIdeaLabUiFixtureV1();
  const html = renderToStaticMarkup(<IdeaLabWorkspace fixture={fixture} />);
  assert.match(html, /Turn a rough business idea into a monitored project/);
  assert.match(html, /Customer Lens/); assert.match(html, /Market Scout/); assert.match(html, /Red Team/); assert.match(html, /Operator/);
  assert.match(html, /Advisory score/); assert.match(html, /Explicit owner promotion/);
  assert.match(html, /No Hermes, Codex, or local-model provider was contacted/);
  assert.match(html, /href="\/projects\/project%3Alocal-trades-ai-desk"/);
  assert.match(html, /Protected runtime not configured\. Controls are safely disabled\./);
  assert.match(html, /<form/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Create session<\/button>/);
  assert.doesNotMatch(html, /Create live project|Dispatch now/);
});

test("CR12B-IDEA-020 gives every promoted project the standard monitoring tabs and a durable lifecycle summary", () => {
  const fixture = buildIdeaLabUiFixtureV1();
  assert.deepEqual(parseProjectWorkspaceSnapshotV1(fixture.workspace), fixture.workspace);
  const html = renderToStaticMarkup(<IdeaPromotedProjectWorkspace fixture={fixture} />);
  for (const label of ["Overview", "Inbox", "Work", "Agents", "Automations", "Files and artifacts", "Reviews", "Activity", "Settings", "Idea origin"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /Lifecycle version 1/); assert.match(html, /Owner-promoted Idea Lab session/);
  assert.match(html, /presentation-only/); assert.match(html, /grants no approval, network, command, lease, dispatch, or execution authority/);
});

test("CR12B-IDEA-020 project origin and settings routes remain scoped and non-mutating", () => {
  const fixture = buildIdeaLabUiFixtureV1();
  const origin = renderToStaticMarkup(<IdeaPromotedProjectWorkspace fixture={fixture} sectionId="idea-origin" />);
  assert.match(origin, /Idea origin/); assert.match(origin, /injected-only evidence/); assert.match(origin, /Skeptic/);
  const settings = renderToStaticMarkup(<IdeaPromotedProjectWorkspace fixture={fixture} sectionId="settings" />);
  assert.match(settings, /Active → paused or completed → archived → reopened/);
  assert.match(settings, /no live mutation endpoint/);
});
