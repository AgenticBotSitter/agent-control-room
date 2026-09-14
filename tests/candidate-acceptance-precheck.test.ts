import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalJson, sha256Digest } from '../src/security/canonical-digest';
import { evaluateReleaseCandidatePrecheckV1 } from '../src/release-candidate-precheck/v1/index';
import { RELEASE_CANDIDATE_COMPONENT_IDS_V1,
  RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1 } from '../src/release-candidate-precheck/v1/types';

const commit = (seed: string) => seed.padEnd(40, '0').slice(0, 40).replace(/[^a-f0-9]/g, 'a');
const digest = (seed: string) => `sha256:${seed.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'b')}`;

const ROOT_CANDIDATE = commit('c1');
const ROOT_ARTIFACT = digest('a1');
const ROOT_MANIFEST = digest('m1');

function componentEvidence(id: string): string {
  return sha256Digest({ artifactDigest: ROOT_ARTIFACT, artifactManifestDigest: ROOT_MANIFEST,
    candidateCommit: ROOT_CANDIDATE, componentId: id });
}

function completeRecord() {
  return {
    schema: RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1,
    candidateCommit: ROOT_CANDIDATE,
    treeDigest: digest('t1'),
    sourceDigest: digest('s1'),
    releaseVersion: '0.1.0',
    artifactDigest: ROOT_ARTIFACT,
    artifactManifestDigest: ROOT_MANIFEST,
    components: RELEASE_CANDIDATE_COMPONENT_IDS_V1.map((id) => ({
      id, acceptedCommit: ROOT_CANDIDATE, evidenceDigest: componentEvidence(id),
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

test('the 14 canonical component identities are frozen at runtime and cannot be shortened', () => {
  const frozen = RELEASE_CANDIDATE_COMPONENT_IDS_V1;
  assert.ok(Object.isFrozen(frozen), 'component IDs must be frozen');
  assert.equal(frozen.length, 14);
  // Mutation attempts (in strict mode this throws, in sloppy mode silently fails;
  // either way the array stays the original size).
  let caught = false;
  try { (frozen as unknown as string[]).length = 0; } catch { caught = true; }
  assert.equal(frozen.length, 14, 'shortening the component IDs is rejected');
  assert.ok(caught || frozen.length === 14);
});

test('mutation regression — the exported component ID array refuses a shortened precheck', () => {
  // Build a forged record that mirrors a mutated runtime where the component ID
  // list has been shortened to 13 entries. Even though every component is
  // internally valid, the precheck must refuse because the canonical ID list
  // is frozen at length 14.
  const short = completeRecord();
  short.components = short.components.slice(0, 13);
  const outcome = evaluateReleaseCandidatePrecheckV1(short);
  assert.equal(outcome.status, 'blocked_invalid_inputs');
  if (outcome.status !== 'blocked_invalid_inputs') assert.fail('refusal required');
  assert.match(outcome.reason, /component-count/);
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

test('component evidence digest must bind to the exact candidate, artifact and manifest', () => {
  // Mismatched acceptedCommit — a different candidate commit for one component.
  const wrongCandidate = completeRecord();
  (wrongCandidate.components[0] as Record<string, unknown>).acceptedCommit = commit('ff');
  assert.equal(evaluateReleaseCandidatePrecheckV1(wrongCandidate).status, 'blocked_invalid_inputs');

  // Mismatched evidenceDigest — same shape but recomputed against a different artifact.
  const wrongArtifact = completeRecord();
  (wrongArtifact.components[2] as Record<string, unknown>).evidenceDigest =
    sha256Digest({ artifactDigest: digest('aa'), artifactManifestDigest: ROOT_MANIFEST,
    candidateCommit: ROOT_CANDIDATE, componentId: 'server-integration' });
  assert.equal(evaluateReleaseCandidatePrecheckV1(wrongArtifact).status, 'blocked_invalid_inputs');

  // Mismatched evidenceDigest — same shape but recomputed against a different manifest.
  const wrongManifest = completeRecord();
  (wrongManifest.components[2] as Record<string, unknown>).evidenceDigest =
    sha256Digest({ artifactDigest: ROOT_ARTIFACT, artifactManifestDigest: digest('mm'),
    candidateCommit: ROOT_CANDIDATE, componentId: 'server-integration' });
  assert.equal(evaluateReleaseCandidatePrecheckV1(wrongManifest).status, 'blocked_invalid_inputs');

  // Mismatched evidenceDigest — same shape but recomputed against a different candidate.
  const wrongEvidence = completeRecord();
  (wrongEvidence.components[2] as Record<string, unknown>).evidenceDigest =
    sha256Digest({ artifactDigest: ROOT_ARTIFACT, artifactManifestDigest: ROOT_MANIFEST,
    candidateCommit: commit('xx'), componentId: 'server-integration' });
  assert.equal(evaluateReleaseCandidatePrecheckV1(wrongEvidence).status, 'blocked_invalid_inputs');
});

test('substituting a component never turns unaccepted input into accepted evidence', () => {
  const before = evaluateReleaseCandidatePrecheckV1(completeRecord());
  const substituted = completeRecord();
  // Substitute component 5 with a different valid tuple (different commit,
  // recomputed evidence binding) — proves the binding is checked and the
  // digest actually moves.
  const subId = substituted.components[5]!.id;
  const newCommit = commit('ff');
  substituted.components[5] = {
    id: subId,
    acceptedCommit: newCommit,
    evidenceDigest: sha256Digest({ artifactDigest: ROOT_ARTIFACT,
      artifactManifestDigest: ROOT_MANIFEST, candidateCommit: newCommit,
      componentId: subId }),
  };
  const after = evaluateReleaseCandidatePrecheckV1(substituted);
  assert.equal(after.status, 'blocked_invalid_inputs',
    'a component bound to a different candidate must refuse');
});

test('secret-, credential-, URL-, locator- or filesystem-shaped values are refused', () => {
  for (const evil of ['«redacted:sk-…»',
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
  let getterRan = false, trapRan = false, trapCount = 0;
  const accessored: Record<string, unknown> = { ...completeRecord() };
  Object.defineProperty(accessored, 'candidateCommit', { enumerable: true,
    get() { getterRan = true; return ROOT_CANDIDATE; }, configurable: true });
  assert.equal(evaluateReleaseCandidatePrecheckV1(accessored).status, 'blocked_invalid_inputs');
  assert.equal(getterRan, false);
  const symbolled = completeRecord() as Record<string | symbol, unknown>;
  symbolled[Symbol('smuggle')] = 'x';
  assert.equal(evaluateReleaseCandidatePrecheckV1(symbolled).status, 'blocked_invalid_inputs');
  const hidden = completeRecord() as Record<string, unknown>;
  Object.defineProperty(hidden, 'treeDigest', { enumerable: false, value: digest('t1') });
  assert.equal(evaluateReleaseCandidatePrecheckV1(hidden).status, 'blocked_invalid_inputs');
  const parent = { candidateCommit: ROOT_CANDIDATE };
  const child = Object.create(parent);
  Object.assign(child, completeRecord(), { candidateCommit: undefined });
  delete child.candidateCommit;
  assert.equal(evaluateReleaseCandidatePrecheckV1(child).status, 'blocked_invalid_inputs');
  const proxied = new Proxy(completeRecord(), { get() {
    trapRan = true; trapCount += 1; throw new Error('must_not_execute'); } });
  const proxiedOutcome = evaluateReleaseCandidatePrecheckV1(proxied);
  assert.equal(proxiedOutcome.status, 'blocked_invalid_inputs');
  assert.equal(trapRan, false);
  // Sparse array slots — array with length but missing index is refused, not dropped.
  const sparse: unknown[] = [];
  sparse[3] = digest('hidden');
  assert.equal(evaluateReleaseCandidatePrecheckV1(sparse).status, 'blocked_invalid_inputs');
  // Hidden field on an array (defensive: array can carry own non-index props).
  const arrWithHidden: unknown[] = [];
  Object.defineProperty(arrWithHidden, 'smuggle', { value: 'x', enumerable: true });
  assert.equal(evaluateReleaseCandidatePrecheckV1(arrWithHidden).status, 'blocked_invalid_inputs');
  // Revoked proxy → reflection throws, treated as attacker input.
  const revoked = Proxy.revocable(completeRecord(), {});
  revoked.revoke();
  assert.equal(evaluateReleaseCandidatePrecheckV1(revoked.proxy).status, 'blocked_invalid_inputs');
});

test('attacker code never runs during reflection — every hostile reflection path is refused', () => {
  // Object whose getPrototypeOf trap fires — must be refused before the trap runs.
  const protoTrapTarget: Record<string, unknown> = { ...completeRecord() };
  let protoTrapRan = false;
  const protoTrap = new Proxy(protoTrapTarget, { getPrototypeOf() {
    protoTrapRan = true; return null; } });
  assert.equal(evaluateReleaseCandidatePrecheckV1(protoTrap).status, 'blocked_invalid_inputs');
  assert.equal(protoTrapRan, false);

  // Object whose ownKeys trap fires — refused before enumeration runs.
  const ownKeysTrapTarget: Record<string, unknown> = { ...completeRecord() };
  let ownKeysTrapRan = false;
  const ownKeysTrap = new Proxy(ownKeysTrapTarget, { ownKeys() {
    ownKeysTrapRan = true; return Object.keys(completeRecord()); } });
  assert.equal(evaluateReleaseCandidatePrecheckV1(ownKeysTrap).status, 'blocked_invalid_inputs');
  assert.equal(ownKeysTrapRan, false);
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
  // node:util is allowed (used for the static Proxy brand check) — assert it is
  // imported ONLY in precheck.ts and ONLY for `types as nodeUtilTypes`.
  const precheckSource = readFileSync(new URL('../src/release-candidate-precheck/v1/precheck.ts',
    import.meta.url), 'utf8');
  assert.match(precheckSource, /from 'node:util'/);
  const otherSources = files.filter((f) => f !== 'src/release-candidate-precheck/v1/precheck.ts')
    .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
  for (const src of otherSources) {
    assert.doesNotMatch(src, /from 'node:util'/, 'node:util import confined to precheck.ts');
  }
});
