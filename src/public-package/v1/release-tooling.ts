import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { PublicPackageContractErrorV1 } from "./errors";
import { parseExactPublicPackageV1, verifyPublicPackageDigestV1 } from "./exact";
import { buildPublicPackageTreeDefinitionsV1, PUBLIC_PACKAGE_LAYOUT_CONTRACT_V1 } from "./package-layout";

export const PUBLIC_RELEASE_TOOLING_CONTRACT_V1 = "control-room-public-release-tooling/v1" as const;
export const PUBLIC_CLEAN_ROOM_CONTRACT_V1 = "control-room-public-clean-room/v1" as const;

export const PUBLIC_RELEASE_STEP_IDS_V1 = [
  "source_inventory", "manifest_validation", "package_type_check", "package_unit_tests", "adapter_conformance",
  "guide_validation", "metadata_normalization", "synthetic_reproduction", "clean_room_assessment",
] as const;
export type PublicReleaseStepIdV1 = (typeof PUBLIC_RELEASE_STEP_IDS_V1)[number];

export interface PublicReleasePlanStepV1 {
  stepId: PublicReleaseStepIdV1;
  ordinal: number;
  evidenceClass: "source_digest" | "validation_report" | "test_report" | "reproduction_report" | "clean_room_report";
  effectMode: "none";
  stepDigest: string;
}

export interface PublicReleasePlanV1 {
  contractVersion: typeof PUBLIC_RELEASE_TOOLING_CONTRACT_V1;
  planId: string;
  packageVersion: string;
  sourceRevisionDigest: string;
  dependencyLockDigest: string;
  packageLayoutContractVersion: typeof PUBLIC_PACKAGE_LAYOUT_CONTRACT_V1;
  packageTreeDefinitionDigests: string[];
  steps: PublicReleasePlanStepV1[];
  localCandidateOnly: true;
  sourceMetadataOnly: true;
  archiveCreationAllowed: false;
  packageInstallationAllowed: false;
  registryContactAllowed: false;
  networkContactAllowed: false;
  nativeHarnessContactAllowed: false;
  signingAllowed: false;
  publicationAllowed: false;
  grantsReleaseAuthority: false;
  createdAt: string;
  planDigest: string;
}

const semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const releaseStepSchema = z.object({
  stepId: z.enum(PUBLIC_RELEASE_STEP_IDS_V1), ordinal: z.number().int().min(1).max(PUBLIC_RELEASE_STEP_IDS_V1.length),
  evidenceClass: z.enum(["source_digest", "validation_report", "test_report", "reproduction_report", "clean_room_report"]),
  effectMode: z.literal("none"), stepDigest: digest,
}).strict();
const releasePlanSchema = z.object({
  contractVersion: z.literal(PUBLIC_RELEASE_TOOLING_CONTRACT_V1), planId: id, packageVersion: semver,
  sourceRevisionDigest: digest, dependencyLockDigest: digest, packageLayoutContractVersion: z.literal(PUBLIC_PACKAGE_LAYOUT_CONTRACT_V1),
  packageTreeDefinitionDigests: z.array(digest).length(4), steps: z.array(releaseStepSchema).length(PUBLIC_RELEASE_STEP_IDS_V1.length),
  localCandidateOnly: z.literal(true), sourceMetadataOnly: z.literal(true), archiveCreationAllowed: z.literal(false),
  packageInstallationAllowed: z.literal(false), registryContactAllowed: z.literal(false), networkContactAllowed: z.literal(false),
  nativeHarnessContactAllowed: z.literal(false), signingAllowed: z.literal(false), publicationAllowed: z.literal(false),
  grantsReleaseAuthority: z.literal(false), createdAt: time, planDigest: digest,
}).strict();

const evidenceClasses: Record<PublicReleaseStepIdV1, PublicReleasePlanStepV1["evidenceClass"]> = {
  source_inventory: "source_digest", manifest_validation: "validation_report", package_type_check: "test_report",
  package_unit_tests: "test_report", adapter_conformance: "test_report", guide_validation: "validation_report",
  metadata_normalization: "validation_report", synthetic_reproduction: "reproduction_report", clean_room_assessment: "clean_room_report",
};

