import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import { spawn,execFile,type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { withRealPostgres,requiresRealPostgres } from './support/attack-kit/index';
import { syntheticRecoveryEngine,syntheticRecoveryCapability,seedRecoveryRun,seedRecoveryPostgres,pgRecoveryIdentity,pgRecoveryScope,pgRecoveryProject,pgRecoveryOwner,recoveryPgWeb,recoveryKey,resultCrashDatabase } from './helpers/improve-control-room-loop-recovery';
import { createImproveControlRoomLoopAdapterV1 } from '../src/web/v1/improve-control-room-loop-adapter';
import { ImproveControlRoomLoopServiceV1 } from '../src/web/v1/improve-control-room-loop-service';
import { sha256Digest } from '../src/security';
import { readPrivateWebSchemaDigest } from '../src/web/v1/private-database-preflight';
import { resolve,join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ImproveControlRoomDeskServiceV1 } from '../src/improve-control-room/v1/service';
const PORT=Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE??60320);
type Pg=Parameters<Parameters<typeof withRealPostgres>[0]>[0];
async function run(work:(pg:Pg)=>Promise<void>){
  assert.ok(requiresRealPostgres(),'B3a requires PostgreSQL17; no skip');
  const result=await withRealPostgres(work,{port:PORT,allowedPorts:Array.from({length:10},(_,i)=>PORT+i),database:'b3a_recovery',boundMs:500000});
  assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);console.log('B3a PostgreSQL teardown cleanedUp=true leftovers=0');
}
const signal=()=>new AbortController().signal;
// Linux keeps the exact kernel argv; hosts without /proc (macOS) ask ps for the same command line.
const processCommand=async(pid:number)=>process.platform==='linux'?readFile(`/proc/${pid}/cmdline`,'utf8'):(await promisify(execFile)('ps',['-ww','-o','command=','-p',String(pid)])).stdout;

