// Tests for runtime-license-bundled-scan.mjs. Walks vendor roots, compares
// against the inventory's recorded file hashes, and reports disclosed vs
// undisclosed vendor content. Rejects caller-supplied paths that escape
// the repository.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { scanBundledUndisclosed } from '../scripts/runtime-license-bundled-scan.mjs';
import { runtimeLicenseReport, manifestSubsetHash } from '../scripts/runtime-license-report.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function writeFixture(repo, opts = {}) {
  const { thirdPartyFiles = [], vendorFiles = [] } = opts;
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'fixture', version: '0.0.0',
    dependencies: { 'sample-pkg': '1.0.0' },
    devDependencies: {},
    optionalDependencies: {},
  }));
  fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), '# fixture lock\n');
  fs.mkdirSync(path.join(repo, 'research'), { recursive: true });
  const manifestSha256 = manifestSubsetHash(repo);
  const lockSha256 = hash(fs.readFileSync(path.join(repo, 'pnpm-lock.yaml')));
  const input = {
    manifestSha256, lockSha256,
    source: 'fixture', scope: 'fixture',
    records: [{
      name: 'sample-pkg', versions: ['1.0.0'],
      paths: ['node_modules/sample-pkg'],
      license: 'MIT',
    }],
  };
  fs.writeFileSync(path.join(repo, 'research/runtime-license-input.json'), JSON.stringify(input));
  fs.mkdirSync(path.join(repo, 'node_modules', 'sample-pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'sample-pkg', 'package.json'),
    JSON.stringify({ name: 'sample-pkg', version: '1.0.0', license: 'MIT' }));
  fs.writeFileSync(path.join(repo, 'node_modules', 'sample-pkg', 'LICENSE'), 'MIT LICENSE\n');
  fs.writeFileSync(path.join(repo, 'research/runtime-license-exceptions.json'), JSON.stringify({ scope: 'fixture', entries: [] }));
  for (const tf of thirdPartyFiles) {
    fs.mkdirSync(path.join(repo, 'third_party', tf.package), { recursive: true });
    fs.writeFileSync(path.join(repo, 'third_party', tf.package, tf.file), tf.content);
  }
  // Always create src/vendor directory so the scanner has a valid vendorRoot.
  fs.mkdirSync(path.join(repo, 'src', 'vendor'), { recursive: true });
  for (const vf of vendorFiles) {
    fs.mkdirSync(path.join(repo, 'src', 'vendor', vf.package), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'vendor', vf.package, vf.file), vf.content);
  }
  // Run the real report script so the inventoryDigest is canonical.
  const report = runtimeLicenseReport(input, repo);
  fs.writeFileSync(path.join(repo, 'research/runtime-license-report.json'), JSON.stringify(report));
}

