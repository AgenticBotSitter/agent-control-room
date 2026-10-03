import nativeFs from 'node:fs';
import {acquirePrivateProcessLockV1} from '../src/installer/shared/private-process-lock.mjs';
import { generateInstallationReleaseKeyV1 } from '../scripts/release-signing.mjs';
import { verifyPostgresShutdownV1 } from '../src/updater/v1/services/elevated.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, fakePorts, rehearsalConfig } from './helpers/installer-round2-fixture.mjs';
import { installControlRoomV1, CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1 } from '../src/updater/v1/install/installer.mjs';
import { assertNoLiveRehearsalCollisionsV1 } from '../src/updater/v1/install/rehearsal-config.mjs';
import { makeOwnerPasteFile } from '../scripts/install/make-owner-paste-file.mjs';
import { parseInstallerArgumentsV1, runUpdaterCliV1 } from '../src/updater/v1/cli.mjs';
import { recordPasskeyStatusV1 } from '../src/updater/v1/pg/initial-passkey-ports.mjs';

const outcome = async promise => promise.then(value => value.state ?? 'ok', error => error.code ?? error.message);
const journal = async f => (await fs.readFile(join(f.root, 'updater-state', CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), 'utf8'))
  .trim().split('\n').map(JSON.parse);

test('R2-01: ENOSPC during release signing metadata leaves no partial final file and permits install retry', async t => {
  for (const name of ['release-signing-key.pem', 'release-signing.json', 'release-trust.json']) {
    const f = await fixture(t, 'torn-release-metadata');
    const original = fs.open;
    let hit = false;
    fs.open = async (...args) => {
      const handle = await original(...args);
      if (!hit && (String(args[0]).endsWith('/' + name) || String(args[0]).includes('/.' + name + '.publish-')) && (args[1] === 'wx' || String(args[0]).includes('.publish-'))) {
        hit = true;
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async bytes => {
          await write(Buffer.from(bytes).subarray(0, 12));
          throw Object.assign(new Error('disk_full'), {code: 'ENOSPC'});
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    let first;
    try { first = await outcome(installControlRoomV1(f.options)); }
    finally { fs.open = original; syncBuiltinESMExports(); }
    assert.equal(hit, true);
    assert.equal(first, 'ENOSPC');
    const retries = [];
    for (let i = 0; i < 2; i++) retries.push(await outcome(installControlRoomV1({...f.options, ...(i ? {bootstrap:undefined} : {})})));
    assert.deepEqual(retries, ['installed', 'commit_already_installed']);
    console.log(JSON.stringify({id:'R2-01', file:name, first, retries}));
  }
});

test('R2-02: SIGKILL after switching a repeat release recovers the pointer snapshot and validates the retry', async t => {
  const f = await fixture(t, 'switch-gap');
  await installControlRoomV1(f.options);
  const old = await fs.readlink(join(f.root, 'current'));
  const options = {...f.options, commit:'b'.repeat(40), bootstrap:undefined, ports:undefined, terminal:undefined};
  const child = spawn(process.execPath, ['tests/helpers/installer-round2-crash-switch.mjs'], {detached:true, stdio:['pipe','pipe','pipe']});
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({code,signal})); });
    child.stdin.end(JSON.stringify(options));
    const result = await exited;
    assert.equal(result.signal, 'SIGKILL', errors);
  } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  const current = await fs.readlink(join(f.root, 'current'));
  assert.notEqual(current, old);
  const before = await journal(f), id = before.filter(row => row.action === 'transaction' && row.phase === 'planned').at(-1).transactionId;
  assert.equal(before.some(row => row.transactionId === id && row.action === 'switch-pointers' && row.phase === 'done'), false);
  const start = f.ports.calls.length;
  const retry = await outcome(installControlRoomV1({...options, ports:f.ports}));
  assert.equal(retry, 'installed');
  assert.equal(await fs.readlink(join(f.root, 'current')), current);
  const calls = f.ports.calls.slice(start).map(row => row[0]);
  assert.equal(calls.includes('health'), true);
  assert.ok(calls.includes('switch-pair'));
  assert.equal(await fs.readlink(join(f.root, 'previous')), old);
  
});

