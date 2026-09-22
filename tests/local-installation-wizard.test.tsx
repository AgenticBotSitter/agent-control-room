import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalInstallationWizard } from "../private-app/app/local-installation-wizard";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createInstallationSetupViewV1 } from "../src/harness/v1/installation-setup-view";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { createInstallationPlanViewV1 } from "../src/installer/v1/installation-plan-view";
import { sha256Digest } from "../src/security/canonical-digest";

function localSetup() {
  const plan = planInstallationTopologyV1({
    databaseAuthorityDigest: sha256Digest("wizard-database"),
    schedulerAuthorityDigest: sha256Digest("wizard-scheduler"),
    currentRoutes: [{ kind: "local" as const, workerId: "worker:private-wizard", adapterId: "connector:hermes", adapterRevision: "revision-1" }],
    requestedRoutes: [{ kind: "local" as const, workerId: "worker:private-wizard", adapterId: "connector:hermes", adapterRevision: "revision-1" }],
  });
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "not_started" },
    { proof: "local_owner_qualification", state: "not_started" },
    { proof: "local_runner_bridge", state: "passed", evidenceDigest: sha256Digest("runner-proof") },
  ] });
  return createInstallationSetupViewV1({ plan, readiness, localBackupRestoreVerified: false });
}

function restartPlan(state: "ready_to_begin" | "inspect" | "owner_attention" | "complete") {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest(`restart-database:${state}`),
    schedulerAuthorityDigest: sha256Digest(`restart-scheduler:${state}`), currentRoutes: [], requestedRoutes: [] });
  let plan: InstallationPlanV1 = createInstallationPlanV1({ topologyPlan: topology,
    releaseDigest: sha256Digest(`restart-release:${state}`), stageInputDigests: Object.fromEntries(
      installationSetupStagesV1.map(stage => [stage, sha256Digest(`restart:${state}:${stage}`)])) });
  if (state === "inspect" || state === "owner_attention") {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "release_preflight", action: "start" });
    if (state === "owner_attention") plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision,
      stage: "release_preflight", action: "fail", outcomeDigest: sha256Digest("restart-failed") });
  } else if (state === "complete") {
    for (const stage of installationSetupStagesV1) {
      plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
      plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass",
        outcomeDigest: sha256Digest(`restart-passed:${stage}`) });
    }
  }
  return createInstallationPlanViewV1(plan);
}

test("first-run wizard labels the unfinished release journey as a source-only preview", () => {
  const html = renderToStaticMarkup(createElement(LocalInstallationWizard, { setup: localSetup(), status: "available" }));
  assert.match(html, /source-only preview/);
  assert.match(html, /public release asset and launcher are not available yet/);
  assert.match(html, /When the supported package is published/);
  assert.match(html, /3\. Prepare the authority database/);
  assert.match(html, /4\. Prepare protected data/);
  assert.match(html, /5\. Prepare owner access/);
  assert.match(html, /6\. Prove recovery/);
  assert.match(html, /7\. Prepare the background service/);
  assert.match(html, /8\. Connect workers/);
  assert.match(html, /9\. Review and enable/);
  assert.match(html, /This computer — selected/);
  assert.match(html, /Several computers/);
  assert.match(html, /same database, scheduler, tasks, results, reviews and corrections/);
  assert.match(html, /do not receive a second controller or a synchronized copy/);
});

test("first-run wizard names remaining redacted proof categories and never claims an agent is live", () => {
  const html = renderToStaticMarkup(createElement(LocalInstallationWizard, { setup: localSetup(), status: "available" }));
  assert.match(html, /Remaining categories visible in saved setup status/);
  assert.match(html, /Verified backup and disposable restore/);
  assert.match(html, /Owner-attended local worker qualification/);
  assert.match(html, /Hermes Agent: Remaining local setup proof/);
  assert.match(html, /Claude Code: Installed-process and permission qualification/);
  assert.match(html, /Codex: macOS process and private-state custody qualification/);
  assert.doesNotMatch(html, /worker:private-wizard|sha256:|running now|connected now/);
});

test("first-run wizard requires both local worker proofs before recording connection", () => {
  const html = renderToStaticMarkup(createElement(LocalInstallationWizard, { setup: localSetup(), status: "available" }));
  assert.match(html, /Still required<\/p><h4>8\. Connect workers/);
});

