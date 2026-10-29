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
/** Synthetic local-close journal: only completed moves contribute to the receipt.
 * Re-entry reads the saved journal instead of moving a second time. */
export function ownedCleanupCapability(capability:LoopFinalizationCapabilityV1,root:string,
  hooks:{state?:"complete"|"refused"|"uncertain";called?:()=>Promise<void>}={}){
  return {...capability,async cleanup(binding:LoopFinalizationBindingV1,retentionDigest:string){
    await hooks.called?.();
    const inspection=await capability.inspect((({eventDigest:_event,...target})=>target)(binding));
    const state=hooks.state??"complete",journal=join(root,"synthetic-close-journal.json");
    let moves:{source:string;destination:string;sha256:string;state:"done"}[]=[];
    if(state!=="refused"){
      try{moves=JSON.parse(await readFile(journal,"utf8"));}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
        moves=[{source:"synthetic-run.log",destination:"synthetic-trash/run.log",sha256:sha256Digest("SYNTHETIC log"),state:"done"}];
        await durable(journal,moves);
      }
    }
    const reasons={complete:"CLEANUP_COMPLETE",refused:"CLEANUP_REFUSED",uncertain:"CLEANUP_UNCERTAIN"} as const;
    return{schemaVersion:1 as const,binding,inventoryDigest:inspection.observation.inventoryDigest,retentionDigest,
      state,removedDigest:sha256Digest(moves),reasonCode:reasons[state],finishedAt:inspection.observation.observedAt};
  }};
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

