import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalTaskApplicationV1 } from "../src/web/v1/mac-local-task-application";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { sha256Digest } from "../src/security";
import type { ActionInboxItemV1 } from "../src/operator-surfaces/v1";
import { binding, instant } from "./hermes-native-fixture";

test("Mac-local task composition reuses the canonical operations without starting a queue or worker", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), configuration = f.configuration;
  const manualVerificationScenarios = [{ scenarioId: "scenario:human", label: "Owner observation",
    instructions: "Read the result and record what you observed.", acceptanceProfileId: "profile:test",
    acceptanceProfileDigest: sha256Digest({ profile: "test" }) }];
  const tasks = { ...configuration.web.tasks!, ownerReviews: {
    integrityKey: f.lifecycle.f.ownerConfig.integrityKey,
    checkpoints: f.lifecycle.f.ownerConfig.checkpoints,
  }, manualVerificationScenarios };
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
    workBatches: { integrityKey: new Uint8Array(32).fill(44), selectionAuthority: { assertCurrent: () => true } },
  };
  const webDatabase = f.openDatabase(configuration.web.database);
  const app = await createMacLocalTaskApplicationV1({
    web: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId,
      tasks, database: webDatabase },
    coordinator,
  });

  assert.equal(app.isReady(), true);
  assert.equal(typeof app.operations.planning?.plan, "function");
  assert.equal(typeof app.operations.assignment?.assign, "function");
  assert.equal(typeof app.operations.approvals?.prepare, "function");
  assert.equal(typeof app.operations.ownerReviews?.record, "function");
  assert.equal(typeof app.taskService.proposeWithDependenciesInSession, "function",
    "owner reviews share the ordinary task service needed to create exception follow-ups");
  assert.strictEqual((app.operations.ownerReviews as unknown as { followUps?: unknown }).followUps, app.taskService,
    "accepted-with-exceptions must use the app's one ordinary task service, not an unconfigured review port");
  assert.equal(typeof app.operations.ownerVerifications?.record, "function",
    "Mac-local mounts the separately configured human verification operation");
  assert.equal(app.taskReadKeys?.results, tasks.results, "the host must pass the same result reader to the local website");
  assert.deepEqual(app.taskReadKeys?.taskPlanIntegrityKey, coordinator.planning.integrityKey,
    "revision links must use the execution-plan key rather than the independent review key");
  assert.notEqual(app.taskReadKeys?.taskPlanIntegrityKey, coordinator.planning.integrityKey,
    "the browser-facing reader receives an isolated key copy");
  assert.equal(app.taskReadKeys?.ownerReviews, tasks.ownerReviews,
    "the result page must advertise owner review only when its mounted review operation is configured");
  assert.equal(app.taskReadKeys?.manualVerificationScenarios, manualVerificationScenarios,
    "the Mac-local result page receives the same human-only scenario source as the write operation");
  assert.equal(typeof app.projectEvents?.read, "function",
    "the Mac-local task host receives the canonical read-only project-event source");
  const actionSource = await app.actionInboxSource?.read({ tenantId: configuration.web.tenantId,
    actorId: "identity:test", grantedAt: "2026-09-28T10:00:00.000Z", now: "2026-09-28T11:00:00.000Z" });
  assert.deepEqual(actionSource, { observedAt: "2026-09-28T11:00:00.000Z", items: [], truncated: false },
    "canonical attention is read through the coordinator role, never the web connection");
  await assert.rejects(app.actionInboxSource?.read({ tenantId: "tenant:other", actorId: "identity:test",
    grantedAt: "2026-09-28T10:00:00.000Z", now: "2026-09-28T11:00:00.000Z" }) ?? Promise.resolve(),
  /action_inbox_scope_mismatch/, "the source must enforce its server-bound tenant scope");
  const inboxItem = (patch: Partial<ActionInboxItemV1>): ActionInboxItemV1 => ({ id: "attention:open",
    tenantId: configuration.web.tenantId, kind: "approval", state: "open", requestedAction: "Review older approval",
    reasonCode: "approval_waiting", blockedWorkItemIds: [], legalResponses: [{ id: "response:review", kind: "open_source",
      label: "Review source", requiresConfirmation: false, available: true }], evidence: [],
    createdAt: "2025-01-01T00:00:00.000Z", deliveryState: "not_requested", ...patch });
  const insertInboxItem = async (item: ActionInboxItemV1) => f.startup.raw.query(
    `INSERT INTO control_action_inbox
      (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
     VALUES ($1,$2,NULL,NULL,$3,$4,$5,$6,NULL,$7::jsonb)`,
    [item.id,item.tenantId,item.kind,item.state,item.deliveryState,item.createdAt,JSON.stringify(item)]);
  await insertInboxItem(inboxItem({}));
  for (let index = 0; index < 501; index += 1) await insertInboxItem(inboxItem({ id: `attention:resolved-${index}`,
    state: "resolved", requestedAction: `Resolved item ${index}`, createdAt: "2026-09-28T10:30:00.000Z" }));
  const crowdedSource = await app.actionInboxSource?.read({ tenantId: configuration.web.tenantId,
    actorId: "identity:test", grantedAt: "2026-09-28T10:00:00.000Z", now: "2026-09-28T11:00:00.000Z" });
  assert.deepEqual(crowdedSource?.items.map(item => item.id), ["attention:open"],
    "newer resolved history must not hide an older open action");
  assert.equal(crowdedSource?.truncated, false, "resolved history must not raise an open-action truncation warning");
  assert.equal(app.queueDelivery, undefined, "constructing the local website must not start or imply a queue worker");
  assert.equal(typeof app.workBatchAuthority?.acceptedResultProof, "function",
    "production composition must expose the owner authority that projects authenticated predecessor provenance");
  assert.equal(app.workBatchAuthority?.binding, "caller_transaction",
    "the controller-side authority must resolve on its caller's transaction");
  assert.equal(app.workBatchView?.binding, "coordinator_snapshot",
    "the web login must get the session-free coordinator snapshot");
  assert.ok(!f.trace.includes("queue-start"));

  await app.close();
  for (const name of ["coordinator_test", "result_test", "evidence_test", "session_test"])
    assert.equal(f.pools.get(name)?.closes(), 1, name);
  assert.equal(f.pools.get("web_test")?.closes(), 0, "the loopback host retains its own restricted web connection");
  await webDatabase.close();
  assert.equal(f.pools.get("web_test")?.closes(), 1);
});

