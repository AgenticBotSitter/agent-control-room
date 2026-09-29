import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationPlanReplayMatchesV1,
  installationPlanRestartGuidanceV1, installationSetupStagesV1, refreshInstallationPlanV1, verifyInstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";

const digest = (value: string) => sha256Digest(value);
const topology = (suffix = "one") => planInstallationTopologyV1({ databaseAuthorityDigest: digest(`database:${suffix}`), schedulerAuthorityDigest: digest(`scheduler:${suffix}`),
  currentRoutes: [{ kind: "local", workerId: `worker:old:${suffix}`, adapterId: "connector:old", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: `worker:new:${suffix}`, adapterId: "connector:new", adapterRevision: "0000001" }] });
const inputs = (changed: Partial<Record<typeof installationSetupStagesV1[number], string>> = {}) => Object.fromEntries(
  installationSetupStagesV1.map(stage => [stage, digest(changed[stage] ?? `input:${stage}`)]));
const create = () => createInstallationPlanV1({ topologyPlan: topology(), releaseDigest: digest("release:one"), stageInputDigests: inputs() });

test("a fixed digest-only plan is deterministic and cannot enable authority", () => {
  const first = create(), exact = create();
  assert.deepEqual(first, exact);
  assert.equal(first.stages.length, 9);
  assert.ok(first.stages.every(item => item.state === "not_started" && item.outcomeDigest === undefined && item.recordedRevision === undefined));
  assert.equal(first.enablesAuthority, false); assert.equal(first.startsService, false); assert.equal(first.startsWorker, false);
  assert.equal(installationPlanReplayMatchesV1(first, exact), true);
  assert.doesNotMatch(JSON.stringify(first), /password|path|credential|evidence text/i);
  assert.deepEqual(verifyInstallationPlanV1(first), first);
});

test("stage changes are ordered, exact-replayable, and changed replays refuse", () => {
  let plan = create();
  plan = advanceInstallationPlanV1(plan, { expectedRevision: 0, stage: "release_preflight", action: "start" });
  assert.deepEqual(installationPlanRestartGuidanceV1(plan), { kind: "inspect", stage: "release_preflight", reason: "running", startsWork: false });
  assert.deepEqual(advanceInstallationPlanV1(plan, { expectedRevision: 0, stage: "release_preflight", action: "start" }), plan);
  plan = advanceInstallationPlanV1(plan, { expectedRevision: 1, stage: "release_preflight", action: "pass", outcomeDigest: digest("release-proof") });
  assert.deepEqual(advanceInstallationPlanV1(plan, { expectedRevision: 1, stage: "release_preflight", action: "pass", outcomeDigest: digest("release-proof") }), plan,
    "a retry after a lost terminal response uses its original revision and returns the stored result");
  assert.throws(() => advanceInstallationPlanV1(plan, { expectedRevision: 1, stage: "release_preflight", action: "pass", outcomeDigest: digest("changed-proof") }), /conflict/);
  assert.throws(() => advanceInstallationPlanV1(plan, { expectedRevision: 2, stage: "database_authority", action: "start" }), /conflict/);
  plan = advanceInstallationPlanV1(plan, { expectedRevision: 2, stage: "private_placement", action: "start" });
  assert.throws(() => advanceInstallationPlanV1(plan, { expectedRevision: 1, stage: "release_preflight", action: "pass", outcomeDigest: digest("release-proof") }), /conflict/,
    "an old retry is no longer the immediately recorded transition after later work starts");
  assert.throws(() => advanceInstallationPlanV1(plan, { expectedRevision: 2, stage: "release_preflight", action: "pass", outcomeDigest: digest("release-proof") }), /conflict/,
    "current-minus-one cannot impersonate the revision that recorded an earlier stage");
  assert.throws(() => advanceInstallationPlanV1(plan, { expectedRevision: 999, stage: "release_preflight", action: "pass", outcomeDigest: digest("release-proof") }), /conflict/);
  plan = advanceInstallationPlanV1(plan, { expectedRevision: 3, stage: "private_placement", action: "uncertain", outcomeDigest: digest("incomplete-observation") });
  assert.deepEqual(installationPlanRestartGuidanceV1(plan), { kind: "inspect", stage: "private_placement", reason: "uncertain", startsWork: false });
});

