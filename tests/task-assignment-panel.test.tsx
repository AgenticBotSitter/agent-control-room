import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskAssignmentPanel } from "../private-app/app/task-assignment";

test("local Hermes assignment states its bounded text-review scope before reservation", () => {
  const html = renderToStaticMarkup(createElement(TaskAssignmentPanel, {
    nodeId: "", setNodeId() {}, pending: false, uncertain: false, onChange() {}, onRetry() {},
    options: { projectId: "project:local", jobId: "job:local", inputDigest: "sha256:" + "a".repeat(64),
      receipt: null, startsWork: false, candidateEvidence: "configured_routes_only",
      candidates: [{ nodeId: "node:local", label: "Local agent", platform: "macos", workScope: "bounded_text_review" }] },
  }));
  assert.match(html, /text review only/);
  assert.match(html, /cannot edit this project, use tools, access accounts, or make network requests/);
  assert.match(html, /Assign without starting/);
  assert.doesNotMatch(html, /Start Hermes|Enable Hermes/);
});
