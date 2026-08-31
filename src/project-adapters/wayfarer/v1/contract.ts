import { z } from "zod";
import {
  COMPLETION_GATE_SCHEMA_VERSION_V1,
  completionAcceptanceProfileSchemaV1,
  type CompletionAcceptanceProfileV1,
} from "../../../completion-gate/v1";
import {
  PACKAGE_REGISTRY_SCHEMA_VERSION_V1,
  packageReviewSchemaV1,
  registryPackageSchemaV1,
  type KnowledgePackageV1,
  type PackageReviewV1,
  type ProcedurePackageV1,
} from "../../../package-registry/v1";
import {
  buildProjectWorkspaceSnapshotV1,
  exactProjectWorkspaceJsonV1,
  parseProjectWorkspaceSnapshotV1,
  ProjectWorkspaceContractErrorV1,
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceLabelSchemaV1 as label,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../../project-workspace/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import {
  WAYFARER_ADAPTER_ID_V1,
  WAYFARER_PROJECT_ID_V1,
  WAYFARER_PROJECT_PACK_CONTRACT_V1,
  WAYFARER_STAGE_IDS_V1,
  WAYFARER_WORKSPACE_ID_V1,
  type WayfarerAcceptanceProfileBindingV1,
  type WayfarerArtifactDefinitionV1,
  type WayfarerArtifactRoleV1,
  type WayfarerGraphEdgeV1,
  type WayfarerProjectPackInputV1,
  type WayfarerProjectPackV1,
  type WayfarerQcRuleV1,
  type WayfarerRetentionClassV1,
  type WayfarerRouteCeilingV1,
  type WayfarerStageDefinitionV1,
  type WayfarerStageIdV1,
} from "./types";

const stageId = z.enum(WAYFARER_STAGE_IDS_V1);
const artifactRole = z.enum(["source_scene_manifest", "source_audio_brief", "render_segment", "audio_candidate", "qc_report",
  "review_proxy", "review_manifest", "episode_master", "assembly_manifest", "publication_package"]);
const platform = z.enum(["linux", "macos", "windows"]);
const contentType = z.string().min(3).max(100).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/);
const unique = <T extends z.ZodType<string>>(schema: T, minimum: number, maximum: number) => z.array(schema).min(minimum).max(maximum)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "values must be unique" });
  });

const inputSchema = z.object({ tenantId: id, workspaceId: z.literal(WAYFARER_WORKSPACE_ID_V1), projectId: z.literal(WAYFARER_PROJECT_ID_V1),
  adapterId: z.literal(WAYFARER_ADAPTER_ID_V1), producerId: id, reviewerId: id, sourceDigest: digest,
  reviewEvidenceDigest: digest, createdAt: time, reviewedAt: time }).strict().superRefine((value, context) => {
    if (value.producerId === value.reviewerId) context.addIssue({ code: "custom", message: "independent review required" });
    if (Date.parse(value.reviewedAt) < Date.parse(value.createdAt)) context.addIssue({ code: "custom", message: "review chronology invalid" });
  });
const routeSchema = z.object({ routeProfileId: id, allowedPlatforms: unique(platform, 1, 3), gpu: z.enum(["required", "optional", "forbidden"]),
  minimumMemoryBytes: z.number().int().min(0).max(1_099_511_627_776), minimumScratchBytes: z.number().int().min(0).max(17_592_186_044_416),
  requiresMeasuredBenchmark: z.boolean(), benchmarkEvidenceDigest: digest.optional(), maximumCostUsd: z.literal(0),
  allowsNativeExecution: z.literal(false), allowsProviderCalls: z.literal(false), allowsNetwork: z.literal(false),
  grantsExecutionAuthority: z.literal(false) }).strict().superRefine((value, context) => {
  if (!value.requiresMeasuredBenchmark && value.benchmarkEvidenceDigest) {
      context.addIssue({ code: "custom", message: "benchmark evidence state invalid" });
    }
  });