test('B3a production login admission journal receipts and pending exact retries',async t=>run(async pg=>{
  let identity=pgRecoveryIdentity();await seedRecoveryPostgres(pg.admin(),identity);
  const e=await syntheticRecoveryEngine(t),c=syntheticRecoveryCapability(e),adapter=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,recovery:c.capability}});t.after(()=>adapter.close());
  const web=recoveryPgWeb(pg.connection('web'),adapter),owner=recoveryPgWeb(pg.connection('web'),e.adapter);t.after(()=>web.close());t.after(()=>owner.close());
  assert.deepEqual((await web.client.query('SELECT session_user,current_user')).rows,[{session_user:'control_room_web',current_user:'control_room_web'}]);
  const admin=new Client(pg.admin());await admin.connect();
  try{
    const schema=await readPrivateWebSchemaDigest(web.client);
    const saved=await seedRecoveryRun({db:owner.client,scope:pgRecoveryScope,identity},e,pgRecoveryProject,Date.now,'b3a-pg-seed',true);
    const target={projectId:pgRecoveryProject,requestId:saved.id,ownerIdentityId:pgRecoveryOwner};
    // Expired/revoked browser sessions do not manufacture background authority.
    const sessions=(await web.client.query('SELECT count(*)::int n FROM control_web_sessions')).rows[0]!.n;
    await admin.query('UPDATE control_web_sessions SET revoked_at=now()');
    let recoveries=0;const probe=new ImproveControlRoomLoopServiceV1(web.client,pgRecoveryScope,{integrityKey:recoveryKey,adapter:{...adapter,recover:async()=>{recoveries++;return{kind:'busy',evidenceDigest:sha256Digest('probe')};}}});
    const before=(await web.client.query(`SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind`)).rows;
    for(let restart=0;restart<2;restart++)await probe.recoveryPort().reconcile(target,signal());
    assert.equal(recoveries,2);assert.equal((await web.client.query('SELECT count(*)::int n FROM control_web_sessions')).rows[0]!.n,sessions);
    const after=(await web.client.query(`SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind`)).rows;
    assert.equal(after.length,before.length+1);for(const row of before)assert.ok(after.some(r=>JSON.stringify(r)===JSON.stringify(row)));
    assert.equal(await readPrivateWebSchemaDigest(web.client),schema);
    assert.equal((await web.client.query(`SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='result'`)).rows[0]!.n,1);
    for(const change of [
      "UPDATE control_role_grants SET revoked_at=now()",
      "UPDATE control_role_grants SET expires_at=now()-interval '1 second'",
      "UPDATE control_role_grants SET risk_ceiling='low'",
      "UPDATE control_role_grants SET allowed_actions='[\"projects.read\"]'",
      "UPDATE control_role_grants SET project_ids='[\"project:foreign\"]'",
      "UPDATE control_identities SET state='suspended'",
      "UPDATE control_manual_project_heads SET lifecycle='archived'",
    ]){
      await admin.query('BEGIN');try{await admin.query(change);await admin.query('COMMIT');await assert.rejects(probe.recoveryPort().reconcile(target,signal()));assert.equal(recoveries,2);}
      finally{await admin.query("UPDATE control_role_grants SET revoked_at=NULL,expires_at=NULL,risk_ceiling='critical',allowed_actions='[\"*\"]',project_ids='[\"*\"]'");await admin.query("UPDATE control_identities SET state='active'");await admin.query("UPDATE control_manual_project_heads SET lifecycle='active'");}
    }
    for(const foreign of [{...target,projectId:'project:foreign'},{...target,ownerIdentityId:'identity:foreign'}])await assert.rejects(probe.recoveryPort().reconcile(foreign,signal()));
    const foreignScope=new ImproveControlRoomLoopServiceV1(web.client,{tenantId:'tenant:foreign',workspaceId:pgRecoveryScope.workspaceId},{integrityKey:recoveryKey,adapter});assert.deepEqual((await foreignScope.recoveryPort().scan(null,8)).targets,[]);
    const wrongWorkspace=new ImproveControlRoomLoopServiceV1(web.client,{...pgRecoveryScope,workspaceId:'workspace:foreign'},{integrityKey:recoveryKey,adapter});await assert.rejects(wrongWorkspace.recoveryPort().reconcile(target,signal()));
    identity={...identity,tokenDigest:sha256Digest('SYNTHETIC B3a new authenticated session')};
    const replayedIntakeRoots:string[]=[];
    for(const operation of ['intake','confirm'] as const){
      const crash=new ImproveControlRoomLoopServiceV1(resultCrashDatabase(owner.client,operation),pgRecoveryScope,{integrityKey:recoveryKey,adapter:e.adapter});
      const intakeBody={description:'SYNTHETIC pending '+operation};
      const draft=await(operation==='intake'?crash:owner.bridge).mutate(identity,pgRecoveryProject,null,'intake',intakeBody,`b3a-pg-${operation}-intake`);
      let body:unknown=intakeBody;
      if(operation==='confirm'){
        const s=await owner.bridge.status(identity,pgRecoveryProject,draft.requestId);body={expectedVersion:1,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256};
        assert.equal((await crash.mutate(identity,pgRecoveryProject,draft.requestId,'confirm',body,'b3a-pg-confirm-exact')).state,'uncertain');
      }else assert.equal(draft.state,'uncertain');
      const pending={projectId:pgRecoveryProject,requestId:draft.requestId,ownerIdentityId:pgRecoveryOwner};
      for(let restart=0;restart<2;restart++)assert.equal((await web.bridge.recoveryPort().reconcile(pending,signal())).state,'blocked');
      const table=operation==='intake'?'control_loop_improvement_run_links':'control_loop_improvement_authorizations';
      assert.equal((await web.client.query(`SELECT count(*)::int n FROM ${table} WHERE request_id=$1`,[draft.requestId])).rows[0]!.n,0);
      assert.equal((await web.client.query(`SELECT count(*)::int n FROM control_loop_improvement_commands WHERE request_id=$1 AND operation=$2 AND entry_kind='result'`,[draft.requestId,operation])).rows[0]!.n,0);
      const key=operation==='intake'?`b3a-pg-${operation}-intake`:'b3a-pg-confirm-exact';
      const replay=await Promise.all([owner.bridge.mutate(identity,pgRecoveryProject,operation==='intake'?null:draft.requestId,operation,body,key),web.bridge.recoveryPort().reconcile(pending,signal())]);assert.equal(replay[0].state,'accepted');
      assert.equal((await owner.bridge.mutate(identity,pgRecoveryProject,operation==='intake'?null:draft.requestId,operation,body,key)).commandId,replay[0].commandId);
      assert.equal((await web.client.query(`SELECT count(*)::int n FROM ${table} WHERE request_id=$1`,[draft.requestId])).rows[0]!.n,1);
      if(operation==='intake')replayedIntakeRoots.push(draft.requestId);
    }
    const decisionRoots:string[]=[];
    for(const operation of ['approve','answer','stop'] as const){
      const decision=await seedRecoveryRun({db:owner.client,scope:pgRecoveryScope,identity},e,pgRecoveryProject,Date.now,`b3a-pg-${operation}`,false,owner.bridge);decisionRoots.push(decision.id);
      const status=await e.raw.status(decision.run);let body:Record<string,unknown>={runLinkId:decision.link};
      if(operation==='approve'){
        const approval={step:'plan' as const,inputVersion:1,head:'a'.repeat(40),reportSha256:'b'.repeat(64)};await e.edit(decision.run,{state:'waiting',approval});body={expectedVersion:1,expectedRevision:status.revision,...approval};
      }else if(operation==='answer'){
        const question={questionId:'question:pg-retained',inputVersion:1,reportSha256:'c'.repeat(64),owner:true,changesInput:false};await e.edit(decision.run,{state:'waiting',question});
        body={expectedVersion:1,expectedRevision:status.revision,questionId:question.questionId,inputVersion:1,questionReportSha256:question.reportSha256,text:'Use the saved authorized answer.'};
      }
      const key=`b3a-pg-${operation}-lost-result`,crash=new ImproveControlRoomLoopServiceV1(resultCrashDatabase(owner.client,operation),pgRecoveryScope,{integrityKey:recoveryKey,adapter:e.adapter});
      const lost=await crash.mutate(identity,pgRecoveryProject,decision.id,operation,body,key);assert.equal(lost.state,'uncertain');
      const decisionTarget={projectId:pgRecoveryProject,requestId:decision.id,ownerIdentityId:pgRecoveryOwner};
      await Promise.allSettled([web.bridge.recoveryPort().reconcile(decisionTarget,signal()),owner.bridge.mutate(identity,pgRecoveryProject,decision.id,operation,body,key)]);
      const replay=await owner.bridge.mutate(identity,pgRecoveryProject,decision.id,operation,body,key);assert.equal(replay.state,'accepted');assert.equal(replay.commandId,lost.commandId);
      assert.equal((await web.client.query('SELECT count(*)::int n FROM control_loop_improvement_commands WHERE command_id=$1 AND entry_kind=\'result\'',[lost.commandId])).rows[0]!.n,1);
      assert.equal((await e.traces()).filter(v=>v.run===decision.run&&v.op===operation).length,1);
    }
    const roots=new Set([saved.id,...decisionRoots,...replayedIntakeRoots]);
    for(let index=1;index<18;index++)roots.add((await seedRecoveryRun({db:owner.client,scope:pgRecoveryScope,identity},e,pgRecoveryProject,Date.now,`b3a-pg-fair-${index}`,false,owner.bridge)).id);
    let cursor=null as import('../src/web/v1/improve-control-room-loop-recovery').LoopRecoveryCursorV1;const seen=new Set<string>();
    for(let pass=0;pass<3;pass++){const scan=await web.bridge.recoveryPort().scan(cursor,8);assert.ok(scan.targets.length<=8);for(const row of scan.targets)seen.add(row.requestId);cursor=scan.nextCursor;}
    assert.equal(cursor,null);assert.equal(roots.size,22);
    assert.deepEqual(seen,roots,'B3a production scan reaches all twenty-two roots including the replayed unconfirmed intake');
    console.log('B3a production scan roots=22 pages=3 limit=8 unconfirmed_intakes=1');
    const dropped=recoveryPgWeb(pg.connection('web'),adapter),connection=await dropped.pool.connect();
    const backend=(await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await admin.query('SELECT pg_terminate_backend($1)',[backend]);connection.release(true);
    try{await assert.rejects(dropped.bridge.recoveryPort().reconcile(target,signal()));}finally{await dropped.close();}
    const beforeRefusal=(await web.client.query('SELECT count(*)::int n FROM control_loop_improvement_commands')).rows[0]!.n;
    const stalePin=new ImproveControlRoomLoopServiceV1(web.client,pgRecoveryScope,{integrityKey:recoveryKey,adapter:{...adapter,schemaDigest:sha256Digest('wrong schema pin')}});
    await assert.rejects(stalePin.recoveryPort().reconcile(target,signal()));
    const wrongKey=new ImproveControlRoomLoopServiceV1(web.client,pgRecoveryScope,{integrityKey:new Uint8Array(32).fill(99),adapter});
    await assert.rejects(wrongKey.recoveryPort().reconcile(target,signal()));
    const desk=new ImproveControlRoomDeskServiceV1(owner.client,pgRecoveryScope,recoveryKey,undefined,Date.now,e.adapter.contract);
    await desk.reviseLoopDraft(identity,pgRecoveryProject,{requestId:saved.id,expectedVersion:1,description:'Changed saved input requires renewed confirmation.',settingsText:e.adapter.settingsText},'b3a-pg-change-input');
    assert.equal((await probe.recoveryPort().reconcile(target,signal())).state,'blocked');assert.equal(recoveries,2);
    assert.equal((await web.client.query('SELECT count(*)::int n FROM control_loop_improvement_commands')).rows[0]!.n,beforeRefusal);
    assert.equal(await readPrivateWebSchemaDigest(web.client),schema);
    console.log('B3a production-login session_independent=true retained_rows_unchanged=true missing_start_results=1 intake_confirm_background_results=0 exact_retry_lineage=1');
  }finally{await admin.end();await web.close();await owner.close();}
}));

