import { S4_FIXTURE_ROUTE, s4FixtureRoutes, s4FixtureContractRoutes, s4ProviderServiceV1, s4TaskFixture } from './helpers/improve-control-room-loop-recovery';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateTaskBootstrap } from '../src/web/v1/private-task-startup';
import { taskStartupFixture } from './helpers/task-startup';
import { syntheticRecoveryEngine, seedRecoveryRun, recoveryKey } from './helpers/improve-control-room-loop-recovery';
import { instant } from './hermes-native-fixture';
import { sha256Digest } from '../src/security';

test('B3a startup recovers the same run without Start',async t=>{
  const f=await taskStartupFixture();t.after(f.close);
  const e=await syntheticRecoveryEngine(t),clock=()=>instant+7000;
  const projectId=f.plannerConfig.template.authority.projectId;
  const saved=await seedRecoveryRun(f,e,projectId,clock);
  const before=(await e.traces()).filter(v=>v.op==='start').length;
  // Prospective installation capability travels through the existing contract.
  const recovery:import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryCapabilityV1={enabled:()=>true,inspect:async(run:string)=>({schemaVersion:1,run:(await e.raw.status(run)).run,revision:3,mode:'runnable',action:'wait',driver:{state:'ended',generation:null,evidenceDigest:sha256Digest('ended')},receipt:null,evidenceDigest:sha256Digest('SYNTHETIC observation')}),
    claimDriver:async(_binding:unknown,spawn:()=>Promise<LoopRecoveryChildV1>)=>({kind:'started',generation:'a'.repeat(32),child:await spawn()})};
  const contract={...e.configuration.contract,recovery};
  const bootstrap=createPrivateTaskBootstrap({openDatabase:f.openDatabase,clock,install:()=>{}});
  const app=await bootstrap.start({...f.config,loopBridge:{integrityKey:recoveryKey,adapter:{...e.configuration,contract}}});
  try{
    const deadline=Date.now()+3000;
    while(Date.now()<deadline&&!(await e.traces()).some(v=>v.op==='wait'))await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await e.traces()).filter(v=>v.op==='wait').length,1,'one wait --chain child after startup');
    assert.equal((await e.traces()).filter(v=>v.op==='start').length,before,'recovery never calls Start');
    assert.equal((await saved.bridge.status(f.identity,projectId,saved.id)).display.runLinkId,saved.link);
  }finally{await app.close();}
});

import { ImproveControlRoomLoopServiceV1 } from '../src/web/v1/improve-control-room-loop-service';
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1, type LoopRecoveryBindingV1, type LoopAdapterV1, type LoopRecoveryChildV1 } from '../src/web/v1/improve-control-room-loop-adapter';
import { createImproveControlRoomLoopRecoveryV1 } from '../src/web/v1/improve-control-room-loop-recovery';
import { taskFixture } from './helpers/web-task';
import { now } from './helpers/web-foundation';
import { syntheticRecoveryCapability } from './helpers/improve-control-room-loop-recovery';
import type { TestContext } from 'node:test';
async function recoveryFixture(t:TestContext,pendingStart=false){
  const f=await s4TaskFixture();t.after(()=>f.db.close());const e=await syntheticRecoveryEngine(t),clock=()=>now;
  const scope={tenantId:'tenant:web',workspaceId:'workspace:web'},projectId=f.project.projectId;
  const saved=await seedRecoveryRun({...f,db:f.client,scope},e,projectId,clock,'b3a-seed',pendingStart);
  const c=syntheticRecoveryCapability(e),adapter=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,recovery:c.capability}});t.after(()=>adapter.close());
  const service=(a:LoopAdapterV1=adapter)=>new ImproveControlRoomLoopServiceV1(f.client,scope,{providers:s4ProviderServiceV1(f.client,scope,clock),integrityKey:recoveryKey,adapter:a},clock);
  const bridge=service(),target={projectId,requestId:saved.id,ownerIdentityId:'identity:web'};
  return{...f,...e,...saved,...c,seedAdapter:e.adapter,scope,projectId,adapter,bridge,service,target,port:bridge.recoveryPort()};
}
const signal=()=>new AbortController().signal;

test('B3a accepted Start and current authority fence',async t=>{
  const f=await recoveryFixture(t,true);let calls=0;
  const port=f.service({...f.adapter,inspectRecovery:async(run,command)=>{const o=await f.capability.inspect(run,command);return{...o,receipt:o.receipt?{...o.receipt,state:'waiting'}:null};},recover:async()=>{calls++;return{kind:'busy',evidenceDigest:sha256Digest('probe')};}}).recoveryPort();
  await port.reconcile(f.target,signal());
  assert.equal(calls,0,'B3a forbidden recovery callback count is zero');
});

test('B3a exact receipt before result append',async t=>{
  const f=await recoveryFixture(t,true);
  const s=await f.raw.status(f.run),foreign={...s.receipts.find(r=>r.commandId.startsWith('loop-command:'))!,commandId:'loop-command:'+'f'.repeat(32)};
  const port=f.service({...f.adapter,inspectRecovery:async(run)=>({...await f.capability.inspect(run),receipt:foreign})}).recoveryPort();
  await port.reconcile(f.target,signal());
  assert.equal((await f.db.query<{n:number}>(`SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='result'`)).rows[0]!.n,0,'B3a foreign receipt appends zero results');
});

test('B3a duplicate driver refuses second spawn',async t=>{
  const f=await recoveryFixture(t);let binding:LoopRecoveryBindingV1|undefined;
  const probe=f.service({...f.adapter,recover:async b=>{binding=b;return{kind:'busy',evidenceDigest:sha256Digest('probe')};}}).recoveryPort();
  await probe.reconcile(f.target,signal());assert.ok(binding);
  let spawns=0;const capability={...f.capability,claimDriver:async(_b:Readonly<LoopRecoveryBindingV1>,spawn:()=>Promise<LoopRecoveryChildV1>)=>{spawns++;return{kind:'started' as const,generation:'b'.repeat(32),child:await spawn()};}};
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,recovery:capability}});t.after(()=>adapter.close());
  const first=await adapter.recover!(binding);assert.equal(first.kind,'started');
  const second=await adapter.recover!(binding);if(second.kind==='started')await second.child.close();
  if(first.kind==='started')await first.child.close();
  assert.equal(spawns,1,'B3a one spawn callback across duplicate drivers');
});

test('B3a stopped uncertain changed input refuse acquisition',async t=>{
  const f=await recoveryFixture(t);let calls=0,binding:LoopRecoveryBindingV1|undefined;
  await f.service({...f.adapter,recover:async b=>{binding=b;return{kind:'busy',evidenceDigest:sha256Digest('probe')};}}).recoveryPort().reconcile(f.target,signal());assert.ok(binding);
  const capability={...f.capability,claimDriver:async(_b:Readonly<LoopRecoveryBindingV1>,spawn:()=>Promise<LoopRecoveryChildV1>)=>{calls++;return{kind:'started' as const,generation:'d'.repeat(32),child:await spawn()};}};
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,recovery:capability}});t.after(()=>adapter.close());
  for(const mode of ['stopped','uncertain','input_changed'] as const){f.setMode(mode);const result=await adapter.recover!(binding);if(result.kind==='started')await result.child.close();}
  assert.equal(calls,0,'B3a stopped uncertain changed acquisition count is zero');
});

test('B3a closing owns late acquisition',async()=>{
  let resolveAcquire!:(v:{state:'started';child:LoopRecoveryChildV1})=>void,entered!:()=>void,live=1,closes=0;
  const reached=new Promise<void>(r=>{entered=r;}),acquisition=new Promise<{state:'started';child:LoopRecoveryChildV1}>(r=>{resolveAcquire=r;});
  let done!:()=>void;const child={pid:123,done:new Promise<{code:number|null;signal:NodeJS.Signals|null}>(r=>{done=()=>r({code:0,signal:null});}),close:async()=>{closes++;live=0;done();}};
  const worker=createImproveControlRoomLoopRecoveryV1({enabled:()=>true,createCycle:()=>({tick(){},close:async()=>{}}),port:{scan:async()=>({targets:[{projectId:'project:test',requestId:'request:test',ownerIdentityId:'identity:test'}],nextCursor:null}),reconcile:async()=>{entered();return acquisition;}}});
  const pending=worker.tick();await reached;const close=worker.close();resolveAcquire({state:'started',child});await pending;await close;await worker.close();
  assert.equal(live,0,'B3a no late child after close');assert.equal(closes,1);
});

