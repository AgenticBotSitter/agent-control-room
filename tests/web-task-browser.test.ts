import assert from "node:assert/strict";
import test from "node:test";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { taskDraft, taskFixture } from "./helpers/web-task";
import { origin, token } from "./helpers/web-foundation";

test("task client uses the real HTTP service and exact receipt recovery after a committed response is lost", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  let lose = true, posts = 0; const keys: string[] = [];
  const transport: typeof fetch = async (input, options) => {
    const headers = new Headers(options?.headers); headers.set("origin", origin); headers.set("cf-access-jwt-assertion", token());
    const response = await f.handler(new Request(new URL(String(input), origin), { ...options, headers }));
    if (options?.method === "POST") { posts++; keys.push(headers.get("idempotency-key")!); if (lose) { lose = false; throw new Error(); } }
    return response;
  };
  const client = createTaskBrowserClient(transport, () => "browser-task-save-001");
  await assert.rejects(client.propose(f.project.projectId, taskDraft), { code: "uncertain" }); assert.equal(client.hasPending(), true);
  assert.equal((await client.list(f.project.projectId)).tasks.length, 1); assert.equal(posts, 1);
  await assert.rejects(client.propose(f.project.projectId, { ...taskDraft, title: "Different" }), { code: "uncertain" });
  assert.equal(posts, 1);
  const receipt = await client.retrySave(); assert.equal(client.hasPending(), false); assert.equal(posts, 2);
  assert.equal(keys[0], keys[1]); assert.equal((await client.detail(f.project.projectId, receipt.jobId)).task.state, "proposed");
});

test("task reads reject mismatched project/task identities, malformed responses and private redirects", async () => {
  let options: RequestInit | undefined;
  const client = createTaskBrowserClient(async (_, init) => { options = init; return Response.json({ project: { projectId: "project:other" } }); });
  await assert.rejects(client.list("project:test"), { code: "unavailable" });
  assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "same-origin"); assert.equal(options?.cache, "no-store");
  await assert.rejects(client.detail("project:test", "job:test"), { code: "unavailable" });
  await assert.rejects(client.list("../elsewhere"), { code: "invalid_request" });
  await assert.rejects(createTaskBrowserClient(async () => new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }))
    .list("project:test"), { code: "unavailable" });
});

test("uncertain writes are never automatically retried; concurrent and changed submissions stay held", async () => {
  let calls = 0; const client = createTaskBrowserClient(async () => { calls++; throw new Error(); }, () => "uncertain-browser-key");
  await assert.rejects(client.propose("project:test", taskDraft), { code: "uncertain" });
  await assert.rejects(client.propose("project:other", taskDraft), { code: "uncertain" }); assert.equal(calls, 1);
  await assert.rejects(client.retrySave(), { code: "uncertain" }); assert.equal(calls, 2);
  for (const status of [400, 401, 403, 404, 409]) {
    const denied = createTaskBrowserClient(async () => Response.json({}, { status }), () => "denied-browser-task-key");
    await assert.rejects(denied.propose("project:test", taskDraft)); assert.equal(denied.hasPending(), false);
  }
});

test("catalog pages are complete, ordered and explicitly paginated rather than silently truncated", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  for (let i = 0; i < 51; i++) await f.tasks.propose(f.identity, f.project.projectId, { ...taskDraft, title: `Task ${i}` }, `task-pagination-${i.toString().padStart(5, "0")}`);
  const client = createTaskBrowserClient(async (input, init) => {
    const headers = new Headers(init?.headers); headers.set("origin", origin); headers.set("cf-access-jwt-assertion", token());
    return f.handler(new Request(new URL(String(input), origin), { ...init, headers }));
  });
  const first = await client.list(f.project.projectId); assert.equal(first.tasks.length, 50); assert.ok(first.nextCursor);
  const second = await client.list(f.project.projectId, first.nextCursor!); assert.equal(second.tasks.length, 1); assert.equal(second.nextCursor, null);
  assert.ok(second.tasks[0].jobId > first.tasks.at(-1)!.jobId);
});
