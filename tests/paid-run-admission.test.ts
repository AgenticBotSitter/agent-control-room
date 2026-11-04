import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { admitPaidRunV1, createPaidRunMemoryConsentStoreV1, derivePaidRunPinV1, isPaidRunAdmissionV1,
  PAID_RUN_CAP_CEILING_NANO_USD, type PaidRunConsumedConsentV1, type PaidRunTrustedContextV1 } from '../src/usage/v1/paid-run-admission';
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1 } from '../src/web/v1/improve-control-room-loop-adapter';
import { paidRunContext, paidRunPrice } from './helpers/paid-run-fake-provider';

async function consent(context = paidRunContext(), capNanoUsd = '18000000') {
  const store = createPaidRunMemoryConsentStoreV1();
  const derived = derivePaidRunPinV1(context, '18000000');
  if (derived.kind !== 'paid') throw new Error('expected synthetic pin');
  const input = { tenantId: context.tenantId, ownerIdentityId: context.ownerIdentityId, projectId: context.projectId,
    requestId: context.requestId, settingsSha256: context.settingsSha256, pinDigest: derived.pinDigest, capNanoUsd, now: context.now };
  const receipt = await store.issue(input);
  const consumed = await store.consumeOnce(receipt.consentId, context);
  if (consumed.kind !== 'consumed') throw new Error('expected consumption');
  return { store, input, receipt, capability: consumed.capability };
}

test('T9 no consumed consent refuses with zero downstream opens', () => {
  let opens = 0;
  const result = admitPaidRunV1(paidRunContext(), undefined);
  if (result.kind === 'paid') opens++;
  assert.deepEqual(result, { kind: 'refused', reason: 'consent_missing' });
  assert.equal(opens, 0);
});

test('T9 authentic capability passes the downstream-open spy; copies and fabricated records never open', async () => {
  const context = paidRunContext();
  const issued = await consent(context);
  const calls: string[] = [];
  const open = (value: unknown) => {
    const result = admitPaidRunV1(context, value as PaidRunConsumedConsentV1);
    if (result.kind === 'paid') {
      assert.ok(isPaidRunAdmissionV1(result.admission));
      calls.push(result.admission.runKey);
    }
    return result;
  };
  assert.equal(open(issued.capability).kind, 'paid');
  assert.equal(calls.length, 1, 'positive control actually reaches downstream');
  for (const forged of [undefined, null, 7, 'consent', {}, { ...issued.capability }, structuredClone(issued.capability),
    JSON.parse(JSON.stringify(issued.capability)), Object.create(issued.capability), new Proxy(issued.capability, {}),
    issued.receipt, { ...issued.input, consumedBy: { commandId: context.commandId, loopRunId: context.loopRunId } },
    { settingsText: JSON.stringify(issued.input) }, { preset: issued.input }, { historicalStart: issued.input }]) {
    assert.deepEqual(open(forged), { kind: 'refused', reason: 'consent_missing' });
    assert.equal(calls.length, 1, 'negative must not open downstream');
  }
  assert.ok(Object.isFrozen(issued.capability));
});

test('T9 issue receipt is not authority, including before consumption', async () => {
  const context = paidRunContext(), store = createPaidRunMemoryConsentStoreV1();
  const derived = derivePaidRunPinV1(context, '18000000');
  if (derived.kind !== 'paid') throw new Error('expected pin');
  const receipt = await store.issue({ ...context, pinDigest: derived.pinDigest, capNanoUsd: '18000000' });
  assert.deepEqual(Object.keys(receipt), ['consentId']);
  assert.deepEqual(admitPaidRunV1(context, receipt as unknown as PaidRunConsumedConsentV1),
    { kind: 'refused', reason: 'consent_missing' });
});

test('T9 concurrent consume is atomic: one winner and nineteen replays', async () => {
  const context = paidRunContext(), store = createPaidRunMemoryConsentStoreV1();
  const receipt = await store.issue({ ...context, pinDigest: 'synthetic', capNanoUsd: '18000000' });
  const results = await Promise.all(Array.from({ length: 20 }, () => store.consumeOnce(receipt.consentId, context)));
  assert.equal(results.filter(r => r.kind === 'consumed').length, 1);
  assert.equal(results.filter(r => r.kind === 'refused' && r.reason === 'consent_replayed').length, 19);
  assert.deepEqual(await createPaidRunMemoryConsentStoreV1().consumeOnce(receipt.consentId, context),
    { kind: 'refused', reason: 'consent_missing' });
});