test('B3a closed worker refuses another tick',async()=>{
  let live=0,admissions=0;
  const child={pid:123,done:new Promise<{code:number|null;signal:NodeJS.Signals|null}>(()=>{}),close:async()=>{live--;}};
  const worker=createImproveControlRoomLoopRecoveryV1({enabled:()=>true,createCycle:()=>({tick(){},close:async()=>{}}),port:{scan:async()=>({targets:[{projectId:'project:test',requestId:'request:test',ownerIdentityId:'identity:test'}],nextCursor:null}),reconcile:async()=>{admissions++;live++;return{state:'started',child};}}});
  await worker.close();await worker.tick();assert.equal(admissions,0,'B3a no child admitted after close');assert.equal(live,0);
});

import { installedI1Gate, i1Regular, i1IsolatedCommand } from './helpers/improve-control-room-loop-finalization';
test('B3a reviewed A2 recovery contract',{skip:process.env.CONTROL_ROOM_B3A_REQUIRE_A2!=='1' ? 'Requires reviewed A2 pins in R and production ownership capability; integration unproven.' : false},async t=>{
  const g=await installedI1Gate(t,'B3a');
  const initial=await g.state();assert.equal(initial.run,g.target.run.loopRunId);
  assert.equal(await g.nativeRead(),null,'B3a owns its run; it never borrows a finalization run');
  const beforeCounters=structuredClone(initial.chain.counters),beforeSteps=initial.steps.length;
  // The private setup must deny the real installed model launch routes, not
  // merely set the product test guard (the entrypoint sanitizes that env).
  assert.equal(typeof g.f.modelLaunchDenials,'function','B3a requires R: executable installed launcher denial probes');
  const denied=await g.f.modelLaunchDenials!();
  assert.ok(Array.isArray(denied)&&denied.length>0,'B3a requires attempted installed model routes');
  for(const probe of denied){
    assert.ok(Array.isArray(probe.argv)&&probe.argv.length>0);
    await i1Regular(probe.argv[0]!,g.root);
    await assert.rejects(readFile(probe.traceFile),{code:'ENOENT'},'model denial probe requires a fresh execution trace');
    const result=await i1IsolatedCommand(g.configuration,probe.argv);
    assert.notEqual(result.exitCode,0,'installed model launch route is denied');
    const trace=JSON.parse(await readFile(await i1Regular(probe.traceFile,g.root),'utf8'));
    assert.ok(trace.attemptedRoutes.length>0);assert.equal(trace.spawnedModelProcesses,0);
  }

  let admissions=0;const driverFailures:unknown[]=[];
  for(let restart=0;restart<3;restart++){
    if(restart)await g.reopen();
    const observation=await g.adapter().inspectRecovery!(g.target.run.loopRunId);
    const bridge=g.bridge(),port=bridge.recoveryPort();
    const worker=createImproveControlRoomLoopRecoveryV1({enabled:()=>true,port:{...port,reconcile:async(target,signal)=>{
      const result=await port.reconcile(target,signal);
      if(result.state==='started'){
        try{
        const deadline=Date.now()+10000;let saved=await g.state();
        while(Date.now()<deadline&&saved.chain.driver?.pid!==result.child.pid){await new Promise(resolve=>setTimeout(resolve,20));saved=await g.state();}
        assert.match(saved.chain.driver?.generation??'',/^[a-f0-9]{32}$/);
        assert.equal(saved.chain.driver.pid,result.child.pid,'B3a real recovery child registers chain.driver');assert.ok(saved.chain.driver.identity);
        assert.equal(saved.run,g.target.run.loopRunId);admissions++;
        }catch(error){driverFailures.push(error);await result.child.close();throw error;}
      }
      return result;
    }},createCycle:()=>({tick(){},close:async()=>{}})});
    try{
      await worker.tick();
      assert.deepEqual(driverFailures,[],"B3a worker must not swallow failed driver assertions");
      assert.equal((await bridge.status(g.f.identity,g.target.projectId,g.target.requestId)).display.runLinkId,g.target.runLinkId);
      const saved=await g.state();assert.deepEqual(saved.chain.counters,beforeCounters,'recovery does not reset limits');
      assert.equal(saved.steps.length,beforeSteps,'denied recovery launches no paid attempt');
      assert.equal(observation.mode,'runnable','B3a prepared recovery run remains runnable with model routes denied');
    }finally{await worker.close();}
    const after=await g.cr(['recovery',g.target.run.loopRunId,'inspect','--json']);
    if(after.driver.record){assert.equal(after.driver.state,'ended');assert.match(after.driver.record.generation,/^[a-f0-9]{32}$/);}
  }
  assert.ok(admissions>0,'B3a must actually start the real recovery worker, never pass with idle scans');
  // R272 uses the owner account. This is honest isolation evidence, not B0
  // worker-account qualification. R6 Phase A is ordered after this gate.
  const r272={noWorkerAccount:true,isolationEvidenceDigest:g.configuration.executionIdentity.isolationEvidenceDigest};
  console.log(`B3a run=${g.target.run.loopRunId} service_restarts=2 real_driver_admissions=${admissions} model_launch_routes_denied=true isolation=R272 r272=${JSON.stringify(r272)}`);
});

import { resultCrashDatabase, exclusiveSyntheticRecoveryCapability } from './helpers/improve-control-room-loop-recovery';
import { ImproveControlRoomDeskServiceV1 } from '../src/improve-control-room/v1/service';
import { createImproveControlRoomHttpHandlerV1 } from '../src/web/v1/improve-control-room-http';
import { origin,trust,request } from './helpers/web-foundation';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertMutationLaneCoverage,reachableTests,workflowCommands } from '../scripts/check-test-lane-coverage.mjs';

test('B3a pending intake and confirm remain owner exact retries',async t=>{
  const f=await s4TaskFixture();t.after(()=>f.db.close());const e=await syntheticRecoveryEngine(t),scope={tenantId:'tenant:web',workspaceId:'workspace:web'},projectId=f.project.projectId;
  // Reuse the normal seed only to establish the self-project presentation.
  await seedRecoveryRun({...f,db:f.client,scope},e,projectId,()=>now);
  const c=syntheticRecoveryCapability(e),adapter=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,recovery:c.capability}});t.after(()=>adapter.close());
  const ordinary=new ImproveControlRoomLoopServiceV1(f.client,scope,{providers:s4ProviderServiceV1(f.client,scope,()=>now),integrityKey:recoveryKey,adapter:e.adapter},()=>now);
  const recovery=new ImproveControlRoomLoopServiceV1(f.client,scope,{providers:s4ProviderServiceV1(f.client,scope,()=>now),integrityKey:recoveryKey,adapter},()=>now).recoveryPort();
  for(const op of ['intake','confirm'] as const){
    const crash=new ImproveControlRoomLoopServiceV1(resultCrashDatabase(f.client,op),scope,{providers:s4ProviderServiceV1(resultCrashDatabase(f.client,op),scope,()=>now),integrityKey:recoveryKey,adapter:e.adapter},()=>now);
    const intakeBody={description:'SYNTHETIC pending exact retry '+op};
    const draft=await(op==='intake'?crash:ordinary).mutate(f.identity,projectId,null,'intake',intakeBody,`b3a-pending-${op}-intake`);
    const id=draft.requestId;let body:unknown=intakeBody;
    if(op==='confirm'){
      const s=await ordinary.status(f.identity,projectId,id);body={expectedVersion:1,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256};
      assert.equal((await crash.mutate(f.identity,projectId,id,'confirm',body,'b3a-pending-confirm-exact')).state,'uncertain');
    }else assert.equal(draft.state,'uncertain');
    const target={projectId,requestId:id,ownerIdentityId:'identity:web'};
    for(let restart=0;restart<2;restart++)assert.equal((await recovery.reconcile(target,signal())).state,'blocked');
    const missingTable=op==='intake'?'control_loop_improvement_run_links':'control_loop_improvement_authorizations';
    assert.equal((await f.db.query<{n:number}>(`SELECT count(*)::int n FROM ${missingTable} WHERE request_id=$1`,[id])).rows[0]!.n,0);
    assert.equal((await f.db.query<{n:number}>(`SELECT count(*)::int n FROM control_loop_improvement_commands WHERE request_id=$1 AND operation=$2 AND entry_kind='result'`,[id,op])).rows[0]!.n,0);
    const key=op==='intake'?`b3a-pending-${op}-intake`:'b3a-pending-confirm-exact';
    const replay=await ordinary.mutate(f.identity,projectId,op==='intake'?null:id,op,body,key);assert.equal(replay.state,'accepted');
    assert.equal((await ordinary.mutate(f.identity,projectId,op==='intake'?null:id,op,body,key)).commandId,replay.commandId);
    assert.equal((await f.db.query<{n:number}>(`SELECT count(*)::int n FROM ${missingTable} WHERE request_id=$1`,[id])).rows[0]!.n,1);
  }
});

