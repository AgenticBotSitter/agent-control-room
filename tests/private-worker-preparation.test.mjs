import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPrivateWorkerPreparationV1 } from '../scripts/check-private-worker-preparation.mjs';
import { comparePreparations, explainPreparation } from '../src/worker-preparation-report/v1/explain.mjs';
import { MAX_PREPARATION_INPUT_BYTES, readBoundedText } from '../src/worker-preparation-report/v1/read-bounded.mjs';
import { sha256Digest } from '../src/security/canonical-digest.ts';

const digest = value => sha256Digest(value);
const profile = {
  schema: 'control-room.connector-profile/v1', connectorId: 'connector.synthetic.codex.v1',
  connectorVersion: '1.0.0', harness: 'codex', harnessVersion: '1.2.3', sourceRevision: 'a'.repeat(40),
  transport: 'jsonl_stdio', isolation: 'adapter_process', credentialResolution: 'harness_native',
  distribution: 'invocation_only', operations: Object.fromEntries(
    ['submit', 'status', 'result', 'events', 'cancel', 'resume', 'read', 'usage', 'artifacts'].map(name =>
      [name, { status: ['submit', 'status', 'result', 'read'].includes(name) ? 'supported' : 'unsupported',
        evidence: ['submit', 'status', 'result', 'read'].includes(name) ? 'actual_interface_tested' : 'source_inspected',
        reasonCode: `${name}_synthetic_evidence` }])),
  resultContract: { forms: ['utf8_text'], maximumBytes: 65_536, additionalAttachments: false },
};

function fixture() {
  const components = [
    { kind: 'bridge', id: 'bridge.control-room.v1', version: '1.0.0', manifestDigest: digest('bridge') },
    { kind: 'harness', id: profile.connectorId, version: profile.harnessVersion,
      manifestDigest: digest({ ecosystem: 'git', revision: profile.sourceRevision }) },
    { kind: 'executor', id: 'runtime.node', version: '22.13.0', manifestDigest: digest('executor') },
  ];
  return { schema: 'control-room.private-worker-preparation-input/v1', selectedProfile: profile,
    expected: { tenantId: 'tenant:test', nodeId: 'node:test', endpointDigest: digest('private-endpoint'),
      connectorProfileDigest: digest(profile), platform: 'macos', architecture: 'arm64', components,
      requiredScratchBytes: 1024, requiredCapabilityProbeId: 'probe:worker', requireVerifiedCapability: true },
    facts: { tenantId: 'tenant:test', nodeId: 'node:test', endpointDigest: digest('private-endpoint'),
      platform: 'macos', architecture: 'arm64', cpuLogicalCores: 8, memoryBytes: 16_000_000_000,
      gpuClasses: [], storage: [{ capacityBytes: 10_000, availableBytes: 8_000,
        scratchEligible: true, encryptionReported: true }], networkClass: 'limited', inventory: structuredClone(components),
      executorManifestDigest: digest('executor'), observedAt: '2026-09-13T12:00:00.000Z',
      expiresAt: '2026-09-13T12:05:00.000Z', evaluatedAt: '2026-09-13T12:00:10.000Z',
      telemetry: { observedAt: '2026-09-13T12:00:00.000Z', expiresAt: '2026-09-13T12:01:00.000Z',
        availableStorageBytes: { quality: 'observed', value: 8_000 }, trust: 'reported' },
      capabilities: [{ probeId: 'probe:worker', probeVersion: '1.0.0', outcome: 'pass',
        reasonCode: 'synthetic_pass', observedAt: '2026-09-13T12:00:00.000Z',
        expiresAt: '2026-09-13T12:10:00.000Z', trust: 'verified', evidenceDigest: digest('probe') }] },
    requestedOperations: ['submit', 'status', 'result', 'read'] };
}

