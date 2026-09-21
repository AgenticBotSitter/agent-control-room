import assert from "node:assert/strict";
import test from "node:test";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { platformServiceLifecycleOperationsV1, preparePlatformServiceLifecycleV1,
  platformServiceStageInputDigestV1, verifyPlatformServiceLifecycleV1 } from "../src/installer/v1/platform-service-lifecycle";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const topology = () => planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
  currentRoutes: [{ kind: "local", workerId: "worker:old", adapterId: "connector:old", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: "worker:new", adapterId: "connector:new", adapterRevision: "0000001" }] });
const base = { platform: "macos_launchd", serviceIdentityDigest: digest("service"),
  authorityDatabaseDigest: digest("database"), protectedDataDigest: digest("protected") };
const observation = (state: "not_installed" | "stopped" | "running" | "unknown", suffix = "old") => ({ state,
  ...(state === "stopped" || state === "running" ? { activeReleaseDigest: digest(`release:${suffix}`),
    installedServiceDefinitionDigest: digest(`definition:${suffix}`) } : {}), observationDigest: digest(`observation:${state}:${suffix}`) });
function input(selectedAction: "status" | "install" | "stop" | "start" | "update" | "uninstall",
  selectedPlatform: "macos_launchd" | "linux_systemd" = "macos_launchd") {
  const bindings = { ...base, platform: selectedPlatform, action: selectedAction,
    observation: selectedAction === "install" ? observation("not_installed") : selectedAction === "start" ? observation("stopped") : observation("running"),
  ...((selectedAction === "install" || selectedAction === "update") ? { targetReleaseDigest: digest("release:new"),
    targetServiceDefinitionDigest: digest("definition:new") } : {}),
  ...(selectedAction === "update" ? { previousVerifiedReleaseDigest: digest("release:old"),
    previousServiceDefinitionDigest: digest("definition:old") } : {}) };
  const releaseDigest = bindings.targetReleaseDigest ?? bindings.observation.activeReleaseDigest ?? digest("release:status");
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "platform_service"
    ? platformServiceStageInputDigestV1({ ...bindings, releaseDigest }) : digest(`input:${stage}`)]));
  let installationPlan = createInstallationPlanV1({ topologyPlan: topology(), releaseDigest, stageInputDigests });
  for (const stage of installationSetupStagesV1.slice(0, installationSetupStagesV1.indexOf("platform_service"))) {
    installationPlan = advanceInstallationPlanV1(installationPlan, { expectedRevision: installationPlan.revision, stage, action: "start" });
    installationPlan = advanceInstallationPlanV1(installationPlan, { expectedRevision: installationPlan.revision, stage, action: "pass",
      outcomeDigest: digest(`proof:${stage}`) });
  }
  installationPlan = advanceInstallationPlanV1(installationPlan, { expectedRevision: installationPlan.revision, stage: "platform_service", action: "start" });
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: installationPlan.planDigest, proofs: [
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: digest("custody") },
    { proof: "restricted_launch_definition", state: "passed", evidenceDigest: digest("definition") },
    { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: digest("drain") },
    { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: digest("rollback") },
  ] });
  return { ...bindings, installationPlan, supervisorReadiness };
}

test("status is read-only, redacted, deterministic, and cannot imply readiness", () => {
  const request = input("status");
  const prepared = preparePlatformServiceLifecycleV1(request);
  assert.deepEqual(prepared.steps, [{ operation: "inspect_service_status", kind: "read" }]);
  assert.equal(prepared.performsEffect, false); assert.equal(prepared.startsService, false);
  assert.equal(prepared.grantsAgentReadiness, false);
  assert.deepEqual(verifyPlatformServiceLifecycleV1(prepared, request), prepared);
  assert.doesNotMatch(JSON.stringify(prepared), /(?:\/Users\/|\/home\/|launchctl|systemctl|password|credential|token|\.plist|\.service)/i);
});

test("install and start place service start after every administrative write", () => {
  for (const action of ["install", "start"] as const) {
    const request = input(action), prepared = preparePlatformServiceLifecycleV1(request);
    const startIndex = prepared.steps.findIndex(item => item.operation === "start_service");
    const laterWrites = prepared.steps.slice(startIndex + 1).filter(item => item.kind !== "read");
    assert.ok(startIndex > 0); assert.deepEqual(laterWrites, []);
    assert.equal(prepared.steps.at(-1)?.operation, "verify_service_health");
    assert.deepEqual(platformServiceLifecycleOperationsV1(prepared, request).steps, prepared.steps);
  }
});

test("stop and uninstall always pause admission and drain for a bounded time before stopping", () => {
  for (const action of ["stop", "uninstall"] as const) {
    const prepared = preparePlatformServiceLifecycleV1(input(action));
    const names = prepared.steps.map(item => item.operation);
    assert.ok(names.indexOf("pause_admission") < names.indexOf("bounded_drain"));
    assert.ok(names.indexOf("bounded_drain") < names.indexOf("stop_service"));
    assert.equal(prepared.steps.find(item => item.operation === "bounded_drain")?.timeoutSeconds, 120);
  }
  const uninstall = preparePlatformServiceLifecycleV1(input("uninstall"));
  assert.ok(uninstall.steps.some(item => item.operation === "retain_authority_database"));
  assert.ok(uninstall.steps.some(item => item.operation === "retain_protected_data"));
  assert.equal(uninstall.preservesAuthorityDatabase, true); assert.equal(uninstall.preservesProtectedData, true);
});

