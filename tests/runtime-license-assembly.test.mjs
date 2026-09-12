import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assembleRuntimeLicenses } from '../scripts/runtime-license-assembly.mjs';
test('actual collector assembles every pinned package instance while retaining provenance gaps', () => {
  const result = assembleRuntimeLicenses();
  assert.equal(result.entries.length, 193); assert.equal(result.rawMissingRootTexts.length, 4);
  assert.equal(result.completeDistributionClearance, false);
  assert.match(result.entries.find(entry => entry.name === '@nodable/entities').qualification, /not resolved/);
  assert.equal(result.entries.filter(entry => entry.provenance !== 'installed_root_text').length, 4);
  for (const entry of result.entries) for (const attachment of entry.attachments) {
    const bytes = Buffer.from(attachment.base64, 'base64');
    assert.equal(bytes.length, attachment.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), attachment.sha256);
  }
});
