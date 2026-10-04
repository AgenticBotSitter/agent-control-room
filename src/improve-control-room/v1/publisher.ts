import type { DatabaseClient } from "../../persistence/database";
import { assertNoSecretMaterial, canonicalJson, sha256Digest } from "../../security";
import { recordUpdateCandidateSchemaV1 } from "./schemas";
import type { ImproveControlRoomDeskServiceV1 } from "./service";

export type UpdateCandidateProfileIdV1 = "fast" | "db" | "full" | "targeted";
export type UpdateCandidateRunnerKindV1 = "candidate_worktree" | "local_test_runner";
export type UpdateCandidateRiskKindV1 = "security" | "database" | "authority" | "dependency";

export type UpdateCandidateProfileConfigurationV1 = Readonly<{
  id: UpdateCandidateProfileIdV1;
  version: number;
  commandIds: readonly string[];
  runner: Readonly<{ kind: UpdateCandidateRunnerKindV1; serviceId: string }>;
  workerId: string;
}>;

export type UpdateCandidatePathRuleV1 = Readonly<{
  prefix: string;
  area: string;
  profiles?: readonly Exclude<UpdateCandidateProfileIdV1, "fast" | "targeted">[];
  risk?: UpdateCandidateRiskKindV1;
}>;

export type IntegrationRepositorySnapshotV1 = Readonly<{
  baseRevision: string;
  candidateRevision: string;
  changedPaths: readonly string[];
  addedPaths: readonly string[];
  commitSubjects: readonly string[];
}>;

export interface IntegrationRepositoryObserverV1 {
  observe(input: Readonly<{ pipelineRunId: string }>): Promise<IntegrationRepositorySnapshotV1>;
}

export type UpdateCandidateRunnerResultV1 = Readonly<{
  status: "passed" | "failed" | "not_run" | "blocked" | "unavailable";
  summary: string;
  evidenceDigest: string | null;
  testCount: number | null;
  durationMs: number;
  observedAt: string;
}>;

/** Stub boundary for the candidate-worktree/local test-runner service. */
export interface UpdateCandidateTestRunnerV1 {
  run(input: Readonly<{ pipelineRunId: string; candidateRevision: string; changedPaths: readonly string[];
    profile: UpdateCandidateProfileConfigurationV1; profileDigest: string }>): Promise<UpdateCandidateRunnerResultV1>;
}

export type UpdateCandidateIndependentReviewV1 = Readonly<{
  reviewId: string;
  reviewDigest: string;
  reviewerWorkerId: string;
}>;

export interface UpdateCandidateReviewSourceV1 {
  acceptedForRun(pipelineRunId: string): Promise<readonly UpdateCandidateIndependentReviewV1[]>;
}

export type UpdateCandidatePublisherConfigurationV1 = Readonly<{
  repository: IntegrationRepositoryObserverV1;
  runner: UpdateCandidateTestRunnerV1;
  profiles: readonly UpdateCandidateProfileConfigurationV1[];
  pathRules: readonly UpdateCandidatePathRuleV1[];
  reviews?: UpdateCandidateReviewSourceV1;
}>;

type BindingRow = { request_id: string; project_id: string; pipeline_run_id: string; lead_worker_id: string;
  run_state: string; signoff_state: string; signoff_worker: string; build_worker: string };