test("update starts the target last and has a last-verified-release rollback", () => {
  const request = input("update"), prepared = preparePlatformServiceLifecycleV1(request);
  const primaryStart = prepared.steps.findIndex(item => item.operation === "start_service");
  assert.deepEqual(prepared.steps.slice(primaryStart + 1).filter(item => item.kind !== "read"), []);
  assert.deepEqual(prepared.rollbackSteps.map(item => item.operation), ["stop_service", "restore_verified_service_definition",
    "restore_verified_release_pointer", "start_service", "verify_service_health"]);
  const rollbackStart = prepared.rollbackSteps.findIndex(item => item.operation === "start_service");
  assert.deepEqual(prepared.rollbackSteps.slice(rollbackStart + 1).filter(item => item.kind !== "read"), []);
  assert.equal(prepared.previousVerifiedReleaseDigest, request.observation.activeReleaseDigest);
});

test("unsafe state, partial readiness, downgrade ambiguity, and retagged observations refuse", () => {
  const install = input("install");
  const incomplete = createLocalSupervisorReadinessV1({ planDigest: install.installationPlan.planDigest, proofs: [
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: digest("custody") },
  ] });
  assert.throws(() => preparePlatformServiceLifecycleV1({ ...install, supervisorReadiness: incomplete }), /refused/);
  assert.throws(() => preparePlatformServiceLifecycleV1({ ...input("stop"), observation: observation("stopped") }), /refused/);
  assert.throws(() => preparePlatformServiceLifecycleV1({ ...input("update"), previousVerifiedReleaseDigest: digest("other") }), /refused/);
  assert.throws(() => preparePlatformServiceLifecycleV1({ ...input("update"), targetReleaseDigest: digest("release:old") }), /refused/);
  const request = input("stop"), prepared = preparePlatformServiceLifecycleV1(request);
  const forgedRequest = { ...request, observation: observation("running", "changed") };
  assert.throws(() => verifyPlatformServiceLifecycleV1(prepared, forgedRequest), /refused/);
  assert.throws(() => verifyPlatformServiceLifecycleV1({ ...prepared, action: "uninstall" }, request), /refused/);
});

test("the complete installation plan must have the exact active platform-service stage", () => {
  const request = input("install"), stageInputs = Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
    request.installationPlan.stages.find(item => item.stage === stage)!.inputDigest]));
  const untouched = createInstallationPlanV1({ topologyPlan: topology(), releaseDigest: request.installationPlan.releaseDigest,
    stageInputDigests: stageInputs });
  assert.throws(() => preparePlatformServiceLifecycleV1({ ...request, installationPlan: untouched }), /refused/);
  for (const terminal of ["fail", "uncertain", "pass"] as const) {
    const terminalPlan = advanceInstallationPlanV1(request.installationPlan, { expectedRevision: request.installationPlan.revision,
      stage: "platform_service", action: terminal, outcomeDigest: digest(`outcome:${terminal}`) });
    assert.throws(() => preparePlatformServiceLifecycleV1({ ...request, installationPlan: terminalPlan,
      supervisorReadiness: createLocalSupervisorReadinessV1({ planDigest: terminalPlan.planDigest, proofs: request.supervisorReadiness.proofs }) }), /refused/);
  }
  const changed = { ...request.installationPlan, stages: request.installationPlan.stages.map(item => item.stage === "platform_service"
    ? { ...item, inputDigest: digest("wrong-stage-input") } : item) };
  assert.throws(() => preparePlatformServiceLifecycleV1({ ...request, installationPlan: changed }), /installation_plan_invalid|refused/);
});

test("a release-only update may retain the same verified service definition", () => {
  const original = input("update");
  const sameDefinitionBindings = { ...base, action: "update" as const, observation: observation("running"),
    targetReleaseDigest: digest("release:new"), targetServiceDefinitionDigest: digest("definition:old"),
    previousVerifiedReleaseDigest: digest("release:old"), previousServiceDefinitionDigest: digest("definition:old") };
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "platform_service"
    ? platformServiceStageInputDigestV1({ ...sameDefinitionBindings, releaseDigest: sameDefinitionBindings.targetReleaseDigest }) : digest(`input:${stage}`)]));
  let plan = createInstallationPlanV1({ topologyPlan: topology(), releaseDigest: sameDefinitionBindings.targetReleaseDigest, stageInputDigests });
  for (const stage of installationSetupStagesV1.slice(0, installationSetupStagesV1.indexOf("platform_service"))) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest: digest(`proof:${stage}`) });
  }
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "platform_service", action: "start" });
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: plan.planDigest, proofs: original.supervisorReadiness.proofs });
  assert.equal(preparePlatformServiceLifecycleV1({ ...sameDefinitionBindings, installationPlan: plan,
    supervisorReadiness }).targetServiceDefinitionDigest, sameDefinitionBindings.previousServiceDefinitionDigest);
});

test("both supported service managers produce the same authority-neutral lifecycle", () => {
  const mac = preparePlatformServiceLifecycleV1(input("update"));
  const linuxRequest = input("update", "linux_systemd");
  const linux = preparePlatformServiceLifecycleV1(linuxRequest);
  assert.deepEqual(mac.steps, linux.steps); assert.deepEqual(mac.rollbackSteps, linux.rollbackSteps);
  assert.notEqual(mac.lifecycleDigest, linux.lifecycleDigest);
});
