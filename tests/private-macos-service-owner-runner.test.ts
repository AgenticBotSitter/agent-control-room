import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { createMacosLocalServicePackageV1 } from "../src/harness/v1/macos-local-service-package";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1,
  installationSetupStagesV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { INSTALLATION_PLAN_JOURNAL_V1 } from "../src/installer/v1/installation-plan-journal";
import { macosServiceIdentityDigestV1 } from "../src/installer/v1/macos-service-owner-action";
import { PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1, PRIVATE_MACOS_SERVICE_LABEL_V1,
  PRIVATE_MACOS_SERVICE_OWNER_ATTACHED_TERMINAL_V1, PRIVATE_MACOS_SERVICE_TOOL_V1,
  confirmPrivateMacosServiceOwnerActionTerminalV1, runPrivateMacosServiceOwnerActionV1,
  type PrivateMacosServiceOwnerRuntimeV1, type PrivateMacosServiceToolRequestV1 } from
  "../src/installer/v1/private-macos-service-owner-runner";
import { platformServiceStageInputDigestV1,
  preparePlatformServiceLifecycleV1 } from "../src/installer/v1/platform-service-lifecycle";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: unknown) => sha256Digest(value);
const servicePackageInput = Object.freeze({ label: PRIVATE_MACOS_SERVICE_LABEL_V1,
  nodePath: "/reviewed/node/bin/node", launcherPath: "/reviewed/releases/v1/run.mjs",
  configurationPath: "/reviewed/protected/config.mjs", workingDirectory: "/reviewed/releases/v1",
  standardOutPath: "/reviewed/protected/service.out.log",
  standardErrorPath: "/reviewed/protected/service.err.log" });

function prepared() {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"),
    schedulerAuthorityDigest: digest("scheduler"), currentRoutes: [], requestedRoutes: [] });
  const package_ = createMacosLocalServicePackageV1(servicePackageInput);
  const bindings = { action: "install" as const, platform: "macos_launchd" as const,
    serviceIdentityDigest: macosServiceIdentityDigestV1(servicePackageInput),
    authorityDatabaseDigest: digest("database-authority"), protectedDataDigest: digest("protected-data"),
    observation: { state: "not_installed" as const, observationDigest: digest("not-installed") },
    targetReleaseDigest: digest("release"), targetServiceDefinitionDigest: digest(package_.plist) };
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
    stage === "platform_service" ? platformServiceStageInputDigestV1({ ...bindings, releaseDigest: digest("release") })
      : digest(`input:${stage}`)]));
  let installationPlan = createInstallationPlanV1({ topologyPlan: topology,
    releaseDigest: digest("release"), stageInputDigests });
  const history: InstallationPlanV1[] = [installationPlan];
  for (const name of installationSetupStagesV1.slice(0, installationSetupStagesV1.indexOf("platform_service"))) {
    installationPlan = advanceInstallationPlanV1(installationPlan,
      { expectedRevision: installationPlan.revision, stage: name, action: "start" });
    history.push(installationPlan);
    installationPlan = advanceInstallationPlanV1(installationPlan,
      { expectedRevision: installationPlan.revision, stage: name, action: "pass", outcomeDigest: digest(`proof:${name}`) });
    history.push(installationPlan);
  }
  installationPlan = advanceInstallationPlanV1(installationPlan,
    { expectedRevision: installationPlan.revision, stage: "platform_service", action: "start" });
  history.push(installationPlan);
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: installationPlan.planDigest, proofs: [
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: digest("custody") },
    { proof: "restricted_launch_definition", state: "passed", evidenceDigest: digest("definition") },
    { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: digest("drain") },
    { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: digest("rollback") },
  ] });
  const lifecycleInput = { ...bindings, installationPlan, supervisorReadiness };
  const lifecycle = preparePlatformServiceLifecycleV1(lifecycleInput);
  return { request: { lifecycle, lifecycleInput, servicePackageInput }, lifecycle, lifecycleInput,
    installationPlan, history, package_ };
}

