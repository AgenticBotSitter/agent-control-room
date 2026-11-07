import { LoopSelectionServiceV1 } from "../src/web/v1/loop-selection-service";
import { createLoopSelectionHttpHandlerV1 } from "../src/web/v1/loop-selection-http";
import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalNodeHandler, createPrivateNodeHandler, createLocalSetupNodeHandler } from "../src/web/v1/private-node-handler";
import { createLoopPolicyHttpHandlerV1 } from "../src/web/v1/loop-policy-http";
import { LoopPolicyServiceV1 } from "../src/web/v1/loop-policy-service";
import { LOCAL_OWNER_SESSION_PROFILE_V1, LocalOwnerSessionServiceV1 } from "../src/web/v1/local-owner-session";
import { sha256Digest } from "../src/security";
import { taskFixture } from "./helpers/web-task";
import { nodeExchange } from "./helpers/web-node";
import { now, origin as privateOrigin, token, trust } from "./helpers/web-foundation";

for (const mode of ['private', 'Mac-local'] as const) {
  test(`P71 ${mode} Node PUT persists and replays project and selection through authenticated policy handler`, async t => {
    const f = await taskFixture(); t.after(() => f.db.close());
    await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
    const origin = mode === 'private' ? privateOrigin : 'http://127.0.0.1:54321';
    let checks = 0, calls = 0;
    const service = new LoopPolicyServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
      { settingsText: '{}', checkSettings: async () => { checks++; return { eligible: true, reasons: [] }; } }, () => now);
    const ownerCode = 'synthetic-policy-owner-code-0001';
    const local = mode === 'Mac-local' ? new LocalOwnerSessionServiceV1({ schema: LOCAL_OWNER_SESSION_PROFILE_V1,
      origin, tenantId: 'tenant:web', provider: trust.issuer, subject: 'test-owner', ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 }) : undefined;
    const cookie = local ? (await local.issue(new Request(`${origin}/api/v1/local-owner-session`,
      { method: 'POST', headers: { origin } }), ownerCode, now)).cookie.split(';')[0]! : undefined;
    const policy = createLoopPolicyHttpHandlerV1({ origin, service, clock: () => now,
      ...(local ? { localOwnerSession: local } : { trust }) });
    const transport = (mode === 'private' ? createPrivateNodeHandler : createMacLocalNodeHandler)({ origin,
      application: { isReady: () => true, close: async () => {} }, assets: { count: 0, digest: "fixture", respond: () => undefined },
      handler: request => { calls++; return policy(request); } });
    const exchange = async (path: string, body: unknown, key: string, options: { anonymous?: boolean; foreign?: boolean } = {}) => {
      const text = JSON.stringify(body);
      const headers = ['Origin', options.foreign ? 'https://foreign.example.invalid' : origin, 'Content-Type', 'application/json',
        'Content-Length', String(Buffer.byteLength(text)), 'Idempotency-Key', key];
      if (!options.anonymous) headers.push(...(cookie ? ['Cookie', cookie] : ['Cf-Access-Jwt-Assertion', token()]));
      const e = nodeExchange({ method: 'PUT', path, body: text, headers }); e.input.rawHeaders[1] = new URL(origin).host;
      try { await transport.handle(e.input, e.output); return { status: e.output.statusCode, body: e.body() }; }
      finally { e.input.destroy(); e.output.destroy(); }
    };
    const base = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/loop-policy`;
    try {
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 0, settings: '{}' }, 'p72-node-missing-locks-0001')).status, 400);
      assert.equal(checks, 0, 'missing lockedPaths refuses before check or persistence');
      assert.equal((await f.db.query('SELECT * FROM control_loop_policy_events')).rows.length, 0);
      for (const layer of ['project', 'selection'] as const) {
        const body = { expectedVersion: 0, settings: JSON.stringify({ fixture: layer }), ...(layer === 'project' ? { lockedPaths: [] } : {}) }, key = `p71-node-${layer}-key-0001`;
        const first = await exchange(`${base}/${layer}`, body, key);
        assert.equal(first.status, 201, `${mode} ${layer} PUT reaches actual policy handler`);
        assert.deepEqual(JSON.parse(first.body), { replayed: false, version: 1 });
        const replay = await exchange(`${base}/${layer}`, body, key); assert.equal(replay.status, 200);
        assert.deepEqual(JSON.parse(replay.body), { replayed: true, version: 1 });
      }
      const identity = local ? local.verify(new Request(origin, { headers: { cookie: cookie! } }), now) : f.identity;
      assert.deepEqual(await service.view(identity, f.project.projectId), { project: { version: 1, settingsText: '{"fixture":"project"}', lockedPaths: [] }, selection: { version: 1, settingsText: '{"fixture":"selection"}' } });
      const rows = async () => ({ layers: (await f.db.query('SELECT * FROM control_loop_policy_layers ORDER BY layer')).rows,
        events: (await f.db.query('SELECT * FROM control_loop_policy_events ORDER BY layer')).rows });
      const saved = await rows(); assert.equal(saved.layers.length, 2); assert.equal(saved.events.length, 2); assert.equal(checks, 2);
      for (const [index, layer] of ['project', 'selection'].entries()) {
        const row = saved.layers[index] as Record<string, unknown>, event = saved.events[index] as Record<string, unknown>;
        assert.equal(row.layer, layer); assert.equal(Number(row.version), 1);
        assert.equal(row.settings_text, JSON.stringify({ fixture: layer }));
        assert.equal(row.settings_sha256, sha256Digest({ fixture: layer }).slice('sha256:'.length));
        assert.equal(event.layer, layer); assert.equal(Number(event.version), 1); assert.equal(event.before_sha256, null);
        assert.equal(event.after_sha256, row.settings_sha256);
      }
      for (const path of [`${base}/other`, `${base}/project/`, `${base}/selection?x=1`, `${base}/project/extra`,
        '/api/v1/loop-providers/fixture/extra', '/api/v1/loop-providers/UPPER', '/api/v1/loop-providers/ab',
        '/api/v1/loop-providers/fixture/', '/api/v1/loop-providers/fixture?x=1', '/api/v1/unrelated']) {
        const before = calls;
        assert.equal((await exchange(path, {}, 'p71-node-neighbour-0001')).status, 405, path); assert.equal(calls, before);
      }
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 1, settings: '{}', lockedPaths: [] }, 'p71-node-anonymous-0001', { anonymous: true })).status, 401);
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 1, settings: '{}', lockedPaths: [] }, 'p71-node-foreign-0001', { foreign: true })).status, 403);
      await f.db.query("UPDATE control_role_grants SET role_key='operator'");
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 1, settings: '{}', lockedPaths: [] }, 'p71-node-operator-0001')).status, 403);
      await f.db.query("UPDATE control_role_grants SET role_key='owner'");
      const before = calls;
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 1, settings: 'x'.repeat(8200), lockedPaths: [] }, 'p71-node-oversize-0001')).status, 413);
      assert.equal(calls, before); assert.equal(checks, 2); assert.deepEqual(await rows(), saved);
    } finally { await transport.close(); }
  });

  test(`P71 ${mode} Node admits only bounded provider PUT and retains existing edit routes`, async () => {
    const origin = mode === 'private' ? privateOrigin : 'http://127.0.0.1:54321'; let calls = 0;
    const transport = (mode === 'private' ? createPrivateNodeHandler : createMacLocalNodeHandler)({ origin,
      application: { isReady: () => true, close: async () => {} }, assets: { count: 0, digest: "fixture", respond: () => undefined },
      handler: async request => { calls++; assert.deepEqual(await request.json(), { expectedVersion: 0 }); return Response.json({ ok: true }); } });
    try {
      for (const path of ['/api/v1/loop-providers/fixture-provider', '/api/v1/projects/fixture/skills/item', '/api/v1/projects/fixture/recurring-rules/item']) {
        const body = JSON.stringify({ expectedVersion: 0 });
        const e = nodeExchange({ path, method: 'PUT', body, headers: ['Origin', origin, 'Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body))] });
        e.input.rawHeaders[1] = new URL(origin).host;
        try { await transport.handle(e.input, e.output); assert.equal(e.output.statusCode, 200, path); }
        finally { e.input.destroy(); e.output.destroy(); }
      }
      assert.equal(calls, 3);
    } finally { await transport.close(); }
  });
}

test('P71 read-only setup transport continues to refuse policy and provider PUT', async () => {
  let calls = 0;
  const transport = createLocalSetupNodeHandler({ origin: 'http://127.0.0.1:3000',
    isReady: () => true, close: async () => {}, assets: { count: 0, digest: "fixture", respond: () => undefined },
    planSource: { read: async () => ({ schema: "control-room.local-setup-journal-source/v1", status: "unavailable", performsEffect: false, permitsRetry: false }) },
    renderSetupPage: () => { calls++; return new Response('unexpected'); } });
  try {
    for (const path of ['/api/v1/loop-providers/fixture-provider', '/api/v1/projects/fixture/loop-policy/project']) {
      const e = nodeExchange({ path, method: 'PUT' }); e.input.rawHeaders[1] = '127.0.0.1:3000';
      try { await transport.handle(e.input, e.output); assert.equal(e.output.statusCode, 405); }
      finally { e.input.destroy(); e.output.destroy(); }
    }
    assert.equal(calls, 0);
  } finally { await transport.close(); }
});

for (const mode of ['private', 'Mac-local'] as const) {
  test(`U81 T13-project ${mode} preview uses actual no-listener Node transport and refuses unsafe requests`, async t => {
    const f = await taskFixture(); t.after(() => f.db.close());
    await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
    await f.db.query(`UPDATE control_role_grants SET allowed_actions='["loop_selection.read"]'::jsonb`);
    const origin = mode === 'private' ? privateOrigin : 'http://127.0.0.1:54321';
    const policy = new LoopPolicyServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' }, { settingsText: '{}' }, () => now);
    const service = new LoopSelectionServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' }, policy, undefined, () => now);
    const ownerCode = 'synthetic-selection-owner-code-0001';
    const local = mode === 'Mac-local' ? new LocalOwnerSessionServiceV1({ schema: LOCAL_OWNER_SESSION_PROFILE_V1,
      origin, tenantId: 'tenant:web', provider: trust.issuer, subject: 'test-owner', ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 }) : undefined;
    const cookie = local ? (await local.issue(new Request(`${origin}/api/v1/local-owner-session`,
      { method: 'POST', headers: { origin } }), ownerCode, now)).cookie.split(';')[0]! : undefined;
    const handler = createLoopSelectionHttpHandlerV1({ origin, service, clock: () => now, ...(local ? { localOwnerSession: local } : { trust }) });
    let calls = 0;
    const transport = (mode === 'private' ? createPrivateNodeHandler : createMacLocalNodeHandler)({ origin,
      application: { isReady: () => true, close: async () => {} }, assets: { count: 0, digest: 'fixture', respond: () => undefined },
      handler: req => { calls++; return handler(req); } });
    const path = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/loop-selection/preview`;
    const slot = { model: 'fixture-model', route: 'fixture-launcher', effort: 'default' };
    const body = { selection: { roles: { plan: slot, spec: slot, build: slot, final: slot, plan_reviews: [], spec_reviews: [], code_reviews: [slot] },
      plan_review_count: 0, spec_review_count: 0, code_review_count: 1 }, overrides: { reviewFamily: false, standardFinal: false } };
    const exchange = async (options: { method?: string; path?: string; origin?: string; contentType?: string; anonymous?: boolean; text?: string } = {}) => {
      const text = options.text ?? JSON.stringify(body), headers = ['Origin', options.origin ?? origin, 'Content-Type', options.contentType ?? 'application/json',
        'Content-Length', String(Buffer.byteLength(text))];
      if (!options.anonymous) headers.push(...(cookie ? ['Cookie', cookie] : ['Cf-Access-Jwt-Assertion', token()]));
      const e = nodeExchange({ method: options.method ?? 'POST', path: options.path ?? path, body: text, headers });
      e.input.rawHeaders[1] = new URL(origin).host;
      try { await transport.handle(e.input, e.output); return { status: e.output.statusCode, body: e.body() }; }
      finally { e.input.destroy(); e.output.destroy(); }
    };
    try {
      const first = await exchange(); assert.equal(first.status, 200);
      assert.deepEqual(JSON.parse(first.body), { available: false, reason: { code: 'selection_snapshot_unavailable', explanation: 'The selection snapshot is unavailable.' } });
      assert.equal((await exchange({ origin: 'https://foreign.example.invalid' })).status, 403);
      assert.equal((await exchange({ anonymous: true })).status, 401);
      assert.equal((await exchange({ contentType: 'text/plain' })).status, 400);
      assert.equal((await exchange({ path: `${path}?x=1` })).status, 400);
      assert.equal((await exchange({ method: 'PUT' })).status, 405);
      assert.equal((await exchange({ method: 'DELETE' })).status, mode === 'private' ? 405 : 400);
      assert.equal((await exchange({ text: '{"selection":{},"selection":{}}' })).status, 400);
      const before = calls;
      assert.equal((await exchange({ text: JSON.stringify({ large: 'x'.repeat(8200) }) })).status, 413);
      assert.equal(calls, before, 'outer budget rejects before the service');
      for (const table of ['control_loop_policy_layers', 'control_loop_policy_events', 'control_loop_policy_input_sources',
        'control_loop_improvement_requests', 'control_loop_improvement_commands']) assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0);
    } finally { await transport.close(); }
  });
}

