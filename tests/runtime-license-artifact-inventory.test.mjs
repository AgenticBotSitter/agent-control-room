// Tests for runtime-license-artifact-inventory.mjs. Builds the canonical
// inventory from a fixture repository: install stub (node_modules/) + bound
// third_party + declared src/vendor. Asserts staleness guards, embedded
// digest carry-through, caller-path rejection, no-installs-in-tests, and
// deterministic output.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { buildArtifactInventory } from '../scripts/runtime-license-artifact-inventory.mjs';
import { runtimeLicenseReport, manifestSubsetHash } from '../scripts/runtime-license-report.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function writeFixture(repo, { withLicense = true } = {}) {
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'fixture', version: '0.0.0',
    dependencies: { 'sample-pkg': '1.0.0' },
    devDependencies: {},
    optionalDependencies: {},
  }));
  fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), '# fixture lock\n');
  fs.mkdirSync(path.join(repo, 'research'), { recursive: true });
  // Compute the correct manifest hash from the just-written package.json
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
  if (withLicense) {
    fs.writeFileSync(path.join(repo, 'node_modules', 'sample-pkg', 'LICENSE'), 'MIT LICENSE\n');
  }
  fs.mkdirSync(path.join(repo, 'third_party', 'sample-pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'third_party', 'sample-pkg', 'LICENSE'), 'MIT LICENSE\n');
  fs.mkdirSync(path.join(repo, 'src', 'vendor'), { recursive: true });
  if (withLicense !== false) {
    fs.mkdirSync(path.join(repo, 'src', 'vendor', 'sample-pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'vendor', 'sample-pkg', 'a.ts'), 'export const a = 1;\n');
  }
  fs.writeFileSync(path.join(repo, 'research/runtime-license-exceptions.json'), JSON.stringify({ scope: 'fixture', entries: [] }));
  // Run the real report script — it's what produces the embedded inventoryDigest.
  const inputData = JSON.parse(fs.readFileSync(path.join(repo, 'research/runtime-license-input.json'), 'utf8'));
  const report = runtimeLicenseReport(inputData, repo);
  fs.writeFileSync(path.join(repo, 'research/runtime-license-report.json'), JSON.stringify(report));
}

test('buildArtifactInventory produces canonical inventory with embedded digest', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'art-inv-'));
  try {
    writeFixture(repo);
    const inv = buildArtifactInventory(repo);
    assert.equal(inv.schema, 'control-room.runtime-license-artifact-inventory/v1');
    assert.match(inv.inventoryDigest, /^[0-9a-f]{64}$/);
    assert.equal(inv.completeDistributionClearance, false);
    assert.equal(inv.installed.count, 1);
    assert.equal(inv.installed.rootTextCollected, 1);
    assert.equal(inv.installed.missingRootText, 0);
    const names = inv.bundled.rows.map(r => `${r.package}@${r.root}`).sort();
    assert.ok(names.includes('sample-pkg@third_party/sample-pkg'));
    assert.ok(names.includes('sample-pkg@src/vendor/sample-pkg'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildArtifactInventory fails on manifest staleness', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'art-inv-'));
  try {
    writeFixture(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      name: 'fixture', version: '0.0.1',
      dependencies: { 'sample-pkg': '1.0.0', 'new-pkg': '2.0.0' },
      devDependencies: {},
      optionalDependencies: {},
    }));
    assert.throws(() => buildArtifactInventory(repo), /license_artifact_inventory_manifest_stale/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildArtifactInventory fails on lockfile staleness', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'art-inv-'));
  try {
    writeFixture(repo);
    fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), '# mutated lock\n');
    assert.throws(() => buildArtifactInventory(repo), /license_artifact_inventory_lock_stale/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildArtifactInventory fails when report digest is missing', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'art-inv-'));
  try {
    writeFixture(repo);
    const reportPath = path.join(repo, 'research/runtime-license-report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    delete report.inventoryDigest;
    fs.writeFileSync(reportPath, JSON.stringify(report));
    assert.throws(() => buildArtifactInventory(repo), /license_artifact_inventory_digest_missing_in_report/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildArtifactInventory is deterministic across runs', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'art-inv-'));
  try {
    writeFixture(repo);
    const a = buildArtifactInventory(repo);
    const b = buildArtifactInventory(repo);
    assert.equal(a.inventoryDigest, b.inventoryDigest);
    assert.deepEqual(a.installed.rows, b.installed.rows);
    assert.deepEqual(a.bundled.rows, b.bundled.rows);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildArtifactInventory binds missing-root text to qualification', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'art-inv-'));
  try {
    writeFixture(repo, { withLicense: false });
    const inv = buildArtifactInventory(repo);
    const missing = inv.installed.rows.filter(r => r.status === 'missing_root_text');
    assert.ok(missing.length >= 1);
    assert.match(missing[0].provenance, /retained_third_party_evidence|pinned_upstream_matching_code|pinned_upstream_release|installed_README_section/);
    assert.ok(missing[0].qualification);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildArtifactInventory digest matches the report digest for the same inputs', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'art-inv-'));
  try {
    writeFixture(repo);
    const report = JSON.parse(fs.readFileSync(path.join(repo, 'research/runtime-license-report.json'), 'utf8'));
    const inv = buildArtifactInventory(repo);
    assert.equal(inv.inventoryDigest, report.inventoryDigest);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildArtifactInventory refuses a stale report whose inventoryDigest does not match the freshly collected bundled rows', () => {
  // Reviewer finding: the inventory MUST recompute the digest from the
  // freshly collected bundled rows, not trust the report's digest
  // verbatim. Otherwise a stale report can carry a digest that covers
  // older bundled state while the inventory ships a fresh `bundled.rows`
  // set — silent drift.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'art-inv-stale-'));
  try {
    writeFixture(repo);
    // Mutate the committed report's digest to a wrong value, simulating a
    // stale snapshot. The inventory must reject, not silently carry the
    // digest mismatch.
    const reportPath = path.join(repo, 'research/runtime-license-report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    report.inventoryDigest = '0'.repeat(64);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    assert.throws(() => buildArtifactInventory(repo), /license_artifact_inventory_digest_mismatch/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