test('HELD: fifty concurrent callers on aged abandoned takeover markers', async t => {
  let largest = 0, successes = 0, allResults = [];
  for (let round = 0; round < 8; round++) {
    const f = await fixture(t, 'old-takeover');
    await fs.mkdir(f.root, {recursive:true});
    await fs.writeFile(join(f.root, '.install.lock'), JSON.stringify({pid:2147483000, token:'dead', identity:'dead'}), {mode:0o600});
    const marker = join(f.root, '.install.lock.takeover-dead');
    await fs.mkdir(marker, {mode:0o700});
    await fs.utimes(marker, new Date(0), new Date(0));
    let inside = 0;
    const results = await Promise.all(Array.from({length:50}, (_, index) => {
      const ports = fakePorts({idStart:1000000 + round*100000 + index*1000, buildGate:async () => {
        inside++; largest = Math.max(largest, inside);
        await new Promise(resolve => setTimeout(resolve, 60)); inside--;
      }});
      ports.randomId = randomUUID;
      return outcome(installControlRoomV1({...f.options, ports}));
    }));
    successes += results.filter(value => value === 'installed').length;
    allResults.push(Object.fromEntries([...new Set(results)].map(value => [value, results.filter(v => v === value).length])));
  }
  assert.equal(largest, 1);
  console.log(JSON.stringify({id:'HELD-LOCK-BURST', largest, successes, rounds:allResults}));
});

test('R2-03: a paused live takeover older than sixty seconds preserves exclusivity', async t => {
  const f = await fixture(t, 'paused-takeover');
  await fs.mkdir(f.root, {recursive:true});
  const lock = join(f.root, '.install.lock');
  await fs.writeFile(lock, JSON.stringify({pid:2147483000, token:'old', identity:'dead'}), {mode:0o600});
  const original = fs.open;
  let reads = 0, releaseRead, readEntered;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const reading = new Promise(resolve => { readEntered = resolve; });
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]) === lock && ++reads === 2) {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...readArgs) => { const bytes = await read(...readArgs); readEntered(); await readGate; return bytes; };
    }
    return handle;
  };
  syncBuiltinESMExports();
  let releaseBuild, enteredB;
  const buildGate = new Promise(resolve => { releaseBuild = resolve; });
  const insideB = new Promise(resolve => { enteredB = resolve; });
  let inside = 0, most = 0;
  const portsA = fakePorts({idStart:6100000, buildGate:async () => { inside++; most=Math.max(most,inside); await buildGate; inside--; }});
  const portsB = fakePorts({idStart:6200000, buildGate:async () => { inside++; most=Math.max(most,inside); enteredB(); await buildGate; inside--; }});
  let first, second;
  try {
    first = outcome(installControlRoomV1({...f.options, ports:portsA}));
    await reading;
    // Model a slow disk or suspended installer that passes the age threshold.
    await fs.utimes(join(f.root,'.install.lock.takeover-old'), new Date(0), new Date(0));
    second = outcome(installControlRoomV1({...f.options, ports:portsB}));
    await Promise.race([insideB, second]);
    releaseRead();
    for (let i=0; i<5 && most<2; i++) await new Promise(resolve => setTimeout(resolve,10));
  } finally {
    releaseRead(); releaseBuild(); fs.open=original; syncBuiltinESMExports();
  }
  const results = await Promise.all([first,second]);
  assert.equal(most, 1);
  assert.equal(results[1], 'install_already_running');
  assert.equal(results[0], 'installed');
  console.log(JSON.stringify({id:'R2-03', concurrentHolders:most, results}));
});

