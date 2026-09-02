import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  ConnectionEnrollmentIntakeErrorV1,
  ConnectionEnrollmentIntakeServiceV1,
  ConnectionEnrollmentNodeDeliveryErrorV1,
  ConnectionRegistryStoreV1,
  DatabaseConnectionEnrollmentNodeDeliveryAdapterV1,
} from "../src/connection-registry/v1/index.ts";
import {
  IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  ideaLabHermes021BuiltInConnectionSourceV1,
} from "../src/idea-lab/v1/index.ts";
import {
  DatabaseNodeKeyResolver,
  DatabaseReplayGuard,
  FixedWindowProtocolRateLimiter,
  NODE_PROTOCOL_V1,
  NodeEnrollmentStore,
  NodeProtocolAuthenticator,
  signEnrollmentProof,
  signNodeFrame,
  type EnrollmentChallenge,
  type EnrollmentProof,
  type SignedNodeFrame,
  type UnsignedNodeFrame,
} from "../src/node-protocol/v1/index.ts";
import { adaptPglite, type DatabaseClient, type DatabaseSession } from "../src/persistence/database.ts";
import { canonicalJson, sha256Digest } from "../src/security/index.ts";

const tenantId = "tenant:node-delivery";
const nodeId = "node:node-delivery";
const keyId = "node-key:node-delivery:1";
const connectionId = "connection:node-delivery";
const deliveryId = "delivery:node-delivery:001";
const enrollmentId = "enrollment:node-delivery:001";
const enrolledAt = "2026-09-01T17:52:00.000Z";
const issuedAt = "2026-09-01T17:56:00.000Z";
const helloAt = "2026-09-01T17:59:00.000Z";
const receivedAt = "2026-09-01T18:00:00.000Z";
const retryReceivedAt = "2026-09-01T18:00:01.000Z";
const frameExpiresAt = "2026-09-01T18:02:00.000Z";
const enrollmentExpiresAt = "2026-09-02T05:56:00.000Z";
const digest = (label: string) => sha256Digest({ label });
const deliveryKey = new Uint8Array(32).fill(61);
const registryKey = new Uint8Array(32).fill(62);
const intakeKey = new Uint8Array(32).fill(63);

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
    displayName: "Authenticated delivery node",
    nodeClass: "personal-compute",
    publicKey: { keyId, algorithm: "ed25519", spki },
    platformFacts: {
      platform: "macos",
      architecture: "arm64",
      hardwareFingerprint: digest("delivery-hardware"),
      softwareFingerprint: digest("delivery-software"),
      bridgeVersion: "0.1.0",
      attestation: { source: "local-discovery" },
    },
    supportedProtocols: [NODE_PROTOCOL_V1],
  };
}

async function enrollNode(db: DatabaseClient, privateKey: KeyObject, spki: string): Promise<void> {
  const store = new NodeEnrollmentStore(db, [{ keyId: "server-key:node-delivery", algorithm: "ed25519", spki }]);
  const issued = await store.issueToken({ tenantId, nodeClass: "personal-compute", createdBy: "identity:owner",
    createdAt: "2026-09-01T17:50:00.000Z", tokenId: "enrollment-token:node-delivery" });
  const challenge = await store.createChallenge({ tokenId: issued.tokenId, token: issued.token,
    nodeClass: "personal-compute", supportedProtocols: [NODE_PROTOCOL_V1] },
  "2026-09-01T17:51:00.000Z", "challenge:node-delivery");
  const result = await store.complete(signEnrollmentProof(unsignedProof(challenge, spki), privateKey), {
    now: enrolledAt,
    policyVersion: "policy:default:v1",
    initialGrant: { nodeClass: "personal-compute", allowedRisk: ["low"] },
  });
  assert.equal(result.accepted, true);
}

