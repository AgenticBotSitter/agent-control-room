import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { ServerNodeSessionConfig } from "../src/node-control/server-node-session";
import { NATIVE_DELIVERY_FEATURE } from "../src/harness/v1/native-delivery";
import { signNodeFrame } from "../src/node-protocol/v1";
import type { NativeSessionTransport } from "../src/web/v1/managed-native-sessions";
import type { PrivateApplication } from "../src/web/v1/private-process";
import { createPrivateTaskBootstrap, type PrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import type { TaskQualityConfiguration } from "../src/web/v1/task-quality-coordinator";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion";
import { taskStartupFixture } from "./helpers/task-startup";

type QualityFixture = Awaited<ReturnType<typeof nativeQualityCompletionFixture>>;
type EvidenceSettings = NonNullable<PrivateTaskStartupConfiguration["coordinator"]["evidence"]>;
type SessionSettings = NonNullable<PrivateTaskStartupConfiguration["coordinator"]["sessions"]>;

function qualityConfiguration(x: QualityFixture): TaskQualityConfiguration {
  return {
    integrityKey: Uint8Array.from(x.f.ownerConfig.integrityKey),
    harnessIntegrityKey: Uint8Array.from(x.f.ownerConfig.harnessIntegrityKey),
    checkpoints: x.f.ownerConfig.checkpoints,
    results: { ...x.f.ownerConfig.results, integrityKey: Uint8Array.from(x.f.ownerConfig.results.integrityKey) },
    scenarios: [{ ...x.scenario, rules: { ...x.scenario.rules,
      requiredHeadings: [...x.scenario.rules.requiredHeadings], forbiddenTerms: [...x.scenario.rules.forbiddenTerms] } }],
  };
}

function restrictedPool(startup: Awaited<ReturnType<typeof taskStartupFixture>>, login: string) {
  let closes = 0, available = true;
  const client: DatabaseClient = {
    query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
    transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: (work, check) => startup.db.transactionWithPreCommitCheck(async tx => {
      await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
      const session: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        return result;
      } };
      return work(session);
    }, check),
  };
  return { client, close: async () => { closes++; available = false; }, isAvailable: () => available,
    closes: () => closes, quarantine: () => { available = false; } };
}

