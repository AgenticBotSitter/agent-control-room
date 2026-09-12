import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectLicenseEvidence } from './license-evidence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** Narrow `package.json` to the fields that actually determine the license inventory,
 *  then hash a stable canonical serialization. Top-level fields like `scripts`,
 *  `name`, formatting, or key order do not move this hash, so unrelated `main`
 *  churn stops invalidating every open PR's license pin. See issue #38. */
export function manifestSubsetHash(repository = process.cwd()) {
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
/** Uses a captured pnpm inventory, never discovers its own dependency graph. */
export function runtimeLicenseReport(input, repository = process.cwd()) {
  if (input.manifestSha256 !== manifestSubsetHash(repository)
    || input.lockSha256 !== hash(fs.readFileSync(path.join(repository, 'pnpm-lock.yaml')))) throw new Error('license_inventory_stale');
  if (!Array.isArray(input.records) || !input.records.length || input.records.length > 4096) throw new Error('license_inventory_invalid');
  const modules = path.join(repository, 'node_modules'), seen = new Set(), results = [];
  for (const record of input.records) {
    if (typeof record.name !== 'string' || !Array.isArray(record.versions) || !record.versions.length
      || !Array.isArray(record.paths) || !record.paths.length || record.paths.length > 128) throw new Error('license_record_invalid');
    const observed = new Set();
    for (const relative of record.paths) {
      if (typeof relative !== 'string' || !relative.startsWith('node_modules/') || path.posix.normalize(relative) !== relative
        || relative.includes('\\') || seen.has(relative)) throw new Error('license_package_path_invalid');
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
