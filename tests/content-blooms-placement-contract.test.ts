import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_GATE_SCHEMA_VERSION_V1,
  type ConsequentialApprovalDecisionV1,
  type ConsequentialApprovalRequestV1,
} from "../src/completion-gate/v1/index.ts";
import {
  advanceContentBloomsReadHighWaterV1,
  applyContentBloomsControlTransitionV1,
  assertContentBloomsPlacementOutcomeBindingV1,
  assertContentBloomsPlacementPreDispatchV1,
  buildContentBloomsAdapterReleaseV1,
  buildContentBloomsControlTransitionV1,
  buildContentBloomsPlacementAmbiguityReceiptV1,
  buildContentBloomsPlacementAuthorizationV1,
  buildContentBloomsPlacementDeclarationV1,
  buildContentBloomsPlacementRequestV1,
  buildContentBloomsPlacementSourceReceiptV1,
  buildContentBloomsReadRequestV1,
  buildContentBloomsRouteComparisonPolicyV1,
  buildContentBloomsSyntheticFixtureRecordsV1,
  buildContentBloomsTranscriptionRouteObservationV1,
  buildInitialContentBloomsControlStateV1,
  compareContentBloomsTranscriptionRoutesV1,
  contentBloomsControlLifecycleDigestV1,
  ContentBloomsContractErrorV1,
  ContentBloomsFixtureSourceV1,
  ContentBloomsInjectedReadAdapterV1,
  parseContentBloomsPlacementAmbiguityReceiptV1,
  parseContentBloomsPlacementAuthorizationV1,
  parseContentBloomsPlacementDeclarationV1,
  parseContentBloomsPlacementOutcomeReceiptV1,
  parseContentBloomsPlacementRequestV1,
  parseContentBloomsPlacementSourceReceiptV1,
  requireExactContentBloomsPlacementAuthorizationReplayV1,
  requireExactContentBloomsPlacementOutcomeReplayV1,
  requireExactContentBloomsPlacementRequestReplayV1,
  type ContentBloomsAdapterControlStateV1,
  type ContentBloomsAdapterReleaseV1,
  type ContentBloomsPlacementAuthorizationV1,
  type ContentBloomsPlacementDeclarationV1,
  type ContentBloomsPlacementRequestV1,
  type ContentBloomsRouteComparisonV1,
  type ContentBloomsTranscriptionRouteObservationV1,
} from "../src/project-adapters/content-blooms/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const tenantId = "tenant:owner";
const workspaceId = "workspace:content-blooms";
const projectId = "project:content-blooms:operations";
const adapterId = "adapter:content-blooms:v1";
const stateId = "state:content-blooms:adapter";
const t0 = "2026-08-29T13:00:00.000Z";
const t1 = "2026-08-29T13:01:00.000Z";
const t6 = "2026-08-29T13:06:00.000Z";
const t7 = "2026-08-29T13:07:00.000Z";
const t8 = "2026-08-29T13:08:00.000Z";
const t9 = "2026-08-29T13:09:00.000Z";
const t10 = "2026-08-29T13:10:00.000Z";
const t11 = "2026-08-29T13:11:00.000Z";
const t12 = "2026-08-29T13:12:00.000Z";
const t13 = "2026-08-29T13:13:00.000Z";
const t14 = "2026-08-29T13:14:00.000Z";
const t18 = "2026-08-29T13:18:00.000Z";
const t19 = "2026-08-29T13:19:00.000Z";
const t20 = "2026-08-29T13:20:00.000Z";
const routeExpiry = "2026-08-30T13:06:00.000Z";

function expectCode(action: () => unknown, code: ContentBloomsContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) => error instanceof ContentBloomsContractErrorV1 && error.safeCode === code);
}

function release(): ContentBloomsAdapterReleaseV1 {
  return buildContentBloomsAdapterReleaseV1({
    releaseId: "release:content-blooms:placement-r1",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    redactionPolicyVersion: "content-blooms-safe.v1",
    adapterPackageDigest: sha256Digest({ package: "placement-r1" }),
    projectionSchemaDigest: sha256Digest({ schema: "placement-r1" }),
    conformanceEvidenceDigest: sha256Digest({ conformance: "placement-r1" }),
    acceptanceProfileDigest: sha256Digest({ acceptanceProfile: "placement-r1" }),
    acceptedReviewDigest: sha256Digest({ acceptedReview: "placement-r1" }),
    completionSnapshotDigest: sha256Digest({ completionSnapshot: "placement-r1" }),
    producerIdentityDigest: sha256Digest({ producer: "placement-r1" }),
    reviewerIdentityDigest: sha256Digest({ reviewer: "placement-r1" }),
    acceptedAt: t0,
  });
}

