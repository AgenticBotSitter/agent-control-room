import { sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationActionPreparationV1 } from "./installation-action-preparation";
import { advanceInstallationPlanV1, verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { PRIVATE_PROTECTED_ROOT_OWNER_RUNNER_V1 } from "./private-protected-root-owner-runner";
import { prepareProtectedDataRecoveryOwnerActionV1 } from "./protected-data-recovery-owner-action";

/**
 * Durable settlement of the protected-data stage. This boundary accepts only
 * the exact terminal result of the retained private protected-root runner. It
 * has no filesystem, storage, database, credential, repair, or retry port.
 */
export const PROTECTED_DATA_ACTION_TRANSACTION_V1 =
  "control-room.protected-data-action-transaction/v1" as const;
export const PROTECTED_DATA_ACTION_REQUEST_V1 =
  "control-room.protected-data-action-transaction-request/v1" as const;
export const PROTECTED_DATA_ACTION_TERMINAL_CONFIRMATION_V1 =
  "control-room.protected-data-action-terminal-confirmation/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;

export type ProtectedDataActionTransactionRequestV1 = Readonly<{
  schema: typeof PROTECTED_DATA_ACTION_REQUEST_V1;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  databaseAuthorityOutcomeDigest: string;
  preparationDigest: string;
  priorProtectedDataBindingDigest: string;
  storageConfigurationDigest: string;
  storageNamespaceDigest: string;
  ownerActionRequestDigest: string;
  operation: "owner_create_private_data_root" | "verify_owner_private_data_root" | "bind_verified_protected_storage";
  performsEffect: false;
  touchesFilesystem: false;
  opensStorage: false;
  opensDatabase: false;
}>;

export type ProtectedDataActionTerminalConfirmationV1 = Readonly<{
  schema: typeof PROTECTED_DATA_ACTION_TERMINAL_CONFIRMATION_V1;
  installationId: string;
  transactionRequestDigest: string;
  ownerObservation: unknown;
  terminalState: "confirmed";
}>;

export type ProtectedDataActionTerminalReceiptV1 = Readonly<{
  schema: typeof PROTECTED_DATA_ACTION_TRANSACTION_V1;
  installationId: string;
  receiptDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  databaseAuthorityOutcomeDigest: string;
  preparationDigest: string;
  ownerActionRequestDigest: string;
  operation: ProtectedDataActionTransactionRequestV1["operation"];
  observationDigest: string;
  protectedDataBindingDigest: string;
  storageConfigurationDigest: string;
  storageNamespaceDigest: string;
  preflightReceiptDigest: string;
  createdDirectory: boolean;
  stage: "protected_data";
  performsEffect: false;
  touchesFilesystem: false;
  opensStorage: false;
  opensDatabase: false;
}>;

export type ProtectedDataActionTransactionResultV1 = Readonly<{
  receipt: ProtectedDataActionTerminalReceiptV1;
  replayed: boolean;
  createsReceiptStore: false;
  performsEffect: false;
  touchesFilesystem: false;
  opensStorage: false;
  opensDatabase: false;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const refuse = (): never => { throw new Error("protected_data_action_transaction_refused"); };

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value);
  if (names.some(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) return refuse();
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  const parsed = record(value), keys = Object.keys(parsed);
  if (keys.length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(parsed, name))
    || keys.some(name => !names.includes(name))) return refuse();
  return parsed;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refuse();
  return value;
}

function stage(plan: InstallationPlanV1, selected: "database_authority" | "protected_data") {
  const value = plan.stages.find(item => item.stage === selected);
  if (!value) return refuse();
  return value;
}

function ownerRequestDigest(request: unknown): string {
  return sha256Digest({ purpose: "protected-data-recovery-owner-action-request/v1", request });
}

function transactionRequestDigest(request: ProtectedDataActionTransactionRequestV1): string {
  return sha256Digest({ purpose: "protected-data-action-transaction-request/v1", request });
}

