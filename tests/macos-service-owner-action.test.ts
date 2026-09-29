import assert from "node:assert/strict";
import test from "node:test";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { createMacosLocalServicePackageV1 } from "../src/harness/v1/macos-local-service-package";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1,
  installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { macosServiceIdentityDigestV1, simulateMacosServiceOwnerActionV1,
  type MacosServiceRunnerRequestV1 } from "../src/installer/v1/macos-service-owner-action";
import { platformServiceStageInputDigestV1,
  preparePlatformServiceLifecycleV1 } from "../src/installer/v1/platform-service-lifecycle";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const packageInput = (release: string) => ({ label: "xyz.agentcontrolroom.local",
  nodePath: "/opt/node/bin/node", launcherPath: `/opt/control-room/${release}/run.mjs`,
  configurationPath: "/opt/control-room/protected/config.mjs", workingDirectory: `/opt/control-room/${release}`,
  standardOutPath: "/opt/control-room/protected/service.out.log",
  standardErrorPath: "/opt/control-room/protected/service.err.log" });
const renderedDigest = (value: ReturnType<typeof packageInput>) => sha256Digest(createMacosLocalServicePackageV1(value).plist);

function prepared(action: "install" | "update") {
  const currentPackage = packageInput("new");
  const previousPackage = packageInput("old");
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"),
    schedulerAuthorityDigest: digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:old", adapterId: "connector:old", adapterRevision: "0000001" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:new", adapterId: "connector:new", adapterRevision: "0000001" }] });
  const observation = action === "install"
    ? { state: "not_installed" as const, observationDigest: digest("not-installed") }
    : { state: "running" as const, activeReleaseDigest: digest("release:old"),
      installedServiceDefinitionDigest: renderedDigest(previousPackage), observationDigest: digest("running-old") };
  const bindings = { action, platform: "macos_launchd" as const,
    serviceIdentityDigest: macosServiceIdentityDigestV1(currentPackage),
    authorityDatabaseDigest: digest("database"), protectedDataDigest: digest("protected"), observation,
    targetReleaseDigest: digest("release:new"), targetServiceDefinitionDigest: renderedDigest(currentPackage),
    ...(action === "update" ? { previousVerifiedReleaseDigest: digest("release:old"),
      previousServiceDefinitionDigest: renderedDigest(previousPackage) } : {}) };
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
    stage === "platform_service" ? platformServiceStageInputDigestV1({ ...bindings, releaseDigest: digest("release:new") })
      : digest(`input:${stage}`)]));
  let installationPlan = createInstallationPlanV1({ topologyPlan: topology,
    releaseDigest: digest("release:new"), stageInputDigests });
  for (const stage of installationSetupStagesV1.slice(0, installationSetupStagesV1.indexOf("platform_service"))) {
    installationPlan = advanceInstallationPlanV1(installationPlan,
      { expectedRevision: installationPlan.revision, stage, action: "start" });
    installationPlan = advanceInstallationPlanV1(installationPlan,
      { expectedRevision: installationPlan.revision, stage, action: "pass", outcomeDigest: digest(`proof:${stage}`) });
  }
  installationPlan = advanceInstallationPlanV1(installationPlan,
    { expectedRevision: installationPlan.revision, stage: "platform_service", action: "start" });
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: installationPlan.planDigest, proofs: [
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: digest("custody") },
    { proof: "restricted_launch_definition", state: "passed", evidenceDigest: digest("definition") },
    { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: digest("drain") },
    { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: digest("rollback") },
  ] });
  const lifecycleInput = { ...bindings, installationPlan, supervisorReadiness };
  return { lifecycleInput, lifecycle: preparePlatformServiceLifecycleV1(lifecycleInput),
    currentPackage, previousPackage };
}

test("simulation reuses the lifecycle order and rendered definition through only an injected fake runner", async () => {
  const fixture = prepared("install");
  const calls: MacosServiceRunnerRequestV1[] = [];
  const report = await simulateMacosServiceOwnerActionV1({ ownerAuthorized: true, lifecycle: fixture.lifecycle,
    lifecycleInput: fixture.lifecycleInput, servicePackageInput: fixture.currentPackage }, { runner: async request => {
      calls.push(request); return { outcome: "succeeded" };
    } });
  assert.equal(report.outcome, "completed");
  assert.deepEqual(calls.map(call => call.operation), fixture.lifecycle.steps.map(step => step.operation));
  assert.equal(calls.find(call => call.operation === "install_service_definition")?.serviceDefinition?.plist,
    createMacosLocalServicePackageV1(fixture.currentPackage).plist);
  assert.ok(calls.every(call => call.timeoutSeconds > 0 && call.timeoutSeconds <= 120));
  assert.equal(report.persistedState, false);
  assert.equal(report.simulationOnly, true); assert.equal(report.ownerApprovalRecordBound, false);
  assert.equal(report.durableReplayProtected, false);
  assert.equal(report.grantsAgentReadiness, false);
  assert.doesNotMatch(JSON.stringify(calls), /launchctl|bootstrap|bootout/u);
});

