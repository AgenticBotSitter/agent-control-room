import { assemblePrivateAgentTaskOperatorConfiguration } from
  "../../web/v1/private-agent-task-operator-configuration";
import { createPrivateTaskBootstrap, validatePrivateTaskStartupConfiguration } from
  "../../web/v1/private-task-startup";
import { verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import type { InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { dispatchPrivateLocalSetupStageV1 } from "./private-local-setup-orchestrator";
import { reverifyPrivateLocalHermesStartupV1, verifyPrivateLocalHermesStartupReverificationV1 } from
  "./private-local-hermes-startup-reverification";
import { verifyLocalClaudePostInstallAdmissionReceiptV1, verifyLocalClaudePostInstallAdmissionV1 } from
  "./local-claude-post-install-admission";
import { createClaudeCodePrivateInstallationCompositionV1 } from
  "../../web/v1/claude-code-private-installation-composition";
import { extendInstalledResultInspectionWithClaudeV1 } from
  "../../web/v1/claude-code-private-installation-composition";
import type { RoutedTaskResultInspectionServiceV1 } from "../../completion-gate/v1/routed-result-inspection";
import { planInstallationTopologyV1 } from "../../harness/v1/installation-topology";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../../harness/claude-code-v1/task-planning-contract";

export const PRIVATE_LOCAL_INSTALLATION_RUNTIME_ASSEMBLY_V1 =
  "control-room.private-local-installation-runtime-assembly/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory" | "inspectSettledHistory">;
type StartupDependencies = Parameters<typeof createPrivateTaskBootstrap>[0];

type Blocker = "private_configuration_custody_missing" | "native_service_custody_missing";

export type PrivateLocalInstallationRuntimeAssemblyBlockedV1 = Readonly<{
  schema: typeof PRIVATE_LOCAL_INSTALLATION_RUNTIME_ASSEMBLY_V1;
  status: "blocked";
  blocker: Blocker;
  createsStateMachine: false;
  createsStore: false;
  createsScheduler: false;
  opensDatabase: false;
  opensArtifactStore: false;
  startsService: false;
  startsWorker: false;
  invokesHermes: false;
  exposesBrowserAction: false;
}>;

const refused = (): never => {
  const error = new Error("private_local_installation_runtime_assembly_refused");
  error.stack = undefined;
  throw error;
};

function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(name => !names.includes(name))
    || names.some(name => !Object.prototype.hasOwnProperty.call(value, name)) || keys.some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refused();
  return value as Readonly<Record<string, unknown>>;
}

function callableRecord(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const allowed = [...required, ...optional], names = Object.getOwnPropertyNames(value);
  if (required.some(name => !names.includes(name)) || names.some(name => !allowed.includes(name))) return refused();
  const captured: Record<string, (...args: never[]) => unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)
      || typeof descriptor.value !== "function") return refused();
    captured[name] = descriptor.value as (...args: never[]) => unknown;
  }
  return Object.freeze(captured);
}

function captureJournal(value: unknown): Journal {
  const journal = callableRecord(value, ["append", "readHistory", "inspectSettledHistory"]);
  return Object.freeze({
    append: Function.prototype.bind.call(journal.append, value),
    readHistory: Function.prototype.bind.call(journal.readHistory, value),
    inspectSettledHistory: Function.prototype.bind.call(journal.inspectSettledHistory, value),
  }) as Journal;
}

function clone<T>(value: T): T {
  try { return structuredClone(value); } catch { return refused(); }
}

function captureOwned(value: unknown, capturedValues = new WeakMap<object, unknown>(), active = new WeakSet<object>(), path = "trusted"): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return value.slice();
  if (active.has(value)) throw new Error(`capture_cycle:${path}`);
  const prior = capturedValues.get(value);
  if (prior !== undefined) return prior;
  active.add(value);
  if (Array.isArray(value)) {
    const array = value.map((item, index) => captureOwned(item, capturedValues, active, `${path}[${index}]`));
    active.delete(value); capturedValues.set(value, array);
    return Object.freeze(array);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`capture_symbol:${path}`);
  const captured = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) throw new Error(`capture_descriptor:${path}.${name}`);
    captured[name] = captureOwned(descriptor.value, capturedValues, active, `${path}.${name}`);
  }
  active.delete(value); capturedValues.set(value, captured);
  return Object.freeze(captured);
}

