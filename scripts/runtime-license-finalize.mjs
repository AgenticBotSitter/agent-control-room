// Render the release-consumable notice index and manifest from the captured
// artifact inventory. No network, install, or caller-selected roots.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInsideRepository } from './runtime-license-repository-guard.mjs';

const INVENTORY = 'research/runtime-license-artifact-inventory.json';
const SCAN = 'research/runtime-license-bundled-scan.json';
const NOTICE = 'THIRD_PARTY.md';
const MANIFEST = 'research/runtime-license-manifest.json';

export function finalizedRuntimeLicenseOutputs(repository = process.cwd()) {
  assertInsideRepository(repository, INVENTORY, SCAN, NOTICE, MANIFEST);
  const read = file => JSON.parse(fs.readFileSync(path.join(repository, file), 'utf8'));
  const inventory = read(INVENTORY), scan = read(SCAN);
  if (!inventory.completeDistributionClearance || scan.inventoryDigest !== inventory.inventoryDigest
    || scan.summary.undisclosed !== 0) throw new Error('runtime_license_finalization_incomplete');
  const manifest = {
    schema: 'control-room.runtime-license-manifest/v1',
    inventoryDigest: inventory.inventoryDigest,
    completeDistributionClearance: true,
    scope: inventory.scope,
    installed: inventory.installed.rows,
    bundled: inventory.bundled.rows,
    bundledScan: { summary: scan.summary, reviewedExclusions: scan.reviewedExclusions },
  };
  const lines = [
    '# Third-party notices and distribution manifest', '',
    `Inventory digest: \`${inventory.inventoryDigest}\``, '',
    'This notice index is generated from the exact declared artifact inputs. It binds retained notice files and their SHA-256 hashes; the release assembler independently verifies the final archive against this digest.', '',
    '## Installed packages', '',
  ];
  for (const row of inventory.installed.rows) {
    const attachments = row.attachments.length
      ? row.attachments.map(a => `\`${a.file}\` (${a.sha256})`).join(', ')
      : 'retained upstream binding recorded in the manifest';
    lines.push(`- \`${row.name}@${row.version}\` — ${row.provenance}; ${attachments}`);
  }
  lines.push('', '## Retained and vendored material', '');
  for (const row of inventory.bundled.rows) {
    const source = row.provenance.sourceCommit ?? row.provenance.source ?? 'reviewed retained exclusion';
    lines.push(`- \`${row.root}\` — ${source}; ${row.provenance.qualification ?? 'reviewed exclusion'}; ${row.evidenceFiles.map(f => `\`${f.file}\` (${f.sha256})`).join(', ')}`);
  }
  if (scan.reviewedExclusions.length) {
    lines.push('', '## Reviewed local adaptations', '');
    for (const item of scan.reviewedExclusions) lines.push(`- \`${item.path}\` — ${item.evidenceRow.reason}; ${item.sha256}`);
  }
  return { manifest, notice: lines.join('\n') + '\n' };
}

export function writeFinalizedRuntimeLicenseOutputs(repository = process.cwd()) {
  const out = finalizedRuntimeLicenseOutputs(repository);
  fs.writeFileSync(path.join(repository, MANIFEST), JSON.stringify(out.manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(repository, NOTICE), out.notice);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = writeFinalizedRuntimeLicenseOutputs();
  process.stdout.write(`${NOTICE} ${MANIFEST} digest=${out.manifest.inventoryDigest}\n`);
}
