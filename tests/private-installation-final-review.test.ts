import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1,
  confirmPrivateInstallationFinalReviewV1, runPrivateInstallationFinalReviewV1,
  type PrivateInstallationFinalReviewContextV1 } from
  "../src/installer/v1/private-installation-final-review";

const digest = (value: string) => sha256Digest(value);
const installationId = "private-installation-one";
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"),
  schedulerAuthorityDigest: digest("scheduler"), currentRoutes: [], requestedRoutes: [] });
const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(name => [name, digest(`input:${name}`)]));

function readyPlan() {
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: digest("release"), stageInputDigests });
  for (const name of installationSetupStagesV1.slice(0, -1)) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: name, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: name, action: "pass",
      outcomeDigest: digest(`outcome:${name}`) });
  }
  return plan;
}

class MemoryJournal {
  readonly installationId: string;
  readonly history: InstallationPlanV1[];
  constructor(plan: InstallationPlanV1, id = installationId) {
    this.installationId = id;
    this.history = Array(plan.revision + 1) as InstallationPlanV1[];
    this.history[plan.revision] = plan;
  }
  async readHistory() { return Object.freeze([...this.history]); }
  async append(plan: InstallationPlanV1) {
    const existing = this.history[plan.revision];
    if (existing) {
      if (existing.planDigest !== plan.planDigest) throw new Error("conflict");
      return { schema: "control-room.installation-plan-journal/v1" as const, installationId: this.installationId,
        revision: plan.revision, planDigest: plan.planDigest, replayed: true,
        enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
    }
    if (plan.revision !== this.history.length) throw new Error("conflict");
    this.history.push(plan);
    return { schema: "control-room.installation-plan-journal/v1" as const, installationId: this.installationId,
      revision: plan.revision, planDigest: plan.planDigest, replayed: false,
      enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
  }
}

function confirmation(context: PrivateInstallationFinalReviewContextV1) {
  return Object.freeze({ schema: PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1,
    installationId: context.installationId, installationPlanDigest: context.installationPlanDigest,
    installationPlanRevision: context.installationPlanRevision,
    finalReviewInputDigest: context.finalReviewInputDigest, ownerAttached: true as const, confirmed: true as const });
}

const runnerInput = (plan: InstallationPlanV1) => ({ installationId, installationPlan: plan, topologyPlan: topology });
const runtime = (journal: MemoryJournal, confirmOwnerAttached = async (context: PrivateInstallationFinalReviewContextV1) => confirmation(context)) =>
  ({ journal, signal: new AbortController().signal, controlDeadlineMs: 1_000, confirmOwnerAttached });

test("owner confirmation starts and settles only final_review without enabling any effect", async () => {
  const plan = readyPlan(), journal = new MemoryJournal(plan);
  let seen: PrivateInstallationFinalReviewContextV1 | undefined;
  const terminal = await runPrivateInstallationFinalReviewV1(runnerInput(plan), runtime(journal, async context => {
    seen = context;
    assert.equal(Object.isFrozen(context), true);
    assert.equal(context.invokesAgent, false); assert.equal(context.enablesAuthority, false);
    assert.equal(JSON.stringify(context).includes("signal"), true);
    return confirmation(context);
  }));
  assert.ok(seen);
  assert.equal(journal.history.at(-1)!.stages.at(-1)!.state, "running");
  const settled = await confirmPrivateInstallationFinalReviewV1({ terminal }, { journal });
  assert.equal(settled.replayed, false);
  assert.equal(journal.history.at(-1)!.stages.at(-1)!.state, "passed");
  assert.equal(journal.history.at(-1)!.stages.at(-1)!.outcomeDigest, terminal.confirmationDigest);
  assert.deepEqual(await confirmPrivateInstallationFinalReviewV1({ terminal }, { journal }), { ...settled, replayed: true });
});

test("concurrent starts elect one attached-owner callback before native entry", async () => {
  const plan = readyPlan(), journal = new MemoryJournal(plan);
  let calls = 0;
  const shared = runtime(journal, async context => { calls += 1; return confirmation(context); });
  const results = await Promise.allSettled([
    runPrivateInstallationFinalReviewV1(runnerInput(plan), shared),
    runPrivateInstallationFinalReviewV1(runnerInput(plan), shared),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(calls, 1);
});

test("foreign installation identity and stale current tips refuse before owner confirmation", async () => {
  const plan = readyPlan();
  let calls = 0;
  await assert.rejects(runPrivateInstallationFinalReviewV1(runnerInput(plan), runtime(new MemoryJournal(plan, "foreign-installation"),
    async context => { calls += 1; return confirmation(context); })), /private_installation_final_review_refused/);
  const stale = new MemoryJournal(plan);
  stale.history.push(advanceInstallationPlanV1(plan, { expectedRevision: plan.revision,
    stage: "final_review", action: "start" }));
  await assert.rejects(runPrivateInstallationFinalReviewV1(runnerInput(plan), runtime(stale,
    async context => { calls += 1; return confirmation(context); })), /private_installation_final_review_refused/);
  assert.equal(calls, 0);
});

test("failed or uncertain prerequisite evidence refuses", async () => {
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: digest("release"), stageInputDigests });
  for (const name of installationSetupStagesV1.slice(0, -2)) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: name, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: name, action: "pass",
      outcomeDigest: digest(`outcome:${name}`) });
  }
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "agent_readiness", action: "start" });
  const uncertain = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "agent_readiness",
    action: "uncertain", outcomeDigest: digest("uncertain") });
  let calls = 0;
  await assert.rejects(runPrivateInstallationFinalReviewV1(runnerInput(uncertain), runtime(new MemoryJournal(uncertain),
    async context => { calls += 1; return confirmation(context); })), /private_installation_final_review_refused/);
  assert.equal(calls, 0);
});

