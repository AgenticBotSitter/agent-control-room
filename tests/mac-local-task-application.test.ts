import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalTaskApplicationV1 } from "../src/web/v1/mac-local-task-application";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";
import { sha256Digest } from "../src/security";
import type { ActionInboxItemV1 } from "../src/operator-surfaces/v1";

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
