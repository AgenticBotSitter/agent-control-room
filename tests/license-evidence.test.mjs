import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectLicenseEvidence } from '../scripts/license-evidence.mjs';

test('pinned upstream collector preserves installed React license bytes', () => {
  for (const name of ['LICENSE', 'NOTICE']) assert.deepEqual(
    fs.readFileSync(path.join('third_party/cyclonedx-library', name)),
    fs.readFileSync(path.join('node_modules/@cyclonedx/cyclonedx-library', name)));
  const directory = path.resolve('node_modules/react');
  const result = collectLicenseEvidence(directory, path.resolve('node_modules'));
  const license = result.find(value => value.file === 'LICENSE');
  assert.ok(license);
  assert.deepEqual(Buffer.from(license.base64, 'base64'), fs.readFileSync(path.join(directory, 'LICENSE')));
  assert.equal(license.bytes, fs.statSync(path.join(directory, 'LICENSE')).size);
  assert.throws(() => collectLicenseEvidence(process.cwd(), path.resolve('node_modules')), /outside_modules/);
});

test('upstream collector retains multiple texts and refuses unsafe or oversized inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-license-fixtures-'));
  const pkg = path.join(root, 'package'); fs.mkdirSync(pkg);
  try {
    fs.writeFileSync(path.join(pkg, 'LICENSE-MIT'), 'Synthetic MIT fixture\n');
    fs.writeFileSync(path.join(pkg, 'LICENSE-APACHE'), 'Synthetic Apache fixture\n');
    fs.writeFileSync(path.join(pkg, 'NOTICE'), 'Synthetic notice\n');
    const result = collectLicenseEvidence(pkg, root);
    assert.deepEqual(result.map(value => value.file).sort(), ['LICENSE-APACHE', 'LICENSE-MIT', 'NOTICE']);
    for (const entry of result) assert.deepEqual(Buffer.from(entry.base64, 'base64'), fs.readFileSync(path.join(pkg, entry.file)));
    fs.symlinkSync(path.join(pkg, 'NOTICE'), path.join(pkg, 'LICENSE-link'));
    assert.throws(() => collectLicenseEvidence(pkg, root), /license_file_unavailable/);
    fs.unlinkSync(path.join(pkg, 'LICENSE-link'));
    fs.writeFileSync(path.join(pkg, 'LICENSE-large'), Buffer.alloc(2_000_001));
    assert.throws(() => collectLicenseEvidence(pkg, root), /license_file_unavailable/);
    fs.unlinkSync(path.join(pkg, 'LICENSE-large'));
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(pkg, `LICENSE-total-${i}`), Buffer.alloc(1_900_000));
    assert.throws(() => collectLicenseEvidence(pkg, root), /license_collection_incomplete/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
