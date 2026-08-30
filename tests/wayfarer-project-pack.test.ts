import assert from "node:assert/strict";
import test from "node:test";
import { completionAcceptanceProfileSchemaV1 } from "../src/completion-gate/v1";
import { packageReviewSchemaV1, registryPackageSchemaV1 } from "../src/package-registry/v1";
import { WAYFARER_ADAPTER_ID_V1, WAYFARER_PROJECT_ID_V1, WAYFARER_STAGE_IDS_V1, WAYFARER_WORKSPACE_ID_V1,
  buildWayfarerProjectPackV1, buildWayfarerSyntheticProjectPackV1, parseWayfarerProjectPackV1,
} from "../src/project-adapters/wayfarer/v1";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

function rehash(value: ReturnType<typeof buildWayfarerSyntheticProjectPackV1>) {
  const { packDigest: _digest, ...material } = value; void _digest;
  return { ...material, packDigest: sha256Digest(material) };
}

test("CR9B-WF-000 freezes one six-stage Wayfarer project pack with no live authority", () => {
  const pack = buildWayfarerSyntheticProjectPackV1();
  assert.deepEqual({ project: pack.projectId, workspace: pack.workspaceId, adapter: pack.adapterId,
    stages: pack.stages.map((stage) => stage.stageId), synthetic: pack.syntheticOnly, unreal: pack.unrealEligible,
    benchmark: pack.requiresMeasuredUnrealBenchmark, native: pack.allowsNativeExecution, providers: pack.allowsProviderCalls,
    network: pack.allowsNetwork, storage: pack.allowsObjectStorage, upload: pack.allowsUpload, publication: pack.allowsPublication,
    approval: pack.grantsApproval, deletion: pack.grantsDeletionAuthority, execution: pack.grantsExecutionAuthority },
  { project: WAYFARER_PROJECT_ID_V1, workspace: WAYFARER_WORKSPACE_ID_V1, adapter: WAYFARER_ADAPTER_ID_V1,
    stages: WAYFARER_STAGE_IDS_V1, synthetic: true, unreal: false, benchmark: true, native: false, providers: false,
    network: false, storage: false, upload: false, publication: false, approval: false, deletion: false, execution: false });
  assert.deepEqual(parseWayfarerProjectPackV1(pack), pack);
});

test("CR9B-WF-000 media graph joins parallel render and audio before QC, review, assembly, and preparation", () => {
  const pack = buildWayfarerSyntheticProjectPackV1();
  assert.deepEqual(pack.edges, [
    { fromStageId: "model_render_segment", toStageId: "qc_media_probe" },
    { fromStageId: "audio_candidate", toStageId: "qc_media_probe" },
    { fromStageId: "model_render_segment", toStageId: "review_cut" },
    { fromStageId: "audio_candidate", toStageId: "review_cut" },
    { fromStageId: "qc_media_probe", toStageId: "review_cut" },
    { fromStageId: "review_cut", toStageId: "assemble_episode" },
    { fromStageId: "assemble_episode", toStageId: "prepare_publication" },
  ]);
  assert.deepEqual(pack.stages.find((stage) => stage.stageId === "review_cut")?.requiresAcceptedReviewOfStageIds, ["qc_media_probe"]);
  assert.deepEqual(pack.stages.find((stage) => stage.stageId === "assemble_episode")?.requiresAcceptedReviewOfStageIds, ["review_cut"]);
  assert.deepEqual(pack.stages.find((stage) => stage.stageId === "prepare_publication")?.requiresAcceptedReviewOfStageIds, ["assemble_episode"]);
  assert.equal(pack.stages.every((stage) => stage.syntheticImplementationAllowed && !stage.liveImplementationAllowed
    && !stage.createsEffectIntent && !stage.grantsExecutionAuthority), true);
});

test("CR9B-WF-000 artifact manifests are immutable digest-only declarations with bounded retention and quarantine", () => {
  const pack = buildWayfarerSyntheticProjectPackV1();
  assert.equal(pack.artifacts.length, 10);
  assert.equal(new Set(pack.artifacts.map((artifact) => artifact.role)).size, 10);
  for (const artifact of pack.artifacts) {
    assert.equal(artifact.immutable && artifact.digestRequired && !artifact.bytesEmbeddedInControlPlane
      && !artifact.locatorStoredInPack && !artifact.grantsAuthority, true);
    assert.ok(artifact.maximumBytes > 0);
    assert.ok(pack.retentionClasses.some((retention) => retention.retentionClassId === artifact.retentionClassId));
  }
  assert.equal(pack.retentionClasses.every((retention) => retention.deletionMode === "owner_reviewed_proposal_only"
    && retention.legalHoldWins && !retention.automaticDeletionEnabled && !retention.grantsDeletionAuthority), true);
  assert.equal(JSON.stringify(pack).includes("filesystemPath"), false);
  assert.equal(JSON.stringify(pack).includes("storageUrl"), false);
});

