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
// Dedicated 60280..60289 range; no other component/attack-kit suite uses it.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 60280);
const scope={tenantId:"tenant:b1b",workspaceId:"workspace:b1b"}, project="project:b1b",owner="identity:b1b", KEY=new Uint8Array(32).fill(67);
const at=new Date(Date.now()-60000).toISOString(),expires=new Date(Date.now()+3600000).toISOString();
const identity:VerifiedWebIdentity={provider:"test",subject:owner,tokenDigest:sha256Digest({session:"b1b"}),issuedAt:at,expiresAt:expires,verificationExpiresAt:expires};
const settingsText=JSON.stringify({project:{host_adapter:"local-loop"},fixture:"SYNTHETIC"});
async function sql(pg:Pg,query:string,params:unknown[]=[],role="admin",database=pg.database){
  const client=new Client(role==="admin"?pg.admin({database}):pg.connection(role,{database}));await client.connect();
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
function engine(){
  const toolingRevision=`sha256:${"a".repeat(64)}`,runs=new Map<string,LoopEngineStatusV1>(),calls:{op:string;id:string}[]=[];
  const contract={toolingRevision,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),
    matchesSavedInput:(_r:unknown,o:{settingsDigest:string;confirmation:{path:string}},input:{settingsText:string})=>o.settingsDigest===loopByteHashV1(input.settingsText)&&o.confirmation.path==="request.md"};
  const apply=async(op:string,id:string,b:LoopBridgeBindingV1,text?:string)=>{
    calls.push({op,id});let s=runs.get(b.loopRunId);
    if(op==="intake")s={run:{adapterId:"adapter:synthetic",loopRunId:b.loopRunId,toolingRevision,a2SchemaVersion:1},revision:1,inputVersion:1,state:"draft",description:text!,settingsSha256:loopByteHashV1(settingsText),settingsDigest:loopByteHashV1(settingsText),confirmation:null,approval:null,question:null,progress:{step:"intake",completed:0,attention:"none"},receipts:[]};
    assert.ok(s);
    if(op==="confirm"){s.confirmation={path:"request.md",sha256:loopByteHashV1(s.description),who:"owner",at:new Date().toISOString(),input_version:s.inputVersion};s.state="ready";s.revision++;}
    if(op==="start"){s.state="running";s.revision++;}if(op==="stop"){s.state="stopped";s.revision++;}
    if(op==="answer"){s.question=null;s.state="running";s.revision++;}
    if(op==="approve"){s.approval=null;s.state="running";s.revision++;}
    s.receipts.push({commandId:id,bindingDigest:sha256Digest(b),state:"accepted",error:null,evidenceDigest:sha256Digest({op,id})});runs.set(b.loopRunId,s);return structuredClone(s);
  };
  const adapter:LoopAdapterV1={adapterId:"adapter:synthetic",toolingRevision,schemaDigest:`sha256:${"b".repeat(64)}`,settingsText,contract,
    reserveRun:()=>`fixture-run-${randomBytes(16).toString("hex")}`,available:()=>true,
    intake:(id,b,text)=>apply("intake",id,b,text),confirmRequest:(id,b)=>apply("confirm",id,b),start:(id,b)=>apply("start",id,b),stop:(id,b)=>apply("stop",id,b),
    approve:(id,b)=>apply("approve",id,b),answer:(id,b,text)=>apply("answer",id,b,text),status:async run=>{const s=runs.get(run);assert.ok(s);return structuredClone({...s,decisions:{observedAt:new Date().toISOString(),gate:
      ["stopped","finished"].includes(s.state)?null:s.question?{kind:"question",text:"SYNTHETIC saved owner question"}:s.approval?{kind:"approve"}:!s.confirmation?{kind:"confirm"}:null}});},close:async()=>{}};
  return {adapter,calls,runs};
}
function web(pg:Pg,adapter:LoopAdapterV1,database=pg.database){
  const login=pg.connection("web",{database}), config={host:"127.0.0.1",port:pg.port,database,username:login.user,password:login.password,majorVersion:17 as const};
  const bound=bindPrivatePgPool(new Pool({...privatePgOptions(config),host:login.host,max:1}));
  return {...bound,config,bridge:new ImproveControlRoomLoopServiceV1(bound.client,scope,{integrityKey:KEY,adapter}),desk:new ImproveControlRoomDeskServiceV1(bound.client,scope,KEY,undefined,Date.now,adapter.contract)};
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
    const started=await w.bridge.mutate(identity,project,id,"start",{expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},"b1b-pg-start-0001");assert.equal(started.state,"accepted");
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
  const body={expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId};
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
    await w.bridge.mutate(identity,project,id,"start",{expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},"b1b-pg-unique-0001");
    const original=(await sql(pg,"SELECT * FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0];
    const row={...original,command_id:`loop-command:${randomBytes(16).toString('hex')}`,idempotency_key:"b1b-pg-unique-0002"};
    const columns=Object.keys(row),values=Object.values(row).map(v=>v&&typeof v==='object'&&!(v instanceof Date)?JSON.stringify(v):v);
    await assert.rejects(sql(pg,`INSERT INTO control_loop_improvement_commands(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,values,"web"),{code:"23505"},"B1b SQL unique Start refusal");
  }finally{await w.close();}
}));

test("B1b empty down/re-up and failed migration roll back atomically",async()=>run(async pg=>{
  const baseline=await readPrivateWebSchemaDigest({query:async(q,p)=>sql(pg,q,p)});
  const down=await readFile("db/down/0302_control_loop_improvement_commands.sql","utf8"),up=await readFile("db/migrations/0302_control_loop_improvement_commands.sql","utf8");
  await sql(pg,down,[],"migrator");
  assert.equal((await sql(pg,"SELECT to_regclass('control_loop_improvement_commands') AS table")).rows[0].table,null);
  await assert.rejects(sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${up}\nSELECT 1/0;COMMIT;`,[],"migrator"),/division by zero/);
  assert.equal((await sql(pg,"SELECT to_regclass('control_loop_improvement_commands') AS table")).rows[0].table,null);
  await sql(pg,`BEGIN;SET LOCAL ROLE control_room_schema_owner;${up}\nCOMMIT;`,[],"migrator");
  await sql(pg,"GRANT SELECT,INSERT ON control_loop_improvement_commands TO control_room_private_web");
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
