import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { postgresSetupNextOperationV1, preparePostgresSetupV1, refreshPostgresSetupPreparationV1,
  postgresSetupStageInputDigestV1, verifyPostgresSetupPreparationV1 } from "../src/installer/v1/postgres-setup-preparation";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";

const digest = (value: string) => sha256Digest(value);
const topology = () => planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
  currentRoutes: [{ kind: "local", workerId: "worker:old", adapterId: "connector:old", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: "worker:new", adapterId: "connector:new", adapterRevision: "0000001" }] });
function plan(bindings: Readonly<{ releaseDigest: string; ledgerDigest: string; targetIdentityDigest: string }> = {
  releaseDigest: digest("release"), ledgerDigest: digest("ledger"), targetIdentityDigest: digest("target"),
}) {
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "database_authority"
    ? postgresSetupStageInputDigestV1(bindings) : digest(`input:${stage}`)]));
  let value = createInstallationPlanV1({ topologyPlan: topology(), releaseDigest: bindings.releaseDigest, stageInputDigests });
  for (const stage of ["release_preflight", "private_placement"] as const) {
    value = advanceInstallationPlanV1(value, { expectedRevision: value.revision, stage, action: "start" });
    value = advanceInstallationPlanV1(value, { expectedRevision: value.revision, stage, action: "pass", outcomeDigest: digest(`proof:${stage}`) });
  }
  return advanceInstallationPlanV1(value, { expectedRevision: value.revision, stage: "database_authority", action: "start" });
}
const input = (observedTargetState: "fresh" | "provisioned" | "existing_verified" | "broken" = "fresh") => {
  const bindings = { releaseDigest: digest("release"), ledgerDigest: digest("ledger"), targetIdentityDigest: digest("target") };
  return { installationPlan: plan(bindings), ...bindings, observedTargetState,
    observationDigest: digest(`observation:${observedTargetState}`) };
};
const observation = (value: ReturnType<typeof input>) => ({ observedTargetState: value.observedTargetState,
  observationDigest: value.observationDigest });

