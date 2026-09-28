import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { DatabaseClient, DatabaseSession, QueryResult } from "../src/persistence/database";
import { LinearPipelineServiceV1, PipelineAdvanceErrorV1, PipelineAdvanceServiceV1, ProductionPipelineAdvanceAuthorityV1,
  ProductionPipelineAdvanceCapabilityV1,
  type PipelineAdvanceCapabilityV1 } from "../src/pipelines/v1";
import type { PipelineStageResolutionV1 } from "../src/pipelines/v1";
import { computeAuthorityDigest, hmacSha256Tag, sha256Digest } from "../src/security";
import { taskFixture } from "./helpers/web-task";
import { now as webNow } from "./helpers/web-foundation";
import { createPipelineAdvanceCycleV1 } from "../src/web/v1/private-task-startup";

const key=new Uint8Array(32).fill(41), at=Date.parse("2026-09-27T12:00:00.000Z"), iso=(n=0)=>new Date(at+n).toISOString();
const digest=(c:string)=>`sha256:${c.repeat(64)}`;
const result=<T>(rows:T[]):QueryResult<T>=>({rows});
const templateDefinition={name:"Pipeline",description:"Bounded pipeline.",stages:[
  {ordinal:0,stageKind:"build",role:"builder",description:"Build.",requiredCapability:"code.change",workerId:"worker:one",
    workerKind:"codex",nodeId:"node:one",selectionKey:"selection:one",model:"model-one",effort:"high",provider:null,profile:null,
    allowedPaths:["src/**"],maximumChangedFiles:12,maximumChangedBytes:65536,maxLoops:1},
  {ordinal:1,stageKind:"check",role:"checker",description:"Check.",requiredCapability:"code.review",workerId:"worker:two",
    workerKind:"claude-code",nodeId:"node:two",selectionKey:"selection:two",model:"model-two",effort:"high",provider:null,profile:null,maxLoops:1},
  {ordinal:2,stageKind:"signoff",role:"validator",description:"Validate.",requiredCapability:"code.validate",workerId:"worker:three",
    workerKind:"hermes",nodeId:"node:three",selectionKey:"selection:three",model:"model-three",effort:"medium",
    provider:"provider:test",profile:"profile:test",maxLoops:0}],maxTotalLoops:2,maxDurationSeconds:3600} as const;

function signedRows(overrides:{unattended?:boolean;tamperStage?:boolean;currentOrdinal?:number|null;
  startedAt?:number|null;updatedAt?:number}={}){
  const template:any={id:"pipeline-template:test",project_id:"project:test",name:templateDefinition.name,
    description:templateDefinition.description,stages:templateDefinition.stages,max_stages:3,max_total_loops:2,
    may_advance_unattended:overrides.unattended??true,max_duration_seconds:3600,version:2,created_at:iso(),updated_at:iso()};
  const templateMaterial={id:template.id,tenantId:"tenant:test",projectId:template.project_id,name:template.name,
    description:template.description,stages:template.stages,maxStages:3,maxTotalLoops:2,
    mayAdvanceUnattended:template.may_advance_unattended,maxDurationSeconds:3600,version:2,createdAt:iso(),updatedAt:iso()};
  template.record_digest=sha256Digest(templateMaterial);template.auth_tag=hmacSha256Tag(key,{purpose:"pipeline-template/v1",record:templateMaterial});
  const startedAt=Object.prototype.hasOwnProperty.call(overrides,"startedAt")?overrides.startedAt:0;
  const updatedAt=overrides.updatedAt??0;
  const run:any={id:"pipeline-run:test",project_id:"project:test",request_id:"request:test",template_id:template.id,
    template_version:2,template_digest:template.record_digest,workflow_id:"workflow:test",title:"Run",state:"active",
    started_at:startedAt===null?null:iso(startedAt),updated_at:iso(updatedAt),completed_at:null,
    current_stage_ordinal:Object.prototype.hasOwnProperty.call(overrides,"currentOrdinal")?overrides.currentOrdinal:0,
    unattended:overrides.unattended??true,version:2};
  const runMaterial={id:run.id,tenantId:"tenant:test",projectId:run.project_id,requestId:run.request_id,templateId:run.template_id,
    templateVersion:2,templateDigest:run.template_digest,workflowId:run.workflow_id,title:run.title,state:run.state,
    startedAt:startedAt===null?null:iso(startedAt),updatedAt:iso(updatedAt),completedAt:null,
    currentStageOrdinal:run.current_stage_ordinal,unattended:run.unattended,version:2};
  run.record_digest=sha256Digest(runMaterial);run.auth_tag=hmacSha256Tag(key,{purpose:"pipeline-run/v1",record:runMaterial});
  const stages=templateDefinition.stages.map(stage=>{const row:any={project_id:"project:test",pipeline_run_id:run.id,
    stage_ordinal:stage.ordinal,stage_kind:stage.stageKind,role:stage.role,current_job_id:`job:source:${stage.ordinal}`,
    worker_id:stage.workerId,worker_kind:stage.workerKind,node_id:stage.nodeId,selection_key:stage.selectionKey,model:stage.model,
    effort:stage.effort,provider:"provider" in stage?stage.provider:null,profile:"profile" in stage?stage.profile:null,
    current_attempt_id:null,current_lease_id:null,state:"proposed",max_loops:stage.maxLoops,handoff_from_result_digest:null,
    allowed_paths:"allowedPaths" in stage?stage.allowedPaths:null,
    maximum_changed_files:"maximumChangedFiles" in stage?stage.maximumChangedFiles:null,
    maximum_changed_bytes:"maximumChangedBytes" in stage?stage.maximumChangedBytes:null,
    signoff_review_id:null,started_at:null,finished_at:null,version:1};
    const material={id:`${run.id}:stage:${stage.ordinal}`,tenantId:"tenant:test",projectId:"project:test",pipelineRunId:run.id,
      stageOrdinal:stage.ordinal,stageKind:stage.stageKind,role:stage.role,workerId:stage.workerId,workerKind:stage.workerKind,
      nodeId:stage.nodeId,selectionKey:stage.selectionKey,model:stage.model,effort:stage.effort,provider:row.provider,profile:row.profile,
      currentJobId:row.current_job_id,currentAttemptId:null,currentLeaseId:null,state:"proposed",maxLoops:stage.maxLoops,
      handoffFromResultDigest:null,allowedPaths:row.allowed_paths,maximumChangedFiles:row.maximum_changed_files,
      maximumChangedBytes:row.maximum_changed_bytes,signoffReviewId:null,startedAt:null,finishedAt:null,version:1};
    row.record_digest=sha256Digest(material);row.auth_tag=hmacSha256Tag(key,{purpose:"pipeline-stage-run/v1",record:material});return row;});
  if(overrides.tamperStage)stages[1]!.model="tampered";
  return{template,run,stages};
}
function job(id:string){const authority:any={projectId:"project:test",allowedExecutor:"worker:one",allowedOperations:["task.execute"],
  credentialRefs:[],filesystemRoots:["/synthetic"],networkPolicy:"none",allowedNetworkDestinations:[],effectPolicy:"none",
  maxRisk:"low",maxDurationSeconds:3600,maxConcurrentEffects:0,expiresAt:iso(3600000),digest:""};authority.digest=computeAuthorityDigest(authority);
  return{contractVersion:"control-room-domain/v1",kind:"job",id,tenantId:"tenant:test",workflowId:"workflow:test",
    projectId:"project:test",jobType:"task.proposal",specVersion:"1.0.0",inputDigest:digest("a"),state:"proposed",priority:50,
    requiredCapability:"code.change",dependsOnJobIds:[],authority,retryPolicy:{maxAttempts:1,backoffSeconds:0,
      retryableFailureCodes:[],retryAfterOrphan:false,ambiguousEffectPolicy:"attention"},version:0,createdAt:iso(),updatedAt:iso()};}

