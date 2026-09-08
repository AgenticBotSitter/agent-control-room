// Research only: exact upstream response-classification AST, synthetic transport.
// No Axios, listener, credentials, notification delivery or Kuma persistence.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {buildOperationsHealthProbeV1} from '../../src/operations/v1/health.ts';
import {sha256Digest} from '../../src/security/index.ts';
const root=process.argv[2];assert.match(root,/^\/private\/tmp\/cr-f8-http\.[A-Za-z0-9]+$/);
const source=readFileSync(`${root}/monitor.js`,'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'33196b8c9b943eb49830888495586f05a7697e497253249ece13eb2aa95c1785');
const ast=ts.createSourceFile('monitor.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const nodes:ts.IfStatement[]=[];
function visit(n:ts.Node){if(ts.isIfStatement(n)&&n.expression.getText(ast)==='this.type === "http"'&&n.thenStatement.getText(ast).includes('bean.status = UP'))nodes.push(n);ts.forEachChild(n,visit);}
visit(ast);assert.equal(nodes.length,1);
const context=vm.createContext({UP:1});
const classify=vm.runInContext(`(async function(res,bean){${nodes[0].getText(ast)};return bean})`,context,{timeout:1000});
const now='2026-09-08T00:01:00.000Z',future='2026-09-08T00:02:00.000Z',past='2026-09-08T00:00:00.000Z';
async function observation(type:'http'|'keyword',data:unknown,options:{status?:number,expired?:boolean,error?:string}={}){
  let state:'pass'|'fail'|'unknown'|'stale'='unknown',classified=false;
  try{
    // This is explicitly a synthetic response/error port, NOT upstream HTTP transport.
    if(options.error)throw Error(options.error);
    const status=options.status??200;
    if(status!==200)throw Error('synthetic_accepted_status_filter');
    const result=await classify.call({type,keyword:'CR_READY',isInvertKeyword:()=>false},{status,data},{msg:`${status}`});
    classified=result.status===1;state=classified?'pass':'fail';
  }catch{state=options.error?'unknown':'fail';}
  if(options.expired)state='stale';
  const probe=buildOperationsHealthProbeV1({probeId:'dependency_connectivity',applicability:'required',state,safeStatusCode:`research_${state}`,observedAt:now,validUntil:options.expired?past:future,evidenceDigest:sha256Digest({fixture:true,type,data,status:options.status??200,state}),observerIdentityDigest:sha256Digest('synthetic-http-observer')});
  assert.equal(probe.grantsServiceControl,false);assert.equal(probe.grantsDeploymentAuthority,false);
  return {state:probe.state,classified,probeDigest:probe.probeDigest};
}
const cases=[];
for(const [name,type,data,options,expected] of [
  ['ready marker','keyword','CR_READY',{},'pass'],
  ['plain HTTP accepts login page','http','<html>Sign in</html>',{},'pass'],
  ['keyword rejects login page','keyword','<html>Sign in</html>',{},'fail'],
  ['keyword accepts marker embedded in error page','keyword','<html>Error: requested CR_READY</html>',{},'pass'],
  ['stale marker','keyword','CR_STALE',{},'fail'],
  ['expired observation cannot pass','keyword','CR_READY',{expired:true},'stale'],
  ['synthetic 503 rejection','keyword','CR_READY',{status:503},'fail'],
  ['synthetic disconnect','keyword','CR_READY',{error:'disconnect'},'unknown'],
  ['synthetic timeout','keyword','CR_READY',{error:'timeout'},'unknown'],
] as const){const result=await observation(type,data,options);assert.equal(result.state,expected);cases.push({name,...result});}
const repeat=await observation('keyword','CR_READY');assert.equal(repeat.probeDigest,cases[0].probeDigest);
cases.push({name:'same observation repeats digest; no alert dedup/persistence proof',...repeat});
console.log(JSON.stringify({revision:'e4821321e559c887b14e37d9979e604b221a8945',sourceHash:'33196b8c9b943eb49830888495586f05a7697e497253249ece13eb2aa95c1785',cases,scope:'Actual HTTP/keyword response-classification branch plus actual CR health builder; synthetic response/status/error ports; no JSON-query, transport, timeout, restart or notification qualification',networkCalls:0,servicesStarted:0},null,2));
