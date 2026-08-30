import assert from "node:assert/strict";
import test from "node:test";
import { WAYFARER_LOCAL_STORE_ID_V1, WAYFARER_R2_STORE_ID_V1, WayfarerFakeStorageAdapterV1,
  WayfarerFakeStorageErrorV1, buildWayfarerDefaultFakeStorageCapacitiesV1, buildWayfarerStoragePlanV1,
  buildWayfarerStoragePolicyV1, buildWayfarerSyntheticProjectPackV1, parseWayfarerFakeStorageReceiptV1,
  type WayfarerStorageArtifactDeclarationV1,
} from "../src/project-adapters/wayfarer/v1";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const plannedAt = "2026-08-29T21:02:00.000Z";
function setup(storeId: typeof WAYFARER_LOCAL_STORE_ID_V1 | typeof WAYFARER_R2_STORE_ID_V1 = WAYFARER_LOCAL_STORE_ID_V1,
  artifactOverrides: Partial<WayfarerStorageArtifactDeclarationV1> = {}) {
  const pack = buildWayfarerSyntheticProjectPackV1(), policy = buildWayfarerStoragePolicyV1({ pack, createdAt: "2026-08-29T21:00:00.000Z" }),
    artifact: WayfarerStorageArtifactDeclarationV1 = { artifactId: "artifact:wayfarer:fake:render", episodeId: "episode:wayfarer:fake",
      role: "render_segment", contentType: "video/mp4", contentDigest: sha256Digest({ fake: "render" }), sizeBytes: 1_048_576,
      createdAt: "2026-08-29T21:01:00.000Z", ...artifactOverrides },
    plan = buildWayfarerStoragePlanV1({ policy, pack, storeId, artifact, plannedAt });
  return { pack, policy, artifact, plan, adapter: new WayfarerFakeStorageAdapterV1(policy, buildWayfarerDefaultFakeStorageCapacitiesV1()) };
}
function observation(plan: ReturnType<typeof setup>["plan"], code: "simulated_store_verified" | "definite_pre_marker_failure"
  | "integrity_mismatch_after_marker" | "post_marker_outcome_unknown" | "restart_after_marker") {
  const base = { observationCode: code, safeEvidenceDigest: sha256Digest({ code }) };
  if (code === "simulated_store_verified") return { ...base, markerRecorded: true, observedContentDigest: plan.artifact.contentDigest,
    observedSizeBytes: plan.artifact.sizeBytes };
  if (code === "integrity_mismatch_after_marker") return { ...base, markerRecorded: true,
    observedContentDigest: sha256Digest({ wrong: true }), observedSizeBytes: plan.artifact.sizeBytes };
  return { ...base, markerRecorded: code === "post_marker_outcome_unknown" || code === "restart_after_marker" };
}
function applyInput(plan: ReturnType<typeof setup>["plan"], code: Parameters<typeof observation>[1]) {
  return { plan, attemptNumber: 1 as const, observation: observation(plan, code), startedAt: "2026-08-29T21:03:00.000Z",
    settledAt: "2026-08-29T21:04:00.000Z" };
}
function rehash<T extends Record<string, unknown>>(value: T, field: string) { const copy = { ...value }; delete copy[field];
  return { ...copy, [field]: sha256Digest(copy) }; }

test("CR9B-WF-050 fake storage records only verified metadata and never bytes, locators, storage, or effects", () => {
  const { adapter, plan } = setup(), receipt = adapter.apply(applyInput(plan, "simulated_store_verified"));
  assert.equal(receipt.objectMetadataRecorded, true); assert.equal(receipt.accountedBytes, plan.artifact.sizeBytes);
  assert.equal(receipt.metadataOnly && !receipt.storesBytes && !receipt.storesLocator && !receipt.resolvesLocator
    && !receipt.resolvesCredential && !receipt.usesFilesystem && !receipt.usesNetwork && !receipt.usesObjectStorage
    && !receipt.canDispatch && !receipt.externalEffectOccurred && !receipt.grantsExecutionAuthority, true);
  assert.deepEqual(adapter.inventory(WAYFARER_LOCAL_STORE_ID_V1), { storeId: WAYFARER_LOCAL_STORE_ID_V1,
    accountedObjectCount: 1, accountedBytes: plan.artifact.sizeBytes, maximumObjects: 8, maximumBytes: 8_589_934_592,
    containsObjectIdentity: false, containsLocator: false, containsBytes: false });
  assert.deepEqual(parseWayfarerFakeStorageReceiptV1(receipt), receipt);
});

test("CR9B-WF-050 exact replay returns a replay receipt without double-accounting", () => {
  const { adapter, plan } = setup(), input = applyInput(plan, "simulated_store_verified"), first = adapter.apply(input), replay = adapter.apply(input);
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(replay.outcomeDigest, first.outcomeDigest);
  assert.equal(adapter.inventory(WAYFARER_LOCAL_STORE_ID_V1).accountedObjectCount, 1);
  assert.notEqual(replay.receiptDigest, first.receiptDigest);
});

