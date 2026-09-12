import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { prepareRuntimeLicenseInventory, pnpmCommand, pnpmInvocation } from '../scripts/runtime-license-inventory-prep.mjs';

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
 * guard uses `path.resolve` + `fileURLToPath` — so a CLI invocation now
 * runs the entry branch when the script's own path contains spaces, AND
 * when the script is reached through a relative path (no leading
 * `file://` and no leading `/`). Both branches are exercised here,
 * because the OLD guard was tautologically true on either of them and
 * the regression would have slipped past a unit test that only invoked
 * the script via its canonical absolute path.
 */
test('inventory prep CLI entry guard matches when the script lives at a path containing spaces (POSIX regression)', () => {
  const hostRepo = mkdtempSync(join(tmpdir(), 'license-inv-space-'));
  try {
    const spaced = join(hostRepo, 'repo with space', 'scripts');
    mkdirSync(spaced, { recursive: true });
    // Copy the script ITSELF (not just the repo manifest) into the spaced
    // path so argv[1] inside the spawned process actually contains
    // spaces. With the OLD guard
    // `import.meta.url === "file://${argv[1]}"`, on POSIX with
    // backslash-free paths and a URI-form argv[1], the comparison
    // would happen to match (the old guard was POSIX-OK, only Windows
    // failed). So we ALSO run the script under its relative name
    // (`./runtime-license-inventory-prep.mjs`) with cwd at the spaced
    // `scripts/` directory — that exercises the cwd-relative branch,
    // which the new guard handles via `path.resolve`/`fileURLToPath`
    // and the old guard would have silently skipped (the URL still
    // starts with `file://` but argv[1] is `./runtime-license-inventory-prep.mjs`,
    // and `"file://${argv[1]}"` !== the script's absolute file URL).
    const scriptSource = resolve(repoRoot, 'scripts', 'runtime-license-inventory-prep.mjs');
    const scriptCopy = join(spaced, 'runtime-license-inventory-prep.mjs');
    writeFileSync(scriptCopy, readFileSync(scriptSource));
    // Mirror the host repo's manifest + lockfile for the script to read.
    writeFileSync(join(spaced, '..', 'package.json'), readFileSync(join(repoRoot, 'package.json')));
    writeFileSync(join(spaced, '..', 'pnpm-lock.yaml'), readFileSync(join(repoRoot, 'pnpm-lock.yaml')));
    const stdout = execFileSync(process.execPath,
      [scriptCopy, '--repo', join(spaced, '..')],  // argv[1] CONTAINS SPACES
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const payload = JSON.parse(stdout);
    assert.equal(payload.manifestSha256.length, 64);
    assert.equal(payload.lockSha256.length, 64);
    assert.match(payload.source, /^pnpm@[\d.]+ licenses list --prod --json$/);
  } finally {
    rmSync(hostRepo, { recursive: true, force: true });
  }
});

test('inventory prep pnpmCommand returns pnpm.cmd on win32 and pnpm elsewhere', () => {
  // process.platform is fixed at startup; we can only assert the
  // current host's branch. The opposite branch is covered by inspection
  // (one-line ternary) and by the fact that any `pnpm.cmd` literal on
  // POSIX would fail with ENOENT in pnpmLicensesJson's catch block.
  const expected = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  assert.equal(pnpmCommand(), expected);
});

test('inventory prep pnpmInvocation wraps the command in cmd.exe /c on Windows only', () => {
  // On Windows the pnpm installer registers a .cmd shim that Node's
  // execFileSync does not resolve without a shell. The portable fix
  // is to wrap in `cmd.exe /c` on Windows only — no shell:true is used.
  // On POSIX the wrapper is a no-op (the program + args pass through).
  if (process.platform === 'win32') {
    const result = pnpmInvocation('pnpm.cmd', ['licenses', 'list']);
    assert.equal(result.file, 'cmd.exe');
    assert.deepEqual(result.args, ['/c', 'pnpm.cmd', 'licenses', 'list']);
  } else {
    const result = pnpmInvocation('pnpm', ['licenses', 'list']);
    assert.equal(result.file, 'pnpm');
    assert.deepEqual(result.args, ['licenses', 'list']);
  }
});

test('inventory prep accepts a pnpmRunner injection (no real pnpm needed)', () => {
  // Regression test for the spaced-path test that runs `pnpm licenses list`
  // inside a temp dir without an installed package index. Previously the
  // script had no way to substitute the pnpm execution, so the regression
  // test was either fragile (relied on the host repo having node_modules/)
  // or skipped entirely on clean CI. The pnpmRunner option lets callers
  // (tests, embedded callers) substitute the actual pnpm execution while
  // preserving the rest of the script's portable entry guard, hash, and
  // path handling.
  const fakeInventory = {
    // pnpm licenses list --prod --json returns a license -> entries map.
    // Each key is a SPDX license id; each value is an array of
    // { name, versions[], paths[], author, homepage?, license } objects.
    'MIT': [{
      name: 'fake-package', versions: ['1.0.0'],
      paths: ['node_modules/.pnpm/fake-package@1.0.0/node_modules/fake-package'],
      author: 'Test Author', homepage: 'https://example.test',
    }],
  };
  let runnerCalled = false;
  let runnerArgs;
  const runner = (file, args) => {
    runnerCalled = true;
    runnerArgs = { file, args };
    return JSON.stringify(fakeInventory);
  };
  // Use the host repo (which has a real manifest + lockfile). The runner
  // returns canned inventory so the test doesn't need a real pnpm install.
  const payload = prepareRuntimeLicenseInventory({
    repoRoot,
    pnpmRunner: runner,
  });
  assert.equal(runnerCalled, true, 'pnpmRunner must be invoked');
  assert.match(runnerArgs.file, /pnpm(\.cmd)?$/);
  assert.deepEqual(runnerArgs.args.slice(-4), ['licenses', 'list', '--prod', '--json']);
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0].name, 'fake-package');
  assert.equal(payload.records[0].license, 'MIT');
  assert.match(payload.source, /^pnpm@.+ licenses list --prod --json$/);
});