test('R2-08: repeating install for a new commit retains the persisted stopped passkey warning', async t => {
  const f = await fixture(t,'repeat-passkey',{passkeyFailure:true});
  f.ports.recordPasskeyStatus=recordPasskeyStatusV1;
  const result=await installControlRoomV1(f.options);
  assert.equal(result.passkey.status,'stopped');
  let stdout='',stderr='';
  const exit=await runUpdaterCliV1(['install','--commit','b'.repeat(40),'--root',f.root,
    '--invoking-user','fixture-owner','--invoking-uid','501','--invoking-gid','20'],{
      installerPorts:f.ports,installerOptions:{accountsPolicy:f.options.accountsPolicy,systemPaths:f.options.systemPaths},
      stdinLine:async()=>'',readComparisonCode:async()=>'',stdout:text=>{stdout+=text;},stderr:text=>{stderr+=text;}
    });
  assert.equal(exit,0,stderr); assert.match(stdout,/Not ready: Face ID is NOT set up .*passkey_terminal_required/); assert.doesNotMatch(stdout,/Ready:/);
  const status=JSON.parse(await fs.readFile(join(f.root,'status/passkey.json'),'utf8'));
  assert.equal(status.status,'stopped');
  
});

import { readFile, lstat } from 'node:fs/promises';
import { fixture as protectedFixture, serviceInput, fakeElevatedRuntime, composeProtectedConfigV1 } from './helpers/installer-round2-protected-fixture.mjs';
import { createInProcessServiceElevatedPortV1 } from '../src/updater/v1/services/elevated.mjs';
import { installServicesV1, recoverServicesV1 } from '../src/updater/v1/services/installer.mjs';
import { remintOwnerCodeV1, rollbackOwnerCodeV1 } from '../src/updater/v1/install/stage-one-ports.mjs';

test('R2-09: SIGKILL after remint but before its receipt restores both owner digests for core recovery',async t=>{
  const f=await protectedFixture(t,'owner-receipt-gap'), configuration=composeProtectedConfigV1(f.input);
  const elevatedPort=createInProcessServiceElevatedPortV1(fakeElevatedRuntime(f.base));
  const receipt=(await installServicesV1(serviceInput(f.root,configuration),{elevatedPort})).receipt;
  const mac=join(f.root,'Protected/config/mac-local.json');
  const before=JSON.parse(await readFile(mac,'utf8')).localOwnerSession.ownerCodeDigest;
  const child=spawn(process.execPath,['tests/helpers/installer-round2-crash-owner.mjs'],{detached:true,stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  try{
    const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
    child.stdin.end(JSON.stringify({root:f.root,accounts:f.input.accounts,configuration,rpId:f.input.rpId,maximumRemints:2}));
    assert.equal((await done).signal,'SIGKILL',stderr);
  }finally{try{process.kill(-child.pid,'SIGKILL');}catch{}}
  assert.notEqual(JSON.parse(await readFile(mac,'utf8')).localOwnerSession.ownerCodeDigest,before);
  // This is exactly recoverInterruptedInstall's planned-without-done branch.
  const retries=[];
  for(let i=0;i<2;i++){
    await rollbackOwnerCodeV1({root:f.root});
    if (i === 0) assert.equal(JSON.parse(await readFile(mac,'utf8')).localOwnerSession.ownerCodeDigest, before);
    const value=await recoverServicesV1({root:f.root,roles:receipt.roles,receipt},{elevatedPort})
      .then(()=> 'recovered',error=>error.code??error.message);
    retries.push(value);
    assert.equal(value,'recovered');
  }
  console.log(JSON.stringify({id:'R2-09',retries,macDigestRestored:true}));
});

test('LOW gateway: rerun recomposes the saved gateway before restart and restores it on failure', async t => {
  const f = await fixture(t, 'gateway-refresh');
  await installControlRoomV1(f.options);
  const path = join(f.root, 'Protected/config/fleet-gateway.json');
  await fs.writeFile(path, '{}\n');
  const before = await fs.readFile(path, 'utf8');
  const restart = f.ports.restartServices;
  f.ports.restartServices = async input => {
    if (!input.rollback) {
      const saved = JSON.parse(await fs.readFile(path, 'utf8'));
      assert.equal(saved.healthProbeKeyFile, join(f.root, 'Protected/service/health-probe.key'));
    }
    return restart(input);
  };
  const health = f.ports.checkHealth;
  f.ports.checkHealth = async () => { throw new Error('health_failed'); };
  const next = {...f.options, bootstrap:undefined, commit:'b'.repeat(40)};
  await assert.rejects(installControlRoomV1(next), /health_failed/);
  assert.equal(await fs.readFile(path, 'utf8'), before);
  f.ports.checkHealth = health;
  assert.equal((await installControlRoomV1(next)).state, 'installed');
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).healthProbeKeyFile,
    join(f.root, 'Protected/service/health-probe.key'));
});