async function managedStartupFixture() {
  const x = await nativeQualityCompletionFixture();
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  for (const role of ["native_results_roles.sql", "native_evidence_roles.sql", "native_session_roles.sql"])
    await startup.raw.exec(await readFile(`db/roles/${role}`, "utf8"));
  await startup.raw.exec(`CREATE ROLE result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE session_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_results TO result_test; GRANT control_room_native_evidence TO evidence_test;
    GRANT control_room_native_sessions TO session_test`);
  const result = restrictedPool(startup, "result_test"), evidence = restrictedPool(startup, "evidence_test");
  const sessions = restrictedPool(startup, "session_test"), serverKeys = generateKeyPairSync("ed25519");
  const serverPublicKeySpki = serverKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const node: ServerNodeSessionConfig = { tenantId: x.registration.tenantId, nodeId: x.registration.nodeId,
    nodeKeyId: "key:test", serverId: "server:managed", serverKeyId: "key:server:managed", serverPublicKeySpki,
    transportIdentity: "transport:managed", features: [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1"],
    maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 };
  const resultDatabase = { ...startup.config.coordinator.database, username: "result_test" };
  const evidenceDatabase = { ...startup.config.coordinator.database, username: "evidence_test" };
  const sessionDatabase = { ...startup.config.coordinator.database, username: "session_test" };
  const evidenceSettings: EvidenceSettings = { database: evidenceDatabase, integrityKey: new Uint8Array(32).fill(75),
    storage: { ...x.f.config, integrityKey: Uint8Array.from(x.f.config.integrityKey), storage: x.f.config.storage },
    enrollments: [{ ...x.f.prepared.enrollment }] };
  const sessionSettings: SessionSettings = { database: sessionDatabase, nodes: [{ ...node }],
    sign: async frame => signNodeFrame(frame, serverKeys.privateKey) };
  const quality = qualityConfiguration(x);
  const approvals = { enrollments: [{ enrollment: { ...x.f.prepared.enrollment }, nodeClass: "personal-compute" as const }], store: x.f.store };
  const config: PrivateTaskStartupConfiguration = { ...startup.config, coordinator: { ...startup.config.coordinator,
    quality, approvals, resultDatabase, evidence: evidenceSettings, sessions: sessionSettings } };
  const names = { web: startup.config.web.database.username, coordinator: startup.config.coordinator.database.username,
    result: resultDatabase.username, evidence: evidenceDatabase.username, sessions: sessionDatabase.username };
  const openDatabase = (database: { username: string }) => {
    if (database.username === names.web) return startup.web;
    if (database.username === names.coordinator) return startup.coordinator;
    if (database.username === names.result) return result;
    if (database.username === names.evidence) return evidence;
    if (database.username === names.sessions) return sessions;
    throw new Error("unexpected_test_database");
  };
  return { x, startup, result, evidence, sessions, node, resultDatabase, evidenceDatabase, sessionDatabase,
    evidenceSettings, sessionSettings, config, openDatabase };
}

test("managed native sessions verify five roles before install and capture configuration and transport methods", async t => {
  const f = await managedStartupFixture(); t.after(f.x.close);
  let app!: PrivateApplication, installs = 0;
  const opened: string[] = [], preflights: { username: string; current_user: string; session_user: string; rolsuper: boolean }[] = [];
  const bootstrap = createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: database => {
    opened.push(database.username); const pool = f.openDatabase(database), db = pool.client;
    const observe = <T>(work: (tx: DatabaseSession) => Promise<T>) => async (tx: DatabaseSession): Promise<T> => work({ async query<U>(sql: string, params?: unknown[]) {
      const value = await tx.query<U>(sql, params);
      if (sql.includes("AS database_temp")) {
        const identity = (await tx.query<{ current_user: string; session_user: string; rolsuper: boolean }>(
          "SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]!;
        preflights.push({ username: database.username, ...identity });
      }
      return value;
    } });
    return { ...pool, client: { ...db, transaction: work => db.transaction(observe(work)),
      transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(observe(work), check) } };
  }, install: value => { assert.equal(preflights.length, 5); app = value; installs++; } });

  const starting = bootstrap.start(f.config);
  f.config.coordinator.sessions!.database.username = "mutated_session_login";
  f.sessionSettings.nodes[0]!.nodeId = "node:mutated";
  f.sessionSettings.sign = async () => { throw new Error("mutated_sign"); };
  const runtime = await starting;
  assert.equal(installs, 1); assert.equal(runtime.isReady(), true);
  assert.deepEqual(opened, ["web_test", "coordinator_test", "result_test", "evidence_test", "session_test"]);
  assert.deepEqual(preflights, [
    { username: "web_test", current_user: "web_test", session_user: "web_test", rolsuper: false },
    { username: "coordinator_test", current_user: "coordinator_test", session_user: "coordinator_test", rolsuper: false },
    { username: "result_test", current_user: "result_test", session_user: "result_test", rolsuper: false },
    { username: "evidence_test", current_user: "evidence_test", session_user: "evidence_test", rolsuper: false },
    { username: "session_test", current_user: "session_test", session_user: "session_test", rolsuper: false },
  ]);
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "connections", "evidence", "isReady", "quality", "results"]);
  assert.deepEqual(Object.keys(app).sort(), ["close", "connections", "evidence", "handle", "isReady", "quality", "results"]);
  assert.ok(runtime.connections);
  assert.deepEqual(Object.keys(runtime.connections).sort(), ["attach", "attachInput", "tenantId", "workspaceId"]);
  for (const forbidden of ["client", "database", "password", "integrityKey", "privateKey", "session_test"])
    assert.equal(JSON.stringify(runtime).includes(forbidden), false, forbidden);

  let originalCloses = 0, mutatedCloses = 0, available = true;
  const transport: NativeSessionTransport = { send: async () => {}, close: async () => { originalCloses++; available = false; },
    isAvailable: () => available };
  const attaching = runtime.connections.attach(f.x.registration.nodeId, transport);
  transport.send = async () => { throw new Error("mutated_send"); };
  transport.close = async () => { mutatedCloses++; }; transport.isAvailable = () => false;
  const handle = await attaching;
  assert.deepEqual(Object.keys(handle).sort(), ["close", "grantsExecutionAuthority", "hello", "nodeId", "progress", "receipt", "reconcile", "recover", "stage", "transmit"]);
  assert.equal(handle.nodeId, f.x.registration.nodeId); assert.equal(handle.grantsExecutionAuthority, false);
  assert.equal(JSON.stringify(handle).includes("transport"), false);
  await handle.close(); assert.equal(originalCloses, 1); assert.equal(mutatedCloses, 0);

  let inputCloses = 0;
  const input = await runtime.connections.attachInput(f.x.registration.nodeId,
    { send: async () => {}, close: async () => { inputCloses++; }, isAvailable: () => true },
    { mode: "initial", task: { projectId: f.x.registration.projectId, jobId: f.x.registration.jobId,
      attemptId: f.x.registration.attemptId, inputDigest: f.x.registration.nativeTask!.inputDigest } });
  assert.equal(Object.isFrozen(input), true);
  assert.deepEqual(Object.keys(input).sort(), ["close", "grantsExecutionAuthority", "nodeId", "receive", "stage", "transmit"]);
  for (const internal of ["handle", "config", "register", "tail", "state", "pending"])
    assert.equal(internal in input, false);
  assert.equal(input.grantsExecutionAuthority, false);
  await input.close(); await input.close(); assert.equal(inputCloses, 1);

  const closing = runtime.close(); assert.equal(runtime.close(), closing); assert.equal(runtime.isReady(), false); await closing;
  assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1); assert.equal(f.result.closes(), 1);
  assert.equal(f.evidence.closes(), 1); assert.equal(f.sessions.closes(), 1); assert.equal(originalCloses, 1);
  await assert.rejects(async () => handle.hello("{}", new AbortController().signal), { message: "task_coordinator_unavailable" });
});

