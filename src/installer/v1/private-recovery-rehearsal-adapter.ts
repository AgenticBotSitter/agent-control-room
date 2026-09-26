import { z } from "zod";
import { computeDatabaseRestoreIdentity, verifyRestoredIdentity } from "../../../deploy/postgres/restore-identity.mjs";
import { artifactBackupInventorySchemaV1, verifyRestoredArtifactBackupInventoryV1 } from "../../artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1 } from "../../harness/v1/local-backup-restore-readiness";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";
import { capturePrivateRecoveryOwnerRuntimePortV1, type PrivateRecoveryOwnerRuntimeV1, type PrivateRecoveryRequestV1,
  type PrivateRecoveryRunnerContextV1 } from "./private-recovery-owner-runner";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identitySchema = z.object({
  ledgerDigest: digest, rolesDigest: digest, membershipsDigest: digest, schemaDigest: digest,
  rowsDigest: digest, ownersDigest: digest, ledgerRowsDigest: digest, databaseOwnerDigest: digest,
}).strict();
const targetSchema = z.object({ sourceTargetDigest: digest, disposableTargetDigest: digest,
  sourceReadOnly: z.literal(true), disposableTargetEmpty: z.literal(true),
  disposableTargetOwned: z.literal(true), protectedRestoreTargetEmpty: z.literal(true),
  // The retained restore tool may create roles. Cluster role state must be
  // isolated too; a different database name on the live cluster is insufficient.
  clusterRolesIsolated: z.literal(true), sourceQuiesced: z.literal(true),
}).strict();
const backupSchema = z.object({ sourceTargetDigest: digest, databaseDumpDigest: digest,
  databaseIdentity: identitySchema, artifactInventory: artifactBackupInventorySchemaV1,
  consistentDatabaseSnapshot: z.literal(true), protectedArtifactsHeld: z.literal(true),
}).strict();
const restoredSchema = z.object({ disposableTargetDigest: digest, databaseDumpDigest: digest,
  databaseIdentity: identitySchema, artifactInventory: artifactBackupInventorySchemaV1,
}).strict();
const loginSchema = z.object({ disposableTargetDigest: digest, applicationLoginSucceeded: z.literal(true),
  requiredReadsSucceeded: z.literal(true), forbiddenWritesRefused: z.literal(true),
  privilegeEscalationRefused: z.literal(true), schedulerBoundaryVerified: z.literal(true),
}).strict();

/** Private callable ports; never serialized into the installation or browser. */
export type PrivateRecoveryRehearsalSessionV1 = Readonly<{
  inspectDisposableTargets(signal: AbortSignal): Promise<unknown>;
  backupDatabaseAndProtectedArtifacts(signal: AbortSignal): Promise<unknown>;
  restoreExactBackup(input: Readonly<{ databaseDumpDigest: string; artifactInventoryDigest: string }>, signal: AbortSignal): Promise<unknown>;
  verifyRestrictedLogins(signal: AbortSignal): Promise<unknown>;
  /** Retire all subprocesses/connections, release holds, and account for the
   * disposable target. This must not delete the retained backup or source. */
  close(signal: AbortSignal): Promise<unknown>;
}>;
export type PrivateRecoveryRehearsalPortsV1 = Readonly<{
  // Opening only acquires private custody/read-only observations. It must not
  // create targets or run a dump/restore. It owns cleanup if acquisition fails.
  open(context: PrivateRecoveryRunnerContextV1): Promise<PrivateRecoveryRehearsalSessionV1>;
}>;
type Input = Readonly<{
  request: PrivateRecoveryRequestV1;
  runtime: Omit<PrivateRecoveryOwnerRuntimeV1, "runExistingBackupRestoreRehearsal">;
  ports: PrivateRecoveryRehearsalPortsV1;
  cleanupDeadlineMs: number;
}>;
const refuse = (): never => { throw new Error("private_recovery_rehearsal_refused"); };
const uncertain = (): never => { throw new Error("private_recovery_rehearsal_uncertain"); };

