import { z } from "zod";

/**
 * Exact response shapes of the three supported upstream Hermes session tools at
 * `asimons81/hermes-gpt` revision `89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73`.
 *
 * Every bound here is read from that revision's `operator_session.py`, not
 * invented: the prompt and result ceilings, the timeout clamp, the job-id
 * shape, the job states and the structured error envelope from
 * `operator_policy.make_error_envelope`. Nothing in this module calls a
 * provider, starts a process or grants execution authority; it only decides
 * whether a value the transport returned is a response this connector
 * understands.
 *
 * Upstream returns an error envelope as an ordinary result rather than raising,
 * so a refusal is parsed, never thrown. Unknown extra fields are preserved by
 * design: upstream redaction and future additions must not turn a usable
 * response into a parse failure.
 */

/** `MAX_PROMPT_CHARS` upstream. Equal to Control Room's result ceiling by coincidence, not by contract. */
export const HERMES_SESSION_MAX_PROMPT_CHARS_V1 = 65_536 as const;
/** `MAX_RESULT_CHARS` upstream: the largest `max_chars` the result tool honors. */
export const HERMES_SESSION_MAX_RESULT_CHARS_V1 = 24_000 as const;
/** Smallest `max_chars` upstream clamps to. */
export const HERMES_SESSION_MIN_RESULT_CHARS_V1 = 500 as const;
/** Upstream clamps `timeout` into this inclusive range. */
export const HERMES_SESSION_MIN_TIMEOUT_SECONDS_V1 = 10 as const;
export const HERMES_SESSION_MAX_TIMEOUT_SECONDS_V1 = 3_600 as const;
/** Upstream `_load` refuses any job id that is not exactly 32 lowercase hex characters. */
export const HERMES_SESSION_JOB_ID_PATTERN_V1 = /^[0-9a-f]{32}$/;
/** Upstream `_validate_start` trims and bounds the session id to 1..256 characters. */
export const HERMES_SESSION_MAX_SESSION_ID_CHARS_V1 = 256 as const;

export const HERMES_SESSION_TOOLS_V1 = [
  "hermes_session_continue", "hermes_session_job_status", "hermes_session_job_result",
] as const;
export type HermesSessionToolNameV1 = (typeof HERMES_SESSION_TOOLS_V1)[number];

/**
 * Job states written by upstream `_watch` and `_reconcile`.
 *
 * `orphaned` is not a failure and not a completion: upstream sets it when a
 * server restart means process ownership could not be proven. `timed_out`
 * means upstream terminated the process group at its own deadline.
 */
export const HERMES_SESSION_JOB_STATES_V1 = [
  "starting", "running", "completed", "failed", "timed_out", "orphaned",
] as const;
export type HermesSessionJobStateV1 = (typeof HERMES_SESSION_JOB_STATES_V1)[number];

/** States in which upstream has stopped working on the job. */
export const HERMES_SESSION_TERMINAL_STATES_V1 = ["completed", "failed", "timed_out", "orphaned"] as const;

/**
 * Error codes observed at `layer: "session_control"` in the pinned revision.
 *
 * The first nine come from `operator_session.py`; the last two are emitted by
 * the MCP wrapper in `server.py`, which resolves the session id before
 * delegating. This list is a reading aid, not a gate: an unrecognized code is
 * still parsed as a refusal and never guessed at, so a future upstream code
 * degrades safely rather than becoming an unrecognized reply.
 */
export const HERMES_SESSION_ERROR_CODES_V1 = [
  "SESSION_CONTROL_DISABLED", "INVALID_SESSION_ID", "INVALID_PROMPT", "PROMPT_TOO_LARGE",
  "INVALID_TIMEOUT", "SESSION_BUSY", "HERMES_START_FAILED", "JOB_NOT_FOUND", "INVALID_MAX_CHARS",
  "SESSION_ID_NOT_FOUND_OR_AMBIGUOUS", "SESSION_CONTINUE_FAILED",
] as const;
export type HermesSessionErrorCodeV1 = (typeof HERMES_SESSION_ERROR_CODES_V1)[number];

const jobId = z.string().regex(HERMES_SESSION_JOB_ID_PATTERN_V1);

/**
 * Upstream bounds the session id with Python `len()`, which counts codepoints.
 * Zod's `.max()` counts UTF-16 units, so an astral-heavy id that upstream
 * accepts would be rejected here as an unrecognized reply. Count the same
 * units upstream counts.
 */
