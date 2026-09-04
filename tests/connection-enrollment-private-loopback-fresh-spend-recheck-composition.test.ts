import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_BODY_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_ENVELOPE_V1,
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1,
  type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1,
} from "../src/connection-registry/v1";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_TERMINAL_OUTCOMES_V1,
  ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1,
  connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1,
  connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1,
  createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1,
  parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1,
  parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1,
} from "../src/connection-registry/v1/private-loopback-fresh-spend-recheck-composition";
import { adaptPglite, type DatabaseClient, type DatabaseSession } from "../src/persistence/database";
import { hmacSha256Tag, sha256Digest } from "../src/security";

const root = resolve(import.meta.dirname, "..");
const modulePath = resolve(root,
  "src/connection-registry/v1/private-loopback-fresh-spend-recheck-composition.ts");
const digest = (label: string) => sha256Digest({ label });
const authorizationKey = new Uint8Array(32).fill(81);
const stateKey = new Uint8Array(32).fill(82);
const consumptionStateKey = new Uint8Array(32).fill(83);
const authorizationKeyIdDigest = digest("live400-native-observation-sealing-key");
const tenantId = "tenant:live400-native-observation";
const issuedAt = "2026-09-04T15:00:00.000Z";
const notBefore = "2026-09-04T15:00:01.000Z";
const expiresAt = "2026-09-04T15:00:45.000Z";
const spendAt = "2026-09-04T15:00:10.000Z";
const recheckAt = "2026-09-04T15:00:11.000Z";
const protectedKeys = { authorizationKey, authorizationKeyIdDigest, stateKey, consumptionStateKey };

async function migrate(raw: PGlite): Promise<void> {
  for (const file of (await readdir(resolve(root, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve(root, "db/migrations", file), "utf8"));
  }
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
    candidateId: "candidate:live400-native-observation:001",
    attemptId: "attempt:live400-native-observation:001",
    operation: "observe_target_runtime_once",
    authorizationId: "authorization:live400-native-observation:001",
    nonceDigest: digest("live400-native-observation-nonce-001"),
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

async function setup(): Promise<{ raw: PGlite; db: DatabaseClient;
  registrationStore: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1 }> {
  const raw = new PGlite();
  await migrate(raw);
  await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)",
    [tenantId, "LIVE-400 native observation"]);
  const db = adaptPglite(raw);
  return { raw, db, registrationStore: new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(db,
    { authorizationKey, authorizationKeyIdDigest, stateKey }) };
}

function withTrustedDatabaseTimes(database: DatabaseClient, values: readonly string[]): DatabaseClient {
  let clockIndex = 0;
  const wrapSession = (session: DatabaseSession): DatabaseSession => Object.freeze({
    query: <T>(statement: string, params: unknown[] = []) => statement.includes("clock_timestamp()")
      ? Promise.resolve({ rows: values[clockIndex] === undefined ? [] as T[]
        : [{ trusted_now: values[clockIndex++] }] as T[] })
      : session.query<T>(statement, params),
  });
  return Object.freeze({
    query: database.query.bind(database),
    transaction: <T>(callback: (session: DatabaseSession) => Promise<T>) =>
      database.transaction((session) => callback(wrapSession(session))),
    transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>, check: () => void) =>
      database.transactionWithPreCommitCheck((session) => callback(wrapSession(session)), check),
  });
}

function failTransaction(database: DatabaseClient, target: number, afterCommit: boolean): DatabaseClient {
  let transactionCalls = 0;
  return Object.freeze({
    query: database.query.bind(database),
    transaction: async <T>(callback: (session: DatabaseSession) => Promise<T>) => {
      transactionCalls += 1;
      if (transactionCalls === target && !afterCommit) throw new Error("synthetic transaction rejection");
      const value = await database.transaction(callback);
      if (transactionCalls === target && afterCommit) throw new Error("synthetic uncertain commit return");
      return value;
    },
    transactionWithPreCommitCheck: database.transactionWithPreCommitCheck.bind(database),
  });
}

async function consumptionCount(raw: PGlite): Promise<number> {
  const result = await raw.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM control_native_observation_authorization_consumptions");
  return result.rows[0]?.count ?? -1;
}

function expectImplementationCode(
  code: ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1["safeCode"],
): (error: unknown) => boolean {
  return (error) => error instanceof ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1
    && error.safeCode === code && error.message === code && error.stack === undefined;
}

