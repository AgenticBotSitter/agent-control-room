import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { createMacLocalProtectedHostV1, createMacLocalWebServiceFromConfigurationV1 } from "../src/web/v1/mac-local-host";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../src/web/v1/mac-local-protected-configuration";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { captureMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";

const configuration = captureMacLocalProtectedConfigurationV1({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
    provider: "local", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode: "long local test owner code" }), sessionSeconds: 900 },
  database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web", password: "test", majorVersion: 17 },
  enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:codex", kind: "codex", executablePath: "/bin/codex", recordedVersion: "codex test" }] } });

const databaseRoles = Object.freeze({
  schema: MAC_LOCAL_DATABASE_ROLES_V1,
  web: configuration.database,
  coordinator: { ...configuration.database, username: "control_room_coordinator", password: "coordinator-test" },
  results: { ...configuration.database, username: "control_room_results", password: "results-test" },
  publisher: { ...configuration.database, username: "control_room_publisher", password: "publisher-test" },
  agentReviewer: { ...configuration.database, username: "control_room_agent_reviewer_login", password: "reviewer-test" },
  queueWorker: { ...configuration.database, username: "control_room_queue_worker", password: "queue-worker-test" },
});

test("loads then verifies workers before it opens the authority database", async () => {
  const trace: string[] = [];
  const server = new EventEmitter() as Server;
  server.listen = ((_options: object, callback: () => void) => { queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = ((callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; }) as Server["close"];
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const host = createMacLocalProtectedHostV1({
    async loadConfiguration() { trace.push("load"); return configuration; },
    async readVersion() { trace.push("version"); return "codex test"; },
    openDatabase() { trace.push("database"); return { client: {} as never, isAvailable: () => true,
      async close() { trace.push("database-close"); } }; },
    assets: { count: 0, digest: "test", respond() { return undefined; } },
    render() { return new Response("local"); },
    // A pid, a probe key, a release and a start time travel together: the web
    // process refuses a pid with no key behind it rather than serving a readiness
    // route that `mac:up` could not verify. Before the host forwarded the pid
    // this test passed with the pid alone, which meant the combination was never
    // exercised at all.
    hostProcessId: 4_243, healthProbeKey: new Uint8Array(32).fill(11),
    healthReleaseId: "test-release", healthStartedAt: "2026-09-30T00:00:00.000Z",
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
  });
  // Construction itself has no filesystem, database, listener, or worker effect.
  assert.deepEqual(trace, []);
  const running = await host.start();
  assert.deepEqual(trace, ["load", "version", "database"]);
  await running.close();
});

test("does not open the database when the pinned worker changes", async () => {
  let opened = false;
  const host = createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; }, async readVersion() { return "changed"; },
    openDatabase() { opened = true; return {} as never; }, assets: { count: 0, digest: "test", respond() { return undefined; } },
    render() { return new Response("local"); },
  });
  await assert.rejects(host.start());
  assert.equal(opened, false);
});

test("connector-only host refuses direct task factories and starts without bot executable inspection", async () => {
  assert.throws(() => createMacLocalProtectedHostV1({ connectorOnly: true,
    async loadConfiguration() { return configuration; },
    openDatabase() { return {} as never; },
    async loadDatabaseRoles() { return {} as never; },
    createTaskApplication: async () => ({ operations: {}, isReady: () => true, async close() {} }),
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
  }), /mac_local_host_configuration_invalid/);

  const trace: string[] = [];
  const server = new EventEmitter() as Server;
  server.listen = ((_options: object, callback: () => void) => { queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = ((callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; }) as Server["close"];
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const host = createMacLocalProtectedHostV1({ connectorOnly: true,
    async loadConfiguration() { trace.push("load"); return configuration; },
    async readVersion() { assert.fail("connector-only host must not inspect a bot CLI"); },
    openDatabase() { trace.push("database"); return { client: {} as never, isAvailable: () => true,
      async close() { trace.push("close"); } }; },
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
  });
  const running = await host.start();
  assert.deepEqual(trace, ["load", "database"]);
  await running.close();
});

test("protected Mac startup creates the shared task lifecycle only after worker verification and owns its shutdown", async () => {
  const trace: string[] = [];
  const server = new EventEmitter() as Server;
  server.listen = ((_options: object, callback: () => void) => { queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = ((callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; }) as Server["close"];
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const host = createMacLocalProtectedHostV1({
    async loadConfiguration() { trace.push("load"); return configuration; },
    async readVersion() { trace.push("version"); return "codex test"; },
    openDatabase() { trace.push("web-database"); return { client: {} as never, isAvailable: () => true,
      async close() { trace.push("web-close"); } }; },
    async loadDatabaseRoles() { trace.push("database-roles"); return databaseRoles; },
    async createTaskApplication({ configuration: received, workerReadiness, databaseRoles: receivedRoles }) {
      trace.push("task-application");
      assert.equal(received, configuration);
      assert.equal(receivedRoles, databaseRoles);
      assert.deepEqual(workerReadiness.read(), [{ kind: "codex", state: "ready", proof: "not_proven" }]);
      return { operations: {}, isReady: () => true, async close() { trace.push("task-close"); } };
    },
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
  });
  const running = await host.start();
  assert.deepEqual(trace, ["load", "database-roles", "version", "web-database", "task-application"]);
  await running.close();
  assert.deepEqual(trace, ["load", "database-roles", "version", "web-database", "task-application", "task-close", "web-close"]);
});

test("protected host captures one batch key, catalog and exact-selection authority for the task application", async () => {
  const key = new Uint8Array(32).fill(19);
  let closed = false;
  const host = createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; }, async readVersion() { return "codex test"; },
    async loadDatabaseRoles() { return databaseRoles; },
    openDatabase() { return { client: {} as never, isAvailable: () => true, async close() { closed = true; } }; },
    workBatchIntegrityKey: key,
    async createTaskApplication({ workBatches }) {
      assert.ok(workBatches);
      assert.notEqual(workBatches.integrityKey, key, "host owns a copy of the installation key");
      assert.deepEqual([...workBatches.integrityKey], [...key]);
      assert.equal(workBatches.queueCatalog[0]?.workerId, "worker:codex");
      assert.equal(workBatches.selectionAuthority.assertCurrent({ workerId: "worker:codex", workerKind: "codex",
        nodeId: "mac-1.codex", selectionKey: "gpt-6-sol", model: "gpt-6-sol", effort: "high",
        provider: null, profile: null }), false, "workers without protected model policy are not admissible");
      throw new Error("capture_complete");
    },
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
  });
  await assert.rejects(host.start(), /mac_local_startup_failed/);
  assert.equal(closed, true);
});

test("a protected Mac host refuses mismatched web role configuration before opening a database", async () => {
  let opened = false;
  const host = createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; },
    async loadDatabaseRoles() { return { ...databaseRoles, web: { ...databaseRoles.web, username: "wrong_web" } }; },
    async readVersion() { return "codex test"; },
    openDatabase() { opened = true; return {} as never; },
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
  });
  await assert.rejects(host.start(), /mac_local_host_configuration_invalid/);
  assert.equal(opened, false);
});

