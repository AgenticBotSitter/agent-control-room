import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { taskFixture } from "./helpers/web-task";
import { now, origin, request, trust } from "./helpers/web-foundation";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1 } from "../src/improve-control-room/v1/schemas";
import { sha256Digest } from "../src/security";

const KEY = new Uint8Array(32).fill(64);
const toolingRevision = sha256Digest({ fixture: "SYNTHETIC B4 tooling" });
const schemaDigest = sha256Digest({ fixture: "SYNTHETIC B4 schema" });
const contract = { toolingRevision, decodeRunIdentity: (v: unknown) => loopImprovementRunIdentitySchemaV1.parse(v),
  decodeObservation: (v: unknown) => loopImprovementObservationSchemaV1.parse(v), matchesSavedInput: () => true };

test("B4 finished candidate reaches Home and saved request", async () => {
  const f = await taskFixture();
  const loopCandidates = { integrityKey: KEY, contract, schemaDigest,
    source: { toolingRevision, schemaDigest, readVerifiedCompletion: async () => { throw new Error("SYNTHETIC absent completion"); } },
    repository: { observe: async () => { throw new Error("SYNTHETIC absent repository"); } } };
  // Spread-only injection keeps this red test executable against the predecessor.
  const app = createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, clock: () => now, database: { client: f.client, close: async () => {} }, ...{ loopCandidates } });
  try {
    const response = await app.handle(request("/api/v1/loop-update-candidates"), () => new Response("unused", { status: 404 }));
    assert.equal(response.status, 200, "B4 candidate route is mounted without a pipeline");
    assert.deepEqual((await response.json()).candidates, []);
    await proveHomeSavedRequest();
  } finally { await app.close(); await f.db.close(); }
});

// SYNTHETIC contract: this verifier checks an independently sealed fixture manifest,
// receipt/output custody and effective policy. It is not an A2 production mapping.
async function syntheticFixture() {
  const f = await taskFixture();
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
  const app=createPrivateWebProcess({origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys,clock:()=>now,
    database:{client:f.client,close:async()=>{}},loopCandidates:config});
  const handle=(r:Request)=>app.handle(r,()=>new Response("unused",{status:404}));
  return {...f,config,adapter,desk,lineage,bridge,app,publisher,handle,forbidden,requestId:draft.request.requestId,runLinkId:link.runLink.runLinkId,
    evidence:()=>structuredClone(evidence),edit:(change:(e:typeof evidence)=>void)=>{change(evidence);writeRetained();},retained,calls:()=>calls,
    unavailable:(v:boolean)=>{unavailable=v;},stop:()=>{status={...status,state:"stopped"};},stopAtLastSnapshot:()=>{stopAt=observations+2;},moveRepositoryHead:(v:string)=>{repositoryHead=v;},dirty:(v:boolean)=>{dirty=v;},proof:(name:keyof typeof proof,v:boolean)=>{proof={...proof,[name]:v};writeRetained();},
    publish:()=>publisher.publishCompletion({runLinkId:link.runLink.runLinkId,completionDigest:evidence.completionDigest}),
    close:async()=>{await app.close();await bridge.close();await f.db.close();fs.rmSync(retained,{recursive:true,force:true});}};
}

test("B4 SYNTHETIC publisher signed service HTTP retained card and inert decision",async()=>{
  const f=await syntheticFixture();
  try {
    const receipt=await f.publish();assert.equal(receipt.state,"recorded");
    assert.equal((await f.publish()).state,"replayed");
    const {ImproveControlRoomDeskServiceV1}=await import("../src/improve-control-room/v1/service");
    const {LoopCandidatePublisherV1}=await import("../src/improve-control-room/v1/loop-candidate-publisher");
    for(let restart=0;restart<2;restart++){
      const restored=new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,f.config.contract,f.config);
      const replay=await new LoopCandidatePublisherV1(restored,f.config).publishCompletion({runLinkId:f.runLinkId,completionDigest:f.evidence().completionDigest});
      assert.equal(replay.state,"replayed");assert.deepEqual(replay.candidate,receipt.candidate,"B4 reconstruction preserves candidate identity and digest");
    }
    const response=await f.handle(request(`/api/v1/projects/${f.project.projectId}/improvements/loop/${f.requestId}/candidate`));
    assert.equal(response.status,200);const card=(await response.json()).candidate;
    assert.equal(card.candidateRevision,"b".repeat(40));assert.equal(card.canDecide,true);
    const body={candidateId:card.candidateId,expectedVersion:1,candidateRecordDigest:card.recordDigest,candidateRevision:card.candidateRevision,
      localVersion:card.localVersion,a2InputVersion:card.a2InputVersion,decision:"accept"};
    const path=`/api/v1/loop-update-candidates/${card.candidateId}/decision`;
    const accepted=await f.handle(request(path,"POST",body,"b4-decision-exact-0001"));assert.equal(accepted.status,201,await accepted.clone().text());
    const decision=await accepted.json();assert.equal(decision.startsDeploy,false);assert.equal(decision.grantsDeployAuthority,false);
    const replay=await f.handle(request(path,"POST",body,"b4-decision-exact-0001"));assert.equal(replay.status,200);assert.equal((await replay.json()).decisionId,decision.decisionId);
    assert.equal((await f.handle(request(path,"POST",body,"b4-decision-new-key-0001"))).status,409);
    assert.equal((await f.desk.readLoopCandidate(f.identity,f.project.projectId,f.requestId)).candidate?.state,"accepted");
    assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,1);
    assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidate_decisions")).rows[0]!.n,1);
    assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM pipeline_runs")).rows[0]!.n,0);
    assert.deepEqual(f.forbidden,[]);
  }finally{await f.close();}
});