function enrollmentEnvelope(privateKey: KeyObject, spki: string, changes: Record<string, unknown> = {}) {
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
    enrollmentId,
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
    expiresAt: enrollmentExpiresAt,
    ...changes,
  };
  const body = { ...material, bodyDigest: sha256Digest(material) };
  return { body, attestation: { algorithm: "ed25519" as const, keyId, publicKeySpki: spki,
    signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url") } };
}

function helloFrame(privateKey: KeyObject): SignedNodeFrame<"connection.hello"> {
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1,
    direction: "node_to_server",
    messageId: "message:node-delivery:hello:1",
    correlationId: "correlation:node-delivery",
    tenantId,
    actorId: nodeId,
    senderKind: "node",
    keyId,
    connectionId,
    sequence: 1,
    sentAt: helloAt,
    expiresAt: frameExpiresAt,
    nonce: "nonce_node_delivery_hello_1234567890",
    type: "connection.hello",
    body: { supportedProtocols: [NODE_PROTOCOL_V1], features: ["connection-enrollment-delivery"],
      requestedMaxFrameBytes: 262_144, lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [] },
  }, privateKey);
}

function deliveryFrame(privateKey: KeyObject, spki: string, options: {
  envelope?: ReturnType<typeof enrollmentEnvelope>;
  deliveryId?: string;
  messageId?: string;
  nonce?: string;
  sequence?: number;
  enrollmentContract?: string;
} = {}): SignedNodeFrame<"connection.enrollment.deliver"> {
  const envelope = options.envelope ?? enrollmentEnvelope(privateKey, spki);
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1,
    direction: "node_to_server",
    messageId: options.messageId ?? "message:node-delivery:enrollment:2",
    correlationId: "correlation:node-delivery",
    causationId: "message:node-delivery:hello:1",
    tenantId,
    actorId: nodeId,
    senderKind: "node",
    keyId,
    connectionId,
    sequence: options.sequence ?? 2,
    sentAt: receivedAt,
    expiresAt: frameExpiresAt,
    nonce: options.nonce ?? "nonce_node_delivery_enrollment_12345",
    type: "connection.enrollment.deliver",
    body: {
      deliveryId: options.deliveryId ?? deliveryId,
      enrollmentContract: options.enrollmentContract ?? IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
      envelopeDigest: sha256Digest(envelope),
      envelope,
    },
  } as UnsignedNodeFrame<"connection.enrollment.deliver">, privateKey);
}

