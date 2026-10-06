import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { WorkBatchStoreV1, workBatchProposalDigestV1, type WorkBatchProposalV1 } from
  "../src/work-intake/v1";
import { taskFixture, taskDraft } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { downRungBefore, readMigrationGraph } from "./helpers/down-migration-order";

const integrityKey = new Uint8Array(32).fill(9);
const proposer = (): AuthenticatedPrincipal => ({ tenantId: "tenant:web", identityId: "identity:queue-proposer",
  actorType: "agent", authenticatedAt: "2026-09-04T11:59:00.000Z", expiresAt: "2026-09-04T13:00:00.000Z" });

async function queueFixture() {
  const f = await taskFixture();
  await f.db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:queue-proposer','tenant:web','agent',
    'Queue proposer','work-intake',$1,'active',$2,$2)`,
  [sha256Digest("queue-proposer"), new Date(now).toISOString()]);
  await f.db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:queue-proposer','tenant:web','identity:queue-proposer','work_batch_proposer',
    '["work_batches.propose"]',$1::jsonb,'low',false,false,$2,$2)`,
  [JSON.stringify([f.project.projectId]), new Date(now).toISOString()]);
  const proposal: WorkBatchProposalV1 = { schema: "control-room.work-batch-proposal/v1",
    projectId: f.project.projectId, tasks: [{ localId: "build", title: "Build the bounded change",
      instructions: "Implement the bounded change.", requiredCapability: "code.change", role: "builder",
      requestedWorkerId: "worker:codex:one", requestedWorkerKind: "codex", requestedModelKey: "codex.standard",
      acceptanceCriteria: "The bounded change is complete.", acceptanceTests: "Run the focused tests." }], edges: [] };
  const batch = await new WorkBatchStoreV1(f.client, integrityKey).create({ principal: proposer(), proposal,
    proposalDigest: workBatchProposalDigestV1(proposal), idempotencyKey: "queue-db-proposal-0001",
    now: new Date(now).toISOString(), queueDepthLimit: 3 });
  const task = await f.tasks.propose(f.identity, f.project.projectId, taskDraft, "queue-db-task-0001");
  const itemId = `${batch.batchId}:item:build`;
  await f.db.query(`INSERT INTO work_batch_items(id,tenant_id,batch_id,batch_revision,project_id,local_id,ordinal,
    role,required_capability,depends_on_local_ids,requested_worker_id,requested_worker_kind,requested_model_key,acceptance_criteria,
    acceptance_tests,decision_state,decision_reason_code,job_id,job_attempt_count,item_digest,auth_tag,created_at)
    VALUES($1,'tenant:web',$2,1,$3,'build',0,'builder','code.change','{}','worker:codex:one','codex','codex.standard',
      'The bounded change is complete.','Run the focused tests.','approved',NULL,$4,0,$5,$6,$7)`,
  [itemId, batch.batchId, f.project.projectId, task.receipt.jobId, `sha256:${"1".repeat(64)}`,
    `hmac-sha256:${"2".repeat(64)}`, new Date(now).toISOString()]);
  await f.db.query(`INSERT INTO work_batch_agent_queue_heads(tenant_id,worker_id,next_position,updated_at)
    VALUES('tenant:web','worker:codex:one',1,$1)`, [new Date(now).toISOString()]);
  const insertAdmission = (tx: { query: typeof f.client.query }, options: { workerKind?: string;
    selectionKey?: string; workerId?: string; assignmentRevision?: number; supersedesAdmissionId?: string | null;
    changeReasonCode?: string; digestCharacter?: string; queuePosition?: number } = {}) => {
    const workerKind = options.workerKind ?? "codex", selectionKey = options.selectionKey ?? "codex.standard";
    const workerId = options.workerId ?? "worker:codex:one", assignmentRevision = options.assignmentRevision ?? 1;
    const supersedesAdmissionId = options.supersedesAdmissionId ?? null;
    const changeReasonCode = options.changeReasonCode ?? "initial_owner_approval";
    const queuePosition = options.queuePosition ?? 1;
    const digestCharacter = options.digestCharacter ?? "3", admissionDigest = `sha256:${digestCharacter.repeat(64)}`;
    return tx.query(`INSERT INTO work_batch_queue_admissions(tenant_id,admission_id,item_id,batch_id,project_id,job_id,worker_id,
      worker_kind,node_id,queue_position,queue_depth_limit,selection_key,model,effort,provider,profile,
      assignment_revision,supersedes_admission_id,change_reason_code,authorized_by_identity_id,
      admission_digest,auth_tag,admitted_at) VALUES('tenant:web',$1,$2,$3,$4,$5,$6,$7,
      'node:local:worker',$8,3,$9,'gpt-test','medium',NULL,NULL,$10,$11,$12,'identity:web',$13,$14,$15)`,
    [`admission:${digestCharacter.repeat(64)}`, itemId, batch.batchId, f.project.projectId, task.receipt.jobId,
      workerId, workerKind, queuePosition, selectionKey, assignmentRevision, supersedesAdmissionId, changeReasonCode,
      admissionDigest, `hmac-sha256:${"4".repeat(64)}`, new Date(now).toISOString()]);
  };
  return { ...f, batch, itemId, task, insertAdmission };
}

