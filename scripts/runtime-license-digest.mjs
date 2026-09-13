// Shared digest helpers used by `runtime-license-report.mjs` and
// `runtime-license-artifact-inventory.mjs`. Centralized here so the
// `inventoryDigest` is computed identically in both places and the
// release-qualification gate (#64) sees a single canonical value.
//
// All digest inputs are derived from the artifact (no caller-supplied
// paths). The digest is **not** clearance; it is a deterministic
// identifier for the bound inventory snapshot.

import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Canonical JSON serialization: stable key order. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

/** Build the canonical inventory-digest payload.
 *  Inputs are JSON-serializable: report, captured exceptions, third_party +
 *  src/vendor rows produced by the artifact-inventory walker. The bundled
 *  rows contribute EVERY walk-relevant field — evidenceFiles (PROVENANCE
 *  pins), discoveredFiles (every walked file + hash), and mismatches
 *  (PROVENANCE pins that don't match on-disk bytes). Without all three,
 *  the digest would silently accept drift in un-pinned content or in
 *  mismatched pins. */
export function buildInventoryDigestPayload({ report, exceptions, bundledRows }) {
  return {
    manifestSha256: report.manifestSha256,
    lockSha256: report.lockSha256,
    inventorySha256: report.inventorySha256,
    exceptionNames: exceptions.entries.map(e => `${e.name}@${e.version}`).sort(),
    exceptionFingerprints: exceptions.entries.map(e => `${e.name}@${e.version}|${e.manifestSha256}|${e.textSha256}`).sort(),
    installedPackages: report.results.map(r => ({
      name: r.name, version: r.version, manifestSha256: r.manifestSha256,
      status: r.status, attachments: r.attachments.map(a => ({ file: a.file, sha256: a.sha256 })),
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    bundled: bundledRows.map(r => ({
      package: r.package, root: r.root,
      evidenceFiles: r.evidenceFiles.map(f => ({ file: f.file, sha256: f.sha256 })).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
      discoveredFiles: (r.discoveredFiles ?? []).map(f => ({ file: f.file, sha256: f.sha256, bytes: f.bytes })).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
      mismatches: (r.mismatches ?? []).map(m => ({ path: m.path, reason: m.reason, pinnedSha256: m.pinnedSha256 ?? null, onDiskSha256: m.onDiskSha256 ?? null })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      provenance: r.provenance,
    })),
  };
}

/** Compute the canonical inventory digest for the artifact. */
export function computeInventoryDigest(payload) {
  return hash(canonicalize(payload));
}
