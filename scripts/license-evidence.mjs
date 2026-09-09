import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = require.resolve('@cyclonedx/cyclonedx-library/package.json');
const implementation = path.join(path.dirname(manifest), 'dist.node/contrib/license/utils.node.js');
if (JSON.parse(fs.readFileSync(manifest, 'utf8')).version !== '10.2.0'
  || hash(fs.readFileSync(implementation)) !== '10a3bc2b7855dcfe85e8f3943d8bd2c512875d2cded34bc7df9ab51544891b36') {
  throw new Error('license_collector_pin_mismatch');
}
const { Utils: { LicenseEvidenceGatherer } } = require('@cyclonedx/cyclonedx-library/Contrib/License');

/** Build-time attachment seam, not a graph walker or full distribution clearance.
 * Caller supplies an installed package directory from the prepared pnpm graph.
 */
export function collectLicenseEvidence(packageDirectory, modulesDirectory) {
  const root = fs.realpathSync(modulesDirectory), directory = fs.realpathSync(packageDirectory);
  if (!directory.startsWith(root + path.sep)) throw new Error('license_package_outside_modules');
  const check = file => {
    if (path.dirname(file) !== directory) throw new Error('license_file_outside_package');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('license_file_unavailable');
    return file;
  };
  const errors = [];
  const collector = new LicenseEvidenceGatherer({ fs: {
    readdirSync(dir) {
      if (dir !== directory) throw new Error('license_directory_mismatch');
      const names = fs.readdirSync(dir);
      if (names.length > 10_000) throw new Error('license_directory_too_large');
      return names;
    },
    statSync: file => fs.lstatSync(check(file)),
    readFileSync: file => fs.readFileSync(check(file)),
  } });
  const attachments = [...collector.getFileAttachments(directory, error => errors.push(error))];
  if (errors.length) throw new Error('license_collection_incomplete');
  return attachments.map(attachment => {
    const original = fs.readFileSync(check(attachment.filePath));
    const bytes = Buffer.from(attachment.text.content, 'base64');
    if (!bytes.equals(original)) throw new Error('license_attachment_mismatch');
    return { file: attachment.file, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') };
  });
}
