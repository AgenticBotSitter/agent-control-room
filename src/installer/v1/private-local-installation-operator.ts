import { completeLocalInstallationPrerequisitesV1 } from "./local-installation-prerequisite-transaction";
import { types } from "node:util";
import { exactHostDataSnapshotV1 } from "../../security/host-value";
import { capturePrivateInstalledClaudePostInstallInputV1 } from "./private-installed-claude-post-install-input";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import { InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { createPrivateLocalInstallationRuntimeAssemblyV1 } from "./private-local-installation-runtime-assembly";
import { projectTwoLocalWorkerActivationPreflightV1 } from "./two-local-worker-activation-preflight";
import { verifyHermes021MacosProtectedWorkerReadinessV1 } from
  "../../harness/hermes-021-v1/protected-worker-readiness";
import { verifyClaudeCodeLocalProcessReadinessV1 } from
  "../../harness/claude-code-v1/local-process-readiness";
import { assessSchedulerResultStorageActivationSourceV1, verifySchedulerResultStorageActivationSourceV1,
  type SchedulerResultStorageActivationSourceV1 } from "./scheduler-result-storage-activation-source";
import { composeThreeWorkerActivationBundlePreflightV1,
  createThreeWorkerActivationBundleCustodyV1,
  recordClaudeThreeWorkerActivationSourceProofV1,
  recordHermesThreeWorkerActivationSourceProofV1 } from "./three-worker-activation-bundle-preflight";

/**
 * Installed-process composition only.  The custody implementation is supplied
 * by a later, owner-attended boundary; this module neither reads a credential
 * nor chooses a native port, listener, store, scheduler, or browser action.
 */
export const PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1 =
  "control-room.private-local-installation-operator/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory" | "inspectSettledHistory">;
type SetupStage = "database_authority" | "protected_data" | "first_owner" | "recovery"
  | "platform_service" | "agent_readiness" | "final_review";
type Blocker = "private_configuration_custody_missing" | "native_service_custody_missing";

export type PrivateLocalInstallationOperatorBlockedV1 = Readonly<{
  schema: typeof PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1;
  status: "blocked";
  blocker: Blocker;
  createsStateMachine: false;
  createsStore: false;
  createsScheduler: false;
  startsListener: false;
  exposesBrowserAction: false;
}>;

type CustodyPort = Readonly<{ loadPrivateConfiguration(): Promise<unknown> }>;
type CapturedLoaded = Readonly<{
  prerequisiteInput: unknown;
  assemblyInput: unknown;
  startupDependencies: unknown;
  setupSources: Readonly<Record<SetupStage, unknown>>;
  setupRuntimes: Readonly<Record<SetupStage, unknown | undefined>>;
  localActivationStatus?: Readonly<{
    schedulerResultStorage: SchedulerResultStorageActivationSourceV1;
    hermes?: Readonly<{ readiness: unknown; currentInput: unknown }>;
    claude?: Readonly<{ readiness: unknown; planDigest: string }>;
  }>;
}>;
type Loaded = CapturedLoaded & Readonly<{
  assembly: ReturnType<typeof createPrivateLocalInstallationRuntimeAssemblyV1>;
  assemblyInstallationId: string;
}>;

const stages = Object.freeze(["database_authority", "protected_data", "first_owner", "recovery",
  "platform_service", "agent_readiness", "final_review"] as const);
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const refuse = (): never => {
  const error = new Error("private_local_installation_operator_refused");
  error.stack = undefined;
  throw error;
};

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(name => !Object.prototype.hasOwnProperty.call(value, name)) || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refuse();
  return value as Readonly<Record<string, unknown>>;
}

function allowed(value: unknown, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value), permitted = [...required, ...optional];
  if (names.some(name => !permitted.includes(name)) || required.some(name => !names.includes(name)) || names.some(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) return refuse();
  return value as Readonly<Record<string, unknown>>;
}

