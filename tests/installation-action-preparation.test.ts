import assert from "node:assert/strict";
import test from "node:test";
import { captureArtifactStorageConfigurationV1 } from "../src/config/v1/artifact-storage";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { firstOwnerStageInputDigestV1 } from "../src/installer/v1/first-owner-setup-preparation";
import { prepareInstallationActionV1, verifyInstallationActionPreparationV1 } from "../src/installer/v1/installation-action-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { platformServiceStageInputDigestV1 } from "../src/installer/v1/platform-service-lifecycle";
import { postgresSetupStageInputDigestV1 } from "../src/installer/v1/postgres-setup-preparation";
import { prepareProtectedDataV1, protectedDataBindingDigestV1, protectedDataStageInputDigestV1,
  recoveryStageInputDigestV1 } from "../src/installer/v1/protected-data-recovery-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const topology = () => planInstallationTopologyV1({ databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
  currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }] });
const storage = () => captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1",
  storageClass: "local", storageNamespace: "artifacts:local", rootPath: "/private/owner/control-room/results",
  maximumArtifacts: 100, maximumFileBytes: 65_536, maximumTotalBytes: 6_553_600, operationTimeoutMs: 2_000 },
{ releaseId: "release:local", releaseDigest: d("release"), databaseSchemaVersion: "schema:76", databaseSchemaDigest: d("schema") });

const protectedObservation = { observedState: "verified" as const, observationDigest: d("protected-observation") };
const postgresSource = { ledgerDigest: d("ledger"), targetIdentityDigest: d("target"),
  observedTargetState: "fresh" as const, observationDigest: d("postgres-observation") };
const firstOwnerSource = { databaseAuthorityOutcomeDigest: d("database-outcome"),
  bootstrapConfigurationDigest: d("bootstrap-configuration"), trustConfigurationDigest: d("trust-configuration"),
  expectedOwnerSubjectDigest: d("expected-owner-subject"), observedOwnerState: "empty" as const,
  observationDigest: d("owner-observation") };
const serviceSourceBase = { action: "status" as const, platform: "macos_launchd" as const,
  serviceIdentityDigest: d("service"), authorityDatabaseDigest: d("database-outcome"),
  protectedDataDigest: d("protected-binding"), observation: { state: "unknown" as const,
    observationDigest: d("service-observation") } };

function fixture() {
  const topo = topology(), stored = storage();
  const storageConfigurationDigest = d({ purpose: "protected-artifact-storage-configuration/v1",
    local: stored.local, inventory: stored.inventory });
  const protectedBinding = protectedDataBindingDigestV1({ storageConfiguration: stored, ...protectedObservation });
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
    stage === "database_authority" ? postgresSetupStageInputDigestV1({ releaseDigest: d("release"),
      ledgerDigest: postgresSource.ledgerDigest, targetIdentityDigest: postgresSource.targetIdentityDigest })
      : stage === "protected_data" ? protectedDataStageInputDigestV1({ releaseDigest: d("release"),
        storageConfigurationDigest, storageNamespaceDigest: stored.inventory.storageNamespaceDigest })
        : stage === "recovery" ? recoveryStageInputDigestV1({ releaseDigest: d("release"), topologyPlanDigest: topo.planDigest,
          protectedDataBindingDigest: protectedBinding, storageConfigurationDigest,
          storageNamespaceDigest: stored.inventory.storageNamespaceDigest,
          databaseAuthorityOutcomeDigest: d("database-outcome"), expectedDatabaseIdentityDigest: d("database-identity"),
          expectedDatabaseSchemaDigest: d("schema") })
          : stage === "first_owner" ? firstOwnerStageInputDigestV1({ releaseDigest: d("release"), ...firstOwnerSource })
          : stage === "platform_service" ? platformServiceStageInputDigestV1({ ...serviceSourceBase, releaseDigest: d("release") })
            : d(`input:${stage}`)]));
  return { topo, stored, protectedBinding, stageInputDigests,
    plan: createInstallationPlanV1({ topologyPlan: topo, releaseDigest: d("release"), stageInputDigests }) };
}

function advanceTo(base: ReturnType<typeof fixture>, target: "database_authority" | "protected_data" | "first_owner" | "recovery" | "platform_service") {
  let plan: InstallationPlanV1 = base.plan;
  for (const stage of installationSetupStagesV1) {
    if (stage === target) return advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    const outcomeDigest = stage === "database_authority" ? d("database-outcome")
      : stage === "protected_data" ? base.protectedBinding : d(`outcome:${stage}`);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest });
  }
  throw new Error("target stage not found");
}

