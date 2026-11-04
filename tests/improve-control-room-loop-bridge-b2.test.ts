import { KEY, settingsText, description, fixture } from "./helpers/improve-control-room-loop-bridge";
import assert from "node:assert/strict";
import test from "node:test";
import { nodeExchange } from "./helpers/web-node";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sha256Digest } from "../src/security";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1/service";
import { type LoopBridgeBindingV1 } from "../src/improve-control-room/v1/schemas";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1, type LoopAdapterV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomHttpHandlerV1 } from "../src/web/v1/improve-control-room-http";
import { createPrivateNodeHandler } from "../src/web/v1/private-node-handler";
import { privateRequestBodyLimit } from "../src/web/v1/private-request-budgets";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { now, origin, request, token, trust } from "./helpers/web-foundation";

for (const step of ["1", "intake", "42", null]) test(`B1b intake completion ignores display step ${step}`, async t => {
  const f = await fixture(t);
  const adapter = { ...f.adapter, intake: async (...args: Parameters<LoopAdapterV1["intake"]>) => {
    const status = await f.adapter.intake(...args);
    return { ...status, progress: { ...status.progress, step } };
  } };
  const bridge = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" },
    { integrityKey: KEY, adapter }, () => now);
  const result = await bridge.mutate(f.identity, f.project.projectId, null, "intake", { description }, "b1b-display-step-0001");
  assert.equal(result.state, "accepted", "intake admission is independent of display step");
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_run_links")).rows.length, 1);
});

// A2 chain_emit exposes steps[].n/role/model/identity; the reviewed decoder
// supplies these display values. Role names match A2 ROLES, including reviews.
test("B1b A2 live progress reaches the run panel", async t => {
  const f=await fixture(t),id=await f.intake();
  const initial=await f.get(id),run=initial.request.runLink!.loopRunId;
  const roles=["orchestrator","plan","plan-review","spec","spec-review","build",
    "code-review","attack-review","ui-review","ci-review","final"];
  for(const [index,role] of roles.entries()){
    const progress={step:String(index+1),role,attempt:2,requestedModel:"model:requested",
      observedModel:index===0?null:"model:observed",repairCount:3,completed:index,attention:"none" as const};
    await f.edit(run,{progress});
    const status=await f.get(id);
    assert.deepEqual(status.engine.progress,progress,"wire preserves decoded A2 progress");
    assert.deepEqual(status.display.progress,{stepId:String(index+1),role,attempt:2,
      requestedModel:"model:requested",observedModel:progress.observedModel,identityVerified:false,repairCount:3},
      "run panel shows saved model, role, step, attempt and repair values");
  }
  // The decoder reports A2's observed identity (cr.py chain_model_identity status "observed").
  const verified={step:"4",role:"plan-review",attempt:2,requestedModel:"model:requested",observedModel:"model:observed",
    identityVerified:true,repairCount:1,completed:3,attention:"owner" as const};
  await f.edit(run,{progress:verified});
  assert.deepEqual((await f.get(id)).display.progress,{stepId:"4",role:"plan-review",attempt:2,requestedModel:"model:requested",
    observedModel:"model:observed",identityVerified:true,repairCount:1},"verified identity reaches the run panel");
  await f.edit(run,{progress:{...verified,observedModel:null}});
  assert.equal((await f.get(id)).display.progress?.identityVerified,false,"verified needs an observed model");
  await f.edit(run,{progress:{step:"plan",completed:0,attention:"none"}});
  assert.deepEqual((await f.get(id)).display.progress,{stepId:"plan",role:null,attempt:null,
    requestedModel:null,observedModel:null,identityVerified:false,repairCount:null},"missing evidence remains unavailable");
});

