import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskAssignmentCoordinator } from '../src/web/v1/task-assignment-coordinator';
import type { TaskExecutionPlanner } from '../src/web/v1/task-execution-planner';
import type { DatabaseClient } from '../src/persistence/database';
import { canonicalApprovalStorageFixture } from './helpers/canonical-approval-storage';
import { sha256Digest } from '../src/security';

test('ready-node queue discovery refuses unfinished readiness checks before and after SQL', async () => {
  const scope = { tenantId: 'tenant:recovery', workspaceId: 'workspace:recovery' };
  for (const failureAt of [1, 2]) for (const value of ['promise', 'rejected', 'false'] as const) {
    let queries = 0, checks = 0, recoveries = 0;
    const db: DatabaseClient = {
      async query<T>() { queries++; return { rows: [] as T[] }; },
      async transaction(work) { return work(db); },
      async transactionWithPreCommitCheck(work, check) { const result = await work(db); await check(); return result; },
    };
    // Only the constructor's declared scope is needed. No planning call is made.
    const planner = { webOperation: () => scope } as unknown as TaskExecutionPlanner;
    const coordinator = new TaskAssignmentCoordinator(db, scope, planner, [], () => 0, [], undefined, {
      async enqueueInSession() { throw new Error('unexpected enqueue'); },
      async recoverUnsentInSession() { recoveries++; return true; },
    });
    const check = () => {
      if (++checks !== failureAt) return;
      if (value === 'promise') return Promise.resolve();
      if (value === 'rejected') return Promise.reject(new Error('synthetic stale readiness'));
      return false;
    };
    await assert.rejects(coordinator.recoverForReadyNode({ nodeId: 'node:fixture' }, new AbortController().signal, check));
    assert.equal(queries, failureAt - 1); assert.equal(recoveries, 0);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});

test('ready-node recovery rolls back transaction and audit when its final fence is unfinished', async t => {
  // Reuse one database across failures: each failed recovery must leave it unchanged.
  const f = await canonicalApprovalStorageFixture();
  t.after(f.close);
  await f.save();
  await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  await f.db.query('CREATE TABLE synthetic_ready_recovery(id int)');
  for (const value of ['promise', 'rejected', 'false', 'throw'] as const) {
    let staged = false;
    const coordinator = f.create(f.db, {
      async enqueueInSession() { throw new Error('unexpected enqueue'); },
      async recoverUnsentInSession(tx) {
        await tx.query('INSERT INTO synthetic_ready_recovery VALUES(1)');
        staged = true;
        return true;
      },
    });
    await assert.rejects(coordinator.recoverForReadyNode({ nodeId: f.route.nodeId }, f.abort.signal, () => {
      if (!staged) return;
      if (value === 'promise') return Promise.resolve();
      if (value === 'rejected') return Promise.reject(new Error('synthetic stale readiness'));
      if (value === 'false') return false;
      throw new Error('synthetic replaced readiness');
    }));
    assert.equal(staged, true);
    assert.equal((await f.db.query('SELECT * FROM synthetic_ready_recovery')).rows.length, 0);
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.queue.unsent_recovered'")).rows.length, 0);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const coordinator = f.create(f.db, {
    async enqueueInSession() { throw new Error('unexpected enqueue'); },
    async recoverUnsentInSession(tx) {
      await tx.query('INSERT INTO synthetic_ready_recovery VALUES(1)');
      return true;
    },
  });
  assert.deepEqual(await coordinator.recoverForReadyNode({ nodeId: f.route.nodeId }, f.abort.signal, () => {}),
    { examined: 1, recovered: 1, held: 0, truncated: false });
  assert.equal((await f.db.query('SELECT * FROM synthetic_ready_recovery')).rows.length, 1);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.queue.unsent_recovered'")).rows.length, 1);
});

test('queue recovery refuses once a route-neutral worker receipt exists', async t => {
  const f = await canonicalApprovalStorageFixture();
  t.after(f.close);
  await f.save();
  const queued = await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  await f.db.query(`INSERT INTO control_worker_delivery_receipts
    (tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
  [f.prepared.request.tenantId, f.prepared.request.projectId, f.prepared.request.jobId,
    f.prepared.request.attemptId, JSON.stringify({ schema: 'fixture-receipt' }), `hmac-sha256:${'0'.repeat(64)}`]);
  let recoveryCalls = 0;
  const coordinator = f.create(f.db, {
    async enqueueInSession() { throw new Error('unexpected enqueue'); },
    async recoverUnsentInSession() { recoveryCalls++; return true; },
  });
  const reference = { schema: 'control-room.native-task-submission/v1' as const,
    tenantId: f.prepared.request.tenantId, projectId: f.prepared.request.projectId,
    jobId: f.prepared.request.jobId, attemptId: f.prepared.request.attemptId,
    queueId: queued.queueId, inputDigest: f.prepared.inputDigest, packetDigest: queued.packetDigest };
  await assert.rejects(coordinator.recoverNeverStagedQueueDelivery(reference, f.abort.signal));
  assert.equal(recoveryCalls, 0);
});
