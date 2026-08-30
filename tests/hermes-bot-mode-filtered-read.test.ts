import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AgentTeamContractErrorV1,
  buildHermesBotModeFilteredNativeRequestV1,
  buildHermesBotModeFilteredReadFixtureMaterialV1,
  evaluateHermesBotModeFilteredCompatibilityV1,
  hermesBotModeFilteredNativeRequestDigestV1,
  hermesBotModeFilteredReadBridgeV1,
  hermesBotModeFilteredReadManifestV1,
  parseHermesBotModeFilteredSafeResultV1,
  sanitizeHermesBotModeFilteredReadResultV1,
  type HermesBotModeFilteredNativeBodyV1,
  type HermesBotModeFilteredNativeEnvelopeV1,
  type HermesBotModeFilteredSafeResultV1,
  type HermesBotModeFilteredSanitizationContextV1,
} from "../src/agent-team/v1/index.ts";
import { canonicalJson, sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const issuer = generateKeyPairSync("ed25519");
const issuerKeyId = "hermes-device-key.fixture";
const issuerSpki = issuer.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

function clone<T>(value: T): T { return structuredClone(value); }

function unsignedBody(body: HermesBotModeFilteredNativeBodyV1): Omit<HermesBotModeFilteredNativeBodyV1, "bodyDigest"> {
  const { bodyDigest: _bodyDigest, ...unsigned } = body;
  void _bodyDigest;
  return unsigned;
}

function fixture(input: {
  mutateBody?: (body: HermesBotModeFilteredNativeBodyV1) => void;
  privateKey?: KeyObject;
  publicKeySpki?: string;
  keyId?: string;
  rehash?: boolean;
} = {}): { envelope: HermesBotModeFilteredNativeEnvelopeV1; context: HermesBotModeFilteredSanitizationContextV1 } {
  const material = buildHermesBotModeFilteredReadFixtureMaterialV1();
  const body = clone(material.body);
  input.mutateBody?.(body);
  if (input.rehash !== false) body.bodyDigest = sha256Digest(unsignedBody(body));
  const signingKey = input.privateKey ?? issuer.privateKey;
  const envelope: HermesBotModeFilteredNativeEnvelopeV1 = {
    body,
    attestation: {
      algorithm: "ed25519",
      keyId: input.keyId ?? issuerKeyId,
      publicKeySpki: input.publicKeySpki ?? issuerSpki,
      signature: sign(null, Buffer.from(canonicalJson(body)), signingKey).toString("base64url"),
    },
  };
  return {
    envelope,
    context: { ...material.contextInput, trustedIssuerKeyId: issuerKeyId, trustedIssuerPublicKeySpki: issuerSpki },
  };
}

function expectCode(action: () => unknown, code: AgentTeamContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) => error instanceof AgentTeamContractErrorV1 && error.safeCode === code);
}

function rehashResult(result: HermesBotModeFilteredSafeResultV1): HermesBotModeFilteredSafeResultV1 {
  const unsigned = { ...result } as Record<string, unknown>;
  delete unsigned.projectionDigest;
  return { ...result, projectionDigest: sha256Digest(unsigned) };
}

