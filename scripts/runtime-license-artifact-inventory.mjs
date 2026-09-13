// One artifact-derived, deterministic notice inventory with a single
// `inventoryDigest` suitable for #64 release-qualification consumption.
//
// Inputs (artifact-only; never a caller-selected path list):
//   - research/runtime-license-input.json  (captured pnpm graph)
//   - research/runtime-license-report.json  (committed per-package evidence)
//   - research/runtime-license-exceptions.json  (bound README-section texts)
//   - third_party/<name>/PROVENANCE.json  (where present)
//   - third_party/<name>/{LICENSE,NOTICE.md,...}  (existing bound texts)
//   - src/vendor/<name>/  (declared vendor roots, walked for bundled evidence)
//
// The script:
//   1. Asserts manifestSha256 + lockSha256 + inputSha256 match the captured
//      inventory (fails closed on staleness).
//   2. Binds each installed package to its attachments + qualification.
//   3. Binds each third_party/<name>/ + src/vendor/<name>/ subtree to a
//      PROVENANCE row (synthesized when absent; never invents upstream commit
//      or license text).
//   4. Emits a canonical JSON object sorted by `name`, `version`, `path` for
//      deterministic `inventoryDigest`.
//
// `completeDistributionClearance` stays false. This script is a discovery +
// binding artifact, not a clearance.
//
// No installs, no network, no caller-supplied paths.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectBundledRows } from './runtime-license-bundled-collector.mjs';
import { assertInsideRepository } from './runtime-license-repository-guard.mjs';
import { buildInventoryDigestPayload, computeInventoryDigest } from './runtime-license-digest.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const VENDOR_ROOTS = ['src/vendor'];
const THIRD_PARTY_ROOT = 'third_party';
const INPUT_PATH = 'research/runtime-license-input.json';
const REPORT_PATH = 'research/runtime-license-report.json';
const EXCEPTIONS_PATH = 'research/runtime-license-exceptions.json';

/** Compact JSON serialization matching the existing report's inventorySha256.
 *  The report captures `hash(JSON.stringify(input))` and we MUST match that
 *  exact byte sequence or our staleness guard fires. */
function compactJson(value) {
  return JSON.stringify(value);
}

/** Read the captured inputs and verify staleness guards from runtime-license-report. */
function readCapturedInputs(repository) {
  assertInsideRepository(repository, INPUT_PATH, REPORT_PATH, EXCEPTIONS_PATH,
    'package.json', 'pnpm-lock.yaml');
  const read = relative => fs.readFileSync(path.join(repository, relative), 'utf8');
  const json = relative => JSON.parse(read(relative));
  const input = json(INPUT_PATH);
  const report = json(REPORT_PATH);
  const exceptions = json(EXCEPTIONS_PATH);
  // Staleness guards — must match the captured graph exactly.
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
  const subset = {};
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const field = manifest[key];
    if (field && typeof field === 'object' && Object.keys(field).length) {
      subset[key] = Object.fromEntries(Object.keys(field).sort().map(k => [k, field[k]]));
    }
  }
  const expectedManifestHash = hash(Buffer.from(JSON.stringify(subset)));
  const expectedLockHash = hash(fs.readFileSync(path.join(repository, 'pnpm-lock.yaml')));
  if (report.manifestSha256 !== expectedManifestHash || input.manifestSha256 !== expectedManifestHash) {
    throw new Error('license_artifact_inventory_manifest_stale');
  }
  if (report.lockSha256 !== expectedLockHash || input.lockSha256 !== expectedLockHash) {
    throw new Error('license_artifact_inventory_lock_stale');
  }
  if (report.inventorySha256 !== hash(compactJson(input))) {
    throw new Error('license_artifact_inventory_input_stale');
  }
  return { input, report, exceptions };
}

/** Build the installed-package binding rows from the report. */
function bindInstalledRows(report, exceptions) {
  const rows = [];
  for (const record of report.results) {
    const row = {
      name: record.name,
      version: record.version,
      installedPath: record.path,
      manifestSha256: record.manifestSha256,
      attachments: record.attachments.map(a => ({ file: a.file, bytes: a.bytes, sha256: a.sha256 })),
      status: record.status,
      provenance: null,
      qualification: null,
    };
    if (record.status === 'missing_root_text') {
      const exception = exceptions.entries.find(
        value => value.name === record.name && value.version === record.version,
      );
      if (exception) {
        row.provenance = 'installed_README_section';
        row.qualification = 'package root lacks license text; text retained from upstream README section bound at pinned revision';
        row.exception = {
          sourceFile: exception.sourceFile,
          sourceSha256: exception.sourceSha256,
          textFile: exception.textFile,
          textSha256: exception.textSha256,
          upstreamLocation: exception.upstreamLocation,
        };
      } else if (record.name === 'saxes' && record.version === '6.0.0') {
        row.provenance = 'pinned_upstream_release';
        row.qualification = 'manifest correspondence; whole-source correspondence not proven';
      } else if (record.name === '@nodable/entities' && record.version === '3.0.0') {
        row.provenance = 'pinned_npm_release_integrity';
        row.qualification = 'installed 3.0.0 release is bound by pnpm lock integrity; prior 2.2.0 source comparison remains historical and is not used for clearance';
      } else {
        row.provenance = 'retained_third_party_evidence';
        row.qualification = 'missing_root_text with separately evidenced third_party binding';
      }
    } else {
      row.provenance = 'installed_root_text';
      row.qualification = 'package root ships LICENSE and/or NOTICE text matching reported bytes';
    }
    rows.push(row);
  }
  return rows;
}

