import { sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { advanceInstallationPlanV1, installationSetupStagesV1, refreshInstallationPlanV1,
  verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";

export const PRIVATE_INSTALLATION_FINAL_REVIEW_V1 =
  "control-room.private-installation-final-review/v1" as const;
export const PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1 =
  "control-room.private-installation-final-review-owner-confirmation/v1" as const;
export const PRIVATE_INSTALLATION_FINAL_REVIEW_TERMINAL_V1 =
  "control-room.private-installation-final-review-terminal/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;
type PriorStage = Exclude<typeof installationSetupStagesV1[number], "final_review">;

export type PrivateInstallationFinalReviewContextV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLATION_FINAL_REVIEW_V1;
  installationId: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  finalReviewInputDigest: string;
  priorStageEvidenceDigest: string;
  operation: "owner_confirm_private_installation_final_review";
  signal: AbortSignal;
  invokesAgent: false;
  enablesAuthority: false;
  startsService: false;
  startsWorker: false;
}>;

export type PrivateInstallationFinalReviewOwnerConfirmationV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1;
  installationId: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  finalReviewInputDigest: string;
  ownerAttached: true;
  confirmed: true;
}>;

export type PrivateInstallationFinalReviewTerminalV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLATION_FINAL_REVIEW_TERMINAL_V1;
  installationId: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  finalReviewInputDigest: string;
  priorStageEvidenceDigest: string;
  confirmationDigest: string;
  invokesAgent: false;
  enablesAuthority: false;
  startsService: false;
  startsWorker: false;
}>;

export type PrivateInstallationFinalReviewResultV1 = Readonly<{
  terminal: PrivateInstallationFinalReviewTerminalV1;
  replayed: boolean;
  invokesAgent: false;
  enablesAuthority: false;
  startsService: false;
  startsWorker: false;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const refuse = (): never => { const error = new Error("private_installation_final_review_refused"); error.stack = undefined; throw error; };

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
  const journal = value as Journal;
  if (typeof journal.append !== "function" || typeof journal.readHistory !== "function") return refuse();
  return Object.freeze({ append: journal.append.bind(value), readHistory: journal.readHistory.bind(value) });
}

function captureRuntime(value: unknown) {
  const runtime = exact(value, ["journal", "signal", "controlDeadlineMs", "confirmOwnerAttached"]);
  const signal = runtime.signal as AbortSignal;
  if (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function" || !Number.isSafeInteger(runtime.controlDeadlineMs)
    || (runtime.controlDeadlineMs as number) < 1 || (runtime.controlDeadlineMs as number) > 30_000
    || typeof runtime.confirmOwnerAttached !== "function") return refuse();
  const owner = value as { confirmOwnerAttached(context: PrivateInstallationFinalReviewContextV1): Promise<unknown> };
  return Object.freeze({ journal: captureJournal(runtime.journal), signal,
    controlDeadlineMs: runtime.controlDeadlineMs as number, confirm: owner.confirmOwnerAttached.bind(owner) });
}

function stage(plan: InstallationPlanV1, name: typeof installationSetupStagesV1[number]) {
  const found = plan.stages.find(item => item.stage === name);
  if (!found) return refuse();
  return found;
}

function priorEvidence(plan: InstallationPlanV1) {
  const records = plan.stages.slice(0, -1);
  if (records.length !== installationSetupStagesV1.length - 1 || records.some(record => record.state !== "passed"
    || record.recordedRevision === undefined || !record.outcomeDigest || !digestPattern.test(record.inputDigest)
    || !digestPattern.test(record.outcomeDigest))) return refuse();
  return Object.freeze(records.map(record => Object.freeze({ stage: record.stage as PriorStage,
    inputDigest: record.inputDigest, outcomeDigest: record.outcomeDigest!, recordedRevision: record.recordedRevision! })));
}

function bindings(plan: InstallationPlanV1) {
  const evidence = priorEvidence(plan);
  const priorStageEvidenceDigest = sha256Digest({ purpose: "private-installation-final-review-prior-evidence/v1",
    stages: evidence });
  const finalReviewInputDigest = sha256Digest({ purpose: "private-installation-final-review-input/v1",
    topologyPlanDigest: plan.topologyPlanDigest, releaseDigest: plan.releaseDigest, stages: evidence });
  return Object.freeze({ priorStageEvidenceDigest, finalReviewInputDigest });
}

async function appendExact(journal: Journal, installationId: string, plan: InstallationPlanV1) {
  let result;
  try { result = await journal.append(plan); } catch { return refuse(); }
  if (result.installationId !== installationId || result.revision !== plan.revision
    || result.planDigest !== plan.planDigest) return refuse();
  return result;
}

