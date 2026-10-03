import { readFile, readdir } from "node:fs/promises";
import { createRepositorySimulationDatabaseV1, type DatabaseClient,
  type RepositorySimulationDatabaseV1 } from "../../persistence/database";
import { LinearPipelineServiceV1, type LinearPipelineTemplateInputV1 } from "../../pipelines/v1";
import { SecurityStore, sha256Digest, type AuthenticatedPrincipal } from "../../security";
import { startSupervisorLoopV1 } from "../../supervisor/v1/loop";
import { supervisorRunModeDecisionV1, type SupervisorRunModePortV1,
  type SupervisorRunModeV1 } from "../../supervisor/v1/operations-mode";
import { WebProjectService } from "../../web/v1/project-service";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebTaskService } from "../../web/v1/task-service";
import { captureTaskModelCatalogV1 } from "../../web/v1/task-model-selection";
import { WorkBatchOwnerServiceV1, WorkBatchStoreV1, captureWorkBatchQueueCatalogV1,
  createWorkBatchQueueSelectionAuthorityV1, workBatchProposalDigestV1,
  type WorkBatchProposalV1, type WorkBatchQueueCatalogV1 } from "../../work-intake/v1";

export const NIGHT_KIT_LOOP_LIMIT_V1 = 2 as const;
export const NIGHT_KIT_S7B_CAPS_V1 = Object.freeze({ maxTotalTasks: 3, maxConcurrentTasks: 1,
  maxTotalCostMicroUsd: 0, maxDurationSeconds: 900 });

export type NightKitModeV1 = "practice" | "shadow";
export type NightKitStageV1 = "build" | "check" | "signoff";
export type NightKitEffectKindV1 = "commit" | "push" | "pull_request_draft";
export type NightKitRecordedEffectV1 = Readonly<{ kind: NightKitEffectKindV1; disposition: "would_have_done";
  runId: string; detail: string }>;

export interface NightKitRecordingEffectPortV1 {
  record(input: NightKitRecordedEffectV1): void | Promise<void>;
  entries(): readonly NightKitRecordedEffectV1[];
}

export function createRecordingNightEffectPortV1(
  afterRecord?: (entry: NightKitRecordedEffectV1) => void | Promise<void>,
): NightKitRecordingEffectPortV1 {
  const recorded: NightKitRecordedEffectV1[] = [];
  return Object.freeze({
    async record(input: NightKitRecordedEffectV1) {
      const entry = Object.freeze({ ...input }); recorded.push(entry); await afterRecord?.(entry);
    },
    entries: () => Object.freeze(recorded.map(entry => Object.freeze({ ...entry }))),
  });
}

export type NightKitWorkerResultV1 = Readonly<{ state: "passed" | "retry" | "failed";
  summary: string; change?: Readonly<{ path: string; content: string }> }>;
export interface NightKitWorkerPortV1 {
  run(input: NightKitWorkerInputV1): Promise<NightKitWorkerResultV1>;
}
export type NightKitWorkerInputV1 = Readonly<{ mode: NightKitModeV1; runId: string; stage: NightKitStageV1;
  workerId: string; model: string; attempt: number }>;

export const deterministicPracticeWorkerV1: NightKitWorkerPortV1 = Object.freeze({
  async run(input: NightKitWorkerInputV1) {
    if (input.stage === "build") return Object.freeze({ state: "passed" as const,
      summary: "Prepared one deterministic in-memory text change.",
      change: Object.freeze({ path: "practice/night-kit.txt", content: "night-kit-practice-v1\n" }) });
    return Object.freeze({ state: "passed" as const,
      summary: input.stage === "check" ? "The deterministic change passed its check."
        : "The deterministic result is ready for a draft review step." });
  },
});

const recordingShadowWorkerV1: NightKitWorkerPortV1 = Object.freeze({
  async run(input: NightKitWorkerInputV1) {
    return Object.freeze({ state: "passed" as const,
      summary: `Recorded selection of ${input.workerId} for ${input.stage}; no worker process was started.` });
  },
});

const fixedNow = Date.parse("2026-09-29T06:00:00.000Z");
const scope = Object.freeze({ tenantId: "tenant:night-kit", workspaceId: "workspace:night-kit" });
const ownerIdentity: VerifiedWebIdentity = Object.freeze({ provider: "night-kit-local", subject: "owner",
  tokenDigest: sha256Digest("night-kit-owner-session"), issuedAt: new Date(fixedNow - 60_000).toISOString(),
  expiresAt: new Date(fixedNow + 3_600_000).toISOString(),
  verificationExpiresAt: new Date(fixedNow + 3_600_000).toISOString() });