test('exact Mac and Linux facts match the selected profile without starting a harness', () => {
  for (const platform of ['macos', 'linux']) {
    const input = fixture(); input.expected.platform = platform; input.facts.platform = platform;
    const result = checkPrivateWorkerPreparationV1(input);
    assert.equal(result.ready, true); assert.equal(result.platform, platform);
    assert.equal(result.usage, 'unknown'); assert.equal(result.startsHarness, false);
    assert.equal(result.grantsExecutionAuthority, false);
    assert.deepEqual(result.operations, { submit: 'available', status: 'available', result: 'available', read: 'available' });
    assert.doesNotMatch(JSON.stringify(result), /private-endpoint|capacityBytes|manifestDigest/);
  }
});

test('missing, wrong and unsupported platform, runtime, integrity and binding facts refuse', () => {
  const changes = [
    input => { input.facts.nodeId = 'node:wrong'; }, input => { input.facts.endpointDigest = digest('wrong'); },
    input => { input.facts.platform = 'linux'; }, input => { input.facts.architecture = 'x64'; },
    input => { input.facts.inventory[2].version = '20.0.0'; },
    input => { input.facts.inventory[1].manifestDigest = digest('wrong'); },
    input => { input.expected.connectorProfileDigest = digest('wrong-profile'); },
    input => { input.facts.inventory.splice(1, 1); },
    input => { input.facts.inventory.push(structuredClone(input.facts.inventory[1])); },
  ];
  for (const change of changes) { const input = fixture(); change(input);
    assert.throws(() => checkPrivateWorkerPreparationV1(input), /private_worker_preparation_unavailable/); }
  const unsupported = fixture(); unsupported.facts.platform = 'windows';
  assert.throws(() => checkPrivateWorkerPreparationV1(unsupported), /private_worker_preparation_unavailable/);
});

test('stale or unverified capability and missing usage stay unavailable or unknown', () => {
  const stale = fixture(); stale.facts.evaluatedAt = '2026-09-13T12:20:00.000Z';
  const staleResult = checkPrivateWorkerPreparationV1(stale);
  assert.equal(staleResult.ready, false); assert.ok(staleResult.eligibility.reasons.includes('telemetry_stale'));
  assert.ok(staleResult.eligibility.reasons.includes('static_discovery_stale'));
  const unverified = fixture(); unverified.facts.capabilities[0].trust = 'reported';
  const unverifiedResult = checkPrivateWorkerPreparationV1(unverified);
  assert.equal(unverifiedResult.ready, false);
  assert.ok(unverifiedResult.eligibility.reasons.includes('capability_unverified'));
  assert.equal(unverifiedResult.usage, 'unknown');
  const unsupported = fixture(); unsupported.requestedOperations.push('cancel');
  const unsupportedResult = checkPrivateWorkerPreparationV1(unsupported);
  assert.equal(unsupportedResult.ready, false); assert.equal(unsupportedResult.operations.cancel, 'unavailable');
});

const explainInput = changes => { const input = fixture(); for (const change of changes) change(input); return input; };
const explainResult = input => explainPreparation(checkPrivateWorkerPreparationV1(structuredClone(input)));
const rendered = explanation => explanation.lines.join('\n');

test('ready facts explain readiness, permitted operations and disclose no identities', () => {
  const explanation = explainResult(fixture());
  assert.equal(explanation.readiness, 'ready');
  assert.ok(explanation.lines.includes('Preparation outcome: ready.'));
  assert.ok(explanation.lines.includes('Permitted operations: read, result, status, submit.'));
  assert.ok(explanation.lines.includes('Blocked operations: none.'));
  const text = rendered(explanation);
  for (const secret of ['tenant:test', 'node:test', 'synthetic_pass', 'connector.synthetic.codex',
    'bridge.control-room.v1', 'runtime.node', 'probe:worker', 'submit_synthetic_evidence']) {
    assert.doesNotMatch(text, new RegExp(secret.replace(/[.:-]/g, '\\$&')));
  }
  assert.doesNotMatch(text, /sha256:[a-f0-9]{64}/);
});