test("agent queue heads allocate one contiguous append-only order and bind the requested worker/model", async t => {
  const f = await queueFixture(); t.after(() => void f.db.close());

  await assert.rejects(f.client.transaction(async tx => {
    await tx.query(`UPDATE work_batch_agent_queue_heads SET next_position=2,updated_at=$1
      WHERE tenant_id='tenant:web' AND worker_id='worker:codex:one'`, [new Date(now + 1).toISOString()]);
    await f.insertAdmission(tx, { workerKind: "claude-code" });
  }), /work batch queue admission rejected/u);
  assert.equal((await f.db.query<{ next_position: number }>(`SELECT next_position FROM work_batch_agent_queue_heads
    WHERE tenant_id='tenant:web' AND worker_id='worker:codex:one'`)).rows[0]!.next_position, 1);

  await assert.rejects(f.client.transaction(async tx => {
    await tx.query(`INSERT INTO work_batch_agent_queue_heads(tenant_id,worker_id,next_position,updated_at)
      VALUES('tenant:web','worker:codex:other',1,$1)`, [new Date(now).toISOString()]);
    await tx.query(`UPDATE work_batch_agent_queue_heads SET next_position=2,updated_at=$1
      WHERE tenant_id='tenant:web' AND worker_id='worker:codex:other'`, [new Date(now + 1).toISOString()]);
    await f.insertAdmission(tx, { workerId: "worker:codex:other" });
  }), /work batch queue admission rejected/u);

  await assert.rejects(f.client.transaction(async tx => {
    await tx.query(`UPDATE work_batch_agent_queue_heads SET next_position=2,updated_at=$1
      WHERE tenant_id='tenant:web' AND worker_id='worker:codex:one'`, [new Date(now + 1).toISOString()]);
    await f.insertAdmission(tx, { selectionKey: "codex.changed" });
  }), /work batch queue admission rejected/u);
  assert.equal((await f.db.query<{ next_position: number }>(`SELECT next_position FROM work_batch_agent_queue_heads
    WHERE tenant_id='tenant:web' AND worker_id='worker:codex:one'`)).rows[0]!.next_position, 1);

  await f.client.transaction(async tx => {
    await tx.query(`UPDATE work_batch_agent_queue_heads SET next_position=2,updated_at=$1
      WHERE tenant_id='tenant:web' AND worker_id='worker:codex:one'`, [new Date(now + 1).toISOString()]);
    await f.insertAdmission(tx);
  });
  assert.deepEqual((await f.db.query<{ queue_position: number; worker_id: string }>(
    "SELECT queue_position,worker_id FROM work_batch_queue_admissions")).rows,
  [{ queue_position: 1, worker_id: "worker:codex:one" }]);

  await assert.rejects(f.db.query("UPDATE work_batch_queue_admissions SET model='changed'"), /append-only/u);
  await assert.rejects(f.db.query("DELETE FROM work_batch_queue_admissions"), /append-only/u);
  await assert.rejects(f.db.query("TRUNCATE work_batch_queue_admissions"), /append-only/u);
  await assert.rejects(f.db.query("DELETE FROM work_batch_agent_queue_heads"), /append-only/u);
  await assert.rejects(f.db.query("TRUNCATE work_batch_agent_queue_heads"), /append-only/u);
});

test("agent queue head allocations cannot commit gaps, abandoned positions or oversized advances", async t => {
  const f = await queueFixture(); t.after(() => void f.db.close());
  await assert.rejects(f.client.transaction(tx => tx.query(`UPDATE work_batch_agent_queue_heads
    SET next_position=2,updated_at=$1 WHERE tenant_id='tenant:web' AND worker_id='worker:codex:one'`,
  [new Date(now + 1).toISOString()])), /committed without contiguous admissions/u);
  await assert.rejects(f.db.query(`UPDATE work_batch_agent_queue_heads SET next_position=22,updated_at=$1
    WHERE tenant_id='tenant:web' AND worker_id='worker:codex:one'`, [new Date(now + 1).toISOString()]),
  /queue head update rejected/u);
  assert.equal((await f.db.query<{ next_position: number }>("SELECT next_position FROM work_batch_agent_queue_heads"))
    .rows[0]!.next_position, 1);
});