test("B4 readiness refuses independent missing counts, bindings, seals and policy",async()=>{
  const f=await syntheticFixture();
  try {
    const original=f.evidence();
    const variants:[string,(e:ReturnType<typeof f.evidence>)=>void][]=[
      ["head",e=>{e.binding.candidateRevision="c".repeat(40);}], ["base",e=>{e.binding.baseRevision="c".repeat(40);}],
      ["local input",e=>{e.binding.localVersion=2;}], ["request",e=>{e.binding.requestSha256="0".repeat(64);}],
      ["settings",e=>{e.binding.settingsSha256="0".repeat(64);}], ["A2 scalar type",e=>{e.binding.a2InputVersion=1;}],
      ["tooling pins",e=>{e.binding.toolingRevision=sha256Digest({different:"tooling"});}],
      ["no required check",e=>{e.checks[0]!.required=false;}], ["zero",e=>{e.checks[0]!.completed=0;e.checks[0]!.passed=0;}],
      ["skipped",e=>{e.checks[0]!.passed=2;e.checks[0]!.skipped=1;}], ["incomplete",e=>{e.checks[0]!.status="INCOMPLETE";}],
      ["not run",e=>{e.checks[0]!.status="NOT RUN";}], ["crashed",e=>{e.checks[0]!.exitCode=1;}],
      ["timeout",e=>{e.checks[0]!.exitCode=null;}], ["missing check",e=>{e.checks=[];}],
      ["missing final",e=>{e.reviews=e.reviews.filter(r=>r.role!=="final");}], ["stale final",e=>{e.reviews[0]!.candidateRevision="a".repeat(40);}],
      ["unknown independence",e=>{e.reviews[0]!.identityVerified=false;}], ["open high",e=>{e.findings[0]!.disposition="OPEN";}],
      ["open medium",e=>{e.findings[0]!.disposition="OPEN";e.findings[0]!.severity="MEDIUM";}],
      ["duration",e=>{e.timing.durationMs=0;}], ["oversized",e=>{e.summary="x".repeat(65537);}],
      ["private path",e=>{e.summary="/home/private/receipt";}],
    ];
    for(const [name,edit] of variants){f.edit(e=>Object.assign(e,structuredClone(original)));f.edit(edit);await assert.rejects(f.publish(),`B4 refuses ${name}`);}
    f.edit(e=>Object.assign(e,original));
    for(const name of ["argv","output","seals","approvals","policy","retention"] as const){f.proof(name,false);await assert.rejects(f.publish(),/verification refused/);f.proof(name,true);}
    f.dirty(true);await assert.rejects(f.publish(),/dirty repository/);f.dirty(false);
    assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,0);
    await f.publish();
    f.edit(e=>{e.summary="Changed bytes under the same lineage";});await assert.rejects(f.publish(),/conflict/);
    assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,1);
  }finally{await f.close();}
});

test("B4 unauthorized caller, malformed routes and 8193-byte refusal have zero source calls",async()=>{
  const f=await syntheticFixture();
  try {
    await f.publish();const page=await f.desk.readLoopCandidates(f.identity),c=page.candidates[0]!;
    const path=`/api/v1/loop-update-candidates/${c.candidateId}/decision`;
    const body={candidateId:c.candidateId,expectedVersion:1,candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,
      localVersion:1,a2InputVersion:c.a2InputVersion,decision:"accept"};
    const before=f.calls();
    const { privateRequestBodyLimit }=await import("../src/web/v1/private-request-budgets");assert.equal(privateRequestBodyLimit(path,"POST",false),8192);
    const large=request(path,"POST",body);const oversized=new Request(large.url,{method:"POST",headers:large.headers,body:" ".repeat(8193)});
    assert.equal((await f.handle(oversized)).status,413);
    const badOrigin=request(path,"POST",body);badOrigin.headers.set("origin","https://foreign.invalid");assert.equal((await f.handle(badOrigin)).status,403);
    const invalid=request(path,"POST",{...body,delivery:true});assert.equal((await f.handle(invalid)).status,400);
    assert.equal((await f.handle(request("/api/v1/loop-update-candidates?bad=1"))).status,400);
    assert.equal(f.calls(),before);
    await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE identity_id='identity:web'");
    assert.equal((await f.handle(request(path,"POST",body))).status,403);
    assert.equal((await f.handle(request("/api/v1/loop-update-candidates"))).status,403);
    assert.equal(f.calls(),before);
    assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidate_decisions")).rows[0]!.n,0);
  }finally{await f.close();}
});

test("B4 unknown source fails instead of an empty or all-clear read",async()=>{
  const f=await syntheticFixture();try{await f.publish();f.unavailable(true);assert.equal((await f.handle(request("/api/v1/loop-update-candidates"))).status,503);}
  finally{await f.close();}
});

test("B4 tampered retained candidate fails every read",async()=>{
  const f=await syntheticFixture();try{
    await f.publish();await f.db.exec("ALTER TABLE control_loop_update_candidates DISABLE TRIGGER control_loop_update_candidates_append_only");
    await f.db.query("UPDATE control_loop_update_candidates SET auth_tag=$1",[`hmac-sha256:${"0".repeat(64)}`]);
    assert.equal((await f.handle(request("/api/v1/loop-update-candidates"))).status,503,"B4 tampered candidate never becomes a readable card");
  }finally{await f.close();}
});

