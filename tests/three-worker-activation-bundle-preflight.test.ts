import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { composeThreeWorkerActivationBundlePreflightV1, createThreeWorkerActivationBundleCustodyV1,
  recordThreeWorkerActivationEvidenceV1, recordThreeWorkerActivationRollbackEvidenceV1,
  refreshThreeWorkerActivationBundlePreflightV1, verifyThreeWorkerActivationBundlePreflightV1 } from
  "../src/installer/v1/three-worker-activation-bundle-preflight";

const d = (name: string) => sha256Digest(name);
function fixture() {
  const custody = createThreeWorkerActivationBundleCustodyV1({ installationId: "control-room-one",
    releaseDigest: d("release"), topologyPlanDigest: d("topology") });
  const evidence = (states: Record<string, "ready" | "blocked" | "owner_attended_action"> = {}) =>
    Object.entries(custody.evidenceIssuers).map(([name, issuer]) =>
      recordThreeWorkerActivationEvidenceV1(issuer, states[name] ?? "ready"));
  const rollback = Object.values(custody.rollbackIssuers).map(recordThreeWorkerActivationRollbackEvidenceV1);
  return { custody, evidence, rollback };
}

test("composes one redacted no-effect owner window from opaque producer evidence", () => {
  const f = fixture();
  const plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate,
    evidence: f.evidence({ hermes_route: "owner_attended_action", claude_owner_write: "owner_attended_action" }),
    rollback: f.rollback });
  assert.equal(plan.status, "owner_attended_action_required");
  assert.deepEqual(plan.ownerActions, ["approve_hermes_first_task", "materialize_claude_manifest"]);
  assert.equal(plan.generation, 1);
  for (const name of ["performsEffect", "readsProtectedFiles", "writesProtectedFiles", "opensDatabase", "usesNetwork",
    "startsService", "startsWorker", "invokesAgent", "accessesCredentialStore", "accessesKeychain"] as const)
    assert.equal(plan[name], false);
  assert.doesNotMatch(JSON.stringify(plan), /password|\/Users\/|postgresql:\/\/|100\.\d+\.\d+\.\d+/iu);
  assert.deepEqual(verifyThreeWorkerActivationBundlePreflightV1(f.custody.aggregate, plan), plan);
});

test("blocked evidence dominates owner action", () => {
  const f = fixture();
  const plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate,
    evidence: f.evidence({ database_route: "blocked", claude_owner_write: "owner_attended_action" }), rollback: f.rollback });
  assert.equal(plan.status, "blocked"); assert.deepEqual(plan.ownerActions, []);
});

test("missing, duplicate, mixed-custody, and forged evidence is refused", () => {
  const f = fixture(), all = f.evidence(), other = fixture();
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate,
    evidence: all.slice(1), rollback: f.rollback }), /preflight_refused/u);
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate,
    evidence: [...all.slice(0, 5), all[0]], rollback: f.rollback }), /preflight_refused/u);
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate,
    evidence: [...all.slice(0, 5), other.evidence()[5]], rollback: f.rollback }), /preflight_refused/u);
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate,
    evidence: [...all.slice(0, 5), { schema: "control-room.three-worker-activation-evidence/v1",
      evidenceDigest: d("forged") }], rollback: f.rollback }), /preflight_refused/u);
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate,
    evidence: all, rollback: [...f.rollback.slice(0, 4), { schema: "control-room.three-worker-activation-rollback-evidence/v1",
      evidenceDigest: d("forged rollback") }] }), /preflight_refused/u);
});

test("exact replay is stable and refresh invalidates old generation", () => {
  const f = fixture(), originalEvidence = f.evidence({ claude_owner_write: "owner_attended_action" });
  const first = composeThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate,
    evidence: originalEvidence, rollback: f.rollback });
  const replay = refreshThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate, current: first,
    evidence: originalEvidence, rollback: f.rollback });
  assert.equal(replay.kind, "replay"); assert.equal(replay.plan.generation, 1);
  const changed = refreshThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate, current: first,
    evidence: f.evidence({ database_route: "blocked", claude_owner_write: "owner_attended_action" }), rollback: f.rollback });
  assert.equal(changed.kind, "invalidated"); assert.equal(changed.plan.generation, 2);
  assert.throws(() => verifyThreeWorkerActivationBundlePreflightV1(f.custody.aggregate, first), /preflight_refused/u);
  assert.deepEqual(verifyThreeWorkerActivationBundlePreflightV1(f.custody.aggregate, changed.plan), changed.plan);
});

test("tampering with current output remains refused", () => {
  const f = fixture(), plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: f.custody.aggregate,
    evidence: f.evidence({ claude_owner_write: "owner_attended_action" }), rollback: f.rollback });
  assert.throws(() => verifyThreeWorkerActivationBundlePreflightV1(f.custody.aggregate,
    { ...plan, status: "ready" }), /preflight_refused/u);
  assert.throws(() => verifyThreeWorkerActivationBundlePreflightV1(f.custody.aggregate,
    { ...plan, planDigest: d("tampered") }), /preflight_refused/u);
});
