import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceContentBloomsReadHighWaterV1,
  applyContentBloomsControlTransitionV1,
  buildContentBloomsAdapterReleaseV1,
  buildContentBloomsControlTransitionV1,
  buildContentBloomsOperationalRecordV1,
  buildContentBloomsReadPageV1,
  buildContentBloomsReadReceiptV1,
  buildContentBloomsReadRequestV1,
  buildInitialContentBloomsControlStateV1,
  ContentBloomsContractErrorV1,
  parseContentBloomsAdapterReleaseV1,
  parseContentBloomsControlStateV1,
  parseContentBloomsControlTransitionReceiptV1,
  parseContentBloomsOperationalRecordV1,
  parseContentBloomsReadPageV1,
  parseContentBloomsReadReceiptV1,
  parseContentBloomsReadRequestV1,
  requireExactContentBloomsControlReplayV1,
  requireExactContentBloomsReadReplayV1,
  type ContentBloomsAdapterControlStateV1,
  type ContentBloomsAdapterReleaseV1,
  type ContentBloomsControlTransitionV1,
  type ContentBloomsOperationalRecordV1,
} from "../src/project-adapters/content-blooms/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const tenantId = "tenant:owner";
const workspaceId = "workspace:content-blooms";
const projectId = "project:content-blooms:operations";
const adapterId = "adapter:content-blooms:v1";
const actorDigest = sha256Digest({ actor: "owner:test" });
const t0 = "2026-08-29T12:00:00.000Z";
const t1 = "2026-08-29T12:01:00.000Z";
const t2 = "2026-08-29T12:02:00.000Z";
const t3 = "2026-08-29T12:03:00.000Z";
const t4 = "2026-08-29T12:04:00.000Z";
const t5 = "2026-08-29T12:05:00.000Z";
const t6 = "2026-08-29T12:06:00.000Z";
const t7 = "2026-08-29T12:07:00.000Z";
const t8 = "2026-08-29T12:08:00.000Z";
const t9 = "2026-08-29T12:09:00.000Z";
const t10 = "2026-08-29T12:10:00.000Z";
const t11 = "2026-08-29T12:11:00.000Z";

function expectCode(action: () => unknown, code: ContentBloomsContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) => error instanceof ContentBloomsContractErrorV1 && error.safeCode === code);
}

function release(releaseId: string, acceptedAt: string, seed: string): ContentBloomsAdapterReleaseV1 {
  return buildContentBloomsAdapterReleaseV1({
    releaseId,
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    redactionPolicyVersion: "content-blooms-safe.v1",
    adapterPackageDigest: sha256Digest({ package: seed }),
    projectionSchemaDigest: sha256Digest({ schema: seed }),
    conformanceEvidenceDigest: sha256Digest({ conformance: seed }),
    acceptanceProfileDigest: sha256Digest({ acceptanceProfile: seed }),
    acceptedReviewDigest: sha256Digest({ acceptedReview: seed }),
    completionSnapshotDigest: sha256Digest({ completionSnapshot: seed }),
    producerIdentityDigest: sha256Digest({ producer: seed }),
    reviewerIdentityDigest: sha256Digest({ reviewer: seed }),
    acceptedAt,
  });
}

function initialState(): ContentBloomsAdapterControlStateV1 {
  return buildInitialContentBloomsControlStateV1({
    stateId: "state:content-blooms:adapter",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    initializedAt: t0,
  });
}

function transition(
  state: ContentBloomsAdapterControlStateV1,
  action: ContentBloomsControlTransitionV1["action"],
  requestedAt: string,
  transitionId: string,
  targetReleaseDigest?: string,
): ContentBloomsControlTransitionV1 {
  return buildContentBloomsControlTransitionV1({
    transitionId,
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    action,
    expectedStateDigest: state.stateDigest,
    ...(targetReleaseDigest ? { targetReleaseDigest } : {}),
    requestedByActorDigest: actorDigest,
    reasonCode: `reason:${action}`,
    requestedAt,
  });
}

