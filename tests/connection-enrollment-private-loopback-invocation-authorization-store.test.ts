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
const consumptionStateKey = new Uint8Array(32).fill(73);
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

function withTrustedDatabaseTime(db: DatabaseClient, value: string | readonly string[] | Error): DatabaseClient {
  const query = async <T>(session: Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0],
    statement: string, params: unknown[] = []) => {
    if (!statement.includes("clock_timestamp()")) return session.query<T>(statement, params);
    if (value instanceof Error) throw value;
    const values = typeof value === "string" ? [value] : value;
    return { rows: values.map((trusted_now) => ({ trusted_now })) as T[] };
  };
  return {
    query: db.query.bind(db),
    transaction: (callback) => db.transaction((session) => callback(Object.freeze({
      query: <T>(statement: string, params: unknown[] = []) => query<T>(session, statement, params),
    }))),
    transactionWithPreCommitCheck: (callback, check) => db.transactionWithPreCommitCheck((session) =>
      callback(Object.freeze({
        query: <T>(statement: string, params: unknown[] = []) => query<T>(session, statement, params),
      })), check),
  };
}

function withMutatedDatabaseRow(db: DatabaseClient, table: string, field: string, value: unknown): DatabaseClient {
  const query = async <T>(session: Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0],
    statement: string, params: unknown[] = []) => {
    const result = await session.query<T>(statement, params);
    if (!statement.includes(`FROM ${table}`) || !statement.includes("SELECT")) return result;
    return { rows: result.rows.map((row) => ({ ...(row as Record<string, unknown>), [field]: value })) as T[] };
  };
  return {
    query: db.query.bind(db),
    transaction: (callback) => db.transaction((session) => callback(Object.freeze({
      query: <T>(statement: string, params: unknown[] = []) => query<T>(session, statement, params),
    }))),
    transactionWithPreCommitCheck: (callback, check) => db.transactionWithPreCommitCheck((session) =>
      callback(Object.freeze({
        query: <T>(statement: string, params: unknown[] = []) => query<T>(session, statement, params),
      })), check),
  };
}

function consumptionStore(db: DatabaseClient, trustedNow = "2026-09-04T15:00:10.000Z") {
  return new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(
    withTrustedDatabaseTime(db, trustedNow),
    { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey });
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
    assert.throws(() => new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey, authorizationKeyIdDigest, stateKey: new Uint8Array(authorizationKey) }),
    expectCode("invalid_input"));
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

test("CR13A-LIVE-360 binds the accepted corrected LIVE-350 product and re-review", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_360_TRUSTED_DATABASE_TIME_AND_LINEAGE_VALIDATION.md"), "utf8");
  const review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_350_INDEPENDENT_REREVIEW.md"));
  assert.equal(createHash("sha256").update(review).digest("hex"),
    "ffea24f4ed6e7d62ffb7a06caf2446471582eff6780351af88136b9aba3c3324");
  assert.match(architecture, /053c4d02003e0223438e26aecea851253d05a60b/);
  assert.match(architecture, /ffea24f4ed6e7d62ffb7a06caf2446471582eff6780351af88136b9aba3c3324/);
  assert.match(architecture, /clock_timestamp\(\)/);
  assert.match(architecture, /read-only preflight|read-only validation/i);
});

