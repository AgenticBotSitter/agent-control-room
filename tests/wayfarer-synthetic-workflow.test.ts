import assert from "node:assert/strict";
import test from "node:test";
import { WAYFARER_STAGE_IDS_V1, WayfarerSyntheticStageExecutorV1, buildWayfarerSyntheticPrerequisiteEvidenceV1,
  buildWayfarerSyntheticProjectPackV1, buildWayfarerSyntheticSourceArtifactsV1, compileWayfarerSyntheticWorkflowV1,
  parseWayfarerSyntheticArtifactV1, parseWayfarerSyntheticStageReceiptV1, parseWayfarerSyntheticWorkflowPlanV1,
  type WayfarerArtifactRoleV1, type WayfarerSyntheticArtifactV1, type WayfarerSyntheticPrerequisiteEvidenceV1,
  type WayfarerSyntheticStageReceiptV1,
} from "../src/project-adapters/wayfarer/v1";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const createdAt = "2026-08-29T19:00:00.000Z";
function setup() {
  const pack = buildWayfarerSyntheticProjectPackV1(), episodeId = "episode:wayfarer:synthetic:1",
    sources = buildWayfarerSyntheticSourceArtifactsV1({ pack, episodeId, createdAt }),
    plan = compileWayfarerSyntheticWorkflowV1({ pack, planId: "plan:wayfarer:synthetic:1", episodeId, sourceArtifacts: sources,
      compiledAt: "2026-08-29T19:01:00.000Z" });
  return { pack, episodeId, sources, plan, executor: new WayfarerSyntheticStageExecutorV1(pack) };
}
function rehash<T extends Record<string, unknown>>(value: T, field: string) {
  const material = { ...value }; delete material[field]; return { ...material, [field]: sha256Digest(material) };
}

test("CR9B-WF-010 compiles two no-byte source fixtures into six proposals without creating jobs, leases, or dispatch", () => {
  const { sources, plan } = setup();
  assert.deepEqual(sources.map((artifact) => artifact.role), ["source_scene_manifest", "source_audio_brief"]);
  assert.equal(sources.every((artifact) => artifact.observedByteCount === 0 && !artifact.mediaMaterialPresent
    && artifact.synthetic && !artifact.externalEffectOccurred && !artifact.grantsAuthority), true);
  assert.deepEqual(plan.stages.map((stage) => stage.stageId), WAYFARER_STAGE_IDS_V1);
  assert.deepEqual({ jobs: plan.createsCanonicalJobs, leases: plan.createsLeases, dispatch: plan.dispatchesWork,
    approval: plan.grantsApproval, execution: plan.grantsExecutionAuthority },
  { jobs: false, leases: false, dispatch: false, approval: false, execution: false });
  assert.equal(plan.stages.every((stage) => !stage.createsCanonicalJob && !stage.canDispatch && !stage.canExecute), true);
  assert.deepEqual(parseWayfarerSyntheticWorkflowPlanV1(plan), plan);
});

test("CR9B-WF-020/030 runs the complete synthetic media graph with exact lineage and non-authoritative QC", () => {
  const { plan, sources, executor } = setup(), artifacts = new Map<WayfarerArtifactRoleV1, WayfarerSyntheticArtifactV1>(
    sources.map((artifact) => [artifact.role, artifact])), receipts: WayfarerSyntheticStageReceiptV1[] = [],
    evidence = new Map<string, WayfarerSyntheticPrerequisiteEvidenceV1>();
  for (const [index, stage] of plan.stages.entries()) {
    const inputArtifacts = stage.requiredInputRoles.map((artifactRole) => artifacts.get(artifactRole)!);
    const prerequisiteEvidence = stage.requiresAcceptedReviewOfStageIds.map((requiredStage) => evidence.get(requiredStage)!);
    const receipt = executor.execute({ plan, stageId: stage.stageId, inputArtifacts, prerequisiteEvidence,
      executedAt: new Date(Date.parse(createdAt) + (index + 2) * 60_000).toISOString() });
    receipts.push(receipt);
    receipt.outputArtifacts.forEach((artifact) => artifacts.set(artifact.role, artifact));
    evidence.set(stage.stageId, buildWayfarerSyntheticPrerequisiteEvidenceV1({ receipt,
      recordedAt: new Date(Date.parse(createdAt) + (index + 2) * 60_000 + 1_000).toISOString() }));
  }
  assert.equal(receipts.length, 6); assert.equal(artifacts.size, 10);
  assert.deepEqual(receipts.map((receipt) => receipt.stageId), WAYFARER_STAGE_IDS_V1);
  assert.equal(receipts.every((receipt) => receipt.synthetic && !receipt.mediaToolInvoked && !receipt.providerInvoked
    && !receipt.networkUsed && !receipt.objectStorageUsed && !receipt.bytesMaterialized && !receipt.createsCompletionRecord
    && receipt.completionCandidateOnly && !receipt.externalEffectOccurred && !receipt.grantsApproval && !receipt.grantsExecutionAuthority), true);
  assert.equal(receipts.flatMap((receipt) => receipt.qcResults).every((result) => result.outcome === "synthetic_pass"
    && !result.qualifiesCompletion && result.independentEvidenceRequiredForCompletion && !result.grantsApproval), true);
  assert.equal(artifacts.get("publication_package")?.producedByStageId, "prepare_publication");
  assert.equal(artifacts.get("publication_package")?.mediaMaterialPresent, false);
});

