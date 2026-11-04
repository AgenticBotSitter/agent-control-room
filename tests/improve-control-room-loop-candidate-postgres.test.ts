import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { collectLedgerEntries, ledgerDigest } from "../scripts/generate-migration-ledger.mjs";
import { withRealPostgres, requiresRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { readPrivateWebSchemaDigest, privateWebSchemaDigest, verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import { digestReleaseSchemaRowsV1 } from "../src/updater/v1/pg/release-schema-digest.mjs";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1 } from "../src/improve-control-room/v1/schemas";
import { sha256Digest } from "../src/security";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { DatabaseClient } from "../src/persistence/database";
import type { LoopCandidateCompletionReceiptV1 } from "../src/improve-control-room/v1/loop-candidate-wire";
const KEY=new Uint8Array(32).fill(64),now=Date.now(),origin="https://private.example.invalid";
const toolingRevision=sha256Digest({fixture:"SYNTHETIC B4 tooling"}),schemaDigest=sha256Digest({fixture:"SYNTHETIC B4 schema"});
const contract={toolingRevision,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),matchesSavedInput:()=>true};
type Pg=Parameters<Parameters<typeof withRealPostgres>[0]>[0];
const PORT=Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE??60340);
const scope={tenantId:"tenant:web",workspaceId:"workspace:web"},project="project:b4",owner="identity:web";
const at=new Date(now-60_000).toISOString(),expires=new Date(now+3600_000).toISOString();
const identity:VerifiedWebIdentity={provider:"test",subject:owner,tokenDigest:sha256Digest({session:"SYNTHETIC B4"}),issuedAt:at,expiresAt:expires,verificationExpiresAt:expires};
async function sql(pg:Pg,query:string,params:unknown[]=[],role="admin",database=pg.database){
 const c=new Client(role==="admin"?pg.admin({database}):pg.connection(role,{database}));await c.connect();try{return await c.query(query,params);}finally{await c.end();}
}
async function seed(pg:Pg,database=pg.database){
  await sql(pg,"INSERT INTO tenants(id,display_name) VALUES($1,'Fixture tenant')",[scope.tenantId],"admin",database);
  await sql(pg,"INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Fixture workspace')",[scope.workspaceId,scope.tenantId],"admin",database);
  await sql(pg,`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:b4',$1,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`,[scope.tenantId],"admin",database);
  await sql(pg,`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,'adapter:b4',$1,'1','Control Room','planned','manual_project_active','healthy','control_room_native',now(),
    '{"presentation":{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}}',now())`,[project,scope.tenantId,scope.workspaceId],"admin",database);
  await sql(pg,"INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES($1,$2,'active',1,now(),now())",[scope.tenantId,project],"admin",database);
  await sql(pg,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Fixture identity','test',$3,'active',$4,$4)`,[owner,scope.tenantId,sha256Digest({provider:"test",subject:owner}),at],"admin",database);
  await sql(pg,`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:b4',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,[scope.tenantId,owner,at],"admin",database);
  await sql(pg,"INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",[scope.tenantId,identity.tokenDigest,owner,at,expires],"admin",database);
}
function web(pg:Pg,database=pg.database){
 const login=pg.connection("web",{database}),config={host:"127.0.0.1",port:pg.port,database,username:login.user,password:login.password,majorVersion:17 as const};
 const bound=bindPrivatePgPool(new Pool({...privatePgOptions(config),host:login.host,max:1}));
 return {...bound,config};
}
type Fixture={client:DatabaseClient;db:DatabaseClient & {close():Promise<void>};identity:VerifiedWebIdentity;project:{projectId:string}};
async function run(work:(pg:Pg)=>Promise<void>){
 assert.ok(requiresRealPostgres(),"B4 PostgreSQL17 is required; never skip");
 const result=await withRealPostgres(work,{port:PORT,allowedPorts:Array.from({length:10},(_,i)=>PORT+i),database:"b4_candidates",boundMs:500000});
 assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);console.log("B4 PostgreSQL teardown cleanedUp=true leftovers=0");
}
async function syntheticFixture(f:Fixture) {
  const { ImproveControlRoomDeskServiceV1 } = await import("../src/improve-control-room/v1/service");
  const { ImproveControlRoomLoopServiceV1 } = await import("../src/web/v1/improve-control-room-loop-service");
  const { LoopCandidatePublisherV1, LoopCandidateStaleCompletionV1 } = await import("../src/improve-control-room/v1/loop-candidate-publisher");
  const { loopByteHashV1 } = await import("../src/web/v1/improve-control-room-loop-adapter");
  const { loopCandidateEvidenceSchemaV1 } = await import("../src/improve-control-room/v1/loop-candidate-wire");
  const { canonicalJson, hmacSha256Tag } = await import("../src/security");
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`,[f.project.projectId]);
  const settingsText='{"fixture":"SYNTHETIC B4"}', description="SYNTHETIC finished improvement";
  const run={adapterId:"adapter:synthetic",loopRunId:"synthetic-run:b4",toolingRevision,a2SchemaVersion:1 as const};
  const confirmedContract={...contract,matchesSavedInput:(_run:unknown,o:{settingsDigest:string;confirmation:{sha256:string}},i:{description:string;settingsText:string}) =>
    o.settingsDigest===loopByteHashV1(i.settingsText) && o.confirmation.sha256===loopByteHashV1(i.description)};
  let status: import("../src/web/v1/improve-control-room-loop-adapter").LoopEngineStatusV1={run,revision:4,inputVersion:"SYNTHETIC:1",state:"ready",description,
    settingsSha256:loopByteHashV1(settingsText),settingsDigest:loopByteHashV1(settingsText),
    confirmation:{path:"request.md",sha256:loopByteHashV1(description),at:new Date(now).toISOString(),who:"owner",input_version:"SYNTHETIC:1"},
    approval:null,question:null,progress:{step:"final",completed:1,attention:"none"},receipts:[]};
  const forbidden:string[]=[], unexpected=async()=>{forbidden.push("unexpected operation");throw new Error("SYNTHETIC forbidden");};
  const adapter:import("../src/web/v1/improve-control-room-loop-adapter").LoopAdapterV1={adapterId:run.adapterId,toolingRevision,schemaDigest,settingsText,contract:confirmedContract,
    reserveRun:()=>run.loopRunId,available:()=>true,status:async()=>structuredClone(status),intake:unexpected,confirmRequest:unexpected,approve:unexpected,answer:unexpected,
    start:async(id,b,fence)=>{fence();status={...status,state:"running",revision:5,receipts:[{commandId:id,bindingDigest:sha256Digest(b),state:"accepted",error:null,evidenceDigest:sha256Digest({fixture:"SYNTHETIC Start"})}]};return structuredClone(status);},
    stop:unexpected,close:async()=>{}};
  const lineage=new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,confirmedContract);
  const draft=await lineage.saveLoopDraft(f.identity,f.project.projectId,{description,settingsText},"b4-synthetic-draft-0001");
  const link=await lineage.recordLoopRunLink({projectId:f.project.projectId,requestId:draft.request.requestId,initialInputVersion:1,run});
  await lineage.authorizeLoopStart(f.identity,f.project.projectId,{requestId:draft.request.requestId,expectedVersion:1,runLinkId:link.runLink.runLinkId,
    requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1(settingsText)},"b4-synthetic-start-0001",{
    inputVersion:status.inputVersion,settingsDigest:status.settingsDigest,revision:status.revision,confirmation:status.confirmation!});
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter},()=>now);
  await bridge.mutate(f.identity,f.project.projectId,draft.request.requestId,"start",{expectedVersion:1,expectedRevision:4,runLinkId:link.runLink.runLinkId},"b4-synthetic-start-0001");
  const head="b".repeat(40),base="a".repeat(40),d=sha256Digest({fixture:"SYNTHETIC B4 custody"});
  const startedAt=new Date(now-1000).toISOString(),endedAt=new Date(now).toISOString();
  let evidence:import("../src/improve-control-room/v1/loop-candidate-wire").LoopCandidateEvidenceV1=loopCandidateEvidenceSchemaV1.parse({schemaVersion:1,
    binding:{projectId:f.project.projectId,requestId:draft.request.requestId,runLinkId:link.runLink.runLinkId,localVersion:1,...run,a2InputVersion:"SYNTHETIC:1",engineRevision:6,
      requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1(settingsText),baseRevision:base,candidateRevision:head,inputsDigest:d,recipeDigest:d,environmentDigest:d},
    summary:"SYNTHETIC finished candidate",changedAreas:["Owner finish card"],databaseChanges:{kind:"none"},
    checks:[{id:"check:synthetic",required:true,commandLabel:"SYNTHETIC fixture checks",receiptDigest:d,outputDigest:d,candidateRevision:head,status:"PASS",exitCode:0,
      completed:3,passed:3,failed:0,skipped:0,durationMs:1000,startedAt,endedAt}],
    reviews:[{current:true,stepId:"review:final",role:"final",attempt:2,requestedModel:"SYNTHETIC final",observedModel:"SYNTHETIC observed",identityVerified:true,
      family:"synthetic-reviewer",verdict:"CLEAN",candidateRevision:head,inputVersion:"SYNTHETIC:1",reportDigest:d,sidecarDigest:d,startedAt,endedAt},
      {current:false,stepId:"review:old",role:"code",attempt:1,requestedModel:"SYNTHETIC requested",observedModel:null,identityVerified:false,
        family:null,verdict:"NEEDS-FIX",candidateRevision:base,inputVersion:"SYNTHETIC:1",reportDigest:d,sidecarDigest:d,startedAt,endedAt}],
    findings:[{origin:"review:old",id:"finding:one",severity:"HIGH",disposition:"FIXED",summary:"SYNTHETIC repair retained",evidenceDigest:d}],
    rounds:{attempts:2,reviewRejections:1,repairs:1,redesigns:0},timing:{startedAt,finishedAt:endedAt,durationMs:1000},
    assumptions:[{id:"assumption:one",text:"SYNTHETIC input validated",status:"validated",evidenceDigest:d}],
    validations:[{id:"validation:one",text:"SYNTHETIC receipt checked",status:"PASS",evidenceDigest:d}],
    overrides:{allowSameFamilyReview:false,allowStandardFinal:false,waivedConflicts:[],fallback:null},completionDigest:d,retentionDigest:d});
  status={...status,state:"finished",revision:6};
  let calls=0,unavailable=false,dirty=false;
  const fs=await import("node:fs"),path=await import("node:path"),crypto=await import("node:crypto");
  fs.mkdirSync(path.resolve(".test-tmp"),{recursive:true});
  const retained=fs.mkdtempSync(path.resolve(".test-tmp/b4-retained-")),rootIdentity=fs.lstatSync(retained);
  const bytesDigest=(bytes:string|Buffer)=>`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  const recipe={argv:["synthetic-check","--fixture"],parser:"SYNTHETIC counts/v1",requiredIds:["check:synthetic"]};
  const output="completed=3 passed=3 failed=0 skipped=0\n";
  const rawReceipt={schemaVersion:1,argv:recipe.argv,parser:recipe.parser,candidateRevision:head,baseRevision:base,
    requestSha256:evidence.binding.requestSha256,settingsSha256:evidence.binding.settingsSha256,inputsDigest:d,
    recipeDigest:sha256Digest(recipe),environmentDigest:d,buildAttempt:2,inputVersion:"SYNTHETIC:1",exitCode:0,
    completed:3,passed:3,failed:0,skipped:0,startedAt,endedAt,durationMs:1000,outputDigest:bytesDigest(output)};
  const receiptBytes=JSON.stringify(rawReceipt);
  evidence.binding.recipeDigest=sha256Digest(recipe);evidence.checks[0]!.receiptDigest=bytesDigest(receiptBytes);evidence.checks[0]!.outputDigest=bytesDigest(output);
  let proof={argv:true,output:true,seals:true,approvals:true,policy:true,retention:true};
  const writeRetained=()=>{
    const {completionDigest:_completion,retentionDigest:_retention,...terminalEvidence}=evidence;
    const terminal=JSON.stringify({schemaVersion:1,state:"finished",evidence:terminalEvidence});
    evidence.completionDigest=bytesDigest(terminal);
    const retention=JSON.stringify({terminalDigest:bytesDigest(terminal),receiptDigest:bytesDigest(receiptBytes),outputDigest:bytesDigest(output)});
    evidence.retentionDigest=bytesDigest(retention);
    fs.writeFileSync(path.join(retained,"terminal.json"),terminal);fs.writeFileSync(path.join(retained,"retention.json"),retention);
    const manifest=JSON.stringify({evidence,receiptDigest:bytesDigest(receiptBytes),outputDigest:bytesDigest(output),
      policy:{ownerApprovals:proof.approvals,checkerEligible:proof.policy,builderFamily:"synthetic-builder",finalFamily:"synthetic-reviewer"},
      retentionDigest:proof.retention?evidence.retentionDigest:sha256Digest({wrong:"retention"})});
    fs.writeFileSync(path.join(retained,"completion.json"),manifest);
    fs.writeFileSync(path.join(retained,"completion.auth"),proof.seals?hmacSha256Tag(KEY,{fixture:"SYNTHETIC retained manifest",manifest}):`hmac-sha256:${"0".repeat(64)}`);
    fs.writeFileSync(path.join(retained,"receipt.json"),proof.argv?receiptBytes:JSON.stringify({...rawReceipt,argv:["different-check"]}));
    fs.writeFileSync(path.join(retained,"output.txt"),proof.output?output:"completed=999 passed=999 failed=0 skipped=0\n");
  };
  writeRetained();
  const source={toolingRevision,schemaDigest,readVerifiedCompletion:async(runLinkId:string)=>{
    calls++;if(unavailable)throw new Error("SYNTHETIC unavailable");if(status.state!=="finished")throw new LoopCandidateStaleCompletionV1();
    const fail=()=>{throw new Error("SYNTHETIC custody verification refused");};
    const current=fs.lstatSync(retained);
    if(runLinkId!==link.runLink.runLinkId || current.isSymbolicLink() || !current.isDirectory()
      || current.dev!==rootIdentity.dev || current.ino!==rootIdentity.ino)fail();
    for(const name of ["completion.json","completion.auth","receipt.json","output.txt","terminal.json","retention.json"]){
      const st=fs.lstatSync(path.join(retained,name));if(!st.isFile()||st.isSymbolicLink()||st.size>131072)fail();
    }
    const manifest=fs.readFileSync(path.join(retained,"completion.json"),"utf8"),seal=fs.readFileSync(path.join(retained,"completion.auth"),"utf8");
    if(seal!==hmacSha256Tag(KEY,{fixture:"SYNTHETIC retained manifest",manifest}))fail();
    const saved=JSON.parse(manifest),raw=fs.readFileSync(path.join(retained,"receipt.json")),out=fs.readFileSync(path.join(retained,"output.txt"));
    if(bytesDigest(raw)!==saved.receiptDigest||bytesDigest(out)!==saved.outputDigest
      || !saved.policy.ownerApprovals || !saved.policy.checkerEligible || saved.policy.builderFamily===saved.policy.finalFamily
      || saved.retentionDigest!==saved.evidence.retentionDigest
      || bytesDigest(fs.readFileSync(path.join(retained,"terminal.json")))!==saved.evidence.completionDigest
      || bytesDigest(fs.readFileSync(path.join(retained,"retention.json")))!==saved.evidence.retentionDigest
      || saved.evidence.reviews.find((r:{current:boolean;role:string})=>r.current&&r.role==="final")?.family!==saved.policy.finalFamily)fail();
    const receipt=JSON.parse(raw.toString("utf8")),e=saved.evidence as typeof evidence,b=e.binding,c=e.checks[0];
    if(!c || e.checks.length!==recipe.requiredIds.length || c.id!==recipe.requiredIds[0] || !c.required || canonicalJson(receipt.argv)!==canonicalJson(recipe.argv)||receipt.parser!==recipe.parser
      || b.recipeDigest!==sha256Digest(recipe)||receipt.candidateRevision!==b.candidateRevision||receipt.baseRevision!==b.baseRevision
      || receipt.requestSha256!==b.requestSha256||receipt.settingsSha256!==b.settingsSha256||receipt.inputVersion!==b.a2InputVersion
      || receipt.inputsDigest!==b.inputsDigest||receipt.environmentDigest!==b.environmentDigest
      || c.receiptDigest!==bytesDigest(raw)||c.outputDigest!==bytesDigest(out)
      || receipt.completed!==c.completed||receipt.passed!==c.passed||receipt.failed!==c.failed||receipt.skipped!==c.skipped
      || receipt.exitCode!==c.exitCode||receipt.startedAt!==c.startedAt||receipt.endedAt!==c.endedAt||receipt.durationMs!==c.durationMs
      || out.toString("utf8")!==`completed=${c.completed} passed=${c.passed} failed=${c.failed} skipped=${c.skipped}\n`)fail();
    return structuredClone(e);
  }};
  let observations=0,stopAt=Infinity,repositoryHead=head;
  const repository={observe:async()=>{observations++;if(observations===stopAt)status={...status,state:"stopped"};if(dirty)throw new Error("SYNTHETIC dirty repository");return {baseRevision:base,candidateRevision:repositoryHead,
    changedPaths:["src/fixture.ts"],addedPaths:["src/fixture.ts"],commitSubjects:["SYNTHETIC candidate"]};}};
  const config={integrityKey:KEY,contract:confirmedContract,schemaDigest,source,repository};
  const desk=new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,confirmedContract,config);
  const publisher=new LoopCandidatePublisherV1(desk,config);
  return {...f,config,adapter,desk,lineage,bridge,publisher,forbidden,requestId:draft.request.requestId,runLinkId:link.runLink.runLinkId,
    evidence:()=>structuredClone(evidence),edit:(change:(e:typeof evidence)=>void)=>{change(evidence);writeRetained();},retained,calls:()=>calls,
    unavailable:(v:boolean)=>{unavailable=v;},stop:()=>{status={...status,state:"stopped"};},stopAtLastSnapshot:()=>{stopAt=observations+2;},moveRepositoryHead:(v:string)=>{repositoryHead=v;},dirty:(v:boolean)=>{dirty=v;},proof:(name:keyof typeof proof,v:boolean)=>{proof={...proof,[name]:v};writeRetained();},
    publish:()=>publisher.publishCompletion({runLinkId:link.runLink.runLinkId,completionDigest:evidence.completionDigest}),
    close:async()=>{await bridge.close();await f.db.close();fs.rmSync(retained,{recursive:true,force:true});}};
}


test("B4 PostgreSQL fresh production login exact grants preflight and schema digest",async()=>run(async pg=>{
 await seed(pg);const w=web(pg);const f=await syntheticFixture({client:w.client,db:{...w.client,close:w.close},identity,project:{projectId:project}});
 try{
  assert.deepEqual((await w.client.query("SELECT current_user,session_user")).rows,[{current_user:"control_room_web",session_user:"control_room_web"}]);
  const measured=await readPrivateWebSchemaDigest(w.client);
  const updater=digestReleaseSchemaRowsV1((await w.client.query(await readFile("src/updater/v1/pg/release-schema-digest.sql","utf8"))).rows);
  console.log(`B4 native schema_digest=${measured} updater_digest=${updater}`);
  assert.equal(measured,privateWebSchemaDigest);assert.equal(updater,measured);
  assert.equal(JSON.parse(await readFile("src/updater/v1/policy/release-schema-digest.json","utf8")).digest,measured);
  await verifyPrivateDatabase(w.client,w.config,{...scope,ownerIdentityId:owner,issuer:"test"},now,{nativeQueue:true});
  const count=(await sql(pg,"SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).rows[0].n;
  assert.equal(count,262);console.log(`B4 native public_catalog=${count} application_catalog=${count-1}`);
  for(const table of ["control_loop_update_candidates","control_loop_update_candidate_decisions"]){
   for(const role of ["app","scheduler","coordinator","results","publisher","queueWorker","intake","news","fleet"])
    await assert.rejects(sql(pg,`SELECT * FROM ${table}`,[],role),{code:"42501"},`B4 broad role ${role} denied`);
   for(const role of ["control_room_reader","control_room_backup"])assert.equal((await sql(pg,"SELECT has_table_privilege($1,$2,'SELECT,INSERT') yes",[role,table])).rows[0].yes,false);
   for(const right of ["SELECT","INSERT"])assert.equal((await sql(pg,"SELECT has_table_privilege('control_room_web',$1,$2) yes",[table,right])).rows[0].yes,true);
   for(const right of ["UPDATE","DELETE","TRUNCATE"])assert.equal((await sql(pg,"SELECT has_table_privilege('control_room_web',$1,$2) yes",[table,right])).rows[0].yes,false);
  }
  // 0305 B6 roster master: same production treatment, plus UPDATE on exactly the edit-in-place columns.
  const rosterUpdate:Record<string,string[]>={
   control_loop_roster_models:["cost","default_effort","efforts","family","launcher","max_build_grade","model_class","nick","note","on_off","provider","roles","updated_at","updated_by"],
   control_loop_roster_state:["exported_sha256","exported_version","last_idempotency_key","last_request_digest","updated_at","version"]};
  for(const [table,columns] of Object.entries(rosterUpdate)){
   for(const role of ["app","scheduler","coordinator","results","publisher","queueWorker","intake","news","fleet"])
    await assert.rejects(sql(pg,`SELECT * FROM ${table}`,[],role),{code:"42501"},`B6 broad role ${role} denied`);
   for(const role of ["control_room_reader","control_room_backup"])assert.equal((await sql(pg,"SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') yes",[role,table])).rows[0].yes,false);
   for(const right of ["SELECT","INSERT"])assert.equal((await sql(pg,"SELECT has_table_privilege('control_room_web',$1,$2) yes",[table,right])).rows[0].yes,true);
   for(const right of ["UPDATE","DELETE","TRUNCATE"])assert.equal((await sql(pg,"SELECT has_table_privilege('control_room_web',$1,$2) yes",[table,right])).rows[0].yes,false);
   const updatable=(await sql(pg,"SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('control_room_web',attrelid,attnum,'UPDATE') ORDER BY attname COLLATE \"C\"",[table])).rows.map(r=>r.attname);
   assert.deepEqual(updatable,columns,`B6 ${table} web UPDATE columns`);
  }
  const receipt=await f.publish();assert.equal(receipt.state,"recorded");assert.equal((await f.publish()).state,"replayed");
  const card=(await f.desk.readLoopCandidate(identity,project,f.requestId)).candidate!;
  const body={candidateId:card.candidateId,expectedVersion:1,candidateRecordDigest:card.recordDigest,candidateRevision:card.candidateRevision,
    localVersion:card.localVersion,a2InputVersion:card.a2InputVersion,decision:"accept"};
  assert.equal((await f.desk.decideLoopCandidate(identity,body,"b4-pg-decision-0001")).replayed,false);
  assert.equal((await f.desk.decideLoopCandidate(identity,body,"b4-pg-decision-0001")).replayed,true);
  assert.deepEqual(f.forbidden,[]);
  const before=(await sql(pg,"SELECT row_to_json(c)::text bytes FROM control_loop_update_candidates c")).rows;
  for(const statement of ["UPDATE control_loop_update_candidates SET created_at=created_at","DELETE FROM control_loop_update_candidates","TRUNCATE control_loop_update_candidates"])
   await assert.rejects(sql(pg,statement,[],"web"),{code:"42501"});
  await assert.rejects(sql(pg,await readFile("db/down/0303_control_loop_update_candidates.sql","utf8")),/retained/);
  assert.deepEqual((await sql(pg,"SELECT row_to_json(c)::text bytes FROM control_loop_update_candidates c")).rows,before);
 }finally{await f.close();}
}));

test("B4 PostgreSQL 24 publication callers and decision contenders preserve one row",async()=>run(async pg=>{
 await seed(pg);const setup=web(pg),f=await syntheticFixture({client:setup.client,db:{...setup.client,close:setup.close},identity,project:{projectId:project}});
 const clients=Array.from({length:24},()=>web(pg));
 try{
  const {ImproveControlRoomDeskServiceV1}=await import("../src/improve-control-room/v1/service");
  const desks=clients.map(w=>new ImproveControlRoomDeskServiceV1(w.client,scope,KEY,undefined,()=>now,f.config.contract,f.config));
  const blocker=new Client(pg.admin());await blocker.connect();
  let waiting=0;
  let pending:Promise<PromiseSettledResult<LoopCandidateCompletionReceiptV1>[]>|undefined;
  try{
   await blocker.query("BEGIN");await blocker.query("SELECT id FROM control_identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[scope.tenantId,owner]);
   pending=Promise.allSettled(desks.map(d=>d.recordLoopCandidate(f.evidence())));
   // PostgreSQL caches statistics for this transaction; refresh before each sample.
   for(let attempt=0;attempt<200;attempt++){
    await blocker.query("SELECT pg_stat_clear_snapshot()");
    waiting=Number((await blocker.query("SELECT count(*) n FROM pg_stat_activity WHERE usename='control_room_web' AND wait_event_type='Lock'")).rows[0].n);
    if(waiting>=24)break;await new Promise(r=>setTimeout(r,10));
   }
   assert.equal(waiting,24,"B4 24 production connections really contend");await blocker.query("COMMIT");
   const outcomes=await pending;
   const receipts=outcomes.map(r=>{assert.equal(r.status,"fulfilled");return (r as PromiseFulfilledResult<LoopCandidateCompletionReceiptV1>).value;});
   assert.equal(new Set(receipts.map(r=>r.candidate.candidateId)).size,1);
   assert.equal(receipts.filter(r=>r.state==="recorded").length,1);assert.equal(receipts.filter(r=>r.state==="replayed").length,23);
  }finally{await blocker.query("ROLLBACK").catch(()=>{});await pending;await blocker.end();}
  const c=(await f.desk.readLoopCandidate(identity,project,f.requestId)).candidate!;
  const results=await Promise.allSettled(desks.map((d,i)=>d.decideLoopCandidate(identity,{candidateId:c.candidateId,expectedVersion:1,
    candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,localVersion:1,a2InputVersion:c.a2InputVersion,decision:i%2?"accept":"decline"},`b4-racing-decision-${String(i).padStart(4,"0")}`)));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1,"B4 exactly one accept/decline wins");
  assert.equal(results.filter(r=>r.status==="rejected").length,23);
  assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0].n,1);
  assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_update_candidate_decisions")).rows[0].n,1);
  console.log(`B4 loaded connections=24 lock_waiters=${waiting} publication_replays=23 decision_losers=23 candidates=1 decisions=1`);
 }finally{await Promise.all(clients.map(w=>w.close()));await f.close();}
}));

test("B4 PostgreSQL empty down re-up and failed migration preserve prior ledger",async()=>run(async pg=>{
 const admin=new Client(pg.admin());await admin.connect();
 try{
  const before=(await admin.query("SELECT * FROM control_room_schema_migrations WHERE filename NOT LIKE 'db/migrations/0303%' AND filename NOT LIKE 'db/migrations/0304%' AND filename NOT LIKE 'db/migrations/0305%' AND filename NOT LIKE 'db/migrations/0306%' AND filename NOT LIKE 'db/migrations/0307%' AND filename NOT LIKE 'db/migrations/0308%' AND filename NOT LIKE 'db/roles/%' ORDER BY ledger_order")).rows;
  await admin.query(await readFile("db/down/0308_control_loop_providers.sql","utf8"));
  await admin.query(await readFile("db/down/0307_control_loop_policy_validate.sql","utf8"));
  await admin.query(await readFile("db/down/0306_control_loop_policy.sql","utf8"));
  await admin.query(await readFile("db/down/0305_control_loop_roster.sql","utf8"));
  await admin.query(await readFile("db/down/0304_control_loop_candidate_start_authorization.sql","utf8"));
  await admin.query(await readFile("db/down/0303_control_loop_update_candidates.sql","utf8"));
  await admin.query("DELETE FROM control_room_schema_migrations WHERE filename LIKE 'db/migrations/0303%' OR filename LIKE 'db/migrations/0304%' OR filename LIKE 'db/migrations/0305%' OR filename LIKE 'db/migrations/0306%' OR filename LIKE 'db/migrations/0307%' OR filename LIKE 'db/migrations/0308%' OR filename LIKE 'db/roles/%'");
  const stage=await mkdtemp(resolve(".test-tmp/b4-ledger-"));
  try{
   await mkdir(join(stage,"db/migrations"),{recursive:true});await mkdir(join(stage,"deploy/postgres"),{recursive:true});
   const entries=await collectLedgerEntries(resolve("."));
   // The applier validates every ledger byte, including unchanged predecessors.
   for(const e of entries){await mkdir(dirname(join(stage,e.file)),{recursive:true});await writeFile(join(stage,e.file),await readFile(e.file));}
   await mkdir(join(stage,"db/setup"),{recursive:true});await writeFile(join(stage,"db/setup/production_migration_ledger.sql"),await readFile("db/setup/production_migration_ledger.sql"));
   const migration="db/migrations/0303_control_loop_update_candidates.sql",original=await readFile(migration,"utf8");
   const fault=original.replace("CREATE TABLE control_loop_update_candidate_decisions (","SELECT 1/0; CREATE TABLE control_loop_update_candidate_decisions (");
   await writeFile(join(stage,migration),fault);
   let staged=await collectLedgerEntries(stage);
   await writeFile(join(stage,"deploy/postgres/migration-ledger.json"),JSON.stringify({version:1,entries:staged,digest:ledgerDigest(staged)}));
   const migrate=async()=>applyMigrations({target:undefined,ledgerPath:join(stage,"deploy/postgres/migration-ledger.json"),rootDir:stage,bootstrapTarget:pg.admin(),migrateTarget:pg.connection("migrator"),env:{NODE_ENV:"test",CONTROL_ROOM_MIGRATOR_PASSWORD:pg.connection("migrator").password,CONTROL_ROOM_APP_PASSWORD:pg.connection("app").password,CONTROL_ROOM_SCHEDULER_PASSWORD:pg.connection("scheduler").password,CONTROL_ROOM_WORK_INTAKE_PASSWORD:pg.connection("control_room_work_intake_agent").password}});
   await assert.rejects(migrate(),/division by zero/);
   assert.equal((await admin.query("SELECT to_regclass('public.control_loop_update_candidates') name")).rows[0].name,null);
   assert.deepEqual((await admin.query("SELECT * FROM control_room_schema_migrations ORDER BY ledger_order")).rows,before);
   await writeFile(join(stage,migration),original);staged=await collectLedgerEntries(stage);
   await writeFile(join(stage,"deploy/postgres/migration-ledger.json"),JSON.stringify({version:1,entries:staged,digest:ledgerDigest(staged)}));
   await migrate();await migrate();assert.notEqual((await admin.query("SELECT to_regclass('public.control_loop_update_candidates') name")).rows[0].name,null);
  }finally{await rm(stage,{recursive:true,force:true});}
 }finally{await admin.end();}
}));

const rawCandidateInsert=async(client:DatabaseClient,e:import("../src/improve-control-room/v1/loop-candidate-wire").LoopCandidateEvidenceV1)=>client.query(`
 INSERT INTO control_loop_update_candidates(tenant_id,id,project_id,request_id,owner_identity_id,run_link_id,local_version,a2_input_version,
 candidate_revision,completion_digest,retention_digest,record_digest,auth_tag,payload,created_at)
 VALUES($1,'loop-candidate:sql-proof',$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
 [scope.tenantId,e.binding.projectId,e.binding.requestId,owner,e.binding.runLinkId,e.binding.localVersion,JSON.stringify(e.binding.a2InputVersion),
  e.binding.candidateRevision,e.completionDigest,e.retentionDigest,sha256Digest({fixture:"SYNTHETIC raw SQL"}),`hmac-sha256:${"f".repeat(64)}`,JSON.stringify(e),new Date(now).toISOString()]);

