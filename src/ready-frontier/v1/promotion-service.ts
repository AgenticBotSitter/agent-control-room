import type { CanonicalStore } from "../../persistence/canonical-store";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import type { ReadyFrontierSimulationStoreV1 } from "./durable-store";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { exactReadyFrontierJsonV1 } from "./exact";
import { buildReadyFrontierPromotionV1, parseReadyFrontierPromotionV1 } from "./promotion";
import { parseReadyFrontierReadyPolicyV1 } from "./ready-policy";
import { readyFrontierPromotionBuildInputSchemaV1 } from "./ready-policy-schemas";
import type { ReadyFrontierPromotionBuildInputV1, ReadyFrontierPromotionReceiptV1,
  ReadyFrontierReadyPolicyV1 } from "./ready-policy-types";
import type { ReadyFrontierStandingPolicyV1 } from "./automation-types";
import type { ReadyFrontierReadyPolicyStoreV1 } from "./ready-policy-store";
import type { ReadyFrontierStandingPolicyStoreV1 } from "./standing-policy-store";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function id(prefix: string, material: unknown): string { return `${prefix}:${sha256Digest(material).slice(7, 39)}`; }

export interface ReadyFrontierTrustedClockV1 { now(): string; }

async function persistPromotion(input: { canonicalStore: CanonicalStore; receipt: ReadyFrontierPromotionReceiptV1;
  standingPolicy: ReadyFrontierStandingPolicyV1; readyPolicy: ReadyFrontierReadyPolicyV1;
  standingPolicyGuard: object; readyPolicyGuard: object;
  evaluationKey: unknown; readyPolicyKey: unknown }):
  Promise<{ receipt: ReadyFrontierPromotionReceiptV1; replayed: boolean }> {
  const receipt = parseReadyFrontierPromotionV1(input.receipt, input.evaluationKey);
  const policy = parseReadyFrontierReadyPolicyV1(input.readyPolicy, input.readyPolicyKey);
  const project = policy.projectPolicies.find((item) => item.projectId === receipt.readyJob.projectId);
  if (!project || policy.policyId !== receipt.readyPolicyId || policy.revision !== receipt.readyPolicyRevision
    || policy.policyDigest !== receipt.readyPolicyDigest || project.resourceKey !== receipt.reservation.resourceKey
    || project.reservationUnits !== receipt.reservation.units
    || project.resourceCapacityUnits !== receipt.reservation.capacityUnits) fail("policy_denied");
  const result = await input.canonicalStore.promoteReadyFrontierJobWithInternalHandoff({
    tenantId: receipt.tenantId, projectId: receipt.readyJob.projectId, jobId: receipt.readyJob.id,
    requestId: receipt.requestId, requestDigest: receipt.promotionRequestDigest, receiptDigest: receipt.receiptDigest,
    readyJobDigest: sha256Digest(receipt.readyJob),
    standingPolicy: { policyId: receipt.standingPolicyId, revision: receipt.standingPolicyRevision,
      policyDigest: receipt.standingPolicyDigest, activeGuard: input.standingPolicyGuard },
    readyPolicy: { policyId: receipt.readyPolicyId, revision: receipt.readyPolicyRevision,
      policyDigest: receipt.readyPolicyDigest, activeGuard: input.readyPolicyGuard },
    expectedJobVersion: 0, expectedJobDigest: receipt.proposedJobDigest,
    maximumActiveReadyGlobal: policy.maximumActiveReadyGlobal, maximumActiveReadyProject: project.maximumActiveReady,
    transitionId: id("transition:frontier-ready", { receiptId: receipt.receiptId }),
    transitionIdempotencyKey: `frontier-ready-${receipt.receiptDigest.slice(7)}`,
    actor: { actorId: "service:ready-frontier-promoter", actorType: "service" }, occurredAt: receipt.promotedAt,
    reservation: { id: receipt.reservation.reservationId, routeId: receipt.reservation.routeId,
      resourceKey: receipt.reservation.resourceKey, units: receipt.reservation.units,
      capacityUnits: receipt.reservation.capacityUnits, decisionDigest: receipt.reservation.decisionDigest,
      acquiredAt: receipt.reservation.acquiredAt, expiresAt: receipt.reservation.expiresAt },
    handoff: { id: receipt.handoff.handoffId, payloadDigest: sha256Digest(receipt.handoff),
      availableAt: receipt.handoff.createdAt, expiresAt: receipt.handoff.expiresAt,
      payload: exactReadyFrontierJsonV1(receipt.handoff) as Record<string, unknown> },
  });
  return { receipt, replayed: result.replayed };
}

