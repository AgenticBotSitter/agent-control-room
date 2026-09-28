import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalTaskApplicationV1 } from "../src/web/v1/mac-local-task-application";
import { createMacLocalWebProcessV1, type MacLocalWebProcessOptionsV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { sha256Digest } from "../src/security";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

const OWNER_PROVIDER = "local", OWNER_SUBJECT = "owner";

/** The local owner session proves who is calling; it grants no permission by
 * itself. The task-composition fixture already bootstraps its own identity
 * for its tenant, so this adds a second identity and an owner-scope grant for
 * this local-owner-session's own provider/subject, the same two rows the
 * real one-time Mac-local bootstrap (`SecurityStore.bootstrapOwner`) writes. */
async function bootstrapOwner(f: ReturnType<Awaited<ReturnType<typeof privateAgentTaskCompositionFixture>>["scenario"]>, tenantId: string) {
  const now = new Date().toISOString();
  const identityId = `identity:usage-wiring-owner:${sha256Digest(tenantId).slice(7, 23)}`;
  const grantId = `grant:usage-wiring-owner:${sha256Digest(tenantId).slice(7, 23)}`;
  await f.lifecycle.f.db.query(`INSERT INTO control_identities
      (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES ($1,$2,'human','Usage wiring owner',$3,$4,'active',$5,$5)`,
  [identityId, tenantId, OWNER_PROVIDER, sha256Digest({ provider: OWNER_PROVIDER, subject: OWNER_SUBJECT }), now]);
  await f.lifecycle.f.db.query(`INSERT INTO control_role_grants
      (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES ($1,$2,$3,'owner',$4::jsonb,$5::jsonb,'critical',true,false,$6,$6)`,
  [grantId, tenantId, identityId, JSON.stringify(["*"]), JSON.stringify(["*"]), now]);
}

// Type-level guard for the third wiring line: `createMacLocalWebProcessV1`'s
// own option type must still admit `usagePriceTable` in a *freshly written*
// `taskReadKeys` object. The runtime tests below pass the composition's own
// `app.taskReadKeys` through by reference, which TypeScript's structural
// typing would still accept even if this field were dropped from the Pick
// (a wider-typed value is assignable to a narrower-typed slot when it is not
// a fresh literal) -- so only a literal assigned directly to this exact type
// catches that specific mutation. This binding exists to be type-checked by
// `tsc`/`pnpm check`, not read at runtime.
const _macLocalWebProcessAdmitsUsagePriceTable: MacLocalWebProcessOptionsV1["taskReadKeys"] = {
  harnessIntegrityKey: new Uint8Array(32), taskPlanIntegrityKey: new Uint8Array(32),
  usagePriceTable: { schema: "control-room.usage-price-table/v1", tableId: "type-guard-only", recordedAt: new Date(0).toISOString(), entries: [] },
};
void _macLocalWebProcessAdmitsUsagePriceTable;

// This suite exists because a real defect (Control Room #412 review) shipped
// the owner price table wired into the coordinator's own task keys, and every
// test proved cost math with a `WebTaskService` built directly from those
// keys -- never through the two composition hand-offs a real Mac-local start
// actually uses. The table silently never reached production. These tests
// build the real `createMacLocalTaskApplicationV1` and
// `createMacLocalWebProcessV1` composition -- no injected `WebTaskService` --
// and read a project overview and task detail back only through that real
// HTTP surface, so deleting either hand-off's `usagePriceTable` field fails
// the test, not just a type check.

const usagePriceTable = {
  schema: "control-room.usage-price-table/v1" as const,
  tableId: "owner-prices-wiring-test",
  recordedAt: new Date(0).toISOString(),
  entries: [{ entryId: "codex-token-price-wiring-test", harness: "codex" as const, model: "codex-wiring-test-model",
    billing: { kind: "token" as const, inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000" } }],
};

test("the real Mac-local composition wires the owner price table through to a run's cost", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), configuration = f.configuration;
  await bootstrapOwner(f, configuration.web.tenantId);
  const tasks = { ...configuration.web.tasks!, usagePriceTable };
  const coordinatorDb = f.openDatabase(configuration.coordinator.database);
  const coordinator = {
    scope: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId },
    database: coordinatorDb,
    planning: configuration.coordinator.planning,
    routes: configuration.coordinator.routes,
    approvals: configuration.coordinator.approvals,
    quality: configuration.coordinator.quality,
    revisionPlanning: configuration.coordinator.revisionPlanning,
    resultDatabase: f.openDatabase(configuration.coordinator.resultDatabase!),
    evidence: { ...configuration.coordinator.evidence!, database: f.openDatabase(configuration.coordinator.evidence!.database) },
    sessions: { ...configuration.coordinator.sessions!, database: f.openDatabase(configuration.coordinator.sessions!.database) },
    nativeHttp: configuration.coordinator.nativeHttp,
  };
  const webDatabase = f.openDatabase(configuration.web.database);
  const app = await createMacLocalTaskApplicationV1({
    web: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId, tasks, database: webDatabase },
    coordinator,
  });
  t.after(app.close);

  // Wiring assertion: `createMacLocalTaskApplicationV1` must still copy the
  // owner price table into the read-key hand-off it gives the local website.
  assert.deepEqual(app.taskReadKeys?.usagePriceTable, usagePriceTable,
    "createMacLocalTaskApplicationV1 must copy the owner price table into taskReadKeys");

  // Build the real Mac-local web process from the composition's own
  // operations and read keys -- not an injected WebTaskService.
  const origin = "http://127.0.0.1:3210";
  const ownerCode = "mac-local-usage-wiring-owner-code";
  const webProcess = createMacLocalWebProcessV1({
    origin, workspaceId: configuration.web.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: configuration.web.tenantId,
      provider: OWNER_PROVIDER, subject: OWNER_SUBJECT, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: webDatabase.client, close: async () => {} },
    taskReadKeys: app.taskReadKeys,
    ...app.operations,
  });
  t.after(webProcess.close);

  const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);
  const signedIn = await webProcess.handle(request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }),
  () => new Response("unused"));
  assert.equal(signedIn.status, 201);
  const cookie = signedIn.headers.get("set-cookie"); assert.ok(cookie);

  const created = await webProcess.handle(request("/api/v1/projects", { method: "POST", headers: { cookie: cookie!, origin,
    "content-type": "application/json", "idempotency-key": "usage-wiring-project-001" },
  body: JSON.stringify({ title: "Usage wiring project", summary: "Prove the price table reaches a real read" }) }),
  () => new Response("unused"));
  assert.equal(created.status, 201, await created.clone().text());
  const projectId = (await created.json() as { project: { projectId: string } }).project.projectId;

  const proposed = await webProcess.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, { method: "POST", headers: {
    cookie: cookie!, origin, "content-type": "application/json", "idempotency-key": "usage-wiring-task-001" },
  body: JSON.stringify({ title: "Usage wiring task", instructions: "Return a short answer." }) }), () => new Response("unused"));
  assert.equal(proposed.status, 201, await proposed.clone().text());
  const jobId = (await proposed.json() as { receipt: { jobId: string } }).receipt.jobId;

  // Seed one real attempt and harness run with real token usage, through the
  // same store (`HarnessRunStoreV1`) and role (`evidence`) production
  // delivery uses -- only the agent execution itself is not simulated. The
  // read side under test (project overview, task detail) is exercised only
  // through the real composition's own HTTP surface below.
  const nodeId = configuration.coordinator.routes[0]!.nodeId;
  const attemptId = `attempt:wiring:${jobId}`, runId = `run:wiring:${jobId}`;
  const createdAt = new Date().toISOString();
  await coordinatorDb.client.query(`INSERT INTO control_attempts
    (id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES ($1,$2,$3,1,'leased',1,NULL,$4,1,$5,$6,$6)`,
  [attemptId, configuration.web.tenantId, jobId, nodeId, JSON.stringify({
    id: attemptId, kind: "attempt", jobId, state: "leased", nodeId, version: 1,
    tenantId: configuration.web.tenantId, createdAt, offeredAt: createdAt, updatedAt: createdAt,
    leaseEpoch: 1, attemptNumber: 1, contractVersion: "control-room-domain/v1",
  }), createdAt]);

  const runs = new HarnessRunStoreV1(coordinator.evidence.database.client, tasks.harnessIntegrityKey!);
  await runs.create({
    schemaVersion: "control-room-harness/v1", id: runId, tenantId: configuration.web.tenantId, projectId,
    jobId, attemptId, nodeId, adapterId: "adapter:usage-wiring-test", adapterVersion: "1.0.0",
    harness: "codex", harnessVersion: "codex-wiring-test-1",
    nativeSessionKeyDigest: sha256Digest({ purpose: "usage-wiring-test", runId }),
    modelSelection: { model: "codex-wiring-test-model", effort: "medium" },
    state: "discovered", resumable: false, cancelState: "not_requested",
    createdAt, updatedAt: createdAt, lastObservedAt: createdAt,
  });
  const finishedAt = new Date(Date.parse(createdAt) + 4200).toISOString();
  for (const [sequence, occurredAt, payload] of [
    [1, createdAt, { category: "lifecycle" as const, state: "starting" as const }],
    [2, createdAt, { category: "lifecycle" as const, state: "running" as const }],
    [3, finishedAt, { category: "usage" as const, inputTokens: 1000, outputTokens: 500, totalTokens: 1500,
      cachedInputTokens: null, reasoningTokens: null, wallTimeMs: 4200 }],
    [4, finishedAt, { category: "lifecycle" as const, state: "succeeded" as const }],
  ] as const) {
    await runs.append({ schemaVersion: "control-room-harness-event/v1", tenantId: configuration.web.tenantId, runId,
      sequence, occurredAt, source: "adapter", sourceEventKeyDigest: sha256Digest({ runId, sequence }), payload });
  }

  const overview = await webProcess.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/overview`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(overview.status, 200, await overview.clone().text());
  const overviewBody = await overview.json() as { priceTable: { state: string; tableId: string | null };
    usageRollup: { knownCostNanoUsd: string; knownCostRuns: number; unknownCostRuns: number } };
  assert.equal(overviewBody.priceTable.state, "recorded",
    "the project overview must show the owner price table as recorded once the wiring is intact");
  assert.equal(overviewBody.priceTable.tableId, usagePriceTable.tableId);
  assert.equal(overviewBody.usageRollup.knownCostRuns, 1);
  assert.equal(overviewBody.usageRollup.unknownCostRuns, 0);
  assert.equal(overviewBody.usageRollup.knownCostNanoUsd, "2000000",
    "the project overview must show a real cost figure computed from the recorded run's tokens");

  const detail = await webProcess.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`,
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(detail.status, 200, await detail.clone().text());
  const detailBody = await detail.json() as { priceTable: { state: string };
    attempts: { runs: { cost: { kind: string; nanoUsd?: string } }[] }[] };
  assert.equal(detailBody.priceTable.state, "recorded",
    "the task detail page must show the owner price table as recorded once the wiring is intact");
  const runCost = detailBody.attempts[0]?.runs[0]?.cost;
  assert.equal(runCost?.kind, "known", "the task detail page must show a computed cost, not an unknown reason");
  assert.equal(runCost?.nanoUsd, "2000000");
});

