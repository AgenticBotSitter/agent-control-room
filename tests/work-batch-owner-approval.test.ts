import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hmacSha256Tag, sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { WorkBatchOwnerServiceV1, WorkBatchStoreV1, workBatchProposalDigestV1,
  workBatchOwnerNotificationV1, type WorkBatchProposalV1 } from "../src/work-intake/v1";
import { taskFixture } from "./helpers/web-task";
import { now, origin, request, trust } from "./helpers/web-foundation";
import { createWorkBatchOwnerHttpHandlerV1 } from "../src/web/v1/work-batch-owner-http";
import type { WorkBatchQueueAdmissionAuthorityV1, WorkBatchQueueCatalogV1 } from "../src/work-intake/v1";
import { WebTaskService } from "../src/web/v1/task-service";
import { captureTaskModelCatalogV1 } from "../src/web/v1/task-model-selection";
import { workBatchQueueItemSchemaV1 } from "../src/work-intake/v1/owner-schemas";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const key = new Uint8Array(32).fill(7);
const agent = (): AuthenticatedPrincipal => ({ tenantId: "tenant:web", identityId: "identity:batch-agent",
  actorType: "agent", authenticatedAt: "2026-09-04T11:59:00.000Z", expiresAt: "2026-09-04T13:00:00.000Z" });
function proposal(projectId: string): WorkBatchProposalV1 {
  return { schema: "control-room.work-batch-proposal/v1", projectId, tasks: [
    { localId: "build", title: "Build the change", instructions: "Implement the bounded change.",
      requiredCapability: "code.change", role: "builder", acceptanceCriteria: "The implementation is bounded.",
      acceptanceTests: "Run the focused build tests." },
    { localId: "check", title: "Check the change", instructions: "Review the retained implementation evidence.",
      requiredCapability: "code.review", role: "checker", acceptanceCriteria: "The review is independent.",
      acceptanceTests: "Run the focused review tests." },
  ], edges: [{ fromLocalId: "build", toLocalId: "check" }] };
}

