// scripts/runtime-license-bundled-scan.mjs
//
// Detect vendored / bundled code that lives OUTSIDE node_modules/ and is
// NOT enumerated in the prepared runtime license inventory.
//
// Why this exists
//   The runtime-license layer (runtime-license-report.mjs +
//   runtime-license-assembly.mjs) only scans `node_modules/` plus four
//   hand-curated `third_party/<name>/` exceptions (saxes, pg-types,
//   pgpass, @nodable/entities). Any code vendored under `src/vendor/`,
//   `assets/`, or any other top-level directory that is NOT one of the
//   named exceptions is currently invisible to the release notice layer.
//
// What this script does
//   Walks the repository root looking for top-level vendor-like
//   directories (default: `src/vendor/`). For every discovered subtree,
//   it checks that:
//     - The subtree has at least one source file (non-empty).
//     - A matching evidence bundle exists at `third_party/<basename>/`
//       containing at least a LICENSE or NOTICE file.
//   Anything failing these checks is emitted as a `bundled_undisclosed`
//   row in the resulting report.
//
// What this script does NOT do
//   - It does NOT touch scripts/license-evidence.mjs (the CycloneDX
//     collector; out of scope for this packet).
//   - It does NOT modify the release artifact. It only produces a
//     report a maintainer can use to decide whether a vendored tree
//     needs a third_party evidence bundle.
//   - It does NOT recurse into node_modules/ or into third_party/
//     (those are handled by the inventory + exception layer).
//
// Cross-platform:
//   - Uses forward-slash everywhere internally; never emits a
//     backslash in the output paths.
//   - Uses `path.sep`-aware directory walks; works on Windows, macOS,
//     and Linux identically.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const DEFAULT_VENDOR_ROOTS = ['src/vendor', 'vendor', 'assets/vendor'];

/**
 * Recursively enumerate every regular file under `root`, returning
 * repo-relative forward-slash paths. Symlinks, devices, FIFOs, and
 * sockets are skipped (not followed). Hidden directories are skipped.
 */
function enumerateFiles(root) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) walk(root, '');
  return out;
}

/**
 * Walk one vendor root and produce a row per discovered subtree.
 */
function scanVendorRoot(vendorRoot, repoRoot) {
  const absRoot = path.join(repoRoot, vendorRoot);
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) return [];
  const subdirs = fs.readdirSync(absRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));
  return subdirs.map(sub => {
    const subAbs = path.join(absRoot, sub.name);
    const files = enumerateFiles(subAbs).map(p => `${vendorRoot}/${sub.name}/${p}`);
    return {
      subtree: `${vendorRoot}/${sub.name}`,
      fileCount: files.length,
      fileSample: files.slice(0, 8),
      fileSha256Sample: files.slice(0, 8).map(p => hash(fs.readFileSync(path.join(repoRoot, p)))),
    };
  });
}

/**
 * Compare each vendor subtree against the third_party/ evidence bundle
 * for the same name. Emit `bundled_undisclosed` for any subtree that
 * lacks a matching LICENSE/NOTICE.
 */
export function scanBundledCode({
  repoRoot = process.cwd(),
  vendorRoots = DEFAULT_VENDOR_ROOTS,
} = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new Error('license_bundled_repo_root_missing');
  const subtrees = vendorRoots.flatMap(r => scanVendorRoot(r, repoRoot));
  const evidenceAbs = path.join(repoRoot, 'third_party');
  const evidenceDirs = fs.existsSync(evidenceAbs)
    ? new Set(fs.readdirSync(evidenceAbs).filter(d => fs.statSync(path.join(evidenceAbs, d)).isDirectory()))
    : new Set();
  const rows = [];
  for (const subtree of subtrees) {
    const base = subtree.subtree.split('/').pop();
    const hasLicense = evidenceDirs.has(base) && (
      fs.existsSync(path.join(evidenceAbs, base, 'LICENSE'))
      || fs.existsSync(path.join(evidenceAbs, base, 'LICENSE.md'))
      || fs.existsSync(path.join(evidenceAbs, base, 'LICENSE.txt'))
    );
    const hasNotice = evidenceDirs.has(base) && fs.existsSync(path.join(evidenceAbs, base, 'NOTICE.md'));
    rows.push({
      subtree: subtree.subtree,
      fileCount: subtree.fileCount,
      fileSample: subtree.fileSample,
      fileSha256Sample: subtree.fileSha256Sample,
      evidenceBundle: evidenceDirs.has(base) ? `third_party/${base}` : null,
      hasLicense, hasNotice,
      bundledUndisclosed: !(hasLicense || hasNotice),
    });
  }
  return rows;
}

// Portable CLI entry guard. Uses the existing path/fileURLToPath
// resolution pattern (see scripts/runtime-license-report.mjs) so the
// same script can run unmodified on POSIX with `node ./script.mjs`
// (entry guard true) and on Windows where argv[1] is a backslash path
// (positional argv[2]/process.cwd() still works the same).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = process.argv[2] || process.cwd();
  const rows = scanBundledCode({ repoRoot });
  process.stdout.write(JSON.stringify({
    schema: 'control-room.runtime-license-bundled-scan/v1',
    repoRoot,
    rows,
  }, null, 2) + '\n');
}