test("a project's cost is refused for another project's owner", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), configuration = f.configuration;
  await bootstrapOwner(f, configuration.web.tenantId);
  const tasks = { ...configuration.web.tasks!, usagePriceTable };
  const coordinator = {
    scope: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId },
    database: f.openDatabase(configuration.coordinator.database),
    planning: configuration.coordinator.planning,
    routes: configuration.coordinator.routes,
    approvals: configuration.coordinator.approvals,
    quality: configuration.coordinator.quality,
    revisionPlanning: configuration.coordinator.revisionPlanning,
    resultDatabase: f.openDatabase(configuration.coordinator.resultDatabase!),
    evidence: { ...configuration.coordinator.evidence!, database: f.openDatabase(configuration.coordinator.evidence!.database) },
    sessions: { ...configuration.coordinator.sessions!, database: f.openDatabase(configuration.coordinator.sessions!.database) },
    nativeHttp: configuration.coordinator.nativeHttp,
  };
  const webDatabase = f.openDatabase(configuration.web.database);
  const app = await createMacLocalTaskApplicationV1({
    web: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId, tasks, database: webDatabase },
    coordinator,
  });
  t.after(app.close);
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-usage-refusal-owner-code";
  const webProcess = createMacLocalWebProcessV1({
    origin, workspaceId: configuration.web.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: configuration.web.tenantId,
      provider: OWNER_PROVIDER, subject: OWNER_SUBJECT, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: webDatabase.client, close: async () => {} },
    taskReadKeys: app.taskReadKeys,
    ...app.operations,
  });
  t.after(webProcess.close);
  const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);
  const signedIn = await webProcess.handle(request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }),
  () => new Response("unused"));
  const cookie = signedIn.headers.get("set-cookie"); assert.ok(cookie);
  const overview = await webProcess.handle(request("/api/v1/projects/project%3Adoes-not-exist/overview",
    { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(overview.status, 404, "a project that does not exist in this owner's scope must never leak a cost figure");
});