test('ready-to-stale comparison reports the transition and grants no authority', () => {
  const before = explainResult(fixture());
  const stale = explainInput([input => { input.facts.evaluatedAt = '2026-09-13T12:20:00.000Z'; }]);
  const after = explainResult(stale);
  assert.equal(after.readiness, 'not-ready');
  const comparison = comparePreparations(before, after);
  assert.ok(comparison.lines.includes('Readiness changed: ready to not-ready.'));
  assert.ok(comparison.lines.includes('Comparison grants no execution authority.'));
  assert.equal(comparison.grantsExecutionAuthority, false);
  const same = comparePreparations(before, explainResult(fixture()));
  assert.ok(same.lines.includes('Readiness unchanged: ready.'));
});

test('missing capability, insufficient scratch and unavailable operations explain plainly', () => {
  const blocked = explainResult(explainInput([input => { input.facts.capabilities[0].outcome = 'blocked'; }]));
  assert.equal(blocked.readiness, 'not-ready');
  assert.ok(rendered(blocked).includes('The required capability probe has no passing recorded outcome.'));
  const scratch = explainResult(explainInput([input => {
    input.facts.telemetry.availableStorageBytes = { quality: 'observed', value: 10 };
  }]));
  assert.ok(rendered(scratch).includes('Reported scratch storage is below the required amount.'));
  const cancelled = explainResult(explainInput([input => { input.requestedOperations.push('cancel'); }]));
  assert.ok(cancelled.lines.includes('Blocked operations: cancel.'));
});

test('malformed input refuses generically without echoing raw fields', () => {
  for (const bad of [{}, { schema: 'wrong' }, null, 'just a string']) {
    let result;
    try {
      result = bad !== null && typeof bad === 'object' ? checkPrivateWorkerPreparationV1(bad) : undefined;
    } catch {
      result = undefined;
    }
    const explanation = explainPreparation(result);
    assert.equal(explanation.readiness, 'refused');
    assert.ok(explanation.lines.includes('Preparation outcome: refused.'));
  }
  assert.throws(() => checkPrivateWorkerPreparationV1({ canary: 'CANARY-RAW-INPUT-9' }),
    /private_worker_preparation_unavailable/);
});

test('explanations are deterministic and never mutate their inputs', () => {
  const input = fixture();
  const frozen = structuredClone(input);
  const first = JSON.stringify(explainResult(input));
  const second = JSON.stringify(explainResult(input));
  assert.equal(first, second);
  assert.deepEqual(input, frozen);
  const before = explainResult(fixture());
  const beforeFrozen = structuredClone(before);
  comparePreparations(before, explainResult(fixture()));
  assert.deepEqual(before, beforeFrozen);
});

test('canary secrets and raw input text never appear in explanations', () => {
  const input = fixture();
  input.facts.gpuClasses = ['CANARY-GPU-CLASS-7'];
  input.facts.capabilities[0].reasonCode = 'CANARY-REASON-8';
  const text = rendered(explainResult(input));
  assert.doesNotMatch(text, /CANARY-GPU-CLASS-7/);
  assert.doesNotMatch(text, /CANARY-REASON-8/);
});

