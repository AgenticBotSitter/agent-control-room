import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
    gatewayOperations: ["session.create", "prompt.submit", "session.events.since", "session.status",
      "session.usage", "session.interrupt", "session.close"] as const,
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
    [envelope({ changes: { gatewayOperations: ["session.create", "prompt.submit", "session.steer",
      "session.events.since", "session.status", "session.usage", "session.interrupt", "session.resume",
      "session.close"] } }), context(envelope({ changes: { gatewayOperations: ["session.create", "prompt.submit",
      "session.steer", "session.events.since", "session.status", "session.usage", "session.interrupt",
      "session.resume", "session.close"] } }))],
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

test("CR12B-IDEA-110N roster snapshots input and ignores caller-owned traversal and collection behavior", () => {
  const firstEnvelope = envelope(), first = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(firstEnvelope, context(firstEnvelope));
  const secondEnvelope = envelope({ connectionId: "captured-roster-local", local: true });
  const second = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(secondEnvelope, context(secondEnvelope));
  const connections = [first, second];
  const nativeMap = Array.prototype.map, nativeFilter = Array.prototype.filter, nativeSet = Set;
  let mapCalls = 0, filterCalls = 0, setCalls = 0;
  try {
    Object.defineProperty(Array.prototype, "map", { configurable: true, writable: true,
      value(this: unknown[], ...args: unknown[]) {
        if (this === connections) { mapCalls += 1; throw new Error("caller roster map reached"); }
        return Reflect.apply(nativeMap, this, args);
      } });
    Object.defineProperty(Array.prototype, "filter", { configurable: true, writable: true,
      value(this: unknown[], ...args: unknown[]) {
        if (this === connections) { filterCalls += 1; throw new Error("caller roster filter reached"); }
        return Reflect.apply(nativeFilter, this, args);
      } });
    Object.defineProperty(globalThis, "Set", { configurable: true, writable: true,
      value: function HostileSet() { setCalls += 1; throw new Error("ambient Set reached"); } });
    const roster = buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
      evaluatedAt: "2026-09-01T10:06:00.000Z", connections });
    assert.deepEqual([roster.connectionCount, roster.sshConnectionCount, roster.localConnectionCount,
      roster.qualificationReadyCount], [2, 1, 1, 2]);
    assert.deepEqual([mapCalls, filterCalls, setCalls], [0, 0, 0]);
  } finally {
    Object.defineProperty(Array.prototype, "map", { configurable: true, writable: true, value: nativeMap });
    Object.defineProperty(Array.prototype, "filter", { configurable: true, writable: true, value: nativeFilter });
    Object.defineProperty(globalThis, "Set", { configurable: true, writable: true, value: nativeSet });
  }

  let ownMapCalls = 0;
  Object.defineProperty(connections, "map", { configurable: true, value() { ownMapCalls += 1; throw new Error("own map reached"); } });
  assert.throws(() => buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
    evaluatedAt: "2026-09-01T10:06:00.000Z", connections }), (error) => error instanceof IdeaLabErrorV1);
  assert.equal(ownMapCalls, 0);
});

