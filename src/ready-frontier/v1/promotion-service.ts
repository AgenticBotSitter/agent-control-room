import type { CanonicalStore } from "../../persistence/canonical-store";
import { assertNoSecretMaterial } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import type { ReadyFrontierSimulationStoreV1 } from "./durable-store";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { exactReadyFrontierJsonV1 } from "./exact";
import { buildReadyFrontierPromotionV1, persistReadyFrontierPromotionV1 } from "./promotion";
import { readyFrontierPromotionBuildInputSchemaV1 } from "./ready-policy-schemas";
import type { ReadyFrontierPromotionBuildInputV1, ReadyFrontierPromotionReceiptV1 } from "./ready-policy-types";
import type { ReadyFrontierReadyPolicyStoreV1 } from "./ready-policy-store";
import type { ReadyFrontierStandingPolicyStoreV1 } from "./standing-policy-store";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }

/** Repository-only ready bridge. It writes canonical readiness, database capacity, and an internal outbox packet only. */
export class ReadyFrontierPromotionServiceV1 {
  private readonly evaluationKey: Uint8Array;
  private readonly standingPolicyKey: Uint8Array;
  private readonly readyPolicyKey: Uint8Array;

  constructor(private readonly evaluations: ReadyFrontierSimulationStoreV1,
    private readonly standingPolicies: ReadyFrontierStandingPolicyStoreV1,
    private readonly readyPolicies: ReadyFrontierReadyPolicyStoreV1,
    private readonly canonicalStore: CanonicalStore,
    evaluationKeyValue: unknown, standingPolicyKeyValue: unknown, readyPolicyKeyValue: unknown) {
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
    const evaluation = this.evaluations.evaluation(materialization.cycleId);
    if (!evaluation) fail("integrity_failed");
    return this.standingPolicies.withCurrentPolicy(request.standingPolicyId, request.standingPolicyRevision,
      request.standingPolicyDigest, (standingPolicy) => this.readyPolicies.withCurrentPolicy(request.readyPolicyId,
        request.readyPolicyRevision, request.readyPolicyDigest, async (readyPolicy) => {
          const receipt = buildReadyFrontierPromotionV1(envelope, this.evaluationKey, this.standingPolicyKey,
            this.readyPolicyKey, evaluation, standingPolicy, readyPolicy);
          return persistReadyFrontierPromotionV1({ canonicalStore: this.canonicalStore, receipt, readyPolicy,
            evaluationKey: this.evaluationKey, readyPolicyKey: this.readyPolicyKey });
        }));
  }

  close(): void {
    this.evaluationKey.fill(0); this.standingPolicyKey.fill(0); this.readyPolicyKey.fill(0);
  }
}