/** Repository-only ready bridge. It writes canonical readiness, database capacity, and an internal outbox packet only. */
export class ReadyFrontierPromotionServiceV1 {
  private readonly evaluationKey: Uint8Array;
  private readonly standingPolicyKey: Uint8Array;
  private readonly readyPolicyKey: Uint8Array;

  constructor(private readonly evaluations: ReadyFrontierSimulationStoreV1,
    private readonly standingPolicies: ReadyFrontierStandingPolicyStoreV1,
    private readonly readyPolicies: ReadyFrontierReadyPolicyStoreV1,
    private readonly canonicalStore: CanonicalStore,
    evaluationKeyValue: unknown, standingPolicyKeyValue: unknown, readyPolicyKeyValue: unknown,
    private readonly clock: ReadyFrontierTrustedClockV1) {
    const evaluationKey = exactHostUint8ArrayV1(evaluationKeyValue, 128);
    const standingPolicyKey = exactHostUint8ArrayV1(standingPolicyKeyValue, 128);
    const readyPolicyKey = exactHostUint8ArrayV1(readyPolicyKeyValue, 128);
    if (!evaluationKey || evaluationKey.byteLength < 32 || !standingPolicyKey || standingPolicyKey.byteLength < 32
      || !readyPolicyKey || readyPolicyKey.byteLength < 32) fail("integrity_failed");
    this.evaluationKey = evaluationKey.copy(); this.standingPolicyKey = standingPolicyKey.copy();
    this.readyPolicyKey = readyPolicyKey.copy();
  }

  async promote(value: unknown): Promise<{ receipt: ReadyFrontierPromotionReceiptV1; replayed: boolean }> {
    let envelope: ReadyFrontierPromotionBuildInputV1;
    try {
      envelope = readyFrontierPromotionBuildInputSchemaV1.parse(exactReadyFrontierJsonV1(value)) as ReadyFrontierPromotionBuildInputV1;
      assertNoSecretMaterial(envelope, "ready frontier promotion request");
    } catch (error) {
      if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("invalid_input");
    }
    const request = envelope.request, materialization = envelope.materializationReceipt;
    let trustedNow: string;
    try { trustedNow = this.clock.now(); } catch { fail("integrity_failed"); }
    const evaluation = this.evaluations.evaluation(materialization.cycleId);
    if (!evaluation) fail("integrity_failed");
    return this.standingPolicies.withCurrentPolicy(request.standingPolicyId, request.standingPolicyRevision,
      request.standingPolicyDigest, (standingPolicy, standingPolicyGuard) => this.readyPolicies.withCurrentPolicy(request.readyPolicyId,
        request.readyPolicyRevision, request.readyPolicyDigest, async (readyPolicy, readyPolicyGuard) => {
          const receipt = buildReadyFrontierPromotionV1(envelope, this.evaluationKey, this.standingPolicyKey,
            this.readyPolicyKey, evaluation, standingPolicy, readyPolicy, trustedNow);
          return persistPromotion({ canonicalStore: this.canonicalStore, receipt, standingPolicy, readyPolicy,
            standingPolicyGuard, readyPolicyGuard,
            evaluationKey: this.evaluationKey, readyPolicyKey: this.readyPolicyKey });
        }));
  }

  close(): void {
    this.evaluationKey.fill(0); this.standingPolicyKey.fill(0); this.readyPolicyKey.fill(0);
  }
}