const stageSchema = z.object({ stageId, label, inputArtifactRoles: unique(artifactRole, 1, 10), outputArtifactRoles: unique(artifactRole, 1, 10),
  completionProfileId: id, completionProfileDigest: digest, requiresAcceptedReviewOfStageIds: z.array(stageId).max(6), route: routeSchema,
  syntheticImplementationAllowed: z.literal(true), liveImplementationAllowed: z.literal(false), createsEffectIntent: z.literal(false),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
const edgeSchema = z.object({ fromStageId: stageId, toStageId: stageId }).strict().refine((value) => value.fromStageId !== value.toStageId,
  { message: "self edge invalid" });
const artifactSchema = z.object({ role: artifactRole, origin: z.enum(["source_input", "generated"]), kind: z.enum(["media", "document", "manifest"]),
  allowedContentTypes: unique(contentType, 1, 8), maximumBytes: z.number().int().positive().max(34_359_738_368), retentionClassId: id,
  immutable: z.literal(true), digestRequired: z.literal(true), bytesEmbeddedInControlPlane: z.literal(false), locatorStoredInPack: z.literal(false),
  quarantineOnFailedVerification: z.boolean(), grantsAuthority: z.literal(false) }).strict();
const retentionSchema = z.object({ retentionClassId: id, retainForDays: z.number().int().min(1).max(36_500),
  clockStartsOn: z.enum(["artifact_created", "completion_accepted", "project_closed"]), deletionMode: z.literal("owner_reviewed_proposal_only"),
  quarantineForDays: z.number().int().min(1).max(365), legalHoldWins: z.literal(true), automaticDeletionEnabled: z.literal(false),
  grantsDeletionAuthority: z.literal(false) }).strict();
const qcSchema = z.object({ ruleId: id, scenarioId: id, appliesToArtifactRoles: unique(artifactRole, 1, 10), severity: z.enum(["medium", "high"]),
  failureDisposition: z.literal("block_completion_and_quarantine"), requiresIndependentEvidence: z.literal(true), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false) }).strict();
const profileBindingSchema = z.object({ profile: z.unknown(), profileDigest: digest }).strict();
const packSchema = z.object({ contractVersion: z.literal(WAYFARER_PROJECT_PACK_CONTRACT_V1), packId: id, tenantId: id,
  workspaceId: z.literal(WAYFARER_WORKSPACE_ID_V1), projectId: z.literal(WAYFARER_PROJECT_ID_V1), adapterId: z.literal(WAYFARER_ADAPTER_ID_V1),
  workspace: z.unknown(), workspaceDigest: digest, stages: z.array(stageSchema).length(6), edges: z.array(edgeSchema).length(7),
  artifacts: z.array(artifactSchema).length(10), retentionClasses: z.array(retentionSchema).length(5), qcRules: z.array(qcSchema).length(9),
  acceptanceProfiles: z.array(profileBindingSchema).length(6), procedure: z.unknown(), procedureDigest: digest, procedureReview: z.unknown(),
  knowledge: z.unknown(), knowledgeDigest: digest, knowledgeReview: z.unknown(), maximumPreStartRetries: z.literal(1),
  automaticPostMarkerRetryAllowed: z.literal(false), ambiguousOutcomeRequiresReconciliation: z.literal(true), syntheticOnly: z.literal(true),
  unrealEligible: z.literal(false), requiresMeasuredUnrealBenchmark: z.literal(true), credentialsReferenceDigests: z.tuple([]),
  allowsNativeExecution: z.literal(false), allowsProviderCalls: z.literal(false), allowsNetwork: z.literal(false),
  allowsObjectStorage: z.literal(false), allowsUpload: z.literal(false), allowsPublication: z.literal(false), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), createdAt: time, packDigest: digest }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(exactProjectWorkspaceJsonV1(value)); }
  catch (error) { if (error instanceof ProjectWorkspaceContractErrorV1) throw error; throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
}
function material(value: Record<string, unknown>, key: string): Record<string, unknown> { const copy = { ...value }; delete copy[key]; return copy; }
function route(routeProfileId: string, gpu: WayfarerRouteCeilingV1["gpu"], memoryGiB: number, scratchGiB: number,
  requiresMeasuredBenchmark = false): WayfarerRouteCeilingV1 {
  return { routeProfileId, allowedPlatforms: ["linux", "macos", "windows"], gpu, minimumMemoryBytes: memoryGiB * 1_073_741_824,
    minimumScratchBytes: scratchGiB * 1_073_741_824, requiresMeasuredBenchmark, maximumCostUsd: 0, allowsNativeExecution: false,
    allowsProviderCalls: false, allowsNetwork: false, grantsExecutionAuthority: false };
}
function profile(input: WayfarerProjectPackInputV1, stage: WayfarerStageIdV1, targetKind: "media" | "document",
  scenarios: string[], minimumRisk: "medium" | "high", reviews: number): WayfarerAcceptanceProfileBindingV1 {
  const value = completionAcceptanceProfileSchemaV1.parse({ schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
    id: `profile:wayfarer:${stage}`, tenantId: input.tenantId, projectId: input.projectId, name: `Wayfarer ${stage.replaceAll("_", " ")}`,
    targetKind, requiredVerificationScenarioIds: [...scenarios].sort(), minimumIndependentReviews: reviews,
    reviewerSeparation: { actor: true, worker: true, agentProfile: true, harness: true, modelFamily: false },
    verificationRequiresProducerSeparation: true, minimumRisk, maximumRevisionRounds: 2, automaticLowRiskDisposition: false,
    createdBy: { actorId: input.producerId, actorType: "agent" }, createdAt: input.createdAt }) as CompletionAcceptanceProfileV1;
  return { profile: value, profileDigest: sha256Digest(value) };
}