test("CR13A-LIVE-360 validates exact stored lineage with same-session database time and no writes", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const validator = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(
      withTrustedDatabaseTime(db, "2026-09-04T15:00:10.000Z"),
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    const first = await validator.validateForConsumption(value);
    assert.deepEqual(await validator.validateForConsumption(value), first);
    assert.equal(first.validatedAt, "2026-09-04T15:00:10.000Z");
    assert.equal(first.state, "validated_unconsumed");
    assert.equal(first.authenticatedLineageValidated, true);
    assert.equal(first.replayReservationValidated, true);
    assert.equal(first.currentWindowValidated, true);
    assert.equal(first.authorizationConsumed, false);
    assert.equal(Object.isFrozen(first), true);
    assert.deepEqual(Object.entries(first).filter(([key]) => key.startsWith("grants")).map(([, entry]) => entry),
      new Array(8).fill(false));
    const counts = await raw.query<{ authorizations: number; nonces: number; heads: number }>(`SELECT
      (SELECT count(*)::int FROM control_native_observation_authorizations) AS authorizations,
      (SELECT count(*)::int FROM control_native_observation_authorization_nonces) AS nonces,
      (SELECT count(*)::int FROM control_native_observation_authorization_heads) AS heads`);
    assert.deepEqual(counts.rows[0], { authorizations: 1, nonces: 1, heads: 1 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-360 reads canonical current time from an actual local PGlite session", async () => {
  const { raw, store } = await setup();
  try {
    const baseline = Date.now();
    const value = envelope(body({
      issuedAt: new Date(baseline - 10_000).toISOString(),
      notBefore: new Date(baseline - 5_000).toISOString(),
      expiresAt: new Date(baseline + 40_000).toISOString(),
    }));
    await store.register(value);
    const receipt = await store.validateForConsumption(value);
    assert.ok(Date.parse(receipt.validatedAt) >= baseline - 1_000);
    assert.ok(Date.parse(receipt.validatedAt) < baseline + 40_000);
    assert.equal(receipt.currentWindowValidated, true);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-360 enforces inclusive not-before and exclusive expiry", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const validateAt = (trustedNow: string) => new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(
      withTrustedDatabaseTime(db, trustedNow), { authorizationKey, authorizationKeyIdDigest, stateKey })
      .validateForConsumption(value);
    await assert.rejects(validateAt("2026-09-04T15:00:00.999Z"), expectCode("not_yet_valid"));
    assert.equal((await validateAt(notBefore)).currentWindowValidated, true);
    assert.equal((await validateAt("2026-09-04T15:00:44.999Z")).currentWindowValidated, true);
    await assert.rejects(validateAt(expiresAt), expectCode("expired"));
  } finally { await raw.close(); }
});

test("CR13A-LIVE-360 distinguishes unavailable identity from authenticated replay conflict", async () => {
  const { raw, db, store } = await setup();
  try {
    const validator = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(
      withTrustedDatabaseTime(db, "2026-09-04T15:00:10.000Z"),
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    await assert.rejects(validator.validateForConsumption(envelope()), expectCode("authorization_unavailable"));
    await store.register(envelope());
    await assert.rejects(validator.validateForConsumption(envelope(body({
      nonceDigest: digest("native-observation-nonce-changed"),
    }))), expectCode("replay_conflict"));
  } finally { await raw.close(); }
});

test("CR13A-LIVE-360 rejects missing, duplicate, noncanonical, and failed database time", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const validateWith = (trustedNow: string | readonly string[] | Error) =>
      new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(withTrustedDatabaseTime(db, trustedNow),
        { authorizationKey, authorizationKeyIdDigest, stateKey }).validateForConsumption(value);
    await assert.rejects(validateWith([]), expectCode("integrity_failed"));
    await assert.rejects(validateWith([notBefore, notBefore]), expectCode("integrity_failed"));
    await assert.rejects(validateWith("2026-09-04 15:00:01+00"), expectCode("integrity_failed"));
    await assert.rejects(validateWith(new Error("raw database clock failure")), expectCode("integrity_failed"));
  } finally { await raw.close(); }
});