export function buildPublicReleasePlanV1(input: {
  packageVersion: string;
  sourceRevisionDigest: string;
  dependencyLockDigest: string;
  createdAt: string;
}): PublicReleasePlanV1 {
  const packageTreeDefinitionDigests = buildPublicPackageTreeDefinitionsV1().map((item) => item.definitionDigest);
  const stepMaterial = PUBLIC_RELEASE_STEP_IDS_V1.map((stepId, index) => ({
    stepId, ordinal: index + 1, evidenceClass: evidenceClasses[stepId], effectMode: "none" as const,
  }));
  const steps = stepMaterial.map((item) => ({ ...item, stepDigest: sha256Digest(item) }));
  const identity = { packageVersion: input.packageVersion, sourceRevisionDigest: input.sourceRevisionDigest, dependencyLockDigest: input.dependencyLockDigest,
    packageTreeDefinitionDigests, steps: steps.map((item) => item.stepDigest) };
  const material: Omit<PublicReleasePlanV1, "planDigest"> = {
    contractVersion: PUBLIC_RELEASE_TOOLING_CONTRACT_V1, planId: `release-plan:${sha256Digest(identity).slice(7, 31)}`,
    packageVersion: input.packageVersion, sourceRevisionDigest: input.sourceRevisionDigest, dependencyLockDigest: input.dependencyLockDigest,
    packageLayoutContractVersion: PUBLIC_PACKAGE_LAYOUT_CONTRACT_V1, packageTreeDefinitionDigests, steps,
    localCandidateOnly: true, sourceMetadataOnly: true, archiveCreationAllowed: false, packageInstallationAllowed: false,
    registryContactAllowed: false, networkContactAllowed: false, nativeHarnessContactAllowed: false, signingAllowed: false,
    publicationAllowed: false, grantsReleaseAuthority: false, createdAt: input.createdAt,
  };
  return parsePublicReleasePlanV1({ ...material, planDigest: sha256Digest(material) });
}

export function parsePublicReleasePlanV1(value: unknown): PublicReleasePlanV1 {
  const parsed = parseExactPublicPackageV1(releasePlanSchema, value, "public release plan");
  if (parsed.steps.map((item) => item.stepId).join("|") !== PUBLIC_RELEASE_STEP_IDS_V1.join("|")
    || parsed.steps.some((item, index) => item.ordinal !== index + 1 || item.evidenceClass !== evidenceClasses[item.stepId])) {
    throw new PublicPackageContractErrorV1("evidence_mismatch");
  }
  parsed.steps.forEach((step) => verifyPublicPackageDigestV1(step as unknown as Record<string, unknown>, "stepDigest", step.stepDigest));
  const expectedTrees = buildPublicPackageTreeDefinitionsV1().map((item) => item.definitionDigest);
  if (parsed.packageTreeDefinitionDigests.join("|") !== expectedTrees.join("|")) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const identity = { packageVersion: parsed.packageVersion, sourceRevisionDigest: parsed.sourceRevisionDigest,
    dependencyLockDigest: parsed.dependencyLockDigest, packageTreeDefinitionDigests: parsed.packageTreeDefinitionDigests,
    steps: parsed.steps.map((item) => item.stepDigest) };
  if (parsed.planId !== `release-plan:${sha256Digest(identity).slice(7, 31)}`) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "planDigest", parsed.planDigest);
  return parsed;
}

export interface SyntheticDeploymentExampleV1 {
  contractVersion: typeof PUBLIC_RELEASE_TOOLING_CONTRACT_V1;
  exampleId: "example:public-package:synthetic-deployment:v1";
  tenantId: "tenant.synthetic.public.v1";
  projectId: "project.synthetic.public.v1";
  runId: "run.synthetic.public.v1";
  adapterIds: string[];
  dataProfile: "fabricated_only";
  storageMode: "memory_only";
  networkMode: "disabled";
  effectAuthority: "none";
  installedHarnessContacted: false;
  providerContacted: false;
  exampleDigest: string;
}

const syntheticExampleSchema = z.object({
  contractVersion: z.literal(PUBLIC_RELEASE_TOOLING_CONTRACT_V1), exampleId: z.literal("example:public-package:synthetic-deployment:v1"),
  tenantId: z.literal("tenant.synthetic.public.v1"), projectId: z.literal("project.synthetic.public.v1"), runId: z.literal("run.synthetic.public.v1"),
  adapterIds: z.array(id).length(3), dataProfile: z.literal("fabricated_only"), storageMode: z.literal("memory_only"),
  networkMode: z.literal("disabled"), effectAuthority: z.literal("none"), installedHarnessContacted: z.literal(false),
  providerContacted: z.literal(false), exampleDigest: digest,
}).strict();