test('B3a result interruption reconciles once across two restarts',async t=>{
  const f=await recoveryFixture(t,true),before=JSON.stringify((await f.db.query(`SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind`)).rows);
  const children:LoopRecoveryChildV1[]=[];
  try{
    for(let restart=0;restart<2;restart++){
      const p=f.service().recoveryPort(),result=await p.reconcile(f.target,signal());if(result.state==='started'){children.push(result.child);await result.child.close();}
    }
    const rows=(await f.db.query(`SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind`)).rows;
    assert.equal(rows.length,JSON.parse(before).length+1);assert.ok(JSON.parse(before).every((old:unknown)=>rows.some(row=>JSON.stringify(row)===JSON.stringify(old))));
    assert.equal((await f.traces()).filter(v=>v.op==='start').length,1);
    assert.equal((await f.db.query<{n:number}>(`SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='result'`)).rows[0]!.n,1);
  }finally{await Promise.all(children.map(c=>c.close()));}
});

test('B3a saved owner gate Stop authority and observational reopen',async t=>{
  const f=await recoveryFixture(t);let calls=0;
  const bridge=f.service({...f.adapter,recover:async()=>{calls++;return{kind:'busy',evidenceDigest:sha256Digest('probe')};}}),port=bridge.recoveryPort();
  await f.edit(f.run,{state:'waiting',approval:{step:'plan',inputVersion:1,head:'a'.repeat(40),reportSha256:'b'.repeat(64)}});
  for(let restart=0;restart<2;restart++)assert.equal((await port.reconcile(f.target,signal())).state,'idle');
  assert.equal(calls,0);
  // Positive saved approval evidence may need advance while coarse status waits.
  f.setMode('runnable');f.setAction('advance');await port.reconcile(f.target,signal());assert.equal(calls,1);
  f.setMode('uncertain');
  const desk=new ImproveControlRoomDeskServiceV1(f.client,f.scope,recoveryKey,undefined,()=>now,f.adapter.contract);
  const handler=createImproveControlRoomHttpHandlerV1({origin,trust,service:desk,loopBridge:bridge,clock:()=>now});
  const before=(await f.traces()).filter(v=>['start','wait','advance'].includes(v.op)).length;
  for(let reopen=0;reopen<2;reopen++){
    const response=await handler(request(`/api/v1/projects/${f.projectId}/improvements/loop/${encodeURIComponent(f.id)}/status`));assert.equal(response.status,200);
    const s=await response.json() as {display:{runLinkId:string;canStart:boolean;attention:{code:string}}};assert.equal(s.display.runLinkId,f.link);assert.equal(s.display.canStart,false);assert.equal(s.display.attention.code,'UNAVAILABLE');
  }
  assert.equal((await f.traces()).filter(v=>['start','wait','advance'].includes(v.op)).length,before);
  f.setMode(undefined);await f.edit(f.run,{state:'stopped',approval:null});
  await assert.rejects(port.reconcile(f.target,signal()));assert.equal(calls,1);
  assert.equal((await bridge.status(f.identity,f.projectId,f.id)).display.state,'stopped');
  await f.edit(f.run,{state:'running'});
  for(const edit of ["UPDATE control_role_grants SET revoked_at=now()", "UPDATE control_identities SET state='suspended'"]){
    await f.db.query(edit);await assert.rejects(port.reconcile(f.target,signal()));assert.equal(calls,1);
  }
});

test('B3a bounded scan fair beyond sixteen roots',async t=>{
  const f=await recoveryFixture(t),ids=new Set([f.id]);
  for(let index=1;index<19;index++){
    const saved=await seedRecoveryRun({...f,db:f.client}, {root:f.root,configuration:f.configuration,adapter:f.seedAdapter,raw:f.raw,edit:f.edit,traces:f.traces},f.projectId,()=>now,`b3a-fair-${index}`);
    ids.add(saved.id);
  }
  let cursor=null as import('../src/web/v1/improve-control-room-loop-recovery').LoopRecoveryCursorV1;const seen=new Set<string>();
  for(let pass=0;pass<3;pass++){
    const result=await f.port.scan(cursor,8);assert.ok(result.targets.length<=8);for(const target of result.targets)seen.add(target.requestId);cursor=result.nextCursor;
  }
  assert.equal(cursor,null);assert.deepEqual(seen,ids);assert.equal((await f.port.scan(null,8)).targets.length,8);
  await assert.rejects(f.port.scan(null,9));
});

test('B3a worker four slots nonoverlap disable and drain',async()=>{
  let enabled=true,live=0,max=0,inspecting=0,maxInspecting=0,scans=0,cycles=0;
  const handles=new Map<number,()=>void>();let sequence=0;
  const worker=createImproveControlRoomLoopRecoveryV1({enabled:()=>enabled,createCycle:input=>{cycles++;assert.equal(input.intervalMs,5000);return{tick(){void input.sweep(8);},close:async()=>{}};},port:{
    scan:async()=>{scans++;return{targets:Array.from({length:8},(_,i)=>({projectId:'project:test',requestId:`request:${i}`,ownerIdentityId:'identity:test'})),nextCursor:null};},
    reconcile:async()=>{inspecting++;maxInspecting=Math.max(maxInspecting,inspecting);await new Promise(r=>setTimeout(r,5));inspecting--;live++;max=Math.max(max,live);const id=++sequence;
      let resolve!:(v:{code:number|null;signal:NodeJS.Signals|null})=>void;const done=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(r=>{resolve=r;});
      const close=async()=>{if(handles.delete(id)){live--;resolve({code:0,signal:null});}};handles.set(id,()=>{void close();});return{state:'started',child:{pid:id,done,close}};
    }}});
  worker.start();await Promise.all([worker.tick(),worker.tick()]);assert.equal(scans,1);assert.equal(cycles,1);assert.equal(live,4);assert.equal(max,4);assert.ok(maxInspecting<=4);
  await worker.tick();assert.equal(live,4);enabled=false;await worker.tick();assert.equal(live,0);
  await worker.close();await worker.close();assert.equal(handles.size,0);
  let disabledCycles=0;const disabled=createImproveControlRoomLoopRecoveryV1({enabled:()=>false,createCycle:()=>{disabledCycles++;throw Error();},port:{scan:async()=>{throw Error();},reconcile:async()=>{throw Error();}}});disabled.start();await disabled.close();assert.equal(disabledCycles,0);
});

