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
const ROOT_TREE = digest('t1');
const ROOT_SOURCE = digest('s1');
const ROOT_VERSION = '0.1.0';
const ROOT_ARTIFACT = digest('a1');
const ROOT_MANIFEST = digest('m1');

/** Candidate-derived binding digest that the precheck REFUSES as
 * `evidenceDigest-candidate-reconstructed`. Mirrors the historical
 * component-to-candidate formula the precheck now treats as a forgery pattern. */
function candidateDerivedBindingDigest(id: string): string {
  return sha256Digest({ artifactDigest: ROOT_ARTIFACT, artifactManifestDigest: ROOT_MANIFEST,
    candidateCommit: ROOT_CANDIDATE, componentId: id });
}

/** Per-component *historical* (witness) evidence digest — what an independent
 * attesting body would emit at acceptance time. NOT derived from the candidate
 * root parameters; uses a separate witness seed per component so each
 * acceptance event is distinct and separately trusted. */
function historicalEvidenceDigest(id: string, index: number): string {
  return sha256Digest({ witness: `historical-witness-${id}`,
    acceptanceIndex: index, witnessSalt: `salt-${index}-distinct`,
    attestationKind: 'historical-component-acceptance-v1' });
}

function aggregateBindingDigestFor(components: Array<{ id: string;
  acceptedCommit: string; evidenceDigest: string }>): string {
  return sha256Digest({
    candidateCommit: ROOT_CANDIDATE, treeDigest: ROOT_TREE, sourceDigest: ROOT_SOURCE,
    releaseVersion: ROOT_VERSION, artifactDigest: ROOT_ARTIFACT,
    artifactManifestDigest: ROOT_MANIFEST,
    components: components.map((c) => ({ id: c.id, acceptedCommit: c.acceptedCommit,
      evidenceDigest: c.evidenceDigest })) });
}

/** A complete, correctly-formed multi-history record: each component is accepted
 * at its own historical commit and carries an independently attested evidence
 * digest (not candidate-reconstructed). The aggregate binding digest is
 * supplied externally. */
function historicalCompleteRecord(opts: { componentsOverride?: Array<{ id: string;
  acceptedCommit: string; evidenceDigest: string }> } = {}) {
  const components = opts.componentsOverride ?? RELEASE_CANDIDATE_COMPONENT_IDS_V1
    .map((id, i) => ({
      id, acceptedCommit: commit(`h${i}`),
      evidenceDigest: historicalEvidenceDigest(id, i) }));
  const aggregateBindingDigest = aggregateBindingDigestFor(components);
  return {
    schema: RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1,
    candidateCommit: ROOT_CANDIDATE, treeDigest: ROOT_TREE, sourceDigest: ROOT_SOURCE,
    releaseVersion: ROOT_VERSION, artifactDigest: ROOT_ARTIFACT,
    artifactManifestDigest: ROOT_MANIFEST, aggregateBindingDigest, components,
  };
}

