import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalRestrictedThreeAgentTaskApplicationV1 } from "../src/web/v1/mac-local-restricted-three-agent-task-composition";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

test("composes Hermes, Claude, and managed Codex into one restricted task lifecycle", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), c = f.configuration;
  const app = await createMacLocalRestrictedThreeAgentTaskApplicationV1({
    web: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId, tasks: c.web.tasks, database: f.openDatabase(c.web.database) },
    databaseRoles: { schema: MAC_LOCAL_DATABASE_ROLES_V1, web: c.web.database, coordinator: c.coordinator.database,
      results: c.coordinator.resultDatabase!, publisher: { ...c.coordinator.database, username: "publisher_test" },
      queueWorker: { ...c.coordinator.database, username: "worker_test" } },
    openDatabase: role => f.openDatabase(role),
    coordinator: { scope: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId }, planning: c.coordinator.planning,
      routes: c.coordinator.routes, approvals: c.coordinator.approvals, quality: c.coordinator.quality,
      revisionPlanning: c.coordinator.revisionPlanning, nativeSubmission: { async enqueueInSession() {} } },
    hermes: { tenantId: c.web.tenantId, execution: { delivery: { binding: { localServiceId: "service:mac", workerId: "worker:mac",
      expectedVersion: "0.21.3", sourceRevision: "a1b2c3d4" } } } as never, results: {} as never, assertAuthority() {},
      host: { async execute() { throw new Error("must_not_start_hermes"); } } },
    claude: { async deliver() { throw new Error("must_not_start_claude"); } },
    codex: { async deliver() { throw new Error("must_not_start_codex"); } },
  });
  assert.equal(typeof app.queueDelivery, "function");
  assert.equal(app.isReady(), true);
  assert.ok(!f.trace.includes("queue-start"), "composition does not start a queue or any local worker");
  await app.close();
});

test("refuses the superseded Hermes admission and runner inputs", async () => {
  const input = { web: { tenantId: "tenant:one" }, coordinator: { scope: { tenantId: "tenant:one" } },
    hermes: { tenantId: "tenant:one", runner: {}, admission: {} }, claude: { async deliver() {} },
    codex: { async deliver() {} } } as never;
  await assert.rejects(createMacLocalRestrictedThreeAgentTaskApplicationV1(input),
    /mac_local_restricted_three_agent_task_composition_invalid/);
});

test("refuses a caller-supplied prebuilt worker route", async () => {
  const input = { web: { tenantId: "tenant:one" }, coordinator: { scope: { tenantId: "tenant:one" },
    codexOwnerTrustedLocal: { async deliver() {} } }, hermes: { tenantId: "tenant:one" },
    claude: { async deliver() {} }, codex: { async deliver() {} } } as never;
  await assert.rejects(createMacLocalRestrictedThreeAgentTaskApplicationV1(input),
    /mac_local_restricted_three_agent_task_composition_invalid/);
});