test("B1b A2 expect pins", async t => {
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const before=await f.raw.status(run);let savedBefore="",statusReadsAtHook=0;
  f.setBeforeAdmission(async()=>{statusReadsAtHook=(await f.traces()).filter(r=>r.op==="status").length;await f.edit(run,{revision:before.revision+1});savedBefore=await readFile(join(f.root,"runs",run+".json"),"utf8");});
  const result=await f.bridge.mutate(f.identity,f.project.projectId,id,"start",{expectedVersion:1,expectedRevision:s.engine.revision,
    runLinkId:s.request.runLink!.runLinkId},"b1b-a2-expect-start-0001");
  const trace=(await f.traces()).find(row=>row.op==="start")!;
  assert.ok(trace.args.includes("--expect"),"A2 Start includes exact --expect bytes");
  const claim=(await f.db.query<{command_id:string;binding:LoopBridgeBindingV1}>("SELECT command_id,binding FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0]!;
  assert.deepEqual(trace.expectation,{schema_version:1,command_id:claim.command_id,binding_digest:sha256Digest(claim.binding),operation:"start",run,
    revision:before.revision,input_version:before.inputVersion,request_sha256:loopByteHashV1(description),settings_sha256:loopByteHashV1(settingsText),approval:null,question:null},
    "A2 engine receives the original cached pins, explicit operation and claim id");
  assert.equal(result.state,"refused");
  assert.equal(await readFile(join(f.root,"runs",run+".json"),"utf8"),savedBefore,"EXPECT_CHANGED leaves run bytes identical with zero launch effects");
  assert.equal((await f.traces()).filter(r=>r.op==="status").length,statusReadsAtHook,"expectation construction performs no post-hook status reread");
  const after=await f.raw.status(run);assert.equal(after.state,"ready");assert.equal(after.receipts.length,before.receipts.length);
});

test("B1b A2 engine receipts refuse lead confirmation and mismatched record",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.get(id),run=s.request.runLink!.loopRunId;
  const lead=spawnSync(f.configuration.interpreter,[f.configuration.entrypoint,"confirm-request",run,"--sha256",s.engine.requestSha256,"--json"],
    {cwd:f.root,env:{NODE_ENV:"production",LANG:"C.UTF-8"},encoding:"utf8"});assert.equal(lead.status,0);
  const current=await f.get(id);
  const refused=await f.bridge.mutate(f.identity,f.project.projectId,id,"confirm",{expectedVersion:1,expectedRevision:current.engine.revision,
    requestSha256:current.engine.requestSha256,settingsSha256:current.engine.settingsSha256},"b1b-a2-lead-confirm-0001");
  assert.equal(refused.state,"refused");assert.equal((await f.get(id)).request.savedAuthorization,false);
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_authorizations")).rows.length,0);
  await writeFile(join(f.root,"refusal.json"),JSON.stringify({op:"intake",code:0,afterSave:true,bindingDigest:`sha256:${"f".repeat(64)}`}));
  const mismatch=await f.bridge.mutate(f.identity,f.project.projectId,null,"intake",{description},"b1b-a2-foreign-receipt-0001");
  assert.equal(mismatch.state,"uncertain","an engine record with another binding never satisfies this claim");
});

test("B1b A2 expect pins cache and context refuse before files or spawn",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const binding:LoopBridgeBindingV1={schemaVersion:1,body:{expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},
    localVersion:1,adapterId:f.raw.adapterId,loopRunId:run,toolingRevision:f.raw.toolingRevision,a2SchemaVersion:1,schemaDigest:f.raw.schemaDigest,
    requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1(settingsText),runLinkId:s.request.runLink!.runLinkId,
    authorizationId:"authorization:fixture",inputVersion:1,expectedRevision:s.engine.revision,evidence:null};
  const commandId=`loop-command:${"e".repeat(32)}`,context=Object.freeze({operation:"start" as const,commandId});
  const freeze=(b:LoopBridgeBindingV1)=>Object.freeze({...b,body:Object.freeze({...b.body})});
  const callback=f.configuration.contract.admissionExpectation!;
  const traces=(await f.traces()).length;
  await assert.rejects(async()=>callback(freeze(binding),undefined as never),/unavailable/);
  await assert.rejects(async()=>callback(freeze(binding),Object.freeze({...context,operation:"confirm"})),/unavailable/);
  await assert.rejects(async()=>callback(freeze(binding),Object.freeze({...context,commandId:"wrong-context"})),/unavailable/);
  await assert.rejects(async()=>callback(freeze({...binding,evidence:`sha256:${"a".repeat(64)}`}),context),/unavailable/);
  f.clearObservations();await assert.rejects(f.raw.start(commandId,binding,()=>{}),/unavailable/,"missing cache refuses before expect file or process");
  assert.equal((await f.traces()).length,traces);assert.deepEqual(await readdir(f.configuration.workRoot),[]);
  await f.edit(run,{revision:s.engine.revision+1});await f.raw.status(run);
  const displaced=(await f.traces()).length;
  await assert.rejects(f.raw.start(commandId,binding,()=>{}),/unavailable/,"displaced cache cannot refresh an old binding");
  assert.equal((await f.traces()).length,displaced);assert.deepEqual(await readdir(f.configuration.workRoot),[]);
  const absent=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,admissionExpectation:undefined}});
  try{for(const operation of ["intake","confirm","start","approve","answer"] as const)assert.equal(absent.available(operation),false);
    assert.equal(absent.available("stop"),true);
  }finally{await absent.close();}
});

