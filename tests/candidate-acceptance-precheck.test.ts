import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalJson } from '../src/security/canonical-digest';
import { evaluateReleaseCandidatePrecheckV1 } from '../src/release-candidate-precheck/v1/index';
import { RELEASE_CANDIDATE_COMPONENT_IDS_V1,
  RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1 } from '../src/release-candidate-precheck/v1/types';

const commit = (seed: string) => seed.padEnd(40, '0').slice(0, 40).replace(/[^a-f0-9]/g, 'a');
const digest = (seed: string) => `sha256:${seed.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'b')}`;

function completeRecord() {
  return {
    schema: RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1,
    candidateCommit: commit('c1'),
    treeDigest: digest('t1'),
    sourceDigest: digest('s1'),
    releaseVersion: '0.1.0',
    artifactDigest: digest('a1'),
    artifactManifestDigest: digest('m1'),
    components: RELEASE_CANDIDATE_COMPONENT_IDS_V1.map((id, index) => ({
      id, acceptedCommit: commit(`c${index}`), evidenceDigest: digest(`e${index}`),
    })),
  };
}

test('a complete fabricated record returns precheck_complete_not_accepted with every authority flag false', () => {
  const outcome = evaluateReleaseCandidatePrecheckV1(completeRecord());
  assert.equal(outcome.status, 'precheck_complete_not_accepted');
  if (outcome.status !== 'precheck_complete_not_accepted') assert.fail('complete required');
  assert.match(outcome.recordDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(outcome.componentCount, 14);
  assert.deepEqual(outcome.authority, { approval: false, qualification: false,
    installation: false, deployment: false, execution: false, externalEffect: false,
    ownerAuthority: false });
  assert.ok(Object.isFrozen(outcome));
});

test('repeated evaluation of exact accepted plain data returns byte-identical canonical output', () => {
  const first = evaluateReleaseCandidatePrecheckV1(completeRecord());
  const second = evaluateReleaseCandidatePrecheckV1(completeRecord());
  assert.equal(canonicalJson(first), canonicalJson(second));
  if (first.status === 'precheck_complete_not_accepted'
    && second.status === 'precheck_complete_not_accepted') {
    assert.equal(first.recordDigest, second.recordDigest);
  } else assert.fail('complete required');
});

test('missing record, field, artifact binding or required component returns a bounded blocked state', () => {
  for (const input of [undefined, null, 42, 'record', []]) {
    const outcome = evaluateReleaseCandidatePrecheckV1(input);
    assert.equal(outcome.status, 'blocked_missing_inputs');
  }
  for (const field of ['candidateCommit', 'treeDigest', 'sourceDigest', 'releaseVersion',
    'artifactDigest', 'artifactManifestDigest', 'components', 'schema']) {
    const record = completeRecord() as Record<string, unknown>;
    delete record[field];
    const outcome = evaluateReleaseCandidatePrecheckV1(record);
    assert.equal(outcome.status, 'blocked_missing_inputs', field);
    if (outcome.status !== 'blocked_missing_inputs') assert.fail('missing required');
    assert.match(outcome.reason, /^[A-Za-z0-9:[\]._-]+$/);
  }
  const short = completeRecord();
  short.components = short.components.slice(0, 13);
  assert.equal(evaluateReleaseCandidatePrecheckV1(short).status, 'blocked_invalid_inputs');
  const noEvidence = completeRecord();
  delete (noEvidence.components[3] as Record<string, unknown>).evidenceDigest;
  assert.equal(evaluateReleaseCandidatePrecheckV1(noEvidence).status, 'blocked_missing_inputs');
});

test('extra or duplicate components, unknown fields, wrong order and malformed values are refused', () => {
  const extra = completeRecord() as Record<string, unknown>;
  extra.surprise = 'nope';
  assert.equal(evaluateReleaseCandidatePrecheckV1(extra).status, 'blocked_invalid_inputs');
  const swapped = completeRecord();
  [swapped.components[0], swapped.components[1]] = [swapped.components[1]!, swapped.components[0]!];
  assert.equal(evaluateReleaseCandidatePrecheckV1(swapped).status, 'blocked_invalid_inputs');
  const duped = completeRecord();
  duped.components[1] = { ...duped.components[0] };
  assert.equal(evaluateReleaseCandidatePrecheckV1(duped).status, 'blocked_invalid_inputs');
  for (const mutate of [
    (r: ReturnType<typeof completeRecord>) => { r.releaseVersion = 'v1'; },
    (r: ReturnType<typeof completeRecord>) => { r.releaseVersion = '1.2'; },
    (r: ReturnType<typeof completeRecord>) => { r.candidateCommit = 'short'; },
    (r: ReturnType<typeof completeRecord>) => { r.candidateCommit = 'Z'.repeat(40); },
    (r: ReturnType<typeof completeRecord>) => { r.treeDigest = 'sha256:xyz'; },
    (r: ReturnType<typeof completeRecord>) => { r.artifactDigest = digest('ok').toUpperCase(); },
    (r: ReturnType<typeof completeRecord>) => { (r.components[0] as Record<string, unknown>).frobnicate = 1; },
    (r: ReturnType<typeof completeRecord>) => { r.components[0]!.acceptedCommit = commit('ok') + 'extra'; },
  ]) {
    const record = completeRecord();
    mutate(record);
    assert.equal(evaluateReleaseCandidatePrecheckV1(record).status, 'blocked_invalid_inputs');
  }
});

test('substituting a component never turns unaccepted input into accepted evidence', () => {
  const before = evaluateReleaseCandidatePrecheckV1(completeRecord());
  const substituted = completeRecord();
  substituted.components[5] = { id: substituted.components[5]!.id,
    acceptedCommit: commit('ff'), evidenceDigest: digest('ff') };
  const after = evaluateReleaseCandidatePrecheckV1(substituted);
  assert.equal(after.status, 'precheck_complete_not_accepted');
  if (before.status !== 'precheck_complete_not_accepted'
    || after.status !== 'precheck_complete_not_accepted') assert.fail('complete required');
  assert.notEqual(before.recordDigest, after.recordDigest);
  assert.deepEqual(after.authority, { approval: false, qualification: false,
    installation: false, deployment: false, execution: false, externalEffect: false,
    ownerAuthority: false });
});

test('secret-, credential-, URL-, locator- or filesystem-shaped values are refused', () => {
  for (const evil of ['sk-live-abcdef1234567890abcdef1234567890abcd',
    'https://example.test/artifact.tgz', '/etc/passwd', 'C:\\release\\a.tgz',
    '${ARTIFACT_DIGEST}', '..\\..\\secret', 'sha256:' + 'g'.repeat(64)]) {
    const record = completeRecord();
    record.artifactDigest = evil;
    const outcome = evaluateReleaseCandidatePrecheckV1(record);
    assert.equal(outcome.status, 'blocked_invalid_inputs', evil.slice(0, 12));
    if (outcome.status !== 'blocked_invalid_inputs') assert.fail('refusal required');
    assert.doesNotMatch(canonicalJson(outcome), /sk-live|example\.test|passwd/);
  }
});

test('inherited, non-enumerable, Symbol, accessor and Proxy inputs are refused without executing attacker code', () => {
  let getterRan = false, trapRan = false;
  const accessored: Record<string, unknown> = { ...completeRecord() };
  Object.defineProperty(accessored, 'candidateCommit', { enumerable: true,
    get() { getterRan = true; return commit('c1'); } });
  assert.equal(evaluateReleaseCandidatePrecheckV1(accessored).status, 'blocked_invalid_inputs');
  assert.equal(getterRan, false);
  const symbolled = completeRecord() as Record<string | symbol, unknown>;
  symbolled[Symbol('smuggle')] = 'x';
  assert.equal(evaluateReleaseCandidatePrecheckV1(symbolled).status, 'blocked_invalid_inputs');
  const hidden = completeRecord() as Record<string, unknown>;
  Object.defineProperty(hidden, 'treeDigest', { enumerable: false, value: digest('t1') });
  assert.equal(evaluateReleaseCandidatePrecheckV1(hidden).status, 'blocked_missing_inputs');
  const parent = { candidateCommit: commit('c1') };
  const child = Object.create(parent);
  Object.assign(child, completeRecord(), { candidateCommit: undefined });
  delete child.candidateCommit;
  assert.equal(evaluateReleaseCandidatePrecheckV1(child).status, 'blocked_invalid_inputs');
  const proxied = new Proxy(completeRecord(), { get() {
    trapRan = true; throw new Error('must_not_execute'); } });
  const outcome = evaluateReleaseCandidatePrecheckV1(proxied);
  assert.equal(outcome.status, 'precheck_complete_not_accepted');
  assert.equal(trapRan, false);
  const revoked = Proxy.revocable(completeRecord(), {});
  revoked.revoke();
  assert.equal(evaluateReleaseCandidatePrecheckV1(revoked.proxy).status, 'blocked_invalid_inputs');
});

test('the new source imports no effect client and exposes no effect port', () => {
  const files = ['src/release-candidate-precheck/v1/types.ts',
    'src/release-candidate-precheck/v1/precheck.ts',
    'src/release-candidate-precheck/v1/index.ts'];
  const forbidden = ['node:fs', 'node:process', 'node:child_process', 'node:net', 'node:http',
    'fetch(', 'XMLHttpRequest', 'child_process', 'process.', 'globalThis', 'require(',
    'pg-native', 'better-sqlite', 'node:sqlite', 'console.'];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const token of forbidden) {
      assert.doesNotMatch(source, new RegExp(token.replace(/[().]/g, '\\$&')), `${file}:${token}`);
    }
  }
});