test("CR12B-IDEA-110O roster digest ignores ambient traversal of rebuilt connections", () => {
  const firstEnvelope = envelope(), first = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(firstEnvelope, context(firstEnvelope));
  const secondEnvelope = envelope({ connectionId: "captured-digest-local", local: true });
  const second = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(secondEnvelope, context(secondEnvelope));
  const connections = [first, second];
  const cleanRoster = buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
    evaluatedAt: "2026-09-01T10:06:00.000Z", connections });
  const expectedDigest = cleanRoster.rosterDigest;
  const nativeMap = Array.prototype.map, nativeJoin = Array.prototype.join, nativeSort = Array.prototype.sort;
  const nativeObjectKeys = Object.keys, nativeStringify = JSON.stringify, nativeReflectApply = Reflect.apply;
  const hashPrototype = Object.getPrototypeOf(createHash("sha256"));
  const nativeHashUpdate = Object.getOwnPropertyDescriptor(hashPrototype, "update")!.value;
  let rebuiltMapCalls = 0, rebuiltJoinCalls = 0, rosterKeysCalls = 0, rosterSortCalls = 0;
  let rosterStringifyCalls = 0, rosterHashUpdateCalls = 0;
  try {
    Object.defineProperty(Array.prototype, "map", { configurable: true, writable: true,
      value(this: unknown[], ...args: unknown[]) {
        if (this !== connections && this.length === 2
          && (this[0] as { contractVersion?: unknown } | undefined)?.contractVersion
            === "control-room-hermes-021-connection-safe-result/v1") {
          rebuiltMapCalls += 1;
          throw new Error("rebuilt roster map reached");
        }
        return nativeReflectApply(nativeMap, this, args);
      } });
    Object.defineProperty(Array.prototype, "join", { configurable: true, writable: true,
      value(this: unknown[], ...args: unknown[]) {
        if (this.length === 2 && typeof this[0] === "string"
          && this[0].includes("control-room-hermes-021-connection-safe-result/v1")) {
          rebuiltJoinCalls += 1;
          throw new Error("rebuilt roster join reached");
        }
        return nativeReflectApply(nativeJoin, this, args);
      } });
    Object.defineProperty(Array.prototype, "sort", { configurable: true, writable: true,
      value(this: unknown[], ...args: unknown[]) {
        let rosterKeys = false, includesRosterDigest = false;
        for (let index = 0; index < this.length; index += 1) {
          if (this[index] === "connections") rosterKeys = true;
          if (this[index] === "rosterDigest") includesRosterDigest = true;
        }
        if (rosterKeys && !includesRosterDigest) { rosterSortCalls += 1; throw new Error("roster key sort reached"); }
        return nativeReflectApply(nativeSort, this, args);
      } });
    Object.defineProperty(Object, "keys", { configurable: true, writable: true,
      value(value: unknown) {
        if ((value as { contractVersion?: unknown } | null)?.contractVersion
          === "control-room-hermes-021-connection-roster/v1"
          && (value as { rosterDigest?: unknown }).rosterDigest === undefined) {
          rosterKeysCalls += 1;
          throw new Error("roster Object.keys reached");
        }
        return nativeReflectApply(nativeObjectKeys, Object, [value]);
      } });
    Object.defineProperty(JSON, "stringify", { configurable: true, writable: true,
      value(value: unknown, ...args: unknown[]) {
        if (value === "control-room-hermes-021-connection-roster/v1") {
          rosterStringifyCalls += 1;
          throw new Error("roster JSON.stringify reached");
        }
        return nativeReflectApply(nativeStringify, JSON, [value, ...args]);
      } });
    Object.defineProperty(hashPrototype, "update", { configurable: true, writable: true,
      value(this: unknown, ...args: unknown[]) {
        if (typeof args[0] === "string"
          && args[0].includes("control-room-hermes-021-connection-roster/v1")) {
          rosterHashUpdateCalls += 1;
          throw new Error("roster hash update reached");
        }
        return nativeReflectApply(nativeHashUpdate, this, args);
      } });
    const roster = buildIdeaLabHermes021ConnectionRosterV1({ tenantId: first.tenantId,
      evaluatedAt: "2026-09-01T10:06:00.000Z", connections });
    assert.equal(roster.rosterDigest, expectedDigest);
    assert.deepEqual([rebuiltMapCalls, rebuiltJoinCalls, rosterKeysCalls, rosterSortCalls,
      rosterStringifyCalls, rosterHashUpdateCalls], [0, 0, 0, 0, 0, 0]);
  } finally {
    Object.defineProperty(Array.prototype, "map", { configurable: true, writable: true, value: nativeMap });
    Object.defineProperty(Array.prototype, "join", { configurable: true, writable: true, value: nativeJoin });
    Object.defineProperty(Array.prototype, "sort", { configurable: true, writable: true, value: nativeSort });
    Object.defineProperty(Object, "keys", { configurable: true, writable: true, value: nativeObjectKeys });
    Object.defineProperty(JSON, "stringify", { configurable: true, writable: true, value: nativeStringify });
    Object.defineProperty(hashPrototype, "update", { configurable: true, writable: true, value: nativeHashUpdate });
  }
});

