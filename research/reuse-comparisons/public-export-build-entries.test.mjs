import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicExportBuildEntries } from '../../scripts/research/public-export-imports.mjs';

test('actual build config includes non-imported executable entries', () => {
  const entries = publicExportBuildEntries('vite.vps.config.ts', readFileSync('vite.vps.config.ts', 'utf8'));
  assert.equal(entries.length, 15);
  for (const file of ['private-idea-authoring-startup', 'private-owner-bootstrap', 'private-owner-review', 'private-task-database-check'])
    assert.ok(entries.includes(`src/web/v1/${file}.ts`));
  assert.ok(entries.includes('src/node-bridge/private-node-entry.ts'));
});
test('config inspection does not execute code and rejects computed entries', () => {
  assert.deepEqual(publicExportBuildEntries('x.ts', 'throw new Error("must not execute"); const config = { input: { x: "src/x.ts" } };'), ['src/x.ts']);
  for (const source of ['({input: makeInput()})', '({input: { x: process.env.X }})', '({input: { ...other }})', '({input: { x: "src/../secret.ts" }})', '({})'])
    assert.throws(() => publicExportBuildEntries('x.ts', source));
});