test("assignment changes append revisions while the effective projection keeps one stable item and job", async t => {
  const f = await queueFixture(); t.after(() => void f.db.close());
  await f.client.transaction(async tx => {
    await tx.query(`UPDATE work_batch_agent_queue_heads SET next_position=2,updated_at=$1
      WHERE tenant_id='tenant:web' AND worker_id='worker:codex:one'`, [new Date(now + 1).toISOString()]);
    await f.insertAdmission(tx);
  });
  await f.db.query(`INSERT INTO work_batch_agent_queue_heads(tenant_id,worker_id,next_position,updated_at)
    VALUES('tenant:web','worker:claude:one',1,$1)`, [new Date(now + 2).toISOString()]);
  await f.client.transaction(async tx => {
    await tx.query(`UPDATE work_batch_agent_queue_heads SET next_position=2,updated_at=$1
      WHERE tenant_id='tenant:web' AND worker_id='worker:claude:one'`, [new Date(now + 3).toISOString()]);
    await f.insertAdmission(tx, { workerKind: "claude-code", selectionKey: "claude.standard",
      workerId: "worker:claude:one", assignmentRevision: 2,
      supersedesAdmissionId: `admission:${"3".repeat(64)}`, changeReasonCode: "owner_reassignment",
      digestCharacter: "5" });
  });

  const history = (await f.db.query<{ assignment_revision: number; worker_id: string }>(`SELECT assignment_revision,
    worker_id FROM work_batch_queue_admissions ORDER BY assignment_revision`)).rows;
  assert.deepEqual(history, [{ assignment_revision: 1, worker_id: "worker:codex:one" },
    { assignment_revision: 2, worker_id: "worker:claude:one" }]);
  const effective = (await f.db.query<{ assignment_revision: number; worker_id: string; item_id: string; job_id: string }>(
    `SELECT assignment_revision,worker_id,item_id,job_id FROM work_batch_effective_queue_admissions`)).rows;
  assert.deepEqual(effective, [{ assignment_revision: 2, worker_id: "worker:claude:one",
    item_id: f.itemId, job_id: f.task.receipt.jobId }]);

  await assert.rejects(f.client.transaction(async tx => {
    await tx.query(`UPDATE work_batch_agent_queue_heads SET next_position=3,updated_at=$1
      WHERE tenant_id='tenant:web' AND worker_id='worker:claude:one'`, [new Date(now + 4).toISOString()]);
    await f.insertAdmission(tx, { workerKind: "claude-code", selectionKey: "claude.standard",
      workerId: "worker:claude:one", assignmentRevision: 4,
      supersedesAdmissionId: `admission:${"5".repeat(64)}`, changeReasonCode: "owner_reassignment",
      digestCharacter: "6", queuePosition: 2 });
  }), /work batch queue admission rejected/u);
});

test("0104 down migration refuses either queue metadata table and removes every owned object when empty", async t => {
  const populated = await queueFixture(); t.after(() => void populated.db.close());
  const down = await readFile("db/down/0104_work_batch_agent_queue.sql", "utf8");
  assert.match(down, /^BEGIN;\nLOCK TABLE work_batch_items, work_batch_agent_queue_heads, work_batch_queue_admissions IN ACCESS EXCLUSIVE MODE;/u);
  await assert.rejects(populated.db.exec(down), /down migration refused/u);
  await populated.db.exec("ROLLBACK");
  assert.equal((await populated.db.query("SELECT 1 FROM work_batch_agent_queue_heads")).rows.length, 1);

  const empty = await taskFixture(); t.after(() => void empty.db.close());
  // A real rollback is stacked: every later migration whose objects are built on
  // 0104's goes first, newest first. The rung is derived from the SQL, so 0213's
  // view over work_batch_queue_admissions is in it without being named here.
  const rung = downRungBefore(await readMigrationGraph("."), "0104_work_batch_agent_queue.sql");
  assert.ok(rung.files.includes("0213_text_copy_derivation_grants.sql"),
    "the rung must carry 0213, whose view reads work_batch_queue_admissions");
  for (const file of rung.files) await empty.db.exec(await readFile(`db/down/${file}`, "utf8"));
  await empty.db.exec(down);
  const objects = (await empty.db.query<{ heads: string | null; admissions: string | null; effective: string | null; head_guard: string | null;
    admission_guard: string | null }>(`SELECT to_regclass('work_batch_agent_queue_heads')::text heads,
      to_regclass('work_batch_queue_admissions')::text admissions,
      to_regclass('work_batch_effective_queue_admissions')::text effective,
      to_regprocedure('guard_work_batch_agent_queue_head_write()')::text head_guard,
      to_regprocedure('guard_work_batch_queue_admission_insert()')::text admission_guard`)).rows[0]!;
  assert.deepEqual(objects, { heads: null, admissions: null, effective: null, head_guard: null, admission_guard: null });
});
