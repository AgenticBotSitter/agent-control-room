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
  assert.ok(report.compilerSeeds.includes('middleware.ts'));
  assert.ok(report.compilerSeeds.includes('src/web/v1/private-task-host.ts'));
  assert.ok(report.compilerSeeds.includes('private-app/app/layout.tsx'));
  for (const file of report.compilerSeeds)
    assert.equal(report.entries.find(entry => entry.path === file)?.reason, 'application_or_build_import');
  for (const file of ['tsconfig.json', 'tsconfig.vps.json'])
    assert.equal(report.entries.find(entry => entry.path === file).disposition, 'adapt');
  assert.ok(report.unresolved.every(entry => entry.file.startsWith('dist-vps/')));
  assert.ok(report.dynamic.some(entry => entry.file === 'scripts/run-private-vps.mjs'));
});

test('compiled-test inventory follows selected tests and helpers without executing package commands', () => {
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/research/public-export-inventory.mjs', '--with-compiled-tests'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  assert.ok(report.testSeeds.includes('tests/vps-built-task-startup.test.mjs'));
  assert.ok(report.testSeeds.includes('tests/vps-built-launcher.test.mjs'));
  assert.ok(!report.testSeeds.includes('tests/sites-preview-build-profile.test.ts'));
  for (const file of ['tests/helpers/task-startup.ts', 'tests/helpers/web-foundation.ts'])
    assert.equal(report.entries.find(entry => entry.path === file).reason, 'application_or_build_import');
  assert.equal(report.publicationApproved, false);
});
