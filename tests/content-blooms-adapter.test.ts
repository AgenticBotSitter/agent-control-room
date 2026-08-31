import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applyContentBloomsControlTransitionV1,
  buildContentBloomsAdapterReleaseV1,
  buildContentBloomsControlTransitionV1,
  buildContentBloomsOperationalRecordV1,
  buildContentBloomsReadPageV1,
  buildContentBloomsReadReceiptV1,
  buildContentBloomsReadRequestV1,
  buildContentBloomsRouteComparisonPolicyV1,
  buildContentBloomsSyntheticFixtureRecordsV1,
  buildContentBloomsTranscriptionRouteObservationV1,
  buildInitialContentBloomsControlStateV1,
  compareContentBloomsTranscriptionRoutesV1,
  ContentBloomsContractErrorV1,
  ContentBloomsFixtureSourceV1,
  ContentBloomsInjectedReadAdapterV1,
  ContentBloomsSyncStoreV1,
  parseContentBloomsRouteComparisonV1,
  parseContentBloomsTranscriptionRouteObservationV1,
  type ContentBloomsAdapterControlStateV1,
  type ContentBloomsAdapterReleaseV1,
  type ContentBloomsReadOperationV1,
  type ContentBloomsReadSourceV1,
} from "../src/project-adapters/content-blooms/v1/index.ts";
import { adaptPglite } from "../src/persistence/database.ts";
import { assertNoSecretMaterial, sha256Digest } from "../src/security/index.ts";
import { assertSafeProjection } from "../src/contracts/v1/index.ts";
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

function expectCode(action: () => unknown, code: ContentBloomsContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) => error instanceof ContentBloomsContractErrorV1 && error.safeCode === code);
}

async function expectCodeAsync(action: () => Promise<unknown>, code: ContentBloomsContractErrorV1["safeCode"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof ContentBloomsContractErrorV1 && error.safeCode === code);
}

async function migratedDatabase(): Promise<PGlite> {
  const db = new PGlite();
  const files = (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await db.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [tenantId, "Synthetic owner"]);
  return db;
}

function release(): ContentBloomsAdapterReleaseV1 {
  return buildContentBloomsAdapterReleaseV1({
    releaseId: "release:content-blooms:offline-r1",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    redactionPolicyVersion: "content-blooms-safe.v1",
    adapterPackageDigest: sha256Digest({ package: "offline-r1" }),
    projectionSchemaDigest: sha256Digest({ schema: "offline-r1" }),
    conformanceEvidenceDigest: sha256Digest({ conformance: "offline-r1" }),
    acceptanceProfileDigest: sha256Digest({ acceptanceProfile: "offline-r1" }),
    acceptedReviewDigest: sha256Digest({ acceptedReview: "offline-r1" }),
    completionSnapshotDigest: sha256Digest({ completionSnapshot: "offline-r1" }),
    producerIdentityDigest: sha256Digest({ producer: "offline-r1" }),
    reviewerIdentityDigest: sha256Digest({ reviewer: "offline-r1" }),
    acceptedAt: t0,
  });
}

function enabledState(r1: ContentBloomsAdapterReleaseV1): ContentBloomsAdapterControlStateV1 {
  const initial = buildInitialContentBloomsControlStateV1({
    stateId,
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    initializedAt: t0,
  });
  const transition = buildContentBloomsControlTransitionV1({
    transitionId: "transition:content-blooms:offline-enable",
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    action: "enable_release",
    expectedStateDigest: initial.stateDigest,
    targetReleaseDigest: r1.releaseDigest,
    requestedByActorDigest: sha256Digest({ actor: "synthetic-owner" }),
    reasonCode: "offline_contract_acceptance",
    requestedAt: t1,
  });
  return applyContentBloomsControlTransitionV1({ state: initial, transition, releases: [r1] }).state;
}

