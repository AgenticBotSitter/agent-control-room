import { sha256Digest } from "../../security/canonical-digest";
import { advanceInstallationPlanV1, verifyInstallationPlanV1,
  type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { PRIVATE_LOCAL_HERMES_ADMISSION_TERMINAL_CONFIRMATION_V1,
  preparePrivateLocalHermesAdmissionRequestV1,
  type PrivateLocalHermesAdmissionRequestV1,
  type PrivateLocalHermesAdmissionTerminalConfirmationV1 } from "./private-local-hermes-admission-runner";

export const LOCAL_HERMES_ADMISSION_TRANSACTION_V1 =
  "control-room.local-hermes-admission-transaction/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;

export type LocalHermesAdmissionTerminalReceiptV1 = Readonly<{
  schema: typeof LOCAL_HERMES_ADMISSION_TRANSACTION_V1;
  installationId: string;
  receiptDigest: string;
  requestDigest: string;
  admissionRequestDigest: string;
  privateStartupBindingDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  installationBindingDigest: string;
  lifecycleContractDigest: string;
  stage: "agent_readiness";
  taskClass: "text_review";
  passesFinalReview: false;
  invokesHermes: false;
  startsService: false;
  startsWork: false;
  enablesWorker: false;
  grantsExecutionAuthority: false;
  createsReceiptStore: false;
}>;

export type LocalHermesAdmissionTransactionResultV1 = Readonly<{
  receipt: LocalHermesAdmissionTerminalReceiptV1;
  replayed: boolean;
  passesFinalReview: false;
  invokesHermes: false;
  startsService: false;
  startsWork: false;
  enablesWorker: false;
  grantsExecutionAuthority: false;
  createsReceiptStore: false;
}>;

const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const refuse = (): never => { throw new Error("local_hermes_admission_transaction_refused"); };
function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(name => !Object.prototype.hasOwnProperty.call(value, name)) || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refuse();
  return value as Readonly<Record<string, unknown>>;
}
function captureJournal(value: unknown): Journal {
  if (!value || typeof value !== "object") return refuse();
  const owner = value as Journal;
  if (typeof owner.append !== "function" || typeof owner.readHistory !== "function") return refuse();
  return Object.freeze({ append: owner.append.bind(value), readHistory: owner.readHistory.bind(value) });
}
function stage(plan: InstallationPlanV1, name: "agent_readiness" | "final_review") {
  const found = plan.stages.find(item => item.stage === name);
  if (!found) return refuse();
  return found;
}
async function authenticatePlan(journal: Journal, installationId: string, plan: InstallationPlanV1) {
  let result;
  try { result = await journal.append(plan); } catch { return refuse(); }
  if (result.installationId !== installationId || result.revision !== plan.revision
    || result.planDigest !== plan.planDigest) return refuse();
  return result;
}

function terminal(value: unknown, request: PrivateLocalHermesAdmissionRequestV1):
PrivateLocalHermesAdmissionTerminalConfirmationV1 {
  const confirmation = exact(value, ["schema", "installationId", "requestDigest", "admissionRequestDigest",
    "privateStartupBindingDigest", "installationPlanDigest", "installationPlanRevision", "terminalState",
    "passesFinalReview", "startsWork", "enablesWorker", "grantsExecutionAuthority", "confirmationDigest"]);
  const body = { schema: PRIVATE_LOCAL_HERMES_ADMISSION_TERMINAL_CONFIRMATION_V1,
    installationId: request.installationId, requestDigest: request.requestDigest,
    admissionRequestDigest: request.admissionRequestDigest,
    privateStartupBindingDigest: request.privateStartupBindingDigest,
    installationPlanDigest: request.installationPlanDigest,
    installationPlanRevision: request.installationPlanRevision,
    terminalState: "confirmed" as const, passesFinalReview: false as const, startsWork: false as const,
    enablesWorker: false as const, grantsExecutionAuthority: false as const };
  if (confirmation.schema !== body.schema || confirmation.installationId !== body.installationId
    || confirmation.requestDigest !== body.requestDigest
    || confirmation.admissionRequestDigest !== body.admissionRequestDigest
    || confirmation.privateStartupBindingDigest !== body.privateStartupBindingDigest
    || confirmation.installationPlanDigest !== body.installationPlanDigest
    || confirmation.installationPlanRevision !== body.installationPlanRevision
    || confirmation.terminalState !== "confirmed" || confirmation.passesFinalReview !== false
    || confirmation.startsWork !== false || confirmation.enablesWorker !== false
    || confirmation.grantsExecutionAuthority !== false
    || confirmation.confirmationDigest !== sha256Digest({ purpose: "private-local-hermes-admission-confirmation/v1",
      confirmation: body })) return refuse();
  return Object.freeze({ ...body, confirmationDigest: confirmation.confirmationDigest as string });
}

