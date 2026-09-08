import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reviewPrivateOwnerTask, printableOwnerValue } from '../scripts/review-private-owner-task.mjs';
import { canonicalApprovalStorageFixture } from './helpers/canonical-approval-storage.ts';
import { nativeStartAuthorityFixture } from './helpers/native-start-authority.ts';
import { nativeHttpFixture } from './helpers/native-http.ts';
import { createNativeConnector } from '../src/node-bridge/native-connector.ts';
import { qualityText } from './helpers/native-quality-completion.ts';
import { sha256Digest } from '../src/security/index.ts';
import { nativeRunId } from './hermes-native-fixture.ts';

const release = process.env.CR_REUSE_COMPILED_OWNER_REVIEW === '1'
  ? await import('../dist-vps/server/ownerReview.js') : await import('../src/web/v1/private-owner-review.ts');
assert.equal(typeof release.createNativeOwnerReviewSession, 'function');
assert.equal(typeof release.verifyPrivateOwnerStoredReceipt, 'function');

async function fixture(t) {
  const f = await canonicalApprovalStorageFixture(); let ownsBase = true;
  t.after(async () => { if (ownsBase) await f.close(); });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-owner-review-command-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'owner.mjs'); await writeFile(path, '// injected synthetic test only', { mode: 0o600 });
  const key = f.packet.approval.body.approvalKeyId;
  let signs = 0, stores = 0, closes = 0, imports = 0, questions = 0, attached = true, consentShown = false;
  const reports = [], errors = [], signals = new EventEmitter();
  const prepared = { target: { projectId: f.args[1], jobId: f.args[2], inputDigest: f.args[3] },
    async load(target, signal) {
      assert.deepEqual(target, prepared.target); assert.equal(signal.aborted, false);
      const canonical = await f.coordinator.prepareNativeApproval(...f.args);
      return { input: { ...canonical, approvalKeyId: key, issuedAt: f.clock(), recoveryExpiresAt: canonical.start.deadline + 120_000,
        approvalNonce: 'synthetic-command-approval', recoveryNonce: 'synthetic-command-recovery' },
      assertCurrent() { if (signal.aborted) throw new Error('synthetic canceled source'); } };
    },
    signing: { publicKeySpki: Buffer.from(await f.approvals.resolveApprovalKey(key)).toString('base64url'),
      timeoutMs: 1000, clock: f.clock, assertKeyCurrent() { f.approvals.assertAvailable(); },
      async sign(bytes, signal) {
        assert.equal(signal.aborted, false); assert.equal(consentShown, true); signs++;
        return Buffer.from(f.sign(JSON.parse(Buffer.from(bytes).toString())).signature, 'base64url');
      },
    },
    async store(packet, signal) { assert.equal(signal.aborted, false); stores++; return f.save(packet); },
    async close() { closes++; },
  };
  const runtime = { signals, isAttached: () => attached, report: value => reports.push(value), reportError: value => errors.push(value),
    async loadRelease() { imports++; return release; }, async loadOperator() { return {
      schema: 'control-room.private-owner-review-configuration/v1', async createConfiguration() { return prepared; },
    }; },
    async question(prompt, signal) {
      questions++; assert.equal(signal.aborted, false); assert.equal(signs, 0); assert.equal(stores, 0);
      assert.ok(reports.some(line => line.startsWith('prompt: ')));
      assert.ok(reports.some(line => line.startsWith('recoveryExpiresAt: ')));
      consentShown = true; return prompt.match(/Type (APPROVE sha256:[a-f0-9]{64}) to sign/)[1];
    },
  };
  t.after(() => { assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0); });
  return { f, prepared, runtime, reports, errors, signals,
    transferBaseOwnership: () => { ownsBase = false; },
    detach: () => { attached = false; }, counts: () => ({ signs, stores, closes, imports, questions }),
    run: () => reviewPrivateOwnerTask(['--configuration', path], runtime) };
}