function apply(
  state: ContentBloomsAdapterControlStateV1,
  action: ContentBloomsControlTransitionV1["action"],
  requestedAt: string,
  transitionId: string,
  releases: ContentBloomsAdapterReleaseV1[],
  targetReleaseDigest?: string,
) {
  return applyContentBloomsControlTransitionV1({
    state,
    transition: transition(state, action, requestedAt, transitionId, targetReleaseDigest),
    releases,
  });
}

function workRecord(sourceVersion = "1", title = "Synthetic transcription route check"): ContentBloomsOperationalRecordV1 {
  return buildContentBloomsOperationalRecordV1({
    kind: "work_item",
    operation: "upsert",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    sourceRecordId: "work:transcription:1042",
    sourceVersion,
    observedAt: t3,
    projection: {
      title,
      normalizedState: "ready",
      domainState: "transcription_capacity",
      priority: 90,
      requiredCapability: "transcription:whisper",
      allowedRouteIds: ["route:mac:mlx", "route:windows:cuda", "route:vps:cpu"],
      downstreamUnlockCount: 2,
      createdAt: t1,
      updatedAt: t2,
      deepLinkPath: "/operations/work/transcription-1042",
    },
  });
}

function enabledState(r1: ContentBloomsAdapterReleaseV1): ContentBloomsAdapterControlStateV1 {
  return apply(initialState(), "enable_release", t1, "transition:enable:r1", [r1], r1.releaseDigest).state;
}

function readFixture(state: ContentBloomsAdapterControlStateV1, r1: ContentBloomsAdapterReleaseV1, record = workRecord()) {
  const request = buildContentBloomsReadRequestV1({
    requestId: "read:work-items:1",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    expectedReleaseDigest: r1.releaseDigest,
    operation: "listWorkItems",
    limit: 25,
    requestedAt: t2,
  });
  const page = buildContentBloomsReadPageV1({
    request,
    release: r1,
    pageId: "page:work-items:1",
    nextCursor: "cursor-work-items-0001",
    hasMore: false,
    sourceSnapshotVersion: "snapshot-0001",
    sourceObservedAt: t3,
    records: [record],
  });
  const validated = buildContentBloomsReadReceiptV1({ request, page, release: r1, controlState: state, recordedAt: t4 });
  return { request, ...validated };
}

test("CR9A release is fixed to read-only source-scheduled authority", () => {
  const r1 = release("release:content-blooms:r1", t0, "r1");
  assert.deepEqual(parseContentBloomsAdapterReleaseV1(r1), r1);
  assert.equal(r1.authorityMode, "source_scheduled");
  assert.deepEqual(r1.supportedCommands, []);
  assert.deepEqual(r1.supportedReadOperations, [
    "getProjectSummary", "listWorkItems", "listExecutions", "listBlockers", "listWorkers", "listAttentionItems", "readChanges",
  ]);
  assert.deepEqual({
    sourceOwnsEligibility: r1.sourceOwnsEligibility,
    sourceOwnsLeases: r1.sourceOwnsLeases,
    sourceOwnsDomainTransitions: r1.sourceOwnsDomainTransitions,
    controlRoomMayLease: r1.controlRoomMayLease,
    controlRoomMayMutateSource: r1.controlRoomMayMutateSource,
    grantsNetworkAuthority: r1.grantsNetworkAuthority,
    grantsCommandAuthority: r1.grantsCommandAuthority,
    grantsExecutionAuthority: r1.grantsExecutionAuthority,
  }, {
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    controlRoomMayLease: false,
    controlRoomMayMutateSource: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  });
  expectCode(() => parseContentBloomsAdapterReleaseV1({ ...r1, controlRoomMayLease: true }), "invalid_input");
  expectCode(() => parseContentBloomsAdapterReleaseV1({ ...r1, supportedCommands: ["requestRetry"] }), "invalid_input");
  expectCode(() => parseContentBloomsAdapterReleaseV1({ ...r1, adapterPackageDigest: sha256Digest({ changed: true }) }), "release_untrusted");
  expectCode(() => buildContentBloomsAdapterReleaseV1({
    releaseId: "release:content-blooms:correlated",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    redactionPolicyVersion: "content-blooms-safe.v1",
    adapterPackageDigest: sha256Digest({ package: "correlated" }),
    projectionSchemaDigest: sha256Digest({ schema: "correlated" }),
    conformanceEvidenceDigest: sha256Digest({ conformance: "correlated" }),
    acceptanceProfileDigest: sha256Digest({ acceptanceProfile: "correlated" }),
    acceptedReviewDigest: sha256Digest({ acceptedReview: "correlated" }),
    completionSnapshotDigest: sha256Digest({ completionSnapshot: "correlated" }),
    producerIdentityDigest: actorDigest,
    reviewerIdentityDigest: actorDigest,
    acceptedAt: t0,
  }), "invalid_input");
});

