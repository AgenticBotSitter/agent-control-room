import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=await fs.mkdtemp('/private/tmp/cr-f3-renderer.');
const pin='3f744975f818bbb40ed029e6b3022cd0c5ad7a24',receipt={root,pin,files:[],status:'fetching'};
const save=()=>fs.writeFile('docs/research/reuse-comparisons/f3-renderer-acquisitions.json',JSON.stringify(receipt,null,2));await save();
for(const p of ['src/renderer/src/components/AgentMarkdown.tsx','src/renderer/src/components/AgentMarkdown.test.tsx','package.json','package-lock.json','LICENSE']){
 const url=`https://raw.githubusercontent.com/fathah/hermes-desktop/${pin}/${p}`,r=await fetch(url,{signal:AbortSignal.timeout(15000)});let n=0,chunks=[];for await(const b of r.body){n+=b.length;if(n>1500000)throw Error('cap');chunks.push(b);}const b=Buffer.concat(chunks);receipt.files.push({path:p,url,status:r.status,bytes:n,sha256:createHash('sha256').update(b).digest('hex')});if(r.ok)await fs.writeFile(root+'/'+p.split('/').at(-1),b);await save();
}receipt.status='source_downloaded';await save();console.log(JSON.stringify({root,files:receipt.files.map(x=>({path:x.path,status:x.status,bytes:x.bytes}))}));
