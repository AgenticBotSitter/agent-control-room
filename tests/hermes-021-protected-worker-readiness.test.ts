import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1,
  HERMES_021_SOURCE_REVISION_V1, createHermes021MacosProtectedWorkerReadinessV1,
  verifyHermes021MacosProtectedWorkerReadinessV1 } from "../src/harness/hermes-021-v1";
import { sha256Digest } from "../src/security/canonical-digest";

const route = Object.freeze({ kind: "local" as const, workerId: "worker:marvin",
  adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: HERMES_021_SOURCE_REVISION_V1 });
const topologyInput = Object.freeze({ databaseAuthorityDigest: sha256Digest("database"),
  schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: Object.freeze([]),
  requestedRoutes: Object.freeze([route]) });
const topologyPlan = planInstallationTopologyV1(topologyInput);
const workerBinding = Object.freeze({ localServiceId: "service:marvin", workerId: route.workerId,
  expectedVersion: "0.21.3" as const, sourceRevision: HERMES_021_SOURCE_REVISION_V1 });
const runnerConfiguration = Object.freeze({ executablePath: "/private/fixture/hermes", profile: "owner-profile-private",
  model: "qwen3.8:27b-long", provider: "ollama", workingDirectory: "/private/fixture/work",
  taskClass: "text_review" as const, maximumTurns: 1 as const, maximumRunBudgetSeconds: 120 });
const runnerQualificationReport = Object.freeze({ schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1,
  qualified: true as const, terminalResultObserved: true as const, sessionDigest: sha256Digest("session"),
  inputTokens: 14, outputTokens: 8, totalTokens: 22, durationMs: 1_250,
  failureReason: "none" as const, retryRequiresFreshOwnerAuthorization: false as const });

function input() {
  return { installationId: "fixture-installation", releaseDigest: sha256Digest("release"), topologyInput,
    topologyPlan, workerBinding, runnerConfiguration, runnerQualificationReport };
}

test("successful runner evidence becomes one redacted installation-bound readiness record without execution", () => {
  const readiness = createHermes021MacosProtectedWorkerReadinessV1(input());
  assert.equal(readiness.state, "qualification_recorded_owner_enablement_required");
  assert.deepEqual(readiness.workerRegistration, { workerId: "worker:marvin",
    adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: HERMES_021_SOURCE_REVISION_V1,
    capabilityId: "harness.hermes.021.macos.local.v1",
    connectorProfileDigest: readiness.workerRegistration.connectorProfileDigest,
    taskClass: "text_review", maximumTurns: 1, maximumConcurrentTasks: 1 });
  assert.deepEqual({ startsHermes: readiness.startsHermes, startsService: readiness.startsService,
    createsDatabaseEntry: readiness.createsDatabaseEntry, sendsTask: readiness.sendsTask,
    enablesWorker: readiness.enablesWorker, grantsExecutionAuthority: readiness.grantsExecutionAuthority },
  { startsHermes: false, startsService: false, createsDatabaseEntry: false, sendsTask: false,
    enablesWorker: false, grantsExecutionAuthority: false });
  const serialized = JSON.stringify(readiness);
  for (const privateValue of [runnerConfiguration.executablePath, runnerConfiguration.profile,
    runnerConfiguration.model, runnerConfiguration.provider, runnerConfiguration.workingDirectory,
    runnerQualificationReport.sessionDigest]) assert.equal(serialized.includes(privateValue), false);
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(Object.isFrozen(readiness.workerRegistration), true);
});

test("saved readiness refuses profile, model, provider, workspace, worker and qualification substitution", () => {
  const original = input(), readiness = createHermes021MacosProtectedWorkerReadinessV1(original);
  const changedInputs = [
    { ...original, runnerConfiguration: { ...runnerConfiguration, profile: "other-profile" } },
    { ...original, runnerConfiguration: { ...runnerConfiguration, model: "other-model" } },
    { ...original, runnerConfiguration: { ...runnerConfiguration, provider: "other-provider" } },
    { ...original, runnerConfiguration: { ...runnerConfiguration, workingDirectory: "/private/fixture/other-work" } },
    { ...original, workerBinding: { ...workerBinding, localServiceId: "service:other" } },
    { ...original, runnerQualificationReport: { ...runnerQualificationReport, sessionDigest: sha256Digest("other-session") } },
  ];
  for (const changed of changedInputs)
    assert.throws(() => verifyHermes021MacosProtectedWorkerReadinessV1(readiness, changed),
      /hermes_021_macos_protected_worker_readiness_unavailable/u);
  assert.deepEqual(verifyHermes021MacosProtectedWorkerReadinessV1(readiness, original), readiness);
});

test("qualification evidence cannot be replayed across an installation, release, topology or registration", () => {
  const original = input(), readiness = createHermes021MacosProtectedWorkerReadinessV1(original);
  const otherRoute = { ...route, workerId: "worker:other" };
  const otherTopologyInput = { ...topologyInput, requestedRoutes: [otherRoute] };
  const changedInputs = [
    { ...original, installationId: "other-installation" },
    { ...original, releaseDigest: sha256Digest("other-release") },
    { ...original, topologyInput: otherTopologyInput, topologyPlan: planInstallationTopologyV1(otherTopologyInput),
      workerBinding: { ...workerBinding, workerId: otherRoute.workerId } },
  ];
  for (const changed of changedInputs)
    assert.throws(() => verifyHermes021MacosProtectedWorkerReadinessV1(readiness, changed),
      /hermes_021_macos_protected_worker_readiness_unavailable/u);
  assert.throws(() => createHermes021MacosProtectedWorkerReadinessV1({ ...original,
    runnerQualificationReport: { ...runnerQualificationReport, qualified: false } }));
  assert.throws(() => createHermes021MacosProtectedWorkerReadinessV1({ ...original,
    topologyPlan: { ...topologyPlan, planDigest: sha256Digest("forged-plan") } }));
});

test("composition accepts only exact inert input records", () => {
  const original = input();
  assert.throws(() => createHermes021MacosProtectedWorkerReadinessV1({ ...original, run() {} }));
  let reads = 0;
  const accessor = { ...original } as Record<string, unknown>;
  Object.defineProperty(accessor, "runnerConfiguration", { enumerable: true, get() { reads++; return runnerConfiguration; } });
  assert.throws(() => createHermes021MacosProtectedWorkerReadinessV1(accessor));
  assert.equal(reads, 0);
});
