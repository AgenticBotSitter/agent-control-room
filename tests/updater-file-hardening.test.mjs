import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { loadMacLocalProtectedConfigurationV1 as load, loadMacLocalProtectedConfigurationFromRootV1 as loadRoot } from '../src/web/v1/mac-local-protected-loader.ts';
import { ensureFirstOwnerStateV1 as ensure, readFirstOwnerStateV1 as readState } from '../src/updater/v1/pg/first-owner-state.mjs';
import { recordPasskeyStatusV1 as status } from '../src/updater/v1/pg/initial-passkey-ports.mjs';
import { writeDatabaseLoginsV1 as passwords, removeDatabaseLoginsV1 as removePasswords } from '../src/updater/v1/pg/first-owner-ports.mjs';
import { FileStepJournalV1 as Journal } from '../src/updater/v1/journal.mjs';
import { generateInstallationReleaseKeyV1 as keygen, signConnectorReleaseAdvertisementV1 as sign, raiseReleaseTrustFloorV1 as raise } from '../scripts/release-signing.mjs';
import { signAttendedConnectorReleaseV1 as signRelease } from '../src/updater/v1/install/connector-release.mjs';
import { verifyAttendedBuildOutputV1 as verifyOutput } from '../src/updater/v1/attended-source.mjs';
import { buildAttendedReleaseV1 as build } from '../src/updater/v1/build-attended-release.mjs';
import { isMainModuleV1 as isMain } from '../src/installer/shared/is-main-module.mjs';
import { createUpdaterHomeStatusReaderV1 as homeReader } from '../src/web/v1/updater-home-status.ts';
import { readPid, runtimePaths } from '../scripts/mac-local/stack.mjs';
import { readHostState, RotatingHostLog } from '../scripts/mac-local/task-host-supervisor.mjs';

const uid = process.getuid(), gid = process.getgid(), commit = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const config = { schema: 'control-room.mac-local-protected-configuration/v1', port: 3210, workspaceId: 'workspace:fixture',
  localOwnerSession: { schema: 'control-room.local-owner-session/v1', origin: 'http://127.0.0.1:3210', tenantId: 'tenant:fixture', provider: 'local-owner', subject: 'owner:fixture', ownerCodeDigest: 'sha256:'+'a'.repeat(64), sessionSeconds: 900 },
  database: { host: '127.0.0.1', port: 5432, database: 'control_room', username: 'control_room_web', password: 'fixture-only', majorVersion: 17 },
  enablement: { schema: 'control-room.owner-trusted-local-enablement/v1', mode: 'mac-local', nodeId: 'mac-1', workers: [] } };
const write = async (path, body, mode = 0o600) => { await fs.writeFile(path, body, {mode}); await fs.chmod(path, mode); };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(),'hardening-case-')));
  t.after(async () => {
    async function thaw(p) { const st=await fs.lstat(p).catch(()=>null); if(st?.isDirectory()&&!st.isSymbolicLink()){await fs.chmod(p,0o700);for(const n of await fs.readdir(p))await thaw(join(p,n));} }
    await thaw(root); await fs.rm(root,{recursive:true,force:true});
  });
  return root;
}
async function patch(name, wrapper, work) { const old=fs[name]; fs[name]=wrapper(old); syncBuiltinESMExports(); try{return await work();}finally{fs[name]=old;syncBuiltinESMExports();} }
function fifo(path) { assert.equal(spawnSync('/usr/bin/mkfifo',[path]).status,0); }
const inputPasswords = root => ({root,accounts:{service:{uid,gid}},passwords:{control_room_web:'A'.repeat(43)}});
async function releaseFixture(t) {
  const root=await fixture(t), protectedRoot=join(root,'Protected'); await fs.mkdir(protectedRoot,{mode:0o750});
  const key=await keygen({protectedRoot,versionFloor:'0.0.0'},{expectedUid:uid});
  const output=join(root,'output'), dir=join(output,'dist-vps/server/fleet/release');await fs.mkdir(dir,{recursive:true,mode:0o700});
  // The signer also requires the bundled version assignment to match the manifest (QA A4).
  const bundle=Buffer.from(`// Control Room embedded release key ID: ${key.trust.keyId}\nvar CONNECTOR_VERSION = "1.2.3";\nfixture\n`);
  const manifest={schema:'control-room.fleet-connector-release/v1',builtFrom:commit,file:'connector-1.2.3.mjs',version:'1.2.3',size:bundle.length,sha256:hash(bundle)};
  await write(join(dir,manifest.file),bundle,0o400);await write(join(dir,'manifest.json'),JSON.stringify(manifest),0o400);
  const files=[];for(const name of await fs.readdir(dir)){const bytes=await fs.readFile(join(dir,name));files.push({path:'dist-vps/server/fleet/release/'+name,bytes:bytes.length,mode:0o400,sha256:'sha256:'+hash(bytes)});}
  await write(join(output,'RELEASE_MANIFEST.json'),JSON.stringify({schema:'control-room.attended-build-manifest/v1',commit,version:'1.2.3',files,fileCount:files.length,byteCount:files.reduce((a,b)=>a+b.bytes,0)}),0o400);
  return {root,output,dir,key,input:{output,commit,trust:key.trust,privateKeyPath:key.privateKeyPath}};
}

