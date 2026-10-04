import type { DatabaseSession } from "../../persistence/database";
import type { CoordinationCostEvidencePortV1 } from "../../project-coordination/v1/schemas";
import { sha256Digest } from "../../security";
import type { WorkBatchQueueSelectionAuthorityV1, WorkBatchQueueSelectionV1 } from "../../work-intake/v1";
import { PipelineAdvanceErrorV1, type PipelineAdvanceCapabilityV1, type PipelineAdvanceSelectionV1,
  type PipelineDelegationReceiptV1, type PipelineStageResolutionV1 } from "./advance-service";

// Transaction-bound only: the advance commits its queue intent in the same
// transaction whose Completion Gate lock the proof holds. The web's coordinator
// snapshot (binding "coordinator_snapshot") does not satisfy this type.
type AcceptedResults = Readonly<{
  binding?:"caller_transaction";
  isAcceptedResultCurrent(tx:DatabaseSession,selection:{sourceJobId:string;workerId:string;nodeId:string}):Promise<boolean>;
  acceptedResultProof(tx:DatabaseSession,selection:{sourceJobId:string;workerId:string;nodeId:string}):Promise<Readonly<{
    executionJobId:string
  }>|null>;
}>;
const fail=(reason:ConstructorParameters<typeof PipelineAdvanceErrorV1>[0]):never=>{throw new PipelineAdvanceErrorV1(reason);};
const number=(value:number|string)=>{const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<0)fail("advance_conflict");return parsed;};

/** Canonical read-side authority for unattended continuation. It creates no
 * work: the policy row only serializes quota accounting until the surrounding
 * transaction commits its ordinary queue intent and signed advance receipt. */
