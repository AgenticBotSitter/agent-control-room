// Emit one candidate patch for local review; never publish or write target files.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const target = '/private/tmp/cr-public-refresh.3pzcHT/repo';
const manifest = JSON.parse(readFileSync('docs/research/public-refresh-build-closure.json', 'utf8'));
const held = new Set(['deploy/operator-config.mjs', 'src/web/v1/private-database-preflight.ts',
  'tests/helpers/web-foundation.ts', 'tests/vps-built-core-schema.test.mjs', 'tests/vps-built-handler.test.mjs', 'styles/control-room.css']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requested = process.argv[3];
if (requested !== undefined && requested !== 'support') throw new Error('Unknown preparation scope');
// An explicit support-only pass leaves the rejected native authority cohort held.
const cohorts = requested === 'support' ? ['support'] : ['ui', 'web', 'native', 'support'];
const reviewed = new Map(cohorts.flatMap(cohort => {
  const report = JSON.parse(readFileSync(`docs/research/public-refresh-${cohort}-content-review.json`, 'utf8'));
  return report.entries ?? report.files;
})
  .filter(entry => entry.fullContentRead === true).map(entry => [entry.path, entry.sha256]));
const candidates = manifest.entries.filter(entry => !held.has(entry.path) && reviewed.get(entry.path) === entry.sha256).map(entry => {
  if (!/^(src|private-app|scripts|tests|styles)\//.test(entry.path) && entry.path !== 'vite.vps.config.ts') return null;
  if (entry.path.split('/').includes('..')) throw new Error('Unsafe path');
  const source = readFileSync(entry.path, 'utf8');
  if (hash(source) !== entry.sha256) throw new Error(`Source changed: ${entry.path}`);
  const old = existsSync(`${target}/${entry.path}`) ? readFileSync(`${target}/${entry.path}`, 'utf8') : null;
  return old === source ? null : { path: entry.path, source, old };
}).filter(Boolean);
const offset = Number(process.argv[2]);
if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Expected offset');
const selected = candidates.slice(offset, offset + 1);
const lines = value => value.replace(/\n$/, '').split('\n');
let patch = '*** Begin Patch\n';
for (const entry of selected) {
  if (entry.old === null) patch += `*** Add File: ${target}/${entry.path}\n`;
  else {
    const result = spawnSync('diff', ['-u', `${target}/${entry.path}`, entry.path], {encoding:'utf8',maxBuffer:4*1024*1024});
    if (result.status !== 1) throw new Error('Expected source difference');
    patch += `*** Update File: ${target}/${entry.path}\n` + result.stdout.split('\n').slice(2).join('\n').replace(/^@@.*@@.*$/gm,'@@');
    continue;
  }
  patch += lines(entry.source).map(line => '+' + line).join('\n') + '\n';
}
patch += '*** End Patch';
console.log(JSON.stringify({ total: candidates.length, selected: selected.map(e => e.path), patch }));
