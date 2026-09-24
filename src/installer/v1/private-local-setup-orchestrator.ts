import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { createMacosLocalServicePackageV1 } from "../../harness/v1/macos-local-service-package";
import { verifyLocalSupervisorReadinessV1 } from "../../harness/v1/local-supervisor-readiness";
import { validatePrivateTaskStartupConfiguration } from "../../web/v1/private-task-startup";
import { verifyPrivateHermes021LocalStartupAdmissionBindingV1 } from
  "../../web/v1/hermes-021-private-installation-composition";
import { prepareLocalHermesAdmissionV1 } from "./local-hermes-admission-preparation";
import { confirmFirstOwnerActionTerminalV1 } from "./first-owner-action-transaction";
import { firstOwnerStageInputDigestV1 } from "./first-owner-setup-preparation";
import { prepareInstallationActionV1 } from "./installation-action-preparation";
import { advanceInstallationPlanV1, refreshInstallationPlanV1, verifyInstallationPlanV1,
  type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { confirmPostgresOwnerActionTerminalV1, startPostgresOwnerActionV1 } from
  "./postgres-owner-action-transaction";
import { preparePostgresOwnerActionV1 } from "./postgres-owner-action";
import { runPrivateFirstOwnerActionV1, type PrivateFirstOwnerRuntimeV1 } from "./private-first-owner-runner";
import { runPrivatePostgresOwnerActionV1, type PrivatePostgresOwnerRuntimeV1 } from
  "./private-postgres-owner-runner";
import { runPrivateProtectedRootOwnerActionV1, type PrivateProtectedRootOwnerRuntimeV1 } from
  "./private-protected-root-owner-runner";
import { capturePrivateRecoveryOwnerRuntimePortV1, runPrivateRecoveryOwnerActionV1,
  verifyPrivateRecoveryOwnerRuntimeV1, type PrivateRecoveryOwnerRuntimeV1 } from
  "./private-recovery-owner-runner";
import { confirmProtectedDataActionTerminalV1, prepareProtectedDataActionTransactionRequestV1,
  PROTECTED_DATA_ACTION_TERMINAL_CONFIRMATION_V1 } from "./protected-data-action-transaction";
import { prepareProtectedDataRecoveryOwnerActionV1 } from "./protected-data-recovery-owner-action";
import { protectedDataStageInputDigestV1, protectedDataStorageBindingsV1, recoveryStageInputDigestV1 } from
  "./protected-data-recovery-preparation";
import { confirmRecoveryActionTerminalV1 } from "./recovery-action-transaction";
import { confirmPrivateMacosServiceOwnerActionTerminalV1, runPrivateMacosServiceOwnerActionV1,
  PRIVATE_MACOS_SERVICE_TOOL_V1, type PrivateMacosServiceOwnerRuntimeV1, type PrivateMacosServiceOwnerToolV1 } from
  "./private-macos-service-owner-runner";
import { macosServiceIdentityDigestV1 } from "./macos-service-owner-action";
import { preparePlatformServiceLifecycleV1 } from "./platform-service-lifecycle";
import { confirmLocalHermesAdmissionTerminalV1 } from "./local-hermes-admission-transaction";
import { runPrivateLocalHermesAdmissionV1, type PrivateLocalHermesAdmissionRunnerContextV1 } from
  "./private-local-hermes-admission-runner";
import { confirmPrivateInstallationFinalReviewV1, runPrivateInstallationFinalReviewV1,
  type PrivateInstallationFinalReviewContextV1 } from "./private-installation-final-review";

/**
 * Private, source-only dispatcher over the accepted installation journal and
 * stage runners. It owns no state machine, store, scheduler, browser/native
 * port, retry loop, or recovery implementation.
 */
export const PRIVATE_LOCAL_SETUP_ORCHESTRATOR_V1 =
  "control-room.private-local-setup-orchestrator/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;
type Stage = "database_authority" | "protected_data" | "first_owner" | "recovery" | "platform_service"
  | "agent_readiness" | "final_review";
type Runtime = Readonly<{ journal: Journal; postgres?: PrivatePostgresOwnerRuntimeV1;
  protectedData?: PrivateProtectedRootOwnerRuntimeV1; firstOwner?: PrivateFirstOwnerRuntimeV1;
  recovery?: PrivateRecoveryOwnerRuntimeV1; platformService?: PrivateMacosServiceOwnerRuntimeV1;
  agentReadiness?: Readonly<{ signal: AbortSignal; controlDeadlineMs: number;
    confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1): Promise<unknown>;
    qualifyOwnerAuthorizedRunner?(context: PrivateLocalHermesAdmissionRunnerContextV1): Promise<object> }>;
  finalReview?: Readonly<{ signal: AbortSignal; controlDeadlineMs: number;
    confirmOwnerAttached(context: PrivateInstallationFinalReviewContextV1): Promise<unknown> }> }>;

export type PrivateLocalSetupOrchestratorResultV1 = Readonly<{
  schema: typeof PRIVATE_LOCAL_SETUP_ORCHESTRATOR_V1;
  installationId: string;
  requestedStage: Stage;
  status: "completed" | "blocked";
  installationPlan: InstallationPlanV1;
  receiptDigest?: string;
  blocker?: "recovery_private_adapter_missing" | "macos_native_service_port_missing"
    | "local_hermes_admission_runtime_missing" | "final_review_runtime_missing";
  replayed: false;
  createsStateMachine: false;
  createsReceiptStore: false;
  startsScheduler: false;
  exposesBrowserEffect: false;
  suppliesNativeEffect: false;
  retriesUncertainEffect: false;
  invokesHermes: boolean;
}>;

