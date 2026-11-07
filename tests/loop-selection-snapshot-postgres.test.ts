import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { Pool,Client } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { withRealPostgres,requiresRealPostgres } from './support/attack-kit/index';
import { sha256Digest } from '../src/security';
import { WebSessionAuthority } from '../src/web/v1/session-authority';
import { privatePgOptions } from '../src/web/v1/private-pg-options';
import { bindPrivatePgPool } from '../src/web/v1/private-pg-database';
import { createLoopSelectionSourceFilesV1,withLoopSelectionSourceTransactionsV1,LoopSelectionSnapshotCoordinatorV1,
  bindLoopSelectionSourceDeadlineV1 } from '../src/web/v1/loop-selection-snapshot';
import { LoopRosterServiceV1,readLoopRosterSnapshotSourceV1 } from '../src/web/v1/loop-roster-service';
import { createImproveControlRoomLoopMonitorV1 } from '../src/web/v1/improve-control-room-loop-monitoring';

const roster='name\tlauncher\tprovider\tfamily\tclass\troles\tefforts\tdefault_effort\tcost\ton\tnote\tnick\tmax_build_grade\n'
 +'fixture\tcodex\tcodex\tfixture\tfrontier\tbuild,final\tmedium\tmedium\tsub\ton\tfixture\tF\tHard\n';
const scope={tenantId:'tenant:snapshot',workspaceId:'workspace:snapshot'};
const until=async(predicate:()=>boolean)=>{const end=performance.now()+10000;while(!predicate()){assert.ok(performance.now()<end,'observed contender barrier timed out');await new Promise(r=>setTimeout(r,10));}};

