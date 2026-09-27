import assert from "node:assert/strict";
import test from "node:test";
import { captureOwnerTrustedLocalEnablementV1, OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import type { DatabaseClient } from "../src/persistence/database";
import { createMacLocalLiveProjectProvisionerV1 } from "../src/web/v1/mac-local-live-projects";
import type { MacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import type { MacLocalTaskRuntimeV1 } from "../src/web/v1/mac-local-task-runtime";
import { createNativeTaskTemplateRegistryV1, TaskExecutionPlanner } from "../src/web/v1/task-execution-planner";
import { createTaskQualityScenarioRegistryV1 } from "../src/web/v1/task-quality-coordinator";

const enablement = captureOwnerTrustedLocalEnablementV1({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1,
  mode: "mac-local", nodeId: "mac-1", workers: (["hermes", "claude-code", "codex"] as const).map(kind => ({
    workerId: `worker:${kind}`, kind, executablePath: `/private/tmp/${kind}`, recordedVersion: "current" })) });
const configuration = { localOwnerSession: { tenantId: "tenant:local" }, enablement } as MacLocalProtectedConfigurationV1;
const runtime = { hermes: { profile: "cr", provider: "opencode-go", model: "space-bunny-free",
  destination: "https://opencode.ai:443" } } as MacLocalTaskRuntimeV1;

test("live Mac-local projects register once under concurrency and exceed the former five-project cap", async () => {
  const templates = createNativeTaskTemplateRegistryV1([]), scenarios = createTaskQualityScenarioRegistryV1([]);
  const registered: string[] = [];
  const db = { async query(_sql: string, params?: unknown[]) {
    const projectId = String(params?.[2]);
    return { rows: [{ project_id: projectId, created_at: "2026-09-27T00:00:00.000Z", active_count: "7" }] };
  } } as DatabaseClient;
  const live = createMacLocalLiveProjectProvisionerV1({ db, tenantId: "tenant:local", workspaceId: "workspace:local",
    configuration, runtime, templates, scenarios, initialProjects: [], profileGate: { async registerProfile(profile: unknown) {
      await new Promise(resolve => setTimeout(resolve, 1));
      registered.push((profile as { projectId: string }).projectId); return { profile, replayed: false } as never;
    } } });
  await Promise.all([live.ensureProject("project:0"), live.ensureProject("project:0")]);
  await Promise.all(Array.from({ length: 6 }, (_, index) => live.ensureProject(`project:${index + 1}`)));
  assert.equal(registered.length, 7);
  assert.equal(new Set(registered).size, 7);
  assert.equal(templates.snapshot().length, 21);
  assert.equal(scenarios.snapshot().length, 7);
  const planner = new TaskExecutionPlanner(db, { tenantId: "tenant:local", workspaceId: "workspace:local" }, {
    templateRegistry: templates, integrityKey: new Uint8Array(32).fill(1), reviewIntegrityKey: new Uint8Array(32).fill(2),
    checkpoints: { read: async () => undefined, initialize: async () => {}, advance: async () => {} },
  });
  assert.equal(planner.supportsProject("project:6"), true, "an already-running planner sees the newly registered templates");
  assert.equal(planner.templatesForProject("project:6").length, 3);
});

test("live Mac-local project preparation fails clearly above the 50-project bound", async () => {
  const live = createMacLocalLiveProjectProvisionerV1({ tenantId: "tenant:local", workspaceId: "workspace:local",
    configuration, runtime, initialProjects: [], templates: createNativeTaskTemplateRegistryV1([]),
    scenarios: createTaskQualityScenarioRegistryV1([]), profileGate: { async registerProfile() { throw new Error("must not register"); } },
    db: { async query() { return { rows: [{ project_id: "project:overflow", created_at: "2026-09-27T00:00:00.000Z",
      active_count: "51" }] }; } } as unknown as DatabaseClient });
  await assert.rejects(live.ensureProject("project:overflow"), /mac_local_project_limit_50/);
});
