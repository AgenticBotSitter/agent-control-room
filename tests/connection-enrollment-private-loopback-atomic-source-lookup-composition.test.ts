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
  connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
  parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
} from "../src/connection-registry/v1/private-loopback-atomic-source-lookup-bridge-contract";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_TERMINAL_OUTCOMES_V1,
  ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1,
  connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1,
  connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1,
  connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1,
  connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
  createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1,
  parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1,
  parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1,
} from "../src/connection-registry/v1/private-loopback-unreachable-atomic-native-observation-source";
import { adaptPglite, type DatabaseClient, type DatabaseSession } from "../src/persistence/database";
import { hmacSha256Tag, sha256Digest } from "../src/security";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-unreachable-atomic-native-observation-source";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
const digest = (label: string) => sha256Digest({ label });
const authorizationKey = new Uint8Array(32).fill(91);
const stateKey = new Uint8Array(32).fill(92);
const consumptionStateKey = new Uint8Array(32).fill(93);
const authorizationKeyIdDigest = digest("live420-native-observation-sealing-key");
const tenantId = "tenant:live420-native-observation";
const issuedAt = "2026-09-04T16:00:00.000Z";
const notBefore = "2026-09-04T16:00:01.000Z";
const expiresAt = "2026-09-04T16:00:45.000Z";
const spendAt = "2026-09-04T16:00:10.000Z";
const recheckAt = "2026-09-04T16:00:11.000Z";
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
    candidateId: "candidate:live420-native-observation:001",
    attemptId: "attempt:live420-native-observation:001",
    operation: "observe_target_runtime_once",
    authorizationId: "authorization:live420-native-observation:001",
    nonceDigest: digest("live420-native-observation-nonce-001"),
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
    [tenantId, "LIVE-420 native observation"]);
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
  code: ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1["safeCode"],
): (error: unknown) => boolean {
  return (error) => error instanceof ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1
    && error.safeCode === code && error.message === code && error.stack === undefined;
}

test("CR13A-LIVE-420 binds exact accepted LIVE-410 evidence and continuity", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_420_PRIVATE_ATOMIC_SOURCE_LOOKUP_BRIDGE_IMPLEMENTATION.md"), "utf8");
  const review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_410_INDEPENDENT_REVIEW.md"));
  assert.equal(createHash("sha256").update(review).digest("hex"),
    "c3f79f0ad2634a2bcbb0abd39eeb21c1b54154e1389a020b0839343f3ffb0bbf");
  assert.match(architecture, /e4d58ff35a44e66454cae8e778b31362902dab6b/);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1(
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1),
  connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1);
  assert.equal(connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1.live330ProductCommit,
    "06be655d188c45902c015f85225673dfc31c445d");
  assert.equal(connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1.live400ProductCommit,
    "ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3");
  assert.equal(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1(
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1),
  connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1);
  assert.equal(Object.isFrozen(connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1), true);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_TERMINAL_OUTCOMES_V1, [
    "rejected_before_spend", "terminal_spend_uncertain", "terminal_already_consumed",
    "terminal_recheck_failed", "terminal_source_lookup_failed",
    "completed_lookup_and_stopped_before_invocation",
  ]);
});

test("CR13A-LIVE-420 reports guarded private reachability with zero invocation", () => {
  const source = connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1;
  const sourceStatus = connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1;
  assert.equal(source.atomicSourceRetrievable, true);
  assert.equal(source.retrievalGuardedByPrivateSpendRecheck, true);
  assert.equal(source.lookupBridgeBarrelExported, false);
  assert.equal(source.atomicSourceExported, false);
  assert.equal(source.atomicSourceInvoked, false);
  assert.equal(sourceStatus.sourceState, "stored_private_lookup_guarded_uninvoked");
  assert.equal(sourceStatus.lookupBridgeState, "implemented_unwired");
  assert.equal(sourceStatus.actualSourceLookups, 0);
  assert.equal(sourceStatus.actualSourceInvocations, 0);
});

