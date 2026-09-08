import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=process.argv[2];
if(!/^\/private\/tmp\/control-room-f2router\.[A-Za-z0-9]+$/.test(root??''))throw Error('owned root required');
const pin='553df1c691fe8bf7747e50da22f1342984495ae0';
const rows=JSON.parse(await readFile(`${root}/receipt.json`,'utf8'));
for(const file of ['_version.py','retry.py']) {
  const url=`https://raw.githubusercontent.com/openai/codex/${pin}/sdk/python/src/openai_codex/${file}`;
  const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error(`fetch ${file}: ${r.status}`);
  const b=Buffer.from(await r.arrayBuffer());if(b.length>100000)throw Error('size limit');
  await writeFile(`${root}/openai_codex/${file}`,b);
  rows.push({file,url,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
}
await writeFile(`${root}/client-receipt.json`,JSON.stringify(rows,null,2));
console.log(JSON.stringify({files:rows.length,bytes:rows.reduce((n,r)=>n+r.bytes,0)}));