const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const refused = (): never => { throw new Error("private_local_setup_orchestrator_refused"); };

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const names = Object.getOwnPropertyNames(value);
  if (names.some(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) return refused();
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  const parsed = record(value), keys = Object.keys(parsed);
  if (keys.length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(parsed, name))
    || keys.some(name => !names.includes(name))) return refused();
  return parsed;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function signal(value: unknown): AbortSignal {
  const candidate = value as AbortSignal;
  if (!candidate || typeof candidate !== "object" || typeof candidate.aborted !== "boolean"
    || typeof candidate.addEventListener !== "function" || typeof candidate.removeEventListener !== "function") return refused();
  return candidate;
}

function deadline(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) return refused();
  return value as number;
}

function clonePlain<T>(value: T): T {
  try { return structuredClone(value); } catch { return refused(); }
}

function precedingClaimedPlan(runningValue: unknown, selected: "platform_service" | "agent_readiness", input: Captured) {
  const running = verifyInstallationPlanV1(runningValue), selectedRecord = stage(running, selected);
  if (running.revision !== input.expectedPlanRevision + 1 || selectedRecord.state !== "running"
    || selectedRecord.recordedRevision !== running.revision || running.releaseDigest !== input.expectedReleaseDigest
    || running.topologyPlanDigest !== input.topologyPlan.planDigest) return refused();
  const { planDigest: _digest, ...runningBody } = running; void _digest;
  const body = { ...runningBody, revision: input.expectedPlanRevision,
    stages: running.stages.map(item => item.stage === selected
      ? { stage: selected, inputDigest: item.inputDigest, state: "not_started" as const } : item) };
  const previous = verifyInstallationPlanV1({ ...body, planDigest: sha256Digest(body) });
  if (previous.planDigest !== input.expectedPlanDigest || previous.revision !== input.expectedPlanRevision
    || nextStage(previous) !== selected) return refused();
  return Object.freeze({ previous, running });
}

type PlatformServiceSource = Readonly<{ request: Readonly<{ lifecycle: unknown; lifecycleInput: unknown;
  servicePackageInput: unknown }>; previous: InstallationPlanV1; running: InstallationPlanV1 }>;

function capturePlatformServiceSource(value: unknown, input: Captured): PlatformServiceSource {
  const source = exact(value, ["lifecycle", "lifecycleInput", "servicePackageInput"]), captured = clonePlain(source);
  const lifecycleInput = exact(captured.lifecycleInput, ["action", "platform", "installationPlan",
    "supervisorReadiness", "serviceIdentityDigest", "authorityDatabaseDigest", "protectedDataDigest", "observation",
    "targetReleaseDigest", "targetServiceDefinitionDigest"]);
  const plans = precedingClaimedPlan(lifecycleInput.installationPlan, "platform_service", input);
  const servicePackageInput = captured.servicePackageInput;
  try {
    const package_ = createMacosLocalServicePackageV1(servicePackageInput as Parameters<typeof createMacosLocalServicePackageV1>[0]);
    const readiness = verifyLocalSupervisorReadinessV1(lifecycleInput.supervisorReadiness);
    if (lifecycleInput.action !== "install" || lifecycleInput.platform !== "macos_launchd"
      || lifecycleInput.targetReleaseDigest !== input.expectedReleaseDigest
      || lifecycleInput.serviceIdentityDigest !== macosServiceIdentityDigestV1(servicePackageInput as
        Parameters<typeof createMacosLocalServicePackageV1>[0])
      || lifecycleInput.targetServiceDefinitionDigest !== sha256Digest(package_.plist)
      || readiness.planDigest !== plans.running.planDigest) return refused();
    preparePlatformServiceLifecycleV1(lifecycleInput as Parameters<typeof preparePlatformServiceLifecycleV1>[0]);
  }
  catch { return refused(); }
  const expected = preparePlatformServiceLifecycleV1(lifecycleInput as Parameters<typeof preparePlatformServiceLifecycleV1>[0]);
  if (canonicalJson(captured.lifecycle) !== canonicalJson(expected)) return refused();
  return Object.freeze({ request: Object.freeze({ lifecycle: expected, lifecycleInput, servicePackageInput }), ...plans });
}

function capturePlatformServiceRuntime(value: unknown): PrivateMacosServiceOwnerRuntimeV1 {
  const runtime = exact(value, ["signal", "controlDeadlineMs", "cleanupDeadlineMs", "reviewedServicePackageInput",
    "confirmOwnerAttachedTerminal", "tool"]);
  const tool = exact(runtime.tool, ["schema", "executeStep", "observeFinal", "cleanup"]);
  if (tool.schema !== PRIVATE_MACOS_SERVICE_TOOL_V1 || typeof runtime.confirmOwnerAttachedTerminal !== "function" || typeof tool.executeStep !== "function"
    || typeof tool.observeFinal !== "function" || typeof tool.cleanup !== "function") return refused();
  const owner = value as PrivateMacosServiceOwnerRuntimeV1, toolOwner = runtime.tool as PrivateMacosServiceOwnerToolV1;
  const reviewedServicePackageInput = clonePlain(runtime.reviewedServicePackageInput) as
    Parameters<typeof createMacosLocalServicePackageV1>[0];
  try { createMacosLocalServicePackageV1(reviewedServicePackageInput); } catch { return refused(); }
  return Object.freeze({ signal: signal(runtime.signal), controlDeadlineMs: deadline(runtime.controlDeadlineMs, 300_000),
    cleanupDeadlineMs: deadline(runtime.cleanupDeadlineMs, 30_000), reviewedServicePackageInput,
    confirmOwnerAttachedTerminal: owner.confirmOwnerAttachedTerminal.bind(owner),
    tool: Object.freeze({ schema: tool.schema as PrivateMacosServiceOwnerToolV1["schema"],
      executeStep: toolOwner.executeStep.bind(toolOwner), observeFinal: toolOwner.observeFinal.bind(toolOwner),
      cleanup: toolOwner.cleanup.bind(toolOwner) }) });
}