if(process.env.CONTROL_ROOM_B4_REQUIRE_A2 === "1")test("B4 reviewed A2 completion and exact delivery head",async()=>{
  assert.fail("B4 production integration is unqualified: reviewed A2 completion/custody pins, B0/I1-I3 captures, B3c producer and isolated delivery harness must be supplied and reviewed. CONTROL_ROOM_B4_A2_CONTRACT is not a production verifier by itself.");
});

async function proveHomeSavedRequest() {
  const f=await syntheticFixture();
  const React=await import("react"),{act}=React,{createRoot}=await import("react-dom/client"),{JSDOM}=await import("jsdom");
  const {UpdateCandidatesHome}=await import("../private-app/app/update-candidates-home");
  const {ImprovementRunPanel}=await import("../private-app/app/improvement-run-panel");
  const dom=new JSDOM("<div id='root'></div>",{url:"https://product.invalid/",pretendToBeVisual:true});
  const posts:{path:string;body:string;key:string}[]=[];
  const transport:typeof fetch=async(input,options)=>{
    const path=String(input);if(path==="/api/v1/update-candidates")return Response.json({}, {status:404});
    if(options?.method==="POST")posts.push({path,body:String(options.body),key:new Headers(options.headers).get("idempotency-key")!});
    return f.handle(request(path,options?.method??"GET",options?.body?JSON.parse(String(options.body)):undefined,new Headers(options?.headers).get("idempotency-key")??"b4-ui-read-000000001"));
  };
  const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,fetch:transport,IS_REACT_ACT_ENVIRONMENT:true};
  const descriptors=Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const root=createRoot(dom.window.document.getElementById("root")!);
  const settle=async()=>{for(let i=0;i<12;i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});};
  try{
    const receipt=await f.publish();
    await act(async()=>root.render(React.createElement(UpdateCandidatesHome)));await settle();
    assert.match(dom.window.document.body.textContent!,/SYNTHETIC finished candidate/);
    assert.ok(dom.window.document.body.textContent!.includes("b".repeat(40)),"B4 Home exposes full candidate head");
    assert.ok(dom.window.document.querySelector(`a[href='${receipt.href}']`));
    assert.equal(posts.length,0,"B4 Home reads never publish or deliver");
    const view=await f.lineage.viewLoopDesk(f.identity,f.project.projectId);
    dom.window.location.hash=receipt.href.split("#")[1]!;
    await act(async()=>root.render(React.createElement(ImprovementRunPanel,{projectId:f.project.projectId,requests:view.loopRequests,fresh:true})));await settle();
    assert.ok(dom.window.document.body.textContent!.includes("b".repeat(40)),"B4 saved request exposes same full head");
    assert.match(dom.window.document.body.textContent!,/Unverified/);
    const button=[...dom.window.document.querySelectorAll("button")].find(b=>b.textContent==="Accept this candidate — record only")!;
    assert.equal(button.disabled,false,"B4 verified finish action enabled");
    await act(async()=>{button.click();button.click();});await settle();
    assert.equal(posts.length,1,"B4 synchronous clicks attempt one inert decision POST");
    assert.equal((await f.desk.readLoopCandidate(f.identity,f.project.projectId,f.requestId)).candidate?.state,"accepted");
  }finally{
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
    await f.close();
  }
}

for(const composition of ["hosted","local"] as const)test(`B4 ${composition} direct embedded loop legacy combined absent configurations`,async()=>{
  const f=await syntheticFixture();const {createMacLocalWebProcessV1}=await import("../src/web/v1/mac-local-web-process");
  const {LOCAL_OWNER_SESSION_PROFILE_V1}=await import("../src/web/v1/local-owner-session");
  try{
    await f.publish();
    for(const mode of ["loop","embedded","legacy","combined","absent"] as const){
      const candidate=mode==="loop"||mode==="combined"?{loopCandidates:f.config}:{};
      const embedded=mode==="embedded"?{loopBridge:{integrityKey:KEY,adapter:f.adapter,loopCandidates:f.config}}:{};
      let handle:(path:string)=>Promise<Response>,close:()=>Promise<void>;
      if(composition==="hosted"){
        const app=createPrivateWebProcess({origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys,clock:()=>now,
          database:{client:f.client,close:async()=>{}},...candidate,...embedded,...(mode==="legacy"||mode==="combined"?{workBatches:{integrityKey:KEY}}:{})});
        handle=path=>app.handle(request(path),()=>new Response("unused",{status:404}));close=()=>app.close();
      }else{
        const localOrigin="http://127.0.0.1:60349",ownerCode="SYNTHETIC-B4-owner-code-long";
        const app=createMacLocalWebProcessV1({origin:localOrigin,workspaceId:"workspace:web",clock:()=>now,
          localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin:localOrigin,tenantId:"tenant:web",provider:trust.issuer,subject:"test-owner",ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900},
          database:{client:f.client,close:async()=>{},isAvailable:()=>true},...candidate,...embedded,
          ...(mode==="legacy"||mode==="combined"?{workBatchIntegrityKey:KEY}:{})});
        const login=await app.handle(new Request(localOrigin+"/api/v1/local-owner-session",{method:"POST",headers:{origin:localOrigin,"content-type":"application/json"},body:JSON.stringify({ownerCode})}),()=>new Response("unused"));
        assert.equal(login.status,201,`B4 local ${mode} sign in: ${await login.clone().text()}`);const cookie=login.headers.get("set-cookie")!;
        handle=path=>app.handle(new Request(localOrigin+path,{headers:{cookie}}),()=>new Response("unused",{status:404}));close=()=>app.close();
      }
      try{
        const response=await handle("/api/v1/loop-update-candidates");
        assert.equal(response.status,mode==="legacy"||mode==="absent"?404:200,`B4 ${composition} ${mode} candidate availability`);
        if(response.status===200)assert.equal((await response.json()).candidates.length,1);
        assert.equal((await handle("/api/v1/update-candidates")).status,mode==="legacy"||mode==="combined"?200:404);
      }finally{await close();}
    }
    assert.throws(()=>createPrivateWebProcess({origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys,
      database:{client:f.client,close:async()=>{}},loopCandidates:{...f.config,schemaDigest:sha256Digest({wrong:"pin"})}}),/configuration_invalid/);
    assert.throws(()=>createPrivateWebProcess({origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys,
      database:{client:f.client,close:async()=>{}},loopCandidates:f.config,loopBridge:{integrityKey:KEY,adapter:f.adapter,loopCandidates:{...f.config}}}),/configuration_conflict/);
  }finally{await f.close();}
});

