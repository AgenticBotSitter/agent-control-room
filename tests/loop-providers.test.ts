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
async function fixture(t: TestContext, presence: import('../src/web/v1/loop-provider-service').ProviderSecretPresenceV1 = { availability: async (_id: string) => 'available' as const }) {
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
  assert.deepEqual(await f.service.view(f.identity), {schema:'control-room.loop-provider-snapshot/v1',tenantId:scope.tenantId,version:0,providers:[],prices:[],fetches:[]});
  assert.deepEqual(await f.rows(), [[],[],[]]);
  const k = key(); assert.equal((await f.put(0,provider(),k)).status,201);
  assert.deepEqual(await f.service.view(f.identity), {schema:'control-room.loop-provider-snapshot/v1',tenantId:scope.tenantId,version:1,providers:[provider()],prices:[],fetches:[]});
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
  for(const p of [provider({billing_kind:'free' as 'token'}),{...provider(),apiKey:'synthetic'}])
    assert.equal((await f.put(0,p)).status,400);
  for(const [p,reason] of [[provider({base_url:'http://example.com'}),'base_url'],[provider({price_source_url:'https://other.example/prices',price_source_format:'control-room.provider-prices/v1'}),'price_source_url'],
    [provider({models:[{...provider().models[0]!,launcher:'other'}],secret_ref:{kind:'launcher',launcher:'other'}}),'roster_mismatch']] as const){
    const r=await f.put(0,p);assert.equal(r.status,422);assert.deepEqual(await r.json(),{error:'provider_refused',reason,message:'Provider unavailable'});
  }
  assert.deepEqual(await f.rows(),[[],[],[]]);
});
test('S1 body secret in allowed credit note refuses without writes or marker disclosure',async t=>{
 const f=await fixture(t),marker='Bearer CRMARKER-'+'a'.repeat(32);
 const response=await f.put(0,provider({credit_note:marker}));
 assert.equal(response.status,400);
 assert.deepEqual(await response.json(),{error:'invalid_request'});
 assert.deepEqual(await f.rows(),[[],[],[]]);
});
test('S1 removal HTTP body type size CSRF and owner refusals preserve all rows',async t=>{
 const f=await fixture(t);assert.equal((await f.put(0)).status,201);const saved=await f.rows();
 for(const req of [new Request(origin+'/api/v1/loop-providers/provider-one/remove',{method:'POST',headers:{'cf-access-jwt-assertion':token(),origin}}),
  new Request(origin+'/api/v1/loop-providers/provider-one/remove',{method:'POST',headers:{'cf-access-jwt-assertion':token(),origin,'content-type':'text/plain'},body:'{}'}),
  request('/api/v1/loop-providers/provider-one/remove','POST',{expectedVersion:1,extra:true})]) assert.equal((await f.handler(req)).status,400);
 assert.equal((await f.handler(request('/api/v1/loop-providers/provider-one/remove','POST',{expectedVersion:1,extra:'x'.repeat(65536)}))).status,413);
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
test('S1 Bitwarden reference persists and replays without probing but unresolved routes refuse',async t=>{
 const calls:string[]=[];
 const f=await fixture(t,{availability:async id=>{calls.push(id);return 'available';}});
 const p=provider({secret_ref:{kind:'bitwarden',item:'opaque-item'}}),k=key();
 assert.equal((await f.put(0,p,k)).status,201);
 const saved=await f.rows();
 assert.deepEqual((await f.service.view(f.identity)).providers,[p]);
 assert.deepEqual(saved[0]![0]!.secret_ref,p.secret_ref);
 assert.deepEqual(saved.map(rows=>rows.length),[1,1,1]);
 assert.equal((await f.put(0,p,k)).status,200);
 await assert.rejects(f.service.revalidate(f.identity,{providerId:'provider-one',model:'synthetic/model'}),{reason:'secret_missing',message:'Secret unavailable'});
 assert.deepEqual(await f.rows(),saved);
 assert.deepEqual(calls,[]);
 assert.equal((await f.remove(1)).status,201);
 assert.deepEqual((await f.rows()).map(rows=>rows.length),[0,0,1]);
 assert.deepEqual(calls,[]);
});
test('S1 roster change invalidates mappings',async t=>{
 const f=await fixture(t);
 assert.equal((await f.put(0)).status,201);await f.db.query("UPDATE control_loop_roster_models SET launcher='changed'");
 await assert.rejects(f.service.revalidate(f.identity,{providerId:'provider-one',model:'synthetic/model'}),{reason:'roster_mismatch'});
});
test('S1 down is empty-only and retained provider model or state rolls back atomically',async t=>{
 const f=await fixture(t);const down=await readFile('db/down/0312_control_loop_providers.sql','utf8');
 assert.equal((await f.put(0)).status,201);const saved=await f.rows();
 await assert.rejects(f.db.exec(down),{code:'23514'});await f.db.exec('ROLLBACK');assert.deepEqual(await f.rows(),saved);
 await f.db.query('DELETE FROM control_loop_provider_models');await f.db.query('DELETE FROM control_loop_providers');
 await assert.rejects(f.db.exec(down),{code:'23514'});await f.db.exec('ROLLBACK');
 await f.db.query('DELETE FROM control_loop_provider_state');
 await f.db.exec(await readFile('db/down/0313_control_loop_provider_prices.sql','utf8'));await f.db.exec(down);
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
  assert.equal(await send(`/api/v1/projects/${f.project.projectId}/loop-policy/project`,{expectedVersion:0,settings:'{}'}),400,'P72 project PUT requires lockedPaths');
  assert.equal((await f.db.query('SELECT * FROM control_loop_policy_events')).rows.length,0);
  for(const layer of ['project','selection'])assert.equal(await send(`/api/v1/projects/${f.project.projectId}/loop-policy/${layer}`,{expectedVersion:0,settings:'{}',...(layer==='project'?{lockedPaths:[]}: {})}),201,'S1 policy Node PUT must persist');
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

test('S2 refresh handler accepts an owner snapshot and idempotent replay without a source', async t => {
  const f = await fixture(t);
  assert.equal((await f.put(0)).status, 201);
  const k = key();
  const refresh = () => f.handler(request('/api/v1/loop-providers/refresh-prices', 'POST', {expectedVersion:1}, k));
  const first = await refresh();
  assert.equal(first.status, 201, 'owner refresh must reach the real service');
  assert.deepEqual(await first.json(), {replayed:false,version:2});
  assert.equal((await refresh()).status, 200);
  assert.equal((await f.service.view(f.identity)).version, 2);
  assert.deepEqual((await f.db.query('SELECT provider_id,outcome,reason FROM control_loop_provider_fetches')).rows,
    [{provider_id:'provider-one',outcome:'no_source',reason:'no_source'}]);
  assert.equal((await f.db.query('SELECT * FROM control_loop_provider_prices')).rows.length, 0);
});

// All S2 sources below are recorded documents served by injected, address-aware transports.
const priceDocument = (prices: unknown[] = [{model:'served/one',currency:'USD',inputUsdPerMillionTokens:'1.234',outputUsdPerMillionTokens:'2.5'}]) => ({schema:'control-room.provider-prices/v1',prices});
const priceProvider = (id='provider-one',served='served/one') => provider({provider_id:id,price_source_url:'https://example.com/prices',price_source_format:'control-room.provider-prices/v1',models:[{...provider().models[0]!,served_model_id:served}]});
const publicLookup = async () => [{address:'8.8.8.8',family:4 as const}];
async function priceFixture(t:TestContext,dependencies:import('../src/web/v1/loop-provider-prices').ProviderPriceDependenciesV1) {
  const f=await fixture(t);
  const service=new LoopProviderServiceV1(f.client,scope,undefined,()=>now,{lookup:publicLookup,...dependencies});
  const handler=createLoopProviderHttpHandlerV1({origin,trust,service,clock:()=>now});
  const refresh=(expectedVersion:number,k=key(),signal?:AbortSignal)=>{
    const req=request('/api/v1/loop-providers/refresh-prices','POST',{expectedVersion},k);
    return handler(signal?new Request(req,{signal}):req);
  };
  return {...f,service,handler,refresh};
}
test('S2 actual refresh four sources partial failure recovery staleness and replay',async t=>{
  let failing=true,gets=0;
  const f=await priceFixture(t,{fetch:async url=>{
    gets++;
    if(url.pathname==='/third'&&failing)return new Response('recorded failure',{status:500});
    if(url.pathname==='/html')return new Response('<html>Recorded page</html>',{headers:{'content-type':'text/html'}});
    return Response.json(priceDocument());
  }});
  let version=0;
  for(const [id,path] of [['provider-one','/first'],['provider-two','/second'],['provider-three','/third'],['provider-four','/html']]){
    const p={...priceProvider(id),price_source_url:'https://example.com'+path};
    await f.service.upsert(f.identity,id!,{expectedVersion:version++,provider:p},key());
  }
  const k=key();assert.equal((await f.refresh(4,k)).status,201);assert.equal(gets,4);
  let view=await f.service.view(f.identity);
  assert.equal(view.prices.length,2);
  assert.deepEqual(view.prices.map(p=>[p.input,p.output,p.status,p.reason,p.checkedAt,p.stale]),Array.from({length:2},()=>['1234','2500','known','',new Date(now).toISOString(),false]));
  assert.deepEqual(view.fetches.map(f=>[f.providerId,f.outcome]),[['provider-four','not_machine_readable'],['provider-one','ok'],['provider-three','failed'],['provider-two','ok']]);
  assert.equal((await f.refresh(4,k)).status,200);assert.equal(gets,4,'replay performs zero GETs');
  failing=false;assert.equal((await f.refresh(5)).status,201);
  // The retained observation is now older than one day, while this fetch fails anew.
  const old=new Date(now-24*3600_000-1).toISOString();
  await f.db.query("UPDATE control_loop_provider_prices SET checked_at=$1 WHERE provider_id='provider-three'",[old]);
  failing=true;assert.equal((await f.refresh(6)).status,201);
  view=await f.service.view(f.identity);
  assert.equal(view.prices.find(p=>p.providerId==='provider-three')!.checkedAt,old);
  assert.equal(view.prices.find(p=>p.providerId==='provider-three')!.stale,true);
  assert.equal(view.fetches.find(p=>p.providerId==='provider-three')!.outcome,'failed');
});
test('S2 public address refusal and pinned address rebinding proof through the handler',async t=>{
  let answers=[{address:'127.0.0.1',family:4 as 4|6}],calls=0,lookups=0;
  const f=await priceFixture(t,{lookup:async()=>{lookups++;return answers;},fetch:async(url,address,init)=>{
    calls++;assert.deepEqual(address,{address:'8.8.8.8',family:4});assert.equal(url.hostname,'example.com');
    assert.equal(init.method,'GET');assert.deepEqual(Object.fromEntries(new Headers(init.headers)),{accept:'application/json','accept-encoding':'identity'});
    // A subsequent resolution would now be private; the transport must use the vetted address.
    answers=[{address:'127.0.0.1',family:4}];return Response.json(priceDocument());
  }});
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());
  let version=1;
  for(const addresses of [[{address:'127.0.0.1',family:4}],[{address:'169.254.169.254',family:4}],[{address:'::1',family:6}],
    [{address:'::ffff:10.0.0.1',family:6}],[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],[{address:'invalid',family:4}]] as typeof answers[]){
    answers=addresses;assert.equal((await f.refresh(version++)).status,201);
    assert.equal(calls,0,'S2 private-address guard must prevent every transport call');
  }
  answers=[{address:'8.8.8.8',family:4}];assert.equal((await f.refresh(version)).status,201);
  assert.equal(calls,1);assert.equal(lookups,7,'exactly one resolution per refresh');
});
test('S2 strict document reader normalization windows DST and canonical digest',async()=>{
  const {providerPriceDocumentSchemaV1:schema,refreshProviderPricesV1,priceAtV1,providerPriceDigestV1}=await import('../src/web/v1/loop-provider-prices');
  const base={model:'served/one',currency:'USD',inputUsdPerMillionTokens:'1.234000000',outputUsdPerMillionTokens:'0'};
  const window={tz:'America/Denver',days:[0],start:'01:00',end:'02:00'};
  for(const item of [{...base,model:' bad'},{...base,model:'a'.repeat(181)},{...base,currency:'ZZZ'},{...base,currency:'usd'},
    {...base,inputUsdPerMillionTokens:'1e3'},{...base,inputUsdPerMillionTokens:'-1'},{...base,inputUsdPerMillionTokens:'NaN'},
    {...base,extra:true},{...base,window:{...window,end:'00:00'}},{...base,window:{...window,days:[0,0]}},
    {...base,window:{...window,tz:'Fake/Zone'}},{...base,window:{...window,start:'24:00'}},{...base,window:{...window,days:[2,1]}}])assert.equal(schema.safeParse(priceDocument([item])).success,false);
  assert.equal(schema.safeParse({...priceDocument(),extra:true}).success,false);
  assert.equal(schema.safeParse(priceDocument(Array(257).fill(base))).success,false);
  assert.equal(schema.safeParse(priceDocument([{...base,window},{...base,window}])).success,false);
  assert.equal(schema.safeParse(priceDocument([{...base,window},{...base,window:{...window,start:'01:30',end:'03:00'}}])).success,false);
  assert.equal(schema.safeParse(priceDocument([{...base,window},{...base,window:{...window,tz:'UTC',start:'02:00',end:'03:00'}}])).success,false);
  const rows=[base,{...base,window}];assert.equal(schema.safeParse(priceDocument(rows)).success,true);
  const result=await refreshProviderPricesV1([priceProvider()],new AbortController().signal,()=>now,{lookup:publicLookup,fetch:async()=>Response.json(priceDocument(rows))});
  const prices=result[0]!.prices!;assert.equal(prices[0]!.input,'1234');assert.equal(prices[0]!.output,'0');
  assert.equal(prices[1]!.windowKey,'America/Denver|0|01:00-02:00');
  for(const at of ['2026-11-01T07:00:00Z','2026-11-01T08:30:00Z'])assert.equal(priceAtV1(prices,new Date(at))!.windowKey,prices[1]!.windowKey,'both DST folds use local window');
  assert.equal(priceAtV1(prices,new Date('2026-11-01T09:00:00Z'))!.windowKey,'all','end is exclusive');
  assert.equal(priceAtV1(prices,new Date('2026-11-01T06:59:59Z'))!.windowKey,'all');
  assert.equal(priceAtV1(prices.slice(1),new Date('2026-11-01T09:00:00Z')),null);
  const p=prices[0]!;
  assert.equal(providerPriceDigestV1(p),sha256Digest({providerId:'provider-one',model:'served/one',windowKey:'all',window:null,input:'1234',output:'0',currency:'USD',status:'known',reason:'',checkedAt:new Date(now).toISOString()}));
  assert.notEqual(providerPriceDigestV1(p),providerPriceDigestV1({...p,status:'unknown'}));
});
test('S2 handler retains rows for invalid unmapped other-provider and non-machine documents',async t=>{
  let document:unknown=priceDocument();
  const f=await priceFixture(t,{fetch:async()=>Response.json(document)});
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());
  await f.service.upsert(f.identity,'provider-two',{expectedVersion:1,provider:priceProvider('provider-two','served/other')},key());
  assert.equal((await f.refresh(2)).status,201);
  const before=(await f.service.view(f.identity)).prices;
  let version=3;
  for(const model of ['served/unmapped','served/other',' bad','a'.repeat(181)]){
    document=priceDocument([{model,currency:'USD',inputUsdPerMillionTokens:'1',outputUsdPerMillionTokens:'2'}]);
    assert.equal((await f.refresh(version++)).status,201);
    const after=await f.service.view(f.identity);
    assert.deepEqual(after.prices.filter(p=>p.providerId==='provider-one'),before.filter(p=>p.providerId==='provider-one'));
    assert.equal(after.fetches.find(p=>p.providerId==='provider-one')!.outcome,'not_machine_readable');
    assert.equal(after.fetches.find(p=>p.providerId==='provider-one')!.reason,model.startsWith('served/')?'unmapped_model':'invalid_document');
  }
  for(const invalid of [priceDocument([{model:'served/one',currency:'ZZZ',inputUsdPerMillionTokens:'1',outputUsdPerMillionTokens:'2'}]),priceDocument([{model:'served/one',currency:'USD',inputUsdPerMillionTokens:'1',outputUsdPerMillionTokens:'2',window:{tz:'UTC',days:[0],start:'23:00',end:'01:00'}}])]){
    document=invalid;assert.equal((await f.refresh(version++)).status,201);
    assert.deepEqual((await f.service.view(f.identity)).prices.filter(p=>p.providerId==='provider-one'),before.filter(p=>p.providerId==='provider-one'));
  }
  document=priceDocument([{model:'served/one',currency:'USD',inputUsdPerMillionTokens:'0.0001',outputUsdPerMillionTokens:'2'}]);
  await f.refresh(version++);let view=await f.service.view(f.identity);
  assert.equal(view.prices.find(p=>p.providerId==='provider-one')!.reason,'precision');assert.equal(view.prices.find(p=>p.providerId==='provider-one')!.input,null);
  document=priceDocument([{model:'served/one',currency:'EUR',inputUsdPerMillionTokens:'1',outputUsdPerMillionTokens:'2'}]);
  await f.refresh(version++);view=await f.service.view(f.identity);
  assert.equal(view.prices.find(p=>p.providerId==='provider-one')!.status,'not_comparable');
  assert.equal(view.prices.find(p=>p.providerId==='provider-one')!.input,null);
  document=priceDocument([]);await f.refresh(version++);assert.deepEqual((await f.service.view(f.identity)).prices,[],'success replaces all rows');
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:version++,provider:priceProvider()},key());
  assert.equal((await f.service.view(f.identity)).fetches.some(p=>p.providerId==='provider-one'),false,'replacement invalidates fetch');
  await f.service.remove(f.identity,'provider-two',{expectedVersion:version},key());
  assert.equal((await f.service.view(f.identity)).fetches.some(p=>p.providerId==='provider-two'),false);
});
test('S2 three simultaneous source timeouts retain observations while the fast source commits',async t=>{
  let slow=false,started=0,aborted=0;
  const f=await priceFixture(t,{providerTimeoutMs:80,handlerTimeoutMs:1000,fetch:async(url,_address,init)=>{
    started++;
    if(slow&&url.pathname!=='/fast')return new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener('abort',()=>{aborted++;reject(new Error('fixture cancelled'));},{once:true}));
    return Response.json(priceDocument());
  }});
  for(let i=0;i<4;i++)await f.service.upsert(f.identity,`provider-${i}`,{expectedVersion:i,provider:{...priceProvider(`provider-${i}`),price_source_url:'https://example.com/'+(i===3?'fast':'slow'+i)}},key());
  await f.refresh(4);const before=(await f.service.view(f.identity)).prices;slow=true;started=0;
  const start=performance.now();const response=await f.refresh(5);const elapsed=performance.now()-start;
  assert.equal(response.status,201);assert.equal(started,4);assert.equal(aborted,3);
  assert.ok(elapsed<240,`parallel source deadlines took ${elapsed}ms`);
  const after=await f.service.view(f.identity);assert.equal(after.fetches.filter(f=>f.outcome==='failed').length,3);
  assert.deepEqual(after.prices,before);assert.equal(after.fetches[3]!.outcome,'ok');
});
test('S2 source overflow redirect encoding body timeout and no retry cancel every request',async t=>{
  let mode='redirect',calls=0,cancelled=0;
  const signals:AbortSignal[]=[];
  const f=await priceFixture(t,{providerTimeoutMs:30,fetch:async(_url,_address,init)=>{
    calls++;signals.push(init.signal!);
    const body=new ReadableStream<Uint8Array>({start(c){if(mode==='overflow')c.enqueue(new Uint8Array(256*1024+1));},cancel(){cancelled++;}});
    return new Response(body,mode==='redirect'?{status:302,headers:{location:'https://example.com/other'}}:mode==='encoding'?{headers:{'content-encoding':'gzip'}}:{});
  }});
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());
  for(const [index,m] of ['redirect','overflow','encoding','timeout'].entries()){
    mode=m;assert.equal((await f.refresh(index+1)).status,201);assert.equal(calls,index+1,'exactly one request, no redirect or retry');
    const fetch=(await f.service.view(f.identity)).fetches[0]!;
    assert.equal(fetch.reason,({redirect:'http_status',overflow:'overflow',encoding:'encoding',timeout:'timeout'} as Record<string,string>)[m]);
  }
  assert.equal(cancelled,4);assert.ok(signals.every(signal=>signal.aborted));
});
test('S2 handler deadline and disconnect cancel work with no late commit',async t=>{
  let cancelled=0;
  const f=await priceFixture(t,{handlerTimeoutMs:80,providerTimeoutMs:1000,fetch:async(_u,_a,init)=>new Promise<Response>((_resolve,reject)=>{
    init.signal!.addEventListener('abort',()=>{cancelled++;reject(new Error('fixture cancelled'));},{once:true});
  })});
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());
  const before=await f.rows();const start=performance.now();assert.ok((await f.refresh(1)).status>=400);
  assert.ok(performance.now()-start<250);assert.equal(cancelled,1);assert.deepEqual(await f.rows(),before);
  const disconnect=new AbortController();const pending=f.refresh(1,key(),disconnect.signal);
  const timer=setTimeout(()=>disconnect.abort(),20);try{assert.ok((await pending).status>=400);}finally{clearTimeout(timer);}
  assert.equal(cancelled,2);assert.deepEqual(await f.rows(),before);
  assert.equal((await f.db.query('SELECT * FROM control_loop_provider_fetches')).rows.length,0);
});
test('S2 changed configuration and concurrent refresh reject stale commits',async t=>{
  let arrival!:()=>void,release!:()=>void;
  let arrived=new Promise<void>(r=>arrival=r),gate=new Promise<void>(r=>release=r);
  let count=0;
  const f=await priceFixture(t,{fetch:async()=>{count++;arrival();await gate;return Response.json(priceDocument());}});
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());
  const pending=f.refresh(1);await arrived;
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:1,provider:priceProvider()},key());release();
  assert.equal((await pending).status,409);assert.equal((await f.service.view(f.identity)).prices.length,0);
  let arrivals=0;arrived=new Promise<void>(r=>arrival=r);gate=new Promise<void>(r=>release=r);
  const deps={lookup:publicLookup,fetch:async()=>{arrivals++;if(arrivals===2)arrival();await gate;return Response.json(priceDocument());}};
  const s=new LoopProviderServiceV1(f.client,scope,undefined,()=>now,deps),h=createLoopProviderHttpHandlerV1({origin,trust,service:s,clock:()=>now});
  const race=[1,2].map(()=>h(request('/api/v1/loop-providers/refresh-prices','POST',{expectedVersion:2},key())));
  await arrived;release();assert.deepEqual((await Promise.all(race)).map(r=>r.status).sort(),[201,409]);
  assert.equal((await s.view(f.identity)).version,3);assert.equal(count,1);
});
test('S2 refresh rejects operator non-human malformed content and CSRF without transport or price writes',async t=>{
  let gets=0;const f=await priceFixture(t,{fetch:async()=>{gets++;return Response.json(priceDocument());}});
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());
  const before=await f.rows();
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");assert.equal((await f.refresh(1)).status,403,'S2 independent owner denial assertion');
  await f.db.query("UPDATE control_role_grants SET role_key='owner'");
  await f.db.query("UPDATE control_identities SET actor_type='agent'");assert.equal((await f.refresh(1)).status,403);
  await f.db.query("UPDATE control_identities SET actor_type='human'");
  for(const body of [{},{expectedVersion:1,extra:true},{expectedVersion:-1},{expectedVersion:'1'}])assert.equal((await f.handler(request('/api/v1/loop-providers/refresh-prices','POST',body,key()))).status,400);
  for(const changed of [{'content-type':'text/plain'},{origin:'https://foreign.invalid'},{'idempotency-key':''}]){
    const req=request('/api/v1/loop-providers/refresh-prices','POST',{expectedVersion:1},key());for(const [k,v] of Object.entries(changed))req.headers.set(k,v);
    assert.ok((await f.handler(req)).status>=400);
  }
  assert.equal(gets,0);assert.deepEqual(await f.rows(),before);
  assert.equal((await f.db.query('SELECT * FROM control_loop_provider_fetches')).rows.length,0);
});
test('S2 price down refuses retained price or fetch atomically and accepts empty',async t=>{
  const f=await priceFixture(t,{fetch:async()=>Response.json(priceDocument())});
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());await f.refresh(1);
  const down=await readFile('db/down/0313_control_loop_provider_prices.sql','utf8');
  const before=await f.service.view(f.identity);
  await assert.rejects(f.db.exec(down),{code:'23514'});await f.db.exec('ROLLBACK');assert.deepEqual(await f.service.view(f.identity),before);
  await f.db.query('DELETE FROM control_loop_provider_prices');await assert.rejects(f.db.exec(down),{code:'23514'});await f.db.exec('ROLLBACK');
  await f.db.query('DELETE FROM control_loop_provider_fetches');await f.db.exec(down);
  assert.equal((await f.db.query("SELECT * FROM pg_tables WHERE tablename IN ('control_loop_provider_prices','control_loop_provider_fetches')")).rows.length,0);
});

