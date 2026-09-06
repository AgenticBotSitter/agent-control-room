// Actual-package, opt-in local test. No native PostgreSQL/server/provider is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalApprovalStorageFixture } from '../../tests/helpers/canonical-approval-storage.ts';
import { preparePgBossNativeTaskSubmission, nativeTaskSubmissionId, PG_BOSS_NATIVE_SUBMISSION as spec } from '../../src/persistence/pg-boss-native-task-submission.ts';
import { sha256Digest } from '../../src/security/index.ts';
import { startPgBossNativeTaskRuntime } from '../../src/persistence/pg-boss-native-task-runtime.ts';
import { createTaskCoordinatorLifecycle } from '../../src/web/v1/task-coordinator-lifecycle.ts';
import { enrollment } from '../../tests/hermes-native-fixture.ts';
import { verifyPgBossApplicationPermissions } from '../../src/persistence/pg-boss-application-permissions.ts';
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase } from '../../src/web/v1/private-database-preflight.ts';
import { createPrivateTaskBootstrap } from '../../src/web/v1/private-task-startup.ts';
import { taskStartupFixture } from '../../tests/helpers/task-startup.ts';
import { WebSessionAuthority } from '../../src/web/v1/session-authority.ts';
import { nativeEnvelopeSession } from '../../tests/helpers/native-envelope-session.ts';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.CR_REUSE_EVAL_ROOT;
assert.ok(root && isAbsolute(root), 'Explicit existing acquisition root required');
const packageRoot = join(root, 'node_modules/pg-boss');
assert.equal(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version, spec.packageVersion);
const { PgBoss } = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
const enqueue = (f, coordinator) => coordinator ? coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal)
  : f.owner.submission.enqueue(...f.args, sha256Digest(f.packet), f.abort.signal);
const count = async (f, table) => (await f.db.query(`SELECT * FROM ${table}`)).rows.length;
const audit = async f => (await f.db.query("SELECT * FROM audit_events WHERE action='native.task.queued'")).rows.length;
const reference = (f, receipt) => ({ schema: 'control-room.native-task-submission/v1', tenantId: f.scope.tenantId,
  projectId: receipt.projectId, jobId: receipt.jobId, attemptId: receipt.attemptId, queueId: receipt.queueId,
  inputDigest: f.args[3], packetDigest: sha256Digest(f.packet) });

async function fixture(t) {
  const f = await canonicalApprovalStorageFixture();
  let submission, owner;
  const instances = [];
  const errors = [];
  const workers = [];
  const admin = new PgBoss({ db: { async executeSql(sql, values) {
    if (values?.length) return f.raw.query(sql, values);
    return (await f.raw.exec(sql)).at(-1) ?? { rows: [] };
  } }, schema: spec.schema, backend: 'pglite', schedule: false, supervise: false });
  admin.on('error', error => errors.push(error));
  t.after(async () => {
    await Promise.allSettled(workers.map(worker => worker.close()));
    if (owner) await owner.close();
    if (submission) await submission.close(); await admin.stop({ graceful: false }); await f.close();
  });
  await admin.start(); await admin.createQueue(spec.name, { retryLimit: 0 });
  class ObservedPgBoss extends PgBoss { constructor(options) { super(options); instances.push(this); } }
  submission = await preparePgBossNativeTaskSubmission(ObservedPgBoss, f.db, { backend: 'pglite' });
  owner = createTaskCoordinatorLifecycle({ scope: f.scope, planning: f.plannerConfig, routes: [f.route],
    database: { client: f.db, isAvailable: () => true, close: async () => {} }, clock: f.clock,
    approvals: { enrollments: [{ enrollment, nodeClass: 'personal-compute' }], store: f.store }, nativeSubmission: submission });
  return { ...f, admin, submission, owner, client: instances[0], errors, c: f.create(f.db, submission),
    async startWorker(deliver) {
      // Distinct logical worker SQL port over the same PGlite database. This tests
      // composition ownership, not real PostgreSQL role/pool isolation.
      let workerClosed = false;
      // Match existing application role preparation: migrations alone leave
      // public trigger functions executable by PUBLIC. The worker preflight
      // must reject that unprepared database rather than exempt those grants.
      await f.raw.exec(await readFile(new URL('../../db/roles/task_coordinator_roles.sql', import.meta.url), 'utf8'));
      await f.raw.exec(await readFile(new URL('../../db/roles/native_queue_worker_roles.sql', import.meta.url), 'utf8'));
      const runtime = await startPgBossNativeTaskRuntime(PgBoss, {
        async query(sql, values) {
          assert.equal(workerClosed, false);
          return f.raw.transaction(async tx => {
            await tx.exec('SET LOCAL ROLE control_room_native_queue_worker');
            return values?.length ? tx.query(sql, values) : (await tx.exec(sql)).at(-1) ?? { rows: [] };
          });
        }, async close() { workerClosed = true; },
      }, { backend: 'pglite', deliver });
      workers.push(runtime); return runtime;
    } };
}

