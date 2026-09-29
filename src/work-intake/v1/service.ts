import type { AuthenticatedPrincipal } from "../../security";
import type { WorkBatchRejectionCodeV1 } from "./validation";
import { validateWorkBatchProposalV1 } from "./validation";
import { WorkBatchStoreV1 } from "./store";
import { WorkIntakeErrorV1 } from "./errors";

export type WorkBatchSubmissionResultV1 = Awaited<ReturnType<WorkBatchStoreV1["create"]>>
  | { accepted: false; safeReasonCode: WorkBatchRejectionCodeV1; startsWork: false; grantsExecutionAuthority: false };

export class WorkBatchServiceV1 {
  constructor(private readonly store: WorkBatchStoreV1, private readonly queueDepthLimit = 10) {
    if (!Number.isSafeInteger(queueDepthLimit) || queueDepthLimit < 1 || queueDepthLimit > 20)
      throw new Error("work_intake_configuration_invalid");
  }

  authorizeBeforeBody(principal: AuthenticatedPrincipal, projectId: string, now: string) {
    return this.store.authorize(principal, projectId, now);
  }
  authorizeAction(principal:AuthenticatedPrincipal,projectId:string,action:string,now:string){
    return this.store.authorizeAction(principal,projectId,action,now);
  }

  recordEnvelopeRefusal(principal: AuthenticatedPrincipal, projectId: string, reasonCode: string, now: string) {
    return this.store.recordValidationRefusal(principal, projectId, reasonCode, now);
  }

  async submit(input: { principal: AuthenticatedPrincipal; projectId: string; rawProposal: string;
    idempotencyKey: string; now: string }): Promise<WorkBatchSubmissionResultV1> {
    const authority = await this.store.authorize(input.principal, input.projectId, input.now);
    if (!authority.allowed) throw new Error(authority.safeReasonCode);
    const validation = validateWorkBatchProposalV1(input.rawProposal, input.projectId);
    if (!validation.accepted) {
      await this.store.recordValidationRefusal(input.principal, input.projectId, validation.safeReasonCode, input.now);
      return { accepted: false, safeReasonCode: validation.safeReasonCode,
        startsWork: false, grantsExecutionAuthority: false };
    }
    try {
      return await this.store.create({ principal: input.principal, proposal: validation.proposal,
        proposalDigest: validation.proposalDigest, idempotencyKey: input.idempotencyKey,
        now: input.now, queueDepthLimit: this.queueDepthLimit });
    } catch (error) {
      if (error instanceof WorkIntakeErrorV1) {
        await this.store.recordValidationRefusal(input.principal, input.projectId, error.safeCode, input.now);
      }
      throw error;
    }
  }

  status(input: { principal: AuthenticatedPrincipal; projectId: string; batchId: string; now: string }) {
    return this.store.status(input.principal, input.projectId, input.batchId, input.now);
  }

  list(input: { principal: AuthenticatedPrincipal; projectId: string; now: string }) {
    return this.store.list(input.principal, input.projectId, input.now);
  }
}