test("B4 creator enumeration excludes another owner's candidate before source reads",async()=>{
  const f=await syntheticFixture();
  try{
    await f.publish();const before=f.calls();
    const {sha256Digest}=await import("../src/security");
    await f.db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES('identity:b4-other','tenant:web','human','SYNTHETIC other owner',$1,$2,'active',$3,$3)`,[f.identity.provider,sha256Digest({provider:f.identity.provider,subject:"SYNTHETIC-other"}),f.identity.issuedAt]);
    await f.db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES('grant:b4-other','tenant:web','identity:b4-other','owner','["*"]','["*"]','critical',false,false,$1,$1)`,[f.identity.issuedAt]);
    const other={...f.identity,subject:"SYNTHETIC-other",tokenDigest:sha256Digest({session:"SYNTHETIC-other"})};
    await f.db.query("INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES('tenant:web',$1,'identity:b4-other',$2,$3)",[other.tokenDigest,other.issuedAt,other.expiresAt]);
    const {ImproveControlRoomDeskServiceV1}=await import("../src/improve-control-room/v1/service");
    let scanned=0;
    const trace=(tx:import("../src/persistence/database").DatabaseSession):import("../src/persistence/database").DatabaseSession=>({query:async<T,>(sql:string,params?:unknown[])=>{
      const result=await tx.query<T>(sql,params);if(sql.includes("SELECT * FROM control_loop_update_candidates WHERE tenant_id=$1 AND"))scanned+=result.rows.length;return result;
    }});
    const db:import("../src/persistence/database").DatabaseClient={query:f.client.query,transaction:fn=>f.client.transaction(tx=>fn(trace(tx))),
      transactionWithPreCommitCheck:(fn,check)=>f.client.transactionWithPreCommitCheck(tx=>fn(trace(tx)),check)};
    const reader=new ImproveControlRoomDeskServiceV1(db,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,f.config.contract,f.config);
    await reader.readLoopCandidates(other).catch(()=>{});
    assert.equal(scanned,0,"B4 creator enumeration scans zero foreign candidate rows");
    assert.equal(f.calls(),before);
    await assert.rejects(reader.readLoopCandidate(other,f.project.projectId,f.requestId),/not_found/);
  }finally{await f.close();}
});

test("B4 revoked expired and foreign authority refuses before source",async()=>{
  const f=await syntheticFixture();try{
    await f.publish();const before=f.calls();
    for(const identity of [{...f.identity,expiresAt:new Date(now).toISOString()},{...f.identity,verificationExpiresAt:new Date(now).toISOString()},
      {...f.identity,subject:"worker:SYNTHETIC"}])await assert.rejects(f.desk.readLoopCandidates(identity));
    await assert.rejects(f.desk.readLoopCandidate(f.identity,"project:foreign",f.requestId),/not_found/);
    await f.db.query("UPDATE control_web_sessions SET revoked_at=$1 WHERE token_digest=$2",[new Date(now).toISOString(),f.identity.tokenDigest]);
    await assert.rejects(f.desk.readLoopCandidates(f.identity),/authentication_required/);
    assert.equal(f.calls(),before);
  }finally{await f.close();}
});

test("B4 wire completed-count guard",async()=>{
  const f=await syntheticFixture();try{const {loopCandidateEvidenceSchemaV1}=await import("../src/improve-control-room/v1/loop-candidate-wire");
    const e=f.evidence();e.checks[0]!.completed=0;e.checks[0]!.passed=0;
    assert.equal(loopCandidateEvidenceSchemaV1.safeParse(e).success,false,"B4 zero completed checks cannot certify readiness");
  }finally{await f.close();}
});

test("B4 wire blocking-finding guard",async()=>{
  const f=await syntheticFixture();try{const {loopCandidateEvidenceSchemaV1}=await import("../src/improve-control-room/v1/loop-candidate-wire");
    const e=f.evidence();e.findings[0]!.disposition="OPEN";
    assert.equal(loopCandidateEvidenceSchemaV1.safeParse(e).success,false,"B4 open HIGH finding cannot certify readiness");
  }finally{await f.close();}
});

