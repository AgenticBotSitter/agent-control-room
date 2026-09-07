import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import test from "node:test";
import { createContributorDemoRuntime } from "../src/contributor-demo/runtime";
import { createContributorDemoHttp } from "../src/contributor-demo/http";
import { createContributorDemoBrowserClient } from "../src/contributor-demo/browser-client";
import { loadContributorHistory, unrecordedContributorFeedback } from "../src/contributor-demo/history-view";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { createLocalPilotBrowserTransportV1 } from "../src/local-pilot/v1/browser-transport";
import { createContributorDemoNodeHandler, createPrivateNodeHandler } from "../src/web/v1/private-node-handler";
import { nodeExchange } from "./helpers/web-node";

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
  const revisionInput = { parentArtifactId: simulation.artifactId, feedback: "Add a short summary." };
  assert.equal((await demo.simulationHistory(request("GET", cookie), project.project.projectId, proposed.receipt.jobId)).entries.length, 1);
  const [revision, repeatedRevision] = await Promise.all([
    demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId, revisionInput),
    demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId, revisionInput),
  ]);
  assert.deepEqual(repeatedRevision, revision); assert.notEqual(revision.artifactId, simulation.artifactId);
  const revisedResult = await demo.runtime.projectTasks.getSyntheticResult(request("GET", cookie),
    project.project.projectId, proposed.receipt.jobId, revision.artifactId);
  assert.match(revisedResult.text, /REVISED SAMPLE/); assert.match(revisedResult.text, /Add a short summary/);
  assert.match(revisedResult.text, /no agent performed/);
  const history = await demo.simulationHistory(request("GET", cookie), project.project.projectId, proposed.receipt.jobId);
  assert.deepEqual(history.entries, [
    { parentArtifactId: null, feedback: null, state: "succeeded", artifactId: simulation.artifactId },
    { parentArtifactId: simulation.artifactId, feedback: revisionInput.feedback, state: "succeeded", artifactId: revision.artifactId },
  ]);
  history.entries.length = 0;
  assert.equal((await demo.simulationHistory(request("GET", cookie), project.project.projectId, proposed.receipt.jobId)).entries.length, 2);
  await assert.rejects(demo.simulationHistory(request("GET"), project.project.projectId, proposed.receipt.jobId));
  assert.equal((await demo.runtime.projectTasks.getSyntheticResult(request("GET", cookie),
    project.project.projectId, proposed.receipt.jobId, simulation.artifactId)).text, result.text);
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId,
    { ...revisionInput, feedback: "Replace the previous request." }), /revision_conflict/);
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId,
    { ...revisionInput, parentArtifactId: "artifact:missing" }), /parent_unavailable/);
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId,
    { ...revisionInput, feedback: " " }));
  const anotherTask = await demo.runtime.projectTasks.proposeTask(request("POST", cookie), project.project.projectId,
    { title: "Another task", instructions: "Separate task scope." }, "contributor-demo-task-002");
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, anotherTask.receipt.jobId, revisionInput),
    /parent_unavailable/);
  const other = await demo.runtime.projectTasks.createProject(request("POST", cookie), {
    title: "Other demo project", summary: "Separate scope",
  }, "contributor-demo-project-002");
  await assert.rejects(demo.simulate(request("POST", cookie), other.project.projectId, proposed.receipt.jobId));
  await assert.rejects(demo.simulationHistory(request("GET", cookie), other.project.projectId, proposed.receipt.jobId));
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
test("history client rejects broken chains, wrong scope and operational claims", async () => {
  const root = { parentArtifactId: null, feedback: null, state: "succeeded", artifactId: "artifact:root" };
  const base = { simulationOnly: true, grantsExecutionAuthority: false, projectId: "project:demo", jobId: "job:demo", entries: [root] };
  for (const change of [{ projectId: "project:other" }, { grantsExecutionAuthority: true },
    { entries: [{ ...root, parentArtifactId: "artifact:missing" }] },
    { entries: [root, { ...root, parentArtifactId: root.artifactId, feedback: "Revise" }] },
    { entries: [root, { ...root, artifactId: "artifact:new", parentArtifactId: "artifact:wrong", feedback: "Revise" }] }]) {
    let calls = 0;
    const client = createContributorDemoBrowserClient(async () => { calls++; return Response.json({ ...base, ...change }); });
    await assert.rejects(client.history(base.projectId, base.jobId), { code: "uncertain" });
    assert.equal(calls, 1);
  }
});

