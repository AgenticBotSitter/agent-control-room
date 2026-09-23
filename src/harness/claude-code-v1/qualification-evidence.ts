import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 } from "./text-review-invocation-policy";

/**
 * The private owner-run Claude check has a deliberately small public-safe
 * output. It proves only that the fixed text-review invocation produced one
 * bounded terminal result. It must never contain the executable, profile,
 * working directory, prompt, answer text, session ID, credential, or raw CLI
 * frames.
 */
export const CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1 =
  "control-room.claude-code-text-review-qualification-report/v1" as const;
export const CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_EVIDENCE_V1 =
  "control-room.claude-code-text-review-qualification-evidence/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const claudeCodeTextReviewQualificationReportSchemaV1 = z.object({
  schema: z.literal(CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1),
  qualified: z.boolean(),
  fixedInvocationPolicyDigest: z.literal(CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1),
  terminalResultObserved: z.boolean(),
  terminalResultDigest: digest.nullable(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  totalTokens: count.nullable(),
  durationMs: count.nullable(),
  failureReason: z.enum([
    "none",
    "owner_configuration_invalid",
    "installed_process_unavailable",
    "fixed_invocation_refused",
    "terminal_result_unexpected",
  ]),
  retryRequiresFreshOwnerAuthorization: z.boolean(),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

const successfulReport = claudeCodeTextReviewQualificationReportSchemaV1.superRefine((value, context) => {
  if (!value.qualified || !value.terminalResultObserved || !value.terminalResultDigest
    || value.inputTokens === null || value.outputTokens === null || value.totalTokens === null || value.durationMs === null
    || value.totalTokens < value.inputTokens + value.outputTokens || value.failureReason !== "none"
    || value.retryRequiresFreshOwnerAuthorization) {
    context.addIssue({ code: "custom", message: "Claude text-review qualification did not pass" });
  }
});

/**
 * Converts only a successful, non-authorizing sanitized report into the
 * private installation fingerprint consumed by the already-existing process
 * host configuration. It does not launch Claude or make a task assignable.
 */
export function createClaudeCodeTextReviewQualificationEvidenceV1(value: unknown) {
  const report = successfulReport.parse(value);
  return Object.freeze({ schema: CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_EVIDENCE_V1,
    evidenceDigest: sha256Digest({ schema: CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_EVIDENCE_V1, report }) });
}
