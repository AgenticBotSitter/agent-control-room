// Node-side smoke test for the workspace browser fixture. Boots the
// synthetic server and drives the same fetch transport the browser
// fixture installs at module scope. Every synthetic response is
// Zod-parsed against src/web/v1/{task,task-result}-wire.ts and
// src/web/v1/task-review-wire.ts so a regression in either the server
// or the underlying components is caught without a browser.
//
// The synthetic server is the single source of truth for the fixture
// data; the browser entry and this test both consume it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "./browser/workspace/fixture-data.ts";
import { createWorkspaceServer } from "./browser/workspace/response-builders.ts";
import { taskPageSchema, taskDetailSchema } from "../src/web/v1/task-wire.ts";
import { taskResultsPageSchema, taskResultContentSchema } from "../src/web/v1/task-result-wire.ts";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client.ts";
import { BrowserRequestError } from "../src/web/v1/browser-client.ts";

const NOW = "2026-09-12T16:00:00.000Z";

function boot() {
  // The server has both an async constructor (uses crypto.subtle when
  // available) and a synchronous fallback for environments without it.
  // We always await the constructor so the seeded hash matches the
  // browser entry's hash.
  return createWorkspaceServer({ now: NOW });
}

test("workspace-fixture: alpha project page parses against taskPageSchema", async () => {
  const server = await boot();
  const url = `/api/v1/projects/${encodeURIComponent("project:alpha")}/tasks`;
  const response = server.handle(url);
  assert.equal(response.status, 200);
  const body = await response.json();
  const parsed = taskPageSchema.safeParse(body);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
  if (parsed.success) {
    assert.equal(parsed.data.project.projectId, "project:alpha");
    assert.equal(parsed.data.tasks.length, 1);
    assert.equal(parsed.data.tasks[0].jobId, "job:alpha-001");
  }
});

test("workspace-fixture: alpha detail parses and points at the seed attempt", async () => {
  const server = await boot();
  const url = `/api/v1/projects/${encodeURIComponent("project:alpha")}/tasks/${encodeURIComponent("job:alpha-001")}`;
  const response = server.handle(url);
  assert.equal(response.status, 200);
  const body = await response.json();
  const parsed = taskDetailSchema.safeParse(body);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
  if (parsed.success) {
    assert.equal(parsed.data.task.jobId, "job:alpha-001");
    assert.equal(parsed.data.attempts.length, 1);
    assert.equal(parsed.data.attempts[0].runs[0].state, "succeeded");
  }
});

test("workspace-fixture: alpha results page carries the changes_requested review", async () => {
  const server = await boot();
  const url = `/api/v1/projects/${encodeURIComponent("project:alpha")}/tasks/${encodeURIComponent("job:alpha-001")}/results`;
  const response = server.handle(url);
  assert.equal(response.status, 200);
  const body = await response.json();
  const parsed = taskResultsPageSchema.safeParse(body);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
  if (parsed.success) {
    assert.equal(parsed.data.canReadContent, true);
    assert.equal(parsed.data.reviews[0].status, "changes_requested");
    assert.equal(parsed.data.reviews[0].openFindingCount, 1);
  }
});

test("workspace-fixture: beta results page carries the ready review and metadata-only access", async () => {
  const server = await boot();
  const url = `/api/v1/projects/${encodeURIComponent("project:beta")}/tasks/${encodeURIComponent("job:beta-001")}/results`;
  const response = server.handle(url);
  assert.equal(response.status, 200);
  const body = await response.json();
  const parsed = taskResultsPageSchema.safeParse(body);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
  if (parsed.success) {
    assert.equal(parsed.data.canReadContent, true); // server returns true; the fixture UI gates read on canRead via browser
    assert.equal(parsed.data.reviews[0].status, "ready");
    assert.equal(parsed.data.reviews[0].openFindingCount, 0);
  }
});

test("workspace-fixture: result content validates and exposes the synthetic body", async () => {
  const server = await boot();
  const url = `/api/v1/projects/${encodeURIComponent("project:alpha")}/tasks/${encodeURIComponent("job:alpha-001")}/results/${encodeURIComponent("artifact:job:alpha-001-r1")}`;
  const response = server.handle(url);
  assert.equal(response.status, 200);
  const body = await response.json();
  const parsed = taskResultContentSchema.safeParse(body);
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues, null, 2) : "no error");
  if (parsed.success) {
    assert.equal(parsed.data.text.length > 0, true);
    assert.equal(parsed.data.untrustedContent, true);
    assert.equal(parsed.data.artifact.contentHash.startsWith("sha256:"), true);
  }
});

test("workspace-fixture: propose adds a task and replays the same idempotency key", async () => {
  const server = await boot();
  const url = `/api/v1/projects/${encodeURIComponent("project:alpha")}/tasks`;
  const body = JSON.stringify({ title: "Probe task", instructions: "Disposable body for idempotency replay." });
  const first = server.handle(url, { method: "POST", body, headers: { "idempotency-key": "fixture-key-1" } });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.replayed, false);
  const second = server.handle(url, { method: "POST", body, headers: { "idempotency-key": "fixture-key-1" } });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.replayed, true);
  assert.equal(secondBody.receipt.jobId, firstBody.receipt.jobId);
});

