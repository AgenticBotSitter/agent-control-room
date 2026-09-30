import assert from "node:assert/strict";
import test, { after } from "node:test";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createContributorDemoNodeHandler, createMacLocalNodeHandler } from "../src/web/v1/private-node-handler";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";
import { nodeExchange } from "./helpers/web-node";
import { createHealthNonceV1, healthRequestTagV1, healthResponseTagV1,
  LOCAL_HOST_HEALTH_ENDPOINT_V1 } from "../src/updater/v1/health-protocol.mjs";

after(closePrivateOwnerBootstrapConformanceDatabase);

test("the real Mac-local wrapper signs in locally and reaches the existing project service", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-web" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const origin = "http://127.0.0.1:3210", trustedOrigin = "https://control-room-mac.example.ts.net";
  const ownerCode = "mac-local-owner-code-long-enough";
  let actionInboxReads = 0;
  const app = createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900,
      trustedOrigin },
    database: { client: fixture.client, close: async () => {} }, clock: () => conformanceNow,
    hostProcessId: 4_243,
    healthProbeKey: new Uint8Array(32).fill(9), healthReleaseId: "dev", healthStartedAt: "2026-09-30T00:00:00.000Z",
    workBatchIntegrityKey: new Uint8Array(32).fill(7),
    taskReadKeys: { harnessIntegrityKey: new Uint8Array(32).fill(1),
      results: { integrityKey: new Uint8Array(32).fill(2), storageClass: "local", storage: { read: async () => undefined } } },
    workerReadiness: { read: () => [{ kind: "hermes-021" as const, state: "ready" as const, proof: "not_proven" as const }] },
    taskWorkersStarted: true,
    actionInboxSource: { read: async () => { actionInboxReads += 1; return {
      observedAt: new Date(conformanceNow).toISOString(), items: [], truncated: false }; } } });
  const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);
  const signedOutApi = await app.handle(request("/api/v1/projects"), () => new Response("unused"));
  assert.equal(signedOutApi.status, 401);
  assert.deepEqual(await signedOutApi.json(), { error: "authentication_required" });
  const signedOutInbox = await app.handle(request("/api/v1/needs-me/action-items"), () => new Response("unused"));
  assert.equal(signedOutInbox.status, 401);
  const signedOutFile = await app.handle(request("/api/v1/projects/project:test/tasks/job:test/files/artifact:test?disposition=preview&token=untrusted"),
    () => new Response("unused"));
  assert.equal(signedOutFile.status, 401, "file preview requires an authenticated owner session before a ticket is considered");
  for (const path of ["/", "/morning", "/projects", "/projects/project:unknown/tasks"]) {
    const signedOutPage = await app.handle(request(path), () => { throw new Error("must not render signed-out page"); });
    assert.equal(signedOutPage.status, 303);
    assert.equal(signedOutPage.headers.get("location"), `${origin}/session`);
    assert.equal(signedOutPage.headers.get("cache-control"), "no-store");
  }
  const signedOutWrite = await app.handle(request("/projects", { method: "POST" }), () => new Response("unused"));
  assert.equal(signedOutWrite.status, 401);
  const healthKey = new Uint8Array(32).fill(9);
  const nonce = createHealthNonceV1(conformanceNow, size => Buffer.alloc(size, 1));
  const reqTag = healthRequestTagV1(healthKey, nonce, LOCAL_HOST_HEALTH_ENDPOINT_V1);
  const wrongHealth = await app.handle(request("/api/v1/local-host-health", { method: "POST", headers: {
    origin, "content-type": "application/json" }, body: JSON.stringify({ nonce: "short" }) }),
  () => new Response("unused"));
  assert.equal(wrongHealth.status, 403); assert.equal(wrongHealth.headers.get("set-cookie"), null);
  const unsignedHealth = await app.handle(request("/api/v1/local-host-health", { method: "POST", headers: {
    "content-type": "application/json" }, body: JSON.stringify({ nonce }) }), () => new Response("unused"));
  assert.equal(unsignedHealth.status, 403, "even the correct code needs the exact loopback Origin");
  const remoteHealth = await app.handle(new Request(`${trustedOrigin}/api/v1/local-host-health`, { method: "POST", headers: {
    origin: trustedOrigin, "content-type": "application/json" }, body: JSON.stringify({ nonce }) }), () => new Response("unused"));
  assert.equal(remoteHealth.status, 403, "the readiness oracle exists only on the loopback origin");
  const health = await app.handle(request("/api/v1/local-host-health", { method: "POST", headers: {
    origin, "content-type": "application/json" }, body: JSON.stringify({ nonce, reqTag }) }), () => new Response("unused"));
  assert.equal(health.status, 200); assert.equal(health.headers.get("set-cookie"), null);
  assert.deepEqual(await health.json(), { schema: "control-room.local-host-health/v1", ready: true, pid: 4_243, nonce,
    releaseId: "dev", startedAt: "2026-09-30T00:00:00.000Z", tag: healthResponseTagV1(healthKey,
      LOCAL_HOST_HEALTH_ENDPOINT_V1, { schema: "control-room.local-host-health/v1", nonce, ready: true,
        pid: 4_243, releaseId: "dev", startedAt: "2026-09-30T00:00:00.000Z" }) });
  const healthRead = await app.handle(request("/api/v1/local-host-health"), () => new Response("unused"));
  assert.equal(healthRead.status, 404, "health is an authenticated POST, not a public read");
  const signedIn = await app.handle(request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response("unused"));
  assert.equal(signedIn.status, 201);
  const cookie = signedIn.headers.get("set-cookie"); assert.ok(cookie);
  const actionInboxResponse = await app.handle(request("/api/v1/needs-me/action-items", { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(actionInboxResponse.status, 200, await actionInboxResponse.clone().text());
  assert.deepEqual(await actionInboxResponse.json(), { observedAt: new Date(conformanceNow).toISOString(), items: [], truncated: false });
  const workers = await app.handle(request("/api/v1/local-workers", { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(workers.status, 200); assert.deepEqual(await workers.json(), { taskWorkersStarted: true,
    projectSections: ["overview", "inbox", "work", "pipelines", "agents", "reviews", "activity", "automations", "files", "settings"],
    workers: [{ kind: "hermes-021", state: "ready", proof: "not_proven" }] });
  const projects = await app.handle(request("/api/v1/projects", { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(projects.status, 200);
  assert.match(await projects.text(), /projects/);
  const home = await app.handle(request("/", { headers: { cookie: cookie! } }), () => new Response("real home shell"));
  assert.equal(home.status, 200);
  assert.equal(await home.text(), "real home shell");
  const morning = await app.handle(request("/morning", { headers: { cookie: cookie! } }), () => new Response("real morning shell"));
  assert.equal(morning.status, 200); assert.equal(await morning.text(), "real morning shell");
  const morningWithQuery = await app.handle(request("/morning?unexpected=value", { headers: { cookie: cookie! } }),
    () => { throw new Error("the morning page must reject query strings before it renders"); });
  assert.equal(morningWithQuery.status, 400);
  const foreignPort = await app.handle(request("/api/v1/projects", { method: "POST", headers: { cookie: cookie!, origin: "http://127.0.0.1:1", "content-type": "application/json",
    "idempotency-key": "mac-local-project-foreign-port-001" }, body: JSON.stringify({ title: "Foreign port", summary: "Must be refused" }) }),
  () => new Response("unused"));
  assert.equal(foreignPort.status, 403);
  // The push subscribe route is only mounted when push is configured, so
  // without it the route is a 404 -- which is itself worth asserting, because a
  // push install must not silently accept a subscribe it cannot honour.
  const pushWithoutConfig = await app.handle(request("/api/v1/owner-web-push", { method: "POST", headers: {
    cookie: cookie!, origin, "content-type": "application/json" },
  body: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/x", expirationTime: null,
    keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) } }) }), () => new Response("unused"));
  assert.equal(pushWithoutConfig.status, 404, "an install with no push configuration does not accept subscriptions");
  const created = await app.handle(request("/api/v1/projects", { method: "POST", headers: { cookie: cookie!, origin, "content-type": "application/json",
    "idempotency-key": "mac-local-project-create-001" }, body: JSON.stringify({ title: "Local wrapper project", summary: "Disposable route proof" }) }),
  () => new Response("unused"));
  assert.equal(created.status, 201); const projectId = (await created.json() as { project: { projectId: string } }).project.projectId;
  const foreignTenantId = "tenant:mac-local-web-foreign", foreignWorkspaceId = "workspace:mac-local-web-foreign";
  const foreignAdapterId = "adapter:mac-local-web-foreign", foreignProjectId = "project:mac-local-web-foreign";
  await fixture.client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Foreign fixture tenant') ON CONFLICT(id) DO NOTHING",
    [foreignTenantId]);
  await fixture.client.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Foreign fixture workspace')
    ON CONFLICT(id) DO NOTHING`, [foreignWorkspaceId, foreignTenantId]);
  await fixture.client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)
    ON CONFLICT(id) DO NOTHING`, [foreignAdapterId, foreignTenantId]);
  await fixture.client.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    description,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1','Foreign fixture project','Tenant isolation proof','ready','active','healthy',
      'control_room_native',$5,'{}'::jsonb,$5) ON CONFLICT(id) DO NOTHING`,
  [foreignProjectId, foreignTenantId, foreignWorkspaceId, foreignAdapterId, new Date(conformanceNow).toISOString()]);
  const detailApi = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}`, { headers: { cookie: cookie! } }),
    () => new Response("unused"));
  assert.equal(detailApi.status, 200);
  assert.equal((await detailApi.json() as { project: { projectId: string } }).project.projectId, projectId);
  const mutationHeaders = { cookie: cookie!, origin, "content-type": "application/json" };
  const skillResponse = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/skills`, {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ name: "Evidence review",
      instructions: "Cite the retained evidence and state uncertainty." }) }), () => new Response("unused"));
  assert.equal(skillResponse.status, 201); const skill = await skillResponse.json() as { skillId: string; version: number };
  const recurringInput = { schedule: "every Monday at 9", timezone: "UTC", title: "Weekly dependency check",
    instructions: "Review dependency updates and propose a report.", requiredCapability: "dependency.review",
    acceptanceCriteria: "The report cites its evidence.", acceptanceTests: "The owner reviews the cited evidence.",
    skillRefs: [{ skillId: skill.skillId, version: skill.version }] };
  const ruleResponse = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/recurring-rules`, {
    method: "POST", headers: mutationHeaders, body: JSON.stringify(recurringInput) }), () => new Response("unused"));
  assert.equal(ruleResponse.status, 201); const rule = await ruleResponse.json() as { ruleId: string; version: number };
  const edited = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/recurring-rules/${encodeURIComponent(rule.ruleId)}`, {
    method: "PUT", headers: mutationHeaders, body: JSON.stringify({ ...recurringInput,
      instructions: "Review dependency updates and propose an evidence-backed report.", expectedVersion: rule.version })
  }), () => new Response("unused"));
  assert.equal(edited.status, 200); const editedRule = await edited.json() as { version: number };
  const paused = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/recurring-rules/${encodeURIComponent(rule.ruleId)}/pause`, {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ paused: true, expectedVersion: editedRule.version })
  }), () => new Response("unused"));
  assert.equal(paused.status, 200); assert.equal((await paused.json() as { state: string }).state, "paused");
  for (const lifecycle of ["active", "paused", "completed", "archived"]) {
    const filtered = await app.handle(request(`/projects?lifecycle=${lifecycle}`, { headers: { cookie: cookie! } }),
      () => new Response("filtered project shell"));
    assert.equal(filtered.status, 200);
  }
  const change = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/lifecycle`, { method: "POST",
    headers: { cookie: cookie!, origin, "content-type": "application/json", "idempotency-key": "mac-local-lifecycle-001" },
    body: JSON.stringify({ lifecycle: "paused", expectedVersion: 1 }) }), () => new Response("unused"));
  assert.equal(change.status, 200);
  assert.equal((await change.json() as { project: { lifecycle: string } }).project.lifecycle, "paused");
  const changedDetail = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}`, { headers: { cookie: cookie! } }),
    () => new Response("unused"));
  assert.equal((await changedDetail.json() as { project: { lifecycle: string } }).project.lifecycle, "paused");
  const reopen = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/lifecycle`, { method: "POST",
    headers: { cookie: cookie!, origin, "content-type": "application/json", "idempotency-key": "mac-local-lifecycle-002" },
    body: JSON.stringify({ lifecycle: "active", expectedVersion: 2 }) }), () => new Response("unused"));
  assert.equal(reopen.status, 200);
  const tasks = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(tasks.status, 200, await tasks.text());
  const proposed = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, { method: "POST", headers: {
    cookie: cookie!, origin, "content-type": "application/json", "idempotency-key": "mac-local-task-proposal-001" },
  body: JSON.stringify({ title: "Local text task", instructions: "Return a harmless short answer." }) }), () => new Response("unused"));
  assert.equal(proposed.status, 201);
  const proposedReceipt = await proposed.json() as { receipt: { jobId: string } };
  let expectedVersion = 3;
  for (const [lifecycle, key] of [["completed", "mac-local-lifecycle-complete-001"],
    ["archived", "mac-local-lifecycle-archive-001"], ["active", "mac-local-lifecycle-reopen-001"]] as const) {
    const transitioned = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/lifecycle`, { method: "POST",
      headers: { cookie: cookie!, origin, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ lifecycle, expectedVersion }) }), () => new Response("unused"));
    assert.equal(transitioned.status, 200);
    const body = await transitioned.json() as { project: { lifecycle: string; version: number } };
    assert.equal(body.project.lifecycle, lifecycle); expectedVersion = body.project.version;
  }
  const homeTasks = await app.handle(request("/api/v1/home/tasks", { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(homeTasks.status, 200);
  assert.equal((await homeTasks.json() as { startsWork: boolean }).startsWork, false);
  const sessionWatch = await app.handle(request("/api/v1/session-watch", { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(sessionWatch.status, 200);
  assert.deepEqual(await sessionWatch.json(), { source: "configured", sessions: [], nextCursor: null,
    observedAt: new Date(conformanceNow).toISOString(), startsWork: false });
  const sessionWatchWrite = await app.handle(request("/api/v1/session-watch", { method: "POST", headers: { cookie: cookie! } }),
    () => new Response("unused"));
  assert.equal(sessionWatchWrite.status, 400);
  const attention = await app.handle(request("/api/v1/needs-me/tasks", { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(attention.status, 200);
  assert.equal((await attention.json() as { items: unknown[]; startsWork: boolean }).startsWork, false);
  const pipelineAttention = await app.handle(request("/api/v1/needs-me/pipelines", { headers: { cookie: cookie! } }),
    () => new Response("unused"));
  assert.equal(pipelineAttention.status, 200);
  assert.deepEqual(await pipelineAttention.json(), { batches: [], startsWork: false, grantsExecutionAuthority: false });
  const pipelines = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/pipelines`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(pipelines.status, 200);
  assert.deepEqual(await pipelines.json(), { batches: [], startsWork: false, grantsExecutionAuthority: false });
  const overview = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/overview`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(overview.status, 200);
  for (const malformedProjectId of ["%", "%2F", "%20", "a".repeat(201)]) {
    const malformedOverview = await app.handle(request(`/api/v1/projects/${malformedProjectId}/overview`,
      { headers: { cookie: cookie! } }), () => new Response("unused"));
    assert.equal(malformedOverview.status, 404, malformedProjectId);
    assert.deepEqual(await malformedOverview.json(), { error: "not_found" });
  }
  const reviews = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/reviews`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(reviews.status, 200);
  const inbox = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/inbox`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(inbox.status, 200);
  assert.equal((await inbox.json() as { projectId: string; startsWork: boolean }).projectId, projectId);
  const agents = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/agents`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(agents.status, 200);
  assert.deepEqual(await agents.json(), { projectId, eligibilitySource: "not_configured", workers: [], tasksExamined: 0,
    additionalTasksOmitted: false, candidateEvidence: "configured_routes_only",
    observedAt: new Date(conformanceNow).toISOString(), startsWork: false,
    grantsAssignmentAuthority: false, grantsExecutionAuthority: false });
  const foreignAgents = await app.handle(request(`/api/v1/projects/${encodeURIComponent(foreignProjectId)}/agents`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(foreignAgents.status, 404, "the agents fallback must authorize the project before synthesizing a response");
  assert.deepEqual(await foreignAgents.json(), { error: "not_found" });
  for (const section of ["agents", "settings"]) {
    for (const refusedProjectId of ["project:missing", foreignProjectId]) {
      const refusedPage = await app.handle(request(`/projects/${encodeURIComponent(refusedProjectId)}/${section}`,
        { headers: { cookie: cookie! } }), () => { throw new Error("an unavailable project section must not render"); });
      assert.equal(refusedPage.status, 404, `${section} must refuse ${refusedProjectId}`);
    }
  }
  for (const section of ["inbox", "agents"]) {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const refusedMethod = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/${section}`,
        { method, headers: { cookie: cookie! } }), () => new Response("unused"));
      assert.equal(refusedMethod.status, 400, `${method} ${section} must be refused`);
      assert.deepEqual(await refusedMethod.json(), { error: "invalid_request" });
    }
  }
  const files = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/files`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(files.status, 200);
  const shell = await app.handle(request("/projects", { headers: { cookie: cookie! } }), () => new Response("real shell"));
  assert.equal(shell.status, 200); assert.equal(await shell.text(), "real shell");
  const projectShell = await app.handle(request(`/projects/${encodeURIComponent(projectId)}`, { headers: { cookie: cookie! } }),
    () => new Response("real project shell"));
  assert.equal(projectShell.status, 200); assert.equal(await projectShell.text(), "real project shell");
  const missingPage = await app.handle(request("/projects/project:missing", { headers: { cookie: cookie! } }),
    () => { throw new Error("a missing project must not render the product shell"); });
  assert.equal(missingPage.status, 404);
  assert.match(missingPage.headers.get("content-type") ?? "", /^text\/html/);
  const missingHtml = await missingPage.text();
  assert.match(missingHtml, /<main>/);
  assert.match(missingHtml, /Page unavailable/);
  assert.match(missingHtml, /This page or saved item is not available/);
  assert.doesNotMatch(missingHtml, /\{"error"/);
  const workersShell = await app.handle(request("/workers", { headers: { cookie: cookie! } }), () => new Response("real workers shell"));
  assert.equal(workersShell.status, 200); assert.equal(await workersShell.text(), "real workers shell");
  const sessionWatchShell = await app.handle(request("/session-watch", { headers: { cookie: cookie! } }),
    () => new Response("real session watch shell"));
  assert.equal(sessionWatchShell.status, 200); assert.equal(await sessionWatchShell.text(), "real session watch shell");
  const needsShell = await app.handle(request("/needs-me", { headers: { cookie: cookie! } }), () => new Response("real needs shell"));
  assert.equal(needsShell.status, 200); assert.equal(await needsShell.text(), "real needs shell");
  for (const section of ["inbox", "pipelines", "agents", "reviews", "activity", "files", "settings"]) {
    const sectionShell = await app.handle(request(`/projects/${encodeURIComponent(projectId)}/${section}`,
      { headers: { cookie: cookie! } }), () => new Response(`real ${section} shell`));
    assert.equal(sectionShell.status, 200); assert.equal(await sectionShell.text(), `real ${section} shell`);
  }
  for (const path of [`/projects/${encodeURIComponent(projectId)}/inbox`,
    `/projects/${encodeURIComponent(projectId)}/agents`, `/projects/${encodeURIComponent(projectId)}/settings`,
    `/api/v1/projects/${encodeURIComponent(projectId)}/inbox`, `/api/v1/projects/${encodeURIComponent(projectId)}/agents`]) {
    const signedOutSection = await app.handle(request(path), () => { throw new Error("must not render or read signed-out section"); });
    assert.ok([303, 401].includes(signedOutSection.status), `${path}: ${signedOutSection.status}`);
  }
  const taskShell = await app.handle(request(`/projects/${encodeURIComponent(projectId)}/tasks`, { headers: { cookie: cookie! } }),
    () => new Response("real task shell"));
  assert.equal(taskShell.status, 200); assert.equal(await taskShell.text(), "real task shell");
  const detailShell = await app.handle(request(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(proposedReceipt.receipt.jobId)}`,
    { headers: { cookie: cookie! } }), () => new Response("real task detail shell"));
  assert.equal(detailShell.status, 200); assert.equal(await detailShell.text(), "real task detail shell");
  const selectedResultShell = await app.handle(request(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(proposedReceipt.receipt.jobId)}`
    + `?result=${encodeURIComponent("artifact:test")}`, { headers: { cookie: cookie! } }), () => new Response("real selected result shell"));
  assert.equal(selectedResultShell.status, 200); assert.equal(await selectedResultShell.text(), "real selected result shell");
  for (const search of ["?result=", "?result=bad%00id", "?result=one&result=two", `?result=${"x".repeat(300)}`]) {
    const staleResultShell = await app.handle(request(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(proposedReceipt.receipt.jobId)}${search}`,
      { headers: { cookie: cookie! } }), () => new Response("real stale result shell"));
    assert.equal(staleResultShell.status, 200, `a stale selection must not replace the page for ${search.slice(0, 40)}`);
    assert.equal(await staleResultShell.text(), "real stale result shell");
  }
  const results = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(proposedReceipt.receipt.jobId)}/results`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(results.status, 200);
  assert.equal((await results.json() as { resultSource: string }).resultSource, "configured",
    "the local website must receive the task application's result-read capability");
  const remoteRequest = (path: string, init: RequestInit = {}) => new Request(`${trustedOrigin}${path}`, init);
  const remoteSignedOut = await app.handle(remoteRequest("/projects"), () => new Response("unused"));
  assert.equal(remoteSignedOut.headers.get("location"), `${trustedOrigin}/session`);
  const remoteSigned = await app.handle(remoteRequest("/api/v1/local-owner-session", { method: "POST", headers: {
    origin: trustedOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
  body: JSON.stringify({ ownerCode }) }), () => new Response("unused"));
  assert.equal(remoteSigned.status, 201); assert.match(remoteSigned.headers.get("set-cookie") ?? "", /; Secure$/);
  const remoteCookie = remoteSigned.headers.get("set-cookie")!;
  const remoteRead = await app.handle(remoteRequest("/api/v1/projects", { headers: { cookie: remoteCookie } }), () => new Response("unused"));
  assert.equal(remoteRead.status, 200);
  const remoteWrite = await app.handle(remoteRequest("/api/v1/projects", { method: "POST", headers: { cookie: remoteCookie,
    origin: trustedOrigin, "content-type": "application/json", "idempotency-key": "mac-local-private-origin-write-001" },
  body: JSON.stringify({ title: "Private address project", summary: "Exact alternate origin proof" }) }), () => new Response("unused"));
  assert.equal(remoteWrite.status, 201);
  const foreign = await app.handle(new Request("https://foreign.example.ts.net/api/v1/projects", { headers: { cookie: remoteCookie } }),
    () => new Response("unused"));
  assert.equal(foreign.status, 403);
  const fakePreview = await app.handle(request("/local-preview", { headers: { cookie: cookie! } }), () => new Response("must not render"));
  assert.equal(fakePreview.status, 404);
  await fixture.client.query(`UPDATE control_role_grants SET role_key='operator'
    WHERE tenant_id=$1 AND role_key='owner'`, [fixture.configuration.tenantId]);
  const nonOwnerInbox = await app.handle(request("/api/v1/needs-me/action-items", { headers: { cookie: cookie! } }),
    () => new Response("unused"));
  assert.equal(nonOwnerInbox.status, 403, "wildcard actions do not replace the owner-role requirement");
  assert.equal(actionInboxReads, 1, "owner-role authority is rechecked before the canonical source is called");
  await app.close();
});

test("the Mac-local needs-me route composes saved-plan verification into the task service", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-plan-attention" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, clock: () => conformanceNow,
    taskReadKeys: { taskPlanIntegrityKey: new Uint8Array(32).fill(3), reviews: {
      integrityKey: new Uint8Array(32).fill(4), checkpoints: new InMemoryRollbackCheckpointStoreV1({ testOnly: true }) } } });
  t.after(() => app.close());
  const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);
  const signedIn = await app.handle(request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }),
  () => new Response("unused"));
  const cookie = signedIn.headers.get("set-cookie"); assert.ok(cookie);
  const attention = await app.handle(request("/api/v1/needs-me/tasks", { headers: { cookie: cookie! } }),
    () => new Response("unused"));
  assert.equal(attention.status, 200, await attention.clone().text());
  assert.equal((await attention.json() as { planningSource: string }).planningSource, "configured");
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
  const calls: unknown[][] = [], projectReads: unknown[][] = [];
  let commandCalls = 0;
  const app = createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, clock: () => conformanceNow,
    assignment: { tenantId: fixture.configuration.tenantId, workspaceId: fixture.configuration.workspaceId,
      async projectOptions(...input) {
        projectReads.push(input);
        return { projectId: input[1], eligibilitySource: "configured" as const, workers: [], tasksExamined: 0,
          additionalTasksOmitted: false, candidateEvidence: "configured_routes_only" as const,
          observedAt: new Date(conformanceNow).toISOString(), startsWork: false as const,
          grantsAssignmentAuthority: false as const, grantsExecutionAuthority: false as const };
      }, async options(...input) {
      calls.push(input);
      const [, projectId, jobId] = input as [unknown, string, string];
      return { projectId, jobId, inputDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        candidates: [], recommendation: { state: "not_available", availability: "unknown", startsWork: false, grantsExecutionAuthority: false },
        receipt: null, startsWork: false, candidateEvidence: "configured_routes_only" };
    }, async assign() { commandCalls += 1; throw new Error("not used"); }, async expire() { throw new Error("not used"); },
      async revoke() { throw new Error("not used"); }, async cancel() { throw new Error("not used"); } },
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
  const projectAgents = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/agents`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(projectAgents.status, 200, await projectAgents.clone().text());
  assert.equal((await projectAgents.json() as { startsWork: boolean }).startsWork, false);
  assert.equal(projectReads.length, 1);
  assert.equal(commandCalls, 0, "project agent reads must not emit assignment commands");
  await app.close();
});

