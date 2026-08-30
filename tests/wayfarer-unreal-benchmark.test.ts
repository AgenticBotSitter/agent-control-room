import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildCurrentWayfarerUnrealBenchmarkDisabledV1, buildWayfarerUnrealBenchmarkDisabledDispositionV1,
  buildWayfarerUnrealBenchmarkEvidenceV1, buildWayfarerUnrealBenchmarkPacketV1,
  buildWayfarerUnrealBenchmarkPrerequisiteV1, buildWayfarerUnrealBenchmarkReadinessV1,
  parseWayfarerUnrealBenchmarkEvidenceV1, parseWayfarerUnrealBenchmarkPacketV1,
  SqliteWayfarerUnrealReadinessStoreV1, WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1
} from "../src/project-adapters/wayfarer/v1";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const current = () => buildCurrentWayfarerUnrealBenchmarkDisabledV1();
const scope = { tenantId: "tenant:wayfarer", workspaceId: "workspace:lofi-wayfarer", projectId: "project:lofi-wayfarer" };
const key = new Uint8Array(32).fill(91), checkedAt = "2026-08-30T00:00:00.000Z";
const d = (value: unknown) => sha256Digest(value);
function error(code: string) { return (value: unknown) => value instanceof ProjectWorkspaceContractErrorV1 && value.safeCode === code; }
function prerequisites(state: "met" | "missing", packetDigest = buildWayfarerUnrealBenchmarkPacketV1().packetDigest, at = checkedAt) {
  return WAYFARER_UNREAL_BENCHMARK_GATE_IDS_V1.map((gateId) => state === "missing"
    ? buildWayfarerUnrealBenchmarkPrerequisiteV1({ gateId, state, checkedAt: at, safeReasonCode: `missing_${gateId}` })
    : buildWayfarerUnrealBenchmarkPrerequisiteV1({ gateId, state, evidenceDigest: gateId === "exact_benchmark_packet"
      ? packetDigest : d({ gateId, evidence: "qualified" }), checkedAt: at, validUntil: "2026-08-30T01:00:00.000Z",
      safeReasonCode: `qualified_${gateId}` }));
}
function blocked(id = "assessment:wayfarer:unreal:blocked", at = checkedAt) {
  const packet = buildWayfarerUnrealBenchmarkPacketV1(), assessment = buildWayfarerUnrealBenchmarkReadinessV1({ assessmentId: id,
    ...scope, candidatePacketId: packet.packetId, candidatePacketDigest: packet.packetDigest,
    prerequisites: prerequisites("missing", packet.packetDigest, at), assessedAt: at });
  return { assessment, disposition: buildWayfarerUnrealBenchmarkDisabledDispositionV1({ assessment,
    recordedAt: new Date(Date.parse(at) + 60_000).toISOString() }) };
}
async function location(label = "ledger") { const directory = await mkdtemp(join(tmpdir(), "wayfarer-unreal-readiness-"));
  return { directory, path: join(directory, `${label}.sqlite`) }; }
function evidenceBase() { const packet = buildWayfarerUnrealBenchmarkPacketV1(); return { packet,
  evidenceId: "evidence:wayfarer:unreal:measured:1", attemptId: "attempt:wayfarer:unreal:1",
  nodeIdentityDigest: d({ node: 1 }), toolIdentityDigest: d({ tool: 1 }), sceneIdentityDigest: d({ scene: 1, size: 100 }),
  environmentFingerprint: d({ environment: 1 }), startedAt: "2026-08-30T00:05:00.000Z",
  settledAt: "2026-08-30T00:10:00.000Z", measurements: { wallClockMs: 300_000, framesPerSecond: 1,
    peakMemoryBytes: 12_884_901_888, peakScratchBytes: 32_212_254_720, outputSizeBytes: 1_048_576 },
  outputContentDigest: d({ output: 1 }), ownerWindowDigest: d({ window: 1 }),
  nodeApprovalAttestationDigest: d({ approval: 1 }), networkEnforcementEvidenceDigest: d({ network: "denied" }),
  nativeExecutionReceiptDigest: d({ execution: 1 }), measurementEvidenceDigest: d({ measurements: 1 }),
  cleanupReceiptDigest: d({ cleanup: 1 }), cleanupConfirmed: true }; }