function fixture(overrides:{unattended?:boolean;tamperStage?:boolean;route?:string;currentOrdinal?:number|null;
  startedAt?:number|null;updatedAt?:number;
  states?: PipelineStageResolutionV1["state"][];
  disableDuringDispatch?:boolean;coordinatorDeadline?:number;advanceClockBeforePrecommit?:number;staleConsent?:boolean;
  driftAfterSweepSelection?:boolean}={}){
  const rows=signedRows(overrides),policy={id:"policy:test",project_id:"project:test",coordinator_identity_id:"agent:lead",
    coordinator_version:1,owner_identity_id:"identity:owner",state:"active",version:1,policy_digest:digest("p"),allowed_actions:["tasks.assign"],
    eligible_routes:["route:one","route:two","route:three"],risk_ceiling:"low",max_total_tasks:3,max_total_cost_microusd:1000,max_concurrent_tasks:2,
    valid_from:iso(-1000),valid_until:iso(60000)};const receipts=new Map<number,any>();let enabled=true,effects=0,chain=Promise.resolve();
  const consentMaterial={id:"transition:test",tenantId:"tenant:test",projectId:"project:test",pipelineRunId:"pipeline-run:test",
    pipelineTemplateId:rows.template.id,templateVersion:Number(rows.template.version),templateDigest:rows.template.record_digest,
    runVersion:Number(rows.run.version),runDigest:rows.run.record_digest,policyId:"policy:test",policyVersion:1,
    policyDigest:overrides.staleConsent?digest("z"):digest("p"),ownerIdentityId:"identity:owner",enabled:true,idempotencyKey:"pipeline-consent-test-0001",
    requestDigest:digest("q"),occurredAt:iso()};
  const consent={id:consentMaterial.id,project_id:consentMaterial.projectId,pipeline_run_id:consentMaterial.pipelineRunId,
    pipeline_template_id:consentMaterial.pipelineTemplateId,template_version:consentMaterial.templateVersion,
    template_digest:consentMaterial.templateDigest,run_version:consentMaterial.runVersion,run_digest:consentMaterial.runDigest,
    policy_id:consentMaterial.policyId,policy_version:1,policy_digest:consentMaterial.policyDigest,
    owner_identity_id:consentMaterial.ownerIdentityId,enabled:true,idempotency_key:consentMaterial.idempotencyKey,
    request_digest:consentMaterial.requestDigest,transition_digest:sha256Digest(consentMaterial),
    auth_tag:hmacSha256Tag(key,{purpose:"pipeline-unattended-transition/v1",record:consentMaterial}),occurred_at:iso()};
  let states=overrides.states??["eligible","terminal_failure","terminal_failure"],clock=at;
  const query:DatabaseSession["query"]=async<T>(sql:string,params:unknown[]=[]):Promise<QueryResult<T>>=>{
    if(sql.includes("FROM pipeline_runs r JOIN LATERAL")){const selected={...consent};if(overrides.driftAfterSweepSelection){
      const replacement={...consentMaterial,id:"transition:replacement"};Object.assign(consent,{id:replacement.id,
        transition_digest:sha256Digest(replacement),auth_tag:hmacSha256Tag(key,{purpose:"pipeline-unattended-transition/v1",record:replacement})});}
      return result([selected] as T[]);}
    if(sql.startsWith("SELECT project_id FROM pipeline_runs"))return result([{project_id:"project:test"}] as T[]);
    if(sql.includes("FROM pipeline_runs")&&sql.includes("FOR UPDATE"))return result([rows.run] as T[]);
    if(sql.includes("FROM pipeline_templates")&&sql.includes("FOR UPDATE"))return result([rows.template] as T[]);
    if(sql.includes("FROM pipeline_stage_runs")&&sql.includes("ORDER BY stage_ordinal FOR UPDATE"))return result(rows.stages as T[]);
    if(sql.includes("FROM pipeline_unattended_transitions")&&sql.includes("ORDER BY run_version"))return result([consent] as T[]);
    if(sql.startsWith("UPDATE pipeline_runs SET unattended_last_swept_at"))return result([] as T[]);
    if(sql.includes("FROM projects p"))return result([{lifecycle:"active"}] as T[]);
    if(sql.includes("FROM pipeline_advance_receipts")&&sql.includes("FOR SHARE"))return result((receipts.has(Number(params[2]))?[receipts.get(Number(params[2]))]:[]) as T[]);
    if(sql.includes("FROM control_jobs")){const id=String(params[2]),ordinal=Number(id.split(":").at(-1)),stage=rows.stages[ordinal]!;
      const value=job(id);value.authority.allowedExecutor=stage.worker_id;value.authority.digest=computeAuthorityDigest(value.authority);
      return result([{payload:value,project_id:"project:test",workflow_id:"workflow:test",pipeline_run_id:"pipeline-run:test",
        stage_kind:stage.stage_kind,stage_ordinal:ordinal}] as T[]);}
    if(sql.includes("FROM control_task_execution_plans")){const ordinal=Number(String(params[2]).split(":").at(-1));
      return result([{source_job_id:`job:source:${ordinal}`}] as T[]);}
    if(sql.includes("FROM control_project_delegation_policies"))return result([policy] as T[]);
    if(sql.startsWith("UPDATE pipeline_runs")&&sql.includes("SET current_stage_ordinal=")){
      rows.run.current_stage_ordinal=Number(params[0]);rows.run.updated_at=String(params[1]);rows.run.version=Number(params[2]);
      rows.run.record_digest=String(params[3]);rows.run.auth_tag=String(params[4]);
      return result([{version:rows.run.version,record_digest:rows.run.record_digest,auth_tag:rows.run.auth_tag}] as T[]);}
    if(sql.startsWith("UPDATE pipeline_runs")&&sql.includes("SET state='succeeded'")){
      rows.run.state="succeeded";rows.run.completed_at=String(params[0]);rows.run.current_stage_ordinal=null;
      rows.run.updated_at=String(params[0]);rows.run.version=Number(params[1]);rows.run.record_digest=String(params[2]);
      rows.run.auth_tag=String(params[3]);return result([{version:rows.run.version,record_digest:rows.run.record_digest,
        auth_tag:rows.run.auth_tag}] as T[]);}
    if(sql.startsWith("INSERT INTO pipeline_advance_receipts")){const receipt={id:params[0],project_id:params[2],pipeline_run_id:params[3],
      stage_ordinal:params[4],source_job_id:params[5],execution_job_id:params[6],attempt_id:params[7],queue_id:params[8],
      selection_digest:params[9],template_version:params[10],template_digest:params[11],run_version:params[12],run_digest:params[13],
      policy_id:params[14],policy_version:params[15],policy_digest:params[16],delegation_receipt_id:params[17],
      delegation_receipt_digest:params[18],delegation_task_units:params[19],delegation_cost_microusd:params[20],
      delegation_cost_evidence_digest:params[21],request_digest:params[22],receipt_digest:params[23],auth_tag:params[24],
      advanced_at:params[25]};
      receipts.set(Number(params[4]),receipt);
      return result([] as T[]);}
    if(sql.includes("SELECT event_digest,event_hash FROM audit_events"))return result([] as T[]);
    if(sql.includes("INSERT INTO control_audit_chain_heads")||sql.includes("INSERT INTO audit_events"))return result([] as T[]);
    if(sql.includes("SELECT head_hash,event_count FROM control_audit_chain_heads")&&sql.includes("FOR UPDATE"))
      return result([{head_hash:digest("0"),event_count:0}] as T[]);
    if(sql.includes("UPDATE control_audit_chain_heads"))return result([{event_hash:digest("b")}] as T[]);
    throw new Error(`unexpected SQL: ${sql}`);};
  const db:DatabaseClient={query,transaction:async work=>work({query}),transactionWithPreCommitCheck:async(work,check)=>{
    let release!:()=>void;const previous=chain;chain=new Promise<void>(resolve=>{release=resolve;});await previous;
    try{const value=await work({query});if(overrides.advanceClockBeforePrecommit!==undefined)clock=overrides.advanceClockBeforePrecommit;
      await check();return value;}finally{release();}}};
  const capability:PipelineAdvanceCapabilityV1={
    resolveStageInSession:async(_tx,input)=>({state:states[input.stageOrdinal]??"terminal_failure",
      executionJobId:`job:execution:${input.stageOrdinal}`,expectedInputDigest:digest("a")}),
    assertAcceptedPredecessorInSession:()=>{},assertSelectionCurrentInSession:()=>{},assertSelectionCurrent:()=>{},
    authorizeDelegationInSession:async(_tx,selection)=>({receiptId:"delegation:one",receiptDigest:digest("d"),policyId:"policy:test",
      policyVersion:1,policyDigest:digest("p"),coordinatorVersion:1,ownerIdentityId:"identity:owner",action:"tasks.assign",routeId:overrides.route??`route:${["one","two","three"][selection.stageOrdinal]}`,
      executorId:selection.workerId,taskUnits:0,committedCostMicroUsd:0,nextCost:{kind:"known",microUsd:10,evidenceDigest:digest("e")},
      concurrentTasks:0,validUntil:iso(60000)}),
    assignAndQueueInSession:async(_tx,_input,gate)=>{if(overrides.coordinatorDeadline!==undefined)
      gate.commitDeadline(overrides.coordinatorDeadline);if(overrides.disableDuringDispatch)enabled=false;await gate.assertCurrent();
      effects+=1;return{attemptId:"attempt:one",queueId:"queue:one",replayed:false};}};
  const service=new PipelineAdvanceServiceV1(db,{tenantId:"tenant:test",workspaceId:"workspace:test"},key,
    {unattendedEnabled:()=>enabled,capability},()=>clock);
  return{service,setStates(value:PipelineStageResolutionV1["state"][]){states=value;},get currentOrdinal(){return rows.run.current_stage_ordinal;},
    get runVersion(){return rows.run.version;},get effects(){return effects;},get receipts(){return receipts;}};
}

