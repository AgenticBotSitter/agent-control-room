import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hermesGptConnectorProfileV1 } from "../src/harness/hermes-gpt-v1";
import { projectNativeObservationTextResultV1 } from "../src/harness/v1/native-canonical-result";

const text = "native result";
const hash = `sha256:${createHash("sha256").update(Buffer.from(text)).digest("hex")}`;
const observation = {
  runId: "run:one", projectId: "project:one", jobId: "job:one", attemptId: "attempt:one",
  leaseId: "lease:one", leaseEpoch: 1, bindingDigest: `sha256:${"a".repeat(64)}`,
  sessionKeyDigest: `sha256:${"b".repeat(64)}`, nativeRunKeyDigest: `sha256:${"c".repeat(64)}`,
  snapshotVersion: 4, observedAt: "2026-09-13T12:00:00.000Z", upstreamUpdatedAt: "2026-09-13T11:59:59.000Z",
  state: "completed", availability: "current", lastActivity: "message_progress", stopAttempted: false,
  safeReason: "none", result: { contentHash: hash, sizeBytes: Buffer.byteLength(text) }, usage: null,
};

function qualifiedProfile() {
  const profile = structuredClone(hermesGptConnectorProfileV1);
  profile.operations.result.evidence = "native_qualified";
  return profile;
}

const project = (overrides: Partial<Parameters<typeof projectNativeObservationTextResultV1>[0]> = {}) =>
  projectNativeObservationTextResultV1({ tenantId: "tenant:one", nodeId: "node:one",
    connectorProfile: qualifiedProfile(), observation, text, ...overrides });

test("maps exact completed native evidence into the common result contract", () => {
  const result = project();
  assert.deepEqual(result.lineage, { tenantId: "tenant:one", projectId: observation.projectId,
    jobId: observation.jobId, attemptId: observation.attemptId, runId: observation.runId, nodeId: "node:one" });
  assert.equal(result.connector.harness, "hermes");
  assert.equal(result.source.upstreamSessionId, observation.sessionKeyDigest);
  assert.equal(result.source.upstreamExecutionId, observation.nativeRunKeyDigest);
  assert.equal(result.content.text, text);
  assert.equal(result.qualityAccepted, false);
  assert.equal(result.completionRecorded, false);
});

test("refuses the selected Hermes profile until its native result operation is qualified", () => {
  assert.throws(() => project({ connectorProfile: hermesGptConnectorProfileV1 }),
    /canonical_result_operation_unavailable/);
});

test("refuses non-current, non-completed and result-free observations", () => {
  for (const changed of [
    { ...observation, availability: "offline" },
    { ...observation, state: "running", result: null },
    { ...observation, result: null },
  ]) assert.throws(() => project({ observation: changed }), /canonical_native_result_unavailable|Invalid input/);
});

test("refuses byte claims that differ from the exact returned text", () => {
  assert.throws(() => project({ text: "changed result" }), /canonical_native_result_mismatch/);
  assert.throws(() => project({ observation: { ...observation,
    result: { ...observation.result, sizeBytes: observation.result.sizeBytes + 1 } } }), /canonical_native_result_mismatch/);
});

test("derives source evidence from the whole observation", () => {
  const first = project(), second = project({ observation: { ...observation, snapshotVersion: 5 } });
  assert.notEqual(first.source.completionEvidenceDigest, second.source.completionEvidenceDigest);
  assert.notEqual(first.resultDigest, second.resultDigest);
});
