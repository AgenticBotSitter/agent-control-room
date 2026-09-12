// Extract validated owned archives; inspect native metadata without loading it.
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const root='/private/tmp/cr-f8-kuma-release-OiEJq7';
const receipt=JSON.parse(await fs.readFile(join(root,'acquisition.json'),'utf8'));
if(receipt.status!=='acquired-not-executed')throw Error('acquisition incomplete');
const run=await fs.mkdtemp(join(root,'inspection-'));const reports=[];
const exec=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:15000,maxBuffer:4*1024**2});
for(const item of receipt.sources){const archive=join(root,item.name);
 if(createHash('sha256').update(await fs.readFile(archive)).digest('hex')!==item.observedSha256)throw Error('archive changed');
 const names=exec('/usr/bin/tar',['-tf',archive]).trim().split('\n');
 const listing=exec('/usr/bin/tar',['-tvf',archive]).trim().split('\n');
 const prefix=item.name==='source.tar.gz'?'uptime-kuma-'+receipt.sourceCommit:item.name==='dist.tar.gz'?'dist':'napi-v6-darwin-arm64';
 for(const name of names)if(!name.startsWith(prefix+'/')||name.startsWith('/')||name.split('/').includes('..')||name.includes('\\'))throw Error('unsafe member');
 if(listing.length!==names.length||listing.some(l=>!['-','d'].includes(l[0])))throw Error('unsupported link/member');
 const expanded=listing.reduce((s,l)=>{const n=Number(l.split(/\s+/)[4]);if(!Number.isSafeInteger(n)||n<0)throw Error('invalid size');return s+n;},0);
 if(expanded>128*1024**2)throw Error('expanded size cap');
 exec('/usr/bin/tar',['-xf',archive,'-C',run,'--no-same-owner','--no-same-permissions']);
 reports.push({archive:item.name,members:names.length,expandedBytes:expanded});
}
const addon=join(run,'napi-v6-darwin-arm64/node_sqlite3.node');
const metadata={file:exec('/usr/bin/file',[addon]),libraries:exec('/usr/bin/otool',['-L',addon])};
try{metadata.signature=exec('/usr/bin/codesign',['--verify','--strict','--verbose=2',addon]);metadata.signatureVerified=true;}
catch(e){metadata.signatureVerified=false;metadata.signature=String(e.stderr??e.message).slice(0,4000);}
const result={root,run,scope:'validated extraction and native metadata only; addon not loaded, no npm scripts or daemon',reports,addonSha256:createHash('sha256').update(await fs.readFile(addon)).digest('hex'),metadata};
await fs.writeFile(join(root,'inspection.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result,null,2));
