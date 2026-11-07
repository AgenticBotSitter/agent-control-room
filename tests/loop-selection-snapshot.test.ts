import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm, chmod, symlink, link, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/security";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { LoopRosterServiceV1, readLoopRosterSnapshotSourceV1 } from "../src/web/v1/loop-roster-service";
import { createLoopSelectionSourceFilesV1, withLoopSelectionSourceTransactionsV1, LoopSelectionSnapshotCoordinatorV1,
  bindLoopSelectionSourceDeadlineV1, registerLoopSelectionSourceTransactionAliasV1 } from "../src/web/v1/loop-selection-snapshot";
import { encodeSelectionSourceBundleV1, decodeSelectionSourceBundleV1, selectionSnapshotFromBundleV1,
  normalizeSelectionAvailabilityV1 } from "../src/web/v1/loop-selection-snapshot-wire";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
const roster='name\tlauncher\tprovider\tfamily\tclass\troles\tefforts\tdefault_effort\tcost\ton\tnote\tnick\tmax_build_grade\n'
  +'fixture\tcodex\tcodex\tfixture\tfrontier\tbuild,final\tlow,medium\tmedium\tsub\ton\té\tF\tHard\n';
const health=(wall=now)=>({schema_version:1 as const,checked_at:new Date(wall).toISOString(),entries:[{model:'fixture',route:'codex',available:true}]});
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
export async function sourceFixture(t:TestContext){
  const f=await taskFixture();t.after(()=>f.db.close());
  await mkdir(resolve('.test-tmp'),{recursive:true});const root=await mkdtemp(resolve('.test-tmp/selection-source-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'config'),{mode:0o700});await mkdir(join(root,'roster'),{mode:0o700});
  let wall=now,mono=100,completed=health(),failPoint:string|undefined;
  let sampleWall:((read:()=>number)=>number)|undefined;
  const exportPath=join(root,'roster/roster-export.tsv');await writeFile(exportPath,roster,{mode:0o600});
  await writeFile(join(root,'config/availability.json'),JSON.stringify(completed),{mode:0o600});
  const files=createLoopSelectionSourceFilesV1({availabilityFile:join(root,'config/availability.json'),rosterFile:exportPath,
    readAvailability:()=>completed,faults:{at(point){if(point===failPoint)throw Error('fixture crash');}}});
  const db=withLoopSelectionSourceTransactionsV1(f.client,files);
  const coordinator=new LoopSelectionSnapshotCoordinatorV1({db,...scope,sourceFiles:files,readRoster:readLoopRosterSnapshotSourceV1,
    clock:{wallNow:()=>sampleWall?sampleWall(()=>wall):wall,monotonicNow:()=>mono}});
  const service=new LoopRosterServiceV1(db,scope,{rosterRoot:join(root,'roster'),toolsSeed:exportPath,check:async()=>({exitCode:0,lines:[]})},()=>wall,{},coordinator);
  assert.equal(existsSync(files.root),false,'capability construction has no filesystem effects');
  await coordinator.start();await service.start();
  const snapshot=await coordinator.capture();
  return {...f,root,files,db,coordinator,service,exportPath,snapshot,health:()=>completed,
    advance(ms:number){wall+=ms;mono+=ms;},wall:()=>wall,mono:()=>mono,setWall(value:number){wall=value;},
    setWallSampler(value?:(read:()=>number)=>number){sampleWall=value;},
    setHealth(value:ReturnType<typeof health>){completed=value;},fault(value?:string){failPoint=value;},
    bind(tx:DatabaseSession,ms=5000){bindLoopSelectionSourceDeadlineV1(tx,{frozenMono:mono,deadlineMono:mono+ms,frozenWall:wall});}};
}

test('T-SNAPSHOT codec independent Unicode hashes, closed shapes, canonical versions and size bound',()=>{
  const bundle={schemaVersion:1 as const,revision:'selection-source-v1:'+'a'.repeat(32),roster:{version:'1',exportedVersion:'1',text:roster},availability:health()};
  const snapshot=selectionSnapshotFromBundleV1(bundle);
  assert.equal(snapshot.rosterDigest,sha(roster));
  assert.equal(snapshot.availabilityDigest,sha('{"checked_at":"'+health().checked_at+'","entries":[{"available":true,"model":"fixture","route":"codex"}],"schema_version":1}'));
  const encoded=encodeSelectionSourceBundleV1(bundle);assert.ok(encoded.endsWith('\n'));
  assert.deepEqual(decodeSelectionSourceBundleV1(Buffer.from(encoded),now),bundle);
  for(const version of ['0','01','-1','1.0','9007199254740992'])assert.throws(()=>encodeSelectionSourceBundleV1({...bundle,roster:{...bundle.roster,version,exportedVersion:version}}));
  for(const mutate of [(v:any)=>v.extra=true,(v:any)=>v.roster.extra=1,(v:any)=>v.availability.entries[0].available=1,
    (v:any)=>v.availability.entries.push({...v.availability.entries[0]}),(v:any)=>v.roster.exportedVersion='2']){
    const v=structuredClone(bundle);mutate(v);assert.throws(()=>decodeSelectionSourceBundleV1(Buffer.from(JSON.stringify(v)),now));
  }
  assert.throws(()=>decodeSelectionSourceBundleV1(Buffer.from('{"schemaVersion":1,"schemaVersion":1}'),now));
  assert.throws(()=>encodeSelectionSourceBundleV1({...bundle,roster:{...bundle.roster,text:'x'.repeat(1048576)}}));
  assert.throws(()=>decodeSelectionSourceBundleV1(Buffer.from([255]),now));
  assert.throws(()=>normalizeSelectionAvailabilityV1(health(now+1),now));
  assert.throws(()=>normalizeSelectionAvailabilityV1(health(now-3600001),now));
  const entries=[{model:'z',route:'a',available:false},{model:'a',route:'z',available:true}];
  assert.deepEqual(normalizeSelectionAvailabilityV1({...health(),entries},now).entries,[entries[1],entries[0]]);
});

test('T-SNAPSHOT producer reads real master, stable clean revision, missing and equal-byte version drift',async t=>{
  const f=await sourceFixture(t);
  assert.deepEqual(await f.coordinator.capture(),f.snapshot);
  const lease=f.files.acquire();try{assert.equal(f.files.current(lease,now).roster.text,roster);}finally{lease.release();}
  await f.db.transaction(async tx=>{await f.coordinator.lockSources(tx);await f.coordinator.invalidate(tx);
    await tx.query('UPDATE control_loop_roster_state SET version=version+1,exported_version=exported_version+1');});
  const second=await f.coordinator.capture();assert.equal(second.rosterDigest,f.snapshot.rosterDigest);assert.notEqual(second.revision,f.snapshot.revision);
  await assert.rejects(f.db.transaction(async tx=>{f.bind(tx);await f.coordinator.assertCurrent(tx,f.snapshot);}));
  await f.db.transaction(async tx=>{await f.coordinator.lockSources(tx);await f.coordinator.invalidate(tx);await tx.query('DELETE FROM control_loop_roster_models');await tx.query('DELETE FROM control_loop_roster_state');});
  await assert.rejects(f.coordinator.capture());
});

test('T-SNAPSHOT facade holds fence through outer COMMIT, rejects aliases outside scope and preserves precommit',async t=>{
  const f=await sourceFixture(t);let callbackDone=false,commitObserved=false;
  const base:DatabaseClient={query:f.client.query.bind(f.client),transaction:f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck:(callback,check)=>f.client.transactionWithPreCommitCheck(async tx=>{
      const value=await callback(tx);callbackDone=true;
      assert.throws(()=>f.files.acquire(),/selection_source_busy/);return value;
    },async()=>{await check();commitObserved=true;assert.equal(callbackDone,true);assert.throws(()=>f.files.acquire(),/selection_source_busy/);})};
  const db=withLoopSelectionSourceTransactionsV1(base,f.files);
  let stale:DatabaseSession|undefined,callerCheck=0;
  await db.transactionWithPreCommitCheck(async tx=>{
    const alias={query:tx.query.bind(tx)};registerLoopSelectionSourceTransactionAliasV1(alias,tx);stale=alias;
    f.bind(alias);await f.coordinator.assertCurrent(alias,f.snapshot);
  },()=>{callerCheck++;});
  assert.equal(callerCheck,1);assert.equal(commitObserved,true);assert.equal(existsSync(join(f.files.root,'fence')),false);
  await assert.rejects(f.coordinator.assertCurrent(stale!,f.snapshot));
  assert.throws(()=>registerLoopSelectionSourceTransactionAliasV1({query:f.client.query.bind(f.client)},f.client));
  await assert.rejects(f.db.transaction(tx=>f.coordinator.assertCurrent(tx,f.snapshot)),'missing deadline refuses');
});

test('T-SNAPSHOT precommit catches health expiry and wall/monotonic skew without resetting deadline',async t=>{
  const f=await sourceFixture(t);f.advance(3597000);
  await assert.rejects(f.db.transaction(async tx=>{f.bind(tx,5000);await f.coordinator.assertCurrent(tx,f.snapshot);}));
  // Exact health bytes remain fresh now but cannot survive through D.
  f.advance(-3597000);
  await assert.rejects(f.db.transaction(async tx=>{f.bind(tx);await f.coordinator.assertCurrent(tx,f.snapshot);f.advance(5000);}));
  await assert.rejects(f.db.transaction(async tx=>{f.bind(tx);await f.coordinator.assertCurrent(tx,f.snapshot);f.setWall(f.wall()-1);}));
});

// The third wall read in validate() is the timing sample after current/source reads.
// Advance both clocks around that read to simulate descheduling without sleeping.
for(const phase of ['assertCurrent','precommit'] as const){
  for(const side of ['before','after'] as const){
    test(`T-SNAPSHOT sampling pause ${side} wall read at ${phase} preserves valid snapshot`,async t=>{
      const f=await sourceFixture(t);let pauses=0;
      const arm=()=>{let reads=0;f.setWallSampler(read=>{
        if(++reads!==3)return read();
        pauses++;
        if(side==='before'){f.advance(25);return read();}
        const wall=read();f.advance(25);return wall;
      });};
      await f.db.transaction(async tx=>{
        f.bind(tx);
        if(phase==='assertCurrent')arm();
        await f.coordinator.assertCurrent(tx,f.snapshot);
        if(phase==='precommit')arm();
      });
      assert.equal(pauses,1,'the timing sample must include exactly one simulated pause');
      assert.equal(f.mono(),125,'sampling pause advances the original monotonic clock');
    });
  }
  for(const jump of [-250,250]){
    test(`T-SNAPSHOT wall jump ${jump} ms at ${phase} refuses snapshot`,async t=>{
      const f=await sourceFixture(t);let jumps=0,callbackDone=false;
      const before=(await f.db.query('SELECT updated_at FROM control_loop_roster_state')).rows;
      const arm=()=>{let reads=0;f.setWallSampler(read=>{
        if(++reads===3){f.setWall(f.wall()+jump);jumps++;}return read();
      });};
      await assert.rejects(f.db.transaction(async tx=>{
        f.bind(tx);f.advance(1000);
        if(phase==='assertCurrent')arm();
        await f.coordinator.assertCurrent(tx,f.snapshot);
        await tx.query("UPDATE control_loop_roster_state SET updated_at='2026-01-01T00:00:00Z'");
        callbackDone=true;
        if(phase==='precommit')arm();
      }),{message:'selection_source_unavailable'});
      assert.equal(jumps,1,'the timing sample must include the requested wall jump');
      assert.equal(callbackDone,phase==='precommit','refuse at the requested validation boundary');
      assert.deepEqual((await f.db.query('SELECT updated_at FROM control_loop_roster_state')).rows,before,'refusal rolls back transaction writes');
    });
  }
  test(`T-SNAPSHOT sampling pause at ${phase} cannot extend monotonic deadline`,async t=>{
    const f=await sourceFixture(t);let pauses=0;
    const arm=()=>{let reads=0;f.setWallSampler(read=>{
      const wall=read();if(++reads===3){f.advance(5000);pauses++;}return wall;
    });};
    await assert.rejects(f.db.transaction(async tx=>{
      f.bind(tx);
      if(phase==='assertCurrent')arm();
      await f.coordinator.assertCurrent(tx,f.snapshot);
      if(phase==='precommit')arm();
    }),{message:'selection_source_unavailable'});
    assert.equal(pauses,1);
  });
}

test('T-SNAPSHOT source-busy seed/edit/export and owned check-directory preservation',async t=>{
  const f=await sourceFixture(t),lease=f.files.acquire(),old=await readFile(f.exportPath);
  try{
    await assert.rejects(f.service.seedFromTsv(roster,'tools-seed'),/selection_source_busy/);
    await assert.rejects(f.service.setOn(f.identity,'fixture',{expectedVersion:1,on:false},'snapshot-busy-edit-0001'),/selection_source_busy/);
    await assert.rejects(f.service.exportRoster(),/selection_source_busy/);
    assert.deepEqual(await readFile(f.exportPath),old);
  }finally{lease.release();}
  const check=join(f.root,'roster/check-ABC123');await mkdir(check,{mode:0o700});await writeFile(join(check,'models.tsv'),'active');
  await f.service.start();assert.equal(await readFile(join(check,'models.tsv'),'utf8'),'active');
});

test('T-SNAPSHOT rollback keeps dirty, A-B-A and restart allocate new source revisions',async t=>{
  const f=await sourceFixture(t);
  await assert.rejects(f.db.transaction(async tx=>{await f.coordinator.lockSources(tx);await f.coordinator.invalidate(tx);throw Error('fixture rollback');}));
  const b=await f.coordinator.capture();assert.notEqual(b.revision,f.snapshot.revision);
  const restarted=new LoopSelectionSnapshotCoordinatorV1({db:f.db,...scope,sourceFiles:f.files,readRoster:readLoopRosterSnapshotSourceV1,
    clock:{wallNow:f.wall,monotonicNow:f.mono}});
  await assert.rejects(restarted.capture());await restarted.start();
  const c=await restarted.capture();assert.notEqual(c.revision,b.revision);
  assert.equal(c.rosterDigest,b.rosterDigest);
});

test('T-SNAPSHOT uncertain COMMIT poisons retained filesystem fence and refuses subsequent capture',async t=>{
  const f=await sourceFixture(t);
  const base:DatabaseClient={query:f.client.query.bind(f.client),transaction:f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck:async(callback,check)=>{
      await f.client.transactionWithPreCommitCheck(callback,check);throw Object.assign(Error('fixture uncertainty'),{code:'database_outcome_uncertain'});
    }};
  const db=withLoopSelectionSourceTransactionsV1(base,f.files);
  await assert.rejects(db.transaction(async tx=>{await f.coordinator.lockSources(tx);}));
  assert.equal(existsSync(join(f.files.root,'fence/owner.json')),true);
  assert.throws(()=>f.files.acquire(),/selection_source_unavailable/);
  await assert.rejects(f.coordinator.capture());
});

for(const point of ['dirty.json:write','dirty.json:fsync','dirty.json:rename','dirty.json:directory-fsync','current:remove',
  'current.json:write','current.json:fsync','current.json:rename','current.json:directory-fsync','dirty:remove']){
  test(`T-SNAPSHOT crash ${point} leaves coherent clean or unavailable state`,async t=>{
    const f=await sourceFixture(t);f.fault(point);
    await assert.rejects(f.db.transaction(async tx=>{await f.coordinator.lockSources(tx);await f.coordinator.invalidate(tx);

    }).then(()=>f.coordinator.capture()));
    f.fault();
    const lease=f.files.acquire();try{
      try{const current=f.files.current(lease,now);assert.equal(current.roster.text,roster);assert.equal(canonicalJson(current.availability),canonicalJson(health()));}
      catch{assert.ok(existsSync(join(f.files.root,'dirty.json'))||!existsSync(join(f.files.root,'current.json')));}
    }finally{lease.release();}
  });
}

test('T-SNAPSHOT file custody rejects symlink, hardlink, wrong mode, foreign fence nonce and double release',async t=>{
  const f=await sourceFixture(t),path=join(f.files.root,'current.json'),bytes=await readFile(path);
  const lease=f.files.acquire();
  await chmod(path,0o644);assert.throws(()=>f.files.current(lease,now));await chmod(path,0o600);
  const other=join(f.files.root,'hardlink');await link(path,other);assert.throws(()=>f.files.current(lease,now));await rm(other);
  await rm(path);await writeFile(join(f.root,'target'),bytes,{mode:0o600});await symlink(join(f.root,'target'),path);
  assert.throws(()=>f.files.current(lease,now));await rm(path);await writeFile(path,bytes,{mode:0o600});
  lease.release();assert.throws(()=>lease.release());
  const held=f.files.acquire();await writeFile(join(f.files.root,'fence/owner.json'),'{"schemaVersion":1,"nonce":"'+'b'.repeat(32)+'"}',{mode:0o600});
  assert.throws(()=>held.release());assert.equal(existsSync(join(f.files.root,'fence')),true);
});

test('T-SNAPSHOT roster publication invalidates tools current before exported edit commits',async t=>{
  const f=await sourceFixture(t);
  await f.service.setOn(f.identity,'fixture',{expectedVersion:1,on:false},'snapshot-source-edit-0001');
  const lease=f.files.acquire();try{assert.throws(()=>f.files.current(lease,now),'tools cannot consume the old current after roster edit');}finally{lease.release();}
});

test('T-SNAPSHOT roster export pause serializes old-version publication and edit',async t=>{
  const f=await sourceFixture(t);let entered!:()=>void,release!:()=>void;
  const reached=new Promise<void>(r=>{entered=r;}),barrier=new Promise<void>(r=>{release=r;});
  const service=new LoopRosterServiceV1(f.db,scope,{rosterRoot:join(f.root,'roster'),toolsSeed:f.exportPath,check:async()=>({exitCode:0,lines:[]})},()=>now,
    {afterTemporaryWrite:async()=>{entered();await barrier;}},f.coordinator);
  const exporting=service.exportRoster();await reached;
  try{assert.throws(()=>f.files.acquire(),/selection_source_busy/,'paused exporter retains the shared fence');}
  finally{release();}
  assert.equal((await exporting).version,1);
  assert.equal((await f.service.setOn(f.identity,'fixture',{expectedVersion:1,on:false},'snapshot-export-race-0002')).version,2);
  assert.match(await readFile(f.exportPath,'utf8'),/\toff\t/);
});

test('T-SNAPSHOT current comparison refuses raw export and health changes and repeatable-read upgrades',async t=>{
  const f=await sourceFixture(t);
  await assert.rejects(f.db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await f.coordinator.lockSources(tx);}));
  await writeFile(f.exportPath,roster+'changed',{mode:0o600});
  await assert.rejects(f.db.transaction(async tx=>{f.bind(tx);await f.coordinator.assertCurrent(tx,f.snapshot);}));
  await writeFile(f.exportPath,roster,{mode:0o600});
  f.setHealth({...health(),entries:[{model:'fixture',route:'codex',available:false}]});
  await assert.rejects(f.db.transaction(async tx=>{f.bind(tx);await f.coordinator.assertCurrent(tx,f.snapshot);}));
  f.setHealth(health(now+1));await assert.rejects(f.coordinator.capture());
  f.setHealth(health(now-3600001));await assert.rejects(f.coordinator.capture());
  f.setHealth(health());
  const invalidClock=new LoopSelectionSnapshotCoordinatorV1({db:f.db,...scope,sourceFiles:f.files,readRoster:readLoopRosterSnapshotSourceV1,
    clock:{wallNow:()=>now,monotonicNow:()=>NaN}});
  await invalidClock.start();await assert.rejects(invalidClock.capture());
});