test('B3a cross-process lock and stale ledger cannot duplicate a live wait',async t=>{
  const f=await recoveryFixture(t),c=await exclusiveSyntheticRecoveryCapability(t,f);
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,recovery:c.capability}});t.after(()=>adapter.close());
  let binding:LoopRecoveryBindingV1|undefined;await f.service({...adapter,recover:async b=>{binding=b;return{kind:'busy',evidenceDigest:sha256Digest('probe')};}}).recoveryPort().reconcile(f.target,signal());assert.ok(binding);
  const first=await adapter.recover!(binding);assert.equal(first.kind,'started');
  try{
    // Independent adapter instance shares only the durable OS fence.
    const contender=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,recovery:c.capability}});t.after(()=>contender.close());
    const result=await contender.recover!(binding);assert.equal(result.kind,'uncertain');
    assert.equal((await f.traces()).filter(v=>v.op==='wait').length<=1,true);
  }finally{if(first.kind==='started')await first.child.close();}
  const deadline=Date.now()+3000;while(Date.now()<deadline){const saved=JSON.parse(await readFile(join(f.root,f.run+'.driver.json'),'utf8'));if(saved.phase==='ended')break;await new Promise(r=>setTimeout(r,5));}
  // A forged PID/unknown field is never proof of an ended driver.
  await writeFile(join(f.root,f.run+'.driver.json'),JSON.stringify({phase:'recorded',pid:process.pid,generation:'a'.repeat(32),foreign:true}));
  const o=await c.capability.inspect(f.run);assert.equal(o.mode,'uncertain');assert.equal(o.action,null);
});

test('B3a registration reaches ordinary Pg and unconditional mutation lanes',async()=>{
  const scripts=JSON.parse(await readFile('package.json','utf8')).scripts,workflow=await readFile('.github/workflows/ci.yml','utf8');
  const ordinary='tests/improve-control-room-loop-recovery.test.ts',pg='tests/improve-control-room-loop-recovery-postgres.test.ts',mutation='tests/improve-control-room-loop-recovery-mutations.test.ts';
  const reached=reachableTests(scripts,workflowCommands(workflow));for(const name of [ordinary,pg,mutation])assert.ok(reached.has(name));
  const components=reachableTests(scripts,['pnpm test:components']);assert.ok(components.has(ordinary));assert.ok(components.has(pg));assert.ok(!components.has(mutation));
  const jobs:Record<string,{steps:{name?:string;if?:boolean|string}[]}>=assertMutationLaneCoverage(scripts,workflow);
  const broken=structuredClone(jobs);
  broken['mutation-checks-candidate'].steps.find(step=>step.name==='Prove interrupted loop recovery guards')!.if=false;
  assert.throws(()=>assertMutationLaneCoverage(scripts,broken),/must be unconditional/,'a conditional recovery step is rejected');
  console.log('B3a negative proof: conditional recovery step rejected; final job dependency accepted');
  assert.match(scripts['test:improve-control-room-loop-attention-browser'],/tests\/browser\/improve-control-room-loop-attention.spec.ts$/);
});

async function recoveryBinding(f:Awaited<ReturnType<typeof recoveryFixture>>){
  let binding:LoopRecoveryBindingV1|undefined;
  await f.service({...f.adapter,recover:async b=>{binding=b;return{kind:'busy',evidenceDigest:sha256Digest('binding probe')};}}).recoveryPort().reconcile(f.target,signal());assert.ok(binding);return binding;
}

test('B3a recovery children separate exits output cap and lifetime',async t=>{
  const f=await recoveryFixture(t),binding=await recoveryBinding(f),behavior=join(f.root,'recovery-behavior.json');
  for(const code of [0,4,2,3]){
    await writeFile(behavior,JSON.stringify({mode:'exit',code}));
    const outcome=await f.adapter.recover!(binding);assert.equal(outcome.kind,'started');if(outcome.kind!=='started')throw Error();
    if(code===0||code===4)assert.equal((await outcome.child.done).code,code);else await assert.rejects(outcome.child.done,{message:'loop_adapter_unavailable'});
    await outcome.child.close();
  }
  for(const mode of ['overflow','signal']){
    await writeFile(behavior,JSON.stringify({mode}));const outcome=await f.adapter.recover!(binding);assert.equal(outcome.kind,'started');if(outcome.kind!=='started')throw Error();await assert.rejects(outcome.child.done,{message:'loop_adapter_unavailable'});await outcome.child.close();
  }
  const {rm}=await import('node:fs/promises');await rm(behavior);
  t.mock.timers.enable({apis:['setTimeout']});
  try{
    const outcome=await f.adapter.recover!(binding);assert.equal(outcome.kind,'started');if(outcome.kind!=='started')throw Error();
    t.mock.timers.tick(3660000);await assert.rejects(outcome.child.done,{message:'loop_adapter_unavailable'});await outcome.child.close();
  }finally{t.mock.timers.reset();}
  const traces=await f.traces();assert.ok(traces.filter(v=>v.op==='wait').every(v=>JSON.stringify(v.args)===JSON.stringify(['--chain','--hours','1'])));
  assert.equal(traces.filter(v=>['resume','stop'].includes(v.op)).length,0);
  console.log('B3a recovery wait exits=0,4,2,3 signal=refused aggregate_output_cap=65536 lifetime_ms=3660000 ordinary_executor_unchanged=true');
});

test('B3a recovery strict evidence callback identity and duplicate callback',async t=>{
  const f=await recoveryFixture(t),binding=await recoveryBinding(f);let calls=0;
  for(const edit of [
    (o:import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryObservationV1)=>({...o,schemaVersion:2}),
    (o:import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryObservationV1)=>({...o,run:{...o.run,loopRunId:'run:foreign'}}),
    (o:import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryObservationV1)=>({...o,unexpected:true}),
    (o:import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryObservationV1)=>({...o,evidenceDigest:''}),
  ]){
    const capability={...f.capability,inspect:async(run:string)=>edit(await f.capability.inspect(run))} as import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryCapabilityV1;
    const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,recovery:capability}});
    try{await assert.rejects(adapter.recover!(binding),{message:'loop_adapter_unavailable'});}finally{await adapter.close();}
  }
  for(const mode of ['duplicate','foreign-child','unknown-outcome'] as const){
    const capability={...f.capability,claimDriver:async(_b:Readonly<LoopRecoveryBindingV1>,spawn:()=>Promise<LoopRecoveryChildV1>)=>{
      calls++;const child=await spawn();
      if(mode==='duplicate')await assert.rejects(spawn());
      return{kind:'started' as const,generation:'e'.repeat(32),child:mode==='foreign-child'?{...child,pid:process.pid}:child,...(mode==='unknown-outcome'?{unexpected:true}:{})};
    }};
    const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,recovery:capability}});
    try{await assert.rejects(adapter.recover!(binding),{message:'loop_adapter_unavailable'});}finally{await adapter.close();}
  }
  assert.equal(calls,3);
  const disabled=createImproveControlRoomLoopAdapterV1(f.configuration);assert.equal(disabled.recover,undefined);assert.equal(disabled.inspectRecovery,undefined);await disabled.close();
  f.setEnabled(false);await assert.rejects(f.adapter.recover!(binding),{message:'loop_adapter_unavailable'});
});

