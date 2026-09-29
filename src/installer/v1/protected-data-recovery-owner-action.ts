import { verifyInstallationActionPreparationV1 } from "./installation-action-preparation";

/**
 * A source-only hand-off for the owner-attended I4 action.
 *
 * The existing private storage adapter, database backup/restore tools,
 * artifact-inventory verifier and operator-installed Restic adapter retain
 * their own formats and effect boundaries. This adapter owns no path,
 * credential, Restic configuration, database port, artifact store, journal,
 * proof, or installation-plan transition.
 */
export const PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1 =
  "control-room.protected-data-recovery-owner-action/v1" as const;

type Action = "protected_data" | "recovery";
type Operation = "owner_create_private_data_root" | "verify_owner_private_data_root"
  | "bind_verified_protected_storage" | "owner_run_existing_backup_restore_rehearsal"
  | "record_verified_backup_restore_evidence";
type Precondition = "owner_attendance_and_unowned_target" | "existing_candidate_and_owner_attendance"
  | "verified_private_root_only" | "owner_attendance_and_disposable_restore_target"
  | "verified_disposable_restore_only";

type ExistingTool = Readonly<{
  kind: "existing_private_storage_and_recovery_tools";
  entrypoints: readonly string[];
}>;

export type ProtectedDataRecoveryOwnerActionRequestV1 = Readonly<{
  schema: typeof PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1;
  action: Action;
  stage: "protected_data" | "recovery";
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  preparationDigest: string;
  protectedDataBindingDigest: string;
  storageConfigurationDigest: string;
  storageNamespaceDigest: string;
  operation: Operation;
  precondition: Precondition;
  tool: ExistingTool;
  /** Configuration is resolved privately by the later owner wrapper. */
  requiresOwnerPrivateConfiguration: true;
  performsEffect: false;
  opensStorage: false;
  runsBackup: false;
  runsRestore: false;
  promotesRestore: false;
  startsService: false;
  grantsExecutionAuthority: false;
}>;

const refuse = (): never => { throw new Error("protected_data_recovery_owner_action_refused"); };

function digest(value: unknown): string {
  if (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)) return value;
  return refuse();
}

function operation(value: unknown): Operation {
  if (value === "owner_create_private_data_root" || value === "verify_owner_private_data_root"
    || value === "bind_verified_protected_storage" || value === "owner_run_existing_backup_restore_rehearsal"
    || value === "record_verified_backup_restore_evidence") return value;
  return refuse();
}

function precondition(value: unknown): Precondition {
  if (value === "owner_attendance_and_unowned_target" || value === "existing_candidate_and_owner_attendance"
    || value === "verified_private_root_only" || value === "owner_attendance_and_disposable_restore_target"
    || value === "verified_disposable_restore_only") return value;
  return refuse();
}

function validPair(selected: Operation, selectedPrecondition: Precondition, action: Action) {
  const expected = selected === "owner_create_private_data_root" ? "owner_attendance_and_unowned_target"
    : selected === "verify_owner_private_data_root" ? "existing_candidate_and_owner_attendance"
      : selected === "bind_verified_protected_storage" ? "verified_private_root_only"
        : selected === "owner_run_existing_backup_restore_rehearsal" ? "owner_attendance_and_disposable_restore_target"
          : "verified_disposable_restore_only";
  if (selectedPrecondition !== expected
    || (action === "protected_data") !== (selected !== "owner_run_existing_backup_restore_rehearsal"
      && selected !== "record_verified_backup_restore_evidence")) return refuse();
}

function toolsFor(action: Action): ExistingTool {
  const entrypoints = action === "protected_data"
    ? ["src/web/v1/private-artifact-storage.ts", "src/artifacts/v1/persistent-local-storage.ts"]
    : ["deploy/postgres/backup-database.mjs", "deploy/postgres/restore-database.mjs",
      "scripts/backup/restic-retained-snapshot.ts", "src/artifacts/v1/artifact-backup-inventory.ts",
      "src/harness/v1/local-backup-restore-readiness.ts"];
  return Object.freeze({ kind: "existing_private_storage_and_recovery_tools" as const, entrypoints: Object.freeze(entrypoints) });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value);
  if (names.some(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor?.enumerable !== true || !descriptor || !("value" in descriptor);
  })) return refuse();
  return value as Readonly<Record<string, unknown>>;
}

function build(input: unknown): ProtectedDataRecoveryOwnerActionRequestV1 {
  const envelope = record(input);
  if (Object.keys(envelope).length !== 2 || !("actionPreparation" in envelope) || !("actionInput" in envelope)) return refuse();
  const action = verifyInstallationActionPreparationV1(envelope.actionPreparation, envelope.actionInput);
  if ((action.action !== "protected_data" && action.action !== "recovery")
    || (action.stage !== "protected_data" && action.stage !== "recovery")) return refuse();
  const prepared = record(action.preparedAction);
  const selectedOperation = operation(prepared.nextOperation), selectedPrecondition = precondition(prepared.precondition);
  validPair(selectedOperation, selectedPrecondition, action.action);
  const request = { schema: PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1, action: action.action, stage: action.stage,
    installationPlanDigest: action.installationPlanDigest, installationPlanRevision: action.installationPlanRevision,
    topologyPlanDigest: action.topologyPlanDigest, releaseDigest: action.releaseDigest,
    preparationDigest: digest(prepared.preparationDigest), protectedDataBindingDigest: digest(prepared.protectedDataBindingDigest),
    storageConfigurationDigest: digest(prepared.storageConfigurationDigest), storageNamespaceDigest: digest(prepared.storageNamespaceDigest),
    operation: selectedOperation, precondition: selectedPrecondition, tool: toolsFor(action.action),
    requiresOwnerPrivateConfiguration: true as const, performsEffect: false as const, opensStorage: false as const,
    runsBackup: false as const, runsRestore: false as const, promotesRestore: false as const,
    startsService: false as const, grantsExecutionAuthority: false as const };
  return Object.freeze({ ...request, tool: Object.freeze({ ...request.tool, entrypoints: Object.freeze([...request.tool.entrypoints]) }) });
}

/**
 * Rechecks the current prepared action and returns only a redacted request.
 * The later runner's backup, restore, filesystem, database and credential
 * work, replay fencing, and evidence recording remain outside this pure
 * source-only adapter.
 */
export function prepareProtectedDataRecoveryOwnerActionV1(input: unknown): ProtectedDataRecoveryOwnerActionRequestV1 {
  try { return build(input); } catch { return refuse(); }
}