function runtimeFor(f: ReturnType<typeof prepared>, overrides: Partial<PrivateMacosServiceOwnerRuntimeV1> = {}) {
  const calls: string[] = [];
  const controller = new AbortController();
  const runtime: PrivateMacosServiceOwnerRuntimeV1 = {
    signal: controller.signal, controlDeadlineMs: 200, cleanupDeadlineMs: 100,
    reviewedServicePackageInput: servicePackageInput,
    async confirmOwnerAttachedTerminal(context) {
      calls.push("owner");
      return { schema: PRIVATE_MACOS_SERVICE_OWNER_ATTACHED_TERMINAL_V1,
        requestDigest: context.requestDigest, lifecycleDigest: context.lifecycleDigest,
        action: "install", ownerAttached: true, confirmed: true };
    },
    tool: {
      schema: PRIVATE_MACOS_SERVICE_TOOL_V1,
      async executeStep(request) { calls.push(request.step.operation); return { outcome: "succeeded" }; },
      async observeFinal(request) {
        calls.push("observe");
        return { schema: PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1, requestDigest: request.requestDigest,
          lifecycleDigest: request.lifecycleDigest, installedServiceDefinitionDigest: request.expectedServiceDefinitionDigest,
          serviceObservation: { state: "running", topologyPlanDigest: f.installationPlan.topologyPlanDigest,
            releaseDigest: request.expectedReleaseDigest, serviceIdentityDigest: request.expectedServiceIdentityDigest,
            databaseAuthorityDigest: f.lifecycle.authorityDatabaseDigest,
            protectedDataBindingDigest: f.lifecycle.protectedDataDigest,
            supervisorReadinessDigest: f.lifecycle.supervisorReadinessDigest,
            observationDigest: digest("running-observation") } };
      },
      async cleanup() { calls.push("cleanup"); return { outcome: "confirmed" }; },
    },
    ...overrides,
  };
  return { runtime, calls, controller };
}

function journal(initial: readonly InstallationPlanV1[]) {
  const history: InstallationPlanV1[] = [...initial];
  return { history, journal: {
    async readHistory() { return Object.freeze([...history]); },
    async append(plan: InstallationPlanV1) {
      const existing = history[plan.revision];
      if (existing) {
        if (existing.planDigest !== plan.planDigest) throw new Error("conflict");
        return { schema: INSTALLATION_PLAN_JOURNAL_V1, installationId: "install-local", revision: plan.revision,
          planDigest: plan.planDigest, replayed: true, enablesAuthority: false, startsService: false, startsWorker: false } as const;
      }
      if (plan.revision !== history.length) throw new Error("gap");
      history.push(plan);
      return { schema: INSTALLATION_PLAN_JOURNAL_V1, installationId: "install-local", revision: plan.revision,
        planDigest: plan.planDigest, replayed: false, enablesAuthority: false, startsService: false, startsWorker: false } as const;
    },
  } };
}

test("runs the exact existing install sequence and settles one terminal journal receipt", async () => {
  const f = prepared(), r = runtimeFor(f);
  const result = await runPrivateMacosServiceOwnerActionV1(f.request, r.runtime);
  assert.deepEqual(r.calls, ["owner", ...f.lifecycle.steps.map(step => step.operation), "observe", "cleanup"]);
  assert.equal(result.grantsAgentReadiness, false);
  assert.equal(result.terminalConfirmation.serviceState, "running");
  assert.doesNotMatch(JSON.stringify(result), /\/reviewed\/|\.plist|launchctl|password|credential/u);

  const saved = journal(f.history);
  const settled = await confirmPrivateMacosServiceOwnerActionTerminalV1({ installationId: "install-local",
    request: f.request, terminalConfirmation: result.terminalConfirmation }, { journal: saved.journal });
  assert.equal(settled.replayed, false); assert.equal(saved.history.length, f.installationPlan.revision + 2);
  assert.equal(saved.history.at(-1)?.stages.find(stage => stage.stage === "platform_service")?.outcomeDigest,
    settled.receipt.receiptDigest);
  const replay = await confirmPrivateMacosServiceOwnerActionTerminalV1({ installationId: "install-local",
    request: f.request, terminalConfirmation: result.terminalConfirmation }, { journal: saved.journal });
  assert.equal(replay.replayed, true); assert.equal(saved.history.length, f.installationPlan.revision + 2);
});

