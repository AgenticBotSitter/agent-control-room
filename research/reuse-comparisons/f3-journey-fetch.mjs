import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
const root=fs.mkdtempSync('/private/tmp/cr-f3-journey.');const files=[];
for(const name of ['MessageRow.tsx','MessageRow.test.tsx','mediaUtils.ts']){
const url='https://raw.githubusercontent.com/fathah/hermes-desktop/3f744975f818bbb40ed029e6b3022cd0c5ad7a24/src/renderer/src/screens/Chat/'+name;
const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('source unavailable');let chunks=[],size=0;for await(const c of r.body){size+=c.length;if(size>150000)throw Error('source cap');chunks.push(c);}const b=Buffer.concat(chunks);fs.writeFileSync(path.join(root,name),b);files.push({name,url,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}
fs.writeFileSync('docs/research/reuse-comparisons/f3-journey-acquisitions.json',JSON.stringify({root,freeBytes:fs.statfsSync(root).bavail*fs.statfsSync(root).bsize,files},null,2));console.log(root);