test("CR9B-WF-020 refuses review, assembly, and publication preparation without exact prerequisite evidence", () => {
  const { plan, sources, executor } = setup(), render = executor.execute({ plan, stageId: "model_render_segment",
    inputArtifacts: [sources[0]], prerequisiteEvidence: [], executedAt: "2026-08-29T19:02:00.000Z" }),
    audio = executor.execute({ plan, stageId: "audio_candidate", inputArtifacts: [sources[1]], prerequisiteEvidence: [],
      executedAt: "2026-08-29T19:02:00.000Z" }),
    qc = executor.execute({ plan, stageId: "qc_media_probe", inputArtifacts: [render.outputArtifacts[0], audio.outputArtifacts[0]],
      prerequisiteEvidence: [], executedAt: "2026-08-29T19:03:00.000Z" });
  assert.throws(() => executor.execute({ plan, stageId: "review_cut",
    inputArtifacts: [render.outputArtifacts[0], audio.outputArtifacts[0], qc.outputArtifacts[0]], prerequisiteEvidence: [],
    executedAt: "2026-08-29T19:04:00.000Z" }), ProjectWorkspaceContractErrorV1);
  const wrongEvidence = buildWayfarerSyntheticPrerequisiteEvidenceV1({ receipt: render, recordedAt: "2026-08-29T19:03:01.000Z" });
  assert.throws(() => executor.execute({ plan, stageId: "review_cut",
    inputArtifacts: [render.outputArtifacts[0], audio.outputArtifacts[0], qc.outputArtifacts[0]], prerequisiteEvidence: [wrongEvidence],
    executedAt: "2026-08-29T19:04:00.000Z" }), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-020 rejects reordered inputs, wrong producer lineage, content-type drift, and cross-plan evidence", () => {
  const { plan, sources, executor } = setup(), render = executor.execute({ plan, stageId: "model_render_segment",
    inputArtifacts: [sources[0]], prerequisiteEvidence: [], executedAt: "2026-08-29T19:02:00.000Z" }),
    audio = executor.execute({ plan, stageId: "audio_candidate", inputArtifacts: [sources[1]], prerequisiteEvidence: [],
      executedAt: "2026-08-29T19:02:00.000Z" });
  assert.throws(() => executor.execute({ plan, stageId: "qc_media_probe",
    inputArtifacts: [audio.outputArtifacts[0], render.outputArtifacts[0]], prerequisiteEvidence: [],
    executedAt: "2026-08-29T19:03:00.000Z" }), ProjectWorkspaceContractErrorV1);
  const artifact = render.outputArtifacts[0]!, forgedProducer = rehash({ ...artifact, producedByStageId: "audio_candidate" }, "artifactDigest");
  assert.throws(() => executor.execute({ plan, stageId: "qc_media_probe", inputArtifacts: [forgedProducer, audio.outputArtifacts[0]],
    prerequisiteEvidence: [], executedAt: "2026-08-29T19:03:00.000Z" }), ProjectWorkspaceContractErrorV1);
  const forgedType = rehash({ ...artifact, contentType: "application/json" }, "artifactDigest");
  assert.throws(() => executor.execute({ plan, stageId: "qc_media_probe", inputArtifacts: [forgedType, audio.outputArtifacts[0]],
    prerequisiteEvidence: [], executedAt: "2026-08-29T19:03:00.000Z" }), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-010/020 digest aliases and changed stage plans cannot enter execution", () => {
  const { plan, sources, executor } = setup();
  assert.throws(() => parseWayfarerSyntheticArtifactV1({ ...sources[0], episodeId: "episode:alias" }),
    (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "digest_mismatch");
  assert.throws(() => parseWayfarerSyntheticWorkflowPlanV1({ ...plan, episodeId: "episode:alias" }),
    (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "digest_mismatch");
  const changedStages = plan.stages.map((stage, index) => index === 0 ? { ...stage, stageDigest: sha256Digest({ stage: "alias" }) } : stage),
    changedPlan = rehash({ ...plan, stages: changedStages }, "planDigest");
  assert.throws(() => executor.execute({ plan: changedPlan, stageId: "model_render_segment", inputArtifacts: [sources[0]],
    prerequisiteEvidence: [], executedAt: "2026-08-29T19:02:00.000Z" }), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-010/020 exact boundaries reject accessors and Proxies without traps", () => {
  const { plan, sources, executor } = setup(); let calls = 0; const accessor = { ...plan };
  Object.defineProperty(accessor, "planId", { enumerable: true, get() { calls += 1; return plan.planId; } });
  assert.throws(() => parseWayfarerSyntheticWorkflowPlanV1(accessor), ProjectWorkspaceContractErrorV1); assert.equal(calls, 0);
  const proxied = observedProxy(plan, "transparent");
  assert.throws(() => parseWayfarerSyntheticWorkflowPlanV1(proxied.value), ProjectWorkspaceContractErrorV1); assert.equal(proxied.trapCount(), 0);
  const executeInput = observedProxy({ plan, stageId: "model_render_segment", inputArtifacts: [sources[0]], prerequisiteEvidence: [],
    executedAt: "2026-08-29T19:02:00.000Z" }, "transparent");
  assert.throws(() => executor.execute(executeInput.value), ProjectWorkspaceContractErrorV1); assert.equal(executeInput.trapCount(), 0);
});

test("CR9B-WF-020 receipt parsing rejects changed output and preserves exact replay identity", () => {
  const { plan, sources, executor } = setup(), receipt = executor.execute({ plan, stageId: "model_render_segment",
    inputArtifacts: [sources[0]], prerequisiteEvidence: [], executedAt: "2026-08-29T19:02:00.000Z" });
  assert.deepEqual(parseWayfarerSyntheticStageReceiptV1(receipt), receipt);
  assert.throws(() => parseWayfarerSyntheticStageReceiptV1({ ...receipt, mediaToolInvoked: true }), ProjectWorkspaceContractErrorV1);
});
