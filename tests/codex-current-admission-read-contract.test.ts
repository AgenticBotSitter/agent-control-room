import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { matchCodexCurrentAdmissionReadResponseV1 } from "../src/harness/codex-v1/current-admission-read-contract";
import { NODE_PROTOCOL_V1, signNodeFrame, signedNodeFrameSchema } from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security";

const now = Date.parse("2026-09-23T20:00:00.000Z");
const digest = (value: string) => sha256Digest(value);
const request = {
  messageId: "message:read", bodyDigest: digest("request"), queueId: "queue:test", projectId: "project:test",
  jobId: "job:test", attemptId: "attempt:test", nodeId: "node:test", challengeNonce: "a".repeat(43),
  activationFrameDigest: digest("activation"), currentAdmissionDigest: digest("admission"),
};

function response(changes: Record<string, unknown> = {}) {
  return { schema: "control-room.codex-current-admission-read-response/v1" as const,
    queueId: request.queueId, projectId: request.projectId, jobId: request.jobId, attemptId: request.attemptId,
    nodeId: request.nodeId, requestMessageId: request.messageId, requestBodyDigest: request.bodyDigest,
    challengeNonce: request.challengeNonce, activationFrameDigest: request.activationFrameDigest,
    currentAdmissionDigest: request.currentAdmissionDigest, ownerTrustRevisionDigest: digest("owner-trust"),
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 20_000).toISOString(),
    startsWork: false as const, grantsExecutionAuthority: false as const, ...changes };
}
const expected = () => ({ requestMessageId: request.messageId, requestBodyDigest: request.bodyDigest,
  queueId: request.queueId, projectId: request.projectId, jobId: request.jobId, attemptId: request.attemptId,
  nodeId: request.nodeId, challengeNonce: request.challengeNonce, activationFrameDigest: request.activationFrameDigest,
  currentAdmissionDigest: request.currentAdmissionDigest, now, maximumExpiresAt: now + 30_000 });

test("Codex current-admission read accepts only exact signed, bounded read evidence", () => {
  const server = generateKeyPairSync("ed25519"), body = response();
  assert.deepEqual(matchCodexCurrentAdmissionReadResponseV1(body, expected()), body);
  const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
    tenantId: "tenant:test", actorId: "server:test", keyId: "server-key:test", connectionId: "connection:test",
    sequence: 1, messageId: "message:response", correlationId: "correlation:read", causationId: request.messageId,
    sentAt: body.checkedAt, expiresAt: body.expiresAt, nonce: "b".repeat(43),
    type: "harness.codex.current-admission.read.response", body }, server.privateKey);
  const parsed = signedNodeFrameSchema.parse(frame);
  assert.equal(parsed.type, "harness.codex.current-admission.read.response");
  assert.deepEqual(parsed.body, body);
  assert.equal(parsed.body.startsWork, false);
  assert.equal(parsed.body.grantsExecutionAuthority, false);
});

test("Codex current-admission read rejects replay substitution, stale owner state, and expiry", () => {
  for (const changed of [
    { challengeNonce: "c".repeat(43) }, { nodeId: "node:other" },
    { activationFrameDigest: digest("other-activation") }, { currentAdmissionDigest: digest("changed-canonical") },
    { expiresAt: new Date(now + 30_001).toISOString() }, { expiresAt: new Date(now).toISOString() },
  ]) {
    assert.throws(() => matchCodexCurrentAdmissionReadResponseV1(response(changed), expected()));
  }
});

test("read response cannot become a start authority through its wire shape", () => {
  for (const changed of [
    { startsWork: true }, { grantsExecutionAuthority: true },
    { requestBodyDigest: digest("wrong-request") }, { requestMessageId: "message:other" },
  ]) {
    assert.throws(() => matchCodexCurrentAdmissionReadResponseV1(response(changed), expected()));
  }
});
