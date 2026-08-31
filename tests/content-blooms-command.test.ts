import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  COMPLETION_GATE_SCHEMA_VERSION_V1,
  type ConsequentialApprovalDecisionV1,
  type ConsequentialApprovalRequestV1,
} from "../src/completion-gate/v1/index.ts";
import {
  APPROVAL_ATTESTATION_SCHEMA_V1,
  computeArtifactBodyDigest,
  signArtifact,
} from "../src/node-policy/v1/index.ts";
import { PackageRegistryStoreV1 } from "../src/package-registry/v1/index.ts";
import { adaptPglite,type DatabaseClient } from "../src/persistence/database.ts";
import {
  applyContentBloomsControlTransitionV1,
  buildContentBloomsAdapterReleaseV1,
  buildContentBloomsControlTransitionV1,
  buildContentBloomsPlacementAuthorizationV1,
  buildContentBloomsPlacementDeclarationV1,
  buildContentBloomsPlacementEffectClaimV1,
  buildContentBloomsPlacementNodeApprovalEvidenceV1,
  buildContentBloomsPlacementPreEffectMarkerV1,
  buildContentBloomsPlacementRequestV1,
  buildContentBloomsProjectPackProjectionV1,
  buildContentBloomsProjectPackV1,
  buildContentBloomsReadRequestV1,
  buildContentBloomsRouteComparisonPolicyV1,
  buildContentBloomsSyntheticFixtureRecordsV1,
  buildContentBloomsTranscriptionRouteObservationV1,
  buildInitialContentBloomsControlStateV1,
  compareContentBloomsTranscriptionRoutesV1,
  ContentBloomsContractErrorV1,
  ContentBloomsFixtureSourceV1,
  ContentBloomsInjectedCommandAdapterV1,
  ContentBloomsInjectedReadAdapterV1,
  ContentBloomsPlacementStoreV1,
  ContentBloomsSyntheticCommandSourceV1,
  ContentBloomsSyncStoreV1,
  parseContentBloomsPlacementNodeApprovalEvidenceV1,
  parseContentBloomsProjectPackProjectionV1,
  parseContentBloomsProjectPackV1,
  type ContentBloomsAdapterControlStateV1,
  type ContentBloomsAdapterReleaseV1,
  type ContentBloomsPlacementAuthorizationV1,
  type ContentBloomsPlacementDeclarationV1,
  type ContentBloomsPlacementNodeApprovalEvidenceV1,
  type ContentBloomsPlacementRequestV1,
  type ContentBloomsTranscriptionRouteObservationV1,
} from "../src/project-adapters/content-blooms/v1/index.ts";
import { assertNoSecretMaterial,sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const tenantId="tenant:owner",workspaceId="workspace:content-blooms",projectId="project:content-blooms:operations",adapterId="adapter:content-blooms:v1",stateId="state:content-blooms:adapter";
const t0="2026-08-29T13:00:00.000Z",t1="2026-08-29T13:01:00.000Z",t6="2026-08-29T13:06:00.000Z",t7="2026-08-29T13:07:00.000Z",t8="2026-08-29T13:08:00.000Z",t9="2026-08-29T13:09:00.000Z",t10="2026-08-29T13:10:00.000Z",t11="2026-08-29T13:11:00.000Z",t12="2026-08-29T13:12:00.000Z",t13="2026-08-29T13:13:00.000Z",t14="2026-08-29T13:14:00.000Z",t15="2026-08-29T13:15:00.000Z",t16="2026-08-29T13:16:00.000Z",t17="2026-08-29T13:17:00.000Z",t18="2026-08-29T13:18:00.000Z",t19="2026-08-29T13:19:00.000Z",t20="2026-08-29T13:20:00.000Z",routeExpiry="2026-08-30T13:06:00.000Z";
const integrityKey=new Uint8Array(32).fill(73);

function expectCode(action:()=>unknown,code:ContentBloomsContractErrorV1["safeCode"]):void{assert.throws(action,(error:unknown)=>error instanceof ContentBloomsContractErrorV1&&error.safeCode===code);}
async function expectCodeAsync(action:()=>Promise<unknown>,code:ContentBloomsContractErrorV1["safeCode"]):Promise<void>{await assert.rejects(action,(error:unknown)=>error instanceof ContentBloomsContractErrorV1&&error.safeCode===code);}

async function migratedDatabase():Promise<{raw:PGlite;db:DatabaseClient}>{
  const raw=new PGlite(),files=(await readdir(resolve("db/migrations"))).filter((file)=>file.endsWith(".sql")).sort();
  for(const file of files)await raw.exec(await readFile(resolve("db/migrations",file),"utf8"));
  await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)",[tenantId,"Synthetic owner"]);
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$3)",[workspaceId,tenantId,"Content Blooms"]);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'content-blooms','control-room-content-blooms-adapter/v1','source_scheduled','content-blooms-safe.v1',30)`,[adapterId,tenantId]);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,$4,'content-operations','42','Content Operations','ready','mixed_queue','watch','source_scheduled',$5,'{}'::jsonb)`,[projectId,tenantId,workspaceId,adapterId,t0]);
  return{raw,db:adaptPglite(raw)};
}