test("durable advance replays with a stable timestamp after a lost response or restart",async()=>{const f=fixture();
  const first=await f.service.advance("pipeline-run:test","policy:test");const replay=await f.service.advance("pipeline-run:test","policy:test");
  if(!first.startsWork||!replay.startsWork)assert.fail("expected queued stage receipts");
  assert.equal(first.advancedAt,replay.advancedAt);assert.equal(replay.replayed,true);assert.equal(f.effects,1);});
test("concurrent exact transitions create one delivery and one durable receipt",async()=>{const f=fixture();
  const values=await Promise.all([f.service.advance("pipeline-run:test","policy:test"),f.service.advance("pipeline-run:test","policy:test")]);
  assert.equal(f.effects,1);assert.equal(values.every(value=>value.startsWork),true);
  assert.deepEqual(values.flatMap(value=>value.startsWork?[value.replayed]:[]).sort(),[false,true]);});
test("changed policy content cannot replay a durable transition",async()=>{const f=fixture();await f.service.advance("pipeline-run:test","policy:test");
  await assert.rejects(f.service.advance("pipeline-run:test","policy:changed"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="unattended_not_authorized");});
test("template and run unattended consent are both required",async()=>{const f=fixture({unattended:false});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="unattended_not_authorized");assert.equal(f.effects,0);});
test("a stale authenticated owner consent refuses before assignment or queue effects",async()=>{const f=fixture({staleConsent:true});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="unattended_not_authorized");assert.equal(f.effects,0);});
test("advance cycle refuses a replaced owner transition selected before its transaction",async()=>{
  const f=fixture({driftAfterSweepSelection:true});const page=await f.service.advanceReady();
  assert.equal(page.checked,1);assert.equal(page.advanced.length,0);assert.equal(f.effects,0);});
