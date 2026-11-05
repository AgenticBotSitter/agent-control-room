import { S4_FIXTURE_ROUTE, s4FixtureRoutes, s4FixtureContractRoutes, s4ProviderServiceV1, s4TaskFixture } from './helpers/improve-control-room-loop-recovery';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateTaskBootstrap } from '../src/web/v1/private-task-startup';
import { taskStartupFixture } from './helpers/task-startup';
import { monitoringEngine,until } from './helpers/improve-control-room-loop-monitoring';
import { recoveryKey } from './helpers/improve-control-room-loop-recovery';
import { sha256Digest } from '../src/security';

if(process.env.CONTROL_ROOM_B3B_LOAD!=='1')test('B3b refresh without browser',async t=>{
  const f=await taskStartupFixture();t.after(f.close);const e=await monitoringEngine(t);
  const recovery={enabled:()=>true,inspect:async()=>{throw Error('no saved runs');},claimDriver:async()=>({kind:'busy' as const,evidenceDigest:sha256Digest('SYNTHETIC')})};
  const monitoring={enabled:()=>true,decodeStatus:()=>({reasonCode:null,deadline:null,workerState:'none'})};
  const contract=Object.assign({},e.configuration.contract,{recovery,monitoring});
  const bootstrap=createPrivateTaskBootstrap({openDatabase:f.openDatabase,install:()=>{}});
  const app=await bootstrap.start({...f.config,loopBridge:{integrityKey:recoveryKey,adapter:{...e.configuration,contract}}});
  try{
    await until(async()=>(await e.healthTraces()).length>0,1500);
    assert.equal((await e.healthTraces()).length,1,'B3b one collector after readiness with zero runs and no browser');
    await until(async()=>!existsSync(e.configuration.availabilityFile+'.monitor.lock'));
    assert.equal(JSON.parse(await readFile(e.configuration.availabilityFile,'utf8')).schema_version,1);
  }finally{await app.close();}
});

import { mkdir,mkdtemp,writeFile,readFile,rm,chmod,symlink,stat } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { existsSync,readFileSync } from 'node:fs';
import { fork,type ChildProcess } from 'node:child_process';
import type { TestContext } from 'node:test';
import { createImproveControlRoomLoopMonitorV1,decodeLoopHealthV1,loopMonitoringStatusSchemaV1,loopMonitoringAttentionV1,
  type LoopMonitoringClockV1 } from '../src/web/v1/improve-control-room-loop-monitoring';
import { createImproveControlRoomLoopAdapterV1,loopByteHashV1 } from '../src/web/v1/improve-control-room-loop-adapter';