test("CR11A TEAM-060 freezes a disabled metadata-only bridge with no native reader", () => {
  assert.deepEqual({
    contract: hermesBotModeFilteredReadManifestV1.bridgeContract,
    bridge: hermesBotModeFilteredReadManifestV1.bridgeId,
    method: hermesBotModeFilteredReadManifestV1.nativeMethod,
    selectors: hermesBotModeFilteredReadManifestV1.requestSelectors,
    shape: hermesBotModeFilteredReadManifestV1.responseShape,
    pins: hermesBotModeFilteredReadManifestV1.acceptedHermesRevisions,
    enabled: hermesBotModeFilteredReadManifestV1.enabledByDefault,
    native: hermesBotModeFilteredReadManifestV1.nativeQualified,
    writes: hermesBotModeFilteredReadManifestV1.supportedWrites,
  }, {
    contract: "control-room-hermes-filtered-read-bridge/v1",
    bridge: "bridge.hermes.bot-mode.filtered-read.v1",
    method: "profiles.control_room_projection",
    selectors: ["profile_key_digest", "optional_room_key_digest", "nonce_digest"],
    shape: "one_profile_optional_one_room_metadata_only",
    pins: [], enabled: false, native: false, writes: [],
  });
  assert.deepEqual(Object.keys(hermesBotModeFilteredReadBridgeV1).sort(), [
    "enabled", "evaluateCompatibility", "manifest", "sanitizeInjectedResult", "state",
  ]);
  for (const forbidden of ["connect", "read", "readNative", "start", "send", "schedule", "approve", "dispatch", "execute", "write"]) {
    assert.equal(forbidden in hermesBotModeFilteredReadBridgeV1, false);
  }
  assert.equal(hermesBotModeFilteredReadBridgeV1.enabled, false);
  assert.equal(hermesBotModeFilteredReadBridgeV1.state, "disabled_pending_exact_pin_and_owner_authorization");
  assert.equal(Object.isFrozen(hermesBotModeFilteredReadManifestV1), true);
});

test("CR11A TEAM-060 compatibility always remains blocked until an exact runtime pin is accepted", () => {
  const exact = {
    bridgeContract: "control-room-hermes-filtered-read-bridge/v1",
    nativeContract: "hermes.control-room.filtered-read/v1",
    nativeMethod: "profiles.control_room_projection",
    runtimeRevision: "a".repeat(40),
    inputMode: "native_filtered_read",
    readCapabilities: ["one_profile", "optional_one_room", "metadata_only", "signed_profile_device_identity"],
    writeCapabilities: [],
    returnsSignedProfileDeviceIdentity: true,
    returnsMessageText: false,
    returnsConfiguration: false,
    returnsNativePaths: false,
    returnsProviderOrModel: false,
    providerCalls: false,
  };
  assert.deepEqual(evaluateHermesBotModeFilteredCompatibilityV1(exact), {
    compatible: false, reasons: ["no_accepted_runtime_pin"],
  });
  assert.equal(evaluateHermesBotModeFilteredCompatibilityV1({ ...exact, returnsMessageText: true }).reasons
    .includes("prohibited_content_present"), true);
  assert.equal(evaluateHermesBotModeFilteredCompatibilityV1({ ...exact, writeCapabilities: ["configure"] }).reasons
    .includes("write_capability_present"), true);
  assert.deepEqual(evaluateHermesBotModeFilteredCompatibilityV1({ ...exact, extra: true }), {
    compatible: false, reasons: ["invalid_evidence"],
  });
});

test("CR11A TEAM-060 request identity binds one profile, optional room, and one nonce", () => {
  const profileSelectorDigest = sha256Digest("profile-selector");
  const roomSelectorDigest = sha256Digest("room-selector");
  const nonceDigest = sha256Digest("nonce");
  const request = buildHermesBotModeFilteredNativeRequestV1({ profileSelectorDigest, roomSelectorDigest, nonceDigest });
  const replay = buildHermesBotModeFilteredNativeRequestV1({ profileSelectorDigest, roomSelectorDigest, nonceDigest });
  assert.deepEqual(replay, request);
  assert.equal(hermesBotModeFilteredNativeRequestDigestV1(replay), hermesBotModeFilteredNativeRequestDigestV1(request));
  const changed = buildHermesBotModeFilteredNativeRequestV1({
    profileSelectorDigest, roomSelectorDigest, nonceDigest: sha256Digest("different-nonce"),
  });
  assert.notEqual(hermesBotModeFilteredNativeRequestDigestV1(changed), hermesBotModeFilteredNativeRequestDigestV1(request));
  assert.equal(Object.isFrozen(request), true);
});

