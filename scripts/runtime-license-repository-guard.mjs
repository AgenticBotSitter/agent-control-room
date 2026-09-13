// Shared repository-boundary helpers used by every script that accepts a
// `repository` argument. Centralising these prevents the scripts from
// silently accepting a caller-supplied path that resolves outside the repo
// (e.g. `/etc/passwd`, a sibling workspace, or a symlink escape).
//
// Usage:
//   import { assertInsideRepository, normalizeRepoPath, normalizeRelative } from './runtime-license-repository-guard.mjs';
//
// `normalizeRelative(repository, absolute)` is the one place that does the
// Windows-safe `path.relative(...) + .split(/[\\/]+/).join('/')` chain.
// Every script that produces a relative path MUST route through it so
// captured paths stay canonical across Windows / POSIX.

import fs from 'node:fs';
import path from 'node:path';

/** Resolve a repository path that may already be absolute. Returns the
 *  realpath (following symlinks). */
export function resolveRepository(repository) {
  if (typeof repository !== 'string' || repository.length === 0) {
    throw new Error('license_repository_required');
  }
  try {
    return fs.realpathSync(repository);
  } catch (err) {
    throw new Error(`license_repository_not_found: ${repository}`);
  }
}

/** Assert every candidate path resolves inside the repository root. */
export function assertInsideRepository(repository, ...candidates) {
  const root = resolveRepository(repository);
  for (const candidate of candidates) {
    assertSingleInside(root, candidate);
  }
}

function assertSingleInside(root, candidate) {
  if (typeof candidate !== 'string') {
    throw new Error(`license_path_not_a_string: ${candidate}`);
  }
  const absolute = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
  // Try to resolve the full candidate path so a symlink whose TARGET is
  // outside the repository is still rejected. If the candidate doesn't
  // exist (or is a dangling symlink), `realpathSync` throws ENOENT.
  let resolvedFull = null;
  try {
    resolvedFull = fs.realpathSync(absolute);
    if (!resolvedFull.startsWith(root + path.sep) && resolvedFull !== root) {
      throw new Error(`license_path_outside_repository: ${candidate} -> ${resolvedFull}`);
    }
    return;
  } catch (err) {
    if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR' && err.code !== 'ELOOP') throw err;
  }
  // The full path doesn't resolve. This covers two cases:
  //   (a) the file simply doesn't exist yet (e.g. a test fixture that
  //       writes the file later) — fall back to parent-dir realpath and
  //       lexical checks.
  //   (b) the path is a DANGLING symlink — `realpathSync` failed, but
  //       `readlinkSync` will return the symlink target. We must still
  //       verify the symlink target resolves inside the repository; if
  //       not, reject the path.
  let lstat;
  try {
    lstat = fs.lstatSync(absolute);
  } catch {
    lstat = null;
  }
  if (lstat) {
    // The candidate path exists (file, dir, or symlink). If it's a
    // symlink, verify the symlink target is also inside the repository —
    // even when the target itself is dangling.
    if (lstat.isSymbolicLink()) {
      let target;
      try { target = fs.readlinkSync(absolute); }
      catch { target = null; }
      if (target !== null) {
        const resolvedTarget = path.resolve(path.dirname(absolute), target);
        try {
          const realTarget = fs.realpathSync(resolvedTarget);
          // Compare against the realpath of root, not the lexical root,
          // so the macOS /var -> /private/var symlink quirk doesn't false-
          // reject an in-repo target.
          const realRoot = fs.realpathSync(root);
          if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
            throw new Error(`license_path_outside_repository: ${candidate} -> ${resolvedTarget}`);
          }
          return;
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            // Target is dangling. We can't realpath the target (it
            // doesn't exist), so we compare against the existing
            // ancestor -- whatever's closest to the target that's
            // actually on disk and resolvable. The macOS `/var` vs
            // `/private/var` symlink quirk is handled by realpathing
            // every existing ancestor.
            const lexicalTarget = path.resolve(resolvedTarget);
            const realRoot = fs.realpathSync(root);
            // Walk up from the target to find the deepest existing
            // ancestor. Anything below that point is a non-existent
            // tail; anything above is on disk and realpath-resolvable.
            let probe = lexicalTarget;
            while (probe && probe !== path.dirname(probe)) {
              try {
                const realProbe = fs.realpathSync(probe);
                if (realProbe.startsWith(realRoot + path.sep) || realProbe === realRoot) {
                  return;
                }
                break;
              } catch {
                probe = path.dirname(probe);
              }
            }
            // No existing ancestor or every existing ancestor falls
            // outside the realpath root. Reject.
            throw new Error(`license_path_outside_repository: ${candidate} -> ${lexicalTarget}`);
          }
          if (err && err.code === 'ELOOP') {
            throw new Error(`license_path_outside_repository: ${candidate} (symlink loop)`);
          }
          throw err;
        }
      }
    }
  }
  let resolved;
  try {
    resolved = fs.realpathSync(path.dirname(absolute))
      + path.sep + path.basename(absolute);
  } catch {
    // Path may not exist yet (e.g. a test fixture that builds the file later).
    // Fall back to a lexical check.
    const lexical = path.resolve(absolute);
    if (!lexical.startsWith(root + path.sep) && lexical !== root) {
      throw new Error(`license_path_outside_repository: ${candidate}`);
    }
    return;
  }
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`license_path_outside_repository: ${candidate}`);
  }
}