test("demo Node bridge preserves local login cookies without changing the production bridge", async t => {
  const demo = await createContributorDemoRuntime(process.cwd());
  const options = { origin: demo.origin, application: { isReady: () => true, close: () => demo.close() },
    handler: createContributorDemoHttp(demo.runtime, demo.simulate),
    assets: { count: 0, digest: "synthetic-empty", respond: () => undefined } };
  assert.throws(() => createPrivateNodeHandler(options), /private_serving_config_invalid/);
  assert.throws(() => createContributorDemoNodeHandler({ ...options, origin: "http://localhost:3000" }), /demo_serving_config_invalid/);
  const bridge = createContributorDemoNodeHandler(options);
  t.after(() => bridge.close());
  async function send(input: Parameters<typeof nodeExchange>[0]) {
    const x = nodeExchange(input);
    x.input.rawHeaders[1] = "127.0.0.1:3000";
    await bridge.handle(x.input, x.output);
    return x;
  }
  const login = await send({ path: "/api/v1/local-pilot/session", method: "POST",
    headers: ["origin", demo.origin, "content-type", "application/json"],
    body: JSON.stringify({ ownerCode: demo.ownerCode }) });
  assert.equal(login.output.statusCode, 201);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const read = { path: "/api/v1/local-pilot/workspace?resource=projects", headers: ["cookie", cookie] };
  assert.equal((await send(read)).output.statusCode, 200);
  for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for"]) {
    assert.equal((await send({ ...read, headers: [...read.headers, name, "untrusted"] })).output.statusCode, 403);
  }
  assert.equal((await send({ ...read, peer: "192.0.2.1" })).output.statusCode, 403);
  const production = createPrivateNodeHandler({ ...options, origin: "https://private.example.invalid",
    handler: () => Response.json({}, { headers: { "set-cookie": "must-not-escape=1" } }) });
  const x = nodeExchange();
  await production.handle(x.input, x.output);
  assert.equal(x.headers.has("set-cookie"), false);
  await production.close();
});

test("simulation browser client rejects mismatched or authority-bearing receipts without retry", async () => {
  const receipt = { simulationOnly: true, grantsExecutionAuthority: false,
    artifactId: "artifact:demo:1", projectId: "project:demo:1", jobId: "job:demo:1" };
  for (const extra of [{ simulationOnly: false }, { grantsExecutionAuthority: true },
    { projectId: "project:other" }, { jobId: "job:other" }, { opaqueLocator: "not-for-browser" }]) {
    let calls = 0;
    const browser = createContributorDemoBrowserClient(async () => {
      calls++; return Response.json({ ...receipt, ...extra });
    });
    await assert.rejects(browser.simulate(receipt.projectId, receipt.jobId), { code: "uncertain" });
    assert.equal(calls, 1);
  }
});

