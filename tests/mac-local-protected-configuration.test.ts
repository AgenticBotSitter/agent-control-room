import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1, captureMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";

const value = Object.freeze({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
    provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode: "a long owner code for test only" }), sessionSeconds: 900 },
  database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web", password: "test-password", majorVersion: 17 },
  enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:codex", kind: "codex", executablePath: "/Applications/Codex.app/Contents/MacOS/codex", recordedVersion: "codex test" }] } });

test("captures one inert exact Mac-local configuration", () => {
  const captured = captureMacLocalProtectedConfigurationV1(value);
  assert.equal(captured.port, 3210); assert.equal(captured.database.password, "test-password");
  assert.equal(captured.enablement.workers[0]?.workerId, "worker:codex");
});

test("refuses a foreign origin, unpinned worker, wrong port, and unknown fields", () => {
  for (const changed of [
    { ...value, port: 3211 },
    { ...value, localOwnerSession: { ...value.localOwnerSession, origin: "http://localhost:3210" } },
    { ...value, enablement: { ...value.enablement, nodeId: "node:other" } },
    { ...value, extra: true },
  ]) assert.throws(() => captureMacLocalProtectedConfigurationV1(changed));
});
