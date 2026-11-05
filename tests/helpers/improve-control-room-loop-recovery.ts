import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1, type LoopBridgeBindingV1 } from "../../src/improve-control-room/v1/schemas";
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1, loopEngineStatusSchemaV1,
  type LoopAdapterConfigurationV1, type LoopAdapterV1, type LoopEngineStatusV1 } from "../../src/web/v1/improve-control-room-loop-adapter";
import { ImproveControlRoomLoopServiceV1 } from "../../src/web/v1/improve-control-room-loop-service";
import { sha256Digest } from "../../src/security";
export const recoveryKey = new Uint8Array(32).fill(73);
export const syntheticSettings = JSON.stringify({project:{host_adapter:"local-loop"},fixture:"SYNTHETIC"});
// A persistent test engine. No agents, credentials, model or network calls.
const cli = `import os,sys,json,hashlib,time,signal
root=os.path.dirname(os.path.abspath(__file__))
op,run=sys.argv[1:3];args=sys.argv[3:];file=os.path.join(root,'runs',run+'.json')
def h(s): return hashlib.sha256(s.encode()).hexdigest()
def flag(k): return args[args.index(k)+1]
with open(os.path.join(root,'trace.jsonl'),'a') as f: f.write(json.dumps(dict(op=op,run=run,args=args,env=dict(os.environ),cwd=os.getcwd(),pid=os.getpid()))+'\\n')
if op=='intake':
    with open(flag('--source')) as f: text=f.read()
    with open(flag('--settings')) as f: settings=f.read()
    s=dict(run=run,revision=1,inputVersion=1,state='draft',description=text,settingsSha256=h(settings),settingsDigest=h(settings),confirmation=None,approval=None,question=None,progress=dict(step='intake',completed=0,attention='none'),receipts=[])
else:
    with open(file) as f: s=json.load(f)
if op=='confirm-request':
    s['confirmation']=dict(path='request.md',sha256=h(s['description']),at='2026-10-01T00:00:00.000Z',who='owner',input_version=s['inputVersion']);s['state']='ready';s['revision']+=1
if op=='start': s['state']='running';s['revision']+=1;s['progress']['step']='plan'
if op=='stop': s['state']='stopped';s['revision']+=1
if op=='approve': s['approval']=None;s['revision']+=1
if op=='answer': s['question']=None;s['revision']+=1
if op=='advance': s['state']='running';s['revision']+=1
if op!='status':
    with open(file+'.tmp','w') as f: json.dump(s,f)
    os.replace(file+'.tmp',file)
if op in ['wait','advance'] and os.path.exists(os.path.join(root,'recovery-behavior.json')):
    with open(os.path.join(root,'recovery-behavior.json')) as f: behavior=json.load(f)
    mode=behavior['mode']
    if mode=='overflow': os.write(1,b'x'*65537);time.sleep(30)
    if mode=='signal': os.kill(os.getpid(),signal.SIGKILL)
    if mode=='exit': sys.exit(behavior['code'])
    if mode=='malformed': print('invalid status');sys.exit(0)
if op=='wait':
    while True: time.sleep(1)
else: print(json.dumps(dict(schema_version=1,run=run,state=s['state'],revision=s['revision'],next=None,attention=[],steps=[],counters=dict(fixture=s),error=None)))
`;
export async function syntheticRecoveryEngine(t: TestContext) {
  await mkdir(resolve('.test-tmp'),{recursive:true});
  const root=await mkdtemp(resolve('.test-tmp/b3a-fixture-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const d of ['runs','work'])await mkdir(join(root,d));
  await writeFile(join(root,'engine.py'),cli);await writeFile(join(root,'tooling.json'),'SYNTHETIC recovery v1');
  await writeFile(join(root,'settings.json'),syntheticSettings);await writeFile(join(root,'availability.json'),'{}');
  const interpreter=realpathSync(process.platform==='darwin'?'/Library/Developer/CommandLineTools/usr/bin/python3':'/usr/bin/python3');
  const toolingRevision=`sha256:${loopByteHashV1('SYNTHETIC recovery v1')}`;
  const lineage={toolingRevision,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),
    decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),
    matchesSavedInput:(_run:unknown,o:{settingsDigest:string;confirmation:{path:string;sha256:string}},i:{description:string;settingsText:string})=>o.settingsDigest===loopByteHashV1(i.settingsText)&&o.confirmation.path==='request.md'&&o.confirmation.sha256===loopByteHashV1(i.description)};
  const edit=async(run:string,patch:Partial<LoopEngineStatusV1>)=>{
    const file=join(root,'runs',run+'.json'),s=JSON.parse(await readFile(file,'utf8'));const {decisions:_decisions,...saved}=patch;await writeFile(file,JSON.stringify({...s,...saved,run:s.run}));
  };
  const configuration:LoopAdapterConfigurationV1={adapterId:'adapter:synthetic',toolingRevision,
    interpreter,interpreterSha256:loopByteHashV1(await readFile(interpreter)),
    entrypoint:join(root,'engine.py'),entrypointSha256:loopByteHashV1(cli),toolingManifest:join(root,'tooling.json'),configRoot:root,
    runRoot:join(root,'runs'),workRoot:join(root,'work'),cwd:root,settingsFile:join(root,'settings.json'),availabilityFile:join(root,'availability.json'),
    settingsSha256:loopByteHashV1(syntheticSettings),availabilitySha256:loopByteHashV1('{}'),executionIdentity:{uid:process.getuid!(),isolationEvidenceDigest:sha256Digest('SYNTHETIC isolation')},
    contract:{lineage,schemaDigest:sha256Digest('SYNTHETIC recovery schema'),generateRunId:()=>`fixture-run-${randomBytes(16).toString('hex')}`,
      qualifiedOperations:['intake','confirm','start','stop','approve','answer'],decodeStatus:(v:unknown)=>{
        const e=v as {run:string;counters:{fixture:object}};
        return loopEngineStatusSchemaV1.parse({...e.counters.fixture,run:{adapterId:'adapter:synthetic',loopRunId:e.run,toolingRevision,a2SchemaVersion:1}});
      },
      // This recovery-only fixture ignores expectation contents; the bridge suite
      // separately proves engine compare-and-admit through its unwrapped adapter.
      admissionExpectation:()=>({fixture:"SYNTHETIC recovery"})}};
  const raw=createImproveControlRoomLoopAdapterV1(configuration);t.after(()=>raw.close());
  const apply=async(op:'intake'|'confirm'|'start'|'stop'|'approve'|'answer',id:string,b:LoopBridgeBindingV1,fence:()=>void,text?:string)=>{
    const s=await(op==='intake'?raw.intake(id,b,text!,fence):op==='confirm'?raw.confirmRequest(id,b,fence):op==='answer'?raw.answer(id,b,text!,fence):raw[op](id,b,fence));
    // These operations formerly created no fixture command files. Recovery
    // tests seed retained files explicitly; discard only new pin-only scratch.
    if(['confirm','start','approve'].includes(op))await raw.releaseCommandFiles!(id);
    s.receipts.push({commandId:id,bindingDigest:sha256Digest(b),state:'accepted',error:null,evidenceDigest:sha256Digest({id,op})});
    await edit(b.loopRunId,s);return s;
  };
  const adapter:LoopAdapterV1={...raw,intake:(id,b,text,f)=>apply('intake',id,b,f,text),confirmRequest:(id,b,f)=>apply('confirm',id,b,f),start:(id,b,f)=>apply('start',id,b,f),stop:(id,b,f)=>apply('stop',id,b,f),approve:(id,b,f)=>apply('approve',id,b,f),answer:(id,b,text,f)=>apply('answer',id,b,f,text)};
  const traces=async()=>{try{return(await readFile(join(root,'trace.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s)) as {op:string;run:string;args:string[];pid:number}[];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e;}};
  return{root,configuration,adapter,raw,edit,traces};
}
export async function seedRecoveryRun(f:{db:import('../../src/persistence/database').DatabaseClient;scope:{tenantId:string;workspaceId:string};identity:import('../../src/web/v1/access-verifier').VerifiedWebIdentity},
  engine:Awaited<ReturnType<typeof syntheticRecoveryEngine>>,projectId:string,clock:()=>number,key='b3a-seed',pendingStart=false,existingBridge?:ImproveControlRoomLoopServiceV1){
  const presentation=(await f.db.query<{template_id:string}>(`SELECT payload->'presentation'->>'templateId' AS template_id FROM projects WHERE id=$1`,[projectId])).rows[0]?.template_id;
  if(presentation!=='control-room')await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`,[projectId]);
  const wrap=(tx:import('../../src/persistence/database').DatabaseSession):import('../../src/persistence/database').DatabaseSession=>({query:(sql,params)=>{
    if(sql.includes('INSERT INTO control_loop_improvement_commands')&&params?.[2]==='result'&&params?.[6]==='start')throw new Error('SYNTHETIC result commit interruption');
    return tx.query(sql,params);
  }});
  const database:import('../../src/persistence/database').DatabaseClient=pendingStart?{query:f.db.query.bind(f.db),transaction:work=>f.db.transaction(tx=>work(wrap(tx))),transactionWithPreCommitCheck:(work,check)=>f.db.transactionWithPreCommitCheck(tx=>work(wrap(tx)),check)}:f.db;
  const bridge=existingBridge??new ImproveControlRoomLoopServiceV1(database,f.scope,{integrityKey:recoveryKey,adapter:engine.adapter},clock);
  const intake=await bridge.mutate(f.identity,projectId,null,'intake',{description:'Recover this exact saved SYNTHETIC request.'},key+'-intake-0001');assert.equal(intake.state,'accepted');
  let s=await bridge.status(f.identity,projectId,intake.requestId);
  assert.equal((await bridge.mutate(f.identity,projectId,intake.requestId,'confirm',{expectedVersion:1,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256},key+'-confirm-0001')).state,'accepted');
  s=await bridge.status(f.identity,projectId,intake.requestId);
  assert.equal((await bridge.mutate(f.identity,projectId,intake.requestId,'start',{expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},key+'-start-000001')).state,pendingStart?'uncertain':'accepted');
  return{bridge,id:intake.requestId,run:s.request.runLink!.loopRunId,link:s.request.runLink!.runLinkId};
}

export function syntheticRecoveryCapability(e:Awaited<ReturnType<typeof syntheticRecoveryEngine>>){
  let enabled=true,action:'wait'|'advance'='wait';
  let mode:import('../../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryObservationV1['mode']|undefined;
  const capability:import('../../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryCapabilityV1={
    enabled:()=>enabled,
    inspect:async(run,command)=>{
      const s=await e.raw.status(run);
      const observedMode=mode??(s.state==='stopped'?'stopped':s.state==='finished'?'terminal':s.state==='waiting'?'waiting':'runnable');
      return{schemaVersion:1,run:s.run,revision:s.revision,mode:observedMode,action:observedMode==='runnable'?action:null,
        driver:{state:'ended',generation:null,evidenceDigest:sha256Digest('SYNTHETIC ended')},
        receipt:command?s.receipts.find(r=>r.commandId===command.commandId&&r.bindingDigest===command.bindingDigest)??null:null,evidenceDigest:sha256Digest({run,observedMode})};
    },
    claimDriver:async(_binding,spawn)=>({kind:'started',generation:randomBytes(16).toString('hex'),child:await spawn()}),
  };
  return{capability,setEnabled:(v:boolean)=>{enabled=v;},setAction:(v:typeof action)=>{action=v;},setMode:(v:typeof mode)=>{mode=v;}};
}

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import type { DatabaseClient, DatabaseSession } from '../../src/persistence/database';
import type { LoopBridgeOperationV1 } from '../../src/improve-control-room/v1/schemas';
import type { LoopRecoveryBindingV1, LoopRecoveryChildV1, LoopRecoveryCapabilityV1 } from '../../src/web/v1/improve-control-room-loop-adapter';
export function resultCrashDatabase(db:DatabaseClient,operation:LoopBridgeOperationV1):DatabaseClient{
  const wrap=(tx:DatabaseSession):DatabaseSession=>({query:(sql,params)=>{
    if(sql.includes('INSERT INTO control_loop_improvement_commands')&&params?.[2]==='result'&&params?.[6]===operation)throw new Error('SYNTHETIC result commit interrupted');
    return tx.query(sql,params);
  }});
  return{query:db.query.bind(db),transaction:work=>db.transaction(tx=>work(wrap(tx))),transactionWithPreCommitCheck:(work,check)=>db.transactionWithPreCommitCheck(tx=>work(wrap(tx)),check)};
}
// The fixture uses a real OS flock, distinct from A2's short mutation lock. An
// unacknowledged registration stays uncertain after parent loss, regardless of
// age or PID. The lock file's mere existence never authorizes takeover.
const driverHost=`import sys,os,json,fcntl
lock,record,runfile,binding=sys.argv[1:];b=json.loads(binding)
f=open(lock,'a+')
try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
    print('busy',flush=True);sys.exit(0)
def save(v):
    with open(record+'.tmp','w') as out: json.dump(v,out);out.flush();os.fsync(out.fileno())
    os.replace(record+'.tmp',record)
if os.path.exists(record):
    try:
        with open(record) as r: old=json.load(r)
        if set(old.keys())!=set(['phase','generation','pid']) or old['phase']!='ended': raise ValueError()
    except Exception:
        print('uncertain',flush=True);sys.exit(0)
with open(runfile) as r: s=json.load(r)
if s['revision']!=b['expectedRevision'] or s['state'] in ['stopped','finished','refused'] or s['settingsSha256']!=b['settingsSha256'] or s['inputVersion']!=b['inputVersion']:
    print('uncertain',flush=True);sys.exit(0)
g=os.urandom(16).hex();v=dict(phase='intent',generation=g,pid=None);save(v)
print('acquired '+g,flush=True)
line=sys.stdin.readline().strip()
if not line.startswith('child '): sys.exit(0)
v['phase']='recorded';v['pid']=int(line.split(' ')[1]);save(v)
print('recorded',flush=True)
if sys.stdin.readline().strip()=='reaped': v['phase']='ended';save(v)
`;
export async function exclusiveSyntheticRecoveryCapability(t:TestContext,e:Awaited<ReturnType<typeof syntheticRecoveryEngine>>,authority?:()=>Promise<boolean>){
  try{await writeFile(join(e.root,'driver-host.py'),driverHost,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const base=syntheticRecoveryCapability(e),hosts=new Set<ChildProcess>(),ownedChildren=new Set<LoopRecoveryChildV1>();
  let acquired=0,busy=0,uncertain=0;
  const closeHost=async(child:ChildProcess)=>{
    if(!hosts.has(child))return;
    const exited=once(child,'close');child.stdin?.end();
    const timer=setTimeout(()=>child.kill('SIGKILL'),2000);try{await exited;}finally{clearTimeout(timer);hosts.delete(child);}
  };
  t.after(async()=>{await Promise.all([...ownedChildren].map(child=>child.close()));await Promise.all([...hosts].map(closeHost));});
  const capability:LoopRecoveryCapabilityV1={...base.capability,
    inspect:async(run,command)=>{
      const o=await base.capability.inspect(run,command);
      try{
        const saved=JSON.parse(await readFile(join(e.root,run+'.driver.json'),'utf8')) as {phase:string;generation:string;pid:number|null};
        if(Object.keys(saved).some(k=>!['phase','generation','pid'].includes(k))||!['intent','recorded','ended'].includes(saved.phase)||!/^[a-f0-9]{32}$/.test(saved.generation))throw new Error('invalid');
        o.driver={state:saved.phase==='ended'?'ended':saved.phase==='recorded'?'live':'uncertain',generation:saved.generation,evidenceDigest:sha256Digest(saved)};
        if(o.driver.state==='live'||o.driver.state==='uncertain')o.action=null;
        return o;
      }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return o;return{...o,mode:'uncertain',action:null,driver:{state:'uncertain',generation:null,evidenceDigest:sha256Digest('invalid driver ledger')}};}
    },
    claimDriver:async(binding,invoke)=>{
      const run=binding.run.loopRunId,child=spawn(e.configuration.interpreter,[join(e.root,'driver-host.py'),join(e.root,run+'.driver.lock'),join(e.root,run+'.driver.json'),join(e.root,'runs',run+'.json'),JSON.stringify(binding)],{stdio:['pipe','pipe','pipe'],env:{NODE_ENV:'test',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}});
      hosts.add(child);child.once('close',()=>hosts.delete(child));
      const lines=createInterface({input:child.stdout}),iterator=lines[Symbol.asyncIterator]();
      try{
        const line=(await iterator.next()).value as string|undefined;
        if(!line?.startsWith('acquired ')){if(line==='busy')busy++;else uncertain++;await closeHost(child);return{kind:line==='busy'?'busy':'uncertain',evidenceDigest:sha256Digest(line??'closed')};}
        if(authority&&!await authority()){uncertain++;await closeHost(child);return{kind:'uncertain',evidenceDigest:sha256Digest('revoked')};}
        acquired++;
        let owned:LoopRecoveryChildV1;
        try{owned=await invoke();}catch(error){await closeHost(child);throw error;}
        ownedChildren.add(owned);
        child.stdin.write('child '+owned.pid+'\n');
        if((await iterator.next()).value!=='recorded'){await owned.close();throw new Error('SYNTHETIC driver registration uncertain');}
        // done is settled only after the exact adapter child was reaped.
        void owned.done.catch(()=>{}).then(async()=>{ownedChildren.delete(owned);if(hosts.has(child)){child.stdin.write('reaped\n');await closeHost(child);}});
        return{kind:'started',generation:line.slice(9),child:owned};
      }finally{lines.close();}
    }};
  return{...base,capability,counts:()=>({acquired,busy,uncertain}),hosts};
}

import { Pool,Client, type PoolConfig } from 'pg';
import { bindPrivatePgPool } from '../../src/web/v1/private-pg-database';
import { privatePgOptions } from '../../src/web/v1/private-pg-options';
import type { VerifiedWebIdentity } from '../../src/web/v1/access-verifier';
import { fileURLToPath } from 'node:url';
export const pgRecoveryScope={tenantId:'tenant:b3a',workspaceId:'workspace:b3a'},pgRecoveryProject='project:b3a',pgRecoveryOwner='identity:b3a';
export function pgRecoveryIdentity():VerifiedWebIdentity{
  const issuedAt=new Date(Date.now()-60000).toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString();
  return{provider:'test',subject:pgRecoveryOwner,issuedAt,expiresAt,verificationExpiresAt:expiresAt,tokenDigest:sha256Digest('SYNTHETIC B3a session')};
}
export async function seedRecoveryPostgres(admin:PoolConfig,identity:VerifiedWebIdentity){
  const client=new Client(admin);await client.connect();
  try{
    await client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Fixture tenant')",[pgRecoveryScope.tenantId]);
    await client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Fixture workspace')",[pgRecoveryScope.workspaceId,pgRecoveryScope.tenantId]);
    await client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES('adapter:b3a',$1,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`,[pgRecoveryScope.tenantId]);
    await client.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,$2,$3,'adapter:b3a',$1,'1','Control Room','planned','manual_project_active','healthy','control_room_native',now(),
      '{"presentation":{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}}',now())`,[pgRecoveryProject,pgRecoveryScope.tenantId,pgRecoveryScope.workspaceId]);
    await client.query("INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES($1,$2,'active',1,now(),now())",[pgRecoveryScope.tenantId,pgRecoveryProject]);
    await client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES($1,$2,'human','Fixture identity','test',$3,'active',$4,$4)`,[pgRecoveryOwner,pgRecoveryScope.tenantId,sha256Digest({provider:'test',subject:pgRecoveryOwner}),identity.issuedAt]);
    await client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES('grant:b3a',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,[pgRecoveryScope.tenantId,pgRecoveryOwner,identity.issuedAt]);
  }finally{await client.end();}
}
export function recoveryPgWeb(connection:PoolConfig,adapter:LoopAdapterV1){
  const config={host:'127.0.0.1',port:connection.port!,database:connection.database!,username:connection.user!,password:String(connection.password),majorVersion:17 as const};
  const pool=new Pool({...privatePgOptions(config),...connection,max:1}),bound=bindPrivatePgPool(pool);
  const bridge=new ImproveControlRoomLoopServiceV1(bound.client,pgRecoveryScope,{integrityKey:recoveryKey,adapter});
  return{...bound,bridge,pool};
}
// Child entry for the measured separate-process contention proof. Input arrives
// only over the parent's private IPC channel; import without this flag is inert.
async function recoveryFixtureHost(){
  type Init={connection:PoolConfig;configuration:LoopAdapterConfigurationV1;target:{projectId:string;requestId:string;ownerIdentityId:string}};
  const cleanup:(()=>Promise<unknown>)[]=[];
  let owned:LoopRecoveryChildV1|undefined;
  const finish=async()=>{await owned?.close();for(const close of cleanup.reverse())await close();process.disconnect?.();};
  const init=await new Promise<Init>(resolve=>process.once('message',value=>resolve(value as Init)));
  const c=init.configuration,toolingRevision=c.toolingRevision;
  c.contract={lineage:{toolingRevision,decodeRunIdentity:v=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:v=>loopImprovementObservationSchemaV1.parse(v),
    matchesSavedInput:(_r,o,i)=>o.settingsDigest===loopByteHashV1(i.settingsText)&&o.confirmation.path==='request.md'&&o.confirmation.sha256===loopByteHashV1(i.description)},
    schemaDigest:c.contract.schemaDigest,generateRunId:()=>{throw Error('SYNTHETIC host never reserves');},qualifiedOperations:[],
    decodeStatus:v=>{const e=v as {run:string;counters:{fixture:object}};return loopEngineStatusSchemaV1.parse({...e.counters.fixture,run:{adapterId:c.adapterId,loopRunId:e.run,toolingRevision,a2SchemaVersion:1}});}};
  const raw=createImproveControlRoomLoopAdapterV1(c);cleanup.push(()=>raw.close());
  const shell={root:c.configRoot,configuration:c,raw} as Awaited<ReturnType<typeof syntheticRecoveryEngine>>;
  const testOwner={after:(fn:()=>Promise<unknown>)=>cleanup.push(fn)} as unknown as TestContext;
  const capability=await exclusiveSyntheticRecoveryCapability(testOwner,shell);
  const adapter=createImproveControlRoomLoopAdapterV1({...c,contract:{...c.contract,recovery:capability.capability}});cleanup.push(()=>adapter.close());
  const web=recoveryPgWeb(init.connection,adapter);cleanup.push(()=>web.close());
  // Readying precedes go: parent can prove all processes crossed one barrier.
  process.send?.({kind:'ready',pid:process.pid});
  await new Promise<void>(resolve=>process.once('message',()=>resolve()));
  try{
    const result=await web.bridge.recoveryPort().reconcile(init.target,new AbortController().signal);
    if(result.state==='started')owned=result.child;
    process.send?.({kind:'result',state:result.state,pid:process.pid,child:owned?.pid??null,counts:capability.counts()});
    if(owned)await new Promise<void>(resolve=>process.once('message',()=>resolve()));
  }catch{process.send?.({kind:'result',state:'blocked',pid:process.pid,child:null,counts:capability.counts()});}
  finally{await finish();}
}
if(process.argv[2]==='--fixture-host'&&process.argv[1]===fileURLToPath(import.meta.url)){
  void recoveryFixtureHost().catch(()=>{process.exitCode=1;process.disconnect?.();});
}

const boundaryHost=`import sys,os,json,time
ledger,marker,change,side=sys.argv[1:];patch=json.loads(change)
with open(ledger) as f: saved=json.load(f)
if side=='after':
    saved.update(patch)
    with open(ledger+'.tmp','w') as f: json.dump(saved,f);f.flush();os.fsync(f.fileno())
    os.replace(ledger+'.tmp',ledger)
with open(marker,'w') as f: f.write(side);f.flush();os.fsync(f.fileno())
while True: time.sleep(1)
`;
/** A real child stops on either side of a durable fixture write. The caller
 * kills only this returned child, then reconstructs the product service. */
export async function crashSyntheticBoundary(e:Awaited<ReturnType<typeof syntheticRecoveryEngine>>,ledger:string,patch:object,side:'before'|'after'){
  const host=join(e.root,'boundary-host.py'),marker=join(e.root,'boundary.marker');
  await writeFile(host,boundaryHost);await rm(marker,{force:true});
  const child=spawn(e.configuration.interpreter,[host,ledger,marker,JSON.stringify(patch),side],{env:{NODE_ENV:'test',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},stdio:'ignore'});
  const closed=once(child,'close');
  try{
    const deadline=Date.now()+5000;let reached=false;
    while(Date.now()<deadline){try{reached=(await readFile(marker,'utf8'))===side;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(reached)break;await new Promise(r=>setTimeout(r,5));}
    assert.ok(reached,'SYNTHETIC child reached the named persisted boundary');
    child.kill('SIGKILL');const [code,signal]=await closed;assert.equal(code,null);assert.equal(signal,'SIGKILL');
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
}