test("CR13A-LIVE-360 rejects tampered state before reading database time", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    await raw.query(`UPDATE control_native_observation_authorization_heads SET head_auth_tag=$1 WHERE tenant_id=$2`,
      [hmacSha256Tag(stateKey, { wrong: true }), tenantId]);
    let clockReads = 0;
    const guarded: DatabaseClient = {
      query: db.query.bind(db),
      transaction: (callback) => db.transaction((session) => callback(Object.freeze({
        query: <T>(statement: string, params: unknown[] = []) => {
          if (statement.includes("clock_timestamp()")) clockReads += 1;
          return statement.includes("clock_timestamp()")
            ? Promise.resolve({ rows: [{ trusted_now: notBefore }] as T[] }) : session.query<T>(statement, params);
        },
      }))),
      transactionWithPreCommitCheck: db.transactionWithPreCommitCheck.bind(db),
    };
    const validator = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(guarded,
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    await assert.rejects(validator.validateForConsumption(value), expectCode("integrity_failed"));
    assert.equal(clockReads, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-360 rejects behavioral authorization-row scalars before coercion or comparison", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    let executions = 0;
    const coercive = { valueOf() { executions += 1; return 1; },
      [Symbol.toPrimitive]() { executions += 1; return 1; } };
    const lengthAccessor = Object.defineProperty({}, "length", {
      get() { executions += 1; return 71; }, enumerable: true,
    });
    for (const [field, hostile] of [["sequence", coercive], ["authorization_auth_tag", lengthAccessor],
      ["record_auth_tag", lengthAccessor]] as const) {
      const hostileDb = withMutatedDatabaseRow(db, "control_native_observation_authorizations", field, hostile);
      const validator = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(hostileDb,
        { authorizationKey, authorizationKeyIdDigest, stateKey });
      await assert.rejects(validator.validateForConsumption(value), expectCode("integrity_failed"));
    }
    assert.equal(executions, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-360 rejects behavioral head and nonce scalars before coercion or comparison", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    let executions = 0;
    const coercive = { valueOf() { executions += 1; return 1; },
      [Symbol.toPrimitive]() { executions += 1; return 1; } };
    const lengthAccessor = Object.defineProperty({}, "length", {
      get() { executions += 1; return 71; }, enumerable: true,
    });
    const cases = [
      ["control_native_observation_authorization_heads", "last_sequence", coercive],
      ["control_native_observation_authorization_heads", "head_auth_tag", lengthAccessor],
      ["control_native_observation_authorization_nonces", "reservation_auth_tag", lengthAccessor],
    ] as const;
    for (const [table, field, hostile] of cases) {
      const hostileDb = withMutatedDatabaseRow(db, table, field, hostile);
      const validator = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(hostileDb,
        { authorizationKey, authorizationKeyIdDigest, stateKey });
      await assert.rejects(validator.validateForConsumption(value), expectCode("integrity_failed"));
    }
    assert.equal(executions, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 binds the accepted corrected LIVE-360 product and re-review", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_370_ATOMIC_INVOCATION_AUTHORIZATION_CONSUMPTION.md"), "utf8");
  const review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_360_INDEPENDENT_REREVIEW.md"));
  assert.equal(createHash("sha256").update(review).digest("hex"),
    "2dbf2c395ba8a95c41898cba05309551ca4e7be8e2b04e706f1fed1b7828cd47");
  assert.match(architecture, /6028badb6db6b0455e9bed02c45751ea81517fa4/);
  assert.match(architecture, /2dbf2c395ba8a95c41898cba05309551ca4e7be8e2b04e706f1fed1b7828cd47/);
  assert.match(architecture, /consumed_pending_post_transaction_time_recheck/);
  assert.match(architecture, /later separately reviewed block must read trusted[\s\S]*time again/i);
});

test("CR13A-LIVE-370 atomically spends one exact authorization and returns no source authority", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const receipt = await consumptionStore(db).consumeForInvocation(value);
    assert.equal(receipt.state, "consumed_pending_post_transaction_time_recheck");
    assert.equal(receipt.freshConsumption, true);
    assert.equal(receipt.consumedAt, "2026-09-04T15:00:10.000Z");
    assert.equal(receipt.postTransactionTimeRechecked, false);
    assert.equal(receipt.sourceLookupPerformed, false);
    assert.equal(receipt.sourceInvocationPerformed, false);
    assert.equal(receipt.nativeReadPerformed, false);
    assert.equal(Object.isFrozen(receipt), true);
    assert.deepEqual(Object.entries(receipt).filter(([key]) => key.startsWith("grants")).map(([, entry]) => entry),
      new Array(8).fill(false));
    const counts = await raw.query<{ consumptions: number; heads: number }>(`SELECT
      (SELECT count(*)::int FROM control_native_observation_authorization_consumptions) AS consumptions,
      (SELECT count(*)::int FROM control_native_observation_authorization_consumption_heads) AS heads`);
    assert.deepEqual(counts.rows[0], { consumptions: 1, heads: 1 });
    assert.doesNotMatch(JSON.stringify(receipt), /authorization:native|owner-mac-hermes|node:owner-mac/);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 exact replay after restart is terminal and creates no second spend", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const first = await consumptionStore(db).consumeForInvocation(value);
    const restarted = consumptionStore(db, "2026-09-04T15:00:20.000Z");
    const replay = await restarted.consumeForInvocation(value);
    assert.equal(first.freshConsumption, true);
    assert.equal(replay.freshConsumption, false);
    assert.equal(replay.state, "already_consumed_terminal");
    assert.equal(replay.consumedAt, first.consumedAt);
    const count = await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM control_native_observation_authorization_consumptions");
    assert.equal(count.rows[0]?.count, 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 concurrent exact spends converge to one durable consumption", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const [left, right] = await Promise.all([
      consumptionStore(db).consumeForInvocation(value), consumptionStore(db).consumeForInvocation(value),
    ]);
    assert.deepEqual([left.freshConsumption, right.freshConsumption].sort(), [false, true]);
    assert.deepEqual([left.state, right.state].sort(),
      ["already_consumed_terminal", "consumed_pending_post_transaction_time_recheck"]);
    const count = await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM control_native_observation_authorization_consumptions");
    assert.equal(count.rows[0]?.count, 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 enforces database-time boundaries immediately before spend", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    await assert.rejects(consumptionStore(db, "2026-09-04T15:00:00.999Z").consumeForInvocation(value),
      expectCode("not_yet_valid"));
    await assert.rejects(consumptionStore(db, expiresAt).consumeForInvocation(value), expectCode("expired"));
    const countBefore = await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM control_native_observation_authorization_consumptions");
    assert.equal(countBefore.rows[0]?.count, 0);
    const receipt = await consumptionStore(db, notBefore).consumeForInvocation(value);
    assert.equal(receipt.consumedAt, notBefore);
    assert.equal(receipt.freshConsumption, true);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 rejects changed identity and malformed database time without spending", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    await assert.rejects(consumptionStore(db).consumeForInvocation(envelope(body({
      nonceDigest: digest("native-observation-nonce-changed"),
    }))), expectCode("replay_conflict"));
    await assert.rejects(consumptionStore(db).consumeForInvocation(envelope(body({
      authorizationId: "authorization:native-observation:changed",
    }))), expectCode("replay_conflict"));
    for (const trustedNow of [[], [notBefore, notBefore], "2026-09-04 15:00:01+00",
      new Error("raw database clock failure")] as const) {
      const invalidClock = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(
        withTrustedDatabaseTime(db, trustedNow),
        { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey });
      await assert.rejects(invalidClock.consumeForInvocation(value), expectCode("integrity_failed"));
    }
    const count = await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM control_native_observation_authorization_consumptions");
    assert.equal(count.rows[0]?.count, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 requires a third exact byte-distinct protected key", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    await assert.rejects(store.consumeForInvocation(value), expectCode("consumption_unavailable"));
    assert.throws(() => new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey: undefined }),
    expectCode("invalid_input"));
    assert.throws(() => new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey: new Uint8Array(authorizationKey) }),
    expectCode("invalid_input"));
    assert.throws(() => new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey, authorizationKeyIdDigest, stateKey,
        consumptionStateKey: new Uint8Array(stateKey) }), expectCode("invalid_input"));
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 rolls back a partial spend and makes post-commit uncertainty terminal", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const failBeforeHead: DatabaseClient = {
      query: db.query.bind(db),
      transaction: (callback) => db.transaction((session) => callback(Object.freeze({
        query: <T>(statement: string, params: unknown[] = []) => {
          if (statement.includes("INSERT INTO control_native_observation_authorization_consumption_heads")) {
            throw new Error("synthetic pre-head failure");
          }
          return session.query<T>(statement, params);
        },
      }))),
      transactionWithPreCommitCheck: db.transactionWithPreCommitCheck.bind(db),
    };
    const rollbackStore = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(
      withTrustedDatabaseTime(failBeforeHead, "2026-09-04T15:00:10.000Z"),
      { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey });
    await assert.rejects(rollbackStore.consumeForInvocation(value), expectCode("integrity_failed"));
    let count = await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM control_native_observation_authorization_consumptions");
    assert.equal(count.rows[0]?.count, 0);

    const acknowledgementLoss: DatabaseClient = {
      query: db.query.bind(db),
      transaction: async (callback) => {
        await db.transaction(callback);
        throw new Error("synthetic lost commit acknowledgement");
      },
      transactionWithPreCommitCheck: db.transactionWithPreCommitCheck.bind(db),
    };
    const ambiguousStore = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(
      withTrustedDatabaseTime(acknowledgementLoss, "2026-09-04T15:00:10.000Z"),
      { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey });
    await assert.rejects(ambiguousStore.consumeForInvocation(value), expectCode("terminal_ambiguity"));
    count = await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM control_native_observation_authorization_consumptions");
    assert.equal(count.rows[0]?.count, 1);
    assert.equal((await consumptionStore(db).consumeForInvocation(value)).state, "already_consumed_terminal");
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 authenticates consumption state and rejects mutation", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    await consumptionStore(db).consumeForInvocation(value);
    await assert.rejects(raw.query("DELETE FROM control_native_observation_authorization_consumptions"));
    await assert.rejects(raw.query(
      "UPDATE control_native_observation_authorization_consumptions SET body_digest=body_digest"));
    await assert.rejects(raw.query("TRUNCATE control_native_observation_authorization_consumptions"));
    await raw.query(`UPDATE control_native_observation_authorization_consumption_heads SET head_auth_tag=$1
      WHERE tenant_id=$2`, [hmacSha256Tag(consumptionStateKey, { wrong: true }), tenantId]);
    await assert.rejects(consumptionStore(db).consumeForInvocation(value), expectCode("integrity_failed"));
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 rejects behavioral consumption scalars without executing them", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    await consumptionStore(db).consumeForInvocation(value);
    let executions = 0;
    const coercive = { valueOf() { executions += 1; return 1; },
      [Symbol.toPrimitive]() { executions += 1; return 1; } };
    const lengthAccessor = Object.defineProperty({}, "length", {
      get() { executions += 1; return 71; }, enumerable: true,
    });
    const cases = [
      ["control_native_observation_authorization_consumptions", "sequence", coercive],
      ["control_native_observation_authorization_consumptions", "record_auth_tag", lengthAccessor],
      ["control_native_observation_authorization_consumptions", "consumed_at", coercive],
      ["control_native_observation_authorization_consumption_heads", "last_sequence", coercive],
      ["control_native_observation_authorization_consumption_heads", "head_auth_tag", lengthAccessor],
    ] as const;
    for (const [table, field, hostile] of cases) {
      const hostileDb = withMutatedDatabaseRow(db, table, field, hostile);
      const hostileStore = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(hostileDb,
        { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey });
      await assert.rejects(hostileStore.consumeForInvocation(value), expectCode("integrity_failed"));
    }
    assert.equal(executions, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-370 consumption survives a persistent PGlite process-boundary reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cr13a-live370-restart-"));
  const dataDirectory = join(directory, "pgdata");
  let raw: PGlite | undefined;
  try {
    raw = new PGlite(dataDirectory);
    await migrate(raw);
    await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [tenantId, "Owner"]);
    const db = adaptPglite(raw), value = envelope();
    const registrar = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    await registrar.register(value);
    const first = await consumptionStore(db).consumeForInvocation(value);
    await raw.close(); raw = undefined;
    raw = new PGlite(dataDirectory);
    const replay = await consumptionStore(adaptPglite(raw), "2026-09-04T15:00:20.000Z")
      .consumeForInvocation(value);
    assert.equal(first.freshConsumption, true);
    assert.equal(replay.freshConsumption, false);
    assert.equal(replay.state, "already_consumed_terminal");
    assert.equal(replay.consumedAt, first.consumedAt);
  } finally {
    if (raw) await raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CR13A-LIVE-380 binds the accepted LIVE-370 product and independent review", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_380_POST_TRANSACTION_DATABASE_TIME_RECHECK.md"), "utf8");
  const review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_370_INDEPENDENT_REVIEW.md"));
  assert.equal(createHash("sha256").update(review).digest("hex"),
    "c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490");
  assert.match(architecture, /6f908ccd1f65f48a5d874fa0da96afe301d8decf/);
  assert.match(architecture, /c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490/);
  assert.match(architecture, /new transaction opened only after the spend transaction returned/i);
  assert.match(architecture, /result remains evidence, not a capability/i);
});

