import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalRestrictedHermesClaudeTaskApplicationV1 } from "../src/web/v1/mac-local-restricted-hermes-claude-task-composition";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

test("composes the Hermes and text-only Claude routes into one restricted lifecycle without starting either", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), c = f.configuration;
  const app = await createMacLocalRestrictedHermesClaudeTaskApplicationV1({
    web: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId, tasks: c.web.tasks, database: f.openDatabase(c.web.database) },
    databaseRoles: { schema: MAC_LOCAL_DATABASE_ROLES_V1, web: c.web.database, coordinator: c.coordinator.database,
      results: c.coordinator.resultDatabase!, queueWorker: { ...c.coordinator.database, username: "worker_test" } },
    openDatabase: role => f.openDatabase(role),
    coordinator: { scope: { tenantId: c.web.tenantId, workspaceId: c.web.workspaceId }, planning: c.coordinator.planning,
      routes: c.coordinator.routes, approvals: c.coordinator.approvals, quality: c.coordinator.quality,
      revisionPlanning: c.coordinator.revisionPlanning, nativeSubmission: { async enqueueInSession() {} } },
    hermes: { tenantId: c.web.tenantId, execution: { delivery: {} } as never, results: {} as never, assertAuthority() {}, runner: {},
      admission: { installationId: "installation:mac", installationPlanDigest: "plan", topologyPlanDigest: "topology",
        releaseDigest: "release", workerBinding: { localServiceId: "service:mac", workerId: "worker:mac", expectedVersion: "0.21.3", sourceRevision: "a1b2c3d4" } } },
    claude: { async deliver() { throw new Error("must_not_start_claude"); } },
  });
  assert.equal(typeof app.queueDelivery, "function");
  assert.equal(app.isReady(), true);
  assert.ok(!f.trace.includes("queue-start"), "composition never starts the queue or either worker");
  await app.close();
});

test("refuses tenant substitution or prebuilt worker callbacks", async () => {
  const common = { web: { tenantId: "tenant:one" }, coordinator: { scope: { tenantId: "tenant:one" } },
    claude: { async deliver() {} }, hermes: { tenantId: "tenant:two" } } as never;
  await assert.rejects(createMacLocalRestrictedHermesClaudeTaskApplicationV1(common),
    /mac_local_restricted_hermes_claude_task_composition_invalid/);
  await assert.rejects(createMacLocalRestrictedHermesClaudeTaskApplicationV1({ ...common,
    hermes: { tenantId: "tenant:one" }, coordinator: { scope: { tenantId: "tenant:one" }, claudeCodeLocal: { async deliver() {} } },
  } as never), /mac_local_restricted_hermes_claude_task_composition_invalid/);
});