function blocked(blocker: Blocker): PrivateLocalInstallationRuntimeAssemblyBlockedV1 {
  return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_RUNTIME_ASSEMBLY_V1, status: "blocked", blocker,
    createsStateMachine: false, createsStore: false, createsScheduler: false, opensDatabase: false,
    opensArtifactStore: false, startsService: false, startsWorker: false, invokesHermes: false,
    exposesBrowserAction: false });
}

function captureRunnerInput(value: unknown) {
  const runner = exact(value, ["admissionPreparationInput", "privateStartupConfiguration", "startupAdmissionBinding"]);
  const admissionPreparationInput = clone(runner.admissionPreparationInput);
  const startupAdmissionBinding = clone(runner.startupAdmissionBinding);
  const supplied = runner.privateStartupConfiguration as Parameters<typeof validatePrivateTaskStartupConfiguration>[0];
  let startup: ReturnType<typeof validatePrivateTaskStartupConfiguration>;
  try { startup = validatePrivateTaskStartupConfiguration(supplied); } catch { return refused(); }
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)
    || !supplied.coordinator || typeof supplied.coordinator !== "object") return refused();
  const delivery = supplied.coordinator.hermes021Local;
  const resultInspectionSource = supplied.coordinator.resultInspectionSource;
  if (!delivery || typeof delivery !== "object" || typeof delivery.deliver !== "function" || !startup.queueWorker
    || resultInspectionSource !== undefined && typeof resultInspectionSource.inspectSubmitted !== "function") return refused();
  const coordinator = Object.freeze({ ...supplied.coordinator, planning: startup.planning, routes: startup.routes,
    approvals: startup.approvals, quality: startup.quality, revisionPlanning: startup.revisionPlanning,
    nativeHttp: startup.nativeHttp, nativeQueue: startup.nativeQueue, nativeQueueRecovery: startup.nativeQueueRecovery,
    queueWorker: startup.queueWorker, database: startup.database, resultDatabase: startup.resultDatabase,
    evidence: startup.evidence, sessions: startup.sessions, hermes021Local: delivery,
    ...(resultInspectionSource ? { resultInspectionSource } : {}) });
  const privateStartupConfiguration = Object.freeze({ ...supplied, web: startup.web, coordinator });
  return Object.freeze({ runnerInput: Object.freeze({ admissionPreparationInput,
    privateStartupConfiguration, startupAdmissionBinding }), delivery,
    ...(resultInspectionSource ? { resultInspectionSource } : {}), queueWorker: startup.queueWorker });
}

function captureDependencies(value: unknown): StartupDependencies {
  const optional = ["clock", "prepareNativeSubmission", "startNativeWorker",
    "prepareNewsSubmission", "startNewsWorker", "openArtifactStorage"];
  const dependencies = callableRecord(value, ["openDatabase", "install"], optional);
  const bound: Record<string, unknown> = {};
  for (const [name, callback] of Object.entries(dependencies))
    bound[name] = Function.prototype.bind.call(callback, value);
  return Object.freeze(bound) as StartupDependencies;
}

function settledCurrent(history: readonly InstallationPlanV1[]) {
  const current = history.at(-1);
  if (!current || history.length !== current.revision + 1) return refused();
  const plan = verifyInstallationPlanV1(current);
  if (plan.stages.some(item => item.state !== "passed")) return refused();
  return plan;
}

/**
 * Inert composition of the accepted setup, settled-journal re-verification,
 * operator configuration and normal task startup. Construction captures only;
 * `start` performs the read-only gate before the existing bootstrap can touch
 * any effect-capable dependency.
 */
