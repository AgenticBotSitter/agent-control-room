import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Render reviewed assembly as plain text, preserving original attachment bytes. */
export function renderRuntimeLicenseText(assembly) {
  assert.equal(assembly.schema, 'control-room.runtime-license-assembly/v1');
  assert.equal(assembly.completeDistributionClearance, false);
  assert.ok(Array.isArray(assembly.entries) && assembly.entries.length > 0);
  const chunks = [Buffer.from('Control Room runtime third-party notices\n\n'
    + 'Scope: installed runtime package root texts and reviewed exceptions only.\n'
    + 'This is NOT complete distribution clearance; bundled code and assets require separate review.\n\n')];
  for (const entry of assembly.entries) {
    assert.ok(Array.isArray(entry.attachments) && entry.attachments.length > 0);
    chunks.push(Buffer.from(`Package: ${entry.name}@${entry.version}\nProvenance: ${entry.provenance}\n`
      + `Qualification: ${entry.qualification ?? 'none recorded'}\n`));
    for (const attachment of entry.attachments) {
      const bytes = Buffer.from(attachment.base64, 'base64');
      assert.equal(bytes.toString('base64'), attachment.base64, 'noncanonical attachment');
      assert.equal(bytes.length, attachment.bytes, 'attachment length changed');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), attachment.sha256, 'attachment hash changed');
      chunks.push(Buffer.from(`\n--- Original ${attachment.file} (${attachment.bytes} bytes) ---\n`));
      chunks.push(bytes);
      chunks.push(Buffer.from('\n--- End original attachment ---\n\n'));
    }
  }
  return Buffer.concat(chunks);
}
