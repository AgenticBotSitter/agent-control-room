// scripts/runtime-license-inventory-prep.mjs
//
// Portable inventory preparation for the runtime-license layer.
//
// Reads `pnpm licenses list --prod --json` (the upstream source of truth for
// production-only package inventories on every platform pnpm supports:
// macOS, Linux, Windows). Strips the absolute leading path component to
// produce repo-relative `node_modules/...` paths. Emits the canonical
// research/runtime-license-input.json shape consumed by
// runtime-license-report.mjs (manifestSha256 + lockSha256 + records).
//
// Cross-platform:
//   - Never touches `process.cwd()` directly: the repository root is the
//     `--repo <dir>` argument (default: process.cwd() for ergonomic
//     in-repo invocations).
//   - Normalizes all output paths to forward-slash `node_modules/...` so
//     the same lockfile yields the same record.paths on Linux, macOS, and
//     Windows regardless of `path.sep`.
//   - Honors `--lockfile <path>` and `--manifest <path>` so the lockfile
//     and package.json hashes can be taken from a relocated checkout
//     (e.g. a CI cache clone) without copying the prepared input.
//
// Failure modes (thrown, not swallowed):
//   - pnpm not found → license_inventory_pnpm_unavailable
//   - pnpm licenses list exits nonzero → license_inventory_pnpm_failed
//   - pnpm output not parseable JSON → license_inventory_pnpm_malformed
//   - No records produced → license_inventory_empty
//   - pnpm output references a path with no `node_modules/` segment
//     (unexpected layout) → license_inventory_path_unrecognized
//
// The script never inspects package.json contents itself; the reporter
// script (runtime-license-report.mjs) is the source of truth for package
// identity. This script's job is only to translate the pnpm list output
// into the reporter's input shape.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import process from 'node:process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Resolve a pnpm path entry to a forward-slash, repo-relative
 * `node_modules/...` path. Throws license_inventory_path_unrecognized
 * when the entry has no `node_modules/` segment (which would mean the
 * upstream changed layout — we want to know, not guess).
 */
function relativizePath(entry, repoRoot) {
  const normalized = entry.split(/[\\/]+/).join('/');
  const marker = normalized.indexOf('node_modules/');
  if (marker < 0) throw new Error(`license_inventory_path_unrecognized: ${entry}`);
  const relativePath = normalized.slice(marker);
  if (repoRoot) {
    const abs = isAbsolute(entry) ? entry : relative(repoRoot, entry);
    void abs;
  }
  return relativePath;
}

/**
 * Run `pnpm licenses list --prod --json` from the given working
 * directory. Returns the parsed JSON object. Cross-platform: pnpm
 * handles its own platform differences.
 */
function pnpmLicensesJson(repoRoot) {
  let raw;
  try {
    raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('license_inventory_pnpm_unavailable');
    const stderr = error.stderr ? error.stderr.toString() : '';
    throw new Error(`license_inventory_pnpm_failed: ${stderr.slice(0, 400) || error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`license_inventory_pnpm_malformed: ${error.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('license_inventory_pnpm_malformed: not an object');
  }
  return parsed;
}

/**
 * Translate the pnpm licenses-list shape (a license → entries map) into
 * the flat record list the reporter expects. Sorts by name+version for
 * cross-platform determinism — same lockfile yields identical bytes.
 */
function flattenInventory(pnpmOutput, repoRoot) {
  const records = [];
  for (const [bucketLicense, entries] of Object.entries(pnpmOutput)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry.name !== 'string' || !Array.isArray(entry.versions) || !entry.versions.length) continue;
      if (!Array.isArray(entry.paths) || !entry.paths.length) continue;
      const paths = entry.paths.map(p => relativizePath(p, repoRoot));
      const license = (typeof entry.license === 'string' && entry.license) ? entry.license : bucketLicense;
      records.push({ name: entry.name, versions: entry.versions, paths, license });
    }
  }
  if (!records.length) throw new Error('license_inventory_empty');
  records.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    const av = a.versions[0] ?? '';
    const bv = b.versions[0] ?? '';
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  return records;
}

/**
 * Build the canonical research/runtime-license-input.json content.
 * Returns an object ready to JSON.stringify with sorted keys.
 */
export function prepareRuntimeLicenseInventory({
  repoRoot = process.cwd(),
  manifestPath = 'package.json',
  lockfilePath = 'pnpm-lock.yaml',
} = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new Error('license_inventory_repo_root_missing');
  const resolve = candidate => isAbsolute(candidate) ? candidate : `${repoRoot}${sep}${candidate}`;
  const manifestAbs = resolve(manifestPath);
  const lockfileAbs = resolve(lockfilePath);
  if (!existsSync(manifestAbs)) throw new Error(`license_inventory_manifest_missing: ${manifestAbs}`);
  if (!existsSync(lockfileAbs)) throw new Error(`license_inventory_lockfile_missing: ${lockfileAbs}`);
  const manifestBytes = readFileSync(manifestAbs);
  const lockfileBytes = readFileSync(lockfileAbs);
  const records = flattenInventory(pnpmLicensesJson(repoRoot), repoRoot);
  const sortedPayload = {
    manifestSha256: hash(manifestBytes),
    lockSha256: hash(lockfileBytes),
    source: `pnpm@${readPnpmVersion(repoRoot)} licenses list --prod --json`,
    scope: 'prepared local production dependency inventory; not bundle coverage',
    records,
  };
  return sortedPayload;
}

function readPnpmVersion(repoRoot) {
  try {
    const out = execFileSync('pnpm', ['--version'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim();
  } catch {
    return 'unknown';
  }
}

/**
 * CLI entry point. Parses --repo / --manifest / --lockfile / --out,
 * emits JSON to stdout (default) or --out path. Throws on any failure.
 */
function parseArgs(argv) {
  const args = { repoRoot: process.cwd(), manifestPath: 'package.json', lockfilePath: 'pnpm-lock.yaml', out: null };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--repo') { args.repoRoot = next; i++; }
    else if (flag === '--manifest') { args.manifestPath = next; i++; }
    else if (flag === '--lockfile') { args.lockfilePath = next; i++; }
    else if (flag === '--out') { args.out = next; i++; }
    else throw new Error(`license_inventory_unknown_flag: ${flag}`);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  const payload = prepareRuntimeLicenseInventory(args);
  const text = JSON.stringify(payload, null, 2) + '\n';
  if (args.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.out, text);
  } else {
    process.stdout.write(text);
  }
}
