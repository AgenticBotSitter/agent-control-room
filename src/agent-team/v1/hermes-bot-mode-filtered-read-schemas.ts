import { z } from "zod";
import {
  agentTeamDigestSchemaV1,
  agentTeamLabelSchemaV1,
  agentTeamPlatformSchemaV1,
  agentTeamSafeCodeSchemaV1,
  agentTeamSafeIdSchemaV1,
  agentTeamTimeSchemaV1,
} from "./schemas";
import {
  HERMES_BOT_MODE_FILTERED_BRIDGE_CONTRACT_V1,
  HERMES_BOT_MODE_FILTERED_BRIDGE_ID_V1,
  HERMES_BOT_MODE_FILTERED_BRIDGE_VERSION_V1,
  HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1,
  HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1,
  HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1,
  HERMES_BOT_MODE_FILTERED_SAFE_RESULT_V1,
} from "./hermes-bot-mode-filtered-read-types";

const base64urlSchema = z.string().min(40).max(256).regex(/^[A-Za-z0-9_-]+$/);
const roomSelectorSchema = agentTeamDigestSchemaV1.nullable();

export const hermesBotModeFilteredCompatibilityEvidenceSchemaV1 = z.object({
  bridgeContract: z.string().min(1).max(160),
  nativeContract: z.string().min(1).max(160),
  nativeMethod: z.string().min(1).max(160),
  runtimeRevision: z.string().regex(/^[a-f0-9]{40}$/),
  inputMode: agentTeamSafeCodeSchemaV1,
  readCapabilities: z.array(agentTeamSafeCodeSchemaV1).max(12),
  writeCapabilities: z.array(agentTeamSafeCodeSchemaV1).max(12),
  returnsSignedProfileDeviceIdentity: z.boolean(),
  returnsMessageText: z.boolean(),
  returnsConfiguration: z.boolean(),
  returnsNativePaths: z.boolean(),
  returnsProviderOrModel: z.boolean(),
  providerCalls: z.boolean(),
}).strict();

export const hermesBotModeFilteredNativeRequestSchemaV1 = z.object({
  contractVersion: z.literal(HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1),
  method: z.literal(HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1),
  profileSelectorDigest: agentTeamDigestSchemaV1,
  roomSelectorDigest: roomSelectorSchema,
  nonceDigest: agentTeamDigestSchemaV1,
}).strict();

export const hermesBotModeFilteredNativeProfileSchemaV1 = z.object({
  profileKeyDigest: agentTeamDigestSchemaV1,
  deviceKeyDigest: agentTeamDigestSchemaV1,
  displayName: agentTeamLabelSchemaV1,
  handle: agentTeamSafeIdSchemaV1,
  role: agentTeamLabelSchemaV1,
  deviceLabel: agentTeamLabelSchemaV1,
  platform: agentTeamPlatformSchemaV1.exclude(["any"]),
  sourceState: z.enum(["enabled", "disabled", "unknown"]),
  metadataRevision: z.number().int().min(0).max(HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1.maxMetadataRevision),
}).strict();

export const hermesBotModeFilteredNativeRoomSchemaV1 = z.object({
  roomKeyDigest: agentTeamDigestSchemaV1,
  label: agentTeamLabelSchemaV1,
  state: z.enum(["open", "paused", "needs_owner", "closed", "unknown"]),
  memberProfileKeyDigests: z.array(agentTeamDigestSchemaV1)
    .min(2).max(HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1.maxRoomMembers),
  metadataRevision: z.number().int().min(0).max(HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1.maxMetadataRevision),
  messageCount: z.number().int().min(0).max(HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1.maxRoomMessagesReported),
  lastActivityAt: agentTeamTimeSchemaV1.optional(),
}).strict();

const omissionsSchema = z.object({
  messageText: z.literal(true),
  rawPrompts: z.literal(true),
  memory: z.literal(true),
  soul: z.literal(true),
  configuration: z.literal(true),
  nativePaths: z.literal(true),
  providerOrModel: z.literal(true),
  sessions: z.literal(true),
  credentials: z.literal(true),
  mcpConfiguration: z.literal(true),
}).strict();