export class ProductionPipelineAdvanceAuthorityV1 implements Pick<PipelineAdvanceCapabilityV1,
  "resolveStageInSession"|"assertAcceptedPredecessorInSession"|"assertSelectionCurrentInSession"|
  "assertSelectionCurrent"|"authorizeDelegationInSession"> {
  constructor(private readonly scope:{tenantId:string;workspaceId:string},
    private readonly selection:WorkBatchQueueSelectionAuthorityV1,private readonly accepted:AcceptedResults,
    private readonly costs:CoordinationCostEvidencePortV1,private readonly clock:()=>number=Date.now) {}
  #batch(value:PipelineAdvanceSelectionV1|Omit<PipelineAdvanceSelectionV1,"executionJobId">):WorkBatchQueueSelectionV1{
    return {tenantId:value.tenantId,projectId:value.projectId,batchId:value.runId,
      itemId:`${value.runId}:stage:${value.stageOrdinal}`,sourceJobId:value.sourceJobId,
      ...( "executionJobId" in value ? {executionJobId:value.executionJobId}:{}),workerId:value.workerId,
      workerKind:value.workerKind,nodeId:value.nodeId,selectionKey:value.selectionKey,model:value.model,effort:value.effort,
      provider:value.provider,profile:value.profile} as WorkBatchQueueSelectionV1;
  }
  assertSelectionCurrent(selection:PipelineAdvanceSelectionV1){if(this.selection.assertCurrent(this.#batch(selection))!==true)fail("selection_not_current");}
  assertSelectionCurrentInSession(_tx:DatabaseSession,selection:PipelineAdvanceSelectionV1){return this.assertSelectionCurrent(selection);}
  async resolveStageInSession(tx:DatabaseSession,input:Omit<PipelineAdvanceSelectionV1,"executionJobId">):Promise<PipelineStageResolutionV1>{
    if(input.tenantId!==this.scope.tenantId)fail("selection_not_current");
    // Only the job row is locked: the coordinator may lock it, and it is the
    // row whose state can move. Execution plans are immutable (0045's trigger)
    // and model selections have no UPDATE grant, so a lock on either would
    // need a privilege the coordinator login does not hold.
    let accepted:null|Readonly<{executionJobId:string}>=null;
    try{accepted=await this.accepted.acceptedResultProof(tx,input);}catch{fail("stage_uncertain");}
    // The input digest lives in the canonical job record; control_jobs has no column for it.
    const rows=(await tx.query<{job_id:string;input_digest:string;state:string}>(`SELECT p.job_id,
      j.payload->>'inputDigest' AS input_digest,j.state
      FROM control_task_execution_plans p JOIN control_jobs j ON j.tenant_id=p.tenant_id AND j.id=p.job_id
      JOIN control_task_model_selections s ON s.tenant_id=j.tenant_id AND s.job_id=j.id
      JOIN pipeline_stage_runs st ON st.tenant_id=j.tenant_id AND st.pipeline_run_id=j.pipeline_run_id
        AND st.stage_ordinal=j.stage_ordinal AND st.current_job_id=p.source_job_id
      WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.source_job_id=$3 AND j.pipeline_run_id=$4 AND j.stage_ordinal=$5
        AND s.worker_kind=$6 AND s.selection_key=$7 AND s.model=$8 AND s.effort=$9
        AND s.provider IS NOT DISTINCT FROM $10 AND s.profile IS NOT DISTINCT FROM $11
        AND st.worker_id=$12 AND st.node_id=$13 AND st.worker_kind=$6 AND st.selection_key=$7 AND st.model=$8
        AND st.effort=$9 AND st.provider IS NOT DISTINCT FROM $10 AND st.profile IS NOT DISTINCT FROM $11
      ORDER BY j.created_at DESC LIMIT 2 FOR SHARE OF j`,[input.tenantId,input.projectId,input.sourceJobId,input.runId,
      input.stageOrdinal,input.workerKind,input.selectionKey,input.model,input.effort,input.provider,input.profile,
      input.workerId,input.nodeId])).rows;
    if(accepted){const row=rows.find(value=>value.job_id===accepted!.executionJobId);
      if(!row)throw new PipelineAdvanceErrorV1("stage_uncertain");
      this.assertSelectionCurrent({...input,executionJobId:row.job_id});
      return {state:"accepted",executionJobId:row.job_id,expectedInputDigest:row.input_digest};}
    if(rows.length!==1)fail("stage_uncertain");const row=rows[0];if(!row)fail("stage_uncertain");
    const state:[PipelineStageResolutionV1["state"]][0]=["proposed","ready","orphaned"].includes(row.state)?"eligible"
      :["leased","running"].includes(row.state)?"in_flight":row.state==="waiting_approval"||row.state==="succeeded"?"waiting_approval"
      :["failed","cancelled","rejected"].includes(row.state)?"terminal_failure":"uncertain";
    return {state,executionJobId:row.job_id,expectedInputDigest:row.input_digest};
  }
  async assertAcceptedPredecessorInSession(tx:DatabaseSession,input:{tenantId:string;projectId:string;runId:string;
    predecessorJobId:string;successorJobId:string}){
    const edge=(await tx.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM control_job_dependencies WHERE tenant_id=$1
      AND job_id=$2 AND depends_on_job_id=$3) present`,[input.tenantId,input.successorJobId,input.predecessorJobId])).rows[0];
    const predecessor=(await tx.query<{worker_id:string;node_id:string}>(`SELECT worker_id,node_id FROM pipeline_stage_runs
      WHERE tenant_id=$1 AND project_id=$2 AND pipeline_run_id=$3 AND current_job_id=$4`,
    [input.tenantId,input.projectId,input.runId,input.predecessorJobId])).rows[0];
    if(!edge?.present||!predecessor||!await this.accepted.isAcceptedResultCurrent(tx,{sourceJobId:input.predecessorJobId,
      workerId:predecessor.worker_id,nodeId:predecessor.node_id}))fail("dependency_not_accepted");
  }
  async authorizeDelegationInSession(tx:DatabaseSession,selection:PipelineAdvanceSelectionV1,policyId:string):Promise<PipelineDelegationReceiptV1>{
    const policy=(await tx.query<{id:string;version:number|string;policy_digest:string;coordinator_version:number|string;
      coordinator_identity_id:string;owner_identity_id:string;state:string;valid_from:string|Date;valid_until:string|Date;
      allowed_actions:unknown;eligible_routes:unknown}>(`SELECT id,version,policy_digest,coordinator_version,
      coordinator_identity_id,owner_identity_id,state,valid_from,valid_until,allowed_actions,eligible_routes
      FROM control_project_delegation_policies WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
    [selection.tenantId,selection.projectId,policyId])).rows[0];
    const head=(await tx.query<{version:number|string;state:string;coordinator_identity_id:string}>(`SELECT version,state,
      coordinator_identity_id FROM control_project_coordinator_heads
      WHERE tenant_id=$1 AND project_id=$2 FOR SHARE`,[selection.tenantId,selection.projectId])).rows[0];
    const owner=policy?(await tx.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM control_identities i
      JOIN control_role_grants g ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      WHERE i.tenant_id=$1 AND i.id=$2 AND i.state='active' AND g.role_key='owner' AND g.revoked_at IS NULL) present`,
    [selection.tenantId,policy.owner_identity_id])).rows[0]:undefined;
    const now=this.clock(),actions=Array.isArray(policy?.allowed_actions)?policy!.allowed_actions:[],
      routes=Array.isArray(policy?.eligible_routes)?policy!.eligible_routes:[];
    if(!policy||!head||!owner?.present||policy.state!=="active"||head.state!=="active"
      ||policy.coordinator_identity_id!==head.coordinator_identity_id||number(policy.coordinator_version)!==number(head.version)
      ||!actions.includes("tasks.assign")||!routes.includes(selection.nodeId)||now<Date.parse(String(policy.valid_from))
      ||now>=Date.parse(String(policy.valid_until)))fail("policy_inactive");
    const job=(await tx.query<{required_capability:string}>(`SELECT required_capability FROM control_jobs WHERE tenant_id=$1
      AND project_id=$2 AND id=$3 FOR SHARE`,[selection.tenantId,selection.projectId,selection.executionJobId])).rows[0];
    if(!job)fail("execution_authority_missing");
    const cost=await this.costs.currentCost({tenantId:selection.tenantId,projectId:selection.projectId,
      routeId:selection.nodeId,requiredCapability:job.required_capability});
    // "Count runs, never dollars." An unknown cost is reported as unknown and
    // is not a refusal here: it is refused nowhere. The installation's optional
    // dollar cap and the owner's signed policy ceiling are both compared in the
    // advance service, which owns the ceilings.
    //
    // A port that CLAIMS to know the cost and returns something impossible --
    // a negative, fractional, non-finite or absurdly large amount, or an
    // evidence digest that is not a digest -- is not an honest unknown, it is an
    // integrity failure, and demoting it to `unknown` let it slip past every
    // dollar ceiling. So it refuses here, before anything is queued or claimed.
    let nextCost: Readonly<{kind:"known";microUsd:number;evidenceDigest:string}>
      | Readonly<{kind:"unknown"}> = {kind:"unknown"};
    if (cost.kind==="unknown") nextCost = {kind:"unknown"};
    else if (!Number.isSafeInteger(cost.admittedCostMicroUsd) || cost.admittedCostMicroUsd<0
      || !/^sha256:[a-f0-9]{64}$/.test(cost.evidenceDigest)) fail("advance_conflict");
    else nextCost = {kind:"known" as const,microUsd:cost.admittedCostMicroUsd,evidenceDigest:cost.evidenceDigest};
    const usage=(await tx.query<{tasks:string;cost:string;concurrent:string}>(`SELECT
      (SELECT COALESCE(SUM(task_units),0) FROM control_project_coordination_operation_receipts WHERE tenant_id=$1 AND policy_id=$2)
       +(SELECT COALESCE(SUM(delegation_task_units),0) FROM pipeline_advance_receipts WHERE tenant_id=$1 AND policy_id=$2) tasks,
      (SELECT COALESCE(SUM(admitted_cost_microusd),0) FROM control_project_coordination_operation_receipts WHERE tenant_id=$1 AND policy_id=$2)
       +(SELECT COALESCE(SUM(delegation_cost_microusd),0) FROM pipeline_advance_receipts WHERE tenant_id=$1 AND policy_id=$2) cost,
      (SELECT COUNT(DISTINCT id) FROM control_jobs WHERE tenant_id=$1 AND project_id=$3 AND state IN('leased','running','waiting_approval')) concurrent`,
    [selection.tenantId,policyId,selection.projectId])).rows[0];
    const material={schema:"control-room.pipeline-delegation-receipt/v1",policyId,policyVersion:number(policy.version),
      policyDigest:policy.policy_digest,coordinatorVersion:number(policy.coordinator_version),
      ownerIdentityId:policy.owner_identity_id,action:"tasks.assign" as const,
      routeId:selection.nodeId,executorId:selection.workerId,taskUnits:number(usage?.tasks??"0"),
      committedCostMicroUsd:number(usage?.cost??"0"),nextCost,
      concurrentTasks:number(usage?.concurrent??"0"),validUntil:new Date(policy.valid_until).toISOString(),
      selectionDigest:sha256Digest(selection)};
    return {receiptId:`pipeline-delegation:${selection.runId}:${selection.stageOrdinal}`,receiptDigest:sha256Digest(material),...material};
  }
}
