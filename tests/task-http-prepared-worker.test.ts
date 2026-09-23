import assert from "node:assert/strict";
import test from "node:test";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { taskDraft, taskFixture } from "./helpers/web-task";
import { now, origin, request, trust } from "./helpers/web-foundation";

test("task detail presents only the server-recorded prepared worker", async t => {
  const f = await taskFixture();
  t.after(() => f.db.close());
  const saved = await f.handler(request(f.path, "POST", taskDraft, "prepared-worker-source"));
  assert.equal(saved.status, 201);
  const command = await saved.json() as { receipt: { jobId: string } };
  const detailPath = `${f.path}/${encodeURIComponent(command.receipt.jobId)}`;
  const calls: unknown[][] = [];
  const handler = createTaskHttpHandler({ origin, trust, service: f.tasks, clock: () => now,
    planning: { async plan() { throw new Error("not reached by task detail"); }, async readPreparedWorker(...input) {
      calls.push(input);
      return "claude" as const;
    } } });

  const response = await handler(request(detailPath));
  assert.equal(response.status, 200);
  const detail = await response.json() as { preparedFor: unknown };
  assert.equal(detail.preparedFor, "claude");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(1), [f.project.projectId, command.receipt.jobId]);

  // A browser parameter cannot choose a worker or reinterpret the saved plan.
  assert.equal((await handler(request(`${detailPath}?preparedFor=hermes`))).status, 400);
  const withoutPlanning = createTaskHttpHandler({ origin, trust, service: f.tasks, clock: () => now });
  assert.equal((await (await withoutPlanning(request(detailPath))).json() as { preparedFor: unknown }).preparedFor, null);
});