test("B1b A2 expect path and byte collisions refuse before engine effects",async t=>{
  for(const collision of ["bytes","symlink","directory-mode"]){
    const f=await fixture(t),target=join(f.root,"outside.txt");await writeFile(target,"retain exact bytes");
    const original=f.configuration.contract.admissionExpectation!;
    const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,admissionExpectation:async(b,c)=>{
      const expected=await original(b,c),directory=join(f.configuration.workRoot,c.commandId.replace(":","-"));
      await mkdir(directory,{mode:collision==="directory-mode"?0o755:0o700});
      if(collision==="bytes")await writeFile(join(directory,"expect.json"),"mismatching bytes",{mode:0o600});
      if(collision==="symlink")await symlink(target,join(directory,"expect.json"));
      return expected;
    }}});
    try{
      const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter},()=>now);
      const result=await bridge.mutate(f.identity,f.project.projectId,null,"intake",{description},`b1b-a2-collision-${collision}`);
      assert.equal(result.state,"uncertain");assert.deepEqual(await readdir(f.configuration.runRoot),[],"invalid expectation path/bytes spawn no engine and write no run");
      assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_run_links")).rows.length,0);
      assert.equal(await readFile(target,"utf8"),"retain exact bytes");
    }finally{await adapter.close();}
  }
});

test("B1b A2 malformed admission records fail the whole decode",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.get(id),run=s.request.runLink!.loopRunId;
  const file=join(f.root,"runs",run+".json"),original=JSON.parse(await readFile(file,"utf8")),record=original.admissions[0];
  for(const admissions of [[{...record,at:"yesterday"}],[{...record,operation:"stop"}],[{...record,evidence:{...record.evidence,extra:true}}],
    [record,record],Array.from({length:21},(_,i)=>({...record,command_id:`loop-command:${i.toString(16).padStart(32,"0")}`}))]){
    await writeFile(file,JSON.stringify({...original,admissions}));
    // Too many stored records is legal; the wire is only the newest twenty.
    if(admissions.length===21)assert.equal((await f.raw.status(run)).receipts.length,20);
    else await assert.rejects(f.raw.status(run),/unavailable/,"invalid engine records cannot yield a partial receipt list");
  }
  const offsetRecord={...record,at:"2026-10-01T00:00:00.123456-06:00"};
  await writeFile(file,JSON.stringify({...original,admissions:[offsetRecord]}));
  assert.equal((await f.raw.status(run)).receipts[0]!.evidenceDigest,sha256Digest(offsetRecord),"A2 offset timestamp stays byte-exact in the immutable record digest");
  await writeFile(file,JSON.stringify(original));assert.equal((await f.raw.status(run)).receipts.length,1);
});

test("B1b sealed SYNTHETIC approval, owner answer and atomic race refusal",async t=>{
  const f=await fixture(t),id=await f.intake();let s=await f.confirm(id);const run=s.request.runLink!.loopRunId,suffix=encodeURIComponent(id);
  for(const step of ["plan","spec"] as const){
    const approval={step,inputVersion:1,head:"a".repeat(40),reportSha256:"b".repeat(64)};
    await f.edit(run,{state:"waiting",approval});s=await f.get(id);
    const body={expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,...approval};
    assert.equal((await f.post(`${suffix}/approve`,{...body,reportSha256:"c".repeat(64)})).status,409);
    const r=await f.post(`${suffix}/approve`,body);assert.equal((await r.json() as {state:string}).state,"accepted");
    assert.equal((await f.post(`${suffix}/approve`,body)).status,409);
  }
  const question={questionId:"question:owner",inputVersion:1,reportSha256:"d".repeat(64),owner:true as const,changesInput:false as const};
  await f.edit(run,{state:"waiting",question});s=await f.get(id);
  const answer={expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,questionId:question.questionId,inputVersion:1,questionReportSha256:question.reportSha256,text:"Keep the approved scope."};
  assert.equal((await f.post(`${suffix}/answer`,{...answer,by:"orchestrator"})).status,400);
  await f.edit(run,{question:{...question,changesInput:true}});
  assert.equal((await f.post(`${suffix}/answer`,answer)).status,409);
  await f.edit(run,{question:{...question,owner:false}});
  assert.equal((await f.post(`${suffix}/answer`,answer)).status,409);
  await f.edit(run,{question});
  assert.equal((await f.post(`${suffix}/answer`,{...answer,inputVersion:"1"})).status,409);
  const r=await f.post(`${suffix}/answer`,answer);assert.equal((await r.json() as {state:string}).state,"accepted");
  assert.equal((await f.post(`${suffix}/answer`,answer)).status,409);
  await f.edit(run,{state:"ready"});s=await f.get(id);
  f.setBeforeAdmission(()=>f.edit(run,{revision:s.engine.revision+1}));
  const race=await f.post(`${suffix}/start`,{expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId});
  assert.equal(race.status,202);assert.equal((await race.json() as {state:string}).state,"refused");
  assert.equal((await f.traces()).filter(e=>e.op==="start").length,1,"B1b engine lock observes exactly one refused Start invocation");
  assert.equal((await f.raw.status(run)).state,"ready","B1b engine lock refuses revision race before launch");
});