/** Rebuilds all public bindings and additionally pins the passed database outcome. */
export function prepareProtectedDataActionTransactionRequestV1(input: unknown): ProtectedDataActionTransactionRequestV1 {
  try {
    const envelope = exact(input, ["actionPreparation", "actionInput"]);
    const action = verifyInstallationActionPreparationV1(envelope.actionPreparation, envelope.actionInput);
    if (action.action !== "protected_data" || action.stage !== "protected_data") return refuse();
    const actionInput = record(envelope.actionInput);
    const plan = verifyInstallationPlanV1(actionInput.installationPlan);
    if (plan.planDigest !== action.installationPlanDigest || plan.revision !== action.installationPlanRevision
      || plan.topologyPlanDigest !== action.topologyPlanDigest || plan.releaseDigest !== action.releaseDigest) return refuse();
    const database = stage(plan, "database_authority"), protectedData = stage(plan, "protected_data");
    if (database.state !== "passed" || database.outcomeDigest === undefined || protectedData.state !== "running") return refuse();
    const prepared = record(action.preparedAction);
    const ownerRequest = prepareProtectedDataRecoveryOwnerActionV1(envelope);
    if (ownerRequest.action !== "protected_data" || ownerRequest.stage !== "protected_data") return refuse();
    return Object.freeze({ schema: PROTECTED_DATA_ACTION_REQUEST_V1,
      installationPlanDigest: action.installationPlanDigest, installationPlanRevision: action.installationPlanRevision,
      topologyPlanDigest: action.topologyPlanDigest, releaseDigest: action.releaseDigest,
      databaseAuthorityOutcomeDigest: digest(database.outcomeDigest), preparationDigest: digest(prepared.preparationDigest),
      priorProtectedDataBindingDigest: digest(prepared.protectedDataBindingDigest),
      storageConfigurationDigest: digest(prepared.storageConfigurationDigest),
      storageNamespaceDigest: digest(prepared.storageNamespaceDigest), ownerActionRequestDigest: ownerRequestDigest(ownerRequest),
      operation: ownerRequest.operation as ProtectedDataActionTransactionRequestV1["operation"],
      performsEffect: false as const, touchesFilesystem: false as const, opensStorage: false as const, opensDatabase: false as const });
  } catch { return refuse(); }
}

function terminalObservation(value: unknown, installationId: string, request: ProtectedDataActionTransactionRequestV1) {
  const confirmation = exact(value, ["schema", "installationId", "transactionRequestDigest", "ownerObservation", "terminalState"]);
  if (confirmation.schema !== PROTECTED_DATA_ACTION_TERMINAL_CONFIRMATION_V1 || confirmation.installationId !== installationId
    || confirmation.transactionRequestDigest !== transactionRequestDigest(request) || confirmation.terminalState !== "confirmed") return refuse();
  const observation = exact(confirmation.ownerObservation, ["schema", "requestDigest", "operation", "observedState", "observationDigest",
    "protectedDataBindingDigest", "storageConfigurationDigest", "storageNamespaceDigest", "preflightReceiptDigest", "createdDirectory"]);
  if (observation.schema !== PRIVATE_PROTECTED_ROOT_OWNER_RUNNER_V1
    || observation.requestDigest !== request.ownerActionRequestDigest || observation.operation !== request.operation
    || observation.observedState !== "verified" || observation.storageConfigurationDigest !== request.storageConfigurationDigest
    || observation.storageNamespaceDigest !== request.storageNamespaceDigest || typeof observation.createdDirectory !== "boolean") return refuse();
  if ((request.operation === "owner_create_private_data_root") !== observation.createdDirectory) return refuse();
  const observationDigest = digest(observation.observationDigest);
  const protectedDataBindingDigest = digest(observation.protectedDataBindingDigest);
  if (protectedDataBindingDigest !== sha256Digest({ purpose: "protected-data-evidence-binding/v1",
    releaseDigest: request.releaseDigest, storageConfigurationDigest: request.storageConfigurationDigest,
    storageNamespaceDigest: request.storageNamespaceDigest, observedState: "verified", observationDigest })) return refuse();
  return Object.freeze({ observationDigest, protectedDataBindingDigest,
    preflightReceiptDigest: digest(observation.preflightReceiptDigest), createdDirectory: observation.createdDirectory as boolean });
}

function receiptFor(installationId: string, request: ProtectedDataActionTransactionRequestV1,
  terminal: ReturnType<typeof terminalObservation>): ProtectedDataActionTerminalReceiptV1 {
  const body = { schema: PROTECTED_DATA_ACTION_TRANSACTION_V1, installationId,
    installationPlanDigest: request.installationPlanDigest, installationPlanRevision: request.installationPlanRevision,
    topologyPlanDigest: request.topologyPlanDigest, releaseDigest: request.releaseDigest,
    databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest, preparationDigest: request.preparationDigest,
    ownerActionRequestDigest: request.ownerActionRequestDigest, operation: request.operation,
    observationDigest: terminal.observationDigest, protectedDataBindingDigest: terminal.protectedDataBindingDigest,
    storageConfigurationDigest: request.storageConfigurationDigest, storageNamespaceDigest: request.storageNamespaceDigest,
    preflightReceiptDigest: terminal.preflightReceiptDigest, createdDirectory: terminal.createdDirectory,
    stage: "protected_data" as const, performsEffect: false as const, touchesFilesystem: false as const,
    opensStorage: false as const, opensDatabase: false as const };
  return Object.freeze({ ...body,
    receiptDigest: sha256Digest({ purpose: "protected-data-action-terminal-receipt/v1", receipt: body }) });
}

