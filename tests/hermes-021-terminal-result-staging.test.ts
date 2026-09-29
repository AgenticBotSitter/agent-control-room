import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { createHermes021MacosTerminalStageV1 } from "../src/harness/hermes-021-v1";
import { InMemoryArtifactStorage } from "../src/node-executor/artifact-storage";
import { sha256Digest } from "../src/security";

const at = "2026-01-01T00:00:02.000Z";
const terminal = { type: "result", session_id: "session:stage", exit_code: 0, text: "saved result",
  tokens: { input: 1, output: 2, total: 3, cache_read: 0, cache_write: 0 }, duration_ms: 4, timestamp: 5 };

function delivery(jobId: string) {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: "tenant:stage", projectId: "project:stage", jobId, attemptId: `attempt:${jobId.slice(4)}`,
      runId: `run:${jobId.slice(4)}`, nodeId: "node:stage" },
    worker: { workerId: "worker:stage", adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "00570550" },
    input: { prompt: "Return a bounded result", instructions: "No tools" }, authorityDigest: sha256Digest(`authority:${jobId}`),
    connectorProfileDigest: sha256Digest("profile:stage"), acceptanceProfileId: "profile:stage",
    acceptanceProfileDigest: sha256Digest("acceptance:stage"), issuedAt: "2026-01-01T00:00:01.000Z", expiresAt: "2026-01-01T00:01:00.000Z",
  });
}

test("a staged terminal result is readable only through its exact delivery identity", async () => {
  const storage = new InMemoryArtifactStorage();
  const first = createHermes021MacosTerminalStageV1({ storage, delivery: delivery("job:first"), receivedAt: at });
  await first.capture(terminal);
  assert.deepEqual(await first.recover(), terminal);
  const other = createHermes021MacosTerminalStageV1({ storage, delivery: delivery("job:other"), receivedAt: at });
  assert.equal(await other.recover(), undefined);
});

test("a staged terminal result is create-once and refuses conflicting later bytes", async () => {
  const storage = new InMemoryArtifactStorage();
  const stage = createHermes021MacosTerminalStageV1({ storage, delivery: delivery("job:first"), receivedAt: at });
  await stage.capture(terminal);
  await assert.rejects(stage.capture({ ...terminal, text: "different result" }));
  assert.deepEqual(await stage.recover(), terminal);
});