test("CR13A-LIVE-420 spends, rechecks, looks up once, and stops before invocation", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const result = await createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, recheckAt]), protectedKeys).run(value);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1(result), result);
    assert.deepEqual({ outcome: result.outcome, spend: result.spendCalls, recheck: result.recheckCalls,
      lookup: result.sourceLookupCalls, lookedUp: result.sourceLookupPerformed }, {
      outcome: "completed_lookup_and_stopped_before_invocation", spend: 1, recheck: 1, lookup: 1, lookedUp: true,
    });
    assert.equal(result.sourceInvocationPerformed, false);
    assert.equal(result.nativeReadPerformed, false);
    assert.equal(result.rawObservationCreated, false);
    assert.equal(result.externalEffectOccurred, false);
    assert.equal(await consumptionCount(raw), 1);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized,
      /authorization:live420|candidate:live420|attempt:live420|consumedAt|recheckedAt|runtimeVersion|executablePath/);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-420 replay is terminal and performs no second lookup", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const runner = createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, recheckAt]), protectedKeys);
    assert.equal((await runner.run(value)).outcome, "completed_lookup_and_stopped_before_invocation");
    const replay = await runner.run(value);
    assert.deepEqual({ outcome: replay.outcome, recheck: replay.recheckCalls, lookup: replay.sourceLookupCalls }, {
      outcome: "terminal_already_consumed", recheck: 0, lookup: 0,
    });
    assert.equal(replay.retryAllowedByResult, false);
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-420 concurrent entries converge to one private lookup", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const runner = createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, recheckAt]), protectedKeys);
    const results = await Promise.all([runner.run(value), runner.run(value)]);
    assert.deepEqual(results.map((entry) => entry.outcome).sort(),
      ["completed_lookup_and_stopped_before_invocation", "terminal_already_consumed"]);
    assert.equal(results.reduce((sum, entry) => sum + entry.sourceLookupCalls, 0), 1);
    assert.equal(results.reduce((sum, entry) => sum + Number(entry.sourceInvocationPerformed), 0), 0);
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-420 post-spend expiry is terminal before source lookup", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const result = await createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, expiresAt]), protectedKeys).run(value);
    assert.deepEqual({ outcome: result.outcome, recheck: result.recheckCalls, lookup: result.sourceLookupCalls }, {
      outcome: "terminal_recheck_failed", recheck: 1, lookup: 0,
    });
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-420 commit uncertainty stops before recheck and lookup", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const result = await createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
      failTransaction(withTrustedDatabaseTimes(db, [spendAt]), 1, true), protectedKeys).run(value);
    assert.deepEqual({ outcome: result.outcome, spendState: result.spendState, recheck: result.recheckCalls,
      lookup: result.sourceLookupCalls }, {
      outcome: "terminal_spend_uncertain", spendState: "unknown_or_spent", recheck: 0, lookup: 0,
    });
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-420 recheck database failure is terminal before lookup", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const result = await createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
      failTransaction(withTrustedDatabaseTimes(db, [spendAt]), 2, false), protectedKeys).run(value);
    assert.equal(result.outcome, "terminal_recheck_failed");
    assert.equal(result.sourceLookupCalls, 0);
    assert.equal(result.retryAllowedByResult, false);
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-420 mid-flight mutation cannot cross the lookup boundary", async () => {
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
    const pending = createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
      pausing, protectedKeys).run(value);
    await committed;
    value.authorizationAuthTag = hmacSha256Tag(authorizationKey, { changed: true });
    releaseReturn();
    const result = await pending;
    assert.equal(result.outcome, "terminal_recheck_failed");
    assert.equal(result.sourceLookupCalls, 0);
    assert.equal(await consumptionCount(raw), 1);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-420 hostile inputs and dependencies trigger no hostile behavior", async () => {
  const { raw, db } = await setup();
  try {
    const runner = createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
      withTrustedDatabaseTimes(db, []), protectedKeys);
    let executions = 0;
    const accessor = Object.defineProperty({}, "body", { enumerable: true, get() { executions += 1; return {}; } });
    const proxy = new Proxy({}, { ownKeys() { executions += 1; return []; }, get() { executions += 1; return 1; } });
    for (const hostile of [null, Symbol("authorization"), accessor, proxy]) {
      const result = await runner.run(hostile);
      assert.equal(result.outcome, "rejected_before_spend");
      assert.equal(result.sourceLookupCalls, 0);
    }
    assert.equal(executions, 0);
    assert.equal(await consumptionCount(raw), 0);
  } finally { await raw.close(); }
  let executions = 0;
  const database = new Proxy({}, { get() { executions += 1; return () => undefined; } });
  assert.throws(() => createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
    database as DatabaseClient, protectedKeys), expectImplementationCode("invalid_factory_input"));
  assert.equal(executions, 0);
});