function request(
  r1: ContentBloomsAdapterReleaseV1,
  operation: ContentBloomsReadOperationV1,
  requestId: string,
  requestedAt: string,
  limit: number,
  afterCursor?: string,
) {
  return buildContentBloomsReadRequestV1({
    requestId,
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    expectedReleaseDigest: r1.releaseDigest,
    operation,
    ...(afterCursor ? { afterCursor } : {}),
    limit,
    requestedAt,
  });
}

test("CR9A-CB-010 fixture covers sanitized project, work, execution, blocker, worker, and attention facts", () => {
  const records = buildContentBloomsSyntheticFixtureRecordsV1();
  assert.equal(records.length, 13);
  assert.deepEqual(new Set(records.map((record) => record.kind)), new Set(["project", "work_item", "execution", "blocker", "worker", "attention"]));
  assert.equal(records.filter((record) => record.kind === "work_item").length, 4);
  assert.equal(records.filter((record) => record.kind === "worker").length, 3);
  assert.ok(records.some((record) => record.kind === "work_item"
    && (record.projection as { domainState: string }).domainState === "transcription_capacity"));
  assert.ok(records.some((record) => record.kind === "work_item"
    && (record.projection as { domainState: string }).domainState === "customer_input_required"));
  assert.ok(records.some((record) => record.kind === "work_item"
    && (record.projection as { domainState: string }).domainState === "awaiting_operator_review"));
  assertNoSecretMaterial(records, "Content Blooms fixture");
  assertSafeProjection(records);
  assert.doesNotMatch(JSON.stringify(records), /transcriptText|draftBody|signedUrl|rawMedia/i);
});

test("CR9A-CB-010 fixture constructor rejects a Proxy array without executing its traps", () => {
  const candidate = observedProxy(buildContentBloomsSyntheticFixtureRecordsV1(), "throwing");
  expectCode(() => new ContentBloomsFixtureSourceV1(candidate.value), "invalid_input");
  assert.equal(candidate.trapCount(), 0);
});

test("CR9A-CB-020 injected adapter serves all seven operations without an endpoint or command", () => {
  const r1 = release(), state = enabledState(r1);
  const adapter = new ContentBloomsInjectedReadAdapterV1(new ContentBloomsFixtureSourceV1());
  const expectedCounts: Record<ContentBloomsReadOperationV1, number> = {
    getProjectSummary: 1,
    listWorkItems: 4,
    listExecutions: 1,
    listBlockers: 2,
    listWorkers: 3,
    listAttentionItems: 2,
    readChanges: 13,
  };
  for (const [index, operation] of Object.keys(expectedCounts).entries()) {
    const typedOperation = operation as ContentBloomsReadOperationV1;
    const result = adapter.read({
      request: request(r1, typedOperation, `request:fixture:${index}`, t6, typedOperation === "getProjectSummary" ? 1 : 100),
      release: r1,
      controlState: state,
      recordedAt: t7,
    });
    assert.equal(result.records.length, expectedCounts[typedOperation]);
    assert.equal(result.receipt.operation, typedOperation);
    assert.equal(result.receipt.grantsNetworkAuthority, false);
    assert.equal(result.receipt.grantsCommandAuthority, false);
    assert.equal(result.receipt.grantsLeaseAuthority, false);
    assert.equal(result.receipt.grantsExecutionAuthority, false);
  }
  assert.equal("endpoint" in adapter, false);
});

test("CR9A-CB-020 disabled state fails before the injected source can be invoked", () => {
  const r1 = release();
  const disabled = buildInitialContentBloomsControlStateV1({
    stateId,
    tenantId,
    workspaceId,
    projectId,
    adapterId,
    initializedAt: t0,
  });
  let sourceCalls = 0;
  class CountingSource implements ContentBloomsReadSourceV1 {
    read(): void {
      sourceCalls += 1;
      throw new Error("disabled adapter must not reach source");
    }
  }
  const adapter = new ContentBloomsInjectedReadAdapterV1(new CountingSource());
  expectCode(() => adapter.read({
    request: request(r1, "listWorkItems", "request:disabled:1", t6, 10),
    release: r1,
    controlState: disabled,
    recordedAt: t7,
  }), "adapter_disabled");
  assert.equal(sourceCalls, 0);
});