test("CR9A operational records are strict, sanitized, digest-bound, and source-lease aware", () => {
  const work = workRecord();
  assert.deepEqual(parseContentBloomsOperationalRecordV1(work), work);
  expectCode(() => parseContentBloomsOperationalRecordV1({ ...work, sourceVersion: "2" }), "replay_drift");
  expectCode(() => workRecord("1", "api_key=unsafe-value-123"), "redaction_rejected");
  expectCode(() => buildContentBloomsOperationalRecordV1({
    kind: "work_item",
    operation: "upsert",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    sourceRecordId: "work:unsafe:1",
    sourceVersion: "1",
    observedAt: t3,
    projection: {
      title: "Unsafe link",
      normalizedState: "ready",
      domainState: "ready",
      priority: 50,
      createdAt: t1,
      updatedAt: t2,
      deepLinkPath: "/operations/item?X-Amz-Signature=unsafe",
    },
  }), "redaction_rejected");
  expectCode(() => buildContentBloomsOperationalRecordV1({
    kind: "execution",
    operation: "upsert",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    sourceRecordId: "execution:1",
    sourceVersion: "1",
    observedAt: t3,
    projection: {
      workItemSourceRecordId: "work:transcription:1042",
      attempt: 1,
      state: "leased",
      routeId: "route:mac:mlx",
    },
  }), "invalid_input");
  const leased = buildContentBloomsOperationalRecordV1({
    kind: "execution",
    operation: "upsert",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    sourceRecordId: "execution:1",
    sourceVersion: "1",
    observedAt: t3,
    projection: {
      workItemSourceRecordId: "work:transcription:1042",
      attempt: 1,
      state: "leased",
      routeId: "route:mac:mlx",
      sourceLeaseOwnerDigest: sha256Digest({ sourceLease: "owner" }),
      sourceLeaseEpoch: 7,
      leaseObservedAt: t2,
    },
  });
  assert.equal(leased.kind, "execution");
});

test("CR9A read receipt binds exact scope, release, page, cursor, and negative authority", () => {
  const r1 = release("release:content-blooms:r1", t0, "r1"), state = enabledState(r1);
  const { request, page, receipt, records, nextCursor } = readFixture(state, r1);
  assert.deepEqual(parseContentBloomsReadRequestV1(request), request);
  assert.deepEqual(parseContentBloomsReadPageV1(page), page);
  assert.deepEqual(parseContentBloomsReadReceiptV1(receipt), receipt);
  assert.deepEqual(records, page.records);
  assert.equal(nextCursor, page.nextCursor);
  assert.equal(receipt.recordCount, 1);
  assert.deepEqual(receipt.recordDigests, [workRecord().recordDigest]);
  assert.deepEqual({
    sourceOwnsEligibility: receipt.sourceOwnsEligibility,
    sourceOwnsLeases: receipt.sourceOwnsLeases,
    sourceOwnsDomainTransitions: receipt.sourceOwnsDomainTransitions,
    controlRoomMayLease: receipt.controlRoomMayLease,
    controlRoomMayMutateSource: receipt.controlRoomMayMutateSource,
    grantsApproval: receipt.grantsApproval,
    grantsNetworkAuthority: receipt.grantsNetworkAuthority,
    grantsCommandAuthority: receipt.grantsCommandAuthority,
    grantsLeaseAuthority: receipt.grantsLeaseAuthority,
    grantsExecutionAuthority: receipt.grantsExecutionAuthority,
  }, {
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    controlRoomMayLease: false,
    controlRoomMayMutateSource: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  });
  assert.doesNotMatch(JSON.stringify(receipt), /cursor-work-items-0001/);
});

