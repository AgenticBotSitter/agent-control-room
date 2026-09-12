import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=await fs.mkdtemp('/private/tmp/cr-f8-kuma-daemon.');
const pin='e4821321e559c887b14e37d9979e604b221a8945';
const receipt={root,pin,status:'fetching',files:[]};
const save=()=>fs.writeFile('docs/research/reuse-comparisons/f8-kuma-daemon-acquisitions.json',JSON.stringify(receipt,null,2));await save();
try{for(const file of ['package.json','package-lock.json','LICENSE','server/server.js','server/database.js','server/uptime-kuma-server.js','server/check-version.js','server/config.js','server/notification.js']){
 const url=`https://raw.githubusercontent.com/louislam/uptime-kuma/${pin}/${file}`,r=await fetch(url,{signal:AbortSignal.timeout(15000)});
 let bytes=0;const chunks=[];for await(const b of r.body){bytes+=b.length;if(bytes>2*1024*1024)throw Error('source_size');chunks.push(b);}const buffer=Buffer.concat(chunks);
 receipt.files.push({file,url,status:r.status,bytes,sha256:createHash('sha256').update(buffer).digest('hex')});
 if(r.ok){await fs.mkdir(path.dirname(root+'/'+file),{recursive:true});await fs.writeFile(root+'/'+file,buffer);}await save();
}receipt.status='source_only';await save();console.log(JSON.stringify({root,files:receipt.files.map(x=>({file:x.file,status:x.status,bytes:x.bytes}))}));}catch(e){receipt.status='failed';receipt.error=e.message;await save();throw e;}
