import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TLSSocket } from "node:tls";
import test from "node:test";
import type { DatabaseSession } from "../src/persistence/database";
import type { NativeSessionTransport } from "../src/web/v1/managed-native-sessions";
import type { PrivateApplication } from "../src/web/v1/private-process";
import { createPrivateTaskBootstrap, type PrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import { managedStartupFixture } from "./helpers/managed-startup";
import { readFile } from "node:fs/promises";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";

test("queue-worker topology and missing factory refuse before any database opens", async t => {
  const f = await managedStartupFixture(); t.after(f.x.close);
  const database = { ...f.config.coordinator.database, username: "worker_test" };
  const valid = { ...f.config, coordinator: { ...f.config.coordinator, nativeQueue: true as const, queueWorker: { database } } };
  const variants: PrivateTaskStartupConfiguration[] = [valid,
    { ...valid, coordinator: { ...valid.coordinator, nativeQueue: undefined } },
    { ...valid, coordinator: { ...valid.coordinator, sessions: undefined } },
    ...[f.config.web.database.username, f.config.coordinator.database.username, "result_test", "evidence_test", "session_test"]
      .map(username => ({ ...valid, coordinator: { ...valid.coordinator, queueWorker: { database: { ...database, username } } } })),
    { ...valid, coordinator: { ...valid.coordinator, queueWorker: { database: { ...database, port: 5433 } } } },
    { ...valid, coordinator: { ...valid.coordinator, queueWorker: { database, concurrency: 9 } } },
  ];
  let effects = 0;
  for (const config of variants) {
    const bootstrap = createPrivateTaskBootstrap({ openDatabase: () => { effects++; throw new Error(); }, install: () => { effects++; },
      prepareNativeSubmission: async () => { effects++; throw new Error(); },
      startNativeWorker: config === valid ? undefined : async () => { effects++; throw new Error(); } });
    await assert.rejects(bootstrap.start(config), /config_invalid/);
  }
  assert.equal(effects, 0);
});

test("explicit host startup owns worker readiness and worker-before-application cleanup", async t => {
  for (const mode of ["success", "ideas", "idea-runtime", "start", "not-ready", "install", "close", "malformed", "getter", "late"] as const) await t.test(mode, async t => {
    const f = await managedStartupFixture(); t.after(f.x.close);
    const ideaPool = mode === "ideas" || mode === "idea-runtime" ? f.startup.pool("idea_test") : undefined;
    const ideaRuntimePool = mode === "idea-runtime" ? f.startup.pool("idea_runtime_test") : undefined;
    let ideaRuntimeCloses = 0;
    if (ideaPool) {
      await f.startup.raw.exec(await readFile("db/roles/idea_creation_roles.sql", "utf8"));
      await f.startup.raw.exec("CREATE ROLE idea_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT control_room_idea_creation TO idea_test");
      const integrityKey = new Uint8Array(32).fill(67);
      f.config.web.ideaProjects = { integrityKey };
      f.config.coordinator.ideaCreation = { integrityKey, participants: buildIdeaLabFixtureV1().session.participants,
        database: { ...f.config.coordinator.database, username: "idea_test" } };
    }
    if (ideaRuntimePool) {
      await f.startup.raw.exec(await readFile("db/roles/idea_runtime_roles.sql", "utf8"));
      await f.startup.raw.exec("CREATE ROLE idea_runtime_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT control_room_idea_runtime TO idea_runtime_test");
      f.config.coordinator.ideaRuntime = { database: { ...f.config.coordinator.database, username: "idea_runtime_test" },
        close: async () => { ideaRuntimeCloses++; }, runtime: {
          resolve: async () => { throw new Error("unused runtime"); },
          driver: { mode: "hermes_bot_mode_filtered", invoke: async () => { throw new Error("unused driver"); } },
          evidenceAuthority: { verify: async () => false }, admissionAuthority: { consume: async () => false },
        } };
    }
    // Minimal ACL fixture only: no queue package/schema correctness claim. Actual
    // pg-boss startup and queue behavior are covered by the opt-in package tests.
    await f.startup.raw.exec(`CREATE SCHEMA control_room_queue;
      CREATE TABLE control_room_queue.version(version integer);
      CREATE TABLE control_room_queue.queue(name text);
      CREATE TABLE control_room_queue.job(id text);
      CREATE TABLE control_room_queue.job_common(id text);
      REVOKE ALL ON SCHEMA control_room_queue FROM PUBLIC;
      GRANT USAGE ON SCHEMA control_room_queue TO control_room_task_coordinator;
      GRANT SELECT ON ALL TABLES IN SCHEMA control_room_queue TO control_room_task_coordinator;
      GRANT INSERT ON control_room_queue.job, control_room_queue.job_common TO control_room_task_coordinator;
      GRANT UPDATE(name) ON control_room_queue.queue TO control_room_task_coordinator;`);
    let installed: PrivateApplication | undefined, workerCloses = 0, producerCloses = 0, accepting = true;
    let releaseLate!: () => void, notifyStarted!: () => void;
    const workerStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
    const database = { ...f.config.coordinator.database, username: "worker_test" };
    const bootstrap = createPrivateTaskBootstrap({ clock: f.x.f.clock,
      openDatabase: db => db.username === "idea_runtime_test" && ideaRuntimePool ? ideaRuntimePool : db.username === "idea_test" && ideaPool ? ideaPool : f.openDatabase(db),
      install: app => { installed = app; if (mode === "install") throw new Error("synthetic install failure"); },
      prepareNativeSubmission: async () => ({ enqueueInSession: async () => { throw new Error("unused fake producer"); },
        close: async () => { producerCloses++; assert.equal(workerCloses, ["start", "late"].includes(mode) ? 0 : 1); } }),
      startNativeWorker: async input => {
        assert.equal(installed, undefined); assert.equal(input.database.username, "worker_test");
        assert.deepEqual(input.application.loginNames, ["web_test", "coordinator_test", "result_test", "evidence_test", "session_test", ...(ideaPool ? ["idea_test"] : []), ...(ideaRuntimePool ? ["idea_runtime_test"] : [])]);
        if (ideaRuntimePool) {
          const { createNativeQueueWorkerBootstrap } = await import("../src/web/v1/native-queue-worker-startup");
          let opened = 0;
          const check = createNativeQueueWorkerBootstrap({ PgBoss: class {} as never,
            openDatabase: () => { opened++; throw new Error("synthetic stop after topology validation"); } });
          await assert.rejects(check.start(input)); assert.equal(opened, 1);
        }
        assert.equal(input.concurrency, 1); assert.equal(typeof input.deliver, "function");
        if (mode === "start") throw new Error("synthetic worker start failure");
        if (mode === "late") {
          const waiting = new Promise<void>(resolve => { releaseLate = resolve; }); notifyStarted(); await waiting;
          await assert.rejects(input.deliver({} as never, new AbortController().signal), /native_task_delivery_unresolved/);
        }
        return { get status() {
          if (mode === "getter") throw new Error("synthetic status getter failure");
          return mode === "malformed" ? undefined! : () => ({ accepting: mode !== "not-ready" && accepting });
        },
          close: async () => {
            workerCloses++;
            assert.equal(f.startup.coordinator.closes(), mode === "late" ? 1 : 0);
            assert.equal(f.sessions.closes(), mode === "late" ? 1 : 0);
            accepting = false;
            if (mode === "close") throw new Error("synthetic worker close failure");
          } };
      } });
    const config = { ...f.config, coordinator: { ...f.config.coordinator, nativeQueue: true as const, queueWorker: { database } } };
    if (mode === "late") {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const pending = bootstrap.start(config);
      await workerStarted; t.mock.timers.tick(30_000);
      await assert.rejects(pending, /cleanup_uncertain/);
      releaseLate(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(installed, undefined); t.mock.timers.reset();
    } else if (["start", "not-ready", "install", "malformed", "getter"].includes(mode)) {
      await assert.rejects(bootstrap.start(config), mode === "start" ? /cleanup_uncertain/ : /prerequisites_failed/);
      assert.equal(installed === undefined, mode !== "install");
    } else {
      const runtime = await bootstrap.start(config);
      assert.equal(runtime.isReady(), true);
      accepting = false; assert.equal(runtime.isReady(), false);
      assert.equal((await installed!.handle(new Request("https://example.test/"), () => new Response())).status, 503);
      if (mode === "close") {
        await assert.rejects(runtime.close(), /cleanup_uncertain/);
        await assert.rejects(runtime.close(), /cleanup_uncertain/);
      } else { await runtime.close(); await runtime.close(); }
    }
    assert.equal(workerCloses, mode === "start" ? 0 : 1); assert.equal(producerCloses, 1);
    assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1);
    assert.equal(f.result.closes(), 1); assert.equal(f.evidence.closes(), 1); assert.equal(f.sessions.closes(), 1);
    if (ideaRuntimePool) { assert.equal(ideaRuntimePool.closes(), 1); assert.equal(ideaRuntimeCloses, 1); }
    await assert.rejects(bootstrap.start(config), /already_attempted/);
  });
});

test("verified startup mounts separate machine HTTP settings before preflight and preserves its current generation on unknown peers or tokens", async t => {
  const f = await managedStartupFixture(); t.after(f.x.close);
  const raw = Buffer.from("synthetic connector certificate");
  const certificateDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  let current = true;
  const nativeHttp = { origin: "https://machine.example.test", peers: [{ nodeId: f.x.registration.nodeId, certificateDigest,
    task: { projectId: f.x.registration.projectId, jobId: f.x.registration.jobId,
      attemptId: f.x.registration.attemptId, inputDigest: f.x.registration.nativeTask!.inputDigest } }],
  isPeerCurrent: () => current };
  const starting = createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: f.openDatabase, install: () => {} })
    .start({ ...f.config, coordinator: { ...f.config.coordinator, nativeHttp } });
  nativeHttp.origin = "https://mutated.example.test"; nativeHttp.peers[0].nodeId = "node:mutated";
  nativeHttp.peers[0].task.jobId = "job:mutated"; nativeHttp.isPeerCurrent = () => { throw new Error("mutated peer callback"); };
  const runtime = await starting; t.after(runtime.close); assert.ok(runtime.nativeHttp);
  assert.equal(typeof runtime.nativeHttp.handleNode, "function"); assert.equal(runtime.isReady(), true);
  const socket = { encrypted: true, authorized: true, destroyed: false, getPeerCertificate: () => ({ raw }) } as unknown as TLSSocket;
  const request = (value: unknown) => {
    const body = JSON.stringify(value);
    return new Request("https://machine.example.test/v1/control-room/native", { method: "POST", body,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } });
  };
  const opened = await runtime.nativeHttp.handle(request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" }), socket);
  assert.equal(opened.status, 200);
  const { connection } = await opened.json();
  const exchange = { schema: "control-room.native-http/v1", operation: "exchange", connection, packet: null };
  const unknown = { ...socket, getPeerCertificate: () => ({ raw: Buffer.from("unknown certificate") }) } as unknown as TLSSocket;
  assert.equal((await runtime.nativeHttp.handle(request(exchange), unknown)).status, 503);
  assert.equal((await runtime.nativeHttp.handle(request({ ...exchange, connection: "connection:http:00000000-0000-4000-8000-000000000000" }), socket)).status, 503);
  assert.equal((await runtime.nativeHttp.handle(request(exchange), socket)).status, 200);
  current = false; assert.equal((await runtime.nativeHttp.handle(request(exchange), socket)).status, 503);
  await runtime.close(); assert.equal(runtime.isReady(), false);
  assert.equal(f.sessions.closes(), 1); assert.equal(f.evidence.closes(), 1);
  assert.equal(f.result.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1); assert.equal(f.startup.web.closes(), 1);
});