const iso=(ms:number)=>new Date(ms).toISOString();
const payload=(now:number,available=true)=>Buffer.from(JSON.stringify({schema_version:1,checked_at:iso(now),entries:[{model:'SYNTHETIC',route:'new-route',available}]}));
async function fixture(t:TestContext,existingRoot?:string,fileName='health.json'){
  await mkdir(resolve('.test-tmp'),{recursive:true});const root=existingRoot??await mkdtemp(resolve('.test-tmp/b3b-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let wall=Date.parse('2026-10-01T00:00:00.000Z'),mono=0,calls=0,enabledCalls=0,available=true,fail=false,latency=0;
  const file=join(root,fileName);
  const clock:LoopMonitoringClockV1={wallNow:()=>wall,monotonicNow:()=>mono,setTimeout,clearTimeout};
  const configuration={availabilityFile:file,bootstrapHash:'0'.repeat(64),binding:'b'.repeat(64),enabled:()=>{enabledCalls++;return true;},clock,
    collect:async(_signal:AbortSignal,onChild:(pid:number)=>Promise<void>)=>{calls++;await onChild(process.pid);wall+=latency;mono+=latency;if(fail)throw Error('SYNTHETIC failure');return{exitCode:available?0:5,bytes:payload(wall,available)};}};
  const monitor=createImproveControlRoomLoopMonitorV1(configuration);t.after(()=>monitor.close());
  const schedule=async()=>JSON.parse(await readFile(file+'.schedule.json','utf8'));
  async function idle(){await until(async()=>!existsSync(file+'.monitor.lock'));await new Promise<void>(r=>setImmediate(r));}
  // A refresh reads the schedule before it creates the lock and only clears its pending flag after it removes
  // the lock, so idle() alone can return early and the next tick can be dropped. A due tick therefore re-ticks
  // until its refresh shows evidence (lock created, or enabled() consulted beyond the ticks issued here) and
  // then waits for idle(); a tick that is plainly not due returns synchronously and has nothing to wait for.
  let skewed=false;
  function plainlyNotDue(){
    if(skewed||!Number.isFinite(wall))return !Number.isFinite(wall);
    try{const s=JSON.parse(readFileSync(file+'.schedule.json','utf8'));
      return wall<Date.parse(s.nextAttemptAt)&&!(s.checkedAt&&Date.parse(s.checkedAt)>wall)&&!(s.lastAttemptAt&&Date.parse(s.lastAttemptAt)>wall)&&Date.parse(s.nextAttemptAt)<=wall+3031000;
    }catch{return false;}
  }
  let ticks=0;
  async function tick(m=monitor){
    const skip=plainlyNotDue(),before=enabledCalls-ticks;ticks++;m.tick();
    if(!skip){const end=Date.now()+5000;
      while(Date.now()<end&&enabledCalls-ticks<=before&&!existsSync(file+'.monitor.lock')){await new Promise<void>(r=>setTimeout(r,2));ticks++;m.tick();}}
    await idle();
  }
  return{root,file,configuration,monitor,clock,schedule,tick,idle,calls:()=>calls,wall:()=>wall,mono:()=>mono,
    advance(ms:number){wall+=ms;mono+=ms;},rewind(ms:number){skewed=true;wall-=ms;},setWall(ms:number){skewed=true;wall=ms;},fail(v:boolean){fail=v;},available(v:boolean){available=v;},latency(ms:number){latency=ms;}};
}
const ordinary=process.env.CONTROL_ROOM_B3B_LOAD!=='1';
if(ordinary){
  test('B3b monitoring adapter accepts only regular availability descendants',async t=>{
    const e=await monitoringEngine(t);
    const directory=join(e.configuration.configRoot,'config');await mkdir(directory,{mode:0o700});
    const availabilityFile=join(directory,'availability.json');
    await writeFile(availabilityFile,await readFile(e.configuration.availabilityFile),{mode:0o600});
    const contract={...e.configuration.contract,monitoring:{enabled:()=>true,decodeStatus:()=>({reasonCode:null,deadline:null,workerState:'none'})}};
    const configuration={...e.configuration,contract,availabilityFile};
    await t.test('nested availability loads and refreshes beside the file',async()=>{
      const adapter=createImproveControlRoomLoopAdapterV1({...configuration,contract:{...contract,recovery:{enabled:()=>true,
        inspect:async()=>{throw Error('unused');},claimDriver:async()=>({kind:'busy' as const,evidenceDigest:sha256Digest('SYNTHETIC')})}}});
      try{
        assert.equal(typeof adapter.monitoringTick,'function');adapter.monitoringTick!();
        await until(async()=>(await e.healthTraces()).length===1);
        await until(async()=>!existsSync(availabilityFile+'.monitor.lock'));
        assert.equal(JSON.parse(await readFile(availabilityFile,'utf8')).schema_version,1);
        assert.equal(existsSync(availabilityFile+'.schedule.json'),true);
      }finally{await adapter.close();}
    });
    await t.test('outside config root is refused',async()=>{
      const outside=await mkdtemp(resolve('.test-tmp/b3b-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
      const file=join(outside,'availability.json');await writeFile(file,'{}',{mode:0o600});
      assert.throws(()=>createImproveControlRoomLoopAdapterV1({...configuration,availabilityFile:file}),/loop_adapter_unavailable/);
    });
    await t.test('symlinked availability and ancestor are refused',async()=>{
      const file=join(directory,'linked.json'),alias=join(e.configuration.configRoot,'alias');
      await symlink(availabilityFile,file);await symlink(directory,alias,'dir');
      for(const path of [file,join(alias,'availability.json')]){
        assert.throws(()=>createImproveControlRoomLoopAdapterV1({...configuration,availabilityFile:path}),/loop_adapter_unavailable/);
      }
    });
    await t.test('directory availability is refused',async()=>{
      assert.throws(()=>createImproveControlRoomLoopAdapterV1({...configuration,availabilityFile:directory}),/loop_adapter_unavailable/);
    });
  });
  test('B3b normal cadence and one bounded retry',async t=>{
    const f=await fixture(t);await f.tick();assert.equal(f.calls(),1);f.monitor.assertAvailability();
    // tick() admits work asynchronously. An absent lock at this instant does
    // not prove that a premature collector will not be admitted just afterwards.
    const assertNoCollection=async(count:number,message:string)=>{
      const deadline=Date.now()+500;
      do{await new Promise<void>(r=>setTimeout(r,10));assert.equal(f.calls(),count,message);}while(Date.now()<deadline);
      await f.idle();assert.equal(f.calls(),count,message);
    };
    f.advance(2999999);await f.tick();await assertNoCollection(1,'B3b premature collection count remains one');
    f.advance(1);f.fail(true);const old=await readFile(f.file);await f.tick();assert.equal(f.calls(),2);assert.deepEqual(await readFile(f.file),old);
    assert.equal((await f.schedule()).nextKind,'retry');f.advance(299999);await f.tick();await assertNoCollection(2,'B3b retry waits for its due time');
    f.advance(1);await f.tick();assert.equal(f.calls(),3);assert.equal((await f.schedule()).nextKind,'normal');
    f.advance(2999999);await f.tick();await assertNoCollection(3,'B3b exhausted retry waits for normal cadence');f.fail(false);f.advance(1);await f.tick();assert.equal(f.calls(),4);f.monitor.assertAvailability();
  });
  test('B3b three hours retain the freshness margin and recovery retry',async t=>{
    const f=await fixture(t);f.latency(31000);await f.tick();
    for(let hour=0;hour<4;hour++){
      f.advance(3005000);f.monitor.assertAvailability();f.fail(hour===1);await f.tick();
      if(hour===1){f.advance(305000);f.monitor.assertAvailability();f.fail(false);await f.tick();}
      f.monitor.assertAvailability();
    }
    assert.equal(f.calls(),6);assert.equal(3600000-(3005000+31000+305000+31000),228000);
  });
  test('B3b partial unavailable health is published with one retry',async t=>{
    const f=await fixture(t);f.available(false);await f.tick();f.monitor.assertAvailability();
    assert.equal(JSON.parse(await readFile(f.file,'utf8')).entries[0].available,false);assert.equal((await f.schedule()).nextKind,'retry');
    f.advance(300000);await f.tick();assert.equal(f.calls(),2);assert.equal((await f.schedule()).nextKind,'normal');
    for(let i=0;i<10;i++){f.advance(5000);await f.tick();}assert.equal(f.calls(),2);
  });
  test('B3b bootstrap requires exact configured bytes and fresh time',async t=>{
    const f=await fixture(t);const bytes=payload(f.wall());await writeFile(f.file,bytes,{mode:0o600});
    const m=createImproveControlRoomLoopMonitorV1({...f.configuration,bootstrapHash:loopByteHashV1(bytes)});t.after(()=>m.close());
    await f.tick(m);assert.equal(f.calls(),0);assert.equal((await f.schedule()).snapshotHash,loopByteHashV1(bytes));
    f.advance(3000000);await f.tick(m);assert.equal(f.calls(),1);
  });
  test('B3b restart reservations survive twice and reject digest mismatch',async t=>{
    const f=await fixture(t);await f.tick();f.advance(3000000);f.fail(true);await f.tick();
    const s=await f.schedule();s.snapshotHash='a'.repeat(64);await writeFile(f.file+'.schedule.json',JSON.stringify(s),{mode:0o600});
    assert.throws(()=>f.monitor.assertAvailability());
    for(let i=0;i<2;i++){const m=createImproveControlRoomLoopMonitorV1(f.configuration);await f.tick(m);await m.close();assert.equal(f.calls(),2);assert.throws(()=>m.assertAvailability());}
    f.fail(false);f.advance(300000);const m=createImproveControlRoomLoopMonitorV1(f.configuration);await f.tick(m);await m.close();assert.equal(f.calls(),3);m.assertAvailability();
  });
  test('B3b future clock correction publishes and survives two restarts',async t=>{
    const f=await fixture(t);await f.tick();const old=f.wall();f.setWall(old-3*86400000);await f.monitor.close();
    for(let i=0;i<2;i++){
      const m=createImproveControlRoomLoopMonitorV1(f.configuration);await f.tick(m);m.assertAvailability();await m.close();assert.equal(f.calls(),2,'B3b one immediate correction across two restarts');
    }
    assert.equal((await f.schedule()).checkedAt,iso(f.wall()));
  });
  test('B3b continuous rewind uses monotonic due and wake never catches up',async t=>{
    const f=await fixture(t);await f.tick();f.rewind(86400000);f.advance(2999999);await f.tick();assert.equal(f.calls(),1);
    f.advance(1);await f.tick();assert.equal(f.calls(),2);f.monitor.assertAvailability();
    for(const sleep of [2*3600000,24*3600000]){f.advance(sleep);await f.tick();await f.tick();assert.equal((await f.schedule()).nextKind,'normal');}
    assert.equal(f.calls(),4);
  });
  test('B3b invalid clock and foreign state have no collection effects',async t=>{
    const f=await fixture(t);f.setWall(NaN);await f.tick();assert.equal(f.calls(),0);assert.equal(existsSync(f.file+'.schedule.json'),false);
    f.setWall(Date.parse('2026-10-01T00:00:00.000Z'));await f.tick();const s=await f.schedule();s.binding='c'.repeat(64);await writeFile(f.file+'.schedule.json',JSON.stringify(s));
    f.advance(86400000);await f.tick();assert.equal(f.calls(),1);assert.throws(()=>f.monitor.assertAvailability());
  });
  test('B3b dynamic file digest and path refusal',async t=>{
    const f=await fixture(t);await f.tick();await writeFile(f.file,payload(f.wall(),false));
    let accepted=0;try{f.monitor.assertAvailability();accepted++;}catch{}assert.equal(accepted,0,'B3b foreign snapshot accepted zero');
    await rm(f.file);await symlink(join(f.root,'other'),f.file);assert.throws(()=>f.monitor.assertAvailability());
    await rm(f.file);await writeFile(f.file,payload(f.wall()),{mode:0o644});assert.throws(()=>f.monitor.assertAvailability());
  });
  test('B3b close fence and disabled opt in',async t=>{
    const f=await fixture(t);await f.monitor.close();await f.tick();assert.equal(f.calls(),0,'B3b no collection admitted after close');
    for(const enabled of [()=>false,()=>{throw Error('SYNTHETIC');}]){const m=createImproveControlRoomLoopMonitorV1({...f.configuration,enabled});await f.tick(m);await m.close();}
    assert.equal(f.calls(),0);
  });
  test('B3b exclusive collector lock',async t=>{
    const f=await fixture(t);let release!:()=>void,entered!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),barrier=new Promise<void>(r=>{release=r;});let live=0,max=0,calls=0;
    const config={...f.configuration,collect:async(_s:AbortSignal,onChild:(pid:number)=>Promise<void>)=>{calls++;live++;max=Math.max(max,live);await onChild(process.pid);entered();await barrier;live--;return{bytes:payload(f.wall()),exitCode:0};}};
    const a=createImproveControlRoomLoopMonitorV1(config),b=createImproveControlRoomLoopMonitorV1(config);
    try{a.tick();b.tick();await reached;await new Promise<void>(r=>setTimeout(r,100));}
    finally{release();await a.close();await b.close();}
    assert.equal(calls,1,'B3b concurrent collectors equal one');assert.equal(max,1);assert.equal(live,0);
  });
  test('B3b strict health output and bounded safe reason decoding',()=>{
    assert.equal(decodeLoopHealthV1(payload(Date.now(),false),5).entries[0]!.available,false);
    for(const [bytes,code] of [[payload(Date.now()),5],[payload(Date.now()),2],[Buffer.from([255]),0],[Buffer.alloc(65537),0],[Buffer.from('{}'),0]] as const)assert.throws(()=>decodeLoopHealthV1(bytes,code));
    for(const reason of ['LOGIN_REQUIRED','PROVIDER_UNAVAILABLE','TOOL_MISSING','HEALTH_STALE','CLOCK_UNCERTAIN','UNAVAILABLE'] as const){
      const parsed=loopMonitoringStatusSchemaV1.parse({reasonCode:reason,deadline:null,workerState:'uncertain'});assert.ok(loopMonitoringAttentionV1(parsed));
    }
    assert.equal(loopMonitoringStatusSchemaV1.safeParse({reasonCode:'secret <script>',deadline:null,workerState:'none'}).success,false);
    assert.equal(loopMonitoringStatusSchemaV1.safeParse({reasonCode:'DEADLINE_EXCEEDED',deadline:null,workerState:'live'}).success,false);
    const start=Date.parse('2026-01-01T00:00:00.000Z');
    for(const offset of [-1,0,1]){const deadline={attemptId:'SYNTHETIC-attempt',startedAt:iso(start),dueAt:iso(start+1000),state:offset<0?'pending':'exceeded'};
      assert.ok(loopMonitoringStatusSchemaV1.parse({reasonCode:offset<0?null:'DEADLINE_EXCEEDED',deadline,workerState:'live'}));}
  });
  test('B3b no unqualified probe spawn and fixed isolated argv',async t=>{
    const e=await monitoringEngine(t);let enabled=false,disabledObserved=false;
    const recovery={enabled:()=>true,inspect:async()=>{throw Error('unused');},claimDriver:async()=>({kind:'busy' as const,evidenceDigest:sha256Digest('SYNTHETIC')})};
    const adapter=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,recovery,monitoring:{enabled:()=>{if(!enabled)disabledObserved=true;return enabled;},decodeStatus:()=>({reasonCode:null,deadline:null,workerState:'none'})}}});t.after(()=>adapter.close());
    disabledObserved=false;adapter.monitoringTick!();
    await until(async()=>disabledObserved||(await e.healthTraces()).length>0);
    assert.equal((await e.healthTraces()).length,0,'B3b forbidden probe spawn zero');
    enabled=true;adapter.monitoringTick!();await until(async()=>(await e.healthTraces()).length===1);await until(async()=>!existsSync(e.configuration.availabilityFile+'.monitor.lock'));
    const [trace]=await e.healthTraces();assert.deepEqual(trace!.argv,['logins','--json']);assert.deepEqual(Object.keys(trace!.env).filter(k=>k!=='__CF_USER_TEXT_ENCODING').sort(),['LANG','LC_ALL','NODE_ENV']);
    assert.equal((await stat(e.configuration.availabilityFile)).mode&0o777,0o600);assert.equal(adapter.available('start'),true);
    enabled=false;assert.equal(adapter.available('stop'),true,'B3b disabling refreshed health keeps Stop available');
  });
  test('B3b false and throwing monitoring preserve existing availability pins',async t=>{
    const e=await monitoringEngine(t);
    for(const enabled of [()=>false,()=>{throw Error('SYNTHETIC disabled');}]){
      const a=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,
        monitoring:{enabled,decodeStatus:()=>{throw Error('SYNTHETIC must remain inert');}}}});
      try{assert.equal(a.available('start'),true,'B3b disabled monitoring preserves existing availability pins');
        a.monitoringTick!();await new Promise<void>(r=>setTimeout(r,20));assert.equal((await e.healthTraces()).length,0);
      }finally{await a.close();}
    }
  });
  test('B3b actual child malformed output retains bytes and closes held child',async t=>{
    const e=await monitoringEngine(t),old=await readFile(e.configuration.availabilityFile);
    const recovery={enabled:()=>true,inspect:async()=>{throw Error('unused');},claimDriver:async()=>({kind:'busy' as const,evidenceDigest:sha256Digest('SYNTHETIC')})};
    for(const behavior of [{malformed:true},{overflow:true},{invalidUtf8:true},{exit:5},{hold:true,ignoreTerm:true}]){
      await rm(e.configuration.availabilityFile+'.schedule.json',{force:true});await e.behavior(behavior);
      const a=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,recovery,monitoring:{enabled:()=>true,decodeStatus:()=>({reasonCode:null,deadline:null,workerState:'none'})}}});
      const n=(await e.healthTraces()).length;a.monitoringTick!();await until(async()=>(await e.healthTraces()).length>n);
      if(!behavior.hold)await until(async()=>!existsSync(e.configuration.availabilityFile+'.monitor.lock'));
      await a.close();assert.deepEqual(await readFile(e.configuration.availabilityFile),old);
      const pid=(await e.healthTraces()).at(-1)!.pid;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    }
  });
  test('B3b two OS process contenders and positive dead owner recovery',async t=>{
    const f=await fixture(t),children:ChildProcess[]=[];
    const start=()=>{const child=fork(resolve('tests/helpers/improve-control-room-loop-monitoring.ts'),['--b3b-fixture-host',f.root],{execArgv:['--import','tsx'],env:{NODE_ENV:'test',CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'},stdio:['ignore','ignore','pipe','ipc']});children.push(child);return child;};
    const wait=(child:ChildProcess,message:string)=>new Promise<void>((res,rej)=>{const timer=setTimeout(()=>rej(Error('SYNTHETIC host timeout')),4000);const listener=(v:unknown)=>{if(v===message){clearTimeout(timer);child.off('message',listener);res();}};child.on('message',listener);});
    const stop=async(child:ChildProcess)=>{if(child.exitCode!==null||child.signalCode!==null)return;const end=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await end;};
    t.after(async()=>{for(const child of children)await stop(child);});
    const first=start();await wait(first,'collecting');
    // A due saved reservation with a still-owned collector must reach the lock,
    // rather than return through the not-due fast path.
    const due=await f.schedule();due.nextAttemptAt=new Date(Date.now()-1).toISOString();
    await writeFile(f.file+'.schedule.json',JSON.stringify(due));
    const lockBefore=await readFile(f.file+'.monitor.lock');
    const loser=start();await wait(loser,'attempted');
    assert.deepEqual(await readFile(f.file+'.monitor.lock'),lockBefore);
    assert.equal((await readFile(join(f.root,'collectors'),'utf8')).trim().split('\n').length,1);
    await stop(loser);await stop(first);const s=await f.schedule();s.nextAttemptAt=new Date(Date.now()-1000).toISOString();s.lastAttemptAt=new Date(Date.now()-2000).toISOString();await writeFile(f.file+'.schedule.json',JSON.stringify(s));
    const recovered=start();await wait(recovered,'collecting');recovered.send('release');await until(async()=>existsSync(f.file));
    await until(async()=>!existsSync(f.file+'.monitor.lock'));assert.equal(JSON.parse(await readFile(f.file,'utf8')).schema_version,1);
    assert.equal((await readFile(join(f.root,'collectors'),'utf8')).trim().split('\n').length,2);recovered.send('close');await new Promise<void>(r=>recovered.once('exit',()=>r()));
  });
}
if(!ordinary)test('B3b product collector contention',async t=>{
  const db=await s4TaskFixture();t.after(()=>db.db.close());const e=await monitoringEngine(t),scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
  const saved=await seedRecoveryRun({...db,db:db.client,scope},e,db.project.projectId,()=>webNow,'b3b-load-stop');
  const bridge=new ImproveControlRoomLoopServiceV1(db.client,scope,{providers:s4ProviderServiceV1(db.client,scope,()=>webNow),integrityKey:recoveryKey,adapter:e.adapter},()=>webNow);
  const f=await fixture(t,e.root,'availability.json');let calls=0,winner=-1,release!:()=>void,entered!:()=>void;
  const reached=new Promise<void>(r=>{entered=r;});
  const config={...f.configuration,collect:async(signal:AbortSignal,onChild:(pid:number)=>Promise<void>)=>{calls++;await onChild(process.pid);entered();await new Promise<void>(r=>{release=r;signal.addEventListener('abort',()=>r(),{once:true});});return{exitCode:0,bytes:payload(f.wall())};}};
  const monitors=Array.from({length:24},(_,index)=>createImproveControlRoomLoopMonitorV1({...config,collect:async(...args)=>{winner=index;return config.collect(...args);}}));t.after(async()=>{release?.();await Promise.all(monitors.map(m=>m.close()));});
  // All24 enter refresh synchronously with no schedule, before the first async
  // exclusive open can finish and reserve a future due time.
  for(const m of monitors)m.tick();await reached;await new Promise<void>(r=>setTimeout(r,100));
  const losers=monitors.filter((_,index)=>index!==winner);assert.equal(losers.length,23);
  assert.equal(calls,1,'B3b all 23 losing paths preserve one collector');
  const at=performance.now();await Promise.all(losers.slice(0,12).map(m=>m.close()));
  const status=await bridge.status(db.identity,db.project.projectId,saved.id);assert.equal(status.display.canStop,true);
  const stopped=await bridge.mutate(db.identity,db.project.projectId,saved.id,'stop',{runLinkId:saved.link},'b3b-load-stop-0001');assert.equal(stopped.state,'accepted');
  assert.ok(performance.now()-at<2000,'B3b loaded status and Stop complete within two seconds');
  await Promise.all(losers.slice(12).map(m=>m.close()));assert.equal(calls,1,'B3b every losing lock path finished while the winner was held');
  release();await f.idle();assert.equal((await f.schedule()).checkedAt,iso(f.wall()));assert.equal(calls,1);
  f.advance(3000000);const retry=createImproveControlRoomLoopMonitorV1({...f.configuration,collect:async()=>{calls++;throw Error('SYNTHETIC dropped transport');}});await f.tick(retry);assert.equal((await f.schedule()).nextKind,'retry');
  f.advance(300000);await f.tick(retry);assert.equal((await f.schedule()).nextKind,'normal');assert.equal(calls,3);await retry.close();
});

import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {ImproveControlRoomLoopServiceV1} from '../src/web/v1/improve-control-room-loop-service';
import {seedRecoveryRun} from './helpers/improve-control-room-loop-recovery';
import {taskFixture} from './helpers/web-task';
import {now as webNow} from './helpers/web-foundation';
import {loopAttentionComplete,loopAttentionKey,type LoopImprovementDecisionsV1} from '../src/web/v1/improve-control-room-loop-attention-wire';
import {PrivateHeader} from '../private-app/app/private-header';
import {HomeDashboard} from '../private-app/app/home-workspace';
import {LocalRuntimeContextV1} from '../private-app/app/local-runtime';
import {useSharedTaskAttention,refreshSharedTaskAttention} from '../private-app/app/shared-task-attention';
import {ImprovementRunPanel} from '../private-app/app/improvement-run-panel';
function Surfaces(){const attention=useSharedTaskAttention(true);return <LocalRuntimeContextV1.Provider value={{mode:'hosted'}}><PrivateHeader/><HomeDashboard data={{activity:{state:'unavailable'},projects:{state:'unavailable'},connections:{state:'ready',value:{source:'local',value:{taskWorkersStarted:true,workers:[],projectSections:[]}}},attention}}/></LocalRuntimeContextV1.Provider>;}
if(ordinary)test('B3b actual adapter service and rendered attention remain one lower bound',async t=>{
  const f=await s4TaskFixture();t.after(()=>f.db.close());const e=await monitoringEngine(t),scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
  const seeded=await seedRecoveryRun({...f,db:f.client,scope},e,f.project.projectId,()=>webNow,'b3b-render');
  let reason:unknown={reasonCode:'LOGIN_REQUIRED',deadline:null,workerState:'none'},gate:LoopImprovementDecisionsV1['gate']=null,decodes=0;
  const a=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,
    decisionProjection:{questionTextPath:['counters','questionText'],decodeGate:()=>gate},
    monitoring:{enabled:()=>true,decodeStatus:(_raw,status)=>{decodes++;assert.equal(status.run.loopRunId,seeded.run);return reason;}}}});t.after(()=>a.close());
  const service=()=>new ImproveControlRoomLoopServiceV1(f.client,scope,{providers:s4ProviderServiceV1(f.client,scope,()=>webNow),integrityKey:recoveryKey,adapter:a},()=>webNow);
  let bridge=service();
  const attention=async()=>{const source=await bridge.readAttention(f.identity);assert.ok(source.state==='available');return source;};
  const before=await readFile(e.configuration.availabilityFile);
  const keys=new Set<string>();
  for(let i=0;i<10;i++){
    if(i===3||i===7)bridge=service();a.monitoringTick!();const source=await attention();
    assert.equal(source.items.length,1);assert.equal(loopAttentionComplete(source),false,'B3b linked unavailable row remains a lower bound');keys.add(loopAttentionKey(source.items[0]!));
    assert.match(source.items[0]!.summary,/needs sign-in/);assert.equal(source.items[0]!.identity.kind,'blocked');
  }
  assert.equal(keys.size,1);assert.equal((await e.healthTraces()).length,0,'B3b status and attention never collect without recovery activation');
  assert.deepEqual(await readFile(e.configuration.availabilityFile),before);
  const s=await bridge.status(f.identity,f.project.projectId,seeded.id);assert.equal(s.display.attention?.code,'LOGIN_REQUIRED');assert.equal(s.decisions?.gate,null);
  assert.equal(decodes,11,'B3b one monitoring decode per existing status response');
  const dom=new JSDOM('<div id="root"></div>',{url:'https://product.invalid/',pretendToBeVisual:true});
  const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true,
    fetch:async(input:unknown)=>String(input).includes('action-items')?Response.json({observedAt:new Date().toISOString(),items:[],truncated:false,loop:await attention()}):String(input).includes('/needs-me/tasks')?Response.json({items:[],nextCursor:null,examined:0,observedAt:new Date().toISOString(),startsWork:false,planningSource:'configured',deliverySource:'configured',sources:{ordinary:'included',ideas:'not_configured'}}):String(input).includes('/status')?Response.json(s):Response.json({}, {status:404})};
  const descriptors=Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  const root=createRoot(dom.window.document.getElementById('root')!);
  const settle=async()=>{for(let i=0;i<8;i++)await act(async()=>{await new Promise<void>(r=>setTimeout(r,10));});};
  try{
    await act(async()=>root.render(<Surfaces/>));await settle();
    assert.equal(dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,'1+');
    assert.match(dom.window.document.body.textContent!,/Check saved request/);
    reason={reasonCode:null,deadline:null,workerState:'none'};await act(async()=>{await refreshSharedTaskAttention(true);});await settle();
    assert.equal((await attention()).items.length,0);assert.equal(loopAttentionComplete(await attention()),true);
    assert.equal(dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,'0');
    reason={reasonCode:'LOGIN_REQUIRED',deadline:null,workerState:'none'};await act(async()=>{await refreshSharedTaskAttention(true);});await settle();
    assert.equal(dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,'1+');
    await act(async()=>root.render(<ImprovementRunPanel projectId={f.project.projectId} requests={[s.request]} fresh={true}/>));await settle();
    assert.match(dom.window.document.body.textContent!,/The configured route needs sign-in/);assert.match(dom.window.document.body.textContent!,/approved account setup/);
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
  for(const code of ['QUESTION_LIMIT','INPUT_CHANGED'] as const){gate={kind:'blocked',code,message:'SYNTHETIC existing priority'};const source=await attention();assert.equal(source.items[0]!.identity.kind,'blocked');assert.equal((source.items[0]!.identity as {code:string}).code,code);assert.doesNotMatch(source.items[0]!.summary,/sign-in/);}
  gate=null;reason={reasonCode:'<script>secret</script>',deadline:null,workerState:'none'};
  assert.match((await attention()).items[0]!.summary,/could not be verified/);assert.doesNotMatch(JSON.stringify(await attention()),/script|secret/);
  const state=await e.raw.status(seeded.run);for(const terminal of ['stopped','finished'] as const){await e.edit(seeded.run,{...state,state:terminal});assert.equal((await attention()).items.length,0);}
  const foreign={...f.identity,subject:'identity:foreign'};await assert.rejects(bridge.status(foreign,f.project.projectId,seeded.id));
});

