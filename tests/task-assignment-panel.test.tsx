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
      recommendation: { state: "one_configured_route", nodeId: "node:local", label: "Local agent",
        workScope: "bounded_text_review", availability: "unknown", startsWork: false, grantsExecutionAuthority: false },
      candidates: [{ nodeId: "node:local", label: "Local agent", platform: "macos", workScope: "bounded_text_review" }] },
  }));
  assert.match(html, /text review only/);
  assert.match(html, /cannot edit this project, use tools, access accounts, or make network requests/);
  assert.match(html, /Assign without starting/);
  assert.match(html, /Suggested route: Local agent/);
  assert.match(html, /Availability and current usage are unknown/i);
  assert.match(html, /does not select, reserve, start, or approve/i);
  assert.doesNotMatch(html, /Start Hermes|Enable Hermes/);
});

test("multiple configured routes remain an owner choice", () => {
  const html = renderToStaticMarkup(createElement(TaskAssignmentPanel, {
    nodeId: "", setNodeId() {}, pending: false, uncertain: false, onChange() {}, onRetry() {},
    options: { projectId: "project:local", jobId: "job:local", inputDigest: "sha256:" + "a".repeat(64), receipt: null,
      startsWork: false, candidateEvidence: "configured_routes_only", recommendation: { state: "choice_required", configuredRouteCount: 2,
        availability: "unknown", startsWork: false, grantsExecutionAuthority: false }, candidates: [
        { nodeId: "node:one", label: "One", platform: "macos", workScope: "bounded_text_review" },
        { nodeId: "node:two", label: "Two", platform: "linux", workScope: "configured_task" },
      ] },
  }));
  assert.match(html, /Choose deliberately below/i);
  assert.match(html, /Choose a machine/);
  assert.match(html, /<option value="" selected="">Choose a machine/);
  assert.doesNotMatch(html, /<option value="node:(one|two)" selected="">/);
});