async function captureAgentReadinessSource(value: unknown, input: Captured) {
  const sourceRecord = record(value);
  const permitted = ["admissionPreparationInput", "privateStartupConfiguration", "startupAdmissionBinding",
    "ownerAuthorizedRunnerProvider", "hermesQualificationRuntime"];
  if (Object.keys(sourceRecord).some(name => !permitted.includes(name))
    || ["admissionPreparationInput", "privateStartupConfiguration", "startupAdmissionBinding"].some(name =>
      !Object.prototype.hasOwnProperty.call(sourceRecord, name))) return refused();
  const source = Object.freeze({ admissionPreparationInput: sourceRecord.admissionPreparationInput,
    privateStartupConfiguration: sourceRecord.privateStartupConfiguration,
    startupAdmissionBinding: sourceRecord.startupAdmissionBinding });
  const ownerAuthorizedRunnerProvider = sourceRecord.ownerAuthorizedRunnerProvider;
  const hermesQualificationRuntime = sourceRecord.hermesQualificationRuntime;
  if (ownerAuthorizedRunnerProvider !== undefined && (!ownerAuthorizedRunnerProvider
    || typeof ownerAuthorizedRunnerProvider !== "object")) return refused();
  if (hermesQualificationRuntime !== undefined && (!hermesQualificationRuntime
    || typeof hermesQualificationRuntime !== "object")) return refused();
  const admission = exact(source.admissionPreparationInput, ["installationId", "installationPlan", "topologyInput",
    "workerBinding", "installationBinding", "installationBindingInput"]);
  const admissionPreparationInput = clonePlain(admission);
  if (admissionPreparationInput.installationId !== input.installationId) return refused();
  const plans = precedingClaimedPlan(admissionPreparationInput.installationPlan, "agent_readiness", input);
  const startupInput = source.privateStartupConfiguration as Parameters<typeof validatePrivateTaskStartupConfiguration>[0];
  let startup: ReturnType<typeof validatePrivateTaskStartupConfiguration>;
  try { startup = validatePrivateTaskStartupConfiguration(startupInput); } catch { return refused(); }
  if (!startupInput || typeof startupInput !== "object" || Array.isArray(startupInput)) return refused();
  const coordinator = (startupInput as { coordinator?: unknown }).coordinator;
  if (!coordinator || typeof coordinator !== "object" || Array.isArray(coordinator)) return refused();
  const delivery = (coordinator as { hermes021Local?: unknown }).hermes021Local;
  if (!delivery || typeof delivery !== "object" || typeof (delivery as { deliver?: unknown }).deliver !== "function") return refused();
  const startupAdmissionBinding = clonePlain(source.startupAdmissionBinding);
  const capturedCoordinator = Object.freeze({ ...(coordinator as Record<string, unknown>), planning: startup.planning,
    routes: startup.routes, approvals: startup.approvals, quality: startup.quality,
    revisionPlanning: startup.revisionPlanning, nativeHttp: startup.nativeHttp, nativeQueue: startup.nativeQueue,
    nativeQueueRecovery: startup.nativeQueueRecovery, queueWorker: startup.queueWorker, database: startup.database,
    resultDatabase: startup.resultDatabase, evidence: startup.evidence, sessions: startup.sessions,
    hermes021Local: delivery });
  const privateStartupConfiguration = Object.freeze({ ...(startupInput as Record<string, unknown>),
    web: startup.web, coordinator: capturedCoordinator });
  const isolatedJournal: Journal = Object.freeze({
    async readHistory() { return Object.freeze([plans.running]); },
    async append(plan: InstallationPlanV1) {
      if (canonicalJson(plan) !== canonicalJson(plans.running)) return refused();
      return { schema: "control-room.installation-plan-journal/v1" as const, installationId: input.installationId,
        revision: plan.revision, planDigest: plan.planDigest, replayed: true, enablesAuthority: false as const,
        startsService: false as const, startsWorker: false as const };
    },
  });
  let preparation: Awaited<ReturnType<typeof prepareLocalHermesAdmissionV1>>;
  try { preparation = await prepareLocalHermesAdmissionV1(admissionPreparationInput as never, { journal: isolatedJournal }); }
  catch { return refused(); }
  if (preparation.state !== "awaiting_owner_admission_review" || !preparation.admissionRequestDigest
    || preparation.installationId !== input.installationId || preparation.topologyPlanDigest !== input.topologyPlan.planDigest
    || preparation.releaseDigest !== input.expectedReleaseDigest || preparation.installationPlanDigest !== plans.running.planDigest
    || preparation.installationPlanRevision !== plans.running.revision) return refused();
  try {
    verifyPrivateHermes021LocalStartupAdmissionBindingV1(startupAdmissionBinding, {
      delivery, queueWorker: startup.queueWorker, installationBinding: admissionPreparationInput.installationBinding,
      topologyPlanDigest: preparation.topologyPlanDigest, releaseDigest: preparation.releaseDigest,
      admissionRequestDigest: preparation.admissionRequestDigest,
    });
  } catch { return refused(); }
  return Object.freeze({ admissionPreparationInput, privateStartupConfiguration, startupAdmissionBinding, ...plans,
    ...(ownerAuthorizedRunnerProvider ? { ownerAuthorizedRunnerProvider } : {}),
    ...(hermesQualificationRuntime ? { hermesQualificationRuntime } : {}) });
}

