// Actual currently installed parsers and adopted upstream parser; no network or database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeAbsFeed} from '../../src/project-adapters/abs-news/v1/feed-decoder.ts';
import {parseFeed} from '../../src/vendor/control-center/sitemap.ts';
const base='https://example.org/feed';
const input={tenantId:'tenant:f7',workspaceId:'workspace:f7',projectId:'project:f7',
  source:{sourceId:'source:f7',sourceLabel:'F7',sourceKind:'rss',endpointUrl:base},
  observedAt:'2026-09-08T12:00:00.000Z',maxBytes:100000,maxItems:100};
const item=(title,link)=>`<item>${title===null?'':`<title>${title}</title>`}<link>${link}</link><description>Evidence</description><pubDate>Tue, 08 Sep 2026 10:00:00 GMT</pubDate></item>`;
const rss=items=>`<rss version="2.0"><channel><title>F7</title><link>https://example.org</link><description>News</description>${items}</channel></rss>`;
test('regular RSS fields align across direct rss-parser decoder and borrowed fast-xml parser',async()=>{
  const xml=rss(item('Model launch','https://example.org/model'));
  const direct=await decodeAbsFeed({...input,xml});const borrowed=parseFeed(xml,'F7',base);
  assert.equal(direct.stories.length,1);assert.equal(borrowed.length,1);
  const d=direct.stories[0],b=borrowed[0];
  assert.deepEqual([d.title,d.summary,d.canonicalUrl,d.publishedAt],[b.title,b.summary,b.url,new Date(b.publishedAt).toISOString()]);
  assert.equal(d.verificationState,'review_only');
});
test('missing titles and relative URLs are not equivalent policies: consolidation needs explicit adapter rules',async()=>{
  const xml=rss(item(null,'https://example.org/untitled')+item('Relative item','/relative'));
  const direct=await decodeAbsFeed({...input,xml});const borrowed=parseFeed(xml,'F7',base);
  assert.equal(direct.stories.length,0);assert.equal(direct.rejectedCount,2);
  assert.equal(borrowed.length,2);assert.equal(borrowed[0].title,'Untitled update');
  assert.equal(borrowed[1].url,'https://example.org/relative');
});
test('direct adapter rejects 101 items above its configured 100 limit while borrowed parser accepts all 101',async()=>{
  const xml=rss(Array.from({length:101},(_,i)=>item(`Story ${i}`,`https://example.org/${i}`)).join(''));
  await assert.rejects(decodeAbsFeed({...input,xml}),error=>error.code==='feed_limit_exceeded');
  assert.equal(parseFeed(xml,'F7',base).length,101);
});
