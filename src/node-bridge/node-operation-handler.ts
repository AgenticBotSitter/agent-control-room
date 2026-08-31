import type { NodeOperationAcknowledgementBody, SignedNodeFrame } from "../node-protocol/v1";
import type { BridgeCommandHandler } from "./admission-handler";
import type { SqliteBridgeJournal } from "./journal";

export interface NodeControlCancellationPort {
  requestRunningCancellation(input: {
    requestId: string;
    reason: "drain" | "quarantine";
    requestedAt: string;
  }): void | Promise<void>;
}

export class DurableNodeOperationHandler implements BridgeCommandHandler {
  private readonly responses = new Map<string, NodeOperationAcknowledgementBody>();

  constructor(
    private readonly nodeId: string,
    private readonly journal: SqliteBridgeJournal,
    private readonly cancellation: NodeControlCancellationPort,
  ) {}

  admissionAllowed(): boolean {
    return this.journal.nodeControlState(this.nodeId)?.state === "active";
  }

  renewalAllowed(): boolean {
    return this.admissionAllowed();
  }

  response(messageId: string): NodeOperationAcknowledgementBody | undefined {
    const response = this.responses.get(messageId);
    return response ? { ...response } : undefined;
  }

  async handle(frame: SignedNodeFrame, now: string): Promise<boolean> {
    if (frame.type !== "node.operation.request") return false;
    if (frame.body.nodeId !== this.nodeId) throw new Error("Node operation targets another node");
    const result = this.journal.applyNodeOperation(frame.body, now);
    if (result.cancellationRequired) {
      await this.cancellation.requestRunningCancellation({
        requestId: frame.body.requestId,
        reason: frame.body.operation === "request_quarantine" ? "quarantine" : "drain",
        requestedAt: now,
      });
      this.journal.markNodeControlCancellationRequested(frame.body.requestId, now);
    }
    this.responses.set(frame.messageId, result.acknowledgement);
    return true;
  }

  async recoverPendingCancellations(now: string): Promise<number> {
    let recovered = 0;
    for (const pending of this.journal.pendingNodeControlCancellations()) {
      await this.cancellation.requestRunningCancellation({
        requestId: pending.requestId,
        reason: pending.operation === "request_quarantine" ? "quarantine" : "drain",
        requestedAt: now,
      });
      this.journal.markNodeControlCancellationRequested(pending.requestId, now);
      recovered += 1;
    }
    return recovered;
  }
}
