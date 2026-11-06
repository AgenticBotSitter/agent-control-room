import { S4_FIXTURE_ROUTE, s4FixtureRoutes, s4ProviderServiceV1, seedS4ProviderV1 } from './helpers/improve-control-room-loop-recovery';
import { LoopRosterServiceV1 } from "../src/web/v1/loop-roster-service";
import { renderLoopRosterV1 } from "../src/web/v1/loop-roster-render";
import { LoopPolicyServiceV1 } from "../src/web/v1/loop-policy-service";
import { databaseSqlStateV1, type DatabaseClient, type DatabaseSession } from "../src/persistence/database";
import { collectLedgerEntries, ledgerDigest } from "../scripts/generate-migration-ledger.mjs";
import { dirname } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client, Pool } from "pg";
import { withRealPostgres, requiresRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1/service";
import { canonicalJson, sha256Digest, hmacSha256Tag } from "../src/security";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1, type LoopBridgeBindingV1 } from "../src/improve-control-room/v1/schemas";
import { loopByteHashV1, type LoopAdapterV1, type LoopEngineStatusV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { readPrivateWebSchemaDigest, privateWebSchemaDigest, verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import { digestReleaseSchemaRowsV1 } from "../src/updater/v1/pg/release-schema-digest.mjs";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { createImproveControlRoomHttpHandlerV1 } from "../src/web/v1/improve-control-room-http";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

type Pg = Parameters<Parameters<typeof withRealPostgres>[0]>[0];
// Unwind acknowledgement constraints before testing a predecessor and restore them last.
async function selectionDown(pg:Pg) {
  for(const name of ['0317_control_loop_selection_acknowledgement_validate','0316_control_loop_selection_acknowledgement'])
    await sql(pg,await readFile(`db/down/${name}.sql`,'utf8'),[],'migrator');
}
async function selectionUp(pg:Pg) {
  for(const name of ['0316_control_loop_selection_acknowledgement','0317_control_loop_selection_acknowledgement_validate'])
    await sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${await readFile(`db/migrations/${name}.sql`,'utf8')}\nCOMMIT;`,[],'migrator');
  await sql(pg,(await readFile('db/roles/private_web_roles.sql','utf8')).replace(/CREATE ROLE control_room_private_web[^;]+;/,''));
}

// Dedicated 60280..60289 range; no other component/attack-kit suite uses it.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 60280);
const scope={tenantId:"tenant:b1b",workspaceId:"workspace:b1b"}, project="project:b1b",owner="identity:b1b", KEY=new Uint8Array(32).fill(67);
const at=new Date(Date.now()-60000).toISOString(),expires=new Date(Date.now()+3600000).toISOString();
const identity:VerifiedWebIdentity={provider:"test",subject:owner,tokenDigest:sha256Digest({session:"b1b"}),issuedAt:at,expiresAt:expires,verificationExpiresAt:expires};
const settingsText=JSON.stringify({project:{host_adapter:"local-loop"},fixture:"SYNTHETIC",providerRoute:S4_FIXTURE_ROUTE});
async function sql(pg:Pg,query:string,params:unknown[]=[],role="admin",database=pg.database){
  const client=new Client(role==="admin"?pg.admin({database}):pg.connection(role,{database}));await client.connect();
  try{return await client.query(query,params);}finally{await client.end();}
}
async function seed(pg:Pg,database=pg.database,withProviders=true){
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
  if(withProviders)await seedS4ProviderV1({query:async(query,params)=>sql(pg,query,params,"admin",database)},scope);
}
function engine(ready=false){
  const toolingRevision=`sha256:${"a".repeat(64)}`,runs=new Map<string,LoopEngineStatusV1>(),calls:{op:string;id:string}[]=[];
  const contract={toolingRevision,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),
    matchesSavedInput:(_r:unknown,o:{settingsDigest:string;confirmation:{path:string}},input:{settingsText:string})=>o.settingsDigest===loopByteHashV1(input.settingsText)&&o.confirmation.path==="request.md"};
  const apply=async(op:string,id:string,b:LoopBridgeBindingV1,text?:string,signedSettings=settingsText)=>{
    calls.push({op,id});let s=runs.get(b.loopRunId);
    if(op==="intake")s={run:{adapterId:"adapter:synthetic",loopRunId:b.loopRunId,toolingRevision,a2SchemaVersion:1},revision:1,inputVersion:1,state:"draft",description:text!,settingsSha256:loopByteHashV1(signedSettings),settingsDigest:loopByteHashV1(signedSettings),confirmation:null,approval:null,question:null,progress:{step:"intake",completed:0,attention:"none"},receipts:[]};
    assert.ok(s);
    if(op==="confirm"){s.confirmation={path:"request.md",sha256:loopByteHashV1(s.description),who:"owner",at:new Date().toISOString(),input_version:s.inputVersion};s.state="ready";s.revision++;}
    if(op==="start"){s.state="running";s.revision++;}if(op==="stop"){s.state="stopped";s.revision++;}
    if(op==="answer"){s.question=null;s.state="running";s.revision++;}
    if(op==="approve"){s.approval=null;s.state="running";s.revision++;}
    s.receipts.push({commandId:id,bindingDigest:sha256Digest(b),state:"accepted",error:null,evidenceDigest:sha256Digest({op,id})});runs.set(b.loopRunId,s);return structuredClone(s);
  };
  const adapter:LoopAdapterV1={providerRoutes:{...s4FixtureRoutes,paidExecutionReady:ready},adapterId:"adapter:synthetic",toolingRevision,schemaDigest:`sha256:${"b".repeat(64)}`,settingsText,contract,
    checkSettings:async()=>({eligible:true,reasons:[]}),reserveRun:()=>`fixture-run-${randomBytes(16).toString("hex")}`,available:()=>true,
    intake:(id,b,text,_f,signed)=>apply("intake",id,b,text,signed),confirmRequest:(id,b)=>apply("confirm",id,b),start:(id,b)=>apply("start",id,b),stop:(id,b)=>apply("stop",id,b),
    approve:(id,b)=>apply("approve",id,b),answer:(id,b,text)=>apply("answer",id,b,text),status:async run=>{const s=runs.get(run);assert.ok(s);return structuredClone({...s,decisions:{observedAt:new Date().toISOString(),gate:
      ["stopped","finished"].includes(s.state)?null:s.question?{kind:"question",text:"SYNTHETIC saved owner question"}:s.approval?{kind:"approve"}:!s.confirmation?{kind:"confirm"}:null}});},close:async()=>{}};
  return {adapter,calls,runs};
}
function web(pg:Pg,adapter:LoopAdapterV1,database=pg.database){
  const login=pg.connection("web",{database}), config={host:"127.0.0.1",port:pg.port,database,username:login.user,password:login.password,majorVersion:17 as const};
  const bound=bindPrivatePgPool(new Pool({...privatePgOptions(config),host:login.host,max:1}));
  const providers=s4ProviderServiceV1(bound.client,scope);
  const policy=new LoopPolicyServiceV1(bound.client,scope,adapter,Date.now,providers);
  return {...bound,config,policy,bridge:new ImproveControlRoomLoopServiceV1(bound.client,scope,{integrityKey:KEY,adapter,policy,providers}),desk:new ImproveControlRoomDeskServiceV1(bound.client,scope,KEY,undefined,Date.now,adapter.contract)};
}
async function run(work:(pg:Pg)=>Promise<void>){
  assert.ok(requiresRealPostgres(),"B1b deciding tests require PostgreSQL17; never skip");
  const result=await withRealPostgres(work,{port:PORT,allowedPorts:Array.from({length:10},(_,i)=>PORT+i),database:"b1b_bridge",boundMs:500000});
  assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);console.log("B1b PostgreSQL teardown cleanedUp=true leftovers=0");
}
async function confirmed(pg:Pg,e:ReturnType<typeof engine>){
  const w=web(pg,e.adapter);
  const receipt=await w.bridge.mutate(identity,project,null,"intake",{description:"Bounded SYNTHETIC improvement."},"b1b-pg-intake-0001");
  assert.equal(receipt.state,"accepted");const s=await w.bridge.status(identity,project,receipt.requestId);
  const c=await w.bridge.mutate(identity,project,receipt.requestId,"confirm",{expectedVersion:1,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256},"b1b-pg-confirm-0001");
  assert.equal(c.state,"accepted");return {w,id:receipt.requestId,s:await w.bridge.status(identity,project,receipt.requestId)};
}

test("B6 PostgreSQL roster reads bigint positions as numbers and appends max plus one", async t => run(async pg => {
  await seed(pg, pg.database, false);
  const w = web(pg, engine().adapter);
  const root = await mkdtemp(resolve('.test-tmp/b6-native-roster-'));
  const row = { name: 'first', launcher: 'synthetic', provider: '', family: '', class: '', roles: '', efforts: '',
    default_effort: '', cost: '', on: 'on', note: '', nick: '', max_build_grade: '' };
  const service = new LoopRosterServiceV1(w.client, scope, { rosterRoot: root, toolsSeed: join(root, 'seed.tsv'),
    check: async () => ({ exitCode: 0, lines: [] }) });
  try {
    await service.seedFromTsv(renderLoopRosterV1([row, { ...row, name: 'second' }]), 'tools-seed');
    await sql(pg, "UPDATE control_loop_roster_models SET position=CASE name WHEN 'first' THEN 7 ELSE 41 END");
    const positions = (await w.client.query<{ position: string }>(
      'SELECT position FROM control_loop_roster_models ORDER BY position')).rows.map(r => r.position);
    assert.deepEqual(positions, ['7', '41'], 'native pg returns bigint positions as strings');
    // Observe the numeric arithmetic boundary: Math.max alone would silently coerce unconverted int8 strings.
    const max = Math.max;
    let numericReads = 0;
    const spy = t.mock.method(Math, 'max', (...values: number[]) => {
      if (values.length === 3 && values[0] === 0 && values.slice(1).map(Number).join(',') === '7,41') {
        assert.deepEqual(values, [0, 7, 41], 'roster positions must be numbers before arithmetic');
        numericReads++;
      }
      return max(...values);
    });
    try {
      const { name: _name, ...fields } = row;
      assert.equal((await service.upsert(identity, 'third', { expectedVersion: 1, row: fields }, 'b6-native-append-0001')).version, 2);
    } finally { spy.mock.restore(); }
    assert.equal(numericReads, 1, 'the append reads both existing positions numerically');
    assert.deepEqual((await sql(pg, 'SELECT name,position FROM control_loop_roster_models ORDER BY position')).rows,
      [{ name: 'first', position: '7' }, { name: 'second', position: '41' }, { name: 'third', position: '42' }]);
    assert.deepEqual((await service.view(identity)).models.map(model => model.name), ['first', 'second', 'third']);
  } finally { await w.close(); await rm(root, { recursive: true, force: true }); }
}));

test("B1b fresh production login, exact grants, journal and measured digests",async()=>run(async pg=>{
  await seed(pg);const e=engine(),{w,id,s}=await confirmed(pg,e);
  try{
    assert.deepEqual((await w.client.query("SELECT current_user,session_user")).rows,[{current_user:"control_room_web",session_user:"control_room_web"}]);
    const actual=await readPrivateWebSchemaDigest(w.client);
    const updater=digestReleaseSchemaRowsV1((await w.client.query(await readFile("src/updater/v1/pg/release-schema-digest.sql","utf8"))).rows);
    console.log(`B1b measured schema_digest=${actual} updater_digest=${updater}`);
    assert.equal(actual,privateWebSchemaDigest);assert.equal(actual,updater);
    assert.equal(JSON.parse(await readFile("src/updater/v1/policy/release-schema-digest.json","utf8")).digest,actual);
    await verifyPrivateDatabase(w.client,w.config,{...scope,ownerIdentityId:owner,issuer:"test"},Date.now(),{nativeQueue:true});
    const started=await w.bridge.mutate(identity,project,id,"start",{route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},"b1b-pg-start-0001");assert.equal(started.state,"accepted");
    for(const action of ["UPDATE control_loop_improvement_commands SET created_at=created_at","DELETE FROM control_loop_improvement_commands","TRUNCATE control_loop_improvement_commands"])
      await assert.rejects(w.client.query(action),{sqlState:"42501"});
    for(const role of ["app","scheduler","control_room_work_intake_agent","coordinator","results","publisher","queueWorker","intake","news","fleet"])
      await assert.rejects(sql(pg,"SELECT * FROM control_loop_improvement_commands",[],role),{code:"42501"},`B1b unrelated role ${role} cannot read`);
    assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_improvement_commands")).rows[0].n,6);
    for(const table of ["pipeline_runs","control_jobs","control_native_task_queue","control_improvement_requests","control_update_candidates"])
      assert.equal((await sql(pg,`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
    const before=JSON.stringify((await sql(pg,"SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind")).rows);
    await assert.rejects(sql(pg,await readFile("db/down/0302_control_loop_improvement_commands.sql","utf8"),[],"migrator"),/loop improvement commands retained/);
    assert.equal(JSON.stringify((await sql(pg,"SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind")).rows),before);
  }finally{await w.close();}
}));

