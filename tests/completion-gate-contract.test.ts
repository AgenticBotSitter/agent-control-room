import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  COMPLETION_GATE_SCHEMA_VERSION_V1,
  CompletionGateErrorV1,
  CompletionGateStoreV1,
  completionAcceptanceProfileSchemaV1,
  completionReviewSchemaV1,
  type CompletionAcceptanceProfileV1,
  type CompletionFindingV1,
  type CompletionPrincipalV1,
  type CompletionReviewTargetV1,
  type CompletionReviewV1,
  type CompletionRevisionV1,
} from "../src/completion-gate/v1";
import type { AuthorityEnvelope, EffectIntentRecord, JobRecord } from "../src/domain/v1";
import { adaptPglite } from "../src/persistence/database";
import { computeAuthorityDigest, computeEffectOperationDigest, InMemoryRollbackCheckpointStoreV1, rollbackCheckpointDigestV1, SecurityStore, sha256Digest } from "../src/security";
import { observedProxy,type ObservedProxyMode } from "./proxy-test-helper";

const tenantId="tenant:cr8b";const projectId="project:cr8b";const integrityKey=new Uint8Array(32).fill(0x48);
const producer:CompletionPrincipalV1={actorId:"agent:producer",actorType:"agent",workerId:"worker:producer",agentProfileId:"profile:producer",harness:"harness:hermes",modelFamily:"model:producer"};
const reviewer:CompletionPrincipalV1={actorId:"agent:reviewer",actorType:"agent",workerId:"worker:reviewer",agentProfileId:"profile:reviewer",harness:"harness:codex",modelFamily:"model:reviewer"};
const verifier:CompletionPrincipalV1={actorId:"service:verifier",actorType:"service"};
const digest=(name:string)=>sha256Digest({evidence:name});

async function setup(now="2026-08-28T13:00:03.000Z"):Promise<{raw:PGlite;store:CompletionGateStoreV1;checkpoints:InMemoryRollbackCheckpointStoreV1}>{
  const raw=new PGlite();for(const file of (await readdir(resolve("db/migrations"))).filter((entry)=>entry.endsWith(".sql")).sort())await raw.exec(await readFile(resolve("db/migrations",file),"utf8"));
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ($1,'CR8B')`,[tenantId]);
  await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:cr8b',$1,'CR8B')`,[tenantId]);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,redaction_policy_version,cursor_retention_days)
    VALUES ('adapter:cr8b',$1,'fixture','v1','advisory','v1',30)`,[tenantId]);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES ($1,$2,'workspace:cr8b','adapter:cr8b','source:cr8b','v1','CR8B','ready','ready','healthy','advisory','2026-08-28T13:00:00Z','{}'::jsonb)`,[projectId,tenantId]);
  const checkpoints=new InMemoryRollbackCheckpointStoreV1({testOnly:true}),store=new CompletionGateStoreV1(adaptPglite(raw),integrityKey,checkpoints,()=>now);await store.provisionTenant(tenantId);return{raw,store,checkpoints};
}

function profile(overrides:Partial<CompletionAcceptanceProfileV1>={}):CompletionAcceptanceProfileV1{return{
  schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"completion-profile:cr8b",tenantId,projectId,name:"Code completion",
  targetKind:"code",requiredVerificationScenarioIds:["scenario:build","scenario:test"],minimumIndependentReviews:1,
  reviewerSeparation:{actor:true,worker:true,agentProfile:true,harness:true,modelFamily:true},verificationRequiresProducerSeparation:true,
  minimumRisk:"medium",maximumRevisionRounds:1,automaticLowRiskDisposition:false,createdBy:{actorId:"human:owner",actorType:"human"},
  createdAt:"2026-08-28T13:00:00.000Z",...overrides};}

function target(item:CompletionAcceptanceProfileV1,overrides:Partial<CompletionReviewTargetV1>={}):CompletionReviewTargetV1{return{
  schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"target:cr8b:0",tenantId,projectId,kind:"code",subjectId:"artifact:cr8b",
  subjectDigest:digest("artifact-v0"),acceptanceProfileId:item.id,acceptanceProfileDigest:sha256Digest(item),producer,rootTargetId:"target:cr8b:0",
  revisionNumber:0,submittedAt:"2026-08-28T13:00:01.000Z",...overrides};}