const proposer: AuthenticatedPrincipal = Object.freeze({ tenantId: scope.tenantId, identityId: "identity:night-proposer",
  actorType: "agent", authenticatedAt: new Date(fixedNow - 60_000).toISOString(),
  expiresAt: new Date(fixedNow + 3_600_000).toISOString() });
const integrityKey = new Uint8Array(32).fill(29);

const practiceCatalog = captureWorkBatchQueueCatalogV1([{ workerId: "worker:night-practice", workerKind: "codex",
  nodeId: "node:night-practice", modelPolicy: { models: ["night-practice-model"], defaultModel: "night-practice-model",
    efforts: ["low"], defaultEffort: "low" } }]);
function selectedCatalog(mode: NightKitModeV1, supplied?: WorkBatchQueueCatalogV1): WorkBatchQueueCatalogV1 {
  if (supplied) return captureWorkBatchQueueCatalogV1(supplied);
  if (mode === "practice") return practiceCatalog;
  throw new Error("night_shadow_worker_catalog_required");
}

function stageSelections(catalog: WorkBatchQueueCatalogV1, mode: NightKitModeV1) {
  if (mode === "practice") return [catalog[0]!, catalog[0]!, catalog[0]!] as const;
  const byKind = new Map(catalog.map(worker => [worker.workerKind, worker]));
  const selected = [byKind.get("codex"), byKind.get("claude-code"), byKind.get("hermes")];
  if (selected.some(value => !value)) throw new Error("night_shadow_three_worker_selection_required");
  return selected as [NonNullable<typeof selected[number]>, NonNullable<typeof selected[number]>, NonNullable<typeof selected[number]>];
}

function modelKey(worker: WorkBatchQueueCatalogV1[number]): string {
  const policy = worker.modelPolicy;
  if (!policy) throw new Error("night_worker_model_policy_required");
  return "profiles" in policy ? policy.defaultProfile : policy.defaultModel;
}

