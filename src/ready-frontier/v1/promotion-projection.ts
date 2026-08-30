import { sha256Digest } from "../../security";
import { parseExactReadyFrontierV1 } from "./exact";
import { parseReadyFrontierPromotionV1 } from "./promotion";
import { parseReadyFrontierReadyPolicyV1 } from "./ready-policy";
import { readyFrontierPromotionProjectionSchemaV1 } from "./ready-policy-schemas";
import { readyFrontierTimeSchemaV1 } from "./schemas";
import {
  READY_FRONTIER_PROMOTION_PROJECTION_V1,
  type ReadyFrontierPromotionProjectionV1,
  type ReadyFrontierPromotionReceiptV1,
  type ReadyFrontierReadyPolicyV1,
} from "./ready-policy-types";

export function projectReadyFrontierPromotionV1(input: { tenantId: string;
  readyPolicy?: ReadyFrontierReadyPolicyV1; receipts: ReadyFrontierPromotionReceiptV1[];
  observedAt: string; evaluationIntegrityKey: unknown; readyPolicyIntegrityKey: unknown }): ReadyFrontierPromotionProjectionV1 {
  const observedAt = parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, input.observedAt);
  const policy = input.readyPolicy ? parseReadyFrontierReadyPolicyV1(input.readyPolicy, input.readyPolicyIntegrityKey) : undefined;
  const receipts = input.receipts.map((receipt) => parseReadyFrontierPromotionV1(receipt, input.evaluationIntegrityKey));
  if ((policy && policy.tenantId !== input.tenantId) || receipts.some((receipt) => receipt.tenantId !== input.tenantId)) {
    throw new Error("promotion projection scope mismatch");
  }
  for (const identities of [receipts.map((receipt) => receipt.receiptId), receipts.map((receipt) => receipt.readyJob.id),
    receipts.map((receipt) => receipt.reservation.reservationId), receipts.map((receipt) => receipt.handoff.handoffId)]) {
    if (new Set(identities).size !== identities.length) throw new Error("promotion projection duplicate lineage");
  }
  const observed = Date.parse(observedAt);
  if (receipts.some((receipt) => observed < Date.parse(receipt.promotedAt)
    || observed >= Date.parse(receipt.reservation.expiresAt)
    || observed >= Date.parse(receipt.handoff.expiresAt))) {
    throw new Error("promotion projection lacks current active reservation and pending handoff evidence");
  }
  const state = !policy ? "missing" : policy.state === "suspended" ? "suspended" : policy.state === "revoked" ? "revoked"
    : observed < Date.parse(policy.effectiveAt) || observed >= Date.parse(policy.expiresAt) ? "expired" : "repository_fixture_active";
  const unsigned = { schema: READY_FRONTIER_PROMOTION_PROJECTION_V1, tenantId: input.tenantId,
    readyPolicyState: state, productionReadyPolicyState: "not_enrolled" as const,
    readyPromotionState: receipts.length > 0 ? "ready_handoff_pending" as const : "not_requested" as const,
    readyJobCount: receipts.length, pendingInternalHandoffCount: receipts.length,
    repositorySimulationOnly: true as const, viewCanPromote: false as const, viewCanSchedule: false as const,
    viewCanClaimOrLease: false as const, viewCanDispatchOrExecute: false as const };
  return parseExactReadyFrontierV1(readyFrontierPromotionProjectionSchemaV1,
    { ...unsigned, projectionDigest: sha256Digest(unsigned) });
}