function release():ContentBloomsAdapterReleaseV1{return buildContentBloomsAdapterReleaseV1({releaseId:"release:content-blooms:command-r1",tenantId,workspaceId,projectId,adapterId,redactionPolicyVersion:"content-blooms-safe.v1",adapterPackageDigest:sha256Digest({package:"command-r1"}),projectionSchemaDigest:sha256Digest({schema:"command-r1"}),conformanceEvidenceDigest:sha256Digest({conformance:"command-r1"}),acceptanceProfileDigest:sha256Digest({profile:"command-r1"}),acceptedReviewDigest:sha256Digest({review:"command-r1"}),completionSnapshotDigest:sha256Digest({snapshot:"command-r1"}),producerIdentityDigest:sha256Digest({producer:"command-r1"}),reviewerIdentityDigest:sha256Digest({reviewer:"command-r1"}),acceptedAt:t0});}
function enabledState(r1:ContentBloomsAdapterReleaseV1):ContentBloomsAdapterControlStateV1{const initial=buildInitialContentBloomsControlStateV1({stateId,tenantId,workspaceId,projectId,adapterId,initializedAt:t0});const transition=buildContentBloomsControlTransitionV1({transitionId:"transition:command:enable",tenantId,workspaceId,projectId,adapterId,action:"enable_release",expectedStateDigest:initial.stateDigest,targetReleaseDigest:r1.releaseDigest,requestedByActorDigest:sha256Digest({actor:"owner"}),reasonCode:"command_test",requestedAt:t1});return applyContentBloomsControlTransitionV1({state:initial,transition,releases:[r1]}).state;}
function declaration(r1:ContentBloomsAdapterReleaseV1):ContentBloomsPlacementDeclarationV1{return buildContentBloomsPlacementDeclarationV1({declarationId:"declaration:content-blooms:command-v1",readRelease:r1,commandSchemaDigest:sha256Digest({schema:"command"}),sourceReceiptSchemaDigest:sha256Digest({schema:"receipt"}),conformanceEvidenceDigest:sha256Digest({conformance:"command"}),acceptanceProfileDigest:sha256Digest({profile:"command"}),acceptedReviewDigest:sha256Digest({review:"command"}),completionSnapshotDigest:sha256Digest({snapshot:"command"}),producerIdentityDigest:sha256Digest({producer:"command"}),reviewerIdentityDigest:sha256Digest({reviewer:"command"}),acceptedAt:t1});}
function route(platform:"macos"|"windows"|"linux",routeId:string,state:"idle"|"busy"|"offline",duration:number):ContentBloomsTranscriptionRouteObservationV1{const runtimeClass={macos:"whisper_mlx",windows:"whisper_cuda",linux:"whisper_cpu"} as const;return buildContentBloomsTranscriptionRouteObservationV1({tenantId,workspaceId,projectId,adapterId,routeId,workerRefDigest:sha256Digest({worker:routeId}),platform,runtimeClass:runtimeClass[platform],state,verification:"verified",estimatedDurationSeconds:duration,estimatedCostMilliUsd:0,qualityRank:platform==="linux"?4:5,privacyClass:"local",benchmarkVersion:"benchmark.synthetic.v1",benchmarkDigest:sha256Digest({benchmark:routeId}),observedAt:t6,validUntil:routeExpiry});}
function comparison(){const workItem=buildContentBloomsSyntheticFixtureRecordsV1().find((record)=>record.kind==="work_item"&&record.sourceRecordId==="recording-queue-1042")!;const selectedRoute=route("windows","route:windows:cuda","idle",120),vps=route("linux","route:vps:cpu","idle",900),busy=route("macos","route:mac:mlx","busy",150);const policy=buildContentBloomsRouteComparisonPolicyV1({policyId:"policy:command",maxCostMilliUsd:0,minimumQualityRank:4,allowedPrivacyClasses:["local"],allowBusy:false,durationWeight:10,costWeight:1,qualityWeight:100,privacyWeight:1000});const compared=compareContentBloomsTranscriptionRoutesV1({tenantId,workspaceId,projectId,adapterId,workItem,routes:[busy,selectedRoute,vps],policy,comparedAt:t7});return{workItem,selectedRoute,comparison:compared};}
function approvalRequest(request:ContentBloomsPlacementRequestV1):ConsequentialApprovalRequestV1{return{schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"approval-request:content-blooms:command",tenantId,projectId,jobId:request.jobId,attemptId:request.attemptId,effectIntentId:request.effectIntentId,operationDigest:request.operationDigest,risk:"medium",requestedBy:{actorId:"agent:control-room",actorType:"agent",workerId:"worker:architect"},requiredFactor:"strong",requestedAt:t9,expiresAt:t19,grantsExecutionAuthority:false};}
function approvalDecision(request:ContentBloomsPlacementRequestV1,approval:ConsequentialApprovalRequestV1):ConsequentialApprovalDecisionV1{return{schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:"approval-decision:content-blooms:command",tenantId,projectId,requestId:approval.id,requestDigest:sha256Digest(approval),operationDigest:request.operationDigest,policyDecisionId:"policy-decision:content-blooms:command",decision:"approved",decidedBy:{actorId:"identity:owner",actorType:"human"},factor:"strong",authenticationEventDigest:sha256Digest({authentication:"strong"}),decidedAt:t10,expiresAt:t18,safeReasonCode:"owner_approved_placement",grantsExecutionAuthority:false,requiresSeparateNodeAttestation:true};}