function envelope(base: ReturnType<typeof fixture>, plan: InstallationPlanV1, action: string, source: unknown) {
  return { installationPlan: plan, topologyPlan: base.topo, expectedPlanRevision: plan.revision, action, source };
}

function assertFixedRefusal(run: () => unknown, markers: readonly string[] = []) {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "installation_action_preparation_refused");
  for (const marker of markers) assert.doesNotMatch(caught.message, new RegExp(marker, "i"));
}

test("one installation-owned seam prepares the existing PostgreSQL and protected-data operations without effects", () => {
  const base = fixture(), databasePlan = advanceTo(base, "database_authority");
  const postgresInput = envelope(base, databasePlan, "postgres", postgresSource);
  const postgres = prepareInstallationActionV1(postgresInput);
  assert.equal(postgres.stage, "database_authority");
  assert.equal(postgres.preparedAction.nextOperation, "owner_provision_database");
  assert.deepEqual(verifyInstallationActionPreparationV1(postgres, postgresInput), postgres);

  const protectedPlan = advanceTo(base, "protected_data");
  const protectedInput = envelope(base, protectedPlan, "protected_data", { storageConfiguration: base.stored, ...protectedObservation });
  const protectedData = prepareInstallationActionV1(protectedInput);
  assert.equal(protectedData.stage, "protected_data");
  assert.equal(protectedData.preparedAction.nextOperation, "bind_verified_protected_storage");
  for (const prepared of [postgres, protectedData]) {
    assert.equal(prepared.performsEffect, false); assert.equal(prepared.runsDatabaseOperation, false);
    assert.equal(prepared.touchesFilesystem, false); assert.equal(prepared.startsService, false);
    assert.equal(prepared.opensCredentialStore, false); assert.equal(prepared.grantsAuthority, false);
    assert.doesNotMatch(JSON.stringify(prepared), /private\/owner|rootPath|secret|postgresql:\/\//i);
  }
});

test("the same seam prepares recovery and service ordering against their exact current plan revisions", () => {
  const base = fixture(), protectedPlan = advanceTo(base, "protected_data");
  const protectedData = prepareProtectedDataV1({ installationPlan: protectedPlan, storageConfiguration: base.stored,
    ...protectedObservation });
  const recoveryPlan = advanceTo(base, "recovery");
  const recoveryInput = envelope(base, recoveryPlan, "recovery", { protectedDataPreparation: protectedData,
    storageConfiguration: base.stored, protectedDataObservation: protectedObservation,
    databaseAuthorityOutcomeDigest: d("database-outcome"), expectedDatabaseIdentityDigest: d("database-identity"),
    expectedDatabaseSchemaDigest: d("schema"), observedState: "not_proven", observationDigest: d("recovery-observation") });
  const recovery = prepareInstallationActionV1(recoveryInput);
  assert.equal(recovery.preparedAction.nextOperation, "owner_run_existing_backup_restore_rehearsal");
  assert.equal(recovery.preparedAction.runsBackup, false); assert.equal(recovery.preparedAction.runsRestore, false);

  const servicePlan = advanceTo(base, "platform_service");
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: servicePlan.planDigest, proofs: [] });
  const serviceInput = envelope(base, servicePlan, "platform_service", { ...serviceSourceBase, supervisorReadiness });
  const service = prepareInstallationActionV1(serviceInput);
  assert.equal(service.preparedAction.action, "status");
  assert.deepEqual(service.preparedAction.steps, [{ operation: "inspect_service_status", kind: "read" }]);
  assert.equal(service.installationPlanRevision, servicePlan.revision);
  assert.equal(service.topologyPlanDigest, base.topo.planDigest);
  assert.equal(service.releaseDigest, servicePlan.releaseDigest);
  assert.doesNotMatch(JSON.stringify([recovery, service]), /private\/owner|rootPath|launchctl|systemctl|\.plist|\.service/i);
});