test('S2 DNS timeout never transports and all late fetch responses are cancelled',async t=>{
  let calls=0;
  const f=await priceFixture(t,{providerTimeoutMs:20,lookup:async()=>new Promise(()=>{}),fetch:async()=>{calls++;return Response.json(priceDocument());}});
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());
  assert.equal((await f.refresh(1)).status,201);assert.equal(calls,0);
  assert.equal((await f.service.view(f.identity)).fetches[0]!.reason,'timeout');
  const {refreshProviderPricesV1}=await import('../src/web/v1/loop-provider-prices');
  let deliver!:(response:Response)=>void,cancelled!:()=>void;
  const cancelledBody=new Promise<void>(r=>cancelled=r);
  const result=await refreshProviderPricesV1([priceProvider()],new AbortController().signal,()=>now,{providerTimeoutMs:10,lookup:publicLookup,fetch:async()=>new Promise(r=>deliver=r)});
  assert.equal(result[0]!.fetch.reason,'timeout');
  deliver(new Response(new ReadableStream({cancel(){cancelled();}})));await cancelledBody;
});
test('S2 precommit cancellation rolls back price fetch and state writes together',async t=>{
  const f=await fixture(t),disconnect=new AbortController();
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());
  const before=await f.rows();let updated=false;
  const db:import('../src/persistence/database').DatabaseClient={...f.client,
    transactionWithPreCommitCheck:(work,check)=>f.client.transactionWithPreCommitCheck(tx=>work({query:async <T>(sql:string,params?:unknown[])=>{
      const result=await tx.query<T>(sql,params);
      if(sql.startsWith('UPDATE control_loop_provider_state')){updated=true;disconnect.abort();}
      return result;
    }}),check),
  };
  const service=new LoopProviderServiceV1(db,scope,undefined,()=>now,{lookup:publicLookup,fetch:async()=>Response.json(priceDocument())});
  await assert.rejects(service.refreshPrices(f.identity,{expectedVersion:1},key(),disconnect.signal));
  assert.equal(updated,true,'cancellation occurs after actual SQL writes');assert.deepEqual(await f.rows(),before);
  for(const table of ['control_loop_provider_prices','control_loop_provider_fetches'])assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length,0);
});
test('S2 final authorization recheck refuses a revoked owner after fetch without observations',async t=>{
  let began!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>began=r),gate=new Promise<void>(r=>release=r);
  const f=await priceFixture(t,{fetch:async()=>{began();await gate;return Response.json(priceDocument());}});
  await f.service.upsert(f.identity,'provider-one',{expectedVersion:0,provider:priceProvider()},key());
  const before=await f.rows(),pending=f.refresh(1);await started;
  await f.db.query("UPDATE control_role_grants SET revoked_at=$1",[new Date(now).toISOString()]);release();
  assert.equal((await pending).status,403);assert.deepEqual(await f.rows(),before);
  assert.equal((await f.db.query('SELECT * FROM control_loop_provider_fetches')).rows.length,0);
});
test('S2 refresh endpoint preserves refresh-prices as a valid provider ID for PUT and remove',async t=>{
  const f=await fixture(t),p=provider({provider_id:'refresh-prices'});
  assert.equal((await f.handler(request('/api/v1/loop-providers/refresh-prices','PUT',{expectedVersion:0,provider:p},key()))).status,201);
  assert.equal((await f.handler(request('/api/v1/loop-providers/refresh-prices/remove','POST',{expectedVersion:1},key()))).status,201);
});

