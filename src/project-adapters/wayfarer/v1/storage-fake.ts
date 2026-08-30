import { z } from "zod";
import { exactProjectWorkspaceJsonV1, ProjectWorkspaceContractErrorV1, projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { sha256Digest } from "../../../security";
import { evaluateWayfarerStorageAttemptV1, parseWayfarerStorageAttemptOutcomeV1, parseWayfarerStoragePlanV1,
  parseWayfarerStoragePolicyV1 } from "./storage-contract";
import { WAYFARER_LOCAL_STORE_ID_V1, WAYFARER_R2_STORE_ID_V1, type WayfarerStorageAttemptOutcomeV1,
  type WayfarerStoragePolicyV1, type WayfarerStoreIdV1 } from "./storage-types";

export const WAYFARER_FAKE_STORAGE_ADAPTER_V1 = "control-room-wayfarer-fake-storage/v1" as const;
export type WayfarerFakeStorageSafeCodeV1 = "fake_invalid" | "fake_scope_mismatch" | "fake_replay_conflict"
  | "fake_no_overwrite" | "fake_capacity";

export class WayfarerFakeStorageErrorV1 extends Error {
  constructor(readonly safeCode: WayfarerFakeStorageSafeCodeV1) { super(safeCode); this.name = "WayfarerFakeStorageErrorV1"; }
}

export interface WayfarerFakeStoreCapacityV1 {
  storeId: WayfarerStoreIdV1;
  maximumObjects: number;
  maximumBytes: number;
}
export interface WayfarerFakeStorageReceiptV1 {
  contractVersion: typeof WAYFARER_FAKE_STORAGE_ADAPTER_V1;
  receiptId: string;
  policyDigest: string;
  planId: string;
  planDigest: string;
  objectKeyDigest: string;
  attemptNumber: 1 | 2;
  outcome: WayfarerStorageAttemptOutcomeV1;
  outcomeDigest: string;
  replayed: boolean;
  objectMetadataRecorded: boolean;
  quarantineRecorded: boolean;
  ambiguityHeld: boolean;
  accountedObjectCount: 0 | 1;
  accountedBytes: number;
  metadataOnly: true;
  storesBytes: false;
  storesLocator: false;
  resolvesLocator: false;
  resolvesCredential: false;
  usesFilesystem: false;
  usesNetwork: false;
  usesObjectStorage: false;
  canDispatch: false;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}
export interface WayfarerFakeStorageInventoryV1 {
  storeId: WayfarerStoreIdV1;
  accountedObjectCount: number;
  accountedBytes: number;
  maximumObjects: number;
  maximumBytes: number;
  containsObjectIdentity: false;
  containsLocator: false;
  containsBytes: false;
}

const storeIdSchema = z.enum([WAYFARER_LOCAL_STORE_ID_V1, WAYFARER_R2_STORE_ID_V1]);
const capacitySchema = z.object({ storeId: storeIdSchema, maximumObjects: z.number().int().positive().max(10_000),
  maximumBytes: z.number().int().positive().max(68_719_476_736) }).strict();
const observationSchema = z.object({ observationCode: z.enum(["simulated_store_verified", "definite_pre_marker_failure",
  "capacity_unavailable_pre_marker", "integrity_mismatch_after_marker", "post_marker_outcome_unknown", "restart_after_marker"]),
  markerRecorded: z.boolean(), observedContentDigest: digest.optional(), observedSizeBytes: z.number().int().positive().optional(),
  safeEvidenceDigest: digest }).strict();
const applySchema = z.object({ plan: z.unknown(), attemptNumber: z.union([z.literal(1), z.literal(2)]),
  previousOutcome: z.unknown().optional(), observation: observationSchema, startedAt: time, settledAt: time }).strict();
const outcomeSchema = z.unknown();
const receiptSchema = z.object({ contractVersion: z.literal(WAYFARER_FAKE_STORAGE_ADAPTER_V1), receiptId: id,
  policyDigest: digest, planId: id, planDigest: digest, objectKeyDigest: digest,
  attemptNumber: z.union([z.literal(1), z.literal(2)]), outcome: outcomeSchema, outcomeDigest: digest, replayed: z.boolean(),
  objectMetadataRecorded: z.boolean(), quarantineRecorded: z.boolean(), ambiguityHeld: z.boolean(),
  accountedObjectCount: z.union([z.literal(0), z.literal(1)]), accountedBytes: z.number().int().nonnegative().max(34_359_738_368),
  metadataOnly: z.literal(true), storesBytes: z.literal(false), storesLocator: z.literal(false), resolvesLocator: z.literal(false),
  resolvesCredential: z.literal(false), usesFilesystem: z.literal(false), usesNetwork: z.literal(false), usesObjectStorage: z.literal(false),
  canDispatch: z.literal(false), externalEffectOccurred: z.literal(false), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), receiptDigest: digest }).strict();