for (const resource of ["result", "evidence", "sessions"] as const) test(`machine HTTP refuses idle exchanges when the ${resource} pool becomes unavailable`, async t => {
  const f = await managedStartupFixture(); t.after(f.x.close);
  const raw = Buffer.from("synthetic pool health certificate");
  const nativeHttp = { origin: "https://machine.example.test", peers: [{ nodeId: f.x.registration.nodeId,
    certificateDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    task: { projectId: f.x.registration.projectId, jobId: f.x.registration.jobId,
      attemptId: f.x.registration.attemptId, inputDigest: f.x.registration.nativeTask!.inputDigest } }], isPeerCurrent: () => true };
  const runtime = await createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: f.openDatabase, install: () => {} })
    .start({ ...f.config, coordinator: { ...f.config.coordinator, nativeHttp } });
  t.after(runtime.close); assert.ok(runtime.nativeHttp);
  const socket = { encrypted: true, authorized: true, destroyed: false, getPeerCertificate: () => ({ raw }) } as unknown as TLSSocket;
  const request = (value: unknown) => { const body = JSON.stringify(value);
    return new Request(`${nativeHttp.origin}/v1/control-room/native`, { method: "POST", body,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }); };
  const opened = await runtime.nativeHttp.handle(request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" }), socket);
  assert.equal(opened.status, 200); const { connection } = await opened.json();
  f[resource].quarantine();
  assert.equal(runtime.nativeHttp.isReady(), false);
  assert.equal((await runtime.nativeHttp.handle(request({ schema: "control-room.native-http/v1", operation: "exchange", connection, packet: null }), socket)).status, 503);
  await runtime.close();
  for (const pool of [f.result, f.evidence, f.sessions, f.startup.web, f.startup.coordinator]) assert.equal(pool.closes(), 1);
});

// Shared fixture is also exercised by the actual-package full-host rehearsal.

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
  assert.deepEqual(Object.keys(runtime.connections).sort(), ["attach", "attachInput", "attachWire", "tenantId", "workspaceId"]);
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
  const nativeHttp = { origin: "https://machine.example.test", isPeerCurrent: () => true,
    peers: [{ nodeId: f.x.registration.nodeId, certificateDigest: `sha256:${"a".repeat(64)}`,
      task: { projectId: f.x.registration.projectId, jobId: f.x.registration.jobId,
        attemptId: f.x.registration.attemptId, inputDigest: f.x.registration.nativeTask!.inputDigest } }] };
  const variants: PrivateTaskStartupConfiguration[] = [
    { ...f.config, coordinator: { ...f.config.coordinator, nativeHttp, sessions: undefined } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      nativeHttp: { ...nativeHttp, peers: [{ ...nativeHttp.peers[0], nodeId: "node:unconfigured" }] } } },
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
