import { verifyInstallationReadinessV1 } from "../../harness/v1/installation-readiness";
import { verifyLocalBackupRestoreReadinessV1 } from "../../harness/v1/local-backup-restore-readiness";
import { verifyLocalSupervisorReadinessV1 } from "../../harness/v1/local-supervisor-readiness";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../../harness/hermes-021-v1/macos-local-worker";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { sha256Digest } from "../../security/canonical-digest";
import { validatePrivateTaskStartupConfiguration } from "../../web/v1/private-task-startup";
import { verifyPrivateHermes021LocalStartupAdmissionBindingV1 } from
  "../../web/v1/hermes-021-private-installation-composition";
import { activateHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderV1 } from
  "../../harness/hermes-021-v1/subprocess-stream-json-host";
import { qualifyPrivateLocalHermesOwnerQualificationRuntimeV1 } from
  "./private-local-hermes-owner-qualification-runtime";
import { type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { prepareLocalHermesAdmissionV1,
  type LocalHermesAdmissionPreparationInputV1 } from "./local-hermes-admission-preparation";

export const PRIVATE_LOCAL_HERMES_ADMISSION_RUNNER_V1 =
  "control-room.private-local-hermes-admission-runner/v1" as const;
export const PRIVATE_LOCAL_HERMES_OWNER_ATTACHED_TERMINAL_V1 =
  "control-room.private-local-hermes-owner-attached-terminal/v1" as const;
export const PRIVATE_LOCAL_HERMES_ADMISSION_TERMINAL_CONFIRMATION_V1 =
  "control-room.private-local-hermes-admission-terminal-confirmation/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;

export type PrivateLocalHermesAdmissionRequestV1 = Readonly<{
  installationId: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  installationBindingDigest: string;
  lifecycleContractDigest: string;
  admissionRequestDigest: string;
  privateStartupBindingDigest: string;
  taskClass: "text_review";
  operation: "owner_admit_local_hermes_text_review";
  requestDigest: string;
}>;

export type PrivateLocalHermesAdmissionRunnerContextV1 = PrivateLocalHermesAdmissionRequestV1 & Readonly<{
  signal: AbortSignal;
}>;

export type PrivateLocalHermesOwnerAttachedTerminalV1 = Readonly<{
  schema: typeof PRIVATE_LOCAL_HERMES_OWNER_ATTACHED_TERMINAL_V1;
  installationId: string;
  requestDigest: string;
  admissionRequestDigest: string;
  privateStartupBindingDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  ownerAttached: true;
  confirmed: true;
}>;

export type PrivateLocalHermesAdmissionTerminalConfirmationV1 = Readonly<{
  schema: typeof PRIVATE_LOCAL_HERMES_ADMISSION_TERMINAL_CONFIRMATION_V1;
  installationId: string;
  requestDigest: string;
  admissionRequestDigest: string;
  privateStartupBindingDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  terminalState: "confirmed";
  confirmationDigest: string;
  passesFinalReview: false;
  startsWork: false;
  enablesWorker: false;
  grantsExecutionAuthority: false;
}>;

export type PrivateLocalHermesAdmissionOwnerResultV1 = Readonly<{
  schema: typeof PRIVATE_LOCAL_HERMES_ADMISSION_RUNNER_V1;
  installationId: string;
  requestDigest: string;
  disposition: "terminal_confirmation" | "qualified_runner";
  terminalConfirmation: PrivateLocalHermesAdmissionTerminalConfirmationV1;
  invokesHermes: boolean;
  startsService: false;
  startsWork: false;
  enablesWorker: boolean;
  grantsExecutionAuthority: false;
}>;

export type PrivateLocalHermesAdmissionRunnerInputV1 = Readonly<{
  admissionPreparationInput: LocalHermesAdmissionPreparationInputV1;
  privateStartupConfiguration: unknown;
  startupAdmissionBinding: unknown;
  /** Opaque, initially inert holder created by the reviewed installed graph. */
  ownerAuthorizedRunnerProvider?: object;
  /** Opaque, installed qualification runtime. It is not serializable data. */
  hermesQualificationRuntime?: object;
}>;

export type PrivateLocalHermesAdmissionRuntimeV1 = Readonly<{
  journal: Journal;
  signal: AbortSignal;
  controlDeadlineMs: number;
  confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1):
    Promise<PrivateLocalHermesOwnerAttachedTerminalV1>;
  /** Owner-host-only operation. It must return a genuine, freshly qualified
   * runner; ordinary data cannot manufacture one. */
  qualifyOwnerAuthorizedRunner?(context: PrivateLocalHermesAdmissionRunnerContextV1): Promise<object>;
}>;

