import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IdeaProjectStatusActions } from "../private-app/app/workspace.tsx";
import { projectViewSchema } from "../src/web/v1/project-wire.ts";

test("Idea project controls show only supplied authorized actions and disable unresolved writes", () => {
  const project = projectViewSchema.parse({ projectId: "project.idea:controls", title: "Idea", summary: "",
    lifecycle: "completed", version: 2, createdAt: "2026-09-04T12:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z",
    origin: "idea_lab", lifecycleEditable: true, ideaLifecycleActions: ["archive"] });
  let calls = 0;
  const render = (pending: boolean) => renderToStaticMarkup(<IdeaProjectStatusActions project={project} pending={pending} onAction={() => { calls++; }} />);
  assert.match(render(false), /Archive project/);
  assert.doesNotMatch(render(false), /Pause project|Resume project|Reopen project|Mark complete|disabled/);
  assert.match(render(true), /disabled=""/);
  assert.equal(calls, 0);
  assert.equal(renderToStaticMarkup(<IdeaProjectStatusActions project={{ ...project, lifecycleEditable: false, ideaLifecycleActions: [] }} pending={false} onAction={() => { calls++; }} />), "");
});
