import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sha256Digest } from '../src/security/digest';
import { admitPaidRunV1, createPaidRunMemoryConsentStoreV1, derivePaidRunPinV1 } from '../src/usage/v1/paid-run-admission';
import { createPaidRunExecutorV1 } from '../src/usage/v1/paid-run-executor';
import { createPaidRunJournalLedgerV1 } from '../src/usage/v1/paid-run-ledger';
import { paidRunFixture, paidRunInput, paidRunCallId, paidRunFakeProfile, paidRunBarrier,
  paidRunAdmission, paidRunContext, paidRunPrice, paidRunNow, type PaidRunScriptV1 } from './helpers/paid-run-fake-provider';
const reason = (r: Awaited<ReturnType<ReturnType<typeof createPaidRunExecutorV1>['call']>>) => r.kind === 'refused' ? r.reason : r.kind;
const records = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

for (const [cap, expected] of [['5999999', 'cap_exhausted'], ['6000000', 'settled']] as const)
  test(`T3 public executor exact cap ${cap}`, async () => {
    const f = await paidRunFixture({ cap });
    try { assert.equal(reason(await f.executor.call(paidRunInput(1))), expected); assert.equal(f.fake.requests.length, expected === 'settled' ? 1 : 0); }
    finally { await f.close(); }
  });