function enabledState(r1: ContentBloomsAdapterReleaseV1): ContentBloomsAdapterControlStateV1 {
  const initial = buildInitialContentBloomsControlStateV1({ stateId,tenantId,workspaceId,projectId,adapterId,initializedAt: t0 });
  const transition = buildContentBloomsControlTransitionV1({
    transitionId: "transition:placement:enable-r1",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    action: "enable_release",
    expectedStateDigest: initial.stateDigest,
    targetReleaseDigest: r1.releaseDigest,
    requestedByActorDigest: sha256Digest({ actor: "owner" }),
    reasonCode: "placement_contract_test",
    requestedAt: t1,
  });
  return applyContentBloomsControlTransitionV1({ state: initial, transition, releases: [r1] }).state;
}

function declaration(r1: ContentBloomsAdapterReleaseV1): ContentBloomsPlacementDeclarationV1 {
  return buildContentBloomsPlacementDeclarationV1({
    declarationId: "declaration:content-blooms:placement-v1",
    readRelease: r1,
    commandSchemaDigest: sha256Digest({ schema: "placement-command-v1" }),
    sourceReceiptSchemaDigest: sha256Digest({ schema: "placement-source-receipt-v1" }),
    conformanceEvidenceDigest: sha256Digest({ conformance: "placement-contract-v1" }),
    acceptanceProfileDigest: sha256Digest({ profile: "placement-contract-v1" }),
    acceptedReviewDigest: sha256Digest({ review: "placement-contract-v1" }),
    completionSnapshotDigest: sha256Digest({ snapshot: "placement-contract-v1" }),
    producerIdentityDigest: sha256Digest({ producer: "placement-contract-v1" }),
    reviewerIdentityDigest: sha256Digest({ reviewer: "placement-contract-v1" }),
    acceptedAt: t1,
  });
}

function route(
  platform: "macos" | "windows" | "linux",
  routeId: string,
  state: "idle" | "busy" | "offline",
  duration: number,
): ContentBloomsTranscriptionRouteObservationV1 {
  const runtimeClass = { macos: "whisper_mlx", windows: "whisper_cuda", linux: "whisper_cpu" } as const;
  return buildContentBloomsTranscriptionRouteObservationV1({
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    routeId,
    workerRefDigest: sha256Digest({ worker: routeId }),
    platform,
    runtimeClass: runtimeClass[platform],
    state,
    verification: "verified",
    estimatedDurationSeconds: duration,
    estimatedCostMilliUsd: 0,
    qualityRank: platform === "linux" ? 4 : 5,
    privacyClass: "local",
    benchmarkVersion: "benchmark.synthetic.v1",
    benchmarkDigest: sha256Digest({ benchmark: routeId }),
    observedAt: t6,
    validUntil: routeExpiry,
  });
}

function comparisonFixture(): {
  workItem: ReturnType<typeof buildContentBloomsSyntheticFixtureRecordsV1>[number];
  selectedRoute: ContentBloomsTranscriptionRouteObservationV1;
  busyRoute: ContentBloomsTranscriptionRouteObservationV1;
  comparison: ContentBloomsRouteComparisonV1;
} {
  const workItem = buildContentBloomsSyntheticFixtureRecordsV1().find((record) => record.kind === "work_item"
    && record.sourceRecordId === "recording-queue-1042")!;
  const busyRoute = route("macos", "route:mac:mlx", "busy", 150);
  const selectedRoute = route("windows", "route:windows:cuda", "idle", 120);
  const vps = route("linux", "route:vps:cpu", "idle", 900);
  const policy = buildContentBloomsRouteComparisonPolicyV1({
    policyId: "policy:transcription:placement",
    maxCostMilliUsd: 0,
    minimumQualityRank: 4,
    allowedPrivacyClasses: ["local"],
    allowBusy: false,
    durationWeight: 10,
    costWeight: 1,
    qualityWeight: 100,
    privacyWeight: 1_000,
  });
  const comparison = compareContentBloomsTranscriptionRoutesV1({
    tenantId,workspaceId,projectId,adapterId,workItem,routes: [busyRoute,selectedRoute,vps],policy,comparedAt: t7,
  });
  return { workItem,selectedRoute,busyRoute,comparison };
}

