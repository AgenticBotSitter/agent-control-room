export const HERMES_BOT_MODE_NATIVE_QUALIFICATION_V1 = "control-room-hermes-bot-mode-native-qualification/v1" as const;
export const HERMES_BOT_MODE_NATIVE_QUALIFICATION_PACKET_V1 = "cr11a-team-050-native-read-v1" as const;

export const HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1 = Object.freeze({
  methodsProfiles: "sha256:3846fdf832e3abab7fb3d9b1eafba629da2fd96ff39f9471964490df1697dca4",
  desktopPlugin: "sha256:a7b55bc825e2e5da162b72c56506c4d0f79bf90c2fd3f3af845225e34105357d",
  profilesCli: "sha256:d2cd616cd80d8405dd756bf0a0f6f14dc0006e86a5cb7eb7498e8132d8941233",
} as const);

export type HermesBotModeNativeCandidateIdV1 = "profiles_list" | "profiles_describe" | "profile_yaml";
export type HermesBotModeNativeQualificationReasonV1 =
  | "official_list_overbroad"
  | "official_describe_full_content"
  | "direct_file_contains_room_text"
  | "device_identity_unproved"
  | "no_sanitization_before_content";

export interface HermesBotModeNativeQualificationInputV1 {
  contractVersion: typeof HERMES_BOT_MODE_NATIVE_QUALIFICATION_V1;
  packetId: typeof HERMES_BOT_MODE_NATIVE_QUALIFICATION_PACKET_V1;
  authorization: {
    authorized: true;
    scope: "one_profile_one_room_sanitized_read_only";
    maximumAttempts: 1;
    allowsRetry: false;
    providerCallsAllowed: 0;
    writesAllowed: 0;
    fullContentReadsAllowed: 0;
  };
  installedRuntime: {
    packageVersion: "0.20.6";
    revision: string;
    worktreeClean: true;
    sourceDigests: typeof HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1;
  };
}

export interface HermesBotModeNativeReadCandidateV1 {
  candidateId: HermesBotModeNativeCandidateIdV1;
  sourceReference: string;
  readKind: "official_rpc" | "direct_metadata_file";
  selectsOneProfile: boolean;
  selectsOneRoom: boolean;
  returnsOnlyMetadata: boolean;
  returnsNativePath: boolean;
  returnsModelOrProvider: boolean;
  returnsFullMessageText: boolean;
  readsSoul: boolean;
  readsMcpConfiguration: boolean;
  readOnlyOperation: boolean;
  providerFree: boolean;
  provesDeviceIdentity: boolean;
  sanitizesBeforeContentCrossesBoundary: boolean;
  eligible: false;
  rejectionReasons: HermesBotModeNativeQualificationReasonV1[];
}

export interface HermesBotModeNativeQualificationDispositionV1 {
  contractVersion: typeof HERMES_BOT_MODE_NATIVE_QUALIFICATION_V1;
  packetId: typeof HERMES_BOT_MODE_NATIVE_QUALIFICATION_PACKET_V1;
  status: "blocked_before_attempt";
  nativeQualified: false;
  eligibility: false;
  selectedCandidate: null;
  reasonCodes: HermesBotModeNativeQualificationReasonV1[];
  checks: {
    authorizationBound: true;
    exactPin: true;
    exactSourceDigests: true;
    worktreeClean: true;
    oneProfileScoped: false;
    oneRoomScoped: false;
    metadataOnly: false;
    sanitizesBeforeContentCrossesBoundary: false;
    readOnlyOperation: true;
    providerFree: true;
    deviceIdentityProved: false;
  };
  candidates: HermesBotModeNativeReadCandidateV1[];
  effects: {
    authorizedAttempts: 1;
    attemptsPerformed: 0;
    retriesPerformed: 0;
    hermesRuntimeContacts: 0;
    profileRecordsRead: 0;
    roomRecordsRead: 0;
    fullContentReads: 0;
    providerCalls: 0;
    writes: 0;
    messagesSent: 0;
    schedulesMutated: 0;
    commandsExecuted: 0;
    installations: 0;
    deployments: 0;
  };
  identity: {
    profileIdentityProved: false;
    deviceIdentityProved: false;
    profileKeyDigest: null;
    deviceKeyDigest: null;
  };
  cleanup: {
    temporaryProfileCreated: false;
    temporaryRoomCreated: false;
    temporaryFilesCreated: false;
    cleanupRequired: false;
  };
  inputDigest: string;
  qualificationDigest: string;
}