function callable(value: unknown, names: readonly string[]) {
  const record = exact(value, names), captured: Record<string, (...args: never[]) => unknown> = {};
  for (const name of names) {
    const callback = record[name];
    if (typeof callback !== "function") return refuse();
    captured[name] = callback as (...args: never[]) => unknown;
  }
  return Object.freeze(captured);
}

function captureJournal(value: unknown): Journal {
  // The release connector hands over the canonical filesystem journal as its
  // actual class instance.  Keep accepting the narrower plain-object port for
  // disposable tests, but never ask an installed caller to re-wrap or clone
  // the durable journal (which would lose its private-root identity checks).
  if (value instanceof InstallationPlanFilesystemJournalV1) return Object.freeze({
    append: value.append.bind(value),
    readHistory: value.readHistory.bind(value),
    inspectSettledHistory: value.inspectSettledHistory.bind(value),
  }) as Journal;
  const journal = callable(value, ["append", "readHistory", "inspectSettledHistory"]);
  return Object.freeze({
    append: Function.prototype.bind.call(journal.append, value),
    readHistory: Function.prototype.bind.call(journal.readHistory, value),
    inspectSettledHistory: Function.prototype.bind.call(journal.inspectSettledHistory, value),
  }) as Journal;
}

function captureCustody(value: unknown): CustodyPort {
  const port = callable(value, ["loadPrivateConfiguration"]);
  return Object.freeze({ loadPrivateConfiguration: Function.prototype.bind.call(port.loadPrivateConfiguration, value) }) as CustodyPort;
}

function captureStageMap(value: unknown): Readonly<Record<SetupStage, unknown>> {
  const supplied = exact(value, stages);
  const captured: Record<string, unknown> = {};
  for (const stage of stages) captured[stage] = supplied[stage];
  return Object.freeze(captured) as Readonly<Record<SetupStage, unknown>>;
}

/** Copies only data-shaped configuration.  Callable and branded/class objects
 * are opaque capabilities: their exact identity is retained, never cloned. */
function captureData(value: unknown, captured = new WeakMap<object, unknown>(), active = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (types.isProxy(value)) return refuse();
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof AbortSignal) return value;
  const previous = captured.get(value);
  if (previous !== undefined) return previous;
  if (active.has(value)) return refuse();
  active.add(value);
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return refuse();
    const result: unknown[] = new Array(length.value as number);
    for (let index = 0; index < result.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refuse();
      result[index] = captureData(descriptor.value, captured, active);
    }
    if (Object.getOwnPropertyNames(value).some(name => name !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(name))) return refuse();
    const frozen = Object.freeze(result);
    active.delete(value); captured.set(value, frozen); return frozen;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) { active.delete(value); return value; }
  if (Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value), descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(value, name)] as const);
  if (descriptors.some(([, descriptor]) => !descriptor || descriptor.enumerable !== true || !("value" in descriptor))) return refuse();
  // A callable plain object is a capability (not configuration). Validate its
  // descriptors, then retain its identity so branded Hermes delivery remains
  // the exact object all existing validators expect.
  if (descriptors.some(([, descriptor]) => typeof (descriptor as PropertyDescriptor & { value: unknown }).value === "function")) {
    active.delete(value); return value;
  }
  const result: Record<string, unknown> = {};
  for (const [name, descriptor] of descriptors) {
    result[name] = captureData((descriptor as PropertyDescriptor & { value: unknown }).value, captured, active);
  }
  active.delete(value);
  const frozen = Object.freeze(result); captured.set(value, frozen); return frozen;
}

/** Strict data-only snapshot for values that will be handed to a structural
 * verifier. Unlike the wider installed configuration capture, this never
 * retains class instances, callable objects, typed arrays, or custom
 * prototypes for later inspection by Zod. */
function captureStrictData(value: unknown, captured = new WeakMap<object, unknown>(), active = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : refuse();
  if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) return refuse();
  const previous = captured.get(value);
  if (previous !== undefined) return previous;
  active.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0
      || Object.getOwnPropertyNames(value).length !== (length.value as number) + 1) return refuse();
    const result: unknown[] = new Array(length.value as number); captured.set(value, result);
    for (let index = 0; index < result.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refuse();
      result[index] = captureStrictData(descriptor.value, captured, active);
    }
    active.delete(value); return Object.freeze(result);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const result: Record<string, unknown> = {}; captured.set(value, result);
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === "__proto__" || name === "prototype" || name === "constructor") return refuse();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refuse();
    result[name] = captureStrictData(descriptor.value, captured, active);
  }
  active.delete(value); return Object.freeze(result);
}