test('S2 clock crossing exactly 24 hours keeps checked-at and exposes a stale retained price on failed refresh',async t=>{
  const f=await fixture(t);let at=now,failed=false;
  const service=new LoopProviderServiceV1(f.client,scope,undefined,()=>at,{lookup:publicLookup,fetch:async()=>failed?new Response('recorded failure',{status:500}):Response.json(priceDocument())});
  const longTrust={...trust,validUntilMs:now+3*24*3600_000};
  const handler=createLoopProviderHttpHandlerV1({origin,trust:longTrust,service,clock:()=>at});
  const jwt=token({exp:(now+3*24*3600_000)/1000});
  const send=(path:string,method='GET',body?:unknown)=>handler(request(path,method,body,key(),jwt));
  await f.db.query('UPDATE control_role_grants SET expires_at=NULL');
  assert.equal((await send('/api/v1/loop-providers/provider-one','PUT',{expectedVersion:0,provider:priceProvider()})).status,201);
  assert.equal((await send('/api/v1/loop-providers/refresh-prices','POST',{expectedVersion:1})).status,201);
  at=now+24*3600_000;
  let view=await (await send('/api/v1/loop-providers')).json() as Awaited<ReturnType<typeof service.view>>;
  assert.equal(view.prices[0]!.stale,false,'exact 24 hour boundary is still fresh');
  at++;failed=true;
  assert.equal((await send('/api/v1/loop-providers/refresh-prices','POST',{expectedVersion:2})).status,201);
  view=await (await send('/api/v1/loop-providers')).json() as typeof view;
  assert.equal(view.prices[0]!.stale,true);assert.equal(view.prices[0]!.checkedAt,new Date(now).toISOString());
  assert.deepEqual(view.fetches,[{providerId:'provider-one',outcome:'failed',reason:'http_status',fetchedAt:new Date(at).toISOString()}]);
});

