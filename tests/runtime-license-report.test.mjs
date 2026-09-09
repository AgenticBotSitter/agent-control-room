import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { runtimeLicenseReport } from '../scripts/runtime-license-report.mjs';

test('runtime report binds current manifests, preserves missing texts and rejects changed identities', () => {
  const input = JSON.parse(fs.readFileSync('research/runtime-license-input.json', 'utf8'));
  const saved = JSON.parse(fs.readFileSync('research/runtime-license-report.json', 'utf8'));
  assert.deepEqual(runtimeLicenseReport(input), saved);
  assert.equal(saved.packages, 193);
  assert.deepEqual(saved.missing.map(value => value.name), ['@nodable/entities', 'pg-types', 'pgpass', 'saxes']);
  assert.throws(() => runtimeLicenseReport({ ...input, lockSha256: '0'.repeat(64) }), /inventory_stale/);
  const foreign = structuredClone(input); foreign.records[0].name = 'foreign-package';
  assert.throws(() => runtimeLicenseReport(foreign), /identity_mismatch/);
  const escaped = structuredClone(input); escaped.records[0].paths[0] = 'node_modules/../package.json';
  assert.throws(() => runtimeLicenseReport(escaped), /path_invalid/);
});