if(ordinary)test('B3b aggregate timeout TERM grace KILL and no timers after reap',async t=>{
  const e=await monitoringEngine(t);await e.behavior({hold:true,ignoreTerm:true});
  let mono=0,next=0;const timers=new Map<number,{due:number;run:()=>void}>();
  const clock:LoopMonitoringClockV1={wallNow:Date.now,monotonicNow:()=>mono,
    setTimeout:((run:()=>void,ms:number)=>{const id=++next;timers.set(id,{due:mono+ms,run});return id;}) as unknown as typeof setTimeout,
    clearTimeout:((id:number)=>{timers.delete(id);}) as unknown as typeof clearTimeout};
  const advance=(ms:number)=>{mono+=ms;for(const[id,timer]of [...timers])if(timer.due<=mono){timers.delete(id);timer.run();}};
  const recovery={enabled:()=>true,inspect:async()=>{throw Error('unused');},claimDriver:async()=>({kind:'busy' as const,evidenceDigest:sha256Digest('SYNTHETIC')})};
  const a=createImproveControlRoomLoopAdapterV1({...e.configuration,monitoringClock:clock,contract:{...e.configuration.contract,recovery,monitoring:{enabled:()=>true,decodeStatus:()=>({reasonCode:null,deadline:null,workerState:'none'})}}});t.after(()=>a.close());
  a.monitoringTick!();await until(async()=>(await e.healthTraces()).length===1);await new Promise<void>(r=>setTimeout(r,30));const pid=(await e.healthTraces())[0]!.pid;
  advance(29999);assert.equal(timers.size,1);assert.doesNotThrow(()=>process.kill(pid,0));
  advance(1);await new Promise<void>(r=>setTimeout(r,20));assert.doesNotThrow(()=>process.kill(pid,0));
  advance(999);assert.doesNotThrow(()=>process.kill(pid,0));advance(1);
  await until(async()=>!existsSync(e.configuration.availabilityFile+'.monitor.lock'));await a.close();
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(timers.size,0);assert.equal(await readFile(e.configuration.availabilityFile,'utf8'),'{}');
});