test("B4 SQL current-input guard independently refuses wrong request bytes",async()=>run(async pg=>{
 await seed(pg);const w=web(pg),f=await syntheticFixture({client:w.client,db:{...w.client,close:w.close},identity,project:{projectId:project}});
 try{const e=f.evidence();e.binding.requestSha256="0".repeat(64);
  await assert.rejects(rawCandidateInsert(w.client,e),{sqlState:"23514"},"B4 SQL wrong request bytes are refused by current binding trigger");
 }finally{await f.close();}
}));

test("B4 SQL Start authorization guard refuses a claim bound to another A2 input version",async()=>run(async pg=>{
 await seed(pg);const w=web(pg),f=await syntheticFixture({client:w.client,db:{...w.client,close:w.close},identity,project:{projectId:project}});
 // Only the Start journal binding moves; candidate, input and authorization rows stay current.
 const startInputVersion=(value:string)=>sql(pg,`BEGIN;ALTER TABLE control_loop_improvement_commands DISABLE TRIGGER control_loop_commands_append_only;
  UPDATE control_loop_improvement_commands SET binding=jsonb_set(binding,'{inputVersion}',to_jsonb('${value}'::text)) WHERE request_id='${f.requestId}' AND operation='start';
  ALTER TABLE control_loop_improvement_commands ENABLE TRIGGER control_loop_commands_append_only;COMMIT;`);
 try{
  await startInputVersion("SYNTHETIC:9");
  await assert.rejects(rawCandidateInsert(w.client,f.evidence()),{sqlState:"23514"},"B4 SQL refuses a Start claim whose input version differs from its authorization");
  await startInputVersion("SYNTHETIC:1");await rawCandidateInsert(w.client,f.evidence());
 }finally{await f.close();}
}));

