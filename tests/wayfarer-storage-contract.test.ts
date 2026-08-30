import assert from "node:assert/strict";
import test from "node:test";
import { WAYFARER_LOCAL_STORE_ID_V1, WAYFARER_R2_STORE_ID_V1, assertWayfarerStorageTransitionV1,
  buildWayfarerRetentionProposalV1, buildWayfarerStorageCleanupReceiptV1, buildWayfarerStoragePlanV1,
  buildWayfarerStoragePolicyV1, buildWayfarerSyntheticProjectPackV1, evaluateWayfarerStorageAttemptV1,
  parseWayfarerRetentionProposalV1, parseWayfarerStorageAttemptOutcomeV1, parseWayfarerStorageCleanupReceiptV1,
  parseWayfarerStoragePlanV1, parseWayfarerStoragePolicyV1, type WayfarerStorageArtifactDeclarationV1,
  type WayfarerStorageAttemptObservationV1,
} from "../src/project-adapters/wayfarer/v1";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const policyAt = "2026-08-29T20:00:00.000Z", artifactAt = "2026-08-29T20:01:00.000Z",
  plannedAt = "2026-08-29T20:02:00.000Z", startedAt = "2026-08-29T20:03:00.000Z";

function declaration(overrides: Partial<WayfarerStorageArtifactDeclarationV1> = {}): WayfarerStorageArtifactDeclarationV1 {
  return { artifactId: "artifact:wayfarer:episode:1:render", episodeId: "episode:wayfarer:1", role: "render_segment",
    contentType: "video/mp4", contentDigest: sha256Digest({ bytes: "declared-render-one" }), sizeBytes: 1_048_576,
    createdAt: artifactAt, ...overrides };
}
function setup(storeId: typeof WAYFARER_LOCAL_STORE_ID_V1 | typeof WAYFARER_R2_STORE_ID_V1 = WAYFARER_LOCAL_STORE_ID_V1) {
  const pack = buildWayfarerSyntheticProjectPackV1(), policy = buildWayfarerStoragePolicyV1({ pack, createdAt: policyAt }),
    artifact = declaration(), plan = buildWayfarerStoragePlanV1({ policy, pack, storeId, artifact, plannedAt });
  return { pack, policy, artifact, plan };
}
function observation(plan: ReturnType<typeof setup>["plan"], observationCode: WayfarerStorageAttemptObservationV1["observationCode"]): WayfarerStorageAttemptObservationV1 {
  const base = { observationCode, safeEvidenceDigest: sha256Digest({ observationCode }) };
  if (observationCode === "simulated_store_verified") return { ...base, markerRecorded: true,
    observedContentDigest: plan.artifact.contentDigest, observedSizeBytes: plan.artifact.sizeBytes };
  if (observationCode === "integrity_mismatch_after_marker") return { ...base, markerRecorded: true,
    observedContentDigest: sha256Digest({ wrong: true }), observedSizeBytes: plan.artifact.sizeBytes };
  return { ...base, markerRecorded: observationCode === "post_marker_outcome_unknown" || observationCode === "restart_after_marker" };
}
function outcome(code: WayfarerStorageAttemptObservationV1["observationCode"] = "simulated_store_verified") {
  const { policy, plan } = setup();
  return { policy, plan, outcome: evaluateWayfarerStorageAttemptV1({ policy, plan, attemptNumber: 1,
    observation: observation(plan, code), startedAt, settledAt: "2026-08-29T20:04:00.000Z" }) };
}
function rehash<T extends Record<string, unknown>>(value: T, field: string) {
  const copy = { ...value }; delete copy[field]; return { ...copy, [field]: sha256Digest(copy) };
}