function captureStartupDependencies(value: unknown) {
  const optional = ["clock", "prepareNativeSubmission", "startNativeWorker", "prepareNewsSubmission", "startNewsWorker", "openArtifactStorage"];
  if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value);
  if (!names.includes("openDatabase") || !names.includes("install") || names.some(name => !["openDatabase", "install", ...optional].includes(name))) return refuse();
  const captured: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) || typeof descriptor.value !== "function") return refuse();
    captured[name] = Function.prototype.bind.call(descriptor.value, value);
  }
  return Object.freeze(captured);
}

function captureAssemblyInput(value: unknown) {
  const assembly = exactHostDataSnapshotV1(value,
    ["runnerInput", "operatorSettings", "operatorTrustedInputs"], ["claudePostInstall"]);
  if (!assembly) return refuse();
  // The established assembly immediately performs its own deep, identity-aware
  // capture. Here retain those opaque validated graphs while owning their outer
  // selector so a loader cannot swap a branch after return.
  return Object.freeze({ runnerInput: assembly.runnerInput, operatorSettings: assembly.operatorSettings,
    operatorTrustedInputs: assembly.operatorTrustedInputs,
    ...(Object.prototype.hasOwnProperty.call(assembly, "claudePostInstall")
      ? { claudePostInstall: capturePrivateInstalledClaudePostInstallInputV1(assembly.claudePostInstall) } : {}) });
}

function captureStageRuntime(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 1) return refuse();
  const descriptor = Object.getOwnPropertyDescriptor(value, names[0]!);
  if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refuse();
  const port = descriptor.value;
  if (!port || typeof port !== "object" || types.isProxy(port) || Object.getPrototypeOf(port) !== Object.prototype
    || Object.getOwnPropertySymbols(port).length !== 0) return Object.freeze({ [names[0]!]: port });
  const result: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(port)) {
    const field = Object.getOwnPropertyDescriptor(port, name);
    if (!field || field.enumerable !== true || !("value" in field)) return refuse();
    result[name] = typeof field.value === "function" ? Function.prototype.bind.call(field.value, port)
      : captureData(field.value);
  }
  return Object.freeze({ [names[0]!]: Object.freeze(result) });
}

