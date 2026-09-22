import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { firstOwnerStageInputDigestV1 } from "../src/installer/v1/first-owner-setup-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1, PRIVATE_FIRST_OWNER_CLEANUP_V1,
  PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1, PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1,
  type PrivateFirstOwnerRunnerContextV1, type PrivateFirstOwnerRuntimeV1 } from
  "../src/installer/v1/private-first-owner-runner";
import { dispatchPrivateLocalSetupStageV1 } from "../src/installer/v1/private-local-setup-orchestrator";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const installationId = "local-installation-one";
const releaseDigest = d("exact-release");
const databaseOutcome = d("database-outcome");
const protectedOutcome = d("protected-outcome");
const ownerSource = Object.freeze({ databaseAuthorityOutcomeDigest: databaseOutcome,
  bootstrapConfigurationDigest: d("bootstrap-configuration"), trustConfigurationDigest: d("trust-configuration"),
  expectedOwnerSubjectDigest: d("expected-owner-subject"), observedOwnerState: "empty" as const,
  observationDigest: d("empty-owner-observation") });
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: d("database"),
  schedulerAuthorityDigest: d("scheduler"), currentRoutes: [], requestedRoutes: [] });


async function fixture() {
  const stageInputs = Object.fromEntries(installationSetupStagesV1.map(name => [name, d(`placeholder:${name}`)]));
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs });
  const history: InstallationPlanV1[] = [plan];
  for (const selected of ["release_preflight", "private_placement", "database_authority", "protected_data"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" }); history.push(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? databaseOutcome
        : selected === "protected_data" ? protectedOutcome : d(`outcome:${selected}`) }); history.push(plan);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-local-orchestrator-"))); await chmod(root, 0o700);
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid: process.getuid!() });
  for (const item of history) await journal.append(item);
  const ownerInputDigest = firstOwnerStageInputDigestV1({ releaseDigest,
    databaseAuthorityOutcomeDigest: ownerSource.databaseAuthorityOutcomeDigest,
    bootstrapConfigurationDigest: ownerSource.bootstrapConfigurationDigest,
    trustConfigurationDigest: ownerSource.trustConfigurationDigest,
    expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest });
  const refreshed = refreshInstallationPlanV1(plan, { topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(plan.stages.map(item => [item.stage,
      item.stage === "first_owner" ? ownerInputDigest : item.inputDigest])) });
  const running = advanceInstallationPlanV1(refreshed, { expectedRevision: refreshed.revision,
    stage: "first_owner", action: "start" });
  return { root, journal, plan, running, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

function runtimeFor(running: InstallationPlanV1, calls: string[], ceremonyFails = false): PrivateFirstOwnerRuntimeV1 {
  const binding = Object.freeze({ schema: PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1, installationId,
    installationPlanDigest: running.planDigest, installationPlanRevision: running.revision, releaseDigest,
    databaseAuthorityOutcomeDigest: databaseOutcome, expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest });
  return Object.freeze({ binding, signal: new AbortController().signal, controlDeadlineMs: 500, cleanupDeadlineMs: 100,
    async confirmOwnerAttachedTerminal(context: PrivateFirstOwnerRunnerContextV1) {
      calls.push("owner-attached"); return { schema: PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1, installationId,
        requestDigest: context.requestDigest, installationPlanDigest: binding.installationPlanDigest,
        installationPlanRevision: binding.installationPlanRevision, releaseDigest,
        databaseAuthorityOutcomeDigest: databaseOutcome, expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest,
        ownerAttached: true as const, confirmed: true as const };
    },
    async runRetainedOwnerBootstrapCeremony() {
      calls.push("ceremony"); if (ceremonyFails) throw new Error("lost ceremony reply");
      return { schema: "control-room.owner-bootstrap-complete/v1" as const, ownerCreated: true as const,
        normalApplicationAvailable: true as const, physicalGatewayAcceptanceComplete: false as const };
    },
    async verifyExistingOwner(context) {
      calls.push("verify-existing-owner"); return { schema: PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1,
        installationId, requestDigest: context.requestDigest, installationPlanDigest: binding.installationPlanDigest,
        installationPlanRevision: binding.installationPlanRevision, releaseDigest,
        databaseAuthorityOutcomeDigest: databaseOutcome, expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest,
        ownerConfirmed: true as const, ownerState: "existing" as const, ownerProofDigest: d("owner-proof"),
        ceremonyOutcomeDigest: context.ceremonyOutcomeDigest, outcome: "verified" as const };
    },
    async cleanupRetainedOwnerBootstrapCeremony(context) {
      calls.push("cleanup"); return { schema: PRIVATE_FIRST_OWNER_CLEANUP_V1, installationId,
        requestDigest: context.requestDigest, scope: "retained_owner_bootstrap_ceremony" as const,
        outcome: "confirmed" as const };
    },
  });
}

function input(plan: InstallationPlanV1, requestedStage: "first_owner" | "recovery", source: unknown = ownerSource) {
  return { installationId, expectedPlanRevision: plan.revision, expectedPlanDigest: plan.planDigest,
    expectedReleaseDigest: releaseDigest, requestedStage, topologyPlan: topology, source };
}

test("dispatches the exact next owner stage, settles it once, then exposes the missing recovery seam", async () => {
  const f = await fixture(), calls: string[] = [];
  try {
    const result = await dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
      { journal: f.journal, firstOwner: runtimeFor(f.running, calls) });
    assert.equal(result.status, "completed");
    assert.equal(result.installationPlan.stages[4]!.state, "passed");
    assert.deepEqual(calls, ["owner-attached", "ceremony", "verify-existing-owner", "cleanup"]);
    assert.equal(result.createsStateMachine, false); assert.equal(result.createsReceiptStore, false);
    assert.equal(result.exposesBrowserEffect, false); assert.equal(result.suppliesNativeEffect, false);
    const before = (await f.journal.readHistory()).length;
    const blocked = await dispatchPrivateLocalSetupStageV1(input(result.installationPlan, "recovery", {}), { journal: f.journal });
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.blocker, "recovery_private_adapter_missing");
    assert.equal((await f.journal.readHistory()).length, before);
  } finally { await f.cleanup(); }
});