test("a known failed update after stop follows the existing rollback plan to the previous rendered definition", async () => {
  const fixture = prepared("update");
  const calls: MacosServiceRunnerRequestV1[] = [];
  const report = await simulateMacosServiceOwnerActionV1({ ownerAuthorized: true, lifecycle: fixture.lifecycle,
    lifecycleInput: fixture.lifecycleInput, servicePackageInput: fixture.currentPackage,
    previousServicePackageInput: fixture.previousPackage }, { runner: async request => {
      calls.push(request);
      return { outcome: request.phase === "primary" && request.operation === "switch_release_pointer" ? "failed" : "succeeded" };
    } });
  assert.equal(report.outcome, "rolled_back");
  assert.deepEqual(calls.filter(call => call.phase === "rollback").map(call => call.operation),
    fixture.lifecycle.rollbackSteps.map(step => step.operation));
  const restored = calls.find(call => call.operation === "restore_verified_service_definition");
  assert.equal(restored?.serviceDefinition?.plist, createMacosLocalServicePackageV1(fixture.previousPackage).plist);
  assert.equal(calls.at(-1)?.operation, "verify_service_health");
});

test("authorization, planner verification, renderer binding and uncertainty all fail closed", async () => {
  const fixture = prepared("update");
  const never = async () => { assert.fail("runner must not be called"); return { outcome: "succeeded" as const }; };
  await assert.rejects(simulateMacosServiceOwnerActionV1({ ownerAuthorized: false as true, lifecycle: fixture.lifecycle,
    lifecycleInput: fixture.lifecycleInput, servicePackageInput: fixture.currentPackage,
    previousServicePackageInput: fixture.previousPackage }, { runner: never }), /refused/);
  await assert.rejects(simulateMacosServiceOwnerActionV1({ ownerAuthorized: true,
    lifecycle: { ...fixture.lifecycle, action: "stop" }, lifecycleInput: fixture.lifecycleInput,
    servicePackageInput: fixture.currentPackage, previousServicePackageInput: fixture.previousPackage }, { runner: never }), /refused/);
  await assert.rejects(simulateMacosServiceOwnerActionV1({ ownerAuthorized: true, lifecycle: fixture.lifecycle,
    lifecycleInput: fixture.lifecycleInput, servicePackageInput: packageInput("changed"),
    previousServicePackageInput: fixture.previousPackage }, { runner: never }), /refused/);

  const calls: MacosServiceRunnerRequestV1[] = [];
  const uncertain = await simulateMacosServiceOwnerActionV1({ ownerAuthorized: true, lifecycle: fixture.lifecycle,
    lifecycleInput: fixture.lifecycleInput, servicePackageInput: fixture.currentPackage,
    previousServicePackageInput: fixture.previousPackage }, { runner: async request => {
      calls.push(request);
      if (request.operation === "install_service_definition") throw new Error("lost reply");
      return { outcome: "succeeded" };
    } });
  assert.equal(uncertain.outcome, "uncertain");
  assert.equal(calls.some(call => call.phase === "rollback"), false);
});

test("malformed lifecycle and service inputs collapse to one refusal before the runner", async () => {
  const fixture = prepared("install"), markers = ["privateLifecycleMarker", "privateServiceMarker"];
  let calls = 0;
  const runner = async () => { calls++; return { outcome: "succeeded" as const }; };
  for (const [lifecycle, servicePackageInput] of [
    [{ ...fixture.lifecycle, [markers[0]!]: "/private/owner/secret" }, fixture.currentPackage],
    [fixture.lifecycle, { ...fixture.currentPackage, [markers[1]!]: "/private/owner/secret" }],
  ] as const) {
    let caught: unknown;
    try { await simulateMacosServiceOwnerActionV1({ ownerAuthorized: true, lifecycle,
      lifecycleInput: fixture.lifecycleInput, servicePackageInput }, { runner }); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof Error); assert.equal(caught.message, "macos_service_owner_action_refused");
    for (const marker of markers) assert.doesNotMatch(caught.message, new RegExp(marker, "i"));
  }
  assert.equal(calls, 0);
});
