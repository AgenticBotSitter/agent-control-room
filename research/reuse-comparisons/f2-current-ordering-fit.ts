// Research only. Authored finite transport; real unchanged runtime and in-memory ledger.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const pins = {
  'isolated-runtime.ts': '398c56e2036ddd0f4aecf1fe8964e3ff1849fcc88fd7143f46826ec3eb022aca',
  'isolated-jsonrpc.ts': 'b224f9ab4bb3edb60b829cbaecad0df40a97cced5ebc9dc5d3e3865ff419b7ff',
  'credential-broker.ts': '639bb488c4c7f317e62a680858e3b1733868217049beb21e4027f9df2c6dd198',
};
for (const [file, hash] of Object.entries(pins)) assert.equal(createHash('sha256').update(readFileSync(new URL(`../../src/harness/codex-v1/${file}`, import.meta.url))).digest('hex'), hash);
const { CodexIsolatedQualificationRuntimeV1, CodexAppServerRuntimeErrorV1 } = await import('../../src/harness/codex-v1/isolated-runtime');
const { InMemoryCodexCredentialBrokerLedgerV1 } = await import('../../src/harness/codex-v1/credential-broker');
const { issueCodexCredentialBoundaryPermitV1 } = await import('../../src/harness/codex-v1/credential-boundary');
const { planCodexMacIsolatedLauncherV1 } = await import('../../src/harness/codex-v1/isolated-launcher');
const now = '2026-08-27T23:00:01.000Z';
const plan = planCodexMacIsolatedLauncherV1({
  nodeRuntime:'/runtime/node', brokerControllerScript:'/release/broker/codex-broker-controller.js',
  brokerConfigPath:'/broker-config/config.json',brokerConfigRoot:'/broker-config',brokerReleaseRoot:'/release/broker',
  brokerCodexHome:'/broker/credentials',brokerStateRoot:'/broker/state',brokerLedgerPath:'/broker/state/ledger.sqlite',
  executorCodexHome:'/executor/home',executorWorkingDirectory:'/executor/work',workspacePath:'/executor/work/repo',
  executorEndpoint:'ws://127.0.0.1:45451',environmentId:'environment:codex:one',
  brokerIdentityDigest:`sha256:${'1'.repeat(64)}`,executorIdentityDigest:`sha256:${'2'.repeat(64)}`,
}); // Pure plan only; no paths/endpoints are accessed.
type Mode = 'response-first'|'same-turn-start-first'|'same-turn-all-first'|'stale-control';
class Transport {
  queue:string[]=[]; methods:string[]=[]; consumed:string[]=[]; closed=0; queuedTurnFrames:unknown[]=[];
  constructor(readonly mode:Mode) {}
  async write(line:string) {
    assert.ok(Buffer.byteLength(line)<16384); assert.ok(this.methods.length<10);
    const m=JSON.parse(line); this.methods.push(m.method);
    if(m.method==='initialized') return;
    let result:unknown={};
    if(m.method==='initialize') result={userAgent:'synthetic'};
    if(m.method==='environment/status') result={status:'ready'};
    if(m.method==='thread/start') result={thread:{id:'thread:runtime:one'}};
    if(m.method==='turn/start') {
      const start={method:'turn/started',params:{threadId:'thread:runtime:one',turn:{id:'turn:runtime:one',status:'inProgress'}}};
      const usage={method:'thread/tokenUsage/updated',params:{threadId:'thread:runtime:one',turnId:'turn:runtime:one',tokenUsage:{last:{inputTokens:20,outputTokens:4,cachedInputTokens:8,reasoningOutputTokens:2}}}};
      const done={method:'turn/completed',params:{threadId:'thread:runtime:one',turn:{id:'turn:runtime:one',status:'completed',items:[]}}};
      const response={id:m.id,result:{turn:{id:'turn:runtime:one',status:'inProgress'}}};
      this.queuedTurnFrames=this.mode==='response-first'?[response,start,usage,done]:this.mode==='same-turn-start-first'?[start,response,usage,done]:this.mode==='same-turn-all-first'?[start,usage,done,response]:[{method:'turn/started',params:{threadId:'thread:runtime:one',turn:{id:'turn:stale',status:'inProgress'}}},response,start,usage,done];
      this.queue.push(...this.queuedTurnFrames.map(x=>JSON.stringify(x))); return;
    }
    assert.ok(['initialize','environment/add','environment/status','thread/start'].includes(m.method));
    this.queue.push(JSON.stringify({id:m.id,result}));
  }
  async readLine(){const s=this.queue.shift();if(s){const m=JSON.parse(s);this.consumed.push(m.method??'response');}return s??null;}
  async close(){this.closed++;}
}
const rows=[];
for(const mode of ['response-first','same-turn-start-first','same-turn-all-first','stale-control'] as Mode[]){
  const runId=`run:ordering:${mode}`;
  const issued=issueCodexCredentialBoundaryPermitV1({runId,now:'2026-08-27T23:00:00.000Z',evidence:{mode:'scoped_provider_broker',longLivedCredentialInWorker:false,credentialStoreReadableToCommands:'blocked',directProviderNetworkFromWorker:false,commandEnvironmentInheritsCredential:false,broker:{endpointIdentityDigest:`sha256:${'5'.repeat(64)}`,runAudience:runId,expiresAt:'2026-08-27T23:04:00.000Z',maximumProviderCalls:3,model:'gpt-5.6-sol',capabilityKind:'ephemeral_run_capability'}}});
  assert.ok(issued.accepted);const permit=issued.permit;
  const ledger=new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${'5'.repeat(64)}`,{clock:()=>now});
  ledger.provision({permit,limits:{maximumInputBytes:1024,maximumOutputTokens:1024}});
  const request={schema:'control-room.codex-broker-call/v1' as const,requestId:`request:ordering:${mode}`,permitDigest:permit.permitDigest,runId,model:permit.model,operation:'start' as const,input:'synthetic bounded text',maximumOutputTokens:512};
  const transport=new Transport(mode);let result:unknown;let safeCode:string|undefined;
  try{result=await new CodexIsolatedQualificationRuntimeV1(plan,ledger,transport).execute(request,now,{timeoutMs:1000});}
  catch(e){assert.ok(e instanceof CodexAppServerRuntimeErrorV1);safeCode=e.safeCode;}
  assert.equal(transport.closed,1);assert.equal(transport.methods.filter(x=>x==='turn/start').length,1);
  const claimed=ledger.claim(request,now);
  if(mode==='response-first') {assert.equal(safeCode,undefined);assert.equal((result as {disposition:string}).disposition,'completed');assert.deepEqual(claimed,{disposition:'replay_completed',usage:{inputTokens:20,outputTokens:4,cachedInputTokens:8,reasoningTokens:2}});}
  else {assert.equal(safeCode,'app_server_protocol_invalid');assert.deepEqual(claimed,{disposition:'ambiguous',safeResultCode:'app_server_protocol_invalid'});assert.equal(result,undefined);}
  assert.equal(ledger.evidence(permit.permitDigest).consumedProviderCalls,1);
  const replayTransport=new Transport(mode);
  const replay=await new CodexIsolatedQualificationRuntimeV1(plan,ledger,replayTransport).execute(request,now,{timeoutMs:1000});
  assert.equal(replay.disposition,mode==='response-first'?'replay_completed':'ambiguous');
  assert.deepEqual(replayTransport.methods,['initialize','initialized','environment/add','environment/status']);
  assert.equal(replayTransport.closed,1);assert.equal(ledger.evidence(permit.permitDigest).consumedProviderCalls,1);
  rows.push({mode,result,safeCode,claimed,replay,consumed:transport.consumed,unreadFrames:transport.queue.length,queuedTurnFrames:transport.queuedTurnFrames,methods:transport.methods,replayMethods:replayTransport.methods,closed:transport.closed,replayClosed:replayTransport.closed,consumedSyntheticCalls:1});
}
console.log(JSON.stringify({schema:'control-room.research.current-ordering/v1',scope:'actual runtime/controller/observer and in-memory ledger; synthetic line transport and authority evidence; no native calls',pins,cases:rows.length,rows},null,2));