test("input changes retain only earlier proof and invalidate the affected suffix", () => {
  let plan = create();
  for (const stage of ["release_preflight", "private_placement", "database_authority"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest: digest(`proof:${stage}`) });
  }
  const refreshed = refreshInstallationPlanV1(plan, { topologyPlan: topology(), releaseDigest: digest("release:one"),
    stageInputDigests: inputs({ protected_data: "changed-protected-data" }) });
  assert.equal(refreshed.stages[2]!.state, "passed");
  assert.equal(refreshed.stages[2]!.recordedRevision, plan.stages[2]!.recordedRevision,
    "refresh retains the receipt revision for unaffected earlier proof");
  assert.equal(refreshed.stages[3]!.state, "not_started");
  assert.equal(refreshed.stages[8]!.state, "not_started");
  assert.equal(refreshed.revision, plan.revision + 1);
  assert.deepEqual(refreshInstallationPlanV1(plan, { topologyPlan: topology(), releaseDigest: digest("release:one"), stageInputDigests: inputs() }), plan);
});

test("a revised release or topology invalidates every pass and failures remain owner attention", () => {
  let plan = create();
  plan = advanceInstallationPlanV1(plan, { expectedRevision: 0, stage: "release_preflight", action: "start" });
  plan = advanceInstallationPlanV1(plan, { expectedRevision: 1, stage: "release_preflight", action: "pass", outcomeDigest: digest("proof") });
  const releaseChanged = refreshInstallationPlanV1(plan, { topologyPlan: topology(), releaseDigest: digest("release:two"), stageInputDigests: inputs() });
  assert.ok(releaseChanged.stages.every(item => item.state === "not_started"));
  const topologyChanged = refreshInstallationPlanV1(plan, { topologyPlan: topology("two"), releaseDigest: digest("release:one"), stageInputDigests: inputs() });
  assert.ok(topologyChanged.stages.every(item => item.state === "not_started"));
  const started = advanceInstallationPlanV1(create(), { expectedRevision: 0, stage: "release_preflight", action: "start" });
  const failed = advanceInstallationPlanV1(started, { expectedRevision: 1, stage: "release_preflight", action: "fail", outcomeDigest: digest("failure") });
  assert.deepEqual(installationPlanRestartGuidanceV1(failed), { kind: "owner_attention", stage: "release_preflight", reason: "failed", startsWork: false });
});

test("refresh refuses to erase unresolved running or uncertain work", () => {
  const running = advanceInstallationPlanV1(create(), { expectedRevision: 0, stage: "release_preflight", action: "start" });
  assert.throws(() => refreshInstallationPlanV1(running, { topologyPlan: topology(), releaseDigest: digest("release:two"),
    stageInputDigests: inputs() }), /conflict/);
  assert.throws(() => refreshInstallationPlanV1(running, { topologyPlan: topology(), releaseDigest: digest("release:one"),
    stageInputDigests: inputs({ release_preflight: "changed-release-input" }) }), /conflict/);
  const uncertain = advanceInstallationPlanV1(running, { expectedRevision: 1, stage: "release_preflight", action: "uncertain",
    outcomeDigest: digest("uncertain-observation") });
  assert.throws(() => refreshInstallationPlanV1(uncertain, { topologyPlan: topology("two"), releaseDigest: digest("release:one"),
    stageInputDigests: inputs() }), /conflict/);
});

test("malformed stage order, outcomes, and stale revisions are refused", () => {
  const plan = create();
  assert.throws(() => verifyInstallationPlanV1({ ...plan, stages: [...plan.stages].reverse() }), /installation_plan_invalid/);
  assert.throws(() => verifyInstallationPlanV1({ ...plan, stages: plan.stages.map((item, index) => index === 0 ? { ...item, outcomeDigest: digest("forged") } : item) }), /installation_plan_invalid/);
  assert.throws(() => advanceInstallationPlanV1(plan, { expectedRevision: 3, stage: "release_preflight", action: "start" }), /conflict/);
});
