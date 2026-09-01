import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import {
  IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1,
  IDEA_LAB_HERMES_021_RELEASE_REVISION_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_SOURCE_MANIFEST_DIGEST_V1,
  IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1,
  IDEA_LAB_HERMES_021_VERSION_V1,
  ideaLabHermes021PanelPacketV1,
} from "./hermes-021-panel-packet";
import { ideaDigestSchemaV1 } from "./schemas";

export const HERMES_021_IDEA_LAB_NATIVE_QUALIFICATION_PLAN_V1 =
  "control-room-hermes-021-idea-lab-native-qualification-plan/v1" as const;
export const HERMES_021_IDEA_LAB_QUALIFICATION_SIMULATION_V1 =
  "control-room-hermes-021-idea-lab-qualification-simulation/v1" as const;

const planSchema = z.object({
  contractVersion: z.literal(HERMES_021_IDEA_LAB_NATIVE_QUALIFICATION_PLAN_V1),
  packetDigest: z.literal(ideaLabHermes021PanelPacketV1.packetDigest),
  compatibilityContractCommit: z.literal(IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1),
  runtimeVersion: z.literal(IDEA_LAB_HERMES_021_VERSION_V1),
  releaseRevision: z.literal(IDEA_LAB_HERMES_021_RELEASE_REVISION_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  sourceManifestDigest: z.literal(IDEA_LAB_HERMES_021_SOURCE_MANIFEST_DIGEST_V1),
  sourcePreflightDigest: z.literal(IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1),
  sourcePreflightAccepted: z.literal(true),
  priorAuthorizationReusable: z.literal(false),
  adapterId: z.literal("adapter.hermes.gateway.v2"),
  stages: z.tuple([
    z.literal("verify_exact_runtime"),
    z.literal("create_disposable_profile_workspace"),
    z.literal("verify_zero_tools_mcp"),
    z.literal("verify_harness_native_custody"),
    z.literal("mark_before_provider_contact"),
    z.literal("run_one_filtered_turn"),
    z.literal("verify_usage_and_sequence_replay"),
    z.literal("interrupt_and_reconcile"),
    z.literal("remove_disposable_resources"),
    z.literal("emit_sanitized_receipt"),
  ]),
  maximumNativeAttempts: z.literal(1),
  maximumProviderCalls: z.literal(1),
  maximumDurationSeconds: z.literal(300),
  maximumRetainedEvidenceBytes: z.literal(262_144),
  automaticRetryAllowed: z.literal(false),
  ownerAttendedWindowRequired: z.literal(true),
  strongFactorRequired: z.literal(true),
  exactInstalledRuntimeEvidenceRequired: z.literal(true),
  protectedValueCustodyEvidenceRequired: z.literal(true),
  zeroToolsRequired: z.literal(true),
  zeroMcpRequired: z.literal(true),
  disposableProfileRequired: z.literal(true),
  disposableWorkspaceRequired: z.literal(true),
  cleanupRequired: z.literal(true),
  unknownAfterMarker: z.literal("terminal_ambiguity"),
  nativePortConfigured: z.literal(false),
  ownerWindowPresent: z.literal(false),
  acceptedNativeReceiptDigests: z.tuple([]),
  status: z.literal("blocked_before_native_attempt"),
  nativeCallsMade: z.literal(0),
  providerCallsMade: z.literal(0),
  protectedValuesAccessed: z.literal(false),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  planDigest: ideaDigestSchemaV1,
}).strict();

export type Hermes021IdeaLabNativeQualificationPlanV1 = z.infer<typeof planSchema>;

const simulationSchema = z.object({
  contractVersion: z.literal(HERMES_021_IDEA_LAB_QUALIFICATION_SIMULATION_V1),
  planDigest: ideaDigestSchemaV1,
  evidenceSource: z.literal("injected_fixture"),
  fixtureDigest: ideaDigestSchemaV1,
  scenarios: z.object({
    exactCompletionTranslated: z.boolean(),
    streamingContentDiscarded: z.boolean(),
    timeoutAborted: z.boolean(),
    malformedSequenceRejected: z.boolean(),
    bindingDriftRejected: z.boolean(),
    cleanupRequiredAndVerified: z.boolean(),
    providerFailureDefiniteOnlyWhenProved: z.boolean(),
    replayNeverResubmits: z.boolean(),
  }).strict(),
  passedScenarioCount: z.number().int().min(0).max(8),
  totalScenarioCount: z.literal(8),
  simulationPassed: z.boolean(),
  nativeQualified: z.literal(false),
  livePanelEligible: z.literal(false),
  acceptedNativeReceiptDigest: z.null(),
  nativeCallsMade: z.literal(0),
  providerCallsMade: z.literal(0),
  protectedValuesAccessed: z.literal(false),
  grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  simulationDigest: ideaDigestSchemaV1,
}).strict();

const simulationInputSchema = z.object({
  fixtureDigest: ideaDigestSchemaV1,
  scenarios: simulationSchema.shape.scenarios,
}).strict();

export type Hermes021IdeaLabQualificationSimulationV1 = z.infer<typeof simulationSchema>;

function unsigned<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const result = { ...value };
  delete result[key];
  return result;
}

