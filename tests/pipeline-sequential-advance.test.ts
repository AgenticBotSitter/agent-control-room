import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { DatabaseClient, DatabaseSession, QueryResult } from "../src/persistence/database";
import { LinearPipelineServiceV1, PipelineAdvanceErrorV1, PipelineAdvanceServiceV1, ProductionPipelineAdvanceAuthorityV1,
  readPipelineHistoryInSessionV1,
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
/** The three CHECK constraints `pipeline_stage_loop_counts` enforces, restated
 * here so the fake table can be held to exactly what the real one is. A row
 * that breaks one of these could never be written to the real table, so a fake
 * that accepts it would let a regression pass. */
const floors=(row:{loop_index:number|string;max_loops:number|string;max_total_loops:number|string;
  run_total_loops:number|string})=>{const loop=Number(row.loop_index),max=Number(row.max_loops),
  totalMax=Number(row.max_total_loops),total=Number(row.run_total_loops);
  return loop<=max&&total<=totalMax&&total>=loop+1;};
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
  startedAt?:number|null;updatedAt?:number;maxTotalLoops?:number}={}){
  const template:any={id:"pipeline-template:test",project_id:"project:test",name:templateDefinition.name,
    description:templateDefinition.description,stages:templateDefinition.stages,max_stages:3,
    max_total_loops:overrides.maxTotalLoops??2,
    may_advance_unattended:overrides.unattended??true,max_duration_seconds:3600,version:2,created_at:iso(),updated_at:iso()};
  const templateMaterial={id:template.id,tenantId:"tenant:test",projectId:template.project_id,name:template.name,
    description:template.description,stages:template.stages,maxStages:3,maxTotalLoops:template.max_total_loops,
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
  run.template_digest=template.record_digest;
  runMaterial.templateDigest=template.record_digest;
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
/** The stage ordinal a pipeline job id names. A pipeline job id is
 * `job:<source|reentry>:<ordinal>[:<seq>]` for the stage's own job -- a fix
 * round mints a new one -- or `job:execution:<ordinal>` for the execution job
 * the planner derives from it. The stage ordinal is the number after the
 * first kind segment, so the number after the LAST segment only works for the
 * execution job; that asymmetry is the whole of review finding B1. */
function ordinalOfJobId(id:string){const segments=id.split(":");
  const kind=["source","reentry"].includes(segments[1]!)?segments[1]!:"execution";
  return Number(segments[segments.indexOf(kind)+1]);}
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
  tamperConsent?:boolean;usage?:{taskUnits?:number;concurrentTasks?:number;committedCostMicroUsd?:number};
  driftAfterSweepSelection?:boolean;
  allowance?:{runs_per_hour:number;runs_per_agent_per_day:number;machine_max_agent_processes:number;
    machine_max_db_clusters:number;dollar_cap_microusd:number|null};
  tamperAllowance?:boolean;noAllowance?:boolean;dbClusters?:number|null;clusterObservedAt?:number;
  activeProcesses?:number;spentMicroUsd?:number;agentRunsToday?:number;runsThisHour?:number;
  nextCostKind?:"known"|"unknown";maxTotalLoops?:number;priorLoops?:Array<{stageOrdinal:number;workerId?:string}>;
  attentions?:any[]}={}){
  const rows=signedRows(overrides),policy={id:"policy:test",project_id:"project:test",coordinator_identity_id:"agent:lead",
    coordinator_version:1,owner_identity_id:"identity:owner",state:"active",version:1,policy_digest:digest("p"),allowed_actions:["tasks.assign"],
    eligible_routes:["route:one","route:two","route:three"],risk_ceiling:"low",max_total_tasks:3,max_total_cost_microusd:1000,max_concurrent_tasks:2,
    valid_from:iso(-1000),valid_until:iso(60000)};
  // The one installation allowance record: owner-set limits, a truthful cluster
  // observation, and the counted loops this fixture's transactions appended.
  const limits=overrides.allowance??{runs_per_hour:6,runs_per_agent_per_day:12,machine_max_agent_processes:12,
    machine_max_db_clusters:6,dollar_cap_microusd:null};
  const allowanceMaterial={schema:"control-room.pipeline-installation-allowance/v1",tenantId:"tenant:test",
    workspaceId:"workspace:test",runsPerHour:limits.runs_per_hour,runsPerAgentPerDay:limits.runs_per_agent_per_day,
    machineMaxAgentProcesses:limits.machine_max_agent_processes,machineMaxDbClusters:limits.machine_max_db_clusters,
    dollarCapMicroUsd:limits.dollar_cap_microusd,ownerIdentityId:"identity:owner",version:1,updatedAt:iso()};
  const allowanceRow={runs_per_hour:limits.runs_per_hour,runs_per_agent_per_day:limits.runs_per_agent_per_day,
    machine_max_agent_processes:limits.machine_max_agent_processes,machine_max_db_clusters:limits.machine_max_db_clusters,
    dollar_cap_microusd:limits.dollar_cap_microusd,version:1,owner_identity_id:"identity:owner",updated_at:iso(),
    record_digest:overrides.tamperAllowance?digest("x"):sha256Digest(allowanceMaterial),
    auth_tag:overrides.tamperAllowance?`hmac-sha256:${"0".repeat(64)}`
      :hmacSha256Tag(key,{purpose:"pipeline-installation-allowance/v1",record:allowanceMaterial})};
  const clusters=overrides.dbClusters===undefined?0:overrides.dbClusters;
  const receipts=new Map<string,any>(),loops:any[]=[];
  // The receipt chain is the loop count, as it is in production: one durable
  // receipt per fix round, and nothing before the first one. A stage therefore
  // starts with NO receipts (its first attempt is round 0), and every re-entry
  // adds exactly one.
  const loopRounds:any[]=[];
  let enabled=true,effects=0,chain=Promise.resolve();
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
    auth_tag:overrides.tamperConsent?`hmac-sha256:${"0".repeat(64)}`
      :hmacSha256Tag(key,{purpose:"pipeline-unattended-transition/v1",record:consentMaterial}),occurred_at:iso()};
  let states=overrides.states??["eligible","terminal_failure","terminal_failure"],clock=at;
  const query:DatabaseSession["query"]=async<T>(sql:string,params:unknown[]=[]):Promise<QueryResult<T>>=>{
    if(sql.includes("FROM pipeline_runs r JOIN LATERAL")){const selected={...consent};if(overrides.driftAfterSweepSelection){
      const replacement={...consentMaterial,id:"transition:replacement"};Object.assign(consent,{id:replacement.id,
        transition_digest:sha256Digest(replacement),auth_tag:hmacSha256Tag(key,{purpose:"pipeline-unattended-transition/v1",record:replacement})});}
      return result([selected] as T[]);}
    // The loop pre-check's own reads, matched before the broad run rules below.
    if(sql.includes("r.state='active'")&&sql.includes("pipeline_unattended_transitions"))
      return result([{eligible:true}] as T[]);
    if(sql.includes("FROM pipeline_runs r JOIN pipeline_templates t")){
      const ordinal=overrides.currentOrdinal===undefined?0:Number(overrides.currentOrdinal);
      const stage=rows.stages[ordinal]!;
      return result([{stage_ordinal:ordinal,worker_id:stage.worker_id,max_loops:stage.max_loops,
        current_job_id:stage.current_job_id,stage_kind:stage.stage_kind,
        max_total_loops:rows.template.max_total_loops,run_version:rows.run.version,
        run_digest:rows.run.record_digest}] as unknown as T[]);}
    if(sql.startsWith("SELECT project_id FROM pipeline_runs"))return result([{project_id:"project:test"}] as T[]);
    if(sql.includes("FROM pipeline_runs")&&sql.includes("FOR UPDATE"))return result([rows.run] as T[]);
    if(sql.includes("FROM pipeline_templates"))return result([rows.template] as T[]);
    if(sql.includes("FROM pipeline_stage_runs")&&sql.includes("ORDER BY stage_ordinal"))return result(rows.stages as T[]);
    if(sql.includes("FROM pipeline_unattended_transitions")&&sql.includes("ORDER BY run_version"))return result([consent] as T[]);
    if(sql.startsWith("UPDATE pipeline_runs SET unattended_last_swept_at"))return result([] as T[]);
    if(sql.includes("FROM projects p"))return result([{lifecycle:"active"}] as T[]);
    if(sql.includes("active_agent_processes"))return result([{runs_this_hour:String(overrides.runsThisHour??loops.length),
      agent_runs_today:String(overrides.agentRunsToday??0),
      active_agent_processes:String(overrides.activeProcesses??0),spent_microusd:String(overrides.spentMicroUsd??0)}] as T[]);
    // The receipt reads, most specific first: they share a table, so the order
    // is what tells them apart. `#stageRound`'s replay read names
    // `source_job_id`, and the count read is a COUNT -- both would otherwise be
    // swallowed by the per-stage/per-round lookup below.
    if(sql.includes("SELECT id FROM pipeline_advance_receipts"))return result([] as T[]);
    // A REPLAY is resolved by the round that job's own receipt carries, so a
    // lost response replays rather than opening the next fix round.
    if(sql.includes("SELECT loop_index FROM pipeline_advance_receipts")&&sql.includes("AND source_job_id=$4")){
      const prior=loopRounds.find(row=>Number(row.stage_ordinal)===Number(params[2])
        &&row.source_job_id===String(params[3]));
      return result((prior?[{loop_index:prior.loop_index}]:[]) as T[]);}
    // The round a stage is on, as a count of that stage's own receipts.
    if(sql.includes("COUNT(*)::text count FROM pipeline_advance_receipts")){
      const ordinal=Number(params[2]);
      return result([{count:String(loopRounds.filter(row=>Number(row.stage_ordinal)===ordinal).length)}] as T[]);}
    // The fix rounds that already exist, as the receipt rows the service reads.
    // `#claimLoopRound` names only the ordinal (it needs the run's whole count)
    // and `#loopRounds` names the ordinal, the round and the source job, so both
    // shapes are answered from the same list.
    if(sql.includes("SELECT stage_ordinal,loop_index,source_job_id FROM pipeline_advance_receipts")
      ||(/SELECT stage_ordinal\s+FROM pipeline_advance_receipts/.test(sql)
        &&!sql.includes("FROM pipeline_advance_receipts r")))
      return result(loopRounds as T[]);
    if(sql.includes("FROM pipeline_advance_receipts")&&sql.includes("AND stage_ordinal=$3")){
      const key=`${Number(params[2])}:${Number(params[3])}`;
      return result((receipts.has(key)?[receipts.get(key)]:[]) as T[]);}
    if(sql.includes("FROM pipeline_stage_loop_counts"))return result(loops as T[]);
    if(sql.includes("FROM pipeline_machine_capacity_observations"))
      return result((clusters===null?[]:[{db_clusters:clusters,observed_at:iso(overrides.clusterObservedAt??0)}]) as T[]);
    if(sql.includes("FROM pipeline_installation_allowances"))
      return result((overrides.noAllowance?[]:[allowanceRow]) as T[]);
    if(sql.includes("FROM pipeline_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE"))return result([] as T[]);
    if(sql.startsWith("INSERT INTO control_action_inbox")){
      const item=JSON.parse(String(params[5]));
      const attn=overrides.attentions??[];
      // A second item under one id would violate the primary key, so the service
      // must never attempt it: the fixture fails loudly if it does.
      if (attn.some(existing=>existing.id===item.id))
        throw new Error(`duplicate attention item: ${item.id}`);
      attn.push(item);return result([] as T[]);}
    if(sql.includes("FROM control_action_inbox")){
      const id=String(params[1]);
      const found=(overrides.attentions??[]).find(item=>item.id===id);
      return result((found?[{payload:found}]:[]) as T[]);}
    if(sql.includes("SELECT id FROM pipeline_advance_receipts"))return result([] as T[]);
    if(sql.startsWith("INSERT INTO pipeline_stage_loop_counts")){
      // Column order: id,tenant,project,run,stage,worker,loop_index,max_loops,
      // max_total_loops,run_total_loops,reason_code,receipt_id,receipt_digest,
      // request_digest,auth_tag,recorded_at.
      const material={schema:"control-room.pipeline-stage-loop-count/v1",tenantId:"tenant:test",projectId:"project:test",
        pipelineRunId:"pipeline-run:test",stageOrdinal:Number(params[4]),workerId:String(params[5]),
        loopIndex:Number(params[6]),maxLoops:Number(params[7]),maxTotalLoops:Number(params[8]),
        runTotalLoops:Number(params[9]),
        reasonCode:params[10]==="stage_advanced"?"stage_advanced"
          :params[10]==="stage_loop_limit_reached"?"stage_loop_limit_reached":"run_loop_limit_reached",
        receiptId:String(params[11]),receiptDigest:String(params[12]),requestDigest:String(params[13]),
        recordedAt:String(params[15])};
      if (loops.some(existing=>existing.id===params[0])) return result([] as T[]);
      loops.push({id:params[0],pipeline_run_id:"pipeline-run:test",stage_ordinal:params[4],worker_id:params[5],
        loop_index:params[6],max_loops:params[7],max_total_loops:params[8],run_total_loops:params[9],
        reason_code:params[10],receipt_id:params[11],receipt_digest:params[12],request_digest:params[13],
        auth_tag:hmacSha256Tag(key,{purpose:"pipeline-stage-loop-count/v1",record:material}),recorded_at:params[15]});
      return result([] as T[]);}
    if(sql.includes("FROM control_jobs")){
      // A pipeline job id names its stage: `job:source:<n>` is the stage's own
      // job, `job:reentry:<n>:<seq>` is a fix round the planner minted, and
      // `job:execution:<n>` is the execution job for stage n.
      const ordinal=ordinalOfJobId(String(params[2])),stage=rows.stages[ordinal]!;
      const value=job(String(params[2]));value.authority.allowedExecutor=stage.worker_id;
      value.authority.digest=computeAuthorityDigest(value.authority);
      return result([{payload:value,project_id:"project:test",workflow_id:"workflow:test",pipeline_run_id:"pipeline-run:test",
        stage_kind:stage.stage_kind,stage_ordinal:ordinal}] as T[]);}
    if(sql.includes("FROM control_task_execution_plans")){
      // The plan row names the SOURCE job it was planned from, which is the
      // stage's own CURRENT job -- including after a fix round, where the
      // planner mints a new source job and plans the execution job from it.
      const stage=rows.stages[ordinalOfJobId(String(params[2]))]!;
      return result([{source_job_id:stage.current_job_id}] as T[]);}
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
    if(sql.startsWith("INSERT INTO pipeline_advance_receipts")){
      // Column order: id,tenant,project,run,stage,loop_index,source,execution,attempt,
      // queue,selection_digest,template_version,template_digest,run_version,run_digest,
      // policy_id,policy_version,policy_digest,delegation_receipt_id,delegation_receipt_digest,
      // task_units,cost_state,cost_microusd,cost_evidence_digest,request_digest,receipt_digest,
      // auth_tag,advanced_at.
      const receipt={id:params[0],project_id:params[2],pipeline_run_id:params[3],
        stage_ordinal:params[4],loop_index:params[5],source_job_id:params[6],execution_job_id:params[7],attempt_id:params[8],
        queue_id:params[9],selection_digest:params[10],template_version:params[11],template_digest:params[12],run_version:params[13],
        run_digest:params[14],policy_id:params[15],policy_version:params[16],policy_digest:params[17],delegation_receipt_id:params[18],
        delegation_receipt_digest:params[19],delegation_task_units:params[20],delegation_cost_state:params[21],
        delegation_cost_microusd:params[22],delegation_cost_evidence_digest:params[23],request_digest:params[24],
        receipt_digest:params[25],auth_tag:params[26],advanced_at:params[27]};
      receipts.set(`${Number(params[4])}:${Number(params[5])}`,receipt);
      // The durable receipt is what the next ceiling check counts: one per fix round.
      loopRounds.push({stage_ordinal:Number(params[4]),loop_index:Number(params[5]),source_job_id:String(params[6])});
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
      executorId:selection.workerId,taskUnits:0,committedCostMicroUsd:0,
      nextCost:overrides.nextCostKind==="unknown"?{kind:"unknown" as const}
        :{kind:"known" as const,microUsd:10,evidenceDigest:digest("e")},
      concurrentTasks:0,validUntil:iso(60000),...overrides.usage}),
    assignAndQueueInSession:async(_tx,_input,gate)=>{if(overrides.coordinatorDeadline!==undefined)
      gate.commitDeadline(overrides.coordinatorDeadline);if(overrides.disableDuringDispatch)enabled=false;await gate.assertCurrent();
      effects+=1;return{attemptId:"attempt:one",queueId:"queue:one",replayed:false};}};
  const service=new PipelineAdvanceServiceV1(db,{tenantId:"tenant:test",workspaceId:"workspace:test"},key,
    {unattendedEnabled:()=>enabled,capability},()=>clock);
  return{service,setStates(value:PipelineStageResolutionV1["state"][]){states=value;},get currentOrdinal(){return rows.run.current_stage_ordinal;},
    get runVersion(){return rows.run.version;},get effects(){return effects;},get receipts(){return receipts;},
    get loops(){return loops;},get attentions(){return overrides.attentions??[];},
    /** One more fix round for a stage: the planner's shape. A re-entry mints a NEW
     * source job and the stage row's `current_job_id` moves to it, so the round
     * count -- the stage's own receipts -- grows by exactly one and the next
     * advance is the next round rather than a replay of the last. The stage row
     * is signed over that column, so it is re-signed with the service's own key:
     * an unsigned rewind would fail the run's integrity check instead of
     * reaching the loop ceiling. */
    reenterStage(ordinal:number){const stage=rows.stages[ordinal]!;
      stage.current_job_id=`job:reentry:${ordinal}:${loopRounds.length}`;
      const material={id:`pipeline-run:test:stage:${ordinal}`,tenantId:"tenant:test",projectId:"project:test",
        pipelineRunId:"pipeline-run:test",stageOrdinal:ordinal,stageKind:stage.stage_kind,role:stage.role,
        workerId:stage.worker_id,workerKind:stage.worker_kind,nodeId:stage.node_id,selectionKey:stage.selection_key,
        model:stage.model,effort:stage.effort,provider:stage.provider,profile:stage.profile,
        currentJobId:stage.current_job_id,currentAttemptId:stage.current_attempt_id,currentLeaseId:stage.current_lease_id,
        state:stage.state,maxLoops:Number(stage.max_loops),handoffFromResultDigest:stage.handoff_from_result_digest,
        allowedPaths:stage.allowed_paths,maximumChangedFiles:stage.maximum_changed_files,
        maximumChangedBytes:stage.maximum_changed_bytes,signoffReviewId:stage.signoff_review_id,
        startedAt:stage.started_at===null?null:iso(stage.started_at),
        finishedAt:stage.finished_at===null?null:iso(stage.finished_at),version:Number(stage.version)};
      stage.record_digest=sha256Digest(material);
      stage.auth_tag=hmacSha256Tag(key,{purpose:"pipeline-stage-run/v1",record:material});},
    /** The planner materialises a not-yet-started stage's job. Nothing enters the
     * receipt chain: a planned job is not a started round, which is the whole
     * point of counting receipts rather than jobs. */
    planStage(_ordinal:number){}};
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
// The policy allowances are the caps: max_total_tasks 3, max_concurrent_tasks 2
// in the fixture policy. There is no dollar cap by default, so a known cost is
// recorded and never refused; the installation's optional cap is pinned below.
test("exhausted policy allowances refuse before assignment or queue effects",async()=>{
  for(const [usage,reason] of [[{taskUnits:3},"policy_task_allowance_exhausted"],
    [{concurrentTasks:2},"policy_concurrency_exhausted"]] as const){
    const f=fixture({usage});
    await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
      (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason===reason,reason);
    assert.equal(f.effects,0,reason);}
  const edge=fixture({usage:{taskUnits:2,concurrentTasks:1}});
  assert.equal((await edge.service.advance("pipeline-run:test","policy:test")).startsWork,true);assert.equal(edge.effects,1);
  // "Count runs, never dollars": with no dollar cap set, even a very expensive
  // known next cost advances. Only the run ceilings bound this run.
  const rich=fixture({usage:{taskUnits:2,concurrentTasks:1}});
  assert.equal((await rich.service.advance("pipeline-run:test","policy:test")).startsWork,true);
});
test("a forged owner consent tag refuses advance before assignment or queue effects",async()=>{
  const f=fixture({tamperConsent:true});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="pipeline_integrity_failed");
  assert.equal(f.effects,0);assert.equal(f.receipts.size,0);});

