import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createMacLocalNodeHandler } from "../src/web/v1/private-node-handler";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";
import { nodeExchange } from "./helpers/web-node";

after(closePrivateOwnerBootstrapConformanceDatabase);

test("the real Mac-local wrapper signs in locally and reaches the existing project service", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-web" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, clock: () => conformanceNow,
    taskReadKeys: { harnessIntegrityKey: new Uint8Array(32).fill(1),
      results: { integrityKey: new Uint8Array(32).fill(2), storageClass: "local", storage: { read: async () => undefined } } },
    workerReadiness: { read: () => [{ kind: "hermes-021" as const, state: "ready" as const, proof: "not_proven" as const }] },
    taskWorkersStarted: true });
  const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);
  assert.equal((await app.handle(request("/api/v1/projects"), () => new Response("unused"))).status, 401);
  const signedIn = await app.handle(request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response("unused"));
  assert.equal(signedIn.status, 201);
  const cookie = signedIn.headers.get("set-cookie"); assert.ok(cookie);
  const workers = await app.handle(request("/api/v1/local-workers", { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(workers.status, 200); assert.deepEqual(await workers.json(), { taskWorkersStarted: true,
    workers: [{ kind: "hermes-021", state: "ready", proof: "not_proven" }] });
  const projects = await app.handle(request("/api/v1/projects", { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(projects.status, 200);
  assert.match(await projects.text(), /projects/);
  const foreignPort = await app.handle(request("/api/v1/projects", { method: "POST", headers: { cookie: cookie!, origin: "http://127.0.0.1:1", "content-type": "application/json",
    "idempotency-key": "mac-local-project-foreign-port-001" }, body: JSON.stringify({ title: "Foreign port", summary: "Must be refused" }) }),
  () => new Response("unused"));
  assert.equal(foreignPort.status, 403);
  const created = await app.handle(request("/api/v1/projects", { method: "POST", headers: { cookie: cookie!, origin, "content-type": "application/json",
    "idempotency-key": "mac-local-project-create-001" }, body: JSON.stringify({ title: "Local wrapper project", summary: "Disposable route proof" }) }),
  () => new Response("unused"));
  assert.equal(created.status, 201); const projectId = (await created.json() as { project: { projectId: string } }).project.projectId;
  const tasks = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(tasks.status, 200, await tasks.text());
  const proposed = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, { method: "POST", headers: {
    cookie: cookie!, origin, "content-type": "application/json", "idempotency-key": "mac-local-task-proposal-001" },
  body: JSON.stringify({ title: "Local text task", instructions: "Return a harmless short answer." }) }), () => new Response("unused"));
  assert.equal(proposed.status, 201);
  const proposedReceipt = await proposed.json() as { receipt: { jobId: string } };
  const shell = await app.handle(request("/projects", { headers: { cookie: cookie! } }), () => new Response("real shell"));
  assert.equal(shell.status, 200); assert.equal(await shell.text(), "real shell");
  const projectShell = await app.handle(request(`/projects/${encodeURIComponent(projectId)}`, { headers: { cookie: cookie! } }),
    () => new Response("real project shell"));
  assert.equal(projectShell.status, 200); assert.equal(await projectShell.text(), "real project shell");
  const taskShell = await app.handle(request(`/projects/${encodeURIComponent(projectId)}/tasks`, { headers: { cookie: cookie! } }),
    () => new Response("real task shell"));
  assert.equal(taskShell.status, 200); assert.equal(await taskShell.text(), "real task shell");
  const detailShell = await app.handle(request(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(proposedReceipt.receipt.jobId)}`,
    { headers: { cookie: cookie! } }), () => new Response("real task detail shell"));
  assert.equal(detailShell.status, 200); assert.equal(await detailShell.text(), "real task detail shell");
  const results = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(proposedReceipt.receipt.jobId)}/results`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(results.status, 200);
  assert.equal((await results.json() as { resultSource: string }).resultSource, "configured",
    "the local website must receive the task application's result-read capability");
  const fakePreview = await app.handle(request("/local-preview", { headers: { cookie: cookie! } }), () => new Response("must not render"));
  assert.equal(fakePreview.status, 404);
  await app.close();
});

test("the Mac-local wrapper does not accept a forwarded or foreign request", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-reject" }); t.after(fixture.close);
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, clock: () => conformanceNow });
  const response = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: {
    origin, forwarded: "for=192.0.2.1", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response("unused"));
  assert.equal(response.status, 403);
  const sessionPage = await app.handle(new Request(`${origin}/session`, { headers: { forwarded: "for=192.0.2.1" } }), () => new Response("unused"));
  assert.equal(sessionPage.status, 403);
  await app.close();
});

test("the Mac-local wrapper forwards the existing assignment operation through local owner authentication", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-assignment" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  const calls: unknown[][] = [];
  const app = createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, clock: () => conformanceNow,
    assignment: { async options(...input) {
      calls.push(input);
      const [, projectId, jobId] = input as [unknown, string, string];
      return { projectId, jobId, inputDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        candidates: [], recommendation: { state: "not_available", availability: "unknown", startsWork: false, grantsExecutionAuthority: false },
        receipt: null, startsWork: false, candidateEvidence: "configured_routes_only" };
    }, async assign() { throw new Error("not used"); }, async expire() { throw new Error("not used"); } },
  });
  const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);
  const signedIn = await app.handle(request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response("unused"));
  const cookie = signedIn.headers.get("set-cookie"); assert.ok(cookie);
  const created = await app.handle(request("/api/v1/projects", { method: "POST", headers: { cookie: cookie!, origin,
    "content-type": "application/json", "idempotency-key": "mac-local-assignment-project-001" }, body: JSON.stringify({ title: "Assignment path", summary: "Route proof" }) }), () => new Response("unused"));
  const projectId = (await created.json() as { project: { projectId: string } }).project.projectId;
  const task = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, { method: "POST", headers: { cookie: cookie!, origin,
    "content-type": "application/json", "idempotency-key": "mac-local-assignment-task-001" }, body: JSON.stringify({ title: "Assignment task", instructions: "Return a short answer." }) }), () => new Response("unused"));
  const jobId = (await task.json() as { receipt: { jobId: string } }).receipt.jobId;
  const options = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/assignment`, { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(options.status, 200, await options.text());
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as unknown[]).slice(1), [projectId, jobId]);
  await app.close();
});

test("the Mac-local transport is loopback-only and is the only transport that relays its session cookie", async () => {
  const origin = "http://127.0.0.1:3210";
  assert.throws(() => createMacLocalNodeHandler({ origin: "https://private.example.invalid", application: {
    isReady: () => true, close: async () => {},
  }, handler: async () => new Response("unused"), assets: { count: 0, digest: "empty", respond: () => undefined } }),
  /mac_local_serving_config_invalid/);
  const handler = createMacLocalNodeHandler({ origin, application: { isReady: () => true, close: async () => {} },
    handler: async () => new Response("ok", { headers: { "set-cookie": "control_room_local_owner=value; HttpOnly" } }),
    assets: { count: 0, digest: "empty", respond: () => undefined } });
  const exchange = nodeExchange({ path: "/session" }); exchange.input.rawHeaders[1] = "127.0.0.1:3210";
  const done = new Promise<void>((resolve, reject) => { exchange.output.once("finish", resolve); exchange.output.once("error", reject); });
  void handler.handle(exchange.input, exchange.output); await done;
  assert.equal(exchange.headers.get("set-cookie"), "control_room_local_owner=value; HttpOnly");
});
