import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { createMacLocalStartupV1 } from "../src/web/v1/mac-local-startup";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";

const config = { schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local", localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local", provider: "local", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode: "long local test owner code" }), sessionSeconds: 900 }, database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web", password: "test", majorVersion: 17 }, enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:codex", kind: "codex", executablePath: "/bin/codex", recordedVersion: "codex test" }] } } as const;

test("verifies pinned workers before it opens the database and starts exactly once", async () => {
  const trace: string[] = [];
  const startup = createMacLocalStartupV1({ async readVersion() { trace.push("version"); return "codex test"; }, openDatabase() { trace.push("database"); return { client: {} as never, async close() { trace.push("database-close"); } }; }, createService() { trace.push("service"); return { async start() { trace.push("start"); }, async close() { trace.push("close"); } }; } });
  const running = await startup.start(config);
  assert.deepEqual(trace, ["version", "database", "service", "start"]); await running.close();
  await assert.rejects(startup.start(config));
});
test("does not open the database when worker verification fails", async () => {
  let opened = false;
  const startup = createMacLocalStartupV1({ async readVersion() { return "changed"; }, openDatabase() { opened = true; return {} as never; }, createService() { throw new Error("must_not_create"); } });
  await assert.rejects(startup.start(config)); assert.equal(opened, false);
});

test("one updated CLI leaves that worker unavailable while the others start", async () => {
  const two = { ...config, enablement: { ...config.enablement, workers: [...config.enablement.workers,
    { workerId: "worker:claude", kind: "claude-code", executablePath: "/bin/claude", recordedVersion: "claude test" }] } } as never;
  const startup = createMacLocalStartupV1({ async readVersion(path) { return path === "/bin/codex" ? "codex test" : "claude updated"; },
    openDatabase() { return { client: {} as never, async close() {} }; },
    createService() { return { async start() {}, async close() {} }; } });
  const running = await startup.start(two);
  assert.deepEqual(running.workerReadiness.read().map(worker => worker.state), ["ready", "unavailable"]);
  await running.close();
});

test("starts from the same digest-bearing configuration returned by the protected loader", async () => {
  const loaded = captureMacLocalProtectedConfigurationV1(config);
  const startup = createMacLocalStartupV1({ async readVersion() { return "codex test"; },
    openDatabase() { return { client: {} as never, async close() {} }; },
    createService() { return { async start() {}, async close() {} }; } });
  const running = await startup.start(loaded);
  assert.deepEqual(running.workerReadiness.read().map(worker => worker.state), ["ready"]);
  await running.close();
});