interface Setup{raw:PGlite;db:DatabaseClient;release:ContentBloomsAdapterReleaseV1;state:ContentBloomsAdapterControlStateV1;declaration:ContentBloomsPlacementDeclarationV1;request:ContentBloomsPlacementRequestV1;approvalRequest:ConsequentialApprovalRequestV1;approvalDecision:ConsequentialApprovalDecisionV1;authorization:ContentBloomsPlacementAuthorizationV1;evidence:ContentBloomsPlacementNodeApprovalEvidenceV1;syncStore:ContentBloomsSyncStoreV1;placementStore:ContentBloomsPlacementStoreV1;}

async function setup():Promise<Setup>{
  const {raw,db}=await migratedDatabase(),r1=release(),state=enabledState(r1),syncStore=new ContentBloomsSyncStoreV1(db,{tenantId,workspaceId,projectId,adapterId,stateId});
  await syncStore.initialize(r1,state);
  const readRequest=buildContentBloomsReadRequestV1({requestId:"request:command:seed-work",tenantId,workspaceId,projectId,adapterId,expectedReleaseDigest:r1.releaseDigest,operation:"listWorkItems",limit:100,requestedAt:t6});
  const read=new ContentBloomsInjectedReadAdapterV1(new ContentBloomsFixtureSourceV1()).read({request:readRequest,release:r1,controlState:state,recordedAt:t7});
  await syncStore.commitRead({page:read.page,records:read.records,nextCursor:read.nextCursor,receipt:read.receipt});
  const currentState=await syncStore.loadState(),declared=declaration(r1),compared=comparison();
  const request=buildContentBloomsPlacementRequestV1({declaration:declared,readRelease:r1,controlState:currentState,workItem:compared.workItem,routeComparison:compared.comparison,selectedRoute:compared.selectedRoute,requestId:"request:content-blooms:command",jobId:"job:content-blooms:command",attemptId:"attempt:content-blooms:command",effectIntentId:"effect:content-blooms:command",reasonCode:"transcription_capacity_preference",requestedByActorDigest:sha256Digest({actor:"owner"}),requestedAt:t8,expiresAt:t20});
  const approval=approvalRequest(request),decision=approvalDecision(request,approval),authorization=buildContentBloomsPlacementAuthorizationV1({request,approvalRequest:approval,approvalDecision:decision});
  const placementStore=new ContentBloomsPlacementStoreV1(db,{tenantId,workspaceId,projectId,adapterId},integrityKey);
  await placementStore.registerAuthorizationBundle({declaration:declared,request,authorization,approvalRequest:approval,approvalDecision:decision});
  const {privateKey,publicKey}=generateKeyPairSync("ed25519"),bodyMaterial={schema:APPROVAL_ATTESTATION_SCHEMA_V1,tenantId,nodeId:"node:synthetic-command",projectId,jobId:request.jobId,attemptId:request.attemptId,operationDigest:request.operationDigest,risk:"medium" as const,decision:"approved" as const,issuedAt:t10,expiresAt:t18,nonce:"node_approval_nonce_command_123456",approvalKeyId:"owner-key:approval:command"};
  const body={...bodyMaterial,bodyDigest:computeArtifactBodyDigest(bodyMaterial)},attestation=signArtifact(body,privateKey),spki=publicKey.export({format:"der",type:"spki"}).toString("base64url");
  const evidence=buildContentBloomsPlacementNodeApprovalEvidenceV1({request,authorization,attestation,publicKeySpki:spki,verifiedAt:t11});
  await placementStore.recordNodeAttestationEvidence(evidence);
  return{raw,db,release:r1,state:currentState,declaration:declared,request,approvalRequest:approval,approvalDecision:decision,authorization,evidence,syncStore,placementStore};
}

