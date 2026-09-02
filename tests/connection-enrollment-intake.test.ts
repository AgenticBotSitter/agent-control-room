import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  buildConnectionEnrollmentProtectedDeliveryV1,
  ConnectionEnrollmentIntakeErrorV1,
  ConnectionEnrollmentIntakeServiceV1,
  ConnectionRegistryStoreV1,
  type ConnectionEnrollmentProtectedDeliverySourceV1,
} from "../src/connection-registry/v1/index.ts";
import {
  IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  ideaLabHermes021BuiltInConnectionSourceV1,
} from "../src/idea-lab/v1/index.ts";
import {
  NODE_PROTOCOL_V1,
  NodeEnrollmentStore,
  signEnrollmentProof,
  type EnrollmentChallenge,
  type EnrollmentProof,
} from "../src/node-protocol/v1/index.ts";
import { adaptPglite, type DatabaseClient, type DatabaseSession } from "../src/persistence/database.ts";
import { canonicalJson, sha256Digest } from "../src/security/index.ts";

const tenantId = "tenant:connection-intake";
const nodeId = "node:connection-intake";
const keyId = "node-key:connection-intake:1";
const connectionId = "connection:connection-intake";
const deliveryId = "delivery:connection-intake:001";
const issuedAt = "2026-09-01T17:56:00.000Z";
const receivedAt = "2026-09-01T18:00:00.000Z";
const expiresAt = "2026-09-02T05:56:00.000Z";
const digest = (label: string) => sha256Digest({ label });
const registryKey = new Uint8Array(32).fill(41);
const auditKey = new Uint8Array(32).fill(42);