test('LOW shutdown: a removed PostgreSQL runtime is refused before execution', async t => {
  const f = await fixture(t, 'runtime-missing');
  await fs.mkdir(join(f.root, 'pg/current'), {recursive:true});
  let calls=0;
  assert.equal(await verifyPostgresShutdownV1({root:f.root, execute:async()=>{
    calls++; return {stdout:'Database cluster state: shut down\n'};
  }}), false);
  assert.equal(calls, 0);
});

test('LOW wording: protected health policy names the installer gateway probe', async () => {
  const policy = JSON.parse(await fs.readFile('src/updater/v1/policy/protected.json','utf8'));
  const text = JSON.stringify(policy);
  assert.match(text, /\/fleet\/v1\/local-health/);
  assert.doesNotMatch(text, /\/fleet\/v1\/health\)/);
});

test('R2-03: a suspended process rejects twenty independent callers and SIGKILL releases the kernel guard',
  {timeout:30000}, async t=>{
    const f=await fixture(t,'process-lock');
    const options={...f.options,ports:undefined,terminal:undefined};
    const children=[];
    const launch=hold=>{
      const child=spawn(process.execPath,['tests/helpers/installer-round2-lock-caller.mjs'],
        {detached:true,stdio:['pipe','pipe','pipe']});
      children.push(child);
      let output='',errors='';let enteredResolve;
      const entered=new Promise(resolve=>{enteredResolve=resolve;});
      child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('entered\n'))enteredResolve();});
      child.stderr.on('data',chunk=>{errors+=chunk;});
      const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,output,errors}));});
      child.stdin.end(JSON.stringify({...options,hold}));return {child,entered,done};
    };
    try{
      const first=launch(true);await first.entered;
      process.kill(first.child.pid,'SIGSTOP');
      const losers=await Promise.all(Array.from({length:20},()=>launch(false).done));
      for(const result of losers){assert.equal(result.code,0,result.errors);assert.equal(JSON.parse(result.output).state,'install_already_running');}
      process.kill(first.child.pid,'SIGKILL');assert.equal((await first.done).signal,'SIGKILL');
      const retry=await launch(false).done;assert.equal(retry.code,0,retry.errors);
      assert.equal(JSON.parse(retry.output).state,'installed',retry.errors);
    }finally{for(const child of children){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}}
});

test('R2-08: absent, malformed and mixed passkey state cannot imply Ready; registered state can',async t=>{
  for(const status of [undefined, 'bad json', {schema:'wrong',status:'registered'},
    {schema:'control-room.install-passkey-status/v1',status:'stopped',reason:'bad reason'},
    {schema:'control-room.install-passkey-status/v1',status:'registered',credentialIdDigest:'sha256:'+'a'.repeat(64),attempts:1,reason:'stopped'},
    {schema:'control-room.install-passkey-status/v1',status:'registered',credentialIdDigest:'sha256:'+'a'.repeat(64),attempts:1}]){
    const f=await fixture(t,'passkey-readiness');await installControlRoomV1(f.options);
    const path=join(f.root,'status/passkey.json');
    if(status===undefined)await fs.rm(path);else await fs.writeFile(path,typeof status==='string'?status:JSON.stringify(status));
    const result=await installControlRoomV1({...f.options,bootstrap:undefined,commit:'b'.repeat(40)});
    if(result.passkey.status==='stopped')assert.match(result.passkey.reason,/^[a-z][a-z0-9_-]{0,79}$/);
    assert.equal(result.passkey.status,status&&typeof status==='object'&&status.schema==='control-room.install-passkey-status/v1'&&status.status==='registered'&&!status.reason?'registered':'stopped');
  }
});