test("demo HTTP composes protected login and project routes without operational endpoints", async t => {
  const demo = await createContributorDemoRuntime(process.cwd());
  t.after(() => demo.close());
  const handle = createContributorDemoHttp(demo.runtime, demo.simulate, demo.simulationHistory);
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
  const projectReply = await handle(create());
  const projectId = (await projectReply.json()).project.projectId;
  const taskReply = await handle(new Request(workspace, { method: "POST", headers: {
    cookie, origin: demo.origin, "content-type": "application/json", "idempotency-key": "demo-http-task-0001",
  }, body: JSON.stringify({ operation: "propose_task", projectId,
    draft: { title: "HTTP sample", instructions: "Simulation only" } }) }));
  assert.equal(taskReply.status, 201);
  const jobId = (await taskReply.json()).receipt.jobId;
  const simulationUrl = `${demo.origin}/api/v1/contributor-demo/simulations`;
  const simulate = (extra: Record<string, unknown> = {}, authenticated = true) => new Request(simulationUrl, {
    method: "POST", headers: { ...(authenticated ? { cookie } : {}), origin: demo.origin, "content-type": "application/json" },
    body: JSON.stringify({ operation: "simulate_task", simulationOnly: true, projectId, jobId, ...extra }),
  });
  assert.equal((await handle(simulate({}, false))).status, 401);
  assert.equal((await handle(simulate({ simulationOnly: false }))).status, 400);
  assert.equal((await handle(simulate({ command: "not allowed" }))).status, 400);
  assert.equal((await createContributorDemoHttp(demo.runtime)(simulate())).status, 503);
  const simulated = await handle(simulate());
  assert.equal(simulated.status, 200);
  const receipt = await simulated.json();
  assert.deepEqual(await (await handle(simulate())).json(), receipt);
  let calls = 0, loseReply = true;
  const browser = createContributorDemoBrowserClient(async (input, init) => {
    calls++;
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie); headers.set("origin", demo.origin);
    const response = await handle(new Request(`${demo.origin}${String(input)}`, { ...init, headers }));
    if (loseReply) { loseReply = false; throw new Error("lost response"); }
    return response;
  });
  await assert.rejects(browser.simulate(projectId, jobId), { code: "uncertain" });
  assert.equal(calls, 1);
  assert.deepEqual(await browser.simulate(projectId, jobId), receipt);
  assert.equal(calls, 2);
  const feedback = { parentArtifactId: receipt.artifactId, feedback: "Use a shorter summary." };
  loseReply = true;
  await assert.rejects(browser.simulate(projectId, jobId, feedback), { code: "uncertain" });
  const revised = await browser.simulate(projectId, jobId, feedback);
  assert.notEqual(revised.artifactId, receipt.artifactId);
  assert.deepEqual(await browser.simulate(projectId, jobId, feedback), revised);
  const revisionQuery = new URLSearchParams({ resource: "synthetic_result", projectId, jobId, artifactId: revised.artifactId });
  const revisionReply = await handle(new Request(`${workspace}?${revisionQuery}`, { headers: { cookie } }));
  assert.equal(revisionReply.status, 200);
  assert.match((await revisionReply.json()).text, /Use a shorter summary/);
  const historyUrl = `${simulationUrl}?${new URLSearchParams({ projectId, jobId })}`;
  assert.equal((await handle(new Request(historyUrl))).status, 401);
  assert.equal((await handle(new Request(`${historyUrl}&jobId=another`, { headers: { cookie } }))).status, 400);
  assert.equal((await handle(new Request(historyUrl, { headers: { cookie, origin: "https://other.example" } }))).status, 403);
  const historyResponse = await handle(new Request(historyUrl, { headers: { cookie } }));
  assert.equal(historyResponse.status, 200);
  assert.match(historyResponse.headers.get("cache-control")!, /no-store/);
  const historyBody = await historyResponse.json();
  assert.equal(historyBody.entries.length, 2);
  assert.equal(historyBody.entries[1].artifactId, revised.artifactId);
  assert.deepEqual(await browser.history(projectId, jobId), historyBody);
  const readTransport: typeof fetch = async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    const headers = new Headers(init?.headers); headers.set("cookie", cookie);
    return handle(new Request(`${demo.origin}${String(input)}`, { ...init, headers }));
  };
  const restored = await loadContributorHistory({ simulations: createContributorDemoBrowserClient(readTransport),
    tasks: createTaskBrowserClient(createLocalPilotBrowserTransportV1(readTransport)) }, projectId, jobId);
  assert.equal(restored.unavailable, false); assert.equal(restored.samples.length, 2);
  assert.equal(restored.samples[1].artifactId, revised.artifactId);
  assert.match(restored.samples[1].text, /Use a shorter summary/);
  const notAccepted = { parentArtifactId: revised.artifactId, feedback: "Keep this unsent draft." };
  const disconnected = createContributorDemoBrowserClient(async () => { throw new Error("request never delivered"); });
  await assert.rejects(disconnected.simulate(projectId, jobId, notAccepted), { code: "uncertain" });
  const recovered = await loadContributorHistory({ simulations: createContributorDemoBrowserClient(readTransport),
    tasks: createTaskBrowserClient(createLocalPilotBrowserTransportV1(readTransport)) }, projectId, jobId);
  assert.equal(unrecordedContributorFeedback(recovered, notAccepted), notAccepted.feedback);
  assert.equal(unrecordedContributorFeedback(recovered, feedback), undefined);
  assert.equal(recovered.samples.length, 2);
  assert.equal((await handle(simulate({ revision: { ...feedback, feedback: "x".repeat(501) } }))).status, 400);
  assert.equal((await handle(simulate({ revision: { ...feedback, command: "no" } }))).status, 400);
  const query = new URLSearchParams({ resource: "synthetic_result", projectId, jobId, artifactId: receipt.artifactId });
  const resultResponse = await handle(new Request(`${workspace}?${query}`, { headers: { cookie } }));
  assert.equal(resultResponse.status, 200);
  const result = await resultResponse.json();
  assert.equal(result.simulationOnly, true);
  assert.equal(result.grantsExecutionAuthority, false);
  assert.match(result.text, /HTTP sample/);
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
