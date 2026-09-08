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

const release = process.env.CR_REUSE_COMPILED_OWNER_REVIEW === '1'
  ? await import('../dist-vps/server/ownerReview.js') : await import('../src/web/v1/private-owner-review.ts');
assert.equal(typeof release.createNativeOwnerReviewSession, 'function');
assert.equal(typeof release.verifyPrivateOwnerStoredReceipt, 'function');

async function fixture(t) {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close);
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
