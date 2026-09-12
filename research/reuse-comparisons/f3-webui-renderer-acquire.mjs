import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=await fs.mkdtemp('/private/tmp/cr-f3-webui-renderer.');
const pin='e168b67e4278df618d1cab61fdb3a8dc55b29a81',out='docs/research/reuse-comparisons/f3-webui-renderer-acquisitions.json';
const receipt={root,pin,files:[],bytes:0,status:'acquiring'};const save=()=>fs.writeFile(out,JSON.stringify(receipt,null,2));await save();
const paths=['static/ui.js','static/messages.js','static/vendor/smd.min.js','LICENSE','static/index.html'];
for(const p of paths){const url=`https://raw.githubusercontent.com/nesquena/hermes-webui/${pin}/${p}`;const r=await fetch(url,{signal:AbortSignal.timeout(15000)}),chunks=[];let n=0;for await(const b of r.body){n+=b.length;receipt.bytes+=b.length;if(receipt.bytes>10*1024*1024)throw Error('response cap');chunks.push(b);}const b=Buffer.concat(chunks);receipt.files.push({path:p,url,status:r.status,bytes:n,sha256:createHash('sha256').update(b).digest('hex')});if(r.ok)await fs.writeFile(root+'/'+p.split('/').at(-1),b);await save();}
receipt.status='source acquired';await save();console.log(JSON.stringify(receipt));
