import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { PgBoss } from "pg-boss";
import { sha256Digest } from "../../security";
import { PersistentLocalArtifactStorageV1 } from "../../artifacts/v1/persistent-local-storage";
import { createDurableReservationPostgresPortV1 } from "../../artifacts/v1/neutral-reservation-postgres";
import { DurableResultReviewSubmissionServiceV1 } from "../../completion-gate/v1/durable-result-review-submission";
import { CompletionGateStoreV1 } from "../../completion-gate/v1/store";
import { preparePgBossNativeTaskSubmission } from "../../persistence/pg-boss-native-task-submission";
import { NativeApprovalPacketStore } from "./native-approval-packet-store";
import { TaskExecutionPlanner } from "./task-execution-planner";
import { createPrivatePostgresDatabase } from "./private-postgres";
import { createMacLocalCurrentThreeAgentTaskApplicationV1 } from "./mac-local-current-three-agent-task-composition";
import { MAC_LOCAL_TASK_PROVIDER_V1, MAC_LOCAL_THREE_AGENT_KINDS_V1,
  type MacLocalTaskProviderV1 } from "./mac-local-task-provider";
import { loadMacLocalTaskRuntimeFromRootV1 } from "./mac-local-task-runtime";
import { openMacLocalRollbackCheckpointStoreV1 } from "./mac-local-rollback-checkpoint-store";
import { buildMacLocalTaskTemplatesV1 } from "./mac-local-task-provider-templates";
import { createMacLocalTextScenarioV1 } from "./mac-local-owner-review-profile";
import { checkMacLocalNodeKeyPinV1 } from "./mac-local-node-key-pin";
import { refreshMacLocalFleetSignalsV1 } from "./mac-local-fleet-signals";
import { CodexOwnerTrustedLocalDispatchPreparationV1 } from "../../harness/codex-v1/owner-trusted-local-dispatch-preparation";
import { ClaudeCodeLocalDispatchPreparationV1 } from "../../harness/claude-code-v1/dispatch-preparation";
import { HermesLocalDispatchPreparationV1 } from "../../harness/hermes-local-v1/dispatch-preparation";
import { createOwnerTrustedLocalCliReceiptPortV1 } from "../../harness/v1/owner-trusted-local-cli-receipt-port";
import { createOwnerTrustedLocalCliAssertCurrentV1 } from "../../harness/v1/owner-trusted-local-cli-assert-current";
import { createOwnerTrustedLocalCliPublishV1 } from "../../harness/v1/owner-trusted-local-cli-publish";
import { createOwnerTrustedLocalCodexDeliveryV1, createOwnerTrustedLocalClaudeDeliveryV1,
  createOwnerTrustedLocalHermesDeliveryV1 } from "../../harness/v1/owner-trusted-local-cli-composition";
import { createOwnerTrustedLocalCodexExecV1 } from "../../harness/codex-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalClaudeExecV1 } from "../../harness/claude-code-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalHermesExecV1 } from "../../harness/hermes-local-v1/owner-trusted-local-exec";
import { codexOwnerTrustedLocalRunRegistrationV1 } from "../../harness/codex-v1/owner-trusted-local-run-registration";
import { ClaudeCodeLocalRunRegistrationV1 } from "../../harness/claude-code-v1/local-run-registration";
import { hermesLocalRunRegistrationV1 } from "../../harness/hermes-local-v1/local-run-registration";
import { createCodexOwnerTrustedLocalQueueExecutorV1 } from "./codex-owner-trusted-local-executor";
import { createClaudeOwnerTrustedLocalQueueExecutorV1 } from "./claude-owner-trusted-local-executor";
import { HERMES_LOCAL_ADAPTER_V1 } from "../../harness/hermes-local-v1/task-planning-contract";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../../harness/claude-code-v1/task-planning-contract";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../../harness/codex-v1/owner-trusted-local-task-planning-contract";

export const schema = MAC_LOCAL_TASK_PROVIDER_V1;
export const workerKinds = MAC_LOCAL_THREE_AGENT_KINDS_V1;

async function ensurePrivateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
    || entry.uid !== process.getuid?.()) throw new Error("mac_local_runtime_directory_unsafe");
}

/** The only provider exported into the protected host. All keys and executables
 * come from the owner's private files; the browser cannot supply them. */