test("CR13A-LIVE-400 binds exact accepted LIVE-390 evidence and freezes its public record", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_400_PRIVATE_FRESH_SPEND_RECHECK_COMPOSITION_IMPLEMENTATION.md"), "utf8");
  const review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_390_INDEPENDENT_REVIEW.md"));
  assert.equal(createHash("sha256").update(review).digest("hex"),
    "c41370441890e64ef53c76c65a8990119520f550cea093e59aa71d7a4926e586");
  assert.match(architecture, /34640c7c6a3c63b781aa848f687ae1c23e7c2dee/);
  assert.match(architecture, /c41370441890e64ef53c76c65a8990119520f550cea093e59aa71d7a4926e586/);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1(
    connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1),
  connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1), true);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_TERMINAL_OUTCOMES_V1,
    ["rejected_before_spend", "terminal_spend_uncertain", "terminal_already_consumed", "terminal_recheck_failed",
      "completed_and_stopped_before_lookup"]);
});

test("CR13A-LIVE-400 privately spends, immediately rechecks, and stops before lookup", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const runner = createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, recheckAt]), protectedKeys);
    const result = await runner.run(value);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1(result), result);
    assert.deepEqual({ outcome: result.outcome, spendState: result.spendState, spendCalls: result.spendCalls,
      recheckCalls: result.recheckCalls, rechecked: result.postTransactionTimeRechecked }, {
      outcome: "completed_and_stopped_before_lookup", spendState: "spent", spendCalls: 1,
      recheckCalls: 1, rechecked: true,
    });
    assert.equal(result.sourceLookupPerformed, false);
    assert.equal(result.sourceInvocationPerformed, false);
    assert.equal(result.nativeReadPerformed, false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(await consumptionCount(raw), 1);
    const keys = Object.keys(result);
    for (const forbidden of ["authorizationIdDigest", "nonceDigest", "bodyDigest", "consumedAt", "recheckedAt",
      "consumptionDigest", "recheckDigest"]) assert.equal(keys.includes(forbidden), false);
    assert.doesNotMatch(JSON.stringify(result), /owner-mac|authorization:live400|candidate:live400|attempt:live400/);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-400 exact replay is terminal and cannot recheck or spend twice", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const runner = createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, recheckAt]), protectedKeys);
    assert.equal((await runner.run(value)).outcome, "completed_and_stopped_before_lookup");
    const replay = await runner.run(value);
    assert.deepEqual({ outcome: replay.outcome, spendState: replay.spendState, spendCalls: replay.spendCalls,
      recheckCalls: replay.recheckCalls }, {
      outcome: "terminal_already_consumed", spendState: "spent", spendCalls: 1, recheckCalls: 0,
    });
    assert.equal(replay.retryAllowedByResult, false);
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-400 concurrent entries converge to one fresh flow", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const runner = createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, recheckAt]), protectedKeys);
    const results = await Promise.all([runner.run(value), runner.run(value)]);
    assert.deepEqual(results.map((entry) => entry.outcome).sort(),
      ["completed_and_stopped_before_lookup", "terminal_already_consumed"]);
    assert.equal(results.reduce((sum, entry) => sum + entry.recheckCalls, 0), 1);
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-400 post-spend expiry is terminal with the durable spend retained", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const result = await createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, expiresAt]), protectedKeys).run(value);
    assert.deepEqual({ outcome: result.outcome, spendState: result.spendState, recheckCalls: result.recheckCalls,
      rechecked: result.postTransactionTimeRechecked }, {
      outcome: "terminal_recheck_failed", spendState: "spent", recheckCalls: 1, rechecked: false,
    });
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-400 commit-return uncertainty stops without recheck", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const uncertain = failTransaction(withTrustedDatabaseTimes(db, [spendAt]), 1, true);
    const result = await createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
      uncertain, protectedKeys).run(value);
    assert.deepEqual({ outcome: result.outcome, spendState: result.spendState, recheckCalls: result.recheckCalls }, {
      outcome: "terminal_spend_uncertain", spendState: "unknown_or_spent", recheckCalls: 0,
    });
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-400 recheck database failure remains terminal after one spend", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const failSecond = failTransaction(withTrustedDatabaseTimes(db, [spendAt]), 2, false);
    const result = await createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
      failSecond, protectedKeys).run(value);
    assert.equal(result.outcome, "terminal_recheck_failed");
    assert.equal(result.recheckCalls, 1);
    assert.equal(result.retryAllowedByResult, false);
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-400 mid-flight sealed-value mutation can only terminate after spend", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    let notifyCommitted!: () => void, releaseReturn!: () => void;
    const committed = new Promise<void>((resolve) => { notifyCommitted = resolve; });
    const release = new Promise<void>((resolve) => { releaseReturn = resolve; });
    const trusted = withTrustedDatabaseTimes(db, [spendAt, recheckAt]);
    let calls = 0;
    const pausing: DatabaseClient = Object.freeze({
      query: trusted.query.bind(trusted),
      transaction: async <T>(callback: (session: DatabaseSession) => Promise<T>) => {
        calls += 1;
        const result = await trusted.transaction(callback);
        if (calls === 1) { notifyCommitted(); await release; }
        return result;
      },
      transactionWithPreCommitCheck: trusted.transactionWithPreCommitCheck.bind(trusted),
    });
    const pending = createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
      pausing, protectedKeys).run(value);
    await committed;
    value.authorizationAuthTag = hmacSha256Tag(authorizationKey, { changed: true });
    releaseReturn();
    const result = await pending;
    assert.equal(result.outcome, "terminal_recheck_failed");
    assert.equal(result.sourceLookupPerformed, false);
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-400 hostile and malformed inputs reject before spending without behavior", async () => {
  const { raw, db } = await setup();
  try {
    const runner = createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
      withTrustedDatabaseTimes(db, []), protectedKeys);
    let executions = 0;
    const accessor = Object.defineProperty({}, "body", { enumerable: true, get() { executions += 1; return {}; } });
    const proxy = new Proxy({}, { ownKeys() { executions += 1; return []; }, get() { executions += 1; return 1; } });
    for (const hostile of [null, Symbol("authorization"), accessor, proxy]) {
      const result = await runner.run(hostile);
      assert.equal(result.outcome, "rejected_before_spend");
      assert.equal(result.spendState, "not_spent");
      assert.equal(result.recheckCalls, 0);
    }
    assert.equal(executions, 0);
    assert.equal(await consumptionCount(raw), 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-400 rejects hostile factory dependencies with one safe error", async () => {
  let executions = 0;
  const database = new Proxy({}, { get() { executions += 1; return () => undefined; } });
  assert.throws(() => createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
    database as DatabaseClient, protectedKeys), expectImplementationCode("invalid_factory_input"));
  assert.throws(() => createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1({} as DatabaseClient,
    { authorizationKey, authorizationKeyIdDigest, stateKey: authorizationKey, consumptionStateKey }),
  expectImplementationCode("invalid_factory_input"));
  assert.equal(executions, 0);
});