test('held: web static special files, modes, truncation and limits',async t=>{
  const root=await fixture(t), p=join(root,'config.json');await write(p,JSON.stringify(config));assert.equal((await load(p)).workspaceId,config.workspaceId);
  for(const mode of [0o620,0o604,0o640,0o601]){await fs.chmod(p,mode);await assert.rejects(load(p));}
  await fs.chmod(p,0o600);await fs.link(p,join(root,'alias'));await assert.rejects(load(p));await fs.unlink(join(root,'alias'));
  await fs.rename(p,join(root,'real'));await fs.symlink('real',p);await assert.rejects(load(p));await fs.unlink(p);fifo(p);await assert.rejects(load(p));await fs.unlink(p);
  for(const body of ['{',' '.repeat(65537)]){await write(p,body);await assert.rejects(load(p));}await fs.unlink(p);await assert.rejects(load(p));
});
test('held: 0o027 rule using fixture root/service identities',async t=>{
  const root=await fixture(t),p=join(root,'config.json');await write(p,JSON.stringify(config));const st=await fs.lstat(p);
  const run=(mode,owner,group,groups=[])=>load(p,{lstat:async()=>Object.assign(Object.create(Object.getPrototypeOf(st)),st,{mode,uid:owner,gid:group}),readFile:fs.readFile,getuid:()=>1234,getgid:()=>2345,getgroups:()=>groups});
  await run(0o100640,0,2345);await run(0o100640,0,3456,[3456]);await run(0o100600,1234,3456);
  for(const args of [[0o100640,0,3456],[0o100660,0,2345],[0o100604,0,2345],[0o100600,9999,2345],[0o100640,1234,2345]])await assert.rejects(run(...args));
});
test('A1-01: web refuses directory swapped to symlink after checks',async t=>{
  const root=await fixture(t),protectedRoot=join(root,'Protected'),dir=join(protectedRoot,'config'),other=join(root,'other');
  await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.mkdir(other,{mode:0o700});await write(join(dir,'mac-local.json'),JSON.stringify(config));
  await write(join(other,'mac-local.json'),JSON.stringify({...config,workspaceId:'workspace:substituted'}),0o666);
  let swapped=false;await assert.rejects(loadRoot(protectedRoot,{lstat:fs.lstat,readFile:async(p,encoding)=>{if(!swapped){swapped=true;await fs.rename(dir,dir+'.old');await fs.symlink(other,dir);}return fs.readFile(p,encoding);}}));
  
});
test('held: first-owner static special files and 50 callers retry to one state',async t=>{
  const root=await fixture(t);const results=await Promise.allSettled(Array.from({length:50},()=>ensure(root)));
  const good=results.filter(r=>r.status==='fulfilled');assert.ok(good.length);assert.equal(new Set(good.map(r=>r.value.reviewKey)).size,1);
  const saved=await readState(root);assert.deepEqual(await ensure(root),saved);console.log('first-owner burst:',good.length,'success,',50-good.length,'transient refusals; retry stable');
  const p=join(root,'updater-state/first-owner.json');await fs.link(p,p+'.alias');await assert.rejects(readState(root));await fs.unlink(p+'.alias');
  await fs.chmod(p,0o640);await assert.rejects(readState(root));await fs.chmod(p,0o600);await fs.rename(p,p+'.real');await fs.symlink(p+'.real',p);await assert.rejects(readState(root));await fs.unlink(p);fifo(p);await assert.rejects(readState(root));await fs.unlink(p);
  for(const body of ['{',' '.repeat(4097)]){await write(p,body);await assert.rejects(readState(root));await assert.rejects(ensure(root));}
});
test('A1-02: first-owner refuses replaced parent after directory validation',async t=>{
  const root=await fixture(t);await ensure(root);const dir=join(root,'updater-state'),other=join(root,'other');await fs.mkdir(other,{mode:0o700});
  await write(join(other,'first-owner.json'),JSON.stringify({schema:'control-room.first-owner-state/v1',createdAt:'2026-01-01T00:00:00.000Z',reviewKey:Buffer.alloc(32,7).toString('base64url')}));
  let swapped=false,opened=0;await assert.rejects(readState(root,{open:async(...args)=>{opened++;return fs.open(...args);},lstat:async p=>{const st=await fs.lstat(p);if(!swapped){swapped=true;await fs.rename(dir,dir+'.old');await fs.symlink(other,dir);}return st;}}));
  assert.equal(opened,0);
});
test('A1-03: passkey writer refuses parent symlink and safely replaces leaf symlink',async t=>{
  const root=await fixture(t),other=join(root,'other');await fs.mkdir(other);await fs.symlink(other,join(root,'status'));
  await assert.rejects(status({root,status:'stopped',reason:'fixture'}));
  assert.deepEqual(await fs.readdir(other),[]);
  await fs.unlink(join(root,'status'));await fs.mkdir(join(root,'status'),{mode:0o700});
  const sentinel=join(root,'sentinel');await write(sentinel,'unchanged');await fs.symlink(sentinel,join(root,'status/passkey.json'));
  await status({root,status:'stopped',reason:'again'});assert.equal(await fs.readFile(sentinel,'utf8'),'unchanged');
});
test('held: passkey 50 atomic writers, malformed input and permission denied',async t=>{
  const root=await fixture(t),dir=join(root,'status');await fs.mkdir(dir,{mode:0o700});
  await Promise.all(Array.from({length:50},(_,i)=>status({root,status:'stopped',reason:'fixture_'+i})));
  assert.match(JSON.parse(await fs.readFile(join(dir,'passkey.json'))).reason,/^fixture_\d+$/);assert.equal((await fs.stat(join(dir,'passkey.json'))).mode&0o777,0o600);
  await assert.rejects(status({root,status:'registered',attempts:0}));await fs.chmod(dir,0o500);try{await assert.rejects(status({root,status:'stopped',reason:'denied'}));}finally{await fs.chmod(dir,0o700);}
});
test('A1-04: ENOSPC cleans partial passkey temporary file',async t=>{
  const root=await fixture(t),dir=join(root,'status');await fs.mkdir(dir);await status({root,status:'stopped',reason:'old'});
  await patch('open',old=>async(p,...args)=>{const h=await old(p,...args);if(String(p).includes('.passkey-')){const real=h.writeFile.bind(h);h.writeFile=async()=>{await real('{');throw Object.assign(new Error('fixture full'),{code:'ENOSPC'});};}return h;},async()=>{await assert.rejects(status({root,status:'stopped',reason:'new'}),{code:'ENOSPC'});});
  const residue=(await fs.readdir(dir)).filter(n=>n.startsWith('.passkey-'));assert.equal(residue.length,0);assert.equal(JSON.parse(await fs.readFile(join(dir,'passkey.json'))).reason,'old');
  await status({root,status:'stopped',reason:'retry'});
});
test('A1-05: password directory substitution refuses before writing secrets',async t=>{
  const root=await fixture(t),dir=join(root,'Protected/config/database-passwords'),other=join(root,'other');await fs.mkdir(other,{mode:0o700});let swapped=false,opened=0;
  await patch('open',old=>async(...args)=>{opened++;return old(...args);},()=>assert.rejects(passwords(inputPasswords(root),{lstat:async p=>{const st=await fs.lstat(p);if(p===dir&&!swapped){swapped=true;await fs.rename(dir,dir+'.old');await fs.symlink(other,dir);}return st;}})));
  assert.deepEqual(await fs.readdir(other),[]);assert.equal(opened,0);
});
test('held: password static directory refusal, leaf protection, concurrent retries and conservative undo',async t=>{
  const root=await fixture(t),dir=join(root,'Protected/config/database-passwords');await fs.mkdir(dirname(dir),{recursive:true,mode:0o700});const other=join(root,'other');await fs.mkdir(other,{mode:0o700});await fs.symlink(other,dir);await assert.rejects(passwords(inputPasswords(root)));await fs.unlink(dir);
  const results=await Promise.allSettled(Array.from({length:50},()=>passwords(inputPasswords(root))));assert.ok(results.some(r=>r.status==='fulfilled'));assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code?.startsWith('database_logins_write_refused')));await passwords(inputPasswords(root));console.log('password burst:',results.filter(r=>r.status==='fulfilled').length,'success,',results.filter(r=>r.status==='rejected').length,'safe refusals; retry succeeds');
  const file=join(dir,'control_room_web.txt'),sentinel=join(root,'sentinel');await write(sentinel,'unchanged');await fs.unlink(file);await fs.symlink(sentinel,file);const result=await passwords(inputPasswords(root));assert.equal(await fs.readFile(sentinel,'utf8'),'unchanged');
  await write(join(dir,'unexpected'),'keep');await assert.rejects(removePasswords({root,receipt:result.receipt}));assert.equal(await fs.readFile(join(dir,'unexpected'),'utf8'),'keep');
});
test('held: one journal instance serializes 50 writes, repairs a tail and refuses middle corruption',async t=>{
  const root=await fixture(t);await fs.mkdir(join(root,'updater-state'));const j=new Journal(root,{ownerUid:uid});
  await Promise.all(Array.from({length:50},(_,i)=>j.intent({runId:'fixture',ordinal:i+1})));assert.equal((await j.validate()).entries.length,50);
  const p=join(root,'updater-state/journal.jsonl');await fs.appendFile(p,'{');assert.equal((await j.validate()).entries.length,50);assert.equal(await j.quarantineCorrupt(),false);await fs.appendFile(p,'{\n{}\n');await assert.rejects(j.validate(),{code:'updater_journal_short'});assert.equal(await j.quarantineCorrupt(),true);
});
test('A1-06: independent journal writers refuse contention and preserve MAC chain',async t=>{
  const root=await fixture(t);await fs.mkdir(join(root,'updater-state'));const j=new Journal(root,{ownerUid:uid});await j.intent({runId:'initial',ordinal:1});
  let release, arrived;const gate=new Promise(r=>release=r), entered=new Promise(r=>arrived=r);
  const checkpoint=async point=>{if(point==='append_before_open'){arrived();await gate;}};
  const first=new Journal(root,{ownerUid:uid,checkpoint}).intent({runId:'parallel',ordinal:1});await entered;
  const results=await Promise.allSettled(Array.from({length:50},(_,i)=>new Journal(root,{ownerUid:uid}).intent({runId:'parallel',ordinal:i+2})));
  release();await first;
  assert.equal(results.filter(r=>r.status==='fulfilled').length,0);
  assert.ok(results.every(r=>r.reason.code==='updater_journal_busy'));
  assert.equal((await j.validate()).entries.length,2);
  await new Journal(root,{ownerUid:uid}).intent({runId:'retry',ordinal:1});
  assert.equal((await j.validate()).entries.length,3);
});
test('held: journal static hard link, symlink, FIFO, owner and cap refusals',async t=>{
  const root=await fixture(t);await fs.mkdir(join(root,'updater-state'));const j=new Journal(root,{ownerUid:uid});await j.intent({runId:'fixture',ordinal:1});const p=join(root,'updater-state/journal.jsonl');
  await assert.rejects(new Journal(root,{ownerUid:uid+1000}).validate());await fs.link(p,p+'.alias');await assert.rejects(j.validate());await fs.unlink(p+'.alias');await fs.rename(p,p+'.real');await fs.symlink(p+'.real',p);await assert.rejects(j.validate());await fs.unlink(p);fifo(p);await assert.rejects(j.validate());await fs.unlink(p);await write(p,' '.repeat(8*1024*1024+16385));await assert.rejects(j.validate());
});
test('held: release key static special files, size, mode, owner and trust-floor concurrency',async t=>{
  const f=await releaseFixture(t),p=f.key.privateKeyPath;const ad={version:'1.2.3',file:'connector-1.2.3.mjs',size:1,sha256:hash('x'),builtFrom:commit,minVersion:'1.2.3'};
  await sign(ad,p,{expectedUid:uid});await assert.rejects(sign(ad,p,{expectedUid:uid+1000}));await fs.chmod(p,0o640);await assert.rejects(sign(ad,p,{expectedUid:uid}));await fs.chmod(p,0o600);
  await fs.link(p,p+'.alias');await assert.rejects(sign(ad,p,{expectedUid:uid}));await fs.unlink(p+'.alias');await fs.rename(p,p+'.real');await fs.symlink(p+'.real',p);await assert.rejects(sign(ad,p,{expectedUid:uid}));await fs.unlink(p);fifo(p);await assert.rejects(sign(ad,p,{expectedUid:uid}));await fs.unlink(p);await write(p,' '.repeat(16385));await assert.rejects(sign(ad,p,{expectedUid:uid}));await fs.unlink(p);await fs.rename(p+'.real',p);
  await Promise.all(Array.from({length:50},(_,i)=>raise({trustPath:f.key.trustPath,installedVersion:'1.0.'+i},{expectedUid:uid})));
  assert.equal(JSON.parse(await fs.readFile(f.key.trustPath)).versionFloor,'1.0.49');
});
test('A1-07: ENOSPC writing trust lock cleans up and permits retry',async t=>{
  const f=await releaseFixture(t),lock=f.key.trustPath+'.lock';
  await patch('open',old=>async(p,...args)=>{const h=await old(p,...args);if(p===lock){h.writeFile=async()=>{throw Object.assign(new Error('fixture full'),{code:'ENOSPC'});};}return h;},async()=>{await assert.rejects(raise({trustPath:f.key.trustPath,installedVersion:'2.0.0'},{expectedUid:uid,attempts:0}),e=>e.code==='ENOSPC');});
  await assert.rejects(fs.stat(lock),{code:'ENOENT'});assert.equal((await raise({trustPath:f.key.trustPath,installedVersion:'2.0.0'},{expectedUid:uid,attempts:2})).versionFloor,'2.0.0');
});
test('held: connector retry after interruption and 50-caller lock contention',async t=>{
  const f=await releaseFixture(t);await assert.rejects(signRelease(f.input,{expectedUid:uid,fault:p=>{if(p==='advertisement_written')throw new Error('fixture interruption');}}));
  await signRelease(f.input,{expectedUid:uid});await verifyOutput(f.output,{commit});
  const results=await Promise.allSettled(Array.from({length:50},()=>signRelease(f.input,{expectedUid:uid})));assert.ok(results.some(r=>r.status==='fulfilled'));assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.message==='attended_connector_release_busy'));
  await signRelease(f.input,{expectedUid:uid});console.log('connector burst:',results.filter(r=>r.status==='fulfilled').length,'success; busy losers; retry valid');
});
test('A1-08: connector signing refuses substituted build manifest',async t=>{
  const f=await releaseFixture(t),buildPath=join(f.output,'RELEASE_MANIFEST.json'),outside=join(f.root,'replacement.json');
  const alternate=JSON.parse(await fs.readFile(buildPath));alternate.injected='fixture replacement';await write(outside,JSON.stringify(alternate),0o666);let switched=false;
  await patch('open',old=>async(p,...args)=>{if(p===buildPath&&!switched){switched=true;await fs.rename(buildPath,buildPath+'.old');await fs.symlink(outside,buildPath);}return old(p,...args);},()=>assert.rejects(signRelease(f.input,{expectedUid:uid})));
  assert.equal(JSON.parse(await fs.readFile(outside)).injected,'fixture replacement');
});
test('held: attended output refuses tamper, extra files, hard links and FIFO',async t=>{
  const f=await releaseFixture(t);await verifyOutput(f.output,{commit});const p=join(f.dir,'connector-1.2.3.mjs');await fs.link(p,p+'.alias');await assert.rejects(verifyOutput(f.output,{commit}));await fs.unlink(p+'.alias');await fs.rename(p,p+'.real');await fs.symlink(p+'.real',p);await assert.rejects(verifyOutput(f.output,{commit}));await fs.unlink(p);await fs.unlink(p+'.real');fifo(p);await assert.rejects(verifyOutput(f.output,{commit}));
});
test('held: entry helper missing, symlink, broken path and file URL contract',async t=>{
  const root=await fixture(t),p=join(root,'entry.mjs');await write(p,'// fixture');const url=pathToFileURL(p).href;assert.equal(isMain(undefined,url),false);assert.equal(isMain(p,url),true);await fs.symlink(p,p+'.link');assert.equal(isMain(p+'.link',url),true);assert.throws(()=>isMain(p+'.missing',url),{code:'direct_entry_guard_refused'});assert.throws(()=>isMain(url,url),{code:'direct_entry_guard_refused'});await fs.link(p,p+'.hard');assert.equal(isMain(p+'.hard',url),false);
});
test('held: public status reader safely refuses missing, FIFO and malformed records',async t=>{
  const root=await fixture(t);await fs.mkdir(join(root,'status'));const reader=homeReader({root});assert.equal((await reader.read()).state,'attention');const p=join(root,'status/status.json');fifo(p);assert.equal((await reader.read()).state,'attention');await fs.unlink(p);await write(p,'{');assert.equal((await reader.read()).state,'attention');
});
test('A1-09: release key replaced by FIFO promptly refuses',async t=>{
  const f=await releaseFixture(t),p=f.key.privateKeyPath;const ad={version:'1.2.3',file:'connector-1.2.3.mjs',size:1,sha256:hash('x'),builtFrom:commit,minVersion:'1.2.3'};
  let hit,settled=false,swapped=false;const checkpoint=new Promise(r=>hit=r);
  await patch('lstat',old=>async(path,...args)=>{const st=await old(path,...args);if(path===p&&!swapped){swapped=true;await fs.rename(p,p+'.real');fifo(p);hit();}return st;},async()=>{
    const pending=sign(ad,p,{expectedUid:uid}).then(()=>{settled=true;return null;},e=>{settled=true;return e;});await checkpoint;
    await new Promise(r=>setTimeout(r,150));const promptly=settled;
    const writer=await fs.open(p,constants.O_RDWR|constants.O_NONBLOCK);try{const error=await pending;assert.equal(error.reason,'file_changed');}finally{await writer.close();}assert.equal(promptly,true);
  });
});
test('held: key generation interrupted after complete key write reuses same key',async t=>{
  const root=await fixture(t),protectedRoot=join(root,'Protected');await fs.mkdir(protectedRoot,{mode:0o750});await assert.rejects(keygen({protectedRoot,versionFloor:'0.0.0'},{expectedUid:uid,fault:()=>{throw new Error('fixture interruption');}}));
  const p=join(root,'updater-state/release-signing-key.pem'),before=await fs.readFile(p);await keygen({protectedRoot,versionFloor:'0.0.0'},{expectedUid:uid});assert.deepEqual(await fs.readFile(p),before);
});
test('A1-10: runtime PID reader promptly refuses static FIFO',async t=>{
  const root=await fixture(t),p=join(root,'task-host.pid');fifo(p);let settled=false;const pending=readPid(p).then(v=>{settled=true;return v;});
  await new Promise(r=>setTimeout(r,150));const promptly=settled;const writer=await fs.open(p,constants.O_RDWR|constants.O_NONBLOCK);await writer.writeFile('12345\n');await writer.close();assert.equal(await pending,undefined);assert.equal(promptly,true);
  
});
test('held: runtime log repairs unsafe leaf without overwriting its target; state refuses FIFO and partial JSON',async t=>{
  const root=await fixture(t),p=join(root,'task-host.log'),sentinel=join(root,'sentinel');await write(sentinel,'keep');await fs.symlink(sentinel,p);const log=await RotatingHostLog.open(p);await log.write('fixture');await log.close();assert.equal(await fs.readFile(sentinel,'utf8'),'keep');
  const state=join(root,'task-host-state.json');fifo(state);await assert.rejects(readHostState(state));await fs.unlink(state);await write(state,'{');await assert.rejects(readHostState(state));
});
test('A1-11: attended builder promptly refuses FIFO package metadata',async t=>{
  const root=await fixture(t),source=join(root,'source'),output=join(root,'output');await fs.mkdir(source);await fs.mkdir(output);const p=join(source,'package.json');fifo(p);let settled=false,opened=0;
  await patch('open',old=>async(path,...args)=>{if(path===p)opened++;return old(path,...args);},async()=>{
  const pending=build({source,output,commit}).then(()=>{settled=true;return null;},e=>{settled=true;return e;});await new Promise(r=>setTimeout(r,150));const promptly=settled,readerOpens=opened;
  const writer=await fs.open(p,constants.O_RDWR|constants.O_NONBLOCK);await writer.writeFile('{"name":"control-room","version":"1.2.3"}');await writer.close();assert.ok(await pending);assert.equal(promptly,true);assert.equal(readerOpens,0);
  });
});
test('held: builder output verifies; file changed between hash and copy is caught before staging',async t=>{
  const root=await fixture(t),source=join(root,'source'),output=join(root,'output');await fs.mkdir(source);await fs.mkdir(output);
  const code=await fs.readFile('src/updater/v1/build-attended-release.mjs','utf8');
  const names=key=>[...code.match(new RegExp('const '+key+' = Object.freeze\\(\\[([\\s\\S]*?)\\]\\)'))[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]);
  for(const name of names('FILES')){const p=join(source,name);await fs.mkdir(dirname(p),{recursive:true});await write(p,name==='package.json'?'{"name":"control-room","version":"1.2.3"}':'original');}
  for(const name of names('DIRECTORIES'))await fs.mkdir(join(source,name),{recursive:true});
  await build({source,output,commit});await verifyOutput(output,{commit});const second=join(root,'second');await fs.mkdir(second);let swapped=false;
  await patch('copyFile',old=>async(from,...args)=>{if(!swapped&&from===join(source,'LICENSE')){swapped=true;await write(from,'modified');}return old(from,...args);},()=>build({source,output:second,commit}));
  await assert.rejects(verifyOutput(second,{commit}));console.log('held: changed copy rejected by attended output verifier');
});

