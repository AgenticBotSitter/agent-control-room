import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1,
} from "./hermes-021-panel-packet";
import { ideaLabOwnerReadyLivePacketV1 } from "./owner-ready-live-packet";
import { ideaDigestSchemaV1 } from "./schemas";

export const IDEA_LAB_HERMES_021_NATIVE_LAUNCH_READINESS_V1 =
  "control-room-idea-lab-hermes-021-native-launch-readiness/v1" as const;
export const IDEA_LAB_HERMES_021_PROFILES_SOURCE_DIGEST_V1 =
  "sha256:edeafa558cea28cc42ce4e80a21489a3176454a48bae9f767d8c179b954e0981" as const;
export const IDEA_LAB_HERMES_021_PROFILE_PARSER_SOURCE_DIGEST_V1 =
  "sha256:b82d2a1d6ed164203b33897aa3aec3797c7f80bfda93ad066e49d8ec904e8196" as const;

const readinessSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_NATIVE_LAUNCH_READINESS_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  ownerPacketDigest: z.literal(ideaLabOwnerReadyLivePacketV1.packetDigest),
  sourcePreflightDigest: z.literal(IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1),
  profileSourceDigests: z.tuple([
    z.object({ pathId: z.literal("hermes_cli_profiles"),
      sha256: z.literal(IDEA_LAB_HERMES_021_PROFILES_SOURCE_DIGEST_V1) }).strict(),
    z.object({ pathId: z.literal("hermes_cli_profile_parser"),
      sha256: z.literal(IDEA_LAB_HERMES_021_PROFILE_PARSER_SOURCE_DIGEST_V1) }).strict(),
  ]),
  observedProfileSemantics: z.object({
    freshProfileSeedsEmptyProtectedValueFile: z.literal(true),
    cloneCopiesProtectedValueFile: z.literal(true),
    cloneCopiesSoulSkillsAndMemory: z.literal(true),
    noSkillsCannotCombineWithClone: z.literal(true),
    protectedValueOnlyCloneAvailable: z.literal(false),
  }).strict(),
  requiredBoundary: z.literal("disposable_empty_profile_with_existing_hermes_authentication"),
  profileIsolationEligible: z.literal(false),
  ownerAuthorizationPresent: z.literal(false),
  nativePortConfigured: z.literal(false),
  ownerCommandEmitted: z.literal(false),
  status: z.literal("blocked_before_owner_command"),
  blockerCodes: z.tuple([
    z.literal("empty_profile_has_no_existing_authentication"),
    z.literal("protected_value_only_clone_missing"),
    z.literal("clone_would_import_unapproved_agent_context"),
    z.literal("native_port_not_configured"),
    z.literal("fresh_owner_authorization_missing"),
  ]),
  nativeAttemptsMade: z.literal(0),
  providerCallsMade: z.literal(0),
  protectedValuesAccessed: z.literal(false),
  automaticRetryAllowed: z.literal(false),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  readinessDigest: ideaDigestSchemaV1,
}).strict();

export type IdeaLabHermes021NativeLaunchReadinessV1 = z.infer<typeof readinessSchema>;

const material = {
  contractVersion: IDEA_LAB_HERMES_021_NATIVE_LAUNCH_READINESS_V1,
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  ownerPacketDigest: ideaLabOwnerReadyLivePacketV1.packetDigest,
  sourcePreflightDigest: IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1,
  profileSourceDigests: [{ pathId: "hermes_cli_profiles" as const,
    sha256: IDEA_LAB_HERMES_021_PROFILES_SOURCE_DIGEST_V1 },
  { pathId: "hermes_cli_profile_parser" as const,
    sha256: IDEA_LAB_HERMES_021_PROFILE_PARSER_SOURCE_DIGEST_V1 }] as const,
  observedProfileSemantics: {
    freshProfileSeedsEmptyProtectedValueFile: true as const,
    cloneCopiesProtectedValueFile: true as const,
    cloneCopiesSoulSkillsAndMemory: true as const,
    noSkillsCannotCombineWithClone: true as const,
    protectedValueOnlyCloneAvailable: false as const,
  },
  requiredBoundary: "disposable_empty_profile_with_existing_hermes_authentication" as const,
  profileIsolationEligible: false as const,
  ownerAuthorizationPresent: false as const,
  nativePortConfigured: false as const,
  ownerCommandEmitted: false as const,
  status: "blocked_before_owner_command" as const,
  blockerCodes: ["empty_profile_has_no_existing_authentication", "protected_value_only_clone_missing",
    "clone_would_import_unapproved_agent_context", "native_port_not_configured",
    "fresh_owner_authorization_missing"] as const,
  nativeAttemptsMade: 0 as const,
  providerCallsMade: 0 as const,
  protectedValuesAccessed: false as const,
  automaticRetryAllowed: false as const,
  grantsApproval: false as const,
  grantsCommandAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

export const ideaLabHermes021NativeLaunchReadinessV1: IdeaLabHermes021NativeLaunchReadinessV1 = Object.freeze(
  readinessSchema.parse({ ...material, readinessDigest: sha256Digest(material) }),
);

export function parseIdeaLabHermes021NativeLaunchReadinessV1(value: unknown):
  IdeaLabHermes021NativeLaunchReadinessV1 {
  const parsed = parseExactIdeaLabV1(readinessSchema, value);
  const unsigned = { ...parsed } as Record<string, unknown>;
  delete unsigned.readinessDigest;
  if (sha256Digest(unsigned) !== parsed.readinessDigest) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}
