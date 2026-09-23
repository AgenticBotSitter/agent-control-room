import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { advanceInstallationTransitionV1, createInstallationTransitionV1 } from "../src/harness/v1/installation-transition";
import { summarizeInstallationTransitionV1 } from "../src/harness/v1/installation-transition-summary";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";

const digest = (value: string) => sha256Digest(value);
const at = (seconds: number) => new Date(1_800_000_000_000 + seconds * 1000).toISOString();
const plan = () => planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
  currentRoutes: [{ kind: "local", workerId: "worker:one", adapterId: "connector:local", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: "worker:one", adapterId: "connector:local", adapterRevision: "0000001" },
    { kind: "remote", workerId: "worker:two", adapterId: "connector:remote", adapterRevision: "0000001" }] });

test("a missing transition is honest and never looks like worker enablement", () => {
  const summary = summarizeInstallationTransitionV1(undefined);
  assert.equal(summary.state, "not_started");
  assert.equal(summary.affectedWorkerCount, 0);
  assert.equal(summary.canEnableWorkers, false);
  assert.equal(summary.canRelocateAuthority, false);
});

test("a verified transition has safe status wording without route identity or authority", () => {
  let record = createInstallationTransitionV1({ transitionId: "transition:summary", topologyPlan: plan(), now: at(0) });
  let summary = summarizeInstallationTransitionV1(record);
  assert.equal(summary.state, "prepared");
  assert.equal(summary.affectedWorkerCount, 1);
  assert.doesNotMatch(JSON.stringify(summary), /worker:two|connector:remote|sha256:/);
  record = advanceInstallationTransitionV1(record, { expectedRevision: 0, action: "pause_admission", now: at(1), evidenceDigest: digest("pause") });
  summary = summarizeInstallationTransitionV1(record);
  assert.equal(summary.state, "admission_paused");
  assert.match(summary.ownerMessage, /paused/i);
  assert.equal(summary.canEnableWorkers, false);
  assert.equal(summary.canRelocateAuthority, false);
});

test("tampered transition material cannot produce a status summary", () => {
  const record = createInstallationTransitionV1({ transitionId: "transition:forged", topologyPlan: plan(), now: at(0) });
  assert.throws(() => summarizeInstallationTransitionV1({ ...record, state: "committed" }), /transition_invalid/);
});