function data<T extends z.ZodRawShape>(schema: z.ZodObject<T>, value: unknown): z.infer<z.ZodObject<T>> {
  const snapshot = exactHostDataSnapshotV1(value, Object.keys(schema.shape));
  if (!snapshot) return refuse();
  return schema.parse(snapshot);
}
function captureSession(value: PrivateRecoveryRehearsalSessionV1): PrivateRecoveryRehearsalSessionV1 {
  const names = ["inspectDisposableTargets", "backupDatabaseAndProtectedArtifacts", "restoreExactBackup",
    "verifyRestrictedLogins", "close"] as const;
  const record = exactHostDataSnapshotV1(value, names);
  if (!record || names.some(name => typeof record[name] !== "function" || isHostProxyV1(record[name]))) return refuse();
  return Object.freeze(Object.fromEntries(names.map(name => [name,
    (record[name] as (...args: unknown[]) => unknown).bind(value)]))) as PrivateRecoveryRehearsalSessionV1;
}
async function bounded<T>(invoke: () => Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  if (signal.aborted) return uncertain();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort);
      reject(new Error("private_recovery_rehearsal_uncertain")); };
    const timer = setTimeout(abort, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(invoke).then(value => { clearTimeout(timer); signal.removeEventListener("abort", abort);
      resolve(value); }, () => abort());
  });
}

/**
 * Concrete sequencing/evidence adapter beneath the existing recovery runner.
 * It reuses PostgreSQL restore identity and artifact-inventory checks. Native
 * tool custody is injected; construction does not open files or databases.
 * A single instance accepts one attempt only, including uncertain attempts.
 */