function current(history: readonly InstallationPlanV1[]): InstallationPlanV1 {
  const plan = history.at(-1);
  if (!plan) return refuse();
  return plan;
}

function expectedPlan(history: readonly InstallationPlanV1[], receipt: ProtectedDataActionTerminalReceiptV1) {
  const plan = history[receipt.installationPlanRevision];
  if (!plan || plan.planDigest !== receipt.installationPlanDigest || plan.topologyPlanDigest !== receipt.topologyPlanDigest
    || plan.releaseDigest !== receipt.releaseDigest || stage(plan, "protected_data").state !== "running"
    || stage(plan, "database_authority").state !== "passed"
    || stage(plan, "database_authority").outcomeDigest !== receipt.databaseAuthorityOutcomeDigest) return refuse();
  return plan;
}

function recovered(history: readonly InstallationPlanV1[], receipt: ProtectedDataActionTerminalReceiptV1): boolean {
  const settled = history[receipt.installationPlanRevision + 1];
  if (!settled) return false;
  const terminal = stage(settled, "protected_data");
  if (settled.revision !== receipt.installationPlanRevision + 1 || terminal.state !== "passed"
    || terminal.recordedRevision !== settled.revision || terminal.outcomeDigest !== receipt.protectedDataBindingDigest) return refuse();
  const present = stage(current(history), "protected_data");
  if (present.state !== "passed" || present.outcomeDigest !== receipt.protectedDataBindingDigest) return refuse();
  return true;
}

async function assertJournalIdentity(journal: Journal, installationId: string, plan: InstallationPlanV1) {
  let appended;
  try { appended = await journal.append(plan); } catch { return refuse(); }
  if (appended.installationId !== installationId || appended.revision !== plan.revision
    || appended.planDigest !== plan.planDigest) return refuse();
  return appended;
}

function captureJournal(value: unknown): Journal {
  if (!value || typeof value !== "object") return refuse();
  const journal = value as Journal;
  if (typeof journal.append !== "function" || typeof journal.readHistory !== "function") return refuse();
  return Object.freeze({ append: journal.append.bind(value), readHistory: journal.readHistory.bind(value) });
}

function result(receipt: ProtectedDataActionTerminalReceiptV1, replayed: boolean): ProtectedDataActionTransactionResultV1 {
  return Object.freeze({ receipt, replayed, createsReceiptStore: false as const, performsEffect: false as const,
    touchesFilesystem: false as const, opensStorage: false as const, opensDatabase: false as const });
}

/**
 * Appends one plan revision only after exact terminal protected-root evidence.
 * The stage outcome is deliberately the protected-data binding, never this
 * adapter's receipt digest, so recovery preparation consumes the same binding.
 */
export async function confirmProtectedDataActionTerminalV1(input: unknown,
  runtime: Readonly<{ journal: Journal }>): Promise<ProtectedDataActionTransactionResultV1> {
  const envelope = exact(input, ["installationId", "actionPreparation", "actionInput", "terminalObservation"]);
  if (typeof envelope.installationId !== "string" || !installationIdPattern.test(envelope.installationId)) return refuse();
  const journal = captureJournal(runtime?.journal);
  const request = prepareProtectedDataActionTransactionRequestV1({ actionPreparation: envelope.actionPreparation,
    actionInput: envelope.actionInput });
  const terminal = terminalObservation(envelope.terminalObservation, envelope.installationId, request);
  const receipt = receiptFor(envelope.installationId, request, terminal);
  try {
    let history = await journal.readHistory();
    const original = expectedPlan(history, receipt);
    await assertJournalIdentity(journal, envelope.installationId, original);
    history = await journal.readHistory();
    expectedPlan(history, receipt);
    if (recovered(history, receipt)) return result(receipt, true);
    if (history.length !== receipt.installationPlanRevision + 1) return refuse();
    const next = advanceInstallationPlanV1(history.at(-1), { expectedRevision: receipt.installationPlanRevision,
      stage: "protected_data", action: "pass", outcomeDigest: receipt.protectedDataBindingDigest });
    const appended = await assertJournalIdentity(journal, envelope.installationId, next);
    return result(receipt, appended.replayed);
  } catch {
    try {
      const history = await journal.readHistory();
      const prior = expectedPlan(history, receipt);
      await assertJournalIdentity(journal, envelope.installationId, prior);
      if (recovered(history, receipt)) return result(receipt, true);
    } catch { /* Missing, changed, stale, or uncertain evidence remains owner attention. */ }
    return refuse();
  }
}
