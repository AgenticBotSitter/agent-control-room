import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import path from 'node:path';
import ts from 'typescript';
import { publicExportImports } from './public-export-imports.mjs';

test('compiler-based planning scan includes type expressions without executing source', () => {
  const source = `
    import { value } from './ordinary';
    export type { Other } from './exported';
    type Shape = import('./type-only').Shape;
    type Factory = typeof import('./factory');
    import Legacy = require('./legacy');
    const lazy = import('./lazy');
    const shared = require('./ordinary');
    const unresolved = import(variable);
    // import('./comment-only')
    const text = "require('./string-only')";
    throw new Error('this must never execute');
  `;
  const scanned = publicExportImports('synthetic.ts', source);
  assert.deepEqual(scanned.imports, ['./ordinary', './exported', './type-only', './factory', './legacy', './lazy']);
  assert.equal(scanned.dynamic.length, 1);
  assert.equal(scanned.dynamic[0].file, 'synthetic.ts');
  assert.equal(scanned.dynamic[0].line, 9);
});

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
    'startup_required_original_asset_license_pending');
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
  // Cross-check our planning scan against the compiler, which also resolves type-only
  // import expressions. A disagreement must be investigated, not silently exported.
  const parsed = ts.getParsedCommandLineOfConfigFile('tsconfig.vps.json', {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const indexed = new Set(report.entries.filter(entry => entry.reason === 'application_or_build_import').map(entry => entry.path));
  for (const source of program.getSourceFiles()) {
    const file = path.relative(process.cwd(), source.fileName);
    if (!file.startsWith('node_modules/')) assert.ok(indexed.has(file), `Compiler source missing from planning closure: ${file}`);
  }
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
test('contributor inventory includes its explicit launcher, browser and verification closure', () => {
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/research/public-export-inventory.mjs',
    '--with-compiled-tests', '--with-contributor-demo'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  for (const file of ['scripts/contributor-demo.mjs', 'contributor-demo/index.html', 'contributor-demo/view.tsx',
    'src/contributor-demo/history-view.ts', 'src/contributor-demo/launcher.ts', 'src/local-pilot/v1/session-http.ts',
    'app/components/contributor-simulation.tsx', 'tests/contributor-demo-runtime.test.ts']) {
    assert.equal(report.entries.find(entry => entry.path === file)?.reason, 'application_or_build_import');
  }
  assert.equal(report.publicationApproved, false);
  assert.ok(report.unresolved.every(entry => entry.file.startsWith('dist-vps/')));
});
