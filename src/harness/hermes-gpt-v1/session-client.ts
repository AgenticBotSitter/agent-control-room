import {
  HERMES_SESSION_MAX_PROMPT_CHARS_V1, HERMES_SESSION_MAX_RESULT_CHARS_V1,
  HERMES_SESSION_MAX_SESSION_ID_CHARS_V1, HERMES_SESSION_MAX_TIMEOUT_SECONDS_V1,
  HERMES_SESSION_MIN_RESULT_CHARS_V1, HERMES_SESSION_MIN_TIMEOUT_SECONDS_V1,
  HERMES_SESSION_JOB_ID_PATTERN_V1,
  hermesSessionContinueResponseSchemaV1, hermesSessionJobResultResponseSchemaV1,
  hermesSessionJobStatusResponseSchemaV1, parseHermesSessionReplyV1,
  type HermesSessionContinueResponseV1, type HermesSessionJobResultResponseV1,
  type HermesSessionJobStatusResponseV1, type HermesSessionReplyV1, type HermesSessionToolNameV1,
} from "./session-contract";

/**
 * Client for the three supported upstream Hermes session tools.
 *
 * The transport is injected and owned by the caller. This module opens no
 * socket, spawns no process, reads no credential and installs nothing: it
 * formats one tool call, hands it to the supplied port, and classifies the
 * reply against the pinned upstream contract.
 *
 * Arguments are validated against upstream's own bounds *before* the call.
 * That is not duplicated validation for its own sake — upstream clamps
 * `timeout` and `max_chars` silently, so a caller that sent an out-of-range
 * value would otherwise believe a bound it never got. Refusing locally keeps
 * the connector's declared behavior and upstream's actual behavior identical.
 */

export interface HermesSessionToolPortV1 {
  /**
   * Invokes one upstream FastMCP tool by name and returns its decoded reply.
   *
   * Implementations must not retry: a repeated `hermes_session_continue`
   * could start a second real turn. Transport-level failures should reject,
   * which this client reports as an unavailable transport rather than as an
   * upstream refusal.
   */
  call(tool: HermesSessionToolNameV1, params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal): Promise<unknown>;
}

export type HermesSessionCallV1<T> =
  | HermesSessionReplyV1<T>
  | { readonly outcome: "invalid_request"; readonly reason: string }
  | { readonly outcome: "transport_unavailable"; readonly reason: string };

function invalid(reason: string): HermesSessionCallV1<never> {
  return { outcome: "invalid_request", reason };
}

async function invoke<T>(port: HermesSessionToolPortV1, tool: HermesSessionToolNameV1,
  params: Record<string, unknown>, schema: Parameters<typeof parseHermesSessionReplyV1<T>>[0],
  signal?: AbortSignal): Promise<HermesSessionCallV1<T>> {
  if (!port || typeof port.call !== "function") return invalid("hermes_session_port_invalid");
  if (signal?.aborted) return { outcome: "transport_unavailable", reason: "hermes_session_aborted" };
  let raw: unknown;
  try {
    raw = await port.call(tool, Object.freeze({ ...params }), signal);
  } catch (error) {
    // A transport failure is not an upstream decision. Reporting it as one
    // would let a network fault look like a refusal the caller can act on.
    return { outcome: "transport_unavailable",
      reason: error instanceof Error && /^hermes_/.test(error.message) ? error.message : "hermes_session_transport_failed" };
  }
  return parseHermesSessionReplyV1(schema, raw, `${tool}_reply_unrecognized`);
}

function checkSessionId(sessionId: string): string | undefined {
  if (typeof sessionId !== "string") return "hermes_session_id_invalid";
  // Upstream trims before measuring, so measure the trimmed value here too.
  const trimmed = sessionId.trim();
  if (trimmed.length === 0 || trimmed.length > HERMES_SESSION_MAX_SESSION_ID_CHARS_V1) {
    return "hermes_session_id_invalid";
  }
  return undefined;
}

/**
 * Starts one bounded non-interactive turn in an existing Hermes session.
 *
 * This is the only operation that can begin real upstream work, so it is never
 * retried here. A caller that did not observe this reply must reconcile
 * through `hermesSessionJobStatusV1`, or rely on upstream refusing a second
 * concurrent turn for the same session with `SESSION_BUSY`.
 */
export async function hermesSessionContinueV1(port: HermesSessionToolPortV1, request: {
  sessionId: string; prompt: string; timeoutSeconds?: number;
}, signal?: AbortSignal): Promise<HermesSessionCallV1<HermesSessionContinueResponseV1>> {
  const sessionIdProblem = checkSessionId(request?.sessionId);
  if (sessionIdProblem) return invalid(sessionIdProblem);
  const prompt = request.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) return invalid("hermes_session_prompt_invalid");
  if (prompt.length > HERMES_SESSION_MAX_PROMPT_CHARS_V1) return invalid("hermes_session_prompt_too_large");
  const timeout = request.timeoutSeconds;
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout)) return invalid("hermes_session_timeout_invalid");
    // Upstream clamps instead of refusing; refuse locally so the caller cannot
    // believe a deadline upstream would silently replace.
    if (timeout < HERMES_SESSION_MIN_TIMEOUT_SECONDS_V1 || timeout > HERMES_SESSION_MAX_TIMEOUT_SECONDS_V1) {
      return invalid("hermes_session_timeout_out_of_range");
    }
  }
  return invoke(port, "hermes_session_continue", {
    session_id: request.sessionId.trim(), prompt,
    ...(timeout === undefined ? {} : { timeout }),
  }, hermesSessionContinueResponseSchemaV1, signal);
}

/** Reads one job's current record. Safe to call repeatedly; it starts nothing. */
export async function hermesSessionJobStatusV1(port: HermesSessionToolPortV1, jobId: string,
  signal?: AbortSignal): Promise<HermesSessionCallV1<HermesSessionJobStatusResponseV1>> {
  if (typeof jobId !== "string" || !HERMES_SESSION_JOB_ID_PATTERN_V1.test(jobId)) {
    return invalid("hermes_session_job_id_invalid");
  }
  return invoke(port, "hermes_session_job_status", { job_id: jobId },
    hermesSessionJobStatusResponseSchemaV1, signal);
}

/**
 * Reads one job's bounded output.
 *
 * `maxChars` is refused outside upstream's accepted range rather than clamped,
 * for the same reason as `timeout`: a silently reduced cap would make the
 * returned `truncated` flag mean something the caller did not ask for.
 */
export async function hermesSessionJobResultV1(port: HermesSessionToolPortV1, jobId: string,
  options: { maxChars?: number } = {}, signal?: AbortSignal,
): Promise<HermesSessionCallV1<HermesSessionJobResultResponseV1>> {
  if (typeof jobId !== "string" || !HERMES_SESSION_JOB_ID_PATTERN_V1.test(jobId)) {
    return invalid("hermes_session_job_id_invalid");
  }
  const maxChars = options?.maxChars;
  if (maxChars !== undefined) {
    if (typeof maxChars !== "number" || !Number.isSafeInteger(maxChars)) return invalid("hermes_session_max_chars_invalid");
    if (maxChars < HERMES_SESSION_MIN_RESULT_CHARS_V1 || maxChars > HERMES_SESSION_MAX_RESULT_CHARS_V1) {
      return invalid("hermes_session_max_chars_out_of_range");
    }
  }
  return invoke(port, "hermes_session_job_result", {
    job_id: jobId, ...(maxChars === undefined ? {} : { max_chars: maxChars }),
  }, hermesSessionJobResultResponseSchemaV1, signal);
}