test("B1b Node transport maximum UTF-8 bytes and hosted composition without pipelines",async t=>{
  const f=await fixture(t);
  const app=createPrivateWebProcess({origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys,
    clock:()=>now,database:{client:f.client,close:async()=>{}},loopBridge:{integrityKey:KEY,adapter:f.adapter}});
  t.after(()=>app.close());
  const handler=createPrivateNodeHandler({origin,application:{isReady:()=>true,close:()=>app.close()},handler:r=>app.handle(r,()=>new Response("unused")),
    assets:{count:0,digest:"SYNTHETIC",respond:()=>undefined}});
  const invoke=async(text:string,key:string)=>{
    const proof=request();
    const exchange=nodeExchange({path:`${f.base}/intake`,method:"POST",headers:["Content-Type","application/json","Origin",origin,
      "cf-access-jwt-assertion",proof.headers.get("cf-access-jwt-assertion")!,"Idempotency-Key",key],body:text});
    await handler.handle(exchange.input,exchange.output);return {status:exchange.output.statusCode,body:exchange.body()};
  };
  const maximal=JSON.stringify({description:"a".repeat(8000)}); // valid maximum character envelope
  assert.equal((await invoke(maximal,"b1b-transport-valid-0001")).status,202);
  // Escaped UTF-8 body is exactly 16384 bytes while decoded text stays <=8000.
  const escaped='{'+JSON.stringify('description')+':"'+"\\u0061".repeat(2727)+'a'.repeat(4)+'"}';
  assert.equal(Buffer.byteLength(escaped),16384);
  assert.equal((await invoke(escaped,"b1b-transport-byte-max-0001")).status,202);
  const oversize=escaped.slice(0,-2)+'a'+escaped.slice(-2);
  assert.equal((await invoke(oversize,"b1b-transport-oversize-0001")).status,413);
  assert.equal(privateRequestBodyLimit(`${f.base}/intake`,"POST",false),16384);
  assert.equal((await f.db.query("SELECT * FROM pipeline_runs")).rows.length,0);
});


test("B1b Mac composition without pipelines, local CSRF and child-before-database close",async t=>{
  const f=await fixture(t);const localOrigin="http://127.0.0.1:32123",ownerCode="synthetic-local-owner-code-long";
  const closes:string[]=[];
  const adapter={...f.adapter,close:async()=>{closes.push("children");await f.adapter.close();}};
  const app=createMacLocalWebProcessV1({origin:localOrigin,workspaceId:"workspace:web",clock:()=>now,
    localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin:localOrigin,tenantId:"tenant:web",provider:trust.issuer,subject:"test-owner",ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900},
    database:{client:f.client,isAvailable:()=>true,close:async()=>{closes.push("database");}},loopBridge:{integrityKey:KEY,adapter}});
  t.after(()=>app.close());
  const call=(path:string,init?:RequestInit)=>app.handle(new Request(localOrigin+path,init),()=>new Response("unused"));
  const signin=await call("/api/v1/local-owner-session",{method:"POST",headers:{origin:localOrigin,"content-type":"application/json"},body:JSON.stringify({ownerCode})});
  assert.equal(signin.status,201);const cookie=signin.headers.get("set-cookie")!;
  const headers={cookie,origin:localOrigin,"content-type":"application/json","idempotency-key":"b1b-mac-intake-0001"};
  const response=await call(`${f.base}/intake`,{method:"POST",headers,body:JSON.stringify({description})});
  assert.equal(response.status,202);const receipt=await response.json() as {requestId:string};
  assert.equal((await call(`${f.base}/${encodeURIComponent(receipt.requestId)}/status`,{headers:{cookie}})).status,200);
  assert.equal((await call(`${f.base}/intake`,{method:"POST",headers:{...headers,origin:"https://foreign.invalid"},body:JSON.stringify({description})})).status,403);
  await app.close();assert.deepEqual(closes,["children","database"]);
});

