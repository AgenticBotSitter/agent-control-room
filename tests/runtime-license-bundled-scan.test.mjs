import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/**
 * Regression for the entry-guard / portability review fix.
 *
 * The previous guard compared `import.meta.url === "file://${argv[1]}"`,
 * which silently skipped CLI execution on Windows and on any path
 * containing spaces. The portable guard matches the existing
 * `path.resolve == fileURLToPath` pattern, so a CLI invocation runs
 * the entry branch regardless of platform.
 */
test('bundled scan CLI entry guard matches when invoked with a path containing spaces', () => {
  const hostRepo = mkdtempSync(join(tmpdir(), 'bundled-scan-space-'));
  try {
    const nested = join(hostRepo, 'repo with space');
    mkdirSync(nested, { recursive: true });
    const out = execFileSync(process.execPath,
      [resolve(repoRoot, 'scripts', 'runtime-license-bundled-scan.mjs'), nested],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const payload = JSON.parse(out);
    assert.equal(payload.schema, 'control-room.runtime-license-bundled-scan/v1');
    assert.equal(payload.repoRoot, nested);
    assert.ok(Array.isArray(payload.rows));
  } finally {
    rmSync(hostRepo, { recursive: true, force: true });
  }
});

test('bundled scan CLI entry guard matches via the path.resolve==fileURLToPath check used internally', () => {
  // Sanity-check the portable comparator exactly the way the script's
  // guard computes it. With cwd at repoRoot,
  // `path.resolve('scripts/foo.mjs')` must equal
  // `fileURLToPath(pathToFileURL(abs/.../scripts/foo.mjs).href)`.
  const scriptPath = resolve(repoRoot, 'scripts', 'runtime-license-bundled-scan.mjs');
  const argv1Relative = join('scripts', 'runtime-license-bundled-scan.mjs');
  assert.equal(resolve(argv1Relative), fileURLToPath(pathToFileURL(scriptPath).href));
});

void sep;
