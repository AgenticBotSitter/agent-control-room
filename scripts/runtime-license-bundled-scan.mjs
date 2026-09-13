// Artifact-derived bundled-undisclosed scanner.
//
// Walks the vendor roots THAT THE INVENTORY ALREADY DECLARES (artifact-only,
// never caller-supplied) and reports any vendored subtree that does NOT have
// matching evidence in the inventory. Fail-closed: throws on any caller path
// that escapes the repository.
//
// Strict rules:
//   - Rejects absolute caller paths outside the repository.
//   - Rejects traversal/symlink targets outside the repo root.
//   - Refuses to download anything or run any install.
//   - Vendor roots are derived from the inventory (which is itself derived
//     from the artifact's `src/vendor` + `third_party` walks). No caller
//     allowlist, no caller-supplied inventory.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildArtifactInventory } from './runtime-license-artifact-inventory.mjs';
import { assertInsideRepository, normalizeRelative } from './runtime-license-repository-guard.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Walk a directory for regular files, ignoring symbolic links.
 *  Windows-safe: relative paths use forward slashes regardless of platform. */
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

/** Build the bundled-undisclosed scan result.
 *  Vendor roots come ONLY from the inventory (derived from the artifact).
 *  No caller-supplied vendor allowlist, no caller-supplied inventory. */
export function scanBundledUndisclosed(repository = process.cwd()) {
  assertInsideRepository(repository, 'third_party', 'src/vendor');

  const inventory = buildArtifactInventory(repository);

  // Derive vendor roots from the inventory's bundled rows. Every distinct
  // vendor-root prefix the inventory actually recognized — `src/vendor` or
  // `third_party` — is what we walk. Caller cannot inject a fabricated root
  // because `inventory.bundled.rows` is built from the artifact walk, not
  // from caller input.
  const declaredVendorRoots = (() => {
    const seen = new Set();
    for (const row of inventory.bundled.rows) {
      const parts = row.root.split('/');
      if (parts[0] === 'third_party') seen.add('third_party');
      else if (parts[0] === 'src' && parts[1] === 'vendor') seen.add('src/vendor');
    }
    return Array.from(seen).sort();
  })();
  // If the inventory has no bundled rows, default to scanning both declared
  // vendor roots so the result is well-formed even when empty.
  if (declaredVendorRoots.length === 0) {
    declaredVendorRoots.push('third_party', 'src/vendor');
  }

  const observations = [];
  for (const vendorRoot of declaredVendorRoots) {
    const rootAbs = path.join(repository, vendorRoot);
    if (!fs.existsSync(rootAbs) || !fs.lstatSync(rootAbs).isDirectory()) continue;
    for (const entry of fs.readdirSync(rootAbs).sort()) {
      const childAbs = path.join(rootAbs, entry);
      if (!fs.lstatSync(childAbs).isDirectory()) continue;
      // Find the inventory row for this package (any root under this vendorRoot).
      const inventoryRow = inventory.bundled.rows.find(r => r.package === entry && r.root.startsWith(vendorRoot));
      const evidenceFiles = inventoryRow?.evidenceFiles ?? [];
      const observationsForEntry = walkRegularFiles(childAbs)
        .filter(({ relativePath }) => relativePath !== 'PROVENANCE.json' && !relativePath.endsWith('/PROVENANCE.json'))
        .map(({ absolutePath, bytes, relativePath: pathUnderRoot }) => {
        const sha = hash(fs.readFileSync(absolutePath));
        // Repo-relative path for the observation record. Windows-safe.
        const repoRelative = normalizeRelative(repository, absolutePath);
        // Decide status: matched iff the inventory's evidenceFiles has a row
        // with the exact path AND hash. Otherwise the file is a discovered
        // artifact without PROVENANCE-pinned evidence.
        let status = 'bundled_undisclosed', evidenceRow = null;
        const evidenceMatch = evidenceFiles.find(f => f.file === pathUnderRoot && f.sha256 === sha);
        if (evidenceMatch) {
          status = 'bundled_evidence_match';
          evidenceRow = { root: inventoryRow.root, sha256: evidenceMatch.sha256, bytes: evidenceMatch.bytes };
        }
        return {
          package: entry,
          vendorRoot,
          path: repoRelative,
          bytes,
          sha256: sha,
          status,
          evidenceRow,
        };
      });
      observations.push(...observationsForEntry);
    }
  }

  observations.sort((a, b) => {
    if (a.package !== b.package) return a.package < b.package ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return 0;
  });

  const undisclosed = observations.filter(o => o.status === 'bundled_undisclosed');
  const matched = observations.filter(o => o.status === 'bundled_evidence_match');

  return {
    schema: 'control-room.runtime-license-bundled-scan/v1',
    inventoryDigest: inventory.inventoryDigest,
    summary: { observed: observations.length, matched: matched.length, undisclosed: undisclosed.length },
    observations,
    undisclosed,
    scope: 'artifact-derived vendor roots only; bundled-undisclosed rows require separate evidence',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = scanBundledUndisclosed();
  const target = process.argv[2] || 'research/runtime-license-bundled-scan.json';
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(`${target} observed=${result.summary.observed} matched=${result.summary.matched} undisclosed=${result.summary.undisclosed} digest=${result.inventoryDigest.slice(0,12)}\n`);
}
