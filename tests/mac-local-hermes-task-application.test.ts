import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalHermesTaskApplicationV1 } from "../src/web/v1/mac-local-hermes-task-application";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

test("adds the existing Hermes queue bridge to one Mac-local task lifecycle without invoking it", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), configuration = f.configuration;
  const result = await createMacLocalHermesTaskApplicationV1({
    web: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId,
      tasks: configuration.web.tasks, database: f.openDatabase(configuration.web.database) },
    coordinator: {
      scope: { tenantId: configuration.web.tenantId, workspaceId: configuration.web.workspaceId },
      database: f.openDatabase(configuration.coordinator.database),
      planning: configuration.coordinator.planning, routes: configuration.coordinator.routes,
      approvals: configuration.coordinator.approvals, quality: configuration.coordinator.quality,
      revisionPlanning: configuration.coordinator.revisionPlanning,
      resultDatabase: f.openDatabase(configuration.coordinator.resultDatabase!),
      nativeSubmission: { async enqueueInSession() {} },
    },
    hermes: {
      tenantId: configuration.web.tenantId,
      execution: { delivery: {} } as never,
      results: {} as never,
      assertAuthority() {}, runner: {},
      admission: { installationId: "installation:mac", installationPlanDigest: "plan", topologyPlanDigest: "topology",
        releaseDigest: "release", workerBinding: { localServiceId: "service:mac", workerId: "worker:mac",
          expectedVersion: "0.21.3", sourceRevision: "a1b2c3d4" } },
    },
  });
  assert.equal(result.isReady(), true);
  assert.equal(typeof result.queueDelivery, "function");
  assert.ok(!f.trace.includes("queue-start"), "composition never starts the queue worker or Hermes");
  await result.close();
});

test("refuses a caller trying to substitute a second Hermes delivery callback", async () => {
  await assert.rejects(createMacLocalHermesTaskApplicationV1({ web: {} as never,
    coordinator: { hermes021Local: { async deliver() {} } } as never, hermes: {} as never,
  }), /mac_local_hermes_task_application_config_invalid/);
});

test("refuses a Hermes bridge for a different tenant before it can be composed", async () => {
  await assert.rejects(createMacLocalHermesTaskApplicationV1({
    web: { tenantId: "tenant:one" } as never,
    coordinator: { scope: { tenantId: "tenant:one" }, database: {} } as never,
    hermes: { tenantId: "tenant:two" } as never,
  }), /mac_local_hermes_task_application_config_invalid/);
});
