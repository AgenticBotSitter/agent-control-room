// Acquisition only: never extracts or executes an archive or installer.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const freeBytes=Number(execFileSync('/bin/df',['-k','.'],{encoding:'utf8'}).trim().split('\n').at(-1).split(/\s+/)[3])*1024;
if(freeBytes<20*1024**3)throw Error('storage floor');
const root=await fs.mkdtemp('/private/tmp/cr-f8-kuma-release-');
const sources=[
 {name:'source.tar.gz',url:'https://codeload.github.com/louislam/uptime-kuma/tar.gz/1f0755fb044fe08e99fccde6722062fb2bf6c8f4',cap:20*1024**2,provenance:'official immutable source URL; observed archive hash, not an upstream signed checksum'},
 {name:'dist.tar.gz',url:'https://github.com/louislam/uptime-kuma/releases/download/2.5.3/dist.tar.gz',cap:7299676,expectedBytes:7299676,sha256:'6af8ea6cb9fc9486860eb4916337205d72caeebe1fa5a0f1ce9d4ae06474baa1',provenance:'previously inspected official release asset digest'},
 {name:'sqlite-native.tar.gz',url:'https://github.com/louislam/node-sqlite3/releases/download/v15.1.6/napi-v6-darwin-arm64-unknown.tar.gz',cap:903679,expectedBytes:903679,provenance:'official release URL over TLS; no independent published checksum located; acquisition is not approval to load'},
];
const receipt={root,freeBytes,sourceCommit:'1f0755fb044fe08e99fccde6722062fb2bf6c8f4',scope:'acquire only; no extraction, native loading or service startup',sources,status:'planned'};
const save=()=>fs.writeFile(join(root,'acquisition.json'),JSON.stringify(receipt,null,2));await save();console.log(JSON.stringify({root,freeBytes,status:receipt.status}));
try{for(const item of sources){
 const response=await fetch(item.url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('http '+response.status);
 const handle=await fs.open(join(root,item.name),'wx',0o600);const hash=createHash('sha256');let bytes=0;
 try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>item.cap)throw Error('size cap');hash.update(chunk);await handle.write(chunk);}}
 finally{await handle.close();}
 item.observedBytes=bytes;item.observedSha256=hash.digest('hex');
 if(item.expectedBytes&&bytes!==item.expectedBytes)throw Error('size mismatch');
 if(item.sha256&&item.sha256!==item.observedSha256)throw Error('hash mismatch');
 item.status='acquired-not-executed';await save();console.log(JSON.stringify({name:item.name,bytes,sha256:item.observedSha256}));
 }receipt.status='acquired-not-executed';
}catch(e){receipt.status='failed';receipt.error=e.message;process.exitCode=1;}
await save();console.log(JSON.stringify({root,status:receipt.status,error:receipt.error}));