test("CR13A-LIVE-400 records and results reject copies, accessors, Symbols, and Proxies", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const result = await createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, recheckAt]), protectedKeys).run(value);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1(
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1),
    connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1);
    let executions = 0;
    const accessor = Object.defineProperty({}, "resultVersion", {
      enumerable: true, get() { executions += 1; return result.resultVersion; },
    });
    const proxy = new Proxy({}, { get() { executions += 1; return result; }, ownKeys() { executions += 1; return []; } });
    for (const forged of [{ ...result }, accessor, proxy, Symbol("result")]) {
      assert.throws(() => parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1(forged),
        expectImplementationCode("invalid_result"));
    }
    assert.throws(() => parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1(
      { ...connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1 }),
    expectImplementationCode("invalid_implementation"));
    assert.equal(executions, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-400 remains absent from the barrel and source/native/runtime consumers", async () => {
  const source = await readFile(modulePath, "utf8");
  const barrel = await readFile(resolve(root, "src/connection-registry/v1/index.ts"), "utf8");
  assert.doesNotMatch(source, /node:(?:os|process|net|child_process)/);
  assert.doesNotMatch(source, /unreachable-atomic-native-observation-source|native-target-runtime-observer/);
  assert.doesNotMatch(source, /createPostgresClient|process\.env|fetch\(|listen\(|spawn\(|exec\(/);
  assert.doesNotMatch(barrel,
    /export \* from "\.\/private-loopback-fresh-spend-recheck-composition";/);
  const productionFiles = (await readdir(resolve(root, "src/connection-registry/v1")))
    .filter((name) => name.endsWith(".ts") && name !== "private-loopback-fresh-spend-recheck-composition.ts");
  const consumers: string[] = [];
  for (const file of productionFiles) {
    const text = await readFile(resolve(root, "src/connection-registry/v1", file), "utf8");
    if (text.includes("private-loopback-fresh-spend-recheck-composition\"")) consumers.push(file);
  }
  assert.deepEqual(consumers, []);
  const status = connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1;
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 23);
  assert.deepEqual(actuals, new Array(23).fill(0));
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.sourceBoundaryCrossed, false);
  assert.equal(status.runtimeWired, false);
});