test('T1 sequential exhaustion sends five and settles 13500000', async () => {
  const f = await paidRunFixture();
  try {
    for (let i = 0; i < 5; i++) assert.equal(reason(await f.executor.call(paidRunInput(i))), 'settled');
    assert.equal(reason(await f.executor.call(paidRunInput(5))), 'cap_exhausted');
    assert.equal(f.fake.requests.length, 5); assert.equal(f.executor.snapshot().settled, '13500000');
    const rows = await records(f.journal);
    for (const request of f.fake.requests) {
      const reserve = rows.findIndex(r => r.type === 'reserve' && r.callId === request.callId);
      const dispatch = rows.findIndex(r => r.type === 'dispatch' && r.callId === request.callId);
      assert.ok(reserve > 0 && dispatch > reserve);
      assert.equal(rows.slice(reserve, dispatch).some(r => ['stop', 'block'].includes(r.type)), false);
    }
  } finally { await f.close(); }
});
test('T2 retries are cumulative: four requests settle 14100000', async () => {
  const f = await paidRunFixture({ scripts: [{}, { failure: 'http_500' }, {}, {}] });
  try {
    for (let i = 0; i < 4; i++) assert.equal(reason(await f.executor.call(paidRunInput(i))), 'settled');
    assert.equal(reason(await f.executor.call(paidRunInput(4))), 'cap_exhausted');
    assert.equal(f.fake.requests.length, 4); assert.equal(f.executor.snapshot().settled, '14100000');
  } finally { await f.close(); }
});
test('T4 twenty callers: three durable winners, seventeen cap refusals', async () => {
  const hold = paidRunBarrier(), reached = paidRunBarrier(); let seen = 0;
  const f = await paidRunFixture({ scripts: Array.from({ length: 3 }, () => ({ hold: hold.promise })),
    onRequest: () => { if (++seen === 3) reached.release(); } });
  const jobs = Array.from({ length: 20 }, (_, i) => f.executor.call(paidRunInput(i)));
  try {
    await reached.promise;
    // Wait for all twenty reserves, without waiting for the held dispatched calls.
    await f.ledger.reserve({ callId: paidRunCallId(90), requestDigest: sha256Digest('barrier'),
      priceRowDigest: f.admission.pin.priceRowDigest, maxNanoUsd: '0', check() {} });
    assert.equal(f.executor.snapshot().reserved, '18000000');
    hold.release(); const results = await Promise.all(jobs);
    assert.equal(results.filter(r => reason(r) === 'cap_exhausted').length, 17);
    const winners = results.flatMap((r, i) => r.kind === 'settled' ? [paidRunCallId(i)] : []);
    assert.deepEqual(new Set(winners), new Set(f.fake.requests.map(r => r.callId)));
    assert.equal((await records(f.journal)).filter(r => r.type === 'reserve' && r.maxNanoUsd !== '0').length, 3);
    assert.equal(f.executor.snapshot().settled, '8100000');
  } finally { hold.release(); await Promise.allSettled(jobs); await f.close(); }
});
test('T4 separate maxConcurrent gate limits twenty callers to two', async () => {
  const hold = paidRunBarrier(), reached = paidRunBarrier(); let seen = 0;
  const f = await paidRunFixture({ cap: '60000000', profile: { ...paidRunFakeProfile, maxConcurrent: 2 },
    scripts: Array.from({ length: 20 }, () => ({ hold: hold.promise })), onRequest: () => { if (++seen === 2) reached.release(); } });
  const jobs = Array.from({ length: 20 }, (_, i) => f.executor.call(paidRunInput(i)));
  try { await reached.promise; hold.release(); await Promise.all(jobs); assert.equal(f.fake.highWater(), 2); }
  finally { hold.release(); await Promise.allSettled(jobs); await f.close(); }
});
test('T6 full identity replays and changed body/output/stream conflict', async () => {
  const f = await paidRunFixture();
  try {
    const input = paidRunInput(1); await f.executor.call(input);
    assert.equal(reason(await f.executor.call({ ...input, stream: false })), 'replay');
    for (const change of [{ body: new Uint8Array(999) }, { maxOutputTokens: 201 }, { stream: true }]) {
      const before = f.executor.snapshot(); assert.equal(reason(await f.executor.call({ ...input, ...change })), 'call_conflict');
      assert.deepEqual(f.executor.snapshot(), before);
    }
    assert.equal(f.fake.requests.length, 1);
  } finally { await f.close(); }
});
test('T6 private snapshot survives currentConfig wait and scalar mutation', async () => {
  const hold = paidRunBarrier(), entered = paidRunBarrier();
  const f = await paidRunFixture({ config: async () => { entered.release(); await hold.promise;
    return { providerVersion: 1, servedModelId: 'served/one', billingKind: 'token', priceRows: [paidRunPrice()] }; } });
  try {
    const input = { ...paidRunInput(1), stream: false }, original = Uint8Array.from(input.body);
    const job = f.executor.call(input); await entered.promise;
    input.body.fill(9); input.body = new Uint8Array(2000); input.maxOutputTokens = 900; input.stream = true; input.callId = paidRunCallId(2);
    hold.release(); assert.equal(reason(await job), 'settled');
    const request = f.fake.requests[0]!; assert.deepEqual(request.body, original);
    assert.equal(request.callId, paidRunCallId(1)); assert.equal(request.maxOutputTokens, 200); assert.equal(request.stream, false);
    const bodyDigest = `sha256:${createHash('sha256').update(original).digest('hex')}`;
    const reserve = (await records(f.journal)).find(r => r.type === 'reserve');
    assert.equal(reserve.requestDigest, sha256Digest({ schemaVersion: 1, bodyDigest, maxOutputTokens: 200, stream: false }));
  } finally { hold.release(); await f.close(); }
});
for (const [label, script, outcome] of [
  ['T10 different model', { servedModelId: 'other-model' }, 'identity_mismatch'],
  ['T10 missing model', { servedModelId: null }, 'identity_mismatch'],
  ['T11 missing usage', { usage: null }, 'usage_unverified'],
  ['T11 missing cached', { usage: { inputTokens: 400, cachedInputTokens: null, outputTokens: 100 } }, 'usage_unverified'],
  ['T11 invalid usage', { usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 100 } }, 'usage_unverified'],
  ['T14b separate reasoning', { usage: { inputTokens: 400, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 50 } }, 'usage_unverified'],
] as const) test(label, async () => {
  const f = await paidRunFixture({ scripts: [script] });
  try {
    const result = await f.executor.call(paidRunInput(1)); assert.equal(result.kind, 'settled');
    if (result.kind === 'settled') assert.equal(result.settlement.outcome, outcome);
    assert.equal(f.executor.snapshot().settled, '6000000');
    assert.equal(reason(await f.executor.call(paidRunInput(2))), 'run_blocked'); assert.equal(f.fake.requests.length, 1);
  } finally { await f.close(); }
});
for (const [mode, input, cached, output, charged, excess, blocked] of [
  ['subset', 900, 800, 100, '4200000', '0', false], ['additive', 400, 300, 100, '3600000', '0', false],
  ['additive', 900, 800, 100, '6000000', '600000', true], ['none', 1000, 0, 200, '6000000', '0', false],
  ['none', 2000, 0, 100, '6000000', '1500000', true], ['none', 400, 1, 100, '6000000', '0', true],
  ['subset', 400, 401, 100, '6000000', '0', true], ['additive', 700, 300, 200, '6000000', '0', false],
  ['subset', 1000, 1000, 200, '6000000', '0', false],
] as const) test(`T14b ${mode} settlement ${input}/${cached}/${output}`, async () => {
  const f = await paidRunFixture({ profile: { ...paidRunFakeProfile, cacheReporting: mode },
    scripts: [{ usage: { inputTokens: input, cachedInputTokens: cached, outputTokens: output } }] });
  try {
    const r = await f.executor.call(paidRunInput(1)); assert.equal(r.kind, 'settled');
    assert.equal(f.executor.snapshot().settled, charged); assert.equal(f.executor.snapshot().excess, excess);
    if (blocked) { assert.equal(reason(await f.executor.call(paidRunInput(2))), 'run_blocked'); assert.equal(f.fake.requests.length, 1); }
    else assert.equal(f.executor.snapshot().blocked, null);
  } finally { await f.close(); }
});
test('T12 enormous usage records exact excess without Number rounding', async () => {
  const f = await paidRunFixture({ scripts: [{ usage: { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 100 } }] });
  try {
    await f.executor.call(paidRunInput(1)); assert.equal(f.executor.snapshot().settled, '6000000');
    assert.equal(f.executor.snapshot().excess, '27021597764218473000'); assert.equal(f.executor.snapshot().blocked, 'bound_violated');
  } finally { await f.close(); }
});
for (const failure of ['reset_after_send', 'hang'] as const) test(`T13 uncertain ${failure} never refunds, replay never resends`, async () => {
  const f = await paidRunFixture({ profile: { ...paidRunFakeProfile, maxCallMs: 20 }, scripts: [{ failure }] });
  try {
    const input = paidRunInput(1), r = await f.executor.call(input); assert.equal(r.kind, 'settled');
    assert.equal(f.executor.snapshot().uncertain, '6000000'); assert.equal(reason(await f.executor.call(input)), 'replay');
    assert.equal(f.fake.requests.length, 1);
  } finally { await f.close(); }
});
test('T13 Stop durably aborts exactly two dispatched calls and closes spending', async () => {
  const reached = paidRunBarrier(); let seen = 0;
  const f = await paidRunFixture({ cap: '60000000', profile: { ...paidRunFakeProfile, maxConcurrent: 2 },
    scripts: [{ failure: 'hang' }, { failure: 'hang' }], onRequest: () => { if (++seen === 2) reached.release(); } });
  const jobs = [f.executor.call(paidRunInput(1)), f.executor.call(paidRunInput(2))];
  try {
    await reached.promise; const ack = await f.executor.stop('owner_stop'); await Promise.all(jobs);
    assert.deepEqual(new Set(ack.inFlightAtStop), new Set([paidRunCallId(1), paidRunCallId(2)]));
    assert.deepEqual(new Set(ack.uncertain), new Set(ack.inFlightAtStop)); assert.equal(ack.totals.uncertain, '12000000');
    assert.equal(reason(await f.executor.call(paidRunInput(3))), 'run_stopped'); assert.equal(f.fake.requests.length, 2); assert.equal(f.fake.active(), 0);
  } finally { await f.close(); }
});
test('T13 late response is information only after stop uncertainty', async () => {
  const hold = paidRunBarrier(), reached = paidRunBarrier();
  const f = await paidRunFixture({ scripts: [{ hold: hold.promise, ignoreAbort: true }], onRequest: () => reached.release() });
  const job = f.executor.call(paidRunInput(1));
  try {
    await reached.promise; await f.executor.stop('owner_stop'); await job; const before = f.executor.snapshot();
    hold.release(); await new Promise<void>(r => setImmediate(r));
    // Drain late journal append using the same mutex.
    await f.ledger.block('late_barrier');
    assert.equal(f.executor.snapshot().uncertain, before.uncertain); assert.equal(f.executor.snapshot().settled, '0');
    assert.equal((await records(f.journal)).some(r => r.type === 'late'), true);
  } finally { hold.release(); await f.close(); }
});
test('T14 final stream usage settles 2700000', async () => {
  const f = await paidRunFixture({ scripts: [{ failure: 'stream' }] });
  try { await f.executor.call({ ...paidRunInput(1), stream: true }); assert.equal(f.executor.snapshot().settled, '2700000'); }
  finally { await f.close(); }
});
test('T14 missing final usage blocks and charges max', async () => {
  const f = await paidRunFixture({ scripts: [{ failure: 'stream', usage: null }] });
  try { await f.executor.call({ ...paidRunInput(1), stream: true }); assert.equal(f.executor.snapshot().settled, '6000000'); assert.equal(f.executor.snapshot().blocked, 'usage_unverified'); }
  finally { await f.close(); }
});
test('T9 changed config blocks before reserve and send', async () => {
  const f = await paidRunFixture({ config: async () => ({ providerVersion: 2, servedModelId: 'served/one', billingKind: 'token', priceRows: [paidRunPrice()] }) });
  try { assert.equal(reason(await f.executor.call(paidRunInput(1))), 'config_changed'); assert.equal(f.fake.requests.length, 0);
    assert.equal((await records(f.journal)).filter(r => r.type === 'reserve').length, 0); }
  finally { await f.close(); }
});
test('T7 stale revalidation blocks before reserve and send', async () => {
  const f = await paidRunFixture({ clock: () => paidRunNow + 86_400_001 });
  try { assert.equal(reason(await f.executor.call(paidRunInput(1))), 'price_stale'); assert.equal(f.fake.requests.length, 0); }
  finally { await f.close(); }
});
test('T9 cloned admission cannot open actual ledger or executor', async () => {
  const f = await paidRunFixture();
  try {
    const forged = { ...f.admission };
    await assert.rejects(f.store.open(forged), /admission_forged/);
    assert.throws(() => createPaidRunExecutorV1({ admission: forged, ledger: f.ledger, transport: f.fake.transport,
      profile: paidRunFakeProfile, clock: () => paidRunNow, currentConfig: async () => { throw new Error('unreachable'); } }), /admission_forged/);
    assert.equal(f.fake.requests.length, 0);
  } finally { await f.close(); }
});
test('authority: one admission cannot open a second ledger root', async () => {
  const f = await paidRunFixture();
  try { await assert.rejects(createPaidRunJournalLedgerV1({ root: f.root + '-unused' }).open(f.admission), /admission_replayed/); }
  finally { await f.close(); }
});