export function buildSyntheticDeploymentExampleV1(): SyntheticDeploymentExampleV1 {
  const material: Omit<SyntheticDeploymentExampleV1, "exampleDigest"> = {
    contractVersion: PUBLIC_RELEASE_TOOLING_CONTRACT_V1, exampleId: "example:public-package:synthetic-deployment:v1",
    tenantId: "tenant.synthetic.public.v1", projectId: "project.synthetic.public.v1", runId: "run.synthetic.public.v1",
    adapterIds: ["adapter.reference.hermes.synthetic.v1", "adapter.reference.codex.synthetic.v1", "adapter.reference.example.synthetic.v1"],
    dataProfile: "fabricated_only", storageMode: "memory_only", networkMode: "disabled", effectAuthority: "none",
    installedHarnessContacted: false, providerContacted: false,
  };
  return parseSyntheticDeploymentExampleV1({ ...material, exampleDigest: sha256Digest(material) });
}

export function parseSyntheticDeploymentExampleV1(value: unknown): SyntheticDeploymentExampleV1 {
  const parsed = parseExactPublicPackageV1(syntheticExampleSchema, value, "synthetic public deployment example");
  if (parsed.adapterIds.join("|") !== ["adapter.reference.hermes.synthetic.v1", "adapter.reference.codex.synthetic.v1", "adapter.reference.example.synthetic.v1"].join("|")) {
    throw new PublicPackageContractErrorV1("evidence_mismatch");
  }
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "exampleDigest", parsed.exampleDigest);
  return parsed;
}

export interface PublicReproductionObservationV1 {
  contractVersion: typeof PUBLIC_CLEAN_ROOM_CONTRACT_V1;
  observationId: string;
  planDigest: string;
  runnerId: string;
  evidenceMode: "synthetic";
  result: "passed" | "failed";
  outputDigests: string[];
  guideValidationPassed: boolean;
  conformancePassed: boolean;
  archiveCreated: false;
  packageInstalled: false;
  registryContacted: false;
  networkContacted: false;
  nativeHarnessContacted: false;
  signingAttempted: false;
  publicationAttempted: false;
  observedAt: string;
  observationDigest: string;
}

const reproductionSchema = z.object({
  contractVersion: z.literal(PUBLIC_CLEAN_ROOM_CONTRACT_V1), observationId: id, planDigest: digest, runnerId: id,
  evidenceMode: z.literal("synthetic"), result: z.enum(["passed", "failed"]), outputDigests: z.array(digest).length(4),
  guideValidationPassed: z.boolean(), conformancePassed: z.boolean(), archiveCreated: z.literal(false), packageInstalled: z.literal(false),
  registryContacted: z.literal(false), networkContacted: z.literal(false), nativeHarnessContacted: z.literal(false),
  signingAttempted: z.literal(false), publicationAttempted: z.literal(false), observedAt: time, observationDigest: digest,
}).strict();

export function buildPublicReproductionObservationV1(input: {
  plan: PublicReleasePlanV1;
  runnerId: string;
  result: "passed" | "failed";
  outputDigests: string[];
  guideValidationPassed: boolean;
  conformancePassed: boolean;
  observedAt: string;
}): PublicReproductionObservationV1 {
  const plan = parsePublicReleasePlanV1(input.plan);
  const identity = { planDigest: plan.planDigest, runnerId: input.runnerId, outputDigests: input.outputDigests, observedAt: input.observedAt };
  const material: Omit<PublicReproductionObservationV1, "observationDigest"> = {
    contractVersion: PUBLIC_CLEAN_ROOM_CONTRACT_V1, observationId: `reproduction:${sha256Digest(identity).slice(7, 31)}`,
    planDigest: plan.planDigest, runnerId: input.runnerId, evidenceMode: "synthetic", result: input.result,
    outputDigests: input.outputDigests, guideValidationPassed: input.guideValidationPassed, conformancePassed: input.conformancePassed,
    archiveCreated: false, packageInstalled: false, registryContacted: false, networkContacted: false,
    nativeHarnessContacted: false, signingAttempted: false, publicationAttempted: false, observedAt: input.observedAt,
  };
  return parsePublicReproductionObservationV1({ ...material, observationDigest: sha256Digest(material) });
}

