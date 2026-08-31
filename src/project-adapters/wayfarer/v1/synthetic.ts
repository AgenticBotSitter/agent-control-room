import { z } from "zod";
import { exactProjectWorkspaceJsonV1, ProjectWorkspaceContractErrorV1, projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { sha256Digest } from "../../../security";
import { parseWayfarerProjectPackV1 } from "./contract";
import { WAYFARER_STAGE_IDS_V1, WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1, type WayfarerArtifactRoleV1,
  type WayfarerProjectPackV1, type WayfarerSyntheticArtifactV1,
  type WayfarerSyntheticPrerequisiteEvidenceV1, type WayfarerSyntheticQcResultV1, type WayfarerSyntheticStagePlanV1,
  type WayfarerSyntheticStageReceiptV1, type WayfarerSyntheticWorkflowPlanV1 } from "./types";

const stageId = z.enum(WAYFARER_STAGE_IDS_V1);
const role = z.enum(["source_scene_manifest", "source_audio_brief", "render_segment", "audio_candidate", "qc_report", "review_proxy",
  "review_manifest", "episode_master", "assembly_manifest", "publication_package"]);
const artifactSchema = z.object({ contractVersion: z.literal(WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1), artifactId: id, tenantId: id,
  workspaceId: id, projectId: id, packDigest: digest, episodeId: id, role, contentType: z.string().min(3).max(100), contentDigest: digest,
  inputArtifactDigests: z.array(digest).max(10), producedByStageId: stageId.optional(), observedByteCount: z.literal(0),
  mediaMaterialPresent: z.literal(false), synthetic: z.literal(true), externalEffectOccurred: z.literal(false), grantsAuthority: z.literal(false),
  createdAt: time, artifactDigest: digest }).strict();
const stagePlanSchema = z.object({ stageId, stageDigest: digest, proposedJobId: id, prerequisiteStageIds: z.array(stageId).max(6),
  requiredInputRoles: z.array(role).min(1).max(10), expectedOutputRoles: z.array(role).min(1).max(10),
  requiresAcceptedReviewOfStageIds: z.array(stageId).max(6), createsCanonicalJob: z.literal(false), canDispatch: z.literal(false),
  canExecute: z.literal(false) }).strict();
const planSchema = z.object({ contractVersion: z.literal(WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1), planId: id, tenantId: id,
  workspaceId: id, projectId: id, packId: id, packDigest: digest, episodeId: id, sourceArtifactDigests: z.array(digest).length(2),
  stages: z.array(stagePlanSchema).length(6), compiledAt: time, syntheticOnly: z.literal(true), createsCanonicalJobs: z.literal(false),
  createsLeases: z.literal(false), dispatchesWork: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  planDigest: digest }).strict();
const qcResultSchema = z.object({ ruleId: id, scenarioId: id, outcome: z.literal("synthetic_pass"), evidenceDigest: digest,
  independentEvidenceRequiredForCompletion: z.literal(true), qualifiesCompletion: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false) }).strict();
const receiptSchema = z.object({ contractVersion: z.literal(WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1), receiptId: id, tenantId: id,
  workspaceId: id, projectId: id, packDigest: digest, planId: id, planDigest: digest, episodeId: id, stageId, stageDigest: digest,
  inputArtifactDigests: z.array(digest).min(1).max(10), outputArtifacts: z.array(artifactSchema).min(1).max(10),
  prerequisiteEvidenceDigests: z.array(digest).max(6), qcResults: z.array(qcResultSchema).min(1).max(20), executedAt: time,
  synthetic: z.literal(true), mediaToolInvoked: z.literal(false), providerInvoked: z.literal(false), networkUsed: z.literal(false),
  objectStorageUsed: z.literal(false), bytesMaterialized: z.literal(false), createsCompletionRecord: z.literal(false),
  completionCandidateOnly: z.literal(true), externalEffectOccurred: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), receiptDigest: digest }).strict();
const evidenceSchema = z.object({ contractVersion: z.literal(WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1), evidenceId: id, tenantId: id,
  projectId: id, packDigest: digest, planDigest: digest, stageId, stageReceiptDigest: digest, acceptedForSimulation: z.literal(true),
  authoritativeCompletionResolution: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  recordedAt: time, evidenceDigest: digest }).strict();
const compileInputSchema = z.object({ pack: z.unknown(), planId: id, episodeId: id, sourceArtifacts: z.array(z.unknown()).length(2),
  compiledAt: time }).strict();
