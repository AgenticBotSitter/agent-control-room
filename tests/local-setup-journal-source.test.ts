import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { createLocalSetupJournalSourceV1, LOCAL_SETUP_JOURNAL_SOURCE_V1 } from "../src/installer/v1/local-setup-journal-source";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
  currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }] });
const plan = () => createInstallationPlanV1({ topologyPlan: topology, releaseDigest: digest("release"),
  stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, digest(`input:${stage}`)])) });

function reader(history: readonly InstallationPlanV1[] | Error) {
  let calls = 0;
  const journal: Pick<InstallationPlanFilesystemJournalV1, "inspectSettledHistory"> = {
    async inspectSettledHistory() {
      calls += 1;
      if (history instanceof Error) throw history;
      return history;
    },
  };
  return { source: createLocalSetupJournalSourceV1(journal), calls: () => calls };
}

test("reads the newest canonical revision on every request and projects only browser-safe progress", async () => {
  const initial = plan();
  const running = advanceInstallationPlanV1(initial, { expectedRevision: initial.revision,
    stage: "release_preflight", action: "start" });
  let history: readonly InstallationPlanV1[] = [initial];
  const journal: Pick<InstallationPlanFilesystemJournalV1, "inspectSettledHistory"> = { async inspectSettledHistory() { return history; } };
  const source = createLocalSetupJournalSourceV1(journal);

  assert.deepEqual(await source.read(), {
    schema: LOCAL_SETUP_JOURNAL_SOURCE_V1, status: "available", plan: {
      schema: "control-room.installation-plan-view/v1", overallState: "in_progress", stages: installationSetupStagesV1.map(stage => ({ stage, state: "not_started" })),
      performsEffect: false, exposesPrivateValues: false,
    }, restart: "ready_to_begin", performsEffect: false, permitsRetry: false,
  });

  history = [initial, running];
  const current = await source.read();
  assert.equal(current.status, "available");
  if (current.status !== "available") throw new Error("expected_available");
  assert.equal(current.plan.stages[0]!.state, "running");
  assert.equal(current.restart, "inspect");
  assert.doesNotMatch(JSON.stringify(current), /sha256:|revision|inputDigest|outcomeDigest|planDigest|topologyPlanDigest/i);
});

test("empty, corrupt, and unavailable journals fail closed without exposing the failure", async () => {
  const empty = reader([]);
  assert.deepEqual(await empty.source.read(), {
    schema: LOCAL_SETUP_JOURNAL_SOURCE_V1, status: "unavailable", performsEffect: false, permitsRetry: false,
  });
  assert.equal(empty.calls(), 1);

  const corrupt = reader([{} as InstallationPlanV1]);
  assert.deepEqual(await corrupt.source.read(), {
    schema: LOCAL_SETUP_JOURNAL_SOURCE_V1, status: "unavailable", performsEffect: false, permitsRetry: false,
  });
  assert.equal(corrupt.calls(), 1);

  const unavailable = reader(new Error("installation_plan_journal_unavailable: /private/owner/setup"));
  assert.deepEqual(await unavailable.source.read(), {
    schema: LOCAL_SETUP_JOURNAL_SOURCE_V1, status: "unavailable", performsEffect: false, permitsRetry: false,
  });
  assert.equal(unavailable.calls(), 1);
});

test("running, uncertain, and failed stages only report a non-retry category", async () => {
  const initial = plan();
  const running = advanceInstallationPlanV1(initial, { expectedRevision: 0, stage: "release_preflight", action: "start" });
  const uncertain = advanceInstallationPlanV1(running, { expectedRevision: 1, stage: "release_preflight", action: "uncertain",
    outcomeDigest: digest("uncertain") });
  const failed = advanceInstallationPlanV1(running, { expectedRevision: 1, stage: "release_preflight", action: "fail",
    outcomeDigest: digest("failed") });

  for (const [value, restart] of [[running, "inspect"], [uncertain, "inspect"], [failed, "owner_attention"]] as const) {
    const result = await reader([value]).source.read();
    assert.equal(result.status, "available");
    if (result.status !== "available") throw new Error("expected_available");
    assert.equal(result.restart, restart);
    assert.equal(result.permitsRetry, false);
    assert.equal(result.performsEffect, false);
    assert.equal(Object.isFrozen(result), true);
  }
});
