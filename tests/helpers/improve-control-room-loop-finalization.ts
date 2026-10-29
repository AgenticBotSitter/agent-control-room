import { createPrivateWebProcess } from "../../src/web/v1/private-process";
import { taskFixture } from "./web-task";
import { now, origin, request, trust } from "./web-foundation";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1 } from "../../src/improve-control-room/v1/schemas";
import { sha256Digest } from "../../src/security";
export const KEY=new Uint8Array(32).fill(64);
const toolingRevision=sha256Digest({fixture:"SYNTHETIC B4 tooling"}),schemaDigest=sha256Digest({fixture:"SYNTHETIC B4 schema"});
const contract={toolingRevision,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),matchesSavedInput:()=>true};
export async function syntheticCandidateFixture() {
  const f = await taskFixture();
  const { ImproveControlRoomDeskServiceV1 } = await import("../../src/improve-control-room/v1/service");
  const { ImproveControlRoomLoopServiceV1 } = await import("../../src/web/v1/improve-control-room-loop-service");
  const { LoopCandidatePublisherV1, LoopCandidateStaleCompletionV1 } = await import("../../src/improve-control-room/v1/loop-candidate-publisher");
  const { loopByteHashV1 } = await import("../../src/web/v1/improve-control-room-loop-adapter");
  const { loopCandidateEvidenceSchemaV1 } = await import("../../src/improve-control-room/v1/loop-candidate-wire");
  const { canonicalJson, hmacSha256Tag } = await import("../../src/security");
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`,[f.project.projectId]);
  const settingsText='{"fixture":"SYNTHETIC B4"}', description="SYNTHETIC finished improvement";
  const run={adapterId:"adapter:synthetic",loopRunId:"synthetic-run:b4",toolingRevision,a2SchemaVersion:1 as const};
  const confirmedContract={...contract,matchesSavedInput:(_run:unknown,o:{settingsDigest:string;confirmation:{sha256:string}},i:{description:string;settingsText:string}) =>
    o.settingsDigest===loopByteHashV1(i.settingsText) && o.confirmation.sha256===loopByteHashV1(i.description)};
  let status: import("../../src/web/v1/improve-control-room-loop-adapter").LoopEngineStatusV1={run,revision:4,inputVersion:"SYNTHETIC:1",state:"ready",description,
    settingsSha256:loopByteHashV1(settingsText),settingsDigest:loopByteHashV1(settingsText),
    confirmation:{path:"request.md",sha256:loopByteHashV1(description),at:new Date(now).toISOString(),who:"owner",input_version:"SYNTHETIC:1"},
    approval:null,question:null,progress:{step:"final",completed:1,attention:"none"},receipts:[]};
  const forbidden:string[]=[], unexpected=async()=>{forbidden.push("unexpected operation");throw new Error("SYNTHETIC forbidden");};
  const adapter:import("../../src/web/v1/improve-control-room-loop-adapter").LoopAdapterV1={adapterId:run.adapterId,toolingRevision,schemaDigest,settingsText,contract:confirmedContract,
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
  let evidence:import("../../src/improve-control-room/v1/loop-candidate-wire").LoopCandidateEvidenceV1=loopCandidateEvidenceSchemaV1.parse({schemaVersion:1,
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
    database:{client:f.client,close:async()=>{}},loopCandidates:config,loopBridge:{integrityKey:KEY,adapter}});
  const handle=(r:Request)=>app.handle(r,()=>new Response("unused",{status:404}));
  return {...f,config,adapter,desk,lineage,bridge,app,publisher,handle,forbidden,
    status:()=>structuredClone(status),editStatus:(patch:Partial<typeof status>)=>{status={...status,...patch};},requestId:draft.request.requestId,runLinkId:link.runLink.runLinkId,
    evidence:()=>structuredClone(evidence),edit:(change:(e:typeof evidence)=>void)=>{change(evidence);writeRetained();},retained,calls:()=>calls,
    unavailable:(v:boolean)=>{unavailable=v;},stop:()=>{status={...status,state:"stopped"};},stopAtLastSnapshot:()=>{stopAt=observations+2;},moveRepositoryHead:(v:string)=>{repositoryHead=v;},dirty:(v:boolean)=>{dirty=v;},proof:(name:keyof typeof proof,v:boolean)=>{proof={...proof,[name]:v};writeRetained();},
    publish:()=>publisher.publishCompletion({runLinkId:link.runLink.runLinkId,completionDigest:evidence.completionDigest}),
    close:async()=>{await app.close();await bridge.close();await f.db.close();fs.rmSync(retained,{recursive:true,force:true});}};
}

import { DatabaseSync } from "node:sqlite";
import { open, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, hmacSha256Tag } from "../../src/security";
import { createImproveControlRoomLoopFinalizerV1, verifyFinalizationRecordV1, type LoopFinalizationBindingV1,
  type LoopFinalizationCapabilityV1, type LoopFinalizationTargetV1, type LoopFinalizationObservationV1, type LoopFinalizationRecordV1 } from "../../src/web/v1/improve-control-room-loop-finalization";
export type FixtureState = {target:LoopFinalizationTargetV1;observation:LoopFinalizationObservationV1;ended:boolean;
  retentionDigest:string;corpus:Record<string,string>};
const fixturePurpose="SYNTHETIC B3c finalization record";
async function durable(path:string,value:unknown){
  const f=await open(path+".next","w");try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}
  await rename(path+".next",path);
  const parent=await open(join(path,".."),"r");try{await parent.sync();}finally{await parent.close();}
}
export async function persistentFinalizationCapability(root:string,dependencies:Pick<LoopFinalizationCapabilityV1,"source"|"repository">,
  hooks:{acquired?:()=>Promise<void>;retained?:()=>Promise<void>;appended?:(record:LoopFinalizationRecordV1)=>Promise<void>}={}){
  const state=async()=>JSON.parse(await readFile(join(root,"finalization-state.json"),"utf8")) as FixtureState;
  const recordPath=join(root,"finalization-record.json"),fencePath=join(root,"finalization-fence.sqlite");
  // The fixture's SQLite transaction is OS-released after death. Its generation
  // is never inferred from an old lock file or a PID. Each run has its own fence.
  const capability:LoopFinalizationCapabilityV1={...dependencies,enabled:()=>true,
    inspect:async target=>{
      const saved=await state();if(canonicalJson(target)!==canonicalJson(saved.target))throw new Error("SYNTHETIC input changed");
      return{observation:structuredClone(saved.observation),termination:{schemaVersion:1,binding:saved.observation.binding,
        inventoryDigest:saved.observation.inventoryDigest,state:saved.ended?"already-ended":"uncertain",
        ownershipDigest:sha256Digest("SYNTHETIC positively ended writer inventory"),observedAt:saved.observation.observedAt}};
    },
    withFence:async(_binding,work)=>{
      const db=new DatabaseSync(fencePath);try{
        try{db.exec("BEGIN IMMEDIATE");}catch{throw new Error("SYNTHETIC fence busy");}
        await hooks.acquired?.();return await work();
      }finally{try{db.exec("ROLLBACK");}catch{/* acquisition did not succeed */}db.close();}
    },
    retain:async(binding,inventoryDigest)=>{
      const saved=await state();
      for(const [name,hash] of Object.entries(saved.corpus)){
        const bytes=await readFile(join(root,name));if(sha256Digest([...bytes])!==hash)throw new Error("SYNTHETIC retained corpus changed");
      }
      if(!saved.ended)throw new Error("SYNTHETIC live writer");
      await hooks.retained?.();return{schemaVersion:1,binding,inventoryDigest,retentionDigest:saved.retentionDigest,verifiedAt:saved.observation.observedAt};
    },
    readRecord:async target=>{
      let bytes:string;try{bytes=await readFile(recordPath,"utf8");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
      const {record,tag}=JSON.parse(bytes);if(tag!==hmacSha256Tag(KEY,{purpose:fixturePurpose,record}))throw new Error("SYNTHETIC corrupt record seal");
      return verifyFinalizationRecordV1(record,target);
    },
    appendRecord:async(binding,record)=>{
      const {eventDigest:_event,...target}=binding,prior=await capability.readRecord(target);
      if(prior?.recordDigest===record.recordDigest)return prior;
      if((prior?.recordDigest??null)!==record.previousDigest||record.sequence!==(prior?.sequence??0)+1)throw new Error("SYNTHETIC append conflict");
      await durable(recordPath,{record,tag:hmacSha256Tag(KEY,{purpose:fixturePurpose,record})});
      await hooks.appended?.(record);return record;
    },
  };
  return capability;
}
export async function finalizationFixture(){
  const f=await syntheticCandidateFixture();
  const scope={tenantId:"tenant:web",workspaceId:"workspace:web"};
  const start=(await f.client.query<{command_id:string;binding:unknown}>("SELECT command_id,binding FROM control_loop_improvement_commands WHERE entry_kind='claim' AND operation='start'")).rows[0]!;
  const authorization=(await f.client.query<{id:string}>("SELECT id FROM control_loop_improvement_authorizations")).rows[0]!;
  const s=f.status(),e=f.evidence();
  const target:LoopFinalizationTargetV1={schemaVersion:1,...scope,projectId:f.project.projectId,requestId:f.requestId,ownerIdentityId:"identity:web",
    runLinkId:f.runLinkId,localVersion:1,authorizationId:authorization.id,startCommandId:start.command_id,startBindingDigest:sha256Digest(start.binding),
    run:s.run,inputVersion:s.inputVersion,requestSha256:e.binding.requestSha256,settingsSha256:e.binding.settingsSha256,
    settingsDigest:s.settingsDigest,expectedRevision:s.revision,schemaDigest:f.config.schemaDigest};
  const corpus:Record<string,string>={};
  for(const name of ["completion.json","completion.auth","receipt.json","output.txt","terminal.json","retention.json"])corpus[name]=sha256Digest([...await readFile(join(f.retained,name))]);
  const observation:LoopFinalizationObservationV1={schemaVersion:1,binding:{...target,eventDigest:sha256Digest({outcome:"candidate_ready",completionDigest:e.completionDigest})},outcome:"candidate_ready",reasonCode:"FINISHED",
    evidenceDigest:sha256Digest({run:s.run,inputVersion:s.inputVersion,event:"terminal"}),completionDigest:e.completionDigest,inventoryDigest:sha256Digest(corpus),observedAt:new Date(now).toISOString()};
  const state:FixtureState={target,observation,ended:true,retentionDigest:e.retentionDigest,corpus};
  const save=()=>writeFile(join(f.retained,"finalization-state.json"),JSON.stringify(state));await save();
  // Precreate before hosts contend, keeping setup outside the measured barrier.
  const db=new DatabaseSync(join(f.retained,"finalization-fence.sqlite"));db.exec("CREATE TABLE IF NOT EXISTS fixture(id INTEGER PRIMARY KEY)");db.close();
  const capability=await persistentFinalizationCapability(f.retained,f.config);
  const adapter={...f.adapter,finalization:capability};
  const service=()=>new (f.bridge.constructor as typeof import("../../src/web/v1/improve-control-room-loop-service").ImproveControlRoomLoopServiceV1)(f.client,scope,{integrityKey:KEY,adapter,loopCandidates:f.config},()=>now);
  const bridge=service(),internalTarget={projectId:target.projectId,requestId:target.requestId,ownerIdentityId:target.ownerIdentityId};
  return{...f,scope,target,state,save,capability,adapter,bridge,service,internalTarget,
    observe:()=>bridge.finalizationPort().observe(internalTarget,new AbortController().signal)};
}

// The helper is import-inert. All real subprocess modes require explicit entry
// dispatch, bounded fixture arguments, and an IPC parent that owns their handles.
async function host(mode:string,root:string){
  if(!["finalizer-host","owned-child","owned-grandchild","second-run-sentinel"].includes(mode)||!root||!resolve(root).startsWith(resolve(".test-tmp")+"/"))throw new Error("SYNTHETIC invalid host arguments");
  if(mode!=="finalizer-host"){
    process.send?.({kind:"ready",mode});
    await new Promise<void>(done=>{process.once("disconnect",done);process.once("message",message=>{if(message==="close")done();});});return;
  }
  const wait=(kind:string)=>new Promise<unknown>(done=>{
    const receive=(message:unknown)=>{if((message as {kind?:string})?.kind===kind){process.off("message",receive);done(message);}};process.on("message",receive);
  });
  process.once("disconnect",()=>process.exit(0));
  const acquired=async()=>{const release=wait("release");process.send?.({kind:"acquired"});await release;};
  const unavailable=async()=>{throw new Error("SYNTHETIC host source is server-owned");};
  const c=await persistentFinalizationCapability(root,{source:{toolingRevision:sha256Digest("SYNTHETIC host"),schemaDigest:sha256Digest("SYNTHETIC host schema"),readVerifiedCompletion:unavailable},repository:{observe:unavailable}},{acquired});
  const go=wait("go");process.send?.({kind:"ready"});await go;
  try{
    const state=JSON.parse(await readFile(join(root,"finalization-state.json"),"utf8")) as FixtureState;
    const record=await createImproveControlRoomLoopFinalizerV1({capability:c,signal:new AbortController().signal,
      authorize:async()=>(JSON.parse(await readFile(join(root,"finalization-state.json"),"utf8")) as FixtureState).target,
      publishCompletion:async input=>{const reply=wait("publication");process.send?.({kind:"publish",input});return (await reply as {receipt:import("../../src/improve-control-room/v1/loop-candidate-wire").LoopCandidateCompletionReceiptV1}).receipt;}}).finalize(state.target);
    process.send?.({kind:"done",digest:record?.recordDigest});
  }catch(error){process.send?.({kind:error instanceof Error&&error.message==="SYNTHETIC fence busy"?"busy":"error"});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&process.argv[2]==="--fixture-host"){
  await host(process.argv[3]!,process.argv[4]!);
  process.disconnect?.();
}
