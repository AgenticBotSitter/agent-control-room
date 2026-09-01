import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, sha256Digest } from "../src/security/index.ts";
import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_PROFILE_PREPARATION_ATTESTATION_V1,
  IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1,
  IdeaLabErrorV1,
  buildIdeaLabHermesProfilePreparationRequestV1,
  parseIdeaLabHermesProfilePreparationSafeResultV1,
  sanitizeIdeaLabHermesProfilePreparationAttestationV1,
} from "../src/idea-lab/v1/index.ts";

const digest = (label: string) => sha256Digest({ label });
const keys = generateKeyPairSync("ed25519");
const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const request = buildIdeaLabHermesProfilePreparationRequestV1({
  requestId: "profile-preparation:attestation", sourceProfileSelectorDigest: digest("source"), nonceDigest: digest("nonce"),
  issuedAt: "2026-09-01T05:00:00.000Z", expiresAt: "2026-09-01T05:01:00.000Z",
});

function fixture(changes: Record<string, unknown> = {}) {
  const material = {
    contractVersion: IDEA_LAB_HERMES_PROFILE_PREPARATION_ATTESTATION_V1,
    method: IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1,
    requestDigest: request.requestDigest,
    runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    preparedAt: "2026-09-01T05:00:10.000Z", issuedAt: "2026-09-01T05:00:11.000Z",
    expiresAt: "2026-09-01T05:00:50.000Z", profileIdentityDigest: digest("profile"),
    launchPermitDigest: digest("permit"), protectedValueCustodyEvidenceDigest: digest("custody"),
    negativeContextCounts: { soul: 0, memory: 0, skills: 0, plugins: 0, mcpConfiguration: 0, rules: 0, sessions: 0 },
    protectedValueMaterialReturned: false, nativePathReturned: false, gatewayStartsMade: 0, providerCallsMade: 0,
    cleanupMethodPresent: true, profilePrepared: true, ...changes,
  };
  const body = { ...material, bodyDigest: sha256Digest(material) };
  return { body, attestation: { algorithm: "ed25519", keyId: "device-key:hermes-qualification",
    publicKeySpki: spki, signature: sign(null, Buffer.from(canonicalJson(body)), keys.privateKey).toString("base64url") } };
}

const context = { request, evaluatedAt: "2026-09-01T05:00:20.000Z",
  trustedDeviceKeyId: "device-key:hermes-qualification", trustedDevicePublicKeySpki: spki,
  inputMode: "injected_signed_attestation_only" as const };

test("CR12B-IDEA-109A verifies a signed zero-context preparation but keeps it unaccepted", () => {
  const result = sanitizeIdeaLabHermesProfilePreparationAttestationV1(fixture(), context);
  assert.deepEqual(parseIdeaLabHermesProfilePreparationSafeResultV1(result), result);
  assert.deepEqual([result.profilePreparedObserved, result.acceptedRuntimeImplementation, result.launchEligible,
    result.blockerCodes, result.providerCallsMade, result.gatewayStartsMade, result.grantsExecutionAuthority],
  [true, false, false, ["runtime_implementation_not_accepted"], 0, 0, false]);
});

test("CR12B-IDEA-109A rejects signature, key, request, runtime, chronology, and expiry drift", () => {
  const wrongKeys = generateKeyPairSync("ed25519");
  const cases: Array<[unknown, unknown]> = [
    [{ ...fixture(), attestation: { ...fixture().attestation, signature: "a".repeat(86) } }, context],
    [fixture(), { ...context, trustedDevicePublicKeySpki: wrongKeys.publicKey
      .export({ format: "der", type: "spki" }).toString("base64url") }],
    [fixture({ requestDigest: digest("other") }), context],
    [fixture({ runtimeRevision: "b".repeat(40) }), context],
    [fixture({ preparedAt: "2026-09-01T05:00:12.000Z", issuedAt: "2026-09-01T05:00:11.000Z" }), context],
    [fixture({ expiresAt: "2026-09-01T05:01:01.000Z" }), context],
  ];
  for (const [envelope, candidateContext] of cases) assert.throws(
    () => sanitizeIdeaLabHermesProfilePreparationAttestationV1(envelope, candidateContext),
    (error) => error instanceof IdeaLabErrorV1);
});

test("CR12B-IDEA-109A schema rejects nonzero context, returned material, gateway, provider, and missing cleanup", () => {
  for (const changed of [
    { negativeContextCounts: { soul: 1, memory: 0, skills: 0, plugins: 0, mcpConfiguration: 0, rules: 0, sessions: 0 } },
    { protectedValueMaterialReturned: true }, { nativePathReturned: true }, { gatewayStartsMade: 1 },
    { providerCallsMade: 1 }, { cleanupMethodPresent: false },
  ]) assert.throws(() => sanitizeIdeaLabHermesProfilePreparationAttestationV1(fixture(changed), context),
    (error) => error instanceof IdeaLabErrorV1);
});

test("CR12B-IDEA-109A rejects re-digested authority and Proxy input without executing behavior", () => {
  const result = sanitizeIdeaLabHermesProfilePreparationAttestationV1(fixture(), context);
  const unsigned = { ...result, launchEligible: true, acceptedRuntimeImplementation: true,
    blockerCodes: [], grantsCommandAuthority: true } as Record<string, unknown>;
  delete unsigned.resultDigest;
  assert.throws(() => parseIdeaLabHermesProfilePreparationSafeResultV1({ ...unsigned,
    resultDigest: sha256Digest(unsigned) }), (error) => error instanceof IdeaLabErrorV1);
  let traps = 0;
  assert.throws(() => sanitizeIdeaLabHermesProfilePreparationAttestationV1(new Proxy(fixture(),
    { ownKeys() { traps += 1; return []; } }), context), (error) => error instanceof IdeaLabErrorV1);
  assert.equal(traps, 0);
});

test("CR12B-IDEA-109A verifier contains no native, filesystem, network, protected-value, or provider client", async () => {
  const source = await readFile("src/idea-lab/v1/hermes-021-profile-preparation-attestation.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(",
    "execFile(", "createPostgresClient(", "auth.json", ".env"]) assert.equal(source.includes(forbidden), false, forbidden);
});
