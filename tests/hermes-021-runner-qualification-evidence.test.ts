import assert from "node:assert/strict";
import test from "node:test";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1,
  HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 } from "../src/harness/hermes-021-v1";

const passing = { schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1, qualified: true as const,
  terminalResultObserved: true as const,
  sessionDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", inputTokens: 804,
  outputTokens: 71, totalTokens: 877, durationMs: 14_904, failureReason: "none" as const,
  retryRequiresFreshOwnerAuthorization: false as const };

test("runner qualification evidence contains only a digest of a complete successful report", () => {
  const evidence = createHermes021MacosLocalRunnerQualificationEvidenceV1(passing);
  assert.match(evidence.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(evidence).sort(), ["evidenceDigest", "schema"]);
});

test("runner qualification evidence refuses an incomplete or failed run", () => {
  assert.throws(() => createHermes021MacosLocalRunnerQualificationEvidenceV1({ ...passing, qualified: false }));
  assert.throws(() => createHermes021MacosLocalRunnerQualificationEvidenceV1({ ...passing, totalTokens: 1 }));
});