test('S3 offers decode one segment, keep every mapping and mark all fresh USD minima',async t=>{
 const f=await fixture(t,{availability:async()=>{throw new Error('view must not probe credentials');}});
 for(const [i,id] of ['provider-one','provider-two','provider-three','provider-four','provider-five','provider-six'].entries()){
  const p=provider({provider_id:id,display_name:id,credit_expires_on:'2020-01-01',...(id==='provider-six'?{secret_ref:{kind:'bitwarden' as const,item:'opaque-item'}}:{})});
  await f.service.upsert(f.identity,id,{expectedVersion:i,provider:p},key());
 }
 const price=async(id:string,input:string,output:string,currency='USD',age=0)=>f.db.query(`INSERT INTO control_loop_provider_prices(tenant_id,provider_id,model,window_key,"window",input_nano_usd_per_token,output_nano_usd_per_token,currency,status,reason,checked_at)
 VALUES($1,$2,'served/one','all',NULL,$3,$4,$5,$6,'',$7) ON CONFLICT (tenant_id,provider_id,model,window_key) DO UPDATE SET input_nano_usd_per_token=$3,output_nano_usd_per_token=$4`,[scope.tenantId,id,currency==='USD'?input:null,currency==='USD'?output:null,currency,currency==='USD'?'known':'not_comparable',new Date(now-age).toISOString()]);
 await price('provider-one','10','20');await price('provider-two','10','20');await price('provider-three','1','1','EUR');await price('provider-four','1','1','USD',86400001);
 await f.db.query(`INSERT INTO control_loop_provider_fetches VALUES('tenant:web','provider-four','failed','http_status',$1)`,[new Date(now).toISOString()]);
 const get=()=>f.handler(request('/api/v1/loop-providers/offers/synthetic%2Fmodel'));
 let response=await get();assert.equal(response.status,200,'S3 offers must reach the real service');
 let body=await response.json();assert.equal(body.offers.length,6);assert.equal(body.cheapestStatus,'minimum');
 assert.deepEqual(body.offers.filter((o:any)=>o.cheapest).map((o:any)=>o.providerId),['provider-one','provider-two']);
 assert.equal(body.offers.find((o:any)=>o.providerId==='provider-one').servedModelId,'served/one');assert.equal(body.offers.find((o:any)=>o.providerId==='provider-one').credit.expired,true);
 assert.equal(body.offers.find((o:any)=>o.providerId==='provider-one').price.input,'10','credit is never deducted');assert.equal(body.offers.find((o:any)=>o.providerId==='provider-four').price.stale,true);
 assert.equal(body.offers.find((o:any)=>o.providerId==='provider-four').latestFetch.outcome,'failed');assert.equal(body.offers.find((o:any)=>o.providerId==='provider-five').price,null);
 assert.equal(body.offers.find((o:any)=>o.providerId==='provider-six').available,false);assert.equal(body.offers.find((o:any)=>o.providerId==='provider-six').availabilityReason,'Secret unavailable');
 await price('provider-two','5','30');body=await (await get()).json();assert.equal(body.cheapestStatus,'no_single_cheapest');assert.ok(body.offers.every((o:any)=>!o.cheapest));
 await f.db.query("UPDATE control_loop_roster_models SET launcher='changed'");body=await (await get()).json();assert.ok(body.offers.every((o:any)=>!o.available));
 for(const path of ['/api/v1/loop-providers/offers/synthetic/model','/api/v1/loop-providers/offers/synthetic%252Fmodel']){
  response=await f.handler(request(path));if(path.includes('%252F')){assert.equal(response.status,200);assert.equal((await response.json()).offers.length,0);}else assert.equal(response.status,404);
 }
 assert.equal((await f.handler(request('/api/v1/loop-providers/offers/%ZZ'))).status,400);
 for(const role of ['operator','lead']){await f.db.query('UPDATE control_role_grants SET role_key=$1',[role]);assert.equal((await get()).status,403);}
 await f.db.query("UPDATE control_role_grants SET role_key='owner'");
 await f.db.query("UPDATE control_identities SET actor_type='agent'");assert.equal((await get()).status,403);
 await f.db.query("UPDATE control_identities SET actor_type='human'");
 await f.service.remove(f.identity,'provider-one',{expectedVersion:6},key());body=await (await get()).json();assert.equal(body.offers.length,5);
});

