import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPrivateLocalInstallationOperatorV1,
  PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1 } from "../src/installer/v1/private-local-installation-operator";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { sha256Digest } from "../src/security/canonical-digest";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { projectTwoLocalWorkerActivationPreflightV1 } from
  "../src/installer/v1/two-local-worker-activation-preflight";
import { assessSchedulerResultStorageActivationSourceV1 } from
  "../src/installer/v1/scheduler-result-storage-activation-source";

function journal() {
  return {
    async append() { throw new Error("must_not_append"); },
    async readHistory() { throw new Error("must_not_read"); },
    async inspectSettledHistory() { throw new Error("must_not_inspect"); },
  };
}

function assertBlocked(result: unknown, blocker: "private_configuration_custody_missing"):
  asserts result is Readonly<{ status: "blocked"; blocker: typeof blocker }> {
  assert.ok(result && typeof result === "object");
  assert.equal((result as { status?: unknown }).status, "blocked");
  assert.equal((result as { blocker?: unknown }).blocker, blocker);
}

test("operator construction captures only exact ports and is inert", async () => {
  let originalLoads = 0, replacementLoads = 0;
  const custody = { async loadPrivateConfiguration() { originalLoads++; return undefined; } };
  const operator = createPrivateLocalInstallationOperatorV1(custody, { journal: journal() });
  assert.equal(operator.schema, PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1);
  assert.equal(originalLoads, 0);
  if (operator.status === "blocked") throw new Error("unexpected constructor blocker");
  custody.loadPrivateConfiguration = async () => { replacementLoads++; return undefined; };
  const status = await operator.status();
  assert.equal(status.status, "blocked");
  assert.equal(status.blocker, "private_configuration_custody_missing");
  assert.equal(originalLoads, 1);
  assert.equal(replacementLoads, 0);
});

test("the installed connector accepts the existing canonical filesystem journal without rewrapping it", async () => {
  const root = await mkdtemp(join(tmpdir(), "acr-operator-journal-"));
  try {
    const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId: "operator-journal",
      ownerUid: process.getuid!() });
    const operator = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { return undefined; } }, { journal });
    assert.notEqual(operator.status, "blocked");
    if (operator.status === "blocked") throw new Error("canonical journal was rejected");
    const result = await operator.status();
    assert.equal(result.status, "blocked");
    assert.equal(result.blocker, "private_configuration_custody_missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accessors, inheritance, extras, symbols, and proxies refuse without invoking a loader", () => {
  let getterCalls = 0;
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, "loadPrivateConfiguration", { enumerable: true, get() {
    getterCalls++; return async () => undefined;
  } });
  const validJournal = journal();
  const cases: readonly unknown[] = [accessor, Object.create({ async loadPrivateConfiguration() {} }),
    { async loadPrivateConfiguration() {}, extra() {} }, { async loadPrivateConfiguration() {}, [Symbol("extra")]: true },
    new Proxy({ async loadPrivateConfiguration() {} }, {})];
  for (const custody of cases) {
    const result = createPrivateLocalInstallationOperatorV1(custody, { journal: validJournal });
    assert.equal(result.status, "blocked");
    assert.equal(result.blocker, "private_configuration_custody_missing");
  }
  assert.equal(getterCalls, 0);
});

test("journal accessors, extras, and proxies are rejected before custody loading", () => {
  let loads = 0, getterCalls = 0;
  const custody = { async loadPrivateConfiguration() { loads++; return undefined; } };
  const accessor = { readHistory: journal().readHistory, inspectSettledHistory: journal().inspectSettledHistory } as Record<string, unknown>;
  Object.defineProperty(accessor, "append", { enumerable: true, get() { getterCalls++; return journal().append; } });
  for (const value of [accessor, { ...journal(), extra() {} }, new Proxy(journal(), {})]) {
    const result = createPrivateLocalInstallationOperatorV1(custody, { journal: value });
    assert.equal(result.status, "blocked");
  }
  assert.equal(getterCalls, 0);
  assert.equal(loads, 0);
});