test("B4 wire current-head guard",async()=>{
  const f=await syntheticFixture();try{const {loopCandidateEvidenceSchemaV1}=await import("../src/improve-control-room/v1/loop-candidate-wire");
    const e=f.evidence();e.reviews[0]!.candidateRevision="a".repeat(40);
    assert.equal(loopCandidateEvidenceSchemaV1.safeParse(e).success,false,"B4 stale final review cannot certify current head");
  }finally{await f.close();}
});

test("B4 decision exact head binding refuses before an insert",async()=>{
  const f=await syntheticFixture();try{
    await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
    const result=await f.handle(request(`/api/v1/loop-update-candidates/${c.candidateId}/decision`,"POST",{
      candidateId:c.candidateId,expectedVersion:1,candidateRecordDigest:c.recordDigest,candidateRevision:"c".repeat(40),localVersion:1,a2InputVersion:c.a2InputVersion,decision:"accept"},"b4-mutant-head-0001"));
    assert.equal(result.status,409,"B4 altered head attempts zero decision inserts");
  }finally{await f.close();}
});

test("B4 decision freshness refuses changed sealed completion",async()=>{
  const f=await syntheticFixture();try{
    await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;f.edit(e=>{e.binding.engineRevision++;e.summary="Changed sealed snapshot";});
    const result=await f.handle(request(`/api/v1/loop-update-candidates/${c.candidateId}/decision`,"POST",{
      candidateId:c.candidateId,expectedVersion:1,candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,localVersion:1,a2InputVersion:c.a2InputVersion,decision:"accept"},"b4-mutant-freshness-0001"));
    assert.equal(result.status,409,"B4 changed sealed completion attempts zero decision inserts");
  }finally{await f.close();}
});

test("B4 tampered retained decision fails verification",async()=>{
  const f=await syntheticFixture();try{
    await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
    await f.desk.decideLoopCandidate(f.identity,{candidateId:c.candidateId,expectedVersion:1,candidateRecordDigest:c.recordDigest,
      candidateRevision:c.candidateRevision,localVersion:1,a2InputVersion:c.a2InputVersion,decision:"decline"},"b4-decision-tamper-0001");
    await f.db.exec("ALTER TABLE control_loop_update_candidate_decisions DISABLE TRIGGER control_loop_update_candidate_decisions_append_only");
    await f.db.query("UPDATE control_loop_update_candidate_decisions SET auth_tag=$1",[`hmac-sha256:${"0".repeat(64)}`]);
    assert.equal((await f.handle(request("/api/v1/loop-update-candidates"))).status,503,"B4 tampered decision never becomes a readable card");
  }finally{await f.close();}
});

test("B4 stopped or uncertain source cannot record readiness",async()=>{
 const f=await syntheticFixture();try{f.stop();await assert.rejects(f.publish(),/stale/);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,0,"B4 stopped completion records no candidate");
 }finally{await f.close();}
});

test("B4 browser client rejects foreign projection and clears protected failures",async()=>{
 const f=await syntheticFixture(),previous=globalThis.fetch;
 try{
  await f.publish();const card=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
  const {loopCandidateBrowserClientV1:client,LoopCandidateReadErrorV1}=await import("../src/web/v1/improve-control-room-loop-candidate-browser-client");
  globalThis.fetch=async()=>Response.json({schemaVersion:1,candidate:card,observedAt:new Date(now).toISOString()});
  await assert.rejects(client.read(new AbortController().signal,"project:foreign",f.requestId),e=>e instanceof LoopCandidateReadErrorV1&&e.protectedFailure);
  globalThis.fetch=async()=>Response.json({},{status:403});
  await assert.rejects(client.read(new AbortController().signal),e=>e instanceof LoopCandidateReadErrorV1&&e.protectedFailure);
  globalThis.fetch=async()=>Response.json({schemaVersion:1,candidates:[],truncated:false,observedAt:new Date(now).toISOString(),startsDeploy:false,signedDeployApprovalCreated:false,forged:true});
  await assert.rejects(client.read(new AbortController().signal),e=>e instanceof LoopCandidateReadErrorV1&&e.protectedFailure);
 }finally{globalThis.fetch=previous;await f.close();}
});

test("B4 UI freshness, late replies and access loss",async()=>{
 const f=await syntheticFixture();const React=await import("react"),{act}=React,{createRoot}=await import("react-dom/client"),{JSDOM}=await import("jsdom");
 const {ImprovementFinishCard}=await import("../private-app/app/improvement-finish-card");
 const dom=new JSDOM("<div id='root'></div>",{url:"https://product.invalid/",pretendToBeVisual:true});
 let hold=false,deny=false,release:()=>void=()=>{},posts=0;
 const transport:typeof fetch=async(input,options)=>{
  if(options?.method==="POST")posts++;
  const response=deny?Response.json({},{status:403}):await f.handle(request(String(input),options?.method??"GET",options?.body?JSON.parse(String(options.body)):undefined,new Headers(options?.headers).get("idempotency-key")??"b4-ui-probe-00001"));
  if(hold)await new Promise<void>(r=>{release=r;});return response;
 };
 const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,fetch:transport,IS_REACT_ACT_ENVIRONMENT:true};
 const descriptors=Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 const root=createRoot(dom.window.document.getElementById("root")!);
 const settle=async()=>{for(let i=0;i<12;i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});};
 const button=(text:string)=>[...dom.window.document.querySelectorAll("button")].find(b=>b.textContent===text)!;
 try{
  await f.publish();await act(async()=>root.render(React.createElement(ImprovementFinishCard)));await settle();
  const accept=button("Accept this candidate — record only");assert.equal(accept.disabled,false);
  hold=true;await act(async()=>button("Refresh candidate").click());await settle();
  assert.equal(accept.disabled,true,"B4 checking read disables fresh decisions");
  // Exercise the callback boundary independently of the DOM disabled attribute.
  const props=(accept as unknown as Record<string,{onClick:()=>void}>)[Object.keys(accept).find(k=>k.startsWith("__reactProps"))!];
  await act(async()=>props!.onClick());assert.equal(posts,0,"B4 checking source attempts zero inert decision POSTs");
  hold=false;release();await settle();assert.equal(button("Accept this candidate — record only").disabled,false);
  deny=true;await act(async()=>button("Refresh candidate").click());await settle();
  assert.equal(dom.window.document.querySelectorAll("article").length,0,"B4 access loss removes protected retained cards");
  assert.equal(posts,0);
 }finally{release();await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await f.close();}
});

