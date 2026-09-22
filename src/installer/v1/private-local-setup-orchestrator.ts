import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
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

/**
 * Private, source-only dispatcher over the accepted installation journal and
 * stage runners. It owns no state machine, store, scheduler, browser/native
 * port, retry loop, or recovery implementation.
 */
export const PRIVATE_LOCAL_SETUP_ORCHESTRATOR_V1 =
  "control-room.private-local-setup-orchestrator/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;
type Stage = "database_authority" | "protected_data" | "first_owner" | "recovery" | "platform_service";
type Runtime = Readonly<{ journal: Journal; postgres?: PrivatePostgresOwnerRuntimeV1;
  protectedData?: PrivateProtectedRootOwnerRuntimeV1; firstOwner?: PrivateFirstOwnerRuntimeV1;
  recovery?: PrivateRecoveryOwnerRuntimeV1 }>;

export type PrivateLocalSetupOrchestratorResultV1 = Readonly<{
  schema: typeof PRIVATE_LOCAL_SETUP_ORCHESTRATOR_V1;
  installationId: string;
  requestedStage: Stage;
  status: "completed" | "blocked";
  installationPlan: InstallationPlanV1;
  receiptDigest?: string;
  blocker?: "recovery_private_adapter_missing" | "macos_native_service_port_missing";
  replayed: false;
  createsStateMachine: false;
  createsReceiptStore: false;
  startsScheduler: false;
  exposesBrowserEffect: false;
  suppliesNativeEffect: false;
  retriesUncertainEffect: false;
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
    || value === "first_owner" || value === "recovery" || value === "platform_service") return value;
  return refused();
}

function nextStage(plan: InstallationPlanV1): Stage {
  const next = plan.stages.find(item => item.state !== "passed");
  if (!next) return refused();
  if (next.stage === "release_preflight" || next.stage === "private_placement") return refused();
  if (next.stage === "database_authority" || next.stage === "protected_data" || next.stage === "first_owner"
    || next.stage === "recovery" || next.stage === "platform_service") return next.stage;
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
  selected: "protected_data" | "first_owner" | "recovery", stageInputDigest: string): Promise<InstallationPlanV1> {
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
    startsScheduler: false, exposesBrowserEffect: false, suppliesNativeEffect: false, retriesUncertainEffect: false });
}

function blocked(input: Captured, plan: InstallationPlanV1,
  blocker: "recovery_private_adapter_missing" | "macos_native_service_port_missing"): PrivateLocalSetupOrchestratorResultV1 {
  return Object.freeze({ schema: PRIVATE_LOCAL_SETUP_ORCHESTRATOR_V1, installationId: input.installationId,
    requestedStage: input.requestedStage, status: "blocked", installationPlan: plan, blocker, replayed: false,
    createsStateMachine: false, createsReceiptStore: false, startsScheduler: false, exposesBrowserEffect: false,
    suppliesNativeEffect: false, retriesUncertainEffect: false });
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
    if (input.requestedStage === "recovery" && Object.keys(runtime).sort().join(",") === "journal,recovery") {
      input = Object.freeze({ ...input, source: captureRecoverySource(input.source) });
      recoveryRuntime = capturePrivateRecoveryOwnerRuntimePortV1(runtime.recovery);
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
      if (Object.keys(runtime).sort().join(",") !== "journal" || Object.keys(record(input.source)).length !== 0) return refused();
      return blocked(input, plan, "macos_native_service_port_missing");
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
