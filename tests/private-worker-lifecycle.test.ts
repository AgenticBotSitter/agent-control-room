import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePrivateCodexStatePathsV1 } from '../src/node-bridge/private-codex-configuration';
import { SqliteBridgeJournal } from '../src/node-bridge/journal';
import { createWorkerLifecycleFixture, projectSyntheticRecovery, buildSyntheticCodexDelivery,
  recordSyntheticCodexDelivery, recordSyntheticLifecycle, reopenSyntheticLifecycle,
  runSyntheticLauncherScenario, runSyntheticPrivateCodexRecovery, syntheticStartPair }
  from './helpers/private-worker-lifecycle';

async function owned(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'control-room-worker-test-')); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return createWorkerLifecycleFixture(root);
}

test('interruption and reopen preserve exact admitted identity without duplicate work', async t => {
  const f = await owned(t);
  assert.deepEqual(validatePrivateCodexStatePathsV1({ bridge: f.bridgePath, starts: f.startPath }),
    { bridge: f.bridgePath, starts: f.startPath });
  const pair = syntheticStartPair();
  // Route the initial delivery through the production seam: a fully-signed
  // Codex dispatch frame, persisted via the bridge journal's
  // `recordCodexDelivery` (the same integrity gate the intake handler uses:
  // digest match, scope check, time window, no-update trigger).
  const recorded = recordSyntheticCodexDelivery(f.bridgePath);
  assert.equal(recorded.receipt.disposition, 'recorded');
  assert.equal(recorded.receipt.queueId, pair.admission.queueId);
  const interrupted = recordSyntheticLifecycle(f.startPath, 'thread');
  assert.equal(interrupted.status, 'thread_recorded_turn_unknown'); assert.equal(interrupted.turnId, null);
  assert.equal(interrupted.permitsRetry, false); assert.equal(interrupted.permitsResume, false);
  const reopened = reopenSyntheticLifecycle(f.startPath);
  assert.equal(reopened.status, interrupted.status); assert.equal(reopened.threadId, interrupted.threadId);
  assert.equal(reopened.readIdentity, null);
  // Re-open the bridge journal and confirm the persisted delivery row is
  // exactly one, no second delivery row was created by the interrupt/reopen
  // cycle, and the no-update / no-delete triggers still hold (a roundtrip
  // through the bridge seam must be the only thing that can write here).
  const reopenedBridge = new SqliteBridgeJournal(f.bridgePath);
  try {
    // Use the durable read path: acceptedCodexDelivery reconstructs the row
    // from its serialized frame + receipt and re-validates both digests, so
    // a single call proves (a) the row exists, (b) the frame/receipt are
    // uncorrupted, and (c) the journal accepted them on the original write.
    const accepted = reopenedBridge.acceptedCodexDelivery(pair.admission.queueId);
    assert.ok(accepted, 'bridge journal must hold the persisted delivery');
    assert.equal(accepted.frame.messageId, 'message:dispatch:lifecycle');
    assert.match(accepted.frame.body.queueId, /^native-queue:[0-9a-f]+$/);
    assert.equal(accepted.receipt.disposition, 'recorded');
    assert.equal(accepted.receipt.grantsExecutionAuthority, false);
    assert.equal(accepted.receipt.startsWork, false);
    assert.match(accepted.frame.bodyDigest, /^sha256:[0-9a-f]{64}$/);
    // The same delivery recorded again via the seam must be refused — this
    // is what proves the durable journal rejected the duplicate.
    const { frame, receipt } = buildSyntheticCodexDelivery('lifecycle');
    assert.throws(() => reopenedBridge.recordCodexDelivery(frame, receipt, () => {}),
      /codex_delivery_already_recorded/);
    // Re-load the durable inventory; the row count is unchanged after the
    // refused duplicate attempt. This is the assertion the round-3 review
    // asked for: the count is held by the bridge journal, not the starts
    // journal, and the duplicate went through the same seam.
    const acceptedCount = reopenedBridge.acceptedCodexDeliveryCount(pair.admission.queueId);
    assert.equal(acceptedCount, 1,
      `bridge journal must hold exactly one delivery for the admitted run; got ${acceptedCount}`);
    // Negative control: an unrelated queue id returns zero.
    assert.equal(reopenedBridge.acceptedCodexDeliveryCount('queue:not-yet-admitted'), 0);
  } finally { reopenedBridge.close(); }
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
