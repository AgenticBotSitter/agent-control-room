// Bounded public source reads only. No downloaded code executes.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const availableBytes=Number(execFileSync('/bin/df',['-k','.'],{encoding:'utf8'}).trim().split('\n').at(-1).split(/\s+/)[3])*1024;
if(availableBytes<20*1024**3)throw Error('storage floor');
const reads=[];
async function get(url){const response=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/vnd.github+json'}});
  const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw Error('body cap');chunks.push(chunk);}
  const body=Buffer.concat(chunks);reads.push({url,status:response.status,bytes,sha256:createHash('sha256').update(body).digest('hex')});
  if(!response.ok)throw Error('http '+response.status);return body.toString();}
const base='https://api.github.com/repos/louislam/uptime-kuma';
let object=JSON.parse(await get(base+'/git/ref/tags/2.5.3')).object;
for(let i=0;object.type==='tag'&&i<3;i++)object=JSON.parse(await get(base+'/git/tags/'+object.sha)).object;
if(object.type!=='commit'||!/^[a-f0-9]{40}$/.test(object.sha))throw Error('unresolved tag');
const old='e4821321e559c887b14e37d9979e604b221a8945',pin=object.sha;
const files=['package.json','package-lock.json','server/server.js','server/database.js','server/uptime-kuma-server.js','server/check-version.js','server/config.js','server/notification.js'];
const comparison=[];
const deltas=[];
for(const path of files.filter(p=>!process.argv.includes('--delta')||['package-lock.json','server/database.js','server/notification.js'].includes(p))){const a=await get(`https://raw.githubusercontent.com/louislam/uptime-kuma/${old}/${path}`);
 const b=pin===old?a:await get(`https://raw.githubusercontent.com/louislam/uptime-kuma/${pin}/${path}`);
 comparison.push({path,equal:a===b,oldBytes:Buffer.byteLength(a),releaseBytes:Buffer.byteLength(b)});
 if(process.argv.includes('--delta')&&a!==b){
  if(path.endsWith('.json')){const ap=JSON.parse(a).packages,bp=JSON.parse(b).packages;
   deltas.push({path,packages:[...new Set([...Object.keys(ap),...Object.keys(bp)])].filter(k=>JSON.stringify(ap[k])!==JSON.stringify(bp[k])).map(key=>({key,before:ap[key],after:bp[key]}))});
  }else{const al=a.split('\n'),bl=b.split('\n');deltas.push({path,
   removed:al.flatMap((line,i)=>!bl.includes(line)?[{line:i+1,text:line,preceding:al.slice(Math.max(0,i-2),i)}]:[]),
   added:bl.flatMap((line,i)=>!al.includes(line)?[{line:i+1,text:line,preceding:bl.slice(Math.max(0,i-2),i)}]:[]),
   limitation:'line membership differences only; not an ordering-sensitive full diff'});}
 }}
const receipt={scope:'public source metadata/hash comparison only; no retained source or execution',availableBytes,tag:'2.5.3',pin,old,comparison,deltas,reads,totalBytes:reads.reduce((s,r)=>s+r.bytes,0)};
if(process.argv.includes('--delta'))writeFileSync('docs/research/reuse-comparisons/f8-kuma-release-delta.json',JSON.stringify(receipt,null,2),{flag:'wx'});
console.log(JSON.stringify({...receipt,reads:reads.length,deltas:deltas.map(d=>d.packages?{path:d.path,changedPackages:d.packages.map(p=>({key:p.key,before:p.before?.version,after:p.after?.version,fields:[...new Set([...Object.keys(p.before??{}),...Object.keys(p.after??{})])].filter(k=>JSON.stringify(p.before?.[k])!==JSON.stringify(p.after?.[k]))}))}:d)},null,2));
