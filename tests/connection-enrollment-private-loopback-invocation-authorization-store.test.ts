import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_BODY_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_ENVELOPE_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_STORE_DISABLED_V1,
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1,
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1,
  type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1,
} from "../src/connection-registry/v1";
import { adaptPglite, type DatabaseClient } from "../src/persistence/database";
import { hmacSha256Tag, sha256Digest } from "../src/security";

const root = resolve(import.meta.dirname, "..");
const modulePath = resolve(root, "src/connection-registry/v1/private-loopback-invocation-authorization-store.ts");
const digest = (label: string) => sha256Digest({ label });
const authorizationKey = new Uint8Array(32).fill(71);
const stateKey = new Uint8Array(32).fill(72);
const authorizationKeyIdDigest = digest("native-observation-sealing-key");
const tenantId = "tenant:native-observation-authorization";
const issuedAt = "2026-09-04T15:00:00.000Z";
const notBefore = "2026-09-04T15:00:01.000Z";
const expiresAt = "2026-09-04T15:00:45.000Z";

async function migrate(raw: PGlite): Promise<void> {
  for (const file of (await readdir(resolve(root, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve(root, "db/migrations", file), "utf8"));
  }
}

async function setup(): Promise<{ raw: PGlite; db: DatabaseClient;
  store: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1 }> {
  const raw = new PGlite();
  await migrate(raw);
  await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [tenantId, "Native observation authorization"]);
  const db = adaptPglite(raw);
  return { raw, db, store: new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
    { authorizationKey, authorizationKeyIdDigest, stateKey }) };
}

function body(changes: Partial<ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1> = {}):
ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1 {
  return {
    contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_BODY_V1,
    live330ProductCommit: "06be655d188c45902c015f85225673dfc31c445d",
    live340ProductCommit: "3108a8759863c4692ade2d5532e88cd28f259779",
    acceptedLive340ReviewSha256: "bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af",
    tenantId,
    projectId: "project:control-room-local-pilot-acceptance",
    connectionId: "connection:owner-mac-hermes",
    nodeId: "node:owner-mac",
    targetPlatformFamily: "macos",
    targetRuntimeFamily: "node",
    candidateId: "candidate:native-observation:001",
    attemptId: "attempt:native-observation:001",
    operation: "observe_target_runtime_once",
    authorizationId: "authorization:native-observation:001",
    nonceDigest: digest("native-observation-nonce-001"),
    issuedAt,
    notBefore,
    expiresAt,
    sealingKeyIdDigest: authorizationKeyIdDigest,
    ...changes,
  };
}

function envelope(value = body(), key = authorizationKey) {
  const bodyDigest = sha256Digest(value);
  return {
    envelopeVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_ENVELOPE_V1,
    body: value,
    bodyDigest,
    authorizationAuthTag: hmacSha256Tag(key,
      { kind: "private_native_observation_invocation_authorization", body: value, bodyDigest }),
  };
}

function expectCode(code: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1["safeCode"]):
(error: unknown) => boolean {
  return (error) => error instanceof ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1
    && error.safeCode === code && error.message === code && error.stack === undefined;
}

test("CR13A-LIVE-350 binds accepted LIVE-340 evidence and freezes the repository-only architecture", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_350_AUTHENTICATED_INVOCATION_AUTHORIZATION_STORE.md"), "utf8");
  const review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_340_INDEPENDENT_REVIEW.md"));
  assert.equal(createHash("sha256").update(review).digest("hex"),
    "bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af");
  assert.match(architecture, /3108a8759863c4692ade2d5532e88cd28f259779/);
  assert.match(architecture, /bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af/);
  assert.match(architecture, /PGlite[\s\S]*not production|not production[\s\S]*PGlite/i);
  assert.match(architecture, /cannot consume|must not[\s\S]*consume/i);
});