async function ownerFixture(queueCatalog: WorkBatchQueueCatalogV1 = [],
  queueAdmissionAuthority: WorkBatchQueueAdmissionAuthorityV1 | null | undefined = queueCatalog.length
    ? { assertCurrent: () => true, isAcceptedResultCurrent: () => false } : undefined) {
  const f = await taskFixture();
  await f.db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:batch-agent','tenant:web','agent','Batch agent',
    'work-intake',$1,'active',$2,$2)`, [sha256Digest("batch-agent"), new Date(now).toISOString()]);
  await f.db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES('grant:batch-agent','tenant:web',
    'identity:batch-agent','work_batch_proposer','["work_batches.propose"]',$1::jsonb,'low',false,false,$2,$2)`,
  [JSON.stringify([f.project.projectId]), new Date(now).toISOString()]);
  const store = new WorkBatchStoreV1(f.client, key);
  const modelCatalog = captureTaskModelCatalogV1(queueCatalog.map(worker =>
    ({ kind: worker.workerKind, policy: worker.modelPolicy })));
  const tasks = queueCatalog.length ? new WebTaskService(f.client,
    { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now, { modelCatalog }) : f.tasks;
  const owner = new WorkBatchOwnerServiceV1(f.client, tasks,
    { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, () => now, queueCatalog,
    queueAdmissionAuthority ?? undefined);
  let submission = 0;
  async function submit(value = proposal(f.project.projectId), queueDepthLimit = 10) {
    return store.create({ principal: agent(), proposal: value, proposalDigest: workBatchProposalDigestV1(value),
      idempotencyKey: `owner-test-submit-${String(++submission).padStart(4, "0")}`, now: new Date(now).toISOString(),
      queueDepthLimit });
  }
  return { ...f, owner, store, submit };
}

const codexCatalog = (): WorkBatchQueueCatalogV1 => [{ workerId: "worker:codex-one", workerKind: "codex",
  nodeId: "node:mac.codex", modelPolicy: { models: ["gpt-build", "gpt-check"], defaultModel: "gpt-build",
    efforts: ["high"], defaultEffort: "high" } }];

async function seedQueueExecution(f: Awaited<ReturnType<typeof ownerFixture>>, sourceJobId: string,
  input: { state: "leased" | "running"; workerId?: string; queued?: boolean }) {
  const at = new Date(now).toISOString(), attemptId = `attempt:${sourceJobId}`;
  await f.db.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
    VALUES('tenant:web',$1,$2,$2,'{}'::jsonb,$3)`,
  [f.project.projectId, sourceJobId, `hmac-sha256:${"5".repeat(64)}`]);
  await f.db.query(`UPDATE control_task_model_selections SET worker_kind='codex',selection_key='gpt-build',
    model='gpt-build',effort='high',provider=NULL,profile=NULL WHERE tenant_id='tenant:web' AND job_id=$1`,
  [sourceJobId]);
  await f.db.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES('node:mac.codex','tenant:web','active',1,'key:test',$1::jsonb,$2,$2) ON CONFLICT(id) DO NOTHING`,
  [JSON.stringify({ id: "node:mac.codex", tenantId: "tenant:web", state: "active", version: 1,
    identityKeyId: "key:test" }), at]);
  const workerId = input.workerId ?? "worker:codex-one";
  await f.db.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,
    lease_epoch,payload,created_at,updated_at) VALUES($1,'tenant:web',$2,1,$3,1,$4,'node:mac.codex',1,$5::jsonb,$6,$6)`,
  [attemptId, sourceJobId, input.state, workerId, JSON.stringify({
    id: attemptId, tenantId: "tenant:web", state: input.state, version: 1, jobId: sourceJobId,
    attemptNumber: 1, workerId, nodeId: "node:mac.codex", leaseEpoch: 1,
  }), at]);
  if (input.queued) {
    await f.db.query(`INSERT INTO control_native_approval_packets(tenant_id,project_id,job_id,attempt_id,record,auth_tag)
      VALUES('tenant:web',$1,$2,$3,'{}'::jsonb,$4)`,
    [f.project.projectId, sourceJobId, attemptId, `hmac-sha256:${"6".repeat(64)}`]);
    await f.db.query(`INSERT INTO control_native_task_queue(tenant_id,project_id,job_id,attempt_id,record,auth_tag)
      VALUES('tenant:web',$1,$2,$3,'{}'::jsonb,$4)`,
    [f.project.projectId, sourceJobId, attemptId, `hmac-sha256:${"7".repeat(64)}`]);
  }
}

test("approval records an exact per-agent queue in dependency order without starting work", async t => {
  const f = await ownerFixture(codexCatalog()); t.after(() => void f.db.close());
  const value = proposal(f.project.projectId);
  value.tasks = [
    { ...value.tasks[1]!, requestedWorkerId: "worker:codex-one", requestedWorkerKind: "codex",
      requestedModelKey: "gpt-check" },
    { ...value.tasks[0]!, requestedWorkerId: "worker:codex-one", requestedWorkerKind: "codex",
      requestedModelKey: "gpt-build" },
  ];
  const batch = await f.submit(value);
  const receipt = await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "check", decision: "approve" }, { localId: "build", decision: "approve" }] },
    "owner-batch-queue-order-0001");
  assert.equal(receipt.startsWork, false);
  const view = await f.owner.view(f.identity, f.project.projectId, batch.batchId);
  assert.deepEqual(view.queue.map(item => [item.localId, item.position, item.workerId, item.model, item.effort, item.state]), [
    ["build", 1, "worker:codex-one", "gpt-build", "high", "awaiting_preparation"],
    ["check", 2, "worker:codex-one", "gpt-check", "high", "awaiting_preparation"],
  ]);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_attempts")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_native_task_queue")).rows[0]!.count, 0);
});

test("queue projection accepts provider-style and plus-suffixed protected model identifiers", () => {
  const base = { localId: "build", jobId: "job:build", workerId: "worker:one", workerKind: "hermes",
    nodeId: "node:one", position: 1, queueDepthLimit: 4, effort: "default",
    state: "awaiting_preparation" as const };
  assert.equal(workBatchQueueItemSchemaV1.parse({ ...base,
    selectionKey: "provider/profile+", model: "provider/model+",
    provider: "provider/api+", profile: "provider/profile+" }).model, "provider/model+");
});

test("the restricted private-web role can render queued batch state", async t => {
  const f = await ownerFixture(codexCatalog()); t.after(() => void f.db.close());
  const value = proposal(f.project.projectId);
  value.tasks[0] = { ...value.tasks[0]!, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" };
  const batch = await f.submit(value);
  await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-restricted-role-0001");
  const jobId = (await f.owner.view(f.identity, f.project.projectId, batch.batchId))
    .items.find(item => item.localId === "build")!.jobId!;
  await seedQueueExecution(f, jobId, { state: "leased", queued: true });
  await f.db.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.db.exec(`CREATE ROLE work_batch_web_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS; GRANT control_room_private_web TO work_batch_web_test;
    SET SESSION AUTHORIZATION work_batch_web_test; SET search_path=pg_catalog,public;`);
  const view = await f.owner.view(f.identity, f.project.projectId, batch.batchId);
  assert.equal(view.queue[0]!.state, "queued");
});

test("queue admission refuses unknown workers, wrong models and depth overflow atomically", async t => {
  const f = await ownerFixture(codexCatalog()); t.after(() => void f.db.close());
  for (const [suffix, workerId, model] of [["worker", "worker:missing", "gpt-build"],
    ["model", "worker:codex-one", "not-enabled"]] as const) {
    const value = proposal(f.project.projectId);
    value.tasks = value.tasks.map(task => ({ ...task, requestedWorkerId: workerId,
      requestedWorkerKind: "codex", requestedModelKey: model }));
    const batch = await f.submit(value);
    await assert.rejects(f.owner.command(f.identity, f.project.projectId,
      { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
        items: value.tasks.map(task => ({ localId: task.localId, decision: "approve" as const })) },
      `owner-batch-queue-invalid-${suffix}`), /conflict/u);
  }
  const bounded = proposal(f.project.projectId);
  bounded.tasks = bounded.tasks.map(task => ({ ...task, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" }));
  const overflow = await f.submit(bounded, 1);
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: overflow.batchId, expectedRevision: 1,
      items: bounded.tasks.map(task => ({ localId: task.localId, decision: "approve" as const })) },
    "owner-batch-queue-overflow-0001"), /queue_depth_exceeded/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_jobs")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_items")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_queue_admissions")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_agent_queue_heads")).rows[0]!.count, 0);
});

test("exact-worker admission rechecks current readiness and model policy inside the decision", async t => {
  let current = false;
  const f = await ownerFixture(codexCatalog(), { assertCurrent: selection => current
    && selection.workerId === "worker:codex-one" && selection.selectionKey === "gpt-build",
  isAcceptedResultCurrent: () => false });
  t.after(() => void f.db.close());
  const value = proposal(f.project.projectId);
  value.tasks[0] = { ...value.tasks[0]!, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" };
  const first = await f.submit(value);
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: first.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-current-refusal-0001"), /conflict/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_items")).rows[0]!.count, 0);
  current = true;
  const accepted = await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: first.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-current-accept-0001");
  assert.equal(accepted.state, "partially_approved");

  const noAuthority = await ownerFixture(codexCatalog(), null); t.after(() => void noAuthority.db.close());
  const secondValue = proposal(noAuthority.project.projectId);
  secondValue.tasks[0] = { ...secondValue.tasks[0]!, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" };
  const second = await noAuthority.submit(secondValue);
  await assert.rejects(noAuthority.owner.command(noAuthority.identity, noAuthority.project.projectId,
    { operation: "decide", batchId: second.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-current-missing-0001"), /conflict/u);
});

test("queue view reports running only for the exact admitted worker and model", async t => {
  const running = await ownerFixture(codexCatalog()); t.after(() => void running.db.close());
  const value = proposal(running.project.projectId);
  value.tasks[0] = { ...value.tasks[0]!, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" };
  const batch = await running.submit(value);
  await running.owner.command(running.identity, running.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-running-state-0001");
  const sourceJobId = (await running.owner.view(running.identity, running.project.projectId, batch.batchId))
    .items.find(item => item.localId === "build")!.jobId!;
  await seedQueueExecution(running, sourceJobId, { state: "running" });
  assert.equal((await running.owner.view(running.identity, running.project.projectId, batch.batchId)).queue[0]!.state, "running");

  const wrong = await ownerFixture(codexCatalog()); t.after(() => void wrong.db.close());
  const wrongValue = proposal(wrong.project.projectId);
  wrongValue.tasks[0] = { ...wrongValue.tasks[0]!, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" };
  const wrongBatch = await wrong.submit(wrongValue);
  await wrong.owner.command(wrong.identity, wrong.project.projectId,
    { operation: "decide", batchId: wrongBatch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-wrong-worker-0001");
  const wrongJobId = (await wrong.owner.view(wrong.identity, wrong.project.projectId, wrongBatch.batchId))
    .items.find(item => item.localId === "build")!.jobId!;
  await seedQueueExecution(wrong, wrongJobId, { state: "running", workerId: "worker:wrong" });
  assert.equal((await wrong.owner.view(wrong.identity, wrong.project.projectId, wrongBatch.batchId)).queue[0]!.state, "uncertain");
});

test("queued unfinished admissions still consume the recorded per-agent depth", async t => {
  const accepted = new Set<string>();
  let acceptanceCheckFails = false;
  const f = await ownerFixture(codexCatalog(), { assertCurrent: () => true,
    isAcceptedResultCurrent: (_tx, selection) => {
      if (acceptanceCheckFails) throw new Error("acceptance authority unavailable");
      return selection.workerId === "worker:codex-one" && selection.nodeId === "node:mac.codex"
        && accepted.has(selection.sourceJobId);
    } });
  t.after(() => void f.db.close());
  const firstValue = proposal(f.project.projectId);
  firstValue.tasks[0] = { ...firstValue.tasks[0]!, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" };
  const first = await f.submit(firstValue, 1);
  await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: first.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-depth-first-0001");
  const firstJobId = (await f.owner.view(f.identity, f.project.projectId, first.batchId))
    .items.find(item => item.localId === "build")!.jobId!;
  await seedQueueExecution(f, firstJobId, { state: "leased", queued: true });
  assert.equal((await f.owner.view(f.identity, f.project.projectId, first.batchId)).queue[0]!.state, "queued");

  const secondValue = proposal(f.project.projectId);
  secondValue.tasks[0] = { ...secondValue.tasks[0]!, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" };
  const second = await f.submit(secondValue, 1);
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: second.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-depth-second-0001"), /queue_depth_exceeded/u);
  acceptanceCheckFails = true;
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: second.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-depth-second-0002"), /queue_depth_exceeded/u);
  acceptanceCheckFails = false;
  accepted.add(firstJobId);
  const released = await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: second.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-depth-second-0003");
  assert.equal(released.state, "partially_approved");
});

test("queue depth refusal crosses the owner HTTP boundary as a bounded safe reason", async t => {
  const f = await ownerFixture(codexCatalog()); t.after(() => void f.db.close());
  const value = proposal(f.project.projectId);
  value.tasks = value.tasks.map(task => ({ ...task, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" }));
  const batch = await f.submit(value, 1);
  const handler = createWorkBatchOwnerHttpHandlerV1({ origin, trust, service: f.owner, clock: () => now });
  const path = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipelines/${encodeURIComponent(batch.batchId)}`;
  const response = await handler(request(path, "POST", { operation: "decide", batchId: batch.batchId,
    expectedRevision: 1, items: value.tasks.map(task => ({ localId: task.localId, decision: "approve" })) },
  "owner-http-queue-depth-0001"));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "queue_depth_exceeded" });
});

