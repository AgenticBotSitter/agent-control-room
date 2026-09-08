// Bounded public-source acquisition only; never execute downloaded code here.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = await mkdtemp('/private/tmp/cr-f7-candidates.');
const candidates = [
  ['miniflux/v2','a84533db6ca0a2ff9a47800fbf0326be6d9b3170', ['LICENSE','go.mod','internal/api/entry_handlers.go','internal/reader/scraper/scraper.go','internal/reader/scraper/scraper_test.go','internal/reader/sanitizer/sanitizer.go']],
  ['FreshRSS/FreshRSS','65e402ca412dd2683ed3b36ac673cb7cdf5de43e',['LICENSE.txt','composer.json','p/api/greader.php','app/Models/Feed.php']],
  ['DIYgod/RSSHub','865f1cf5af3973dffaa2cb8c2d73ee0538043c12',['LICENSE','package.json','lib/routes/github/issue.ts','lib/utils/rss-parser.ts','lib/utils/rss-parser.test.ts','lib/middleware/cache.ts','lib/middleware/cache.test.ts']],
];
const receipt={root,scope:'read-only source, no installation or execution', files:[], totalBytes:0};
console.log(JSON.stringify({root}));
try {
  for(const [repo,pin,paths] of candidates) for(const path of paths){
    const url=`https://raw.githubusercontent.com/${repo}/${pin}/${path}`;
    const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(`${url}: ${response.status}`);
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>400_000||receipt.totalBytes+bytes>3_000_000)throw Error('source acquisition cap');chunks.push(chunk);}
    const content=Buffer.concat(chunks), name=`${repo.split('/')[0]}--${path.replaceAll('/','--')}`;
    await writeFile(join(root,name),content,{flag:'wx'});
    receipt.files.push({repo,pin,path,url,name,bytes,sha256:createHash('sha256').update(content).digest('hex')});receipt.totalBytes+=bytes;
  }
} finally {await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(receipt));}