test("CR9A-CB-020 source handoff rejects Proxy results without executing Proxy traps", () => {
  const r1 = release(), state = enabledState(r1);
  const candidate = observedProxy({
    pageId: "page:proxy:1",
    nextCursor: "cursor-proxy-1",
    hasMore: false,
    sourceSnapshotVersion: "snapshot-proxy-1",
    sourceObservedAt: t6,
    records: [],
  }, "throwing");
  class ProxySource implements ContentBloomsReadSourceV1 {
    read(_request: Parameters<ContentBloomsReadSourceV1["read"]>[0], collector: Parameters<ContentBloomsReadSourceV1["read"]>[1]): void {
      collector.submit(candidate.value);
    }
  }
  const adapter = new ContentBloomsInjectedReadAdapterV1(new ProxySource());
  expectCode(() => adapter.read({
    request: request(r1, "listWorkItems", "request:proxy:1", t6, 10),
    release: r1,
    controlState: state,
    recordedAt: t7,
  }), "source_unavailable");
  assert.equal(candidate.trapCount(), 0);
});

test("CR9A-CB-030 atomically commits two pages, cursor, receipt, history, current records, and control high-water", async () => {
  const db = await migratedDatabase();
  try {
    const r1 = release(), state = enabledState(r1), adapter = new ContentBloomsInjectedReadAdapterV1(new ContentBloomsFixtureSourceV1());
    const store = new ContentBloomsSyncStoreV1(adaptPglite(db), { tenantId,workspaceId,projectId,adapterId,stateId });
    await store.initialize(r1, state);
    const firstRequest = request(r1, "listWorkItems", "request:sync:work:1", t6, 2);
    const first = adapter.read({ request: firstRequest, release: r1, controlState: state, recordedAt: t7 });
    assert.equal(first.page.hasMore, true);
    const firstCommit = await store.commitRead(first);
    assert.deepEqual({ replayed: firstCommit.replayed, current: firstCommit.appliedCurrentRecords, history: firstCommit.appendedHistoryRecords }, {
      replayed: false, current: 2, history: 2,
    });
    assert.equal(await store.cursor("listWorkItems"), first.nextCursor);
    const secondRequest = request(r1, "listWorkItems", "request:sync:work:2", t8, 2, first.nextCursor);
    const second = adapter.read({ request: secondRequest, release: r1, controlState: firstCommit.state, recordedAt: t9 });
    assert.equal(second.page.hasMore, false);
    const secondCommit = await store.commitRead(second);
    assert.equal(secondCommit.replayed, false);
    assert.equal((await store.currentRecords("work_item")).length, 4);
    assert.equal(await store.receiptCount(), 2);
    assert.equal(await store.historyCount(), 4);
    assert.equal(await store.cursor("listWorkItems"), second.nextCursor);
    assert.equal(secondCommit.state.lastReadReceiptDigest, second.receipt.receiptDigest);
    assert.equal(secondCommit.state.lastCommittedCursorDigest, second.receipt.nextCursorDigest);
  } finally {
    await db.close();
  }
});

test("CR9A-CB-030 survives store reconstruction and exact old-page replay stays inert", async () => {
  const db = await migratedDatabase();
  try {
    const r1 = release(), state = enabledState(r1), adapter = new ContentBloomsInjectedReadAdapterV1(new ContentBloomsFixtureSourceV1());
    const scope = { tenantId,workspaceId,projectId,adapterId,stateId };
    const firstStore = new ContentBloomsSyncStoreV1(adaptPglite(db), scope);
    await firstStore.initialize(r1, state);
    const page = adapter.read({
      request: request(r1, "listBlockers", "request:restart:blockers", t6, 100),
      release: r1,
      controlState: state,
      recordedAt: t7,
    });
    const committed = await firstStore.commitRead(page);
    const reconstructed = new ContentBloomsSyncStoreV1(adaptPglite(db), scope);
    assert.equal((await reconstructed.loadState()).stateDigest, committed.state.stateDigest);
    assert.equal(await reconstructed.cursor("listBlockers"), page.nextCursor);
    assert.equal((await reconstructed.currentRecords("blocker")).length, 2);
    const replay = await reconstructed.commitRead(page);
    assert.equal(replay.replayed, true);
    assert.equal(replay.appliedCurrentRecords, 0);
    assert.equal(await reconstructed.receiptCount(), 1);
    assert.equal(await reconstructed.historyCount(), 2);
  } finally {
    await db.close();
  }
});