test('R2-09: pending recovery cannot be overwritten and a caller cannot replace its saved receipt',async t=>{
  const f=await protectedFixture(t,'owner-receipt-guards');
  const configuration=composeProtectedConfigV1(f.input);
  for(const resource of configuration)await fs.writeFile(resource.path,resource.contents,{mode:parseInt(resource.fileMode,8)});
  const input={root:f.root,accounts:f.input.accounts,configuration,rpId:f.input.rpId,maximumRemints:2};
  const minted=await remintOwnerCodeV1(input);
  const next=configuration.map(resource=>resource.path.endsWith('local-owner-session.json')
    ? {...resource,contents:JSON.stringify({...JSON.parse(resource.contents),ownerCodeDigest:minted.ownerCodeDigest})}:resource);
  await assert.rejects(remintOwnerCodeV1({...input,configuration:next}),/owner_code_recovery_pending/);
  await assert.rejects(rollbackOwnerCodeV1({root:f.root,receipt:{...minted.receipt,previousOwnerCodeDigest:'sha256:'+'d'.repeat(64)}}),/owner_code_rollback_refused/);
  await rollbackOwnerCodeV1({root:f.root,receipt:Object.fromEntries(Object.entries(minted.receipt).reverse())});
  assert.equal(JSON.parse(await fs.readFile(join(f.root,'Protected/config/mac-local.json'),'utf8')).localOwnerSession.ownerCodeDigest,f.input.ownerCodeDigest);
});

test('R2-09: twenty concurrent remints retain one recovery receipt and restore the service batch',async t=>{
  const f=await protectedFixture(t,'owner-burst');const configuration=composeProtectedConfigV1(f.input);
  const elevatedPort=createInProcessServiceElevatedPortV1(fakeElevatedRuntime(f.base));
  const installed=(await installServicesV1(serviceInput(f.root,configuration),{elevatedPort})).receipt;
  const input={root:f.root,accounts:f.input.accounts,configuration,rpId:f.input.rpId,maximumRemints:2};
  const results=await Promise.allSettled(Array.from({length:20},()=>remintOwnerCodeV1(input)));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  for(const result of results.filter(result=>result.status==='rejected'))assert.match(result.reason.message,/owner_code_recovery_pending|owner_code_refused/);
  await rollbackOwnerCodeV1({root:f.root});
  assert.equal((await recoverServicesV1({root:f.root,roles:installed.roles,receipt:installed},{elevatedPort})).outcome,'recovered');
});