for (const key of ['tenantId', 'ownerIdentityId', 'projectId', 'requestId', 'settingsSha256', 'commandId', 'loopRunId'] as const) {
  test(`T9 trusted ${key} binding mismatch refuses`, async () => {
    const context = paidRunContext(), issued = await consent(context);
    assert.deepEqual(admitPaidRunV1({ ...context, [key]: 'different' }, issued.capability),
      { kind: 'refused', reason: 'consent_mismatch' });
    assert.deepEqual(await issued.store.consumeOnce(issued.receipt.consentId, context),
      { kind: 'refused', reason: 'consent_replayed' });
    assert.equal(admitPaidRunV1(context, issued.capability).kind, 'paid', 'mismatch does not burn capability');
  });
}

test('T9 consume binding mismatch does not burn the authentic claim', async () => {
  const context = paidRunContext(), store = createPaidRunMemoryConsentStoreV1();
  const receipt = await store.issue({ ...context, pinDigest: 'synthetic', capNanoUsd: '18000000' });
  for (const key of ['tenantId', 'ownerIdentityId', 'projectId', 'requestId', 'settingsSha256'] as const)
    assert.deepEqual(await store.consumeOnce(receipt.consentId, { ...context, [key]: 'wrong' }),
      { kind: 'refused', reason: 'consent_mismatch' });
  assert.equal((await store.consumeOnce(receipt.consentId, context)).kind, 'consumed');
});

test('T9 expiry is exclusive and checked again at admission; overlong lifetime is stale', async () => {
  const context = paidRunContext(), issued = await consent(context);
  assert.equal(admitPaidRunV1({ ...context, now: context.now + 599_999 }, issued.capability).kind, 'paid');
  for (const now of [context.now - 1, context.now + 600_000, NaN])
    assert.deepEqual(admitPaidRunV1({ ...context, now }, issued.capability), { kind: 'refused', reason: 'consent_stale' });
  for (const lifetimeMs of [600_001, 0, -1, Infinity, 1.5]) {
    const store = createPaidRunMemoryConsentStoreV1({ lifetimeMs });
    const receipt = await store.issue({ ...context, pinDigest: 'synthetic', capNanoUsd: '18000000' });
    assert.deepEqual(await store.consumeOnce(receipt.consentId, context), { kind: 'refused', reason: 'consent_stale' });
  }
  const store = createPaidRunMemoryConsentStoreV1();
  const receipt = await store.issue({ ...context, pinDigest: 'synthetic', capNanoUsd: '18000000' });
  assert.deepEqual(await store.consumeOnce(receipt.consentId, { ...context, now: context.now + 600_000 }),
    { kind: 'refused', reason: 'consent_stale' });
});

for (const cap of ['0', '01', '1e9', ' 1', '-1', '1.5', '', '5000000001', '99999999999999999']) {
  test(`T9 cap ${JSON.stringify(cap)} refuses with invalid_cap`, async () => {
    assert.deepEqual(derivePaidRunPinV1(paidRunContext(), cap), { kind: 'refused', reason: 'invalid_cap' });
    const issued = await consent(paidRunContext(), cap);
    assert.deepEqual(admitPaidRunV1(paidRunContext(), issued.capability), { kind: 'refused', reason: 'invalid_cap' });
  });
}

