import {mkdtemp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=await mkdtemp('/private/tmp/cr-f7-miniflux-extractor.');
const pin='a84533db6ca0a2ff9a47800fbf0326be6d9b3170',files=[];let total=0;
for(const file of ['LICENSE','go.mod','internal/reader/readability/readability.go','internal/reader/readability/readability_test.go','internal/reader/readability/testdata','internal/reader/scraper/scraper.go']){
 const url=`https://raw.githubusercontent.com/miniflux/v2/${pin}/${file}`,r=await fetch(url,{signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error(`${file}:${r.status}`);const b=Buffer.from(await r.arrayBuffer());total+=b.length;if(total>500000)throw Error('cap');
 const local=file.replaceAll('/','--');await writeFile(`${root}/${local}`,b,{flag:'wx'});files.push({file,local,url,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
}
const receipt={root,pin,total,files};await writeFile(`${root}/receipt.json`,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