test("omitting managed sessions preserves the exact prior four-role evidence surface", async t => {
  const f = await managedStartupFixture(); t.after(f.x.close);
  const prior = { ...f.config, coordinator: { ...f.config.coordinator, sessions: undefined } };
  let app!: PrivateApplication, opens = 0;
  const runtime = await createPrivateTaskBootstrap({ clock: f.x.f.clock,
    openDatabase: database => { opens++; return f.openDatabase(database); }, install: value => { app = value; } }).start(prior);
  assert.equal(opens, 4); assert.deepEqual(Object.keys(runtime).sort(), ["close", "evidence", "isReady", "quality", "results"]);
  assert.deepEqual(Object.keys(app).sort(), ["close", "evidence", "handle", "isReady", "quality", "results"]);
  assert.equal("connections" in runtime, false); assert.equal("connections" in app, false);
  await runtime.close(); assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1);
  assert.equal(f.result.closes(), 1); assert.equal(f.evidence.closes(), 1); assert.equal(f.sessions.closes(), 0);
});

test("invalid managed-session topology is rejected before opening any pool", async t => {
  const f = await managedStartupFixture(); t.after(f.x.close); let effects = 0;
  const sessions = f.config.coordinator.sessions!;
  const otherNode = { ...sessions.nodes[0]!, nodeId: "node:other" };
  const variants: PrivateTaskStartupConfiguration[] = [
    { ...f.config, coordinator: { ...f.config.coordinator, evidence: undefined } },
    { ...f.config, coordinator: { ...f.config.coordinator, approvals: undefined } },
    ...[f.config.web.database.username, f.config.coordinator.database.username, f.resultDatabase.username, f.evidenceDatabase.username]
      .map(username => ({ ...f.config, coordinator: { ...f.config.coordinator,
        sessions: { ...sessions, database: { ...sessions.database, username } } } })),
    { ...f.config, coordinator: { ...f.config.coordinator,
      sessions: { ...sessions, database: { ...sessions.database, port: 5433 } } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      sessions: { ...sessions, nodes: [{ ...sessions.nodes[0]!, tenantId: "tenant:other" }] } } },
    { ...f.config, coordinator: { ...f.config.coordinator, sessions: { ...sessions, nodes: [otherNode] } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      sessions: { ...sessions, nodes: [sessions.nodes[0]!, sessions.nodes[0]!] } } },
    { ...f.config, coordinator: { ...f.config.coordinator, sessions: { ...sessions, nodes: [] } } },
  ];
  for (const config of variants) {
    const bootstrap = createPrivateTaskBootstrap({ openDatabase: () => { effects++; throw new Error(); }, install: () => { effects++; } });
    await assert.rejects(bootstrap.start(config), { message: "private_task_startup_config_invalid" });
    await assert.rejects(bootstrap.start(f.config), /already_attempted/);
  }
  assert.equal(effects, 0);
});

