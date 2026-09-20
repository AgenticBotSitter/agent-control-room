import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1, verifyInstallationTopologyPlanV1 } from "../src/harness/v1/installation-topology";
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
  assert.deepEqual(plan.requiredProofs, ["backup_restore", "local_owner_qualification"]);
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
  assert.deepEqual(plan.requiredProofs, ["backup_restore", "local_owner_qualification", "remote_enrollment", "two_computer_delivery"]);
  assert.equal(plan.enablesWorkers, false);
});

test("a worker cannot be both local and remote, and a changed reviewed plan is refused", () => {
  assert.throws(() => planInstallationTopologyV1(input([local, { ...local, kind: "remote" as const }])), /worker_route_ambiguous/);
  const plan = planInstallationTopologyV1(input([local]));
  assert.throws(() => verifyInstallationTopologyPlanV1({ ...plan, mode: "several_computers" }), /plan_invalid/);
});

test("moving a known worker between local and remote is a rebind, not quiet retention", () => {
  const plan = planInstallationTopologyV1(input([{ ...local, kind: "remote" }]));
  assert.deepEqual(plan.retainedWorkerIds, []);
  assert.deepEqual(plan.reboundWorkerIds, ["worker:marvin"]);
  assert.deepEqual(plan.addedRemoteWorkerIds, []);
  assert.ok(plan.requiredProofs.includes("remote_enrollment"));
});
