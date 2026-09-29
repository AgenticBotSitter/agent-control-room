import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { WebTaskService } from "../src/web/v1/task-service";
import { WebProjectService } from "../src/web/v1/project-service";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, instant } from "./hermes-native-fixture";
import { at, registration } from "./native-task-fixture";
import { computeAuthorityDigest, hmacSha256Tag, sha256Digest } from "../src/security";
import type { CompletionReviewV1, CompletionVerificationV1 } from "../src/completion-gate/v1";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_START_OPERATION_V1 } from "../src/harness/v1/remote-worker-delivery";
import { taskDraft } from "./helpers/web-task";
import { WebTaskVerificationService } from "../src/web/v1/task-verification-service";
import { HarnessRunStoreV1, type StoredHarnessRunRowV1 } from "../src/harness/v1/store";
import { readResultBoundWorktreeChangeAuditSummariesV1 } from "../src/harness/v1/worktree-change-audit-record-store";
import { NativeResultStore } from "../src/artifacts/v1/native-results";

function observed(db: DatabaseClient, delayMs: number) {
  let queries = 0, transactions = 0;
  const wrap = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    queries += 1;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return tx.query<T>(sql, params);
  } });
  const client: DatabaseClient = { query: async <T>(sql: string, params?: unknown[]) => {
    queries += 1;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return db.query<T>(sql, params);
  }, transaction: work => { transactions += 1; return db.transaction(tx => work(wrap(tx))); },
  transactionWithPreCommitCheck: (work, check) => { transactions += 1;
    return db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check); } };
  return { client, count: () => queries, transactionCount: () => transactions };
}

const injectedLatencyMs = 50;
// Exact round-trip counts are the load-bearing budget. Wall time is only a
// deadlock/runaway sanity check, so allow a full second for loaded CI runners
// beyond the worst case where every allowed injected delay is sequential.
const wallClockMarginMs = 1_000;
const assertInjectedLatencyBudget = (label: string, measured: { queries: number; elapsedMs: number },
  allowedRoundTrips: number) => {
  assert.equal(measured.queries, allowedRoundTrips,
    `${label} changed the injected-latency round-trip budget: ${JSON.stringify(measured)}`);
  const sanityBoundMs = injectedLatencyMs * allowedRoundTrips + wallClockMarginMs;
  assert.ok(measured.elapsedMs < sanityBoundMs,
    `${label} exceeded the ${sanityBoundMs}ms wall-clock sanity bound: ${JSON.stringify(measured)}`);
};

async function state(db: DatabaseClient, jobIds: readonly string[], next: "succeeded" | "proposed" | "running", version: number) {
  for (const jobId of jobIds) {
    const row = (await db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, jobId])).rows[0]!;
    await db.query("UPDATE control_jobs SET state=$3,version=$4,payload=$5::jsonb,updated_at=$6 WHERE tenant_id=$1 AND id=$2",
      [binding.tenantId, jobId, next, version, JSON.stringify({ ...row.payload, state: next, version, updatedAt: at(7000 + version) }),
        at(7000 + version)]);
  }
}