test("the process port receives only fixed structured requests and the reviewed rendered definition", async () => {
  const f = prepared(), requests: PrivateMacosServiceToolRequestV1[] = [];
  const base = runtimeFor(f);
  const runtime = { ...base.runtime, tool: { ...base.runtime.tool,
    async executeStep(request: PrivateMacosServiceToolRequestV1) { requests.push(request); return { outcome: "succeeded" as const }; } } };
  await runPrivateMacosServiceOwnerActionV1(f.request, runtime);
  assert.deepEqual(requests.map(item => item.step.operation), f.lifecycle.steps.map(item => item.operation));
  assert.ok(requests.every(item => item.schema === PRIVATE_MACOS_SERVICE_TOOL_V1
    && item.step.label === PRIVATE_MACOS_SERVICE_LABEL_V1 && item.deadlineUnixMs > Date.now()));
  const install = requests.find(item => item.step.operation === "install_service_definition");
  assert.equal(install?.step.serviceDefinition?.plist, f.package_.plist);
  assert.doesNotMatch(JSON.stringify(requests), /launchctl|bootstrap|bootout|EnvironmentVariables/u);
});

test("wrong label, changed release, extra inputs and non-install actions refuse before owner or tool entry", async () => {
  const f = prepared();
  for (const changed of [
    { ...f.request, servicePackageInput: { ...servicePackageInput, label: "xyz.agentcontrolroom.changed" } },
    { ...f.request, servicePackageInput: { ...servicePackageInput, launcherPath: "/reviewed/releases/other/run.mjs" } },
    { ...f.request, privateCommand: "launchctl bootstrap" },
    { ...f.request, lifecycle: { ...f.lifecycle, action: "status" } },
  ]) {
    const r = runtimeFor(f);
    await assert.rejects(runPrivateMacosServiceOwnerActionV1(changed, r.runtime), /private_macos_service_owner_runner_refused/u);
    assert.deepEqual(r.calls, []);
  }
});

test("the request cannot substitute paths outside the private reviewed package binding", async () => {
  const f = prepared(), r = runtimeFor(f);
  const changed = { ...f.request, servicePackageInput: { ...servicePackageInput,
    standardOutPath: "/tmp/caller-chosen.log" } };
  await assert.rejects(runPrivateMacosServiceOwnerActionV1(changed, r.runtime), /_refused/u);
  assert.deepEqual(r.calls, []);
});

