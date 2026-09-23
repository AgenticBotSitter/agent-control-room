import {
  capturePrivateClaudeCodeInstalledProcessHostConfigurationV1,
  type PrivateClaudeCodeInstalledProcessHostConfigurationV1,
} from "./private-process-acquisition";
import { sha256Digest } from "../../security/canonical-digest";

/**
 * The first installed Claude route is deliberately narrower than a general
 * coding session. These are fixed CLI arguments for a supplied-text review:
 * one printed stream result, no persisted session, no built-in tools, no MCP
 * tools, and no unattended permission approval.
 *
 * The exact CLI version and its support for these flags are still checked by
 * the separate owner-attended qualification. This source boundary only makes
 * it impossible for a task, browser request, or later caller to broaden the
 * invocation that qualification is meant to prove.
 */
export const CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1 = Object.freeze([
  "--print",
  "--output-format", "stream-json",
  "--verbose",
  "--restricted",
  "--bare",
  "--disallowedTools", "*,mcp__*",
  "--permission-prompts", "none",
  "--no-session-persistence",
  "--max-turns", "1",
] as const);

export type ClaudeCodeTextReviewInvocationConfigurationV1 = ReturnType<
  typeof captureClaudeCodeTextReviewInvocationConfigurationV1
>;

/**
 * A plan-safe fingerprint of the fixed first-task policy. It intentionally
 * contains neither a command path nor any owner credential or workspace data.
 * An owner-attended qualification can record this digest without exporting its
 * private command configuration.
 */
export const CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 = sha256Digest({
  schema: "control-room.claude-code-text-review-invocation-policy/v1",
  args: CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1,
});

type CapturedInstalledProcessConfiguration = ReturnType<
  typeof capturePrivateClaudeCodeInstalledProcessHostConfigurationV1
>;

const unavailable = (): never => {
  const error = new Error("claude_code_text_review_invocation_unavailable");
  error.stack = undefined;
  throw error;
};

function exactArgs(value: readonly string[]): boolean {
  return value.length === CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1.length
    && value.every((argument, index) => argument === CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1[index]);
}

/**
 * Captures an installation-owned process configuration only when it is the
 * fixed first-release text-review invocation. It creates no child and reads
 * no credential, setting, plug-in, MCP configuration, or environment.
 */
export function captureClaudeCodeTextReviewInvocationConfigurationV1(
  value: PrivateClaudeCodeInstalledProcessHostConfigurationV1,
): CapturedInstalledProcessConfiguration {
  try {
    const captured = capturePrivateClaudeCodeInstalledProcessHostConfigurationV1(value);
    if (!exactArgs(captured.process.args)) unavailable();
    return captured;
  } catch { return unavailable(); }
}
