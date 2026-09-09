import assert from "node:assert/strict";
import test from "node:test";
import Page from "../private-app/app/projects/[projectId]/news/page";
import TaskList from "../private-app/app/projects/[projectId]/tasks/page";
import TaskDetail from "../private-app/app/projects/[projectId]/tasks/[jobId]/page";

test("news page identity cannot collide across colon-bearing project and cursor IDs", async () => {
  const render = (projectId: string, after?: string, sourceAfter?: string) => Page({
    params: Promise.resolve({ projectId }), searchParams: Promise.resolve({ after, sourceAfter }),
  });
  const first = await render("project:one", "story:two:story:three");
  const second = await render("project:one:story:two", "story:three");
  assert.notEqual(first.key, second.key);
  assert.equal(first.key, (await render("project:one", "story:two:story:three")).key);
  assert.notEqual((await render("project:one", "story:two:source:three", "source:four")).key,
    (await render("project:one", "story:two", "source:three:source:four")).key);
});

test("task list and detail identities preserve project boundaries with colon-bearing IDs", async () => {
  const list = (projectId: string, after?: string) => TaskList({
    params: Promise.resolve({ projectId }), searchParams: Promise.resolve({ after }),
  });
  const detail = (projectId: string, jobId: string) => TaskDetail({ params: Promise.resolve({ projectId, jobId }) });
  assert.notEqual((await list("project:one", "job:two:three")).key,
    (await list("project:one:job", "two:three")).key);
  assert.notEqual((await detail("project:one", "job:two:three")).key,
    (await detail("project:one:job", "two:three")).key);
  assert.equal((await detail("project:one", "job:two")).key,
    (await detail("project:one", "job:two")).key);
});
