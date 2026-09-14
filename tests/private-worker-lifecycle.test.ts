import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePrivateCodexStatePathsV1 } from '../src/node-bridge/private-codex-configuration';
import { SqliteBridgeJournal } from '../src/node-bridge/journal';
import { createWorkerLifecycleFixture, projectSyntheticRecovery, recordSyntheticLifecycle,
  reopenSyntheticLifecycle, runSyntheticLauncherScenario, runSyntheticPrivateCodexRecovery,
  syntheticStartPair } from './helpers/private-worker-lifecycle';

async function owned(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'control-room-worker-test-')); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return createWorkerLifecycleFixture(root);
}

test('interruption and reopen preserve exact admitted identity without duplicate work', async t => {
  const f = await owned(t);
  assert.deepEqual(validatePrivateCodexStatePathsV1({ bridge: f.bridgePath, starts: f.startPath }),
    { bridge: f.bridgePath, starts: f.startPath });
  // Seed one delivery row to the bridge journal. The interrupt/reopen path
  // must not create a second delivery, a second turn or a second start. The
  // assertion below is what proves "no second delivery is created after
  // reopen", addressing the round-2 finding that this lifecycle was previously
  // exercised only against the starts journal, not against the durable bridge
  // journal where deliveries are recorded.
  const pair = syntheticStartPair();
  const seed = new SqliteBridgeJournal(f.bridgePath);
  (seed as unknown as { db: { prepare(sql: string): { run: (...args: unknown[]) => unknown } } }).db.prepare(
    `INSERT INTO bridge_codex_deliveries (queue_id,message_id,tenant_id,project_id,node_id,job_id,
       attempt_id,run_id,frame_json,frame_digest,receipt_json,receipt_digest)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(pair.admission.queueId, 'message:delivery:initial', 'tenant:synthetic', 'project:synthetic',
      'node:synthetic', pair.admission.scope.jobId, pair.admission.scope.attemptId,
      pair.admission.scope.runId, '{}', 'sha256:' + '0'.repeat(64), '{}',
      'sha256:' + '0'.repeat(64));
  seed.close();
  const interrupted = recordSyntheticLifecycle(f.startPath, 'thread');
  assert.equal(interrupted.status, 'thread_recorded_turn_unknown'); assert.equal(interrupted.turnId, null);
  assert.equal(interrupted.permitsRetry, false); assert.equal(interrupted.permitsResume, false);
  const reopened = reopenSyntheticLifecycle(f.startPath);
  assert.equal(reopened.status, interrupted.status); assert.equal(reopened.threadId, interrupted.threadId);
  assert.equal(reopened.readIdentity, null);
  // Reopen the bridge journal and confirm the seeded delivery row is intact
  // and no second delivery row was created by the interrupt/reopen cycle.
  const reopenedBridge = new SqliteBridgeJournal(f.bridgePath);
  const deliveryCount = ((reopenedBridge as unknown as { db: { prepare(sql: string):
    { get: (...args: unknown[]) => unknown } } }).db.prepare(
    `SELECT count(*) AS count FROM bridge_codex_deliveries WHERE queue_id=?`).get(
    pair.admission.queueId) as { count: number }).count;
  assert.equal(deliveryCount, 1,
    `bridge journal must hold exactly one delivery for the admitted run; got ${deliveryCount}`);
  reopenedBridge.close();
  const duplicate = recordSyntheticLifecycle(f.startPath, 'thread');
  assert.equal(duplicate.status, 'thread_recorded_turn_unknown');
});

test('completed durable identity reopens into read-only recovery with honest unknown usage', async t => {
  const f = await owned(t); recordSyntheticLifecycle(f.startPath, 'recorded');
  const observation = projectSyntheticRecovery(f.startPath, 'completed');
  assert.equal(observation.threadId, 'thread:lifecycle'); assert.equal(observation.turnId, 'turn:lifecycle');
  assert.equal(observation.status, 'completed'); assert.equal(observation.usage, 'unknown');
  assert.equal(observation.completionVerified, false); assert.equal(observation.grantsExecutionAuthority, false);
  const throughConfiguration = await runSyntheticPrivateCodexRecovery(f);
  assert.equal(throughConfiguration.observation.status, 'completed');
  assert.equal(throughConfiguration.observation.usage, 'unknown');
  assert.deepEqual({ acquisitions: throughConfiguration.acquisitions, closes: throughConfiguration.closes },
    { acquisitions: 1, closes: 1 });
});

test('revocation prevents new admission and retains an empty durable journal', async t => {
  const f = await owned(t);
  assert.throws(() => recordSyntheticLifecycle(f.startPath, 'reserved', true), /write_rejected/);
  assert.equal(reopenSyntheticLifecycle(f.startPath).status, 'not_reserved');
});

test('launcher cancellation, late acquisition and failed drain close only owned resources without retry', async () => {
  const completed = await runSyntheticLauncherScenario('completed');
  assert.deepEqual({ code: completed.code, runs: completed.runs, closes: completed.closes, acquisitions: completed.acquisitions },
    { code: 0, runs: 1, closes: 1, acquisitions: 1 });
  const revoked = await runSyntheticLauncherScenario('revoked');
  assert.deepEqual({ code: revoked.code, runs: revoked.runs, closes: revoked.closes }, { code: 1, runs: 1, closes: 1 });
  const late = await runSyntheticLauncherScenario('late-acquisition');
  assert.deepEqual({ code: late.code, runs: late.runs, closes: late.closes, acquisitions: late.acquisitions },
    { code: 1, runs: 0, closes: 1, acquisitions: 1 });
  const drain = await runSyntheticLauncherScenario('drain-failure');
  assert.deepEqual({ code: drain.code, runs: drain.runs, closes: drain.closes }, { code: 1, runs: 1, closes: 1 });
  assert.match(drain.errors.join(' '), /cleanup uncertain/i);
  const hermes = await runSyntheticLauncherScenario('hermes-completed');
  assert.deepEqual({ code: hermes.code, runs: hermes.runs, closes: hermes.closes }, { code: 0, runs: 1, closes: 1 });
  for (const result of [completed, revoked, late, drain, hermes]) {
    assert.equal(result.acquisitions, 1); assert.equal(result.journalStatus, 'thread_recorded_turn_unknown');
    assert.doesNotMatch(JSON.stringify(result), /synthetic_revoked|synthetic_drain_failed/);
  }
});
