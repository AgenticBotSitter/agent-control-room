import { timingSafeEqual } from "node:crypto";
import { effectIntentRecordSchema, jobRecordSchema, type EffectIntentRecord, type JobRecord } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { databaseOperationSignal } from "../../persistence/operation-signal";
import { assertNoSecretMaterial, computeAuthorityDigest, computeEffectOperationDigest, hmacSha256Tag, sha256Digest } from "../../security";
import { ROLLBACK_CHECKPOINT_SCHEMA_V1, rollbackCheckpointDigestV1, type AwaitableRollbackCheckpointStoreV1, type RollbackCheckpointV1 } from "../../security/rollback-checkpoint";
import {
  completionAcceptanceProfileSchemaV1,
  completionFindingSchemaV1,
  completionPreferenceSchemaV1,
  completionReviewSchemaV1,
  completionReviewTargetSchemaV1,
  completionRevisionSchemaV1,
  completionVerificationSchemaV1,
  consequentialApprovalDecisionSchemaV1,
  consequentialApprovalRequestSchemaV1,
} from "./schemas";
import type {
  CompletionAcceptanceProfileV1,
  CompletionFindingV1,
  CompletionGateRecordV1,
  CompletionGateSnapshotV1,
  CompletionPreferenceV1,
  CompletionPrincipalV1,
  CompletionReviewTargetV1,
  CompletionReviewV1,
  CompletionRevisionV1,
  CompletionRiskV1,
  CompletionVerificationV1,
  ConsequentialApprovalDecisionV1,
  ConsequentialApprovalRequestV1,
} from "./types";

export type CompletionGateRecordKindV1="profile"|"target"|"review"|"verification"|"finding"|"revision"|"preference"|"approval_request"|"approval_decision";
export type CompletionGateSafeCodeV1="invalid_record"|"record_conflict"|"record_not_found"|"scope_mismatch"|"profile_mismatch"|
  "reviewer_not_independent"|"risk_floor_mismatch"|"verification_scenario_invalid"|"target_superseded"|"revision_invalid"|"approval_binding_invalid"|"integrity_failed";

export class CompletionGateErrorV1 extends Error {
  constructor(readonly safeCode:CompletionGateSafeCodeV1){super(safeCode);this.name="CompletionGateErrorV1";}
}

interface CompletionRow {
  id:string;tenant_id:string;project_id:string;kind:CompletionGateRecordKindV1;record_key:string;subject_id:string;parent_id:string|null;
  record_digest:string;record_auth_tag:string;payload:CompletionGateRecordV1;occurred_at:string|Date;
}
interface ApprovalPolicyRow {
  identity_id:string;action:string;resource_type:string;resource_id:string;project_id:string|null;risk:CompletionRiskV1;
  external_effect:boolean;allowed:boolean;grant_ids:string[];strong_factor_evidence_id:string|null;request_digest:string;
  decided_at:string|Date;expires_at:string|Date;actor_type:string;identity_state:string;
}
interface ApprovalGrantRow {
  id:string;role_key:string;allowed_actions:string[];project_ids:string[];risk_ceiling:CompletionRiskV1;allow_external_effects:boolean;
  expires_at:string|Date|null;revoked_at:string|Date|null;
}
interface CompletionIntegrityRow {tenant_id:string;revision:number;record_count:number;state_digest:string;state_auth_tag:string;}
type QuerySource=Pick<DatabaseClient,"query">|DatabaseSession;
const columns="id,tenant_id,project_id,kind,record_key,subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at";
const riskOrder:CompletionRiskV1[]=["low","medium","high","critical"];

function iso(value:string|Date):string{return new Date(value).toISOString();}
function parse<T>(schema:{parse(value:unknown):T},input:unknown):T{try{return schema.parse(input);}catch{throw new CompletionGateErrorV1("invalid_record");}}
function safe(input:unknown):void{try{assertNoSecretMaterial(input,"completion gate record");}catch{throw new CompletionGateErrorV1("invalid_record");}}
function exactSorted(left:string[],right:string[]):boolean{return left.join("|")===right.join("|");}
function sameTag(left:string,right:string):boolean{const a=Buffer.from(left,"utf8");const b=Buffer.from(right,"utf8");return a.length===b.length&&timingSafeEqual(a,b);}

function describe(kind:CompletionGateRecordKindV1,record:CompletionGateRecordV1):{recordKey:string;subjectId:string;parentId:string|null;occurredAt:string}{
  switch(kind){
    case "profile":{const value=record as CompletionAcceptanceProfileV1;return{recordKey:value.id,subjectId:value.id,parentId:null,occurredAt:value.createdAt};}
    case "target":{const value=record as CompletionReviewTargetV1;return{recordKey:sha256Digest({kind,subjectId:value.subjectId,revisionNumber:value.revisionNumber}),subjectId:value.subjectId,parentId:value.acceptanceProfileId,occurredAt:value.submittedAt};}
    case "review":{const value=record as CompletionReviewV1;return{recordKey:sha256Digest({kind,targetId:value.targetId,authority:value.authority,reviewerActorId:value.reviewer.actorId}),subjectId:value.targetId,parentId:value.targetId,occurredAt:value.reviewedAt};}
    case "verification":{const value=record as CompletionVerificationV1;return{recordKey:sha256Digest({kind,targetId:value.targetId,scenarioId:value.scenarioId}),subjectId:value.targetId,parentId:value.targetId,occurredAt:value.verifiedAt};}
    case "finding":{const value=record as CompletionFindingV1;return{recordKey:value.id,subjectId:value.targetId,parentId:value.reviewId,occurredAt:value.raisedAt};}
    case "revision":{const value=record as CompletionRevisionV1;return{recordKey:value.fromTargetId,subjectId:value.rootTargetId,parentId:value.fromTargetId,occurredAt:value.revisedAt};}
    case "preference":{const value=record as CompletionPreferenceV1;return{recordKey:value.id,subjectId:value.subjectId,parentId:null,occurredAt:value.selectedAt};}
    case "approval_request":{const value=record as ConsequentialApprovalRequestV1;return{recordKey:value.effectIntentId,subjectId:value.effectIntentId,parentId:value.effectIntentId,occurredAt:value.requestedAt};}
    case "approval_decision":{const value=record as ConsequentialApprovalDecisionV1;return{recordKey:value.requestId,subjectId:value.requestId,parentId:value.requestId,occurredAt:value.decidedAt};}
  }
}

