import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { assertNoSecretMaterial, canonicalJson, sha256Digest } from "../../security";
import { AgentTeamContractErrorV1 } from "./errors";
import { exactAgentTeamJsonV1, parseExactAgentTeamV1 } from "./exact";
import {
  HERMES_BOT_MODE_FILTERED_EXACT_CONTRACTS_V1,
  HERMES_BOT_MODE_FILTERED_EXPECTED_CAPABILITIES_V1,
  hermesBotModeFilteredCompatibilityEvidenceSchemaV1,
  hermesBotModeFilteredNativeEnvelopeSchemaV1,
  hermesBotModeFilteredNativeRequestSchemaV1,
  hermesBotModeFilteredSafeResultSchemaV1,
  hermesBotModeFilteredSanitizationContextSchemaV1,
} from "./hermes-bot-mode-filtered-read-schemas";
import {
  HERMES_BOT_MODE_FILTERED_BRIDGE_CONTRACT_V1,
  HERMES_BOT_MODE_FILTERED_BRIDGE_ID_V1,
  HERMES_BOT_MODE_FILTERED_BRIDGE_VERSION_V1,
  HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1,
  HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1,
  HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1,
  HERMES_BOT_MODE_FILTERED_SAFE_RESULT_V1,
  type HermesBotModeFilteredCompatibilityDecisionV1,
  type HermesBotModeFilteredCompatibilityEvidenceV1,
  type HermesBotModeFilteredNativeBodyV1,
  type HermesBotModeFilteredNativeEnvelopeV1,
  type HermesBotModeFilteredNativeRequestV1,
  type HermesBotModeFilteredReadBridgeV1,
  type HermesBotModeFilteredReadManifestV1,
  type HermesBotModeFilteredSafeResultV1,
  type HermesBotModeFilteredSanitizationContextV1,
} from "./hermes-bot-mode-filtered-read-types";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function parseNativeEnvelope<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  let parsed: T;
  try {
    parsed = schema.parse(exactAgentTeamJsonV1(value));
  } catch (error) {
    if (error instanceof AgentTeamContractErrorV1) throw error;
    throw new AgentTeamContractErrorV1("invalid_input");
  }
  try { assertNoSecretMaterial(parsed, "Hermes filtered native envelope"); }
  catch { throw new AgentTeamContractErrorV1("redaction_rejected"); }
  return parsed;
}

const unsignedManifest: Omit<HermesBotModeFilteredReadManifestV1, "manifestDigest"> = {
  bridgeContract: HERMES_BOT_MODE_FILTERED_BRIDGE_CONTRACT_V1,
  bridgeId: HERMES_BOT_MODE_FILTERED_BRIDGE_ID_V1,
  bridgeVersion: HERMES_BOT_MODE_FILTERED_BRIDGE_VERSION_V1,
  nativeContract: HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1,
  safeResultContract: HERMES_BOT_MODE_FILTERED_SAFE_RESULT_V1,
  nativeMethod: HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1,
  requestSelectors: ["profile_key_digest", "optional_room_key_digest", "nonce_digest"],
  responseShape: "one_profile_optional_one_room_metadata_only",
  acceptedHermesRevisions: [],
  exactRuntimePinRequired: true,
  freshOwnerAuthorizationRequired: true,
  enabledByDefault: false,
  nativeQualified: false,
  allowedInputMode: "injected_signed_projection_only",
  supportedReads: HERMES_BOT_MODE_FILTERED_EXPECTED_CAPABILITIES_V1,
  prohibitedReads: [
    "message_text", "raw_prompts", "memory", "soul", "configuration", "native_paths",
    "provider_or_model", "sessions", "credentials", "mcp_configuration",
  ],
  supportedWrites: [],
  providerCalls: false,
  createsSchedules: false,
  createsWorkItems: false,
  dispatchesWork: false,
  grantsApproval: false,
  grantsLeaseAuthority: false,
  grantsCommandAuthority: false,
  grantsExecutionAuthority: false,
  resourceCeilings: HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1,
};