test("cancelled fixed operations refuse before the custody loader can run", async () => {
  let loads = 0;
  const operator = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { loads++; return undefined; } },
    { journal: journal() });
  if (operator.status === "blocked") throw new Error("unexpected constructor blocker");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(operator.status(controller.signal), /private_local_installation_operator_refused/u);
  await assert.rejects(operator.setupNext(controller.signal), /private_local_installation_operator_refused/u);
  await assert.rejects(operator.start(controller.signal), /private_local_installation_operator_refused/u);
  assert.equal(loads, 0);
});

function statusFixture() {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [], requestedRoutes: [] });
  const releaseDigest = sha256Digest("release");
  const plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, sha256Digest(stage)])) });
  const setupSources = Object.fromEntries(["database_authority", "protected_data", "first_owner", "recovery",
    "platform_service", "agent_readiness", "final_review"].map(stage => [stage, {}]));
  const setupRuntimes = Object.fromEntries(Object.keys(setupSources).map(stage => [stage, undefined]));
  const assemblyInput = { runnerInput: { admissionPreparationInput: { installationId: "fixture-installation",
      installationPlan: {}, topologyInput: {}, workerBinding: {}, installationBinding: {}, installationBindingInput: {} },
    privateStartupConfiguration: {}, startupAdmissionBinding: {} }, operatorSettings: {}, operatorTrustedInputs: {} };
  const configuration = { prerequisiteInput: { installationId: "fixture-installation", topologyPlan: topology, releaseDigest,
    releasePreflight: {}, privatePlacement: {} }, assemblyInput, startupDependencies: { openDatabase() {}, install() {} },
    setupSources, setupRuntimes };
  let history = [plan], appends = 0;
  const journal = { async append(value: typeof plan) { appends++; return { installationId: "fixture-installation",
      revision: value.revision, planDigest: value.planDigest }; }, async readHistory() { return history; },
    async inspectSettledHistory() { return history; } };
  return { topology, releaseDigest, plan, configuration, journal, appends: () => appends,
    replace(value: typeof plan) { history = [value]; } };
}

test("status authenticates the exact configured journal binding and never reports ready from unrelated custody", async () => {
  const f = statusFixture();
  const operator = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { return f.configuration; } },
    { journal: f.journal });
  if (operator.status === "blocked") throw new Error("unexpected constructor blocker");
  const status = await operator.status();
  assert.equal(status.status, "blocked");
  assert.equal(status.blocker, "private_configuration_custody_missing");
  assert.equal(f.appends(), 1, "the canonical journal authenticated the configured installation id");

  const unrelated = statusFixture();
  const foreignJournal = { ...unrelated.journal, async append(value: typeof unrelated.plan) {
    return { installationId: "other-installation", revision: value.revision, planDigest: value.planDigest };
  } };
  const foreign = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { return unrelated.configuration; } },
    { journal: foreignJournal });
  if (foreign.status === "blocked") throw new Error("unexpected constructor blocker");
  const blocked = await foreign.status();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocker, "private_configuration_custody_missing");
});

test("loaded nested accessors and proxies are refused before the first journal read", async () => {
  const f = statusFixture(), sources = f.configuration.setupSources as Record<string, unknown>;
  let getterCalls = 0, reads = 0;
  Object.defineProperty(sources, "database_authority", { enumerable: true, get() { getterCalls++; return {}; } });
  const journal = { ...f.journal, async readHistory() { reads++; return [f.plan]; } };
  const operator = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { return f.configuration; } },
    { journal });
  if (operator.status === "blocked") throw new Error("unexpected constructor blocker");
  const blocked = await operator.status();
  assert.equal(blocked.status, "blocked");
  assert.equal(getterCalls, 0); assert.equal(reads, 0);
});

