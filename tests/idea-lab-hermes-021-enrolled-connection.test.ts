import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, sha256Digest } from "../src/security/index.ts";
import {
  IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  IdeaLabErrorV1,
  buildIdeaLabHermes021ConnectionRosterV1,
  ideaLabHermes021BuiltInConnectionSourceV1,
  ideaLabHermes021ConnectionReassessmentV1,
  parseIdeaLabHermes021ConnectionSafeResultV1,
  sanitizeIdeaLabHermes021ConnectionEnrollmentV1,
} from "../src/idea-lab/v1/index.ts";

const digest = (label: string) => sha256Digest({ label });
const keys = generateKeyPairSync("ed25519");
const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const hostKeyDigest = digest("owner-verified-ssh-host-key");

function envelope(input: { connectionId?: string; profileIdentityDigest?: string; local?: boolean;
  changes?: Record<string, unknown>; routeChanges?: Record<string, unknown> } = {}) {
  const local = input.local ?? false;
  const route = local ? {
    transport: "local_loopback" as const, sshHostKeyFingerprintDigest: null, sshPublicKeyOnly: false as const,
    sshBatchMode: false as const, ownerVerifiedFirstHostKey: false as const, hostKeyChangesFailClosed: false as const,
  } : {
    transport: "ssh_tunnel" as const, sshHostKeyFingerprintDigest: hostKeyDigest, sshPublicKeyOnly: true as const,
    sshBatchMode: true as const, ownerVerifiedFirstHostKey: true as const, hostKeyChangesFailClosed: true as const,
  };
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
    enrollmentId: `enrollment:${input.connectionId ?? "johnny5"}`,
    connectionId: input.connectionId ?? "connection:johnny5-mac",
    tenantId: "tenant:local-owner",
    nodeId: local ? "node:control-room-mac" : "node:johnny5-mac",
    runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
    route: { ...route, ...input.routeChanges },
    connectorRouteDigest: digest(`route:${input.connectionId ?? "johnny5"}`),
    profileIdentityDigest: input.profileIdentityDigest ?? digest(`profile:${input.connectionId ?? "johnny5"}`),
    gatewayEndpointVisibility: "connector_private_loopback" as const,
    gatewaySessionValueCustody: "connector_private" as const,
    gatewayOperations: ["session.create", "prompt.submit", "session.steer", "session.interrupt", "session.resume",
      "session.status", "session.usage", "session.events.since"] as const,
    arbitraryRemoteCommandAllowed: false as const,
    genericShellExposedToControlRoom: false as const,
    freshProfileNoSkills: true as const,
    protectedValueResolution: "global_root_read_only_per_provider" as const,
    protectedValueMaterialReturned: false as const,
    copiedContextCounts: { soul: 0 as const, memory: 0 as const, skills: 0 as const, plugins: 0 as const,
      mcpConfiguration: 0 as const, rules: 0 as const, sessions: 0 as const },
    toolsEnabled: false as const, mcpEnabled: false as const, pluginsEnabled: false as const,
    gatewayStartsMade: 0 as const, providerCallsMade: 0 as const,
    issuedAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-09-01T22:00:00.000Z",
    ...input.changes,
  };
  const body = { ...material, bodyDigest: sha256Digest(material) };
  return { body, attestation: { algorithm: "ed25519" as const, keyId: "node-key:johnny5",
    publicKeySpki: spki, signature: sign(null, Buffer.from(canonicalJson(body)), keys.privateKey).toString("base64url") } };
}

function context(value = envelope()) {
  return { evaluatedAt: "2026-09-01T10:05:00.000Z", expectedTenantId: value.body.tenantId,
    expectedNodeId: value.body.nodeId, expectedConnectionId: value.body.connectionId,
    expectedConnectorRouteDigest: value.body.connectorRouteDigest,
    expectedProfileIdentityDigest: value.body.profileIdentityDigest,
    expectedSshHostKeyFingerprintDigest: value.body.route.sshHostKeyFingerprintDigest,
    trustedNodeKeyId: "node-key:johnny5", trustedNodePublicKeySpki: spki,
    inputMode: "injected_signed_node_enrollment_only" as const };
}