test("CR13A-LIVE-380 reauthenticates a committed spend and reads database time again without writes", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const consumption = await consumptionStore(db).consumeForInvocation(value);
    const receipt = await consumptionStore(db, "2026-09-04T15:00:20.000Z")
      .recheckAfterConsumption(value, consumption);
    assert.equal(receipt.state, "consumed_and_post_transaction_time_rechecked");
    assert.equal(receipt.consumedAt, consumption.consumedAt);
    assert.equal(receipt.recheckedAt, "2026-09-04T15:00:20.000Z");
    assert.equal(receipt.consumptionStateAuthenticated, true);
    assert.equal(receipt.postTransactionTimeRechecked, true);
    assert.equal(receipt.exactReplayReturnsNoAuthority, true);
    assert.equal(receipt.sourceLookupPerformed, false);
    assert.equal(receipt.sourceInvocationPerformed, false);
    assert.equal(receipt.nativeReadPerformed, false);
    assert.equal(Object.isFrozen(receipt), true);
    assert.deepEqual(Object.entries(receipt).filter(([key]) => key.startsWith("grants")).map(([, entry]) => entry),
      new Array(8).fill(false));
    const counts = await raw.query<{ consumptions: number; heads: number }>(`SELECT
      (SELECT count(*)::int FROM control_native_observation_authorization_consumptions) AS consumptions,
      (SELECT count(*)::int FROM control_native_observation_authorization_consumption_heads) AS heads`);
    assert.deepEqual(counts.rows[0], { consumptions: 1, heads: 1 });
  } finally { await raw.close(); }
});