// Digest literals independently computed with Python hashlib over compact sorted-key JSON.
// Base row includes every explicit fixture field; run key hashes [tenant:one, run:one].
test('T9 exact cap policy boundaries and server pin fields; no settings-derived pin', async () => {
  const context = paidRunContext();
  assert.equal(PAID_RUN_CAP_CEILING_NANO_USD, '5000000000');
  for (const cap of ['1', '5000000000']) {
    const derived = derivePaidRunPinV1(context, cap);
    assert.equal(derived.kind, 'paid');
    if (derived.kind !== 'paid') throw new Error('expected pin');
    assert.deepEqual(derived.pin, { providerId: 'provider-one', model: 'roster-one', servedModelId: 'served/one',
      providerVersion: 1, priceRowDigest: 'sha256:7ad208c5594030210c104339516b6aefee5eceaea7323faf1fcf21725925172f', capNanoUsd: cap });
    const store = createPaidRunMemoryConsentStoreV1();
    const receipt = await store.issue({ ...context, pinDigest: derived.pinDigest, capNanoUsd: cap });
    const consumed = await store.consumeOnce(receipt.consentId, context);
    if (consumed.kind !== 'consumed') throw new Error('expected consent');
    const result = admitPaidRunV1(context, consumed.capability);
    assert.equal(result.kind, 'paid');
    if (result.kind === 'paid') {
      assert.equal(result.admission.runKey, 'sha256:a0d9b6bb159ce39893f482b193284e122c59d5e889ea14337d1a2acb8aea6c8a');
      assert.ok(isPaidRunAdmissionV1(result.admission));
      assert.ok(Object.isFrozen(result.admission) && Object.isFrozen(result.admission.pin));
      for (const copy of [{ ...result.admission }, structuredClone(result.admission), Object.create(result.admission)])
        assert.equal(isPaidRunAdmissionV1(copy), false);
    }
  }
  assert.equal(isPaidRunAdmissionV1(undefined), false);
});

test('T9 whole-window digest is order invariant; refresh or other window change invalidates consent', async () => {
  const peak = paidRunPrice({ input: '6000', output: '30000', windowKey: 'peak',
    window: { tz: 'UTC', days: [0], start: '07:00', end: '08:00' } });
  const context = paidRunContext({ prices: [paidRunPrice(), peak] });
  const issued = await consent(context);
  const derived = derivePaidRunPinV1(context, '18000000');
  assert.equal(derived.kind, 'paid');
  if (derived.kind === 'paid') assert.equal(derived.pin.priceRowDigest, 'sha256:aac2b211a573b836eaad6475e49f6c056f28bc408c4455a88b3e97846bc16ed9');
  assert.equal(admitPaidRunV1({ ...context, prices: [...context.prices].reverse() }, (await consent(context)).capability).kind, 'paid');
  const unrelated = paidRunPrice({ model: 'served/other', input: '1' });
  assert.equal(admitPaidRunV1({ ...context, prices: [unrelated, ...context.prices] }, (await consent(context)).capability).kind, 'paid');
  for (const prices of [
    [context.prices[0]!, { ...peak, input: '6001' }],
    context.prices.map(row => ({ ...row, checkedAt: new Date(context.now + 1).toISOString() })),
    [context.prices[0]!],
  ]) assert.deepEqual(admitPaidRunV1({ ...context, prices }, issued.capability), { kind: 'refused', reason: 'consent_mismatch' });
  const suppliedDigest = context.prices.map(row => ({ ...row, digest: 'forged' }));
  assert.equal(admitPaidRunV1({ ...context, prices: suppliedDigest }, (await consent(context)).capability).kind, 'paid', 'row digest is recomputed');
  assert.deepEqual(admitPaidRunV1({ ...context, providerVersion: 2 }, issued.capability), { kind: 'refused', reason: 'consent_mismatch' });
  const changedProviders = structuredClone(context.providers);
  changedProviders[0]!.models[0]!.served_model_id = 'served/changed';
  assert.deepEqual(admitPaidRunV1({ ...context, providers: changedProviders }, issued.capability),
    { kind: 'refused', reason: 'consent_mismatch' });
});

test('T9 private record snapshots ignore later issue/claim mutations', async () => {
  const context = paidRunContext(), store = createPaidRunMemoryConsentStoreV1();
  const derived = derivePaidRunPinV1(context, '18000000');
  if (derived.kind !== 'paid') throw new Error('expected pin');
  const input = { ...context, pinDigest: derived.pinDigest, capNanoUsd: '18000000' };
  const receipt = await store.issue(input);
  input.requestId = 'mutated'; input.capNanoUsd = '5000000000';
  const claim = { ...context };
  const pending = store.consumeOnce(receipt.consentId, claim);
  claim.commandId = 'mutated'; claim.loopRunId = 'mutated';
  const consumed = await pending;
  if (consumed.kind !== 'consumed') throw new Error('expected consumption');
  const result = admitPaidRunV1(context, consumed.capability);
  assert.equal(result.kind, 'paid');
  if (result.kind === 'paid') assert.equal(result.admission.pin.capNanoUsd, '18000000');
});

