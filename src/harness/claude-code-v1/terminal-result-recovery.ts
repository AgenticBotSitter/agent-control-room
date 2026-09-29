import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import { publishClaudeTerminalResultV1, type ClaudeTerminalResultPublicationV1 } from "./result-publication";
import type { ClaudeCodeTerminalResultStagePortV1 } from "./terminal-result-staging";

export type ClaudeCodeTerminalResultRecoveryV1 = Readonly<
  | { state: "recovered_pending_review"; publication: ClaudeTerminalResultPublicationV1; permitsRetry: false; permitsResume: false }
  | { state: "terminal_result_uncertain"; reasonCode: "staged_terminal_result_missing" | "staged_terminal_result_altered"; permitsRetry: false; permitsResume: false }
>;

/**
 * Replays exactly one protected terminal record into the existing durable
 * result/review service. There is intentionally no acquisition, launcher or
 * process binding argument: a restart cannot resume, retry or guess Claude.
 */
export async function recoverClaudeCodeTerminalResultV1(input: Readonly<{
  publication: DurableResultPublicationConfigurationV1;
  stage: ClaudeCodeTerminalResultStagePortV1;
  assertAuthority: () => void;
  signal?: AbortSignal;
}>): Promise<ClaudeCodeTerminalResultRecoveryV1> {
  if (!input || !input.stage || typeof input.stage.recover !== "function" || typeof input.assertAuthority !== "function") {
    throw new Error("claude_code_terminal_recovery_unavailable");
  }
  let staged;
  try { staged = await input.stage.recover(input.signal); } catch {
    return Object.freeze({ state: "terminal_result_uncertain", reasonCode: "staged_terminal_result_altered", permitsRetry: false, permitsResume: false });
  }
  if (!staged) return Object.freeze({ state: "terminal_result_uncertain", reasonCode: "staged_terminal_result_missing", permitsRetry: false, permitsResume: false });
  let publication: ClaudeTerminalResultPublicationV1;
  try {
    publication = await publishClaudeTerminalResultV1(input.publication, { ...staged, assertAuthority: input.assertAuthority });
  } catch (error) {
    // Stage-originated material that no longer satisfies the independent
    // bridge checks is uncertainty, never a cue to acquire Claude again.
    if (error instanceof Error && error.message.startsWith("claude_code_result_publication_")) {
      return Object.freeze({ state: "terminal_result_uncertain", reasonCode: "staged_terminal_result_altered", permitsRetry: false, permitsResume: false });
    }
    throw error;
  }
  return Object.freeze({ state: "recovered_pending_review", publication, permitsRetry: false, permitsResume: false });
}