async function settled(f, id) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await f.admin.getJobById(spec.name, id);
    if (['completed', 'failed', 'cancelled'].includes(value?.state)) return value;
    await delay(15);
  }
  assert.fail('Synthetic canonical worker observation timed out');
}

for (const failure of [null, 'audit', 'expiry', 'mismatch']) test(`canonical never-staged recovery and actual queue transaction: ${failure ?? 'commit and bounded replay'}`, async t => {
  const f = await fixture(t); await f.save();
  const receipt = await enqueue(f), ref = reference(f, receipt), id = nativeTaskSubmissionId(ref);
  await f.admin.fetch(spec.name); await f.admin.fail(spec.name, id, { reason: 'synthetic offline' });
  if (failure === 'mismatch') await f.db.query(`UPDATE ${spec.schema}.job SET data=$1 WHERE id=$2`, [{ ...ref, packetDigest: sha256Digest('wrong') }, id]);
  const before = await f.admin.getJobById(spec.name, id);
  let canonicalActive = false;
  // A separate fresh producer gives retry/update a cold metadata cache. Any
  // escaped package query would fail here instead of deadlocking the fixture.
  const recovery = await preparePgBossNativeTaskSubmission(PgBoss, { query(sql, values) {
    assert.equal(canonicalActive, false, 'recovery package query escaped canonical transaction');
    return f.db.query(sql, values);
  } }, { backend: 'pglite', recovery: true });
  t.after(recovery.close);
  const port = { enqueueInSession: recovery.enqueueInSession, async recoverUnsentInSession(tx, value, ordinal) {
    const result = await recovery.recoverUnsentInSession(tx, value, ordinal);
    if (failure === 'expiry') f.setNow(f.prepared.start.deadline);
    return result;
  } };
  const db = failure !== 'audit' ? f.db : { ...f.db,
    transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({ async query(sql, values) {
      if (sql.includes('INSERT INTO audit_events')) throw new Error('synthetic recovery audit failure');
      return tx.query(sql, values);
    } }), check) };
  const coordinator = f.create(db, port);
  const recover = async () => {
    canonicalActive = true;
    try { return await coordinator.recoverNeverStagedQueueDelivery(ref, f.abort.signal); }
    finally { canonicalActive = false; }
  };
  if (failure) {
    await assert.rejects(recover());
    assert.deepEqual(await f.admin.getJobById(spec.name, id), before);
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.queue.unsent_recovered'")).rows.length, 0);
    return;
  }
  for (const ordinal of [1, 2, 3]) {
    assert.deepEqual(await recover(), { recovered: true, ordinal });
    if (ordinal < 3) assert.deepEqual(await recover(), { recovered: false, ordinal: null });
    const jobs = await f.admin.fetch(spec.name, { includeMetadata: true });
    assert.equal(jobs.length, 1); assert.equal(jobs[0].id, id);
    assert.equal(jobs[0].retryLimit, 0); assert.equal(jobs[0].retryCount, ordinal);
    await f.admin.fail(spec.name, id, { reason: 'synthetic still offline' });
  }
  await assert.rejects(recover());
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.queue.unsent_recovered'")).rows.length, 3);
  assert.equal(await count(f, 'control_native_task_queue'), 1);
  assert.equal(await count(f, 'control_native_delivery_envelopes'), 0);
  assert.equal((await f.admin.fetch(spec.name)).length, 0);
});

