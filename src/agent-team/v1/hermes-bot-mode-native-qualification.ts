import { HERMES_PINNED_REVISION_V1 } from "../../harness/hermes-v1";
import { sha256Digest } from "../../security";
import { AgentTeamContractErrorV1 } from "./errors";
import { parseExactAgentTeamV1 } from "./exact";
import {
  hermesBotModeNativeQualificationDispositionSchemaV1,
  hermesBotModeNativeQualificationInputSchemaV1,
} from "./hermes-bot-mode-native-qualification-schemas";
import {
  HERMES_BOT_MODE_NATIVE_QUALIFICATION_PACKET_V1,
  HERMES_BOT_MODE_NATIVE_QUALIFICATION_V1,
  HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1,
  type HermesBotModeNativeQualificationDispositionV1,
  type HermesBotModeNativeQualificationInputV1,
  type HermesBotModeNativeReadCandidateV1,
} from "./hermes-bot-mode-native-qualification-types";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export const hermesBotModeNativeReadCandidatesV1: readonly HermesBotModeNativeReadCandidateV1[] = deepFreeze([
  {
    candidateId: "profiles_list",
    sourceReference: "tui_gateway/methods_profiles.py:22; apps/desktop/src/plugins/hermes-bots/plugin.js:1225",
    readKind: "official_rpc",
    selectsOneProfile: false,
    selectsOneRoom: false,
    returnsOnlyMetadata: false,
    returnsNativePath: true,
    returnsModelOrProvider: true,
    returnsFullMessageText: true,
    readsSoul: false,
    readsMcpConfiguration: false,
    readOnlyOperation: true,
    providerFree: true,
    provesDeviceIdentity: false,
    sanitizesBeforeContentCrossesBoundary: false,
    eligible: false,
    rejectionReasons: ["official_list_overbroad", "device_identity_unproved", "no_sanitization_before_content"],
  },
  {
    candidateId: "profiles_describe",
    sourceReference: "tui_gateway/methods_profiles.py:578",
    readKind: "official_rpc",
    selectsOneProfile: true,
    selectsOneRoom: false,
    returnsOnlyMetadata: false,
    returnsNativePath: false,
    returnsModelOrProvider: true,
    returnsFullMessageText: false,
    readsSoul: true,
    readsMcpConfiguration: true,
    readOnlyOperation: true,
    providerFree: true,
    provesDeviceIdentity: false,
    sanitizesBeforeContentCrossesBoundary: false,
    eligible: false,
    rejectionReasons: ["official_describe_full_content", "device_identity_unproved", "no_sanitization_before_content"],
  },
  {
    candidateId: "profile_yaml",
    sourceReference: "hermes_cli/profiles.py:877; apps/desktop/src/plugins/hermes-bots/plugin.js:635",
    readKind: "direct_metadata_file",
    selectsOneProfile: true,
    selectsOneRoom: false,
    returnsOnlyMetadata: false,
    returnsNativePath: false,
    returnsModelOrProvider: false,
    returnsFullMessageText: true,
    readsSoul: false,
    readsMcpConfiguration: false,
    readOnlyOperation: true,
    providerFree: true,
    provesDeviceIdentity: false,
    sanitizesBeforeContentCrossesBoundary: false,
    eligible: false,
    rejectionReasons: ["direct_file_contains_room_text", "device_identity_unproved", "no_sanitization_before_content"],
  },
]);

function unsignedDisposition(value: HermesBotModeNativeQualificationDispositionV1): Omit<HermesBotModeNativeQualificationDispositionV1, "qualificationDigest"> {
  const { qualificationDigest: _qualificationDigest, ...unsigned } = value;
  void _qualificationDigest;
  return unsigned;
}