function captureAgentReadinessRuntime(value: unknown) {
  const captured = record(value), names = Object.keys(captured);
  if (names.some(name => !["signal", "controlDeadlineMs", "confirmOwnerAttachedTerminal", "qualifyOwnerAuthorizedRunner"].includes(name))
    || ["signal", "controlDeadlineMs", "confirmOwnerAttachedTerminal"].some(name => !names.includes(name))) return refused();
  const runtime = captured;
  if (typeof runtime.confirmOwnerAttachedTerminal !== "function") return refused();
  if (runtime.qualifyOwnerAuthorizedRunner !== undefined && typeof runtime.qualifyOwnerAuthorizedRunner !== "function") return refused();
  const owner = value as NonNullable<Runtime["agentReadiness"]>;
  return Object.freeze({ signal: signal(runtime.signal), controlDeadlineMs: deadline(runtime.controlDeadlineMs, 30_000),
    confirmOwnerAttachedTerminal: owner.confirmOwnerAttachedTerminal.bind(owner),
    ...(runtime.qualifyOwnerAuthorizedRunner ? { qualifyOwnerAuthorizedRunner: owner.qualifyOwnerAuthorizedRunner!.bind(owner) } : {}) });
}

function captureFinalReviewRuntime(value: unknown) {
  const runtime = exact(value, ["signal", "controlDeadlineMs", "confirmOwnerAttached"]);
  if (typeof runtime.confirmOwnerAttached !== "function") return refused();
  const owner = value as NonNullable<Runtime["finalReview"]>;
  return Object.freeze({ signal: signal(runtime.signal), controlDeadlineMs: deadline(runtime.controlDeadlineMs, 30_000),
    confirmOwnerAttached: owner.confirmOwnerAttached.bind(owner) });
}

function captureRecoverySource(value: unknown): unknown {
  const source = exact(value, ["protectedDataPreparation", "storageConfiguration", "protectedDataObservation",
    "databaseAuthorityOutcomeDigest", "expectedDatabaseIdentityDigest", "expectedDatabaseSchemaDigest",
    "observedState", "observationDigest"]);
  const captured = JSON.parse(canonicalJson(source)) as unknown;
  const freeze = (item: unknown): unknown => {
    if (Array.isArray(item)) return Object.freeze(item.map(freeze));
    if (item && typeof item === "object") {
      const plain = record(item);
      return Object.freeze(Object.fromEntries(Object.entries(plain).map(([name, nested]) => [name, freeze(nested)])));
    }
    return item;
  };
  return freeze(captured);
}

function captureJournal(value: unknown): Journal {
  if (!value || typeof value !== "object") return refused();
  const journal = value as Journal;
  if (typeof journal.append !== "function" || typeof journal.readHistory !== "function") return refused();
  return Object.freeze({ append: journal.append.bind(value), readHistory: journal.readHistory.bind(value) });
}

function stage(plan: InstallationPlanV1, selected: Stage) {
  const found = plan.stages.find(item => item.stage === selected);
  if (!found) return refused();
  return found;
}

function requestedStage(value: unknown): Stage {
  if (value === "database_authority" || value === "protected_data"
    || value === "first_owner" || value === "recovery" || value === "platform_service"
    || value === "agent_readiness" || value === "final_review") return value;
  return refused();
}

function nextStage(plan: InstallationPlanV1): Stage {
  const next = plan.stages.find(item => item.state !== "passed");
  if (!next) return refused();
  if (next.stage === "release_preflight" || next.stage === "private_placement") return refused();
  if (next.stage === "database_authority" || next.stage === "protected_data" || next.stage === "first_owner"
    || next.stage === "recovery" || next.stage === "platform_service" || next.stage === "agent_readiness"
    || next.stage === "final_review") return next.stage;
  return refused();
}

type Captured = Readonly<{ installationId: string; expectedPlanRevision: number; expectedPlanDigest: string;
  expectedReleaseDigest: string; requestedStage: Stage; topologyPlan: ReturnType<typeof verifyInstallationTopologyPlanV1>;
  source: unknown }>;

function captureInput(value: unknown): Captured {
  const input = exact(value, ["installationId", "expectedPlanRevision", "expectedPlanDigest", "expectedReleaseDigest",
    "requestedStage", "topologyPlan", "source"]);
  if (typeof input.installationId !== "string" || !installationIdPattern.test(input.installationId)
    || !Number.isSafeInteger(input.expectedPlanRevision) || (input.expectedPlanRevision as number) < 0) return refused();
  return Object.freeze({ installationId: input.installationId, expectedPlanRevision: input.expectedPlanRevision as number,
    expectedPlanDigest: digest(input.expectedPlanDigest), expectedReleaseDigest: digest(input.expectedReleaseDigest),
    requestedStage: requestedStage(input.requestedStage), topologyPlan: verifyInstallationTopologyPlanV1(input.topologyPlan),
    source: input.source });
}