test("queue admission integrity failures refuse owner reads", async t => {
  const f = await ownerFixture(codexCatalog()); t.after(() => void f.db.close());
  const value = proposal(f.project.projectId);
  value.tasks[0] = { ...value.tasks[0]!, requestedWorkerId: "worker:codex-one",
    requestedWorkerKind: "codex", requestedModelKey: "gpt-build" };
  const batch = await f.submit(value);
  await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" }, { localId: "check", decision: "approve" }] },
    "owner-batch-queue-integrity-0001");
  await f.db.query("DROP TRIGGER work_batch_queue_admissions_append_only ON work_batch_queue_admissions");
  await f.db.query("UPDATE work_batch_queue_admissions SET model='tampered'");
  await assert.rejects(f.owner.view(f.identity, f.project.projectId, batch.batchId), /work_batch_integrity_failed/u);
});

function observed(db: DatabaseClient) {
  let queries = 0;
  const wrap = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    queries += 1; return tx.query<T>(sql, params);
  } });
  const client: DatabaseClient = { query: async <T>(sql: string, params?: unknown[]) => {
    queries += 1; return db.query<T>(sql, params);
  }, transaction: work => db.transaction(tx => work(wrap(tx))),
  transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
  return { client, count: () => queries };
}

test("owner approval atomically materializes ordinary proposed tasks and exact replay is inert", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit(), command = { operation: "decide" as const, batchId: batch.batchId, expectedRevision: 1,
    items: [{ localId: "build", decision: "approve" as const }, { localId: "check", decision: "approve" as const }] };
  const attention = await f.owner.attention(f.identity);
  assert.equal(attention.batches.length, 1); assert.equal(attention.batches[0]!.batchId, batch.batchId);
  const first = await f.owner.command(f.identity, f.project.projectId, command, "owner-batch-decision-0001");
  assert.equal(first.state, "approved"); assert.equal(first.startsWork, false); assert.equal(first.jobIds.length, 2);
  const replay = await f.owner.command(f.identity, f.project.projectId, command, "owner-batch-decision-0001");
  assert.equal(replay.replayed, true); assert.deepEqual(replay.jobIds, first.jobIds);
  const jobs = await f.db.query<{ state: string }>("SELECT state FROM control_jobs WHERE tenant_id='tenant:web'");
  assert.equal(jobs.rows.length, 2); assert.ok(jobs.rows.every(row => row.state === "proposed"));
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_attempts")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_items")).rows[0]!.count, 2);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_action_inbox")).rows[0]!.count, 1);
  assert.equal((await f.db.query<{ state: string }>("SELECT state FROM control_action_inbox")).rows[0]!.state, "resolved");
  assert.equal((await f.owner.attention(f.identity)).batches.length, 0);
  const notification = workBatchOwnerNotificationV1({ tenantId: "tenant:web", projectId: f.project.projectId,
    batchId: batch.batchId, createdAt: new Date(now).toISOString() });
  assert.equal(notification.envelope.authority, "none"); assert.deepEqual(notification.envelope.actions, []);
  assert.equal("command" in notification.envelope, false); assert.equal("legalResponses" in notification.envelope, false);
  const view = await f.owner.view(f.identity, f.project.projectId, batch.batchId);
  assert.equal(view.state, "approved"); assert.equal(view.items[1]!.dependsOnLocalIds[0], "build");
});

