import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { codexOwnerTrustedLocalRunRegistrationV1 } from "../src/harness/codex-v1/owner-trusted-local-run-registration";
import { hermesLocalRunRegistrationV1 } from "../src/harness/hermes-local-v1/local-run-registration";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { HERMES_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-local-v1/task-planning-contract";
import { sha256Digest } from "../src/security";
import { at } from "./native-task-fixture";

function delivery(adapterId: string) {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: "tenant:mac-1", projectId: "project:mac-1", jobId: "job:mac-1",
      attemptId: "attempt:mac-1", runId: "run:mac-1", nodeId: "mac-1" },
    worker: { workerId: "worker:mac-1", adapterId, adapterRevision: "source-123" },
    input: { prompt: "Reply with exactly the single word: ok", instructions: "Return plain text only." },
    authorityDigest: sha256Digest("mac-local-authority"), connectorProfileDigest: sha256Digest("mac-local-profile"),
    acceptanceProfileId: "profile:mac-local", acceptanceProfileDigest: sha256Digest("mac-local-acceptance"),
    issuedAt: at(1_000), expiresAt: at(120_000),
  });
}

test("an owner-trusted local Codex delivery becomes one ordinary run record carrying its live pinned version", () => {
  const packet = delivery(CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1);
  const run = codexOwnerTrustedLocalRunRegistrationV1(packet, at(2_000), "codex-cli-0.99.1");
  assert.deepEqual({ id: run.id, tenantId: run.tenantId, projectId: run.projectId, jobId: run.jobId,
    attemptId: run.attemptId, nodeId: run.nodeId, adapterId: run.adapterId, harness: run.harness, harnessVersion: run.harnessVersion }, {
    id: packet.identity.runId, tenantId: packet.identity.tenantId, projectId: packet.identity.projectId,
    jobId: packet.identity.jobId, attemptId: packet.identity.attemptId, nodeId: packet.identity.nodeId,
    adapterId: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, harness: "codex", harnessVersion: "codex-cli-0.99.1",
  });
  assert.equal(run.connectorProfileDigest, packet.connectorProfileDigest);
  assert.equal(run.authorityDigest, packet.authorityDigest);
  assert.equal(run.state, "discovered");
  assert.equal(run.cancelState, "unsupported");
  assert.equal(run.nativeSessionKeyDigest, sha256Digest({ purpose: "codex-owner-trusted-local-run-binding/v1", deliveryDigest: packet.deliveryDigest }));
});

test("a wrong adapter, expired delivery, or missing version cannot make a Codex owner-trusted local run record", () => {
  const packet = delivery(CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1);
  assert.throws(() => codexOwnerTrustedLocalRunRegistrationV1({ ...packet, worker: { ...packet.worker, adapterId: HERMES_LOCAL_ADAPTER_V1 } },
    at(2_000), "codex-cli-0.99.1"));
  assert.throws(() => codexOwnerTrustedLocalRunRegistrationV1(packet, packet.expiresAt, "codex-cli-0.99.1"));
  assert.throws(() => codexOwnerTrustedLocalRunRegistrationV1(packet, at(2_000), ""));
});

test("an owner-trusted local Hermes delivery becomes one ordinary run record carrying its live pinned version", () => {
  const packet = delivery(HERMES_LOCAL_ADAPTER_V1);
  const run = hermesLocalRunRegistrationV1(packet, at(2_000), "hermes-agent-2.3.0");
  assert.deepEqual({ id: run.id, adapterId: run.adapterId, harness: run.harness, harnessVersion: run.harnessVersion }, {
    id: packet.identity.runId, adapterId: HERMES_LOCAL_ADAPTER_V1, harness: "hermes", harnessVersion: "hermes-agent-2.3.0",
  });
  assert.equal(run.nativeSessionKeyDigest, sha256Digest({ purpose: "hermes-local-run-binding/v1", deliveryDigest: packet.deliveryDigest }));
});

test("a wrong adapter or expired delivery cannot make a Hermes local run record", () => {
  const packet = delivery(HERMES_LOCAL_ADAPTER_V1);
  assert.throws(() => hermesLocalRunRegistrationV1({ ...packet, worker: { ...packet.worker, adapterId: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } },
    at(2_000), "hermes-agent-2.3.0"));
  assert.throws(() => hermesLocalRunRegistrationV1(packet, packet.expiresAt, "hermes-agent-2.3.0"));
});