test("B1b PostgreSQL 24 connections contend on one Start and retry uncertainty",async()=>run(async pg=>{
  await seed(pg);const e=engine(),{w,id,s}=await confirmed(pg,e);await w.close();
  const clients=Array.from({length:24},()=>web(pg,e.adapter));
  let reached=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  const body={route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId};
  try{
    const blocker=new Client(pg.admin());await blocker.connect();
    let results: PromiseSettledResult<Awaited<ReturnType<ImproveControlRoomLoopServiceV1["mutate"]>>>[];
    let observedWaiters=0;
    try {
      await blocker.query("BEGIN");await blocker.query("SELECT id FROM control_identities WHERE id=$1 FOR UPDATE",[owner]);
      const pending=Promise.allSettled(clients.map(async(c,i)=>{reached++;if(reached===24)release();await barrier;
        return c.bridge.mutate(identity,project,id,"start",body,i<12?"b1b-pg-contend-same-0001":`b1b-pg-contend-key-${i}`);}));
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){
        await blocker.query("SELECT pg_stat_clear_snapshot()");
        observedWaiters=Number((await blocker.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%control_identities%'",[pg.database])).rows[0].n);
        if(observedWaiters===24)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      await blocker.query("COMMIT");results=await pending;
      assert.equal(observedWaiters,24,"B1b all 24 independent connections really waited on the admission identity lock");
    }finally{await blocker.end();}
    assert.equal(reached,24);assert.equal(e.calls.filter(c=>c.op==="start").length,1,"B1b PostgreSQL one-dispatch launch count");
    assert.ok(results.some(r=>r.status==="rejected"),"losing independent keys really ran");
    const claims=(await sql(pg,"SELECT command_id,idempotency_key FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows;
    assert.equal(claims.length,1);
    const winner=claims[0]!;
    await clients[0]!.bridge.mutate(identity,project,id,"stop",{runLinkId:s.request.runLink!.runLinkId},"b1b-pg-stop-0001");
    // Only the admitted key is guaranteed an exact replay. A distinct key may
    // beat all twelve shared-key callers to the sole Start claim.
    const retry=await clients[0]!.bridge.mutate(identity,project,id,"start",body,winner.idempotency_key);
    assert.equal(retry.replayed,true);assert.equal(retry.commandId,winner.command_id);assert.equal(retry.state,"accepted");
    await assert.rejects(clients[0]!.bridge.mutate(identity,project,id,"start",body,"b1b-pg-contend-unused-0001"),{code:"conflict"});
    assert.equal(e.calls.filter(c=>c.op==="start").length,1);
    assert.equal(e.runs.get(s.request.runLink!.loopRunId)!.state,"stopped");
    console.log(`B1b barrier callers=24 reached=${reached} rejected=${results.filter(r=>r.status==='rejected').length} observed_waiters=${observedWaiters} starts=1 winner=${winner.idempotency_key} replayed=true stopped=true`);
  }finally{await Promise.all(clients.map(c=>c.close()));}
}));

test("B1b SQL claim uniqueness guard",async()=>run(async pg=>{
  await seed(pg);const e=engine(),{w,id,s}=await confirmed(pg,e);
  try{
    await w.bridge.mutate(identity,project,id,"start",{route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},"b1b-pg-unique-0001");
    const original=(await sql(pg,"SELECT * FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0];
    const row={...original,command_id:`loop-command:${randomBytes(16).toString('hex')}`,idempotency_key:"b1b-pg-unique-0002"};
    const columns=Object.keys(row),values=Object.values(row).map(v=>v&&typeof v==='object'&&!(v instanceof Date)?JSON.stringify(v):v);
    await assert.rejects(sql(pg,`INSERT INTO control_loop_improvement_commands(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,values,"web"),{code:"23505"},"B1b SQL unique Start refusal");
  }finally{await w.close();}
}));

test("B1b empty down/re-up and failed migration roll back atomically",async()=>run(async pg=>{
  const baseline=await readPrivateWebSchemaDigest({query:async(q,p)=>sql(pg,q,p)});
  const down=await readFile("db/down/0302_control_loop_improvement_commands.sql","utf8"),up=await readFile("db/migrations/0302_control_loop_improvement_commands.sql","utf8");
  await selectionDown(pg);
  await sql(pg,await readFile("db/down/0315_control_loop_paid_admission.sql","utf8"),[],"migrator");
  await sql(pg,await readFile("db/down/0314_control_loop_policy_enforcement.sql","utf8"),[],"migrator");
  await sql(pg,await readFile("db/down/0311_control_loop_policy_validate.sql","utf8"),[],"migrator");
  await sql(pg,await readFile("db/down/0310_control_loop_policy.sql","utf8"),[],"migrator");
  await sql(pg,down,[],"migrator");
  assert.equal((await sql(pg,"SELECT to_regclass('control_loop_improvement_commands') AS table")).rows[0].table,null);
  await assert.rejects(sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${up}\nSELECT 1/0;COMMIT;`,[],"migrator"),/division by zero/);
  assert.equal((await sql(pg,"SELECT to_regclass('control_loop_improvement_commands') AS table")).rows[0].table,null);
  await sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${up}\nCOMMIT;`,[],"migrator");
  await sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${await readFile("db/migrations/0310_control_loop_policy.sql","utf8")}\nCOMMIT;`,[],"migrator");
  await sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${await readFile("db/migrations/0311_control_loop_policy_validate.sql","utf8")}\nCOMMIT;`,[],"migrator");
  await sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${await readFile("db/migrations/0314_control_loop_policy_enforcement.sql","utf8")}\nCOMMIT;`,[],"migrator");
  await sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${await readFile("db/migrations/0315_control_loop_paid_admission.sql","utf8")}\nCOMMIT;`,[],"migrator");
  await selectionUp(pg);
  await sql(pg,"GRANT SELECT,INSERT ON control_loop_improvement_commands TO control_room_private_web");
  const roleSql=await readFile("db/roles/private_web_roles.sql","utf8");
  await sql(pg,roleSql.replace(/CREATE ROLE control_room_private_web[^;]+;/,''));
  const after=await readPrivateWebSchemaDigest({query:async(q,p)=>sql(pg,q,p)});assert.equal(after,baseline);
}));

test("B1b 24 independent intake and answer callers consume one target",async()=>run(async pg=>{
  await seed(pg);const e=engine(),clients=Array.from({length:24},()=>web(pg,e.adapter));
  try{
    const intake=await Promise.all(clients.map(c=>c.bridge.mutate(identity,project,null,"intake",{description:"Concurrent SYNTHETIC intake."},"b1b-pg-intake-race-0001")));
    assert.equal(new Set(intake.map(r=>r.requestId)).size,1);assert.equal(e.calls.filter(c=>c.op==="intake").length,1);
    const id=intake[0]!.requestId,s=await clients[0]!.bridge.status(identity,project,id);
    await clients[0]!.bridge.mutate(identity,project,id,"confirm",{expectedVersion:1,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256},"b1b-pg-answer-confirm-0001");
    const state=e.runs.get(s.request.runLink!.loopRunId)!;
    state.state="waiting";state.question={questionId:"question:owner",inputVersion:1,reportSha256:"c".repeat(64),owner:true,changesInput:false};
    const body={expectedVersion:1,expectedRevision:state.revision,questionId:state.question.questionId,inputVersion:1,questionReportSha256:state.question.reportSha256,text:"Keep approved scope."};
    const answers=await Promise.allSettled(clients.map((c,i)=>c.bridge.mutate(identity,project,id,"answer",body,i<12?"b1b-pg-answer-same-0001":`b1b-pg-answer-key-${i}`)));
    assert.equal(e.calls.filter(c=>c.op==="answer").length,1,"B1b one saved owner answer despite contending keys");
    assert.ok(answers.some(r=>r.status==="rejected"));
    assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='answer' AND entry_kind='claim'")).rows[0].n,1);
    console.log(`B1b intake_answer callers=24 intake_roots=1 intake_dispatches=1 answer_claims=1 rejected=${answers.filter(r=>r.status==='rejected').length}`);
  }finally{await Promise.all(clients.map(c=>c.close()));}
}));

test("B1b journal SQL types, body closure and schema-owner append-only refusals",async()=>run(async pg=>{
  await seed(pg);const e=engine(),{w}=await confirmed(pg,e);
  try{
    const original=(await sql(pg,"SELECT * FROM control_loop_improvement_commands WHERE operation='confirm' AND entry_kind='claim'")).rows[0];
    const insert=async(binding:unknown)=>{
      const row={...original,command_id:`loop-command:${randomBytes(16).toString('hex')}`,idempotency_key:`b1b-sql-shape-${randomBytes(8).toString('hex')}`,binding};
      const columns=Object.keys(row),values=Object.entries(row).map(([key,value])=>key==='binding'||key==='result'?value===null?null:JSON.stringify(value):value);
      return sql(pg,`INSERT INTO control_loop_improvement_commands(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,values,'web');
    };
    for(const patch of [{adapterId:123},{requestSha256:123},{schemaVersion:"1"},{localVersion:null},{localVersion:0},{inputVersion:0},{extra:true},
      {body:{...original.binding.body,argv:['escape']}},{body:{...original.binding.body,expectedVersion:"1"}},{body:{...original.binding.body,requestSha256:null}}])
      await assert.rejects(insert({...original.binding,...patch}),{code:'23514'},'B1b SQL closed typed binding refusal');
    for(const statement of ['UPDATE control_loop_improvement_commands SET created_at=created_at','DELETE FROM control_loop_improvement_commands','TRUNCATE control_loop_improvement_commands'])
      await assert.rejects(sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${statement};COMMIT;`,[],'migrator'),/append.only/iu);
    assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_improvement_commands")).rows[0].n,4);
  }finally{await w.close();}
}));

test("B2b attention creator isolation", async()=>run(async pg=>{
  await seed(pg);const e=engine(),w=web(pg,e.adapter);
  try {
    assert.deepEqual((await w.client.query("SELECT current_user,session_user")).rows,[{current_user:"control_room_web",session_user:"control_room_web"}]);
    const ids:string[]=[];
    for(let i=0;i<11;i++){
      const receipt=await w.bridge.mutate(identity,project,null,"intake",{description:`SYNTHETIC saved request ${i}`},`b2b-pg-intake-${String(i).padStart(8,"0")}`);
      assert.equal(receipt.state,"accepted");ids.push(receipt.requestId);
    }
    const foreign="identity:b2b-foreign";
    await sql(pg,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES($1,$2,'human','Other fixture owner','test',$3,'active',$4,$4)`,[foreign,scope.tenantId,sha256Digest({provider:"test",subject:foreign}),at]);
    const addProject=async(id:string,workspace:string,lifecycle:string,self:boolean)=>{
      await sql(pg,`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at) SELECT $1,tenant_id,$2,adapter_id,$1,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,
        jsonb_set(payload,'{presentation,templateId}',to_jsonb($3::text)),updated_at FROM projects WHERE id=$4`,[id,workspace,self?"control-room":"other",project]);
      await sql(pg,"INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES($1,$2,$3,1,now(),now())",[scope.tenantId,id,lifecycle]);
    };
    await sql(pg,"INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:b2b-other',$1,'Other fixture workspace')",[scope.tenantId]);
    await addProject("project:b2b-other-workspace","workspace:b2b-other","active",true);
    await addProject("project:b2b-inactive",scope.workspaceId,"archived",true);
    await addProject("project:b2b-not-self",scope.workspaceId,"active",false);
    const insertRoot=async(id:string,p:string,creator:string,tenant=scope.tenantId)=>{
      const root={tenant_id:tenant,id,project_id:p,owner_identity_id:creator,idempotency_key:`b2b-root:${id}`,created_at:new Date().toISOString()};
      const input={tenant_id:tenant,request_id:id,project_id:p,owner_identity_id:creator,version:1,description:"SYNTHETIC isolated request",settings_text:settingsText,
        request_sha256:loopByteHashV1("SYNTHETIC isolated request"),settings_sha256:loopByteHashV1(settingsText),idempotency_key:`b2b-input:${id}`,created_at:root.created_at};
      await sql(pg,`INSERT INTO control_loop_improvement_requests(tenant_id,id,project_id,owner_identity_id,idempotency_key,created_at,record_digest,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenant,id,p,creator,root.idempotency_key,root.created_at,sha256Digest(root),hmacSha256Tag(KEY,{purpose:"loop-improvement-request/v1",record:root})]);
      await sql(pg,`INSERT INTO control_loop_improvement_inputs(tenant_id,request_id,project_id,owner_identity_id,version,description,settings_text,request_sha256,settings_sha256,idempotency_key,created_at,record_digest,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,Object.values(input).concat([sha256Digest(input),hmacSha256Tag(KEY,{purpose:"loop-improvement-input/v1",record:input})]));
    };
    await insertRoot("request:b2b-foreign",project,foreign);
    await insertRoot("request:b2b-workspace","project:b2b-other-workspace",owner);
    await insertRoot("request:b2b-inactive","project:b2b-inactive",owner);
    await insertRoot("request:b2b-not-self","project:b2b-not-self",owner);
    await sql(pg,"INSERT INTO tenants(id,display_name) VALUES('tenant:b2b-other','Other fixture tenant')");
    await sql(pg,"INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:b2b-tenant','tenant:b2b-other','Other fixture tenant workspace')");
    await sql(pg,`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES('adapter:b2b-other','tenant:b2b-other','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`);
    await sql(pg,`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      SELECT 'project:b2b-tenant','tenant:b2b-other','workspace:b2b-tenant','adapter:b2b-other','project:b2b-tenant',source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at FROM projects WHERE id=$1`,[project]);
    await sql(pg,"INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES('tenant:b2b-other','project:b2b-tenant','active',1,now(),now())");
    await sql(pg,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES('identity:b2b-tenant','tenant:b2b-other','human','Other tenant fixture owner','test',$1,'active',$2,$2)`,[sha256Digest({provider:"test",subject:"identity:b2b-tenant"}),at]);
    await insertRoot("request:b2b-tenant","project:b2b-tenant","identity:b2b-tenant","tenant:b2b-other");
    const rawExpected=(await sql(pg,"SELECT id FROM control_loop_improvement_requests WHERE tenant_id=$1 AND project_id=$2 AND owner_identity_id=$3 ORDER BY created_at DESC,id DESC LIMIT 11",[scope.tenantId,project,owner])).rows.map(r=>r.id);
    const discovered=await w.desk.viewLoopAttentionRequests(identity);
    assert.ok(!discovered.requests.some(r=>r.requestId==="request:b2b-foreign"),"B2b discovery excludes foreign creators before status");
    assert.deepEqual(discovered.requests.map(r=>r.requestId),rawExpected.slice(0,10));assert.equal(discovered.truncated,true);
    const originalStatus=e.adapter.status;let total=0,inflight=0,peak=0;
    e.adapter.status=async run=>{total++;inflight++;peak=Math.max(peak,inflight);try{await new Promise(r=>setTimeout(r,15));return await originalStatus(run);}finally{inflight--;}};
    const tables=["control_loop_improvement_requests","control_loop_improvement_inputs","control_loop_improvement_run_links","control_loop_improvement_authorizations","control_loop_improvement_commands","control_web_sessions"];
    const snapshot=async()=>JSON.stringify(await Promise.all(tables.map(async table=>(await sql(pg,`SELECT * FROM ${table} ORDER BY 1,2`)).rows)));
    let before=await snapshot();const schema=await readPrivateWebSchemaDigest(w.client);
    // All newest ten can be terminal; the older question is uninspected until the terminal-evidence pin exists.
    for(const run of e.runs.values())run.state="finished";
    const older=(await sql(pg,"SELECT loop_run_id FROM control_loop_improvement_run_links WHERE request_id=$1",[rawExpected[10]])).rows[0]!.loop_run_id;
    e.runs.get(older)!.state="waiting";e.runs.get(older)!.question={questionId:"question:older",inputVersion:1,reportSha256:"e".repeat(64),owner:true,changesInput:false};
    const localOrigin="http://127.0.0.1:59369",ownerCode="SYNTHETIC-b2b-owner-code-long";
    const app=createMacLocalWebProcessV1({origin:localOrigin,workspaceId:scope.workspaceId,database:{client:w.client,isAvailable:()=>true,close:async()=>{}},
      localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin:localOrigin,tenantId:scope.tenantId,provider:"test",subject:owner,ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900},loopBridge:{integrityKey:KEY,adapter:e.adapter}});
    const signIn=await app.handle(new Request(localOrigin+"/api/v1/local-owner-session",{method:"POST",headers:{origin:localOrigin,"content-type":"application/json"},body:JSON.stringify({ownerCode})}),()=>new Response("unused"));
    assert.equal(signIn.status,201);const cookie=signIn.headers.get("set-cookie")!;
    // Establish only this disposable local session before the read-only snapshot.
    await app.handle(new Request(localOrigin+`/api/v1/projects/${encodeURIComponent(project)}/improvements/loop/desk`,{headers:{cookie}}),()=>new Response("unused"));
    before=await snapshot();
    let attention: Awaited<ReturnType<ImproveControlRoomLoopServiceV1["readAttention"]>>;
    try{
      const response=await app.handle(new Request(localOrigin+"/api/v1/needs-me/action-items",{headers:{cookie}}),()=>new Response("unused"));
      assert.equal(response.status,200);attention=(await response.json()).loop;
    }finally{await app.close();}
    assert.equal(attention.state,"available");
    if(attention.state==="available"){assert.equal(attention.items.length,0);assert.equal(attention.truncated,true);}
    assert.equal(total,10);assert.ok(peak<=4&&peak>1);assert.equal(inflight,0);
    assert.equal(await snapshot(),before);assert.equal(await readPrivateWebSchemaDigest(w.client),schema);
    // An unlinked root counts once, without a status call, with both nullable bindings.
    const pending=await w.desk.saveLoopDraft(identity,project,{description:"SYNTHETIC pending intake",settingsText},"b2b-pending-intake-0001");
    total=0;const pendingAttention=await w.bridge.readAttention(identity);
    assert.equal(pendingAttention.state,"available");if(pendingAttention.state==="available"){
      const row=pendingAttention.items.find(i=>i.requestId===pending.request.requestId)!;assert.ok(row);assert.equal(row.kind,"blocked");
      assert.equal(row.runLinkId,null);assert.equal(row.engineRevision,null);assert.deepEqual(row.identity,{kind:"blocked",code:"UNAVAILABLE"});
    }
    assert.equal(total,9);
    // Current root signatures are verified; tampering cannot silently hide an eligible root.
    await sql(pg,"ALTER TABLE control_loop_improvement_requests DISABLE TRIGGER USER");
    await sql(pg,"UPDATE control_loop_improvement_requests SET auth_tag=$1 WHERE id=$2",[`hmac-sha256:${"f".repeat(64)}`,pending.request.requestId]);
    await assert.rejects(w.desk.viewLoopAttentionRequests(identity),/integrity/);
    console.log(`B2b PostgreSQL discovery newest=11 returned=10 status_calls=10 peak=${peak} lower_bound=0+ pending_status_calls=9 no_writes=true`);
  }finally{await w.close();}
}));

test("P71 PostgreSQL production grants, immutable sources/audit, copies and retained down",async()=>run(async pg=>{
  await seed(pg);const e=engine(),w=web(pg,e.adapter);
  try{
    assert.equal(await readPrivateWebSchemaDigest(w.client),privateWebSchemaDigest);
    const updater=digestReleaseSchemaRowsV1((await w.client.query(await readFile('src/updater/v1/pg/release-schema-digest.sql','utf8'))).rows);
    assert.equal(updater,privateWebSchemaDigest);
    const tables=['control_loop_policy_layers','control_loop_policy_events','control_loop_policy_input_sources','control_loop_policy_input_admissions'];
    for(const table of tables){
      for(const privilege of ['SELECT','INSERT'])assert.equal((await w.client.query<{yes:boolean}>("SELECT has_table_privilege(current_user,$1,$2) yes",[table,privilege])).rows[0]!.yes,true);
      for(const privilege of ['UPDATE','DELETE','TRUNCATE'])assert.equal((await w.client.query<{yes:boolean}>("SELECT has_table_privilege(current_user,$1,$2) yes",[table,privilege])).rows[0]!.yes,false);
      for(const role of ['control_room_application','control_room_reader','control_room_schedule_admissions','control_room_github_broker','control_room_work_intake','control_room_backup'])
        assert.equal((await sql(pg,"SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') yes",[role,table])).rows[0].yes,false);
    }
    const columns=(await w.client.query<{attname:string}>(`SELECT attname FROM pg_attribute WHERE attrelid='control_loop_policy_layers'::regclass
      AND attnum>0 AND NOT attisdropped AND has_column_privilege(current_user,attrelid,attnum,'UPDATE') ORDER BY attname COLLATE "C"`)).rows.map(r=>r.attname);
    assert.deepEqual(columns,['last_idempotency_key','last_request_digest','locked_paths','settings_sha256','settings_text','updated_at','updated_by','version']);
    const desired=JSON.parse(await readFile('deploy/postgres/desired-grants.json','utf8')).desired as string[];
    const declared=desired.filter(value=>tables.some(table=>value.startsWith(`control_room_private_web|table|public.${table}|`))).sort();
    const observed=[];
    for(const table of tables){
      observed.push(`control_room_private_web|table|public.${table}||SELECT|plain`,`control_room_private_web|table|public.${table}||INSERT|plain`);
      if(table===tables[0])for(const column of columns)observed.push(`control_room_private_web|table|public.${table}|${column}|UPDATE|plain`);
    }
    assert.deepEqual(declared,observed.sort());
    await w.policy.put(identity,project,'project',{lockedPaths:[],expectedVersion:0,settings:'{"fixture":"A"}'},'p71-native-save-a-0001');
    const a=await w.bridge.mutate(identity,project,null,'intake',{description:'Saved A copy'},'p71-native-intake-a-0001');assert.equal(a.state,'accepted');
    const oldInput=(await sql(pg,'SELECT row_to_json(i)::text bytes FROM control_loop_improvement_inputs i WHERE request_id=$1',[a.requestId])).rows;
    await w.policy.put(identity,project,'project',{lockedPaths:[],expectedVersion:1,settings:'{"fixture":"B"}'},'p71-native-save-b-0001');
    const b=await w.bridge.mutate(identity,project,null,'intake',{description:'Saved B copy'},'p71-native-intake-b-0001');assert.equal(b.state,'accepted');
    const aInput=(await sql(pg,'SELECT settings_text FROM control_loop_improvement_inputs WHERE request_id=$1',[a.requestId])).rows[0];
    const bInput=(await sql(pg,'SELECT settings_text FROM control_loop_improvement_inputs WHERE request_id=$1',[b.requestId])).rows[0];
    assert.notEqual(aInput.settings_text,bInput.settings_text);
    const sources=(await sql(pg,'SELECT request_id,layer_versions FROM control_loop_policy_input_sources ORDER BY request_id')).rows;
    assert.equal(sources.find(s=>s.request_id===a.requestId).layer_versions.project,1);
    assert.equal(sources.find(s=>s.request_id===b.requestId).layer_versions.project,2);
    // Restart is a new service and connection; the signed A copy survives current layer B.
    const restarted=web(pg,e.adapter);
    try{
      let s=await restarted.bridge.status(identity,project,a.requestId);
      const current=e.runs.get(s.request.runLink!.loopRunId)!;current.description='Normalized saved A copy';current.inputVersion=2;current.revision++;
      s=await restarted.bridge.status(identity,project,a.requestId);
      const c=await restarted.bridge.mutate(identity,project,a.requestId,'confirm',{expectedVersion:1,expectedRevision:s.engine.revision,
        requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256},'p71-native-confirm-a-0001');assert.equal(c.state,'accepted');
      s=await restarted.bridge.status(identity,project,a.requestId);assert.equal(s.request.currentVersion,2);
      assert.equal((await restarted.bridge.mutate(identity,project,a.requestId,'start',{route:S4_FIXTURE_ROUTE,expectedVersion:2,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},'p71-native-start-a-000001')).state,'accepted');
      const copies=(await sql(pg,'SELECT settings_text FROM control_loop_improvement_inputs WHERE request_id=$1 ORDER BY version',[a.requestId])).rows;
      assert.deepEqual(copies.map(r=>r.settings_text),[aInput.settings_text,aInput.settings_text]);
      const sourceCopies=(await sql(pg,'SELECT defaults_sha256,layer_versions,waiver_id FROM control_loop_policy_input_sources WHERE request_id=$1 ORDER BY input_version',[a.requestId])).rows;
      assert.equal(sourceCopies.length,2);assert.deepEqual(sourceCopies[0],sourceCopies[1]);
      assert.deepEqual((await sql(pg,'SELECT row_to_json(i)::text bytes FROM control_loop_improvement_inputs i WHERE request_id=$1 AND version=1',[a.requestId])).rows,oldInput);
    }finally{await restarted.close();}
    for(const table of tables){
      for(const action of [`DELETE FROM ${table}`,`TRUNCATE ${table}`])await assert.rejects(w.client.query(action),{sqlState:'42501'});
      if(table!==tables[0])for(const action of [`UPDATE ${table} SET tenant_id=tenant_id`,`DELETE FROM ${table}`,`TRUNCATE ${table}`]) {
        const paired=['control_loop_policy_input_sources','control_loop_policy_input_admissions'];
        const companion=paired.find(name=>name!==table)!;
        const trigger=companion==='control_loop_policy_input_sources'?'control_loop_policy_sources_no_truncate':'control_loop_policy_input_admissions_no_truncate';
        const statement=action.startsWith('TRUNCATE')&&paired.includes(table)
          ? `BEGIN; ALTER TABLE ${companion} DISABLE TRIGGER ${trigger}; TRUNCATE ${paired.join(',')}` : action;
        await assert.rejects(sql(pg,statement),{code:'P0001'});
      }

    }
    await assert.rejects(sql(pg,await readFile('db/down/0310_control_loop_policy.sql','utf8'),[],'migrator'),/loop policy retained/);
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_events')).rows[0].n,2);
    assert.equal(await readPrivateWebSchemaDigest(w.client),privateWebSchemaDigest,'refused truncate restored all companion triggers');
    console.log(`P71 PG schema=${privateWebSchemaDigest} exact_ACL=true sources=3 events=2 retained_down=refused old_signed_copy=unchanged`);
  }finally{await w.close();}
}));

function pgPolicy(pg:Pg,adapter:LoopAdapterV1,identityForCall=identity,wrap?:(tx:DatabaseSession)=>DatabaseSession){
  const w=web(pg,adapter);
  const db:DatabaseClient=wrap?{query:w.client.query.bind(w.client),transaction:work=>w.client.transaction(tx=>work(wrap(tx))),
    transactionWithPreCommitCheck:(work,check)=>w.client.transactionWithPreCommitCheck(tx=>work(wrap(tx)),check)}:w.client;
  return{...w,policy:new LoopPolicyServiceV1(db,scope,adapter,Date.now,s4ProviderServiceV1(db,scope)),who:identityForCall};
}
async function secondOwner(pg:Pg){
  const who={...identity,subject:'identity:p71-second',tokenDigest:sha256Digest({session:'p71-second'})};
  await sql(pg,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Second fixture identity','test',$3,'active',$4,$4)`,[who.subject,scope.tenantId,sha256Digest({provider:'test',subject:who.subject}),at]);
  await sql(pg,`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:p71-second',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,[scope.tenantId,who.subject,at]);
  await sql(pg,'INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)',[scope.tenantId,who.tokenDigest,who.subject,at,expires]);
  return who;
}
function checkBarrier(count:number){
  let reached=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  return{check:async()=>{if(++reached===count)release();await gate;return{eligible:true,reasons:[]};},get reached(){return reached;},release};
}

test('P71 PostgreSQL 24 checked writers, replay, distinct-owner mutex and intake drift',async()=>run(async pg=>{
  await seed(pg);const e=engine(),barrier=checkBarrier(24),states:string[]=[];
  const record=(tx:DatabaseSession):DatabaseSession=>({query:async(sql,params)=>{try{return await tx.query(sql,params);}catch(error){const code=databaseSqlStateV1(error);if(code)states.push(code);throw error;}}});
  const adapter={...e.adapter,checkSettings:barrier.check},clients=Array.from({length:24},()=>pgPolicy(pg,adapter,identity,record));
  try{
    const results=await Promise.allSettled(clients.map((w,i)=>w.policy.put(identity,project,'project',{lockedPaths:[],expectedVersion:0,settings:'{"fixture":"one"}'},`p71-native-contend-${String(i).padStart(4,'0')}`)));
    assert.equal(barrier.reached,24,'all 24 checks executed outside the commit transaction');
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    for(const result of results)if(result.status==='rejected')assert.equal(result.reason.code,'conflict');
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_events')).rows[0].n,1);
    const pair=checkBarrier(2),same={...e.adapter,checkSettings:pair.check},a=pgPolicy(pg,same),b=pgPolicy(pg,same);
    try{
      const replays=await Promise.all([a,b].map(w=>w.policy.put(identity,project,'project',{lockedPaths:[],expectedVersion:1,settings:'{"fixture":"two"}'},'p71-native-replay-pair-0001')));
      assert.deepEqual(replays.map(r=>r.replayed).sort(),[false,true]);assert.equal(pair.reached,2);
    }finally{await a.close();await b.close();}
    const who=await secondOwner(pg),first=pgPolicy(pg,e.adapter,identity,record),second=pgPolicy(pg,e.adapter,who,record),blocker=new Client(pg.admin());
    await blocker.connect();
    try{
      const before=Number((await blocker.query('SELECT deadlocks FROM pg_stat_database WHERE datname=$1',[pg.database])).rows[0].deadlocks);
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
      const pairGate=checkBarrier(2);first.policy=new LoopPolicyServiceV1(first.client,scope,{...e.adapter,checkSettings:pairGate.check},Date.now,s4ProviderServiceV1(first.client,scope));
      second.policy=new LoopPolicyServiceV1(second.client,scope,{...e.adapter,checkSettings:pairGate.check},Date.now,s4ProviderServiceV1(second.client,scope));
      const pending=Promise.allSettled([first,second].map((w,i)=>w.policy.put(w.who,project,'selection',{expectedVersion:0,settings:'{}'},`p71-native-owner-first-${i}`)));
      let waiting=0;const until=Date.now()+10000;
      while(Date.now()<until){await blocker.query('SELECT pg_stat_clear_snapshot()');waiting=Number((await blocker.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM projects%FOR UPDATE%';",[pg.database])).rows[0].n);if(waiting===2)break;await new Promise(r=>setTimeout(r,10));}
      await blocker.query('COMMIT');const result=await pending;
      assert.equal(waiting,2,'distinct owners both wait before the initial exclusive project mutex');
      assert.equal(result.filter(r=>r.status==='fulfilled').length,1);for(const r of result)if(r.status==='rejected')assert.equal(r.reason.code,'conflict');
      await blocker.query('SELECT pg_stat_clear_snapshot()');const after=Number((await blocker.query('SELECT deadlocks FROM pg_stat_database WHERE datname=$1',[pg.database])).rows[0].deadlocks);assert.equal(after,before);
      assert.deepEqual(states,[],'raw SQLSTATE recording forbids hidden deadlocks or serialization errors');
      console.log(`P71 contention checks=24 winners=1 losers=23 replay_pair_checks=2 project_waiters=${waiting} SQLSTATEs=${JSON.stringify(states)} deadlock_delta=${after-before}`);
    }finally{await blocker.query('ROLLBACK');await blocker.end();await first.close();await second.close();}
    // A concurrent equal-byte save still changes the version vector. Intake must roll back all copies/claims.
    let entered!:()=>void,release!:()=>void;
    const reached=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    const slow=web(pg,{...e.adapter,checkSettings:async()=>{entered();await gate;return{eligible:true,reasons:[]};}}),writer=web(pg,e.adapter);
    try{
      const pending=slow.bridge.mutate(who,project,null,'intake',{description:'Must not admit stale snapshot'},'p71-native-stale-intake-0001');
      await reached;
      await writer.policy.put(identity,project,'selection',{expectedVersion:1,settings:'{}'},'p71-native-equal-byte-drift-0001');release();
      await assert.rejects(pending,{code:'conflict'});
      for(const table of ['control_loop_improvement_requests','control_loop_policy_input_sources','control_loop_improvement_commands'])
        assert.equal((await sql(pg,`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
    }finally{release();await slow.close();await writer.close();}
  }finally{barrier.release();await Promise.all(clients.map(w=>w.close()));}
}));

test('P71 PostgreSQL dropped commit connection rolls back layer/event and retry succeeds',async()=>run(async pg=>{
  await seed(pg);const e=engine();let interrupted=false,pid=0;
  const w=pgPolicy(pg,e.adapter,identity,tx=>({query:async(statement,params)=>{
    if(statement.includes('UPDATE control_loop_policy_layers')||statement.includes('INSERT INTO control_loop_policy_layers')){
      pid=Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid);
    }
    if(statement.includes('INSERT INTO control_loop_policy_events')&&!interrupted){interrupted=true;await sql(pg,'SELECT pg_terminate_backend($1)',[pid]);}
    return tx.query(statement,params);
  }}));
  const body={lockedPaths:[],expectedVersion:0,settings:'{}'},key='p71-native-interrupted-save-0001';
  try{await assert.rejects(w.policy.put(identity,project,'project',body,key));assert.equal(interrupted,true);
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_layers')).rows[0].n,0);
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_events')).rows[0].n,0);
  }finally{await w.close();}
  const retry=web(pg,e.adapter);
  try{assert.deepEqual(await retry.policy.put(identity,project,'project',body,key),{replayed:false,version:1});
    assert.deepEqual(await retry.policy.put(identity,project,'project',body,key),{replayed:true,version:1});
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_events')).rows[0].n,1);
    console.log('P71 interruption=terminated_checked_out_connection partial_layers=0 partial_events=0 retry_version=1 events=1');
  }finally{await retry.close();}
}));

test('P71 PostgreSQL retained run-edit commands refuse down without changing rows or schema',async()=>run(async pg=>{
  await seed(pg);const e=engine(),w=web(pg,e.adapter),admin=new Client(pg.admin());await admin.connect();
  try{
    const description='Retained edited command';
    const draft=await w.desk.saveLoopDraft(identity,project,{description,settingsText:'{}'},'p71-native-retained-draft-0001');
    const binding={schemaVersion:1,body:{description,settingsEdits:'{}'},localVersion:1,
      adapterId:e.adapter.adapterId,loopRunId:'run:fixture',toolingRevision:e.adapter.toolingRevision,schemaDigest:e.adapter.schemaDigest,
      a2SchemaVersion:1,requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1('{}'),runLinkId:null,
      authorizationId:null,inputVersion:null,expectedRevision:null,evidence:null};
    await admin.query(`INSERT INTO control_loop_improvement_commands
      (tenant_id,command_id,entry_kind,request_id,project_id,owner_identity_id,operation,idempotency_key,binding,record_digest,auth_tag,created_at)
      VALUES($1,$2,'claim',$3,$4,$5,'intake',$6,$7,'sha256:'||repeat('c',64),'hmac-sha256:'||repeat('d',64),now())`,
      [scope.tenantId,'loop-command:'+'1'.repeat(32),draft.request.requestId,project,owner,'p71-native-retained-command-0001',JSON.stringify(binding)]);
    const before=(await admin.query('SELECT * FROM control_loop_improvement_commands')).rows;
    for(const table of ['control_loop_policy_layers','control_loop_policy_events','control_loop_policy_input_sources'])
      assert.equal((await admin.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
    await selectionDown(pg);
    await admin.query(await readFile('db/down/0315_control_loop_paid_admission.sql','utf8'));
    await admin.query(await readFile('db/down/0314_control_loop_policy_enforcement.sql','utf8'));
    await admin.query(await readFile('db/down/0311_control_loop_policy_validate.sql','utf8'));
    const schemaBefore=await readPrivateWebSchemaDigest(admin);
    await assert.rejects(admin.query(await readFile('db/down/0310_control_loop_policy.sql','utf8')),
      {code:'23514',message:'loop policy retained command rows'});
    await admin.query('ROLLBACK');
    assert.deepEqual((await admin.query('SELECT * FROM control_loop_improvement_commands')).rows,before);
    assert.equal(await readPrivateWebSchemaDigest(admin),schemaBefore,'named refusal leaves the entire pre-down schema intact');
    await admin.query(await readFile('db/migrations/0311_control_loop_policy_validate.sql','utf8'));
    await admin.query(await readFile('db/migrations/0314_control_loop_policy_enforcement.sql','utf8'));
    await admin.query(await readFile('db/migrations/0315_control_loop_paid_admission.sql','utf8'));
    await selectionUp(pg);
    assert.equal(await readPrivateWebSchemaDigest(admin),privateWebSchemaDigest,'re-validating P71 restores its release pin after refusal');
    console.log('P71 retained_commands=1 named_down_refusal=23514 rows_unchanged=true schema_unchanged=true P71_pin_restored=true');
  }finally{await admin.end();await w.close();}
}));

test('P71 PostgreSQL empty downgrade restores the merged down-chain schema and re-up preserves ledger after injected failure',async()=>run(async pg=>{
  const admin=new Client(pg.admin());await admin.connect();
  const stage=await mkdtemp(resolve('.test-tmp/p71-ledger-'));
  const validated=async()=>Boolean((await admin.query("SELECT convalidated FROM pg_constraint WHERE conrelid='control_loop_improvement_commands'::regclass AND conname='control_loop_improvement_commands_check1'")).rows[0].convalidated);
  try{
    assert.equal(await validated(),true,'fresh production migration validates the command predicate');
    await selectionDown(pg);
    await admin.query(await readFile('db/down/0313_control_loop_provider_prices.sql','utf8'));
    await admin.query(await readFile('db/down/0312_control_loop_providers.sql','utf8'));
    await admin.query(await readFile('db/down/0315_control_loop_paid_admission.sql','utf8'));
    await admin.query(await readFile('db/down/0314_control_loop_policy_enforcement.sql','utf8'));
    await admin.query(await readFile('db/down/0311_control_loop_policy_validate.sql','utf8'));
    assert.equal(await validated(),false,'validation down restores NOT VALID while preserving the predicate');
    await admin.query(await readFile('db/down/0310_control_loop_policy.sql','utf8'));
    assert.equal(await validated(),true,'0310 down restores the validated pre-P71 predicate');
    // The digest changed because the merged down-chain retains main's 0305/0307/0308 and B7's roster.
    assert.equal(await readPrivateWebSchemaDigest(admin),'2bdb25811bef31d5f9ee8e8a06b49ea2a2a31c476fed8214724d790b57b97386');
    await admin.query("DELETE FROM control_room_schema_migrations WHERE filename LIKE 'db/migrations/0310%' OR filename LIKE 'db/migrations/0311%' OR filename LIKE 'db/migrations/0312%' OR filename LIKE 'db/migrations/0313%' OR filename LIKE 'db/migrations/0314%' OR filename LIKE 'db/migrations/0315%' OR filename LIKE 'db/migrations/0316%' OR filename LIKE 'db/migrations/0317%' OR filename LIKE 'db/roles/%'");
    const before=(await admin.query('SELECT * FROM control_room_schema_migrations ORDER BY ledger_order')).rows;
    for(const entry of await collectLedgerEntries(resolve('.'))){await mkdir(dirname(join(stage,entry.file)),{recursive:true});await writeFile(join(stage,entry.file),await readFile(entry.file));}
    await mkdir(join(stage,'db/setup'),{recursive:true});await writeFile(join(stage,'db/setup/production_migration_ledger.sql'),await readFile('db/setup/production_migration_ledger.sql'));
    await mkdir(join(stage,'deploy/postgres'),{recursive:true});
    const name='db/migrations/0310_control_loop_policy.sql',original=await readFile(name,'utf8');
    await writeFile(join(stage,name),original+'\nSELECT 1/0;\n');
    const ledger=async()=>{const entries=await collectLedgerEntries(stage);await writeFile(join(stage,'deploy/postgres/migration-ledger.json'),JSON.stringify({version:1,entries,digest:ledgerDigest(entries)}));};
    const migrate=()=>applyMigrations({target:undefined,ledgerPath:join(stage,'deploy/postgres/migration-ledger.json'),rootDir:stage,bootstrapTarget:pg.admin(),migrateTarget:pg.connection('migrator'),env:{NODE_ENV:'test',CONTROL_ROOM_MIGRATOR_PASSWORD:pg.connection('migrator').password,CONTROL_ROOM_APP_PASSWORD:pg.connection('app').password,CONTROL_ROOM_SCHEDULER_PASSWORD:pg.connection('scheduler').password,CONTROL_ROOM_WORK_INTAKE_PASSWORD:pg.connection('control_room_work_intake_agent').password}});
    await ledger();await assert.rejects(migrate(),/division by zero/);
    assert.equal((await admin.query("SELECT to_regclass('control_loop_policy_layers') name")).rows[0].name,null);
    assert.deepEqual((await admin.query('SELECT * FROM control_room_schema_migrations ORDER BY ledger_order')).rows,before);
    await writeFile(join(stage,name),original);
    const validationName='db/migrations/0311_control_loop_policy_validate.sql',validationSql=await readFile(validationName,'utf8');
    await writeFile(join(stage,validationName),validationSql+'\nSELECT 1/0;\n');
    await ledger();await assert.rejects(migrate(),/division by zero/);
    assert.equal(await validated(),false,'failed validation migration rolls back its catalog change');
    assert.equal((await admin.query("SELECT count(*)::int n FROM control_room_schema_migrations WHERE filename=$1",[validationName])).rows[0].n,0,'failed validation is absent from the ledger');
    assert.equal((await admin.query('SELECT count(*)::int n FROM control_loop_policy_layers')).rows[0].n,0,'the preceding schema migration committed without policy data');
    await writeFile(join(stage,validationName),validationSql);await ledger();await migrate();await migrate();
    assert.equal(await validated(),true,'retry validates in a separate production-applier transaction');
    assert.equal(await readPrivateWebSchemaDigest(admin),privateWebSchemaDigest);
    console.log('P71 empty_down=true failed_migration_partial_tables=0 ledger_unchanged=true validation_rollback=true validation_retry=true reup_replay=true');
  }finally{await admin.end();await rm(stage,{recursive:true,force:true});}
}));

test('P71 PostgreSQL previous-release signed rows survive production upgrade and legacy Start',async()=>run(async pg=>{
  await selectionDown(pg);
  await sql(pg,await readFile('db/down/0313_control_loop_provider_prices.sql','utf8'),[],'migrator');
  await sql(pg,await readFile('db/down/0312_control_loop_providers.sql','utf8'),[],'migrator');
  await sql(pg,await readFile('db/down/0315_control_loop_paid_admission.sql','utf8'),[],'migrator');
  await sql(pg,await readFile('db/down/0314_control_loop_policy_enforcement.sql','utf8'),[],'migrator');
  await sql(pg,await readFile('db/down/0311_control_loop_policy_validate.sql','utf8'),[],'migrator');
  await sql(pg,await readFile('db/down/0310_control_loop_policy.sql','utf8'),[],'migrator');
  await sql(pg,"DELETE FROM control_room_schema_migrations WHERE filename LIKE 'db/migrations/0310%' OR filename LIKE 'db/migrations/0311%' OR filename LIKE 'db/migrations/0312%' OR filename LIKE 'db/migrations/0313%' OR filename LIKE 'db/migrations/0314%' OR filename LIKE 'db/migrations/0315%' OR filename LIKE 'db/migrations/0316%' OR filename LIKE 'db/migrations/0317%' OR filename LIKE 'db/roles/%'");
  await seed(pg,pg.database,false);const e=engine(),w=web(pg,e.adapter);
  try{
    const description='Retained pre-policy input.';
    const draft=await w.desk.saveLoopDraft(identity,project,{description,settingsText},'p71-legacy-draft-0001');
    const requestId=draft.request.requestId,run={adapterId:e.adapter.adapterId,loopRunId:e.adapter.reserveRun(),toolingRevision:e.adapter.toolingRevision,a2SchemaVersion:1 as const};
    const link=await w.desk.recordLoopRunLink({projectId:project,requestId,initialInputVersion:1,run});
    const confirmation={path:'request.md',sha256:loopByteHashV1(description),at:new Date().toISOString(),who:'owner' as const,input_version:1};
    const status:LoopEngineStatusV1={run,revision:2,inputVersion:1,state:'ready',description,settingsSha256:loopByteHashV1(settingsText),settingsDigest:loopByteHashV1(settingsText),confirmation,
      approval:null,question:null,progress:{step:'intake',completed:0,attention:'none'},receipts:[]};e.runs.set(run.loopRunId,status);
    await w.desk.authorizeLoopStart(identity,project,{requestId,expectedVersion:1,runLinkId:link.runLink.runLinkId,
      requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1(settingsText)},'p71-legacy-authorize-0001',
      {revision:status.revision,inputVersion:1,settingsDigest:status.settingsDigest,confirmation});
    const historicalDescription='Retained pre-policy normalization.',normalized=historicalDescription+' Normalized.';
    const historical=await w.desk.saveLoopDraft(identity,project,{description:historicalDescription,settingsText},'p71-legacy-normalize-draft-0001');
    const historicalRun={...run,loopRunId:e.adapter.reserveRun()};
    const historicalLink=await w.desk.recordLoopRunLink({projectId:project,requestId:historical.request.requestId,initialInputVersion:1,run:historicalRun});
    e.runs.set(historicalRun.loopRunId,{...status,run:historicalRun,revision:1,inputVersion:2,state:'draft',description:normalized,confirmation:null,receipts:[]});
    const tables=['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_improvement_run_links','control_loop_improvement_authorizations'];
    const saved=async()=>Promise.all(tables.map(async table=>({table,rows:(await sql(pg,`SELECT row_to_json(r)::text bytes FROM ${table} r ORDER BY created_at,record_digest`)).rows})));
    const before=await saved();
    await applyMigrations({target:undefined,ledgerPath:resolve('deploy/postgres/migration-ledger.json'),rootDir:resolve('.'),bootstrapTarget:pg.admin(),migrateTarget:pg.connection('migrator'),
      env:{NODE_ENV:'test',CONTROL_ROOM_MIGRATOR_PASSWORD:pg.connection('migrator').password,CONTROL_ROOM_APP_PASSWORD:pg.connection('app').password,
        CONTROL_ROOM_SCHEDULER_PASSWORD:pg.connection('scheduler').password,CONTROL_ROOM_WORK_INTAKE_PASSWORD:pg.connection('control_room_work_intake_agent').password}});
    const roleSql=await readFile('db/roles/private_web_roles.sql','utf8');
    await sql(pg,roleSql.replace(/CREATE ROLE control_room_private_web[^;]+;/,''));
    assert.equal((await w.client.query<{allowed:boolean}>("SELECT has_function_privilege(current_user,'control_loop_selection_ack_timestamp_v1(text)','EXECUTE') allowed")).rows[0]!.allowed,true);
    await seedS4ProviderV1({query:async(query,params)=>sql(pg,query,params)},scope);
    assert.deepEqual(await saved(),before,'no backfill rewrites prior signed rows');
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_input_sources')).rows[0].n,0,'missing source stays legacy, never an inferred waiver');
    for(const operation of ['confirm','start'] as const) await assert.rejects(w.bridge.selectionTarget(identity,project,requestId,operation),{code:'service_unavailable'});
    const historicalStatus=await w.bridge.status(identity,project,requestId);assert.equal(historicalStatus.selection,undefined);
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_input_admissions')).rows[0].n,0,'all-versions-empty history gains no B8 authority');
    assert.equal(await readPrivateWebSchemaDigest(w.client),privateWebSchemaDigest);
    await w.policy.put(identity,project,'project',{lockedPaths:[],expectedVersion:0,settings:'{"fixture":"FUTURE_ONLY"}'},'p71-legacy-future-layer-0001');
    const started=await w.bridge.mutate(identity,project,requestId,'start',{route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:2,runLinkId:link.runLink.runLinkId},'p71-legacy-start-0001');
    assert.equal(started.state,'accepted');assert.deepEqual(await saved(),before);
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_input_sources')).rows[0].n,0);
    const normalizedResult=await w.bridge.mutate(identity,project,historical.request.requestId,'confirm',{
      expectedVersion:1,expectedRevision:1,requestSha256:loopByteHashV1(normalized),settingsSha256:loopByteHashV1(settingsText)},'p71-legacy-normalize-confirm-0001');
    assert.equal(normalizedResult.state,'accepted');assert.equal(normalizedResult.localVersion,2);
    assert.deepEqual((await sql(pg,'SELECT row_to_json(r)::text bytes FROM control_loop_improvement_inputs r WHERE version=1 ORDER BY created_at,record_digest')).rows,before.find(row=>row.table==='control_loop_improvement_inputs')!.rows,'normalization appends without rewriting either historical signed input');
    const historicalStarted=await w.bridge.mutate(identity,project,historical.request.requestId,'start',{
      route:S4_FIXTURE_ROUTE,expectedVersion:2,expectedRevision:2,runLinkId:historicalLink.runLink.runLinkId},'p71-legacy-normalize-start-0001');
    assert.equal(historicalStarted.state,'accepted');
    for(const table of ['control_loop_policy_input_sources','control_loop_policy_input_admissions'])
      assert.equal((await sql(pg,`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,'historical normalized copy manufactures no provenance');
    for(const operation of ['confirm','start'] as const)
      await assert.rejects(w.bridge.selectionTarget(identity,project,historical.request.requestId,operation),{code:'service_unavailable'});
    console.log('P71 production_upgrade=true prior_signed_rows=unchanged legacy_sources=0 legacy_Confirm_normalized=accepted legacy_Start=accepted all_versions_empty_B8=refused later_layers=future_only');
  }finally{await w.close();}
}));

for (const schedule of ['put-first','intake-first'] as const)
test(`P71 PostgreSQL distinct-owner intake versus PUT waits at the initial project mutex: ${schedule}`,async()=>run(async pg=>{
  await seed(pg);const other=await secondOwner(pg),e=engine(),states:string[]=[];
  const traced=(db:DatabaseClient):DatabaseClient=>{
    const wrap=(tx:DatabaseSession):DatabaseSession=>({query:async(sql,params)=>{try{return await tx.query(sql,params);}catch(error){const state=databaseSqlStateV1(error);if(state)states.push(state);throw error;}}});
    return{query:db.query.bind(db),transaction:work=>db.transaction(tx=>work(wrap(tx))),transactionWithPreCommitCheck:(work,check)=>db.transactionWithPreCommitCheck(tx=>work(wrap(tx)),check)};
  };
  if (schedule === 'intake-first') {
    const initial = web(pg, e.adapter);
    try { await initial.policy.put(identity, project, 'project', {lockedPaths:[], expectedVersion: 0, settings: '{}' }, 'p71-mutex-explicit-seed-0001'); }
    finally { await initial.close(); }
  }
  {
    let intakeChecked!:()=>void,putChecked!:()=>void,releaseIntake!:()=>void,releasePut!:()=>void;
    const intakeReady=new Promise<void>(r=>{intakeChecked=r;}),putReady=new Promise<void>(r=>{putChecked=r;});
    const intakeGate=new Promise<void>(r=>{releaseIntake=r;}),putGate=new Promise<void>(r=>{releasePut=r;});
    const intakeAdapter={...e.adapter,checkSettings:async()=>{intakeChecked();await intakeGate;return{eligible:true,reasons:[]};}};
    const writerAdapter={...e.adapter,checkSettings:async()=>{putChecked();await putGate;return{eligible:true,reasons:[]};}};
    const reader=web(pg,intakeAdapter),writer=web(pg,writerAdapter),blocker=new Client(pg.admin());await blocker.connect();
    const bridge=new ImproveControlRoomLoopServiceV1(traced(reader.client),scope,{providers:s4ProviderServiceV1(traced(reader.client),scope,undefined),integrityKey:KEY,adapter:intakeAdapter});
    const policy=new LoopPolicyServiceV1(traced(writer.client),scope,writerAdapter,Date.now,s4ProviderServiceV1(traced(writer.client),scope));
    let pending:PromiseSettledResult<unknown>[]=[];
    try{
      const before=Number((await blocker.query('SELECT deadlocks FROM pg_stat_database WHERE datname=$1',[pg.database])).rows[0].deadlocks);
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
      const intake=bridge.mutate(other,project,null,'intake',{description:'Current signed snapshot'},`p71-mutex-intake-${schedule}-0001`);
      const put=policy.put(identity,project,'project',{lockedPaths:[],expectedVersion:schedule==='put-first'?0:1,settings:schedule==='put-first'?'{}':'{"fixture":"future"}'},`p71-mutex-put-${schedule}-0001`);
      const all=Promise.allSettled([intake,put]); // observe both rejections before either is awaited
      let waiters=0;const deadline=Date.now()+10000;
      while(Date.now()<deadline){await blocker.query('SELECT pg_stat_clear_snapshot()');waiters=Number((await blocker.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM projects%FOR UPDATE%'",[pg.database])).rows[0].n);if(waiters===2)break;await new Promise(r=>setTimeout(r,10));}
      await blocker.query('COMMIT');await Promise.all([intakeReady,putReady]);
      assert.equal(waiters,2,'both distinct owners synchronize before the initial exclusive lock');
      if(schedule==='put-first'){
        releasePut();await put;releaseIntake();pending=await all;
        assert.equal(pending[0]!.status,'rejected');if(pending[0]!.status==='rejected')assert.equal(pending[0]!.reason.code,'conflict');
        for(const table of ['control_loop_improvement_requests','control_loop_policy_input_sources','control_loop_improvement_commands'])assert.equal((await sql(pg,`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
      }else{
        releaseIntake();const receipt=await intake;assert.equal(receipt.state,'accepted');releasePut();await put;pending=await all;
        assert.ok(pending.every(result=>result.status==='fulfilled'));
        const source=(await sql(pg,'SELECT layer_versions FROM control_loop_policy_input_sources WHERE request_id=$1',[receipt.requestId])).rows[0];
        assert.deepEqual(source.layer_versions,{project:1,selection:0});
        const input=(await sql(pg,'SELECT settings_text FROM control_loop_improvement_inputs WHERE request_id=$1',[receipt.requestId])).rows[0];
        assert.equal(JSON.parse(input.settings_text).fixture,'SYNTHETIC','later policy never rewrites the admitted copy');
      }
      await blocker.query('SELECT pg_stat_clear_snapshot()');const after=Number((await blocker.query('SELECT deadlocks FROM pg_stat_database WHERE datname=$1',[pg.database])).rows[0].deadlocks);
      assert.equal(after,before);assert.deepEqual(states,[],'no raw deadlock/serialization SQLSTATE is masked as conflict');
      console.log(`P71 intake_PUT schedule=${schedule} distinct_owners=2 initial_project_waiters=${waiters} SQLSTATEs=${JSON.stringify(states)} deadlock_delta=${after-before}`);
    }finally{releaseIntake();releasePut();await blocker.query('ROLLBACK');await blocker.end();await reader.close();await writer.close();}
  }
}));

// P72 uses the production login and separate connections; no synthetic PG substitute.
const p72Locked=(error:unknown)=>error instanceof Error&&'reasons' in error
  && (error as {reasons:{code:string}[]}).reasons[0]?.code==='POLICY_LOCKED';
async function p72Waiver(w:ReturnType<typeof web>,path='fixture') {
  return (await w.policy.createWaiver(identity,project,{path,reason:'One bounded synthetic exception',expiresAt:new Date(Date.now()+300000).toISOString()},`p72-waiver-${randomBytes(12).toString('hex')}`)).waiver;
}
test('P72 PostgreSQL production waiver grants owner transition scope expiry and retained down',async()=>run(async pg=>{
  await seed(pg);const e=engine(),w=web(pg,e.adapter);
  try{
    const guards=['guard_control_loop_policy_locked_paths','guard_control_loop_policy_source_waiver','guard_control_loop_policy_waiver'];
    const configs=(await sql(pg,'SELECT proname,proconfig FROM pg_proc WHERE proname=ANY($1::text[]) ORDER BY proname',[guards])).rows;
    assert.deepEqual(configs,guards.map(proname=>({proname,proconfig:['search_path=pg_catalog, public, pg_temp']})));
    const table='control_loop_policy_waivers';
    for(const right of ['SELECT','INSERT'])assert.equal((await w.client.query<{yes:boolean}>('SELECT has_table_privilege(current_user,$1,$2) yes',[table,right])).rows[0]!.yes,true);
    for(const right of ['UPDATE','DELETE','TRUNCATE'])assert.equal((await w.client.query<{yes:boolean}>('SELECT has_table_privilege(current_user,$1,$2) yes',[table,right])).rows[0]!.yes,false);
    const columns=(await w.client.query<{attname:string}>(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
      AND attnum>0 AND NOT attisdropped AND has_column_privilege(current_user,attrelid,attnum,'UPDATE') ORDER BY attname COLLATE "C"`,[table])).rows.map(r=>r.attname);
    assert.deepEqual(columns,['consumed_by_request_id','revoked_at']);
    for(const role of ['control_room_application','control_room_reader','control_room_schedule_admissions','control_room_github_broker','control_room_work_intake','control_room_backup'])
      assert.equal((await sql(pg,"SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') yes",[role,table])).rows[0].yes,false);
    const createSql=`INSERT INTO control_loop_policy_waivers(tenant_id,project_id,id,path,reason,created_by,created_at,expires_at)
      VALUES($1,$2,$3,'fixture','Synthetic exception',$4,statement_timestamp(),statement_timestamp()+interval '1 day')`;
    await sql(pg,"UPDATE control_role_grants SET role_key='operator' WHERE identity_id=$1",[owner]);
    await assert.rejects(w.client.query(createSql,[scope.tenantId,project,'waiver:denied',owner]),{sqlState:'42501'});
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_waivers')).rows[0].n,0);
    await sql(pg,"UPDATE control_role_grants SET role_key='owner' WHERE identity_id=$1",[owner]);
    const replayKey='p72-native-expiry-replay-0001';
    const replayBody={path:'fixture',reason:'Exact expiry retry',expiresAt:new Date(Date.now()+300000).toISOString()};
    const created=await w.policy.createWaiver(identity,project,replayBody,replayKey);
    assert.equal(created.replayed,false);
    assert.deepEqual(await w.policy.createWaiver(identity,project,replayBody,replayKey),{...created,replayed:true});
    await assert.rejects(w.policy.createWaiver(identity,project,{...replayBody,expiresAt:replayBody.expiresAt.replace('Z','001Z')},replayKey),{code:'conflict'});
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_waivers')).rows[0].n,1,'changed expiry retry writes nothing');
    await w.policy.put(identity,project,'project',{expectedVersion:0,settings:'{}',lockedPaths:[]},'p72-native-paths-project-0001');
    await w.policy.put(identity,project,'selection',{expectedVersion:0,settings:'{}'},'p72-native-paths-select-0001');
    for(const paths of [null,{},[1],['fixture','fixture'],['z','a'],['fixture.0'],['__proto__'],Array.from({length:101},(_,i)=>`key${i}`)])
      await assert.rejects(w.client.query("UPDATE control_loop_policy_layers SET locked_paths=$1::jsonb WHERE layer='project'",[JSON.stringify(paths)]),{sqlState:'23514'});
    await assert.rejects(w.client.query("UPDATE control_loop_policy_layers SET locked_paths='[\"fixture\"]'::jsonb WHERE layer='selection'"),{sqlState:'23514'});
    for(const interval of ["interval '8 days'","interval '0 days'"])
      await assert.rejects(w.client.query(createSql.replace("interval '1 day'",interval),[scope.tenantId,project,'waiver:invalid-expiry',owner]),{sqlState:'23514'});
    const foreignProject='project:p72-foreign';
    await sql(pg,`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      SELECT $1,tenant_id,workspace_id,adapter_id,$1,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at FROM projects WHERE id=$2`,[foreignProject,project]);
    await sql(pg,"INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES($1,$2,'active',1,now(),now())",[scope.tenantId,foreignProject]);
    const foreignDraft=await w.desk.saveLoopDraft(identity,foreignProject,{description:'Other project request',settingsText},'p72-native-foreign-draft-0001');
    const scoped=await p72Waiver(w);
    await assert.rejects(w.client.query('UPDATE control_loop_policy_waivers SET consumed_by_request_id=$1 WHERE id=$2',[foreignDraft.request.requestId,scoped.id]),{sqlState:'23514'});
    const source=await w.desk.saveLoopDraft(identity,project,{description:'Same project request',settingsText},'p72-native-source-draft-0001');
    await w.client.query('UPDATE control_loop_policy_waivers SET consumed_by_request_id=$1 WHERE id=$2',[source.request.requestId,scoped.id]);
    await assert.rejects(w.client.query(`INSERT INTO control_loop_policy_input_sources(tenant_id,request_id,input_version,defaults_sha256,layer_versions,waiver_id)
      VALUES($1,$2,1,$3,'{"project":0,"selection":0}',$4)`,[scope.tenantId,foreignDraft.request.requestId,loopByteHashV1(settingsText),scoped.id]),{sqlState:'23514'});
    console.log('P72 native locked_paths_shape_sort_duplicates_selection expiry_same_project_source constraints=23514');
    const waiver=await p72Waiver(w);
    for(const statement of ["UPDATE control_loop_policy_waivers SET reason='mutated'","DELETE FROM control_loop_policy_waivers","TRUNCATE control_loop_policy_waivers"])
      await assert.rejects(w.client.query(statement),{sqlState:'42501'});
    await w.policy.revokeWaiver(identity,project,waiver.id);await w.policy.revokeWaiver(identity,project,waiver.id);
    await assert.rejects(w.client.query('UPDATE control_loop_policy_waivers SET revoked_at=NULL'),{sqlState:'23514'});
    const draft=await w.desk.saveLoopDraft(identity,project,{description:'Synthetic unused request',settingsText},'p72-transition-draft-0001');
    await assert.rejects(w.client.query('UPDATE control_loop_policy_waivers SET consumed_by_request_id=$1 WHERE id=$2',[draft.request.requestId,waiver.id]),{sqlState:'23514'});
    const expired=(await sql(pg,`INSERT INTO control_loop_policy_waivers(tenant_id,project_id,id,path,reason,created_by,created_at,expires_at)
      VALUES($1,$2,'waiver:expired','fixture','Expired exception',$3,statement_timestamp()-interval '2 days',statement_timestamp()-interval '1 day') RETURNING id`,[scope.tenantId,project,owner])).rows[0];
    await assert.rejects(w.client.query('UPDATE control_loop_policy_waivers SET consumed_by_request_id=$1 WHERE id=$2',[draft.request.requestId,expired.id]),{sqlState:'23514'});
    const before=await readPrivateWebSchemaDigest(w.client);
    await assert.rejects(sql(pg,await readFile('db/down/0314_control_loop_policy_enforcement.sql','utf8'),[],'migrator'),{code:'23514',message:'loop policy enforcement retained'});
    assert.equal(await readPrivateWebSchemaDigest(w.client),before);
    assert.equal(before,privateWebSchemaDigest);
    const updater=digestReleaseSchemaRowsV1((await w.client.query(await readFile('src/updater/v1/pg/release-schema-digest.sql','utf8'))).rows);
    assert.equal(updater,before);
    console.log(`P72 PG17 measured_web=${before} measured_updater=${updater} owner_SQLSTATE=42501 mutation_SQLSTATE=23514 retained_down=refused`);
  }finally{await w.close();}
}));

test('P72 PostgreSQL one waiver 24 checked intakes one consumption source input and claim',async()=>run(async pg=>{
  await seed(pg);const e=engine(),initial=web(pg,e.adapter),barrier=checkBarrier(24),states:string[]=[];
  let waiverId:string;
  try{
    await initial.policy.put(identity,project,'project',{expectedVersion:0,settings:'{}',lockedPaths:['fixture']},'p72-concurrent-lock-0001');
    waiverId=(await p72Waiver(initial)).id;
  }finally{await initial.close();}
  const traced=(tx:DatabaseSession):DatabaseSession=>({query:async(sql,params)=>{try{return await tx.query(sql,params);}catch(error){const state=databaseSqlStateV1(error);if(state)states.push(state);throw error;}}});
  const adapter={...e.adapter,checkSettings:barrier.check};
  const clients=Array.from({length:24},()=>{
    const w=pgPolicy(pg,adapter,identity,traced);
    const db:DatabaseClient={query:w.client.query.bind(w.client),transaction:fn=>w.client.transaction(tx=>fn(traced(tx))),transactionWithPreCommitCheck:(fn,check)=>w.client.transactionWithPreCommitCheck(tx=>fn(traced(tx)),check)};
    return {...w,bridge:new ImproveControlRoomLoopServiceV1(db,scope,{providers:s4ProviderServiceV1(db,scope,undefined),integrityKey:KEY,adapter})};
  });
  try{
    const results=await Promise.allSettled(clients.map((w,i)=>w.bridge.mutate(identity,project,null,'intake',
      {description:'Single-use exception',settingsEdits:'{"fixture":"exception"}',waiverId},`p72-waiver-contend-${String(i).padStart(4,'0')}`)));
    assert.equal(barrier.reached,24,'all 24 callers passed preflight and checked');
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    for(const loser of results.filter(r=>r.status==='rejected'))assert.ok(p72Locked(loser.reason));
    for(const table of ['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_policy_input_sources'])
      assert.equal((await sql(pg,`SELECT count(*)::int n FROM ${table}`)).rows[0].n,1);
    assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_improvement_commands WHERE entry_kind='claim'")).rows[0].n,1);
    const winner=(await sql(pg,'SELECT request_id,waiver_id FROM control_loop_policy_input_sources')).rows[0];
    const consumed=(await sql(pg,'SELECT consumed_by_request_id FROM control_loop_policy_waivers WHERE id=$1',[waiverId])).rows[0];
    assert.equal(winner.waiver_id,waiverId);assert.equal(consumed.consumed_by_request_id,winner.request_id);
    await assert.rejects(clients[0]!.client.query('UPDATE control_loop_policy_waivers SET consumed_by_request_id=NULL WHERE id=$1',[waiverId]),{sqlState:'23514'});
    assert.deepEqual(states,[],'no SQLSTATE deadlock or serialization error hidden as a passing loser');
    console.log(`P72 waiver barrier callers=24 checked=${barrier.reached} winners=1 POLICY_LOCKED=23 drafts=1 inputs=1 sources=1 claims=1 SQLSTATEs=${JSON.stringify(states)}`);
  }finally{barrier.release();await Promise.all(clients.map(w=>w.close()));}
}));

for(const order of ['put-first','intake-first'] as const)
test(`P72 PostgreSQL lock PUT versus waiver intake current locks and project wait: ${order}`,async()=>run(async pg=>{
  await seed(pg);const other=await secondOwner(pg),e=engine(),initial=web(pg,e.adapter);
  let waiverId:string;
  try{
    await initial.policy.put(identity,project,'project',{expectedVersion:0,settings:'{"locked":"base","other":"base"}',lockedPaths:['locked']},'p72-race-initial-0001');
    waiverId=(await p72Waiver(initial,'locked')).id;
  }finally{await initial.close();}
  let checked!:()=>void,releaseCheck!:()=>void;
  const ready=new Promise<void>(r=>{checked=r;}),gate=new Promise<void>(r=>{releaseCheck=r;});
  let entered!:()=>void,releaseConsume!:()=>void;
  const held=new Promise<void>(r=>{entered=r;}),consumeGate=new Promise<void>(r=>{releaseConsume=r;});
  const states:string[]=[];
  const reader=web(pg,{...e.adapter,checkSettings:async()=>{checked();await gate;return{eligible:true,reasons:[]};}}),writer=web(pg,e.adapter);
  const wrap=(tx:DatabaseSession):DatabaseSession=>({query:async(sql,params)=>{
    try{
      if(order==='intake-first'&&sql.startsWith('UPDATE control_loop_policy_waivers SET consumed_by_request_id')){entered();await consumeGate;}
      return await tx.query(sql,params);
    }catch(error){const state=databaseSqlStateV1(error);if(state)states.push(state);throw error;}
  }});
  const db:DatabaseClient={query:reader.client.query.bind(reader.client),transaction:fn=>reader.client.transaction(tx=>fn(wrap(tx))),transactionWithPreCommitCheck:(fn,check)=>reader.client.transactionWithPreCommitCheck(tx=>fn(wrap(tx)),check)};
  const adapter={...e.adapter,checkSettings:async()=>{checked();await gate;return{eligible:true,reasons:[]};}};
  const bridge=new ImproveControlRoomLoopServiceV1(db,scope,{providers:s4ProviderServiceV1(db,scope,undefined),integrityKey:KEY,adapter});
  let intake:Promise<unknown>|undefined,put:Promise<unknown>|undefined;
  try{
    intake=bridge.mutate(other,project,null,'intake',{description:'Raced exception',settingsEdits:'{"locked":"changed","other":"changed"}',waiverId},`p72-race-intake-${order}`);
    const observed=Promise.allSettled([intake]);await ready;
    const save=()=>writer.policy.put(identity,project,'project',{expectedVersion:1,settings:'{"locked":"base","other":"base"}',lockedPaths:['locked','other']},`p72-race-put-${order}`);
    if(order==='put-first'){
      await save();releaseCheck();const result=await observed;
      assert.equal(result[0]!.status,'rejected');if(result[0]!.status==='rejected')assert.ok(p72Locked(result[0]!.reason));
      assert.equal((await sql(pg,'SELECT consumed_by_request_id FROM control_loop_policy_waivers')).rows[0].consumed_by_request_id,null);
      for(const table of ['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_policy_input_sources','control_loop_improvement_commands'])
        assert.equal((await sql(pg,`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
    }else{
      releaseCheck();await held;put=save();const pendingPut=Promise.allSettled([put]);
      let waiters=0;const deadline=Date.now()+10000;
      while(Date.now()<deadline){waiters=Number((await sql(pg,"SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM projects%FOR UPDATE%'",[pg.database])).rows[0].n);if(waiters)break;await new Promise(r=>setTimeout(r,10));}
      assert.equal(waiters,1,'lock PUT really waits behind intake project mutex');releaseConsume();
      const result=await observed;assert.equal(result[0]!.status,'fulfilled');await put;await pendingPut;
      assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_input_sources')).rows[0].n,1);
    }
    assert.deepEqual(states,[]);console.log(`P72 locks schedule=${order} SQLSTATEs=[] no_waiver_burn_on_refusal=true`);
  }finally{releaseCheck();releaseConsume();await Promise.allSettled([intake,put].filter((v):v is Promise<unknown>=>Boolean(v)));await reader.close();await writer.close();}
}));

test('P72 PostgreSQL empty down re-up and injected migration failure leave prior schema and ledger',async()=>run(async pg=>{
  await mkdir(resolve('.test-tmp'),{recursive:true});
  const stage=await mkdtemp(resolve('.test-tmp/p72-upgrade-'));
  const admin=new Client(pg.admin());
  try{
    await admin.connect();
    const up='db/migrations/0314_control_loop_policy_enforcement.sql';
    const after=await readPrivateWebSchemaDigest(admin);
    await selectionDown(pg);
    await admin.query(await readFile('db/down/0315_control_loop_paid_admission.sql','utf8'));
    await admin.query(await readFile('db/down/0314_control_loop_policy_enforcement.sql','utf8'));
    const before=await readPrivateWebSchemaDigest(admin);
    assert.equal(before,'388364abf81943ff1a8aca8eb7ed153b73239c0e2a935f896c2d51635ba29422');
    assert.equal((await admin.query("SELECT pg_get_userbyid(relowner) owner FROM pg_class WHERE oid='control_loop_policy_layers'::regclass")).rows[0].owner,'control_room_schema_owner');
    assert.deepEqual((await admin.query("SELECT attname FROM pg_attribute WHERE attrelid='control_loop_policy_layers'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('control_room_web',attrelid,attnum,'UPDATE') ORDER BY attname COLLATE \"C\"")).rows.map(row=>row.attname),
      ['last_idempotency_key','last_request_digest','settings_sha256','settings_text','updated_at','updated_by','version']);
    for(const privilege of ['SELECT','INSERT'])assert.equal((await admin.query('SELECT has_table_privilege($1,$2,$3) yes',['control_room_web','control_loop_policy_layers',privilege])).rows[0].yes,true);
    await admin.query("DELETE FROM control_room_schema_migrations WHERE filename LIKE 'db/migrations/0314%' OR filename LIKE 'db/migrations/0315%' OR filename LIKE 'db/migrations/0316%' OR filename LIKE 'db/migrations/0317%' OR filename LIKE 'db/roles/%'");
    const ledgerBefore=(await admin.query('SELECT * FROM control_room_schema_migrations ORDER BY ledger_order')).rows;
    const files=(await import('node:fs')).readdirSync('db',{recursive:true}).filter(file=>typeof file==='string' && file.endsWith('.sql')).map(file=>'db/'+file);
    for(const file of [...files,up]){await mkdir(dirname(join(stage,file)),{recursive:true});await writeFile(join(stage,file),await readFile(file));}
    await writeFile(join(stage,up),(await readFile(up,'utf8'))+"\nSELECT 1/0;\n");
    const migrationEnv:NodeJS.ProcessEnv={NODE_ENV:'test',CONTROL_ROOM_MIGRATOR_PASSWORD:pg.connection('migrator').password,CONTROL_ROOM_APP_PASSWORD:pg.connection('app').password,CONTROL_ROOM_SCHEDULER_PASSWORD:pg.connection('scheduler').password,CONTROL_ROOM_WORK_INTAKE_PASSWORD:pg.connection('control_room_work_intake_agent').password};
    const failedEntries=await collectLedgerEntries(stage);await mkdir(join(stage,'deploy/postgres'),{recursive:true});
    await writeFile(join(stage,'deploy/postgres/migration-ledger.json'),JSON.stringify({version:1,digest:ledgerDigest(failedEntries),entries:failedEntries}));
    await assert.rejects(applyMigrations({target:undefined,rootDir:stage,ledgerPath:join(stage,'deploy/postgres/migration-ledger.json'),bootstrapTarget:pg.admin(),migrateTarget:pg.connection('migrator'),env:migrationEnv}),/division by zero/);
    assert.equal(await readPrivateWebSchemaDigest(admin),before);
    assert.deepEqual((await admin.query('SELECT * FROM control_room_schema_migrations ORDER BY ledger_order')).rows,ledgerBefore);
    assert.equal((await admin.query("SELECT to_regclass('control_loop_policy_waivers') name")).rows[0].name,null);
    await applyMigrations({target:undefined,rootDir:resolve('.'),ledgerPath:resolve('deploy/postgres/migration-ledger.json'),bootstrapTarget:pg.admin(),migrateTarget:pg.connection('migrator'),env:migrationEnv});
    assert.equal(await readPrivateWebSchemaDigest(admin),after);
    console.log(`P72 PG17 empty_down_pin=${before} reup_pin=${after} injected_failure=rollback ledger_unchanged=true`);
  }finally{await admin.end();await rm(stage,{recursive:true,force:true});}
}));

for(const order of ['start-first','revoke-first'] as const)
test(`P72 PostgreSQL Start revoke serialization and admission winner: ${order}`,async()=>run(async pg=>{
  await seed(pg);const other=await secondOwner(pg),e=engine(),w=web(pg,e.adapter);
  const revoker=web(pg,e.adapter);
  let unblock!:()=>void,held!:()=>void;
  const hold=new Promise<void>(r=>{unblock=r;}),ready=new Promise<void>(r=>{held=r;});
  try{
    await w.policy.put(identity,project,'project',{expectedVersion:0,settings:'{}',lockedPaths:['fixture']},'p72-start-order-lock-0001');
    const waiver=await p72Waiver(w);
    const intake=await w.bridge.mutate(identity,project,null,'intake',{description:'Ordered waiver',settingsEdits:'{"fixture":"exception"}',waiverId:waiver.id},'p72-start-order-intake-0001');
    let s=await w.bridge.status(identity,project,intake.requestId);
    await w.bridge.mutate(identity,project,intake.requestId,'confirm',{expectedVersion:1,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256},'p72-start-order-confirm-0001');
    s=await w.bridge.status(identity,project,intake.requestId);
    const startBody={route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId};
    if(order==='start-first'){
      const adapter={...e.adapter,start:async(...args:Parameters<LoopAdapterV1['start']>)=>{held();await hold;return e.adapter.start(...args);}};
      const bridge=new ImproveControlRoomLoopServiceV1(w.client,scope,{providers:s4ProviderServiceV1(w.client,scope,undefined),integrityKey:KEY,adapter});
      const starting=bridge.mutate(identity,project,intake.requestId,'start',startBody,'p72-start-order-start-0001');
      const observed=Promise.allSettled([starting]);await ready;
      assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0].n,1);
      await revoker.policy.revokeWaiver(other,project,waiver.id);unblock();
      const result=await observed;assert.equal(result[0]!.status,'fulfilled');assert.equal((await starting).state,'accepted');
      assert.equal(e.calls.filter(c=>c.op==='start').length,1,'revocation never cancels an admitted Start');
    }else{
      const wrap=(tx:DatabaseSession):DatabaseSession=>({query:async<T>(sql:string,params?:unknown[])=>{
        const value=await tx.query<T>(sql,params);
        if(sql.startsWith('UPDATE control_loop_policy_waivers SET revoked_at')){held();await hold;}
        return value;
      }});
      const db:DatabaseClient={query:revoker.client.query.bind(revoker.client),transaction:fn=>revoker.client.transaction(tx=>fn(wrap(tx))),transactionWithPreCommitCheck:(fn,check)=>revoker.client.transactionWithPreCommitCheck(tx=>fn(wrap(tx)),check)};
      const policy=new LoopPolicyServiceV1(db,scope,e.adapter,Date.now,s4ProviderServiceV1(db,scope));
      const revoking=policy.revokeWaiver(other,project,waiver.id);const observedRevoke=Promise.allSettled([revoking]);await ready;
      const starting=w.bridge.mutate(identity,project,intake.requestId,'start',startBody,'p72-start-order-start-0001');
      const observedStart=Promise.allSettled([starting]);
      let waiters=0;const deadline=Date.now()+10000;
      while(Date.now()<deadline){waiters=Number((await sql(pg,"SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM projects%FOR UPDATE%'",[pg.database])).rows[0].n);if(waiters)break;await new Promise(r=>setTimeout(r,10));}
      assert.equal(waiters,1,'Start really waits for revoke transaction');unblock();await revoking;await observedRevoke;
      const result=await observedStart;assert.equal(result[0]!.status,'rejected');if(result[0]!.status==='rejected')assert.equal(result[0]!.reason.reasons[0].code,'WAIVER_INVALID');
      assert.equal(e.calls.filter(c=>c.op==='start').length,0);
      assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0].n,0);
    }
    console.log(`P72 Start_revoke order=${order} admission_order_wins=true no_driver_leak=true`);
  }finally{unblock();await w.close();await revoker.close();}
}));

test('P72 PostgreSQL dropped connection after consumption rolls back then retry consumes once',async()=>run(async pg=>{
  await seed(pg);const e=engine(),w=web(pg,e.adapter);
  let waiverId:string;
  try{
    await w.policy.put(identity,project,'project',{expectedVersion:0,settings:'{}',lockedPaths:['fixture']},'p72-drop-lock-0001');
    waiverId=(await p72Waiver(w)).id;
    let terminated=false;
    const wrap=(tx:DatabaseSession):DatabaseSession=>({query:async<T>(statement:string,params?:unknown[])=>{
      const value=await tx.query<T>(statement,params);
      if(statement.startsWith('UPDATE control_loop_policy_waivers SET consumed_by_request_id')&&!terminated){
        const pid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;terminated=true;await sql(pg,'SELECT pg_terminate_backend($1)',[pid]);
      }
      return value;
    }});
    const db:DatabaseClient={query:w.client.query.bind(w.client),transaction:fn=>w.client.transaction(tx=>fn(wrap(tx))),transactionWithPreCommitCheck:(fn,check)=>w.client.transactionWithPreCommitCheck(tx=>fn(wrap(tx)),check)};
    const b=new ImproveControlRoomLoopServiceV1(db,scope,{providers:s4ProviderServiceV1(db,scope,undefined),integrityKey:KEY,adapter:e.adapter});
    await assert.rejects(b.mutate(identity,project,null,'intake',{description:'Interrupted exception',settingsEdits:'{"fixture":"exception"}',waiverId},'p72-drop-intake-0001'));
    assert.equal(terminated,true);
    assert.equal((await sql(pg,'SELECT consumed_by_request_id FROM control_loop_policy_waivers WHERE id=$1',[waiverId])).rows[0].consumed_by_request_id,null);
    for(const table of ['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_policy_input_sources','control_loop_improvement_commands'])assert.equal((await sql(pg,`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
    assert.equal(e.calls.length,0);
  }finally{await w.close();}
  const retry=web(pg,e.adapter);
  try{
    const body={description:'Interrupted exception',settingsEdits:'{"fixture":"exception"}',waiverId};
    const first=await retry.bridge.mutate(identity,project,null,'intake',body,'p72-drop-intake-0001');assert.equal(first.state,'accepted');
    const second=await retry.bridge.mutate(identity,project,null,'intake',body,'p72-drop-intake-0001');assert.equal(second.replayed,true);assert.equal(first.requestId,second.requestId);
    assert.equal((await sql(pg,'SELECT count(*)::int n FROM control_loop_policy_input_sources')).rows[0].n,1);
    console.log('P72 dropped_connection consumed_rollback=true partial_rows=0 retry_sources=1 replay=true');
  }finally{await retry.close();}
}));

test('S4 native admission pins and migration preserve signed history and reject malformed SQL',async()=>run(async pg=>{
 await seed(pg);const e=engine(true),{w,id,s}=await confirmed(pg,e);
 let app:ReturnType<typeof createMacLocalWebProcessV1>|undefined;
 const rosterRoot=await mkdtemp(resolve('.test-tmp/s4-native-roster-'));
 try{
  assert.deepEqual((await w.client.query('SELECT current_user,session_user')).rows,[{current_user:'control_room_web',session_user:'control_room_web'}]);
  const rows=()=>sql(pg,'SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind');
  const history=(await rows()).rows;
  const down=await readFile('db/down/0315_control_loop_paid_admission.sql','utf8'),up=await readFile('db/migrations/0315_control_loop_paid_admission.sql','utf8');
  await selectionDown(pg);
  await sql(pg,down,[],'migrator');const previous=await readPrivateWebSchemaDigest(w.client);
  await assert.rejects(sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${up}\nSELECT 1/0;COMMIT;`,[],'migrator'),{code:'22012'});
  assert.equal(await readPrivateWebSchemaDigest(w.client),previous,'failed upgrade rolls back both CHECK replacements');
  assert.deepEqual((await rows()).rows,history,'failed upgrade retains signed bytes');
  await sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${up}\nCOMMIT;`,[],'migrator');
  await selectionUp(pg);
  const digest=await readPrivateWebSchemaDigest(w.client);
  assert.equal(digest,privateWebSchemaDigest);
  assert.equal(digest,digestReleaseSchemaRowsV1((await w.client.query(await readFile('src/updater/v1/pg/release-schema-digest.sql','utf8'))).rows));
  assert.deepEqual((await rows()).rows,history,'successful upgrade retains signed bytes');
  await sql(pg,"UPDATE control_loop_providers SET billing_kind='token' WHERE provider_id=$1",[S4_FIXTURE_ROUTE.providerId]);
  await sql(pg,`INSERT INTO control_loop_provider_prices(tenant_id,provider_id,model,window_key,"window",input_nano_usd_per_token,output_nano_usd_per_token,currency,status,reason,checked_at)
   VALUES($1,$2,'served/fixture','all',NULL,'2','3','USD','known','',now())`,[scope.tenantId,S4_FIXTURE_ROUTE.providerId]);
  const body={route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId,paid:{optIn:true,capNanoUsd:'100'}};
  const localOrigin='http://127.0.0.1:60779',ownerCode='SYNTHETIC-s4-owner-code-000001';
  app=createMacLocalWebProcessV1({origin:localOrigin,workspaceId:scope.workspaceId,database:{client:w.client,isAvailable:()=>true,close:async()=>{}},
   localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin:localOrigin,tenantId:scope.tenantId,provider:'test',subject:owner,ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900},
   loopBridge:{integrityKey:KEY,adapter:{...e.adapter,roster:{rosterRoot,toolsSeed:join(rosterRoot,'unused-seed.tsv'),check:async()=>{throw new Error('recorded roster check is not used by admission');}}}}});
  const signIn=await app.handle(new Request(localOrigin+'/api/v1/local-owner-session',{method:'POST',headers:{origin:localOrigin,'content-type':'application/json'},body:JSON.stringify({ownerCode})}),()=>new Response('unused'));
  assert.equal(signIn.status,201);const cookie=signIn.headers.get('set-cookie')!;
  const response=await app.handle(new Request(`${localOrigin}/api/v1/projects/${encodeURIComponent(project)}/improvements/loop/${encodeURIComponent(id)}/start`,{
   method:'POST',headers:{origin:localOrigin,cookie,'content-type':'application/json','idempotency-key':'s4-native-paid-000001'},body:JSON.stringify(body)}),()=>new Response('unused'));
  assert.equal(response.status,202);const result=await response.json();assert.equal(result.state,'accepted');
  const claims=(await sql(pg,"SELECT * FROM control_loop_improvement_commands WHERE operation='start' ORDER BY entry_kind")).rows;
  assert.equal(claims.length,2);
  const checkedAt=(await w.client.query<{checked_at:Date}>('SELECT checked_at FROM control_loop_provider_prices WHERE tenant_id=$1 AND provider_id=$2',[scope.tenantId,S4_FIXTURE_ROUTE.providerId])).rows[0]!.checked_at;
  const {providerPriceDigestV1}=await import('../src/web/v1/loop-provider-prices');
  const expectedPin={...S4_FIXTURE_ROUTE,servedModelId:'served/fixture',providerVersion:1,capNanoUsd:'100',
   priceRowDigest:providerPriceDigestV1({providerId:S4_FIXTURE_ROUTE.providerId,model:'served/fixture',windowKey:'all',window:null,input:'2',output:'3',currency:'USD',status:'known',reason:'',checkedAt:checkedAt.toISOString()})};
  for(const row of claims)assert.deepEqual(row.binding.paidPin,expectedPin,'each native claim/result keeps the complete service-derived pin');
  for(const row of claims){assert.equal(row.binding.paidPin.servedModelId,'served/fixture');assert.equal(row.binding.paidPin.providerVersion,1);assert.equal(row.binding.paidPin.capNanoUsd,'100');assert.equal(row.binding.paidPin.providerId,S4_FIXTURE_ROUTE.providerId);}
  const binding=claims[0].binding;
  const mutations=[{...binding,unknown:true},{...binding,paidPin:null},{...binding,paidPin:{...binding.paidPin,servedModelId:null}},
   {...binding,paidPin:{...binding.paidPin,capNanoUsd:'101'}},{...binding,body:{...body,route:null}},
   {...binding,body:{...body,route:{...S4_FIXTURE_ROUTE,unknown:true}}},{...binding,body:{...body,paid:{optIn:false,capNanoUsd:'100'}}}];
  const {route:_,...noRoute}=body;mutations.push({...binding,body:noRoute});
  for(const mutated of mutations){
   const row={...claims[0],command_id:`loop-command:${randomBytes(16).toString('hex')}`,idempotency_key:`s4-native-bad-${randomBytes(8).toString('hex')}`,binding:mutated};
   const columns=Object.keys(row),values=Object.values(row).map(value=>value&&typeof value==='object'&&!(value instanceof Date)?JSON.stringify(value):value);
   await assert.rejects(sql(pg,`INSERT INTO control_loop_improvement_commands(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,values,'web'),{code:'23514'});
  }
  const retained=(await rows()).rows;
  await assert.rejects(sql(pg,down,[],'migrator'),{code:'23514',message:'loop paid admission retained'});
  assert.deepEqual((await rows()).rows,retained);assert.equal(await readPrivateWebSchemaDigest(w.client),digest);
  assert.equal((await w.bridge.mutate(identity,project,id,'start',body,'s4-native-paid-000001')).replayed,true);
  await assert.rejects(w.bridge.mutate(identity,project,id,'start',{...body,paid:{optIn:true,capNanoUsd:'101'}},'s4-native-paid-000001'),{code:'conflict'});
  console.log('S4 native login=production entrypoint=authenticated-Mac-local-handler CHECK vectors=8 signed-history=unchanged failed-upgrade=atomic retained-down=refused paid-stand-in=accepted replay=exact readiness=native-disabled');
 }finally{await app?.close();await w.close();await rm(rosterRoot,{recursive:true,force:true});}
}));

test('S4 native legacy route-less signed Start survives upgrade replay sweep and Stop',async()=>run(async pg=>{
 await seed(pg);const e=engine(),{w,id,s}=await confirmed(pg,e);
 try{
  const down=await readFile('db/down/0315_control_loop_paid_admission.sql','utf8'),up=await readFile('db/migrations/0315_control_loop_paid_admission.sql','utf8');
  await selectionDown(pg);
  await sql(pg,down,[],'migrator');
  const confirm=(await w.client.query<{binding:LoopBridgeBindingV1}>("SELECT binding FROM control_loop_improvement_commands WHERE operation='confirm' AND entry_kind='claim'")).rows[0]!.binding;
  const authorization=(await w.client.query<{id:string}>('SELECT id FROM control_loop_improvement_authorizations')).rows[0]!.id;
  const body={expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId};
  const binding={...confirm,body,authorizationId:authorization,expectedRevision:s.engine.revision};
  const commandId=`loop-command:${randomBytes(16).toString('hex')}`,key='s4-native-legacy-start-0001';
  // Seal the predecessor's fifteen-key binding under its actual CHECKs. This
  // fixture adapter records execution only; it never invokes a provider.
  const insert=async(entry_kind:'claim'|'result',result:unknown)=>{
   const material={tenant_id:scope.tenantId,command_id:commandId,entry_kind,request_id:id,project_id:project,owner_identity_id:owner,
    operation:'start',idempotency_key:key,binding,result,created_at:new Date().toISOString()};
   const row={...material,record_digest:sha256Digest(material),auth_tag:hmacSha256Tag(KEY,{purpose:'loop-improvement-command/v1',record:material})};
   const columns=Object.keys(row),values=Object.values(row).map(value=>value&&typeof value==='object'?JSON.stringify(value):value);
   await w.client.query(`INSERT INTO control_loop_improvement_commands(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,values);
  };
  await insert('claim',null);
  const observed=await e.adapter.start(commandId,binding,()=>{});
  await insert('result',{state:'accepted',revision:observed.revision,adapterId:e.adapter.adapterId,loopRunId:binding.loopRunId,
   toolingRevision:e.adapter.toolingRevision,evidenceDigest:observed.receipts.find(receipt=>receipt.commandId===commandId)!.evidenceDigest,error:null});
  const rows=()=>sql(pg,'SELECT row_to_json(r)::text bytes FROM control_loop_improvement_commands r ORDER BY command_id,entry_kind');
  const before=(await rows()).rows;
  await assert.rejects(sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${up}\nSELECT 1/0;COMMIT;`,[],'migrator'),{code:'22012'});
  assert.deepEqual((await rows()).rows,before);
  await sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${up}\nCOMMIT;`,[],'migrator');
  await selectionUp(pg);
  assert.deepEqual((await rows()).rows,before,'upgrade preserves every legacy signed byte');
  assert.equal(await readPrivateWebSchemaDigest(w.client),privateWebSchemaDigest);
  const released:string[]=[],adapter={...e.adapter,providerRoutes:undefined,releaseCommandFiles:async(id:string)=>{released.push(id);}};
  const restarted=new ImproveControlRoomLoopServiceV1(w.client,scope,{integrityKey:KEY,adapter});
  const replay=await restarted.mutate(identity,project,id,'start',body,key);
  assert.equal(replay.replayed,true);assert.equal(replay.state,'accepted');
  assert.equal(e.calls.filter(c=>c.op==='start').length,1,'legacy replay never redispatches');
  assert.ok(released.includes(commandId),'the signed legacy completed Start is eligible for sweep');
  assert.deepEqual((await rows()).rows,before,'replay and sweep never rewrite historical bindings');
  assert.equal((await restarted.status(identity,project,id)).display.canStop,true);
  await assert.rejects(restarted.mutate(identity,project,id,'start',body,'s4-native-new-route-less-0001'),{code:'invalid_request'});
  const stop=await restarted.mutate(identity,project,id,'stop',{runLinkId:body.runLinkId},'s4-native-legacy-stop-0001');
  assert.equal(stop.state,'accepted');assert.equal(e.calls.filter(c=>c.op==='stop').length,1);
  assert.deepEqual((await sql(pg,'SELECT row_to_json(r)::text bytes FROM control_loop_improvement_commands r WHERE command_id=$1 ORDER BY entry_kind',[commandId])).rows,
   before.filter(row=>JSON.parse(row.bytes).command_id===commandId));
  console.log('S4 legacy route-less signature=verified signed-bytes=unchanged failed-upgrade=atomic replay=no-dispatch sweep=verified Stop=accepted new-route-less=refused');
 }finally{await w.close();}
}));