async function migrate(raw: PGlite): Promise<void> {
  for (const file of (await readdir(resolve("db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
}

function unsignedProof(challenge: EnrollmentChallenge, spki: string): Omit<EnrollmentProof, "signature"> {
  return {
    challengeId: challenge.challengeId,
    challengeNonce: challenge.challengeNonce,
    nodeId,
    displayName: "Protected connection intake node",
    nodeClass: "personal-compute",
    publicKey: { keyId, algorithm: "ed25519", spki },
    platformFacts: {
      platform: "macos",
      architecture: "arm64",
      hardwareFingerprint: digest("hardware"),
      softwareFingerprint: digest("software"),
      bridgeVersion: "0.1.0",
      attestation: { source: "local-discovery" },
    },
    supportedProtocols: [NODE_PROTOCOL_V1],
  };
}

async function enrollNode(db: DatabaseClient, privateKey: KeyObject, spki: string): Promise<void> {
  const store = new NodeEnrollmentStore(db, [{ keyId: "server-key:connection-intake", algorithm: "ed25519", spki }]);
  const issued = await store.issueToken({ tenantId, nodeClass: "personal-compute", createdBy: "identity:owner",
    createdAt: "2026-09-01T17:50:00.000Z", tokenId: "enrollment-token:connection-intake" });
  const challenge = await store.createChallenge({ tokenId: issued.tokenId, token: issued.token,
    nodeClass: "personal-compute", supportedProtocols: [NODE_PROTOCOL_V1] },
  "2026-09-01T17:51:00.000Z", "challenge:connection-intake");
  const proof = signEnrollmentProof(unsignedProof(challenge, spki), privateKey);
  const result = await store.complete(proof, { now: "2026-09-01T17:52:00.000Z", policyVersion: "policy:default:v1",
    initialGrant: { nodeClass: "personal-compute", allowedRisk: ["low"] } });
  assert.equal(result.accepted, true);
}

async function fixture() {
  const raw = new PGlite(); await migrate(raw); const db = adaptPglite(raw);
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES($1,$2)`, [tenantId, "Connection intake"]);
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  await enrollNode(db, keys.privateKey, spki);
  return { raw, db, keys, spki };
}

function envelope(privateKey: KeyObject, spki: string, changes: Record<string, unknown> = {}) {
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
    enrollmentId: "enrollment:connection-intake:001",
    connectionId,
    tenantId,
    nodeId,
    runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
    route: {
      transport: "ssh_tunnel" as const,
      sshHostKeyFingerprintDigest: digest("owner-verified-host-key"),
      sshPublicKeyOnly: true as const,
      sshBatchMode: true as const,
      ownerVerifiedFirstHostKey: true as const,
      hostKeyChangesFailClosed: true as const,
    },
    connectorRouteDigest: digest("connector-route"),
    profileIdentityDigest: digest("profile-identity"),
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
    toolsEnabled: false as const,
    mcpEnabled: false as const,
    pluginsEnabled: false as const,
    gatewayStartsMade: 0 as const,
    providerCallsMade: 0 as const,
    issuedAt,
    expiresAt,
    ...changes,
  };
  const body = { ...material, bodyDigest: sha256Digest(material) };
  return { body, attestation: { algorithm: "ed25519" as const, keyId, publicKeySpki: spki,
    signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url") } };
}

class FixedSource implements ConnectionEnrollmentProtectedDeliverySourceV1 {
  calls = 0;
  constructor(readonly value: unknown, readonly expectedDeliveryId = deliveryId) {}
  async read(input: { deliveryId: string; receivedAt: string }): Promise<unknown> {
    this.calls += 1;
    assert.deepEqual(input, { deliveryId: this.expectedDeliveryId, receivedAt });
    return this.value;
  }
}

function service(db: DatabaseClient, source: ConnectionEnrollmentProtectedDeliverySourceV1,
  selectedAuditKey = auditKey): ConnectionEnrollmentIntakeServiceV1 {
  return new ConnectionEnrollmentIntakeServiceV1(db, registryKey, selectedAuditKey, source);
}

test("CR13A-LIVE-030 verifies an authenticated delivery, persists it atomically, and replays exactly", async () => {
  const { raw, db, keys, spki } = await fixture();
  try {
    const signed = envelope(keys.privateKey, spki);
    const delivery = buildConnectionEnrollmentProtectedDeliveryV1({ deliveryId, authenticatedAt: receivedAt,
      envelope: signed });
    const source = new FixedSource(delivery), intake = service(db, source);
    const first = await intake.ingest({ deliveryId, receivedAt });
    assert.equal(first.replayed, false);
    assert.deepEqual([first.receipt.disposition, first.receipt.registryRevision, first.receipt.grantsApproval,
      first.receipt.grantsNetworkAuthority, first.receipt.grantsCommandAuthority,
      first.receipt.grantsLeaseAuthority, first.receipt.grantsExecutionAuthority],
    ["accepted", 1, false, false, false, false, false]);
    assert.equal(first.receipt.deliveryEvidenceDigest, delivery.deliveryEvidenceDigest);
    const serialized = JSON.stringify(first.receipt);
    for (const protectedValue of [tenantId, nodeId, keyId, connectionId, signed.body.enrollmentId, spki,
      signed.attestation.signature]) assert.equal(serialized.includes(protectedValue), false, protectedValue);

    const roster = await new ConnectionRegistryStoreV1(db, registryKey).read({ tenantId, now: receivedAt });
    assert.deepEqual([roster.connectionCount, roster.connections[0]?.resultDigest],
      [1, first.receipt.enrollmentResultDigest]);
    const replay = await intake.ingest({ deliveryId, receivedAt });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, first.receipt);
    await raw.query(`UPDATE control_node_keys SET state='revoked',valid_until=$1,revoked_at=$1
      WHERE tenant_id=$2 AND node_id=$3 AND id=$4`, [receivedAt, tenantId, nodeId, keyId]);
    const replayAfterRevocation = await intake.ingest({ deliveryId, receivedAt });
    assert.equal(replayAfterRevocation.replayed, true);
    assert.deepEqual(replayAfterRevocation.receipt, first.receipt);
    assert.equal(source.calls, 3);
    const counts = await raw.query<{ enrollments: number; receipts: number; heads: number }>(`SELECT
      (SELECT count(*)::int FROM control_connection_enrollments) AS enrollments,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS receipts,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_heads) AS heads`);
    assert.deepEqual(counts.rows[0], { enrollments: 1, receipts: 1, heads: 1 });

    const changedDelivery = buildConnectionEnrollmentProtectedDeliveryV1({
      deliveryId: "delivery:connection-intake:changed", authenticatedAt: receivedAt, envelope: signed });
    await assert.rejects(() => service(db, new FixedSource(changedDelivery,
      "delivery:connection-intake:changed")).ingest({
      deliveryId: "delivery:connection-intake:changed", receivedAt,
    }), (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
      && error.safeCode === "replay_conflict");

    const afterRevocationEnvelope = envelope(keys.privateKey, spki, {
      enrollmentId: "enrollment:connection-intake:after-revocation",
      connectionId: "connection:connection-intake:after-revocation",
      connectorRouteDigest: digest("connector-route-after-revocation"),
      profileIdentityDigest: digest("profile-identity-after-revocation"),
    });
    const afterRevocation = buildConnectionEnrollmentProtectedDeliveryV1({
      deliveryId: "delivery:connection-intake:after-revocation", authenticatedAt: receivedAt,
      envelope: afterRevocationEnvelope,
    });
    await assert.rejects(() => service(db, new FixedSource(afterRevocation,
      "delivery:connection-intake:after-revocation")).ingest({
      deliveryId: "delivery:connection-intake:after-revocation", receivedAt,
    }), (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
      && error.safeCode === "unauthenticated_delivery");
  } finally { await raw.close(); }
});

test("CR13A-LIVE-030 serializes concurrent independent enrollments into one verified audit chain", async () => {
  const { raw, db, keys, spki } = await fixture();
  try {
    const candidates = [2, 3].map((sequence) => {
      const selectedDeliveryId = `delivery:connection-intake:00${sequence}`;
      const signed = envelope(keys.privateKey, spki, {
        enrollmentId: `enrollment:connection-intake:00${sequence}`,
        connectionId: `connection:connection-intake:00${sequence}`,
        connectorRouteDigest: digest(`connector-route-${sequence}`),
        profileIdentityDigest: digest(`profile-identity-${sequence}`),
      });
      const delivery = buildConnectionEnrollmentProtectedDeliveryV1({ deliveryId: selectedDeliveryId,
        authenticatedAt: receivedAt, envelope: signed });
      return service(db, new FixedSource(delivery, selectedDeliveryId)).ingest({
        deliveryId: selectedDeliveryId, receivedAt,
      });
    });
    const results = await Promise.all(candidates);
    assert.deepEqual(results.map((result) => [result.replayed, result.receipt.registryRevision]),
      [[false, 1], [false, 1]]);
    const roster = await new ConnectionRegistryStoreV1(db, registryKey).read({ tenantId, now: receivedAt });
    assert.equal(roster.connectionCount, 2);
    const rows = await raw.query<{ sequence: number; previous_audit_record_digest: string | null }>(
      `SELECT sequence,previous_audit_record_digest FROM control_connection_enrollment_intake_receipts ORDER BY sequence`);
    assert.deepEqual(rows.rows.map((row) => Number(row.sequence)), [1, 2]);
    assert.equal(rows.rows[0]?.previous_audit_record_digest, null);
    assert.match(rows.rows[1]?.previous_audit_record_digest ?? "", /^sha256:[a-f0-9]{64}$/);
    const head = await raw.query<{ last_sequence: number }>(
      `SELECT last_sequence FROM control_connection_enrollment_intake_heads WHERE tenant_id=$1`, [tenantId]);
    assert.equal(Number(head.rows[0]?.last_sequence), 2);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-030 rejects untrusted, cross-scope, behavioral, expired, and unavailable delivery evidence", async () => {
  const { raw, db, keys, spki } = await fixture();
  try {
    const exact = buildConnectionEnrollmentProtectedDeliveryV1({ deliveryId, authenticatedAt: receivedAt,
      envelope: envelope(keys.privateKey, spki) });
    const wrongKeys = generateKeyPairSync("ed25519");
    const wrongSpki = wrongKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const untrusted = buildConnectionEnrollmentProtectedDeliveryV1({ deliveryId, authenticatedAt: receivedAt,
      envelope: envelope(wrongKeys.privateKey, wrongSpki) });
    await assert.rejects(() => service(db, new FixedSource(untrusted)).ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "unauthenticated_delivery");

    const crossScopeEnvelope = envelope(keys.privateKey, spki, { nodeId: "node:other" });
    const crossScope = buildConnectionEnrollmentProtectedDeliveryV1({ deliveryId, authenticatedAt: receivedAt,
      envelope: crossScopeEnvelope });
    await assert.rejects(() => service(db, new FixedSource(crossScope)).ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "unauthenticated_delivery");

    const expired = buildConnectionEnrollmentProtectedDeliveryV1({ deliveryId, authenticatedAt: receivedAt,
      envelope: envelope(keys.privateKey, spki, { expiresAt: "2026-09-01T17:59:59.000Z" }) });
    await assert.rejects(() => service(db, new FixedSource(expired)).ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "unauthenticated_delivery");

    let traps = 0;
    const behavioral = { ...exact };
    Object.defineProperty(behavioral, "deliveryId", { enumerable: true,
      get() { traps += 1; throw new Error("behavior executed"); } });
    await assert.rejects(() => service(db, new FixedSource(behavioral)).ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "unauthenticated_delivery");
    assert.equal(traps, 0);

    await assert.rejects(() => service(db, { async read() { throw new Error("offline"); } }).ingest({
      deliveryId, receivedAt,
    }), (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
      && error.safeCode === "source_unavailable");
    const counts = await raw.query<{ enrollments: number; receipts: number }>(`SELECT
      (SELECT count(*)::int FROM control_connection_enrollments) AS enrollments,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS receipts`);
    assert.deepEqual(counts.rows[0], { enrollments: 0, receipts: 0 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-030 rolls registry persistence back when audit evidence cannot commit", async () => {
  const { raw, db, keys, spki } = await fixture();
  try {
    const delivery = buildConnectionEnrollmentProtectedDeliveryV1({ deliveryId, authenticatedAt: receivedAt,
      envelope: envelope(keys.privateKey, spki) });
    const intake = service(db, new FixedSource(delivery));
    await raw.exec(`CREATE FUNCTION reject_connection_intake_test() RETURNS trigger AS $$ BEGIN
      RAISE EXCEPTION 'injected intake failure'; END; $$ LANGUAGE plpgsql`);
    await raw.exec(`CREATE TRIGGER reject_connection_intake_test BEFORE INSERT
      ON control_connection_enrollment_intake_receipts FOR EACH ROW EXECUTE FUNCTION reject_connection_intake_test()`);
    await assert.rejects(() => intake.ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "integrity_failed");
    let counts = await raw.query<{ enrollments: number; receipts: number }>(`SELECT
      (SELECT count(*)::int FROM control_connection_enrollments) AS enrollments,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS receipts`);
    assert.deepEqual(counts.rows[0], { enrollments: 0, receipts: 0 });
    await raw.exec(`DROP TRIGGER reject_connection_intake_test ON control_connection_enrollment_intake_receipts`);
    assert.equal((await intake.ingest({ deliveryId, receivedAt })).replayed, false);
    counts = await raw.query<{ enrollments: number; receipts: number }>(`SELECT
      (SELECT count(*)::int FROM control_connection_enrollments) AS enrollments,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS receipts`);
    assert.deepEqual(counts.rows[0], { enrollments: 1, receipts: 1 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-030 detects audit mutation, deletion, wrong keys, and behavioral database rows", async () => {
  const { raw, db, keys, spki } = await fixture();
  try {
    const delivery = buildConnectionEnrollmentProtectedDeliveryV1({ deliveryId, authenticatedAt: receivedAt,
      envelope: envelope(keys.privateKey, spki) });
    const source = new FixedSource(delivery), intake = service(db, source);
    await intake.ingest({ deliveryId, receivedAt });
    await assert.rejects(() => service(db, source, new Uint8Array(32).fill(99)).ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "integrity_failed");

    let traps = 0;
    const wrap = (session: DatabaseSession): DatabaseSession => Object.freeze({
      async query<T = Record<string, unknown>>(statement: string, params: unknown[] = []) {
        const result = await session.query<T>(statement, params);
        if (!statement.includes("control_connection_enrollment_intake_receipts")) return result;
        return { rows: result.rows.map((row) => new Proxy(row as object,
          { get() { traps += 1; throw new Error("database behavior executed"); } }) as T) };
      },
    });
    const behavioralDb: DatabaseClient = Object.freeze({
      query: <T = Record<string, unknown>>(statement: string, params: unknown[] = []) => db.query<T>(statement, params),
      transaction: <T>(callback: (session: DatabaseSession) => Promise<T>) =>
        db.transaction((session) => callback(wrap(session))),
      transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>, check: () => void) =>
        db.transactionWithPreCommitCheck((session) => callback(wrap(session)), check),
    });
    await assert.rejects(() => service(behavioralDb, source).ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "integrity_failed");
    assert.equal(traps, 0);

    await raw.exec(`DROP TRIGGER control_connection_enrollment_intake_receipts_append_only
      ON control_connection_enrollment_intake_receipts`);
    await raw.query(`UPDATE control_connection_enrollment_intake_receipts SET payload_digest=$1 WHERE tenant_id=$2`,
      [digest("tampered"), tenantId]);
    await assert.rejects(() => intake.ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "integrity_failed");
    await raw.query(`DELETE FROM control_connection_enrollment_intake_receipts WHERE tenant_id=$1`, [tenantId]);
    await assert.rejects(() => intake.ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "integrity_failed");
  } finally { await raw.close(); }
});

test("CR13A-LIVE-030 exposes no browser or HTTP enrollment mutation path", async () => {
  const connectionRoute = await readFile(resolve("app/api/v1/connections/route.ts"), "utf8");
  const appRuntime = await readFile(resolve("app/control-room-local-pilot-runtime.ts"), "utf8");
  assert.doesNotMatch(connectionRoute, /\bPOST\b|ConnectionEnrollmentIntake|connectionEnrollmentIntake/);
  assert.doesNotMatch(appRuntime, /ConnectionEnrollmentIntake|connectionEnrollmentIntake/);
  assert.match(connectionRoute, /export const GET/);
});