function exact<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(exactProjectWorkspaceJsonV1(value)); }
  catch (error) { if (error instanceof ProjectWorkspaceContractErrorV1) throw error; throw new WayfarerFakeStorageErrorV1("fake_invalid"); }
}
function digestWithout(value: Record<string, unknown>, key: string) { const copy = { ...value }; delete copy[key]; return sha256Digest(copy); }
function receiptMaterial(outcome: WayfarerStorageAttemptOutcomeV1) {
  const objectMetadataRecorded = outcome.disposition === "simulated_verified", quarantineRecorded = outcome.disposition === "quarantined",
    ambiguityHeld = outcome.disposition === "ambiguous", accounted = objectMetadataRecorded || quarantineRecorded || ambiguityHeld;
  return { objectMetadataRecorded, quarantineRecorded, ambiguityHeld, accountedObjectCount: accounted ? 1 as const : 0 as const,
    accountedBytes: accounted ? outcome.expectedSizeBytes : 0 };
}

export function parseWayfarerFakeStorageReceiptV1(value: unknown): WayfarerFakeStorageReceiptV1 {
  const parsed = exact(receiptSchema, value) as WayfarerFakeStorageReceiptV1,
    outcome = parseWayfarerStorageAttemptOutcomeV1(parsed.outcome), expected = receiptMaterial(outcome);
  if (parsed.outcomeDigest !== outcome.outcomeDigest || parsed.planDigest !== outcome.planDigest || parsed.policyDigest !== outcome.policyDigest
    || parsed.attemptNumber !== outcome.attemptNumber || parsed.receiptId !== `fake-storage-receipt:wayfarer:${outcome.outcomeDigest.slice(7, 31)}`
    || Object.entries(expected).some(([key, expectedValue]) => parsed[key as keyof WayfarerFakeStorageReceiptV1] !== expectedValue)) {
    throw new WayfarerFakeStorageErrorV1("fake_replay_conflict");
  }
  if (digestWithout(parsed as unknown as Record<string, unknown>, "receiptDigest") !== parsed.receiptDigest) {
    throw new WayfarerFakeStorageErrorV1("fake_replay_conflict");
  }
  return { ...parsed, outcome };
}

export class WayfarerFakeStorageAdapterV1 {
  readonly #policy: WayfarerStoragePolicyV1;
  readonly #capacity = new Map<WayfarerStoreIdV1, WayfarerFakeStoreCapacityV1>();
  readonly #claims = new Map<string, string>();
  readonly #attempts = new Map<string, WayfarerFakeStorageReceiptV1>();
  readonly #accounted = new Map<string, { storeId: WayfarerStoreIdV1; bytes: number }>();

  constructor(policyValue: unknown, capacitiesValue: unknown) {
    this.#policy = parseWayfarerStoragePolicyV1(policyValue);
    const capacities = exact(z.array(capacitySchema).length(2), capacitiesValue) as WayfarerFakeStoreCapacityV1[];
    if (capacities.map((value) => value.storeId).join("|") !== `${WAYFARER_LOCAL_STORE_ID_V1}|${WAYFARER_R2_STORE_ID_V1}`) {
      throw new WayfarerFakeStorageErrorV1("fake_invalid");
    }
    for (const capacity of capacities) {
      const ceiling = this.#policy.stores.find((store) => store.storeId === capacity.storeId)!;
      if (capacity.maximumObjects > ceiling.maximumOutstandingObjects || capacity.maximumBytes > ceiling.maximumReservationBytes) {
        throw new WayfarerFakeStorageErrorV1("fake_invalid");
      }
      this.#capacity.set(capacity.storeId, { ...capacity });
    }
  }