import { crashSyntheticBoundary } from './helpers/improve-control-room-loop-recovery';
test('B3a crash boundary retained result answer and repair evidence survives two service restarts',async t=>{
  const f=await recoveryFixture(t),ledger=join(f.root,f.run+'.sealed-fixture.json');
  const initial={paidLaunchKeys:['job:sealed'],consumedIds:['result:sealed'],answerHashes:[sha256Digest('sealed answer')],rejections:2,mechanismRepairs:1,reviews:2,escalations:0,approach:'writer:original',cloneDispatches:0,redesignApprovals:0,mode:'runnable',action:'wait'};
  const cases:{name:string;patch:Partial<typeof initial>}[]=[
    {name:'journal-claim',patch:{mode:'uncertain'}},{name:'journal-result',patch:{consumedIds:['result:sealed','result:next']}},
    {name:'driver-intent',patch:{mode:'uncertain'}},{name:'driver-spawn',patch:{mode:'uncertain'}},{name:'driver-record',patch:{mode:'uncertain'}},
    {name:'model-intent-prepared',patch:{}},{name:'model-spawn-launching',patch:{paidLaunchKeys:['job:sealed','job:next'],mode:'uncertain'}},
    {name:'model-ledger-record',patch:{paidLaunchKeys:['job:sealed','job:next']}},
    {name:'report-complete',patch:{}},{name:'sidecar-complete',patch:{}},{name:'result-consumed',patch:{consumedIds:['result:sealed','result:next']}},
    {name:'answer-saved',patch:{answerHashes:[sha256Digest('sealed answer'),sha256Digest('next answer')],action:'advance'}},
    {name:'answer-resume-intent',patch:{mode:'uncertain'}},{name:'repair-rejection',patch:{rejections:3}},
    {name:'second-mechanism-repair',patch:{mechanismRepairs:2,mode:'waiting'}},{name:'third-review-threshold',patch:{reviews:3,escalations:1,mode:'waiting'}},
    {name:'replan',patch:{mode:'waiting'}},{name:'escalation',patch:{escalations:1,mode:'waiting'}},
    {name:'clone-dispatch',patch:{cloneDispatches:1,mode:'uncertain'}},{name:'reviewed-approved-redesign',patch:{redesignApprovals:1,action:'advance'}},
    {name:'redesigned-third-owner-wait',patch:{reviews:3,redesignApprovals:1,mode:'waiting'}},
  ];
  const capability={...f.capability,inspect:async(run:string,command?:{commandId:string;bindingDigest:string})=>{
    const observation=await f.capability.inspect(run,command),state=JSON.parse(await readFile(ledger,'utf8')) as typeof initial;
    return{...observation,mode:state.mode as 'runnable'|'waiting'|'uncertain',action:state.mode==='runnable'?state.action as 'wait'|'advance':null,evidenceDigest:sha256Digest(state)};
  }};
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,recovery:capability}});t.after(()=>adapter.close());
  let scenarios=0;
  for(const scenario of cases)for(const side of ['before','after'] as const){
    await writeFile(ledger,JSON.stringify(initial));await crashSyntheticBoundary(f,ledger,scenario.patch,side);
    const expected=side==='after'?{...initial,...scenario.patch}:initial,retained=await readFile(ledger,'utf8');
    assert.deepEqual(JSON.parse(retained),expected,`${scenario.name} ${side} has independent persisted counters`);
    for(let restart=0;restart<2;restart++){
      const reconstructed=f.service(adapter),result=await reconstructed.recoveryPort().reconcile(f.target,signal());
      if(result.state==='started')await result.child.close();
      else assert.ok(['idle','blocked','busy'].includes(result.state));
      assert.equal(await readFile(ledger,'utf8'),retained,`${scenario.name} ${side} restart ${restart} retains sealed evidence byte for byte`);
      const status=await reconstructed.status(f.identity,f.projectId,f.id);assert.equal(status.display.runLinkId,f.link);assert.equal(status.display.canStart,false);
    }
    assert.equal((await f.traces()).filter(v=>v.op==='start').length,1,`${scenario.name} ${side} never repeats Start`);scenarios++;
  }
  console.log(`B3a SYNTHETIC crash boundaries=${scenarios} service_restarts=${scenarios*2} repeated_Start=0 ledger_mutations=0 production_A2_qualification=false`);
});

test('B3a terminal observations remove owner actions and binding stays immutable',async t=>{
  const f=await recoveryFixture(t),binding=await recoveryBinding(f);f.setMode('terminal');
  const status=await f.bridge.status(f.identity,f.projectId,f.id);assert.equal(status.decisions?.gate,null);assert.equal(status.display.canStart,false);assert.equal(status.display.canStop,false);
  f.setMode('runnable');let reached=false;
  const capability={...f.capability,claimDriver:async b=>{reached=true;assert.ok(Object.isFrozen(b));assert.ok(Object.isFrozen(b.run));assert.throws(()=>{(b.run as {loopRunId:string}).loopRunId='run:foreign';});return{kind:'busy' as const,evidenceDigest:sha256Digest('immutable')};}} satisfies import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryCapabilityV1;
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,recovery:capability}});
  try{assert.equal((await adapter.recover!(binding)).kind,'busy');assert.equal(reached,true);}finally{await adapter.close();}
});

test('B3a real startup closes a late recovery child before shared pools',async t=>{
  const f=await taskStartupFixture();t.after(f.close);const e=await syntheticRecoveryEngine(t),clock=()=>instant+7000;
  await seedRecoveryRun(f,e,f.plannerConfig.template.authority.projectId,clock);
  const c=syntheticRecoveryCapability(e);let reached!:()=>void,release!:()=>void,owned:LoopRecoveryChildV1|undefined;
  const entered=new Promise<void>(r=>{reached=r;}),gate=new Promise<void>(r=>{release=r;});
  const capability={...c.capability,claimDriver:async(_b:Readonly<LoopRecoveryBindingV1>,spawn:()=>Promise<LoopRecoveryChildV1>)=>{
    owned=await spawn();reached();await gate;return{kind:'started' as const,generation:'f'.repeat(32),child:owned};
  }};
  const bootstrap=createPrivateTaskBootstrap({openDatabase:f.openDatabase,clock,install:()=>{}});
  const app=await bootstrap.start({...f.config,loopBridge:{integrityKey:recoveryKey,adapter:{...e.configuration,contract:{...e.configuration.contract,recovery:capability}}}});
  try{
    await entered;let closed=false;const closing=app.close().then(()=>{closed=true;});await new Promise<void>(r=>setImmediate(r));
    assert.equal(closed,false);assert.equal(f.web.closes(),0);release();await closing;await app.close();
    assert.ok(owned);await assert.rejects(owned.done,{message:'loop_adapter_unavailable'});
    assert.equal(f.web.closes(),1);assert.equal(f.coordinator.closes(),1);assert.equal((await e.traces()).filter(v=>['stop','resume'].includes(v.op)).length,0);
  }finally{release();await app.close();}
});

test('B3a startup failed installation and disabled capability create no recovery effects',async t=>{
  for(const mode of ['failure','disabled'] as const)await t.test(mode,async t=>{
    const f=await taskStartupFixture();t.after(f.close);const e=await syntheticRecoveryEngine(t),clock=()=>instant+7000;
    await seedRecoveryRun(f,e,f.plannerConfig.template.authority.projectId,clock);
    const c=syntheticRecoveryCapability(e);if(mode==='disabled')c.setEnabled(false);
    const bootstrap=createPrivateTaskBootstrap({openDatabase:f.openDatabase,clock,install:()=>{if(mode==='failure')throw Error('synthetic installation refusal');}});
    const config={...f.config,loopBridge:{integrityKey:recoveryKey,adapter:{...e.configuration,contract:{...e.configuration.contract,recovery:c.capability}}}};
    if(mode==='failure')await assert.rejects(bootstrap.start(config),{message:'private_task_startup_prerequisites_failed'});
    else{const app=await bootstrap.start(config);await app.close();await app.close();}
    assert.equal(f.web.closes(),1);assert.equal(f.coordinator.closes(),1);assert.equal((await e.traces()).filter(v=>['wait','advance','resume','stop'].includes(v.op)).length,0);
  });
});


test('B3a disabled recovery preserves observational status',async t=>{
  const f=await recoveryFixture(t),before=await f.bridge.status(f.identity,f.projectId,f.id);f.setEnabled(false);
  const after=await f.bridge.status(f.identity,f.projectId,f.id);assert.deepEqual(after.display.attention,before.display.attention);assert.deepEqual(after.decisions?.gate,before.decisions?.gate);
  assert.equal((await f.traces()).filter(v=>['advance','wait'].includes(v.op)).length,0);
});

