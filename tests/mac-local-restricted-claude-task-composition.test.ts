import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalRestrictedClaudeTaskApplicationV1 } from "../src/web/v1/mac-local-restricted-claude-task-composition";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

test("attaches an existing text-only Claude delivery callback without starting it", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), c = f.configuration;
  const app = await createMacLocalRestrictedClaudeTaskApplicationV1({
    web: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId, tasks: c.web.tasks, database: f.openDatabase(c.web.database) },
    databaseRoles: { schema: MAC_LOCAL_DATABASE_ROLES_V1, web: c.web.database, coordinator: c.coordinator.database,
      results: c.coordinator.resultDatabase!, publisher: { ...c.coordinator.database, username: "publisher_test" },
      queueWorker: { ...c.coordinator.database, username: "worker_test" } },
    openDatabase: role => f.openDatabase(role),
    coordinator: { scope: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId }, planning: c.coordinator.planning,
      routes: c.coordinator.routes, approvals: c.coordinator.approvals, quality: c.coordinator.quality,
      revisionPlanning: c.coordinator.revisionPlanning, nativeSubmission: { async enqueueInSession() {} } },
    claude: { async deliver() { throw new Error("must_not_start_claude"); } },
  });
  assert.equal(typeof app.queueDelivery, "function");
  assert.ok(!f.trace.includes("queue-start"));
  await app.close();
});

test("refuses a missing Claude delivery capability", async () => {
  await assert.rejects(createMacLocalRestrictedClaudeTaskApplicationV1({ claude: {} as never } as never),
    /mac_local_restricted_claude_task_composition_invalid/);
});
