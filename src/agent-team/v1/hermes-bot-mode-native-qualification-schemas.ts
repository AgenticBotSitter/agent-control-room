import { z } from "zod";
import { HERMES_PINNED_REVISION_V1 } from "../../harness/hermes-v1";
import {
  HERMES_BOT_MODE_NATIVE_QUALIFICATION_PACKET_V1,
  HERMES_BOT_MODE_NATIVE_QUALIFICATION_V1,
  HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1,
} from "./hermes-bot-mode-native-qualification-types";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const reasonSchema = z.enum([
  "official_list_overbroad",
  "official_describe_full_content",
  "direct_file_contains_room_text",
  "device_identity_unproved",
  "no_sanitization_before_content",
]);

const sourceDigestsSchema = z.object({
  methodsProfiles: z.literal(HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1.methodsProfiles),
  desktopPlugin: z.literal(HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1.desktopPlugin),
  profilesCli: z.literal(HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1.profilesCli),
}).strict();

export const hermesBotModeNativeQualificationInputSchemaV1 = z.object({
  contractVersion: z.literal(HERMES_BOT_MODE_NATIVE_QUALIFICATION_V1),
  packetId: z.literal(HERMES_BOT_MODE_NATIVE_QUALIFICATION_PACKET_V1),
  authorization: z.object({
    authorized: z.literal(true),
    scope: z.literal("one_profile_one_room_sanitized_read_only"),
    maximumAttempts: z.literal(1),
    allowsRetry: z.literal(false),
    providerCallsAllowed: z.literal(0),
    writesAllowed: z.literal(0),
    fullContentReadsAllowed: z.literal(0),
  }).strict(),
  installedRuntime: z.object({
    packageVersion: z.literal("0.20.6"),
    revision: z.literal(HERMES_PINNED_REVISION_V1),
    worktreeClean: z.literal(true),
    sourceDigests: sourceDigestsSchema,
  }).strict(),
}).strict();

export const hermesBotModeNativeReadCandidateSchemaV1 = z.object({
  candidateId: z.enum(["profiles_list", "profiles_describe", "profile_yaml"]),
  sourceReference: z.string().min(1).max(160),
  readKind: z.enum(["official_rpc", "direct_metadata_file"]),
  selectsOneProfile: z.boolean(),
  selectsOneRoom: z.boolean(),
  returnsOnlyMetadata: z.boolean(),
  returnsNativePath: z.boolean(),
  returnsModelOrProvider: z.boolean(),
  returnsFullMessageText: z.boolean(),
  readsSoul: z.boolean(),
  readsMcpConfiguration: z.boolean(),
  readOnlyOperation: z.boolean(),
  providerFree: z.boolean(),
  provesDeviceIdentity: z.boolean(),
  sanitizesBeforeContentCrossesBoundary: z.boolean(),
  eligible: z.literal(false),
  rejectionReasons: z.array(reasonSchema).min(1).max(5),
}).strict();

export const hermesBotModeNativeQualificationDispositionSchemaV1 = z.object({
  contractVersion: z.literal(HERMES_BOT_MODE_NATIVE_QUALIFICATION_V1),
  packetId: z.literal(HERMES_BOT_MODE_NATIVE_QUALIFICATION_PACKET_V1),
  status: z.literal("blocked_before_attempt"),
  nativeQualified: z.literal(false),
  eligibility: z.literal(false),
  selectedCandidate: z.null(),
  reasonCodes: z.array(reasonSchema).length(5),
  checks: z.object({
    authorizationBound: z.literal(true),
    exactPin: z.literal(true),
    exactSourceDigests: z.literal(true),
    worktreeClean: z.literal(true),
    oneProfileScoped: z.literal(false),
    oneRoomScoped: z.literal(false),
    metadataOnly: z.literal(false),
    sanitizesBeforeContentCrossesBoundary: z.literal(false),
    readOnlyOperation: z.literal(true),
    providerFree: z.literal(true),
    deviceIdentityProved: z.literal(false),
  }).strict(),
  candidates: z.array(hermesBotModeNativeReadCandidateSchemaV1).length(3),
  effects: z.object({
    authorizedAttempts: z.literal(1),
    attemptsPerformed: z.literal(0),
    retriesPerformed: z.literal(0),
    hermesRuntimeContacts: z.literal(0),
    profileRecordsRead: z.literal(0),
    roomRecordsRead: z.literal(0),
    fullContentReads: z.literal(0),
    providerCalls: z.literal(0),
    writes: z.literal(0),
    messagesSent: z.literal(0),
    schedulesMutated: z.literal(0),
    commandsExecuted: z.literal(0),
    installations: z.literal(0),
    deployments: z.literal(0),
  }).strict(),
  identity: z.object({
    profileIdentityProved: z.literal(false),
    deviceIdentityProved: z.literal(false),
    profileKeyDigest: z.null(),
    deviceKeyDigest: z.null(),
  }).strict(),
  cleanup: z.object({
    temporaryProfileCreated: z.literal(false),
    temporaryRoomCreated: z.literal(false),
    temporaryFilesCreated: z.literal(false),
    cleanupRequired: z.literal(false),
  }).strict(),
  inputDigest: digestSchema,
  qualificationDigest: digestSchema,
}).strict();
