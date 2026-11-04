import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { LoopProviderServiceV1, createProviderSecretPresenceV1 } from '../src/web/v1/loop-provider-service';
import { createLoopProviderHttpHandlerV1 } from '../src/web/v1/loop-provider-http';
import type { LoopProviderDataV1 } from '../src/web/v1/improve-control-room-loop-adapter';
import { taskFixture } from './helpers/web-task';
import { now, origin, request, trust, token } from './helpers/web-foundation';
import { nodeExchange } from './helpers/web-node';
import { createMacLocalNodeHandler, createPrivateNodeHandler } from '../src/web/v1/private-node-handler';
import { LOCAL_OWNER_SESSION_PROFILE_V1, LocalOwnerSessionServiceV1 } from '../src/web/v1/local-owner-session';
import { createLoopPolicyHttpHandlerV1 } from '../src/web/v1/loop-policy-http';
import { LoopPolicyServiceV1 } from '../src/web/v1/loop-policy-service';
import { sha256Digest } from '../src/security';
const scope = { tenantId: 'tenant:web', workspaceId: 'workspace:web' };
let sequence = 0;
const key = () => `provider-test-key-${String(++sequence).padStart(8,'0')}`;
const provider = (changes: Partial<LoopProviderDataV1> = {}): LoopProviderDataV1 => ({
  provider_id: 'provider-one', display_name: 'Synthetic provider', base_url: 'https://example.com/api', billing_kind: 'token',
  secret_ref: { kind: 'launcher', launcher: 'synthetic-api' },
  models: [{ roster_name: 'synthetic/model', launcher: 'synthetic-api', served_model_id: 'served/one' }],
  credit_amount_nano_usd: '123000', credit_expires_on: '2027-01-31', credit_note: 'Synthetic credit',
  price_source_url: null, price_source_format: null, ...changes,
});
async function fixture(t: TestContext, presence = { availability: async (_id: string) => 'available' as const }) {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.db.query(`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,
    default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
    VALUES('tenant:web','synthetic/model',1,'synthetic-api','','','','','','','','on','','','','identity:web',$1)`, [new Date(now).toISOString()]);
  const service = new LoopProviderServiceV1(f.client, scope, presence, () => now);
  const handler = createLoopProviderHttpHandlerV1({ origin, trust, service, clock: () => now });
  const put = (expectedVersion: number, p: unknown = provider(), k = key()) => handler(request('/api/v1/loop-providers/provider-one','PUT',{ expectedVersion, provider: p },k));
  const remove = (version: number, k = key()) => handler(request('/api/v1/loop-providers/provider-one/remove','POST',{expectedVersion:version},k));
  const rows = async (): Promise<Record<string,unknown>[][]> => Promise.all(['control_loop_providers','control_loop_provider_models','control_loop_provider_state'].map(async table => (await f.db.query<Record<string,unknown>>(`SELECT * FROM ${table} ORDER BY 1,2`)).rows));
  return { ...f, service, handler, put, remove, rows };
}
test('S1 owner add replace remove replay and conflicts retain exactly one revision per edit', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.view(f.identity), {schema:'control-room.loop-provider-snapshot/v1',tenantId:scope.tenantId,version:0,providers:[]});
  assert.deepEqual(await f.rows(), [[],[],[]]);
  const k = key(); assert.equal((await f.put(0,provider(),k)).status,201);
  assert.deepEqual(await f.service.view(f.identity), {schema:'control-room.loop-provider-snapshot/v1',tenantId:scope.tenantId,version:1,providers:[provider()]});
  assert.equal((await f.put(0,provider(),k)).status,200);
  assert.equal((await f.put(0,provider({display_name:'Changed'}),k)).status,409);
  assert.equal((await f.put(0)).status,409);
  const replacement=provider({ models:[{...provider().models[0]!,served_model_id:'served/replacement'}],credit_note:'Replacement' });
  assert.equal((await f.put(1,replacement)).status,201);
  assert.equal((await f.rows())[1].length,1);
  assert.equal((await f.service.revalidate(f.identity,{providerId:'provider-one',model:'synthetic/model'})).served_model_id,'served/replacement');
  await assert.rejects(f.service.revalidate(f.identity,{providerId:'provider-one',model:'absent'}),{reason:'roster_mismatch'});
  const rk=key(); assert.equal((await f.remove(2,rk)).status,201); assert.equal((await f.remove(2,rk)).status,200);
  assert.deepEqual((await f.rows()).map(r=>r.length),[0,0,1]);
  assert.equal((await f.service.view(f.identity)).version,3);
  await assert.rejects(f.service.revalidate(f.identity,{providerId:'provider-one',model:'synthetic/model'}),{reason:'roster_mismatch'});
});
test('S1 owner guard denies operator and non-human reads and writes without provider storage',async t=>{
  const f=await fixture(t);
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");
  assert.equal((await f.put(0)).status,403,'S1 independent owner denial assertion');
  assert.equal((await f.handler(request('/api/v1/loop-providers'))).status,403);
  await f.db.query("UPDATE control_role_grants SET role_key='owner'");
  await f.db.query("UPDATE control_identities SET actor_type='agent'");
  assert.equal((await f.put(0)).status,403);
  assert.deepEqual(await f.rows(),[[],[],[]]);
});
test('S1 schema errors and semantic URL roster categories are neutral and leave no writes',async t=>{
  const f=await fixture(t);
  for(const p of [provider({billing_kind:'free' as 'token'}),{...provider(),apiKey:'synthetic'},provider({credit_note:'Bearer CRMARKER-'+'a'.repeat(32)})])
    assert.equal((await f.put(0,p)).status,400);
  for(const [p,reason] of [[provider({base_url:'http://example.com'}),'base_url'],[provider({price_source_url:'https://other.example/prices',price_source_format:'control-room.provider-prices/v1'}),'price_source_url'],
    [provider({models:[{...provider().models[0]!,launcher:'other'}],secret_ref:{kind:'launcher',launcher:'other'}}),'roster_mismatch']] as const){
    const r=await f.put(0,p);assert.equal(r.status,422);assert.deepEqual(await r.json(),{error:'provider_refused',reason,message:'Provider unavailable'});
  }
  assert.deepEqual(await f.rows(),[[],[],[]]);
});
test('S1 removal HTTP body type size CSRF and owner refusals preserve all rows',async t=>{
 const f=await fixture(t);assert.equal((await f.put(0)).status,201);const saved=await f.rows();
 for(const req of [new Request(origin+'/api/v1/loop-providers/provider-one/remove',{method:'POST',headers:{'cf-access-jwt-assertion':token(),origin}}),
  new Request(origin+'/api/v1/loop-providers/provider-one/remove',{method:'POST',headers:{'cf-access-jwt-assertion':token(),origin,'content-type':'text/plain'},body:'{}'}),
  request('/api/v1/loop-providers/provider-one/remove','POST',{expectedVersion:1,extra:true}),
  request('/api/v1/loop-providers/provider-one/remove','POST',{expectedVersion:1,extra:'x'.repeat(65536)})]) assert.ok([400,413].includes((await f.handler(req)).status));
 const foreign=request('/api/v1/loop-providers/provider-one/remove','POST',{expectedVersion:1});foreign.headers.set('origin','https://foreign.invalid');assert.equal((await f.handler(foreign)).status,403);
 await f.db.query("UPDATE control_role_grants SET role_key='operator'");assert.equal((await f.remove(1)).status,403);
 assert.deepEqual(await f.rows(),saved);
});
test('S1 availability argv never reads a value and zeroes stand-in output on every exit',async()=>{
 const marker='Bearer CRMARKER-'+'b'.repeat(32),calls:unknown[]=[];
 for(const exitCode of [0,44,1]){
  let output:Uint8Array|undefined,diagnostic:Uint8Array|undefined;
  const presence=createProviderSecretPresenceV1({run:async command=>{calls.push(command);output=Buffer.from(command.args.includes('-w')?marker:'synthetic metadata');diagnostic=Buffer.from('synthetic diagnostic');return {exitCode,stdout:output,stderr:diagnostic};}});
  assert.equal(await presence.availability('provider-one'),exitCode===0?'available':'unavailable');
  assert.ok(output!.every(x=>x===0)&&diagnostic!.every(x=>x===0));
 }
 assert.deepEqual(calls,Array(3).fill({executable:'/usr/bin/security',args:['find-generic-password','-s','control-room.provider','-a','provider-one'],timeoutMilliseconds:15000,maxOutputBytes:32768}));
});
test('S1 keychain missing and unavailable refuse unchanged; success is metadata only and replay never probes',async t=>{
 const calls:string[]=[];let available=false;
 const f=await fixture(t,{availability:async id=>{calls.push(id);return (available?'available':'unavailable') as 'available';}});
 const p=provider({secret_ref:{kind:'macos_keychain',service:'control-room.provider',account:'provider-one'}});
 let r=await f.put(0,p);assert.equal(r.status,422);assert.deepEqual(await r.json(),{error:'provider_refused',reason:'secret_missing',message:'Secret unavailable'});assert.deepEqual(await f.rows(),[[],[],[]]);
 available=true;const k=key();assert.equal((await f.put(0,p,k)).status,201);assert.equal((await f.put(0,p,k)).status,200);
 await f.service.view(f.identity);assert.deepEqual(calls,['provider-one','provider-one']);
 assert.doesNotMatch(JSON.stringify(await f.rows()),/CRMARKER/);
});
test('S1 concurrent reference change during outside-transaction probe refuses stale commit',async t=>{
 let entered!:()=>void,release!:()=>void;const gate=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>entered=r);
 const f=await fixture(t,{availability:async()=>{entered();await gate;return 'available';}});
 assert.equal((await f.put(0)).status,201);
 const pending=f.put(1,provider({secret_ref:{kind:'macos_keychain',service:'control-room.provider',account:'provider-one'}}));
 await seen;assert.equal((await f.put(1,provider({credit_note:'Concurrent edit'}))).status,201);release();assert.equal((await pending).status,409);
 assert.equal((await f.service.view(f.identity)).providers[0]!.credit_note,'Concurrent edit');
});
test('S1 roster change invalidates mappings; unresolved Bitwarden reference is unavailable',async t=>{
 const f=await fixture(t);assert.equal((await f.put(0,provider({secret_ref:{kind:'bitwarden',item:'opaque-item'}}))).status,422);
 assert.equal((await f.put(0)).status,201);await f.db.query("UPDATE control_loop_roster_models SET launcher='changed'");
 await assert.rejects(f.service.revalidate(f.identity,{providerId:'provider-one',model:'synthetic/model'}),{reason:'roster_mismatch'});
});
test('S1 down is empty-only and retained provider model or state rolls back atomically',async t=>{
 const f=await fixture(t);const down=await readFile('db/down/0308_control_loop_providers.sql','utf8');
 assert.equal((await f.put(0)).status,201);const saved=await f.rows();
 await assert.rejects(f.db.exec(down),{code:'23514'});await f.db.exec('ROLLBACK');assert.deepEqual(await f.rows(),saved);
 await f.db.query('DELETE FROM control_loop_provider_models');await f.db.query('DELETE FROM control_loop_providers');
 await assert.rejects(f.db.exec(down),{code:'23514'});await f.db.exec('ROLLBACK');
 await f.db.query('DELETE FROM control_loop_provider_state');await f.db.exec(down);
 assert.equal((await f.db.query("SELECT * FROM pg_tables WHERE tablename LIKE 'control_loop_provider%'")).rows.length,0);
});
for(const mode of ['private','Mac-local'] as const)test(`S1 ${mode} Node actual provider and policy PUT persistence and refusal`,async t=>{
 const f=await fixture(t);await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb)`);
 const host=mode==='private'?origin:'http://127.0.0.1:54321';const ownerCode='synthetic-provider-owner-code-0001';
 const local=mode==='Mac-local'?new LocalOwnerSessionServiceV1({schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin:host,tenantId:scope.tenantId,provider:trust.issuer,subject:'test-owner',ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900}):undefined;
 const cookie=local?(await local.issue(new Request(host+'/api/v1/local-owner-session',{method:'POST',headers:{origin:host}}),ownerCode,now)).cookie.split(';')[0]!:undefined;
 const auth=local?{localOwnerSession:local}:{trust};
 const providerHttp=createLoopProviderHttpHandlerV1({origin:host,service:f.service,clock:()=>now,...auth});
 const policyHttp=createLoopPolicyHttpHandlerV1({origin:host,service:new LoopPolicyServiceV1(f.client,scope,{settingsText:'{}',checkSettings:async()=>({eligible:true,reasons:[]})},()=>now),clock:()=>now,...auth});
 let calls=0;
 const transport=(mode==='private'?createPrivateNodeHandler:createMacLocalNodeHandler)({origin:host,application:{isReady:()=>true,close:async()=>{}},assets:{count:0,digest:'fixture',respond:()=>undefined},handler:r=>{calls++;return new URL(r.url).pathname.includes('/loop-policy/')?policyHttp(r):providerHttp(r);}});
 const send=async(path:string,value:unknown,k=key(),anonymous=false,foreign=false)=>{
  const body=JSON.stringify(value),headers=['Origin',foreign?'https://foreign.invalid':host,'Content-Type','application/json','Content-Length',String(Buffer.byteLength(body)),'Idempotency-Key',k];
  if(!anonymous)headers.push(...(cookie?['Cookie',cookie]:['Cf-Access-Jwt-Assertion',token()]));
  const e=nodeExchange({path,method:'PUT',body,headers});e.input.rawHeaders[1]=new URL(host).host;
  try{await transport.handle(e.input,e.output);return e.output.statusCode;}finally{e.input.destroy();e.output.destroy();}
 };
 try{
  const path='/api/v1/loop-providers/provider-one',body={expectedVersion:0,provider:provider()},k=key();
  assert.equal(await send(path,body,k),201,'S1 provider Node PUT must persist');assert.equal(await send(path,body,k),200);
  assert.equal(await send(path,{expectedVersion:1,provider:provider({display_name:'Replacement'})}),201);
  assert.equal((await f.rows())[0].length,1);assert.equal((await f.rows())[2][0]!.version,2);
  for(const layer of ['project','selection'])assert.equal(await send(`/api/v1/projects/${f.project.projectId}/loop-policy/${layer}`,{expectedVersion:0,settings:'{}'}),201,'S1 policy Node PUT must persist');
  assert.equal((await f.db.query('SELECT * FROM control_loop_policy_events')).rows.length,2);
  const saved=await f.rows();
  for(const bad of [path+'/extra',path+'/',path+'?x=1','/api/v1/loop-providers/UPPER',`/api/v1/projects/${f.project.projectId}/loop-policy/other`,'/api/v1/neighbour']){const n=calls;assert.equal(await send(bad,{}),405);assert.equal(calls,n);}
  assert.equal(await send(path,body,key(),true),401);assert.equal(await send(path,body,key(),false,true),403);
  assert.equal(await send(path,{expectedVersion:2,provider:provider({credit_note:'x'.repeat(9000)})}),413);
  assert.deepEqual(await f.rows(),saved);
 }finally{await transport.close();}
});

test('S1 service enforces 32-provider and 64 KiB captured snapshot bounds before storage',async t=>{
 const f=await fixture(t);
 for(let i=0;i<32;i++){const p=provider({provider_id:`provider-${String(i).padStart(2,'0')}`});await f.service.upsert(f.identity,p.provider_id,{expectedVersion:i,provider:p},key());}
 const saved=await f.rows();const p=provider({provider_id:'provider-extra'});
 await assert.rejects(f.service.upsert(f.identity,p.provider_id,{expectedVersion:32,provider:p},key()),{code:'invalid_request'});
 assert.deepEqual(await f.rows(),saved);
});

test('S1 oversized valid mapped snapshot refuses before provider storage',async t=>{
 const f=await fixture(t);const models=[];
 for(let i=0;i<180;i++){
  const name='synthetic-'+String(i).padStart(3,'0')+'x'.repeat(140);
  await f.db.query(`INSERT INTO control_loop_roster_models SELECT tenant_id,$1,$2,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at FROM control_loop_roster_models WHERE name='synthetic/model'`,[name,i+2]);
  models.push({roster_name:name,launcher:'synthetic-api',served_model_id:'s'.repeat(180)});
 }
 const p=provider({models});assert.ok(Buffer.byteLength(JSON.stringify(p))>65536);
 await assert.rejects(f.service.upsert(f.identity,p.provider_id,{expectedVersion:0,provider:p},key()),{code:'invalid_request'});
 assert.deepEqual(await f.rows(),[[],[],[]]);
});