test("CR13A-LIVE-350 atomically registers one sealed authorization and returns only negative evidence", async () => {
  const { raw, store } = await setup();
  try {
    const value = envelope(), receipt = await store.register(value);
    assert.equal(receipt.authorizationIdDigest, sha256Digest({ authorizationId: value.body.authorizationId }));
    assert.equal(receipt.nonceDigest, value.body.nonceDigest);
    assert.equal(receipt.bodyDigest, value.bodyDigest);
    assert.equal(receipt.state, "registered_unconsumed");
    assert.equal(receipt.validityEvaluated, false);
    for (const entry of Object.entries(receipt).filter(([key]) => key.startsWith("grants"))) assert.equal(entry[1], false);
    assert.equal(Object.isFrozen(receipt), true);
    const counts = await raw.query<{ authorizations: number; nonces: number; heads: number }>(`SELECT
      (SELECT count(*)::int FROM control_native_observation_authorizations) AS authorizations,
      (SELECT count(*)::int FROM control_native_observation_authorization_nonces) AS nonces,
      (SELECT count(*)::int FROM control_native_observation_authorization_heads) AS heads`);
    assert.deepEqual(counts.rows[0], { authorizations: 1, nonces: 1, heads: 1 });
    assert.doesNotMatch(JSON.stringify(receipt), /authorization:native|owner-mac-hermes|node:owner-mac/);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 exact replay is inert and reconstructs the identical receipt after store restart", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope(), first = await store.register(value);
    const restarted = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    assert.deepEqual(await restarted.register(value), first);
    const counts = await raw.query<{ authorizations: number; nonces: number }>(`SELECT
      (SELECT count(*)::int FROM control_native_observation_authorizations) AS authorizations,
      (SELECT count(*)::int FROM control_native_observation_authorization_nonces) AS nonces`);
    assert.deepEqual(counts.rows[0], { authorizations: 1, nonces: 1 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 exact replay survives a persistent PGlite process-boundary reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cr13a-live350-restart-"));
  const dataDirectory = join(directory, "pgdata");
  let raw: PGlite | undefined;
  try {
    raw = new PGlite(dataDirectory);
    await migrate(raw);
    await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [tenantId, "Owner"]);
    const firstStore = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(adaptPglite(raw),
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    const value = envelope(), first = await firstStore.register(value);
    await raw.close(); raw = undefined;
    raw = new PGlite(dataDirectory);
    const reopened = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(adaptPglite(raw),
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    assert.deepEqual(await reopened.register(value), first);
    const counts = await raw.query<{ authorizations: number; nonces: number }>(`SELECT
      (SELECT count(*)::int FROM control_native_observation_authorizations) AS authorizations,
      (SELECT count(*)::int FROM control_native_observation_authorization_nonces) AS nonces`);
    assert.deepEqual(counts.rows[0], { authorizations: 1, nonces: 1 });
  } finally {
    if (raw) await raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CR13A-LIVE-350 changed authorization-ID replay fails closed", async () => {
  const { raw, store } = await setup();
  try {
    await store.register(envelope());
    await assert.rejects(store.register(envelope(body({
      attemptId: "attempt:native-observation:changed",
      nonceDigest: digest("native-observation-nonce-changed"),
    }))), expectCode("replay_conflict"));
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 changed nonce replay fails closed", async () => {
  const { raw, store } = await setup();
  try {
    await store.register(envelope());
    await assert.rejects(store.register(envelope(body({
      authorizationId: "authorization:native-observation:002",
      candidateId: "candidate:native-observation:002",
    }))), expectCode("replay_conflict"));
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 rejects changed body, digest, tag, scope, and invalid time without writes", async () => {
  const { raw, store } = await setup();
  try {
    const changedBody = envelope();
    await assert.rejects(store.register({ ...changedBody, body: { ...changedBody.body,
      attemptId: "attempt:native-observation:changed" } }), expectCode("authentication_failed"));
    await assert.rejects(store.register({ ...changedBody, bodyDigest: digest("wrong-body") }),
      expectCode("authentication_failed"));
    await assert.rejects(store.register({ ...changedBody, authorizationAuthTag: hmacSha256Tag(stateKey, { wrong: true }) }),
      expectCode("authentication_failed"));
    await assert.rejects(store.register(envelope(body({ sealingKeyIdDigest: digest("different-sealing-key") }))),
      expectCode("authentication_failed"));
    await assert.rejects(store.register(envelope(body({ tenantId: "tenant:foreign" }))), expectCode("integrity_failed"));
    await assert.rejects(store.register(envelope(body({ expiresAt: "2026-09-04T15:02:00.000Z" }))),
      expectCode("invalid_input"));
    const count = await raw.query<{ count: number }>("SELECT count(*)::int AS count FROM control_native_observation_authorizations");
    assert.equal(count.rows[0]?.count, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 rejects Proxy, accessor, Symbol, and widened keys without behavior", async () => {
  const { raw, db, store } = await setup();
  try {
    let executions = 0;
    const proxy = new Proxy({}, { ownKeys() { executions += 1; throw new Error("raw proxy"); } });
    const accessor = Object.defineProperty({}, "envelopeVersion", {
      enumerable: true, get() { executions += 1; throw new Error("raw accessor"); },
    });
    await assert.rejects(store.register(proxy), expectCode("invalid_input"));
    await assert.rejects(store.register(accessor), expectCode("invalid_input"));
    await assert.rejects(store.register(Symbol("authorization")), expectCode("invalid_input"));
    assert.throws(() => new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey: new Uint8Array(31), authorizationKeyIdDigest, stateKey }), expectCode("invalid_input"));
    assert.equal(executions, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 defensively captures keys and freezes its callable boundary", async () => {
  const raw = new PGlite();
  try {
    await migrate(raw);
    await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [tenantId, "Owner"]);
    const auth = new Uint8Array(authorizationKey), state = new Uint8Array(stateKey);
    const store = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(adaptPglite(raw),
      { authorizationKey: auth, authorizationKeyIdDigest, stateKey: state });
    auth.fill(0); state.fill(0);
    await store.register(envelope());
    assert.equal(Object.isFrozen(store), true);
    assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1), true);
    assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype), true);
    assert.equal(Object.isFrozen(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype.register), true);
    const error = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1("raw secret");
    assert.equal(error.safeCode, "integrity_failed");
    assert.equal(Object.isFrozen(error), true);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 detects authenticated-head tampering before accepting another record", async () => {
  const { raw, store } = await setup();
  try {
    await store.register(envelope());
    await raw.query(`UPDATE control_native_observation_authorization_heads
      SET head_auth_tag=$1 WHERE tenant_id=$2`, [hmacSha256Tag(stateKey, { wrong: true }), tenantId]);
    await assert.rejects(store.register(envelope(body({
      authorizationId: "authorization:native-observation:002",
      nonceDigest: digest("native-observation-nonce-002"),
    }))), expectCode("integrity_failed"));
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 transaction failure cannot leave a half reservation", async () => {
  const { raw, db } = await setup();
  try {
    const wrapped: DatabaseClient = {
      query: db.query.bind(db),
      transaction: (callback) => db.transaction((session) => callback({
        query: async <T>(statement: string, params: unknown[] = []) => {
          if (statement.includes("control_native_observation_authorization_nonces") && statement.includes("INSERT INTO")) {
            throw new Error("synthetic nonce insert failure");
          }
          return session.query<T>(statement, params);
        },
      })),
      transactionWithPreCommitCheck: db.transactionWithPreCommitCheck.bind(db),
    };
    const store = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(wrapped,
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    await assert.rejects(store.register(envelope()), expectCode("integrity_failed"));
    const counts = await raw.query<{ authorizations: number; nonces: number; heads: number }>(`SELECT
      (SELECT count(*)::int FROM control_native_observation_authorizations) AS authorizations,
      (SELECT count(*)::int FROM control_native_observation_authorization_nonces) AS nonces,
      (SELECT count(*)::int FROM control_native_observation_authorization_heads) AS heads`);
    assert.deepEqual(counts.rows[0], { authorizations: 0, nonces: 0, heads: 0 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 concurrent exact duplicate registration converges to one durable pair", async () => {
  const { raw, db } = await setup();
  try {
    const first = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    const second = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    const value = envelope();
    const [left, right] = await Promise.all([first.register(value), second.register(value)]);
    assert.deepEqual(left, right);
    const counts = await raw.query<{ authorizations: number; nonces: number }>(`SELECT
      (SELECT count(*)::int FROM control_native_observation_authorizations) AS authorizations,
      (SELECT count(*)::int FROM control_native_observation_authorization_nonces) AS nonces`);
    assert.deepEqual(counts.rows[0], { authorizations: 1, nonces: 1 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 append-only guards reject authorization and nonce mutation", async () => {
  const { raw, store } = await setup();
  try {
    await store.register(envelope());
    await assert.rejects(raw.query("DELETE FROM control_native_observation_authorizations"));
    await assert.rejects(raw.query("UPDATE control_native_observation_authorization_nonces SET body_digest=body_digest"));
    await assert.rejects(raw.query("TRUNCATE control_native_observation_authorizations"));
  } finally { await raw.close(); }
});

test("CR13A-LIVE-350 has no issuer, consumer, lookup, native source, or runtime wiring", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from "node:|import "node:|unreachable-atomic-native-observation-source/);
  assert.doesNotMatch(source, /\.consume\(|sourceLookups: [1-9]|sourceInvocations: [1-9]|nativeReads: [1-9]/);
  assert.deepEqual(Object.getOwnPropertyNames(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype),
    ["constructor", "register"]);
  const status = CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_STORE_DISABLED_V1;
  assert.equal(Object.isFrozen(status), true);
  assert.equal(status.productionDatabaseConfigured, false);
  assert.equal(status.productionIssuerImplemented, false);
  assert.equal(status.authorizationConsumptions, 0);
  assert.equal(status.sourceLookups, 0);
  assert.equal(status.sourceInvocations, 0);
  assert.equal(status.nativeReads, 0);
  assert.equal(status.externalEffectOccurred, false);
  assert.deepEqual(Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value),
    new Array(8).fill(false));
});
