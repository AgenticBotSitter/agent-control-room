import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1,
  captureClaudeCodeTextReviewInvocationConfigurationV1,
} from "../src/harness/claude-code-v1/text-review-invocation-policy";

const digest = `sha256:${"a".repeat(64)}`;
const configuration = {
  schema: "control-room.claude-code-private-installed-process-host-configuration/v1" as const,
  process: {
    executablePath: "/private/fixture/bin/claude",
    args: [...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1],
    workingDirectory: "/private/fixture/workspace",
    cleanupMs: 100,
  },
  executableSha256: digest,
  workingDirectoryBindingDigest: digest,
  qualificationDigest: digest,
  startupDeadlineMs: 100,
  terminateDeadlineMs: 100,
  killDeadlineMs: 100,
};

test("the first Claude task accepts only the fixed text-review invocation", () => {
  assert.deepEqual(CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1.slice(-2), ["--model", "opus"]);
  const captured = captureClaudeCodeTextReviewInvocationConfigurationV1(configuration);
  assert.deepEqual(captured.process.args, CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1);
  assert.equal(Object.isFrozen(captured.process.args), true);
});

test("a first Claude task refuses tool, session, permission, or add-on drift before launch", () => {
  for (const args of [
    ["--print", "--output-format", "stream-json"],
    [...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1, "--resume", "old-session"],
    [...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1.slice(0, 4), "--plugin-dir", "/private/plugin",
      ...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1.slice(4)],
    [...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1.slice(0, 4), "--mcp-config", "/private/mcp.json",
      ...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1.slice(4)],
    [...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1.slice(0, -2), "--max-turns", "2"],
  ]) assert.throws(() => captureClaudeCodeTextReviewInvocationConfigurationV1({
    ...configuration, process: { ...configuration.process, args },
  }), /claude_code_text_review_invocation_unavailable/);
});
