import { bindReadyFrontierCanonicalOperationsV1, bindReadyFrontierRepositoryCanonicalOperationsV1, type CanonicalStore,
  type ReadyFrontierCanonicalOperationsV1 } from "../../persistence/canonical-store";
import { assertNoSecretMaterial } from "../../security";
import { exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { bindReadyFrontierSimulationEvaluationV1, type ReadyFrontierSimulationStoreV1 } from "./durable-store";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { exactReadyFrontierJsonV1 } from "./exact";
import { buildReadyFrontierPromotionV1, parseReadyFrontierPromotionV1 } from "./promotion";
import { parseReadyFrontierReadyPolicyV1 } from "./ready-policy";
import { readyFrontierPromotionBuildInputSchemaV1 } from "./ready-policy-schemas";
import type { ReadyFrontierPromotionBuildInputV1, ReadyFrontierPromotionReceiptV1,
  ReadyFrontierReadyPolicyV1 } from "./ready-policy-types";
import type { ReadyFrontierStandingPolicyV1 } from "./automation-types";
import { bindReadyFrontierFixedRepositoryClockV1 } from "./no-relay-coordinator";
import { bindReadyFrontierReadyPolicyGuardV1, type ReadyFrontierBoundReadyPolicyGuardV1,
  type ReadyFrontierReadyPolicyStoreV1 } from "./ready-policy-store";
import { bindReadyFrontierStandingPolicyGuardV1, type ReadyFrontierBoundStandingPolicyGuardV1,
  type ReadyFrontierStandingPolicyStoreV1 } from "./standing-policy-store";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }

const promotionServices = new WeakSet<object>();
const repositoryPromotionServices = new WeakSet<object>();

export interface ReadyFrontierTrustedClockV1 { now(): string; }

interface CanonicalPromotionAuthorizationBindingV1 {
  receipt: ReadyFrontierPromotionReceiptV1;
  standingPolicy: ReadyFrontierStandingPolicyV1;
  readyPolicy: ReadyFrontierReadyPolicyV1;
  materializedAt: string;
  authorizedAt: string;
  now: () => string;
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
    now: () => binding.now(),
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

async function persistPromotion(input: { promoteWithInternalHandoff: ReadyFrontierCanonicalOperationsV1["promoteWithInternalHandoff"];
  receipt: ReadyFrontierPromotionReceiptV1;
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
  const result = await input.promoteWithInternalHandoff(input.operationAuthorization);
  return { receipt, replayed: result.replayed };
}

function captureTrustedClockNowV1(clock: ReadyFrontierTrustedClockV1): (() => string) | undefined {
  if (!clock || (typeof clock !== "object" && typeof clock !== "function") || isHostProxyV1(clock)) return undefined;
  const own = Object.getOwnPropertyDescriptor(clock, "now");
  const inherited = own ? undefined : Object.getOwnPropertyDescriptor(Object.getPrototypeOf(clock) as object, "now");
  const descriptor = own ?? inherited;
  if (!descriptor || typeof descriptor.value !== "function" || descriptor.get || descriptor.set) return undefined;
  const now = descriptor.value as () => string;
  return () => now.call(clock);
}

/** Repository-only ready bridge. It writes canonical readiness, database capacity, and an internal outbox packet only. */
export class ReadyFrontierPromotionServiceV1 {
  readonly #evaluationKey: Uint8Array;
  readonly #standingPolicyKey: Uint8Array;
  readonly #readyPolicyKey: Uint8Array;
  readonly #evaluation: NonNullable<ReturnType<typeof bindReadyFrontierSimulationEvaluationV1>>;
  readonly #withStandingPolicy: ReadyFrontierBoundStandingPolicyGuardV1;
  readonly #withReadyPolicy: ReadyFrontierBoundReadyPolicyGuardV1;
  readonly #promoteWithInternalHandoff: ReadyFrontierCanonicalOperationsV1["promoteWithInternalHandoff"];
  readonly #now: () => string;

  constructor(evaluations: ReadyFrontierSimulationStoreV1,
    standingPolicies: ReadyFrontierStandingPolicyStoreV1,
    readyPolicies: ReadyFrontierReadyPolicyStoreV1,
    canonicalStore: CanonicalStore,
    evaluationKeyValue: unknown, standingPolicyKeyValue: unknown, readyPolicyKeyValue: unknown,
    clock: ReadyFrontierTrustedClockV1) {
    const evaluationKey = exactHostUint8ArrayV1(evaluationKeyValue, 128);
    const standingPolicyKey = exactHostUint8ArrayV1(standingPolicyKeyValue, 128);
    const readyPolicyKey = exactHostUint8ArrayV1(readyPolicyKeyValue, 128);
    const evaluation = bindReadyFrontierSimulationEvaluationV1(evaluations);
    const withStandingPolicy = bindReadyFrontierStandingPolicyGuardV1(standingPolicies);
    const withReadyPolicy = bindReadyFrontierReadyPolicyGuardV1(readyPolicies);
    const canonical = bindReadyFrontierCanonicalOperationsV1(canonicalStore);
    const repositoryCanonical = bindReadyFrontierRepositoryCanonicalOperationsV1(canonicalStore);
    const repositoryNow = bindReadyFrontierFixedRepositoryClockV1(clock);
    const genericNow = captureTrustedClockNowV1(clock);
    if (!evaluationKey || evaluationKey.byteLength < 32 || !standingPolicyKey || standingPolicyKey.byteLength < 32
      || !readyPolicyKey || readyPolicyKey.byteLength < 32 || !evaluation || !withStandingPolicy
      || !withReadyPolicy || !canonical || !genericNow) fail("integrity_failed");
    this.#evaluation = evaluation; this.#withStandingPolicy = withStandingPolicy;
    this.#withReadyPolicy = withReadyPolicy; this.#promoteWithInternalHandoff = canonical.promoteWithInternalHandoff;
    this.#now = repositoryNow ?? genericNow;
    this.#evaluationKey = evaluationKey.copy(); this.#standingPolicyKey = standingPolicyKey.copy();
    this.#readyPolicyKey = readyPolicyKey.copy(); promotionServices.add(this);
    if (repositoryNow && repositoryCanonical) repositoryPromotionServices.add(this); Object.freeze(this);
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
    const evaluation = this.#evaluation(materialization.cycleId);
    if (!evaluation) fail("integrity_failed");
    return this.#withStandingPolicy(request.standingPolicyId, request.standingPolicyRevision,
      request.standingPolicyDigest, (standingPolicy) => this.#withReadyPolicy(request.readyPolicyId,
        request.readyPolicyRevision, request.readyPolicyDigest, async (readyPolicy) => {
          let trustedNow: string;
          try { trustedNow = this.#now(); } catch { fail("integrity_failed"); }
          const receipt = buildReadyFrontierPromotionV1(envelope, this.#evaluationKey, this.#standingPolicyKey,
            this.#readyPolicyKey, evaluation, standingPolicy, readyPolicy, trustedNow);
          return withCanonicalPromotionAuthorizationV1({ receipt, standingPolicy, readyPolicy,
            materializedAt: materialization.materializedAt, authorizedAt: trustedNow, now: this.#now },
          (operationAuthorization) => persistPromotion({ promoteWithInternalHandoff: this.#promoteWithInternalHandoff, receipt,
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
    || !repositoryPromotionServices.has(value)
    || Object.getPrototypeOf(value) !== ReadyFrontierPromotionServiceV1.prototype
    || !Object.isFrozen(value)) return undefined;
  const service = value as ReadyFrontierPromotionServiceV1;
  return (request: unknown) => promoteReadyFrontier.call(service, request);
}
