import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { advanceInstallationTransitionV1, createInstallationTransitionV1, verifyInstallationTransitionV1 } from "../src/harness/v1/installation-transition";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";

const at = (seconds: number) => new Date(1_800_000_000_000 + seconds * 1000).toISOString();
const digest = (value: string) => sha256Digest(value);
const plan = () => planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
  currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" },
    { kind: "remote", workerId: "worker:remote", adapterId: "connector:remote", adapterRevision: "0000001" }] });

test("a worker-layout transition binds the reviewed topology and follows pause, drain, proof, commit", () => {
  let record = createInstallationTransitionV1({ transitionId: "transition:fixture", topologyPlan: plan(), now: at(0) });
  assert.deepEqual(record.affectedWorkerIds, ["worker:remote"]);
  for (const [action, label] of [["pause_admission", "pause"], ["record_drain", "drain"], ["verify_proofs", "proof"], ["commit", "commit"]] as const) {
    record = advanceInstallationTransitionV1(record, { expectedRevision: record.revision, action, now: at(record.revision + 1), evidenceDigest: digest(label) });
  }
  assert.equal(record.state, "committed");
  assert.equal(record.enablesWorkers, false);
  assert.equal(record.authorizesAuthorityRelocation, false);
  assert.deepEqual(verifyInstallationTransitionV1(record), record);
});

test("a failed transition can only prepare and record rollback before commitment", () => {
  let record = createInstallationTransitionV1({ transitionId: "transition:rollback", topologyPlan: plan(), now: at(0) });
  record = advanceInstallationTransitionV1(record, { expectedRevision: 0, action: "fail", now: at(1), failureDigest: digest("failure") });
  record = advanceInstallationTransitionV1(record, { expectedRevision: 1, action: "prepare_rollback", now: at(2), evidenceDigest: digest("rollback-ready") });
  record = advanceInstallationTransitionV1(record, { expectedRevision: 2, action: "rollback", now: at(3), evidenceDigest: digest("rolled-back") });
  assert.equal(record.state, "rolled_back");
  assert.throws(() => advanceInstallationTransitionV1(record, { expectedRevision: 3, action: "commit", now: at(4), evidenceDigest: digest("late") }));
});

test("a transition includes new local workers and supports the maximum disjoint route replacement", () => {
  const localOnly = planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local-one", adapterId: "connector:local", adapterRevision: "0000001" }],
    requestedRoutes: [
      { kind: "local", workerId: "worker:local-one", adapterId: "connector:local", adapterRevision: "0000001" },
      { kind: "local", workerId: "worker:local-two", adapterId: "connector:local", adapterRevision: "0000001" },
    ] });
  assert.deepEqual(createInstallationTransitionV1({ transitionId: "transition:local-add", topologyPlan: localOnly, now: at(0) }).affectedWorkerIds,
    ["worker:local-two"]);

  const route = (kind: "local" | "remote", index: number) => ({ kind, workerId: `worker:${kind}:${index}`,
    adapterId: `connector:${kind}`, adapterRevision: "0000001" });
  const maximum = planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
    currentRoutes: Array.from({ length: 100 }, (_, index) => route("local", index)),
    requestedRoutes: Array.from({ length: 100 }, (_, index) => route("remote", index)) });
  const record = createInstallationTransitionV1({ transitionId: "transition:maximum", topologyPlan: maximum, now: at(0) });
  assert.equal(record.affectedWorkerIds.length, 200);
  assert.deepEqual(verifyInstallationTransitionV1(record), record);
});

test("the transition contract rejects out-of-order, stale and forged records", () => {
  const record = createInstallationTransitionV1({ transitionId: "transition:denial", topologyPlan: plan(), now: at(0) });
  assert.throws(() => advanceInstallationTransitionV1(record, { expectedRevision: 0, action: "commit", now: at(1), evidenceDigest: digest("wrong") }));
  assert.throws(() => advanceInstallationTransitionV1(record, { expectedRevision: 2, action: "pause_admission", now: at(1), evidenceDigest: digest("stale") }));
  assert.throws(() => verifyInstallationTransitionV1({ ...record, enablesWorkers: true }));
});