test('actual owned runtime reaches canonical staging and transmission once; absent receipt stays unresolved', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  const receipt = await enqueue(f), ref = reference(f, receipt), id = nativeTaskSubmissionId(ref);
  const session = await nativeEnvelopeSession(f); t.after(session.close);
  await new WebSessionAuthority(f.db, f.scope, f.clock).logout(f.args[0]);
  const browserSessions = await count(f, 'control_web_sessions');
  let calls = 0;
  const worker = await f.startWorker(async (value, signal) => {
    calls++; assert.deepEqual(value, ref);
    await f.c.stageApprovedQueueDelivery(value, session.session, signal);
    const sent = await f.c.transmitApprovedQueueDelivery(value, session.session, signal);
    assert.equal(sent.deliveryConfirmed, false);
    throw new Error('synthetic-awaiting-authenticated-receipt');
  });
  const result = await settled(f, id);
  assert.equal(result.state, 'failed'); assert.equal(result.retryCount, 0);
  assert.equal(await count(f, 'control_native_transmission_intents'), 1);
  assert.equal(await count(f, 'control_native_delivery_receipts'), 0);
  assert.equal(session.sent.filter(raw => JSON.parse(raw).type === 'harness.native.dispatch').length, 1);
  await assert.rejects(enqueue(f), /authentication_required/);
  assert.equal(await count(f, 'control_web_sessions'), browserSessions, 'server delivery creates no browser session');
  await delay(1100); assert.equal(calls, 1);
  await worker.close(); assert.deepEqual(f.errors, []);
});

test('server delivery grant expiry after commit blocks transport and preserves unresolved intent', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.save();
  const ref = reference(f, await enqueue(f));
  const session = await nativeEnvelopeSession(f); t.after(session.close);
  await f.c.stageApprovedQueueDelivery(ref, session.session, f.abort.signal);
  const expiry = f.clock() + 1000;
  await f.db.query("UPDATE control_role_grants SET expires_at=$1 WHERE id='grant:test'", [new Date(expiry).toISOString()]);
  const db = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    const result = await f.db.transactionWithPreCommitCheck(work, check); f.setNow(expiry); return result;
  } };
  await assert.rejects(f.create(db, f.submission).transmitApprovedQueueDelivery(ref, session.session, f.abort.signal));
  assert.equal(await count(f, 'control_native_transmission_intents'), 1);
  assert.equal(session.sent.filter(raw => JSON.parse(raw).type === 'harness.native.dispatch').length, 0);
  await assert.rejects(f.c.transmitApprovedQueueDelivery(ref, session.session, f.abort.signal));
});

for (const mode of ['expired', 'owner-revoked', 'pins-closed', 'node-retired', 'project-completed', 'tampered-packet']) {
  test(`operational pickup cannot bypass canonical ${mode} approval`, { timeout: 30000 }, async t => {
    const f = await fixture(t); await f.save();
    const receipt = await enqueue(f), ref = reference(f, receipt), id = nativeTaskSubmissionId(ref);
    const session = await nativeEnvelopeSession(f); t.after(session.close);
    if (mode === 'expired') f.setNow(f.prepared.start.deadline);
    if (mode === 'owner-revoked') await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE tenant_id=$1", [f.scope.tenantId]);
    if (mode === 'pins-closed') f.approvals.close();
    if (mode === 'node-retired') await f.db.query("UPDATE control_node_keys SET state='retired' WHERE tenant_id=$1", [f.scope.tenantId]);
    if (mode === 'project-completed') await f.db.query("UPDATE control_manual_project_heads SET lifecycle='completed' WHERE tenant_id=$1", [f.scope.tenantId]);
    if (mode === 'tampered-packet') await f.raw.query('UPDATE control_room_queue.job SET data=$1 WHERE id=$2',
      [{ ...ref, packetDigest: sha256Digest('synthetic-wrong-packet') }, id]);
    const worker = await f.startWorker(async (value, signal) => {
      await f.c.stageApprovedQueueDelivery(value, session.session, signal);
      assert.fail('Canonical rejection should precede staging');
    });
    const result = await settled(f, id);
    assert.equal(result.state, 'failed'); assert.equal(result.retryCount, 0);
    assert.equal(await count(f, 'control_native_delivery_envelopes'), 0);
    assert.equal(await count(f, 'control_native_transmission_intents'), 0);
    assert.equal(session.sent.filter(raw => JSON.parse(raw).type === 'harness.native.dispatch').length, 0);
    await worker.close(); assert.deepEqual(f.errors, []);
  });
}