function buildProfiles(input: WayfarerProjectPackInputV1): WayfarerAcceptanceProfileBindingV1[] {
  return [
    profile(input, "model_render_segment", "media", ["wayfarer.verify.frame_continuity", "wayfarer.verify.render_decode"], "medium", 1),
    profile(input, "audio_candidate", "media", ["wayfarer.verify.audio_decode", "wayfarer.verify.loudness_bounds"], "medium", 1),
    profile(input, "qc_media_probe", "document", ["wayfarer.verify.av_sync", "wayfarer.verify.qc_report_integrity"], "medium", 1),
    profile(input, "review_cut", "media", ["wayfarer.verify.av_sync", "wayfarer.verify.review_proxy_integrity"], "high", 1),
    profile(input, "assemble_episode", "media", ["wayfarer.verify.assembly_manifest_integrity", "wayfarer.verify.av_sync"], "high", 2),
    profile(input, "prepare_publication", "document", ["wayfarer.verify.publication_package_integrity"], "high", 2),
  ];
}

function artifact(role: WayfarerArtifactRoleV1, origin: WayfarerArtifactDefinitionV1["origin"], kind: WayfarerArtifactDefinitionV1["kind"],
  types: string[], maximumBytes: number, retentionClassId: string, quarantine: boolean): WayfarerArtifactDefinitionV1 {
  return { role, origin, kind, allowedContentTypes: types, maximumBytes, retentionClassId, immutable: true, digestRequired: true,
    bytesEmbeddedInControlPlane: false, locatorStoredInPack: false, quarantineOnFailedVerification: quarantine, grantsAuthority: false };
}

function qc(ruleId: string, scenarioId: string, roles: WayfarerArtifactRoleV1[], severity: "medium" | "high"): WayfarerQcRuleV1 {
  return { ruleId, scenarioId, appliesToArtifactRoles: roles, severity, failureDisposition: "block_completion_and_quarantine",
    requiresIndependentEvidence: true, grantsApproval: false, grantsExecutionAuthority: false };
}

