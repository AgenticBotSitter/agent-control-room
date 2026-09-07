import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import test from "node:test";
import { createContributorDemoRuntime } from "../src/contributor-demo/runtime";
import { createContributorDemoHttp } from "../src/contributor-demo/http";

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
  await assert.rejects(demo.simulate(request("GET", cookie), project.project.projectId, proposed.receipt.jobId));
  await assert.rejects(demo.simulate(request("POST"), project.project.projectId, proposed.receipt.jobId));
  const [simulation, replay] = await Promise.all([
    demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId),
    demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId),
  ]);
  assert.deepEqual(replay, simulation);
  assert.equal(simulation.simulationOnly, true);
  assert.equal(simulation.grantsExecutionAuthority, false);
  const result = await demo.runtime.projectTasks.getSyntheticResult(request("GET", cookie),
    project.project.projectId, proposed.receipt.jobId, simulation.artifactId);
  assert.match(result.text, /SIMULATED RESULT/);
  assert.match(result.text, /Compare options/);
  assert.equal(result.untrustedContent, true);
  const other = await demo.runtime.projectTasks.createProject(request("POST", cookie), {
    title: "Other demo project", summary: "Separate scope",
  }, "contributor-demo-project-002");
  await assert.rejects(demo.simulate(request("POST", cookie), other.project.projectId, proposed.receipt.jobId));
  await assert.rejects(demo.runtime.projectTasks.getSyntheticResult(request("GET", cookie),
    other.project.projectId, proposed.receipt.jobId, simulation.artifactId));
  const after = await demo.runtime.projectTasks.getTask(request("GET", cookie), project.project.projectId, proposed.receipt.jobId);
  assert.equal(after.task.state, "proposed");
  assert.deepEqual(after.attempts, []);
  const first = demo.close();
  assert.equal(demo.close(), first);
  await first;
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId));
  await assert.rejects(stat(demo.dataDir), { code: "ENOENT" });
});

test("demo rejects relative repository roots before allocating data", async () => {
  await assert.rejects(createContributorDemoRuntime("."), /demo_repository_root_must_be_absolute/);
});

test("demo HTTP composes protected login and project routes without operational endpoints", async t => {
  const demo = await createContributorDemoRuntime(process.cwd());
  t.after(() => demo.close());
  const handle = createContributorDemoHttp(demo.runtime);
  const session = `${demo.origin}/api/v1/local-pilot/session`;
  const workspace = `${demo.origin}/api/v1/local-pilot/workspace`;
  assert.equal((await handle(new Request(session))).status, 401);
  assert.equal((await handle(new Request(`${workspace}?resource=projects`))).status, 401);
  const login = () => new Request(session, { method: "POST", headers: {
    origin: demo.origin, "content-type": "application/json",
  }, body: JSON.stringify({ ownerCode: demo.ownerCode }) });
  for (const body of [{ ownerCode: "x".repeat(513) }, { ownerCode: demo.ownerCode, extra: true }]) {
    assert.equal((await handle(new Request(session, { method: "POST", headers: {
      origin: demo.origin, "content-type": "application/json",
    }, body: JSON.stringify(body) }))).status, 400);
  }
  const authenticated = await handle(login());
  assert.equal(authenticated.status, 201);
  assert.equal(authenticated.headers.get("cache-control"), "no-store");
  assert.equal(authenticated.headers.get("x-control-room-pilot"), "repository-fake");
  const cookie = authenticated.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await handle(login())).status, 409);
  assert.equal((await handle(new Request(session, { headers: { cookie } }))).status, 200);
  const create = () => new Request(workspace, { method: "POST", headers: {
    cookie, origin: demo.origin, "content-type": "application/json", "idempotency-key": "demo-http-project-0001",
  }, body: JSON.stringify({ operation: "create_project", draft: { title: "HTTP demo", summary: "Synthetic only" } }) });
  assert.equal((await handle(create())).status, 201);
  assert.equal((await handle(create())).status, 200);
  const projects = await handle(new Request(`${workspace}?resource=projects`, { headers: { cookie } }));
  assert.equal((await projects.json()).projects.length, 1);
  assert.equal((await handle(new Request(`${workspace}?resource=projects`, {
    headers: { cookie, origin: "https://untrusted.example" },
  }))).status, 403);
  assert.equal((await handle(new Request(`${demo.origin}/api/v1/native/start`, { method: "POST" }))).status, 404);
  assert.equal((await handle(new Request(session, { method: "DELETE" }))).status, 405);
  assert.equal((await handle(new Request(`${session}?unexpected=yes`))).status, 400);
  assert.equal((await handle(new Request("http://localhost:3000/api/v1/local-pilot/session"))).status, 403);
  await demo.close();
  assert.equal((await handle(new Request(session, { headers: { cookie } }))).status, 503);
});