test('custody: bounded descriptor reads reject leaf and parent changes', async t => {
  const { stableFileBytesV1, directoryCustodyV1, sameFileV1 } = await import('../src/installer/shared/file-custody.mjs');
  const root = await fixture(t), path = join(root, 'held'); await write(path, 'safe');
  const good = await fs.lstat(path);
  for (const field of ['dev','ino','size','mode','uid','gid','nlink','mtimeMs','ctimeMs'])
    assert.equal(sameFileV1(good, { ...good, [field]: good[field] + 1 }), false, field);
  assert.equal(sameFileV1(good, good), true);
  assert.equal((await stableFileBytesV1(path, 4)).toString(), 'safe');
  await assert.rejects(stableFileBytesV1(path, 3));
  await fs.link(path, path + '.alias'); await assert.rejects(stableFileBytesV1(path, 4)); await fs.unlink(path + '.alias');
  await patch('open', old => async (p, ...args) => {
    const handle = await old(p, ...args);
    if (p === path) { await fs.rename(path, path + '.old'); await write(path, 'safe'); }
    return handle;
  }, () => assert.rejects(stableFileBytesV1(path, 4)));
  await patch('open', old => async (p, ...args) => {
    const handle = await old(p, ...args);
    if (p === path) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { const value = await read(...readArgs); await fs.appendFile(path, 'extra'); return value; };
    }
    return handle;
  }, () => assert.rejects(stableFileBytesV1(path, 4)));
  const check = await directoryCustodyV1(root); await fs.chmod(root, 0o750); await assert.rejects(check()); await fs.chmod(root, 0o700);
});