function packages(input: WayfarerProjectPackInputV1): { procedure: ProcedurePackageV1; procedureDigest: string; procedureReview: PackageReviewV1;
  knowledge: KnowledgePackageV1; knowledgeDigest: string; knowledgeReview: PackageReviewV1 } {
  const common = { schemaVersion: PACKAGE_REGISTRY_SCHEMA_VERSION_V1, tenantId: input.tenantId, projectId: input.projectId, version: "1.0.0",
    provenance: { sourceType: "repository" as const, sourceId: "source:wayfarer-project-pack-v1", sourceDigest: input.sourceDigest,
      producerId: input.producerId, producedAt: input.createdAt }, compatibility: [{ adapterId: "adapter:wayfarer:procedure:v1",
      adapterVersion: "1.0.0", harness: "other" as const, harnessVersion: "1.0.0", requiredVerbs: ["discover", "start", "stream", "cancel", "resume", "usage"] as const,
      supportedPlatforms: ["linux", "macos", "windows"] as const }], separation: { grantsAuthority: false as const, suppliesPolicy: false as const,
      containsCredentials: false as const }, createdAt: input.createdAt };
  const procedure = registryPackageSchemaV1.parse({ ...common, id: "package:wayfarer:procedure:1", kind: "procedure", name: "Wayfarer synthetic media workflow",
    content: { objective: "Produce digest-bound synthetic media evidence through render, audio, QC, review, assembly, and publication preparation without native tools, providers, storage services, upload, or publication.",
      steps: WAYFARER_STAGE_IDS_V1.map((stage, index) => ({ id: `step:${stage}`, instruction: `${index + 1}. Process only the exact declared artifact roles for ${stage}; stop when evidence, review, route, or scope is missing and never infer authority from a completed artifact.` })),
      acceptanceSteps: [{ id: "accept:graph", check: "Every artifact follows the frozen acyclic graph and carries an immutable digest." },
        { id: "accept:qc", check: "Every required QC scenario passes with producer-separated evidence before completion." },
        { id: "accept:review", check: "Review and assembly use the named Completion Gate profiles and do not grant effect approval." },
        { id: "accept:retention", check: "Retention and quarantine produce owner-reviewed proposals only and never delete automatically." },
        { id: "accept:effects", check: "No native tool, provider, network, object storage, upload, or publication is invoked." }],
      inputRoles: ["digest bound source manifests", "synthetic artifact envelopes"], outputRoles: ["synthetic media workflow evidence", "completion gate targets"] } }) as ProcedurePackageV1;
  const procedureDigest = sha256Digest(procedure);
  const knowledge = registryPackageSchemaV1.parse({ ...common, id: "package:wayfarer:knowledge:1", kind: "knowledge", name: "Wayfarer media authority boundaries",
    content: { facts: [
      { id: "fact:wayfarer:graph", subject: "Wayfarer workflow", predicate: "uses", value: "one frozen six stage acyclic media graph", evidenceDigest: input.reviewEvidenceDigest },
      { id: "fact:wayfarer:unreal", subject: "Unreal execution", predicate: "requires", value: "a separately measured owner controlled benchmark before eligibility", evidenceDigest: input.reviewEvidenceDigest },
      { id: "fact:wayfarer:storage", subject: "artifact pack", predicate: "contains", value: "digests and logical classes but no bytes paths credentials or storage authority", evidenceDigest: input.reviewEvidenceDigest },
      { id: "fact:wayfarer:publish", subject: "publication preparation", predicate: "does not", value: "upload publish or authorize a destination effect", evidenceDigest: input.reviewEvidenceDigest },
      { id: "fact:wayfarer:ambiguity", subject: "post marker uncertainty", predicate: "requires", value: "terminal ambiguity and authoritative reconciliation without automatic retry", evidenceDigest: input.reviewEvidenceDigest }],
      references: [{ id: "reference:wayfarer:contract", kind: "repository", locatorDigest: sha256Digest({ document: "CR9B_WAYFARER_PROJECT_PACK_CONTRACT.md" }),
        contentDigest: input.sourceDigest }] } }) as KnowledgePackageV1;
  const knowledgeDigest = sha256Digest(knowledge);
  const review = (kind: "procedure" | "knowledge", packageId: string, packageDigest: string) => packageReviewSchemaV1.parse({
    schemaVersion: PACKAGE_REGISTRY_SCHEMA_VERSION_V1, id: `review:wayfarer:${kind}:1`, tenantId: input.tenantId, projectId: input.projectId,
    packageId, packageDigest, producerId: input.producerId, reviewerId: input.reviewerId, decision: "accepted",
    reasonCode: "media_graph_and_authority_boundaries_verified", evidenceDigests: [input.reviewEvidenceDigest, input.sourceDigest].sort(),
    reviewedAt: input.reviewedAt }) as PackageReviewV1;
  return { procedure, procedureDigest, procedureReview: review("procedure", procedure.id, procedureDigest), knowledge, knowledgeDigest,
    knowledgeReview: review("knowledge", knowledge.id, knowledgeDigest) };
}