/** Compute a Windows-safe repo-relative path from an absolute path.
 *  Normalizes Windows backslashes (and any doubled separators) to forward
 *  slashes BEFORE calling `path.relative`, because Node's POSIX `path`
 *  module does not treat `\` as a separator. Both the repository root and
 *  the candidate are passed through `realpathSync` so a caller that mixes
 *  `/var/folders/...` (the unexpanded macOS temp dir) and
 *  `/private/var/folders/...` (its realpath) still computes a correct
 *  in-repo relative path.
 *
 *  Caller may pass either an absolute path (typical: from `pnpm licenses
 *  list --json` on any platform) or a path that is already repo-relative
 *  (typical: from an in-script walk). In the latter case, the function
 *  verifies the result is still inside the repository. */
export function normalizeRelative(repository, absolute) {
  if (typeof absolute !== 'string') {
    throw new Error('license_path_not_a_string');
  }
  const normalized = absolute.split(/[\\/]+/).join('/');
  const root = resolveRepository(repository);
  let realAbsolute;
  try {
    realAbsolute = fs.realpathSync(normalized);
  } catch {
    // Path doesn't exist (e.g. we're synthesizing relative output for a
    // test fixture). Fall back to a lexical comparison against the
    // repository path AS GIVEN by the caller (not the realpath). This is
    // important because callers sometimes pass paths with `/var/folders/...`
    // (the unexpanded macOS temp dir) and sometimes with the realpath
    // `/private/var/folders/...`. The repository path the caller passed
    // works for one case; the realpath works for the other. Use BOTH.
    const lexical = path.resolve(normalized);
    const callerRoot = path.resolve(repository);
    const matchesLexical = lexical.startsWith(callerRoot + path.sep) || lexical === callerRoot;
    const matchesReal = root === callerRoot
      ? matchesLexical
      : (lexical.startsWith(root + path.sep) || lexical === root);
    if (!matchesLexical && !matchesReal) {
      throw new Error(`license_path_outside_repository: ${absolute}`);
    }
    const refRoot = matchesLexical ? callerRoot : root;
    const rel = lexical === refRoot ? '' : lexical.slice(refRoot.length + 1);
    return rel.split(/[\\/]+/).join('/');
  }
  const relative = path.relative(root, realAbsolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`license_path_outside_repository: ${absolute}`);
  }
  return relative.split(/[\\/]+/).join('/');
}