// I-1's private setup supplies connections and the already-created signed Start
// lineage, never a qualification verdict or completion JSON. R is created by the
// lead, not by these tests. Opens must reuse the same persistent database and
// signed target, and close must close connections only. Cold GET child processes
// reopen this setup. The lead declares comma-separated noncredential variable
// names in CONTROL_ROOM_I1_CHILD_ENV for database/configuration reopening. Only
// those names plus HOME/TMPDIR pass through; credential-looking names or store
// paths are refused at gate start. Fixed gate controls override passthrough.
// The test owns every finalizer/publisher assertion.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { DatabaseClient } from "../../src/persistence/database";
import type { LoopAdapterConfigurationV1 } from "../../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomLoopAdapterV1 } from "../../src/web/v1/improve-control-room-loop-adapter";
import type { VerifiedWebIdentity } from "../../src/web/v1/access-verifier";
import { ImproveControlRoomDeskServiceV1 } from "../../src/improve-control-room/v1/service";
import { LoopCandidatePublisherV1 } from "../../src/improve-control-room/v1/loop-candidate-publisher";
import { ImproveControlRoomLoopServiceV1 } from "../../src/web/v1/improve-control-room-loop-service";
import { loopFinalizationTargetSchemaV1 } from "../../src/web/v1/improve-control-room-loop-finalization";

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
const execI1 = promisify(execFile);
export type I1Gate = "B3a" | "B3c-refused" | "B3c-owned" | "B4";
export type I1Setup = {
  client:DatabaseClient; identity:VerifiedWebIdentity; integrityKey:Uint8Array;
  scope:{tenantId:string;workspaceId:string}; target:LoopFinalizationTargetV1;
  clock:()=>number; close:()=>Promise<void>;
  monitorMutations:{toolingRevision:string;argv:string[];outputFile:string};
  // Preparation installs transport stubs and arranges each refusal. The gate
  // executes cr deliver itself and reads the resulting transport trace.
  delivery?: (scenario:string,input:{run:string;head:string})=>Promise<{
    bodyFile:string;readyFile:string;transportBin:string;traceFile:string;restore:()=>Promise<void>;
  }>;
  modelLaunchDenials?:()=>Promise<{argv:string[];traceFile:string}[]>;
};
export const i1ByteHash = (bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
export async function i1Regular(file:string,root?:string){
  assert.ok(isAbsolute(file)&&!/(?:^|[/\\])(?:\.env|\.codex|\.hermes|\.aws|auth\.json|tokens?)(?:[/\\]|$)/i.test(file),"I-1 requires R: noncredential absolute path");
  assert.equal(await realpath(file),file,"I-1 refuses symlink paths");
  assert.equal((await lstat(file)).isFile(),true);
  if(root)assert.ok(relative(root,file)!==""&&relative(root,file)!==".."&&!relative(root,file).startsWith(`..${sep}`)&&!isAbsolute(relative(root,file)),"I-1 path must be inside R");
  return file;
}
export function i1ChildEnvironment(env:Readonly<Record<string,string|undefined>>=process.env):Record<string,string|undefined>{
  const names=(env.CONTROL_ROOM_I1_CHILD_ENV??"").split(",").map(name=>name.trim()).filter(Boolean);
  const child:Record<string,string|undefined>={HOME:env.HOME,TMPDIR:env.TMPDIR};
  const credentialStore=/(?:^|[/\\:=;\s"'?&#])(?:\.env(?:\.[\w.-]+)?|\.codex|\.hermes|\.aws|\.ssh|\.gnupg|\.netrc|\.npmrc|\.pgpass|auth\.json|credentials?(?:\.[\w.-]+)?|tokens?(?:\.[\w.-]+)?|keychains?|secrets?(?:\.[\w.-]+)?|\.git-credentials|\.docker[/\\]config\.json|\.kube[/\\]config|id_rsa|id_ed25519|\.pypirc|gcloud|api-keys?(?:\.[\w.-]+)?)(?=$|[/\\:;\s"'?&#])/i;
  for(const name of names){
    assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),"I-1 CONTROL_ROOM_I1_CHILD_ENV requires variable names");
    assert.ok(!/KEY|TOKEN|SECRET|PASSWORD|AUTH|COOKIE/i.test(name),"I-1 CONTROL_ROOM_I1_CHILD_ENV refuses credential-looking variable names");
    const value=env[name];
    assert.ok(value===undefined||!credentialStore.test(value),"I-1 CONTROL_ROOM_I1_CHILD_ENV refuses credential store values");
    if(value!==undefined)Object.defineProperty(child,name,{value,enumerable:true,configurable:true,writable:true});
  }
  child.CONTROL_ROOM_I1_CHILD_ENV=names.join(",");
  return child;
}
export async function installedI1Gate(t:Pick<TestContext,"after">,gate:I1Gate){
  const childEnvironment=i1ChildEnvironment();
  const root=process.env.CONTROL_ROOM_I1_R;
  assert.ok(root&&isAbsolute(root),`${gate} requires R: CONTROL_ROOM_I1_R and a reviewed private setup module`);
  assert.equal(await realpath(root),root);
  const prefix=gate==="B4"?"B4":gate==="B3a"?"B3A":"B3C";
  const setupFile=process.env[`CONTROL_ROOM_${prefix}_A2_CONTRACT`];
  assert.ok(setupFile,`${gate} requires R: CONTROL_ROOM_${prefix}_A2_CONTRACT must export openI1ProductGate`);
  await i1Regular(setupFile,root);
  const carrierFile=await i1Regular(join(root,"config/contract.json"),root);
  const carrier=JSON.parse(await readFile(carrierFile,"utf8"));
  // cr-entry.py replaces CR_* from this pinned file; the parent environment
  // alone cannot tell us where cr.py's trash_root_for will move the logs.
  const entryRoots=JSON.parse(await readFile(await i1Regular(join(root,"tools/loop/bridge/cr-entry.json"),root),"utf8"));
  const workRoot=entryRoots.CR_WORK_ROOT;
  const trashMessage=`${gate} requires R: CR_WORK_ROOT and its sibling .cr-trash must be inside R`;
  assert.ok(typeof workRoot==="string"&&isAbsolute(workRoot),trashMessage);
  assert.ok(typeof entryRoots.CR_HOME_WORK==="string"&&isAbsolute(entryRoots.CR_HOME_WORK),trashMessage);
  // Clones use WORK.parent; logs outside WORK use HOME_WORK itself.
  for(const trashRoot of [join(dirname(workRoot),".cr-trash"),join(entryRoots.CR_HOME_WORK,".cr-trash")]){
    const inside=relative(root,trashRoot);
    assert.ok(inside!==""&&inside!==".."&&!inside.startsWith(`..${sep}`)&&!isAbsolute(inside),trashMessage);
  }
  assert.equal(workRoot,carrier.configuration.workRoot,`${gate} requires R: CR_WORK_ROOT must match carrier workRoot`);
  await i1Regular(carrier.modulePath,root);
  assert.equal(carrier.modulePath,join(root,"tools/loop/bridge/a2-contract.mjs"));
  assert.equal(i1ByteHash(await readFile(carrier.modulePath)),carrier.moduleSha256,"I-1 checks module bytes before import");
  const module=await import(pathToFileURL(carrier.modulePath).href);
  const lineage={toolingRevision:carrier.configuration.toolingRevision,
    decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),
    decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),matchesSavedInput:(run:{toolingRevision:string},observation:{settingsDigest:string;confirmation:{path:string;sha256:string}},input:{description:string;settingsText:string;requestSha256:string;settingsSha256:string})=>
      run.toolingRevision===carrier.configuration.toolingRevision&&observation.confirmation.path==="docs/request-source.md"
      &&observation.confirmation.sha256===i1ByteHash(input.description)&&input.requestSha256===i1ByteHash(input.description)
      &&observation.settingsDigest===i1ByteHash(input.settingsText)&&input.settingsSha256===i1ByteHash(input.settingsText)};
  const loaded=await module.loadA2Carrier(carrierFile,{root,lineage});
  const configuration=loaded.configuration as LoopAdapterConfigurationV1;
  assert.match(configuration.toolingRevision,/^sha256:[a-f0-9]{64}$/);
  assert.equal(configuration.executionIdentity.uid,process.getuid!());
  assert.equal(configuration.executionIdentity.isolationEvidenceDigest,sha256Digest("R272: no worker account"));
  assert.equal(carrier.recovery,true,"I-1 requires A2F-6 recovery in R");
  assert.equal(carrier.monitoring,true,"I-1/R6 requires A2M-4 monitoring in R");
  const settings=JSON.parse(await readFile(configuration.settingsFile,"utf8"));
  assert.equal(settings.limits.attempt_minutes,1,"I-1/R6 requires the saved one-minute budget");
  const setupModule=await import(pathToFileURL(setupFile).href);
  assert.equal(typeof setupModule.openI1ProductGate,"function",`${gate} requires R: executable setup, not proof booleans`);
  const f=await setupModule.openI1ProductGate({gate,configuration}) as I1Setup;
  let cleanupProduct=async()=>{};t.after(async()=>{try{await cleanupProduct();}finally{await f.close();}});
  assert.equal(f.monitorMutations?.toolingRevision,configuration.toolingRevision,"R6 requires monitor mutation evidence at R's pinned tooling revision");
  assert.deepEqual(f.monitorMutations.argv,["/usr/bin/python3","-B","loop/mutate_a2.py","all"]);
  const mutations=await readFile(await i1Regular(f.monitorMutations.outputFile,root),"utf8");
  assert.match(mutations,/(?:^|\n)RESULT: PASS \(all slices\)\s*$/,"R6 requires A2M-3 mutate_a2.py all PASS output");
  const target=loopFinalizationTargetSchemaV1.parse(f.target);
  assert.equal(target.run.toolingRevision,configuration.toolingRevision);
  assert.equal(target.tenantId,f.scope.tenantId);assert.equal(target.workspaceId,f.scope.workspaceId);
  const stateFile=join(configuration.runRoot,target.run.loopRunId,"run.json");
  const state=async()=>JSON.parse(await readFile(await i1Regular(stateFile,root),"utf8"));
  let adapter=createImproveControlRoomLoopAdapterV1(configuration);
  assert.equal(target.schemaDigest,adapter.schemaDigest);
  let web:ReturnType<typeof createPrivateWebProcess>|undefined;
  let bridge:ImproveControlRoomLoopServiceV1|undefined;
  const candidateConfig=()=>({integrityKey:f.integrityKey,contract:adapter.contract,schemaDigest:adapter.schemaDigest,
    source:adapter.finalization!.source,repository:adapter.finalization!.repository});
  const desk=()=>new ImproveControlRoomDeskServiceV1(f.client,f.scope,f.integrityKey,undefined,f.clock,adapter.contract,candidateConfig());
  const publisher=()=>new LoopCandidatePublisherV1(desk(),candidateConfig());
  const closeProduct=async()=>{await web?.close();web=undefined;await bridge?.close();bridge=undefined;await adapter.close();};
  cleanupProduct=closeProduct;
  let coldCard=false;
  const reopen=async()=>{await closeProduct();coldCard=true;
    const again=await module.loadA2Carrier(carrierFile,{root,lineage});adapter=createImproveControlRoomLoopAdapterV1(again.configuration);
  };
  const card=async()=>{
    if(coldCard){
      // A fresh Node process reopens the private setup's persistent database.
      // Neither this process's module cache nor a run-link map can serve it.
      const child=await execI1(process.execPath,["--import","tsx",resolve("tests/helpers/improve-control-room-loop-finalization.ts"),"--i1-card-host",gate],{
        cwd:process.cwd(),encoding:"utf8",timeout:60000,maxBuffer:1<<20,env:{...childEnvironment,NODE_ENV:"test",PATH:"/usr/bin:/bin",CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1",CONTROL_ROOM_I1_R:root,
          [`CONTROL_ROOM_${prefix}_A2_CONTRACT`]:setupFile}});
      const line=child.stdout.split("\n").find(value=>value.startsWith("I1_CARD_JSON "));
      assert.ok(line,"I-1 cold card process must report its completed GET");
      const result=JSON.parse(line.slice("I1_CARD_JSON ".length));assert.deepEqual(result.target,target);coldCard=false;return result.card;
    }
    // The first operation after reopen is this card GET, before status/finalize.
    web??=createPrivateWebProcess({origin,...trust,...f.scope,loadKeys:async()=>trust.keys,clock:f.clock,
      database:{client:f.client,close:async()=>{}},loopCandidates:candidateConfig()});
    const response=await web.handle(request(`/api/v1/projects/${target.projectId}/improvements/loop/${target.requestId}/candidate`),()=>new Response("missing",{status:404}));
    assert.equal(response.status,200,"I-1 saved-request card GET");return response.json();
  };
  const cr=async(args:string[])=>{
    const result=await execI1(configuration.interpreter,[configuration.entrypoint,...args],{cwd:configuration.cwd,
      encoding:"utf8",env:{NODE_ENV:"test",PATH:"/usr/bin:/bin",LANG:"C.UTF-8",LC_ALL:"C.UTF-8"},timeout:60000,maxBuffer:1<<20}).catch(error=>{
      throw new Error(`I-1 cr ${args.join(" ")} exit=${error.code} stdout=${String(error.stdout)} stderr=${String(error.stderr)}`);
    });
    return JSON.parse(result.stdout);
  };
  const nativeRead=()=>cr(["finalize",target.run.loopRunId,"read","--json"]);
  const count=async()=>Number((await f.client.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates WHERE run_link_id=$1",[target.runLinkId])).rows[0]!.n);
  const snapshot=async()=>{const saved=await state();await i1Regular(join(saved.clone,".git","HEAD")).catch(async()=>{
      // An adopted worktree has a regular .git pointer rather than a directory.
      await i1Regular(join(saved.clone,".git"));
    });
    const git=async(args:string[])=>(await execI1("/usr/bin/git",["-C",saved.clone,"-c","core.fsmonitor=false",...args],{timeout:30000,maxBuffer:1<<20,encoding:"utf8",env:{NODE_ENV:"test",PATH:"/usr/bin:/bin",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"}})).stdout;
    return {head:await git(["rev-parse","HEAD"]),status:await git(["status","--porcelain=v1","--untracked-files=all"])};
  };
  const finalize=async(capability=adapter.finalization!,publish=(input:{runLinkId:string;completionDigest:string})=>publisher().publishCompletion(input))=>{
    assert.ok(capability,"I-1 requires installed A2 finalization");
    return createImproveControlRoomLoopFinalizerV1({capability,publishCompletion:publish,authorize:async()=>{
      const view=await desk().viewLoopDesk(f.identity,target.projectId);
      const saved=view.loopRequests.find(r=>r.requestId===target.requestId);
      assert.ok(saved?.savedAuthorization,"I-1 rechecks current owner authority and saved Start authorization");
      assert.equal(saved.currentVersion,target.localVersion);assert.equal(saved.runLink?.runLinkId,target.runLinkId);
      assert.equal(saved.runLink?.loopRunId,target.run.loopRunId);assert.equal(saved.runLink?.toolingRevision,target.run.toolingRevision);
      assert.equal(saved.requestSha256,target.requestSha256);assert.equal(saved.settingsSha256,target.settingsSha256);
      return target;
    },signal:new AbortController().signal}).finalize(target);
  };
  const rehash=async(record:LoopFinalizationRecordV1)=>{
    const retained=join(configuration.runRoot,target.run.loopRunId,"finalization/retained",record.observation.inventoryDigest.slice(7));
    const bytes=await readFile(await i1Regular(join(retained,"SEALED.json"),root)),seal=JSON.parse(bytes.toString());
    assert.equal(`sha256:${i1ByteHash(bytes)}`,record.custody?.retentionDigest);
    assert.equal(seal.run,target.run.loopRunId);assert.equal(seal.inventory_sha256,record.observation.inventoryDigest.slice(7));
    assert.ok(seal.files.length>0,"I-1 retained corpus is nonempty");
    for(const entry of seal.files){const data=await readFile(await i1Regular(join(retained,"files",entry.name),retained));
      assert.equal(data.length,entry.size);assert.equal(i1ByteHash(data),entry.sha256);}
    const archiveBytes=await readFile(await i1Regular(join(retained,"archive/manifest.json"),retained));
    assert.equal(i1ByteHash(archiveBytes),seal.archive_manifest_sha256);
    const archive=JSON.parse(archiveBytes.toString());assert.equal(archive.complete,true);assert.equal(archive.restored,true);
    for(const [name,hash] of Object.entries(archive.artifacts))assert.equal(i1ByteHash(await readFile(await i1Regular(join(retained,"archive",name),retained))),hash);
  };
  console.log(`I-1 gate=${gate} run=${target.run.loopRunId} tooling=${configuration.toolingRevision} isolation=R272`);
  return {f,root,carrier,configuration,target,state,stateFile,adapter:()=>adapter,reopen,card,cr,nativeRead,count,snapshot,finalize,publisher,rehash,
    bridge:()=>bridge??=new ImproveControlRoomLoopServiceV1(f.client,f.scope,{integrityKey:f.integrityKey,adapter},f.clock)};
}

export async function i1IsolatedCommand(configuration:LoopAdapterConfigurationV1,argv:string[],path="/usr/bin:/bin"){
  // Transport denial is enforced outside the child, not by a caller's boolean.
  return execI1("/usr/bin/sandbox-exec",["-p","(version 1)(allow default)(deny network*)",...argv],{
    cwd:configuration.cwd,encoding:"utf8",env:{NODE_ENV:"test",PATH:path,LANG:"C.UTF-8",LC_ALL:"C.UTF-8"},timeout:60000,maxBuffer:1<<20})
    .then(value=>({exitCode:0,stdout:value.stdout,stderr:value.stderr}),error=>{
      assert.equal(typeof error.code,"number",`I-1 isolated child failed to execute: ${String(error)}`);
      return {exitCode:error.code as number,stdout:String(error.stdout),stderr:String(error.stderr)};
    });
}

if(process.argv[2]==="--i1-card-host"){
  const hooks:Array<()=>Promise<void>>=[];
  let result;
  try{
    const gate=process.argv[3] as I1Gate;
    assert.ok(["B4","B3c-owned"].includes(gate));
    const g=await installedI1Gate({after(fn){if(fn)hooks.push(async()=>{await Reflect.apply(fn,undefined,[]);});}},gate);
    result={target:g.target,card:await g.card()};
  }finally{for(const hook of hooks)await hook();}
  console.log(`I1_CARD_JSON ${JSON.stringify(result)}`);
}
