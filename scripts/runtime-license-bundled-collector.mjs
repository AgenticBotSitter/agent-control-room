// Walk the artifact's bundled (third_party + src/vendor) roots and return
// per-package rows. Each row carries:
//   - `evidenceFiles`: files explicitly pinned by the package's PROVENANCE.json.
//     These are the only files that count as bundled-evidence in #11's sense.
//   - `discoveredFiles`: every regular file found by walking the root, used
//     for change detection (file-hash drift between captured evidence and the
//     current on-disk artifact).
//   - `mismatches`: pinned files whose on-disk bytes differ from PROVENANCE.
//   - `provenance`: source commit, installed version, qualification line.
//
// Rules:
//   - Only walks paths inside the repository (third_party + src/vendor).
//   - Rejects symlinks; rejects files > 2 MB; ignores empty files.
//   - Reads `PROVENANCE.json` if present and uses its `files[]` array as the
//     authoritative list of evidence files (matched against the walked files
//     by path + sha256). Without PROVENANCE.json, evidenceFiles is empty and
//     the package is marked `missing_provenance`.
//   - Never invents revision, file hash, license text, or qualification claim.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertInsideRepository, normalizeRelative } from './runtime-license-repository-guard.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const VENDOR_ROOTS = ['src/vendor'];
const THIRD_PARTY_ROOT = 'third_party';
const REVIEW_PATH = 'research/runtime-license-retained-provenance.json';
const BASELINE_PATH = 'research/runtime-license-artifact-inventory.json';

function lockIntegrity(lockText, name, version) {
  const escaped = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = lockText.match(new RegExp(`^  ['"]?${escaped}['"]?:\\n(?:.*\\n){0,8}?    resolution: \\{integrity: ([^}]+)\\}`, 'm'));
  if (!match) throw new Error(`retained_provenance_lock_integrity_missing:${name}@${version}`);
  return match[1].trim();
}

/** Walk a directory and return its non-empty regular files (skipping symlinks). */
function walkRegularFiles(rootAbsolute) {
  const out = [];
  const stack = [rootAbsolute];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.lstatSync(current).isDirectory() ? fs.readdirSync(current, { withFileTypes: true }) : []; }
    catch { continue; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      let stat;
      try { stat = fs.lstatSync(child); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) stack.push(child);
      else if (stat.isFile() && stat.size > 0 && stat.size <= 2_000_000) {
        out.push({ absolutePath: child, relativePath: normalizeRelative(rootAbsolute, child), bytes: stat.size });
      }
    }
  }
  return out;
}

/** Read PROVENANCE.json if present; return null when absent or invalid.
 *  Only inspects files named PROVENANCE.json directly inside `absDir`. */