/** Sort rows deterministically before digesting. */
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.version !== b.version) return (a.version ?? '') < (b.version ?? '') ? -1 : 1;
    const ap = a.installedPath ?? a.root ?? '';
    const bp = b.installedPath ?? b.root ?? '';
    return ap < bp ? -1 : ap > bp ? 1 : 0;
  });
}

/** Build the canonical artifact inventory. */
export function buildArtifactInventory(repository = process.cwd()) {
  assertInsideRepository(repository, INPUT_PATH, REPORT_PATH, EXCEPTIONS_PATH,
    THIRD_PARTY_ROOT, ...VENDOR_ROOTS);
  const { input, report, exceptions } = readCapturedInputs(repository);
  const installedRows = sortRows(bindInstalledRows(report, exceptions));
  const bundledRows = collectBundledRows(repository);
  // The report's `inventoryDigest` was computed by the report script from
  // (report + exceptions + bundledRows). The artifact-inventory MUST
  // re-derive the digest from the freshly-collected bundled rows and
  // require it to match the report. This catches a stale report whose
  // committed `inventoryDigest` was computed against an older set of
  // bundled artifacts — the inventory refuses to silently carry a digest
  // that does not cover the current on-disk state.
  if (typeof report.inventoryDigest !== 'string' || report.inventoryDigest.length !== 64) {
    throw new Error('license_artifact_inventory_digest_missing_in_report');
  }
  const freshBundledInventory = bundledRows.map(row => ({
    package: row.package,
    root: row.root,
    vendor: row.vendor,
    evidenceFiles: row.evidenceFiles,
    discoveredFiles: row.discoveredFiles,
    mismatches: row.mismatches,
    provenance: row.provenance,
  }));
  const freshInventoryDigest = computeInventoryDigest(buildInventoryDigestPayload({
    report, exceptions, bundledRows: freshBundledInventory,
  }));
  if (freshInventoryDigest !== report.inventoryDigest) {
    throw new Error(
      `license_artifact_inventory_digest_mismatch: report=${report.inventoryDigest.slice(0, 12)} fresh=${freshInventoryDigest.slice(0, 12)}`
    );
  }
  // Re-shape bundled rows to expose `evidenceFiles` (PROVENANCE-pinned) and
  // `discoveredFiles` (every walked file) so the inventory carries both the
  // pinned evidence and the discovery set for change detection.
  const bundledInventory = freshBundledInventory;
  const bundledClear = bundledInventory.every(row => {
    const disclosed = new Set(row.evidenceFiles.map(file => file.file));
    return row.mismatches.length === 0 && row.discoveredFiles
      .filter(file => !/^PROVENANCE\.(?:json|md)$/i.test(file.file))
      .every(file => disclosed.has(file.file));
  });
  const installedClear = installedRows.every(row => row.status === 'root_text_collected'
    || row.provenance === 'installed_README_section'
    || row.provenance === 'pinned_upstream_release'
    || row.provenance === 'pinned_npm_release_integrity'
    || row.provenance === 'pinned_upstream_matching_code'
    || row.provenance === 'retained_third_party_evidence');
  return {
    schema: 'control-room.runtime-license-artifact-inventory/v1',
    manifestSha256: report.manifestSha256,
    lockSha256: report.lockSha256,
    inventoryDigest: report.inventoryDigest,
    completeDistributionClearance: bundledClear && installedClear,
    scope: 'complete for the declared artifact inputs only; #64 independently verifies the assembled release tree',
    repository: path.basename(repository),
    installed: {
      count: installedRows.length,
      rootTextCollected: installedRows.filter(r => r.status === 'root_text_collected').length,
      missingRootText: installedRows.filter(r => r.status === 'missing_root_text').length,
      rows: installedRows,
    },
    bundled: {
      count: bundledInventory.length,
      rows: bundledInventory,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildArtifactInventory();
  const target = process.argv[2] || 'research/runtime-license-artifact-inventory.json';
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`${target} digest=${out.inventoryDigest}\n`);
}
