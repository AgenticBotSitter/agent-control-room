import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
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