test('T-SNAPSHOT source capability captures paths and validator and requires owned raw health',async t=>{
  const f=await sourceFixture(t),file=join(f.root,'config/availability.json');
  const input={availabilityFile:file,rosterFile:f.exportPath,readAvailability:()=>f.health()};
  const files=createLoopSelectionSourceFilesV1(input);input.availabilityFile=join(f.root,'missing');input.readAvailability=()=>health(now+1);
  assert.deepEqual(files.availability(now),health(),'captured validator and file path stay immutable');
  await chmod(file,0o644);assert.throws(()=>files.availability(now));await chmod(file,0o600);
  await writeFile(file,JSON.stringify({...health(),entries:[{model:'fixture',route:'codex',available:false}]}));
  assert.throws(()=>files.availability(now),'raw JSON cannot bypass the authoritative health validator');
});

for (const operation of ['current', 'previous', 'invalidate', 'publish'] as const) {
  test(`T-SNAPSHOT retained lease refuses ${operation} after fence owner changes`, async t => {
    const f = await sourceFixture(t), lease = f.files.acquire();
    const bundle = f.files.current(lease, now);
    const currentPath = join(f.files.root, 'current.json');
    const before = await readFile(currentPath);
    const ownerPath = join(f.files.root, 'fence/owner.json');
    const owner = await readFile(ownerPath);
    try {
      await writeFile(ownerPath, JSON.stringify({schemaVersion: 1, nonce: 'b'.repeat(32)}));
      assert.throws(() => {
        if (operation === 'current' || operation === 'previous') f.files[operation](lease, now);
        else if (operation === 'invalidate') f.files.invalidate(lease);
        else f.files.publish(lease, bundle);
      }, /selection_source_unavailable/, 'foreign fence must refuse before reading or publishing');
      assert.deepEqual(await readFile(currentPath), before);
      assert.equal(existsSync(join(f.files.root, 'dirty.json')), false);
    } finally { await writeFile(ownerPath, owner); lease.release(); }
  });
}