test("the same seam prepares the retained first-owner ceremony without identity or listener authority", () => {
  const base = fixture(), ownerPlan = advanceTo(base, "first_owner");
  const ownerInput = envelope(base, ownerPlan, "first_owner", firstOwnerSource);
  const owner = prepareInstallationActionV1(ownerInput);
  assert.equal(owner.stage, "first_owner");
  assert.equal(owner.preparedAction.nextOperation, "arm_existing_owner_bootstrap_ceremony");
  assert.equal(owner.performsEffect, false); assert.equal(owner.runsDatabaseOperation, false);
  assert.equal(owner.startsService, false); assert.equal(owner.grantsAuthority, false);
  assert.equal(owner.preparedAction.acceptsAssertion, false);
  assert.equal(owner.preparedAction.acceptsOneTimeCode, false);
  assert.deepEqual(verifyInstallationActionPreparationV1(owner, ownerInput), owner);
  assert.doesNotMatch(JSON.stringify(owner), /raw-assertion|123456|test-owner|postgresql:\/\//i);
});

test("stale revisions, changed topology, wrong active stages, forged outputs, and injected request fields refuse", () => {
  const base = fixture(), plan = advanceTo(base, "database_authority"), input = envelope(base, plan, "postgres", postgresSource);
  assert.throws(() => prepareInstallationActionV1({ ...input, expectedPlanRevision: plan.revision - 1 }), /refused/);
  assert.throws(() => prepareInstallationActionV1({ ...input, command: "psql" }), /refused/);
  assert.throws(() => prepareInstallationActionV1({ ...input, source: { ...postgresSource, password: "secret" } }), /refused/);
  const wrongStagePlan = advanceTo(base, "protected_data");
  assert.throws(() => prepareInstallationActionV1({ ...input, installationPlan: wrongStagePlan,
    expectedPlanRevision: wrongStagePlan.revision }), /refused/);
  const otherTopology = planInstallationTopologyV1({ databaseAuthorityDigest: d("other-database"), schedulerAuthorityDigest: d("scheduler"),
    currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: "worker:other", adapterId: "connector:other", adapterRevision: "0000001" }] });
  assert.throws(() => prepareInstallationActionV1({ ...input, topologyPlan: otherTopology }), /refused/);
  const prepared = prepareInstallationActionV1(input);
  assert.throws(() => verifyInstallationActionPreparationV1({ ...prepared, performsEffect: true }, input));
  assert.throws(() => verifyInstallationActionPreparationV1(prepared, { ...input,
    source: { ...postgresSource, observationDigest: d("changed-observation") } }), /refused/);
});

test("all malformed public values collapse to one fixed refusal without private parser detail", () => {
  const base = fixture(), plan = advanceTo(base, "database_authority"), input = envelope(base, plan, "postgres", postgresSource);
  const nestedPlanMarker = "privatePlanMarker", nestedValueMarker = "privatePlanValue";
  const malformedPlan = { ...plan, stages: plan.stages.map((stage, index) => index === 0
    ? { ...stage, [nestedPlanMarker]: nestedValueMarker } : stage) };
  assertFixedRefusal(() => prepareInstallationActionV1({ ...input, installationPlan: malformedPlan }),
    [nestedPlanMarker, nestedValueMarker]);

  const prepared = prepareInstallationActionV1(input), outputMarker = "privateOutputMarker",
    outputValueMarker = "privateOutputValue";
  assertFixedRefusal(() => verifyInstallationActionPreparationV1({ ...prepared,
    [outputMarker]: outputValueMarker }, input),
  [outputMarker, outputValueMarker]);
  assertFixedRefusal(() => prepareInstallationActionV1({ ...input, action: "privateActionMarker" }),
    ["privateActionMarker"]);
  assertFixedRefusal(() => prepareInstallationActionV1({ ...input, expectedPlanRevision: "privateRevisionMarker" }),
    ["privateRevisionMarker"]);
});

test("the strict private boundary rejects inherited, symbolic, and non-enumerable envelope or source fields", () => {
  const base = fixture(), plan = advanceTo(base, "database_authority"), input = envelope(base, plan, "postgres", postgresSource);
  const inherited = Object.assign(Object.create({ hiddenCommand: "privateInheritedValue" }), input);
  assertFixedRefusal(() => prepareInstallationActionV1(inherited), ["hiddenCommand", "privateInheritedValue"]);

  const hidden = { ...input };
  Object.defineProperty(hidden, "privateHiddenPath", { value: "/private/marker", enumerable: false });
  assertFixedRefusal(() => prepareInstallationActionV1(hidden), ["privateHiddenPath", "private/marker"]);

  const sourceWithSymbol = { ...postgresSource, [Symbol("privateSymbolMarker")]: "privateSymbolValue" };
  assertFixedRefusal(() => prepareInstallationActionV1({ ...input, source: sourceWithSymbol }),
    ["privateSymbolMarker", "privateSymbolValue"]);
});