test("bounded sweeps rotate past stuck and tampered rows to reach later healthy work",async()=>{
  const candidates=Array.from({length:10},(_,index)=>{const suffix=String(index).padStart(2,"0"),runId=`pipeline-run:${suffix}`;
    const material={id:`transition:${suffix}`,tenantId:"tenant:test",projectId:"project:test",pipelineRunId:runId,
      pipelineTemplateId:"pipeline-template:test",templateVersion:2,templateDigest:digest("t"),runVersion:2,
      runDigest:digest("r"),policyId:"policy:test",policyVersion:1,policyDigest:digest("p"),
      ownerIdentityId:"identity:owner",enabled:true,idempotencyKey:`pipeline-sweep-${suffix}`,
      requestDigest:digest("q"),occurredAt:iso()};
    return{id:material.id,project_id:material.projectId,pipeline_run_id:runId,pipeline_template_id:material.pipelineTemplateId,
      template_version:material.templateVersion,template_digest:material.templateDigest,run_version:material.runVersion,
      run_digest:material.runDigest,policy_id:material.policyId,policy_version:material.policyVersion,
      policy_digest:material.policyDigest,owner_identity_id:material.ownerIdentityId,enabled:true,
      idempotency_key:material.idempotencyKey,request_digest:material.requestDigest,
      transition_digest:sha256Digest(material),auth_tag:index===0?`hmac-sha256:${"0".repeat(64)}`:
        hmacSha256Tag(key,{purpose:"pipeline-unattended-transition/v1",record:material}),occurred_at:material.occurredAt};});
  const cursors=new Map<string,number>();let sweep=0;
  const query:DatabaseClient["query"]=async<T>(sql:string,params:unknown[]=[])=>{
    if(sql.includes("FROM pipeline_runs r JOIN LATERAL")){const limit=Number(params[1]);
      const selected=[...candidates].sort((left,right)=>{
        const a=cursors.get(left.pipeline_run_id),b=cursors.get(right.pipeline_run_id);
        if(a===undefined&&b!==undefined)return-1;if(a!==undefined&&b===undefined)return 1;
        return(a??0)-(b??0)||left.pipeline_run_id.localeCompare(right.pipeline_run_id);}).slice(0,limit);
      return result(selected as T[]);}
    if(sql.startsWith("UPDATE pipeline_runs SET unattended_last_swept_at")){cursors.set(String(params[1]),++sweep);return result([] as T[]);}
    throw new Error(`unexpected SQL: ${sql}`);};
  const db:DatabaseClient={query,transaction:async work=>work({query}),
    transactionWithPreCommitCheck:async(work,check)=>{const value=await work({query});await check();return value;}};
  const service=new PipelineAdvanceServiceV1(db,{tenantId:"tenant:test",workspaceId:"workspace:test"},key,
    {unattendedEnabled:()=>true,capability:{} as PipelineAdvanceCapabilityV1},()=>at+sweep);
  const controlled=service as unknown as {advance:(runId:string)=>Promise<any>};
  controlled.advance=async runId=>{if(runId!=="pipeline-run:08")throw new PipelineAdvanceErrorV1("stage_not_eligible");
    return{runId,stageOrdinal:0,jobId:"job:healthy",attemptId:"attempt:healthy",queueId:"queue:healthy",replayed:false,
      advancedAt:iso(),startsWork:true,grantsExecutionAuthority:false,claimsCancellation:false};};
  const first=await service.advanceReady(8);assert.equal(first.checked,8);assert.equal(first.advanced.length,0);
  const second=await service.advanceReady(8);assert.equal(second.checked,8);
  assert.deepEqual(second.advanced.map(receipt=>receipt.runId),["pipeline-run:08"]);
  assert.ok(cursors.has("pipeline-run:00"),"the tampered head row receives a cursor and cannot abort or pin the sweep");
});
test("every authenticated stage projection is verified before advance",async()=>{const f=fixture({tamperStage:true});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="pipeline_integrity_failed");assert.equal(f.effects,0);});
test("server-resolved route must match the exact policy route",async()=>{const f=fixture({route:"route:other"});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="policy_route_mismatch");assert.equal(f.effects,0);});
test("current stage ordinal cannot move backwards",async()=>{const f=fixture({currentOrdinal:1});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="advance_conflict");});
test("null or a successor leap refuses instead of selecting a later stage",async()=>{
  for(const [currentOrdinal,states] of [[null,["eligible"]],[0,["accepted","accepted","eligible"]]] as const){
    const f=fixture({currentOrdinal,states:[...states] as PipelineStageResolutionV1["state"][]});
    await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
      (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="advance_conflict");}
});
test("accepted current stage advances exactly one ordinal while in-flight lost response replays prior receipt",async()=>{
  const f=fixture();const first=await f.service.advance("pipeline-run:test","policy:test");
  const lost=await f.service.advance("pipeline-run:test","policy:test");
  if(!lost.startsWork)assert.fail("expected queued stage receipt");assert.equal(lost.replayed,true);
  f.setStates(["accepted","eligible","terminal_failure"]);
  const next=await f.service.advance("pipeline-run:test","policy:test");
  assert.equal(first.startsWork,true);assert.equal(next.startsWork,true);
  if(!first.startsWork||!next.startsWork)assert.fail("expected queued stage receipts");
  assert.equal(first.stageOrdinal,0);assert.equal(next.stageOrdinal,1);assert.equal(next.replayed,false);assert.equal(f.effects,2);
  assert.equal(f.currentOrdinal,1);assert.equal(f.runVersion,3);
  assert.equal(Number(f.receipts.get(1)?.run_version),3);
});
test("accepted final stage terminalizes the authenticated run without another queue effect",async()=>{
  const f=fixture({currentOrdinal:2,states:["accepted","accepted","accepted"]});
  const outcome=await f.service.advance("pipeline-run:test","policy:test");
  assert.equal(outcome.startsWork,false);assert.deepEqual(outcome,{runId:"pipeline-run:test",state:"succeeded",
    completedAt:iso(),startsWork:false,grantsExecutionAuthority:false,claimsCancellation:false});
  assert.equal(f.currentOrdinal,null);assert.equal(f.runVersion,3);assert.equal(f.effects,0);
});
test("live installation switch is checked at the delivery boundary",async()=>{const f=fixture({disableDuringDispatch:true});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="unattended_disabled");assert.equal(f.effects,0);});
test("active runs require a start anchor and mutable updates cannot extend the wall-clock deadline",async()=>{
  const missing=fixture({startedAt:null});
  await assert.rejects(missing.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="pipeline_integrity_failed");
  assert.equal(missing.effects,0);
  const expired=fixture({startedAt:-3600001,updatedAt:0});
  await assert.rejects(expired.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="deadline_reached");
  assert.equal(expired.effects,0);
});
test("the coordinator's stricter deadline is enforced by the outer precommit boundary",async()=>{
  const f=fixture({coordinatorDeadline:at+30000,advanceClockBeforePrecommit:at+30001});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="deadline_reached");
});

