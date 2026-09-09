import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskAssignmentCoordinator } from '../src/web/v1/task-assignment-coordinator';
import type { TaskExecutionPlanner } from '../src/web/v1/task-execution-planner';
import type { DatabaseClient } from '../src/persistence/database';

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
