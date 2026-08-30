import type { CanonicalStore } from "../../persistence/canonical-store";
import { assertNoSecretMaterial } from "../../security";
import { exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
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

const promotionServices = new WeakSet<object>();

export interface ReadyFrontierTrustedClockV1 { now(): string; }

interface CanonicalPromotionAuthorizationBindingV1 {
  receipt: ReadyFrontierPromotionReceiptV1;
  standingPolicy: ReadyFrontierStandingPolicyV1;
  readyPolicy: ReadyFrontierReadyPolicyV1;
  materializedAt: string;
  authorizedAt: string;
  clock: ReadyFrontierTrustedClockV1;
  accepting: boolean;
  acquired: boolean;
  uses: Set<Promise<void>>;
}

export interface ReadyFrontierCanonicalPromotionAuthorizationUseV1 {
  receipt: ReadyFrontierPromotionReceiptV1;
  standingPolicy: ReadyFrontierStandingPolicyV1;
  readyPolicy: ReadyFrontierReadyPolicyV1;
  materializedAt: string;
  authorizedAt: string;
  now(): string;
  release(): void;
}

const activeCanonicalPromotionAuthorizations = new WeakMap<object, CanonicalPromotionAuthorizationBindingV1>();

function exactClone<T>(value: T): T { return exactReadyFrontierJsonV1(value) as T; }

/** CanonicalStore can acquire a use, but only this module can mint the opaque authorization object. */
export function acquireReadyFrontierCanonicalPromotionAuthorizationV1(
  value: unknown): ReadyFrontierCanonicalPromotionAuthorizationUseV1 | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  const binding = activeCanonicalPromotionAuthorizations.get(value as object);
  if (!binding?.accepting || binding.acquired) return undefined;
  binding.acquired = true;
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  binding.uses.add(completed);
  let released = false;
  return {
    receipt: exactClone(binding.receipt),
    standingPolicy: exactClone(binding.standingPolicy),
    readyPolicy: exactClone(binding.readyPolicy),
    materializedAt: binding.materializedAt,
    authorizedAt: binding.authorizedAt,
    now: () => binding.clock.now(),
    release: () => {
      if (released) return;
      released = true;
      binding.uses.delete(completed);
      finish();
    },
  };
}

async function withCanonicalPromotionAuthorizationV1<T>(bindingInput: Omit<CanonicalPromotionAuthorizationBindingV1,
  "accepting" | "acquired" | "uses">, operation: (authorization: object) => Promise<T>): Promise<T> {
  const authorization = Object.freeze(Object.create(null)) as object;
  const binding: CanonicalPromotionAuthorizationBindingV1 = {
    ...bindingInput, accepting: true, acquired: false, uses: new Set(),
  };
  activeCanonicalPromotionAuthorizations.set(authorization, binding);
  try {
    return await operation(authorization);
  } finally {
    binding.accepting = false;
    await Promise.allSettled([...binding.uses]);
    activeCanonicalPromotionAuthorizations.delete(authorization);
  }
}

async function persistPromotion(input: { canonicalStore: CanonicalStore; receipt: ReadyFrontierPromotionReceiptV1;
  standingPolicy: ReadyFrontierStandingPolicyV1; readyPolicy: ReadyFrontierReadyPolicyV1;
  operationAuthorization: object;
  evaluationKey: unknown; readyPolicyKey: unknown }):
  Promise<{ receipt: ReadyFrontierPromotionReceiptV1; replayed: boolean }> {
  const receipt = parseReadyFrontierPromotionV1(input.receipt, input.evaluationKey);
  const policy = parseReadyFrontierReadyPolicyV1(input.readyPolicy, input.readyPolicyKey);
  const project = policy.projectPolicies.find((item) => item.projectId === receipt.readyJob.projectId);
  if (!project || policy.policyId !== receipt.readyPolicyId || policy.revision !== receipt.readyPolicyRevision
    || policy.policyDigest !== receipt.readyPolicyDigest || project.resourceKey !== receipt.reservation.resourceKey
    || project.reservationUnits !== receipt.reservation.units
    || project.resourceCapacityUnits !== receipt.reservation.capacityUnits) fail("policy_denied");
  const result = await input.canonicalStore.promoteReadyFrontierJobWithInternalHandoff(input.operationAuthorization);
  return { receipt, replayed: result.replayed };
}