test('approved task, immutable intent, audit and actual pg-boss job commit together', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  const receipt = await enqueue(f), id = nativeTaskSubmissionId(reference(f, receipt));
  assert.equal(await count(f, 'control_native_task_queue'), 1); assert.equal(await audit(f), 1);
  const job = await f.admin.getJobById(spec.name, id);
  assert.deepEqual(job.data, reference(f, receipt)); assert.equal(job.retryLimit, 0);
  assert.equal(job.state, 'created');
  assert.equal(receipt.startsWork, false); assert.equal(receipt.grantsExecutionAuthority, false);
  assert.equal('enqueueNativeTask' in f.c.webOperation(), false);
  assert.equal((await enqueue(f)).replayed, true);
  const [picked] = await f.admin.fetch(spec.name); assert.equal(picked.id, id);
  assert.deepEqual(await f.admin.fetch(spec.name), []);
  await f.admin.complete(spec.name, id, { synthetic: 'accepted-result-placeholder' });
  await f.admin.deleteJob(spec.name, id);
  assert.equal((await enqueue(f)).replayed, true);
  assert.deepEqual(await f.admin.fetch(spec.name), [], 'Canonical replay must not resurrect pruned operational history');
  assert.equal(await audit(f), 1); assert.deepEqual(f.errors, []);
});

test('cold pg-boss cache reads stay inside the exact canonical transaction', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  // Real public library call evicts the private client cache. No fetch priming.
  await f.client.updateQueue(spec.name, { retryLimit: 0 });
  await enqueue(f);
  assert.equal((await f.admin.fetch(spec.name)).length, 1);
  assert.deepEqual(f.errors, []);
});

for (const mode of ['abort', 'expiry', 'revocation', 'after-send', 'audit']) {
  test(`failure rolls back actual pg-boss submission, canonical intent and audit: ${mode}`, { timeout: 30000 }, async t => {
    const f = await fixture(t); await f.save(); let submitted = false;
    const submission = { async enqueueInSession(tx, value) {
      await f.submission.enqueueInSession(tx, value); submitted = true;
      if (mode === 'abort') f.abort.abort();
      if (mode === 'expiry') f.setNow(f.prepared.start.deadline);
      if (mode === 'revocation') await f.native.revoke();
      if (mode === 'after-send') throw new Error('synthetic-after-send');
    } };
    const db = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
      async query(sql, values) {
        if (mode === 'audit' && /INSERT INTO audit_events/i.test(sql)) throw new Error('synthetic-audit-failure');
        return tx.query(sql, values);
      },
    }), check) };
    await assert.rejects(enqueue(f, f.create(db, submission)));
    assert.equal(submitted, true); assert.equal(await count(f, 'control_native_task_queue'), 0);
    assert.equal(await audit(f), 0); assert.deepEqual(await f.admin.fetch(spec.name), []);
    assert.deepEqual(f.errors, []);
  });
}

test('missing or mismatched approval never submits a job', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(enqueue(f)); await f.save();
  await assert.rejects(f.c.enqueueNativeTask(...f.args, sha256Digest('wrong-packet'), f.abort.signal));
  assert.deepEqual(await f.admin.fetch(spec.name), []); assert.equal(await audit(f), 0);
});

test('lost commit acknowledgement replays canonical identity without another send', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  const db = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    await f.db.transactionWithPreCommitCheck(work, check); throw new Error('synthetic-lost-ack');
  } };
  await assert.rejects(enqueue(f, f.create(db, f.submission)), /synthetic-lost-ack/);
  const receipt = await f.c.readNativeTaskQueue(...f.args); assert.ok(receipt);
  assert.equal((await enqueue(f)).replayed, true); assert.equal(await audit(f), 1);
  assert.equal((await f.admin.fetch(spec.name)).length, 1);
  assert.deepEqual(await f.admin.fetch(spec.name), []);
});

test('existing legacy intent is not silently backfilled when adapter is introduced', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  await enqueue(f, f.coordinator);
  assert.equal((await enqueue(f)).replayed, true);
  assert.deepEqual(await f.admin.fetch(spec.name), []);
});

test('unsafe queue reconfiguration denies new submission and rolls back intent', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  await f.admin.updateQueue(spec.name, { retryLimit: 2 });
  await assert.rejects(enqueue(f), /native_task_submission_unavailable/);
  assert.equal(await count(f, 'control_native_task_queue'), 0); assert.equal(await audit(f), 0);
  assert.deepEqual(await f.admin.fetch(spec.name), []);
});