test("CR9A-CB-030 same source version drift rolls back the entire page transaction", async () => {
  const db = await migratedDatabase();
  try {
    const r1 = release(), state = enabledState(r1), adapter = new ContentBloomsInjectedReadAdapterV1(new ContentBloomsFixtureSourceV1());
    const store = new ContentBloomsSyncStoreV1(adaptPglite(db), { tenantId,workspaceId,projectId,adapterId,stateId });
    await store.initialize(r1, state);
    const first = adapter.read({
      request: request(r1, "listWorkItems", "request:drift:1", t6, 1),
      release: r1,
      controlState: state,
      recordedAt: t7,
    });
    const committed = await store.commitRead(first);
    const original = first.records[0];
    const changed = buildContentBloomsOperationalRecordV1({
      kind: "work_item",
      operation: "upsert",
      tenantId,
      workspaceId,
      projectId,
      adapterId,
      sourceRecordId: original.sourceRecordId,
      sourceVersion: original.sourceVersion,
      observedAt: t8,
      projection: {
        ...(original.projection as unknown as Record<string, unknown>),
        title: "Conflicting same-version synthetic title",
        updatedAt: t8,
      },
    });
    const nextRequest = request(r1, "listWorkItems", "request:drift:2", t8, 1, first.nextCursor);
    const page = buildContentBloomsReadPageV1({
      request: nextRequest,
      release: r1,
      pageId: "page:drift:2",
      nextCursor: "cursor-drift-2",
      hasMore: false,
      sourceSnapshotVersion: "snapshot-drift-2",
      sourceObservedAt: t8,
      records: [changed],
    });
    const candidate = buildContentBloomsReadReceiptV1({
      request: nextRequest,
      page,
      release: r1,
      controlState: committed.state,
      recordedAt: t9,
    });
    await expectCodeAsync(() => store.commitRead(candidate), "replay_drift");
    assert.equal(await store.receiptCount(), 1);
    assert.equal(await store.historyCount(), 1);
    assert.equal(await store.cursor("listWorkItems"), first.nextCursor);
    assert.equal((await store.currentRecords("work_item"))[0].recordDigest, original.recordDigest);
  } finally {
    await db.close();
  }
});

test("CR9A-CB-030 refuses independently re-digested receipts that do not exactly bind their page", async () => {
  const db = await migratedDatabase();
  try {
    const r1 = release(), state = enabledState(r1);
    const adapter = new ContentBloomsInjectedReadAdapterV1(new ContentBloomsFixtureSourceV1());
    const store = new ContentBloomsSyncStoreV1(adaptPglite(db), { tenantId,workspaceId,projectId,adapterId,stateId });
    await store.initialize(r1, state);
    const read = adapter.read({
      request: request(r1, "listWorkItems", "request:binding:1", t6, 1),
      release: r1,
      controlState: state,
      recordedAt: t7,
    });
    const alteredFields: Array<Record<string, unknown>> = [
      { pageId: "page:binding:other" },
      { requestDigest: sha256Digest({ forged: "request" }) },
      { releaseDigest: sha256Digest({ forged: "release" }) },
      { operation: "listBlockers" },
      { sourceSnapshotVersion: "fixture:forged-snapshot" },
      { sourceObservedAt: t8 },
    ];
    for (const changed of alteredFields) {
      const { receiptDigest: _receiptDigest, ...knownUnsigned } = read.receipt;
      void _receiptDigest;
      const unsigned = { ...knownUnsigned, ...changed };
      const forged = { ...unsigned, receiptDigest: sha256Digest(unsigned) };
      await expectCodeAsync(() => store.commitRead({ ...read, receipt: forged }), "replay_drift");
    }
    const { receiptDigest: _receiptDigest, ...knownUnsigned } = read.receipt;
    void _receiptDigest;
    const prematureUnsigned = { ...knownUnsigned, recordedAt: t0 };
    const premature = { ...prematureUnsigned, receiptDigest: sha256Digest(prematureUnsigned) };
    await expectCodeAsync(() => store.commitRead({ ...read, receipt: premature }), "sequence_invalid");
    assert.equal(await store.receiptCount(), 0);
    assert.equal(await store.historyCount(), 0);
    assert.deepEqual(await store.currentRecords(), []);
  } finally {
    await db.close();
  }
});

