import { verifyLocalBackupRestoreReadinessV1,
  type LocalBackupRestoreReadinessV1 } from "../../harness/v1/local-backup-restore-readiness";
import { sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationActionPreparationV1 } from "./installation-action-preparation";
import { prepareProtectedDataRecoveryOwnerActionV1 } from "./protected-data-recovery-owner-action";

/** Source-only boundary. The real backup and restore callables remain private and injected. */
export const PRIVATE_RECOVERY_OWNER_RUNNER_V1 = "control-room.private-recovery-owner-runner/v1" as const;
export const PRIVATE_RECOVERY_INSTALLATION_BINDING_V1 =
  "control-room.private-recovery-installation-binding/v1" as const;
export const PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1 =
  "control-room.private-recovery-owner-attached-terminal/v1" as const;
export const PRIVATE_RECOVERY_TERMINAL_CONFIRMATION_V1 =
  "control-room.private-recovery-terminal-confirmation/v1" as const;

export type PrivateRecoveryRequestV1 = Readonly<{
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  preparationDigest: string;
  protectedDataBindingDigest: string;
  storageConfigurationDigest: string;
  storageNamespaceDigest: string;
  databaseAuthorityOutcomeDigest: string;
  expectedDatabaseIdentityDigest: string;
  expectedDatabaseSchemaDigest: string;
  ownerActionRequestDigest: string;
  operation: "owner_run_existing_backup_restore_rehearsal";
  requestDigest: string;
}>;

export type PrivateRecoveryInstallationBindingV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_INSTALLATION_BINDING_V1;
  installationId: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  protectedDataBindingDigest: string;
  databaseAuthorityOutcomeDigest: string;
}>;

export type PrivateRecoveryRunnerContextV1 = Readonly<{
  installationId: string;
  requestDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  protectedDataBindingDigest: string;
  databaseAuthorityOutcomeDigest: string;
  signal: AbortSignal;
}>;

export type PrivateRecoveryOwnerAttachedTerminalV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1;
  installationId: string;
  requestDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  protectedDataBindingDigest: string;
  databaseAuthorityOutcomeDigest: string;
  ownerAttached: true;
  confirmed: true;
}>;

export type PrivateRecoveryTerminalConfirmationV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_TERMINAL_CONFIRMATION_V1;
  installationId: string;
  requestDigest: string;
  backupRestoreProof: LocalBackupRestoreReadinessV1;
  terminalState: "confirmed";
}>;

export type PrivateRecoveryOwnerResultV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_OWNER_RUNNER_V1;
  installationId: string;
  requestDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  protectedDataBindingDigest: string;
  databaseAuthorityOutcomeDigest: string;
  backupRestoreProofDigest: string;
  disposition: "terminal_confirmation";
  terminalConfirmation: PrivateRecoveryTerminalConfirmationV1;
  performsEffect: false;
  runsBackup: false;
  runsRestore: false;
  promotesRestore: false;
}>;

