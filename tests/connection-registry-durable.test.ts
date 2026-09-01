import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ConnectionRegistryErrorV1, ConnectionRegistryStoreV1 } from "../src/connection-registry/v1/index.ts";
import { AuthenticatedFleetTelemetryFreshnessSourceV1, ConnectionCenterReadErrorV1,
  ConnectionCenterReadServiceV1 } from "../src/connection-center/v1/index.ts";
import { DOMAIN_CONTRACT_VERSION, type NodeRecord } from "../src/domain/v1/index.ts";
import {
  IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  ideaLabHermes021BuiltInConnectionSourceV1,
  type IdeaLabHermes021ConnectionSafeResultV1,
} from "../src/idea-lab/v1/index.ts";
import { AuthenticatedTelemetryReceiptStoreV1, FleetSignalStore,
  fleetSignalEnvelopeSchema } from "../src/node-fleet/v1/index.ts";
import { adaptPglite, type DatabaseClient, type DatabaseSession } from "../src/persistence/database.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { sha256Digest } from "../src/security/index.ts";

const tenantId = "tenant:connection-registry";
const now = "2026-09-01T18:00:00.000Z";
const digest = (label: string) => sha256Digest({ label });

function safeConnection(overrides: Partial<IdeaLabHermes021ConnectionSafeResultV1> = {}): IdeaLabHermes021ConnectionSafeResultV1 {
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
    sourceMode: "injected_signed_node_enrollment_only" as const,
    enrollmentId: "enrollment:durable:001",
    connectionId: "10.0.0.5:22",
    tenantId,
    nodeId: "johnny5.private:22",
    runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    transport: "ssh_tunnel" as const,
    connectorRouteDigest: digest("route-one"),
    profileIdentityDigest: digest("profile-one"),
    sshHostKeyFingerprintDigest: digest("host-one"),
    issuerKeyDigest: digest("issuer-one"),
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
  return { ...changed, resultDigest: sha256Digest(changed) } as IdeaLabHermes021ConnectionSafeResultV1;
}

