import { sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationActionPreparationV1 } from "./installation-action-preparation";
import { advanceInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";

/**
 * Durable settlement for the retained first-owner ceremony. This module is a
 * journal adapter, not an identity or bootstrap implementation: it accepts no
 * assertion, code, credential, database handle, listener, filesystem path, or
 * effect port. The existing ceremony and private owner command remain the only
 * components that may create the owner.
 */
export const FIRST_OWNER_ACTION_TRANSACTION_V1 = "control-room.first-owner-action-transaction/v1" as const;
export const FIRST_OWNER_ACTION_REQUEST_V1 = "control-room.first-owner-action-request/v1" as const;
export const FIRST_OWNER_ACTION_TERMINAL_CONFIRMATION_V1 =
  "control-room.first-owner-action-terminal-confirmation/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;

export type FirstOwnerActionRequestV1 = Readonly<{
  schema: typeof FIRST_OWNER_ACTION_REQUEST_V1;
  installationPlanDigest: string;
  installationPlanRevision: number;
  releaseDigest: string;
  databaseAuthorityOutcomeDigest: string;
  preparationDigest: string;
  expectedOwnerSubjectDigest: string;
  initialOwnerState: "empty";
  initialOwnerProofDigest: string;
  operation: "arm_existing_owner_bootstrap_ceremony";
  performsEffect: false;
  acceptsAssertion: false;
  acceptsOneTimeCode: false;
  createsOwner: false;
  opensDatabase: false;
  startsListener: false;
}>;

export type FirstOwnerActionTerminalConfirmationV1 = Readonly<{
  schema: typeof FIRST_OWNER_ACTION_TERMINAL_CONFIRMATION_V1;
  installationId: string;
  requestDigest: string;
  expectedOwnerSubjectDigest: string;
  ownerConfirmed: true;
  ownerState: "existing";
  ownerProofDigest: string;
  ceremonyOutcomeDigest: string;
  terminalState: "confirmed";
}>;

export type FirstOwnerActionTerminalReceiptV1 = Readonly<{
  schema: typeof FIRST_OWNER_ACTION_TRANSACTION_V1;
  installationId: string;
  receiptDigest: string;
  requestDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  stage: "first_owner";
  operation: FirstOwnerActionRequestV1["operation"];
  databaseAuthorityOutcomeDigest: string;
  expectedOwnerSubjectDigest: string;
  ownerState: "existing";
  ownerProofDigest: string;
  ceremonyOutcomeDigest: string;
  performsEffect: false;
  createsOwner: false;
  opensDatabase: false;
  startsListener: false;
}>;

export type FirstOwnerActionTransactionResultV1 = Readonly<{
  receipt: FirstOwnerActionTerminalReceiptV1;
  replayed: boolean;
  createsReceiptStore: false;
  performsEffect: false;
  createsOwner: false;
  opensDatabase: false;
  startsListener: false;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const refuse = (): never => { throw new Error("first_owner_action_transaction_refused"); };

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

/** Rebuilds the exact effect-free request from the existing preparation. */
export function prepareFirstOwnerActionTransactionRequestV1(input: unknown): FirstOwnerActionRequestV1 {
  try {
    const envelope = exact(input, ["actionPreparation", "actionInput"]);
    const action = verifyInstallationActionPreparationV1(envelope.actionPreparation, envelope.actionInput);
    if (action.action !== "first_owner" || action.stage !== "first_owner") return refuse();
    const prepared = record(action.preparedAction);
    if (prepared.schema !== "control-room.first-owner-setup-preparation/v1"
      || prepared.nextOperation !== "arm_existing_owner_bootstrap_ceremony"
      || prepared.precondition !== "empty_owner_target_and_owner_attendance"
      || prepared.observedOwnerState !== "empty"
      || prepared.createsOwner !== false || prepared.opensDatabase !== false
      || prepared.startsListener !== false || prepared.acceptsAssertion !== false
      || prepared.acceptsOneTimeCode !== false) return refuse();
    return Object.freeze({ schema: FIRST_OWNER_ACTION_REQUEST_V1,
      installationPlanDigest: action.installationPlanDigest,
      installationPlanRevision: action.installationPlanRevision,
      releaseDigest: action.releaseDigest,
      databaseAuthorityOutcomeDigest: digest(prepared.databaseAuthorityOutcomeDigest),
      preparationDigest: digest(prepared.preparationDigest),
      expectedOwnerSubjectDigest: digest(prepared.expectedOwnerSubjectDigest),
      initialOwnerState: "empty" as const,
      initialOwnerProofDigest: digest(prepared.observationDigest),
      operation: "arm_existing_owner_bootstrap_ceremony" as const,
      performsEffect: false as const, acceptsAssertion: false as const, acceptsOneTimeCode: false as const,
      createsOwner: false as const, opensDatabase: false as const, startsListener: false as const });
  } catch { return refuse(); }
}

function requestDigest(request: FirstOwnerActionRequestV1): string {
  return sha256Digest({ purpose: "first-owner-action-request/v1", request });
}

function terminalConfirmation(value: unknown, installationId: string, request: FirstOwnerActionRequestV1) {
  const confirmation = exact(value, ["schema", "installationId", "requestDigest", "expectedOwnerSubjectDigest", "ownerConfirmed",
    "ownerState", "ownerProofDigest", "ceremonyOutcomeDigest", "terminalState"]);
  if (confirmation.schema !== FIRST_OWNER_ACTION_TERMINAL_CONFIRMATION_V1
    || confirmation.installationId !== installationId
    || confirmation.requestDigest !== requestDigest(request)
    || confirmation.expectedOwnerSubjectDigest !== request.expectedOwnerSubjectDigest
    || confirmation.ownerConfirmed !== true || confirmation.ownerState !== "existing"
    || confirmation.terminalState !== "confirmed") return refuse();
  return Object.freeze({ ownerProofDigest: digest(confirmation.ownerProofDigest),
    ceremonyOutcomeDigest: digest(confirmation.ceremonyOutcomeDigest) });
}

function receiptFor(installationId: string, request: FirstOwnerActionRequestV1,
  confirmation: Readonly<{ ownerProofDigest: string; ceremonyOutcomeDigest: string }>): FirstOwnerActionTerminalReceiptV1 {
  const body = { schema: FIRST_OWNER_ACTION_TRANSACTION_V1, installationId,
    requestDigest: requestDigest(request), installationPlanDigest: request.installationPlanDigest,
    installationPlanRevision: request.installationPlanRevision, stage: "first_owner" as const,
    operation: request.operation, databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest,
    expectedOwnerSubjectDigest: request.expectedOwnerSubjectDigest, ownerState: "existing" as const,
    ownerProofDigest: confirmation.ownerProofDigest, ceremonyOutcomeDigest: confirmation.ceremonyOutcomeDigest,
    performsEffect: false as const, createsOwner: false as const, opensDatabase: false as const,
    startsListener: false as const };
  return Object.freeze({ ...body,
    receiptDigest: sha256Digest({ purpose: "first-owner-action-terminal-receipt/v1", receipt: body }) });
}

function stage(plan: InstallationPlanV1) {
  const value = plan.stages.find(item => item.stage === "first_owner");
  if (!value) return refuse();
  return value;
}

function current(history: readonly InstallationPlanV1[]): InstallationPlanV1 {
  const plan = history.at(-1);
  if (!plan) return refuse();
  return plan;
}

function expectedPlan(history: readonly InstallationPlanV1[], receipt: FirstOwnerActionTerminalReceiptV1) {
  const plan = history[receipt.installationPlanRevision];
  if (!plan || plan.planDigest !== receipt.installationPlanDigest || stage(plan).state !== "running") return refuse();
  return plan;
}

function recovered(history: readonly InstallationPlanV1[], receipt: FirstOwnerActionTerminalReceiptV1): boolean {
  const settled = history[receipt.installationPlanRevision + 1];
  if (!settled) return false;
  const terminal = stage(settled);
  if (settled.revision !== receipt.installationPlanRevision + 1 || terminal.state !== "passed"
    || terminal.recordedRevision !== settled.revision || terminal.outcomeDigest !== receipt.receiptDigest) return refuse();
  const present = stage(current(history));
  if (present.state !== "passed" || present.outcomeDigest !== receipt.receiptDigest) return refuse();
  return true;
}

async function assertJournalIdentity(journal: Journal, installationId: string, plan: InstallationPlanV1) {
  let appended;
  try { appended = await journal.append(plan); } catch { return refuse(); }
  if (appended.installationId !== installationId || appended.revision !== plan.revision
    || appended.planDigest !== plan.planDigest) return refuse();
  return appended;
}

function result(receipt: FirstOwnerActionTerminalReceiptV1, replayed: boolean): FirstOwnerActionTransactionResultV1 {
  return Object.freeze({ receipt, replayed, createsReceiptStore: false as const, performsEffect: false as const,
    createsOwner: false as const, opensDatabase: false as const, startsListener: false as const });
}

/**
 * Appends one terminal first-owner receipt after a private wrapper has both
 * completed the retained ceremony and independently proved the exact expected
 * owner. Intermediate arming/preparation output is deliberately insufficient.
 */
export async function confirmFirstOwnerActionTerminalV1(input: unknown,
  runtime: Readonly<{ journal: Journal }>): Promise<FirstOwnerActionTransactionResultV1> {
  const envelope = exact(input, ["installationId", "actionPreparation", "actionInput", "terminalConfirmation"]);
  if (typeof envelope.installationId !== "string" || !installationIdPattern.test(envelope.installationId)
    || !runtime?.journal || typeof runtime.journal.append !== "function"
    || typeof runtime.journal.readHistory !== "function") return refuse();
  const request = prepareFirstOwnerActionTransactionRequestV1({ actionPreparation: envelope.actionPreparation,
    actionInput: envelope.actionInput });
  const confirmation = terminalConfirmation(envelope.terminalConfirmation, envelope.installationId, request);
  const receipt = receiptFor(envelope.installationId, request, confirmation);

  try {
    let history = await runtime.journal.readHistory();
    const original = expectedPlan(history, receipt);
    await assertJournalIdentity(runtime.journal, envelope.installationId, original);
    history = await runtime.journal.readHistory();
    expectedPlan(history, receipt);
    if (recovered(history, receipt)) return result(receipt, true);
    if (history.length !== receipt.installationPlanRevision + 1) return refuse();
    const next = advanceInstallationPlanV1(history.at(-1), { expectedRevision: receipt.installationPlanRevision,
      stage: "first_owner", action: "pass", outcomeDigest: receipt.receiptDigest });
    const appended = await assertJournalIdentity(runtime.journal, envelope.installationId, next);
    return result(receipt, appended.replayed);
  } catch {
    try {
      const history = await runtime.journal.readHistory();
      const prior = expectedPlan(history, receipt);
      await assertJournalIdentity(runtime.journal, envelope.installationId, prior);
      if (recovered(history, receipt)) return result(receipt, true);
    } catch { /* Missing, changed, or uncertain owner outcome remains owner attention. */ }
    return refuse();
  }
}