function dispatchInput(setupValue:Setup){return{requestId:setupValue.request.requestId,authorizationId:setupValue.authorization.authorizationId,nodeAttestationEvidenceId:setupValue.evidence.evidenceId,checkedAt:t11,claimedAt:t12,markedAt:t13,sourceObservedAt:t14,receivedAt:t15,ambiguityRaisedAt:t16};}

test("CR9A-CB-060 separately verifies and stores one exact signed node approval attestation",async()=>{
  const value=await setup();assert.equal(value.evidence.signatureVerified,true);assert.equal(value.evidence.grantsExecutionAuthority,false);assert.equal(parseContentBloomsPlacementNodeApprovalEvidenceV1(value.evidence).evidenceDigest,value.evidence.evidenceDigest);
  const replay=await value.placementStore.recordNodeAttestationEvidence(value.evidence);assert.equal(replay.replayed,true);
  const proxy=observedProxy(value.evidence,"throwing");expectCode(()=>parseContentBloomsPlacementNodeApprovalEvidenceV1(proxy.value),"invalid_input");assert.equal(proxy.trapCount(),0);
  await value.raw.close();
});

test("CR9A-CB-060 accepted fake placement is claimed, marked, settled, durable, and never redispatched",async()=>{
  const value=await setup(),source=new ContentBloomsSyntheticCommandSourceV1({sourceRecordId:value.request.workItemSourceRecordId,sourceVersion:value.request.expectedSourceVersion,eligibleRouteIds:[value.request.selectedRouteId]}),adapter=new ContentBloomsInjectedCommandAdapterV1(value.placementStore,value.syncStore,source);
  const first=await adapter.dispatch(dispatchInput(value));assert.equal(first.outcome.disposition,"accepted");assert.equal(first.sourceInvoked,true);assert.equal(first.replayed,false);assert.equal(source.callCount(),1);assert.equal(first.outcome.controlRoomMayLease,false);
  const restartedStore=new ContentBloomsPlacementStoreV1(value.db,{tenantId,workspaceId,projectId,adapterId},integrityKey),restarted=new ContentBloomsInjectedCommandAdapterV1(restartedStore,value.syncStore,source),replay=await restarted.dispatch(dispatchInput({...value,placementStore:restartedStore}));
  assert.equal(replay.outcome.receiptDigest,first.outcome.receiptDigest);assert.equal(replay.replayed,true);assert.equal(replay.sourceInvoked,false);assert.equal(source.callCount(),1);
  assert.deepEqual(await restartedStore.counts(),{declarations:1,requests:1,authorizations:1,nodeAttestations:1,claims:1,markers:1,outcomes:1,tombstones:0});
  const sealed=await restartedStore.sealTombstone({claimKey:sha256Digest({schema:"control-room.effect-identity/v1",tenantId,nodeId:value.evidence.nodeId,projectId,jobId:value.request.jobId,attemptId:value.request.attemptId,operationDigest:value.request.operationDigest}),sealedAt:t19,retainUntil:"2027-08-29T13:19:00.000Z",allRetentionHorizonsKnown:true});
  assert.equal(sealed.tombstone.prohibitsRedispatch,true);assert.equal((await restartedStore.sealTombstone({claimKey:sealed.tombstone.claimKey,sealedAt:t19,retainUntil:"2027-08-29T13:19:00.000Z",allRetentionHorizonsKnown:true})).replayed,true);
  await assert.rejects(value.raw.query("DELETE FROM control_content_blooms_placement_effect_claims WHERE tenant_id=$1 AND claim_key=$2",[tenantId,sealed.tombstone.claimKey]),/append-only/i);
  await value.raw.close();
});

