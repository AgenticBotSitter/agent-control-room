import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { scanBundledCode } from '../scripts/runtime-license-bundled-scan.mjs';

const repoRoot = process.cwd();

test('bundled scan surfaces src/vendor/<name> and matches against third_party/<name>/ evidence', () => {
  const rows = scanBundledCode({ repoRoot });
  const cc = rows.find(r => r.subtree === 'src/vendor/control-center');
  assert.ok(cc, 'expected src/vendor/control-center in scan output');
  assert.ok(cc.fileCount >= 10, `expected >=10 files in src/vendor/control-center, got ${cc.fileCount}`);
  assert.equal(cc.evidenceBundle, 'third_party/control-center');
  assert.equal(cc.hasLicense, true);
  assert.equal(cc.hasNotice, true);
  assert.equal(cc.bundledUndisclosed, false);
});

test('bundled scan flags a vendor subtree with no matching third_party evidence bundle', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bundled-scan-'));
  try {
    const vendor = join(tmp, 'src', 'vendor', 'orphan-lib');
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, 'mod.ts'), 'export const x = 1;\n');
    writeFileSync(join(vendor, 'mod.test.ts'), 'test("x", () => {});\n');
    mkdirSync(join(tmp, 'third_party'), { recursive: true });
    // No `third_party/orphan-lib` directory created — should be flagged.
    const rows = scanBundledCode({ repoRoot: tmp });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subtree, `src/vendor/orphan-lib`);
    assert.equal(rows[0].fileCount, 2);
    assert.equal(rows[0].evidenceBundle, null);
    assert.equal(rows[0].hasLicense, false);
    assert.equal(rows[0].hasNotice, false);
    assert.equal(rows[0].bundledUndisclosed, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled scan accepts LICENSE without NOTICE and does not flag it as undisclosed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bundled-scan-license-'));
  try {
    const vendor = join(tmp, 'src', 'vendor', 'license-only-lib');
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, 'mod.ts'), 'export const y = 2;\n');
    mkdirSync(join(tmp, 'third_party', 'license-only-lib'), { recursive: true });
    writeFileSync(join(tmp, 'third_party', 'license-only-lib', 'LICENSE'), 'MIT License\n');
    const rows = scanBundledCode({ repoRoot: tmp });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hasLicense, true);
    assert.equal(rows[0].hasNotice, false);
    assert.equal(rows[0].bundledUndisclosed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled scan walks vendor roots configured via vendorRoots override', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bundled-scan-roots-'));
  try {
    const customVendor = join(tmp, 'extra-vendor', 'glued-lib');
    mkdirSync(customVendor, { recursive: true });
    writeFileSync(join(customVendor, 'mod.ts'), 'export const z = 3;\n');
    mkdirSync(join(tmp, 'third_party', 'glued-lib'), { recursive: true });
    writeFileSync(join(tmp, 'third_party', 'glued-lib', 'LICENSE'), 'MIT License\n');
    const rows = scanBundledCode({
      repoRoot: tmp,
      vendorRoots: ['extra-vendor'],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subtree, 'extra-vendor/glued-lib');
    assert.equal(rows[0].evidenceBundle, 'third_party/glued-lib');
    assert.equal(rows[0].hasLicense, true);
    assert.equal(rows[0].bundledUndisclosed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled scan returns an empty rows array when no vendor root exists', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bundled-scan-empty-'));
  try {
    const rows = scanBundledCode({ repoRoot: tmp });
    assert.deepEqual(rows, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

void sep;