test("CR9A-CB-030 immutable release, receipt, and history tables reject mutation", async () => {
  const db = await migratedDatabase();
  try {
    const r1 = release(), state = enabledState(r1), adapter = new ContentBloomsInjectedReadAdapterV1(new ContentBloomsFixtureSourceV1());
    const store = new ContentBloomsSyncStoreV1(adaptPglite(db), { tenantId,workspaceId,projectId,adapterId,stateId });
    await store.initialize(r1, state);
    const read = adapter.read({
      request: request(r1, "listExecutions", "request:append-only:1", t6, 100),
      release: r1,
      controlState: state,
      recordedAt: t7,
    });
    await store.commitRead(read);
    await assert.rejects(db.query("UPDATE control_content_blooms_releases SET release_id='changed'"), /append-only/i);
    await assert.rejects(db.query("DELETE FROM control_content_blooms_read_receipts"), /append-only/i);
    await assert.rejects(db.query("UPDATE control_content_blooms_record_history SET source_version='changed'"), /append-only/i);
  } finally {
    await db.close();
  }
});

function route(
  platform: "macos" | "windows" | "linux",
  routeId: string,
  state: "idle" | "busy" | "offline",
  duration: number,
  qualityRank: number,
) {
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
    qualityRank,
    privacyClass: "local",
    benchmarkVersion: "benchmark.synthetic.v1",
    benchmarkDigest: sha256Digest({ benchmark: routeId }),
    observedAt: t6,
    validUntil: "2026-08-30T13:06:00.000Z",
  });
}

test("CR9A-CB-040 deterministically compares Mac, Windows, and VPS routes as a source preference only", () => {
  const records = buildContentBloomsSyntheticFixtureRecordsV1();
  const workItem = records.find((record) => record.kind === "work_item"
    && record.sourceRecordId === "recording-queue-1042")!;
  const mac = route("macos", "route:mac:mlx", "busy", 150, 5);
  const windows = route("windows", "route:windows:cuda", "idle", 120, 5);
  const vps = route("linux", "route:vps:cpu", "idle", 900, 4);
  const policy = buildContentBloomsRouteComparisonPolicyV1({
    policyId: "policy:transcription:synthetic",
    maxCostMilliUsd: 0,
    minimumQualityRank: 4,
    allowedPrivacyClasses: ["local"],
    allowBusy: false,
    durationWeight: 10,
    costWeight: 1,
    qualityWeight: 100,
    privacyWeight: 1_000,
  });
  const input = { tenantId,workspaceId,projectId,adapterId,workItem,policy,comparedAt: t7 };
  const comparison = compareContentBloomsTranscriptionRoutesV1({ ...input, routes: [mac, windows, vps] });
  const reordered = compareContentBloomsTranscriptionRoutesV1({ ...input, routes: [vps, mac, windows] });
  assert.deepEqual(parseContentBloomsRouteComparisonV1(comparison), comparison);
  assert.equal(comparison.comparisonDigest, reordered.comparisonDigest);
  assert.equal(comparison.recommendedRouteId, "route:windows:cuda");
  assert.deepEqual(comparison.eligibleRoutes.map((candidate) => candidate.routeId), ["route:windows:cuda", "route:vps:cpu"]);
  assert.deepEqual(comparison.rejectedRouteIds, ["route:mac:mlx"]);
  assert.deepEqual({
    disposition: comparison.disposition,
    sourceMustDecide: comparison.sourceMustDecide,
    controlRoomMayAssign: comparison.controlRoomMayAssign,
    grantsApproval: comparison.grantsApproval,
    grantsCommandAuthority: comparison.grantsCommandAuthority,
    grantsLeaseAuthority: comparison.grantsLeaseAuthority,
    grantsExecutionAuthority: comparison.grantsExecutionAuthority,
  }, {
    disposition: "source_preference_observation",
    sourceMustDecide: true,
    controlRoomMayAssign: false,
    grantsApproval: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  });
  expectCode(() => parseContentBloomsTranscriptionRouteObservationV1({ ...windows, platform: "macos" }), "replay_drift");
});