test('T-SNAPSHOT PostgreSQL17 production-role source contention and COMMIT lifetime',async t=>{
  assert.ok(process.env.PG_BIN,'BLOCKED: lead-supplied PG_BIN is required');
  assert.ok(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE,'BLOCKED: lead-supplied isolated port range is required');
  const count=Number(execFileSync('/bin/bash',['-o','pipefail','-c','ipcs -m | tail -n +4 | wc -l'],{encoding:'utf8',timeout:10000}).trim());
  assert.ok(Number.isSafeInteger(count)&&count<20,'BLOCKED: native PostgreSQL requires verified shared-memory count below 20');
  assert.ok(requiresRealPostgres(),'BLOCKED: PostgreSQL17 required, never skip');
  const port=Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE);
  const result=await withRealPostgres(async pg=>{
    assert.ok(pg.appliedMigrations>0);const admin=new Client(pg.admin());await admin.connect();try{await admin.query(`INSERT INTO tenants(id,display_name) VALUES($1,'Snapshot fixture')`,[scope.tenantId]);
    await admin.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Snapshot fixture')`,[scope.workspaceId,scope.tenantId]);}finally{await admin.end();}
    await mkdir(resolve('.test-tmp'),{recursive:true});const root=await mkdtemp(resolve('.test-tmp/snapshot-pg-'));
    const pools:Array<ReturnType<typeof bindPrivatePgPool>>=[];
    let monitor:ReturnType<typeof createImproveControlRoomLoopMonitorV1>|undefined;
    try{
      await mkdir(join(root,'config'),{mode:0o700});await mkdir(join(root,'roster'),{mode:0o700});
      const file=join(root,'config/availability.json'),exportPath=join(root,'roster/roster-export.tsv');await writeFile(exportPath,roster,{mode:0o600});
      let monitorAttempts=0;
      let wall=Date.now(),mono=performance.now(),health={schema_version:1 as const,checked_at:new Date(wall).toISOString(),entries:[{model:'fixture',route:'codex',available:true}]};
      const files=createLoopSelectionSourceFilesV1({availabilityFile:file,rosterFile:exportPath,readAvailability:()=>monitor!.readAvailability()});
      monitor=createImproveControlRoomLoopMonitorV1({availabilityFile:file,bootstrapHash:'0'.repeat(64),binding:'b'.repeat(64),selectionSources:Object.freeze({...files,acquire(){monitorAttempts++;return files.acquire();}}),
        enabled:()=>true,clock:{wallNow:()=>wall,monotonicNow:()=>mono,setTimeout,clearTimeout},
        collect:async()=>({bytes:Buffer.from(JSON.stringify(health)),exitCode:0})});
      const web=()=>{const login=pg.connection('web');const p=bindPrivatePgPool(new Pool({...privatePgOptions({host:'127.0.0.1',port:pg.port,database:pg.database,username:login.user,password:login.password!,majorVersion:17}),host:login.host,max:1}));pools.push(p);return withLoopSelectionSourceTransactionsV1(p.client,files);};
      const db=web(),coordinator=new LoopSelectionSnapshotCoordinatorV1({db,...scope,sourceFiles:files,readRoster:readLoopRosterSnapshotSourceV1,
        clock:{wallNow:()=>wall,monotonicNow:()=>mono}});
      await coordinator.start();
      const clients=Array.from({length:24},web);await Promise.all(clients.map(d=>d.query('SELECT current_user')));
      assert.equal((await db.query<{current_user:string}>('SELECT current_user')).rows[0]!.current_user,'control_room_web');
      const held=files.acquire(),owner=await readFile(join(files.root,'fence/owner.json'));
      try{
        const results=await Promise.allSettled(clients.map(d=>new LoopRosterServiceV1(d,scope,{rosterRoot:join(root,'roster'),toolsSeed:exportPath,
          check:async()=>({exitCode:0,lines:[]})},()=>wall,{},coordinator).seedFromTsv(roster,'export-file')));
        assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.message==='selection_source_busy').length,24);
        assert.equal((await pg.query('web','SELECT * FROM control_loop_roster_state')).rows.length,0);
        assert.deepEqual(await readFile(join(files.root,'fence/owner.json')),owner);
      }finally{held.release();}
      const service=new LoopRosterServiceV1(db,scope,{rosterRoot:join(root,'roster'),toolsSeed:exportPath,check:async()=>({exitCode:0,lines:[]})},()=>wall,{},coordinator);
      await service.seedFromTsv(roster,'export-file');monitor.tick();
      await until(()=>existsSync(file)&&!existsSync(file+'.monitor.lock'));
      const checked=await coordinator.capture();
      // Each caller owns distinct authority and project rows, so those locks cannot
      // serialize this barrier and masquerade as the shared source fence.
      const identities=await (async()=>{
        const admin=new Client(pg.admin());await admin.connect();
        try{
          await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
            VALUES('adapter:snapshot',$1,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`,[scope.tenantId]);
          const values=[];
          for(let i=0;i<24;i++){
            const id='identity:snapshot:'+i,project='project:snapshot:'+i,at=new Date(wall-60000).toISOString(),expires=new Date(wall+7200000).toISOString();
            const identity={provider:'test',subject:id,tokenDigest:sha256Digest({session:id}),issuedAt:at,expiresAt:expires,verificationExpiresAt:expires};
            await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
              VALUES($1,$2,$3,'adapter:snapshot',$1,'1','Snapshot fixture','planned','manual_project_active','healthy','control_room_native',now(),'{}',now())`,[project,scope.tenantId,scope.workspaceId]);
            await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
              VALUES($1,$2,'human','Snapshot fixture','test',$3,'active',$4,$4)`,[id,scope.tenantId,sha256Digest({provider:'test',subject:id}),at]);
            await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
              VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,['grant:snapshot:'+i,scope.tenantId,id,at]);
            await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)`,[scope.tenantId,identity.tokenDigest,id,at,expires]);
            values.push({identity,project});
          }
          return values;
        }finally{await admin.end();}
      })();
      let arrivals=0,losers=0,winners=0,release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});
      const competing=clients.map((d,i)=>new WebSessionAuthority(d,scope,()=>wall).authenticated(identities[i]!.identity,async(tx,actor)=>{
        actor.require('roster.manage');await tx.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identities[i]!.project]);
        arrivals++;await coordinator.lockSources(tx);winners++;await barrier;
      }).catch(e=>{if(e.message==='selection_source_busy'){losers++;return;}throw e;}));
      try{await until(()=>arrivals===24&&losers===23);assert.equal(winners,1);assert.equal(losers,23);}finally{release();await Promise.all(competing);}
      let outerCommitted=false;
      const observed={query:db.query.bind(db),transaction:db.transaction.bind(db),transactionWithPreCommitCheck:<T>(callback:Parameters<typeof db.transaction<T>>[0],check:()=>void|Promise<void>)=>
        pools[0]!.client.transactionWithPreCommitCheck(callback,check).then(value=>{outerCommitted=true;assert.throws(()=>files.acquire(),/selection_source_busy/);return value;})};
      const admission=withLoopSelectionSourceTransactionsV1(observed,files);
      await admission.transaction(async tx=>{bindLoopSelectionSourceDeadlineV1(tx,{frozenMono:mono,frozenMonoEnd:mono,deadlineMono:mono+5000,frozenWall:wall});
        await coordinator.assertCurrent(tx,checked);assert.throws(()=>files.acquire(),/selection_source_busy/);
        const before=await pg.query('web','SELECT * FROM control_loop_roster_state');
        const attempts=await Promise.allSettled(clients.map((d,i)=>new LoopRosterServiceV1(d,scope,{rosterRoot:join(root,'roster'),toolsSeed:exportPath,
          check:async()=>({exitCode:0,lines:[]})},()=>wall,{},coordinator).setOn(identities[i]!.identity,'fixture',{expectedVersion:1,on:false},'snapshot-held-writer-'+i)));
        assert.equal(attempts.filter(r=>r.status==='rejected'&&r.reason.message==='selection_source_busy').length,24);
        assert.deepEqual((await pg.query('web','SELECT * FROM control_loop_roster_state')).rows,before.rows);
        assert.equal((await pg.query<{on_off:string}>('web','SELECT on_off FROM control_loop_roster_models')).rows[0]!.on_off,'on');});
      assert.equal(outerCommitted,true);const released=files.acquire();released.release();
      const retryWriter=new LoopRosterServiceV1(clients[0]!,scope,{rosterRoot:join(root,'roster'),toolsSeed:exportPath,check:async()=>({exitCode:0,lines:[]})},()=>wall,{},coordinator);
      assert.equal((await retryWriter.setOn(identities[0]!.identity,'fixture',{expectedVersion:1,on:false},'snapshot-retry-after-release')).version,2);
      assert.equal((await retryWriter.setOn(identities[0]!.identity,'fixture',{expectedVersion:2,on:true},'snapshot-restore-after-retry')).version,3);
      await assert.rejects(db.transaction(async tx=>{await coordinator.lockSources(tx);await coordinator.invalidate(tx);
        await tx.query(`UPDATE control_loop_roster_models SET note='rolled back' WHERE tenant_id=$1`,[scope.tenantId]);throw Error('fixture rollback');}));
      assert.equal((await pg.query<{note:string}>('web','SELECT note FROM control_loop_roster_models')).rows[0]!.note,'fixture');
      let afterRollback=await coordinator.capture();assert.notEqual(afterRollback.revision,checked.revision);
      // Export first: actual producer publication holds the same fence until its
      // SQL transaction commits. Admission refuses instead of waiting/upgrading.
      let entered!:()=>void,resume!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),paused=new Promise<void>(r=>{resume=r;});
      const exporter=new LoopRosterServiceV1(clients[0]!,scope,{rosterRoot:join(root,'roster'),toolsSeed:exportPath,check:async()=>({exitCode:0,lines:[]})},()=>wall,
        {afterTemporaryWrite:async()=>{entered();await paused;}},coordinator);
      const exporting=exporter.exportRoster();
      try{
        await reached;
        await assert.rejects(db.transaction(async tx=>{bindLoopSelectionSourceDeadlineV1(tx,{frozenMono:mono,frozenMonoEnd:mono,deadlineMono:mono+5000,frozenWall:wall});await coordinator.assertCurrent(tx,afterRollback);}),/selection_source_busy/);
      }finally{resume();await exporting;}
      afterRollback=await coordinator.capture();
      // Admission first: a due monitor attempt cannot change either file while
      // the transaction owns the fence; its next existing scheduled attempt can.
      wall+=3000001;mono+=3000001;health={...health,checked_at:new Date(wall).toISOString()};
      const healthBefore=await readFile(file),scheduleBefore=await readFile(file+'.schedule.json');
      await db.transaction(async tx=>{
        bindLoopSelectionSourceDeadlineV1(tx,{frozenMono:mono,frozenMonoEnd:mono,deadlineMono:mono+5000,frozenWall:wall});await coordinator.assertCurrent(tx,afterRollback);
        const attempts=monitorAttempts;monitor!.tick();await until(()=>monitorAttempts>attempts&&!existsSync(file+'.monitor.lock'));
        assert.deepEqual(await readFile(file),healthBefore);assert.deepEqual(await readFile(file+'.schedule.json'),scheduleBefore);
      });
      await new Promise(r=>setTimeout(r,20));monitor.tick();
      await until(()=>existsSync(file)&&!existsSync(file+'.monitor.lock')&&JSON.parse(readFileSync(file,'utf8')).checked_at===health.checked_at);
      assert.notDeepEqual(await readFile(file),healthBefore);afterRollback=await coordinator.capture();
      // Expiry at precommit rolls back a real production-role SQL write.
      const priorKey=(await pg.query<{last_idempotency_key:string|null}>('web','SELECT last_idempotency_key FROM control_loop_roster_state WHERE tenant_id=$1',[scope.tenantId])).rows[0]!.last_idempotency_key;
      await assert.rejects(db.transaction(async tx=>{
        bindLoopSelectionSourceDeadlineV1(tx,{frozenMono:mono,frozenMonoEnd:mono,deadlineMono:mono+5000,frozenWall:wall});await coordinator.assertCurrent(tx,afterRollback);
        await tx.query("UPDATE control_loop_roster_state SET last_idempotency_key='expired-rollback-fixture',last_request_digest=$2 WHERE tenant_id=$1",[scope.tenantId,sha256Digest({fixture:'expiry'})]);wall+=5000;mono+=5000;
      }),/selection_source_unavailable/);
      assert.equal((await pg.query<{last_idempotency_key:string|null}>('web','SELECT last_idempotency_key FROM control_loop_roster_state WHERE tenant_id=$1',[scope.tenantId])).rows[0]!.last_idempotency_key,priorKey);
      wall+=3599000;mono+=3599000;
      await assert.rejects(db.transaction(async tx=>{bindLoopSelectionSourceDeadlineV1(tx,{frozenMono:mono,frozenMonoEnd:mono,deadlineMono:mono+5000,frozenWall:wall});await coordinator.assertCurrent(tx,afterRollback);}));
      console.log('T-SNAPSHOT PG production_connections=24 source_busy_seed=24 arrivals=24 winners=1 losers=23 authorized_owners=24 distinct_projects=24 held_admission_writers_refused=24 writer_retry_after_release=true producer_first=true monitor_busy_retry=true committed_fence=true rollback=true precommit_rollback=true expiry=true');
    }finally{await monitor?.close();await Promise.all(pools.map(p=>p.close()));await rm(root,{recursive:true,force:true});}
  },{port,allowedPorts:Array.from({length:10},(_,i)=>port+i),database:'snapshot_sources',boundMs:500000});
  assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);
  console.log('T-SNAPSHOT PG teardown cleanedUp=true leftovers=0');
});
