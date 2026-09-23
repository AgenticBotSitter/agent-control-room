import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { createClaudeCodeOwnedProcessSessionV1, type OwnedClaudeCodeProcessV1 } from "../../harness/claude-code-v1/owned-process-session";
import { createClaudeCodeStreamDecoderV1, type ClaudeCodeResultFrameV1 } from "../../harness/claude-code-v1/stream-json-decode";
import { CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1,
  CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 } from "../../harness/claude-code-v1/text-review-invocation-policy";
import { CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1 } from "../../harness/claude-code-v1/qualification-evidence";

/**
 * Private, one-shot qualification core for the already-fixed Claude text
 * review invocation. It has no default process launcher: the command-line
 * wrapper supplies an owner-attended native port, while tests use a fake.
 * This module neither records a credential nor enables a worker or task.
 */
export const PRIVATE_LOCAL_CLAUDE_QUALIFICATION_V1 =
  "control-room.private-local-claude-qualification/v1" as const;

export type PrivateLocalClaudeQualificationInputV1 = Readonly<{
  executablePath: string;
  workingDirectory: string;
  /** Opaque identity of the exact executable that the owner selected. */
  executableSha256: string;
  /** Opaque binding of the exact resolved workspace that the owner selected. */
  workingDirectoryBindingDigest: string;
  /** Random text supplied by the caller, never returned in a report. */
  expectedText: string;
  signal: AbortSignal;
}>;

export type PrivateLocalClaudeQualificationPortV1 = Readonly<{
  launch(request: Readonly<{
    schema: typeof PRIVATE_LOCAL_CLAUDE_QUALIFICATION_V1;
    executablePath: string;
    args: readonly string[];
    workingDirectory: string;
  }>): OwnedClaudeCodeProcessV1;
}>;

export type ClaudeTextReviewQualificationReportV1 = Readonly<{
  schema: typeof CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1;
  qualified: boolean;
  fixedInvocationPolicyDigest: typeof CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1;
  executableSha256: string;
  workingDirectoryBindingDigest: string;
  terminalResultObserved: boolean;
  terminalResultDigest: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  failureReason: "none" | "owner_configuration_invalid" | "installed_process_unavailable" | "fixed_invocation_refused" | "terminal_result_unexpected";
  retryRequiresFreshOwnerAuthorization: boolean;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

const unavailable = (): never => { throw new Error("private_local_claude_qualification_unavailable"); };
const safePath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096
  && isAbsolute(value) && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
const safeNonce = (value: unknown): value is string => typeof value === "string" && /^[A-Z0-9_-]{24,160}$/u.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);

function report(input: Omit<ClaudeTextReviewQualificationReportV1, "schema" | "fixedInvocationPolicyDigest" | "startsWork" | "grantsExecutionAuthority">): ClaudeTextReviewQualificationReportV1 {
  return Object.freeze({ schema: CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1,
    fixedInvocationPolicyDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
    startsWork: false as const, grantsExecutionAuthority: false as const, ...input });
}

/** Extract only fixed numeric usage after the shared strict decoder accepted the frame. */
function usageFromTerminalLine(line: string): Readonly<{ input: number; output: number; total: number }> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const usage = (parsed as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
    const raw = usage as Record<string, unknown>;
    // The accepted local Claude compatibility is intentionally narrow. A
    // changed CLI field shape is a failed qualification, not a guess.
    const input = raw.input_tokens, output = raw.output_tokens;
    if (!count(input) || !count(output)) return undefined;
    const total = raw.total_tokens === undefined ? input + output : raw.total_tokens;
    return count(total) && total >= input + output ? Object.freeze({ input, output, total }) : undefined;
  } catch { return undefined; }
}

function failed(reason: ClaudeTextReviewQualificationReportV1["failureReason"]): ClaudeTextReviewQualificationReportV1 {
  return report({ executableSha256: "sha256:" + "0".repeat(64), workingDirectoryBindingDigest: "sha256:" + "0".repeat(64),
    qualified: false, terminalResultObserved: false, terminalResultDigest: null,
    inputTokens: null, outputTokens: null, totalTokens: null, durationMs: null,
    failureReason: reason, retryRequiresFreshOwnerAuthorization: true });
}

/**
 * Runs exactly one supplied-text probe through an injected owner-held process
 * port. The full frame is decoded using the ordinary connector decoder, but
 * only a digest and bounded measurements survive this function.
 */
export async function qualifyPrivateLocalClaudeTextReviewV1(input: PrivateLocalClaudeQualificationInputV1,
  port: PrivateLocalClaudeQualificationPortV1, now: () => number = Date.now): Promise<ClaudeTextReviewQualificationReportV1> {
  if (!input || !safePath(input.executablePath) || !safePath(input.workingDirectory) || !digest(input.executableSha256)
    || !digest(input.workingDirectoryBindingDigest) || !safeNonce(input.expectedText)
    || !(input.signal instanceof AbortSignal) || input.signal.aborted || !port || typeof port.launch !== "function" || typeof now !== "function")
    return failed("owner_configuration_invalid");
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt)) return failed("owner_configuration_invalid");
  let owner: OwnedClaudeCodeProcessV1 | undefined;
  try {
    owner = port.launch(Object.freeze({ schema: PRIVATE_LOCAL_CLAUDE_QUALIFICATION_V1, executablePath: input.executablePath,
      args: Object.freeze([...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1]), workingDirectory: input.workingDirectory }));
    const session = createClaudeCodeOwnedProcessSessionV1({ binding: {
      processAttemptId: randomUUID(), runId: randomUUID(), attemptId: randomUUID(),
      invocationDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
    }, initialInput: new TextEncoder().encode(`Reply with exactly this text and nothing else: ${input.expectedText}`),
      signal: input.signal, acquire: () => owner!, cleanupMs: 2_000 });
    const wire = await session.ready, decoder = createClaudeCodeStreamDecoderV1();
    let terminal: ClaudeCodeResultFrameV1 | undefined, terminalUsage: Readonly<{ input: number; output: number; total: number }> | undefined;
    for (;;) {
      const line = await wire.readLine(input.signal);
      if (line === undefined) break;
      const frame = decoder.accept(line);
      if (frame.kind === "decode_error") return failed("terminal_result_unexpected");
      if (frame.kind === "result") {
        if (terminal) return failed("terminal_result_unexpected");
        terminal = frame;
        terminalUsage = usageFromTerminalLine(line);
      }
    }
    const state = decoder.state(), durationMs = now() - startedAt;
    if (!terminal || state.failed || !state.initObserved || !state.terminalObserved || terminal.outcome !== "succeeded"
      || terminal.resultText !== input.expectedText || !terminal.resultTextDigest || !terminalUsage
      || !Number.isSafeInteger(durationMs) || durationMs < 0) return failed("terminal_result_unexpected");
    session.recordTerminalResultObserved();
    await session.close();
    return report({ executableSha256: input.executableSha256, workingDirectoryBindingDigest: input.workingDirectoryBindingDigest,
      qualified: true, terminalResultObserved: true, terminalResultDigest: terminal.resultTextDigest,
      inputTokens: terminalUsage.input, outputTokens: terminalUsage.output, totalTokens: terminalUsage.total,
      durationMs, failureReason: "none", retryRequiresFreshOwnerAuthorization: false });
  } catch {
    return failed("installed_process_unavailable");
  } finally {
    try { await owner?.close(); } catch { /* failed report remains the only outcome */ }
  }
}
