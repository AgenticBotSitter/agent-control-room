import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { register, syncBuiltinESMExports } from 'node:module';
import nativeFs from 'node:fs';
register('./helpers/r7-backup-pg-loader.mjs', import.meta.url);
const { createMacLocalDatabaseBackupV1, MAC_BACKUP_REQUIRED_TABLES_V1, VERIFIED_BACKUP_MANIFEST_V1 } =
  await import('../scripts/ops/backup-database.mjs');
const { readBoundMacLocalDatabaseBackupV1 } = await import('../scripts/ops/verify-database-backup.mjs');
const { backupDatabase } = await import('../deploy/postgres/backup-database.mjs');
const { targetCli } = await import('../deploy/postgres/evidence.mjs');
const { reserveBackupGenerationV1, consumeBackupGenerationV1, assertBackupGenerationV1, releaseBackupGenerationV1, sha256BackupFileV1 } =
  await import('../src/installer/shared/backup-files.mjs');

const d = 'sha256:'+'a'.repeat(64), digest = text=>'sha256:'+createHash('sha256').update(text).digest('hex');
const source = database=>({host:'fixture.invalid',port:5432,database,user:'fixture_login'});
async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR ?? '/tmp','r7-backup-files-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bin=join(root,'bin');await fs.mkdir(bin);
  await fs.writeFile(join(bin,'package.json'),JSON.stringify({type:'module'}));
  // Finite direct-child executable. No sockets, descendants, timers or detachment.
  await fs.writeFile(join(bin,'pg_dump'),`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);
    fs.writeFileSync(a[a.indexOf('--file')+1],a[a.indexOf('-d')+1]);\n`,{mode:0o700});
  return {root,bin,out:join(root,'backup')};
}
const backup=(f,database)=>createMacLocalDatabaseBackupV1({source:source(database),out:f.out,pgBin:f.bin});
const outcome=p=>p.then(value=>({value}),error=>({error: error.code??error.message}));
test('R7B-01: reuse refuses before changing a bound output', {timeout:60000},async t=>{
  const f=await fixture(t);await backup(f,'earlier-owner-data');
  await readBoundMacLocalDatabaseBackupV1(f.out);
  const before=await Promise.all(['database.dump','metadata.json','manifest.json'].map(n=>fs.readFile(join(f.out,n),'utf8')));
  const refused=await outcome(backup(f,'newer-owner-data'));
  const after=await Promise.all(['database.dump','metadata.json','manifest.json'].map(n=>fs.readFile(join(f.out,n),'utf8')));
  const readable=await outcome(readBoundMacLocalDatabaseBackupV1(f.out));
  console.log(JSON.stringify({finding:'R7B-01',refused,dumpChanged:before[0]!==after[0],metadataChanged:before[1]!==after[1],manifestChanged:before[2]!==after[2],readable:!!readable.value}));
  assert.equal(refused.error,'backup_output_exists');
  assert.deepEqual(after,before);assert.ok(readable.value);
});
test('R7B-01: fifty independent outputs work; shared output admits one producer', {timeout:20000},async t=>{
  const f=await fixture(t);let calls=0;
  const outs=Array.from({length:50},(_,i)=>join(f.root,'independent-'+i));
  const independent=await Promise.allSettled(outs.map(out=>createMacLocalDatabaseBackupV1({source:source('same-data'),out,pgBin:f.bin})));
  assert.equal(independent.filter(x=>x.status==='fulfilled').length,50);
  const shared=await Promise.all(Array.from({length:20},(_,i)=>outcome(createMacLocalDatabaseBackupV1({source:source('call-'+i),out:f.out,pgBin:f.bin,
    backup:async input=>{calls++;const {backupDatabase}=await import('../deploy/postgres/backup-database.mjs');return backupDatabase(input);}}))));
  console.log(JSON.stringify({finding:'R7B-01',independent:50,sharedDumps:calls,sharedSucceeded:shared.filter(v=>v.value).length,sharedRefusals:shared.filter(v=>v.error).length}));
  assert.equal(calls,1);assert.equal(shared.filter(x=>x.value).length,1);
  assert.ok(shared.filter(x=>x.error).every(x=>x.error==='backup_output_exists'));
});
test('R7B-01: damaged dump leaf preserves a retained file', {timeout:60000},async t=>{
  const f=await fixture(t);await fs.mkdir(f.out);
  const retained=join(f.root,'retained.dump');await fs.writeFile(retained,'keep-earlier-data');
  await fs.symlink(retained,join(f.out,'database.dump'));
  const r=await outcome(backup(f,'replacement-data'));
  const bytes=await fs.readFile(retained,'utf8');
  console.log(JSON.stringify({finding:'R7B-01',damagedLeaf:r,retainedChanged:bytes!=='keep-earlier-data'}));
  assert.equal(r.error,'backup_output_exists');
  assert.equal(bytes,'keep-earlier-data');
});
test('R7B-02: a sparse two-GiB-plus dump binds and verifies', {timeout:60000},async t=>{
  const f=await fixture(t);const ledger=JSON.parse(await fs.readFile('deploy/postgres/migration-ledger.json','utf8'));
  const metadata={version:1,ledgerDigest:'sha256:'+ledger.digest,identity:{identityDigest:d},evidence:{ledger:[{ledger_order:1,filename:'fixture.sql',digest:d}],roles:[{rolname:'fixture_login'}]}};
  const producer=async ({out})=>{
    await fs.mkdir(out,{recursive:true});const fd=await fs.open(join(out,'database.dump'),'wx');
    try{await fd.truncate(2**31+4096);}finally{await fd.close();}
    await fs.writeFile(join(out,'metadata.json'),JSON.stringify(metadata));return {planned:false,identityDigest:d};
  };
  const created=await outcome(createMacLocalDatabaseBackupV1({source:source('large-data'),out:f.out,pgBin:f.bin,backup:producer}));
  if(!created.value) await fs.writeFile(join(f.out,'manifest.json'),JSON.stringify({schema:VERIFIED_BACKUP_MANIFEST_V1,dumpDigest:d,
    metadataDigest:digest(JSON.stringify(metadata)),restoreIdentityDigest:d,requiredTables:MAC_BACKUP_REQUIRED_TABLES_V1,
    ledger:{digest:metadata.ledgerDigest,head:{order:1,file:'fixture.sql',digest:d}}}));
  const inspected=await outcome(readBoundMacLocalDatabaseBackupV1(f.out));
  const stat=await fs.stat(join(f.out,'database.dump'));
  console.log(JSON.stringify({finding:'R7B-02',bytes:stat.size,allocated:stat.blocks*512,created:!!created.value,inspected:!!inspected.value}));
  assert.ok(created.value);assert.ok(inspected.value);
  assert.equal(created.value.dumpDigest,inspected.value.manifest.dumpDigest);
  // Independently computed SHA-256 of 2**31 + 4096 zero bytes.
  assert.equal(created.value.dumpDigest,'sha256:d702231a97a4e742e747bd3fdc81d8d1b604378660d5fc38934b865ca2a9d6d1');
});
test('R7B-03: failed operator CLIs never print URI credentials', {timeout:60000},async t=>{
  const f=await fixture(t);
  for(const name of ['pg_dump','pg_restore'])await fs.writeFile(join(f.bin,name),`#!${process.execPath}\nprocess.stderr.write(process.env.PGPASSWORD ?? '');process.exit(12);\n`,{mode:0o700});
  // Random synthetic marker stays in memory; only leakage booleans are logged.
  const marker=createHash('sha256').update(String(Math.random())).digest('hex');
  const endpoint='postgresql://fixture_login:'+marker+'@fixture.invalid/fixture_data';
  await fs.mkdir(f.out);
  await fs.writeFile(join(f.out,'metadata.json'),JSON.stringify({version:1,evidence:{roles:[]}}));
  const exec=promisify(execFile),results=[];
  for(const failure of ['native','connect','query']) for(const [entry,args] of [
    ['scripts/ops/backup-database.mjs',['--source',endpoint,'--out',join(f.root,'cli-output-'+failure),'--pg-bin',f.bin]],
    ['deploy/postgres/backup-database.mjs',['--source',endpoint,'--out',join(f.root,'raw-output-'+failure),'--pg-bin',f.bin,'--ledger-digest',d]],
    ['deploy/postgres/restore-database.mjs',['--target',endpoint,'--confirm-target',endpoint,'--backup',f.out,'--pg-bin',f.bin]]]){
    let stderr='',stdout='',code;
    try{await exec(process.execPath,['--loader','./tests/helpers/r7-backup-pg-loader.mjs',entry,...args],{timeout:5000,maxBuffer:65536,
      env:{...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1',NODE_NO_WARNINGS:'1',R7_BACKUP_FAKE_FAILURE:failure}});}
    catch(error){stderr=error.stderr;stdout=error.stdout;code=error.code;}
    const leaks=(stderr+stdout).includes(marker);results.push({entry,failure,code,leaks});
    assert.equal(code,1);assert.equal(leaks,false);
    assert.match(stderr,/_execution_failed/);
  }
  console.log(JSON.stringify({finding:'R7B-03',results}));
});
test('control: wrapped backup rejects empty/truncated data and missing files', {timeout:60000},async t=>{
  const f=await fixture(t);await backup(f,'owner-data');
  await fs.writeFile(join(f.out,'database.dump'),'changed-owner-data');
  await assert.rejects(readBoundMacLocalDatabaseBackupV1(f.out),/database_backup_digest_refused/);
  await fs.writeFile(join(f.out,'database.dump'),'');
  await assert.rejects(readBoundMacLocalDatabaseBackupV1(f.out),/database_backup_file_refused/);
  await fs.rm(join(f.out,'database.dump'));
  await assert.rejects(readBoundMacLocalDatabaseBackupV1(f.out),{code:'ENOENT'});
});

test('R7B-01: raw backup reserves before connection and refuses every existing output', {timeout:20000}, async t => {
  const f = await fixture(t);
  const invoke = out => backupDatabase({source:source('raw-data'),out,pgBin:f.bin,ledgerDigest:d});
  await invoke(f.out);
  const before = await Promise.all(['database.dump','metadata.json','manifest.json'].map(n=>fs.readFile(join(f.out,n))));
  let connects = 0;
  await assert.rejects(backupDatabase({source:source('replacement'),out:f.out,pgBin:f.bin,ledgerDigest:d,
    connect:()=>{connects++;throw Error('must not connect');}}), /backup_output_exists/);
  assert.equal(connects,0);
  assert.deepEqual(await Promise.all(['database.dump','metadata.json','manifest.json'].map(n=>fs.readFile(join(f.out,n)))),before);
  const empty = join(f.root,'empty'); await fs.mkdir(empty);
  await assert.rejects(invoke(empty), /backup_output_exists/);
  const linked = join(f.root,'linked'); await fs.symlink(f.out,linked);
  await assert.rejects(invoke(linked), /backup_output_exists/);
  const parent = join(f.root,'linked-parent'); await fs.symlink(f.root,parent);
  await assert.rejects(invoke(join(parent,'uncreated')), /backup_output_path_refused/);
  assert.equal((await fs.stat(f.out)).mode & 0o777,0o700);
  const shared = join(f.root,'shared-raw');
  const results = await Promise.allSettled(Array.from({length:50},()=>invoke(shared)));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.ok(results.filter(x=>x.status==='rejected').every(x=>x.reason.message==='backup_output_exists'));
});

test('R7B-01: reservation capability rejects reuse, forgery, replacement, contents and mode changes', {timeout:10000}, async t => {
  const f=await fixture(t);
  await assert.rejects(consumeBackupGenerationV1(f.out,{}),/backup_output_reservation_refused/);
  const token=await reserveBackupGenerationV1(f.out);
  t.after(()=>releaseBackupGenerationV1?.(token));
  await assert.rejects(consumeBackupGenerationV1(join(f.root,'other'),token),/backup_output_reservation_refused/);
  await consumeBackupGenerationV1(f.out,token);
  await assert.rejects(consumeBackupGenerationV1(f.out,token),/backup_output_reservation_refused/);
  for(const alteration of ['replace','contents','mode','link']) {
    const out=join(f.root,alteration), cap=await reserveBackupGenerationV1(out);
    t.after(()=>releaseBackupGenerationV1?.(cap));
    if(alteration==='replace'){await fs.rename(out,out+'-old');await fs.mkdir(out,{mode:0o700});}
    if(alteration==='contents')await fs.writeFile(join(out,'old.dump'),'retained');
    if(alteration==='mode')await fs.chmod(out,0o755);
    if(alteration==='link'){await fs.rename(out,out+'-old');await fs.symlink(out+'-old',out);}
    await assert.rejects(consumeBackupGenerationV1(out,cap),/backup_output_reservation_refused/);
  }
  await assert.rejects(reserveBackupGenerationV1('.'),/backup_output_path_refused/);
  await assert.rejects(reserveBackupGenerationV1(join(f.root,'missing','generation')), {code:'ENOENT'});
});

test('R7B-01: partial dump failure is quarantined; fresh retry succeeds and prior bytes survive', {timeout:10000}, async t => {
  const f=await fixture(t);await backup(f,'prior');
  const prior=await fs.readFile(join(f.out,'database.dump'));
  const partial=join(f.root,'partial');
  await assert.rejects(createMacLocalDatabaseBackupV1({source:source('new'),out:partial,pgBin:f.bin,
    backup:async({out})=>{await fs.writeFile(join(out,'database.dump'),'half');throw Error('injected stop halfway');}}),/injected stop halfway/);
  await assert.rejects(backup({...f,out:partial},'retry'),/backup_output_exists/);
  assert.equal(await fs.readFile(join(partial,'database.dump'),'utf8'),'half');
  await backup({...f,out:join(f.root,'fresh-retry')},'retry');
  assert.deepEqual(await fs.readFile(join(f.out,'database.dump')),prior);
});

test('R7B-02: bounded hashing refuses symlinks, empty files, directories and races', {timeout:10000}, async t => {
  const f=await fixture(t), path=join(f.root,'hash.dump');
  await fs.writeFile(path,'fixture-bytes');
  assert.equal(await sha256BackupFileV1(path),digest('fixture-bytes'));
  await fs.symlink(path,path+'.link');
  await assert.rejects(sha256BackupFileV1(path+'.link'),/backup_file_refused/);
  await fs.writeFile(path+'.empty','');
  await assert.rejects(sha256BackupFileV1(path+'.empty'),/backup_file_refused/);
  await assert.rejects(sha256BackupFileV1(f.root),/backup_file_refused/);
  const originalOpen=nativeFs.promises.open;
  try {
    for(const race of ['link','replace','content','leaf-after-read']) {
      await fs.writeFile(path,'fixture-bytes');
      nativeFs.promises.open=async(p,...args)=>{
        if(p===path && ['link','replace'].includes(race)) {
          await fs.rename(path,path+'.retained-'+race);
          if(race==='link')await fs.symlink(path+'.retained-'+race,path);
          else await fs.writeFile(path,'replacement');
        }
        const handle=await originalOpen(p,...args);
        if(p===path && ['content','leaf-after-read'].includes(race)) {
          const read=handle.read.bind(handle);let once=true;
          handle.read=async(...values)=>{
            const result=await read(...values);
            if(once){once=false;
              if(race==='content')await fs.writeFile(path,'changed-bytes');
              else{await fs.rename(path,path+'.after');await fs.writeFile(path,'fixture-bytes');}
            }
            return result;
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      await assert.rejects(sha256BackupFileV1(path),error=>race==='link' ? error.code==='ELOOP' : ['backup_file_refused','backup_file_changed'].includes(error.message));
      if(race==='link')await fs.unlink(path);
      nativeFs.promises.open=originalOpen;syncBuiltinESMExports();
    }
  } finally {nativeFs.promises.open=originalOpen;syncBuiltinESMExports();}
});

test('R7B-03: URI and keyword credentials stay in environment; non-secret options survive', {timeout:10000}, () => {
  const marker=createHash('sha256').update(String(Math.random())).digest('hex');
  for(const endpoint of [
    'postgresql://fixture:'+marker+'@fixture.invalid:5439/db?sslmode=require',
    'postgresql://fixture:overridden@fixture.invalid/db?password='+marker+'&application_name=backup',
    "host=fixture.invalid port=5439 dbname='fixture data' user=fixture password='"+marker+"' sslmode=require"
  ]) {
    const cli=targetCli(endpoint);
    assert.equal(cli.args.join(' ').includes(marker),false);
    assert.equal(cli.env.PGPASSWORD,marker);
    assert.match(cli.args.join(' '),/fixture/);
  }
  const cli=targetCli('postgresql://fixture:p%40ss%3Aword@fixture.invalid/db');
  assert.equal(cli.env.PGPASSWORD,'p@ss:word');
  assert.equal(cli.args.join(' ').includes('p%40ss'),false);
  const multi=targetCli('postgresql://fixture:'+marker+'@host1:5432,host2:5433/db?sslmode=require');
  assert.equal(multi.args[1],'postgresql://fixture@host1:5432,host2:5433/db?sslmode=require');
  assert.equal(multi.env.PGPASSWORD,marker);
  const socket=targetCli('postgresql://fixture:'+marker+'@%2Fsocket/db');
  assert.equal(socket.args[1],'postgresql://fixture@%2Fsocket/db');
  assert.equal(socket.env.PGPASSWORD,marker);
  assert.equal(targetCli('postgresql:///db?password=a+b').env.PGPASSWORD,'a+b');
  assert.throws(()=>targetCli('http://fixture.invalid'),/target_connection_string_invalid/);
  assert.throws(()=>targetCli('postgresql://fixture:%ZZ@fixture.invalid/db'),/target_connection_string_invalid/);
});

test('R7B-03: verifier failure never echoes path credentials and never starts a cluster', {timeout:10000}, async t => {
  const f=await fixture(t), marker=createHash('sha256').update(String(Math.random())).digest('hex');
  let result;
  try { await promisify(execFile)(process.execPath,['scripts/ops/verify-database-backup.mjs','--backup',join(f.root,marker),'--port','15620','--pg-bin',f.bin],
    {timeout:5000,env:{...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'}}); }
  catch(error){result=error;}
  assert.equal(result?.code,1);
  assert.equal((result.stdout+result.stderr).includes(marker),false);
  assert.match(result.stderr,/database_backup_verification_failed/);
});

test('R7B-01: dropped dump child stops halfway, leaves no bound manifest and permits a fresh retry', {timeout:10000}, async t => {
  const f=await fixture(t);
  await fs.writeFile(join(f.bin,'pg_dump'),`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('--file')+1],'half');process.stdin.on('end',()=>process.exit(0));process.stdin.resume();\n`,{mode:0o700});
  await assert.rejects(backupDatabase({source:source('stopped'),out:f.out,pgBin:f.bin,ledgerDigest:d,dumpTimeoutMs:500}),/nightly_backup_dump_timeout:500/);
  assert.equal(await fs.readFile(join(f.out,'database.dump'),'utf8'),'half');
  await assert.rejects(fs.stat(join(f.out,'manifest.json')),{code:'ENOENT'});
  await assert.rejects(backup(f,'retry'),/backup_output_exists/);
  await fs.writeFile(join(f.bin,'pg_dump'),`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('--file')+1],'complete');\n`,{mode:0o700});
  const fresh=join(f.root,'after-stop');await backup({...f,out:fresh},'retry');
  await readBoundMacLocalDatabaseBackupV1(fresh);
});

test('R7B-01: nightly reservation reaches the real producer through the dependency-free runner', {timeout:10000}, async t => {
  const f=await fixture(t);
  const {createNightlyBackupConfigurationV1}=await import('../src/installer/v1/nightly-backup-configuration.ts');
  const {runNightlyBackupV1}=await import('../src/installer/v1/nightly-backup.ts');
  const cfg=createNightlyBackupConfigurationV1(f.root), path=join(f.root,'Protected/config/backup.json');
  await fs.mkdir(join(f.root,'Protected/config/database-passwords'),{recursive:true});
  await fs.mkdir(join(f.root,'Protected/runtime-state/nightly-backup'),{recursive:true});
  await fs.mkdir(cfg.outputRoot,{recursive:true});
  await fs.writeFile(path,JSON.stringify(cfg));
  await fs.writeFile(cfg.database.passwordFile,'fixture\n',{mode:0o600});
  await runNightlyBackupV1(path,{now:()=> '2026-10-02T02:30:00.000Z',backup:input=>backupDatabase({...input,pgBin:f.bin})});
  const out=join(cfg.outputRoot,'2026-10-02T02-30-00-000Z');
  await readBoundMacLocalDatabaseBackupV1(out);
  await assert.rejects(runNightlyBackupV1(path,{now:()=> '2026-10-02T02:30:00.000Z',backup:()=>{throw Error('must not produce');}}),/nightly_backup_output_refused/);
});

test('R7B-01: metadata publication refuses an injected retained leaf', {timeout:10000}, async t => {
  const f=await fixture(t), retained=join(f.root,'retained-metadata');
  await fs.writeFile(retained,'prior-metadata');
  await fs.writeFile(join(f.bin,'pg_dump'),`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(2),out=a[a.indexOf('--file')+1];fs.writeFileSync(out,'complete');fs.symlinkSync(${JSON.stringify(retained)},path.join(path.dirname(out),'metadata.json'));\n`,{mode:0o700});
  await assert.rejects(backupDatabase({source:source('new'),out:f.out,pgBin:f.bin,ledgerDigest:d}),{code:'EEXIST'});
  assert.equal(await fs.readFile(retained,'utf8'),'prior-metadata');
});

test('R7B-01: an upstream reserved generation passes through the wrapper once', {timeout:10000}, async t => {
  const f=await fixture(t), generation=await reserveBackupGenerationV1(f.out);
  t.after(()=>releaseBackupGenerationV1?.(generation));
  await createMacLocalDatabaseBackupV1({source:source('upgrade-data'),out:f.out,pgBin:f.bin,generation});
  const before=await fs.readFile(join(f.out,'database.dump'));
  await assert.rejects(createMacLocalDatabaseBackupV1({source:source('second'),out:f.out,pgBin:f.bin,generation}),/backup_output_reservation_refused/);
  assert.deepEqual(await fs.readFile(join(f.out,'database.dump')),before);
  await readBoundMacLocalDatabaseBackupV1(f.out);
});

test('R7B-01: wrapper refuses forged reservations before invoking its producer', {timeout:10000}, async t => {
  const f=await fixture(t);let calls=0;
  await assert.rejects(createMacLocalDatabaseBackupV1({source:source('invalid'),out:f.out,pgBin:f.bin,generation:{},
    backup:async()=>{calls++;return {planned:true};}}),/backup_output_reservation_refused|ENOENT/);
  assert.equal(calls,0);
});


test('a recreated backup generation folder is refused', {timeout:30000}, async t => {
  const f = await fixture(t);
  for (const consumed of [false, true]) {
    const out = join(f.root, consumed ? 'after-consume' : 'before-consume');
    const token = await reserveBackupGenerationV1(out);
    try {
      if (consumed) await consumeBackupGenerationV1(out, token);
      const original = await fs.lstat(out);
      for (let cycle = 0; cycle < 200; cycle++) {
        await fs.rmdir(out);
        await fs.mkdir(out, {mode:0o700});
        const replacement = await fs.lstat(out);
        if (cycle === 0) console.log(JSON.stringify({consumed, originalInode:original.ino,
          replacementInode:replacement.ino, device:original.dev}));
        await assert.rejects(consumed ? assertBackupGenerationV1(out, token)
          : consumeBackupGenerationV1(out, token), /backup_output_reservation_refused/,
        'a recreated generation must never be accepted');
        // A consumed token is one-shot; also exercise the path identity reader on every cycle.
        await assert.rejects(assertBackupGenerationV1(out, token), /backup_output_reservation_refused/);
      }
    } finally { if (releaseBackupGenerationV1) await releaseBackupGenerationV1(token); }
  }
});


// Observe real kernel handles; never replace filesystem answers with a stand-in.
async function observeReservationHandles(body, ignoredDirectory) {
  const originalOpen = nativeFs.promises.open, handles = [];
  nativeFs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if ((await handle.stat()).isDirectory() && args[0] !== ignoredDirectory) {
      const close = handle.close.bind(handle);
      handle.reservationCloseCalls = 0;
      handle.close = () => { handle.reservationCloseCalls++; return close(); };
      handles.push(handle);
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await body(handles); }
  finally {
    nativeFs.promises.open = originalOpen;
    syncBuiltinESMExports();
    // Also clean up after a failed mutation assertion.
    await Promise.all(handles.map(handle => handle.close()));
  }
}
const closedReservationHandles = async handles => {
  for (const handle of handles) await assert.rejects(handle.stat(), {code:'EBADF'},
    'every reservation descriptor must be closed');
};

test('reservation release is idempotent and invalidates both readers', {timeout:10000}, async t => {
  const f = await fixture(t);
  assert.equal(typeof releaseBackupGenerationV1, 'function', 'reservation owner needs an explicit release');
  await observeReservationHandles(async handles => {
    const token = await reserveBackupGenerationV1(f.out);
    assert.equal(handles.length, 1, 'reservation must hold one real directory descriptor');
    await consumeBackupGenerationV1(f.out, token);
    await assertBackupGenerationV1(f.out, token);
    await assert.doesNotReject(async () => handles[0].stat(), 'consume must keep a live original directory descriptor');
    assert.equal((await handles[0].stat()).isDirectory(), true, 'consume keeps the original directory alive');
    await Promise.all([releaseBackupGenerationV1(token), releaseBackupGenerationV1(token)]);
    await releaseBackupGenerationV1(token);
    await closedReservationHandles(handles);
    assert.equal(handles[0].reservationCloseCalls, 1, 'concurrent and repeated release closes the owned handle once');
    const fresh = join(f.root, 'released-before-consume'), unused = await reserveBackupGenerationV1(fresh);
    try {
      await releaseBackupGenerationV1(unused);
      await assert.rejects(consumeBackupGenerationV1(fresh, unused), /backup_output_reservation_refused/,
        'release must refuse even the first consume');
    } finally { await releaseBackupGenerationV1(unused); }
    await assert.rejects(assertBackupGenerationV1(f.out, token), /backup_output_reservation_refused/);
    await assert.rejects(consumeBackupGenerationV1(f.out, token), /backup_output_reservation_refused/);
    await releaseBackupGenerationV1({});
    await releaseBackupGenerationV1(undefined);
    await closedReservationHandles(handles);
  });
});

test('reservation acquisition closes handles on raced identity, type, mode and stat failures', {timeout:10000}, async t => {
  const f = await fixture(t);
  assert.equal(typeof releaseBackupGenerationV1, 'function', 'reservation acquisition must hold and release a descriptor');
  const originalOpen = nativeFs.promises.open, originalLstat = nativeFs.promises.lstat;
  for (const change of ['identity', 'type', 'link', 'mode', 'stat', 'type-before-stat']) {
    const out = join(f.root, change);
    let held;
    nativeFs.promises.lstat = async (path, ...args) => {
      if (path === out && change === 'type-before-stat') {
        await fs.rmdir(out);
        await fs.writeFile(out, 'not a directory', {mode:0o700});
      }
      return originalLstat(path, ...args);
    };
    nativeFs.promises.open = async (path, ...args) => {
      if (path === out && ['identity', 'type', 'link'].includes(change)) {
        await fs.rename(out, out + '-original');
        if (change === 'identity') await fs.mkdir(out, {mode:0o700});
        else if (change === 'link') await fs.symlink(out + '-original', out);
        else await fs.writeFile(out, 'not a directory');
      }
      held = await originalOpen(path, ...args);
      if (path === out && change === 'mode') await fs.chmod(out, 0o755);
      if (path === out && change === 'stat') held.stat = async () => { throw Error('injected stat failure'); };
      return held;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(reserveBackupGenerationV1(out), change === 'stat'
        ? /injected stat failure/ : error => error.message === 'backup_output_reservation_refused' || ['ENOTDIR','ELOOP'].includes(error.code));
      if (held) assert.equal(held.fd, -1, 'acquisition failure must close its real descriptor');
    } finally {
      nativeFs.promises.open = originalOpen;
      nativeFs.promises.lstat = originalLstat;
      syncBuiltinESMExports();
      if (held) await held.close();
    }
  }
});

test('200 reserve and caller failure cycles leave no reservation descriptors open', {timeout:30000}, async t => {
  const f = await fixture(t);
  assert.equal(typeof releaseBackupGenerationV1, 'function', 'callers need explicit reservation release');
  await observeReservationHandles(async handles => {
    for (let cycle = 0; cycle < 200; cycle++) {
      const out = join(f.root, 'failed-' + cycle);
      await assert.rejects(createMacLocalDatabaseBackupV1({source:source('fail'),out,pgBin:f.bin,
        backup:async () => { throw Error('injected producer failure'); }}), /injected producer failure/);
      await closedReservationHandles(handles.slice(cycle));
    }
    assert.equal(handles.length, 200, 'each failure must actually reserve and open a directory');
    await backup(f, 'success');
    await readBoundMacLocalDatabaseBackupV1(f.out);
    await closedReservationHandles(handles);
    const {state} = await import('./helpers/r7-backup-fake-pg.mjs');
    const connects = state.connections;
    const priorFailure = process.env.R7_BACKUP_FAKE_FAILURE;
    try {
      process.env.R7_BACKUP_FAKE_FAILURE = 'connect';
      await assert.rejects(backupDatabase({source:source('raw-failure'),out:join(f.root,'raw-failure'),
        pgBin:f.bin,ledgerDigest:d}), /failed:/);
    } finally {
      if (priorFailure === undefined) delete process.env.R7_BACKUP_FAKE_FAILURE;
      else process.env.R7_BACKUP_FAKE_FAILURE = priorFailure;
    }
    assert.equal(state.connections, connects + 1, 'raw failure reaches the producer connection');
    await closedReservationHandles(handles);
    await backupDatabase({source:source('raw-success'),out:join(f.root,'raw-success'),pgBin:f.bin,ledgerDigest:d});
    await closedReservationHandles(handles);
    await assert.rejects(backupDatabase({source:source('early'),out:join(f.root,'early'),ledgerDigest:d}), /backup_refused_no_pg_bin/);
    assert.equal((await backupDatabase({})).planned, true);
    await closedReservationHandles(handles);
    assert.equal(handles.length, 203, 'early refusals and plan-only calls must not allocate a descriptor');
  });
});

test('nightly reservation releases on success, backup failure, unbound output and retention failure', {timeout:30000}, async t => {
  const f = await fixture(t);
  assert.equal(typeof releaseBackupGenerationV1, 'function', 'nightly owns reservation release');
  const {createNightlyBackupConfigurationV1} = await import('../src/installer/v1/nightly-backup-configuration.ts');
  const {runNightlyBackupV1} = await import('../src/installer/v1/nightly-backup.ts');
  const cfg = createNightlyBackupConfigurationV1(f.root), path = join(f.root,'Protected/config/backup.json');
  await fs.mkdir(join(f.root,'Protected/config/database-passwords'), {recursive:true});
  await fs.mkdir(join(f.root,'Protected/runtime-state/nightly-backup'), {recursive:true});
  await fs.mkdir(cfg.outputRoot, {recursive:true});
  await fs.writeFile(path, JSON.stringify(cfg));
  await fs.writeFile(cfg.database.passwordFile, 'fixture\n', {mode:0o600});
  await observeReservationHandles(async handles => {
    let day = 1;
    for (const failure of ['success', 'backup', 'unbound', 'retention']) {
      const stamp = `2026-10-0${day++}T02:30:00.000Z`;
      const overrides = {now:()=>stamp,backup:input=>backupDatabase({...input,pgBin:f.bin})};
      if (failure === 'backup') overrides.backup = async () => { throw Error('injected backup failure'); };
      if (failure === 'unbound') overrides.readGeneratedGeneration = async () => ({bound:false});
      if (failure === 'retention') overrides.listBackups = async () => { throw Error('injected retention failure'); };
      if (failure === 'success') await runNightlyBackupV1(path, overrides);
      else await assert.rejects(runNightlyBackupV1(path, overrides), new RegExp('nightly_backup_' +
        ({backup:'execution_failed',unbound:'unbound_generation',retention:'retention_failed'}[failure])));
      await closedReservationHandles(handles);
    }
    assert.equal(handles.length, 4, 'all four exits must reach real reservation');
  }, cfg.outputRoot);
});

// Direct children keep stdin attached. Read results on close after stdout drains;
// the test finally kills only its children, and the outer run owns their group.
function reservationChild(out) {
  const module = new URL('../src/installer/shared/backup-files.mjs', import.meta.url).href;
  const script = `import {once} from 'node:events';
    const api=await import(${JSON.stringify(module)});let token;
    const input=process.stdin;input.setEncoding('utf8');input.resume();
    console.log('ready');await once(input,'data');
    try { token=await api.reserveBackupGenerationV1(process.argv[1]);console.log('held');
      await once(input,'data');console.log('released');
    } catch(error) { console.log(error.message); }
    finally { if(token) await api.releaseBackupGenerationV1(token);input.pause(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module','-e',script,out], {stdio:['pipe','pipe','pipe']});
  let output = '', stderr = '';
  child.stdin.on('error', () => {});
  child.stderr.on('data', data => { stderr += data; });
  const waiters = [];
  child.stdout.on('data', data => {
    output += data;
    for (const [pattern, resolve] of waiters) if (pattern.test(output)) resolve();
  });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({code,signal,output,stderr}));
  });
  return {child, closed, held:()=>/^held/m.test(output), wait:pattern=>pattern.test(output) ? Promise.resolve()
    : Promise.race([new Promise(resolve=>waiters.push([pattern,resolve])),
      closed.then(result=>{if (!pattern.test(result.output)) throw Error('child closed before barrier: ' + result.stderr);})])};
}

test('50 concurrent process reservations admit one held generation and 49 actual refusals', {timeout:60000}, async t => {
  const f = await fixture(t);
  assert.equal(typeof releaseBackupGenerationV1, 'function', 'cross-process owner needs release');
  const children = Array.from({length:50},()=>reservationChild(f.out));
  try {
    await Promise.all(children.map(c=>c.wait(/^ready/m)));
    for (const c of children) c.child.stdin.write('go\n');
    await Promise.all(children.map(c=>c.wait(/^held|^backup_output_exists/m)));
    for (const c of children) if (c.held()) c.child.stdin.end('finish\n');
    const results = await Promise.all(children.map(c=>c.closed));
    assert.equal(results.filter(r=>/^held/m.test(r.output)).length, 1, 'one process holds the reservation');
    assert.equal(results.filter(r=>/^backup_output_exists/m.test(r.output)).length, 49, 'all losing branches actually ran');
    assert.ok(results.every(r=>r.code === 0 && r.stderr === ''), 'all direct children finish and close their descriptors');
    await assert.rejects(reserveBackupGenerationV1(f.out), /backup_output_exists/);
  } finally {
    for (const c of children) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    await Promise.all(children.map(c=>c.closed));
  }
});

test('killed reservation owner leaves a refused partial folder and fresh retry works', {timeout:15000}, async t => {
  const f = await fixture(t);
  assert.equal(typeof releaseBackupGenerationV1, 'function', 'retry owner needs explicit release');
  const c = reservationChild(f.out);
  try {
    await c.wait(/^ready/m);
    c.child.stdin.write('go\n');
    await c.wait(/^held/m);
    c.child.kill('SIGKILL');
    const killed = await c.closed;
    assert.equal(killed.signal, 'SIGKILL', 'stop the actual holder before it releases');
    await assert.rejects(reserveBackupGenerationV1(f.out), /backup_output_exists/);
    const fresh = join(f.root, 'fresh-after-kill'), token = await reserveBackupGenerationV1(fresh);
    try { await consumeBackupGenerationV1(fresh, token); await assertBackupGenerationV1(fresh, token); }
    finally { await releaseBackupGenerationV1(token); }
    await fs.rmdir(f.out);
    const replacement = await reserveBackupGenerationV1(f.out);
    try { await consumeBackupGenerationV1(f.out, replacement); }
    finally { await releaseBackupGenerationV1(replacement); }
  } finally {
    if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    await c.closed;
  }
});


test('borrowed reservation remains live through wrapper success and failure', {timeout:10000}, async t => {
  const f = await fixture(t);
  assert.equal(typeof releaseBackupGenerationV1, 'function', 'the upstream owner controls release');
  await observeReservationHandles(async handles => {
    const generation = await reserveBackupGenerationV1(f.out);
    try {
      await assert.doesNotReject(createMacLocalDatabaseBackupV1({source:source('borrowed'),out:f.out,
        pgBin:f.bin,generation}), 'borrowers must keep the reservation live through final publication');
      await assert.doesNotReject(assertBackupGenerationV1(f.out, generation),
        'upstream reservation must remain valid after wrapper success');
      await assert.doesNotReject(handles[0].stat(), 'the upstream handle must remain open after wrapper success');
      assert.equal((await handles[0].stat()).isDirectory(), true, 'the upstream handle is still live after wrapper success');
      await assert.rejects(createMacLocalDatabaseBackupV1({source:source('borrowed-failure'),out:f.out,
        pgBin:f.bin,generation,backup:async()=>{throw Error('injected borrowed failure');}}), /injected borrowed failure/);
      await assert.doesNotReject(handles[0].stat(), 'failure must return a live handle to the upstream owner');
      assert.equal((await handles[0].stat()).isDirectory(), true, 'failure returns handle ownership to the upstream caller');
    } finally { await releaseBackupGenerationV1(generation); }
    await closedReservationHandles(handles);
  });
});


test('reservation holds valid long and spaced paths and refuses a linked parent', {timeout:10000}, async t => {
  const f = await fixture(t);
  assert.equal(typeof releaseBackupGenerationV1, 'function', 'layout variants require the same owner release');
  const parent = join(f.root, 'space and unicode-\u03bb', 'a'.repeat(120), 'b'.repeat(120), 'c'.repeat(120));
  await fs.mkdir(parent, {recursive:true,mode:0o700});
  const out = join(parent, 'generation');
  await assert.rejects(fs.lstat(out), {code:'ENOENT'}, 'setup must leave the generation absent');
  const token = await reserveBackupGenerationV1(out);
  try {
    assert.equal((await fs.lstat(out)).mode & 0o777, 0o700);
    await consumeBackupGenerationV1(out, token);
    await assertBackupGenerationV1(out, token);
  } finally { await releaseBackupGenerationV1(token); }
  const linked = join(f.root, 'linked-parent');
  await fs.symlink(parent, linked);
  await assert.rejects(reserveBackupGenerationV1(join(linked, 'other-generation')), /backup_output_path_refused/);
  await assert.rejects(fs.lstat(join(parent, 'other-generation')), {code:'ENOENT'}, 'refusal must not create state');
});