test("the Mac-local transport stays loopback-only and admits only one configured exact HTTPS host", async () => {
  const origin = "http://127.0.0.1:3210";
  const trustedOrigin = "https://control-room-mac.example.ts.net";
  assert.throws(() => createMacLocalNodeHandler({ origin: "https://private.example.invalid", application: {
    isReady: () => true, close: async () => {},
  }, handler: async () => new Response("unused"), assets: { count: 0, digest: "empty", respond: () => undefined } }),
  /mac_local_serving_config_invalid/);
  const receivedMethods: string[] = [], receivedEventIds: (string | null)[] = [];
  const handler = createMacLocalNodeHandler({ origin, secondaryOrigin: trustedOrigin,
    application: { isReady: () => true, close: async () => {} },
    handler: async request => { receivedMethods.push(request.method); receivedEventIds.push(request.headers.get("last-event-id"));
      return new Response("ok", { headers: { "set-cookie": "control_room_local_owner=value; HttpOnly" } }); },
    assets: { count: 0, digest: "empty", respond: () => undefined } });
  const exchange = nodeExchange({ path: "/session" }); exchange.input.rawHeaders[1] = "127.0.0.1:3210";
  const done = new Promise<void>((resolve, reject) => { exchange.output.once("finish", resolve); exchange.output.once("error", reject); });
  void handler.handle(exchange.input, exchange.output); await done;
  assert.equal(exchange.headers.get("set-cookie"), "control_room_local_owner=value; HttpOnly");

  const remote = nodeExchange({ path: "/projects", headers: ["Origin", trustedOrigin] });
  remote.input.rawHeaders[1] = "control-room-mac.example.ts.net";
  const remoteDone = new Promise<void>((resolve, reject) => { remote.output.once("finish", resolve); remote.output.once("error", reject); });
  void handler.handle(remote.input, remote.output); await remoteDone;
  assert.equal(remote.output.statusCode, 200);

  const resumed = nodeExchange({ path: "/api/v1/projects/project:test/events", headers: ["Last-Event-ID", "cursor-from-browser"] });
  resumed.input.rawHeaders[1] = "127.0.0.1:3210";
  const resumedDone = new Promise<void>((resolve, reject) => { resumed.output.once("finish", resolve); resumed.output.once("error", reject); });
  void handler.handle(resumed.input, resumed.output); await resumedDone;
  assert.equal(resumed.output.statusCode, 200); assert.equal(receivedEventIds.at(-1), "cursor-from-browser");

  const signOut = nodeExchange({ path: "/api/v1/local-owner-session", method: "DELETE" });
  signOut.input.rawHeaders[1] = "127.0.0.1:3210";
  const signOutDone = new Promise<void>((resolve, reject) => { signOut.output.once("finish", resolve); signOut.output.once("error", reject); });
  void handler.handle(signOut.input, signOut.output); await signOutDone;
  assert.equal(signOut.output.statusCode, 200);
  assert.deepEqual(receivedMethods, ["GET", "GET", "GET", "DELETE"]);

  const demoHandler = createContributorDemoNodeHandler({ origin: "http://127.0.0.1:3000",
    application: { isReady: () => true, close: async () => {} }, handler: async () => new Response("unexpected"),
    assets: { count: 0, digest: "empty", respond: () => undefined } });
  const demoDelete = nodeExchange({ path: "/api/v1/local-owner-session", method: "DELETE" });
  demoDelete.input.rawHeaders[1] = "127.0.0.1:3000";
  const demoDeleteDone = new Promise<void>((resolve, reject) => { demoDelete.output.once("finish", resolve); demoDelete.output.once("error", reject); });
  void demoHandler.handle(demoDelete.input, demoDelete.output); await demoDeleteDone;
  assert.equal(demoDelete.output.statusCode, 405);

  const foreign = nodeExchange({ path: "/projects", headers: ["Origin", "https://foreign.example.ts.net"] });
  foreign.input.rawHeaders[1] = "foreign.example.ts.net";
  const foreignDone = new Promise<void>((resolve, reject) => { foreign.output.once("finish", resolve); foreign.output.once("error", reject); });
  void handler.handle(foreign.input, foreign.output); await foreignDone;
  assert.equal(foreign.output.statusCode, 403);
});