async function fixture() {
  const raw = new PGlite();
  await migrate(raw);
  const db = adaptPglite(raw);
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES($1,$2)`, [tenantId, "Node delivery"]);
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  await enrollNode(db, keys.privateKey, spki);
  const helloAuthenticator = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(db),
    new DatabaseReplayGuard(db), new FixedWindowProtocolRateLimiter(100, 60));
  await helloAuthenticator.verify(JSON.stringify(helloFrame(keys.privateKey)), {
    expectedDirection: "node_to_server", receivedAt, transportIdentity: "transport:node-delivery-test",
  });
  const adapter = new DatabaseConnectionEnrollmentNodeDeliveryAdapterV1(db, deliveryKey,
    new FixedWindowProtocolRateLimiter(100, 60));
  return { raw, db, keys, spki, adapter };
}

function deliveryOptions(observedAt = receivedAt) {
  return { receivedAt: observedAt, transportIdentity: "transport:node-delivery-test" };
}

test("CR13A-LIVE-040 authenticates, persists, replays, and feeds the independently verified intake", async () => {
  const { raw, db, keys, spki, adapter } = await fixture();
  try {
    const frame = deliveryFrame(keys.privateKey, spki);
    const innerEnvelope = frame.body.envelope as ReturnType<typeof enrollmentEnvelope>;
    const first = await adapter.deliver(JSON.stringify(frame), deliveryOptions());
    assert.deepEqual([first.protocolDisposition, first.ledgerDisposition, first.grantsApproval,
      first.grantsNetworkAuthority, first.grantsCommandAuthority, first.grantsLeaseAuthority,
      first.grantsExecutionAuthority], ["accepted", "accepted", false, false, false, false, false]);
    const serializedReceipt = JSON.stringify(first);
    for (const protectedValue of [tenantId,nodeId,keyId,connectionId,deliveryId,enrollmentId,spki,
      frame.signature,innerEnvelope.attestation.signature]) {
      assert.equal(serializedReceipt.includes(protectedValue), false, protectedValue);
    }
    const replay = await adapter.deliver(JSON.stringify(frame), deliveryOptions(retryReceivedAt));
    assert.deepEqual(replay, first, "response-loss replay must return the original safe receipt");

    const intake = new ConnectionEnrollmentIntakeServiceV1(db, registryKey, intakeKey, adapter);
    const ingested = await intake.ingest({ deliveryId, receivedAt });
    assert.equal(ingested.replayed, false);
    assert.equal((await intake.ingest({ deliveryId, receivedAt })).replayed, true);
    const roster = await new ConnectionRegistryStoreV1(db, registryKey).read({ tenantId, now: receivedAt });
    assert.deepEqual([roster.connectionCount, roster.connections[0]?.connectionId], [1, connectionId]);
    const counts = await raw.query<{ deliveries: number; delivery_heads: number; intake: number; connections: number }>(
      `SELECT (SELECT count(*)::int FROM control_connection_enrollment_protocol_deliveries) AS deliveries,
      (SELECT count(*)::int FROM control_connection_enrollment_delivery_heads) AS delivery_heads,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS intake,
      (SELECT count(*)::int FROM control_connection_enrollments) AS connections`);
    assert.deepEqual(counts.rows[0], { deliveries: 1, delivery_heads: 1, intake: 1, connections: 1 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-040 independently rejects forged outer frames and invalid inner enrollment signatures", async () => {
  const first = await fixture();
  try {
    const attacker = generateKeyPairSync("ed25519");
    const forged = deliveryFrame(attacker.privateKey, first.spki,
      { envelope: enrollmentEnvelope(first.keys.privateKey, first.spki) });
    await assert.rejects(() => first.adapter.deliver(JSON.stringify(forged), deliveryOptions()),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeDeliveryErrorV1
        && error.safeCode === "authentication_failed");
    assert.equal((await first.raw.query(`SELECT delivery_id FROM control_connection_enrollment_protocol_deliveries`))
      .rows.length, 0);
  } finally { await first.raw.close(); }

  const second = await fixture();
  try {
    const invalidInner = enrollmentEnvelope(second.keys.privateKey, second.spki);
    invalidInner.attestation.signature = "A".repeat(86);
    const frame = deliveryFrame(second.keys.privateKey, second.spki, { envelope: invalidInner });
    assert.equal((await second.adapter.deliver(JSON.stringify(frame), deliveryOptions())).ledgerDisposition, "accepted");
    const intake = new ConnectionEnrollmentIntakeServiceV1(second.db, registryKey, intakeKey, second.adapter);
    await assert.rejects(() => intake.ingest({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentIntakeErrorV1
        && error.safeCode === "unauthenticated_delivery");
    assert.equal((await second.raw.query(`SELECT connection_id FROM control_connection_enrollments`)).rows.length, 0);
  } finally { await second.raw.close(); }
});

test("CR13A-LIVE-040 recovers a post-authentication ledger failure through exact protocol replay", async () => {
  const { raw, keys, spki, adapter } = await fixture();
  try {
    const frame = deliveryFrame(keys.privateKey, spki);
    await raw.exec(`CREATE FUNCTION reject_node_delivery_test() RETURNS trigger AS $$ BEGIN
      RAISE EXCEPTION 'injected delivery failure'; END; $$ LANGUAGE plpgsql`);
    await raw.exec(`CREATE TRIGGER reject_node_delivery_test BEFORE INSERT
      ON control_connection_enrollment_protocol_deliveries FOR EACH ROW EXECUTE FUNCTION reject_node_delivery_test()`);
    await assert.rejects(() => adapter.deliver(JSON.stringify(frame), deliveryOptions()),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeDeliveryErrorV1
        && error.safeCode === "integrity_failed");
    assert.equal((await raw.query(`SELECT delivery_id FROM control_connection_enrollment_protocol_deliveries`))
      .rows.length, 0);
    await raw.exec(`DROP TRIGGER reject_node_delivery_test ON control_connection_enrollment_protocol_deliveries`);
    const recovered = await adapter.deliver(JSON.stringify(frame), deliveryOptions(retryReceivedAt));
    assert.deepEqual([recovered.protocolDisposition,recovered.ledgerDisposition,recovered.receivedAt],
      ["duplicate", "accepted", receivedAt]);
    const exactReplay = await adapter.deliver(JSON.stringify(frame),
      deliveryOptions("2026-09-01T18:00:02.000Z"));
    assert.deepEqual(exactReplay, recovered, "recovered ledger replay must return its original safe receipt");
  } finally { await raw.close(); }
});

test("CR13A-LIVE-040 rejects invalid delivery IDs before replay and accepts the exact bounds", async () => {
  const invalid = await fixture();
  try {
    const before = (await invalid.raw.query(`SELECT message_id FROM node_protocol_replay`)).rows.length;
    for (const candidate of ["aa", "d".repeat(161)]) {
      const otherwiseValid = deliveryFrame(invalid.keys.privateKey, invalid.spki);
      const malformed = { ...otherwiseValid, body: { ...otherwiseValid.body, deliveryId: candidate } };
      await assert.rejects(() => invalid.adapter.deliver(
        JSON.stringify(malformed),
        deliveryOptions()), (error: unknown) => error instanceof ConnectionEnrollmentNodeDeliveryErrorV1
          && error.safeCode === "authentication_failed");
      assert.equal((await invalid.raw.query(`SELECT message_id FROM node_protocol_replay`)).rows.length, before);
    }
  } finally { await invalid.raw.close(); }

  for (const candidate of ["abc", "d".repeat(160)]) {
    const accepted = await fixture();
    try {
      const receipt = await accepted.adapter.deliver(JSON.stringify(
        deliveryFrame(accepted.keys.privateKey, accepted.spki, { deliveryId: candidate })), deliveryOptions());
      assert.equal(receipt.ledgerDisposition, "accepted");
      assert.equal((await accepted.raw.query(`SELECT delivery_id FROM control_connection_enrollment_protocol_deliveries
        WHERE delivery_id=$1`, [candidate])).rows.length, 1);
    } finally { await accepted.raw.close(); }
  }
});

test("CR13A-LIVE-040 rejects conflicting delivery identity and detects durable-ledger damage", async () => {
  const { raw, keys, spki, adapter } = await fixture();
  try {
    await adapter.deliver(JSON.stringify(deliveryFrame(keys.privateKey, spki)), deliveryOptions());
    const conflict = deliveryFrame(keys.privateKey, spki, {
      messageId: "message:node-delivery:enrollment:3",
      nonce: "nonce_node_delivery_enrollment_conflict",
      sequence: 3,
    });
    await assert.rejects(() => adapter.deliver(JSON.stringify(conflict), deliveryOptions()),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeDeliveryErrorV1
        && error.safeCode === "replay_conflict");
    assert.equal((await raw.query(`SELECT delivery_id FROM control_connection_enrollment_protocol_deliveries`))
      .rows.length, 1);

    await raw.exec(`DROP TRIGGER control_connection_enrollment_protocol_deliveries_append_only
      ON control_connection_enrollment_protocol_deliveries`);
    await raw.query(`UPDATE control_connection_enrollment_protocol_deliveries SET payload_digest=$1
      WHERE delivery_id=$2`, [digest("tampered-delivery"), deliveryId]);
    await assert.rejects(() => adapter.read({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeDeliveryErrorV1
        && error.safeCode === "integrity_failed");
  } finally { await raw.close(); }
});

test("CR13A-LIVE-040 rejects forged tags under post-import ambient mutation without calling replacements", async () => {
  const { raw, db, keys, spki, adapter } = await fixture();
  try {
    await adapter.deliver(JSON.stringify(deliveryFrame(keys.privateKey, spki)), deliveryOptions());
    const wrongKey = new DatabaseConnectionEnrollmentNodeDeliveryAdapterV1(db,
      new Uint8Array(32).fill(99), new FixedWindowProtocolRateLimiter(100, 60));
    await assert.rejects(() => wrongKey.read({ deliveryId, receivedAt }),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeDeliveryErrorV1
        && error.safeCode === "integrity_failed");

    const mutationTargets: Array<[object, PropertyKey]> = [
      [Buffer, "from"], [RegExp.prototype, "exec"], [Date, "parse"], [JSON, "stringify"],
      [Object, "freeze"], [Object, "getOwnPropertyDescriptor"], [Number, "isSafeInteger"],
      [Reflect, "apply"], [Array.prototype, "map"], [Set.prototype, "has"],
    ];
    for (const [target, key] of mutationTargets) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      assert.ok(descriptor && "value" in descriptor);
      let ambientCalls = 0;
      let pending: Promise<unknown> | undefined;
      Object.defineProperty(target, key, { ...descriptor, value: function replacement() {
        ambientCalls += 1;
        return undefined;
      } });
      try { pending = wrongKey.read({ deliveryId, receivedAt }); }
      finally { Object.defineProperty(target, key, descriptor); }
      await assert.rejects(pending, (error: unknown) => error instanceof ConnectionEnrollmentNodeDeliveryErrorV1
        && error.safeCode === "integrity_failed");
      assert.equal(ambientCalls, 0, `${String(key)} replacement must never execute`);
    }
  } finally { await raw.close(); }
});

test("CR13A-LIVE-040 executes no behavioral database row and adds no browser or HTTP mutation", async () => {
  const { raw, db, keys, spki } = await fixture();
  try {
    let traps = 0;
    const wrapResult = <T>(statement: string, result: { rows: T[] }) => statement.includes("control_node_keys")
      ? { rows: result.rows.map((row) => new Proxy(row as object,
        { get() { traps += 1; throw new Error("database behavior executed"); } }) as T) }
      : result;
    const wrapSession = (session: DatabaseSession): DatabaseSession => Object.freeze({
      async query<T = Record<string, unknown>>(statement: string, params: unknown[] = []) {
        return wrapResult(statement, await session.query<T>(statement, params));
      },
    });
    const behavioralDb: DatabaseClient = Object.freeze({
      async query<T = Record<string, unknown>>(statement: string, params: unknown[] = []) {
        return wrapResult(statement, await db.query<T>(statement, params));
      },
      transaction: <T>(callback: (session: DatabaseSession) => Promise<T>) =>
        db.transaction((session) => callback(wrapSession(session))),
      transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>, check: () => void) =>
        db.transactionWithPreCommitCheck((session) => callback(wrapSession(session)), check),
    });
    const adapter = new DatabaseConnectionEnrollmentNodeDeliveryAdapterV1(behavioralDb, deliveryKey,
      new FixedWindowProtocolRateLimiter(100, 60));
    await assert.rejects(() => adapter.deliver(JSON.stringify(deliveryFrame(keys.privateKey, spki)), deliveryOptions()),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeDeliveryErrorV1
        && error.safeCode === "integrity_failed");
    assert.equal(traps, 0);

    const connectionRoute = await readFile(resolve("app/api/v1/connections/route.ts"), "utf8");
    const appRuntime = await readFile(resolve("app/control-room-local-pilot-runtime.ts"), "utf8");
    assert.doesNotMatch(connectionRoute, /NodeDeliveryAdapter|connection\.enrollment\.deliver|\bPOST\b/);
    assert.doesNotMatch(appRuntime, /NodeDeliveryAdapter|connection\.enrollment\.deliver/);
  } finally { await raw.close(); }
});