test("CR9A-CB-060 source rejection and already-applied truth are terminal local outcomes",async()=>{
  const rejected=await setup(),rejectSource=new ContentBloomsSyntheticCommandSourceV1({sourceRecordId:rejected.request.workItemSourceRecordId,sourceVersion:rejected.request.expectedSourceVersion,eligibleRouteIds:[rejected.request.selectedRouteId],forcedRejection:"source_policy_denied"}),rejectAdapter=new ContentBloomsInjectedCommandAdapterV1(rejected.placementStore,rejected.syncStore,rejectSource);
  const rejection=await rejectAdapter.dispatch(dispatchInput(rejected));assert.equal(rejection.outcome.disposition,"rejected");assert.equal("safeReasonCode" in rejection.outcome&&rejection.outcome.safeReasonCode,"source_policy_denied");assert.equal((await rejectAdapter.dispatch(dispatchInput(rejected))).sourceInvoked,false);assert.equal(rejectSource.callCount(),1);await rejected.raw.close();

  const applied=await setup(),alreadySource=new ContentBloomsSyntheticCommandSourceV1({sourceRecordId:applied.request.workItemSourceRecordId,sourceVersion:applied.request.expectedSourceVersion,eligibleRouteIds:[applied.request.selectedRouteId],preApplied:{idempotencyKey:applied.request.idempotencyKey,selectedRouteId:applied.request.selectedRouteId,appliedSourceVersion:`${applied.request.expectedSourceVersion}.preference.1`}}),alreadyAdapter=new ContentBloomsInjectedCommandAdapterV1(applied.placementStore,applied.syncStore,alreadySource);
  const already=await alreadyAdapter.dispatch(dispatchInput(applied));assert.equal(already.outcome.disposition,"already_applied");assert.equal(already.outcome.preferenceRecorded,true);assert.equal(alreadySource.callCount(),1);await applied.raw.close();
});

test("CR9A-CB-060 uncertain post-marker source outcome becomes terminal ambiguity and never auto-retries",async()=>{
  const value=await setup(),source=new ContentBloomsSyntheticCommandSourceV1({sourceRecordId:value.request.workItemSourceRecordId,sourceVersion:value.request.expectedSourceVersion,eligibleRouteIds:[value.request.selectedRouteId],uncertainAfterApply:true}),adapter=new ContentBloomsInjectedCommandAdapterV1(value.placementStore,value.syncStore,source);
  const first=await adapter.dispatch(dispatchInput(value));assert.equal(first.outcome.disposition,"ambiguous");assert.equal(first.outcome.sameEffectRetryProhibited,true);assert.equal(first.outcome.requiresSourceReconciliation,true);assert.ok(source.observedApplication(value.request.idempotencyKey));
  const replay=await adapter.dispatch(dispatchInput(value));assert.equal(replay.outcome.receiptDigest,first.outcome.receiptDigest);assert.equal(replay.sourceInvoked,false);assert.equal(source.callCount(),1);await value.raw.close();
});

test("CR9A-CB-060 restart classifies an unmarked claim as re-evaluable and a marked claim as ambiguous",async()=>{
  const value=await setup(),claim=buildContentBloomsPlacementEffectClaimV1({request:value.request,authorization:value.authorization,nodeAttestationEvidence:value.evidence,claimedAt:t12});
  assert.equal((await value.placementStore.claim({request:value.request,authorization:value.authorization,nodeAttestationEvidence:value.evidence,claimedAt:t12})).disposition,"dispatch_permitted");
  assert.equal((await value.placementStore.recover(claim.claimKey,t13)).action,"safe_re_evaluate");
  const marker=buildContentBloomsPlacementPreEffectMarkerV1({claim,request:value.request,markedAt:t13});await value.placementStore.commitPreEffectMarker(marker);
  const restarted=new ContentBloomsPlacementStoreV1(value.db,{tenantId,workspaceId,projectId,adapterId},integrityKey),recovered=await restarted.recover(claim.claimKey,t16);assert.equal(recovered.action,"ambiguous");assert.ok("outcome" in recovered);assert.equal(recovered.outcome.disposition,"ambiguous");
  const again=await restarted.recover(claim.claimKey,t17);assert.equal(again.action,"replay_terminal");await value.raw.close();
});