test("a Mac-local host owns the shared task composition and fails ready when that composition is unavailable", async () => {
  let databaseCloses = 0, taskCloses = 0, available = true;
  const server = new EventEmitter() as Server;
  server.listen = ((_options: object, callback: () => void) => { queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = ((callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; }) as Server["close"];
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const service = createMacLocalWebServiceFromConfigurationV1({
    configuration,
    database: { client: {} as never, isAvailable: () => true, async close() { databaseCloses++; } },
    assets: { count: 0, digest: "test", respond() { return undefined; } },
    render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
    taskApplication: {
      operations: {}, isReady: () => available,
      async close() { taskCloses++; },
    },
  });
  await service.start();
  assert.equal(service.isReady(), true);
  available = false;
  assert.equal(service.isReady(), false, "the site never presents itself as ready after its controller is unavailable");
  await service.close();
  assert.equal(databaseCloses, 1);
  assert.equal(taskCloses, 1);
});

test("a failed task drain still closes the site database and remains failed on retry", async () => {
  const trace: string[] = [];
  let releaseTaskClose!: () => void, taskCloseStarted = false;
  const taskCloseMayFinish = new Promise<void>(resolve => { releaseTaskClose = resolve; });
  const server = new EventEmitter() as Server;
  server.listen = ((_options: object, callback: () => void) => { queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = ((callback?: (error?: Error) => void) => { trace.push("site-close"); queueMicrotask(() => callback?.()); return server; }) as Server["close"];
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const service = createMacLocalWebServiceFromConfigurationV1({
    configuration,
    database: { client: {} as never, isAvailable: () => true, async close() { trace.push("database-close"); } },
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
    taskApplication: { operations: {}, isReady: () => true, async close() {
      taskCloseStarted = true; trace.push("task-close-start");
      await taskCloseMayFinish;
      trace.push("task-close"); throw new Error("injected_task_drain_failure");
    } },
  });
  await service.start();
  const closing = service.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(taskCloseStarted, true);
  assert.deepEqual(trace, ["task-close-start"], "the site close cannot race a blocked task drain");
  releaseTaskClose();
  await assert.rejects(closing, /mac_local_host_cleanup_uncertain/);
  await assert.rejects(service.close(), /mac_local_host_cleanup_uncertain/);
  assert.deepEqual(trace, ["task-close-start", "task-close", "site-close", "database-close"]);
});

test("a Mac-local host refuses operations from a different controller lifecycle", () => {
  assert.throws(() => createMacLocalWebServiceFromConfigurationV1({ configuration,
    database: { client: {} as never, async close() {} } as never,
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); } }),
  /mac_local_host_configuration_invalid/);
  assert.throws(() => createMacLocalWebServiceFromConfigurationV1({
    configuration, database: { client: {} as never, isAvailable: () => true, async close() {} },
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
    operations: {}, taskApplication: { operations: {}, isReady: () => true, async close() {} },
  }), /mac_local_host_configuration_invalid/);
});

test("a protected Mac host refuses bare operations mixed with a task-application factory", () => {
  assert.throws(() => createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; }, async readVersion() { return "codex test"; },
    openDatabase() { return {} as never; }, assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
    operations: {}, createTaskApplication: async () => ({ operations: {}, isReady: () => true, async close() {} }),
  }), /mac_local_host_configuration_invalid/);
});