/** Repository-only ready bridge. It writes canonical readiness, database capacity, and an internal outbox packet only. */
export class ReadyFrontierPromotionServiceV1 {
  readonly #evaluationKey: Uint8Array;
  readonly #standingPolicyKey: Uint8Array;
  readonly #readyPolicyKey: Uint8Array;
  readonly #evaluations: ReadyFrontierSimulationStoreV1;
  readonly #standingPolicies: ReadyFrontierStandingPolicyStoreV1;
  readonly #readyPolicies: ReadyFrontierReadyPolicyStoreV1;
  readonly #canonicalStore: CanonicalStore;
  readonly #clock: ReadyFrontierTrustedClockV1;

  constructor(evaluations: ReadyFrontierSimulationStoreV1,
    standingPolicies: ReadyFrontierStandingPolicyStoreV1,
    readyPolicies: ReadyFrontierReadyPolicyStoreV1,
    canonicalStore: CanonicalStore,
    evaluationKeyValue: unknown, standingPolicyKeyValue: unknown, readyPolicyKeyValue: unknown,
    clock: ReadyFrontierTrustedClockV1) {
    const evaluationKey = exactHostUint8ArrayV1(evaluationKeyValue, 128);
    const standingPolicyKey = exactHostUint8ArrayV1(standingPolicyKeyValue, 128);
    const readyPolicyKey = exactHostUint8ArrayV1(readyPolicyKeyValue, 128);
    if (!evaluationKey || evaluationKey.byteLength < 32 || !standingPolicyKey || standingPolicyKey.byteLength < 32
      || !readyPolicyKey || readyPolicyKey.byteLength < 32) fail("integrity_failed");
    this.#evaluations = evaluations; this.#standingPolicies = standingPolicies;
    this.#readyPolicies = readyPolicies; this.#canonicalStore = canonicalStore; this.#clock = clock;
    this.#evaluationKey = evaluationKey.copy(); this.#standingPolicyKey = standingPolicyKey.copy();
    this.#readyPolicyKey = readyPolicyKey.copy(); promotionServices.add(this); Object.freeze(this);
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
    const evaluation = this.#evaluations.evaluation(materialization.cycleId);
    if (!evaluation) fail("integrity_failed");
    return this.#standingPolicies.withCurrentPolicy(request.standingPolicyId, request.standingPolicyRevision,
      request.standingPolicyDigest, (standingPolicy) => this.#readyPolicies.withCurrentPolicy(request.readyPolicyId,
        request.readyPolicyRevision, request.readyPolicyDigest, async (readyPolicy) => {
          let trustedNow: string;
          try { trustedNow = this.#clock.now(); } catch { fail("integrity_failed"); }
          const receipt = buildReadyFrontierPromotionV1(envelope, this.#evaluationKey, this.#standingPolicyKey,
            this.#readyPolicyKey, evaluation, standingPolicy, readyPolicy, trustedNow);
          return withCanonicalPromotionAuthorizationV1({ receipt, standingPolicy, readyPolicy,
            materializedAt: materialization.materializedAt, authorizedAt: trustedNow, clock: this.#clock },
          (operationAuthorization) => persistPromotion({ canonicalStore: this.#canonicalStore, receipt,
            standingPolicy, readyPolicy, operationAuthorization,
            evaluationKey: this.#evaluationKey, readyPolicyKey: this.#readyPolicyKey }));
        }));
  }

  close(): void {
    this.#evaluationKey.fill(0); this.#standingPolicyKey.fill(0); this.#readyPolicyKey.fill(0);
  }
}

const promoteReadyFrontier = ReadyFrontierPromotionServiceV1.prototype.promote;
Object.freeze(ReadyFrontierPromotionServiceV1.prototype);

/** Binds the exact accepted repository service without exposing a mutable collaborator alias. */
export function bindReadyFrontierPromotionServiceV1(value: unknown):
  ((request: unknown) => Promise<{ receipt: ReadyFrontierPromotionReceiptV1; replayed: boolean }>) | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !promotionServices.has(value)
    || Object.getPrototypeOf(value) !== ReadyFrontierPromotionServiceV1.prototype
    || !Object.isFrozen(value)) return undefined;
  const service = value as ReadyFrontierPromotionServiceV1;
  return (request: unknown) => promoteReadyFrontier.call(service, request);
}