test("local activation status is redacted, bound, and rejected before journal or runtime use", async () => {
  const f = statusFixture(); let reads = 0, appends = 0;
  const activation = { schedulerResultStorage: assessSchedulerResultStorageActivationSourceV1({ installationId: "fixture-installation",
      releaseDigest: f.releaseDigest, topologyPlanDigest: f.topology.planDigest,
      schedulerReadinessEvidence: undefined, protectedStorageRestoreEvidence: undefined }) };
  const journal = { ...f.journal, async readHistory() { reads++; return [f.plan]; },
    async append(value: typeof f.plan) { appends++; return { installationId: "fixture-installation",
      revision: value.revision, planDigest: value.planDigest }; } };
  for (const localActivationStatus of [
    { ...activation, schedulerResultStorage: assessSchedulerResultStorageActivationSourceV1({
      installationId: "foreign-installation", releaseDigest: f.releaseDigest, topologyPlanDigest: f.topology.planDigest,
      schedulerReadinessEvidence: undefined, protectedStorageRestoreEvidence: undefined }) },
    { ...activation, twoLocalWorkerPreflight: projectTwoLocalWorkerActivationPreflightV1({}) },
    { ...activation, claude: { readiness: {}, planDigest: f.topology.planDigest } },
    { ...activation, hermes: { readiness: {}, currentInput: {} } },
  ]) {
    const configuration = { ...f.configuration, localActivationStatus };
    const operator = createPrivateLocalInstallationOperatorV1(
      { async loadPrivateConfiguration() { return configuration; } }, { journal });
    if (operator.status === "blocked") throw new Error("unexpected constructor blocker");
    assertBlocked(await operator.status(), "private_configuration_custody_missing");
  }
  assert.equal(reads, 0); assert.equal(appends, 0);
});

test("nested activation accessors, custom prototypes, and proxies are refused before a verifier or journal can observe them", async () => {
  const f = statusFixture(); let getterCalls = 0, reads = 0;
  const scheduler = assessSchedulerResultStorageActivationSourceV1({ installationId: "fixture-installation",
    releaseDigest: f.releaseDigest, topologyPlanDigest: f.topology.planDigest,
    schedulerReadinessEvidence: undefined, protectedStorageRestoreEvidence: undefined }) as Record<string, unknown>;
  const accessor = { ...scheduler } as Record<string, unknown>;
  Object.defineProperty(accessor, "schema", { enumerable: true, get() { getterCalls++; return scheduler.schema; } });
  let prototypeGetterCalls = 0;
  const inherited = Object.create(Object.defineProperty({}, "schema", { get() { prototypeGetterCalls++; return scheduler.schema; } }));
  for (const [name, value] of Object.entries(scheduler)) if (name !== "schema") inherited[name] = value;
  class SchedulerRecord { constructor(readonly value: unknown) {} }
  for (const schedulerResultStorage of [accessor, inherited, new SchedulerRecord(scheduler), new Proxy(scheduler, {})]) {
    const configuration = { ...f.configuration, localActivationStatus: { schedulerResultStorage } };
    const operator = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { return configuration; } },
      { journal: { ...f.journal, async readHistory() { reads++; return [f.plan]; } } });
    if (operator.status === "blocked") throw new Error("unexpected constructor blocker");
    assertBlocked(await operator.status(), "private_configuration_custody_missing");
  }
  assert.equal(getterCalls, 0); assert.equal(prototypeGetterCalls, 0); assert.equal(reads, 0);
});

