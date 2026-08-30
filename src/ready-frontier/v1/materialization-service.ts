import { bindReadyFrontierCanonicalOperationsV1, type CanonicalStore,
  type ReadyFrontierCanonicalOperationsV1 } from "../../persistence/canonical-store";
import { exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { readyFrontierMaterializationRequestSchemaV1 } from "./automation-schemas";
import type { ReadyFrontierMaterializationReceiptV1, ReadyFrontierMaterializationRequestV1 } from "./automation-types";
import { bindReadyFrontierSimulationEvaluationV1, type ReadyFrontierSimulationStoreV1 } from "./durable-store";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { buildReadyFrontierMaterializationV1, parseReadyFrontierMaterializationV1 } from "./materialization";
import { bindReadyFrontierStandingPolicyGuardV1, type ReadyFrontierBoundStandingPolicyGuardV1,
  type ReadyFrontierStandingPolicyStoreV1 } from "./standing-policy-store";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }

const materializationServices = new WeakSet<object>();

/** Repository-only materialization seam. It has no timer, scheduler, provider, agent, GitHub, or effect client. */
export class ReadyFrontierMaterializationServiceV1 {
  readonly #evaluationKey: Uint8Array; readonly #policyKey: Uint8Array;
  readonly #evaluation: NonNullable<ReturnType<typeof bindReadyFrontierSimulationEvaluationV1>>;
  readonly #withPolicy: ReadyFrontierBoundStandingPolicyGuardV1;
  readonly #createProposedWorkBundle: ReadyFrontierCanonicalOperationsV1["createProposedWorkBundle"];
  constructor(evaluations: ReadyFrontierSimulationStoreV1,
    policies: ReadyFrontierStandingPolicyStoreV1, canonicalStore: CanonicalStore,
    evaluationKeyValue: unknown, policyKeyValue: unknown) {
    const evaluationKey = exactHostUint8ArrayV1(evaluationKeyValue, 128), policyKey = exactHostUint8ArrayV1(policyKeyValue, 128);
    const evaluation = bindReadyFrontierSimulationEvaluationV1(evaluations);
    const withPolicy = bindReadyFrontierStandingPolicyGuardV1(policies);
    const canonical = bindReadyFrontierCanonicalOperationsV1(canonicalStore);
    if (!evaluationKey || evaluationKey.byteLength < 32 || !policyKey || policyKey.byteLength < 32
      || !evaluation || !withPolicy || !canonical) fail("integrity_failed");
    this.#evaluation = evaluation; this.#withPolicy = withPolicy;
    this.#createProposedWorkBundle = canonical.createProposedWorkBundle;
    this.#evaluationKey = evaluationKey.copy(); this.#policyKey = policyKey.copy();
    materializationServices.add(this); Object.freeze(this);
  }
  async materialize(value: unknown): Promise<{ receipt: ReadyFrontierMaterializationReceiptV1; replayed: boolean }> {
    const request = parseExactReadyFrontierV1(readyFrontierMaterializationRequestSchemaV1, value) as ReadyFrontierMaterializationRequestV1;
    const evaluation = this.#evaluation(request.cycleId); if (!evaluation) fail("integrity_failed");
    return this.#withPolicy(request.standingPolicyId, request.standingPolicyRevision,
      request.standingPolicyDigest, async (policy) => {
        const built = buildReadyFrontierMaterializationV1({ request, evaluation, standingPolicy: policy }, this.#evaluationKey, this.#policyKey);
        const receipt = parseReadyFrontierMaterializationV1(built, this.#evaluationKey);
        const result = await this.#createProposedWorkBundle({ request: receipt.request, workflow: receipt.workflow,
          job: receipt.job, actionInbox: receipt.actionInbox });
        return { receipt, replayed: result.replayed };
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