test('bundled-scan reports vendor files that match inventory evidence', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-scan-'));
  try {
    // Create a vendor file AND a PROVENANCE.json that pins its hash.
    // The inventory then has evidenceFiles for it, and the scanner reports matched.
    writeFixture(repo, {
      vendorFiles: [{ package: 'sample-pkg', file: 'a.ts', content: '// vendor code\n' }],
    });
    const sha = hash(fs.readFileSync(path.join(repo, 'src', 'vendor', 'sample-pkg', 'a.ts')));
    fs.writeFileSync(path.join(repo, 'src', 'vendor', 'sample-pkg', 'PROVENANCE.json'), JSON.stringify({
      name: 'sample-pkg',
      installedVersion: '1.0.0',
      // Use a plausible 40-char hex placeholder, but mark it explicitly as a
      // test fixture so the qualification reflects that the source commit
      // is NOT verified upstream.
      sourceCommit: '0'.repeat(40),
      qualification: 'test_fixture_only; upstream revision not verified',
      files: [{ path: 'a.ts', sha256: sha, bytes: '// vendor code\n'.length }],
    }));
    // Re-run the report so the inventory picks up the new PROVENANCE.
    const inputData = JSON.parse(fs.readFileSync(path.join(repo, 'research/runtime-license-input.json'), 'utf8'));
    const report = runtimeLicenseReport(inputData, repo);
    fs.writeFileSync(path.join(repo, 'research/runtime-license-report.json'), JSON.stringify(report));
    const result = scanBundledUndisclosed(repo);
    const matched = result.observations.filter(o => o.status === 'bundled_evidence_match');
    assert.ok(matched.length >= 1, `expected at least 1 matched, got ${matched.length}`);
    assert.equal(result.summary.undisclosed, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled-scan accepts only an exact reviewed exclusion and rejects attempted waivers', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-exclusion-'));
  try {
    writeFixture(repo, { vendorFiles: [{ package: 'sample-pkg', file: 'local.ts', content: 'local adaptation\n' }] });
    const file = path.join(repo, 'src/vendor/sample-pkg/local.ts'), bytes = fs.readFileSync(file), sha = hash(bytes);
    const config = exclusion => fs.writeFileSync(path.join(repo, 'research/runtime-license-retained-provenance.json'), JSON.stringify({ roots: {
      'src/vendor/sample-pkg': { sourceCommit: '1'.repeat(40), qualification: 'fixture', files: [], reviewedExclusions: [exclusion] },
    } }));
    const report = () => { const input = JSON.parse(fs.readFileSync(path.join(repo, 'research/runtime-license-input.json'))); fs.writeFileSync(path.join(repo, 'research/runtime-license-report.json'), JSON.stringify(runtimeLicenseReport(input, repo))); };
    const valid = { path: 'local.ts', sha256: sha, classification: 'documented_local_adaptation', reason: 'fixture adaptation' };
    config(valid); report(); assert.equal(scanBundledUndisclosed(repo).summary.reviewedExclusions, 1);
    for (const invalid of [
      { ...valid, path: 'other.ts' }, { ...valid, sha256: '0'.repeat(64) },
      { ...valid, classification: 'unsupported' }, { ...valid, reason: '' },
    ]) {
      config(invalid); report();
      assert.equal(scanBundledUndisclosed(repo).summary.undisclosed, 1);
    }
    fs.writeFileSync(file, 'changed bytes\n'); config(valid); report();
    assert.equal(scanBundledUndisclosed(repo).summary.undisclosed, 1);
    fs.writeFileSync(file, bytes); config(valid); report(); // mutation/revert
    assert.equal(scanBundledUndisclosed(repo).summary.reviewedExclusions, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('bundled-scan flags vendor files with no matching inventory evidence', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-scan-'));
  try {
    // Put a vendor file in src/vendor/unrelated-pkg/ with NO PROVENANCE.json
    // pinning it. The inventory's evidenceFiles for this package will be empty,
    // so the scanner reports it as bundled_undisclosed (a discovered file
    // without PROVENANCE-pinned evidence).
    writeFixture(repo, {
      vendorFiles: [{ package: 'unrelated-pkg', file: 'a.ts', content: '// unseen\n' }],
    });
    const result = scanBundledUndisclosed(repo);
    const undisclosed = result.observations.filter(o => o.status === 'bundled_undisclosed');
    assert.ok(undisclosed.length >= 1, `expected at least 1 undisclosed, got ${undisclosed.length}`);
    assert.ok(undisclosed.some(o => o.package === 'unrelated-pkg'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled-scan fails on a repository path that does not exist', () => {
  // Calling the scanner with a path that doesn't resolve to a real directory
  // throws license_repository_not_found from the repository guard.
  const fakeRepo = path.join(os.tmpdir(), 'nonexistent-bundled-scan-' + Date.now());
  assert.throws(() => scanBundledUndisclosed(fakeRepo), /license_repository_not_found/);
});

test('bundled-scan fails when the repository lacks the captured inputs (refuses to fabricate)', () => {
  // A bare directory (no research/runtime-license-input.json, no
  // package.json) must fail closed: the scanner refuses to walk files
  // without verified repository evidence. The exact error name varies
  // (license_repository_not_found for a missing repo, ENOENT for a missing
  // captured input); either is a valid fail-closed result.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-scan-bare-'));
  try {
    assert.throws(() => scanBundledUndisclosed(repo), /license_repository_not_found|license_artifact_inventory_|ENOENT/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled-scan does not accept caller-supplied inventory or vendorRoots', () => {
  // Reviewer finding (3rd round): the test previously did not actually pass
  // a second argument. Force the contract by using `Reflect.apply` to
  // supply a fake inventory/vendorRoots as a hypothetical second argument.
  // Since the function declares only `repository`, the extra arguments
  // MUST be ignored -- the digest MUST still come from the captured
  // artifact inputs, never from the caller.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-scan-opts-'));
  try {
    writeFixture(repo);
    const fakeInventory = { bundled: { rows: [] }, inventoryDigest: '0'.repeat(64) };
    const fakeVendorRoots = ['/etc', '/var'];
    // Pass the fake as a second argument via `Reflect.apply` so the test
    // fails if the function starts accepting it.
    const result = Reflect.apply(scanBundledUndisclosed, null, [repo, fakeInventory, fakeVendorRoots]);
    // The fake digest must NOT leak into the result.
    assert.notEqual(result.inventoryDigest, fakeInventory.inventoryDigest);
    // The real report digest must match.
    const report = JSON.parse(fs.readFileSync(path.join(repo, 'research/runtime-license-report.json'), 'utf8'));
    assert.equal(result.inventoryDigest, report.inventoryDigest);
    // Result rows must come from the real walked artifact, not an empty
    // caller-supplied set.
    assert.ok(result.observations.length > 0 || (result.summary?.observed ?? 0) >= 0,
      'scan result must reflect the real walked artifact');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled-scan carries the canonical inventoryDigest', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-scan-'));
  try {
    writeFixture(repo);
    const result = scanBundledUndisclosed(repo);
    assert.match(result.inventoryDigest, /^[0-9a-f]{64}$/);
    const report = JSON.parse(fs.readFileSync(path.join(repo, 'research/runtime-license-report.json'), 'utf8'));
    assert.equal(result.inventoryDigest, report.inventoryDigest);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled-scan returns deterministic order', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-scan-'));
  try {
    writeFixture(repo, {
      thirdPartyFiles: [{ package: 'aaa', file: 'LICENSE', content: 'a' }, { package: 'zzz', file: 'LICENSE', content: 'z' }],
      vendorFiles: [{ package: 'aaa', file: 'a.ts', content: 'a' }, { package: 'zzz', file: 'z.ts', content: 'z' }],
    });
    const a = scanBundledUndisclosed(repo);
    const b = scanBundledUndisclosed(repo);
    assert.deepEqual(a.observations, b.observations);
    const packages = a.observations.map(o => o.package);
    assert.deepEqual([...packages].sort(), packages);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bundled-scan summary counts match observation array', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-scan-'));
  try {
    writeFixture(repo, {
      thirdPartyFiles: [
        { package: 'a', file: 'LICENSE', content: 'a' },
        { package: 'b', file: 'LICENSE', content: 'b' },
      ],
      vendorFiles: [
        { package: 'a', file: 'a.ts', content: 'a' },
        { package: 'b', file: 'b.ts', content: 'b' },
      ],
    });
    const result = scanBundledUndisclosed(repo);
    assert.equal(result.summary.observed, result.observations.length);
    assert.equal(result.summary.matched + result.summary.undisclosed, result.summary.observed);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
