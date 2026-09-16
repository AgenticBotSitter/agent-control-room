import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCanonicalTextResultV1 } from "../src/harness/v1/canonical-text-result";
import { connectorOperationNamesV1 } from "../src/harness/v1/connector-profile";
import { runConnectorConformanceV1, type ConnectorConformanceObservationV1, type ConnectorConformanceRunInputV1, type ConnectorConformanceScenarioV1 } from "../src/connector-conformance/v1";

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

const multibyteText = "café ✅ 漢字";

test("conformance runner exercises result envelope, bytes and encoding rules for two harnesses", () => {
  const observations: Record<string, ConnectorConformanceObservationV1> = {
    plain: { form: "utf8_text", text: " exact result\n" },
    multibyte: { form: "utf8_text", text: multibyteText },
    overLimit: { form: "utf8_text", text: "x".repeat(65_537) },
    empty: { form: "utf8_text", text: "" },
    loneSurrogate: { form: "utf8_text", text: "\ud800" },
    invalidBytes: { form: "raw_bytes", bytes: [0x66, 0x80, 0x6f] },
  };
  const report = runConnectorConformanceV1({
    profiles: { nativeSynthetic: profile(), interfaceSynthetic: profile("actual_interface_tested") },
    observations,
    scenarios: [
      { scenarioId: "native-envelope", rule: "result_envelope", profileId: "nativeSynthetic", operation: "result", observationId: "plain", expect: "admitted" },
      { scenarioId: "interface-envelope", rule: "result_envelope", profileId: "interfaceSynthetic", operation: "result", observationId: "plain", expect: "admitted" },
      { scenarioId: "native-read-unavailable", rule: "result_envelope", profileId: "nativeSynthetic", operation: "read", observationId: "plain", expect: "refused" },
      { scenarioId: "multibyte-bytes", rule: "content_bytes", profileId: "nativeSynthetic", operation: "result", observationId: "multibyte", expect: "admitted" },
      { scenarioId: "over-limit-bytes", rule: "content_bytes", profileId: "nativeSynthetic", operation: "result", observationId: "overLimit", expect: "refused" },
      { scenarioId: "empty-bytes", rule: "content_bytes", profileId: "interfaceSynthetic", operation: "result", observationId: "empty", expect: "refused" },
      { scenarioId: "lone-surrogate-encoding", rule: "content_encoding", profileId: "nativeSynthetic", operation: "result", observationId: "loneSurrogate", expect: "refused" },
      { scenarioId: "raw-byte-encoding", rule: "content_encoding", profileId: "nativeSynthetic", operation: "result", observationId: "invalidBytes", expect: "unsupported" },
    ],
  });

  assert.deepEqual(report.counts, { pass: 7, fail: 0, unsupported: 1 });
  const evidence = new Map(report.scenarios.map(scenario => [scenario.scenarioId, scenario]));
  assert.equal(evidence.get("interface-envelope")?.reasonCode, "result_envelope_admitted");
  assert.equal(evidence.get("native-read-unavailable")?.reasonCode, "operation_unavailable");
  assert.equal(evidence.get("multibyte-bytes")?.sizeBytes, Buffer.byteLength(multibyteText));
  assert.equal(evidence.get("multibyte-bytes")?.contentHash,
    `sha256:${createHash("sha256").update(Buffer.from(multibyteText)).digest("hex")}`);
  assert.equal(evidence.get("over-limit-bytes")?.reasonCode, "content_unavailable");
  assert.equal(evidence.get("empty-bytes")?.reasonCode, "content_unavailable");
  assert.equal(evidence.get("lone-surrogate-encoding")?.reasonCode, "content_unavailable");
  assert.equal(evidence.get("raw-byte-encoding")?.outcome, "unsupported");
  assert.equal(evidence.get("raw-byte-encoding")?.reasonCode, "utf8_text_boundary_required");
});

test("conformance evidence keeps exact identity, stays immutable and repeats reproducibly", () => {
  const identity = { lineage, source };
  const scenarios: ConnectorConformanceScenarioV1[] = [
    { scenarioId: "identity-one", rule: "lineage_identity", profileId: "nativeSynthetic", operation: "result", observationId: "plain", identity, expect: "admitted" },
    { scenarioId: "identity-two", rule: "lineage_identity", profileId: "nativeSynthetic", operation: "result", observationId: "plain", identity: { lineage: { ...lineage, attemptId: "attempt:two" }, source }, expect: "admitted" },
    { scenarioId: "determinism", rule: "result_determinism", profileId: "nativeSynthetic", operation: "result", observationId: "plain", identity, expect: "admitted" },
    { scenarioId: "immutability", rule: "input_immutability", profileId: "nativeSynthetic", operation: "result", observationId: "plain", identity, expect: "admitted" },
    { scenarioId: "review-flags", rule: "review_flags", profileId: "nativeSynthetic", operation: "result", observationId: "plain", identity, expect: "admitted" },
  ];
  const observations: Record<string, ConnectorConformanceObservationV1> = {
    plain: { form: "utf8_text", text: " exact result\n" },
  };
  const input: ConnectorConformanceRunInputV1 = {
    profiles: { nativeSynthetic: profile() },
    observations,
    scenarios,
  };
  const report = runConnectorConformanceV1(input);

  assert.deepEqual(report.counts, { pass: 5, fail: 0, unsupported: 0 });
  const evidence = new Map(report.scenarios.map(scenario => [scenario.scenarioId, scenario]));
  assert.equal(evidence.get("identity-one")?.resultDigest, evidence.get("determinism")?.resultDigest);
  assert.notEqual(evidence.get("identity-two")?.resultDigest, evidence.get("identity-one")?.resultDigest);
  assert.equal(evidence.get("identity-one")?.contentHash,
    `sha256:${createHash("sha256").update(Buffer.from(" exact result\n")).digest("hex")}`);
  assert.equal(evidence.get("immutability")?.resultFrozen, true);
  assert.equal(evidence.get("immutability")?.reasonCode, "caller_input_and_admission_unchanged");
  assert.equal(evidence.get("review-flags")?.reasonCode, "review_still_required");
  assert.equal(report.nativeQualification, false);
  assert.deepEqual(report.enabledOperations, []);
  assert.deepEqual(runConnectorConformanceV1(input), report);
});
