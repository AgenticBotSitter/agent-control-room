import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalizedRuntimeLicenseOutputs } from '../scripts/runtime-license-finalize.mjs';

function fixture({ complete = true, digest = 'a'.repeat(64), scanDigest = digest, undisclosed = 0 } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'license-final-'));
  fs.mkdirSync(path.join(repo, 'research'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'research/runtime-license-artifact-inventory.json'), JSON.stringify({
    completeDistributionClearance: complete, inventoryDigest: digest, scope: 'fixture',
    installed: { rows: [{ name: 'pkg', version: '1.0.0', provenance: 'pinned_npm_release_integrity', attachments: [] }] },
    bundled: { rows: [] },
  }));
  fs.writeFileSync(path.join(repo, 'research/runtime-license-bundled-scan.json'), JSON.stringify({ inventoryDigest: scanDigest, summary: { undisclosed }, reviewedExclusions: [] }));
  fs.writeFileSync(path.join(repo, 'THIRD_PARTY.md'), 'old\n');
  return repo;
}

test('finalizer is byte-stable and rejects incomplete, mismatched, or undisclosed inputs', () => {
  for (const options of [{ complete: false }, { scanDigest: 'b'.repeat(64) }, { undisclosed: 1 }]) {
    const repo = fixture(options); try { assert.throws(() => finalizedRuntimeLicenseOutputs(repo), /runtime_license_finalization_incomplete/); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  }
  const repo = fixture(); try {
    const first = finalizedRuntimeLicenseOutputs(repo), second = finalizedRuntimeLicenseOutputs(repo);
    assert.deepEqual(second, first); assert.match(first.notice, /Inventory digest/); assert.equal(first.manifest.inventoryDigest, 'a'.repeat(64));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