test("saved item and final-decision integrity failures refuse owner reads", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" }, { localId: "check", decision: "approve" }] },
    "owner-batch-integrity-0001");
  assert.equal((await f.store.status(agent(), f.project.projectId, batch.batchId,
    new Date(now).toISOString())).state, "approved");
  await f.db.query("DROP TRIGGER work_batch_items_append_only ON work_batch_items");
  await f.db.query("UPDATE work_batch_items SET acceptance_criteria='tampered' WHERE local_id='build'");
  await assert.rejects(f.owner.view(f.identity, f.project.projectId, batch.batchId), /work_batch_integrity_failed/u);
  await assert.rejects(f.store.status(agent(), f.project.projectId, batch.batchId,
    new Date(now).toISOString()), /integrity_failed/u);

  const second = await ownerFixture(); t.after(() => void second.db.close());
  const secondBatch = await second.submit();
  await second.owner.command(second.identity, second.project.projectId,
    { operation: "decide", batchId: secondBatch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] }, "owner-batch-integrity-0002");
  await second.db.query("DROP TRIGGER work_batches_owner_update ON work_batches");
  await second.db.query("UPDATE work_batches SET decision_auth_tag=$1 WHERE id=$2",
    [`hmac-sha256:${"0".repeat(64)}`, secondBatch.batchId]);
  await assert.rejects(second.owner.list(second.identity, second.project.projectId), /work_batch_integrity_failed/u);
  await assert.rejects(second.store.list(agent(), second.project.projectId,
    new Date(now).toISOString()), /integrity_failed/u);
});