export type PrivateRecoveryOwnerRuntimeV1 = Readonly<{
  binding: PrivateRecoveryInstallationBindingV1;
  signal: AbortSignal;
  controlDeadlineMs: number;
  confirmOwnerAttachedTerminal(context: PrivateRecoveryRunnerContextV1): Promise<PrivateRecoveryOwnerAttachedTerminalV1>;
  /** Private composition delegates to the retained adapters; this module provides no implementation. */
  runExistingBackupRestoreRehearsal(context: PrivateRecoveryRunnerContextV1): Promise<unknown>;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const failureKinds = new WeakMap<object, "refused" | "uncertain">();
function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_recovery_owner_runner_${kind}`);
  error.stack = undefined; failureKinds.set(error, kind); return error;
}
function refused(): never { throw sanitized("refused"); }
function uncertain(): never { throw sanitized("uncertain"); }
function failureKind(value: unknown) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? failureKinds.get(value as object) : undefined;
}
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
function digest(value: unknown): string { if (typeof value !== "string" || !digestPattern.test(value)) return refused(); return value; }

/** Rebuilds the exact redacted recovery request and adds no effect capability. */
export function preparePrivateRecoveryOwnerRequestV1(input: unknown): PrivateRecoveryRequestV1 {
  try {
    const envelope = exact(input, ["actionPreparation", "actionInput"]);
    const action = verifyInstallationActionPreparationV1(envelope.actionPreparation, envelope.actionInput);
    const ownerAction = prepareProtectedDataRecoveryOwnerActionV1(envelope);
    const prepared = exact(action.preparedAction, ["schema", "installationPlanDigest", "topologyPlanDigest", "releaseDigest",
      "protectedDataBindingDigest", "storageConfigurationDigest", "storageNamespaceDigest", "databaseAuthorityOutcomeDigest",
      "expectedDatabaseIdentityDigest", "expectedDatabaseSchemaDigest", "observedState", "observationDigest", "stage",
      "stageInputDigest", "nextOperation", "precondition", "preparationDigest", "runsBackup", "runsRestore", "promotesRestore",
      "exposesPath", "exposesCredentials", "startsService", "grantsExecutionAuthority"]);
    if (action.action !== "recovery" || action.stage !== "recovery" || ownerAction.action !== "recovery"
      || ownerAction.operation !== "owner_run_existing_backup_restore_rehearsal" || prepared.observedState !== "not_proven") return refused();
    const material = { installationPlanDigest: action.installationPlanDigest,
      installationPlanRevision: action.installationPlanRevision, topologyPlanDigest: action.topologyPlanDigest,
      releaseDigest: action.releaseDigest, preparationDigest: digest(prepared.preparationDigest),
      protectedDataBindingDigest: digest(prepared.protectedDataBindingDigest),
      storageConfigurationDigest: digest(prepared.storageConfigurationDigest),
      storageNamespaceDigest: digest(prepared.storageNamespaceDigest),
      databaseAuthorityOutcomeDigest: digest(prepared.databaseAuthorityOutcomeDigest),
      expectedDatabaseIdentityDigest: digest(prepared.expectedDatabaseIdentityDigest),
      expectedDatabaseSchemaDigest: digest(prepared.expectedDatabaseSchemaDigest),
      ownerActionRequestDigest: sha256Digest({ purpose: "protected-data-recovery-owner-action-request/v1", request: ownerAction }),
      operation: "owner_run_existing_backup_restore_rehearsal" as const };
    return Object.freeze({ ...material,
      requestDigest: sha256Digest({ purpose: "private-recovery-owner-request/v1", request: material }) });
  } catch { return refused(); }
}

function capturedRuntime(value: unknown, request: PrivateRecoveryRequestV1) {
  const runtime = exact(value, ["binding", "signal", "controlDeadlineMs", "confirmOwnerAttachedTerminal",
    "runExistingBackupRestoreRehearsal"]), binding = exact(runtime.binding, ["schema", "installationId",
      "installationPlanDigest", "installationPlanRevision", "topologyPlanDigest", "releaseDigest",
      "protectedDataBindingDigest", "databaseAuthorityOutcomeDigest"]);
  if (binding.schema !== PRIVATE_RECOVERY_INSTALLATION_BINDING_V1 || typeof binding.installationId !== "string"
    || !installationIdPattern.test(binding.installationId) || binding.installationPlanDigest !== request.installationPlanDigest
    || binding.installationPlanRevision !== request.installationPlanRevision || binding.topologyPlanDigest !== request.topologyPlanDigest
    || binding.releaseDigest !== request.releaseDigest || binding.protectedDataBindingDigest !== request.protectedDataBindingDigest
    || binding.databaseAuthorityOutcomeDigest !== request.databaseAuthorityOutcomeDigest || !runtime.signal
    || typeof runtime.signal !== "object" || typeof (runtime.signal as AbortSignal).aborted !== "boolean"
    || typeof (runtime.signal as AbortSignal).addEventListener !== "function" || !Number.isSafeInteger(runtime.controlDeadlineMs)
    || (runtime.controlDeadlineMs as number) < 1 || (runtime.controlDeadlineMs as number) > 300_000
    || typeof runtime.confirmOwnerAttachedTerminal !== "function" || typeof runtime.runExistingBackupRestoreRehearsal !== "function") return refused();
  const owner = value as PrivateRecoveryOwnerRuntimeV1;
  return Object.freeze({ binding: Object.freeze({ ...binding }) as unknown as PrivateRecoveryInstallationBindingV1,
    signal: runtime.signal as AbortSignal, controlDeadlineMs: runtime.controlDeadlineMs as number,
    confirm: owner.confirmOwnerAttachedTerminal.bind(owner), run: owner.runExistingBackupRestoreRehearsal.bind(owner) });
}
function context(request: PrivateRecoveryRequestV1, runtime: ReturnType<typeof capturedRuntime>): PrivateRecoveryRunnerContextV1 {
  return Object.freeze({ installationId: runtime.binding.installationId, requestDigest: request.requestDigest,
    installationPlanDigest: request.installationPlanDigest, installationPlanRevision: request.installationPlanRevision,
    topologyPlanDigest: request.topologyPlanDigest, releaseDigest: request.releaseDigest,
    protectedDataBindingDigest: request.protectedDataBindingDigest,
    databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest, signal: runtime.signal });
}
function attached(value: unknown, expected: PrivateRecoveryRunnerContextV1) {
  const result = exact(value, ["schema", "installationId", "requestDigest", "installationPlanDigest",
    "installationPlanRevision", "topologyPlanDigest", "releaseDigest", "protectedDataBindingDigest",
    "databaseAuthorityOutcomeDigest", "ownerAttached", "confirmed"]);
  for (const name of ["installationId", "requestDigest", "installationPlanDigest", "installationPlanRevision",
    "topologyPlanDigest", "releaseDigest", "protectedDataBindingDigest", "databaseAuthorityOutcomeDigest"] as const) {
    if (result[name] !== expected[name]) return refused();
  }
  if (result.schema !== PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1 || result.ownerAttached !== true
    || result.confirmed !== true) return refused();
}
function proof(value: unknown, request: PrivateRecoveryRequestV1): LocalBackupRestoreReadinessV1 {
  let result: LocalBackupRestoreReadinessV1;
  try { result = verifyLocalBackupRestoreReadinessV1(value); } catch { return uncertain(); }
  if (result.planDigest !== request.topologyPlanDigest || result.releaseDigest !== request.releaseDigest
    || result.storageNamespaceDigest !== request.storageNamespaceDigest
    || result.databaseIdentityDigest !== request.expectedDatabaseIdentityDigest
    || result.databaseSchemaDigest !== request.expectedDatabaseSchemaDigest || result.restoredToDisposableTarget !== true
    || result.promoted !== false || result.startsWork !== false || result.grantsExecutionAuthority !== false
    || result.permitsRetry !== false || result.permitsCleanup !== false) return uncertain();
  return Object.freeze({ ...result });
}
async function bounded<T>(call: () => Promise<T>, signal: AbortSignal, timeoutMs: number,
  timeoutKind: "refused" | "uncertain"): Promise<T> {
  if (signal.aborted) throw sanitized(timeoutKind);
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { finish(); reject(sanitized(timeoutKind)); };
    timer = setTimeout(abort, timeoutMs); signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(call).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
  });
}

/** Calls only captured injected ports. The repository supplies no live implementation of either port. */
export async function runPrivateRecoveryOwnerActionV1(input: unknown, runtimeInput: unknown): Promise<PrivateRecoveryOwnerResultV1> {
  let request: PrivateRecoveryRequestV1, runtime: ReturnType<typeof capturedRuntime>;
  try { request = preparePrivateRecoveryOwnerRequestV1(input); runtime = capturedRuntime(runtimeInput, request); }
  catch { return refused(); }
  if (runtime.signal.aborted) return refused();
  const ctx = context(request, runtime);
  try {
    attached(await bounded(() => runtime.confirm(ctx), runtime.signal, runtime.controlDeadlineMs, "refused"), ctx);
  } catch (error) { throw sanitized(failureKind(error) ?? "refused"); }
  let exactProof: LocalBackupRestoreReadinessV1;
  try {
    exactProof = proof(await bounded(() => runtime.run(ctx), runtime.signal, runtime.controlDeadlineMs, "uncertain"), request);
  } catch { return uncertain(); }
  const terminalConfirmation = Object.freeze({ schema: PRIVATE_RECOVERY_TERMINAL_CONFIRMATION_V1,
    installationId: runtime.binding.installationId, requestDigest: request.requestDigest,
    backupRestoreProof: exactProof, terminalState: "confirmed" as const });
  return Object.freeze({ schema: PRIVATE_RECOVERY_OWNER_RUNNER_V1, installationId: runtime.binding.installationId,
    requestDigest: request.requestDigest, installationPlanDigest: request.installationPlanDigest,
    installationPlanRevision: request.installationPlanRevision, topologyPlanDigest: request.topologyPlanDigest,
    releaseDigest: request.releaseDigest, protectedDataBindingDigest: request.protectedDataBindingDigest,
    databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest,
    backupRestoreProofDigest: exactProof.proofDigest, disposition: "terminal_confirmation" as const,
    terminalConfirmation, performsEffect: false as const, runsBackup: false as const, runsRestore: false as const,
    promotesRestore: false as const });
}