import { exclusiveSyntheticRecoveryCapability } from './helpers/improve-control-room-loop-recovery';
import { assertPortAvailable } from './support/attack-kit/index';

test('B3a PostgreSQL 24 separate processes contend one retained result and driver',async t=>run(async pg=>{
  const identity=pgRecoveryIdentity();await seedRecoveryPostgres(pg.admin(),identity);
  const e=await syntheticRecoveryEngine(t);await exclusiveSyntheticRecoveryCapability(t,e);
  const owner=recoveryPgWeb(pg.connection('web'),e.adapter),admin=new Client(pg.admin());await admin.connect();
  const children:ChildProcess[]=[],pids=new Set<number>();
  type Result={kind:'result';state:string;pid:number;child:number|null;counts:{acquired:number;busy:number;uncertain:number}};
  const messages=new Map<ChildProcess,{ready:Promise<void>;result:Promise<Result>}>();
  async function host(){
    const child=spawn(process.execPath,['--import','tsx',resolve('tests/helpers/improve-control-room-loop-recovery.ts'),'--fixture-host'],{stdio:['ignore','pipe','pipe','ipc'],env:{NODE_ENV:'test',CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',...(process.env.ESBUILD_BINARY_PATH?{ESBUILD_BINARY_PATH:process.env.ESBUILD_BINARY_PATH}:{})}});children.push(child);
    let output='';child.stdout?.on('data',b=>{output+=String(b).slice(0,4096);});child.stderr?.on('data',b=>{output+=String(b).slice(0,4096);});
    const ready=new Promise<void>((resolve,reject)=>{let received=false;child.on('message',v=>{if((v as {kind:string}).kind==='ready'){received=true;resolve();}});child.on('exit',code=>{if(!received)reject(new Error(`SYNTHETIC host setup failed exit=${code} ${output}`));});});
    const result=new Promise<Result>((resolve,reject)=>{let received=false;child.on('message',v=>{if((v as {kind:string}).kind==='result'){received=true;const r=v as Result;if(r.child)pids.add(r.child);resolve(r);}});child.on('exit',code=>{if(!received)reject(new Error(`SYNTHETIC host execution failed exit=${code} ${output}`));});});
    // Attach handlers immediately; failures before the measured release remain setup failures.
    void ready.catch(()=>{});void result.catch(()=>{});messages.set(child,{ready,result});
    child.send({connection:pg.connection('web'),configuration:{...e.configuration,contract:{schemaDigest:e.configuration.contract.schemaDigest}},target});
    return child;
  }
  const target={projectId:pgRecoveryProject,requestId:'request:pending',ownerIdentityId:pgRecoveryOwner};
  try{
    const saved=await seedRecoveryRun({db:owner.client,scope:pgRecoveryScope,identity},e,pgRecoveryProject,Date.now,'b3a-pg-contend',true);target.requestId=saved.id;
    const schema=await readPrivateWebSchemaDigest(owner.client);
    for(let index=0;index<24;index++)await host();
    await Promise.all([...messages.values()].map(v=>v.ready));
    await admin.query('BEGIN');await admin.query('SELECT id FROM control_identities WHERE id=$1 FOR UPDATE',[pgRecoveryOwner]);
    for(const child of children)child.send({kind:'go'});
    let waiters=0;const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      await admin.query('SELECT pg_stat_clear_snapshot()');
      waiters=Number((await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%control_identities%'`,[pg.database])).rows[0].n);
      if(waiters===24)break;await new Promise(r=>setTimeout(r,10));
    }
    await admin.query('COMMIT');assert.equal(waiters,24,'B3a all 24 OS processes reached the same production identity lock');
    const results=await Promise.all([...messages.values()].map(v=>v.result));
    assert.equal(new Set(results.map(r=>r.pid)).size,24);assert.equal(results.filter(r=>r.state==='started').length,1);
    assert.equal(results.filter(r=>['busy','blocked','idle'].includes(r.state)).length,23);
    assert.equal(results.reduce((n,r)=>n+r.counts.acquired,0),1);assert.equal(pids.size,1);
    assert.equal((await owner.client.query(`SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='result'`)).rows[0]!.n,1);
    for(let restart=0;restart<2;restart++){
      const child=await host();await messages.get(child)!.ready;child.send({kind:'go'});assert.notEqual((await messages.get(child)!.result).state,'started');
    }
    // Stop remains responsive while the foreground wait holds driver ownership.
    const start=Date.now();assert.equal((await owner.bridge.mutate(identity,pgRecoveryProject,saved.id,'stop',{runLinkId:saved.link},'b3a-pg-stop-halfway')).state,'accepted');
    const stopMs=Date.now()-start;
    console.log(`RESULT stop-response elapsed_ms=${stopMs} bound_ms=2000 margin_ms=${2000-stopMs}`);
    assert.ok(stopMs<2000,'B3a Stop remains responsive within two seconds');
    assert.equal((await owner.bridge.status(identity,pgRecoveryProject,saved.id)).display.state,'stopped');
    const winnerResult=results.find(r=>r.state==='started')!,winner=children.find(child=>child.pid===winnerResult.pid)!;
    const winnerExit=once(winner,'exit');winner.kill('SIGKILL');await winnerExit;
    assert.ok(winnerResult.child);const orphan=winnerResult.child;
    const command=await processCommand(orphan);assert.ok(command.includes(e.configuration.entrypoint)&&command.includes(saved.run),'B3a orphan identity matches the actual owned wait');
    for(const child of children)if(child.connected)child.send({kind:'finish'});
    await Promise.all(children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():once(child,'exit')));
    const c=await exclusiveSyntheticRecoveryCapability(t,e),adapter=createImproveControlRoomLoopAdapterV1({...e.configuration,contract:{...e.configuration.contract,recovery:c.capability}});t.after(()=>adapter.close());
    const restarted=recoveryPgWeb(pg.connection('web'),adapter);
    try{await assert.rejects(restarted.bridge.recoveryPort().reconcile(target,signal()));}finally{await restarted.close();}
    process.kill(orphan,'SIGTERM');
    const reapedDeadline=Date.now()+3000;let gone=false;while(Date.now()<reapedDeadline){try{process.kill(orphan,0);}catch{gone=true;break;}await new Promise(r=>setTimeout(r,5));}
    assert.ok(gone,'B3a test-owned orphan was terminated and reaped by container init');pids.delete(orphan);
    assert.equal((await e.traces()).filter(v=>v.op==='start').length,1);assert.equal((await e.traces()).filter(v=>v.op==='wait').length,1);
    assert.equal(await readPrivateWebSchemaDigest(owner.client),schema);
    console.log(`B3a contention processes=24 measured_lock_waiters=${waiters} winners=1 losers=23 result_rows=1 wait_children=1 restarts=2 stop_responsive=true holder_sigkill=true orphan_refused=true`);
  }finally{
    await admin.query('ROLLBACK').catch(()=>{});
    await Promise.all(children.map(async child=>{if(child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');if(child.connected)child.send({kind:'finish'});const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exit;}finally{clearTimeout(timer);}}));
    for(const pid of pids){try{const command=await processCommand(pid);if(command.includes(e.configuration.entrypoint)&&command.includes('wait'))process.kill(pid,'SIGTERM');}catch{/* Already reaped. */}}
    await admin.end();await owner.close();
  }
}));
