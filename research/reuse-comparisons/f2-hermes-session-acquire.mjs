import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=process.argv[2];assert.match(root,/^\/private\/tmp\/cr-f2-hermes-session\.[A-Za-z0-9]+$/);
const pin='b1f003e18633298d549668b8e186af84cca45b76';
const hash=b=>createHash('sha256').update(b).digest('hex');
const sources=[];
for(const path of ['pyproject.toml','LICENSE','hermes_cli/web_routers/files.py','hermes_cli/web_server_files.py','hermes_cli/web_models.py','hermes_cli/web_deps.py','hermes_cli/_subprocess_compat.py','tests/hermes_cli/test_web_server_files.py']){
 const url=`https://raw.githubusercontent.com/NousResearch/hermes-agent/${pin}/${path}`;
 const response=await fetch(url,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
 const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<1024*1024);
 await mkdir(`${root}/source/${path.split('/').slice(0,-1).join('/')}`,{recursive:true});await writeFile(`${root}/source/${path}`,bytes);
 sources.push({path,url,bytes:bytes.length,sha256:hash(bytes)});
}
const wheels=[];
for(const filename of await readdir(`${root}/wheels`)){
 assert.ok(filename.endsWith('.whl'));const [name,version]=filename.split('-');
 const response=await fetch(`https://pypi.org/pypi/${name}/${version}/json`,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
 const metadata=await response.json();const artifact=metadata.urls.find(x=>x.filename===filename);assert.ok(artifact);
 const bytes=await readFile(`${root}/wheels/${filename}`);assert.equal(hash(bytes),artifact.digests.sha256);
 wheels.push({filename,name:metadata.info.name,version,url:artifact.url,bytes:bytes.length,sha256:hash(bytes),licenseExpression:metadata.info.license_expression,license:metadata.info.license,classifiers:metadata.info.classifiers.filter(x=>x.startsWith('License ::'))});
}
const result={pin,ownedRoot:root,sources,wheels,totalAcquiredBytes:sources.reduce((a,x)=>a+x.bytes,0)+wheels.reduce((a,x)=>a+x.bytes,0),scope:'Exact source and binary wheels only; registry JSON metadata transient; no sdist or installation scripts.'};
assert.ok(result.totalAcquiredBytes<50*1024*1024);
await writeFile('docs/research/reuse-comparisons/f2-hermes-session-acquisitions.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
