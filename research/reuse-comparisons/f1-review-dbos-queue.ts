import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Same short canonical-review phase as pg-boss, not an artificial durable wait.
export async function openDbosReviewQueue(root: string, pool: unknown, reconcile: () => Promise<object>) {
  const pkg = join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json');
  assert.equal(JSON.parse(await readFile(pkg, 'utf8')).version, '4.27.6');
  const require = createRequire(pkg), { DBOS } = require('./dist/src/dbos.js');
  const { ensureSystemDatabase } = require('./dist/src/system_database.js');
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  let callbacks = 0, sequence = 0;
  try {
    await ensureSystemDatabase('', logger, pool, 'comparison_dbos_review', false);
    DBOS.setConfig({ name: 'review-comparison', applicationVersion: 'fixture-v1', executorID: 'fixture-review',
      systemDatabasePool: pool, systemDatabaseSchemaName: 'comparison_dbos_review', runMigrations: false,
      runAdminServer: false, enableOTLP: false, tracingEnabled: false, otlpTracesEndpoints: [], otlpLogsEndpoints: [], logger,
      useListenNotify: false, listenQueues: ['review-phase'], maxConcurrentQueueDispatches: 1,
      systemDatabasePollingConcurrency: 1 });
    const workflow = DBOS.registerWorkflow(async (input: { probe: boolean }) => {
      callbacks++; return input.probe ? { probe: true } : reconcile();
    }, { name: 'canonical-review-phase', maxRecoveryAttempts: 1 });
    await DBOS.launch();
    await DBOS.registerQueue('review-phase', { globalConcurrency: 1, workerConcurrency: 1, minPollingIntervalMs: 50 });
    return {
      async phase(probe = false) {
        const id = `review-phase-${++sequence}`;
        const handle = await DBOS.startWorkflow(workflow, { workflowID: id, queueName: 'review-phase' })({ probe });
        return { id, output: await handle.getResult({ timeoutSeconds: 8, pollingIntervalMs: 50 }) };
      },
      callbacks: () => callbacks,
      close: () => DBOS.shutdown({ workflowCompletionTimeoutMS: 1000, deregister: true }),
    };
  } catch (error) {
    if (DBOS.isInitialized()) await DBOS.shutdown({ workflowCompletionTimeoutMS: 1000, deregister: true });
    throw error;
  }
}