test('trust lock: failed initialization never removes a replacement lock', async t => {
  const f = await releaseFixture(t), lock = f.key.trustPath + '.lock';
  await patch('open', old => async (p, ...args) => {
    const handle = await old(p, ...args);
    if (p === lock) handle.writeFile = async () => {
      await fs.rename(lock, lock + '.owned'); await write(lock, 'replacement');
      throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
    };
    return handle;
  }, () => assert.rejects(raise({trustPath:f.key.trustPath,installedVersion:'2.0.0'}, {expectedUid:uid,attempts:0}), {code:'ENOSPC'}));
  assert.equal(await fs.readFile(lock, 'utf8'), 'replacement');
});

test('journal: interrupted append releases transaction lock and retry validates', async t => {
  const root = await fixture(t); await fs.mkdir(join(root, 'updater-state'));
  const journal = new Journal(root, {ownerUid:uid, checkpoint:point => { if (point === 'append_before_write') throw new Error('fixture stop'); }});
  await assert.rejects(journal.intent({runId:'interrupted',ordinal:1}), /fixture stop/);
  await assert.rejects(fs.lstat(join(root, 'updater-state/journal.lock')), {code:'ENOENT'});
  const retry = new Journal(root, {ownerUid:uid}); await retry.intent({runId:'retry',ordinal:1});
  assert.equal((await retry.validate()).entries.length, 1);
});

