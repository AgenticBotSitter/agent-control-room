// Research-only actual pg-boss review-phase seam; caller supplies disposable SQL.
import assert from 'node:assert/strict';
import { PgBoss, getConstructionPlans } from 'pg-boss';
import { setTimeout as delay } from 'node:timers/promises';

export async function openReviewQueue(query: (sql: string, values?: unknown[]) => Promise<{ rows: object[] }>,
  reconcile: () => Promise<object>) {
  const schema = 'comparison_review_queue', name = 'review-phase';
  const boss = new PgBoss({ schema, db: { executeSql: query }, migrate: false,
    supervise: false, schedule: false, useListenNotify: false });
  const errors: string[] = [];
  boss.on('error', error => errors.push(error.message));
  let callbacks = 0;
  try {
    await query(getConstructionPlans(schema)); await boss.start();
    await boss.createQueue(name, { policy: 'standard', retryLimit: 0, partition: false, notify: false });
    await boss.work<{ probe: boolean }>(name, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 0.5 }, async jobs => {
      assert.equal(jobs.length, 1); callbacks++;
      return jobs[0].data.probe ? { probe: true } : reconcile();
    });
    return {
      async phase(probe = false) {
        const id = await boss.send(name, { probe }, { retryLimit: 0 }); assert.ok(id);
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const job = await boss.getJobById(name, id);
          if (job?.state === 'completed') return { id, output: job.output };
          assert.notEqual(job?.state, 'failed'); await delay(50);
        }
        throw new Error('review queue observation deadline');
      },
      callbacks: () => callbacks,
      async close() { await boss.stop({ graceful: true, timeout: 1000, close: false }); assert.deepEqual(errors, []); },
    };
  } catch (error) { await boss.stop({ graceful: true, timeout: 1000, close: false }); throw error; }
}
