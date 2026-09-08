import assert from "node:assert/strict";
import test from "node:test";
import { createProjectBrowserClient } from "../src/web/v1/browser-client.ts";
import { projectViewSchema } from "../src/web/v1/project-wire.ts";

const project = projectViewSchema.parse({ projectId: "project.idea:browser", title: "Idea project", summary: "Test",
  lifecycle: "active", version: 1, createdAt: "2026-09-04T12:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z",
  origin: "idea_lab", lifecycleEditable: true, ideaLifecycleActions: ["pause", "complete"] });
const receipt = { projectId: project.projectId, title: project.title, summary: project.summary,
  lifecycle: "completed", version: 2, createdAt: project.createdAt, updatedAt: project.updatedAt };

test("Idea browser preserves dotted IDs and original command across timeout and intervening denial", async () => {
  const calls: { path: string; body: string; key: string }[] = [];
  const client = createProjectBrowserClient((async (path, init) => {
    calls.push({ path: String(path), body: String(init?.body), key: new Headers(init?.headers).get("idempotency-key")! });
    if (calls.length === 1) throw new Error("disconnected");
    if (calls.length === 2) return new Response(null, { status: 403 });
    return Response.json({ project: receipt, replayed: true });
  }) as typeof fetch, () => "idea-browser-command-001");
  await assert.rejects(client.transitionIdea(project, "archive"), /invalid_request/);
  assert.equal(calls.length, 0);
  await assert.rejects(client.transitionIdea(project, "complete"), /uncertain/);
  assert.equal(client.hasPending(), true);
  await assert.rejects(client.retryPending(), /access_denied/);
  assert.equal(client.hasPending(), true);
  await assert.rejects(client.transitionIdea(project, "pause"), /uncertain/);
  assert.deepEqual(await client.retryPending(), receipt);
  assert.equal(client.hasPending(), false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].path, "/api/v1/projects/project.idea%3Abrowser/idea-lifecycle");
  assert.deepEqual(calls, [calls[0], calls[0], calls[0]]);
});

test("Idea lifecycle receipt must match requested project, target, version and original fields", async () => {
  for (const change of [{ projectId: "project.idea:other" }, { lifecycle: "archived" }, { version: 3 }, { title: "changed" }]) {
    const client = createProjectBrowserClient((async () => Response.json({ project: { ...receipt, ...change }, replayed: false })) as typeof fetch);
    await assert.rejects(client.transitionIdea(project, "complete"), /uncertain/);
    assert.equal(client.hasPending(), true);
  }
  for (const change of [{ lifecycleEditable: true, ideaLifecycleActions: [] }, { ideaLifecycleActions: ["pause", "pause"] },
    { origin: "ordinary" }, { ideaLifecycleActions: ["delete"] }]) {
    assert.equal(projectViewSchema.safeParse({ ...project, ...change }).success, false);
  }
});
