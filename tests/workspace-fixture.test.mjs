// Node-side smoke test for the workspace browser fixture. Exercises the
// response builders from response-builders.ts and Zod-parses each output
// against the wire schemas in src/web/v1/{task,task-result}-wire.ts. The
// fixture itself is rendered in a browser; this test only proves the
// synthetic data produces responses that the real components will accept.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "./browser/workspace/fixture-data.ts";
import { buildWorkspaceResponses } from "./browser/workspace/response-builders.ts";
import { taskPageSchema, taskDetailSchema } from "../src/web/v1/task-wire.ts";
import { taskResultsPageSchema, taskResultContentSchema } from "../src/web/v1/task-result-wire.ts";

const NOW = "2026-09-12T16:00:00.000Z";

test("workspace-fixture: alpha project produces a valid task page response", () => {
  const builder = buildWorkspaceResponses(fixtures["project:alpha"], NOW);
  builder.setContentHash("sha256:" + "0".repeat(64));
  const page = builder.buildTaskPage();
  const parsed = taskPageSchema.safeParse(page);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
});

test("workspace-fixture: alpha project produces a valid task detail response", () => {
  const builder = buildWorkspaceResponses(fixtures["project:alpha"], NOW);
  builder.setContentHash("sha256:" + "1".repeat(64));
  const detail = builder.buildTaskDetail();
  const parsed = taskDetailSchema.safeParse(detail);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
});

test("workspace-fixture: alpha results page accepts canReadContent=true", () => {
  const builder = buildWorkspaceResponses(fixtures["project:alpha"], NOW);
  builder.setContentHash("sha256:" + "2".repeat(64));
  const results = builder.buildResultsPage(true);
  const parsed = taskResultsPageSchema.safeParse(results);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
  if (parsed.success && parsed.data.reviews[0]) {
    assert.equal(parsed.data.reviews[0].status, "changes_requested");
    assert.equal(parsed.data.reviews[0].grantsApproval, false);
    assert.equal(parsed.data.reviews[0].grantsExecutionAuthority, false);
  }
});

test("workspace-fixture: beta results page mirrors alpha with ready status and canReadContent=false", () => {
  const builder = buildWorkspaceResponses(fixtures["project:beta"], NOW);
  builder.setContentHash("sha256:" + "3".repeat(64));
  const results = builder.buildResultsPage(false);
  const parsed = taskResultsPageSchema.safeParse(results);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
  if (parsed.success && parsed.data.reviews[0]) {
    assert.equal(parsed.data.reviews[0].status, "ready");
    assert.equal(parsed.data.canReadContent, false);
  }
});

test("workspace-fixture: result content response validates with contentHash consistency", () => {
  const builder = buildWorkspaceResponses(fixtures["project:alpha"], NOW);
  builder.setContentHash("sha256:" + "4".repeat(64));
  const content = builder.buildResultContent();
  const parsed = taskResultContentSchema.safeParse(content);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
  if (parsed.success) {
    assert.equal(parsed.data.text.length > 0, true);
    assert.equal(parsed.data.untrustedContent, true);
  }
});

test("workspace-fixture: each project has distinct URLs that do not collide", () => {
  const alpha = buildWorkspaceResponses(fixtures["project:alpha"], NOW);
  const beta = buildWorkspaceResponses(fixtures["project:beta"], NOW);
  for (const key of /** @type {const} */ (["listUrl", "detailUrl", "resultsUrl", "resultContentUrl"])) {
    assert.notEqual(alpha.urls[key], beta.urls[key], `URL collision on ${key}: ${alpha.urls[key]}`);
  }
});

test("workspace-fixture: setContentHash patches responses built later", () => {
  const builder = buildWorkspaceResponses(fixtures["project:alpha"], NOW);
  const placeholders = builder.buildResultContent();
  assert.equal(placeholders.artifact.contentHash.startsWith("sha256:aaa"), true);
  builder.setContentHash("sha256:" + "9".repeat(64));
  const real = builder.buildResultContent();
  assert.equal(real.artifact.contentHash, "sha256:" + "9".repeat(64));
});