test("CR12B-IDEA-109B recognizes the built-in shared-credential and SSH route without a Hermes change", () => {
  const source = ideaLabHermes021BuiltInConnectionSourceV1;
  assert.equal(source.runtimeRevision, IDEA_LAB_HERMES_021_REVISION_V1);
  assert.deepEqual([source.capabilities.freshNoSkillsProfile, source.capabilities.profileProtectedValueFallback,
    source.capabilities.sshConnectionRegistry, source.hermesModificationRequired, source.nativeQualified],
  [true, "global_root_read_only_per_provider", true, false, false]);
  assert.deepEqual([ideaLabHermes021ConnectionReassessmentV1.freshNoSkillsProfileEligible,
    ideaLabHermes021ConnectionReassessmentV1.existingAuthenticationAvailableByReadOnlyFallback,
    ideaLabHermes021ConnectionReassessmentV1.privateBotContextCopyRequired,
    ideaLabHermes021ConnectionReassessmentV1.hermesModificationRequired], [true, true, false, false]);
});

test("CR12B-IDEA-109B verifies a signed SSH enrollment and returns only an opaque, non-authorizing route", () => {
  const candidate = envelope();
  const result = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(candidate, context(candidate));
  assert.deepEqual(parseIdeaLabHermes021ConnectionSafeResultV1(result), result);
  assert.deepEqual([result.transport, result.routeEnrollmentAccepted, result.qualificationProfileEligible,
    result.hermesModificationRequired, result.nativeQualified, result.livePanelEligible, result.grantsExecutionAuthority],
  ["ssh_tunnel", true, true, false, false, false, false]);
  const text = JSON.stringify(result);
  for (const forbidden of ["johnny5.local", "alastair", "/Users/", ".ssh/", "session-token", "privateKey"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test("CR12B-IDEA-109B accepts a separately scoped local loopback route without inventing SSH evidence", () => {
  const candidate = envelope({ connectionId: "local-control-room", local: true });
  const result = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(candidate, context(candidate));
  assert.deepEqual([result.transport, result.sshHostKeyFingerprintDigest, result.genericShellAvailable],
    ["local_loopback", null, false]);
});

test("CR12B-IDEA-109B rejects host-key, route, profile, signature, expiry, and unsafe capability drift", () => {
  const exact = envelope();
  const wrongKeys = generateKeyPairSync("ed25519");
  const cases: Array<[unknown, unknown]> = [
    [exact, { ...context(exact), expectedSshHostKeyFingerprintDigest: digest("other-host") }],
    [exact, { ...context(exact), expectedConnectorRouteDigest: digest("other-route") }],
    [exact, { ...context(exact), expectedProfileIdentityDigest: digest("other-profile") }],
    [{ ...exact, attestation: { ...exact.attestation, signature: "a".repeat(86) } }, context(exact)],
    [exact, { ...context(exact), trustedNodePublicKeySpki: wrongKeys.publicKey
      .export({ format: "der", type: "spki" }).toString("base64url") }],
    [envelope({ changes: { expiresAt: "2026-09-01T10:04:00.000Z" } }), context(envelope({ changes: { expiresAt: "2026-09-01T10:04:00.000Z" } }))],
    [envelope({ changes: { genericShellExposedToControlRoom: true } }), context(envelope({ changes: { genericShellExposedToControlRoom: true } }))],
    [envelope({ changes: { copiedContextCounts: { soul: 0, memory: 1, skills: 0, plugins: 0,
      mcpConfiguration: 0, rules: 0, sessions: 0 } } }), context(envelope({ changes: { copiedContextCounts: {
      soul: 0, memory: 1, skills: 0, plugins: 0, mcpConfiguration: 0, rules: 0, sessions: 0 } } }))],
  ];
  for (const [candidate, candidateContext] of cases) assert.throws(
    () => sanitizeIdeaLabHermes021ConnectionEnrollmentV1(candidate, candidateContext),
    (error) => error instanceof IdeaLabErrorV1);
});

test("CR12B-IDEA-109B roster rejects duplicate routes, profiles, stale enrollments, and cross-tenant entries", () => {
  const firstEnvelope = envelope(), first = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(firstEnvelope, context(firstEnvelope));
  const secondEnvelope = envelope({ connectionId: "control-room-local", local: true });
  const second = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(secondEnvelope, context(secondEnvelope));
  const roster = buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
    evaluatedAt: "2026-09-01T10:06:00.000Z", connections: [first, second] });
  assert.deepEqual([roster.connectionCount, roster.sshConnectionCount, roster.localConnectionCount,
    roster.qualificationReadyCount, roster.nativeQualifiedCount, roster.livePanelEligibleCount], [2, 1, 1, 2, 0, 0]);
  assert.throws(() => buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
    evaluatedAt: "2026-09-01T10:06:00.000Z", connections: [first, first] }),
  (error) => error instanceof IdeaLabErrorV1);
  const duplicateRouteEnvelope = envelope({ connectionId: "duplicate-route", changes: {
    connectorRouteDigest: first.connectorRouteDigest,
  } });
  const duplicateRoute = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(
    duplicateRouteEnvelope, context(duplicateRouteEnvelope));
  assert.throws(() => buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
    evaluatedAt: "2026-09-01T10:06:00.000Z", connections: [first, duplicateRoute] }),
  (error) => error instanceof IdeaLabErrorV1);
  const duplicateProfileEnvelope = envelope({ connectionId: "duplicate-profile",
    profileIdentityDigest: first.profileIdentityDigest });
  const duplicateProfile = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(
    duplicateProfileEnvelope, context(duplicateProfileEnvelope));
  assert.throws(() => buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
    evaluatedAt: "2026-09-01T10:06:00.000Z", connections: [first, duplicateProfile] }),
  (error) => error instanceof IdeaLabErrorV1);
  const crossTenantEnvelope = envelope({ connectionId: "cross-tenant", changes: { tenantId: "tenant:other-owner" } });
  const crossTenant = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(crossTenantEnvelope, context(crossTenantEnvelope));
  assert.throws(() => buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
    evaluatedAt: "2026-09-01T10:06:00.000Z", connections: [first, crossTenant] }),
  (error) => error instanceof IdeaLabErrorV1);
  assert.throws(() => buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
    evaluatedAt: "2026-09-01T23:00:00.000Z", connections: [first] }),
  (error) => error instanceof IdeaLabErrorV1);
});