export function createPrivateLocalInstallationRuntimeAssemblyV1(inputValue: unknown, runtimeValue: unknown) {
  let input: Readonly<Record<string, unknown>>;
  try {
    const names = inputValue && typeof inputValue === "object"
      && Object.prototype.hasOwnProperty.call(inputValue, "claudePostInstall")
      ? ["runnerInput", "operatorSettings", "operatorTrustedInputs", "claudePostInstall"]
      : ["runnerInput", "operatorSettings", "operatorTrustedInputs"];
    input = exact(inputValue, names);
  }
  catch { return blocked("private_configuration_custody_missing"); }
  if (input.runnerInput === undefined || input.operatorSettings === undefined || input.operatorTrustedInputs === undefined)
    return blocked("private_configuration_custody_missing");
  let captured: ReturnType<typeof captureRunnerInput>, journal: Journal, dependencies: StartupDependencies;
  try {
    captured = captureRunnerInput(input.runnerInput);
    const runtime = exact(runtimeValue, ["journal", "startupDependencies"]);
    journal = captureJournal(runtime.journal);
    dependencies = captureDependencies(runtime.startupDependencies);
  } catch { return blocked("private_configuration_custody_missing"); }
  let operatorSettings: unknown;
  try { operatorSettings = clone(input.operatorSettings); }
  catch { return blocked("private_configuration_custody_missing"); }
  if (!input.operatorTrustedInputs || typeof input.operatorTrustedInputs !== "object"
    || Array.isArray(input.operatorTrustedInputs)) return blocked("private_configuration_custody_missing");
  const trustedInput = input.operatorTrustedInputs as Record<string, unknown>;
  if (trustedInput.hermes021Local !== captured.delivery
    || trustedInput.resultInspectionSource !== undefined && trustedInput.resultInspectionSource !== captured.resultInspectionSource)
    return blocked("private_configuration_custody_missing");
  let detachedTrusted: Record<string, unknown>;
  try {
    const withoutDelivery = Object.fromEntries(Object.entries(trustedInput)
      .filter(([name]) => name !== "hermes021Local" && name !== "resultInspectionSource"));
    detachedTrusted = captureOwned(withoutDelivery) as Record<string, unknown>;
  } catch { return blocked("private_configuration_custody_missing"); }
  const capturedTrusted: Readonly<Record<string, unknown>> = Object.freeze({
    ...detachedTrusted, hermes021Local: captured.delivery,
    ...(trustedInput.resultInspectionSource === captured.resultInspectionSource && captured.resultInspectionSource
      ? { resultInspectionSource: captured.resultInspectionSource } : {}),
  });
  let claudePostInstall: Readonly<Record<string, unknown>> | undefined;
  if (input.claudePostInstall !== undefined) {
    try { claudePostInstall = captureOwned(exact(input.claudePostInstall,
      ["admissionInput", "admissionRuntime", "compositionInput"])) as Readonly<Record<string, unknown>>; }
    catch { return blocked("private_configuration_custody_missing"); }
  }

  async function prepare(signal?: AbortSignal) {
    if (signal?.aborted) return refused();
    const receipt = await reverifyPrivateLocalHermesStartupV1({ runnerInput: captured.runnerInput }, { journal });
    if (signal?.aborted) return refused();
    let history = await journal.inspectSettledHistory(), current = settledCurrent(history);
    verifyPrivateLocalHermesStartupReverificationV1(receipt, { delivery: captured.delivery,
      queueWorker: captured.queueWorker, installationPlan: current });
    let claudeDelivery: ReturnType<typeof createClaudeCodePrivateInstallationCompositionV1> | undefined;
    let resultInspectionSource = captured.resultInspectionSource as RoutedTaskResultInspectionServiceV1 | undefined;
    let claudeAdmission: Awaited<ReturnType<typeof verifyLocalClaudePostInstallAdmissionV1>> | undefined;
    if (claudePostInstall) {
      const admissionRuntime = claudePostInstall.admissionRuntime;
      if (!admissionRuntime || typeof admissionRuntime !== "object") return refused();
      const readHistory = (admissionRuntime as { readOriginalInstallationHistory?: unknown }).readOriginalInstallationHistory;
      const readTransition = (admissionRuntime as { readTransition?: unknown }).readTransition;
      if (typeof readHistory !== "function" || typeof readTransition !== "function") return refused();
      claudeAdmission = await verifyLocalClaudePostInstallAdmissionV1(claudePostInstall.admissionInput as never,
        Object.freeze({ readOriginalInstallationHistory: Function.prototype.bind.call(readHistory, admissionRuntime),
          readTransition: Function.prototype.bind.call(readTransition, admissionRuntime) }));
      if (signal?.aborted) return refused();
      const originalAdmission = captured.runnerInput.admissionPreparationInput as {
        installationId?: unknown; topologyInput?: unknown };
      if (typeof originalAdmission.installationId !== "string") return refused();
      const originalTopology = planInstallationTopologyV1(originalAdmission.topologyInput);
      verifyLocalClaudePostInstallAdmissionReceiptV1(claudeAdmission, {
        installationId: originalAdmission.installationId, originalInstallationPlanDigest: current.planDigest,
        originalInstallationPlanRevision: current.revision, originalTopologyPlanDigest: current.topologyPlanDigest,
        releaseDigest: current.releaseDigest, databaseAuthorityDigest: originalTopology.databaseAuthorityDigest,
        schedulerAuthorityDigest: originalTopology.schedulerAuthorityDigest, adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1 });
      const composition = claudePostInstall.compositionInput;
      if (!composition || typeof composition !== "object") return refused();
      claudeDelivery = createClaudeCodePrivateInstallationCompositionV1({ ...(composition as Record<string, unknown>),
        admission: claudeAdmission } as never);
      if (resultInspectionSource)
        resultInspectionSource = extendInstalledResultInspectionWithClaudeV1(claudeDelivery, resultInspectionSource);
    }
    const trusted = Object.freeze({ ...capturedTrusted,
      web: Object.freeze({ ...(capturedTrusted.web as Record<string, unknown>), installationPlan: current }),
      hermes021LocalStartupReverification: receipt,
      ...(resultInspectionSource ? { resultInspectionSource } : {}),
      ...(claudeDelivery ? { claudeCodeLocal: claudeDelivery,
        claudeCodeLocalStartupReverification: claudeAdmission,
        claudeCodeLocalInstallationId: claudeAdmission?.installationId } : {}) });
    const operator = assemblePrivateAgentTaskOperatorConfiguration(operatorSettings, trusted);
    if (signal?.aborted) return refused();
    history = await journal.inspectSettledHistory(); current = settledCurrent(history);
    verifyPrivateLocalHermesStartupReverificationV1(receipt, { delivery: captured.delivery,
      queueWorker: captured.queueWorker, installationPlan: current });
    if (claudeAdmission && claudePostInstall) {
      const runtime = claudePostInstall.admissionRuntime as { readOriginalInstallationHistory?: unknown; readTransition?: unknown };
      if (typeof runtime?.readOriginalInstallationHistory !== "function" || typeof runtime.readTransition !== "function") return refused();
      const reread = await verifyLocalClaudePostInstallAdmissionV1(claudePostInstall.admissionInput as never,
        Object.freeze({ readOriginalInstallationHistory: Function.prototype.bind.call(runtime.readOriginalInstallationHistory, runtime),
          readTransition: Function.prototype.bind.call(runtime.readTransition, runtime) }));
      if (reread.admissionDigest !== claudeAdmission.admissionDigest) return refused();
    }
    if (signal?.aborted) return refused();
    return Object.freeze({ receipt, configuration: operator.configuration, port: operator.port, plan: current });
  }

  return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_RUNTIME_ASSEMBLY_V1, status: "ready" as const,
    createsStateMachine: false as const, createsStore: false as const, createsScheduler: false as const,
    opensDatabase: false as const, opensArtifactStore: false as const, startsService: false as const,
    startsWorker: false as const, invokesHermes: false as const, exposesBrowserAction: false as const,
    async dispatchSetup(setupInput: unknown, stageRuntimeValue: unknown = {}) {
      const stageRuntime = exact(stageRuntimeValue, Object.keys(stageRuntimeValue as object));
      if (Object.prototype.hasOwnProperty.call(stageRuntime, "journal")) return refused();
      const requested = setupInput && typeof setupInput === "object"
        ? (setupInput as { requestedStage?: unknown }).requestedStage : undefined;
      if (requested === "platform_service" && !Object.prototype.hasOwnProperty.call(stageRuntime, "platformService")) {
        return blocked("native_service_custody_missing");
      }
      return dispatchPrivateLocalSetupStageV1(setupInput, Object.freeze({ journal, ...stageRuntime }) as never);
    },
    prepare,
    async start(signal?: AbortSignal) {
      const prepared = await prepare(signal);
      if (signal?.aborted) return refused();
      return createPrivateTaskBootstrap(dependencies).start(prepared.configuration, signal);
    },
  });
}
