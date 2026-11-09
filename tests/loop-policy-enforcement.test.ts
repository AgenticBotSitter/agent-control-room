import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { taskFixture } from './helpers/web-task';
import { now, origin, request, trust, token } from './helpers/web-foundation';
import { LoopPolicyServiceV1, LoopPolicyRefusedV1 } from '../src/web/v1/loop-policy-service';
import { createLoopPolicyHttpHandlerV1, isLoopPolicyRouteV1 } from '../src/web/v1/loop-policy-http';
import { LoopProviderServiceV1 } from '../src/web/v1/loop-provider-service';
import { createAccessVerifier } from '../src/web/v1/access-verifier';

const scope = { tenantId: 'tenant:web', workspaceId: 'workspace:web' };
const route = {providerId:'provider-p72',model:'synthetic/p72'};
const defaults = '{"providerRoute":{"providerId":"provider-p72","model":"synthetic/p72"},"roles":{"build":"default","final":"default"},"array":[1,2],"object":{"child":1},"nullable":null,"overrides":{"allow_standard_final":false}}';
let sequence = 0;
const key = () => `p72-policy-key-${String(++sequence).padStart(8,'0')}`;
const locked = (e: unknown) => e instanceof LoopPolicyRefusedV1 && e.reasons[0]?.code === 'POLICY_LOCKED';
async function fixture(t: TestContext) {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const at = Date.now(), expires = new Date(at+300000).toISOString();
  const jwt = token({iat: Math.floor(at/1000)-60, exp: Math.floor(at/1000)+300});
  const identity = createAccessVerifier({...trust,validUntilMs:at+3600000})(request(undefined,undefined,undefined,undefined,jwt),at);
  await f.db.query('INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)',
    [scope.tenantId,identity.tokenDigest,'identity:web',identity.issuedAt,expires]);
  await f.db.query(`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,
    default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
    VALUES('tenant:web','synthetic/p72',1,'synthetic-p72','','','','','','','','on','','','','identity:web',$1)`,[new Date(at).toISOString()]);
  const providers=new LoopProviderServiceV1(f.client,scope,{availability:async()=> 'available'},()=>at);
  await providers.upsert(identity,route.providerId,{expectedVersion:0,provider:{provider_id:route.providerId,display_name:'Synthetic P72',
    base_url:'https://example.com',billing_kind:'subscription',secret_ref:{kind:'launcher',launcher:'synthetic-p72'},
    models:[{roster_name:route.model,launcher:'synthetic-p72',served_model_id:'served/p72'}],price_source_url:null,price_source_format:null,
    credit_amount_nano_usd:null,credit_expires_on:null,credit_note:''}},key());
  const checks: string[] = [];
  let check = async (_text: string) => ({eligible:true,reasons:[] as {code:string;explanation:string}[]});
  const tools = {settingsText:defaults,checkSettings:async(text:string)=>{checks.push(text);return check(text);}};
  const service = new LoopPolicyServiceV1(f.client,scope,tools,Date.now,providers);
  const handler = createLoopPolicyHttpHandlerV1({origin,trust:{...trust,validUntilMs:at+3600000},service});
  const path = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/loop-policy`;
  const send = (suffix:string,method:string,body?:unknown,k=key())=>handler(request(path+suffix,method,body,k,jwt));
  const put = (layer:string,body:unknown,k=key())=>send('/'+layer,'PUT',body,k);
  const count = async(table:string)=>(await f.db.query<{n:number}>(`SELECT count(*)::int n FROM ${table}`)).rows[0]!.n;
  return {...f,identity,service,tools,providers,checks,put,send,path,count,setCheck:(value:typeof check)=>{check=value;}};
}

test('P72 lockedPaths exact body readback canonical replay digest and clearing', async t => {
  const f=await fixture(t), project=f.project.projectId;
  assert.equal((await f.put('project',{expectedVersion:0,settings:'{}'})).status,400,'lockedPaths is required');
  assert.equal((await f.put('selection',{expectedVersion:0,settings:'{}',lockedPaths:[]})).status,400);
  const body={expectedVersion:0,settings:'{}',lockedPaths:['roles.final','array']},k=key();
  assert.equal((await f.put('project',body,k)).status,201);
  assert.deepEqual((await f.service.view(f.identity,project)).project,{version:1,settingsText:'{}',lockedPaths:['array','roles.final']});
  assert.equal((await f.put('project',{...body,lockedPaths:['array','roles.final']},k)).status,200);
  assert.equal((await f.put('project',{...body,lockedPaths:['roles.final']},k)).status,409);
  assert.equal((await f.put('project',{expectedVersion:1,settings:'{}',lockedPaths:[]})).status,201);
  assert.equal(await f.count('control_loop_policy_events'),2);
});

test('P72 lock syntax existence same-PUT engine keys null arrays and retained paths', async t => {
  const f=await fixture(t);
  for(const paths of [['roles.missing'],['selectionOnly'],['array.0'],['array.child'],['nullable.child'],['object.*'],['__proto__.x'],['array','array'],['a'.repeat(257)],Array.from({length:101},(_,i)=>`key${i}`)]){
    assert.equal((await f.put('project',{expectedVersion:0,settings:'{}',lockedPaths:paths})).status,400,JSON.stringify(paths));
  }
  assert.equal(f.checks.length,0);
  assert.equal((await f.put('project',{expectedVersion:0,settings:'{"engineKey":{"x":null}}',lockedPaths:['engineKey.x','nullable','array']})).status,201);
  assert.equal((await f.put('project',{expectedVersion:1,settings:'{}',lockedPaths:['engineKey.x']})).status,400);
  assert.equal((await f.put('project',{expectedVersion:1,settings:'{}',lockedPaths:[]})).status,201);
});

test('P72 POLICY_LOCKED result-vs-base subtree deletion arrays equality and late locks', async t => {
  const f=await fixture(t);
  assert.equal((await f.put('selection',{expectedVersion:0,settings:'{"roles":{"final":"other"}}'})).status,201);
  assert.equal((await f.put('project',{expectedVersion:0,settings:'{}',lockedPaths:['roles.final','object','array']})).status,201);
  const before=f.checks.length;
  const response=await f.put('selection',{expectedVersion:1,settings:'{"roles":{"final":"other"},"unrelated":true}'});
  assert.equal(response.status,422,'P72 independent POLICY_LOCKED comparison');
  assert.deepEqual(await response.json(),{error:'policy_refused',reasons:[{code:'POLICY_LOCKED',explanation:'roles.final'}]});
  assert.equal(f.checks.length,before);
  for(const settings of ['{"object":null}','{"array":[1]}'])assert.equal((await f.put('selection',{expectedVersion:1,settings})).status,422);
  assert.equal((await f.put('selection',{expectedVersion:1,settings:'{"roles":{"final":"default"},"unlocked":true}'})).status,201);
  await assert.rejects(f.client.transaction(tx=>f.service.snapshot(tx,f.project.projectId,'{"object":null}')),locked);
});

test('P72 owner waiver HTTP reason expiry strict body replay scope revoke and no authority inheritance', async t => {
  const f=await fixture(t),body={path:'roles.final',reason:'One request needs this exception',expiresAt:new Date(Date.now()+60000).toISOString()},k=key();
  for(const invalid of [{...body,reason:' '},{...body,reason:'x'.repeat(501)},{...body,expiresAt:new Date(Date.now()-1000).toISOString()},
    {...body,expiresAt:new Date(Date.now()+8*86400000).toISOString()},{...body,path:'array.0'},{...body,extra:true},{...body,reason:'api_key=sk-synthetic-secret-value-1234567890'}])
    assert.equal((await f.send('/waivers','POST',invalid)).status,400);
  assert.equal((await f.send('/waivers','POST',body,'bad-key')).status,400);
  assert.equal(await f.count('control_loop_policy_waivers'),0,'invalid bodies and keys write no waivers');
  const first=await f.send('/waivers','POST',body,k);assert.equal(first.status,201);
  const waiver=await first.json();assert.equal(waiver.path,body.path);assert.equal(waiver.reason,body.reason);
  const replay=await f.send('/waivers','POST',body,k);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),waiver);
  assert.equal((await f.send('/waivers','POST',{...body,reason:'Different'},k)).status,409);
  assert.equal((await f.send('/waivers','POST',{...body,expiresAt:body.expiresAt.replace('Z','001Z')},k)).status,409,
    'a changed expiry conflicts even within the same JavaScript millisecond');
  assert.equal((await f.send('/waivers/'+waiver.id+'/revoke','POST',{settings:'{}'})).status,400);
  assert.equal((await f.send('/waivers/'+waiver.id+'/revoke','POST')).status,204);
  assert.equal((await f.send('/waivers/'+waiver.id+'/revoke','POST')).status,204);
  for(const [suffix,method] of [[`/waivers/${waiver.id}`,'DELETE'],[`/waivers/${waiver.id}`,'POST'],[`/waivers/${waiver.id}/revoke`,'GET'],[`/waivers/${waiver.id}/revoke/extra`,'POST']] as const)
    assert.ok((await f.send(suffix,method)).status >= 400, 'only explicit POST revoke is accepted');
  assert.equal(await f.count('control_loop_policy_waivers'),1);
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");
  assert.equal((await f.send('/waivers','POST',body,key())).status,403);
  assert.equal((await f.send('/waivers/'+waiver.id+'/revoke','POST')).status,403);
  await f.db.query("UPDATE control_role_grants SET role_key='owner',revoked_at=statement_timestamp()");
  assert.equal((await f.send('/waivers','POST',body,key())).status,403);
  assert.equal((await f.send('/waivers/'+waiver.id+'/revoke','POST')).status,403);
  assert.equal(await f.count('control_loop_policy_waivers'),1);
});

import { randomBytes } from 'node:crypto';
import { ImproveControlRoomLoopServiceV1 } from '../src/web/v1/improve-control-room-loop-service';
import { ImproveControlRoomDeskServiceV1 } from '../src/improve-control-room/v1/service';
import { loopImprovementObservationSchemaV1, loopImprovementRunIdentitySchemaV1, loopBridgeBodiesV1, type LoopBridgeBindingV1 } from '../src/improve-control-room/v1/schemas';
import { loopByteHashV1, type LoopAdapterV1, type LoopEngineStatusV1 } from '../src/web/v1/improve-control-room-loop-adapter';
import { sha256Digest } from '../src/security';
import type { DatabaseClient, DatabaseSession } from '../src/persistence/database';
const integrityKey = new Uint8Array(32).fill(72);
function engine(tools: {settingsText:string;checkSettings(text:string):Promise<{eligible:boolean;reasons:{code:string;explanation:string}[]}>}) {
  const toolingRevision=`sha256:${'a'.repeat(64)}`,runs=new Map<string,LoopEngineStatusV1>(),calls:string[]=[];
  let refuseIntake=false;
  const contract={toolingRevision,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),
    matchesSavedInput:(_r:unknown,o:{settingsDigest:string},input:{settingsText:string})=>o.settingsDigest===loopByteHashV1(input.settingsText)};
  const apply=async(op:string,id:string,b:LoopBridgeBindingV1,text?:string,signed=tools.settingsText)=>{
    calls.push(op);let s=runs.get(b.loopRunId);
    if(op==='intake')s={run:{adapterId:'adapter:synthetic',loopRunId:b.loopRunId,toolingRevision,a2SchemaVersion:1},revision:1,inputVersion:1,state:'draft',description:text!,settingsSha256:loopByteHashV1(signed),settingsDigest:loopByteHashV1(signed),confirmation:null,approval:null,question:null,progress:{step:'intake',completed:0,attention:'none'},receipts:[]};
    assert.ok(s);
    if(op==='confirm'){s.confirmation={path:'request.md',sha256:loopByteHashV1(s.description),who:'owner',at:new Date().toISOString(),input_version:s.inputVersion};s.state='ready';s.revision++;}
    if(op==='start'){s.state='running';s.revision++;}if(op==='stop'){s.state='stopped';s.revision++;}
    const refused=op==='intake'&&refuseIntake;
    s.receipts.push({commandId:id,bindingDigest:sha256Digest(b),state:refused?'refused':'accepted',error:refused?'INELIGIBLE':null,evidenceDigest:sha256Digest({op,id})});
    runs.set(b.loopRunId,s);return structuredClone(s);
  };
  const adapter:LoopAdapterV1={...tools,adapterId:'adapter:synthetic',toolingRevision,schemaDigest:`sha256:${'b'.repeat(64)}`,contract,
    providerRoutes:{paidExecutionReady:false,resolveStartRoute:async()=>({...route,additionalRoutes:[]})},
    reserveRun:()=>`fixture-run-${randomBytes(16).toString('hex')}`,available:()=>true,
    intake:(id,b,text,_f,signed)=>apply('intake',id,b,text,signed),confirmRequest:(id,b)=>apply('confirm',id,b),start:(id,b)=>apply('start',id,b),stop:(id,b)=>apply('stop',id,b),
    approve:(id,b)=>apply('approve',id,b),answer:(id,b)=>apply('answer',id,b),status:async run=>{const s=runs.get(run);assert.ok(s);return structuredClone(s);},close:async()=>{}};
  return {adapter,runs,calls,refuse:()=>{refuseIntake=true;}};
}
function bridge(f: Awaited<ReturnType<typeof fixture>>, db: DatabaseClient=f.client) {
  const e=engine(f.tools),policy=new LoopPolicyServiceV1(db,scope,e.adapter,Date.now,f.providers);
  return {...e,policy,service:new ImproveControlRoomLoopServiceV1(db,scope,{integrityKey,adapter:e.adapter,policy,providers:f.providers}),desk:new ImproveControlRoomDeskServiceV1(db,scope,integrityKey,undefined,Date.now,e.adapter.contract)};
}
async function waiver(f:Awaited<ReturnType<typeof fixture>>,path='roles.final') {
  return (await f.service.createWaiver(f.identity,f.project.projectId,{path,reason:'Bounded synthetic exception',expiresAt:new Date(Date.now()+300000).toISOString()},key())).waiver;
}
async function lockFinal(f:Awaited<ReturnType<typeof fixture>>) {
  await f.service.put(f.identity,f.project.projectId,'project',{expectedVersion:0,settings:'{}',lockedPaths:['roles.final']},key());
}
const exceptionEdits='{"roles":{"final":"exception"}}';
async function confirm(f:Awaited<ReturnType<typeof fixture>>,b:ReturnType<typeof bridge>,requestId:string) {
  const s=await b.service.status(f.identity,f.project.projectId,requestId);
  await b.service.mutate(f.identity,f.project.projectId,requestId,'confirm',{expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256},key());
  const ready=await b.service.status(f.identity,f.project.projectId,requestId);
  return {expectedVersion:ready.request.currentVersion,expectedRevision:ready.engine.revision,runLinkId:ready.request.runLink!.runLinkId,route};
}

test('P72 explicit waiver selection and intake consume one request with immutable source lineage',async t=>{
  const f=await fixture(t),b=bridge(f);await lockFinal(f);const w=await waiver(f);
  const project=f.project.projectId;
  await f.service.put(f.identity,project,'selection',{expectedVersion:0,settings:exceptionEdits,waiverId:w.id},key());
  assert.equal((await f.db.query<{consumed_by_request_id:string|null}>('SELECT consumed_by_request_id FROM control_loop_policy_waivers')).rows[0]!.consumed_by_request_id,null);
  await assert.rejects(b.service.mutate(f.identity,project,null,'intake',{description:'No implicit waiver'},key()),locked);
  const receipt=await b.service.mutate(f.identity,project,null,'intake',{description:'Explicit exception',waiverId:w.id},key());
  assert.equal(receipt.state,'accepted');
  const source=(await f.db.query<{waiver_id:string}>('SELECT waiver_id FROM control_loop_policy_input_sources')).rows[0]!;
  assert.equal(source.waiver_id,w.id);
  assert.equal((await f.db.query<{consumed_by_request_id:string}>('SELECT consumed_by_request_id FROM control_loop_policy_waivers')).rows[0]!.consumed_by_request_id,receipt.requestId);
  await assert.rejects(b.service.mutate(f.identity,project,null,'intake',{description:'Cannot reuse',waiverId:w.id},key()),locked);
  assert.equal(await f.count('control_loop_improvement_requests'),1);assert.equal(await f.count('control_loop_policy_input_sources'),1);
  assert.deepEqual(b.calls,['intake']);
});

test('P72 invalid supplied waivers including no violation foreign scope path expiry and one-path coverage refuse without writes',async t=>{
  const f=await fixture(t),b=bridge(f),project=f.project.projectId;await lockFinal(f);
  const good=await waiver(f),wrong=await waiver(f,'array');
  const {WebProjectService}=await import('../src/web/v1/project-service');
  const projects=new WebProjectService(f.client,scope);
  const other=(await projects.create(f.identity,{title:'Other policy project',summary:'Synthetic scope test'},key())).project.projectId;
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`,[other]);
  await f.service.put(f.identity,other,'project',{expectedVersion:0,settings:'{}',lockedPaths:['roles.final']},key());
  const foreign=await f.service.createWaiver(f.identity,other,{path:'roles.final',reason:'Other project only',expiresAt:new Date(Date.now()+300000).toISOString()},key());
  await assert.rejects(b.service.mutate(f.identity,project,null,'intake',{description:'Foreign project waiver',settingsEdits:exceptionEdits,waiverId:foreign.waiver.id},key()),locked);
  await assert.rejects(f.service.revokeWaiver(f.identity,project,foreign.waiver.id),{code:'not_found'});
  assert.equal((await f.db.query<{revoked_at:unknown}>('SELECT revoked_at FROM control_loop_policy_waivers WHERE id=$1',[foreign.waiver.id])).rows[0]!.revoked_at,null);
  const expired=await waiver(f);
  await f.db.exec('ALTER TABLE control_loop_policy_waivers DISABLE TRIGGER control_loop_policy_waiver_guard');
  try { await f.db.query("UPDATE control_loop_policy_waivers SET created_at=statement_timestamp()-interval '2 days',expires_at=statement_timestamp()-interval '1 day' WHERE id=$1",[expired.id]); }
  finally { await f.db.exec('ALTER TABLE control_loop_policy_waivers ENABLE TRIGGER control_loop_policy_waiver_guard'); }
  await assert.rejects(b.service.mutate(f.identity,project,null,'intake',{description:'Expired waiver',settingsEdits:exceptionEdits,waiverId:expired.id},key()),locked);
  for(const body of [{description:'Unknown',settingsEdits:exceptionEdits,waiverId:'waiver:missing'},
    {description:'Wrong path',settingsEdits:exceptionEdits,waiverId:wrong.id},{description:'No violation',waiverId:good.id}])
    await assert.rejects(b.service.mutate(f.identity,project,null,'intake',body,key()),locked);
  await f.service.put(f.identity,project,'project',{expectedVersion:1,settings:'{}',lockedPaths:['roles.final','array']},key());
  await assert.rejects(b.service.mutate(f.identity,project,null,'intake',{description:'Two violations',settingsEdits:'{"roles":{"final":"exception"},"array":[]}',waiverId:good.id},key()),locked);
  await f.service.revokeWaiver(f.identity,project,good.id);
  await assert.rejects(b.service.mutate(f.identity,project,null,'intake',{description:'Revoked',settingsEdits:exceptionEdits,waiverId:good.id},key()),locked);
  assert.equal(await f.count('control_loop_improvement_requests'),0);assert.equal(await f.count('control_loop_policy_input_sources'),0);assert.equal(await f.count('control_loop_improvement_commands'),0);
  assert.equal(b.calls.length,0);
});