// S7b: each installation ceiling refuses exactly AT its boundary, never past
// it, and always before any assignment or queue effect. Only the ceiling under
// test is at its boundary in each case; the others are far away.
test("each installation ceiling refuses at its own boundary and one below it advances",async()=>{
  const open={runs_per_hour:6,runs_per_agent_per_day:12,machine_max_agent_processes:12,
    machine_max_db_clusters:6,dollar_cap_microusd:null};
  const cases=[
    // reason, limits to tighten, count already at the boundary
    ["installation_runs_per_hour_exhausted",{runs_per_hour:2},2],
    ["installation_agent_runs_per_day_exhausted",{runs_per_agent_per_day:2},2],
    ["installation_agent_process_ceiling_reached",{machine_max_agent_processes:4},4],
    ["installation_db_cluster_ceiling_reached",{machine_max_db_clusters:3},3],
  ] as const;
  for(const [reason,tightened,atBoundary] of cases){
    const allowance={...open,...tightened};
    const busy={runsThisHour:0,agentRunsToday:0,activeProcesses:0,dbClusters:0};
    // AT the boundary: the next run would be one too many, so it refuses.
    const at=fixture({allowance,...busy,
      ...(reason==="installation_runs_per_hour_exhausted"?{runsThisHour:atBoundary}:{}),
      ...(reason==="installation_agent_runs_per_day_exhausted"?{agentRunsToday:atBoundary}:{}),
      ...(reason==="installation_agent_process_ceiling_reached"?{activeProcesses:atBoundary}:{}),
      ...(reason==="installation_db_cluster_ceiling_reached"?{dbClusters:atBoundary}:{})});
    await assert.rejects(at.service.advance("pipeline-run:test","policy:test"),
      (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason===reason,reason);
    assert.equal(at.effects,0,reason);assert.equal(at.receipts.size,0,reason);
    // ONE BELOW: the run still fits and advances.
    const below=fixture({allowance,...busy,
      ...(reason==="installation_runs_per_hour_exhausted"?{runsThisHour:atBoundary-1}:{}),
      ...(reason==="installation_agent_runs_per_day_exhausted"?{agentRunsToday:atBoundary-1}:{}),
      ...(reason==="installation_agent_process_ceiling_reached"?{activeProcesses:atBoundary-1}:{}),
      ...(reason==="installation_db_cluster_ceiling_reached"?{dbClusters:atBoundary-1}:{})});
    assert.equal((await below.service.advance("pipeline-run:test","policy:test")).startsWork,true,reason);
    assert.equal(below.effects,1,reason);
  }
});
test("an unknown or unrecorded cluster count refuses and a stale observation is not trusted",async()=>{
  const unrecorded=fixture({dbClusters:null});
  await assert.rejects(unrecorded.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="installation_cluster_count_unknown");
  assert.equal(unrecorded.effects,0);
  // Recorded two days ago: nobody may claim that is still true.
  const stale=fixture({dbClusters:1,clusterObservedAt:-172800000});
  await assert.rejects(stale.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="installation_cluster_count_unknown");
  assert.equal(stale.effects,0);
});
test("an installation with no allowance record refuses rather than assuming defaults",async()=>{
  const f=fixture({noAllowance:true});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="installation_allowance_missing");
  assert.equal(f.effects,0);assert.equal(f.receipts.size,0);});
