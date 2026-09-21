import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { firstOwnerSetupNextOperationV1, firstOwnerStageInputDigestV1, prepareFirstOwnerSetupV1,
  verifyFirstOwnerSetupPreparationV1 } from "../src/installer/v1/first-owner-setup-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const bindings = Object.freeze({ releaseDigest: d("release"), databaseAuthorityOutcomeDigest: d("database-outcome"),
  bootstrapConfigurationDigest: d("bootstrap-configuration"), trustConfigurationDigest: d("trust-configuration"),
  expectedOwnerSubjectDigest: d("expected-owner-subject") });
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
  currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:hermes", adapterRevision: "0000001" }] });

function plan(databaseOutcomeDigest = bindings.databaseAuthorityOutcomeDigest) {
  const inputs = Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "first_owner"
    ? firstOwnerStageInputDigestV1(bindings) : d(`input:${stage}`)]));
  let value = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: bindings.releaseDigest, stageInputDigests: inputs });
  for (const stage of installationSetupStagesV1) {
    value = advanceInstallationPlanV1(value, { expectedRevision: value.revision, stage, action: "start" });
    if (stage === "first_owner") return value;
    value = advanceInstallationPlanV1(value, { expectedRevision: value.revision, stage, action: "pass",
      outcomeDigest: stage === "database_authority" ? databaseOutcomeDigest : d(`outcome:${stage}`) });
  }
  throw new Error("first owner stage unavailable");
}

const input = () => ({ installationPlan: plan(), ...bindings, observedOwnerState: "empty" as const,
  observationDigest: d("owner-observation") });
const observation = (value = input()) => ({ observedOwnerState: value.observedOwnerState, observationDigest: value.observationDigest });

test("prepares the retained first-owner ceremony without accepting or creating identity material", () => {
  const source = input(), prepared = prepareFirstOwnerSetupV1(source);
  assert.deepEqual(verifyFirstOwnerSetupPreparationV1(prepared, source, observation(source)), prepared);
  assert.deepEqual(firstOwnerSetupNextOperationV1(prepared, source, observation(source)), {
    stage: "first_owner", operation: "arm_existing_owner_bootstrap_ceremony",
    precondition: "empty_owner_target_and_owner_attendance", performsEffect: false,
    createsOwner: false, opensDatabase: false, startsListener: false,
  });
  assert.equal(prepared.acceptsAssertion, false); assert.equal(prepared.acceptsOneTimeCode, false);
  assert.doesNotMatch(JSON.stringify(prepared), /test-owner|raw-assertion|123456|password-value|postgresql:\/\/|\/private\/owner/i);
});

test("existing, uncertain, stale, changed and consistently retagged owner states refuse", () => {
  const source = input(), prepared = prepareFirstOwnerSetupV1(source);
  for (const state of ["existing", "uncertain"] as const)
    assert.throws(() => prepareFirstOwnerSetupV1({ ...source, observedOwnerState: state }), /refused/);
  assert.throws(() => prepareFirstOwnerSetupV1({ ...source, expectedOwnerSubjectDigest: d("other-owner") }), /refused/);
  assert.throws(() => prepareFirstOwnerSetupV1({ ...source,
    databaseAuthorityOutcomeDigest: d("other-database-outcome") }), /refused/);
  assert.throws(() => prepareFirstOwnerSetupV1({ ...source,
    installationPlan: plan(d("other-database-outcome")) }), /refused/,
  "a matching first-owner stage input cannot override a different passed database outcome");
  assert.throws(() => verifyFirstOwnerSetupPreparationV1(prepared, source,
    { observedOwnerState: "existing", observationDigest: source.observationDigest }), /refused/);
  const forged = { ...prepared, observedOwnerState: "existing" };
  assert.throws(() => verifyFirstOwnerSetupPreparationV1(forged, source, observation(source)), /refused/);
});

test("a first-owner preparation cannot be made before its ordered active stage", () => {
  const source = input(), fresh = createInstallationPlanV1({ topologyPlan: topology,
    releaseDigest: bindings.releaseDigest, stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
      stage === "first_owner" ? firstOwnerStageInputDigestV1(bindings) : d(`input:${stage}`)])) });
  assert.throws(() => prepareFirstOwnerSetupV1({ ...source, installationPlan: fresh }), /refused/);
});