async function currentAndBound(journal: Journal, input: Captured): Promise<InstallationPlanV1> {
  let history: readonly InstallationPlanV1[], appended;
  try { history = await journal.readHistory(); }
  catch { return refused(); }
  const current = history.at(-1);
  if (!current) return refused();
  const plan = verifyInstallationPlanV1(current);
  if (plan.revision !== input.expectedPlanRevision || plan.planDigest !== input.expectedPlanDigest
    || plan.releaseDigest !== input.expectedReleaseDigest || plan.topologyPlanDigest !== input.topologyPlan.planDigest) return refused();
  try { appended = await journal.append(plan); }
  catch { return refused(); }
  if (appended.installationId !== input.installationId || appended.revision !== plan.revision
    || appended.planDigest !== plan.planDigest) return refused();
  return plan;
}

async function append(journal: Journal, installationId: string, plan: InstallationPlanV1,
  requireFreshPublication = false): Promise<InstallationPlanV1> {
  let result;
  try { result = await journal.append(plan); }
  catch { return refused(); }
  if (result.installationId !== installationId || result.revision !== plan.revision || result.planDigest !== plan.planDigest) return refused();
  if (requireFreshPublication && result.replayed) return refused();
  return plan;
}

async function startStage(journal: Journal, input: Captured, plan: InstallationPlanV1,
  selected: "protected_data" | "first_owner" | "recovery" | "platform_service", stageInputDigest: string): Promise<InstallationPlanV1> {
  if (nextStage(plan) !== selected || stage(plan, selected).state !== "not_started") return refused();
  const stageInputDigests = Object.fromEntries(plan.stages.map(item => [item.stage,
    item.stage === selected ? stageInputDigest : item.inputDigest]));
  const refreshed = refreshInstallationPlanV1(plan, { topologyPlan: input.topologyPlan,
    releaseDigest: input.expectedReleaseDigest, stageInputDigests });
  if (canonicalJson(refreshed) !== canonicalJson(plan)) plan = await append(journal, input.installationId, refreshed);
  const running = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" });
  return append(journal, input.installationId, running, true);
}

function actionInput(plan: InstallationPlanV1, input: Captured,
  action: "postgres" | "protected_data" | "first_owner" | "recovery",
  source: unknown) {
  return Object.freeze({ installationPlan: plan, topologyPlan: input.topologyPlan, expectedPlanRevision: plan.revision,
    action, source });
}

function completed(input: Captured, plan: InstallationPlanV1, receiptDigest?: string): PrivateLocalSetupOrchestratorResultV1 {
  return Object.freeze({ schema: PRIVATE_LOCAL_SETUP_ORCHESTRATOR_V1, installationId: input.installationId,
    requestedStage: input.requestedStage, status: "completed", installationPlan: plan,
    ...(receiptDigest ? { receiptDigest } : {}), replayed: false, createsStateMachine: false, createsReceiptStore: false,
    startsScheduler: false, exposesBrowserEffect: false, suppliesNativeEffect: false, retriesUncertainEffect: false,
    invokesHermes: false });
}

function blocked(input: Captured, plan: InstallationPlanV1,
  blocker: "recovery_private_adapter_missing" | "macos_native_service_port_missing"
    | "local_hermes_admission_runtime_missing" | "final_review_runtime_missing"): PrivateLocalSetupOrchestratorResultV1 {
  return Object.freeze({ schema: PRIVATE_LOCAL_SETUP_ORCHESTRATOR_V1, installationId: input.installationId,
    requestedStage: input.requestedStage, status: "blocked", installationPlan: plan, blocker, replayed: false,
    createsStateMachine: false, createsReceiptStore: false, startsScheduler: false, exposesBrowserEffect: false,
    suppliesNativeEffect: false, retriesUncertainEffect: false, invokesHermes: false });
}

async function database(input: Captured, journal: Journal, runtime: PrivatePostgresOwnerRuntimeV1) {
  const source = exact(input.source, ["ledgerDigest", "targetIdentityDigest", "initialObservedTargetState", "initialObservationDigest"]);
  const ledgerDigest = digest(source.ledgerDigest), targetIdentityDigest = digest(source.targetIdentityDigest);
  let observedState = source.initialObservedTargetState;
  if (observedState !== "fresh" && observedState !== "provisioned" && observedState !== "existing_verified") return refused();
  let observationDigest = digest(source.initialObservationDigest);
  const started = await startPostgresOwnerActionV1({ installationId: input.installationId, topologyPlan: input.topologyPlan,
    releaseDigest: input.expectedReleaseDigest, ledgerDigest, targetIdentityDigest }, { journal });
  if (started.replayed) return refused();
  const plan = started.installationPlan;
  for (;;) {
    const sourceForAction = { ledgerDigest, targetIdentityDigest, observedTargetState: observedState, observationDigest };
    const currentActionInput = actionInput(plan, input, "postgres", sourceForAction);
    const actionPreparation = prepareInstallationActionV1(currentActionInput);
    const request = preparePostgresOwnerActionV1({ actionPreparation, actionInput: currentActionInput });
    const result = await runPrivatePostgresOwnerActionV1(request, runtime);
    if (result.disposition === "terminal_confirmation") {
      if (!result.terminalConfirmation) return refused();
      const settled = await confirmPostgresOwnerActionTerminalV1({ installationId: input.installationId,
        actionPreparation, actionInput: currentActionInput, terminalConfirmation: result.terminalConfirmation }, { journal });
      const history = await journal.readHistory();
      return completed(input, verifyInstallationPlanV1(history.at(-1)), settled.receipt.receiptDigest);
    }
    observationDigest = result.observationDigest;
    observedState = observedState === "fresh" ? "provisioned" : observedState === "provisioned" ? "existing_verified" : refused();
  }
}

