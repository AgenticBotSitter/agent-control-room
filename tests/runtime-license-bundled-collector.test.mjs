// Tests for the artifact-derived bundled-collector. Walks third_party/ +
// src/vendor/ and produces rows with file hashes + provenance. Refuses
// caller-supplied paths that escape the repository.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { collectBundledRows, readExceptions } from '../scripts/runtime-license-bundled-collector.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

test('retained npm provenance requires exact identity, integrity, and pinned bytes', () => {
  const repo = makeFixtureRepo(), license = 'MIT LICENSE\n';
  try {
    fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), "packages:\n\n  'pg@1.0.0':\n    resolution: {integrity: sha512-exact}\n");
    fs.mkdirSync(path.join(repo, 'research'), { recursive: true });
    const write = value => fs.writeFileSync(path.join(repo, 'research/runtime-license-retained-provenance.json'), JSON.stringify({ roots: { 'third_party/pg': value } }));
    write({ packageName: 'pg', packageVersion: '1.0.0', sourceCommit: null, qualification: 'pinned_npm_release_integrity', files: [{ file: 'LICENSE', bytes: license.length, sha256: hash(license) }] });
    let row = collectBundledRows(repo).find(value => value.root === 'third_party/pg');
    assert.equal(row.provenance.distributionIntegrity, 'sha512-exact');
    fs.writeFileSync(path.join(repo, 'third_party/pg/LICENSE'), 'altered');
    row = collectBundledRows(repo).find(value => value.root === 'third_party/pg');
    assert.equal(row.mismatches[0].reason, 'reviewed_retained_file_mismatch');
    fs.writeFileSync(path.join(repo, 'third_party/pg/LICENSE'), license); // mutation/revert sensitivity
    assert.equal(collectBundledRows(repo).find(value => value.root === 'third_party/pg').mismatches.length, 0);
    write({ packageName: 'pg', packageVersion: '2.2.0', files: [] });
    assert.throws(() => collectBundledRows(repo), /retained_provenance_lock_integrity_missing:pg@2.2.0/);
    fs.mkdirSync(path.join(repo, 'third_party/nodable-entities'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'third_party/nodable-entities/LICENSE'), 'entities license');
    fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), "packages:\n\n  'pg@1.0.0':\n    resolution: {integrity: sha512-exact}\n\n  '@nodable/entities@3.0.0':\n    resolution: {integrity: sha512-entities-3}\n");
    const entities = 'entities license';
    fs.writeFileSync(path.join(repo, 'research/runtime-license-retained-provenance.json'), JSON.stringify({ roots: {
      'third_party/nodable-entities': { packageName: '@nodable/entities', packageVersion: '3.0.0', sourceCommit: null, files: [{ file: 'LICENSE', bytes: entities.length, sha256: hash(entities) }] },
    } }));
    let entityRow = collectBundledRows(repo).find(value => value.root === 'third_party/nodable-entities');
    assert.equal(entityRow.provenance.distributionIntegrity, 'sha512-entities-3');
    fs.writeFileSync(path.join(repo, 'research/runtime-license-retained-provenance.json'), JSON.stringify({ roots: {
      'third_party/nodable-entities': { packageName: '@nodable/entities', packageVersion: '2.2.0', sourceCommit: null, files: [{ file: 'LICENSE', bytes: entities.length, sha256: hash(entities) }] },
    } }));
    assert.throws(() => collectBundledRows(repo), /retained_provenance_lock_integrity_missing:@nodable\/entities@2.2.0/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

function makeFixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-coll-'));
  fs.mkdirSync(path.join(repo, 'third_party', 'pg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'third_party', 'pg', 'LICENSE'), 'MIT LICENSE\n');
  fs.mkdirSync(path.join(repo, 'third_party', 'pg', 'PROVENANCE.dir'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'vendor', 'control-center'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'vendor', 'control-center', 'feed-discovery.ts'), 'export {};\n');
  // Saxes-style: PROVENANCE.json + upstream-package.json
  fs.mkdirSync(path.join(repo, 'third_party', 'saxes'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'third_party', 'saxes', 'PROVENANCE.json'), JSON.stringify({
    name: 'saxes', installedVersion: '6.0.0', sourceCommit: '0'.repeat(40),
    qualification: 'test_fixture_only; upstream revision not verified',
  }));
  fs.writeFileSync(path.join(repo, 'third_party', 'saxes', 'LICENSE'), 'ISC LICENSE\n');
  return repo;
}

test('bundled collector walks third_party and src/vendor', () => {
  const repo = makeFixtureRepo();
  try {
    const rows = collectBundledRows(repo);
    const names = rows.map(r => `${r.package}@${r.root}`).sort();
    assert.deepEqual(names, [
      'control-center@src/vendor/control-center',
      'pg@third_party/pg',
      'saxes@third_party/saxes',
    ]);
    for (const r of rows) {
      // Each row carries both evidenceFiles (PROVENANCE-pinned) and
      // discoveredFiles (walked). Either may be empty depending on
      // PROVENANCE.json presence.
      assert.ok(Array.isArray(r.evidenceFiles));
      assert.ok(Array.isArray(r.discoveredFiles));
      for (const f of [...r.evidenceFiles, ...r.discoveredFiles]) {
        assert.match(f.sha256, /^[0-9a-f]{64}$/);
        assert.ok(f.bytes > 0);
        assert.ok(f.bytes <= 2_000_000);
      }
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled collector reads existing PROVENANCE.json verbatim', () => {
  const repo = makeFixtureRepo();
  try {
    const rows = collectBundledRows(repo);
    const saxes = rows.find(r => r.package === 'saxes');
    assert.equal(saxes.provenance.sourceCommit, '0'.repeat(40));
    assert.equal(saxes.provenance.installedVersion, '6.0.0');
    assert.equal(saxes.provenance.qualification, 'test_fixture_only; upstream revision not verified');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled collector synthesizes missing_provenance for unreviewed third_party', () => {
  const repo = makeFixtureRepo();
  try {
    const rows = collectBundledRows(repo);
    const pg = rows.find(r => r.package === 'pg' && r.root === 'third_party/pg');
    assert.equal(pg.provenance.sourceCommit, null);
    assert.equal(pg.provenance.installedVersion, null);
    assert.match(pg.provenance.qualification, /missing_provenance/);
    // Without PROVENANCE.json, evidenceFiles is empty but discoveredFiles
    // still records the walked files (for drift detection).
    assert.equal(pg.evidenceFiles.length, 0);
    assert.ok(pg.discoveredFiles.length > 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled collector marks declared vendor roots with declared_vendor_root qualification', () => {
  const repo = makeFixtureRepo();
  try {
    const rows = collectBundledRows(repo);
    const cc = rows.find(r => r.package === 'control-center');
    assert.match(cc.provenance.qualification, /declared_vendor_root/);
    assert.equal(cc.provenance.sourceCommit, null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled collector skips symlinks and oversized files', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-sym-'));
  try {
    fs.mkdirSync(path.join(repo, 'third_party', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'third_party', 'pkg', 'LICENSE'), 'real');
    const big = Buffer.alloc(3_000_000, 0x61);
    try { fs.writeFileSync(path.join(repo, 'third_party', 'pkg', 'BIG'), big); } catch { /* fs may refuse */ }
    // Symlink to outside the repo
    try { fs.symlinkSync('/tmp', path.join(repo, 'third_party', 'pkg', 'ext')); } catch { /* ignore */ }
    const rows = collectBundledRows(repo);
    const pkg = rows.find(r => r.package === 'pkg');
    const fileNames = pkg.discoveredFiles.map(f => f.file);
    assert.ok(fileNames.includes('LICENSE'));
    // BIG might fail to write on some filesystems (ENOSPC) so check conditionally
    if (fileNames.includes('BIG')) {
      const bigRow = pkg.discoveredFiles.find(f => f.file === 'BIG');
      assert.ok(bigRow.bytes <= 2_000_000);
    }
    assert.ok(!fileNames.includes('ext'), 'symlink must be skipped');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled collector returns deterministic order', () => {
  const repo = makeFixtureRepo();
  try {
    const a = collectBundledRows(repo);
    const b = collectBundledRows(repo);
    assert.deepEqual(a, b);
    // Packages in alphabetical order
    const packages = a.map(r => r.package);
    assert.deepEqual([...packages].sort(), packages);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled collector normalizes Windows backslashes to forward slashes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-bs-'));
  try {
    fs.mkdirSync(path.join(repo, 'third_party', 'win-pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'third_party', 'win-pkg', 'LICENSE'), 'MIT\n');
    const rows = collectBundledRows(repo);
    const pkg = rows.find(r => r.package === 'win-pkg');
    assert.equal(pkg.root, 'third_party/win-pkg');
    for (const f of pkg.discoveredFiles) {
      assert.ok(!f.file.includes('\\'), `file path still contains backslash: ${f.file}`);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('readExceptions returns empty entries when no exceptions file', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-'));
  try {
    const result = readExceptions(repo);
    assert.deepEqual(result.entries, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('readExceptions parses a real exceptions.json', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-'));
  try {
    fs.mkdirSync(path.join(repo, 'research'), { recursive: true });
    const data = { scope: 'test', entries: [{ name: 'pg-types', version: '2.2.0', manifestSha256: 'm', textSha256: 't', sourceFile: 'README.md', textFile: 'third_party/pg-types/LICENSE.from-README.md', sourceSha256: 's' }] };
    fs.writeFileSync(path.join(repo, 'research', 'runtime-license-exceptions.json'), JSON.stringify(data));
    const result = readExceptions(repo);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].name, 'pg-types');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