const executeInputSchema = z.object({ plan: z.unknown(), stageId, inputArtifacts: z.array(z.unknown()).min(1).max(10),
  prerequisiteEvidence: z.array(z.unknown()).max(6), executedAt: time }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T { try { return schema.parse(exactProjectWorkspaceJsonV1(value)); }
  catch (error) { if (error instanceof ProjectWorkspaceContractErrorV1) throw error; throw new ProjectWorkspaceContractErrorV1("invalid_input"); } }
function exactDigest(value: Record<string, unknown>, key: string, actual: string) { const copy = { ...value }; delete copy[key];
  if (sha256Digest(copy) !== actual) throw new ProjectWorkspaceContractErrorV1("digest_mismatch"); }

export function buildWayfarerSyntheticSourceArtifactsV1(inputValue: unknown): WayfarerSyntheticArtifactV1[] {
  const input = parse(z.object({ pack: z.unknown(), episodeId: id, createdAt: time }).strict(), inputValue),
    pack = parseWayfarerProjectPackV1(input.pack);
  return (["source_scene_manifest", "source_audio_brief"] as const).map((artifactRole) => {
    const definition = pack.artifacts.find((item) => item.role === artifactRole)!;
    const material: Omit<WayfarerSyntheticArtifactV1, "artifactDigest"> = { contractVersion: WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1,
      artifactId: `artifact:wayfarer:${input.episodeId}:${artifactRole}`, tenantId: pack.tenantId, workspaceId: pack.workspaceId,
      projectId: pack.projectId, packDigest: pack.packDigest, episodeId: input.episodeId, role: artifactRole,
      contentType: definition.allowedContentTypes[0]!, contentDigest: sha256Digest({ syntheticSource: artifactRole, episodeId: input.episodeId }),
      inputArtifactDigests: [], observedByteCount: 0, mediaMaterialPresent: false, synthetic: true, externalEffectOccurred: false,
      grantsAuthority: false, createdAt: input.createdAt };
    return parseWayfarerSyntheticArtifactV1({ ...material, artifactDigest: sha256Digest(material) });
  });
}

export function parseWayfarerSyntheticArtifactV1(value: unknown): WayfarerSyntheticArtifactV1 { const parsed = parse(artifactSchema, value) as WayfarerSyntheticArtifactV1;
  if (new Set(parsed.inputArtifactDigests).size !== parsed.inputArtifactDigests.length) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  exactDigest(parsed as unknown as Record<string, unknown>, "artifactDigest", parsed.artifactDigest); return parsed; }

export function compileWayfarerSyntheticWorkflowV1(inputValue: unknown): WayfarerSyntheticWorkflowPlanV1 {
  const input = parse(compileInputSchema, inputValue), pack = parseWayfarerProjectPackV1(input.pack),
    sources = input.sourceArtifacts.map(parseWayfarerSyntheticArtifactV1);
  if (sources.map((item) => item.role).join("|") !== "source_scene_manifest|source_audio_brief"
    || sources.some((item) => item.tenantId !== pack.tenantId || item.workspaceId !== pack.workspaceId || item.projectId !== pack.projectId
      || item.packDigest !== pack.packDigest || item.episodeId !== input.episodeId || item.producedByStageId
      || !pack.artifacts.find((definition) => definition.role === item.role)?.allowedContentTypes.includes(item.contentType))) {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  const stages: WayfarerSyntheticStagePlanV1[] = pack.stages.map((stage) => ({ stageId: stage.stageId,
    stageDigest: sha256Digest(stage), proposedJobId: `proposal:wayfarer:${input.episodeId}:${stage.stageId}`,
    prerequisiteStageIds: pack.edges.filter((edge) => edge.toStageId === stage.stageId).map((edge) => edge.fromStageId),
    requiredInputRoles: stage.inputArtifactRoles, expectedOutputRoles: stage.outputArtifactRoles,
    requiresAcceptedReviewOfStageIds: stage.requiresAcceptedReviewOfStageIds, createsCanonicalJob: false, canDispatch: false, canExecute: false }));
  const material: Omit<WayfarerSyntheticWorkflowPlanV1, "planDigest"> = { contractVersion: WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1,
    planId: input.planId, tenantId: pack.tenantId, workspaceId: pack.workspaceId, projectId: pack.projectId, packId: pack.packId,
    packDigest: pack.packDigest, episodeId: input.episodeId, sourceArtifactDigests: sources.map((item) => item.artifactDigest), stages,
    compiledAt: input.compiledAt, syntheticOnly: true, createsCanonicalJobs: false, createsLeases: false, dispatchesWork: false,
    grantsApproval: false, grantsExecutionAuthority: false };
  return parseWayfarerSyntheticWorkflowPlanV1({ ...material, planDigest: sha256Digest(material) });
}

export function parseWayfarerSyntheticWorkflowPlanV1(value: unknown): WayfarerSyntheticWorkflowPlanV1 {
  const parsed = parse(planSchema, value) as WayfarerSyntheticWorkflowPlanV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "planDigest", parsed.planDigest);
  if (parsed.stages.map((item) => item.stageId).join("|") !== WAYFARER_STAGE_IDS_V1.join("|")
    || new Set(parsed.sourceArtifactDigests).size !== parsed.sourceArtifactDigests.length
    || new Set(parsed.stages.map((item) => item.proposedJobId)).size !== parsed.stages.length
    || parsed.stages.some((item) => new Set(item.prerequisiteStageIds).size !== item.prerequisiteStageIds.length
      || new Set(item.requiredInputRoles).size !== item.requiredInputRoles.length
      || new Set(item.expectedOutputRoles).size !== item.expectedOutputRoles.length
      || new Set(item.requiresAcceptedReviewOfStageIds).size !== item.requiresAcceptedReviewOfStageIds.length)) {
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
  return parsed;
}

export function parseWayfarerSyntheticPrerequisiteEvidenceV1(value: unknown): WayfarerSyntheticPrerequisiteEvidenceV1 {
  const parsed = parse(evidenceSchema, value) as WayfarerSyntheticPrerequisiteEvidenceV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "evidenceDigest", parsed.evidenceDigest); return parsed;
}

export function buildWayfarerSyntheticPrerequisiteEvidenceV1(inputValue: unknown): WayfarerSyntheticPrerequisiteEvidenceV1 {
  const input = parse(z.object({ receipt: z.unknown(), recordedAt: time }).strict(), inputValue), receipt = parseWayfarerSyntheticStageReceiptV1(input.receipt);
  const material: Omit<WayfarerSyntheticPrerequisiteEvidenceV1, "evidenceDigest"> = {
    contractVersion: WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1, evidenceId: `evidence:wayfarer:simulation:${receipt.stageId}:${receipt.receiptDigest.slice(7, 19)}`,
    tenantId: receipt.tenantId, projectId: receipt.projectId, packDigest: receipt.packDigest, planDigest: receipt.planDigest,
    stageId: receipt.stageId, stageReceiptDigest: receipt.receiptDigest, acceptedForSimulation: true,
    authoritativeCompletionResolution: false, grantsApproval: false, grantsExecutionAuthority: false, recordedAt: input.recordedAt };
  return parseWayfarerSyntheticPrerequisiteEvidenceV1({ ...material, evidenceDigest: sha256Digest(material) });
}

export function parseWayfarerSyntheticStageReceiptV1(value: unknown): WayfarerSyntheticStageReceiptV1 {
  const parsed = parse(receiptSchema, value) as WayfarerSyntheticStageReceiptV1;
  const outputs = parsed.outputArtifacts.map(parseWayfarerSyntheticArtifactV1);
  if (new Set(parsed.inputArtifactDigests).size !== parsed.inputArtifactDigests.length
    || new Set(parsed.prerequisiteEvidenceDigests).size !== parsed.prerequisiteEvidenceDigests.length
    || new Set(outputs.map((item) => item.role)).size !== outputs.length
    || new Set(parsed.qcResults.map((item) => item.ruleId)).size !== parsed.qcResults.length
    || outputs.some((item) => item.tenantId !== parsed.tenantId || item.workspaceId !== parsed.workspaceId
      || item.projectId !== parsed.projectId || item.packDigest !== parsed.packDigest || item.episodeId !== parsed.episodeId
      || item.producedByStageId !== parsed.stageId || item.inputArtifactDigests.join("|") !== parsed.inputArtifactDigests.join("|"))) {
    throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  exactDigest(parsed as unknown as Record<string, unknown>, "receiptDigest", parsed.receiptDigest); return parsed;
}

export class WayfarerSyntheticStageExecutorV1 {
  readonly #pack: WayfarerProjectPackV1;
  constructor(packValue: unknown) { this.#pack = parseWayfarerProjectPackV1(packValue); }
  execute(inputValue: unknown): WayfarerSyntheticStageReceiptV1 {
    const input = parse(executeInputSchema, inputValue), plan = parseWayfarerSyntheticWorkflowPlanV1(input.plan),
      stage = this.#pack.stages.find((item) => item.stageId === input.stageId), stagePlan = plan.stages.find((item) => item.stageId === input.stageId),
      artifacts = input.inputArtifacts.map(parseWayfarerSyntheticArtifactV1), evidence = input.prerequisiteEvidence.map(parseWayfarerSyntheticPrerequisiteEvidenceV1);
    const expectedProducer = (artifactRole: WayfarerArtifactRoleV1) => this.#pack.stages.find((candidate) =>
      candidate.outputArtifactRoles.includes(artifactRole))?.stageId;
    if (!stage || !stagePlan || plan.packDigest !== this.#pack.packDigest || plan.projectId !== this.#pack.projectId
      || stagePlan.stageDigest !== sha256Digest(stage) || stagePlan.requiredInputRoles.join("|") !== stage.inputArtifactRoles.join("|")
      || stagePlan.expectedOutputRoles.join("|") !== stage.outputArtifactRoles.join("|")
      || artifacts.map((item) => item.role).join("|") !== stage.inputArtifactRoles.join("|")
      || artifacts.some((item) => item.tenantId !== plan.tenantId || item.workspaceId !== plan.workspaceId || item.projectId !== plan.projectId
        || item.packDigest !== plan.packDigest || item.episodeId !== plan.episodeId || item.producedByStageId !== expectedProducer(item.role)
        || !this.#pack.artifacts.find((definition) => definition.role === item.role)?.allowedContentTypes.includes(item.contentType))
      || evidence.map((item) => item.stageId).join("|") !== stage.requiresAcceptedReviewOfStageIds.join("|")
      || evidence.some((item) => item.tenantId !== plan.tenantId || item.projectId !== plan.projectId || item.packDigest !== plan.packDigest
        || item.planDigest !== plan.planDigest)) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
    const inputDigests = artifacts.map((item) => item.artifactDigest), outputArtifacts = stage.outputArtifactRoles.map((outputRole) => {
      const definition = this.#pack.artifacts.find((item) => item.role === outputRole)!;
      const material: Omit<WayfarerSyntheticArtifactV1, "artifactDigest"> = { contractVersion: WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1,
        artifactId: `artifact:wayfarer:${plan.episodeId}:${input.stageId}:${outputRole}`, tenantId: plan.tenantId, workspaceId: plan.workspaceId,
        projectId: plan.projectId, packDigest: plan.packDigest, episodeId: plan.episodeId, role: outputRole,
        contentType: definition.allowedContentTypes[0]!, contentDigest: sha256Digest({ planDigest: plan.planDigest, stageId: input.stageId,
          outputRole, inputDigests }), inputArtifactDigests: inputDigests, producedByStageId: input.stageId, observedByteCount: 0,
        mediaMaterialPresent: false, synthetic: true, externalEffectOccurred: false, grantsAuthority: false, createdAt: input.executedAt };
      return parseWayfarerSyntheticArtifactV1({ ...material, artifactDigest: sha256Digest(material) });
    });
    const relevantRules = this.#pack.qcRules.filter((rule) => rule.appliesToArtifactRoles.some((item) =>
      stage.inputArtifactRoles.includes(item) || stage.outputArtifactRoles.includes(item)));
    const qcResults: WayfarerSyntheticQcResultV1[] = relevantRules.map((rule) => ({ ruleId: rule.ruleId, scenarioId: rule.scenarioId,
      outcome: "synthetic_pass", evidenceDigest: sha256Digest({ ruleId: rule.ruleId, planDigest: plan.planDigest, stageId: input.stageId,
        inputDigests, outputDigests: outputArtifacts.map((item) => item.artifactDigest) }), independentEvidenceRequiredForCompletion: true,
      qualifiesCompletion: false, grantsApproval: false, grantsExecutionAuthority: false }));
    const material: Omit<WayfarerSyntheticStageReceiptV1, "receiptDigest"> = { contractVersion: WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1,
      receiptId: `receipt:wayfarer:${plan.episodeId}:${input.stageId}`, tenantId: plan.tenantId, workspaceId: plan.workspaceId,
      projectId: plan.projectId, packDigest: plan.packDigest, planId: plan.planId, planDigest: plan.planDigest, episodeId: plan.episodeId,
      stageId: input.stageId, stageDigest: stagePlan.stageDigest, inputArtifactDigests: inputDigests, outputArtifacts,
      prerequisiteEvidenceDigests: evidence.map((item) => item.evidenceDigest), qcResults, executedAt: input.executedAt, synthetic: true,
      mediaToolInvoked: false, providerInvoked: false, networkUsed: false, objectStorageUsed: false, bytesMaterialized: false,
      createsCompletionRecord: false, completionCandidateOnly: true, externalEffectOccurred: false, grantsApproval: false,
      grantsExecutionAuthority: false };
    return parseWayfarerSyntheticStageReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
  }
}

export const wayfarerSyntheticSchemasV1 = { artifact: artifactSchema, stagePlan: stagePlanSchema, plan: planSchema,
  qcResult: qcResultSchema, receipt: receiptSchema, prerequisiteEvidence: evidenceSchema } as const;