test("CR9B-WF-000 every stage binds a strict Completion Gate profile and every scenario has a QC rule", () => {
  const pack = buildWayfarerSyntheticProjectPackV1(), scenarios = new Set<string>();
  for (const [index, binding] of pack.acceptanceProfiles.entries()) {
    const profile = completionAcceptanceProfileSchemaV1.parse(binding.profile);
    assert.equal(sha256Digest(profile), binding.profileDigest);
    assert.equal(profile.id, pack.stages[index]?.completionProfileId);
    assert.equal(binding.profileDigest, pack.stages[index]?.completionProfileDigest);
    assert.equal(profile.reviewerSeparation.actor && profile.verificationRequiresProducerSeparation, true);
    profile.requiredVerificationScenarioIds.forEach((scenario) => scenarios.add(scenario));
  }
  assert.deepEqual([...scenarios].sort(), [...new Set(pack.qcRules.map((rule) => rule.scenarioId))].sort());
  assert.equal(pack.qcRules.every((rule) => rule.requiresIndependentEvidence && rule.failureDisposition === "block_completion_and_quarantine"
    && !rule.grantsApproval && !rule.grantsExecutionAuthority), true);
});

test("CR9B-WF-000 procedure and knowledge packages are independently reviewed configuration, not authority", () => {
  const pack = buildWayfarerSyntheticProjectPackV1();
  for (const [packageValue, packageDigest, reviewValue] of [[pack.procedure, pack.procedureDigest, pack.procedureReview],
    [pack.knowledge, pack.knowledgeDigest, pack.knowledgeReview]] as const) {
    const parsedPackage = registryPackageSchemaV1.parse(packageValue), review = packageReviewSchemaV1.parse(reviewValue);
    assert.equal(sha256Digest(parsedPackage), packageDigest); assert.equal(review.packageDigest, packageDigest);
    assert.notEqual(review.producerId, review.reviewerId);
    assert.deepEqual(parsedPackage.separation, { grantsAuthority: false, suppliesPolicy: false, containsCredentials: false });
  }
});

test("CR9B-WF-000 route declarations preserve benchmark, ambiguity, retry, and effect ceilings", () => {
  const pack = buildWayfarerSyntheticProjectPackV1(), render = pack.stages[0]!, publication = pack.stages[5]!;
  assert.deepEqual({ gpu: render.route.gpu, benchmark: render.route.requiresMeasuredBenchmark,
    evidence: render.route.benchmarkEvidenceDigest, unreal: pack.unrealEligible },
  { gpu: "required", benchmark: true, evidence: undefined, unreal: false });
  assert.deepEqual({ gpu: publication.route.gpu, network: publication.route.allowsNetwork, native: publication.route.allowsNativeExecution,
    provider: publication.route.allowsProviderCalls, cost: publication.route.maximumCostUsd },
  { gpu: "forbidden", network: false, native: false, provider: false, cost: 0 });
  assert.deepEqual({ preStart: pack.maximumPreStartRetries, postMarker: pack.automaticPostMarkerRetryAllowed,
    reconcile: pack.ambiguousOutcomeRequiresReconciliation }, { preStart: 1, postMarker: false, reconcile: true });
});

test("CR9B-WF-000 workspace keeps the shared shell and bounded media, QC, and retention views", () => {
  const workspace = buildWayfarerSyntheticProjectPackV1().workspace;
  assert.equal(workspace.authorityMode, "control_room_native");
  assert.deepEqual(workspace.sections.slice(-3).map((section) => section.sectionId), ["media-graph", "quality-control", "retention"]);
  assert.equal(workspace.sections.every((section) => section.presentationOnly && !section.grantsCommandAuthority
    && !section.grantsExecutionAuthority), true);
  assert.equal(workspace.sourceStatuses[0]?.mode, "synthetic"); assert.equal(workspace.sourceStatuses[0]?.grantsNetworkAuthority, false);
});

