import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { prepareInstallationActionV1 } from "../src/installer/v1/installation-action-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { preparePostgresOwnerActionV1 } from "../src/installer/v1/postgres-owner-action";
import { postgresSetupStageInputDigestV1 } from "../src/installer/v1/postgres-setup-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: unknown) => sha256Digest(value);
const postgresSource = (observedTargetState: "fresh" | "provisioned" | "existing_verified") => ({ ledgerDigest: digest("ledger"),
  targetIdentityDigest: digest("target"), observedTargetState, observationDigest: digest(`observation:${observedTargetState}`) });

function databasePlan(source = postgresSource("fresh")) {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }] });
  let plan: InstallationPlanV1 = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: digest("release"),
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "database_authority"
      ? postgresSetupStageInputDigestV1({ releaseDigest: digest("release"), ledgerDigest: source.ledgerDigest,
        targetIdentityDigest: source.targetIdentityDigest }) : digest(`input:${stage}`)])) });
  for (const stage of ["release_preflight", "private_placement"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest: digest(`proof:${stage}`) });
  }
  return { topology, plan: advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "database_authority", action: "start" }), source };
}

function preparedFixture(state: "fresh" | "provisioned" | "existing_verified" = "fresh") {
  const fixture = databasePlan(postgresSource(state));
  const actionInput = { installationPlan: fixture.plan, topologyPlan: fixture.topology, expectedPlanRevision: fixture.plan.revision,
    action: "postgres", source: fixture.source };
  return { actionInput, actionPreparation: prepareInstallationActionV1(actionInput) };
}

test("the pure adapter reuses the current action plan and names each existing PostgreSQL tool without running it", () => {
  const expected = [
    ["fresh", "owner_provision_database", "psql", "deploy/postgres/provision-database.sql"],
    ["provisioned", "apply_existing_migration_ledger", "node", "deploy/postgres/apply-migrations.mjs"],
    ["existing_verified", "collect_existing_database_evidence", "node", "deploy/postgres/evidence.mjs"],
  ] as const;
  for (const [state, operation, executable, entrypoint] of expected) {
    const request = preparePostgresOwnerActionV1(preparedFixture(state));
    assert.equal(request.operation, operation); assert.equal(request.tool.executable, executable);
    assert.equal(request.tool.entrypoint, entrypoint);
    if (operation === "apply_existing_migration_ledger") assert.deepEqual(request.tool.supportingPaths,
      ["deploy/postgres/migration-ledger.json", "db/roles/production_provision.sql", "db/roles/production_table_grants.sql"]);
    assert.equal(request.performsEffect, false); assert.equal(request.startsProcess, false);
    assert.equal(request.opensNetwork, false); assert.equal(request.runsSql, false);
    assert.doesNotMatch(JSON.stringify(request), /password|connectionString|postgresql:\/\/|--bootstrap-target|--migrate-target/i);
  }
});

test("the adapter refuses a stale, changed, or non-PostgreSQL preparation", () => {
  const fixture = preparedFixture();
  assert.throws(() => preparePostgresOwnerActionV1({ ...fixture, actionInput: { ...fixture.actionInput,
    expectedPlanRevision: fixture.actionInput.expectedPlanRevision - 1 } }), /postgres_owner_action_refused/);
  assert.throws(() => preparePostgresOwnerActionV1({ ...fixture, actionInput: { ...fixture.actionInput,
    source: { ...fixture.actionInput.source, observationDigest: digest("changed") } } }), /postgres_owner_action_refused/);
  assert.throws(() => preparePostgresOwnerActionV1({ ...fixture, actionInput: { ...fixture.actionInput,
    action: "recovery" } }), /postgres_owner_action_refused/);
});

test("preparing the request is replay-stable and cannot pass or advance the installation plan", () => {
  assert.deepEqual(preparePostgresOwnerActionV1(preparedFixture()), preparePostgresOwnerActionV1(preparedFixture()));
});
