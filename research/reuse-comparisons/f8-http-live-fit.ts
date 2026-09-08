// Research only. Exact hash-checked upstream HTTP block and helper methods.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import crypto from 'node:crypto';
import http from 'node:http';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {buildOperationsHealthProbeV1} from '../../src/operations/v1/health.ts';
import {sha256Digest} from '../../src/security/index.ts';
const root=process.argv[2];assert.match(root,/^\/private\/tmp\/cr-f8-http\.[A-Za-z0-9]+$/);
const hashes={'monitor.js':'33196b8c9b943eb49830888495586f05a7697e497253249ece13eb2aa95c1785','util.ts':'630730aaf91714fb42b66c31525f8ffac705cfb6f843a9cfb5453a3861ffb0fd','util-server.js':'374c070054db0fcf6f089dc40d1b5d341729dc2533348f12e1c7162439bce90a'};
const sources=Object.fromEntries(Object.entries(hashes).map(([f,h])=>{const s=readFileSync(`${root}/${f}`,'utf8');assert.equal(createHash('sha256').update(s).digest('hex'),h);return[f,ts.createSourceFile(f,s,ts.ScriptTarget.Latest,true)];}));
function select(f:string,p:(n:ts.Node)=>boolean){const found:ts.Node[]=[];function visit(n:ts.Node){if(p(n))found.push(n);ts.forEachChild(n,visit);}visit(sources[f]);assert.equal(found.length,1);return found[0];}
const branch=select('monitor.js',n=>ts.isIfStatement(n)&&n.expression.getText(sources['monitor.js'])==='this.type === "http" || this.type === "keyword" || this.type === "json-query"') as ts.IfStatement;
const method=select('monitor.js',n=>ts.isMethodDeclaration(n)&&n.name.getText()==='makeAxiosRequest');
const query=select('util.ts',n=>ts.isFunctionDeclaration(n)&&n.name?.text==='evaluateJsonQuery');
const check=select('util-server.js',n=>ts.isBinaryExpression(n)&&n.left.getText()==='exports.checkStatusCode') as ts.BinaryExpression;
const abort=select('util-server.js',n=>ts.isBinaryExpression(n)&&n.left.getText()==='module.exports.axiosAbortSignal') as ts.BinaryExpression;
const req=createRequire(`${root}/package.json`),axios=req('axios');axios.defaults.proxy=false;
const context=vm.createContext({axios,dayjs:req('dayjs'),jsonata:req('jsonata'),http,crypto,CookieJar:req('tough-cookie').CookieJar,HttpsCookieAgent:req('http-cookie-agent/http').HttpsCookieAgent,AbortSignal,AbortController,setTimeout,Buffer,UP:1,process:{env:{}},log:{debug(){},info(){},error(){}}});
vm.runInContext(`var checkStatusCode=${check.right.getText()}; var axiosAbortSignal=${abort.right.getText()};`,context);
vm.runInContext(ts.transpile(query.getText().replace(/^export /,''),{target:ts.ScriptTarget.ES2022}),context);
const make=vm.runInContext(`({${method.getText()}}).makeAxiosRequest`,context);
const probe=vm.runInContext(`(async function(bean)${branch.thenStatement.getText()})`,context);
const sockets=new Set<import('node:net').Socket>();let hits=0;
const server=http.createServer((r,s)=>{hits++;if(r.url==='/timeout')return;if(r.url==='/disconnect'){r.socket.destroy();return;}if(r.url==='/503')s.statusCode=503;
 const body=r.url==='/login'?'<html>Sign in</html>':r.url==='/embedded'?'<html>Error CR_READY</html>':JSON.stringify({state:r.url==='/stale'?'stale':'ready',validUntil:r.url==='/expired'?'2000-01-01T00:00:00Z':'2099-01-01T00:00:00Z',marker:'CR_READY'});s.end(body);});
server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
async function start(){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;}
async function stop(){for(const s of sockets)s.destroy();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
let base=await start();const cases=[];
async function observe(path:string,type='json-query',expired=false){const bean:{status?:number}={};let state:'unknown'|'pass'|'fail'|'stale'='unknown',code='ok';const monitor={url:base+path,type,timeout:.15,headers:null,method:'GET',maxredirects:0,name:'disposable',auth_method:'none',getIgnoreTls:()=>false,getAcceptedStatuscodes:()=>['200-299'],getSaveResponse:()=>false,getUrl:()=>new URL(base+path),keyword:'CR_READY',isInvertKeyword:()=>false,jsonPath:'state',jsonPathOperator:'==',expectedValue:'ready',makeAxiosRequest:make};
 try{await probe.call(monitor,bean);state=bean.status===1?'pass':'unknown';}catch(error:unknown){const e=error as {code?:string;response?:unknown};code=e.code??'classification';state=e.response?'fail':e.code?'unknown':'fail';}if(expired&&state==='pass')state='stale';
 const p=buildOperationsHealthProbeV1({probeId:'dependency_connectivity',applicability:'required',state,safeStatusCode:`research_${state}`,observedAt:'2026-09-08T00:01:00Z',validUntil:expired?'2026-09-08T00:00:00Z':'2026-09-08T00:02:00Z',evidenceDigest:sha256Digest({path,type,state}),observerIdentityDigest:sha256Digest('disposable-upstream-http')});assert.equal(p.grantsServiceControl,false);assert.equal(p.grantsDeploymentAuthority,false);return{state:p.state,code,digest:p.probeDigest};}
try{for(const [path,type,expired,expected] of [['/ready','json-query',false,'pass'],['/login','http',false,'pass'],['/login','json-query',false,'fail'],['/embedded','keyword',false,'pass'],['/stale','json-query',false,'fail'],['/expired','json-query',true,'stale'],['/503','json-query',false,'fail'],['/disconnect','json-query',false,'unknown'],['/timeout','json-query',false,'unknown']] as const){const result=await observe(path,type,expired);assert.equal(result.state,expected);cases.push({path,type,...result});}
 assert.equal(cases.find(c=>c.path==='/503')?.code,'ERR_BAD_RESPONSE');assert.equal(cases.find(c=>c.path==='/disconnect')?.code,'ECONNRESET');assert.equal(cases.find(c=>c.path==='/timeout')?.code,'ECONNABORTED');
 const repeat=await observe('/ready');assert.equal(repeat.digest,cases[0].digest);cases.push({path:'repeat observation (not alert dedup)',...repeat});await stop();base=await start();const restarted=await observe('/ready');assert.equal(restarted.state,'pass');cases.push({path:'fixture server restarted (not Kuma daemon restart)',...restarted});
 console.log(JSON.stringify({pin:'e4821321e559c887b14e37d9979e604b221a8945',hashes,cases,hits,scope:'Actual upstream HTTP branch, makeAxiosRequest, status filter, abort signal, JSON query and real Axios/dayjs/jsonata/cookie agents through actual CR health builder. Own loopback HTTP only; no full Kuma scheduler/ORM/notifications/TLS/auth/daemon persistence. Stale timestamp interpretation is research adapter input, not upstream state-query behavior.'},null,2));
}finally{if(server.listening)await stop();}
