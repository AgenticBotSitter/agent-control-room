// Actual canonical review services on the runner's fresh PostgreSQL only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withNativeFixtureDatabase } from '../../tests/helpers/native-fixture-database.ts';
import { nativeQualityCompletionFixture } from '../../tests/helpers/native-quality-completion.ts';
import { TaskQualityCoordinator } from '../../src/web/v1/task-quality-coordinator.ts';
import { boundPrivateDatabase } from '../../src/web/v1/bounded-database.ts';
import { openReviewQueue } from './f1-review-queue.ts';
import { openDbosReviewQueue } from './f1-review-dbos-queue.ts';
const [root, socket] = process.argv.slice(2);
const candidate = process.argv[4] ?? 'pgboss';
assert.ok(['pgboss', 'dbos'].includes(candidate));
assert.match(root, /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
const { Pool } = createRequire(join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json'))('pg');
const pool = new Pool({ host: socket, port: 65433, user: 'f1_owner', database: 'postgres', password: '',
  max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
const database = boundPrivateDatabase({ async acquire() {
  const lease = await pool.connect();
  return { query: (sql, values) => lease.query(sql, values), release: () => lease.release() };
}, terminate: () => pool.end() });
let allocations = 0;
try {
  assert.equal((await pool.query('SHOW listen_addresses')).rows[0].listen_addresses, '');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
  await withNativeFixtureDatabase(async () => {
    // Additional trust/material helper fixtures are separate synthetic PGlite
    // databases. Only the first, main task/review fixture receives PostgreSQL.
    if (++allocations !== 1) return undefined;
    return { db: database.client, raw: { query: database.client.query.bind(database.client),
      exec: (sql: string) => pool.query(sql), close: async () => {} } };
  }, async () => {
    const x = await nativeQualityCompletionFixture();
    try {
      assert.equal(x.f.db, database.client, 'main canonical review must use actual PostgreSQL');
      const request = { ...x.request, projectId: x.registration.projectId, jobId: x.registration.jobId };
      const make = () => new TaskQualityCoordinator(x.f.db, x.f.scope,
        { ...x.f.ownerConfig, scenarios: [x.scenario] }, x.f.clock);
      const reconcile = () => make().reconcile(request, new AbortController().signal, () => {});
      const calls = structuredClone(x.local.calls), effects = x.local.effects.countFull();
      const queue = candidate === 'dbos' ? await openDbosReviewQueue(root, pool, reconcile)
        : await openReviewQueue((sql, values) => pool.query(sql, values), reconcile);
      try {
      const queued = await queue.phase();
      const pending = queued.output as Awaited<ReturnType<typeof reconcile>>;
      assert.equal(pending.disposition, 'waiting_review');
      assert.ok(pending.capacity); const states = await x.states(); assert.equal(states.lease.state, 'released');
      const recovered = await reconcile(); assert.equal(recovered.disposition, 'waiting_review');
      assert.ok(recovered.capacity?.replayed); assert.deepEqual(recovered.capacity.receipt, pending.capacity.receipt);
      assert.deepEqual(await x.states(), states);
      const probe = await queue.phase(true); assert.deepEqual(probe.output, { probe: true });
      assert.equal(queue.callbacks(), 2);
      const child = await promisify(execFile)(process.execPath,
        [fileURLToPath(new URL('./f1-review-readback.mjs', import.meta.url)), root, socket, candidate, queued.id],
        { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', NODE_ENV: 'test' }, timeout: 10000, maxBuffer: 65536 });
      const readback = JSON.parse(child.stdout);
      assert.equal(readback.readOnly, true); assert.equal(readback.id, queued.id);
      assert.deepEqual(readback.output, queued.output);
      assert.equal(queue.callbacks(), 2, 'read-only fresh client cannot re-execute a phase');
      assert.notEqual((await x.states()).job.state, 'succeeded', 'queue phase completion is not task completion');
      await x.review(); const done = await reconcile(); assert.equal(done.disposition, 'completed');
      const replay = await reconcile(); assert.equal(replay.disposition, 'completed');
      assert.ok(replay.completion?.replayed); assert.deepEqual(replay.completion.receipt, done.completion?.receipt);
      assert.deepEqual(x.local.calls, calls); assert.equal(x.local.effects.countFull(), effects);
      console.log(JSON.stringify({ backend: 'PostgreSQL18.4', canonicalAllocations: 1, supportingPgliteAllocations: allocations - 1,
        pendingReview: true, releasedCapacity: true, reconstructedExactReceipts: true, additionalNativeCalls: 0,
        queue: candidate === 'dbos' ? 'DBOS4.27.6' : 'pg-boss12.30.0', sameDatabase: true, queueConcurrency: 1, independentProbeWhileReviewPending: true,
        freshProcessExactResultRead: true,
        limitations: ['synthetic transport and owner review', 'fixture owner role, not production roles',
          'object reconstruction, not process restart', 'queue admission atomicity and DBOS/Hatchet parity not tested here'] }));
      } finally { await queue.close(); }
    } finally { await x.close(); }
  });
} finally { await database.close(); }