test("0099 owner transition authenticates and persists both unattended consents with exact replay",async t=>{
  const f=await taskFixture();t.after(()=>void f.db.close());
  const linear=new LinearPipelineServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},key,
    {assertCurrent:()=>true,isAcceptedResultCurrent:()=>false},()=>webNow);
  const saved=await linear.createTemplate(f.identity,f.project.projectId,templateDefinition);
  const run=await linear.instantiate(f.identity,f.project.projectId,{templateId:saved.templateId,title:"Authorized run"},
    "pipeline-unattended-run-0001");
  await f.db.query(`INSERT INTO control_project_delegation_policies(tenant_id,id,project_id,coordinator_identity_id,
    coordinator_version,state,version,policy_digest,owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,
    risk_ceiling,effect_ceiling,max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,
    created_at,updated_at) VALUES('tenant:web','policy:advance',$1,'identity:web',1,'active',1,$2,'identity:web',$2,
    '["tasks.assign"]','["route:one"]','low','none',3,1000,2,$3,$4,'{}',$3,$3)`,
  [f.project.projectId,digest("c"),new Date(webNow-1000).toISOString(),new Date(webNow+60000).toISOString()]);
  const service=new PipelineAdvanceServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},key,{},()=>webNow);
  const command={runId:run.runId,templateId:saved.templateId,policyId:"policy:advance",enabled:true,
    expectedRunVersion:1,expectedTemplateVersion:1};
  const first=await service.setUnattended(f.identity,f.project.projectId,command,"pipeline-unattended-enable-0001");
  const replay=await service.setUnattended(f.identity,f.project.projectId,command,"pipeline-unattended-enable-0001");
  assert.equal(first.replayed,false);assert.equal(replay.replayed,true);assert.equal(first.occurredAt,replay.occurredAt);
  const activated=(await f.db.query<{may_advance_unattended:boolean;unattended:boolean;state:string;started_at:string|Date|null}>(
    `SELECT t.may_advance_unattended,r.unattended,r.state,r.started_at FROM pipeline_templates t JOIN pipeline_runs r
    ON r.tenant_id=t.tenant_id AND r.template_id=t.id WHERE r.id=$1`,[run.runId])).rows[0]!;
  assert.deepEqual({...activated,started_at:activated.started_at?new Date(activated.started_at).toISOString():null},
    {may_advance_unattended:true,unattended:true,state:"active",started_at:new Date(webNow).toISOString()});
  assert.equal((await f.db.query<{count:number}>(`SELECT count(*)::int count FROM pipeline_unattended_transitions`)).rows[0]!.count,1);
  await assert.rejects(service.setUnattended(f.identity,f.project.projectId,{...command,enabled:false},
    "pipeline-unattended-enable-0001"),/conflict/u);
  await assert.rejects(f.db.query("UPDATE pipeline_runs SET started_at=NULL WHERE id=$1",[run.runId]),
    /pipeline_runs_active_started_at_check/u);
  // Simulate an authenticated legacy row created before 0099's NOT VALID
  // lifecycle constraint.  Owner consent must not re-sign this active/null-start
  // state or turn mutable updated_at into the run's deadline anchor.
  await f.db.exec("ALTER TABLE pipeline_runs DROP CONSTRAINT pipeline_runs_active_started_at_check");
  const legacy=(await f.db.query<any>(`SELECT id,project_id,request_id,template_id,template_version,template_digest,workflow_id,title,
    updated_at,completed_at,current_stage_ordinal,unattended,version FROM pipeline_runs WHERE id=$1`,[run.runId])).rows[0]!;
  const legacyMaterial={id:legacy.id,tenantId:"tenant:web",projectId:legacy.project_id,requestId:legacy.request_id,
    templateId:legacy.template_id,templateVersion:Number(legacy.template_version),templateDigest:legacy.template_digest,
    workflowId:legacy.workflow_id,title:legacy.title,state:"active",startedAt:null,updatedAt:new Date(legacy.updated_at).toISOString(),
    completedAt:null,currentStageOrdinal:legacy.current_stage_ordinal,unattended:legacy.unattended,version:Number(legacy.version)};
  await f.db.query("UPDATE pipeline_runs SET state='active',started_at=NULL,record_digest=$1,auth_tag=$2 WHERE id=$3",
    [sha256Digest(legacyMaterial),hmacSha256Tag(key,{purpose:"pipeline-run/v1",record:legacyMaterial}),run.runId]);
  await assert.rejects(service.setUnattended(f.identity,f.project.projectId,{...command,enabled:false,
    expectedRunVersion:2,expectedTemplateVersion:2},"pipeline-unattended-disable-legacy-0001"),
  (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="pipeline_integrity_failed");
  await f.db.exec("ALTER TABLE pipeline_unattended_transitions DISABLE TRIGGER pipeline_unattended_transitions_immutable");
  await f.db.query("UPDATE pipeline_unattended_transitions SET auth_tag=$1",["hmac-sha256:"+"0".repeat(64)]);
  await f.db.exec("ALTER TABLE pipeline_unattended_transitions ENABLE TRIGGER pipeline_unattended_transitions_immutable");
  await assert.rejects(service.setUnattended(f.identity,f.project.projectId,command,"pipeline-unattended-enable-0001"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="pipeline_integrity_failed");
  const down=await readFile("db/down/0099_pipeline_unattended_advance.sql","utf8");
  await assert.rejects(f.db.exec(down),/down migration refused/u);await f.db.exec("ROLLBACK");
});