function placementRequestFixture(overrides: { state?: ContentBloomsAdapterControlStateV1; requestId?: string } = {}): {
  release: ContentBloomsAdapterReleaseV1;
  state: ContentBloomsAdapterControlStateV1;
  declaration: ContentBloomsPlacementDeclarationV1;
  workItem: ReturnType<typeof buildContentBloomsSyntheticFixtureRecordsV1>[number];
  selectedRoute: ContentBloomsTranscriptionRouteObservationV1;
  busyRoute: ContentBloomsTranscriptionRouteObservationV1;
  comparison: ContentBloomsRouteComparisonV1;
  request: ContentBloomsPlacementRequestV1;
} {
  const r1 = release();
  const state = overrides.state ?? enabledState(r1);
  const declared = declaration(r1);
  const compared = comparisonFixture();
  const request = buildContentBloomsPlacementRequestV1({
    declaration: declared,
    readRelease: r1,
    controlState: state,
    workItem: compared.workItem,
    routeComparison: compared.comparison,
    selectedRoute: compared.selectedRoute,
    requestId: overrides.requestId ?? "request:content-blooms:placement-1",
    jobId: "job:content-blooms:placement-1",
    attemptId: "attempt:content-blooms:placement-1",
    effectIntentId: "effect:content-blooms:placement-1",
    reasonCode: "transcription_capacity_preference",
    requestedByActorDigest: sha256Digest({ actor: "owner" }),
    requestedAt: t8,
    expiresAt: t20,
  });
  return { release: r1,state,declaration: declared,...compared,request };
}

function approvalRequest(request: ContentBloomsPlacementRequestV1): ConsequentialApprovalRequestV1 {
  return {
    schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
    id: "approval-request:content-blooms:placement-1",
    tenantId,
    projectId,
    jobId: request.jobId,
    attemptId: request.attemptId,
    effectIntentId: request.effectIntentId,
    operationDigest: request.operationDigest,
    risk: "medium",
    requestedBy: { actorId: "agent:control-room",actorType: "agent",workerId: "worker:architect" },
    requiredFactor: "strong",
    requestedAt: t9,
    expiresAt: t19,
    grantsExecutionAuthority: false,
  };
}

function approvalDecision(
  request: ContentBloomsPlacementRequestV1,
  approval: ConsequentialApprovalRequestV1,
  decision: "approved" | "denied" = "approved",
): ConsequentialApprovalDecisionV1 {
  return {
    schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
    id: "approval-decision:content-blooms:placement-1",
    tenantId,
    projectId,
    requestId: approval.id,
    requestDigest: sha256Digest(approval),
    operationDigest: request.operationDigest,
    policyDecisionId: "policy-decision:content-blooms:placement-1",
    decision,
    decidedBy: { actorId: "identity:owner",actorType: "human" },
    factor: "strong",
    authenticationEventDigest: sha256Digest({ authentication: "strong-factor" }),
    decidedAt: t10,
    expiresAt: t18,
    safeReasonCode: decision === "approved" ? "owner_approved_placement" : "owner_denied_placement",
    grantsExecutionAuthority: false,
    requiresSeparateNodeAttestation: true,
  };
}

function authorizedFixture(): ReturnType<typeof placementRequestFixture> & {
  approvalRequest: ConsequentialApprovalRequestV1;
  approvalDecision: ConsequentialApprovalDecisionV1;
  authorization: ContentBloomsPlacementAuthorizationV1;
} {
  const fixture = placementRequestFixture();
  const requested = approvalRequest(fixture.request);
  const decided = approvalDecision(fixture.request, requested);
  const authorization = buildContentBloomsPlacementAuthorizationV1({
    request: fixture.request,
    approvalRequest: requested,
    approvalDecision: decided,
  });
  return { ...fixture,approvalRequest: requested,approvalDecision: decided,authorization };
}