function receiptFor(request: PrivateLocalHermesAdmissionRequestV1): LocalHermesAdmissionTerminalReceiptV1 {
  const body = { schema: LOCAL_HERMES_ADMISSION_TRANSACTION_V1, installationId: request.installationId,
    requestDigest: request.requestDigest, admissionRequestDigest: request.admissionRequestDigest,
    privateStartupBindingDigest: request.privateStartupBindingDigest,
    installationPlanDigest: request.installationPlanDigest,
    installationPlanRevision: request.installationPlanRevision,
    topologyPlanDigest: request.topologyPlanDigest, releaseDigest: request.releaseDigest,
    installationBindingDigest: request.installationBindingDigest,
    lifecycleContractDigest: request.lifecycleContractDigest, stage: "agent_readiness" as const,
    taskClass: "text_review" as const, passesFinalReview: false as const, invokesHermes: false as const,
    startsService: false as const, startsWork: false as const, enablesWorker: false as const,
    grantsExecutionAuthority: false as const, createsReceiptStore: false as const };
  return Object.freeze({ ...body,
    receiptDigest: sha256Digest({ purpose: "local-hermes-admission-terminal-receipt/v1", receipt: body }) });
}

function recovered(history: readonly InstallationPlanV1[], receipt: LocalHermesAdmissionTerminalReceiptV1) {
  const settled = history[receipt.installationPlanRevision + 1], current = history.at(-1);
  if (!settled) return false;
  if (!current || settled.revision !== receipt.installationPlanRevision + 1
    || stage(settled, "agent_readiness").state !== "passed"
    || stage(settled, "agent_readiness").recordedRevision !== settled.revision
    || stage(settled, "agent_readiness").outcomeDigest !== receipt.receiptDigest
    || stage(current, "agent_readiness").state !== "passed"
    || stage(current, "agent_readiness").outcomeDigest !== receipt.receiptDigest) return refuse();
  return true;
}

function result(receipt: LocalHermesAdmissionTerminalReceiptV1, replayed: boolean):
LocalHermesAdmissionTransactionResultV1 {
  return Object.freeze({ receipt, replayed, passesFinalReview: false as const, invokesHermes: false as const,
    startsService: false as const, startsWork: false as const, enablesWorker: false as const,
    grantsExecutionAuthority: false as const, createsReceiptStore: false as const });
}

/** Settles only agent_readiness in the existing journal. It reconstructs the
 * exact historical owner request through a read-only view of that journal,
 * verifies the private runner terminal confirmation, then rereads the current
 * tip after append. It never advances final_review. */
export async function confirmLocalHermesAdmissionTerminalV1(inputValue: unknown,
  runtime: Readonly<{ journal: Journal }>): Promise<LocalHermesAdmissionTransactionResultV1> {
  const envelope = exact(inputValue, ["runnerInput", "terminalConfirmation"]);
  const runnerInput = exact(envelope.runnerInput,
    ["admissionPreparationInput", "privateStartupConfiguration", "startupAdmissionBinding"]);
  const admissionInput = exact(runnerInput.admissionPreparationInput, ["installationId", "installationPlan",
    "topologyInput", "workerBinding", "installationBinding", "installationBindingInput"]);
  if (typeof admissionInput.installationId !== "string" || !installationIdPattern.test(admissionInput.installationId)) return refuse();
  const journal = captureJournal(runtime?.journal);
  let original: InstallationPlanV1;
  try { original = verifyInstallationPlanV1(admissionInput.installationPlan); } catch { return refuse(); }
  try {
    let history = await journal.readHistory();
    const historical = history[original.revision];
    if (!historical || historical.planDigest !== original.planDigest) return refuse();
    await authenticatePlan(journal, admissionInput.installationId, original);
    history = await journal.readHistory();
    if (!history[original.revision] || history[original.revision]!.planDigest !== original.planDigest) return refuse();
    const historicalJournal: Journal = Object.freeze({
      async readHistory() { return Object.freeze(history.slice(0, original.revision + 1)); },
      async append(value: InstallationPlanV1) {
        if (value.revision !== original.revision || value.planDigest !== original.planDigest) return refuse();
        return { schema: "control-room.installation-plan-journal/v1" as const,
          installationId: admissionInput.installationId as string, revision: original.revision,
          planDigest: original.planDigest, replayed: true, enablesAuthority: false as const,
          startsService: false as const, startsWorker: false as const };
      },
    });
    const request = await preparePrivateLocalHermesAdmissionRequestV1(envelope.runnerInput, historicalJournal);
    terminal(envelope.terminalConfirmation, request);
    const receipt = receiptFor(request);
    history = await journal.readHistory();
    await authenticatePlan(journal, request.installationId, original);
    history = await journal.readHistory();
    if (recovered(history, receipt)) return result(receipt, true);
    const current = history.at(-1);
    if (!current || current.revision !== original.revision || current.planDigest !== original.planDigest
      || history.length !== original.revision + 1 || stage(current, "agent_readiness").state !== "running"
      || stage(current, "final_review").state !== "not_started") return refuse();
    const next = advanceInstallationPlanV1(current, { expectedRevision: current.revision,
      stage: "agent_readiness", action: "pass", outcomeDigest: receipt.receiptDigest });
    const appended = await authenticatePlan(journal, request.installationId, next);
    history = await journal.readHistory();
    if (!recovered(history, receipt)) return refuse();
    return result(receipt, appended.replayed);
  } catch {
    return refuse();
  }
}
