import assert from "node:assert/strict";
import test from "node:test";
import {
  IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  buildIdeaLabHermes021ConnectionRosterV1,
  ideaLabHermes021BuiltInConnectionSourceV1,
  type IdeaLabHermes021ConnectionSafeResultV1,
} from "../src/idea-lab/v1/index.ts";
import {
  ConnectionCenterReadErrorV1,
  ConnectionCenterReadServiceV1,
  buildConnectionCenterProjectionV1,
  parseConnectionCenterProjectionV1,
} from "../src/connection-center/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const tenantId = "tenant:connection-center";
const now = "2026-09-01T18:00:00.000Z";

function safeConnection(overrides: Partial<Pick<IdeaLabHermes021ConnectionSafeResultV1, "connectionId" | "nodeId">> = {}): IdeaLabHermes021ConnectionSafeResultV1 {
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
    sourceMode: "injected_signed_node_enrollment_only" as const,
    enrollmentId: "enrollment:connection-center",
    connectionId: "connection:mac-hermes",
    tenantId,
    nodeId: "node:mac-hermes",
    runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    transport: "ssh_tunnel" as const,
    connectorRouteDigest: sha256Digest({ route: "private" }),
    profileIdentityDigest: sha256Digest({ profile: "empty" }),
    sshHostKeyFingerprintDigest: sha256Digest({ host: "withheld" }),
    issuerKeyDigest: sha256Digest({ issuer: "node" }),
    sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
    issuedAt: "2026-09-01T17:55:00.000Z",
    expiresAt: "2026-09-02T05:55:00.000Z",
    evaluatedAt: now,
    hermesModificationRequired: false as const,
    protectedValueMaterialRetained: false as const,
    nativeLocatorRetained: false as const,
    genericShellAvailable: false as const,
    privateContextRetained: false as const,
    routeEnrollmentAccepted: true as const,
    qualificationProfileEligible: true as const,
    nativeQualified: false as const,
    livePanelEligible: false as const,
    blockerCodes: ["native_qualification_missing", "owner_effect_window_missing",
      "admission_authority_not_configured", "live_driver_not_configured"] as IdeaLabHermes021ConnectionSafeResultV1["blockerCodes"],
    grantsApproval: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  const changed = { ...material, ...overrides };
  return { ...changed, resultDigest: sha256Digest(changed) };
}

test("CR13A-LIVE-010 projects an honest protected empty connection inventory", async () => {
  const source = { async read(input: { tenantId: string; now: string }) {
    return buildIdeaLabHermes021ConnectionRosterV1({ tenantId: input.tenantId, evaluatedAt: input.now, connections: [] });
  } };
  const projection = await new ConnectionCenterReadServiceV1(source).read({ tenantId, now });
  assert.deepEqual([projection.inventoryState, projection.safeStatusCode, projection.summary.connectionCount,
    projection.summary.livePanelEligibleCount], ["empty", "no_enrolled_connections", 0, 0]);
  assert.deepEqual([projection.containsNativeLocators, projection.containsProtectedValueMaterial,
    projection.grantsNetworkAuthority, projection.grantsExecutionAuthority], [false, false, false, false]);
  assert.deepEqual(parseConnectionCenterProjectionV1(projection), projection);
  assert.equal(Object.isFrozen(projection), true);
});

test("CR13A-LIVE-010 shows only safe version, route, and blocker diagnostics for an enrolled connection", () => {
  const roster = buildIdeaLabHermes021ConnectionRosterV1({ tenantId, evaluatedAt: now, connections: [safeConnection()] });
  const projection = buildConnectionCenterProjectionV1(roster);
  assert.deepEqual([projection.summary.connectionCount, projection.summary.sshConnectionCount,
    projection.summary.attentionCount, projection.reviewedRuntime.releaseLine], [1, 1, 1, "0.21"]);
  const connection = projection.connections[0]!;
  assert.deepEqual([connection.connectionReference, connection.nodeReference],
    ["connection:inventory:001", "node:inventory:001"]);
  assert.deepEqual([connection.runtimeCompatibility, connection.enrollmentState, connection.qualificationState,
    connection.livePanelState, connection.locationVisible, connection.credentialMaterialVisible],
  ["reviewed_exact_revision", "accepted", "required", "blocked", false, false]);
  const serialized = JSON.stringify(projection);
  for (const forbidden of ["hostname", "privateKey", ".ssh/", "/Users/", "password", "session-token"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("CR13A-LIVE-010 replaces locator-shaped signed identifiers with non-locator presentation references", () => {
  const roster = buildIdeaLabHermes021ConnectionRosterV1({ tenantId, evaluatedAt: now, connections: [safeConnection({
    connectionId: "10.0.0.5:22", nodeId: "johnny5.local:22",
  })] });
  const projection = buildConnectionCenterProjectionV1(roster);
  assert.deepEqual([projection.connections[0]?.connectionReference, projection.connections[0]?.nodeReference],
    ["connection:inventory:001", "node:inventory:001"]);
  const serialized = JSON.stringify(projection);
  for (const forbidden of ["10.0.0.5", ":22", "johnny5.local", tenantId]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.deepEqual([projection.containsNativeLocators, projection.connections[0]?.locationVisible,
    projection.connections[0]?.nativeLocatorVisible], [false, false, false]);
});

test("CR13A-LIVE-010 rejects digest drift, cross-tenant rosters, and invalid read time", async () => {
  const roster = buildIdeaLabHermes021ConnectionRosterV1({ tenantId, evaluatedAt: now, connections: [] });
  const tamperedProjection = { ...buildConnectionCenterProjectionV1(roster), safeStatusCode: "enrollment_present_qualification_required" };
  assert.throws(() => parseConnectionCenterProjectionV1(tamperedProjection), ConnectionCenterReadErrorV1);
  const changedRoster = { ...roster, rosterDigest: sha256Digest({ changed: true }) };
  await assert.rejects(() => new ConnectionCenterReadServiceV1({ async read() { return changedRoster; } })
    .read({ tenantId, now }), ConnectionCenterReadErrorV1);
  await assert.rejects(() => new ConnectionCenterReadServiceV1({ async read() { return roster; } })
    .read({ tenantId: "tenant:other", now }), ConnectionCenterReadErrorV1);
  await assert.rejects(() => new ConnectionCenterReadServiceV1({ async read() { return roster; } })
    .read({ tenantId, now: "not-a-time" }), ConnectionCenterReadErrorV1);
});