test("fresh preparation binds the reviewed plan, release, ledger and redacted target to database authority", () => {
  const request = input(), prepared = preparePostgresSetupV1(request);
  assert.equal(prepared.stage, "database_authority");
  assert.equal(prepared.nextOperation, "owner_provision_database");
  assert.equal(prepared.precondition, "empty_target_and_owner_attendance");
  assert.equal(prepared.createsDatabase, false); assert.equal(prepared.runsSql, false);
  assert.equal(prepared.exposesCredentials, false); assert.equal(prepared.startsService, false);
  assert.deepEqual(verifyPostgresSetupPreparationV1(prepared, request.installationPlan, observation(request)), prepared);
  assert.doesNotMatch(JSON.stringify(prepared), /password|host|port|path|connectionString|postgresql:\/\//i);
});

test("fresh, provisioned, and verified-repeat targets map to the existing three-step toolchain", () => {
  const freshRequest = input("fresh"), provisionedRequest = input("provisioned"), repeatedRequest = input("existing_verified");
  const fresh = preparePostgresSetupV1(freshRequest), provisioned = preparePostgresSetupV1(provisionedRequest),
    repeated = preparePostgresSetupV1(repeatedRequest);
  assert.notEqual(fresh.preparationDigest, provisioned.preparationDigest);
  assert.notEqual(provisioned.preparationDigest, repeated.preparationDigest);
  assert.deepEqual(postgresSetupNextOperationV1(provisioned, provisionedRequest.installationPlan, observation(provisionedRequest)), { stage: "database_authority", operation: "apply_existing_migration_ledger",
    precondition: "provisioned_target_and_owner_attendance", performsEffect: false, runsSql: false });
  assert.deepEqual(postgresSetupNextOperationV1(repeated, repeatedRequest.installationPlan, observation(repeatedRequest)), { stage: "database_authority", operation: "collect_existing_database_evidence",
    precondition: "existing_verified_target_only", performsEffect: false, runsSql: false });
  assert.equal(refreshPostgresSetupPreparationV1(fresh, freshRequest.installationPlan, observation(freshRequest), freshRequest).kind, "replay");
});

test("broken targets and changed replay bindings refuse or invalidate before an owner wrapper can act", () => {
  assert.throws(() => preparePostgresSetupV1(input("broken")), /postgres_setup_preparation_refused/);
  const original = input(), current = preparePostgresSetupV1(original);
  for (const changed of [
    (() => { const bindings = { releaseDigest: digest("release:changed"), ledgerDigest: original.ledgerDigest, targetIdentityDigest: original.targetIdentityDigest };
      return { ...original, ...bindings, installationPlan: plan(bindings) }; })(),
    (() => { const bindings = { releaseDigest: original.releaseDigest, ledgerDigest: digest("ledger:changed"), targetIdentityDigest: original.targetIdentityDigest };
      return { ...original, ...bindings, installationPlan: plan(bindings) }; })(),
    (() => { const bindings = { releaseDigest: original.releaseDigest, ledgerDigest: original.ledgerDigest, targetIdentityDigest: digest("target:changed") };
      return { ...original, ...bindings, installationPlan: plan(bindings) }; })(),
  ]) assert.equal(refreshPostgresSetupPreparationV1(current, original.installationPlan, observation(original), changed).kind, "invalidated");
  assert.throws(() => preparePostgresSetupV1({ ...input(), releaseDigest: digest("wrong-release") }), /postgres_setup_preparation_refused/);
});

test("database preparation requires the active ordered database stage and its trusted target binding", () => {
  const request = input(), prepared = preparePostgresSetupV1(request);
  const untouched = createInstallationPlanV1({ topologyPlan: topology(), releaseDigest: request.releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "database_authority"
      ? postgresSetupStageInputDigestV1(request) : digest(`input:${stage}`)])) });
  assert.throws(() => preparePostgresSetupV1({ ...request, installationPlan: untouched }), /refused/);
  const forgedTarget = { ...prepared, targetIdentityDigest: digest("other") };
  const { preparationDigest: _old, ...forgedMaterial } = forgedTarget;
  assert.throws(() => verifyPostgresSetupPreparationV1({ ...forgedMaterial, preparationDigest: sha256Digest(forgedMaterial) }, request.installationPlan, observation(request)), /refused/);
  const forgedLedger = { ...prepared, ledgerDigest: digest("other-ledger") };
  const { preparationDigest: _ledgerOld, ...ledgerMaterial } = forgedLedger;
  assert.throws(() => verifyPostgresSetupPreparationV1({ ...ledgerMaterial, preparationDigest: sha256Digest(ledgerMaterial) }, request.installationPlan, observation(request)), /refused/);
});

test("forged preparation data never changes the exact operation or target binding", () => {
  const request = input(), prepared = preparePostgresSetupV1(request);
  assert.throws(() => verifyPostgresSetupPreparationV1({ ...prepared, nextOperation: "apply_existing_migration_ledger" }, request.installationPlan, observation(request)), /refused/);
  assert.throws(() => verifyPostgresSetupPreparationV1({ ...prepared, targetIdentityDigest: digest("other") }, request.installationPlan, observation(request)), /refused/);
  const { preparationDigest: _ignored, ...material } = prepared;
  const retagged = { ...material, observedTargetState: "existing_verified" as const,
    nextOperation: "owner_provision_database" as const, precondition: "empty_target_and_owner_attendance" as const };
  assert.throws(() => verifyPostgresSetupPreparationV1({ ...retagged, preparationDigest: sha256Digest(retagged) }, request.installationPlan, observation(request)), /refused/,
    "a recomputed digest cannot turn a verified repeat into a provisioning request");
  for (const forgedState of ["provisioned", "existing_verified"] as const) {
    const next = preparePostgresSetupV1(input(forgedState));
    assert.throws(() => verifyPostgresSetupPreparationV1(next, request.installationPlan, observation(request)), /refused/,
      "a consistently retagged state and operation still require the trusted observation");
  }
});
