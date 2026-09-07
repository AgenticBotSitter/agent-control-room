import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import test from "node:test";
import { createContributorDemoRuntime } from "../src/contributor-demo/runtime";

test("disposable demo uses real local authentication and project/task services, then removes its data", async t => {
  const demo = await createContributorDemoRuntime(process.cwd());
  t.after(() => demo.close());
  assert.equal(demo.simulationOnly, true);
  assert.ok(isAbsolute(demo.dataDir));
  assert.ok((await stat(demo.dataDir)).isDirectory());
  const request = (method: "GET" | "POST", cookie?: string) => new Request(`${demo.origin}/local-preview`, {
    method, headers: { ...(method === "POST" ? { origin: demo.origin } : {}), ...(cookie ? { cookie } : {}) },
  });
  await assert.rejects(demo.runtime.projectTasks.listProjects(request("GET")), /authentication_required/);
  await assert.rejects(demo.runtime.ownerSession.issue(request("POST"), "incorrect-code-01234567890123456789"), /invalid_owner_code/);
  const issued = await demo.runtime.ownerSession.issue(request("POST"), demo.ownerCode);
  const cookie = issued.cookie.split(";")[0]!;
  await assert.rejects(demo.runtime.ownerSession.issue(request("POST"), demo.ownerCode), /owner_code_consumed/);
  const project = await demo.runtime.projectTasks.createProject(request("POST", cookie), {
    title: "Contributor demo", summary: "Disposable synthetic project",
  }, "contributor-demo-project-001");
  const proposed = await demo.runtime.projectTasks.proposeTask(request("POST", cookie), project.project.projectId, {
    title: "Compare options", instructions: "Synthetic comparison only; do not run an agent.",
  }, "contributor-demo-task-001");
  assert.equal(proposed.receipt.startsWork, false);
  const detail = await demo.runtime.projectTasks.getTask(request("GET", cookie), project.project.projectId, proposed.receipt.jobId);
  assert.equal(detail.task.state, "proposed");
  assert.deepEqual(detail.attempts, []);
  const first = demo.close();
  assert.equal(demo.close(), first);
  await first;
  await assert.rejects(stat(demo.dataDir), { code: "ENOENT" });
});

test("demo rejects relative repository roots before allocating data", async () => {
  await assert.rejects(createContributorDemoRuntime("."), /demo_repository_root_must_be_absolute/);
});