test("CR9B-WF-050 same attempt drift and same immutable object under a changed plan fail closed", () => {
  const { adapter, policy, pack, artifact, plan } = setup(); adapter.apply(applyInput(plan, "simulated_store_verified"));
  assert.throws(() => adapter.apply({ ...applyInput(plan, "simulated_store_verified"), settledAt: "2026-08-29T21:04:01.000Z" }),
    (error: unknown) => error instanceof WayfarerFakeStorageErrorV1 && error.safeCode === "fake_replay_conflict");
  const changedPlan = buildWayfarerStoragePlanV1({ policy, pack, storeId: WAYFARER_LOCAL_STORE_ID_V1, artifact,
    plannedAt: "2026-08-29T21:02:01.000Z" });
  assert.equal(changedPlan.objectKeyDigest, plan.objectKeyDigest); assert.notEqual(changedPlan.planDigest, plan.planDigest);
  assert.throws(() => adapter.apply(applyInput(changedPlan, "simulated_store_verified")),
    (error: unknown) => error instanceof WayfarerFakeStorageErrorV1 && error.safeCode === "fake_no_overwrite");
});

test("CR9B-WF-050 definite pre-marker failure consumes no capacity and one bounded retry may succeed", () => {
  const { adapter, plan } = setup(), first = adapter.apply(applyInput(plan, "definite_pre_marker_failure"));
  assert.equal(first.outcome.retryAllowed, true); assert.equal(first.accountedObjectCount, 0);
  assert.equal(adapter.inventory(WAYFARER_LOCAL_STORE_ID_V1).accountedObjectCount, 0);
  const second = adapter.apply({ plan, attemptNumber: 2, previousOutcome: first.outcome,
    observation: observation(plan, "simulated_store_verified"), startedAt: "2026-08-29T21:05:00.000Z",
    settledAt: "2026-08-29T21:06:00.000Z" });
  assert.equal(second.outcome.disposition, "simulated_verified"); assert.equal(second.outcome.retryAllowed, false);
  assert.equal(adapter.inventory(WAYFARER_LOCAL_STORE_ID_V1).accountedObjectCount, 1);
});

test("CR9B-WF-050 quarantine and terminal ambiguity preserve separate truthful metadata states", () => {
  const quarantined = setup(), quarantineReceipt = quarantined.adapter.apply(applyInput(quarantined.plan, "integrity_mismatch_after_marker"));
  assert.equal(quarantineReceipt.quarantineRecorded, true); assert.equal(quarantineReceipt.objectMetadataRecorded, false);
  const ambiguous = setup(), ambiguityReceipt = ambiguous.adapter.apply(applyInput(ambiguous.plan, "restart_after_marker"));
  assert.equal(ambiguityReceipt.ambiguityHeld, true); assert.equal(ambiguityReceipt.outcome.requiresReconciliation, true);
  assert.equal(ambiguityReceipt.outcome.retryAllowed, false);
});

test("CR9B-WF-050 synthetic local and R2 capacity are isolated and bounded", () => {
  const local = setup(), r2 = setup(WAYFARER_R2_STORE_ID_V1, { artifactId: "artifact:wayfarer:fake:r2" });
  local.adapter.apply(applyInput(local.plan, "simulated_store_verified"));
  r2.adapter.apply(applyInput(r2.plan, "simulated_store_verified"));
  assert.equal(local.adapter.inventory(WAYFARER_R2_STORE_ID_V1).accountedObjectCount, 0);
  assert.equal(r2.adapter.inventory(WAYFARER_R2_STORE_ID_V1).accountedObjectCount, 1);
  const tiny = new WayfarerFakeStorageAdapterV1(local.policy, [
    { storeId: WAYFARER_LOCAL_STORE_ID_V1, maximumObjects: 1, maximumBytes: 1_024 },
    { storeId: WAYFARER_R2_STORE_ID_V1, maximumObjects: 1, maximumBytes: 1_024 },
  ]);
  assert.throws(() => tiny.apply(applyInput(local.plan, "simulated_store_verified")),
    (error: unknown) => error instanceof WayfarerFakeStorageErrorV1 && error.safeCode === "fake_capacity");
});

test("CR9B-WF-050 receipt semantic drift and cross-policy plans are rejected", () => {
  const { adapter, plan } = setup(), receipt = adapter.apply(applyInput(plan, "simulated_store_verified"));
  assert.throws(() => parseWayfarerFakeStorageReceiptV1(rehash({ ...receipt, objectMetadataRecorded: false }, "receiptDigest")),
    WayfarerFakeStorageErrorV1);
  const otherPack = buildWayfarerSyntheticProjectPackV1(), otherPolicy = buildWayfarerStoragePolicyV1({ pack: otherPack,
    createdAt: "2026-08-29T22:00:00.000Z" }), otherAdapter = new WayfarerFakeStorageAdapterV1(otherPolicy,
      buildWayfarerDefaultFakeStorageCapacitiesV1());
  assert.throws(() => otherAdapter.apply(applyInput(plan, "simulated_store_verified")),
    (error: unknown) => error instanceof WayfarerFakeStorageErrorV1 && error.safeCode === "fake_scope_mismatch");
});

test("CR9B-WF-050 exact adapter input rejects accessors and Proxies without executing traps", () => {
  const { adapter, plan } = setup(); let calls = 0; const accessor = applyInput(plan, "simulated_store_verified");
  Object.defineProperty(accessor, "startedAt", { enumerable: true, get() { calls += 1; return "2026-08-29T21:03:00.000Z"; } });
  assert.throws(() => adapter.apply(accessor), ProjectWorkspaceContractErrorV1); assert.equal(calls, 0);
  const proxied = observedProxy(applyInput(plan, "simulated_store_verified"), "transparent");
  assert.throws(() => adapter.apply(proxied.value), ProjectWorkspaceContractErrorV1); assert.equal(proxied.trapCount(), 0);
});