const codepointLength = (value: string): number => {
  let count = 0;
  for (const _ of value) count++;
  return count;
};
const sessionId = z.string().min(1).refine(
  value => codepointLength(value) <= HERMES_SESSION_MAX_SESSION_ID_CHARS_V1,
  { message: "session id exceeds the upstream codepoint limit" },
);

/** `operator_policy.make_error_envelope`. `success` and `ok` are both false for compatibility. */
export const hermesSessionErrorEnvelopeSchemaV1 = z.object({
  success: z.literal(false),
  ok: z.literal(false).optional(),
  error: z.string(),
  layer: z.string(),
  code: z.string().min(1),
  safe_message: z.string(),
  suggested_action: z.string(),
  trace_id: z.string().optional(),
}).passthrough();

export const hermesSessionContinueResponseSchemaV1 = z.object({
  success: z.literal(true),
  job_id: jobId,
  session_id: sessionId,
  status: z.literal("running"),
}).passthrough();

/**
 * The persisted job record upstream writes with `_save`.
 *
 * `session_id` and `created_at` are optional because `_watch` falls back to
 * `_load(...) or {"job_id": job_id}` when the job file cannot be read, and then
 * saves a record carrying neither field. Requiring them would turn that
 * degraded-but-real record into an unrecognized reply.
 */
export const hermesSessionJobSchemaV1 = z.object({
  job_id: jobId,
  session_id: sessionId.optional(),
  status: z.enum(HERMES_SESSION_JOB_STATES_V1),
  created_at: z.string().optional(),
  started_at: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
  return_code: z.number().int().nullable().optional(),
  timeout: z.number().int().optional(),
  prompt_len: z.number().int().nonnegative().optional(),
  prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reconciliation: z.string().optional(),
}).passthrough();

export const hermesSessionJobStatusResponseSchemaV1 = z.object({
  success: z.literal(true),
  job: hermesSessionJobSchemaV1,
}).passthrough();

export const hermesSessionJobResultResponseSchemaV1 = z.object({
  success: z.literal(true),
  job_id: jobId,
  session_id: sessionId.nullable(),
  status: z.enum(HERMES_SESSION_JOB_STATES_V1),
  return_code: z.number().int().nullable().optional(),
  response: z.string(),
  truncated: z.boolean(),
}).passthrough();

export type HermesSessionErrorEnvelopeV1 = z.infer<typeof hermesSessionErrorEnvelopeSchemaV1>;
export type HermesSessionContinueResponseV1 = z.infer<typeof hermesSessionContinueResponseSchemaV1>;
export type HermesSessionJobV1 = z.infer<typeof hermesSessionJobSchemaV1>;
export type HermesSessionJobStatusResponseV1 = z.infer<typeof hermesSessionJobStatusResponseSchemaV1>;
export type HermesSessionJobResultResponseV1 = z.infer<typeof hermesSessionJobResultResponseSchemaV1>;

/** A parsed upstream reply: either the tool's success shape or its refusal envelope. */
export type HermesSessionReplyV1<T> =
  | { readonly outcome: "ok"; readonly value: T }
  | { readonly outcome: "refused"; readonly code: string; readonly envelope: HermesSessionErrorEnvelopeV1 }
  | { readonly outcome: "unrecognized"; readonly reason: string };

function refusal(value: unknown): HermesSessionReplyV1<never> | undefined {
  const parsed = hermesSessionErrorEnvelopeSchemaV1.safeParse(value);
  return parsed.success
    ? { outcome: "refused", code: parsed.data.code, envelope: Object.freeze(parsed.data) }
    : undefined;
}

/**
 * Classifies one raw transport reply. An unrecognized shape is reported as
 * such rather than coerced: a connector that guesses at an unknown reply would
 * be inventing upstream behavior.
 */
export function parseHermesSessionReplyV1<T>(
  schema: z.ZodType<T>, value: unknown, reason: string,
): HermesSessionReplyV1<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { outcome: "ok", value: Object.freeze(parsed.data) as T };
  return refusal(value) ?? { outcome: "unrecognized", reason };
}

/** True when upstream has stopped working on the job, by any route. */
export function hermesSessionJobIsTerminalV1(state: HermesSessionJobStateV1): boolean {
  return (HERMES_SESSION_TERMINAL_STATES_V1 as readonly string[]).includes(state);
}
