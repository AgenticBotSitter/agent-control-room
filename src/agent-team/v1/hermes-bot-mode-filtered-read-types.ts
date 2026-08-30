import type { AgentPlatformV1 } from "./types";

export const HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1 = "hermes.control-room.filtered-read/v1" as const;
export const HERMES_BOT_MODE_FILTERED_BRIDGE_CONTRACT_V1 = "control-room-hermes-filtered-read-bridge/v1" as const;
export const HERMES_BOT_MODE_FILTERED_SAFE_RESULT_V1 = "control-room-hermes-filtered-safe-result/v1" as const;
export const HERMES_BOT_MODE_FILTERED_BRIDGE_ID_V1 = "bridge.hermes.bot-mode.filtered-read.v1" as const;
export const HERMES_BOT_MODE_FILTERED_BRIDGE_VERSION_V1 = "1.0.0" as const;
export const HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1 = "profiles.control_room_projection" as const;

export const HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1 = Object.freeze({
  maxProfiles: 1,
  maxRooms: 1,
  maxRoomMembers: 6,
  maxRoomMessagesReported: 10,
  maxMetadataRevision: 2_147_483_647,
  maxAttestationLifetimeSeconds: 60,
} as const);

export interface HermesBotModeFilteredReadManifestV1 {
  bridgeContract: typeof HERMES_BOT_MODE_FILTERED_BRIDGE_CONTRACT_V1;
  bridgeId: typeof HERMES_BOT_MODE_FILTERED_BRIDGE_ID_V1;
  bridgeVersion: typeof HERMES_BOT_MODE_FILTERED_BRIDGE_VERSION_V1;
  nativeContract: typeof HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1;
  safeResultContract: typeof HERMES_BOT_MODE_FILTERED_SAFE_RESULT_V1;
  nativeMethod: typeof HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1;
  requestSelectors: readonly ["profile_key_digest", "optional_room_key_digest", "nonce_digest"];
  responseShape: "one_profile_optional_one_room_metadata_only";
  acceptedHermesRevisions: readonly [];
  exactRuntimePinRequired: true;
  freshOwnerAuthorizationRequired: true;
  enabledByDefault: false;
  nativeQualified: false;
  allowedInputMode: "injected_signed_projection_only";
  supportedReads: readonly ["one_profile", "optional_one_room", "metadata_only", "signed_profile_device_identity"];
  prohibitedReads: readonly [
    "message_text",
    "raw_prompts",
    "memory",
    "soul",
    "configuration",
    "native_paths",
    "provider_or_model",
    "sessions",
    "credentials",
    "mcp_configuration",
  ];
  supportedWrites: readonly [];
  providerCalls: false;
  createsSchedules: false;
  createsWorkItems: false;
  dispatchesWork: false;
  grantsApproval: false;
  grantsLeaseAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
  resourceCeilings: typeof HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1;
  manifestDigest: string;
}

export interface HermesBotModeFilteredCompatibilityEvidenceV1 {
  bridgeContract: string;
  nativeContract: string;
  nativeMethod: string;
  runtimeRevision: string;
  inputMode: string;
  readCapabilities: string[];
  writeCapabilities: string[];
  returnsSignedProfileDeviceIdentity: boolean;
  returnsMessageText: boolean;
  returnsConfiguration: boolean;
  returnsNativePaths: boolean;
  returnsProviderOrModel: boolean;
  providerCalls: boolean;
}

export type HermesBotModeFilteredCompatibilityReasonV1 =
  | "invalid_evidence"
  | "bridge_contract_drift"
  | "native_contract_drift"
  | "method_drift"
  | "input_mode_drift"
  | "read_capability_drift"
  | "write_capability_present"
  | "identity_attestation_absent"
  | "prohibited_content_present"
  | "provider_call_present"
  | "no_accepted_runtime_pin";

export interface HermesBotModeFilteredCompatibilityDecisionV1 {
  compatible: false;
  reasons: HermesBotModeFilteredCompatibilityReasonV1[];
}

export interface HermesBotModeFilteredNativeRequestV1 {
  contractVersion: typeof HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1;
  method: typeof HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1;
  profileSelectorDigest: string;
  roomSelectorDigest: string | null;
  nonceDigest: string;
}

