import type { CanonicalStore } from "../../persistence/canonical-store";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { readyFrontierMaterializationRequestSchemaV1 } from "./automation-schemas";
import type { ReadyFrontierMaterializationReceiptV1, ReadyFrontierMaterializationRequestV1 } from "./automation-types";
import type { ReadyFrontierSimulationStoreV1 } from "./durable-store";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { buildReadyFrontierMaterializationV1, persistReadyFrontierMaterializationV1 } from "./materialization";
import type { ReadyFrontierStandingPolicyStoreV1 } from "./standing-policy-store";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }

/** Repository-only materialization seam. It has no timer, scheduler, provider, agent, GitHub, or effect client. */
export class ReadyFrontierMaterializationServiceV1 {
  private readonly evaluationKey: Uint8Array; private readonly policyKey: Uint8Array;
  constructor(private readonly evaluations: ReadyFrontierSimulationStoreV1,
    private readonly policies: ReadyFrontierStandingPolicyStoreV1, private readonly canonicalStore: CanonicalStore,
    evaluationKeyValue: unknown, policyKeyValue: unknown) {
    const evaluationKey = exactHostUint8ArrayV1(evaluationKeyValue, 128), policyKey = exactHostUint8ArrayV1(policyKeyValue, 128);
    if (!evaluationKey || evaluationKey.byteLength < 32 || !policyKey || policyKey.byteLength < 32) fail("integrity_failed");
    this.evaluationKey = evaluationKey.copy(); this.policyKey = policyKey.copy();
  }
  async materialize(value: unknown): Promise<{ receipt: ReadyFrontierMaterializationReceiptV1; replayed: boolean }> {
    const request = parseExactReadyFrontierV1(readyFrontierMaterializationRequestSchemaV1, value) as ReadyFrontierMaterializationRequestV1;
    const evaluation = this.evaluations.evaluation(request.cycleId); if (!evaluation) fail("integrity_failed");
    return this.policies.withCurrentPolicy(request.standingPolicyId, request.standingPolicyRevision,
      request.standingPolicyDigest, async (policy) => {
        const receipt = buildReadyFrontierMaterializationV1({ request, evaluation, standingPolicy: policy }, this.evaluationKey, this.policyKey);
        return persistReadyFrontierMaterializationV1({ canonicalStore: this.canonicalStore, receipt, integrityKey: this.evaluationKey });
      });
  }
  close(): void { this.evaluationKey.fill(0); this.policyKey.fill(0); }
}