async function migrate(database: RepositorySimulationDatabaseV1): Promise<number> {
  const files = (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort();
  for (const file of files) await database.exec(await readFile(`db/migrations/${file}`, "utf8"));
  return files.length;
}

async function seed(db: DatabaseClient): Promise<void> {
  const now = new Date(fixedNow).toISOString();
  await db.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [scope.tenantId, "Night Kit"]);
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$3)",
    [scope.workspaceId, scope.tenantId, "Night Kit"]);
  await new SecurityStore(db).bootstrapOwner({ tenantId: scope.tenantId, provider: ownerIdentity.provider,
    subject: ownerIdentity.subject, identityId: "identity:night-owner", grantId: "grant:night-owner",
    displayName: "Night Kit Owner", verifiedAt: ownerIdentity.issuedAt, expiresAt: ownerIdentity.expiresAt, now });
  await db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent',$3,$4,$5,'active',$6,$6)`,
  [proposer.identityId, scope.tenantId, "Night Kit Proposer", "night-kit", sha256Digest("night-kit-proposer"), now]);
  await db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'work_batch_proposer','["work_batches.propose"]','["*"]','low',false,false,$4,$4)`,
  ["grant:night-proposer", scope.tenantId, proposer.identityId, now]);
}

function proposal(projectId: string, workers: ReturnType<typeof stageSelections>): WorkBatchProposalV1 {
  const definitions = [
    { localId: "build", title: "Build the deterministic night change", role: "builder" as const,
      requiredCapability: "code.change", acceptanceCriteria: "One bounded deterministic change is produced.",
      acceptanceTests: "Confirm the deterministic content and path." },
    { localId: "check", title: "Check the deterministic night change", role: "checker" as const,
      requiredCapability: "code.review", acceptanceCriteria: "The bounded change passes its declared check.",
      acceptanceTests: "Run the focused night-kit check." },
    { localId: "signoff", title: "Prepare the draft review handoff", role: "validator" as const,
      requiredCapability: "code.review", acceptanceCriteria: "A draft-only review handoff is recorded.",
      acceptanceTests: "Confirm no commit, push, or pull request occurred." },
  ];
  return { schema: "control-room.work-batch-proposal/v1", projectId,
    tasks: definitions.map((definition, index) => ({ ...definition,
      instructions: `${definition.title}. Do not perform repository or network effects.`,
      requestedWorkerId: workers[index]!.workerId, requestedWorkerKind: workers[index]!.workerKind,
      requestedModelKey: modelKey(workers[index]!) })),
    edges: [{ fromLocalId: "build", toLocalId: "check" }, { fromLocalId: "check", toLocalId: "signoff" }] };
}

function template(workers: ReturnType<typeof stageSelections>): LinearPipelineTemplateInputV1 {
  const common = (index: number) => { const worker = workers[index]!; const policy = worker.modelPolicy!;
    const key = modelKey(worker); const profile = "profiles" in policy ? policy.profiles.find(item => item.name === key)! : undefined;
    return { ordinal: index, description: `Night kit ${["build", "check", "signoff"][index]} stage.`,
      requiredCapability: index === 0 ? "code.change" : "code.review", workerId: worker.workerId,
      workerKind: worker.workerKind, nodeId: worker.nodeId, selectionKey: key,
      model: profile?.model ?? key, effort: policy.defaultEffort,
      provider: profile?.provider ?? null, profile: profile?.name ?? null, maxLoops: NIGHT_KIT_LOOP_LIMIT_V1 }; };
  return { name: "First test night", description: "Bounded practice and shadow pipeline.",
    stages: [
      { ...common(0), stageKind: "build", role: "builder", allowedPaths: ["practice/**"],
        maximumChangedFiles: 1, maximumChangedBytes: 1024 },
      { ...common(1), stageKind: "check", role: "checker" },
      { ...common(2), stageKind: "signoff", role: "validator" },
    ] as LinearPipelineTemplateInputV1["stages"], maxTotalLoops: NIGHT_KIT_LOOP_LIMIT_V1,
    maxDurationSeconds: NIGHT_KIT_S7B_CAPS_V1.maxDurationSeconds };
}

export type NightKitStatusV1 = "completed" | "paused" | "drained" | "stopped" | "capped" | "failed";
export type NightKitSummaryV1 = Readonly<{ mode: NightKitModeV1; status: NightKitStatusV1; batchId: string;
  pipelineRunId: string; selectedWorkers: readonly string[]; completedStages: readonly NightKitStageV1[];
  effects: readonly NightKitRecordedEffectV1[]; databaseKind: "throwaway_local"; databaseClosed: boolean;
  migrationsApplied: number; loopLimit: typeof NIGHT_KIT_LOOP_LIMIT_V1; caps: typeof NIGHT_KIT_S7B_CAPS_V1;
  message: string }>;

export interface NightKitDependenciesV1 {
  operations?: SupervisorRunModePortV1;
  worker?: NightKitWorkerPortV1;
  effects?: NightKitRecordingEffectPortV1;
  workerCatalog?: WorkBatchQueueCatalogV1;
  readyWorkerIds?: readonly string[];
  createDatabase?: () => Promise<RepositorySimulationDatabaseV1>;
}

const runningOperations: SupervisorRunModePortV1 = Object.freeze({ read: () => "running" as const });

async function boundary(operations: SupervisorRunModePortV1): Promise<Exclude<NightKitStatusV1, "completed" | "capped" | "failed"> | undefined> {
  const decision = supervisorRunModeDecisionV1(await operations.read());
  return decision === "start" ? undefined : decision === "pause" ? "paused" : decision === "drain" ? "drained" : "stopped";
}

export async function runNightKitV1(mode: NightKitModeV1,
  dependencies: NightKitDependenciesV1 = {}): Promise<NightKitSummaryV1> {
  if (mode !== "practice" && mode !== "shadow") throw new Error("night_mode_invalid");
  const operations = dependencies.operations ?? runningOperations;
  const effects = dependencies.effects ?? createRecordingNightEffectPortV1();
  const worker = dependencies.worker ?? (mode === "practice" ? deterministicPracticeWorkerV1 : recordingShadowWorkerV1);
  const catalog = selectedCatalog(mode, dependencies.workerCatalog), workers = stageSelections(catalog, mode);
  const readyWorkerIds = new Set(dependencies.readyWorkerIds ?? workers.map(item => item.workerId));
  const selection = createWorkBatchQueueSelectionAuthorityV1(catalog, { isReady: workerId => readyWorkerIds.has(workerId) });
  const database = await (dependencies.createDatabase ?? (() => createRepositorySimulationDatabaseV1({ testOnly: true })))();
  let databaseClosed = false, migrationsApplied = 0, batchId = "batch:unavailable", pipelineRunId = "pipeline-run:unavailable";
  const completedStages: NightKitStageV1[] = [];
  let status: NightKitStatusV1 = "failed";
  try {
    migrationsApplied = await migrate(database); await seed(database.client);
    const projects = new WebProjectService(database.client, scope, () => fixedNow, integrityKey);
    const { project } = await projects.create(ownerIdentity, { title: "First test night", summary: "Throwaway local night rehearsal." },
      "night-kit-project-0001");
    const batchProposal = proposal(project.projectId, workers);
    const created = await new WorkBatchStoreV1(database.client, integrityKey).create({ principal: proposer,
      proposal: batchProposal, proposalDigest: workBatchProposalDigestV1(batchProposal),
      idempotencyKey: "night-kit-proposal-0001", now: new Date(fixedNow).toISOString(),
      queueDepthLimit: NIGHT_KIT_S7B_CAPS_V1.maxTotalTasks });
    batchId = created.batchId;
    const tasks = new WebTaskService(database.client, scope, () => fixedNow, { modelCatalog:
      captureTaskModelCatalogV1(catalog.map(item => ({ kind: item.workerKind, policy: item.modelPolicy }))) });
    const queueAuthority = { assertCurrent: selection.assertCurrent,
      isAcceptedResultCurrent: () => false };
    const owner = new WorkBatchOwnerServiceV1(database.client, tasks, scope, integrityKey,
      () => fixedNow, catalog, queueAuthority);
    await owner.command(ownerIdentity, project.projectId, { operation: "decide", batchId,
      expectedRevision: 1, items: batchProposal.tasks.map(item => ({ localId: item.localId, decision: "approve" as const })) },
    "night-kit-approve-0001");
    const pipelines = new LinearPipelineServiceV1(database.client, scope, integrityKey,
      { assertCurrent: selection.assertCurrent, isAcceptedResultCurrent: () => false }, () => fixedNow);
    const saved = await pipelines.createTemplate(ownerIdentity, project.projectId, template(workers));
    const run = await pipelines.instantiate(ownerIdentity, project.projectId,
      { templateId: saved.templateId, title: "First test night" }, "night-kit-pipeline-0001");
    pipelineRunId = run.runId;
    let runStatus: NightKitStatusV1 = "completed";
    const stageNames = ["build", "check", "signoff"] as const;
    const service = { async cycle() {
      for (const [index, stage] of stageNames.entries()) {
        const halted = await boundary(operations); if (halted) { runStatus = halted; return; }
        let passed = false;
        for (let attempt = 1; attempt <= NIGHT_KIT_LOOP_LIMIT_V1; attempt += 1) {
          const result = await worker.run({ mode, runId: pipelineRunId, stage, workerId: workers[index]!.workerId,
            model: modelKey(workers[index]!), attempt });
          if (result.state === "passed") { passed = true; break; }
          if (result.state === "failed") { runStatus = "failed"; return; }
        }
        if (!passed) { runStatus = "capped"; return; }
        completedStages.push(stage);
      }
      for (const [kind, detail] of [["commit", "record the bounded change as a local commit"],
        ["push", "push the local night branch"], ["pull_request_draft", "open a draft pull request"]] as const) {
        const halted = await boundary(operations); if (halted) { runStatus = halted; return; }
        await effects.record({ kind, disposition: "would_have_done", runId: pipelineRunId, detail });
      }
    } };
    const handle = await startSupervisorLoopV1({ service, intervalMs: 300_000 });
    await handle.close(); status = runStatus;
  } finally {
    await database.close(); databaseClosed = true;
  }
  const message = status === "completed"
    ? `${mode === "practice" ? "Practice" : "Shadow"} night completed in a throwaway database; no commit, push, or pull request was performed.`
    : `${mode === "practice" ? "Practice" : "Shadow"} night ${status}; no commit, push, or pull request was performed.`;
  return Object.freeze({ mode, status, batchId, pipelineRunId,
    selectedWorkers: Object.freeze(workers.map(item => item.workerId)), completedStages: Object.freeze([...completedStages]),
    effects: effects.entries(), databaseKind: "throwaway_local", databaseClosed, migrationsApplied,
    loopLimit: NIGHT_KIT_LOOP_LIMIT_V1, caps: NIGHT_KIT_S7B_CAPS_V1, message });
}

export function mutableNightOperationsModeV1(initial: SupervisorRunModeV1 = "running") {
  let mode = initial;
  return Object.freeze({ read: () => mode, set(value: SupervisorRunModeV1) { mode = value; } });
}