export const hermesBotModeFilteredReadManifestV1: HermesBotModeFilteredReadManifestV1 = deepFreeze({
  ...unsignedManifest,
  manifestDigest: sha256Digest(unsignedManifest),
});

function sameOrderedStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function evaluateHermesBotModeFilteredCompatibilityV1(evidenceValue: unknown): HermesBotModeFilteredCompatibilityDecisionV1 {
  let evidence: HermesBotModeFilteredCompatibilityEvidenceV1;
  try {
    evidence = parseExactAgentTeamV1(
      hermesBotModeFilteredCompatibilityEvidenceSchemaV1,
      evidenceValue,
    ) as HermesBotModeFilteredCompatibilityEvidenceV1;
  } catch {
    return deepFreeze({ compatible: false, reasons: ["invalid_evidence"] });
  }
  const reasons: HermesBotModeFilteredCompatibilityDecisionV1["reasons"] = [];
  if (evidence.bridgeContract !== HERMES_BOT_MODE_FILTERED_EXACT_CONTRACTS_V1.bridgeContract) reasons.push("bridge_contract_drift");
  if (evidence.nativeContract !== HERMES_BOT_MODE_FILTERED_EXACT_CONTRACTS_V1.nativeContract) reasons.push("native_contract_drift");
  if (evidence.nativeMethod !== HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1) reasons.push("method_drift");
  if (evidence.inputMode !== "native_filtered_read") reasons.push("input_mode_drift");
  if (!sameOrderedStrings(evidence.readCapabilities, HERMES_BOT_MODE_FILTERED_EXPECTED_CAPABILITIES_V1)) {
    reasons.push("read_capability_drift");
  }
  if (evidence.writeCapabilities.length !== 0) reasons.push("write_capability_present");
  if (!evidence.returnsSignedProfileDeviceIdentity) reasons.push("identity_attestation_absent");
  if (evidence.returnsMessageText || evidence.returnsConfiguration || evidence.returnsNativePaths
    || evidence.returnsProviderOrModel) reasons.push("prohibited_content_present");
  if (evidence.providerCalls) reasons.push("provider_call_present");
  if (!hermesBotModeFilteredReadManifestV1.acceptedHermesRevisions.includes(evidence.runtimeRevision as never)) {
    reasons.push("no_accepted_runtime_pin");
  }
  return deepFreeze({ compatible: false, reasons });
}

export function buildHermesBotModeFilteredNativeRequestV1(input: {
  profileSelectorDigest: string;
  roomSelectorDigest: string | null;
  nonceDigest: string;
}): HermesBotModeFilteredNativeRequestV1 {
  return deepFreeze(parseExactAgentTeamV1(hermesBotModeFilteredNativeRequestSchemaV1, {
    contractVersion: HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1,
    method: HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1,
    ...input,
  }) as HermesBotModeFilteredNativeRequestV1);
}

export function hermesBotModeFilteredNativeRequestDigestV1(requestValue: unknown): string {
  const request = parseExactAgentTeamV1(
    hermesBotModeFilteredNativeRequestSchemaV1,
    requestValue,
  ) as HermesBotModeFilteredNativeRequestV1;
  return sha256Digest(request);
}

function unsignedNativeBody(body: HermesBotModeFilteredNativeBodyV1): Omit<HermesBotModeFilteredNativeBodyV1, "bodyDigest"> {
  const { bodyDigest: _bodyDigest, ...unsigned } = body;
  void _bodyDigest;
  return unsigned;
}

function unsignedSafeResult(result: HermesBotModeFilteredSafeResultV1): Omit<HermesBotModeFilteredSafeResultV1, "projectionDigest"> {
  const { projectionDigest: _projectionDigest, ...unsigned } = result;
  void _projectionDigest;
  return unsigned;
}

