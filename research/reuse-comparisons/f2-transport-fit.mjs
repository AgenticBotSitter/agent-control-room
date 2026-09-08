// Actual published SDK process transport with a plainly synthetic executable.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, chmod, readFile, readdir, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeCodexJsonLineV1 } from '../../src/harness/codex-v1/decoder.ts';
import { projectCodexRunResultV1 } from '../../src/harness/codex-v1/result.ts';
const source=process.argv[2];
assert.match(source??'',/^\/private\/tmp\/cr-compare-f2\.[A-Za-z0-9]+$/);
assert.equal(createHash('sha256').update(await readFile(join(source,'package/dist/index.js'))).digest('hex'),'d62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f');
const {Codex}=await import(pathToFileURL(join(source,'package/dist/index.js')));
const started=performance.now();
const root=await mkdtemp('/private/tmp/cr-f2-transport.');
const peer=join(root,'synthetic-peer.mjs');
await copyFile(resolve('research/reuse-comparisons/f2-transport-peer.mjs'),peer);
await chmod(peer,0o700);await mkdir(join(root,'workspace'));
const checks=[],receipts=[];
process.env.F2_AMBIENT_SENTINEL='synthetic-not-to-be-inherited';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const nativeId='11111111-1111-4111-8111-111111111111';
let serial=0;const lastInstance=new Map();
const instance=mode=>{const id=String(++serial);lastInstance.set(mode,id);return new Codex({codexPathOverride:peer,env:{PATH:dirname(process.execPath)+':/usr/bin:/bin',F2_FIXTURE_ROOT:root,F2_FIXTURE_MODE:mode,F2_FIXTURE_INSTANCE:id}});};
const options={sandboxMode:'read-only',networkAccessEnabled:false,webSearchMode:'disabled',approvalPolicy:'never',workingDirectory:join(root,'workspace'),skipGitRepoCheck:true};
const projection=async thread=>{
  const events=[];let finalTextDigest;
  const {events:stream}=await thread.runStreamed('Synthetic prompt');
  for await(const frame of stream){
    const decoded=decodeCodexJsonLineV1(JSON.stringify(frame),{tenantId:'tenant:fixture',nodeId:'node:fixture',runId:'run:fixture',sequence:events.length+1,occurredAt:'2026-09-08T00:00:00.000Z'});
    events.push(...decoded.events);finalTextDigest=decoded.finalTextDigest??finalTextDigest;
  }
  return projectCodexRunResultV1({tenantId:'tenant:fixture',runId:'run:fixture',events,finalTextDigest});
};
async function trace(mode){return JSON.parse(await readFile(join(root,`${mode}-${lastInstance.get(mode)}.json`),'utf8'));}
let clean=false;
try{
  const result=await projection(instance('success').startThread(options));
  assert.equal(result.terminalState,'succeeded');assert.equal(result.usage.inputTokens,8);
  const initial=await trace('success');
  assert.deepEqual(initial.args.slice(0,2),['exec','--experimental-json']);
  assert.equal(initial.args[initial.args.indexOf('--cd')+1],join(root,'workspace'));
  assert.equal(initial.args[initial.args.indexOf('--sandbox')+1],'read-only');
  assert.ok(initial.args.includes('web_search="disabled"'));
  assert.equal(initial.inputBytes,Buffer.byteLength('Synthetic prompt'));assert.equal(initial.inputMatches,true);
  assert.ok(initial.args.includes('approval_policy="never"'));
  assert.ok(initial.args.includes('sandbox_workspace_write.network_access=false'));
  // macOS may add this runtime encoding key after spawn; never inspect its value.
  assert.deepEqual(initial.environmentKeys.filter(x=>x!=='__CF_USER_TEXT_ENCODING'),['CODEX_INTERNAL_ORIGINATOR_OVERRIDE','F2_FIXTURE_INSTANCE','F2_FIXTURE_MODE','F2_FIXTURE_ROOT','PATH']);
  const receipt={...initial,args:initial.args.map(x=>x===join(root,'workspace')?'<disposable-workspace>':x)};delete receipt.pid;
  receipts.push(receipt);
  checks.push('actual SDK spawn/argv/stdin and isolated environment reach synthetic executable; actual events cross CR result projection');
  await projection(instance('success').resumeThread(nativeId,options));
  const resumed=await trace('success');assert.equal(resumed.args[resumed.args.indexOf('resume')+1],nativeId);
  checks.push('public resume method forwards exact native ID to synthetic child');
  await assert.rejects(projection(instance('truncated').startThread(options)),/missing terminal state/);
  checks.push('actual EOF transport settles; CR refuses incomplete terminal evidence');
  await assert.rejects(projection(instance('malformed').startThread(options)),/Failed to parse item/);
  checks.push('actual malformed child output refuses');
  await assert.rejects(projection(instance('nonzero').startThread(options)),/code 7: synthetic refusal/);
  checks.push('nonzero synthetic process surfaces exit and stderr');
  await assert.rejects(projection(instance('oversize').startThread(options)),/frame too large/);
  checks.push('SDK admits oversized line; existing CR decoder rejects it after line allocation');
  const oversizedError=await instance('stderr').startThread(options).run('Synthetic prompt').then(()=>null,e=>e);
  assert.ok(oversizedError.message.length>=65536);checks.push('SDK includes 64KiB synthetic stderr in error; output redaction/bounds still required');
  const controller=new AbortController();
  const attempt=instance('wait').startThread(options).run('Synthetic prompt',{signal:controller.signal}).then(()=>({ok:true}),e=>({ok:false,name:e.name,message:e.message}));
  let waiting;
  for(let n=0;n<100;n++){try{waiting=await trace('wait');break;}catch(e){if(e.code!=='ENOENT')throw e;await pause(10);}}
  assert.ok(waiting,'synthetic child did not acknowledge start');controller.abort();
  const cancellation=await attempt;assert.equal(cancellation.ok,false);assert.match(cancellation.name,/Abort/);
  for(let n=0;n<100&&alive(waiting.pid);n++)await pause(10);
  assert.equal(alive(waiting.pid),false);
  checks.push('AbortSignal stops acknowledged cooperative synthetic child; no native agent or descendant guarantee');
}finally{
  delete process.env.F2_AMBIENT_SENTINEL;
  const traces=[];
  for(const name of await readdir(root))if(name.endsWith('.json'))traces.push(JSON.parse(await readFile(join(root,name),'utf8')));
  for(let n=0;n<250&&traces.some(t=>alive(t.pid));n++)await pause(10);
  const remaining=traces.filter(t=>alive(t.pid)).map(t=>t.pid);
  if(remaining.length===0){await rm(root,{recursive:true});clean=true;}
  console.log(JSON.stringify({checks,count:checks.length,receipts,ownedRoot:root,clean,remaining,elapsedMs:performance.now()-started,parentPeakRssKiB:process.resourceUsage().maxRSS,scope:'actual SDK process transport to synthetic Node emitter; no real Codex, credentials, providers, profile or plugins; memory is parent-only, not cumulative children',nativeAgentCalls:0},null,2));
  assert.equal(remaining.length,0,'owned synthetic peer still alive; retained root for diagnosis');
}