test("task list, needs-me and Home keep a fixed query budget as the page grows", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);

  const measure = async (delayMs: number, read: (tasks: WebTaskService) => Promise<unknown>) => {
    const watched = observed(f.db, delayMs);
    const tasks = new WebTaskService(watched.client, f.scope, () => instant + 6000, f.ownerKeys);
    const started = performance.now(); await read(tasks);
    return { queries: watched.count(), elapsedMs: performance.now() - started };
  };
  const reads = {
    list: (tasks: WebTaskService) => tasks.list(f.identity, binding.projectId),
    attention: (tasks: WebTaskService) => tasks.attention(f.identity),
    home: (tasks: WebTaskService) => tasks.home(f.identity),
    overview: (tasks: WebTaskService) => tasks.projectOverview(f.identity, binding.projectId),
  };
  const one = { list: await measure(0, reads.list), attention: await measure(0, reads.attention),
    home: await measure(0, reads.home), overview: await measure(0, reads.overview) };
  const activeList = await f.tasks.list(f.identity, binding.projectId), activeHome = await f.tasks.home(f.identity);
  assert.equal(activeList.tasks.find(task => task.jobId === binding.jobId)?.state, "succeeded",
    "the canonical leased task is displayed as completed from its authenticated latest run and result");
  assert.equal(activeHome.active.some(task => task.jobId === binding.jobId), false,
    "a displayed-completed task is not retained in Home active work");
  assert.equal(activeHome.recentResults.find(result => result.task.jobId === binding.jobId)?.task.state, "succeeded");

  const source = (await f.db.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, binding.jobId])).rows[0]!.payload;
  const workflow = (await f.db.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM control_workflows WHERE tenant_id=$1 AND id=$2", [binding.tenantId, "workflow:test"])).rows[0]!.payload;
  const extra = Array.from({ length: 9 }, (_, index) => `job:budget:${String(index + 1).padStart(2, "0")}`);
  await f.db.query("UPDATE control_workflows SET payload=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, "workflow:test", JSON.stringify({ ...workflow, jobIds: [binding.jobId, ...extra] })]);
  for (const jobId of extra) {
    const payload = { ...source, id: jobId, state: "leased", version: 2, updatedAt: at(7002) };
    await f.db.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,
      authority_digest,payload,created_at,updated_at) SELECT $1,tenant_id,workflow_id,project_id,'leased',2,priority,
      required_capability,authority_digest,$2::jsonb,created_at,$3 FROM control_jobs WHERE tenant_id=$4 AND id=$5`,
    [jobId, JSON.stringify(payload), at(7002), binding.tenantId, binding.jobId]);
  }

  const list = await measure(injectedLatencyMs, reads.list);
  assert.equal(list.queries, one.list.queries, `list query count grew: ${JSON.stringify({ one: one.list, ten: list })}`);
  assertInjectedLatencyBudget("list", list, 9);
  const overview = await measure(0, reads.overview);
  assert.equal(overview.queries, one.overview.queries,
    `project overview query count grew: ${JSON.stringify({ one: one.overview, ten: overview })}`);

  await state(f.db, extra, "proposed", 4);
  const attention = await measure(injectedLatencyMs, reads.attention);
  assert.equal(attention.queries, one.attention.queries,
    `needs-me query count grew: ${JSON.stringify({ one: one.attention, ten: attention })}`);
  assertInjectedLatencyBudget("needs-me", attention, 9);

  await state(f.db, extra, "running", 5);
  const home = await measure(injectedLatencyMs, reads.home);
  assert.equal(home.queries, one.home.queries, `Home query count grew: ${JSON.stringify({ one: one.home, ten: home })}`);
  assertInjectedLatencyBudget("Home", home, 9);
  t.diagnostic(JSON.stringify({ injectedLatencyMs, oneTaskQueries: {
    list: one.list.queries, attention: one.attention.queries, home: one.home.queries, overview: one.overview.queries,
  }, tenTask: { list, attention, home, overview } }));
});

test("needs-me suppresses authentic saved plans in-session without hiding unplanned proposals or growing its query budget", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const planIntegrityKey = new Uint8Array(32).fill(117);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:budget-remote",
    allowedOperations: [CONTROLLER_WORKER_REMOTE_START_OPERATION_V1], credentialRefs: ["credential:budget-remote"],
    filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required",
    maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:attention-budget", adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1,
    authority, instructions: "Return a bounded plain-text review only.", connectorProfileDigest: sha256Digest("budget-profile"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: planIntegrityKey,
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7_000);
  const saveProposal = async (index: number) => {
    const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, `attention-budget-saved-${index}`);
    await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
    return source.receipt.jobId;
  };
  const firstSavedJobId = await saveProposal(1);
  const unplanned = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "attention-budget-unplanned");
  const measure = async (delayMs: number) => {
    const watched = observed(f.db, delayMs);
    const tasks = new WebTaskService(watched.client, f.scope, () => instant + 8_000,
      { ...f.ownerKeys, taskPlanIntegrityKey: planIntegrityKey });
    const started = performance.now(), page = await tasks.attention(f.identity);
    return { page, queries: watched.count(), transactions: watched.transactionCount(), elapsedMs: performance.now() - started };
  };

  const one = await measure(0);
  assert.equal(one.transactions, 1, "saved-plan verification shares the attention authentication transaction");
  assert.equal(one.page.planningSource, "configured");
  assert.equal(one.page.items.some(item => item.task.jobId === firstSavedJobId), false,
    "an authenticated saved plan suppresses its source proposal inside WebTaskService.attention");
  assert.deepEqual(one.page.items.find(item => item.task.jobId === unplanned.receipt.jobId)?.reasons, ["proposal"],
    "a proposal with no saved plan remains visible and does not fail completion-profile authentication");

  const additionalSavedJobIds = [];
  for (let index = 2; index <= 5; index += 1) additionalSavedJobIds.push(await saveProposal(index));
  const many = await measure(injectedLatencyMs);
  assert.equal(many.transactions, 1, "batched saved-plan verification does not open a per-plan transaction");
  for (const jobId of [firstSavedJobId, ...additionalSavedJobIds])
    assert.equal(many.page.items.some(item => item.task.jobId === jobId), false, `saved proposal remained visible: ${jobId}`);
  assert.deepEqual(many.page.items.find(item => item.task.jobId === unplanned.receipt.jobId)?.reasons, ["proposal"]);
  assert.equal(many.queries, one.queries,
    `saved-plan attention query count grew with proposal count: ${JSON.stringify({ one: one.queries, many: many.queries })}`);
  assertInjectedLatencyBudget("saved-plan attention", many, 9);
  t.diagnostic(JSON.stringify({ injectedLatencyMs, oneSavedPlanQueries: one.queries,
    fiveSavedPlans: { queries: many.queries, elapsedMs: many.elapsedMs } }));
});

test("Home project catalog stays fixed-query as ordinary projects grow", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const measure = async (delayMs: number) => {
    const watched = observed(f.db, delayMs);
    const projects = new WebProjectService(watched.client, f.scope, () => instant + 6000);
    const started = performance.now(); await projects.listPage(f.identity);
    return { queries: watched.count(), elapsedMs: performance.now() - started };
  };
  const one = await measure(0);
  for (let index = 1; index < 10; index += 1) {
    const id = `project:budget:${String(index).padStart(2, "0")}`;
    await f.db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      SELECT $1,tenant_id,workspace_id,adapter_id,$1,source_version,$2,description,normalized_state,domain_state,health,
      authority_mode,observed_at,payload,updated_at FROM projects WHERE tenant_id=$3 AND id=$4`,
    [id, `Budget project ${index}`, binding.tenantId, binding.projectId]);
    await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      SELECT tenant_id,$1,lifecycle,version,created_at,updated_at FROM control_manual_project_heads
      WHERE tenant_id=$2 AND project_id=$3`, [id, binding.tenantId, binding.projectId]);
  }
  const ten = await measure(injectedLatencyMs);
  assert.equal(ten.queries, one.queries, `project query count grew: ${JSON.stringify({ one, ten })}`);
  assertInjectedLatencyBudget("project catalog", ten, 5);
  t.diagnostic(JSON.stringify({ injectedLatencyMs, oneTaskQueries: one.queries, tenProjects: ten }));
});

test("three concurrent Home reads stay inside the injected remote-latency target", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  await state(f.db, [binding.jobId], "succeeded", 3);
  const measure = async (read: (tasks: WebTaskService, projects: WebProjectService) => Promise<unknown>) => {
    const watched = observed(f.db, injectedLatencyMs);
    const tasks = new WebTaskService(watched.client, f.scope, () => instant + 6000, f.ownerKeys);
    const projects = new WebProjectService(watched.client, f.scope, () => instant + 6000);
    const started = performance.now();
    await Promise.all(Array.from({ length: 3 }, () => read(tasks, projects)));
    return { queries: watched.count(), elapsedMs: performance.now() - started };
  };
  const burst = {
    list: await measure(tasks => tasks.list(f.identity, binding.projectId)),
    attention: await measure(tasks => tasks.attention(f.identity)),
    home: await measure(tasks => tasks.home(f.identity)),
    projects: await measure((_tasks, projects) => projects.listPage(f.identity)),
  };
  const allowedBurstRoundTrips = { list: 27, attention: 27, home: 27, projects: 15 } as const;
  for (const [name, result] of Object.entries(burst))
    assertInjectedLatencyBudget(`${name} burst`, result, allowedBurstRoundTrips[name as keyof typeof allowedBurstRoundTrips]);
  t.diagnostic(JSON.stringify({ injectedLatencyMs, concurrentReads: 3, burst }));
});

test("task detail and result-open reads stay within fixed remote-query budgets", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const listed = await f.tasks.results(f.identity, binding.projectId, binding.jobId);
  if (!("items" in listed)) throw new Error("result_page_unavailable");
  const preview = new URL(listed.items.find(item => item.artifactId === f.artifact.artifactId)!.fileAccess!.previewHref,
    "http://control-room.invalid");
  const previewToken = preview.searchParams.get("token")!;
  const scenarios = f.profile.requiredVerificationScenarioIds.map((scenarioId, index) => ({
    scenarioId, label: `Scenario ${index + 1}`, instructions: "Inspect the exact saved result.",
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile),
  }));
  const measure = async (delayMs: number, read: (db: DatabaseClient) => Promise<unknown>) => {
    const watched = observed(f.db, delayMs), started = performance.now();
    await read(watched.client);
    return { queries: watched.count(), elapsedMs: performance.now() - started };
  };
  const reads = {
    detail: (db: DatabaseClient) => new WebTaskService(db, f.scope, () => instant + 6000, f.ownerKeys)
      .detail(f.identity, binding.projectId, binding.jobId),
    results: (db: DatabaseClient) => new WebTaskService(db, f.scope, () => instant + 6000, f.ownerKeys)
      .results(f.identity, binding.projectId, binding.jobId),
    content: (db: DatabaseClient) => new WebTaskService(db, f.scope, () => instant + 6000, f.ownerKeys)
      .file(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, "preview", previewToken),
    review: (db: DatabaseClient) => f.createReviews(db).options(f.identity, binding.projectId, binding.jobId,
      f.artifact.artifactId, f.target.id),
    verification: (db: DatabaseClient) => new WebTaskVerificationService(db, f.scope, {
      integrityKey: f.reviewKey, checkpoints: f.checkpoints, harnessIntegrityKey: f.harnessKey,
      results: f.config, manualVerificationScenarios: scenarios,
    }, () => instant + 6000).options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id),
  };
  const collect = async (delayMs: number) => {
    const entries: [string, { queries: number; elapsedMs: number }][] = [];
    for (const [name, read] of Object.entries(reads)) entries.push([name, await measure(delayMs, read)]);
    return Object.fromEntries(entries) as Record<keyof typeof reads, { queries: number; elapsedMs: number }>;
  };
  const baseline = await collect(0), delayed = await collect(injectedLatencyMs);
  const allowedRoundTrips = { detail: 12, results: 12, content: 7, review: 12, verification: 11 } as const;
  for (const name of Object.keys(allowedRoundTrips) as (keyof typeof allowedRoundTrips)[]) {
    assert.equal(delayed[name]!.queries, baseline[name]!.queries, `${name} query count changed under latency`);
    assertInjectedLatencyBudget(name, delayed[name]!, allowedRoundTrips[name]);
  }
  const resultOpenCriticalQueries = delayed.results!.queries + delayed.content!.queries
    + Math.max(delayed.review!.queries, delayed.verification!.queries);
  assert.ok(resultOpenCriticalQueries * injectedLatencyMs < 1_600,
    `composed result-open network budget exceeded 1.6s: ${resultOpenCriticalQueries * injectedLatencyMs}`);
  t.diagnostic(JSON.stringify({ injectedLatencyMs, baseline, delayed,
    resultOpenCriticalPathMs: resultOpenCriticalQueries * injectedLatencyMs }));
});

test("verification options stay fixed-query as reviews and configured scenarios grow", async t => {
  const scenarioIds = Array.from({ length: 5 }, (_, index) => `scenario:budget:${index + 1}`);
  const f = await ownerReviewFixture({ profile: { requiredVerificationScenarioIds: scenarioIds } }); t.after(f.close);
  const descriptors = scenarioIds.map((scenarioId, index) => ({ scenarioId, label: `Budget scenario ${index + 1}`,
    instructions: `Inspect bounded evidence ${index + 1}.`, acceptanceProfileId: f.profile.id,
    acceptanceProfileDigest: sha256Digest(f.profile) }));
  const measure = async (configured: typeof descriptors) => {
    const watched = observed(f.db, 0);
    const service = new WebTaskVerificationService(watched.client, f.scope, { integrityKey: f.reviewKey,
      checkpoints: f.checkpoints, harnessIntegrityKey: f.harnessKey, results: f.config,
      manualVerificationScenarios: configured }, () => instant + 6000);
    await service.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
    return watched.count();
  };
  const oneScenario = await measure(descriptors.slice(0, 1));
  for (let index = 0; index < 5; index += 1) {
    const review: CompletionReviewV1 = { schemaVersion: "control-room-completion-gate/v1",
      id: `review:options-budget:${index}`, tenantId: binding.tenantId, projectId: binding.projectId,
      targetId: f.target.id, targetDigest: sha256Digest(f.target), acceptanceProfileId: f.profile.id,
      acceptanceProfileDigest: sha256Digest(f.profile), reviewer: { actorId: `identity:options-budget:${index}`, actorType: "human" },
      authority: "completion_gate", decision: "accepted", assessedRisk: "low", effectiveRisk: "low",
      evidenceDigests: [f.artifact.contentHash], findingIds: [], reviewedAt: at(5000 + index),
      grantsApproval: false, grantsExecutionAuthority: false };
    await f.reviewStore.recordReview(review);
  }
  const fiveScenariosAndReviews = await measure(descriptors);
  assert.equal(fiveScenariosAndReviews, oneScenario,
    `verification options added per-review or per-scenario queries: ${JSON.stringify({ oneScenario, fiveScenariosAndReviews })}`);
  assert.ok(fiveScenariosAndReviews <= 11, `verification options exceeded fixed query budget: ${fiveScenariosAndReviews}`);
});

test("attempt, run and artifact aggregate readers stay one-query as cardinality grows", async () => {
  let queries = 0;
  const db: DatabaseClient = { query: async () => { queries++; return { rows: [] }; },
    transaction: async work => work({ query: async () => { queries++; return { rows: [] }; } }),
    transactionWithPreCommitCheck: async (work, check) => {
      const value = await work({ query: async () => { queries++; return { rows: [] }; } }); await check(); return value;
    } };
  const runs = new HarnessRunStoreV1(db, new Uint8Array(32).fill(17));
  const count = async (read: () => Promise<unknown>) => { queries = 0; await read(); return queries; };
  const oneAttempt = await count(() => runs.inspectAttempts(binding.tenantId, binding.projectId, binding.jobId, [binding.attemptId]));
  const manyAttempts = await count(() => runs.inspectAttempts(binding.tenantId, binding.projectId, binding.jobId,
    Array.from({ length: 20 }, (_, index) => `attempt:budget:${index}`)));
  assert.equal(oneAttempt, 1); assert.equal(manyAttempts, oneAttempt);
  const oneRun = await count(() => runs.inspectMany(binding.tenantId, [binding.runId]));
  const manyRuns = await count(() => runs.inspectMany(binding.tenantId, Array.from({ length: 50 }, (_, index) => `run:budget:${index}`)));
  assert.equal(oneRun, 1); assert.equal(manyRuns, oneRun);
  const scope = (index: number) => ({ tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
    attemptId: `attempt:budget:${index}`, runId: `run:budget:${index}`,
    artifactId: `artifact:result:${index.toString(16).padStart(64, "0")}` });
  const oneArtifact = await count(() => readResultBoundWorktreeChangeAuditSummariesV1(db, new Uint8Array(32).fill(19), [scope(1)]));
  const manyArtifacts = await count(() => readResultBoundWorktreeChangeAuditSummariesV1(db, new Uint8Array(32).fill(19),
    Array.from({ length: 50 }, (_, index) => scope(index + 1))));
  assert.equal(oneArtifact, 1); assert.equal(manyArtifacts, oneArtifact);
});

test("full task detail stays fixed-query while processing ten populated attempts", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const withAttempts = (count: number): DatabaseClient => {
    const wrap = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
      const result = await tx.query<T>(sql, params);
      if (!sql.includes("FROM control_attempts WHERE tenant_id=$1 AND job_id=$2")) return result;
      const source = result.rows[0] as unknown as { id: string; state: string; attempt_number: number; payload: Record<string, unknown> };
      return { rows: Array.from({ length: count }, (_, index) => ({ ...source,
        id: `attempt:detail-budget:${index + 1}`, attempt_number: index + 1,
        payload: { ...source.payload, id: `attempt:detail-budget:${index + 1}`, attemptNumber: index + 1 } })) as T[] };
    } });
    return { query: f.db.query.bind(f.db), transaction: work => f.db.transaction(tx => work(wrap(tx))),
      transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
  };
  const measure = async (count: number) => {
    const watched = observed(withAttempts(count), 0);
    const detail = await new WebTaskService(watched.client, f.scope, () => instant + 6000, f.ownerKeys)
      .detail(f.identity, binding.projectId, binding.jobId);
    return { queries: watched.count(), attempts: detail.attempts.length };
  };
  const one = await measure(1), ten = await measure(10);
  assert.equal(one.attempts, 1); assert.equal(ten.attempts, 10);
  assert.equal(ten.queries, one.queries, `task detail added per-attempt queries: ${JSON.stringify({ one, ten })}`);
});

test("task detail reports additional runs only when an attempt has more than ten", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const row = (index: number): StoredHarnessRunRowV1 => {
    const timestamp = at(3000 + index), run = { ...registration, id: `run:omission:${index}`,
      nativeSessionKeyDigest: sha256Digest(`session:omission:${index}`),
      createdAt: timestamp, updatedAt: timestamp, lastObservedAt: timestamp };
    const runDigest = sha256Digest(run);
    return { id: run.id, tenant_id: run.tenantId, project_id: run.projectId, job_id: run.jobId,
      attempt_id: run.attemptId, node_id: run.nodeId, adapter_id: run.adapterId, harness: run.harness,
      native_session_key_digest: run.nativeSessionKeyDigest, parent_run_id: run.parentRunId ?? null,
      revision_of_run_id: run.revisionOfRunId ?? null, payload: run, last_sequence: 0, run_digest: runDigest,
      run_auth_tag: hmacSha256Tag(f.harnessKey, { id: run.id, tenantId: run.tenantId, projectId: run.projectId,
        jobId: run.jobId, attemptId: run.attemptId, nodeId: run.nodeId, adapterId: run.adapterId, harness: run.harness,
        nativeSessionKeyDigest: run.nativeSessionKeyDigest, parentRunId: run.parentRunId ?? null,
        revisionOfRunId: run.revisionOfRunId ?? null, state: run.state, lastSequence: 0, runDigest,
        createdAt: timestamp, updatedAt: timestamp, lastObservedAt: timestamp }), state: run.state,
      created_at: timestamp, updated_at: timestamp, last_observed_at: timestamp, event_rows: [] };
  };
  const insert = async (value: StoredHarnessRunRowV1) => {
    await f.db.query(`INSERT INTO control_harness_runs
      (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,parent_run_id,
       revision_of_run_id,state,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)`,
    [value.id, value.tenant_id, value.project_id, value.job_id, value.attempt_id, value.node_id, value.adapter_id,
      value.harness, value.native_session_key_digest, value.parent_run_id, value.revision_of_run_id, value.state,
      value.run_digest, value.run_auth_tag, JSON.stringify(value.payload), value.created_at, value.updated_at,
      value.last_observed_at]);
  };
  const detail = () => new WebTaskService(f.db, f.scope, () => instant + 6000, f.ownerKeys)
    .detail(f.identity, binding.projectId, binding.jobId);
  // The fixture owns one real run. Insert through the backing database so the
  // production LATERAL query and its LIMIT determine the returned rows.
  for (let index = 1; index <= 9; index += 1) await insert(row(index));
  const ten = await detail();
  await insert(row(10));
  const eleven = await detail();
  assert.equal(ten.attempts[0]!.runs.length, 10); assert.equal(ten.attempts[0]!.additionalRunsOmitted, false);
  assert.equal(eleven.attempts[0]!.runs.length, 10); assert.equal(eleven.attempts[0]!.additionalRunsOmitted, true);
  assert.equal(eleven.attempts[0]!.runs[0]!.runId, "run:omission:10");
});

test("full result page stays fixed-query while processing ten populated artifacts", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const prototype = NativeResultStore.prototype, original = prototype.list;
  let artifactCount = 1;
  prototype.list = async function(this: NativeResultStore, ...args: Parameters<NativeResultStore["list"]>) {
    const result = await original.apply(this, args), receipt = result.receipts[0]!;
    return { ...result, receipts: Array.from({ length: artifactCount }, (_, index) => ({ ...receipt,
      artifactId: `artifact:result:${(index + 1).toString(16).padStart(64, "0")}` })) };
  };
  t.after(() => { prototype.list = original; });
  const measure = async (count: number) => {
    artifactCount = count;
    const watched = observed(f.db, 0);
    const page = await new WebTaskService(watched.client, f.scope, () => instant + 6000, f.ownerKeys)
      .results(f.identity, binding.projectId, binding.jobId);
    if (!("items" in page)) throw new Error("result_page_unavailable");
    return { queries: watched.count(), artifacts: page.items.length };
  };
  const one = await measure(1), ten = await measure(10);
  assert.equal(one.artifacts, 1); assert.equal(ten.artifacts, 10);
  assert.equal(ten.queries, one.queries, `result page added per-artifact queries: ${JSON.stringify({ one, ten })}`);
});

test("review options inspect an exact target independently of the bounded result-page projection", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  // The result page deliberately omits older targets after its display bound.
  // Exact option reads must use the authenticated record set directly, not
  // rediscover their target through that bounded page projection.
  const prototype = Object.getPrototypeOf(f.reviewStore) as { inspectSubjectsFromRecords(): Map<string, unknown> };
  const original = prototype.inspectSubjectsFromRecords;
  prototype.inspectSubjectsFromRecords = () => new Map();
  t.after(() => { prototype.inspectSubjectsFromRecords = original; });
  const options = await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  assert.equal(options.targetId, f.target.id);
});

test("batched quality status fails closed when authenticated review evidence is omitted", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  for (let index = 0; index < 51; index += 1) {
    const review: CompletionReviewV1 = { schemaVersion: "control-room-completion-gate/v1",
      id: `review:budget:${String(index).padStart(2, "0")}`, tenantId: binding.tenantId,
      projectId: binding.projectId, targetId: f.target.id, targetDigest: sha256Digest(f.target),
      acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile),
      reviewer: { actorId: `identity:budget:${index}`, actorType: "human" }, authority: "completion_gate",
      decision: "accepted", assessedRisk: "low", effectiveRisk: "low", evidenceDigests: [f.artifact.contentHash],
      findingIds: [], reviewedAt: at(3000 + index), grantsApproval: false, grantsExecutionAuthority: false };
    await f.reviewStore.recordReview(review);
  }
  const verification: CompletionVerificationV1 = { schemaVersion: "control-room-completion-gate/v1",
    id: "verification:budget:content", tenantId: binding.tenantId, projectId: binding.projectId,
    targetId: f.target.id, targetDigest: sha256Digest(f.target), acceptanceProfileId: f.profile.id,
    acceptanceProfileDigest: sha256Digest(f.profile), scenarioId: f.profile.requiredVerificationScenarioIds[0]!,
    outcome: "passed", verifier: { actorId: "service:budget", actorType: "service" },
    evidenceDigests: [f.artifact.contentHash], verifiedAt: at(4000), grantsApproval: false,
    grantsExecutionAuthority: false };
  await f.reviewStore.recordVerification(verification);
  await state(f.db, [binding.jobId], "succeeded", 3);
  const page = await f.tasks.list(f.identity, binding.projectId);
  assert.notEqual(page.tasks.find(task => task.jobId === binding.jobId)?.qualityStatus, "accepted");
});
