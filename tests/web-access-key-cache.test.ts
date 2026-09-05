import assert from "node:assert/strict";
import test from "node:test";
import { createAccessKeyCache, createAccessKeyLoader } from "../src/web/v1/access-key-cache.ts";
import { now, trust } from "./helpers/web-foundation.ts";

test("concurrent requests share public-key refresh and stale keys are never used after a failed refresh", async () => {
  let current = now; let calls = 0; let fail = false;
  const cache = createAccessKeyCache({ ...trust, clock: () => current, freshForMs: 1000,
    loadKeys: async () => { calls++; if (fail) throw new Error(); return trust.keys; } });
  const results = await Promise.all([cache.get(), cache.get(), cache.get()]); assert.equal(calls, 1);
  assert.equal(results[0].validUntilMs, now + 1000);
  fail = true; current += 1000;
  await assert.rejects(cache.get()); await assert.rejects(cache.get()); assert.equal(calls, 2);
  fail = false; current += 5000;
  assert.equal((await cache.get()).validUntilMs, current + 1000);
  current--; await assert.rejects(cache.get()); cache.close(); await assert.rejects(cache.get());
});
test("public-key loading has a finite deadline even when its injected transport ignores cancellation", async () => {
  let signal!: AbortSignal;
  const cache = createAccessKeyCache({ ...trust, clock: () => now, timeoutMs: 10,
    loadKeys: input => { signal = input; return new Promise(() => {}); } });
  await assert.rejects(cache.get()); assert.equal(signal.aborted, true); cache.close();
});
test("a synchronous key-loader failure can recover after the fixed backoff", async () => {
  let current = now; let calls = 0;
  const cache = createAccessKeyCache({ ...trust, clock: () => current, loadKeys: () => {
    if (++calls === 1) throw new Error(); return Promise.resolve(trust.keys);
  } });
  await assert.rejects(cache.get()); current += 5001;
  assert.equal((await cache.get()).issuer, trust.issuer); assert.equal(calls, 2); cache.close();
});
for (const timeout of [false, true]) {
  test(`a ${timeout ? "timed out" : "delayed failed"} refresh has a full five-second post-failure backoff`, async () => {
    let current = now; let calls = 0;
    const cache = createAccessKeyCache({ ...trust, clock: () => current, timeoutMs: 10, loadKeys: async () => {
      if (++calls > 1) return trust.keys;
      current += 5000;
      if (timeout) return new Promise(() => {});
      throw new Error();
    } });
    await assert.rejects(cache.get());
    current += 4999; await assert.rejects(cache.get()); assert.equal(calls, 1);
    current++; assert.equal((await cache.get()).issuer, trust.issuer); assert.equal(calls, 2);
    cache.close();
  });
}
test("unmeasurable failure time closes key refresh rather than scheduling an immediate retry", async () => {
  let current = now; let calls = 0;
  const cache = createAccessKeyCache({ ...trust, clock: () => current, loadKeys: async () => {
    calls++; current--; throw new Error();
  } });
  await assert.rejects(cache.get()); current = now + 6000;
  await assert.rejects(cache.get()); assert.equal(calls, 1);
});
test("the configured issuer fixes the key URL and redirects or private key material are not accepted", async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  let privateMaterial = false;
  const loader = createAccessKeyLoader(trust.issuer, (async (path, init) => {
    calls.push({ path: String(path), init });
    return Response.json({ keys: trust.keys.map(key => ({ ...key.jwk, kid: key.kid, ...(privateMaterial ? { d: "not-public" } : {}) })) });
  }) as typeof fetch);
  assert.equal((await loader(new AbortController().signal)).length, 1);
  assert.equal(calls[0].path, `${trust.issuer}/cdn-cgi/access/certs`); assert.equal(calls[0].init?.redirect, "error");
  assert.equal(calls[0].init?.credentials, "omit");
  privateMaterial = true; await assert.rejects(loader(new AbortController().signal));
  assert.throws(() => createAccessKeyLoader("http://example.invalid", fetch));
});