export interface HermesBotModeFilteredNativeProfileV1 {
  profileKeyDigest: string;
  deviceKeyDigest: string;
  displayName: string;
  handle: string;
  role: string;
  deviceLabel: string;
  platform: Exclude<AgentPlatformV1, "any">;
  sourceState: "enabled" | "disabled" | "unknown";
  metadataRevision: number;
}

export interface HermesBotModeFilteredNativeRoomV1 {
  roomKeyDigest: string;
  label: string;
  state: "open" | "paused" | "needs_owner" | "closed" | "unknown";
  memberProfileKeyDigests: string[];
  metadataRevision: number;
  messageCount: number;
  lastActivityAt?: string;
}

export interface HermesBotModeFilteredNativeBodyV1 {
  contractVersion: typeof HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1;
  method: typeof HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1;
  requestDigest: string;
  profileSelectorDigest: string;
  roomSelectorDigest: string | null;
  nonceDigest: string;
  observedAt: string;
  issuedAt: string;
  expiresAt: string;
  profile: HermesBotModeFilteredNativeProfileV1;
  room: HermesBotModeFilteredNativeRoomV1 | null;
  omissions: {
    messageText: true;
    rawPrompts: true;
    memory: true;
    soul: true;
    configuration: true;
    nativePaths: true;
    providerOrModel: true;
    sessions: true;
    credentials: true;
    mcpConfiguration: true;
  };
  providerCallObserved: false;
  writeObserved: false;
  bodyDigest: string;
}

export interface HermesBotModeFilteredNativeEnvelopeV1 {
  body: HermesBotModeFilteredNativeBodyV1;
  attestation: {
    algorithm: "ed25519";
    keyId: string;
    publicKeySpki: string;
    signature: string;
  };
}

export interface HermesBotModeFilteredSanitizationContextV1 {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  evaluatedAt: string;
  expectedRequestDigest: string;
  expectedProfileSelectorDigest: string;
  expectedRoomSelectorDigest: string | null;
  expectedNonceDigest: string;
  trustedIssuerKeyId: string;
  trustedIssuerPublicKeySpki: string;
  inputMode: "repository_fixture_only";
  nativeQualified: false;
}

export interface HermesBotModeFilteredSafeResultV1 {
  contractVersion: typeof HERMES_BOT_MODE_FILTERED_SAFE_RESULT_V1;
  bridgeId: typeof HERMES_BOT_MODE_FILTERED_BRIDGE_ID_V1;
  bridgeVersion: typeof HERMES_BOT_MODE_FILTERED_BRIDGE_VERSION_V1;
  sourceMode: "injected_signed_projection_only";
  tenantId: string;
  workspaceId: string;
  projectId: string;
  observedAt: string;
  evaluatedAt: string;
  requestDigest: string;
  issuerKeyDigest: string;
  identityEvidenceDigest: string;
  profile: HermesBotModeFilteredNativeProfileV1;
  room: HermesBotModeFilteredNativeRoomV1 | null;
  collectionTruth: { profiles: "observed"; rooms: "observed" | "absent" };
  metadataOnly: true;
  nativeQualified: false;
  retainsMessageText: false;
  retainsRawInputContent: false;
  retainsMemory: false;
  retainsConfiguration: false;
  retainsNativePaths: false;
  retainsProviderOrModel: false;
  retainsSessions: false;
  retainsUsableAccessData: false;
  retainsMcpConfiguration: false;
  providerCalls: false;
  writes: false;
  createsSchedules: false;
  createsWorkItems: false;
  dispatchesWork: false;
  grantsApproval: false;
  grantsLeaseAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
  projectionDigest: string;
}

export interface HermesBotModeFilteredReadBridgeV1 {
  manifest: HermesBotModeFilteredReadManifestV1;
  enabled: false;
  state: "disabled_pending_exact_pin_and_owner_authorization";
  evaluateCompatibility(evidence: unknown): HermesBotModeFilteredCompatibilityDecisionV1;
  sanitizeInjectedResult(envelope: unknown, context: unknown): HermesBotModeFilteredSafeResultV1;
}