function captureLoaded(value: unknown): CapturedLoaded {
  const loaded = exactHostDataSnapshotV1(value,
    ["prerequisiteInput", "assemblyInput", "startupDependencies", "setupSources", "setupRuntimes"], ["localActivationStatus"]);
  if (!loaded) return refuse();
  const sources = captureStageMap(loaded.setupSources), runtimes = captureStageMap(loaded.setupRuntimes);
  const captured = new WeakMap<object, unknown>();
  const capturedSources: Record<string, unknown> = {}, capturedRuntimes: Record<string, unknown> = {};
  for (const stage of stages) { capturedSources[stage] = captureData(sources[stage], captured); capturedRuntimes[stage] = captureStageRuntime(runtimes[stage]); }
  const prerequisiteInput = captureData(loaded.prerequisiteInput, captured);
  const binding = prerequisiteBinding(prerequisiteInput);
  let localActivationStatus: CapturedLoaded["localActivationStatus"];
  if (Object.prototype.hasOwnProperty.call(loaded, "localActivationStatus")) {
    // This value originates only in protected installed configuration. Capture
    // each optional worker proof before verifying it, so a browser request or
    // a later caller mutation cannot make an unavailable worker look ready.
    const capturedStatus = captureData(loaded.localActivationStatus);
    const status = allowed(capturedStatus, ["schedulerResultStorage"], ["hermes", "claude"]);
    const schedulerResultStorage = verifySchedulerResultStorageActivationSourceV1(status.schedulerResultStorage);
    if (schedulerResultStorage.installationId !== binding.installationId || schedulerResultStorage.releaseDigest !== binding.releaseDigest
      || schedulerResultStorage.topologyPlanDigest !== binding.topologyPlan.planDigest) return refuse();
    let hermes: Readonly<{ readiness: unknown; currentInput: unknown }> | undefined;
    if (Object.prototype.hasOwnProperty.call(status, "hermes")) {
      const value = exact(status.hermes, ["readiness", "currentInput"]);
      // Re-derive the readiness record now. This retains the established
      // protected Hermes proof boundary rather than trusting a saved summary.
      const readiness = verifyHermes021MacosProtectedWorkerReadinessV1(value.readiness, value.currentInput);
      if (readiness.installationId !== binding.installationId || readiness.releaseDigest !== binding.releaseDigest
        || readiness.topologyPlanDigest !== binding.topologyPlan.planDigest) return refuse();
      hermes = Object.freeze({ readiness, currentInput: value.currentInput });
    }
    let claude: Readonly<{ readiness: unknown; planDigest: string }> | undefined;
    if (Object.prototype.hasOwnProperty.call(status, "claude")) {
      const value = exact(status.claude, ["readiness", "planDigest"]);
      const readiness = verifyClaudeCodeLocalProcessReadinessV1(value.readiness);
      if (typeof value.planDigest !== "string" || value.planDigest !== binding.topologyPlan.planDigest
        || readiness.planDigest !== value.planDigest) return refuse();
      claude = Object.freeze({ readiness, planDigest: value.planDigest });
    }
    localActivationStatus = Object.freeze({ schedulerResultStorage,
      ...(hermes === undefined ? {} : { hermes }), ...(claude === undefined ? {} : { claude }) });
  }
  return Object.freeze({ prerequisiteInput,
    assemblyInput: captureAssemblyInput(loaded.assemblyInput), startupDependencies: captureStartupDependencies(loaded.startupDependencies),
    setupSources: Object.freeze(capturedSources) as Readonly<Record<SetupStage, unknown>>,
    setupRuntimes: Object.freeze(capturedRuntimes) as Readonly<Record<SetupStage, unknown | undefined>>,
    ...(localActivationStatus ? { localActivationStatus } : {}) });
}

function localActivationStatus(configured: CapturedLoaded, binding: ReturnType<typeof prerequisiteBinding>) {
  // Older installed configurations have no retained local preflight yet. Show
  // only the honest empty projection and the existing blocked scheduler/store
  // assessment; do not infer qualification or readiness from configuration.
  const retainedScheduler = configured.localActivationStatus?.schedulerResultStorage;
  const activationCustody = createThreeWorkerActivationBundleCustodyV1({ installationId: binding.installationId,
    releaseDigest: binding.releaseDigest, topologyPlanDigest: binding.topologyPlan.planDigest });
  const hermes = configured.localActivationStatus?.hermes;
  const claude = configured.localActivationStatus?.claude;
  const localWorkers = projectTwoLocalWorkerActivationPreflightV1({
    ...(hermes ? { hermes } : {}), ...(claude ? { claude } : {}),
  });
  const activationProofs = [
    ...(hermes ? [recordHermesThreeWorkerActivationSourceProofV1({
      aggregate: activationCustody.aggregate, readiness: hermes.readiness, currentInput: hermes.currentInput,
    })] : []),
    ...(claude ? [recordClaudeThreeWorkerActivationSourceProofV1({
      aggregate: activationCustody.aggregate, readiness: claude.readiness,
    })] : []),
  ];
  return Object.freeze({
    // The optional records were re-derived from protected installed inputs in
    // `captureLoaded`. This is presentation only: even a prepared result here
    // does not enable a worker or grant task authority.
    twoLocalWorkerPreflight: localWorkers,
    schedulerResultStorage: retainedScheduler ?? assessSchedulerResultStorageActivationSourceV1({
      installationId: binding.installationId, releaseDigest: binding.releaseDigest,
      topologyPlanDigest: binding.topologyPlan.planDigest,
      schedulerReadinessEvidence: undefined, protectedStorageRestoreEvidence: undefined }),
    // This output is a redacted, read-only checklist. It is created from the
    // installed plan binding only and accepts no caller-supplied readiness or
    // action capability, so status cannot manufacture a worker enablement.
    activationBundle: composeThreeWorkerActivationBundlePreflightV1({
      aggregate: activationCustody.aggregate, sourceProofs: activationProofs,
    }),
  });
}

