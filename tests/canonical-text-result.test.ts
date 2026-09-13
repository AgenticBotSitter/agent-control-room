import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCanonicalTextResultV1 } from "../src/harness/v1/canonical-text-result";
import { connectorOperationNamesV1 } from "../src/harness/v1/connector-profile";

const operation = (status: "supported" | "unsupported" | "unknown",
  evidence: "source_inspected" | "fixture_tested" | "actual_interface_tested" | "native_qualified") =>
  ({ status, evidence, reasonCode: `reason_${status}_${evidence}` });

function profile(resultEvidence: "source_inspected" | "fixture_tested" | "actual_interface_tested" | "native_qualified" = "native_qualified") {
  return {
    schema: "control-room.connector-profile/v1",
    connectorId: "connector.test.v1",
    connectorVersion: "1.0.0",
    harness: "other",
    harnessVersion: "1.2.3",
    sourceRevision: "a".repeat(40),
    transport: "rest",
    isolation: "adapter_process",
    credentialResolution: "harness_native",
    distribution: "invocation_only",
    operations: Object.fromEntries(connectorOperationNamesV1.map(name => [name,
      name === "result" ? operation("supported", resultEvidence) : operation("unsupported", "source_inspected")])),
    resultContract: { forms: ["utf8_text"], maximumBytes: 65_536, additionalAttachments: false },
  };
}

const lineage = { tenantId: "tenant:one", projectId: "project:one", jobId: "job:one",
  attemptId: "attempt:one", runId: "run:one", nodeId: "node:one" };
const source = { upstreamSessionId: "session:one", upstreamExecutionId: "execution:one",
  upstreamResultId: "result:one", completionEvidenceDigest: `sha256:${"b".repeat(64)}` };
const make = (overrides: Partial<Parameters<typeof createCanonicalTextResultV1>[0]> = {}) => createCanonicalTextResultV1({
  connectorProfile: profile(), operation: "result", lineage, source, text: " exact result\n",
  observedAt: "2026-09-13T12:00:00.000Z", ...overrides,
});

test("creates one immutable harness-neutral result pending owner review", () => {
  const value = make();
  assert.equal(value.schema, "control-room.canonical-text-result/v1");
  assert.equal(value.connector.harness, "other");
  assert.equal(value.connector.operationEvidence, "native_qualified");
  assert.equal(value.content.text, " exact result\n");
  assert.equal(value.content.sizeBytes, Buffer.byteLength(value.content.text));
  assert.equal(value.content.contentHash,
    `sha256:${createHash("sha256").update(Buffer.from(value.content.text)).digest("hex")}`);
  assert.equal(value.qualityAccepted, false);
  assert.equal(value.reviewRequired, true);
  assert.equal(value.completionRecorded, false);
  assert.equal(value.grantsExecutionAuthority, false);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.lineage) && Object.isFrozen(value.content));
});

test("same evidence is deterministic while content and lineage changes change identity", () => {
  assert.deepEqual(make(), make());
  assert.notEqual(make({ text: "different" }).resultDigest, make().resultDigest);
  assert.notEqual(make({ lineage: { ...lineage, attemptId: "attempt:two" } }).resultDigest, make().resultDigest);
});

test("rejects source and fixture evidence even when a profile advertises result", () => {
  for (const evidence of ["source_inspected", "fixture_tested"] as const) {
    assert.throws(() => make({ connectorProfile: profile(evidence) }), /canonical_result_operation_unavailable/);
  }
  const unsupported = profile();
  unsupported.operations.result = operation("unsupported", "native_qualified");
  assert.throws(() => make({ connectorProfile: unsupported }), /canonical_result_operation_unavailable/);
});

test("read can be the qualified recovery source but must be independently admitted", () => {
  const value = profile();
  value.operations.result = operation("unsupported", "source_inspected");
  value.operations.read = operation("supported", "actual_interface_tested");
  const result = make({ connectorProfile: value, operation: "read" });
  assert.equal(result.connector.operation, "read");
  assert.equal(result.connector.operationEvidence, "actual_interface_tested");
});

test("preserves exact UTF-8 bytes and enforces the public size boundary", () => {
  assert.equal(make({ text: "x".repeat(65_536) }).content.sizeBytes, 65_536);
  for (const text of ["", " \n\t ", "x".repeat(65_537), "\ud800", "\udc00"]) {
    assert.throws(() => make({ text }), /canonical_result_content_unavailable/);
  }
});

test("rejects secret text, malformed lineage, malformed evidence and extra fields", () => {
  assert.throws(() => make({ text: "Authorization: Bearer abcdefghijklmnop" }), /contains secret material/);
  assert.throws(() => make({ lineage: { ...lineage, projectId: "../escape" } }), /Invalid string/);
  assert.throws(() => make({ source: { ...source, completionEvidenceDigest: "not-a-digest" } }), /Invalid string/);
  assert.throws(() => make({ source: { ...source, endpoint: "https://private.invalid" } as never }), /Unrecognized key/);
});

test("connector identity is derived from the exact validated profile", () => {
  const first = make();
  const changed = profile();
  changed.connectorVersion = "1.0.1";
  const second = make({ connectorProfile: changed });
  assert.notEqual(first.connector.profileDigest, second.connector.profileDigest);
  assert.notEqual(first.resultDigest, second.resultDigest);
});