test('P72 check conflict and injected transaction failures never burn waiver but committed engine refusal retains it',async t=>{
  const f=await fixture(t),project=f.project.projectId;await lockFinal(f);const w=await waiver(f),b=bridge(f);
  const body={description:'Rollback exception',settingsEdits:exceptionEdits,waiverId:w.id};
  f.setCheck(async()=>({eligible:false,reasons:[{code:'SYNTHETIC_CHECK_REFUSAL',explanation:'Refused'}]}));
  await assert.rejects(b.service.mutate(f.identity,project,null,'intake',body,key()),/loop_policy_refused/);
  f.setCheck(async()=>{throw new Error('checker unavailable');});
  await assert.rejects(b.service.mutate(f.identity,project,null,'intake',body,key()),/checker unavailable/);
  f.setCheck(async()=>({eligible:true,reasons:[]}));
  for(const sqlState of ['23514','42501','40001','40P01']) {
    const wrap=(tx:DatabaseSession):DatabaseSession=>({query:async<T,>(sql:string,params?:unknown[])=>{
      if(sql.includes('INSERT INTO control_loop_policy_input_sources'))throw Object.assign(new Error('injected write failure'),{sqlState});
      return tx.query<T>(sql,params);
    }});
    const db:DatabaseClient={query:f.client.query.bind(f.client),transaction:fn=>f.client.transaction(tx=>fn(wrap(tx))),transactionWithPreCommitCheck:(fn,check)=>f.client.transactionWithPreCommitCheck(tx=>fn(wrap(tx)),check)};
    await assert.rejects(bridge(f,db).service.mutate(f.identity,project,null,'intake',body,key()),{code:'conflict'});
    assert.equal(await f.count('control_loop_improvement_requests'),0);assert.equal(await f.count('control_loop_policy_input_sources'),0);assert.equal(await f.count('control_loop_improvement_commands'),0);
    assert.equal((await f.db.query<{consumed_by_request_id:string|null}>('SELECT consumed_by_request_id FROM control_loop_policy_waivers')).rows[0]!.consumed_by_request_id,null);
  }
  b.refuse();const receipt=await b.service.mutate(f.identity,project,null,'intake',body,key());
  assert.equal(receipt.state,'refused');
  assert.equal((await f.db.query<{consumed_by_request_id:string}>('SELECT consumed_by_request_id FROM control_loop_policy_waivers')).rows[0]!.consumed_by_request_id,receipt.requestId);
});

