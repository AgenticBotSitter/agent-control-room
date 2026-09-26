import assert from "node:assert/strict";
import test from "node:test";
import { deriveClaudeCodeExpectedSessionIdV1 } from "../src/harness/claude-code-v1/session-identity";

const binding = {
  processAttemptId: "attempt.process.fixture", runId: "run.fixture", attemptId: "attempt.fixture",
  invocationDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

test("Claude expected session identity is deterministic, UUID-shaped, and bound to the complete attempt", () => {
  const first = deriveClaudeCodeExpectedSessionIdV1(binding);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(deriveClaudeCodeExpectedSessionIdV1({ ...binding }), first);
  assert.notEqual(deriveClaudeCodeExpectedSessionIdV1({ ...binding, processAttemptId: "attempt.process.other" }), first);
  assert.notEqual(deriveClaudeCodeExpectedSessionIdV1({ ...binding, invocationDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), first);
});

test("Claude expected session identity rejects malformed bindings", () => {
  assert.throws(() => deriveClaudeCodeExpectedSessionIdV1({ ...binding, invocationDigest: "not-a-digest" }));
  assert.throws(() => deriveClaudeCodeExpectedSessionIdV1({ processAttemptId: binding.processAttemptId }));
});