test('T9 route classification rejects distinct paid pairs but allows repeated same pair', async () => {
  const context = paidRunContext();
  const repeated = { ...context, resolution: { ...context.resolution,
    additionalRoutes: Array(4).fill({ providerId: 'provider-one', model: 'roster-one' }) } };
  assert.equal(admitPaidRunV1(repeated, (await consent(repeated)).capability).kind, 'paid');
  const providers = structuredClone(context.providers);
  providers[0]!.models.push({ ...providers[0]!.models[0]!, roster_name: 'roster-two' });
  assert.deepEqual(admitPaidRunV1({ ...context, providers, resolution: { ...context.resolution,
    additionalRoutes: [{ providerId: 'provider-one', model: 'roster-two' }] } }, undefined),
  { kind: 'refused', reason: 'multiple_paid_routes' });
});

test('T9 unknown or ambiguous provider/model routes fail closed', () => {
  const context = paidRunContext();
  const doubled = structuredClone(context.providers);
  doubled[0]!.models.push({ ...doubled[0]!.models[0]! });
  for (const changes of [
    { providers: [] }, { providers: [...context.providers, ...context.providers] }, { providers: doubled },
    { resolution: { ...context.resolution, model: 'missing' } },
    { resolution: { ...context.resolution, additionalRoutes: [{ providerId: 'missing', model: 'roster-one' }] } },
  ]) assert.deepEqual(admitPaidRunV1({ ...context, ...changes }, undefined), { kind: 'refused', reason: 'route_unknown' });
});

test('T16 subscription-only is unpaid without consent; subscription plus paid pins exactly the paid pair', async () => {
  const context = paidRunContext();
  const subscription = { ...context.providers[0]!, provider_id: 'subscription', billing_kind: 'subscription' as const };
  const free = { ...context, providers: [subscription], resolution: { providerId: 'subscription', model: 'roster-one', additionalRoutes: [] } };
  assert.deepEqual(admitPaidRunV1(free, undefined), { kind: 'unpaid' });
  const mixed = { ...context, providers: [...context.providers, subscription], resolution: { ...free.resolution,
    additionalRoutes: [{ providerId: 'provider-one', model: 'roster-one' }] } };
  const result = admitPaidRunV1(mixed, (await consent(mixed)).capability);
  assert.equal(result.kind, 'paid');
  if (result.kind === 'paid') assert.equal(result.admission.pin.providerId, 'provider-one');
});

