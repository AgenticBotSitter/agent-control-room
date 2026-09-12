// Effect-free current-interface comparison. No native client or credentials.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {CodexAppServerJsonlSessionV1} from '../../src/harness/codex-v1/isolated-jsonrpc';
import {CodexMacIsolatedControllerV1} from '../../src/harness/codex-v1/isolated-controller';
import type {CodexMacIsolatedLauncherPlanV1} from '../../src/harness/codex-v1/isolated-launcher';
import type {CodexBrokerCallRequestV1} from '../../src/harness/codex-v1/credential-broker';
// Only the effect-free planner's accessed data is supplied; this is NOT an
// accepted launcher attestation or authorization to create a process.
const launcher={threadEnvironment:{cwd:'/synthetic/empty'}} as CodexMacIsolatedLauncherPlanV1;
const controller=new CodexMacIsolatedControllerV1(launcher,{
  claim(){throw Error('unexpected ledger claim');},
  authorizeClaimedDispatch(){throw Error('unexpected dispatch');},
});
const session=new CodexAppServerJsonlSessionV1();
const checks:string[]=[];
const check=(name:string,fn:()=>void)=>{fn();checks.push(name);};
const init=session.request('initialize',{});
session.receive(JSON.stringify({id:init.id,result:{}}));session.notification('initialized',{});
check('actual initialized JSONL port excludes read recovery',()=>assert.throws(
  ()=>session.request('thread/read',{threadId:'thread:synthetic',includeTurns:true}),/method forbidden/));
check('actual controller excludes read recovery',()=>assert.throws(
  ()=>controller.assertClientMethod('thread/read'),/method forbidden/));
const request={operation:'resume',nativeThreadId:'thread:synthetic',model:'synthetic-model'} as CodexBrokerCallRequestV1;
const boundary=controller.planThreadBoundary(request);
check('resume selects exact thread but suppresses stored turns',()=>{
  assert.equal(boundary.method,'thread/resume');
  assert.equal('excludeTurns' in boundary.params && boundary.params.excludeTurns,true);
  assert.equal('threadId' in boundary.params && boundary.params.threadId,request.nativeThreadId);
});
check('missing known identity refused',()=>assert.throws(()=>controller.planThreadBoundary({...request,nativeThreadId:undefined})));
check('rejected read has no pending request and close is terminal',()=>{
  assert.equal(session.disconnect().pendingRequestCount,0);
  assert.throws(()=>session.request('thread/resume',{threadId:'thread:synthetic'}),/closed/);
});
const sources=['isolated-jsonrpc.ts','isolated-controller.ts','isolated-runtime.ts','isolated-topology.ts'].map(file=>({file,
  sha256:createHash('sha256').update(readFileSync(new URL('../../src/harness/codex-v1/'+file,import.meta.url))).digest('hex')}));
console.log(JSON.stringify({scope:'actual current request/planning interfaces, synthetic data, no native/provider calls',
  checks,sources,cleanup:'in-memory session closed; no files/processes/services created',
  conclusion:'Supported upstream read is absent from current qualification port; existing resume is not read-only recovery'},null,2));
