import type { DatabaseSession } from "../../persistence/database";
import type { TaskAssignmentCoordinator } from "../../web/v1/task-assignment-coordinator";
import type { PipelineAdvanceCapabilityV1, PipelineAdvanceSelectionV1, PipelineDelegationReceiptV1,
  PipelineStageResolutionV1 } from "./advance-service";

type SupportingAuthority = Pick<PipelineAdvanceCapabilityV1, "resolveStageInSession" | "assertAcceptedPredecessorInSession"
  | "assertSelectionCurrentInSession" | "assertSelectionCurrent" | "authorizeDelegationInSession">;

/**
 * Protected native-delivery composition. Implementations must call the same
 * route-specific queue-intent and `native-task-delivery` enqueue functions used
 * by manual starts. This port cannot invoke a provider, send a transport frame,
 * merge, mutate dependencies or create another scheduler/queue.
 */
export type PipelineNativeDeliveryQueueV1 = Readonly<{
  enqueueAssignedInSession: (tx: DatabaseSession, input: PipelineAdvanceSelectionV1 & Readonly<{
    attemptId: string; leaseId: string; leaseEpoch: number; inputDigest: string;
    policyId: string; approvingOwnerIdentityId: string; idempotencyKey: string; commitDeadline: number;
  }>, authority: Readonly<{ actorId: "service:pipeline-advance:v1";
    assertCurrent: () => void | Promise<void> }>) => Promise<Readonly<{ queueId: string; replayed: boolean }>>;
}>;

/**
 * Production authority adapter: one surrounding caller transaction, the
 * ordinary TaskAssignmentCoordinator reservation, then the existing native
 * delivery queue. It introduces no timer, worker, broker or browser identity.
 */
export class ProductionPipelineAdvanceCapabilityV1 implements PipelineAdvanceCapabilityV1 {
  constructor(private readonly supporting: SupportingAuthority,
    private readonly assignment: Pick<TaskAssignmentCoordinator, "assignScheduledInSession">,
    private readonly nativeDelivery: PipelineNativeDeliveryQueueV1) {}

  resolveStageInSession(tx: DatabaseSession, input: Omit<PipelineAdvanceSelectionV1,"executionJobId">): Promise<PipelineStageResolutionV1> {
    return this.supporting.resolveStageInSession(tx,input);
  }
  assertAcceptedPredecessorInSession(tx: DatabaseSession, input: Readonly<{tenantId:string;projectId:string;runId:string;
    predecessorJobId:string;successorJobId:string}>){return this.supporting.assertAcceptedPredecessorInSession(tx,input);}
  assertSelectionCurrentInSession(tx: DatabaseSession, selection: PipelineAdvanceSelectionV1){
    return this.supporting.assertSelectionCurrentInSession(tx,selection);}
  assertSelectionCurrent(selection: PipelineAdvanceSelectionV1){return this.supporting.assertSelectionCurrent(selection);}
  authorizeDelegationInSession(tx: DatabaseSession, selection: PipelineAdvanceSelectionV1,
    policyId: string): Promise<PipelineDelegationReceiptV1>{return this.supporting.authorizeDelegationInSession(tx,selection,policyId);}

  async assignAndQueueInSession(tx: DatabaseSession, input: PipelineAdvanceSelectionV1 & Readonly<{
    expectedInputDigest:string;policyId:string;approvingOwnerIdentityId:string;idempotencyKey:string;commitDeadline:number}>,
    authority: Readonly<{actorId:"service:pipeline-advance:v1";assertCurrent:()=>void|Promise<void>;
      commitDeadline:(value:number)=>void}>) {
    await authority.assertCurrent();
    let deadline = input.commitDeadline;
    const assigned = await this.assignment.assignScheduledInSession(tx,{projectId:input.projectId,
      jobId:input.executionJobId,nodeId:input.nodeId,expectedInputDigest:input.expectedInputDigest},{
      assertCurrent:authority.assertCurrent,commitDeadline:value=>{
        deadline=Math.min(deadline,value);authority.commitDeadline(deadline);
      },});
    await authority.assertCurrent();
    const queued = await this.nativeDelivery.enqueueAssignedInSession(tx,{...input,
      attemptId:assigned.receipt.attemptId,leaseId:assigned.receipt.leaseId,leaseEpoch:assigned.receipt.leaseEpoch,
      inputDigest:input.expectedInputDigest,commitDeadline:deadline},authority);
    await authority.assertCurrent();
    return {attemptId:assigned.receipt.attemptId,queueId:queued.queueId,replayed:assigned.replayed&&queued.replayed};
  }
}
