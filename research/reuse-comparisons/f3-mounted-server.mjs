// Disposable research server. No product runtime wiring; no real Access credentials.
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {fixture,request,token,now} from '../../tests/helpers/web-foundation.ts';
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite'))('esbuild');
const root=process.argv[2];
assert.match(root,/^\/private\/tmp\/control-room-f3\.[A-Za-z0-9]+$/);
const read=(name,hash)=>{const s=fs.readFileSync(`${root}/${name}`,'utf8');assert.equal(createHash('sha256').update(s).digest('hex'),hash);return s;};
const desktop=read('ActiveSessionsBar.tsx','61eea6c02fbc832136c5b50cd30d785a1ff774989adb29a0af8be4eb30f736c8');
const webui=read('sessions.js','598be491bc0a4309d6cacfc04b7b15a0aec192569e7098f2a8cc68c835bfbcb3');
const selected=['_buildSessionAction','_isSessionLocallyStreaming','_isSessionEffectivelyStreaming','_hasPendingUserMessageSignal','_isServerIdleSessionRow'];
const ast=ts.createSourceFile('sessions.js',webui,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const fragments=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&selected.includes(n.name?.text)).map(n=>n.getText(ast));
assert.equal(fragments.length,selected.length);
// Only import/decorative dependencies replaced. Original Desktop component body unchanged.
const desktopBody=desktop.replace(/^import .*;\n/gm,'');
const desktopModule=`import {memo} from 'react';const X=()=>null,Plus=()=>null,OrbLoader=()=>null,ProfileAvatar=()=>null;const useI18n=()=>({t:k=>k});\n${desktopBody}`;
// Actual WebUI functions use a scoped state and an explicit escaping dependency.
const webuiModule=`let S={session:null,busy:false};function esc(s){const e=document.createElement('span');e.textContent=s;return e.innerHTML;}export function setWebState(s){S=s;}\n${fragments.join('\n')}\nexport {${selected.join(',')}};`;
const bundled=await build({entryPoints:['research/reuse-comparisons/f3-mounted-ui.tsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',logLevel:'silent',plugins:[{name:'pinned-research-source',setup(b){
  b.onResolve({filter:/^f3-(desktop|webui)$/},a=>({path:a.path,namespace:'f3'}));
  b.onLoad({filter:/.*/,namespace:'f3'},a=>({contents:a.path==='f3-desktop'?desktopModule:webuiModule,loader:a.path==='f3-desktop'?'tsx':'js',resolveDir:process.cwd()}));
}}]});
const source=bundled.outputFiles[0].contents;
const f=await fixture();
for(const [index,title] of ['Project A','Project B'].entries()){
  const response=await f.handler(request(undefined,'POST',{title,summary:'Disposable UI comparison'},`f3-fixture-project-${index}`));
  assert.equal(response.status,201);
}
let expired=false, offline=false, holdNext=false,held;
let heldInfo=null,lastCompleted=null,releasedInfo=null;
const readHistory=[];
let reads=0;let report=null;let base='';let finished=false;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,base);
    if(req.headers.host!==new URL(base).host || req.headers.origin&&req.headers.origin!==base){res.writeHead(403);res.end();return;}
    const send=(status,body,type='application/json')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'"});res.end(body);};
    if(url.pathname==='/fixture.js'&&req.method==='GET'){send(200,source,'text/javascript');return;}
    if(url.pathname==='/'&&req.method==='GET'){send(200,'<!doctype html><html><head><title>F3 disposable UI comparison</title></head><body><h1>F3 disposable protected-project comparison</h1><div id="app"></div><pre id="results">Running</pre><script src="/fixture.js"></script></body></html>','text/html');return;}
    if(url.pathname==='/api/v1/projects'&&req.method==='GET'){
      const requestId=++reads;
      const capture=holdNext;holdNext=false;
      if(offline){lastCompleted={requestId,status:503,projectCount:0};readHistory.push(lastCompleted);send(503,JSON.stringify({error:'unavailable'}));return;}
      const response=await f.handler(request(undefined,'GET',undefined,undefined,expired?token({exp:now/1000-1}):token()));
      const body=await response.text();
      const result={requestId,status:response.status,projectCount:JSON.parse(body).projects?.length??0};
      readHistory.push(result);
      if(capture){heldInfo=result;held=()=>send(response.status,body);return;}
      lastCompleted=result;
      send(response.status,body);return;
    }
    if(url.pathname==='/fixture/report'&&req.method==='GET'){send(200,JSON.stringify(report??{state:'running'}));return;}
    if(url.pathname==='/fixture/state'&&req.method==='GET'){send(200,JSON.stringify({held:heldInfo,lastCompleted,released:releasedInfo}));return;}
    if(req.method!=='POST'||req.headers['x-f3-fixture']!=='1'){send(403,'{}');return;}
    if(url.pathname==='/fixture/expire')expired=true;
    else if(url.pathname==='/fixture/renew')expired=false;
    else if(url.pathname==='/fixture/offline')offline=true;
    else if(url.pathname==='/fixture/online')offline=false;
    else if(url.pathname==='/fixture/hold'){holdNext=true;heldInfo=null;releasedInfo=null;}
    else if(url.pathname==='/fixture/release'){
      if(!held||String(heldInfo?.requestId)!==req.headers['x-f3-request-id']){send(409,'{}');return;}
      releasedInfo={...heldInfo,afterRequestId:lastCompleted?.requestId,afterStatus:lastCompleted?.status};
      held();held=undefined;
      send(200,JSON.stringify(releasedInfo));return;
    }
    else if(url.pathname==='/fixture/result'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw new Error('oversize');}
      report=JSON.parse(body);const jobs=(await f.db.query('SELECT count(*)::int AS n FROM control_jobs')).rows[0].n;
      report.server={reads,controlJobs:jobs,syntheticProjects:2,realProviderCalls:0,bundleBytes:source.length,readHistory,held:heldInfo,released:releasedInfo};
      console.log(JSON.stringify(report));
    }else{send(404,'{}');return;}
    send(200,'{}');
  }catch{res.writeHead(500);res.end('{}');}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
base=`http://127.0.0.1:${server.address().port}`;
console.log(`F3_URL=${base}`);
async function close(){if(finished)return;finished=true;held?.();held=undefined;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.db.close();console.log('F3 fixture server and disposable database closed');}
const timer=setTimeout(()=>void close(),240000);timer.unref();
process.on('SIGTERM',()=>{clearTimeout(timer);void close();});
process.on('SIGINT',()=>{clearTimeout(timer);void close();});