test("B1b all seven routes recheck expiry, revocation, project and replay authority",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.get(id),suffix=encodeURIComponent(id);
  const routes=[
    {suffix:"intake",body:{description}},
    {suffix:`${suffix}/status`,body:undefined},
    {suffix:`${suffix}/confirm`,body:{expectedVersion:1,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256}},
    {suffix:`${suffix}/start`,body:{expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId}},
    {suffix:`${suffix}/stop`,body:{runLinkId:s.request.runLink!.runLinkId}},
    {suffix:`${suffix}/approve`,body:{expectedVersion:1,expectedRevision:1,step:"plan",inputVersion:1,head:"a".repeat(40),reportSha256:"b".repeat(64)}},
    {suffix:`${suffix}/answer`,body:{expectedVersion:1,expectedRevision:1,questionId:"question:owner",inputVersion:1,questionReportSha256:"c".repeat(64),text:"Keep scope."}},
  ];
  const snapshot=async()=>JSON.stringify((await f.db.query("SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind")).rows);
  const original=await snapshot(),traceCount=(await f.traces()).length;
  const call=(route:typeof routes[number],jwt?:string,base=f.base)=>f.handler(request(`${base}/${route.suffix}`,route.body?"POST":"GET",route.body,"b1b-request-00000001",jwt));
  for(const route of routes){
    assert.equal((await call(route,token({exp:now/1000-1}))).status,401);
    const foreign=f.base.replace(encodeURIComponent(f.project.projectId),"project:foreign");
    assert.equal((await call(route,undefined,foreign)).status,404);
  }
  await f.db.exec("ALTER TABLE control_web_sessions DISABLE TRIGGER USER");
  await f.db.query("UPDATE control_role_grants SET created_at='2026-09-04T11:00:00Z'");
  for(const [change,restore,status] of [
    ["UPDATE control_web_sessions SET revoked_at=now()","UPDATE control_web_sessions SET revoked_at=NULL",401],
    ["UPDATE control_web_sessions SET expires_at='2026-09-04T11:59:30Z'","UPDATE control_web_sessions SET expires_at='2099-01-01'",401],
    ["UPDATE control_role_grants SET revoked_at='2026-09-04T12:00:00Z'","UPDATE control_role_grants SET revoked_at=NULL",403],
    ["UPDATE control_role_grants SET expires_at='2026-09-04T11:59:30Z'","UPDATE control_role_grants SET expires_at=NULL",403],
    ["UPDATE control_manual_project_heads SET lifecycle='archived'","UPDATE control_manual_project_heads SET lifecycle='active'",409],
  ] as const){
    await f.db.query(change);
    for(const route of routes)assert.equal((await call(route)).status,status);
    await f.db.query(restore);
  }
  await f.db.exec("ALTER TABLE control_web_sessions ENABLE TRIGGER USER");
  assert.equal(await snapshot(),original);assert.equal((await f.traces()).length,traceCount,"local refusals call no adapter");
});

test("B1b status is observational and no contract enables no route",async t=>{
  const f=await fixture(t),id=await f.intake();
  const tables=["control_loop_improvement_requests","control_loop_improvement_inputs","control_loop_improvement_run_links","control_loop_improvement_authorizations","control_loop_improvement_commands","control_web_sessions"];
  const snapshot=async()=>JSON.stringify(await Promise.all(tables.map(async table=>(await f.db.query(`SELECT * FROM ${table}`)).rows)));
  const before=await snapshot();await f.get(id);await f.get(id);assert.equal(await snapshot(),before);
  const handler=createImproveControlRoomHttpHandlerV1({origin,trust,service:f.service,clock:()=>now});
  assert.equal((await handler(request(`${f.base}/intake`,"POST",{description},"b1b-no-contract-0001"))).status,404);
  assert.throws(()=>createImproveControlRoomHttpHandlerV1({origin,trust}),/service_required/);
});

test("B1b Stop still targets the original owned run after local draft/settings change",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id);
  assert.equal((await f.post(`${encodeURIComponent(id)}/start`, { expectedVersion: s.request.currentVersion,
    expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId })).status, 202);
  const desk=new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,f.adapter.contract);
  await desk.reviseLoopDraft(f.identity,f.project.projectId,{requestId:id,expectedVersion:1,description:"Changed local draft.",settingsText:JSON.stringify({changed:true})},"b1b-changed-local-0001");
  const response=await f.post(`${encodeURIComponent(id)}/stop`,{runLinkId:s.request.runLink!.runLinkId});
  assert.equal((await response.json() as {state:string}).state,"accepted");
  assert.equal((await f.get(id)).engine.state,"stopped");
});