test("B4 SQL completed-check guard independently refuses zero counts",async()=>run(async pg=>{
 await seed(pg);const w=web(pg),f=await syntheticFixture({client:w.client,db:{...w.client,close:w.close},identity,project:{projectId:project}});
 try{const e=f.evidence();e.checks[0]!.completed=0;e.checks[0]!.passed=0;
  await assert.rejects(rawCandidateInsert(w.client,e),{sqlState:"23514"},"B4 SQL zero counts are refused by required check trigger");
 }finally{await f.close();}
}));

test("B4 SQL decision owner grant independently refuses revoked authority",async()=>run(async pg=>{
 await seed(pg);const w=web(pg),f=await syntheticFixture({client:w.client,db:{...w.client,close:w.close},identity,project:{projectId:project}});
 try{const r=await f.publish();await sql(pg,"UPDATE control_role_grants SET revoked_at=now() WHERE identity_id=$1",[owner]);
  await assert.rejects(w.client.query(`INSERT INTO control_loop_update_candidate_decisions(tenant_id,id,candidate_id,project_id,owner_identity_id,
   candidate_record_digest,candidate_revision,idempotency_key,decision,decision_digest,auth_tag,candidate_version,decided_at)
   VALUES($1,'loop-decision:sql-proof',$2,$3,$4,$5,$6,'b4-sql-grant-00001','accept',$7,$8,1,$9)`,
   [scope.tenantId,r.candidate.candidateId,project,owner,r.candidate.recordDigest,r.candidate.candidateRevision,
    sha256Digest({fixture:"SYNTHETIC SQL decision"}),`hmac-sha256:${"f".repeat(64)}`,new Date(now).toISOString()]),
   {sqlState:"23514"},"B4 SQL revoked owner cannot insert an inert decision");
 }finally{await f.close();}
}));

