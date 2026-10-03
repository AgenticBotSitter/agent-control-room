import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, chmod, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import * as c from '../scripts/fleet/connector.mjs';
import * as u from '../scripts/fleet/connector-update.mjs';
import * as s from '../scripts/release-signing.mjs';
import { buildFleetConnectorReleaseForTestV1 } from '../scripts/build-fleet-connector.mjs';
import { signAttendedConnectorReleaseV1 } from '../src/updater/v1/install/connector-release.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({format:'der',type:'spki'}).toString('base64url');
const trust = { schema:s.RELEASE_TRUST_SCHEMA_V1, epoch:1, keyId:s.releaseKeyIdV1(publicKey), publicKey,
  versionFloor:'0.5.0', revokedKeyIds:[] };
const commit = 'a'.repeat(40);
const digest = b => createHash('sha256').update(b).digest('hex');
const agreement = {version:c.WORKING_AGREEMENT.version,digest:c.WORKING_AGREEMENT.digest,startsWork:false,grantsAuthority:false};
const worker = {workerId:`fleet-worker:${'a'.repeat(32)}`,displayName:'QA',workerKind:'codex',projectIds:['project:qa'],
  capabilities:['writing'],credentialExpiresAt:'2099-01-01T00:00:00.000Z',workingAgreement:agreement,operationsMode:'paused'};
function advertised(bytes, version='0.5.0') {
  const value = {version,file:`connector-${version}.mjs`,sha256:digest(bytes),size:bytes.length,builtFrom:commit,minVersion:'0.5.0'};
  return {...value,signature:sign(null,s.connectorReleaseSignatureMaterialV1(value),keys.privateKey).toString('base64url')};
}
async function temporary(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'fleet-robust-')));
  t.after(()=>rm(root,{recursive:true,force:true})); return root;
}
async function configAt(root) {
  const path=join(root,'bot.json');
  const config={schema:'control-room.fleet-connector/v1',server:'https://control.example',...worker,
    secret:`crf_${'A'.repeat(43)}`};
  await writeFile(path,JSON.stringify(config),{mode:0o600});return {path,config};
}

test('A4-04: signer refuses a mislabeled bundle and updater reverts its reported version mismatch',async t=>{
  const root=await temporary(t),output=join(root,'output'),dir=join(output,'dist-vps/server/fleet/release');
  const built=await buildFleetConnectorReleaseForTestV1({root:dir,builtFrom:commit,releaseTrust:trust});
  const bytes=await readFile(join(dir,built.manifest.file));
  assert.match(bytes.toString(),/CONNECTOR_VERSION = "0.5.0"/);
  const manifest={...built.manifest,version:'0.6.0',file:'connector-0.6.0.mjs'};
  await rm(join(dir,built.manifest.file));
  await writeFile(join(dir,manifest.file),bytes,{mode:0o400});
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));await chmod(join(dir,'manifest.json'),0o400);
  const files=[];
  for(const name of [manifest.file,'manifest.json']) {
    const body=await readFile(join(dir,name));
    files.push({path:`dist-vps/server/fleet/release/${name}`,sha256:`sha256:${digest(body)}`,mode:0o400,bytes:body.length});
  }
  await writeFile(join(output,'RELEASE_MANIFEST.json'),JSON.stringify({schema:'control-room.attended-build-manifest/v1',
    commit,version:'1.2.3',files,fileCount:files.length,byteCount:files.reduce((n,f)=>n+f.bytes,0)}),{mode:0o400});
  const key=join(root,'ephemeral-key.pem');
  await writeFile(key,keys.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  await t.test('signer binds bundled version to manifest',async()=>{await assert.rejects(signAttendedConnectorReleaseV1({output,commit,trust,privateKeyPath:key},{expectedUid:process.geteuid()}),/attended_connector_release_refused/);});
  const signed=advertised(bytes,'0.6.0');
  const actual=await import(pathToFileURL(join(dir,manifest.file)).href);
  assert.equal(actual.CONNECTOR_VERSION,'0.5.0');
  const seenVersions=[];
  const server=createServer(async(req,res)=>{
    let raw=''; for await(const chunk of req) raw+=chunk;
    if(req.url==='/fleet/v1/heartbeat') seenVersions.push(JSON.parse(raw).connectorVersion);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,result:worker}));
  });
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
  const installRoot=join(root,'installed'),sourcePath=join(dir,manifest.file),shimPath=join(installRoot,'bin/mcp');
  await u.installConnectorLauncherV1({installRoot,sourcePath,shimPath,version:'0.5.0',trust,advertisement:advertised(bytes)});
  const {path:configPath,config}=await configAt(root);
  config.server=`http://127.0.0.1:${server.address().port}`;
  config.installation={updates:c.connectorUpdateSettingsFromReleaseTrustV1(trust)};
  await writeFile(configPath,JSON.stringify(config));
  const update=await u.checkForConnectorUpdateV1({installRoot,configPath,config,advertised:signed,currentVersion:'0.5.0',
    fetcher:async()=>new Response(bytes)});
  assert.deepEqual(update,{state:'reverted',version:'0.5.0',failedVersion:'0.6.0'});
  assert.deepEqual(seenVersions,['0.5.0']);
  const paths=u.connectorUpdatePathsV1(installRoot);
  assert.equal(JSON.parse(await readFile(paths.trust)).versionFloor,'0.5.0');
});

