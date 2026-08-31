import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentTeamContractErrorV1,
  buildHermesBotModeNativeQualificationDispositionV1,
  HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1,
  hermesBotModeNativeQualificationDispositionV1,
  hermesBotModeNativeQualificationInputV1,
  hermesBotModeNativeReadCandidatesV1,
  parseHermesBotModeNativeQualificationDispositionV1,
  type HermesBotModeNativeQualificationDispositionV1,
} from "../src/agent-team/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

function cloneInput(): Record<string, unknown> {
  return structuredClone(hermesBotModeNativeQualificationInputV1) as unknown as Record<string, unknown>;
}

function expectCode(action: () => unknown, code: AgentTeamContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) => error instanceof AgentTeamContractErrorV1 && error.safeCode === code);
}

function rehash(value: HermesBotModeNativeQualificationDispositionV1): HermesBotModeNativeQualificationDispositionV1 {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.qualificationDigest;
  return { ...value, qualificationDigest: sha256Digest(unsigned) };
}

test("CR11A TEAM-050 freezes the owner grant, exact pin, source digests, and zero-effect ceiling", () => {
  assert.deepEqual(hermesBotModeNativeQualificationInputV1, {
    contractVersion: "control-room-hermes-bot-mode-native-qualification/v1",
    packetId: "cr11a-team-050-native-read-v1",
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
      revision: "5fc308a70719a83cccdbba4c0e39c23f5a8239d5",
      worktreeClean: true,
      sourceDigests: HERMES_BOT_MODE_NATIVE_SOURCE_DIGESTS_V1,
    },
  });
  assert.equal(Object.isFrozen(hermesBotModeNativeQualificationInputV1), true);
  assert.equal(Object.isFrozen(hermesBotModeNativeQualificationInputV1.authorization), true);
});

test("CR11A TEAM-050 records a blocked-before-attempt disposition with no native contact", () => {
  const result = buildHermesBotModeNativeQualificationDispositionV1(cloneInput());
  assert.deepEqual(parseHermesBotModeNativeQualificationDispositionV1(result), result);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual({ status: result.status, eligible: result.eligibility, selected: result.selectedCandidate,
    native: result.nativeQualified, profile: result.identity.profileIdentityProved, device: result.identity.deviceIdentityProved }, {
    status: "blocked_before_attempt", eligible: false, selected: null, native: false, profile: false, device: false,
  });
  assert.deepEqual(result.effects, {
    authorizedAttempts: 1, attemptsPerformed: 0, retriesPerformed: 0, hermesRuntimeContacts: 0,
    profileRecordsRead: 0, roomRecordsRead: 0, fullContentReads: 0, providerCalls: 0, writes: 0,
    messagesSent: 0, schedulesMutated: 0, commandsExecuted: 0, installations: 0, deployments: 0,
  });
  assert.deepEqual(result.cleanup, {
    temporaryProfileCreated: false, temporaryRoomCreated: false, temporaryFilesCreated: false, cleanupRequired: false,
  });
});

test("CR11A TEAM-050 rejects the official list RPC because it returns all profiles and raw room text", () => {
  const candidate = hermesBotModeNativeReadCandidatesV1[0]!;
  assert.deepEqual({ id: candidate.candidateId, kind: candidate.readKind, oneProfile: candidate.selectsOneProfile,
    oneRoom: candidate.selectsOneRoom, metadataOnly: candidate.returnsOnlyMetadata, path: candidate.returnsNativePath,
    provider: candidate.returnsModelOrProvider, messageText: candidate.returnsFullMessageText, eligible: candidate.eligible }, {
    id: "profiles_list", kind: "official_rpc", oneProfile: false, oneRoom: false, metadataOnly: false,
    path: true, provider: true, messageText: true, eligible: false,
  });
});

test("CR11A TEAM-050 rejects describe and direct-file fallbacks before either can read content", () => {
  const describe = hermesBotModeNativeReadCandidatesV1[1]!;
  const direct = hermesBotModeNativeReadCandidatesV1[2]!;
  assert.deepEqual({ oneProfile: describe.selectsOneProfile, soul: describe.readsSoul, mcp: describe.readsMcpConfiguration,
    model: describe.returnsModelOrProvider, eligible: describe.eligible }, {
    oneProfile: true, soul: true, mcp: true, model: true, eligible: false,
  });
  assert.deepEqual({ oneProfile: direct.selectsOneProfile, oneRoom: direct.selectsOneRoom,
    messageText: direct.returnsFullMessageText, sanitizedFirst: direct.sanitizesBeforeContentCrossesBoundary,
    eligible: direct.eligible }, {
    oneProfile: true, oneRoom: false, messageText: true, sanitizedFirst: false, eligible: false,
  });
});

