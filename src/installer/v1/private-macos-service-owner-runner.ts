import { sha256Digest } from "../../security/canonical-digest";
import { createMacosLocalServicePackageV1 } from "../../harness/v1/macos-local-service-package";
import { captureLocalPlatformServiceObservationV1 } from "./local-platform-service-observation";
import { macosServiceIdentityDigestV1, simulateMacosServiceOwnerActionV1,
  type MacosServiceRunnerRequestV1 } from "./macos-service-owner-action";
import { advanceInstallationPlanV1, verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { verifyPlatformServiceLifecycleV1, type PlatformServiceLifecycleV1 } from "./platform-service-lifecycle";

/**
 * Private, source-only boundary for the first macOS background-service install.
 * There is deliberately no launchctl, filesystem, process, or observation
 * implementation here. A separately reviewed private port must supply those
 * effects and their cleanup.
 */
export const PRIVATE_MACOS_SERVICE_OWNER_RUNNER_V1 =
  "control-room.private-macos-service-owner-runner/v1" as const;
export const PRIVATE_MACOS_SERVICE_OWNER_ATTACHED_TERMINAL_V1 =
  "control-room.private-macos-service-owner-attached-terminal/v1" as const;
export const PRIVATE_MACOS_SERVICE_TOOL_V1 =
  "control-room.private-macos-service-tool/v1" as const;
export const PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1 =
  "control-room.private-macos-service-final-observation/v1" as const;
export const PRIVATE_MACOS_SERVICE_TERMINAL_CONFIRMATION_V1 =
  "control-room.private-macos-service-terminal-confirmation/v1" as const;
export const PRIVATE_MACOS_SERVICE_TERMINAL_RECEIPT_V1 =
  "control-room.private-macos-service-terminal-receipt/v1" as const;

export const PRIVATE_MACOS_SERVICE_LABEL_V1 = "xyz.agentcontrolroom.local" as const;

type LifecycleInput = Parameters<typeof verifyPlatformServiceLifecycleV1>[1];
type ServicePackageInput = Parameters<typeof createMacosLocalServicePackageV1>[0];
type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;

export type PrivateMacosServiceOwnerContextV1 = Readonly<{
  requestDigest: string;
  lifecycleDigest: string;
  action: "install";
  signal: AbortSignal;
}>;

export type PrivateMacosServiceOwnerAttachedTerminalV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_OWNER_ATTACHED_TERMINAL_V1;
  requestDigest: string;
  lifecycleDigest: string;
  action: "install";
  ownerAttached: true;
  confirmed: true;
}>;

export type PrivateMacosServiceToolRequestV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_TOOL_V1;
  requestDigest: string;
  deadlineUnixMs: number;
  step: MacosServiceRunnerRequestV1;
}>;

export type PrivateMacosServiceFinalObservationRequestV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_TOOL_V1;
  operation: "observe_installed_service";
  requestDigest: string;
  lifecycleDigest: string;
  label: typeof PRIVATE_MACOS_SERVICE_LABEL_V1;
  expectedReleaseDigest: string;
  expectedServiceIdentityDigest: string;
  expectedServiceDefinitionDigest: string;
  deadlineUnixMs: number;
}>;

export type PrivateMacosServiceFinalObservationV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1;
  requestDigest: string;
  lifecycleDigest: string;
  installedServiceDefinitionDigest: string;
  serviceObservation: unknown;
}>;

export type PrivateMacosServiceOwnerToolV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_TOOL_V1;
  executeStep(request: PrivateMacosServiceToolRequestV1, signal: AbortSignal): Promise<
    Readonly<{ outcome: "succeeded" }> | Readonly<{ outcome: "failed_before_effect" }>>;
  observeFinal(request: PrivateMacosServiceFinalObservationRequestV1, signal: AbortSignal): Promise<unknown>;
  cleanup(signal: AbortSignal): Promise<Readonly<{ outcome: "confirmed" }>>;
}>;

export type PrivateMacosServiceOwnerRuntimeV1 = Readonly<{
  signal: AbortSignal;
  controlDeadlineMs: number;
  cleanupDeadlineMs: number;
  /** Installation-private, owner-reviewed fixed paths; never accepted from a tool reply. */
  reviewedServicePackageInput: ServicePackageInput;
  confirmOwnerAttachedTerminal(context: PrivateMacosServiceOwnerContextV1):
    Promise<PrivateMacosServiceOwnerAttachedTerminalV1>;
  tool: PrivateMacosServiceOwnerToolV1;
}>;

