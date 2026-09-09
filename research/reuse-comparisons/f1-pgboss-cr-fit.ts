// Actual CR queue adapters on actual PostgreSQL; delivery port is synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss, getConstructionPlans } from 'pg-boss';
import postgres from 'postgres';
import { createPostgresClient } from '../../src/persistence/database.ts';
import { boundPrivateDatabase } from '../../src/web/v1/bounded-database.ts';
import { preparePgBossNativeTaskSubmission, nativeTaskSubmissionId, PG_BOSS_NATIVE_SUBMISSION as spec } from '../../src/persistence/pg-boss-native-task-submission.ts';
import { startPgBossNativeTaskWorker } from '../../src/persistence/pg-boss-native-task-worker.ts';
import { sha256Digest } from '../../src/security/index.ts';
const [root, socket] = process.argv.slice(2);
const driver = process.argv[4] ?? 'postgres-js';
assert.ok(['postgres-js', 'node-pg', 'postgres-typed'].includes(driver));
assert.match(root, /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
assert.equal(process.cwd(), join(dirname(socket), 'empty'));
assert.deepEqual(await readdir(process.cwd()), []);
const require = createRequire(import.meta.url);
assert.equal(JSON.parse(await readFile(join(dirname(require.resolve('pg-boss')), '../package.json'), 'utf8')).version, '12.30.0');
const { Pool } = createRequire(join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json'))('pg');
const pool = new Pool({ host: socket, port: 65433, user: 'f1_owner', database: 'postgres', password: '',
  max: 3, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
Object.assign(process.env, { PGHOST: socket, PGPORT: '65433', PGUSER: 'f1_owner', PGDATABASE: 'postgres', PGPASSWORD: '' });
const nativePool = driver === 'node-pg' ? new Pool({ host: socket, port: 65433, user: 'f1_owner', database: 'postgres',
  password: '', max: 3, connectionTimeoutMillis: 3000, statement_timeout: 5000 }) : undefined;
const typedSql = driver === 'postgres-typed' ? postgres({host: socket, port: 65433,
  username: 'f1_owner', database: 'postgres', password: '', max: 3, connect_timeout: 3,
  prepare: false, fetch_types: true, max_pipeline: 1, connection: {statement_timeout: 5000}}) : undefined;
// Maintained native pg driver under the EXISTING production bounds. Research
// composition only, not replacement configuration/roles or termination proof.
const db = nativePool ? boundPrivateDatabase({
  async acquire() {
    const lease = await nativePool.connect();
    return { query: (sql, values) => lease.query(sql, values), release: () => lease.release() };
  },
  terminate: () => nativePool.end(),
}) : typedSql ? boundPrivateDatabase({
  async acquire() {
    const lease = await typedSql.reserve();
    return { async query<T>(statement: string, values: unknown[] = []) {
      const params = values.map(value => typeof value === 'string' ? typedSql.typed(value, 25) : value);
      const rows = await lease.unsafe(statement, params as never[], {prepare: false, simple: false});
      return {rows: rows as unknown as T[]};
    }, release: () => lease.release()};
  }, terminate: () => typedSql.end({timeout: 0}),
}) : createPostgresClient('');
const boss = new PgBoss({ schema: spec.schema, db: { executeSql: (sql, values) => pool.query(sql, values) },
  migrate: false, supervise: false, schedule: false, useListenNotify: false });
const errors: string[] = [], deliveries: string[] = [], outcomes: object[] = [];
const diagnostics: object[] = [];
// Read-only diagnostic wrapper: preserve candidate behavior and actual SQL errors
// before the application deliberately replaces them with a safe public error.
class ObservedPgBoss extends PgBoss {
  override async send(...args: Parameters<PgBoss['send']>) {
    try { const id = await super.send(...args); diagnostics.push({ operation: 'send', returnedId: id }); return id; }
    catch (error) { diagnostics.push({ operation: 'send', message: (error as Error).message }); throw error; }
  }
}
pool.on('error', (e: Error) => errors.push(e.message)); boss.on('error', (e: Error) => errors.push(e.message));
nativePool?.on('error', (e: Error) => errors.push(e.message));
let submission: Awaited<ReturnType<typeof preparePgBossNativeTaskSubmission>> | undefined;
let worker: Awaited<ReturnType<typeof startPgBossNativeTaskWorker>> | undefined;
const reference = (label: string) => {
  const ids = { tenantId: 'tenant:fixture', jobId: `job:${label}`, attemptId: `attempt:${label}` };
  return { schema: 'control-room.native-task-submission/v1' as const, ...ids, projectId: 'project:fixture',
    queueId: `native-queue:${sha256Digest(ids).slice(7)}`, inputDigest: sha256Digest('input'), packetDigest: sha256Digest('packet') };
};
const until = async (fn: () => Promise<boolean>, ms = 6000) => {
  const end = Date.now() + ms;
  do { if (await fn()) return; await delay(50); } while (Date.now() < end);
  throw new Error('bounded observation deadline');
};
try {
  assert.equal((await pool.query('SELECT to_regnamespace($1) AS present', [spec.schema])).rows[0].present, null);
  await pool.query(getConstructionPlans(spec.schema));
  await pool.query('CREATE TABLE comparison_marker (id text PRIMARY KEY)');
  await boss.start();
  await boss.createQueue(spec.name, { policy: 'standard', partition: false, retryLimit: 0, notify: false });
  submission = await preparePgBossNativeTaskSubmission(ObservedPgBoss, db.client);
  const rolled = reference('rolled-back');
  await assert.rejects(db.client.transactionWithPreCommitCheck(async tx => {
    await tx.query('INSERT INTO comparison_marker VALUES ($1)', ['rolled']);
    await submission!.enqueueInSession({ async query(sql, params) {
      try { const result = await tx.query(sql, params); diagnostics.push({ operation: sql.trim().split(/\s+/)[0], rows: result.rows.length }); return result; }
      catch (error) { diagnostics.push({ operation: 'sql-error', code: (error as { code?: string }).code, message: (error as Error).message }); throw error; }
    } }, rolled);
  }, () => { throw new Error('synthetic-revocation'); }), /synthetic-revocation/);
  assert.equal((await pool.query('SELECT * FROM comparison_marker')).rowCount, 0);
  assert.equal(await boss.getJobById(spec.name, nativeTaskSubmissionId(rolled)), null);
  outcomes.push({ name: 'actual-CR-precommit-rollback', markerRows: 0, queueJob: null });
  // This records synthetic dispositions; it is not an actual canonical admission,
  // approval check or provider invocation. The CR wrapper and queue are unchanged.
  worker = await startPgBossNativeTaskWorker(boss, { concurrency: 1, deliver: async ref => {
    deliveries.push(ref.jobId);
    return { disposition: ref.jobId === 'job:held' ? 'held' : 'delivered' };
  } });
  const held = reference('held'), next = reference('next');
  for (const ref of [held, next]) await db.client.transaction(async tx => {
    await tx.query('INSERT INTO comparison_marker VALUES ($1)', [ref.jobId]);
    await submission!.enqueueInSession(tx, ref);
  });
  for (const [ref, disposition] of [[held, 'held'], [next, 'delivered']] as const) {
    const id = nativeTaskSubmissionId(ref);
    await until(async () => (await boss.getJobById(spec.name, id))?.state === 'completed');
    assert.deepEqual((await boss.getJobById(spec.name, id))?.output, { disposition });
  }
  assert.deepEqual(deliveries, ['job:held', 'job:next']);
  outcomes.push({ name: 'actual-submission-to-CR-worker', concurrency: 1, heldThenDelivered: true, persistedOutputs: true });
  await assert.rejects(db.client.transaction(tx => submission!.enqueueInSession(tx, held)), /native_task_submission_unavailable/);
  assert.equal(deliveries.length, 2);
  outcomes.push({ name: 'fresh-intent-operational-collision-refused', noAdditionalDelivery: true });
  const badId = await boss.send(spec.name, { ...reference('malformed'), prompt: 'unexpected-field' }, { retryLimit: 0 }); assert.ok(badId);
  await until(async () => ['cancelled', 'failed'].includes((await boss.getJobById(spec.name, badId))?.state ?? ''));
  assert.equal(deliveries.length, 2);
  outcomes.push({ name: 'malformed-operational-job-refused', state: (await boss.getJobById(spec.name, badId))?.state, noDelivery: true });
  await worker.close(); worker = undefined;
  await submission.close(); submission = undefined;
  assert.deepEqual(errors.filter(error => error !== 'native_task_delivery_unresolved'), []);
  console.log(JSON.stringify({ candidate: 'pg-boss12.30.0', driver, backend: 'PostgreSQL18.4', outcomes, deliveries, errors,
    scope: 'actual CR SQL/submission/worker adapters; synthetic delivery port; no canonical approval, native effects, crash recovery or full task-quality journey' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ failed: true, message: (error as Error).message, outcomes, deliveries, errors, diagnostics })); process.exitCode = 1;
} finally {
  try { await worker?.close(); } finally {
    try { await submission?.close(); } finally {
      try { await boss.stop({ graceful: true, timeout: 1000, close: false }); }
      finally { try { await db.close(); } finally { await pool.end(); } }
    }
  }
}
