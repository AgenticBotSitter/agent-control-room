// Research seam: actual canonical review/capacity services; one disposable PGlite
// database and synthetic native transport. Not a queue or process-crash test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { taskQualityCoordinatorFixture } from '../../tests/helpers/task-quality-coordinator.ts';
import { TaskQualityCoordinator } from '../../src/web/v1/task-quality-coordinator.ts';

test('canonical pending-review lineage survives coordinator reconstruction without another delivery', async t => {
  const x = await taskQualityCoordinatorFixture();
  t.after(x.close);
  const calls = structuredClone(x.local.calls);
  const effects = x.local.effects.countFull();
  const first = await x.reconcile();
  assert.equal(first.disposition, 'waiting_review');
  assert.ok(first.capacity);
  const retained = await x.states();
  assert.equal(retained.lease.state, 'released');
  assert.notEqual(retained.job.state, 'succeeded');
  const reconstruct = () => new TaskQualityCoordinator(x.f.db, x.f.scope,
    { ...x.f.ownerConfig, scenarios: [x.scenario] }, x.f.clock);
  const recovered = await reconstruct().reconcile(x.request, new AbortController().signal, () => {});
  assert.equal(recovered.disposition, 'waiting_review');
  assert.equal(recovered.verification, 'replayed');
  assert.ok(recovered.capacity?.replayed);
  assert.deepEqual(recovered.capacity.receipt, first.capacity.receipt);
  assert.deepEqual(await x.states(), retained);
  await x.ownerReview();
  const completed = await reconstruct().reconcile(x.request, new AbortController().signal, () => {});
  assert.equal(completed.disposition, 'completed');
  assert.equal(completed.completion?.receipt.jobId, x.request.jobId);
  assert.equal(completed.completion?.receipt.runId, x.request.runId);
  const replay = await reconstruct().reconcile(x.request, new AbortController().signal, () => {});
  assert.equal(replay.disposition, 'completed');
  assert.ok(replay.completion?.replayed);
  assert.deepEqual(replay.completion.receipt, completed.completion?.receipt);
  assert.deepEqual(x.local.calls, calls);
  assert.equal(x.local.effects.countFull(), effects);
});