test("B1b dropped request and lost dispatch reply consume one durable attempt",async t=>{
  const f=await fixture(t);let entered!:()=>void,release!:()=>void,calls=0;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const adapter={...f.adapter,intake:async(id:string,b:LoopBridgeBindingV1,text:string,fence:()=>void)=>{calls++;entered();await gate;return f.adapter.intake(id,b,text,fence);}};
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter},()=>now);
  const handler=createImproveControlRoomHttpHandlerV1({origin,trust,loopBridge:bridge,clock:()=>now});
  const key="b1b-dropped-request-0001",controller=new AbortController();
  const original=request(`${f.base}/intake`,"POST",{description},key);
  const pending=handler(new Request(original,{signal:controller.signal}));await waiting;controller.abort();
  try{
    const replay=await handler(request(`${f.base}/intake`,"POST",{description},key));
    assert.equal(replay.status,202);assert.equal((await replay.json() as {state:string}).state,"uncertain");
    assert.equal(calls,1,"B1b dropped caller never redispatches a committed claim");
  }finally{release();}
  assert.equal((await pending).status,202);
  assert.equal((await handler(request(`${f.base}/intake`,"POST",{description},key))).status,200);
  assert.equal(calls,1);
});

test("B1b malicious request bytes stay literal exclusive command-file contents",async t=>{
  const f=await fixture(t),text='literal $(touch injected) ; "../outside" \\u2028';
  const response=await f.post("intake",{description:text});assert.equal(response.status,202);
  const trace=(await f.traces()).find(e=>e.op==="intake")!;
  const receipt=await response.json() as {requestId:string};
  assert.equal((await f.get(receipt.requestId)).engine.draft,text,"engine consumed literal exclusive source-file bytes");
  await assert.rejects(readFile(trace.args[1]!,"utf8"),{code:"ENOENT"},"completed source file reclaimed");
  assert.equal((await readdir(f.root)).includes("injected"),false);
  for(const bad of [{description:"a",workerId:"worker:other"},{description:"a",source:"../outside"},{description:"a",settings:"private"}])assert.equal((await f.post("intake",bad)).status,400);
});

test("B1b expired admission never spawns and post-dispatch database failure reconciles",async t=>{
  const f=await fixture(t);let current=now,expire=true,launches=0,failResult=false;
  const traced=(tx:import('../src/persistence/database').DatabaseSession)=>({query:async<T>(sql:string,params?:unknown[])=>{
    if(failResult&&sql.startsWith('INSERT INTO control_loop_improvement_commands')&&params?.[2]==='result'){failResult=false;throw new Error('SYNTHETIC DB result loss');}
    return tx.query<T>(sql,params);
  }});
  const db:import('../src/persistence/database').DatabaseClient={query:f.client.query,transaction:callback=>f.client.transaction(tx=>callback(traced(tx))),
    transactionWithPreCommitCheck:async(callback,check)=>{const value=await f.client.transactionWithPreCommitCheck(tx=>callback(traced(tx)),check);if(expire){expire=false;current+=6000;}return value;}};
  const adapter={...f.adapter,intake:async(id:string,b:LoopBridgeBindingV1,text:string,fence:()=>void)=>{launches++;return f.adapter.intake(id,b,text,fence);}};
  const bridge=new ImproveControlRoomLoopServiceV1(db,{tenantId:'tenant:web',workspaceId:'workspace:web'},{integrityKey:KEY,adapter},()=>current);
  const expired=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-expired-admission-0001');
  assert.equal(expired.state,'uncertain');assert.equal(launches,0,'expired committed admission never reaches spawn');
  assert.equal((await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-expired-admission-0001')).state,'uncertain');assert.equal(launches,0);
  failResult=true;
  const lost=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-post-dispatch-db-0001');assert.equal(lost.state,'uncertain');
  const reconciled=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-post-dispatch-db-0001');assert.equal(reconciled.state,'accepted');assert.equal(reconciled.replayed,true);assert.equal(launches,1);
});

test("B1b sweep database errors reach the transaction while verification failures retain files", async t => {
  const f = await fixture(t);
  const crashed = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    { integrityKey: KEY, adapter: { ...f.adapter, releaseCommandFiles: async () => {} } }, () => now);
  const retained = await crashed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, 'b1b-sweep-db-invalid');
  const finished = await crashed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, 'b1b-sweep-db-finished');
  const diagnostic = t.mock.method(console, 'warn', () => {});
  const failures: unknown[] = [];
  let databaseError: unknown, sweeps = 0;
  const trace = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    if (sql.includes("entry_kind='result'") && params?.[1] === finished.commandId) {
      try { await tx.query('SELECT missing_sweep_column FROM control_loop_improvement_commands'); }
      catch (error) { databaseError = error; throw error; }
      assert.fail('the injected query must fail');
    }
    const result = await tx.query<T>(sql, params);
    if (sql.includes('SELECT c.* FROM control_loop_improvement_commands')) {
      sweeps++;
      result.rows = [retained, finished].map(receipt => {
        const row = result.rows.find(raw => (raw as { command_id: string }).command_id === receipt.commandId)!;
        return receipt === retained ? { ...row, record_digest: `sha256:${'f'.repeat(64)}` } : row;
      });
    }
    return result;
  } });
  const client: DatabaseClient = { query: (sql, params) => f.client.query(sql, params),
    transaction: work => f.client.transaction(tx => work(trace(tx))),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(async tx => {
      try { return await work(trace(tx)); }
      catch (error) { failures.push(error); throw error; }
    }, check) };
  const restarted = new ImproveControlRoomLoopServiceV1(client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    { integrityKey: KEY, adapter: f.adapter }, () => now);
  for (let i = 0; i < 2; i++) {
    const receipt = await restarted.mutate(f.identity, f.project.projectId, null, 'intake', { description }, `b1b-sweep-db-trigger-${i}`);
    assert.equal(receipt.state, 'accepted', 'best-effort sweep cannot change the admitted command result');
    assert.ok(databaseError instanceof Error);
    assert.equal(failures.length, i + 1, 'database error escapes the row catch and aborts the sweep transaction');
    assert.equal(failures[i], databaseError, 'the original database error reaches the transaction boundary');
    for (const row of [retained, finished]) assert.equal(await readFile(join(f.configuration.workRoot,
      row.commandId.replace(':', '-'), 'source.txt'), 'utf8'), description, 'failed sweep retains command files');
  }
  assert.equal(sweeps, 2, 'failed sweep remains eligible for retry');
  assert.deepEqual(diagnostic.mock.calls.map(call => call.arguments), [
    ['loop_command_sweep_verification_failed'], ['loop_command_sweep_verification_failed'],
  ], 'only verification failures produce the fixed row diagnostic');
});