function blocked(blocker: Blocker): PrivateLocalInstallationOperatorBlockedV1 {
  return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1, status: "blocked", blocker,
    createsStateMachine: false, createsStore: false, createsScheduler: false, startsListener: false,
    exposesBrowserAction: false });
}

function current(history: readonly InstallationPlanV1[]): InstallationPlanV1 {
  const last = history.at(-1);
  if (!last || history.length !== last.revision + 1) return refuse();
  return verifyInstallationPlanV1(last);
}

function next(plan: InstallationPlanV1): SetupStage | undefined {
  const item = plan.stages.find(stage => stage.state !== "passed");
  if (!item) return undefined;
  if (!stages.includes(item.stage as SetupStage) || item.state !== "not_started") return refuse();
  return item.stage as SetupStage;
}

function runtimeFor(stage: SetupStage, supplied: unknown): Readonly<Record<string, unknown>> | PrivateLocalInstallationOperatorBlockedV1 {
  if (stage === "platform_service" && supplied === undefined) return blocked("native_service_custody_missing");
  if (supplied === undefined) return blocked("private_configuration_custody_missing");
  const property: Record<SetupStage, string> = {
    database_authority: "postgres", protected_data: "protectedData", first_owner: "firstOwner", recovery: "recovery",
    platform_service: "platformService", agent_readiness: "agentReadiness", final_review: "finalReview",
  };
  const runtime = exact(supplied, [property[stage]]), name = property[stage]!;
  return Object.freeze({ [name]: runtime[name] });
}

function cancellation(signal: AbortSignal | undefined) {
  if (signal?.aborted) return refuse();
}

function prerequisiteBinding(value: unknown) {
  const input = exact(value, ["installationId", "topologyPlan", "releaseDigest", "releasePreflight", "privatePlacement"]);
  if (typeof input.installationId !== "string" || !installationIdPattern.test(input.installationId)
    || typeof input.releaseDigest !== "string" || !digestPattern.test(input.releaseDigest)) return refuse();
  return Object.freeze({ installationId: input.installationId, releaseDigest: input.releaseDigest,
    topologyPlan: verifyInstallationTopologyPlanV1(input.topologyPlan) });
}

function assemblyInstallationId(value: unknown) {
  const assembly = exactHostDataSnapshotV1(value,
    ["runnerInput", "operatorSettings", "operatorTrustedInputs"], ["claudePostInstall"]);
  if (!assembly) return refuse();
  const runner = exact(assembly.runnerInput, ["admissionPreparationInput", "privateStartupConfiguration", "startupAdmissionBinding"]);
  const admission = exact(runner.admissionPreparationInput, ["installationId", "installationPlan", "topologyInput", "workerBinding",
    "installationBinding", "installationBindingInput"]);
  if (typeof admission.installationId !== "string" || !installationIdPattern.test(admission.installationId)) return refuse();
  return admission.installationId;
}

function prerequisiteState(plan: InstallationPlanV1) {
  const release = plan.stages.find(stage => stage.stage === "release_preflight");
  const placement = plan.stages.find(stage => stage.stage === "private_placement");
  if (!release || !placement) return refuse();
  if (release.state === "passed" && placement.state === "passed") return "settled" as const;
  if (release.state !== "not_started" || placement.state !== "not_started") return refuse();
  return "pending" as const;
}