async function protectedData(input: Captured, journal: Journal, current: InstallationPlanV1,
  runtime: PrivateProtectedRootOwnerRuntimeV1) {
  const source = exact(input.source, ["storageConfiguration", "observedState", "observationDigest"]);
  const storage = protectedDataStorageBindingsV1(source.storageConfiguration as
    Parameters<typeof protectedDataStorageBindingsV1>[0]);
  const stageInputDigest = protectedDataStageInputDigestV1(storage);
  const plan = await startStage(journal, input, current, "protected_data", stageInputDigest);
  const currentActionInput = actionInput(plan, input, "protected_data", source);
  const actionPreparation = prepareInstallationActionV1(currentActionInput);
  const ownerRequest = prepareProtectedDataRecoveryOwnerActionV1({ actionPreparation, actionInput: currentActionInput });
  const observation = await runPrivateProtectedRootOwnerActionV1(ownerRequest, runtime);
  const transactionRequest = prepareProtectedDataActionTransactionRequestV1({ actionPreparation, actionInput: currentActionInput });
  const terminalObservation = Object.freeze({ schema: PROTECTED_DATA_ACTION_TERMINAL_CONFIRMATION_V1,
    installationId: input.installationId,
    transactionRequestDigest: sha256Digest({ purpose: "protected-data-action-transaction-request/v1", request: transactionRequest }),
    ownerObservation: observation, terminalState: "confirmed" as const });
  const settled = await confirmProtectedDataActionTerminalV1({ installationId: input.installationId,
    actionPreparation, actionInput: currentActionInput, terminalObservation }, { journal });
  const history = await journal.readHistory();
  return completed(input, verifyInstallationPlanV1(history.at(-1)), settled.receipt.receiptDigest);
}

async function firstOwner(input: Captured, journal: Journal, current: InstallationPlanV1,
  runtime: PrivateFirstOwnerRuntimeV1) {
  const source = exact(input.source, ["databaseAuthorityOutcomeDigest", "bootstrapConfigurationDigest",
    "trustConfigurationDigest", "expectedOwnerSubjectDigest", "observedOwnerState", "observationDigest"]);
  const stageInputDigest = firstOwnerStageInputDigestV1({ releaseDigest: input.expectedReleaseDigest,
    databaseAuthorityOutcomeDigest: source.databaseAuthorityOutcomeDigest,
    bootstrapConfigurationDigest: source.bootstrapConfigurationDigest, trustConfigurationDigest: source.trustConfigurationDigest,
    expectedOwnerSubjectDigest: source.expectedOwnerSubjectDigest });
  const plan = await startStage(journal, input, current, "first_owner", stageInputDigest);
  const currentActionInput = actionInput(plan, input, "first_owner", source);
  const actionPreparation = prepareInstallationActionV1(currentActionInput);
  const result = await runPrivateFirstOwnerActionV1({ actionPreparation, actionInput: currentActionInput }, runtime);
  const settled = await confirmFirstOwnerActionTerminalV1({ installationId: input.installationId,
    actionPreparation, actionInput: currentActionInput, terminalConfirmation: result.terminalConfirmation }, { journal });
  const history = await journal.readHistory();
  return completed(input, verifyInstallationPlanV1(history.at(-1)), settled.receipt.receiptDigest);
}