test("owner confirmation is exact and mutable caller port objects cannot replace captured methods", async () => {
  const f = prepared(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const r = runtimeFor(f, { async confirmOwnerAttachedTerminal(context) {
    entered(); await gate;
    return { schema: PRIVATE_MACOS_SERVICE_OWNER_ATTACHED_TERMINAL_V1, requestDigest: context.requestDigest,
      lifecycleDigest: context.lifecycleDigest, action: "install", ownerAttached: true, confirmed: true };
  } });
  let original = 0, replacement = 0;
  const mutableTool = r.runtime.tool as unknown as {
    executeStep: PrivateMacosServiceOwnerRuntimeV1["tool"]["executeStep"];
  };
  mutableTool.executeStep = async () => { original++; return { outcome: "succeeded" }; };
  const pending = runPrivateMacosServiceOwnerActionV1(f.request, r.runtime);
  await waiting;
  mutableTool.executeStep = async () => { replacement++; return { outcome: "succeeded" }; };
  release(); await pending;
  assert.equal(original, f.lifecycle.steps.length); assert.equal(replacement, 0);

  const bad = runtimeFor(f, { async confirmOwnerAttachedTerminal(context) {
    return { schema: PRIVATE_MACOS_SERVICE_OWNER_ATTACHED_TERMINAL_V1,
      requestDigest: digest(context.requestDigest), lifecycleDigest: context.lifecycleDigest,
      action: "install", ownerAttached: true, confirmed: true };
  } });
  await assert.rejects(runPrivateMacosServiceOwnerActionV1(f.request, bad.runtime), /refused/u);
  assert.equal(bad.calls.includes("install_service_definition"), false);
});

test("strict replies distinguish pre-effect refusal from post-start uncertainty", async () => {
  {
    const f = prepared(), r = runtimeFor(f);
    const runtime = { ...r.runtime, tool: { ...r.runtime.tool,
      async executeStep() { return { outcome: "failed_before_effect" as const }; } } };
    await assert.rejects(runPrivateMacosServiceOwnerActionV1(f.request, runtime), /_refused/u);
    assert.equal(r.calls.at(-1), "cleanup");
  }
  for (const mode of ["malformed", "throw-after-start", "bad-observation", "cleanup"] as const) {
    const f = prepared(), r = runtimeFor(f);
    const runtime = { ...r.runtime, tool: { ...r.runtime.tool,
      async executeStep(request: PrivateMacosServiceToolRequestV1) {
        if (mode === "malformed" && request.step.operation === "install_service_definition") return { outcome: "maybe" } as never;
        if (mode === "throw-after-start" && request.step.operation === "verify_service_health") throw new Error("private path");
        return { outcome: "succeeded" as const };
      },
      async observeFinal(request: Parameters<typeof r.runtime.tool.observeFinal>[0], signal: AbortSignal) {
        const value = await r.runtime.tool.observeFinal(request, signal);
        return mode === "bad-observation" ? { ...(value as object), installedServiceDefinitionDigest: digest("changed") } : value;
      },
      async cleanup(signal: AbortSignal) {
        if (mode === "cleanup") throw new Error("private cleanup detail");
        return r.runtime.tool.cleanup(signal);
      },
    } };
    let caught: unknown;
    try { await runPrivateMacosServiceOwnerActionV1(f.request, runtime); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error); assert.equal(caught.message, "private_macos_service_owner_runner_uncertain");
    assert.equal(caught.stack, undefined); assert.doesNotMatch(String(caught), /private path|cleanup detail/u);
  }
});

test("abort and deadline after entry are uncertainty and cannot yield terminal evidence", async () => {
  {
    const f = prepared(), r = runtimeFor(f); r.controller.abort();
    await assert.rejects(runPrivateMacosServiceOwnerActionV1(f.request, r.runtime), /_refused/u);
    assert.deepEqual(r.calls, []);
  }
  {
    const f = prepared(), r = runtimeFor(f);
    const runtime = { ...r.runtime, controlDeadlineMs: 15, tool: { ...r.runtime.tool,
      async executeStep(request: PrivateMacosServiceToolRequestV1) {
        if (request.step.operation === "install_service_definition") return new Promise<never>(() => {});
        return { outcome: "succeeded" as const };
      } } };
    await assert.rejects(runPrivateMacosServiceOwnerActionV1(f.request, runtime), /_uncertain/u);
    assert.equal(r.calls.at(-1), "cleanup");
  }
});

test("terminal settlement refuses changed binding, stale history and another installation identity", async () => {
  const f = prepared(), r = runtimeFor(f);
  const result = await runPrivateMacosServiceOwnerActionV1(f.request, r.runtime);
  for (const changed of [
    { ...result.terminalConfirmation, requestDigest: digest("changed") },
    { ...result.terminalConfirmation, serviceState: "stopped" },
  ]) {
    const saved = journal(f.history);
    await assert.rejects(confirmPrivateMacosServiceOwnerActionTerminalV1({ installationId: "install-local",
      request: f.request, terminalConfirmation: changed }, { journal: saved.journal }), /_refused/u);
  }
  const wrong = journal(f.history);
  const wrongJournal = { ...wrong.journal, async append(plan: InstallationPlanV1) {
    const value = await wrong.journal.append(plan); return { ...value, installationId: "other-install" } as const;
  } };
  await assert.rejects(confirmPrivateMacosServiceOwnerActionTerminalV1({ installationId: "install-local",
    request: f.request, terminalConfirmation: result.terminalConfirmation }, { journal: wrongJournal }), /_refused/u);
});

test("the source contains no launchd, process, filesystem, network, database, credential or retry implementation", async () => {
  const source = await readFile(new URL("../src/installer/v1/private-macos-service-owner-runner.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:fs", "node:net", "node:tls", "pg", "postgres",
    "execFile(", "spawn(", "connect(", "setInterval("]) assert.equal(source.includes(forbidden), false, forbidden);
});