test("CR13A-LIVE-420 exact records reject copies and retain captured parser intrinsics", async () => {
  const { raw, db, registrationStore } = await setup();
  try {
    const value = envelope();
    await registrationStore.register(value);
    const result = await createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1(
      withTrustedDatabaseTimes(db, [spendAt, recheckAt]), protectedKeys).run(value);
    assert.equal(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1(
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1),
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1);
    for (const forged of [{ ...result }, Symbol("result")]) {
      assert.throws(() => parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1(forged),
        expectImplementationCode("invalid_result"));
    }
    let executions = 0;
    const proxy = new Proxy({}, { get() { executions += 1; return result; }, ownKeys() { executions += 1; return []; } });
    assert.throws(() => parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1(proxy),
      expectImplementationCode("invalid_result"));
    const originalIsFrozen = Object.isFrozen;
    const originalWeakSetHas = WeakSet.prototype.has;
    const originalWeakMapGet = WeakMap.prototype.get;
    const originalReflectApply = Reflect.apply;
    try {
      Object.isFrozen = () => { executions += 1; return false; };
      WeakSet.prototype.has = function () { executions += 1; return false; };
      WeakMap.prototype.get = function () { executions += 1; return undefined; };
      Reflect.apply = () => { executions += 1; throw new Error("ambient"); };
      assert.equal(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1(result), result);
    } finally {
      Object.isFrozen = originalIsFrozen;
      WeakSet.prototype.has = originalWeakSetHas;
      WeakMap.prototype.get = originalWeakMapGet;
      Reflect.apply = originalReflectApply;
    }
    assert.equal(executions, 0);
  } finally { await raw.close(); }
});

test("CR13A-LIVE-420 publishes zero static actuals and eight false grants", () => {
  const status = connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1;
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 22);
  assert.deepEqual(actuals, new Array(22).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.sourceBoundaryCrossed, false);
});

test("CR13A-LIVE-420 has one guarded same-module lookup and no invocation or runtime consumer", async () => {
  const source = await readFile(modulePath, "utf8");
  const barrel = await readFile(resolve(root, "src/connection-registry/v1/index.ts"), "utf8");
  assert.equal((source.match(/weakMapGetV1, quarantinedAtomicNativeObservationSourcesV1/g) ?? []).length, 1);
  assert.match(source, /runPrivateAtomicSourceLookupCompositionV1/);
  assert.match(source, /consumeForInvocationV1/);
  assert.match(source, /recheckAfterConsumptionV1/);
  assert.match(source, /privateSource !== quarantinedAtomicNativeObservationSourceV1/);
  assert.doesNotMatch(source, /privateSource\s*\(/);
  assert.doesNotMatch(source, /createPostgresClient|process\.env|fetch\(|listen\(|spawn\(|exec\(/);
  assert.doesNotMatch(barrel,
    /export \* from "\.\/private-loopback-unreachable-atomic-native-observation-source";/);
  const productionFiles = (await readdir(resolve(root, "src/connection-registry/v1")))
    .filter((name) => name.endsWith(".ts") && name !== `${moduleName}.ts`);
  const consumers: string[] = [];
  for (const file of productionFiles) {
    const text = await readFile(resolve(root, "src/connection-registry/v1", file), "utf8");
    if (text.includes(`${moduleName}"`)) consumers.push(file);
  }
  assert.deepEqual(consumers, []);
  const migrations = (await readdir(resolve(root, "db/migrations"))).filter((name) => name.endsWith(".sql"));
  assert.equal(migrations.length, 38);
});