test("CR12B-IDEA-109B rejects re-digested authority and hostile objects without executing behavior", () => {
  const candidate = envelope(), result = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(candidate, context(candidate));
  const unsigned = { ...result, nativeQualified: true, livePanelEligible: true, blockerCodes: [],
    grantsCommandAuthority: true, grantsExecutionAuthority: true } as Record<string, unknown>;
  delete unsigned.resultDigest;
  assert.throws(() => parseIdeaLabHermes021ConnectionSafeResultV1({ ...unsigned,
    resultDigest: sha256Digest(unsigned) }), (error) => error instanceof IdeaLabErrorV1);
  let traps = 0;
  assert.throws(() => sanitizeIdeaLabHermes021ConnectionEnrollmentV1(new Proxy(candidate,
    { ownKeys() { traps += 1; return []; } }), context(candidate)), (error) => error instanceof IdeaLabErrorV1);
  assert.equal(traps, 0);
});

test("CR12B-IDEA-109B ships no SSH process, filesystem, network, credential reader, or provider client", async () => {
  const source = await readFile("src/idea-lab/v1/hermes-021-enrolled-connection.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(",
    "execFile(", "createPostgresClient(", "auth.json", ".env", "readFile("]) assert.equal(source.includes(forbidden), false, forbidden);
});