test('R2-01: a kill immediately after publication preserves the complete key and permits retries',async t=>{
  for(const name of ['release-signing-key.pem','release-signing.json','release-trust.json']){
    const f=await fixture(t,'published-alias');const protectedRoot=join(f.root,'Protected');
    await fs.mkdir(protectedRoot,{recursive:true,mode:0o700});
    const child=spawn(process.execPath,['tests/helpers/installer-round2-crash-signing.mjs'],{detached:true,stdio:['pipe','pipe','pipe']});
    let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
    try{
      const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
      child.stdin.end(JSON.stringify({name,protectedRoot,versionFloor:'1.2.3'}));
      assert.equal((await done).signal,'SIGKILL',errors);
    }finally{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    const privateKeyPath=join(f.root,'updater-state/release-signing-key.pem');
    const before=await fs.readFile(privateKeyPath);
    for(let retry=0;retry<2;retry++)await generateInstallationReleaseKeyV1({protectedRoot,versionFloor:'1.2.3'},{expectedUid:process.geteuid()});
    assert.deepEqual(await fs.readFile(privateKeyPath),before);
    for(const path of [privateKeyPath,join(f.root,'updater-state/release-signing.json'),join(protectedRoot,'config/release-trust.json')])assert.equal((await fs.lstat(path)).nlink,1);
  }
});

test('R2-01: publication recovery leaves unrelated private temporaries and hard links untouched',async t=>{
  const f=await fixture(t,'publication-victim');const protectedRoot=join(f.root,'Protected');
  await fs.mkdir(protectedRoot,{recursive:true,mode:0o700});
  const input={protectedRoot,versionFloor:'1.2.3'},options={expectedUid:process.geteuid()};
  const installed=await generateInstallationReleaseKeyV1(input,options);
  const victim=join(f.root,'updater-state/.release-signing-key.pem.publish-1-aaaaaaaaaaaaaaaa');
  await fs.writeFile(victim,'unrelated',{mode:0o600});
  await fs.link(installed.privateKeyPath,join(f.root,'updater-state/unrelated-link'));
  await assert.rejects(generateInstallationReleaseKeyV1(input,options),/release_signing_refused/);
  assert.equal(await fs.readFile(victim,'utf8'),'unrelated');
  assert.deepEqual(await fs.readFile(join(f.root,'updater-state/unrelated-link')),await fs.readFile(installed.privateKeyPath));
});

// These use real protected files and receipts; only the privileged service calls are replaced.
test('R2-09: an interruption at each owner-file publication and halfway through rollback is recoverable',async t=>{
  for(const crashAt of ['receipt','mac','session']){
    const f=await protectedFixture(t,'owner-'+crashAt),configuration=composeProtectedConfigV1(f.input);
    const elevatedPort=createInProcessServiceElevatedPortV1(fakeElevatedRuntime(f.base));
    const receipt=(await installServicesV1(serviceInput(f.root,configuration),{elevatedPort})).receipt;
    const child=spawn(process.execPath,['tests/helpers/installer-round2-crash-owner.mjs'],{detached:true,stdio:['pipe','pipe','pipe']});
    let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
    try{
      const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
      child.stdin.end(JSON.stringify({crashAt,root:f.root,accounts:f.input.accounts,configuration,rpId:f.input.rpId,maximumRemints:2}));
      assert.equal((await done).signal,'SIGKILL',errors);
    }finally{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    const rename=fs.rename;let hit=false;
    fs.rename=async(...args)=>{await rename(...args);if(crashAt!=='receipt'&&!hit&&String(args[1]).endsWith('/mac-local.json')){hit=true;throw new Error('rollback_interrupted');}};
    syncBuiltinESMExports();
    try{if(crashAt!=='receipt')await assert.rejects(rollbackOwnerCodeV1({root:f.root}),/rollback_interrupted/);}
    finally{fs.rename=rename;syncBuiltinESMExports();}
    await rollbackOwnerCodeV1({root:f.root});
    assert.equal(JSON.parse(await fs.readFile(join(f.root,'Protected/config/mac-local.json'),'utf8')).localOwnerSession.ownerCodeDigest,f.input.ownerCodeDigest);
    assert.equal((await recoverServicesV1({root:f.root,roles:receipt.roles,receipt},{elevatedPort})).outcome,'recovered');
  }
});

test('R2-03: the kernel guard refuses private-file violations and a replaced inode',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t,'kernel-guard');await fs.mkdir(f.root,{recursive:true});
  const path=join(f.root,'guard');
  const first=acquirePrivateProcessLockV1(path);
  let second;
  try{
    await fs.writeFile(path,'');await fs.utimes(path,new Date(0),new Date(0));
    assert.throws(()=>{second=acquirePrivateProcessLockV1(path);},/private_process_lock_busy/);
  }finally{second?.release();first.release();}
  await fs.writeFile(path,'private',{mode:0o600});
  // Broken entries (wrong mode, foreign owner, hard link, symlink) are refused as UNUSABLE, not
  // as a live holder (supfix4 R4S-06); only real contention and a replaced inode stay busy.
  const unusable=error=>error.message==='private_process_lock_unusable'&&error.unusable===true;
  await fs.chmod(path,0o644);assert.throws(()=>acquirePrivateProcessLockV1(path),unusable);
  await fs.chmod(path,0o600);assert.throws(()=>acquirePrivateProcessLockV1(path,{expectedUid:-1}),unusable);
  const other=path+'-other';await fs.link(path,other);assert.throws(()=>acquirePrivateProcessLockV1(path),unusable);
  await fs.rm(path);await fs.symlink(other,path);assert.throws(()=>acquirePrivateProcessLockV1(path),unusable);
  await fs.rm(path);await fs.rm(other);
  const original=nativeFs.openSync;let swapped=false;
  nativeFs.openSync=(file,...args)=>{const fd=original(file,...args);if(file===path&&!swapped){swapped=true;nativeFs.renameSync(path,other);nativeFs.writeFileSync(path,'replacement',{mode:0o600});}return fd;};
  syncBuiltinESMExports();
  try{assert.throws(()=>acquirePrivateProcessLockV1(path),/private_process_lock_busy/);}
  finally{nativeFs.openSync=original;syncBuiltinESMExports();}
  assert.equal(await fs.readFile(path,'utf8'),'replacement');
});