export function buildWayfarerProjectPackV1(inputValue: unknown): WayfarerProjectPackV1 {
  const input = parse(inputSchema, inputValue) as WayfarerProjectPackInputV1;
  const acceptanceProfiles = buildProfiles(input), profileByStage = new Map(acceptanceProfiles.map((item, index) => [WAYFARER_STAGE_IDS_V1[index]!, item]));
  const stage = (stageIdValue: WayfarerStageIdV1, stageLabel: string, inputs: WayfarerArtifactRoleV1[], outputs: WayfarerArtifactRoleV1[],
    accepted: WayfarerStageIdV1[], stageRoute: WayfarerRouteCeilingV1): WayfarerStageDefinitionV1 => {
    const bound = profileByStage.get(stageIdValue)!;
    return { stageId: stageIdValue, label: stageLabel, inputArtifactRoles: inputs, outputArtifactRoles: outputs,
      completionProfileId: bound.profile.id, completionProfileDigest: bound.profileDigest, requiresAcceptedReviewOfStageIds: accepted,
      route: stageRoute, syntheticImplementationAllowed: true, liveImplementationAllowed: false, createsEffectIntent: false,
      grantsApproval: false, grantsExecutionAuthority: false };
  };
  const stages = [
    stage("model_render_segment", "Model render segment", ["source_scene_manifest"], ["render_segment"], [], route("route:wayfarer:model-render", "required", 16, 64, true)),
    stage("audio_candidate", "Audio candidate", ["source_audio_brief"], ["audio_candidate"], [], route("route:wayfarer:audio", "optional", 8, 16)),
    stage("qc_media_probe", "QC media probe", ["render_segment", "audio_candidate"], ["qc_report"], [], route("route:wayfarer:qc", "forbidden", 4, 8)),
    stage("review_cut", "Review cut", ["render_segment", "audio_candidate", "qc_report"], ["review_proxy", "review_manifest"], ["qc_media_probe"], route("route:wayfarer:review", "forbidden", 4, 8)),
    stage("assemble_episode", "Assemble episode", ["review_proxy", "review_manifest"], ["episode_master", "assembly_manifest"], ["review_cut"], route("route:wayfarer:assembly", "optional", 16, 128)),
    stage("prepare_publication", "Prepare publication", ["episode_master", "assembly_manifest"], ["publication_package"], ["assemble_episode"], route("route:wayfarer:publication-preparation", "forbidden", 4, 8)),
  ];
  const edges: WayfarerGraphEdgeV1[] = [{ fromStageId: "model_render_segment", toStageId: "qc_media_probe" },
    { fromStageId: "audio_candidate", toStageId: "qc_media_probe" }, { fromStageId: "model_render_segment", toStageId: "review_cut" },
    { fromStageId: "audio_candidate", toStageId: "review_cut" }, { fromStageId: "qc_media_probe", toStageId: "review_cut" },
    { fromStageId: "review_cut", toStageId: "assemble_episode" }, { fromStageId: "assemble_episode", toStageId: "prepare_publication" }];
  const gib = 1_073_741_824, mib = 1_048_576;
  const artifacts = [artifact("source_scene_manifest", "source_input", "manifest", ["application/json"], mib, "retention:wayfarer:source", false),
    artifact("source_audio_brief", "source_input", "document", ["application/json"], mib, "retention:wayfarer:source", false),
    artifact("render_segment", "generated", "media", ["video/mp4", "video/quicktime"], 4 * gib, "retention:wayfarer:intermediate", true),
    artifact("audio_candidate", "generated", "media", ["audio/flac", "audio/wav"], gib, "retention:wayfarer:intermediate", true),
    artifact("qc_report", "generated", "document", ["application/json"], 16 * mib, "retention:wayfarer:evidence", true),
    artifact("review_proxy", "generated", "media", ["video/mp4"], gib, "retention:wayfarer:review", true),
    artifact("review_manifest", "generated", "manifest", ["application/json"], 16 * mib, "retention:wayfarer:review", true),
    artifact("episode_master", "generated", "media", ["video/mp4", "video/quicktime"], 16 * gib, "retention:wayfarer:master", true),
    artifact("assembly_manifest", "generated", "manifest", ["application/json"], 16 * mib, "retention:wayfarer:evidence", true),
    artifact("publication_package", "generated", "manifest", ["application/json"], 16 * mib, "retention:wayfarer:master", true)];
  const retention = (retentionClassId: string, days: number, start: WayfarerRetentionClassV1["clockStartsOn"], quarantineForDays: number): WayfarerRetentionClassV1 =>
    ({ retentionClassId, retainForDays: days, clockStartsOn: start, deletionMode: "owner_reviewed_proposal_only", quarantineForDays,
      legalHoldWins: true, automaticDeletionEnabled: false, grantsDeletionAuthority: false });
  const retentionClasses = [retention("retention:wayfarer:source", 3650, "project_closed", 90),
    retention("retention:wayfarer:intermediate", 30, "completion_accepted", 30), retention("retention:wayfarer:evidence", 2555, "artifact_created", 90),
    retention("retention:wayfarer:review", 180, "completion_accepted", 90), retention("retention:wayfarer:master", 3650, "project_closed", 180)];
  const qcRules = [qc("qc:wayfarer:render-decode", "wayfarer.verify.render_decode", ["render_segment"], "medium"),
    qc("qc:wayfarer:frame-continuity", "wayfarer.verify.frame_continuity", ["render_segment"], "medium"),
    qc("qc:wayfarer:audio-decode", "wayfarer.verify.audio_decode", ["audio_candidate"], "medium"),
    qc("qc:wayfarer:loudness", "wayfarer.verify.loudness_bounds", ["audio_candidate"], "medium"),
    qc("qc:wayfarer:av-sync", "wayfarer.verify.av_sync", ["render_segment", "audio_candidate", "review_proxy", "episode_master"], "high"),
    qc("qc:wayfarer:report-integrity", "wayfarer.verify.qc_report_integrity", ["qc_report"], "medium"),
    qc("qc:wayfarer:review-proxy", "wayfarer.verify.review_proxy_integrity", ["review_proxy", "review_manifest"], "high"),
    qc("qc:wayfarer:assembly", "wayfarer.verify.assembly_manifest_integrity", ["episode_master", "assembly_manifest"], "high"),
    qc("qc:wayfarer:publication-package", "wayfarer.verify.publication_package_integrity", ["publication_package"], "high")];
  const workspace = buildProjectWorkspaceSnapshotV1({ snapshotId: "snapshot:wayfarer:pack:1", tenantId: input.tenantId,
    workspaceId: input.workspaceId, projectId: input.projectId, adapterId: input.adapterId, projectType: "media_production",
    title: "Lo-Fi Wayfarer", summary: "Synthetic-first media production with explicit QC, review, assembly, retention, and publication preparation boundaries.",
    authorityMode: "control_room_native", generatedAt: input.createdAt, extensionSections: [
      { sectionId: "media-graph", extensionKind: "wayfarer_media_graph", label: "Media graph", itemCount: 6 },
      { sectionId: "quality-control", extensionKind: "wayfarer_qc", label: "Quality control", itemCount: 9 },
      { sectionId: "retention", extensionKind: "wayfarer_retention", label: "Retention", itemCount: 5 }],
    sourceStatuses: [{ sourceId: "source:wayfarer:synthetic-media", sourceKind: "synthetic_media", label: "Synthetic media fixtures",
      mode: "synthetic", state: "available", safeStatusCode: "synthetic_contract_ready", checkedAt: input.createdAt, itemCount: 0,
      grantsNetworkAuthority: false }], activeItemCount: 0, waitingReviewCount: 0, failedItemCount: 0 });
  const packageRecords = packages(input);
  const unsigned: Omit<WayfarerProjectPackV1, "packDigest"> = { contractVersion: WAYFARER_PROJECT_PACK_CONTRACT_V1,
    packId: "project-pack:lofi-wayfarer:1", tenantId: input.tenantId, workspaceId: input.workspaceId, projectId: input.projectId,
    adapterId: input.adapterId, workspace, workspaceDigest: workspace.snapshotDigest, stages, edges, artifacts, retentionClasses, qcRules,
    acceptanceProfiles, ...packageRecords, maximumPreStartRetries: 1, automaticPostMarkerRetryAllowed: false,
    ambiguousOutcomeRequiresReconciliation: true, syntheticOnly: true, unrealEligible: false, requiresMeasuredUnrealBenchmark: true,
    credentialsReferenceDigests: [], allowsNativeExecution: false, allowsProviderCalls: false, allowsNetwork: false, allowsObjectStorage: false,
    allowsUpload: false, allowsPublication: false, grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false,
    createdAt: input.createdAt };
  return parseWayfarerProjectPackV1({ ...unsigned, packDigest: sha256Digest(unsigned) });
}