test("B1b canStop after a refused Start agrees with the Stop route", async t => {
  const f = await fixture(t), id = await f.intake(), s = await f.confirm(id), suffix = encodeURIComponent(id);
  await writeFile(join(f.root, "refusal.json"), JSON.stringify({ op: "start", code: 3 }));
  const refused = await f.bridge.mutate(f.identity, f.project.projectId, id, 'start',
    { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId }, 'b1b-refused-start-0001');
  assert.equal(refused.state, 'refused');
  await rm(join(f.root, "refusal.json"));
  const after = await f.get(id);
  assert.equal(after.display.startState, 'not_started'); assert.equal(after.display.canStart, false);
  assert.equal(after.display.canStop, true, 'canStop agrees with Stop after a refused Start');
  const stop = await f.post(`${suffix}/stop`, { runLinkId: s.request.runLink!.runLinkId });
  assert.equal(stop.status, 202); assert.equal((await stop.json() as { state: string }).state, 'accepted');
  assert.equal((await f.get(id)).display.canStop, false);
});

for (const [code, breakStatus] of [[1, false], [4, false], [2, true], [3, true]] as const) {
  test(`B1b approve empty output exit ${code} broken status ${breakStatus} stays uncertain`, async t => {
    const f = await fixture(t), id = await f.intake(); let s = await f.confirm(id);
    const approval = { step: 'plan' as const, inputVersion: 1, head: 'a'.repeat(40), reportSha256: 'b'.repeat(64) };
    await f.edit(s.request.runLink!.loopRunId, { state: 'waiting', approval }); s = await f.get(id);
    await writeFile(join(f.root, 'refusal.json'), JSON.stringify({ op: 'approve', code, output: 'empty', breakStatus }));
    const body = { expectedVersion: 1, expectedRevision: s.engine.revision, ...approval };
    const key = `b1b-approve-uncertain-${code}`;
    const receipt = await f.bridge.mutate(f.identity, f.project.projectId, id, 'approve', body, key);
    assert.equal(receipt.state, 'uncertain'); assert.equal(receipt.error, 'LAUNCH_UNCERTAIN');
    assert.equal((await f.bridge.mutate(f.identity, f.project.projectId, id, 'approve', body, key)).state, 'uncertain');
    assert.equal((await f.traces()).filter(trace => trace.op === 'approve').length, 1, 'uncertain approval never redispatches');
  });
}

test("B2b escaped question budget precedes the engine decoder", async t => {
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const question={questionId:"question:bounded",inputVersion:1,reportSha256:"d".repeat(64),owner:true,changesInput:false};
  const prefix='"\\\n\t' + 'é🧭';
  const exact=prefix+"x".repeat(12288-Buffer.byteLength(JSON.stringify(prefix)));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)),12288);
  let seen: unknown;
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,decodeStatus:output=>{
    seen=(output as {counters:{fixture:{questionText:unknown}}}).counters.fixture.questionText;
    return f.configuration.contract.decodeStatus(output);
  }}});t.after(()=>adapter.close());
  for(const [text,expected] of [[exact,exact],[exact+"x",null],[{invalid:true},null],[undefined,null]] as const){
    await f.edit(run,{state:"waiting",question,questionText:text});
    const saved=await adapter.status(run);
    assert.equal(seen,expected,"raw text is budgeted before strict engine decoding");
    assert.deepEqual(saved.decisions?.gate,{kind:"question",text:expected});
    assert.deepEqual(saved.question,question);assert.deepEqual(saved.confirmation,(await f.adapter.status(run)).confirmation);
    assert.equal(saved.revision,s.engine.revision);assert.equal(saved.description,description);
  }
  await f.edit(run,{questionText:"x".repeat(65536)});
  await assert.rejects(adapter.status(run),/unavailable/,"aggregate stdout cap remains unchanged");
});