test("CR9A-CB-050 declaration is independently reviewed but grants no command, lease, network, or execution authority", () => {
  const r1 = release();
  const declared = declaration(r1);
  assert.deepEqual(parseContentBloomsPlacementDeclarationV1(declared), declared);
  assert.equal(declared.command, "setWorkerPreference");
  assert.equal(declared.sourceOperation, "request_transcription_route_preference");
  assert.equal(declared.readReleaseDigest, r1.releaseDigest);
  assert.deepEqual({
    sourceOwnsEligibility: declared.sourceOwnsEligibility,
    sourceOwnsLeases: declared.sourceOwnsLeases,
    sourceOwnsDomainTransitions: declared.sourceOwnsDomainTransitions,
    requestChangesPreferenceOnly: declared.requestChangesPreferenceOnly,
    controlRoomMayAssign: declared.controlRoomMayAssign,
    controlRoomMayLease: declared.controlRoomMayLease,
    grantsApproval: declared.grantsApproval,
    grantsNetworkAuthority: declared.grantsNetworkAuthority,
    grantsCommandAuthority: declared.grantsCommandAuthority,
    grantsExecutionAuthority: declared.grantsExecutionAuthority,
  }, {
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    requestChangesPreferenceOnly: true,
    controlRoomMayAssign: false,
    controlRoomMayLease: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  });
  expectCode(() => buildContentBloomsPlacementDeclarationV1({
    declarationId: "declaration:correlated",
    readRelease: r1,
    commandSchemaDigest: sha256Digest({ schema: 1 }),
    sourceReceiptSchemaDigest: sha256Digest({ schema: 2 }),
    conformanceEvidenceDigest: sha256Digest({ evidence: 1 }),
    acceptanceProfileDigest: sha256Digest({ profile: 1 }),
    acceptedReviewDigest: sha256Digest({ review: 1 }),
    completionSnapshotDigest: sha256Digest({ snapshot: 1 }),
    producerIdentityDigest: sha256Digest({ same: true }),
    reviewerIdentityDigest: sha256Digest({ same: true }),
    acceptedAt: t1,
  }), "invalid_input");
});

test("CR9A-CB-050 request binds exact source version, eligible route, lifecycle, and stable effect idempotency", () => {
  const fixture = placementRequestFixture();
  const request = fixture.request;
  assert.deepEqual(parseContentBloomsPlacementRequestV1(request), request);
  assert.equal(request.expectedSourceVersion, fixture.workItem.sourceVersion);
  assert.equal(request.expectedSourceChecksum, fixture.workItem.sourceChecksum);
  assert.equal(request.expectedWorkItemRecordDigest, fixture.workItem.recordDigest);
  assert.equal(request.routeComparisonDigest, fixture.comparison.comparisonDigest);
  assert.equal(request.selectedRouteDigest, fixture.selectedRoute.routeDigest);
  assert.match(request.idempotencyKey, /^cb-placement:[a-f0-9]{64}$/);
  assert.deepEqual({
    preferenceRequestOnly: request.preferenceRequestOnly,
    controlRoomMayAssign: request.controlRoomMayAssign,
    controlRoomMayLease: request.controlRoomMayLease,
    grantsApproval: request.grantsApproval,
    grantsCommandAuthority: request.grantsCommandAuthority,
    grantsExecutionAuthority: request.grantsExecutionAuthority,
  }, {
    preferenceRequestOnly: true,
    controlRoomMayAssign: false,
    controlRoomMayLease: false,
    grantsApproval: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  });
  const changedId = placementRequestFixture({ requestId: "request:content-blooms:placement-replay" }).request;
  assert.equal(changedId.idempotencyKey, request.idempotencyKey);
  expectCode(() => requireExactContentBloomsPlacementRequestReplayV1(request, changedId), "replay_drift");
  assert.deepEqual(requireExactContentBloomsPlacementRequestReplayV1(request, request), request);
});

test("CR9A-CB-050 request rejects an ineligible route, stale lifecycle material, and route-expiry widening", () => {
  const fixture = placementRequestFixture();
  expectCode(() => buildContentBloomsPlacementRequestV1({
    declaration: fixture.declaration,
    readRelease: fixture.release,
    controlState: fixture.state,
    workItem: fixture.workItem,
    routeComparison: fixture.comparison,
    selectedRoute: fixture.busyRoute,
    requestId: "request:placement:busy",
    jobId: "job:placement:busy",
    attemptId: "attempt:placement:busy",
    effectIntentId: "effect:placement:busy",
    reasonCode: "busy_route_not_eligible",
    requestedByActorDigest: sha256Digest({ actor: "owner" }),
    requestedAt: t8,
    expiresAt: t20,
  }), "authority_conflation");
  expectCode(() => parseContentBloomsPlacementRequestV1({
    ...fixture.request,
    controlLifecycleRevision: fixture.request.controlLifecycleRevision + 1,
  }), "replay_drift");
  expectCode(() => buildContentBloomsPlacementRequestV1({
    declaration: fixture.declaration,
    readRelease: fixture.release,
    controlState: fixture.state,
    workItem: fixture.workItem,
    routeComparison: fixture.comparison,
    selectedRoute: fixture.selectedRoute,
    requestId: "request:placement:expired-route",
    jobId: "job:placement:expired-route",
    attemptId: "attempt:placement:expired-route",
    effectIntentId: "effect:placement:expired-route",
    reasonCode: "invalid_route_window",
    requestedByActorDigest: sha256Digest({ actor: "owner" }),
    requestedAt: t8,
    expiresAt: "2026-08-31T13:20:00.000Z",
  }), "request_expired");
});