test('explain CLI helps, explains a document, and refuses generically', () => {
  const script = new URL('../scripts/explain-worker-preparation.mjs', import.meta.url).pathname;
  const run = args => execFileSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8' });
  const help = run(['--help']);
  assert.match(help, /--input <facts\.json>/);
  const dir = mkdtempSync(join(tmpdir(), 'prep-'));
  const readyPath = join(dir, 'ready.json');
  writeFileSync(readyPath, JSON.stringify(fixture()));
  const out = JSON.parse(run(['--input', readyPath]));
  assert.equal(out.explanation.readiness, 'ready');
  assert.ok(!JSON.stringify(out).includes('tenant:test'));
  const badPath = join(dir, 'bad.json');
  writeFileSync(badPath, '{"canary":"CANARY-CLI-RAW-5"}');
  let failed;
  try {
    execFileSync(process.execPath, ['--import', 'tsx', script, '--input', badPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, 'malformed input must exit non-zero');
  assert.match(failed.stderr, /refused supplied facts/);
  assert.doesNotMatch(failed.stderr, /CANARY-CLI-RAW-5/);
  assert.doesNotMatch(JSON.stringify(failed.stdout ?? ''), /CANARY-CLI-RAW-5/);
});

const fakeHandle = (size, { regular = true, failAfter = -1 } = {}) => {
  let position = 0, closed = false, requested = 0, reads = 0;
  const handle = {
    state: () => ({ closed, requested, reads }),
    async stat() { return { isFile: () => regular }; },
    async read() {
      reads++;
      if (failAfter >= 0 && reads > failAfter) throw new Error('synthetic_read_failure');
      if (position >= size) return { bytesRead: 0, buffer: Buffer.alloc(0) };
      const n = Math.min(65536, size - position);
      position += n; requested += n;
      return { bytesRead: n, buffer: Buffer.alloc(n, 0x61) };
    },
    async close() { closed = true; },
  };
  return handle;
};

test('bounded reader returns small files exactly and closes the handle', async () => {
  const handle = fakeHandle(100);
  const text = await readBoundedText('/synthetic/small.json', { open: async () => handle });
  assert.equal(text, 'a'.repeat(100));
  assert.equal(handle.state().closed, true);
});

test('bounded reader stops at the limit on oversized input and closes', async () => {
  const handle = fakeHandle(5 * 1024 * 1024);
  const text = await readBoundedText('/synthetic/huge.json', { open: async () => handle });
  assert.equal(text, null);
  const { requested, closed } = handle.state();
  assert.ok(requested <= MAX_PREPARATION_INPUT_BYTES + 65536,
    `reader stopped early at ${requested} bytes`);
  assert.equal(closed, true);
});

test('bounded reader accepts exactly the limit and refuses one byte more', async () => {
  const exact = fakeHandle(MAX_PREPARATION_INPUT_BYTES);
  assert.equal((await readBoundedText('/synthetic/exact.json', { open: async () => exact }))?.length,
    MAX_PREPARATION_INPUT_BYTES);
  const over = fakeHandle(MAX_PREPARATION_INPUT_BYTES + 1);
  assert.equal(await readBoundedText('/synthetic/over.json', { open: async () => over }), null);
  assert.equal(over.state().closed, true);
});

test('bounded reader refuses non-regular, unreadable and failing inputs', async () => {
  const dir = fakeHandle(100, { regular: false });
  assert.equal(await readBoundedText('/synthetic/dir', { open: async () => dir }), null);
  assert.equal(dir.state().closed, true);
  assert.equal(await readBoundedText('/synthetic/missing', {
    open: async () => { throw new Error('ENOENT'); } }), null);
  const failing = fakeHandle(100000, { failAfter: 1 });
  assert.equal(await readBoundedText('/synthetic/failing', { open: async () => failing }), null);
  assert.equal(failing.state().closed, true);
});

test('explain CLI refuses oversized files and directories without echoing data', () => {
  const script = new URL('../scripts/explain-worker-preparation.mjs', import.meta.url).pathname;
  const run = args => execFileSync(process.execPath, ['--import', 'tsx', script, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dir = mkdtempSync(join(tmpdir(), 'prep-bounded-'));
  const bigPath = join(dir, 'big.json');
  writeFileSync(bigPath, `{"canary":"CANARY-OVERSIZE-11","pad":"${'x'.repeat(3 * 1024 * 1024)}"}`);
  for (const target of [bigPath, dir]) {
    let failed;
    try {
      run(['--input', target]);
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, `oversized input must exit non-zero: ${target}`);
    assert.match(failed.stderr, /refused supplied facts/);
    assert.doesNotMatch(failed.stderr, /CANARY-OVERSIZE-11/);
    assert.doesNotMatch(JSON.stringify(failed.stdout ?? ''), /CANARY-OVERSIZE-11/);
  }
});