if(ordinary)test('B3b status and Stop stay responsive during collection and disable drains',async t=>{
  const f=await s4TaskFixture();t.after(()=>f.db.close());const e=await monitoringEngine(t),scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
  const saved=await seedRecoveryRun({...f,db:f.client,scope},e,f.project.projectId,()=>webNow,'b3b-stop-held');
  await e.behavior({hold:true,ignoreTerm:true});let enabled=true;
  const recovery={enabled:()=>true,inspect:async()=>{throw Error('SYNTHETIC unavailable');},claimDriver:async()=>({kind:'busy' as const,evidenceDigest:sha256Digest('SYNTHETIC')})};
  const a=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,recovery,monitoring:{enabled:()=>enabled,decodeStatus:()=>({reasonCode:'PROVIDER_UNAVAILABLE',deadline:null,workerState:'live'})}}});t.after(()=>a.close());
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,scope,{providers:s4ProviderServiceV1(f.client,scope,()=>webNow),integrityKey:recoveryKey,adapter:a},()=>webNow);
  a.monitoringTick!();await until(async()=>(await e.healthTraces()).length===1);
  const at=performance.now();const s=await bridge.status(f.identity,f.project.projectId,saved.id);assert.equal(s.display.canStop,true);
  const stopped=await bridge.mutate(f.identity,f.project.projectId,saved.id,'stop',{runLinkId:saved.link},'b3b-stop-held-0001');assert.ok(['accepted','uncertain'].includes(stopped.state));
  assert.ok(performance.now()-at<2000,'B3b status and Stop complete within two seconds');
  assert.equal((await a.status(saved.run)).state,'stopped');enabled=false;a.monitoringTick!();await a.close();
  const pid=(await e.healthTraces())[0]!.pid;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal(existsSync(e.configuration.availabilityFile+'.monitor.lock'),false);
});

