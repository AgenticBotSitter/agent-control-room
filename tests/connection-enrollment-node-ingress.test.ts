import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  ConnectionEnrollmentNodeIngressErrorV1,
  DatabaseConnectionEnrollmentNodeIngressV1,
  DisabledConnectionEnrollmentNodeIngressV1,
  parseConnectionEnrollmentNodeIngressReceiptV1,
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

const tenantId = "tenant:node-ingress";
const nodeId = "node:node-ingress";
const keyId = "node-key:node-ingress:1";
const connectionId = "connection:node-ingress";
const deliveryId = "delivery:node-ingress:001";
const enrollmentId = "enrollment:node-ingress:001";
const enrolledAt = "2026-09-02T05:00:00.000Z";
const issuedAt = "2026-09-02T05:04:00.000Z";
const helloAt = "2026-09-02T05:07:00.000Z";
const receivedAt = "2026-09-02T05:08:00.000Z";
const retryAt = "2026-09-02T05:08:10.000Z";
const frameExpiresAt = "2026-09-02T05:10:00.000Z";
const enrollmentExpiresAt = "2026-09-03T05:04:00.000Z";
const digest = (label: string) => sha256Digest({ label });
const deliveryKey = new Uint8Array(32).fill(71);
const registryKey = new Uint8Array(32).fill(72);
const intakeKey = new Uint8Array(32).fill(73);

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
    displayName: "Authenticated ingress node",
    nodeClass: "personal-compute",
    publicKey: { keyId, algorithm: "ed25519", spki },
    platformFacts: {
      platform: "macos",
      architecture: "arm64",
      hardwareFingerprint: digest("ingress-hardware"),
      softwareFingerprint: digest("ingress-software"),
      bridgeVersion: "0.1.0",
      attestation: { source: "local-discovery" },
    },
    supportedProtocols: [NODE_PROTOCOL_V1],
  };
}

async function enrollNode(db: DatabaseClient, privateKey: KeyObject, spki: string): Promise<void> {
  const store = new NodeEnrollmentStore(db, [{ keyId: "server-key:node-ingress", algorithm: "ed25519", spki }]);
  const issued = await store.issueToken({ tenantId, nodeClass: "personal-compute", createdBy: "identity:owner",
    createdAt: "2026-09-02T04:58:00.000Z", tokenId: "enrollment-token:node-ingress" });
  const challenge = await store.createChallenge({ tokenId: issued.tokenId, token: issued.token,
    nodeClass: "personal-compute", supportedProtocols: [NODE_PROTOCOL_V1] },
  "2026-09-02T04:59:00.000Z", "challenge:node-ingress");
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
    messageId: "message:node-ingress:hello:1",
    correlationId: "correlation:node-ingress",
    tenantId,
    actorId: nodeId,
    senderKind: "node",
    keyId,
    connectionId,
    sequence: 1,
    sentAt: helloAt,
    expiresAt: frameExpiresAt,
    nonce: "nonce_node_ingress_hello_1234567890",
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
} = {}): SignedNodeFrame<"connection.enrollment.deliver"> {
  const envelope = options.envelope ?? enrollmentEnvelope(privateKey, spki);
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1,
    direction: "node_to_server",
    messageId: options.messageId ?? "message:node-ingress:enrollment:2",
    correlationId: "correlation:node-ingress",
    causationId: "message:node-ingress:hello:1",
    tenantId,
    actorId: nodeId,
    senderKind: "node",
    keyId,
    connectionId,
    sequence: options.sequence ?? 2,
    sentAt: receivedAt,
    expiresAt: frameExpiresAt,
    nonce: options.nonce ?? "nonce_node_ingress_enrollment_12345",
    type: "connection.enrollment.deliver",
    body: {
      deliveryId: options.deliveryId ?? deliveryId,
      enrollmentContract: IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
      envelopeDigest: sha256Digest(envelope),
      envelope,
    },
  } as UnsignedNodeFrame<"connection.enrollment.deliver">, privateKey);
}