test("CR9B-WF-040 freezes exact local and R2 logical stores while exposing no physical storage identity", () => {
  const { policy } = setup();
  assert.deepEqual(policy.stores.map((store) => [store.storeId, store.storageClass]), [
    [WAYFARER_LOCAL_STORE_ID_V1, "local_private"], [WAYFARER_R2_STORE_ID_V1, "r2_private"]]);
  assert.equal(policy.stores.every((store) => store.locatorReferenceMode === "digest_only" && store.locatorValuesRemainBrokerPrivate
    && store.immutableObjectKeys && !store.overwriteAllowed && !store.adapterConfigured && !store.adapterQualified
    && !store.liveAccessAllowed && !store.filesystemAccessAllowed && !store.networkAccessAllowed), true);
  assert.deepEqual(policy.locatorCustody, { locatorRegistryId: "registry:wayfarer:private-locators:v1",
    controlPlaneStoresLocatorValues: false, controlPlaneStoresPaths: false, controlPlaneStoresBucketNames: false,
    controlPlaneStoresAccountIdentifiers: false, controlPlaneStoresEndpoints: false, controlPlaneStoresSignedUrls: false,
    locatorResolutionRequiresSeparateAuthority: true, locatorResolutionAllowedByThisContract: false,
    locatorReferencesGrantAuthority: false });
  assert.equal(JSON.stringify(policy).includes("/Users/"), false);
  assert.equal(JSON.stringify(policy).includes("r2.cloudflarestorage.com"), false);
  assert.deepEqual(parseWayfarerStoragePolicyV1(policy), policy);
});

test("CR9B-WF-040 derives immutable object and locator-reference digests from exact artifact and store identity", () => {
  const local = setup(), r2 = setup(WAYFARER_R2_STORE_ID_V1);
  assert.equal(local.plan.artifactIdentityDigest, r2.plan.artifactIdentityDigest);
  assert.notEqual(local.plan.objectKeyDigest, r2.plan.objectKeyDigest);
  assert.notEqual(local.plan.locatorRefDigest, r2.plan.locatorRefDigest);
  assert.notEqual(local.plan.planId, r2.plan.planId);
  assert.notEqual(local.plan.capacityReservation.reservationId, r2.plan.capacityReservation.reservationId);
  assert.deepEqual({ state: local.plan.capacityReservation.state, count: local.plan.capacityReservation.reservedObjectCount,
    bytes: local.plan.capacityReservation.reservedBytes, acquired: local.plan.capacityReservation.acquiredCapacity,
    canWrite: local.plan.capacityReservation.canWrite }, { state: "proposed", count: 1, bytes: local.artifact.sizeBytes,
    acquired: false, canWrite: false });
  assert.equal(local.plan.embedsBytes || local.plan.containsLocatorValue || local.plan.resolvesLocator || local.plan.resolvesCredential
    || local.plan.writesObject || local.plan.createsEffectIntent || local.plan.grantsExecutionAuthority, false);
  assert.deepEqual(buildWayfarerStoragePlanV1({ policy: local.policy, pack: local.pack, storeId: WAYFARER_LOCAL_STORE_ID_V1,
    artifact: local.artifact, plannedAt }), local.plan);
});

