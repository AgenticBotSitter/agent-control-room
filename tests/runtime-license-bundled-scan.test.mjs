import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { scanBundledCode, parseVendorRoots } from '../scripts/runtime-license-bundled-scan.mjs';

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

/**
 * Regression for the entry-guard / portability review fix.
 *
 * The previous guard compared `import.meta.url === "file://${argv[1]}"`,
 * which silently skipped CLI execution on Windows and on any path
 * containing spaces. The portable guard matches the existing
 * `path.resolve == fileURLToPath` pattern, so a CLI invocation runs
 * the entry branch regardless of platform.
 *
 * The regression value of these tests comes from invoking the script
 * by argv[1] forms that the OLD guard could NOT have matched: the
 * script living under a spaced path, AND the script being launched
 * by its `./<file>` relative form with cwd at `scripts/`. The old
 * guard was tautologically true on the canonical absolute-path
 * invocation, so a unit test that ONLY used the absolute path would
 * not have caught a regression.
 */
test('bundled scan CLI entry guard matches when the script lives at a path containing spaces', () => {
  const hostRepo = mkdtempSync(join(tmpdir(), 'bundled-scan-space-'));
  try {
    const spaced = join(hostRepo, 'repo with space', 'scripts');
    mkdirSync(spaced, { recursive: true });
    const scriptSource = resolve(repoRoot, 'scripts', 'runtime-license-bundled-scan.mjs');
    const scriptCopy = join(spaced, 'runtime-license-bundled-scan.mjs');
    writeFileSync(scriptCopy, readFileSync(scriptSource));
    const out = execFileSync(process.execPath,
      [scriptCopy, spaced],  // argv[1] CONTAINS SPACES; positional argv[2] is the spaced repo
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const payload = JSON.parse(out);
    assert.equal(payload.schema, 'control-room.runtime-license-bundled-scan/v1');
    assert.equal(payload.repoRoot, spaced);
    assert.ok(Array.isArray(payload.rows));
  } finally {
    rmSync(hostRepo, { recursive: true, force: true });
  }
});

void sep;

test('bundled scan omits vendor subtrees under roots outside the override list', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bundled-scan-omitted-'));
  try {
    const kept = join(tmp, 'extra-vendor', 'glued-lib');
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, 'mod.ts'), 'export const z = 3;\n');
    // A populated default root that the override does NOT include.
    const omitted = join(tmp, 'src', 'vendor', 'hidden-lib');
    mkdirSync(omitted, { recursive: true });
    writeFileSync(join(omitted, 'mod.ts'), 'export const h = 4;\n');
    mkdirSync(join(tmp, 'third_party'), { recursive: true });
    const rows = scanBundledCode({
      repoRoot: tmp,
      vendorRoots: ['extra-vendor'],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subtree, 'extra-vendor/glued-lib');
    assert.ok(!rows.some(r => r.subtree.includes('hidden-lib')),
      'src/vendor/hidden-lib must not be surfaced when src/vendor is not in vendorRoots');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled scan CLI --roots <csv> restricts the scan to the listed roots', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bundled-scan-cli-roots-'));
  try {
    const kept = join(tmp, 'extra-vendor', 'glued-lib');
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, 'mod.ts'), 'export const z = 3;\n');
    const omitted = join(tmp, 'src', 'vendor', 'hidden-lib');
    mkdirSync(omitted, { recursive: true });
    writeFileSync(join(omitted, 'mod.ts'), 'export const h = 4;\n');
    mkdirSync(join(tmp, 'third_party'), { recursive: true });
    const script = resolve(repoRoot, 'scripts', 'runtime-license-bundled-scan.mjs');
    const out = execFileSync(process.execPath,
      [script, tmp, '--roots', 'extra-vendor'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const payload = JSON.parse(out);
    assert.equal(payload.schema, 'control-room.runtime-license-bundled-scan/v1');
    assert.deepEqual(payload.vendorRoots, ['extra-vendor']);
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].subtree, 'extra-vendor/glued-lib');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled scan parseVendorRoots bounds: empty, absolute, traversal, and oversize inputs rejected', () => {
  assert.deepEqual(parseVendorRoots('extra-vendor'), ['extra-vendor']);
  assert.deepEqual(parseVendorRoots(' a ,b/, ,c\\d '), ['a', 'b', 'c/d']);
  assert.throws(() => parseVendorRoots(''), /license_bundled_roots_empty/);
  assert.throws(() => parseVendorRoots('  ,  '), /license_bundled_roots_empty/);
  assert.throws(() => parseVendorRoots('/etc/vendor'), /license_bundled_root_outside_repo/);
  assert.throws(() => parseVendorRoots('../escape'), /license_bundled_root_outside_repo/);
  assert.throws(() => parseVendorRoots('ok,../escape'), /license_bundled_root_outside_repo/);
  const many = Array.from({ length: 33 }, (_, i) => `root${i}`).join(',');
  assert.throws(() => parseVendorRoots(many), /license_bundled_too_many_roots/);
});

test('bundled scan CLI rejects unknown flags and out-of-repo roots', () => {
  const script = resolve(repoRoot, 'scripts', 'runtime-license-bundled-scan.mjs');
  assert.throws(() => execFileSync(process.execPath, [script, '--bogus'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /license_bundled_unknown_flag/);
  assert.throws(() => execFileSync(process.execPath, [script, '--roots', '../escape'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /license_bundled_root_outside_repo/);
});
