import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1, verifyInstallationTopologyPlanV1 } from "../src/harness/v1/installation-topology";
import { createInstallationReadinessV1, summarizeInstallationReadinessV1, verifyInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const local = { kind: "local" as const, workerId: "worker:marvin", adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "00570550" };
const remote = { kind: "remote" as const, workerId: "worker:remote", adapterId: "connector:generic-remote-v1", adapterRevision: "00570550" };
const input = (requestedRoutes: readonly unknown[]) => ({ databaseAuthorityDigest: digest("one-postgres"),
  schedulerAuthorityDigest: digest("one-scheduler"), currentRoutes: [local], requestedRoutes });

test("a this-computer plan preserves one authority and asks only for local proof", () => {
  const plan = planInstallationTopologyV1(input([local]));
  assert.equal(plan.currentMode, "this_computer");
  assert.equal(plan.mode, "this_computer");
  assert.deepEqual(plan.retainedWorkerIds, ["worker:marvin"]);
  assert.deepEqual(plan.reboundWorkerIds, []);
  assert.deepEqual(plan.addedRemoteWorkerIds, []);
  assert.deepEqual(plan.removedWorkerIds, []);
  assert.deepEqual(plan.requiredProofs, ["backup_restore", "local_owner_qualification", "local_runner_bridge"]);
  assert.equal(plan.enablesWorkers, false);
  assert.deepEqual(verifyInstallationTopologyPlanV1(plan), plan);
});

test("adding a remote worker is one-installation migration preparation, not a second system", () => {
  const plan = planInstallationTopologyV1(input([local, remote]));
  assert.equal(plan.currentMode, "this_computer");
  assert.equal(plan.mode, "several_computers");
  assert.deepEqual(plan.retainedWorkerIds, ["worker:marvin"]);
  assert.deepEqual(plan.reboundWorkerIds, []);
  assert.deepEqual(plan.addedRemoteWorkerIds, ["worker:remote"]);
  assert.deepEqual(plan.removedWorkerIds, []);
  assert.deepEqual(plan.requiredProofs, ["backup_restore", "local_owner_qualification", "local_runner_bridge", "remote_enrollment", "two_computer_delivery"]);
  assert.equal(plan.enablesWorkers, false);
});

test("a worker cannot be both local and remote, and a changed reviewed plan is refused", () => {
  assert.throws(() => planInstallationTopologyV1(input([local, { ...local, kind: "remote" as const }])), /worker_route_ambiguous/);
  const plan = planInstallationTopologyV1(input([local]));
  assert.throws(() => verifyInstallationTopologyPlanV1({ ...plan, mode: "several_computers" }), /plan_invalid/);
  const duplicateProofs = { ...plan, requiredProofs: [...plan.requiredProofs, "backup_restore"] };
  const { planDigest: _ignored, ...duplicateMaterial } = duplicateProofs;
  assert.throws(() => verifyInstallationTopologyPlanV1({ ...duplicateMaterial,
    planDigest: sha256Digest(duplicateMaterial) }), /plan_invalid/);
});

test("moving a known worker between local and remote is a rebind, not quiet retention", () => {
  const plan = planInstallationTopologyV1(input([{ ...local, kind: "remote" }]));
  assert.deepEqual(plan.retainedWorkerIds, []);
  assert.deepEqual(plan.reboundWorkerIds, ["worker:marvin"]);
  assert.deepEqual(plan.addedRemoteWorkerIds, []);
  assert.deepEqual(plan.removedWorkerIds, []);
  assert.ok(plan.requiredProofs.includes("remote_enrollment"));
});

test("the plan binds every route change and records an explicit worker removal", () => {
  const original = planInstallationTopologyV1(input([local, remote]));
  const removed = planInstallationTopologyV1({ ...input([local]), currentRoutes: [local, remote] });
  const changedAdapter = planInstallationTopologyV1(input([{ ...local, adapterRevision: "00600000" }]));
  const differentLocal = planInstallationTopologyV1(input([local, { ...local, workerId: "worker:local-second" }]));
  assert.deepEqual(removed.removedWorkerIds, ["worker:remote"]);
  assert.notEqual(original.planDigest, removed.planDigest);
  assert.notEqual(planInstallationTopologyV1(input([local])).planDigest, changedAdapter.planDigest);
  assert.notEqual(planInstallationTopologyV1(input([local, { ...local, workerId: "worker:local-first" }])).planDigest, differentLocal.planDigest);
  assert.throws(() => verifyInstallationTopologyPlanV1({ ...removed, removedWorkerIds: [] }), /plan_invalid/);
});

test("readiness is bound to one reviewed plan and never means a worker is enabled", () => {
  const plan = planInstallationTopologyV1(input([local]));
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: digest("restore-evidence") },
    { proof: "local_owner_qualification", state: "not_started" },
    { proof: "local_runner_bridge", state: "not_started" },
  ] });
  assert.deepEqual(verifyInstallationReadinessV1(readiness), readiness);
  const summary = summarizeInstallationReadinessV1(plan, readiness);
  assert.equal(summary.state, "not_ready");
  assert.equal(summary.nextProof, "local_owner_qualification");
  const differentPlan = planInstallationTopologyV1({ ...input([local]), currentRoutes: [] });
  assert.throws(() => summarizeInstallationReadinessV1(differentPlan, readiness), /mismatch/);
  assert.throws(() => createInstallationReadinessV1({ planDigest: plan.planDigest,
    proofs: [{ proof: "backup_restore", state: "passed" }] }), /pass_without_evidence/);
  const unrelated = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "remote_enrollment", state: "not_started" },
  ] });
  assert.throws(() => summarizeInstallationReadinessV1(plan, unrelated), /proof_not_required/);
});

test("a unified local-and-remote installation can retain all five required proof states", () => {
  const plan = planInstallationTopologyV1(input([local, remote]));
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: digest("backup") },
    { proof: "local_owner_qualification", state: "passed", evidenceDigest: digest("text") },
    { proof: "local_runner_bridge", state: "passed", evidenceDigest: digest("runner") },
    { proof: "remote_enrollment", state: "passed", evidenceDigest: digest("remote") },
    { proof: "two_computer_delivery", state: "passed", evidenceDigest: digest("delivery") },
  ] });
  assert.equal(summarizeInstallationReadinessV1(plan, readiness).state, "ready_for_owner_enablement");
});