test('P72 Start refuses expired revoked wrong-request waiver before claim and preserves copies under later locks',async t=>{
  const f=await fixture(t),b=bridge(f),project=f.project.projectId;await lockFinal(f);
  const w=await waiver(f);const saved=await b.service.mutate(f.identity,project,null,'intake',{description:'Start exception',settingsEdits:exceptionEdits,waiverId:w.id},key());
  const start=await confirm(f,b,saved.requestId);
  const before=await f.count('control_loop_improvement_commands');
  await f.service.revokeWaiver(f.identity,project,w.id);
  await assert.rejects(b.service.mutate(f.identity,project,saved.requestId,'start',start,key()),e=>e instanceof LoopPolicyRefusedV1&&e.reasons[0]?.code==='WAIVER_INVALID');
  assert.equal(await f.count('control_loop_improvement_commands'),before);assert.equal(b.calls.filter(op=>op==='start').length,0);
  // Corruption probes bypass the production transition guard, then restore it.
  await f.db.exec('ALTER TABLE control_loop_policy_waivers DISABLE TRIGGER control_loop_policy_waiver_guard');
  await f.db.query('UPDATE control_loop_policy_waivers SET revoked_at=NULL,created_at=statement_timestamp()-interval \'2 days\',expires_at=statement_timestamp()-interval \'1 day\'');
  await f.db.exec('ALTER TABLE control_loop_policy_waivers ENABLE TRIGGER control_loop_policy_waiver_guard');
  await assert.rejects(b.service.mutate(f.identity,project,saved.requestId,'start',start,key()),e=>e instanceof LoopPolicyRefusedV1&&e.reasons[0]?.code==='WAIVER_INVALID');
  const other=await b.desk.saveLoopDraft(f.identity,project,{description:'Different request',settingsText:'{}'},key());
  await f.db.exec('ALTER TABLE control_loop_policy_waivers DISABLE TRIGGER control_loop_policy_waiver_guard');
  await f.db.query('UPDATE control_loop_policy_waivers SET created_at=statement_timestamp(),expires_at=statement_timestamp()+interval \'1 day\',consumed_by_request_id=$1',[other.request.requestId]);
  await f.db.exec('ALTER TABLE control_loop_policy_waivers ENABLE TRIGGER control_loop_policy_waiver_guard');
  await assert.rejects(b.service.mutate(f.identity,project,saved.requestId,'start',start,key()),e=>e instanceof LoopPolicyRefusedV1&&e.reasons[0]?.code==='WAIVER_INVALID');
  await f.db.exec('ALTER TABLE control_loop_policy_waivers DISABLE TRIGGER control_loop_policy_waiver_guard');
  await f.db.query('UPDATE control_loop_policy_waivers SET consumed_by_request_id=$1',[saved.requestId]);
  await f.db.exec('ALTER TABLE control_loop_policy_waivers ENABLE TRIGGER control_loop_policy_waiver_guard');
  await f.service.put(f.identity,project,'project',{expectedVersion:1,settings:'{"roles":{"final":"future"}}',lockedPaths:['roles.final','array']},key());
  assert.equal((await b.service.mutate(f.identity,project,saved.requestId,'start',start,key())).state,'accepted','later layers and locks never rejudge saved copies');
  assert.equal(b.calls.filter(op=>op==='start').length,1);
});