test('journal: dead writer lock recovers, malformed and live locks refuse', async t => {
  const root = await fixture(t); await fs.mkdir(join(root, 'updater-state'));
  const journal = new Journal(root, {ownerUid:uid}), path = join(root, 'updater-state/journal.lock');
  const child = spawnSync(process.execPath, ['-e','process.stdout.write(String(process.pid))'], {encoding:'utf8'});
  assert.equal(child.status, 0); const deadPid = Number(child.stdout); assert.ok(deadPid > 1);
  for (const body of ['{', 'null', '{}', JSON.stringify({pid:-0x7fffffff}), JSON.stringify({pid:process.pid}), JSON.stringify({pid:0}), JSON.stringify({pid:1e30})]) {
    await write(path, body); await assert.rejects(journal.intent({runId:'refused',ordinal:1}), {code:'updater_journal_busy'});
    assert.equal(await fs.readFile(path, 'utf8'), body); await fs.unlink(path);
  }
  await write(path, JSON.stringify({pid:deadPid})); await journal.intent({runId:'recovered',ordinal:1});
  assert.equal((await journal.validate()).entries.length, 1);
});

test('journal: a reclaimed PID stamp is cleared under the kernel lock, so a killed holder cannot strand it', async t => {
  const root = await fixture(t); await fs.mkdir(join(root, 'updater-state')); const path = join(root, 'updater-state/journal.lock');
  const dead = spawnSync(process.execPath, ['-e','process.stdout.write(String(process.pid))'], {encoding:'utf8'});
  assert.equal(dead.status, 0); await write(path, JSON.stringify({pid:Number(dead.stdout)}));
  const module = pathToFileURL(resolve('src/updater/v1/journal.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {FileStepJournalV1} from ${JSON.stringify(module)};
    const journal=new FileStepJournalV1(process.argv[1],{ownerUid:process.getuid(),checkpoint:async point=>{if(point==='append_before_open'){process.stdout.write('held\\n');setInterval(()=>{},1000);await new Promise(resume=>{globalThis.resume=resume;});}}});
    await journal.intent({runId:'killed',ordinal:1});`, root], {detached:true, stdio:['ignore','pipe','ignore']});
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed)); let timer;
  try {
    await new Promise((resolveHeld, rejectHeld) => { timer = setTimeout(() => rejectHeld(new Error('lock_not_held')), 10000);
      child.once('error', rejectHeld); child.stdout.once('data', resolveHeld); });
    // A stamp left behind would name a PID that can be reused; the holder empties it.
    assert.equal(await fs.readFile(path, 'utf8'), '');
    await assert.rejects(new Journal(root, {ownerUid:uid}).intent({runId:'contender',ordinal:1}), {code:'updater_journal_busy'});
    process.kill(-child.pid, 'SIGKILL'); await closed;
    const retry = new Journal(root, {ownerUid:uid}); await retry.intent({runId:'retry',ordinal:1});
    assert.equal((await retry.validate()).entries.length, 1);
    await assert.rejects(fs.lstat(path), {code:'ENOENT'});
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await closed;
  }
});

test('journal: unsafe transaction lock files refuse and stay in place', async t => {
  const root = await fixture(t); await fs.mkdir(join(root, 'updater-state')); const path = join(root, 'updater-state/journal.lock');
  const journal = new Journal(root, {ownerUid:uid});
  for (const [plant, still] of [[() => write(path, '', 0o644), async () => (await fs.lstat(path)).mode & 0o777],
    [async () => { await write(path, ''); await fs.link(path, path + '.alias'); }, async () => (await fs.lstat(path)).nlink],
    [() => fs.symlink(join(root, 'elsewhere'), path), async () => fs.readlink(path)],
    [() => fs.mkdir(path), async () => (await fs.lstat(path)).isDirectory()],
    [async () => fifo(path), async () => (await fs.lstat(path)).isFIFO()]]) {
    await plant(); const before = await still();
    await assert.rejects(journal.intent({runId:'refused',ordinal:1}), {code:/^updater_\w+_refused$/u});
    assert.deepEqual(await still(), before);
    await fs.rm(path, {recursive:true, force:true}); await fs.rm(path + '.alias', {force:true});
  }
  await journal.intent({runId:'clean',ordinal:1}); assert.equal((await journal.validate()).entries.length, 1);
});

test('status: writable root or status directory refuses without a temporary file', async t => {
  const root = await fixture(t), dir = join(root, 'status'); await fs.mkdir(dir, {mode:0o700});
  for (const directory of [root,dir]) {
    await fs.chmod(directory, 0o777);
    try { await assert.rejects(status({root,status:'stopped',reason:'fixture'})); assert.deepEqual(await fs.readdir(dir), []); }
    finally { await fs.chmod(directory, 0o700); }
  }
});

test('journal: fifty stale-lock recoverers preserve one chain and allow retry', async t => {
  const root = await fixture(t); await fs.mkdir(join(root, 'updater-state'));
  const child = spawnSync(process.execPath, ['-e','process.stdout.write(String(process.pid))'], {encoding:'utf8'});
  assert.equal(child.status, 0); await write(join(root,'updater-state/journal.lock'), JSON.stringify({pid:Number(child.stdout)}));
  const results = await Promise.allSettled(Array.from({length:50}, (_,i) => new Journal(root,{ownerUid:uid}).intent({runId:'recovery',ordinal:i+1})));
  const successes = results.filter(r=>r.status==='fulfilled').length; assert.ok(successes >= 1);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='updater_journal_busy'));
  const retry = new Journal(root,{ownerUid:uid}); assert.equal((await retry.validate()).entries.length, successes);
  await retry.intent({runId:'retry',ordinal:1}); assert.equal((await retry.validate()).entries.length, successes+1);
});

test('custody: static ancestor symlink and changed directory identity refuse', async t => {
  const { stableFileBytesV1, directoryCustodyV1 } = await import('../src/installer/shared/file-custody.mjs');
  const root = await fixture(t), real = join(root,'real'), alias = join(root,'alias');
  await fs.mkdir(join(real,'nested'),{recursive:true}); await write(join(real,'nested/held'),'safe'); await fs.symlink(real,alias);
  await assert.rejects(stableFileBytesV1(join(alias,'nested/held'),4));
  const check = await directoryCustodyV1(real); await fs.rename(real,real+'.old'); await fs.mkdir(real);
  await assert.rejects(check());
});

test('status: failed temporary write preserves a replacement inode', async t => {
  const root = await fixture(t); await fs.mkdir(join(root,'status'));
  let replacement;
  await patch('open', old => async (p,...args) => {
    const handle = await old(p,...args);
    if (String(p).includes('.passkey-')) handle.writeFile = async () => {
      replacement=p; await fs.rename(p,p+'.owned'); await write(p,'unrelated');
      throw Object.assign(new Error('fixture full'),{code:'ENOSPC'});
    };
    return handle;
  },()=>assert.rejects(status({root,status:'stopped',reason:'fixture'}),{code:'ENOSPC'}));
  assert.equal(await fs.readFile(replacement,'utf8'),'unrelated');
});

test('PID: bounded private regular files and decimal safe integers only', async t => {
  const root=await fixture(t), path=join(root,'pid');
  for(const body of ['','0','1','2.5','-123','+123','1e3','Infinity','9007199254740992','1'.repeat(33),' '.repeat(33)+'123','123\0','12\n34']){
    await write(path,body);assert.equal(await readPid(path),undefined);
  }
  await write(path,'12345\n');assert.equal(await readPid(path),12345);
  await fs.chmod(path,0o666);assert.equal(await readPid(path),undefined);await fs.chmod(path,0o600);
  await fs.link(path,path+'.alias');assert.equal(await readPid(path),undefined);await fs.unlink(path+'.alias');
  await fs.rename(path,path+'.real');await fs.symlink(path+'.real',path);assert.equal(await readPid(path),undefined);
});

test('builder: package metadata cap, link and post-open substitution refuse', async t => {
  const root=await fixture(t), source=join(root,'source'), output=join(root,'output');await fs.mkdir(source);await fs.mkdir(output);
  const path=join(source,'package.json'), input={source,output,commit};
  await write(path,'{"name":"wrong","version":"1.2.3"}'+ ' '.repeat(256*1024)); // the cap is 256 KiB since int9
  await assert.rejects(build(input),{code:'updater_build_input_refused'});
  await write(path,'{"name":"control-room","version":"1.2.3"}');await fs.link(path,path+'.alias');
  await assert.rejects(build(input),{code:'updater_build_input_refused'});await fs.unlink(path+'.alias');
  let collected=false;
  await patch('lstat',old=>async(p,...args)=>{if(p===join(source,'LICENSE'))collected=true;return old(p,...args);},async()=>{
    await patch('open',old=>async(p,...args)=>{const h=await old(p,...args);if(p===path){const read=h.read.bind(h);let swapped=false;h.read=async(...readArgs)=>{const value=await read(...readArgs);if(!swapped){swapped=true;await fs.rename(path,path+'.old');await write(path,'{"name":"control-room","version":"1.2.3"}');}return value;};}return h;},
      ()=>assert.rejects(build(input),{code:'updater_build_input_refused'}));
  });
  assert.equal(collected,false,'unstable metadata must refuse before collecting build inputs');
});

test('web custody: parent alias to the same checked inode still refuses', async t => {
  const root=await fixture(t), protectedRoot=join(root,'Protected'), dir=join(protectedRoot,'config');
  await fs.mkdir(dir,{recursive:true,mode:0o700});await write(join(dir,'mac-local.json'),JSON.stringify(config));
  await assert.rejects(loadRoot(protectedRoot,{lstat:fs.lstat,readFile:async(p,encoding)=>{
    await fs.rename(dir,dir+'.old');await fs.symlink(dir+'.old',dir);return fs.readFile(p,encoding);
  }}));
});

test('web custody: leaf replacement and oversized reader result refuse', async t => {
  const root=await fixture(t), path=join(root,'web.json');await write(path,JSON.stringify(config));
  await assert.rejects(load(path,{lstat:fs.lstat,readFile:async(p,encoding)=>{
    await fs.rename(p,p+'.old');await write(p,JSON.stringify({...config,workspaceId:'workspace:substituted'}));return fs.readFile(p,encoding);
  }}));
  await assert.rejects(load(path,{lstat:fs.lstat,readFile:async()=>JSON.stringify(config)+' '.repeat(65536)}));
});

test('signing custody: checked release directory substitution refuses', async t => {
  const f=await releaseFixture(t);let swapped=false;
  await patch('lstat', old=>async(p,...args)=>{
    const entry=await old(p,...args);
    if(p===f.dir&&!swapped){swapped=true;await fs.rename(p,p+'.old');await fs.mkdir(p,{mode:0o700});
      for(const name of await fs.readdir(p+'.old'))await fs.copyFile(join(p+'.old',name),join(p,name));
    }
    return entry;
  },()=>assert.rejects(signRelease(f.input,{expectedUid:uid})));
});

test('journal: twenty separate processes acknowledge only a valid shared chain', async t => {
  const root=await fixture(t);await fs.mkdir(join(root,'updater-state'));
  const runner=join(root,'writer.mjs');await write(runner,`const {FileStepJournalV1}=await import(process.argv[2]);
try{await new FileStepJournalV1(process.argv[3],{ownerUid:process.getuid()}).intent({runId:'process',ordinal:Number(process.argv[4])});}
catch(error){if(error.code==='updater_journal_busy')process.exitCode=2;else{console.error(error.code);process.exitCode=1;}}`);
  const children=[], completions=[];
  try {
    for(let ordinal=1;ordinal<=20;ordinal++){
      const child=spawn(process.execPath,[runner,pathToFileURL(resolve('src/updater/v1/journal.mjs')).href,root,String(ordinal)],{detached:true,stdio:'ignore'});
      children.push(child);completions.push(new Promise((resolveDone,rejectDone)=>{child.once('error',rejectDone);child.once('exit',code=>resolveDone(code));}));
    }
    const results=await Promise.all(completions);assert.ok(results.every(code=>code===0||code===2));
    const successes=results.filter(code=>code===0).length;assert.ok(successes>0);
    const journal=new Journal(root,{ownerUid:uid});assert.equal((await journal.validate()).entries.length,successes);
    await journal.intent({runId:'retry',ordinal:1});assert.equal((await journal.validate()).entries.length,successes+1);
  } finally {
    for(const child of children){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    await Promise.allSettled(completions);
    for(const child of children)assert.throws(()=>process.kill(-child.pid,0),{code:'ESRCH'});
  }
});

test('journal: replaced transaction lock refuses without deleting its replacement', async t => {
  const root=await fixture(t);await fs.mkdir(join(root,'updater-state'));const path=join(root,'updater-state/journal.lock');
  const journal=new Journal(root,{ownerUid:uid,checkpoint:async point=>{if(point==='append_done'){await fs.rename(path,path+'.owned');await write(path,'replacement');}}});
  await assert.rejects(journal.intent({runId:'fixture',ordinal:1}),{code:'updater_journal_owner_refused'});
  assert.equal(await fs.readFile(path,'utf8'),'replacement');
});

test('web custody: optional installed readers reject substituted or oversized files', async t => {
  const {loadWorkIntakeServerConfigurationFromRootV1,loadOwnerWebPushConfigFromRootV1,loadMacLocalDatabaseRolesFromRootV1}=await import('../src/web/v1/mac-local-protected-loader.ts');
  const {mac:base,composer}=await import('./support/hardening-config.mjs');
  const {composeProtectedConfigV1}=await import('../src/updater/v1/services/protected-config.mjs');
  const {captureMacLocalProtectedConfigurationV1,captureMacLocalDatabaseRolesV1}=await import('../src/web/v1/mac-local-protected-loader.ts');
  const {captureReleaseTrustV1}=await import('../scripts/release-signing.mjs');
  const root=await fixture(t), protectedRoot=join(root,'Protected'), dir=join(protectedRoot,'config');await fs.mkdir(dir,{recursive:true,mode:0o700});
  const roles=JSON.parse(composeProtectedConfigV1(composer(root),{captureMacLocalProtectedConfigurationV1,captureMacLocalDatabaseRolesV1,captureReleaseTrustV1}).find(x=>x.path.endsWith('/database-roles.json')).contents);
  const cases=[['work-intake-server.json',loadWorkIntakeServerConfigurationFromRootV1,{schema:'control-room.work-intake-server/v1',port:12345,database:{...base.database,username:'control_room_work_intake_agent'},integrityKey:'a'.repeat(43),queueDepthLimit:1,credentials:[]}],
    ['owner-web-push.json',loadOwnerWebPushConfigFromRootV1,{schema:'control-room.owner-web-push-config/v1',subject:'mailto:fixture@example.invalid',publicKey:'a'.repeat(87),privateKey:'b'.repeat(43)}],
    ['database-roles.json',loadMacLocalDatabaseRolesFromRootV1,roles]];
  for(const [name,read,value] of cases){
    const path=join(dir,name);await write(path,JSON.stringify(value));assert.ok(await read(protectedRoot));
    await assert.rejects(read(protectedRoot,{lstat:fs.lstat,readFile:async(p,encoding)=>{await fs.rename(p,p+'.old');await write(p,JSON.stringify(value));return fs.readFile(p,encoding);}}));
    await assert.rejects(read(protectedRoot,{lstat:fs.lstat,readFile:async()=>JSON.stringify(value)+' '.repeat(65536)}));
  }
});

test('first-owner custody: parent substitution during read refuses', async t => {
  const root=await fixture(t);await ensure(root);const dir=join(root,'updater-state');
  await assert.rejects(readState(root,{open:async(...args)=>{
    const handle=await fs.open(...args),read=handle.readFile.bind(handle);
    handle.readFile=async()=>{const value=await read();await fs.rename(dir,dir+'.old');await fs.symlink(dir+'.old',dir);return value;};
    return handle;
  }}),{code:'first_owner_state_refused'});
});

test('custody: opened descriptor metadata is checked before reading bytes', async t => {
  const {stableFileBytesV1}=await import('../src/installer/shared/file-custody.mjs');
  const root=await fixture(t),path=join(root,'held');await write(path,'safe');let reads=0;
  await patch('open',old=>async(p,...args)=>{
    const handle=await old(p,...args);
    if(p===path){const stat=handle.stat.bind(handle),read=handle.read.bind(handle);
      handle.stat=async()=>{const entry=await stat();entry.mode^=0o020;return entry;};
      handle.read=async(...readArgs)=>{reads++;return read(...readArgs);};}
    return handle;
  },()=>assert.rejects(stableFileBytesV1(path,4)));
  assert.equal(reads,0);
});


test('web custody: root replacement during policy inspection refuses', async t => {
  const root=await fixture(t), protectedRoot=join(root,'Protected'), dir=join(protectedRoot,'config');
  await fs.mkdir(dir,{recursive:true,mode:0o700});await write(join(dir,'mac-local.json'),JSON.stringify(config));
  let swapped=false;
  await assert.rejects(loadRoot(protectedRoot,{lstat:async path=>{
    const entry=await fs.lstat(path);
    if(path===protectedRoot&&!swapped){swapped=true;await fs.rename(protectedRoot,protectedRoot+'.old');await fs.mkdir(dir,{recursive:true,mode:0o700});await write(join(dir,'mac-local.json'),JSON.stringify(config));}
    return entry;
  },readFile:fs.readFile}));
});


test('custody: FIFO substituted before descriptor open refuses promptly', async t => {
  const {stableFileBytesV1}=await import('../src/installer/shared/file-custody.mjs');
  const root=await fixture(t), path=join(root,'held');await write(path,'safe');let swapped=false,settled=false;
  await patch('open',old=>async(p,...args)=>{if(p===path&&!swapped){swapped=true;await fs.rename(path,path+'.old');fifo(path);}return old(p,...args);},async()=>{
    const pending=stableFileBytesV1(path,4).then(()=>{settled=true;return null;},error=>{settled=true;return error;});
    await new Promise(resolve=>setTimeout(resolve,150));const promptly=settled;
    const writer=await fs.open(path,constants.O_RDWR|constants.O_NONBLOCK);try{assert.ok(await pending);}finally{await writer.close();}
    assert.equal(promptly,true);
  });
});


test('status custody: parent replaced during policy inspection refuses before writing', async t => {
  const root=await fixture(t), dir=join(root,'status');await fs.mkdir(dir,{mode:0o700});let swapped=false;
  await patch('lstat',old=>async(path,...args)=>{
    const entry=await old(path,...args);
    if(path===dir&&!swapped){swapped=true;await fs.rename(dir,dir+'.old');await fs.mkdir(dir,{mode:0o700});}
    return entry;
  },()=>assert.rejects(status({root,status:'stopped',reason:'fixture'})));
  assert.deepEqual(await fs.readdir(dir),[]);
});