for(const composition of ["hosted","local"] as const)test(`B2b ${composition} attention and document composition`,async t=>{
  const canonical={observedAt:new Date(now).toISOString(),items:[],truncated:false};
  for(const mode of ["loop","canonical","both","neither","failed-canonical"] as const){
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const directory=join(f.configuration.runRoot,run);await mkdir(directory);
  const text="SYNTHETIC complete sealed plan.";const approval={step:"plan" as const,inputVersion:1,head:"a".repeat(40),reportSha256:loopByteHashV1(text)};
  await writeFile(join(directory,"report.md"),text);await writeFile(join(directory,"report.json"),JSON.stringify(approval));await f.edit(run,{state:"waiting",approval});
    let canonicalReads=0;
    const options={clock:()=>now,database:{client:f.client,isAvailable:()=>true,close:async()=>{}},
      ...(mode==="loop"||mode==="both"||mode==="failed-canonical"?{loopBridge:{integrityKey:KEY,adapter:f.adapter}}:{}),
      ...(mode==="canonical"||mode==="both"||mode==="failed-canonical"?{actionInboxSource:{read:async()=>{canonicalReads++;if(mode==="failed-canonical")throw new Error("SYNTHETIC unavailable canonical source");return canonical;}}}:{})};
    let call:(path:string)=>Promise<Response>,close:()=>Promise<void>;
    if(composition==="hosted"){
      const app=createPrivateWebProcess({...options,origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys});
      call=path=>app.handle(request(path),()=>new Response("unused"));close=()=>app.close();
    }else{
      const localOrigin="http://127.0.0.1:59359",ownerCode="SYNTHETIC-b2b-composition-owner-code";
      const app=createMacLocalWebProcessV1({...options,origin:localOrigin,workspaceId:"workspace:web",localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,
        origin:localOrigin,tenantId:"tenant:web",provider:trust.issuer,subject:"test-owner",ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900}});
      const response=await app.handle(new Request(localOrigin+"/api/v1/local-owner-session",{method:"POST",headers:{origin:localOrigin,"content-type":"application/json"},body:JSON.stringify({ownerCode})}),()=>new Response("unused"));
      assert.equal(response.status,201);const cookie=response.headers.get("set-cookie")!;
      call=path=>app.handle(new Request(localOrigin+path,{headers:{cookie}}),()=>new Response("unused"));close=()=>app.close();
    }
    try{
      const attention=await call("/api/v1/needs-me/action-items");
      assert.equal(attention.status,mode==="neither"?404:mode==="failed-canonical"?503:200);
      if(attention.status===200){const body=await attention.json();assert.deepEqual(body.items,[]);
        if(mode!=="canonical"){assert.equal(body.loop.state,"available");assert.equal(body.loop.items[0].kind,"approval");}
        else assert.equal(body.loop,undefined);
      }
      if(mode==="loop"||mode==="both"){
        const document=await call(`${f.base}/${encodeURIComponent(id)}/approval-document`);assert.equal(document.status,200);assert.equal((await document.json()).text,text);
      }
      assert.equal((await call("/api/v1/needs-me/action-items?extra=true")).status,400);
      assert.equal(canonicalReads,mode==="canonical"||mode==="both"||mode==="failed-canonical"?1:0);
    }finally{await close();}

  }
});


test("B5 shared bridge fixture cleanup leaves the sibling client usable", async t => {
  const survivor = await fixture(t);
  let closed: Awaited<ReturnType<typeof fixture>> | undefined;
  await t.test("owned sibling cleanup", async child => {
    closed = await fixture(child);
    assert.notEqual(closed.root, survivor.root);
    await closed.intake();
  });
  assert.ok(closed);
  await assert.rejects(readFile(join(closed.root, "engine.py")), { code: "ENOENT" },
    "shared bridge cleanup removes only the completed client's root");
  await assert.rejects(closed.db.query("SELECT 1"), "shared bridge cleanup closes the completed client's database");
  assert.ok((await readFile(join(survivor.root, "engine.py"))).length);
  const id = await survivor.intake();
  assert.equal((await survivor.get(id)).engine.state, "draft", "sibling still executes the real synthetic engine");
});
