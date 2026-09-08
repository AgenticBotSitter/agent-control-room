import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {verify,entitiesRoot} from './f7-parser-decision-pins.mjs';
const pins=verify();
const {XMLParser,XMLValidator,XMLBuilder}=await import('fast-xml-parser');
const {decodeAbsFeed}=await import('../../src/project-adapters/abs-news/v1/feed-decoder');
const {parseFeed}=await import('../../src/vendor/control-center/sitemap');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const priorPath=path.resolve('research/reuse-comparisons/f7-parser-decision-fit.ts'),prior=readFileSync(priorPath,'utf8');
assert.equal(hash(prior),'3a11a58aea39ff9cb76ba0a293e8200c763767c5b48f217f84cda56f87bed661');
const snippet=prior.slice(prior.indexOf('// Minimal competing adapter;'),prior.indexOf('const file=')).replaceAll('import.meta.url',JSON.stringify(pathToFileURL(priorPath).href));
assert.ok(snippet.includes('class FastCompatibilityParser'));
// Extract only the reviewed adapter declarations, not its top-level18case workload.
const adapterCode=ts.transpile(`${snippet}\ncompatibilityMode=true;return FastCompatibilityParser;`,{target:ts.ScriptTarget.ES2022});
const Candidate=vm.runInThisContext(`(function(createRequire,entitiesRoot,XMLParser,XMLValidator,XMLBuilder){${adapterCode}})`)(createRequire,entitiesRoot,XMLParser,XMLValidator,XMLBuilder);
const file=path.resolve('src/project-adapters/abs-news/v1/feed-decoder.ts'),source=readFileSync(file,'utf8'),req=createRequire(file);
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
function substituted(Parser:any){const module={exports:{} as any};let substitutions=0;vm.runInThisContext(`(function(module,exports,require){${code}\n})`)(module,module.exports,(name:string)=>name==='rss-parser'?(substitutions++,Parser):req(name));assert.equal(substitutions,1);return module.exports.decodeAbsFeed;}
const candidate=substituted(Candidate);
// Distinct alternative: translate actual borrowed parseFeed output, not its parser internals.
class BorrowedTranslation {async parseString(xml:string){return{items:parseFeed(xml,'Selection','https://example.org/feed').map(i=>({title:i.title,link:i.url,contentSnippet:i.summary,...(i.publishedAt?{isoDate:Number.isFinite(Date.parse(i.publishedAt))?new Date(i.publishedAt).toISOString():i.publishedAt}:{})}))};}}
const borrowed=substituted(BorrowedTranslation);
const input={tenantId:'tenant:rc7',workspaceId:'workspace:rc7',projectId:'project:rc7',source:{sourceId:'source:rc7',sourceLabel:'RC7',sourceKind:'rss',endpointUrl:'https://example.org/feed'},observedAt:'2026-09-08T12:00:00.000Z',maxBytes:100000,maxItems:100};
const rss=(item:string)=>`<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title><item>${item}</item></channel></rss>`;
const core='<title>AI news</title><link>https://example.org/item</link><description>Report</description>';
const atom=(entry:string)=>`<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><entry>${entry}</entry></feed>`;
const a='<title>AI news</title><link href="https://example.org/item"/><updated>2026-09-08T10:00:00Z</updated>';
const cases=[
 ['prefixed Atom',`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>Feed</atom:title><atom:entry><atom:title>News</atom:title><atom:link href="https://example.org/item"/></atom:entry></atom:feed>`],
 ['RSS mixed inline title',rss(core.replace('AI news','AI <b>news</b> today'))],
 ['RSS duplicate title',rss(core.replace('<title>AI news</title>','<title>First</title><title>Second</title>'))],
 ['RSS numeric leadingzero title',rss(core.replace('AI news','0012'))],
 ['RSS duplicate description',rss(core+'<description>Second</description>')],
 ['RSS content encoded only',rss(core.replace('<description>Report</description>','<content:encoded><![CDATA[<p>Full report</p>]]></content:encoded>'))],
 ['RSS invalidpubdate validDCdate',rss(core+'<pubDate>invalid</pubDate><dc:date>2026-09-08T10:00:00Z</dc:date>')],
 ['Atom alternate link selected',atom(a.replace('<link href="https://example.org/item"/>','<link rel="self" href="https://example.org/feed"/><link rel="alternate" href="https://example.org/item"/>')+'<content>Report</content>')],
 ['Atom empty published updated fallback',atom(a+'<published></published><content>Report</content>')],
 ['Atom summary only',atom(a+'<summary>Meaningful summary</summary>')],
 ['Atom XHTML mixedcontent',atom(a+'<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Before <b>bold</b> after</div></content>')],
 ['Atom duplicate content',atom(a+'<content>First</content><content>Second</content>')],
 ['RSS missing title',rss(core.replace('<title>AI news</title>',''))],
 ['RSS relative URL',rss(core.replace('https://example.org/item','/item'))],
 ['RSS long summary',rss(core.replace('Report','x'.repeat(600)))],
 ['RSS multiple links',rss(core+'<link>https://example.org/second</link>')],
 ['existing multibyte bytecap',rss(core.replace('AI news','你好')),10],
 ['existing exact itemcap',rss(core).replace('</item>','</item><item>'+core+'</item>'),undefined,1],
] as const;
async function outcome(fn:any,xml:string,maxBytes=100000,maxItems=100){try{return{ok:true,value:await fn({...input,xml,maxBytes,maxItems})};}catch(e:any){return{ok:false,code:e.code??e.message};}}
const results=[];
function compact(o:any){return{wholeOutputSha256:hash(JSON.stringify(o)),ok:o.ok,...(o.ok?{state:o.value.state,rejected:o.value.rejectedCount,duplicates:o.value.duplicateCount,stories:o.value.stories.map((s:any)=>({title:s.title,summary:s.summary,url:s.canonicalUrl,publishedAt:s.publishedAt,storyDigest:s.storyDigest}))}:{code:o.code})};}
for(const [name,xml,bytes,items] of cases){const incumbent=await outcome(decodeAbsFeed,xml,bytes,items),adapted=await outcome(candidate,xml,bytes,items),translated=await outcome(borrowed,xml,bytes,items);results.push({name,adapterParity:JSON.stringify(incumbent)===JSON.stringify(adapted),borrowedParity:JSON.stringify(incumbent)===JSON.stringify(translated),incumbent:compact(incumbent),adapted:compact(adapted),translated:compact(translated)});}
assert.equal(results.filter(r=>r.adapterParity).length,11);assert.equal(results.filter(r=>r.borrowedParity).length,4);
console.log(JSON.stringify({scope:'new18case full-decoder synthetic corpus; original18case workload not rerun; actual borrowed parseFeed plus explicit translation alternative',pins,adapterSha256:hash(prior),adapterDeclarationLines:snippet.split('\n').length,results,summary:{cases:results.length,adapterParity:results.filter(r=>r.adapterParity).length,borrowedParity:results.filter(r=>r.borrowedParity).length,adapterMismatches:results.filter(r=>!r.adapterParity).map(r=>r.name),borrowedMismatches:results.filter(r=>!r.borrowedParity).map(r=>r.name)}},null,2));