export function createPrivateRecoveryRehearsalAdapterV1(input: Input): PrivateRecoveryOwnerRuntimeV1 {
  const root = exactHostDataSnapshotV1(input, ["request", "runtime", "ports", "cleanupDeadlineMs"]);
  const rawRuntime = exactHostDataSnapshotV1(root?.runtime, ["binding", "signal", "controlDeadlineMs", "confirmOwnerAttachedTerminal"]);
  const rawRequest = exactHostDataSnapshotV1(root?.request, ["installationPlanDigest", "installationPlanRevision",
    "topologyPlanDigest", "releaseDigest", "preparationDigest", "protectedDataBindingDigest", "storageConfigurationDigest",
    "storageNamespaceDigest", "databaseAuthorityOutcomeDigest", "expectedDatabaseIdentityDigest", "expectedDatabaseSchemaDigest",
    "ownerActionRequestDigest", "operation", "requestDigest"]);
  const ports = exactHostDataSnapshotV1(root?.ports, ["open"]);
  if (!root || !rawRuntime || !rawRequest || !ports || typeof ports.open !== "function" || isHostProxyV1(ports.open)) return refuse();
  const runtime = capturePrivateRecoveryOwnerRuntimePortV1({ ...rawRuntime, async runExistingBackupRestoreRehearsal() { return refuse(); } });
  const request = Object.freeze(rawRequest) as PrivateRecoveryRequestV1;
  for (const [key, value] of Object.entries(request)) {
    if (key !== "installationPlanRevision" && key !== "operation" && !digest.safeParse(value).success) return refuse();
  }
  if (!Number.isSafeInteger(request.installationPlanRevision) || request.installationPlanRevision < 0
    || request.operation !== "owner_run_existing_backup_restore_rehearsal") return refuse();
  for (const key of ["installationPlanDigest", "installationPlanRevision", "topologyPlanDigest", "releaseDigest",
    "protectedDataBindingDigest", "databaseAuthorityOutcomeDigest"] as const) {
    if (runtime.binding[key] !== request[key]) return refuse();
  }
  const open = (ports.open as PrivateRecoveryRehearsalPortsV1["open"]).bind(root.ports);
  const cleanupDeadlineMs = root.cleanupDeadlineMs as number;
  if (!Number.isSafeInteger(cleanupDeadlineMs) || cleanupDeadlineMs < 1 || cleanupDeadlineMs > 30_000
    || !Number.isSafeInteger(runtime.controlDeadlineMs) || runtime.controlDeadlineMs < 1
    || runtime.controlDeadlineMs > 300_000) return refuse();
  let attempted = false;
  return Object.freeze({ ...runtime,
    async runExistingBackupRestoreRehearsal(context: PrivateRecoveryRunnerContextV1) {
      if (attempted || context.signal.aborted || context.installationId !== runtime.binding.installationId) return refuse();
      for (const key of ["requestDigest", "installationPlanDigest", "installationPlanRevision", "topologyPlanDigest",
        "releaseDigest", "protectedDataBindingDigest", "databaseAuthorityOutcomeDigest"] as const) {
        if (context[key] !== request[key]) return refuse();
      }
      attempted = true;
      const lifetime = new AbortController();
      const abort = () => lifetime.abort();
      context.signal.addEventListener("abort", abort, { once: true });
      const end = performance.now() + runtime.controlDeadlineMs;
      const call = <T>(fn: () => Promise<T>) => {
        const remaining = end - performance.now();
        if (remaining <= 0) return uncertain();
        return bounded(fn, lifetime.signal, remaining);
      };
      let session: PrivateRecoveryRehearsalSessionV1 | undefined;
      let result: ReturnType<typeof createLocalBackupRestoreReadinessV1> | undefined;
      let started = false, failed = false;
      try {
        // Acquisition must be bounded by the port itself and cleans up if it
        // cannot hand back custody. Do not abandon an unresolved acquisition.
        session = captureSession(await open(Object.freeze({ ...context, signal: lifetime.signal })));
        if (context.signal.aborted || performance.now() >= end) return uncertain();
        const target = data(targetSchema, await call(() => session!.inspectDisposableTargets(lifetime.signal)));
        if (target.sourceTargetDigest === target.disposableTargetDigest) return refuse();
        started = true;
        const backup = data(backupSchema, await call(() => session!.backupDatabaseAndProtectedArtifacts(lifetime.signal)));
        const identity = computeDatabaseRestoreIdentity(backup.databaseIdentity);
        if (backup.sourceTargetDigest !== target.sourceTargetDigest
          || identity.identityDigest !== request.expectedDatabaseIdentityDigest
          || identity.schemaDigest !== request.expectedDatabaseSchemaDigest
          || backup.artifactInventory.releaseDigest !== request.releaseDigest
          || backup.artifactInventory.storageNamespaceDigest !== request.storageNamespaceDigest) return uncertain();
        // Reobserve destination custody immediately before the first restore.
        const current = data(targetSchema, await call(() => session!.inspectDisposableTargets(lifetime.signal)));
        if (JSON.stringify(current) !== JSON.stringify(target)) return uncertain();
        const restored = data(restoredSchema, await call(() => session!.restoreExactBackup(Object.freeze({
          databaseDumpDigest: backup.databaseDumpDigest, artifactInventoryDigest: backup.artifactInventory.inventoryDigest,
        }), lifetime.signal)));
        if (restored.disposableTargetDigest !== target.disposableTargetDigest
          || restored.databaseDumpDigest !== backup.databaseDumpDigest) return uncertain();
        verifyRestoredIdentity(identity, computeDatabaseRestoreIdentity(restored.databaseIdentity));
        const login = data(loginSchema, await call(() => session!.verifyRestrictedLogins(lifetime.signal)));
        if (login.disposableTargetDigest !== target.disposableTargetDigest) return uncertain();
        result = createLocalBackupRestoreReadinessV1({ planDigest: request.topologyPlanDigest,
          databaseRestore: { tenantId: backup.artifactInventory.tenantId, releaseId: backup.artifactInventory.releaseId,
            releaseDigest: request.releaseDigest, databaseIdentityDigest: identity.identityDigest,
            databaseDumpDigest: backup.databaseDumpDigest, databaseSchemaVersion: backup.artifactInventory.databaseSchemaVersion,
            databaseSchemaDigest: identity.schemaDigest, restoredToDisposableTarget: true, promoted: false,
            startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false },
          expectedArtifactInventory: backup.artifactInventory, restoredArtifactInventory: restored.artifactInventory,
          artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({
            expected: backup.artifactInventory, restored: restored.artifactInventory }),
        });
      } catch { failed = true; }
      finally {
        lifetime.abort();
        context.signal.removeEventListener("abort", abort);
        if (session) {
          try {
            const cleanup = data(z.object({ retired: z.literal(true), backupRetained: z.literal(true),
              sourceUnchanged: z.literal(true), disposableTargetAccountedFor: z.literal(true) }).strict(),
            await bounded(() => session!.close(new AbortController().signal), new AbortController().signal, cleanupDeadlineMs));
            if (!cleanup.retired) failed = true;
          } catch { failed = true; started = true; }
        }
      }
      if (failed || !result || context.signal.aborted || performance.now() >= end) return started ? uncertain() : refuse();
      return result;
    },
  });
}