test("fifth-pool open, preflight, authority, alias, health and install failures close every acquired resource once", async t => {
  for (const failure of ["fifth-open", "preflight", "extra-rights", "resource-alias", "client-alias", "unavailable", "install"] as const)
    await t.test(failure, async t => {
      const f = await managedStartupFixture(); t.after(f.x.close); let opens = 0, installs = 0;
      if (failure === "preflight")
        await f.startup.raw.exec("REVOKE SELECT ON node_protocol_replay FROM control_room_native_sessions");
      if (failure === "extra-rights")
        await f.startup.raw.exec("GRANT SELECT ON control_completion_gate_records TO control_room_native_sessions");
      if (failure === "unavailable") f.sessions.quarantine();
      const bootstrap = createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: database => {
        opens++;
        if (failure === "fifth-open" && opens === 5) throw new Error("private fifth-open detail");
        if (failure === "resource-alias" && opens === 5) return f.evidence;
        if (failure === "client-alias" && opens === 5) return { ...f.sessions, client: f.evidence.client };
        return f.openDatabase(database);
      }, install: () => { installs++; if (failure === "install") throw new Error("private install detail"); } });
      await assert.rejects(bootstrap.start(f.config), { message: "private_task_startup_prerequisites_failed" });
      assert.equal(installs, failure === "install" ? 1 : 0);
      assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1); assert.equal(f.result.closes(), 1);
      assert.equal(f.evidence.closes(), 1); assert.equal(f.sessions.closes(), ["fifth-open", "resource-alias"].includes(failure) ? 0 : 1);
    });
});

test("fifth-pool health invalidates the runtime and closes an attached transport", async t => {
  const f = await managedStartupFixture(); t.after(f.x.close); let transportCloses = 0;
  const runtime = await createPrivateTaskBootstrap({ clock: f.x.f.clock,
    openDatabase: f.openDatabase, install: () => {} }).start(f.config);
  assert.ok(runtime.connections);
  const handle = await runtime.connections.attach(f.x.registration.nodeId,
    { send: async () => {}, close: async () => { transportCloses++; }, isAvailable: () => true });
  f.sessions.quarantine(); assert.equal(runtime.isReady(), false);
  await assert.rejects(async () => handle.hello("{}", new AbortController().signal), { message: "task_coordinator_unavailable" });
  assert.equal(transportCloses, 0);
  await runtime.close(); assert.equal(f.sessions.closes(), 1); assert.equal(transportCloses, 1);
});

test("failed managed-session cleanup is uncertain and never retried", async t => {
  const f = await managedStartupFixture(); t.after(f.x.close); let sessionCloses = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: database => {
    const pool = f.openDatabase(database);
    return database.username === "session_test" ? { ...pool, close: async () => { sessionCloses++; throw new Error("private close detail"); } } : pool;
  }, install: () => { throw new Error("private install detail"); } });
  await assert.rejects(bootstrap.start(f.config), { message: "private_task_startup_cleanup_uncertain" });
  assert.equal(sessionCloses, 1); assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1);
  assert.equal(f.result.closes(), 1); assert.equal(f.evidence.closes(), 1);
  await assert.rejects(bootstrap.start(f.config), /already_attempted/); assert.equal(sessionCloses, 1);
});
