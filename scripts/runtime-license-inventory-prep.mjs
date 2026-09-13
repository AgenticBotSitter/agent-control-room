// Portable, deterministic pnpm-licenses preparation for the captured
// runtime-license-input.json. Converts the pnpm license-keyed JSON to
// the flat `records[]` schema consumed by `runtime-license-report.mjs`,
// strips absolute paths to repo-relative, and binds the manifest/lock
// digests so the report's staleness guards work.
//
// This script is the regenerator referenced by `runtime-license-artifact-inventory.mjs`
// when the captured input is stale. It does NOT install packages, does NOT
// resolve transitive-only licenses (pnpm does that), and does NOT bind any
// exception text — that work happens in `runtime-license-assembly.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertInsideRepository, normalizeRelative } from './runtime-license-repository-guard.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Narrow manifest hash (matches `manifestSubsetHash` in runtime-license-report.mjs).
 *  Throws if the repository path is outside a real repo. */
export function manifestSubsetHash(repository = process.cwd()) {
  assertInsideRepository(repository, 'package.json', 'pnpm-lock.yaml');
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
  const subset = {};
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const field = manifest[key];
    if (field && typeof field === 'object' && Object.keys(field).length) {
      subset[key] = Object.fromEntries(Object.keys(field).sort().map(k => [k, field[k]]));
    }
  }
  return hash(Buffer.from(JSON.stringify(subset)));
}

/** Capture pnpm licenses output and reshape into the flat-records schema. */
export function prepareRuntimeLicenseInput(repository = process.cwd(), pnpmOutput) {
  assertInsideRepository(repository, 'package.json', 'pnpm-lock.yaml');
  if (typeof pnpmOutput !== 'string') {
    throw new Error('license_prep_pnpm_output_required');
  }
  const manifestSha256 = manifestSubsetHash(repository);
  const lockSha256 = hash(fs.readFileSync(path.join(repository, 'pnpm-lock.yaml')));
  const raw = JSON.parse(pnpmOutput);
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    throw new Error('license_prep_pnpm_schema_unexpected');
  }
  const records = [];
  const seen = new Set();
  for (const [license, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) {
      throw new Error('license_prep_pnpm_license_array_required');
    }
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || !Array.isArray(entry.versions) || !entry.versions.length
        || !Array.isArray(entry.paths) || !entry.paths.length) {
        throw new Error('license_prep_pnpm_entry_shape_invalid');
      }
      const relativePaths = entry.paths.map(absolute => normalizeRelative(repository, absolute));
      for (const relative of relativePaths) {
        if (seen.has(relative)) throw new Error('license_prep_pnpm_duplicate_path');
        seen.add(relative);
      }
      records.push({ name: entry.name, versions: [...entry.versions].sort(), paths: relativePaths, license });
    }
  }
  records.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.versions[0] !== b.versions[0]) return a.versions[0] < b.versions[0] ? -1 : 1;
    return a.paths[0] < b.paths[0] ? -1 : 1;
  });
  return {
    manifestSha256,
    lockSha256,
    source: 'pnpm@11.19.0 licenses list --prod --json',
    scope: 'prepared local production dependency inventory; not bundle coverage',
    records,
  };
}

/** Run pnpm licenses and write the captured input. */
export function regenerateCapturedInput(repository = process.cwd(), outputPath = 'research/runtime-license-input.json') {
  assertInsideRepository(repository, 'package.json', 'pnpm-lock.yaml');
  const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: repository, encoding: 'utf8', timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`license_prep_pnpm_failed: ${result.stderr || result.stdout}`);
  }
  const prepped = prepareRuntimeLicenseInput(repository, result.stdout);
  const absoluteOutput = path.isAbsolute(outputPath)
    ? outputPath
    : path.join(repository, outputPath);
  assertInsideRepository(repository, normalizeRelative(repository, path.dirname(absoluteOutput)) || '.');
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, JSON.stringify(prepped, null, 2) + '\n');
  return { outputPath: absoluteOutput, manifestSha256: prepped.manifestSha256, lockSha256: prepped.lockSha256, records: prepped.records.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = regenerateCapturedInput();
  process.stdout.write(`${out.outputPath} records=${out.records} manifest=${out.manifestSha256.slice(0,12)} lock=${out.lockSha256.slice(0,12)}\n`);
}
