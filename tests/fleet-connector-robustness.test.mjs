import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, chmod, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import * as c from '../scripts/fleet/connector.mjs';
import * as s from '../scripts/release-signing.mjs';
import { buildFleetConnectorReleaseForTestV1 } from '../scripts/build-fleet-connector.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({format:'der',type:'spki'}).toString('base64url');
const trust = { schema:s.RELEASE_TRUST_SCHEMA_V1, epoch:1, keyId:s.releaseKeyIdV1(publicKey), publicKey,
  versionFloor:'0.5.0', revokedKeyIds:[] };
const commit = 'a'.repeat(40);
const digest = b => createHash('sha256').update(b).digest('hex');
const reply = result => new Response(JSON.stringify({ok:true,result}));
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

test('A4-01: background service retains its custom config without install environment',async t=>{
  const root=await temporary(t), home=join(root,'home'); await mkdir(home);
  const built=await buildFleetConnectorReleaseForTestV1({root:join(root,'release'),builtFrom:commit,releaseTrust:trust});
  const sourcePath=join(root,'release',built.manifest.file), bytes=await readFile(sourcePath);
  const b=await import(pathToFileURL(sourcePath).href);
  const env={XDG_CONFIG_HOME:join(root,'custom-config'),CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'};
  const fetcher=async url=>String(url).endsWith('connector-manifest.json')?new Response('',{status:404})
    :reply({...worker,releaseTrust:trust,connector:advertised(bytes)});
  const installed=await b.installConnector({server:'https://control.example',code:`crj_${'A'.repeat(43)}`,
    bot:'codex',name:'qa',homeDir:home,realHomeDir:home,env,platform:'darwin',fetcher,
    runner:async()=>({stdout:'',stderr:''}),sourcePath,unattended:true,workerExecutable:'/fixture/codex',ownerUid:501});
  const xml=await readFile(installed.paths.servicePath,'utf8');
  const parsed=JSON.parse(execFileSync('python3',['-c','import sys,plistlib,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'],{input:xml,encoding:'utf8'}));
  const args=parsed.ProgramArguments.slice(3);
  assert.equal(args[0],'run'); assert.equal(args[args.indexOf('--config')+1],installed.paths.configPath);
  let err=''; const io={out:{write(){}},err:{write(v){err+=v;}}};
  const code=await b.main([...args,'--once'],io,{homeDir:home,env:{HOME:home,CONTROL_ROOM_CONNECTOR_LAUNCHED:'1',
    CONTROL_ROOM_CONNECTOR_INSTALL_ROOT:installed.paths.installRoot,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'},fetcher});
  assert.equal(code,0);
  const fixed=await b.main([...args,'--config',installed.paths.configPath,'--once'],io,
    {homeDir:home,env:{HOME:home,CONTROL_ROOM_CONNECTOR_LAUNCHED:'1',CONTROL_ROOM_CONNECTOR_INSTALL_ROOT:installed.paths.installRoot,
      CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'},fetcher});
  assert.equal(fixed,0,await readFile(installed.paths.serviceLogPath,'utf8'));
});

test('A4-02: malformed replies stay in the retry path and fail health',async t=>{
  const root=await temporary(t), {path}=await configAt(root);
  const outcomes=await Promise.all(Array.from({length:20},async()=>{
    try { return await c.runWorker({configPath:path,once:true,fetcher:async()=>reply(null),log(){}}); }
    catch(e){throw e;}
  }));
  assert.ok(outcomes.some(x=>x.state==='unreachable'));
  assert.ok(outcomes.every(x=>['unreachable','already_running'].includes(x.state)));
  let output='';
  const health=await c.main(['health-check','--config',path],{out:{write(v){output+=v;}},err:{write(v){output+=v;}}},
    {fetcher:async()=>reply(null)});
  assert.equal(health,1);
  const adapterPath=join(root,'adapter.mjs'); await writeFile(adapterPath,'export const unused = true;',{mode:0o600});
  const settings=join(root,'harnesses.json');
  await writeFile(settings,JSON.stringify({schema:'control-room.fleet-harnesses/v1',adapterModule:adapterPath,
    harnesses:{codex:{enabled:true,deadlineMs:1000}}}),{mode:0o600});
  let executions=0;
  const importer=async()=>({createFleetHarnessAdapter:()=>({execute:async()=>{executions++;return {text:'ok'};}})});
  const fetcher=async url=>String(url).endsWith('/heartbeat')?reply({...worker,operationsMode:'running'})
    :String(url).endsWith('/work')?reply([{offerId:'fleet-offer:fixture',jobId:'job:fixture'}]):reply({});
  assert.equal((await c.runWorker({configPath:path,harnessesPath:settings,once:true,fetcher,importer,log(){}})).state,'unreachable');
  assert.equal(executions,0);
  const retry=await c.runWorker({configPath:path,once:true,fetcher:async()=>reply({...worker,workerKind:'mcp-agent'}),log(){}});
  assert.equal(retry.state,'no_harness');
});

test('A4-03: service paths refuse controls before serialization',()=>{
  for(const field of ['XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','APPDATA','LOCALAPPDATA']) {
    for(const control of ['\r','\u0001','\u0000','\u007f']) {
      assert.throws(()=>c.connectorInstallPaths({homeDir:'/fixture/home',name:'qa',workspace:'/fixture/work',
        platform:field.includes('APPDATA')?'win32':'darwin',env:{[field]:`/fixture/x${control}y`}}));
    }
  }
  const paths=c.connectorInstallPaths({homeDir:'/fixture/home',name:'qa',env:{},platform:'darwin'});
  assert.throws(()=>c.connectorServiceDefinition({...paths,serviceLogPath:'/fixture/x\ry'},{platform:'darwin'}));
  assert.throws(()=>c.connectorServiceDefinition(paths,{platform:'darwin',nodePath:'/fixture/x\ry'}));
});
test('A4-05: 20 concurrent direct joins preserve the sole winning credential',async t=>{
  const root=await temporary(t),configPath=join(root,'join.json'),bytes=Buffer.from('fixture');
  let enrolled=0;
  const fetcher=async url=>{
    if(String(url).endsWith('connector-manifest.json')) {await delay(30);return new Response('',{status:404});}
    if(++enrolled===1) return reply({...worker,releaseTrust:trust,connector:advertised(bytes)});
    await delay(60);return new Response(JSON.stringify({ok:false,error:'conflict'}),{status:409});
  };
  const input={server:'https://control.example',code:`crj_${'Q'.repeat(43)}`,workerKind:'codex',configPath,fetcher};
  const results=await Promise.allSettled(Array.from({length:20},()=>c.join(input)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,19);
  assert.equal(enrolled,1);
  assert.equal((await c.loadConfig(configPath)).workerId,worker.workerId);
});
test('A2-05: tool manifest refuses process argument controls', async t => {
  const root=await mkdtemp(join(tmpdir(),'tool-arg-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'tools.json');
  const value={schema:'control-room.local-tool-adapters/v1',maxConcurrent:1,adapters:[{id:'qa',capability:'tool.qa',executable:'/usr/bin/true',arguments:['{input:source}','{output:result}'],timeoutMs:1000,maxOutputBytes:1024,envAllowlist:[]}]};
  await writeFile(path,JSON.stringify(value),{mode:0o600});
  const valid=await c.loadToolAdapters(path); assert.equal(valid.adapters.size,1);
  value.adapters[0].arguments.push('bad\0argument'); await writeFile(path,JSON.stringify(value));
  await assert.rejects(c.loadToolAdapters(path));
  // Node refuses before an executable can run; no real tool or bot is launched.
  assert.throws(()=>execFileSync('/usr/bin/true',['bad\0argument']),error=>error.code==='ERR_INVALID_ARG_VALUE');
  for(const arg of ['bad\nargument','$(echo x)','x;y','a{input:x}']) {
    value.adapters[0].arguments[2]=arg;await writeFile(path,JSON.stringify(value));await assert.rejects(c.loadToolAdapters(path));
  }
});

test('A4-05: refusal cleanup removes only its own pending nonce',async t=>{
  const root=await temporary(t);
  for(const replacement of ['joined','other_nonce','own_nonce']) {
    const configPath=join(root,`${replacement}.json`);
    const fetcher=async(url,init)=>{
      if(String(url).endsWith('connector-manifest.json')) return new Response('',{status:404});
      const nonce=JSON.parse(init.body).clientNonce;
      await writeFile(configPath,JSON.stringify({schema:'control-room.fleet-connector/v1',server:'https://control.example',
        workerId:replacement==='joined'?worker.workerId:null,secret:`crf_${'A'.repeat(43)}`,
        clientNonce:replacement==='other_nonce'?`crn_${'Z'.repeat(43)}`:nonce}),{mode:0o600});
      return new Response(JSON.stringify({ok:false,error:'conflict'}),{status:409});
    };
    await assert.rejects(c.join({server:'https://control.example',code:`crj_${'Q'.repeat(43)}`,
      workerKind:'codex',configPath,fetcher}),e=>e.code==='conflict');
    if(replacement==='own_nonce') await assert.rejects(c.loadConfig(configPath),/not joined yet/);
    else assert.equal((await c.loadConfig(configPath)).workerId,replacement==='joined'?worker.workerId:null);
  }
});

test('A4-02: malformed heartbeat backs off repeatedly, recovers, and stops on revocation',async t=>{
  const root=await temporary(t),{path}=await configAt(root);
  const delays=[],logs=[];
  let calls=0;
  const result=await c.runWorker({configPath:path,pollMs:1000,random:()=>1,sleep:async ms=>{delays.push(ms);},log:v=>logs.push(v),
    fetcher:async()=>{
      calls++;
      if(calls<=20)return reply(null);
      if(calls===21)return reply({...worker,workerKind:'mcp-agent'});
      return new Response(JSON.stringify({ok:false,error:'unauthenticated'}),{status:401});
    }});
  assert.equal(result.state,'revoked');
  assert.equal(calls,22);
  assert.deepEqual(delays.slice(0,4),[1000,2000,4000,8000]);
  assert.ok(delays.slice(4,20).every(ms=>ms>=8000&&ms<=60000));
  assert.equal(delays.at(-1),1000,'valid heartbeat resets failure backoff');
  assert.ok(logs.some(v=>v.includes('driven through MCP')));
});

test('A4-02: client refuses incomplete heartbeat and claim fields before callers use them',async()=>{
  const config={server:'https://control.example'};
  const claim={claimId:`fleet-claim:${'a'.repeat(32)}`,jobId:'job:qa',title:'QA',instructions:'data'};
  for(const field of ['claimId','jobId','title','instructions']) {
    for(const bad of [undefined,null,[],42]) {
      const client=c.createClient(config,async()=>reply({...claim,[field]:bad}));
      await assert.rejects(client.claim('offer:qa','key'),e=>e.code==='protocol_invalid');
    }
  }
  assert.deepEqual(await c.createClient(config,async()=>reply(claim)).claim('offer:qa','key'),claim);
  for(const bad of [null,[],{}, {...worker,workerKind:null},{...worker,displayName:[]},{...worker,workingAgreement:null}]) {
    await assert.rejects(c.createClient(config,async()=>reply(bad)).heartbeat(),e=>e.code==='protocol_invalid');
  }
});

test('A4-02: agreement mismatch is refused by worker and health without accepting server prose',async t=>{
  const root=await temporary(t),{path}=await configAt(root);
  const fetcher=async()=>reply({...worker,workingAgreement:{...agreement,digest:'bad',text:'untrusted fixture prose'}});
  assert.equal((await c.runWorker({configPath:path,once:true,fetcher,log(){}})).state,'unreachable');
  let error='';
  assert.equal(await c.main(['health-check','--config',path],{out:{write(){}},err:{write:v=>{error+=v;}}},{fetcher}),1);
  assert.ok(!error.includes('untrusted fixture prose'));
});
