import assert from 'node:assert/strict';
import test from 'node:test';
import { paidCallBoundV1, paidUsageWithinBoundV1, assertBoundableProfileV1, rowsForIntervalV1,
  type PaidRunProviderProfileV1 } from '../src/usage/v1/paid-run-bound';
import { priceAtV1 } from '../src/web/v1/loop-provider-prices';
import { costForUsageV1 } from '../src/usage/v1/usage-cost';
import { paidRunFakeProfile, paidRunNow, paidRunPrice } from './helpers/paid-run-fake-provider';

const bound = (prices = [paidRunPrice()]) => paidCallBoundV1({ profile: paidRunFakeProfile,
  body: new Uint8Array(1000), maxOutputTokens: 200, providerId: 'provider-one', servedModelId: 'served/one', prices, now: paidRunNow });

test('T7 price older than 24 hours refuses before any call', () => {
  assert.deepEqual(bound([paidRunPrice({ checkedAt: new Date(paidRunNow - 86_400_001).toISOString() })]),
    { kind: 'refused', reason: 'price_stale' });
});

test('T7 exact 24-hour price boundary admits; missing or future checkedAt refuses', () => {
  assert.equal(bound([paidRunPrice({ checkedAt: new Date(paidRunNow - 86_400_000).toISOString() })]).kind, 'bounded');
  for (const checkedAt of ['invalid', new Date(paidRunNow + 1).toISOString()])
    assert.deepEqual(bound([paidRunPrice({ checkedAt })]), { kind: 'refused', reason: 'price_stale' });
});

test('T8 DST interval and clock skew use the peak rather than dispatch-only price', () => {
  const peak = paidRunPrice({ input: '6000', output: '30000', windowKey: 'peak',
    window: { tz: 'America/New_York', days: [0], start: '03:00', end: '04:00' } });
  for (const [now, maxCallMs, clockSkewMs, expected] of [
    ['2026-03-08T06:59:00Z', 120_000, 0, '12000000'],
    ['2026-03-08T06:00:00Z', 120_000, 0, '6000000'],
    ['2026-03-08T06:58:00Z', 60_000, 60_000, '12000000'],
    ['2026-03-08T06:58:00Z', 60_000, 0, '6000000'],
  ] as const) {
    const result = paidCallBoundV1({ profile: { ...paidRunFakeProfile, maxCallMs, clockSkewMs },
      body: new Uint8Array(1000), maxOutputTokens: 200, providerId: 'provider-one', servedModelId: 'served/one',
      prices: [paidRunPrice(), peak], now: Date.parse(now) });
    assert.equal(result.kind, 'bounded');
    if (result.kind === 'bounded') assert.equal(result.maxNanoUsd, expected);
  }
  assert.deepEqual(bound([peak]), { kind: 'refused', reason: 'price_unknown' });
});

test('T8 cache formatter agrees with priceAt at every swept instant across both DST transitions', () => {
  for (const center of ['2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z']) {
    const at = Date.parse(center);
    const rows = [paidRunPrice({ checkedAt: new Date(at - 3_600_000).toISOString() }), paidRunPrice({
      checkedAt: new Date(at - 3_600_000).toISOString(), input: '6000', windowKey: 'local',
      window: { tz: 'America/New_York', days: [0], start: '01:50', end: '03:05' } })];
    for (let delta = -16; delta <= 16; delta++) {
      const instant = at + delta * 60_000;
      const result = rowsForIntervalV1(rows, instant, instant, instant);
      assert.equal(result.kind, 'priced');
      if (result.kind === 'priced') assert.deepEqual(result.rows, [priceAtV1(rows, instant)]);
    }
    const start = at - 750_001, end = start + 1_500_000;
    const result = rowsForIntervalV1(rows, start, end, at);
    assert.equal(result.kind, 'priced');
    const instants = [start, end];
    for (let t = Math.ceil(start / 60_000) * 60_000; t < end; t += 60_000) instants.push(t);
    assert.equal(instants.length, 27, 'maximum interval uses 27 instants');
    if (result.kind === 'priced') assert.deepEqual(new Set(result.rows), new Set(instants.map(t => priceAtV1(rows, t))));
  }
});

test('T8 model/provider isolation ignores a cheaper active window from another pair', () => {
  const cheap = paidRunPrice({ input: '1', output: '1', windowKey: 'cheap',
    window: { tz: 'UTC', days: [0], start: '00:00', end: '23:59' } });
  for (const other of [{ ...cheap, model: 'served/other' }, { ...cheap, providerId: 'provider-other' }]) {
    const result = bound([other, paidRunPrice()]);
    assert.equal(result.kind, 'bounded');
    if (result.kind === 'bounded') assert.equal(result.maxNanoUsd, '6000000');
  }
});

