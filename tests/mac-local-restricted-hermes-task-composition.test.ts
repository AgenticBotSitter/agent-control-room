import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalRestrictedHermesTaskApplicationV1 } from "../src/web/v1/mac-local-restricted-hermes-task-composition";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

test("combines one restricted Mac task lifecycle with the existing Hermes queue bridge without starting it", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), c = f.configuration;
  const result = await createMacLocalRestrictedHermesTaskApplicationV1({
    web: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId, tasks: c.web.tasks, database: f.openDatabase(c.web.database) },
    databaseRoles: { schema: MAC_LOCAL_DATABASE_ROLES_V1, web: c.web.database, coordinator: c.coordinator.database,
      results: c.coordinator.resultDatabase!, publisher: { ...c.coordinator.database, username: "publisher_test" },
      queueWorker: { ...c.coordinator.database, username: "worker_test" } },
    openDatabase: role => f.openDatabase(role),
    coordinator: { scope: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId }, planning: c.coordinator.planning,
      routes: c.coordinator.routes, approvals: c.coordinator.approvals, quality: c.coordinator.quality,
      revisionPlanning: c.coordinator.revisionPlanning, nativeSubmission: { async enqueueInSession() {} } },
    hermes: { tenantId: c.web.tenantId, execution: { delivery: {} } as never, results: {} as never, assertAuthority() {}, runner: {},
      admission: { installationId: "installation:mac", installationPlanDigest: "plan", topologyPlanDigest: "topology",
        releaseDigest: "release", workerBinding: { localServiceId: "service:mac", workerId: "worker:mac", expectedVersion: "0.21.3", sourceRevision: "a1b2c3d4" } } },
  });
  assert.equal(typeof result.queueDelivery, "function");
  assert.ok(!f.trace.includes("queue-start"));
  await result.close();
});
