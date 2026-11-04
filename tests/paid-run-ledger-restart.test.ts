import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, readFile, appendFile, writeFile, chmod, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPaidRunJournalLedgerV1, recoverPaidRunLeaseV1, paidRunLedgerRootIdentityV1 } from '../src/usage/v1/paid-run-ledger';
import { createPaidRunExecutorV1 } from '../src/usage/v1/paid-run-executor';
import { paidRunAdmission, paidRunContext, paidRunFixture, paidRunInput, paidRunFakeProfile, paidRunNow } from './helpers/paid-run-fake-provider';
import { derivePaidRunPinV1, createPaidRunMemoryConsentStoreV1, admitPaidRunV1 } from '../src/usage/v1/paid-run-admission';
import { canonicalJson, sha256Digest } from '../src/security/digest';
type Checkpoint = { phase: string; requests: number; generation: string; runKey: string; pinDigest: string };
async function crash(point: string, beforeKill?: (root: string, checkpoint: Checkpoint) => Promise<void>, existingRoot?: string) {
  await mkdir(resolve('.test-tmp'), { recursive: true });
  const root = existingRoot ?? await mkdtemp(resolve('.test-tmp/paid-run-restart-'));
  // Trusted run-record expectation is derived in the parent without minting consent or admission.
  const context = paidRunContext(), pin = derivePaidRunPinV1(context, '18000000');
  assert.equal(pin.kind, 'paid'); if (pin.kind !== 'paid') throw new Error('trusted_pin');
  const expected = { runKey: sha256Digest([context.tenantId, context.loopRunId]), pinDigest: pin.pinDigest };
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  const child = fork(resolve('tests/helpers/paid-run-driver.ts'), [root, point], {
    execArgv: ['--import', 'tsx'], env: { ...env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = ''; child.stdout?.on('data', b => { output += b; }); child.stderr?.on('data', b => { output += b; });
  const exit = once(child, 'exit'); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const checkpoint = await Promise.race([
      once(child, 'message').then(([message]) => message as Checkpoint),
      exit.then(() => { throw new Error('driver exited before checkpoint: ' + output); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('driver checkpoint timeout: ' + output)), 20000); }),
    ]);
    assert.equal(checkpoint.phase, point); assert.equal(checkpoint.runKey, expected.runKey); assert.equal(checkpoint.pinDigest, expected.pinDigest);
    await assert.rejects(createPaidRunJournalLedgerV1({ root }).reopenForSettlementV1(expected), /lease_held/);
    await beforeKill?.(root, checkpoint);
    child.kill('SIGKILL');
    const [code, signal] = await exit; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    return { root, checkpoint, expected, journal: join(root, checkpoint.runKey, 'journal.jsonl') };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    await rm(root, { recursive: true, force: true }); throw error;
  } finally { clearTimeout(timer); }
}
for (const [point, settled, uncertain, requests] of [
  ['reserve', '0', '0', 0], ['dispatch', '0', '6000000', 1], ['settle', '2700000', '0', 1],
] as const) test(`T5 D17 SIGKILL after ${point}: retained accounting, no authority`, async () => {
  const f = await crash(point);
  try {
    const store = createPaidRunJournalLedgerV1({ root: f.root });
    await assert.rejects(store.reopenForSettlementV1(f.expected), /lease_held/);
    await assert.rejects(recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, 'wrong-generation'), /lease_generation_mismatch/);
    await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation);
    const h = await store.reopenForSettlementV1(f.expected);
    try {
      assert.equal(h.totals().settled, settled); assert.equal(h.totals().uncertain, uncertain);
      assert.equal(h.totals().reserved, '0'); assert.equal(h.totals().spendingClosed, true); assert.equal(f.checkpoint.requests, requests);
      assert.deepEqual(await h.call!(), { kind: 'refused', reason: 'run_recovered_closed' });
      assert.equal('reserve' in h, false); assert.equal('dispatch' in h, false); assert.equal('settle' in h, false);
      const fake = { sends: 0, async send() { this.sends++; throw new Error('must not send'); } };
      assert.throws(() => createPaidRunExecutorV1({ admission: {} as never, ledger: h as never, transport: fake,
        currentConfig: async () => { throw new Error('must not configure'); }, clock: () => paidRunNow, profile: paidRunFakeProfile }), /run_recovered_closed/);
      assert.equal(fake.sends, 0);
      await assert.rejects(store.reopenForSettlementV1(f.expected), /lease_held/);
      if (requests) {
        const before = h.totals();
        for (let i = 0; i < 2; i++) await h.recordLate(paidRunInput(1).callId, { servedModelId: 'served/one' });
        assert.deepEqual(h.totals(), before);
      }
      const rows = (await readFile(f.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(rows.filter(r => r.type === 'dispatch').length, requests);
      assert.equal(rows.some(r => r.type === 'recovered'), true);
    } finally { await h.close(); }
    // A second recovery has no mint/consent and cannot lower prior accounting.
    const reopened = await store.reopenForSettlementV1(f.expected);
    try { assert.equal(reopened.totals().settled, settled); assert.equal(reopened.totals().uncertain, uncertain); }
    finally { await reopened.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('T5 recovery rejects mismatched pin/run without changing journal', async () => {
  const f = await crash('dispatch');
  try {
    await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation);
    const before = await readFile(f.journal), store = createPaidRunJournalLedgerV1({ root: f.root });
    await assert.rejects(store.reopenForSettlementV1({ ...f.expected, pinDigest: sha256Digest('wrong-pin') }), /cross_run/);
    assert.deepEqual(await readFile(f.journal), before);
    const other = sha256Digest('wrong-run');
    await mkdir(join(f.root, other), { mode: 0o700 });
    await writeFile(join(f.root, other, 'journal.jsonl'), before, { mode: 0o600 });
    await writeFile(join(f.root, other, 'head.json'), await readFile(join(f.root, f.expected.runKey, 'head.json')), { mode: 0o600 });
    await assert.rejects(store.reopenForSettlementV1({ ...f.expected, runKey: other }), /cross_run/);
    const h = await store.reopenForSettlementV1(f.expected); await h.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
for (const tail of ['{"seq":', '{not-json}\n']) test(`T5 torn final tail ${JSON.stringify(tail)} recovers conservatively`, async () => {
  const f = await crash('dispatch');
  try {
    await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation); await appendFile(f.journal, tail);
    const h = await createPaidRunJournalLedgerV1({ root: f.root }).reopenForSettlementV1(f.expected);
    try { assert.equal(h.totals().uncertain, '6000000');
      assert.match(await readFile(f.journal, 'utf8'), /"tornTail":true/); }
    finally { await h.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
for (const mutation of ['middle-byte', 'middle-json', 'chain', 'semantic', 'null-record', 'infinite-number']) test(`T5 corrupt ${mutation} refuses without repair`, async () => {
  const f = await crash('dispatch');
  try {
    await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation);
    let text = await readFile(f.journal, 'utf8');
    if (mutation === 'middle-byte') text = text.replace('6000000', '6000001');
    if (mutation === 'middle-json') text = text.replace('"maxNanoUsd":', '"maxNanoUsd"!');
    if (mutation === 'null-record') text += 'null\n';
    if (mutation === 'infinite-number') text += '{"seq":1e999}\n';
    if (mutation === 'chain') text = text.replace('"seq":2', '"seq":3');
    if (mutation === 'semantic') {
      const lines = text.trim().split('\n'); const r = JSON.parse(lines[2]!); r.callId = 'missing_call_0001';
      // Last record has no following hash; semantic replay still refuses it.
      lines[2] = canonicalJson(r); text = lines.join('\n') + '\n';
    }
    await writeFile(f.journal, text);
    await assert.rejects(createPaidRunJournalLedgerV1({ root: f.root }).reopenForSettlementV1(f.expected), /journal_corrupt/);
    assert.equal(await readFile(f.journal, 'utf8'), text);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('owned-file journal rejects unsafe permissions and symlink', async () => {
  const f = await crash('settle');
  try {
    await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation);
    await chmod(f.journal, 0o644);
    const store = createPaidRunJournalLedgerV1({ root: f.root });
    await assert.rejects(store.reopenForSettlementV1(f.expected), /journal_unsafe/);
    const copy = await readFile(f.journal); await rm(f.journal); await writeFile(join(f.root, 'target'), copy, { mode: 0o600 });
    await symlink(join(f.root, 'target'), f.journal);
    await assert.rejects(store.reopenForSettlementV1(f.expected), /ELOOP/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('same-process lease also refuses a concurrent settlement opener', async () => {
  const f = await paidRunFixture();
  try { await assert.rejects(f.store.reopenForSettlementV1(f.admission), /lease_held/); }
  finally { await f.close(); }
});

test('normal admission open refuses fresh consent for a previously closed run', async () => {
  const f = await paidRunFixture();
  try {
    await f.executor.call(paidRunInput(1)); await f.executor.stop('run_ended'); await f.ledger.close();
    const fresh = await paidRunAdmission(f.context);
    assert.equal(fresh.runKey, f.admission.runKey); assert.equal(fresh.pinDigest, f.admission.pinDigest);
    assert.notEqual(fresh.consentId, f.admission.consentId);
    await assert.rejects(f.store.open(fresh), /cross_run/);
    const settlement = await f.store.reopenForSettlementV1(f.admission);
    try { assert.equal(settlement.totals().settled, '2700000'); assert.equal(settlement.totals().spendingClosed, true); }
    finally { await settlement.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const point of ['lock-window', 'journal-created']) test(`FIX ${point}: real SIGKILL retains recovery without spending`, async () => {
  const f = await crash(point);
  try {
    await assert.doesNotReject(recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation));
    const h = await createPaidRunJournalLedgerV1({ root: f.root }).reopenForSettlementV1(f.expected)
      .catch(error => assert.fail('initial journal must recover: ' + error.message));
    try {
      assert.equal(h.totals().settled, '0'); assert.equal(h.totals().uncertain, '0');
      assert.equal(h.totals().reserved, '0'); assert.equal(h.totals().spendingClosed, true);
      assert.deepEqual(await h.call!(), { kind: 'refused', reason: 'run_recovered_closed' });
      assert.equal('reserve' in h, false); assert.equal(f.checkpoint.requests, 0);
    } finally { await h.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('FIX live holder cannot lose its exact-generation lease before observed SIGKILL', async () => {
  const f = await crash('dispatch', async (root, checkpoint) => {
    const path = join(root, checkpoint.runKey, 'lease.json'), before = await readFile(path);
    await assert.rejects(recoverPaidRunLeaseV1(root, checkpoint.runKey, checkpoint.generation), /lease_owner_alive/);
    assert.deepEqual(await readFile(path), before);
  });
  try {
    await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation);
    const h = await createPaidRunJournalLedgerV1({ root: f.root }).reopenForSettlementV1(f.expected);
    try { assert.equal(h.totals().uncertain, '6000000'); assert.equal(h.totals().spendingClosed, true); }
    finally { await h.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
for (const mutation of ['opening-only', 'valid-rewrite']) test(`FIX content anchor rejects ${mutation} accounting rollback`, async () => {
  const f = await crash('settle');
  try {
    await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation);
    const lines = (await readFile(f.journal, 'utf8')).trim().split('\n');
    if (mutation === 'opening-only') lines.splice(1);
    else {
      const last = JSON.parse(lines.at(-1)!); last.settlement.accountedNanoUsd = '0'; lines[lines.length - 1] = canonicalJson(last);
    }
    const text = lines.join('\n') + '\n'; await writeFile(f.journal, text);
    await assert.rejects(createPaidRunJournalLedgerV1({ root: f.root }).reopenForSettlementV1(f.expected), /journal_corrupt/);
    assert.equal(await readFile(f.journal, 'utf8'), text);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('FIX fresh consent for same run cannot move its accounting to another root', async () => {
  const f = await paidRunFixture(), otherRoot = f.root + '-other';
  try {
    await f.executor.call(paidRunInput(1));
    const fresh = await paidRunAdmission(f.context);
    await assert.rejects(createPaidRunJournalLedgerV1({ root: otherRoot }).open(fresh), /ledger_root_mismatch/);
    assert.equal(f.executor.snapshot().settled, '2700000'); assert.equal(f.fake.requests.length, 1);
  } finally { await f.close(); await rm(otherRoot, { recursive: true, force: true }); }
});

for (const [point, settled, uncertain, requests] of [
  ['anchor-open', '0', '0', 0], ['anchor-dispatch', '0', '6000000', 0], ['anchor-settle', '2700000', '0', 1],
] as const) test(`FIX ${point}: killed write-ahead head conservatively materializes missing record`, async () => {
  const f = await crash(point);
  try {
    await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation);
    const h = await createPaidRunJournalLedgerV1({ root: f.root }).reopenForSettlementV1(f.expected);
    try {
      assert.equal(h.totals().settled, settled); assert.equal(h.totals().uncertain, uncertain);
      assert.equal(h.totals().reserved, '0'); assert.equal(h.totals().spendingClosed, true);
      assert.equal(f.checkpoint.requests, requests); assert.equal('reserve' in h, false);
    } finally { await h.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('FIX recovery-window: another SIGKILL while replay owns the opener is recoverable', async () => {
  const initial = await crash('dispatch');
  try {
    await recoverPaidRunLeaseV1(initial.root, initial.checkpoint.runKey, initial.checkpoint.generation);
    const f = await crash('recovery-window', undefined, initial.root);
    await assert.rejects(recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, initial.checkpoint.generation), /lease_generation_mismatch/);
    await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation);
    const h = await createPaidRunJournalLedgerV1({ root: f.root }).reopenForSettlementV1(f.expected);
    try { assert.equal(h.totals().uncertain, '6000000'); assert.equal(h.totals().reserved, '0');
      assert.equal(h.totals().spendingClosed, true); assert.equal('reserve' in h, false); }
    finally { await h.close(); }
  } finally { await rm(initial.root, { recursive: true, force: true }); }
});
test('FIX concurrent reapers and settlement openers keep one owner and full uncertainty', async () => {
  const f = await crash('dispatch');
  try {
    const reapers = await Promise.allSettled(Array.from({ length: 12 }, () =>
      recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation)));
    const recovered = reapers.filter(r => r.status === 'fulfilled').length;
    assert.ok(recovered <= 1, 'at most one concurrent reaper may remove the old generation');
    if (!recovered) await recoverPaidRunLeaseV1(f.root, f.checkpoint.runKey, f.checkpoint.generation);
    for (const r of reapers) if (r.status === 'rejected') assert.match(String(r.reason), /lease_held|ENOENT/);
    const store = createPaidRunJournalLedgerV1({ root: f.root });
    const openers = await Promise.allSettled(Array.from({ length: 12 }, () => store.reopenForSettlementV1(f.expected)));
    const owners = openers.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    try {
      assert.ok(owners.length <= 1, 'at most one settlement owner under contention');
      // Non-waiting contenders may all refuse while choosing. An uncontended retry must progress.
      if (!owners.length) owners.push(await store.reopenForSettlementV1(f.expected));
      assert.equal(owners.length, 1);
      for (const r of openers) if (r.status === 'rejected') assert.match(String(r.reason), /lease_held/);
      assert.equal(owners[0]!.totals().uncertain, '6000000'); assert.equal(owners[0]!.totals().spendingClosed, true);
      assert.equal('reserve' in owners[0]!, false);
    } finally { await Promise.all(owners.map(h => h.close())); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('FIX consent root identity survives no change and refuses missing or changed custody', async () => {
  const f = await paidRunFixture(), moved = f.root + '-moved';
  try {
    const unbound = await paidRunAdmission(paidRunContext());
    await assert.rejects(f.store.open(unbound), /ledger_root_mismatch/);
    const fresh = await paidRunAdmission(f.context);
    // Recreate the empty root at the same pathname after preserving the original ledger.
    await f.executor.stop('run_ended'); await f.ledger.close();
    const { rename } = await import('node:fs/promises'); await rename(f.root, moved); await mkdir(f.root, { mode: 0o700 });
    assert.notEqual(await paidRunLedgerRootIdentityV1(f.root), f.context.ledgerRootIdentity);
    await assert.rejects(createPaidRunJournalLedgerV1({ root: f.root }).open(fresh), /ledger_root_mismatch/);
  } finally { await f.executor.stop('run_ended'); await f.ledger.close();
    await rm(f.root, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }); }
});

test('FIX consent snapshots root custody and refuses a changed consume or admit context', async () => {
  const context = paidRunContext({ ledgerRootIdentity: 'sha256:' + '7'.repeat(64) });
  const preview = derivePaidRunPinV1(context, '18000000');
  assert.equal(preview.kind, 'paid'); if (preview.kind !== 'paid') throw new Error('trusted_pin');
  const store = createPaidRunMemoryConsentStoreV1(), input = { ...context, pinDigest: preview.pinDigest, capNanoUsd: '18000000' };
  const issued = await store.issue(input); input.ledgerRootIdentity = 'sha256:' + '8'.repeat(64);
  const changed = { ...context, ledgerRootIdentity: input.ledgerRootIdentity };
  assert.deepEqual(await store.consumeOnce(issued.consentId, changed), { kind: 'refused', reason: 'consent_mismatch' });
  const consumed = await store.consumeOnce(issued.consentId, context);
  assert.equal(consumed.kind, 'consumed'); if (consumed.kind !== 'consumed') throw new Error('trusted_consent');
  assert.deepEqual(admitPaidRunV1(changed, consumed.capability), { kind: 'refused', reason: 'consent_mismatch' });
  const admitted = admitPaidRunV1(context, consumed.capability);
  assert.equal(admitted.kind, 'paid'); if (admitted.kind === 'paid') assert.equal(admitted.admission.ledgerRootIdentity, context.ledgerRootIdentity);
});