function schemaFor(kind:CompletionGateRecordKindV1){
  switch(kind){
    case "profile":return completionAcceptanceProfileSchemaV1;case "target":return completionReviewTargetSchemaV1;
    case "review":return completionReviewSchemaV1;case "verification":return completionVerificationSchemaV1;
    case "finding":return completionFindingSchemaV1;case "revision":return completionRevisionSchemaV1;
    case "preference":return completionPreferenceSchemaV1;case "approval_request":return consequentialApprovalRequestSchemaV1;
    case "approval_decision":return consequentialApprovalDecisionSchemaV1;
  }
}

function rowAuthMaterial(row:Omit<CompletionRow,"record_auth_tag"|"payload">):Record<string,unknown>{
  return{id:row.id,tenantId:row.tenant_id,projectId:row.project_id,kind:row.kind,recordKey:row.record_key,subjectId:row.subject_id,
    parentId:row.parent_id,recordDigest:row.record_digest,occurredAt:iso(row.occurred_at)};
}

function recordIdentity(record:CompletionGateRecordV1):{id:string;tenantId:string;projectId:string}{
  return record as {id:string;tenantId:string;projectId:string};
}

export class CompletionGateStoreV1 {
  private async checkpointOperation<T>(work: (signal?: AbortSignal) => T | Promise<T>): Promise<T> {
    const signal = databaseOperationSignal();
    try {
      if (signal?.aborted) throw new Error();
      const result = await work(signal);
      if (signal?.aborted) throw new Error();
      return result;
    } catch { throw new CompletionGateErrorV1("integrity_failed"); }
  }
  private readonly integrityKey:Uint8Array;
  private readonly checkpointRead:AwaitableRollbackCheckpointStoreV1["read"];private readonly checkpointInitialize:AwaitableRollbackCheckpointStoreV1["initialize"];private readonly checkpointAdvance:AwaitableRollbackCheckpointStoreV1["advance"];
  constructor(private readonly db:DatabaseClient,integrityKey:Uint8Array,checkpointStore:AwaitableRollbackCheckpointStoreV1,private readonly clock:()=>string=()=>new Date().toISOString()){
    try{hmacSha256Tag(integrityKey,{purpose:"completion-gate-key-check"});this.integrityKey=new Uint8Array(integrityKey);this.checkpointRead=checkpointStore.read.bind(checkpointStore);this.checkpointInitialize=checkpointStore.initialize.bind(checkpointStore);this.checkpointAdvance=checkpointStore.advance.bind(checkpointStore);}catch{throw new CompletionGateErrorV1("integrity_failed");}
  }

  async provisionTenant(tenantId:string):Promise<void>{
    await this.db.transaction(async(tx)=>{const tenant=await tx.query<{id:string}>("SELECT id FROM tenants WHERE id=$1 FOR UPDATE",[tenantId]);if(!tenant.rows[0])throw new CompletionGateErrorV1("scope_mismatch");
      const existing=await tx.query<CompletionIntegrityRow>("SELECT * FROM control_completion_gate_integrity WHERE tenant_id=$1 FOR UPDATE",[tenantId]);const computed=await this.computedTenantState(tx,tenantId);
      if(existing.rows[0]||computed.recordCount!==0||await this.readCheckpoint(tenantId))throw new CompletionGateErrorV1("integrity_failed");
      const revision=1,stateAuthTag=this.tenantStateTag(tenantId,revision,computed.recordCount,computed.stateDigest),checkpoint=this.checkpoint(tenantId,revision,computed.recordCount,computed.stateDigest,stateAuthTag);
      await tx.query(`INSERT INTO control_completion_gate_integrity(tenant_id,revision,record_count,state_digest,state_auth_tag) VALUES($1,$2,$3,$4,$5)`,[tenantId,revision,computed.recordCount,computed.stateDigest,stateAuthTag]);
      try{await this.checkpointOperation(signal => this.checkpointInitialize(checkpoint, signal));}catch{throw new CompletionGateErrorV1("integrity_failed");}});
  }

