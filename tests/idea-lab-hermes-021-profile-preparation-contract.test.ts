import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Digest } from "../src/security/index.ts";
import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1,
  IdeaLabErrorV1,
  buildIdeaLabHermesProfilePreparationRequestV1,
  evaluateIdeaLabHermesProfilePreparationCompatibilityV1,
  ideaLabHermesProfilePreparationManifestV1,
  parseIdeaLabHermesProfilePreparationRequestV1,
} from "../src/idea-lab/v1/index.ts";

const digest = (label: string) => sha256Digest({ label });
const idealEvidence = {
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  nativeMethod: IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1,
  signedDeviceAttestation: true,
  protectedValueTransferInternal: true,
  opaqueOneUseLaunchPermitInternal: true,
  copiesSoul: false, copiesMemory: false, copiesSkills: false, copiesPlugins: false,
  copiesMcpConfiguration: false, copiesRules: false, copiesSessions: false,
  returnsProtectedValueMaterial: false, returnsNativePath: false, startsGateway: false, contactsProvider: false,
  cleanupMethodPresent: true,
};

test("CR12B-IDEA-109 defines a narrow native preparation surface but accepts no runtime", () => {
  const decision = evaluateIdeaLabHermesProfilePreparationCompatibilityV1(idealEvidence);
  assert.deepEqual(decision, { compatible: false, reasons: ["runtime_revision_not_accepted"] });
  assert.deepEqual([ideaLabHermesProfilePreparationManifestV1.acceptedRuntimeRevisions.length,
    ideaLabHermesProfilePreparationManifestV1.providerCallsAllowed,
    ideaLabHermesProfilePreparationManifestV1.gatewayStartsAllowed,
    ideaLabHermesProfilePreparationManifestV1.grantsExecutionAuthority], [0, 0, 0, false]);
});

test("CR12B-IDEA-109 reports every private-context, custody, gateway, provider, and cleanup incompatibility", () => {
  const decision = evaluateIdeaLabHermesProfilePreparationCompatibilityV1({ ...idealEvidence,
    nativeMethod: "profiles.clone", signedDeviceAttestation: false, protectedValueTransferInternal: false,
    opaqueOneUseLaunchPermitInternal: false, copiesSoul: true, copiesMemory: true, copiesSkills: true,
    returnsProtectedValueMaterial: true, returnsNativePath: true, startsGateway: true, contactsProvider: true,
    cleanupMethodPresent: false });
  assert.ok(decision.reasons.includes("private_context_copy_present"));
  assert.ok(decision.reasons.includes("native_protected_value_transfer_missing"));
  assert.ok(decision.reasons.includes("provider_contact_present"));
  assert.ok(decision.reasons.includes("cleanup_method_missing"));
});

test("CR12B-IDEA-109 builds only a short-lived non-authorizing proposal", () => {
  const request = buildIdeaLabHermesProfilePreparationRequestV1({
    requestId: "profile-preparation:idea-lab-109", sourceProfileSelectorDigest: digest("source"),
    nonceDigest: digest("nonce"), issuedAt: "2026-09-01T05:00:00.000Z", expiresAt: "2026-09-01T05:01:00.000Z",
  });
  assert.deepEqual(parseIdeaLabHermesProfilePreparationRequestV1(request), request);
  assert.deepEqual([request.requestMode, request.preparationPolicy.copySoul, request.preparationPolicy.copyMemory,
    request.preparationPolicy.startGateway, request.nativeCallsMade, request.providerCallsMade,
    request.protectedValuesAccessed, request.grantsCommandAuthority], ["proposal_only", false, false, false, 0, 0, false, false]);
});

test("CR12B-IDEA-109 rejects expiry, re-digested policy, accessors, and Proxies", () => {
  assert.throws(() => buildIdeaLabHermesProfilePreparationRequestV1({
    requestId: "profile-preparation:too-long", sourceProfileSelectorDigest: digest("source"), nonceDigest: digest("nonce"),
    issuedAt: "2026-09-01T05:00:00.000Z", expiresAt: "2026-09-01T05:01:01.000Z",
  }), (error) => error instanceof IdeaLabErrorV1);
  const request = buildIdeaLabHermesProfilePreparationRequestV1({
    requestId: "profile-preparation:tamper", sourceProfileSelectorDigest: digest("source"), nonceDigest: digest("nonce"),
    issuedAt: "2026-09-01T05:00:00.000Z", expiresAt: "2026-09-01T05:00:30.000Z",
  });
  const unsigned = { ...request, preparationPolicy: { ...request.preparationPolicy, copySoul: true } } as Record<string, unknown>;
  delete unsigned.requestDigest;
  assert.throws(() => parseIdeaLabHermesProfilePreparationRequestV1({ ...unsigned, requestDigest: sha256Digest(unsigned) }),
    (error) => error instanceof IdeaLabErrorV1);
  let traps = 0;
  assert.throws(() => parseIdeaLabHermesProfilePreparationRequestV1(new Proxy(request,
    { ownKeys() { traps += 1; return []; } })), (error) => error instanceof IdeaLabErrorV1);
  assert.equal(traps, 0);
});

test("CR12B-IDEA-109 contract contains no native, filesystem, network, protected-value, or provider client", async () => {
  const source = await readFile("src/idea-lab/v1/hermes-021-profile-preparation-contract.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(",
    "execFile(", "createPostgresClient(", "auth.json", ".env"]) assert.equal(source.includes(forbidden), false, forbidden);
});
