import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectLicenseEvidence } from './license-evidence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** Uses a captured pnpm inventory, never discovers its own dependency graph. */
export function runtimeLicenseReport(input, repository = process.cwd()) {
  if (input.manifestSha256 !== hash(fs.readFileSync(path.join(repository, 'package.json')))
    || input.lockSha256 !== hash(fs.readFileSync(path.join(repository, 'pnpm-lock.yaml')))) throw new Error('license_inventory_stale');
  if (!Array.isArray(input.records) || !input.records.length || input.records.length > 4096) throw new Error('license_inventory_invalid');
  const modules = path.join(repository, 'node_modules'), seen = new Set(), results = [];
  for (const record of input.records) {
    if (typeof record.name !== 'string' || !Array.isArray(record.versions) || !record.versions.length
      || !Array.isArray(record.paths) || !record.paths.length || record.paths.length > 128) throw new Error('license_record_invalid');
    const observed = new Set();
    for (const rawRelative of record.paths) {
      if (typeof rawRelative !== 'string') throw new Error('license_package_path_invalid');
      // Windows-prepared pnpm inventories may emit backslash-separated
      // paths (e.g. `node_modules\.pnpm\foo@1.0.0\node_modules\foo`).
      // Normalize to forward slash before the rest of the checks run.
      const relative = rawRelative.includes('\\') ? rawRelative.split('\\').join('/') : rawRelative;
      if (!relative.startsWith('node_modules/') || path.posix.normalize(relative) !== relative
        || seen.has(relative)) throw new Error('license_package_path_invalid');
      seen.add(relative);
      const directory = fs.realpathSync(path.join(repository, relative));
      if (!directory.startsWith(fs.realpathSync(modules) + path.sep)) throw new Error('license_package_outside_modules');
      const manifestPath = path.join(directory, 'package.json'), stat = fs.lstatSync(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('license_manifest_unavailable');
      const bytes = fs.readFileSync(manifestPath), manifest = JSON.parse(bytes);
      if (manifest.name !== record.name || !record.versions.includes(manifest.version)) throw new Error('license_package_identity_mismatch');
      observed.add(manifest.version);
      const attachments = collectLicenseEvidence(directory, modules).map(({ base64, ...metadata }) => metadata);
      results.push({ name: manifest.name, version: manifest.version, path: relative,
        manifestSha256: hash(bytes), attachments, status: attachments.length ? 'root_text_collected' : 'missing_root_text' });
    }
    if (record.versions.some(version => !observed.has(version))) throw new Error('license_inventory_version_missing');
  }
  return { schema: 'control-room.runtime-license-report/v1', manifestSha256: input.manifestSha256,
    lockSha256: input.lockSha256, inventorySha256: hash(JSON.stringify(input)),
    scope: 'prepared runtime root texts only; not complete distribution clearance',
    packages: results.length, missing: results.filter(value => value.status === 'missing_root_text').map(({ name, version }) => ({ name, version })), results };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(runtimeLicenseReport(JSON.parse(fs.readFileSync('research/runtime-license-input.json', 'utf8'))), null, 2));
}