test('P72 D4 running paused stopped linked edits refuse while normalization and Stop new request work',async t=>{
  const f=await fixture(t),b=bridge(f),project=f.project.projectId;
  const old=await b.service.mutate(f.identity,project,null,'intake',{description:'Original request'},key());const start=await confirm(f,b,old.requestId);
  await b.service.mutate(f.identity,project,old.requestId,'start',start,key());
  const run=b.runs.values().next().value!;
  // The adapter normalizes a paused engine to waiting.
  for(const state of ['running','waiting','stopped'] as const){
    run.state=state;const before=await f.count('control_loop_improvement_inputs');
    await assert.rejects(b.desk.reviseLoopDraft(f.identity,project,{requestId:old.requestId,expectedVersion:1,description:'Edit linked',settingsText:'{"changed":true}'},key()),{code:'conflict'});
    assert.equal(await f.count('control_loop_improvement_inputs'),before);
  }
  run.state='running';
  const saved=(await f.db.query<{settings_text:string}>('SELECT settings_text FROM control_loop_improvement_inputs WHERE request_id=$1',[old.requestId])).rows[0]!;
  const normalized=await b.desk.reviseLoopDraft(f.identity,project,{requestId:old.requestId,expectedVersion:1,description:'Normalized description',settingsText:saved.settings_text},key());
  assert.equal(normalized.savedInput.version,2);
  for(const op of ['confirm','start','approve','answer'] as const)assert.equal(loopBridgeBodiesV1[op].safeParse({...start,settingsEdits:'{}'}).success,false);
  await b.service.mutate(f.identity,project,old.requestId,'stop',{runLinkId:start.runLinkId},key());
  const fresh=await b.service.mutate(f.identity,project,null,'intake',{description:'New request after Stop',settingsEdits:'{"changed":true}'},key());
  const newStart=await confirm(f,b,fresh.requestId);
  await assert.rejects(b.service.mutate(f.identity,project,fresh.requestId,'start',{...newStart,runLinkId:start.runLinkId},key()),{code:'not_found'});
  assert.equal((await b.service.mutate(f.identity,project,fresh.requestId,'start',newStart,key())).state,'accepted');
  assert.equal(b.calls.filter(op=>op==='start').length,2);
});