async function fixture(options: { wrapDatabase?: (db: DatabaseClient) => DatabaseClient } = {}) {
  const raw = new PGlite();
  await migrate(raw);
  const db = adaptPglite(raw);
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES($1,$2)`, [tenantId, "Node ingress"]);
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  await enrollNode(db, keys.privateKey, spki);
  const helloAuthenticator = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(db),
    new DatabaseReplayGuard(db), new FixedWindowProtocolRateLimiter(100, 60));
  await helloAuthenticator.verify(JSON.stringify(helloFrame(keys.privateKey)), {
    expectedDirection: "node_to_server", receivedAt, transportIdentity: "transport:node-ingress-test",
  });
  const ingress = new DatabaseConnectionEnrollmentNodeIngressV1(options.wrapDatabase?.(db) ?? db, {
    deliveryIntegrityKey: deliveryKey,
    registryIntegrityKey: registryKey,
    intakeAuditIntegrityKey: intakeKey,
  }, new FixedWindowProtocolRateLimiter(100, 60));
  return { raw, db, keys, spki, ingress };
}

function request(frame: SignedNodeFrame<"connection.enrollment.deliver">, observedAt = receivedAt,
  routingDeliveryId = deliveryId) {
  return { rawFrame: JSON.stringify(frame), deliveryId: routingDeliveryId, receivedAt: observedAt,
    transportIdentity: "transport:node-ingress-test" };
}

test("CR13A-LIVE-050 composes delivery and independent intake into one stable safe receipt", async () => {
  const { raw, keys, spki, ingress } = await fixture();
  try {
    const frame = deliveryFrame(keys.privateKey, spki);
    const first = await ingress.receive(request(frame));
    const replay = await ingress.receive(request(frame, retryAt));
    assert.deepEqual(replay, first);
    assert.deepEqual([first.protocolDisposition, first.ledgerDisposition, first.enrollmentDisposition,
      first.registryRevision, first.grantsApproval, first.grantsNetworkAuthority, first.grantsCommandAuthority,
      first.grantsLeaseAuthority, first.grantsExecutionAuthority],
    ["accepted", "accepted", "accepted", 1, false, false, false, false, false]);
    const serialized = JSON.stringify(first);
    for (const protectedValue of [tenantId,nodeId,keyId,connectionId,deliveryId,enrollmentId,spki,frame.signature]) {
      assert.equal(serialized.includes(protectedValue), false, protectedValue);
    }
    const counts = await raw.query<{ deliveries: number; intake: number; connections: number }>(
      `SELECT (SELECT count(*)::int FROM control_connection_enrollment_protocol_deliveries) AS deliveries,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS intake,
      (SELECT count(*)::int FROM control_connection_enrollments) AS connections`);
    assert.deepEqual(counts.rows[0], { deliveries: 1, intake: 1, connections: 1 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-050 rejects forged outer and invalid inner signatures at separate boundaries", async () => {
  const outer = await fixture();
  try {
    const attacker = generateKeyPairSync("ed25519");
    const forged = deliveryFrame(attacker.privateKey, outer.spki,
      { envelope: enrollmentEnvelope(outer.keys.privateKey, outer.spki) });
    await assert.rejects(() => outer.ingress.receive(request(forged)),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1
        && error.safeCode === "authentication_failed");
  } finally { await outer.raw.close(); }

  const inner = await fixture();
  try {
    const invalid = enrollmentEnvelope(inner.keys.privateKey, inner.spki);
    invalid.attestation.signature = "A".repeat(86);
    const frame = deliveryFrame(inner.keys.privateKey, inner.spki, { envelope: invalid });
    await assert.rejects(() => inner.ingress.receive(request(frame)),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1
        && error.safeCode === "enrollment_rejected");
    assert.equal((await inner.raw.query(`SELECT delivery_id FROM control_connection_enrollment_protocol_deliveries`))
      .rows.length, 1);
    assert.equal((await inner.raw.query(`SELECT connection_id FROM control_connection_enrollments`)).rows.length, 0);
  } finally { await inner.raw.close(); }
});

test("CR13A-LIVE-050 proves the untrusted routing hint matches authenticated delivery evidence", async () => {
  const { raw, keys, spki, ingress } = await fixture();
  try {
    const frame = deliveryFrame(keys.privateKey, spki);
    await assert.rejects(() => ingress.receive(request(frame, receivedAt, "aa")),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1
        && error.safeCode === "invalid_input");
    assert.equal((await raw.query(`SELECT delivery_id FROM control_connection_enrollment_protocol_deliveries`))
      .rows.length, 0);
    await assert.rejects(() => ingress.receive(request(frame, receivedAt, "delivery:wrong-routing-hint")),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1
        && error.safeCode === "integrity_failed");
    assert.equal((await raw.query(`SELECT delivery_id FROM control_connection_enrollment_protocol_deliveries`))
      .rows.length, 1);
    assert.equal((await raw.query(`SELECT delivery_id FROM control_connection_enrollment_intake_receipts`))
      .rows.length, 0);
    assert.equal((await ingress.receive(request(frame, retryAt))).enrollmentDisposition, "accepted");
  } finally { await raw.close(); }
});

test("CR13A-LIVE-050 recovers intake failure without duplicating delivery, registry, or receipt", async () => {
  const { raw, keys, spki, ingress } = await fixture();
  try {
    const frame = deliveryFrame(keys.privateKey, spki);
    await raw.exec(`CREATE FUNCTION reject_node_ingress_intake_test() RETURNS trigger AS $$ BEGIN
      RAISE EXCEPTION 'injected intake failure'; END; $$ LANGUAGE plpgsql`);
    await raw.exec(`CREATE TRIGGER reject_node_ingress_intake_test BEFORE INSERT
      ON control_connection_enrollment_intake_receipts FOR EACH ROW EXECUTE FUNCTION reject_node_ingress_intake_test()`);
    await assert.rejects(() => ingress.receive(request(frame)),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1
        && error.safeCode === "integrity_failed");
    assert.equal((await raw.query(`SELECT delivery_id FROM control_connection_enrollment_protocol_deliveries`))
      .rows.length, 1);
    assert.equal((await raw.query(`SELECT connection_id FROM control_connection_enrollments`)).rows.length, 0);
    await raw.exec(`DROP TRIGGER reject_node_ingress_intake_test ON control_connection_enrollment_intake_receipts`);
    const recovered = await ingress.receive(request(frame, retryAt));
    const replay = await ingress.receive(request(frame, "2026-09-02T05:08:20.000Z"));
    assert.deepEqual(replay, recovered);
    assert.equal(recovered.receivedAt, receivedAt);
    const counts = await raw.query<{ deliveries: number; intake: number; connections: number }>(
      `SELECT (SELECT count(*)::int FROM control_connection_enrollment_protocol_deliveries) AS deliveries,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS intake,
      (SELECT count(*)::int FROM control_connection_enrollments) AS connections`);
    assert.deepEqual(counts.rows[0], { deliveries: 1, intake: 1, connections: 1 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-050 serializes concurrent exact delivery through one registry outcome", async () => {
  const { raw, keys, spki, ingress } = await fixture();
  try {
    const frame = deliveryFrame(keys.privateKey, spki);
    const [first, second] = await Promise.all([
      ingress.receive(request(frame)),
      ingress.receive(request(frame, retryAt)),
    ]);
    assert.deepEqual(second, first);
    const counts = await raw.query<{ deliveries: number; intake: number; connections: number }>(
      `SELECT (SELECT count(*)::int FROM control_connection_enrollment_protocol_deliveries) AS deliveries,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS intake,
      (SELECT count(*)::int FROM control_connection_enrollments) AS connections`);
    assert.deepEqual(counts.rows[0], { deliveries: 1, intake: 1, connections: 1 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-050 rejects behavioral inputs, database proxies, duplicate keys, and disabled use", async () => {
  const database = await fixture();
  try {
    assert.deepEqual(Array.from(deliveryKey), Array(32).fill(71), "composition must not wipe caller-owned keys");
    assert.deepEqual(Array.from(registryKey), Array(32).fill(72), "composition must not wipe caller-owned keys");
    assert.deepEqual(Array.from(intakeKey), Array(32).fill(73), "composition must not wipe caller-owned keys");
    let traps = 0;
    const input = new Proxy({ rawFrame: "{}", deliveryId, receivedAt,
      transportIdentity: "transport:test" }, { get() { traps += 1; throw new Error("input trap"); } });
    await assert.rejects(() => database.ingress.receive(input),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1
        && error.safeCode === "invalid_input");
    assert.equal(traps, 0);
    assert.throws(() => new DatabaseConnectionEnrollmentNodeIngressV1(database.db, {
      deliveryIntegrityKey: deliveryKey,
      registryIntegrityKey: deliveryKey,
      intakeAuditIntegrityKey: intakeKey,
    }, new FixedWindowProtocolRateLimiter(100, 60)),
    (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1
      && error.safeCode === "invalid_input");
    assert.throws(() => new DatabaseConnectionEnrollmentNodeIngressV1(new Proxy(database.db, {}), {
      deliveryIntegrityKey: deliveryKey,
      registryIntegrityKey: registryKey,
      intakeAuditIntegrityKey: intakeKey,
    }, new FixedWindowProtocolRateLimiter(100, 60)),
    (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1
      && error.safeCode === "invalid_input");
  } finally { await database.raw.close(); }

  await assert.rejects(() => new DisabledConnectionEnrollmentNodeIngressV1().receive(),
    (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1 && error.safeCode === "disabled");
});

test("CR13A-LIVE-050 detects receipt drift and adds no route, listener, or app ingress port", async () => {
  const { raw, keys, spki, ingress } = await fixture();
  try {
    const receipt = await ingress.receive(request(deliveryFrame(keys.privateKey, spki)));
    assert.throws(() => parseConnectionEnrollmentNodeIngressReceiptV1({ ...receipt, registryRevision: 2 }),
      (error: unknown) => error instanceof ConnectionEnrollmentNodeIngressErrorV1
        && error.safeCode === "integrity_failed");
    const route = await readFile(resolve("app/api/v1/connections/route.ts"), "utf8");
    const appRuntime = await readFile(resolve("app/control-room-local-pilot-runtime.ts"), "utf8");
    const localRuntime = await readFile(resolve("src/local-pilot/v1/runtime.ts"), "utf8");
    assert.doesNotMatch(route, /NodeIngress|connection\.enrollment\.deliver|\bPOST\b/);
    assert.doesNotMatch(appRuntime, /NodeIngress|connection\.enrollment\.deliver/);
    assert.match(localRuntime, /DisabledConnectionEnrollmentNodeIngressV1/);
    assert.doesNotMatch(localRuntime, /DatabaseConnectionEnrollmentNodeIngressV1/);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-050 rejects selected post-import runtime replacement before it executes", async () => {
  const { raw, keys, spki, ingress } = await fixture();
  const getDescriptor = Object.getOwnPropertyDescriptor, defineProperty = Object.defineProperty;
  try {
    const receipt = await ingress.receive(request(deliveryFrame(keys.privateKey, spki)));
    const drifted = { ...receipt, registryRevision: 2 };
    const hashPrototype = Object.getPrototypeOf(createHash("sha256"));
    const targets: ReadonlyArray<readonly [object, PropertyKey]> = [
      [Object, "getOwnPropertyDescriptor"], [Object, "getPrototypeOf"], [Object, "freeze"], [Object, "keys"],
      [Array, "isArray"], [Array.prototype, "map"], [Array.prototype, "join"], [Array.prototype, "sort"],
      [Number, "isFinite"], [Number, "isSafeInteger"], [JSON, "stringify"], [Date, "parse"],
      [Date.prototype, "getTime"], [Date.prototype, "toISOString"], [String.prototype, "slice"],
      [RegExp.prototype, "exec"], [Reflect, "apply"], [Object.getPrototypeOf(Uint8Array.prototype), "fill"],
      [hashPrototype, "update"], [hashPrototype, "digest"],
    ];
    for (const [owner, key] of targets) {
      const descriptor = getDescriptor(owner, key);
      assert.ok(descriptor && "value" in descriptor && typeof descriptor.value === "function", String(key));
      let replacementCalls = 0;
      const replacement = function (this: unknown, ...args: unknown[]) {
        replacementCalls += 1;
        return Reflect.apply(descriptor.value as (...values: unknown[]) => unknown, this, args);
      };
      defineProperty(owner, key, { ...descriptor, value: replacement });
      let failure: unknown;
      try { parseConnectionEnrollmentNodeIngressReceiptV1(drifted); }
      catch (error) { failure = error; }
      finally { defineProperty(owner, key, descriptor); }
      assert.equal(replacementCalls, 0, String(key));
      assert.ok(failure instanceof ConnectionEnrollmentNodeIngressErrorV1, String(key));
      assert.equal(failure.safeCode, "integrity_failed", String(key));
    }
  } finally { await raw.close(); }
});

test("CR13A-LIVE-050 rechecks runtime after intake commit before constructing a receipt", async () => {
  const getDescriptor = Object.getOwnPropertyDescriptor, defineProperty = Object.defineProperty;
  const keysDescriptor = getDescriptor(Object, "keys");
  assert.ok(keysDescriptor && "value" in keysDescriptor && typeof keysDescriptor.value === "function");
  let armed = false, replacementCalls = 0, replacementInstalled = false;
  const replacement = function (this: unknown, ...args: unknown[]) {
    replacementCalls += 1;
    return Reflect.apply(keysDescriptor.value as (...values: unknown[]) => unknown, this, args);
  };
  const wrapped = (db: DatabaseClient): DatabaseClient => ({
    query: <T = Record<string, unknown>>(statement: string, params: unknown[] = []) => db.query<T>(statement, params),
    async transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> {
      const result = await db.transaction(callback);
      if (armed && result && typeof result === "object"
        && getDescriptor(result, "replayed")?.value !== undefined
        && getDescriptor(result, "receipt")?.value !== undefined) {
        defineProperty(Object, "keys", { ...keysDescriptor, value: replacement });
        replacementInstalled = true; armed = false;
      }
      return result;
    },
    transactionWithPreCommitCheck<T>(callback: (session: DatabaseSession) => Promise<T>,
      preCommitCheck: () => void): Promise<T> {
      return db.transactionWithPreCommitCheck(callback, preCommitCheck);
    },
  });
  const fixtureValue = await fixture({ wrapDatabase: wrapped });
  try {
    armed = true;
    let failure: unknown;
    try { await fixtureValue.ingress.receive(request(deliveryFrame(fixtureValue.keys.privateKey, fixtureValue.spki))); }
    catch (error) { failure = error; }
    finally {
      if (replacementInstalled) defineProperty(Object, "keys", keysDescriptor);
    }
    assert.equal(replacementInstalled, true);
    assert.equal(replacementCalls, 0);
    assert.ok(failure instanceof ConnectionEnrollmentNodeIngressErrorV1);
    assert.equal(failure.safeCode, "integrity_failed");
    const recovered = await fixtureValue.ingress.receive(request(
      deliveryFrame(fixtureValue.keys.privateKey, fixtureValue.spki), retryAt));
    assert.equal(recovered.registryRevision, 1);
  } finally {
    if (replacementInstalled) defineProperty(Object, "keys", keysDescriptor);
    await fixtureValue.raw.close();
  }
});

test("CR13A-LIVE-050 contains behavioral database rejection without executing or persisting it", async () => {
  let traps = 0;
  const rejection: object = new Proxy(Object.create(null) as object, {
    getPrototypeOf() { traps += 1; throw rejection; },
  });
  const rejectingDatabase = (db: DatabaseClient): DatabaseClient => ({
    async query(): Promise<never> { throw rejection; },
    transaction: <T>(callback: (session: DatabaseSession) => Promise<T>) => db.transaction(callback),
    transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>,
      preCommitCheck: () => void) => db.transactionWithPreCommitCheck(callback, preCommitCheck),
  });
  const fixtureValue = await fixture({ wrapDatabase: rejectingDatabase });
  try {
    let failure: unknown;
    try { await fixtureValue.ingress.receive(request(deliveryFrame(fixtureValue.keys.privateKey, fixtureValue.spki))); }
    catch (error) { failure = error; }
    assert.equal(traps, 0);
    assert.ok(failure instanceof ConnectionEnrollmentNodeIngressErrorV1);
    assert.equal(failure.safeCode, "integrity_failed");
    assert.notEqual(failure, rejection);
    const counts = await fixtureValue.raw.query<{
      replay: number; deliveries: number; intake: number; connections: number;
    }>(`SELECT (SELECT count(*)::int FROM node_protocol_replay) AS replay,
      (SELECT count(*)::int FROM control_connection_enrollment_protocol_deliveries) AS deliveries,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS intake,
      (SELECT count(*)::int FROM control_connection_enrollments) AS connections`);
    assert.deepEqual(counts.rows[0], { replay: 1, deliveries: 0, intake: 0, connections: 0 });
  } finally { await fixtureValue.raw.close(); }
});

test("CR13A-LIVE-050 contains a database rejection without consulting its unusual prototype", async () => {
  let prototypeReads = 0;
  const unusualPrototype: object = new Proxy(Object.create(null) as object, {
    getPrototypeOf() { prototypeReads += 1; throw new Error("prototype must remain unread"); },
    getOwnPropertyDescriptor() { prototypeReads += 1; throw new Error("prototype must remain unread"); },
  });
  const rejection = Object.create(unusualPrototype) as object;
  Object.defineProperty(rejection, "safeCode", {
    get() { prototypeReads += 1; throw new Error("code must remain unread"); },
  });
  const rejectingDatabase = (db: DatabaseClient): DatabaseClient => ({
    async query(): Promise<never> { throw rejection; },
    transaction: <T>(callback: (session: DatabaseSession) => Promise<T>) => db.transaction(callback),
    transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>,
      preCommitCheck: () => void) => db.transactionWithPreCommitCheck(callback, preCommitCheck),
  });
  const fixtureValue = await fixture({ wrapDatabase: rejectingDatabase });
  try {
    let failure: unknown;
    try { await fixtureValue.ingress.receive(request(deliveryFrame(fixtureValue.keys.privateKey, fixtureValue.spki))); }
    catch (error) { failure = error; }
    assert.equal(prototypeReads, 0);
    assert.ok(failure instanceof ConnectionEnrollmentNodeIngressErrorV1);
    assert.equal(failure.safeCode, "integrity_failed");
    assert.notEqual(failure, rejection);
    const counts = await fixtureValue.raw.query<{
      replay: number; deliveries: number; intake: number; connections: number;
    }>(`SELECT (SELECT count(*)::int FROM node_protocol_replay) AS replay,
      (SELECT count(*)::int FROM control_connection_enrollment_protocol_deliveries) AS deliveries,
      (SELECT count(*)::int FROM control_connection_enrollment_intake_receipts) AS intake,
      (SELECT count(*)::int FROM control_connection_enrollments) AS connections`);
    assert.deepEqual(counts.rows[0], { replay: 1, deliveries: 0, intake: 0, connections: 0 });
  } finally { await fixtureValue.raw.close(); }
});