  async registerProfile(input:unknown):Promise<{profile:CompletionAcceptanceProfileV1;replayed:boolean}>{
    const profile=parse(completionAcceptanceProfileSchemaV1,input) as CompletionAcceptanceProfileV1;safe(profile);
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,profile.tenantId);await this.requireProject(tx,profile.tenantId,profile.projectId);const result=await this.insert(tx,"profile",profile);
      return{profile:result.record as CompletionAcceptanceProfileV1,replayed:result.replayed};});
  }

  async registerTarget(input:unknown):Promise<{target:CompletionReviewTargetV1;replayed:boolean}>{
    const target=parse(completionReviewTargetSchemaV1,input) as CompletionReviewTargetV1;safe(target);
    if(target.revisionNumber!==0)throw new CompletionGateErrorV1("revision_invalid");
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,target.tenantId);const profile=await this.requireProfile(tx,target.tenantId,target.acceptanceProfileId);
      this.assertTargetProfile(target,profile);const result=await this.insert(tx,"target",target);return{target:result.record as CompletionReviewTargetV1,replayed:result.replayed};});
  }

  async recordReview(input:unknown,findingInputs:unknown[]=[]):Promise<{review:CompletionReviewV1;findings:CompletionFindingV1[];replayed:boolean}>{
    const review=parse(completionReviewSchemaV1,input) as CompletionReviewV1;const findings=findingInputs.map((value)=>parse(completionFindingSchemaV1,value) as CompletionFindingV1);
    safe(review);safe(findings);if(!exactSorted(review.findingIds,[...findings.map((finding)=>finding.id)].sort()))throw new CompletionGateErrorV1("invalid_record");
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,review.tenantId);const target=await this.requireTarget(tx,review.tenantId,review.targetId,true);const profile=await this.requireProfile(tx,review.tenantId,target.acceptanceProfileId);
      this.assertReviewBindings(review,target,profile);if(review.authority==="completion_gate")this.assertIndependent(target.producer,review.reviewer,profile);
      const expectedRisk=riskOrder[Math.max(riskOrder.indexOf(profile.minimumRisk),riskOrder.indexOf(review.assessedRisk))];
      if(review.effectiveRisk!==expectedRisk)throw new CompletionGateErrorV1("risk_floor_mismatch");
      for(const finding of findings){if(finding.tenantId!==review.tenantId||finding.projectId!==review.projectId||finding.targetId!==review.targetId
          ||finding.targetDigest!==review.targetDigest||finding.reviewId!==review.id||Date.parse(finding.raisedAt)<Date.parse(review.reviewedAt))throw new CompletionGateErrorV1("invalid_record");}
      const replay=await this.findExisting(tx,"review",review);if(replay){const replayedFindings:CompletionFindingV1[]=[];
        for(const finding of findings){const result=await this.insert(tx,"finding",finding);if(!result.replayed)throw new CompletionGateErrorV1("integrity_failed");replayedFindings.push(result.record as CompletionFindingV1);}
        return{review:replay.record as CompletionReviewV1,findings:replayedFindings,replayed:true};}
      if((await this.listByParent(tx,target.tenantId,target.projectId,"revision",target.id)).length)throw new CompletionGateErrorV1("target_superseded");
      const existingFindings=await this.listBySubject(tx,review.tenantId,review.projectId,"finding",review.targetId);
      if(review.decision==="accepted"&&existingFindings.length>0)throw new CompletionGateErrorV1("invalid_record");
      if(review.authority==="completion_gate"){const existingReviews=await this.listByParent(tx,review.tenantId,review.projectId,"review",review.targetId) as CompletionReviewV1[];
        for(const existing of existingReviews.filter((item)=>item.authority==="completion_gate"))this.assertIndependent(existing.reviewer,review.reviewer,profile);}
      const stored=await this.insert(tx,"review",review);let replayed=stored.replayed;
      const storedFindings:CompletionFindingV1[]=[];for(const finding of findings){const result=await this.insert(tx,"finding",finding);replayed=replayed&&result.replayed;storedFindings.push(result.record as CompletionFindingV1);}
      return{review:stored.record as CompletionReviewV1,findings:storedFindings,replayed};});
  }

  async recordVerification(input:unknown):Promise<{verification:CompletionVerificationV1;replayed:boolean}>{
    const verification=parse(completionVerificationSchemaV1,input) as CompletionVerificationV1;safe(verification);
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,verification.tenantId);const target=await this.requireTarget(tx,verification.tenantId,verification.targetId,true);const profile=await this.requireProfile(tx,verification.tenantId,target.acceptanceProfileId);
      if(verification.tenantId!==target.tenantId||verification.projectId!==target.projectId||verification.targetDigest!==sha256Digest(target)
        ||verification.acceptanceProfileId!==profile.id||verification.acceptanceProfileDigest!==sha256Digest(profile))throw new CompletionGateErrorV1("profile_mismatch");
      if(!profile.requiredVerificationScenarioIds.includes(verification.scenarioId))throw new CompletionGateErrorV1("verification_scenario_invalid");
      if(profile.verificationRequiresProducerSeparation&&verification.verifier.actorId===target.producer.actorId)throw new CompletionGateErrorV1("reviewer_not_independent");
      if(Date.parse(verification.verifiedAt)<Date.parse(target.submittedAt))throw new CompletionGateErrorV1("invalid_record");
      const replay=await this.findExisting(tx,"verification",verification);if(replay)return{verification:replay.record as CompletionVerificationV1,replayed:true};
      if((await this.listByParent(tx,target.tenantId,target.projectId,"revision",target.id)).length)throw new CompletionGateErrorV1("target_superseded");
      const result=await this.insert(tx,"verification",verification);return{verification:result.record as CompletionVerificationV1,replayed:result.replayed};});
  }

  async recordRevision(revisionInput:unknown,targetInput:unknown):Promise<{revision:CompletionRevisionV1;target:CompletionReviewTargetV1;replayed:boolean}>{
    const revision=parse(completionRevisionSchemaV1,revisionInput) as CompletionRevisionV1;const next=parse(completionReviewTargetSchemaV1,targetInput) as CompletionReviewTargetV1;
    safe(revision);safe(next);
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,revision.tenantId);const prior=await this.requireTarget(tx,revision.tenantId,revision.fromTargetId,true);const profile=await this.requireProfile(tx,revision.tenantId,prior.acceptanceProfileId);
      if(revision.tenantId!==prior.tenantId||revision.projectId!==prior.projectId||revision.rootTargetId!==prior.rootTargetId
        ||revision.fromTargetDigest!==sha256Digest(prior)||revision.toTargetId!==next.id||revision.toTargetDigest!==sha256Digest(next)
        ||revision.revisionNumber!==prior.revisionNumber+1||next.revisionNumber!==revision.revisionNumber||next.rootTargetId!==prior.rootTargetId
        ||next.supersedesTargetId!==prior.id||next.subjectId!==prior.subjectId||next.kind!==prior.kind||next.acceptanceProfileId!==prior.acceptanceProfileId
        ||next.acceptanceProfileDigest!==prior.acceptanceProfileDigest||next.tenantId!==prior.tenantId||next.projectId!==prior.projectId
        ||sha256Digest(next.producer)!==sha256Digest(revision.revisedBy)||next.submittedAt!==revision.revisedAt||next.subjectDigest===prior.subjectDigest
        ||revision.revisionNumber>profile.maximumRevisionRounds)throw new CompletionGateErrorV1("revision_invalid");
      const replay=await this.findExisting(tx,"revision",revision);if(replay){const replayTarget=await this.findExisting(tx,"target",next);
        if(!replayTarget)throw new CompletionGateErrorV1("integrity_failed");return{revision:replay.record as CompletionRevisionV1,target:replayTarget.record as CompletionReviewTargetV1,replayed:true};}
      if(await this.findExisting(tx,"target",next))throw new CompletionGateErrorV1("integrity_failed");
      const existingRevision=await this.listByParent(tx,prior.tenantId,prior.projectId,"revision",prior.id);if(existingRevision.length)throw new CompletionGateErrorV1("revision_invalid");
      const findingRows=await this.listBySubject(tx,prior.tenantId,prior.projectId,"finding",prior.id);const findingIds=findingRows.map((row)=>(row as CompletionFindingV1).id).sort();
      const latestFinding=Math.max(...findingRows.map((row)=>Date.parse((row as CompletionFindingV1).raisedAt)));
      if(!findingIds.length||!exactSorted(revision.resolvedFindingIds,findingIds)||Date.parse(revision.revisedAt)<latestFinding)throw new CompletionGateErrorV1("revision_invalid");
      const targetResult=await this.insert(tx,"target",next);const revisionResult=await this.insert(tx,"revision",revision);
      return{target:targetResult.record as CompletionReviewTargetV1,revision:revisionResult.record as CompletionRevisionV1,replayed:targetResult.replayed&&revisionResult.replayed};});
  }

  async recordPreference(input:unknown):Promise<{preference:CompletionPreferenceV1;replayed:boolean}>{
    const preference=parse(completionPreferenceSchemaV1,input) as CompletionPreferenceV1;safe(preference);
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,preference.tenantId);await this.requireProject(tx,preference.tenantId,preference.projectId);const result=await this.insert(tx,"preference",preference);
      return{preference:result.record as CompletionPreferenceV1,replayed:result.replayed};});
  }

  async requestApproval(input:unknown):Promise<{request:ConsequentialApprovalRequestV1;replayed:boolean}>{
    const request=parse(consequentialApprovalRequestSchemaV1,input) as ConsequentialApprovalRequestV1;safe(request);
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,request.tenantId);const replay=await this.findExisting(tx,"approval_request",request);if(replay)return{request:replay.record as ConsequentialApprovalRequestV1,replayed:true};
      const now=this.currentTime();if(Date.parse(now)<Date.parse(request.requestedAt)||Date.parse(now)>=Date.parse(request.expiresAt))throw new CompletionGateErrorV1("approval_binding_invalid");
      await this.requireApprovableEffect(tx,request);
      const stored=await this.insert(tx,"approval_request",request);return{request:stored.record as ConsequentialApprovalRequestV1,replayed:stored.replayed};});
  }

  async decideApproval(input:unknown):Promise<{decision:ConsequentialApprovalDecisionV1;replayed:boolean}>{
    const decision=parse(consequentialApprovalDecisionSchemaV1,input) as ConsequentialApprovalDecisionV1;safe(decision);
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,decision.tenantId);const request=await this.requireRecord(tx,decision.tenantId,decision.requestId,"approval_request") as ConsequentialApprovalRequestV1;
      const replay=await this.findExisting(tx,"approval_decision",decision);if(replay)return{decision:replay.record as ConsequentialApprovalDecisionV1,replayed:true};
      if(decision.projectId!==request.projectId||decision.requestDigest!==sha256Digest(request)||decision.operationDigest!==request.operationDigest
        ||Date.parse(decision.decidedAt)<Date.parse(request.requestedAt)||Date.parse(decision.decidedAt)>=Date.parse(request.expiresAt)
        ||Date.parse(decision.expiresAt)>Date.parse(request.expiresAt))throw new CompletionGateErrorV1("approval_binding_invalid");
      const now=this.currentTime();if(Date.parse(now)<Date.parse(decision.decidedAt)||Date.parse(now)>=Date.parse(decision.expiresAt)||Date.parse(now)>=Date.parse(request.expiresAt))throw new CompletionGateErrorV1("approval_binding_invalid");
      await this.requireApprovableEffect(tx,request);
      await this.requireStrongFactorDecision(tx,request,decision,now);
      const stored=await this.insert(tx,"approval_decision",decision);return{decision:stored.record as ConsequentialApprovalDecisionV1,replayed:stored.replayed};});
  }

  async snapshot(tenantId:string,targetId:string):Promise<CompletionGateSnapshotV1>{
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,tenantId);
      return this.snapshotWith(tx,tenantId,await this.requireTarget(tx,tenantId,targetId));});
  }

  /** One checkpoint-verified read, serialized with writers. No checkpoint initialization or advancement. */
  async inspectSubject(tenantId:string,projectId:string,subjectId:string){
    return this.db.transaction(async(tx)=>{
      await this.lockAndVerifyTenantState(tx,tenantId);
      const rows=(await tx.query<CompletionRow>(`SELECT ${columns} FROM control_completion_gate_records
        WHERE tenant_id=$1 AND project_id=$2 AND kind='target' AND subject_id=$3 ORDER BY occurred_at DESC,id DESC LIMIT 21`,
      [tenantId,projectId,subjectId])).rows;
      const targets=[];
      for(const row of rows.slice(0,20)){
        const target=this.verifiedRow(row) as CompletionReviewTargetV1;
        const snapshot=await this.snapshotWith(tx,tenantId,target);
        const reviews=await this.listByParent(tx,tenantId,projectId,"review",target.id) as CompletionReviewV1[];
        const verifications=await this.listByParent(tx,tenantId,projectId,"verification",target.id) as CompletionVerificationV1[];
        const findings=await this.listBySubject(tx,tenantId,projectId,"finding",target.id) as CompletionFindingV1[];
        targets.push({snapshot,reviews:reviews.slice(-50),verifications:verifications.slice(-50),findings:findings.slice(-100),
          additionalEvidenceOmitted:reviews.length>50||verifications.length>50||findings.length>100});
      }
      return{targets,additionalTargetsOmitted:rows.length>20};
    });
  }

  private async snapshotWith(tx:DatabaseSession,tenantId:string,target:CompletionReviewTargetV1):Promise<CompletionGateSnapshotV1>{
    const profile=await this.requireProfile(tx,tenantId,target.acceptanceProfileId);
    const reviews=(await this.listByParent(tx,tenantId,target.projectId,"review",target.id)) as CompletionReviewV1[];
    const verifications=(await this.listByParent(tx,tenantId,target.projectId,"verification",target.id)) as CompletionVerificationV1[];
    const findings=(await this.listBySubject(tx,tenantId,target.projectId,"finding",target.id)) as CompletionFindingV1[];
    const revisions=(await this.listByParent(tx,tenantId,target.projectId,"revision",target.id)) as CompletionRevisionV1[];
    const accepted=[...new Set(reviews.filter((review)=>review.authority==="completion_gate"&&review.decision==="accepted").map((review)=>review.id))].sort();
    const passed=new Set(verifications.filter((verification)=>verification.outcome==="passed").map((verification)=>verification.scenarioId));
    const missing=profile.requiredVerificationScenarioIds.filter((scenario)=>!passed.has(scenario));
    const blocked=verifications.some((verification)=>profile.requiredVerificationScenarioIds.includes(verification.scenarioId)&&verification.outcome!=="passed");
    const openFindings=findings.map((finding)=>finding.id).sort();let status:CompletionGateSnapshotV1["status"]="pending";
    if(revisions.length)status="superseded";else if(openFindings.length&&target.revisionNumber>=profile.maximumRevisionRounds)status="revision_limit_reached";
    else if(openFindings.length)status="changes_requested";else if(blocked)status="verification_blocked";
    else if(missing.length===0&&accepted.length>=profile.minimumIndependentReviews)status="ready";
    return{target,targetDigest:sha256Digest(target),status,acceptedReviewIds:accepted,missingVerificationScenarioIds:missing,
      openFindingIds:openFindings,revisionNumber:target.revisionNumber,requiresSeparateApproval:true,grantsApproval:false,grantsExecutionAuthority:false};
  }

  async getRecord(tenantId:string,id:string,kind:CompletionGateRecordKindV1):Promise<CompletionGateRecordV1|undefined>{
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,tenantId);const result=await tx.query<CompletionRow>(`SELECT ${columns} FROM control_completion_gate_records WHERE tenant_id=$1 AND id=$2 AND kind=$3`,[tenantId,id,kind]);
    return result.rows[0]?this.verifiedRow(result.rows[0]):undefined;});
  }

  private async insert(source:DatabaseSession,kind:CompletionGateRecordKindV1,record:CompletionGateRecordV1):Promise<{record:CompletionGateRecordV1;replayed:boolean}>{
    const identity=recordIdentity(record);const metadata=describe(kind,record);const digest=sha256Digest(record);const existing=await this.findExisting(source,kind,record);
    if(existing)return existing;
    const material={id:identity.id,tenant_id:identity.tenantId,project_id:identity.projectId,kind,record_key:metadata.recordKey,subject_id:metadata.subjectId,
      parent_id:metadata.parentId,record_digest:digest,occurred_at:metadata.occurredAt};const auth=hmacSha256Tag(this.integrityKey,rowAuthMaterial(material));
    const inserted=await source.query<{id:string}>(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT DO NOTHING RETURNING id`,[identity.id,identity.tenantId,identity.projectId,kind,metadata.recordKey,metadata.subjectId,metadata.parentId,digest,auth,JSON.stringify(record),metadata.occurredAt]);
    if(inserted.rows[0]){await this.refreshTenantState(source,identity.tenantId);return{record,replayed:false};}const raced=await this.findExisting(source,kind,record);if(!raced)throw new CompletionGateErrorV1("integrity_failed");return raced;
  }

  private async findExisting(source:QuerySource,kind:CompletionGateRecordKindV1,record:CompletionGateRecordV1):Promise<{record:CompletionGateRecordV1;replayed:true}|undefined>{
    const identity=recordIdentity(record);const metadata=describe(kind,record);const digest=sha256Digest(record);
    const existing=await source.query<CompletionRow>(`SELECT ${columns} FROM control_completion_gate_records WHERE tenant_id=$1 AND (id=$2 OR (kind=$3 AND record_key=$4)) FOR UPDATE`,
      [identity.tenantId,identity.id,kind,metadata.recordKey]);
    if(!existing.rows[0])return undefined;const verified=this.verifiedRow(existing.rows[0]);
    if(existing.rows[0].kind!==kind||existing.rows[0].record_digest!==digest)throw new CompletionGateErrorV1("record_conflict");return{record:verified,replayed:true};
  }

  private verifiedRow(row:CompletionRow):CompletionGateRecordV1{
    let record:CompletionGateRecordV1;try{record=schemaFor(row.kind).parse(row.payload) as CompletionGateRecordV1;}catch{throw new CompletionGateErrorV1("integrity_failed");}
    const identity=recordIdentity(record);const metadata=describe(row.kind,record);
    if(identity.id!==row.id||identity.tenantId!==row.tenant_id||identity.projectId!==row.project_id||metadata.recordKey!==row.record_key
      ||metadata.subjectId!==row.subject_id||metadata.parentId!==row.parent_id||metadata.occurredAt!==iso(row.occurred_at)
      ||sha256Digest(record)!==row.record_digest||!sameTag(hmacSha256Tag(this.integrityKey,rowAuthMaterial(row)),row.record_auth_tag))throw new CompletionGateErrorV1("integrity_failed");
    safe(record);return record;
  }

  private async requireRecord(source:QuerySource,tenantId:string,id:string,kind:CompletionGateRecordKindV1,forUpdate=false):Promise<CompletionGateRecordV1>{
    const result=await source.query<CompletionRow>(`SELECT ${columns} FROM control_completion_gate_records WHERE tenant_id=$1 AND id=$2 AND kind=$3${forUpdate?" FOR UPDATE":""}`,[tenantId,id,kind]);
    if(!result.rows[0])throw new CompletionGateErrorV1("record_not_found");return this.verifiedRow(result.rows[0]);
  }
  private requireProfile(source:QuerySource,tenantId:string,id:string):Promise<CompletionAcceptanceProfileV1>{return this.requireRecord(source,tenantId,id,"profile") as Promise<CompletionAcceptanceProfileV1>;}
  private requireTarget(source:QuerySource,tenantId:string,id:string,forUpdate=false):Promise<CompletionReviewTargetV1>{return this.requireRecord(source,tenantId,id,"target",forUpdate) as Promise<CompletionReviewTargetV1>;}
  private async listByParent(source:QuerySource,tenantId:string,projectId:string,kind:CompletionGateRecordKindV1,parentId:string):Promise<CompletionGateRecordV1[]>{
    const result=await source.query<CompletionRow>(`SELECT ${columns} FROM control_completion_gate_records WHERE tenant_id=$1 AND project_id=$2 AND kind=$3 AND parent_id=$4 ORDER BY occurred_at,id`,[tenantId,projectId,kind,parentId]);
    return result.rows.map((row)=>this.verifiedRow(row));
  }
  private async listBySubject(source:QuerySource,tenantId:string,projectId:string,kind:CompletionGateRecordKindV1,subjectId:string):Promise<CompletionGateRecordV1[]>{
    const result=await source.query<CompletionRow>(`SELECT ${columns} FROM control_completion_gate_records WHERE tenant_id=$1 AND project_id=$2 AND kind=$3 AND subject_id=$4 ORDER BY occurred_at,id`,[tenantId,projectId,kind,subjectId]);
    return result.rows.map((row)=>this.verifiedRow(row));
  }
  private async requireProject(source:QuerySource,tenantId:string,projectId:string):Promise<void>{const result=await source.query<{id:string}>(`SELECT id FROM projects WHERE tenant_id=$1 AND id=$2`,[tenantId,projectId]);if(!result.rows[0])throw new CompletionGateErrorV1("scope_mismatch");}
  private async requireApprovableEffect(source:QuerySource,request:ConsequentialApprovalRequestV1):Promise<void>{
    const result=await source.query<{effect_payload:EffectIntentRecord;job_payload:JobRecord}>(`SELECT e.payload AS effect_payload,j.payload AS job_payload
      FROM control_effect_intents e JOIN control_jobs j ON j.tenant_id=e.tenant_id AND j.id=e.job_id
      WHERE e.tenant_id=$1 AND e.id=$2 FOR UPDATE OF e,j`,[request.tenantId,request.effectIntentId]);
    let effect:EffectIntentRecord;let job:JobRecord;try{effect=effectIntentRecordSchema.parse(result.rows[0]?.effect_payload) as EffectIntentRecord;job=jobRecordSchema.parse(result.rows[0]?.job_payload) as JobRecord;}catch{throw new CompletionGateErrorV1("approval_binding_invalid");}
    if(job.tenantId!==request.tenantId||effect.tenantId!==request.tenantId||job.projectId!==request.projectId||effect.jobId!==request.jobId
      ||effect.attemptId!==request.attemptId||effect.operationDigest!==request.operationDigest||effect.operationDigest!==computeEffectOperationDigest(effect,job.projectId)
      ||job.authority.digest!==computeAuthorityDigest(job.authority)||job.authority.effectPolicy!=="approval_required"||!job.authority.allowedOperations.includes(effect.operation)
      ||riskOrder.indexOf(effect.risk)>riskOrder.indexOf(job.authority.maxRisk)||effect.risk!==request.risk||effect.state!=="proposed"||effect.approvalId!==undefined
      ||!["leased","running","waiting_approval"].includes(job.state)||Date.parse(request.requestedAt)<Date.parse(effect.createdAt)
      ||Date.parse(request.requestedAt)>=Date.parse(job.authority.expiresAt)||Date.parse(request.expiresAt)>Date.parse(job.authority.expiresAt))throw new CompletionGateErrorV1("approval_binding_invalid");
  }
  private async requireStrongFactorDecision(source:QuerySource,request:ConsequentialApprovalRequestV1,decision:ConsequentialApprovalDecisionV1,now:string):Promise<void>{
    const result=await source.query<ApprovalPolicyRow>(`SELECT d.identity_id,d.action,d.resource_type,d.resource_id,d.project_id,d.risk,d.external_effect,d.allowed,
      d.grant_ids,d.strong_factor_evidence_id,d.request_digest,d.decided_at,d.expires_at,i.actor_type,i.state AS identity_state
      FROM control_policy_decisions d JOIN control_identities i ON i.tenant_id=d.tenant_id AND i.id=d.identity_id
      WHERE d.tenant_id=$1 AND d.id=$2 FOR UPDATE OF d,i`,[decision.tenantId,decision.policyDecisionId]);const policy=result.rows[0];
    const authorizationRequest={tenantId:decision.tenantId,action:"approval.decide",resourceType:"effect_intent",resourceId:request.effectIntentId,
      projectId:request.projectId,risk:request.risk,externalEffect:true,occurredAt:decision.decidedAt};
    if(!policy||!policy.allowed||policy.identity_state!=="active"||policy.actor_type!=="human"||policy.identity_id!==decision.decidedBy.actorId
      ||policy.action!==authorizationRequest.action||policy.resource_type!==authorizationRequest.resourceType||policy.resource_id!==authorizationRequest.resourceId
      ||policy.project_id!==authorizationRequest.projectId||policy.risk!==authorizationRequest.risk||!policy.external_effect
      ||policy.request_digest!==sha256Digest(authorizationRequest)||iso(policy.decided_at)!==decision.decidedAt
      ||Date.parse(iso(policy.expires_at))<Date.parse(decision.expiresAt)
      ||!policy.strong_factor_evidence_id||decision.authenticationEventDigest!==sha256Digest({evidenceId:policy.strong_factor_evidence_id}))throw new CompletionGateErrorV1("approval_binding_invalid");
    const grants=await source.query<ApprovalGrantRow>(`SELECT id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,expires_at,revoked_at
      FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2 FOR UPDATE`,[decision.tenantId,policy.identity_id]);const matched=new Set(policy.grant_ids);
    const active=grants.rows.some((grant)=>matched.has(grant.id)&&["owner","operator"].includes(grant.role_key)
      &&(grant.allowed_actions.includes("*")||grant.allowed_actions.includes("approval.decide"))
      &&(grant.project_ids.includes("*")||grant.project_ids.includes(request.projectId))&&grant.allow_external_effects
      &&riskOrder.indexOf(request.risk)<=riskOrder.indexOf(grant.risk_ceiling)
      &&(!grant.expires_at||Date.parse(iso(grant.expires_at))>=Date.parse(decision.expiresAt))
      &&(!grant.revoked_at||Date.parse(iso(grant.revoked_at))>Date.parse(now)));
    if(!active)throw new CompletionGateErrorV1("approval_binding_invalid");
  }
  private assertTargetProfile(target:CompletionReviewTargetV1,profile:CompletionAcceptanceProfileV1):void{
    if(target.tenantId!==profile.tenantId||target.projectId!==profile.projectId||target.kind!==profile.targetKind||target.acceptanceProfileDigest!==sha256Digest(profile))throw new CompletionGateErrorV1("profile_mismatch");
  }
  private assertReviewBindings(review:CompletionReviewV1,target:CompletionReviewTargetV1,profile:CompletionAcceptanceProfileV1):void{
    if(review.tenantId!==target.tenantId||review.projectId!==target.projectId||review.targetDigest!==sha256Digest(target)||review.acceptanceProfileId!==profile.id
      ||review.acceptanceProfileDigest!==sha256Digest(profile)||Date.parse(review.reviewedAt)<Date.parse(target.submittedAt))throw new CompletionGateErrorV1("profile_mismatch");
  }
  private assertIndependent(producer:CompletionPrincipalV1,reviewer:CompletionPrincipalV1,profile:CompletionAcceptanceProfileV1):void{
    const axes:[keyof CompletionAcceptanceProfileV1["reviewerSeparation"],keyof CompletionPrincipalV1][]=[
      ["actor","actorId"],["worker","workerId"],["agentProfile","agentProfileId"],["harness","harness"],["modelFamily","modelFamily"]];
    for(const [policy,field] of axes){if(!profile.reviewerSeparation[policy])continue;const left=producer[field];const right=reviewer[field];if(typeof left!=="string"||typeof right!=="string"||left===right)throw new CompletionGateErrorV1("reviewer_not_independent");}
  }
  private checkpointScope(tenantId:string){return `completion-gate:${tenantId}`;}
  private tenantStateTag(tenantId:string,revision:number,recordCount:number,stateDigest:string){return hmacSha256Tag(this.integrityKey,{module:"completion-gate",tenantId,revision,recordCount,stateDigest});}
  private checkpoint(tenantId:string,revision:number,recordCount:number,stateDigest:string,stateAuthTag:string):RollbackCheckpointV1{return{schema:ROLLBACK_CHECKPOINT_SCHEMA_V1,scope:this.checkpointScope(tenantId),revision,recordCount,stateDigest,stateAuthTag};}
  private async readCheckpoint(tenantId:string){try{return await this.checkpointOperation(signal => this.checkpointRead(this.checkpointScope(tenantId), signal));}catch{throw new CompletionGateErrorV1("integrity_failed");}}
  private async assertCheckpoint(tenantId:string,row:CompletionIntegrityRow){try{const expected=this.checkpoint(tenantId,Number(row.revision),Number(row.record_count),row.state_digest,row.state_auth_tag),known=await this.readCheckpoint(tenantId);if(!known||rollbackCheckpointDigestV1(known)!==rollbackCheckpointDigestV1(expected))throw new Error("mismatch");return expected;}catch{throw new CompletionGateErrorV1("integrity_failed");}}
  private async computedTenantState(source:QuerySource,tenantId:string){const result=await source.query<CompletionRow>(`SELECT ${columns} FROM control_completion_gate_records WHERE tenant_id=$1 ORDER BY kind,id`,[tenantId]);for(const row of result.rows)this.verifiedRow(row);const records=result.rows.map((row)=>({id:row.id,projectId:row.project_id,kind:row.kind,recordKey:row.record_key,subjectId:row.subject_id,parentId:row.parent_id,recordDigest:row.record_digest,recordAuthTag:row.record_auth_tag,occurredAt:iso(row.occurred_at)}));return{recordCount:records.length,stateDigest:sha256Digest({tenantId,records})};}
  private async lockAndVerifyTenantState(source:DatabaseSession,tenantId:string){const result=await source.query<CompletionIntegrityRow>("SELECT * FROM control_completion_gate_integrity WHERE tenant_id=$1 FOR UPDATE",[tenantId]);
    const row=result.rows[0],computed=await this.computedTenantState(source,tenantId);if(!row||Number(row.revision)<1||Number(row.record_count)!==computed.recordCount||row.state_digest!==computed.stateDigest||!sameTag(row.state_auth_tag,this.tenantStateTag(tenantId,Number(row.revision),computed.recordCount,computed.stateDigest)))throw new CompletionGateErrorV1("integrity_failed");await this.assertCheckpoint(tenantId,row);}
  private async refreshTenantState(source:DatabaseSession,tenantId:string){const priorResult=await source.query<CompletionIntegrityRow>("SELECT * FROM control_completion_gate_integrity WHERE tenant_id=$1 FOR UPDATE",[tenantId]);const prior=priorResult.rows[0];if(!prior)throw new CompletionGateErrorV1("integrity_failed");const expected=await this.assertCheckpoint(tenantId,prior),computed=await this.computedTenantState(source,tenantId),revision=Number(prior.revision)+1,stateAuthTag=this.tenantStateTag(tenantId,revision,computed.recordCount,computed.stateDigest),next=this.checkpoint(tenantId,revision,computed.recordCount,computed.stateDigest,stateAuthTag);
    const result=await source.query<{tenant_id:string}>(`UPDATE control_completion_gate_integrity SET revision=$2,record_count=$3,state_digest=$4,state_auth_tag=$5 WHERE tenant_id=$1 AND revision=$6 RETURNING tenant_id`,[tenantId,revision,computed.recordCount,computed.stateDigest,stateAuthTag,Number(prior.revision)]);if(!result.rows[0])throw new CompletionGateErrorV1("integrity_failed");
    try{await this.checkpointOperation(signal => this.checkpointAdvance(rollbackCheckpointDigestV1(expected),next,signal));}catch{throw new CompletionGateErrorV1("integrity_failed");}}
  private currentTime():string{const value=this.clock();if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))throw new CompletionGateErrorV1("approval_binding_invalid");return value;}
}