test('T8 missing, unknown, non-USD or malformed prices refuse without assumed zeros', () => {
  for (const prices of [[], [paidRunPrice({ status: 'unknown' })], [paidRunPrice({ status: 'not_comparable' })],
    [paidRunPrice({ currency: 'EUR' })], [paidRunPrice({ input: null })], [paidRunPrice({ output: null })],
    [paidRunPrice({ input: '-1' })], [paidRunPrice({ input: '1.5' })], [paidRunPrice({ input: '01' })]])
    assert.deepEqual(bound(prices), { kind: 'refused', reason: 'price_unknown' });
  const result = bound([paidRunPrice({ input: '0', output: '0' })]);
  assert.equal(result.kind, 'bounded');
  if (result.kind === 'bounded') assert.equal(result.maxNanoUsd, '0', 'explicit known zero rates are valid');
});

test('T8 stale peak encountered only at interval endpoint still refuses', () => {
  const result = paidCallBoundV1({ profile: paidRunFakeProfile, body: new Uint8Array(1000), maxOutputTokens: 200,
    providerId: 'provider-one', servedModelId: 'served/one', now: Date.parse('2026-03-08T06:58:00Z'),
    prices: [paidRunPrice(), paidRunPrice({ input: '6000', output: '30000', windowKey: 'peak',
      checkedAt: '2026-03-07T06:57:59.999Z',
      window: { tz: 'America/New_York', days: [0], start: '03:00', end: '04:00' } })] });
  assert.deepEqual(result, { kind: 'refused', reason: 'price_stale' });
});

test('T12 huge rates remain exact BigInt rather than overflowing or rounding', () => {
  // USD/M 999999999999999999999999999999 -> nano/token *1000.
  const result = bound([paidRunPrice({ input: '999999999999999999999999999999000',
    output: '999999999999999999999999999999000' })]);
  assert.equal(result.kind, 'bounded');
  if (result.kind === 'bounded') assert.equal(result.maxNanoUsd, '1199999999999999999999999999998800000');
  // Cap admission/reservation is CAP-B; this pure bound must not convert money to Number.
});

