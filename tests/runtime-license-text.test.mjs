import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRuntimeLicenses } from '../scripts/runtime-license-assembly.mjs';
import { renderRuntimeLicenseText } from '../scripts/runtime-license-text.mjs';

test('release notice text preserves every original attachment and unresolved qualification', () => {
  const assembly = assembleRuntimeLicenses();
  const output = renderRuntimeLicenseText(assembly);
  assert.match(output.toString(), /NOT complete distribution clearance/);
  assert.match(output.toString(), /source manifest 2.2.0 differs from installed 3.0.0; not resolved/);
  for (const entry of assembly.entries) for (const attachment of entry.attachments) {
    assert.ok(output.includes(Buffer.from(attachment.base64, 'base64')));
  }
  assert.deepEqual(output, renderRuntimeLicenseText(assembly));
  const changed = structuredClone(assembly);
  changed.entries[0].attachments[0].base64 = Buffer.from('replaced notice').toString('base64');
  assert.throws(() => renderRuntimeLicenseText(changed), /attachment length changed|attachment hash changed/);
  const missing = structuredClone(assembly);
  missing.entries[0].attachments = [];
  assert.throws(() => renderRuntimeLicenseText(missing));
  assert.throws(() => renderRuntimeLicenseText({ ...assembly, completeDistributionClearance: true }));
});
