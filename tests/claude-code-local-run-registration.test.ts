import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { ClaudeCodeLocalRunRegistrationV1 } from "../src/harness/claude-code-v1/local-run-registration";
import { Hermes021MacosLocalRunRegistrationV1 } from "../src/harness/hermes-021-v1/local-run-registration";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-021-v1/macos-local-worker";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../src/harness/claude-code-v1/task-planning-contract";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from "../src/harness/claude-code-v1/result-publication";
import { sha256Digest } from "../src/security";
import { at } from "./native-task-fixture";

function delivery() {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: "tenant:claude-local", projectId: "project:claude-local", jobId: "job:claude-local",
      attemptId: "attempt:claude-local", runId: "run:claude-local", nodeId: "node:claude-local" },
    worker: { workerId: "worker:claude-local", adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, adapterRevision: "source-123" },
    input: { prompt: "Review bounded supplied text.", instructions: "Return plain text only." },
    authorityDigest: sha256Digest("claude-local-authority"), connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acceptanceProfileId: "profile:claude-local", acceptanceProfileDigest: sha256Digest("claude-local-profile"),
    issuedAt: at(1_000), expiresAt: at(120_000),
  });
}

test("a Claude local delivery becomes one ordinary, non-native Control Room run record", () => {
  const packet = delivery();
  const run = ClaudeCodeLocalRunRegistrationV1(packet, at(2_000));
  assert.deepEqual({ id: run.id, tenantId: run.tenantId, projectId: run.projectId, jobId: run.jobId,
    attemptId: run.attemptId, nodeId: run.nodeId, adapterId: run.adapterId, harness: run.harness }, {
    id: packet.identity.runId, tenantId: packet.identity.tenantId, projectId: packet.identity.projectId,
    jobId: packet.identity.jobId, attemptId: packet.identity.attemptId, nodeId: packet.identity.nodeId,
    adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, harness: "claude",
  });
  assert.equal(run.connectorProfileDigest, packet.connectorProfileDigest);
  assert.equal(run.authorityDigest, packet.authorityDigest);
  assert.equal(run.state, "discovered");
  assert.equal(run.cancelState, "unsupported");
  assert.equal(run.nativeTask, undefined, "a local Claude delivery does not impersonate the Hermes-native protocol");
  assert.equal(run.nativeSessionKeyDigest, sha256Digest({ purpose: "claude-code-local-run-binding/v1", deliveryDigest: packet.deliveryDigest }));
});

test("a wrong adapter or expired Claude delivery cannot make a run record", () => {
  const packet = delivery();
  assert.throws(() => ClaudeCodeLocalRunRegistrationV1({ ...packet, worker: { ...packet.worker, adapterId: "connector:other" } }, at(2_000)));
  assert.throws(() => ClaudeCodeLocalRunRegistrationV1(packet, packet.expiresAt));
  const hermesPacket = createControllerWorkerDeliveryV1({
    identity: packet.identity, worker: { ...packet.worker, adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1 },
    input: packet.input, authorityDigest: packet.authorityDigest, connectorProfileDigest: packet.connectorProfileDigest,
    acceptanceProfileId: packet.acceptanceProfileId, acceptanceProfileDigest: packet.acceptanceProfileDigest,
    issuedAt: packet.issuedAt, expiresAt: packet.expiresAt,
  });
  assert.throws(() => Hermes021MacosLocalRunRegistrationV1(hermesPacket, hermesPacket.expiresAt),
    /hermes_021_macos_run_registration_unavailable/);
});
