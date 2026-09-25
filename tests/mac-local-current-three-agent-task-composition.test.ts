import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalCurrentThreeAgentTaskApplicationV1 } from "../src/web/v1/mac-local-current-three-agent-task-composition";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

test("composes current Hermes, Claude, and Codex into the existing local task lifecycle", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), c = f.configuration;
  const app = await createMacLocalCurrentThreeAgentTaskApplicationV1({
    web: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId, tasks: c.web.tasks, database: f.openDatabase(c.web.database) },
    databaseRoles: { schema: MAC_LOCAL_DATABASE_ROLES_V1, web: c.web.database, coordinator: c.coordinator.database,
      results: c.coordinator.resultDatabase!, queueWorker: { ...c.coordinator.database, username: "worker_test" } },
    openDatabase: role => f.openDatabase(role),
    coordinator: { scope: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId }, planning: c.coordinator.planning,
      routes: c.coordinator.routes, approvals: c.coordinator.approvals, quality: c.coordinator.quality,
      revisionPlanning: c.coordinator.revisionPlanning, nativeSubmission: { async enqueueInSession() {} } },
    hermes: { tenantId: c.web.tenantId, preparation: { async prepare() { throw new Error("must_not_prepare_hermes"); },
      async assertCurrent() { throw new Error("must_not_prepare_hermes"); } },
    delivery: { async deliver() { throw new Error("must_not_start_hermes"); } } },
    claude: { async deliver() { throw new Error("must_not_start_claude"); } },
    codex: { async deliver() { throw new Error("must_not_start_codex"); } },
  });
  assert.equal(typeof app.queueDelivery, "function");
  assert.equal(app.isReady(), true);
  assert.ok(!f.trace.includes("queue-start"), "composition does not start a queue or local worker");
  await app.close();
});

test("refuses a caller-supplied current Hermes worker route", async () => {
  const input = { web: { tenantId: "tenant:one" }, coordinator: { scope: { tenantId: "tenant:one" },
    hermesLocal: { async deliver() {} } }, hermes: { tenantId: "tenant:one" },
    claude: { async deliver() {} }, codex: { async deliver() {} } } as never;
  await assert.rejects(createMacLocalCurrentThreeAgentTaskApplicationV1(input),
    /mac_local_current_three_agent_task_composition_invalid/);
});