  apply(inputValue: unknown): WayfarerFakeStorageReceiptV1 {
    const input = exact(applySchema, inputValue), plan = parseWayfarerStoragePlanV1(input.plan),
      previous = input.previousOutcome === undefined ? undefined : parseWayfarerStorageAttemptOutcomeV1(input.previousOutcome);
    if (plan.policyDigest !== this.#policy.policyDigest || plan.policyId !== this.#policy.policyId) {
      throw new WayfarerFakeStorageErrorV1("fake_scope_mismatch");
    }
    const attemptKey = `${plan.planDigest}:${input.attemptNumber}`, priorAttempt = this.#attempts.get(attemptKey),
      inputFingerprint = sha256Digest({ planDigest: plan.planDigest, attemptNumber: input.attemptNumber,
        previousOutcomeDigest: previous?.outcomeDigest ?? null, observation: input.observation, startedAt: input.startedAt, settledAt: input.settledAt });
    if (priorAttempt) {
      const priorFingerprint = sha256Digest({ planDigest: plan.planDigest, attemptNumber: priorAttempt.attemptNumber,
        previousOutcomeDigest: priorAttempt.outcome.previousOutcomeDigest ?? null, observation: priorAttempt.outcome.observation,
        startedAt: priorAttempt.outcome.startedAt, settledAt: priorAttempt.outcome.settledAt });
      if (priorFingerprint !== inputFingerprint) throw new WayfarerFakeStorageErrorV1("fake_replay_conflict");
      const replayMaterial = { ...priorAttempt, replayed: true };
      return parseWayfarerFakeStorageReceiptV1({ ...replayMaterial,
        receiptDigest: digestWithout(replayMaterial as unknown as Record<string, unknown>, "receiptDigest") });
    }
    const claimedPlan = this.#claims.get(plan.planId);
    if (claimedPlan && claimedPlan !== plan.planDigest) throw new WayfarerFakeStorageErrorV1("fake_no_overwrite");
    const objectClaim = this.#claims.get(plan.objectKeyDigest);
    if (objectClaim && objectClaim !== plan.planDigest) throw new WayfarerFakeStorageErrorV1("fake_no_overwrite");
    const current = this.inventory(plan.storeId), capacity = this.#capacity.get(plan.storeId)!;
    const wouldAccount = ["simulated_store_verified", "integrity_mismatch_after_marker", "post_marker_outcome_unknown", "restart_after_marker"]
      .includes(input.observation.observationCode);
    if (wouldAccount && (current.accountedObjectCount + 1 > capacity.maximumObjects
      || current.accountedBytes + plan.artifact.sizeBytes > capacity.maximumBytes)) throw new WayfarerFakeStorageErrorV1("fake_capacity");
    const outcome = evaluateWayfarerStorageAttemptV1({ policy: this.#policy, plan, attemptNumber: input.attemptNumber,
      ...(previous ? { previousOutcome: previous } : {}), observation: input.observation, startedAt: input.startedAt, settledAt: input.settledAt }),
      expected = receiptMaterial(outcome), unsigned: Omit<WayfarerFakeStorageReceiptV1, "receiptDigest"> = {
        contractVersion: WAYFARER_FAKE_STORAGE_ADAPTER_V1,
        receiptId: `fake-storage-receipt:wayfarer:${outcome.outcomeDigest.slice(7, 31)}`, policyDigest: this.#policy.policyDigest,
        planId: plan.planId, planDigest: plan.planDigest, objectKeyDigest: plan.objectKeyDigest, attemptNumber: input.attemptNumber,
        outcome, outcomeDigest: outcome.outcomeDigest, replayed: false, ...expected, metadataOnly: true, storesBytes: false,
        storesLocator: false, resolvesLocator: false, resolvesCredential: false, usesFilesystem: false, usesNetwork: false,
        usesObjectStorage: false, canDispatch: false, externalEffectOccurred: false, grantsApproval: false,
        grantsDeletionAuthority: false, grantsExecutionAuthority: false },
      receipt = parseWayfarerFakeStorageReceiptV1({ ...unsigned, receiptDigest: sha256Digest(unsigned) });
    this.#claims.set(plan.planId, plan.planDigest); this.#claims.set(plan.objectKeyDigest, plan.planDigest); this.#attempts.set(attemptKey, receipt);
    if (expected.accountedObjectCount === 1) this.#accounted.set(plan.objectKeyDigest, { storeId: plan.storeId, bytes: plan.artifact.sizeBytes });
    return receipt;
  }

  inventory(storeIdValue: WayfarerStoreIdV1): WayfarerFakeStorageInventoryV1 {
    const capacity = this.#capacity.get(storeIdValue);
    if (!capacity) throw new WayfarerFakeStorageErrorV1("fake_invalid");
    const values = [...this.#accounted.values()].filter((item) => item.storeId === storeIdValue);
    return { storeId: storeIdValue, accountedObjectCount: values.length, accountedBytes: values.reduce((sum, item) => sum + item.bytes, 0),
      maximumObjects: capacity.maximumObjects, maximumBytes: capacity.maximumBytes, containsObjectIdentity: false,
      containsLocator: false, containsBytes: false };
  }
}

export function buildWayfarerDefaultFakeStorageCapacitiesV1(): [WayfarerFakeStoreCapacityV1, WayfarerFakeStoreCapacityV1] {
  return [{ storeId: WAYFARER_LOCAL_STORE_ID_V1, maximumObjects: 8, maximumBytes: 8_589_934_592 },
    { storeId: WAYFARER_R2_STORE_ID_V1, maximumObjects: 16, maximumBytes: 17_179_869_184 }];
}

export const wayfarerFakeStorageSchemasV1 = { capacity: capacitySchema, receipt: receiptSchema } as const;