test("shared template activation is monotonic while sibling run consent remains independent",async t=>{
  const f=await taskFixture();t.after(()=>void f.db.close());
  const linear=new LinearPipelineServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},key,
    {assertCurrent:()=>true,isAcceptedResultCurrent:()=>false},()=>webNow);
  const saved=await linear.createTemplate(f.identity,f.project.projectId,templateDefinition);
  const first=await linear.instantiate(f.identity,f.project.projectId,{templateId:saved.templateId,title:"First run"},
    "pipeline-unattended-run-0002");
  const second=await linear.instantiate(f.identity,f.project.projectId,{templateId:saved.templateId,title:"Second run"},
    "pipeline-unattended-run-0003");
  await f.db.query(`INSERT INTO control_project_delegation_policies(tenant_id,id,project_id,coordinator_identity_id,
    coordinator_version,state,version,policy_digest,owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,
    risk_ceiling,effect_ceiling,max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,
    created_at,updated_at) VALUES('tenant:web','policy:siblings',$1,'identity:web',1,'active',1,$2,'identity:web',$2,
    '["tasks.assign"]','["route:one"]','low','none',3,1000,2,$3,$4,'{}',$3,$3)`,
  [f.project.projectId,digest("b"),new Date(webNow-1000).toISOString(),new Date(webNow+60000).toISOString()]);
  const service=new PipelineAdvanceServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},key,{},()=>webNow);
  await service.setUnattended(f.identity,f.project.projectId,{runId:first.runId,templateId:saved.templateId,
    policyId:"policy:siblings",enabled:true,expectedRunVersion:1,expectedTemplateVersion:1},"pipeline-sibling-enable-0001");
  const historical=await linear.view(f.identity,f.project.projectId,second.runId);
  const before=await linear.list(f.identity,f.project.projectId);
  assert.equal(historical.runId,second.runId);assert.equal(historical.startsWork,false);
  assert.deepEqual(new Set(before.runs.map(run=>run.runId)),new Set([first.runId,second.runId]));
  const unavailable:PipelineAdvanceCapabilityV1={resolveStageInSession:async()=>{throw new Error("must not resolve");},
    assertAcceptedPredecessorInSession:()=>{throw new Error("must not check predecessor");},
    assertSelectionCurrentInSession:()=>{throw new Error("must not check selection");},
    assertSelectionCurrent:()=>{throw new Error("must not check selection");},
    authorizeDelegationInSession:async()=>{throw new Error("must not authorize");},
    assignAndQueueInSession:async()=>{throw new Error("must not assign");}};
  const advance=new PipelineAdvanceServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},key,
    {unattendedEnabled:()=>true,capability:unavailable},()=>webNow);
  await assert.rejects(advance.advance(second.runId,"policy:siblings"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="unattended_not_authorized");
  await service.setUnattended(f.identity,f.project.projectId,{runId:second.runId,templateId:saved.templateId,
    policyId:"policy:siblings",enabled:true,expectedRunVersion:1,expectedTemplateVersion:2},"pipeline-sibling-enable-0002");
  assert.equal((await linear.view(f.identity,f.project.projectId,first.runId)).runId,first.runId);
  assert.equal((await linear.view(f.identity,f.project.projectId,second.runId)).runId,second.runId);
  assert.deepEqual(new Set((await linear.list(f.identity,f.project.projectId)).runs.map(run=>run.runId)),
    new Set([first.runId,second.runId]));
  await service.setUnattended(f.identity,f.project.projectId,{runId:first.runId,templateId:saved.templateId,
    policyId:"policy:siblings",enabled:false,expectedRunVersion:2,expectedTemplateVersion:2},"pipeline-sibling-disable-0001");
  const rows=(await f.db.query<{id:string;template_version:number;unattended:boolean}>(`SELECT id,template_version,unattended
    FROM pipeline_runs WHERE id IN($1,$2) ORDER BY id`,[first.runId,second.runId])).rows;
  const byId=new Map(rows.map(row=>[row.id,row]));
  assert.deepEqual({templateVersion:Number(byId.get(first.runId)?.template_version),unattended:byId.get(first.runId)?.unattended},
    {templateVersion:2,unattended:false});
  assert.deepEqual({templateVersion:Number(byId.get(second.runId)?.template_version),unattended:byId.get(second.runId)?.unattended},
    {templateVersion:2,unattended:true});
  assert.deepEqual((await f.db.query<{version:number;may_advance_unattended:boolean}>(`SELECT version,may_advance_unattended
    FROM pipeline_templates WHERE id=$1`,[saved.templateId])).rows[0],{version:2,may_advance_unattended:true});
});