test('T-SNAPSHOT fractional monotonic deadlines accept exactly five seconds and refuse longer windows',async t=>{
  const f=await sourceFixture(t);
  for(const frozenMono of [8191.999999999999,16383.999999999998]){
    const deadlineMono=frozenMono+5000;
    assert.ok(deadlineMono-frozenMono>5000,'vector reproduces subtraction rounding');
    await f.db.transaction(async tx=>{
      assert.doesNotThrow(()=>bindLoopSelectionSourceDeadlineV1(tx,{frozenMono,deadlineMono,frozenWall:f.wall()}));
    });
    await f.db.transaction(async tx=>{
      assert.throws(()=>bindLoopSelectionSourceDeadlineV1(tx,{frozenMono,deadlineMono:deadlineMono+0.000001,frozenWall:f.wall()}),/selection_source_unavailable/);
    });
  }
});

for(const replaced of ['root','fence'] as const){
  test(`T-SNAPSHOT retained lease refuses swapped ${replaced} directory inode`,async t=>{
    const f=await sourceFixture(t),lease=f.files.acquire();
    const path=replaced==='root'?f.files.root:join(f.files.root,'fence'),old=path+'.retained';
    await rename(path,old);await mkdir(path,{mode:0o700});
    // Keep the same owner nonce: only the inode check can detect this replacement.
    if(replaced==='root'){
      await rename(join(old,'fence'),join(path,'fence'));
      await writeFile(join(path,'current.json'),await readFile(join(old,'current.json')),{mode:0o600});
    }
    if(replaced==='fence')await writeFile(join(path,'owner.json'),await readFile(join(old,'owner.json')),{mode:0o600});
    try{
      assert.throws(()=>f.files.current(lease,now),/selection_source_unavailable/,'swapped inode must refuse despite identical nonce');
      assert.throws(()=>lease.release(),/selection_source_unavailable/);
    }finally{
      if(replaced==='root')await rename(join(path,'fence'),join(old,'fence'));
      await rm(path,{recursive:true});await rename(old,path);lease.release();
    }
  });
}

