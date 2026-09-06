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
import { nativeEnvelopeSession } from '../../tests/helpers/native-envelope-session.ts';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.CR_REUSE_EVAL_ROOT;
assert.ok(root && isAbsolute(root), 'Explicit existing acquisition root required');
const packageRoot = join(root, 'node_modules/pg-boss');
assert.equal(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version, spec.packageVersion);
const { PgBoss } = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
const enqueue = (f, coordinator = f.c) => coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
const count = async (f, table) => (await f.db.query(`SELECT * FROM ${table}`)).rows.length;
const audit = async f => (await f.db.query("SELECT * FROM audit_events WHERE action='native.task.queued'")).rows.length;
const reference = (f, receipt) => ({ schema: 'control-room.native-task-submission/v1', tenantId: f.scope.tenantId,
  projectId: receipt.projectId, jobId: receipt.jobId, attemptId: receipt.attemptId, queueId: receipt.queueId,
  inputDigest: f.args[3], packetDigest: sha256Digest(f.packet) });

async function fixture(t) {
  const f = await canonicalApprovalStorageFixture();
  let submission;
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
    if (submission) await submission.close(); await admin.stop({ graceful: false }); await f.close();
  });
  await admin.start(); await admin.createQueue(spec.name, { retryLimit: 0 });
  class ObservedPgBoss extends PgBoss { constructor(options) { super(options); instances.push(this); } }
  submission = await preparePgBossNativeTaskSubmission(ObservedPgBoss, f.db, { backend: 'pglite' });
  return { ...f, admin, submission, client: instances[0], errors, c: f.create(f.db, submission),
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

test('actual owned runtime reaches canonical staging and transmission once; absent receipt stays unresolved', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  const receipt = await enqueue(f), ref = reference(f, receipt), id = nativeTaskSubmissionId(ref);
  const session = await nativeEnvelopeSession(f); t.after(session.close);
  let calls = 0;
  const worker = await f.startWorker(async (value, signal) => {
    calls++; assert.deepEqual(value, ref);
    // Test-only composition supplies this synthetic verified owner identity. Production
    // must resolve current authorization; serialized web credentials are never queued.
    await f.c.stageQueuedNativeDelivery(f.args[0], value.projectId, value.jobId, value.inputDigest,
      value.packetDigest, session.session, signal, value.attemptId);
    const sent = await f.c.transmitQueuedNativeDelivery(f.args[0], value.projectId, value.jobId,
      value.inputDigest, value.packetDigest, session.session, signal, value.attemptId);
    assert.equal(sent.deliveryConfirmed, false);
    throw new Error('synthetic-awaiting-authenticated-receipt');
  });
  const result = await settled(f, id);
  assert.equal(result.state, 'failed'); assert.equal(result.retryCount, 0);
  assert.equal(await count(f, 'control_native_transmission_intents'), 1);
  assert.equal(await count(f, 'control_native_delivery_receipts'), 0);
  assert.equal(session.sent.filter(raw => JSON.parse(raw).type === 'harness.native.dispatch').length, 1);
  assert.equal((await enqueue(f)).replayed, true);
  await delay(1100); assert.equal(calls, 1);
  await worker.close(); assert.deepEqual(f.errors, []);
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
      await f.c.stageQueuedNativeDelivery(f.args[0], value.projectId, value.jobId, value.inputDigest,
        value.packetDigest, session.session, signal, value.attemptId);
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

test('coordinator role can submit with exact queue grants; private web role remains excluded', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.save();
  await f.raw.exec(await readFile('db/roles/task_coordinator_roles.sql', 'utf8'));
  await f.raw.exec(await readFile('db/roles/private_web_roles.sql', 'utf8'));
  await f.raw.exec(`GRANT USAGE ON SCHEMA control_room_queue TO control_room_task_coordinator;
    GRANT SELECT ON control_room_queue.version,control_room_queue.queue TO control_room_task_coordinator;
    GRANT UPDATE(name) ON control_room_queue.queue TO control_room_task_coordinator;
    GRANT SELECT,INSERT ON control_room_queue.job,control_room_queue.job_common TO control_room_task_coordinator;`);
  await f.raw.exec('SET ROLE control_room_task_coordinator');
  try { assert.equal((await enqueue(f)).replayed, false); }
  finally { await f.raw.exec('RESET ROLE'); }
  await f.raw.exec('SET ROLE control_room_private_web');
  try { await assert.rejects(f.db.query('SELECT * FROM control_room_queue.job_common')); }
  finally { await f.raw.exec('RESET ROLE'); }
  assert.equal((await f.admin.fetch(spec.name)).length, 1);
});