function linkedRuntime(stage: SetupStage, runtime: Readonly<Record<string, unknown>>, parent: AbortSignal | undefined) {
  const name: Record<SetupStage, string> = { database_authority: "postgres", protected_data: "protectedData",
    first_owner: "firstOwner", recovery: "recovery", platform_service: "platformService",
    agent_readiness: "agentReadiness", final_review: "finalReview" };
  const port = runtime[name[stage]!];
  if (!port || typeof port !== "object" || types.isProxy(port)) return refuse();
  const fields = Object.getOwnPropertyNames(port);
  const signalDescriptor = Object.getOwnPropertyDescriptor(port, "signal");
  if (!signalDescriptor || !("value" in signalDescriptor)) return refuse();
  const supplied = signalDescriptor.value as AbortSignal;
  if (!supplied || typeof supplied.aborted !== "boolean" || typeof supplied.addEventListener !== "function"
    || typeof supplied.removeEventListener !== "function") return refuse();
  const controller = new AbortController(), abort = () => controller.abort();
  supplied.addEventListener("abort", abort, { once: true });
  parent?.addEventListener("abort", abort, { once: true });
  if (supplied.aborted || parent?.aborted) controller.abort();
  const replacement: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(port, field);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refuse();
    replacement[field] = field === "signal" ? controller.signal : descriptor.value;
  }
  return Object.freeze({ runtime: Object.freeze({ [name[stage]!]: Object.freeze(replacement) }),
    close() { supplied.removeEventListener("abort", abort); parent?.removeEventListener("abort", abort); } });
}

/**
 * Captures only the exact loader and canonical journal at construction.  Each
 * operation performs a fresh custody load: retained uncertain journal state
 * is never retried or hidden in process memory.
 */