test('real help is inert; piped invocation cannot import configuration or release', async t => {
  const path = fileURLToPath(new URL('../scripts/review-private-owner-task.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0); assert.match(result.stdout, /Owner-attended only/);
  const x = await fixture(t); x.detach(); await assert.rejects(x.run(), /private_owner_terminal_required/);
  assert.deepEqual(x.counts(), { signs: 0, stores: 0, closes: 0, imports: 0, questions: 0 });
});

test('confirmed command packet drives the same canonical task through signed dispatch to pending review', async t => {
  const x = await fixture(t), store = x.prepared.store;
  let issuedPacket;
  x.prepared.store = async (packet, signal) => {
    const receipt = await store(packet, signal); issuedPacket = structuredClone(packet); return receipt;
  };
  assert.equal(await x.run(), 0); assert.ok(issuedPacket);
  assert.equal(await x.f.count(), 1);
  assert.equal((await x.f.db.query('SELECT 1 FROM control_native_task_queue')).rows.length, 0);
  // Continue with the actual command-produced pair. Preserve the fixture's stable
  // packet object, which downstream setup reads; do not create a second signature.
  Object.assign(x.f.packet, issuedPacket);
  const local = await nativeStartAuthorityFixture(undefined, x.f.prepared.enrollment, x.f.assignmentFixture);
  // Nested helpers take ownership at entry and close partial acquisitions on failure.
  x.transferBaseOwnership();
  const pipeline = await nativeHttpFixture({ f: x.f, local, providerRunId: nativeRunId, resultText: qualityText });
  let connector;
  t.after(async () => { try { await connector?.close(); } finally { await pipeline.close(); } });
  const wire = pipeline.createClient(); let waits = 0;
  connector = createNativeConnector(pipeline.f.runtime, {
    async exchange(command, signal) {
      try { return await wire.client.exchange(command, signal); }
      finally { await pipeline.f.x.admin(async () => {}); }
    }, close: () => wire.client.close(),
  }, { maxCycles: 3, intervalMs: 1, timeoutMs: 60_000 }, {
    assertCurrent() {},
    async wait(_milliseconds, signal) {
      if (++waits === 1) {
        await pipeline.server.dispatch(pipeline.f.config.enrollment.nodeId, x.f.identity, pipeline.f.x.task, signal);
        await pipeline.f.x.admin(async () => {});
      } else {
        assert.equal(waits, 2); pipeline.f.advance(); pipeline.f.setResult(qualityText);
        await pipeline.f.x.admin(async () => {});
      }
    },
  });
  await pipeline.f.x.verify();
  assert.equal(pipeline.f.x.task.packetDigest, sha256Digest(issuedPacket));
  assert.equal(pipeline.f.x.task.jobId, x.prepared.target.jobId);
  assert.deepEqual(local.calls, []);
  const outcome = await pipeline.f.x.admin(() => connector.run('initial', new AbortController().signal));
  assert.equal(outcome.disposition, 'terminal'); assert.equal(outcome.state, 'completed');
  const counts = await pipeline.f.x.counts();
  assert.equal(counts.runs.length, 1); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.equal(counts.runs[0].job_id, x.prepared.target.jobId);
  assert.deepEqual(await x.f.config.storage.read(counts.artifacts[0].id), new TextEncoder().encode(qualityText));
  const target = await pipeline.f.x.admin(async () => {
    const rows = await x.f.db.query('SELECT plan FROM control_native_review_plans WHERE run_id=$1', [pipeline.f.x.registration.id]);
    assert.equal(rows.rows.length, 1); return rows.rows[0].plan.targetId;
  });
  const review = await pipeline.f.x.admin(() => x.f.reviewStore.snapshot(x.f.scope.tenantId, target));
  assert.equal(review.status, 'pending');
  assert.deepEqual(local.calls, ['capabilities', 'start', 'status']);
  assert.equal(x.counts().signs, 2); assert.equal(x.counts().stores, 1);
  assert.equal(await pipeline.f.x.admin(() => x.f.count()), 1);
});

test('same-task helper setup failure closes transferred base and native resources once', async t => {
  const x = await fixture(t);
  const local = await nativeStartAuthorityFixture(undefined, x.f.prepared.enrollment, x.f.assignmentFixture);
  let baseCloses = 0, localCloses = 0;
  const baseClose = x.f.close, localClose = local.close;
  x.f.close = async () => { baseCloses++; await baseClose(); };
  local.close = async () => { localCloses++; await localClose(); };
  // This fails after managed setup and outer bridge journal acquisition.
  x.f.save = async () => { throw new Error('synthetic post-managed-setup failure'); };
  x.transferBaseOwnership();
  await assert.rejects(nativeHttpFixture({ f: x.f, local, providerRunId: nativeRunId, resultText: qualityText }),
    /synthetic post-managed-setup failure/);
  assert.equal(baseCloses, 1); assert.equal(localCloses, 1);
});

test('injected owner confirmation shows full exact scope then real issuer stores once without dispatch', async t => {
  const x = await fixture(t); assert.equal(await x.run(), 0);
  assert.deepEqual(x.counts(), { signs: 2, stores: 1, closes: 1, imports: 1, questions: 1 });
  assert.equal(await x.f.count(), 1); assert.deepEqual(x.errors, []);
  assert.match(x.reports.at(-1), /packet stored/);
  assert.equal(x.reports.some(line => line.includes('"signature":')), false);
  assert.equal(x.reports.some(line => line.includes('credentialRef')), false);
});

test('decline, lost terminal and invalid current key never sign or store', async t => {
  for (const mode of ['decline', 'detach', 'key']) {
    const x = await fixture(t);
    const question = x.runtime.question;
    x.runtime.question = async (...args) => {
      const answer = await question(...args);
      if (mode === 'detach') x.detach();
      if (mode === 'key') x.f.approvals.close();
      return mode === 'decline' ? 'no' : answer;
    };
    assert.equal(await x.run(), mode === 'decline' ? 0 : 1);
    assert.equal(x.counts().signs, 0); assert.equal(x.counts().stores, 0); assert.equal(x.counts().closes, 1);
    assert.equal(await x.f.count(), 0);
  }
});

test('lost stored receipt and bad receipt never retry or claim confirmed storage', async t => {
  for (const mode of ['lost', 'wrong', 'attempt', 'authority']) {
    const x = await fixture(t), store = x.prepared.store;
    x.prepared.store = async (...args) => {
      const receipt = await store(...args);
      if (mode === 'lost') throw new Error('synthetic private diagnostics must not escape');
      if (mode === 'attempt') return { ...receipt, attemptId: 'attempt:other' };
      if (mode === 'authority') return { ...receipt, grantsExecutionAuthority: true };
      return { ...receipt, packetDigest: `sha256:${'a'.repeat(64)}` };
    };
    assert.equal(await x.run(), 1); assert.equal(x.counts().signs, 2); assert.equal(x.counts().stores, 1);
    assert.equal(await x.f.count(), 1, 'the unknown response does not undo the canonical commit');
    assert.doesNotMatch(x.reports.join('\n'), /packet stored\./); assert.doesNotMatch(x.errors.join('\n'), /private diagnostics/);
  }
});

test('quoted review text cannot inject terminal controls or bidi presentation', () => {
  const rendered = printableOwnerValue('\x1b[2J\nAPPROVE \u202e');
  assert.equal(rendered, '"\\u001b[2J\\nAPPROVE \\u{202e}"');
  assert.equal(rendered.includes('\x1b'), false); assert.equal(rendered.includes('\n'), false);
});

test('storage callback cannot mutate expected signed bytes; cancellation after commit stays uncertain', async t => {
  for (const mode of ['mutate', 'cancel']) {
    const x = await fixture(t), store = x.prepared.store;
    x.prepared.store = async (packet, signal) => {
      const receipt = await store(packet, signal);
      if (mode === 'mutate') packet.approval.body.jobId = 'job:changed-by-callback';
      else { x.signals.emit('SIGTERM'); assert.equal(signal.aborted, true); }
      return receipt;
    };
    assert.equal(await x.run(), mode === 'mutate' ? 0 : 1);
    assert.equal(x.counts().signs, 2); assert.equal(x.counts().stores, 1); assert.equal(x.counts().closes, 1);
    assert.equal(await x.f.count(), 1);
    if (mode === 'cancel') assert.doesNotMatch(x.reports.join('\n'), /packet stored\./);
  }
});

test('cleanup rejection prevents a clean-result claim even after canonical storage', async t => {
  const x = await fixture(t), close = x.prepared.close;
  x.prepared.close = async () => { await close(); throw new Error('synthetic private cleanup details'); };
  assert.equal(await x.run(), 1); assert.equal(x.counts().closes, 1); assert.equal(await x.f.count(), 1);
  assert.doesNotMatch(x.reports.join('\n'), /packet stored\./);
  assert.doesNotMatch(x.errors.join('\n'), /private cleanup details/);
});

test('cleanup timeout is uncertainty, not a claim the pending close stopped', async t => {
  const x = await fixture(t); let entered, finish;
  const closing = new Promise(resolve => { entered = resolve; });
  // Install the fake clock before both command and cleanup timers are created,
  // so cleanup cannot strand an earlier real timer behind a mocked clearTimeout.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  x.prepared.close = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const running = x.run(); await closing; t.mock.timers.tick(15_001);
  assert.equal(await running, 1); assert.equal(await x.f.count(), 1);
  assert.doesNotMatch(x.reports.join('\n'), /packet stored\./); finish();
});