test("0099 owns append-only records, least-privilege grants, and a guarded down path",async()=>{
  const [up,down,grants,web,coordinator,preflight]=await Promise.all([readFile("db/migrations/0099_pipeline_unattended_advance.sql","utf8"),
    readFile("db/down/0099_pipeline_unattended_advance.sql","utf8"),readFile("db/roles/production_table_grants.sql","utf8"),
    readFile("db/roles/private_web_roles.sql","utf8"),readFile("db/roles/task_coordinator_roles.sql","utf8"),
    readFile("src/web/v1/private-database-preflight.ts","utf8")]);
  for(const table of ["pipeline_unattended_transitions","pipeline_advance_receipts"]){
    assert.match(up,new RegExp(`CREATE TABLE ${table}`));assert.match(up,new RegExp(`REVOKE ALL ON[\\s\\S]*${table}`));
    assert.match(grants,new RegExp(table));assert.match(down,new RegExp(`EXISTS \\(SELECT 1 FROM ${table}\\)`));}
  assert.match(web,/GRANT INSERT ON pipeline_unattended_transitions TO control_room_private_web/u);
  assert.match(web,/GRANT UPDATE \(may_advance_unattended, version, updated_at, record_digest, auth_tag\)[\s\S]*ON pipeline_templates/u);
  assert.match(web,/GRANT UPDATE \(unattended, state, started_at, updated_at, version, template_version, template_digest,[\s\S]*ON pipeline_runs/u);
  assert.match(coordinator,/GRANT INSERT ON pipeline_advance_receipts TO control_room_task_coordinator/u);
  assert.match(coordinator,/GRANT UPDATE \(state, completed_at, current_stage_ordinal, updated_at, version, record_digest, auth_tag, unattended_last_swept_at\)[\s\S]*ON pipeline_runs/u);
  assert.match(preflight,/privateWebReadTables[\s\S]*pipeline_unattended_transitions/u);
  assert.match(preflight,/inserts\.add\("pipeline_unattended_transitions"\)/u);
  assert.match(preflight,/pipeline_templates: \["may_advance_unattended", "version", "updated_at", "record_digest", "auth_tag"\]/u);
  assert.match(preflight,/pipeline_runs: \["unattended", "state", "started_at", "updated_at", "version", "template_version", "template_digest"/u);
  assert.match(preflight,/coordinatorReads\.push\([\s\S]*pipeline_advance_receipts/u);
  assert.match(preflight,/coordinatorInserts\.add\("pipeline_advance_receipts"\)/u);
  assert.match(preflight,/pipeline_runs: \["state", "completed_at", "current_stage_ordinal",[\s\S]*"unattended_last_swept_at"\]/u);
  assert.match(up,/BEFORE UPDATE OR DELETE/u);assert.match(up,/BEFORE TRUNCATE/u);
  assert.match(up,/ADD COLUMN unattended_last_swept_at timestamptz/u);
  assert.match(up,/pipeline_runs_unattended_sweep_cursor[\s\S]*unattended_last_swept_at ASC NULLS FIRST/u);
  assert.match(up,/pipeline_runs_active_started_at_check[\s\S]*state <> 'active'[\s\S]*started_at IS NOT NULL[\s\S]*NOT VALID/u);
  assert.match(down,/REVOKE UPDATE \(may_advance_unattended, version, updated_at, record_digest, auth_tag\)[\s\S]*pipeline_templates FROM control_room_private_web/u);
  assert.match(down,/REVOKE UPDATE \(unattended, state, started_at, updated_at, version, template_version, template_digest,[\s\S]*pipeline_runs FROM control_room_private_web/u);
  assert.match(down,/REVOKE UPDATE \(state, completed_at, current_stage_ordinal, updated_at, version, record_digest, auth_tag, unattended_last_swept_at\)[\s\S]*pipeline_runs FROM control_room_task_coordinator/u);
  assert.match(down,/may_advance_unattended/u);assert.match(down,/unattended/u);
  assert.match(down,/DROP COLUMN unattended_last_swept_at/u);
  assert.match(down,/DROP CONSTRAINT pipeline_runs_active_started_at_check/u);
});

test("production adapter reserves through ordinary assignment before the existing native delivery queue",async()=>{
  const calls:string[]=[],tx={query:async<T>()=>result([] as T[])};let current=0,deadline=Infinity,queuedDeadline=Infinity;
  const assignment:any={assignScheduledInSession:async(_tx:DatabaseSession,_input:unknown,authority:{assertCurrent:()=>void|Promise<void>;
    commitDeadline:(value:number)=>void})=>{calls.push("assign");await authority.assertCurrent();authority.commitDeadline(at+30000);
    return{receipt:{attemptId:"attempt:one",leaseId:"lease:one",leaseEpoch:1},replayed:false};}};
  const supporting:any={resolveStageInSession:async()=>({state:"eligible",executionJobId:"job:execution:0",expectedInputDigest:digest("a")}),
    assertAcceptedPredecessorInSession:()=>{},assertSelectionCurrentInSession:()=>{},assertSelectionCurrent:()=>{},
    authorizeDelegationInSession:async()=>({})};
  const queue={enqueueAssignedInSession:async(_tx:DatabaseSession,input:any,authority:any)=>{calls.push("queue");
    assert.equal(input.attemptId,"attempt:one");queuedDeadline=input.commitDeadline;
    await authority.assertCurrent();return{queueId:"queue:one",replayed:false};}};
  const capability=new ProductionPipelineAdvanceCapabilityV1(supporting,assignment,queue);
  const selection:any={tenantId:"tenant:test",projectId:"project:test",runId:"pipeline-run:test",stageOrdinal:0,
    sourceJobId:"job:source:0",executionJobId:"job:execution:0",workerId:"worker:one",workerKind:"codex",nodeId:"node:one",
    selectionKey:"selection:one",model:"model-one",effort:"high",provider:null,profile:null};
  const saved=await capability.assignAndQueueInSession(tx,{...selection,expectedInputDigest:digest("a"),policyId:"policy:test",
    approvingOwnerIdentityId:"identity:owner",
    idempotencyKey:"pipeline-advance:test",commitDeadline:at+60000},{actorId:"service:pipeline-advance:v1",
    assertCurrent:()=>{current+=1;},commitDeadline:value=>{deadline=value;}});
  assert.deepEqual(calls,["assign","queue"]);assert.equal(saved.queueId,"queue:one");assert.ok(current>=3);
  assert.equal(deadline,at+30000);assert.equal(queuedDeadline,at+30000);
});

test("production authority derives policy usage and cost from canonical records and refuses unknown cost",async()=>{
  const selection:any={tenantId:"tenant:test",projectId:"project:test",runId:"pipeline-run:test",stageOrdinal:0,
    sourceJobId:"job:source:0",executionJobId:"job:execution:0",workerId:"worker:one",workerKind:"hermes",nodeId:"route:one",
    selectionKey:"selection:one",model:"model-one",effort:"high",provider:"provider:test",profile:"profile:test"};
  const query:DatabaseSession["query"]=async<T>(sql:string)=>{
    if(sql.includes("FROM control_project_delegation_policies"))return result([{id:"policy:test",version:2,
      policy_digest:digest("p"),coordinator_version:3,coordinator_identity_id:"agent:lead",owner_identity_id:"identity:owner",
      state:"active",valid_from:iso(-1000),valid_until:iso(60000),allowed_actions:["tasks.assign"],eligible_routes:["route:one"]}] as T[]);
    if(sql.includes("FROM control_project_coordinator_heads"))return result([{version:3,state:"active",coordinator_identity_id:"agent:lead"}] as T[]);
    if(sql.includes("FROM control_identities i"))return result([{present:true}] as T[]);
    if(sql.includes("SELECT required_capability FROM control_jobs"))return result([{required_capability:"code.review"}] as T[]);
    if(sql.includes("SELECT\n      (SELECT COALESCE"))return result([{tasks:"1",cost:"25",concurrent:"1"}] as T[]);
    throw new Error(`unexpected SQL: ${sql}`);};
  const tx={query},current={assertCurrent:()=>true},accepted={isAcceptedResultCurrent:async()=>true,
    acceptedResultProof:async()=>null};
  const authority=new ProductionPipelineAdvanceAuthorityV1({tenantId:"tenant:test",workspaceId:"workspace:test"},current,
    accepted,{currentCost:()=>({kind:"known",admittedCostMicroUsd:10,evidenceDigest:digest("e")})},()=>at);
  const receipt=await authority.authorizeDelegationInSession(tx,selection,"policy:test");
  assert.deepEqual({taskUnits:receipt.taskUnits,cost:receipt.committedCostMicroUsd,next:receipt.nextCost,concurrent:receipt.concurrentTasks},
    {taskUnits:1,cost:25,next:{kind:"known",microUsd:10,evidenceDigest:digest("e")},concurrent:1});
  const unknown=new ProductionPipelineAdvanceAuthorityV1({tenantId:"tenant:test",workspaceId:"workspace:test"},current,
    accepted,{currentCost:()=>({kind:"unknown"})},()=>at);
  await assert.rejects(unknown.authorizeDelegationInSession(tx,selection,"policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="policy_cost_unknown");
});

test("installed advance cycle is default-off, non-overlapping, and drains before close",async()=>{
  let scheduled:()=>void=()=>{},cleared=0,enabled=false,calls=0,release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const cycle=createPipelineAdvanceCycleV1({enabled:()=>enabled,intervalMs:1000,sweep:async()=>{calls++;await blocked;}},{
    schedule:run=>{scheduled=run;return"timer";},clear:handle=>{assert.equal(handle,"timer");cleared++;}});
  scheduled();assert.equal(calls,0);enabled=true;scheduled();scheduled();assert.equal(calls,1);
  let closed=false;const closing=cycle.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  scheduled();assert.equal(calls,1);release();await closing;assert.equal(closed,true);assert.equal(cleared,1);
});

test("history filters before its bound and maps the complete explicit lifecycle vocabulary",async()=>{
  const partition="month:2026-09",genesis=digest("0"),specs=[
    ...Array.from({length:12},(_,index)=>[`audit:unknown:${index}`,"service:other","unrelated.action","job","job:execution:0"] as const),
    ["audit:batch","agent:proposer","work_batches.propose","work_batch","batch:one"],
    ["audit:batch-revise","identity:owner","work_batches.revise","work_batch","batch:one"],
    ["audit:approval","identity:owner","work_batches.approved","work_batch","batch:one"],
    ["audit:reject","identity:owner","work_batches.rejected","work_batch","batch:one"],
    ["audit:partial","identity:owner","work_batches.partially_approved","work_batch","batch:one"],
    ["audit:revision","identity:owner","tasks.revisions.plan","job","job:execution:0"],
    ["audit:assign","service:assignment","tasks.assign","job","job:execution:0"],
    ["audit:expire","service:assignment","tasks.assignment.expire","job","job:execution:0"],
    ["audit:prepare","identity:owner","native.delivery.prepared","job","job:execution:0"],
    ["audit:native-stage","identity:owner","native.delivery.staged","job","job:execution:0"],
    ["audit:native-transmit","identity:owner","native.delivery.transmission_requested","job","job:execution:0"],
    ["audit:native-receipt","worker:one","native.delivery.receipt_recorded","attempt","attempt:one"],
    ["audit:recover","identity:owner","native.queue.unsent_recovered","job","job:execution:0"],
    ["audit:codex-stage","identity:owner","codex.delivery.staged","job","job:execution:0"],
    ["audit:codex-transmit","identity:owner","codex.delivery.transmission_requested","job","job:execution:0"],
    ["audit:codex-receipt","worker:one","codex.delivery.receipt_recorded","attempt","attempt:one"],
    ["audit:capacity","service:capacity","task.native.capacity_released","job","job:execution:0"],
    ["audit:received","worker:one","task.result.received","artifact","artifact:one"],
    ["audit:result","worker:one","task.result.submitted_for_review","artifact","artifact:one"],
    ["audit:review","agent:checker","tasks.reviews.record","job","job:execution:0"],
    ["audit:completed","service:completion","task.native.completed","job","job:execution:0"],
    ["audit:advanced","service:pipeline","pipelines.stage.advanced","pipeline_run","pipeline-run:test"],
  ] as const;let previous=genesis;
  const stored=specs.map((spec,index)=>{const [id,actorId,action,targetType,targetId]=spec,occurredAt=iso(index),safeMetadata={};
    const material={id,tenantId:"tenant:test",workspaceId:"workspace:test",projectId:"project:test",actorId,
      actorType:actorId.startsWith("identity")?"human":actorId.startsWith("agent")?"agent":actorId.startsWith("worker")?"worker":"service",
      action,targetType,targetId,correlationId:null,idempotencyKey:null,safeMetadata,occurredAt};const event_digest=sha256Digest(material),
      event_hash=sha256Digest({chainVersion:1,partition,sequence:index+1,previousHash:previous,eventDigest:event_digest});
    const row={...material,chain_sequence:index+1,event_digest,prev_hash:previous,event_hash};previous=event_hash;return row;});
  const query:DatabaseSession["query"]=async<T>(sql:string,params:unknown[]=[])=>{if(sql.startsWith("SELECT id FROM pipeline_runs"))return result([{id:"pipeline-run:test"}] as T[]);
    if(sql.includes("WITH RECURSIVE source_jobs AS")){assert.match(sql,/e\.action=ANY\(\$5::text\[\]\)/u);
      const actions=params[4] as string[],bound=Number(params[3]);return result(stored.filter(row=>actions.includes(row.action)).slice(0,bound).map(row=>({id:row.id,actor_id:row.actorId,actor_type:row.actorType,
      action:row.action,target_type:row.targetType,target_id:row.targetId,safe_metadata:row.safeMetadata,occurred_at:row.occurredAt,
      chain_partition:partition,chain_sequence:row.chain_sequence,event_hash:row.event_hash})) as T[]);}
    if(sql.includes("tenant_id as \"tenantId\""))return result(stored as T[]);
    if(sql.includes("SELECT head_hash,event_count FROM control_audit_chain_heads"))return result([{head_hash:previous,event_count:stored.length}] as T[]);
    throw new Error(`unexpected SQL: ${sql}`);};
  const db:DatabaseClient={query,transaction:async work=>work({query}),transactionWithPreCommitCheck:async(work,check)=>{const value=await work({query});await check();return value;}};
  const service=new PipelineAdvanceServiceV1(db,{tenantId:"tenant:test",workspaceId:"workspace:test"},key,{},()=>at);
  const bounded=await service.history("project:test","pipeline-run:test",6);
  assert.equal(bounded.chainVerified,true);assert.equal(bounded.truncated,true);assert.deepEqual(bounded.events.map(event=>event.kind),
    ["proposed","revised","approved","rejected","partially_approved","revision_planned"]);
  const complete=await service.history("project:test","pipeline-run:test",30);
  assert.equal(complete.truncated,false);assert.deepEqual(complete.events.map(event=>event.kind),
    ["proposed","revised","approved","rejected","partially_approved","revision_planned","ran","assignment_expired",
      "delivery_prepared","delivery_staged","transmission_requested","delivery_received","queue_recovered","delivery_staged",
      "transmission_requested","delivery_received","capacity_released","received","resulted","checked","completed","advanced"]);
});