// Byte-for-byte cr status --json captures from current native tools (synthetic dry
// launcher fixture only). No installed tooling or provider is needed in this lane.
const nativeStatusCaptures = [
  "{\"schema_version\": 1, \"run\": \"synth\", \"state\": \"ready\", \"revision\": 0, \"next\": null, \"attention\": null, \"steps\": [], \"counters\": {}, \"error\": null, \"request\": {\"input_version\": 1, \"sha256\": \"aa713bf668f62358c1931409e87daab4ab3671c14c7153dd4c2c1b08d25ebadf\", \"text\": \"SYNTHETIC exact owner request for saved chaining.\\n\", \"settings_sha256\": null, \"confirmation\": {\"sha256\": \"aa713bf668f62358c1931409e87daab4ab3671c14c7153dd4c2c1b08d25ebadf\", \"at\": \"2026-10-29T23:21:00.946578+00:00\", \"who\": \"owner\", \"input_version\": 1, \"path\": \"docs/request-source.md\"}, \"approval\": null, \"question\": null, \"admissions\": []}, \"clock\": \"ok\", \"deadline\": null}\n",
  "{\"schema_version\": 1, \"run\": \"synth\", \"state\": \"running\", \"revision\": 2, \"next\": {\"role\": \"plan\"}, \"attention\": null, \"steps\": [{\"n\": 1, \"role\": \"plan\", \"model\": \"writer\", \"state\": \"running\", \"detail\": \"0 min (stop: cr stop <run>)\", \"stale\": null, \"attempt\": 1, \"identity\": {\"requested\": \"writer\", \"observed\": null, \"status\": \"unverified\"}}], \"counters\": {\"sendbacks\": 0, \"escalations\": 0, \"provider_retries\": 0, \"limits\": {\"configured\": 3, \"effective\": 3}, \"approaches\": {\"plan\": {\"approach\": 1, \"rejections\": {}}}}, \"error\": null, \"request\": {\"input_version\": 1, \"sha256\": \"aa713bf668f62358c1931409e87daab4ab3671c14c7153dd4c2c1b08d25ebadf\", \"text\": \"SYNTHETIC exact owner request for saved chaining.\\n\", \"settings_sha256\": \"cd5420d1da89620690d8315c213fa00dd14167c256ed8fb3b9d267b8fc5d2dde\", \"confirmation\": {\"sha256\": \"aa713bf668f62358c1931409e87daab4ab3671c14c7153dd4c2c1b08d25ebadf\", \"at\": \"2026-10-29T23:18:52.594084+00:00\", \"who\": \"owner\", \"input_version\": 1, \"path\": \"docs/request-source.md\"}, \"approval\": null, \"question\": null, \"admissions\": []}, \"clock\": \"ok\", \"deadline\": {\"attempt\": \"c662c7a7c5a04f2694ca641d758dcc30\", \"started_at\": \"2026-10-29T23:18:53.060638+00:00\", \"due_at\": \"2026-10-29T23:19:53.060638+00:00\", \"state\": \"pending\", \"worker\": \"live\"}}\n",
  "{\"schema_version\": 1, \"run\": \"synth\", \"state\": \"running\", \"revision\": 2, \"next\": {\"role\": \"plan\"}, \"attention\": null, \"steps\": [{\"n\": 1, \"role\": \"plan\", \"model\": \"writer\", \"state\": \"running\", \"detail\": \"0 min (stop: cr stop <run>)\", \"stale\": null, \"attempt\": 1, \"identity\": {\"requested\": \"writer\", \"observed\": null, \"status\": \"unverified\"}}], \"counters\": {\"sendbacks\": 0, \"escalations\": 0, \"provider_retries\": 0, \"limits\": {\"configured\": 3, \"effective\": 3}, \"approaches\": {\"plan\": {\"approach\": 1, \"rejections\": {}}}}, \"error\": null, \"request\": {\"input_version\": 1, \"sha256\": \"aa713bf668f62358c1931409e87daab4ab3671c14c7153dd4c2c1b08d25ebadf\", \"text\": \"SYNTHETIC exact owner request for saved chaining.\\n\", \"settings_sha256\": \"cd5420d1da89620690d8315c213fa00dd14167c256ed8fb3b9d267b8fc5d2dde\", \"confirmation\": {\"sha256\": \"aa713bf668f62358c1931409e87daab4ab3671c14c7153dd4c2c1b08d25ebadf\", \"at\": \"2026-10-29T23:18:52.594084+00:00\", \"who\": \"owner\", \"input_version\": 1, \"path\": \"docs/request-source.md\"}, \"approval\": null, \"question\": null, \"admissions\": []}, \"clock\": \"uncertain\", \"deadline\": {\"attempt\": \"c662c7a7c5a04f2694ca641d758dcc30\", \"started_at\": \"2026-10-29T23:18:53.060638+00:00\", \"due_at\": \"2026-10-29T23:19:53.060638+00:00\", \"state\": \"pending\", \"worker\": \"uncertain\"}}\n"
];
// Frozen reviewed a2MonitoringV1 + utcInstant and their exact wire helpers.
const reviewedMonitoringSource = [
  "const RUN = /^[a-z0-9][a-z0-9-]{2,40}$/;  // A2 NAME and the product identity length",
  "const HEX64 = /^[a-f0-9]{64}$/, HEX40 = /^[a-f0-9]{40}$/, HEX32 = /^[a-f0-9]{32}$/;",
  "const unavailable = () => new Error(\"loop_adapter_unavailable\");",
  "const need = condition => { if (!condition) throw unavailable(); };",
  "const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);",
  "const plain = value => value !== null && typeof value === \"object\" && !Array.isArray(value)",
  "  && [Object.prototype, null].includes(Object.getPrototypeOf(value));",
  "const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));",
  "const match = (pattern, value) => typeof value === \"string\" && pattern.test(value);",
  "export function utcInstant(value) {",
  "  const m = typeof value === \"string\"",
  "    && /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d{1,9})?(Z|([+-])(\\d{2}):(\\d{2}))$/.exec(value);",
  "  need(m);",
  "  const [, y, mo, d, h, mi, s, fraction = \"\", zone, sign, oh, om] = m;",
  "  const local = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);",
  "  const at = new Date(local - (zone === \"Z\" ? 0 : (sign === \"-\" ? -1 : 1) * (+oh * 60 + +om) * 60000));",
  "  need(!Number.isNaN(at.getTime()) && new Date(local).toISOString().slice(0, 19) === `${y}-${mo}-${d}T${h}:${mi}:${s}`",
  "    && (zone === \"Z\" || +oh <= 23 && +om <= 59));",
  "  return `${at.toISOString().slice(0, 19)}${fraction}Z`;",
  "}",
  "export function a2MonitoringV1(flag) {",
  "  need(flag === true);",
  "  return Object.freeze({ enabled: () => flag, decodeStatus(raw, status) {",
  "    need(plain(raw) && raw.schema_version === 1 && plain(status) && plain(status.run)",
  "      && match(RUN, raw.run) && raw.run === status.run.loopRunId",
  "      && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && raw.revision === status.revision",
  "      && [\"ok\", \"uncertain\"].includes(raw.clock) && own(raw, \"deadline\"));",
  "    const d = raw.deadline;",
  "    let deadline = null, workerState = \"none\";",
  "    if (d !== null) {",
  "      need(exact(d, [\"attempt\", \"started_at\", \"due_at\", \"state\", \"worker\"]) && match(HEX32, d.attempt)",
  "        && [\"pending\", \"exceeded\"].includes(d.state) && [\"live\", \"ended\", \"uncertain\"].includes(d.worker));",
  "      // A2 stores offset ISO instants with microseconds; the product requires canonical millisecond UTC.",
  "      const startedAt = new Date(utcInstant(d.started_at)).toISOString(), dueAt = new Date(utcInstant(d.due_at)).toISOString();",
  "      need(Date.parse(dueAt) > Date.parse(startedAt));",
  "      deadline = { attemptId: d.attempt, startedAt, dueAt, state: d.state };",
  "      workerState = d.worker;",
  "    }",
  "    return { reasonCode: raw.clock === \"uncertain\" ? \"CLOCK_UNCERTAIN\"",
  "      : deadline?.state === \"exceeded\" ? \"DEADLINE_EXCEEDED\" : null, deadline, workerState };",
  "  } });",
  "}"
].join('\n');
if(ordinary)test('adapter decodes the current native envelope',async t=>{
  const e=await monitoringEngine(t);
  const reviewed=await import('data:text/javascript;base64,'+Buffer.from(reviewedMonitoringSource).toString('base64'));
  const monitoring=reviewed.a2MonitoringV1(true);
  const status={run:{adapterId:e.configuration.adapterId,loopRunId:'synth',toolingRevision:e.configuration.toolingRevision,a2SchemaVersion:1 as const},
    revision:0,inputVersion:1,state:'running' as const,description:'SYNTHETIC native envelope',settingsSha256:e.configuration.settingsSha256,
    settingsDigest:e.configuration.settingsSha256,confirmation:null,approval:null,question:null,
    progress:{step:null,completed:0,attention:'none' as const},receipts:[]};
  async function decode(bytes:string,monitored=true){
    // Replay the captured stdout through an actual isolated adapter child.
    const source='import sys\nsys.stdout.write('+JSON.stringify(bytes)+')\n';
    await writeFile(e.configuration.entrypoint,source);
    const adapter=createImproveControlRoomLoopAdapterV1({...e.configuration,entrypointSha256:loopByteHashV1(source),
      contract:{...e.configuration.contract,decodeStatus:(raw:unknown)=>({...status,revision:(raw as {revision:number}).revision}),
        monitoring:monitored?monitoring:undefined}});
    try{return await adapter.status('synth');}finally{await adapter.close();}
  }
  const empty=await decode(nativeStatusCaptures[0]!);assert.equal(empty.monitoring?.deadline,null);
  const live=await decode(nativeStatusCaptures[1]!);assert.equal(live.monitoring?.workerState,'live');assert.equal(live.monitoring?.deadline?.state,'pending');
  assert.equal((await decode(nativeStatusCaptures[2]!)).monitoring?.reasonCode,'CLOCK_UNCERTAIN');
  // Non-monitoring carriers receive the same native fields.
  assert.equal((await decode(nativeStatusCaptures[1]!,false)).monitoring,undefined);
  const raw=JSON.parse(nativeStatusCaptures[1]!);
  assert.equal(live.monitoring?.deadline?.attemptId,raw.deadline.attempt);
  assert.equal(live.monitoring?.deadline?.dueAt,new Date(raw.deadline.due_at).toISOString());
  const {clock:_clock,deadline:_deadline,...legacy}=raw;
  assert.equal((await decode(JSON.stringify(legacy),false)).monitoring,undefined,'legacy envelopes remain admitted');
  const {worker:_worker,...missing}=raw.deadline;
  for(const bad of [{...raw,extra:true},{...raw,clock:'bad'},{...raw,deadline:{...raw.deadline,extra:true}},
    {...raw,deadline:missing},{...raw,deadline:{...raw.deadline,state:'late'}},
    {...raw,deadline:{...raw.deadline,attempt:'x'.repeat(181)}}]){
    await assert.rejects(decode(JSON.stringify(bad)),/loop_adapter_unavailable/);
  }
  // The outer admission must still defer content/timestamp validation to A2.
  assert.equal((await decode(JSON.stringify({...raw,deadline:{...raw.deadline,due_at:'bad'}}))).monitoring?.reasonCode,'UNAVAILABLE');
});