test('A4-04: default health child refuses missing, mismatched, and oversized version reports',async t=>{
  const root=await temporary(t);
  for(const [name,report,healthy] of [
    ['missing','',false],['wrong',JSON.stringify({connectorVersion:'0.5.0'}),false],
    ['oversized',' '.repeat(5000)+JSON.stringify({connectorVersion:'0.6.0'}),false],
    ['correct',JSON.stringify({connectorVersion:'0.6.0'}),true],
  ]) {
    const directory=join(root,name);await mkdir(directory);
    const installRoot=join(directory,'installed'),sourcePath=join(directory,'old.mjs');
    const bytes=Buffer.from('process.exit(0);');await writeFile(sourcePath,bytes);
    await u.installConnectorLauncherV1({installRoot,sourcePath,shimPath:join(installRoot,'bin/mcp'),version:'0.5.0',trust,advertisement:advertised(bytes)});
    const {path:configPath,config}=await configAt(directory);
    config.installation={updates:c.connectorUpdateSettingsFromReleaseTrustV1(trust)};await writeFile(configPath,JSON.stringify(config));
    const candidate=Buffer.from(name==='oversized'
      ? `process.stdout.write('{"connectorVersion":"0.6.0"}'); setTimeout(()=>{process.stdout.write(" ".repeat(5000));process.exit(0);},100);`
      : `process.stdout.write(${JSON.stringify(report)});`);
    const result=await u.checkForConnectorUpdateV1({installRoot,configPath,config,advertised:advertised(candidate,'0.6.0'),currentVersion:'0.5.0',
      fetcher:async()=>new Response(candidate)});
    assert.equal(result.state,healthy?'updated':'reverted',name);
    assert.equal(JSON.parse(await readFile(u.connectorUpdatePathsV1(installRoot).trust)).versionFloor,healthy?'0.6.0':'0.5.0');
  }
});

test('A4-04: an exited health child cannot pass using a partial oversized report',async()=>{
  let kills=0;
  const healthy=await u.connectorCandidateHealthCheckV1('/fixture/candidate','/fixture/config','0.6.0',{spawner:()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{kills++;return false;};
    queueMicrotask(()=>{
      child.stdout.emit('data',Buffer.from('{"connectorVersion":"0.6.0"}'));
      child.stdout.emit('data',Buffer.from(' '.repeat(5000)));
      child.emit('close',0);
    });
    return child;
  }});
  assert.equal(healthy,false);
  assert.equal(kills,1);
});

test('A4-04: healthy connector CLI reports its running version',async t=>{
  const root=await temporary(t),{path}=await configAt(root);
  let output='';
  const code=await c.main(['health-check','--config',path],{out:{write:v=>{output+=v;}},err:{write(){}}},
    {fetcher:async()=>Response.json({ok:true,result:worker})});
  assert.equal(code,0);
  assert.equal(JSON.parse(output).connectorVersion,c.CONNECTOR_VERSION);
});