test('LOW gateway: malformed and missing configuration refuse before restart',async t=>{
  for(const content of ['not json','[]',null]){
    const f=await fixture(t,'gateway-input');await installControlRoomV1(f.options);
    const path=join(f.root,'Protected/config/fleet-gateway.json'),old=await fs.readlink(join(f.root,'current'));
    if(content===null)await fs.rm(path);else await fs.writeFile(path,content);
    const start=f.ports.calls.length;
    await assert.rejects(installControlRoomV1({...f.options,bootstrap:undefined,commit:'b'.repeat(40)}),/gateway_configuration_refused|existing_file_refused/);
    assert.equal(await fs.readlink(join(f.root,'current')),old);
    assert.equal(f.ports.calls.slice(start).some(([name,input])=>name==='restart-services'&&!input.rollback),false);
  }
});

test('LOW gateway: recovery refuses forged snapshot paths, digests and changed configuration',async t=>{
  for(const alteration of ['path','digest','current','pointer']){
    const f=await fixture(t,'gateway-recovery');await installControlRoomV1(f.options);
    const path=join(f.root,'Protected/config/fleet-gateway.json');await fs.writeFile(path,'{}\n');
    let stop=true;f.ports.afterJournalEntry=async record=>{if(stop&&record.action==='recompose-gateway-config'&&record.phase==='planned'){stop=false;throw new Error('gateway_stop');}};
    const options={...f.options,bootstrap:undefined,commit:'b'.repeat(40)};
    await assert.rejects(installControlRoomV1(options),/gateway_stop/);
    const journalPath=join(f.root,'updater-state',CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
    const records=(await fs.readFile(journalPath,'utf8')).trim().split('\n').map(JSON.parse);
    const snapshot=records.findLast(record=>record.action==='recompose-gateway-config');
    if(alteration==='path'){
      // These bytes and digests otherwise match, so only the path guard can refuse it.
      await fs.writeFile(join(f.root,'victim'),'{}\n');snapshot.data.backup='../victim';
    }else if(alteration==='digest')snapshot.data.before='sha256:'+'d'.repeat(64);
    else if(alteration==='current')await fs.writeFile(path,'{"changed":true}\n');
    else delete records.findLast(record=>record.action==='switch-pointers'&&record.phase==='done').data.oldCurrent;
    await fs.writeFile(journalPath,records.map(record=>JSON.stringify(record)).join('\n')+'\n');
    await assert.rejects(installControlRoomV1(options),/install_journal_refused|gateway_configuration_changed/);
    if(alteration==='current')assert.equal(await fs.readFile(path,'utf8'),'{"changed":true}\n');
    if(alteration==='path')assert.equal(await fs.readFile(join(f.root,'victim'),'utf8'),'{}\n');
  }
});

test('R2-01 and R2-09: file and directory sync precede published keys and owner effects',async t=>{
  const f=await protectedFixture(t,'durable-publication');
  const configuration=composeProtectedConfigV1(f.input);
  for(const resource of configuration)await fs.writeFile(resource.path,resource.contents,{mode:parseInt(resource.fileMode,8)});
  const signing=await fixture(t,'sync-signing');await fs.mkdir(join(signing.root,'Protected'),{recursive:true,mode:0o700});
  const synced=new Set(),directories=new Set(),owned=new Set(),moded=new Set();
  const originalOpen=fs.open,originalLink=fs.link,originalRename=fs.rename;
  const state=join(f.root,'updater-state');
  fs.open=async(file,...args)=>{const handle=await originalOpen(file,...args),sync=handle.sync.bind(handle),chown=handle.chown.bind(handle),chmod=handle.chmod.bind(handle);
    handle.chown=async(...values)=>{await chown(...values);owned.add(String(file));};
    handle.chmod=async(...values)=>{await chmod(...values);moded.add(String(file));};
    handle.sync=async()=>{await sync();synced.add(String(file));if((await handle.stat()).isDirectory())directories.add(String(file));};return handle;};
  fs.link=async(source,target)=>{if(String(source).includes('.publish-')){assert.ok(synced.has(String(source)),'signing bytes sync before publication');assert.ok(moded.has(String(source)));if(String(target).endsWith('/release-trust.json'))assert.ok(owned.has(String(source)),'trust group ownership before publication');}return originalLink(source,target);};
  fs.rename=async(source,target)=>{
    if(String(source).includes('.stage-one-'))assert.ok(synced.has(String(source)),'owner bytes sync before publication');
    if(String(target).endsWith('/mac-local.json')||String(target).endsWith('/local-owner-session.json'))assert.ok(directories.has(state),'receipt directory sync before either owner file');
    return originalRename(source,target);
  };
  syncBuiltinESMExports();
  try{
    await generateInstallationReleaseKeyV1({protectedRoot:join(signing.root,'Protected'),versionFloor:'1.2.3'},{expectedUid:process.geteuid()});
    assert.ok(directories.has(join(signing.root,'updater-state')));assert.ok(directories.has(join(signing.root,'Protected/config')));
    directories.clear();
    await remintOwnerCodeV1({root:f.root,accounts:f.input.accounts,configuration,rpId:f.input.rpId,maximumRemints:2});
  }finally{fs.open=originalOpen;fs.link=originalLink;fs.rename=originalRename;syncBuiltinESMExports();}
  await rollbackOwnerCodeV1({root:f.root});
});

test('R2-01: publication cleanup refuses an unexpected file owner before removing aliases',async t=>{
  const f=await fixture(t,'alias-owner');const input={protectedRoot:join(f.root,'Protected'),versionFloor:'1.2.3'};
  await fs.mkdir(input.protectedRoot,{recursive:true,mode:0o700});
  const options={expectedUid:process.geteuid()},installed=await generateInstallationReleaseKeyV1(input,options);
  const alias=join(f.root,'updater-state/.release-signing-key.pem.publish-1-aaaaaaaaaaaaaaaa');
  await fs.link(installed.privateKeyPath,alias);
  const original=fs.lstat;fs.lstat=async(path,...args)=>{const stat=await original(path,...args);if(path===installed.privateKeyPath)stat.uid++;return stat;};
  syncBuiltinESMExports();
  try{await assert.rejects(generateInstallationReleaseKeyV1(input,options),/release_signing_refused/);assert.ok(await fs.lstat(alias));}
  finally{fs.lstat=original;syncBuiltinESMExports();}
});

test('R2-09: owner recovery rejects missing roots before taking a filesystem lock',async()=>{
  await assert.rejects(remintOwnerCodeV1({}),{code:'owner_code_refused'});
  await assert.rejects(rollbackOwnerCodeV1({}),{code:'owner_code_rollback_refused'});
});

test('R2-02: pointer snapshots refuse malformed names and symlink escapes before switching',async t=>{
  for(const [name,target,escape] of [['previous','releases/rogue',false],['updater/previous','rogue updater',false],['updater/previous','.',false],['updater/previous','rogue',true]]){
    const f=await fixture(t,'snapshot-input');await installControlRoomV1(f.options);
    const child=join(f.root,name.startsWith('updater/')?'updater':'',target);
    if(escape){await fs.mkdir(join(f.base,'escape'));await fs.symlink(join(f.base,'escape'),child);}
    else await fs.mkdir(child,{recursive:true});
    await fs.rm(join(f.root,name));await fs.symlink(target,join(f.root,name));
    const start=f.ports.calls.length;
    await assert.rejects(installControlRoomV1({...f.options,bootstrap:undefined,commit:'b'.repeat(40)}),/release_pointer_refused/);
    assert.equal(f.ports.calls.slice(start).some(([name])=>name==='switch-pair'),false);
  }
});