for (const block of [false, true]) test(`T13b ${block ? 'block' : 'stop'} between reserve and dispatch releases without sending`, async () => {
  const held = paidRunBarrier(), entered = paidRunBarrier();
  const f = await paidRunFixture({ afterReserve: async id => { if (id === paidRunCallId(1)) { entered.release(); await held.promise; } },
    scripts: block ? [{ servedModelId: 'other-model' }] : [] });
  const pending = f.executor.call(paidRunInput(1));
  try {
    await entered.promise;
    if (block) await f.executor.call(paidRunInput(2));
    else {
      const ack = await f.executor.stop('owner_stop');
      assert.deepEqual(ack.inFlightAtStop, []); assert.deepEqual(ack.uncertain, []);
    }
    held.release(); assert.equal(reason(await pending), block ? 'run_blocked' : 'run_stopped');
    assert.equal(f.fake.requests.some(r => r.callId === paidRunCallId(1)), false);
    assert.equal(f.executor.snapshot().reserved, '0');
    assert.equal((await records(f.journal)).some(r => r.type === 'release' && r.callId === paidRunCallId(1)), true);
  } finally { held.release(); await pending; await f.close(); }
});
test('T6 private snapshot survives a held ledger reservation', async () => {
  const held = paidRunBarrier(), entered = paidRunBarrier();
  const f = await paidRunFixture({ afterReserve: async () => { entered.release(); await held.promise; } });
  const input = { ...paidRunInput(1), stream: false }, pending = f.executor.call(input);
  try {
    await entered.promise; input.body.fill(7); input.maxOutputTokens = 999; input.stream = true;
    held.release(); await pending;
    assert.deepEqual(f.fake.requests[0]!.body, new Uint8Array(1000));
    assert.equal(f.fake.requests[0]!.maxOutputTokens, 200); assert.equal(f.fake.requests[0]!.stream, false);
  } finally { held.release(); await pending; await f.close(); }
});
test('T15 unbounded profile and output/input/stream refuse with zero requests', async () => {
  for (const profile of [{ ...paidRunFakeProfile, enforcesMaxOutputTokens: false },
    { ...paidRunFakeProfile, extraBillableCategories: ['request_fee'] },
    { ...paidRunFakeProfile, streamUsageInFinalEvent: false }]) {
    const f = await paidRunFixture({ profile: profile as typeof paidRunFakeProfile });
    try { assert.equal(reason(await f.executor.call({ ...paidRunInput(1), stream: true })),
      profile.streamUsageInFinalEvent === false ? 'stream_unbounded' : 'unbounded_provider'); assert.equal(f.fake.requests.length, 0); }
    finally { await f.close(); }
  }
});
test('T12 enormous price bound refuses cap without dispatch', async () => {
  const f = await paidRunFixture({ context: paidRunContext({ prices: [paidRunPrice({ input: '999999999999999999999999999999000' })] }) });
  try { assert.equal(reason(await f.executor.call(paidRunInput(1))), 'cap_exhausted'); assert.equal(f.fake.requests.length, 0); }
  finally { await f.close(); }
});