test("Mac-local task composition refuses to collapse the web and controller roles into one connection", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), configuration = f.configuration;
  const web = f.openDatabase(configuration.web.database);
  await assert.rejects(createMacLocalTaskApplicationV1({
    web: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId,
      tasks: configuration.web.tasks, database: web },
    coordinator: {
      scope: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId },
      database: web, planning: configuration.coordinator.planning, routes: configuration.coordinator.routes,
    },
  }), /mac_local_task_application_config_invalid/);
  assert.equal(web.closes(), 0, "a rejected configuration does not take ownership of a caller connection");
});

test("the Mac-local owner route records accepted-with-exceptions, creates follow-ups atomically, and replays", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-exception-review-owner-code";
  const process = createMacLocalWebProcessV1({ origin, workspaceId: f.scope.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: f.scope.tenantId,
      provider: f.identity.provider, subject: "test-owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: f.db, close: async () => {} }, taskService: f.tasks, taskReadKeys: f.taskKeys,
    ownerReviews: f.reviews, clock: () => instant + 6000 });
  t.after(process.close);
  const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);
  const signedIn = await process.handle(request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }),
  () => new Response("unused"));
  assert.equal(signedIn.status, 201);
  const cookie = signedIn.headers.get("set-cookie"); assert.ok(cookie);
  const draft = { ...f.draft, decision: "accepted_with_exceptions" as const, feedback: "",
    exceptions: ["Add a timeout retry test", "Document the recovery procedure"] };
  const path = `/api/v1/projects/${encodeURIComponent(binding.projectId)}/tasks/${encodeURIComponent(binding.jobId)}`
    + `/results/${encodeURIComponent(f.artifact.artifactId)}/reviews/${encodeURIComponent(f.target.id)}`;
  const post = () => process.handle(request(path, { method: "POST", headers: { cookie: cookie!, origin,
    "content-type": "application/json", "idempotency-key": "mac-local-exceptions-review-001" }, body: JSON.stringify(draft) }),
  () => new Response("unused"));

  const recorded = await post();
  assert.equal(recorded.status, 201, await recorded.clone().text());
  const first = await recorded.json() as { replayed: boolean; receipt: { exceptions?: { followUpJobId: string }[] } };
  assert.equal(first.replayed, false);
  const followUps = first.receipt.exceptions?.map(exception => exception.followUpJobId) ?? [];
  assert.equal(followUps.length, 2);
  assert.equal(new Set(followUps).size, 2);
  const rows = await f.db.query<{ state: string }>(`SELECT state FROM control_jobs
    WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id`, [binding.tenantId, followUps]);
  assert.deepEqual(rows.rows.map(row => row.state), ["proposed", "proposed"],
    "the review transaction only materializes non-runnable follow-ups");

  const replay = await post();
  assert.equal(replay.status, 200, await replay.clone().text());
  const replayed = await replay.json() as { replayed: boolean; receipt: { exceptions?: { followUpJobId: string }[] } };
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.receipt.exceptions?.map(exception => exception.followUpJobId), followUps);
  const total = await f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_jobs WHERE tenant_id=$1", [binding.tenantId]);
  assert.equal(total.rows[0]?.count, "3", "retrying the review does not create another batch of follow-ups");
});

test("the Mac-local web process refuses an owner-review composition without its shared task service", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const origin = "http://127.0.0.1:3210";
  assert.throws(() => createMacLocalWebProcessV1({ origin, workspaceId: f.scope.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: f.scope.tenantId,
      provider: f.identity.provider, subject: "test-owner", ownerCodeDigest: sha256Digest({ ownerCode: "a sufficiently long owner code" }), sessionSeconds: 900 },
    database: { client: f.db, close: async () => {} }, taskReadKeys: f.taskKeys, ownerReviews: f.reviews,
    clock: () => instant + 6000 }), /mac_local_web_process_config_invalid/);
});