test('T17 actual adapter construction keeps paid readiness false without executing any process', async t => {
  await mkdir(resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.test-tmp/paid-cap-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = { interpreter: 'inert synthetic file; never execute', entrypoint: 'inert synthetic entry',
    manifest: '{"synthetic":true}', settings: '{"project":{"host_adapter":"local-loop"}}', availability: '{}' };
  for (const [name, text] of Object.entries(content)) await writeFile(join(root, name), text);
  for (const name of ['runs', 'work']) await mkdir(join(root, name));
  const toolingRevision = `sha256:${loopByteHashV1(content.manifest)}`;
  const unused = (): never => { throw new Error('no engine operation authorized'); };
  const adapter = createImproveControlRoomLoopAdapterV1({ adapterId: 'adapter:synthetic',
    interpreter: join(root, 'interpreter'), entrypoint: join(root, 'entrypoint'), toolingManifest: join(root, 'manifest'),
    interpreterSha256: loopByteHashV1(content.interpreter), entrypointSha256: loopByteHashV1(content.entrypoint),
    runRoot: join(root, 'runs'), workRoot: join(root, 'work'), configRoot: root, cwd: root,
    settingsFile: join(root, 'settings'), availabilityFile: join(root, 'availability'), toolingRevision,
    settingsSha256: loopByteHashV1(content.settings), availabilitySha256: loopByteHashV1(content.availability),
    executionIdentity: { uid: process.getuid!(), isolationEvidenceDigest: `sha256:${'b'.repeat(64)}` },
    contract: { lineage: { toolingRevision, decodeRunIdentity: unused, decodeObservation: unused, matchesSavedInput: () => false },
      schemaDigest: `sha256:${'c'.repeat(64)}`, generateRunId: unused, decodeStatus: unused, qualifiedOperations: [],
      providerRoutes: { schemaVersion: 1, resolveStartRoute: async () => paidRunContext().resolution } } });
  try {
    assert.equal(adapter.providerRoutes!.paidExecutionReady, false);
    assert.deepEqual(await readdir(join(root, 'work')), []);
    assert.deepEqual(await readdir(join(root, 'runs')), []);
  } finally { await adapter.close(); }
});

for (const [label, resolution] of [
  ['absent resolution', undefined], ['null resolution', null],
  ['absent additionalRoutes', { providerId: 'provider-one', model: 'roster-one' }],
  ...[null, 0, 'routes', {}, new Set()].map(additionalRoutes =>
    [`additionalRoutes ${String(additionalRoutes)}`, { providerId: 'provider-one', model: 'roster-one', additionalRoutes }]),
  ['null additional route', { providerId: 'provider-one', model: 'roster-one', additionalRoutes: [null] }],
] as const) {
  test(`FIX LOW-2 malformed resolution refuses: ${label}`, async () => {
    const context = paidRunContext(), issued = await consent(context);
    const malformed = { ...context, resolution } as unknown as PaidRunTrustedContextV1;
    assert.deepEqual(admitPaidRunV1(malformed, issued.capability), { kind: 'refused', reason: 'route_unknown' });
    assert.deepEqual(derivePaidRunPinV1(malformed, '18000000'), { kind: 'refused', reason: 'route_unknown' });
    assert.equal(admitPaidRunV1(context, issued.capability).kind, 'paid', 'refusal does not burn a valid capability');
  });
}

test('FIX LOW-3 one consumed capability mints one admission across twenty attempts', async () => {
  const context = paidRunContext(), issued = await consent(context);
  let downstreamOpens = 0;
  const results = await Promise.all(Array.from({ length: 20 }, async () => {
    const result = admitPaidRunV1(context, issued.capability);
    if (result.kind === 'paid') {
      assert.ok(isPaidRunAdmissionV1(result.admission));
      downstreamOpens++;
    }
    return result;
  }));
  assert.equal(downstreamOpens, 1);
  assert.equal(results.filter(result => result.kind === 'paid').length, 1);
  assert.deepEqual(results.slice(1), Array.from({ length: 19 }, () => ({ kind: 'refused', reason: 'consent_replayed' })));
});

test('T9 over-ceiling capability with independently computed matching pin still refuses', async () => {
  const context = paidRunContext(), store = createPaidRunMemoryConsentStoreV1();
  // Python hashlib of the explicit base pin with cap 5000000001, one nano above policy.
  const receipt = await store.issue({ ...context, capNanoUsd: '5000000001',
    pinDigest: 'sha256:b962ac8395904b85f9a7505c7065ebb0b160d293abd132d976dcf861e8cf0b1e' });
  const consumed = await store.consumeOnce(receipt.consentId, context);
  if (consumed.kind !== 'consumed') throw new Error('expected consumption');
  assert.deepEqual(admitPaidRunV1(context, consumed.capability), { kind: 'refused', reason: 'invalid_cap' });
});

 test('FIX LOW-1 malformed trusted context refuses rather than throwing', () => {
  for (const change of [null, undefined, { providers: undefined }, { providers: null }, { providers: {} },
    { providers: [null] }, { providers: [{ provider_id: 'provider-one', models: null }] },
    { providers: [{ provider_id: 'provider-one', models: [null] }] }, { prices: null }, { prices: [null] }, { prices: [{}] }, { providerVersion: NaN }, { providerVersion: undefined }]) {
    const context = change === null || change === undefined ? change : { ...paidRunContext(), ...change };
    assert.doesNotThrow(() => {
      const preview = derivePaidRunPinV1(context as PaidRunTrustedContextV1, '18000000');
      assert.equal(preview.kind, 'refused');
      const result = admitPaidRunV1(context as PaidRunTrustedContextV1, undefined);
      assert.equal(result.kind, 'refused');
    });
  }
});