async function migrate(raw: PGlite): Promise<void> {
  for (const file of (await readdir(resolve("db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
}

async function createNode(db: ReturnType<typeof adaptPglite>, nodeId = "johnny5.private:22"): Promise<void> {
  const node: NodeRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: nodeId, tenantId,
    displayName: "Protected node", state: "pending_enrollment", version: 0, platform: "macos", architecture: "arm64",
    identityKeyId: `key:${nodeId.replaceAll(":", "-")}`, hardwareFingerprint: digest(`hardware:${nodeId}`),
    softwareFingerprint: digest(`software:${nodeId}`), policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1",
    createdAt: now, updatedAt: now };
  await new CanonicalStore(db).create(node);
}

test("CR13A-LIVE-020 persists protected enrollments and composes only authenticated telemetry freshness", async () => {
  const raw = new PGlite(); await migrate(raw); const db = adaptPglite(raw);
  try {
    await raw.query(`INSERT INTO tenants(id,display_name) VALUES($1,$2)`, [tenantId, "Connection registry"]);
    await createNode(db);
    const key = new Uint8Array(32).fill(7), store = new ConnectionRegistryStoreV1(db, key), enrollment = safeConnection();
    const binding = { tenantId, nodeId: enrollment.nodeId, connectionId: enrollment.connectionId };
    assert.deepEqual(await store.enrollAuthenticated(enrollment, now, binding), { replayed: false, revision: 1 });
    assert.deepEqual(await store.enrollAuthenticated(enrollment, now, binding), { replayed: true, revision: 1 });
    await assert.rejects(() => store.enrollAuthenticated(enrollment, "2026-09-01T18:00:01.000Z", binding),
      (error: unknown) => error instanceof ConnectionRegistryErrorV1 && error.safeCode === "invalid_input");
    const backwardsTime = safeConnection({ enrollmentId: "enrollment:backwards-time",
      issuedAt: "2026-09-01T17:56:00.000Z", expiresAt: "2026-09-02T06:00:00.000Z",
      evaluatedAt: "2026-09-01T17:59:00.000Z" });
    await assert.rejects(() => store.enrollAuthenticated(backwardsTime, backwardsTime.evaluatedAt, binding),
      (error: unknown) => error instanceof ConnectionRegistryErrorV1 && error.safeCode === "replay_conflict");
    await assert.rejects(() => store.enrollAuthenticated(safeConnection({ profileIdentityDigest: digest("changed") }), now, binding),
      (error: unknown) => error instanceof ConnectionRegistryErrorV1 && error.safeCode === "replay_conflict");
    await assert.rejects(() => store.enrollAuthenticated(enrollment, now, { ...binding, tenantId: "tenant:other" }),
      (error: unknown) => error instanceof ConnectionRegistryErrorV1 && error.safeCode === "scope_mismatch");

    const restarted = new ConnectionRegistryStoreV1(db, key);
    assert.equal((await restarted.read({ tenantId, now })).connectionCount, 1);
    const renewal = safeConnection({ enrollmentId: "enrollment:durable:002",
      issuedAt: "2026-09-01T17:56:00.000Z", expiresAt: "2026-09-02T06:00:00.000Z" });
    assert.deepEqual(await store.enrollAuthenticated(renewal, now, binding), { replayed: false, revision: 2 });
    assert.equal((await restarted.read({ tenantId, now })).connections[0]?.enrollmentId, renewal.enrollmentId);
    await createNode(db, "node:second");
    const duplicateRoute = safeConnection({ enrollmentId: "enrollment:duplicate-route", connectionId: "connection:second",
      nodeId: "node:second", profileIdentityDigest: digest("profile-second") });
    await assert.rejects(() => store.enrollAuthenticated(duplicateRoute, now,
      { tenantId, nodeId: duplicateRoute.nodeId, connectionId: duplicateRoute.connectionId }),
    (error: unknown) => error instanceof ConnectionRegistryErrorV1 && error.safeCode === "replay_conflict");

    const telemetry = fleetSignalEnvelopeSchema.parse({ schemaVersion: "1.0.0", tenantId, nodeId: enrollment.nodeId,
      kind: "telemetry", source: "telemetry_port", sequence: 1, observedAt: "2026-09-01T17:59:00.000Z",
      expiresAt: "2026-09-01T18:04:00.000Z", trust: "reported", fingerprint: digest("telemetry"),
      payload: { samplingIntervalSeconds: 60, cpuUtilizationPercent: { quality: "observed", value: 20 },
        availableMemoryBytes: { quality: "observed", value: 10_000 }, availableStorageBytes: { quality: "observed", value: 20_000 },
        networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } });
    await new FleetSignalStore(db).ingestAuthenticated(telemetry, telemetry.observedAt, { tenantId, nodeId: enrollment.nodeId });
    const freshness = new AuthenticatedFleetTelemetryFreshnessSourceV1(db, key);
    const forgedCurrent = await new ConnectionCenterReadServiceV1(restarted, freshness).read({ tenantId, now });
    assert.deepEqual([forgedCurrent.summary.currentSignalCount, forgedCurrent.summary.missingSignalCount,
      forgedCurrent.connections[0]?.signalFreshnessBasis], [0, 1, "none"]);
    await raw.query(`INSERT INTO control_connection_authenticated_telemetry_receipts
      (tenant_id,node_id,signal_sequence,signal_digest,message_id_digest,key_id_digest,connection_id_digest,
       observed_at,expires_at,authenticated_at,receipt_auth_tag) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$7,$9)`,
    [tenantId,enrollment.nodeId,sha256Digest(telemetry),digest("forged-message"),digest("forged-key"),
      digest("forged-connection"),telemetry.observedAt,telemetry.expiresAt,`hmac-sha256:${"0".repeat(64)}`]);
    await assert.rejects(() => new ConnectionCenterReadServiceV1(restarted, freshness).read({ tenantId, now }),
      (error: unknown) => error instanceof ConnectionCenterReadErrorV1 && error.safeCode === "invalid_roster");
    await raw.query(`DELETE FROM control_connection_authenticated_telemetry_receipts WHERE tenant_id=$1`, [tenantId]);
    const receipts = new AuthenticatedTelemetryReceiptStoreV1(db, key);
    await receipts.recordAfterAuthenticatedIngress({ tenantId, nodeId: enrollment.nodeId,
      signalSequence: telemetry.sequence, signalDigest: sha256Digest(telemetry),
      messageId: "message:authenticated:telemetry:001", keyId: "key:authenticated:telemetry",
      connectionId: "connection:authenticated:telemetry", observedAt: telemetry.observedAt,
      expiresAt: telemetry.expiresAt, authenticatedAt: telemetry.observedAt });
    const current = await new ConnectionCenterReadServiceV1(restarted, freshness).read({ tenantId, now });
    assert.deepEqual([current.summary.currentSignalCount, current.summary.staleSignalCount, current.summary.missingSignalCount], [1, 0, 0]);
    assert.deepEqual([current.connections[0]?.signalFreshness, current.connections[0]?.signalFreshnessBasis,
      current.connections[0]?.qualificationState, current.connections[0]?.livePanelState,
      current.connections[0]?.grantsExecutionAuthority], ["current", "authenticated_telemetry", "required", "blocked", false]);
    const stale = await new ConnectionCenterReadServiceV1(restarted, freshness)
      .read({ tenantId, now: "2026-09-01T18:05:00.000Z" });
    assert.deepEqual([stale.summary.currentSignalCount, stale.summary.staleSignalCount], [0, 1]);

    const serialized = JSON.stringify(current);
    for (const protectedValue of [tenantId, enrollment.connectionId, enrollment.nodeId, enrollment.enrollmentId,
      enrollment.connectorRouteDigest, enrollment.profileIdentityDigest, enrollment.issuerKeyDigest]) {
      assert.equal(serialized.includes(protectedValue), false, protectedValue);
    }
    assert.equal(serialized.includes("connection:inventory:001"), true);

    await raw.exec(`DROP TRIGGER control_connection_enrollments_append_only ON control_connection_enrollments`);
    await raw.query(`UPDATE control_connection_enrollments SET result_digest=$1 WHERE tenant_id=$2`, [digest("tampered"), tenantId]);
    await assert.rejects(() => restarted.read({ tenantId, now }),
      (error: unknown) => error instanceof ConnectionRegistryErrorV1 && error.safeCode === "integrity_failed");
  } finally { await raw.close(); }
});

test("CR13A-LIVE-020 reports missing without telemetry instead of inventing liveness", async () => {
  const raw = new PGlite(); await migrate(raw); const db = adaptPglite(raw);
  try {
    await raw.query(`INSERT INTO tenants(id,display_name) VALUES($1,$2)`, [tenantId, "Connection registry"]);
    await createNode(db);
    const key = new Uint8Array(32).fill(8), store = new ConnectionRegistryStoreV1(db, key), enrollment = safeConnection();
    await store.enrollAuthenticated(enrollment, now, { tenantId, nodeId: enrollment.nodeId, connectionId: enrollment.connectionId });
    const discovery = fleetSignalEnvelopeSchema.parse({ schemaVersion: "1.0.0", tenantId, nodeId: enrollment.nodeId,
      kind: "discovery", source: "static_collector", sequence: 1, observedAt: "2026-09-01T17:50:00.000Z",
      expiresAt: "2026-09-02T17:50:00.000Z", trust: "reported", fingerprint: digest("discovery"),
      payload: { platform: "macos", architecture: "arm64", cpuLogicalCores: 10, memoryBytes: 16_000,
        gpuClasses: ["apple-gpu"], storage: [{ capacityBytes: 10_000, availableBytes: 5_000,
          scratchEligible: true, encryptionReported: true }], networkClass: "unmetered", inventory: [],
        executorManifestDigest: digest("executor") } });
    await new FleetSignalStore(db).ingestAuthenticated(discovery, discovery.observedAt, { tenantId, nodeId: enrollment.nodeId });
    const projection = await new ConnectionCenterReadServiceV1(store, new AuthenticatedFleetTelemetryFreshnessSourceV1(db, key))
      .read({ tenantId, now });
    assert.deepEqual([projection.summary.currentSignalCount, projection.summary.staleSignalCount,
      projection.summary.missingSignalCount, projection.connections[0]?.signalFreshnessBasis], [0, 0, 1, "none"]);
    await raw.exec(`DROP TRIGGER control_connection_enrollments_append_only ON control_connection_enrollments`);
    await raw.query(`DELETE FROM control_connection_enrollments WHERE tenant_id=$1`, [tenantId]);
    await assert.rejects(() => store.read({ tenantId, now }),
      (error: unknown) => error instanceof ConnectionRegistryErrorV1 && error.safeCode === "integrity_failed");
  } finally { await raw.close(); }
});

test("CR13A-LIVE-020 rejects behavioral database rows without executing them", async () => {
  const raw = new PGlite(); await migrate(raw); const db = adaptPglite(raw);
  try {
    await raw.query(`INSERT INTO tenants(id,display_name) VALUES($1,$2)`, [tenantId, "Connection registry"]);
    await createNode(db);
    const key = new Uint8Array(32).fill(22), enrollment = safeConnection();
    await new ConnectionRegistryStoreV1(db, key).enrollAuthenticated(enrollment, now,
      { tenantId, nodeId: enrollment.nodeId, connectionId: enrollment.connectionId });
    let traps = 0;
    const wrap = (session: DatabaseSession): DatabaseSession => Object.freeze({
      async query<T = Record<string, unknown>>(statement: string, params: unknown[] = []) {
        const result = await session.query<T>(statement, params);
        if (!statement.includes("FROM control_connection_enrollments")) return result;
        return { rows: result.rows.map((row) => new Proxy(row as object,
          { get() { traps += 1; throw new Error("database row behavior executed"); } }) as T) };
      },
    });
    const behavioralDb: DatabaseClient = Object.freeze({
      query: <T = Record<string, unknown>>(statement: string, params: unknown[] = []) => db.query<T>(statement, params),
      transaction: <T>(callback: (session: DatabaseSession) => Promise<T>) =>
        db.transaction((session) => callback(wrap(session))),
      transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>, check: () => void) =>
        db.transactionWithPreCommitCheck((session) => callback(wrap(session)), check),
    });
    await assert.rejects(() => new ConnectionRegistryStoreV1(behavioralDb, key).read({ tenantId, now }),
      (error: unknown) => error instanceof ConnectionRegistryErrorV1 && error.safeCode === "integrity_failed");
    assert.equal(traps, 0);
  } finally { await raw.close(); }
});