import { dirname,isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstatSync,realpathSync } from 'node:fs';
if(ordinary)test('B3b reviewed A2 monitoring contract',{
  skip:process.env.CONTROL_ROOM_B3B_REQUIRE_A2!=='1'?'Requires reviewed A2 monitoring pins in R; integration unproven.':false,
},async()=>{
  const path=process.env.CONTROL_ROOM_B3B_A2_CONTRACT;
  assert.ok(path&&isAbsolute(path),'B3b requires R: absolute CONTROL_ROOM_B3B_A2_CONTRACT');
  assert.equal(resolve(path),path);
  assert.doesNotMatch(path,/(?:^|[/\\])(?:\.env(?:\.[^/]*)?|\.aws|\.codex|\.hermes|auth\.json|credentials|tokens?)(?:[/\\]|$)/iu);
  for(let part=path;;part=dirname(part)){
    assert.equal(lstatSync(part).isSymbolicLink(),false,'B3b refuses symlinked module paths');
    if(part===dirname(part))break;
  }
  assert.equal(realpathSync(path),path);assert.equal(lstatSync(path).isFile(),true);
  const phase=process.env.CONTROL_ROOM_B3B_A2_PHASE;
  assert.ok(phase==='denied'||phase==='active','B3b requires an explicit denied or active phase');
  const module=await import(pathToFileURL(path).href);
  assert.equal(typeof module.qualifyB3bMonitoring,'function');
  const proof=await module.qualifyB3bMonitoring({createPrivateTaskBootstrap,createImproveControlRoomLoopAdapterV1,
    decodeLoopHealthV1,loopMonitoringStatusSchemaV1},{phase});
  assert.equal(proof.reviewed,true);
  for(const key of ['toolingRevision','schemaDigest'])assert.match(proof[key],/^sha256:[a-f0-9]{64}$/);
  for(const key of ['entrypointSha256','moduleSha256'])assert.match(proof[key],/^[a-f0-9]{64}$/);
  assert.equal(proof.paidAttempts,0);
  if(phase==='active'){
    assert.equal(proof.serviceRestarts,2);assert.equal(proof.staleRefusals,0);
    assert.equal(proof.dispatchesThroughRefreshed,1);assert.equal(proof.overdueFacts,1);assert.equal(proof.countersChanged,false);
  }
});