test("CR12B-IDEA-110P freezes reparsed and nested roster evidence after digest verification", () => {
  const firstEnvelope = envelope(), sanitized = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(firstEnvelope, context(firstEnvelope));
  const reparsed = parseIdeaLabHermes021ConnectionSafeResultV1(sanitized);
  const resultDigest = reparsed.resultDigest;
  assert.equal(Object.isFrozen(reparsed), true);
  assert.equal(Object.isFrozen(reparsed.blockerCodes), true);
  assert.throws(() => { (reparsed as { grantsExecutionAuthority: boolean }).grantsExecutionAuthority = true; }, TypeError);
  assert.throws(() => { (reparsed.blockerCodes as unknown[]).length = 0; }, TypeError);
  assert.equal(reparsed.grantsExecutionAuthority, false);
  assert.equal(reparsed.blockerCodes.length, 4);
  assert.equal(reparsed.resultDigest, resultDigest);

  const roster = buildIdeaLabHermes021ConnectionRosterV1({ tenantId: reparsed.tenantId,
    evaluatedAt: "2026-09-01T10:06:00.000Z", connections: [reparsed] });
  const rosterDigest = roster.rosterDigest, connectionDigest = roster.connections[0]!.resultDigest;
  assert.equal(Object.isFrozen(roster), true);
  assert.equal(Object.isFrozen(roster.connections), true);
  assert.equal(Object.isFrozen(roster.connections[0]), true);
  assert.equal(Object.isFrozen(roster.connections[0]!.blockerCodes), true);
  assert.throws(() => { (roster.connections[0] as { connectionId: string }).connectionId = "changed"; }, TypeError);
  assert.throws(() => { (roster.connections[0] as { nativeQualified: boolean }).nativeQualified = true; }, TypeError);
  assert.throws(() => { (roster.connections[0] as { livePanelEligible: boolean }).livePanelEligible = true; }, TypeError);
  assert.throws(() => {
    (roster.connections[0] as { grantsExecutionAuthority: boolean }).grantsExecutionAuthority = true;
  }, TypeError);
  assert.throws(() => { (roster.connections[0]!.blockerCodes as unknown[]).length = 0; }, TypeError);
  assert.equal(roster.connections[0]!.connectionId, reparsed.connectionId);
  assert.equal(roster.connections[0]!.nativeQualified, false);
  assert.equal(roster.connections[0]!.livePanelEligible, false);
  assert.equal(roster.connections[0]!.grantsExecutionAuthority, false);
  assert.equal(roster.connections[0]!.blockerCodes.length, 4);
  assert.equal(roster.connections[0]!.resultDigest, connectionDigest);
  assert.equal(roster.rosterDigest, rosterDigest);
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

test("CR12B-IDEA-110M enrollment chronology ignores post-import ambient substitutions", () => {
  const valid = envelope(), expired = envelope({ changes: { expiresAt: "2026-09-01T10:04:00.000Z" } });
  const parse = Date.parse, finite = Number.isFinite, every = Array.prototype.every;
  let dateParseCalls = 0, finiteCalls = 0, everyCalls = 0;
  try {
    Object.defineProperty(Date, "parse", { configurable: true, writable: true,
      value() { dateParseCalls += 1; return 0; } });
    Object.defineProperty(Number, "isFinite", { configurable: true, writable: true,
      value() { finiteCalls += 1; return true; } });
    Object.defineProperty(Array.prototype, "every", { configurable: true, writable: true,
      value() { everyCalls += 1; throw new Error("ambient Array.every reached"); } });
    assert.equal(sanitizeIdeaLabHermes021ConnectionEnrollmentV1(valid, context(valid)).routeEnrollmentAccepted, true);
    assert.throws(() => sanitizeIdeaLabHermes021ConnectionEnrollmentV1(expired, context(expired)),
      (error) => error instanceof IdeaLabErrorV1);
    assert.deepEqual([dateParseCalls, everyCalls, finiteCalls > 0], [0, 0, true]);
  } finally {
    Object.defineProperty(Date, "parse", { configurable: true, writable: true, value: parse });
    Object.defineProperty(Number, "isFinite", { configurable: true, writable: true, value: finite });
    Object.defineProperty(Array.prototype, "every", { configurable: true, writable: true, value: every });
  }
});

test("CR12B-IDEA-109B ships no SSH process, filesystem, network, credential reader, or provider client", async () => {
  const source = await readFile("src/idea-lab/v1/hermes-021-enrolled-connection.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(",
    "execFile(", "createPostgresClient(", "auth.json", ".env", "readFile("]) assert.equal(source.includes(forbidden), false, forbidden);
});