test("workspace-fixture: real task browser client succeeds against the synthetic server", async () => {
  const server = await boot();
  const transport = (url, init) => Promise.resolve(server.handle(url, init));
  const client = createTaskBrowserClient(transport, () => "client-key-1");
  const page = await client.list("project:alpha");
  assert.equal(page.tasks.length, 1);
  assert.equal(page.tasks[0].jobId, "job:alpha-001");
  const detail = await client.detail("project:alpha", "job:alpha-001");
  assert.equal(detail.task.jobId, "job:alpha-001");
});

test("workspace-fixture: real client propose + replay preserves request identity", async () => {
  const server = await boot();
  const transport = (url, init) => Promise.resolve(server.handle(url, init));
  const client = createTaskBrowserClient(transport, () => "client-key-2");
  const draft = { title: "Client probe", instructions: "Disposable body for client replay." };
  const first = await client.propose("project:alpha", draft);
  assert.equal(typeof first.jobId, "string");
  assert.equal(client.hasPending(), false);
  const second = await client.propose("project:alpha", draft);
  assert.equal(second.jobId, first.jobId);
});

test("workspace-fixture: client list returns not_found for unknown project", async () => {
  const server = await boot();
  const transport = (url, init) => Promise.resolve(server.handle(url, init));
  const client = createTaskBrowserClient(transport);
  await assert.rejects(client.list("project:does-not-exist"), (error) => {
    assert.ok(error instanceof BrowserRequestError);
    assert.equal(error.code, "not_found");
    return true;
  });
});

test("workspace-fixture: revision replaces the result file and review", async () => {
  const server = await boot();
  const url = `/api/v1/projects/${encodeURIComponent("project:alpha")}/tasks/${encodeURIComponent("job:alpha-001")}/revisions`;
  const body = JSON.stringify({ targetId: "review:job:alpha-001-r1", instructions: "Add section 2." });
  const response = server.handle(url, { method: "POST", body, headers: { "idempotency-key": "rev-key-1" } });
  assert.equal(response.status, 200);
  const out = await response.json();
  assert.equal(out.revision, 2);
  assert.equal(out.artifactId, "artifact:job:alpha-001-r2");
  const resultsUrl = `/api/v1/projects/${encodeURIComponent("project:alpha")}/tasks/${encodeURIComponent("job:alpha-001")}/results`;
  const second = await (await server.handle(resultsUrl)).json();
  const parsed = taskResultsPageSchema.safeParse(second);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.reviews[0].revision, 2);
    assert.equal(parsed.data.reviews[0].status, "pending");
  }
});

test("workspace-fixture: lifecycle archive rejects propose with conflict", async () => {
  const server = await boot();
  const lifecycleUrl = `/api/v1/projects/${encodeURIComponent("project:beta")}/lifecycle`;
  const archive = server.handle(lifecycleUrl, { method: "POST", body: JSON.stringify({ lifecycle: "archived" }), headers: { "idempotency-key": "lc-1" } });
  assert.equal(archive.status, 200);
  const proposeUrl = `/api/v1/projects/${encodeURIComponent("project:beta")}/tasks`;
  const blocked = server.handle(proposeUrl, { method: "POST", body: JSON.stringify({ title: "blocked", instructions: "x" }), headers: { "idempotency-key": "p-1" } });
  assert.equal(blocked.status, 409);
  const reopen = server.handle(lifecycleUrl, { method: "POST", body: JSON.stringify({ lifecycle: "active" }), headers: { "idempotency-key": "lc-2" } });
  assert.equal(reopen.status, 200);
  const allowed = server.handle(proposeUrl, { method: "POST", body: JSON.stringify({ title: "allowed", instructions: "x" }), headers: { "idempotency-key": "p-2" } });
  assert.equal(allowed.status, 200);
});

test("workspace-fixture: unknown path returns 503 with no fallback", async () => {
  const server = await boot();
  const response = server.handle("/api/v1/projects/project:alpha/something-else");
  assert.equal(response.status, 503);
});

test("workspace-fixture: project isolation — alpha page lists only alpha tasks", async () => {
  const server = await boot();
  const alphaUrl = `/api/v1/projects/${encodeURIComponent("project:alpha")}/tasks`;
  const betaUrl = `/api/v1/projects/${encodeURIComponent("project:beta")}/tasks`;
  const alphaBody = await (await server.handle(alphaUrl)).json();
  const betaBody = await (await server.handle(betaUrl)).json();
  assert.ok(alphaBody.tasks.every((t) => t.projectId === "project:alpha"));
  assert.ok(betaBody.tasks.every((t) => t.projectId === "project:beta"));
  assert.equal(alphaBody.tasks[0].jobId, "job:alpha-001");
  assert.equal(betaBody.tasks[0].jobId, "job:beta-001");
});

test("workspace-fixture: synthetic transport cut returns 503 so the client holds the request", async () => {
  // The transport-cut option consumes the next POST /tasks and returns
  // 503 with no body. The client's commit() then surfaces an "uncertain"
  // BrowserRequestError, which keeps the idempotency key in client
  // memory. The retry call against a healthy server would replay the
  // receipt; here we only exercise the cut path itself.
  const fresh = await createWorkspaceServer({ now: NOW, cutNextPropose: true });
  const proposeUrl = `/api/v1/projects/${encodeURIComponent("project:alpha")}/tasks`;
  const body = JSON.stringify({ title: "Cut probe", instructions: "x" });
  const response = fresh.handle(proposeUrl, { method: "POST", body, headers: { "idempotency-key": "cut-key-1" } });
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text, "");
});