function identityEvidenceDigest(input: Pick<HermesBotModeFilteredSafeResultV1,
  "bridgeId" | "requestDigest" | "issuerKeyDigest" | "observedAt" | "profile"
>): string {
  return sha256Digest({
    bridgeId: input.bridgeId,
    requestDigest: input.requestDigest,
    issuerKeyDigest: input.issuerKeyDigest,
    observedAt: input.observedAt,
    profileKeyDigest: input.profile.profileKeyDigest,
    deviceKeyDigest: input.profile.deviceKeyDigest,
  });
}

function canonicalEd25519Key(spki: string): { key: KeyObject; digest: string } {
  try {
    const supplied = Buffer.from(spki, "base64url");
    const key = createPublicKey({ key: supplied, format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || !Buffer.isBuffer(canonical) || !supplied.equals(canonical)
      || spki !== canonical.toString("base64url")) throw new Error("invalid");
    return { key, digest: `sha256:${createHash("sha256").update(canonical).digest("hex")}` };
  } catch {
    throw new AgentTeamContractErrorV1("integrity_failed");
  }
}

function sameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8"), rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validateBindings(
  envelope: HermesBotModeFilteredNativeEnvelopeV1,
  context: HermesBotModeFilteredSanitizationContextV1,
): { issuerKeyDigest: string } {
  const { body, attestation } = envelope;
  if (!sameText(attestation.keyId, context.trustedIssuerKeyId)
    || !sameText(attestation.publicKeySpki, context.trustedIssuerPublicKeySpki)) {
    throw new AgentTeamContractErrorV1("integrity_failed");
  }
  const issuer = canonicalEd25519Key(attestation.publicKeySpki);
  let signatureValid = false;
  try {
    signatureValid = verify(null, Buffer.from(canonicalJson(body)), issuer.key, Buffer.from(attestation.signature, "base64url"));
  } catch { signatureValid = false; }
  if (!signatureValid || sha256Digest(unsignedNativeBody(body)) !== body.bodyDigest) {
    throw new AgentTeamContractErrorV1("integrity_failed");
  }
  if (body.requestDigest !== context.expectedRequestDigest
    || body.profileSelectorDigest !== context.expectedProfileSelectorDigest
    || body.roomSelectorDigest !== context.expectedRoomSelectorDigest
    || body.nonceDigest !== context.expectedNonceDigest
    || body.profile.profileKeyDigest !== context.expectedProfileSelectorDigest
    || (body.room ? body.room.roomKeyDigest : null) !== context.expectedRoomSelectorDigest) {
    throw new AgentTeamContractErrorV1("scope_mismatch");
  }
  const request = buildHermesBotModeFilteredNativeRequestV1({
    profileSelectorDigest: body.profileSelectorDigest,
    roomSelectorDigest: body.roomSelectorDigest,
    nonceDigest: body.nonceDigest,
  });
  if (hermesBotModeFilteredNativeRequestDigestV1(request) !== body.requestDigest) {
    throw new AgentTeamContractErrorV1("digest_mismatch");
  }
  const observed = Date.parse(body.observedAt), issued = Date.parse(body.issuedAt);
  const expires = Date.parse(body.expiresAt), evaluated = Date.parse(context.evaluatedAt);
  if (![observed, issued, expires, evaluated].every(Number.isFinite)
    || observed > issued || issued > evaluated || expires <= evaluated || expires <= issued
    || expires - issued > HERMES_BOT_MODE_FILTERED_RESOURCE_CEILINGS_V1.maxAttestationLifetimeSeconds * 1_000) {
    throw new AgentTeamContractErrorV1("integrity_failed");
  }
  if (body.room) {
    if (new Set(body.room.memberProfileKeyDigests).size !== body.room.memberProfileKeyDigests.length
      || !body.room.memberProfileKeyDigests.includes(body.profile.profileKeyDigest)
      || (body.room.lastActivityAt && Date.parse(body.room.lastActivityAt) > observed)) {
      throw new AgentTeamContractErrorV1("scope_mismatch");
    }
  }
  if (body.profile.profileKeyDigest === body.profile.deviceKeyDigest) {
    throw new AgentTeamContractErrorV1("integrity_failed");
  }
  return { issuerKeyDigest: issuer.digest };
}