function validateGraph(stages: WayfarerStageDefinitionV1[], edges: WayfarerGraphEdgeV1[]): void {
  if (stages.map((stage) => stage.stageId).join("|") !== WAYFARER_STAGE_IDS_V1.join("|")) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const expectedEdges = ["model_render_segment>qc_media_probe", "audio_candidate>qc_media_probe", "model_render_segment>review_cut",
    "audio_candidate>review_cut", "qc_media_probe>review_cut", "review_cut>assemble_episode", "assemble_episode>prepare_publication"];
  if (edges.map((edge) => `${edge.fromStageId}>${edge.toStageId}`).join("|") !== expectedEdges.join("|")) {
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
  const order = new Map(WAYFARER_STAGE_IDS_V1.map((value, index) => [value, index]));
  if (edges.some((edge) => order.get(edge.fromStageId)! >= order.get(edge.toStageId)!)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
}

export function parseWayfarerProjectPackV1(value: unknown): WayfarerProjectPackV1 {
  const pack = parse(packSchema, value) as WayfarerProjectPackV1;
  try { assertNoSecretMaterial(pack, "Wayfarer project pack"); } catch { throw new ProjectWorkspaceContractErrorV1("redaction_rejected"); }
  const workspace = parseProjectWorkspaceSnapshotV1(pack.workspace);
  if (workspace.tenantId !== pack.tenantId || workspace.workspaceId !== pack.workspaceId || workspace.projectId !== pack.projectId
    || workspace.adapterId !== pack.adapterId || workspace.snapshotDigest !== pack.workspaceDigest) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  const profiles = pack.acceptanceProfiles.map((binding) => {
    let profileValue: CompletionAcceptanceProfileV1;
    try { profileValue = completionAcceptanceProfileSchemaV1.parse(binding.profile) as CompletionAcceptanceProfileV1; }
    catch { throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
    if (sha256Digest(profileValue) !== binding.profileDigest || profileValue.tenantId !== pack.tenantId || profileValue.projectId !== pack.projectId) {
      throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
    }
    return profileValue;
  });
  validateGraph(pack.stages, pack.edges);
  const profileMap = new Map(profiles.map((profileValue, index) => [WAYFARER_STAGE_IDS_V1[index]!, profileValue]));
  for (const stage of pack.stages) {
    const profileValue = profileMap.get(stage.stageId);
    if (!profileValue || stage.completionProfileId !== profileValue.id || stage.completionProfileDigest !== sha256Digest(profileValue)) {
      throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
    }
  }
  const artifacts = new Map(pack.artifacts.map((item) => [item.role, item]));
  if (artifacts.size !== pack.artifacts.length || new Set(pack.retentionClasses.map((item) => item.retentionClassId)).size !== pack.retentionClasses.length
    || pack.artifacts.some((item) => !pack.retentionClasses.some((retentionClass) => retentionClass.retentionClassId === item.retentionClassId))) {
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
  const produced = new Map<WayfarerArtifactRoleV1, WayfarerStageIdV1>();
  for (const stage of pack.stages) for (const role of stage.outputArtifactRoles) {
    if (produced.has(role) || artifacts.get(role)?.origin !== "generated") throw new ProjectWorkspaceContractErrorV1("invalid_input");
    produced.set(role, stage.stageId);
  }
  for (const stage of pack.stages) for (const role of stage.inputArtifactRoles) {
    const artifactValue = artifacts.get(role), producer = produced.get(role);
    if (!artifactValue || (artifactValue.origin === "generated" && (!producer || WAYFARER_STAGE_IDS_V1.indexOf(producer) >= WAYFARER_STAGE_IDS_V1.indexOf(stage.stageId)))) {
      throw new ProjectWorkspaceContractErrorV1("invalid_input");
    }
  }
  const scenarioIds = new Set(profiles.flatMap((profileValue) => profileValue.requiredVerificationScenarioIds));
  if (new Set(pack.qcRules.map((rule) => rule.ruleId)).size !== pack.qcRules.length
    || pack.qcRules.some((rule) => !scenarioIds.has(rule.scenarioId) || rule.appliesToArtifactRoles.some((role) => !artifacts.has(role)))) {
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
  let procedure: ProcedurePackageV1, knowledge: KnowledgePackageV1, procedureReview: PackageReviewV1, knowledgeReview: PackageReviewV1;
  try { procedure = registryPackageSchemaV1.parse(pack.procedure) as ProcedurePackageV1;
    knowledge = registryPackageSchemaV1.parse(pack.knowledge) as KnowledgePackageV1;
    procedureReview = packageReviewSchemaV1.parse(pack.procedureReview) as PackageReviewV1;
    knowledgeReview = packageReviewSchemaV1.parse(pack.knowledgeReview) as PackageReviewV1; }
  catch { throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
  if (procedure.kind !== "procedure" || knowledge.kind !== "knowledge" || sha256Digest(procedure) !== pack.procedureDigest
    || sha256Digest(knowledge) !== pack.knowledgeDigest || procedureReview.packageDigest !== pack.procedureDigest
    || knowledgeReview.packageDigest !== pack.knowledgeDigest || procedureReview.reviewerId === procedureReview.producerId
    || knowledgeReview.reviewerId === knowledgeReview.producerId || procedure.tenantId !== pack.tenantId || knowledge.tenantId !== pack.tenantId
    || procedure.projectId !== pack.projectId || knowledge.projectId !== pack.projectId) throw new ProjectWorkspaceContractErrorV1("replay_drift");
  if (sha256Digest(material(pack as unknown as Record<string, unknown>, "packDigest")) !== pack.packDigest) {
    throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  }
  return { ...pack, workspace, acceptanceProfiles: pack.acceptanceProfiles.map((binding, index) => ({ ...binding, profile: profiles[index]! })),
    procedure, knowledge, procedureReview, knowledgeReview };
}

export const wayfarerProjectPackSchemasV1 = { route: routeSchema, stage: stageSchema, edge: edgeSchema, artifact: artifactSchema,
  retention: retentionSchema, qc: qcSchema, pack: packSchema } as const;
