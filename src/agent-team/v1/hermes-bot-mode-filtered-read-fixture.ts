import { sha256Digest } from "../../security";
import {
  buildHermesBotModeFilteredNativeRequestV1,
  hermesBotModeFilteredNativeRequestDigestV1,
} from "./hermes-bot-mode-filtered-read";
import {
  HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1,
  HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1,
  type HermesBotModeFilteredNativeBodyV1,
  type HermesBotModeFilteredSanitizationContextV1,
} from "./hermes-bot-mode-filtered-read-types";

export function buildHermesBotModeFilteredReadFixtureMaterialV1(): {
  body: HermesBotModeFilteredNativeBodyV1;
  contextInput: Omit<HermesBotModeFilteredSanitizationContextV1, "trustedIssuerKeyId" | "trustedIssuerPublicKeySpki">;
} {
  const profileSelectorDigest = sha256Digest({ fixture: "cr11a-team-060", profile: "architect" });
  const roomSelectorDigest = sha256Digest({ fixture: "cr11a-team-060", room: "build" });
  const nonceDigest = sha256Digest({ fixture: "cr11a-team-060", nonce: 1 });
  const request = buildHermesBotModeFilteredNativeRequestV1({ profileSelectorDigest, roomSelectorDigest, nonceDigest });
  const unsignedBody: Omit<HermesBotModeFilteredNativeBodyV1, "bodyDigest"> = {
    contractVersion: HERMES_BOT_MODE_FILTERED_NATIVE_CONTRACT_V1,
    method: HERMES_BOT_MODE_FILTERED_NATIVE_METHOD_V1,
    requestDigest: hermesBotModeFilteredNativeRequestDigestV1(request),
    profileSelectorDigest,
    roomSelectorDigest,
    nonceDigest,
    observedAt: "2026-08-30T20:00:00.000Z",
    issuedAt: "2026-08-30T20:00:01.000Z",
    expiresAt: "2026-08-30T20:01:01.000Z",
    profile: {
      profileKeyDigest: profileSelectorDigest,
      deviceKeyDigest: sha256Digest({ fixture: "cr11a-team-060", device: "mac-mini" }),
      displayName: "Architect",
      handle: "architect@fixture-device",
      role: "Control Room architect",
      deviceLabel: "Fixture Mac",
      platform: "macos",
      sourceState: "enabled",
      metadataRevision: 7,
    },
    room: {
      roomKeyDigest: roomSelectorDigest,
      label: "Build room",
      state: "open",
      memberProfileKeyDigests: [
        profileSelectorDigest,
        sha256Digest({ fixture: "cr11a-team-060", profile: "reviewer" }),
      ],
      metadataRevision: 11,
      messageCount: 3,
      lastActivityAt: "2026-08-30T19:59:59.000Z",
    },
    omissions: {
      messageText: true,
      rawPrompts: true,
      memory: true,
      soul: true,
      configuration: true,
      nativePaths: true,
      providerOrModel: true,
      sessions: true,
      credentials: true,
      mcpConfiguration: true,
    },
    providerCallObserved: false,
    writeObserved: false,
  };
  return {
    body: { ...unsignedBody, bodyDigest: sha256Digest(unsignedBody) },
    contextInput: {
      tenantId: "tenant.fixture",
      workspaceId: "workspace.fixture",
      projectId: "project.fixture.team-060",
      evaluatedAt: "2026-08-30T20:00:30.000Z",
      expectedRequestDigest: unsignedBody.requestDigest,
      expectedProfileSelectorDigest: profileSelectorDigest,
      expectedRoomSelectorDigest: roomSelectorDigest,
      expectedNonceDigest: nonceDigest,
      inputMode: "repository_fixture_only",
      nativeQualified: false,
    },
  };
}
