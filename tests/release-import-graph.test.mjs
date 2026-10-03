import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertReleaseImportGraphV1, requiredReleaseFilesV1 } from './support/release-import-graph.mjs';

test('R2S-09: release closure follows static, re-export, lazy-loader and worker imports through cycles', async t => {
  const root = await mkdtemp('/private/tmp/release-graph-'); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), shipped = join(root, 'shipped'); await mkdir(source); await mkdir(shipped);
  const files = {
    'entry.mjs': `import 'node:fs'; import './shared.mjs'; export {value} from './exported.mjs';
      const base=new URL('./',import.meta.url); const load=path=>import(path); load(new URL('lazy.mjs',base).href);
      new Worker(new URL('./worker.mjs',import.meta.url)); import('./dynamic.mjs');`,
    'shared.mjs': `import './entry.mjs'; export const value=1;`,
    'exported.mjs': 'export const value=1;', 'lazy.mjs': 'export const value=1;',
    'worker.mjs': `import './worker-shared.mjs';`, 'worker-shared.mjs': '', 'dynamic.mjs': '',
  };
  for (const [name, text] of Object.entries(files)) { await writeFile(join(source, name), text); await writeFile(join(shipped, name), text); }
  assert.deepEqual(await requiredReleaseFilesV1(source, ['entry.mjs']), Object.keys(files).sort());
  for (const [name, text] of Object.entries(files)) {
    await rm(join(shipped, name));
    await assert.rejects(assertReleaseImportGraphV1(source, shipped, ['entry.mjs']), error => error.message === `release dependency missing: ${name}`);
    await writeFile(join(shipped, name), text);
  }
  await assertReleaseImportGraphV1(source, shipped, ['entry.mjs']);
});

test('R2S-09: imports outside the release and unresolved runtime packages fail the closure proof', async t => {
  const root = await mkdtemp('/private/tmp/release-graph-bad-'); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source);
  for (const text of [`import '../outside.mjs';`, `import 'unshipped-package';`]) {
    await writeFile(join(source, 'entry.mjs'), text);
    await assert.rejects(requiredReleaseFilesV1(source, ['entry.mjs']), /release import/);
  }
});
