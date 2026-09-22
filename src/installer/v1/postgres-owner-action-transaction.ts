import { sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { advanceInstallationPlanV1, refreshInstallationPlanV1, verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { preparePostgresOwnerActionV1, type PostgresOwnerActionRequestV1 } from "./postgres-owner-action";
import { postgresSetupStageInputDigestV1 } from "./postgres-setup-preparation";

/**
 * The durable, terminal-confirmed boundary for the first PostgreSQL owner
 * action. It records no connection detail, command, credential, or database
 * observation: the existing append-only installation-plan journal is the one
 * receipt store. A caller can only settle an already-running exact plan.
 */
export const POSTGRES_OWNER_ACTION_TRANSACTION_V1 = "control-room.postgres-owner-action-transaction/v1" as const;
export const POSTGRES_OWNER_ACTION_TERMINAL_CONFIRMATION_V1 =
  "control-room.postgres-owner-action-terminal-confirmation/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;

export type PostgresOwnerActionTerminalReceiptV1 = Readonly<{
  schema: typeof POSTGRES_OWNER_ACTION_TRANSACTION_V1;
  installationId: string;
  receiptDigest: string;
  requestDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  stage: "database_authority";
  operation: PostgresOwnerActionRequestV1["operation"];
  terminalEvidenceDigest: string;
  performsEffect: false;
  startsProcess: false;
  opensNetwork: false;
  runsSql: false;
}>;

export type PostgresOwnerActionTransactionResultV1 = Readonly<{
  receipt: PostgresOwnerActionTerminalReceiptV1;
  replayed: boolean;
  createsReceiptStore: false;
  performsEffect: false;
  startsProcess: false;
  opensNetwork: false;
  runsSql: false;
}>;

export type PostgresOwnerActionStartResultV1 = Readonly<{
  installationPlan: InstallationPlanV1;
  replayed: boolean;
  performsEffect: false;
  startsProcess: false;
  opensNetwork: false;
  runsSql: false;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const refuse = (): never => { throw new Error("postgres_owner_action_transaction_refused"); };

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

function requestDigest(request: PostgresOwnerActionRequestV1): string {
  return sha256Digest({ purpose: "postgres-owner-action-request/v1", request });
}

function terminalConfirmation(value: unknown, expectedRequestDigest: string): string {
  const confirmation = exact(value, ["schema", "requestDigest", "terminalEvidenceDigest", "terminalState"]);
  if (confirmation.schema !== POSTGRES_OWNER_ACTION_TERMINAL_CONFIRMATION_V1
    || confirmation.requestDigest !== expectedRequestDigest || confirmation.terminalState !== "confirmed") return refuse();
  return digest(confirmation.terminalEvidenceDigest);
}

function receiptFor(installationId: string, request: PostgresOwnerActionRequestV1,
  terminalEvidenceDigest: string): PostgresOwnerActionTerminalReceiptV1 {
  const preparedRequestDigest = requestDigest(request);
  const body = { schema: POSTGRES_OWNER_ACTION_TRANSACTION_V1, installationId, requestDigest: preparedRequestDigest,
    installationPlanDigest: request.installationPlanDigest, installationPlanRevision: request.installationPlanRevision,
    stage: "database_authority" as const, operation: request.operation, terminalEvidenceDigest,
    performsEffect: false as const, startsProcess: false as const, opensNetwork: false as const, runsSql: false as const };
  return Object.freeze({ ...body, receiptDigest: sha256Digest({ purpose: "postgres-owner-action-terminal-receipt/v1", receipt: body }) });
}

function stage(plan: InstallationPlanV1) {
  const value = plan.stages.find(item => item.stage === "database_authority");
  if (!value) return refuse();
  return value;
}

function expectedPlan(history: readonly InstallationPlanV1[], receipt: PostgresOwnerActionTerminalReceiptV1): InstallationPlanV1 {
  const plan = history[receipt.installationPlanRevision];
  if (!plan || plan.planDigest !== receipt.installationPlanDigest || stage(plan).state !== "running") return refuse();
  return plan;
}

function recovered(history: readonly InstallationPlanV1[], receipt: PostgresOwnerActionTerminalReceiptV1): boolean {
  const settled = history[receipt.installationPlanRevision + 1];
  if (!settled) return false;
  const terminal = stage(settled);
  if (settled.revision !== receipt.installationPlanRevision + 1 || terminal.state !== "passed"
    || terminal.recordedRevision !== settled.revision || terminal.outcomeDigest !== receipt.receiptDigest) return refuse();
  // Historical evidence alone is not replay authority. A later refresh may
  // retain this old pass while resetting database_authority for new inputs.
  const present = stage(current(history));
  if (present.state !== "passed" || present.outcomeDigest !== receipt.receiptDigest) return refuse();
  return true;
}

function result(receipt: PostgresOwnerActionTerminalReceiptV1, replayed: boolean): PostgresOwnerActionTransactionResultV1 {
  return Object.freeze({ receipt, replayed, createsReceiptStore: false as const, performsEffect: false as const,
    startsProcess: false as const, opensNetwork: false as const, runsSql: false as const });
}

function current(history: readonly InstallationPlanV1[]): InstallationPlanV1 {
  const plan = history.at(-1);
  if (!plan) return refuse();
  return plan;
}

/** A journal replay is also the only trustworthy binding to its installation id. */
async function assertJournalIdentity(journal: Journal, installationId: string, plan: InstallationPlanV1) {
  let appended;
  try { appended = await journal.append(plan); }
  catch { return refuse(); }
  if (appended.installationId !== installationId || appended.revision !== plan.revision
    || appended.planDigest !== plan.planDigest) return refuse();
  return appended;
}

function expectedDatabaseInput(input: Readonly<Record<string, unknown>>): string {
  return postgresSetupStageInputDigestV1({ releaseDigest: input.releaseDigest, ledgerDigest: input.ledgerDigest,
    targetIdentityDigest: input.targetIdentityDigest });
}

/**
 * Binds the immutable PostgreSQL inputs and durably records `running` before
 * the existing preparation seam can name an owner action. It has no tool port,
 * so neither a fresh start nor a replay can invoke PostgreSQL. A retained
 * running stage is recovery information only; changed or uncertain state is
 * refused rather than reset or retried.
 */
export async function startPostgresOwnerActionV1(input: unknown,
  runtime: Readonly<{ journal: Journal }>): Promise<PostgresOwnerActionStartResultV1> {
  const envelope = exact(input, ["installationId", "topologyPlan", "releaseDigest", "ledgerDigest", "targetIdentityDigest"]);
  if (typeof envelope.installationId !== "string" || !installationIdPattern.test(envelope.installationId)
    || !runtime?.journal || typeof runtime.journal.append !== "function" || typeof runtime.journal.readHistory !== "function") return refuse();
  const topology = verifyInstallationTopologyPlanV1(envelope.topologyPlan);
  const releaseDigest = digest(envelope.releaseDigest), databaseInput = expectedDatabaseInput(envelope);
  let history: readonly InstallationPlanV1[];
  try { history = await runtime.journal.readHistory(); }
  catch { return refuse(); }
  let plan = current(history);
  await assertJournalIdentity(runtime.journal, envelope.installationId, plan);
  let database = stage(plan);
  if (plan.topologyPlanDigest !== topology.planDigest || plan.releaseDigest !== releaseDigest) return refuse();
  if (database.state === "running") {
    if (database.inputDigest !== databaseInput) return refuse();
    return Object.freeze({ installationPlan: plan, replayed: true, performsEffect: false as const,
      startsProcess: false as const, opensNetwork: false as const, runsSql: false as const });
  }
  if (database.state !== "not_started") return refuse();

  const stageInputDigests = Object.fromEntries(plan.stages.map(item => [item.stage,
    item.stage === "database_authority" ? databaseInput : item.inputDigest]));
  const refreshed = refreshInstallationPlanV1(plan, { topologyPlan: topology, releaseDigest, stageInputDigests });
  if (refreshed.planDigest !== plan.planDigest) {
    await assertJournalIdentity(runtime.journal, envelope.installationId, refreshed);
    plan = refreshed;
  }
  database = stage(plan);
  if (database.state !== "not_started" || database.inputDigest !== databaseInput) return refuse();
  const running = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "database_authority", action: "start" });
  try {
    const appended = await assertJournalIdentity(runtime.journal, envelope.installationId, running);
    return Object.freeze({ installationPlan: running, replayed: appended.replayed, performsEffect: false as const,
      startsProcess: false as const, opensNetwork: false as const, runsSql: false as const });
  } catch {
    try {
      history = await runtime.journal.readHistory();
      plan = current(history); await assertJournalIdentity(runtime.journal, envelope.installationId, plan); database = stage(plan);
      if (database.state === "running" && database.inputDigest === databaseInput) return Object.freeze({
        installationPlan: plan, replayed: true as const, performsEffect: false as const, startsProcess: false as const,
        opensNetwork: false as const, runsSql: false as const });
    } catch { /* The owner must inspect an unsettled or changed journal. */ }
    return refuse();
  }
}

/**
 * Persists one terminal receipt by advancing the existing running database
 * stage to `passed`. The supplied terminal confirmation is private-wrapper
 * input, not a browser assertion. Its evidence remains an opaque digest.
 *
 * This function never invokes the PostgreSQL tools. If an effect completed but
 * terminal confirmation is absent or uncertain, this boundary must not be
 * called to guess a pass; the still-running plan remains owner attention.
 */
export async function confirmPostgresOwnerActionTerminalV1(input: unknown,
  runtime: Readonly<{ journal: Journal }>): Promise<PostgresOwnerActionTransactionResultV1> {
  const envelope = exact(input, ["installationId", "actionPreparation", "actionInput", "terminalConfirmation"]);
  if (typeof envelope.installationId !== "string" || !installationIdPattern.test(envelope.installationId)) return refuse();
  if (!runtime?.journal || typeof runtime.journal.append !== "function" || typeof runtime.journal.readHistory !== "function") return refuse();
  const request = preparePostgresOwnerActionV1({ actionPreparation: envelope.actionPreparation, actionInput: envelope.actionInput });
  if (request.operation !== "collect_existing_database_evidence") return refuse();
  const terminalEvidenceDigest = terminalConfirmation(envelope.terminalConfirmation, requestDigest(request));
  const receipt = receiptFor(envelope.installationId, request, terminalEvidenceDigest);

  let history: readonly InstallationPlanV1[];
  try { history = await runtime.journal.readHistory(); }
  catch { return refuse(); }
  const original = expectedPlan(history, receipt);
  await assertJournalIdentity(runtime.journal, envelope.installationId, original);
  if (recovered(history, receipt)) return result(receipt, true);
  if (history.length !== receipt.installationPlanRevision + 1) return refuse();

  const next = advanceInstallationPlanV1(history.at(-1), { expectedRevision: receipt.installationPlanRevision,
    stage: "database_authority", action: "pass", outcomeDigest: receipt.receiptDigest });
  try {
    const appended = await assertJournalIdentity(runtime.journal, envelope.installationId, next);
    return result(receipt, appended.replayed);
  } catch {
    try {
      history = await runtime.journal.readHistory();
      const prior = expectedPlan(history, receipt);
      await assertJournalIdentity(runtime.journal, envelope.installationId, prior);
      if (recovered(history, receipt)) return result(receipt, true);
    } catch { /* The terminal state is absent, changed, or uncertain. */ }
    return refuse();
  }
}