export const createTaskApplication: MacLocalTaskProviderV1["createTaskApplication"] = async input => {
  const { configuration, protectedRoot, databaseRoles, workerReadiness } = input;
  const tenantId = configuration.localOwnerSession.tenantId;
  const workspaceId = configuration.workspaceId;
  const runtime = await loadMacLocalTaskRuntimeFromRootV1(protectedRoot);
  await checkMacLocalNodeKeyPinV1(input.database.client, protectedRoot, configuration);
  const rows = await input.database.client.query<{ project_id: string; created_at: string | Date }>(
    `SELECT p.id AS project_id,h.created_at FROM projects p
      JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
      WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND h.lifecycle='active'
      ORDER BY p.id LIMIT 6`, [tenantId, workspaceId]);
  if (rows.rows.length < 1 || rows.rows.length > 5) throw new Error("mac_local_project_limit");
  const projects = rows.rows.map(row => ({ projectId: row.project_id, createdAt: new Date(row.created_at).toISOString() }));
  const built = buildMacLocalTaskTemplatesV1(projects, configuration, runtime);
  // Validate each parent before creating descendants: lstat on a child alone
  // would follow a symlinked `runtime` directory and miss the unsafe path.
  await ensurePrivateDirectory(join(protectedRoot, "runtime"));
  const artifacts = join(protectedRoot, "runtime", "artifacts");
  await ensurePrivateDirectory(artifacts);
  const storage = await PersistentLocalArtifactStorageV1.create({ rootPath: artifacts,
    maximumArtifacts: 10_000, maximumFileBytes: 65_536, maximumTotalBytes: 655_360_000, operationTimeoutMs: 2_000 });
  const work = Object.freeze({ hermes: join(protectedRoot, "runtime", "work-hermes"),
    claude: join(protectedRoot, "runtime", "work-claude"), codex: join(protectedRoot, "runtime", "work-codex") });
  for (const path of Object.values(work)) await ensurePrivateDirectory(path);

  const readPool = createPrivatePostgresDatabase(databaseRoles.coordinator);
  let checkpoints: Awaited<ReturnType<typeof openMacLocalRollbackCheckpointStoreV1>> | undefined;
  let submission: Awaited<ReturnType<typeof preparePgBossNativeTaskSubmission>> | undefined;
  let application: Awaited<ReturnType<typeof createMacLocalCurrentThreeAgentTaskApplicationV1>> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight: Promise<void> | undefined;
  try {
    checkpoints = await openMacLocalRollbackCheckpointStoreV1(protectedRoot);
    const keys = runtime.keys;
    const reviewGate = new CompletionGateStoreV1(readPool.client, keys.review, checkpoints);
    // First-owner provisioning is an explicit one-time operator action. The
    // ordinary host must never initialize the review authority on startup.
    const existing = await readPool.client.query("SELECT revision FROM control_completion_gate_integrity WHERE tenant_id=$1", [tenantId]);
    if (existing.rows.length !== 1) throw new Error("mac_local_first_owner_setup_missing");
    for (const profile of built.profiles) await reviewGate.registerProfile(profile);
    const planning = { template: built.templates[0]!, additionalTemplates: built.templates.slice(1),
      integrityKey: keys.planning, reviewIntegrityKey: keys.review, checkpoints,
      localAdapterAdmission: { enabledAdapters: [HERMES_LOCAL_ADAPTER_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1,
        CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1] } } as const;
    const planner = new TaskExecutionPlanner(readPool.client, { tenantId, workspaceId }, planning);
    const workers = (["hermes", "claude", "codex"] as const).map(kind => {
      const worker = configuration.enablement.workers.find(value => value.kind === (kind === "claude" ? "claude-code" : kind));
      const route = built.routes.find(value => value.nodeId === `${configuration.enablement.nodeId}.${kind}`);
      if (!worker || !route) throw new Error("mac_local_worker_missing");
      return { kind: worker.kind, worker, route, adapterId: kind === "hermes" ? HERMES_LOCAL_ADAPTER_V1
        : kind === "claude" ? CLAUDE_CODE_LOCAL_ADAPTER_V1 : CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 };
    });
    const prepared = workers.map(value => {
      const adapterRevision = sha256Digest({ executablePath: value.worker.executablePath,
        recordedVersion: value.worker.recordedVersion }).slice("sha256:".length);
      const config = { workerId: value.worker.workerId, adapterRevision };
      return value.kind === "hermes" ? new HermesLocalDispatchPreparationV1(readPool.client, planner, config)
        : value.kind === "claude-code" ? new ClaudeCodeLocalDispatchPreparationV1(readPool.client, planner, config)
          : new CodexOwnerTrustedLocalDispatchPreparationV1(readPool.client, planner, config);
    });
    const reviewSubmission = new DurableResultReviewSubmissionServiceV1(readPool.client, {
      integrityKey: keys.results, reviewIntegrityKey: keys.review, checkpoints, storageClass: "local", storage });
    const publication = { db: readPool.client, integrityKey: keys.results, reviewKey: keys.review,
      storage, storageClass: "local" as const, reservations: createDurableReservationPostgresPortV1(), reviewSubmission };
    const common = (index: number, registerRun: Parameters<typeof createOwnerTrustedLocalCliPublishV1>[0]["registerRun"]) => {
      const selected = workers[index]!;
      return { db: readPool.client, integrityKey: keys.deliveryReceipt,
        binding: { workerId: selected.worker.workerId, adapterId: selected.adapterId,
          adapterRevision: sha256Digest({ executablePath: selected.worker.executablePath,
            recordedVersion: selected.worker.recordedVersion }).slice("sha256:".length) },
        receiptPort: createOwnerTrustedLocalCliReceiptPortV1(),
        assertCurrent: createOwnerTrustedLocalCliAssertCurrentV1(readPool.client, prepared[index]!, workerReadiness),
        publish: createOwnerTrustedLocalCliPublishV1({ db: readPool.client,
          runIntegrityKey: keys.harness, publication, registerRun }) };
    };
    const hermes = { tenantId,
      preparation: prepared[0] as HermesLocalDispatchPreparationV1,
      delivery: createOwnerTrustedLocalHermesDeliveryV1(common(0, (value, time) =>
        hermesLocalRunRegistrationV1(value, time, workers[0]!.worker.recordedVersion)),
      createOwnerTrustedLocalHermesExecV1(), { executablePath: workers[0]!.worker.executablePath,
        profile: runtime.hermes.profile, provider: runtime.hermes.provider, model: runtime.hermes.model,
        workingDirectory: work.hermes, deadlineMs: 120_000 }) };
    const claude = createClaudeOwnerTrustedLocalQueueExecutorV1({ tenantId,
      preparation: prepared[1] as ClaudeCodeLocalDispatchPreparationV1,
      delivery: createOwnerTrustedLocalClaudeDeliveryV1(common(1, ClaudeCodeLocalRunRegistrationV1),
        createOwnerTrustedLocalClaudeExecV1(), { executablePath: workers[1]!.worker.executablePath,
          workingDirectory: work.claude, deadlineMs: 120_000 }) });
    const codex = createCodexOwnerTrustedLocalQueueExecutorV1({ tenantId,
      preparation: prepared[2] as CodexOwnerTrustedLocalDispatchPreparationV1,
      delivery: createOwnerTrustedLocalCodexDeliveryV1(common(2, (value, time) =>
        codexOwnerTrustedLocalRunRegistrationV1(value, time, workers[2]!.worker.recordedVersion)),
      createOwnerTrustedLocalCodexExecV1(), { executablePath: workers[2]!.worker.executablePath,
        workingDirectory: work.codex, deadlineMs: 120_000 }) });
    submission = await preparePgBossNativeTaskSubmission(PgBoss, readPool.client, { backend: "postgres", recovery: true });
    await refreshMacLocalFleetSignalsV1({ db: readPool.client, tenantId, protectedRoot,
      readiness: workerReadiness, workers: workers.map(value => ({ kind: value.kind, workerId: value.worker.workerId,
        nodeId: value.route.nodeId, capabilityProbeId: value.route.capabilityProbeId })) });
    application = await createMacLocalCurrentThreeAgentTaskApplicationV1({
      web: { tenantId, workspaceId, database: input.database,
        tasks: { harnessIntegrityKey: keys.harness,
          results: { integrityKey: keys.results, storageClass: "local", storage },
          reviews: { integrityKey: keys.review, checkpoints },
          ownerReviews: { integrityKey: keys.review, checkpoints } } },
      databaseRoles, openDatabase: createPrivatePostgresDatabase,
      coordinator: { scope: { tenantId, workspaceId }, planning, routes: built.routes,
        approvals: { enrollments: [], store: new NativeApprovalPacketStore(keys.approvals, []) },
        nativeSubmission: submission, revisionPlanning: true,
        quality: { integrityKey: keys.review, harnessIntegrityKey: keys.harness, checkpoints,
          results: { integrityKey: keys.results, storageClass: "local", storage },
          scenarios: built.profiles.map(createMacLocalTextScenarioV1) } },
      hermes, claude, codex,
    });
    const refreshInput = { db: readPool.client, tenantId, protectedRoot, readiness: workerReadiness,
      workers: workers.map(value => ({ kind: value.kind, workerId: value.worker.workerId,
        nodeId: value.route.nodeId, capabilityProbeId: value.route.capabilityProbeId })) };
    refreshTimer = setInterval(() => {
      if (refreshInFlight) return;
      refreshInFlight = refreshMacLocalFleetSignalsV1(refreshInput).catch(() => {
        // Stale signals refuse new assignment; never turn a failed refresh into a healthy claim.
      }).finally(() => { refreshInFlight = undefined; });
    }, 30_000);
    refreshTimer.unref();
    const owned = application;
    return Object.freeze({ ...owned, async close() {
      if (refreshTimer) clearInterval(refreshTimer);
      await refreshInFlight?.catch(() => {});
      const results = await Promise.allSettled([owned.close(), readPool.close(), checkpoints.close()]);
      if (results.some(result => result.status === "rejected")) throw new Error("mac_local_task_provider_cleanup_uncertain");
    } });
  } catch (error) {
    if (refreshTimer) clearInterval(refreshTimer);
    await refreshInFlight?.catch(() => {});
    const results = await Promise.allSettled([application?.close(), !application && submission?.close(),
      readPool.close(), checkpoints?.close()].filter((value): value is Promise<unknown> => !!value));
    if (results.some(result => result.status === "rejected")) throw new Error("mac_local_task_provider_cleanup_uncertain");
    throw error;
  }
};
