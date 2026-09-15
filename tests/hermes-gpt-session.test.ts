import assert from "node:assert/strict";
import test from "node:test";
import {
  HERMES_SESSION_MAX_PROMPT_CHARS_V1, HERMES_SESSION_MAX_RESULT_CHARS_V1,
  HERMES_SESSION_MAX_TIMEOUT_SECONDS_V1, HERMES_SESSION_MIN_TIMEOUT_SECONDS_V1,
  hermesSessionJobIsTerminalV1, type HermesSessionToolNameV1,
} from "../src/harness/hermes-gpt-v1/session-contract";
import {
  hermesSessionContinueV1, hermesSessionJobResultV1, hermesSessionJobStatusV1,
  type HermesSessionToolPortV1,
} from "../src/harness/hermes-gpt-v1/session-client";

/**
 * Recorded upstream transport.
 *
 * Replies are recorded from the pinned `asimons81/hermes-gpt` revision
 * `89cbfbe2…` `operator_session.py` and `operator_policy.make_error_envelope`.
 * Nothing here starts a process, opens a socket or calls a provider: the port
 * only replays a recorded reply and remembers what it was asked.
 */
class RecordedHermesTransport implements HermesSessionToolPortV1 {
  readonly calls: { tool: HermesSessionToolNameV1; params: Record<string, unknown> }[] = [];
  constructor(private readonly replies: Partial<Record<HermesSessionToolNameV1, unknown[]>> = {},
    private readonly failure?: Error) {}
  async call(tool: HermesSessionToolNameV1, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.calls.push({ tool, params: { ...params } });
    if (this.failure) throw this.failure;
    const queue = this.replies[tool];
    if (!queue || queue.length === 0) throw new Error(`no recorded reply for ${tool}`);
    return queue.shift();
  }
}

const JOB_ID = "a".repeat(32);
const SESSION_ID = "session-2026-09-15-alpha";

/** Exactly `operator_policy.make_error_envelope`. */
const envelope = (code: string, safeMessage: string, action = "Check the job ID.") => ({
  success: false, ok: false, error: safeMessage, layer: "session_control",
  code, safe_message: safeMessage, suggested_action: action, trace_id: "trace-0001",
});

const runningJob = (overrides: Record<string, unknown> = {}) => ({
  job_id: JOB_ID, session_id: SESSION_ID, status: "running", created_at: "2026-09-15T10:00:00+00:00",
  started_at: "2026-09-15T10:00:01+00:00", ended_at: null, pid: 4321, return_code: null,
  timeout: 900, prompt_len: 42, prompt_sha256: "b".repeat(64), ...overrides,
});

test("continue returns the upstream job identity and sends exactly the pinned parameter names", async () => {
  const transport = new RecordedHermesTransport({
    hermes_session_continue: [{ success: true, job_id: JOB_ID, session_id: SESSION_ID, status: "running" }],
  });
  const call = await hermesSessionContinueV1(transport,
    { sessionId: `  ${SESSION_ID}  `, prompt: "Continue the task.", timeoutSeconds: 120 });
  assert.equal(call.outcome, "ok");
  assert.equal(call.outcome === "ok" && call.value.job_id, JOB_ID);

  // Upstream's own parameter names, and the session id trimmed the way
  // `_validate_start` trims it before use.
  assert.deepEqual(transport.calls, [{ tool: "hermes_session_continue",
    params: { session_id: SESSION_ID, prompt: "Continue the task.", timeout: 120 } }]);
});

test("the client refuses out-of-range arguments before upstream can silently clamp them", async () => {
  const transport = new RecordedHermesTransport();
  const rejected = async (request: Parameters<typeof hermesSessionContinueV1>[1], reason: string) => {
    const call = await hermesSessionContinueV1(transport, request);
    assert.equal(call.outcome, "invalid_request");
    assert.equal(call.outcome === "invalid_request" && call.reason, reason);
  };

  // Upstream clamps timeout into [10, 3600] and max_chars into [500, 24000]
  // rather than refusing. A caller that sent a wider bound would otherwise
  // believe a deadline or cap it never received.
  await rejected({ sessionId: SESSION_ID, prompt: "p", timeoutSeconds: HERMES_SESSION_MIN_TIMEOUT_SECONDS_V1 - 1 },
    "hermes_session_timeout_out_of_range");
  await rejected({ sessionId: SESSION_ID, prompt: "p", timeoutSeconds: HERMES_SESSION_MAX_TIMEOUT_SECONDS_V1 + 1 },
    "hermes_session_timeout_out_of_range");
  await rejected({ sessionId: SESSION_ID, prompt: "p", timeoutSeconds: 1.5 }, "hermes_session_timeout_invalid");
  await rejected({ sessionId: "", prompt: "p" }, "hermes_session_id_invalid");
  await rejected({ sessionId: "x".repeat(257), prompt: "p" }, "hermes_session_id_invalid");
  await rejected({ sessionId: SESSION_ID, prompt: "   " }, "hermes_session_prompt_invalid");
  await rejected({ sessionId: SESSION_ID, prompt: "x".repeat(HERMES_SESSION_MAX_PROMPT_CHARS_V1 + 1) },
    "hermes_session_prompt_too_large");

  const badCap = await hermesSessionJobResultV1(transport, JOB_ID, { maxChars: HERMES_SESSION_MAX_RESULT_CHARS_V1 + 1 });
  assert.equal(badCap.outcome, "invalid_request");
  const badJob = await hermesSessionJobStatusV1(transport, "not-a-job-id");
  assert.equal(badJob.outcome, "invalid_request");

  // Nothing reached the transport: a refused request never becomes a call.
  assert.equal(transport.calls.length, 0);
});