test("revision and item HMAC-only tampering refuses owner and intake reads", async t => {
  const revision = await ownerFixture(); t.after(() => void revision.db.close());
  const revisionBatch = await revision.submit(), changed = proposal(revision.project.projectId);
  changed.tasks[0] = { ...changed.tasks[0]!, title: "Revised before tag tampering" };
  await revision.owner.command(revision.identity, revision.project.projectId,
    { operation: "revise", batchId: revisionBatch.batchId, expectedRevision: 1,
      reasonCode: "owner_edit", proposal: changed }, "owner-revision-hmac-0001");
  await revision.db.query("DROP TRIGGER work_batch_revisions_append_only ON work_batch_revisions");
  await revision.db.query("UPDATE work_batch_revisions SET auth_tag=$1 WHERE batch_id=$2 AND revision=2",
    [`hmac-sha256:${"0".repeat(64)}`, revisionBatch.batchId]);
  await assert.rejects(revision.owner.view(revision.identity, revision.project.projectId, revisionBatch.batchId),
    /work_batch_integrity_failed/u);
  await assert.rejects(revision.store.status(agent(), revision.project.projectId, revisionBatch.batchId,
    new Date(now).toISOString()), /integrity_failed/u);

  const item = await ownerFixture(); t.after(() => void item.db.close());
  const itemBatch = await item.submit();
  await item.owner.command(item.identity, item.project.projectId,
    { operation: "decide", batchId: itemBatch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" }, { localId: "check", decision: "approve" }] },
    "owner-item-hmac-0001");
  await item.db.query("DROP TRIGGER work_batch_items_append_only ON work_batch_items");
  await item.db.query("UPDATE work_batch_items SET auth_tag=$1 WHERE batch_id=$2 AND local_id='build'",
    [`hmac-sha256:${"0".repeat(64)}`, itemBatch.batchId]);
  await assert.rejects(item.owner.view(item.identity, item.project.projectId, itemBatch.batchId),
    /work_batch_integrity_failed/u);
  await assert.rejects(item.store.status(agent(), item.project.projectId, itemBatch.batchId,
    new Date(now).toISOString()), /integrity_failed/u);
});

test("database owner guards enforce every identity and grant authority boundary", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit(), changed = proposal(f.project.projectId);
  changed.tasks[0] = { ...changed.tasks[0]!, title: "Direct revision attack" };
  const digest = workBatchProposalDigestV1(changed);
  const ownerId = (await f.db.query<{ identity_id: string }>(
    "SELECT identity_id FROM control_role_grants WHERE id='grant:web'")).rows[0]!.identity_id;
  const rejectRevision = () => assert.rejects(f.db.query(`INSERT INTO work_batch_revisions
    (id,tenant_id,batch_id,revision,edited_by_identity_id,edited_at,reason_code,proposal,revision_digest,auth_tag)
    VALUES($1,'tenant:web',$2,2,$3,$4,'owner_edit',$5::jsonb,$6,$7)`,
  [`${batch.batchId}:revision:2`, batch.batchId, ownerId, new Date(now).toISOString(), JSON.stringify(changed), digest,
    `hmac-sha256:${"0".repeat(64)}`]), /work batch revision insert rejected/u);
  const rejectDecision = () => assert.rejects(f.db.query(`UPDATE work_batches SET state='approved',approval_identity_id=$1,approved_at=$2,
    decision_digest=$3,decision_auth_tag=$4,updated_at=$2 WHERE id=$5`,
  [ownerId, new Date(now).toISOString(), `sha256:${"0".repeat(64)}`, `hmac-sha256:${"0".repeat(64)}`, batch.batchId]),
  /work batch decision update rejected/u);
  const attacks = [
    { name: "revoked grant", apply: "UPDATE control_role_grants SET revoked_at='2026-09-04T12:00:00.000Z' WHERE id='grant:web'",
      restore: "UPDATE control_role_grants SET revoked_at=NULL WHERE id='grant:web'" },
    { name: "expired grant", apply: "UPDATE control_role_grants SET expires_at='2026-09-04T11:59:59.000Z' WHERE id='grant:web'",
      restore: "UPDATE control_role_grants SET expires_at=NULL WHERE id='grant:web'" },
    { name: "operator role", apply: "UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'",
      restore: "UPDATE control_role_grants SET role_key='owner' WHERE id='grant:web'" },
    { name: "missing action", apply: `UPDATE control_role_grants SET allowed_actions='["tasks.read"]'::jsonb WHERE id='grant:web'`,
      restore: `UPDATE control_role_grants SET allowed_actions='["*"]'::jsonb WHERE id='grant:web'` },
    { name: "wrong project", apply: `UPDATE control_role_grants SET project_ids='["project:other"]'::jsonb WHERE id='grant:web'`,
      restore: `UPDATE control_role_grants SET project_ids='["*"]'::jsonb WHERE id='grant:web'` },
    { name: "inactive identity", apply: "UPDATE control_identities SET state='suspended' WHERE id=$1",
      restore: "UPDATE control_identities SET state='active' WHERE id=$1", params: [ownerId] },
    { name: "non-human identity", apply: "UPDATE control_identities SET actor_type='service' WHERE id=$1",
      restore: "UPDATE control_identities SET actor_type='human' WHERE id=$1", params: [ownerId] },
  ];
  for (const attack of attacks) {
    await f.db.query(attack.apply, attack.params);
    await rejectRevision().catch(error => { throw new Error(`${attack.name} revision attack was not rejected`, { cause: error }); });
    await rejectDecision().catch(error => { throw new Error(`${attack.name} decision attack was not rejected`, { cause: error }); });
    await f.db.query(attack.restore, attack.params);
  }
});