test("CR9B-WF-080 freezes one bounded digest-only Unreal scene/render packet", () => {
  const packet = buildWayfarerUnrealBenchmarkPacketV1();
  assert.deepEqual(parseWayfarerUnrealBenchmarkPacketV1(packet), packet);
  assert.deepEqual(packet.workload, { widthPixels: 1920, heightPixels: 1080, frameCount: 300, warmupRuns: 1,
    measuredRuns: 3, aggregation: "median_wall_clock", deterministicSettingsRequired: true });
  assert.deepEqual({ memory: packet.limits.minimumMemoryBytes, scratch: packet.limits.minimumScratchBytes,
    runtime: packet.limits.maximumRuntimeSeconds, attempts: packet.limits.maximumAttempts, cost: packet.limits.maximumCostUsd,
    network: packet.limits.networkPolicy }, { memory: 16 * 1_073_741_824, scratch: 64 * 1_073_741_824,
    runtime: 900, attempts: 1, cost: 0, network: "forbidden" });
  assert.equal(!packet.storesPaths && !packet.storesSceneOrRenderBytes && !packet.allowsNativeExecution
    && !packet.grantsApproval && !packet.grantsExecutionAuthority, true);
});

test("CR9B-WF-080 current truth freezes the packet and durably disables the other twelve gates", () => {
  const value = current(), met = value.assessment.prerequisites.filter((item) => item.state === "met");
  assert.deepEqual(met.map((item) => item.gateId), ["exact_benchmark_packet"]);
  assert.equal(value.assessment.blockingGateIds.length, 12); assert.equal(value.disposition.blockingGateIds.length, 12);
  assert.deepEqual({ readiness: value.assessment.readiness, eligible: value.assessment.eligibleForOwnerWindow,
    attempted: value.disposition.nativeAttempted, gpu: value.disposition.gpuWorkObserved, scene: value.disposition.sceneReadObserved,
    output: value.disposition.renderOutputObserved, effect: value.disposition.externalEffectOccurred,
    authorized: value.disposition.benchmarkAuthorized, unreal: value.disposition.unrealEligible,
    retry: value.disposition.automaticRetryAllowed }, { readiness: "blocked", eligible: false, attempted: false, gpu: false,
    scene: false, output: false, effect: false, authorized: false, unreal: false, retry: false });
});

test("CR9B-WF-080 complete prerequisites produce only an owner-window candidate, never benchmark authority", () => {
  const packet = buildWayfarerUnrealBenchmarkPacketV1(), assessment = buildWayfarerUnrealBenchmarkReadinessV1({
    assessmentId: "assessment:wayfarer:unreal:candidate", ...scope, candidatePacketId: packet.packetId,
    candidatePacketDigest: packet.packetDigest, prerequisites: prerequisites("met", packet.packetDigest), assessedAt: checkedAt });
  assert.deepEqual({ readiness: assessment.readiness, eligible: assessment.eligibleForOwnerWindow,
    coordinator: assessment.nativeCoordinatorImplemented, authorized: assessment.benchmarkAuthorized,
    approval: assessment.grantsApproval, execution: assessment.grantsExecutionAuthority },
  { readiness: "candidate_for_owner_window", eligible: true, coordinator: false, authorized: false, approval: false, execution: false });
  assert.throws(() => buildWayfarerUnrealBenchmarkDisabledDispositionV1({ assessment,
    recordedAt: "2026-08-30T00:01:00.000Z" }), error("unsupported_action"));
});

