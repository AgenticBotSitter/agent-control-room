import type { NodeOperationAcknowledgementBody, SignedNodeFrame } from "../node-protocol/v1";
import { sha256Digest } from "../security";
import {
  buildWireDenialReceipt,
  evaluateLocalPolicy,
  SqliteLocalAdmissionStore,
  type LocalPolicyEvaluationInputV1,
  type WireDenialReceiptV1,
} from "../node-policy/v1";

export interface BridgeCommandHandler {
  handle(frame: SignedNodeFrame, now: string): Promise<boolean>;
  response?(messageId: string): NodeOperationAcknowledgementBody | undefined;
}

export interface AdmissionPlanV1 {
  evaluation: LocalPolicyEvaluationInputV1;
}

export interface AdmissionHandlingResultV1 {
  disposition: "accepted" | "refused";
  receipt?: WireDenialReceiptV1;
}

export type AdmissionPlannerV1 = (frame: SignedNodeFrame, now: string) => AdmissionPlanV1 | undefined | Promise<AdmissionPlanV1 | undefined>;

export class DurablePolicyCommandHandler implements BridgeCommandHandler {
  private readonly results = new Map<string, AdmissionHandlingResultV1>();

  constructor(private readonly store: SqliteLocalAdmissionStore, private readonly planner: AdmissionPlannerV1) {}

  result(messageId: string): AdmissionHandlingResultV1 | undefined {
    const result = this.results.get(messageId);
    return result ? { ...result, ...(result.receipt ? { receipt: { ...result.receipt } } : {}) } : undefined;
  }

  async handle(frame: SignedNodeFrame, now: string): Promise<boolean> {
    const plan = await this.planner(frame, now);
    if (!plan) return false;
    const request = plan.evaluation.request;
    const identity = {
      tenantId: request.tenantId, nodeId: request.nodeId, projectId: request.projectId,
      jobId: request.jobId, attemptId: request.attemptId, operationDigest: request.operationDigest,
    };
    const prior = this.store.findEquivalent(identity, sha256Digest(request), plan.evaluation.ceiling.bodyDigest, plan.evaluation.lease.authorityDigest);
    const decision = prior?.decision ?? evaluateLocalPolicy(plan.evaluation, { now: () => now });
    this.store.record({ messageId: frame.messageId, identity, decision, recordedAt: prior?.recordedAt ?? now });
    const result: AdmissionHandlingResultV1 = decision.accepted ? { disposition: "accepted" } : {
      disposition: "refused",
      receipt: buildWireDenialReceipt(decision, {
        receiptId: `receipt:${decision.requestDigest.slice("sha256:".length)}`,
        relatedMessageId: frame.messageId,
        jobId: request.jobId,
        attemptId: request.attemptId,
        occurredAt: now,
      }),
    };
    this.results.set(frame.messageId, result);
    return true;
  }
}