function review(item:CompletionAcceptanceProfileV1,reviewTarget:CompletionReviewTargetV1,overrides:Partial<CompletionReviewV1>={}):CompletionReviewV1{return{
  schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"review:cr8b:accepted",tenantId,projectId,targetId:reviewTarget.id,targetDigest:sha256Digest(reviewTarget),
  acceptanceProfileId:item.id,acceptanceProfileDigest:sha256Digest(item),reviewer,authority:"completion_gate",decision:"accepted",
  assessedRisk:"low",effectiveRisk:"medium",evidenceDigests:[digest("review")],findingIds:[],reviewedAt:"2026-08-28T13:00:04.000Z",
  grantsApproval:false,grantsExecutionAuthority:false,...overrides};}

function finding(reviewTarget:CompletionReviewTargetV1,reviewId:string,id="finding:cr8b:one"):CompletionFindingV1{return{
  schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id,tenantId,projectId,targetId:reviewTarget.id,targetDigest:sha256Digest(reviewTarget),reviewId,
  code:"acceptance_missing",severity:"medium",statementDigest:digest(`${id}:statement`),evidenceDigests:[digest(`${id}:evidence`)],raisedAt:"2026-08-28T13:00:04.000Z"};}

async function acceptedTarget(store:CompletionGateStoreV1){
  const acceptance=profile();const reviewTarget=target(acceptance);await store.registerProfile(acceptance);await store.registerTarget(reviewTarget);
  for(const [scenarioId,at] of [["scenario:build","2026-08-28T13:00:02.000Z"],["scenario:test","2026-08-28T13:00:03.000Z"]] as const){
    await store.recordVerification({schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:`verification:${scenarioId}`,tenantId,projectId,targetId:reviewTarget.id,
      targetDigest:sha256Digest(reviewTarget),acceptanceProfileId:acceptance.id,acceptanceProfileDigest:sha256Digest(acceptance),scenarioId,outcome:"passed",
      verifier,evidenceDigests:[digest(scenarioId)],verifiedAt:at,grantsApproval:false,grantsExecutionAuthority:false});
  }
  await store.recordReview(review(acceptance,reviewTarget));return{acceptance,reviewTarget};
}

test("CR8B schemas make advisory review, completion review, verification, preference, and approval non-interchangeable",()=>{
  const acceptance=profile();const reviewTarget=target(acceptance);
  assert.equal(completionReviewSchemaV1.safeParse(review(acceptance,reviewTarget,{authority:"advisory",decision:"accepted"})).success,false);
  assert.equal(completionReviewSchemaV1.safeParse(review(acceptance,reviewTarget,{authority:"advisory",decision:"commented",findingIds:["finding:advisory"]})).success,false);
  assert.equal(completionReviewSchemaV1.safeParse(review(acceptance,reviewTarget,{grantsApproval:true as never})).success,false);
  assert.equal(completionReviewSchemaV1.safeParse(review(acceptance,reviewTarget,{grantsExecutionAuthority:true as never})).success,false);
  assert.equal(completionAcceptanceProfileSchemaV1.safeParse(profile({reviewerSeparation:{...acceptance.reviewerSeparation,actor:false}})).success,false);
});

