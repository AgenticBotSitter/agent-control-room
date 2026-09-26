import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalWorkerReadinessV1 } from "../src/web/v1/mac-local-worker-readiness";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";

const enablement = { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local" as const, nodeId: "mac-1" as const,
  workers: [{ workerId: "worker:codex", kind: "codex" as const, executablePath: "/bin/codex", recordedVersion: "codex test" },
    { workerId: "worker:hermes", kind: "hermes-021" as const, executablePath: "/bin/hermes", recordedVersion: "hermes test" },
    { workerId: "worker:claude", kind: "claude-code" as const, executablePath: "/bin/claude", recordedVersion: "claude test" }] };
const verified = { nodeId: "mac-1" as const, enabledWorkerIds: ["worker:codex", "worker:hermes", "worker:claude"], unavailableWorkerIds: [] };

test("shows only startup-verified workers as ready and requires a saved-result observation for proven", () => {
  const readiness = createMacLocalWorkerReadinessV1(enablement, verified);
  assert.deepEqual(readiness.read(), [
    { kind: "codex", state: "ready", proof: "not_proven" },
    { kind: "hermes-021", state: "ready", proof: "not_proven" },
    { kind: "claude-code", state: "ready", proof: "not_proven" },
  ]);
  readiness.recordPublishedResult("worker:claude");
  assert.equal(readiness.read()[2]?.proof, "proven");
});

test("a failed worker cannot return to ready in the same host generation", () => {
  const readiness = createMacLocalWorkerReadinessV1(enablement, verified);
  readiness.recordReadinessFailure("worker:hermes");
  readiness.recordPublishedResult("worker:hermes");
  assert.equal(readiness.isReady("worker:hermes"), false);
  assert.deepEqual(readiness.read()[1], { kind: "hermes-021", state: "unavailable", proof: "not_proven" });
});

test("rejects a partial, duplicate, foreign, or wrong-node startup claim", () => {
  for (const invalid of [
    { nodeId: "mac-1" as const, enabledWorkerIds: ["worker:codex"], unavailableWorkerIds: [] },
    { nodeId: "mac-1" as const, enabledWorkerIds: ["worker:codex"] },
    { nodeId: "mac-1" as const, enabledWorkerIds: [], unavailableWorkerIds: ["worker:codex", "worker:hermes", "worker:claude"] },
    { nodeId: "mac-1" as const, enabledWorkerIds: ["worker:codex", "worker:claude"], unavailableWorkerIds: ["worker:codex"] },
    { nodeId: "mac-1" as const, enabledWorkerIds: ["worker:codex", "worker:codex", "worker:claude"], unavailableWorkerIds: [] },
    { nodeId: "mac-1" as const, enabledWorkerIds: ["worker:codex", "worker:hermes", "worker:other"], unavailableWorkerIds: [] },
    { nodeId: "node:other" as const, enabledWorkerIds: verified.enabledWorkerIds, unavailableWorkerIds: [] },
  ]) assert.throws(() => createMacLocalWorkerReadinessV1(enablement, invalid as never), /mac_local_worker_readiness_invalid/);
});

test("a worker that failed startup verification starts unavailable and cannot become proven", () => {
  const readiness = createMacLocalWorkerReadinessV1(enablement,
    { nodeId: "mac-1", enabledWorkerIds: ["worker:codex", "worker:hermes"], unavailableWorkerIds: ["worker:claude"] });
  assert.equal(readiness.isReady("worker:codex"), true);
  assert.equal(readiness.isReady("worker:claude"), false);
  readiness.recordPublishedResult("worker:claude");
  assert.deepEqual(readiness.read()[2], { kind: "claude-code", state: "unavailable", proof: "not_proven" });
});