test("B4 retained SYNTHETIC receipt custody rejects symlink and changed bytes",async()=>{
 const f=await syntheticFixture(),fs=await import("node:fs"),path=await import("node:path");
 const outside=path.resolve(".test-tmp/b4-untrusted-output.txt");
 try{
  fs.writeFileSync(outside,"SYNTHETIC sibling bytes");
  const output=path.join(f.retained,"output.txt");fs.unlinkSync(output);fs.symlinkSync(outside,output);
  await assert.rejects(f.publish(),/verification refused/,"B4 symlinked retained output is refused before reading its bytes");
  fs.unlinkSync(output);f.proof("output",true);await f.publish();
  fs.writeFileSync(output,"changed bytes after a valid seal");await assert.rejects(f.publish(),/verification refused/);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,1);
 }finally{fs.rmSync(outside,{force:true});await f.close();}
});

test("B4 Node transport enforces the exact 8192-byte new decision budget",async()=>{
 const f=await syntheticFixture();try{
  const {createPrivateNodeHandler}=await import("../src/web/v1/private-node-handler"),{nodeExchange}=await import("./helpers/web-node");
  const handler=createPrivateNodeHandler({origin,application:{isReady:()=>true,close:()=>f.app.close()},handler:f.handle,
    assets:{count:0,digest:"SYNTHETIC",respond:()=>undefined}});
  const proof=request(),exchange=nodeExchange({path:"/api/v1/loop-update-candidates/loop-candidate:missing/decision",method:"POST",
   headers:["Content-Type","application/json","Origin",origin,"cf-access-jwt-assertion",proof.headers.get("cf-access-jwt-assertion")!,"Idempotency-Key","b4-node-budget-00001"],body:" ".repeat(8193)});
  const calls=f.calls();await handler.handle(exchange.input,exchange.output);
  assert.equal(exchange.output.statusCode,413,"B4 authenticated outer transport refuses 8193 bytes");assert.equal(f.calls(),calls);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidate_decisions")).rows[0]!.n,0);
 }finally{await f.close();}
});

test("B4 unauthorized exact decision replay is reauthorized before source",async()=>{
 const f=await syntheticFixture();try{
  await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
  const body={candidateId:c.candidateId,expectedVersion:1,candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,
   localVersion:1,a2InputVersion:c.a2InputVersion,decision:"accept"};
  const path=`/api/v1/loop-update-candidates/${c.candidateId}/decision`,key="b4-protected-replay-0001";
  assert.equal((await f.handle(request(path,"POST",body,key))).status,201);
  await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE identity_id='identity:web'");
  const before=f.calls();assert.equal((await f.handle(request(path,"POST",body,key))).status,403,"B4 unauthorized original-key replay never returns a decision receipt");
  assert.equal(f.calls(),before,"B4 unauthorized exact replay reads no completion source");
 }finally{await f.close();}
});

test("B4 focused test lanes and unconditional browser registration",async()=>{
 const {readFile}=await import("node:fs/promises"),{reachableTests,workflowCommands}=await import("../scripts/check-test-lane-coverage.mjs");
 const manifest=JSON.parse(await readFile("package.json","utf8")),workflow=await readFile(".github/workflows/ci.yml","utf8");
 const reached=reachableTests(manifest.scripts,workflowCommands(workflow)),components=reachableTests(manifest.scripts,["pnpm run test:components"]);
 for(const file of ["tests/improve-control-room-loop-candidate.test.tsx","tests/improve-control-room-loop-candidate-postgres.test.ts","tests/improve-control-room-loop-candidate-mutations.test.ts"])assert.equal(reached.has(file),true);
 assert.equal(components.has("tests/improve-control-room-loop-candidate.test.tsx"),true);assert.equal(components.has("tests/improve-control-room-loop-candidate-postgres.test.ts"),true);
 assert.equal(components.has("tests/improve-control-room-loop-candidate-mutations.test.ts"),false);
 assert.equal(manifest.scripts["test:improve-control-room-loop-candidate-browser"],"CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 playwright test tests/browser/improve-control-room-loop-candidate.spec.ts");
 for(const name of ["Prove retained loop candidate guards","Prove retained loop candidate Home and saved request"]){
  const block=workflow.slice(workflow.indexOf(`      - name: ${name}`)).split(/\n      - /)[0]!;
  assert.ok(block.includes("pnpm run test:improve-control-room-loop-candidate-"));assert.doesNotMatch(block,/\n\s+if:/);assert.match(block,/timeout-minutes: 5/);
 }
});