async function recovery(input: Captured, journal: Journal, current: InstallationPlanV1,
  runtime: PrivateRecoveryOwnerRuntimeV1) {
  const source = exact(input.source, ["protectedDataPreparation", "storageConfiguration", "protectedDataObservation",
    "databaseAuthorityOutcomeDigest", "expectedDatabaseIdentityDigest", "expectedDatabaseSchemaDigest",
    "observedState", "observationDigest"]);
  const protectedPreparation = record(source.protectedDataPreparation);
  const storage = protectedDataStorageBindingsV1(source.storageConfiguration as
    Parameters<typeof protectedDataStorageBindingsV1>[0]);
  const stageInputDigest = recoveryStageInputDigestV1({ releaseDigest: input.expectedReleaseDigest,
    topologyPlanDigest: input.topologyPlan.planDigest,
    protectedDataBindingDigest: digest(protectedPreparation.protectedDataBindingDigest),
    storageConfigurationDigest: storage.storageConfigurationDigest,
    storageNamespaceDigest: storage.storageNamespaceDigest,
    databaseAuthorityOutcomeDigest: source.databaseAuthorityOutcomeDigest,
    expectedDatabaseIdentityDigest: source.expectedDatabaseIdentityDigest,
    expectedDatabaseSchemaDigest: source.expectedDatabaseSchemaDigest });
  if (nextStage(current) !== "recovery" || stage(current, "recovery").state !== "not_started") return refused();
  const stageInputDigests = Object.fromEntries(current.stages.map(item => [item.stage,
    item.stage === "recovery" ? stageInputDigest : item.inputDigest]));
  const refreshed = refreshInstallationPlanV1(current, { topologyPlan: input.topologyPlan,
    releaseDigest: input.expectedReleaseDigest, stageInputDigests });
  const running = advanceInstallationPlanV1(refreshed, { expectedRevision: refreshed.revision,
    stage: "recovery", action: "start" });
  const currentActionInput = actionInput(running, input, "recovery", source);
  const actionPreparation = prepareInstallationActionV1(currentActionInput);
  const exactRuntime = verifyPrivateRecoveryOwnerRuntimeV1({ actionPreparation, actionInput: currentActionInput }, runtime);
  if (canonicalJson(refreshed) !== canonicalJson(current)) await append(journal, input.installationId, refreshed);
  await append(journal, input.installationId, running, true);
  const result = await runPrivateRecoveryOwnerActionV1({ actionPreparation, actionInput: currentActionInput }, exactRuntime);
  const settled = await confirmRecoveryActionTerminalV1({ installationId: input.installationId,
    actionPreparation, actionInput: currentActionInput, terminalConfirmation: result.terminalConfirmation }, { journal });
  const history = await journal.readHistory();
  const latest = verifyInstallationPlanV1(history.at(-1)), recovered = stage(latest, "recovery");
  if (recovered.state !== "passed" || recovered.outcomeDigest !== settled.receipt.backupRestoreProofDigest) return refused();
  return completed(input, latest, settled.receipt.receiptDigest);
}

async function platformService(input: Captured, journal: Journal, current: InstallationPlanV1,
  source: PlatformServiceSource, runtime: PrivateMacosServiceOwnerRuntimeV1) {
  if (canonicalJson(current) !== canonicalJson(source.previous)) return refused();
  await append(journal, input.installationId, source.running, true);
  const result = await runPrivateMacosServiceOwnerActionV1(source.request, runtime);
  const settled = await confirmPrivateMacosServiceOwnerActionTerminalV1({ installationId: input.installationId,
    request: source.request, terminalConfirmation: result.terminalConfirmation }, { journal });
  const history = await journal.readHistory();
  const latest = verifyInstallationPlanV1(history.at(-1)), record = stage(latest, "platform_service");
  if (record.state !== "passed" || record.outcomeDigest !== settled.receipt.receiptDigest) return refused();
  return completed(input, latest, settled.receipt.receiptDigest);
}

async function agentReadiness(input: Captured, journal: Journal, current: InstallationPlanV1,
  source: Awaited<ReturnType<typeof captureAgentReadinessSource>>,
  runtime: ReturnType<typeof captureAgentReadinessRuntime>) {
  if (canonicalJson(current) !== canonicalJson(source.previous)) return refused();
  await append(journal, input.installationId, source.running, true);
  const runnerInput = Object.freeze({ admissionPreparationInput: source.admissionPreparationInput,
    privateStartupConfiguration: source.privateStartupConfiguration,
    startupAdmissionBinding: source.startupAdmissionBinding,
    ...(source.ownerAuthorizedRunnerProvider ? { ownerAuthorizedRunnerProvider: source.ownerAuthorizedRunnerProvider } : {}),
    ...(source.hermesQualificationRuntime ? { hermesQualificationRuntime: source.hermesQualificationRuntime } : {}) });
  const result = await runPrivateLocalHermesAdmissionV1(runnerInput, Object.freeze({ journal,
    signal: runtime.signal, controlDeadlineMs: runtime.controlDeadlineMs,
    confirmOwnerAttachedTerminal: runtime.confirmOwnerAttachedTerminal,
    ...(runtime.qualifyOwnerAuthorizedRunner ? { qualifyOwnerAuthorizedRunner: runtime.qualifyOwnerAuthorizedRunner } : {}) }));
  if (runnerInput.ownerAuthorizedRunnerProvider === undefined ? result.invokesHermes !== false : result.invokesHermes !== true) return refused();
  const settlement = Object.freeze({ runnerInput, terminalConfirmation: result.terminalConfirmation });
  let settled;
  try { settled = await confirmLocalHermesAdmissionTerminalV1(settlement, { journal }); }
  catch { settled = await confirmLocalHermesAdmissionTerminalV1(settlement, { journal }); }
  const history = await journal.readHistory();
  const latest = verifyInstallationPlanV1(history.at(-1)), record = stage(latest, "agent_readiness");
  if (record.state !== "passed" || record.outcomeDigest !== settled.receipt.receiptDigest) return refused();
  return completed(input, latest, settled.receipt.receiptDigest);
}

async function finalReview(input: Captured, journal: Journal, current: InstallationPlanV1,
  runtime: ReturnType<typeof captureFinalReviewRuntime>) {
  const terminal = await runPrivateInstallationFinalReviewV1({ installationId: input.installationId,
    installationPlan: current, topologyPlan: input.topologyPlan }, Object.freeze({ journal,
    signal: runtime.signal, controlDeadlineMs: runtime.controlDeadlineMs,
    confirmOwnerAttached: runtime.confirmOwnerAttached }));
  let settled;
  try { settled = await confirmPrivateInstallationFinalReviewV1({ terminal }, { journal }); }
  catch { settled = await confirmPrivateInstallationFinalReviewV1({ terminal }, { journal }); }
  const history = await journal.readHistory();
  const latest = verifyInstallationPlanV1(history.at(-1)), record = stage(latest, "final_review");
  if (record.state !== "passed" || record.outcomeDigest !== settled.terminal.confirmationDigest) return refused();
  return completed(input, latest, settled.terminal.confirmationDigest);
}