export function parsePublicReproductionObservationV1(value: unknown): PublicReproductionObservationV1 {
  const parsed = parseExactPublicPackageV1(reproductionSchema, value, "public reproduction observation");
  if (parsed.result === "passed" && (!parsed.guideValidationPassed || !parsed.conformancePassed)) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const identity = { planDigest: parsed.planDigest, runnerId: parsed.runnerId, outputDigests: parsed.outputDigests, observedAt: parsed.observedAt };
  if (parsed.observationId !== `reproduction:${sha256Digest(identity).slice(7, 31)}`) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "observationDigest", parsed.observationDigest);
  return parsed;
}

export interface PublicCleanRoomAssessmentV1 {
  contractVersion: typeof PUBLIC_CLEAN_ROOM_CONTRACT_V1;
  assessmentId: string;
  planDigest: string;
  firstObservationDigest: string;
  secondObservationDigest: string;
  runnerIndependent: boolean;
  outputsReproduced: boolean;
  state: "blocked" | "synthetic_candidate_only";
  blockers: Array<"observation_failed" | "runner_not_independent" | "output_mismatch">;
  evidenceMode: "synthetic";
  actualCleanRoomInstallObserved: false;
  actualReleaseArtifactBuilt: false;
  independentExternalEvidenceRequired: true;
  grantsCertification: false;
  grantsInstallAuthority: false;
  grantsPublicationAuthority: false;
  assessedAt: string;
  assessmentDigest: string;
}

const blocker = z.enum(["observation_failed", "runner_not_independent", "output_mismatch"]);
const cleanRoomAssessmentSchema = z.object({
  contractVersion: z.literal(PUBLIC_CLEAN_ROOM_CONTRACT_V1), assessmentId: id, planDigest: digest,
  firstObservationDigest: digest, secondObservationDigest: digest, runnerIndependent: z.boolean(), outputsReproduced: z.boolean(),
  state: z.enum(["blocked", "synthetic_candidate_only"]), blockers: z.array(blocker).max(3), evidenceMode: z.literal("synthetic"),
  actualCleanRoomInstallObserved: z.literal(false), actualReleaseArtifactBuilt: z.literal(false), independentExternalEvidenceRequired: z.literal(true),
  grantsCertification: z.literal(false), grantsInstallAuthority: z.literal(false), grantsPublicationAuthority: z.literal(false),
  assessedAt: time, assessmentDigest: digest,
}).strict();

export function assessPublicCleanRoomV1(input: {
  plan: PublicReleasePlanV1;
  first: PublicReproductionObservationV1;
  second: PublicReproductionObservationV1;
  assessedAt: string;
}): PublicCleanRoomAssessmentV1 {
  const plan = parsePublicReleasePlanV1(input.plan), first = parsePublicReproductionObservationV1(input.first), second = parsePublicReproductionObservationV1(input.second);
  if (first.planDigest !== plan.planDigest || second.planDigest !== plan.planDigest) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const runnerIndependent = first.runnerId !== second.runnerId;
  const outputsReproduced = first.outputDigests.join("|") === second.outputDigests.join("|");
  const blockers: PublicCleanRoomAssessmentV1["blockers"] = [];
  if (first.result !== "passed" || second.result !== "passed") blockers.push("observation_failed");
  if (!runnerIndependent) blockers.push("runner_not_independent");
  if (!outputsReproduced) blockers.push("output_mismatch");
  const identity = { planDigest: plan.planDigest, firstObservationDigest: first.observationDigest, secondObservationDigest: second.observationDigest };
  const material: Omit<PublicCleanRoomAssessmentV1, "assessmentDigest"> = {
    contractVersion: PUBLIC_CLEAN_ROOM_CONTRACT_V1, assessmentId: `clean-room-assessment:${sha256Digest(identity).slice(7, 31)}`,
    planDigest: plan.planDigest, firstObservationDigest: first.observationDigest, secondObservationDigest: second.observationDigest,
    runnerIndependent, outputsReproduced, state: blockers.length === 0 ? "synthetic_candidate_only" : "blocked", blockers,
    evidenceMode: "synthetic", actualCleanRoomInstallObserved: false, actualReleaseArtifactBuilt: false,
    independentExternalEvidenceRequired: true, grantsCertification: false, grantsInstallAuthority: false,
    grantsPublicationAuthority: false, assessedAt: input.assessedAt,
  };
  return parsePublicCleanRoomAssessmentV1({ ...material, assessmentDigest: sha256Digest(material) });
}