test("B4 SQL append-only guard refuses schema-owner changes",async()=>run(async pg=>{
 const c=new Client(pg.admin());await c.connect();try{
  await c.query("SET ROLE control_room_schema_owner");
  await assert.rejects(c.query("UPDATE control_loop_update_candidates SET created_at=created_at"),/append.only/i,"B4 SQL schema owner cannot rewrite candidates");
  await assert.rejects(c.query("UPDATE control_loop_update_candidate_decisions SET decided_at=decided_at"),/append.only/i,"B4 SQL schema owner cannot rewrite decisions");
 }finally{await c.end();}
}));

test("B4 SQL broad application role denial is independent",async()=>run(async pg=>{
 assert.equal((await sql(pg,"SELECT has_table_privilege('control_room_app','control_loop_update_candidates','SELECT') yes")).rows[0].yes,false,"B4 application login has no candidate SELECT");
 assert.equal((await sql(pg,"SELECT has_table_privilege('control_room_app','control_loop_update_candidate_decisions','INSERT') yes")).rows[0].yes,false,"B4 application login has no decision INSERT");
}));

async function migrateRoot(pg:Pg,rootDir:string){
 return applyMigrations({target:undefined,rootDir,ledgerPath:join(rootDir,"deploy/postgres/migration-ledger.json"),bootstrapTarget:pg.admin(),migrateTarget:pg.connection("migrator"),
  env:{NODE_ENV:"test",CONTROL_ROOM_MIGRATOR_PASSWORD:pg.connection("migrator").password,CONTROL_ROOM_APP_PASSWORD:pg.connection("app").password,
   CONTROL_ROOM_SCHEDULER_PASSWORD:pg.connection("scheduler").password,CONTROL_ROOM_WORK_INTAKE_PASSWORD:pg.connection("control_room_work_intake_agent").password}});
}