test("CR9A-CB-050 authorization requires the exact approved strong-factor Completion Gate records", () => {
  const fixture = authorizedFixture();
  const authorization = fixture.authorization;
  assert.deepEqual(parseContentBloomsPlacementAuthorizationV1(authorization), authorization);
  assert.equal(authorization.approvalRequestDigest, sha256Digest(fixture.approvalRequest));
  assert.equal(authorization.approvalDecisionDigest, sha256Digest(fixture.approvalDecision));
  assert.equal(authorization.requiresSeparateNodeAttestation, true);
  assert.equal(authorization.requiresDurableEffectClaim, true);
  assert.equal(authorization.grantsExecutionAuthority, false);
  assert.deepEqual(requireExactContentBloomsPlacementAuthorizationReplayV1(authorization, authorization), authorization);
  expectCode(() => buildContentBloomsPlacementAuthorizationV1({
    request: fixture.request,
    approvalRequest: fixture.approvalRequest,
    approvalDecision: approvalDecision(fixture.request, fixture.approvalRequest, "denied"),
  }), "approval_denied");
  expectCode(() => buildContentBloomsPlacementAuthorizationV1({
    request: fixture.request,
    approvalRequest: fixture.approvalRequest,
    approvalDecision: { ...fixture.approvalDecision,operationDigest: sha256Digest({ wrong: "operation" }) },
  }), "approval_required");
});

test("CR9A-CB-050 read high-water preserves placement lifecycle while disable and re-enable invalidate old authorization", () => {
  const fixture = authorizedFixture();
  const readAdapter = new ContentBloomsInjectedReadAdapterV1(new ContentBloomsFixtureSourceV1());
  const readRequest = buildContentBloomsReadRequestV1({
    requestId: "request:placement:lifecycle-read",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    expectedReleaseDigest: fixture.release.releaseDigest,
    operation: "listWorkItems",
    limit: 1,
    requestedAt: t6,
  });
  const read = readAdapter.read({ request: readRequest,release: fixture.release,controlState: fixture.state,recordedAt: t7 });
  const advanced = advanceContentBloomsReadHighWaterV1({ state: fixture.state,receipt: read.receipt });
  assert.notEqual(advanced.stateDigest, fixture.state.stateDigest);
  assert.equal(advanced.lifecycleRevision, fixture.state.lifecycleRevision);
  assert.equal(contentBloomsControlLifecycleDigestV1(advanced), fixture.request.controlLifecycleDigest);
  assert.doesNotThrow(() => assertContentBloomsPlacementPreDispatchV1({
    request: fixture.request,
    authorization: fixture.authorization,
    declaration: fixture.declaration,
    readRelease: fixture.release,
    controlState: advanced,
    checkedAt: t11,
  }));
  const disable = buildContentBloomsControlTransitionV1({
    transitionId: "transition:placement:disable",
    tenantId,workspaceId,projectId,adapterId,
    action: "disable",
    expectedStateDigest: advanced.stateDigest,
    requestedByActorDigest: sha256Digest({ actor: "owner" }),
    reasonCode: "disable_invalidates_commands",
    requestedAt: t12,
  });
  const disabledResult = applyContentBloomsControlTransitionV1({ state: advanced,transition: disable,releases: [fixture.release] });
  const disabled = disabledResult.state;
  assert.equal(disabledResult.receipt.beforeLifecycleRevision, advanced.lifecycleRevision);
  assert.equal(disabledResult.receipt.afterLifecycleRevision, advanced.lifecycleRevision + 1);
  assert.equal(disabledResult.receipt.beforeLifecycleDigest, contentBloomsControlLifecycleDigestV1(advanced));
  assert.equal(disabledResult.receipt.afterLifecycleDigest, contentBloomsControlLifecycleDigestV1(disabled));
  expectCode(() => assertContentBloomsPlacementPreDispatchV1({
    request: fixture.request,authorization: fixture.authorization,declaration: fixture.declaration,
    readRelease: fixture.release,controlState: disabled,checkedAt: t13,
  }), "adapter_disabled");
  const enable = buildContentBloomsControlTransitionV1({
    transitionId: "transition:placement:re-enable",
    tenantId,workspaceId,projectId,adapterId,
    action: "enable_release",
    expectedStateDigest: disabled.stateDigest,
    targetReleaseDigest: fixture.release.releaseDigest,
    requestedByActorDigest: sha256Digest({ actor: "owner" }),
    reasonCode: "re_enable_requires_new_placement",
    requestedAt: t13,
  });
  const reenabled = applyContentBloomsControlTransitionV1({ state: disabled,transition: enable,releases: [fixture.release] }).state;
  assert.ok(reenabled.lifecycleRevision > fixture.request.controlLifecycleRevision);
  expectCode(() => assertContentBloomsPlacementPreDispatchV1({
    request: fixture.request,authorization: fixture.authorization,declaration: fixture.declaration,
    readRelease: fixture.release,controlState: reenabled,checkedAt: t14,
  }), "stale_state");
});

