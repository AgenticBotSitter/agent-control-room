import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalInstallationWizard } from "../private-app/app/local-installation-wizard";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1,
  installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { createInstallationPlanViewV1, verifyInstallationPlanViewV1 } from "../src/installer/v1/installation-plan-view";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: string) => sha256Digest(value);
function plan() {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: d("database"),
    schedulerAuthorityDigest: d("scheduler"), currentRoutes: [], requestedRoutes: [
      { kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" },
    ] });
  return createInstallationPlanV1({ topologyPlan: topology, releaseDigest: d("release"),
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, d(`input:${stage}`)])) });
}

test("browser projection exposes only ordered stage states", () => {
  let value = plan();
  value = advanceInstallationPlanV1(value, { expectedRevision: value.revision,
    stage: "release_preflight", action: "start" });
  value = advanceInstallationPlanV1(value, { expectedRevision: value.revision,
    stage: "release_preflight", action: "pass", outcomeDigest: d("release-proof") });
  value = advanceInstallationPlanV1(value, { expectedRevision: value.revision,
    stage: "private_placement", action: "start" });
  const view = createInstallationPlanViewV1(value);
  assert.equal(view.overallState, "in_progress");
  assert.deepEqual(view.stages.slice(0, 3).map(item => item.state), ["passed", "running", "not_started"]);
  assert.doesNotMatch(JSON.stringify(view), /sha256:|revision|inputDigest|outcomeDigest|topology/i);
  assert.deepEqual(verifyInstallationPlanViewV1(view), view);

  const html = renderToStaticMarkup(createElement(LocalInstallationWizard,
    { installationPlan: view, installationPlanStatus: "available" }));
  assert.match(html, /Saved progress<\/p><h4>1\./);
  assert.doesNotMatch(html, /Recorded proof<\/p><h4>1\./);
  assert.match(html, /Still required<\/p><h4>2\./);
  assert.doesNotMatch(html, /sha256:|release-proof|input:private/);
});

test("failed or uncertain progress is attention, and a false reviewed label is refused", () => {
  let value = plan();
  value = advanceInstallationPlanV1(value, { expectedRevision: value.revision,
    stage: "release_preflight", action: "start" });
  value = advanceInstallationPlanV1(value, { expectedRevision: value.revision,
    stage: "release_preflight", action: "uncertain", outcomeDigest: d("uncertain") });
  const view = createInstallationPlanViewV1(value);
  assert.equal(view.overallState, "attention");
  const html = renderToStaticMarkup(createElement(LocalInstallationWizard,
    { installationPlan: view, installationPlanStatus: "available" }));
  assert.match(html, /Needs attention<\/p><h4>1\./);
  assert.throws(() => verifyInstallationPlanViewV1({ ...view, overallState: "reviewed" }), /invalid/);
});

test("an unavailable saved plan is explicit and never rendered as completed", () => {
  const html = renderToStaticMarkup(createElement(LocalInstallationWizard,
    { installationPlanStatus: "unavailable" }));
  assert.match(html, /Saved setup progress is unavailable/);
  assert.match(html, /No stage is treated as completed/);
  assert.doesNotMatch(html, /Recorded proof<\/p><h4>[1-9]\./);
});
