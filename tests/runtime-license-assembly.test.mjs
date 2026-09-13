import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleRuntimeLicenses, checkBundledDisclosure } from '../scripts/runtime-license-assembly.mjs';
test('actual collector assembles every pinned package instance while retaining provenance gaps', () => {
  const result = assembleRuntimeLicenses();
  assert.equal(result.entries.length, 193); assert.equal(result.rawMissingRootTexts.length, 4);
  assert.equal(result.completeDistributionClearance, false);
  assert.match(result.entries.find(entry => entry.name === '@nodable/entities').qualification, /not resolved/);
  assert.equal(result.entries.filter(entry => entry.provenance !== 'installed_root_text').length, 4);
  for (const entry of result.entries) for (const attachment of entry.attachments) {
    const bytes = Buffer.from(attachment.base64, 'base64');
    assert.equal(bytes.length, attachment.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), attachment.sha256);
  }
  // The release path enforces the full bundled root set: the scan ran
  // and every discovered subtree carried notice evidence.
  assert.deepEqual(result.bundledScan.vendorRoots, ['src/vendor', 'vendor', 'assets/vendor']);
  assert.equal(result.bundledScan.rows.length, 1);
  assert.equal(result.bundledScan.rows[0].bundledUndisclosed, false);
});
test('release assembly fails closed when bundled code lacks notice evidence', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bundled-gate-'));
  try {
    const lib = join(tmp, 'extra-vendor', 'unattributed-lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'mod.ts'), 'export const u = 1;\n');
    mkdirSync(join(tmp, 'third_party'), { recursive: true });
    assert.throws(() => checkBundledDisclosure({ repoRoot: tmp, vendorRoots: ['extra-vendor'] }),
      /license_bundled_undisclosed: extra-vendor\/unattributed-lib/);
    // Attributed copy (LICENSE in the matching evidence bundle) passes.
    const evidence = join(tmp, 'third_party', 'unattributed-lib');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'LICENSE'), 'MIT\n');
    const scan = checkBundledDisclosure({ repoRoot: tmp, vendorRoots: ['extra-vendor'] });
    assert.equal(scan.rows.length, 1);
    assert.equal(scan.rows[0].bundledUndisclosed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