export function buildHermesBotModeNativeQualificationDispositionV1(
  inputValue: unknown,
): HermesBotModeNativeQualificationDispositionV1 {
  const input = parseExactAgentTeamV1(
    hermesBotModeNativeQualificationInputSchemaV1,
    inputValue,
  ) as HermesBotModeNativeQualificationInputV1;
  const inputDigest = sha256Digest(input);
  const unsigned: Omit<HermesBotModeNativeQualificationDispositionV1, "qualificationDigest"> = {
    contractVersion: HERMES_BOT_MODE_NATIVE_QUALIFICATION_V1,
    packetId: HERMES_BOT_MODE_NATIVE_QUALIFICATION_PACKET_V1,
    status: "blocked_before_attempt",
    nativeQualified: false,
    eligibility: false,
    selectedCandidate: null,
    reasonCodes: [
      "official_list_overbroad",
      "official_describe_full_content",
      "direct_file_contains_room_text",
      "device_identity_unproved",
      "no_sanitization_before_content",
    ],
    checks: {
      authorizationBound: true,
      exactPin: true,
      exactSourceDigests: true,
      worktreeClean: input.installedRuntime.worktreeClean,
      oneProfileScoped: false,
      oneRoomScoped: false,
      metadataOnly: false,
      sanitizesBeforeContentCrossesBoundary: false,
      readOnlyOperation: true,
      providerFree: true,
      deviceIdentityProved: false,
    },
    candidates: structuredClone([...hermesBotModeNativeReadCandidatesV1]),
    effects: {
      authorizedAttempts: 1,
      attemptsPerformed: 0,
      retriesPerformed: 0,
      hermesRuntimeContacts: 0,
      profileRecordsRead: 0,
      roomRecordsRead: 0,
      fullContentReads: 0,
      providerCalls: 0,
      writes: 0,
      messagesSent: 0,
      schedulesMutated: 0,
      commandsExecuted: 0,
      installations: 0,
      deployments: 0,
    },
    identity: {
      profileIdentityProved: false,
      deviceIdentityProved: false,
      profileKeyDigest: null,
      deviceKeyDigest: null,
    },
    cleanup: {
      temporaryProfileCreated: false,
      temporaryRoomCreated: false,
      temporaryFilesCreated: false,
      cleanupRequired: false,
    },
    inputDigest,
  };
  return deepFreeze(parseExactAgentTeamV1(hermesBotModeNativeQualificationDispositionSchemaV1, {
    ...unsigned,
    qualificationDigest: sha256Digest(unsigned),
  }) as HermesBotModeNativeQualificationDispositionV1);
}

export function parseHermesBotModeNativeQualificationDispositionV1(
  value: unknown,
): HermesBotModeNativeQualificationDispositionV1 {
  const parsed = parseExactAgentTeamV1(
    hermesBotModeNativeQualificationDispositionSchemaV1,
    value,
  ) as HermesBotModeNativeQualificationDispositionV1;
  if (sha256Digest(unsignedDisposition(parsed)) !== parsed.qualificationDigest
    || parsed.candidates.map((candidate) => candidate.candidateId).join("|") !== "profiles_list|profiles_describe|profile_yaml"
    || JSON.stringify(parsed.candidates) !== JSON.stringify(hermesBotModeNativeReadCandidatesV1)) {
    throw new AgentTeamContractErrorV1("digest_mismatch");
  }
  return deepFreeze(parsed);
}

export const hermesBotModeNativeQualificationInputV1: HermesBotModeNativeQualificationInputV1 = deepFreeze({
  contractVersion: HERMES_BOT_MODE_NATIVE_QUALIFICATION_V1,
  packetId: HERMES_BOT_MODE_NATIVE_QUALIFICATION_PACKET_V1,
  authorization: {
    authorized: true,
    scope: "one_profile_one_room_sanitized_read_only",
    maximumAttempts: 1,
    allowsRetry: false,
    providerCallsAllowed: 0,
    writesAllowed: 0,
    fullContentReadsAllowed: 0,
  },
  installedRuntime: {
    packageVersion: "0.20.6",
    revision: HERMES_PINNED_REVISION_V1,
    worktreeClean: true,
    sourceDigests: HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1,
  },
});

export const hermesBotModeNativeQualificationDispositionV1 =
  buildHermesBotModeNativeQualificationDispositionV1(hermesBotModeNativeQualificationInputV1);