test("CR9A-CB-050 pre-dispatch gate expires at equality and remains a precondition, not command authority", () => {
  const fixture = authorizedFixture();
  const checked = assertContentBloomsPlacementPreDispatchV1({
    request: fixture.request,authorization: fixture.authorization,declaration: fixture.declaration,
    readRelease: fixture.release,controlState: fixture.state,checkedAt: t11,
  });
  assert.equal(checked.authorization.grantsCommandAuthority, false);
  assert.equal(checked.authorization.grantsExecutionAuthority, false);
  expectCode(() => assertContentBloomsPlacementPreDispatchV1({
    request: fixture.request,authorization: fixture.authorization,declaration: fixture.declaration,
    readRelease: fixture.release,controlState: fixture.state,checkedAt: t18,
  }), "request_expired");
});

test("CR9A-CB-050 source accepted, already-applied, and rejected receipts echo exact idempotency without claiming a lease", () => {
  const fixture = authorizedFixture();
  const common = {
    request: fixture.request,
    authorization: fixture.authorization,
    sourceReceiptId: "source-receipt:placement-1",
    sourceIdempotencyKey: fixture.request.idempotencyKey,
    dispatchClaimDigest: sha256Digest({ claim: "placement-1" }),
    preEffectMarkerDigest: sha256Digest({ marker: "placement-1" }),
    authenticatedTransportEvidenceDigest: sha256Digest({ transport: "placement-1" }),
    dispatchedAt: t11,
    sourceObservedAt: t12,
    receivedAt: t13,
  };
  const accepted = buildContentBloomsPlacementSourceReceiptV1({
    ...common,
    sourceCommandId: "source-command:placement-1",
    disposition: "accepted",
    appliedSourceVersion: "13",
  });
  assert.deepEqual(parseContentBloomsPlacementSourceReceiptV1(accepted), accepted);
  assert.deepEqual(assertContentBloomsPlacementOutcomeBindingV1({
    request: fixture.request,
    authorization: fixture.authorization,
    outcome: accepted,
  }), accepted);
  assert.equal(accepted.preferenceRecorded, true);
  assert.equal(accepted.sourceOwnsLeases, true);
  assert.equal(accepted.controlRoomMayLease, false);
  assert.equal(accepted.sameEffectRetryProhibited, true);
  const already = buildContentBloomsPlacementSourceReceiptV1({
    ...common,
    sourceReceiptId: "source-receipt:placement-already",
    sourceCommandId: "source-command:placement-1",
    disposition: "already_applied",
    appliedSourceVersion: fixture.request.expectedSourceVersion,
  });
  assert.equal(already.preferenceRecorded, true);
  const rejected = buildContentBloomsPlacementSourceReceiptV1({
    ...common,
    sourceReceiptId: "source-receipt:placement-stale",
    disposition: "rejected",
    safeReasonCode: "stale_source_version",
    observedSourceVersionDigest: sha256Digest({ sourceVersion: "14" }),
  });
  assert.equal(rejected.preferenceRecorded, false);
  assert.equal(rejected.appliedSourceVersion, undefined);
  assert.deepEqual(parseContentBloomsPlacementOutcomeReceiptV1(rejected), rejected);
  const { receiptDigest: _receiptDigest, ...acceptedUnsigned } = accepted;
  void _receiptDigest;
  const detachedRequestDigest = sha256Digest({ detached: "request" });
  const detachedUnsigned = {
    ...acceptedUnsigned,
    requestDigest: detachedRequestDigest,
    receiptId: `cb-placement-source:${sha256Digest({
      requestDigest: detachedRequestDigest,
      sourceReceiptId: accepted.sourceReceiptId,
    }).slice(7, 39)}`,
  };
  const detached = { ...detachedUnsigned,receiptDigest: sha256Digest(detachedUnsigned) };
  assert.deepEqual(parseContentBloomsPlacementSourceReceiptV1(detached), detached);
  expectCode(() => assertContentBloomsPlacementOutcomeBindingV1({
    request: fixture.request,
    authorization: fixture.authorization,
    outcome: detached,
  }), "replay_drift");
  expectCode(() => buildContentBloomsPlacementSourceReceiptV1({
    ...common,
    sourceCommandId: "source-command:placement-wrong-key",
    sourceIdempotencyKey: "cb-placement:0000000000000000000000000000000000000000000000000000000000000000",
    disposition: "accepted",
    appliedSourceVersion: "13",
  }), "source_receipt_invalid");
  expectCode(() => buildContentBloomsPlacementSourceReceiptV1({
    ...common,
    sourceCommandId: "source-command:placement-same-version",
    disposition: "accepted",
    appliedSourceVersion: fixture.request.expectedSourceVersion,
  }), "source_receipt_invalid");
});

