import{mkdir,writeFile,readdir}from'node:fs/promises';import{createHash}from'node:crypto';
const root=process.argv[2];if(!/^\/private\/tmp\/control-room-f2router\.[A-Za-z0-9]+$/.test(root??''))throw Error('root');
if((await readdir(root)).length)throw Error('fresh empty owned root required');
const pin='553df1c691fe8bf7747e50da22f1342984495ae0';let total=0;const receipt=[];
for(const file of ['_message_router.py','_goal.py','models.py','errors.py','generated/notification_registry.py','generated/v2_all.py','client.py']){const url=`https://raw.githubusercontent.com/openai/codex/${pin}/sdk/python/src/openai_codex/${file}`;const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`source fetch ${r.status}`);const b=Buffer.from(await r.arrayBuffer());total+=b.length;if(total>1000000||b.length>400000)throw Error('cap');await mkdir(`${root}/openai_codex/${file.includes('/')?'generated':''}`,{recursive:true});await writeFile(`${root}/openai_codex/${file}`,b);receipt.push({file,url,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}
await writeFile(`${root}/receipt.json`,JSON.stringify(receipt,null,2));console.log({total,files:receipt.length});