test("CR9A exact read replay is idempotent and changed same-page truth fails closed", () => {
  const r1 = release("release:content-blooms:r1", t0, "r1"), state = enabledState(r1);
  const first = readFixture(state, r1);
  assert.deepEqual(requireExactContentBloomsReadReplayV1(first.receipt, first.receipt), first.receipt);
  const changed = readFixture(state, r1, workRecord("2", "Synthetic transcription route check revised"));
  expectCode(() => requireExactContentBloomsReadReplayV1(first.receipt, changed.receipt), "replay_drift");
  const advanced = advanceContentBloomsReadHighWaterV1({ state, receipt: first.receipt });
  assert.equal(advanced.lastCommittedCursorDigest, first.receipt.nextCursorDigest);
  assert.equal(advanced.lastReadReceiptDigest, first.receipt.receiptDigest);
  assert.deepEqual(advanceContentBloomsReadHighWaterV1({ state: advanced, receipt: first.receipt }), advanced);
});

test("CR9A rejects cross-scope records, wrong read kinds, and stuck cursors", () => {
  const r1 = release("release:content-blooms:r1", t0, "r1"), state = enabledState(r1);
  const request = buildContentBloomsReadRequestV1({
    requestId: "read:work-items:scope",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    expectedReleaseDigest: r1.releaseDigest,
    operation: "listWorkItems",
    afterCursor: "cursor-before",
    limit: 25,
    requestedAt: t2,
  });
  const crossScope = buildContentBloomsOperationalRecordV1({
    kind: "work_item",
    operation: "upsert",
    tenantId: "tenant:other",
    workspaceId,
    projectId,
    adapterId,
    sourceRecordId: "work:other:1",
    sourceVersion: "1",
    observedAt: t3,
    projection: {
      title: "Other tenant item",
      normalizedState: "ready",
      domainState: "ready",
      priority: 50,
      createdAt: t1,
      updatedAt: t2,
    },
  });
  expectCode(() => buildContentBloomsReadPageV1({
    request,
    release: r1,
    pageId: "page:cross-scope",
    nextCursor: "cursor-after",
    hasMore: false,
    sourceSnapshotVersion: "snapshot-1",
    sourceObservedAt: t3,
    records: [crossScope],
  }), "scope_mismatch");
  const blocker = buildContentBloomsOperationalRecordV1({
    kind: "blocker",
    operation: "upsert",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    sourceRecordId: "blocker:1",
    sourceVersion: "1",
    observedAt: t3,
    projection: {
      blockerType: "capacity",
      title: "Synthetic capacity blocker",
      severity: "warning",
      responsibleRole: "system",
      openedAt: t2,
    },
  });
  expectCode(() => buildContentBloomsReadPageV1({
    request,
    release: r1,
    pageId: "page:wrong-kind",
    nextCursor: "cursor-after",
    hasMore: false,
    sourceSnapshotVersion: "snapshot-1",
    sourceObservedAt: t3,
    records: [blocker],
  }), "authority_conflation");
  expectCode(() => buildContentBloomsReadPageV1({
    request,
    release: r1,
    pageId: "page:stuck",
    nextCursor: "cursor-before",
    hasMore: true,
    sourceSnapshotVersion: "snapshot-1",
    sourceObservedAt: t3,
    records: [workRecord()],
  }), "cursor_drift");
  assert.equal(state.status, "enabled");
});