type ReviewRow = { review_id: string; review_digest: string; reviewer_worker_id: string };
const revision = /^[a-f0-9]{40}$/u, digest = /^sha256:[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[\x21-\x7e]{1,512}$/u;
const migrationPath = /^db\/migrations\/(\d{4}_[a-z0-9_]+)\.sql$/u;
const isDatabasePath = (path: string) => path === "db" || path.startsWith("db/")
  || path === "deploy/postgres" || path.startsWith("deploy/postgres/")
  || path === "scripts/mac-local/database-role-manifest.mjs" || path.endsWith(".sql");
const isDependencyPath = (path: string) => path === "package.json" || path === "pnpm-lock.yaml"
  || path === ".npmrc" || path === "pnpm-workspace.yaml" || path === ".pnpmfile.cjs";
const order: readonly UpdateCandidateProfileIdV1[] = ["fast", "targeted", "db", "full"];

function captureConfiguration(value: UpdateCandidatePublisherConfigurationV1) {
  if (!value || typeof value.repository?.observe !== "function" || typeof value.runner?.run !== "function"
    || !Array.isArray(value.profiles) || !Array.isArray(value.pathRules)) throw new Error("update_candidate_publisher_config_invalid");
  const profiles = value.profiles.map(profile => {
    if (!order.includes(profile.id) || !Number.isSafeInteger(profile.version) || profile.version < 1
      || !Array.isArray(profile.commandIds) || profile.commandIds.length < 1 || profile.commandIds.length > 32
      || profile.commandIds.some((command: string) => !identifier.test(command)) || new Set(profile.commandIds).size !== profile.commandIds.length
      || !identifier.test(profile.workerId) || !identifier.test(profile.runner?.serviceId)
      || !["candidate_worktree", "local_test_runner"].includes(profile.runner?.kind))
      throw new Error("update_candidate_publisher_config_invalid");
    if ((profile.id === "db" || profile.id === "full") !== (profile.runner.kind === "local_test_runner"))
      throw new Error("update_candidate_publisher_config_invalid");
    return Object.freeze({ ...profile, commandIds: Object.freeze([...profile.commandIds]),
      runner: Object.freeze({ ...profile.runner }) });
  });
  if (profiles.length !== order.length || new Set(profiles.map((profile: UpdateCandidateProfileConfigurationV1) => profile.id)).size !== order.length
    || order.some(id => !profiles.some(profile => profile.id === id))) throw new Error("update_candidate_publisher_config_invalid");
  const pathRules = value.pathRules.map(rule => {
    if (!safePath.test(rule.prefix) || rule.prefix.endsWith("/") === false || !rule.area.trim() || rule.area.length > 240
      || rule.profiles?.some((profile: "db" | "full") => profile !== "db" && profile !== "full")
      || rule.risk !== undefined && !["security", "database", "authority", "dependency"].includes(rule.risk))
      throw new Error("update_candidate_publisher_config_invalid");
    return Object.freeze({ ...rule, profiles: Object.freeze([...(rule.profiles ?? [])]) });
  });
  if (new Set(pathRules.map(rule => rule.prefix)).size !== pathRules.length) throw new Error("update_candidate_publisher_config_invalid");
  return Object.freeze({ repository: Object.freeze({ observe: value.repository.observe.bind(value.repository) }),
    runner: Object.freeze({ run: value.runner.run.bind(value.runner) }), profiles: Object.freeze(profiles),
    pathRules: Object.freeze(pathRules), reviews: value.reviews ? Object.freeze({
      acceptedForRun: value.reviews.acceptedForRun.bind(value.reviews) }) : undefined });
}

export const CONTROL_ROOM_UPDATE_TEST_PROFILES_V1: readonly UpdateCandidateProfileConfigurationV1[] = Object.freeze([
  Object.freeze({ id: "fast", version: 1, commandIds: Object.freeze(["check.types", "test.changed"]),
    runner: Object.freeze({ kind: "candidate_worktree", serviceId: "runner:candidate-worktree" }), workerId: "service:test-runner" }),
  Object.freeze({ id: "db", version: 1, commandIds: Object.freeze(["test.postgres.production", "check.migration-ledger"]),
    runner: Object.freeze({ kind: "local_test_runner", serviceId: "runner:local-postgres" }), workerId: "service:test-runner" }),
  Object.freeze({ id: "full", version: 1, commandIds: Object.freeze(["check.full", "test.full.non-live"]),
    runner: Object.freeze({ kind: "local_test_runner", serviceId: "runner:local-full" }), workerId: "service:test-runner" }),
  Object.freeze({ id: "targeted", version: 1, commandIds: Object.freeze(["test.changed-lanes", "test.changed-guards", "test.changed-journeys"]),
    runner: Object.freeze({ kind: "candidate_worktree", serviceId: "runner:candidate-worktree" }), workerId: "service:test-runner" }),
]);

export const CONTROL_ROOM_UPDATE_PATH_RULES_V1: readonly UpdateCandidatePathRuleV1[] = Object.freeze([
  Object.freeze({ prefix: "db/", area: "database", profiles: Object.freeze(["db"] as const), risk: "database" }),
  Object.freeze({ prefix: "db/migrations/", area: "database migrations", profiles: Object.freeze(["db"] as const), risk: "database" }),
  Object.freeze({ prefix: "db/roles/", area: "database roles", profiles: Object.freeze(["db", "full"] as const), risk: "database" }),
  Object.freeze({ prefix: "deploy/", area: "deployment authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: ".github/", area: "release authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "src/security/", area: "security", profiles: Object.freeze(["full"] as const), risk: "security" }),
  Object.freeze({ prefix: "src/node-policy/", area: "node security policy", profiles: Object.freeze(["full"] as const), risk: "security" }),
  Object.freeze({ prefix: "src/persistence/", area: "database access", profiles: Object.freeze(["db", "full"] as const), risk: "database" }),
  Object.freeze({ prefix: "src/completion-gate/", area: "review authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "src/improve-control-room/", area: "update authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "src/pipelines/", area: "pipeline authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "src/work-intake/", area: "work authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "src/web/v1/", area: "web access boundary", profiles: Object.freeze(["full"] as const), risk: "security" }),
  Object.freeze({ prefix: "src/installer/", area: "installer", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "src/harness/", area: "worker authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "src/node-executor/", area: "execution authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "src/release-candidate-precheck/", area: "release authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "src/supervisor/", area: "service authority", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "scripts/mac-local/", area: "local service controls", profiles: Object.freeze(["full"] as const), risk: "authority" }),
  Object.freeze({ prefix: "private-app/", area: "owner interface" }),
  Object.freeze({ prefix: "tests/", area: "test coverage" }),
  Object.freeze({ prefix: "docs/", area: "documentation" }),
]);

function classify(paths: readonly string[], rules: readonly UpdateCandidatePathRuleV1[]) {
  const profiles = new Set<UpdateCandidateProfileIdV1>(["fast", "targeted"]), areas = new Set<string>();
  const risks = new Map<UpdateCandidateRiskKindV1, string>();
  for (const path of paths) {
    if (!safePath.test(path)) throw new Error("update_candidate_repository_unavailable");
    const databasePath = isDatabasePath(path), dependencyPath = isDependencyPath(path);
    const matching = rules.filter(rule => path.startsWith(rule.prefix));
    if (!matching.length) {
      if (!databasePath && !dependencyPath) {
        profiles.add("full"); areas.add(path.split("/", 1)[0] ?? "other");
        risks.set("authority", "unclassified path"); continue;
      }
    }
    for (const rule of matching) {
      areas.add(rule.area); for (const profile of rule.profiles ?? []) profiles.add(profile);
      if (rule.risk) risks.set(rule.risk, rule.area);
    }
    if (databasePath) { profiles.add("db"); areas.add("database-sensitive files"); risks.set("database", "database-sensitive files"); }
    if (dependencyPath) { profiles.add("full"); areas.add("dependency configuration"); risks.set("dependency", "dependency configuration"); }
  }
  return { profileIds: order.filter(profile => profiles.has(profile)), changedAreas: [...areas].sort(),
    riskFlags: [...risks].sort(([left], [right]) => left.localeCompare(right)).map(([kind, area]) => ({ kind,
      summary: `${area} changed`, needsIndependentReview: true as const })) };
}

function databaseChanges(paths: readonly string[], addedPaths: readonly string[]) {
  const changedPaths = paths.filter(isDatabasePath).sort();
  if (!changedPaths.length) return { kind: "none" as const };
  const migrationIds = changedPaths.map(path => migrationPath.exec(path)?.[1])
    .filter((value): value is string => !!value).sort();
  if (changedPaths.every(path => migrationPath.test(path) && addedPaths.includes(path))) return {
    kind: "migrations" as const, migrationIds,
    summary: `${migrationIds.length} migration${migrationIds.length === 1 ? "" : "s"} added.`,
    compatibilityNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure.",
    rollbackNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure." };
  return { kind: "changes" as const, changedPaths, migrationIds,
    summary: `${changedPaths.length} database-sensitive path${changedPaths.length === 1 ? "" : "s"} changed.`,
    compatibilityNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure.",
    rollbackNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure." };
}

function summary(snapshot: IntegrationRepositorySnapshotV1) {
  const subjects = snapshot.commitSubjects.map(value => value.replace(/\s+/gu, " ").trim()).filter(Boolean).slice(0, 8);
  const value = subjects.length ? subjects.join("; ") : `${snapshot.changedPaths.length} changed path${snapshot.changedPaths.length === 1 ? "" : "s"}`;
  return value.slice(0, 4000);
}

export class UpdateCandidatePublisherV1 {
  readonly #configuration: ReturnType<typeof captureConfiguration>;
  readonly #pending = new Map<string, Promise<UpdateCandidatePublishResultV1>>();
  #sweeping?: Promise<UpdateCandidatePublishResultV1[]>;
  readonly #reviews: UpdateCandidateReviewSourceV1;
  constructor(private readonly db: DatabaseClient, private readonly scope: Readonly<{ tenantId: string; workspaceId: string }>,
    private readonly desk: Pick<ImproveControlRoomDeskServiceV1, "recordCandidate">,
    configuration: UpdateCandidatePublisherConfigurationV1) {
    this.#configuration = captureConfiguration(configuration);
    this.#reviews = this.#configuration.reviews ?? { acceptedForRun: async pipelineRunId =>
      (await this.db.query<ReviewRow>(`SELECT plan.review_id,record.record_digest AS review_digest,
        plan.reviewer->>'workerId' AS reviewer_worker_id FROM control_agent_review_plans plan
        JOIN control_completion_gate_records record ON record.tenant_id=plan.tenant_id AND record.id=plan.review_id
          AND record.project_id=plan.project_id AND record.kind='review'
        WHERE plan.tenant_id=$1 AND plan.pipeline_run_id=$2 AND record.payload->>'decision'='accepted'
        ORDER BY plan.review_id`, [this.scope.tenantId, pipelineRunId])).rows.map(row => ({ reviewId: row.review_id,
          reviewDigest: row.review_digest, reviewerWorkerId: row.reviewer_worker_id })) };
  }

  async #binding(runId: string) {
    return (await this.db.query<BindingRow>(`SELECT request.id AS request_id,request.project_id,request.pipeline_run_id,
      request.lead_worker_id,run.state AS run_state,stage.state AS signoff_state,
      stage.worker_id AS signoff_worker,
      (SELECT worker_id FROM pipeline_stage_runs selected WHERE selected.tenant_id=run.tenant_id
        AND selected.pipeline_run_id=run.id AND selected.stage_kind='build') AS build_worker
      FROM control_improvement_requests request
      JOIN pipeline_runs run ON run.tenant_id=request.tenant_id AND run.id=request.pipeline_run_id
        AND run.project_id=request.project_id
      JOIN pipeline_stage_runs stage ON stage.tenant_id=run.tenant_id AND stage.pipeline_run_id=run.id
        AND stage.project_id=run.project_id AND stage.stage_kind='signoff'
      LEFT JOIN control_update_candidates candidate ON candidate.tenant_id=request.tenant_id
        AND candidate.pipeline_run_id=request.pipeline_run_id
      WHERE request.tenant_id=$1 AND request.pipeline_run_id=$2 AND candidate.id IS NULL`,
    [this.scope.tenantId, runId])).rows[0];
  }

  publishRun(runId: string): Promise<UpdateCandidatePublishResultV1> {
    if (!identifier.test(runId)) return Promise.resolve({ state: "not_eligible" });
    const existing = this.#pending.get(runId); if (existing) return existing;
    const operation = this.#publish(runId).catch(() => ({ state: "blocked", reason: "publisher_unavailable" } as const))
      .finally(() => this.#pending.delete(runId));
    this.#pending.set(runId, operation); return operation;
  }

  async #publish(runId: string): Promise<UpdateCandidatePublishResultV1> {
    const binding = await this.#binding(runId);
    if (!binding || binding.run_state !== "succeeded" || binding.signoff_state !== "succeeded"
      || binding.signoff_worker !== binding.lead_worker_id) return { state: "not_eligible" };
    const first = await this.#configuration.repository.observe({ pipelineRunId: runId });
    if (!revision.test(first.baseRevision) || !revision.test(first.candidateRevision)
      || first.baseRevision === first.candidateRevision || !first.changedPaths.length || first.changedPaths.length > 1000
      || !Array.isArray(first.addedPaths) || first.addedPaths.some(path => !first.changedPaths.includes(path)))
      return { state: "blocked", reason: "repository_unavailable" };
    const classified = classify(first.changedPaths, this.#configuration.pathRules);
    const accepted = await this.#reviews.acceptedForRun(runId);
    if (accepted.some(review => !identifier.test(review.reviewId) || !digest.test(review.reviewDigest)
      || !identifier.test(review.reviewerWorkerId))) return { state: "blocked", reason: "review_unavailable" };
    const independent = accepted.filter(review => review.reviewerWorkerId !== binding.lead_worker_id
      && review.reviewerWorkerId !== binding.build_worker);
    if (classified.riskFlags.length && !independent.length) return { state: "blocked", reason: "independent_review_required" };
    const testResults = [];
    for (const profileId of classified.profileIds) {
      const profile = this.#configuration.profiles.find(value => value.id === profileId)!;
      const profileDigest = sha256Digest({ schema: "control-room.update-test-profile/v1", ...profile });
      let result: UpdateCandidateRunnerResultV1;
      try { result = await this.#configuration.runner.run({ pipelineRunId: runId, candidateRevision: first.candidateRevision,
        changedPaths: first.changedPaths, profile, profileDigest }); }
      catch { return { state: "blocked", reason: "test_runner_unavailable" }; }
      const candidate = { profile: profile.id, profileVersion: profile.version, profileDigest,
        commandIds: [...profile.commandIds], candidateRevision: first.candidateRevision, ...result,
        workerId: profile.workerId, runner: profile.runner };
      try { assertNoSecretMaterial(candidate); } catch { return { state: "blocked", reason: "test_evidence_invalid" }; }
      if (candidate.status !== "passed" || !candidate.evidenceDigest || !digest.test(candidate.evidenceDigest))
        return { state: "blocked", reason: "tests_not_passed" };
      testResults.push(candidate);
    }
    const second = await this.#configuration.repository.observe({ pipelineRunId: runId });
    if (canonicalJson(second) !== canonicalJson(first)) return { state: "blocked", reason: "repository_changed" };
    const input = recordUpdateCandidateSchemaV1.parse({ projectId: binding.project_id,
      improvementRequestId: binding.request_id, pipelineRunId: binding.pipeline_run_id,
      baseRevision: first.baseRevision, candidateRevision: first.candidateRevision, summary: summary(first),
      changedAreas: classified.changedAreas, testResults, databaseChanges: databaseChanges(first.changedPaths, first.addedPaths),
      riskFlags: classified.riskFlags, independentReviews: independent, leadWorkerId: binding.lead_worker_id });
    try { assertNoSecretMaterial(input); } catch { return { state: "blocked", reason: "candidate_invalid" }; }
    const recorded = await this.desk.recordCandidate(input);
    return { state: recorded.replayed ? "replayed" : "published", candidateId: recorded.candidate.candidateId };
  }

  sweep(limit = 8): Promise<UpdateCandidatePublishResultV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error("update_candidate_publisher_config_invalid");
    const existing = this.#sweeping; if (existing) return existing;
    const operation = this.#sweep(limit).finally(() => { if (this.#sweeping === operation) this.#sweeping = undefined; });
    this.#sweeping = operation; return operation;
  }

  async #sweep(limit: number) {
    const rows = (await this.db.query<{ pipeline_run_id: string }>(`SELECT request.pipeline_run_id
      FROM control_improvement_requests request JOIN pipeline_runs run ON run.tenant_id=request.tenant_id
        AND run.id=request.pipeline_run_id AND run.project_id=request.project_id
      LEFT JOIN control_update_candidates candidate ON candidate.tenant_id=request.tenant_id
        AND candidate.pipeline_run_id=request.pipeline_run_id
      WHERE request.tenant_id=$1 AND run.state='succeeded' AND candidate.id IS NULL
      ORDER BY run.completed_at,request.pipeline_run_id LIMIT $2`, [this.scope.tenantId, limit])).rows;
    const results: UpdateCandidatePublishResultV1[] = [];
    // The integration repository has one mutable branch HEAD. Keep observation,
    // tests, re-observation and recording together for one candidate at a time.
    for (const row of rows) results.push(await this.publishRun(row.pipeline_run_id));
    return results;
  }
}

export type UpdateCandidatePublishResultV1 = Readonly<
  { state: "published" | "replayed"; candidateId: string }
  | { state: "not_eligible" }
  | { state: "blocked"; reason: "publisher_unavailable" | "repository_unavailable" | "review_unavailable"
    | "independent_review_required" | "test_runner_unavailable" | "test_evidence_invalid" | "tests_not_passed"
    | "repository_changed" | "candidate_invalid" }
>;