test("setupNext checks cancellation after prerequisite settlement before it can dispatch a stage", async () => {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database-cancel"),
    schedulerAuthorityDigest: sha256Digest("scheduler-cancel"), currentRoutes: [], requestedRoutes: [] });
  const releaseDigest = sha256Digest("release-cancel"), installationId = "fixture-cancellation";
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, sha256Digest(`cancel:${stage}`)])) });
  const history = [plan], controller = new AbortController(); let abortAfterPrerequisites = false;
  const journal = { async append(value: typeof plan) {
      const existing = history[value.revision];
      if (!existing) history.push(value); else if (existing.planDigest !== value.planDigest) throw new Error("conflict");
      plan = history.at(-1)!;
      return { installationId, revision: value.revision, planDigest: value.planDigest };
    }, async readHistory() {
      if (abortAfterPrerequisites && plan.stages.find(stage => stage.stage === "private_placement")?.state === "passed") controller.abort();
      return history;
    }, async inspectSettledHistory() { return history; } };
  const reports = { releasePreflight: { schema: "control-room.local-installation-package-preparation/v1", mode: "dry-run",
      bundle: { state: "fingerprinted", version: "1.2.3", fileCount: 12, byteCount: 4567, digest: sha256Digest("bundle"), authenticityVerified: false },
      service: { state: "awaiting_owner_setup" }, readyForOwnerSetup: true, startsService: false,
      releaseManifestDigest: releaseDigest, createsDatabase: false, writesCredentials: false, nextSteps: ["Owner review remains required."] },
    privatePlacement: { schema: "control-room.local-release-staging/v1", state: "verified_release_staged", version: "1.2.3",
      releaseManifestDigest: releaseDigest, alreadyStaged: false, fileCount: 7, byteCount: 8000,
      remainingCategory: "production_dependencies_not_prepared", preparesDependencies: false, switchesCurrentRelease: false,
      installsOrStartsService: false, createsDatabase: false, writesCredentials: false, usesNetwork: false, publishes: false } } as const;
  const setupSources = Object.fromEntries(["database_authority", "protected_data", "first_owner", "recovery",
    "platform_service", "agent_readiness", "final_review"].map(stage => [stage, {}]));
  const assemblyInput = { runnerInput: { admissionPreparationInput: { installationId,
      installationPlan: {}, topologyInput: {}, workerBinding: {}, installationBinding: {}, installationBindingInput: {} },
    privateStartupConfiguration: {}, startupAdmissionBinding: {} }, operatorSettings: {}, operatorTrustedInputs: {} };
  const configuration = { prerequisiteInput: { installationId, topologyPlan: topology, releaseDigest, ...reports }, assemblyInput,
    startupDependencies: { openDatabase() {}, install() {} }, setupSources, setupRuntimes: Object.fromEntries(Object.keys(setupSources).map(stage => [stage, undefined])) };
  const operator = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { return configuration; } }, { journal });
  if (operator.status === "blocked") throw new Error("unexpected constructor blocker");
  abortAfterPrerequisites = true;
  await assert.rejects(operator.setupNext(controller.signal), /private_local_installation_operator_refused/u);
  assert.equal(plan.stages.find(stage => stage.stage === "database_authority")?.state, "not_started");
});

test("setupNext uses an already-settled canonical plan instead of replaying prerequisites", async () => {
  const f = statusFixture();
  let plan = f.plan;
  const history = [plan];
  for (const stage of ["release_preflight", "private_placement", "database_authority"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" }); history.push(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest: sha256Digest(`passed:${stage}`) }); history.push(plan);
  }
  let appended = 0;
  const journal = { async append(value: typeof plan) { appended++; const current = history.at(-1)!;
      if (value.revision !== current.revision || value.planDigest !== current.planDigest) throw new Error("unexpected transition");
      return { installationId: "fixture-installation", revision: value.revision, planDigest: value.planDigest }; },
    async readHistory() { return history; }, async inspectSettledHistory() { return history; } };
  const operator = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { return f.configuration; } }, { journal });
  if (operator.status === "blocked") throw new Error("unexpected constructor blocker");
  const result = await operator.setupNext();
  assert.equal(result.status, "blocked");
  assert.equal(result.blocker, "private_configuration_custody_missing");
  assert.equal(appended, 1, "only canonical journal authentication occurred; prerequisites were not replayed");
});

test("start refuses a foreign assembly admission installation before bootstrap", async () => {
  const f = statusFixture();
  f.configuration.assemblyInput = { runnerInput: { admissionPreparationInput: { installationId: "foreign-installation",
    installationPlan: {}, topologyInput: {}, workerBinding: {}, installationBinding: {}, installationBindingInput: {} },
    privateStartupConfiguration: {}, startupAdmissionBinding: {} }, operatorSettings: {}, operatorTrustedInputs: {} };
  const operator = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { return f.configuration; } },
    { journal: f.journal });
  if (operator.status === "blocked") throw new Error("unexpected constructor blocker");
  const result = await operator.start();
  assertBlocked(result, "private_configuration_custody_missing");
  assert.equal(f.appends(), 1);
});