test("installation, release, revision, digest, stage, and runtime substitution refuse before owner confirmation", async () => {
  for (const mutate of [
    (value: ReturnType<typeof input>) => ({ ...value, installationId: "other-installation" }),
    (value: ReturnType<typeof input>) => ({ ...value, expectedPlanRevision: value.expectedPlanRevision + 1 }),
    (value: ReturnType<typeof input>) => ({ ...value, expectedPlanDigest: d("other-plan") }),
    (value: ReturnType<typeof input>) => ({ ...value, expectedReleaseDigest: d("other-release") }),
    (value: ReturnType<typeof input>) => ({ ...value, requestedStage: "recovery" as const, source: {} }),
  ]) {
    const f = await fixture(), calls: string[] = [];
    try {
      await assert.rejects(dispatchPrivateLocalSetupStageV1(mutate(input(f.plan, "first_owner")),
        { journal: f.journal, firstOwner: runtimeFor(f.running, calls) }), /private_local_setup_orchestrator_refused/);
      assert.deepEqual(calls, []);
      assert.equal((await f.journal.readHistory()).at(-1)!.planDigest, f.plan.planDigest);
    } finally { await f.cleanup(); }
  }
});

test("an uncertain owner effect remains running and cannot be dispatched again", async () => {
  const f = await fixture(), calls: string[] = [];
  try {
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
      { journal: f.journal, firstOwner: runtimeFor(f.running, calls, true) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(calls, ["owner-attached", "ceremony", "cleanup"]);
    const retained = (await f.journal.readHistory()).at(-1)!;
    assert.equal(retained.stages[4]!.state, "running");
    const retryCalls: string[] = [];
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(retained, "first_owner"),
      { journal: f.journal, firstOwner: runtimeFor(retained, retryCalls) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(retryCalls, []);
    assert.equal((await f.journal.readHistory()).at(-1)!.planDigest, retained.planDigest);
  } finally { await f.cleanup(); }
});

test("simultaneous dispatch elects one fresh running revision before any owner effect", async () => {
  const f = await fixture(), leftCalls: string[] = [], rightCalls: string[] = [];
  try {
    const outcomes = await Promise.allSettled([
      dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
        { journal: f.journal, firstOwner: runtimeFor(f.running, leftCalls) }),
      dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
        { journal: f.journal, firstOwner: runtimeFor(f.running, rightCalls) }),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    assert.equal([...leftCalls, ...rightCalls].filter(item => item === "owner-attached").length, 1);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages[4]!.state, "passed");
  } finally { await f.cleanup(); }
});

test("source directly reuses accepted transactions and runners and imports no browser, scheduler, database, or native effect", async () => {
  const source = await readFile("src/installer/v1/private-local-setup-orchestrator.ts", "utf8");
  for (const retained of ["startPostgresOwnerActionV1",
    "runPrivatePostgresOwnerActionV1", "confirmPostgresOwnerActionTerminalV1",
    "runPrivateProtectedRootOwnerActionV1", "confirmProtectedDataActionTerminalV1",
    "runPrivateFirstOwnerActionV1", "confirmFirstOwnerActionTerminalV1"]) assert.match(source, new RegExp(retained));
  assert.doesNotMatch(source, /from "(?:node:fs|node:child_process|node:net)"|pg-boss|private-app|launchctl|createServer|setInterval/i);
});