test("CR11A TEAM-050 fails closed on pin, clean-tree, source, or authorization drift", () => {
  const cases = [
    () => { const value = cloneInput(); (value.installedRuntime as Record<string, unknown>).packageVersion = "0.20.7"; return value; },
    () => { const value = cloneInput(); (value.installedRuntime as Record<string, unknown>).revision = "a".repeat(40); return value; },
    () => { const value = cloneInput(); (value.installedRuntime as Record<string, unknown>).worktreeClean = false; return value; },
    () => { const value = cloneInput(); ((value.installedRuntime as Record<string, unknown>).sourceDigests as Record<string, unknown>).desktopPlugin = `sha256:${"a".repeat(64)}`; return value; },
    () => { const value = cloneInput(); (value.authorization as Record<string, unknown>).maximumAttempts = 2; return value; },
    () => { const value = cloneInput(); (value.authorization as Record<string, unknown>).allowsRetry = true; return value; },
    () => { const value = cloneInput(); (value.authorization as Record<string, unknown>).providerCallsAllowed = 1; return value; },
    () => { const value = cloneInput(); (value.authorization as Record<string, unknown>).writesAllowed = 1; return value; },
    () => { const value = cloneInput(); (value.authorization as Record<string, unknown>).fullContentReadsAllowed = 1; return value; },
  ];
  for (const mutate of cases) expectCode(() => buildHermesBotModeNativeQualificationDispositionV1(mutate()), "invalid_input");
});

test("CR11A TEAM-050 rejects hidden fields, accessors, and Proxies without executing behavior", () => {
  const hidden = cloneInput(); hidden.nativeReader = () => "unsafe";
  expectCode(() => buildHermesBotModeNativeQualificationDispositionV1(hidden), "invalid_input");
  let getterCalls = 0;
  const accessor = cloneInput();
  Object.defineProperty(accessor, "packetId", { enumerable: true, get() { getterCalls += 1; return "cr11a-team-050-native-read-v1"; } });
  expectCode(() => buildHermesBotModeNativeQualificationDispositionV1(accessor), "invalid_input");
  assert.equal(getterCalls, 0);
  const proxied = observedProxy(cloneInput(), "transparent");
  expectCode(() => buildHermesBotModeNativeQualificationDispositionV1(proxied.value), "invalid_input");
  assert.equal(proxied.trapCount(), 0);
});

test("CR11A TEAM-050 disposition rejects tampered attempt, identity, candidate, and digest claims", () => {
  const attempt = structuredClone(hermesBotModeNativeQualificationDispositionV1);
  (attempt.effects as unknown as Record<string, unknown>).attemptsPerformed = 1;
  expectCode(() => parseHermesBotModeNativeQualificationDispositionV1(rehash(attempt)), "invalid_input");
  const identity = structuredClone(hermesBotModeNativeQualificationDispositionV1);
  (identity.identity as unknown as Record<string, unknown>).deviceIdentityProved = true;
  expectCode(() => parseHermesBotModeNativeQualificationDispositionV1(rehash(identity)), "invalid_input");
  const candidate = structuredClone(hermesBotModeNativeQualificationDispositionV1);
  candidate.candidates[0]!.returnsFullMessageText = false;
  expectCode(() => parseHermesBotModeNativeQualificationDispositionV1(rehash(candidate)), "digest_mismatch");
  const digest = structuredClone(hermesBotModeNativeQualificationDispositionV1);
  digest.reasonCodes = [...digest.reasonCodes].reverse();
  expectCode(() => parseHermesBotModeNativeQualificationDispositionV1(digest), "digest_mismatch");
});

test("CR11A TEAM-050 result contains no raw profile, room, path, provider, prompt, memory, or message data", () => {
  const serialized = JSON.stringify(hermesBotModeNativeQualificationDispositionV1);
  for (const forbidden of ["profileName", "roomName", "nativePath", "messageBody", "prompt", "MEMORY.md", "SOUL.md content", "providerSession", "credential"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.match(hermesBotModeNativeQualificationDispositionV1.inputDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(hermesBotModeNativeQualificationDispositionV1.qualificationDigest, /^sha256:[a-f0-9]{64}$/);
});