test("CR9B-WF-000 rejects graph, artifact, profile, scope, and outer digest drift even when rehashed", () => {
  const edgeDrift = buildWayfarerSyntheticProjectPackV1(); edgeDrift.edges = [...edgeDrift.edges].reverse();
  assert.throws(() => parseWayfarerProjectPackV1(rehash(edgeDrift)), ProjectWorkspaceContractErrorV1);
  const artifactDrift = buildWayfarerSyntheticProjectPackV1();
  artifactDrift.artifacts[2] = { ...artifactDrift.artifacts[2]!, retentionClassId: "retention:unknown" };
  assert.throws(() => parseWayfarerProjectPackV1(rehash(artifactDrift)), ProjectWorkspaceContractErrorV1);
  const profileDrift = buildWayfarerSyntheticProjectPackV1();
  profileDrift.stages[0] = { ...profileDrift.stages[0]!, completionProfileDigest: sha256Digest({ alias: true }) };
  assert.throws(() => parseWayfarerProjectPackV1(rehash(profileDrift)), ProjectWorkspaceContractErrorV1);
  const scopeDrift = buildWayfarerSyntheticProjectPackV1(); scopeDrift.workspace = { ...scopeDrift.workspace, tenantId: "tenant:other" };
  assert.throws(() => parseWayfarerProjectPackV1(rehash(scopeDrift)), ProjectWorkspaceContractErrorV1);
  const ordinary = buildWayfarerSyntheticProjectPackV1();
  assert.throws(() => parseWayfarerProjectPackV1({ ...ordinary, createdAt: "2026-08-29T18:01:00.000Z" }),
    (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "digest_mismatch");
});

test("CR9B-WF-000 rejects correlated review, reversed chronology, and secret-shaped evidence", () => {
  const base = { tenantId: "tenant:wayfarer", workspaceId: WAYFARER_WORKSPACE_ID_V1, projectId: WAYFARER_PROJECT_ID_V1,
    adapterId: WAYFARER_ADAPTER_ID_V1, producerId: "agent:producer", reviewerId: "agent:reviewer",
    sourceDigest: sha256Digest({ source: 1 }), reviewEvidenceDigest: sha256Digest({ review: 1 }),
    createdAt: "2026-08-29T18:00:00.000Z", reviewedAt: "2026-08-29T18:05:00.000Z" };
  assert.throws(() => buildWayfarerProjectPackV1({ ...base, reviewerId: base.producerId }), ProjectWorkspaceContractErrorV1);
  assert.throws(() => buildWayfarerProjectPackV1({ ...base, reviewedAt: "2026-08-29T17:59:00.000Z" }), ProjectWorkspaceContractErrorV1);
  const secret = buildWayfarerSyntheticProjectPackV1();
  secret.stages[0] = { ...secret.stages[0]!, label: "api_key=sk_test_12345678901234567890" };
  assert.throws(() => parseWayfarerProjectPackV1(rehash(secret)),
    (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "redaction_rejected");
});

test("CR9B-WF-000 rejects accessors and Proxies without executing behavior", () => {
  const value = buildWayfarerSyntheticProjectPackV1(); let calls = 0; const accessor = { ...value };
  Object.defineProperty(accessor, "packId", { enumerable: true, get() { calls += 1; return value.packId; } });
  assert.throws(() => parseWayfarerProjectPackV1(accessor), ProjectWorkspaceContractErrorV1); assert.equal(calls, 0);
  const proxied = observedProxy(value, "transparent");
  assert.throws(() => parseWayfarerProjectPackV1(proxied.value), ProjectWorkspaceContractErrorV1); assert.equal(proxied.trapCount(), 0);
  const input = observedProxy({ tenantId: "tenant:wayfarer", workspaceId: WAYFARER_WORKSPACE_ID_V1,
    projectId: WAYFARER_PROJECT_ID_V1, adapterId: WAYFARER_ADAPTER_ID_V1, producerId: "agent:producer",
    reviewerId: "agent:reviewer", sourceDigest: sha256Digest({ source: 1 }), reviewEvidenceDigest: sha256Digest({ review: 1 }),
    createdAt: "2026-08-29T18:00:00.000Z", reviewedAt: "2026-08-29T18:05:00.000Z" }, "transparent");
  assert.throws(() => buildWayfarerProjectPackV1(input.value), ProjectWorkspaceContractErrorV1); assert.equal(input.trapCount(), 0);
});