test('preexisting operational collision is not accepted as a fresh canonical enqueue', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  let queueReference;
  const capture = { async enqueueInSession(_tx, value) { queueReference = value; throw new Error('capture-and-rollback'); } };
  await assert.rejects(enqueue(f, f.create(f.db, capture)), /capture-and-rollback/);
  const id = nativeTaskSubmissionId(queueReference);
  await f.admin.send(spec.name, { synthetic: 'orphan' }, { id });
  await assert.rejects(enqueue(f), /native_task_submission_unavailable/);
  assert.equal(await count(f, 'control_native_task_queue'), 0); assert.equal(await audit(f), 0);
  assert.deepEqual((await f.admin.getJobById(spec.name, id)).data, { synthetic: 'orphan' });
});

test('explicit startup prepares actual producer after database gates and closes it before the pool', { timeout: 30000 }, async t => {
  for (const mode of ['success', 'install', 'prepare', 'close', 'late']) await t.test(mode, async t => {
    const f = await fixture(t); await f.save();
    const host = await taskStartupFixture(f);
    await f.raw.exec(await readFile('db/roles/native_queue_producer_roles.sql', 'utf8'));
    let prepared = 0, closed = 0, releaseLate;
    const bootstrap = createPrivateTaskBootstrap({ clock: f.clock, openDatabase: host.openDatabase,
      install: () => { if (mode === 'install') throw new Error('synthetic install failure'); },
      prepareNativeSubmission: async db => {
        prepared++;
        if (mode === 'prepare') throw new Error('synthetic preparation failure');
        if (mode === 'late') return new Promise(resolve => { releaseLate = () => resolve({
          async enqueueInSession() { assert.fail('late producer must never be installed'); }, async close() { closed++; },
        }); });
        const producer = await preparePgBossNativeTaskSubmission(PgBoss, db, { backend: 'pglite' });
        return { enqueueInSession: producer.enqueueInSession, async close() {
          assert.equal(host.coordinator.closes(), 0); closed++; await producer.close();
          if (mode === 'close') throw new Error('synthetic close failure');
        } };
      } });
    const config = { ...host.config, coordinator: { ...host.config.coordinator, nativeQueue: true,
      approvals: { enrollments: [{ enrollment, nodeClass: 'personal-compute' }], store: f.store } } };
    if (mode === 'install') await assert.rejects(bootstrap.start(config), /prerequisites_failed/);
    else if (mode === 'prepare') await assert.rejects(bootstrap.start(config), /cleanup_uncertain/);
    else if (mode === 'late') {
      await assert.rejects(bootstrap.start(config), /cleanup_uncertain/);
      releaseLate(); await delay(10);
    }
    else {
      const runtime = await bootstrap.start(config);
      t.after(() => mode === 'close' ? assert.rejects(runtime.close(), /cleanup_uncertain/) : runtime.close());
      assert.equal((await runtime.submission.enqueue(...f.args, sha256Digest(f.packet), f.abort.signal)).replayed, false);
      if (mode === 'close') {
        await assert.rejects(runtime.close(), /cleanup_uncertain/); await assert.rejects(runtime.close(), /cleanup_uncertain/);
      } else { await runtime.close(); await runtime.close(); }
      await assert.rejects(runtime.submission.enqueue(...f.args, sha256Digest(f.packet), f.abort.signal), /unavailable/);
    }
    assert.equal(prepared, 1); assert.equal(closed, mode === 'prepare' ? 0 : 1);
    assert.equal(host.coordinator.closes(), 1); assert.equal(host.web.closes(), 1);
  });
});

test('upstream producer version check refuses incompatible versions without migrating', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const sql of ['UPDATE control_room_queue.version SET version=39', 'UPDATE control_room_queue.version SET version=41', 'DELETE FROM control_room_queue.version']) {
    await f.raw.exec(sql);
    const before = await f.raw.query('SELECT * FROM control_room_queue.version');
    await assert.rejects(preparePgBossNativeTaskSubmission(PgBoss, f.db, { backend: 'pglite' }), /native_task_submission_unavailable/);
    assert.deepEqual((await f.raw.query('SELECT * FROM control_room_queue.version')).rows, before.rows);
    assert.equal(await count(f, 'control_native_task_queue'), 0);
  }
});

