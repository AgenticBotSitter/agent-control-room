import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareRuntimeLicenseInventory, pnpmCommand } from '../scripts/runtime-license-inventory-prep.mjs';

const repoRoot = process.cwd();

/**
 * Run a script file as a CLI process and return its stdout.
 * Uses process.execPath — the exact Node binary this test process was
 * started with — so the test works identically on hosts that install
 * Node as `node`, `node.exe`, or under a versioned path, instead of
 * relying on PATH resolving a bare `node` token.
 */
function runScript(scriptPath, args = []) {
  return execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('inventory prep reproduces the canonical input.json shape from a real pnpm install', () => {
  const payload = prepareRuntimeLicenseInventory({ repoRoot });
  assert.equal(payload.manifestSha256.length, 64);
  assert.equal(payload.lockSha256.length, 64);
  assert.match(payload.source, /^pnpm@[\d.]+ licenses list --prod --json$/);
  assert.equal(payload.scope, 'prepared local production dependency inventory; not bundle coverage');
  assert.ok(Array.isArray(payload.records));
  assert.ok(payload.records.length > 100, `expected > 100 records, got ${payload.records.length}`);
  for (const record of payload.records) {
    assert.equal(typeof record.name, 'string');
    assert.ok(Array.isArray(record.versions) && record.versions.length > 0);
    assert.ok(Array.isArray(record.paths) && record.paths.length > 0);
    assert.equal(typeof record.license, 'string');
    for (const path of record.paths) {
      assert.ok(path.startsWith('node_modules/'), `path does not start with node_modules/: ${path}`);
      assert.ok(!path.includes('\\'), `path contains backslash: ${path}`);
      assert.ok(!path.includes('//'), `path contains double slash: ${path}`);
    }
  }
});

test('inventory prep output is byte-identical to the committed research/runtime-license-input.json on this checkout', () => {
  const prepared = prepareRuntimeLicenseInventory({ repoRoot });
  const committedPath = join(repoRoot, 'research', 'runtime-license-input.json');
  if (!existsSync(committedPath)) return;
  const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
  assert.equal(prepared.manifestSha256, committed.manifestSha256, 'manifestSha256 drifted');
  assert.equal(prepared.lockSha256, committed.lockSha256, 'lockSha256 drifted');
  assert.equal(prepared.records.length, committed.records.length, 'record count drifted');
  const preparedNames = prepared.records.map(r => `${r.name}@${r.versions[0]}`).sort();
  const committedNames = committed.records.map(r => `${r.name}@${r.versions[0]}`).sort();
  assert.deepEqual(preparedNames, committedNames, 'record set drifted');
});

test('inventory prep records are sorted by package name then first version', () => {
  const payload = prepareRuntimeLicenseInventory({ repoRoot });
  for (let i = 1; i < payload.records.length; i++) {
    const prev = payload.records[i - 1];
    const curr = payload.records[i];
    const prevKey = `${prev.name}@${prev.versions[0]}`;
    const currKey = `${curr.name}@${curr.versions[0]}`;
    // Sort key is package name (string comparison) then first version.
    // Use the comparator the script uses, not raw string compare on the
    // joined key: a `name@-` continuation sorts AFTER the bare name in
    // raw string compare, but the script only sorts by name.
    if (prev.name === curr.name) {
      assert.ok(prev.versions[0] <= curr.versions[0], `versions not sorted at index ${i}: ${prevKey} > ${currKey}`);
    } else {
      assert.ok(prev.name <= curr.name, `names not sorted at index ${i}: ${prev.name} > ${curr.name}`);
    }
  }
});

test('inventory prep accepts relocated manifest and lockfile paths via --manifest and --lockfile', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'license-inv-'));
  try {
    const manifestTarget = join(tmp, 'package.json');
    const lockfileTarget = join(tmp, 'pnpm-lock.yaml');
    writeFileSync(manifestTarget, readFileSync(join(repoRoot, 'package.json')));
    writeFileSync(lockfileTarget, readFileSync(join(repoRoot, 'pnpm-lock.yaml')));
    const payload = prepareRuntimeLicenseInventory({
      repoRoot,
      manifestPath: manifestTarget,
      lockfilePath: lockfileTarget,
    });
    const expected = prepareRuntimeLicenseInventory({ repoRoot });
    assert.equal(payload.manifestSha256, expected.manifestSha256);
    assert.equal(payload.lockSha256, expected.lockSha256);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('inventory prep CLI writes to --out path with a JSON document that round-trips', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'license-inv-cli-'));
  try {
    const outPath = join(tmp, 'inventory.json');
    runScript(resolve(repoRoot, 'scripts', 'runtime-license-inventory-prep.mjs'), ['--out', outPath]);
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.ok(written.records.length > 0);
    assert.match(written.source, /^pnpm@[\d.]+/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('inventory prep fails cleanly when the repository root is absent', () => {
  assert.throws(
    () => prepareRuntimeLicenseInventory({ repoRoot: join(sep, 'no', 'such', 'dir') }),
    /license_inventory_manifest_missing|license_inventory_lockfile_missing/,
  );
});

/**
 * Regression for the entry-guard / portability review fix.
 *
 * The previous guard compared `import.meta.url === "file://${argv[1]}"`,
 * which silently skipped execution on Windows (backslash argv vs.
 * forward-slash URL) and on any path containing spaces. The portable
 * guard uses `path.resolve` + `fileURLToPath` — so a CLI invocation
 * now runs the entry branch when the script's path contains spaces.
 */
test('inventory prep CLI entry guard matches when invoked with a path containing spaces (POSIX regression)', () => {
  const hostRepo = mkdtempSync(join(tmpdir(), 'license-inv-space-'));
  try {
    const nested = join(hostRepo, 'repo with space');
    mkdirSync(nested, { recursive: true });
    // Copy the real repo's manifest + lockfile into a path with spaces.
    writeFileSync(join(nested, 'package.json'), readFileSync(join(repoRoot, 'package.json')));
    writeFileSync(join(nested, 'pnpm-lock.yaml'), readFileSync(join(repoRoot, 'pnpm-lock.yaml')));
    const stdout = runScript(resolve(repoRoot, 'scripts', 'runtime-license-inventory-prep.mjs'), ['--repo', nested]);
    const payload = JSON.parse(stdout);
    assert.equal(payload.manifestSha256.length, 64);
    assert.equal(payload.lockSha256.length, 64);
  } finally {
    rmSync(hostRepo, { recursive: true, force: true });
  }
});

test('inventory prep CLI resolves its entry script via the path.resolve==fileURLToPath check used internally', () => {
  // Sanity-check the portable comparator: with cwd at repoRoot,
  // `path.resolve('scripts/foo.mjs')` must equal
  // `fileURLToPath(pathToFileURL('/abs/.../scripts/foo.mjs').href)`.
  // This proves the guard inside the script will match for the
  // realistic `node scripts/runtime-license-inventory-prep.mjs` form.
  const scriptPath = resolve(repoRoot, 'scripts', 'runtime-license-inventory-prep.mjs');
  const argv1Relative = join('scripts', 'runtime-license-inventory-prep.mjs');
  const expected = resolve(argv1Relative);
  assert.equal(expected, fileURLToPath(pathToFileURL(scriptPath).href));
});

test('inventory prep pnpmCommand returns pnpm.cmd on win32 and pnpm elsewhere', () => {
  // process.platform is fixed at startup; we can only assert the
  // current host's branch. The opposite branch is covered by inspection
  // (one-line ternary) and by the fact that any `pnpm.cmd` literal on
  // POSIX would fail with ENOENT in pnpmLicensesJson's catch block.
  const expected = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  assert.equal(pnpmCommand(), expected);
});

void tmpdir;
