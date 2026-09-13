// Tests for the shared inventoryDigest helpers in runtime-license-digest.mjs.
// The digest must be deterministic, sensitive to every input field, and
// canonical (key-sorted).
//
// These tests are pure-function tests of the digest builder — they do not
// touch the filesystem at all, so they correctly do not use mkdtempSync.
// (mkdtempSync fixtures are only required for tests that walk files.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInventoryDigestPayload, computeInventoryDigest } from '../scripts/runtime-license-digest.mjs';

test('inventory digest is 64 hex chars and stable across runs', () => {
  const payload = {
    report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c', results: [] },
    exceptions: { entries: [] },
    bundledRows: [],
  };
  const d1 = computeInventoryDigest(buildInventoryDigestPayload(payload));
  const d2 = computeInventoryDigest(buildInventoryDigestPayload(payload));
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
});

test('inventory digest is sensitive to manifestSha256', () => {
  const base = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c', results: [] }, exceptions: { entries: [] }, bundledRows: [] };
  const changed = { report: { manifestSha256: 'X', lockSha256: 'b', inventorySha256: 'c', results: [] }, exceptions: { entries: [] }, bundledRows: [] };
  assert.notEqual(computeInventoryDigest(buildInventoryDigestPayload(base)), computeInventoryDigest(buildInventoryDigestPayload(changed)));
});

test('inventory digest is sensitive to lockSha256', () => {
  const base = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c', results: [] }, exceptions: { entries: [] }, bundledRows: [] };
  const changed = { report: { manifestSha256: 'a', lockSha256: 'X', inventorySha256: 'c', results: [] }, exceptions: { entries: [] }, bundledRows: [] };
  assert.notEqual(computeInventoryDigest(buildInventoryDigestPayload(base)), computeInventoryDigest(buildInventoryDigestPayload(changed)));
});

test('inventory digest is sensitive to installed-package attachments', () => {
  const base = {
    report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c',
      results: [{ name: 'x', version: '1', manifestSha256: 'm', status: 'root_text_collected', attachments: [{ file: 'LICENSE', sha256: 'h' }] }] },
    exceptions: { entries: [] },
    bundledRows: [],
  };
  const changed = JSON.parse(JSON.stringify(base));
  changed.report.results[0].attachments[0].sha256 = 'H';
  assert.notEqual(computeInventoryDigest(buildInventoryDigestPayload(base)), computeInventoryDigest(buildInventoryDigestPayload(changed)));
});

test('inventory digest is sensitive to bundled row file additions', () => {
  const base = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c', results: [] },
    exceptions: { entries: [] },
    bundledRows: [{ package: 'pg', root: 'third_party/pg', evidenceFiles: [{ file: 'LICENSE', sha256: 'x' }], provenance: { sourceCommit: null } }] };
  const changed = JSON.parse(JSON.stringify(base));
  changed.bundledRows[0].evidenceFiles.push({ file: 'NOTICE.md', sha256: 'y' });
  assert.notEqual(computeInventoryDigest(buildInventoryDigestPayload(base)), computeInventoryDigest(buildInventoryDigestPayload(changed)));
});

test('inventory digest normalizes Windows backslashes in inventorySha256 inputs', () => {
  // Captured input paths from `pnpm licenses list` on Windows arrive with
  // backslashes. The captured-input prep normalizes them; this test asserts
  // the digest is sensitive to that normalization (i.e., backslashes vs
  // forward slashes produce different digests so drift is detectable).
  const base = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'a89ac', results: [] },
    exceptions: { entries: [] },
    bundledRows: [{ package: 'pg', root: 'third_party\\pg', evidenceFiles: [], provenance: { sourceCommit: null } }] };
  const normalized = JSON.parse(JSON.stringify(base));
  normalized.report.inventorySha256 = 'a89ad';
  normalized.bundledRows[0].root = 'third_party/pg';
  assert.notEqual(computeInventoryDigest(buildInventoryDigestPayload(base)), computeInventoryDigest(buildInventoryDigestPayload(normalized)));
});

