import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { WebTaskService } from "../src/web/v1/task-service";
import { WebProjectService } from "../src/web/v1/project-service";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { sha256Digest } from "../src/security";
import type { CompletionReviewV1, CompletionVerificationV1 } from "../src/completion-gate/v1";

function observed(db: DatabaseClient, delayMs: number) {
  let queries = 0;
  const wrap = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    queries += 1;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return tx.query<T>(sql, params);
  } });
  const client: DatabaseClient = { query: async <T>(sql: string, params?: unknown[]) => {
    queries += 1;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return db.query<T>(sql, params);
  }, transaction: work => db.transaction(tx => work(wrap(tx))),
  transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
  return { client, count: () => queries };
}

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
  await state(f.db, [binding.jobId], "succeeded", 3);

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
  };
  const one = { list: await measure(0, reads.list), attention: await measure(0, reads.attention),
    home: await measure(0, reads.home) };

  const source = (await f.db.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, binding.jobId])).rows[0]!.payload;
  const workflow = (await f.db.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM control_workflows WHERE tenant_id=$1 AND id=$2", [binding.tenantId, "workflow:test"])).rows[0]!.payload;
  const extra = Array.from({ length: 9 }, (_, index) => `job:budget:${String(index + 1).padStart(2, "0")}`);
  await f.db.query("UPDATE control_workflows SET payload=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, "workflow:test", JSON.stringify({ ...workflow, jobIds: [binding.jobId, ...extra] })]);
  for (const jobId of extra) {
    const payload = { ...source, id: jobId, state: "succeeded", version: 3, updatedAt: at(7003) };
    await f.db.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,
      authority_digest,payload,created_at,updated_at) SELECT $1,tenant_id,workflow_id,project_id,'succeeded',3,priority,
      required_capability,authority_digest,$2::jsonb,created_at,$3 FROM control_jobs WHERE tenant_id=$4 AND id=$5`,
    [jobId, JSON.stringify(payload), at(7003), binding.tenantId, binding.jobId]);
  }

  const list = await measure(50, reads.list);
  assert.equal(list.queries, one.list.queries, `list query count grew: ${JSON.stringify({ one: one.list, ten: list })}`);
  assert.ok(list.queries <= 8, `list exceeded the eight-query remote budget: ${list.queries}`);
  assert.ok(list.queries * 50 < 500, `list network budget exceeded 500ms: ${list.queries * 50}`);
  assert.ok(list.elapsedMs < 500, `list exceeded the 500ms wall target: ${list.elapsedMs}`);

  await state(f.db, extra, "proposed", 4);
  const attention = await measure(50, reads.attention);
  assert.equal(attention.queries, one.attention.queries,
    `needs-me query count grew: ${JSON.stringify({ one: one.attention, ten: attention })}`);
  assert.ok(attention.queries <= 8, `needs-me exceeded the eight-query remote budget: ${attention.queries}`);
  assert.ok(attention.queries * 50 < 500, `needs-me network budget exceeded 500ms: ${attention.queries * 50}`);
  assert.ok(attention.elapsedMs < 500, `needs-me exceeded the 500ms wall target: ${attention.elapsedMs}`);

  await state(f.db, extra, "running", 5);
  const home = await measure(50, reads.home);
  assert.equal(home.queries, one.home.queries, `Home query count grew: ${JSON.stringify({ one: one.home, ten: home })}`);
  assert.ok(home.queries <= 8, `Home exceeded the eight-query remote budget: ${home.queries}`);
  assert.ok(home.queries * 50 < 500, `Home network budget exceeded 500ms: ${home.queries * 50}`);
  assert.ok(home.elapsedMs < 500, `Home exceeded the 500ms wall target: ${home.elapsedMs}`);
  t.diagnostic(JSON.stringify({ injectedLatencyMs: 50, oneTaskQueries: {
    list: one.list.queries, attention: one.attention.queries, home: one.home.queries,
  }, tenTask: { list, attention, home } }));
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
  const ten = await measure(50);
  assert.equal(ten.queries, one.queries, `project query count grew: ${JSON.stringify({ one, ten })}`);
  assert.ok(ten.queries <= 5, `project catalog exceeded the five-query remote budget: ${ten.queries}`);
  assert.ok(ten.queries * 50 < 500, `project catalog network budget exceeded 500ms: ${ten.queries * 50}`);
  assert.ok(ten.elapsedMs < 500, `project catalog exceeded the 500ms wall target: ${ten.elapsedMs}`);
  t.diagnostic(JSON.stringify({ injectedLatencyMs: 50, oneTaskQueries: one.queries, tenProjects: ten }));
});

test("three concurrent Home reads stay inside the injected remote-latency target", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  await state(f.db, [binding.jobId], "succeeded", 3);
  const measure = async (read: (tasks: WebTaskService, projects: WebProjectService) => Promise<unknown>) => {
    const watched = observed(f.db, 50);
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
  for (const [name, result] of Object.entries(burst)) {
    assert.ok(result.queries * 50 < 1_500, `${name} burst network budget exceeded 1.5s: ${result.queries * 50}`);
    assert.ok(result.elapsedMs < 1_500, `${name} burst exceeded the wall target: ${result.elapsedMs}`);
  }
  t.diagnostic(JSON.stringify({ injectedLatencyMs: 50, concurrentReads: 3, burst }));
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