/**
 * Dispatches only the exact next journal stage. Every effectful accepted stage
 * starts and settles within one call; a retained running/uncertain stage is
 * refused on entry and therefore can never be automatically attempted again.
 */
export async function dispatchPrivateLocalSetupStageV1(inputValue: unknown,
  runtimeValue: Runtime): Promise<PrivateLocalSetupOrchestratorResultV1> {
  try {
    let input = captureInput(inputValue);
    const runtime = record(runtimeValue), journal = captureJournal(runtime.journal);
    let recoveryRuntime: PrivateRecoveryOwnerRuntimeV1 | undefined;
    let platformSource: PlatformServiceSource | undefined, platformRuntime: PrivateMacosServiceOwnerRuntimeV1 | undefined;
    let agentSource: Awaited<ReturnType<typeof captureAgentReadinessSource>> | undefined;
    let agentRuntime: ReturnType<typeof captureAgentReadinessRuntime> | undefined;
    let finalRuntime: ReturnType<typeof captureFinalReviewRuntime> | undefined;
    const runtimeShape = Object.keys(runtime).sort().join(",");
    if (input.requestedStage === "recovery" && Object.keys(runtime).sort().join(",") === "journal,recovery") {
      input = Object.freeze({ ...input, source: captureRecoverySource(input.source) });
      recoveryRuntime = capturePrivateRecoveryOwnerRuntimePortV1(runtime.recovery);
    }
    if (input.requestedStage === "platform_service") {
      const missing = runtimeShape === "journal";
      if (missing && Object.keys(record(input.source)).length === 0) { /* retained explicit blocker */ }
      else {
        platformSource = capturePlatformServiceSource(input.source, input);
        input = Object.freeze({ ...input, source: platformSource });
      }
      if (!missing) {
        if (runtimeShape !== "journal,platformService") return refused();
        platformRuntime = capturePlatformServiceRuntime(runtime.platformService);
        if (platformSource && canonicalJson(platformRuntime.reviewedServicePackageInput)
          !== canonicalJson(platformSource.request.servicePackageInput)) return refused();
      }
    }
    if (input.requestedStage === "agent_readiness") {
      const missing = runtimeShape === "journal";
      if (!missing) {
        if (runtimeShape !== "agentReadiness,journal") return refused();
        agentRuntime = captureAgentReadinessRuntime(runtime.agentReadiness);
      }
      if (missing && Object.keys(record(input.source)).length === 0) { /* retained explicit blocker */ }
      else {
        agentSource = await captureAgentReadinessSource(input.source, input);
        input = Object.freeze({ ...input, source: agentSource });
      }
    }
    if (input.requestedStage === "final_review") {
      if (Object.keys(record(input.source)).length !== 0) return refused();
      if (runtimeShape !== "journal") {
        if (runtimeShape !== "finalReview,journal") return refused();
        finalRuntime = captureFinalReviewRuntime(runtime.finalReview);
      }
    }
    const plan = await currentAndBound(journal, input);
    if (nextStage(plan) !== input.requestedStage) return refused();
    const selected = stage(plan, input.requestedStage);
    if (selected.state !== "not_started") return refused();
    if (input.requestedStage === "recovery") {
      const runtimeShape = Object.keys(runtime).sort().join(",");
      if (runtimeShape === "journal" && Object.keys(record(input.source)).length === 0)
        return blocked(input, plan, "recovery_private_adapter_missing");
      if (runtimeShape !== "journal,recovery" || !recoveryRuntime) return refused();
      return await recovery(input, journal, plan, recoveryRuntime);
    }
    if (input.requestedStage === "platform_service") {
      if (!platformRuntime) return blocked(input, plan, "macos_native_service_port_missing");
      if (!platformSource) return refused();
      return await platformService(input, journal, plan, platformSource, platformRuntime);
    }
    if (input.requestedStage === "agent_readiness") {
      if (!agentRuntime) return blocked(input, plan, "local_hermes_admission_runtime_missing");
      if (!agentSource) return refused();
      return await agentReadiness(input, journal, plan, agentSource, agentRuntime);
    }
    if (input.requestedStage === "final_review") {
      if (!finalRuntime) return blocked(input, plan, "final_review_runtime_missing");
      return await finalReview(input, journal, plan, finalRuntime);
    }
    if (input.requestedStage === "database_authority") {
      if (Object.keys(runtime).sort().join(",") !== "journal,postgres" || !runtime.postgres) return refused();
      return await database(input, journal, runtime.postgres as PrivatePostgresOwnerRuntimeV1);
    }
    if (input.requestedStage === "protected_data") {
      if (Object.keys(runtime).sort().join(",") !== "journal,protectedData" || !runtime.protectedData) return refused();
      return await protectedData(input, journal, plan, runtime.protectedData as PrivateProtectedRootOwnerRuntimeV1);
    }
    if (Object.keys(runtime).sort().join(",") !== "firstOwner,journal" || !runtime.firstOwner) return refused();
    return await firstOwner(input, journal, plan, runtime.firstOwner as PrivateFirstOwnerRuntimeV1);
  } catch { return refused(); }
}
