// Actual rehearsal control flow, held real Node verifier, fail-on-open sentinels.
// Not candidate-library execution and not PostgreSQL acceptance.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const file = new URL('../../src/web/v1/private-database-rehearsal.ts', import.meta.url);
const require = createRequire(file);
const raw = readFileSync(file, 'utf8');
const sha256 = createHash('sha256').update(raw).digest('hex');
assert.equal(sha256, 'd74c3f2bfdaea0840acf20a63e584fd8406ee0398b00e99f765b776fbf988bbe');
const auth = require('./access-verifier.ts');
const { now, token, trust } = require('../../../tests/helpers/web-foundation.ts');
const results = [];
for (const mode of ['valid', 'wrong-owner', 'expired-token', 'abort', 'elapsed', 'wall-expired', 'wall-backwards']) {
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const began = new Promise(r => { entered = r; });
  const replacement = { ...auth, createAccessVerifier: t => {
    const verify = auth.createAccessVerifier(t);
    return async (r, n) => { entered(); await gate; return verify(r, n); };
  } };
  const needle = 'const claims = createAccessVerifier(';
  assert.equal(raw.split(needle).length, 2);
  const source = raw.replace(needle, 'const claims = await createAccessVerifier(');
  const exports = {};
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, vm.createContext({ exports, Request, Response, Uint8Array, structuredClone,
    setTimeout, clearTimeout, AbortController, Date, performance,
    require: p => p === './access-verifier' ? replacement : require(p) }));
  let wall = now, mono = 0, opens = 0, probes = 0;
  const signal = new AbortController();
  const manifest = { commit: '1'.repeat(40), tree: '2'.repeat(40), artifactDigest: '3'.repeat(64) };
  const database = { host: '127.0.0.1', port: 5432, database: 'cr14b_rehearsal_synthetic',
    username: 'synthetic', password: 'synthetic-not-a-credential', majorVersion: 17 };
  const input = { manifest, database, signal: signal.signal,
    material: { assertion: token(mode === 'wrong-owner' ? { sub: 'other' } : mode === 'expired-token' ? { exp: now / 1000 - 1 } : {}),
      keys: trust.keys, ideaIntegrityKey: new Uint8Array(32), registryIntegrityKey: new Uint8Array(32), telemetryIntegrityKey: new Uint8Array(32) },
    packet: { manifest, scopeDigest: exports.rehearsalScopeDigest(database),
      preparationDigest: '4'.repeat(64), ownerApprovalDigest: '5'.repeat(64), cleanupPlanDigest: '6'.repeat(64),
      pgPackageDigest: '7'.repeat(64), pgVersionNumber: 170005, expiresAt: now + 900000, durationMs: 60000,
      dedicatedSyntheticDatabase: true, sameHostPrivatePrimary: true, setupAccepted: true,
      connectionPools: 2, maxWebConnections: 8, validationSessions: 2, physicalListener: false,
      automaticRetry: false, cleanup: 'close_owned_connections_then_operator_database_cleanup' } };
  const runner = exports.createInjectedPrivateDatabaseRehearsal({ clock: () => wall, monotonic: () => mono,
    openDatabase: () => { opens++; throw Error('synthetic sentinel; no pool created'); },
    openProbe: () => { probes++; throw Error('probe forbidden'); } });
  const pending = runner.run(input);
  await began;
  assert.equal(opens, 0);
  if (mode === 'abort') signal.abort();
  if (mode === 'elapsed') mono = 50000;
  if (mode === 'wall-expired') wall += 900000;
  if (mode === 'wall-backwards') wall--;
  release();
  const evidence = await pending;
  assert.equal(opens, mode === 'valid' ? 1 : 0);
  assert.equal(probes, 0);
  assert.equal(evidence.disposition, ['wrong-owner', 'expired-token'].includes(mode) ? 'setup_incomplete' : 'stopped');
  assert.equal(evidence.realPostgresAccepted, false);
  assert.equal((await runner.run(input)).disposition, 'already_attempted');
  assert.equal(opens, mode === 'valid' ? 1 : 0);
  results.push({ mode, disposition: evidence.disposition, openSentinelCalls: opens, probes, replay: 'already_attempted' });
}
console.log(JSON.stringify({ sourceSha256: sha256, scope: 'Awaited actual rehearsal with delayed Node verifier; synthetic clock and fail-on-open sentinel; no libraries, DB, listener or provider', results }, null, 2));