export function createPrivateLocalInstallationOperatorV1(custodyValue: unknown, runtimeValue: unknown) {
  let custody: CustodyPort, journal: Journal;
  try {
    custody = captureCustody(custodyValue);
    journal = captureJournal(exact(runtimeValue, ["journal"]).journal);
  } catch {
    return blocked("private_configuration_custody_missing");
  }

  async function load(signal?: AbortSignal): Promise<Loaded | PrivateLocalInstallationOperatorBlockedV1> {
    cancellation(signal);
    let value: unknown;
    try { value = await custody.loadPrivateConfiguration(); }
    catch { return blocked("private_configuration_custody_missing"); }
    cancellation(signal);
    try {
      const captured = captureLoaded(value);
      return Object.freeze({ ...captured, assemblyInstallationId: assemblyInstallationId(captured.assemblyInput),
        assembly: createPrivateLocalInstallationRuntimeAssemblyV1(captured.assemblyInput,
          { journal, startupDependencies: captured.startupDependencies }) });
    }
    catch { return blocked("private_configuration_custody_missing"); }
  }

  async function authenticatedCurrent(configured: Loaded, signal?: AbortSignal) {
    const binding = prerequisiteBinding(configured.prerequisiteInput);
    const plan = current(await journal.readHistory());
    cancellation(signal);
    if (plan.releaseDigest !== binding.releaseDigest || plan.topologyPlanDigest !== binding.topologyPlan.planDigest) return refuse();
    const authenticated = await journal.append(plan);
    cancellation(signal);
    if (authenticated.installationId !== binding.installationId || authenticated.revision !== plan.revision
      || authenticated.planDigest !== plan.planDigest) return refuse();
    const reread = current(await journal.readHistory());
    cancellation(signal);
    if (reread.planDigest !== plan.planDigest) return refuse();
    return Object.freeze({ binding, plan });
  }

  async function currentAfterPrerequisites(configured: Loaded, signal?: AbortSignal) {
    let bound = await authenticatedCurrent(configured, signal);
    if (prerequisiteState(bound.plan) === "settled") return bound;
    await completeLocalInstallationPrerequisitesV1(configured.prerequisiteInput, { journal });
    cancellation(signal);
    bound = await authenticatedCurrent(configured, signal);
    if (prerequisiteState(bound.plan) !== "settled") return refuse();
    return bound;
  }

  async function status(signal?: AbortSignal) {
    const configured = await load(signal);
    if ("status" in configured) return configured;
    cancellation(signal);
    let plan: InstallationPlanV1;
    try {
      const authenticated = await authenticatedCurrent(configured, signal);
      plan = authenticated.plan;
      // Verify/capture the redacted activation evidence before any stage port
      // is observed. A stale, tampered, or foreign assessment is not a status.
      localActivationStatus(configured, authenticated.binding);
    }
    catch { return blocked("private_configuration_custody_missing"); }
    const assembly = configured.assembly;
    if (assembly.status === "blocked") return blocked(assembly.blocker);
    if (configured.assemblyInstallationId !== prerequisiteBinding(configured.prerequisiteInput).installationId)
      return blocked("private_configuration_custody_missing");
    const stage = next(plan);
    if (stage) {
      const stageRuntime = runtimeFor(stage, configured.setupRuntimes[stage]);
      if ("status" in stageRuntime) return stageRuntime;
      try { linkedRuntime(stage, stageRuntime, signal).close(); }
      catch { return blocked(stage === "platform_service" ? "native_service_custody_missing" : "private_configuration_custody_missing"); }
    }
    const binding = prerequisiteBinding(configured.prerequisiteInput);
    return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1, status: "ready" as const,
      nextStage: stage ?? "complete", installationPlanDigest: plan.planDigest, installationPlanRevision: plan.revision,
      localActivationStatus: localActivationStatus(configured, binding),
      createsStateMachine: false as const, createsStore: false as const, createsScheduler: false as const,
      startsListener: false as const, exposesBrowserAction: false as const });
  }

  return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1, status,
    async setupNext(signal?: AbortSignal) {
      const configured = await load(signal);
      if ("status" in configured) return configured;
      cancellation(signal);
      let bound: Awaited<ReturnType<typeof currentAfterPrerequisites>>;
      try { bound = await currentAfterPrerequisites(configured, signal); }
      catch { return refuse(); }
      const plan = bound.plan;
      const stage = next(plan);
      if (!stage) return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1, status: "complete" as const,
        installationPlanDigest: plan.planDigest, installationPlanRevision: plan.revision, createsStateMachine: false as const,
        createsStore: false as const, createsScheduler: false as const, startsListener: false as const,
        exposesBrowserAction: false as const });
      const stageRuntime = runtimeFor(stage, configured.setupRuntimes[stage]);
      if ("status" in stageRuntime) return stageRuntime;
      const prerequisiteInput = bound.binding;
      if (configured.assemblyInstallationId !== prerequisiteInput.installationId)
        return blocked("private_configuration_custody_missing");
      const assembly = configured.assembly;
      if (assembly.status === "blocked") return blocked(assembly.blocker);
      const linked = linkedRuntime(stage, stageRuntime, signal);
      try {
        cancellation(signal);
        const result = await assembly.dispatchSetup(Object.freeze({ installationId: prerequisiteInput.installationId,
          expectedPlanRevision: plan.revision, expectedPlanDigest: plan.planDigest, expectedReleaseDigest: plan.releaseDigest,
          requestedStage: stage, topologyPlan: prerequisiteInput.topologyPlan, source: configured.setupSources[stage],
        }), linked.runtime);
        cancellation(signal);
        return result;
      } finally { linked.close(); }
    },
    async start(signal?: AbortSignal) {
      const configured = await load(signal);
      if ("status" in configured) return configured;
      cancellation(signal);
      let bound: Awaited<ReturnType<typeof authenticatedCurrent>>;
      try { bound = await authenticatedCurrent(configured, signal); }
      catch { return blocked("private_configuration_custody_missing"); }
      cancellation(signal);
      if (configured.assemblyInstallationId !== bound.binding.installationId)
        return blocked("private_configuration_custody_missing");
      const assembly = configured.assembly;
      if (assembly.status === "blocked") return blocked(assembly.blocker);
      // `start` performs the existing settled-journal re-verification directly
      // before it delegates to the sole private task bootstrap boundary.
      return assembly.start(signal);
    },
    createsStateMachine: false as const, createsStore: false as const, createsScheduler: false as const,
    startsListener: false as const, exposesBrowserAction: false as const,
  });
}
