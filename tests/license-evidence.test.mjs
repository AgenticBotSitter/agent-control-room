import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { collectLicenseEvidence } from '../scripts/license-evidence.mjs';

test('pinned upstream collector preserves installed React license bytes', () => {
  const directory = path.resolve('node_modules/react');
  const result = collectLicenseEvidence(directory, path.resolve('node_modules'));
  const license = result.find(value => value.file === 'LICENSE');
  assert.ok(license);
  assert.deepEqual(Buffer.from(license.base64, 'base64'), fs.readFileSync(path.join(directory, 'LICENSE')));
  assert.equal(license.bytes, fs.statSync(path.join(directory, 'LICENSE')).size);
  assert.throws(() => collectLicenseEvidence(process.cwd(), path.resolve('node_modules')), /outside_modules/);
});