test("CR11A TEAM-060 verifies and sanitizes one signed profile plus one metadata-only room", () => {
  const { envelope, context } = fixture();
  const result = sanitizeHermesBotModeFilteredReadResultV1(envelope, context);
  assert.deepEqual(parseHermesBotModeFilteredSafeResultV1(result), result);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual({
    profile: result.profile.displayName,
    device: result.profile.deviceLabel,
    room: result.room?.label,
    members: result.room?.memberProfileKeyDigests.length,
    messages: result.room?.messageCount,
    truth: result.collectionTruth,
    metadata: result.metadataOnly,
    native: result.nativeQualified,
  }, {
    profile: "Architect", device: "Fixture Mac", room: "Build room", members: 2, messages: 3,
    truth: { profiles: "observed", rooms: "observed" }, metadata: true, native: false,
  });
  assert.match(result.issuerKeyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.identityEvidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(issuerSpki), false);
  assert.equal(JSON.stringify(result).includes(envelope.attestation.signature), false);
});

test("CR11A TEAM-060 accepts an explicitly absent room without inventing room truth", () => {
  const { envelope, context } = fixture({ mutateBody(body) {
    body.roomSelectorDigest = null;
    body.room = null;
    const request = buildHermesBotModeFilteredNativeRequestV1({
      profileSelectorDigest: body.profileSelectorDigest, roomSelectorDigest: null, nonceDigest: body.nonceDigest,
    });
    body.requestDigest = hermesBotModeFilteredNativeRequestDigestV1(request);
  } });
  context.expectedRoomSelectorDigest = null;
  context.expectedRequestDigest = envelope.body.requestDigest;
  const result = sanitizeHermesBotModeFilteredReadResultV1(envelope, context);
  assert.equal(result.room, null);
  assert.deepEqual(result.collectionTruth, { profiles: "observed", rooms: "absent" });
});

test("CR11A TEAM-060 rejects message, prompt, config, path, provider, session, and credential fields before use", () => {
  const unsafeKeys = [
    "messageText", "prompt", "memoryBody", "soulBody", "configurationBody", "nativePath",
    "provider", "model", "sessionId", "credential", "mcpServers",
  ];
  for (const key of unsafeKeys) {
    const { envelope, context } = fixture();
    (envelope.body as unknown as Record<string, unknown>)[key] = "unsafe";
    expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(envelope, context), "invalid_input");
  }
});

test("CR11A TEAM-060 rejects signature, issuer, digest, and signed-body substitution", () => {
  const badSignature = fixture(); badSignature.envelope.attestation.signature = "a".repeat(86);
  expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(badSignature.envelope, badSignature.context), "integrity_failed");
  const attacker = generateKeyPairSync("ed25519");
  const attackerSpki = attacker.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const foreign = fixture({ privateKey: attacker.privateKey, publicKeySpki: attackerSpki });
  expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(foreign.envelope, foreign.context), "integrity_failed");
  const digest = fixture({ rehash: false, mutateBody(body) { body.profile.displayName = "Changed"; } });
  expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(digest.envelope, digest.context), "integrity_failed");
  const issuerId = fixture({ keyId: "hermes-device-key.substituted" });
  expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(issuerId.envelope, issuerId.context), "integrity_failed");
});

test("CR11A TEAM-060 rejects request, selector, nonce, profile, and room scope drift", () => {
  const cases: Array<(input: ReturnType<typeof fixture>) => void> = [
    ({ context }) => { context.expectedRequestDigest = sha256Digest("foreign-request"); },
    ({ context }) => { context.expectedProfileSelectorDigest = sha256Digest("foreign-profile"); },
    ({ context }) => { context.expectedRoomSelectorDigest = sha256Digest("foreign-room"); },
    ({ context }) => { context.expectedNonceDigest = sha256Digest("foreign-nonce"); },
    ({ envelope }) => { envelope.body.profile.profileKeyDigest = sha256Digest("substituted-profile"); },
    ({ envelope }) => { envelope.body.room!.roomKeyDigest = sha256Digest("substituted-room"); },
  ];
  for (const mutate of cases) {
    const input = fixture(); mutate(input);
    expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(input.envelope, input.context),
      mutate === cases[4] || mutate === cases[5] ? "integrity_failed" : "scope_mismatch");
  }
});