test("CR8B completion requires named verification, deterministic risk floor, and independent review",async()=>{
  const {raw,store}=await setup();try{
    const acceptance=profile();const reviewTarget=target(acceptance);await store.registerProfile(acceptance);await store.registerTarget(reviewTarget);
    assert.deepEqual((await store.snapshot(tenantId,reviewTarget.id)).missingVerificationScenarioIds,["scenario:build","scenario:test"]);
    await store.recordPreference({schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"preference:cr8b",tenantId,projectId,subjectId:reviewTarget.subjectId,
      subjectDigest:reviewTarget.subjectDigest,optionDigests:[digest("option-a"),digest("option-b")].sort(),selectedOptionDigest:digest("option-a"),
      selectedBy:{actorId:"human:owner",actorType:"human"},selectedAt:"2026-08-28T13:00:02.000Z",grantsApproval:false,grantsExecutionAuthority:false});
    assert.equal((await store.snapshot(tenantId,reviewTarget.id)).status,"pending");
    await assert.rejects(store.recordVerification({schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"verification:self",tenantId,projectId,targetId:reviewTarget.id,
      targetDigest:sha256Digest(reviewTarget),acceptanceProfileId:acceptance.id,acceptanceProfileDigest:sha256Digest(acceptance),scenarioId:"scenario:build",
      outcome:"passed",verifier:producer,evidenceDigests:[digest("self")],verifiedAt:"2026-08-28T13:00:02.000Z",grantsApproval:false,grantsExecutionAuthority:false}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="reviewer_not_independent");
    await assert.rejects(store.recordReview(review(acceptance,reviewTarget,{id:"review:self",reviewer:producer})),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="reviewer_not_independent");
    await assert.rejects(store.recordReview(review(acceptance,reviewTarget,{id:"review:risk",effectiveRisk:"low"})),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="risk_floor_mismatch");
    for(const [scenarioId,at] of [["scenario:build","2026-08-28T13:00:02.000Z"],["scenario:test","2026-08-28T13:00:03.000Z"]] as const){
      await store.recordVerification({schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:`verification:${scenarioId}`,tenantId,projectId,targetId:reviewTarget.id,
        targetDigest:sha256Digest(reviewTarget),acceptanceProfileId:acceptance.id,acceptanceProfileDigest:sha256Digest(acceptance),scenarioId,outcome:"passed",
        verifier,evidenceDigests:[digest(scenarioId)],verifiedAt:at,grantsApproval:false,grantsExecutionAuthority:false});
    }
    await store.recordReview(review(acceptance,reviewTarget));const snapshot=await store.snapshot(tenantId,reviewTarget.id);
    assert.deepEqual({status:snapshot.status,requiresSeparateApproval:snapshot.requiresSeparateApproval,grantsApproval:snapshot.grantsApproval,
      grantsExecutionAuthority:snapshot.grantsExecutionAuthority},{status:"ready",requiresSeparateApproval:true,grantsApproval:false,grantsExecutionAuthority:false});
  }finally{await raw.close();}
});

test("CR8B immutable semantic replay rejects drift and correlated reviewers do not multiply independence",async()=>{
  const {raw,store}=await setup();try{
    const acceptance=profile({minimumIndependentReviews:2});const reviewTarget=target(acceptance);
    assert.equal((await store.registerProfile(acceptance)).replayed,false);assert.equal((await store.registerProfile(acceptance)).replayed,true);
    await assert.rejects(store.registerProfile({...acceptance,name:"Changed profile"}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="record_conflict");
    assert.equal((await store.registerTarget(reviewTarget)).replayed,false);assert.equal((await store.registerTarget(reviewTarget)).replayed,true);
    await assert.rejects(store.registerTarget({...reviewTarget,subjectDigest:digest("changed-target")}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="record_conflict");
    const verification={schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"verification:replay",tenantId,projectId,targetId:reviewTarget.id,
      targetDigest:sha256Digest(reviewTarget),acceptanceProfileId:acceptance.id,acceptanceProfileDigest:sha256Digest(acceptance),scenarioId:"scenario:build",
      outcome:"passed" as const,verifier,evidenceDigests:[digest("replay-verification")],verifiedAt:"2026-08-28T13:00:02.000Z",
      grantsApproval:false as const,grantsExecutionAuthority:false as const};
    assert.equal((await store.recordVerification(verification)).replayed,false);assert.equal((await store.recordVerification(verification)).replayed,true);
    await assert.rejects(store.recordVerification({...verification,id:"verification:conflict",outcome:"failed"}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="record_conflict");
    const accepted=review(acceptance,reviewTarget);await store.recordReview(accepted);
    const correlated={...reviewer,actorId:"agent:reviewer:alias"};
    await assert.rejects(store.recordReview(review(acceptance,reviewTarget,{id:"review:correlated",reviewer:correlated})),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="reviewer_not_independent");
    const independent:CompletionPrincipalV1={actorId:"agent:reviewer:two",actorType:"agent",workerId:"worker:reviewer:two",
      agentProfileId:"profile:reviewer:two",harness:"harness:independent",modelFamily:"model:independent"};
    const changes=review(acceptance,reviewTarget,{id:"review:independent:changes",reviewer:independent,decision:"changes_requested",
      findingIds:["finding:independent"],reviewedAt:"2026-08-28T13:00:05.000Z"});
    await store.recordReview(changes,[{...finding(reviewTarget,changes.id,"finding:independent"),raisedAt:changes.reviewedAt}]);
    assert.equal((await store.recordReview(accepted)).replayed,true);
    assert.equal((await store.snapshot(tenantId,reviewTarget.id)).status,"changes_requested");
  }finally{await raw.close();}
});

test("CR8B serializes simultaneous correlated reviewers",async()=>{
  const {raw,store}=await setup();try{
    const acceptance=profile({minimumIndependentReviews:2});const reviewTarget=target(acceptance);await store.registerProfile(acceptance);await store.registerTarget(reviewTarget);
    const correlated={...reviewer,actorId:"agent:reviewer:concurrent"};
    const results=await Promise.allSettled([
      store.recordReview(review(acceptance,reviewTarget,{id:"review:concurrent:one"})),
      store.recordReview(review(acceptance,reviewTarget,{id:"review:concurrent:two",reviewer:correlated})),
    ]);
    assert.equal(results.filter((result)=>result.status==="fulfilled").length,1);
    assert.equal(results.filter((result)=>result.status==="rejected"&&result.reason instanceof CompletionGateErrorV1
      &&result.reason.safeCode==="reviewer_not_independent").length,1);
  }finally{await raw.close();}
});

test("CR8B code, media, document, and operation profiles share the same negative-authority completion contract",async()=>{
  const {raw,store}=await setup();try{
    for(const [index,kind] of (["code","media","document","operation"] as const).entries()){
      const acceptance=profile({id:`completion-profile:${kind}`,name:`${kind} acceptance`,targetKind:kind,
        requiredVerificationScenarioIds:[`scenario:${kind}`]});
      const reviewTarget=target(acceptance,{id:`target:${kind}:0`,kind,subjectId:`artifact:${kind}`,subjectDigest:digest(`${kind}-artifact`),
        acceptanceProfileId:acceptance.id,acceptanceProfileDigest:sha256Digest(acceptance),rootTargetId:`target:${kind}:0`,submittedAt:`2026-08-28T13:01:0${index}.000Z`});
      await store.registerProfile(acceptance);await store.registerTarget(reviewTarget);
      await store.recordVerification({schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:`verification:${kind}`,tenantId,projectId,targetId:reviewTarget.id,
        targetDigest:sha256Digest(reviewTarget),acceptanceProfileId:acceptance.id,acceptanceProfileDigest:sha256Digest(acceptance),scenarioId:`scenario:${kind}`,
        outcome:"passed",verifier,evidenceDigests:[digest(`${kind}-verification`)],verifiedAt:`2026-08-28T13:02:0${index}.000Z`,
        grantsApproval:false,grantsExecutionAuthority:false});
      await store.recordReview(review(acceptance,reviewTarget,{id:`review:${kind}`,reviewedAt:`2026-08-28T13:03:0${index}.000Z`}));
      const snapshot=await store.snapshot(tenantId,reviewTarget.id);assert.equal(snapshot.status,"ready");assert.equal(snapshot.grantsApproval,false);
      assert.equal(snapshot.grantsExecutionAuthority,false);assert.equal(snapshot.requiresSeparateApproval,true);
    }
  }finally{await raw.close();}
});

test("CR8B requested changes create one bounded immutable revision and explicit finding resolution",async()=>{
  const {raw,store}=await setup();try{
    const acceptance=profile();const original=target(acceptance);await store.registerProfile(acceptance);await store.registerTarget(original);
    const changeReview=review(acceptance,original,{id:"review:cr8b:changes",decision:"changes_requested",findingIds:["finding:cr8b:one"]});
    const firstFinding=finding(original,changeReview.id);await store.recordReview(changeReview,[firstFinding]);
    assert.deepEqual((await store.snapshot(tenantId,original.id)).status,"changes_requested");
    const revised=target(acceptance,{id:"target:cr8b:1",subjectDigest:digest("artifact-v1"),rootTargetId:original.id,revisionNumber:1,
      supersedesTargetId:original.id,submittedAt:"2026-08-28T13:00:05.000Z"});
    const revision:CompletionRevisionV1={schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"revision:cr8b:1",tenantId,projectId,rootTargetId:original.id,
      fromTargetId:original.id,fromTargetDigest:sha256Digest(original),toTargetId:revised.id,toTargetDigest:sha256Digest(revised),revisionNumber:1,
      resolvedFindingIds:[firstFinding.id],revisedBy:producer,revisedAt:revised.submittedAt,grantsApproval:false,grantsExecutionAuthority:false};
    await assert.rejects(store.recordRevision({...revision,toTargetDigest:sha256Digest({...revised,subjectDigest:original.subjectDigest})},
      {...revised,subjectDigest:original.subjectDigest}),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="revision_invalid");
    const firstRevision=await store.recordRevision(revision,revised);assert.equal(firstRevision.replayed,false);
    assert.equal((await store.recordRevision(revision,revised)).replayed,true);assert.equal((await store.snapshot(tenantId,original.id)).status,"superseded");
    assert.equal((await store.snapshot(tenantId,revised.id)).status,"pending");
    await assert.rejects(store.recordVerification({schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"verification:late",tenantId,projectId,targetId:original.id,
      targetDigest:sha256Digest(original),acceptanceProfileId:acceptance.id,acceptanceProfileDigest:sha256Digest(acceptance),scenarioId:"scenario:build",
      outcome:"passed",verifier,evidenceDigests:[digest("late")],verifiedAt:"2026-08-28T13:00:06.000Z",grantsApproval:false,grantsExecutionAuthority:false}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="target_superseded");
    const lateReviewer:CompletionPrincipalV1={actorId:"agent:late",actorType:"agent",workerId:"worker:late",agentProfileId:"profile:late",
      harness:"harness:late",modelFamily:"model:late"};
    await assert.rejects(store.recordReview(review(acceptance,original,{id:"review:late",reviewer:lateReviewer,reviewedAt:"2026-08-28T13:00:06.000Z"})),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="target_superseded");
    const secondReview=review(acceptance,revised,{id:"review:cr8b:changes:2",decision:"changes_requested",findingIds:["finding:cr8b:two"],reviewedAt:"2026-08-28T13:00:06.000Z"});
    const secondFinding={...finding(revised,secondReview.id,"finding:cr8b:two"),raisedAt:secondReview.reviewedAt};await store.recordReview(secondReview,[secondFinding]);
    assert.equal((await store.snapshot(tenantId,revised.id)).status,"revision_limit_reached");
    const overLimit=target(acceptance,{id:"target:cr8b:2",subjectDigest:digest("artifact-v2"),rootTargetId:original.id,revisionNumber:2,
      supersedesTargetId:revised.id,submittedAt:"2026-08-28T13:00:07.000Z"});
    await assert.rejects(store.recordRevision({...revision,id:"revision:cr8b:2",fromTargetId:revised.id,fromTargetDigest:sha256Digest(revised),
      toTargetId:overLimit.id,toTargetDigest:sha256Digest(overLimit),revisionNumber:2,resolvedFindingIds:[secondFinding.id],revisedAt:overLimit.submittedAt},overLimit),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="revision_invalid");
  }finally{await raw.close();}
});

async function seedEffect(raw:PGlite):Promise<{job:JobRecord;effect:EffectIntentRecord}>{
  await raw.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at) VALUES ('node:cr8b',$1,'active',1,'key:cr8b',$2::jsonb,'2026-08-28T13:00:00Z','2026-08-28T13:00:00Z')`,
    [tenantId,JSON.stringify({id:"node:cr8b",tenantId,state:"active",version:1,identityKeyId:"key:cr8b"})]);
  await raw.query(`INSERT INTO control_requests(id,tenant_id,state,version,idempotency_key,payload,created_at,updated_at) VALUES ('request:cr8b',$1,'draft',0,'request-cr8b-key',$2::jsonb,'2026-08-28T13:00:00Z','2026-08-28T13:00:00Z')`,
    [tenantId,JSON.stringify({id:"request:cr8b",tenantId,state:"draft",version:0,idempotencyKey:"request-cr8b-key"})]);
  const workflowDigest=digest("workflow");
  await raw.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at) VALUES ('workflow:cr8b',$1,'request:cr8b',$2,$3,'active',1,$4::jsonb,'2026-08-28T13:00:00Z','2026-08-28T13:00:00Z')`,
    [tenantId,projectId,workflowDigest,JSON.stringify({id:"workflow:cr8b",tenantId,requestId:"request:cr8b",projectId,definitionDigest:workflowDigest,state:"active",version:1})]);
  const authorityBase:AuthorityEnvelope={projectId,allowedExecutor:"executor:publish",allowedOperations:["operation:publish"],credentialRefs:[],filesystemRoots:[],
    networkPolicy:"none",allowedNetworkDestinations:[],effectPolicy:"approval_required",maxRisk:"medium",maxDurationSeconds:300,maxConcurrentEffects:1,
    expiresAt:"2026-08-28T14:00:00.000Z",digest:""};authorityBase.digest=computeAuthorityDigest(authorityBase);
  const job:JobRecord={contractVersion:"control-room-domain/v1",id:"job:cr8b",tenantId,version:1,createdAt:"2026-08-28T13:00:00.000Z",
    updatedAt:"2026-08-28T13:00:00.000Z",kind:"job",workflowId:"workflow:cr8b",projectId,jobType:"publish",specVersion:"v1",
    inputDigest:digest("job-input"),state:"running",priority:50,requiredCapability:"capability:publish",dependsOnJobIds:[],authority:authorityBase,
    retryPolicy:{maxAttempts:1,backoffSeconds:0,retryableFailureCodes:[],retryAfterOrphan:false,ambiguousEffectPolicy:"attention"}};
  await raw.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
    VALUES ($1,$2,'workflow:cr8b',$3,'running',1,50,'capability:publish',$4,$5::jsonb,$6,$6)`,[job.id,tenantId,projectId,job.authority.digest,JSON.stringify(job),job.createdAt]);
  await raw.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES ('attempt:cr8b',$1,$2,1,'running',1,'node:cr8b',1,$3::jsonb,'2026-08-28T13:00:00Z','2026-08-28T13:00:00Z')`,
    [tenantId,job.id,JSON.stringify({id:"attempt:cr8b",tenantId,jobId:job.id,attemptNumber:1,state:"running",version:1,nodeId:"node:cr8b",leaseEpoch:1})]);
  const effectBase={tenantId,jobId:job.id,attemptId:"attempt:cr8b",operation:"operation:publish",destination:"destination:reviewed",
    idempotencyKey:"effect-cr8b-idempotency",risk:"medium" as const};
  const effect:EffectIntentRecord={contractVersion:"control-room-domain/v1",id:"effect:cr8b",version:0,createdAt:"2026-08-28T13:00:01.000Z",
    updatedAt:"2026-08-28T13:00:01.000Z",kind:"effect_intent",...effectBase,operationDigest:computeEffectOperationDigest(effectBase,projectId),state:"proposed"};
  await raw.query(`INSERT INTO control_effect_intents(id,tenant_id,job_id,attempt_id,operation_digest,destination,idempotency_key,state,version,payload,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed',0,$8::jsonb,$9,$9)`,[effect.id,tenantId,effect.jobId,effect.attemptId,effect.operationDigest,effect.destination,effect.idempotencyKey,JSON.stringify(effect),effect.createdAt]);
  return{job,effect};
}

test("CR8B quality acceptance cannot substitute for an exact strong-factor consequential approval",async()=>{
  const {raw,store,checkpoints}=await setup();try{
    const {reviewTarget}=await acceptedTarget(store);assert.equal((await store.snapshot(tenantId,reviewTarget.id)).status,"ready");
    const {effect}=await seedEffect(raw);const request={schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"approval-request:cr8b",tenantId,projectId,
      jobId:effect.jobId,attemptId:effect.attemptId,effectIntentId:effect.id,operationDigest:effect.operationDigest,risk:effect.risk,requestedBy:{actorId:"agent:requester",actorType:"agent" as const},
      requiredFactor:"strong" as const,requestedAt:"2026-08-28T13:00:02.000Z",expiresAt:"2026-08-28T13:10:00.000Z",grantsExecutionAuthority:false as const};
    await assert.rejects(store.requestApproval({...request,id:"approval-request:too-long",expiresAt:"2026-08-28T14:00:01.000Z"}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="approval_binding_invalid");
    assert.equal(await store.getRecord(tenantId,"approval-request:cr8b","approval_request"),undefined);assert.equal((await store.requestApproval(request)).replayed,false);
    assert.equal((await store.requestApproval(request)).replayed,true);
    await assert.rejects(store.requestApproval({...request,id:"approval-request:changed",expiresAt:"2026-08-28T13:09:00.000Z"}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="record_conflict");
    const decision={schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"approval-decision:cr8b",tenantId,projectId,requestId:request.id,
      requestDigest:sha256Digest(request),operationDigest:request.operationDigest,policyDecisionId:"policy-decision:cr8b",decision:"approved" as const,
      decidedBy:{actorId:"human:owner",actorType:"human" as const},factor:"strong" as const,authenticationEventDigest:sha256Digest({evidenceId:"factor:cr8b"}),
      decidedAt:"2026-08-28T13:00:03.000Z",expiresAt:"2026-08-28T13:05:00.000Z",
      safeReasonCode:"owner_confirmed",grantsExecutionAuthority:false as const,requiresSeparateNodeAttestation:true as const};
    await assert.rejects(store.decideApproval(decision),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="approval_binding_invalid");
    const security=new SecurityStore(adaptPglite(raw));const authentication={tenantId,provider:"fixture",subject:"owner:cr8b",verifiedAt:"2026-08-28T13:00:02.000Z",
      expiresAt:"2026-08-28T14:00:00.000Z",strongFactor:{evidenceId:"factor:cr8b",method:"passkey" as const,verifiedAt:"2026-08-28T13:00:02.000Z",expiresAt:"2026-08-28T13:10:00.000Z"}};
    await security.bootstrapOwner({...authentication,identityId:"human:owner",grantId:"grant:owner:cr8b",displayName:"CR8B owner",now:"2026-08-28T13:00:02.000Z"});
    await security.authorize({decisionId:decision.policyDecisionId,authentication,request:{tenantId,action:"approval.decide",resourceType:"effect_intent",
      resourceId:effect.id,projectId,risk:effect.risk,externalEffect:true,occurredAt:decision.decidedAt}});
    const lateStore=new CompletionGateStoreV1(adaptPglite(raw),integrityKey,checkpoints,()=>request.expiresAt);
    await assert.rejects(lateStore.decideApproval(decision),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="approval_binding_invalid");
    await raw.query(`UPDATE control_role_grants SET expires_at='2026-08-28T13:04:00.000Z' WHERE tenant_id=$1 AND id='grant:owner:cr8b'`,[tenantId]);
    await assert.rejects(store.decideApproval(decision),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="approval_binding_invalid");
    await raw.query(`UPDATE control_role_grants SET expires_at=NULL WHERE tenant_id=$1 AND id='grant:owner:cr8b'`,[tenantId]);
    await assert.rejects(store.decideApproval({...decision,expiresAt:"2026-08-28T13:06:00.000Z"}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="approval_binding_invalid");
    await assert.rejects(store.decideApproval({...decision,decidedAt:request.expiresAt,expiresAt:"2026-08-28T13:11:00.000Z"}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="approval_binding_invalid");
    await assert.rejects(store.decideApproval({...decision,authenticationEventDigest:digest("forged-factor")}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="approval_binding_invalid");
    const first=await store.decideApproval(decision);assert.equal(first.replayed,false);assert.equal((await store.decideApproval(decision)).replayed,true);
    assert.deepEqual({grantsExecutionAuthority:first.decision.grantsExecutionAuthority,requiresSeparateNodeAttestation:first.decision.requiresSeparateNodeAttestation},
      {grantsExecutionAuthority:false,requiresSeparateNodeAttestation:true});
    await assert.rejects(store.decideApproval({...decision,id:"approval-decision:forged",operationDigest:digest("other-operation")}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&["approval_binding_invalid","record_conflict"].includes(error.safeCode));
  }finally{await raw.close();}
});

test("CR8B trusted broker time rejects a newly submitted backdated approval request",async()=>{
  const expiresAt="2026-08-28T13:10:00.000Z";const {raw,store}=await setup(expiresAt);try{
    const {effect}=await seedEffect(raw);await assert.rejects(store.requestApproval({schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"approval-request:late",tenantId,projectId,
      jobId:effect.jobId,attemptId:effect.attemptId,effectIntentId:effect.id,operationDigest:effect.operationDigest,risk:effect.risk,requestedBy:{actorId:"agent:requester",actorType:"agent"},
      requiredFactor:"strong",requestedAt:"2026-08-28T13:00:02.000Z",expiresAt,grantsExecutionAuthority:false}),
      (error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="approval_binding_invalid");
  }finally{await raw.close();}
});

test("CR8B same record IDs remain tenant-scoped",async()=>{
  const {raw,store}=await setup();try{
    await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:other','Other')`);
    await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:other','tenant:other','Other')`);
    await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,redaction_policy_version,cursor_retention_days)
      VALUES ('adapter:other','tenant:other','fixture','v1','advisory','v1',30)`);
    await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
      VALUES ('project:other','tenant:other','workspace:other','adapter:other','source:other','v1','Other','ready','ready','healthy','advisory','2026-08-28T13:00:00Z','{}'::jsonb)`);
    await store.provisionTenant("tenant:other");
    const first=profile();const second={...first,tenantId:"tenant:other",projectId:"project:other"};
    await store.registerProfile(first);await store.registerProfile(second);
    assert.equal((await store.getRecord(tenantId,first.id,"profile"))?.tenantId,tenantId);
    assert.equal((await store.getRecord("tenant:other",second.id,"profile"))?.tenantId,"tenant:other");
  }finally{await raw.close();}
});

test("CR8B append-only records reject mutation and recomputed ordinary digests without the external integrity key",async()=>{
  const {raw,store}=await setup();try{
    const acceptance=profile();await store.registerProfile(acceptance);
    await assert.rejects(raw.exec(`UPDATE control_completion_gate_records SET subject_id='profile:changed' WHERE id='${acceptance.id}'`),/append-only relation/);
    const forged={...acceptance,minimumRisk:"low" as const};
    await raw.exec(`ALTER TABLE control_completion_gate_records DISABLE TRIGGER control_completion_gate_records_append_only`);
    await raw.query(`UPDATE control_completion_gate_records SET payload=$1::jsonb,record_digest=$2 WHERE id=$3`,[JSON.stringify(forged),sha256Digest(forged),acceptance.id]);
    await raw.exec(`ALTER TABLE control_completion_gate_records ENABLE TRIGGER control_completion_gate_records_append_only`);
    await assert.rejects(store.getRecord(tenantId,acceptance.id,"profile"),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="integrity_failed");
    await assert.rejects(store.getRecord("tenant:other",acceptance.id,"profile"),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="integrity_failed");
  }finally{await raw.close();}
});

test("CR8B tenant state authentication detects privileged record deletion",async()=>{
  const {raw,store}=await setup();try{const acceptance=profile();await store.registerProfile(acceptance);
    await raw.exec(`ALTER TABLE control_completion_gate_records DISABLE TRIGGER control_completion_gate_records_append_only`);
    await raw.query(`DELETE FROM control_completion_gate_records WHERE tenant_id=$1 AND id=$2`,[tenantId,acceptance.id]);
    await raw.exec(`ALTER TABLE control_completion_gate_records ENABLE TRIGGER control_completion_gate_records_append_only`);
    await assert.rejects(store.getRecord(tenantId,acceptance.id,"profile"),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="integrity_failed");
  }finally{await raw.close();}
});

test("CR8Q external checkpoint rejects complete Completion Gate erasure",async()=>{
  const {raw,store}=await setup();try{await store.registerProfile(profile());
    await raw.exec(`ALTER TABLE control_completion_gate_records DISABLE TRIGGER control_completion_gate_records_append_only`);
    await raw.query(`DELETE FROM control_completion_gate_records WHERE tenant_id=$1`,[tenantId]);
    await raw.query(`DELETE FROM control_completion_gate_integrity WHERE tenant_id=$1`,[tenantId]);
    await raw.exec(`ALTER TABLE control_completion_gate_records ENABLE TRIGGER control_completion_gate_records_append_only`);
    await assert.rejects(store.registerProfile(profile()),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="integrity_failed");
    await assert.rejects(store.provisionTenant(tenantId),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="integrity_failed");
  }finally{await raw.close();}
});

test("CR8Q external checkpoint rejects an older valid Completion Gate snapshot",async()=>{
  const {raw,store}=await setup();try{const first=profile();await store.registerProfile(first);
    const prior=(await raw.query<{revision:number;record_count:number;state_digest:string;state_auth_tag:string}>(`SELECT revision,record_count,state_digest,state_auth_tag FROM control_completion_gate_integrity WHERE tenant_id=$1`,[tenantId])).rows[0];
    const second=profile({id:"completion-profile:second",name:"Second profile"});await store.registerProfile(second);
    await raw.exec(`ALTER TABLE control_completion_gate_records DISABLE TRIGGER control_completion_gate_records_append_only`);
    await raw.query(`DELETE FROM control_completion_gate_records WHERE tenant_id=$1 AND id=$2`,[tenantId,second.id]);
    await raw.query(`UPDATE control_completion_gate_integrity SET revision=$2,record_count=$3,state_digest=$4,state_auth_tag=$5 WHERE tenant_id=$1`,[tenantId,Number(prior.revision),Number(prior.record_count),prior.state_digest,prior.state_auth_tag]);
    await raw.exec(`ALTER TABLE control_completion_gate_records ENABLE TRIGGER control_completion_gate_records_append_only`);
    await assert.rejects(store.getRecord(tenantId,first.id,"profile"),(error:unknown)=>error instanceof CompletionGateErrorV1&&error.safeCode==="integrity_failed");
  }finally{await raw.close();}
});

test("CR8Q Completion Gate captures its trusted checkpoint functions",async()=>{const{raw,store,checkpoints}=await setup();try{
  checkpoints.read=()=>undefined;checkpoints.initialize=()=>{throw new Error("mutated initialize");};checkpoints.advance=()=>{throw new Error("mutated advance");};
  assert.equal((await store.registerProfile(profile())).replayed,false);
}finally{await raw.close();}});

test("CR8Q rollback checkpoints reject Proxies before any validation trap executes",()=>{for(const mode of ["transparent","key_hiding","descriptor_fabricating","throwing"] as ObservedProxyMode[]){const target={schema:"control-room-rollback-checkpoint/v1" as const,scope:"completion:tenant:proxy",revision:1,recordCount:0,stateDigest:"sha256:"+"a".repeat(64),stateAuthTag:"hmac-sha256:"+"b".repeat(64),...(mode==="key_hiding"?{[Symbol("hidden")]:true}:{})},proxy=observedProxy(target,mode);assert.throws(()=>rollbackCheckpointDigestV1(proxy.value as never),/checkpoint invalid/);assert.equal(proxy.trapCount(),0);}});