test("CR9B-WF-080 measured pass is only a review candidate and cannot activate Unreal or resolve media", () => {
  const evidence = buildWayfarerUnrealBenchmarkEvidenceV1({ ...evidenceBase(), outcome: "measured_pass" });
  assert.deepEqual(parseWayfarerUnrealBenchmarkEvidenceV1(evidence), evidence);
  assert.equal(evidence.executionAttempted && evidence.preEffectMarkerRecorded && evidence.cleanupConfirmed
    && evidence.candidateForRouteQualification, true);
  assert.equal(!evidence.automaticallyActivatesRoute && !evidence.resolvesMediaCompletion && !evidence.unrealEligible
    && evidence.requiresIndependentReview && !evidence.requiresReconciliation && !evidence.grantsApproval
    && !evidence.grantsExecutionAuthority, true);
});

test("CR9B-WF-080 blocked and ambiguous evidence preserve negative truth and forbid invented measurements", () => {
  const base = evidenceBase(), blockedEvidence = buildWayfarerUnrealBenchmarkEvidenceV1({ evidenceId: base.evidenceId,
    packet: base.packet, attemptId: base.attemptId, nodeIdentityDigest: base.nodeIdentityDigest,
    toolIdentityDigest: base.toolIdentityDigest, sceneIdentityDigest: base.sceneIdentityDigest,
    environmentFingerprint: base.environmentFingerprint, outcome: "blocked_before_start",
    settledAt: base.settledAt, cleanupConfirmed: false });
  assert.equal(!blockedEvidence.executionAttempted && !blockedEvidence.preEffectMarkerRecorded
    && !blockedEvidence.candidateForRouteQualification && !blockedEvidence.requiresReconciliation, true);
  const { measurements: _measurements, outputContentDigest: _output, cleanupReceiptDigest: _cleanup, ...attemptBase } = base;
  void _measurements; void _output; void _cleanup;
  const ambiguous = buildWayfarerUnrealBenchmarkEvidenceV1({ ...attemptBase, outcome: "ambiguous_after_start",
    cleanupConfirmed: false });
  assert.equal(ambiguous.executionAttempted && ambiguous.preEffectMarkerRecorded && ambiguous.requiresReconciliation
    && !ambiguous.candidateForRouteQualification, true);
  assert.throws(() => buildWayfarerUnrealBenchmarkEvidenceV1({ ...attemptBase, measurements: base.measurements,
    outputContentDigest: base.outputContentDigest, outcome: "measured_pass", cleanupConfirmed: false }), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-080 exact packet and readiness boundaries reject drift, aliases, chronology, accessors, and Proxies", () => {
  const packet = buildWayfarerUnrealBenchmarkPacketV1();
  assert.throws(() => parseWayfarerUnrealBenchmarkPacketV1({ ...packet, packetId: "packet:alias" }), error("digest_mismatch"));
  const mismatched = prerequisites("met", d({ wrong: "packet" }));
  assert.throws(() => buildWayfarerUnrealBenchmarkReadinessV1({ assessmentId: "assessment:mismatch", ...scope,
    candidatePacketId: packet.packetId, candidatePacketDigest: packet.packetDigest, prerequisites: mismatched, assessedAt: checkedAt }),
  ProjectWorkspaceContractErrorV1);
  const future = prerequisites("met", packet.packetDigest, "2026-08-30T00:30:00.000Z");
  assert.throws(() => buildWayfarerUnrealBenchmarkReadinessV1({ assessmentId: "assessment:future", ...scope,
    candidatePacketId: packet.packetId, candidatePacketDigest: packet.packetDigest, prerequisites: future, assessedAt: checkedAt }),
  ProjectWorkspaceContractErrorV1);
  let calls = 0; const accessor = { ...packet };
  Object.defineProperty(accessor, "packetId", { enumerable: true, get() { calls += 1; return packet.packetId; } });
  assert.throws(() => parseWayfarerUnrealBenchmarkPacketV1(accessor), ProjectWorkspaceContractErrorV1); assert.equal(calls, 0);
  const proxied = observedProxy(packet, "transparent");
  assert.throws(() => parseWayfarerUnrealBenchmarkPacketV1(proxied.value), ProjectWorkspaceContractErrorV1);
  assert.equal(proxied.trapCount(), 0);
});

test("CR9B-WF-080 disabled disposition ledger is append-only, restart-safe, and exact replay is inert", async () => {
  const target = await location(); try { const value = blocked(); let store = new SqliteWayfarerUnrealReadinessStoreV1(target.path, scope,
    { integrityKey: key, mode: "create" });
    assert.equal(store.latest(), undefined); assert.equal(store.record(value).replayed, false);
    const before = store.verifyIntegrity(); assert.deepEqual(before, { revision: 2, recordCount: 2, stateDigest: before.stateDigest });
    assert.equal(store.record(value).replayed, true); assert.deepEqual(store.verifyIntegrity(), before); store.close();
    store = new SqliteWayfarerUnrealReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "open" });
    assert.deepEqual(store.latest(), value); assert.deepEqual(store.verifyIntegrity(), before); store.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9B-WF-080 ledger rejects chronology rollback, ID drift, foreign scope, and partial records", async () => {
  const target = await location(); try { const store = new SqliteWayfarerUnrealReadinessStoreV1(target.path, scope,
    { integrityKey: key, mode: "create" }), value = blocked(); store.record(value);
    assert.throws(() => store.record(blocked("assessment:wayfarer:unreal:old", "2026-08-29T23:00:00.000Z")), error("unsupported_action"));
    const drift = blocked(value.assessment.assessmentId, "2026-08-30T00:30:00.000Z");
    assert.throws(() => store.record(drift), error("replay_drift"));
    const foreign = blocked("assessment:wayfarer:unreal:foreign", "2026-08-30T00:30:00.000Z");
    assert.throws(() => store.record({ assessment: { ...foreign.assessment, tenantId: "tenant:foreign" },
      disposition: foreign.disposition }), ProjectWorkspaceContractErrorV1);
    assert.throws(() => store.record({ assessment: value.assessment }), ProjectWorkspaceContractErrorV1); store.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9B-WF-080 ledger detects row deletion, metadata drift, added schema behavior, and wrong keys", async () => {
  for (const attack of ["deletion", "metadata", "schema", "wrong_key"] as const) { const target = await location(attack); try {
    const store = new SqliteWayfarerUnrealReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    store.record(blocked()); store.close();
    if (attack === "wrong_key") { assert.throws(() => new SqliteWayfarerUnrealReadinessStoreV1(target.path, scope,
      { integrityKey: new Uint8Array(32).fill(92), mode: "open" }), error("integrity_failed")); continue; }
    const attacker = new DatabaseSync(target.path);
    if (attack === "deletion") attacker.exec("DELETE FROM wayfarer_unreal_readiness_records WHERE kind='disposition'");
    if (attack === "metadata") attacker.exec("UPDATE wayfarer_unreal_readiness_metadata SET revision=999");
    if (attack === "schema") attacker.exec("CREATE TRIGGER injected AFTER INSERT ON wayfarer_unreal_readiness_records BEGIN SELECT 1; END");
    attacker.close(); assert.throws(() => new SqliteWayfarerUnrealReadinessStoreV1(target.path, scope,
      { integrityKey: key, mode: "open" }), error("integrity_failed"));
  } finally { await rm(target.directory, { recursive: true, force: true }); } }
});

test("CR9B-WF-080 a later disabled assessment advances current truth without erasing history", async () => {
  const target = await location(); try { const store = new SqliteWayfarerUnrealReadinessStoreV1(target.path, scope,
    { integrityKey: key, mode: "create" }), first = blocked(), second = blocked("assessment:wayfarer:unreal:recheck",
      "2026-08-30T00:30:00.000Z"); store.record(first); store.record(second); assert.deepEqual(store.latest(), second);
    assert.equal(store.verifyIntegrity().recordCount, 4); store.close(); const db = new DatabaseSync(target.path, { readOnly: true });
    const count = Number((db.prepare("SELECT count(*) count FROM wayfarer_unreal_readiness_records").get() as { count: number }).count);
    db.close(); assert.equal(count, 4);
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});