test("CR11A TEAM-060 rejects stale, overlong, future, and incoherent identity or room evidence", () => {
  const cases: Array<[ReturnType<typeof fixture>, AgentTeamContractErrorV1["safeCode"]]> = [
    [fixture({ mutateBody(body) { body.expiresAt = "2026-08-30T20:00:20.000Z"; } }), "integrity_failed"],
    [fixture({ mutateBody(body) { body.expiresAt = "2026-08-30T20:01:02.000Z"; } }), "integrity_failed"],
    [fixture({ mutateBody(body) { body.observedAt = "2026-08-30T20:00:02.000Z"; } }), "integrity_failed"],
    [fixture({ mutateBody(body) { body.profile.deviceKeyDigest = body.profile.profileKeyDigest; } }), "integrity_failed"],
    [fixture({ mutateBody(body) { body.room!.memberProfileKeyDigests = [body.profile.profileKeyDigest, body.profile.profileKeyDigest]; } }), "scope_mismatch"],
    [fixture({ mutateBody(body) { body.room!.memberProfileKeyDigests = [sha256Digest("one"), sha256Digest("two")]; } }), "scope_mismatch"],
    [fixture({ mutateBody(body) { body.room!.lastActivityAt = "2026-08-30T20:00:01.000Z"; } }), "scope_mismatch"],
  ];
  for (const [input, code] of cases) {
    expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(input.envelope, input.context), code);
  }
});

test("CR11A TEAM-060 exact boundaries reject accessors and Proxies without running behavior", () => {
  const input = fixture();
  let getterCalls = 0;
  Object.defineProperty(input.envelope, "body", { enumerable: true, get() { getterCalls += 1; return input.envelope.body; } });
  expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(input.envelope, input.context), "invalid_input");
  assert.equal(getterCalls, 0);
  const proxiedEnvelope = observedProxy(fixture().envelope, "transparent");
  expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(proxiedEnvelope.value, fixture().context), "invalid_input");
  assert.equal(proxiedEnvelope.trapCount(), 0);
  const proxiedContext = observedProxy(fixture().context, "transparent");
  expectCode(() => sanitizeHermesBotModeFilteredReadResultV1(fixture().envelope, proxiedContext.value), "invalid_input");
  assert.equal(proxiedContext.trapCount(), 0);
});

test("CR11A TEAM-060 safe output is digest-bound and rejects re-signed authority or identity drift", () => {
  const input = fixture();
  const result = sanitizeHermesBotModeFilteredReadResultV1(input.envelope, input.context);
  const authority = clone(result);
  (authority as unknown as Record<string, unknown>).writes = true;
  expectCode(() => parseHermesBotModeFilteredSafeResultV1(rehashResult(authority)), "invalid_input");
  const identity = clone(result); identity.profile.deviceKeyDigest = sha256Digest("different-device");
  expectCode(() => parseHermesBotModeFilteredSafeResultV1(rehashResult(identity)), "digest_mismatch");
  const roomTruth = clone(result); roomTruth.collectionTruth.rooms = "absent";
  expectCode(() => parseHermesBotModeFilteredSafeResultV1(rehashResult(roomTruth)), "digest_mismatch");
  const rawTamper = clone(result); rawTamper.profile.role = "Changed without digest";
  expectCode(() => parseHermesBotModeFilteredSafeResultV1(rawTamper), "digest_mismatch");
});

test("CR11A TEAM-060 implementation contains no native, filesystem, network, provider, or effect client", () => {
  const source = readFileSync(new URL("../src/agent-team/v1/hermes-bot-mode-filtered-read.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "node:fs", "node:net", "node:http", "node:https", "node:child_process", "fetch(", "WebSocket",
    "profiles.list", "profiles.describe", "profile.yaml", "profiles.configure", "providerClient", "dispatch(",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