const planMaterial = {
  contractVersion: HERMES_021_IDEA_LAB_NATIVE_QUALIFICATION_PLAN_V1,
  packetDigest: ideaLabHermes021PanelPacketV1.packetDigest,
  compatibilityContractCommit: IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1,
  runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1,
  releaseRevision: IDEA_LAB_HERMES_021_RELEASE_REVISION_V1,
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  sourceManifestDigest: IDEA_LAB_HERMES_021_SOURCE_MANIFEST_DIGEST_V1,
  sourcePreflightDigest: IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1,
  sourcePreflightAccepted: true as const,
  priorAuthorizationReusable: false as const,
  adapterId: "adapter.hermes.gateway.v2" as const,
  stages: [
    "verify_exact_runtime", "create_disposable_profile_workspace", "verify_zero_tools_mcp",
    "verify_harness_native_custody", "mark_before_provider_contact", "run_one_filtered_turn",
    "verify_usage_and_sequence_replay", "interrupt_and_reconcile", "remove_disposable_resources",
    "emit_sanitized_receipt",
  ] as const,
  maximumNativeAttempts: 1 as const,
  maximumProviderCalls: 1 as const,
  maximumDurationSeconds: 300 as const,
  maximumRetainedEvidenceBytes: 262_144 as const,
  automaticRetryAllowed: false as const,
  ownerAttendedWindowRequired: true as const,
  strongFactorRequired: true as const,
  exactInstalledRuntimeEvidenceRequired: true as const,
  protectedValueCustodyEvidenceRequired: true as const,
  zeroToolsRequired: true as const,
  zeroMcpRequired: true as const,
  disposableProfileRequired: true as const,
  disposableWorkspaceRequired: true as const,
  cleanupRequired: true as const,
  unknownAfterMarker: "terminal_ambiguity" as const,
  nativePortConfigured: false as const,
  ownerWindowPresent: false as const,
  acceptedNativeReceiptDigests: [] as const,
  status: "blocked_before_native_attempt" as const,
  nativeCallsMade: 0 as const,
  providerCallsMade: 0 as const,
  protectedValuesAccessed: false as const,
  grantsApproval: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

export const hermes021IdeaLabNativeQualificationPlanV1: Hermes021IdeaLabNativeQualificationPlanV1 = Object.freeze(
  planSchema.parse({ ...planMaterial, planDigest: sha256Digest(planMaterial) }),
);

export function parseHermes021IdeaLabNativeQualificationPlanV1(value: unknown): Hermes021IdeaLabNativeQualificationPlanV1 {
  const parsed = parseExactIdeaLabV1(planSchema, value);
  if (sha256Digest(unsigned(parsed, "planDigest")) !== parsed.planDigest) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}

export function buildHermes021IdeaLabQualificationSimulationV1(input: {
  fixtureDigest: string;
  scenarios: Hermes021IdeaLabQualificationSimulationV1["scenarios"];
}): Hermes021IdeaLabQualificationSimulationV1 {
  const plan = parseHermes021IdeaLabNativeQualificationPlanV1(hermes021IdeaLabNativeQualificationPlanV1);
  const parsedInput = parseExactIdeaLabV1(simulationInputSchema, input);
  const passedScenarioCount = Object.values(parsedInput.scenarios).filter(Boolean).length;
  const material = {
    contractVersion: HERMES_021_IDEA_LAB_QUALIFICATION_SIMULATION_V1,
    planDigest: plan.planDigest,
    evidenceSource: "injected_fixture" as const,
    fixtureDigest: parsedInput.fixtureDigest,
    scenarios: parsedInput.scenarios,
    passedScenarioCount,
    totalScenarioCount: 8 as const,
    simulationPassed: passedScenarioCount === 8,
    nativeQualified: false as const,
    livePanelEligible: false as const,
    acceptedNativeReceiptDigest: null,
    nativeCallsMade: 0 as const,
    providerCallsMade: 0 as const,
    protectedValuesAccessed: false as const,
    grantsApproval: false as const,
    grantsExecutionAuthority: false as const,
  };
  return simulationSchema.parse({ ...material, simulationDigest: sha256Digest(material) });
}

export function parseHermes021IdeaLabQualificationSimulationV1(value: unknown): Hermes021IdeaLabQualificationSimulationV1 {
  const parsed = parseExactIdeaLabV1(simulationSchema, value);
  if (parsed.planDigest !== hermes021IdeaLabNativeQualificationPlanV1.planDigest
    || parsed.passedScenarioCount !== Object.values(parsed.scenarios).filter(Boolean).length
    || parsed.simulationPassed !== (parsed.passedScenarioCount === parsed.totalScenarioCount)
    || sha256Digest(unsigned(parsed, "simulationDigest")) !== parsed.simulationDigest) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  return parsed;
}

export const HERMES_021_IDEA_LAB_NATIVE_QUALIFICATION_DISABLED_V1 = Object.freeze({
  state: "blocked_before_native_attempt" as const,
  nativePortConfigured: false as const,
  acceptedNativeReceiptDigests: Object.freeze([]) as readonly string[],
  nativeCallsMade: 0 as const,
  providerCallsMade: 0 as const,
  grantsExecutionAuthority: false as const,
});