test('B3a interrupted decision and Stop results reconcile without redispatch',async t=>{
  for(const operation of ['approve','answer','stop'] as const)await t.test(operation,async t=>{
    const f=await recoveryFixture(t);let body:Record<string,unknown>={runLinkId:f.link};
    if(operation==='approve'){
      const approval={step:'plan' as const,inputVersion:1,head:'a'.repeat(40),reportSha256:'b'.repeat(64)};await f.edit(f.run,{state:'waiting',approval});
      body={expectedVersion:1,expectedRevision:3,...approval};
    }else if(operation==='answer'){
      const question={questionId:'question:retained',inputVersion:1,reportSha256:'c'.repeat(64),owner:true,changesInput:false};await f.edit(f.run,{state:'waiting',question});
      body={expectedVersion:1,expectedRevision:3,questionId:question.questionId,inputVersion:1,questionReportSha256:question.reportSha256,text:'Use the saved authorized answer.'};
    }
    const key=`b3a-interrupted-${operation}-0001`;
    const crash=new ImproveControlRoomLoopServiceV1(resultCrashDatabase(f.client,operation),f.scope,{providers:s4ProviderServiceV1(resultCrashDatabase(f.client,operation),f.scope,()=>now),integrityKey:recoveryKey,adapter:f.seedAdapter},()=>now);
    const lost=await crash.mutate(f.identity,f.projectId,f.id,operation,body,key);assert.equal(lost.state,'uncertain');
    const displayBridge=f.service({...f.adapter,status:async run=>({...await f.adapter.status(run),decisions:{observedAt:new Date(now).toISOString(),gate:null}})});
    const visible=await displayBridge.status(f.identity,f.projectId,f.id);assert.equal(visible.display.canStart,false);
    if(operation==='stop'){assert.equal(visible.display.state,'stopped');assert.equal(visible.decisions?.gate,null);assert.equal(visible.display.attention?.code,'LAUNCH_UNCERTAIN');}
    else assert.equal(visible.decisions?.gate?.kind,'blocked');
    assert.equal((await f.db.query('SELECT * FROM control_loop_improvement_commands WHERE command_id=$1 AND entry_kind=\'result\'',[lost.commandId])).rows.length,0,'B3a GET never reconciles a pending result');
    const owner=f.service(f.seedAdapter);
    await Promise.allSettled([f.port.reconcile(f.target,signal()),owner.mutate(f.identity,f.projectId,f.id,operation,body,key)]);
    const replay=await owner.mutate(f.identity,f.projectId,f.id,operation,body,key);assert.equal(replay.state,'accepted');assert.equal(replay.commandId,lost.commandId);
    const rows=(await f.db.query(`SELECT * FROM control_loop_improvement_commands WHERE command_id=$1 AND entry_kind='result'`,[lost.commandId])).rows;assert.equal(rows.length,1);
    await Promise.allSettled([f.port.reconcile(f.target,signal())]);
    assert.deepEqual((await f.db.query(`SELECT * FROM control_loop_improvement_commands WHERE command_id=$1 AND entry_kind='result'`,[lost.commandId])).rows,rows);
    assert.equal((await f.traces()).filter(v=>v.op===operation).length,1,`B3a ${operation} is never redispatched`);
  });
});


test('B3a exact eight-root page ends with a null cursor',async t=>{
  const f=await recoveryFixture(t),seedService=f.service(f.seedAdapter);
  for(let index=1;index<8;index++)await seedRecoveryRun({...f,db:f.client},{...f,adapter:f.seedAdapter},f.projectId,()=>now,`b3a-page-${index}`,false,seedService);
  const page=await f.port.scan(null,8);assert.equal(page.targets.length,8);assert.equal(page.nextCursor,null,'B3a exact page EOF wraps without an empty extra tick');
});


test('B3a pending Stop before its effect remains unconfirmed on reopen',async t=>{
  const f=await recoveryFixture(t),owner=f.service({...f.seedAdapter,stop:async()=>{throw Error('SYNTHETIC Stop before-effect interruption');}});
  const lost=await owner.mutate(f.identity,f.projectId,f.id,'stop',{runLinkId:f.link},'b3a-stop-before-effect');assert.equal(lost.state,'uncertain');
  const displayBridge=f.service({...f.adapter,status:async run=>({...await f.adapter.status(run),decisions:{observedAt:new Date(now).toISOString(),gate:null}})});
  for(let reopen=0;reopen<2;reopen++){const s=await displayBridge.status(f.identity,f.projectId,f.id);assert.equal(s.display.attention?.code,'LAUNCH_UNCERTAIN');assert.equal(s.display.attention?.message,'Stop could not be confirmed.');assert.equal(s.decisions?.gate?.kind,'blocked');assert.equal(s.display.canStart,false);}
  assert.equal((await f.port.reconcile(f.target,signal())).state,'blocked');assert.equal((await f.traces()).filter(v=>['stop','wait','advance'].includes(v.op)).length,0);
});


test('B3a current read-only owner grant shows recovery unavailable',async t=>{
  const f=await recoveryFixture(t);await f.db.query(`UPDATE control_role_grants SET allowed_actions='["projects.read"]'`);
  const s=await f.bridge.status(f.identity,f.projectId,f.id);assert.equal(s.display.attention?.code,'UNAVAILABLE');assert.equal(s.decisions?.gate?.kind,'blocked');assert.equal(s.display.canStart,false);assert.equal(s.display.canStop,false);
  let callbacks=0;const port=f.service({...f.adapter,recover:async()=>{callbacks++;return{kind:'busy',evidenceDigest:sha256Digest('authority probe')};}}).recoveryPort();
  await Promise.allSettled([port.reconcile(f.target,signal())]);assert.equal(callbacks,0,'B3a forbidden current-authority callback count is zero');
});


test('B3a R2 readiness failure never starts recovery discovery',async t=>{
  const f=await taskStartupFixture();t.after(f.close);
  const e=await syntheticRecoveryEngine(t),c=syntheticRecoveryCapability(e);
  let scans=0,installed=false;
  const query=f.web.client.query.bind(f.web.client);
  f.web.client.query=(sql,params)=>{if(sql.includes('recovery_has_more'))scans++;return query(sql,params);};
  const bootstrap=createPrivateTaskBootstrap({openDatabase:f.openDatabase,clock:()=>instant+7000,
    install:()=>{installed=true;throw Error('SYNTHETIC install failure');}});
  await assert.rejects(bootstrap.start({...f.config,loopBridge:{integrityKey:recoveryKey,
    adapter:{...e.configuration,contract:{...e.configuration.contract,recovery:c.capability}}}}));
  assert.equal(installed,true);
  assert.equal(scans,0,'B3a no recovery discovery before every readiness gate succeeds');
});

