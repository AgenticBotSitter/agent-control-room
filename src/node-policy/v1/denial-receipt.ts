import { assertNoSecretMaterial } from "../../security";
import { wireDenialReceiptSchema } from "./schemas";
import { NODE_POLICY_CONTRACT_V1, type LocalPolicyDecisionV1, type WireDenialReceiptV1 } from "./types";

export interface WireDenialReceiptReferencesV1 {
  receiptId: string;
  relatedMessageId: string;
  jobId: string;
  attemptId: string;
  occurredAt: string;
}

export function buildWireDenialReceipt(
  decision: Extract<LocalPolicyDecisionV1, { accepted: false }>,
  references: WireDenialReceiptReferencesV1,
): WireDenialReceiptV1 {
  const receipt: WireDenialReceiptV1 = {
    contractVersion: NODE_POLICY_CONTRACT_V1,
    ...references,
    category: decision.wireCategory,
  };
  const parsed = wireDenialReceiptSchema.safeParse(receipt);
  if (!parsed.success) throw new Error("Wire denial receipt references are invalid");
  assertNoSecretMaterial(parsed.data, "wire denial receipt");
  return parsed.data;
}