test("future revocation remains valid until its effective timestamp", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit(), changed = proposal(f.project.projectId);
  changed.tasks[0] = { ...changed.tasks[0]!, title: "Revise before scheduled revocation" };
  await f.db.query("UPDATE control_role_grants SET revoked_at='2099-01-01T00:00:00.000Z' WHERE id='grant:web'");
  assert.deepEqual((await f.owner.attention(f.identity)).batches.map(item => item.batchId), [batch.batchId]);
  const revised = await f.owner.command(f.identity, f.project.projectId,
    { operation: "revise", batchId: batch.batchId, expectedRevision: 1, reasonCode: "owner_edit", proposal: changed },
    "owner-future-revocation-revise-0001");
  assert.equal(revised.revision, 2);
  const decided = await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 2,
      items: [{ localId: "build", decision: "approve" }, { localId: "check", decision: "approve" }] },
    "owner-future-revocation-decide-0001");
  assert.equal(decided.state, "approved");
});

test("revision history and rejected items remain visible", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit(), changed = proposal(f.project.projectId);
  changed.tasks[0] = { ...changed.tasks[0]!, title: "Build the revised change" };
  const revised = await f.owner.command(f.identity, f.project.projectId,
    { operation: "revise", batchId: batch.batchId, expectedRevision: 1, reasonCode: "owner_edit", proposal: changed },
    "owner-batch-revision-0001");
  assert.equal(revised.revision, 2); assert.equal(revised.state, "proposed");
  const decided = await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 2,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "needs_different_check" }] },
    "owner-batch-decision-0002");
  assert.equal(decided.state, "partially_approved"); assert.equal(decided.jobIds.length, 1);
  const view = await f.owner.view(f.identity, f.project.projectId, batch.batchId);
  assert.equal(view.revisions.length, 2); assert.equal(view.revisions[0]!.proposal.tasks[0]!.title, "Build the change");
  assert.equal(view.proposal.tasks[0]!.title, "Build the revised change");
  assert.equal(view.items[1]!.decisionReasonCode, "needs_different_check");
});