test("CR9A-CB-050 ambiguity is terminal for automatic retry and can only await source reconciliation", () => {
  const fixture = authorizedFixture();
  const ambiguous = buildContentBloomsPlacementAmbiguityReceiptV1({
    request: fixture.request,
    authorization: fixture.authorization,
    dispatchClaimDigest: sha256Digest({ claim: "ambiguous-placement" }),
    preEffectMarkerDigest: sha256Digest({ marker: "ambiguous-placement" }),
    ambiguityEvidenceDigest: sha256Digest({ evidence: "connection-ended-without-source-receipt" }),
    dispatchedAt: t11,
    raisedAt: t14,
  });
  assert.deepEqual(parseContentBloomsPlacementAmbiguityReceiptV1(ambiguous), ambiguous);
  assert.deepEqual(parseContentBloomsPlacementOutcomeReceiptV1(ambiguous), ambiguous);
  assert.equal(ambiguous.sourceReceiptObserved, false);
  assert.equal(ambiguous.sameEffectRetryProhibited, true);
  assert.equal(ambiguous.requiresSourceReconciliation, true);
  assert.equal(ambiguous.newAuthorizationRequiredForAnyNewEffect, true);
  assert.deepEqual(requireExactContentBloomsPlacementOutcomeReplayV1(ambiguous, ambiguous), ambiguous);
  const settled = buildContentBloomsPlacementSourceReceiptV1({
    request: fixture.request,
    authorization: fixture.authorization,
    sourceReceiptId: "source-receipt:after-ambiguity",
    sourceCommandId: "source-command:after-ambiguity",
    sourceIdempotencyKey: fixture.request.idempotencyKey,
    disposition: "already_applied",
    appliedSourceVersion: "13",
    dispatchClaimDigest: ambiguous.dispatchClaimDigest,
    preEffectMarkerDigest: ambiguous.preEffectMarkerDigest,
    authenticatedTransportEvidenceDigest: sha256Digest({ reconciliation: "source-query" }),
    dispatchedAt: t11,
    sourceObservedAt: t12,
    receivedAt: t13,
  });
  expectCode(() => requireExactContentBloomsPlacementOutcomeReplayV1(ambiguous, settled), "replay_drift");
});

test("CR9A-CB-050 exact placement boundary rejects Proxies without executing traps", () => {
  const fixture = placementRequestFixture();
  const candidate = observedProxy(fixture.request, "throwing");
  expectCode(() => parseContentBloomsPlacementRequestV1(candidate.value), "invalid_input");
  assert.equal(candidate.trapCount(), 0);
});