test("starts the existing queue worker only after the loopback site is listening and drains writers before databases", async () => {
  const trace: string[] = [];
  const server = new EventEmitter() as Server;
  server.listen = ((_options: object, callback: () => void) => { trace.push("site-start"); queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = ((callback?: (error?: Error) => void) => { trace.push("site-close"); queueMicrotask(() => callback?.()); return server; }) as Server["close"];
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const host = createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; }, async readVersion() { return "codex test"; },
    openDatabase() { return { client: {} as never, isAvailable: () => true,
      async close() { trace.push("database-close"); } }; },
    async loadDatabaseRoles() { return databaseRoles; },
    async createTaskApplication() { return { operations: {}, isReady: () => true, async close() { trace.push("task-close"); },
      async queueDelivery() { return { disposition: "delivered" as const }; } }; },
    async startQueueWorker(value) {
      trace.push("queue-start");
      assert.equal(value.database.username, "control_room_queue_worker");
      assert.equal(value.application.loginNames.includes("control_room_web"), true);
      assert.equal(value.application.loginNames.includes("control_room_agent_reviewer_login"), true);
      return { status: () => ({ accepting: true }), async close() { trace.push("queue-close"); } };
    },
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
  });
  const running = await host.start();
  assert.deepEqual(trace.slice(0, 2), ["site-start", "queue-start"]);
  await running.close();
  assert.deepEqual(trace.slice(-4), ["queue-close", "task-close", "site-close", "database-close"]);
});

test("a readiness quarantine drains a mid-write task before either owned database closes", async () => {
  const trace: string[] = [];
  let databaseAvailable = true, databaseClosed = false, releaseWrite!: () => void;
  const writeMayFinish = new Promise<void>(resolve => { releaseWrite = resolve; });
  const results: string[] = [];
  const activeWrite = (async () => {
    trace.push("write-start");
    await writeMayFinish;
    assert.equal(databaseClosed, false, "an in-flight result must never write after the host database closes");
    results.push("saved"); trace.push("write-recorded");
  })();
  const server = new EventEmitter() as Server;
  server.listen = ((_options: object, callback: () => void) => { trace.push("site-start"); queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = ((callback?: (error?: Error) => void) => { trace.push("site-close"); queueMicrotask(() => callback?.()); return server; }) as Server["close"];
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const service = createMacLocalWebServiceFromConfigurationV1({
    configuration,
    database: { client: {} as never, isAvailable: () => databaseAvailable,
      async close() { databaseClosed = true; trace.push("web-database-close"); } },
    taskApplication: { operations: {}, isReady: () => true, async close() {
      trace.push("task-drain-start");
      await activeWrite;
      assert.deepEqual(results, ["saved"], "the task drain must retain the completed result");
      trace.push("task-close");
    } },
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
  });
  await service.start();
  databaseAvailable = false;
  assert.equal(service.isReady(), false, "database quarantine must make the host unavailable before restart");
  const closes = Array.from({ length: 32 }, () => service.close());
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(databaseClosed, false, "shutdown must keep the database open while the result write is blocked");
  assert.equal(trace.includes("task-close"), false, "task resources must remain open until the active write finishes");
  releaseWrite();
  await Promise.all(closes);
  assert.deepEqual(results, ["saved"]);
  assert.deepEqual(trace, ["write-start", "site-start", "task-drain-start", "write-recorded", "task-close", "site-close", "web-database-close"]);
});

test("refuses a queue-worker factory without the task lifecycle it delivers", () => {
  assert.throws(() => createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; }, async readVersion() { return "codex test"; },
    openDatabase() { return {} as never; }, assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
    async startQueueWorker() { return { status: () => ({ accepting: true }), async close() {} }; },
  }), /mac_local_host_configuration_invalid/);
});

test("closes a rejected queue worker before it closes the local site", async () => {
  const trace: string[] = [];
  const server = new EventEmitter() as Server;
  server.listen = ((_options: object, callback: () => void) => { queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = ((callback?: (error?: Error) => void) => { trace.push("site-close"); queueMicrotask(() => callback?.()); return server; }) as Server["close"];
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const host = createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; }, async readVersion() { return "codex test"; },
    openDatabase() { return { client: {} as never, isAvailable: () => true, async close() {} }; },
    async loadDatabaseRoles() { return databaseRoles; },
    async createTaskApplication() { return { operations: {}, isReady: () => true, async close() {}, async queueDelivery() { return { disposition: "delivered" as const }; } }; },
    async startQueueWorker() { return { status: () => ({ accepting: false }), async close() { trace.push("worker-close"); } }; },
    assets: { count: 0, digest: "test", respond() { return undefined; } }, render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
  });
  await assert.rejects(host.start(), /mac_local_startup_failed/);
  assert.deepEqual(trace, ["worker-close", "site-close"]);
});