test('a complete historical multi-commit record returns precheck_complete_not_accepted', () => {
  const record = historicalCompleteRecord();
  const outcome = evaluateReleaseCandidatePrecheckV1(record);
  assert.equal(outcome.status, 'precheck_complete_not_accepted');
  if (outcome.status !== 'precheck_complete_not_accepted') assert.fail('complete required');
  assert.equal(outcome.schema, RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1);
  assert.equal(outcome.candidateCommit, ROOT_CANDIDATE);
  assert.equal(outcome.artifactDigest, ROOT_ARTIFACT);
  assert.equal(outcome.artifactManifestDigest, ROOT_MANIFEST);
  assert.equal(outcome.componentCount, 14);
  assert.equal(outcome.components.length, 14);
  assert.ok(Object.isFrozen(outcome.components));
  for (const c of outcome.components) {
    assert.ok(Object.isFrozen(c));
    assert.match(c.acceptedCommit, /^[a-f0-9]{40}$/);
    assert.match(c.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  }
  assert.deepEqual(outcome.authority, { approval: false, qualification: false,
    installation: false, deployment: false, execution: false, externalEffect: false,
    ownerAuthority: false });
  assert.ok(Object.isFrozen(outcome));
  // Aggregate binding must be reported as supplied=recomputed; internal proof
  // only — never acceptance.
  assert.equal(outcome.aggregateBinding.supplied, outcome.aggregateBinding.recomputed);
  assert.equal(outcome.aggregateBinding.supplied, record.aggregateBindingDigest);
});

test('multi-history example — every component keeps its own distinct historical accepted commit and digest', () => {
  // Build a record where each component has its own distinct historical
  // (acceptance-time) commit and an independently witnessed evidence digest.
  // The precheck must preserve those distinct values in the output order.
  const outcome = evaluateReleaseCandidatePrecheckV1(historicalCompleteRecord());
  if (outcome.status !== 'precheck_complete_not_accepted') assert.fail('expected precheck_complete_not_accepted');
  const outComponents = outcome.components as readonly { id: string;
    acceptedCommit: string; evidenceDigest: string }[];
  const inputRecord = historicalCompleteRecord();
  for (let i = 0; i < outComponents.length; i++) {
    assert.equal(outComponents[i].id, inputRecord.components[i]!.id);
    assert.equal(outComponents[i].acceptedCommit, inputRecord.components[i]!.acceptedCommit);
    assert.equal(outComponents[i].evidenceDigest, inputRecord.components[i]!.evidenceDigest,
      `component ${i} must preserve its independently attested historical evidence`);
  }
  // 14 distinct (commit, digest) pairs across the 14 identities — proves
  // multiple distinct accept-time decisions were honored, not collapsed.
  const uniquePairs = new Set(outComponents.map((c) => `${c.acceptedCommit}|${c.evidenceDigest}`));
  assert.equal(uniquePairs.size, 14, 'all 14 accept-time decisions must remain distinct');
});

test('a substituted historical accepted commit refuses — only the digest binds', () => {
  // Substitute component 5's historical accepted commit with a different
  // historical commit AND leave the supplied aggregateBindingDigest exactly
  // as it was for the original (commit, digest) tuple. The precheck must
  // recompute the aggregate binding digest from the new historical-commit
  // set and refuse with aggregateBindingDigest-mismatch — proving the
  // aggregate binding binds the historical accepted commits, not just the
  // digests. Realistic operator error: "I signed off at commit ZZ for
  // component 5, but my archive still has the old aggregate binding from
  // when component 5 was at its prior commit." This mismatch means the
  // historical acceptance set and the candidate's binding carry different
  // histories and must refuse.
  const record = historicalCompleteRecord();
  const index = 5;
  const target = (record.components as { id: string; acceptedCommit: string;
    evidenceDigest: string }[])[index]!;
  const originalCommit = target.acceptedCommit;
  target.acceptedCommit = commit('zz'); // historical commit from a different acceptance
  // evidenceDigest is UNCHANGED — digest-only rebinding would still pass.
  // The supplied aggregateBindingDigest is UNCHANGED — it was computed for
  // the original (commit, digest) tuple at this slot. Now the recomputed
  // binding uses the new commit, which differs.
  assert.notEqual(originalCommit, target.acceptedCommit);
  const outcome = evaluateReleaseCandidatePrecheckV1(record);
  assert.equal(outcome.status, 'blocked_invalid_inputs',
    'substituted historical commit with stale aggregate binding must refuse');
  assert.match(outcome.reason, /aggregateBindingDigest-mismatch/);
  // Sanity: when the operator refreshes the binding to match the new commit,
  // the record is complete (the precheck still does NOT accept — it returns
  // precheck_complete_not_accepted, never approval).
  record.aggregateBindingDigest = aggregateBindingDigestFor(
    record.components as Array<{ id: string; acceptedCommit: string; evidenceDigest: string }>);
  const refreshed = evaluateReleaseCandidatePrecheckV1(record);
  assert.equal(refreshed.status, 'precheck_complete_not_accepted',
    'refreshing the binding with the new commit restores complete-not-accepted, never acceptance');
});

test('a substituted component evidence digest refuses with aggregateBindingDigest-mismatch', () => {
  // Substitute component 7's evidence digest for a different historical
  // witness. The supplied aggregate binding digest was computed over the
  // original digests; the precheck recomputes over the new digest and
  // refuses binding mismatch.
  const record = historicalCompleteRecord();
  const index = 7;
  (record.components as { id: string; acceptedCommit: string;
    evidenceDigest: string }[])[index]!.evidenceDigest =
    historicalEvidenceDigest('substituted-witness', index);
  // supplied aggregate binding digest still references the original digest set
  // and therefore mismatches the recomputed value
  const outcome = evaluateReleaseCandidatePrecheckV1(record);
  assert.equal(outcome.status, 'blocked_invalid_inputs',
    'a substituted evidence digest must fail the aggregate binding check');
  assert.match(outcome.reason, /aggregateBindingDigest-mismatch/);
});

test('a forensically candidate-reconstructed component refuses — never independently attested', () => {
  // Construct a record where every component carries the candidate-derived
  // binding digest (the digest that *would* be produced if an operator
  // re-derived it from the candidate root parameters rather than producing
  // it from historical witness attestation). The precheck must refuse each
  // such slot as `evidenceDigest-candidate-reconstructed` — the historical
  // evidence pattern is the entire purpose of the per-component digest.
  const record = historicalCompleteRecord();
  const components = record.components as { id: string; acceptedCommit: string;
    evidenceDigest: string }[];
  for (let i = 0; i < components.length; i++) {
    components[i]!.evidenceDigest = candidateDerivedBindingDigest(components[i]!.id);
  }
  record.aggregateBindingDigest = aggregateBindingDigestFor(
    components as Array<{ id: string; acceptedCommit: string; evidenceDigest: string }>);
  const outcome = evaluateReleaseCandidatePrecheckV1(record);
  assert.equal(outcome.status, 'blocked_invalid_inputs',
    'candidate-reconstructed evidence digests are not historical attestation');
  assert.match(outcome.reason, /evidenceDigest-candidate-reconstructed/);
});

test('refuses a record where all 14 component evidence digests collapse to a single attestation', () => {
  // All four distinct-history guards reject records where components don't
  // actually carry distinct per-component witness digests. Even when each
  // digest is independently attested, a record where every component shares
  // the same historical digest is not a multi-component assembled release.
  const singleDigest = historicalEvidenceDigest('shared-witness', 0);
  const components = RELEASE_CANDIDATE_COMPONENT_IDS_V1.map((id, i) => ({
    id, acceptedCommit: commit(`h${i}`), evidenceDigest: singleDigest }));
  const record = {
    schema: RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1,
    candidateCommit: ROOT_CANDIDATE, treeDigest: ROOT_TREE, sourceDigest: ROOT_SOURCE,
    releaseVersion: ROOT_VERSION, artifactDigest: ROOT_ARTIFACT,
    artifactManifestDigest: ROOT_MANIFEST,
    aggregateBindingDigest: aggregateBindingDigestFor(
      components as Array<{ id: string; acceptedCommit: string; evidenceDigest: string }>),
    components,
  };
  const outcome = evaluateReleaseCandidatePrecheckV1(record);
  assert.equal(outcome.status, 'blocked_invalid_inputs',
    'all-equal-digests is not a historical-set attestation');
  assert.match(outcome.reason, /evidenceDigest-not-distinct/);
});

test('forged aggregate binding digest refuses', () => {
  // All 14 components are historically valid and distinct, but the supplied
  // aggregate binding digest is fabricated and does not match the recomputed
  // value. The precheck must refuse with `aggregateBindingDigest-mismatch`.
  const record = historicalCompleteRecord();
  record.aggregateBindingDigest = `sha256:${'e'.repeat(64)}`;
  const outcome = evaluateReleaseCandidatePrecheckV1(record);
  assert.equal(outcome.status, 'blocked_invalid_inputs');
  assert.match(outcome.reason, /aggregateBindingDigest-mismatch/);
});

test('repeated evaluation of exact accepted plain data returns byte-identical canonical output', () => {
  const first = evaluateReleaseCandidatePrecheckV1(historicalCompleteRecord());
  const second = evaluateReleaseCandidatePrecheckV1(historicalCompleteRecord());
  assert.equal(canonicalJson(first), canonicalJson(second));
  if (first.status === 'precheck_complete_not_accepted'
    && second.status === 'precheck_complete_not_accepted') {
    assert.deepEqual(
      (first.components as readonly { evidenceDigest: string }[]).map((c) => c.evidenceDigest),
      (second.components as readonly { evidenceDigest: string }[]).map((c) => c.evidenceDigest));
    assert.deepEqual(
      (first.components as readonly { acceptedCommit: string }[]).map((c) => c.acceptedCommit),
      (second.components as readonly { acceptedCommit: string }[]).map((c) => c.acceptedCommit));
    assert.equal(first.aggregateBinding.supplied, second.aggregateBinding.supplied);
    assert.equal(first.aggregateBinding.recomputed, second.aggregateBinding.recomputed);
  } else assert.fail('complete required');
});

test('the 14 canonical component identities are frozen at runtime and cannot be shortened', () => {
  const frozen = RELEASE_CANDIDATE_COMPONENT_IDS_V1;
  assert.ok(Object.isFrozen(frozen), 'component IDs must be frozen');
  assert.equal(frozen.length, 14);
  let caught = false;
  try { (frozen as unknown as string[]).length = 0; } catch { caught = true; }
  assert.equal(frozen.length, 14, 'shortening the component IDs is rejected');
  assert.ok(caught || frozen.length === 14);
});

test('mutation regression — the exported component ID array refuses a shortened precheck', () => {
  const record = historicalCompleteRecord();
  record.components = (record.components as unknown[]).slice(0, 13) as typeof record.components;
  const outcome = evaluateReleaseCandidatePrecheckV1(record);
  assert.equal(outcome.status, 'blocked_invalid_inputs');
  if (outcome.status !== 'blocked_invalid_inputs') assert.fail('refusal required');
  assert.match(outcome.reason, /component-count/);
});

test('missing record, field, artifact binding, aggregate binding or required component returns blocked state', () => {
  for (const input of [undefined, null, 42, 'record', []]) {
    const outcome = evaluateReleaseCandidatePrecheckV1(input);
    assert.equal(outcome.status, 'blocked_missing_inputs');
  }
  for (const field of ['candidateCommit', 'treeDigest', 'sourceDigest',
    'releaseVersion', 'artifactDigest', 'artifactManifestDigest',
    'aggregateBindingDigest', 'components', 'schema']) {
    const record = historicalCompleteRecord() as Record<string, unknown>;
    delete record[field];
    const outcome = evaluateReleaseCandidatePrecheckV1(record);
    assert.equal(outcome.status, 'blocked_missing_inputs', field);
    if (outcome.status !== 'blocked_missing_inputs') assert.fail('missing required');
    assert.match(outcome.reason, /^[A-Za-z0-9:[\]._-]+$/);
  }
  const noEvidence = historicalCompleteRecord();
  delete (noEvidence.components[3] as Record<string, unknown>).evidenceDigest;
  assert.equal(evaluateReleaseCandidatePrecheckV1(noEvidence).status, 'blocked_missing_inputs');
});

test('extra or duplicate components, unknown fields, wrong order and malformed values are refused', () => {
  const extra = historicalCompleteRecord() as Record<string, unknown>;
  extra.surprise = 'nope';
  assert.equal(evaluateReleaseCandidatePrecheckV1(extra).status, 'blocked_invalid_inputs');
  const swapped = historicalCompleteRecord();
  [swapped.components[0], swapped.components[1]] = [swapped.components[1]!, swapped.components[0]!];
  assert.equal(evaluateReleaseCandidatePrecheckV1(swapped).status, 'blocked_invalid_inputs');
  for (const mutate of [
    (r: ReturnType<typeof historicalCompleteRecord>) => { r.releaseVersion = 'v1'; },
    (r: ReturnType<typeof historicalCompleteRecord>) => { r.releaseVersion = '1.2'; },
    (r: ReturnType<typeof historicalCompleteRecord>) => { r.candidateCommit = 'short'; },
    (r: ReturnType<typeof historicalCompleteRecord>) => { r.candidateCommit = 'Z'.repeat(40); },
    (r: ReturnType<typeof historicalCompleteRecord>) => { r.treeDigest = 'sha256:xyz'; },
    (r: ReturnType<typeof historicalCompleteRecord>) => { r.artifactDigest = digest('ok').toUpperCase(); },
    (r: ReturnType<typeof historicalCompleteRecord>) => { (r.components[0] as Record<string, unknown>).frobnicate = 1; },
    (r: ReturnType<typeof historicalCompleteRecord>) => { (r.components[0] as { acceptedCommit: string }).acceptedCommit = commit('ok') + 'extra'; },
    (r: ReturnType<typeof historicalCompleteRecord>) => { r.aggregateBindingDigest = 'sha256:short'; },
  ]) {
    const record = historicalCompleteRecord();
    mutate(record);
    assert.equal(evaluateReleaseCandidatePrecheckV1(record).status, 'blocked_invalid_inputs');
  }
});

test('a historical record where the aggregate binding digest omits the digest set refuses', () => {
  // Build a record where the supplied aggregateBindingDigest was computed
  // against a stale or partial digest set (e.g. with one component omitted)
  // — provides an audit-trail of when the binding was last recomputed.
  const record = historicalCompleteRecord();
  const components = record.components as { evidenceDigest: string; id: string;
    acceptedCommit: string }[];
  const trimmed: Array<{ id: string; acceptedCommit: string;
    evidenceDigest: string }> = components.slice(0, components.length - 1)
    .map((c) => ({ id: c.id, acceptedCommit: c.acceptedCommit,
      evidenceDigest: c.evidenceDigest }));
  record.aggregateBindingDigest = aggregateBindingDigestFor(trimmed);
  const outcome = evaluateReleaseCandidatePrecheckV1(record);
  assert.equal(outcome.status, 'blocked_invalid_inputs');
  assert.match(outcome.reason, /aggregateBindingDigest-mismatch/);
});

test('secret-, credential-, URL-, locator- or filesystem-shaped values are refused', () => {
  for (const evil of ['«redacted:sk-…»',
    'https://example.test/artifact.tgz', '/etc/passwd', 'C:\\release\\a.tgz',
    '${ARTIFACT_DIGEST}', '..\\..\\secret', 'sha256:' + 'g'.repeat(64)]) {
    const record = historicalCompleteRecord();
    record.artifactDigest = evil;
    const outcome = evaluateReleaseCandidatePrecheckV1(record);
    assert.equal(outcome.status, 'blocked_invalid_inputs', evil.slice(0, 12));
    if (outcome.status !== 'blocked_invalid_inputs') assert.fail('refusal required');
    assert.doesNotMatch(canonicalJson(outcome), /sk-live|example\.test|passwd/);
  }
});

test('inherited, non-enumerable, Symbol, accessor and Proxy inputs are refused without executing attacker code', () => {
  let getterRan = false, trapRan = false;
  const accessored: Record<string, unknown> = { ...historicalCompleteRecord() };
  Object.defineProperty(accessored, 'candidateCommit', { enumerable: true,
    get() { getterRan = true; return ROOT_CANDIDATE; }, configurable: true });
  assert.equal(evaluateReleaseCandidatePrecheckV1(accessored).status, 'blocked_invalid_inputs');
  assert.equal(getterRan, false);
  const symbolled = historicalCompleteRecord() as Record<string | symbol, unknown>;
  symbolled[Symbol('smuggle')] = 'x';
  assert.equal(evaluateReleaseCandidatePrecheckV1(symbolled).status, 'blocked_invalid_inputs');
  const hidden = historicalCompleteRecord() as Record<string, unknown>;
  Object.defineProperty(hidden, 'treeDigest', { enumerable: false, value: digest('t1') });
  assert.equal(evaluateReleaseCandidatePrecheckV1(hidden).status, 'blocked_invalid_inputs');
  const parent = { candidateCommit: ROOT_CANDIDATE };
  const child = Object.create(parent);
  Object.assign(child, historicalCompleteRecord(), { candidateCommit: undefined });
  delete child.candidateCommit;
  assert.equal(evaluateReleaseCandidatePrecheckV1(child).status, 'blocked_invalid_inputs');
  const proxied = new Proxy(historicalCompleteRecord(), { get() {
    trapRan = true; throw new Error('must_not_execute'); } });
  const proxiedOutcome = evaluateReleaseCandidatePrecheckV1(proxied);
  assert.equal(proxiedOutcome.status, 'blocked_invalid_inputs');
  assert.equal(trapRan, false);
  const sparse: unknown[] = [];
  sparse[3] = digest('hidden');
  assert.equal(evaluateReleaseCandidatePrecheckV1(sparse).status, 'blocked_invalid_inputs');
  const arrWithHidden: unknown[] = [];
  Object.defineProperty(arrWithHidden, 'smuggle', { value: 'x', enumerable: true });
  assert.equal(evaluateReleaseCandidatePrecheckV1(arrWithHidden).status, 'blocked_invalid_inputs');
  const revoked = Proxy.revocable(historicalCompleteRecord(), {});
  revoked.revoke();
  assert.equal(evaluateReleaseCandidatePrecheckV1(revoked.proxy).status, 'blocked_invalid_inputs');
});

test('attacker code never runs during reflection — every hostile reflection path is refused', () => {
  const protoTrapTarget: Record<string, unknown> = { ...historicalCompleteRecord() };
  let protoTrapRan = false;
  const protoTrap = new Proxy(protoTrapTarget, { getPrototypeOf() {
    protoTrapRan = true; return null; } });
  assert.equal(evaluateReleaseCandidatePrecheckV1(protoTrap).status, 'blocked_invalid_inputs');
  assert.equal(protoTrapRan, false);

  const ownKeysTrapTarget: Record<string, unknown> = { ...historicalCompleteRecord() };
  let ownKeysTrapRan = false;
  const ownKeysTrap = new Proxy(ownKeysTrapTarget, { ownKeys() {
    ownKeysTrapRan = true; return Object.keys(historicalCompleteRecord()); } });
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
  const precheckSource = readFileSync(new URL('../src/release-candidate-precheck/v1/precheck.ts',
    import.meta.url), 'utf8');
  assert.match(precheckSource, /from 'node:util'/);
  const otherSources = files.filter((f) => f !== 'src/release-candidate-precheck/v1/precheck.ts')
    .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
  for (const src of otherSources) {
    assert.doesNotMatch(src, /from 'node:util'/, 'node:util import confined to precheck.ts');
  }
});
