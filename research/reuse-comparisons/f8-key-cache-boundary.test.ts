// Research only: current real cache/factory, synthetic public keys, no transport.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createAccessKeyCache } from '../../src/web/v1/access-key-cache';
import type { AccessTrust } from '../../src/web/v1/access-verifier';

const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
const good = () => [{ kid: 'synthetic', jwk: { ...publicKey } }];
const mutations: Array<[string, (keys: AccessTrust['keys']) => AccessTrust['keys']]> = [
  ['empty', () => []],
  ['too many', keys => Array.from({ length: 9 }, (_, i) => ({ ...keys[0], kid: `key${i}` }))],
  ['duplicate ID', keys => [keys[0], keys[0]]],
  ['empty ID', keys => [{ ...keys[0], kid: '' }]],
  ['wrong key type', keys => [{ ...keys[0], jwk: { ...publicKey, kty: 'EC' } }]],
  ['private material', keys => [{ ...keys[0], jwk: { ...publicKey, d: 'synthetic-invalid' } }]],
  ['wrong algorithm', keys => [{ ...keys[0], jwk: { ...publicKey, alg: 'RS512' } }]],
  ['wrong use', keys => [{ ...keys[0], jwk: { ...publicKey, use: 'enc' } }]],
  ['malformed modulus', keys => [{ ...keys[0], jwk: { ...publicKey, n: 'AA' } }]],
];

for (const [name, mutate] of mutations) test(`invalid trust is not cached: ${name}`, async () => {
  let calls = 0;
  let now = 1_800_000_000_000;
  const cache = createAccessKeyCache({ issuer: 'https://synthetic.invalid', audience: 'test',
    maxSessionSeconds: 3600, clock: () => now, loadKeys: async () => {
      calls++; return calls === 1 ? mutate(good()) : good();
    } });
  try {
    await assert.rejects(cache.get(), /access_keys_unavailable/);
    await assert.rejects(cache.get(), /access_keys_unavailable/);
    assert.equal(calls, 1, 'invalid load must enter backoff, not immediately reload');
    now += 5000;
    const trust = await cache.get();
    assert.equal(trust.keys.length, 1);
    assert.equal(calls, 2);
    assert.equal(await cache.get(), trust);
  } finally { cache.close(); }
});

for (const mode of ['expired', 'backwards', 'closed', 'valid'] as const) {
  test(`held key load: ${mode}`, async () => {
    let now = 1_800_000_000_000;
    let release!: (keys: AccessTrust['keys']) => void;
    let entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const loaded = new Promise<AccessTrust['keys']>(resolve => { release = resolve; });
    let calls = 0;
    const cache = createAccessKeyCache({ issuer: 'https://synthetic.invalid', audience: 'test',
      maxSessionSeconds: 3600, freshForMs: 1000, clock: () => now,
      loadKeys: async () => { calls++; entered(); return loaded; } });
    try {
      const first = cache.get(), second = cache.get();
      // Attach rejection observers before releasing either pending consumer.
      const settled = Promise.allSettled([first, second]);
      await began;
      if (mode === 'expired') now += 1000;
      if (mode === 'backwards') now--;
      if (mode === 'closed') cache.close();
      const keys = good(); release(keys);
      const results = await settled;
      assert.equal(calls, 1, 'coalesced refresh');
      for (const result of results) {
        assert.equal(result.status, mode === 'valid' ? 'fulfilled' : 'rejected');
        if (result.status === 'rejected') assert.match(String(result.reason), /access_keys_unavailable/);
        else {
          assert.notEqual(result.value.keys, keys, 'loader-owned array is copied');
          keys[0].kid = 'changed-after-load';
          assert.equal(result.value.keys[0].kid, 'synthetic');
        }
      }
    } finally { release?.(good()); cache.close(); }
  });
}