test("CR9A-CB-060 stale read truth and forged mutable ledger state fail before another fake command",async()=>{
  const value=await setup(),staleRecord={...comparison().workItem,sourceVersion:"13"},staleSync={loadState:()=>value.syncStore.loadState(),activeRelease:()=>value.syncStore.activeRelease(),currentRecords:async()=>[staleRecord]},source=new ContentBloomsSyntheticCommandSourceV1({sourceRecordId:value.request.workItemSourceRecordId,sourceVersion:value.request.expectedSourceVersion,eligibleRouteIds:[value.request.selectedRouteId]}),adapter=new ContentBloomsInjectedCommandAdapterV1(value.placementStore,staleSync as Pick<ContentBloomsSyncStoreV1,"loadState"|"activeRelease"|"currentRecords">,source);
  await expectCodeAsync(()=>adapter.dispatch(dispatchInput(value)),"stale_state");assert.equal(source.callCount(),0);
  const normal=new ContentBloomsInjectedCommandAdapterV1(value.placementStore,value.syncStore,source),accepted=await normal.dispatch(dispatchInput(value));assert.equal(accepted.outcome.disposition,"accepted");
  await value.raw.query("UPDATE control_content_blooms_placement_effect_claims SET version=version+100 WHERE tenant_id=$1",[tenantId]);
  await expectCodeAsync(()=>normal.dispatch(dispatchInput(value)),"replay_drift");assert.equal(source.callCount(),1);await value.raw.close();
});

test("CR9A-CB-060 changed request identity cannot alias the same semantic effect",async()=>{
  const value=await setup(),{requestDigest:_digest,...requestMaterial}=value.request;void _digest;
  const changedMaterial={...requestMaterial,requestId:"request:content-blooms:changed"},changed={...changedMaterial,requestDigest:sha256Digest(changedMaterial)};
  const approval={...approvalRequest(changed),id:"approval-request:content-blooms:changed"},decision={...approvalDecision(changed,approval),id:"approval-decision:content-blooms:changed"},authorization=buildContentBloomsPlacementAuthorizationV1({request:changed,approvalRequest:approval,approvalDecision:decision});
  await expectCodeAsync(()=>value.placementStore.registerAuthorizationBundle({declaration:value.declaration,request:changed,authorization,approvalRequest:approval,approvalDecision:decision}),"replay_drift");
  await value.raw.close();
});

test("CR9A-CB-070 builds independently reviewed research, transcription, and article packages with no authority",async()=>{
  const value=await setup(),pack=buildContentBloomsProjectPackV1({release:value.release,placementDeclaration:value.declaration,producerId:"agent:content-pack-author",reviewerId:"agent:content-pack-reviewer",sourceDigest:sha256Digest({source:"cb070"}),reviewEvidenceDigest:sha256Digest({review:"cb070"}),createdAt:t11,reviewedAt:t12});
  assert.deepEqual(pack.stages,["research","transcription","article"]);assert.equal(pack.allowsPublishing,false);assert.equal(pack.grantsCommandAuthority,false);assert.equal(parseContentBloomsProjectPackV1(pack).packDigest,pack.packDigest);assertNoSecretMaterial(pack,"CB-070 pack");
  assert.match(pack.procedure.content.steps.map((step)=>step.instruction).join(" "),/never automatically retried|Stop on.*ambiguity/i);assert.match(pack.knowledge.content.facts.map((fact)=>fact.value).join(" "),/source reconciliation/i);
  const projection=buildContentBloomsProjectPackProjectionV1({pack,records:buildContentBloomsSyntheticFixtureRecordsV1(),observedAt:t13});assert.deepEqual(projection.items.map((item)=>item.stage),["research","transcription","article"]);assert.equal(projection.canDispatch,false);assert.equal(parseContentBloomsProjectPackProjectionV1(projection).projectionDigest,projection.projectionDigest);
  const registry=new PackageRegistryStoreV1(value.db,new Uint8Array(32).fill(31));const procedure=await registry.register(pack.procedure),knowledge=await registry.register(pack.knowledge);assert.equal(procedure.replayed,false);assert.equal(knowledge.replayed,false);assert.equal((await registry.review(pack.procedureReview)).review.decision,"accepted");assert.equal((await registry.review(pack.knowledgeReview)).review.decision,"accepted");
  expectCode(()=>buildContentBloomsProjectPackV1({release:value.release,placementDeclaration:value.declaration,producerId:"agent:same",reviewerId:"agent:same",sourceDigest:sha256Digest({source:"bad"}),reviewEvidenceDigest:sha256Digest({review:"bad"}),createdAt:t11,reviewedAt:t12}),"invalid_input");
  await value.raw.close();
});
