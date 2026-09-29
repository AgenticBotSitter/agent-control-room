import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1, captureMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { createMacLocalWorkBatchQueueCatalogV1 } from "../src/web/v1/mac-local-host";
import { createWorkBatchQueueSelectionAuthorityV1 } from "../src/work-intake/v1";

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

test("derives exact active queue workers, nodes and protected model policies", () => {
  const configuration = captureMacLocalProtectedConfigurationV1({ ...value, enablement: {
    ...value.enablement, workers: [
      { ...value.enablement.workers[0], modelPolicy: { models: ["gpt-6-sol"], defaultModel: "gpt-6-sol",
        efforts: ["high"], defaultEffort: "high" } },
      { workerId: "worker:claude", kind: "claude-code", executablePath: "/private/tmp/claude",
        recordedVersion: "claude test", modelPolicy: { models: ["opus"], defaultModel: "opus",
          efforts: ["high"], defaultEffort: "high" } },
      { workerId: "worker:hermes-old", kind: "hermes-021", executablePath: "/private/tmp/hermes-old",
        recordedVersion: "historical", modelPolicy: { profiles: [{ name: "old", provider: "old", model: "old" }],
          defaultProfile: "old", efforts: ["default"], defaultEffort: "default" } },
    ] } });
  assert.deepEqual(createMacLocalWorkBatchQueueCatalogV1(configuration), [
    { workerId: "worker:codex", workerKind: "codex", nodeId: "mac-1.codex",
      modelPolicy: { models: ["gpt-6-sol"], defaultModel: "gpt-6-sol", efforts: ["high"], defaultEffort: "high" } },
    { workerId: "worker:claude", workerKind: "claude-code", nodeId: "mac-1.claude",
      modelPolicy: { models: ["opus"], defaultModel: "opus", efforts: ["high"], defaultEffort: "high" } },
  ]);
});

test("protected batch selection refuses unavailable workers and policy drift", () => {
  const configuration = captureMacLocalProtectedConfigurationV1({ ...value, enablement: {
    ...value.enablement, workers: [{ ...value.enablement.workers[0], modelPolicy: {
      models: ["gpt-6-sol"], defaultModel: "gpt-6-sol", efforts: ["medium", "high"], defaultEffort: "medium" } }] } });
  const catalog = createMacLocalWorkBatchQueueCatalogV1(configuration);
  let ready = true;
  const authority = createWorkBatchQueueSelectionAuthorityV1(catalog, { isReady: () => ready });
  const exact = { workerId: "worker:codex", workerKind: "codex" as const, nodeId: "mac-1.codex",
    selectionKey: "gpt-6-sol", model: "gpt-6-sol", effort: "high", provider: null, profile: null };
  assert.equal(authority.assertCurrent(exact), true);
  ready = false;
  assert.equal(authority.assertCurrent(exact), false, "current host readiness is mandatory");
  ready = true;
  assert.equal(authority.assertCurrent({ ...exact, effort: "low" }), false);
  assert.equal(authority.assertCurrent({ ...exact, nodeId: "mac-1.other" }), false);
  assert.equal(authority.assertCurrent({ ...exact, model: "drifted" }), false);
});
