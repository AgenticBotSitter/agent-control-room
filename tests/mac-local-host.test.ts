import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { createMacLocalProtectedHostV1 } from "../src/web/v1/mac-local-host";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../src/web/v1/mac-local-protected-configuration";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";

const configuration = { schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
    provider: "local", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode: "long local test owner code" }), sessionSeconds: 900 },
  database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web", password: "test", majorVersion: 17 },
  enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:codex", kind: "codex", executablePath: "/bin/codex", recordedVersion: "codex test" }] } } as const;

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
