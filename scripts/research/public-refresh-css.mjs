// Prepare a narrowly sanitized CSS patch; no files written or app code executed.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('vite'));
const postcss = viteRequire('postcss');
const file = 'styles/control-room.css';
const target = '/private/tmp/cr-public-refresh.3pzcHT/repo/' + file;
const source = readFileSync(file, 'utf8');
const review = JSON.parse(readFileSync('docs/research/public-refresh-support-content-review.json', 'utf8')).entries.find(e=>e.path===file);
assert.equal(createHash('sha256').update(source).digest('hex'), review.sha256);
assert.equal(review.fullContentRead, true);
const manifest = JSON.parse(readFileSync('docs/research/public-refresh-build-closure.json', 'utf8'));
for (const entry of manifest.entries.filter(e=>e.path!==file && !e.path.startsWith('tests/')))
  assert.ok(!/wayfarer/i.test(readFileSync(entry.path,'utf8')), `Consumer reference outside CSS: ${entry.path}`);
const ast = postcss.parse(source);
const removed = [], mixed = [];
ast.walkRules(rule => {
  const selectors = rule.selectors;
  const keep = selectors.filter(selector=>!selector.includes('.wayfarer-'));
  if (keep.length === selectors.length) return;
  removed.push(...selectors.filter(selector=>selector.includes('.wayfarer-')));
  if (!keep.length) rule.remove();
  else { mixed.push({before:selectors,after:keep}); rule.selectors=keep; }
});
ast.walkComments(comment=>{ if (/wayfarer/i.test(comment.text)) comment.remove(); });
const output = ast.toString();
assert.ok(!/wayfarer/i.test(output));
postcss.parse(output);
assert.ok(removed.length>0);
// Every remaining rule retains its declarations and ancestry. Only the named
// consumer selectors/comments may disappear; unrelated rules are not dropped.
const normalized = css => {const rows=[];postcss.parse(css).walkRules(rule=>{
  const selectors=rule.selectors.filter(s=>!s.includes('.wayfarer-'));
  if(selectors.length){const parents=[];let p=rule.parent;while(p&&p.type!=='root'){parents.push([p.name,p.params]);p=p.parent;}
    rows.push({selectors,parents,body:rule.nodes.map(n=>n.toString())});}
});return rows;};
assert.deepEqual(normalized(source), normalized(output));
const result=spawnSync('diff',['-u',target,'-'],{input:output,encoding:'utf8',maxBuffer:2*1024*1024});
assert.ok(result.status===0||result.status===1);
const patch=result.status===1?'*** Begin Patch\n*** Update File: '+target+'\n'+result.stdout.split('\n').slice(2).join('\n').replace(/^@@.*@@.*$/gm,'@@')+'*** End Patch':null;
console.log(JSON.stringify({sourceHash:review.sha256,outputHash:createHash('sha256').update(output).digest('hex'),removedSelectorCount:removed.length,mixed,retainedRulesVerified:true,patch}));
