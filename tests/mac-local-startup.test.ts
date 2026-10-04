import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { createMacLocalStartupV1 } from "../src/web/v1/mac-local-startup";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { captureOwnerTrustedLocalEnablementV1 } from "../src/harness/v1/owner-trusted-local-enablements";

const config = captureMacLocalProtectedConfigurationV1({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local", localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local", provider: "local", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode: "long local test owner code" }), sessionSeconds: 900 }, database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web", password: "test", majorVersion: 17 }, enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:codex", kind: "codex", executablePath: "/bin/codex", recordedVersion: "codex test" }] } });

test("verifies pinned workers before it opens the database and starts exactly once", async () => {
  const trace: string[] = [];
  const startup = createMacLocalStartupV1({ async readVersion() { trace.push("version"); return "codex test"; }, openDatabase() { trace.push("database"); return { client: {} as never, isAvailable: () => true, async close() { trace.push("database-close"); } }; }, createService() { trace.push("service"); return { async start() { trace.push("start"); }, isReady: () => true, async close() { trace.push("close"); } }; } });
  const running = await startup.start(config);
  assert.deepEqual(trace, ["version", "database", "service", "start"]); await running.close();
  await assert.rejects(startup.start(config));
});
test("does not open the database when worker verification fails", async () => {
  let opened = false;
  const startup = createMacLocalStartupV1({ async readVersion() { return "changed"; }, openDatabase() { opened = true; return {} as never; }, createService() { throw new Error("must_not_create"); } });
  await assert.rejects(startup.start(config)); assert.equal(opened, false);
});

test("refuses startup components that omit database or service readiness", async () => {
  let serviceCreated = false, databaseClosed = 0, serviceClosed = 0, serviceStarts = 0;
  const missingDatabaseReadiness = createMacLocalStartupV1({ async readVersion() { return "codex test"; },
    openDatabase() { return { client: {} as never, async close() { databaseClosed += 1; } } as never; },
    createService() { serviceCreated = true; return {} as never; } });
  await assert.rejects(missingDatabaseReadiness.start(config), /mac_local_startup_failed/);
  assert.equal(serviceCreated, false); assert.equal(databaseClosed, 1);

  const missingServiceReadiness = createMacLocalStartupV1({ async readVersion() { return "codex test"; },
    openDatabase() { return { client: {} as never, isAvailable: () => true, async close() { databaseClosed += 1; } }; },
    createService() { return { async start() { serviceStarts += 1; }, async close() { serviceClosed += 1; } } as never; } });
  await assert.rejects(missingServiceReadiness.start(config), /mac_local_startup_failed/);
  assert.equal(databaseClosed, 1); assert.equal(serviceClosed, 1); assert.equal(serviceStarts, 0);
});

test("one updated CLI leaves that worker unavailable while the others start", async () => {
  const enablement = captureOwnerTrustedLocalEnablementV1({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local",
    nodeId: "mac-1", workers: [...config.enablement.workers,
      { workerId: "worker:claude", kind: "claude-code", executablePath: "/bin/claude", recordedVersion: "claude test" }] });
  const two = captureMacLocalProtectedConfigurationV1({ ...config, enablement });
  const startup = createMacLocalStartupV1({ async readVersion(path) { return path === "/bin/codex" ? "codex test" : "claude updated"; },
    openDatabase() { return { client: {} as never, isAvailable: () => true, async close() {} }; },
    createService() { return { async start() {}, isReady: () => true, async close() {} }; } });
  const running = await startup.start(two);
  assert.deepEqual(running.workerReadiness.read().map(worker => worker.state), ["ready", "unavailable"]);
  await running.close();
});

test("starts from the same digest-bearing configuration returned by the protected loader", async () => {
  const loaded = captureMacLocalProtectedConfigurationV1(config);
  const startup = createMacLocalStartupV1({ async readVersion() { return "codex test"; },
    openDatabase() { return { client: {} as never, isAvailable: () => true, async close() {} }; },
    createService() { return { async start() {}, isReady: () => true, async close() {} }; } });
  const running = await startup.start(loaded);
  assert.deepEqual(running.workerReadiness.read().map(worker => worker.state), ["ready"]);
  await running.close();
});

test("connector-only startup opens the service without reading or spawning a bot executable", async () => {
  const trace: string[] = [];
  const startup = createMacLocalStartupV1({ connectorOnly: true,
    async readVersion() { assert.fail("connector-only startup must not inspect a bot CLI"); },
    openDatabase() { trace.push("database"); return { client: {} as never, isAvailable: () => true,
      async close() { trace.push("database-close"); } }; },
    createService(input) {
      trace.push("service");
      assert.equal(input.workerReadiness, undefined);
      return { async start() { trace.push("start"); }, isReady: () => true, async close() { trace.push("close"); } };
    },
  });
  const running = await startup.start(config);
  assert.deepEqual(trace, ["database", "service", "start"]);
  assert.equal("workerReadiness" in running, false);
  await running.close();
});