test("CR9A disable is immediate and preserves cursor and receipt high-water", () => {
  const r1 = release("release:content-blooms:r1", t0, "r1");
  const enabled = enabledState(r1), read = readFixture(enabled, r1);
  const advanced = advanceContentBloomsReadHighWaterV1({ state: enabled, receipt: read.receipt });
  const disabledResult = apply(advanced, "disable", t5, "transition:disable:r1", [r1]);
  const disabled = disabledResult.state;
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.readsEligible, false);
  assert.equal(disabled.configuredReleaseDigest, r1.releaseDigest);
  assert.equal(disabled.activeReleaseDigest, undefined);
  assert.equal(disabled.lastCommittedCursorDigest, advanced.lastCommittedCursorDigest);
  assert.equal(disabled.lastReadReceiptDigest, advanced.lastReadReceiptDigest);
  assert.equal(disabledResult.receipt.preservedCursorDigest, advanced.lastCommittedCursorDigest);
  assert.equal(disabledResult.receipt.preservedReadReceiptDigest, advanced.lastReadReceiptDigest);
  assert.deepEqual(parseContentBloomsControlTransitionReceiptV1(disabledResult.receipt), disabledResult.receipt);
  expectCode(() => buildContentBloomsReadReceiptV1({
    request: read.request,
    page: read.page,
    release: r1,
    controlState: disabled,
    recordedAt: t6,
  }), "adapter_disabled");
});

test("CR9A upgrade and rollback never rewind read truth or re-enable a disabled adapter", () => {
  const r1 = release("release:content-blooms:r1", t0, "r1");
  const r2 = release("release:content-blooms:r2", t1, "r2");
  let state = enabledState(r1);
  const read = readFixture(state, r1);
  state = advanceContentBloomsReadHighWaterV1({ state, receipt: read.receipt });
  state = apply(state, "enable_release", t5, "transition:upgrade:r2", [r1, r2], r2.releaseDigest).state;
  assert.equal(state.activeReleaseDigest, r2.releaseDigest);
  assert.deepEqual(state.previousReleaseDigests, [r1.releaseDigest]);
  const rolledBack = apply(state, "rollback_release", t6, "transition:rollback:r1", [r1, r2], r1.releaseDigest);
  state = rolledBack.state;
  assert.equal(state.activeReleaseDigest, r1.releaseDigest);
  assert.deepEqual(state.previousReleaseDigests, [r2.releaseDigest]);
  assert.equal(state.lastCommittedCursorDigest, read.receipt.nextCursorDigest);
  assert.equal(state.lastReadReceiptDigest, read.receipt.receiptDigest);
  state = apply(state, "disable", t7, "transition:disable:after-rollback", [r1, r2]).state;
  state = apply(state, "rollback_release", t8, "transition:rollback-disabled:r2", [r1, r2], r2.releaseDigest).state;
  assert.equal(state.status, "disabled");
  assert.equal(state.readsEligible, false);
  assert.equal(state.configuredReleaseDigest, r2.releaseDigest);
  assert.equal(state.activeReleaseDigest, undefined);
  assert.equal(state.lastCommittedCursorDigest, read.receipt.nextCursorDigest);
  state = apply(state, "enable_release", t9, "transition:reenable:r2", [r1, r2], r2.releaseDigest).state;
  assert.equal(state.status, "enabled");
  assert.equal(state.activeReleaseDigest, r2.releaseDigest);
});