test("a forged allowance tag refuses advance before assignment or queue effects",async()=>{
  const f=fixture({tamperAllowance:true});
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="pipeline_integrity_failed");
  assert.equal(f.effects,0);});
test("the optional dollar cap refuses only when it is set and the cost is known",async()=>{
  const capped={runs_per_hour:6,runs_per_agent_per_day:12,machine_max_agent_processes:12,
    machine_max_db_clusters:6,dollar_cap_microusd:100};
  // 95 spent, next run costs 10: one micro-USD over the cap, so it refuses.
  const over=fixture({allowance:capped,spentMicroUsd:95});
  await assert.rejects(over.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="installation_cost_ceiling_exhausted");
  assert.equal(over.effects,0);
  // Exactly 90 spent leaves exactly 10: the next run fits and advances.
  const edge=fixture({allowance:capped,spentMicroUsd:90});
  assert.equal((await edge.service.advance("pipeline-run:test","policy:test")).startsWork,true);
  // A fully spent cap with an UNKNOWN cost still advances: unknown is not a
  // number, and unknown must never refuse.
  const unknown=fixture({allowance:capped,spentMicroUsd:100,nextCostKind:"unknown"});
  assert.equal((await unknown.service.advance("pipeline-run:test","policy:test")).startsWork,true);
  // With no cap set at all, an expensive known cost advances as well.
  const uncapped=fixture({spentMicroUsd:0});
  assert.equal((await uncapped.service.advance("pipeline-run:test","policy:test")).startsWork,true);
});
test("an unknown cost advances and the receipt records it as unknown with no invented number",async()=>{
  const f=fixture({nextCostKind:"unknown"});
  const outcome=await f.service.advance("pipeline-run:test","policy:test");
  assert.equal(outcome.startsWork,true);
  assert.equal(f.effects,1);
  const receipt=f.receipts.get("0:0");
  assert.equal(receipt.delegation_cost_state,"unknown");
  assert.equal(receipt.delegation_cost_microusd,null);
  assert.equal(receipt.delegation_cost_evidence_digest,null);
  // The replay path accepts the same honest unknown, so a lost response is still
  // a replay and not a conflict.
  const replay=await f.service.advance("pipeline-run:test","policy:test");
  assert.equal((replay as {replayed:boolean}).replayed,true);
  // A known cost is stored with its number and its evidence digest.
  const known=fixture();
  await known.service.advance("pipeline-run:test","policy:test");
  assert.equal(known.receipts.get("0:0").delegation_cost_state,"known");
  assert.equal(known.receipts.get("0:0").delegation_cost_microusd,10);
  assert.equal(known.receipts.get("0:0").delegation_cost_evidence_digest,digest("e"));});