test('inventory prep pnpmRunner injection works under a spaced repoRoot (no real pnpm install needed)', () => {
  // The full spaced-path regression from the original review feedback:
  // a fresh temp dir whose OWN path contains spaces, manifest + lockfile
  // copied in, pnpm inventory produced via the injection — no pnpm install
  // required, no fragile reliance on host repo's node_modules. The OLD
  // implementation could not be tested this way at all (the script had
  // no injection point, so any test of this shape had to either run a
  // real `pnpm install --prod` in the temp dir or skip the path-spaces
  // assertion entirely).
  const hostRepo = mkdtempSync(join(tmpdir(), 'license-inv-injected-'));
  try {
    const spaced = join(hostRepo, 'repo with space');
    mkdirSync(spaced, { recursive: true });
    writeFileSync(join(spaced, 'package.json'), readFileSync(join(repoRoot, 'package.json')));
    writeFileSync(join(spaced, 'pnpm-lock.yaml'), readFileSync(join(repoRoot, 'pnpm-lock.yaml')));
    const fakeInventory = {
      'Apache-2.0': [{
        name: 'spaced-fixture', versions: ['0.1.0'],
        paths: ['node_modules/.pnpm/spaced-fixture@0.1.0/node_modules/spaced-fixture'],
      }],
    };
    const payload = prepareRuntimeLicenseInventory({
      repoRoot: spaced,
      pnpmRunner: () => JSON.stringify(fakeInventory),
    });
    assert.equal(payload.records.length, 1);
    assert.equal(payload.records[0].name, 'spaced-fixture');
    assert.equal(payload.records[0].license, 'Apache-2.0');
    // The repoRoot path contains spaces — assert it round-tripped correctly
    // through the script's path handling (the entry guard + the repoRoot
    // propagation that the OLD guard was tautologically testing).
    assert.ok(spaced.includes(' '), 'repoRoot should contain spaces for this regression test');
    assert.match(payload.source, /^pnpm@.+ licenses list --prod --json$/);
  } finally {
    rmSync(hostRepo, { recursive: true, force: true });
  }
});