test("B4 edited then restored inputs keep the old candidate historical",async()=>{
 const f=await syntheticFixture();try{
  await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
  const settingsText='{"fixture":"SYNTHETIC B4"}',original="SYNTHETIC finished improvement";
  await f.lineage.reviseLoopDraft(f.identity,f.project.projectId,{requestId:f.requestId,expectedVersion:1,description:"Changed approved scope",settingsText},"b4-changed-input-0001");
  await f.lineage.reviseLoopDraft(f.identity,f.project.projectId,{requestId:f.requestId,expectedVersion:2,description:original,settingsText},"b4-restored-input-0001");
  const before=f.calls(),detail=await f.desk.readLoopCandidate(f.identity,f.project.projectId,f.requestId);
  assert.equal(detail.candidate?.freshness,"stale");assert.equal(detail.candidate?.canDecide,false);
  const result=await f.handle(request(`/api/v1/loop-update-candidates/${c.candidateId}/decision`,"POST",{candidateId:c.candidateId,expectedVersion:1,
   candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,localVersion:1,a2InputVersion:c.a2InputVersion,decision:"accept"},"b4-old-tab-input-0001"));
  assert.equal(result.status,409,"B4 restored bytes do not restore a consumed input version");assert.equal(f.calls(),before,"B4 stale local input is refused before source verification");
 }finally{await f.close();}
});

test("B4 Stop before the final verified source snapshot blocks publication",async()=>{
 const f=await syntheticFixture();try{f.stopAtLastSnapshot();await assert.rejects(f.publish(),/stale/);
  assert.equal(f.calls(),2,"B4 stopped outcome is observed by the final source reread");
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,0);
 }finally{await f.close();}
});

test("B4 repository head must agree with the verified completion",async()=>{
 const f=await syntheticFixture();try{
  f.moveRepositoryHead("c".repeat(40));await f.publish().catch(()=>{});
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,0,"B4 a different observed repository head records zero candidates");
 }finally{await f.close();}
});

test("B4 per-card retry latch freezes one inert POST",async()=>{
 const f=await syntheticFixture();const React=await import("react"),{act}=React,{createRoot}=await import("react-dom/client"),{JSDOM}=await import("jsdom");
 const {ImprovementFinishCandidate}=await import("../private-app/app/improvement-finish-card");
 const dom=new JSDOM("<div id='root'></div>",{url:"https://product.invalid/",pretendToBeVisual:true});
 let posts=0,loss=true;const releases:(()=>void)[]=[];const release=()=>{for(const resolve of releases.splice(0))resolve();};
 const transport:typeof fetch=async(input,options)=>{
  posts++;const response=await f.handle(request(String(input),"POST",JSON.parse(String(options?.body)),new Headers(options?.headers).get("idempotency-key")!));
  if(loss){loss=false;throw new TypeError("SYNTHETIC lost decision reply");}
  await new Promise<void>(r=>{releases.push(r);});return response;
 };
 const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,fetch:transport,IS_REACT_ACT_ENVIRONMENT:true};
 const descriptors=Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 const root=createRoot(dom.window.document.getElementById("root")!);
 const settle=async()=>{for(let i=0;i<10;i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});};
 try{
  await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
  // This tests the card's own latch with an independently fresh parent. The
  // ordinary parent freshness gate has its own separate guard-off proof.
  await act(async()=>root.render(React.createElement(ImprovementFinishCandidate,{card:c,fresh:true,isFresh:()=>true,invalidate:()=>{},refresh:()=>{},clearProtected:()=>{}})));
  const button=(text:string)=>[...dom.window.document.querySelectorAll("button")].find(b=>b.textContent===text)!;
  await act(async()=>button("Accept this candidate — record only").click());await settle();assert.equal(posts,1);
  const retry=button("Retry this exact decision"),props=(retry as unknown as Record<string,{onClick:()=>void}>)[Object.keys(retry).find(k=>k.startsWith("__reactProps"))!];
  await act(async()=>{props!.onClick();props!.onClick();});await settle();
  assert.equal(posts,2,"B4 per-card synchronous retry latch attempts exactly one same-key POST");
  release();await settle();
 }finally{release();await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await f.close();}
});

test("B4 Stop after staging exposes retained history without decision authority",async()=>{
 const f=await syntheticFixture();try{
  await f.publish();f.stop();const read=await f.handle(request(`/api/v1/projects/${f.project.projectId}/improvements/loop/${f.requestId}/candidate`));
  assert.equal(read.status,200);const c=(await read.json()).candidate;
  assert.equal(c.freshness,"stale");assert.equal(c.canDecide,false);assert.equal(c.candidateRevision,"b".repeat(40));
  const decision=await f.handle(request(`/api/v1/loop-update-candidates/${c.candidateId}/decision`,"POST",{candidateId:c.candidateId,expectedVersion:1,
   candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,localVersion:1,a2InputVersion:c.a2InputVersion,decision:"accept"},"b4-stopped-decision-0001"));
  assert.equal(decision.status,409);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidate_decisions")).rows[0]!.n,0);
 }finally{await f.close();}
});