test("CR9A-CB-040 no eligible route is an honest observation, not an assignment or failure-open", () => {
  const workItem = buildContentBloomsSyntheticFixtureRecordsV1().find((record) => record.kind === "work_item"
    && record.sourceRecordId === "recording-queue-1042")!;
  const policy = buildContentBloomsRouteComparisonPolicyV1({
    policyId: "policy:transcription:no-route",
    maxCostMilliUsd: 0,
    minimumQualityRank: 5,
    allowedPrivacyClasses: ["restricted"],
    allowBusy: false,
    durationWeight: 1,
    costWeight: 1,
    qualityWeight: 1,
    privacyWeight: 1,
  });
  const comparison = compareContentBloomsTranscriptionRoutesV1({
    tenantId,workspaceId,projectId,adapterId,workItem,policy,comparedAt: t7,
    routes: [route("macos", "route:mac:mlx", "busy", 150, 5), route("windows", "route:windows:cuda", "offline", 120, 5)],
  });
  assert.equal(comparison.recommendedRouteId, undefined);
  assert.deepEqual(comparison.eligibleRoutes, []);
  assert.equal(comparison.rejectedRouteIds.length, 2);
  assert.equal(comparison.controlRoomMayAssign, false);
});

test("CR9A-CB-040 refuses route comparison for a non-transcription work item or cross-tenant route", () => {
  const records = buildContentBloomsSyntheticFixtureRecordsV1();
  const research = records.find((record) => record.kind === "work_item" && record.sourceRecordId === "research-plan-882")!;
  const transcription = records.find((record) => record.kind === "work_item" && record.sourceRecordId === "recording-queue-1042")!;
  const policy = buildContentBloomsRouteComparisonPolicyV1({
    policyId: "policy:transcription:scope",
    maxCostMilliUsd: 0,
    minimumQualityRank: 4,
    allowedPrivacyClasses: ["local"],
    allowBusy: true,
    durationWeight: 1,
    costWeight: 1,
    qualityWeight: 1,
    privacyWeight: 1,
  });
  const windows = route("windows", "route:windows:cuda", "idle", 120, 5);
  expectCode(() => compareContentBloomsTranscriptionRoutesV1({
    tenantId,workspaceId,projectId,adapterId,workItem: research,policy,comparedAt: t7,routes: [windows],
  }), "authority_conflation");
  const otherTenant = buildContentBloomsTranscriptionRouteObservationV1({
    tenantId: "tenant:other",
    workspaceId,
    projectId,
    adapterId,
    routeId: "route:windows:other",
    workerRefDigest: sha256Digest({ worker: "other" }),
    platform: "windows",
    runtimeClass: "whisper_cuda",
    state: "idle",
    verification: "verified",
    estimatedDurationSeconds: 120,
    estimatedCostMilliUsd: 0,
    qualityRank: 5,
    privacyClass: "local",
    benchmarkVersion: "benchmark.synthetic.v1",
    benchmarkDigest: sha256Digest({ benchmark: "other" }),
    observedAt: t6,
    validUntil: "2026-08-30T13:06:00.000Z",
  });
  expectCode(() => compareContentBloomsTranscriptionRoutesV1({
    tenantId,workspaceId,projectId,adapterId,workItem: transcription,policy,comparedAt: t7,routes: [otherTenant],
  }), "scope_mismatch");
});