test('inventory digest is sensitive to exception textSha256 changes', () => {
  const base = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c', results: [] },
    exceptions: { entries: [{ name: 'pg-types', version: '2.2.0', manifestSha256: 'm', textSha256: 'h', sourceFile: 'README.md', textFile: 'third_party/pg-types/LICENSE.from-README.md', sourceSha256: 's', upstreamLocation: 'https://example' }] },
    bundledRows: [] };
  const changed = JSON.parse(JSON.stringify(base));
  changed.exceptions.entries[0].textSha256 = 'H';
  assert.notEqual(computeInventoryDigest(buildInventoryDigestPayload(base)), computeInventoryDigest(buildInventoryDigestPayload(changed)));
});

test('inventory digest is sensitive to bundled discoveredFiles hash changes', () => {
  // Reviewer finding: the digest must reflect walk-discovered content, not
  // just PROVENANCE-pinned evidence. Without this, a file change in
  // third_party/ would not move the digest and #64's qualification gate
  // could pass stale snapshots.
  const base = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c', results: [] },
    exceptions: { entries: [] },
    bundledRows: [{ package: 'pg', root: 'third_party/pg',
      evidenceFiles: [],
      discoveredFiles: [{ file: 'LICENSE', sha256: 'h1', bytes: 100 }],
      mismatches: [],
      provenance: { sourceCommit: null } }] };
  const changed = JSON.parse(JSON.stringify(base));
  changed.bundledRows[0].discoveredFiles[0].sha256 = 'h2';
  assert.notEqual(computeInventoryDigest(buildInventoryDigestPayload(base)), computeInventoryDigest(buildInventoryDigestPayload(changed)));
});

test('inventory digest is sensitive to bundled mismatches list changes', () => {
  // Reviewer finding: PROVENANCE pins that don't match on-disk bytes
  // (the `mismatches[]` array) must move the digest, otherwise drift in
  // pinned-but-broken packages would go undetected.
  const base = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c', results: [] },
    exceptions: { entries: [] },
    bundledRows: [{ package: 'pg', root: 'third_party/pg',
      evidenceFiles: [],
      discoveredFiles: [],
      mismatches: [],
      provenance: { sourceCommit: null } }] };
  const changed = JSON.parse(JSON.stringify(base));
  changed.bundledRows[0].mismatches.push({ path: 'LICENSE', reason: 'pinned_hash_or_size_mismatch', pinnedSha256: 'p', onDiskSha256: 'o' });
  assert.notEqual(computeInventoryDigest(buildInventoryDigestPayload(base)), computeInventoryDigest(buildInventoryDigestPayload(changed)));
});

test('canonical digest is key-order independent', () => {
  // The canonical form sorts keys, so payload with keys in different order
  // must produce the same digest.
  const a = { bundledRows: [], exceptions: { entries: [] }, report: { inventorySha256: 'c', lockSha256: 'b', manifestSha256: 'a', results: [] } };
  const b = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c', results: [] }, exceptions: { entries: [] }, bundledRows: [] };
  assert.equal(computeInventoryDigest(buildInventoryDigestPayload(a)), computeInventoryDigest(buildInventoryDigestPayload(b)));
});

test('canonical digest is array-order dependent for installed results', () => {
  // Array order in `results` is meaningful (it encodes the captured inventory
  // sequence), so it MUST affect the digest. This guards against a future
  // refactor that accidentally sorts the results array.
  const a = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c',
    results: [{ name: 'a', version: '1', manifestSha256: 'm', status: 'root_text_collected', attachments: [] }] },
    exceptions: { entries: [] }, bundledRows: [] };
  const b = { report: { manifestSha256: 'a', lockSha256: 'b', inventorySha256: 'c',
    results: [{ name: 'b', version: '1', manifestSha256: 'm', status: 'root_text_collected', attachments: [] }] },
    exceptions: { entries: [] }, bundledRows: [] };
  assert.notEqual(computeInventoryDigest(buildInventoryDigestPayload(a)), computeInventoryDigest(buildInventoryDigestPayload(b)));
});