for (const output of [0, -1, 1.5, 1_000_001, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
  test(`T12 output ${output} is unbounded`, () => {
    assert.deepEqual(paidCallBoundV1({ profile: paidRunFakeProfile, body: new Uint8Array(1000), maxOutputTokens: output,
      providerId: 'provider-one', servedModelId: 'served/one', prices: [paidRunPrice()], now: paidRunNow }),
    { kind: 'refused', reason: 'output_unbounded' });
  });
}

test('T12 body size, overhead and output boundaries are inclusive; shared bodies refuse', () => {
  const input = { profile: { ...paidRunFakeProfile, maxBodyBytes: 1000 }, body: new Uint8Array(1000), maxOutputTokens: 200,
    providerId: 'provider-one', servedModelId: 'served/one', prices: [paidRunPrice()], now: paidRunNow };
  assert.equal(paidCallBoundV1(input).kind, 'bounded');
  assert.deepEqual(paidCallBoundV1({ ...input, body: new Uint8Array(1001) }), { kind: 'refused', reason: 'input_unbounded' });
  assert.deepEqual(paidCallBoundV1({ ...input, body: new Uint8Array(new SharedArrayBuffer(1000)) }),
    { kind: 'refused', reason: 'input_unbounded' });
  const result = paidCallBoundV1({ ...input, body: new Uint8Array(0), maxOutputTokens: 1,
    profile: { ...input.profile, inputOverheadTokens: 65_536 } });
  assert.equal(result.kind, 'bounded');
  if (result.kind === 'bounded') assert.equal(result.maxNanoUsd, '196623000');
});

const cacheCases = [
  ['subset', 900, 800, 100, true, '4200000'],
  ['additive', 400, 300, 100, true, '3600000'],
  ['additive', 900, 800, 100, false, '6600000'],
  ['none', 1000, 0, 200, true, '6000000'],
  ['none', 2000, 0, 100, false, '7500000'],
  ['none', 400, 1, 100, false, '2703000'],
  ['subset', 400, 401, 100, false, null],
  ['additive', 700, 300, 200, true, '6000000'],
  ['subset', 1000, 1000, 200, true, '6000000'],
] as const;
for (const [cacheReporting, inputTokens, cachedInputTokens, outputTokens, within, nanoUsd] of cacheCases) {
  test(`T14b ${cacheReporting} ${inputTokens}/${cachedInputTokens}/${outputTokens} independently priced boundary`, () => {
    const result = bound();
    assert.equal(result.kind, 'bounded');
    if (result.kind !== 'bounded') throw new Error('expected bound');
    assert.equal(paidUsageWithinBoundV1({ ...paidRunFakeProfile, cacheReporting }, result,
      { inputTokens, cachedInputTokens, outputTokens }), within);
    const harness = cacheReporting === 'subset' ? 'codex' : 'other';
    const priced = costForUsageV1({ harness, model: 'served/one',
      usage: { inputTokens, cachedInputTokens, outputTokens, totalTokens: null, wallTimeMs: null },
      priceTable: { schema: 'control-room.usage-price-table/v1', tableId: 'paid-run-bound',
        recordedAt: new Date(paidRunNow).toISOString(), entries: [{ entryId: 'paid-run-entry', harness, model: 'served/one',
          billing: { kind: 'token', inputNanoUsdPerToken: '3000', outputNanoUsdPerToken: '15000', cachedInputNanoUsdPerToken: '3000' } }] } });
    if (nanoUsd === null) assert.equal(priced.kind, 'unknown');
    else {
      assert.equal(priced.kind, 'known');
      if (priced.kind === 'known') assert.equal(priced.nanoUsd, nanoUsd);
    }
  });
}

test('T14b output and unsafe or negative usage counters fail the ceiling predicate', () => {
  const result = bound();
  if (result.kind !== 'bounded') throw new Error('expected bound');
  for (const cacheReporting of ['none', 'subset', 'additive'] as const) {
    for (const usage of [
      { inputTokens: 400, cachedInputTokens: 0, outputTokens: 201 },
      { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 100 },
      { inputTokens: 400, cachedInputTokens: -1, outputTokens: 100 },
      { inputTokens: 400.5, cachedInputTokens: 0, outputTokens: 100 },
      { inputTokens: 400, cachedInputTokens: NaN, outputTokens: 100 },
    ]) assert.equal(paidUsageWithinBoundV1({ ...paidRunFakeProfile, cacheReporting }, result, usage), false);
  }
});

test('T14 stream without final-event usage support refuses before dispatch', () => {
  assert.deepEqual(paidCallBoundV1({ profile: { ...paidRunFakeProfile, streamUsageInFinalEvent: false },
    body: new Uint8Array(1000), maxOutputTokens: 200, stream: true, providerId: 'provider-one', servedModelId: 'served/one',
    prices: [paidRunPrice()], now: paidRunNow }), { kind: 'refused', reason: 'stream_unbounded' });
});

test('T15 every profile literal and bounded numeric assumption refuses invalid values', () => {
  for (const patch of [
    { profileId: '' }, { maxTokensPerInputByte: 2 }, { enforcesMaxOutputTokens: false },
    { cacheReporting: 'unknown' }, { reasoningReporting: 'separate' }, { extraBillableCategories: ['request_fee'] },
    { reportsServedModelId: false }, { streamUsageInFinalEvent: 'yes' },
  ]) assert.deepEqual(assertBoundableProfileV1({ ...paidRunFakeProfile, ...patch } as PaidRunProviderProfileV1),
    { kind: 'refused', reason: 'unbounded_provider' });
  for (const [field, min, max] of [
    ['inputOverheadTokens', 0, 65_536], ['maxOutputTokensCeiling', 1, 1_000_000],
    ['maxBodyBytes', 1, 8 * 1024 * 1024], ['maxCallMs', 1, 900_000],
    ['clockSkewMs', 0, 300_000], ['maxConcurrent', 1, 32],
  ] as const) {
    for (const value of [min, max]) assert.equal(assertBoundableProfileV1({ ...paidRunFakeProfile, [field]: value }).kind, 'boundable');
    for (const value of [min - 1, max + 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.deepEqual(assertBoundableProfileV1({ ...paidRunFakeProfile, [field]: value }),
        { kind: 'refused', reason: 'unbounded_provider' });
  }
});
test('T14b none input 2000 exceeds independent 1000 ceiling despite cached zero', () => {
  const result = bound();
  assert.equal(result.kind, 'bounded');
  if (result.kind !== 'bounded') throw new Error('expected bound');
  // 2000*3000+100*15000=7500000, exceeding reserve 6000000 by 1500000.
  assert.equal(result.maxNanoUsd, '6000000');
  assert.equal(paidUsageWithinBoundV1({ ...paidRunFakeProfile, cacheReporting: 'none' }, result,
    { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 100 }), false);
});