test("CR9B-WF-040 storage planning rejects unknown media types, oversized objects, and scope drift", () => {
  const { pack, policy, artifact } = setup();
  assert.throws(() => buildWayfarerStoragePlanV1({ policy, pack, storeId: WAYFARER_LOCAL_STORE_ID_V1,
    artifact: { ...artifact, contentType: "application/octet-stream" }, plannedAt }), ProjectWorkspaceContractErrorV1);
  assert.throws(() => buildWayfarerStoragePlanV1({ policy, pack, storeId: WAYFARER_LOCAL_STORE_ID_V1,
    artifact: { ...artifact, sizeBytes: 4_294_967_297 }, plannedAt }), ProjectWorkspaceContractErrorV1);
  const changedPack = rehash({ ...pack, projectId: "project:other" }, "packDigest");
  assert.throws(() => buildWayfarerStoragePlanV1({ policy, pack: changedPack, storeId: WAYFARER_LOCAL_STORE_ID_V1,
    artifact, plannedAt }), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-040 verifies an injected fake outcome without resolving a locator or touching storage", () => {
  const { plan, outcome: result } = outcome();
  assert.deepEqual({ disposition: result.disposition, state: result.lifecycleState, reservation: result.reservationDisposition,
    retry: result.retryAllowed, reconcile: result.requiresReconciliation }, { disposition: "simulated_verified", state: "verified",
    reservation: "simulated_consumed", retry: false, reconcile: false });
  assert.equal(result.locatorResolved || result.credentialResolved || result.bytesTransferred || result.filesystemUsed
    || result.networkUsed || result.objectStorageUsed || result.externalEffectOccurred || result.grantsExecutionAuthority, false);
  assert.deepEqual(parseWayfarerStorageAttemptOutcomeV1(result), result);
  assert.equal(result.planDigest, plan.planDigest);
});

test("CR9B-WF-040 permits exactly one retry after a definite pre-marker failure", () => {
  const { policy, plan } = setup(), first = evaluateWayfarerStorageAttemptV1({ policy, plan, attemptNumber: 1,
    observation: observation(plan, "definite_pre_marker_failure"), startedAt, settledAt: "2026-08-29T20:04:00.000Z" });
  assert.equal(first.retryAllowed, true); assert.equal(first.retryReason, "definite_pre_marker_only");
  const second = evaluateWayfarerStorageAttemptV1({ policy, plan, attemptNumber: 2, previousOutcome: first,
    observation: observation(plan, "capacity_unavailable_pre_marker"), startedAt: "2026-08-29T20:05:00.000Z",
    settledAt: "2026-08-29T20:06:00.000Z" });
  assert.equal(second.retryAllowed, false); assert.equal(second.retryReason, "retry_limit_reached");
  assert.equal(second.previousOutcomeDigest, first.outcomeDigest);
  assert.throws(() => evaluateWayfarerStorageAttemptV1({ policy, plan, attemptNumber: 2,
    observation: observation(plan, "definite_pre_marker_failure"), startedAt: "2026-08-29T20:05:00.000Z",
    settledAt: "2026-08-29T20:06:00.000Z" }), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-040 makes post-marker uncertainty and restart terminal ambiguity with no retry", () => {
  for (const code of ["post_marker_outcome_unknown", "restart_after_marker"] as const) {
    const { outcome: result } = outcome(code);
    assert.deepEqual({ disposition: result.disposition, state: result.lifecycleState, reservation: result.reservationDisposition,
      retry: result.retryAllowed, reconcile: result.requiresReconciliation }, { disposition: "ambiguous", state: "ambiguous",
      reservation: "held_for_reconciliation", retry: false, reconcile: true });
  }
});

test("CR9B-WF-040 quarantines integrity mismatch and rejects dishonest marker observations", () => {
  const mismatch = outcome("integrity_mismatch_after_marker").outcome;
  assert.equal(mismatch.disposition, "quarantined"); assert.equal(mismatch.lifecycleState, "quarantined");
  assert.equal(mismatch.retryAllowed, false); assert.equal(mismatch.requiresReconciliation, false);
  const { policy, plan } = setup();
  assert.throws(() => evaluateWayfarerStorageAttemptV1({ policy, plan, attemptNumber: 1,
    observation: { ...observation(plan, "simulated_store_verified"), markerRecorded: false }, startedAt,
    settledAt: "2026-08-29T20:04:00.000Z" }), ProjectWorkspaceContractErrorV1);
  assert.throws(() => evaluateWayfarerStorageAttemptV1({ policy, plan, attemptNumber: 1,
    observation: { ...observation(plan, "definite_pre_marker_failure"), markerRecorded: true }, startedAt,
    settledAt: "2026-08-29T20:04:00.000Z" }), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-040 retention remains a due-date proposal and legal hold always wins", () => {
  const { policy, plan, outcome: result } = outcome(), pack = buildWayfarerSyntheticProjectPackV1(),
    base = { pack, policy, plan, outcome: result, retentionClockStartedAt: artifactAt,
      retentionClockEvidenceDigest: sha256Digest({ accepted: "independent-retention-clock" }) };
  const early = buildWayfarerRetentionProposalV1({ ...base, evaluatedAt: "2026-09-01T20:01:00.000Z", legalHoldActive: false }),
    due = buildWayfarerRetentionProposalV1({ ...base, evaluatedAt: "2026-10-01T20:01:00.000Z", legalHoldActive: false }),
    held = buildWayfarerRetentionProposalV1({ ...base, evaluatedAt: "2026-10-01T20:01:00.000Z", legalHoldActive: true });
  assert.deepEqual([early.disposition, due.disposition, held.disposition], ["not_due", "owner_review_candidate", "blocked_by_legal_hold"]);
  assert.deepEqual([early.cleanupCandidate, due.cleanupCandidate, held.cleanupCandidate], [false, true, false]);
  for (const proposal of [early, due, held]) assert.equal(proposal.ownerReviewRequired && proposal.independentEvidenceRequired
    && !proposal.automaticallyScheduled && !proposal.deletesObject && !proposal.resolvesLocator && !proposal.grantsDeletionAuthority, true);
  assert.deepEqual(parseWayfarerRetentionProposalV1(due), due);
});

test("CR9B-WF-040 cleanup receipts release only synthetic temporary state and never prove deletion", () => {
  for (const code of ["simulated_store_verified", "definite_pre_marker_failure", "post_marker_outcome_unknown"] as const) {
    const { plan, outcome: result } = outcome(code), receipt = buildWayfarerStorageCleanupReceiptV1({ plan, outcome: result,
      cleanedAt: "2026-08-29T20:07:00.000Z" });
    assert.equal(receipt.reservationDisposition, result.reservationDisposition);
    assert.equal(receipt.temporaryHandlesClosed && !receipt.temporaryObjectsRemaining && !receipt.locatorResolved
      && !receipt.credentialResolved && !receipt.objectDeleted && !receipt.filesystemUsed && !receipt.networkUsed
      && !receipt.objectStorageUsed && !receipt.cleanupIsDeletionEvidence && !receipt.externalEffectOccurred
      && !receipt.grantsDeletionAuthority, true);
    assert.deepEqual(parseWayfarerStorageCleanupReceiptV1(receipt), receipt);
  }
});

test("CR9B-WF-040 lifecycle graph has no direct deletion, ambiguity retry, or unreviewed cleanup transition", () => {
  for (const [from, to] of [["declared", "reserved"], ["reserved", "write_marker_recorded"],
    ["stored_unverified", "verified"], ["verified", "retention_candidate"],
    ["retention_candidate", "cleanup_proposed"]] as const) assert.doesNotThrow(() => assertWayfarerStorageTransitionV1(from, to));
  for (const [from, to] of [["declared", "verified"], ["ambiguous", "reserved"], ["verified", "cleanup_proposed"],
    ["cleanup_proposed", "released"]] as const) assert.throws(() => assertWayfarerStorageTransitionV1(from, to),
      (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "invalid_transition");
});

test("CR9B-WF-040 digest aliases, locator-shaped additions, and changed outcomes fail closed", () => {
  const { policy, plan } = setup(), verified = outcome().outcome;
  assert.throws(() => parseWayfarerStoragePolicyV1({ ...policy, projectId: "project:alias" }), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerStoragePlanV1({ ...plan, objectKeyDigest: sha256Digest({ alias: true }) }), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerStoragePlanV1(rehash({ ...plan, planId: "storage-plan:wayfarer:wrong" }, "planDigest")),
    ProjectWorkspaceContractErrorV1);
  const wrongReservation = rehash({ ...plan.capacityReservation, reservationId: "capacity:wayfarer:wrong" }, "reservationDigest");
  assert.throws(() => parseWayfarerStoragePlanV1(rehash({ ...plan, capacityReservation: wrongReservation }, "planDigest")),
    ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerStoragePlanV1({ ...plan, bucketName: "private-media" }), ProjectWorkspaceContractErrorV1);
  const changed = rehash({ ...verified, retryAllowed: true }, "outcomeDigest");
  assert.throws(() => parseWayfarerStorageAttemptOutcomeV1(changed), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerStorageAttemptOutcomeV1(rehash({ ...verified, outcomeId: "storage-outcome:wayfarer:wrong:1" },
    "outcomeDigest")), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerStoragePlanV1({ ...plan, accessToken: "access_token=unsafe-material" }),
    (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1
      && (error.safeCode === "redaction_rejected" || error.safeCode === "invalid_input"));
});

test("CR9B-WF-040 exact boundaries reject accessors and Proxies without executing traps", () => {
  const { policy, plan } = setup(); let calls = 0; const accessor = { ...policy };
  Object.defineProperty(accessor, "policyId", { enumerable: true, get() { calls += 1; return policy.policyId; } });
  assert.throws(() => parseWayfarerStoragePolicyV1(accessor), ProjectWorkspaceContractErrorV1); assert.equal(calls, 0);
  const proxiedPlan = observedProxy(plan, "transparent");
  assert.throws(() => parseWayfarerStoragePlanV1(proxiedPlan.value), ProjectWorkspaceContractErrorV1);
  assert.equal(proxiedPlan.trapCount(), 0);
  const attemptInput = observedProxy({ policy, plan, attemptNumber: 1 as const, observation: observation(plan, "simulated_store_verified"),
    startedAt, settledAt: "2026-08-29T20:04:00.000Z" }, "transparent");
  assert.throws(() => evaluateWayfarerStorageAttemptV1(attemptInput.value), ProjectWorkspaceContractErrorV1);
  assert.equal(attemptInput.trapCount(), 0);
});
