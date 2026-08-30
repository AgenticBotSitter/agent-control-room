import type { CanonicalStore } from "../../persistence/canonical-store";
import { exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { readyFrontierMaterializationRequestSchemaV1 } from "./automation-schemas";
import type { ReadyFrontierMaterializationReceiptV1, ReadyFrontierMaterializationRequestV1 } from "./automation-types";
import type { ReadyFrontierSimulationStoreV1 } from "./durable-store";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { buildReadyFrontierMaterializationV1, persistReadyFrontierMaterializationV1 } from "./materialization";
import type { ReadyFrontierStandingPolicyStoreV1 } from "./standing-policy-store";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }

const materializationServices = new WeakSet<object>();

/** Repository-only materialization seam. It has no timer, scheduler, provider, agent, GitHub, or effect client. */
export class ReadyFrontierMaterializationServiceV1 {
  readonly #evaluationKey: Uint8Array; readonly #policyKey: Uint8Array;
  readonly #evaluations: ReadyFrontierSimulationStoreV1;
  readonly #policies: ReadyFrontierStandingPolicyStoreV1;
  readonly #canonicalStore: CanonicalStore;
  constructor(evaluations: ReadyFrontierSimulationStoreV1,
    policies: ReadyFrontierStandingPolicyStoreV1, canonicalStore: CanonicalStore,
    evaluationKeyValue: unknown, policyKeyValue: unknown) {
    const evaluationKey = exactHostUint8ArrayV1(evaluationKeyValue, 128), policyKey = exactHostUint8ArrayV1(policyKeyValue, 128);
    if (!evaluationKey || evaluationKey.byteLength < 32 || !policyKey || policyKey.byteLength < 32) fail("integrity_failed");
    this.#evaluations = evaluations; this.#policies = policies; this.#canonicalStore = canonicalStore;
    this.#evaluationKey = evaluationKey.copy(); this.#policyKey = policyKey.copy();
    materializationServices.add(this); Object.freeze(this);
  }
  async materialize(value: unknown): Promise<{ receipt: ReadyFrontierMaterializationReceiptV1; replayed: boolean }> {
    const request = parseExactReadyFrontierV1(readyFrontierMaterializationRequestSchemaV1, value) as ReadyFrontierMaterializationRequestV1;
    const evaluation = this.#evaluations.evaluation(request.cycleId); if (!evaluation) fail("integrity_failed");
    return this.#policies.withCurrentPolicy(request.standingPolicyId, request.standingPolicyRevision,
      request.standingPolicyDigest, async (policy) => {
        const receipt = buildReadyFrontierMaterializationV1({ request, evaluation, standingPolicy: policy }, this.#evaluationKey, this.#policyKey);
        return persistReadyFrontierMaterializationV1({ canonicalStore: this.#canonicalStore, receipt, integrityKey: this.#evaluationKey });
      });
  }
  close(): void { this.#evaluationKey.fill(0); this.#policyKey.fill(0); }
}

const materializeReadyFrontier = ReadyFrontierMaterializationServiceV1.prototype.materialize;
Object.freeze(ReadyFrontierMaterializationServiceV1.prototype);

/** Binds the exact accepted repository service without exposing a mutable collaborator alias. */
export function bindReadyFrontierMaterializationServiceV1(value: unknown):
  ((request: unknown) => Promise<{ receipt: ReadyFrontierMaterializationReceiptV1; replayed: boolean }>) | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !materializationServices.has(value)
    || Object.getPrototypeOf(value) !== ReadyFrontierMaterializationServiceV1.prototype
    || !Object.isFrozen(value)) return undefined;
  const service = value as ReadyFrontierMaterializationServiceV1;
  return (request: unknown) => materializeReadyFrontier.call(service, request);
}
