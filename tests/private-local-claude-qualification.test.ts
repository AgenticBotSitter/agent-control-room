import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1 } from "../src/harness/claude-code-v1/text-review-invocation-policy";
import { createClaudeCodeTextReviewQualificationEvidenceV1,
  createClaudeCodeTextReviewQualificationFailureEvidenceV1 } from "../src/harness/claude-code-v1/qualification-evidence";
import { qualifyPrivateLocalClaudeTextReviewV1,
  type PrivateLocalClaudeQualificationPortV1 } from "../src/installer/v1/private-local-claude-qualification";

const nonce = "CONTROL_ROOM_CLAUDE_QUALIFICATION_0123456789";
const sessionId = "00000000-0000-4000-8000-000000004242";

function port(lines: readonly string[], onLaunch?: (request: unknown) => void): PrivateLocalClaudeQualificationPortV1 {
  return Object.freeze({ launch(request) {
    onLaunch?.(request);
    const stdout = [...lines].map(line => new TextEncoder().encode(`${line}\n`));
    const writes: Uint8Array[] = [];
    return Object.freeze({
      ready: Promise.resolve(Object.freeze({
        async writeStdin(bytes: Uint8Array) { writes.push(Uint8Array.from(bytes)); },
        async readStdout() { return stdout.shift(); },
        async readStderr() { return undefined; },
        async closeStdin() {}, async terminate() {}, exited: Promise.resolve({ code: 0, signal: null }),
      })),
      async close() {},
      // Test-only evidence is held by the callback below instead of emitted
      // from the qualification report.
      _writes: writes,
    } as never);
  } });
}

function frame(type: "system" | "result", extra: Record<string, unknown> = {}) {
  return JSON.stringify(type === "system"
    ? { type, subtype: "init", session_id: sessionId, ...extra }
    : { type, subtype: "success", is_error: false, session_id: sessionId, ...extra });
}

test("owner-held Claude qualification accepts only one exact fixed text result and returns redacted evidence", async () => {
  let request: { args?: readonly string[] } | undefined;
  const value = await qualifyPrivateLocalClaudeTextReviewV1({ executablePath: "/private/owner/claude",
    workingDirectory: "/private/owner/work", expectedText: nonce, signal: new AbortController().signal },
  port([frame("system"), frame("result", { result: nonce,
    usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } })], value => { request = value as typeof request; }),
  () => 100);
  assert.equal(value.qualified, true);
  assert.deepEqual({ input: value.inputTokens, output: value.outputTokens, total: value.totalTokens },
    { input: 8, output: 5, total: 13 });
  assert.equal(value.terminalResultObserved, true);
  assert.equal(value.retryRequiresFreshOwnerAuthorization, false);
  assert.match(createClaudeCodeTextReviewQualificationEvidenceV1(value).evidenceDigest, /^sha256:/);
  assert.deepEqual(request?.args, CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1);
  assert.doesNotMatch(JSON.stringify(value), /private\/owner|CLAUDE_QUALIFICATION|00000000-0000-4000-8000-000000004242/i);
});

test("qualification refuses invalid configuration before the owner-held launch port", async () => {
  let launches = 0;
  const value = await qualifyPrivateLocalClaudeTextReviewV1({ executablePath: "claude",
    workingDirectory: "/private/owner/work", expectedText: nonce, signal: new AbortController().signal },
  Object.freeze({ launch() { launches++; throw new Error("must not launch"); } }), () => 100);
  assert.equal(launches, 0);
  assert.equal(value.qualified, false);
  assert.equal(value.failureReason, "owner_configuration_invalid");
  assert.equal(value.retryRequiresFreshOwnerAuthorization, true);
});

test("a changed result, malformed usage, or unavailable process remains a failed non-retryable qualification", async () => {
  for (const lines of [
    [frame("system"), frame("result", { result: "wrong", usage: { input_tokens: 1, output_tokens: 1 } })],
    [frame("system"), frame("result", { result: nonce, usage: { input_tokens: "1", output_tokens: 1 } })],
    [frame("system"), frame("result", { result: nonce, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 1 } })],
  ]) {
    const value = await qualifyPrivateLocalClaudeTextReviewV1({ executablePath: "/private/owner/claude",
      workingDirectory: "/private/owner/work", expectedText: nonce, signal: new AbortController().signal }, port(lines), () => 100);
    assert.equal(value.qualified, false);
    assert.equal(value.failureReason, "terminal_result_unexpected");
    assert.equal(value.terminalResultDigest, null);
  }
  const unavailable = await qualifyPrivateLocalClaudeTextReviewV1({ executablePath: "/private/owner/claude",
    workingDirectory: "/private/owner/work", expectedText: nonce, signal: new AbortController().signal },
  Object.freeze({ launch() { throw new Error("unavailable"); } }), () => 100);
  assert.equal(unavailable.failureReason, "installed_process_unavailable");
  assert.deepEqual(createClaudeCodeTextReviewQualificationFailureEvidenceV1(unavailable).state, "failed");
});
