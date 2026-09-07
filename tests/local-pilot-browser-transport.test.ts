import assert from "node:assert/strict";
import test from "node:test";
import { createLocalPilotBrowserTransportV1 } from "../src/local-pilot/v1/browser-transport";
import { createProjectBrowserClient } from "../src/web/v1/browser-client";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";

test("pilot transport maps bounded reads and preserves request options and responses", async () => {
  const response = Response.json({ marker: true });
  const signal = new AbortController().signal;
  let seen: { input: unknown; init?: RequestInit } | undefined;
  const transport = createLocalPilotBrowserTransportV1(async (input, init) => { seen = { input, init }; return response; });
  for (const [path, expected] of [
    ["", { resource: "projects" }],
    ["?after=project%3Aprevious", { resource: "projects", after: "project:previous" }],
    ["/project%3Aexample", { resource: "project", projectId: "project:example" }],
    ["/project%3Aexample/tasks?after=job%3Aprevious", { resource: "tasks", projectId: "project:example", after: "job:previous" }],
    ["/project%3Aexample/tasks/job%3Aexample", { resource: "task", projectId: "project:example", jobId: "job:example" }],
  ] as const) {
    const init: RequestInit = { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal };
    assert.equal(await transport(`/api/v1/projects${path}`, init), response);
    const url = new URL(String(seen!.input), "http://127.0.0.1:3000");
    assert.equal(url.pathname, "/api/v1/local-pilot/workspace");
    assert.deepEqual(Object.fromEntries(url.searchParams), expected);
    assert.deepEqual(seen!.init, init);
  }
});

test("pilot transport wraps only the three supported writes without losing replay headers", async () => {
  const calls: RequestInit[] = [];
  const transport = createLocalPilotBrowserTransportV1(async (input, init) => {
    assert.equal(input, "/api/v1/local-pilot/workspace"); calls.push(init!); return Response.json({});
  });
  const headers = { "content-type": "application/json", "idempotency-key": "same-save" };
  for (const [path, draft, expected] of [
    ["", { title: "Project", summary: "Summary" }, { operation: "create_project" }],
    ["/project%3Aexample/lifecycle", { lifecycle: "archived", expectedVersion: 1 }, { operation: "transition_project", projectId: "project:example" }],
    ["/project%3Aexample/tasks", { title: "Task", instructions: "Research" }, { operation: "propose_task", projectId: "project:example" }],
  ] as const) {
    await transport(`/api/v1/projects${path}`, { method: "POST", headers, body: JSON.stringify(draft) });
    assert.deepEqual(JSON.parse(String(calls.at(-1)!.body)), { ...expected, draft });
    assert.equal(calls.at(-1)!.headers, headers);
  }
});

test("unsupported paths, methods, malformed drafts and ambiguous queries never reach a network", async () => {
  let calls = 0;
  const transport = createLocalPilotBrowserTransportV1(async () => { calls++; return Response.json({}); });
  for (const path of [
    "https://example.invalid/api/v1/projects", "//example.invalid/api/v1/projects", "/api/v1/session/logout",
    "/api/v1/projects-other", "/api/v1/projects/", "/api/v1/projects/project%2Fescape",
    "/api/v1/projects/project%ZZ", "/api/v1/projects/project:example/tasks/job:example/results",
    "/api/v1/projects/project:example/lifecycle", "/api/v1/projects#ignored",
    "/api/v1/projects?after=project:one&after=project:two", "/api/v1/projects?unknown=yes",
    "/api/v1/projects?after=", "/api/v1/projects?after=project:one?extra",
    "/api/v1/projects/project:example?after=project:one",
  ]) await assert.rejects(transport(path));
  await assert.rejects(transport(new Request("http://127.0.0.1:3000/api/v1/projects")));
  for (const init of [{ method: "DELETE" }, { method: "GET", body: "x" },
    { method: "POST", body: "{" }, { method: "POST", body: "x".repeat(24_577) },
    { method: "POST", body: JSON.stringify({ title: "Example", summary: "", startAgent: true }) }]) {
    await assert.rejects(transport("/api/v1/projects", init));
  }
  assert.equal(calls, 0);
});

test("canonical project and task clients retain exact saves through a lost pilot response", async () => {
  const requests: { key: string | null; body: string }[] = [];
  const project = { projectId: "project:example", title: "Example", summary: "", lifecycle: "active", version: 1,
    createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
  const receipt = { projectId: project.projectId, jobId: "job:example", requestId: "request:example",
    createdAt: project.createdAt, submission: "proposed", startsWork: false };
  const transport = createLocalPilotBrowserTransportV1(async (_input, init) => {
    requests.push({ key: new Headers(init?.headers).get("idempotency-key"), body: String(init?.body) });
    if (requests.length % 2 === 1) throw new Error("lost response");
    const command = JSON.parse(String(init?.body));
    return Response.json(command.operation === "create_project" ? { project, replayed: true } : { receipt, replayed: true });
  });
  const projects = createProjectBrowserClient(transport, () => "project-save");
  await assert.rejects(projects.create({ title: "Example", summary: "" }), { code: "uncertain" });
  assert.equal(projects.hasPending(), true);
  await assert.rejects(projects.create({ title: "Different", summary: "" }), { code: "uncertain" });
  assert.deepEqual(await projects.retryPending(), project);
  assert.equal(projects.hasPending(), false);
  assert.deepEqual(requests[0], requests[1]);
  const tasks = createTaskBrowserClient(transport, () => "task-save");
  await assert.rejects(tasks.propose(project.projectId, { title: "Task", instructions: "Research" }), { code: "uncertain" });
  assert.equal(tasks.hasPending(), true);
  await assert.rejects(tasks.propose(project.projectId, { title: "Other", instructions: "Research" }), { code: "uncertain" });
  assert.deepEqual(await tasks.retrySave(), receipt);
  assert.equal(tasks.hasPending(), false);
  assert.deepEqual(requests[2], requests[3]);
  assert.equal(requests.length, 4);
});