export function parsePublicCleanRoomAssessmentV1(value: unknown): PublicCleanRoomAssessmentV1 {
  const parsed = parseExactPublicPackageV1(cleanRoomAssessmentSchema, value, "public clean room assessment");
  const expectedState = parsed.blockers.length === 0 ? "synthetic_candidate_only" : "blocked";
  if (parsed.state !== expectedState || parsed.runnerIndependent === parsed.blockers.includes("runner_not_independent")
    || parsed.outputsReproduced === parsed.blockers.includes("output_mismatch")) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const identity = { planDigest: parsed.planDigest, firstObservationDigest: parsed.firstObservationDigest,
    secondObservationDigest: parsed.secondObservationDigest };
  if (parsed.assessmentId !== `clean-room-assessment:${sha256Digest(identity).slice(7, 31)}`
    || new Set(parsed.blockers).size !== parsed.blockers.length) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "assessmentDigest", parsed.assessmentDigest);
  return parsed;
}

export interface DisabledPublicReleaseMaterializationReceiptV1 {
  contractVersion: typeof PUBLIC_RELEASE_TOOLING_CONTRACT_V1;
  planDigest: string;
  disposition: "disabled_before_archive_creation";
  safeReasonCode: "public_release_materialization_not_authorized";
  filesystemClientPresent: false;
  processClientPresent: false;
  registryClientPresent: false;
  networkClientPresent: false;
  archiveCreated: false;
  packageInstalled: false;
  signingAttempted: false;
  uploadAttempted: false;
  publicationAttempted: false;
  grantsReleaseAuthority: false;
  observedAt: string;
  receiptDigest: string;
}

const disabledReceiptSchema = z.object({
  contractVersion: z.literal(PUBLIC_RELEASE_TOOLING_CONTRACT_V1), planDigest: digest,
  disposition: z.literal("disabled_before_archive_creation"), safeReasonCode: z.literal("public_release_materialization_not_authorized"),
  filesystemClientPresent: z.literal(false), processClientPresent: z.literal(false), registryClientPresent: z.literal(false),
  networkClientPresent: z.literal(false), archiveCreated: z.literal(false), packageInstalled: z.literal(false),
  signingAttempted: z.literal(false), uploadAttempted: z.literal(false), publicationAttempted: z.literal(false),
  grantsReleaseAuthority: z.literal(false), observedAt: time, receiptDigest: digest,
}).strict();

export function createDisabledPublicReleaseMaterializerV1(): {
  materialize(plan: PublicReleasePlanV1, observedAt: string): DisabledPublicReleaseMaterializationReceiptV1;
} {
  return Object.freeze({ materialize(plan: PublicReleasePlanV1, observedAt: string) {
    const exactPlan = parsePublicReleasePlanV1(plan);
    const material: Omit<DisabledPublicReleaseMaterializationReceiptV1, "receiptDigest"> = {
      contractVersion: PUBLIC_RELEASE_TOOLING_CONTRACT_V1, planDigest: exactPlan.planDigest,
      disposition: "disabled_before_archive_creation", safeReasonCode: "public_release_materialization_not_authorized",
      filesystemClientPresent: false, processClientPresent: false, registryClientPresent: false, networkClientPresent: false,
      archiveCreated: false, packageInstalled: false, signingAttempted: false, uploadAttempted: false,
      publicationAttempted: false, grantsReleaseAuthority: false, observedAt,
    };
    return parseDisabledPublicReleaseMaterializationReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
  } });
}

export function parseDisabledPublicReleaseMaterializationReceiptV1(value: unknown): DisabledPublicReleaseMaterializationReceiptV1 {
  const parsed = parseExactPublicPackageV1(disabledReceiptSchema, value, "disabled public release materialization receipt");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "receiptDigest", parsed.receiptDigest);
  return parsed;
}