test("B4 inert decision transport spy observes forbidden attempts before refusal",async()=>{
 const f=await syntheticFixture();const React=await import("react"),{act}=React,{createRoot}=await import("react-dom/client"),{JSDOM}=await import("jsdom");
 const {ImprovementFinishCandidate}=await import("../private-app/app/improvement-finish-card");
 const dom=new JSDOM("<div id='root'></div>",{url:"https://product.invalid/",pretendToBeVisual:true});
 const forbidden:string[]=[];
 const transport:typeof fetch=async(input,options)=>{
  const path=String(input);
  if(/deliver|publish|install|push|merge/.test(path)){forbidden.push(path);return Response.json({error:"access_denied"},{status:403});}
  return f.handle(request(path,"POST",JSON.parse(String(options?.body)),new Headers(options?.headers).get("idempotency-key")!));
 };
 const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,fetch:transport,IS_REACT_ACT_ENVIRONMENT:true};
 const descriptors=Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 const root=createRoot(dom.window.document.getElementById("root")!);
 try{
  await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
  await act(async()=>root.render(React.createElement(ImprovementFinishCandidate,{card:c,fresh:true,isFresh:()=>true,invalidate:()=>{},refresh:()=>{},clearProtected:()=>{}})));
  const button=[...dom.window.document.querySelectorAll("button")].find(b=>b.textContent==="Accept this candidate — record only")!;
  await act(async()=>button.click());for(let i=0;i<12;i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});
  assert.equal(forbidden.length,0,"B4 inert decision attempts zero delivery operations before any downstream refusal");
  assert.equal((await f.desk.readLoopCandidate(f.identity,f.project.projectId,f.requestId)).candidate?.state,"accepted");
 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await f.close();}
});

test("B4 wire decided state requires version two and a decision time",async()=>{
 const f=await syntheticFixture();try{
  await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
  const {loopCandidateCardSchemaV1}=await import("../src/improve-control-room/v1/loop-candidate-wire");
  assert.equal(loopCandidateCardSchemaV1.safeParse({...c,state:"accepted",version:1,decidedAt:new Date(now).toISOString(),canDecide:false}).success,false,
   "B4 accepted state cannot carry a ready candidate version");
  assert.equal(loopCandidateCardSchemaV1.safeParse({...c,state:"declined",version:2,decidedAt:null,canDecide:false}).success,false,
   "B4 declined state requires its immutable decision time");
 }finally{await f.close();}
});


test("B4 direct recording refuses altered evidence with the real digest",async()=>{
 const f=await syntheticFixture();try{
  const original=f.evidence(),forged=structuredClone(original);forged.summary="Forged finish summary";
  assert.equal(forged.completionDigest,original.completionDigest);
  await assert.rejects(f.desk.recordLoopCandidate(forged),{code:"conflict"},"B4 direct evidence must equal the verified source before signing");
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,0);
 }finally{await f.close();}
});

test("B4 same-key replay refuses the opposite decision",async()=>{
 const f=await syntheticFixture();try{
  await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
  const body={candidateId:c.candidateId,expectedVersion:1,candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,
   localVersion:c.localVersion,a2InputVersion:c.a2InputVersion,decision:"accept"};
  const path=`/api/v1/loop-update-candidates/${c.candidateId}/decision`,key="b4-opposite-replay-0001";
  assert.equal((await f.handle(request(path,"POST",body,key))).status,201);
  assert.equal((await f.handle(request(path,"POST",{...body,decision:"decline"},key))).status,409,"B4 same-key opposite decision conflicts");
  const rows=(await f.db.query<{decision:string}>("SELECT decision FROM control_loop_update_candidate_decisions")).rows;
  assert.deepEqual(rows.map(row=>row.decision),["accept"]);
  assert.equal((await f.handle(request(path,"POST",body,key))).status,200);
 }finally{await f.close();}
});

test("B4 decision URL and body candidate IDs must agree",async()=>{
 const f=await syntheticFixture();try{
  await f.publish();const c=(await f.desk.readLoopCandidates(f.identity)).candidates[0]!;
  const body={candidateId:c.candidateId,expectedVersion:1,candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,
   localVersion:c.localVersion,a2InputVersion:c.a2InputVersion,decision:"accept"};
  const calls=f.calls();
  const response=await f.handle(request("/api/v1/loop-update-candidates/loop-candidate:different/decision","POST",body,"b4-route-binding-0001"));
  assert.equal(response.status,400,"B4 mismatched URL ID is refused before the service");
  assert.equal(f.calls(),calls);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidate_decisions")).rows[0]!.n,0);
 }finally{await f.close();}
});

test("B4 CI mutation partitions retain five-minute step bounds",async()=>{
 const {readFile}=await import("node:fs/promises");
 const workflow=await readFile(".github/workflows/ci.yml","utf8"),manifest=JSON.parse(await readFile("package.json","utf8"));
 const job=workflow.split("  mutation-checks:")[1]!.split("\n  pr-claims:")[0]!;
 assert.match(job,/timeout-minutes: 45/u);
 for(const part of ["source","sql-binding","sql-authority"]){
  const script=`test:improve-control-room-loop-candidate-mutations:${part}`;
  assert.equal(typeof manifest.scripts[script],"string","B4 bounded CI partitions each invoke an executable lane");
  assert.match(manifest.scripts[script],/--test-name-pattern=/u);
  const step=job.split(/      - /u).find(s=>s.includes(`run: pnpm run ${script}\n`));
  assert.ok(step,`B4 CI reaches mutation partition ${part}`);assert.match(step,/timeout-minutes: 5/u);assert.doesNotMatch(step,/\n        if:/u);
 }
});