import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createLoopSelectionSourceFilesV1 } from '../src/web/v1/loop-selection-snapshot';
import { selectionSnapshotFromBundleV1 } from '../src/web/v1/loop-selection-snapshot-wire';
import { createMacLocalWebProcessV1 } from '../src/web/v1/mac-local-web-process';
import { createPrivateWebProcess } from '../src/web/v1/private-process';
import type { LoopAdapterV1 } from '../src/web/v1/improve-control-room-loop-adapter';
import { loopImprovementRunIdentitySchemaV1,loopImprovementObservationSchemaV1 } from '../src/improve-control-room/v1/schemas';

for(const mode of ['private','Mac-local'] as const)test(`T-SNAPSHOT ${mode} process keeps synchronous construction and awaits real source startup`,async t=>{
  const f=await taskFixture();t.after(()=>f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`,[f.project.projectId]);
  await mkdir(resolve('.test-tmp'),{recursive:true});const root=await mkdtemp(resolve('.test-tmp/snapshot-process-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'config'),{mode:0o700});await mkdir(join(root,'roster'),{mode:0o700});
  const roster='name\tlauncher\tprovider\tfamily\tclass\troles\tefforts\tdefault_effort\tcost\ton\tnote\tnick\tmax_build_grade\n'
    +'fixture\tfixture\tfixture\tfixture\tfrontier\tbuild,final\tmedium\tmedium\tsub\ton\tfixture\tF\tHard\n';
  const exportPath=join(root,'roster/roster-export.tsv');await writeFile(exportPath,roster,{mode:0o600});
  const health={schema_version:1 as const,checked_at:new Date(now).toISOString(),entries:[{model:'fixture',route:'fixture',available:true}]};
  await writeFile(join(root,'config/availability.json'),JSON.stringify(health),{mode:0o600});
  const sources=createLoopSelectionSourceFilesV1({availabilityFile:join(root,'config/availability.json'),rosterFile:exportPath,readAvailability:()=>health});
  let entered!:()=>void,release!:()=>void,checks=0;
  const reached=new Promise<void>(r=>{entered=r;}),barrier=new Promise<void>(r=>{release=r;});
  const toolingRevision='sha256:'+'a'.repeat(64),unexpected=async():Promise<never>=>{throw Error('unexpected dispatch');};
  const adapter:LoopAdapterV1={adapterId:'adapter:fixture',toolingRevision,schemaDigest:'sha256:'+'b'.repeat(64),settingsText:'{}',selectionSources:sources,
    available:()=>false,reserveRun:()=>{throw Error('unexpected reserve');},
    contract:{toolingRevision,decodeRunIdentity:v=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:v=>loopImprovementObservationSchemaV1.parse(v),matchesSavedInput:()=>false},
    roster:{rosterRoot:join(root,'roster'),toolsSeed:exportPath,check:async()=>{entered();await barrier;return {exitCode:0,lines:[]};}},
    checkSettings:async(text)=>{
      checks++;const lease=sources.acquire();let snapshot;try{snapshot=selectionSnapshotFromBundleV1(sources.current(lease,now));}finally{lease.release();}
      const roles=JSON.parse(text).roles,lineup=(['plan','spec','build','code_reviews','final'] as const).map(role=>{
        const v=role==='code_reviews'?roles[role][0]:roles[role];
        const requested={model:v.model,route:v.route,effort:v.effort,family:'fixture',class:'frontier',cost:'subscription' as const};
        return {role,index:0,requested,effective:requested,refusals:[],fallback:false};});
      return {eligible:true,reasons:[],snapshot,projection:{family_policy:'review-only',lineup,reservedFinal:lineup[4]!.effective,waivedReasons:[],
        rosterDigest:snapshot.rosterDigest,availabilityDigest:snapshot.availabilityDigest,lineupDigest:'c'.repeat(64)}};
    },intake:unexpected,confirmRequest:unexpected,start:unexpected,status:unexpected,stop:unexpected,approve:unexpected,answer:unexpected,close:async()=>{}};
  const origin=mode==='private'?privateOrigin:'http://127.0.0.1:54321',ownerCode='snapshot-owner-code-0001';
  const app=mode==='private'?createPrivateWebProcess({origin,issuer:trust.issuer,audience:trust.audience,...{tenantId:'tenant:web',workspaceId:'workspace:web'},
    maxSessionSeconds:trust.maxSessionSeconds,loadKeys:async()=>trust.keys,database:{client:f.client,close:async()=>{}},clock:()=>now,loopBridge:{integrityKey:new Uint8Array(32).fill(65),adapter}})
    :createMacLocalWebProcessV1({origin,workspaceId:'workspace:web',database:{client:f.client,close:async()=>{},isAvailable:()=>true},clock:()=>now,
      localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin,tenantId:'tenant:web',provider:trust.issuer,subject:'test-owner',ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900},
      loopBridge:{integrityKey:new Uint8Array(32).fill(65),adapter}});
  assert.equal(typeof app.handle,'function','constructors remain synchronous');t.after(async()=>{release();await app.close();});
  let cookie:string|undefined;
  if(mode==='Mac-local'){
    const response=await app.handle(new Request(origin+'/api/v1/local-owner-session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({ownerCode})}),()=>new Response('shell'));
    cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  }
  await reached;
  const slot={model:'fixture',route:'fixture',effort:'medium'},selection={roles:{plan:slot,spec:slot,build:slot,code_reviews:[slot],final:slot,plan_reviews:[],spec_reviews:[]},plan_review_count:0,spec_review_count:0,code_review_count:1};
  let finished=false;
  const response=app.handle(new Request(`${origin}/api/v1/projects/${f.project.projectId}/loop-selection/preview`,{method:'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{'cf-access-jwt-assertion':token()})},body:JSON.stringify({selection})}),()=>new Response('shell')).then(r=>{finished=true;return r;});
  await new Promise(r=>setTimeout(r,20));assert.equal(finished,false);assert.equal(checks,0);release();
  const result=await response;assert.equal(result.status,200);assert.equal((await result.json()).available,true);assert.equal(checks,1);
});

import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { composeLoopSettingsV1 } from '../src/web/v1/loop-policy-compose';
import { LoopProviderServiceV1 } from '../src/web/v1/loop-provider-service';
import { LoopSelectionSnapshotCoordinatorV1 } from '../src/web/v1/loop-selection-snapshot';
import type { LoopBridgeBindingV1 } from '../src/improve-control-room/v1/schemas';
const factoryHash = (text:string) => createHash('sha256').update(text).digest('hex');

/** Real application/authentication/SQL with a recording engine; no worker or provider launch. */
async function admissionFactory(t:TestContext, mode:'private'|'Mac-local', source:'absent'|'pending'|'failed'|'unseeded'|'export-failed'|'ready'='absent') {
  const start=performance.now(),clock=()=>now+Math.floor(performance.now()-start);
  const f=await taskFixture(clock);t.after(()=>f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`,[f.project.projectId]);
  await mkdir(resolve('.test-tmp'),{recursive:true});
  const root=await mkdtemp(resolve('.test-tmp/u81-factory-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'roster'),{mode:0o700});await mkdir(join(root,'config'),{mode:0o700});
  const roster='name\tlauncher\tprovider\tfamily\tclass\troles\tefforts\tdefault_effort\tcost\ton\tnote\tnick\tmax_build_grade\n'
    +'fixture\tfixture\tfixture\tfixture\tfrontier\tplan,spec,build,review,final\tmedium\tmedium\tsub\ton\tfixture\tF\tHard\n';
  const exportPath=join(root,'roster/roster-export.tsv');await writeFile(exportPath,roster,{mode:0o600});
  const health={schema_version:1 as const,checked_at:new Date(now).toISOString(),entries:[{model:'fixture',route:'fixture',available:true}]};
  await writeFile(join(root,'config/availability.json'),JSON.stringify(health),{mode:0o600});
  let captures=0,assertions=0;
  const originalCapture=LoopSelectionSnapshotCoordinatorV1.prototype.capture,originalAssert=LoopSelectionSnapshotCoordinatorV1.prototype.assertCurrent;
  t.mock.method(LoopSelectionSnapshotCoordinatorV1.prototype,'capture',async function(this:LoopSelectionSnapshotCoordinatorV1){captures++;return originalCapture.call(this);});
  t.mock.method(LoopSelectionSnapshotCoordinatorV1.prototype,'assertCurrent',async function(this:LoopSelectionSnapshotCoordinatorV1,...args:Parameters<typeof originalAssert>){assertions++;return originalAssert.apply(this,args);});
  let files=source==='absent'?undefined:createLoopSelectionSourceFilesV1({availabilityFile:join(root,'config/availability.json'),rosterFile:exportPath,readAvailability:()=>health});
  if(source==='failed') files={...files!,initialize(){throw Error('synthetic source startup failure');}};
  if(source==='unseeded') await rm(exportPath);
  let release!:()=>void,entered!:()=>void;
  const pending=new Promise<void>(r=>{release=r;}),reached=new Promise<void>(r=>{entered=r;});
  const checks:{text:string;context:unknown}[]=[],dispatches:{text:string;binding:LoopBridgeBindingV1;capsule:unknown}[]=[];
  let current:Awaited<ReturnType<LoopAdapterV1['status']>>,serial=0;
  const toolingRevision='sha256:'+'a'.repeat(64),adapterId='adapter:fixture';
  const slot={model:'fixture',route:'fixture',effort:'medium'},selection={roles:{plan:slot,spec:slot,build:slot,final:slot,plan_reviews:[],spec_reviews:[],code_reviews:[slot]},plan_review_count:0,spec_review_count:0,code_review_count:1};
  const route={providerId:'fixture-provider',model:'fixture'};
  const settingsText=composeLoopSettingsV1({defaultsText:JSON.stringify(selection)}).text;
  const receipt=(commandId:string,binding:LoopBridgeBindingV1)=>({commandId,bindingDigest:sha256Digest(binding),state:'accepted' as const,error:null,evidenceDigest:sha256Digest({commandId})});
  const next=(state:'ready'|'running',commandId:string,b:LoopBridgeBindingV1,fence:()=>void,text:string,capsule:unknown)=>{
    fence();dispatches.push({text,binding:b,capsule});current.state=state;current.revision++;
    if(state==='ready')current.confirmation={path:'request.md',sha256:b.requestSha256,who:'owner',at:new Date(clock()).toISOString(),input_version:current.inputVersion};
    current.receipts.push(receipt(commandId,b));return structuredClone(current);
  };
  const unexpected=async():Promise<never>=>{throw Error('unexpected worker operation');};
  const adapter:LoopAdapterV1={adapterId,toolingRevision,schemaDigest:'sha256:'+'b'.repeat(64),settingsText,selectionSources:files,
    available:()=>true,reserveRun:()=>`fixture-factory-${++serial}`,
    contract:{toolingRevision,decodeRunIdentity:v=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:v=>loopImprovementObservationSchemaV1.parse(v),
      matchesSavedInput:(_r,o,i)=>o.settingsDigest===i.settingsSha256&&o.confirmation.sha256===i.requestSha256},
    roster:{rosterRoot:join(root,'roster'),toolsSeed:exportPath,check:async()=>{entered();if(source==='pending')await pending;if(source==='export-failed')throw Error('synthetic export failure');return {exitCode:0,lines:[]};}},
    providerRoutes:{paidExecutionReady:false,resolveStartRoute:async()=>({providerId:route.providerId,model:route.model,additionalRoutes:[]})},
    checkSettings:async(text,context)=>{
      checks.push({text,context});if(!context)return {eligible:true,reasons:[]};
      const lease=files!.acquire();let snapshot;try{snapshot=selectionSnapshotFromBundleV1(files!.current(lease,clock()));}finally{lease.release();}
      const roles=JSON.parse(text).roles,lineup=(['plan','spec','build','code_reviews','final'] as const).map(role=>{
        const v=role==='code_reviews'?roles[role][0]:roles[role],requested={...v,family:'fixture',class:'frontier',cost:'subscription' as const};
        return {role,index:0,requested,effective:requested,refusals:[],fallback:false};});
      return {eligible:true,reasons:[],snapshot,projection:{family_policy:'review-only',lineup,reservedFinal:lineup[4]!.effective,waivedReasons:[],rosterDigest:snapshot.rosterDigest,availabilityDigest:snapshot.availabilityDigest,lineupDigest:'c'.repeat(64)}};
    },
    intake:async(id,b,description,fence,text='{}',capsule)=>{
      fence();dispatches.push({text,binding:b,capsule});current={run:{adapterId,toolingRevision,loopRunId:b.loopRunId,a2SchemaVersion:1},revision:1,inputVersion:1,state:'draft',description,
        settingsSha256:factoryHash(text),settingsDigest:factoryHash(text),confirmation:null,approval:null,question:null,progress:{step:'intake',completed:0,attention:'none'},receipts:[receipt(id,b)]};return structuredClone(current);
    },confirmRequest:async(id,b,fence,text,capsule)=>next('ready',id,b,fence,text!,capsule),
    start:async(id,b,fence,text,_admission,capsule)=>next('running',id,b,fence,text!,capsule),status:async()=>structuredClone(current),stop:unexpected,approve:unexpected,answer:unexpected,close:async()=>{}};
  const origin=mode==='private'?privateOrigin:'http://127.0.0.1:54321',ownerCode='synthetic-factory-owner-code-0001';
  const app=mode==='private'?createPrivateWebProcess({origin,issuer:trust.issuer,audience:trust.audience,tenantId:'tenant:web',workspaceId:'workspace:web',maxSessionSeconds:trust.maxSessionSeconds,
    loadKeys:async()=>trust.keys,database:{client:f.client,close:async()=>{}},clock,loopBridge:{integrityKey:new Uint8Array(32).fill(65),adapter}})
    :createMacLocalWebProcessV1({origin,workspaceId:'workspace:web',database:{client:f.client,close:async()=>{},isAvailable:()=>true},clock,
      localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin,tenantId:'tenant:web',provider:trust.issuer,subject:'test-owner',ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900},
      loopBridge:{integrityKey:new Uint8Array(32).fill(65),adapter}});
  t.after(async()=>{release();await app.close();});
  let cookie:string|undefined;
  if(mode==='Mac-local'){
    const login=await app.handle(new Request(origin+'/api/v1/local-owner-session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({ownerCode})}),()=>new Response('shell'));
    assert.equal(login.status,201);cookie=login.headers.get('set-cookie')!.split(';')[0];
  }
  const headers={origin,'content-type':'application/json',...(cookie?{cookie}:{'cf-access-jwt-assertion':token()})};
  const base=`/api/v1/projects/${f.project.projectId}/improvements/loop`;
  const send=async(path:string,body?:unknown,key='u81-factory-command-0001')=>app.handle(new Request(origin+base+'/'+path,{method:body===undefined?'GET':'POST',headers:{...headers,'idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}),()=>new Response('shell'));
  // A preview waits for startup; a pending startup is deliberately not awaited.
  if(source==='pending') await reached;
  else if(source!=='absent') await app.handle(new Request(origin+`/api/v1/projects/${f.project.projectId}/loop-selection/preview`,{method:'POST',headers,body:JSON.stringify({selection})}),()=>new Response('shell'));
  else { // Roster startup without sources still provides the legacy provider mapping.
    for(let i=0;i<100;i++){if((await f.db.query('SELECT * FROM control_loop_roster_state')).rows.length)break;await new Promise(r=>setTimeout(r,5));}
  }
  const rows=async()=>Promise.all(['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_policy_input_sources','control_loop_improvement_commands','control_loop_improvement_authorizations'].map(async table=>(await f.db.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows));
  return {...f,app,adapter,send,checks,dispatches,settingsText,selection,route,rows,release,get current(){return current;},get captures(){return captures;},get assertions(){return assertions;}};
}

for(const mode of ['private','Mac-local'] as const){
  test(`U81-B D29 ${mode} factory preserves native intake and refuses unguarded B8`,async t=>{
    for(const source of ['absent','pending','failed','unseeded','export-failed','ready'] as const)await t.test(source,async t=>{
      const f=await admissionFactory(t,mode,source),body={description:'Recorded factory request'};
      const native=await f.send('intake',body,'u81-factory-native-intake-0001');assert.equal(native.status,202,await native.text());
      assert.equal(f.checks.at(-1)!.context,undefined);assert.equal(f.dispatches.at(-1)!.capsule,undefined);
      const sources=(await f.db.query('SELECT admission_kind FROM control_loop_policy_input_admissions')).rows;
      assert.deepEqual(sources,[{admission_kind:'native-p71'}]);
      const before=await f.rows(),dispatches=f.dispatches.length,captures=f.captures;
      const b8=await f.send('selection-intake',body,'u81-factory-b8-intake-0001');
      if(source==='ready'){
        assert.equal(b8.status,202,await b8.text());assert.ok(f.dispatches.at(-1)!.capsule,'raw coordinator reaches bounded locked commit');
        assert.equal((f.checks.at(-1)!.context as {mode:string}).mode,'admission');assert.ok(f.assertions>0,'raw coordinator assertion reached');
      }else{
        assert.equal(b8.status,503,await b8.text());assert.deepEqual(await f.rows(),before,'unready B8 has zero additional writes');assert.equal(f.dispatches.length,dispatches);assert.equal(f.captures,captures,'unready B8 must refuse before capture');
      }
    });
  });
  test(`U81-B D29 ${mode} legacy structured dispatch residual`,async t=>{
    const f=await admissionFactory(t,mode),scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
    const providers=new LoopProviderServiceV1(f.client,scope,undefined,()=>now);
    await providers.upsert(f.identity,'fixture-provider',{expectedVersion:0,provider:{provider_id:'fixture-provider',display_name:'Recorded provider',base_url:'https://example.com/api',billing_kind:'subscription',secret_ref:{kind:'launcher',launcher:'fixture'},
      models:[{roster_name:'fixture',launcher:'fixture',served_model_id:'served/fixture'}],credit_amount_nano_usd:null,credit_expires_on:null,credit_note:'',price_source_url:null,price_source_format:null}},'u81-factory-provider-0001');
    const edits=JSON.stringify({...f.selection,providerRoute:f.route}),body={description:'Recorded structured native request',settingsEdits:edits};
    const expected=composeLoopSettingsV1({defaultsText:f.settingsText,runEdits:JSON.stringify({...f.selection,providerRoute:f.route,overrides:{reviewFamily:false,standardFinal:false}})}).text;
    const native=await f.send('intake',body,'u81-factory-residual-intake-0001');assert.equal(native.status,202,await native.clone().text());const r=await native.json();
    const confirm=await f.send(r.requestId+'/confirm',{expectedVersion:1,expectedRevision:1,requestSha256:factoryHash(body.description),settingsSha256:factoryHash(expected)},'u81-factory-residual-confirm-0001');assert.equal(confirm.status,202,await confirm.text());
    const status=await (await f.send(r.requestId+'/status')).json();
    const start=await f.send(r.requestId+'/start',{expectedVersion:1,expectedRevision:f.current.revision,runLinkId:status.request.runLink.runLinkId,route:f.route},'u81-factory-residual-start-0001');assert.equal(start.status,202,await start.text());
    assert.equal(f.dispatches.length,3);for(const dispatch of f.dispatches){assert.equal(dispatch.text,expected);assert.equal(dispatch.binding.settingsSha256,factoryHash(expected));assert.equal(dispatch.capsule,undefined,'native dispatch carries no selection expectation');}
    assert.ok(f.checks.length>0);assert.ok(f.checks.every(c=>c.context===undefined));
    assert.deepEqual((await f.db.query('SELECT admission_kind FROM control_loop_policy_input_admissions')).rows,[{admission_kind:'native-p71'}]);
    const before=await f.rows();const b8=await f.send('selection-intake',body,'u81-factory-residual-b8-0001');assert.equal(b8.status,503);assert.deepEqual(await f.rows(),before);assert.equal(f.dispatches.length,3);
  });
}