test("CR9A stale control state, implicit rollback, and changed transition replay fail closed", () => {
  const r1 = release("release:content-blooms:r1", t0, "r1");
  const r2 = release("release:content-blooms:r2", t1, "r2");
  const state = enabledState(r1);
  const upgradeTransition = transition(state, "enable_release", t5, "transition:upgrade", r2.releaseDigest);
  const upgraded = applyContentBloomsControlTransitionV1({ state, transition: upgradeTransition, releases: [r1, r2] });
  expectCode(() => applyContentBloomsControlTransitionV1({ state: upgraded.state, transition: upgradeTransition, releases: [r1, r2] }), "stale_state");
  expectCode(() => apply(upgraded.state, "enable_release", t6, "transition:implicit-rollback", [r1, r2], r1.releaseDigest), "rollback_invalid");
  const alternate = applyContentBloomsControlTransitionV1({
    state,
    transition: buildContentBloomsControlTransitionV1({
      transitionId: "transition:upgrade",
      tenantId,
      workspaceId,
      projectId,
      adapterId,
      action: "enable_release",
      expectedStateDigest: state.stateDigest,
      targetReleaseDigest: r2.releaseDigest,
      requestedByActorDigest: actorDigest,
      reasonCode: "reason:alternate",
      requestedAt: t6,
    }),
    releases: [r1, r2],
  });
  assert.deepEqual(requireExactContentBloomsControlReplayV1(upgraded.receipt, upgraded.receipt), upgraded.receipt);
  expectCode(() => requireExactContentBloomsControlReplayV1(upgraded.receipt, alternate.receipt), "replay_drift");
});

test("CR9A exact-host boundary rejects Proxies and accessors without invoking behavior", () => {
  const r1 = release("release:content-blooms:r1", t0, "r1");
  const proxied = observedProxy(r1, "throwing");
  expectCode(() => parseContentBloomsAdapterReleaseV1(proxied.value), "invalid_input");
  assert.equal(proxied.trapCount(), 0);
  let getterCalls = 0;
  const requestInput = {
    requestId: "read:accessor:1",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    expectedReleaseDigest: r1.releaseDigest,
    operation: "listWorkItems",
    limit: 10,
    requestedAt: t2,
  };
  Object.defineProperty(requestInput, "limit", { enumerable: true, get() { getterCalls += 1; return 10; } });
  expectCode(() => buildContentBloomsReadRequestV1(requestInput), "invalid_input");
  assert.equal(getterCalls, 0);
  expectCode(() => parseContentBloomsControlStateV1({ ...initialState(), readsEligible: true }), "invalid_input");
});

test("CR9A release and control chronology reject unknown releases and time rollback", () => {
  const r1 = release("release:content-blooms:r1", t0, "r1");
  const future = release("release:content-blooms:future", t10, "future");
  const state = enabledState(r1);
  const unknownDigest = sha256Digest({ release: "unknown" });
  expectCode(() => apply(state, "enable_release", t5, "transition:unknown", [r1], unknownDigest), "release_untrusted");
  expectCode(() => apply(state, "enable_release", t5, "transition:future", [r1, future], future.releaseDigest), "sequence_invalid");
  expectCode(() => apply(state, "disable", t0, "transition:time-rollback", [r1]), "sequence_invalid");
  const rOther = buildContentBloomsAdapterReleaseV1({
    releaseId: "release:other:r1",
    tenantId: "tenant:other",
    workspaceId,
    projectId,
    adapterId,
    redactionPolicyVersion: "content-blooms-safe.v1",
    adapterPackageDigest: sha256Digest({ package: "other" }),
    projectionSchemaDigest: sha256Digest({ schema: "other" }),
    conformanceEvidenceDigest: sha256Digest({ conformance: "other" }),
    acceptanceProfileDigest: sha256Digest({ acceptanceProfile: "other" }),
    acceptedReviewDigest: sha256Digest({ acceptedReview: "other" }),
    completionSnapshotDigest: sha256Digest({ completionSnapshot: "other" }),
    producerIdentityDigest: sha256Digest({ producer: "other" }),
    reviewerIdentityDigest: sha256Digest({ reviewer: "other" }),
    acceptedAt: t0,
  });
  expectCode(() => apply(state, "enable_release", t5, "transition:other-scope", [r1, rOther], rOther.releaseDigest), "scope_mismatch");
  assert.ok(Date.parse(t11) > Date.parse(t10));
});