export type PrivateMacosServiceTerminalConfirmationV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_TERMINAL_CONFIRMATION_V1;
  requestDigest: string;
  lifecycleDigest: string;
  action: "install";
  terminalEvidenceDigest: string;
  serviceState: "running";
  terminalState: "confirmed";
}>;

export type PrivateMacosServiceOwnerResultV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_OWNER_RUNNER_V1;
  requestDigest: string;
  lifecycleDigest: string;
  action: "install";
  disposition: "terminal_confirmation";
  terminalEvidenceDigest: string;
  cleanupConfirmed: true;
  grantsAgentReadiness: false;
  terminalConfirmation: PrivateMacosServiceTerminalConfirmationV1;
}>;

export type PrivateMacosServiceTerminalReceiptV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_TERMINAL_RECEIPT_V1;
  installationId: string;
  receiptDigest: string;
  requestDigest: string;
  lifecycleDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  stage: "platform_service";
  action: "install";
  terminalEvidenceDigest: string;
  serviceState: "running";
  grantsAgentReadiness: false;
}>;

export type PrivateMacosServiceSettlementResultV1 = Readonly<{
  receipt: PrivateMacosServiceTerminalReceiptV1;
  replayed: boolean;
  createsReceiptStore: false;
  grantsAgentReadiness: false;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const failureKinds = new WeakMap<object, "refused" | "uncertain">();

function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_macos_service_owner_runner_${kind}`);
  error.stack = undefined;
  failureKinds.set(error, kind);
  return error;
}
function refused(): never { throw sanitized("refused"); }
function uncertain(): never { throw sanitized("uncertain"); }
function failureKind(value: unknown) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? failureKinds.get(value as object) : undefined;
}

function exactRecord(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))
    || keys.some(name => !names.includes(name)) || keys.some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refused();
  return value as Readonly<Record<string, unknown>>;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function stage(plan: InstallationPlanV1, name: "database_authority" | "protected_data" | "first_owner" | "recovery" | "platform_service") {
  const found = plan.stages.find(item => item.stage === name);
  if (!found) return refused();
  return found;
}

function passedPrerequisite(plan: InstallationPlanV1,
  name: "database_authority" | "protected_data" | "first_owner" | "recovery"): string {
  const found = stage(plan, name);
  if (found.state !== "passed" || found.recordedRevision === undefined || found.outcomeDigest === undefined) return refused();
  return digest(found.outcomeDigest);
}

function capturedRequest(input: unknown): Readonly<{
  lifecycle: PlatformServiceLifecycleV1;
  lifecycleInput: LifecycleInput;
  installationPlan: InstallationPlanV1;
  servicePackageInput: ServicePackageInput;
  serviceDefinitionDigest: string;
  requestDigest: string;
}> {
  const envelope = exactRecord(input, ["lifecycle", "lifecycleInput", "servicePackageInput"]);
  let lifecycleValue: unknown, lifecycleInputValue: unknown, servicePackageInput: ServicePackageInput;
  try {
    lifecycleValue = structuredClone(envelope.lifecycle);
    lifecycleInputValue = structuredClone(envelope.lifecycleInput);
    servicePackageInput = structuredClone(envelope.servicePackageInput) as ServicePackageInput;
  } catch { return refused(); }
  const lifecycleInput = exactRecord(lifecycleInputValue, ["action", "platform", "installationPlan",
    "supervisorReadiness", "serviceIdentityDigest", "authorityDatabaseDigest", "protectedDataDigest", "observation",
    "targetReleaseDigest", "targetServiceDefinitionDigest"]) as unknown as LifecycleInput;
  let lifecycle: PlatformServiceLifecycleV1;
  let installationPlan: InstallationPlanV1;
  let package_: ReturnType<typeof createMacosLocalServicePackageV1>;
  try {
    lifecycle = verifyPlatformServiceLifecycleV1(lifecycleValue, lifecycleInput);
    installationPlan = verifyInstallationPlanV1(lifecycleInput.installationPlan);
    package_ = createMacosLocalServicePackageV1(servicePackageInput);
  } catch { return refused(); }
  if (lifecycle.action !== "install" || lifecycle.platform !== "macos_launchd"
    || lifecycle.observation.state !== "not_installed" || package_.label !== PRIVATE_MACOS_SERVICE_LABEL_V1
    || lifecycle.serviceIdentityDigest !== macosServiceIdentityDigestV1(servicePackageInput)
    || lifecycle.targetServiceDefinitionDigest !== sha256Digest(package_.plist)
    || lifecycle.targetReleaseDigest !== installationPlan.releaseDigest) return refused();
  const plan = installationPlan;
  const prerequisites = Object.freeze({ databaseAuthorityOutcomeDigest: passedPrerequisite(plan, "database_authority"),
    protectedDataOutcomeDigest: passedPrerequisite(plan, "protected_data"),
    firstOwnerOutcomeDigest: passedPrerequisite(plan, "first_owner"),
    recoveryOutcomeDigest: passedPrerequisite(plan, "recovery") });
  const serviceDefinitionDigest = digest(lifecycle.targetServiceDefinitionDigest);
  const body = { schema: PRIVATE_MACOS_SERVICE_OWNER_RUNNER_V1, action: "install" as const,
    lifecycleDigest: lifecycle.lifecycleDigest, installationPlanDigest: lifecycle.installationPlanDigest,
    installationPlanRevision: lifecycle.installationPlanRevision, releaseDigest: lifecycle.targetReleaseDigest,
    serviceIdentityDigest: lifecycle.serviceIdentityDigest, serviceDefinitionDigest,
    authorityDatabaseDigest: lifecycle.authorityDatabaseDigest, protectedDataDigest: lifecycle.protectedDataDigest,
    supervisorReadinessDigest: lifecycle.supervisorReadinessDigest, prerequisites };
  return Object.freeze({ lifecycle, lifecycleInput, installationPlan, servicePackageInput,
    serviceDefinitionDigest, requestDigest: sha256Digest({ purpose: "private-macos-service-owner-request/v1", request: body }) });
}

function capturedRuntime(value: unknown) {
  const runtime = exactRecord(value, ["signal", "controlDeadlineMs", "cleanupDeadlineMs", "reviewedServicePackageInput",
    "confirmOwnerAttachedTerminal", "tool"]);
  const tool = exactRecord(runtime.tool, ["schema", "executeStep", "observeFinal", "cleanup"]);
  if (!runtime.signal || typeof runtime.signal !== "object" || typeof (runtime.signal as AbortSignal).aborted !== "boolean"
    || typeof (runtime.signal as AbortSignal).addEventListener !== "function"
    || !Number.isSafeInteger(runtime.controlDeadlineMs) || (runtime.controlDeadlineMs as number) < 1
    || (runtime.controlDeadlineMs as number) > 300_000
    || !Number.isSafeInteger(runtime.cleanupDeadlineMs) || (runtime.cleanupDeadlineMs as number) < 1
    || (runtime.cleanupDeadlineMs as number) > 30_000 || typeof runtime.confirmOwnerAttachedTerminal !== "function"
    || tool.schema !== PRIVATE_MACOS_SERVICE_TOOL_V1 || typeof tool.executeStep !== "function"
    || typeof tool.observeFinal !== "function" || typeof tool.cleanup !== "function") return refused();
  let reviewedServicePackageInput: ServicePackageInput, reviewedPackage: ReturnType<typeof createMacosLocalServicePackageV1>;
  try {
    reviewedServicePackageInput = structuredClone(runtime.reviewedServicePackageInput) as ServicePackageInput;
    reviewedPackage = createMacosLocalServicePackageV1(reviewedServicePackageInput);
  } catch { return refused(); }
  if (reviewedPackage.label !== PRIVATE_MACOS_SERVICE_LABEL_V1) return refused();
  const terminalOwner = runtime as unknown as PrivateMacosServiceOwnerRuntimeV1;
  const toolOwner = runtime.tool as PrivateMacosServiceOwnerToolV1;
  return Object.freeze({ signal: runtime.signal as AbortSignal,
    controlDeadlineMs: runtime.controlDeadlineMs as number, cleanupDeadlineMs: runtime.cleanupDeadlineMs as number,
    reviewedServicePackageInput,
    confirmOwnerAttachedTerminal: terminalOwner.confirmOwnerAttachedTerminal.bind(terminalOwner),
    executeStep: toolOwner.executeStep.bind(toolOwner), observeFinal: toolOwner.observeFinal.bind(toolOwner),
    cleanup: toolOwner.cleanup.bind(toolOwner) });
}

function attached(value: unknown, context: PrivateMacosServiceOwnerContextV1) {
  const confirmation = exactRecord(value, ["schema", "requestDigest", "lifecycleDigest", "action", "ownerAttached", "confirmed"]);
  if (confirmation.schema !== PRIVATE_MACOS_SERVICE_OWNER_ATTACHED_TERMINAL_V1
    || confirmation.requestDigest !== context.requestDigest || confirmation.lifecycleDigest !== context.lifecycleDigest
    || confirmation.action !== "install" || confirmation.ownerAttached !== true || confirmation.confirmed !== true) return refused();
}

function strictToolResult(value: unknown): "succeeded" | "failed_before_effect" {
  const result = exactRecord(value, ["outcome"]);
  if (result.outcome !== "succeeded" && result.outcome !== "failed_before_effect") return uncertain();
  return result.outcome;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(sanitized("uncertain"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(sanitized("uncertain"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function invoke<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return uncertain();
  try { return await raceAbort(Promise.resolve().then(call), signal); }
  catch (error) { throw sanitized(failureKind(error) ?? "uncertain"); }
}

async function cleanup(runtime: ReturnType<typeof capturedRuntime>): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(sanitized("uncertain")); }, runtime.cleanupDeadlineMs);
    });
    const result = exactRecord(await Promise.race([runtime.cleanup(controller.signal), deadline]), ["outcome"]);
    return result.outcome === "confirmed" && !controller.signal.aborted;
  } catch { return false; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function finalObservation(value: unknown, request: ReturnType<typeof capturedRequest>): string {
  const result = exactRecord(value, ["schema", "requestDigest", "lifecycleDigest",
    "installedServiceDefinitionDigest", "serviceObservation"]);
  if (result.schema !== PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1 || result.requestDigest !== request.requestDigest
    || result.lifecycleDigest !== request.lifecycle.lifecycleDigest
    || result.installedServiceDefinitionDigest !== request.serviceDefinitionDigest) return uncertain();
  let observation: ReturnType<typeof captureLocalPlatformServiceObservationV1>;
  try { observation = captureLocalPlatformServiceObservationV1(result.serviceObservation); }
  catch { return uncertain(); }
  const plan = request.installationPlan;
  if (observation.state !== "running" || observation.topologyPlanDigest !== plan.topologyPlanDigest
    || observation.releaseDigest !== request.lifecycle.targetReleaseDigest
    || observation.serviceIdentityDigest !== request.lifecycle.serviceIdentityDigest
    || observation.databaseAuthorityDigest !== request.lifecycle.authorityDatabaseDigest
    || observation.protectedDataBindingDigest !== request.lifecycle.protectedDataDigest
    || observation.supervisorReadinessDigest !== request.lifecycle.supervisorReadinessDigest) return uncertain();
  return sha256Digest({ purpose: "private-macos-service-terminal-evidence/v1",
    requestDigest: request.requestDigest, lifecycleDigest: request.lifecycle.lifecycleDigest,
    installedServiceDefinitionDigest: request.serviceDefinitionDigest, serviceObservation: observation });
}

/**
 * Executes the already-prepared initial install through one injected private
 * port. A real port is intentionally absent. Known pre-effect failure refuses;
 * anything after a write/transition may have begun is uncertainty.
 */
export async function runPrivateMacosServiceOwnerActionV1(input: unknown,
  runtimeInput: unknown): Promise<PrivateMacosServiceOwnerResultV1> {
  let request: ReturnType<typeof capturedRequest>, runtime: ReturnType<typeof capturedRuntime>;
  try { request = capturedRequest(input); runtime = capturedRuntime(runtimeInput); }
  catch { return refused(); }
  if (sha256Digest(createMacosLocalServicePackageV1(runtime.reviewedServicePackageInput).plist)
    !== request.serviceDefinitionDigest) return refused();
  if (runtime.signal.aborted) return refused();
  const controller = new AbortController();
  const abort = () => controller.abort();
  runtime.signal.addEventListener("abort", abort, { once: true });
  const deadlineUnixMs = Date.now() + runtime.controlDeadlineMs;
  const timer = setTimeout(() => controller.abort(), runtime.controlDeadlineMs);
  const context = Object.freeze({ requestDigest: request.requestDigest, lifecycleDigest: request.lifecycle.lifecycleDigest,
    action: "install" as const, signal: controller.signal });
  let effectStarted = false;
  let result: PrivateMacosServiceOwnerResultV1 | undefined;
  let failure: "refused" | "uncertain" | undefined;
  try {
    attached(await invoke(() => runtime.confirmOwnerAttachedTerminal(context), controller.signal), context);
    const report = await simulateMacosServiceOwnerActionV1({ ownerAuthorized: true, lifecycle: request.lifecycle,
      lifecycleInput: request.lifecycleInput, servicePackageInput: request.servicePackageInput }, { runner: async step => {
      if (controller.signal.aborted || Date.now() >= deadlineUnixMs) return { outcome: "uncertain" as const };
      const toolRequest = Object.freeze({ schema: PRIVATE_MACOS_SERVICE_TOOL_V1, requestDigest: request.requestDigest,
        deadlineUnixMs, step });
      const outcome = strictToolResult(await invoke(() => runtime.executeStep(toolRequest, controller.signal), controller.signal));
      if (outcome === "succeeded" && step.kind !== "read") effectStarted = true;
      return { outcome: outcome === "succeeded" ? "succeeded" as const : "failed" as const };
    } });
    if (report.outcome !== "completed") throw sanitized(report.outcome === "failed" && !effectStarted ? "refused" : "uncertain");
    const observationRequest = Object.freeze({ schema: PRIVATE_MACOS_SERVICE_TOOL_V1,
      operation: "observe_installed_service" as const, requestDigest: request.requestDigest,
      lifecycleDigest: request.lifecycle.lifecycleDigest, label: PRIVATE_MACOS_SERVICE_LABEL_V1,
      expectedReleaseDigest: digest(request.lifecycle.targetReleaseDigest),
      expectedServiceIdentityDigest: request.lifecycle.serviceIdentityDigest,
      expectedServiceDefinitionDigest: request.serviceDefinitionDigest, deadlineUnixMs });
    const terminalEvidenceDigest = finalObservation(
      await invoke(() => runtime.observeFinal(observationRequest, controller.signal), controller.signal), request);
    const terminalConfirmation = Object.freeze({ schema: PRIVATE_MACOS_SERVICE_TERMINAL_CONFIRMATION_V1,
      requestDigest: request.requestDigest, lifecycleDigest: request.lifecycle.lifecycleDigest, action: "install" as const,
      terminalEvidenceDigest, serviceState: "running" as const, terminalState: "confirmed" as const });
    result = Object.freeze({ schema: PRIVATE_MACOS_SERVICE_OWNER_RUNNER_V1, requestDigest: request.requestDigest,
      lifecycleDigest: request.lifecycle.lifecycleDigest, action: "install" as const,
      disposition: "terminal_confirmation" as const, terminalEvidenceDigest, cleanupConfirmed: true as const,
      grantsAgentReadiness: false as const, terminalConfirmation });
  } catch (error) { failure = failureKind(error) ?? (effectStarted || controller.signal.aborted ? "uncertain" : "refused"); }
  finally { clearTimeout(timer); }
  const cleanupConfirmed = await cleanup(runtime);
  const cancelled = runtime.signal.aborted || controller.signal.aborted;
  runtime.signal.removeEventListener("abort", abort);
  if (!cleanupConfirmed || cancelled || failure || !result) throw sanitized(!cleanupConfirmed || cancelled || failure === "uncertain"
    ? "uncertain" : "refused");
  return result;
}

function terminalConfirmation(value: unknown, request: ReturnType<typeof capturedRequest>) {
  const confirmation = exactRecord(value, ["schema", "requestDigest", "lifecycleDigest", "action",
    "terminalEvidenceDigest", "serviceState", "terminalState"]);
  if (confirmation.schema !== PRIVATE_MACOS_SERVICE_TERMINAL_CONFIRMATION_V1
    || confirmation.requestDigest !== request.requestDigest || confirmation.lifecycleDigest !== request.lifecycle.lifecycleDigest
    || confirmation.action !== "install" || confirmation.serviceState !== "running"
    || confirmation.terminalState !== "confirmed") return refused();
  return digest(confirmation.terminalEvidenceDigest);
}

function receiptFor(installationId: string, request: ReturnType<typeof capturedRequest>, evidence: string) {
  const body = { schema: PRIVATE_MACOS_SERVICE_TERMINAL_RECEIPT_V1, installationId,
    requestDigest: request.requestDigest, lifecycleDigest: request.lifecycle.lifecycleDigest,
    installationPlanDigest: request.lifecycle.installationPlanDigest,
    installationPlanRevision: request.lifecycle.installationPlanRevision, stage: "platform_service" as const,
    action: "install" as const, terminalEvidenceDigest: evidence, serviceState: "running" as const,
    grantsAgentReadiness: false as const };
  return Object.freeze({ ...body,
    receiptDigest: sha256Digest({ purpose: "private-macos-service-terminal-receipt/v1", receipt: body }) });
}

function current(history: readonly InstallationPlanV1[]) { const plan = history.at(-1); if (!plan) return refused(); return plan; }
function expectedPlan(history: readonly InstallationPlanV1[], receipt: PrivateMacosServiceTerminalReceiptV1) {
  const plan = history[receipt.installationPlanRevision];
  if (!plan || plan.planDigest !== receipt.installationPlanDigest || stage(plan, "platform_service").state !== "running") return refused();
  return plan;
}
function recovered(history: readonly InstallationPlanV1[], receipt: PrivateMacosServiceTerminalReceiptV1) {
  const settled = history[receipt.installationPlanRevision + 1];
  if (!settled) return false;
  const terminal = stage(settled, "platform_service");
  if (settled.revision !== receipt.installationPlanRevision + 1 || terminal.state !== "passed"
    || terminal.recordedRevision !== settled.revision || terminal.outcomeDigest !== receipt.receiptDigest
    || stage(current(history), "platform_service").state !== "passed"
    || stage(current(history), "platform_service").outcomeDigest !== receipt.receiptDigest) return refused();
  return true;
}
async function assertJournalIdentity(journal: Journal, installationId: string, plan: InstallationPlanV1) {
  let appended;
  try { appended = await journal.append(plan); } catch { return refused(); }
  if (appended.installationId !== installationId || appended.revision !== plan.revision
    || appended.planDigest !== plan.planDigest) return refused();
  return appended;
}

/** Records only an exact terminal confirmation in the existing installation journal. */
export async function confirmPrivateMacosServiceOwnerActionTerminalV1(input: unknown,
  runtime: Readonly<{ journal: Journal }>): Promise<PrivateMacosServiceSettlementResultV1> {
  const envelope = exactRecord(input, ["installationId", "request", "terminalConfirmation"]);
  if (typeof envelope.installationId !== "string" || !installationIdPattern.test(envelope.installationId)
    || !runtime?.journal || typeof runtime.journal.append !== "function" || typeof runtime.journal.readHistory !== "function") return refused();
  const journalOwner = runtime.journal;
  const journal: Journal = Object.freeze({ append: journalOwner.append.bind(journalOwner),
    readHistory: journalOwner.readHistory.bind(journalOwner) });
  const request = capturedRequest(envelope.request);
  const evidence = terminalConfirmation(envelope.terminalConfirmation, request);
  const receipt = receiptFor(envelope.installationId, request, evidence);
  try {
    let history = await journal.readHistory();
    const original = expectedPlan(history, receipt);
    await assertJournalIdentity(journal, envelope.installationId, original);
    history = await journal.readHistory();
    expectedPlan(history, receipt);
    if (recovered(history, receipt)) return Object.freeze({ receipt, replayed: true,
      createsReceiptStore: false as const, grantsAgentReadiness: false as const });
    if (history.length !== receipt.installationPlanRevision + 1) return refused();
    const next = advanceInstallationPlanV1(history.at(-1), { expectedRevision: receipt.installationPlanRevision,
      stage: "platform_service", action: "pass", outcomeDigest: receipt.receiptDigest });
    const appended = await assertJournalIdentity(journal, envelope.installationId, next);
    return Object.freeze({ receipt, replayed: appended.replayed, createsReceiptStore: false as const,
      grantsAgentReadiness: false as const });
  } catch {
    try {
      const history = await journal.readHistory();
      const original = expectedPlan(history, receipt);
      await assertJournalIdentity(journal, envelope.installationId, original);
      if (recovered(history, receipt)) return Object.freeze({ receipt, replayed: true,
        createsReceiptStore: false as const, grantsAgentReadiness: false as const });
    } catch { /* Missing, changed, or uncertain service evidence remains owner attention. */ }
    return refused();
  }
}