function assertCurrent(history: readonly InstallationPlanV1[], plan: InstallationPlanV1) {
  const current = history.at(-1);
  if (!current || history.length !== plan.revision + 1 || current.revision !== plan.revision
    || current.planDigest !== plan.planDigest) return refuse();
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return refuse();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("private_installation_final_review_refused")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(new Error("private_installation_final_review_refused")); });
  });
}

function verifyOwnerConfirmation(value: unknown, context: PrivateInstallationFinalReviewContextV1) {
  const result = exact(value, ["schema", "installationId", "installationPlanDigest", "installationPlanRevision",
    "finalReviewInputDigest", "ownerAttached", "confirmed"]);
  if (result.schema !== PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1
    || result.installationId !== context.installationId || result.installationPlanDigest !== context.installationPlanDigest
    || result.installationPlanRevision !== context.installationPlanRevision
    || result.finalReviewInputDigest !== context.finalReviewInputDigest
    || result.ownerAttached !== true || result.confirmed !== true) return refuse();
}

/** Control Room-specific authority glue. It deliberately retains no donor implementation. */
export async function runPrivateInstallationFinalReviewV1(inputValue: unknown,
  runtimeValue: unknown): Promise<PrivateInstallationFinalReviewTerminalV1> {
  const input = exact(inputValue, ["installationId", "installationPlan", "topologyPlan"]);
  if (typeof input.installationId !== "string" || !installationIdPattern.test(input.installationId)) return refuse();
  let supplied: InstallationPlanV1, topology: ReturnType<typeof verifyInstallationTopologyPlanV1>;
  try { supplied = verifyInstallationPlanV1(input.installationPlan); topology = verifyInstallationTopologyPlanV1(input.topologyPlan); }
  catch { return refuse(); }
  if (topology.planDigest !== supplied.topologyPlanDigest || stage(supplied, "final_review").state !== "not_started") return refuse();
  const binding = bindings(supplied);
  const runtime = captureRuntime(runtimeValue);
  const controller = new AbortController();
  const abortChild = () => controller.abort();
  runtime.signal.addEventListener("abort", abortChild, { once: true });
  if (runtime.signal.aborted) abortChild();
  const timer = setTimeout(abortChild, runtime.controlDeadlineMs);
  const active = () => {
    if (runtime.signal.aborted || controller.signal.aborted) return refuse();
  };
  try {
    active();
    let history = await bounded(runtime.journal.readHistory(), controller.signal).catch(refuse);
    active();
    assertCurrent(history, supplied);
    await bounded(appendExact(runtime.journal, input.installationId, supplied), controller.signal).catch(refuse);
    active();
    history = await bounded(runtime.journal.readHistory(), controller.signal).catch(refuse);
    active();
    assertCurrent(history, supplied);

    const stageInputDigests = Object.fromEntries(supplied.stages.map(item => [item.stage,
      item.stage === "final_review" ? binding.finalReviewInputDigest : item.inputDigest]));
    active();
    let refreshed: InstallationPlanV1;
    try { refreshed = refreshInstallationPlanV1(supplied, { topologyPlan: topology,
      releaseDigest: supplied.releaseDigest, stageInputDigests }); } catch { return refuse(); }
    active();
    if (refreshed.planDigest !== supplied.planDigest) {
      await bounded(appendExact(runtime.journal, input.installationId, refreshed), controller.signal).catch(refuse);
      active();
    }
    history = await bounded(runtime.journal.readHistory(), controller.signal).catch(refuse);
    active();
    assertCurrent(history, refreshed);

    active();
    let running: InstallationPlanV1;
    try { running = advanceInstallationPlanV1(refreshed, { expectedRevision: refreshed.revision,
      stage: "final_review", action: "start" }); } catch { return refuse(); }
    active();
    const start = await bounded(appendExact(runtime.journal, input.installationId, running), controller.signal).catch(refuse);
    active();
    if (start.replayed) return refuse();

    const context = Object.freeze({ schema: PRIVATE_INSTALLATION_FINAL_REVIEW_V1,
      installationId: input.installationId, installationPlanDigest: running.planDigest,
      installationPlanRevision: running.revision, topologyPlanDigest: running.topologyPlanDigest,
      releaseDigest: running.releaseDigest, finalReviewInputDigest: binding.finalReviewInputDigest,
      priorStageEvidenceDigest: binding.priorStageEvidenceDigest,
      operation: "owner_confirm_private_installation_final_review" as const, signal: controller.signal,
      invokesAgent: false as const, enablesAuthority: false as const, startsService: false as const, startsWorker: false as const });
    active();
    let confirmation: unknown;
    try { confirmation = await bounded(Promise.resolve().then(() => runtime.confirm(context)), controller.signal); }
    catch { return refuse(); }
    active();
    verifyOwnerConfirmation(confirmation, context);
    history = await bounded(runtime.journal.readHistory(), controller.signal).catch(refuse);
    active();
    assertCurrent(history, running);
    active();
    const body = { schema: PRIVATE_INSTALLATION_FINAL_REVIEW_TERMINAL_V1,
      installationId: input.installationId, installationPlanDigest: running.planDigest,
      installationPlanRevision: running.revision, topologyPlanDigest: running.topologyPlanDigest,
      releaseDigest: running.releaseDigest, finalReviewInputDigest: binding.finalReviewInputDigest,
      priorStageEvidenceDigest: binding.priorStageEvidenceDigest, invokesAgent: false as const,
      enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
    return Object.freeze({ ...body, confirmationDigest: sha256Digest({
      purpose: "private-installation-final-review-terminal/v1", confirmation: body }) });
  } finally {
    clearTimeout(timer); controller.abort(); runtime.signal.removeEventListener("abort", abortChild);
  }
}

function verifyTerminal(value: unknown): PrivateInstallationFinalReviewTerminalV1 {
  const terminal = exact(value, ["schema", "installationId", "installationPlanDigest", "installationPlanRevision",
    "topologyPlanDigest", "releaseDigest", "finalReviewInputDigest", "priorStageEvidenceDigest",
    "invokesAgent", "enablesAuthority", "startsService", "startsWorker", "confirmationDigest"]);
  const { confirmationDigest, ...body } = terminal;
  if (terminal.schema !== PRIVATE_INSTALLATION_FINAL_REVIEW_TERMINAL_V1
    || typeof terminal.installationId !== "string" || !installationIdPattern.test(terminal.installationId)
    || !Number.isSafeInteger(terminal.installationPlanRevision)
    || [terminal.installationPlanDigest, terminal.topologyPlanDigest, terminal.releaseDigest,
      terminal.finalReviewInputDigest, terminal.priorStageEvidenceDigest, confirmationDigest].some(value =>
      typeof value !== "string" || !digestPattern.test(value))
    || terminal.invokesAgent !== false || terminal.enablesAuthority !== false
    || terminal.startsService !== false || terminal.startsWorker !== false
    || confirmationDigest !== sha256Digest({ purpose: "private-installation-final-review-terminal/v1", confirmation: body })) return refuse();
  return terminal as PrivateInstallationFinalReviewTerminalV1;
}

function settled(history: readonly InstallationPlanV1[], terminal: PrivateInstallationFinalReviewTerminalV1) {
  const plan = history[terminal.installationPlanRevision + 1], current = history.at(-1);
  if (!plan) return false;
  const record = stage(plan, "final_review");
  if (!current || plan.revision !== terminal.installationPlanRevision + 1 || record.state !== "passed"
    || record.outcomeDigest !== terminal.confirmationDigest || record.recordedRevision !== plan.revision
    || current.planDigest !== plan.planDigest) return refuse();
  return true;
}

/** Appends only the final_review pass transition to the authenticated journal. */
export async function confirmPrivateInstallationFinalReviewV1(inputValue: unknown,
  runtimeValue: unknown): Promise<PrivateInstallationFinalReviewResultV1> {
  const input = exact(inputValue, ["terminal"]), terminal = verifyTerminal(input.terminal);
  const runtime = exact(runtimeValue, ["journal"]), journal = captureJournal(runtime.journal);
  let history = await journal.readHistory().catch(refuse);
  const running = history[terminal.installationPlanRevision];
  if (!running || running.planDigest !== terminal.installationPlanDigest
    || running.topologyPlanDigest !== terminal.topologyPlanDigest || running.releaseDigest !== terminal.releaseDigest
    || stage(running, "final_review").state !== "running"
    || stage(running, "final_review").inputDigest !== terminal.finalReviewInputDigest
    || bindings(running).priorStageEvidenceDigest !== terminal.priorStageEvidenceDigest) return refuse();
  await appendExact(journal, terminal.installationId, running);
  history = await journal.readHistory().catch(refuse);
  if (settled(history, terminal)) return Object.freeze({ terminal, replayed: true,
    invokesAgent: false, enablesAuthority: false, startsService: false, startsWorker: false });
  assertCurrent(history, running);
  let passed: InstallationPlanV1;
  try { passed = advanceInstallationPlanV1(running, { expectedRevision: running.revision,
    stage: "final_review", action: "pass", outcomeDigest: terminal.confirmationDigest }); } catch { return refuse(); }
  const appended = await appendExact(journal, terminal.installationId, passed);
  history = await journal.readHistory().catch(refuse);
  if (!settled(history, terminal)) return refuse();
  return Object.freeze({ terminal, replayed: appended.replayed,
    invokesAgent: false, enablesAuthority: false, startsService: false, startsWorker: false });
}
