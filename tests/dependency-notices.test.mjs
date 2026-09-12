import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Source-preview direct dependencies only. This is not a bundled-artifact SBOM.
const notices = {
  '@mozilla/readability': ['LICENSE.md', 'readability/LICENSE'],
  'cron-parser': ['LICENSE', 'cron-parser/LICENSE'],
  'fast-xml-parser': ['LICENSE', 'fast-xml-parser/LICENSE'],
  jsdom: ['LICENSE.txt', 'jsdom/LICENSE'],
  jsonwebtoken: ['LICENSE', 'jsonwebtoken/LICENSE'],
  luxon: ['LICENSE.md', 'luxon/LICENSE.md'],
  pg: ['LICENSE', 'pg/LICENSE'],
  'pg-boss': ['LICENSE', 'pg-boss/LICENSE'],
  react: ['LICENSE', 'react/LICENSE'],
  'react-dom': ['LICENSE', 'react-dom/LICENSE'],
  'react-markdown': ['license', 'react-markdown/LICENSE'],
  'remark-gfm': ['license', 'remark-gfm/LICENSE'],
  'rss-parser': ['LICENSE', 'rss-parser/LICENSE'],
  zod: ['LICENSE', 'zod/LICENSE'],
};
test('every direct runtime dependency retains its exact installed license and pinned version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(notices).sort(), Object.keys(manifest.dependencies).sort(),
    'new direct dependencies require a notice mapping');
  for (const [name, [original, retained]] of Object.entries(notices)) {
    const root = new URL(`../node_modules/${name}/`, import.meta.url);
    const installed = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    assert.equal(installed.name, name);
    assert.equal(installed.version, manifest.dependencies[name], `${name}: installed version drift`);
    assert.deepEqual(await readFile(new URL(original, root)),
      await readFile(new URL(`../third_party/${retained}`, import.meta.url)), `${name}: original license drift`);
  }
});
