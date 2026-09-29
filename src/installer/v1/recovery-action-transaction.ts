import { verifyLocalBackupRestoreReadinessV1,
  type LocalBackupRestoreReadinessV1 } from "../../harness/v1/local-backup-restore-readiness";
import { sha256Digest } from "../../security/canonical-digest";
import { advanceInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { PRIVATE_RECOVERY_TERMINAL_CONFIRMATION_V1, preparePrivateRecoveryOwnerRequestV1,
  type PrivateRecoveryRequestV1 } from "./private-recovery-owner-runner";

/** Durable journal settlement only; this module has no recovery effect port. */
export const RECOVERY_ACTION_TRANSACTION_V1 = "control-room.recovery-action-transaction/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;
export type RecoveryActionTerminalReceiptV1 = Readonly<{
  schema: typeof RECOVERY_ACTION_TRANSACTION_V1;
  installationId: string;
  receiptDigest: string;
  requestDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  protectedDataBindingDigest: string;
  databaseAuthorityOutcomeDigest: string;
  storageConfigurationDigest: string;
  storageNamespaceDigest: string;
  expectedDatabaseIdentityDigest: string;
  expectedDatabaseSchemaDigest: string;
  backupRestoreProofDigest: string;
  databaseDumpDigest: string;
  artifactInventoryDigest: string;
  artifactRestoreVerificationDigest: string;
  artifactEntryCount: number;
  stage: "recovery";
  restoredToDisposableTarget: true;
  promoted: false;
  performsEffect: false;
  runsBackup: false;
  runsRestore: false;
  opensFilesystem: false;
  opensDatabase: false;
  opensCredentialStore: false;
}>;
export type RecoveryActionTransactionResultV1 = Readonly<{
  receipt: RecoveryActionTerminalReceiptV1;
  replayed: boolean;
  createsReceiptStore: false;
  performsEffect: false;
  runsBackup: false;
  runsRestore: false;
}>;

const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const refuse = (): never => { throw new Error("recovery_action_transaction_refused"); };
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
function stage(plan: InstallationPlanV1, name: "database_authority" | "protected_data" | "recovery") {
  const value = plan.stages.find(item => item.stage === name);
  if (!value) return refuse();
  return value;
}
function proofFor(value: unknown, request: PrivateRecoveryRequestV1): LocalBackupRestoreReadinessV1 {
  let proof: LocalBackupRestoreReadinessV1;
  try { proof = verifyLocalBackupRestoreReadinessV1(value); } catch { return refuse(); }
  if (proof.planDigest !== request.topologyPlanDigest || proof.releaseDigest !== request.releaseDigest
    || proof.storageNamespaceDigest !== request.storageNamespaceDigest
    || proof.databaseIdentityDigest !== request.expectedDatabaseIdentityDigest
    || proof.databaseSchemaDigest !== request.expectedDatabaseSchemaDigest || proof.restoredToDisposableTarget !== true
    || proof.promoted !== false || proof.startsWork !== false || proof.grantsExecutionAuthority !== false
    || proof.permitsRetry !== false || proof.permitsCleanup !== false) return refuse();
  return proof;
}
function terminal(value: unknown, installationId: string, request: PrivateRecoveryRequestV1) {
  const confirmation = exact(value, ["schema", "installationId", "requestDigest", "backupRestoreProof", "terminalState"]);
  if (confirmation.schema !== PRIVATE_RECOVERY_TERMINAL_CONFIRMATION_V1 || confirmation.installationId !== installationId
    || confirmation.requestDigest !== request.requestDigest || confirmation.terminalState !== "confirmed") return refuse();
  return proofFor(confirmation.backupRestoreProof, request);
}
function receiptFor(installationId: string, request: PrivateRecoveryRequestV1,
  proof: LocalBackupRestoreReadinessV1): RecoveryActionTerminalReceiptV1 {
  const body = { schema: RECOVERY_ACTION_TRANSACTION_V1, installationId, requestDigest: request.requestDigest,
    installationPlanDigest: request.installationPlanDigest, installationPlanRevision: request.installationPlanRevision,
    topologyPlanDigest: request.topologyPlanDigest, releaseDigest: request.releaseDigest,
    protectedDataBindingDigest: request.protectedDataBindingDigest,
    databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest,
    storageConfigurationDigest: request.storageConfigurationDigest, storageNamespaceDigest: request.storageNamespaceDigest,
    expectedDatabaseIdentityDigest: request.expectedDatabaseIdentityDigest,
    expectedDatabaseSchemaDigest: request.expectedDatabaseSchemaDigest, backupRestoreProofDigest: proof.proofDigest,
    databaseDumpDigest: proof.databaseDumpDigest, artifactInventoryDigest: proof.artifactInventoryDigest,
    artifactRestoreVerificationDigest: proof.artifactRestoreVerificationDigest, artifactEntryCount: proof.artifactEntryCount,
    stage: "recovery" as const, restoredToDisposableTarget: true as const, promoted: false as const,
    performsEffect: false as const, runsBackup: false as const, runsRestore: false as const,
    opensFilesystem: false as const, opensDatabase: false as const, opensCredentialStore: false as const };
  return Object.freeze({ ...body,
    receiptDigest: sha256Digest({ purpose: "recovery-action-terminal-receipt/v1", receipt: body }) });
}
function expectedPlan(history: readonly InstallationPlanV1[], receipt: RecoveryActionTerminalReceiptV1) {
  const plan = history[receipt.installationPlanRevision];
  if (!plan || plan.planDigest !== receipt.installationPlanDigest || plan.topologyPlanDigest !== receipt.topologyPlanDigest
    || plan.releaseDigest !== receipt.releaseDigest || stage(plan, "recovery").state !== "running"
    || stage(plan, "database_authority").state !== "passed"
    || stage(plan, "database_authority").outcomeDigest !== receipt.databaseAuthorityOutcomeDigest
    || stage(plan, "protected_data").state !== "passed"
    || stage(plan, "protected_data").outcomeDigest !== receipt.protectedDataBindingDigest) return refuse();
  return plan;
}
function recovered(history: readonly InstallationPlanV1[], receipt: RecoveryActionTerminalReceiptV1): boolean {
  const settled = history[receipt.installationPlanRevision + 1];
  if (!settled) return false;
  const recovery = stage(settled, "recovery"), current = history.at(-1);
  if (!current || settled.revision !== receipt.installationPlanRevision + 1 || recovery.state !== "passed"
    || recovery.recordedRevision !== settled.revision || recovery.outcomeDigest !== receipt.backupRestoreProofDigest
    || stage(current, "recovery").state !== "passed"
    || stage(current, "recovery").outcomeDigest !== receipt.backupRestoreProofDigest) return refuse();
  return true;
}
function captureJournal(value: unknown): Journal {
  if (!value || typeof value !== "object") return refuse();
  const owner = value as Journal;
  if (typeof owner.append !== "function" || typeof owner.readHistory !== "function") return refuse();
  return Object.freeze({ append: owner.append.bind(value), readHistory: owner.readHistory.bind(value) });
}
async function assertJournalIdentity(journal: Journal, installationId: string, plan: InstallationPlanV1) {
  let result;
  try { result = await journal.append(plan); } catch { return refuse(); }
  if (result.installationId !== installationId || result.revision !== plan.revision || result.planDigest !== plan.planDigest) return refuse();
  return result;
}
function result(receipt: RecoveryActionTerminalReceiptV1, replayed: boolean): RecoveryActionTransactionResultV1 {
  return Object.freeze({ receipt, replayed, createsReceiptStore: false as const, performsEffect: false as const,
    runsBackup: false as const, runsRestore: false as const });
}

/** Appends only the private runner's exact verified terminal proof to the existing plan journal. */
export async function confirmRecoveryActionTerminalV1(input: unknown,
  runtime: Readonly<{ journal: Journal }>): Promise<RecoveryActionTransactionResultV1> {
  const envelope = exact(input, ["installationId", "actionPreparation", "actionInput", "terminalConfirmation"]);
  if (typeof envelope.installationId !== "string" || !installationIdPattern.test(envelope.installationId)) return refuse();
  const journal = captureJournal(runtime?.journal), request = preparePrivateRecoveryOwnerRequestV1({
    actionPreparation: envelope.actionPreparation, actionInput: envelope.actionInput });
  const proof = terminal(envelope.terminalConfirmation, envelope.installationId, request);
  const receipt = receiptFor(envelope.installationId, request, proof);
  try {
    let history = await journal.readHistory();
    const original = expectedPlan(history, receipt);
    await assertJournalIdentity(journal, envelope.installationId, original);
    history = await journal.readHistory();
    expectedPlan(history, receipt);
    if (recovered(history, receipt)) return result(receipt, true);
    if (history.length !== receipt.installationPlanRevision + 1) return refuse();
    const next = advanceInstallationPlanV1(history.at(-1), { expectedRevision: receipt.installationPlanRevision,
      stage: "recovery", action: "pass", outcomeDigest: receipt.backupRestoreProofDigest });
    const appended = await assertJournalIdentity(journal, envelope.installationId, next);
    history = await journal.readHistory();
    if (!recovered(history, receipt)) return refuse();
    return result(receipt, appended.replayed);
  } catch {
    try {
      let history = await journal.readHistory();
      const original = expectedPlan(history, receipt);
      await assertJournalIdentity(journal, envelope.installationId, original);
      history = await journal.readHistory();
      if (recovered(history, receipt)) return result(receipt, true);
    } catch { /* Changed, stale, foreign, competing, or uncertain evidence remains owner attention. */ }
    return refuse();
  }
}