test("B4 BASE upgrade preserves signed 0301 and 0302 history",async()=>run(async pg=>{
 const stage=await mkdtemp(resolve(".test-tmp/b4-base-")),base="11fba7c7899319ee0e21e5849bd77f010b1f2cc0";
 let fixture:Awaited<ReturnType<typeof syntheticFixture>>|undefined;
 try{
  // Reconstruct only the supplied base's immutable migration inputs; never another worktree.
  const files=execFileSync("git",["ls-tree","-r","--name-only",base,"--","db/","deploy/postgres/migration-ledger.json"],{encoding:"utf8",maxBuffer:8*1024*1024}).trim().split("\n");
  assert.ok(files.includes("db/migrations/0302_control_loop_improvement_commands.sql"));assert.ok(!files.includes("db/migrations/0303_control_loop_update_candidates.sql"));
  for(const file of files){await mkdir(dirname(join(stage,file)),{recursive:true});await writeFile(join(stage,file),execFileSync("git",["show",`${base}:${file}`],{maxBuffer:8*1024*1024}));}
  const admin=new Client(pg.admin());await admin.connect();try{
   await admin.query(await readFile("db/down/0308_control_loop_providers.sql","utf8"));
   await admin.query(await readFile("db/down/0307_control_loop_policy_validate.sql","utf8"));
   await admin.query(await readFile("db/down/0306_control_loop_policy.sql","utf8"));
  await admin.query(await readFile("db/down/0305_control_loop_roster.sql","utf8"));
   await admin.query(await readFile("db/down/0304_control_loop_candidate_start_authorization.sql","utf8"));
   await admin.query(await readFile("db/down/0303_control_loop_update_candidates.sql","utf8"));
   await admin.query("DELETE FROM control_room_schema_migrations WHERE filename LIKE 'db/migrations/0303%' OR filename LIKE 'db/migrations/0304%' OR filename LIKE 'db/migrations/0305%' OR filename LIKE 'db/migrations/0306%' OR filename LIKE 'db/migrations/0307%' OR filename LIKE 'db/migrations/0308%' OR filename LIKE 'db/roles/%'");
  }finally{await admin.end();}
  await migrateRoot(pg,stage);await seed(pg);
  const w=web(pg);fixture=await syntheticFixture({client:w.client,db:{...w.client,close:w.close},identity,project:{projectId:project}});
  const tables=["control_loop_improvement_requests","control_loop_improvement_inputs","control_loop_improvement_run_links","control_loop_improvement_authorizations","control_loop_improvement_commands"];
  const snapshot=async()=>JSON.stringify(await Promise.all(tables.map(async table=>({table,rows:(await sql(pg,`SELECT row_to_json(t)::text bytes FROM ${table} t ORDER BY created_at,record_digest`)).rows}))));
  const before=await snapshot();
  const upgraded=await migrateRoot(pg,resolve("."));assert.ok(upgraded.applied!.some(e=>e.file.endsWith("0303_control_loop_update_candidates.sql")));assert.ok(upgraded.applied!.some(e=>e.file.endsWith("0304_control_loop_candidate_start_authorization.sql")));
  const {readMacGrantCatalogV1,desiredMacGrantsV1,diffMacGrantsV1,applyMacGrantDiffV1}=await import("../scripts/mac-local/database-upgrade-grants.mjs");
  const roleFiles=["private_web_roles.sql","task_coordinator_roles.sql","native_queue_producer_roles.sql","native_results_roles.sql","local_result_publisher_roles.sql","native_queue_worker_roles.sql","agent_reviewer_roles.sql","fleet_gateway_roles.sql"];
  const sources=Object.fromEntries(await Promise.all(roleFiles.map(async name=>[name,await readFile(join("db/roles",name),"utf8")])));
  const roles=new Client(pg.admin());await roles.connect();try{
   await roles.query(await readFile("db/roles/agent_reviewer_roles.sql","utf8"));
   await roles.query("BEGIN");await applyMacGrantDiffV1(roles,diffMacGrantsV1(await readMacGrantCatalogV1(roles),desiredMacGrantsV1(sources)));await roles.query("COMMIT");}finally{await roles.end();}
  assert.equal((await migrateRoot(pg,resolve("."))).applied!.length,0);
  assert.equal(await snapshot(),before,"B4 BASE signed history remains byte-identical");
  for(const table of ["control_loop_update_candidates","control_loop_update_candidate_decisions"])assert.equal((await sql(pg,`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
  assert.equal((await fixture.publish()).state,"recorded");assert.equal(await snapshot(),before);
  console.log("B4 BASE upgrade signed_0301_0302_unchanged=true backfill=0 idempotent=true production_publication=true");
 }finally{await fixture?.close();await rm(stage,{recursive:true,force:true});}
}));

test("B4 prior release upgrade preserves actual signed legacy data",{timeout:600000},async()=>{
 // Reuse the shipped prior-release fixture and its actual three signed requests,
 // three candidates and two decisions. This precise existing test now upgrades
 // through 0303 too; historical expectations remain unchanged in its source.
 const {promisify}=await import("node:util"),{execFile}=await import("node:child_process");
 const exec=promisify(execFile),env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_PG_TEST_PORT_BASE:String(PORT)};delete env.NODE_TEST_CONTEXT;
 const child=await exec(process.execPath,["scripts/run-tests-with-quarantine.mjs","--import","tsx","--test","--test-concurrency=1","--test-timeout=600000",
  "--test-name-pattern=^B1a upgrade 2e5c622aa240eb06787764b7b2f3a9129e17f9cf$","tests/improve-control-room-desk-postgres.test.ts"],{env,timeout:600000,maxBuffer:8*1024*1024});
 assert.match(child.stdout,/# pass 1/u);assert.match(child.stdout,/# fail 0/u);assert.match(child.stdout,/legacy_requests=3 legacy_candidates=3 decisions=2/u);
 console.log("B4 prior-release signed_history=true legacy_decisions=2 production_upgrade=true");
});

test("B4 SQL unique decision floor refuses a second consumption",async()=>run(async pg=>{
 await seed(pg);const w=web(pg),f=await syntheticFixture({client:w.client,db:{...w.client,close:w.close},identity,project:{projectId:project}});
 try{
  await f.publish();const c=(await f.desk.readLoopCandidates(identity)).candidates[0]!;
  await f.desk.decideLoopCandidate(identity,{candidateId:c.candidateId,expectedVersion:1,candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,
   localVersion:1,a2InputVersion:c.a2InputVersion,decision:"accept"},"b4-pg-unique-first-0001");
  // Isolate the unique constraint from the independently tested INSERT trigger.
  await sql(pg,"ALTER TABLE control_loop_update_candidate_decisions DISABLE TRIGGER control_loop_update_candidate_decisions_binding");
  await assert.rejects(w.client.query(`INSERT INTO control_loop_update_candidate_decisions(tenant_id,id,candidate_id,project_id,owner_identity_id,
   candidate_record_digest,candidate_revision,idempotency_key,decision,decision_digest,auth_tag,candidate_version,decided_at)
   SELECT tenant_id,'loop-decision:second',candidate_id,project_id,owner_identity_id,candidate_record_digest,candidate_revision,
   'b4-pg-unique-second-0001',decision,decision_digest,auth_tag,candidate_version,decided_at FROM control_loop_update_candidate_decisions`),
   {sqlState:"23505"},"B4 SQL unique candidate consumption floor refuses a second decision");
 }finally{await f.close();}
}));

test("B4 PostgreSQL interrupt before commit and lost receipt after commit reconstruct once",async()=>run(async pg=>{
 await seed(pg);const w=web(pg),f=await syntheticFixture({client:w.client,db:{...w.client,close:w.close},identity,project:{projectId:project}});
 const {ImproveControlRoomDeskServiceV1}=await import("../src/improve-control-room/v1/service");
 const {loopCandidateCompletionReceiptSchemaV1}=await import("../src/improve-control-room/v1/loop-candidate-wire");
 let interrupt=true,lose=false,captured:unknown;
 const trace=(tx:import("../src/persistence/database").DatabaseSession):import("../src/persistence/database").DatabaseSession=>({query:async<T>(statement:string,params?:unknown[])=>{
  const result=await tx.query<T>(statement,params);
  if(interrupt&&statement.includes("INSERT INTO control_loop_update_candidates("))throw new Error("SYNTHETIC interrupt before commit");
  return result;
 }});
 const client:DatabaseClient={query:w.client.query,transaction:async callback=>{
  const result=await w.client.transaction(tx=>callback(trace(tx)));
  if(lose&&result&&typeof result==="object"&&"candidate" in result){lose=false;captured=result;throw new Error("SYNTHETIC lost receipt after commit");}
  return result;
 },transactionWithPreCommitCheck:(callback,check)=>w.client.transactionWithPreCommitCheck(tx=>callback(trace(tx)),check)};
 const interrupted=new ImproveControlRoomDeskServiceV1(client,scope,KEY,undefined,()=>now,f.config.contract,f.config);
 try{
  await assert.rejects(interrupted.recordLoopCandidate(f.evidence()),/interrupt before commit/);
  assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0].n,0,"B4 pre-commit interruption rolls back its feature insert");
  interrupt=false;lose=true;await assert.rejects(interrupted.recordLoopCandidate(f.evidence()),/lost receipt after commit/);
  assert.equal((await sql(pg,"SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0].n,1);
  const committed=loopCandidateCompletionReceiptSchemaV1.parse(captured),reconstructed=await f.publish();
  assert.equal(reconstructed.state,"replayed");assert.deepEqual(reconstructed.candidate,committed.candidate);
  assert.deepEqual((await f.publish()).candidate,committed.candidate);assert.deepEqual(f.forbidden,[]);
  console.log("B4 native injected_commit_interruption=rolled_back injected_lost_receipt=replayed candidates=1 outward_actions=0");
 }finally{await f.close();}
}));

test("B4 inherited fixture preparation measures 261 tables and preserves refusals",{timeout:600000},async()=>{
 const {promisify}=await import("node:util"),{execFile}=await import("node:child_process");
 const exec=promisify(execFile),env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_PG_TEST_PORT_BASE:String(PORT)};delete env.NODE_TEST_CONTEXT;
 const child=await exec(process.execPath,["scripts/run-tests-with-quarantine.mjs","--import","tsx","--test","--test-concurrency=1","--test-timeout=600000",
  "--test-name-pattern=^B1a fixture preparation (shipped ownership|prepared|wrong owner|nonempty)$","tests/improve-control-room-desk-postgres.test.ts"],
  {env,timeout:600000,maxBuffer:8*1024*1024});
 assert.match(child.stdout,/# pass 4/u);assert.match(child.stdout,/# fail 0/u);assert.match(child.stdout,/catalog=261/u);assert.doesNotMatch(child.stdout,/# skipped [1-9]/u);
 console.log("B4 native inherited_fixture_cases=4 prepared_catalog=261 ownership_and_nonempty_refusals=true");
});

// S1: production-login storage, process-independent reopen, route withdrawal and exact grants.
test('S1 PostgreSQL provider persistence after application pool close and exact ACLs',async()=>run(async pg=>{
 const {LoopProviderServiceV1}=await import('../src/web/v1/loop-provider-service');
 await seed(pg);
 await sql(pg,`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
 VALUES($1,'synthetic/model',1,'synthetic-api','','','','','','','','on','','','',$2,now())`,[scope.tenantId,owner]);
 const p={provider_id:'provider-one',display_name:'Synthetic provider',base_url:'https://example.com/api',billing_kind:'token' as const,
  secret_ref:{kind:'launcher' as const,launcher:'synthetic-api'},models:[{roster_name:'synthetic/model',launcher:'synthetic-api',served_model_id:'served/old'}],
  credit_amount_nano_usd:'123000',credit_expires_on:'2027-01-31',credit_note:'Synthetic credit',price_source_url:null,price_source_format:null};
 let w=web(pg),service=new LoopProviderServiceV1(w.client,scope,undefined,()=>now);
 const expected={schema:'control-room.loop-provider-snapshot/v1',tenantId:scope.tenantId,version:1,providers:[p]};
 try{
  assert.deepEqual((await w.client.query('SELECT current_user,session_user')).rows,[{current_user:'control_room_web',session_user:'control_room_web'}]);
  assert.deepEqual(await service.upsert(identity,p.provider_id,{expectedVersion:0,provider:p},'s1-native-add-0001'),{replayed:false,version:1});
  assert.deepEqual(await service.view(identity),expected);
 }finally{await w.close();}
 // A genuinely new application pool on the same server/database; no migrations or reseed here.
 w=web(pg);service=new LoopProviderServiceV1(w.client,scope,undefined,()=>now);
 try{
  assert.deepEqual(await service.view(identity),expected);
  const rows=(await w.client.query('SELECT provider_id,display_name,base_url,billing_kind,secret_ref,credit_amount_nano_usd,credit_expires_on::text,credit_note,price_source_url,price_source_format,updated_by FROM control_loop_providers')).rows;
  const {models:_models,...stored}=p;assert.deepEqual(rows,[{...stored,updated_by:owner}]);
  assert.deepEqual((await w.client.query('SELECT provider_id,roster_name,launcher,served_model_id FROM control_loop_provider_models')).rows,[{provider_id:p.provider_id,...p.models[0]}]);
  await verifyPrivateDatabase(w.client,w.config,{...scope,ownerIdentityId:owner,issuer:'test'},now,{nativeQueue:true});
  const updates:Record<string,string[]>={control_loop_providers:['base_url','billing_kind','credit_amount_nano_usd','credit_expires_on','credit_note','display_name','price_source_format','price_source_url','secret_ref','updated_at','updated_by'],control_loop_provider_models:[],control_loop_provider_state:['last_idempotency_key','last_request_digest','updated_at','version']};
  for(const [table,columns] of Object.entries(updates)){
   for(const right of ['SELECT','INSERT'])assert.equal((await sql(pg,"SELECT has_table_privilege('control_room_web',$1,$2) yes",[table,right])).rows[0].yes,true);
   assert.equal((await sql(pg,"SELECT has_table_privilege('control_room_web',$1,'DELETE') yes",[table])).rows[0].yes,!table.endsWith('_state'));
   for(const right of ['UPDATE','TRUNCATE'])assert.equal((await sql(pg,"SELECT has_table_privilege('control_room_web',$1,$2) yes",[table,right])).rows[0].yes,false);
   assert.deepEqual((await sql(pg,"SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('control_room_web',attrelid,attnum,'UPDATE') ORDER BY attname COLLATE \"C\"",[table])).rows.map(r=>r.attname),columns);
   for(const role of ['app','scheduler','coordinator','results','publisher','queueWorker','intake','news','fleet'])await assert.rejects(sql(pg,`SELECT * FROM ${table}`,[],role),{code:'42501'});
  }
  const replacement={...p,secret_ref:{kind:'launcher' as const,launcher:'synthetic-api'},models:[{...p.models[0]!,served_model_id:'served/new'}],credit_note:'Replacement'};
  await service.upsert(identity,p.provider_id,{expectedVersion:1,provider:replacement},'s1-native-replace-0001');
  assert.deepEqual(await service.view(identity),{...expected,version:2,providers:[replacement]});
  assert.equal((await w.client.query("SELECT * FROM control_loop_provider_models WHERE served_model_id='served/old'")).rows.length,0);
  assert.equal((await service.revalidate(identity,{providerId:p.provider_id,model:'synthetic/model'})).served_model_id,'served/new');
  await assert.rejects(service.revalidate(identity,{providerId:p.provider_id,model:'absent'}),{reason:'roster_mismatch'});
  const unresolved={...replacement,secret_ref:{kind:'bitwarden' as const,item:'opaque-item'}};
  await service.upsert(identity,p.provider_id,{expectedVersion:2,provider:unresolved},'s1-native-bitwarden-0001');
  await w.close();w=web(pg);service=new LoopProviderServiceV1(w.client,scope,undefined,()=>now);
  assert.deepEqual(await service.view(identity),{...expected,version:3,providers:[unresolved]});
  assert.deepEqual((await w.client.query('SELECT secret_ref FROM control_loop_providers')).rows,[{secret_ref:unresolved.secret_ref}]);
  await assert.rejects(service.revalidate(identity,{providerId:p.provider_id,model:'synthetic/model'}),{reason:'secret_missing'});
  const before=(await sql(pg,'SELECT * FROM control_loop_providers')).rows;
  await assert.rejects(sql(pg,await readFile('db/down/0308_control_loop_providers.sql','utf8')),/loop providers retained/);
  assert.deepEqual((await sql(pg,'SELECT * FROM control_loop_providers')).rows,before);
  await service.remove(identity,p.provider_id,{expectedVersion:3},'s1-native-remove-0001');
  assert.deepEqual(await service.view(identity),{...expected,version:4,providers:[]});
  for(const table of ['control_loop_providers','control_loop_provider_models'])assert.equal((await w.client.query(`SELECT * FROM ${table}`)).rows.length,0);
  await assert.rejects(service.revalidate(identity,{providerId:p.provider_id,model:'synthetic/model'}),{reason:'roster_mismatch'});
  await assert.rejects(sql(pg,await readFile('db/down/0308_control_loop_providers.sql','utf8')),/loop providers retained/);
  console.log('S1 native reopened_pool=true exact_rows=true replaced_and_removed=true exact_grants=true retained_down_atomic=true');
 }finally{await w.close();}
}));

test('S1 PostgreSQL 20 independent provider callers contend at probe barrier with one winner',async()=>run(async pg=>{
 const {LoopProviderServiceV1}=await import('../src/web/v1/loop-provider-service');await seed(pg);
 await sql(pg,`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
 VALUES($1,'synthetic/model',1,'synthetic-api','','','','','','','','on','','','',$2,now())`,[scope.tenantId,owner]);
 const p={provider_id:'provider-one',display_name:'Synthetic provider',base_url:'https://example.com',billing_kind:'token' as const,secret_ref:{kind:'macos_keychain' as const,service:'control-room.provider' as const,account:'provider-one'},models:[{roster_name:'synthetic/model',launcher:'synthetic-api',served_model_id:'served/one'}],credit_amount_nano_usd:null,credit_expires_on:null,credit_note:'',price_source_url:null,price_source_format:null};
 const clients=Array.from({length:20},()=>web(pg));let arrived=0,release!:()=>void;
 const barrier=new Promise<void>(r=>release=r),presence={availability:async()=>{arrived++;if(arrived===20)release();await barrier;return 'available' as const;}};
 const services=clients.map(w=>new LoopProviderServiceV1(w.client,scope,presence,()=>now));
 try{
  const results=await Promise.allSettled(services.map((s,i)=>s.upsert(identity,p.provider_id,{expectedVersion:0,provider:p},`s1-native-race-key-${String(i).padStart(4,'0')}`)));
  assert.equal(arrived,20);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const losers=results.filter(r=>r.status==='rejected');assert.equal(losers.length,19);for(const loser of losers)if(loser.status==='rejected')assert.equal(loser.reason.code,'conflict');
  assert.equal((await services[0]!.view(identity)).version,1);
  assert.equal((await sql(pg,'SELECT * FROM control_loop_providers')).rows.length,1);
  console.log('S1 native separate_production_callers=20 barrier_arrivals=20 winners=1 losers=19 version=1');
 }finally{release();await Promise.all(clients.map(w=>w.close()));}
}));