import { createMacLocalNodeHandler, createPrivateNodeHandler } from '../src/web/v1/private-node-handler';
import { LOCAL_OWNER_SESSION_PROFILE_V1, LocalOwnerSessionServiceV1 } from '../src/web/v1/local-owner-session';
import { nodeExchange } from './helpers/web-node';

for (const mode of ['private', 'Mac-local'] as const) {
  test(`P72 ${mode} Node POST revoke authenticates authorizes replays and retains audit`, async t => {
    const f = await fixture(t), at = Date.now();
    const nodeOrigin = mode === 'private' ? origin : 'http://127.0.0.1:54321';
    const ownerCode = 'synthetic-policy-revoke-owner-code';
    const local = mode === 'Mac-local' ? new LocalOwnerSessionServiceV1({ schema: LOCAL_OWNER_SESSION_PROFILE_V1,
      origin: nodeOrigin, tenantId: scope.tenantId, provider: trust.issuer, subject: 'test-owner',
      ownerCodeDigest: sha256Digest({ownerCode}), sessionSeconds: 900 }) : undefined;
    const cookie = local ? (await local.issue(new Request(`${nodeOrigin}/api/v1/local-owner-session`,
      {method:'POST',headers:{origin:nodeOrigin}}),ownerCode,at)).cookie.split(';')[0]! : undefined;
    const policy = createLoopPolicyHttpHandlerV1({ origin:nodeOrigin,service:f.service,clock:()=>at,
      ...(local ? {localOwnerSession:local} : {trust:{...trust,validUntilMs:at+3600000}}) });
    let calls = 0;
    const transport = (mode === 'private' ? createPrivateNodeHandler : createMacLocalNodeHandler)({ origin:nodeOrigin,
      application:{isReady:()=>true,close:async()=>{}},assets:{count:0,digest:'fixture',respond:()=>undefined},
      handler:request=>{ calls++; assert.ok(isLoopPolicyRouteV1(new URL(request.url).pathname)); return policy(request); } });
    t.after(()=>transport.close());
    const w = await waiver(f), path = `${f.path}/waivers/${encodeURIComponent(w.id)}/revoke`;
    const jwt = token({iat:Math.floor(at/1000)-60,exp:Math.floor(at/1000)+300});
    const exchange = async (options:{anonymous?:boolean;foreign?:boolean;body?:unknown;method?:string}={}) => {
      const headers = ['Origin',options.foreign?'https://foreign.example.invalid':nodeOrigin];
      if(!options.anonymous) headers.push(...(cookie?['Cookie',cookie]:['Cf-Access-Jwt-Assertion',jwt]));
      const body=options.body===undefined?undefined:JSON.stringify(options.body);
      if(body!==undefined) headers.push('Content-Type','application/json','Content-Length',String(Buffer.byteLength(body)));
      const e=nodeExchange({method:options.method??'POST',path,body,headers});e.input.rawHeaders[1]=new URL(nodeOrigin).host;
      try { await transport.handle(e.input,e.output); return e.output.statusCode; }
      finally { e.input.destroy(); e.output.destroy(); }
    };
    const rows=async()=>(await f.db.query<Record<string,unknown>>('SELECT * FROM control_loop_policy_waivers ORDER BY id')).rows;
    const before=await rows();
    assert.equal(await exchange({anonymous:true}),401);
    assert.equal(await exchange({foreign:true}),403);
    assert.equal(await exchange({body:{}}),400);
    await f.db.query("UPDATE control_role_grants SET role_key='operator'");
    assert.equal(await exchange(),403);
    assert.deepEqual(await rows(),before,'all refusals preserve the waiver audit');
    await f.db.query("UPDATE control_role_grants SET role_key='owner'");
    assert.equal(await exchange(),204,'POST revoke reaches policy handler through Node transport');
    const revoked=await rows();assert.ok(revoked[0]!.revoked_at);
    assert.deepEqual({...revoked[0],revoked_at:null},before[0],'immutable scope reason creator and expiry retained');
    assert.equal(await exchange(),204);assert.deepEqual(await rows(),revoked,'retry is an audited no-op');
    if(mode==='private') { const beforeCalls=calls;assert.equal(await exchange({method:'DELETE'}),405);assert.equal(calls,beforeCalls); }
  });
}


