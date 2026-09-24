import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalTaskApplicationV1 } from "../src/web/v1/mac-local-task-application";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

test("Mac-local task composition reuses the canonical operations without starting a queue or worker", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), configuration = f.configuration;
  const tasks = { ...configuration.web.tasks!, ownerReviews: {
    integrityKey: f.lifecycle.f.ownerConfig.integrityKey,
    checkpoints: f.lifecycle.f.ownerConfig.checkpoints,
  } };
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
  assert.equal(app.operations.ownerVerifications, undefined, "manual verification remains unavailable until explicitly configured");
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
