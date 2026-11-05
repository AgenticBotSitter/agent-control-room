import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { Pool,Client } from 'pg';
import { existsSync } from 'node:fs';
import { withRealPostgres,requiresRealPostgres } from './support/attack-kit/index';
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
      let wall=Date.now(),mono=performance.now(),health={schema_version:1 as const,checked_at:new Date(wall).toISOString(),entries:[{model:'fixture',route:'codex',available:true}]};
      const files=createLoopSelectionSourceFilesV1({availabilityFile:file,rosterFile:exportPath,readAvailability:()=>monitor!.readAvailability()});
      monitor=createImproveControlRoomLoopMonitorV1({availabilityFile:file,bootstrapHash:'0'.repeat(64),binding:'b'.repeat(64),selectionSources:files,
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
      await until(()=>existsSync(file)&&!existsSync(file+'.monitor.lock'));await monitor.close();
      const checked=await coordinator.capture();
      let arrivals=0,losers=0,winners=0,release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});
      const competing=clients.map(d=>d.transaction(async tx=>{
        arrivals++;await coordinator.lockSources(tx);winners++;await barrier;
      }).catch(e=>{if(e.message==='selection_source_busy'){losers++;return;}throw e;}));
      await until(()=>arrivals===24&&losers===23);assert.equal(winners,1);assert.equal(losers,23);release();await Promise.all(competing);
      let outerCommitted=false;
      const observed={query:db.query.bind(db),transaction:db.transaction.bind(db),transactionWithPreCommitCheck:<T>(callback:Parameters<typeof db.transaction<T>>[0],check:()=>void|Promise<void>)=>
        pools[0]!.client.transactionWithPreCommitCheck(callback,check).then(value=>{outerCommitted=true;assert.throws(()=>files.acquire(),/selection_source_busy/);return value;})};
      const admission=withLoopSelectionSourceTransactionsV1(observed,files);
      await admission.transaction(async tx=>{bindLoopSelectionSourceDeadlineV1(tx,{frozenMono:mono,deadlineMono:mono+5000,frozenWall:wall});
        await coordinator.assertCurrent(tx,checked);assert.throws(()=>files.acquire(),/selection_source_busy/);});
      assert.equal(outerCommitted,true);const released=files.acquire();released.release();
      await assert.rejects(db.transaction(async tx=>{await coordinator.lockSources(tx);await coordinator.invalidate(tx);
        await tx.query(`UPDATE control_loop_roster_models SET note='rolled back' WHERE tenant_id=$1`,[scope.tenantId]);throw Error('fixture rollback');}));
      assert.equal((await pg.query<{note:string}>('web','SELECT note FROM control_loop_roster_models')).rows[0]!.note,'fixture');
      const afterRollback=await coordinator.capture();assert.notEqual(afterRollback.revision,checked.revision);
      wall+=3599000;mono+=3599000;
      await assert.rejects(db.transaction(async tx=>{bindLoopSelectionSourceDeadlineV1(tx,{frozenMono:mono,deadlineMono:mono+5000,frozenWall:wall});await coordinator.assertCurrent(tx,afterRollback);}));
      console.log('T-SNAPSHOT PG production_connections=24 source_busy_seed=24 arrivals=24 winners=1 losers=23 committed_fence=true rollback=true expiry=true');
    }finally{await monitor?.close();await Promise.all(pools.map(p=>p.close()));await rm(root,{recursive:true,force:true});}
  },{port,allowedPorts:Array.from({length:10},(_,i)=>port+i),database:'snapshot_sources',boundMs:500000});
  assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);
  console.log('T-SNAPSHOT PG teardown cleanedUp=true leftovers=0');
});
