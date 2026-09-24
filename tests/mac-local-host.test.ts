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

const configuration = { schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
    provider: "local", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode: "long local test owner code" }), sessionSeconds: 900 },
  database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web", password: "test", majorVersion: 17 },
  enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:codex", kind: "codex", executablePath: "/bin/codex", recordedVersion: "codex test" }] } } as const;

const databaseRoles = Object.freeze({
  schema: MAC_LOCAL_DATABASE_ROLES_V1,
  web: configuration.database,
  coordinator: { ...configuration.database, username: "control_room_coordinator", password: "coordinator-test" },
  results: { ...configuration.database, username: "control_room_results", password: "results-test" },
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
    openDatabase() { trace.push("database"); return { client: {} as never, async close() { trace.push("database-close"); } }; },
    assets: { async respond() { return undefined; } },
    render() { return new Response("local"); },
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
    openDatabase() { opened = true; return {} as never; }, assets: { async respond() { return undefined; } },
    render() { return new Response("local"); },
  });
  await assert.rejects(host.start());
  assert.equal(opened, false);
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
    openDatabase() { trace.push("web-database"); return { client: {} as never, async close() { trace.push("web-close"); } }; },
    async loadDatabaseRoles() { trace.push("database-roles"); return databaseRoles; },
    async createTaskApplication({ configuration: received, workerReadiness, databaseRoles: receivedRoles }) {
      trace.push("task-application");
      assert.equal(received, configuration);
      assert.equal(receivedRoles, databaseRoles);
      assert.deepEqual(workerReadiness.read(), [{ kind: "codex", state: "ready", proof: "not_proven" }]);
      return { operations: {}, isReady: () => true, async close() { trace.push("task-close"); } };
    },
    assets: { async respond() { return undefined; } }, render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
  });
  const running = await host.start();
  assert.deepEqual(trace, ["load", "database-roles", "version", "web-database", "task-application"]);
  await running.close();
  assert.deepEqual(trace, ["load", "database-roles", "version", "web-database", "task-application", "web-close", "task-close"]);
});

test("a protected Mac host refuses mismatched web role configuration before opening a database", async () => {
  let opened = false;
  const host = createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; },
    async loadDatabaseRoles() { return { ...databaseRoles, web: { ...databaseRoles.web, username: "wrong_web" } }; },
    async readVersion() { return "codex test"; },
    openDatabase() { opened = true; return {} as never; },
    assets: { async respond() { return undefined; } }, render() { return new Response("local"); },
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
    database: { client: {} as never, async close() { databaseCloses++; } },
    assets: { async respond() { return undefined; } },
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

test("a Mac-local host refuses operations from a different controller lifecycle", () => {
  assert.throws(() => createMacLocalWebServiceFromConfigurationV1({
    configuration, database: { client: {} as never, async close() {} },
    assets: { async respond() { return undefined; } }, render() { return new Response("local"); },
    operations: {}, taskApplication: { operations: {}, isReady: () => true, async close() {} },
  }), /mac_local_host_configuration_invalid/);
});

test("a protected Mac host refuses bare operations mixed with a task-application factory", () => {
  assert.throws(() => createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; }, async readVersion() { return "codex test"; },
    openDatabase() { return {} as never; }, assets: { async respond() { return undefined; } }, render() { return new Response("local"); },
    operations: {}, createTaskApplication: async () => ({ operations: {}, isReady: () => true, async close() {} }),
  }), /mac_local_host_configuration_invalid/);
});

test("starts the existing queue worker only after the loopback site is listening and closes both together", async () => {
  const trace: string[] = [];
  const server = new EventEmitter() as Server;
  server.listen = ((_options: object, callback: () => void) => { trace.push("site-start"); queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = ((callback?: (error?: Error) => void) => { trace.push("site-close"); queueMicrotask(() => callback?.()); return server; }) as Server["close"];
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const host = createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; }, async readVersion() { return "codex test"; },
    openDatabase() { return { client: {} as never, async close() { trace.push("database-close"); } }; },
    async loadDatabaseRoles() { return databaseRoles; },
    async createTaskApplication() { return { operations: {}, isReady: () => true, async close() { trace.push("task-close"); },
      async queueDelivery() {}, queueRecovery: { async verify() {} } }; },
    async startQueueWorker(value) {
      trace.push("queue-start");
      assert.equal(value.database.username, "control_room_queue_worker");
      assert.equal(value.application.loginNames.includes("control_room_web"), true);
      return { status: () => ({ accepting: true }), async close() { trace.push("queue-close"); } };
    },
    assets: { async respond() { return undefined; } }, render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
  });
  const running = await host.start();
  assert.deepEqual(trace.slice(0, 2), ["site-start", "queue-start"]);
  await running.close();
  assert.deepEqual(trace.slice(-4), ["queue-close", "site-close", "database-close", "task-close"]);
});

test("refuses a queue-worker factory without the task lifecycle it delivers", () => {
  assert.throws(() => createMacLocalProtectedHostV1({
    async loadConfiguration() { return configuration; }, async readVersion() { return "codex test"; },
    openDatabase() { return {} as never; }, assets: { async respond() { return undefined; } }, render() { return new Response("local"); },
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
    openDatabase() { return { client: {} as never, async close() {} }; },
    async loadDatabaseRoles() { return databaseRoles; },
    async createTaskApplication() { return { operations: {}, isReady: () => true, async close() {}, async queueDelivery() {} }; },
    async startQueueWorker() { return { status: () => ({ accepting: false }), async close() { trace.push("worker-close"); } }; },
    assets: { async respond() { return undefined; } }, render() { return new Response("local"); },
    createServer: () => server, listenerTiming: { bindMs: 100, closeMs: 100 },
  });
  await assert.rejects(host.start(), /mac_local_startup_failed/);
  assert.deepEqual(trace, ["worker-close", "site-close"]);
});