test("current revision task count is consistent across owner and intake summaries", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit(), changed = proposal(f.project.projectId);
  changed.tasks.push({ localId: "validate", title: "Validate the change", instructions: "Validate the bounded change.",
    requiredCapability: "code.validate", role: "validator", acceptanceCriteria: "The validation is independent.",
    acceptanceTests: "Run the focused validation tests." });
  await f.owner.command(f.identity, f.project.projectId,
    { operation: "revise", batchId: batch.batchId, expectedRevision: 1, reasonCode: "owner_edit", proposal: changed },
    "owner-batch-task-count-0001");

  const listed = await f.owner.list(f.identity, f.project.projectId);
  const attention = await f.owner.attention(f.identity);
  const status = await f.store.status(agent(), f.project.projectId, batch.batchId, new Date(now).toISOString());
  assert.equal(listed.batches[0]?.revision, 2);
  assert.equal(listed.batches[0]?.taskCount, 3);
  assert.equal(attention.batches[0]?.revision, 2);
  assert.equal(attention.batches[0]?.taskCount, 3);
  assert.equal(status.taskCount, 3);
  assert.equal(status.proposalDigest, workBatchProposalDigestV1(changed));
  assert.notEqual(status.proposalDigest, batch.proposalDigest);
});

test("owner list and attention query counts stay fixed as proposed batches grow", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  await f.submit();
  const measure = async (read: (owner: WorkBatchOwnerServiceV1) => Promise<unknown>) => {
    const watched = observed(f.client);
    const owner = new WorkBatchOwnerServiceV1(watched.client, f.tasks,
      { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, () => now);
    await read(owner); return watched.count();
  };
  const one = { list: await measure(owner => owner.list(f.identity, f.project.projectId)),
    attention: await measure(owner => owner.attention(f.identity)) };
  for (let index = 0; index < 9; index += 1) await f.submit();
  const ten = { list: await measure(owner => owner.list(f.identity, f.project.projectId)),
    attention: await measure(owner => owner.attention(f.identity)) };
  assert.deepEqual(ten, one, `owner batch reads added per-batch queries: ${JSON.stringify({ one, ten })}`);
});

test("unauthorized batches cannot consume the owner attention limit", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const otherProjectId = "project:batch-attention-other";
  await f.db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    description,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    SELECT $1,tenant_id,workspace_id,adapter_id,$1,source_version,'Other project',description,normalized_state,
      domain_state,health,authority_mode,observed_at,payload,updated_at FROM projects WHERE tenant_id=$2 AND id=$3`,
  [otherProjectId, "tenant:web", f.project.projectId]);
  await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    SELECT tenant_id,$1,lifecycle,version,created_at,updated_at FROM control_manual_project_heads
    WHERE tenant_id=$2 AND project_id=$3`, [otherProjectId, "tenant:web", f.project.projectId]);
  await f.db.query("UPDATE control_role_grants SET project_ids=$1::jsonb WHERE id='grant:batch-agent'",
    [JSON.stringify([f.project.projectId, otherProjectId])]);
  await f.db.query("UPDATE control_role_grants SET project_ids=$1::jsonb WHERE id='grant:web'",
    [JSON.stringify([f.project.projectId])]);
  const otherProposal = proposal(otherProjectId);
  for (let index = 0; index < 100; index += 1) await f.store.create({ principal: agent(), proposal: otherProposal,
    proposalDigest: workBatchProposalDigestV1(otherProposal),
    idempotencyKey: `other-attention-${String(index).padStart(4, "0")}`,
    now: new Date(now - 1000).toISOString(), queueDepthLimit: 10 });
  const authorized = await f.submit();
  const attention = await f.owner.attention(f.identity);
  assert.deepEqual(attention.batches.map(batch => batch.batchId), [authorized.batchId]);
});

