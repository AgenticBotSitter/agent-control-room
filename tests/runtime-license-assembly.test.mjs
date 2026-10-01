import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assembleRuntimeLicenses,
  assertRetainedAttachments,
  findRetainedMissingRootEvidence,
} from '../scripts/runtime-license-assembly.mjs';

const retainedRow = () => ({
  root: 'third_party/http_ece',
  provenance: {
    source: 'npm:http_ece@1.2.0',
    distributionIntegrity: 'sha512-pinned',
    qualification: 'pinned upstream text',
  },
  evidenceFiles: [{ file: 'LICENSE', bytes: 4, sha256: 'a'.repeat(64) }],
  mismatches: [],
});

test('missing-root retained evidence requires exact identity, provenance, and clean pinned files', () => {
  const record = { name: 'http_ece', version: '1.2.0' };
  assert.deepEqual(findRetainedMissingRootEvidence(record, [retainedRow()]), retainedRow());
  for (const mutate of [
    row => { row.root = 'src/vendor/http_ece'; },
    row => { row.root = 'third_party/http_ece/nested'; },
    row => { row.provenance.source = 'npm:http_ece@1.1.0'; },
    row => { row.provenance.distributionIntegrity = ''; },
    row => { row.provenance.qualification = ''; },
    row => { row.evidenceFiles = []; },
    row => { row.mismatches = [{ reason: 'changed' }]; },
  ]) {
    const row = retainedRow();
    mutate(row);
    assert.equal(findRetainedMissingRootEvidence(record, [row]), undefined);
  }
  assert.equal(findRetainedMissingRootEvidence(null, [retainedRow()]), undefined);
  assert.equal(findRetainedMissingRootEvidence(record, null), undefined);
});

test('retained attachment metadata must match the reviewed evidence exactly', () => {
  const expected = [{ file: 'LICENSE', bytes: 4, sha256: 'a'.repeat(64) }];
  assert.doesNotThrow(() => assertRetainedAttachments([{ ...expected[0], base64: 'dGVzdA==' }], expected));
  assert.throws(
    () => assertRetainedAttachments([{ ...expected[0], sha256: 'b'.repeat(64), base64: 'dGVzdA==' }], expected),
    /retained license evidence changed/,
  );
});

test('actual collector assembles every pinned package instance while retaining provenance gaps', () => {
  const result = assembleRuntimeLicenses();
  assert.equal(result.entries.length, 225); assert.equal(result.rawMissingRootTexts.length, 5);
  assert.equal(result.completeDistributionClearance, false);
  assert.match(result.entries.find(entry => entry.name === '@nodable/entities').qualification, /not resolved/);
  const httpEce = result.entries.find(entry => entry.name === 'http_ece');
  assert.equal(httpEce.provenance, 'pinned_npm_release_integrity');
  assert.match(httpEce.qualification, /exact npm gitHead/);
  assert.equal(httpEce.attachments[0].sha256, '717363ac0c7f0883042868db171cfed1f4b423119249eac9bce5131291017ea8');
  assert.equal(result.entries.filter(entry => entry.provenance !== 'installed_root_text').length, 5);
  for (const entry of result.entries) for (const attachment of entry.attachments) {
    const bytes = Buffer.from(attachment.base64, 'base64');
    assert.equal(bytes.length, attachment.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), attachment.sha256);
  }
});
