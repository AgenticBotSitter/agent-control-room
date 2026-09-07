import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { IDEA_LAB_HERMES_021_REVISION_V1 } from "./hermes-021-panel-packet";
import { ideaLabOwnerReadyLivePacketV1 } from "./owner-ready-live-packet";
import { capturedIdeaTimeMillisecondsV1, capturedPatternMatchesV1, ideaDigestSchemaV1, ideaIdSchemaV1,
  ideaTimeSchemaV1 } from "./schemas";

export const IDEA_LAB_HERMES_PROFILE_PREPARATION_CONTRACT_V1 =
  "control-room-hermes-profile-preparation/v1" as const;
export const IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1 =
  "profiles.prepare_control_room_qualification" as const;
export const IDEA_LAB_HERMES_PROFILE_PREPARATION_REQUEST_V1 =
  "control-room-hermes-profile-preparation-request/v1" as const;

const compatibilityEvidenceSchema = z.object({
  runtimeRevision: z.string().refine((value) => capturedPatternMatchesV1(/^[a-f0-9]{40}$/, value)),
  nativeMethod: z.string().min(1).max(120),
  signedDeviceAttestation: z.boolean(),
  protectedValueTransferInternal: z.boolean(),
  opaqueOneUseLaunchPermitInternal: z.boolean(),
  copiesSoul: z.boolean(),
  copiesMemory: z.boolean(),
  copiesSkills: z.boolean(),
  copiesPlugins: z.boolean(),
  copiesMcpConfiguration: z.boolean(),
  copiesRules: z.boolean(),
  copiesSessions: z.boolean(),
  returnsProtectedValueMaterial: z.boolean(),
  returnsNativePath: z.boolean(),
  startsGateway: z.boolean(),
  contactsProvider: z.boolean(),
  cleanupMethodPresent: z.boolean(),
}).strict();

export type IdeaLabHermesProfilePreparationCompatibilityEvidenceV1 = z.infer<typeof compatibilityEvidenceSchema>;

export type IdeaLabHermesProfilePreparationCompatibilityReasonV1 =
  | "invalid_evidence" | "runtime_revision_not_accepted" | "method_missing" | "device_attestation_missing"
  | "native_protected_value_transfer_missing" | "opaque_launch_permit_missing" | "private_context_copy_present"
  | "protected_value_material_returned" | "native_path_returned" | "gateway_start_present"
  | "provider_contact_present" | "cleanup_method_missing";

export interface IdeaLabHermesProfilePreparationCompatibilityDecisionV1 {
  compatible: false;
  reasons: readonly IdeaLabHermesProfilePreparationCompatibilityReasonV1[];
}

export const ideaLabHermesProfilePreparationManifestV1 = Object.freeze({
  contractVersion: IDEA_LAB_HERMES_PROFILE_PREPARATION_CONTRACT_V1,
  nativeMethod: IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1,
  runtimeRevisionUnderReview: IDEA_LAB_HERMES_021_REVISION_V1,
  acceptedRuntimeRevisions: Object.freeze([]) as readonly string[],
  requestMode: "proposal_only" as const,
  requiredOutput: "signed_digest_only_attestation" as const,
  protectedValueTransferMode: "hermes_native_internal" as const,
  launchPermitCustody: "hermes_native_internal" as const,
  copiedContextAllowed: Object.freeze([]) as readonly string[],
  returnedMaterialAllowed: Object.freeze([
    "request_digest", "profile_identity_digest", "launch_permit_digest", "custody_evidence_digest",
    "negative_context_counts", "expiry", "device_attestation",
  ] as const),
  providerCallsAllowed: 0 as const,
  gatewayStartsAllowed: 0 as const,
  enabledByDefault: false as const,
  nativeQualified: false as const,
  grantsApproval: false as const,
  grantsCommandAuthority: false as const,
  grantsExecutionAuthority: false as const,
});

export function evaluateIdeaLabHermesProfilePreparationCompatibilityV1(value: unknown):
  IdeaLabHermesProfilePreparationCompatibilityDecisionV1 {
  let evidence: IdeaLabHermesProfilePreparationCompatibilityEvidenceV1;
  try { evidence = parseExactIdeaLabV1(compatibilityEvidenceSchema, value); }
  catch { return Object.freeze({ compatible: false, reasons: Object.freeze(["invalid_evidence"] as const) }); }
  const reasons: IdeaLabHermesProfilePreparationCompatibilityReasonV1[] = [];
  if (!ideaLabHermesProfilePreparationManifestV1.acceptedRuntimeRevisions.includes(evidence.runtimeRevision)) {
    reasons.push("runtime_revision_not_accepted");
  }
  if (evidence.nativeMethod !== IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1) reasons.push("method_missing");
  if (!evidence.signedDeviceAttestation) reasons.push("device_attestation_missing");
  if (!evidence.protectedValueTransferInternal) reasons.push("native_protected_value_transfer_missing");
  if (!evidence.opaqueOneUseLaunchPermitInternal) reasons.push("opaque_launch_permit_missing");
  if (evidence.copiesSoul || evidence.copiesMemory || evidence.copiesSkills || evidence.copiesPlugins
    || evidence.copiesMcpConfiguration || evidence.copiesRules || evidence.copiesSessions) {
    reasons.push("private_context_copy_present");
  }
  if (evidence.returnsProtectedValueMaterial) reasons.push("protected_value_material_returned");
  if (evidence.returnsNativePath) reasons.push("native_path_returned");
  if (evidence.startsGateway) reasons.push("gateway_start_present");
  if (evidence.contactsProvider) reasons.push("provider_contact_present");
  if (!evidence.cleanupMethodPresent) reasons.push("cleanup_method_missing");
  return Object.freeze({ compatible: false, reasons: Object.freeze(reasons) });
}

const requestSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_PROFILE_PREPARATION_REQUEST_V1),
  method: z.literal(IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1),
  requestId: ideaIdSchemaV1,
  ownerPacketDigest: z.literal(ideaLabOwnerReadyLivePacketV1.packetDigest),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  sourceProfileSelectorDigest: ideaDigestSchemaV1,
  nonceDigest: ideaDigestSchemaV1,
  issuedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
  maximumLifetimeSeconds: z.literal(60),
  preparationPolicy: z.object({
    protectedValueTransferMode: z.literal("hermes_native_internal"),
    launchPermitCustody: z.literal("hermes_native_internal"),
    temporaryProfile: z.literal(true),
    copySoul: z.literal(false), copyMemory: z.literal(false), copySkills: z.literal(false),
    copyPlugins: z.literal(false), copyMcpConfiguration: z.literal(false), copyRules: z.literal(false),
    copySessions: z.literal(false), returnProtectedValueMaterial: z.literal(false), returnNativePath: z.literal(false),
    startGateway: z.literal(false), contactProvider: z.literal(false), cleanupRequired: z.literal(true),
  }).strict(),
  requestMode: z.literal("proposal_only"),
  nativeCallsMade: z.literal(0),
  providerCallsMade: z.literal(0),
  protectedValuesAccessed: z.literal(false),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  requestDigest: ideaDigestSchemaV1,
}).strict();

export type IdeaLabHermesProfilePreparationRequestV1 = z.infer<typeof requestSchema>;

export function buildIdeaLabHermesProfilePreparationRequestV1(input: {
  requestId: string; sourceProfileSelectorDigest: string; nonceDigest: string; issuedAt: string; expiresAt: string;
}): IdeaLabHermesProfilePreparationRequestV1 {
  const parsedInput = parseExactIdeaLabV1(z.object({ requestId: ideaIdSchemaV1,
    sourceProfileSelectorDigest: ideaDigestSchemaV1, nonceDigest: ideaDigestSchemaV1,
    issuedAt: ideaTimeSchemaV1, expiresAt: ideaTimeSchemaV1 }).strict(), input);
  const issued = capturedIdeaTimeMillisecondsV1(parsedInput.issuedAt)!;
  const expires = capturedIdeaTimeMillisecondsV1(parsedInput.expiresAt)!;
  if (expires <= issued || expires - issued > 60_000) {
    throw new IdeaLabErrorV1("invalid_input");
  }
  const material = {
    contractVersion: IDEA_LAB_HERMES_PROFILE_PREPARATION_REQUEST_V1,
    method: IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1,
    ...parsedInput,
    ownerPacketDigest: ideaLabOwnerReadyLivePacketV1.packetDigest,
    runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    maximumLifetimeSeconds: 60 as const,
    preparationPolicy: {
      protectedValueTransferMode: "hermes_native_internal" as const,
      launchPermitCustody: "hermes_native_internal" as const,
      temporaryProfile: true as const,
      copySoul: false as const, copyMemory: false as const, copySkills: false as const,
      copyPlugins: false as const, copyMcpConfiguration: false as const, copyRules: false as const,
      copySessions: false as const, returnProtectedValueMaterial: false as const, returnNativePath: false as const,
      startGateway: false as const, contactProvider: false as const, cleanupRequired: true as const,
    },
    requestMode: "proposal_only" as const,
    nativeCallsMade: 0 as const,
    providerCallsMade: 0 as const,
    protectedValuesAccessed: false as const,
    grantsApproval: false as const,
    grantsCommandAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  return Object.freeze(requestSchema.parse({ ...material, requestDigest: sha256Digest(material) }));
}

export function parseIdeaLabHermesProfilePreparationRequestV1(value: unknown):
  IdeaLabHermesProfilePreparationRequestV1 {
  const parsed = parseExactIdeaLabV1(requestSchema, value);
  const unsigned = { ...parsed } as Record<string, unknown>;
  delete unsigned.requestDigest;
  const issued = capturedIdeaTimeMillisecondsV1(parsed.issuedAt)!;
  const expires = capturedIdeaTimeMillisecondsV1(parsed.expiresAt)!;
  if (sha256Digest(unsigned) !== parsed.requestDigest || expires <= issued || expires - issued > 60_000) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  return parsed;
}
