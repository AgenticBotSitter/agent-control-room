import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runtimeLicenseReport } from './runtime-license-report.mjs';
import { collectLicenseEvidence } from './license-evidence.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Current-platform root-text assembly. Not a bundle/vendor/asset clearance. */
export function assembleRuntimeLicenses(repository = process.cwd()) {
  const read = relative => fs.readFileSync(path.join(repository, relative));
  const json = relative => JSON.parse(read(relative));
  const report = runtimeLicenseReport(json('research/runtime-license-input.json'), repository);
  assert.deepEqual(report, json('research/runtime-license-report.json'), 'license report changed; review before assembly');
  const readme = json('research/runtime-license-exceptions.json').entries;
  const entries = report.results.map(record => {
    let directory = path.join(repository, record.path), root = path.join(repository, 'node_modules');
    let provenance = 'installed_root_text', qualification = null, expected;
    if (record.status === 'missing_root_text') {
      const exception = readme.find(value => value.name === record.name && value.version === record.version);
      if (exception) {
        assert.equal(record.manifestSha256, exception.manifestSha256);
        const source = fs.readFileSync(path.join(directory, exception.sourceFile)), text = read(exception.textFile);
        assert.equal(hash(source), exception.sourceSha256); assert.equal(hash(text), exception.textSha256);
        assert.ok(source.includes(text));
        directory = path.dirname(path.join(repository, exception.textFile)); expected = exception.textSha256;
        provenance = 'installed_README_section';
      } else if (record.name === 'saxes' && record.version === '6.0.0') {
        const { private: unpublished, ...upstream } = json('third_party/saxes/upstream-package.json');
        assert.equal(unpublished, true); assert.deepEqual(upstream, json(`${record.path}/package.json`));
        directory = path.join(repository, 'third_party/saxes');
        expected = '0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e';
        provenance = 'pinned_upstream_release'; qualification = 'manifest correspondence; whole-source correspondence not proven';
      } else if (record.name === '@nodable/entities' && record.version === '3.0.0') {
        const evidence = json('third_party/nodable-entities/PROVENANCE.json');
        assert.equal(evidence.sourceManifestVersion, '2.2.0'); assert.equal(evidence.installedVersion, '3.0.0');
        const files = evidence.files.filter(file => file.localMatch === true); assert.equal(files.length, 8);
        for (const file of files) {
          assert.ok(file.path.startsWith('Entity/') && !file.path.includes('..'));
          const bytes = fs.readFileSync(path.join(directory, file.path.slice(7)));
          assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
        }
        directory = path.join(repository, 'third_party/nodable-entities');
        expected = '750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40';
        provenance = 'pinned_upstream_matching_code'; qualification = 'source manifest 2.2.0 differs from installed 3.0.0; not resolved';
      } else throw new Error('license_exception_missing');
      root = path.join(repository, 'third_party');
    }
    const attachments = collectLicenseEvidence(directory, root);
    assert.ok(attachments.length, 'license text missing');
    if (expected) { assert.equal(attachments.length, 1); assert.equal(attachments[0].sha256, expected); }
    else assert.deepEqual(attachments.map(({ base64, ...metadata }) => metadata), record.attachments);
    return { name: record.name, version: record.version, path: record.path, provenance, qualification, attachments };
  });
  return { schema: 'control-room.runtime-license-assembly/v1', scope: report.scope,
    completeDistributionClearance: false, rawMissingRootTexts: report.missing,
    manifestSha256: report.manifestSha256, lockSha256: report.lockSha256, entries };
}