// Explicit native lane: ordinary unit runs do not start a cluster.
test('S3 PostgreSQL 20 provider selection writers contend as production logins', {skip:process.env.CONTROL_ROOM_S3_NATIVE!=='1'}, async()=>{
 const {withRealPostgres}=await import('./support/attack-kit/index');
 const {Client,Pool}=await import('pg');
 const {bindPrivatePgPool}=await import('../src/web/v1/private-pg-database');
 const {privatePgOptions}=await import('../src/web/v1/private-pg-options');
 type Pg=Parameters<Parameters<typeof withRealPostgres>[0]>[0];
 const scope={tenantId:'tenant:s3',workspaceId:'workspace:s3'},project='project:s3',owner='identity:s3';
 const at=new Date(now-60000).toISOString(),expires=new Date(now+3600000).toISOString();
 const identity={provider:'test',subject:owner,tokenDigest:sha256Digest({session:'s3'}),issuedAt:at,expiresAt:expires,verificationExpiresAt:expires};
 async function sql(pg:Pg,query:string,params:unknown[]=[],role='admin',database=pg.database){
  const client=new Client(role==='admin'?pg.admin({database}):pg.connection(role,{database}));await client.connect();
  try{return await client.query(query,params);}finally{await client.end();}
 }
async function seed(pg:Pg,database=pg.database){
  await sql(pg,"INSERT INTO tenants(id,display_name) VALUES($1,'Fixture tenant')",[scope.tenantId],"admin",database);
  await sql(pg,"INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Fixture workspace')",[scope.workspaceId,scope.tenantId],"admin",database);
  await sql(pg,`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:b1b',$1,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`,[scope.tenantId],"admin",database);
  await sql(pg,`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,'adapter:b1b',$1,'1','Control Room','planned','manual_project_active','healthy','control_room_native',now(),
    '{"presentation":{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}}',now())`,[project,scope.tenantId,scope.workspaceId],"admin",database);
  await sql(pg,"INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES($1,$2,'active',1,now(),now())",[scope.tenantId,project],"admin",database);
  await sql(pg,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Fixture identity','test',$3,'active',$4,$4)`,[owner,scope.tenantId,sha256Digest({provider:"test",subject:owner}),at],"admin",database);
  await sql(pg,`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:b1b',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,[scope.tenantId,owner,at],"admin",database);
  await sql(pg,"INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",[scope.tenantId,identity.tokenDigest,owner,at,expires],"admin",database);
}
 const result=await withRealPostgres(async pg=>{
  await seed(pg);
  await sql(pg,`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
   VALUES($1,'synthetic/model',1,'synthetic-api','','','','','','','','on','','','',$2,$3)`,[scope.tenantId,owner,at]);
  const writer=()=>{
   const login=pg.connection('web');
   const bound=bindPrivatePgPool(new Pool({...privatePgOptions({host:'127.0.0.1',port:pg.port,database:pg.database,username:login.user,password:login.password!,majorVersion:17}),host:login.host,max:1}));
   return {...bound,providers:new LoopProviderServiceV1(bound.client,scope,{availability:async()=>{throw new Error('no secret probe');}},()=>now)};
  };
  const initial=writer();
  try{
   for(const [i,id] of ['provider-one','provider-two'].entries())await initial.providers.upsert(identity,id,{expectedVersion:i,provider:provider({provider_id:id,billing_kind:'subscription'})},key());
   let reached=0,release!:()=>void;
   const gate=new Promise<void>(r=>{release=r;});let barrierTimedOut=false;
   const timer=setTimeout(()=>{barrierTimedOut=true;release();},20000);
   const tools={settingsText:'{}',checkSettings:async()=>{if(++reached===20)release();await gate;return{eligible:true,reasons:[]};}};
   const clients=Array.from({length:20},()=>writer());
   try{
    const route={providerId:'provider-two',model:'synthetic/model'},settings=JSON.stringify({providerRoute:route});
    const results=await Promise.allSettled(clients.map((w,i)=>new LoopPolicyServiceV1(w.client,scope,tools,()=>now,w.providers).put(identity,project,'selection',{expectedVersion:0,settings},`s3-native-policy-${String(i).padStart(4,'0')}`)));
    assert.equal(barrierTimedOut,false,'all 20 callers reach the barrier before its safety timeout');
    assert.equal(reached,20,'all separate production callers checked before final compare-and-commit');
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    for(const r of results)if(r.status==='rejected')assert.equal(r.reason.code,'conflict');
    const rows=await sql(pg,'SELECT version,settings_text FROM control_loop_policy_layers');assert.equal(rows.rows.length,1);assert.deepEqual(JSON.parse(rows.rows[0].settings_text).providerRoute,route);
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_events')).rows[0].n,1);
    console.log('S3 PostgreSQL callers=20 checked=20 winners=1 losers=19 layers=1 events=1 barrier_timed_out='+barrierTimedOut);
   }finally{clearTimeout(timer);release();await Promise.all(clients.map(w=>w.close()));}
   // Final compare catches a withdrawal while the slow checker holds no DB lock.
   const slow={settingsText:'{}',checkSettings:async()=>{await initial.providers.remove(identity,'provider-two',{expectedVersion:2},key());return{eligible:true,reasons:[]};}};
   const policy=new LoopPolicyServiceV1(initial.client,scope,slow,()=>now,initial.providers);
   await assert.rejects(policy.put(identity,project,'selection',{expectedVersion:1,settings:JSON.stringify({providerRoute:{providerId:'provider-two',model:'synthetic/model'}})},key()),/loop_policy_refused/);
   assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_events')).rows[0].n,1);
  }finally{await initial.close();}
 },{port:60580,allowedPorts:[60580],database:'s3_provider_choice',boundMs:180000});
 assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);
 console.log('S3 PostgreSQL cleanedUp=true leftovers=0');
});

test('S3 offers namespace preserves offers as a provider ID for PUT and removal',async t=>{
 const f=await fixture(t),p=provider({provider_id:'offers'});
 assert.equal((await f.handler(request('/api/v1/loop-providers/offers','PUT',{expectedVersion:0,provider:p},key()))).status,201);
 const offers=await f.handler(request('/api/v1/loop-providers/offers/synthetic%2Fmodel'));
 assert.equal(offers.status,200);assert.equal((await offers.json()).offers[0].providerId,'offers');
 const removed=await f.handler(request('/api/v1/loop-providers/offers/remove','POST',{expectedVersion:1},key()));
 assert.equal(removed.status,201,'S3 provider offers must remain removable');
 assert.equal((await f.service.view(f.identity)).providers.length,0);
 // GET is still the offers endpoint for the literal roster name "remove".
 const read=await f.handler(request('/api/v1/loop-providers/offers/remove'));
 assert.equal(read.status,200);assert.equal((await read.json()).offers.length,0);
});

test('S3 offers refuses secret-marked model text without reflecting it or writing',async t=>{
 const f=await fixture(t),marker='Bearer CRMARKER-'+'c'.repeat(32),before=await f.rows();
 const response=await f.handler(request('/api/v1/loop-providers/offers/'+encodeURIComponent(marker)));
 assert.equal(response.status,400,'S3 offer model text must use the shared secret boundary');
 assert.deepEqual(await response.json(),{error:'invalid_request'});
 assert.deepEqual(await f.rows(),before);
});


test('S4 Start wire admits explicit route and positive cap; legacy body stays readable',async()=>{
 const {loopBridgeBodiesV1,loopBridgeBindingSchemaV1}=await import('../src/improve-control-room/v1/schemas');
 const legacy={expectedVersion:1,expectedRevision:0,runLinkId:'link:fixture'};
 const route={providerId:'provider-one',model:'synthetic/model'};
 assert.equal(loopBridgeBodiesV1.start.safeParse(legacy).success,true);
 assert.equal(loopBridgeBodiesV1.start.safeParse({...legacy,route}).success,true,'new subscription Start has its own route');
 assert.equal(loopBridgeBodiesV1.start.safeParse({...legacy,route,paid:{optIn:true,capNanoUsd:'1'}}).success,true);
 for(const bad of [{route:null},{paid:{optIn:true,capNanoUsd:'1'}},{route,paid:null},...['0','01','-1','1.5','1e3','1'.repeat(31)].map(capNanoUsd=>({route,paid:{optIn:true,capNanoUsd}})),{route,paid:{optIn:false,capNanoUsd:'1'}},{route:{...route,servedModelId:'forged'}}])
  assert.equal(loopBridgeBodiesV1.start.safeParse({...legacy,...bad}).success,false,JSON.stringify(bad));
 const binding={schemaVersion:1,body:legacy,localVersion:1,adapterId:'adapter:test',loopRunId:'run:test',toolingRevision:'sha256:'+'a'.repeat(64),a2SchemaVersion:1,schemaDigest:'sha256:'+'b'.repeat(64),requestSha256:'c'.repeat(64),settingsSha256:'d'.repeat(64),runLinkId:'link:fixture',authorizationId:null,inputVersion:null,expectedRevision:0,evidence:null};
 assert.equal(loopBridgeBindingSchemaV1.safeParse(binding).success,true);
 assert.equal(loopBridgeBindingSchemaV1.safeParse({...binding,paidPin:null}).success,false);
});

import { ImproveControlRoomDeskServiceV1 } from '../src/improve-control-room/v1/service';
import { ImproveControlRoomLoopServiceV1 } from '../src/web/v1/improve-control-room-loop-service';
import { createImproveControlRoomHttpHandlerV1 } from '../src/web/v1/improve-control-room-http';
import { loopImprovementRunIdentitySchemaV1,loopImprovementObservationSchemaV1,type LoopBridgeBindingV1 } from '../src/improve-control-room/v1/schemas';
import { loopByteHashV1,type LoopAdapterV1,type LoopEngineStatusV1,type LoopProviderRouteResolutionV1 } from '../src/web/v1/improve-control-room-loop-adapter';
const S4_ROUTE={providerId:'provider-two',model:'synthetic/model'};
async function realS4Routes(t:TestContext, snapshot:import('../src/web/v1/improve-control-room-loop-adapter').LoopProviderSnapshotV1) {
 const {mkdir,mkdtemp,copyFile,writeFile,rm}=await import('node:fs/promises');
 const {realpathSync}=await import('node:fs');
 const {resolve,join,dirname}=await import('node:path');
 const {pathToFileURL}=await import('node:url');
 const {createImproveControlRoomLoopAdapterV1}=await import('../src/web/v1/improve-control-room-loop-adapter');
 const loop=process.env.CONTROL_ROOM_A2_TEST_LOOP;
 assert.ok(loop,'real S4 resolver requires the pinned tools checkout');
 const root=await mkdtemp(resolve('.test-tmp/s4-real-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['tools/loop/bridge','config','runs','work','product'])await mkdir(join(root,dir),{recursive:true});
 const files=['bridge/selection-schema.json','bridge/a2-contract.mjs','bridge/cr-entry.py','bridge/provider-routes.py','run_settings.py','lineup.py','selection_contract.py'];
 for(const file of files)await copyFile(join(loop,file),join(root,'tools/loop',file));
 const shim=await readFile(join(dirname(loop),'bin/lib/python.sh'),'utf8');
 const pinned=/CR_PYTHON=(\S+)/.exec(shim);assert.ok(pinned);
 const interpreter=realpathSync(pinned[1]!.replace(/^["']|["']$/g,''));
 const manifest=(await Promise.all(files.map(async file=>`${loopByteHashV1(await readFile(join(root,'tools/loop',file)))}  tools/loop/${file}\n`))).join('');
 await writeFile(join(root,'config/manifest.sha256'),manifest);
 const toolingRevision=`sha256:${loopByteHashV1(manifest)}`;
 const slot=(model:string,effort='high')=>({model,route:'codex',effort});
 const settingsText=JSON.stringify({schema_version:1,plan_review_count:3,spec_review_count:3,code_review_count:3,project:{repository:join(root,'product'),base:'main',host_adapter:'local-loop'},
  roles:{plan:slot(S4_ROUTE.model),spec:slot(S4_ROUTE.model),build:slot(S4_ROUTE.model),final:slot(S4_ROUTE.model),orchestrator:slot(S4_ROUTE.model),
   plan_reviews:[slot('reviewer','low'),slot('reviewer','medium'),slot('reviewer','high')],
   spec_reviews:[slot('reviewer','low'),slot('reviewer','medium'),slot('reviewer','high')],
   code_reviews:[slot('reviewer','low'),slot('reviewer','medium'),slot('reviewer','high')],
   risk_reviews:[{...slot('reviewer'),role:'attack-review'},{...slot('reviewer'),role:'ui-review'},{...slot('reviewer'),role:'ci-review'}]},providerRoute:S4_ROUTE});
 await writeFile(join(root,'config/settings.json'),settingsText);await writeFile(join(root,'config/availability.json'),'{}');
 const rosterText='name\tlauncher\tprovider\tfamily\tclass\troles\tefforts\tdefault_effort\tcost\ton\tnote\n'+
  [[S4_ROUTE.model,'execution-two'],['reviewer','execution-extra']].map(([model,execution])=>[model,'codex',execution,'fixture-family','frontier',
   'plan,spec,build,final,plan-review,spec-review,code-review,attack-review,ui-review,ci-review','low,medium,high','medium','sub','on','SYNTHETIC'].join('\t')).join('\n')+'\n';
 // Independent executable identity bindings, never taken from saved providerRoute.
 const bindings=[{model:S4_ROUTE.model,route:'codex',provider:'execution-two',providerId:'provider-two'},
  {model:'reviewer',route:'codex',provider:'execution-extra',providerId:'provider-extra'}];
 const seen:unknown[]=[],captured=structuredClone(snapshot);
 const configuration={adapterId:'adapter:s4-real',interpreter,interpreterSha256:loopByteHashV1(await readFile(interpreter)),
  entrypoint:join(root,'tools/loop/bridge/cr-entry.py'),entrypointSha256:loopByteHashV1(await readFile(join(root,'tools/loop/bridge/cr-entry.py'))),
  toolingManifest:join(root,'config/manifest.sha256'),toolingRevision,configRoot:root,runRoot:join(root,'runs'),workRoot:join(root,'work'),cwd:join(root,'product'),
  settingsFile:join(root,'config/settings.json'),settingsSha256:loopByteHashV1(settingsText),availabilityFile:join(root,'config/availability.json'),availabilitySha256:loopByteHashV1('{}'),
  executionIdentity:{uid:process.getuid!(),isolationEvidenceDigest:'sha256:'+'b'.repeat(64)}};
 const module=await import(pathToFileURL(join(root,'tools/loop/bridge/a2-contract.mjs')).href);
 const lineage={toolingRevision,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),matchesSavedInput:()=>false};
 const contract=module.a2BridgeContractV1(lineage,{providerRoutes:{configuration,expectedTenantId:scope.tenantId,capture:async()=>({
  tenantId:captured.tenantId,rosterText,repositoryRoot:join(root,'product'),outputRoot:join(root,'work'),skillsRoot:join(root,'work'),
  resolvePair:async(identity:{model:string;route:string;provider:string})=>{
   seen.push(identity);assert.deepEqual(Object.keys(identity).sort(),['model','provider','route']);
   const matches=bindings.filter(row=>row.model===identity.model&&row.route===identity.route&&row.provider===identity.provider);
   assert.equal(matches.length,1);const binding=matches[0]!;
   const provider=captured.providers.find(p=>p.provider_id===binding.providerId);
   assert.ok(provider?.models.some(m=>m.roster_name===identity.model&&m.launcher===identity.route));
   return {providerId:binding.providerId,model:identity.model};
  }})}});
 const adapter=createImproveControlRoomLoopAdapterV1({...configuration,contract});t.after(()=>adapter.close());
 assert.equal(adapter.providerRoutes?.paidExecutionReady,false);
 assert.deepEqual(await adapter.providerRoutes!.resolveStartRoute(settingsText),{...S4_ROUTE,additionalRoutes:[{providerId:'provider-extra',model:'reviewer'}]},'actual resolver must succeed before admission refusal probes');
 seen.length=0;
 return {settingsText,routes:adapter.providerRoutes!,seen};
}
async function admissionFixture(t:TestContext,options:{billing?:'subscription'|'token';ready?:boolean;capability?:boolean;additional?:{providerId:string;model:string}[];real?:boolean;storedSettings?:Record<string,unknown>;presence?:{availability:(id:string)=>Promise<'available'|'unavailable'>}}={}){
 const f=await fixture(t,options.presence),integrityKey=new Uint8Array(32).fill(64),calls:LoopBridgeBindingV1[]=[],resolutions:string[]=[];
 let settingsText=JSON.stringify({...options.storedSettings,providerRoute:S4_ROUTE,lineup:{build:{model:'synthetic/model',effort:'high'},review:[{model:'synthetic/model',effort:'low'}]}});
 for(const [i,id] of ['provider-one','provider-two','provider-extra'].entries())await f.service.upsert(f.identity,id,{expectedVersion:i,provider:provider({provider_id:id,billing_kind:id==='provider-two'?(options.billing??'subscription'):'subscription',models:[{...provider().models[0]!,served_model_id:`served/${id}`}]})},key());
 let real:Awaited<ReturnType<typeof realS4Routes>>|undefined;
 if(options.real){
  await f.db.query("UPDATE control_loop_roster_models SET launcher='codex'");
  await f.db.query(`INSERT INTO control_loop_roster_models SELECT tenant_id,'reviewer',2,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at FROM control_loop_roster_models WHERE name=$1`,[S4_ROUTE.model]);
  await f.db.query("UPDATE control_loop_provider_models SET launcher='codex'");
  await f.db.query(`UPDATE control_loop_providers SET secret_ref='{"kind":"launcher","launcher":"codex"}'::jsonb`);
  await f.db.query("INSERT INTO control_loop_provider_models SELECT tenant_id,provider_id,'reviewer',launcher,'served/reviewer' FROM control_loop_provider_models WHERE provider_id='provider-extra'");
  real=await realS4Routes(t,await f.service.view(f.identity));settingsText=real.settingsText;
 }
 const toolingRevision=sha256Digest({fixture:'S4 recorded'}),run={adapterId:'adapter:s4',loopRunId:'run:s4',toolingRevision,a2SchemaVersion:1 as const},description='Recorded provider admission';
 const contract={toolingRevision,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),
  matchesSavedInput:(_run:unknown,observation:{settingsDigest:string},input:{settingsText:string})=>observation.settingsDigest===loopByteHashV1(input.settingsText)};
 let status:LoopEngineStatusV1={run,revision:4,inputVersion:1,state:'ready',description,settingsSha256:loopByteHashV1(settingsText),settingsDigest:loopByteHashV1(settingsText),
  confirmation:{path:'request.md',sha256:loopByteHashV1(description),at:new Date(now).toISOString(),who:'owner',input_version:1},approval:null,question:null,progress:{step:'plan',completed:0,attention:'none'},receipts:[]};
 let resolution:LoopProviderRouteResolutionV1={...S4_ROUTE,additionalRoutes:options.additional??[]};
 let resolverHook:()=>Promise<void>=async()=>{};
 const unused=async():Promise<never>=>{throw new Error('unexpected recorded operation');};
 const adapter:LoopAdapterV1={adapterId:run.adapterId,toolingRevision,schemaDigest:sha256Digest({fixture:'S4 schema'}),settingsText,contract,reserveRun:()=>run.loopRunId,available:()=>true,
  ...(options.capability===false?{}:{providerRoutes:{paidExecutionReady:options.ready??false,resolveStartRoute:async text=>{resolutions.push(text);await resolverHook();if(real)resolution=await real.routes.resolveStartRoute(text);return structuredClone(resolution);}}}),
  status:async()=>structuredClone(status),start:async(id,b,fence,settings,admitted)=>{
   fence();assert.equal(settings,settingsText);assert.deepEqual(admitted,{settingsSha256:loopByteHashV1(settingsText),routes:resolution,...(b.paidPin?{paidPin:b.paidPin}:{})});calls.push(b);
   status={...status,state:'running',revision:5,receipts:[{commandId:id,bindingDigest:sha256Digest(b),state:'accepted',evidenceDigest:sha256Digest({id}),error:null}]};return structuredClone(status);
  },intake:unused,confirmRequest:unused,stop:unused,approve:unused,answer:unused,close:async()=>{}};
 await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`,[f.project.projectId]);
 const desk=new ImproveControlRoomDeskServiceV1(f.client,scope,integrityKey,undefined,()=>now,contract);
 const draft=await desk.saveLoopDraft(f.identity,f.project.projectId,{description,settingsText},key());
 const linked=await desk.recordLoopRunLink({projectId:f.project.projectId,requestId:draft.request.requestId,initialInputVersion:1,run});
 await desk.authorizeLoopStart(f.identity,f.project.projectId,{requestId:draft.request.requestId,expectedVersion:1,runLinkId:linked.runLink.runLinkId,requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1(settingsText)},key(),{inputVersion:1,settingsDigest:status.settingsDigest,revision:4,confirmation:status.confirmation!});
 const bridge=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey,adapter,providers:f.service},()=>now);
 const handler=createImproveControlRoomHttpHandlerV1({origin,trust,loopBridge:bridge,clock:()=>now});
 const body={expectedVersion:1,expectedRevision:4,runLinkId:linked.runLink.runLinkId,route:S4_ROUTE};
 const start=(input:unknown=body,k=key())=>handler(request(`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/improvements/loop/${encodeURIComponent(draft.request.requestId)}/start`,'POST',input,k));
 const commands=async()=>(await f.db.query<{binding:LoopBridgeBindingV1;entry_kind:string}>('SELECT * FROM control_loop_improvement_commands ORDER BY entry_kind')).rows;
 const price=()=>f.db.query(`INSERT INTO control_loop_provider_prices(tenant_id,provider_id,model,window_key,"window",input_nano_usd_per_token,output_nano_usd_per_token,currency,status,reason,checked_at)
  VALUES('tenant:web','provider-two','served/provider-two','all',NULL,'2','3','USD','known','',$1)`,[new Date(now).toISOString()]);
 return {...f,adapter,body,start,commands,calls,resolutions,price,settingsText,real,setResolution:(r:LoopProviderRouteResolutionV1)=>{resolution=r;},setResolverHook:(hook:()=>Promise<void>)=>{resolverHook=hook;}};
}
test('S4 new route-less Start is refused before claim and dispatch',async t=>{
 const f=await admissionFixture(t);const {route,...legacy}=f.body;
 assert.equal((await f.start(legacy)).status,400);assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
});
test('S4 resolved and saved route mismatches and missing capability refuse before claim',async t=>{
 for(const kind of ['body','resolved','missing'] as const){await t.test(kind,async t=>{
  const f=await admissionFixture(t,{capability:kind!=='missing'});
  if(kind==='resolved')f.setResolution({providerId:'provider-one',model:'synthetic/model',additionalRoutes:[]});
  const response=await f.start(kind==='body'?{...f.body,route:{providerId:'provider-one',model:'synthetic/model'}}:f.body);
  assert.equal(response.status,kind==='missing'?503:409);assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
 });}
});
test('S4 subscription distinct free reviewers start without token prices or paid readiness',async t=>{
 const f=await admissionFixture(t,{additional:[{providerId:'provider-extra',model:'synthetic/model'}]});
 assert.equal((await f.start()).status,202);assert.equal(f.calls.length,1);assert.equal(Object.hasOwn(f.calls[0]!,'paidPin'),false);
 assert.equal((await f.commands()).length,2);assert.deepEqual(f.resolutions,[f.settingsText]);
});
test('S4 stored paid keys never substitute for per-run Start consent', async t => {
  for (const billing of ['subscription', 'token'] as const) await t.test(billing, async t => {
    const f = await admissionFixture(t, { billing, ready: true, storedSettings: {
      paid: { optIn: true, capNanoUsd: '100' }, nested: { paidPin: null }, array: [{ paid: false }],
    } });
    await f.price();
    assert.equal((await f.start()).status, billing === 'token' ? 409 : 202,
      'stored keys neither brick subscription Start nor authorize token Start');
    if (billing === 'token') {
      assert.deepEqual(await f.commands(), []);
      assert.deepEqual(f.calls, []);
    } else {
      assert.equal(f.calls.length, 1);
      assert.equal(Object.hasOwn(f.calls[0]!, 'paidPin'), false);
      assert.equal(Object.hasOwn(f.calls[0]!.body, 'paid'), false);
    }
  });
});
test('S4 token consent price and readiness guards leave no claims',async t=>{
 for(const kind of ['no-consent','subscription-paid','unknown','stale','non-usd','disabled'] as const)await t.test(kind,async t=>{
  const f=await admissionFixture(t,{billing:kind==='subscription-paid'?'subscription':'token',ready:kind!=='disabled'});
  if(!['unknown','subscription-paid'].includes(kind))await f.price();
  if(kind==='stale')await f.db.query("UPDATE control_loop_provider_prices SET checked_at=$1",[new Date(now-25*3600_000).toISOString()]);
  if(kind==='non-usd')await f.db.query("UPDATE control_loop_provider_prices SET status='not_comparable',currency='EUR',input_nano_usd_per_token=NULL,output_nano_usd_per_token=NULL");
  const input=kind==='no-consent'?f.body:{...f.body,paid:{optIn:true,capNanoUsd:'100'}};
  assert.equal((await f.start(input)).status,kind==='disabled'?503:409);assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
 });
});
test('S4 additional token mapping refuses both free and paid routed lineups',async t=>{
 for(const billing of ['subscription','token'] as const)await t.test(billing,async t=>{
  const f=await admissionFixture(t,{billing,ready:true,additional:[{providerId:'provider-extra',model:'synthetic/model'}]});
  await f.db.query("UPDATE control_loop_providers SET billing_kind='token' WHERE provider_id='provider-extra'");await f.price();
  assert.equal((await f.start(billing==='token'?{...f.body,paid:{optIn:true,capNanoUsd:'100'}}:f.body)).status,503);
  assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
 });
});
test('S4 stand-in paid claim pins chosen served model and exact cap replay',async t=>{
 const f=await admissionFixture(t,{billing:'token',ready:true,additional:[{providerId:'provider-extra',model:'synthetic/model'}]});await f.price();
 const input={...f.body,paid:{optIn:true,capNanoUsd:'100'}},k=key();
 const first=await f.start(input,k);assert.equal(first.status,202);assert.equal((await first.json()).state,'accepted');
 const rows=await f.commands();assert.equal(rows.length,2);
 const {providerPriceDigestV1}=await import('../src/web/v1/loop-provider-prices');
 const expected={...S4_ROUTE,servedModelId:'served/provider-two',providerVersion:3,capNanoUsd:'100',priceRowDigest:providerPriceDigestV1({providerId:'provider-two',model:'served/provider-two',windowKey:'all',window:null,input:'2',output:'3',currency:'USD',status:'known',reason:'',checkedAt:new Date(now).toISOString()})};
 for(const row of rows)assert.deepEqual(row.binding.paidPin,expected);
 assert.equal((await f.start(input,k)).status,200);assert.equal(f.calls.length,1);
 assert.equal((await f.start({...input,paid:{optIn:true,capNanoUsd:'101'}},k)).status,409);assert.deepEqual(await f.commands(),rows);
});


test('S4 admission route normalization uses the real resolver ordinal ordering',async()=>{
 const {normalizeLoopProviderRoutesV1}=await import('../src/web/v1/improve-control-room-loop-adapter');
 const result=normalizeLoopProviderRoutesV1({...S4_ROUTE,additionalRoutes:[
  {providerId:'alpha_one',model:'reviewer'}, {providerId:'alpha0one',model:'reviewer'},
  {providerId:'alpha_one',model:'reviewer'}, S4_ROUTE,
 ]});
 assert.deepEqual(result.additionalRoutes,[{providerId:'alpha0one',model:'reviewer'},{providerId:'alpha_one',model:'reviewer'}],
  'service admission copy must retain F10c ordinal ordering');
});


test('S4 real F10c whole lineup reaches subscription Start with all reviewer roles and no paid pin',async t=>{
 if(!process.env.CONTROL_ROOM_A2_TEST_LOOP){t.skip('counted real-tools gate requires pinned checkout');return;}
 const f=await admissionFixture(t,{real:true});
 assert.equal((await f.start()).status,202,'real whole-lineup resolver must admit the actual saved chosen provider');
 assert.equal(f.calls.length,1);assert.equal(Object.hasOwn(f.calls[0]!,'paidPin'),false);
 assert.equal(f.adapter.providerRoutes?.paidExecutionReady,false);
 assert.deepEqual(f.real!.seen,[{model:S4_ROUTE.model,route:'codex',provider:'execution-two'},{model:'reviewer',route:'codex',provider:'execution-extra'}]);
 const saved=JSON.parse(f.settingsText);
 for(const role of ['plan_reviews','spec_reviews','code_reviews'])assert.equal(saved.roles[role].length,3);
 assert.deepEqual(saved.roles.code_reviews.map((slot:{effort:string})=>slot.effort),['low','medium','high']);
 assert.equal((await f.commands()).length,2);
});

test('S4 real F10c hidden token reviewer refuses before claim',async t=>{
 if(!process.env.CONTROL_ROOM_A2_TEST_LOOP){t.skip('counted real-tools gate requires pinned checkout');return;}
 const f=await admissionFixture(t,{real:true});
 await f.db.query("UPDATE control_loop_providers SET billing_kind='token' WHERE provider_id='provider-extra'");
 assert.equal((await f.start()).status,503);assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
});


test('S4 missing token-route secret returns the shared 422 secret_missing refusal before claim',async t=>{
 let probes=0;
 const f=await admissionFixture(t,{billing:'token',presence:{availability:async()=>{probes++;return 'unavailable';}}});
 await f.price();
 await f.db.query(`UPDATE control_loop_providers SET secret_ref='{"kind":"macos_keychain","service":"control-room.provider","account":"provider-two"}'::jsonb WHERE provider_id='provider-two'`);
 const response=await f.start({...f.body,paid:{optIn:true,capNanoUsd:'100'}});
 assert.equal(probes,1,'only recorded presence is checked; no credential bytes are read');
 assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
 assert.equal(response.status,422,'new token Start must preserve the shared secret_missing refusal contract');
 assert.deepEqual(await response.json(),{error:'provider_refused',reason:'secret_missing',message:'Secret unavailable'});
});

test('S4 Start handler exposes a typed missing-secret refusal as 422',async()=>{
 const {LoopProviderRefusedV1}=await import('../src/web/v1/loop-provider-service');
 const unused=async():Promise<never>=>{throw new Error('unused fixture operation');};
 const handler=createImproveControlRoomHttpHandlerV1({origin,trust,clock:()=>now,loopBridge:{
  mutate:async()=>{throw new LoopProviderRefusedV1('secret_missing');},status:unused,viewDesk:unused,readApprovalDocument:unused,
 }});
 const response=await handler(request('/api/v1/projects/project:fixture/improvements/loop/request:fixture/start','POST',
  {expectedVersion:1,expectedRevision:1,runLinkId:'link:fixture',route:S4_ROUTE},key()));
 assert.equal(response.status,422,'the real Start handler must preserve the existing provider refusal');
 assert.deepEqual(await response.json(),{error:'provider_refused',reason:'secret_missing',message:'Secret unavailable'});
});

for(const reason of ['base_url','price_source_url','roster_mismatch'] as const)test(`S4 Start handler preserves typed provider refusal ${reason}`,async()=>{
 const {LoopProviderRefusedV1}=await import('../src/web/v1/loop-provider-service');
 const unused=async():Promise<never>=>{throw new Error('unused fixture operation');};
 const handler=createImproveControlRoomHttpHandlerV1({origin,trust,clock:()=>now,loopBridge:{
  mutate:async()=>{throw new LoopProviderRefusedV1(reason);},status:unused,viewDesk:unused,readApprovalDocument:unused,
 }});
 const response=await handler(request('/api/v1/projects/project:fixture/improvements/loop/request:fixture/start','POST',
  {expectedVersion:1,expectedRevision:1,runLinkId:'link:fixture',route:S4_ROUTE},key()));
 assert.equal(response.status,422);
 assert.deepEqual(await response.json(),{error:'provider_refused',reason,message:'Provider unavailable'});
 // The lead allowance is Start only: an unrelated operation retains its existing failure mapping.
 const other=await handler(request('/api/v1/projects/project:fixture/improvements/loop/request:fixture/confirm','POST',{},key()));
 assert.equal(other.status,503);
 assert.deepEqual(await other.json(),{error:'service_unavailable'});
});
test('S4 unresolved Bitwarden Start secret is the same neutral refusal without a probe or claim',async t=>{
 let probes=0;
 const f=await admissionFixture(t,{billing:'token',presence:{availability:async()=>{probes++;return 'available';}}});
 await f.price();
 await f.db.query(`UPDATE control_loop_providers SET secret_ref='{"kind":"bitwarden","item":"recorded-unresolved-reference"}'::jsonb WHERE provider_id='provider-two'`);
 const response=await f.start({...f.body,paid:{optIn:true,capNanoUsd:'100'}});
 assert.equal(probes,0);assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
 assert.equal(response.status,422);
 assert.deepEqual(await response.json(),{error:'provider_refused',reason:'secret_missing',message:'Secret unavailable'});
});

test('S4 Start rechecks the probed reference and provider version before claiming',async t=>{
 let changed=false,probes=0;
 const f=await admissionFixture(t,{billing:'token',ready:true,presence:{availability:async()=>{
  probes++;
  await f.db.query(`UPDATE control_loop_providers SET secret_ref='{"kind":"launcher","launcher":"synthetic-api"}'::jsonb WHERE provider_id='provider-two'`);
  await f.db.query('UPDATE control_loop_provider_state SET version=version+1');changed=true;return 'available';
 }}});
 await f.price();
 await f.db.query(`UPDATE control_loop_providers SET secret_ref='{"kind":"macos_keychain","service":"control-room.provider","account":"provider-two"}'::jsonb WHERE provider_id='provider-two'`);
 assert.equal((await f.start({...f.body,paid:{optIn:true,capNanoUsd:'100'}})).status,409);
 assert.equal(probes,1);assert.equal(changed,true);assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
});
test('S4 a browser cannot submit a served-model pin as paid authority',async t=>{
 const f=await admissionFixture(t,{billing:'token',ready:true});await f.price();
 const response=await f.start({...f.body,paid:{optIn:true,capNanoUsd:'100'},paidPin:{...S4_ROUTE,servedModelId:'served/forged',providerVersion:3,priceRowDigest:'sha256:'+'a'.repeat(64),capNanoUsd:'100'}});
 assert.equal(response.status,400);assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
});

test('S4 forged served-model snapshot refuses against the admission mapping before claim',async t=>{
 const f=await admissionFixture(t,{billing:'token',ready:true});await f.price();
 const preflight=f.service.preflightStartMappingV1.bind(f.service);
 t.mock.method(f.service,'preflightStartMappingV1',async(...args:Parameters<typeof preflight>)=>({...await preflight(...args),servedModelId:'served/forged'}));
 const response=await f.start({...f.body,paid:{optIn:true,capNanoUsd:'100'}});
 assert.equal(response.status,409);assert.deepEqual(await f.commands(),[]);assert.deepEqual(f.calls,[]);
});
