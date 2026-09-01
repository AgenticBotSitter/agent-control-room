import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { ideaDigestSchemaV1 } from "./schemas";

export const IDEA_LAB_HERMES_021_PANEL_PACKET_V1 = "control-room-idea-lab-hermes-021-panel-packet/v1" as const;
export const IDEA_LAB_HERMES_021_VERSION_V1 = "0.21.0" as const;
export const IDEA_LAB_HERMES_021_REVISION_V1 = "29112bef099274229cadff79cdff7bf7b99c4b77" as const;
export const IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1 = "629006dbaa958f55403fb926c4686c237d593523" as const;

const packetSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_PANEL_PACKET_V1),
  providerId: z.literal("hermes_bot_mode"),
  adapterId: z.literal("adapter.hermes.gateway.v2"),
  adapterVersion: z.literal("2.0.0"),
  runtimeVersion: z.literal(IDEA_LAB_HERMES_021_VERSION_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  compatibilityContractCommit: z.literal(IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1),
  sourceCompatibility: z.literal("accepted_repository_evidence"),
  lifecycleSurfaceCompatible: z.literal(true),
  botModeBuiltIn: z.literal(true),
  requiredGatewayMethods: z.tuple([
    z.literal("session.create"), z.literal("prompt.submit"), z.literal("session.steer"),
    z.literal("session.interrupt"), z.literal("session.resume"), z.literal("session.status"), z.literal("session.usage"),
  ]),
  requiredEventReplayMethod: z.literal("session.events.since"),
  protectedValueCustodyMode: z.literal("harness_native"),
  controlRoomCanReadProtectedValue: z.literal(false),
  nativeQualified: z.literal(false),
  acceptedNativeQualificationReceiptDigests: z.tuple([]),
  ownerEffectWindowPresent: z.literal(false),
  acceptedAdmissionDigests: z.tuple([]),
  livePanelEligible: z.literal(false),
  blockerCodes: z.tuple([
    z.literal("native_qualification_missing"), z.literal("protected_value_custody_evidence_missing"),
    z.literal("owner_effect_window_missing"), z.literal("admission_authority_not_configured"),
    z.literal("live_driver_not_configured"),
  ]),
  defaultComposition: z.literal("provider_disabled"),
  browserComposition: z.literal("provider_disabled"),
  productionComposition: z.literal("provider_disabled"),
  nativeCallsMade: z.literal(0),
  protectedValuesAccessed: z.literal(false),
  providerContacted: z.literal(false),
  automaticRetryAllowed: z.literal(false),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsProjectCreationAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  packetDigest: ideaDigestSchemaV1,
}).strict();

export type IdeaLabHermes021PanelPacketV1 = z.infer<typeof packetSchema>;

function withoutDigest(value: IdeaLabHermes021PanelPacketV1): Record<string, unknown> {
  const result = { ...value };
  delete (result as { packetDigest?: string }).packetDigest;
  return result;
}

const packetMaterial = {
  contractVersion: IDEA_LAB_HERMES_021_PANEL_PACKET_V1,
  providerId: "hermes_bot_mode" as const,
  adapterId: "adapter.hermes.gateway.v2" as const,
  adapterVersion: "2.0.0" as const,
  runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1,
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  compatibilityContractCommit: IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1,
  sourceCompatibility: "accepted_repository_evidence" as const,
  lifecycleSurfaceCompatible: true as const,
  botModeBuiltIn: true as const,
  requiredGatewayMethods: [
    "session.create", "prompt.submit", "session.steer", "session.interrupt", "session.resume", "session.status", "session.usage",
  ] as const,
  requiredEventReplayMethod: "session.events.since" as const,
  protectedValueCustodyMode: "harness_native" as const,
  controlRoomCanReadProtectedValue: false as const,
  nativeQualified: false as const,
  acceptedNativeQualificationReceiptDigests: [] as const,
  ownerEffectWindowPresent: false as const,
  acceptedAdmissionDigests: [] as const,
  livePanelEligible: false as const,
  blockerCodes: [
    "native_qualification_missing", "protected_value_custody_evidence_missing", "owner_effect_window_missing",
    "admission_authority_not_configured", "live_driver_not_configured",
  ] as const,
  defaultComposition: "provider_disabled" as const,
  browserComposition: "provider_disabled" as const,
  productionComposition: "provider_disabled" as const,
  nativeCallsMade: 0 as const,
  protectedValuesAccessed: false as const,
  providerContacted: false as const,
  automaticRetryAllowed: false as const,
  grantsApproval: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsProjectCreationAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

export const ideaLabHermes021PanelPacketV1: IdeaLabHermes021PanelPacketV1 = Object.freeze(
  packetSchema.parse({ ...packetMaterial, packetDigest: sha256Digest(packetMaterial) }),
);

export function parseIdeaLabHermes021PanelPacketV1(value: unknown): IdeaLabHermes021PanelPacketV1 {
  const parsed = parseExactIdeaLabV1(packetSchema, value);
  if (sha256Digest(withoutDigest(parsed)) !== parsed.packetDigest) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}

export function buildIdeaLabHermes021RuntimeCandidateV1(input: {
  compatibilityEvidenceDigest: string;
  nativeQualificationReceiptDigest: string;
  runtimeManifestDigest: string;
  protectedValueCustodyEvidenceDigest: string;
}) {
  const packet = parseIdeaLabHermes021PanelPacketV1(ideaLabHermes021PanelPacketV1);
  return Object.freeze({
    providerId: packet.providerId,
    adapterId: packet.adapterId,
    adapterVersion: packet.adapterVersion,
    runtimeVersion: packet.runtimeVersion,
    runtimeRevision: packet.runtimeRevision,
    compatibilityEvidenceDigest: input.compatibilityEvidenceDigest,
    nativeQualificationReceiptDigest: input.nativeQualificationReceiptDigest,
    runtimeManifestDigest: input.runtimeManifestDigest,
    protectedValueCustodyMode: packet.protectedValueCustodyMode,
    protectedValueCustodyEvidenceDigest: input.protectedValueCustodyEvidenceDigest,
    controlRoomCanReadProtectedValue: false as const,
    protectedValueMaterialPresent: false as const,
    toolsDisabled: true as const,
    mcpDisabled: true as const,
    start: true as const,
    filteredEvents: true as const,
    usage: true as const,
    cancel: true as const,
    steer: true as const,
    resume: true as const,
  });
}
