// Research only: actual decoder with only its parser import substituted.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {verify,entitiesRoot} from './f7-parser-decision-pins.mjs';
const verifiedPins=verify(); // Explicit identity refusal BEFORE candidate/borrowed imports.
const {XMLParser,XMLValidator,XMLBuilder}=await import('fast-xml-parser');
const {decodeAbsFeed}=await import('../../src/project-adapters/abs-news/v1/feed-decoder');
const {parseFeed}=await import('../../src/vendor/control-center/sitemap');
const {createIndustrySourceReader}=await import('../../src/vendor/control-center/source-reader');

// Minimal competing adapter; deliberately not claimed a full rss-parser clone.
const arr=(v:any):any[]=>v===undefined?[]:Array.isArray(v)?v:[v];
const txt=(v:any):string|undefined=>typeof v==='string'?v:typeof v?.['#text']==='string'?v['#text']:undefined;
let compatibilityMode=false;
// Standalone exact installed package path: candidate does not resolve via incumbent.
const {decodeHTML}=createRequire(import.meta.url)(entitiesRoot);
class FastCompatibilityParser {
 async parseString(xml:string){
  if(XMLValidator.validate(xml)!==true)throw Error('invalid XML');
  const p=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',removeNSPrefix:true,parseTagValue:false}).parse(xml);
  const atom=!!p.feed,channel=p.rss?.channel??p.RDF?.channel;
  if(!atom&&!channel)throw Error('unsupported feed');
  const raw=arr(atom?p.feed.entry:p.rss?.channel?.item??p.RDF?.item);
  return {items:raw.map((i:any)=>{
    const links=arr(i.link);const selected=links.find((v:any)=>v?.['@_rel']==='alternate')??links[0];
    const link=atom?selected?.['@_href']:txt(selected);
    const rawContent=atom?i.content:i.description;
    const content=txt(rawContent)??(compatibilityMode&&rawContent&&typeof rawContent==='object'?new XMLBuilder({ignoreAttributes:false,attributeNamePrefix:'@_'}).build({div:rawContent}):undefined);
    const date=txt(atom?i.published??i.updated:i.pubDate??i.date);
    // Date errors are surfaced by the actual downstream policy; do not drop them.
    if(compatibilityMode&&atom&&date!==undefined&&!Number.isFinite(Date.parse(date)))throw Error('invalid Atom date');
    const isoDate=date===undefined?undefined:Number.isFinite(Date.parse(date))?new Date(date).toISOString():compatibilityMode?undefined:date;
    // Compatibility strip algorithm adapted from MIT rss-parser/lib/utils.js;
    // keep its attribution if this experiment ever becomes shipping code.
    const contentSnippet=content===undefined?undefined:compatibilityMode?decodeHTML(content.replace(/([^\n])<\/?(h|br|p|ul|ol|li|blockquote|section|table|tr|div)(?:.|\n)*?>([^\n])/gm,'$1\n$3').replace(/<(?:.|\n)*?>/gm,'')).trim():content.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim();
    return {title:txt(i.title),link,...(contentSnippet===undefined?{}:{contentSnippet}),...(isoDate===undefined?{}:{isoDate})};
  })};
 }
}
const file=path.resolve('src/project-adapters/abs-news/v1/feed-decoder.ts'),source=readFileSync(file,'utf8');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const require=createRequire(file),module={exports:{} as any};let replaced=0;
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
// Same JS realm preserves the application's exact plain-object digest contract.
vm.runInThisContext(`(function(module,exports,require){${code}\n})`)(module,module.exports,(name:string)=>{if(name==='rss-parser'){replaced++;return FastCompatibilityParser;}return require(name);});
assert.equal(replaced,1);
const adapted=module.exports.decodeAbsFeed;
const observedAt='2026-09-08T12:00:00.000Z',base='https://example.org/feed';
const input={tenantId:'tenant:rc7',workspaceId:'workspace:rc7',projectId:'project:rc7',source:{sourceId:'source:rc7',sourceLabel:'RC7',sourceKind:'rss',endpointUrl:base},observedAt,maxBytes:100000,maxItems:100};
const item=(body:string)=>`<item>${body}</item>`;
const regular='<title>AI launch</title><link>https://example.org/launch</link><description>Evidence</description><pubDate>Tue, 08 Sep 2026 10:00:00 GMT</pubDate>';
const rss=(body:string)=>`<rss version="2.0"><channel><title>RC7</title>${body}</channel></rss>`;
const atom=(body:string)=>`<feed xmlns="http://www.w3.org/2005/Atom"><title>RC7</title><entry><title>AI launch</title><link href="https://example.org/launch"/><updated>2026-09-08T10:00:00Z</updated>${body}</entry></feed>`;
const fixtures=[
 ['rss',rss(item(regular))],['atom content',atom('<content>Evidence</content>')],['atom summary only',atom('<summary>Evidence</summary>')],
 ['rdf namespaced date',`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>RC7</title></channel>${item(regular.replace(/<pubDate>.*?<\/pubDate>/,'<dc:date>2026-09-08T10:00:00Z</dc:date>'))}</rdf:RDF>`],
 ['missing title',rss(item(regular.replace('<title>AI launch</title>','')))],['relative URL',rss(item(regular.replace('https://example.org/launch','/launch')))],
 ['canonical query',rss(item(regular.replace('/launch','/launch?utm_source=fixture')))],['duplicate URL',rss(item(regular)+item(regular))],
 ['undated',rss(item(regular.replace(/<pubDate>.*?<\/pubDate>/,'')))],['future date',rss(item(regular.replace('2026 10:00','2099 10:00')))],
 ['malformed',rss(item(regular)).replace('</title>','</bad>')],['DTD',`<!DOCTYPE rss [<!ENTITY a "test">]>${rss(item(regular))}`],
 ['NUL',rss(item(regular+'\u0000'))],['101 item limit',rss(item(regular).repeat(101))],
 ['HTML entities',rss(item(regular.replace('Evidence','<![CDATA[<p>A</p><p>B &copy; &#169;</p>]]>')))],
 ['Atom XHTML',atom('<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Evidence</p></div></content>')],
 ['bad RSS date',rss(item(regular.replace('Tue, 08 Sep 2026 10:00:00 GMT','not-a-date')))],
 ['bad Atom date',atom('<content>Evidence</content>').replace('2026-09-08T10:00:00Z','not-a-date')],
] as const;
async function outcome(fn:any,xml:string){try{return {ok:true,value:await fn({...input,xml})};}catch(e:any){return {ok:false,code:e.code??e.message};}}
const comparisons=[];
for(const [name,xml] of fixtures){compatibilityMode=false;const original=await outcome(decodeAbsFeed,xml),candidate=await outcome(adapted,xml);compatibilityMode=true;const corrected=await outcome(adapted,xml);const parity=JSON.stringify(original)===JSON.stringify(candidate),adaptedParity=JSON.stringify(original)===JSON.stringify(corrected);comparisons.push({name,parity,adaptedParity,originalDigest:hash(JSON.stringify(original)),candidateDigest:hash(JSON.stringify(candidate)),adaptedDigest:hash(JSON.stringify(corrected)),originalState:original.ok?'success':original.code,candidateState:candidate.ok?'success':candidate.code,...(!parity?{original,candidate,corrected}:{})});}
const dated=Array.from({length:260},(_,i)=>item(regular.replace('/launch',`/item-${i}`).replace('Tue, 08 Sep 2026 10:00:00 GMT',new Date(Date.parse(observedAt)-i*60000).toUTCString()))).reverse().join('');
const capped=parseFeed(rss(dated),'RC7',base);assert.equal(capped.length,250);assert.equal(capped[0].url,'https://example.org/item-0');assert.equal(capped[249].url,'https://example.org/item-249');
// Real borrowed reader: feed-kind/quiet baseline/replay remain intact, no fetch.
let body=rss(item(regular.replace(/<pubDate>.*?<\/pubDate>/,'')));let calls=0;
const reader=createIndustrySourceReader({now:()=>Date.parse(observedAt),async readText(url){calls++;return{text:body,finalUrl:url};}});
const configured={id:'fixture',name:'RC7',url:base};
const first=await reader.readSource(configured as any);assert.equal(first.status.state,'baseline');assert.equal(first.items.length,0);
const repeat=await reader.readSource(configured as any,first.snapshot);assert.equal(repeat.items.length,0);
body=rss(item(regular.replace(/<pubDate>.*?<\/pubDate>/,'').replace('/launch','/second')));
const next=await reader.readSource(configured as any,repeat.snapshot);assert.equal(next.items.length,1);assert.equal(next.items[0].url,'https://example.org/second');assert.equal(next.feedKind,'rss');assert.equal(calls,3);
assert.equal(comparisons.filter(c=>c.parity).length,14);
assert.deepEqual(comparisons.filter(c=>!c.parity).map(c=>c.name),['HTML entities','Atom XHTML','bad RSS date','bad Atom date']);
assert.equal(comparisons.filter(c=>c.adaptedParity).length,18);
console.log(JSON.stringify({scope:'actual full decoder import substitution plus actual borrowed parser/reader; supplied synthetic XML and readText only, no network/DB',verifiedPins,entitiesResolution:'explicit node_modules/.pnpm/entities@2.2.0/node_modules/entities; not via rss-parser',sourceSha256:hash(source),substitutedImports:replaced,comparisons,summary:{fixtures:comparisons.length,parity:comparisons.filter(c=>c.parity).length,adaptedParity:comparisons.filter(c=>c.adaptedParity).length,mismatches:comparisons.filter(c=>!c.parity).map(c=>c.name),remainingMismatches:comparisons.filter(c=>!c.adaptedParity).map(c=>c.name),borrowedCapSort:true,borrowedUndatedBaselineReplay:true,syntheticReadCalls:calls}},null,2));
