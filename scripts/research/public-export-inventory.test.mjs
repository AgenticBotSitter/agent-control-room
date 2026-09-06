import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';

test('planning inventory covers current tracked inputs without approving their publication', () => {
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/research/public-export-inventory.mjs'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
    .filter(file => file && file !== 'docs/research/public-export-inventory.json').sort();
  assert.deepEqual(report.entries.map(entry => entry.path), paths);
  assert.equal(report.publicationApproved, false);
  assert.equal(Object.values(report.counts).reduce((a, b) => a + b, 0), paths.length);
  for (const entry of report.entries) {
    assert.equal(entry.review, 'pending');
    assert.notEqual(entry.disposition, 'approved');
    assert.equal(entry.sha256, lstatSync(entry.path).isFile()
      ? createHash('sha256').update(readFileSync(entry.path)).digest('hex') : null);
  }
  assert.equal(report.entries.find(entry => entry.path === 'public/favicon.svg').reason,
    'startup_required_asset_rights_pending');
  assert.equal(report.entries.find(entry => entry.path === '.openai/hosting.json').disposition, 'exclude');
  assert.ok(report.unresolved.every(entry => entry.file.startsWith('dist-vps/')));
  assert.ok(report.dynamic.some(entry => entry.file === 'scripts/run-private-vps.mjs'));
});