test('T-SNAPSHOT public filesystem refusals are sanitized',async t=>{
  const f=await sourceFixture(t),lease=f.files.acquire();
  await rm(join(f.files.root,'current.json'));
  assert.throws(()=>f.files.current(lease,now),{message:'selection_source_unavailable'});
  assert.equal(f.files.previous(lease,now),undefined,'missing previous is still a normal bootstrap state');
  lease.release();
  await rm(f.exportPath);assert.throws(()=>f.files.rosterText(),{message:'selection_source_unavailable'});
  await rm(join(f.root,'config/availability.json'));assert.throws(()=>f.files.availability(now),{message:'selection_source_unavailable'});
  await assert.rejects(f.db.transaction(tx=>f.coordinator.assertCurrent(tx,{} as any)),{message:'selection_source_unavailable'});
});

test('T-SNAPSHOT release failure after COMMIT reports uncertain outcome and poisons custody',async t=>{
  const f=await sourceFixture(t);let committed=false;
  const base:DatabaseClient={query:f.client.query.bind(f.client),transaction:f.client.transaction.bind(f.client),
    async transactionWithPreCommitCheck(callback,check){
      const result=await f.client.transactionWithPreCommitCheck(callback,check);committed=true;
      await writeFile(join(f.files.root,'fence/owner.json'),'{"schemaVersion":1,"nonce":"'+'b'.repeat(32)+'"}');
      return result;
    }};
  const db=withLoopSelectionSourceTransactionsV1(base,f.files);
  await assert.rejects(db.transaction(async tx=>{f.bind(tx);await f.coordinator.assertCurrent(tx,f.snapshot);
    await tx.query("UPDATE control_loop_roster_state SET updated_at='2026-01-01T00:00:00Z'");
  }),{code:'database_outcome_uncertain',message:'database_outcome_uncertain'});
  assert.equal(committed,true,'database committed before release failed');
  assert.throws(()=>f.files.acquire(),/selection_source_unavailable/,'custody is poisoned after release failure');
});

test('T-SNAPSHOT release failure preserves a confirmed rollback error',async t=>{
  const f=await sourceFixture(t),original=new Error('synthetic transaction refusal');
  const base:DatabaseClient={query:f.client.query.bind(f.client),transaction:f.client.transaction.bind(f.client),
    async transactionWithPreCommitCheck(callback,check){
      try{return await f.client.transactionWithPreCommitCheck(callback,check);}
      catch(error){await writeFile(join(f.files.root,'fence/owner.json'),'{"schemaVersion":1,"nonce":"'+'b'.repeat(32)+'"}');throw error;}
    }};
  const db=withLoopSelectionSourceTransactionsV1(base,f.files);
  await assert.rejects(db.transaction(async tx=>{await f.coordinator.lockSources(tx);throw original;}),error=>error===original);
  assert.throws(()=>f.files.acquire(),/selection_source_unavailable/,'release failure poisons custody even after rollback');
});