import { readFile } from 'node:fs/promises';
import { readPrivateWebSchemaDigest } from '../src/web/v1/private-database-preflight';
test('P72 empty enforcement down re-up restores exact shape and retained unlocked layers refuse',async t=>{
  const f=await fixture(t),before=await readPrivateWebSchemaDigest(f.client);
  await f.db.exec(await readFile('db/down/0317_control_loop_selection_acknowledgement_validate.sql','utf8'));
  await f.db.exec(await readFile('db/down/0316_control_loop_selection_acknowledgement.sql','utf8'));
  await f.db.exec(await readFile('db/down/0315_control_loop_paid_admission.sql','utf8'));
  await f.db.exec(await readFile('db/down/0314_control_loop_policy_enforcement.sql','utf8'));
  assert.equal(await readPrivateWebSchemaDigest(f.client),'388364abf81943ff1a8aca8eb7ed153b73239c0e2a935f896c2d51635ba29422');
  await f.db.exec('BEGIN');
  const validation = async () => (await f.db.query<{conname:string;convalidated:boolean}>(`SELECT conname,convalidated FROM pg_constraint
    WHERE conname IN ('control_loop_policy_locked_paths_check','control_loop_policy_sources_waiver_fk','control_loop_improvement_commands_check1')
    ORDER BY conname`)).rows;
  try { await f.db.exec(await readFile('db/migrations/0314_control_loop_policy_enforcement.sql','utf8'));
    await f.db.exec('COMMIT');
    assert.deepEqual(await validation(), ['control_loop_improvement_commands_check1','control_loop_policy_locked_paths_check','control_loop_policy_sources_waiver_fk']
      .map(conname=>({conname,convalidated:false})), '0314 enforces new writes without validating retained rows in its DDL transaction');
    await f.db.exec('BEGIN');
    await f.db.exec(await readFile('db/migrations/0315_control_loop_paid_admission.sql','utf8'));await f.db.exec('COMMIT');
    assert.ok((await validation()).every(row=>row.convalidated), '0315 validates all retained rows in the following transaction');
    for (const file of ['0316_control_loop_selection_acknowledgement.sql','0317_control_loop_selection_acknowledgement_validate.sql']) {
      await f.db.exec('BEGIN');await f.db.exec(await readFile('db/migrations/'+file,'utf8'));await f.db.exec('COMMIT');
    } }
  catch(error) { await f.db.exec('ROLLBACK');throw error; }
  await f.db.exec(await readFile('db/roles/private_web_roles.sql','utf8'));
  assert.equal((await f.db.query<{allowed:boolean}>(`SELECT has_table_privilege('control_room_private_web','control_loop_policy_input_admissions','INSERT') allowed`)).rows[0]!.allowed,true);
  assert.equal(await readPrivateWebSchemaDigest(f.client),before,'no physical column-number drift after empty down re-up');
  await f.service.put(f.identity,f.project.projectId,'project',{expectedVersion:0,settings:'{}',lockedPaths:[]},key());
  const rows=(await f.db.query('SELECT * FROM control_loop_policy_layers')).rows;
  await assert.rejects(f.db.exec(await readFile('db/down/0314_control_loop_policy_enforcement.sql','utf8')),/loop policy enforcement retained/);
  await f.db.exec('ROLLBACK');
  assert.deepEqual((await f.db.query('SELECT * FROM control_loop_policy_layers')).rows,rows);
  assert.equal(await readPrivateWebSchemaDigest(f.client),before,'refused down changes no schema or retained layer');
});