test("every upstream refusal envelope is parsed as a decision, never thrown", async () => {
  for (const code of ["SESSION_CONTROL_DISABLED", "SESSION_BUSY", "HERMES_START_FAILED", "INVALID_PROMPT"]) {
    const transport = new RecordedHermesTransport({
      hermes_session_continue: [envelope(code, `${code} happened.`)],
    });
    const call = await hermesSessionContinueV1(transport, { sessionId: SESSION_ID, prompt: "go" });
    assert.equal(call.outcome, "refused");
    assert.equal(call.outcome === "refused" && call.code, code);
  }
  const missing = new RecordedHermesTransport({
    hermes_session_job_status: [envelope("JOB_NOT_FOUND", "Hermes session job was not found.")],
  });
  const status = await hermesSessionJobStatusV1(missing, JOB_ID);
  assert.equal(status.outcome === "refused" && status.code, "JOB_NOT_FOUND");
});

test("a transport fault is reported as unavailable, not as an upstream refusal", async () => {
  const transport = new RecordedHermesTransport({}, new Error("socket closed"));
  const call = await hermesSessionContinueV1(transport, { sessionId: SESSION_ID, prompt: "go" });
  assert.equal(call.outcome, "transport_unavailable");
  // The distinction matters: a refusal is an upstream decision a caller can
  // act on; an unavailable transport leaves the turn's fate unknown.
  assert.notEqual(call.outcome, "refused");
});

test("an unrecognized reply shape is reported rather than coerced", async () => {
  const transport = new RecordedHermesTransport({
    hermes_session_continue: [{ success: true, job_id: "not-hex", session_id: SESSION_ID, status: "running" }],
    hermes_session_job_status: [{ success: true }],
  });
  const started = await hermesSessionContinueV1(transport, { sessionId: SESSION_ID, prompt: "go" });
  assert.equal(started.outcome, "unrecognized");
  const status = await hermesSessionJobStatusV1(transport, JOB_ID);
  assert.equal(status.outcome, "unrecognized");
});

test("status accepts every upstream job state and classifies terminal ones", async () => {
  for (const state of ["starting", "running", "completed", "failed", "timed_out", "orphaned"] as const) {
    const transport = new RecordedHermesTransport({
      hermes_session_job_status: [{ success: true, job: runningJob({ status: state }) }],
    });
    const call = await hermesSessionJobStatusV1(transport, JOB_ID);
    assert.equal(call.outcome, "ok", state);
    assert.equal(call.outcome === "ok" && call.value.job.status, state);
  }
  assert.deepEqual(
    (["starting", "running", "completed", "failed", "timed_out", "orphaned"] as const).map(hermesSessionJobIsTerminalV1),
    [false, false, true, true, true, true]);
});

test("the orphaned record keeps upstream's reconciliation note", async () => {
  const transport = new RecordedHermesTransport({
    hermes_session_job_status: [{ success: true, job: runningJob({
      status: "orphaned", ended_at: "2026-09-15T10:30:00+00:00",
      reconciliation: "server restarted; process ownership could not be proven" }) }],
  });
  const call = await hermesSessionJobStatusV1(transport, JOB_ID);
  assert.equal(call.outcome === "ok" && call.value.job.reconciliation,
    "server restarted; process ownership could not be proven");
});

test("result defaults to upstream's own cap and passes the requested cap through", async () => {
  const reply = { success: true, job_id: JOB_ID, session_id: SESSION_ID, status: "completed",
    return_code: 0, response: "done", truncated: false };
  const transport = new RecordedHermesTransport({ hermes_session_job_result: [reply, reply] });
  await hermesSessionJobResultV1(transport, JOB_ID);
  assert.deepEqual(transport.calls[0].params, { job_id: JOB_ID });
  await hermesSessionJobResultV1(transport, JOB_ID, { maxChars: 1_000 });
  assert.deepEqual(transport.calls[1].params, { job_id: JOB_ID, max_chars: 1_000 });
});

test("an aborted signal stops the call before it reaches the transport", async () => {
  const transport = new RecordedHermesTransport();
  const call = await hermesSessionContinueV1(transport, { sessionId: SESSION_ID, prompt: "go" },
    AbortSignal.abort());
  assert.equal(call.outcome, "transport_unavailable");
  assert.equal(transport.calls.length, 0);
});

test("the degraded job record upstream can write is still a recognized reply", async () => {
  // `_watch` falls back to `_load(...) or {"job_id": job_id}` when the job file
  // cannot be read, then saves a record carrying neither session_id nor
  // created_at. Requiring those would turn a real upstream record into an
  // unrecognized reply and hide a job that genuinely exists.
  const transport = new RecordedHermesTransport({
    hermes_session_job_status: [{ success: true, job: { job_id: JOB_ID, status: "failed",
      return_code: null, ended_at: "2026-09-15T10:30:00+00:00" } }],
  });
  const call = await hermesSessionJobStatusV1(transport, JOB_ID);
  assert.equal(call.outcome, "ok");
  assert.equal(call.outcome === "ok" && call.value.job.status, "failed");
  assert.equal(call.outcome === "ok" && call.value.job.session_id, undefined);
});
