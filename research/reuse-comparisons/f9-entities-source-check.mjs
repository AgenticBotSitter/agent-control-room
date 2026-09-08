// Read public exact-version source; compare installed package bytes. No execution/install.
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const pin='d2070d76a8ba07e6c7fa142caeb51ffd756e47eb';
const base=`https://raw.githubusercontent.com/nodable/val-parsers/${pin}/`;
const local='node_modules/.pnpm/@nodable+entities@3.0.0/node_modules/@nodable/entities';
const root=await mkdtemp('/private/tmp/cr-f9-entities.');
const receipt={root,pin,registry:'https://registry.npmjs.org/@nodable%2fentities/3.0.0',files:[],bytes:0};
console.log(JSON.stringify({root}));
const paths=['LICENSE','Entity/package.json','Entity/README.md','Entity/src/EntityDecoder.js','Entity/src/EntityEncoder.js','Entity/src/all-entities.js','Entity/src/entities.js','Entity/src/entityTries.js','Entity/src/index.d.ts','Entity/src/index.js'];
try{
  for(const path of paths){
    const r=await fetch(base+path,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`${path}:${r.status}`);
    const content=Buffer.from(await r.arrayBuffer());receipt.bytes+=content.length;
    if(content.length>150000||receipt.bytes>300000)throw Error('source cap');
    const hash=createHash('sha256').update(content).digest('hex');
    let localMatch=null;
    if(path.startsWith('Entity/'))localMatch=content.equals(await readFile(join(local,path.slice(7))));
    await writeFile(join(root,path.replaceAll('/','--')),content,{flag:'wx'});
    receipt.files.push({path,url:base+path,bytes:content.length,sha256:hash,localMatch});
  }
}finally{await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(receipt));}
