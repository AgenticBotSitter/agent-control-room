import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPrivateWorkerPreparationV1 } from '../scripts/check-private-worker-preparation.mjs';
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