export function sanitizeHermesBotModeFilteredReadResultV1(
  envelopeValue: unknown,
  contextValue: unknown,
): HermesBotModeFilteredSafeResultV1 {
  const envelope = parseNativeEnvelope(
    hermesBotModeFilteredNativeEnvelopeSchemaV1,
    envelopeValue,
  ) as HermesBotModeFilteredNativeEnvelopeV1;
  const context = parseExactAgentTeamV1(
    hermesBotModeFilteredSanitizationContextSchemaV1,
    contextValue,
  ) as HermesBotModeFilteredSanitizationContextV1;
  const { issuerKeyDigest } = validateBindings(envelope, context);
  const unsigned: Omit<HermesBotModeFilteredSafeResultV1, "projectionDigest"> = {
    contractVersion: HERMES_BOT_MODE_FILTERED_SAFE_RESULT_V1,
    bridgeId: HERMES_BOT_MODE_FILTERED_BRIDGE_ID_V1,
    bridgeVersion: HERMES_BOT_MODE_FILTERED_BRIDGE_VERSION_V1,
    sourceMode: "injected_signed_projection_only",
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    observedAt: envelope.body.observedAt,
    evaluatedAt: context.evaluatedAt,
    requestDigest: envelope.body.requestDigest,
    issuerKeyDigest,
    identityEvidenceDigest: identityEvidenceDigest({
      bridgeId: HERMES_BOT_MODE_FILTERED_BRIDGE_ID_V1,
      requestDigest: envelope.body.requestDigest,
      issuerKeyDigest,
      observedAt: envelope.body.observedAt,
      profile: envelope.body.profile,
    }),
    profile: envelope.body.profile,
    room: envelope.body.room,
    collectionTruth: { profiles: "observed", rooms: envelope.body.room ? "observed" : "absent" },
    metadataOnly: true,
    nativeQualified: false,
    retainsMessageText: false,
    retainsRawInputContent: false,
    retainsMemory: false,
    retainsConfiguration: false,
    retainsNativePaths: false,
    retainsProviderOrModel: false,
    retainsSessions: false,
    retainsUsableAccessData: false,
    retainsMcpConfiguration: false,
    providerCalls: false,
    writes: false,
    createsSchedules: false,
    createsWorkItems: false,
    dispatchesWork: false,
    grantsApproval: false,
    grantsLeaseAuthority: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  };
  return deepFreeze(parseExactAgentTeamV1(hermesBotModeFilteredSafeResultSchemaV1, {
    ...unsigned,
    projectionDigest: sha256Digest(unsigned),
  }) as HermesBotModeFilteredSafeResultV1);
}

export function parseHermesBotModeFilteredSafeResultV1(value: unknown): HermesBotModeFilteredSafeResultV1 {
  const parsed = parseExactAgentTeamV1(
    hermesBotModeFilteredSafeResultSchemaV1,
    value,
  ) as HermesBotModeFilteredSafeResultV1;
  if (sha256Digest(unsignedSafeResult(parsed)) !== parsed.projectionDigest
    || identityEvidenceDigest(parsed) !== parsed.identityEvidenceDigest
    || parsed.collectionTruth.rooms !== (parsed.room ? "observed" : "absent")
    || (parsed.room && !parsed.room.memberProfileKeyDigests.includes(parsed.profile.profileKeyDigest))) {
    throw new AgentTeamContractErrorV1("digest_mismatch");
  }
  return deepFreeze(parsed);
}

export const hermesBotModeFilteredReadBridgeV1: HermesBotModeFilteredReadBridgeV1 = Object.freeze({
  manifest: hermesBotModeFilteredReadManifestV1,
  enabled: false,
  state: "disabled_pending_exact_pin_and_owner_authorization",
  evaluateCompatibility: evaluateHermesBotModeFilteredCompatibilityV1,
  sanitizeInjectedResult: sanitizeHermesBotModeFilteredReadResultV1,
});