const failureKinds = new WeakMap<object, "refused" | "uncertain">();
function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_local_hermes_admission_runner_${kind}`);
  error.stack = undefined; failureKinds.set(error, kind); return error;
}
function refused(): never { throw sanitized("refused"); }
function uncertain(): never { throw sanitized("uncertain"); }
function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(name => !Object.prototype.hasOwnProperty.call(value, name)) || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refused();
  return value as Readonly<Record<string, unknown>>;
}
function captureJournal(value: unknown): Journal {
  if (!value || typeof value !== "object") return refused();
  const owner = value as Journal;
  if (typeof owner.append !== "function" || typeof owner.readHistory !== "function") return refused();
  return Object.freeze({ append: owner.append.bind(value), readHistory: owner.readHistory.bind(value) });
}

function stage(plan: InstallationPlanV1, name: "agent_readiness" | "final_review") {
  const found = plan.stages.find(item => item.stage === name);
  if (!found) return refused();
  return found;
}

/** Rebuilds the accepted admission preparation and runs the existing pure
 * private-startup validator. No returned field contains a callback, database
 * setting, credential, path, worker identity, or Hermes setting. */
export async function preparePrivateLocalHermesAdmissionRequestV1(inputValue: unknown,
  journalValue: unknown): Promise<PrivateLocalHermesAdmissionRequestV1> {
  const input = exactOptional(inputValue, ["admissionPreparationInput", "privateStartupConfiguration", "startupAdmissionBinding"],
    ["ownerAuthorizedRunnerProvider", "hermesQualificationRuntime"]);
  const journal = captureJournal(journalValue);
  let preparation: Awaited<ReturnType<typeof prepareLocalHermesAdmissionV1>>;
  let startup: ReturnType<typeof validatePrivateTaskStartupConfiguration>;
  try {
    preparation = await prepareLocalHermesAdmissionV1(
      input.admissionPreparationInput as LocalHermesAdmissionPreparationInputV1, { journal });
    startup = validatePrivateTaskStartupConfiguration(input.privateStartupConfiguration as never);
  } catch { return refused(); }
  if (preparation.state !== "awaiting_owner_admission_review" || !preparation.admissionRequestDigest
    || !preparation.installationBindingDigest || !startup.hermes021Local || !startup.nativeQueue
    || !startup.queueWorker || !startup.planning.localAdapterAdmission?.enabledAdapters.includes(
      HERMES_021_MACOS_LOCAL_ADAPTER_V1)) return refused();
  const admissionInput = exact(input.admissionPreparationInput, ["installationId", "installationPlan",
    "topologyInput", "workerBinding", "installationBinding", "installationBindingInput"]);
  const startupInput = input.privateStartupConfiguration;
  if (!startupInput || typeof startupInput !== "object" || Array.isArray(startupInput)) return refused();
  const coordinator = (startupInput as { coordinator?: unknown }).coordinator;
  if (!coordinator || typeof coordinator !== "object" || Array.isArray(coordinator)) return refused();
  let startupBinding: ReturnType<typeof verifyPrivateHermes021LocalStartupAdmissionBindingV1>;
  try {
    startupBinding = verifyPrivateHermes021LocalStartupAdmissionBindingV1(input.startupAdmissionBinding, {
      delivery: (coordinator as { hermes021Local?: unknown }).hermes021Local,
      queueWorker: (coordinator as { queueWorker?: unknown }).queueWorker,
      installationBinding: admissionInput.installationBinding,
      topologyPlanDigest: preparation.topologyPlanDigest, releaseDigest: preparation.releaseDigest,
      admissionRequestDigest: preparation.admissionRequestDigest,
    });
  } catch { return refused(); }
  if (startupBinding.installationBindingDigest !== preparation.installationBindingDigest
    || startupBinding.workerBindingDigest !== (admissionInput.installationBinding as { workerBindingDigest?: unknown }).workerBindingDigest
    || startupBinding.runnerConfigurationDigest !== (admissionInput.installationBinding as { runnerConfigurationDigest?: unknown }).runnerConfigurationDigest)
    return refused();
  let topology: ReturnType<typeof verifyInstallationTopologyPlanV1>;
  let readiness: ReturnType<typeof verifyInstallationReadinessV1>;
  let recovery: ReturnType<typeof verifyLocalBackupRestoreReadinessV1>;
  let supervisor: ReturnType<typeof verifyLocalSupervisorReadinessV1>;
  try {
    topology = verifyInstallationTopologyPlanV1(startup.web.installationTopologyPlan);
    readiness = verifyInstallationReadinessV1(startup.web.installationReadiness);
    recovery = verifyLocalBackupRestoreReadinessV1(startup.web.localBackupRestoreReadiness);
    supervisor = verifyLocalSupervisorReadinessV1(startup.web.localSupervisorReadiness);
  } catch { return refused(); }
  if (topology.planDigest !== preparation.topologyPlanDigest || readiness.planDigest !== topology.planDigest
    || recovery.planDigest !== topology.planDigest || supervisor.planDigest !== topology.planDigest) return refused();
  const privateStartupBindingDigest = startupBinding.bindingDigest;
  const material = { installationId: preparation.installationId,
    installationPlanDigest: preparation.installationPlanDigest,
    installationPlanRevision: preparation.installationPlanRevision,
    topologyPlanDigest: preparation.topologyPlanDigest, releaseDigest: preparation.releaseDigest,
    installationBindingDigest: preparation.installationBindingDigest,
    lifecycleContractDigest: preparation.lifecycleContractDigest,
    admissionRequestDigest: preparation.admissionRequestDigest, privateStartupBindingDigest,
    taskClass: "text_review" as const, operation: "owner_admit_local_hermes_text_review" as const };
  return Object.freeze({ ...material,
    requestDigest: sha256Digest({ purpose: "private-local-hermes-admission-request/v1", request: material }) });
}

function exactOptional(value: unknown, required: readonly string[], optional: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const names = Object.getOwnPropertyNames(value), permitted = [...required, ...optional];
  if (names.some(name => !permitted.includes(name)) || required.some(name => !names.includes(name)) || names.some(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) return refused();
  return value as Readonly<Record<string, unknown>>;
}

function captureRuntime(value: unknown) {
  const runtime = exactOptional(value, ["journal", "signal", "controlDeadlineMs", "confirmOwnerAttachedTerminal"],
    ["qualifyOwnerAuthorizedRunner"]);
  const journal = captureJournal(runtime.journal);
  if (!runtime.signal || typeof runtime.signal !== "object"
    || typeof (runtime.signal as AbortSignal).aborted !== "boolean"
    || typeof (runtime.signal as AbortSignal).addEventListener !== "function"
    || typeof (runtime.signal as AbortSignal).removeEventListener !== "function"
    || !Number.isSafeInteger(runtime.controlDeadlineMs) || (runtime.controlDeadlineMs as number) < 1
    || (runtime.controlDeadlineMs as number) > 30_000 || typeof runtime.confirmOwnerAttachedTerminal !== "function"
    || (runtime.qualifyOwnerAuthorizedRunner !== undefined && typeof runtime.qualifyOwnerAuthorizedRunner !== "function")) return refused();
  const owner = value as PrivateLocalHermesAdmissionRuntimeV1;
  return Object.freeze({ journal, signal: runtime.signal as AbortSignal,
    controlDeadlineMs: runtime.controlDeadlineMs as number,
    confirm: owner.confirmOwnerAttachedTerminal.bind(owner),
    ...(runtime.qualifyOwnerAuthorizedRunner ? { qualify: owner.qualifyOwnerAuthorizedRunner!.bind(owner) } : {}) });
}

function attached(value: unknown, request: PrivateLocalHermesAdmissionRequestV1) {
  const confirmation = exact(value, ["schema", "installationId", "requestDigest", "admissionRequestDigest",
    "privateStartupBindingDigest", "installationPlanDigest", "installationPlanRevision", "ownerAttached", "confirmed"]);
  if (confirmation.schema !== PRIVATE_LOCAL_HERMES_OWNER_ATTACHED_TERMINAL_V1
    || confirmation.installationId !== request.installationId || confirmation.requestDigest !== request.requestDigest
    || confirmation.admissionRequestDigest !== request.admissionRequestDigest
    || confirmation.privateStartupBindingDigest !== request.privateStartupBindingDigest
    || confirmation.installationPlanDigest !== request.installationPlanDigest
    || confirmation.installationPlanRevision !== request.installationPlanRevision
    || confirmation.ownerAttached !== true || confirmation.confirmed !== true) return refused();
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return uncertain();
  return new Promise<T>((resolve, reject) => {
    const finish = () => signal.removeEventListener("abort", abort);
    const abort = () => { finish(); reject(sanitized("uncertain")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { finish(); resolve(value); }, () => { finish(); reject(sanitized("uncertain")); });
  });
}

/** Obtains one attached-owner confirmation. The captured local delivery
 * callback is validated but never invoked. A final journal reread after owner
 * confirmation prevents an approval of stale setup state. */
export async function runPrivateLocalHermesAdmissionV1(input: unknown,
  runtimeValue: unknown): Promise<PrivateLocalHermesAdmissionOwnerResultV1> {
  let runtime: ReturnType<typeof captureRuntime>, request: PrivateLocalHermesAdmissionRequestV1;
  try { runtime = captureRuntime(runtimeValue); request = await preparePrivateLocalHermesAdmissionRequestV1(input, runtime.journal); }
  catch { return refused(); }
  if (runtime.signal.aborted) return refused();
  const controller = new AbortController(), abortChild = () => controller.abort();
  runtime.signal.addEventListener("abort", abortChild, { once: true });
  const timer = setTimeout(abortChild, runtime.controlDeadlineMs);
  const context = Object.freeze({ ...request, signal: controller.signal });
  try {
    let reply: unknown;
    try { reply = await raceAbort(Promise.resolve().then(() => runtime.confirm(context)), controller.signal); }
    catch { return uncertain(); }
    if (runtime.signal.aborted || controller.signal.aborted) return uncertain();
    try { attached(reply, request); } catch { return refused(); }
    if (runtime.signal.aborted || controller.signal.aborted) return uncertain();
    const provider = input && typeof input === "object" && !Array.isArray(input)
      ? (input as { ownerAuthorizedRunnerProvider?: unknown }).ownerAuthorizedRunnerProvider : undefined;
    const qualificationRuntime = input && typeof input === "object" && !Array.isArray(input)
      ? (input as { hermesQualificationRuntime?: unknown }).hermesQualificationRuntime : undefined;
    let qualifiedRunner: object | undefined;
    if (provider !== undefined) {
      if (!provider || typeof provider !== "object" || qualificationRuntime === undefined) return refused();
      try { qualifiedRunner = await raceAbort(Promise.resolve().then(() =>
        runtime.qualify ? runtime.qualify(context) : qualifyPrivateLocalHermesOwnerQualificationRuntimeV1(qualificationRuntime, context)), controller.signal); }
      catch { return uncertain(); }
      if (runtime.signal.aborted || controller.signal.aborted) return uncertain();
    }
    let history: readonly InstallationPlanV1[];
    try { history = await raceAbort(runtime.journal.readHistory(), controller.signal); }
    catch { return uncertain(); }
    if (runtime.signal.aborted || controller.signal.aborted) return uncertain();
    const current = history.at(-1), readiness = current && stage(current, "agent_readiness");
    if (!current || current.revision !== request.installationPlanRevision
      || current.planDigest !== request.installationPlanDigest || readiness?.state !== "running"
      || stage(current, "final_review").state !== "not_started") return uncertain();
    if (provider !== undefined) {
      try { activateHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderV1(provider, qualifiedRunner); }
      catch { return refused(); }
    }
    const body = { schema: PRIVATE_LOCAL_HERMES_ADMISSION_TERMINAL_CONFIRMATION_V1,
      installationId: request.installationId, requestDigest: request.requestDigest,
      admissionRequestDigest: request.admissionRequestDigest,
      privateStartupBindingDigest: request.privateStartupBindingDigest,
      installationPlanDigest: request.installationPlanDigest,
      installationPlanRevision: request.installationPlanRevision, terminalState: "confirmed" as const,
      passesFinalReview: false as const, startsWork: false as const, enablesWorker: false as const,
      grantsExecutionAuthority: false as const };
    const terminalConfirmation = Object.freeze({ ...body,
      confirmationDigest: sha256Digest({ purpose: "private-local-hermes-admission-confirmation/v1", confirmation: body }) });
    return Object.freeze({ schema: PRIVATE_LOCAL_HERMES_ADMISSION_RUNNER_V1,
      installationId: request.installationId, requestDigest: request.requestDigest,
      disposition: provider === undefined ? "terminal_confirmation" as const : "qualified_runner" as const, terminalConfirmation,
      invokesHermes: provider !== undefined, startsService: false as const, startsWork: false as const,
      enablesWorker: provider !== undefined, grantsExecutionAuthority: false as const });
  } finally {
    clearTimeout(timer);
    controller.abort();
    runtime.signal.removeEventListener("abort", abortChild);
  }
}