function readProvenance(absDir) {
  const p = path.join(absDir, 'PROVENANCE.json');
  if (!fs.existsSync(p) || !fs.lstatSync(p).isFile()) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** For each file pinned by PROVENANCE.json, verify the on-disk file matches
 *  the pinned sha256 + bytes. Returns the verified evidence file list.
 *  Never invents missing evidence — files that fail the check are reported
 *  as `mismatch` and excluded from `evidenceFiles`. */
function evidenceFilesFromProvenance(absDir, walked, reviewed, baselineFiles) {
  if (reviewed) {
    const pins = baselineFiles ?? [];
    const mismatches = [];
    const files = [];
    for (const pinned of pins) {
      const onDisk = walked.find(w => w.relativePath === pinned.file);
      if (!onDisk || hash(fs.readFileSync(onDisk.absolutePath)) !== pinned.sha256 || onDisk.bytes !== pinned.bytes) {
        mismatches.push({ path: pinned.file, reason: 'reviewed_retained_file_mismatch', pinnedSha256: pinned.sha256 });
      } else files.push({ file: pinned.file, bytes: onDisk.bytes, sha256: pinned.sha256 });
    }
    return { files, mismatches, provenance: reviewed };
  }
  const prov = readProvenance(absDir);
  if (!prov || !Array.isArray(prov.files)) return { files: [], mismatches: [], provenance: prov };
  const mismatches = [];
  const matched = [];
  for (const pinned of prov.files) {
    if (!pinned || typeof pinned.path !== 'string') continue;
    const pinnedRel = pinned.path.split(/[\\/]+/).join('/');
    const onDisk = walked.find(w => w.relativePath === pinnedRel);
    if (!onDisk) {
      mismatches.push({ path: pinnedRel, reason: 'pinned_file_missing_on_disk', pinnedSha256: pinned.sha256 ?? null });
      continue;
    }
    const onDiskSha = hash(fs.readFileSync(onDisk.absolutePath));
    if (onDiskSha !== pinned.sha256 || onDisk.bytes !== pinned.bytes) {
      mismatches.push({ path: pinnedRel, reason: 'pinned_hash_or_size_mismatch', onDiskSha256: onDiskSha, onDiskBytes: onDisk.bytes });
      continue;
    }
    matched.push({ file: pinnedRel, bytes: onDisk.bytes, sha256: onDiskSha });
  }
  return { files: matched, mismatches, provenance: prov };
}

function buildThirdPartyRow(repository, name, absDir, reviews, baseline) {
  const relDir = normalizeRelative(repository, absDir);
  const walked = walkRegularFiles(absDir);
  const review = reviews[relDir] ?? null;
  const old = baseline.get(relDir) ?? [];
  const evidence = evidenceFilesFromProvenance(absDir, walked, review, old);
  let provenanceRow;
  if (evidence.provenance) {
    provenanceRow = {
      source: evidence.provenance.packageName ? `npm:${evidence.provenance.packageName}@${evidence.provenance.packageVersion}` : evidence.provenance.source ?? null,
      sourceCommit: evidence.provenance.sourceCommit ?? null,
      distributionIntegrity: evidence.provenance.distributionIntegrity ?? null,
      reviewedExclusion: evidence.provenance.reviewedExclusion ?? null,
      reviewedExclusions: evidence.provenance.reviewedExclusions ?? [],
      installedVersion: evidence.provenance.packageVersion ?? evidence.provenance.installedVersion ?? null,
      sourceManifestVersion: evidence.provenance.sourceManifestVersion ?? null,
      qualification: evidence.provenance.qualification ?? null,
    };
  } else {
    // Synthesize from the installed manifest only.
    const manifestCandidate = walked.find(w => w.relativePath === 'package.json'
      || w.relativePath === 'upstream-package.json');
    let installedVersion = null, installedManifestSha256 = null;
    if (manifestCandidate) {
      try {
        const obj = JSON.parse(fs.readFileSync(manifestCandidate.absolutePath, 'utf8'));
        installedVersion = obj.version ?? null;
        installedManifestSha256 = hash(fs.readFileSync(manifestCandidate.absolutePath));
      } catch { /* leave nulls */ }
    }
    provenanceRow = {
      source: null,
      sourceCommit: null,
      installedVersion,
      sourceManifestVersion: null,
      qualification: 'missing_provenance; synthesized from retained text only',
    };
  }
  return {
    package: name,
    root: relDir,
    evidenceFiles: evidence.files,
    discoveredFiles: walked.map(w => ({ file: w.relativePath, bytes: w.bytes, sha256: hash(fs.readFileSync(w.absolutePath)) })),
    provenance: provenanceRow,
    mismatches: evidence.mismatches,
  };
}

function buildVendorRow(repository, vendorRoot, name, absDir, reviews, baseline) {
  const relDir = normalizeRelative(repository, absDir);
  const walked = walkRegularFiles(absDir);
  const review = reviews[relDir] ?? null;
  const old = baseline.get(relDir) ?? [];
  const evidence = evidenceFilesFromProvenance(absDir, walked, review, old);
  let provenanceRow;
  if (evidence.provenance) {
    provenanceRow = {
      source: evidence.provenance.source ?? null,
      sourceCommit: evidence.provenance.sourceCommit ?? null,
      distributionIntegrity: evidence.provenance.distributionIntegrity ?? null,
      reviewedExclusion: evidence.provenance.reviewedExclusion ?? null,
      reviewedExclusions: evidence.provenance.reviewedExclusions ?? [],
      installedVersion: evidence.provenance.installedVersion ?? null,
      sourceManifestVersion: evidence.provenance.sourceManifestVersion ?? null,
      qualification: evidence.provenance.qualification ?? null,
    };
  } else {
    provenanceRow = {
      source: null,
      sourceCommit: null,
      installedVersion: null,
      sourceManifestVersion: null,
      qualification: 'declared_vendor_root; PROVENANCE.json missing; revision not verified',
    };
  }
  return {
    package: name,
    root: relDir,
    vendor: vendorRoot,
    evidenceFiles: evidence.files,
    discoveredFiles: walked.map(w => ({ file: w.relativePath, bytes: w.bytes, sha256: hash(fs.readFileSync(w.absolutePath)) })),
    provenance: provenanceRow,
    mismatches: evidence.mismatches,
  };
}

/** Walk all bundled roots and return rows sorted deterministically.
 *  Refuses any `repository` path that does not resolve inside a real repo. */
export function collectBundledRows(repository = process.cwd()) {
  assertInsideRepository(repository, THIRD_PARTY_ROOT, ...VENDOR_ROOTS, REVIEW_PATH, BASELINE_PATH);
  const reviewPath = path.join(repository, REVIEW_PATH);
  const reviews = fs.existsSync(reviewPath)
    ? (JSON.parse(fs.readFileSync(reviewPath, 'utf8')).roots ?? {}) : {};
  if (Object.keys(reviews).length) {
    const lockText = fs.readFileSync(path.join(repository, 'pnpm-lock.yaml'), 'utf8');
    for (const review of Object.values(reviews)) {
      if (review.packageName && review.packageVersion) {
        review.distributionIntegrity = lockIntegrity(lockText, review.packageName, review.packageVersion);
      }
    }
  }
  const baselinePath = path.join(repository, BASELINE_PATH);
  const baselineJson = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {};
  const baseline = new Map((baselineJson.bundled?.rows ?? []).map(row => [row.root,
    (row.discoveredFiles ?? []).filter(f => !f.file.startsWith('PROVENANCE')).map(f => ({ file: f.file, bytes: f.bytes, sha256: f.sha256 }))]));
  const rows = [];
  const thirdPartyAbs = path.join(repository, THIRD_PARTY_ROOT);
  if (fs.existsSync(thirdPartyAbs) && fs.lstatSync(thirdPartyAbs).isDirectory()) {
    for (const entry of fs.readdirSync(thirdPartyAbs).sort()) {
      const childAbs = path.join(thirdPartyAbs, entry);
      if (!fs.lstatSync(childAbs).isDirectory()) continue;
      rows.push(buildThirdPartyRow(repository, entry, childAbs, reviews, baseline));
    }
  }
  for (const vendorRoot of VENDOR_ROOTS) {
    const vendorAbs = path.join(repository, vendorRoot);
    if (!fs.existsSync(vendorAbs) || !fs.lstatSync(vendorAbs).isDirectory()) continue;
    for (const entry of fs.readdirSync(vendorAbs).sort()) {
      const childAbs = path.join(vendorAbs, entry);
      if (!fs.lstatSync(childAbs).isDirectory()) continue;
      rows.push(buildVendorRow(repository, vendorRoot, entry, childAbs, reviews, baseline));
    }
  }
  return rows.sort((a, b) => {
    if (a.package !== b.package) return a.package < b.package ? -1 : 1;
    if (a.root !== b.root) return a.root < b.root ? -1 : 1;
    return 0;
  });
}

/** Read the captured exceptions file. Refuses paths outside the repo. */
export function readExceptions(repository = process.cwd()) {
  assertInsideRepository(repository, 'research/runtime-license-exceptions.json');
  const exceptionsPath = path.join(repository, 'research/runtime-license-exceptions.json');
  if (!fs.existsSync(exceptionsPath)) return { scope: '', entries: [] };
  return JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
}