test("an S1-authenticated batch remains readable after the S2 migration and first revision", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  const before = (await f.db.query<{ id: string; project_id: string; proposed_by_identity_id: string;
    proposed_at: string | Date; proposal: WorkBatchProposalV1; queue_depth_limit: number; batch_digest: string;
    auth_tag: string; auth_material_version: number; created_at: string | Date }>(`SELECT id,project_id,
      proposed_by_identity_id,proposed_at,proposal,queue_depth_limit,batch_digest,auth_tag,
      auth_material_version,created_at FROM work_batches WHERE id=$1`, [batch.batchId])).rows[0]!;
  const createdAt = new Date(before.created_at).toISOString();
  assert.equal(before.auth_material_version, 1, "0102 backfills the S1 auth-material version");
  assert.equal(before.auth_tag, hmacSha256Tag(key, { purpose: "work-batch/v1", record: {
    id: before.id, tenantId: "tenant:web", projectId: before.project_id,
    proposedByIdentityId: before.proposed_by_identity_id, proposedAt: new Date(before.proposed_at).toISOString(),
    state: "proposed", proposal: before.proposal, queueDepthLimit: Number(before.queue_depth_limit),
    batchDigest: before.batch_digest, version: 1, createdAt, updatedAt: createdAt } }));
  const changed = proposal(f.project.projectId);
  changed.tasks[0] = { ...changed.tasks[0]!, title: "Build after the S2 upgrade" };
  await f.owner.command(f.identity, f.project.projectId,
    { operation: "revise", batchId: batch.batchId, expectedRevision: 1, reasonCode: "owner_edit", proposal: changed },
    "owner-cross-version-revision-0001");
  assert.equal((await f.store.status(agent(), f.project.projectId, batch.batchId,
    new Date(now).toISOString())).state, "proposed");
  assert.equal((await f.store.list(agent(), f.project.projectId, new Date(now).toISOString())).length, 1);
  assert.equal((await f.owner.view(f.identity, f.project.projectId, batch.batchId)).revision, 2);
});

test("a missing durable notification rolls the whole owner decision back", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  await f.db.query("DELETE FROM control_action_inbox WHERE work_item_id=$1", [batch.batchId]);
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" }, { localId: "check", decision: "approve" }] },
    "owner-batch-missing-notification-0001"), /work_batch_integrity_failed/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_jobs")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_items")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ state: string }>("SELECT state FROM work_batches WHERE id=$1",
    [batch.batchId])).rows[0]!.state, "proposed");
});

test("owner commands refuse proposed-state decision residue before materialization", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  await f.db.query("DROP TRIGGER work_batches_owner_update ON work_batches");
  await f.db.query("UPDATE work_batches SET decision_digest=$1,decision_auth_tag=$2 WHERE id=$3",
    [sha256Digest("tampered decision"), `hmac-sha256:${"0".repeat(64)}`, batch.batchId]);
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" }, { localId: "check", decision: "approve" }] },
    "owner-batch-residue-0001"), /work_batch_integrity_failed/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_jobs")).rows[0]!.count, 0);
});

test("dependency-open partial approval and non-owner decisions leave no owner-command record", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
        { localId: "check", decision: "approve" }] }, "owner-batch-invalid-0001"), /conflict/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_jobs")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_idempotency WHERE operation_scope LIKE 'work-batches.owner%'")).rows[0]!.count, 0);
  await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'");
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-non-owner-0001"), /access_denied/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_items")).rows[0]!.count, 0);
});

test("owner batch HTTP routes are same-origin, bounded and path-bound", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit(), handler = createWorkBatchOwnerHttpHandlerV1({ origin, trust, service: f.owner, clock: () => now });
  const list = await handler(request(`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipelines`));
  assert.equal(list.status, 200); assert.equal((await list.json()).batches.length, 1);
  const path = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipelines/${encodeURIComponent(batch.batchId)}`;
  const mismatch = await handler(request(path, "POST", { operation: "decide", batchId: "batch:other", expectedRevision: 1,
    items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
      { localId: "check", decision: "reject", reasonCode: "not_selected" }] }, "owner-http-decision-0001"));
  assert.equal(mismatch.status, 400);
  const decided = await handler(request(path, "POST", { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
    items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
      { localId: "check", decision: "reject", reasonCode: "not_selected" }] }, "owner-http-decision-0002"));
  assert.equal(decided.status, 201); assert.equal((await decided.json()).state, "rejected");
});
