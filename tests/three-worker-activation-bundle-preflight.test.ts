import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { composeThreeWorkerActivationBundlePreflightV1,
  refreshThreeWorkerActivationBundlePreflightV1,
  verifyThreeWorkerActivationBundlePreflightV1 } from
  "../src/installer/v1/three-worker-activation-bundle-preflight";

const d = (name: string) => sha256Digest(name);
const schemas = Object.freeze({
  verified_release: "control-room.local-installation-package-preparation/v1",
  protected_configuration: "control-room.private-installed-configuration-preparation/v1",
  database_route: "control-room.private-postgres-endpoint/v1",
  scheduler_result_storage: "control-room.agent-task-operator-settings/v1",
  hermes_route: "control-room.local-hermes-admission-preparation/v1",
  claude_owner_write: "control-room.private-installed-configuration-v3-materialization-preparation/v1",
});

function input(states: Partial<Record<keyof typeof schemas, "ready" | "blocked" | "owner_attended_action">> = {}) {
  const binding = { installationId: "control-room-one", releaseDigest: d("release"), topologyPlanDigest: d("topology") };
  return {
    ...binding,
    evidence: Object.entries(schemas).map(([component, sourceSchema]) => ({ component, sourceSchema,
      state: states[component as keyof typeof schemas] ?? "ready", binding,
      evidenceDigest: d(`evidence:${component}`) })),
    rollback: { releaseRollbackDigest: d("rollback-release"), databaseSnapshotDigest: d("rollback-db"),
      privateRouteSnapshotDigest: d("rollback-route"), websiteRouteSnapshotDigest: d("rollback-web"),
      protectedConfigurationPriorStateDigest: d("rollback-config") },
  };
}

test("composes one redacted no-effect owner window without private values", () => {
  const plan = composeThreeWorkerActivationBundlePreflightV1(input({
    hermes_route: "owner_attended_action", claude_owner_write: "owner_attended_action",
  }));
  assert.equal(plan.status, "owner_attended_action_required");
  assert.deepEqual(plan.ownerActions, ["approve_hermes_first_task", "materialize_claude_manifest"]);
  assert.equal(plan.rollback.status, "prerequisites_captured");
  assert.equal(plan.performsEffect, false);
  assert.equal(plan.readsProtectedFiles, false);
  assert.equal(plan.writesProtectedFiles, false);
  assert.equal(plan.opensDatabase, false);
  assert.equal(plan.usesNetwork, false);
  assert.equal(plan.startsService, false);
  assert.equal(plan.startsWorker, false);
  assert.equal(plan.invokesAgent, false);
  assert.equal(plan.containsCredentialValue, false);
  assert.equal(plan.accessesCredentialStore, false);
  assert.equal(plan.accessesKeychain, false);
  assert.doesNotMatch(JSON.stringify(plan), /password|\/Users\/|postgresql:\/\/|100\.\d+\.\d+\.\d+/iu);
  assert.deepEqual(verifyThreeWorkerActivationBundlePreflightV1(plan), plan);
});

test("a blocker dominates owner-attended actions", () => {
  const plan = composeThreeWorkerActivationBundlePreflightV1(input({
    database_route: "blocked", claude_owner_write: "owner_attended_action",
  }));
  assert.equal(plan.status, "blocked");
  assert.deepEqual(plan.ownerActions, []);
});

test("missing, duplicate, mismatched and ineligible evidence is refused", () => {
  const missing = input(); missing.evidence.pop();
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1(missing), /preflight_refused/u);
  const missingRollback = input() as ReturnType<typeof input> & { rollback: Record<string, string> };
  delete missingRollback.rollback.websiteRouteSnapshotDigest;
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1(missingRollback), /preflight_refused/u);
  const duplicate = input(); duplicate.evidence[5] = { ...duplicate.evidence[4]! };
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1(duplicate), /preflight_refused/u);
  const mixed = input(); mixed.evidence[2] = { ...mixed.evidence[2]!,
    binding: { ...mixed.evidence[2]!.binding, releaseDigest: d("another release") } };
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1(mixed), /preflight_refused/u);
  const wrongSchema = input(); wrongSchema.evidence[0] = { ...wrongSchema.evidence[0]!, sourceSchema: schemas.database_route };
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1(wrongSchema), /preflight_refused/u);
  const invalidOwnerAction = input(); invalidOwnerAction.evidence[0] = { ...invalidOwnerAction.evidence[0]!,
    state: "owner_attended_action" };
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1(invalidOwnerAction), /preflight_refused/u);
});

test("exact replay is stable while changed evidence explicitly invalidates the old plan", () => {
  const firstInput = input({ claude_owner_write: "owner_attended_action" });
  const first = composeThreeWorkerActivationBundlePreflightV1(firstInput);
  const replay = refreshThreeWorkerActivationBundlePreflightV1(first, firstInput);
  assert.equal(replay.kind, "replay");
  assert.equal(replay.plan.planDigest, first.planDigest);
  assert.equal(replay.performsEffect, false);
  const changed = input({ database_route: "blocked", claude_owner_write: "owner_attended_action" });
  const invalidated = refreshThreeWorkerActivationBundlePreflightV1(first, changed);
  assert.equal(invalidated.kind, "invalidated");
  assert.notEqual(invalidated.plan.planDigest, first.planDigest);
  assert.equal(invalidated.plan.status, "blocked");
  assert.equal(invalidated.performsEffect, false);
});

test("tampering with status, actions or digest is refused", () => {
  const plan = composeThreeWorkerActivationBundlePreflightV1(input({ claude_owner_write: "owner_attended_action" }));
  assert.throws(() => verifyThreeWorkerActivationBundlePreflightV1({ ...plan, status: "ready" }), /preflight_refused/u);
  assert.throws(() => verifyThreeWorkerActivationBundlePreflightV1({ ...plan, ownerActions: [] }), /preflight_refused/u);
  assert.throws(() => verifyThreeWorkerActivationBundlePreflightV1({ ...plan, planDigest: d("tampered") }), /preflight_refused/u);
});