test('structural dispatch is durable before independently observed send', async () => {
  let observedReserve = false, observedDispatch = false;
  const f = await paidRunFixture({ onRequest: id => {
    const rows = readFileSync(f.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    observedReserve = rows.some(r => r.type === 'reserve' && r.callId === id);
    observedDispatch = rows.some(r => r.type === 'dispatch' && r.callId === id);
  } });
  try { await f.executor.call(paidRunInput(1)); assert.equal(observedReserve, true); assert.equal(observedDispatch, true); }
  finally { await f.close(); }
});
test('T13 close leaves active resource types unchanged', async () => {
  await new Promise<void>(r => setImmediate(r));
  const before = process.getActiveResourcesInfo().sort();
  const f = await paidRunFixture({ profile: { ...paidRunFakeProfile, maxCallMs: 10 }, scripts: [{ failure: 'hang' }] });
  await f.executor.call(paidRunInput(1)); await f.close(); await new Promise<void>(r => setImmediate(r));
  assert.deepEqual(process.getActiveResourcesInfo().sort(), before);
});

test('T14 stream without any final event charges max as usage_unverified', async () => {
  const f = await paidRunFixture({ scripts: [{ events: { kind: 'stream', status: 200,
    events: (async function* () { yield { kind: 'data' as const, body: new Uint8Array([1]) }; })() } }] });
  try { await f.executor.call({ ...paidRunInput(1), stream: true }); assert.equal(f.executor.snapshot().settled, '6000000');
    assert.equal(f.executor.snapshot().blocked, 'usage_unverified'); }
  finally { await f.close(); }
});
test('T9 malformed revalidation snapshot blocks rather than throwing', async () => {
  const f = await paidRunFixture({ config: async () => ({ providerVersion: 1, servedModelId: 'served/one',
    billingKind: 'token', priceRows: [null] } as never) });
  try { assert.equal(reason(await f.executor.call(paidRunInput(1))), 'config_changed'); assert.equal(f.fake.requests.length, 0); }
  finally { await f.close(); }
});
test('T9 exact ledger admission binding and single executor ownership', async () => {
  const f = await paidRunFixture();
  try {
    assert.throws(() => createPaidRunExecutorV1({ admission: f.admission, ledger: f.ledger, transport: f.fake.transport,
      profile: paidRunFakeProfile, clock: () => paidRunNow, currentConfig: async () => { throw new Error('unreachable'); } }), /executor_already_bound/);
    const other = await paidRunAdmission(f.context);
    assert.equal(other.runKey, f.admission.runKey); assert.equal(other.pinDigest, f.admission.pinDigest);
    assert.notEqual(other.consentId, f.admission.consentId);
    assert.throws(() => createPaidRunExecutorV1({ admission: other, ledger: f.ledger, transport: f.fake.transport,
      profile: paidRunFakeProfile, clock: () => paidRunNow, currentConfig: async () => { throw new Error('unreachable'); } }), /cross_run/);
    assert.equal(f.fake.requests.length, 0);
  } finally { await f.close(); }
});

test('T9 authentic versus fabricated capabilities before actual ledger and send', async () => {
  const f = await paidRunFixture();
  const context = paidRunContext(), store = createPaidRunMemoryConsentStoreV1();
  const preview = derivePaidRunPinV1(context, '18000000');
  assert.equal(preview.kind, 'paid'); if (preview.kind !== 'paid') throw new Error('fixture_pin');
  const issued = await store.issue({ ...context, capNanoUsd: '18000000', pinDigest: preview.pinDigest });
  const consumed = await store.consumeOnce(issued.consentId, context);
  assert.equal(consumed.kind, 'consumed'); if (consumed.kind !== 'consumed') throw new Error('fixture_consent');
  let opened = 0;
  try {
    for (const candidate of [undefined, {}, { ...consumed.capability }, JSON.parse(JSON.stringify(consumed.capability)),
      Object.create(consumed.capability), issued, { ...context, pinDigest: preview.pinDigest, capNanoUsd: '18000000',
        consumedBy: { commandId: context.commandId, loopRunId: context.loopRunId } }]) {
      const result = admitPaidRunV1(context, candidate as typeof consumed.capability);
      if (result.kind === 'paid') { opened++; const unexpected = await f.store.open(result.admission); await unexpected.close(); }
      assert.deepEqual(result, { kind: 'refused', reason: 'consent_missing' });
    }
    assert.equal(opened, 0); assert.equal(f.fake.requests.length, 0);
    const admitted = admitPaidRunV1(context, consumed.capability);
    assert.equal(admitted.kind, 'paid'); if (admitted.kind !== 'paid') throw new Error('authentic_admission');
    const ledger = await f.store.open(admitted.admission);
    const executor = createPaidRunExecutorV1({ admission: admitted.admission, ledger, transport: f.fake.transport,
      profile: paidRunFakeProfile, clock: () => paidRunNow, currentConfig: async () => ({ providerVersion: 1,
        servedModelId: 'served/one', billingKind: 'token', priceRows: context.prices }) });
    try { assert.equal(reason(await executor.call(paidRunInput(1))), 'settled'); assert.equal(f.fake.requests.length, 1); }
    finally { await executor.stop('run_ended'); await ledger.close(); }
  } finally { await f.close(); }
});
