import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
test('saxes pinned release manifest matches installed packaging and retains complete notice', () => {
  const installed = fs.readFileSync('node_modules/.pnpm/saxes@6.0.0/node_modules/saxes/package.json');
  assert.equal(hash(installed), '32052572b41c2a890ed0854798c48454cc5991dcaafe5fb1718a4253046acfd3');
  const { private: unpublished, ...upstream } = JSON.parse(fs.readFileSync('third_party/saxes/upstream-package.json', 'utf8'));
  assert.equal(unpublished, true);
  assert.deepEqual(upstream, JSON.parse(installed));
  const notice = fs.readFileSync('third_party/saxes/LICENSE');
  assert.equal(notice.length, 3011);
  assert.equal(hash(notice), '0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e');
});
test('named README exceptions retain exact current source and original license bytes', () => {
  const input = JSON.parse(fs.readFileSync('research/runtime-license-input.json', 'utf8'));
  const exceptions = JSON.parse(fs.readFileSync('research/runtime-license-exceptions.json', 'utf8'));
  for (const entry of exceptions.entries) {
    const record = input.records.find(value => value.name === entry.name);
    assert.ok(record); assert.deepEqual(record.versions, [entry.version]);
    for (const directory of record.paths) {
      const manifest = fs.readFileSync(path.join(directory, 'package.json'));
      const source = fs.readFileSync(path.join(directory, entry.sourceFile));
      const text = fs.readFileSync(entry.textFile);
      assert.equal(hash(manifest), entry.manifestSha256);
      assert.equal(hash(source), entry.sourceSha256);
      assert.equal(hash(text), entry.textSha256);
      assert.ok(source.includes(text), 'retained text must exist verbatim in current installed README');
    }
  }
});