test('B3a R2 recovered result releases only its command files after commit',async t=>{
  const f=await recoveryFixture(t,true);
  const claim=(await f.db.query<{command_id:string}>("SELECT command_id FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0]!;
  const directory=join(f.configuration.workRoot,claim.command_id.replace(':','-'));
  const {access,mkdir}=await import('node:fs/promises');
  await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'answer.txt'),'SYNTHETIC retained command text',{mode:0o600});
  await access(directory);
  const sibling=join(f.configuration.workRoot,'unrelated');await mkdir(sibling);
  let committed=false;
  const port=f.service({...f.adapter,recover:async()=>({kind:'busy',evidenceDigest:sha256Digest('probe')}),
    releaseCommandFiles:async id=>{
      committed=(await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_improvement_commands WHERE command_id=$1 AND entry_kind='result'",[id])).rows[0]!.n===1;
      await f.adapter.releaseCommandFiles!(id);
    }}).recoveryPort();
  await port.reconcile(f.target,signal());
  assert.equal(committed,true,'B3a recovered result commits before releasing command files');
  await assert.rejects(access(directory),{code:'ENOENT'},'B3a recovery reclaims its completed command directory');
  await access(sibling);
});

test('B3a R2 verified terminal status needs no recovery inspection',async t=>{
  const f=await recoveryFixture(t);await f.edit(f.run,{state:'finished'});
  let inspections=0,dispatches=0;
  const port=f.service({...f.adapter,inspectRecovery:async(...args)=>{inspections++;return f.adapter.inspectRecovery!(...args);},
    recover:async()=>{dispatches++;return{kind:'busy',evidenceDigest:sha256Digest('probe')};}}).recoveryPort();
  for(let tick=0;tick<3;tick++)await port.reconcile(f.target,signal());
  assert.equal(inspections,0,'B3a terminal status avoids redundant recovery inspection without a terminal cache');
  assert.equal(dispatches,0);
});

test('B3a R2 verified changed input is shown explicitly',async t=>{
  const f=await recoveryFixture(t);f.setMode('input_changed');
  const status=await f.bridge.status(f.identity,f.projectId,f.id);
  assert.equal(status.display.attention?.code,'INPUT_CHANGED','B3a verified changed input retains its reason');
  assert.equal(status.decisions?.gate?.kind,'blocked');
});

test('B3a R2 ordinary A2 gate reports its missing qualification',async()=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const env={...process.env};delete env.NODE_TEST_CONTEXT;delete env.CONTROL_ROOM_B3A_REQUIRE_A2;delete env.CONTROL_ROOM_B3A_A2_CONTRACT;
  const {stdout}=await promisify(execFile)(process.execPath,['scripts/run-tests-with-quarantine.mjs','--import','tsx','--test',
    '--test-name-pattern=^B3a reviewed A2 recovery contract$','tests/improve-control-room-loop-recovery.test.ts'],{env,timeout:45000});
  assert.match(stdout,/# SKIP .*reviewed A2/i,'B3a ordinary lane explicitly reports A2 qualification absent');
  assert.match(stdout,/# skipped 1/);
  assert.match(stdout,/# pass 0/);
});

test('B3a Stop uses its verified result without a status preflight',async t=>{
  const f=await recoveryFixture(t);let reads=0,stops=0;
  const bridge=f.service({...f.seedAdapter,status:async()=>{reads++;throw Error('SYNTHETIC status connection unavailable');},
    stop:async(...args)=>{stops++;return f.seedAdapter.stop(...args);}});
  const body={runLinkId:f.link},key='b3a-stop-no-preflight';
  const result=await bridge.mutate(f.identity,f.projectId,f.id,'stop',body,key);
  assert.equal(result.state,'accepted','Stop accepts its own verified result without an observational status connection');
  assert.equal(reads,0);assert.equal(stops,1);
  assert.deepEqual(await bridge.mutate(f.identity,f.projectId,f.id,'stop',body,key),{...result,replayed:true});
  assert.equal(stops,1,'exact Stop replay never redispatches');
  assert.equal((await f.raw.status(f.run)).state,'stopped');
  assert.equal((await bridge.mutate(f.identity,f.projectId,f.id,'stop',body,'b3a-stop-already-stopped')).state,'accepted');
  assert.equal(reads,0,'already stopped runs also use the verified Stop result');
});

// Report-only intake has its own owned advancement, before Confirm and Start.
test('B5 completed intake advances once to the desk Confirm gate across service restart', async t => {
  const f=await s4TaskFixture();t.after(()=>f.db.close());
  const e=await syntheticRecoveryEngine(t),scope={tenantId:'tenant:web',workspaceId:'workspace:web'},projectId=f.project.projectId;
  await seedRecoveryRun({...f,db:f.client,scope},e,projectId,()=>now);
  const originalBindings:import('../src/improve-control-room/v1/schemas').LoopBridgeBindingV1[]=[];
  const owner=new ImproveControlRoomLoopServiceV1(f.client,scope,{providers:s4ProviderServiceV1(f.client,scope,()=>now),integrityKey:recoveryKey,adapter:{...e.adapter,intakeDriver:{enabled:()=>false,inspect:async()=>{throw Error('not used');},advance:async()=>{throw Error('not used');}},intake:async(id,b,text,fence)=>{originalBindings.push(b);return e.adapter.intake(id,b,text,fence);}}},()=>now);
  const intake=await owner.mutate(f.identity,projectId,null,'intake',{description:'SYNTHETIC report-only intake'},'b5-completed-intake-0001');
  const local=await owner.status(f.identity,projectId,intake.requestId),run=local.request.runLink!.loopRunId;
  const claim=(await f.client.query<{command_id:string;binding:import('../src/improve-control-room/v1/schemas').LoopBridgeBindingV1}>(`SELECT command_id,binding FROM control_loop_improvement_commands WHERE command_id=$1 AND entry_kind='claim'`,[intake.commandId])).rows[0]!;
  const completed={launch_key:'a'.repeat(32),step:1,job_id:'fixture-job',ended:new Date(now).toISOString(),report_sha256:'b'.repeat(64),proposal_sha256:'c'.repeat(64),task_sha256:'d'.repeat(64)};
  const receiptFile=join(e.root,'intake-receipt.json');let advances=0,enabled=true;
  const savedReceipt=async()=>{try{return JSON.parse(await readFile(receiptFile,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
  const capability:import('../src/web/v1/improve-control-room-loop-adapter').LoopIntakeDriverCapabilityV1={enabled:()=>enabled,
    inspect:async id=>{const s=await e.raw.status(id),receipt=await savedReceipt();return{schemaVersion:1,run:s.run,revision:s.revision,inputVersion:Number(s.inputVersion),requestSha256:claim.binding.requestSha256,settingsSha256:s.settingsSha256,mode:receipt?'advanced':'completed',completedResult:receipt?null:completed,receipt,evidenceDigest:sha256Digest({id,receipt})};},
    advance:async b=>{advances++;assert.deepEqual(b.intakeBinding,originalBindings[0]);assert.equal(b.intakeCommandId,claim.command_id);assert.equal(b.intakeBindingDigest,sha256Digest(originalBindings[0]));assert.equal(b.runLinkId,local.request.runLink!.runLinkId);assert.deepEqual(b.completedResult,completed);assert.equal('authorizationId' in b,false);
      const receipt={command_id:`loop-command:${sha256Digest(b).slice(7,39)}`,binding_digest:sha256Digest(b),completed_result:completed,intake_command_id:b.intakeCommandId,intake_binding:b.intakeBinding,custody:{...scope,projectId,requestId:intake.requestId,ownerIdentityId:'identity:web',localVersion:1,settingsDigest:b.settingsDigest,runLinkId:b.runLinkId},request_sha256:b.requestSha256,settings_sha256:b.settingsSha256,input_version:b.inputVersion,expected_revision:b.expectedRevision,revision:b.expectedRevision+1,at:new Date(now).toISOString(),state:'waiting_owner' as const,attention:'REQUEST_UNCONFIRMED' as const};
      await writeFile(receiptFile,JSON.stringify(receipt));await e.edit(run,{revision:receipt.revision});return{kind:'advanced',receipt,observation:await capability.inspect(run)};}};
  const target={projectId,requestId:intake.requestId,ownerIdentityId:'identity:web'};
  const reopen=()=>{const adapter=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,intakeDriver:capability}});t.after(()=>adapter.close());
    return new ImproveControlRoomLoopServiceV1(f.client,scope,{providers:s4ProviderServiceV1(f.client,scope,()=>now),integrityKey:recoveryKey,adapter:{...adapter,status:async id=>({...await adapter.status(id),decisions:{gate:await savedReceipt()?{kind:'confirm'}:null,observedAt:new Date(now).toISOString()}})}},()=>now);};
  let bridge=reopen();
  await bridge.status(f.identity,projectId,intake.requestId);await bridge.viewDesk(f.identity,projectId);assert.equal(advances,0,'GETs remain observational');
  assert.ok((await bridge.recoveryPort().scan(null,8)).targets.some(v=>v.requestId===intake.requestId),'accepted linked intake is scanned before Start');
  await bridge.recoveryPort().reconcile(target,signal());assert.equal(advances,1);
  assert.deepEqual((await bridge.status(f.identity,projectId,intake.requestId)).decisions?.gate,{kind:'confirm'});
  for(let restart=0;restart<2;restart++){bridge=reopen();await bridge.recoveryPort().reconcile(target,signal());}
  assert.equal(advances,1,'saved native receipt prevents another advance after restart');
  enabled=false;await bridge.recoveryPort().reconcile(target,signal());assert.equal(advances,1);
  assert.equal((await f.client.query<{n:number}>(`SELECT count(*)::int n FROM control_loop_improvement_commands WHERE request_id=$1 AND operation IN ('confirm','start')`,[intake.requestId])).rows[0]!.n,0,'recovery stops at Confirm');
});

test('B5 refused stopped and already-confirmed intake never calls the driver',async t=>{
  const f=await recoveryFixture(t);let calls=0;
  const driver={enabled:()=>true,inspect:async()=>{calls++;throw Error('forbidden intake inspection');},advance:async()=>{calls++;throw Error('forbidden intake advance');}};
  const service=f.service({...f.seedAdapter,intakeDriver:driver});
  await service.recoveryPort().reconcile(f.target,signal());assert.equal(calls,0,'already confirmed');
  const draft=await service.mutate(f.identity,f.projectId,null,'intake',{description:'SYNTHETIC terminal intake'},'b5-terminal-intake-0001');
  const run=(await service.status(f.identity,f.projectId,draft.requestId)).request.runLink!.loopRunId;
  for(const state of ['refused','stopped','finished'] as const){await f.edit(run,{state});await service.recoveryPort().reconcile({...f.target,requestId:draft.requestId},signal());}
  assert.equal(calls,0,'terminal intake never enters driver');
});

test('B5 tools intake contract consumes the product admission envelope and replays its receipt',
  {skip:!process.env.CONTROL_ROOM_B5_INTAKE_CONTRACT?'Requires supplied tools contract path (synthetic invoker; no model launch).':false},async t=>{
  const {pathToFileURL}=await import('node:url');
  const tools=await import(pathToFileURL(process.env.CONTROL_ROOM_B5_INTAKE_CONTRACT!).href);
  const f=await taskFixture();t.after(()=>f.db.close());const e=await syntheticRecoveryEngine(t);
  const scope={tenantId:'tenant:web',workspaceId:'workspace:web'},projectId=f.project.projectId;
  await f.client.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',$2::jsonb) WHERE id=$1`,[projectId,JSON.stringify({schema:'control-room.project-presentation/v1',templateId:'control-room',configurationDigest:'sha256:'+'a'.repeat(64),templateDisplayName:'Control Room',enabledModules:[]})]);
  const completed={launch_key:'a'.repeat(32),step:1,job_id:'fixture-job',ended:new Date(now).toISOString(),report_sha256:'b'.repeat(64),proposal_sha256:'c'.repeat(64),task_sha256:'d'.repeat(64)};
  const receiptFile=join(e.root,'tools-intake-receipt.json');let claims=0;
  const native=async(run:string)=>{
    const s=await e.raw.status(run);let receipt=null;
    try{receipt=JSON.parse(await readFile(receiptFile,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return{schema_version:1,run,revision:s.revision,input_version:Number(s.inputVersion),request_sha256:loopByteHashV1(s.description),settings_sha256:s.settingsSha256,mode:receipt?'advanced':'completed',completed_result:receipt?null:completed,receipt};
  };
  const driver=tools.a2IntakeDriverV1(e.configuration.contract.lineage,e.configuration,async(args:string[])=>{
    const run=args[1]!;
    if(args[2]==='claim'){
      claims++;const expect=JSON.parse(await readFile(args[args.indexOf('--expect')+1]!,'utf8'));
      assert.equal(expect.intake_binding.tenantId,scope.tenantId);assert.equal(expect.intake_binding.projectId,projectId);
      const receipt={command_id:expect.command_id,binding_digest:expect.binding_digest,completed_result:expect.completed_result,
        intake_command_id:expect.intake_command_id,intake_binding:expect.intake_binding,custody:expect.custody,
        request_sha256:expect.request_sha256,settings_sha256:expect.settings_sha256,input_version:expect.input_version,
        expected_revision:expect.revision,revision:expect.revision+1,at:new Date(now).toISOString(),state:'waiting_owner',attention:'REQUEST_UNCONFIRMED'};
      await writeFile(receiptFile,JSON.stringify(receipt));const s=await e.raw.status(run);
      await e.edit(run,{revision:receipt.revision,progress:{...s.progress,attention:'owner'}});
    }
    return{status:0,stdout:JSON.stringify(await native(run))};
  });
  const configuration={...e.configuration,adapterId:tools.A2_BRIDGE_ADAPTER_ID,contract:{...e.configuration.contract,intakeDriver:driver,
    generateRunId:()=> 'b5-tools-intake',decodeStatus:(v:unknown)=>{const s=e.configuration.contract.decodeStatus(v);return{...s,run:{...s.run,adapterId:tools.A2_BRIDGE_ADAPTER_ID}};},
    decisionProjection:{questionTextPath:['counters','questionText'],decodeGate:(_v:unknown,s:import('../src/web/v1/improve-control-room-loop-adapter').LoopEngineStatusV1)=>s.progress.attention==='owner'?{kind:'confirm'}:null}}};
  const raw=createImproveControlRoomLoopAdapterV1(configuration);t.after(()=>raw.close());
  const adapter={...raw,intake:async(id:string,b:import('../src/improve-control-room/v1/schemas').LoopBridgeBindingV1,text:string,fence:()=>void)=>{
    const s=await raw.intake(id,b,text,fence);s.receipts.push({commandId:id,bindingDigest:sha256Digest(b),state:'accepted' as const,error:null,evidenceDigest:sha256Digest({id})});await e.edit(b.loopRunId,s);return s;}};
  const open=()=>new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:recoveryKey,adapter},()=>now);
  let bridge=open();const intake=await bridge.mutate(f.identity,projectId,null,'intake',{description:'SYNTHETIC tools custody integration'},'b5-tools-intake-0001');
  assert.equal(intake.state,'accepted');const target={projectId,requestId:intake.requestId,ownerIdentityId:'identity:web'};
  await bridge.status(f.identity,projectId,intake.requestId);assert.equal(claims,0);
  await Promise.all([bridge.recoveryPort().reconcile(target,signal()),open().recoveryPort().reconcile(target,signal())]);
  assert.equal(claims,1,'competing owners issue only one tools claim');
  bridge=open();await bridge.recoveryPort().reconcile(target,signal());assert.equal(claims,1);
  assert.deepEqual((await bridge.status(f.identity,projectId,intake.requestId)).decisions?.gate,{kind:'confirm'});
  console.log('RESULT B5 tools contract product_envelope=true claims=1 restart_advances=0 gate=confirm model_launches=0');
});

test('B5 recovery sweep logs the original bounded publication cause once',async t=>{
  const {LoopFinalizationFailureV1}=await import('../src/web/v1/improve-control-room-loop-finalization');
  const warnings:unknown[][]=[];
  t.mock.method(console,'warn',(...args:unknown[])=>warnings.push(args));
  const target={projectId:'project:diagnostic',requestId:'request:diagnostic',ownerIdentityId:'owner:diagnostic'};
  const worker=createImproveControlRoomLoopRecoveryV1({enabled:()=>true,
    observe:async()=>{throw new LoopFinalizationFailureV1('PUBLICATION_RECORD_FAILED',new Error('conflict'));},
    port:{scan:async()=>({targets:[target],nextCursor:null}),reconcile:async()=>({state:'blocked'})},
    createCycle:()=>({tick(){},close:async()=>{}})});
  try{await worker.tick();}finally{await worker.close();}
  assert.deepEqual(warnings,[['loop_finalization_sweep_failed','PUBLICATION_RECORD_FAILED','Error','conflict']]);
});
