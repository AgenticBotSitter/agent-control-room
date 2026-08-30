import { sha256Digest } from "../../security";
import type { ControlRoomMcpProposalReceiptV1, ControlRoomMcpProposalRecordV1, ControlRoomMcpProposalStoreV1 } from "./types";

/** Excludes server observation time so a later transport retry remains idempotent. */
export function digestControlRoomMcpProposalRecordV1(input: ControlRoomMcpProposalRecordV1): string {
  const stableRequest = { ...input } as Record<string, unknown>;
  delete stableRequest.requestedAt;
  return sha256Digest(stableRequest);
}

/** Proposal-only reference store. It cannot create jobs, leases, approvals, reservations, or effects. */
export class InMemoryControlRoomMcpProposalStoreV1 implements ControlRoomMcpProposalStoreV1 {
  private readonly records = new Map<string, { digest: string; receipt: ControlRoomMcpProposalReceiptV1 }>();
  constructor(private readonly maximumRecords = 10_000) {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 100_000) throw new Error("MCP proposal store configuration invalid");
  }

  record(input: ControlRoomMcpProposalRecordV1): ControlRoomMcpProposalReceiptV1 {
    const key = `${input.tenantId}:${input.idempotencyKey}`; const requestDigest = digestControlRoomMcpProposalRecordV1(input);
    const prior = this.records.get(key);
    if (prior) {
      if (prior.digest !== requestDigest) throw new Error("MCP proposal replay conflict");
      return { ...prior.receipt, replayed: true };
    }
    if (this.records.size >= this.maximumRecords) throw new Error("MCP proposal capacity exhausted");
    const receipt: ControlRoomMcpProposalReceiptV1 = {
      receiptId: `receipt:${requestDigest.slice(7, 39)}`,
      requestKind: input.kind,
      requestDigest,
      state: "recorded",
      grantsAuthority: false,
      dispatchCreated: false,
      replayed: false,
    };
    this.records.set(key, { digest: requestDigest, receipt });
    return structuredClone(receipt);
  }

  evidence(): { records: number; authorityGrants: 0; dispatches: 0 } {
    return { records: this.records.size, authorityGrants: 0, dispatches: 0 };
  }
}