test('recovery has exact column grants and canonical recovery works without table-wide queue UPDATE', async t => {
  const f = await fixture(t); await f.save();
  const receipt = await enqueue(f), ref = reference(f, receipt), id = nativeTaskSubmissionId(ref);
  await f.admin.fetch(spec.name); await f.admin.fail(spec.name, id, { reason: 'synthetic offline' });
  await f.raw.exec(await readFile('db/roles/task_coordinator_roles.sql', 'utf8'));
  await f.raw.exec(await readFile('db/roles/private_web_roles.sql', 'utf8'));
  await f.raw.exec(await readFile('db/roles/native_queue_producer_roles.sql', 'utf8'));
  const recovery = await preparePgBossNativeTaskSubmission(PgBoss, f.db, { backend: 'pglite', recovery: true });
  t.after(recovery.close);
  const coordinator = f.create(f.db, recovery);
  const asCoordinator = async work => {
    await f.raw.exec('SET ROLE control_room_task_coordinator');
    try { return await work(); } finally { await f.raw.exec('RESET ROLE'); }
  };
  await asCoordinator(async () => {
    await verifyPgBossApplicationPermissions(f.db, true);
    await assert.rejects(verifyPgBossApplicationPermissions(f.db, true, true));
    await assert.rejects(coordinator.recoverNeverStagedQueueDelivery(ref, f.abort.signal));
  });
  assert.equal((await f.admin.getJobById(spec.name, id)).state, 'failed');
  await f.raw.exec(await readFile('db/roles/native_queue_recovery_roles.sql', 'utf8'));
  await asCoordinator(async () => {
    await assert.rejects(verifyPgBossApplicationPermissions(f.db, true));
    await verifyPgBossApplicationPermissions(f.db, true, true);
    assert.deepEqual(await coordinator.recoverNeverStagedQueueDelivery(ref, f.abort.signal), { recovered: true, ordinal: 1 });
    for (const sql of ['UPDATE control_room_queue.job SET id=id', 'UPDATE control_room_queue.job SET retry_count=retry_count',
      'DELETE FROM control_room_queue.job', 'UPDATE control_room_queue.queue SET retry_limit=1']) await assert.rejects(f.db.query(sql));
  });
  assert.equal((await f.admin.getJobById(spec.name, id)).retryLimit, 0);
  await f.raw.exec(`CREATE ROLE recovery_coordinator_test LOGIN INHERIT;
    GRANT control_room_task_coordinator TO recovery_coordinator_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  const checked = { ...f.db, transaction: work => f.db.transaction(tx => work({ async query(sql, values) {
    const result = await tx.query(sql, values);
    // Known PGlite TEMP metadata limitation only; identity and ACL gates are real.
    if (sql.includes('AS database_temp')) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
    return result;
  } })) };
  const config = { host: '127.0.0.1', port: 5432, database: 'template1', username: 'recovery_coordinator_test', password: 'synthetic-only', majorVersion: 17 };
  const scope = { ...f.scope, ownerIdentityId: 'identity:test', issuer: f.accessTrust.issuer };
  await f.admin.fetch(spec.name); await f.admin.fail(spec.name, id, { reason: 'synthetic offline again' });
  await f.raw.exec('SET SESSION AUTHORIZATION recovery_coordinator_test');
  try {
    await assert.rejects(verifyTaskCoordinatorDatabase(checked, config, scope, f.clock(), { nativeQueue: true }));
    await verifyTaskCoordinatorDatabase(checked, config, scope, f.clock(), { nativeQueue: true, nativeQueueRecovery: true });
    assert.deepEqual(await coordinator.recoverNeverStagedQueueDelivery(ref, f.abort.signal), { recovered: true, ordinal: 2 });
  } finally { await f.raw.exec('SET SESSION AUTHORIZATION postgres'); }
  for (const [grant, revoke] of [
    ['GRANT UPDATE(id) ON control_room_queue.job TO control_room_task_coordinator', 'REVOKE UPDATE(id) ON control_room_queue.job FROM control_room_task_coordinator'],
    ['GRANT UPDATE ON control_room_queue.job_common TO control_room_task_coordinator', 'REVOKE UPDATE ON control_room_queue.job_common FROM control_room_task_coordinator'],
  ]) {
    await f.raw.exec(grant);
    await asCoordinator(() => assert.rejects(verifyPgBossApplicationPermissions(f.db, true, true)));
    await f.raw.exec(revoke);
    await f.raw.exec(await readFile('db/roles/native_queue_recovery_roles.sql', 'utf8'));
  }
  await f.raw.exec('REVOKE UPDATE(data) ON control_room_queue.job_common FROM control_room_task_coordinator');
  await asCoordinator(() => assert.rejects(verifyPgBossApplicationPermissions(f.db, true, true)));
  await f.raw.exec('SET ROLE control_room_private_web');
  try { await verifyPgBossApplicationPermissions(f.db, false); await assert.rejects(f.db.query('SELECT * FROM control_room_queue.job')); }
  finally { await f.raw.exec('RESET ROLE'); }
});

test('coordinator role can submit with exact queue grants; private web role remains excluded', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  await f.raw.exec(await readFile('db/roles/task_coordinator_roles.sql', 'utf8'));
  await f.raw.exec(await readFile('db/roles/private_web_roles.sql', 'utf8'));
  await f.raw.exec(await readFile('db/roles/native_queue_producer_roles.sql', 'utf8'));
  await f.raw.exec('SET ROLE control_room_task_coordinator');
  try { await verifyPgBossApplicationPermissions(f.db, true); assert.equal((await enqueue(f)).replayed, false); }
  finally { await f.raw.exec('RESET ROLE'); }
  await f.raw.exec('SET ROLE control_room_private_web');
  try { await verifyPgBossApplicationPermissions(f.db, false); await assert.rejects(f.db.query('SELECT * FROM control_room_queue.job_common')); }
  finally { await f.raw.exec('RESET ROLE'); }
  await f.raw.exec(`CREATE ROLE queue_coordinator_test LOGIN INHERIT;
    GRANT control_room_task_coordinator TO queue_coordinator_test;
    CREATE ROLE queue_web_test LOGIN INHERIT;
    GRANT control_room_private_web TO queue_web_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  // Existing PGlite limitation: TEMP metadata only is injected. All ACL, schema,
  // owner, session identity and role checks execute against actual catalogs.
  const checked = { ...f.db, transaction: work => f.db.transaction(tx => work({ async query(sql, values) {
    const result = await tx.query(sql, values);
    if (sql.includes('AS database_temp')) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
    return result;
  } })) };
  const scope = { ...f.scope, ownerIdentityId: 'identity:test', issuer: f.accessTrust.issuer };
  const config = { host: '127.0.0.1', port: 5432, database: 'template1', username: 'queue_coordinator_test', password: 'synthetic-only', majorVersion: 17 };
  await f.raw.exec('SET SESSION AUTHORIZATION queue_coordinator_test');
  try {
    await assert.rejects(verifyTaskCoordinatorDatabase(checked, config, scope, f.clock()), /preflight_failed/);
    await verifyTaskCoordinatorDatabase(checked, config, scope, f.clock(), { nativeQueue: true });
  } finally { await f.raw.exec('SET SESSION AUTHORIZATION postgres'); }
  for (const [change, restore] of [
    ['GRANT UPDATE(retry_limit) ON control_room_queue.queue TO control_room_task_coordinator', 'REVOKE UPDATE(retry_limit) ON control_room_queue.queue FROM control_room_task_coordinator'],
    ['REVOKE UPDATE(name) ON control_room_queue.queue FROM control_room_task_coordinator', 'GRANT UPDATE(name) ON control_room_queue.queue TO control_room_task_coordinator'],
    ['GRANT DELETE ON control_room_queue.job_common TO control_room_task_coordinator', 'REVOKE DELETE ON control_room_queue.job_common FROM control_room_task_coordinator'],
    ['CREATE SCHEMA synthetic_unapproved', 'DROP SCHEMA synthetic_unapproved'],
  ]) {
    await f.raw.exec(change); await f.raw.exec('SET SESSION AUTHORIZATION queue_coordinator_test');
    try { await assert.rejects(verifyTaskCoordinatorDatabase(checked, config, scope, f.clock(), { nativeQueue: true }), /preflight_failed/); }
    finally { await f.raw.exec('SET SESSION AUTHORIZATION postgres'); await f.raw.exec(restore); }
  }
  await f.raw.exec('SET SESSION AUTHORIZATION queue_web_test');
  try { await verifyPrivateDatabase(checked, { ...config, username: 'queue_web_test' }, scope, f.clock(), { nativeQueue: true }); }
  finally { await f.raw.exec('SET SESSION AUTHORIZATION postgres'); }
  assert.equal((await f.admin.fetch(spec.name)).length, 1);
});