test("CR13A-LIVE-380 is read-only on exact replay and enforces monotonic exclusive-expiry time", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const consumption = await consumptionStore(db).consumeForInvocation(value);
    const recheckAt = (trustedNow: string) => consumptionStore(db, trustedNow)
      .recheckAfterConsumption(value, consumption);
    await assert.rejects(recheckAt("2026-09-04T15:00:09.999Z"), expectCode("integrity_failed"));
    assert.equal((await recheckAt(consumption.consumedAt)).recheckedAt, consumption.consumedAt);
    const first = await recheckAt("2026-09-04T15:00:44.999Z");
    assert.deepEqual(await recheckAt("2026-09-04T15:00:44.999Z"), first);
    await assert.rejects(recheckAt(expiresAt), expectCode("expired"));
    const count = await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM control_native_observation_authorization_consumptions");
    assert.equal(count.rows[0]?.count, 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-380 rejects terminal replay and receipt drift before database access", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const fresh = await consumptionStore(db).consumeForInvocation(value);
    const terminal = await consumptionStore(db).consumeForInvocation(value);
    let transactions = 0;
    const guarded: DatabaseClient = {
      query: db.query.bind(db),
      transaction: async () => { transactions += 1; throw new Error("database must remain unread"); },
      transactionWithPreCommitCheck: db.transactionWithPreCommitCheck.bind(db),
    };
    const validator = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(guarded,
      { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey });
    await assert.rejects(validator.recheckAfterConsumption(value, terminal), expectCode("replay_conflict"));
    await assert.rejects(validator.recheckAfterConsumption(value,
      { ...fresh, consumedAt: "2026-09-04T15:00:11.000Z" }), expectCode("replay_conflict"));
    await assert.rejects(validator.recheckAfterConsumption(value, { ...fresh, extra: false }), expectCode("invalid_input"));
    assert.equal(transactions, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-380 rejects hostile receipt values without executing behavior", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const fresh = await consumptionStore(db).consumeForInvocation(value);
    let executions = 0;
    const proxy = new Proxy({}, { ownKeys() { executions += 1; throw new Error("receipt proxy"); } });
    const accessor = Object.defineProperty({ ...fresh }, "consumedAt", {
      enumerable: true, get() { executions += 1; throw new Error("receipt accessor"); },
    });
    const validator = consumptionStore(db, "2026-09-04T15:00:20.000Z");
    await assert.rejects(validator.recheckAfterConsumption(value, proxy), expectCode("invalid_input"));
    await assert.rejects(validator.recheckAfterConsumption(value, accessor), expectCode("invalid_input"));
    await assert.rejects(validator.recheckAfterConsumption(value, Symbol("receipt")), expectCode("invalid_input"));
    assert.equal(executions, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-380 authenticates all durable state before the second clock read", async () => {
  const { raw, db, store } = await setup();
  try {
    const value = envelope();
    await store.register(value);
    const fresh = await consumptionStore(db).consumeForInvocation(value);
    await raw.query(`UPDATE control_native_observation_authorization_consumption_heads SET head_auth_tag=$1
      WHERE tenant_id=$2`, [hmacSha256Tag(consumptionStateKey, { wrong: true }), tenantId]);
    let clockReads = 0;
    const guarded: DatabaseClient = {
      query: db.query.bind(db),
      transaction: (callback) => db.transaction((session) => callback(Object.freeze({
        query: <T>(statement: string, params: unknown[] = []) => {
          if (statement.includes("clock_timestamp()")) clockReads += 1;
          return statement.includes("clock_timestamp()")
            ? Promise.resolve({ rows: [{ trusted_now: "2026-09-04T15:00:20.000Z" }] as T[] })
            : session.query<T>(statement, params);
        },
      }))),
      transactionWithPreCommitCheck: db.transactionWithPreCommitCheck.bind(db),
    };
    const validator = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(guarded,
      { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey });
    await assert.rejects(validator.recheckAfterConsumption(value, fresh), expectCode("integrity_failed"));
    assert.equal(clockReads, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-380 rejects malformed second database time and missing consumption", async () => {
  const { raw, db, store } = await setup();
  let emptyRaw: PGlite | undefined;
  try {
    const value = envelope();
    await store.register(value);
    const fabricatedFresh = await consumptionStore(db).consumeForInvocation(value);
    for (const trustedNow of [[], [expiresAt, expiresAt], "2026-09-04 15:00:20+00",
      new Error("raw database clock failure")] as const) {
      const validator = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(
        withTrustedDatabaseTime(db, trustedNow),
        { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey });
      await assert.rejects(validator.recheckAfterConsumption(value, fabricatedFresh), expectCode("integrity_failed"));
    }
    emptyRaw = new PGlite();
    await migrate(emptyRaw);
    await emptyRaw.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [tenantId, "Owner"]);
    const emptyDb = adaptPglite(emptyRaw);
    await new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(emptyDb,
      { authorizationKey, authorizationKeyIdDigest, stateKey }).register(value);
    await assert.rejects(consumptionStore(emptyDb, "2026-09-04T15:00:20.000Z")
      .recheckAfterConsumption(value, fabricatedFresh), expectCode("consumption_unavailable"));
  } finally {
    if (emptyRaw) await emptyRaw.close();
    await raw.close();
  }
});

test("CR13A-LIVE-380 rechecks the exact committed spend after a persistent PGlite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cr13a-live380-restart-"));
  const dataDirectory = join(directory, "pgdata");
  let raw: PGlite | undefined;
  try {
    raw = new PGlite(dataDirectory);
    await migrate(raw);
    await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [tenantId, "Owner"]);
    const db = adaptPglite(raw), value = envelope();
    const registrar = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
      { authorizationKey, authorizationKeyIdDigest, stateKey });
    await registrar.register(value);
    const fresh = await consumptionStore(db).consumeForInvocation(value);
    await raw.close(); raw = undefined;
    raw = new PGlite(dataDirectory);
    const receipt = await consumptionStore(adaptPglite(raw), "2026-09-04T15:00:20.000Z")
      .recheckAfterConsumption(value, fresh);
    assert.equal(receipt.consumedAt, fresh.consumedAt);
    assert.equal(receipt.recheckedAt, "2026-09-04T15:00:20.000Z");
  } finally {
    if (raw) await raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CR13A-LIVE-350/360/370/380 has no issuer, source consumer, native source, or runtime wiring", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from "node:|import "node:|unreachable-atomic-native-observation-source/);
  assert.doesNotMatch(source, /\.consume\(|sourceLookups: [1-9]|sourceInvocations: [1-9]|nativeReads: [1-9]/);
  assert.deepEqual(Object.getOwnPropertyNames(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype),
    ["constructor", "register", "validateForConsumption", "consumeForInvocation", "recheckAfterConsumption"]);
  const status = CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_STORE_DISABLED_V1;
  assert.equal(Object.isFrozen(status), true);
  assert.equal(status.readOnlyValidationImplemented, true);
  assert.equal(status.atomicConsumptionImplemented, true);
  assert.equal(status.postTransactionTimeRecheckImplemented, true);
  assert.equal(status.trustedDatabaseTimeRequired, true);
  assert.equal(status.productionDatabaseConfigured, false);
  assert.equal(status.productionIssuerImplemented, false);
  assert.equal(status.consumptionStateKeyConfigured, false);
  assert.equal(status.authorizationValidations, 0);
  assert.equal(status.databaseClockReads, 0);
  assert.equal(status.authorizationConsumptions, 0);
  assert.equal(status.sourceLookups, 0);
  assert.equal(status.sourceInvocations, 0);
  assert.equal(status.nativeReads, 0);
  assert.equal(status.externalEffectOccurred, false);
  assert.deepEqual(Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value),
    new Array(8).fill(false));
});