test("the loop limit stops advancing that run and raises exactly one Needs Attention item",async()=>{
  // The fixture template gives stage 0 maxLoops 1: round 0 runs, and the stage may
  // be entered once more. A third entry is past the ceiling.
  const attentions:any[]=[];
  const f=fixture({attentions,maxTotalLoops:6});
  assert.equal((await f.service.advance("pipeline-run:test","policy:test")).startsWork,true);
  assert.equal(f.loops.length,1);
  assert.equal(f.loops[0].loop_index,0);
  assert.equal(f.loops[0].worker_id,"worker:one");
  assert.equal(f.loops[0].reason_code,"stage_advanced");
  // A lost response replays the same receipt and never opens a second round.
  await f.service.advance("pipeline-run:test","policy:test");
  assert.equal(f.loops.length,1);
  // One fix round: the planner adds a job to the same stage, so the next advance
  // is round 1, which max_loops 1 still admits.
  f.reenterStage(0);
  assert.equal((await f.service.advance("pipeline-run:test","policy:test")).startsWork,true);
  assert.deepEqual(f.loops.map(row=>[row.stage_ordinal,row.loop_index,row.reason_code]),[[0,0,"stage_advanced"],[0,1,"stage_advanced"]]);
  // A second fix round is round 2, past max_loops 1: the run stops, and the owner
  // is told once.
  f.reenterStage(0);
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="stage_loop_limit_reached");
  assert.equal(attentions.length,1);
  assert.equal(attentions[0].reasonCode,"pipeline_stage_loop_limit_reached");
  assert.equal(attentions[0].maxLoops,1);
  assert.equal(attentions[0].kind,"question");
  assert.equal(attentions[0].state,"open");
  // The stop is recorded as its own signed receipt of the ceiling decision. It
  // names the LAST ROUND THE RUN ACTUALLY STARTED, not the round that was
  // refused: a stop can sit at max_loops and never above it, which is what the
  // table's own CHECK asserts. Recording the refused round instead made every
  // stop fail its constraint and left the owner with a database error.
  const stops=f.loops.filter(row=>row.reason_code!=="stage_advanced");
  assert.equal(stops.length,1);
  // The clamp is the point of this assertion: the refused round is 2, one past
  // the ceiling of 1, and the recorded row must sit AT the ceiling instead. A
  // fake table cannot prove the CHECK catches it, so this asserts the value the
  // CHECK exists to guarantee, and the real-login suite proves the CHECK.
  assert.equal(floors(stops[0]),true,"the recorded round is inside the ceiling it names");
  assert.equal(stops[0].loop_index,1);
  assert.equal(stops[0].max_loops,1);
  assert.equal(stops[0].run_total_loops,2);
  assert.equal(stops[0].reason_code,"stage_loop_limit_reached");
  // Repeating the refusal raises no second item and claims no new round.
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="stage_loop_limit_reached");
  assert.equal(attentions.length,1);
  assert.equal(f.loops.filter(row=>row.reason_code!=="stage_advanced").length,1);
});
test("the run-wide loop ceiling stops a run whose stages are each under their own",async()=>{
  // max_total_loops 2 admits round indices 0 and 1 for the whole run. Stage 0
  // runs round 0, stage 1 runs round 1, and neither stage is near its own
  // max_loops of 1. A second round on stage 0 would be round 2 of the run, so it
  // is the RUN ceiling that stops it, not the stage ceiling.
  const attentions:any[]=[];
  const f=fixture({attentions,maxTotalLoops:2});
  assert.equal((await f.service.advance("pipeline-run:test","policy:test")).startsWork,true);
  f.setStates(["accepted","eligible","terminal_failure"]);
  assert.equal((await f.service.advance("pipeline-run:test","policy:test")).startsWork,true);
  // The run is on stage 1 with two rounds spent. A fix round back on stage 0
  // would be the run's third round.
  f.setStates(["accepted","eligible","terminal_failure"]);
  f.reenterStage(0);
  await assert.rejects(f.service.advance("pipeline-run:test","policy:test"),
    (error:unknown)=>error instanceof PipelineAdvanceErrorV1&&error.safeReason==="run_loop_limit_reached");
  assert.equal(attentions.length,1);
  assert.equal(attentions[0].reasonCode,"pipeline_run_loop_limit_reached");
  assert.equal(attentions[0].maxTotalLoops,2);
  // Neither stage hit its own ceiling: no round row carries a stage refusal.
  assert.ok(f.loops.every(row=>row.reason_code!=="stage_loop_limit_reached"));
  // Nothing was queued for the refused round.
  assert.equal(f.effects,2);
});
test("the counted loop rounds are appended with the receipt that opened them",async()=>{
  const f=fixture();
  await f.service.advance("pipeline-run:test","policy:test");
  assert.equal(f.loops.length,1);
  const [row]=f.loops;
  assert.equal(row.stage_ordinal,0);
  assert.equal(row.loop_index,0);
  assert.equal(row.worker_id,"worker:one");
  assert.equal(row.reason_code,"stage_advanced");
  // A replay of the same receipt must not append a second round.
  await f.service.advance("pipeline-run:test","policy:test");
  assert.equal(f.loops.length,1);});

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
    if(sql.includes("FROM pipeline_runs r JOIN LATERAL")){
      assert.match(sql,/ORDER BY r\.unattended_last_swept_at NULLS FIRST,\s*r\.id LIMIT \$2/u);
      const limit=Number(params[1]);
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
  assert.equal(Number(f.receipts.get("1:0")?.run_version),3);
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

test("0109 owner transition authenticates and persists both unattended consents with exact replay",async t=>{
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
  // Without a live owner grant the consent is refused and nothing is written.
  await f.db.query("UPDATE control_role_grants SET revoked_at=$1 WHERE identity_id=$2",
    [new Date(webNow-1).toISOString(),"identity:web"]);
  await assert.rejects(service.setUnattended(f.identity,f.project.projectId,command,"pipeline-unattended-revoked-0001"),
    /access_denied/u);
  assert.equal((await f.db.query<{count:number}>("SELECT count(*)::int count FROM pipeline_unattended_transitions")).rows[0]!.count,0);
  await f.db.query("UPDATE control_role_grants SET revoked_at=NULL WHERE identity_id=$1",["identity:web"]);
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
  // Simulate an authenticated legacy row created before 0109's NOT VALID
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
  const down=await readFile("db/down/0109_pipeline_unattended_advance.sql","utf8");
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

test("0109 owns append-only records, least-privilege grants, and a guarded down path",async()=>{
  const [up,down,grants,web,coordinator,preflight]=await Promise.all([readFile("db/migrations/0109_pipeline_unattended_advance.sql","utf8"),
    readFile("db/down/0109_pipeline_unattended_advance.sql","utf8"),readFile("db/roles/production_table_grants.sql","utf8"),
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
  // cook/v1 renamed the local to the exported privateWebInsertTables, and the
  // declaration this asserts is that the slice still adds its own table there.
  assert.match(preflight,/privateWebInsertTables\.add\("pipeline_unattended_transitions"\)/u);
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

test("production authority derives policy usage and cost from canonical records and reports an unknown cost as unknown",async()=>{
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
  // "Count runs, never dollars": an unknown cost is an honest unknown, not a
  // refusal. It is refused nowhere, and the receipt records it as unknown.
  const unknown=new ProductionPipelineAdvanceAuthorityV1({tenantId:"tenant:test",workspaceId:"workspace:test"},current,
    accepted,{currentCost:()=>({kind:"unknown"})},()=>at);
  const unknownReceipt=await unknown.authorizeDelegationInSession(tx,selection,"policy:test");
  assert.deepEqual(unknownReceipt.nextCost,{kind:"unknown"});
  // A cost port that CLAIMS to know the cost and returns something impossible is
  // an integrity failure, not an honest unknown: demoting it to `unknown` let it
  // slip past every dollar ceiling, so it now refuses before anything is queued.
  for (const forged of [
    { kind: "known" as const, admittedCostMicroUsd: -5, evidenceDigest: digest("e") },
    { kind: "known" as const, admittedCostMicroUsd: 1.5, evidenceDigest: digest("e") },
    { kind: "known" as const, admittedCostMicroUsd: 10, evidenceDigest: "not-a-digest" },
  ]) {
    const lying=new ProductionPipelineAdvanceAuthorityV1({tenantId:"tenant:test",workspaceId:"workspace:test"},current,
      accepted,{currentCost:()=>forged as never},()=>at);
    await assert.rejects(lying.authorizeDelegationInSession(tx,selection,"policy:test"),
      (error:unknown)=>(error as {safeReason?:string}).safeReason==="advance_conflict",
      `a malformed known cost must refuse, got ${JSON.stringify(forged)}`);
  }
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
  const history=(limit:number)=>db.transaction(tx=>readPipelineHistoryInSessionV1(tx,"tenant:test","project:test",
    "pipeline-run:test",limit,at));
  const bounded=await history(6);
  assert.equal(bounded.chainVerified,true);assert.equal(bounded.truncated,true);assert.deepEqual(bounded.events.map(event=>event.kind),
    ["proposed","revised","approved","rejected","partially_approved","revision_planned"]);
  const complete=await history(30);
  assert.equal(complete.truncated,false);assert.deepEqual(complete.events.map(event=>event.kind),
    ["proposed","revised","approved","rejected","partially_approved","revision_planned","ran","assignment_expired",
      "delivery_prepared","delivery_staged","transmission_requested","delivery_received","queue_recovered","delivery_staged",
      "transmission_requested","delivery_received","capacity_released","received","resulted","checked","completed","advanced"]);
});
