import assert from "node:assert/strict";
import test from "node:test";
import { createHermes021MacosLocalQualificationEvidenceV1 } from "../src/harness/hermes-021-v1";

const successful = { qualified: true as const, exitCode: 0 as const, exitSignal: null, terminalResultObserved: true as const,
  sessionDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", inputTokens: 804, outputTokens: 71,
  totalTokens: 877, durationMs: 14_904, stderrBytes: 36, failureStage: "none" as const, failureReason: "none" as const,
  profileOverrideUsed: true, modelOverrideUsed: true, providerOverrideUsed: true, retryRequiresFreshOwnerAuthorization: false as const };

test("a successful sanitized Hermes qualification produces only an opaque readiness fingerprint", () => {
  const evidence = createHermes021MacosLocalQualificationEvidenceV1(successful);
  assert.equal(evidence.schema, "control-room.hermes-021-macos-local-qualification-evidence/v1");
  assert.match(evidence.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(evidence).includes("qwen"), false);
  assert.equal(JSON.stringify(evidence).includes("session:"), false);
});

test("failed, incomplete, or inconsistent qualification reports cannot become passed proof", () => {
  assert.throws(() => createHermes021MacosLocalQualificationEvidenceV1({ ...successful, qualified: false }));
  assert.throws(() => createHermes021MacosLocalQualificationEvidenceV1({ ...successful, failureReason: "model_response_missing" }));
  assert.throws(() => createHermes021MacosLocalQualificationEvidenceV1({ ...successful, totalTokens: 1 }));
  assert.throws(() => createHermes021MacosLocalQualificationEvidenceV1({ ...successful, sessionDigest: "session:raw" }));
});