export const hermesBotModeFilteredNativeBodySchemaV1 = z.object({
  contractVersion: z.literal(HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1),
  method: z.literal(HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1),
  requestDigest: agentTeamDigestSchemaV1,
  profileSelectorDigest: agentTeamDigestSchemaV1,
  roomSelectorDigest: roomSelectorSchema,
  nonceDigest: agentTeamDigestSchemaV1,
  observedAt: agentTeamTimeSchemaV1,
  issuedAt: agentTeamTimeSchemaV1,
  expiresAt: agentTeamTimeSchemaV1,
  profile: hermesBotModeFilteredNativeProfileSchemaV1,
  room: hermesBotModeFilteredNativeRoomSchemaV1.nullable(),
  omissions: omissionsSchema,
  providerCallObserved: z.literal(false),
  writeObserved: z.literal(false),
  bodyDigest: agentTeamDigestSchemaV1,
}).strict();

export const hermesBotModeFilteredNativeEnvelopeSchemaV1 = z.object({
  body: hermesBotModeFilteredNativeBodySchemaV1,
  attestation: z.object({
    algorithm: z.literal("ed25519"),
    keyId: agentTeamSafeIdSchemaV1,
    publicKeySpki: base64urlSchema,
    signature: base64urlSchema,
  }).strict(),
}).strict();

export const hermesBotModeFilteredSanitizationContextSchemaV1 = z.object({
  tenantId: agentTeamSafeIdSchemaV1,
  workspaceId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  evaluatedAt: agentTeamTimeSchemaV1,
  expectedRequestDigest: agentTeamDigestSchemaV1,
  expectedProfileSelectorDigest: agentTeamDigestSchemaV1,
  expectedRoomSelectorDigest: roomSelectorSchema,
  expectedNonceDigest: agentTeamDigestSchemaV1,
  trustedIssuerKeyId: agentTeamSafeIdSchemaV1,
  trustedIssuerPublicKeySpki: base64urlSchema,
  inputMode: z.literal("repository_fixture_only"),
  nativeQualified: z.literal(false),
}).strict();

export const hermesBotModeFilteredSafeResultSchemaV1 = z.object({
  contractVersion: z.literal(HERMES_BOT_MODE_FILTERED_SAFE_RESULT_V1),
  bridgeId: z.literal(HERMES_BOT_MODE_FILTERED_BRIDGE_ID_V1),
  bridgeVersion: z.literal(HERMES_BOT_MODE_FILTERED_BRIDGE_VERSION_V1),
  sourceMode: z.literal("injected_signed_projection_only"),
  tenantId: agentTeamSafeIdSchemaV1,
  workspaceId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  observedAt: agentTeamTimeSchemaV1,
  evaluatedAt: agentTeamTimeSchemaV1,
  requestDigest: agentTeamDigestSchemaV1,
  issuerKeyDigest: agentTeamDigestSchemaV1,
  identityEvidenceDigest: agentTeamDigestSchemaV1,
  profile: hermesBotModeFilteredNativeProfileSchemaV1,
  room: hermesBotModeFilteredNativeRoomSchemaV1.nullable(),
  collectionTruth: z.object({ profiles: z.literal("observed"), rooms: z.enum(["observed", "absent"]) }).strict(),
  metadataOnly: z.literal(true),
  nativeQualified: z.literal(false),
  retainsMessageText: z.literal(false),
  retainsRawInputContent: z.literal(false),
  retainsMemory: z.literal(false),
  retainsConfiguration: z.literal(false),
  retainsNativePaths: z.literal(false),
  retainsProviderOrModel: z.literal(false),
  retainsSessions: z.literal(false),
  retainsUsableAccessData: z.literal(false),
  retainsMcpConfiguration: z.literal(false),
  providerCalls: z.literal(false),
  writes: z.literal(false),
  createsSchedules: z.literal(false),
  createsWorkItems: z.literal(false),
  dispatchesWork: z.literal(false),
  grantsApproval: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  projectionDigest: agentTeamDigestSchemaV1,
}).strict();

export const HERMES_BOT_MODE_FILTERED_EXPECTED_CAPABILITIES_V1 = Object.freeze([
  "one_profile",
  "optional_one_room",
  "metadata_only",
  "signed_profile_device_identity",
] as const);

export const HERMES_BOT_MODE_FILTERED_EXACT_CONTRACTS_V1 = Object.freeze({
  bridgeContract: HERMES_BOT_MODE_FILTERED_BRIDGE_CONTRACT_V1,
  nativeContract: HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1,
});
