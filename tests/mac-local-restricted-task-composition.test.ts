import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalRestrictedTaskApplicationV1 } from "../src/web/v1/mac-local-restricted-task-composition";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

test("opens only the existing restricted controller and results roles for the Mac task lifecycle", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), configuration = f.configuration;
  const roles = {
    schema: MAC_LOCAL_DATABASE_ROLES_V1,
    web: configuration.web.database,
    coordinator: configuration.coordinator.database,
    results: configuration.coordinator.resultDatabase!,
    publisher: { ...configuration.coordinator.database, username: "publisher_test" },
    queueWorker: { ...configuration.coordinator.database, username: "worker_test" },
  } as const;
  const application = await createMacLocalRestrictedTaskApplicationV1({
    web: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId,
      tasks: configuration.web.tasks, database: f.openDatabase(configuration.web.database) },
    databaseRoles: roles,
    openDatabase: role => f.openDatabase(role),
    coordinator: {
      scope: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId },
      planning: configuration.coordinator.planning, routes: configuration.coordinator.routes,
      approvals: configuration.coordinator.approvals, quality: configuration.coordinator.quality,
      revisionPlanning: configuration.coordinator.revisionPlanning,
    },
  });
  assert.equal(application.isReady(), true);
  assert.equal(typeof application.operations.planning?.plan, "function");
  assert.equal(application.queueDelivery, undefined, "opening the roles never starts a queue or worker");
  assert.ok(!f.trace.includes("queue-start"));
  await application.close();
  assert.equal(f.pools.get("coordinator_test")?.closes(), 1);
  assert.equal(f.pools.get("result_test")?.closes(), 1);
  assert.equal(f.pools.get("web_test")?.closes(), 0, "the loopback host still owns its web role");
});

test("refuses reuse of the loopback web connection for a controller role", async () => {
  await assert.rejects(createMacLocalRestrictedTaskApplicationV1({
    web: { database: { client: {} } } as never,
    databaseRoles: {} as never,
    openDatabase: () => ({ client: {} as never, async close() {}, isAvailable: () => true }),
    coordinator: {} as never,
  }), /mac_local_(database_roles|restricted_task_composition)_/);
});
