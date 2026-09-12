import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { manifestSubsetHash, runtimeLicenseReport } from '../scripts/runtime-license-report.mjs';

test('runtime report binds current manifests, preserves missing texts and rejects changed identities', () => {
  const input = JSON.parse(fs.readFileSync('research/runtime-license-input.json', 'utf8'));
  const saved = JSON.parse(fs.readFileSync('research/runtime-license-report.json', 'utf8'));
  assert.deepEqual(runtimeLicenseReport(input), saved);
  assert.equal(saved.packages, 193);
  assert.deepEqual(saved.missing.map(value => value.name), ['@nodable/entities', 'pg-types', 'pgpass', 'saxes']);
  assert.throws(() => runtimeLicenseReport({ ...input, lockSha256: '0'.repeat(64) }), /inventory_stale/);
  const foreign = structuredClone(input); foreign.records[0].name = 'foreign-package';
  assert.throws(() => runtimeLicenseReport(foreign), /identity_mismatch/);
  const escaped = structuredClone(input); escaped.records[0].paths[0] = 'node_modules/../package.json';
  assert.throws(() => runtimeLicenseReport(escaped), /path_invalid/);
});

test('manifestSubsetHash only changes when a dependency field changes (#38)', () => {
  // Set up a clean disposable repo with a known package.json.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subset-hash-'));
  const deps = { '@mozilla/readability': '0.6.0', 'cron-parser': '5.10.0' };
  const devDeps = { typescript: '5.4.0' };
  const base = { name: 'control-room', scripts: { test: 'node --test' }, dependencies: { ...deps }, devDependencies: { ...devDeps } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(base, null, 2) + '\n');
  const baseline = manifestSubsetHash(dir);

  // 1. Top-level field edits (scripts, name, formatting, key order) MUST NOT move the hash.
  const mutated = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  mutated.scripts['test:new'] = 'node --test new.mjs';
  mutated.name = 'different-name';
  mutated.engines = { node: '>=22' };
  // Reorder the top-level keys: write with `scripts` first, `name` second.
  const reordered = { scripts: mutated.scripts, name: mutated.name, engines: mutated.engines,
    dependencies: mutated.dependencies, devDependencies: mutated.devDependencies };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(reordered) + '\n');
  assert.equal(manifestSubsetHash(dir), baseline, 'scripts/name/formatting/key order should NOT move hash');

  // 2. Reorder keys inside the dependencies object — same hash.
  const reorderDeps = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  reorderDeps.dependencies = Object.fromEntries(Object.entries(reorderDeps.dependencies).reverse());
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(reorderDeps, null, 2) + '\n');
  assert.equal(manifestSubsetHash(dir), baseline, 'inner key order should NOT move hash');

  // 3. A real dependency change MUST move the hash.
  const depBump = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  depBump.dependencies['cron-parser'] = '5.11.0';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(depBump, null, 2) + '\n');
  assert.notEqual(manifestSubsetHash(dir), baseline, 'a real dependency change SHOULD move hash');

  // 4. Adding a new dependency MUST move the hash.
  const depAdded = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  depAdded.dependencies['lodash'] = '4.17.21';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(depAdded, null, 2) + '\n');
  assert.notEqual(manifestSubsetHash(dir), baseline, 'adding a dependency SHOULD move hash');

  // 5. Removing a dependency MUST move the hash.
  const depRemoved = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  delete depRemoved.dependencies['lodash'];
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(depRemoved, null, 2) + '\n');
  assert.notEqual(manifestSubsetHash(dir), baseline, 'removing a dependency SHOULD move hash');

  // 6. Adding an optionalDependencies field that didn't exist MUST move the hash.
  const optAdded = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  optAdded.optionalDependencies = { fsevents: '2.3.3' };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(optAdded, null, 2) + '\n');
  assert.notEqual(manifestSubsetHash(dir), baseline, 'adding optionalDependencies SHOULD move hash');

  // 7. devDependencies change MUST move the hash.
  const devBump = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  delete devBump.optionalDependencies;
  devBump.devDependencies['typescript'] = '5.5.0';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(devBump, null, 2) + '\n');
  assert.notEqual(manifestSubsetHash(dir), baseline, 'devDependencies change SHOULD move hash');

  fs.rmSync(dir, { recursive: true, force: true });
});