test("first-run wizard requires both remote worker proofs before recording connection", () => {
  const plan = planInstallationTopologyV1({
    databaseAuthorityDigest: sha256Digest("wizard-remote-database"),
    schedulerAuthorityDigest: sha256Digest("wizard-remote-scheduler"),
    currentRoutes: [],
    requestedRoutes: [{ kind: "remote" as const, workerId: "worker:remote-wizard", adapterId: "connector:hermes", adapterRevision: "revision-1" }],
  });
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("remote-backup") },
    { proof: "remote_enrollment", state: "passed", evidenceDigest: sha256Digest("remote-enrollment") },
    { proof: "two_computer_delivery", state: "not_started" },
  ] });
  const setup = createInstallationSetupViewV1({ plan, readiness, localBackupRestoreVerified: true });
  const html = renderToStaticMarkup(createElement(LocalInstallationWizard, { setup, status: "available" }));
  assert.match(html, /Still required<\/p><h4>8\. Connect workers/);
});

test("first-run wizard never marks final activation complete from topology proof alone", () => {
  const plan = planInstallationTopologyV1({
    databaseAuthorityDigest: sha256Digest("wizard-ready-database"),
    schedulerAuthorityDigest: sha256Digest("wizard-ready-scheduler"),
    currentRoutes: [],
    requestedRoutes: [{ kind: "local" as const, workerId: "worker:ready-wizard", adapterId: "connector:hermes", adapterRevision: "revision-1" }],
  });
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("ready-backup") },
    { proof: "local_owner_qualification", state: "passed", evidenceDigest: sha256Digest("ready-owner") },
    { proof: "local_runner_bridge", state: "passed", evidenceDigest: sha256Digest("ready-runner") },
  ] });
  const localSupervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: plan.planDigest, proofs: [] });
  const setup = createInstallationSetupViewV1({ plan, readiness, localBackupRestoreVerified: true, localSupervisorReadiness });
  assert.equal(setup.overallState, "ready_for_owner_enablement");
  const html = renderToStaticMarkup(createElement(LocalInstallationWizard, { setup, status: "available" }));
  assert.match(html, /Still required<\/p><h4>9\. Review and enable/);
  assert.match(html, /does not claim installation readiness/);
  assert.match(html, /release-authenticity/);
});

test("first-run wizard is read-only and reserves all effects for installation-owned actions", () => {
  const html = renderToStaticMarkup(createElement(LocalInstallationWizard, { setup: localSetup(), status: "available" }));
  assert.match(html, /No installation effects happen from this read-only view/);
  assert.match(html, /separately reviewed installation-owned actions/);
  assert.match(html, /cannot accept a password, signing key, executable path, private path, or command/);
  assert.match(html, /Enabling the controller and selected workers is a separate owner decision/);
  assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea/);
});

test("first-run wizard renders bounded read-only restart guidance without implying live services", () => {
  const cases = [
    ["ready_to_begin", /No interrupted or failed setup work is recorded/],
    ["inspect", /Saved setup work requires inspection/],
    ["owner_attention", /Saved setup work requires owner attention/],
    ["complete", /progress record only; it does not show that a service or worker is running/],
  ] as const;
  for (const [restart, message] of cases) {
    const html = renderToStaticMarkup(createElement(LocalInstallationWizard, { installationPlan: restartPlan(restart),
      installationPlanStatus: "available", installationPlanRestart: restart }));
    assert.match(html, /Read-only recovery guidance/);
    assert.match(html, message);
    assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea/);
  }
});

test("first-run wizard refuses missing or contradictory restart guidance", () => {
  const plan = restartPlan("ready_to_begin");
  for (const installationPlanRestart of [undefined, "inspect"] as const) {
    const html = renderToStaticMarkup(createElement(LocalInstallationWizard, { installationPlan: plan,
      installationPlanStatus: "available", installationPlanRestart }));
    assert.match(html, /Safe recovery guidance is unavailable/);
    assert.doesNotMatch(html, /No interrupted or failed setup work is recorded/);
  }
});

test("first-run wizard treats unavailable saved proof as unknown, never ready", () => {
  const html = renderToStaticMarkup(createElement(LocalInstallationWizard, { status: "unavailable" }));
  assert.match(html, /Saved setup proof is unavailable/);
  assert.match(html, /Nothing is treated as installed, ready, or running/);
  assert.match(html, /No reviewed placement choice is recorded yet/);
  assert.match(html, /does not guess from this browser/);
  assert.doesNotMatch(html, /— selected/);
});