test("changed owner evidence and a changed journal tip after callback refuse terminal confirmation", async () => {
  const first = readyPlan(), firstJournal = new MemoryJournal(first);
  await assert.rejects(runPrivateInstallationFinalReviewV1(runnerInput(first), runtime(firstJournal, async context => ({
    ...confirmation(context), finalReviewInputDigest: digest("changed"),
  }))), /private_installation_final_review_refused/);

  const second = readyPlan(), secondJournal = new MemoryJournal(second);
  await assert.rejects(runPrivateInstallationFinalReviewV1(runnerInput(second), runtime(secondJournal, async context => {
    const running = secondJournal.history.at(-1)!;
    await secondJournal.append(advanceInstallationPlanV1(running, { expectedRevision: running.revision,
      stage: "final_review", action: "pass", outcomeDigest: digest("foreign-outcome") }));
    return confirmation(context);
  })), /private_installation_final_review_refused/);
});

test("timeout aborts the child signal and produces no terminal confirmation", async () => {
  const plan = readyPlan(), journal = new MemoryJournal(plan);
  let child: AbortSignal | undefined;
  await assert.rejects(runPrivateInstallationFinalReviewV1(runnerInput(plan), {
    journal, signal: new AbortController().signal, controlDeadlineMs: 10,
    async confirmOwnerAttached(context: PrivateInstallationFinalReviewContextV1) {
      child = context.signal;
      return new Promise(() => undefined);
    },
  }), /private_installation_final_review_refused/);
  assert.equal(child?.aborted, true);
  assert.equal(journal.history.at(-1)!.stages.at(-1)!.state, "running");
});

test("parent cancellation during pre-start journal I/O cannot start final_review or call the owner", async () => {
  for (const abortAt of ["read", "append"] as const) {
    const plan = readyPlan(), journal = new MemoryJournal(plan), parent = new AbortController();
    let calls = 0, reads = 0, appends = 0;
    const guardedJournal = {
      async readHistory() {
        reads += 1;
        if (abortAt === "read" && reads === 1) parent.abort();
        return journal.readHistory();
      },
      async append(value: InstallationPlanV1) {
        appends += 1;
        if (abortAt === "append" && appends === 1) parent.abort();
        return journal.append(value);
      },
    };
    await assert.rejects(runPrivateInstallationFinalReviewV1(runnerInput(plan), {
      journal: guardedJournal, signal: parent.signal, controlDeadlineMs: 1_000,
      async confirmOwnerAttached(context: PrivateInstallationFinalReviewContextV1) {
        calls += 1;
        assert.equal(context.signal.aborted, true);
        return confirmation(context);
      },
    }), /private_installation_final_review_refused/);
    assert.equal(calls, 0, `${abortAt} cancellation must precede the owner callback`);
    assert.equal(journal.history.at(-1)!.stages.at(-1)!.state, "not_started");
  }
});
